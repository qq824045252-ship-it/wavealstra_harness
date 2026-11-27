use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedTask {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trashed_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purge_after: Option<f64>,
    #[serde(skip)]
    trash_path: Option<String>,
    directory_missing: bool,
}

pub fn list(db: &Connection) -> Result<Vec<TrashedTask>> {
    let mut query = db.prepare(
        "SELECT t.id,t.title,t.space_id,t.project_id,w.trashed_at,w.purge_after,w.trash_path
         FROM task_execution_workspace_state w JOIN tasks t ON t.id=w.task_id
         WHERE w.state='trashed'
         ORDER BY coalesce(w.trashed_at,0) DESC,w.updated_at DESC,w.rowid",
    )?;
    let rows = query.query_map([], |row| {
        Ok(TrashedTask {
            id: row.get(0)?,
            title: row.get(1)?,
            space_id: row.get(2)?,
            project_id: row.get(3)?,
            trashed_at: row.get(4)?,
            purge_after: row.get(5)?,
            trash_path: row.get(6)?,
            directory_missing: true,
        })
    })?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}

pub fn check_directories(root: &Path, mut rows: Vec<TrashedTask>) -> Vec<TrashedTask> {
    for row in &mut rows {
        if let Some(path) = row.trash_path.take().filter(|path| !path.is_empty()) {
            let path = Path::new(&path);
            row.directory_missing = !path.exists()
                && !path
                    .file_name()
                    .is_some_and(|name| root.join(name).exists());
        }
    }
    rows
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueTask {
    task_id: String,
    project_id: Option<String>,
}

pub fn due(db: &Connection, now: i64) -> Result<Vec<DueTask>> {
    let mut query = db.prepare(
        "SELECT w.task_id,t.project_id FROM task_execution_workspace_state w
         LEFT JOIN tasks t ON t.id=w.task_id
         WHERE w.state='trashed' AND w.purge_after<=?1
         ORDER BY w.updated_at DESC,w.rowid",
    )?;
    let rows = query.query_map([now], |row| {
        Ok(DueTask {
            task_id: row.get(0)?,
            project_id: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RetentionReply {
    Saved { changed: usize },
    Rejected { message: String },
}

pub fn align_retention(db: &Connection, retention_ms: i64) -> RetentionReply {
    match db.execute(
        "UPDATE task_execution_workspace_state
         SET purge_after=coalesce(trashed_at,updated_at)+?1
         WHERE state='trashed'
         AND coalesce(trashed_at,updated_at) BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
         AND (purge_after IS NULL OR purge_after>coalesce(trashed_at,updated_at)+?1)",
        [retention_ms],
    ) {
        Ok(changed) => RetentionReply::Saved { changed },
        Err(error) => RetentionReply::Rejected { message: error.to_string() },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purge {
    task_id: String,
    updated_at: f64,
    trashed_at: Option<f64>,
    trash_path: Option<String>,
    archive_scope: Option<ArchiveScope>,
}

impl Purge {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveScope {
    direct: DirectArchive,
    selected_roots: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum DirectArchive {
    Explicit,
    Inherited,
    None,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PurgeReply {
    Saved,
    Rejected { message: String },
}

pub fn purge(db: &mut Connection, request: Purge) -> PurgeReply {
    match apply_purge(db, request) {
        Ok(()) => PurgeReply::Saved,
        Err(error) => PurgeReply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply_purge(db: &mut Connection, request: Purge) -> Result<()> {
    let id = &request.task_id;
    if id == crate::DOTS_TASK_ID {
        return Err("Dots 对话不能作为普通任务删除".into());
    }
    let tx = db.transaction()?;
    let same_entry: bool = tx
        .query_row(
            "SELECT state='trashed' AND updated_at IS NOT DISTINCT FROM ?2 AND trashed_at IS NOT DISTINCT FROM ?3 AND trash_path IS NOT DISTINCT FROM ?4
         FROM task_execution_workspace_state WHERE task_id=?1",
            params![
                id,
                request.updated_at,
                request.trashed_at,
                request.trash_path
            ],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if !same_entry {
        return Err(format!("purge 中止：回收站条目已变化：{id}").into());
    }
    if let Some(scope) = request.archive_scope {
        if !in_archive_scope(&tx, id, scope)? {
            return Err("任务或所属空间已恢复，已停止彻底删除".into());
        }
    }
    delete_task_rows_in_tx(&tx, id)?;
    crate::request_control::commit(tx)?;
    Ok(())
}

pub(crate) fn delete_task_rows_in_tx(tx: &Connection, id: &str) -> Result<()> {
    if crate::gateway_execution_authority::gateway_task_id(id) {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
            [id],
            |row| row.get(0),
        )?;
        if exists {
            crate::gateway_admission::retire_task_routes(tx, id)?;
        }
        tx.execute("DELETE FROM gateway_execution_sources WHERE task_id=?1", [id])?;
    }
    let directory: Option<String> = tx.query_row(
        "SELECT directory FROM durable_bot_bindings WHERE task_id=?1", [id], |row| row.get(0),
    ).optional()?;
    if let Some(directory) = directory {
        crate::pi_storage::retire_task_store_in_tx(tx, Path::new(&directory))?;
    }
    // Keep the bounded excerpt for memories that refer to these conversation turns.
    tx.execute(
        "UPDATE memory_evidence
         SET excerpt=coalesce(nullif(excerpt,''), (
            SELECT substr('用户：' || t.user_text || chr(10) || '助手：' || t.assistant_text,1,1200)
            FROM memory_turns t WHERE t.id=memory_evidence.ref_id
         ))
         WHERE evidence_kind='conversation' AND ref_id IN (SELECT id FROM memory_turns WHERE task_id=?1)",
        [id],
    )?;
    crate::artifact_write::delete_artifacts(tx, id, None)?;
    for sql in [
        "DELETE FROM memory_turns WHERE task_id=?1",
        "DELETE FROM memory_pipeline_state WHERE task_id=?1",
        "DELETE FROM memory_skill_effectiveness WHERE task_id=?1",
        "DELETE FROM artifact_task_revisions WHERE task_id=?1",
        "DELETE FROM artifact_task_state WHERE task_id=?1",
        "DELETE FROM artifact_write_receipts WHERE task_id=?1",
        "DELETE FROM task_runtime_context_snapshots WHERE task_id=?1",
        "DELETE FROM agent_loadout_observations WHERE task_id=?1",
        "DELETE FROM runtime_snapshot_receipts WHERE task_id=?1",
        "DELETE FROM task_request_diagnostics WHERE task_id=?1",
        "DELETE FROM task_tool_diagnostics WHERE task_id=?1",
        "DELETE FROM conversation_interactions WHERE task_id=?1",
        "DELETE FROM task_code_review WHERE task_id=?1",
        "DELETE FROM task_expert_bindings WHERE task_id=?1",
        "DELETE FROM durable_bot_memory_projection WHERE task_id=?1",
        "DELETE FROM durable_bot_message_workspaces WHERE task_id=?1",
        "DELETE FROM durable_bot_workspace_moves WHERE task_id=?1",
        "DELETE FROM durable_bot_bindings WHERE task_id=?1",
        "DELETE FROM gateway_sidebar_conversations WHERE task_id=?1",
        "DELETE FROM task_execution_workspace_state WHERE task_id=?1",
        "DELETE FROM tasks WHERE id=?1",
        "DELETE FROM task_library_references WHERE task_id=?1",
    ] {
        tx.execute(sql, [id])?;
    }
    crate::trigger_effects::on_task_deleted_in_tx(tx, id)?;
    Ok(())
}

fn in_archive_scope(db: &Connection, id: &str, scope: ArchiveScope) -> Result<bool> {
    let explicitly_archived = matches!(scope.direct, DirectArchive::Explicit);
    let directly_selected = !matches!(scope.direct, DirectArchive::None);
    let selected_filter = if scope.selected_roots.is_empty() {
        "FALSE".to_owned()
    } else {
        format!("a.id IN ({})", crate::database::anon_placeholders(scope.selected_roots.len()))
    };
    let sql = format!(
        "WITH RECURSIVE ancestors(id,parent_id,archived) AS (
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON t.space_id=s.id WHERE t.id=?
            UNION
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
         ), selected_ancestors(id,parent_id,archived) AS (
            SELECT a.id,a.parent_id,a.archived FROM ancestors a WHERE {selected_filter}
            UNION
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN selected_ancestors a ON s.id=a.parent_id
         )
         SELECT EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND (
             (? AND t.archived!=0) OR (? AND EXISTS (SELECT 1 FROM ancestors WHERE archived!=0))
             OR EXISTS (SELECT 1 FROM selected_ancestors WHERE archived!=0)
         ))"
    );
    let mut params_vec: Vec<duckdb::types::Value> = vec![duckdb::types::Value::Text(id.to_owned())];
    for r in scope.selected_roots {
        params_vec.push(duckdb::types::Value::Text(r));
    }
    params_vec.push(duckdb::types::Value::Text(id.to_owned()));
    params_vec.push(duckdb::types::Value::Boolean(explicitly_archived));
    params_vec.push(duckdb::types::Value::Boolean(directly_selected));
    Ok(db.query_row(&sql, duckdb::params_from_iter(params_vec), |row| row.get(0))?)
}
