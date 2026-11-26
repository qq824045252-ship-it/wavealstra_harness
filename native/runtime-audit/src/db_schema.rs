//! Rust-owned application database initialization, schema verification, incompatible
//! reset, seed materialization, and startup maintenance (`Step 4`, `RC-09`).

use crate::{business_protocol, core_lease};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const CANONICAL_SCHEMA_SQL: &str = include_str!("canonical_schema.sql");

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

fn sidecar_and_main_paths(db_path: &Path) -> [PathBuf; 4] {
    let raw = db_path.as_os_str();
    let suffix = |ext: &str| {
        let mut s = raw.to_os_string();
        s.push(ext);
        PathBuf::from(s)
    };
    [
        suffix("-wal"),
        suffix("-shm"),
        suffix("-journal"),
        db_path.to_path_buf(),
    ]
}

fn probe_user_version(db_path: &Path) -> crate::Result<u32> {
    let db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(500))?;
    let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(version)
}

/// Validates current schema (`expected_version`) under Core's OS guards (`core.lock` +
/// `core-worker.lock`), deletes confirmed incompatible files without backup, never treats
/// unreadable I/O errors as old schema, and materializes canonical schema + startup seeds.
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
    expected_version: u32,
) -> crate::Result<InitDatabaseReport> {
    if let Some(parent) = db_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }

    let targets = sidecar_and_main_paths(db_path);
    let any_exists = targets.iter().any(|p| p.exists());
    let db_exists = db_path.exists();
    let mut rebuilt = false;
    let mut deleted_files = Vec::new();
    let mut start_version = 0u32;

    if any_exists {
        let needs_reset = if db_exists {
            let version = probe_user_version(db_path)?;
            start_version = version;
            version != expected_version
        } else {
            true
        };
        if needs_reset {
            for target in &targets {
                if !target.exists() {
                    continue;
                }
                fs::remove_file(target).map_err(|e| {
                    format!("无法删除不兼容数据库 {}，未重建: {e}", db_path.display())
                })?;
                deleted_files.push(target.display().to_string());
            }
            if targets.iter().any(|p| p.exists()) {
                return Err(format!("无法重建不兼容数据库：旧数据库文件仍存在 {}", db_path.display()).into());
            }
            rebuilt = true;
            start_version = 0;
        }
    }

    let mut conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;

    let materialized = if start_version != expected_version || needs_materialization(&conn)? {
        materialize_schema(&mut conn, expected_version)?;
        true
    } else {
        // Still apply idempotent startup recovery/cleanups inside an IMMEDIATE transaction.
        run_startup_repairs(&mut conn)?;
        false
    };

    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(InitDatabaseReport {
        schema_version: expected_version,
        rebuilt,
        deleted_files,
        materialized,
    })
}

fn needs_materialization(conn: &Connection) -> crate::Result<bool> {
    for required in ["spaces", "tasks", "soul", "projects", "works", "notifications"] {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                [required],
                |row| row.get(0),
            )
            .ok();
        if found.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn materialize_schema(conn: &mut Connection, expected_version: u32) -> crate::Result<()> {
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(CANONICAL_SCHEMA_SQL)?;
    tx.execute(
        "INSERT OR IGNORE INTO runtime_snapshot_writer VALUES (1, 0, '', 0)",
        [],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO runtime_diagnostic_writer VALUES (1, 0, 0)",
        [],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO soul (id, name, alias, persona) VALUES (1, 'MyBuddy', '老板', '你是本地桌面助理，简洁、可靠、会动手。')",
        [],
    )?;
    tx.pragma_update(None, "user_version", expected_version)?;
    tx.commit()?;
    business_protocol::ensure_tables(conn, &business_protocol::current_core_generation())?;
    run_startup_repairs(conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

pub fn run_startup_repairs(conn: &mut Connection) -> crate::Result<()> {
    let now = now_ms();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Legacy welcome_mode normalization ('bot' -> 'general').
    let _ = tx.execute("UPDATE tasks SET welcome_mode = 'general' WHERE welcome_mode = 'bot'", []);
    let _ = tx.execute("UPDATE cron_jobs SET welcome_mode = 'general' WHERE welcome_mode = 'bot'", []);
    let _ = tx.execute(
        "UPDATE task_runtime_context_snapshots SET welcome_mode = 'general' WHERE welcome_mode = 'bot'",
        [],
    );
    let _ = tx.execute(
        "UPDATE agent_loadout_observations SET context_json = json_set(context_json, '$.mode', 'general') WHERE json_valid(context_json) AND json_extract(context_json, '$.mode') = 'bot'",
        [],
    );
    // Recover cron runs left running after unexpected shutdown without auto-replaying.
    let _ = tx.execute(
        "UPDATE cron_runs SET status = 'error', finished_at = ?, error = '应用退出中断执行，未自动重放' WHERE status = 'running'",
        [now],
    );
    // Reset interrupted memory extraction / organization runs safely.
    let _ = tx.execute(
        "UPDATE memory_turns SET extraction_state = 'failed', updated_at = ? WHERE extraction_state = 'processing'",
        [now],
    );
    let _ = tx.execute(
        "UPDATE memory_organization_runs SET status = 'paused', updated_at = ? WHERE status = 'scanning'",
        [now],
    );
    // Recover pending interaction prompts left active across crash.
    let _ = tx.execute(
        "UPDATE conversation_interactions SET status = 'expired', version = version + 1, resolved_at = ? WHERE status = 'pending'",
        [now],
    );
    // Seed default Dots answer routing policy and initial version baseline if missing.
    let default_rule_config = r#"{"title":"默认调度策略","include":[],"exclude":[],"instruction":"按本轮请求和已知任务状态选择直答或委派。","evidenceFile":"","enabled":true,"projectId":null,"sourceMemoryId":null,"policy":{"version":1,"routeMode":"auto","foregroundReadLimits":{"characters":24000,"sources":4,"calls":6},"trackingPolicy":{"milestones":true,"heartbeatMs":null,"silenceMs":120000}}}"#;
    let _ = tx.execute(
        "INSERT OR IGNORE INTO answer_rules(id, revision, enabled, config) VALUES ('dots-default-policy', 1, 1, ?1)",
        [default_rule_config],
    );
    let _ = tx.execute(
        "INSERT OR IGNORE INTO answer_rule_versions(rule_id, revision, at, source, title, config)
         SELECT id, revision, ?1, 'baseline', COALESCE(json_extract(config, '$.title'), ''), config
         FROM answer_rules r WHERE NOT EXISTS (SELECT 1 FROM answer_rule_versions v WHERE v.rule_id = r.id)",
        [now],
    );
    // Hide legacy nonzero shell/code exit failures that are not pending recovery items.
    let _ = tx.execute(
        "UPDATE execution_failures SET dismissed_at = COALESCE(dismissed_at, ?1)
         WHERE cause_code IN ('shell-exit-nonzero', 'code-execution-exit-nonzero') AND resolved_at IS NULL AND dismissed_at IS NULL",
        [now],
    );
    // Fence any running diagnostic spans from a previous host session.
    let _ = tx.execute(
        "UPDATE task_request_diagnostics SET record_json = json_set(record_json, '$.status', 'interrupted')
         WHERE json_extract(record_json, '$.status') = 'running'",
        [],
    );
    let _ = tx.execute(
        "UPDATE task_tool_diagnostics SET record_json = json_set(record_json, '$.status', 'interrupted', '$.complete', json('false'), '$.segmentStartedAt', NULL)
         WHERE json_extract(record_json, '$.status') = 'running'",
        [],
    );
    let _ = tx.execute(
        "UPDATE scope_tool_diagnostics SET record_json = json_set(record_json, '$.status', 'interrupted', '$.complete', json('false'), '$.segmentStartedAt', NULL)
         WHERE json_extract(record_json, '$.status') = 'running'",
        [],
    );
    // Mark external agent runs orphaned by previous exit as failed recovery candidates.
    let _ = tx.execute(
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
    );
    let _ = tx.execute(
        "UPDATE external_agent_runs SET cancellation_evidence='unconfirmed' WHERE cancellation_evidence='requested'",
        [],
    );
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
        let db_path = data_dir.join("app.db");
        let first = initialize_database(&data_dir, &db_path, 36).unwrap();
        assert_eq!(first.materialized, true);
        assert_eq!(first.rebuilt, false);
        assert_eq!(probe_user_version(&db_path).unwrap(), 36);

        let conn = Connection::open(&db_path).unwrap();
        let soul_name: String = conn
            .query_row("SELECT name FROM soul WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(soul_name, "MyBuddy");
        drop(conn);

        let second = initialize_database(&data_dir, &db_path, 36).unwrap();
        assert_eq!(second.materialized, false);
        assert_eq!(second.rebuilt, false);
    }

    #[test]
    fn discards_incompatible_schema_and_sidecars_without_backup_and_preserves_unreadable_bytes() {
        let s = Sandbox::new("discard");
        let data_dir = s.0.join("data");
        let db_path = data_dir.join("old.db");
        fs::create_dir_all(&data_dir).unwrap();
        let old = Connection::open(&db_path).unwrap();
        old.pragma_update(None, "user_version", 35u32).unwrap();
        old.execute_batch("CREATE TABLE legacy(x INT); INSERT INTO legacy VALUES (1);").unwrap();
        drop(old);
        fs::write(format!("{}-wal", db_path.display()), b"stale-wal").unwrap();
        fs::write(format!("{}-shm", db_path.display()), b"stale-shm").unwrap();

        let report = initialize_database(&data_dir, &db_path, 36).unwrap();
        assert_eq!(report.rebuilt, true);
        assert_eq!(report.materialized, true);
        assert!(!data_dir.join("old.db-wal").exists());
        assert_eq!(probe_user_version(&db_path).unwrap(), 36);

        // Corrupt bytes must fail without deleting or pretending to be an old schema.
        let bad_path = data_dir.join("corrupt.db");
        fs::write(&bad_path, b"not-a-sqlite-file").unwrap();
        assert!(initialize_database(&data_dir, &bad_path, 36).is_err());
        assert_eq!(fs::read(&bad_path).unwrap(), b"not-a-sqlite-file");
    }
}
