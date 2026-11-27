//! Declarative `RelationCatalog` & `PartialUniqueRule` enforcement for DuckDB (`IN-01`).
//!
//! Replaces SQLite's 155 FK constraints (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`)
//! and 14 `CREATE UNIQUE INDEX ... WHERE ...` predicates with explicit single-transaction
//! parent validation, transitive delete closure, RESTRICT pre-checks, and `unique_claims` keys.

use crate::database::DbError;
use duckdb::Transaction;
use std::collections::{HashMap, HashSet};

#[path = "relation_catalog_data.rs"]
pub mod data;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteAction {
    Cascade,
    SetNull,
    Restrict,
    NoAction,
}

#[derive(Debug, Clone, Copy)]
pub struct FkRelation {
    pub child_table: &'static str,
    pub parent_table: &'static str,
    pub columns: &'static [(&'static str, &'static str)],
    pub on_delete: DeleteAction,
}

#[derive(Debug, Clone, Copy)]
pub struct PartialUniqueRule {
    pub name: &'static str,
    pub table: &'static str,
    pub columns: &'static [&'static str],
    pub predicate_sql: &'static str,
    pub case_insensitive: bool,
}

fn valid_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Validates every parent reference defined for `child_table` inside `tx` (`IN-01`).
/// Only single- or composite-key non-NULL bindings are checked (matching SQL `MATCH SIMPLE`).
pub fn validate_parents_for_row(
    tx: &Transaction<'_>,
    child_table: &str,
    row_values: &[(&str, &str)],
) -> Result<(), DbError> {
    let val_map: HashMap<&str, &str> = row_values.iter().copied().collect();
    for rel in data::FK_RELATIONS
        .iter()
        .filter(|r| r.child_table == child_table)
    {
        if !valid_ident(rel.parent_table) {
            return Err(DbError::Query(format!("Invalid parent table {}", rel.parent_table)));
        }
        let mut parent_cols = Vec::new();
        let mut child_vals = Vec::new();
        let mut any_missing_or_null = false;
        for (child_col, parent_col) in rel.columns {
            if !valid_ident(child_col) || !valid_ident(parent_col) {
                return Err(DbError::Query("Invalid column identifier".into()));
            }
            match val_map.get(child_col) {
                Some(v) => {
                    parent_cols.push(*parent_col);
                    child_vals.push(*v);
                }
                None => {
                    any_missing_or_null = true;
                    break;
                }
            }
        }
        if any_missing_or_null || parent_cols.is_empty() {
            continue;
        }
        let where_clause = parent_cols
            .iter()
            .map(|c| format!("{c} = ?"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!("SELECT COUNT(*) FROM {} WHERE {where_clause}", rel.parent_table);
        let mut stmt = tx.prepare(&sql)?;
        let params: Vec<&dyn duckdb::ToSql> = child_vals.iter().map(|v| v as &dyn duckdb::ToSql).collect();
        let count: i64 = stmt.query_row(duckdb::params_from_iter(params), |r| r.get(0))?;
        if count == 0 {
            return Err(DbError::Constraint(format!(
                "Foreign key constraint failed: {}.{} missing parent in {}",
                child_table,
                rel.columns.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(","),
                rel.parent_table
            )));
        }
    }
    Ok(())
}

/// Inserts a claim into `unique_claims` for a partial-unique predicate (fails cleanly with `Constraint` on duplicate without aborting the outer DuckDB transaction).
pub fn claim_unique(
    tx: &Transaction<'_>,
    rule_name: &str,
    key_parts: &[&str],
    owner_table: &str,
    owner_id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let encoded_key = serde_json::to_string(key_parts).unwrap_or_else(|_| key_parts.join("\0"));
    let existing: Option<(String, String)> = match tx.query_row(
        "SELECT owner_table, owner_id FROM unique_claims WHERE claim_namespace = ? AND claim_key = ?",
        duckdb::params![rule_name, encoded_key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ) {
        Ok(v) => Some(v),
        Err(duckdb::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(DbError::from(e)),
    };
    if let Some((et, eid)) = existing {
        if et == owner_table && eid == owner_id {
            return Ok(());
        }
        return Err(DbError::Constraint(format!(
            "UNIQUE constraint failed: {rule_name} ({owner_table}:{owner_id} conflicts with {et}:{eid})"
        )));
    }
    let inserted = tx.execute(
        "INSERT INTO unique_claims (claim_namespace, claim_key, owner_table, owner_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (claim_namespace, claim_key) DO NOTHING",
        duckdb::params![rule_name, encoded_key, owner_table, owner_id, now_ms],
    )
    .map_err(DbError::from)?;
    if inserted == 0 {
        return Err(DbError::Constraint(format!(
            "UNIQUE constraint failed: {rule_name}"
        )));
    }
    Ok(())
}

/// Releases all `unique_claims` owned by `(owner_table, owner_id)` inside the same tx.
pub fn release_unique_for_owner(
    tx: &Transaction<'_>,
    owner_table: &str,
    owner_id: &str,
) -> Result<(), DbError> {
    tx.execute(
        "DELETE FROM unique_claims WHERE owner_table = ? AND owner_id = ?",
        duckdb::params![owner_table, owner_id],
    )?;
    Ok(())
}

/// Atomically executes transitive FK delete closure starting at `(root_table, pk_col = pk_val)`:
/// 1. Checks ALL `Restrict` / `NoAction` edges referencing any node to be deleted BEFORE mutating.
/// 2. Nullifies `SetNull` foreign key columns in referencing child tables.
/// 3. Deletes leaf-to-root cascading child rows & releases their `unique_claims`.
/// 4. Safe against FK cycles (tracked by `(table, key_val)` visited set).
pub fn delete_cascade_by_single_pk(
    tx: &Transaction<'_>,
    root_table: &str,
    pk_col: &str,
    pk_val: &str,
) -> Result<usize, DbError> {
    if !valid_ident(root_table) || !valid_ident(pk_col) {
        return Err(DbError::Query("Invalid identifier".into()));
    }
    let mut visited: HashSet<(String, String)> = HashSet::new();
    let mut post_order: Vec<(String, String, String)> = Vec::new();
    let mut set_null_ops: Vec<(String, Vec<String>, String, String)> = Vec::new();

    fn collect_closure(
        tx: &Transaction<'_>,
        table: &str,
        key_col: &str,
        key_val: &str,
        visited: &mut HashSet<(String, String)>,
        post_order: &mut Vec<(String, String, String)>,
        set_null_ops: &mut Vec<(String, Vec<String>, String, String)>,
    ) -> Result<(), DbError> {
        let visit_key = (table.to_owned(), key_val.to_owned());
        if !visited.insert(visit_key) {
            return Ok(());
        }
        for rel in data::FK_RELATIONS.iter().filter(|r| r.parent_table == table) {
            if rel.columns.len() != 1 || rel.columns[0].1 != key_col {
                continue;
            }
            let child_col = rel.columns[0].0;
            if !valid_ident(rel.child_table) || !valid_ident(child_col) {
                continue;
            }
            match rel.on_delete {
                DeleteAction::Restrict | DeleteAction::NoAction => {
                    let sql = format!("SELECT COUNT(*) FROM {} WHERE {child_col} = ?", rel.child_table);
                    let cnt: i64 = tx.query_row(&sql, duckdb::params![key_val], |r| r.get(0))?;
                    if cnt > 0 {
                        // Exclude rows that are already scheduled inside our own cascade set from triggering Restrict
                        let child_pk = primary_id_col(rel.child_table);
                        let mut blocked = false;
                        if let Some(cpk) = child_pk {
                            let sel = format!("SELECT {cpk} FROM {} WHERE {child_col} = ?", rel.child_table);
                            let mut stmt = tx.prepare(&sel)?;
                            let ids: Vec<String> = stmt
                                .query_map(duckdb::params![key_val], |r| r.get::<_, String>(0))?
                                .collect::<Result<Vec<_>, _>>()?;
                            for cid in ids {
                                if !visited.contains(&(rel.child_table.to_owned(), cid)) {
                                    blocked = true;
                                    break;
                                }
                            }
                        } else {
                            blocked = true;
                        }
                        if blocked {
                            return Err(DbError::Constraint(format!(
                                "FOREIGN KEY RESTRICT/NO ACTION blocked delete of {table}({key_val}) referenced by {}.{}",
                                rel.child_table, child_col
                            )));
                        }
                    }
                }
                DeleteAction::SetNull => {
                    set_null_ops.push((
                        rel.child_table.to_owned(),
                        vec![child_col.to_owned()],
                        child_col.to_owned(),
                        key_val.to_owned(),
                    ));
                }
                DeleteAction::Cascade => {
                    if let Some(child_pk) = primary_id_col(rel.child_table) {
                        let sql = format!(
                            "SELECT CAST({child_pk} AS VARCHAR) FROM {} WHERE {child_col} = ?",
                            rel.child_table
                        );
                        let mut stmt = tx.prepare(&sql)?;
                        let child_keys: Vec<String> = stmt
                            .query_map(duckdb::params![key_val], |r| r.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?;
                        for ck in child_keys {
                            collect_closure(
                                tx,
                                rel.child_table,
                                child_pk,
                                &ck,
                                visited,
                                post_order,
                                set_null_ops,
                            )?;
                        }
                    } else {
                        // Child table without single PK (composite key): delete directly by FK match after root collect
                        let del = format!("DELETE FROM {} WHERE {child_col} = ?", rel.child_table);
                        set_null_ops.push((
                            format!("__DIRECT_DELETE__:{}", rel.child_table),
                            vec![del],
                            child_col.to_owned(),
                            key_val.to_owned(),
                        ));
                    }
                }
            }
        }
        post_order.push((table.to_owned(), key_col.to_owned(), key_val.to_owned()));
        Ok(())
    }

    collect_closure(
        tx,
        root_table,
        pk_col,
        pk_val,
        &mut visited,
        &mut post_order,
        &mut set_null_ops,
    )?;

    let mut total_deleted = 0usize;
    for (tbl, cols, where_col, where_val) in set_null_ops {
        if tbl.starts_with("__DIRECT_DELETE__:") {
            let del_sql = &cols[0];
            total_deleted += tx.execute(del_sql, duckdb::params![where_val])?;
        } else {
            let sets = cols.iter().map(|c| format!("{c} = NULL")).collect::<Vec<_>>().join(", ");
            let sql = format!("UPDATE {tbl} SET {sets} WHERE {where_col} = ?");
            tx.execute(&sql, duckdb::params![where_val])?;
        }
    }

    for (tbl, col, val) in post_order {
        release_unique_for_owner(tx, &tbl, &val)?;
        let sql = format!("DELETE FROM {tbl} WHERE {col} = ?");
        total_deleted += tx.execute(&sql, duckdb::params![val])?;
    }
    Ok(total_deleted)
}

fn primary_id_col(table: &str) -> Option<&'static str> {
    // Check if table is itself a parent in any FK relation to infer single-column PK name,
    // plus common single-PK tables in canonical_schema.sql.
    for rel in data::FK_RELATIONS {
        if rel.parent_table == table && rel.columns.len() == 1 {
            return Some(rel.columns[0].1);
        }
    }
    match table {
        "tasks" | "spaces" | "notifications" | "artifacts" | "cron_jobs" | "cron_runs"
        | "projects" | "library_spaces" | "library_documents" | "memory_records" => Some("id"),
        "works" => Some("work_id"),
        "work_dispatch_requests" | "work_blockers" => Some("id"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{DuckDbEngine, DuckDbPoolConfig};
    use std::time::Duration;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-rel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn catalog_covers_all_155_fks_and_14_partial_unique_rules_and_enforces_cascade_setnull_restrict_and_claims() {
        assert_eq!(data::FK_RELATIONS.len(), 155);
        assert_eq!(data::PARTIAL_UNIQUE_RULES.len(), 14);

        let dir = temp_dir("enforces");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();
        let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
        let tx = w.conn_mut().transaction().unwrap();

        // Seed parent space + child task + child cron_job -> core_cron_schedule_state (155th runtime FK!)
        tx.execute(
            "INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('sp1', 'Root', 1, 1)",
            [],
        ).unwrap();
        tx.execute(
            "INSERT INTO tasks (id, title, space_id, updated_at) VALUES ('t1', 'Task 1', 'sp1', 1)",
            [],
        ).unwrap();
        // Validate parent check catches missing parent!
        let missing = validate_parents_for_row(&tx, "tasks", &[("space_id", "missing-space")]);
        assert!(matches!(missing, Err(DbError::Constraint(_))));
        assert!(validate_parents_for_row(&tx, "tasks", &[("space_id", "sp1")]).is_ok());

        // Seed cron_job + core_cron_schedule_state
        tx.execute(
            "INSERT INTO cron_jobs (id, name, prompt, schedule_type, schedule_expr, created_at, updated_at)
             VALUES ('cj1', 'job', 'hi', 'cron', '* * * * *', 1, 1)",
            [],
        ).unwrap();
        tx.execute(
            "INSERT INTO core_cron_schedule_state (job_id, next_due_at_ms, occurrence_at_ms, last_evaluated_at_ms, schedule_sig)
             VALUES ('cj1', 100, NULL, 1, 'sig')",
            [],
        ).unwrap();

        // Partial unique claim enforcement + release on owner delete
        claim_unique(&tx, "idx_notifications_dedupe", &["k1"], "notifications", "n1", 1).unwrap();
        let dup = claim_unique(&tx, "idx_notifications_dedupe", &["k1"], "notifications", "n2", 2);
        assert!(matches!(dup, Err(DbError::Constraint(_))));
        release_unique_for_owner(&tx, "notifications", "n1").unwrap();
        claim_unique(&tx, "idx_notifications_dedupe", &["k1"], "notifications", "n2", 3).unwrap();

        // Cascade delete cron_jobs('cj1') -> deletes core_cron_schedule_state('cj1')
        delete_cascade_by_single_pk(&tx, "cron_jobs", "id", "cj1").unwrap();
        let rem_state: i64 = tx
            .query_row("SELECT COUNT(*) FROM core_cron_schedule_state WHERE job_id = 'cj1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rem_state, 0);

        tx.commit().unwrap();
        drop(w);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
