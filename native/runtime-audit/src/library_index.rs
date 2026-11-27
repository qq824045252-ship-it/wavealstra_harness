use crate::{Result, library_text};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, symlink_metadata},
    io::Read,
    path::PathBuf,
    time::UNIX_EPOCH,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    item: ItemVersion,
    #[serde(flatten)]
    source: SourceVersion,
    staging_uri: String,
    chunk_count: usize,
    indexed_at: i64,
    only_missing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceVersion {
    source_path: PathBuf,
    source_size: u64,
    source_modified_nanos: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemVersion {
    id: String,
    space_id: String,
    title: String,
    filename: String,
    kind: String,
    mime_type: String,
    content_hash: Option<String>,
    updated_at: i64,
    size_bytes: i64,
    extract_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPublication {
    item: ItemVersion,
    source: Option<SourceVersion>,
    content: DocumentContent,
    indexed_at: i64,
    only_missing: bool,
    chunk_size: usize,
    overlap: usize,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DocumentContent {
    TextFile,
    Extracted {
        status: ExtractionStatus,
        text: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ExtractionStatus {
    Extracted,
    Unsupported,
    Error,
}

impl ExtractionStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Extracted => "extracted",
            Self::Unsupported => "unsupported",
            Self::Error => "error",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Indexed,
    Skipped,
    SourceChanged,
}

impl SourceVersion {
    fn is_current(&self) -> bool {
        let Ok(stamp) = symlink_metadata(&self.source_path) else {
            return false;
        };
        if !stamp.is_file() || stamp.len() != self.source_size {
            return false;
        }
        let Ok(modified) = stamp.modified() else {
            return false;
        };
        let nanos = match modified.duration_since(UNIX_EPOCH) {
            Ok(elapsed) => elapsed.as_nanos() as i128,
            Err(error) => -(error.duration().as_nanos() as i128),
        };
        self.source_modified_nanos.parse::<i128>() == Ok(nanos)
    }
}

fn version_is_current(
    db: &Connection,
    item: &ItemVersion,
    require_revision: bool,
) -> duckdb::Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM library_items WHERE id=? AND space_id=? AND filename=?
             AND kind=? AND mime_type=? AND content_hash IS NOT DISTINCT FROM ? AND size_bytes=?
             AND extract_status IS NOT DISTINCT FROM ? AND trashed_at IS NULL AND (NOT ? OR (title=? AND updated_at=?))",
            params![
                item.id,
                item.space_id,
                item.filename,
                item.kind,
                item.mime_type,
                item.content_hash,
                item.size_bytes,
                item.extract_status,
                require_revision,
                item.title,
                item.updated_at
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn has_item_chunks(db: &Connection, id: &str) -> duckdb::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_chunks WHERE item_id=?)",
        [id],
        |row| row.get(0),
    )
}

fn refresh_fts(db: &Connection, item: &ItemVersion, body: Option<&str>) -> Result<()> {
    refresh_item_fts(db, &item.id, body)
}

pub(crate) fn refresh_item_fts(db: &Connection, id: &str, body: Option<&str>) -> Result<()> {
    let doc_key = format!("library:{id}");
    let Some(body_text) = body else {
        crate::search_postings::delete_document_postings_in_tx(db, &doc_key)?;
        return Ok(());
    };
    let row: Option<(String, String, String, Option<String>, i64)> = db
        .query_row(
            "SELECT space_id, title, filename, content_hash, updated_at FROM library_items WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((space_id, title, filename, content_hash, updated_at)) = row else {
        crate::search_postings::delete_document_postings_in_tx(db, &doc_key)?;
        return Ok(());
    };
    let doc = crate::search_postings::SearchDocumentInput {
        doc_key,
        domain: "library".to_owned(),
        scope: format!("library_space:{space_id}"),
        entity_id: id.to_owned(),
        title: format!("{title} {filename}"),
        body: body_text.to_owned(),
        content_revision: updated_at,
        content_hash: content_hash.unwrap_or_default(),
        metadata_json: None,
    };
    let postings = crate::search_postings::prepare_document_postings(&doc);
    let _ = crate::search_postings::publish_document_postings_in_tx(db, &doc, &postings, updated_at)?;
    Ok(())
}

pub(crate) fn has_table(db: &Connection, name: &str) -> Result<bool> {
    crate::database::table_exists(db, name)
}

pub fn publish(db: &mut Connection, publication: Publication) -> Result<Status> {
    let staged = library_text::read_staged_chunks(&publication.staging_uri)?;
    publish_transaction(db, &publication, &staged)
}

fn publish_transaction(
    db: &mut Connection,
    publication: &Publication,
    staged: &[library_text::StagedChunk],
) -> Result<Status> {
    let tx = db.transaction()?;
    let item = &publication.item;
    if !version_is_current(&tx, item, true)? {
        return Ok(Status::Skipped);
    }
    let has_chunks = has_table(&tx, "library_chunks")?;
    if publication.only_missing && has_chunks && has_item_chunks(&tx, &item.id)? {
        return Ok(Status::Skipped);
    }
    if !publication.source.is_current() {
        return Ok(Status::SourceChanged);
    }
    let combined_body: String = staged
        .iter()
        .map(|c| c.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    refresh_fts(&tx, item, Some(&combined_body))?;
    if has_chunks {
        replace_chunks(&tx, publication, staged)?;
    }
    if !publication.source.is_current() {
        return Ok(Status::SourceChanged);
    }
    tx.commit()?;
    Ok(Status::Indexed)
}

fn replace_chunks(
    db: &Connection,
    publication: &Publication,
    staged: &[library_text::StagedChunk],
) -> Result<()> {
    let id = &publication.item.id;
    let mut insert = db.prepare(
        "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET chunk_index=excluded.chunk_index,content=excluded.content,
           char_offset=excluded.char_offset,hash=excluded.hash,updated_at=excluded.updated_at",
    )?;
    for chunk in staged {
        let chunk_id = format!("{id}#{}", chunk.chunk_index);
        insert.execute(params![
            chunk_id,
            id,
            chunk.chunk_index,
            chunk.content,
            chunk.char_offset,
            chunk.hash,
            publication.indexed_at
        ])?;
    }
    prune_chunks(db, id, publication.chunk_count)?;
    Ok(())
}

fn prune_chunks(db: &Connection, id: &str, chunk_count: usize) -> duckdb::Result<()> {
    db.execute(
        "DELETE FROM library_chunk_embeddings
         WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?)
           AND NOT EXISTS (
             SELECT 1 FROM library_chunks c WHERE c.id=library_chunk_embeddings.chunk_id
               AND c.chunk_index < ? AND c.hash=library_chunk_embeddings.chunk_hash
           )",
        params![id, chunk_count],
    )?;
    db.execute(
        "DELETE FROM library_chunks WHERE item_id=? AND chunk_index>=?",
        params![id, chunk_count],
    )?;
    Ok(())
}

pub(crate) struct Chunk {
    content: String,
    hash: String,
    offset: usize,
}

pub(crate) fn document_chunks(body: &str, chunk_size: usize, overlap: usize) -> Result<Vec<Chunk>> {
    library_text::validate_chunk_sizes(chunk_size, overlap)?;
    let mut chunks = Vec::new();
    let units: Vec<u16> = body.encode_utf16().collect();
    let mut visit = |window: &[u16], offset: usize| -> Result<()> {
        if let Some((content, hash)) = library_text::chunk_content(window)? {
            chunks.push(Chunk {
                content,
                hash,
                offset,
            });
        }
        Ok(())
    };
    let end = library_text::visit_windows(&units, chunk_size, chunk_size - overlap, &mut visit)?;
    visit(&units[end..], end)?;
    Ok(chunks)
}

pub fn publish_document(db: &mut Connection, publication: DocumentPublication) -> Result<Status> {
    if !(200..=4000).contains(&publication.chunk_size)
        || publication.overlap > publication.chunk_size / 2
    {
        return Err("invalid library chunk configuration".into());
    }
    let source_is_current = || {
        publication
            .source
            .as_ref()
            .is_none_or(SourceVersion::is_current)
    };
    if !source_is_current() {
        return Ok(Status::SourceChanged);
    }
    let (body, extract_status) = match publication.content {
        DocumentContent::TextFile => {
            let mut bytes = Vec::new();
            if let Some(source) = &publication.source {
                if source.source_size > 1024 * 1024 {
                    return Err("large library text requires a staged index".into());
                }
                File::open(&source.source_path)?
                    .take(source.source_size + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 != source.source_size {
                    return Ok(Status::SourceChanged);
                }
            }
            (Some(String::from_utf8_lossy(&bytes).into_owned()), None)
        }
        DocumentContent::Extracted { status, text } => {
            let text = text
                .filter(|text| matches!(status, ExtractionStatus::Extracted) && !text.is_empty());
            (text, Some(status.as_str()))
        }
    };
    let chunks = document_chunks(
        body.as_deref().unwrap_or(""),
        publication.chunk_size,
        publication.overlap,
    )?;
    let tx = db.transaction()?;
    let item = &publication.item;
    if !version_is_current(&tx, item, false)? {
        return Ok(Status::Skipped);
    }
    let has_chunks = has_table(&tx, "library_chunks")?;
    if publication.only_missing && (!has_chunks || has_item_chunks(&tx, &item.id)?) {
        return Ok(Status::Skipped);
    }
    if !source_is_current() {
        return Ok(Status::SourceChanged);
    }
    if !publication.only_missing {
        refresh_fts(&tx, item, body.as_deref())?;
        if let Some(status) = extract_status {
            tx.execute(
                "UPDATE library_items SET extract_status=? WHERE id=?",
                params![status, item.id],
            )?;
        }
    }
    if has_chunks {
        replace_document_chunks(&tx, &item.id, &chunks, publication.indexed_at)?;
    }
    if !source_is_current() {
        return Ok(Status::SourceChanged);
    }
    tx.commit()?;
    if publication.only_missing && chunks.is_empty() {
        return Ok(Status::Skipped);
    }
    Ok(Status::Indexed)
}

pub(crate) fn index_saved_text(
    db: &Connection,
    id: &str,
    body: &str,
    chunks: &[Chunk],
    updated_at: i64,
) -> Result<()> {
    let body_fts = if body.len() > library_text::LARGE_TEXT_BYTES {
        ""
    } else {
        body
    };
    index_inline_text(db, id, body_fts, chunks, updated_at)
}

pub(crate) fn index_inline_text(
    db: &Connection,
    id: &str,
    body: &str,
    chunks: &[Chunk],
    updated_at: i64,
) -> Result<()> {
    refresh_item_fts(db, id, Some(body))?;
    if has_table(db, "library_chunks")? {
        replace_document_chunks(db, id, chunks, updated_at)?;
    }
    Ok(())
}

/// Chunk a streamed document without touching the database, so a caller that must
/// hold a write transaction can keep it to row inserts only.
pub(crate) fn stage_streamed_text(
    file: &mut File,
    chunk_size: usize,
    overlap: usize,
) -> Result<Vec<Chunk>> {
    library_text::validate_chunk_sizes(chunk_size, overlap)?;
    let metadata = file.metadata()?;
    let mut chunks = Vec::new();
    library_text::stream_document(
        file,
        &metadata,
        chunk_size,
        overlap,
        |_| Ok(true),
        |units, offset| {
            if let Some((content, hash)) = library_text::chunk_content(units)? {
                chunks.push(Chunk {
                    content,
                    hash,
                    offset,
                });
            }
            Ok(())
        },
    )?;
    Ok(chunks)
}

pub(crate) fn index_streamed_text(
    db: &Connection,
    id: &str,
    file: &mut File,
    updated_at: i64,
    chunk_size: usize,
    overlap: usize,
) -> Result<()> {
    refresh_item_fts(db, id, Some(""))?;
    if has_table(db, "library_chunks")? {
        let metadata = file.metadata()?;
        write_document_chunks(db, id, updated_at, |insert| {
            library_text::stream_document(
                file,
                &metadata,
                chunk_size,
                overlap,
                |_| Ok(true),
                |units, offset| {
                    if let Some((content, hash)) = library_text::chunk_content(units)? {
                        insert(&content, &hash, offset)?;
                    }
                    Ok(())
                },
            )?;
            Ok(())
        })?;
    }
    Ok(())
}

fn replace_document_chunks(
    db: &Connection,
    item_id: &str,
    chunks: &[Chunk],
    indexed_at: i64,
) -> Result<()> {
    write_document_chunks(db, item_id, indexed_at, |insert| {
        for chunk in chunks {
            insert(&chunk.content, &chunk.hash, chunk.offset)?;
        }
        Ok(())
    })
}

fn write_document_chunks(
    db: &Connection,
    item_id: &str,
    indexed_at: i64,
    document: impl FnOnce(&mut dyn FnMut(&str, &str, usize) -> Result<()>) -> Result<()>,
) -> Result<()> {
    let mut insert = db.prepare(
        "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           chunk_index=excluded.chunk_index,content=excluded.content,char_offset=excluded.char_offset,
           hash=excluded.hash,updated_at=excluded.updated_at",
    )?;
    let mut index = 0;
    document(&mut |content, hash, offset| {
        let id = format!("{item_id}#{index}");
        insert.execute(params![
            id, item_id, index, content, offset, hash, indexed_at
        ])?;
        index += 1;
        Ok(())
    })?;
    prune_chunks(db, item_id, index)?;
    Ok(())
}
