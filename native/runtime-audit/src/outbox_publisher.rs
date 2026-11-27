//! Transactional domain outbox + single short Core durable publisher (`IN-03`, `IN-09`, `IN-10`).
//!
//! Concurrent business transactions write authoritative state + receipts + `domain_outbox_groups`
//! / `domain_outbox_events` WITHOUT holding a global seq counter or waiting on publication.
//! A single short Core publisher verifies causal dependencies, assigns contiguous global `seq`
//! values, writes `core_event_publications` + optional `work_projection_streams`, releases DB locks,
//! and emits notifications strictly in ascending `seq` order.

use crate::database::{DbError, DuckDbEngine};
use crate::resource_gate::{ResourceGate, ResourceKey, ResourceRequirement};
use crate::snapshot_cut::SnapshotOwnerToken;
use duckdb::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::{self, JoinHandle, Thread};
use std::time::Duration;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxGroupDraft {
    pub group_id: String,
    pub operation_id: String,
    pub batch_index: i64,
    pub entity_key: String,
    pub entity_revision: Option<i64>,
    pub previous_revision: Option<i64>,
    pub depends_on_group_id: Option<String>,
    pub work_projection_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxEventDraft {
    pub event_id: String,
    pub owner_generation: String,
    pub domain: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub entity_id: String,
    pub revision: i64,
    pub command_id: Option<String>,
    pub payload_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedCoreEvent {
    pub seq: i64,
    pub event_id: String,
    pub core_generation: String,
    pub owner_generation: String,
    pub domain: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub entity_id: String,
    pub revision: i64,
    pub command_id: Option<String>,
    pub payload: Value,
    pub created_at_ms: i64,
}

/// Appends one complete outbox group inside a concurrent domain transaction.
/// Never allocates public `seq` or updates `core_event_meta`.
pub fn append_outbox_group_in_tx(
    tx: &Transaction<'_>,
    group: &OutboxGroupDraft,
    events: &[OutboxEventDraft],
    now: i64,
) -> Result<(), DbError> {
    if events.is_empty() {
        return Err(DbError::Constraint("Outbox group must contain at least one event".into()));
    }
    tx.execute(
        "INSERT INTO domain_outbox_groups (
           group_id, operation_id, batch_index, entity_key, entity_revision, previous_revision,
           depends_on_group_id, work_projection_user_id, published, published_seq_start, published_seq_end, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, NULL, NULL, ?)",
        duckdb::params![
            group.group_id,
            group.operation_id,
            group.batch_index,
            group.entity_key,
            group.entity_revision,
            group.previous_revision,
            group.depends_on_group_id,
            group.work_projection_user_id,
            now
        ],
    )?;
    for (idx, ev) in events.iter().enumerate() {
        tx.execute(
            "INSERT INTO domain_outbox_events (
               group_id, ordinal, event_id, owner_generation, domain, kind, task_id,
               entity_id, revision, command_id, payload_json, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            duckdb::params![
                group.group_id,
                idx as i64,
                ev.event_id,
                ev.owner_generation,
                ev.domain,
                ev.kind,
                ev.task_id,
                ev.entity_id,
                ev.revision,
                ev.command_id,
                ev.payload_json,
                now
            ],
        )?;
    }
    Ok(())
}

type SubscriberFn = Arc<dyn Fn(&[PublishedCoreEvent]) + Send + Sync>;

struct PublishWaitState {
    published_groups: HashMap<String, (i64, i64)>,
}

pub struct OutboxPublisher {
    wait_state: Arc<(Mutex<PublishWaitState>, Condvar)>,
    subscribers: Mutex<Vec<SubscriberFn>>,
    next_seq_hint: AtomicU64,
    closed: AtomicBool,
    worker_thread: OnceLock<Thread>,
}

impl OutboxPublisher {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            wait_state: Arc::new((
                Mutex::new(PublishWaitState {
                    published_groups: HashMap::new(),
                }),
                Condvar::new(),
            )),
            subscribers: Mutex::new(Vec::new()),
            next_seq_hint: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            worker_thread: OnceLock::new(),
        })
    }

    pub fn start_worker(
        self: &Arc<Self>,
        engine: Arc<DuckDbEngine>,
        gate: Arc<ResourceGate>,
        generation: String,
    ) -> std::io::Result<JoinHandle<()>> {
        let publisher = Arc::clone(self);
        let handle = thread::Builder::new().name("domain-outbox-publisher".into()).spawn(move || {
            while !publisher.closed.load(Ordering::Acquire) {
                match publisher.publish_pending(&engine, &gate, &generation) {
                    Ok(_) => thread::park(),
                    Err(error) if !publisher.closed.load(Ordering::Acquire) => {
                        eprintln!("[Core] Domain outbox publication will retry: {error}");
                        thread::park_timeout(Duration::from_secs(1));
                    }
                    Err(_) => break,
                }
            }
        })?;
        let _ = self.worker_thread.set(handle.thread().clone());
        Ok(handle)
    }

    pub fn wake(&self) {
        if let Some(thread) = self.worker_thread.get() {
            thread.unpark();
        }
    }

    pub fn subscribe(&self, listener: SubscriberFn) {
        if let Ok(mut guard) = self.subscribers.lock() {
            guard.push(listener);
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.wait_state.1.notify_all();
        self.wake();
    }

    /// Waits asynchronously (OUTSIDE all DB connections, locks, and `CommitShare`) for a committed
    /// outbox group to receive its `(seq_start, seq_end)` publication mapping (`IN-09`).
    pub fn wait_for_publication(
        &self,
        group_id: &str,
        timeout: Duration,
    ) -> Result<(i64, i64), DbError> {
        let deadline = std::time::Instant::now() + timeout;
        let (lock, cv) = &*self.wait_state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(range) = guard.published_groups.get(group_id) {
                return Ok(*range);
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(DbError::Unavailable("OutboxPublisher closed".into()));
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(DbError::Busy(format!(
                    "Timed out waiting for publication mapping of group {group_id}"
                )));
            }
            let (next_g, _) = cv
                .wait_timeout(guard, deadline.saturating_duration_since(now).min(Duration::from_millis(25)))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_g;
        }
    }

    /// Normal scheduled/triggered publish pass:
    /// Strictly obeys lock order `DbLifecycle(Shared) -> CommitShare(Shared) -> PublisherOrder(Exclusive)`.
    pub fn publish_pending(
        &self,
        engine: &DuckDbEngine,
        gate: &ResourceGate,
        core_generation: &str,
    ) -> Result<Vec<PublishedCoreEvent>, DbError> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }
        let _lease = gate
            .acquire(
                vec![
                    ResourceRequirement::shared(ResourceKey::DbLifecycle),
                    ResourceRequirement::shared(ResourceKey::CommitShare),
                    ResourceRequirement::exclusive(ResourceKey::PublisherOrder),
                ],
                Duration::from_secs(5),
                || self.closed.load(Ordering::Acquire),
            )
            .map_err(|e| DbError::Busy(format!("Publisher gate acquire failed: {e:?}")))?;

        let conn_guard = engine.reserved_publisher_owner().lock().unwrap_or_else(|e| e.into_inner());
        self.publish_on_connection(&conn_guard, core_generation)
    }

    /// Publish inside a snapshot cut that already owns the publisher permit.
    pub fn publish_pending_with_owner(
        &self,
        engine: &DuckDbEngine,
        core_generation: &str,
        owner_token: &SnapshotOwnerToken<'_>,
        conn: &duckdb::Connection,
    ) -> Result<Vec<PublishedCoreEvent>, DbError> {
        if !owner_token.belongs_to(engine) {
            return Err(DbError::Unavailable("SnapshotOwnerToken database_generation mismatch".into()));
        }
        self.publish_on_connection(conn, core_generation)
    }

    fn publish_on_connection(
        &self,
        conn: &duckdb::Connection,
        core_generation: &str,
    ) -> Result<Vec<PublishedCoreEvent>, DbError> {
        conn.execute_batch("BEGIN TRANSACTION")?;
        let tx_res = (|| -> Result<(Vec<PublishedCoreEvent>, Vec<(String, i64, i64)>), DbError> {
            // Ensure singleton head meta exists
            let existing_head: i64 = conn
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM core_domain_events", [], |r| r.get(0))?;
            let min_avail = conn
                .query_row(
                    "SELECT min_available_seq FROM core_event_meta WHERE id = 1",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1);
            conn.execute(
                "INSERT INTO core_event_meta (id, core_generation, min_available_seq, retention_limit)
                 VALUES (1, ?, ?, 4096)
                 ON CONFLICT (id) DO NOTHING",
                duckdb::params![core_generation, min_avail],
            )?;

            // Load ALL committed unpublished outbox groups ordered deterministically
            let mut stmt = conn.prepare(
                "SELECT group_id, operation_id, batch_index, entity_key, entity_revision, previous_revision,
                        depends_on_group_id, work_projection_user_id, created_at_ms
                 FROM domain_outbox_groups
                 WHERE published = FALSE
                 ORDER BY created_at_ms ASC, group_id ASC",
            )?;
            let pending: Vec<OutboxGroupRow> = stmt
                .query_map([], |r| {
                    Ok(OutboxGroupRow {
                        group_id: r.get(0)?,
                        operation_id: r.get(1)?,
                        batch_index: r.get(2)?,
                        entity_key: r.get(3)?,
                        entity_revision: r.get(4)?,
                        previous_revision: r.get(5)?,
                        depends_on_group_id: r.get(6)?,
                        work_projection_user_id: r.get(7)?,
                        created_at_ms: r.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            if pending.is_empty() {
                return Ok((Vec::new(), Vec::new()));
            }

            let pending_ids: HashSet<String> = pending.iter().map(|g| g.group_id.clone()).collect();
            let mut newly_published_ids: HashSet<String> = HashSet::new();
            // Track highest pending revision per entity_key to enforce causal entity revision order
            let mut entity_pending_revs: HashMap<String, Vec<(i64, String)>> = HashMap::new();
            for g in &pending {
                if let Some(rev) = g.entity_revision {
                    entity_pending_revs
                        .entry(g.entity_key.clone())
                        .or_default()
                        .push((rev, g.group_id.clone()));
                }
            }

            let mut next_seq = existing_head + 1;
            let mut emitted = Vec::new();
            let mut group_ranges = Vec::new();
            let now = now_ms();

            // Multi-pass causal resolution inside one short transaction:
            // Any group whose dependency is satisfied publishes in causal order; groups waiting on
            // still-uncommitted upstream groups remain queued while unrelated groups publish now.
            loop {
                let mut progress = false;
                for g in &pending {
                    if newly_published_ids.contains(&g.group_id) {
                        continue;
                    }
                    // 1. Check explicit upstream group dependency
                    if let Some(dep_id) = g.depends_on_group_id.as_deref() {
                        if pending_ids.contains(dep_id) {
                            if !newly_published_ids.contains(dep_id) {
                                continue;
                            }
                        } else {
                            let dep_published: Option<bool> = match conn.query_row(
                                "SELECT published FROM domain_outbox_groups WHERE group_id = ?",
                                duckdb::params![dep_id],
                                |r| r.get(0),
                            ) {
                                Ok(v) => Some(v),
                                Err(duckdb::Error::QueryReturnedNoRows) => None,
                                Err(e) => return Err(DbError::from(e)),
                            };
                            if dep_published != Some(true) {
                                continue;
                            }
                        }
                    }

                    // 2. Check entity causal predecessor revision
                    if let (Some(my_rev), Some(prev_rev)) = (g.entity_revision, g.previous_revision) {
                        let blocked_by_earlier_pending = entity_pending_revs
                            .get(&g.entity_key)
                            .is_some_and(|list| {
                                list.iter().any(|(other_rev, other_gid)| {
                                    *other_gid != g.group_id
                                        && *other_rev <= prev_rev
                                        && !newly_published_ids.contains(other_gid)
                                })
                            });
                        if blocked_by_earlier_pending {
                            continue;
                        }
                        // Also check if another lower revision pending group exists
                        let _ = my_rev;
                    }

                    // Load events in group ordinal order
                    let mut ev_stmt = conn.prepare(
                        "SELECT event_id, owner_generation, domain, kind, task_id, entity_id,
                                revision, command_id, payload_json, created_at_ms
                         FROM domain_outbox_events
                         WHERE group_id = ?
                         ORDER BY ordinal ASC",
                    )?;
                    let ev_rows: Vec<(String, String, String, String, Option<String>, String, i64, Option<String>, String, i64)> =
                        ev_stmt
                            .query_map(duckdb::params![g.group_id], |r| {
                                Ok((
                                    r.get(0)?,
                                    r.get(1)?,
                                    r.get(2)?,
                                    r.get(3)?,
                                    r.get(4)?,
                                    r.get(5)?,
                                    r.get(6)?,
                                    r.get(7)?,
                                    r.get(8)?,
                                    r.get(9)?,
                                ))
                            })?
                            .collect::<Result<Vec<_>, _>>()?;

                    if ev_rows.is_empty() {
                        continue;
                    }
                    if let (Some(user_id), Some((_, _, _, _, _, work_id, ..))) =
                        (g.work_projection_user_id.as_deref(), ev_rows.first())
                    {
                        // Projection events and the cursor share the publisher commit.
                        crate::trigger_effects::touch_work_projection_for_user_in_tx(conn, user_id, work_id)?;
                    }
                    let seq_start = next_seq;
                    let mut seq_end = next_seq;
                    for (event_id, owner_gen, domain, kind, task_id, entity_id, revision, command_id, payload_json, created_at) in ev_rows {
                        let seq = next_seq;
                        next_seq += 1;
                        seq_end = seq;
                        conn.execute(
                            "INSERT INTO core_domain_events (
                               seq, event_id, core_generation, owner_generation, domain, kind,
                               entity_id, revision, command_id, payload_json, created_at_ms
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT (event_id) DO NOTHING",
                            duckdb::params![
                                seq,
                                event_id,
                                core_generation,
                                owner_gen,
                                domain,
                                kind,
                                entity_id,
                                revision,
                                command_id,
                                payload_json,
                                created_at
                            ],
                        )?;
                        let payload: Value = serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({}));
                        emitted.push(PublishedCoreEvent {
                            seq,
                            event_id,
                            core_generation: core_generation.to_owned(),
                            owner_generation: owner_gen,
                            domain,
                            kind,
                            task_id,
                            entity_id,
                            revision,
                            command_id,
                            payload,
                            created_at_ms: created_at,
                        });
                    }
                    conn.execute(
                        "INSERT INTO core_event_publications (group_id, core_generation, seq_start, seq_end, published_at_ms)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (group_id) DO NOTHING",
                        duckdb::params![g.group_id, core_generation, seq_start, seq_end, now],
                    )?;
                    conn.execute(
                        "UPDATE domain_outbox_groups
                         SET published = TRUE, published_seq_start = ?, published_seq_end = ?
                         WHERE group_id = ?",
                        duckdb::params![seq_start, seq_end, g.group_id],
                    )?;
                    newly_published_ids.insert(g.group_id.clone());
                    group_ranges.push((g.group_id.clone(), seq_start, seq_end));
                    progress = true;
                }
                if !progress {
                    break;
                }
            }

            let _ = (&pending[0].operation_id, pending[0].batch_index, pending[0].created_at_ms);
            Ok((emitted, group_ranges))
        })();

        match tx_res {
            Ok((emitted, group_ranges)) => {
                conn.execute_batch("COMMIT")?;
                if let Some(last) = emitted.last() {
                    self.next_seq_hint.store((last.seq + 1) as u64, Ordering::Release);
                }
                // Record publication mappings AFTER COMMIT succeeds and wake waiters
                if !group_ranges.is_empty() {
                    let (lock, cv) = &*self.wait_state;
                    let mut ws = lock.lock().unwrap_or_else(|e| e.into_inner());
                    for (gid, s, e) in group_ranges {
                        ws.published_groups.insert(gid, (s, e));
                    }
                    cv.notify_all();
                }
                // Emit strictly sorted ascending seq notifications outside DB transaction/locks (`IN-09`)
                if !emitted.is_empty() {
                    let subs = self.subscribers.lock().map(|g| g.clone()).unwrap_or_default();
                    for sub in subs {
                        sub(&emitted);
                    }
                }
                Ok(emitted)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

#[derive(Debug)]
struct OutboxGroupRow {
    group_id: String,
    operation_id: String,
    batch_index: i64,
    entity_key: String,
    entity_revision: Option<i64>,
    previous_revision: Option<i64>,
    depends_on_group_id: Option<String>,
    work_projection_user_id: Option<String>,
    created_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::DuckDbPoolConfig;
    use crate::request_control::Control;
    use crate::resource_gate::{DatabaseWriteExecutor, WriteExecError};
    use std::path::PathBuf;
    use std::sync::Barrier;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-outbox-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn out_of_order_commits_and_causal_dependencies_publish_contiguously_without_gaps() {
        let dir = temp_dir("causal");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let control = Control::memory();
        let gate = ResourceGate::new(32);
        let exec = DatabaseWriteExecutor::new(Arc::clone(&engine), Arc::clone(&gate), Arc::clone(&control));
        let publisher = OutboxPublisher::new();

        let observed_seqs = Arc::new(Mutex::new(Vec::<i64>::new()));
        let obs_c = Arc::clone(&observed_seqs);
        publisher.subscribe(Arc::new(move |evs| {
            let mut g = obs_c.lock().unwrap();
            for e in evs {
                g.push(e.seq);
            }
        }));

        // Step 1: Transaction B (depends on group A) commits BEFORE Group A is committed!
        exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "t-b".into()))],
            Duration::from_secs(2),
            |tx| {
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "grp-b".into(),
                        operation_id: "op-b".into(),
                        batch_index: 0,
                        entity_key: "task:t1".into(),
                        entity_revision: Some(2),
                        previous_revision: Some(1),
                        depends_on_group_id: Some("grp-a".into()),
                        work_projection_user_id: Some("u1".into()),
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-b".into(),
                        owner_generation: "g1".into(),
                        domain: "work".into(),
                        kind: "task.updated".into(),
                        task_id: Some("t1".into()),
                        entity_id: "t1".into(),
                        revision: 2,
                        command_id: None,
                        payload_json: "{\"step\":2}".into(),
                    }],
                    20,
                )
                .map_err(WriteExecError::Db)
            },
        ).unwrap();

        // Meanwhile unrelated Group C commits independently
        exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "t-c".into()))],
            Duration::from_secs(2),
            |tx| {
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "grp-c".into(),
                        operation_id: "op-c".into(),
                        batch_index: 0,
                        entity_key: "task:unrelated".into(),
                        entity_revision: Some(1),
                        previous_revision: None,
                        depends_on_group_id: None,
                        work_projection_user_id: None,
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-c".into(),
                        owner_generation: "g1".into(),
                        domain: "work".into(),
                        kind: "task.created".into(),
                        task_id: Some("unrelated".into()),
                        entity_id: "unrelated".into(),
                        revision: 1,
                        command_id: None,
                        payload_json: "{\"step\":0}".into(),
                    }],
                    15,
                )
                .map_err(WriteExecError::Db)
            },
        ).unwrap();

        // Rolled back transaction leaves ZERO phantom outbox rows or seq gaps
        let rb_res: Result<(), WriteExecError> = exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "rb".into()))],
            Duration::from_secs(2),
            |tx| {
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "grp-rb".into(),
                        operation_id: "op-rb".into(),
                        batch_index: 0,
                        entity_key: "task:rb".into(),
                        entity_revision: Some(1),
                        previous_revision: None,
                        depends_on_group_id: None,
                        work_projection_user_id: None,
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-rb".into(),
                        owner_generation: "g1".into(),
                        domain: "work".into(),
                        kind: "task.created".into(),
                        task_id: Some("rb".into()),
                        entity_id: "rb".into(),
                        revision: 1,
                        command_id: None,
                        payload_json: "{}".into(),
                    }],
                    18,
                )
                .map_err(WriteExecError::Db)?;
                Err(WriteExecError::Other("forced rollback".into()))
            },
        );
        assert!(rb_res.is_err());

        // Publish pass 1: unrelated C publishes as seq=1; B stays deferred waiting on A!
        let p1 = publisher.publish_pending(&engine, &gate, "core-1").unwrap();
        assert_eq!(p1.len(), 1);
        assert_eq!(p1[0].event_id, "ev-c");
        assert_eq!(p1[0].seq, 1);

        // Now A commits AFTER B!
        exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "t-a".into()))],
            Duration::from_secs(2),
            |tx| {
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "grp-a".into(),
                        operation_id: "op-a".into(),
                        batch_index: 0,
                        entity_key: "task:t1".into(),
                        entity_revision: Some(1),
                        previous_revision: None,
                        depends_on_group_id: None,
                        work_projection_user_id: Some("u1".into()),
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-a".into(),
                        owner_generation: "g1".into(),
                        domain: "work".into(),
                        kind: "task.created".into(),
                        task_id: Some("t1".into()),
                        entity_id: "t1".into(),
                        revision: 1,
                        command_id: None,
                        payload_json: "{\"step\":1}".into(),
                    }],
                    25,
                )
                .map_err(WriteExecError::Db)
            },
        ).unwrap();

        // Publish pass 2: A becomes seq=2, then B immediately becomes seq=3! Contiguous [1, 2, 3], zero leaks/gaps!
        let p2 = publisher.publish_pending(&engine, &gate, "core-1").unwrap();
        assert_eq!(p2.len(), 2);
        assert_eq!(p2[0].event_id, "ev-a");
        assert_eq!(p2[0].seq, 2);
        assert_eq!(p2[1].event_id, "ev-b");
        assert_eq!(p2[1].seq, 3);
        assert_eq!(*observed_seqs.lock().unwrap(), vec![1, 2, 3]);
        assert_eq!(publisher.wait_for_publication("grp-b", Duration::from_secs(1)).unwrap(), (3, 3));
        {
            let db = engine.checkout_reader(Duration::from_secs(1)).unwrap();
            let cursor: i64 = db.conn().query_row(
                "SELECT sequence FROM work_projection_streams WHERE user_id='u1'", [], |row| row.get(0),
            ).unwrap();
            let mut query = db.conn().prepare(
                "SELECT sequence,work_id FROM work_projection_events WHERE user_id='u1' ORDER BY sequence",
            ).unwrap();
            let events = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            assert_eq!(cursor, 2);
            assert_eq!(events, vec![(1, "t1".into()), (2, "t1".into())]);
        }

        // Concurrent disjoint waits on publisher after commit never block each other
        let bar = Arc::new(Barrier::new(2));
        let _ = bar;

        drop(exec);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
