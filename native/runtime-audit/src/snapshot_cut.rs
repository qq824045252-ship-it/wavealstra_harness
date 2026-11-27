//! Strong snapshot cut barrier & delta retention lease coordinator (`IN-04`).
//!
//! Enforces strict invariants:
//! - Pre-reserves `reserved_snapshot_reader` + `reserved_publisher_owner` BEFORE taking the barrier.
//! - Acquires lifecycle, exclusive commit share and exclusive publisher order in one grant.
//! - Borrows that grant in the snapshot publisher token and keeps lifecycle while the MVCC view is open.
//! - Drains ALL committed pending `domain_outbox_groups` within budget; fails loudly (never
//!   returns partial snapshot) if drain cannot finish or dependency is missing.
//! - Opens MVCC read tx & runs initial query on `reserved_snapshot_reader` to fix `head_seq`.
//! - Registers TTL `core_snapshot_retention_leases` BEFORE releasing `CommitShare(Exclusive)`.

use crate::database::{DbError, DuckDbEngine};
use crate::outbox_publisher::OutboxPublisher;
use crate::resource_gate::{LockMode, ResourceGate, ResourceKey, ResourceLease, ResourceRequirement};
use duckdb::Connection;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

static NEXT_BARRIER_ID: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct SnapshotOwnerToken<'a> {
    database_generation: &'a str,
    _cut: &'a ResourceLease,
}

impl SnapshotOwnerToken<'_> {
    pub fn belongs_to(&self, engine: &DuckDbEngine) -> bool {
        self.database_generation == engine.database_generation()
    }
}

/// Active pinned consistent DuckDB MVCC snapshot + registered retention lease.
/// Releasing `PinnedSnapshot` rolls back its read transaction; caller can also explicitly revoke lease.
pub struct PinnedSnapshot<'a> {
    pub lease_id: String,
    pub core_generation: String,
    pub head_seq: i64,
    pub min_available_seq: i64,
    reader_guard: MutexGuard<'a, Connection>,
    _lifecycle_lease: ResourceLease,
    engine: Arc<DuckDbEngine>,
    ended: bool,
}

impl<'a> PinnedSnapshot<'a> {
    pub fn conn(&self) -> &Connection {
        &self.reader_guard
    }

    pub fn release_lease(&mut self) -> Result<(), DbError> {
        if !self.ended {
            let _ = self.reader_guard.execute_batch("ROLLBACK");
            self.ended = true;
        }
        let pub_guard = self
            .engine
            .reserved_publisher_owner()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pub_guard.execute(
            "DELETE FROM core_snapshot_retention_leases WHERE lease_id = ?",
            duckdb::params![self.lease_id],
        )?;
        Ok(())
    }
}

impl Drop for PinnedSnapshot<'_> {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.reader_guard.execute_batch("ROLLBACK");
            self.ended = true;
        }
    }
}

pub struct StrongSnapshotCut;

impl StrongSnapshotCut {
    /// Captures a strong consistent snapshot at a single authoritative `head_seq`, draining all
    /// committed outbox groups first and protecting `seq > head_seq` via TTL retention lease.
    pub fn acquire<'a>(
        engine: &'a Arc<DuckDbEngine>,
        gate: &ResourceGate,
        publisher: &OutboxPublisher,
        core_generation: &str,
        lease_ttl: Duration,
        drain_timeout: Duration,
    ) -> Result<PinnedSnapshot<'a>, DbError> {
        let barrier_id = NEXT_BARRIER_ID.fetch_add(1, Ordering::Relaxed);
        let lease_id = format!("snap-{}-{barrier_id}-{}", std::process::id(), now_ms());

        let reader_guard = engine
            .reserved_snapshot_reader()
            .try_lock()
            .map_err(|_| DbError::Busy("Reserved snapshot reader connection currently busy".into()))?;
        let deadline = std::time::Instant::now() + drain_timeout;
        let mut ticket = gate.enqueue(vec![
            ResourceRequirement::shared(ResourceKey::DbLifecycle),
            ResourceRequirement::exclusive(ResourceKey::CommitShare),
            ResourceRequirement::exclusive(ResourceKey::PublisherOrder),
        ]).map_err(|e| DbError::Busy(format!("Snapshot cut admission failed: {e:?}")))?;
        let (mut cut, pub_guard) = loop {
            let generation = gate.generation();
            // Try the publisher connection and the cut together. Release the publisher
            // reservation before waiting for an older incompatible ticket.
            if let Ok(publisher) = engine.reserved_publisher_owner().try_lock()
                && let Some(cut) = ticket.try_grant()
            {
                break (cut, publisher);
            }
            let wait = deadline.saturating_duration_since(std::time::Instant::now());
            if wait.is_zero() {
                return Err(DbError::Busy("Snapshot cut admission timed out".into()));
            }
            gate.wait_for_change(generation, wait.min(Duration::from_millis(25)));
        };

        // Drain every committed outbox group under the cut's existing publisher permit.
        let owner_token = SnapshotOwnerToken {
            database_generation: engine.database_generation(),
            _cut: &cut,
        };
        let deadline = std::time::Instant::now() + drain_timeout;
        loop {
            let published = publisher.publish_pending_with_owner(
                engine,
                core_generation,
                &owner_token,
                &pub_guard,
            )?;
            let remaining: i64 = pub_guard.query_row(
                "SELECT COUNT(*) FROM domain_outbox_groups WHERE published = FALSE",
                [],
                |r| r.get(0),
            )?;
            if remaining == 0 {
                break;
            }
            if published.is_empty() {
                // Missing dependency or unresolvable causal cycle inside cut -> abort barrier cleanly!
                return Err(DbError::Busy(format!(
                    "Snapshot cut aborted: {remaining} outbox group(s) have unsatisfied causal dependencies"
                )));
            }
            if std::time::Instant::now() >= deadline {
                return Err(DbError::Busy(format!(
                    "Snapshot cut drain timeout with {remaining} pending group(s)"
                )));
            }
        }

        // 4. Open MVCC read transaction on reserved reader & run first query to fix DuckDB snapshot + head_seq
        reader_guard.execute_batch("BEGIN TRANSACTION")?;
        let head_res: Result<(i64, i64), DbError> = (|| {
            let head_seq: i64 = reader_guard
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM core_domain_events", [], |r| r.get(0))?;
            let min_avail: i64 = reader_guard
                .query_row("SELECT min_available_seq FROM core_event_meta WHERE id = 1", [], |r| r.get(0))
                .unwrap_or(1);
            Ok((head_seq, min_avail))
        })();
        let (head_seq, min_available_seq) = match head_res {
            Ok(v) => v,
            Err(e) => {
                let _ = reader_guard.execute_batch("ROLLBACK");
                return Err(e);
            }
        };

        // 5. Register TTL retention lease BEFORE releasing CommitShare(ExclusiveCut)!
        let now = now_ms();
        let expires_at = now + lease_ttl.as_millis() as i64;
        if let Err(e) = pub_guard.execute(
            "INSERT INTO core_snapshot_retention_leases (lease_id, core_generation, pinned_head_seq, expires_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, ?)",
            duckdb::params![lease_id, core_generation, head_seq, expires_at, now],
        ) {
            let _ = reader_guard.execute_batch("ROLLBACK");
            return Err(DbError::from(e));
        }

        drop(pub_guard);
        cut.retain_only(&ResourceKey::DbLifecycle);

        Ok(PinnedSnapshot {
            lease_id,
            core_generation: core_generation.to_owned(),
            head_seq,
            min_available_seq,
            reader_guard,
            _lifecycle_lease: cut,
            engine: Arc::clone(engine),
            ended: false,
        })
    }
}

/// Retention pruning obeys fixed lock order (`DbLifecycle(Shared) -> CommitShare(Shared) -> PublisherOrder(Exclusive)`)
/// and NEVER removes events covered by an active snapshot lease (`expires_at_ms > now`) or needed
/// for unpublished outbox recovery (`IN-04`).
pub fn prune_retained_events(
    engine: &DuckDbEngine,
    gate: &ResourceGate,
    retention_limit: i64,
    now: i64,
) -> Result<usize, DbError> {
    let _lease = gate
        .acquire(
            vec![
                ResourceRequirement::shared(ResourceKey::DbLifecycle),
                ResourceRequirement::shared(ResourceKey::CommitShare),
                ResourceRequirement {
                    key: ResourceKey::PublisherOrder,
                    mode: LockMode::Exclusive,
                },
            ],
            Duration::from_secs(5),
            || false,
        )
        .map_err(|e| DbError::Busy(format!("Retention gate failed: {e:?}")))?;

    let pub_conn = engine
        .reserved_publisher_owner()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    pub_conn.execute_batch("BEGIN TRANSACTION")?;
    let res = (|| -> Result<usize, DbError> {
        // Expire stale leases first
        pub_conn.execute(
            "DELETE FROM core_snapshot_retention_leases WHERE expires_at_ms <= ?",
            duckdb::params![now],
        )?;
        let max_seq: i64 = pub_conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM core_domain_events", [], |r| r.get(0))?;
        let mut cut_before = (max_seq - retention_limit + 1).max(1);

        let min_pinned: Option<i64> = pub_conn
            .query_row(
                "SELECT MIN(pinned_head_seq) FROM core_snapshot_retention_leases WHERE expires_at_ms > ?",
                duckdb::params![now],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if let Some(pinned) = min_pinned {
            cut_before = cut_before.min(pinned.max(1));
        }
        if cut_before <= 1 {
            return Ok(0);
        }
        let deleted = pub_conn.execute(
            "DELETE FROM core_domain_events WHERE seq < ?",
            duckdb::params![cut_before],
        )?;
        pub_conn.execute(
            "UPDATE core_event_meta SET min_available_seq = GREATEST(min_available_seq, ?) WHERE id = 1",
            duckdb::params![cut_before],
        )?;
        Ok(deleted)
    })();

    match res {
        Ok(d) => {
            pub_conn.execute_batch("COMMIT")?;
            Ok(d)
        }
        Err(e) => {
            let _ = pub_conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::DuckDbPoolConfig;
    use crate::outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx};
    use crate::request_control::Control;
    use crate::resource_gate::{DatabaseWriteExecutor, WriteExecError};
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-snapcut-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn occupied_snapshot_reader_cannot_queue_another_cut() {
        let dir = temp_dir("reader-busy");
        let (engine, _) = DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let gate = ResourceGate::new(8);
        let publisher = OutboxPublisher::new();
        let pinned = engine.reserved_snapshot_reader().lock().unwrap();
        let error = StrongSnapshotCut::acquire(
            &engine, &gate, &publisher, "core-cut", Duration::from_secs(30), Duration::from_millis(50),
        ).err().expect("a held reader must reject a new cut");
        assert!(matches!(error, DbError::Busy(message) if message == "Reserved snapshot reader connection currently busy"));
        assert_eq!(gate.max_waiters_observed(), 0);
        drop(pinned);
        drop(engine);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn strong_snapshot_cut_drains_outbox_pins_mvcc_head_and_protects_retention_lease() {
        let dir = temp_dir("lease");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let control = Control::memory();
        let gate = ResourceGate::new(32);
        let exec = DatabaseWriteExecutor::new(Arc::clone(&engine), Arc::clone(&gate), Arc::clone(&control));
        let publisher = OutboxPublisher::new();

        // Commit note #1 + outbox group BEFORE snapshot cut (still unpublished!)
        exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("note".into(), "n1".into()))],
            Duration::from_secs(2),
            |tx| {
                tx.execute(
                    "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                     VALUES ('n1', 'g1', 1, 'before-cut', '{}', 0, 100)",
                    [],
                ).map_err(|e| WriteExecError::Db(DbError::from(e)))?;
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "gcut-1".into(),
                        operation_id: "op-cut-1".into(),
                        batch_index: 0,
                        entity_key: "note:n1".into(),
                        entity_revision: Some(1),
                        previous_revision: None,
                        depends_on_group_id: None,
                        work_projection_user_id: None,
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-cut-1".into(),
                        owner_generation: "g1".into(),
                        domain: "notes".into(),
                        kind: "note.created".into(),
                        task_id: None,
                        entity_id: "n1".into(),
                        revision: 1,
                        command_id: None,
                        payload_json: "{}".into(),
                    }],
                    100,
                ).map_err(WriteExecError::Db)
            },
        ).unwrap();

        let mut snap = StrongSnapshotCut::acquire(
            &engine,
            &gate,
            &publisher,
            "core-cut",
            Duration::from_secs(60),
            Duration::from_secs(5),
        ).unwrap();
        assert_eq!(snap.head_seq, 1, "snapshot cut must drain committed outbox first");

        // Now write note #2 AFTER cut was released — must commit cleanly without blocking on reader,
        // while pinned snapshot STILL sees only note #1!
        exec.run_write(
            None,
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("note".into(), "n2".into()))],
            Duration::from_secs(2),
            |tx| {
                tx.execute(
                    "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                     VALUES ('n2', 'g1', 1, 'after-cut', '{}', 0, 200)",
                    [],
                ).map_err(|e| WriteExecError::Db(DbError::from(e)))?;
                append_outbox_group_in_tx(
                    tx,
                    &OutboxGroupDraft {
                        group_id: "gcut-2".into(),
                        operation_id: "op-cut-2".into(),
                        batch_index: 0,
                        entity_key: "note:n2".into(),
                        entity_revision: Some(1),
                        previous_revision: None,
                        depends_on_group_id: None,
                        work_projection_user_id: None,
                    },
                    &[OutboxEventDraft {
                        event_id: "ev-cut-2".into(),
                        owner_generation: "g1".into(),
                        domain: "notes".into(),
                        kind: "note.created".into(),
                        task_id: None,
                        entity_id: "n2".into(),
                        revision: 1,
                        command_id: None,
                        payload_json: "{}".into(),
                    }],
                    200,
                ).map_err(WriteExecError::Db)
            },
        ).unwrap();
        publisher.publish_pending(&engine, &gate, "core-cut").unwrap();

        let visible_notes: i64 = snap
            .conn()
            .query_row("SELECT COUNT(*) FROM core_domain_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(visible_notes, 1, "pinned MVCC snapshot must stay at cut point");

        // Retention GC with limit=1 must NOT purge seq=1 while active lease protects pinned_head_seq=1!
        let pruned_while_held = prune_retained_events(&engine, &gate, 1, now_ms()).unwrap();
        assert_eq!(pruned_while_held, 0);

        snap.release_lease().unwrap();
        drop(snap);

        // Once lease is released, retention limit=1 cleanly trims seq < 2!
        let pruned_after = prune_retained_events(&engine, &gate, 1, now_ms()).unwrap();
        assert_eq!(pruned_after, 1);

        drop(exec);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
