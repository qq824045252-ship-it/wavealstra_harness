use crate::{
    Result, library_backup, library_index, library_restore, library_text,
    project_write::{self, Status},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::ErrorKind, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    operation_id: String,
    project_id: String,
    event_id: String,
    promotion_id: String,
    promoted_by: String,
    actor_task_id: Option<String>,
    created_at: i64,
    root: PathBuf,
    space_id: String,
    space_name: String,
    item_id: String,
    title: String,
    content: String,
    owner: String,
    saved_at: i64,
    chunk_size: usize,
    overlap: usize,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Changed,
    ExistingPromotion,
    NeedsHost,
    Rejected { message: String },
}

#[derive(PartialEq)]
struct Destination {
    event_title: String,
    space_id: String,
    new_space: bool,
}

fn plan(db: &Connection, request: &Promotion) -> Result<Option<Destination>> {
    match project_write::writable_project_scope(db, &request.project_id, request.actor_task_id.as_deref())? {
        Status::Changed => {}
        Status::Archived => return Err("项目已归档（只读）：可以读取，但不能写入项目资料/上下文/记忆；独立任务也不提供个人资料库作为写入退路。".into()),
        Status::ScopeChanged => return Err("任务的项目归属已变化，请重新读取".into()),
        _ => return Err(format!("项目不存在：{}", request.project_id).into()),
    }
    let event: Option<(String, bool)> = db
        .query_row(
        "SELECT title, CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.libraryItemId') IS 'text' ELSE 0 END
         FROM project_events WHERE id=?1 AND project_id=?2",
            params![request.event_id, request.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((event_title, already_has_file)) = event else {
        return Err(format!("事件不存在：{}", request.event_id).into());
    };
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_event_promotions WHERE project_id=?1 AND event_id=?2 AND target_kind='library')",
        params![request.project_id, request.event_id],
        |row| row.get::<_, bool>(0),
    )? {
        return Ok(None);
    }
    if already_has_file {
        return Err(
            "该事件已关联资料库条目（文件导入），无需重复保存为资料；可提升为记忆或计划。".into(),
        );
    }
    let current_space: Option<String> = db
        .query_row(
            "SELECT id FROM library_spaces WHERE project_id=?1 ORDER BY created_at,rowid LIMIT 1",
            [&request.project_id],
            |row| row.get(0),
        )
        .optional()?;
    let new_space = current_space.is_none();
    let space_id = current_space.unwrap_or_else(|| request.space_id.clone());
    if !library_restore::valid_id(&space_id) {
        return Err("资料空间路径无效".into());
    }
    if new_space {
        if request.space_name.encode_utf16().count() > 100 {
            return Err("空间名称不能超过 100 字符".into());
        }
        match fs::symlink_metadata(request.root.join(&space_id)) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => return Err("本地存在同名受管目录，无法安全创建资料空间".into()),
        }
    }
    Ok(Some(Destination {
        event_title,
        space_id,
        new_space,
    }))
}

pub fn promote(db: &mut Connection, request: Promotion) -> Result<Reply> {
    if !request.root.is_absolute()
        || !library_restore::valid_operation(&request.operation_id)
        || !library_restore::valid_id(&request.item_id)
    {
        return Err("资料写入位置无效".into());
    }
    library_text::validate_chunk_sizes(request.chunk_size, request.overlap)?;
    let root = request.root.to_str().ok_or("资料写入路径无效")?;
    let filename = format!("{}.md", request.title);
    if !library_backup::valid_filename(&filename) {
        return Err("资料文件名无效".into());
    }
    let write_guard = crate::write_gate::enter()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if project_write::has_receipt(&tx, &request.operation_id)? {
        return Ok(Reply::Changed);
    }
    let Some(destination) = plan(&tx, &request)? else {
        return Ok(Reply::ExistingPromotion);
    };
    let path = library_text::managed_path(
        &request.root,
        &destination.space_id,
        &request.item_id,
        &filename,
    );
    if library_text::open_managed(
        &request.root,
        &path,
        &destination.space_id,
        &request.item_id,
    )?
    .is_some()
    {
        return Err("本地存在同名受管文件，无法安全保存".into());
    }
    library_restore::reserve_file(
        &tx,
        root,
        &request.operation_id,
        &destination.space_id,
        &request.item_id,
        &filename,
    )?;
    crate::request_control::commit(tx)?;
    drop(write_guard);

    let applied = apply(db, &request, &destination, &filename, &path);
    let cleanup = library_restore::recover(db, &request.root, Some(&request.operation_id));
    match (applied, cleanup) {
        (Ok(reply), Ok(_)) => Ok(reply),
        (Ok(reply), Err(error)) => {
            eprintln!("Project library promotion cleanup will retry: {error}");
            Ok(reply)
        }
        (Err(error), Ok(0)) if error.is::<library_restore::UnsupportedLink>() => {
            Ok(Reply::NeedsHost)
        }
        (Err(error), Ok(0)) => Err(error),
        (Err(error), Ok(_)) => Err(format!("{error}。暂存文件将在下次启动时重试清理").into()),
        (Err(error), Err(cleanup_error)) => {
            Err(format!("{error}。暂存文件将在下次启动时重试清理：{cleanup_error}").into())
        }
    }
}

fn apply(
    db: &mut Connection,
    request: &Promotion,
    destination: &Destination,
    filename: &str,
    path: &std::path::Path,
) -> Result<Reply> {
    let chunks =
        library_index::document_chunks(&request.content, request.chunk_size, request.overlap)?;
    let write_guard = crate::write_gate::enter()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(current) = plan(&tx, request)? else {
        return Ok(Reply::ExistingPromotion);
    };
    if &current != destination {
        return Err("项目资料空间已变化，请刷新后重试".into());
    }
    let space = &destination.space_id;
    if destination.new_space {
        let inserted = tx.execute(
            "INSERT INTO library_spaces(id,name,kind,project_id,created_at,updated_at) VALUES (?1,?2,'team',?3,?4,?4)",
            params![space, request.space_name, request.project_id, request.saved_at],
        )?;
        if inserted != 1 {
            return Err(rusqlite::Error::StatementChangedRows(inserted).into());
        }
    }
    let content = request.content.as_bytes();
    library_restore::publish(path, content, &request.operation_id, &request.item_id)?;
    let inserted = tx.execute(
        "INSERT INTO library_items(id,space_id,kind,title,filename,mime_type,size_bytes,owner,
           source_type,content_hash,created_at,updated_at,last_visited_at)
         VALUES (?1,?2,'markdown',?3,?4,'text/markdown',?5,?6,'created',?7,?8,?8,?8)",
        params![
            request.item_id,
            space,
            request.title,
            filename,
            content.len(),
            request.owner,
            format!("{:x}", Sha256::digest(content)),
            request.saved_at
        ],
    )?;
    if inserted != 1 {
        return Err(rusqlite::Error::StatementChangedRows(inserted).into());
    }
    let seed = format!("# {}\n\n", request.title);
    if seed != request.content {
        tx.execute(
            "INSERT INTO library_versions(id,item_id,version,content_hash,path,created_by,created_at,snapshot)
             VALUES (?1,?2,1,?3,?4,?5,?6,?7)",
            params![request.operation_id, request.item_id, format!("{:x}", Sha256::digest(seed.as_bytes())),
                path.to_str().ok_or("历史版本路径无效")?, request.owner, request.saved_at, seed.as_bytes()],
        )?;
    }
    library_index::index_saved_text(
        &tx,
        &request.item_id,
        &request.content,
        &chunks,
        request.saved_at,
    )?;
    let linked = tx.execute(
        "INSERT INTO project_event_promotions(id,project_id,event_id,event_title,target_kind,target_id,target_title,promoted_by,created_at)
         VALUES (?1,?2,?3,?4,'library',?5,?6,?7,?8)",
        params![request.promotion_id, request.project_id, request.event_id, destination.event_title,
            request.item_id, request.title, request.promoted_by, request.created_at],
    )?;
    if linked != 1 {
        return Err(rusqlite::Error::StatementChangedRows(linked).into());
    }
    project_write::record_receipt(&tx, &request.operation_id)?;
    crate::request_control::commit(tx)?;
    drop(write_guard);
    Ok(Reply::Changed)
}
