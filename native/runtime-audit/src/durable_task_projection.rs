use crate::database::{DbError, classify_duckdb_error};
use duckdb::{Connection, OptionalExt, params, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// A streaming turn projects far more revisions than anyone reads: each one only moves
/// `updated_at` while the status stays put, so every delta used to cost a write transaction.
/// Collapsing repeats of the same running status to one touch per window keeps a token stream
/// from turning into a write per token. Terminal and waiting statuses are never collapsed, so a
/// finished turn cannot look like it is still running.
const SNAPSHOT_TOUCH_WINDOW_MS: i64 = 2_000;
const SNAPSHOT_TOUCH_LIMIT: usize = 2_048;

struct SnapshotTouch {
    status: String,
    written_at_ms: i64,
}

fn snapshot_touches() -> &'static Mutex<HashMap<String, SnapshotTouch>> {
    static TOUCHES: OnceLock<Mutex<HashMap<String, SnapshotTouch>>> = OnceLock::new();
    TOUCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn snapshot_touch_is_collapsible(status: &str) -> bool {
    !matches!(status, "completed" | "failed" | "stopped" | "pending")
}

/// Answers a projection that would not change anything a reader can observe, so it never opens
/// a transaction. `None` means the projection still needs the write path.
fn collapsible_snapshot_reply(
    db: &Connection,
    task_id: &str,
    status: &str,
    candidate: Option<f64>,
    workspaces: &[MessageWorkspace],
) -> crate::Result<Option<Reply>> {
    if !workspaces.is_empty() || !snapshot_touch_is_collapsible(status) {
        return Ok(None);
    }
    let stored: Option<(Option<String>, Option<f64>)> = db
        .prepare("SELECT status, CAST(updated_at AS DOUBLE) FROM tasks WHERE id = ?1")?
        .query_row([task_id], |row| Ok((row.get(0)?, row.get(1).ok())))
        .optional()?;
    let Some((stored_status, stored_activity)) = stored else {
        return Ok(None);
    };
    // A task the user never gave a status still has a NULL column, and a probe that cannot read
    // it must fall through to the write path instead of failing the projection.
    if stored_status.as_deref() != Some(status) {
        return Ok(None);
    }
    // The ordering guard only moves `updated_at` forward, so a projection that is not strictly
    // newer than the stored time cannot change either column.
    let advances = matches!((candidate, stored_activity), (Some(at), Some(stored)) if at > stored);
    if !advances {
        return Ok(Some(Reply::Applied {
            activity_at: stored_activity,
            workspaces: Vec::new(),
        }));
    }
    let now = crate::core_lease::now_ms() as i64;
    let recent = snapshot_touches()
        .lock()
        .map(|touches| {
            touches.get(task_id).is_some_and(|touch| {
                touch.status == status && now - touch.written_at_ms < SNAPSHOT_TOUCH_WINDOW_MS
            })
        })
        .unwrap_or(false);
    Ok(recent.then(|| Reply::Applied {
        activity_at: stored_activity.or(candidate),
        workspaces: Vec::new(),
    }))
}

fn remember_snapshot_touch(task_id: &str, status: &str) {
    let Ok(mut touches) = snapshot_touches().lock() else {
        return;
    };
    if touches.len() >= SNAPSHOT_TOUCH_LIMIT && !touches.contains_key(task_id) {
        touches.clear();
    }
    touches.insert(
        task_id.to_string(),
        SnapshotTouch {
            status: status.to_string(),
            written_at_ms: crate::core_lease::now_ms() as i64,
        },
    );
}

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
    TaskContextUsage { task_id: String },
    RuntimeBotForTask { task_id: String, user_id: String },
    WorkspaceMove { task_id: String },
    TaskContinuation { task_id: String },
    BotTaskWorkspace { task_id: String },
    BotExecutionSettings {
        bot_id: String,
        message_id: Option<String>,
    },
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
        Query::TaskContextUsage { task_id } => task_context_usage(db, &task_id),
        Query::RuntimeBotForTask { task_id, user_id } => runtime_bot_for_task(db, &task_id, &user_id),
        Query::WorkspaceMove { task_id } => workspace_move(db, &task_id),
        Query::TaskContinuation { task_id } => task_continuation(db, &task_id),
        Query::BotTaskWorkspace { task_id } => bot_task_workspace(db, &task_id),
        Query::BotExecutionSettings { bot_id, message_id } => {
            bot_execution_settings(db, &bot_id, message_id.as_deref())
        }
    }
}

fn task_context_usage(db: &Connection, task_id: &str) -> crate::Result<Value> {
    let row = db
        .query_row(
            "SELECT context_used_tokens, context_window_tokens, context_cache_hit_rate
             FROM tasks WHERE id = ?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, Option<f64>>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((used_tokens, Some(context_window), cache_hit_rate)) => json!({
            "usedTokens": used_tokens,
            "contextWindow": context_window,
            "cacheHitRate": cache_hit_rate,
        }),
        _ => Value::Null,
    })
}

fn runtime_bot_for_task(db: &Connection, task_id: &str, user_id: &str) -> crate::Result<Value> {
    let has_binding: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_execution_bindings WHERE task_id = ?1)",
        [task_id],
        |row| row.get(0),
    )?;
    let bot_id: Option<String> = db
        .query_row(
            "SELECT b.bot_id
             FROM work_execution_bindings b
             JOIN works w ON w.work_id = b.work_id
             LEFT JOIN work_team_ownership o ON o.work_id = b.work_id
             WHERE b.task_id = ?1 AND w.user_id = ?2
               AND o.work_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM work_teams wt WHERE wt.work_id = b.work_id)
             ORDER BY b.admitted_at DESC, b.binding_id DESC
             LIMIT 1",
            params![task_id, user_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json!({ "hasBinding": has_binding, "botId": bot_id }))
}

fn workspace_move(db: &Connection, task_id: &str) -> crate::Result<Value> {
    let row = db
        .query_row(
            "SELECT from_cwd, to_cwd FROM durable_bot_workspace_moves WHERE task_id = ?1",
            [task_id],
            |row| Ok(json!({ "fromCwd": row.get::<_, String>(0)?, "toCwd": row.get::<_, String>(1)? })),
        )
        .optional()?;
    Ok(row.unwrap_or(Value::Null))
}

fn task_continuation(db: &Connection, task_id: &str) -> crate::Result<Value> {
    let row = db
        .query_row(
            "SELECT work_id, continuation_plan_id, intent_revision, input_snapshot_id, state
             FROM work_dispatch_requests WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok(json!({
                    "workId": row.get::<_, String>(0)?,
                    "continuationPlanId": row.get::<_, Option<String>>(1)?,
                    "intentRevision": row.get::<_, i64>(2)?,
                    "inputSnapshotId": row.get::<_, String>(3)?,
                    "state": row.get::<_, String>(4)?,
                }))
            },
        )
        .optional()?;
    Ok(row.unwrap_or(Value::Null))
}

fn bot_task_workspace(db: &Connection, task_id: &str) -> crate::Result<Value> {
    let settings_json: Option<String> = db
        .query_row(
            "SELECT s.settings_json FROM bot_work_settings s
             JOIN work_dispatch_requests d ON d.work_id = s.work_id WHERE d.task_id = ?1
             UNION ALL
             SELECT s.settings_json FROM bot_work_settings s
             JOIN work_team_executions t ON t.work_id = s.work_id WHERE t.task_id = ?1
             LIMIT 1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(settings_json.map_or(Value::Null, Value::String))
}

fn bot_execution_settings(
    db: &Connection,
    bot_id: &str,
    message_id: Option<&str>,
) -> crate::Result<Value> {
    let settings_json: Option<String> = db
        .query_row(
            "SELECT settings_json FROM bot_execution_settings WHERE bot_id = ?1",
            [bot_id],
            |row| row.get(0),
        )
        .optional()?;
    let msg = match message_id {
        Some(mid) => db
            .query_row(
                "SELECT settings_json, profile_json
                 FROM bot_message_execution_settings WHERE message_id = ?1 AND bot_id = ?2",
                params![mid, bot_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?,
        None => None,
    };
    Ok(json!({
        "settingsJson": settings_json,
        "messageSettingsJson": msg.as_ref().map(|(s, _)| s),
        "messageProfileJson": msg.as_ref().map(|(_, p)| p),
    }))
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
    if let Request::Snapshot {
        task_id,
        status,
        activity_at,
        workspaces,
    } = request
    {
        let candidate = activity_at.filter(|value| value.is_finite() && *value > 0.0);
        match collapsible_snapshot_reply(db, task_id, status, candidate, workspaces) {
            Ok(Some(reply)) => return reply,
            Ok(None) => {}
            Err(error) => {
                return Reply::Rejected {
                    message: error.to_string(),
                };
            }
        }
    }
    match apply(db, request) {
        Ok((activity_at, workspaces)) => {
            if let Request::Snapshot { task_id, status, .. } = request {
                remember_snapshot_touch(task_id, status);
            }
            Reply::Applied {
                activity_at,
                workspaces,
            }
        }
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

    #[test]
    fn new_core_read_queries_are_duckdb_compatible() -> crate::Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch(include_str!("duckdb_schema.sql"))?;

        // Seed minimal rows to exercise non-empty result paths as well as empty paths.
        // `tasks` has no `created_at` column (see duckdb_schema.sql); only `updated_at`.
        db.execute_batch(
            "INSERT INTO spaces(id, name, created_at, updated_at) VALUES ('sp-1', 'Workspace 1', 1, 1);
             INSERT INTO tasks(id, title, space_id, updated_at, context_used_tokens, context_window_tokens, context_cache_hit_rate)
             VALUES ('t-1', 'Task 1', 'sp-1', 2, 100, 8192, 0.5);",
        )?;

        // workspace_data
        let ws = crate::workspace_data::read(
            &mut db,
            crate::workspace_data::Query::SpaceDeleteStatus { space_id: "sp-1".into() },
        )?;
        let ws_val = serde_json::to_value(ws)?;
        assert_eq!(ws_val["deleteStatus"]["exists"], json!(true));
        assert_eq!(ws_val["deleteStatus"]["hasTasks"], json!(true));

        // durable_task_projection new queries
        assert_eq!(
            read(&db, Query::TaskContextUsage { task_id: "t-1".into() })?,
            json!({"usedTokens": 100.0, "contextWindow": 8192.0, "cacheHitRate": 0.5})
        );
        let rbot = read(&db, Query::RuntimeBotForTask { task_id: "t-1".into(), user_id: "local".into() })?;
        assert_eq!(rbot["hasBinding"], json!(false));
        assert!(read(&db, Query::WorkspaceMove { task_id: "t-1".into() })?.is_null());
        assert!(read(&db, Query::TaskContinuation { task_id: "t-1".into() })?.is_null());
        assert!(read(&db, Query::BotTaskWorkspace { task_id: "t-1".into() })?.is_null());
        let bsettings = read(&db, Query::BotExecutionSettings { bot_id: "b-1".into(), message_id: Some("m-1".into()) })?;
        assert!(bsettings["settingsJson"].is_null());

        // conversation_branch_data new queries
        let ui = Some(crate::business_protocol::ClientContext {
            epoch: 0,
            role: "ui".into(),
            client_id: "test".into(),
            generation: "test".into(),
        });
        assert!(crate::conversation_branch_data::read(
            &db,
            crate::conversation_branch_data::Query::ByRequestId { request_id: "req-1".into() },
            ui.as_ref(),
        )?["childTaskId"].is_null());
        assert!(crate::conversation_branch_data::read(
            &db,
            crate::conversation_branch_data::Query::SessionFiles,
            ui.as_ref(),
        )?["rows"].is_array());

        // cron_data
        assert!(crate::cron_data::read(&db, crate::cron_data::Query::Running)?.is_array());

        // external_agent_history_data
        assert!(crate::external_agent_history_data::read_query(
            &db,
            crate::external_agent_history_data::Query::Run { run_id: "r-1".into() },
        )?.is_null());
        assert!(crate::external_agent_history_data::read_query(
            &db,
            crate::external_agent_history_data::Query::Tools { run_id: "r-1".into() },
        )?.is_null());

        // bot_registry_data
        let exp = crate::bot_registry_data::read(
            &db,
            crate::bot_registry_data::Query::ExportMessage {
                user_id: "local".into(),
                bot_id: "b-1".into(),
                conversation_id: "c-1".into(),
                message_id: "m-1".into(),
            },
        )?;
        assert!(exp["bot"].is_null());

        // improvement_review
        let diag = crate::improvement_review::read(
            &mut db,
            crate::improvement_review::Query::SubagentDiagnostics { task: "t-1".into(), id: "1".into() },
        )?;
        assert_eq!(diag["data"]["requests"], json!(0));
        let src = crate::improvement_review::read(
            &mut db,
            crate::improvement_review::Query::SourceContext {
                task: "t-1".into(),
                conversation: "1".into(),
                generation: 1,
                actor: "main".into(),
                assistant_message_id: Some("m-1".into()),
                operation: Some("op-1".into()),
                goal_id: Some("g-1".into()),
                goal_revision: Some(1),
                evidence_refs_json: Some("[]".into()),
                input_snapshot_id: Some("s-1".into()),
            },
        )?;
        assert!(src["data"]["requests"].is_array());

        // memory_turn_data & memory_records_data
        assert!(crate::memory_turn_data::read(
            &db,
            crate::memory_turn_data::Query::UndistilledTurns,
            "local",
        )?["rows"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::DistinctProjectionScopes)?["scopes"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::Projects { include_archived: true })?["projects"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::CandidateById { id: "c-1".into() })?["candidate"].is_null());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::CaptureReceipt { source_key: "k-1".into() })?["receipt"].is_null());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::Revisions { memory_id: "m-1".into() })?["revisions"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::UserWorks { user_id: "local".into() })?["workIds"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::WorkCaptureFacts { work_id: "w-1".into(), user_id: "local".into() })?["work"].is_null());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::AssistantScopeContext {
            task_id: Some("t-1".into()),
            work_id: Some("w-1".into()),
            conversation_id: Some("c-1".into()),
            user_id: "local".into(),
        })?["hasGatewayDotsMemory"] == json!(false));
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::DotsDueProjection { now: 1000 })?["records"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::SkillEffectivenessQuery {
            query: crate::memory_records_data::SkillEffectivenessQueryKind::Summaries { limit: 10 },
        })?["rows"].is_array());
        assert!(crate::memory_records_data::read(&db, crate::memory_records_data::Query::SkillEffectivenessQuery {
            query: crate::memory_records_data::SkillEffectivenessQueryKind::RevisionRefreshFacts { skill_id: "sk-1".into(), candidate_id: None },
        })?["failedCount"] == json!(0));

        // library_metadata
        assert!(crate::library_metadata::read(&db, crate::library_metadata::Query::ProjectArchived { id: "p-1".into() })?.is_null());
        assert!(crate::library_metadata::read(&db, crate::library_metadata::Query::ArtifactScope { id: "a-1".into() })?.is_null());
        assert!(crate::library_metadata::read(&db, crate::library_metadata::Query::ArtifactById { id: "a-1".into() })?.is_null());
        assert!(crate::library_metadata::read(&db, crate::library_metadata::Query::ArtifactsList)?.is_array());

        // dots_delegation_data ActionData queries
        use crate::dots_delegation_data::ActionQuery;
        for aq in [
            ActionQuery::PendingInputs,
            ActionQuery::ControlState { task_id: "t-1".into() },
            ActionQuery::PausedTasks,
            ActionQuery::ControlReceipt { operation_id: "op-1".into(), target_task_id: Some("t-1".into()) },
            ActionQuery::ControlBatch { id: "b-1".into() },
            ActionQuery::ProactivePause { scope: "".into() },
            ActionQuery::IsProactivePaused { space_id: Some("sp-1".into()) },
            ActionQuery::LatestDelegationMeta { task_id: "t-1".into() },
            ActionQuery::DelegationReplay { operation_id: "op-1".into(), task_id: "t-1".into() },
            ActionQuery::DelegationStatus { operation_id: "op-1".into() },
            ActionQuery::DelegationActiveExists { operation_id: "op-1".into(), task_id: "t-1".into() },
            ActionQuery::HasAnyDelegation { task_id: "t-1".into() },
            ActionQuery::SourceLinks { source_message_id: "m-1".into() },
            ActionQuery::TaskLinkCount { source_message_id: "m-1".into() },
            ActionQuery::LatestStatusCheck { task_id: "t-1".into(), key: "k-1".into(), input_key: "ik-1".into() },
            ActionQuery::ContinuationTarget { source: "s-1".into(), task_id: "t-1".into() },
            ActionQuery::OtherContinuationTargets { source: "s-1".into(), excluding_task_id: "t-1".into() },
            ActionQuery::AutoWaitMatch { task_id: "t-1".into(), prerequisite_id: "p-1".into() },
            ActionQuery::ScopeMatches { operation_id: "op-1".into(), task_id: "t-1".into() },
            ActionQuery::UnsettledReplyOps,
            ActionQuery::TerminalDeliveryReceipt { task_id: "t-1".into(), seq: 1 },
            ActionQuery::PendingSteerCheck { task_id: "t-1".into(), goal_id: Some("g-1".into()), operation_id: Some("op-1".into()), continue_plan: true, follow_up: false },
            ActionQuery::BranchPersistenceCheck { child_task_id: "t-1".into() },
        ] {
            let _ = crate::dots_delegation_data::read(
                &db,
                crate::dots_delegation_data::Query::ActionData { query: aq },
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod snapshot_touch_tests {
    use super::*;

    fn task_db() -> crate::Result<Connection> {
        let db = Connection::open_in_memory()?;
        db.execute_batch(
            "CREATE TABLE tasks(id VARCHAR PRIMARY KEY, status VARCHAR, updated_at BIGINT);
             INSERT INTO tasks VALUES ('touch-a','in_progress',1000),('touch-b','in_progress',1000),
               ('touch-null',NULL,1000);",
        )?;
        Ok(db)
    }

    fn collapsed(reply: Option<Reply>) -> bool {
        matches!(reply, Some(Reply::Applied { .. }))
    }

    #[test]
    fn running_projections_collapse_within_the_window_but_terminal_ones_never_do() -> crate::Result<()>
    {
        let db = task_db()?;
        // The stored time is already past the projection, so the ordering guard would no-op.
        assert!(collapsed(collapsible_snapshot_reply(
            &db,
            "touch-a",
            "in_progress",
            Some(900.0),
            &[]
        )?));
        // An advancing projection has to land once before anything can be collapsed.
        assert!(!collapsed(collapsible_snapshot_reply(
            &db,
            "touch-a",
            "in_progress",
            Some(3_000.0),
            &[]
        )?));
        remember_snapshot_touch("touch-a", "in_progress");
        assert!(collapsed(collapsible_snapshot_reply(
            &db,
            "touch-a",
            "in_progress",
            Some(4_000.0),
            &[]
        )?));
        // A waiting or finished status is what readers act on: never collapse it.
        for status in ["completed", "failed", "stopped", "pending"] {
            assert!(!collapsed(collapsible_snapshot_reply(
                &db,
                "touch-a",
                status,
                Some(4_000.0),
                &[]
            )?));
        }
        // A status change is visible immediately even inside the window.
        assert!(!collapsed(collapsible_snapshot_reply(
            &db,
            "touch-a",
            "in_progress",
            Some(4_000.0),
            &[MessageWorkspace {
                message_id: "m-1".into(),
                cwd: "/workspace".into()
            }]
        )?));
        Ok(())
    }

    #[test]
    fn the_window_expires_and_unknown_tasks_keep_the_write_path() -> crate::Result<()> {
        let db = task_db()?;
        snapshot_touches().lock().unwrap().insert(
            "touch-b".into(),
            SnapshotTouch {
                status: "in_progress".into(),
                written_at_ms: crate::core_lease::now_ms() as i64 - SNAPSHOT_TOUCH_WINDOW_MS - 1,
            },
        );
        assert!(!collapsed(collapsible_snapshot_reply(
            &db,
            "touch-b",
            "in_progress",
            Some(4_000.0),
            &[]
        )?));
        // A task this memo never saw, and one the table does not hold, must not be answered
        // from memory.
        assert!(!collapsed(collapsible_snapshot_reply(
            &db,
            "touch-c",
            "in_progress",
            Some(4_000.0),
            &[]
        )?));
        assert!(!collapsed(collapsible_snapshot_reply(
            &db,
            "missing",
            "in_progress",
            Some(4_000.0),
            &[]
        )?));
        Ok(())
    }

    #[test]
    fn a_task_without_a_status_keeps_the_write_path() -> crate::Result<()> {
        // 用户从未写过状态的任务，`status` 列是 NULL：探测必须落回写路径，而不是把读列失败
        // 当成投影被拒绝。
        let db = task_db()?;
        remember_snapshot_touch("touch-null", "in_progress");
        assert!(collapsible_snapshot_reply(&db, "touch-null", "in_progress", Some(4_000.0), &[])?.is_none());
        Ok(())
    }
}
