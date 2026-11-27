//! Rust-owned DuckDB application database initialization, schema verification, incompatible
//! reset, seed materialization, and startup maintenance (`Step 4`, `DB-01`, `DB-05`, `DB-06`).

use crate::core_lease;
use crate::database::{
    CANONICAL_DUCKDB_SCHEMA_SQL, DUCKDB_FORMAT_VERSION, DUCKDB_SCHEMA_VERSION,
    DuckDbEngine, DuckDbPoolConfig, patch_json_fields, table_exists,
};
use duckdb::Connection;
use serde::Serialize;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_DOTS_RULE_CONFIG: &str = r#"{"title":"默认调度策略","include":[],"exclude":[],"instruction":"按本轮请求和已知任务状态选择直答或委派。","evidenceFile":"","enabled":true,"projectId":null,"sourceMemoryId":null,"policy":{"version":1,"routeMode":"auto","foregroundReadLimits":{"characters":24000,"sources":4,"calls":6},"trackingPolicy":{"milestones":true,"heartbeatMs":null,"silenceMs":120000}}}"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDatabaseReport {
    pub schema_version: u32,
    pub rebuilt: bool,
    pub deleted_files: Vec<String>,
    pub materialized: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Validates current DuckDB schema (`expected_version`) under Core's OS guards (`core.lock` +
/// `core-worker.lock`), resets only confirmed schema mismatch (never I/O, permission, or corrupt files),
/// and materializes canonical DuckDB schema + startup seeds/repairs.
pub fn initialize_database(
    data_dir: &Path,
    db_path: &Path,
    expected_version: u32,
) -> crate::Result<InitDatabaseReport> {
    let _guards = core_lease::initialization_guards(data_dir)
        .map_err(|e| format!("Core database ownership guard unavailable: {e}"))?;
    initialize_database_unguarded(db_path, expected_version)
}

pub fn initialize_database_unguarded(
    db_path: &Path,
    _expected_version: u32,
) -> crate::Result<InitDatabaseReport> {
    if let Some(parent) = db_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let cfg = DuckDbPoolConfig {
        allow_reset_on_mismatch: true,
        ..Default::default()
    };
    let (engine, open_report) = DuckDbEngine::open_or_initialize(db_path, cfg)?;
    let mut writer = engine.checkout_writer(std::time::Duration::from_secs(10))?;
    materialize_seeds_and_repairs(writer.conn_mut())?;
    drop(writer);
    drop(engine);
    Ok(InitDatabaseReport {
        schema_version: DUCKDB_SCHEMA_VERSION as u32,
        rebuilt: open_report.rebuilt,
        deleted_files: open_report.deleted_files,
        materialized: open_report.rebuilt,
    })
}

pub fn materialize_seeds_and_repairs(conn: &mut Connection) -> crate::Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO soul (id, name, alias, persona) VALUES (1, 'MyBuddy', '老板', '你是本地桌面助理，简洁、可靠、会动手。') ON CONFLICT (id) DO NOTHING",
        [],
    )?;
    let core_gen = crate::business_protocol::current_core_generation();
    tx.execute(
        "INSERT INTO core_event_meta (id, core_generation, min_available_seq, retention_limit) VALUES (1, ?1, 1, 4096)
         ON CONFLICT (id) DO UPDATE SET core_generation = excluded.core_generation",
        [&core_gen],
    )?;
    tx.commit()?;
    run_startup_repairs(conn)?;
    Ok(())
}

pub fn materialize_schema(conn: &mut Connection, _expected_version: u32) -> crate::Result<()> {
    conn.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL)?;
    materialize_seeds_and_repairs(conn)
}

pub fn run_startup_repairs(conn: &mut Connection) -> crate::Result<()> {
    if !table_exists(conn, "tasks")? {
        return Ok(());
    }
    let now = now_ms();
    let tx = conn.transaction()?;
    tx.execute("UPDATE tasks SET welcome_mode = 'general' WHERE welcome_mode = 'bot'", [])?;
    tx.execute("UPDATE cron_jobs SET welcome_mode = 'general' WHERE welcome_mode = 'bot'", [])?;
    tx.execute(
        "UPDATE task_runtime_context_snapshots SET welcome_mode = 'general' WHERE welcome_mode = 'bot'",
        [],
    )?;
    {
        let mut stmt = tx.prepare(
            "SELECT id, context_json FROM agent_loadout_observations
             WHERE json_valid(context_json) AND json_extract_string(context_json, '$.mode') = 'bot'",
        )?;
        let mut rows = stmt.query([])?;
        let mut updates = Vec::new();
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let raw: String = r.get(1)?;
            updates.push((id, patch_json_fields(&raw, &[("$.mode", json!("general"))])));
        }
        drop(rows);
        drop(stmt);
        for (id, updated_json) in updates {
            tx.execute(
                "UPDATE agent_loadout_observations SET context_json = ?1 WHERE id = ?2",
                duckdb::params![updated_json, id],
            )?;
        }
    }
    tx.execute(
        "UPDATE cron_runs SET status = 'error', finished_at = ?1, error = '应用退出中断执行，未自动重放' WHERE status = 'running'",
        [now],
    )?;
    tx.execute(
        "UPDATE memory_turns SET extraction_state = 'failed' WHERE extraction_state = 'processing'",
        [],
    )?;
    {
        let mut stmt = tx.prepare(
            "SELECT id, state_json FROM memory_organization_runs
             WHERE json_valid(state_json) AND json_extract_string(state_json, '$.run.status') = 'scanning'",
        )?;
        let mut rows = stmt.query([])?;
        let mut updates = Vec::new();
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let raw: String = r.get(1)?;
            updates.push((id, patch_json_fields(&raw, &[("$.run.status", json!("paused"))])));
        }
        drop(rows);
        drop(stmt);
        for (id, state_json) in updates {
            tx.execute(
                "UPDATE memory_organization_runs SET state_json = ?1, updated_at = ?2 WHERE id = ?3",
                duckdb::params![state_json, now, id],
            )?;
        }
    }
    tx.execute(
        "UPDATE conversation_interactions SET status = 'expired', version = version + 1, resolved_at = ?1 WHERE status = 'pending'",
        [now],
    )?;
    tx.execute(
        "INSERT INTO answer_rules(id, revision, enabled, config) VALUES ('dots-default-policy', 1, 1, ?1) ON CONFLICT (id) DO NOTHING",
        [DEFAULT_DOTS_RULE_CONFIG],
    )?;
    tx.execute(
        "INSERT INTO answer_rule_versions(rule_id, revision, \"at\", source, title, config)
         SELECT id, revision, ?1, 'baseline', COALESCE(json_extract_string(config, '$.title'), ''), config
         FROM answer_rules r WHERE NOT EXISTS (SELECT 1 FROM answer_rule_versions v WHERE v.rule_id = r.id)
         ON CONFLICT (rule_id, revision) DO NOTHING",
        [now],
    )?;
    tx.execute(
        "UPDATE execution_failures SET dismissed_at = COALESCE(dismissed_at, ?1)
         WHERE cause_code IN ('shell-exit-nonzero', 'code-execution-exit-nonzero') AND resolved_at IS NULL AND dismissed_at IS NULL",
        [now],
    )?;
    {
        let mut stmt = tx.prepare(
            "SELECT request_id, record_json FROM task_request_diagnostics
             WHERE json_extract_string(record_json, '$.status') = 'running'",
        )?;
        let mut rows = stmt.query([])?;
        let mut patches = Vec::new();
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let raw: String = r.get(1)?;
            patches.push((id, patch_json_fields(&raw, &[("$.status", json!("interrupted"))])));
        }
        drop(rows);
        drop(stmt);
        for (id, raw) in patches {
            tx.execute(
                "UPDATE task_request_diagnostics SET record_json = ?1 WHERE request_id = ?2",
                duckdb::params![raw, id],
            )?;
        }
    }
    for table in ["task_tool_diagnostics", "scope_tool_diagnostics"] {
        let sql = format!(
            "SELECT id, record_json FROM {table} WHERE json_extract_string(record_json, '$.status') = 'running'"
        );
        let mut stmt = tx.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut patches = Vec::new();
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let raw: String = r.get(1)?;
            patches.push((
                id,
                patch_json_fields(
                    &raw,
                    &[
                        ("$.status", json!("interrupted")),
                        ("$.complete", json!(false)),
                        ("$.segmentStartedAt", serde_json::Value::Null),
                    ],
                ),
            ));
        }
        drop(rows);
        drop(stmt);
        let upd_sql = format!("UPDATE {table} SET record_json = ?1 WHERE id = ?2");
        for (id, raw) in patches {
            tx.execute(&upd_sql, duckdb::params![raw, id])?;
        }
    }
    tx.execute(
        "UPDATE external_agent_runs
            SET status='failed',
                completed_at=COALESCE(completed_at, ?1),
                error=COALESCE(error, 'MyBuddy 已重启，上一轮外部子任务已中断。'),
                recovery_state=CASE
                  WHEN session_id IS NOT NULL AND resume_supported=1 THEN 'resume-available'
                  ELSE 'new-run-required'
                END,
                cancel_supported=0,
                recovery_message=CASE
                  WHEN session_id IS NOT NULL AND resume_supported=1 THEN '应用重启后原进程已不存在；可基于原 session 续聊，续聊前请先核对工作目录与已有产物。'
                  ELSE '应用重启后原进程已不存在，且没有可恢复 session；请核对已有输出/产物后新建执行。'
                END
          WHERE status IN ('starting','working','blocked')",
        [now],
    )?;
    tx.execute(
        "UPDATE external_agent_runs SET cancellation_evidence='unconfirmed' WHERE cancellation_evidence='requested'",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(1);

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "mybuddy-db-schema-{label}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn initializes_fresh_database_with_expected_schema_and_is_idempotent() {
        let s = Sandbox::new("fresh");
        let data_dir = s.0.join("data");
        let db_path = data_dir.join("app.duckdb");
        let first = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32).unwrap();
        assert!(!first.rebuilt);

        let (eng, _) = DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        let r = eng.checkout_reader(std::time::Duration::from_secs(2)).unwrap();
        let soul_name: String = r
            .conn()
            .query_row("SELECT name FROM soul WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(soul_name, "MyBuddy");
        let fmt: String = r
            .conn()
            .query_row("SELECT format FROM database_meta WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fmt, DUCKDB_FORMAT_VERSION);
        drop(r);
        drop(eng);

        let second = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32).unwrap();
        assert!(!second.rebuilt);
    }

    #[test]
    fn discards_incompatible_schema_and_sidecars_without_backup_and_preserves_unreadable_bytes() {
        let s = Sandbox::new("discard");
        let data_dir = s.0.join("data");
        let db_path = data_dir.join("old.duckdb");
        fs::create_dir_all(&data_dir).unwrap();
        {
            let old = Connection::open(&db_path).unwrap();
            old.execute_batch(
                "CREATE TABLE database_meta (id BIGINT PRIMARY KEY, format VARCHAR, schema_version BIGINT, database_generation VARCHAR, initialized BOOLEAN, created_at_ms BIGINT, updated_at_ms BIGINT);
                 INSERT INTO database_meta VALUES (1, 'legacy-v0', 0, 'old-gen', TRUE, 1, 1);",
            ).unwrap();
        }
        fs::write(format!("{}.wal", db_path.display()), b"stale-wal").unwrap();

        let report = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32).unwrap();
        assert!(report.rebuilt);
        assert!(!data_dir.join("old.duckdb.wal").exists());

        // Corrupt bytes must fail without deleting or pretending to be an old schema.
        let bad_path = data_dir.join("corrupt.duckdb");
        fs::write(&bad_path, b"not-a-duckdb-file").unwrap();
        assert!(initialize_database(&data_dir, &bad_path, DUCKDB_SCHEMA_VERSION as u32).is_err());
        assert_eq!(fs::read(&bad_path).unwrap(), b"not-a-duckdb-file");
    }
}
