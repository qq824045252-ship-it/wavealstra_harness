use crate::{
    Result, library_backup, library_index, library_metadata::ITEMS, library_restore, library_text,
    scoped_notes, sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    operation_id: String,
    source_note_id: Option<String>,
    root: PathBuf,
    space_id: String,
    files: Vec<Item>,
    project: Option<Project>,
    owner: Option<library_backup::Owner>,
    #[serde(default)]
    default_space: bool,
    #[serde(default)]
    folders: Vec<Folder>,
    chunk_size: usize,
    overlap: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    collection_id: Option<String>,
    filename: String,
    title: String,
    kind: String,
    mime_type: String,
    original_path: Option<String>,
    content_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    parent_id: Option<String>,
    name: String,
}

fn ensure_scope(db: &Connection, b: &Batch, space: &str, at: i64) -> Result<()> {
    use library_backup::Owner;
    let Some(owner) = &b.owner else { return Ok(()) };
    let owned = library_backup::spaces(db, owner)?;
    if !owned.iter().any(|id| id == space) {
        if !b.default_space {
            return Err("目标不属于当前查看范围".into());
        }
        let (project, workspace, name, kind) = match owner {
            Owner::Personal => (None, None, String::from("我的文档"), "personal"),
            Owner::Project { project_id } => (
                Some(project_id),
                None,
                db.query_row(
                    "SELECT left(name,80)||'资料' FROM projects WHERE id=?",
                    [project_id],
                    |r| r.get(0),
                )?,
                "team",
            ),
            Owner::Workspace { workspace_id } => (
                None,
                Some(workspace_id),
                db.query_row(
                    "SELECT left(name,80)||'资料' FROM spaces WHERE id=?",
                    [workspace_id],
                    |r| r.get(0),
                )?,
                "team",
            ),
        };
        if !scoped_notes::library_owner_writable(
            db,
            project.map(String::as_str),
            workspace.map(String::as_str),
        )? {
            return Err("归档资料只读".into());
        }
        db.execute("INSERT INTO library_spaces(id,name,kind,project_id,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![space,name,kind,project,workspace,at,at])?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    event_id: String,
    reference: String,
    body: Option<String>,
    extract_status: String,
    truncated: bool,
    original_size: i64,
}

fn check(db: &Connection, space: &str, items: &[Item]) -> Result<()> {
    let (project, workspace): (Option<String>, Option<String>) = db.query_row(
        "SELECT project_id,workspace_id FROM library_spaces WHERE id=?",
        [space],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !scoped_notes::library_owner_writable(db, project.as_deref(), workspace.as_deref())? {
        return Err("归档资料仅可读取".into());
    }
    for item in items {
        if let Some(folder) = &item.collection_id {
            if !db.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_collections WHERE id=? AND space_id=?)",
                params![folder, space],
                |r| r.get::<_, bool>(0),
            )? {
                return Err("集合不属于该空间".into());
            }
        }
    }
    Ok(())
}

fn existing(db: &Connection, project: &Project) -> Result<Option<Value>> {
    let archived: bool = db.query_row(
        "SELECT archived<>0 FROM projects WHERE id=?",
        [&project.id],
        |r| r.get(0),
    )?;
    if archived {
        return Err("已归档项目仅可读取".into());
    }
    let result=db.query_row("SELECT id,json_extract_string(payload_json,'$.libraryItemId') FROM project_events WHERE project_id=? AND source='document' AND ref=? ORDER BY created_at,id LIMIT 1",
        params![project.id,project.reference],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)) ).optional()?;
    if let Some((event_id, id)) = result {
        let row = records(
            db,
            &format!("SELECT {ITEMS} FROM library_items WHERE id=?"),
            [id],
        )?
        .pop();
        return Ok(Some(
            json!({"status":"updated","eventId":event_id,"item":row,"reused":true}),
        ));
    }
    Ok(None)
}

pub fn apply(db: &mut Connection, b: Batch, at: i64) -> Result<Value> {
    let root_key = b.root.to_str().ok_or("资料路径无效")?;
    if !b.root.is_absolute()
        || !library_restore::valid_operation(&b.operation_id)
        || !library_restore::valid_id(&b.space_id)
        || (b.files.is_empty() && (b.project.is_some() || b.folders.is_empty()))
    {
        return Err("资料导入参数无效".into());
    }
    library_text::validate_chunk_sizes(b.chunk_size, b.overlap)?;
    let mut space = b.space_id.clone();
    let tx = db.transaction()?;
    if let Some(p) = &b.project {
        if let Some(found) = existing(&tx, p)? {
            return Ok(found);
        }
        if let Some(id) = tx
            .query_row(
                "SELECT id FROM library_spaces WHERE project_id=? ORDER BY created_at,id LIMIT 1",
                [&p.id],
                |r| r.get(0),
            )
            .optional()?
        {
            space = id;
        }
    } else if let Some(owner) = &b.owner {
        if b.default_space {
            space = match owner {
                library_backup::Owner::Personal => "personal".into(),
                _ => library_backup::spaces(&tx, owner)?
                    .into_iter()
                    .next()
                    .unwrap_or(space),
            };
        } else if !library_backup::spaces(&tx, owner)?.contains(&space) {
            return Err("目标不属于当前查看范围".into());
        }
    } else {
        check(&tx, &space, &b.files)?;
    }
    for item in &b.files {
        if !library_restore::valid_operation(&item.id)
            || !library_backup::valid_filename(&item.filename)
        {
            return Err("无效的导入条目".into());
        }
        library_restore::reserve_file(
            &tx,
            root_key,
            &b.operation_id,
            &space,
            &item.id,
            &item.filename,
        )?;
    }
    crate::request_control::commit(tx)?;
    let apply = (|| -> Result<Value> {
        let mut staged = Vec::new();
        let inputs = std::env::temp_dir().join(format!("mybuddy-import-{}", b.operation_id));
        for item in &b.files {
            let path = library_text::managed_path(&b.root, &space, &item.id, &item.filename);
            if library_text::open_managed(&b.root, &path, &space, &item.id)?.is_some() {
                return Err("目标文件已存在".into());
            }
            let input = inputs.join(&item.id);
            if !input.symlink_metadata()?.is_file() || !inputs.symlink_metadata()?.is_dir() {
                return Err("导入暂存文件不安全".into());
            }
            let temp = library_restore::stage_reader(
                &path,
                &mut File::open(input)?,
                &b.operation_id,
                &item.id,
            )?;
            let mut hasher = Sha256::new();
            let size = std::io::copy(&mut File::open(&temp)?, &mut hasher)?;
            if format!("{:x}", hasher.finalize()) != item.content_hash {
                return Err("文件在导入期间已变化".into());
            }
            staged.push((path, temp, size));
        }
        let tx = db.transaction()?;
        if let Some(p) = &b.project {
            if let Some(found) = existing(&tx, p)? {
                return Ok(found);
            }
            tx.execute("INSERT INTO library_spaces(id,name,kind,project_id,created_at,updated_at) SELECT ?1,name||'·项目资料','team',id,?2,?2 FROM projects WHERE id=?3 AND NOT EXISTS(SELECT 1 FROM library_spaces WHERE id=?1)",params![space,at,p.id])?;
            let owned: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_spaces WHERE id=? AND project_id=?)",
                params![space, p.id],
                |r| r.get(0),
            )?;
            if !owned {
                return Err("项目资料归属已变化".into());
            }
        }
        ensure_scope(&tx, &b, &space, at)?;
        for folder in &b.folders {
            if !library_restore::valid_operation(&folder.id) || folder.name.trim().is_empty() {
                return Err("无效的集合".into());
            }
            if let Some(parent) = &folder.parent_id {
                if !tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM library_collections WHERE space_id=? AND id=?)",
                    params![space, parent],
                    |r| r.get::<_, bool>(0),
                )? {
                    return Err("上级集合不属于目标空间".into());
                }
            }
            tx.execute("INSERT INTO library_collections(id,space_id,parent_id,name,owner,created_at,updated_at) VALUES(?1,?2,?3,?4,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),?5,?5)",params![folder.id,space,folder.parent_id,folder.name,at])?;
        }
        check(&tx, &space, &b.files)?;
        if let Some(note) = &b.source_note_id {
            let [image] = b.files.as_slice() else { return Err("笔记图片数量不符".into()) };
            if image.kind != "image" || !tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM library_items WHERE id=? AND space_id=? AND collection_id IS NOT DISTINCT FROM ? AND kind='markdown' AND trashed_at IS NULL)",
                params![note,space,image.collection_id], |r| r.get::<_,bool>(0),
            )? { return Err("笔记位置已变化，请重新插入图片".into()); }
        }
        for (item, (path, temp, size)) in b.files.iter().zip(&staged) {
            tx.execute("INSERT INTO library_items(id,space_id,collection_id,kind,title,filename,mime_type,size_bytes,owner,source_type,original_path,content_hash,created_at,updated_at,last_visited_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),'uploaded',?9,?10,?11,?11,?11)",
                params![item.id,space,item.collection_id,item.kind,item.title,item.filename,item.mime_type,size,item.original_path,item.content_hash,at])?;
            if matches!(item.kind.as_str(), "markdown" | "html" | "csv") {
                let mut file = File::open(temp)?;
                if *size as usize > library_text::LARGE_TEXT_BYTES {
                    library_index::index_streamed_text(
                        &tx,
                        &item.id,
                        &mut file,
                        at,
                        b.chunk_size,
                        b.overlap,
                    )?;
                } else {
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes)?;
                    let text = String::from_utf8_lossy(&bytes);
                    let chunks = library_index::document_chunks(&text, b.chunk_size, b.overlap)?;
                    library_index::index_saved_text(&tx, &item.id, &text, &chunks, at)?;
                }
            } else {
                library_index::refresh_item_fts(&tx, &item.id, None)?;
            }
            library_restore::commit_staged(path, &b.operation_id, &item.id)?;
        }
        if let Some(p) = &b.project {
            let main = &b.files[0];
            let payload = json!({"libraryItemId":main.id,"sizeBytes":p.original_size,"extractStatus":p.extract_status,"extractTruncated":p.truncated});
            let title: String = main
                .filename
                .chars()
                .scan(0, |n, c| {
                    *n += c.len_utf16();
                    (*n <= 200).then_some(c)
                })
                .collect();
            tx.execute("INSERT INTO project_events(id,project_id,source,kind,title,body,ref,payload_json,created_at) VALUES(?,?,'document','note',?,?,?,?,?)",
                params![p.event_id,p.id,title,p.body,p.reference,payload.to_string(),at])?;
            tx.execute("DELETE FROM project_events WHERE project_id=?1 AND id NOT IN(SELECT id FROM project_events WHERE project_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1000)",[&p.id])?;
        }
        let row = if let Some(main) = b.files.first() {
            records(
                &tx,
                &format!("SELECT {ITEMS} FROM library_items WHERE id=?"),
                [&main.id],
            )?
            .pop()
        } else {
            None
        };
        crate::request_control::commit(tx)?;
        Ok(
            json!({"status":"updated","item":row,"eventId":b.project.as_ref().map(|p|&p.event_id),"reused":false}),
        )
    })();
    library_restore::recover(db, &b.root, Some(&b.operation_id))?;
    apply
}
