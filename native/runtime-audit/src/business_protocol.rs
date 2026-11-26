//! Step 3 business protocol: named domain commands, monotonic revisions, atomic SQLite
//! event log with bounded retention and cursor replay/resync, and Core-owned execution slots.

use crate::core_lease::{self, CoreLifecycleState};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::atomic::{AtomicI64, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_RETENTION_LIMIT: i64 = 4096;
const DEFAULT_REPLAY_LIMIT: usize = 256;
const MAX_EXECUTION_QUEUE: i64 = 256;
const MAX_EXECUTION_SLOTS: i64 = 8;

static EVENT_ID_SEQ: AtomicU64 = AtomicU64::new(1);
static EPHEMERAL_PROGRESS_EMITTED: AtomicU64 = AtomicU64::new(0);

pub fn ephemeral_progress_emitted() -> u64 {
    EPHEMERAL_PROGRESS_EMITTED.load(Ordering::Relaxed)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn next_event_id(generation: &str) -> String {
    let seq = EVENT_ID_SEQ.fetch_add(1, Ordering::AcqRel);
    format!("evt-{}-{seq}", &generation[..generation.len().min(8)])
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientContext {
    pub epoch: u64,
    pub role: String,
    pub client_id: String,
    pub generation: String,
}

impl ClientContext {
    pub fn synthetic(generation: &str) -> Self {
        Self {
            epoch: 0,
            role: "legacy".to_owned(),
            client_id: "direct".to_owned(),
            generation: generation.to_owned(),
        }
    }
}

#[derive(Default)]
pub struct ExecutorTracker {
    online: std::sync::atomic::AtomicBool,
    epoch: AtomicU64,
    client_id: std::sync::Mutex<String>,
    slots_limit: AtomicI64,
    capabilities: std::sync::Mutex<Option<HashSet<String>>>,
    active_executions: std::sync::Mutex<HashMap<String, (i64, u64, String)>>,
}

impl ExecutorTracker {
    pub fn new() -> Self {
        Self {
            online: std::sync::atomic::AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            client_id: std::sync::Mutex::new(String::new()),
            slots_limit: AtomicI64::new(MAX_EXECUTION_SLOTS),
            capabilities: std::sync::Mutex::new(None),
            active_executions: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn register_active_execution(
        &self,
        execution_id: &str,
        attempt: i64,
        epoch: u64,
        owner_generation: &str,
    ) {
        if let Ok(mut map) = self.active_executions.lock() {
            map.insert(
                execution_id.to_owned(),
                (attempt, epoch, owner_generation.to_owned()),
            );
        }
    }

    pub fn clear_active_execution(&self, execution_id: &str) {
        if let Ok(mut map) = self.active_executions.lock() {
            map.remove(execution_id);
        }
    }

    pub fn verify_active_execution(
        &self,
        execution_id: &str,
        attempt: i64,
        epoch: u64,
    ) -> Option<String> {
        let map = self.active_executions.lock().ok()?;
        let (exp_attempt, exp_epoch, owner_gen) = map.get(execution_id)?;
        if *exp_attempt == attempt && *exp_epoch == epoch {
            Some(owner_gen.clone())
        } else {
            None
        }
    }

    pub fn set_presence(&self, online: bool, epoch: u64, client_id: String) {
        if online {
            if let Ok(mut guard) = self.client_id.lock() {
                *guard = client_id;
            }
            if let Ok(mut caps) = self.capabilities.lock() {
                *caps = None;
            }
            self.epoch.store(epoch, Ordering::Release);
            self.online.store(true, Ordering::Release);
        } else if self.epoch.load(Ordering::Acquire) == epoch || epoch == 0 {
            self.online.store(false, Ordering::Release);
            if let Ok(mut caps) = self.capabilities.lock() {
                *caps = None;
            }
            if let Ok(mut active) = self.active_executions.lock() {
                if epoch == 0 {
                    active.clear();
                } else {
                    active.retain(|_, (_, e, _)| *e != epoch);
                }
            }
        }
    }

    pub fn set_capabilities(&self, capabilities: Option<HashSet<String>>) {
        if let Ok(mut guard) = self.capabilities.lock() {
            *guard = capabilities;
        }
    }

    pub fn supports_kind(&self, kind: &str) -> bool {
        let Ok(guard) = self.capabilities.lock() else {
            return true;
        };
        match guard.as_ref() {
            Some(caps) => caps.contains(kind),
            None => true,
        }
    }

    pub fn is_online(&self) -> Option<(u64, String)> {
        if !self.online.load(Ordering::Acquire) {
            return None;
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        let client_id = self
            .client_id
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        Some((epoch, client_id))
    }

    pub fn slots_limit(&self) -> i64 {
        self.slots_limit.load(Ordering::Acquire).max(1)
    }

    pub fn set_slots_limit(&self, limit: i64) {
        self.slots_limit.store(limit.clamp(1, 64), Ordering::Release);
    }
}

pub fn current_core_generation() -> String {
    std::env::var(core_lease::GENERATION_ENV).unwrap_or_else(|_| "direct-worker".to_owned())
}

pub(crate) fn ensure_tables(conn: &Connection, core_generation: &str) -> crate::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS core_event_meta (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           core_generation TEXT NOT NULL,
           min_available_seq INTEGER NOT NULL,
           retention_limit INTEGER NOT NULL DEFAULT 4096
         );
         CREATE TABLE IF NOT EXISTS core_domain_events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           event_id TEXT UNIQUE NOT NULL,
           core_generation TEXT NOT NULL,
           owner_generation TEXT NOT NULL,
           domain TEXT NOT NULL,
           kind TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           revision INTEGER NOT NULL,
           command_id TEXT,
           payload_json TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_core_domain_events_domain ON core_domain_events(domain, seq);
         CREATE TABLE IF NOT EXISTS core_domain_notes (
           entity_id TEXT PRIMARY KEY,
           owner_generation TEXT NOT NULL,
           revision INTEGER NOT NULL,
           title TEXT NOT NULL,
           body_json TEXT NOT NULL,
           deleted INTEGER NOT NULL DEFAULT 0,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS core_command_receipts (
           command_id TEXT PRIMARY KEY,
           command_name TEXT NOT NULL,
           result_json TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS core_execution_runs (
           execution_id TEXT PRIMARY KEY,
           idempotency_key TEXT UNIQUE NOT NULL,
           owner_generation TEXT NOT NULL,
           source_role TEXT NOT NULL,
           source_client_id TEXT NOT NULL,
           source_epoch INTEGER NOT NULL,
           task_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           status TEXT NOT NULL,
           revision INTEGER NOT NULL DEFAULT 1,
           executor_client_id TEXT,
           executor_epoch INTEGER,
           attempt INTEGER NOT NULL DEFAULT 0,
           result_json TEXT,
           error_message TEXT,
           wait_reason TEXT,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_core_execution_status ON core_execution_runs(status, created_at_ms);",
    )?;
    let has_wait_reason: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(core_execution_runs)")?;
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        cols.iter().any(|c| c == "wait_reason")
    };
    if !has_wait_reason {
        conn.execute(
            "ALTER TABLE core_execution_runs ADD COLUMN wait_reason TEXT",
            [],
        )?;
    }
    let existing: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT core_generation, min_available_seq, retention_limit FROM core_event_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match existing {
        None => {
            conn.execute(
                "INSERT INTO core_event_meta (id, core_generation, min_available_seq, retention_limit) VALUES (1, ?, 1, ?)",
                params![core_generation, DEFAULT_RETENTION_LIMIT],
            )?;
        }
        Some((stored_gen, _, _)) if stored_gen != core_generation => {
            conn.execute(
                "UPDATE core_event_meta SET core_generation = ? WHERE id = 1",
                params![core_generation],
            )?;
        }
        Some(_) => {}
    }
    Ok(())
}

pub(crate) fn table_exists(conn: &Connection, table: &str) -> crate::Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
            params![table],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmittedEvent {
    pub seq: i64,
    pub event_id: String,
    pub core_generation: String,
    pub owner_generation: String,
    pub domain: String,
    pub kind: String,
    pub entity_id: String,
    pub revision: i64,
    pub command_id: Option<String>,
    pub payload: Value,
    pub created_at_ms: i64,
}

pub(crate) fn append_event(
    tx: &Connection,
    core_generation: &str,
    owner_generation: &str,
    domain: &str,
    kind: &str,
    entity_id: &str,
    revision: i64,
    command_id: Option<&str>,
    payload: &Value,
) -> crate::Result<EmittedEvent> {
    let event_id = next_event_id(core_generation);
    let created_at_ms = now_ms();
    let payload_json = serde_json::to_string(payload)?;
    tx.execute(
        "INSERT INTO core_domain_events (
           event_id, core_generation, owner_generation, domain, kind, entity_id, revision, command_id, payload_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            event_id,
            core_generation,
            owner_generation,
            domain,
            kind,
            entity_id,
            revision,
            command_id,
            payload_json,
            created_at_ms
        ],
    )?;
    let seq = tx.last_insert_rowid();
    prune_retention_window(tx)?;
    Ok(EmittedEvent {
        seq,
        event_id,
        core_generation: core_generation.to_owned(),
        owner_generation: owner_generation.to_owned(),
        domain: domain.to_owned(),
        kind: kind.to_owned(),
        entity_id: entity_id.to_owned(),
        revision,
        command_id: command_id.map(str::to_owned),
        payload: payload.clone(),
        created_at_ms,
    })
}

fn prune_retention_window(tx: &Connection) -> crate::Result<()> {
    let (min_seq, limit): (i64, i64) = tx.query_row(
        "SELECT min_available_seq, retention_limit FROM core_event_meta WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let head_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM core_domain_events",
        [],
        |row| row.get(0),
    )?;
    let keep_from = (head_seq - limit.max(1) + 1).max(min_seq);
    if keep_from > min_seq {
        tx.execute(
            "DELETE FROM core_domain_events WHERE seq < ?",
            params![keep_from],
        )?;
        tx.execute(
            "UPDATE core_event_meta SET min_available_seq = ? WHERE id = 1",
            params![keep_from],
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CommandInput {
    UpsertNote {
        command_id: String,
        entity_id: String,
        expected_revision: Option<i64>,
        owner_generation: Option<String>,
        title: String,
        body: Option<Value>,
    },
    DeleteNote {
        command_id: String,
        entity_id: String,
        expected_revision: Option<i64>,
        owner_generation: Option<String>,
    },
    SetEventRetention {
        limit: i64,
    },
    SetExecutionSlotsLimit {
        limit: i64,
    },
}

#[derive(Debug)]
pub struct WriteSideEffects {
    pub data: Value,
    pub events: Vec<EmittedEvent>,
    pub dispatches: Vec<Value>,
    pub shutdown_after_reply: bool,
}

pub fn execute_command(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: CommandInput,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    match command {
        CommandInput::SetEventRetention { limit } => {
            let clamped = limit.clamp(2, 100_000);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "UPDATE core_event_meta SET retention_limit = ? WHERE id = 1",
                params![clamped],
            )?;
            prune_retention_window(&tx)?;
            let min_available_seq: i64 = tx.query_row(
                "SELECT min_available_seq FROM core_event_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "retentionLimit": clamped, "minAvailableSeq": min_available_seq }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        CommandInput::SetExecutionSlotsLimit { limit } => {
            tracker.set_slots_limit(limit);
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "slotsLimit": tracker.slots_limit() }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        CommandInput::UpsertNote {
            command_id,
            entity_id,
            expected_revision,
            owner_generation,
            title,
            body,
        } => {
            if command_id.trim().is_empty() || entity_id.trim().is_empty() {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "INVALID_REQUEST", "message": "commandId and entityId are required" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(prev) = tx
                .query_row(
                    "SELECT result_json FROM core_command_receipts WHERE command_id = ?",
                    params![command_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                let mut result: Value = serde_json::from_str(&prev)?;
                if let Some(obj) = result.as_object_mut() {
                    obj.insert("deduplicated".into(), Value::Bool(true));
                }
                return Ok(WriteSideEffects {
                    data: result,
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let current: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT revision, deleted FROM core_domain_notes WHERE entity_id = ?",
                    params![entity_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let current_rev = current.map(|(r, _)| r).unwrap_or(0);
            if let Some(expected) = expected_revision
                && expected != current_rev
            {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "rejected",
                        "code": "REVISION_CONFLICT",
                        "entityId": entity_id,
                        "expectedRevision": expected,
                        "actualRevision": current_rev,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = current_rev + 1;
            let owner_gen = owner_generation.unwrap_or_else(|| client.generation.clone());
            let body_val = body.unwrap_or_else(|| json!({}));
            let body_json = serde_json::to_string(&body_val)?;
            let updated_at_ms = now_ms();
            tx.execute(
                "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                 VALUES (?, ?, ?, ?, ?, 0, ?)
                 ON CONFLICT(entity_id) DO UPDATE SET
                   owner_generation = excluded.owner_generation,
                   revision = excluded.revision,
                   title = excluded.title,
                   body_json = excluded.body_json,
                   deleted = 0,
                   updated_at_ms = excluded.updated_at_ms",
                params![entity_id, owner_gen, next_rev, title, body_json, updated_at_ms],
            )?;
            let event = append_event(
                &tx,
                &core_gen,
                &owner_gen,
                "domainNote",
                if current.is_none() { "domainNote.created" } else { "domainNote.updated" },
                &entity_id,
                next_rev,
                Some(&command_id),
                &json!({
                    "entityId": entity_id,
                    "title": title,
                    "body": body_val,
                    "revision": next_rev,
                    "role": client.role,
                    "clientId": client.client_id,
                    "epoch": client.epoch,
                }),
            )?;
            let reply = json!({
                "status": "committed",
                "commandId": command_id,
                "entityId": entity_id,
                "revision": next_rev,
                "coreGeneration": core_gen,
                "ownerGeneration": owner_gen,
                "eventSeq": event.seq,
                "deduplicated": false,
            });
            tx.execute(
                "INSERT INTO core_command_receipts (command_id, command_name, result_json, created_at_ms) VALUES (?, 'upsertNote', ?, ?)",
                params![command_id, serde_json::to_string(&reply)?, updated_at_ms],
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![event],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        CommandInput::DeleteNote {
            command_id,
            entity_id,
            expected_revision,
            owner_generation,
        } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(prev) = tx
                .query_row(
                    "SELECT result_json FROM core_command_receipts WHERE command_id = ?",
                    params![command_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                let mut result: Value = serde_json::from_str(&prev)?;
                if let Some(obj) = result.as_object_mut() {
                    obj.insert("deduplicated".into(), Value::Bool(true));
                }
                return Ok(WriteSideEffects {
                    data: result,
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let current: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT revision, deleted FROM core_domain_notes WHERE entity_id = ?",
                    params![entity_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let current_rev = current.map(|(r, _)| r).unwrap_or(0);
            if current.is_none() {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND", "entityId": entity_id }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(expected) = expected_revision
                && expected != current_rev
            {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "rejected",
                        "code": "REVISION_CONFLICT",
                        "entityId": entity_id,
                        "expectedRevision": expected,
                        "actualRevision": current_rev,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = current_rev + 1;
            let owner_gen = owner_generation.unwrap_or_else(|| client.generation.clone());
            let updated_at_ms = now_ms();
            tx.execute(
                "UPDATE core_domain_notes SET deleted = 1, revision = ?, owner_generation = ?, updated_at_ms = ? WHERE entity_id = ?",
                params![next_rev, owner_gen, updated_at_ms, entity_id],
            )?;
            let event = append_event(
                &tx,
                &core_gen,
                &owner_gen,
                "domainNote",
                "domainNote.deleted",
                &entity_id,
                next_rev,
                Some(&command_id),
                &json!({ "entityId": entity_id, "revision": next_rev }),
            )?;
            let reply = json!({
                "status": "committed",
                "commandId": command_id,
                "entityId": entity_id,
                "revision": next_rev,
                "coreGeneration": core_gen,
                "ownerGeneration": owner_gen,
                "eventSeq": event.seq,
                "deduplicated": false,
            });
            tx.execute(
                "INSERT INTO core_command_receipts (command_id, command_name, result_json, created_at_ms) VALUES (?, 'deleteNote', ?, ?)",
                params![command_id, serde_json::to_string(&reply)?, updated_at_ms],
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![event],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecutionRequest {
    Submit {
        execution_id: String,
        idempotency_key: String,
        task_id: String,
        kind: String,
        payload: Option<Value>,
        owner_generation: Option<String>,
    },
    Pause {
        execution_id: String,
        expected_revision: Option<i64>,
    },
    Cancel {
        execution_id: String,
        expected_revision: Option<i64>,
    },
    Resume {
        execution_id: String,
        expected_revision: Option<i64>,
    },
    Status {
        execution_id: String,
    },
    Reconcile {
        execution_id: String,
        status: String,
        expected_revision: Option<i64>,
        attempt: Option<i64>,
        result: Option<Value>,
        error_message: Option<String>,
    },
    ExecutorAck {
        execution_id: String,
        attempt: i64,
        owner_generation: Option<String>,
        #[serde(default)]
        host_generation: Option<String>,
    },
    ExecutorProgress {
        execution_id: String,
        attempt: i64,
        progress: Value,
        owner_generation: Option<String>,
        #[serde(default)]
        host_generation: Option<String>,
        #[serde(default)]
        ephemeral: bool,
    },
    ExecutorSettled {
        execution_id: String,
        attempt: i64,
        status: String, // "completed" | "failed" | "cancelled" | "paused" | "unknown"
        result: Option<Value>,
        error_message: Option<String>,
        owner_generation: Option<String>,
        #[serde(default)]
        host_generation: Option<String>,
    },
}

pub fn execution_is_read_only(req: &ExecutionRequest) -> bool {
    matches!(req, ExecutionRequest::Status { .. })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionRow {
    pub(crate) execution_id: String,
    pub(crate) idempotency_key: String,
    pub(crate) owner_generation: String,
    pub(crate) source_role: String,
    pub(crate) source_client_id: String,
    pub(crate) source_epoch: i64,
    pub(crate) task_id: String,
    pub(crate) kind: String,
    pub(crate) payload: Value,
    pub(crate) status: String,
    pub(crate) revision: i64,
    pub(crate) executor_client_id: Option<String>,
    pub(crate) executor_epoch: Option<i64>,
    pub(crate) attempt: i64,
    pub(crate) result: Option<Value>,
    pub(crate) error_message: Option<String>,
    pub(crate) wait_reason: Option<String>,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

pub(crate) fn fetch_execution_tx(conn: &Connection, execution_id: &str) -> crate::Result<Option<ExecutionRow>> {
    fetch_execution(conn, execution_id)
}

pub(crate) fn row_to_execution_pub(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionRow> {
    row_to_execution(row)
}

fn fetch_execution(conn: &Connection, execution_id: &str) -> crate::Result<Option<ExecutionRow>> {
    conn.query_row(
        "SELECT execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt,
                result_json, error_message, wait_reason, created_at_ms, updated_at_ms
         FROM core_execution_runs WHERE execution_id = ?",
        params![execution_id],
        row_to_execution,
    )
    .optional()
    .map_err(Into::into)
}

fn fetch_execution_by_key(conn: &Connection, idempotency_key: &str) -> crate::Result<Option<ExecutionRow>> {
    conn.query_row(
        "SELECT execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt,
                result_json, error_message, wait_reason, created_at_ms, updated_at_ms
         FROM core_execution_runs WHERE idempotency_key = ?",
        params![idempotency_key],
        row_to_execution,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_execution(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionRow> {
    let payload_str: String = row.get(8)?;
    let result_str: Option<String> = row.get(14)?;
    Ok(ExecutionRow {
        execution_id: row.get(0)?,
        idempotency_key: row.get(1)?,
        owner_generation: row.get(2)?,
        source_role: row.get(3)?,
        source_client_id: row.get(4)?,
        source_epoch: row.get(5)?,
        task_id: row.get(6)?,
        kind: row.get(7)?,
        payload: serde_json::from_str(&payload_str).unwrap_or(Value::Null),
        status: row.get(9)?,
        revision: row.get(10)?,
        executor_client_id: row.get(11)?,
        executor_epoch: row.get(12)?,
        attempt: row.get(13)?,
        result: result_str.and_then(|s| serde_json::from_str(&s).ok()),
        error_message: row.get(15)?,
        wait_reason: row.get(16)?,
        created_at_ms: row.get(17)?,
        updated_at_ms: row.get(18)?,
    })
}

pub(crate) fn dispatch_waiting_executions(
    tx: &Connection,
    core_gen: &str,
    tracker: &ExecutorTracker,
    events: &mut Vec<EmittedEvent>,
    dispatches: &mut Vec<Value>,
) -> crate::Result<()> {
    crate::work_scheduler::promote_compatible_executions(tx, core_gen, tracker, events, dispatches)?;
    Ok(())
}

pub fn execute_execution_read(db: &Connection, execution_id: &str) -> crate::Result<Value> {
    let core_gen = current_core_generation();
    if !table_exists(db, "core_execution_runs")? {
        return Ok(json!({ "status": "not_found", "coreGeneration": core_gen, "execution": Value::Null }));
    }
    match fetch_execution(db, execution_id)? {
        Some(row) => Ok(json!({ "status": "ok", "coreGeneration": core_gen, "execution": row })),
        None => Ok(json!({ "status": "not_found", "coreGeneration": core_gen, "execution": Value::Null })),
    }
}

pub fn execute_ephemeral_progress(
    tracker: &ExecutorTracker,
    client: &ClientContext,
    execution_id: &str,
    attempt: i64,
    progress: Value,
    owner_generation: Option<&str>,
) -> crate::Result<Value> {
    let core_gen = current_core_generation();
    if let Some(rejection) = verify_executor_identity(client, &core_gen, owner_generation) {
        return Ok(rejection.data);
    }
    let Some(owner_gen) = tracker.verify_active_execution(execution_id, attempt, client.epoch) else {
        return Ok(json!({ "status": "rejected", "code": "STALE_EXECUTOR_OWNER" }));
    };
    let seq = EVENT_ID_SEQ.fetch_add(1, Ordering::AcqRel);
    let event = json!({
        "seq": 0,
        "ephemeral": true,
        "eventId": format!("stream-{}-{seq}", &core_gen[..core_gen.len().min(8)]),
        "coreGeneration": core_gen,
        "ownerGeneration": owner_gen,
        "domain": "execution",
        "kind": "execution.progress",
        "entityId": execution_id,
        "revision": 0,
        "payload": {
            "executionId": execution_id,
            "attempt": attempt,
            "progress": progress,
        },
        "createdAtMs": now_ms(),
    });
    EPHEMERAL_PROGRESS_EMITTED.fetch_add(1, Ordering::Relaxed);
    let _ = crate::request_control::emit(&json!({ "coreStreamEvent": event }));
    Ok(json!({ "status": "ok", "ephemeral": true, "coreGeneration": core_gen }))
}

pub fn execute_execution(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    req: ExecutionRequest,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    match req {
        ExecutionRequest::Status { execution_id } => {
            let data = execute_execution_read(db, &execution_id)?;
            Ok(WriteSideEffects {
                data,
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::Submit {
            execution_id,
            idempotency_key,
            task_id,
            kind,
            payload,
            owner_generation,
        } => {
            if execution_id.trim().is_empty() || idempotency_key.trim().is_empty() || task_id.trim().is_empty() {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "INVALID_REQUEST" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(existing) = fetch_execution_by_key(&tx, &idempotency_key)? {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "ok",
                        "deduplicated": true,
                        "coreGeneration": core_gen,
                        "execution": existing,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let queued_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM core_execution_runs WHERE status IN ('queued', 'waiting_executor', 'dispatching', 'running', 'pause_requested', 'cancel_requested')",
                [],
                |row| row.get(0),
            )?;
            if queued_count >= MAX_EXECUTION_QUEUE {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "OVERLOADED", "message": "execution queue limit reached" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let now = now_ms();
            let owner_gen = owner_generation.unwrap_or_else(|| client.generation.clone());
            let payload_val = payload.unwrap_or_else(|| json!({}));
            let initial_status = if tracker.is_online().is_some() && tracker.supports_kind(&kind) {
                "queued"
            } else {
                "waiting_executor"
            };
            tx.execute(
                "INSERT INTO core_execution_runs (
                   execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                   task_id, kind, payload_json, status, revision, created_at_ms, updated_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                params![
                    execution_id,
                    idempotency_key,
                    owner_gen,
                    client.role,
                    client.client_id,
                    client.epoch as i64,
                    task_id,
                    kind,
                    serde_json::to_string(&payload_val)?,
                    initial_status,
                    now,
                    now,
                ],
            )?;
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &owner_gen,
                "execution",
                if initial_status == "waiting_executor" {
                    "execution.waiting_executor"
                } else {
                    "execution.submitted"
                },
                &execution_id,
                1,
                Some(&idempotency_key),
                &json!({
                    "executionId": execution_id,
                    "taskId": task_id,
                    "kind": kind,
                    "status": initial_status,
                    "sourceRole": client.role,
                    "sourceClientId": client.client_id,
                }),
            )?];
            let mut dispatches = vec![];
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            let final_row = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({
                    "status": "ok",
                    "deduplicated": false,
                    "coreGeneration": core_gen,
                    "execution": final_row,
                }),
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::Pause {
            execution_id,
            expected_revision,
        } => transition_control_execution(
            db,
            tracker,
            &core_gen,
            &execution_id,
            expected_revision,
            "pause",
        ),
        ExecutionRequest::Cancel {
            execution_id,
            expected_revision,
        } => transition_control_execution(
            db,
            tracker,
            &core_gen,
            &execution_id,
            expected_revision,
            "cancel",
        ),
        ExecutionRequest::Resume {
            execution_id,
            expected_revision,
        } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(row) = fetch_execution(&tx, &execution_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if let Some(expected) = expected_revision
                && expected != row.revision
            {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "rejected",
                        "code": "REVISION_CONFLICT",
                        "actualRevision": row.revision,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if row.status != "paused" && row.status != "waiting_executor" {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "rejected",
                        "code": "INVALID_STATE",
                        "actualStatus": row.status,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = row.revision + 1;
            let next_status = if tracker.is_online().is_some() {
                "queued"
            } else {
                "waiting_executor"
            };
            let now = now_ms();
            tx.execute(
                "UPDATE core_execution_runs SET status = ?, revision = ?, wait_reason = NULL, updated_at_ms = ? WHERE execution_id = ?",
                params![next_status, next_rev, now, execution_id],
            )?;
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &row.owner_generation,
                "execution",
                "execution.resumed",
                &execution_id,
                next_rev,
                None,
                &json!({ "executionId": execution_id, "status": next_status }),
            )?];
            let mut dispatches = vec![];
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            let updated = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::ExecutorAck {
            execution_id,
            attempt,
            owner_generation,
            host_generation,
        } => {
            if let Some(rejection) = verify_executor_identity(client, &core_gen, owner_generation.as_deref()) {
                return Ok(rejection);
            }
            if let Some(rejection) = verify_host_generation(db, host_generation.as_deref()) {
                return Ok(rejection);
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(row) = fetch_execution(&tx, &execution_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if row.executor_epoch != Some(client.epoch as i64) || row.attempt != attempt {
                return Ok(WriteSideEffects {
                    data: json!({
                        "status": "rejected",
                        "code": "STALE_EXECUTOR_OWNER",
                        "expectedEpoch": row.executor_epoch,
                        "actualEpoch": client.epoch,
                        "expectedAttempt": row.attempt,
                        "actualAttempt": attempt,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if row.status != "dispatching" && row.status != "cancel_requested" && row.status != "pause_requested" {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "INVALID_STATE", "actualStatus": row.status }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_status = if row.status == "dispatching" { "running" } else { &row.status };
            let next_rev = row.revision + 1;
            let now = now_ms();
            tx.execute(
                "UPDATE core_execution_runs SET status = ?, revision = ?, wait_reason = NULL, updated_at_ms = ? WHERE execution_id = ?",
                params![next_status, next_rev, now, execution_id],
            )?;
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &row.owner_generation,
                "execution",
                "execution.running",
                &execution_id,
                next_rev,
                None,
                &json!({ "executionId": execution_id, "attempt": attempt, "status": next_status }),
            )?];
            crate::work_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &execution_id,
                next_status,
                None,
                None,
                now,
                &mut events,
            )?;
            let updated = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
                events,
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::ExecutorProgress {
            execution_id,
            attempt,
            progress,
            owner_generation,
            host_generation,
            ephemeral,
        } => {
            if let Some(rejection) = verify_host_generation(db, host_generation.as_deref()) {
                return Ok(rejection);
            }
            if ephemeral {
                let data = execute_ephemeral_progress(
                    tracker,
                    client,
                    &execution_id,
                    attempt,
                    progress,
                    owner_generation.as_deref(),
                )?;
                return Ok(WriteSideEffects {
                    data,
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(rejection) = verify_executor_identity(client, &core_gen, owner_generation.as_deref()) {
                return Ok(rejection);
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(row) = fetch_execution(&tx, &execution_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if row.executor_epoch != Some(client.epoch as i64) || row.attempt != attempt {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "STALE_EXECUTOR_OWNER" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = row.revision + 1;
            let now = now_ms();
            tx.execute(
                "UPDATE core_execution_runs SET revision = ?, updated_at_ms = ? WHERE execution_id = ?",
                params![next_rev, now, execution_id],
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &row.owner_generation,
                "execution",
                "execution.progress",
                &execution_id,
                next_rev,
                None,
                &json!({ "executionId": execution_id, "attempt": attempt, "progress": progress }),
            )?;
            let updated = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::ExecutorSettled {
            execution_id,
            attempt,
            status,
            result,
            error_message,
            owner_generation,
            host_generation,
        } => {
            if let Some(rejection) = verify_executor_identity(client, &core_gen, owner_generation.as_deref()) {
                return Ok(rejection);
            }
            if let Some(rejection) = verify_host_generation(db, host_generation.as_deref()) {
                return Ok(rejection);
            }
            if !matches!(status.as_str(), "completed" | "failed" | "cancelled" | "paused" | "unknown") {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "INVALID_STATE" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(row) = fetch_execution(&tx, &execution_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if row.executor_epoch != Some(client.epoch as i64) || row.attempt != attempt {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "STALE_EXECUTOR_OWNER" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = row.revision + 1;
            let now = now_ms();
            let result_json = result.as_ref().map(serde_json::to_string).transpose()?;
            tx.execute(
                "UPDATE core_execution_runs
                 SET status = ?, revision = ?, result_json = ?, error_message = ?, wait_reason = NULL, updated_at_ms = ?
                 WHERE execution_id = ?",
                params![status, next_rev, result_json, error_message, now, execution_id],
            )?;
            tracker.clear_active_execution(&execution_id);
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &row.owner_generation,
                "execution",
                &format!("execution.{status}"),
                &execution_id,
                next_rev,
                None,
                &json!({
                    "executionId": execution_id,
                    "attempt": attempt,
                    "status": status,
                    "result": result,
                    "errorMessage": error_message,
                }),
            )?];
            crate::work_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &execution_id,
                &status,
                result.as_ref(),
                error_message.as_deref(),
                now,
                &mut events,
            )?;
            crate::cron_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &row.owner_generation,
                &execution_id,
                &status,
                result.as_ref(),
                error_message.as_deref(),
                now,
                &mut events,
            )?;
            crate::dots_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &row.owner_generation,
                &execution_id,
                &status,
                now,
                &mut events,
            )?;
            crate::gateway_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &row.owner_generation,
                &execution_id,
                &status,
                now,
                &mut events,
            )?;
            crate::maintenance_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &row.owner_generation,
                &execution_id,
                &status,
                error_message.as_deref(),
                now,
                &mut events,
            )?;
            let mut dispatches = vec![];
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            let updated = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        ExecutionRequest::Reconcile {
            execution_id,
            status,
            expected_revision,
            attempt,
            result,
            error_message,
        } => {
            if !matches!(status.as_str(), "completed" | "failed" | "cancelled" | "paused" | "unknown" | "waiting_executor") {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "INVALID_STATE" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(row) = fetch_execution(&tx, &execution_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if let Some(expected) = expected_revision
                && expected != row.revision
            {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "REVISION_CONFLICT", "actualRevision": row.revision }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(att) = attempt
                && att != row.attempt
            {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "STALE_ATTEMPT", "actualAttempt": row.attempt }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let next_rev = row.revision + 1;
            let now = now_ms();
            let result_json = result.as_ref().map(serde_json::to_string).transpose()?;
            tx.execute(
                "UPDATE core_execution_runs
                 SET status = ?, revision = ?, result_json = COALESCE(?, result_json), error_message = ?, updated_at_ms = ?
                 WHERE execution_id = ?",
                params![status, next_rev, result_json, error_message, now, execution_id],
            )?;
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &row.owner_generation,
                "execution",
                "execution.reconciled",
                &execution_id,
                next_rev,
                None,
                &json!({ "executionId": execution_id, "status": status }),
            )?];
            let mut dispatches = vec![];
            if status == "waiting_executor" {
                dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            }
            let updated = fetch_execution(&tx, &execution_id)?.unwrap();
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
    }
}

fn verify_executor_identity(
    client: &ClientContext,
    core_gen: &str,
    owner_generation: Option<&str>,
) -> Option<WriteSideEffects> {
    if client.role != "execution-host" {
        return Some(WriteSideEffects {
            data: json!({ "status": "rejected", "code": "FORBIDDEN_ROLE", "role": client.role }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    if client.generation != core_gen
        || owner_generation.is_some_and(|supplied| supplied != core_gen)
    {
        return Some(WriteSideEffects {
            data: json!({ "status": "rejected", "code": "STALE_GENERATION", "coreGeneration": core_gen }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    None
}

fn verify_host_generation(
    db: &Connection,
    host_generation: Option<&str>,
) -> Option<WriteSideEffects> {
    let hg = host_generation?;
    if crate::pi_host_supervisor::is_generation_fenced(db, hg) {
        return Some(WriteSideEffects {
            data: json!({
                "status": "rejected",
                "code": "STALE_HOST_GENERATION",
                "hostGeneration": hg,
            }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    None
}

fn transition_control_execution(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    core_gen: &str,
    execution_id: &str,
    expected_revision: Option<i64>,
    action: &str,
) -> crate::Result<WriteSideEffects> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(row) = fetch_execution(&tx, execution_id)? else {
        return Ok(WriteSideEffects {
            data: json!({ "status": "rejected", "code": "NOT_FOUND" }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    };
    if let Some(expected) = expected_revision
        && expected != row.revision
    {
        return Ok(WriteSideEffects {
            data: json!({ "status": "rejected", "code": "REVISION_CONFLICT", "actualRevision": row.revision }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    let now = now_ms();
    let (next_status, notify_executor) = match (action, row.status.as_str()) {
        ("cancel", "queued" | "waiting_executor" | "paused") => ("cancelled", false),
        ("cancel", "dispatching" | "running" | "pause_requested") => ("cancel_requested", true),
        ("pause", "queued" | "waiting_executor") => ("paused", false),
        ("pause", "dispatching" | "running") => ("pause_requested", true),
        _ => {
            return Ok(WriteSideEffects {
                data: json!({ "status": "rejected", "code": "INVALID_STATE", "actualStatus": row.status }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            });
        }
    };
    let next_rev = row.revision + 1;
    tx.execute(
        "UPDATE core_execution_runs SET status = ?, revision = ?, wait_reason = NULL, updated_at_ms = ? WHERE execution_id = ?",
        params![next_status, next_rev, now, execution_id],
    )?;
    if matches!(next_status, "cancelled" | "paused") {
        tracker.clear_active_execution(execution_id);
    }
    let mut events = vec![append_event(
        &tx,
        core_gen,
        &row.owner_generation,
        "execution",
        &format!("execution.{next_status}"),
        execution_id,
        next_rev,
        None,
        &json!({ "executionId": execution_id, "status": next_status }),
    )?];
    let mut dispatches = vec![];
    if notify_executor && let Some((exec_epoch, _)) = tracker.is_online() {
        let updated = fetch_execution(&tx, execution_id)?.unwrap();
        dispatches.push(json!({
            "coreExecutionDispatch": {
                "targetRole": "execution-host",
                "targetEpoch": exec_epoch,
                "coreGeneration": core_gen,
                "action": action,
                "execution": updated,
            }
        }));
    } else if !notify_executor {
        dispatch_waiting_executions(&tx, core_gen, tracker, &mut events, &mut dispatches)?;
    }
    let updated = fetch_execution(&tx, execution_id)?.unwrap();
    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data: json!({ "status": "ok", "coreGeneration": core_gen, "execution": updated }),
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

pub fn handle_executor_presence(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    online: bool,
    epoch: u64,
    client_id: String,
    generation: String,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    tracker.set_presence(online, epoch, client_id.clone());
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut events = vec![];
    let mut dispatches = vec![];
    let now = now_ms();
    if !online {
        let mut stmt = tx.prepare(
            "SELECT execution_id, revision, owner_generation, attempt FROM core_execution_runs
             WHERE executor_epoch = ? AND status IN ('dispatching', 'running', 'pause_requested', 'cancel_requested')",
        )?;
        let rows: Vec<(String, i64, String, i64)> = stmt
            .query_map(params![epoch as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        for (execution_id, rev, owner_gen, attempt) in rows {
            let next_rev = rev + 1;
            tx.execute(
                "UPDATE core_execution_runs
                 SET status = 'unknown', revision = ?, error_message = 'executor disconnected while in flight', updated_at_ms = ?
                 WHERE execution_id = ?",
                params![next_rev, now, execution_id],
            )?;
            events.push(append_event(
                &tx,
                &core_gen,
                &owner_gen,
                "execution",
                "execution.unknown",
                &execution_id,
                next_rev,
                None,
                &json!({
                    "executionId": execution_id,
                    "attempt": attempt,
                    "reason": "executor_disconnected",
                    "disconnectedEpoch": epoch,
                    "generation": generation,
                }),
            )?);
            crate::work_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &execution_id,
                "unknown",
                None,
                Some("executor disconnected while in flight"),
                now,
                &mut events,
            )?;
            crate::cron_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &owner_gen,
                &execution_id,
                "unknown",
                None,
                Some("executor disconnected while in flight"),
                now,
                &mut events,
            )?;
            crate::dots_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &owner_gen,
                &execution_id,
                "unknown",
                now,
                &mut events,
            )?;
            crate::gateway_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &owner_gen,
                &execution_id,
                "unknown",
                now,
                &mut events,
            )?;
            crate::maintenance_scheduler::on_core_execution_state_change(
                &tx,
                &core_gen,
                &owner_gen,
                &execution_id,
                "unknown",
                Some("executor disconnected while in flight"),
                now,
                &mut events,
            )?;
        }
    } else {
        dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
    }
    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data: json!({ "status": "ok", "online": online }),
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

pub fn events_snapshot(db: &Connection, domain_filter: Option<&str>) -> crate::Result<Value> {
    let core_gen = current_core_generation();
    if !table_exists(db, "core_event_meta")? {
        return Ok(json!({
            "coreGeneration": core_gen,
            "headSeq": 0,
            "minAvailableSeq": 1,
            "notes": [],
            "executions": [],
            "lifecycle": read_current_lifecycle_json(),
        }));
    }
    let meta: Option<(String, i64, i64)> = db
        .query_row(
            "SELECT core_generation, min_available_seq, retention_limit FROM core_event_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (meta_gen, min_available_seq, retention_limit) =
        meta.unwrap_or_else(|| (core_gen.clone(), 1, DEFAULT_RETENTION_LIMIT));
    let head_seq: i64 = db.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM core_domain_events",
        [],
        |row| row.get(0),
    )?;
    let notes = if domain_filter.is_none() || domain_filter == Some("domainNote") {
        let mut stmt = db.prepare(
            "SELECT entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms
             FROM core_domain_notes ORDER BY entity_id ASC LIMIT 1024",
        )?;
        stmt.query_map([], |row| {
            let body_str: String = row.get(4)?;
            Ok(json!({
                "entityId": row.get::<_, String>(0)?,
                "ownerGeneration": row.get::<_, String>(1)?,
                "revision": row.get::<_, i64>(2)?,
                "title": row.get::<_, String>(3)?,
                "body": serde_json::from_str::<Value>(&body_str).unwrap_or(Value::Null),
                "deleted": row.get::<_, i64>(5)? != 0,
                "updatedAtMs": row.get::<_, i64>(6)?,
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        vec![]
    };
    let executions = if domain_filter.is_none() || domain_filter == Some("execution") {
        let mut stmt = db.prepare(
            "SELECT execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                    task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt,
                    result_json, error_message, wait_reason, created_at_ms, updated_at_ms
             FROM core_execution_runs ORDER BY created_at_ms DESC LIMIT 512",
        )?;
        stmt.query_map([], row_to_execution)?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    Ok(json!({
        "coreGeneration": meta_gen,
        "headSeq": head_seq,
        "minAvailableSeq": min_available_seq,
        "retentionLimit": retention_limit,
        "notes": notes,
        "executions": executions,
        "lifecycle": read_current_lifecycle_json(),
    }))
}

pub fn events_replay(
    db: &Connection,
    after_seq: i64,
    requested_generation: &str,
    limit: Option<usize>,
) -> crate::Result<Value> {
    let core_gen = current_core_generation();
    if !table_exists(db, "core_event_meta")? {
        if requested_generation != core_gen || after_seq > 0 {
            return Ok(json!({
                "gap": true,
                "reason": if requested_generation != core_gen { "generation_mismatch" } else { "cursor_ahead" },
                "coreGeneration": core_gen,
                "headSeq": 0,
                "minAvailableSeq": 1,
                "events": [],
            }));
        }
        return Ok(json!({
            "gap": false,
            "coreGeneration": core_gen,
            "headSeq": 0,
            "minAvailableSeq": 1,
            "events": [],
        }));
    }
    let (meta_gen, min_available_seq): (String, i64) = db
        .query_row(
            "SELECT core_generation, min_available_seq FROM core_event_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_else(|_| (core_gen.clone(), 1));
    let head_seq: i64 = db.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM core_domain_events",
        [],
        |row| row.get(0),
    )?;
    if requested_generation != meta_gen {
        return Ok(json!({
            "gap": true,
            "reason": "generation_mismatch",
            "coreGeneration": meta_gen,
            "headSeq": head_seq,
            "minAvailableSeq": min_available_seq,
            "events": [],
        }));
    }
    if after_seq < min_available_seq - 1 {
        return Ok(json!({
            "gap": true,
            "reason": "cursor_expired",
            "coreGeneration": meta_gen,
            "headSeq": head_seq,
            "minAvailableSeq": min_available_seq,
            "events": [],
        }));
    }
    if after_seq > head_seq {
        return Ok(json!({
            "gap": true,
            "reason": "cursor_ahead",
            "coreGeneration": meta_gen,
            "headSeq": head_seq,
            "minAvailableSeq": min_available_seq,
            "events": [],
        }));
    }
    let batch_limit = limit.unwrap_or(DEFAULT_REPLAY_LIMIT).clamp(1, 512) as i64;
    let mut stmt = db.prepare(
        "SELECT seq, event_id, core_generation, owner_generation, domain, kind, entity_id, revision, command_id, payload_json, created_at_ms
         FROM core_domain_events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    )?;
    let events = stmt
        .query_map(params![after_seq, batch_limit], |row| {
            let payload_str: String = row.get(9)?;
            Ok(EmittedEvent {
                seq: row.get(0)?,
                event_id: row.get(1)?,
                core_generation: row.get(2)?,
                owner_generation: row.get(3)?,
                domain: row.get(4)?,
                kind: row.get(5)?,
                entity_id: row.get(6)?,
                revision: row.get(7)?,
                command_id: row.get(8)?,
                payload: serde_json::from_str(&payload_str).unwrap_or(Value::Null),
                created_at_ms: row.get(10)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let has_more = events.last().is_some_and(|e| e.seq < head_seq);
    Ok(json!({
        "gap": false,
        "coreGeneration": meta_gen,
        "headSeq": head_seq,
        "minAvailableSeq": min_available_seq,
        "hasMore": has_more,
        "events": events,
    }))
}

fn read_current_lifecycle_json() -> Value {
    let dir = std::env::var_os(core_lease::DATA_DIRECTORY_ENV);
    let state = dir
        .map(|d| core_lease::read_lifecycle_state(Path::new(&d)))
        .unwrap_or_default();
    serde_json::to_value(state).unwrap_or(Value::Null)
}

pub fn handle_lifecycle(
    db: &mut Connection,
    client: &ClientContext,
    action: &str,
    resident_enabled: Option<bool>,
    autostart_enabled: Option<bool>,
    reason: Option<String>,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    let Some(data_dir_os) = std::env::var_os(core_lease::DATA_DIRECTORY_ENV) else {
        return Ok(WriteSideEffects {
            data: json!({ "status": "ok", "state": CoreLifecycleState::default() }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    };
    let data_dir = Path::new(&data_dir_os);
    let mut current = core_lease::read_lifecycle_state(data_dir);
    let mut shutdown = false;
    match action {
        "get" => {
            return Ok(WriteSideEffects {
                data: json!({
                    "status": "ok",
                    "state": current,
                    "coreStatus": core_lease::read_core_status(data_dir),
                }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            });
        }
        "stop" => {
            current.mode = "stopped_explicitly".to_owned();
            if let Some(v) = resident_enabled {
                current.resident_enabled = v;
            }
            if let Some(v) = autostart_enabled {
                current.autostart_enabled = v;
            }
            current.reason = reason.unwrap_or_else(|| "explicit_stop".to_owned());
            current.updated_at = core_lease::now_ms();
            core_lease::write_lifecycle_state(data_dir, &current)?;
            shutdown = true;
        }
        "activate" | "configure" => {
            if action == "activate" {
                current.mode = "active".to_owned();
            }
            if let Some(v) = resident_enabled {
                current.resident_enabled = v;
            }
            if let Some(v) = autostart_enabled {
                current.autostart_enabled = v;
            }
            current.reason = reason.unwrap_or_else(|| action.to_owned());
            current.updated_at = core_lease::now_ms();
            core_lease::write_lifecycle_state(data_dir, &current)?;
        }
        _ => {
            return Ok(WriteSideEffects {
                data: json!({ "status": "rejected", "code": "INVALID_REQUEST" }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            });
        }
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let ev = append_event(
        &tx,
        &core_gen,
        &client.generation,
        "lifecycle",
        &format!("assistantLifecycle.{action}"),
        "assistant",
        current.updated_at as i64,
        None,
        &json!({
            "mode": current.mode,
            "residentEnabled": current.resident_enabled,
            "autostartEnabled": current.autostart_enabled,
            "reason": current.reason,
        }),
    )?;
    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data: json!({
            "status": "ok",
            "state": current,
            "coreStatus": core_lease::read_core_status(data_dir),
        }),
        events: vec![ev],
        dispatches: vec![],
        shutdown_after_reply: shutdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        ensure_tables(&db, "gen-1").unwrap();
        db
    }

    #[test]
    fn offline_executor_stays_waiting_and_never_claims_running() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        let ui = ClientContext {
            epoch: 1,
            role: "ui".into(),
            client_id: "win-1".into(),
            generation: "gen-1".into(),
        };
        let submitted = execute_execution(
            &mut db,
            &tracker,
            &ui,
            ExecutionRequest::Submit {
                execution_id: "exec-1".into(),
                idempotency_key: "key-1".into(),
                task_id: "task-1".into(),
                kind: "pi_turn".into(),
                payload: Some(json!({ "text": "hello" })),
                owner_generation: None,
            },
        )
        .unwrap();
        assert_eq!(submitted.data["execution"]["status"], "waiting_executor");
        assert!(submitted.dispatches.is_empty());

        // Idempotent retry returns same execution without creating a duplicate.
        let dup = execute_execution(
            &mut db,
            &tracker,
            &ClientContext {
                epoch: 2,
                role: "ui".into(),
                client_id: "win-2".into(),
                generation: "gen-1".into(),
            },
            ExecutionRequest::Submit {
                execution_id: "exec-other".into(),
                idempotency_key: "key-1".into(),
                task_id: "task-1".into(),
                kind: "pi_turn".into(),
                payload: None,
                owner_generation: None,
            },
        )
        .unwrap();
        assert_eq!(dup.data["deduplicated"], true);
        assert_eq!(dup.data["execution"]["executionId"], "exec-1");
    }

    #[test]
    fn wrong_role_or_stale_epoch_cannot_settle_execution_and_disconnect_marks_unknown() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        let exec = ClientContext {
            epoch: 10,
            role: "execution-host".into(),
            client_id: "pi-1".into(),
            generation: current_core_generation(),
        };
        let presence = handle_executor_presence(
            &mut db,
            &tracker,
            true,
            10,
            "pi-1".into(),
            current_core_generation(),
        )
        .unwrap();
        assert_eq!(presence.data["online"], true);

        let ui = ClientContext {
            epoch: 11,
            role: "ui".into(),
            client_id: "ui-1".into(),
            generation: current_core_generation(),
        };
        let submitted = execute_execution(
            &mut db,
            &tracker,
            &ui,
            ExecutionRequest::Submit {
                execution_id: "exec-2".into(),
                idempotency_key: "key-2".into(),
                task_id: "task-2".into(),
                kind: "pi_turn".into(),
                payload: None,
                owner_generation: None,
            },
        )
        .unwrap();
        assert_eq!(submitted.data["execution"]["status"], "dispatching");
        assert_eq!(submitted.dispatches.len(), 1);

        // UI cannot acknowledge execution.
        let spoof = execute_execution(
            &mut db,
            &tracker,
            &ui,
            ExecutionRequest::ExecutorAck {
                execution_id: "exec-2".into(),
                attempt: 1,
                owner_generation: None,
                host_generation: None,
            },
        )
        .unwrap();
        assert_eq!(spoof.data["code"], "FORBIDDEN_ROLE");

        // Real executor acks -> running.
        let ack = execute_execution(
            &mut db,
            &tracker,
            &exec,
            ExecutionRequest::ExecutorAck {
                execution_id: "exec-2".into(),
                attempt: 1,
                owner_generation: None,
                host_generation: None,
            },
        )
        .unwrap();
        assert_eq!(ack.data["execution"]["status"], "running");

        // UI disconnect does NOT fail or cancel execution; only executor disconnect marks unknown.
        handle_executor_presence(
            &mut db,
            &tracker,
            false,
            10,
            "pi-1".into(),
            current_core_generation(),
        )
        .unwrap();
        let after = execute_execution_read(&db, "exec-2").unwrap();
        assert_eq!(after["execution"]["status"], "unknown");
    }

    #[test]
    fn bounded_event_retention_detects_cursor_gap_and_triggers_resync() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        let ui = ClientContext::synthetic(&current_core_generation());
        execute_command(&mut db, &tracker, &ui, CommandInput::SetEventRetention { limit: 2 }).unwrap();
        for i in 1..=5 {
            execute_command(
                &mut db,
                &tracker,
                &ui,
                CommandInput::UpsertNote {
                    command_id: format!("cmd-{i}"),
                    entity_id: format!("note-{i}"),
                    expected_revision: None,
                    owner_generation: None,
                    title: format!("Title {i}"),
                    body: Some(json!({ "n": i })),
                },
            )
            .unwrap();
        }
        let replay_stale = events_replay(&db, 1, &current_core_generation(), None).unwrap();
        assert_eq!(replay_stale["gap"], true);
        assert_eq!(replay_stale["reason"], "cursor_expired");

        let snap = events_snapshot(&db, Some("domainNote")).unwrap();
        assert_eq!(snap["headSeq"], 5);
        assert_eq!(snap["minAvailableSeq"], 4);
        let replay_valid = events_replay(&db, 3, &current_core_generation(), None).unwrap();
        assert_eq!(replay_valid["gap"], false);
        assert_eq!(replay_valid["events"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn ephemeral_progress_validates_active_execution_without_writing_sqlite_events() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        let core_gen = current_core_generation();
        let exec = ClientContext {
            epoch: 10,
            role: "execution-host".into(),
            client_id: "pi-eph".into(),
            generation: core_gen.clone(),
        };
        handle_executor_presence(&mut db, &tracker, true, 10, "pi-eph".into(), core_gen.clone())
            .unwrap();
        let ui = ClientContext {
            epoch: 11,
            role: "ui".into(),
            client_id: "ui-eph".into(),
            generation: core_gen.clone(),
        };
        execute_execution(
            &mut db,
            &tracker,
            &ui,
            ExecutionRequest::Submit {
                execution_id: "exec-eph-1".into(),
                idempotency_key: "key-eph-1".into(),
                task_id: "task-eph".into(),
                kind: "pi_turn".into(),
                payload: None,
                owner_generation: None,
            },
        )
        .unwrap();
        let ack = execute_execution(
            &mut db,
            &tracker,
            &exec,
            ExecutionRequest::ExecutorAck {
                execution_id: "exec-eph-1".into(),
                attempt: 1,
                owner_generation: None,
                host_generation: None,
            },
        )
        .unwrap();
        assert_eq!(ack.data["execution"]["status"], "running");

        let count_events = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM core_domain_events", [], |r| r.get(0))
                .unwrap()
        };
        let events_before = count_events(&db);
        let emitted_before = ephemeral_progress_emitted();

        let ok = execute_ephemeral_progress(
            &tracker,
            &exec,
            "exec-eph-1",
            1,
            json!({ "delta": "hi" }),
            None,
        )
        .unwrap();
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["ephemeral"], true);
        assert_eq!(ephemeral_progress_emitted(), emitted_before + 1);
        assert_eq!(count_events(&db), events_before);

        let wrong_attempt = execute_ephemeral_progress(
            &tracker,
            &exec,
            "exec-eph-1",
            2,
            json!({ "delta": "stale" }),
            None,
        )
        .unwrap();
        assert_eq!(wrong_attempt["code"], "STALE_EXECUTOR_OWNER");

        let wrong_epoch = execute_ephemeral_progress(
            &tracker,
            &ClientContext {
                epoch: 99,
                role: "execution-host".into(),
                client_id: "pi-eph".into(),
                generation: core_gen.clone(),
            },
            "exec-eph-1",
            1,
            json!({ "delta": "stale-epoch" }),
            None,
        )
        .unwrap();
        assert_eq!(wrong_epoch["code"], "STALE_EXECUTOR_OWNER");

        execute_execution(
            &mut db,
            &tracker,
            &exec,
            ExecutionRequest::ExecutorSettled {
                execution_id: "exec-eph-1".into(),
                attempt: 1,
                status: "completed".into(),
                result: Some(json!({ "ok": true })),
                error_message: None,
                owner_generation: None,
                host_generation: None,
            },
        )
        .unwrap();
        let after_settled = execute_ephemeral_progress(
            &tracker,
            &exec,
            "exec-eph-1",
            1,
            json!({ "delta": "late" }),
            None,
        )
        .unwrap();
        assert_eq!(after_settled["code"], "STALE_EXECUTOR_OWNER");
    }
}
