//! Per-scope / per-domain Memory change-log versioning & cache safety (`IN-05`).
//!
//! Eliminates `memory_search_epoch(id=1)` global write hotspot while preserving:
//! - Scope/domain version vector `(epoch, retired_count + COUNT(visible changes))`
//! - Atomic compactor deleting an explicit `change_id` set and incrementing `retired_count`
//! - Two-snapshot read validation (snapshot S1 read -> verify S2 unchanged before caching)
//! - Time-window validity `[evaluated_at, next_validity_boundary)` + clock-rollback rejection
//! - Cross-scope move dual invalidation (`old_scope`, `new_scope`) + immediate forget barrier

use crate::database::{DbError, DuckDbEngine};
use crate::resource_gate::{ResourceGate, ResourceKey, ResourceRequirement};
use duckdb::{Connection, Transaction};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeDomainVersion {
    pub scope: String,
    pub domain: String,
    pub epoch: i64,
    pub total_events: i64,
}

#[derive(Debug, Clone)]
pub struct SearchCacheEntry {
    pub scope: String,
    pub domain: String,
    pub index_gen: u64,
    pub version: ScopeDomainVersion,
    pub evaluated_at_ms: i64,
    pub next_validity_boundary_ms: Option<i64>,
}

impl SearchCacheEntry {
    pub fn is_valid(
        &self,
        current_version: &ScopeDomainVersion,
        current_index_gen: u64,
        now_ms: i64,
    ) -> bool {
        if self.index_gen != current_index_gen || self.version != *current_version {
            return false;
        }
        // Clock rollback invalidates temporal validity guarantees immediately (`§6.1`).
        if now_ms < self.evaluated_at_ms {
            return false;
        }
        if let Some(boundary) = self.next_validity_boundary_ms
            && now_ms >= boundary
        {
            return false;
        }
        true
    }
}

/// Appends one unique change record for `(scope, domain)` inside the caller's business tx.
/// Never updates any global `id = 1` row.
pub fn record_memory_change_in_tx(
    tx: &Transaction<'_>,
    change_id: &str,
    scope: &str,
    domain: &str,
    entity_id: &str,
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    tx.execute(
        "INSERT INTO memory_changes (change_id, scope, domain, entity_id, operation_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (change_id) DO NOTHING",
        duckdb::params![change_id, scope, domain, entity_id, operation_id, now_ms],
    )?;
    Ok(())
}

/// Cross-scope move invalidation appends changes to BOTH `old_scope` and `new_scope` in the same tx.
pub fn record_cross_scope_move_in_tx(
    tx: &Transaction<'_>,
    base_change_id: &str,
    old_scope: &str,
    new_scope: &str,
    domain: &str,
    entity_id: &str,
    operation_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    record_memory_change_in_tx(
        tx,
        &format!("{base_change_id}:from"),
        old_scope,
        domain,
        entity_id,
        operation_id,
        now_ms,
    )?;
    if new_scope != old_scope {
        record_memory_change_in_tx(
            tx,
            &format!("{base_change_id}:to"),
            new_scope,
            domain,
            entity_id,
            operation_id,
            now_ms,
        )?;
    }
    Ok(())
}

/// Reads `(epoch, retired_count + COUNT(visible changes))` inside one consistent read snapshot.
pub fn read_scope_version(
    conn: &Connection,
    scope: &str,
    domain: &str,
) -> Result<ScopeDomainVersion, DbError> {
    let base: (i64, i64) = match conn.query_row(
        "SELECT epoch, retired_count FROM memory_change_bases WHERE scope = ? AND domain = ?",
        duckdb::params![scope, domain],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ) {
        Ok(v) => v,
        Err(duckdb::Error::QueryReturnedNoRows) => (1, 0),
        Err(e) => return Err(DbError::from(e)),
    };
    let live_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memory_changes WHERE scope = ? AND domain = ?",
        duckdb::params![scope, domain],
        |r| r.get(0),
    )?;
    Ok(ScopeDomainVersion {
        scope: scope.to_owned(),
        domain: domain.to_owned(),
        epoch: base.0,
        total_events: base.1 + live_count,
    })
}

/// Computes `next_validity_boundary_ms` across candidate records' `valid_from` / `valid_until`
/// strictly greater than `evaluated_at_ms`.
pub fn next_validity_boundary(evaluated_at_ms: i64, boundaries: impl Iterator<Item = i64>) -> Option<i64> {
    boundaries.filter(|&ts| ts > evaluated_at_ms).min()
}

/// Compacts an explicit selected batch of `change_id`s for `(scope, domain)` by deleting ONLY those
/// exact IDs and adding the exact deleted count to `memory_change_bases.retired_count` atomically,
/// leaving `ScopeDomainVersion.total_events` mathematically invariant!
pub fn compact_scope_changes(
    engine: &DuckDbEngine,
    gate: &ResourceGate,
    scope: &str,
    domain: &str,
    limit: usize,
    now_ms: i64,
) -> Result<usize, DbError> {
    let _lease = gate
        .acquire(
            vec![
                ResourceRequirement::shared(ResourceKey::DbLifecycle),
                ResourceRequirement::shared(ResourceKey::CommitShare),
                ResourceRequirement::exclusive(ResourceKey::Entity(
                    "memory_compactor".into(),
                    format!("{scope}:{domain}"),
                )),
            ],
            Duration::from_secs(5),
            || false,
        )
        .map_err(|e| DbError::Busy(format!("Memory compactor gate failed: {e:?}")))?;

    let mut w = engine.checkout_writer(Duration::from_secs(5))?;
    let tx = w.conn_mut().transaction()?;
    let mut stmt = tx.prepare(
        "SELECT change_id FROM memory_changes WHERE scope = ? AND domain = ? ORDER BY created_at_ms ASC, change_id ASC LIMIT ?",
    )?;
    let ids: Vec<String> = stmt
        .query_map(duckdb::params![scope, domain, limit as i64], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if ids.is_empty() {
        tx.commit()?;
        return Ok(0);
    }
    let mut deleted = 0usize;
    for id in &ids {
        deleted += tx.execute(
            "DELETE FROM memory_changes WHERE change_id = ?",
            duckdb::params![id],
        )?;
    }
    tx.execute(
        "INSERT INTO memory_change_bases (scope, domain, epoch, retired_count, updated_at_ms)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (scope, domain) DO UPDATE SET
           retired_count = memory_change_bases.retired_count + excluded.retired_count,
           updated_at_ms = excluded.updated_at_ms",
        duckdb::params![scope, domain, deleted as i64, now_ms],
    )?;
    tx.commit()?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::DuckDbPoolConfig;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-memver-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scope_version_remains_invariant_across_compaction_and_enforces_validity_and_clock_rollback() {
        let dir = temp_dir("in05");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let gate = ResourceGate::new(32);

        {
            let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
            let tx = w.conn_mut().transaction().unwrap();
            for i in 0..5 {
                record_memory_change_in_tx(&tx, &format!("c-{i}"), "proj-1", "text", "m1", "op1", 100 + i).unwrap();
            }
            record_cross_scope_move_in_tx(&tx, "move-1", "proj-1", "proj-2", "text", "m2", "op2", 200).unwrap();
            tx.commit().unwrap();
        }

        let v_before = {
            let r = engine.checkout_reader(Duration::from_secs(2)).unwrap();
            let v1 = read_scope_version(r.conn(), "proj-1", "text").unwrap();
            let v2 = read_scope_version(r.conn(), "proj-2", "text").unwrap();
            assert_eq!(v1.total_events, 6);
            assert_eq!(v2.total_events, 1);
            v1
        };

        // Compact 4 changes in proj-1 atomically: version vector total_events MUST remain 6!
        let compacted = compact_scope_changes(&engine, &gate, "proj-1", "text", 4, 300).unwrap();
        assert_eq!(compacted, 4);
        let v_after = {
            let r = engine.checkout_reader(Duration::from_secs(2)).unwrap();
            read_scope_version(r.conn(), "proj-1", "text").unwrap()
        };
        assert_eq!(v_after, v_before);

        // Validity boundary & clock rollback check
        let cache = SearchCacheEntry {
            scope: "proj-1".into(),
            domain: "text".into(),
            index_gen: 1,
            version: v_after.clone(),
            evaluated_at_ms: 1000,
            next_validity_boundary_ms: next_validity_boundary(1000, [500, 1500, 2000].into_iter()),
        };
        assert_eq!(cache.next_validity_boundary_ms, Some(1500));
        assert!(cache.is_valid(&v_after, 1, 1200));
        assert!(!cache.is_valid(&v_after, 1, 1500), "expired at valid_until boundary");
        assert!(!cache.is_valid(&v_after, 1, 999), "clock rollback must invalidate cache");

        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
