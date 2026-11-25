use crate::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    id: String,
    archive_roots: Option<Vec<String>>,
    dots_task_id: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Reply {
    match apply(db, mutation) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, mutation: Mutation) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id = &mutation.id;
    if let Some(roots) = &mutation.archive_roots {
        if !in_archived_selection(&tx, id, roots)? {
            return Err("空间已恢复或移动，已停止彻底删除".into());
        }
        let has_tasks: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE space_id=?1 AND id!=?2)",
            params![id, mutation.dots_task_id],
            |row| row.get(0),
        )?;
        if has_tasks {
            return Err("空间仍有未删除的任务、子空间或自有资料，请处理失败项后重试".into());
        }
    }
    let blocked: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM spaces WHERE parent_id=?1)
         OR EXISTS(SELECT 1 FROM tasks t WHERE t.space_id=?1 AND (
             EXISTS(SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=t.id)
             OR NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
         ))
         OR EXISTS(SELECT 1 FROM library_spaces l JOIN library_items i ON i.space_id=l.id WHERE l.workspace_id=?1)",
        [id], |row| row.get(0),
    )?;
    if blocked {
        let name: Option<String> = tx
            .query_row("SELECT name FROM spaces WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        return Err(format!(
            "空间「{}」尚有子空间、任务或自有资料，拒绝删除（请先迁移或清空资料）",
            name.as_deref().unwrap_or(id)
        )
        .into());
    }
    tx.execute(
        "UPDATE tasks SET space_id=NULL,space_sort_order=0 WHERE space_id=?1 AND EXISTS (
          SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=tasks.id AND w.state='trashed')",
        [id],
    )?;
    for sql in [
        "DELETE FROM workspace_library_links WHERE workspace_id=?1 OR library_space_id IN (SELECT id FROM library_spaces WHERE workspace_id=?1)",
        "DELETE FROM workspace_library_collection_links WHERE workspace_id=?1 OR library_space_id IN (SELECT id FROM library_spaces WHERE workspace_id=?1)",
        "DELETE FROM library_spaces WHERE workspace_id=?1",
        "DELETE FROM spaces WHERE id=?1",
    ] {
        tx.execute(sql, [id])?;
    }
    tx.commit()?;
    Ok(())
}

fn in_archived_selection(db: &Connection, id: &str, roots: &[String]) -> Result<bool> {
    let roots = serde_json::to_string(roots)?;
    Ok(db.query_row(
        "WITH RECURSIVE ancestors(id,parent_id,archived) AS (
            SELECT id,parent_id,archived FROM spaces WHERE id=?1
            UNION
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
         ), selected_ancestors(id,parent_id,archived) AS (
            SELECT a.id,a.parent_id,a.archived FROM ancestors a JOIN json_each(?2) roots ON roots.value=a.id
            UNION
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN selected_ancestors a ON s.id=a.parent_id
         )
         SELECT EXISTS(SELECT 1 FROM selected_ancestors WHERE archived!=0)",
        params![id, roots], |row| row.get(0),
    )?)
}
