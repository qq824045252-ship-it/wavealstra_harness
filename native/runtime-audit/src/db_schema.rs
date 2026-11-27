//! Rust-owned DuckDB application database initialization, schema verification, one-time
//! SQLite cutover, seed materialization, and startup maintenance (`Step 4`, `DB-01`, `DB-05`, `DB-06`).

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

#[path = "database_release.rs"]
mod database_release;

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
/// `core-worker.lock`), performs the first packaged SQLite cutover, and materializes the
/// canonical schema and startup seeds/repairs without resetting an existing DuckDB.
pub fn initialize_database(
    data_dir: &Path,
    db_path: &Path,
    expected_version: u32,
    release_version: Option<&str>,
) -> crate::Result<InitDatabaseReport> {
    let release = release_version
        .map(|version| database_release::DatabaseRelease::verify(data_dir, db_path, version))
        .transpose()?;
    let guard_directory = release.as_ref().map_or(data_dir, |release| release.root.as_path());
    let _guards = core_lease::initialization_guards(guard_directory)
        .map_err(|e| format!("Core database ownership guard unavailable: {e}"))?;
    let Some(release) = release else {
        return open_and_materialize(db_path).map(|(report, _)| report);
    };
    // The stamp is written only after successful initialization. Older stamps
    // also prove the old SQLite cleanup already ran; do not run it again.
    let stamp = release.read_stamp()?;
    let changed = !release.matches(stamp.as_ref());
    let deleted = if stamp.is_none() && !release.has_cutover_receipt()? {
        release.remove_legacy_sqlite_databases()?
    } else {
        release.verify_current_database(true)?;
        Vec::new()
    };
    let canonical = release.root.join("app.duckdb");
    let replaced_sqlite = deleted.iter().any(|path| Path::new(path) == canonical);
    let (mut report, generation) = open_and_materialize(&canonical)?;
    {
        let mut conn = Connection::open(&canonical)?;
        let tx = conn.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS packaged_sqlite_cutover (database_generation VARCHAR PRIMARY KEY)")?;
        tx.execute("INSERT INTO packaged_sqlite_cutover VALUES (?1) ON CONFLICT DO NOTHING", [&generation])?;
        tx.commit()?;
    }
    if changed || stamp.as_ref().is_some_and(|stamp| stamp.database_generation != generation) {
        release.publish(generation)?;
    }
    report.rebuilt |= replaced_sqlite;
    report.materialized |= changed;
    report.deleted_files = deleted;
    Ok(report)
}

fn open_and_materialize(db_path: &Path) -> crate::Result<(InitDatabaseReport, String)> {
    if let Some(parent) = db_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let (engine, open_report) =
        DuckDbEngine::open_or_initialize(db_path, DuckDbPoolConfig::default())?;
    let mut writer = engine.checkout_writer(std::time::Duration::from_secs(10))?;
    materialize_seeds_and_repairs(writer.conn_mut())?;
    drop(writer);
    drop(engine);
    Ok((InitDatabaseReport {
        schema_version: DUCKDB_SCHEMA_VERSION as u32,
        rebuilt: open_report.rebuilt,
        deleted_files: open_report.deleted_files,
        materialized: open_report.rebuilt,
    }, open_report.database_generation))
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
        let first = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32, None).unwrap();
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

        let second = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32, None).unwrap();
        assert!(!second.rebuilt);
    }

    #[test]
    fn rejects_incompatible_duckdb_and_preserves_unreadable_bytes() {
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
        let original = fs::read(&db_path).unwrap();
        let err = initialize_database(&data_dir, &db_path, DUCKDB_SCHEMA_VERSION as u32, None).unwrap_err();
        assert!(err.to_string().contains("legacy-v0"));
        assert_eq!(fs::read(&db_path).unwrap(), original);

        // Corrupt bytes must fail without deleting or pretending to be an old schema.
        let bad_path = data_dir.join("corrupt.duckdb");
        fs::write(&bad_path, b"not-a-duckdb-file").unwrap();
        assert!(initialize_database(&data_dir, &bad_path, DUCKDB_SCHEMA_VERSION as u32, None).is_err());
        assert_eq!(fs::read(&bad_path).unwrap(), b"not-a-duckdb-file");
    }

    fn obsolete_sqlite(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = [0; 512];
        file[..16].copy_from_slice(b"SQLite format 3\0");
        file[16..18].copy_from_slice(&512u16.to_be_bytes());
        file[18..20].copy_from_slice(&[1, 1]);
        file[21..24].copy_from_slice(&[64, 32, 32]);
        fs::write(path, file).unwrap();
    }

    #[test]
    fn first_release_clears_sqlite_once_and_two_upgrades_keep_duckdb() {
        let s = Sandbox::new("release-upgrade");
        let data = s.0.join(".mybuddy");
        fs::create_dir(&data).unwrap();
        let db = data.join("app.duckdb");
        let legacy = data.join("app.db");
        let durable = data.join("durable").join("a".repeat(64)).join("durable.sqlite");
        let retained = data.join("outside-cleanup.sqlite");
        let gateway = data.join("gateway/spaces/qq-default").join("b".repeat(64)).join("durable.sqlite");
        let cleanup = [
            db.clone(),
            legacy.clone(),
            durable,
            gateway,
            data.join("native-hooks.sqlite"),
            data.join("native-improvement.sqlite"),
            data.join(".mybuddy-writer-lock.sqlite"),
        ];
        for path in cleanup.iter().chain(std::iter::once(&retained)) {
            obsolete_sqlite(path);
        }
        let companion = data.join("app.db-wal");
        fs::write(&companion, "legacy companion").unwrap();
        let init = |version| initialize_database(&data, &db, DUCKDB_SCHEMA_VERSION as u32, Some(version)).unwrap();
        let first = init("0.1.1");
        assert!(first.rebuilt);
        assert_eq!(first.deleted_files.len(), cleanup.len() + 1);
        assert!(cleanup[1..].iter().all(|path| !path.exists()));
        assert!(!companion.exists());
        assert!(retained.exists());
        Connection::open(&db).unwrap().execute(
            "INSERT INTO tasks (id, title, updated_at) VALUES ('retained', 'Keep', 1)", [],
        ).unwrap();
        let read_stamp = || -> database_release::Stamp {
            serde_json::from_slice(&fs::read(data.join("database-release.json")).unwrap()).unwrap()
        };
        let first_stamp = read_stamp();
        obsolete_sqlite(&legacy);
        let late_legacy = fs::read(&legacy).unwrap();
        for version in ["0.1.1", "0.1.2", "0.1.3"] {
            let report = init(version);
            assert!(!report.rebuilt && report.deleted_files.is_empty());
            assert_eq!(read_stamp().release_version, version);
            assert_eq!(read_stamp().database_generation, first_stamp.database_generation);
            assert_eq!(fs::read(&legacy).unwrap(), late_legacy);
            let conn = Connection::open(&db).unwrap();
            let count: i64 = conn.query_row("SELECT count(*) FROM tasks WHERE id='retained'", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn first_packaged_run_preserves_an_unstamped_duckdb_and_retries_unpublished_cleanup() {
        let s = Sandbox::new("release-unstamped");
        let data = s.0.join(".mybuddy");
        fs::create_dir(&data).unwrap();
        let db = data.join("app.duckdb");
        let init = || initialize_database(&data, &db, DUCKDB_SCHEMA_VERSION as u32, Some("0.1.1"));
        let (_, generation) = open_and_materialize(&db).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO tasks (id, title, updated_at) VALUES ('unstamped', 'Keep', 1)", []).unwrap();
        drop(conn);
        let old = data.join("app.db");
        obsolete_sqlite(&old);
        let unrelated = data.join("app.duckdb-shm");
        fs::write(&unrelated, "not associated with a legacy app.duckdb").unwrap();
        let invalid = data.join("native-hooks.sqlite");
        let stamp = data.join("database-release.json");
        let pending = data.join(".database-release.json.pending");
        fs::write(&invalid, "not a database").unwrap();
        assert!(init().is_err());
        assert!(old.is_file() && !stamp.exists());
        fs::remove_file(&invalid).unwrap();
        fs::write(&pending, "interrupted stamp").unwrap();
        let cutover = init().unwrap();
        assert!(!cutover.rebuilt);
        assert_eq!(cutover.deleted_files, [old.display().to_string()]);
        assert!(!old.exists() && !pending.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"not associated with a legacy app.duckdb");
        let saved: database_release::Stamp = serde_json::from_slice(&fs::read(&stamp).unwrap()).unwrap();
        assert_eq!(saved.database_generation, generation);
        let conn = Connection::open(&db).unwrap();
        let title: String = conn.query_row("SELECT title FROM tasks WHERE id='unstamped'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Keep");
    }

    #[test]
    fn stamped_upgrade_recovers_committed_duckdb_wal() {
        let s = Sandbox::new("release-wal");
        let data = s.0.join(".mybuddy");
        fs::create_dir(&data).unwrap();
        let live = s.0.join("live.duckdb");
        let db = data.join("app.duckdb");
        let (_, generation) = open_and_materialize(&live).unwrap();
        let writer = Connection::open(&live).unwrap();
        writer.execute_batch("CHECKPOINT").unwrap();
        writer.execute(
            "INSERT INTO tasks (id, title, updated_at) VALUES ('from-wal', 'Keep', 1)", [],
        ).unwrap();
        // Snapshot an idle writer before the clean close checkpoints its WAL.
        fs::copy(&live, &db).unwrap();
        fs::copy(s.0.join("live.duckdb.wal"), data.join("app.duckdb.wal")).unwrap();
        drop(writer);
        fs::write(
            data.join("database-release.json"),
            serde_json::to_vec(&database_release::Stamp {
                release_version: "0.1.1".to_owned(),
                database_generation: generation.clone(),
                sqlite_cutover_recorded: false,
            }).unwrap(),
        ).unwrap();

        let report = initialize_database(&data, &db, DUCKDB_SCHEMA_VERSION as u32, Some("0.1.2")).unwrap();
        assert!(!report.rebuilt && report.deleted_files.is_empty());
        let saved: database_release::Stamp = serde_json::from_slice(
            &fs::read(data.join("database-release.json")).unwrap(),
        ).unwrap();
        assert_eq!(saved.database_generation, generation);
        let conn = Connection::open(&db).unwrap();
        let title: String = conn.query_row("SELECT title FROM tasks WHERE id='from-wal'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Keep");
    }

    #[test]
    fn preserves_orphan_duckdb_wal_on_first_cutover_and_upgrade() {
        let s = Sandbox::new("orphan-wal");
        let data = s.0.join(".mybuddy");
        fs::create_dir(&data).unwrap();
        let db = data.join("app.duckdb");
        let wal = data.join("app.duckdb.wal");
        let init = |v| initialize_database(&data, &db, DUCKDB_SCHEMA_VERSION as u32, Some(v));
        fs::write(&wal, "preserve").unwrap();
        assert!(init("0.1.1").is_err());
        assert_eq!(fs::read(&wal).unwrap(), b"preserve");
        assert!(!data.join("database-release.json").exists());
        fs::remove_file(&wal).unwrap();
        init("0.1.1").unwrap();
        fs::rename(&db, data.join("fixture-copy.duckdb")).unwrap();
        fs::write(&wal, "still preserve").unwrap();
        assert!(init("0.1.2").is_err());
        assert_eq!(fs::read(&wal).unwrap(), b"still preserve");
        let saved: database_release::Stamp = serde_json::from_slice(
            &fs::read(data.join("database-release.json")).unwrap(),
        ).unwrap();
        assert_eq!(saved.release_version, "0.1.1");
        fs::remove_file(&wal).unwrap();
        assert!(init("0.1.2").is_err());
        assert!(!db.exists());
    }

    #[cfg(unix)]
    #[test]
    fn release_upgrade_refuses_linked_store_before_removing_other_databases() {
        use std::os::unix::fs::symlink;
        let s = Sandbox::new("release-link");
        let data = s.0.join(".mybuddy");
        let outside = s.0.join("outside");
        let db_path = data.join("app.duckdb");
        fs::create_dir_all(data.join("durable")).unwrap();
        obsolete_sqlite(&outside.join("durable.sqlite"));
        obsolete_sqlite(&data.join("app.db"));
        symlink(&outside, data.join("durable").join("a".repeat(64))).unwrap();
        assert!(initialize_database(&data, &db_path, DUCKDB_SCHEMA_VERSION as u32, Some("0.1.1")).is_err());
        assert!(data.join("app.db").is_file());
        assert!(outside.join("durable.sqlite").is_file());
        assert!(!db_path.exists());
    }
}
