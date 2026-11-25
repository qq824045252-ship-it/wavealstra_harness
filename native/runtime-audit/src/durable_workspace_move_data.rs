use crate::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    task_id: String,
    from_cwd: String,
    to_cwd: String,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Action {
    Stage,
    Cancel,
    Commit { cwd: String, at: i64 },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Applied,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, request: &Request) -> Reply {
    match apply(db, request) {
        Ok(()) => Reply::Applied,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

const CONFLICT: &str = "任务工作目录搬迁记录已变化";
const PROTECTED: &str = "任务已删除或在回收站中";

fn apply(db: &mut Connection, request: &Request) -> Result<()> {
    let Request {
        task_id,
        from_cwd,
        to_cwd,
        action,
    } = request;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = tx
        .prepare_cached(
            "SELECT t.cwd, b.cwd, m.from_cwd, m.to_cwd
             FROM tasks t
             LEFT JOIN durable_bot_bindings b ON b.task_id = t.id
             LEFT JOIN durable_bot_workspace_moves m ON m.task_id = t.id
             WHERE t.id = ?1 AND NOT EXISTS (
                SELECT 1 FROM task_execution_workspace_state w
                WHERE w.task_id = t.id AND w.state = 'trashed'
             )",
        )?
        .query_row([task_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .optional()?
        .ok_or(PROTECTED)?;
    let (task_cwd, bound_cwd, pending_from, pending_to) = state;
    let bound = bound_cwd.as_deref();
    let pending = pending_from.as_deref().zip(pending_to.as_deref());
    let expected = (from_cwd.as_str(), to_cwd.as_str());
    if pending.is_some_and(|current| current != expected) {
        return Err(CONFLICT.into());
    }

    match action {
        Action::Stage if bound == Some(from_cwd) => {
            if pending.is_none() {
                tx.prepare_cached(
                    "INSERT INTO durable_bot_workspace_moves(task_id,from_cwd,to_cwd)
                     VALUES (?1,?2,?3)",
                )?
                .execute(params![task_id, from_cwd, to_cwd])?;
            }
        }
        Action::Cancel if bound == Some(from_cwd) => {
            delete_intent(&tx, request)?;
        }
        Action::Commit { cwd, at }
            if pending.is_some() && (bound == Some(from_cwd) || bound == Some(cwd)) =>
        {
            tx.prepare_cached("UPDATE durable_bot_bindings SET cwd = ?2 WHERE task_id = ?1")?
                .execute(params![task_id, cwd])?;
            tx.prepare_cached(
                "UPDATE tasks SET cwd = ?2, updated_at = max(updated_at, ?3) WHERE id = ?1",
            )?
            .execute(params![task_id, cwd, at])?;
            delete_intent(&tx, request)?;
        }
        Action::Commit { cwd, .. }
            if pending.is_none() && bound == Some(cwd) && task_cwd.as_deref() == Some(cwd) => {}
        _ => return Err(CONFLICT.into()),
    }
    tx.commit()?;
    Ok(())
}

fn delete_intent(db: &Connection, request: &Request) -> rusqlite::Result<()> {
    db.prepare_cached(
        "DELETE FROM durable_bot_workspace_moves WHERE task_id = ?1 AND from_cwd = ?2 AND to_cwd = ?3",
    )?
    .execute(params![request.task_id, request.from_cwd, request.to_cwd])?;
    Ok(())
}
