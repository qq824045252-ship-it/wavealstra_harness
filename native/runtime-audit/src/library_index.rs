use crate::{Result, library_text};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
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
) -> rusqlite::Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM library_items WHERE id=? AND space_id=? AND filename=?
             AND kind=? AND mime_type=? AND content_hash IS ? AND size_bytes=?
             AND extract_status IS ? AND trashed_at IS NULL AND (NOT ? OR (title=? AND updated_at=?))",
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

fn has_item_chunks(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_chunks WHERE item_id=?)",
        [id],
        |row| row.get(0),
    )
}

fn refresh_fts(db: &Connection, item: &ItemVersion, body: Option<&str>) -> rusqlite::Result<()> {
    if has_table(db, "library_fts")? {
        db.execute("DELETE FROM library_fts WHERE item_id=?", [&item.id])?;
        if let Some(body) = body {
            db.execute(
                "INSERT INTO library_fts(item_id,title,filename,body)
                 SELECT id,title,filename,? FROM library_items WHERE id=?",
                params![body, item.id],
            )?;
        }
    }
    Ok(())
}

fn has_table(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?)",
        [name],
        |row| row.get(0),
    )
}

pub fn publish(db: &mut Connection, publication: Publication) -> Result<Status> {
    db.execute(
        "ATTACH DATABASE ? AS library_index_stage",
        [&publication.staging_uri],
    )?;
    let result = publish_transaction(db, &publication);
    db.execute_batch("DETACH DATABASE library_index_stage")?;
    result
}

fn publish_transaction(db: &mut Connection, publication: &Publication) -> Result<Status> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
    refresh_fts(&tx, item, Some(""))?;
    if has_chunks {
        replace_chunks(&tx, publication)?;
    }
    if !publication.source.is_current() {
        return Ok(Status::SourceChanged);
    }
    tx.commit()?;
    Ok(Status::Indexed)
}

fn replace_chunks(db: &Connection, publication: &Publication) -> rusqlite::Result<()> {
    let id = &publication.item.id;
    db.execute(
        "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at)
         SELECT ? || '#' || chunk_index, ?, chunk_index, content, char_offset, hash, ?
         FROM library_index_stage.chunks WHERE 1 ORDER BY chunk_index
         ON CONFLICT(id) DO UPDATE SET chunk_index=excluded.chunk_index,content=excluded.content,
           char_offset=excluded.char_offset,hash=excluded.hash,updated_at=excluded.updated_at",
        params![id, id, publication.indexed_at],
    )?;
    if has_table(db, "library_chunks_fts")? {
        db.execute("DELETE FROM library_chunks_fts WHERE item_id=?", [id])?;
        db.execute(
            "INSERT INTO library_chunks_fts(item_id,chunk_id,content)
             SELECT ?, ? || '#' || chunk_index, content FROM library_index_stage.chunks ORDER BY chunk_index",
            [id, id],
        )?;
    }
    prune_chunks(db, id, publication.chunk_count)
}

fn prune_chunks(db: &Connection, id: &str, chunk_count: usize) -> rusqlite::Result<()> {
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

struct Chunk {
    content: String,
    hash: String,
    offset: usize,
}

fn document_chunks(body: &str, chunk_size: usize, overlap: usize) -> Result<Vec<Chunk>> {
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
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
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

fn replace_document_chunks(
    db: &Connection,
    item_id: &str,
    chunks: &[Chunk],
    indexed_at: i64,
) -> rusqlite::Result<()> {
    let mut insert = db.prepare_cached(
        "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           chunk_index=excluded.chunk_index,content=excluded.content,char_offset=excluded.char_offset,
           hash=excluded.hash,updated_at=excluded.updated_at",
    )?;
    let mut fts = if has_table(db, "library_chunks_fts")? {
        db.execute("DELETE FROM library_chunks_fts WHERE item_id=?", [item_id])?;
        Some(db.prepare_cached(
            "INSERT INTO library_chunks_fts(item_id,chunk_id,content) VALUES (?,?,?)",
        )?)
    } else {
        None
    };
    for (index, chunk) in chunks.iter().enumerate() {
        let id = format!("{item_id}#{index}");
        insert.execute(params![
            id,
            item_id,
            index,
            chunk.content,
            chunk.offset,
            chunk.hash,
            indexed_at
        ])?;
        if let Some(fts) = &mut fts {
            fts.execute(params![item_id, id, chunk.content])?;
        }
    }
    prune_chunks(db, item_id, chunks.len())
}
