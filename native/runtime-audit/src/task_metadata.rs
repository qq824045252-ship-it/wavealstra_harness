use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

pub fn acknowledge(db: &Connection, task_id: &str, at: i64) -> Result<bool> {
    let updated = db.execute(
        "UPDATE tasks SET done_acked_at = GREATEST(coalesce(done_acked_at, ?2), ?2) WHERE id = ?1",
        params![task_id, at],
    )?;
    Ok(updated != 0)
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SidebarEdit {
    Rename { title: String, updated_at: i64 },
    Favorite { is_favorited: bool },
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SidebarStatus {
    Saved { project_id: Option<String> },
    Missing,
    Unavailable,
}

pub fn edit_sidebar(
    db: &mut Connection,
    task_id: &str,
    edit: SidebarEdit,
) -> Result<SidebarStatus> {
    const VISIBLE: &str = "WHERE id = ?1 AND NOT EXISTS (
        SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id = tasks.id AND w.state = 'trashed'
    ) RETURNING project_id";
    let tx = db.transaction()?;
    let project: Option<Option<String>> = match edit {
        SidebarEdit::Rename { title, updated_at } => tx.query_row(
            &format!(
                "UPDATE tasks SET title = coalesce(nullif(?2, ''), title),
               updated_at = GREATEST(updated_at, ?3) {VISIBLE}"
            ),
            params![task_id, title, updated_at],
            |row| row.get(0),
        ),
        SidebarEdit::Favorite { is_favorited } => tx.query_row(
            &format!("UPDATE tasks SET is_favorited = ?2 {VISIBLE}"),
            params![task_id, i64::from(is_favorited)],
            |row| row.get(0),
        ),
    }
    .optional()?;
    let result = if let Some(project_id) = project {
        SidebarStatus::Saved { project_id }
    } else if tx
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
        .optional()?
        .is_some()
    {
        SidebarStatus::Unavailable
    } else {
        SidebarStatus::Missing
    };
    tx.commit()?;
    Ok(result)
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DueDateStatus {
    Saved { project_id: Option<String> },
    Unavailable,
    BeforeStart,
}

pub fn set_due_date(
    db: &mut Connection,
    task_id: &str,
    due_at: Option<i64>,
    next_local_day: Option<i64>,
) -> Result<DueDateStatus> {
    let tx = db.transaction()?;
    let task = tx
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, archived) AS (
                 SELECT s.id, s.parent_id, s.archived FROM spaces s
                 JOIN tasks t ON t.space_id = s.id WHERE t.id = ?1
                 UNION
                 SELECT s.id, s.parent_id, s.archived FROM spaces s
                 JOIN ancestors a ON a.parent_id = s.id
             )
             SELECT project_id, CASE
                 WHEN start_at BETWEEN -8640000000000000 AND 8640000000000000
                 THEN COALESCE(start_at >= ?2, FALSE) ELSE FALSE END
             FROM tasks t WHERE t.id = ?1 AND t.archived = 0
             AND NOT EXISTS (SELECT 1 FROM ancestors WHERE archived != 0)
             AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w
                 WHERE w.task_id = t.id AND w.state = 'trashed')",
            params![task_id, next_local_day],
            |row| Ok((row.get(0)?, row.get::<_, Option<bool>>(1)?.unwrap_or(false))),
        )
        .optional()?;
    let Some((project_id, before_start)) = task else {
        return Ok(DueDateStatus::Unavailable);
    };
    if before_start {
        return Ok(DueDateStatus::BeforeStart);
    }
    tx.execute(
        "UPDATE tasks SET due_at = ?2 WHERE id = ?1",
        params![task_id, due_at],
    )?;
    tx.commit()?;
    Ok(DueDateStatus::Saved { project_id })
}
