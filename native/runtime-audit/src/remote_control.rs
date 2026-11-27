//! Step 6.4: Rust Core authoritative Remote background lifecycle, command deduplication
//! across disconnects/replays, durable Remote event log, and offline notification catch-up (`RC-16`).

use crate::business_protocol::{
    ClientContext, WriteSideEffects, append_event, current_core_generation,
    ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::{now_ms, sha256_hex};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_REMOTE_EVENT_RETENTION: i64 = 2048;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRemoteState {
    #[serde(default)]
    pub configured_enabled: bool,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub generation: i64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status,
    Lifecycle {
        configured_enabled: Option<bool>,
        running: Option<bool>,
        port: Option<Option<i64>>,
        base_url: Option<Option<String>>,
        error: Option<Option<String>>,
        now_ms: Option<i64>,
    },
    AdmitCommand {
        operation_id: String,
        command_type: String,
        task_id: Option<String>,
        request_payload: Option<Value>,
        now_ms: Option<i64>,
    },
    CompleteCommand {
        operation_id: String,
        command_type: String,
        status: String,
        response: Option<Value>,
        error_message: Option<String>,
        now_ms: Option<i64>,
    },
    QueryCommand {
        operation_id: String,
        command_type: String,
    },
    PublishEvent {
        event_type: String,
        payload: Value,
        now_ms: Option<i64>,
    },
    ReplayEvents {
        after_id: i64,
        limit: Option<i64>,
    },
    PublishNotification {
        id: Option<String>,
        #[serde(rename = "type")]
        notification_type: String,
        level: String,
        title: String,
        body: Option<String>,
        source_type: String,
        source_id: Option<String>,
        task_id: Option<String>,
        project_id: Option<String>,
        workspace_id: Option<String>,
        dedupe_key: Option<String>,
        created_at: Option<i64>,
    },
    CatchupNotifications {
        after_created_at_ms: Option<i64>,
        after_seq: Option<i64>,
        limit: Option<i64>,
    },
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Command::Status
                | Command::QueryCommand { .. }
                | Command::ReplayEvents { .. }
                | Command::CatchupNotifications { .. }
        )
    }
}

pub fn ensure_remote_control_tables(db: &Connection) -> crate::Result<()> {
    let _ = db;
    Ok(())
}

fn table_exists(db: &Connection, name: &str) -> crate::Result<bool> {
    crate::database::table_exists(db, name)
}

fn load_state(db: &Connection) -> crate::Result<RuntimeRemoteState> {
    if !table_exists(db, "core_remote_state")? {
        return Ok(RuntimeRemoteState::default());
    }
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM core_remote_state WHERE key = 'runtime'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save_state(tx: &Connection, state: &RuntimeRemoteState) -> crate::Result<()> {
    tx.execute(
        "INSERT INTO core_remote_state (key, value_json) VALUES ('runtime', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [serde_json::to_string(state)?],
    )?;
    Ok(())
}

fn command_key(command_type: &str, operation_id: &str) -> String {
    sha256_hex(&format!("remote-cmd:{command_type}:{operation_id}"))
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    match command {
        Command::Status => {
            let state = load_state(db)?;
            let cmd_count: i64 = if table_exists(db, "core_remote_commands")? {
                db.query_row("SELECT COUNT(*) FROM core_remote_commands", [], |r| r.get(0))?
            } else {
                0
            };
            let event_head: i64 = if table_exists(db, "core_remote_events")? {
                db.query_row(
                    "SELECT COALESCE(MAX(id), 0) FROM core_remote_events",
                    [],
                    |r| r.get(0),
                )?
            } else {
                0
            };
            Ok(json!({
                "status": "ok",
                "remote": state,
                "commandCount": cmd_count,
                "eventHeadId": event_head,
            }))
        }
        Command::QueryCommand {
            operation_id,
            command_type,
        } => {
            if !table_exists(db, "core_remote_commands")? {
                return Ok(json!({ "status": "ok", "found": false }));
            }
            let key = command_key(&command_type, &operation_id);
            let row: Option<(String, Option<String>, Option<String>, i64)> = db
                .query_row(
                    "SELECT status, response_json, error_message, updated_at_ms
                     FROM core_remote_commands WHERE command_key = ?1",
                    [&key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            Ok(match row {
                None => json!({ "status": "ok", "found": false }),
                Some((cmd_status, resp_str, err_msg, upd)) => {
                    let resp = resp_str
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok());
                    json!({
                        "status": "ok",
                        "found": true,
                        "commandStatus": cmd_status,
                        "response": resp,
                        "errorMessage": err_msg,
                        "updatedAtMs": upd,
                    })
                }
            })
        }
        Command::ReplayEvents { after_id, limit } => {
            if !table_exists(db, "core_remote_events")? {
                return Ok(json!({ "status": "ok", "gap": false, "headId": 0, "events": [] }));
            }
            let min_id: i64 = db.query_row(
                "SELECT COALESCE(MIN(id), 0) FROM core_remote_events",
                [],
                |r| r.get(0),
            )?;
            let head_id: i64 = db.query_row(
                "SELECT COALESCE(MAX(id), 0) FROM core_remote_events",
                [],
                |r| r.get(0),
            )?;
            if after_id < 0 || after_id > head_id || (min_id > 1 && after_id < min_id - 1) {
                return Ok(json!({
                    "status": "ok",
                    "gap": true,
                    "headId": head_id,
                    "minId": min_id,
                    "events": [],
                }));
            }
            let cap = limit.unwrap_or(256).clamp(1, 1024);
            let mut stmt = db.prepare(
                "SELECT id, event_type, payload_json, created_at_ms
                 FROM core_remote_events
                 WHERE id > ?1
                 ORDER BY id ASC LIMIT ?2",
            )?;
            let events: Vec<Value> = stmt
                .query_map(params![after_id, cap], |r| {
                    let payload_raw: String = r.get(2)?;
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "type": r.get::<_, String>(1)?,
                        "payload": serde_json::from_str::<Value>(&payload_raw).unwrap_or(Value::Null),
                        "at": r.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({
                "status": "ok",
                "gap": false,
                "headId": head_id,
                "minId": min_id,
                "events": events,
            }))
        }
        Command::CatchupNotifications {
            after_created_at_ms,
            after_seq,
            limit,
        } => {
            let snapshot = db.unchecked_transaction()?;
            let db: &Connection = &snapshot;
            let cap = limit.unwrap_or(100).clamp(1, 200);
            let since = after_created_at_ms.unwrap_or(0);
            let notifications: Vec<Value> = if table_exists(db, "notifications")? {
                let mut stmt = db.prepare(
                    "SELECT id, type, level, title, body, source_type, source_id, task_id, project_id, workspace_id, dedupe_key, created_at, read_at, dismissed_at
                     FROM notifications
                     WHERE dismissed_at IS NULL AND (created_at >= ?1 OR read_at IS NULL)
                     ORDER BY created_at DESC, id DESC LIMIT ?2",
                )?;
                stmt.query_map(params![since, cap], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "type": r.get::<_, String>(1)?,
                        "level": r.get::<_, String>(2)?,
                        "title": r.get::<_, String>(3)?,
                        "body": r.get::<_, Option<String>>(4)?,
                        "sourceType": r.get::<_, String>(5)?,
                        "sourceId": r.get::<_, Option<String>>(6)?,
                        "taskId": r.get::<_, Option<String>>(7)?,
                        "projectId": r.get::<_, Option<String>>(8)?,
                        "workspaceId": r.get::<_, Option<String>>(9)?,
                        "dedupeKey": r.get::<_, Option<String>>(10)?,
                        "createdAt": r.get::<_, i64>(11)?,
                        "readAt": r.get::<_, Option<i64>>(12)?,
                        "dismissedAt": r.get::<_, Option<i64>>(13)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                vec![]
            };
            let unread_count: i64 = if table_exists(db, "notifications")? {
                db.query_row(
                    "SELECT COUNT(*) FROM notifications WHERE dismissed_at IS NULL AND read_at IS NULL",
                    [],
                    |r| r.get(0),
                )?
            } else {
                0
            };
            let seq_floor = after_seq.unwrap_or(0);
            let domain_events: Vec<Value> = if table_exists(db, "core_domain_events")? {
                let mut estmt = db.prepare(
                    "SELECT seq, kind, entity_id, payload_json, created_at_ms
                     FROM core_domain_events
                     WHERE seq > ?1 AND domain IN ('notification', 'cron', 'remote')
                     ORDER BY seq ASC LIMIT ?2",
                )?;
                estmt
                    .query_map(params![seq_floor, cap], |r| {
                        let p_raw: String = r.get(3)?;
                        Ok(json!({
                            "seq": r.get::<_, i64>(0)?,
                            "kind": r.get::<_, String>(1)?,
                            "entityId": r.get::<_, String>(2)?,
                            "payload": serde_json::from_str::<Value>(&p_raw).unwrap_or(Value::Null),
                            "createdAtMs": r.get::<_, i64>(4)?,
                        }))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                vec![]
            };
            snapshot.commit()?;
            Ok(json!({
                "status": "ok",
                "unreadCount": unread_count,
                "notifications": notifications,
                "domainEvents": domain_events,
            }))
        }
        _ => Ok(json!({ "status": "rejected", "code": "NOT_READ_ONLY" })),
    }
}

pub fn execute_write(
    db: &mut Connection,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_protocol_tables(db, &core_gen)?;
    ensure_remote_control_tables(db)?;

    let tx = db.transaction()?;
    let mut events = Vec::new();

    let data = match command {
        Command::Lifecycle {
            configured_enabled,
            running,
            port,
            base_url,
            error,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let mut state = load_state(&tx)?;
            if let Some(v) = configured_enabled {
                state.configured_enabled = v;
            }
            if let Some(v) = running {
                state.running = v;
            }
            if let Some(p) = port {
                state.port = p;
            }
            if let Some(b) = base_url {
                state.base_url = b;
            }
            if let Some(e) = error {
                state.error = e;
            }
            state.generation += 1;
            state.updated_at_ms = now;
            save_state(&tx, &state)?;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "remote",
                "remote.lifecycle",
                "remote",
                state.generation,
                None,
                &serde_json::to_value(&state)?,
            )?);
            json!({ "status": "ok", "remote": state })
        }
        Command::AdmitCommand {
            operation_id,
            command_type,
            task_id,
            request_payload,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let key = command_key(&command_type, &operation_id);
            let req_hash = sha256_hex(
                &request_payload
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
                    .unwrap_or_default(),
            );
            let existing: Option<(String, String, Option<String>, Option<String>)> = tx
                .query_row(
                    "SELECT status, request_hash, response_json, error_message
                     FROM core_remote_commands WHERE command_key = ?1",
                    [&key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            if let Some((cmd_status, prev_hash, resp_str, err_msg)) = existing {
                if prev_hash != req_hash {
                    return Ok(WriteSideEffects {
                        data: json!({
                            "status": "rejected",
                            "code": "PAYLOAD_CONFLICT",
                            "operationId": operation_id,
                            "commandType": command_type,
                        }),
                        events,
                        dispatches: vec![],
                        shutdown_after_reply: false,
                    });
                }
                let resp = resp_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                events.push(append_event(
                    &tx,
                    &core_gen,
                    &client.generation,
                    "remote",
                    "remote.commandDeduplicated",
                    &key,
                    now,
                    Some(&operation_id),
                    &json!({ "operationId": operation_id, "commandType": command_type, "commandStatus": cmd_status }),
                )?);
                json!({
                    "status": "ok",
                    "duplicate": true,
                    "commandStatus": cmd_status,
                    "response": resp,
                    "errorMessage": err_msg,
                })
            } else {
                tx.execute(
                    "INSERT INTO core_remote_commands (
                        command_key, operation_id, command_type, task_id, request_hash, status,
                        response_json, error_message, created_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'in_progress', NULL, NULL, ?6, ?6)",
                    params![key, operation_id, command_type, task_id, req_hash, now],
                )?;
                events.push(append_event(
                    &tx,
                    &core_gen,
                    &client.generation,
                    "remote",
                    "remote.commandAdmitted",
                    &key,
                    now,
                    Some(&operation_id),
                    &json!({ "operationId": operation_id, "commandType": command_type, "taskId": task_id }),
                )?);
                json!({
                    "status": "ok",
                    "duplicate": false,
                    "accepted": true,
                    "commandStatus": "in_progress",
                })
            }
        }
        Command::CompleteCommand {
            operation_id,
            command_type,
            status,
            response,
            error_message,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let key = command_key(&command_type, &operation_id);
            let resp_json = response.as_ref().map(serde_json::to_string).transpose()?;
            tx.execute(
                "UPDATE core_remote_commands
                 SET status = ?1, response_json = COALESCE(?2, response_json), error_message = ?3, updated_at_ms = ?4
                 WHERE command_key = ?5",
                params![status, resp_json, error_message, now, key],
            )?;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "remote",
                "remote.commandSettled",
                &key,
                now,
                Some(&operation_id),
                &json!({ "operationId": operation_id, "commandType": command_type, "commandStatus": status }),
            )?);
            json!({ "status": "ok", "operationId": operation_id, "commandStatus": status })
        }
        Command::PublishEvent {
            event_type,
            payload,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let payload_str = serde_json::to_string(&payload)?;
            let id: i64 = tx.query_row(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM core_remote_events",
                [],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO core_remote_events (id, event_type, payload_json, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
                params![id, event_type, payload_str, now],
            )?;
            tx.execute(
                "DELETE FROM core_remote_events WHERE id <= (SELECT COALESCE(MAX(id), 0) - ?1 FROM core_remote_events)",
                [MAX_REMOTE_EVENT_RETENTION],
            )?;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "remote",
                "remote.eventPublished",
                &id.to_string(),
                id,
                None,
                &json!({ "id": id, "type": event_type, "payload": payload, "at": now }),
            )?);
            json!({ "status": "ok", "eventId": id })
        }
        Command::PublishNotification {
            id,
            notification_type,
            level,
            title,
            body,
            source_type,
            source_id,
            task_id,
            project_id,
            workspace_id,
            dedupe_key,
            created_at,
        } => {
            let now = created_at.unwrap_or_else(now_ms);
            let nid = id.unwrap_or_else(|| {
                let seed = dedupe_key.as_deref().unwrap_or(&title);
                let h = sha256_hex(&format!("notif:{notification_type}:{seed}:{now}"));
                format!("notif-{}", &h[..16])
            });
            let notice = crate::notification_data::Notification {
                id: nid,
                notification_type,
                level,
                title,
                body,
                source_type,
                source_id,
                task_id,
                project_id,
                workspace_id,
                dedupe_key,
                created_at: now,
            };
            let inserted = crate::notification_data::insert(&tx, &notice, None, true, false)?;
            let unread_count = crate::notification_data::unread_count(&tx)?;
            if inserted {
                events.push(append_event(
                    &tx,
                    &core_gen,
                    &client.generation,
                    "notification",
                    "notification.created",
                    &notice.id,
                    now,
                    None,
                    &json!({
                        "id": notice.id,
                        "type": notice.notification_type,
                        "level": notice.level,
                        "title": notice.title,
                        "body": notice.body,
                        "sourceType": notice.source_type,
                        "sourceId": notice.source_id,
                        "taskId": notice.task_id,
                        "projectId": notice.project_id,
                        "workspaceId": notice.workspace_id,
                        "dedupeKey": notice.dedupe_key,
                        "createdAt": now,
                        "unreadCount": unread_count,
                    }),
                )?);
            }
            json!({ "status": "ok", "id": notice.id, "inserted": inserted, "unreadCount": unread_count })
        }
        Command::Status
        | Command::QueryCommand { .. }
        | Command::ReplayEvents { .. }
        | Command::CatchupNotifications { .. } => {
            json!({ "status": "rejected", "code": "READ_ONLY" })
        }
    };

    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data,
        events,
        dispatches: vec![],
        shutdown_after_reply: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::CANONICAL_DUCKDB_SCHEMA_SQL;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL).expect("schema");
        let core_gen = current_core_generation();
        ensure_protocol_tables(&conn, &core_gen).expect("protocol tables");
        ensure_remote_control_tables(&conn).expect("remote tables");
        conn
    }

    #[test]
    fn remote_command_dedup_and_offline_notification_catchup() {
        let mut conn = setup_db();
        let ctx = ClientContext::synthetic("test-gen");
        let t0 = 1_700_000_000_000i64;

        // 1. Remote command admit -> complete -> reconnect replay returns cached result
        let a1 = execute_write(
            &mut conn,
            &ctx,
            Command::AdmitCommand {
                operation_id: "op-remote-1".into(),
                command_type: "prompt".into(),
                task_id: Some("t-1".into()),
                request_payload: Some(json!({ "text": "hello" })),
                now_ms: Some(t0),
            },
        )
        .unwrap();
        assert_eq!(a1.data["duplicate"], json!(false));

        execute_write(
            &mut conn,
            &ctx,
            Command::CompleteCommand {
                operation_id: "op-remote-1".into(),
                command_type: "prompt".into(),
                status: "completed".into(),
                response: Some(json!({ "ok": true, "submissionId": 42 })),
                error_message: None,
                now_ms: Some(t0 + 50),
            },
        )
        .unwrap();

        let replay = execute_write(
            &mut conn,
            &ctx,
            Command::AdmitCommand {
                operation_id: "op-remote-1".into(),
                command_type: "prompt".into(),
                task_id: Some("t-1".into()),
                request_payload: Some(json!({ "text": "hello" })),
                now_ms: Some(t0 + 200),
            },
        )
        .unwrap();
        assert_eq!(replay.data["duplicate"], json!(true));
        assert_eq!(replay.data["commandStatus"], json!("completed"));
        assert_eq!(replay.data["response"]["submissionId"], json!(42));

        // 2. Offline notifications published while UI offline -> catchup recovers once with dedupe
        let n1 = execute_write(
            &mut conn,
            &ctx,
            Command::PublishNotification {
                id: None,
                notification_type: "automation.completed".into(),
                level: "success".into(),
                title: "Cron done offline".into(),
                body: Some("Finished check".into()),
                source_type: "automation".into(),
                source_id: Some("job-1".into()),
                task_id: Some("t-1".into()),
                project_id: None,
                workspace_id: None,
                dedupe_key: Some("offline-cron-1".into()),
                created_at: Some(t0 + 300),
            },
        )
        .unwrap();
        assert_eq!(n1.data["inserted"], json!(true));

        let dup_n = execute_write(
            &mut conn,
            &ctx,
            Command::PublishNotification {
                id: None,
                notification_type: "automation.completed".into(),
                level: "success".into(),
                title: "Cron done offline".into(),
                body: Some("Finished check".into()),
                source_type: "automation".into(),
                source_id: Some("job-1".into()),
                task_id: Some("t-1".into()),
                project_id: None,
                workspace_id: None,
                dedupe_key: Some("offline-cron-1".into()),
                created_at: Some(t0 + 400),
            },
        )
        .unwrap();
        assert_eq!(dup_n.data["inserted"], json!(false));

        let catchup = execute_read(
            &conn,
            Command::CatchupNotifications {
                after_created_at_ms: Some(t0),
                after_seq: Some(0),
                limit: Some(50),
            },
        )
        .unwrap();
        assert_eq!(catchup["unreadCount"], json!(1));
        assert_eq!(catchup["notifications"].as_array().unwrap().len(), 1);
    }
}
