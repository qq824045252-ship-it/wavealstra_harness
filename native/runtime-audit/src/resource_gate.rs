//! Canonical ordered multi-resource scheduler and bounded multi-worker
//! DuckDB write executor (`CC-01`..`CC-05`, `CC-07`).
//!
//! Enforces strict invariants:
//! - Acquire ALL `ResourceKey` permits atomically in canonical order (no hold-and-wait deadlocks).
//! - Wait outside DuckDB connections / MVCC snapshots; only open `BEGIN TRANSACTION` AFTER every
//!   required resource permit and `CommitShare(Shared)` are held.
//! - Queued cancellation/expiry removes waiters immediately so a cancelled queued job never runs.
//! - Pure-DB transactions with confirmed DuckDB conflict rollback may retry cleanly; side-effect
//!   closures never re-run automatically.

use crate::database::{DbError, DuckDbEngine, PooledConnection};
use crate::request_control::{Control, RecoveryFinalizationPermit};
use duckdb::Transaction;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResourceKey {
    DbLifecycle,
    CommitShare,
    PublisherOrder,
    ExecutionAdmission,
    Namespace(String, String),
    Entity(String, String),
    PiStore(String),
    MaintenanceCycle(String),
    ClaimPredicate(String),
    ContentHash(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LockMode {
    Shared = 0,
    Exclusive = 1,
}

#[derive(Debug, Clone)]
pub struct ResourceRequirement {
    pub key: ResourceKey,
    pub mode: LockMode,
}

impl ResourceRequirement {
    pub fn shared(key: ResourceKey) -> Self {
        Self {
            key,
            mode: LockMode::Shared,
        }
    }

    pub fn exclusive(key: ResourceKey) -> Self {
        Self {
            key,
            mode: LockMode::Exclusive,
        }
    }
}

/// Deduplicates and canonically sorts resource requirements so multi-resource plans are
/// globally deadlock-free (`CC-03`).
pub fn normalize_plan(reqs: Vec<ResourceRequirement>) -> Vec<ResourceRequirement> {
    let mut map: BTreeMap<ResourceKey, LockMode> = BTreeMap::new();
    for req in reqs {
        map.entry(req.key)
            .and_modify(|existing| {
                if req.mode > *existing {
                    *existing = req.mode;
                }
            })
            .or_insert(req.mode);
    }
    map.into_iter()
        .map(|(key, mode)| ResourceRequirement { key, mode })
        .collect()
}

#[derive(Default)]
struct HeldState {
    shared_count: usize,
    exclusive_held: bool,
}

struct GateWaiter {
    id: u64,
    plan: Vec<ResourceRequirement>,
}

struct GateInner {
    held: HashMap<ResourceKey, HeldState>,
    waiters: VecDeque<GateWaiter>,
    next_waiter_id: u64,
    queue_capacity: usize,
    max_waiters_observed: usize,
    generation: u64,
}

type GateState = Arc<(Mutex<GateInner>, Condvar)>;

fn changed(inner: &mut GateInner, cv: &Condvar) {
    inner.generation = inner.generation.wrapping_add(1);
    cv.notify_all();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateAcquireError {
    Overloaded { never_started: bool },
    Cancelled { never_started: bool },
    TimedOut { never_started: bool },
}

pub struct ResourceGate {
    state: GateState,
}

pub struct ResourceLease {
    state: GateState,
    id: u64,
    plan: Vec<ResourceRequirement>,
}

impl ResourceLease {
    pub fn retain_only(&mut self, key: &ResourceKey) {
        self.release_where(|req| &req.key != key);
    }

    pub fn suspend(self) -> SuspendedResourceLease {
        SuspendedResourceLease { state: self.state.clone(), id: self.id, plan: self.plan.clone() }
    }

    fn release_where(&mut self, release: impl Fn(&ResourceRequirement) -> bool) {
        if self.plan.is_empty() {
            return;
        }
        let (lock, cv) = &*self.state;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let previous_len = self.plan.len();
        self.plan.retain(|req| {
            if !release(req) {
                return true;
            }
            if let Some(entry) = inner.held.get_mut(&req.key) {
                match req.mode {
                    LockMode::Shared => entry.shared_count = entry.shared_count.saturating_sub(1),
                    LockMode::Exclusive => entry.exclusive_held = false,
                }
                if entry.shared_count == 0 && !entry.exclusive_held {
                    inner.held.remove(&req.key);
                }
            }
            false
        });
        if self.plan.len() != previous_len {
            changed(&mut inner, cv);
        }
    }
}

impl Drop for ResourceLease {
    fn drop(&mut self) {
        self.release_where(|_| true);
    }
}

/// Dropping a pending ticket releases its place in the queue.
pub struct ResourceTicket {
    state: GateState,
    id: Option<u64>,
}

fn plans_conflict(left: &[ResourceRequirement], right: &[ResourceRequirement]) -> bool {
    left.iter().any(|a| right.iter().any(|b| {
        a.key == b.key && (a.mode == LockMode::Exclusive || b.mode == LockMode::Exclusive)
    }))
}

impl ResourceTicket {
    pub fn try_grant(&mut self) -> Option<ResourceLease> {
        let id = self.id?;
        let (lock, cv) = &*self.state;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let position = inner.waiters.iter().position(|waiter| waiter.id == id)?;
        let plan = &inner.waiters[position].plan;
        if !ResourceGate::all_grantable(&inner.held, plan)
            || inner.waiters.iter().take(position).any(|older| plans_conflict(&older.plan, plan))
        {
            return None;
        }
        let waiter = inner.waiters.remove(position)?;
        ResourceGate::apply_grant(&mut inner.held, &waiter.plan);
        self.id = None;
        changed(&mut inner, cv);
        Some(ResourceLease { state: self.state.clone(), id, plan: waiter.plan })
    }
}

/// An already-started phase can release resources without surrendering its order
/// to newer requests that may themselves be waiting for that phase's worker.
pub struct SuspendedResourceLease {
    state: GateState,
    id: u64,
    plan: Vec<ResourceRequirement>,
}

impl SuspendedResourceLease {
    pub fn resume(self, timeout: Duration) -> Result<ResourceLease, GateAcquireError> {
        let Self { state, id, plan } = self;
        {
            let (lock, cv) = &*state;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            let position = inner.waiters.iter().position(|waiter| waiter.id > id).unwrap_or(inner.waiters.len());
            // Only an existing lease can enter here. The number of these tickets
            // is bounded by the number of phases already assigned to workers.
            inner.waiters.insert(position, GateWaiter { id, plan });
            changed(&mut inner, cv);
        }
        let gate = ResourceGate { state: state.clone() };
        gate.wait_for_ticket(ResourceTicket { state, id: Some(id) }, Instant::now() + timeout, || false)
    }
}

impl Drop for ResourceTicket {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else { return };
        let (lock, cv) = &*self.state;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        inner.waiters.retain(|waiter| waiter.id != id);
        changed(&mut inner, cv);
    }
}

impl ResourceGate {
    pub fn new(queue_capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new((
                Mutex::new(GateInner {
                    held: HashMap::new(),
                    waiters: VecDeque::new(),
                    next_waiter_id: 1,
                    queue_capacity: queue_capacity.max(1),
                    max_waiters_observed: 0,
                    generation: 0,
                }),
                Condvar::new(),
            )),
        })
    }

    pub fn max_waiters_observed(&self) -> usize {
        self.state.0.lock().unwrap_or_else(|e| e.into_inner()).max_waiters_observed
    }

    pub fn generation(&self) -> u64 {
        self.state.0.lock().unwrap_or_else(|e| e.into_inner()).generation
    }

    pub fn wake(&self) {
        let (lock, cv) = &*self.state;
        changed(&mut lock.lock().unwrap_or_else(|e| e.into_inner()), cv);
    }

    pub fn wait_for_change(&self, generation: u64, timeout: Duration) {
        let (lock, cv) = &*self.state;
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        drop(cv.wait_timeout_while(inner, timeout, |current| current.generation == generation)
            .unwrap_or_else(|e| e.into_inner()));
    }

    pub fn enqueue(&self, reqs: Vec<ResourceRequirement>) -> Result<ResourceTicket, GateAcquireError> {
        let plan = normalize_plan(reqs);
        let (lock, cv) = &*self.state;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        if inner.waiters.len() >= inner.queue_capacity {
            return Err(GateAcquireError::Overloaded { never_started: true });
        }
        let id = inner.next_waiter_id;
        inner.next_waiter_id = inner.next_waiter_id.wrapping_add(1);
        inner.waiters.push_back(GateWaiter { id, plan });
        inner.max_waiters_observed = inner.max_waiters_observed.max(inner.waiters.len());
        changed(&mut inner, cv);
        Ok(ResourceTicket { state: self.state.clone(), id: Some(id) })
    }

    fn all_grantable(held: &HashMap<ResourceKey, HeldState>, plan: &[ResourceRequirement]) -> bool {
        for req in plan {
            if let Some(entry) = held.get(&req.key) {
                match req.mode {
                    LockMode::Shared => {
                        if entry.exclusive_held {
                            return false;
                        }
                    }
                    LockMode::Exclusive => {
                        if entry.exclusive_held || entry.shared_count > 0 {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    fn apply_grant(held: &mut HashMap<ResourceKey, HeldState>, plan: &[ResourceRequirement]) {
        for req in plan {
            let entry = held.entry(req.key.clone()).or_default();
            match req.mode {
                LockMode::Shared => entry.shared_count += 1,
                LockMode::Exclusive => entry.exclusive_held = true,
            }
        }
    }

    /// Acquires all resources atomically. Cancelled or expired waiters are removed without
    /// acquiring any lock so cancelled queued work can never execute (`CC-05`).
    pub fn acquire(
        &self,
        reqs: Vec<ResourceRequirement>,
        timeout: Duration,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<ResourceLease, GateAcquireError> {
        if is_cancelled() {
            return Err(GateAcquireError::Cancelled { never_started: true });
        }
        let deadline = Instant::now() + timeout;
        self.wait_for_ticket(self.enqueue(reqs)?, deadline, is_cancelled)
    }

    fn wait_for_ticket(
        &self,
        mut ticket: ResourceTicket,
        deadline: Instant,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<ResourceLease, GateAcquireError> {
        loop {
            let generation = self.generation();
            if is_cancelled() {
                return Err(GateAcquireError::Cancelled { never_started: true });
            }
            if let Some(lease) = ticket.try_grant() {
                return Ok(lease);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(GateAcquireError::TimedOut { never_started: true });
            }
            let wait_slice = deadline.saturating_duration_since(now).min(Duration::from_millis(25));
            self.wait_for_change(generation, wait_slice);
        }
    }
}

#[derive(Debug, Clone)]
pub enum WriteExecError {
    Rejected { code: &'static str, never_started: bool },
    Db(DbError),
    Other(String),
}

impl From<DbError> for WriteExecError {
    fn from(value: DbError) -> Self {
        Self::Db(value)
    }
}

impl From<Box<dyn std::error::Error + Send + Sync>> for WriteExecError {
    fn from(value: Box<dyn std::error::Error + Send + Sync>) -> Self {
        let msg = value.to_string();
        if msg.contains("CANCELLED") {
            Self::Rejected { code: "CANCELLED", never_started: false }
        } else if msg.contains("EXPIRED") {
            Self::Rejected { code: "EXPIRED", never_started: false }
        } else {
            Self::Other(msg)
        }
    }
}

/// Multi-worker bounded database write coordinator using `DuckDbEngine` independent connections
/// and `ResourceGate` entity-level scheduling (`CC-01`..`CC-05`, `CC-07`).
pub struct DatabaseWriteExecutor {
    engine: Arc<DuckDbEngine>,
    gate: Arc<ResourceGate>,
    control: Arc<Control>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

impl DatabaseWriteExecutor {
    pub fn new(engine: Arc<DuckDbEngine>, gate: Arc<ResourceGate>, control: Arc<Control>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            gate,
            control,
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
        })
    }

    pub fn max_in_flight(&self) -> usize {
        self.max_in_flight.load(Ordering::Acquire)
    }

    pub fn gate(&self) -> &Arc<ResourceGate> {
        &self.gate
    }

    pub fn engine(&self) -> &Arc<DuckDbEngine> {
        &self.engine
    }

    /// Acquires `ResourceKey` permits + `CommitShare(Shared)` BEFORE opening a DuckDB connection
    /// or `BEGIN TRANSACTION`, binds `(request_id, epoch)` if `request_id` is supplied, runs `op`,
    /// and commits via lock-free `Control::commit_duckdb_tx`.
    pub fn run_write<T>(
        &self,
        request_id: Option<&str>,
        mut plan: Vec<ResourceRequirement>,
        timeout: Duration,
        mut op: impl FnMut(&Transaction<'_>) -> Result<T, WriteExecError>,
    ) -> Result<T, WriteExecError> {
        // Every ordinary write holds DbLifecycle(Shared) and CommitShare(Shared).
        plan.push(ResourceRequirement::shared(ResourceKey::DbLifecycle));
        plan.push(ResourceRequirement::shared(ResourceKey::CommitShare));

        let lease = self
            .gate
            .acquire(plan, timeout, || {
                request_id.is_some_and(|id| self.control.is_cancelled_or_expired(id))
            })
            .map_err(|err| match err {
                GateAcquireError::Overloaded { never_started } => WriteExecError::Rejected {
                    code: "OVERLOADED",
                    never_started,
                },
                GateAcquireError::Cancelled { never_started } => WriteExecError::Rejected {
                    code: "CANCELLED",
                    never_started,
                },
                GateAcquireError::TimedOut { never_started } => WriteExecError::Rejected {
                    code: "TIMEOUT",
                    never_started,
                },
            })?;

        let cur = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        self.max_in_flight.fetch_max(cur, Ordering::AcqRel);
        let result = (|| -> Result<T, WriteExecError> {
            let mut conn_guard: PooledConnection = self.engine.checkout_writer(timeout)?;
            if let Some(id) = request_id {
                conn_guard.bind_request(id, Arc::clone(&self.control));
            }
            let tx = conn_guard
                .conn_mut()
                .transaction()
                .map_err(|e| WriteExecError::Db(DbError::from(e)))?;
            let val = op(&tx)?;
            if let Some(id) = request_id {
                self.control
                    .commit_duckdb_tx(id, tx)
                    .map_err(|e| WriteExecError::Db(DbError::from(e)))?;
            } else {
                tx.commit().map_err(|e| WriteExecError::Db(DbError::from(e)))?;
            }
            Ok(val)
        })();
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        drop(lease);
        result
    }

    /// Retries pure-DB transactions ONLY when DuckDB confirms rollback due to write-write conflict.
    /// Non-conflict errors, cancellations, and external side-effect ops are NEVER retried (`CC-07`).
    pub fn run_pure_db_with_retry<T>(
        &self,
        request_id: Option<&str>,
        plan: Vec<ResourceRequirement>,
        timeout: Duration,
        max_attempts: usize,
        mut pure_db_op: impl FnMut(&Transaction<'_>, usize) -> Result<T, WriteExecError>,
    ) -> Result<T, WriteExecError> {
        let attempts = max_attempts.max(1);
        for attempt in 0..attempts {
            match self.run_write(request_id, plan.clone(), timeout, |tx| pure_db_op(tx, attempt)) {
                Ok(v) => return Ok(v),
                Err(WriteExecError::Db(DbError::Conflict(msg))) if attempt + 1 < attempts => {
                    std::thread::sleep(Duration::from_millis((attempt as u64 + 1) * 2));
                    let _ = msg;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }

    /// Commits bounded post-effect recovery/cleanup/final-receipt state even after late cancel
    /// using an explicit scoped `RecoveryFinalizationPermit` (`CC-09`).
    pub fn run_finalization_write<T>(
        &self,
        permit: &RecoveryFinalizationPermit,
        mut plan: Vec<ResourceRequirement>,
        timeout: Duration,
        mut op: impl FnMut(&Transaction<'_>) -> Result<T, WriteExecError>,
    ) -> Result<T, WriteExecError> {
        plan.push(ResourceRequirement::shared(ResourceKey::DbLifecycle));
        plan.push(ResourceRequirement::shared(ResourceKey::CommitShare));
        let _lease = self
            .gate
            .acquire(plan, timeout, || false)
            .map_err(|e| WriteExecError::Other(format!("finalization gate failed: {e:?}")))?;
        let mut conn_guard = self.engine.checkout_writer(timeout)?;
        let tx = conn_guard
            .conn_mut()
            .transaction()
            .map_err(|e| WriteExecError::Db(DbError::from(e)))?;
        let val = op(&tx)?;
        self.control
            .commit_duckdb_finalization(permit, tx)
            .map_err(|e| WriteExecError::Db(DbError::from(e)))?;
        Ok(val)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn older_exclusive_request_blocks_younger_shares_but_not_independent_work() {
        let gate = ResourceGate::new(8);
        let key = ResourceKey::CommitShare;
        let active = gate.acquire(vec![ResourceRequirement::shared(key.clone())], Duration::from_secs(1), || false).unwrap();
        let mut cut = gate.enqueue(vec![ResourceRequirement::exclusive(key.clone())]).unwrap();
        let mut newer = gate.enqueue(vec![ResourceRequirement::shared(key)]).unwrap();
        let mut unrelated = gate.enqueue(vec![ResourceRequirement::exclusive(ResourceKey::PiStore("other".into()))]).unwrap();

        assert!(cut.try_grant().is_none());
        assert!(newer.try_grant().is_none());
        let independent = unrelated.try_grant().expect("independent store is runnable");
        drop(active);
        let snapshot = cut.try_grant().expect("oldest conflicting ticket receives the cut");
        assert!(newer.try_grant().is_none());
        drop(snapshot);
        assert!(newer.try_grant().is_some());
        drop(independent);
    }

    #[test]
    fn started_phase_can_resume_ahead_of_conflicting_queued_work() {
        let gate = ResourceGate::new(1);
        let plan = vec![ResourceRequirement::exclusive(ResourceKey::PiStore("store".into()))];
        let writing = gate.acquire(plan.clone(), Duration::from_secs(1), || false).unwrap();
        let mut waiting = gate.enqueue(plan).unwrap();
        let suspended = writing.suspend();

        let resumed = suspended.resume(Duration::from_millis(50)).expect("started phase must still be able to finalize");
        assert!(waiting.try_grant().is_none());
        drop(resumed);
        assert!(waiting.try_grant().is_some());
    }
    use crate::database::DuckDbPoolConfig;
    use std::path::PathBuf;
    use std::sync::Barrier;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-rg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cc01_disjoint_entities_overlap_inside_db_barrier_while_same_entity_serializes() {
        let dir = temp_dir("cc01");
        let db_path = dir.join("app.duckdb");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        let control = Control::memory();
        let gate = ResourceGate::new(32);
        let exec = DatabaseWriteExecutor::new(Arc::clone(&engine), Arc::clone(&gate), Arc::clone(&control));

        // Prove 4 independent entities genuinely overlap at DML barrier inside separate DuckDB write txs!
        let barrier = Arc::new(Barrier::new(4));
        let mut handles = Vec::new();
        for i in 0..4 {
            let ex = Arc::clone(&exec);
            let b = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                ex.run_write(
                    None,
                    vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), format!("t-{i}")))],
                    Duration::from_secs(5),
                    |tx| {
                        tx.execute(
                            "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                             VALUES (?, 'g', 1, 'ok', '{}', 0, 1)",
                            duckdb::params![format!("t-{i}")],
                        ).map_err(|e| WriteExecError::Db(DbError::from(e)))?;
                        b.wait();
                        Ok(())
                    },
                )
            }));
        }
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert!(exec.max_in_flight() >= 4, "disjoint entities must overlap inside writer pool");

        // Now prove same entity serializes cleanly without conflict error!
        let active_same = Arc::new(AtomicUsize::new(0));
        let max_same = Arc::new(AtomicUsize::new(0));
        let mut same_handles = Vec::new();
        for i in 0..4 {
            let ex = Arc::clone(&exec);
            let act = Arc::clone(&active_same);
            let mx = Arc::clone(&max_same);
            same_handles.push(std::thread::spawn(move || {
                ex.run_write(
                    None,
                    vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "shared-t".into()))],
                    Duration::from_secs(5),
                    |tx| {
                        let cur = act.fetch_add(1, Ordering::AcqRel) + 1;
                        mx.fetch_max(cur, Ordering::AcqRel);
                        std::thread::sleep(Duration::from_millis(15));
                        tx.execute(
                            "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                             VALUES (?, 'g', 1, 'seq', '{}', 0, 1)",
                            duckdb::params![format!("shared-note-{i}")],
                        ).map_err(|e| WriteExecError::Db(DbError::from(e)))?;
                        act.fetch_sub(1, Ordering::AcqRel);
                        Ok(())
                    },
                )
            }));
        }
        for h in same_handles {
            h.join().unwrap().unwrap();
        }
        assert_eq!(max_same.load(Ordering::Acquire), 1, "same entity must stay strictly serialized");

        drop(exec);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cc03_parent_child_mutual_exclusion_and_inverse_resource_deadlock_freedom() {
        let gate = ResourceGate::new(64);
        // Thread 1 requests [B, A], Thread 2 requests [A, B] repeatedly: canonical ordering prevents deadlock!
        let g1 = Arc::clone(&gate);
        let g2 = Arc::clone(&gate);
        let h1 = std::thread::spawn(move || {
            for _ in 0..50 {
                let _l = g1.acquire(
                    vec![
                        ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "b".into())),
                        ResourceRequirement::exclusive(ResourceKey::Namespace("workspace".into(), "ws1".into())),
                    ],
                    Duration::from_secs(3),
                    || false,
                ).unwrap();
            }
        });
        let h2 = std::thread::spawn(move || {
            for _ in 0..50 {
                let _l = g2.acquire(
                    vec![
                        ResourceRequirement::shared(ResourceKey::Namespace("workspace".into(), "ws1".into())),
                        ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "b".into())),
                    ],
                    Duration::from_secs(3),
                    || false,
                ).unwrap();
            }
        });
        h1.join().unwrap();
        h2.join().unwrap();
    }

    #[test]
    fn cc05_cancelled_queued_waiter_never_executes_and_bounded_queue_rejects_overload() {
        let gate = ResourceGate::new(2);
        let holder = gate
            .acquire(
                vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "hot".into()))],
                Duration::from_secs(1),
                || false,
            )
            .unwrap();

        let cancelled_flag = Arc::new(AtomicBool::new(false));
        let flag_c = Arc::clone(&cancelled_flag);
        let gate_c = Arc::clone(&gate);
        let ran = Arc::new(AtomicBool::new(false));
        let ran_c = Arc::clone(&ran);
        let h_cancel = std::thread::spawn(move || {
            let res = gate_c.acquire(
                vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "hot".into()))],
                Duration::from_secs(5),
                || flag_c.load(Ordering::Acquire),
            );
            if res.is_ok() {
                ran_c.store(true, Ordering::Release);
            }
            res.err()
        });
        // Give waiter a moment to enter queue
        std::thread::sleep(Duration::from_millis(30));

        // Fill capacity=2 with waiter #2
        let gate_w2 = Arc::clone(&gate);
        let h_w2 = std::thread::spawn(move || {
            gate_w2
                .acquire(
                    vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "hot".into()))],
                    Duration::from_millis(200),
                    || false,
                )
                .map(|_| ())
        });
        std::thread::sleep(Duration::from_millis(30));

        // 3rd waiter hits queue cap=2 immediately with Overloaded!
        let overload_res = gate.acquire(
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "hot".into()))],
            Duration::from_secs(1),
            || false,
        );
        assert!(matches!(overload_res, Err(GateAcquireError::Overloaded { never_started: true })));

        // Cancel waiter #1 BEFORE releasing holder -> must return Cancelled and never run!
        cancelled_flag.store(true, Ordering::Release);
        let cancel_err = h_cancel.join().unwrap();
        assert!(matches!(cancel_err, Some(GateAcquireError::Cancelled { never_started: true })));
        drop(holder);
        let _ = h_w2.join().unwrap();
        assert!(!ran.load(Ordering::Acquire));
    }

    #[test]
    fn cc07_pure_db_conflict_retries_cleanly_to_success() {
        let dir = temp_dir("cc07");
        let db_path = dir.join("app.duckdb");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        let control = Control::memory();
        let gate = ResourceGate::new(32);
        let exec = DatabaseWriteExecutor::new(Arc::clone(&engine), gate, control);
        let attempts = Arc::new(AtomicUsize::new(0));
        let att_c = Arc::clone(&attempts);
        exec.run_pure_db_with_retry(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "r1".into()))],
            Duration::from_secs(2),
            3,
            |tx, attempt| {
                att_c.fetch_add(1, Ordering::AcqRel);
                if attempt == 0 {
                    return Err(WriteExecError::Db(DbError::Conflict("simulated mvcc conflict".into())));
                }
                tx.execute(
                    "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                     VALUES ('r1', 'g', 1, 'retried', '{}', 0, 1)",
                    [],
                ).map_err(|e| WriteExecError::Db(DbError::from(e)))?;
                Ok(())
            },
        ).unwrap();
        assert_eq!(attempts.load(Ordering::Acquire), 2);
        drop(exec);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
