use crate::Result;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTaskCandidate {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_file: Option<String>,
}

pub fn read(
    db: &Connection,
    dots_task_id: &str,
    task_ids: &[String],
    space_ids: &[String],
) -> Result<Vec<ArchiveTaskCandidate>> {
    let task_ids = serde_json::to_string(task_ids)?;
    let space_ids = serde_json::to_string(space_ids)?;
    let mut statement = db.prepare_cached(
        "SELECT id,space_id,project_id,archived,cwd,session_file FROM tasks
         WHERE id != ?1 AND (id IN (SELECT value FROM json_each(?2))
            OR space_id IN (SELECT value FROM json_each(?3)))
         ORDER BY updated_at DESC,rowid",
    )?;
    let rows = statement.query_map(params![dots_task_id, task_ids, space_ids], |row| {
        Ok(ArchiveTaskCandidate {
            id: row.get(0)?,
            space_id: row.get(1)?,
            project_id: row.get(2)?,
            archived: row.get(3)?,
            cwd: row.get(4)?,
            session_file: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
