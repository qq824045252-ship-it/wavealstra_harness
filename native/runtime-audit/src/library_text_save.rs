use crate::{Result, library_index, library_text, scoped_notes};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

// The transport must also fit escaped JSON in the worker's 32 MiB line budget.
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    id: String,
    space_id: String,
    filename: String,
    path: PathBuf,
    root: PathBuf,
    operation_id: String,
    title: Option<String>,
    next_filename: Option<String>,
    expected_title: Option<String>,
    expected_content_hash: Option<String>,
    content: String,
    created_by: String,
    updated_at: i64,
    chunk_size: usize,
    overlap: usize,
}

#[derive(PartialEq, Eq)]
struct Item {
    title: String,
    kind: String,
    source_task_id: Option<String>,
    project_id: Option<String>,
    workspace_id: Option<String>,
}

fn current_item(db: &Connection, save: &Save) -> Result<Option<Item>> {
    let found = db
        .query_row(
            "SELECT i.title,i.kind,i.source_task_id,s.project_id,s.workspace_id
         FROM library_items i JOIN library_spaces s ON s.id=i.space_id
         WHERE i.id=?1 AND i.space_id=?2 AND i.filename=?3 AND i.trashed_at IS NULL
           AND i.kind IN ('markdown','html','csv')",
            params![save.id, save.space_id, save.filename],
            |row| {
                Ok(Item {
                    title: row.get(0)?,
                    kind: row.get(1)?,
                    source_task_id: row.get(2)?,
                    project_id: row.get(3)?,
                    workspace_id: row.get(4)?,
                })
            },
        )
        .optional()?;
    let Some(item) = found else {
        return Ok(None);
    };
    if !scoped_notes::library_owner_writable(
        db,
        item.project_id.as_deref(),
        item.workspace_id.as_deref(),
    )? {
        return Ok(None);
    }
    Ok(Some(item))
}

fn read_managed(save: &Save) -> Result<Option<Vec<u8>>> {
    let Some(file) = library_text::open_managed(&save.root, &save.path, &save.space_id, &save.id)?
    else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn replace_file(save: &Save, previous: &Option<Vec<u8>>) -> Result<()> {
    let staged = save
        .path
        .with_file_name(format!(".mybuddy-note-{}.tmp", save.operation_id));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)?;
    file.write_all(save.content.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if &read_managed(save)? != previous {
        return Err("managed library text changed before publication".into());
    }
    fs::rename(&staged, &save.path)?;
    #[cfg(unix)]
    fs::File::open(
        save.path
            .parent()
            .ok_or("missing library space directory")?,
    )?
    .sync_all()?;
    Ok(())
}

pub fn write(db: &mut Connection, save: Save) -> Result<Value> {
    if !save.root.is_absolute()
        || save.operation_id.len() != 36
        || !save
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("invalid library text save identity".into());
    }
    if save.content.len() > MAX_BYTES {
        return Ok(json!("needsHost"));
    }
    let chunks = library_index::document_chunks(&save.content, save.chunk_size, save.overlap)?;
    let tx = db.transaction()?;
    let Some(item) = current_item(&tx, &save)? else {
        return Ok(json!("conflict"));
    };
    let pending: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_text_saves WHERE item_id=?1 AND committed=0)",
        [&save.id],
        |row| row.get(0),
    )?;
    if pending {
        return Ok(json!("pending"));
    }
    let old_content = read_managed(&save)?;
    let old_bytes = old_content.as_deref().unwrap_or_default();
    if old_bytes.len() > MAX_BYTES || std::str::from_utf8(old_bytes).is_err() {
        return Ok(json!("needsHost"));
    }
    let old_hash = hash(old_bytes);
    if save
        .expected_title
        .as_ref()
        .is_some_and(|title| title != &item.title)
        || save
            .expected_content_hash
            .as_ref()
            .is_some_and(|expected| expected != &old_hash)
    {
        return Ok(json!("conflict"));
    }
    let content_changed = old_content.as_deref() != Some(save.content.as_bytes());
    let title = save.title.as_deref().unwrap_or(&item.title);
    if !content_changed && title == item.title {
        return Ok(json!("unchanged"));
    }
    let new_hash = hash(save.content.as_bytes());
    let old_hash = old_content.as_ref().map(|_| &old_hash);
    let path = save.path.to_str().ok_or("invalid library text path")?;
    let root = save.root.to_str().ok_or("invalid library root path")?;
    // Keep the previous bytes durable before replacing the managed path.
    tx.execute(
        "INSERT INTO library_text_saves(item_id,operation_id,root,path,old_content,old_hash,new_hash,committed)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0)
         ON CONFLICT(item_id) DO UPDATE SET operation_id=excluded.operation_id,root=excluded.root,path=excluded.path,
           old_content=excluded.old_content,old_hash=excluded.old_hash,new_hash=excluded.new_hash,committed=0",
        params![save.id, save.operation_id, root, path, old_content, old_hash, new_hash],
    )?;
    tx.commit()?;

    // The committed receipt, version and index now share one SQLite commit.
    let tx = db.transaction()?;
    if current_item(&tx, &save)?.as_ref() != Some(&item) || read_managed(&save)? != old_content {
        return Ok(json!("conflict"));
    }
    if content_changed {
        if let (Some(old_content), Some(old_hash)) = (&old_content, old_hash) {
            tx.execute(
                "INSERT INTO library_versions(id,item_id,version,content_hash,path,created_by,source_task_id,created_at,snapshot)
                 SELECT ?1,?2,coalesce(max(version),0)+1,?3,?4,?5,?6,?7,?8 FROM library_versions WHERE item_id=?2",
                params![save.operation_id, save.id, old_hash, path, save.created_by, item.source_task_id, save.updated_at, old_content],
            )?;
        }
    }
    tx.execute(
        "UPDATE library_items SET title=?1,filename=?2,size_bytes=?3,content_hash=?4,updated_at=GREATEST(updated_at, ?5) WHERE id=?6",
        params![title, save.next_filename.as_deref().unwrap_or(&save.filename), save.content.len(), new_hash, save.updated_at, save.id],
    )?;
    library_index::index_saved_text(&tx, &save.id, &save.content, &chunks, save.updated_at)?;
    let recorded = tx.execute(
        "UPDATE library_text_saves SET old_content=NULL,committed=1 WHERE item_id=?1 AND operation_id=?2",
        params![save.id, save.operation_id],
    )?;
    if recorded != 1 {
        return Err("missing prepared library text save".into());
    }
    if content_changed {
        replace_file(&save, &old_content)?;
    }
    tx.commit()?;
    Ok(json!("saved"))
}
