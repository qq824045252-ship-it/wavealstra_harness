use rusqlite::{
    Connection, Error, ErrorCode, OptionalExtension, TransactionBehavior, params, types::ValueRef,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Snapshot {
        task_id: String,
        status: String,
        activity_at: Option<f64>,
        workspaces: Vec<MessageWorkspace>,
    },
    RememberWorkspaces {
        task_id: String,
        workspaces: Vec<MessageWorkspace>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWorkspace {
    message_id: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Applied {
        #[serde(skip_serializing_if = "Option::is_none")]
        activity_at: Option<f64>,
        workspaces: Vec<MessageWorkspace>,
    },
    NeedsHost,
    Rejected {
        message: String,
    },
}

pub fn write(db: &mut Connection, request: &Request) -> Reply {
    match apply(db, request) {
        Ok((activity_at, workspaces)) => Reply::Applied {
            activity_at,
            workspaces,
        },
        Err(Error::SqliteFailure(error, _))
            if matches!(
                error.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            ) =>
        {
            Reply::NeedsHost
        }
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(
    db: &mut Connection,
    request: &Request,
) -> rusqlite::Result<(Option<f64>, Vec<MessageWorkspace>)> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = match request {
        Request::Snapshot {
            task_id,
            status,
            activity_at,
            workspaces,
        } => {
            let candidate = activity_at.filter(|value| value.is_finite() && *value > 0.0);
            // Ordering guard: a projection that arrives late with an older activity time must
            // not move the status backwards (disconnects and retries deliver out of order).
            tx.prepare_cached(
                "UPDATE tasks SET status = ?2 WHERE id = ?1 AND status IS NOT ?2
                   AND (?3 IS NULL OR ?3 >= updated_at)",
            )?
            .execute(params![task_id, status, candidate])?;
            let advanced = match candidate {
                Some(value) => {
                    tx.prepare_cached(
                        "UPDATE tasks SET updated_at = ?2 WHERE id = ?1 AND updated_at < ?2",
                    )?
                    .execute(params![task_id, value])?
                        > 0
                }
                None => false,
            };
            let activity_at = if advanced {
                candidate
            } else {
                tx.prepare_cached("SELECT updated_at FROM tasks WHERE id = ?1")?
                    .query_row([task_id], |row| {
                        Ok(match row.get_ref(0)? {
                            ValueRef::Integer(value) => Some(value as f64),
                            ValueRef::Real(value) => Some(value),
                            _ => None,
                        })
                    })
                    .optional()?
                    .flatten()
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .or(candidate)
            };
            remember_workspaces(&tx, task_id, workspaces)?;
            (activity_at, read_workspaces(&tx, task_id, workspaces)?)
        }
        Request::RememberWorkspaces {
            task_id,
            workspaces,
        } => {
            remember_workspaces(&tx, task_id, workspaces)?;
            (None, Vec::new())
        }
    };
    tx.commit()?;
    Ok(result)
}

fn read_workspaces(
    db: &Connection,
    task_id: &str,
    requested: &[MessageWorkspace],
) -> rusqlite::Result<Vec<MessageWorkspace>> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let mut lookup = db.prepare_cached(
        "SELECT cwd FROM durable_bot_message_workspaces WHERE task_id = ?1 AND message_id = ?2",
    )?;
    let mut workspaces = Vec::with_capacity(requested.len());
    for entry in requested {
        let cwd = lookup
            .query_row(params![task_id, entry.message_id], |row| row.get(0))
            .optional()?;
        if let Some(cwd) = cwd {
            workspaces.push(MessageWorkspace {
                message_id: entry.message_id.clone(),
                cwd,
            });
        }
    }
    Ok(workspaces)
}

fn remember_workspaces(
    db: &Connection,
    task_id: &str,
    workspaces: &[MessageWorkspace],
) -> rusqlite::Result<()> {
    if !workspaces.is_empty() {
        let mut insert = db.prepare_cached(
            "INSERT OR IGNORE INTO durable_bot_message_workspaces (task_id, message_id, cwd)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?1)",
        )?;
        for workspace in workspaces {
            insert.execute(params![task_id, workspace.message_id, workspace.cwd])?;
        }
    }
    Ok(())
}
