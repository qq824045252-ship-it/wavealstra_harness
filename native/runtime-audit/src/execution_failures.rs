use crate::Result;
use duckdb::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFailureRow {
    record_json: String,
    resolved_at: Option<i64>,
    dismissed_at: Option<i64>,
}

pub fn list(db: &Connection, task_id: &str) -> Result<Vec<ExecutionFailureRow>> {
    let mut query = db.prepare(
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
    Ok(rows.collect::<duckdb::Result<_>>()?)
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

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WriteRequest {
    Record {
        id: String,
        task_id: String,
        cause_code: String,
        record_json: String,
        created_at: i64,
    },
    RecordIfAbsent {
        id: String,
        task_id: String,
        cause_code: String,
        target: Option<String>,
        recovery: String,
        phase: String,
        record_json: String,
        created_at: i64,
    },
    ResolveWorkspaceFailures {
        task_id: String,
        at: i64,
    },
    ResolveMatching {
        task_id: String,
        target: Option<String>,
        cause_codes: Option<Vec<String>>,
        side_effects: Option<String>,
        at: i64,
    },
}

fn insert_and_prune(
    tx: &duckdb::Transaction<'_>,
    id: &str,
    task_id: &str,
    cause_code: &str,
    record_json: &str,
    created_at: i64,
) -> duckdb::Result<()> {
    tx.execute(
        "INSERT INTO execution_failures(id,task_id,cause_code,record_json,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, task_id, cause_code, record_json, created_at],
    )?;
    tx.execute(
        "DELETE FROM execution_failures WHERE task_id = ?1 AND id NOT IN (
           SELECT id FROM execution_failures WHERE task_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 100
         )",
        [task_id],
    )?;
    Ok(())
}

pub fn write(db: &mut Connection, request: WriteRequest) -> Result<Value> {
    let tx = db.transaction()?;
    let out = match request {
        WriteRequest::Record {
            id,
            task_id,
            cause_code,
            record_json,
            created_at,
        } => {
            insert_and_prune(&tx, &id, &task_id, &cause_code, &record_json, created_at)?;
            json!({ "inserted": true, "recordJson": record_json })
        }
        WriteRequest::RecordIfAbsent {
            id,
            task_id,
            cause_code,
            target,
            recovery,
            phase,
            record_json,
            created_at,
        } => {
            let mut stmt = tx.prepare(
                "SELECT record_json, resolved_at, dismissed_at FROM execution_failures
                 WHERE task_id=?1 AND dismissed_at IS NULL
                 ORDER BY created_at DESC, rowid DESC LIMIT 100",
            )?;
            let rows = stmt
                .query_map([&task_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            drop(stmt);
            let mut existing = None;
            for (raw, resolved_at, _dismissed_at) in rows {
                if resolved_at.is_some() {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if parsed["taskId"].as_str() != Some(task_id.as_str()) {
                    continue;
                }
                if parsed["causeCode"].as_str() == Some(cause_code.as_str())
                    && parsed["target"].as_str().map(str::to_owned) == target
                    && parsed["recovery"].as_str() == Some(recovery.as_str())
                    && parsed["phase"].as_str() == Some(phase.as_str())
                {
                    existing = Some(raw);
                    break;
                }
            }
            if let Some(existing_json) = existing {
                json!({ "inserted": false, "recordJson": existing_json })
            } else {
                insert_and_prune(&tx, &id, &task_id, &cause_code, &record_json, created_at)?;
                json!({ "inserted": true, "recordJson": record_json })
            }
        }
        WriteRequest::ResolveWorkspaceFailures { task_id, at } => {
            let changes = tx.execute(
                "UPDATE execution_failures SET resolved_at = ?1
                 WHERE task_id = ?2 AND resolved_at IS NULL
                   AND cause_code IN ('workspace-path-missing','workspace-path-invalid','workspace-binding-missing','workspace-binding-cycle')",
                params![at, task_id],
            )?;
            json!({ "changes": changes })
        }
        WriteRequest::ResolveMatching {
            task_id,
            target,
            cause_codes,
            side_effects,
            at,
        } => {
            let mut stmt = tx.prepare(
                "SELECT id, cause_code, record_json FROM execution_failures
                 WHERE task_id = ?1 AND resolved_at IS NULL ORDER BY created_at DESC, rowid DESC",
            )?;
            let rows = stmt
                .query_map([&task_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            drop(stmt);
            let mut ids = Vec::new();
            for (row_id, cause_code, raw) in rows {
                if let Some(codes) = &cause_codes
                    && !codes.is_empty()
                    && !codes.iter().any(|c| c == &cause_code)
                {
                    continue;
                }
                if target.is_some() || side_effects.is_some() {
                    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                        continue;
                    };
                    if let Some(expected_target) = &target
                        && parsed["target"].as_str() != Some(expected_target.as_str())
                    {
                        continue;
                    }
                    if let Some(expected_side) = &side_effects
                        && parsed["sideEffects"].as_str() != Some(expected_side.as_str())
                    {
                        continue;
                    }
                }
                ids.push(row_id);
            }
            let mut count = 0usize;
            if !ids.is_empty() {
                let mut update = tx.prepare(
                    "UPDATE execution_failures SET resolved_at = ?1 WHERE id = ?2 AND task_id = ?3 AND resolved_at IS NULL",
                )?;
                for row_id in ids {
                    count += update.execute(params![at, row_id, task_id])?;
                }
            }
            json!({ "changes": count })
        }
    };
    tx.commit()?;
    Ok(out)
}

