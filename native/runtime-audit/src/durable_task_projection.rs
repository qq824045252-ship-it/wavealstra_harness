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
    BindBot {
        task_id: String,
        directory: String,
        cwd: String,
        #[serde(default)]
        update_cwd_if_exists: bool,
    },
    CommitBranch {
        task_id: String,
        directory: String,
        cwd: String,
        inherited_last_entry_id: i64,
    },
    RebindGatewayDirectory {
        task_id: String,
        previous_directory: String,
        next_directory: String,
    },
    QueueWorkspaceMove {
        task_id: String,
        from_cwd: String,
        to_cwd: String,
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
        Request::BindBot {
            task_id,
            directory,
            cwd,
            update_cwd_if_exists,
        } => {
            tx.prepare_cached(
                "INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd)
                 VALUES (?1, 'pi-durable', ?2, ?3)
                 ON CONFLICT(task_id) DO UPDATE SET
                   cwd = CASE WHEN ?4 THEN excluded.cwd ELSE durable_bot_bindings.cwd END",
            )?
            .execute(params![task_id, directory, cwd, i64::from(*update_cwd_if_exists)])?;
            (None, Vec::new())
        }
        Request::CommitBranch {
            task_id,
            directory,
            cwd,
            inherited_last_entry_id,
        } => {
            tx.prepare_cached(
                "INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd)
                 VALUES (?1, 'pi-durable', ?2, ?3)",
            )?
            .execute(params![task_id, directory, cwd])?;
            tx.prepare_cached(
                "INSERT INTO durable_bot_memory_projection(task_id, entry_id) VALUES (?1, ?2)",
            )?
            .execute(params![task_id, inherited_last_entry_id])?;
            (None, Vec::new())
        }
        Request::RebindGatewayDirectory {
            task_id,
            previous_directory,
            next_directory,
        } => {
            tx.prepare_cached(
                "UPDATE durable_bot_bindings SET directory = ?1 WHERE task_id = ?2 AND directory = ?3",
            )?
            .execute(params![next_directory, task_id, previous_directory])?;
            (None, Vec::new())
        }
        Request::QueueWorkspaceMove {
            task_id,
            from_cwd,
            to_cwd,
        } => {
            tx.prepare_cached(
                "INSERT OR REPLACE INTO durable_bot_workspace_moves(task_id, from_cwd, to_cwd) VALUES (?1, ?2, ?3)",
            )?
            .execute(params![task_id, from_cwd, to_cwd])?;
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
