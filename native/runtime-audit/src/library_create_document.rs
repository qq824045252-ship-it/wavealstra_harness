use crate::{
    Result, library_backup, library_index, library_metadata::ITEMS, library_restore, library_text,
    scoped_notes, sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    id: String,
    operation_id: String,
    space_id: String,
    collection_id: Option<String>,
    document_kind: String,
    title: String,
    content: String,
    owner: Option<library_backup::Owner>,
    clip_source: Option<Value>,
    tags: Option<Vec<String>>,
    root: PathBuf,
    chunk_size: usize,
    overlap: usize,
    merge: Option<MergeSources>,
}

#[derive(Deserialize)]
pub struct MergeSources {
    sources: Vec<Source>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    updated_at: i64,
    body_hash: String,
}

impl Document {
    fn check_destination(&self, db: &Connection) -> Result<()> {
        if let Some(owner) = &self.owner {
            if !library_backup::spaces(db, owner)?.contains(&self.space_id) {
                return Err("目标不属于当前查看范围".into());
            }
        }
        let owners = db
            .query_row(
                "SELECT project_id,workspace_id FROM library_spaces WHERE id=?",
                [&self.space_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?
            .ok_or("空间不存在")?;
        if !scoped_notes::library_owner_writable(db, owners.0.as_deref(), owners.1.as_deref())? {
            return Err("归档资料仅可读取".into());
        }
        if owners.0.is_none()
            && (self.title.encode_utf16().count() > 200
                || self.content.encode_utf16().count() > 1_000_000)
        {
            return Err("资料标题或正文超过长度上限".into());
        }
        if let Some(merge) = &self.merge {
            if self.document_kind != "markdown" || merge.sources.len() < 2 ||
                self.owner.is_none() {
                return Err("笔记合并的来源或归属已变化".into());
            }
            for source in &merge.sources {
                let name: Option<String> = db.query_row(
                    "SELECT filename FROM library_items WHERE id=?1 AND space_id=?2 AND kind='markdown'
                     AND trashed_at IS NULL AND updated_at=?3",
                    params![source.id, self.space_id, source.updated_at], |r|r.get(0)).optional()?;
                let filename = name.ok_or("合并前笔记已变化，请重试")?;
                let path = library_text::managed_path(&self.root, &self.space_id, &source.id, &filename);
                let file = library_text::open_managed(&self.root, &path, &self.space_id, &source.id)?
                    .ok_or("合并来源不可读取")?;
                let mut hash = Sha256::new();
                if std::io::copy(&mut std::io::Read::take(file, 4 * 1024 * 1024 + 1), &mut hash)? > 4 * 1024 * 1024 {
                    return Err("合并来源过大，请重试".into());
                }
                if format!("{:x}", hash.finalize()) != source.body_hash {
                    return Err("合并时笔记正文已变化，请重试".into());
                }
            }
        }
        if let Some(folder) = &self.collection_id {
            if !db.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_collections WHERE id=? AND space_id=?)",
                params![folder, self.space_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err("集合不属于该资料空间".into());
            }
        }
        Ok(())
    }
}

pub fn create(db: &mut Connection, doc: Document, at: i64) -> Result<Value> {
    if !doc.root.is_absolute()
        || !library_restore::valid_id(&doc.space_id)
        || !library_restore::valid_operation(&doc.id)
        || !library_restore::valid_operation(&doc.operation_id)
    {
        return Err("资料位置无效".into());
    }
    let (ext, mime) = match doc.document_kind.as_str() {
        "markdown" => ("md", "text/markdown"),
        "html" => ("html", "text/html"),
        "csv" => ("csv", "text/csv"),
        "url" => ("url", "text/uri-list"),
        _ => return Err("资料类型无效".into()),
    };
    let filename = format!("{}.{}", doc.title, ext);
    if !library_backup::valid_filename(&filename) {
        return Err("资料文件名无效".into());
    }
    if doc.document_kind == "url" {
        if !(doc.content.starts_with("https://") || doc.content.starts_with("http://")) {
            return Err("仅支持 http(s) 链接".into());
        }
        let tx = db.transaction()?;
        doc.check_destination(&tx)?;
        tx.execute("INSERT INTO library_items(id,space_id,collection_id,kind,title,filename,mime_type,size_bytes,owner,url,source_type,extract_status,created_at,updated_at,last_visited_at)
            VALUES(?1,?2,?3,'url',?4,?5,?6,0,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),?7,'url','pending',?8,?8,?8)",
            params![doc.id,doc.space_id,doc.collection_id,doc.title,filename,mime,doc.content,at])?;
        let item = records(&tx, &format!("SELECT {ITEMS} FROM library_items WHERE id=?"), [&doc.id])?
            .pop().ok_or("缺少新增链接记录")?;
        crate::request_control::commit(tx)?;
        return Ok(json!({"status":"updated","item":item}));
    }
    library_text::validate_chunk_sizes(doc.chunk_size, doc.overlap)?;
    let chunks = library_index::document_chunks(&doc.content, doc.chunk_size, doc.overlap)?;
    let path = library_text::managed_path(&doc.root, &doc.space_id, &doc.id, &filename);
    let tx = db.transaction()?;
    doc.check_destination(&tx)?;
    if library_text::open_managed(&doc.root, &path, &doc.space_id, &doc.id)?.is_some() {
        return Err("本地已存在同名受管文件".into());
    }
    library_restore::reserve_file(
        &tx,
        doc.root.to_str().ok_or("资料路径无效")?,
        &doc.operation_id,
        &doc.space_id,
        &doc.id,
        &filename,
    )?;
    crate::request_control::commit(tx)?;
    let apply = (|| -> Result<Value> {
        library_restore::stage(&path, doc.content.as_bytes(), &doc.operation_id, &doc.id)?;
        let tx = db.transaction()?;
        doc.check_destination(&tx)?;
        let mut metadata = serde_json::Map::new();
        if let Some(source) = &doc.clip_source { metadata.insert("clipSource".into(), source.clone()); }
        if let Some(tags) = &doc.tags { metadata.insert("tags".into(), json!(tags)); }
        tx.execute("INSERT INTO library_items(id,space_id,collection_id,kind,title,filename,mime_type,size_bytes,owner,content_hash,created_at,updated_at,last_visited_at,note_metadata)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),?9,?10,?10,?10,?11)",
            params![doc.id,doc.space_id,doc.collection_id,doc.document_kind,doc.title,filename,mime,doc.content.len(),format!("{:x}",Sha256::digest(doc.content.as_bytes())),at,serde_json::to_string(&metadata)?])?;
        library_index::index_saved_text(&tx, &doc.id, &doc.content, &chunks, at)?;
        let row = records(
            &tx,
            &format!("SELECT {ITEMS} FROM library_items WHERE id=?"),
            [&doc.id],
        )?
        .pop()
        .ok_or("缺少新增资料记录")?;
        library_restore::commit_staged(&path, &doc.operation_id, &doc.id)?;
        crate::request_control::commit(tx)?;
        Ok(json!({"status":"updated","item":row}))
    })();
    library_restore::recover(db, &doc.root, Some(&doc.operation_id))?;
    apply
}
