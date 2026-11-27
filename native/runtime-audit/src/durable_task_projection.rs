use crate::database::{DbError, classify_duckdb_error};
use duckdb::{Connection, OptionalExt, params, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    WorkspaceState { task_id: String },
    ActiveBindingPaths { excluding: String },
    Binding { task_id: String },
    ResumePage { after: Option<String> },
    OpenState { task_id: String },
    WorkspaceAuthority { task_id: String },
    TaskWriteGrants { task_id: String },
    ExecutionAttempt {
        id: String,
        task_id: String,
        execution_id: String,
        assistant_message_id: String,
        tool_call_id: String,
    },
    WorkMetrics { task_id: String, include_facts: bool },
}

pub fn read(db: &Connection, query: Query) -> crate::Result<Value> {
    match query {
        Query::WorkspaceState { task_id } => Ok(db.query_row(
            "SELECT directory_name,state,created_at,updated_at,trashed_at,purge_after,trash_path
             FROM task_execution_workspace_state WHERE task_id=?1", [&task_id], |row| Ok(json!({
                "taskId": task_id, "directoryName": row.get::<_,String>(0)?, "state": row.get::<_,String>(1)?,
                "createdAt": row.get::<_,i64>(2)?, "updatedAt": row.get::<_,i64>(3)?,
                "trashedAt": row.get::<_,Option<i64>>(4)?, "purgeAfter": row.get::<_,Option<i64>>(5)?,
                "trashPath": row.get::<_,Option<String>>(6)?,
             })),
        ).optional()?.unwrap_or(Value::Null)),
        Query::ActiveBindingPaths { excluding } => {
            let mut statement = db.prepare("SELECT DISTINCT b.cwd FROM durable_bot_bindings b
                JOIN tasks t ON t.id=b.task_id LEFT JOIN task_execution_workspace_state s ON s.task_id=t.id
                WHERE b.task_id<>? AND coalesce(s.state,'active')<>'trashed'")?;
            Ok(json!(statement.query_map([excluding], |row| row.get::<_,String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()?))
        }
        Query::Binding { task_id } => Ok(db.query_row(
            "SELECT b.directory,b.cwd,
                EXISTS(SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=b.task_id AND s.state='trashed')
             FROM durable_bot_bindings b JOIN tasks t ON t.id=b.task_id WHERE b.task_id=?1",
            [task_id], |row| Ok(json!({
                "directory": row.get::<_, String>(0)?, "cwd": row.get::<_, String>(1)?,
                "trashed": row.get::<_, bool>(2)?,
            })),
        ).optional()?.unwrap_or(Value::Null)),
        Query::ResumePage { after } => {
            const PAGE_SIZE: usize = 256;
            let mut statement = db.prepare(
                "SELECT b.task_id FROM durable_bot_bindings b JOIN tasks t ON t.id=b.task_id
                 WHERE (?1 IS NULL OR b.task_id>?1) ORDER BY b.task_id LIMIT ?2",
            )?;
            let mut task_ids = statement.query_map(params![after, PAGE_SIZE + 1], |row| row.get::<_, String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()?;
            let next = if task_ids.len() > PAGE_SIZE {
                task_ids.truncate(PAGE_SIZE);
                task_ids.last().cloned()
            } else {
                None
            };
            Ok(json!({ "taskIds": task_ids, "next": next }))
        }
        Query::OpenState { task_id } => open_state(db, &task_id),
        Query::WorkspaceAuthority { task_id } => crate::task_workspace_authority::read(db, &task_id),
        Query::TaskWriteGrants { task_id } => Ok(serde_json::to_value(crate::sqlite_rows::records(
            db,
            r#"SELECT g.task_id AS "taskId", g.path, g.created_at AS "createdAt"
               FROM task_write_grants g JOIN tasks t ON t.id=g.task_id
               WHERE g.task_id=? ORDER BY g.created_at DESC, g.path"#,
            [task_id],
        )?)?),
        Query::ExecutionAttempt { id, task_id, execution_id, assistant_message_id, tool_call_id } => {
            let record: Option<String> = db.query_row(
                "SELECT record_json FROM execution_attempts WHERE id=?1 AND task_id=?2
                 AND execution_id=?3 AND assistant_message_id=?4 AND tool_call_id=?5",
                params![id, task_id, execution_id, assistant_message_id, tool_call_id],
                |row| row.get(0),
            ).optional()?;
            record.map_or(Ok(Value::Null), |raw| Ok(serde_json::from_str(&raw)?))
        }
        Query::WorkMetrics { task_id, include_facts } => work_metrics(db, &task_id, include_facts),
    }
}

fn open_state(db: &Connection, task_id: &str) -> crate::Result<Value> {
    let state = db.query_row(
        "SELECT b.directory,b.cwd,m.from_cwd,m.to_cwd,p.entry_id,
            EXISTS(SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed')
         FROM tasks t LEFT JOIN durable_bot_bindings b ON b.task_id=t.id
         LEFT JOIN durable_bot_workspace_moves m ON m.task_id=t.id
         LEFT JOIN durable_bot_memory_projection p ON p.task_id=t.id
         WHERE t.id=?1",
        [task_id],
        |row| {
            let directory: Option<String> = row.get(0)?;
            let cwd: Option<String> = row.get(1)?;
            let from_cwd: Option<String> = row.get(2)?;
            let to_cwd: Option<String> = row.get(3)?;
            Ok(json!({
                "binding": directory.zip(cwd).map(|(directory,cwd)| json!({"directory":directory,"cwd":cwd})),
                "workspaceMove": from_cwd.zip(to_cwd).map(|(from,to)| json!({"fromCwd":from,"toCwd":to})),
                "memoryProjectionEntryId": row.get::<_, Option<i64>>(4)?,
                "trashed": row.get::<_, bool>(5)?,
            }))
        },
    ).optional()?;
    Ok(state.unwrap_or(Value::Null))
}

fn work_metrics(db: &Connection, task_id: &str, include_facts: bool) -> crate::Result<Value> {
    let owner = db.query_row(
        "SELECT binding_id,conversation_id,started_at,value_json FROM work_execution_metrics WHERE task_id=?1",
        [task_id],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, i64>(2)?,row.get::<_, Option<String>>(3)?)),
    ).optional()?;
    let Some((binding_id,conversation_id,started_at,value_json)) = owner else { return Ok(Value::Null); };
    let mut usage = Vec::new();
    let mut timings = Vec::new();
    let mut bytes = 4096 + value_json.as_ref().map_or(0, String::len);
    if include_facts {
        for (sql, facts) in [
            ("SELECT call_key,value_json FROM work_execution_usage WHERE binding_id=? ORDER BY call_key", &mut usage),
            ("SELECT message_id,value_json FROM work_execution_timings WHERE binding_id=? ORDER BY message_id", &mut timings),
        ] {
            let mut stmt = db.prepare(sql)?;
            let mut cursor = stmt.query([&binding_id])?;
            while let Some(row) = cursor.next()? {
                let key = row.get::<_, String>(0)?;
                let value = row.get::<_, String>(1)?;
                bytes += key.len() + value.len() + 128;
                if bytes >= crate::MAX_REPLY_BYTES / 2 {
                    return Err("Work execution metrics exceed the IPC response limit".into());
                }
                facts.push(json!({"key":key,"valueJson":value}));
            }
        }
    }
    Ok(json!({"bindingId":binding_id,"conversationId":conversation_id,"startedAt":started_at,
        "valueJson":value_json,"usage":usage,"timings":timings}))
}

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
    BindWorkspaceCwd {
        task_id: String,
        expected_version: String,
        cwd: String,
        at: i64,
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

impl Request {
    pub fn task_id(&self) -> &str {
        match self {
            Self::Snapshot { task_id, .. }
            | Self::RememberWorkspaces { task_id, .. }
            | Self::BindBot { task_id, .. }
            | Self::BindWorkspaceCwd { task_id, .. }
            | Self::CommitBranch { task_id, .. }
            | Self::RebindGatewayDirectory { task_id, .. }
            | Self::QueueWorkspaceMove { task_id, .. } => task_id,
        }
    }

    pub fn directories(&self) -> [Option<&str>; 2] {
        match self {
            Self::BindBot { directory, .. } | Self::CommitBranch { directory, .. } => {
                [Some(directory), None]
            }
            Self::RebindGatewayDirectory {
                previous_directory,
                next_directory,
                ..
            } => [Some(previous_directory), Some(next_directory)],
            _ => [None, None],
        }
    }
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
    WorkspaceBound { version: String },
    NeedsHost,
    Rejected {
        message: String,
    },
}

pub fn write(db: &mut Connection, request: &Request) -> Reply {
    if let Request::BindWorkspaceCwd { task_id, expected_version, cwd, at } = request {
        return match crate::task_workspace_authority::bind(db, task_id, expected_version, cwd, *at) {
            Ok(version) => Reply::WorkspaceBound { version },
            Err(error) => Reply::Rejected { message: error.to_string() },
        };
    }
    match apply(db, request) {
        Ok((activity_at, workspaces)) => Reply::Applied {
            activity_at,
            workspaces,
        },
        Err(error) if matches!(classify_duckdb_error(&error.to_string()), DbError::Busy(_)) => {
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
) -> crate::Result<(Option<f64>, Vec<MessageWorkspace>)> {
    let tx = db.transaction()?;
    if matches!(
        request,
        Request::BindBot { .. } | Request::CommitBranch { .. } | Request::QueueWorkspaceMove { .. }
    ) {
        let available: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)
             AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state WHERE task_id=?1 AND state='trashed')",
            [request.task_id()], |row| row.get(0),
        )?;
        if !available {
            return Err("任务已删除或在回收站中".into());
        }
    }
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
            let changed = tx
                .prepare(
                    "UPDATE tasks SET status = ?2 WHERE id = ?1 AND status IS DISTINCT FROM ?2
                   AND (?3 IS NULL OR ?3 >= updated_at)",
                )?
                .execute(params![task_id, status, candidate])?
                > 0;
            let advanced = match candidate {
                Some(value) => {
                    tx.prepare(
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
                tx.prepare("SELECT updated_at FROM tasks WHERE id = ?1")?
                    .query_row([task_id], |row| {
                        Ok(match row.get_ref(0)? {
                            ValueRef::BigInt(value) => Some(value as f64),
                            ValueRef::Int(value) => Some(value as f64),
                            ValueRef::Double(value) => Some(value),
                            ValueRef::Float(value) => Some(value as f64),
                            _ => None,
                        })
                    })
                    .optional()?
                    .flatten()
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .or(candidate)
            };
            if changed && matches!(status.as_str(), "completed" | "failed") {
                let terminal_at = candidate
                    .map(|at| at.round() as i64)
                    .unwrap_or_else(|| crate::core_lease::now_ms() as i64);
                crate::trigger_effects::on_task_ended_in_tx(&tx, task_id, terminal_at)?;
            }
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
            let changed = tx
                .prepare(
                    "INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd)
                 VALUES (?1, 'pi-durable', ?2, ?3)
                 ON CONFLICT(task_id) DO UPDATE SET
                   cwd = CASE WHEN ?4 THEN excluded.cwd ELSE durable_bot_bindings.cwd END
                 WHERE durable_bot_bindings.directory=excluded.directory",
                )?
                .execute(params![
                    task_id,
                    directory,
                    cwd,
                    i64::from(*update_cwd_if_exists)
                ])?;
            if changed == 0 {
                return Err("Durable 会话已经绑定到另一个目录".into());
            }
            (None, Vec::new())
        }
        Request::BindWorkspaceCwd { .. } => unreachable!("workspace binding uses guarded transaction"),
        Request::CommitBranch {
            task_id,
            directory,
            cwd,
            inherited_last_entry_id,
        } => {
            tx.prepare(
                "INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd)
                 VALUES (?1, 'pi-durable', ?2, ?3)",
            )?
            .execute(params![task_id, directory, cwd])?;
            tx.prepare(
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
            tx.prepare(
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
            tx.prepare(
                "INSERT INTO durable_bot_workspace_moves(task_id, from_cwd, to_cwd) VALUES (?1, ?2, ?3)
                 ON CONFLICT (task_id) DO UPDATE SET from_cwd = excluded.from_cwd, to_cwd = excluded.to_cwd",
            )?
            .execute(params![task_id, from_cwd, to_cwd])?;
            (None, Vec::new())
        }
    };
    crate::request_control::commit(tx)?;
    Ok(result)
}

fn read_workspaces(
    db: &Connection,
    task_id: &str,
    requested: &[MessageWorkspace],
) -> duckdb::Result<Vec<MessageWorkspace>> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let mut lookup = db.prepare(
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
) -> duckdb::Result<()> {
    if !workspaces.is_empty() {
        let mut insert = db.prepare(
            "INSERT INTO durable_bot_message_workspaces (task_id, message_id, cwd)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?1)
             ON CONFLICT DO NOTHING",
        )?;
        for workspace in workspaces {
            insert.execute(params![task_id, workspace.message_id, workspace.cwd])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod read_tests {
    use super::*;

    #[test]
    fn resume_pages_follow_the_task_key_and_skip_orphaned_bindings() -> crate::Result<()> {
        let db = Connection::open_in_memory()?;
        db.execute_batch(
            "CREATE TABLE tasks(id VARCHAR PRIMARY KEY);
             CREATE TABLE durable_bot_bindings(task_id VARCHAR PRIMARY KEY,directory VARCHAR,cwd VARCHAR);
             CREATE TABLE task_execution_workspace_state(task_id VARCHAR PRIMARY KEY,state VARCHAR);
             INSERT INTO tasks SELECT 'task-' || lpad(i::VARCHAR, 3, '0') FROM range(514) AS r(i);
             INSERT INTO durable_bot_bindings SELECT id,id || '/store',id || '/cwd' FROM tasks;
             INSERT INTO durable_bot_bindings VALUES ('orphan','orphan/store','orphan/cwd');
             INSERT INTO task_execution_workspace_state VALUES ('task-257','trashed');",
        )?;
        let mut actual = Vec::new();
        let mut after = None;
        loop {
            let page = read(&db, Query::ResumePage { after })?;
            actual.extend(
                page["taskIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_owned()),
            );
            after = page["next"].as_str().map(str::to_owned);
            if after.is_none() {
                break;
            }
        }
        let expected: Vec<_> = (0..514).map(|id| format!("task-{id:03}")).collect();
        assert_eq!(actual, expected);
        assert_eq!(
            read(
                &db,
                Query::Binding {
                    task_id: "task-257".into()
                }
            )?,
            json!({"directory":"task-257/store","cwd":"task-257/cwd","trashed":true}),
        );
        assert_eq!(
            read(
                &db,
                Query::Binding {
                    task_id: "orphan".into()
                }
            )?,
            Value::Null
        );
        Ok(())
    }
}
