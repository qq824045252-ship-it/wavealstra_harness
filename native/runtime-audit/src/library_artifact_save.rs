use crate::{
    Result, library_backup, library_index, library_metadata::ITEMS, library_restore, library_text,
    library_text_save, scoped_notes, sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    artifact_id: String,
    version: i64,
    operation_id: String,
    root: PathBuf,
    space_id: String,
    collection_id: Option<String>,
    owner: Option<library_backup::Owner>,
    actor: Option<Actor>,
    filename: String,
    kind: String,
    mime: String,
    chunk_size: usize,
    overlap: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Actor {
    task_id: Option<String>,
    project_id: Option<String>,
}

#[derive(PartialEq)]
struct Source {
    path: PathBuf,
    title: String,
    task: String,
}

fn source(db: &Connection, s: &Save) -> Result<Source> {
    let (project, workspace): (Option<String>, Option<String>) = db.query_row(
        "SELECT project_id,workspace_id FROM library_spaces WHERE id=?",
        [&s.space_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !scoped_notes::library_owner_writable(db, project.as_deref(), workspace.as_deref())? {
        return Err("归档资料只读".into());
    }
    if let Some(folder) = &s.collection_id {
        if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_collections WHERE id=? AND space_id=?)",
            params![folder, s.space_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err("集合不属于当前资料空间".into());
        }
    }
    let (task,title,root,entry,task_project,task_workspace):(String,Option<String>,String,String,Option<String>,Option<String>)=db.query_row(
        "SELECT a.task_id,a.title,a.root_dir,CASE WHEN a.source_type='managed-content' THEN a.storage_path ELSE a.entry_file END,t.project_id,t.space_id
         FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND a.version=?",
        params![s.artifact_id,s.version], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    if let Some(actor) = &s.actor {
        let (actor_project, actor_workspace): (Option<String>, Option<String>) =
            if let Some(task_id) = &actor.task_id {
                db.query_row(
                    "SELECT project_id,space_id FROM tasks WHERE id=?",
                    [task_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
            } else {
                (actor.project_id.clone(), None)
            };
        let valid: bool = db.query_row(
            "SELECT (?1 IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=?1 AND archived=0))
            AND (?2 IS NULL OR EXISTS(SELECT 1 FROM spaces WHERE id=?2))",
            params![actor_project, actor_workspace],
            |r| r.get(0),
        )?;
        let own_destination =
            (project.is_some() && project == actor_project && workspace.is_none())
                || (workspace.is_some() && workspace == actor_workspace && project.is_none());
        let own_source = actor.task_id.as_ref() == Some(&task)
            || (actor_project.is_some() && actor_project == task_project);
        let kind: String = db.query_row(
            "SELECT kind FROM library_spaces WHERE id=?",
            [&s.space_id],
            |r| r.get(0),
        )?;
        if !(valid && own_destination && own_source) || kind == "personal" {
            return Err("当前任务只能将本任务或同项目成果存入直属可写资料空间".into());
        }
    } else if s.owner.is_none() {
        // Older callers can omit the UI scope; resolve it from the destination.
        let allowed = if let Some(p) = &project {
            task_project.as_ref() == Some(p)
        } else if let Some(w) = &workspace {
            task_workspace.as_ref() == Some(w)
        } else {
            task_project.is_none() && task_workspace.is_none()
        };
        if !allowed {
            return Err("产物来源任务已不属于当前归属".into());
        }
    }
    if let Some(owner) = &s.owner {
        if !library_backup::spaces(db, owner)?.contains(&s.space_id) {
            return Err("目标资料空间已变化".into());
        }
        let permitted = match owner {
            library_backup::Owner::Personal => task_project.is_none() && task_workspace.is_none(),
            library_backup::Owner::Workspace { workspace_id } => {
                task_workspace.as_ref() == Some(workspace_id)
            }
            library_backup::Owner::Project { project_id } => {
                task_project.as_ref() == Some(project_id)
            }
        };
        if !permitted {
            return Err("产物来源任务已不属于当前归属".into());
        }
    }
    let root = fs::canonicalize(root)?;
    let path = fs::canonicalize(root.join(entry))?;
    if !path.starts_with(&root)
        || path.file_name().and_then(|v| v.to_str()) != Some(&s.filename)
        || !path.is_file()
    {
        return Err("产物文件已移动或越界".into());
    }
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| path.file_stem().unwrap().to_string_lossy().into_owned());
    Ok(Source { path, title, task })
}

fn existing(db: &Connection, s: &Save) -> Result<Option<(String, String, String, Option<String>)>> {
    Ok(db.query_row("SELECT id,filename,kind,collection_id FROM library_items WHERE space_id=? AND source_artifact_id=? AND trashed_at IS NULL",
        params![s.space_id,s.artifact_id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?)
}

fn receipt(db: &Connection, s: &Save, id: &str) -> Result<Value> {
    let item = records(
        db,
        &format!("SELECT {ITEMS} FROM library_items WHERE id=?"),
        [id],
    )?
    .pop()
    .ok_or("资料条目缺失")?;
    let result = json!({"status":"updated","item":item});
    db.execute("INSERT INTO library_restore_receipts(root,operation_id,result_json) VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET operation_id=excluded.operation_id,result_json=excluded.result_json",
        params![s.root.to_str(),s.operation_id,result.to_string()])?;
    Ok(result)
}

pub(crate) fn file_hash(mut f: File) -> Result<String> {
    let mut hash = Sha256::new();
    std::io::copy(&mut f, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn resolve_version(path: &Path, op: &str) -> Result<PathBuf> {
    let mut dir = path.as_os_str().to_owned();
    dir.push(".versions");
    let dir = PathBuf::from(dir);
    match fs::symlink_metadata(&dir) {
        Ok(m) if !m.is_dir() || library_text::is_link(&m) => {
            return Err("版本目录无法安全读取".into());
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    Ok(dir.join(op))
}

pub fn write(db: &mut Connection, s: Save, at: i64) -> Result<Value> {
    if !s.root.is_absolute()
        || !library_restore::valid_id(&s.space_id)
        || !library_restore::valid_operation(&s.operation_id)
        || !library_backup::valid_filename(&s.filename)
    {
        return Err("资料标识无效".into());
    }
    library_text::validate_chunk_sizes(s.chunk_size, s.overlap)?;
    let tx = db.transaction()?;
    let src = source(&tx, &s)?;
    let prior = existing(&tx, &s)?;
    let id = if let Some(row) = &prior {
        row.0.clone()
    } else {
        // Concurrent saves use one reservation; a previously trashed copy keeps its identity.
        let mut salt = 0;
        loop {
            let candidate = format!(
                "{:x}",
                Sha256::digest(format!("{}\0{}\0{salt}", s.space_id, s.artifact_id).as_bytes())
            );
            if !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_items WHERE id=?)",
                [&candidate],
                |r| r.get::<_, bool>(0),
            )? {
                break candidate;
            }
            salt += 1;
        }
    };
    if prior.is_some()
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_text_saves WHERE item_id=? AND committed=0)",
            [&id],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err("资料正在保存，或上次保存尚待恢复".into());
    }
    let filename = prior.as_ref().map(|p| &p.1).unwrap_or(&s.filename);
    let target = library_text::managed_path(&s.root, &s.space_id, &id, filename);
    let old_hash = library_text::open_managed(&s.root, &target, &s.space_id, &id)?
        .map(file_hash)
        .transpose()?;
    let new_hash = file_hash(File::open(&src.path)?)?;
    if prior.is_some() && old_hash.as_ref() == Some(&new_hash) {
        if let Some(folder) = &s.collection_id {
            tx.execute("UPDATE library_items SET collection_id=?,updated_at=? WHERE id=? AND collection_id IS DISTINCT FROM ?",params![folder,at,id,folder])?;
        }
        let res = receipt(&tx, &s, &id)?;
        crate::request_control::commit(tx)?;
        return Ok(res);
    }
    let text_stage = target.with_file_name(format!(".mybuddy-note-{}.tmp", s.operation_id));
    if prior.is_some() {
        let accepted=tx.execute("INSERT INTO library_text_saves(item_id,operation_id,root,path,old_content,old_hash,new_hash,committed)
            VALUES(?,?,?,?,NULL,?,?,0) ON CONFLICT(item_id) DO UPDATE SET operation_id=excluded.operation_id,root=excluded.root,path=excluded.path,old_content=NULL,
            old_hash=excluded.old_hash,new_hash=excluded.new_hash,committed=0 WHERE library_text_saves.committed=1",
            params![id,s.operation_id,s.root.to_str(),target.to_str(),old_hash,new_hash])?;
        if accepted != 1 {
            return Err("资料正在保存".into());
        }
    } else {
        if old_hash.is_some() {
            return Err("目标文件已被占用".into());
        }
        library_restore::reserve_file(
            &tx,
            s.root.to_str().ok_or("无效资料路径")?,
            &s.operation_id,
            &s.space_id,
            &id,
            filename,
        )?;
    }
    crate::request_control::commit(tx)?;
    let apply = (|| -> Result<Value> {
        let mut input = File::open(&src.path)?;
        let temp = if prior.is_some() {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&text_stage)?;
            std::io::copy(&mut input, &mut file)?;
            file.sync_all()?;
            text_stage.clone()
        } else {
            library_restore::stage_reader(&target, &mut input, &s.operation_id, &id)?
        };
        let size = fs::metadata(&temp)?.len();
        if file_hash(File::open(&temp)?)? != new_hash {
            return Err("源产物已变化".into());
        }
        let tx = db.transaction()?;
        if src != source(&tx, &s)?
            || existing(&tx, &s)? != prior
            || file_hash(File::open(&src.path)?)? != new_hash
            || library_text::open_managed(&s.root, &target, &s.space_id, &id)?
                .map(file_hash)
                .transpose()?
                != old_hash
        {
            return Err("产物或资料在保存期间已改变".into());
        }
        let kind = prior.as_ref().map(|p| &p.2).unwrap_or(&s.kind);
        let actor: String = tx.query_row(
            "SELECT coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我')",
            [],
            |r| r.get(0),
        )?;
        if prior.is_some() {
            if let Some(hash) = &old_hash {
                let version = resolve_version(&target, &s.operation_id)?;
                fs::create_dir_all(version.parent().ok_or("版本目录无效")?)?;
                fs::hard_link(&target, &version)?;
                #[cfg(unix)]
                File::open(version.parent().unwrap())?.sync_all()?;
                tx.execute("INSERT INTO library_versions(id,item_id,version,content_hash,path,created_by,source_task_id,created_at)
                    SELECT ?,?,coalesce(max(version),0)+1,?,?,?,?,? FROM library_versions WHERE item_id=?",
                    params![s.operation_id,id,hash,version.to_str(),actor,src.task,at,id])?;
            }
            tx.execute("UPDATE library_items SET collection_id=coalesce(?,collection_id),content_hash=?,size_bytes=?,original_path=?,updated_at=? WHERE id=?",
                params![s.collection_id,new_hash,size,src.path.to_str(),at,id])?;
            if tx.execute("UPDATE library_text_saves SET committed=1 WHERE item_id=? AND operation_id=? AND committed=0",params![id,s.operation_id])?!=1 {return Err("产物保存回执已变化".into());}
        } else {
            tx.execute("INSERT INTO library_items(id,space_id,collection_id,kind,title,filename,mime_type,size_bytes,owner,source_type,source_task_id,source_artifact_id,original_path,content_hash,created_at,updated_at,last_visited_at)
                VALUES(?,?,?,?,?,?,?,?,?,'artifact',?,?,?,?,?,?,?)",params![id,s.space_id,s.collection_id,kind,src.title,filename,s.mime,size,actor,src.task,s.artifact_id,src.path.to_str(),new_hash,at,at,at])?;
        }
        if matches!(kind.as_str(), "html" | "markdown" | "csv") {
            let mut f = File::open(&temp)?;
            if size as usize > library_text::LARGE_TEXT_BYTES {
                library_index::index_streamed_text(&tx, &id, &mut f, at, s.chunk_size, s.overlap)?;
            } else {
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes)?;
                let body = String::from_utf8_lossy(&bytes);
                let chunks = library_index::document_chunks(&body, s.chunk_size, s.overlap)?;
                library_index::index_saved_text(&tx, &id, &body, &chunks, at)?;
            }
        } else {
            library_index::refresh_item_fts(&tx, &id, None)?;
        }
        let res = receipt(&tx, &s, &id)?;
        if prior.is_some() {
            fs::rename(&temp, &target)?;
            #[cfg(unix)]
            File::open(target.parent().unwrap())?.sync_all()?;
        } else {
            library_restore::commit_staged(&target, &s.operation_id, &id)?;
        }
        crate::request_control::commit(tx)?;
        Ok(res)
    })();
    if prior.is_none() {
        library_restore::recover(db, &s.root, Some(&s.operation_id))?;
    } else if apply.is_err() {
        library_text_save::recover_one(db, &s.root, &id)?;
    }
    apply
}
