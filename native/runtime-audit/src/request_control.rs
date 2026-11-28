//! Admission and operation truth, shared by stdin and every worker. Cancellation is
//! authoritative before execution; after execution starts it is a request, never a
//! claim that an arbitrary database/file effect was undone.
//!
//! Refactored for DuckDB concurrency (`CC-06`, `CC-09`):
//! - Global map lock only resolves `Arc<RequestSlot>` in nanoseconds; NEVER held across disk
//!   receipt persistence, `COMMIT`, or `fsync`!
//! - Slow `COMMIT` never blocks `status()` or `cancel()` on the same or any other request.
//! - Connection interrupts bind `(request_id, conn_epoch)` and unbind before pool return.
//! - `RecoveryFinalizationPermit` allows bounded post-effect cleanup/finalization commits while
//!   rejecting ordinary post-cancel writes.

use crate::database::DbError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_RECORDS: usize = 512;
const MAX_RESULT_BYTES: usize = 256 * 1024;
const MAX_REVOCATIONS: usize = 8192;
static SHARED: OnceLock<Arc<Control>> = OnceLock::new();
thread_local! { static CURRENT: RefCell<Option<String>> = const { RefCell::new(None) }; }

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
pub fn install(control: Arc<Control>) {
    let _ = SHARED.set(control);
}
pub fn shared() -> Option<&'static Arc<Control>> {
    SHARED.get()
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub operation: String,
    pub state: String,
    pub generation: String,
    #[serde(default)]
    pub deadline_at: u64,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub never_started: bool,
    #[serde(default)]
    pub durable: bool,
    #[serde(skip)]
    persist_file_receipt: bool,
    #[serde(default)]
    pub commits: u32,
    #[serde(default)]
    pub boundary_rejected: bool,
    #[serde(default)]
    pub pending_dispatch: bool,
    #[serde(default)]
    pub confirmed_no_effect: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub committing: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub cancel_outcome_pending: bool,
    #[serde(skip)]
    persistence_pending: bool,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Receipt {
    fn terminal(&self) -> bool {
        !matches!(self.state.as_str(), "queued" | "running")
    }
}

/// Scoped permission for bounded cleanup / compensation / final-receipt commits after an
/// irreversible external effect (Pi spawn/kill, file rename) already happened (`CC-09`).
#[derive(Debug, Clone)]
pub struct RecoveryFinalizationPermit {
    pub operation_id: String,
    pub generation: String,
    pub purpose: &'static str,
}

type InterruptBinding = Option<(u64, Arc<dyn Fn() + Send + Sync>)>;

struct RequestSlot {
    receipt: Mutex<Receipt>,
    interrupt: Mutex<InterruptBinding>,
}

impl RequestSlot {
    fn new(receipt: Receipt) -> Arc<Self> {
        Arc::new(Self {
            receipt: Mutex::new(receipt),
            interrupt: Mutex::new(None),
        })
    }
}

#[derive(Default)]
struct State {
    records: HashMap<String, Arc<RequestSlot>>,
    order: VecDeque<String>,
    revoked: HashSet<(String, Option<String>)>,
    revoke_overflow: bool,
}

pub struct Control {
    state: Mutex<State>,
    directory: Option<PathBuf>,
    generation: String,
}

#[derive(Debug, Clone)]
pub struct Rejection {
    pub status: &'static str,
    pub code: &'static str,
    pub never_started: bool,
}
impl Rejection {
    pub fn frame(&self, id: &str) -> Value {
        json!({"replyId":id,"historyLane":true,"status":self.status,"errorCode":self.code,"neverStarted":self.never_started})
    }
}

impl Control {
    pub fn open(db_path: &Path) -> io::Result<Arc<Self>> {
        let directory = db_path.with_extension("runtime-operations");
        fs::create_dir_all(&directory)?;
        let generation = format!("{}-{}", std::process::id(), now_ms());
        let control = Arc::new(Self {
            state: Mutex::new(State::default()),
            directory: Some(directory.clone()),
            generation,
        });
        let mut records = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "json")
            {
                continue;
            }
            if entry.metadata()?.len() > MAX_RESULT_BYTES as u64 + 8192 {
                continue;
            }
            if let Ok(mut receipt) = serde_json::from_slice::<Receipt>(&fs::read(entry.path())?) {
                if matches!(receipt.state.as_str(), "running" | "queued") {
                    receipt.state = "unknown".into();
                    receipt.error =
                        Some("worker ended before a terminal receipt was persisted".into());
                    receipt.never_started = false;
                    receipt.pending_dispatch = false;
                    receipt.committing = false;
                }
                records.push(receipt);
            }
        }
        records.sort_by_key(|receipt| receipt.updated_at);
        while records.len() > MAX_RECORDS {
            let Some(index) = records
                .iter()
                .position(|receipt| receipt.state != "unknown")
            else {
                break;
            };
            let receipt = records.remove(index);
            let _ = fs::remove_file(control.receipt_path(&receipt.request_id).unwrap());
        }
        let mut state = control.state.lock().unwrap_or_else(|e| e.into_inner());
        for receipt in records {
            let id = receipt.request_id.clone();
            state.order.push_back(id.clone());
            state.records.insert(id, RequestSlot::new(receipt));
        }
        drop(state);
        Ok(control)
    }

    pub fn memory() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            directory: None,
            generation: "test".into(),
        })
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    fn slot(&self, id: &str) -> Option<Arc<RequestSlot>> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .records
            .get(id)
            .cloned()
    }

    fn receipt_path(&self, id: &str) -> Option<PathBuf> {
        self.directory
            .as_ref()
            .map(|dir| dir.join(format!("{:x}.json", Sha256::digest(id.as_bytes()))))
    }

    fn persist(&self, receipt: &Receipt) -> io::Result<()> {
        if !receipt.persist_file_receipt {
            return Ok(());
        }
        let Some(path) = self.receipt_path(&receipt.request_id) else {
            return Ok(());
        };
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temporary = path.with_extension(format!("{}-{nonce}.tmp", std::process::id()));
        let bytes = serde_json::to_vec(receipt)?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            #[cfg(unix)]
            {
                fs::File::open(path.parent().unwrap())?.sync_all()?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn bind_interrupt(
        &self,
        id: &str,
        conn_epoch: u64,
        interrupt_fn: Arc<dyn Fn() + Send + Sync>,
    ) {
        if let Some(slot) = self.slot(id) {
            let mut guard = slot.interrupt.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((conn_epoch, interrupt_fn));
        }
    }

    pub fn unbind_interrupt(&self, id: &str, conn_epoch: u64) {
        if let Some(slot) = self.slot(id) {
            let mut guard = slot.interrupt.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((bound_epoch, _)) = guard.as_ref()
                && *bound_epoch == conn_epoch
            {
                *guard = None;
            }
        }
    }

    pub fn is_cancelled_or_expired(&self, id: &str) -> bool {
        let Some(slot) = self.slot(id) else {
            return false;
        };
        let r = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        r.cancel_requested || r.state == "cancelled" || r.deadline_at <= now_ms()
    }

    pub fn issue_finalization_permit(
        &self,
        id: &str,
        purpose: &'static str,
    ) -> Option<RecoveryFinalizationPermit> {
        let slot = self.slot(id)?;
        let r = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        if !r.durable {
            return None;
        }
        Some(RecoveryFinalizationPermit {
            operation_id: id.to_owned(),
            generation: self.generation.clone(),
            purpose,
        })
    }

    pub fn register(
        &self,
        id: &str,
        operation: &str,
        deadline_at: u64,
        durable: bool,
    ) -> Result<(), Rejection> {
        self.register_with_persistence(id, operation, deadline_at, durable, durable)
    }

    pub fn register_with_persistence(
        &self,
        id: &str,
        operation: &str,
        deadline_at: u64,
        durable: bool,
        persist_file_receipt: bool,
    ) -> Result<(), Rejection> {
        if id.is_empty()
            || id.len() > 192
            || operation.is_empty()
            || operation.len() > 128
            || deadline_at == 0
        {
            return Err(Rejection {
                status: "error",
                code: "INVALID_REQUEST",
                never_started: true,
            });
        }
        let mut evicted_paths = Vec::new();
        let outcome = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.records.contains_key(id) {
                return Err(Rejection {
                    status: "error",
                    code: "DUPLICATE_REQUEST",
                    never_started: false,
                });
            }
            while state.records.len() >= MAX_RECORDS {
                let Some(index) = state.order.iter().position(|cand_id| {
                    state.records.get(cand_id).is_none_or(|slot| {
                        let receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
                        receipt.terminal()
                            && !receipt.pending_dispatch
                            && !receipt.persistence_pending
                            && !receipt.committing
                            && !(receipt.durable && receipt.state == "unknown")
                    })
                }) else {
                    return Err(Rejection {
                        status: "error",
                        code: "OVERLOADED",
                        never_started: true,
                    });
                };
                let old = state.order.remove(index).unwrap();
                state.records.remove(&old);
                if let Some(path) = self.receipt_path(&old) {
                    evicted_paths.push(path);
                }
            }
            let expired = deadline_at <= now_ms();
            state.records.insert(
                id.into(),
                RequestSlot::new(Receipt {
                    request_id: id.into(),
                    operation: operation.into(),
                    state: if expired { "expired" } else { "queued" }.into(),
                    generation: self.generation.clone(),
                    deadline_at,
                    cancel_requested: false,
                    never_started: expired,
                    durable,
                    persist_file_receipt,
                    commits: 0,
                    boundary_rejected: false,
                    pending_dispatch: !expired,
                    confirmed_no_effect: false,
                    committing: false,
                    cancel_outcome_pending: false,
                    persistence_pending: false,
                    updated_at: now_ms(),
                    result: None,
                    error: None,
                }),
            );
            state.order.push_back(id.into());
            if expired {
                Err(Rejection {
                    status: "expired",
                    code: "EXPIRED",
                    never_started: true,
                })
            } else {
                Ok(())
            }
        };
        for path in evicted_paths {
            let _ = fs::remove_file(path);
        }
        outcome
    }

    pub fn start(&self, id: &str) -> Result<(), Rejection> {
        let Some(slot) = self.slot(id) else {
            return Err(Rejection {
                status: "error",
                code: "UNKNOWN_REQUEST",
                never_started: true,
            });
        };
        let receipt = {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if receipt.cancel_requested || receipt.state == "cancelled" {
                receipt.state = "cancelled".into();
                receipt.never_started = true;
                receipt.pending_dispatch = false;
                return Err(Rejection {
                    status: "cancelled",
                    code: "CANCELLED",
                    never_started: true,
                });
            }
            if receipt.deadline_at <= now_ms() || receipt.state == "expired" {
                receipt.state = "expired".into();
                receipt.never_started = true;
                receipt.pending_dispatch = false;
                return Err(Rejection {
                    status: "expired",
                    code: "EXPIRED",
                    never_started: true,
                });
            }
            if receipt.state != "queued" {
                return Err(Rejection {
                    status: "error",
                    code: "DUPLICATE_REQUEST",
                    never_started: false,
                });
            }
            let mut starting = receipt.clone();
            starting.state = "running".into();
            starting.updated_at = now_ms();
            starting
        };
        // Persist outside any map or slot lock (`CC-06`)
        if self.persist(&receipt).is_err() {
            self.reject(id, "failed", "RECEIPT_UNAVAILABLE");
            return Err(Rejection {
                status: "error",
                code: "RECEIPT_UNAVAILABLE",
                never_started: true,
            });
        }
        let rejected = {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if receipt.cancel_requested || receipt.deadline_at <= now_ms() {
                let cancelled = receipt.cancel_requested;
                receipt.state = if cancelled { "cancelled" } else { "expired" }.into();
                receipt.never_started = true;
                Some((
                    receipt.clone(),
                    Rejection {
                        status: if cancelled { "cancelled" } else { "expired" },
                        code: if cancelled { "CANCELLED" } else { "EXPIRED" },
                        never_started: true,
                    },
                ))
            } else {
                receipt.pending_dispatch = false;
                receipt.state = "running".into();
                receipt.updated_at = now_ms();
                None
            }
        };
        if let Some((receipt, rejection)) = rejected {
            if let Err(error) = self.persist(&receipt) {
                eprintln!("Operation receipt persistence failed: {error}");
            }
            let mut rec = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            rec.pending_dispatch = false;
            return Err(rejection);
        }
        Ok(())
    }

    pub fn reject(&self, id: &str, status: &str, code: &str) {
        if let Some(slot) = self.slot(id) {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            receipt.state = status.into();
            receipt.error = Some(code.into());
            receipt.never_started = true;
            receipt.pending_dispatch = false;
            receipt.updated_at = now_ms();
        }
    }

    fn reject_pending(&self, id: &str, fallback: &'static str) -> Option<Rejection> {
        let slot = self.slot(id)?;
        let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        if !receipt.pending_dispatch {
            return None;
        }
        let (state, status, code) = if receipt.cancel_requested || receipt.state == "cancelled" {
            ("cancelled", "cancelled", "CANCELLED")
        } else if fallback == "EXPIRED" || receipt.deadline_at <= now_ms() || receipt.state == "expired" {
            ("expired", "expired", "EXPIRED")
        } else {
            ("failed", "error", fallback)
        };
        receipt.state = state.into();
        receipt.error = Some(code.into());
        receipt.never_started = true;
        receipt.pending_dispatch = false;
        receipt.updated_at = now_ms();
        Some(Rejection { status, code, never_started: true })
    }

    pub fn finish(&self, id: &str, success: bool, result: Option<Value>, error: Option<String>) {
        let Some(slot) = self.slot(id) else {
            return;
        };
        let receipt = {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if receipt.terminal() {
                return;
            }
            receipt.committing = false;
            receipt.state = if receipt.boundary_rejected {
                if receipt.commits > 0 {
                    "unknown"
                } else if receipt.cancel_requested {
                    "cancelled"
                } else {
                    "expired"
                }
            } else if success {
                "committed"
            } else if (receipt.confirmed_no_effect || !receipt.persist_file_receipt)
                && receipt.commits == 0
                && !receipt.committing
            {
                receipt.confirmed_no_effect = true;
                "failed"
            } else if receipt.durable {
                "unknown"
            } else {
                "failed"
            }
            .into();
            receipt.updated_at = now_ms();
            receipt.error = error;
            receipt.result = result.filter(|value| {
                serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_RESULT_BYTES)
            });
            receipt.persistence_pending = true;
            receipt.clone()
        };
        if let Err(error) = self.persist(&receipt) {
            eprintln!("Operation receipt persistence failed: {error}");
        }
        {
            let mut rec = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            rec.persistence_pending = false;
        }
        CURRENT.with(|current| {
            if current.borrow().as_deref() == Some(id) {
                current.replace(None);
            }
        });
    }

    fn known_failure(&self, id: &str) {
        if let Some(slot) = self.slot(id) {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if receipt.state == "running" && receipt.commits == 0 && !receipt.committing {
                receipt.confirmed_no_effect = true;
            }
        }
    }

    fn checkpoint_record(receipt: &mut Receipt) -> io::Result<()> {
        if receipt.cancel_requested || receipt.deadline_at <= now_ms() {
            receipt.boundary_rejected = true;
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                if receipt.cancel_requested {
                    "CANCELLED"
                } else {
                    "EXPIRED"
                },
            ));
        }
        Ok(())
    }

    fn checkpoint(&self, id: &str) -> io::Result<()> {
        let Some(slot) = self.slot(id) else {
            return Err(io::Error::other("unknown transaction owner"));
        };
        let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        Self::checkpoint_record(&mut receipt)
    }

    /// Native DuckDB lock-free commit (`CC-06`):
    /// - Verifies cancellation/deadline BEFORE commit
    /// - Marks `phase = committing` and drops EVERY mutex before calling `tx.commit()`!
    /// - `status()` and `cancel()` remain completely unblocked while disk commit runs.
    pub fn commit_duckdb_tx(&self, id: &str, tx: duckdb::Transaction<'_>) -> Result<(), DbError> {
        let Some(slot) = self.slot(id) else {
            return Err(DbError::Unavailable("unknown transaction owner".into()));
        };
        {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            Self::checkpoint_record(&mut receipt).map_err(|e| DbError::Interrupted(e.to_string()))?;
            receipt.committing = true;
        }
        let commit_res = tx.commit();
        let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        receipt.committing = false;
        commit_res.map_err(DbError::from)?;
        receipt.commits += 1;
        Ok(())
    }

    /// Scoped post-effect recovery/finalization commit (`CC-09`). Allows cleanup / final-receipt
    /// persistence after an irreversible OS/file side effect, even if late `cancel()` arrived,
    /// while verifying generation & operation identity.
    pub fn commit_duckdb_finalization(
        &self,
        permit: &RecoveryFinalizationPermit,
        tx: duckdb::Transaction<'_>,
    ) -> Result<(), DbError> {
        if permit.generation != self.generation || permit.purpose.is_empty() {
            return Err(DbError::Unavailable("Invalid RecoveryFinalizationPermit generation".into()));
        }
        let Some(slot) = self.slot(&permit.operation_id) else {
            // Even if in-memory slot expired, reject unanchored finalization unless generation matches
            return Err(DbError::Unavailable("Unknown operation for RecoveryFinalizationPermit".into()));
        };
        {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            receipt.committing = true;
        }
        let commit_res = tx.commit();
        let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        receipt.committing = false;
        commit_res.map_err(DbError::from)?;
        receipt.commits += 1;
        Ok(())
    }

    pub fn terminal_override(&self, id: &str) -> Option<Value> {
        let slot = self.slot(id)?;
        let receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
        if receipt.state == "failed" && receipt.confirmed_no_effect && !receipt.never_started {
            return Some(
                json!({
                    "replyId": id,
                    "historyLane": true,
                    "status": "error",
                    "errorCode": "FAILED",
                    "confirmedNoEffect": true,
                    "error": receipt.error,
                    "neverStarted": false
                }),
            );
        }
        if !receipt.boundary_rejected {
            return None;
        }
        Some(
            json!({"replyId":id,"historyLane":true,"status":if receipt.state == "unknown" { "error" } else { &receipt.state },
            "errorCode":if receipt.state == "unknown" { "OUTCOME_UNKNOWN" } else if receipt.state == "cancelled" { "CANCELLED" } else { "EXPIRED" }, "neverStarted":false}),
        )
    }

    pub fn status(&self, id: &str) -> Value {
        if let Some(slot) = self.slot(id) {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if receipt.state == "queued" && receipt.deadline_at <= now_ms() {
                receipt.state = "expired".into();
                receipt.never_started = true;
            }
            return serde_json::to_value(&*receipt)
                .unwrap_or_else(|_| json!({"requestId":id,"state":"unknown"}));
        }
        json!({"requestId":id,"state":"unknown","generation":self.generation})
    }

    pub fn cancel(&self, id: &str) -> Value {
        if let Some(slot) = self.slot(id) {
            let mut receipt = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if !receipt.terminal() {
                receipt.cancel_requested = true;
                if receipt.committing {
                    // COMMIT owns the result until it returns.
                    receipt.cancel_outcome_pending = true;
                } else if receipt.state == "queued" {
                    receipt.state = "cancelled".into();
                    receipt.never_started = true;
                } else {
                    // Hold the binding until the interrupt is sent. Unbinding lets
                    // the pool return this connection to a different request.
                    let bound = slot.interrupt.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some((_, interrupt)) = bound.as_ref() {
                        interrupt();
                    }
                }
            }
        }
        self.status(id)
    }

    pub fn revoke_gadget(&self, generation: String, invocation: Option<String>) -> bool {
        if generation.is_empty()
            || generation.len() > 128
            || invocation
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 64)
        {
            return false;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.revoked.len() >= MAX_REVOCATIONS {
            state.revoke_overflow = true;
        } else {
            state.revoked.insert((generation, invocation));
        }
        true
    }

    pub fn revoke_gadgets(&self, generations: Vec<String>) -> bool {
        if generations.len() > MAX_REVOCATIONS
            || generations
                .iter()
                .any(|generation| generation.is_empty() || generation.len() > 128)
        {
            return false;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for generation in generations {
            if state.revoked.contains(&(generation.clone(), None)) {
                continue;
            }
            if state.revoked.len() >= MAX_REVOCATIONS {
                state.revoke_overflow = true;
                break;
            }
            state.revoked.insert((generation, None));
        }
        true
    }

    fn gadget_allowed(
        &self,
        state: &State,
        id: Option<&str>,
        generation: &str,
        invocation: &str,
        expires_at: u64,
    ) -> bool {
        !state.revoke_overflow
            && !generation.is_empty()
            && !invocation.is_empty()
            && (expires_at == 0 || expires_at > now_ms())
            && !state.revoked.contains(&(generation.into(), None))
            && !state
                .revoked
                .contains(&(generation.into(), Some(invocation.into())))
            && id.is_none_or(|req_id| {
                state.records.get(req_id).is_some_and(|slot| {
                    let record = slot.receipt.lock().unwrap_or_else(|e| e.into_inner());
                    !record.cancel_requested
                        && record.deadline_at > now_ms()
                        && record.state == "running"
                })
            })
    }

    pub fn gadget_check(
        &self,
        id: Option<&str>,
        generation: &str,
        invocation: &str,
        expires_at: u64,
    ) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.gadget_allowed(&state, id, generation, invocation, expires_at)
    }

    pub fn gadget_commit<T>(
        &self,
        id: Option<&str>,
        generation: &str,
        invocation: &str,
        expires_at: u64,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !self.gadget_allowed(&state, id, generation, invocation, expires_at) {
            return None;
        }
        Some(commit())
    }
}

pub fn emit(frame: &Value) -> io::Result<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, frame)?;
    output.write_all(b"\n")?;
    output.flush()
}
pub fn begin(id: &Option<String>) -> bool {
    let Some(id) = id else {
        return false;
    };
    if let Some(control) = shared() {
        if let Err(error) = control.start(id) {
            let _ = emit(&error.frame(id));
            return false;
        }
    }
    CURRENT.with(|current| {
        current.replace(Some(id.clone()));
    });
    true
}
pub fn checkpoint() -> crate::Result<()> {
    let id = CURRENT.with(|current| current.borrow().clone());
    if let (Some(control), Some(id)) = (shared(), id) {
        control.checkpoint(&id)?;
    }
    Ok(())
}
/// Call only when this operation has provably produced no durable effect: for
/// example a failed BEGIN or an explicit, successful rollback before any commit.
pub fn known_failure() {
    let id = CURRENT.with(|current| current.borrow().clone());
    if let (Some(control), Some(id)) = (shared(), id) {
        control.known_failure(&id);
    }
}
pub fn commit(transaction: duckdb::Transaction<'_>) -> crate::Result<()> {
    let id = CURRENT.with(|current| current.borrow().clone());
    match (shared(), id) {
        (Some(control), Some(id)) => Ok(control.commit_duckdb_tx(&id, transaction)?),
        _ => transaction.commit().map_err(Into::into),
    }
}

pub fn commit_finalization(transaction: duckdb::Transaction<'_>, purpose: &'static str) -> crate::Result<()> {
    let id = CURRENT.with(|current| current.borrow().clone());
    match (shared(), id) {
        (Some(control), Some(id)) => {
            let permit = control.issue_finalization_permit(&id, purpose)
                .ok_or("Operation cannot finalize an external effect")?;
            Ok(control.commit_duckdb_finalization(&permit, transaction)?)
        }
        _ => transaction.commit().map_err(Into::into),
    }
}
pub fn overload(id: &Option<String>, code: &'static str) -> io::Result<()> {
    let id = id.as_deref().unwrap_or("");
    if let Some(control) = shared() {
        control.reject(id, "failed", code);
    }
    emit(
        &Rejection {
            status: "error",
            code,
            never_started: true,
        }
        .frame(id),
    )
}

/// Finish a request still owned by an admission queue without entering its running state.
pub fn reject_pending(id: &Option<String>, fallback: &'static str) -> io::Result<()> {
    let Some(id) = id.as_deref() else { return Ok(()) };
    let rejection = match shared() {
        Some(control) => control.reject_pending(id, fallback),
        None => Some(Rejection {
            status: if fallback == "EXPIRED" { "expired" } else { "error" },
            code: fallback,
            never_started: true,
        }),
    };
    rejection.map_or(Ok(()), |rejection| emit(&rejection.frame(id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{DuckDbEngine, DuckDbPoolConfig};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn pending_rejection_preserves_cancellation_and_emits_once() {
        let control = Control::memory();
        control.register("queued", "piStorage", now_ms() + 30_000, true).unwrap_or_else(|_| panic!("register"));
        assert_eq!(control.cancel("queued")["state"], "cancelled");
        let reply = control.reject_pending("queued", "EXPIRED").expect("original request needs a reply").frame("queued");
        assert_eq!(reply["errorCode"], "CANCELLED");
        assert_eq!(reply["neverStarted"], true);
        assert!(control.reject_pending("queued", "UNAVAILABLE").is_none());
        assert_eq!(control.status("queued")["state"], "cancelled");
    }

    #[test]
    fn queue_expiry_and_cancellation_never_start_and_running_is_not_falsely_cancelled() {
        let control = Control::memory();
        control
            .register("queued", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        assert_eq!(control.cancel("queued")["state"], "cancelled");
        assert!(control.start("queued").is_err());
        assert!(control.register("old", "write", now_ms() - 1, true).is_err());
        assert!(control.start("old").is_err());
        control
            .register("active", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control.start("active").unwrap_or_else(|_| panic!("start"));
        assert_eq!(control.cancel("active")["state"], "running");
        control.finish("active", true, Some(json!({"saved":true})), None);
        assert_eq!(control.status("active")["state"], "committed");
    }

    #[test]
    fn revoke_is_checked_at_commit_and_tombstone_overflow_fails_closed() {
        let control = Control::memory();
        assert!(control.gadget_check(None, "g", "i", 0));
        control.revoke_gadget("g".into(), Some("i".into()));
        let mut committed = false;
        assert!(
            control
                .gadget_commit(None, "g", "i", 0, || { committed = true })
                .is_none()
        );
        assert!(!committed);
        assert!(control.revoke_gadgets(vec!["client-a".into(), "client-b".into()]));
        assert!(!control.gadget_check(None, "client-a", "i", 0));
        assert!(!control.gadget_check(None, "client-b", "i", 0));
        assert!(!control.revoke_gadgets(vec!["valid".into(), "".into()]));
        assert!(
            control.gadget_check(None, "valid", "i", 0),
            "invalid batches are rejected atomically"
        );
        for i in 0..MAX_REVOCATIONS + 1 {
            control.revoke_gadget(format!("g{i}"), None);
        }
        assert!(!control.gadget_check(None, "g", "i", 0));
        assert!(!control.gadget_check(None, "brand-new", "i", 0));
    }

    #[test]
    fn restarted_generation_keeps_uncertain_operation_unknown() {
        let root = std::env::temp_dir().join(format!(
            "audit-receipts-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("app.db");
        let first = Control::open(&path).unwrap();
        first
            .register("active", "deleteLibrary", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        first.start("active").unwrap_or_else(|_| panic!("start"));
        drop(first);
        let second = Control::open(&path).unwrap();
        assert_eq!(second.status("active")["state"], "unknown");
        assert!(
            second
                .register("active", "deleteLibrary", now_ms() + 30_000, true)
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_at_sql_commit_rolls_back_and_unknown_receipts_are_not_evicted() {
        let control = Control::memory();
        let mut db = duckdb::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items (value BIGINT)").unwrap();
        control
            .register("cancel-before-commit", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control
            .start("cancel-before-commit")
            .unwrap_or_else(|_| panic!("start"));
        let transaction = db.transaction().unwrap();
        transaction.execute("INSERT INTO items VALUES(1)", []).unwrap();
        control.cancel("cancel-before-commit");
        assert!(control.commit_duckdb_tx("cancel-before-commit", transaction).is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        control.finish("cancel-before-commit", false, None, None);
        assert_eq!(control.status("cancel-before-commit")["state"], "cancelled");
        control
            .register("uncertain", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control.start("uncertain").unwrap_or_else(|_| panic!("start"));
        control.finish("uncertain", false, None, Some("outcome unknown".into()));
        for index in 0..MAX_RECORDS + 100 {
            let id = format!("read-{index}");
            control
                .register(&id, "read", now_ms() + 30_000, false)
                .unwrap_or_else(|_| panic!("admit"));
            control.start(&id).unwrap_or_else(|_| panic!("start"));
            control.finish(&id, true, Some(json!(true)), None);
        }
        assert_eq!(control.status("uncertain")["state"], "unknown");
        assert!(
            control
                .register("uncertain", "write", now_ms() + 30_000, true)
                .is_err()
        );
    }

    #[test]
    fn cancelled_queued_jobs_remain_pinned_until_dequeue() {
        let control = Control::memory();
        control
            .register("waiting", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control.cancel("waiting");
        for index in 0..MAX_RECORDS + 100 {
            let id = format!("read-{index}");
            control
                .register(&id, "read", now_ms() + 30_000, false)
                .unwrap_or_else(|_| panic!("admit"));
            control.start(&id).unwrap_or_else(|_| panic!("start"));
            control.finish(&id, true, None, None);
        }
        assert_eq!(control.status("waiting")["state"], "cancelled");
        assert!(
            control
                .register("waiting", "write", now_ms() + 30_000, true)
                .is_err()
        );
        let rejection = control.start("waiting").err().unwrap();
        assert_eq!(rejection.code, "CANCELLED");
        assert!(rejection.never_started);
    }

    #[test]
    fn proven_no_effect_is_failed_without_claiming_never_started() {
        let control = Control::memory();
        control
            .register("rolled-back", "write", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control.start("rolled-back").unwrap_or_else(|_| panic!("start"));
        control.known_failure("rolled-back");
        control.finish(
            "rolled-back",
            false,
            None,
            Some("transaction rolled back".into()),
        );
        assert_eq!(control.status("rolled-back")["state"], "failed");
        let frame = control.terminal_override("rolled-back").unwrap();
        assert_eq!(frame["errorCode"], "FAILED");
        assert_eq!(frame["neverStarted"], false);
    }

    #[test]
    fn cc06_cc09_duckdb_commit_unbinds_interrupt_and_supports_finalization_permit() {
        let dir = std::env::temp_dir().join(format!("mybuddy-rc-ddb-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let control = Control::memory();

        // Interrupt binding unbinds cleanly before returning connection to pool so next request isn't hit
        let hit_late = Arc::new(AtomicBool::new(false));
        control.register("req-1", "query", now_ms() + 30_000, false).unwrap();
        control.start("req-1").unwrap();
        {
            let mut conn = engine.checkout_writer(Duration::from_secs(2)).unwrap();
            conn.bind_request("req-1", Arc::clone(&control));
            // Drop returns connection to pool and calls unbind_interrupt
        }
        let cancelled_after_return = control.cancel("req-1");
        assert_eq!(cancelled_after_return["cancelRequested"], true);
        assert!(!hit_late.load(Ordering::Acquire));

        // Scoped RecoveryFinalizationPermit lets post-effect cleanup commit AFTER late cancel
        control.register("pi-cleanup", "piStop", now_ms() + 30_000, true).unwrap();
        control.start("pi-cleanup").unwrap();
        let permit = control.issue_finalization_permit("pi-cleanup", "pi_stop_cleanup").unwrap();
        control.cancel("pi-cleanup");

        let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
        let tx = w.conn_mut().transaction().unwrap();
        tx.execute(
            "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
             VALUES ('cleanup-note', 'g1', 1, 'finalized', '{}', 0, 10)",
            [],
        ).unwrap();
        control.commit_duckdb_finalization(&permit, tx).unwrap();
        let count: i64 = w.conn().query_row(
            "SELECT COUNT(*) FROM core_domain_notes WHERE entity_id = 'cleanup-note'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);

        drop(w);
        drop(engine);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pure_db_mutation_skips_file_receipt_and_marks_precommit_error_as_failed() {
        let dir = std::env::temp_dir().join(format!(
            "mybuddy-rc-puredb-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("app.duckdb");
        let control = Control::open(&db_path).unwrap();

        control
            .register_with_persistence("pure-db-err", "upsertTaskRecord", now_ms() + 30_000, true, false)
            .unwrap();
        control.start("pure-db-err").unwrap();
        let receipt_dir = db_path.with_extension("runtime-operations");
        assert_eq!(fs::read_dir(&receipt_dir).unwrap().count(), 0);

        control.finish(
            "pure-db-err",
            false,
            None,
            Some("Catalog Error: Table does not exist".into()),
        );
        assert_eq!(fs::read_dir(&receipt_dir).unwrap().count(), 0);
        assert_eq!(control.status("pure-db-err")["state"], "failed");
        let frame = control.terminal_override("pure-db-err").unwrap();
        assert_eq!(frame["errorCode"], "FAILED");
        assert_eq!(frame["confirmedNoEffect"], true);
        assert_eq!(frame["error"], "Catalog Error: Table does not exist");
        assert_eq!(frame["neverStarted"], false);

        let _ = fs::remove_dir_all(&dir);
    }
}
