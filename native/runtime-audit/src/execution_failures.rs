use crate::Result;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFailureRow {
    record_json: String,
    resolved_at: Option<i64>,
    dismissed_at: Option<i64>,
}

pub fn list(db: &Connection, task_id: &str) -> Result<Vec<ExecutionFailureRow>> {
    let mut query = db.prepare_cached(
        "SELECT record_json, resolved_at, dismissed_at FROM execution_failures
         WHERE task_id=?1 AND dismissed_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 100",
    )?;
    let rows = query.query_map([task_id], |row| {
        Ok(ExecutionFailureRow {
            record_json: row.get(0)?,
            resolved_at: row.get(1)?,
            dismissed_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DismissReply {
    Saved { dismissed: bool },
    Rejected { message: String },
}

pub fn dismiss(db: &Connection, task_id: &str, id: &str, at: i64) -> DismissReply {
    match db.execute(
        "UPDATE execution_failures SET dismissed_at=?3
         WHERE task_id=?1 AND id=?2 AND resolved_at IS NULL AND dismissed_at IS NULL",
        params![task_id, id, at],
    ) {
        Ok(changes) => DismissReply::Saved {
            dismissed: changes > 0,
        },
        Err(error) => DismissReply::Rejected {
            message: error.to_string(),
        },
    }
}
