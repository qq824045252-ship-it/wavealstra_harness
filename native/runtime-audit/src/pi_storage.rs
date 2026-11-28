//! Native DuckDB persistence backend for Pi 1.5.0 `Storage` (`PI-01` .. `PI-07`, `CC-03`, `CC-08`).
//!
//! All logical Pi stores live inside `app.duckdb` partitioned by `store_id`.
//! Multi-store concurrency uses `ResourceKey::PiStore(store_id)` so distinct stores
//! commit concurrently while writes to the same store serialize and fence by
//! `writer_epoch` + `host_generation`.

use crate::database::row_bool;
use crate::Result;
use duckdb::types::ToSql;
use duckdb::{params, Connection, OptionalExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const PI_STORAGE_FORMAT: &str = "pi-durable-duckdb-v1";
const DEFAULT_LEASE_TTL_MS: i64 = 30_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    #[serde(flatten)]
    pub action: Action,
    operation_id: Option<String>,
    expected_incarnation: Option<String>,
}

impl Invocation {
    pub fn execute(self, db: &mut Connection) -> Result<Value> {
        if let Some(expected) = &self.expected_incarnation {
            let snapshot = db.transaction()?;
            let current = live_incarnation_key(&snapshot, self.action.store_id())?;
            if current.as_ref() != Some(expected) {
                return Ok(OpOutcome::fenced("Durable store was replaced or retired").into_json());
            }
            let data = execute_read(&snapshot, self.action)?.into_json();
            snapshot.rollback()?;
            return Ok(data);
        }
        Ok(execute_inner(db, self.action, self.operation_id.as_deref())?.into_json())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    ResolveStoreId {
        directory: String,
    },
    StoreInfo {
        store_id: String,
    },
    OpenWriter {
        store_id: String,
        host_generation: Option<String>,
        lease_holder: Option<String>,
        lease_ttl_ms: Option<i64>,
        expected_writer_epoch: Option<i64>,
        force_takeover: Option<bool>,
    },
    OpenReadOnly {
        store_id: String,
    },
    HeartbeatLease {
        store_id: String,
        writer_epoch: i64,
        host_generation: Option<String>,
        lease_holder: Option<String>,
        lease_ttl_ms: Option<i64>,
    },
    ReleaseLease {
        store_id: String,
        writer_epoch: i64,
        lease_holder: Option<String>,
    },
    PurgeStore {
        store_id: String,
        expected_writer_epoch: Option<i64>,
    },
    MintId {
        store_id: String,
        writer_epoch: i64,
        host_generation: Option<String>,
        /// 一次预留多少个 id（缺省 1）。批量发号让写者不必每条 id 单开一个事务。
        #[serde(default)]
        count: Option<i64>,
    },
    Commit {
        store_id: String,
        writer_epoch: i64,
        host_generation: Option<String>,
        batches: Vec<Vec<Value>>,
    },
    Conversation {
        store_id: String,
        id: i64,
    },
    ScanConversations {
        store_id: String,
        owner_conversation_id: Option<i64>,
        owner_task_id: Option<i64>,
        order: Option<String>,
        limit: Value,
        cursor: Option<Value>,
    },
    Entry {
        store_id: String,
        id: i64,
        conversation_id: Option<i64>,
    },
    FindLatestHeadMarker {
        store_id: String,
        conversation_id: i64,
        at_or_before_entry_id: Option<i64>,
    },
    ScanEntries {
        store_id: String,
        conversation_id: i64,
        min_entry_id: Option<i64>,
        max_entry_id: Option<i64>,
        order: Option<String>,
        limit: Value,
        cursor: Option<Value>,
    },
    Task {
        store_id: String,
        id: i64,
    },
    ScanTasks {
        store_id: String,
        conversation_id: Option<i64>,
        kind: Option<String>,
        status: Option<String>,
        abort_requested: Option<bool>,
        background: Option<bool>,
        order: Option<String>,
        limit: Value,
        cursor: Option<Value>,
    },
    Submission {
        store_id: String,
        id: i64,
    },
    ScanSubmissions {
        store_id: String,
        conversation_id: Option<i64>,
        status: Option<String>,
        order: Option<String>,
        limit: Value,
        cursor: Option<Value>,
    },
    SubmissionByRequest {
        store_id: String,
        conversation_id: i64,
        request_id: String,
    },
    FindDocument {
        store_id: String,
        address: Value,
        at: Value,
    },
    Document {
        store_id: String,
        id: i64,
        at: Value,
    },
    ScanDocuments {
        store_id: String,
        scope: Value,
        at: Value,
        kind: Option<String>,
        limit: Value,
        cursor: Option<Value>,
    },
}

impl Action {
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::ResolveStoreId { .. }
                | Self::StoreInfo { .. }
                | Self::OpenReadOnly { .. }
                | Self::Conversation { .. }
                | Self::ScanConversations { .. }
                | Self::Entry { .. }
                | Self::FindLatestHeadMarker { .. }
                | Self::ScanEntries { .. }
                | Self::Task { .. }
                | Self::ScanTasks { .. }
                | Self::Submission { .. }
                | Self::ScanSubmissions { .. }
                | Self::SubmissionByRequest { .. }
                | Self::FindDocument { .. }
                | Self::Document { .. }
                | Self::ScanDocuments { .. }
        )
    }

    pub fn store_id(&self) -> &str {
        match self {
            Self::ResolveStoreId { .. } => "",
            Self::StoreInfo { store_id }
            | Self::OpenWriter { store_id, .. }
            | Self::OpenReadOnly { store_id }
            | Self::HeartbeatLease { store_id, .. }
            | Self::ReleaseLease { store_id, .. }
            | Self::PurgeStore { store_id, .. }
            | Self::MintId { store_id, .. }
            | Self::Commit { store_id, .. }
            | Self::Conversation { store_id, .. }
            | Self::ScanConversations { store_id, .. }
            | Self::Entry { store_id, .. }
            | Self::FindLatestHeadMarker { store_id, .. }
            | Self::ScanEntries { store_id, .. }
            | Self::Task { store_id, .. }
            | Self::ScanTasks { store_id, .. }
            | Self::Submission { store_id, .. }
            | Self::ScanSubmissions { store_id, .. }
            | Self::SubmissionByRequest { store_id, .. }
            | Self::FindDocument { store_id, .. }
            | Self::Document { store_id, .. }
            | Self::ScanDocuments { store_id, .. } => store_id.as_str(),
        }
    }
}

enum OpOutcome {
    Ok(Value),
    AppError {
        kind: &'static str,
        message: String,
        detail: Option<Value>,
    },
}

impl OpOutcome {
    fn ok(data: Value) -> Self {
        Self::Ok(data)
    }

    fn request_error(message: impl Into<String>) -> Self {
        Self::AppError {
            kind: "request_error",
            message: message.into(),
            detail: None,
        }
    }

    fn fenced(message: impl Into<String>) -> Self {
        Self::AppError {
            kind: "fenced",
            message: message.into(),
            detail: None,
        }
    }

    fn owned(message: impl Into<String>, owner: Value) -> Self {
        Self::AppError {
            kind: "owned",
            message: message.into(),
            detail: Some(owner),
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self::AppError {
            kind: "fatal",
            message: message.into(),
            detail: None,
        }
    }

    fn into_json(self) -> Value {
        match self {
            Self::Ok(data) => json!({ "ok": true, "data": data }),
            Self::AppError {
                kind,
                message,
                detail,
            } => {
                let mut map = Map::new();
                map.insert("ok".to_string(), Value::Bool(false));
                map.insert("kind".to_string(), Value::String(kind.to_string()));
                map.insert("message".to_string(), Value::String(message));
                if let Some(detail) = detail {
                    map.insert("detail".to_string(), detail);
                }
                Value::Object(map)
            }
        }
    }
}

struct StoreRow {
    store_id: String,
    format: String,
    next_id: i64,
    commit_seq: i64,
    writer_epoch: i64,
    host_generation: Option<String>,
    lease_holder: Option<String>,
    lease_expires_at_ms: Option<i64>,
    retired: bool,
    created_at_ms: i64,
    updated_at_ms: i64,
    database_generation: Option<String>,
}

#[cfg(test)]
fn execute(db: &mut Connection, action: Action) -> Result<Value> {
    let outcome = execute_inner(db, action, None)?;
    Ok(outcome.into_json())
}

fn execute_inner(db: &mut Connection, action: Action, operation_id: Option<&str>) -> Result<OpOutcome> {
    match action {
        Action::OpenWriter {
            store_id,
            host_generation,
            lease_holder,
            lease_ttl_ms,
            expected_writer_epoch,
            force_takeover,
        } => open_writer(
            db,
            &store_id,
            host_generation,
            lease_holder,
            lease_ttl_ms,
            expected_writer_epoch,
            force_takeover.unwrap_or(false),
        ),
        Action::HeartbeatLease {
            store_id,
            writer_epoch,
            host_generation,
            lease_holder,
            lease_ttl_ms,
        } => heartbeat_lease(
            db,
            &store_id,
            writer_epoch,
            host_generation,
            lease_holder,
            lease_ttl_ms,
        ),
        Action::ReleaseLease {
            store_id,
            writer_epoch,
            lease_holder,
        } => release_lease(db, &store_id, writer_epoch, lease_holder),
        Action::PurgeStore {
            store_id,
            expected_writer_epoch,
        } => purge_store(db, &store_id, expected_writer_epoch),
        Action::MintId {
            store_id,
            writer_epoch,
            host_generation,
            count,
        } => mint_id(
            db,
            &store_id,
            writer_epoch,
            host_generation.as_deref(),
            operation_id,
            count,
        ),
        Action::Commit {
            store_id,
            writer_epoch,
            host_generation,
            batches,
        } => commit_batches(
            db,
            &store_id,
            writer_epoch,
            host_generation.as_deref(),
            batches,
            operation_id,
        ),
        read => execute_read(db, read),
    }
}

fn execute_read(db: &Connection, action: Action) -> Result<OpOutcome> {
    match action {
        Action::ResolveStoreId { directory } => {
            let store_id = crate::durable::store_id_for_path(Path::new(&directory));
            Ok(OpOutcome::ok(json!({ "storeId": store_id })))
        }
        Action::StoreInfo { store_id } => store_info(db, &store_id),
        Action::OpenReadOnly { store_id } => open_read_only(db, &store_id),
        Action::Conversation { store_id, id } => get_conversation(db, &store_id, id),
        Action::ScanConversations {
            store_id,
            owner_conversation_id,
            owner_task_id,
            order,
            limit,
            cursor,
        } => scan_conversations(
            db,
            &store_id,
            owner_conversation_id,
            owner_task_id,
            order.as_deref(),
            &limit,
            cursor.as_ref(),
        ),
        Action::Entry {
            store_id,
            id,
            conversation_id,
        } => get_entry(db, &store_id, id, conversation_id),
        Action::FindLatestHeadMarker {
            store_id,
            conversation_id,
            at_or_before_entry_id,
        } => find_latest_head_marker(db, &store_id, conversation_id, at_or_before_entry_id),
        Action::ScanEntries {
            store_id,
            conversation_id,
            min_entry_id,
            max_entry_id,
            order,
            limit,
            cursor,
        } => scan_entries(
            db,
            &store_id,
            conversation_id,
            min_entry_id,
            max_entry_id,
            order.as_deref(),
            &limit,
            cursor.as_ref(),
        ),
        Action::Task { store_id, id } => get_task(db, &store_id, id),
        Action::ScanTasks {
            store_id,
            conversation_id,
            kind,
            status,
            abort_requested,
            background,
            order,
            limit,
            cursor,
        } => scan_tasks(
            db,
            &store_id,
            conversation_id,
            kind.as_deref(),
            status.as_deref(),
            abort_requested,
            background,
            order.as_deref(),
            &limit,
            cursor.as_ref(),
        ),
        Action::Submission { store_id, id } => get_submission(db, &store_id, id),
        Action::ScanSubmissions {
            store_id,
            conversation_id,
            status,
            order,
            limit,
            cursor,
        } => scan_submissions(
            db,
            &store_id,
            conversation_id,
            status.as_deref(),
            order.as_deref(),
            &limit,
            cursor.as_ref(),
        ),
        Action::SubmissionByRequest {
            store_id,
            conversation_id,
            request_id,
        } => get_submission_by_request(db, &store_id, conversation_id, &request_id),
        Action::FindDocument {
            store_id,
            address,
            at,
        } => find_document(db, &store_id, &address, &at),
        Action::Document { store_id, id, at } => get_document(db, &store_id, id, &at),
        Action::ScanDocuments {
            store_id,
            scope,
            at,
            kind,
            limit,
            cursor,
        } => scan_documents(
            db,
            &store_id,
            &scope,
            &at,
            kind.as_deref(),
            &limit,
            cursor.as_ref(),
        ),
        _ => Err("Pi store write cannot run on a read snapshot".into()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_store_row(db: &Connection, store_id: &str) -> Result<Option<StoreRow>> {
    db.query_row(
        "SELECT store_id, format, next_id, commit_seq, writer_epoch, host_generation, lease_holder, lease_expires_at_ms, retired, created_at_ms, updated_at_ms,
                (SELECT database_generation FROM database_meta WHERE id = 1)
         FROM durable_stores WHERE store_id = ?1 LIMIT 1",
        params![store_id],
        |row| {
            Ok(StoreRow {
                store_id: row.get(0)?,
                format: row.get(1)?,
                next_id: row.get(2)?,
                commit_seq: row.get(3)?,
                writer_epoch: row.get(4)?,
                host_generation: row.get(5)?,
                lease_holder: row.get(6)?,
                lease_expires_at_ms: row.get(7)?,
                retired: row_bool(row, 8)?,
                created_at_ms: row.get(9)?,
                updated_at_ms: row.get(10)?,
                database_generation: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn incarnation_key(row: &StoreRow) -> String {
    format!("{}:{}:{}", row.database_generation.as_deref().unwrap_or_default(), row.store_id, row.created_at_ms)
}

pub(crate) fn live_incarnation_key(db: &Connection, store_id: &str) -> Result<Option<String>> {
    Ok(read_store_row(db, store_id)?.filter(|row| !row.retired).as_ref().map(incarnation_key))
}

fn store_row_to_json(row: &StoreRow) -> Value {
    json!({
        "exists": !row.retired,
        "storeId": row.store_id,
        "format": row.format,
        "nextId": row.next_id,
        "commitSeq": row.commit_seq,
        "writerEpoch": row.writer_epoch,
        "hostGeneration": row.host_generation,
        "leaseHolder": row.lease_holder,
        "leaseExpiresAtMs": row.lease_expires_at_ms,
        "retired": row.retired,
        "createdAtMs": row.created_at_ms,
        "updatedAtMs": row.updated_at_ms,
        "incarnationKey": incarnation_key(row),
    })
}

fn store_info(db: &Connection, store_id: &str) -> Result<OpOutcome> {
    if store_id.trim().is_empty() {
        return Ok(OpOutcome::request_error("storeId must be non-empty"));
    }
    match read_store_row(db, store_id)? {
        Some(row) if !row.retired => Ok(OpOutcome::ok(store_row_to_json(&row))),
        _ => Ok(OpOutcome::ok(json!({
            "exists": false,
            "storeId": store_id,
            "retired": false,
        }))),
    }
}

fn open_read_only(db: &Connection, store_id: &str) -> Result<OpOutcome> {
    if store_id.trim().is_empty() {
        return Ok(OpOutcome::request_error("storeId must be non-empty"));
    }
    match read_store_row(db, store_id)? {
        Some(row) if !row.retired => Ok(OpOutcome::ok(store_row_to_json(&row))),
        _ => Ok(OpOutcome::ok(json!({
            "exists": false,
            "storeId": store_id,
            "nextId": 1,
            "commitSeq": 0,
            "retired": false,
        }))),
    }
}

fn check_host_generation_not_fenced(db: &Connection, host_generation: Option<&str>) -> Result<Option<String>> {
    let Some(host_gen) = host_generation else {
        return Ok(None);
    };
    if crate::pi_host_supervisor::is_generation_fenced(db, host_gen) {
        return Ok(Some(format!("Host generation {host_gen} is fenced")));
    }
    Ok(None)
}

fn verify_writer_authority(
    db: &Connection,
    store_id: &str,
    writer_epoch: i64,
    host_generation: Option<&str>,
) -> Result<std::result::Result<StoreRow, OpOutcome>> {
    if let Some(reason) = check_host_generation_not_fenced(db, host_generation)? {
        return Ok(Err(OpOutcome::fenced(reason)));
    }
    let Some(row) = read_store_row(db, store_id)? else {
        return Ok(Err(OpOutcome::fenced(format!("Durable store {store_id} does not exist"))));
    };
    if row.retired {
        return Ok(Err(OpOutcome::fenced(format!("Durable store {store_id} is retired"))));
    }
    if row.writer_epoch != writer_epoch {
        return Ok(Err(OpOutcome::fenced(format!(
            "Durable store {store_id} writer epoch {writer_epoch} superseded by {}",
            row.writer_epoch
        ))));
    }
    if let Some(expected_gen) = host_generation {
        if row.host_generation.as_deref() != Some(expected_gen) {
            return Ok(Err(OpOutcome::fenced(format!(
                "Durable store {store_id} host generation {expected_gen} superseded by {:?}",
                row.host_generation
            ))));
        }
    }
    Ok(Ok(row))
}

fn run_in_tx<F>(db: &mut Connection, f: F) -> Result<OpOutcome>
where
    F: FnOnce(&duckdb::Transaction<'_>) -> Result<OpOutcome>,
{
    let tx = db.transaction()?;
    let outcome = f(&tx)?;
    crate::request_control::commit(tx)?;
    Ok(outcome)
}

struct MutationReceipt<'a> {
    scope: String,
    id: &'a str,
    hash: String,
}

impl<'a> MutationReceipt<'a> {
    fn new(id: &'a str, store_id: &str, request: &impl Serialize) -> Result<Self> {
        if id.is_empty() || id.len() > 128 {
            return Err("invalid Pi Storage operation identity".into());
        }
        Ok(Self {
            scope: format!("pi-store:{store_id}"),
            id,
            hash: format!("{:x}", Sha256::digest(serde_json::to_vec(request)?)),
        })
    }

    fn replay(&self, tx: &Connection) -> Result<Option<OpOutcome>> {
        let prior: Option<(String, String)> = tx.query_row(
            "SELECT request_hash, result_json FROM operation_receipts
             WHERE caller_scope = ?1 AND operation_id = ?2 AND batch_index = 0",
            params![self.scope, self.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        match prior {
            Some((hash, result)) if hash == self.hash => Ok(Some(OpOutcome::ok(serde_json::from_str(&result)?))),
            Some(_) => Ok(Some(OpOutcome::request_error("Pi Storage operation identity already used with a different request"))),
            None => Ok(None),
        }
    }

    fn save(&self, tx: &Connection, data: &Value, now: i64) -> Result<()> {
        tx.execute(
            "INSERT INTO operation_receipts (caller_scope, operation_id, batch_index, request_hash, status, result_json, created_at_ms)
             VALUES (?1, ?2, 0, ?3, 'committed', ?4, ?5)",
            params![self.scope, self.id, self.hash, serde_json::to_string(data)?, now],
        )?;
        Ok(())
    }
}

fn open_writer(
    db: &mut Connection,
    store_id: &str,
    host_generation: Option<String>,
    lease_holder: Option<String>,
    lease_ttl_ms: Option<i64>,
    expected_writer_epoch: Option<i64>,
    force_takeover: bool,
) -> Result<OpOutcome> {
    if store_id.trim().is_empty() {
        return Ok(OpOutcome::request_error("storeId must be non-empty"));
    }
    if let Some(reason) = check_host_generation_not_fenced(db, host_generation.as_deref())? {
        return Ok(OpOutcome::fenced(reason));
    }
    let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS).max(1_000);
    let now = now_ms();
    let expires_at = now.saturating_add(ttl);
    run_in_tx(db, |tx| {
        let existing = read_store_row(tx, store_id)?;
        match existing {
            None => {
                if let Some(expected) = expected_writer_epoch {
                    if expected != 0 {
                        return Ok(OpOutcome::fenced(format!(
                            "Durable store {store_id} missing for expected writer epoch {expected}"
                        )));
                    }
                }
                tx.execute(
                    "INSERT INTO durable_stores (store_id, format, next_id, commit_seq, writer_epoch, host_generation, lease_holder, lease_expires_at_ms, retired, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 2, 0, 1, ?3, ?4, ?5, FALSE, ?6, ?6)",
                    params![
                        store_id,
                        PI_STORAGE_FORMAT,
                        host_generation.as_deref(),
                        lease_holder.as_deref(),
                        lease_holder.as_ref().map(|_| expires_at),
                        now,
                    ],
                )?;
            }
            Some(row) if row.retired => {
                clear_store_children(tx, store_id)?;
                let new_epoch = row.writer_epoch.saturating_add(1);
                let created_at = now.max(row.created_at_ms.saturating_add(1));
                tx.execute(
                    "UPDATE durable_stores
                     SET format = ?2, next_id = 2, commit_seq = 0, writer_epoch = ?3,
                         host_generation = ?4, lease_holder = ?5, lease_expires_at_ms = ?6,
                         retired = FALSE, created_at_ms = ?7, updated_at_ms = ?8
                     WHERE store_id = ?1",
                    params![
                        store_id,
                        PI_STORAGE_FORMAT,
                        new_epoch,
                        host_generation.as_deref(),
                        lease_holder.as_deref(),
                        lease_holder.as_ref().map(|_| expires_at),
                        created_at,
                        now,
                    ],
                )?;
            }
            Some(row) => {
                if let Some(expected) = expected_writer_epoch {
                    if row.writer_epoch != expected {
                        return Ok(OpOutcome::fenced(format!(
                            "Durable store {store_id} expected writer epoch {expected}, found {}",
                            row.writer_epoch
                        )));
                    }
                }
                if !force_takeover {
                    if let (Some(holder), Some(exp)) = (&row.lease_holder, row.lease_expires_at_ms) {
                        let same_holder = lease_holder.as_deref() == Some(holder.as_str());
                        if !same_holder && exp > now {
                            return Ok(OpOutcome::owned(
                                format!("Durable store {store_id} is actively leased by {holder}"),
                                json!({
                                    "storeId": store_id,
                                    "holder": holder,
                                    "hostGeneration": row.host_generation,
                                    "leaseExpiresAtMs": exp,
                                    "writerEpoch": row.writer_epoch,
                                }),
                            ));
                        }
                    }
                }
                let new_epoch = row.writer_epoch.saturating_add(1);
                tx.execute(
                    "UPDATE durable_stores
                     SET writer_epoch = ?2, host_generation = ?3, lease_holder = ?4,
                         lease_expires_at_ms = ?5, updated_at_ms = ?6
                     WHERE store_id = ?1",
                    params![
                        store_id,
                        new_epoch,
                        host_generation.as_deref(),
                        lease_holder.as_deref(),
                        lease_holder.as_ref().map(|_| expires_at),
                        now,
                    ],
                )?;
            }
        }
        let updated = read_store_row(tx, store_id)?.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "durable store missing after open")
        })?;
        Ok(OpOutcome::ok(store_row_to_json(&updated)))
    })
}

fn heartbeat_lease(
    db: &mut Connection,
    store_id: &str,
    writer_epoch: i64,
    host_generation: Option<String>,
    lease_holder: Option<String>,
    lease_ttl_ms: Option<i64>,
) -> Result<OpOutcome> {
    let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS).max(1_000);
    let now = now_ms();
    let expires_at = now.saturating_add(ttl);
    run_in_tx(db, |tx| {
        let row = match verify_writer_authority(tx, store_id, writer_epoch, host_generation.as_deref())? {
            Ok(row) => row,
            Err(fenced) => return Ok(fenced),
        };
        if let Some(req_holder) = lease_holder.as_deref() {
            if let Some(existing_holder) = row.lease_holder.as_deref() {
                if existing_holder != req_holder {
                    return Ok(OpOutcome::fenced(format!(
                        "Durable store {store_id} lease holder mismatch"
                    )));
                }
            }
        }
        tx.execute(
            "UPDATE durable_stores SET lease_expires_at_ms = ?2, updated_at_ms = ?3 WHERE store_id = ?1 AND writer_epoch = ?4",
            params![store_id, expires_at, now, writer_epoch],
        )?;
        Ok(OpOutcome::ok(json!({
            "storeId": store_id,
            "writerEpoch": writer_epoch,
            "leaseExpiresAtMs": expires_at,
        })))
    })
}

fn release_lease(
    db: &mut Connection,
    store_id: &str,
    writer_epoch: i64,
    lease_holder: Option<String>,
) -> Result<OpOutcome> {
    let now = now_ms();
    run_in_tx(db, |tx| {
        let Some(row) = read_store_row(tx, store_id)? else {
            return Ok(OpOutcome::ok(json!({ "released": false })));
        };
        if row.retired || row.writer_epoch != writer_epoch {
            return Ok(OpOutcome::ok(json!({ "released": false })));
        }
        if let (Some(req), Some(cur)) = (lease_holder.as_deref(), row.lease_holder.as_deref()) {
            if req != cur {
                return Ok(OpOutcome::ok(json!({ "released": false })));
            }
        }
        tx.execute(
            "UPDATE durable_stores SET lease_holder = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?2
             WHERE store_id = ?1 AND writer_epoch = ?3",
            params![store_id, now, writer_epoch],
        )?;
        Ok(OpOutcome::ok(json!({ "released": true })))
    })
}

fn clear_store_children(tx: &Connection, store_id: &str) -> Result<()> {
    tx.execute("DELETE FROM operation_receipts WHERE caller_scope = ?1", [format!("pi-store:{store_id}")])?;
    for table in [
        "durable_document_revisions",
        "durable_documents",
        "durable_submissions",
        "durable_tasks",
        "durable_entries",
        "durable_conversations",
        "durable_request_keys",
        "durable_ids",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE store_id = ?1"), params![store_id])?;
    }
    Ok(())
}

fn purge_store(
    db: &mut Connection,
    store_id: &str,
    expected_writer_epoch: Option<i64>,
) -> Result<OpOutcome> {
    if store_id.trim().is_empty() {
        return Ok(OpOutcome::request_error("storeId must be non-empty"));
    }
    let now = now_ms();
    run_in_tx(db, |tx| {
        let existing = read_store_row(tx, store_id)?;
        if let (Some(expected), Some(row)) = (expected_writer_epoch, &existing) {
            if !row.retired && row.writer_epoch != expected {
                return Ok(OpOutcome::fenced(format!(
                    "Durable store {store_id} expected writer epoch {expected}, found {}",
                    row.writer_epoch
                )));
            }
        }
        retire_store_in_tx(tx, store_id, existing, now)?;
        Ok(OpOutcome::ok(json!({ "purged": true, "storeId": store_id })))
    })
}

pub(crate) fn retire_task_store_in_tx(tx: &Connection, directory: &std::path::Path) -> Result<()> {
    let store_id = crate::durable::store_id_for_path(directory);
    if store_id.is_empty() {
        return Err("Durable 会话目录为空，无法确认待删除的 store".into());
    }
    retire_store_in_tx(tx, &store_id, read_store_row(tx, &store_id)?, now_ms())
}

fn retire_store_in_tx(tx: &Connection, store_id: &str, existing: Option<StoreRow>, now: i64) -> Result<()> {
    clear_store_children(tx, store_id)?;
    if let Some(row) = existing {
        tx.execute(
            "UPDATE durable_stores
             SET retired = TRUE, writer_epoch = ?2, next_id = 2, commit_seq = 0,
                 host_generation = NULL, lease_holder = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?3
             WHERE store_id = ?1",
            params![store_id, row.writer_epoch.saturating_add(1), now],
        )?;
    }
    Ok(())
}

fn mint_id(
    db: &mut Connection,
    store_id: &str,
    writer_epoch: i64,
    host_generation: Option<&str>,
    operation_id: Option<&str>,
    count: Option<i64>,
) -> Result<OpOutcome> {
    let count = count.unwrap_or(1).clamp(1, 1_024);
    let receipt = operation_id
        .map(|id| MutationReceipt::new(id, store_id, &("mintId", writer_epoch, host_generation)))
        .transpose()?;
    let now = now_ms();
    run_in_tx(db, |tx| {
        let row = match verify_writer_authority(tx, store_id, writer_epoch, host_generation)? {
            Ok(row) => row,
            Err(fenced) => return Ok(fenced),
        };
        if let Some(receipt) = &receipt && let Some(prior) = receipt.replay(tx)? {
            return Ok(prior);
        }
        if row.next_id > MAX_SAFE_INTEGER - count {
            return Ok(OpOutcome::fatal("ID space is exhausted"));
        }
        let id = row.next_id;
        let next_id = id.saturating_add(count);
        tx.execute(
            "UPDATE durable_stores SET next_id = ?2, updated_at_ms = ?3 WHERE store_id = ?1",
            params![store_id, next_id, now],
        )?;
        let data = json!({ "id": id, "count": count });
        if let Some(receipt) = &receipt {
            receipt.save(tx, &data, now)?;
        }
        Ok(OpOutcome::ok(data))
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum ScopeKey {
    Session,
    Conversation(i64),
    Task(i64),
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct DocAddressKey {
    encoded_kind: String,
    scope: ScopeKey,
    doc_key: String,
}

#[derive(Clone)]
struct DocMeta {
    id: i64,
    encoded_kind: String,
    history: Option<String>,
    fork_mode: Option<String>,
    scope: ScopeKey,
    doc_key: String,
    created_at_seq: i64,
    retired_at_seq: Option<i64>,
    latest_version: i64,
}

enum ParsedWrite {
    Conversation {
        id: i64,
        parent_conversation_id: Option<i64>,
        parent_at_entry_id: Option<i64>,
        owner_conversation_id: Option<i64>,
        owner_task_id: Option<i64>,
        value: Value,
    },
    Entry {
        id: i64,
        conversation_id: i64,
        kind: String,
        has_head: bool,
        head_entry_id: Option<i64>,
        by_task_id: Option<i64>,
        value: Value,
    },
    Task {
        id: i64,
        conversation_id: i64,
        kind: String,
        status: String,
        abort_requested: bool,
        background: bool,
        value: Value,
    },
    Submission {
        id: i64,
        conversation_id: i64,
        request_id: Option<String>,
        status: String,
        value: Value,
    },
    DocCreate {
        id: i64,
        kind: String,
        scope: ScopeKey,
        doc_key: String,
        history: Option<String>,
        fork_mode: Option<String>,
        record: Value,
        version: i64,
        base_value: Value,
    },
    DocCopy {
        id: i64,
        kind: String,
        scope: ScopeKey,
        doc_key: String,
        history: Option<String>,
        fork_mode: Option<String>,
        record: Value,
        source_id: i64,
        source_at: DocPoint,
    },
    DocChange {
        id: i64,
        version: i64,
        content_kind: String,
        payload: Value,
    },
    DocRetire {
        id: i64,
    },
}

enum DocPoint {
    Current,
    Seq(i64),
}

fn parse_positive_id(value: Option<&Value>, label: &str) -> std::result::Result<i64, String> {
    let Some(v) = value else {
        return Err(format!("Missing {label}"));
    };
    let Some(n) = v.as_i64() else {
        return Err(format!("Invalid integer for {label}"));
    };
    if n < 1 || n > MAX_SAFE_INTEGER {
        return Err(format!("Out-of-range integer for {label}"));
    }
    Ok(n)
}

fn parse_doc_point_str(value: &Value) -> std::result::Result<DocPoint, String> {
    if let Some(s) = value.as_str() {
        if s == "current" {
            return Ok(DocPoint::Current);
        }
        return Err(format!("Invalid document point: {s}"));
    }
    parse_positive_id(Some(value), "document point").map(DocPoint::Seq)
}

fn parse_scope(value: Option<&Value>) -> std::result::Result<ScopeKey, String> {
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return Err("Invalid document scope".to_string());
    };
    match obj.get("kind").and_then(|v| v.as_str()) {
        Some("session") => Ok(ScopeKey::Session),
        Some("conversation") => {
            let cid = parse_positive_id(obj.get("conversationId"), "scope.conversationId")?;
            Ok(ScopeKey::Conversation(cid))
        }
        Some("task") => {
            let tid = parse_positive_id(obj.get("taskId"), "scope.taskId")?;
            Ok(ScopeKey::Task(tid))
        }
        _ => Err("Invalid document scope kind".to_string()),
    }
}

pub(crate) fn encode_indexed_str(s: &str) -> String {
    if !s.contains('\0') && !s.contains('%') {
        s.to_string()
    } else {
        s.replace('%', "%25").replace('\0', "%00")
    }
}

fn encode_doc_key(key: Option<&str>) -> String {
    match key {
        None => "S".to_string(),
        Some(k) => format!("K:{}", encode_indexed_str(k)),
    }
}

fn parse_write(raw: &Value) -> std::result::Result<ParsedWrite, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "StorageWrite must be an object".to_string())?;
    let wtype = obj
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "StorageWrite missing type".to_string())?;
    match wtype {
        "conversation" => {
            let val = obj
                .get("value")
                .ok_or_else(|| "Missing conversation value".to_string())?;
            let id = parse_positive_id(val.get("id"), "conversation.id")?;
            let parent_conversation_id = val
                .get("parent")
                .and_then(|p| p.get("conversationId"))
                .map(|v| parse_positive_id(Some(v), "parent.conversationId"))
                .transpose()?;
            let parent_at_entry_id = val
                .get("parent")
                .and_then(|p| p.get("at"))
                .map(|v| parse_positive_id(Some(v), "parent.at"))
                .transpose()?;
            let owner_conversation_id = val
                .get("owner")
                .and_then(|o| o.get("conversationId"))
                .map(|v| parse_positive_id(Some(v), "owner.conversationId"))
                .transpose()?;
            let owner_task_id = val
                .get("owner")
                .and_then(|o| o.get("taskId"))
                .map(|v| parse_positive_id(Some(v), "owner.taskId"))
                .transpose()?;
            Ok(ParsedWrite::Conversation {
                id,
                parent_conversation_id,
                parent_at_entry_id,
                owner_conversation_id,
                owner_task_id,
                value: val.clone(),
            })
        }
        "entry" => {
            let val = obj
                .get("value")
                .ok_or_else(|| "Missing entry value".to_string())?;
            let id = parse_positive_id(val.get("id"), "entry.id")?;
            let conversation_id =
                parse_positive_id(val.get("conversationId"), "entry.conversationId")?;
            let kind = val
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing entry.kind".to_string())?
                .to_string();
            let head_entry_id = match val.get("head") {
                None | Some(Value::Null) => None,
                Some(v) => Some(parse_positive_id(Some(v), "entry.head")?),
            };
            let by_task_id = match val.get("byTaskId") {
                None | Some(Value::Null) => None,
                Some(v) => Some(parse_positive_id(Some(v), "entry.byTaskId")?),
            };
            Ok(ParsedWrite::Entry {
                id,
                conversation_id,
                kind,
                has_head: head_entry_id.is_some(),
                head_entry_id,
                by_task_id,
                value: val.clone(),
            })
        }
        "task" => {
            let val = obj
                .get("value")
                .ok_or_else(|| "Missing task value".to_string())?;
            let id = parse_positive_id(val.get("id"), "task.id")?;
            let conversation_id =
                parse_positive_id(val.get("conversationId"), "task.conversationId")?;
            let kind = val
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing task.kind".to_string())?
                .to_string();
            let status = val
                .get("state")
                .and_then(|s| s.get("status"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing task.state.status".to_string())?
                .to_string();
            let abort_requested = val
                .get("abortRequested")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Missing task.abortRequested".to_string())?;
            let background = val
                .get("background")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Missing task.background".to_string())?;
            Ok(ParsedWrite::Task {
                id,
                conversation_id,
                kind,
                status,
                abort_requested,
                background,
                value: val.clone(),
            })
        }
        "submission" => {
            let val = obj
                .get("value")
                .ok_or_else(|| "Missing submission value".to_string())?;
            let id = parse_positive_id(val.get("id"), "submission.id")?;
            let conversation_id =
                parse_positive_id(val.get("conversationId"), "submission.conversationId")?;
            let request_id = val
                .get("requestId")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let status = val
                .get("status")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing submission.status".to_string())?
                .to_string();
            Ok(ParsedWrite::Submission {
                id,
                conversation_id,
                request_id,
                status,
                value: val.clone(),
            })
        }
        "document.create" => {
            let rec = obj
                .get("record")
                .ok_or_else(|| "Missing document.create record".to_string())?;
            let id = parse_positive_id(rec.get("id"), "record.id")?;
            let kind = rec
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing record.kind".to_string())?
                .to_string();
            let scope = parse_scope(rec.get("scope"))?;
            let key = rec.get("key").and_then(|v| v.as_str());
            let history = rec.get("history").and_then(|v| v.as_str()).map(ToOwned::to_owned);
            let fork_mode = rec.get("fork").and_then(|v| v.as_str()).map(ToOwned::to_owned);
            let content = obj
                .get("content")
                .ok_or_else(|| "Missing document.create content".to_string())?;
            let ckind = content.get("kind").and_then(|v| v.as_str());
            if ckind != Some("base") {
                return Err("document.create content must be base".to_string());
            }
            let version = parse_positive_id(content.get("version"), "content.version")?;
            let base_value = content
                .get("value")
                .filter(|v| v.is_object())
                .ok_or_else(|| "document.create content.value must be an object".to_string())?
                .clone();
            Ok(ParsedWrite::DocCreate {
                id,
                kind,
                scope,
                doc_key: encode_doc_key(key),
                history,
                fork_mode,
                record: rec.clone(),
                version,
                base_value,
            })
        }
        "document.copy" => {
            let rec = obj
                .get("record")
                .ok_or_else(|| "Missing document.copy record".to_string())?;
            let id = parse_positive_id(rec.get("id"), "record.id")?;
            let kind = rec
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing record.kind".to_string())?
                .to_string();
            let scope = parse_scope(rec.get("scope"))?;
            let key = rec.get("key").and_then(|v| v.as_str());
            let history = rec.get("history").and_then(|v| v.as_str()).map(ToOwned::to_owned);
            let fork_mode = rec.get("fork").and_then(|v| v.as_str()).map(ToOwned::to_owned);
            let source = obj
                .get("source")
                .ok_or_else(|| "Missing document.copy source".to_string())?;
            let source_id = parse_positive_id(source.get("id"), "source.id")?;
            let source_at = parse_doc_point_str(
                source
                    .get("at")
                    .ok_or_else(|| "Missing source.at".to_string())?,
            )?;
            Ok(ParsedWrite::DocCopy {
                id,
                kind,
                scope,
                doc_key: encode_doc_key(key),
                history,
                fork_mode,
                record: rec.clone(),
                source_id,
                source_at,
            })
        }
        "document.change" => {
            let id = parse_positive_id(obj.get("id"), "document.change.id")?;
            let content = obj
                .get("content")
                .ok_or_else(|| "Missing document.change content".to_string())?;
            let ckind = content
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing content.kind".to_string())?;
            let version = parse_positive_id(content.get("version"), "content.version")?;
            let payload = match ckind {
                "base" => content
                    .get("value")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| "document.change base missing object value".to_string())?
                    .clone(),
                "delta" => content
                    .get("ops")
                    .filter(|v| v.is_array())
                    .ok_or_else(|| "document.change delta missing ops array".to_string())?
                    .clone(),
                other => return Err(format!("Unsupported content.kind: {other}")),
            };
            Ok(ParsedWrite::DocChange {
                id,
                version,
                content_kind: ckind.to_string(),
                payload,
            })
        }
        "document.retire" => {
            let id = parse_positive_id(obj.get("id"), "document.retire.id")?;
            Ok(ParsedWrite::DocRetire { id })
        }
        other => Err(format!("Unsupported write type: {other}")),
    }
}

fn load_doc_meta(tx: &Connection, store_id: &str, doc_id: i64) -> Result<Option<DocMeta>> {
    let row = tx
        .query_row(
            "SELECT d.id, d.kind, d.history, d.fork_mode, d.scope_kind, d.scope_conversation_id, d.scope_task_id, d.doc_key, d.created_at_seq, d.retired_at_seq,
                    COALESCE((SELECT r.version FROM durable_document_revisions r WHERE r.store_id = d.store_id AND r.document_id = d.id ORDER BY r.seq DESC LIMIT 1), 0)
             FROM durable_documents d WHERE d.store_id = ?1 AND d.id = ?2 LIMIT 1",
            params![store_id, doc_id],
            |row| {
                let scope_kind: String = row.get(4)?;
                let conv_id: Option<i64> = row.get(5)?;
                let task_id: Option<i64> = row.get(6)?;
                let scope = match scope_kind.as_str() {
                    "session" => ScopeKey::Session,
                    "conversation" => ScopeKey::Conversation(conv_id.unwrap_or(0)),
                    "task" => ScopeKey::Task(task_id.unwrap_or(0)),
                    _ => ScopeKey::Session,
                };
                Ok(DocMeta {
                    id: row.get(0)?,
                    encoded_kind: row.get(1)?,
                    history: row.get(2)?,
                    fork_mode: row.get(3)?,
                    scope,
                    doc_key: row.get(7)?,
                    created_at_seq: row.get(8)?,
                    retired_at_seq: row.get(9)?,
                    latest_version: row.get(10)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

fn find_live_doc_at_address(
    tx: &Connection,
    store_id: &str,
    addr: &DocAddressKey,
) -> Result<Option<i64>> {
    match addr.scope {
        ScopeKey::Session => tx
            .query_row(
                "SELECT id FROM durable_documents
                 WHERE store_id = ?1 AND kind = ?2 AND scope_kind = 'session' AND scope_conversation_id IS NULL AND scope_task_id IS NULL AND doc_key = ?3 AND retired_at_seq IS NULL LIMIT 1",
                params![store_id, addr.encoded_kind, addr.doc_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into),
        ScopeKey::Conversation(cid) => tx
            .query_row(
                "SELECT id FROM durable_documents
                 WHERE store_id = ?1 AND kind = ?2 AND scope_kind = 'conversation' AND scope_conversation_id = ?3 AND doc_key = ?4 AND retired_at_seq IS NULL LIMIT 1",
                params![store_id, addr.encoded_kind, cid, addr.doc_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into),
        ScopeKey::Task(tid) => tx
            .query_row(
                "SELECT id FROM durable_documents
                 WHERE store_id = ?1 AND kind = ?2 AND scope_kind = 'task' AND scope_task_id = ?3 AND doc_key = ?4 AND retired_at_seq IS NULL LIMIT 1",
                params![store_id, addr.encoded_kind, tid, addr.doc_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into),
    }
}

fn materialize_doc_value(
    tx: &Connection,
    store_id: &str,
    doc_id: i64,
    up_to_seq: i64,
) -> Result<std::result::Result<(i64, Value), String>> {
    let base_seq: Option<i64> = tx
        .query_row(
            "SELECT MAX(seq) FROM durable_document_revisions
             WHERE store_id = ?1 AND document_id = ?2 AND seq <= ?3 AND content_kind = 'base'",
            params![store_id, doc_id, up_to_seq],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(base_seq) = base_seq else {
        return Ok(Err(format!("No base revision found for document {doc_id}")));
    };
    let mut stmt = tx.prepare(
        "SELECT version, content_kind, payload_json FROM durable_document_revisions
         WHERE store_id = ?1 AND document_id = ?2 AND seq >= ?3 AND seq <= ?4 ORDER BY seq ASC",
    )?;
    let mut rows = stmt.query(params![store_id, doc_id, base_seq, up_to_seq])?;
    let mut current: Option<(i64, Value)> = None;
    while let Some(row) = rows.next()? {
        let ver: i64 = row.get(0)?;
        let ckind: String = row.get(1)?;
        let payload_str: String = row.get(2)?;
        let payload: Value = serde_json::from_str(&payload_str)?;
        match ckind.as_str() {
            "base" => {
                current = Some((ver, payload));
            }
            "delta" => {
                let Some((_, mut val)) = current else {
                    return Ok(Err(format!("Delta without base for document {doc_id}")));
                };
                if let Err(err) = apply_chord_delta(&mut val, &payload) {
                    return Ok(Err(err));
                }
                current = Some((ver, val));
            }
            other => return Ok(Err(format!("Unknown revision kind: {other}"))),
        }
    }
    match current {
        Some((v, val)) => Ok(Ok((v, val))),
        None => Ok(Err(format!("Empty revision stream for document {doc_id}"))),
    }
}

// Mirror DuckDbStorage's wire encoding before applying UTF-16 string operations.
pub(crate) fn decode_pi_string(value: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{e000}' {
            match chars.peek().copied() {
                Some('\u{e000}') => {
                    chars.next();
                    units.push(0xe000);
                    continue;
                }
                Some(escaped @ '\u{e001}'..='\u{e800}') => {
                    chars.next();
                    units.push(escaped as u16 - 0x801);
                    continue;
                }
                _ => {}
            }
        }
        units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
    }
    units
}

pub(crate) fn encode_pi_string(units: Vec<u16>) -> String {
    let mut encoded = String::new();
    for character in char::decode_utf16(units) {
        match character {
            Ok('\u{e000}') => encoded.push_str("\u{e000}\u{e000}"),
            Ok(character) => encoded.push(character),
            Err(error) => {
                encoded.push('\u{e000}');
                encoded.push(char::from_u32(u32::from(error.unpaired_surrogate()) + 0x801)
                    .expect("escaped surrogate is in the private-use area"));
            }
        }
    }
    encoded
}

fn apply_chord_delta(root: &mut Value, ops_val: &Value) -> std::result::Result<(), String> {
    let ops = ops_val
        .as_array()
        .ok_or_else(|| "Delta ops must be an array".to_string())?;
    for op in ops {
        let arr = op
            .as_array()
            .ok_or_else(|| "Delta op must be a tuple array".to_string())?;
        let tag = arr
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Delta op missing tag".to_string())?;
        match tag {
            "r" => {
                let replacement = arr.get(1).ok_or_else(|| "r op missing value".to_string())?;
                *root = replacement.clone();
            }
            "s" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "s op missing path".to_string())?;
                let val = arr.get(2).ok_or_else(|| "s op missing value".to_string())?;
                if path.is_empty() {
                    *root = val.clone();
                } else {
                    let target = navigate_mut(root, &path[..path.len() - 1])?;
                    set_slot(target, &path[path.len() - 1], val.clone())?;
                }
            }
            "d" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "d op missing path".to_string())?;
                if path.is_empty() {
                    return Err("d op cannot target root".to_string());
                }
                let target = navigate_mut(root, &path[..path.len() - 1])?;
                let key = path[path.len() - 1]
                    .as_str()
                    .ok_or_else(|| "d op key must be string".to_string())?;
                if let Some(map) = target.as_object_mut() {
                    map.remove(key);
                }
            }
            "a" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "a op missing path".to_string())?;
                let suffix = arr
                    .get(2)
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "a op suffix must be string".to_string())?;
                let target = navigate_mut(root, path)?;
                let Some(s) = target.as_str() else {
                    return Err("a op target must be string".to_string());
                };
                let mut combined = String::with_capacity(s.len() + suffix.len());
                combined.push_str(s);
                combined.push_str(suffix);
                if s.contains('\u{e000}') && suffix.starts_with('\u{e000}') {
                    combined = encode_pi_string(decode_pi_string(&combined));
                }
                *target = Value::String(combined);
            }
            "t" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "t op missing path".to_string())?;
                let len = arr
                    .get(2)
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "t op len must be integer".to_string())? as usize;
                let target = navigate_mut(root, path)?;
                let Some(s) = target.as_str() else {
                    return Err("t op target must be string".to_string());
                };
                let mut units = decode_pi_string(s);
                units.truncate(len);
                *target = Value::String(encode_pi_string(units));
            }
            "p" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "p op missing path".to_string())?;
                let idx = arr
                    .get(2)
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "p op idx must be integer".to_string())? as usize;
                let del_count = arr
                    .get(3)
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "p op delCount must be integer".to_string())? as usize;
                let insert_items = arr
                    .get(4)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "p op items must be array".to_string())?;
                let target = navigate_mut(root, path)?;
                let Some(vec) = target.as_array_mut() else {
                    return Err("p op target must be array".to_string());
                };
                let start = idx.min(vec.len());
                let end = start.saturating_add(del_count).min(vec.len());
                vec.splice(start..end, insert_items.iter().cloned());
            }
            "m" => {
                let path = arr
                    .get(1)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "m op missing path".to_string())?;
                let perm = arr
                    .get(2)
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "m op perm must be array".to_string())?;
                let target = navigate_mut(root, path)?;
                let Some(vec) = target.as_array_mut() else {
                    return Err("m op target must be array".to_string());
                };
                if perm.len() != vec.len() {
                    return Err("m op permutation length mismatch".to_string());
                }
                let old = vec.clone();
                for (dest, src_v) in perm.iter().enumerate() {
                    let src_idx = src_v
                        .as_u64()
                        .ok_or_else(|| "m op index must be integer".to_string())? as usize;
                    let item = old
                        .get(src_idx)
                        .ok_or_else(|| "m op index out of bounds".to_string())?;
                    vec[dest] = item.clone();
                }
            }
            other => return Err(format!("Unsupported delta op: {other}")),
        }
    }
    Ok(())
}

fn navigate_mut<'a>(mut cur: &'a mut Value, path: &[Value]) -> std::result::Result<&'a mut Value, String> {
    for step in path {
        if let Some(key) = step.as_str() {
            cur = cur
                .as_object_mut()
                .and_then(|m| m.get_mut(key))
                .ok_or_else(|| format!("Delta path missing key: {key}"))?;
        } else if let Some(idx) = step.as_u64() {
            cur = cur
                .as_array_mut()
                .and_then(|a| a.get_mut(idx as usize))
                .ok_or_else(|| format!("Delta path missing index: {idx}"))?;
        } else {
            return Err("Delta path segment must be string or integer".to_string());
        }
    }
    Ok(cur)
}

fn set_slot(target: &mut Value, seg: &Value, val: Value) -> std::result::Result<(), String> {
    if let Some(key) = seg.as_str() {
        let map = target
            .as_object_mut()
            .ok_or_else(|| "s op target must be object".to_string())?;
        map.insert(key.to_string(), val);
        Ok(())
    } else if let Some(idx) = seg.as_u64() {
        let vec = target
            .as_array_mut()
            .ok_or_else(|| "s op target must be array".to_string())?;
        let i = idx as usize;
        if i > vec.len() {
            return Err(format!("s op array index {i} out of bounds"));
        }
        if i == vec.len() {
            vec.push(val);
        } else {
            vec[i] = val;
        }
        Ok(())
    } else {
        Err("s op path segment must be string or integer".to_string())
    }
}

fn stamp_created_and_retired(record: &Value, seq: i64, retired: bool) -> Value {
    let mut cloned = record.clone();
    if let Some(obj) = cloned.as_object_mut() {
        obj.insert("createdAt".to_string(), json!(seq));
        if retired {
            obj.insert("retiredAt".to_string(), json!(seq));
        } else {
            obj.remove("retiredAt");
        }
    }
    cloned
}

fn stamp_retired_at(record_json: &str, seq: i64) -> Result<String> {
    let mut parsed: Value = serde_json::from_str(record_json)?;
    if let Some(obj) = parsed.as_object_mut() {
        obj.insert("retiredAt".to_string(), json!(seq));
    }
    Ok(serde_json::to_string(&parsed)?)
}

fn commit_batches(
    db: &mut Connection,
    store_id: &str,
    writer_epoch: i64,
    host_generation: Option<&str>,
    batches: Vec<Vec<Value>>,
    operation_id: Option<&str>,
) -> Result<OpOutcome> {
    let receipt = operation_id
        .map(|id| MutationReceipt::new(id, store_id, &("commit", writer_epoch, host_generation, &batches)))
        .transpose()?;
    let now = now_ms();
    run_in_tx(db, |tx| {
        let store = match verify_writer_authority(tx, store_id, writer_epoch, host_generation)? {
            Ok(row) => row,
            Err(fenced) => return Ok(fenced),
        };
        if let Some(receipt) = &receipt && let Some(prior) = receipt.replay(tx)? {
            return Ok(prior);
        }
        let mut commit_seq = store.commit_seq;
        let mut max_id = store.next_id.saturating_sub(1);
        let mut seqs: Vec<i64> = Vec::with_capacity(batches.len());
        let mut refused: Option<String> = None;

        for batch in batches {
            if batch.is_empty() {
                refused = Some("Commit batch cannot be empty".to_string());
                break;
            }
            let guarded: Vec<_> = batch.iter().filter_map(dots_outbox_entry).collect();
            for (key, record) in &guarded {
                if !crate::dots_reply_data::commit_is_current(tx, store_id, key, record)? {
                    refused = Some(crate::dots_reply_data::REVOKED.to_string());
                    break;
                }
            }
            if refused.is_some() { break; }
            if !dots_cron_placements_current(tx, store_id, &batch)? {
                refused = Some("Dots 定时输入的授权已撤销或与已登记运行不一致".to_string());
                break;
            }
            if !crate::goal_continuation::placement_current(
                tx, store_id, store.created_at_ms, commit_seq, host_generation, &batch,
            )? {
                refused = Some("原目标或会话已变化，请重新发起目标续跑".to_string());
                break;
            }
            let goal_inputs = crate::goal_user_input::prepare(tx, store_id, &batch)?;
            match validate_and_apply_batch(tx, store_id, commit_seq + 1, &batch, &mut max_id)? {
                Ok(new_seq) => {
                    for (key, record) in guarded {
                        let entry_id = record["id"].as_i64().ok_or("Missing Dots reply entry id")?;
                        crate::dots_reply_data::finish_commit(tx, store_id, key, entry_id)?;
                    }
                    if !goal_inputs.is_empty() {
                        let incarnation = incarnation_key(&store);
                        let owner = store.host_generation.clone().unwrap_or_else(crate::business_protocol::current_core_generation);
                        for input in goal_inputs {
                            crate::goal_user_input::accept(tx, store_id, &incarnation, &owner, now, input)?;
                        }
                    }
                    commit_seq = new_seq;
                    seqs.push(new_seq);
                }
                Err(reason) => {
                    refused = Some(reason);
                    break;
                }
            }
        }

        if !seqs.is_empty() || max_id >= store.next_id {
            let next_id = store.next_id.max(max_id.saturating_add(1));
            tx.execute(
                "UPDATE durable_stores SET commit_seq = ?2, next_id = ?3, updated_at_ms = ?4 WHERE store_id = ?1",
                params![store_id, commit_seq, next_id, now],
            )?;
        }

        let mut payload = Map::new();
        payload.insert("stored".to_string(), json!(seqs.len()));
        payload.insert("seqs".to_string(), json!(seqs));
        if let Some(reason) = refused {
            payload.insert("refused".to_string(), Value::String(reason));
        }
        let data = Value::Object(payload);
        if let Some(receipt) = &receipt {
            receipt.save(tx, &data, now)?;
        }
        Ok(OpOutcome::ok(data))
    })
}

pub(crate) fn goal_user_input_task(write: &Value) -> Option<String> {
    crate::goal_user_input::resource_task(write)
}

fn dots_cron_input(write: &Value) -> Option<(&Value, &str)> {
    let value = &write["value"];
    if write["type"] != "submission" || value["type"] != "input"
        || !matches!(value["status"].as_str(), Some("queued" | "placed"))
    {
        return None;
    }
    let source = value["requestId"].as_str()?;
    crate::cron_scheduler::dots_run_id(source)?;
    Some((value, source))
}

pub(crate) fn is_dots_cron_input(write: &Value) -> bool {
    dots_cron_input(write).is_some()
}

fn dots_cron_placements_current(db: &Connection, store_id: &str, batch: &[Value]) -> Result<bool> {
    let mut submissions = batch.iter().filter_map(dots_cron_input).peekable();
    if submissions.peek().is_none() { return Ok(true); }
    let directory: Option<String> = db.query_row(
        "SELECT directory FROM durable_bot_bindings WHERE task_id=? AND backend='pi-durable'",
        [crate::DOTS_TASK_ID], |row| row.get(0),
    ).optional()?;
    if !directory.is_some_and(|path| crate::durable::store_id_for_path(Path::new(&path)) == store_id) {
        return Ok(true);
    }
    let mut sources = HashMap::new();
    for (submission, source) in submissions {
        let (Some(id), Some(conversation)) = (submission["id"].as_i64(), submission["conversationId"].as_i64()) else {
            return Ok(false);
        };
        let identity = (id, conversation);
        if sources.insert(source, identity).is_some_and(|prior| prior != identity)
            || !is_goal_input_conversation(db, store_id, conversation)?
        {
            return Ok(false);
        }
        let replay = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM durable_request_keys k JOIN durable_submissions s
              ON s.store_id=k.store_id AND s.id=k.submission_id
              WHERE k.store_id=?1 AND k.request_id=?2 AND (k.conversation_id<>?3 OR k.submission_id<>?4 OR s.status<>'queued'))",
            params![store_id, encode_indexed_str(source), conversation, id], |row| row.get::<_, bool>(0),
        )?;
        if replay { return Ok(false); }
        let text_hash = if submission["status"] == "placed" {
            let Some(entry_id) = submission["entry"].as_i64() else { return Ok(false); };
            let Some(entry) = batch.iter().find(|write| write["type"] == "entry" && write["value"]["id"] == entry_id) else {
                return Ok(false);
            };
            let record = &entry["value"];
            let input = &record["data"]["mybuddyInput"];
            if record["kind"] != "mybuddy.user" || record["conversationId"] != conversation || input["inputRequestId"] != source {
                return Ok(false);
            }
            let Some(text) = input["text"].as_str().and_then(|text| String::from_utf16(&decode_pi_string(text)).ok()) else {
                return Ok(false);
            };
            Some(crate::work_scheduler::sha256_hex(&text))
        } else { None };
        if crate::cron_scheduler::authorize_dots_run(db, source, &crate::cron_scheduler::DotsRunPurpose::Placement { text_hash })?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn is_goal_input_conversation(db: &Connection, store: &str, conversation: i64) -> Result<bool> {
    // Pi's root is record 1. MyBuddy can point the current conversation at a user-selected fork.
    const PI_ROOT_CONVERSATION: i64 = 1;
    let address = DocAddressKey { encoded_kind: "mybuddy.active-conversation".into(), scope: ScopeKey::Session,
        doc_key: encode_doc_key(None) };
    let active = match find_live_doc_at_address(db, store, &address)? {
        Some(id) => {
            let (_, pointer) = materialize_doc_value(db, store, id, i64::MAX)?
                .map_err(|reason| -> Box<dyn std::error::Error> { reason.into() })?;
            match pointer.get("conversationId") {
                Some(Value::Null) => Some(PI_ROOT_CONVERSATION),
                Some(value) => value.as_i64(),
                None => None,
            }
        }
        None => Some(PI_ROOT_CONVERSATION),
    };
    Ok(active == Some(conversation))
}

pub(crate) fn goal_live_run(
    db: &Connection,
    store: &str,
    conversation: i64,
) -> Result<Option<(i64, Vec<i64>)>> {
    let address = DocAddressKey {
        encoded_kind: "pi.live".into(),
        scope: ScopeKey::Conversation(conversation),
        doc_key: encode_doc_key(None),
    };
    let Some(id) = find_live_doc_at_address(db, store, &address)? else {
        return Ok(None);
    };
    let (_, live) = materialize_doc_value(db, store, id, i64::MAX)?
        .map_err(|reason| -> Box<dyn std::error::Error> { reason.into() })?;
    let Some(run) = live.get("run").filter(|run| !run.is_null()) else {
        return Ok(None);
    };
    let task = parse_positive_id(run.get("taskId"), "Pi live run task identity")?;
    let inputs = run["inputs"]
        .as_array()
        .filter(|inputs| !inputs.is_empty())
        .ok_or("Pi live run has no input identities")?
        .iter()
        .map(|id| parse_positive_id(Some(id), "Pi live run input identity"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Some((task, inputs)))
}

pub fn dots_outbox_entry(write: &Value) -> Option<(&str, &Value)> {
    let record = &write["value"];
    if write["type"] != "entry" || record["kind"] != crate::dots_reply_data::ENTRY_KIND { return None; }
    record["data"]["dotsOutboxEventKey"].as_str().map(|key| (key, record))
}

pub fn dots_delivery_entry(db: &Connection, store: &str, key: &str) -> Result<Option<Value>> {
    let address = DocAddressKey { encoded_kind: "mybuddy.dots-delivery-receipts".into(), scope: ScopeKey::Session, doc_key: encode_doc_key(Some(key)) };
    let Some(doc_id) = find_live_doc_at_address(db, store, &address)? else { return Ok(None); };
    let (_, value) = materialize_doc_value(db, store, doc_id, i64::MAX)?.map_err(|reason| -> Box<dyn std::error::Error> { reason.into() })?;
    let Some(entry_id) = value["entryId"].as_i64() else { return Ok(None); };
    let record: Option<String> = db.query_row("SELECT record_json FROM durable_entries WHERE store_id=? AND id=? AND kind=?",
        params![store,entry_id,crate::dots_reply_data::ENTRY_KIND], |r| r.get(0)).optional()?;
    let record = serde_json::from_str::<Value>(&record.ok_or("Dots receipt points outside its original conversation store")?)?;
    if record["data"]["deliveryKey"] != key { return Err("Dots receipt has a different delivery identity".into()); }
    Ok(Some(record))
}

pub struct DotsProactiveReceipt {
    pub entry_id: i64,
    pub text: String,
    pub workspace: Option<String>,
}

pub fn dots_proactive_receipt(db: &Connection, store: &str, key: &str) -> Result<Option<DotsProactiveReceipt>> {
    let encoded_key = encode_pi_string(key.encode_utf16().collect());
    let address = DocAddressKey {
        encoded_kind: "mybuddy.dots-proactive-receipt".into(),
        scope: ScopeKey::Session,
        doc_key: encode_doc_key(Some(&encoded_key)),
    };
    let Some(doc_id) = find_live_doc_at_address(db, store, &address)? else { return Ok(None); };
    let (_, value) = materialize_doc_value(db, store, doc_id, i64::MAX)?
        .map_err(|reason| -> Box<dyn std::error::Error> { reason.into() })?;
    let Some(entry_id) = value["entryId"].as_i64() else { return Ok(None); };
    let raw: Option<String> = db.query_row("SELECT record_json FROM durable_entries WHERE store_id=? AND id=? AND kind='mybuddy.dots-proactive'",
        params![store, entry_id], |row| row.get(0)).optional()?;
    let record: Value = serde_json::from_str(&raw.ok_or("Dots proactive receipt points outside its conversation store")?)?;
    let data = &record["data"];
    if data["key"] != encoded_key || data["deliveredAt"].as_i64().is_none_or(|at| at <= 0) {
        return Err("Dots proactive receipt has a different delivery identity".into());
    }
    let text = String::from_utf16(&decode_pi_string(
        data["text"].as_str().ok_or("Dots proactive receipt has no text")?,
    ))?;
    let workspace = value["workspace"].as_str().map(|path| String::from_utf16(&decode_pi_string(path))).transpose()?;
    Ok(Some(DotsProactiveReceipt { entry_id, text, workspace }))
}

struct PendingDocContent {
    version: i64,
    kind: String,
    payload: Value,
}

struct PendingDocCreate {
    kind: String,
    scope: ScopeKey,
    doc_key: String,
    history: Option<String>,
    fork_mode: Option<String>,
    record: Value,
}

struct PendingDocAction {
    create: Option<PendingDocCreate>,
    copy: Option<(i64, DocPoint)>,
    content: Option<PendingDocContent>,
    retire: bool,
}

fn validate_and_apply_batch(
    tx: &Connection,
    store_id: &str,
    batch_seq: i64,
    raw_writes: &[Value],
    max_seen_id: &mut i64,
) -> Result<std::result::Result<i64, String>> {
    let mut writes = Vec::with_capacity(raw_writes.len());
    for raw in raw_writes {
        match parse_write(raw) {
            Ok(w) => writes.push(w),
            Err(reason) => return Ok(Err(reason)),
        }
    }

    // Step 1: check global ID ownership & immutability
    let mut batch_ids: HashMap<i64, &'static str> = HashMap::new();
    let mut batch_max_id = *max_seen_id;

    for w in &writes {
        let id_info: Option<(i64, &'static str, bool)> = match w {
            ParsedWrite::Conversation { id, .. } => Some((*id, "conversation", false)),
            ParsedWrite::Entry { id, .. } => Some((*id, "entry", false)),
            ParsedWrite::Task { id, .. } => Some((*id, "task", true)),
            ParsedWrite::Submission { id, .. } => Some((*id, "submission", true)),
            ParsedWrite::DocCreate { id, .. } | ParsedWrite::DocCopy { id, .. } => {
                Some((*id, "document", false))
            }
            ParsedWrite::DocChange { id, .. } | ParsedWrite::DocRetire { id } => {
                batch_max_id = batch_max_id.max(*id);
                None
            }
        };

        if let Some((id, kind, mutable)) = id_info {
            batch_max_id = batch_max_id.max(id);
            let existing: Option<String> = tx
                .query_row(
                    "SELECT record_kind FROM durable_ids WHERE store_id = ?1 AND id = ?2 LIMIT 1",
                    params![store_id, id],
                    |r| r.get(0),
                )
                .optional()?;
            let earlier = batch_ids.get(&id).copied();
            if !mutable {
                if let Some(existing_kind) = existing {
                    return Ok(Err(format!("ID {id} already belongs to {existing_kind}")));
                }
                if let Some(prev_kind) = earlier {
                    if prev_kind == kind {
                        return Ok(Err(format!("ID {id} is written more than once")));
                    }
                    return Ok(Err(format!("ID {id} is written as two record types")));
                }
            } else {
                if let Some(existing_kind) = existing {
                    if existing_kind != kind {
                        return Ok(Err(format!("ID {id} already belongs to {existing_kind}")));
                    }
                }
                if let Some(prev_kind) = earlier {
                    if prev_kind != kind {
                        return Ok(Err(format!("ID {id} is written as two record types")));
                    }
                }
            }
            batch_ids.insert(id, kind);
        }
    }

    // Step 2: prepare collapsed document actions (order-independent per doc_id)
    let mut actions: HashMap<i64, PendingDocAction> = HashMap::new();
    let mut action_order: Vec<i64> = Vec::new();
    for w in &writes {
        match w {
            ParsedWrite::DocCreate {
                id,
                kind,
                scope,
                doc_key,
                history,
                fork_mode,
                record,
                version,
                base_value,
            } => {
                if !actions.contains_key(id) {
                    action_order.push(*id);
                }
                let action = actions.entry(*id).or_insert(PendingDocAction {
                    create: None,
                    copy: None,
                    content: None,
                    retire: false,
                });
                if action.create.is_some() || action.content.is_some() || action.copy.is_some() {
                    return Ok(Err(format!("Document {id} has more than one content command")));
                }
                action.create = Some(PendingDocCreate {
                    kind: kind.clone(),
                    scope: *scope,
                    doc_key: doc_key.clone(),
                    history: history.clone(),
                    fork_mode: fork_mode.clone(),
                    record: record.clone(),
                });
                action.content = Some(PendingDocContent {
                    version: *version,
                    kind: "base".to_string(),
                    payload: base_value.clone(),
                });
            }
            ParsedWrite::DocCopy {
                id,
                kind,
                scope,
                doc_key,
                history,
                fork_mode,
                record,
                source_id,
                source_at,
            } => {
                if !actions.contains_key(id) {
                    action_order.push(*id);
                }
                let action = actions.entry(*id).or_insert(PendingDocAction {
                    create: None,
                    copy: None,
                    content: None,
                    retire: false,
                });
                if action.create.is_some() || action.content.is_some() || action.copy.is_some() {
                    return Ok(Err(format!("Document {id} has more than one content command")));
                }
                action.create = Some(PendingDocCreate {
                    kind: kind.clone(),
                    scope: *scope,
                    doc_key: doc_key.clone(),
                    history: history.clone(),
                    fork_mode: fork_mode.clone(),
                    record: record.clone(),
                });
                let cloned_pt = match source_at {
                    DocPoint::Current => DocPoint::Current,
                    DocPoint::Seq(s) => DocPoint::Seq(*s),
                };
                action.copy = Some((*source_id, cloned_pt));
            }
            ParsedWrite::DocChange {
                id,
                version,
                content_kind,
                payload,
            } => {
                if !actions.contains_key(id) {
                    action_order.push(*id);
                }
                let action = actions.entry(*id).or_insert(PendingDocAction {
                    create: None,
                    copy: None,
                    content: None,
                    retire: false,
                });
                if action.content.is_some() || action.copy.is_some() {
                    return Ok(Err(format!("Document {id} has more than one content command")));
                }
                action.content = Some(PendingDocContent {
                    version: *version,
                    kind: content_kind.clone(),
                    payload: payload.clone(),
                });
            }
            ParsedWrite::DocRetire { id } => {
                if !actions.contains_key(id) {
                    action_order.push(*id);
                }
                let action = actions.entry(*id).or_insert(PendingDocAction {
                    create: None,
                    copy: None,
                    content: None,
                    retire: false,
                });
                if action.retire {
                    return Ok(Err(format!("Document {id} is retired more than once")));
                }
                action.retire = true;
            }
            _ => {}
        }
    }

    // Step 3: check document actions & address uniqueness (order-independent)
    let mut existing_metas: HashMap<i64, Option<DocMeta>> = HashMap::new();
    let mut live_counts: HashMap<DocAddressKey, i32> = HashMap::new();
    for &id in &action_order {
        let action = &actions[&id];
        if let Some((src_id, _)) = &action.copy {
            if actions.contains_key(src_id) {
                return Ok(Err(format!(
                    "Document copy {id} source is changed in the copy batch"
                )));
            }
        }
        let existing = load_doc_meta(tx, store_id, id)?;
        if action.create.is_none() && existing.is_none() {
            return Ok(Err(format!("Unknown document: {id}")));
        }
        if action.create.is_some() && existing.is_some() {
            return Ok(Err(format!("Document {id} already exists")));
        }
        if existing.as_ref().is_some_and(|e| e.retired_at_seq.is_some()) {
            return Ok(Err(format!("Document {id} is retired")));
        }
        if let Some(content) = &action.content {
            if content.kind == "delta" {
                let prev_ver = existing.as_ref().map(|e| e.latest_version).unwrap_or(0);
                if prev_ver == 0 {
                    return Ok(Err(format!("Document {id} delta has no base")));
                }
                if prev_ver != content.version {
                    return Ok(Err(format!(
                        "Document {id} version transition requires a base"
                    )));
                }
            }
        }
        let addr = if let Some(create) = &action.create {
            DocAddressKey {
                encoded_kind: encode_indexed_str(&create.kind),
                scope: create.scope,
                doc_key: create.doc_key.clone(),
            }
        } else {
            let ex = existing.as_ref().unwrap();
            DocAddressKey {
                encoded_kind: ex.encoded_kind.clone(),
                scope: ex.scope,
                doc_key: ex.doc_key.clone(),
            }
        };
        let mut live = match live_counts.get(&addr) {
            Some(&n) => n,
            None => {
                if find_live_doc_at_address(tx, store_id, &addr)?.is_some() {
                    1
                } else {
                    0
                }
            }
        };
        if action.retire && existing.is_some() {
            live -= 1;
        }
        if action.create.is_some() && !action.retire {
            live += 1;
        }
        live_counts.insert(addr, live);
        existing_metas.insert(id, existing);
    }
    for &live in live_counts.values() {
        if live > 1 {
            return Ok(Err(
                "Document address already has a current incarnation".to_string()
            ));
        }
    }

    // Step 4: resolve document copies against committed state before this batch
    for &id in &action_order {
        let copy_info = actions[&id].copy.as_ref().map(|(s, pt)| {
            (
                *s,
                match pt {
                    DocPoint::Current => DocPoint::Current,
                    DocPoint::Seq(seq) => DocPoint::Seq(*seq),
                },
            )
        });
        let Some((src_id, src_at)) = copy_info else {
            continue;
        };
        let create = actions[&id].create.as_ref().unwrap();
        let Some(src_meta) = load_doc_meta(tx, store_id, src_id)? else {
            return Ok(Err(format!("Fork source document {src_id} cannot be read")));
        };
        if !matches!(src_meta.scope, ScopeKey::Conversation(_))
            || !matches!(create.scope, ScopeKey::Conversation(_))
            || src_meta.encoded_kind != encode_indexed_str(&create.kind)
            || src_meta.doc_key != create.doc_key
            || src_meta.history != create.history
            || src_meta.fork_mode != create.fork_mode
        {
            return Ok(Err(format!(
                "Fork source document {src_id} does not match the copied record"
            )));
        }
        let target_seq = match src_at {
            DocPoint::Current => {
                if src_meta.retired_at_seq.is_some() {
                    return Ok(Err(format!("Fork source document {src_id} cannot be read")));
                }
                i64::MAX
            }
            DocPoint::Seq(seq) => {
                if src_meta.history.as_deref() != Some("rewindable") {
                    return Ok(Err(format!(
                        "Document {src_id} does not retain historical content"
                    )));
                }
                if seq < src_meta.created_at_seq
                    || src_meta.retired_at_seq.map_or(false, |r| seq >= r)
                {
                    return Ok(Err(format!("Fork source document {src_id} cannot be read")));
                }
                seq
            }
        };
        let (ver, val) = match materialize_doc_value(tx, store_id, src_id, target_seq)? {
            Ok(pair) => pair,
            Err(msg) => return Ok(Err(msg)),
        };
        if let Some(action) = actions.get_mut(&id) {
            action.content = Some(PendingDocContent {
                version: ver,
                kind: "base".to_string(),
                payload: val,
            });
        }
    }

    // Step 5: apply validated table writes
    for w in writes {
        match w {
            ParsedWrite::Conversation {
                id,
                parent_conversation_id,
                parent_at_entry_id,
                owner_conversation_id,
                owner_task_id,
                value,
            } => {
                insert_id_if_new(tx, store_id, id, "conversation", batch_seq)?;
                let json_str = serde_json::to_string(&value)?;
                tx.execute(
                    "INSERT INTO durable_conversations (store_id, id, parent_conversation_id, parent_at_entry_id, owner_conversation_id, owner_task_id, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        store_id,
                        id,
                        parent_conversation_id,
                        parent_at_entry_id,
                        owner_conversation_id,
                        owner_task_id,
                        json_str,
                    ],
                )?;
            }
            ParsedWrite::Entry {
                id,
                conversation_id,
                kind,
                has_head,
                head_entry_id,
                by_task_id,
                value,
            } => {
                insert_id_if_new(tx, store_id, id, "entry", batch_seq)?;
                let json_str = serde_json::to_string(&value)?;
                let encoded_kind = encode_indexed_str(&kind);
                tx.execute(
                    "INSERT INTO durable_entries (store_id, id, conversation_id, kind, has_head, head_entry_id, by_task_id, commit_seq, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        store_id,
                        id,
                        conversation_id,
                        encoded_kind,
                        has_head,
                        head_entry_id,
                        by_task_id,
                        batch_seq,
                        json_str,
                    ],
                )?;
            }
            ParsedWrite::Task {
                id,
                conversation_id,
                kind,
                status,
                abort_requested,
                background,
                value,
            } => {
                insert_id_if_new(tx, store_id, id, "task", batch_seq)?;
                let json_str = serde_json::to_string(&value)?;
                let encoded_kind = encode_indexed_str(&kind);
                tx.execute(
                    "DELETE FROM durable_tasks WHERE store_id = ?1 AND id = ?2",
                    params![store_id, id],
                )?;
                tx.execute(
                    "INSERT INTO durable_tasks (store_id, id, conversation_id, kind, status, abort_requested, background, commit_seq, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        store_id,
                        id,
                        conversation_id,
                        encoded_kind,
                        status,
                        abort_requested,
                        background,
                        batch_seq,
                        json_str,
                    ],
                )?;
            }
            ParsedWrite::Submission {
                id,
                conversation_id,
                request_id,
                status,
                value,
            } => {
                insert_id_if_new(tx, store_id, id, "submission", batch_seq)?;
                let json_str = serde_json::to_string(&value)?;
                let encoded_req = request_id.as_deref().map(encode_indexed_str);
                tx.execute(
                    "DELETE FROM durable_submissions WHERE store_id = ?1 AND id = ?2",
                    params![store_id, id],
                )?;
                tx.execute(
                    "INSERT INTO durable_submissions (store_id, id, conversation_id, request_id, status, commit_seq, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        store_id,
                        id,
                        conversation_id,
                        encoded_req.as_deref(),
                        status,
                        batch_seq,
                        json_str,
                    ],
                )?;
                if let Some(req_id) = encoded_req.as_deref() {
                    tx.execute(
                        "DELETE FROM durable_request_keys WHERE store_id = ?1 AND conversation_id = ?2 AND request_id = ?3",
                        params![store_id, conversation_id, req_id],
                    )?;
                    tx.execute(
                        "INSERT INTO durable_request_keys (store_id, conversation_id, request_id, submission_id)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![store_id, conversation_id, req_id, id],
                    )?;
                }
            }
            ParsedWrite::DocCreate { .. }
            | ParsedWrite::DocCopy { .. }
            | ParsedWrite::DocChange { .. }
            | ParsedWrite::DocRetire { .. } => {}
        }
    }

    // Step 6: apply collapsed document actions
    for id in action_order {
        let action = actions.remove(&id).unwrap();
        let copy_src = action.copy;
        let is_current_only;
        if let Some(create) = action.create {
            insert_id_if_new(tx, store_id, id, "document", batch_seq)?;
            let (scope_kind, scope_conv_id, scope_task_id) = split_scope(create.scope);
            let encoded_kind = encode_indexed_str(&create.kind);
            let stamped =
                serde_json::to_string(&stamp_created_and_retired(&create.record, batch_seq, action.retire))?;
            let (src_id, src_at_seq) = match copy_src {
                Some((sid, DocPoint::Current)) => (Some(sid), None),
                Some((sid, DocPoint::Seq(s))) => (Some(sid), Some(s)),
                None => (None, None),
            };
            is_current_only = create.history.as_deref() != Some("rewindable");
            tx.execute(
                "INSERT INTO durable_documents (store_id, id, kind, scope_kind, scope_conversation_id, scope_task_id, doc_key, history, fork_mode, created_at_seq, retired_at_seq, source_id, source_at_seq, record_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    store_id,
                    id,
                    encoded_kind,
                    scope_kind,
                    scope_conv_id,
                    scope_task_id,
                    create.doc_key,
                    create.history.as_deref(),
                    create.fork_mode.as_deref(),
                    batch_seq,
                    if action.retire { Some(batch_seq) } else { None },
                    src_id,
                    src_at_seq,
                    stamped,
                ],
            )?;
            if let Some(content) = action.content {
                let payload_json = serde_json::to_string(&content.payload)?;
                tx.execute(
                    "INSERT INTO durable_document_revisions (store_id, document_id, seq, version, content_kind, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        store_id,
                        id,
                        batch_seq,
                        content.version,
                        content.kind,
                        payload_json,
                    ],
                )?;
            }
            if action.retire && is_current_only {
                tx.execute(
                    "DELETE FROM durable_document_revisions WHERE store_id = ?1 AND document_id = ?2",
                    params![store_id, id],
                )?;
            }
        } else {
            let ex = existing_metas[&id].as_ref().unwrap();
            is_current_only = ex.history.as_deref() != Some("rewindable");
            if let Some(content) = action.content {
                if content.kind == "base" && is_current_only {
                    tx.execute(
                        "DELETE FROM durable_document_revisions WHERE store_id = ?1 AND document_id = ?2",
                        params![store_id, id],
                    )?;
                }
                let payload_json = serde_json::to_string(&content.payload)?;
                tx.execute(
                    "INSERT INTO durable_document_revisions (store_id, document_id, seq, version, content_kind, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        store_id,
                        id,
                        batch_seq,
                        content.version,
                        content.kind,
                        payload_json,
                    ],
                )?;
            }
            if action.retire {
                let record_json: String = tx.query_row(
                    "SELECT record_json FROM durable_documents WHERE store_id = ?1 AND id = ?2",
                    params![store_id, id],
                    |r| r.get(0),
                )?;
                let updated_json = stamp_retired_at(&record_json, batch_seq)?;
                tx.execute(
                    "UPDATE durable_documents SET retired_at_seq = ?3, record_json = ?4 WHERE store_id = ?1 AND id = ?2",
                    params![store_id, id, batch_seq, updated_json],
                )?;
                if is_current_only {
                    tx.execute(
                        "DELETE FROM durable_document_revisions WHERE store_id = ?1 AND document_id = ?2",
                        params![store_id, id],
                    )?;
                }
            }
        }
    }

    *max_seen_id = batch_max_id;
    Ok(Ok(batch_seq))
}

fn split_scope(scope: ScopeKey) -> (&'static str, Option<i64>, Option<i64>) {
    match scope {
        ScopeKey::Session => ("session", None, None),
        ScopeKey::Conversation(cid) => ("conversation", Some(cid), None),
        ScopeKey::Task(tid) => ("task", None, Some(tid)),
    }
}

fn insert_id_if_new(
    tx: &Connection,
    store_id: &str,
    id: i64,
    kind: &str,
    commit_seq: i64,
) -> Result<()> {
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM durable_ids WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        tx.execute(
            "INSERT INTO durable_ids (store_id, id, record_kind, created_commit_seq) VALUES (?1, ?2, ?3, ?4)",
            params![store_id, id, kind, commit_seq],
        )?;
    }
    Ok(())
}

fn normalize_limit(limit: &Value) -> std::result::Result<usize, String> {
    let Some(n) = limit.as_i64() else {
        return Err("Scan limit must be a non-negative integer".to_string());
    };
    if n < 0 {
        return Err("Scan limit must be non-negative".to_string());
    }
    Ok(n as usize)
}

fn parse_scan_start(
    requested: Option<&str>,
    cursor: Option<&Value>,
    fallback: &str,
) -> std::result::Result<(&'static str, Option<i64>), String> {
    let normalize_order = |raw: &str| -> std::result::Result<&'static str, String> {
        match raw {
            "ascending" => Ok("ascending"),
            "descending" => Ok("descending"),
            other => Err(format!("Unsupported scan order: {other}")),
        }
    };
    let req_norm = requested.map(normalize_order).transpose()?;
    let fb_norm = normalize_order(fallback)?;

    if let Some(c) = cursor {
        let Some(obj) = c.as_object() else {
            return Err("Invalid scan cursor".to_string());
        };
        let after = parse_positive_id(obj.get("after"), "cursor.after")?;
        let cursor_order = match obj.get("order") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let Some(s) = v.as_str() else {
                    return Err("Invalid scan cursor order".to_string());
                };
                Some(normalize_order(s)?)
            }
        };
        if let (Some(req), Some(co)) = (req_norm, cursor_order) {
            if req != co {
                return Err(format!(
                    "Scan cursor order {co} does not match requested order {req}"
                ));
            }
        }
        let order = cursor_order.or(req_norm).unwrap_or(fb_norm);
        Ok((order, Some(after)))
    } else {
        Ok((req_norm.unwrap_or(fb_norm), None))
    }
}

fn page_from_rows(rows: Vec<(i64, Value)>, limit: usize, order: &str) -> Value {
    let has_more = rows.len() > limit;
    let take_count = if has_more { limit } else { rows.len() };
    let mut items = Vec::with_capacity(take_count);
    let mut last_id: Option<i64> = None;
    for (id, val) in rows.into_iter().take(take_count) {
        last_id = Some(id);
        items.push(val);
    }
    if has_more {
        if let Some(id) = last_id {
            return json!({
                "items": items,
                "next": { "after": id, "order": order },
            });
        }
    }
    json!({ "items": items })
}

fn get_conversation(db: &Connection, store_id: &str, id: i64) -> Result<OpOutcome> {
    let raw: Option<String> = db
        .query_row(
            "SELECT record_json FROM durable_conversations WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(s) => Ok(OpOutcome::ok(serde_json::from_str(&s)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

fn scan_conversations(
    db: &Connection,
    store_id: &str,
    owner_conversation_id: Option<i64>,
    owner_task_id: Option<i64>,
    order: Option<&str>,
    limit: &Value,
    cursor: Option<&Value>,
) -> Result<OpOutcome> {
    let limit = match normalize_limit(limit) {
        Ok(l) => l,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let (order, after) = match parse_scan_start(order, cursor, "ascending") {
        Ok(v) => v,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    if limit == 0 {
        return Ok(OpOutcome::ok(json!({ "items": [] })));
    }
    let mut sql = String::from("SELECT id, record_json FROM durable_conversations WHERE store_id = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    if let Some(ocid) = owner_conversation_id {
        sql.push_str(" AND owner_conversation_id = ?");
        boxed.push(Box::new(ocid));
    }
    if let Some(otid) = owner_task_id {
        sql.push_str(" AND owner_task_id = ?");
        boxed.push(Box::new(otid));
    }
    if let Some(after_id) = after {
        sql.push_str(if order == "ascending" { " AND id > ?" } else { " AND id < ?" });
        boxed.push(Box::new(after_id));
    }
    sql.push_str(if order == "ascending" {
        " ORDER BY id ASC LIMIT ?"
    } else {
        " ORDER BY id DESC LIMIT ?"
    });
    boxed.push(Box::new((limit + 1) as i64));
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = db.prepare(&sql)?;
    let mut rows_q = stmt.query(refs.as_slice())?;
    let mut rows = Vec::new();
    while let Some(r) = rows_q.next()? {
        let id: i64 = r.get(0)?;
        let raw: String = r.get(1)?;
        rows.push((id, serde_json::from_str(&raw)?));
    }
    Ok(OpOutcome::ok(page_from_rows(rows, limit, order)))
}

fn collect_lineage(
    db: &Connection,
    store_id: &str,
    conversation_id: i64,
) -> Result<std::result::Result<Vec<(i64, Option<i64>)>, String>> {
    let mut segments = Vec::new();
    let mut cur = conversation_id;
    let mut cutoff: Option<i64> = None;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(cur) {
            return Ok(Err(format!("Cycle in conversation lineage at {cur}")));
        }
        let parent: Option<(Option<i64>, Option<i64>)> = db
            .query_row(
                "SELECT parent_conversation_id, parent_at_entry_id FROM durable_conversations WHERE store_id = ?1 AND id = ?2 LIMIT 1",
                params![store_id, cur],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((parent_cid, parent_at)) = parent else {
            return Ok(Err(format!("Unknown conversation {cur}")));
        };
        segments.push((cur, cutoff));
        match (parent_cid, parent_at) {
            (Some(pcid), Some(pat)) => {
                cur = pcid;
                cutoff = Some(pat);
            }
            (None, None) => break,
            _ => return Ok(Err(format!("Corrupt fork parent on conversation {cur}"))),
        }
    }
    Ok(Ok(segments))
}

fn push_lineage_filter(
    segments: &[(i64, Option<i64>)],
    sql: &mut String,
    boxed: &mut Vec<Box<dyn ToSql>>,
) {
    sql.push_str(" AND (");
    for (idx, &(cid, max_id)) in segments.iter().enumerate() {
        if idx > 0 {
            sql.push_str(" OR ");
        }
        if let Some(m) = max_id {
            sql.push_str("(conversation_id = ? AND id <= ?)");
            boxed.push(Box::new(cid));
            boxed.push(Box::new(m));
        } else {
            sql.push_str("conversation_id = ?");
            boxed.push(Box::new(cid));
        }
    }
    sql.push(')');
}

fn get_entry(
    db: &Connection,
    store_id: &str,
    id: i64,
    conversation_id: Option<i64>,
) -> Result<OpOutcome> {
    if let Some(cid) = conversation_id {
        let segments = match collect_lineage(db, store_id, cid)? {
            Ok(s) => s,
            Err(msg) => return Ok(OpOutcome::request_error(msg)),
        };
        let mut sql = String::from("SELECT commit_seq, record_json FROM durable_entries WHERE store_id = ? AND id = ?");
        let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string()), Box::new(id)];
        push_lineage_filter(&segments, &mut sql, &mut boxed);
        sql.push_str(" LIMIT 1");
        let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
        let row: Option<(i64, String)> = db
            .query_row(&sql, refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        return match row {
            Some((seq, raw)) => Ok(OpOutcome::ok(json!({
                "entry": serde_json::from_str::<Value>(&raw)?,
                "commitSeq": seq,
            }))),
            None => Ok(OpOutcome::ok(Value::Null)),
        };
    }

    let row: Option<(i64, String)> = db
        .query_row(
            "SELECT commit_seq, record_json FROM durable_entries WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((seq, raw)) => Ok(OpOutcome::ok(json!({
            "entry": serde_json::from_str::<Value>(&raw)?,
            "commitSeq": seq,
        }))),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

fn find_latest_head_marker(
    db: &Connection,
    store_id: &str,
    conversation_id: i64,
    at_or_before_entry_id: Option<i64>,
) -> Result<OpOutcome> {
    let segments = match collect_lineage(db, store_id, conversation_id)? {
        Ok(s) => s,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let mut sql = String::from(
        "SELECT record_json FROM durable_entries WHERE store_id = ? AND has_head = TRUE",
    );
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    push_lineage_filter(&segments, &mut sql, &mut boxed);
    if let Some(cutoff) = at_or_before_entry_id {
        sql.push_str(" AND id <= ?");
        boxed.push(Box::new(cutoff));
    }
    sql.push_str(" ORDER BY id DESC LIMIT 1");
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let row: Option<String> = db.query_row(&sql, refs.as_slice(), |r| r.get(0)).optional()?;
    match row {
        Some(raw) => Ok(OpOutcome::ok(serde_json::from_str(&raw)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_entries(
    db: &Connection,
    store_id: &str,
    conversation_id: i64,
    min_entry_id: Option<i64>,
    max_entry_id: Option<i64>,
    order: Option<&str>,
    limit: &Value,
    cursor: Option<&Value>,
) -> Result<OpOutcome> {
    let limit = match normalize_limit(limit) {
        Ok(l) => l,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let (order, after) = match parse_scan_start(order, cursor, "descending") {
        Ok(v) => v,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let segments = match collect_lineage(db, store_id, conversation_id)? {
        Ok(s) => s,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    if limit == 0 {
        return Ok(OpOutcome::ok(json!({ "items": [] })));
    }
    let mut sql = String::from("SELECT id, record_json FROM durable_entries WHERE store_id = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    push_lineage_filter(&segments, &mut sql, &mut boxed);
    if let Some(min_id) = min_entry_id {
        sql.push_str(" AND id >= ?");
        boxed.push(Box::new(min_id));
    }
    if let Some(max_id) = max_entry_id {
        sql.push_str(" AND id <= ?");
        boxed.push(Box::new(max_id));
    }
    if let Some(after_id) = after {
        sql.push_str(if order == "ascending" { " AND id > ?" } else { " AND id < ?" });
        boxed.push(Box::new(after_id));
    }
    sql.push_str(if order == "ascending" {
        " ORDER BY id ASC LIMIT ?"
    } else {
        " ORDER BY id DESC LIMIT ?"
    });
    boxed.push(Box::new((limit + 1) as i64));
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = db.prepare(&sql)?;
    let mut rows_q = stmt.query(refs.as_slice())?;
    let mut rows = Vec::new();
    while let Some(r) = rows_q.next()? {
        let id: i64 = r.get(0)?;
        let raw: String = r.get(1)?;
        rows.push((id, serde_json::from_str(&raw)?));
    }
    Ok(OpOutcome::ok(page_from_rows(rows, limit, order)))
}

fn get_task(db: &Connection, store_id: &str, id: i64) -> Result<OpOutcome> {
    let raw: Option<String> = db
        .query_row(
            "SELECT record_json FROM durable_tasks WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(s) => Ok(OpOutcome::ok(serde_json::from_str(&s)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_tasks(
    db: &Connection,
    store_id: &str,
    conversation_id: Option<i64>,
    kind: Option<&str>,
    status: Option<&str>,
    abort_requested: Option<bool>,
    background: Option<bool>,
    order: Option<&str>,
    limit: &Value,
    cursor: Option<&Value>,
) -> Result<OpOutcome> {
    let limit = match normalize_limit(limit) {
        Ok(l) => l,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let (order, after) = match parse_scan_start(order, cursor, "ascending") {
        Ok(v) => v,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    if limit == 0 {
        return Ok(OpOutcome::ok(json!({ "items": [] })));
    }
    let mut sql = String::from("SELECT id, record_json FROM durable_tasks WHERE store_id = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    if let Some(cid) = conversation_id {
        sql.push_str(" AND conversation_id = ?");
        boxed.push(Box::new(cid));
    }
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?");
        boxed.push(Box::new(encode_indexed_str(k)));
    }
    if let Some(st) = status {
        sql.push_str(" AND status = ?");
        boxed.push(Box::new(st.to_string()));
    }
    if let Some(ar) = abort_requested {
        sql.push_str(" AND abort_requested = ?");
        boxed.push(Box::new(ar));
    }
    if let Some(bg) = background {
        sql.push_str(" AND background = ?");
        boxed.push(Box::new(bg));
    }
    if let Some(after_id) = after {
        sql.push_str(if order == "ascending" { " AND id > ?" } else { " AND id < ?" });
        boxed.push(Box::new(after_id));
    }
    sql.push_str(if order == "ascending" {
        " ORDER BY id ASC LIMIT ?"
    } else {
        " ORDER BY id DESC LIMIT ?"
    });
    boxed.push(Box::new((limit + 1) as i64));
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = db.prepare(&sql)?;
    let mut rows_q = stmt.query(refs.as_slice())?;
    let mut rows = Vec::new();
    while let Some(r) = rows_q.next()? {
        let id: i64 = r.get(0)?;
        let raw: String = r.get(1)?;
        rows.push((id, serde_json::from_str(&raw)?));
    }
    Ok(OpOutcome::ok(page_from_rows(rows, limit, order)))
}

fn get_submission(db: &Connection, store_id: &str, id: i64) -> Result<OpOutcome> {
    let raw: Option<String> = db
        .query_row(
            "SELECT record_json FROM durable_submissions WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(s) => Ok(OpOutcome::ok(serde_json::from_str(&s)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

fn get_submission_by_request(
    db: &Connection,
    store_id: &str,
    conversation_id: i64,
    request_id: &str,
) -> Result<OpOutcome> {
    let encoded_req = encode_indexed_str(request_id);
    let raw: Option<String> = db
        .query_row(
            "SELECT s.record_json
             FROM durable_request_keys k
             JOIN durable_submissions s ON s.store_id = k.store_id AND s.id = k.submission_id
             WHERE k.store_id = ?1 AND k.conversation_id = ?2 AND k.request_id = ?3 LIMIT 1",
            params![store_id, conversation_id, encoded_req],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(s) => Ok(OpOutcome::ok(serde_json::from_str(&s)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

fn scan_submissions(
    db: &Connection,
    store_id: &str,
    conversation_id: Option<i64>,
    status: Option<&str>,
    order: Option<&str>,
    limit: &Value,
    cursor: Option<&Value>,
) -> Result<OpOutcome> {
    let limit = match normalize_limit(limit) {
        Ok(l) => l,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let (order, after) = match parse_scan_start(order, cursor, "ascending") {
        Ok(v) => v,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    if limit == 0 {
        return Ok(OpOutcome::ok(json!({ "items": [] })));
    }
    let mut sql = String::from("SELECT id, record_json FROM durable_submissions WHERE store_id = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    if let Some(cid) = conversation_id {
        sql.push_str(" AND conversation_id = ?");
        boxed.push(Box::new(cid));
    }
    if let Some(st) = status {
        sql.push_str(" AND status = ?");
        boxed.push(Box::new(st.to_string()));
    }
    if let Some(after_id) = after {
        sql.push_str(if order == "ascending" { " AND id > ?" } else { " AND id < ?" });
        boxed.push(Box::new(after_id));
    }
    sql.push_str(if order == "ascending" {
        " ORDER BY id ASC LIMIT ?"
    } else {
        " ORDER BY id DESC LIMIT ?"
    });
    boxed.push(Box::new((limit + 1) as i64));
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = db.prepare(&sql)?;
    let mut rows_q = stmt.query(refs.as_slice())?;
    let mut rows = Vec::new();
    while let Some(r) = rows_q.next()? {
        let id: i64 = r.get(0)?;
        let raw: String = r.get(1)?;
        rows.push((id, serde_json::from_str(&raw)?));
    }
    Ok(OpOutcome::ok(page_from_rows(rows, limit, order)))
}

fn find_document(
    db: &Connection,
    store_id: &str,
    address: &Value,
    at: &Value,
) -> Result<OpOutcome> {
    let point = match parse_doc_point_str(at) {
        Ok(p) => p,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let Some(obj) = address.as_object() else {
        return Ok(OpOutcome::request_error("Invalid document address"));
    };
    let Some(kind) = obj.get("kind").and_then(|v| v.as_str()) else {
        return Ok(OpOutcome::request_error("Document address missing kind"));
    };
    let scope = match parse_scope(obj.get("scope")) {
        Ok(s) => s,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let key = match obj.get("key") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s) => Some(s),
            None => return Ok(OpOutcome::request_error("Document address key must be string")),
        },
    };
    let doc_key = encode_doc_key(key);

    let mut sql = String::from("SELECT record_json FROM durable_documents WHERE store_id = ? AND kind = ? AND doc_key = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![
        Box::new(store_id.to_string()),
        Box::new(encode_indexed_str(kind)),
        Box::new(doc_key),
    ];
    match scope {
        ScopeKey::Session => {
            sql.push_str(" AND scope_kind = 'session' AND scope_conversation_id IS NULL AND scope_task_id IS NULL");
        }
        ScopeKey::Conversation(cid) => {
            sql.push_str(" AND scope_kind = 'conversation' AND scope_conversation_id = ?");
            boxed.push(Box::new(cid));
        }
        ScopeKey::Task(tid) => {
            sql.push_str(" AND scope_kind = 'task' AND scope_task_id = ?");
            boxed.push(Box::new(tid));
        }
    }
    match point {
        DocPoint::Current => {
            sql.push_str(" AND retired_at_seq IS NULL");
        }
        DocPoint::Seq(seq) => {
            sql.push_str(" AND created_at_seq <= ? AND (retired_at_seq IS NULL OR retired_at_seq > ?)");
            boxed.push(Box::new(seq));
            boxed.push(Box::new(seq));
        }
    }
    sql.push_str(" LIMIT 1");
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let row: Option<String> = db.query_row(&sql, refs.as_slice(), |r| r.get(0)).optional()?;
    match row {
        Some(raw) => Ok(OpOutcome::ok(serde_json::from_str(&raw)?)),
        None => Ok(OpOutcome::ok(Value::Null)),
    }
}

fn get_document(db: &Connection, store_id: &str, id: i64, at: &Value) -> Result<OpOutcome> {
    let point = match parse_doc_point_str(at) {
        Ok(p) => p,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let meta: Option<(Option<String>, i64, Option<i64>, String)> = db
        .query_row(
            "SELECT history, created_at_seq, retired_at_seq, record_json FROM durable_documents WHERE store_id = ?1 AND id = ?2 LIMIT 1",
            params![store_id, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((history, created_at_seq, retired_at_seq, record_json)) = meta else {
        return Ok(OpOutcome::ok(Value::Null));
    };

    let target_seq = match point {
        DocPoint::Current => {
            if retired_at_seq.is_some() {
                return Ok(OpOutcome::ok(Value::Null));
            }
            i64::MAX
        }
        DocPoint::Seq(seq) => {
            if history.as_deref() != Some("rewindable") {
                return Ok(OpOutcome::request_error(format!(
                    "Document {id} does not retain historical content"
                )));
            }
            if seq < created_at_seq || retired_at_seq.map_or(false, |r| seq >= r) {
                return Ok(OpOutcome::ok(Value::Null));
            }
            seq
        }
    };

    let base_row: Option<(i64, i64, String)> = db
        .query_row(
            "SELECT seq, version, payload_json FROM durable_document_revisions
             WHERE store_id = ?1 AND document_id = ?2 AND seq <= ?3 AND content_kind = 'base'
             ORDER BY seq DESC LIMIT 1",
            params![store_id, id, target_seq],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((base_seq, base_ver, base_json)) = base_row else {
        return Ok(OpOutcome::ok(Value::Null));
    };

    let mut stmt = db.prepare(
        "SELECT version, payload_json FROM durable_document_revisions
         WHERE store_id = ?1 AND document_id = ?2 AND seq > ?3 AND seq <= ?4 AND content_kind = 'delta'
         ORDER BY seq ASC",
    )?;
    let mut rows = stmt.query(params![store_id, id, base_seq, target_seq])?;
    let mut latest_ver = base_ver;
    let mut deltas: Vec<Value> = Vec::new();
    while let Some(r) = rows.next()? {
        latest_ver = r.get(0)?;
        let ops_str: String = r.get(1)?;
        deltas.push(serde_json::from_str(&ops_str)?);
    }

    Ok(OpOutcome::ok(json!({
        "record": serde_json::from_str::<Value>(&record_json)?,
        "version": latest_ver,
        "baseValue": serde_json::from_str::<Value>(&base_json)?,
        "deltas": deltas,
        "deltasSinceBase": deltas.len(),
    })))
}

pub(crate) fn current_session_document(
    db: &Connection,
    store_id: &str,
    kind: &str,
    key: &str,
) -> Result<Option<Value>> {
    let current = json!("current");
    let address = json!({"kind":kind,"scope":{"kind":"session"},"key":key});
    let OpOutcome::Ok(record) = find_document(db, store_id, &address, &current)? else {
        return Err("Failed to locate a native session document".into());
    };
    let Some(id) = record["id"].as_i64() else {
        return Ok(None);
    };
    let OpOutcome::Ok(mut stored) = get_document(db, store_id, id, &current)? else {
        return Err("Failed to read a native session document".into());
    };
    let Some(base) = stored.get_mut("baseValue") else {
        return Ok(None);
    };
    let mut value = std::mem::take(base);
    for delta in stored["deltas"].as_array().into_iter().flatten() {
        apply_chord_delta(&mut value, delta)?;
    }
    Ok(Some(value))
}

fn scan_documents(
    db: &Connection,
    store_id: &str,
    scope: &Value,
    at: &Value,
    kind: Option<&str>,
    limit: &Value,
    cursor: Option<&Value>,
) -> Result<OpOutcome> {
    let limit = match normalize_limit(limit) {
        Ok(l) => l,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let point = match parse_doc_point_str(at) {
        Ok(p) => p,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let scope = match parse_scope(Some(scope)) {
        Ok(s) => s,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    let (order, after) = match parse_scan_start(None, cursor, "ascending") {
        Ok(v) => v,
        Err(msg) => return Ok(OpOutcome::request_error(msg)),
    };
    if order != "ascending" {
        return Ok(OpOutcome::request_error(
            "Document scan cursor order must be ascending",
        ));
    }
    if limit == 0 {
        return Ok(OpOutcome::ok(json!({ "items": [] })));
    }

    let mut sql = String::from("SELECT id, record_json FROM durable_documents WHERE store_id = ?");
    let mut boxed: Vec<Box<dyn ToSql>> = vec![Box::new(store_id.to_string())];
    match scope {
        ScopeKey::Session => {
            sql.push_str(" AND scope_kind = 'session' AND scope_conversation_id IS NULL AND scope_task_id IS NULL");
        }
        ScopeKey::Conversation(cid) => {
            sql.push_str(" AND scope_kind = 'conversation' AND scope_conversation_id = ?");
            boxed.push(Box::new(cid));
        }
        ScopeKey::Task(tid) => {
            sql.push_str(" AND scope_kind = 'task' AND scope_task_id = ?");
            boxed.push(Box::new(tid));
        }
    }
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?");
        boxed.push(Box::new(encode_indexed_str(k)));
    }
    match point {
        DocPoint::Current => {
            sql.push_str(" AND retired_at_seq IS NULL");
        }
        DocPoint::Seq(seq) => {
            sql.push_str(" AND created_at_seq <= ? AND (retired_at_seq IS NULL OR retired_at_seq > ?)");
            boxed.push(Box::new(seq));
            boxed.push(Box::new(seq));
        }
    }
    if let Some(after_id) = after {
        sql.push_str(" AND id > ?");
        boxed.push(Box::new(after_id));
    }
    sql.push_str(" ORDER BY id ASC LIMIT ?");
    boxed.push(Box::new((limit + 1) as i64));

    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = db.prepare(&sql)?;
    let mut rows_q = stmt.query(refs.as_slice())?;
    let mut rows = Vec::new();
    while let Some(r) = rows_q.next()? {
        let id: i64 = r.get(0)?;
        let raw: String = r.get(1)?;
        rows.push((id, serde_json::from_str(&raw)?));
    }
    Ok(OpOutcome::ok(page_from_rows(rows, limit, "ascending")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::CANONICAL_DUCKDB_SCHEMA_SQL;
    use crate::resource_gate::{ResourceGate, ResourceKey, ResourceRequirement};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory duckdb");
        conn.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL)
            .expect("apply schema");
        conn
    }

    #[test]
    fn chord_string_deltas_use_original_utf16_offsets() {
        let mut document = json!({"emoji": "😂", "marker": "\u{e000}\u{e000}X"});
        apply_chord_delta(&mut document, &json!([["t", ["emoji"], 1], ["t", ["marker"], 1]])).unwrap();
        assert_eq!(document, json!({"emoji": "\u{e000}\u{e03e}", "marker": "\u{e000}\u{e000}"}));
        apply_chord_delta(&mut document, &json!([["a", ["emoji"], "\u{e000}\u{e603}"]])).unwrap();
        assert_eq!(document["emoji"], "😂");
    }

    #[test]
    fn open_writer_mint_commit_and_fence_by_epoch() {
        let mut db = setup_db();
        let opened = execute(
            &mut db,
            Action::OpenWriter {
                store_id: "store-a".into(),
                host_generation: Some("gen-1".into()),
                lease_holder: Some("holder-1".into()),
                lease_ttl_ms: Some(30_000),
                expected_writer_epoch: None,
                force_takeover: None,
            },
        )
        .unwrap();
        assert_eq!(opened["ok"], true);
        let epoch1 = opened["data"]["writerEpoch"].as_i64().unwrap();

        let id1 = execute(
            &mut db,
            Action::MintId {
                store_id: "store-a".into(),
                writer_epoch: epoch1,
                host_generation: Some("gen-1".into()),
                count: None,
            },
        )
        .unwrap()["data"]["id"]
            .as_i64()
            .unwrap();
        assert_eq!(id1, 2);

        // Concurrent non-forced open from another holder fails as owned
        let owned = execute(
            &mut db,
            Action::OpenWriter {
                store_id: "store-a".into(),
                host_generation: Some("gen-2".into()),
                lease_holder: Some("holder-2".into()),
                lease_ttl_ms: Some(30_000),
                expected_writer_epoch: None,
                force_takeover: None,
            },
        )
        .unwrap();
        assert_eq!(owned["ok"], false);
        assert_eq!(owned["kind"], "owned");

        // Forced takeover bumps writer_epoch and fences holder-1
        let takeover = execute(
            &mut db,
            Action::OpenWriter {
                store_id: "store-a".into(),
                host_generation: Some("gen-2".into()),
                lease_holder: Some("holder-2".into()),
                lease_ttl_ms: Some(30_000),
                expected_writer_epoch: None,
                force_takeover: Some(true),
            },
        )
        .unwrap();
        assert_eq!(takeover["ok"], true);
        let epoch2 = takeover["data"]["writerEpoch"].as_i64().unwrap();
        assert!(epoch2 > epoch1);

        let stale = execute(
            &mut db,
            Action::Commit {
                store_id: "store-a".into(),
                writer_epoch: epoch1,
                host_generation: Some("gen-1".into()),
                batches: vec![vec![json!({ "type": "conversation", "value": { "id": 1 } })]],
            },
        )
        .unwrap();
        assert_eq!(stale["ok"], false);
        assert_eq!(stale["kind"], "fenced");

        // Partial batch commit & refusal on duplicate ID
        let res = execute(
            &mut db,
            Action::Commit {
                store_id: "store-a".into(),
                writer_epoch: epoch2,
                host_generation: Some("gen-2".into()),
                batches: vec![
                    vec![json!({ "type": "conversation", "value": { "id": 1 } })],
                    vec![json!({ "type": "conversation", "value": { "id": 1 } })],
                    vec![json!({ "type": "conversation", "value": { "id": 2 } })],
                ],
            },
        )
        .unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["stored"], 1);
        assert_eq!(res["data"]["seqs"], json!([1]));
        assert!(res["data"]["refused"]
            .as_str()
            .unwrap()
            .contains("ID 1 already belongs to conversation"));

        // Conv 1 exists, conv 2 does not
        let c1 = execute(
            &mut db,
            Action::Conversation {
                store_id: "store-a".into(),
                id: 1,
            },
        )
        .unwrap();
        assert_eq!(c1["data"]["id"], 1);
        let c2 = execute(
            &mut db,
            Action::Conversation {
                store_id: "store-a".into(),
                id: 2,
            },
        )
        .unwrap();
        assert!(c2["data"].is_null());

        // Purge clears store & fences epoch2
        let purged = execute(
            &mut db,
            Action::PurgeStore {
                store_id: "store-a".into(),
                expected_writer_epoch: Some(epoch2),
            },
        )
        .unwrap();
        assert_eq!(purged["ok"], true);
        let info = execute(
            &mut db,
            Action::StoreInfo {
                store_id: "store-a".into(),
            },
        )
        .unwrap();
        assert_eq!(info["data"]["exists"], false);
        let fenced_after_purge = execute(
            &mut db,
            Action::MintId {
                store_id: "store-a".into(),
                writer_epoch: epoch2,
                host_generation: None,
                count: None,
            },
        )
        .unwrap();
        assert_eq!(fenced_after_purge["ok"], false);
        assert_eq!(fenced_after_purge["kind"], "fenced");
    }

    #[test]
    fn copy_with_seven_delta_ops_and_multi_store_parallel_gate() {
        let gate = Arc::new(ResourceGate::new(64));
        let mut handles = Vec::new();
        // Verify 4 independent stores serialize cleanly on ResourceKey::PiStore
        for idx in 0..4 {
            let g = gate.clone();
            handles.push(thread::spawn(move || {
                let store_id = format!("store-{idx}");
                let lease = g
                    .acquire(
                        vec![ResourceRequirement::exclusive(ResourceKey::PiStore(
                            store_id.clone(),
                        ))],
                        Duration::from_secs(2),
                        || false,
                    )
                    .expect("acquire store gate");
                let mut db = setup_db();
                let open = execute(
                    &mut db,
                    Action::OpenWriter {
                        store_id: store_id.clone(),
                        host_generation: None,
                        lease_holder: None,
                        lease_ttl_ms: None,
                        expected_writer_epoch: None,
                        force_takeover: None,
                    },
                )
                .unwrap();
                let epoch = open["data"]["writerEpoch"].as_i64().unwrap();
                let commit = execute(
                    &mut db,
                    Action::Commit {
                        store_id: store_id.clone(),
                        writer_epoch: epoch,
                        host_generation: None,
                        batches: vec![
                            vec![
                                json!({ "type": "conversation", "value": { "id": 1 } }),
                                json!({ "type": "conversation", "value": { "id": 2 } }),
                                json!({
                                    "type": "document.create",
                                    "record": {
                                        "id": 10,
                                        "kind": "notes",
                                        "scope": { "kind": "conversation", "conversationId": 1 },
                                        "history": "rewindable",
                                        "fork": "asOf"
                                    },
                                    "content": {
                                        "kind": "base",
                                        "version": 1,
                                        "value": { "text": "hello world", "arr": [1, 2, 3], "drop": true }
                                    }
                                }),
                            ],
                            vec![json!({
                                "type": "document.change",
                                "id": 10,
                                "content": {
                                    "kind": "delta",
                                    "version": 1,
                                    "ops": [
                                        ["t", ["text"], 5],
                                        ["a", ["text"], " duck"],
                                        ["d", ["drop"]],
                                        ["p", ["arr"], 1, 1, [9, 8]],
                                        ["m", ["arr"], [3, 2, 1, 0]]
                                    ]
                                }
                            })],
                            vec![json!({
                                "type": "document.copy",
                                "record": {
                                    "id": 11,
                                    "kind": "notes",
                                    "scope": { "kind": "conversation", "conversationId": 2 },
                                    "history": "rewindable",
                                    "fork": "asOf"
                                },
                                "source": { "id": 10, "at": "current" }
                            })],
                        ],
                    },
                )
                .unwrap();
                assert_eq!(commit["data"]["stored"], 3);
                let copied = execute(
                    &mut db,
                    Action::Document {
                        store_id,
                        id: 11,
                        at: json!("current"),
                    },
                )
                .unwrap();
                assert_eq!(
                    copied["data"]["baseValue"],
                    json!({ "text": "hello duck", "arr": [3, 8, 9, 1] })
                );
                drop(lease);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
    }

    #[test]
    fn indexed_nul_bytes_order_independent_retire_create_and_copy_validation() {
        let mut db = setup_db();
        let open = execute(
            &mut db,
            Action::OpenWriter {
                store_id: "store-edge".into(),
                host_generation: None,
                lease_holder: None,
                lease_ttl_ms: None,
                expected_writer_epoch: None,
                force_takeover: None,
            },
        )
        .unwrap();
        let epoch = open["data"]["writerEpoch"].as_i64().unwrap();

        // Embedded NUL bytes in kind, key, and requestId stay distinct
        let c1 = execute(
            &mut db,
            Action::Commit {
                store_id: "store-edge".into(),
                writer_epoch: epoch,
                host_generation: None,
                batches: vec![vec![
                    json!({ "type": "conversation", "value": { "id": 1 } }),
                    json!({ "type": "conversation", "value": { "id": 2 } }),
                    json!({
                        "type": "task",
                        "value": { "id": 3, "conversationId": 1, "kind": "k\u{0000}a", "abortRequested": false, "background": false, "state": { "status": "pending", "checkpoint": {} } }
                    }),
                    json!({
                        "type": "task",
                        "value": { "id": 4, "conversationId": 1, "kind": "k\u{0000}b", "abortRequested": false, "background": false, "state": { "status": "pending", "checkpoint": {} } }
                    }),
                    json!({
                        "type": "submission",
                        "value": { "id": 5, "conversationId": 1, "type": "input", "status": "queued", "requestId": "req\u{0000}1" }
                    }),
                    json!({
                        "type": "submission",
                        "value": { "id": 6, "conversationId": 1, "type": "input", "status": "queued", "requestId": "req\u{0000}2" }
                    }),
                    json!({
                        "type": "document.create",
                        "record": { "id": 10, "kind": "doc\u{0000}1", "scope": { "kind": "conversation", "conversationId": 1 }, "key": "m\u{0000}1", "history": "latest", "fork": "current" },
                        "content": { "kind": "base", "version": 1, "value": { "v": 1 } }
                    }),
                    json!({
                        "type": "document.create",
                        "record": { "id": 11, "kind": "doc\u{0000}1", "scope": { "kind": "conversation", "conversationId": 1 }, "key": "m\u{0000}2", "history": "latest", "fork": "current" },
                        "content": { "kind": "base", "version": 1, "value": { "v": 2 } }
                    }),
                ]],
            },
        )
        .unwrap();
        assert_eq!(c1["data"]["stored"], 1);

        let tasks_a = execute(
            &mut db,
            Action::ScanTasks {
                store_id: "store-edge".into(),
                conversation_id: None,
                kind: Some("k\u{0000}a".into()),
                status: None,
                abort_requested: None,
                background: None,
                order: None,
                limit: json!(10),
                cursor: None,
            },
        )
        .unwrap();
        assert_eq!(tasks_a["data"]["items"].as_array().unwrap().len(), 1);
        assert_eq!(tasks_a["data"]["items"][0]["id"], 3);

        let sub2 = execute(
            &mut db,
            Action::SubmissionByRequest {
                store_id: "store-edge".into(),
                conversation_id: 1,
                request_id: "req\u{0000}2".into(),
            },
        )
        .unwrap();
        assert_eq!(sub2["data"]["id"], 6);

        let found_doc = execute(
            &mut db,
            Action::FindDocument {
                store_id: "store-edge".into(),
                address: json!({ "kind": "doc\u{0000}1", "scope": { "kind": "conversation", "conversationId": 1 }, "key": "m\u{0000}2" }),
                at: json!("current"),
            },
        )
        .unwrap();
        assert_eq!(found_doc["data"]["id"], 11);

        // Same-batch create BEFORE retire at identical address succeeds (order-independent)
        let replace = execute(
            &mut db,
            Action::Commit {
                store_id: "store-edge".into(),
                writer_epoch: epoch,
                host_generation: None,
                batches: vec![vec![
                    json!({
                        "type": "document.create",
                        "record": { "id": 12, "kind": "doc\u{0000}1", "scope": { "kind": "conversation", "conversationId": 1 }, "key": "m\u{0000}1", "history": "latest", "fork": "current" },
                        "content": { "kind": "base", "version": 1, "value": { "v": 12 } }
                    }),
                    json!({ "type": "document.retire", "id": 10 }),
                ]],
            },
        )
        .unwrap();
        assert_eq!(replace["data"]["stored"], 1);
        assert!(replace["data"]["refused"].is_null());

        // Copy rejects mismatched fork/history/key/scope
        let bad_copy = execute(
            &mut db,
            Action::Commit {
                store_id: "store-edge".into(),
                writer_epoch: epoch,
                host_generation: None,
                batches: vec![vec![json!({
                    "type": "document.copy",
                    "record": { "id": 13, "kind": "doc\u{0000}1", "scope": { "kind": "conversation", "conversationId": 2 }, "key": "other", "history": "latest", "fork": "current" },
                    "source": { "id": 12, "at": "current" }
                })]],
            },
        )
        .unwrap();
        assert_eq!(bad_copy["data"]["stored"], 0);
        assert!(bad_copy["data"]["refused"]
            .as_str()
            .unwrap()
            .contains("does not match the copied record"));
    }
}
