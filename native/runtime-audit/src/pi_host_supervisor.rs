//! Step 8: Rust Core Pi Node Host Supervisor & Generation Lease Fencing (`RC-20`..`RC-22`).
//!
//! Launches, registers, heartbeats, fences, and stops the isolated `pi-node-host` OS process
//! under Rust Core so Electron Main can exit or crash without interrupting active non-desktop
//! Pi execution, while fenced/stale Pi Host generations are rejected at Core commit boundaries.

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, dispatch_waiting_executions,
};
use crate::database::{DuckDbEngine, PooledConnection};
use crate::outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx};
use crate::resource_gate::ResourceLease;
use crate::work_scheduler::now_ms;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static HOST_GEN_SEQ: AtomicU64 = AtomicU64::new(1);
const DEFAULT_STARTUP_GRACE_MS: i64 = 20_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS: i64 = 20_000;
const MAX_CONSECUTIVE_CRASH_RESTARTS: i64 = 5;

fn env_duration_ms(key: &str, default_ms: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v >= 200)
        .unwrap_or(default_ms)
}

fn crash_backoff_ms(failures: i64) -> i64 {
    match failures {
        i64::MIN..=0 => 0,
        1 => 500,
        2 => 1_500,
        3 => 3_000,
        _ => 5_000,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiHostRecord {
    pub host_id: String,
    pub pid: i64,
    pub alive: bool,
    pub core_generation: String,
    pub host_generation: String,
    pub storage_root: String,
    pub db_path: String,
    pub pi_version: String,
    pub status: String,
    pub started_at_ms: i64,
    pub last_heartbeat_ms: i64,
    pub stopped_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status,
    VerifyLease {
        host_generation: String,
        storage_root: Option<String>,
    },
    Launch {
        executable: PathBuf,
        script_path: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        data_directory: PathBuf,
        db_path: PathBuf,
        storage_root: PathBuf,
        pi_version: String,
        expected_pi_version: String,
        host_id: Option<String>,
        force_restart: Option<bool>,
        runtime_audit_executable: Option<PathBuf>,
        #[serde(default)]
        extra_env: HashMap<String, String>,
        #[serde(default)]
        auto_restart: Option<bool>,
    },
    Bootstrap {
        host_id: String,
        pid: i64,
        host_generation: String,
        storage_root: String,
        db_path: Option<String>,
        pi_version: String,
        expected_pi_version: String,
    },
    Register {
        host_id: String,
        pid: i64,
        host_generation: String,
        storage_root: String,
        db_path: Option<String>,
        pi_version: String,
        expected_pi_version: String,
        #[serde(default)]
        capabilities: Option<Vec<String>>,
        #[serde(default)]
        recovered_task_ids: Vec<String>,
        #[serde(default)]
        require_manifest: bool,
    },
    Heartbeat {
        host_id: String,
        pid: i64,
        host_generation: String,
    },
    Stop {
        host_id: Option<String>,
        reason: Option<String>,
    },
    FenceGeneration {
        host_generation: String,
        reason: Option<String>,
    },
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Command::Status | Command::VerifyLease { .. })
    }
}

pub fn ensure_pi_host_tables(_db: &Connection) -> crate::Result<()> {
    Ok(())
}

pub fn is_generation_fenced(db: &Connection, host_generation: &str) -> bool {
    let Ok(exists): Result<Option<i64>, _> = db
        .query_row(
            "SELECT 1 FROM core_pi_host_fences WHERE host_generation = ?1",
            [host_generation],
            |row| row.get(0),
        )
        .optional()
    else {
        return false;
    };
    exists.is_some()
}

pub fn is_pid_alive(pid: i64) -> bool {
    if pid <= 0 || pid > u32::MAX as i64 {
        return false;
    }
    let pid_u32 = pid as u32;
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn OpenProcess(desired_access: u32, inherit_handles: i32, process_id: u32) -> isize;
            fn GetExitCodeProcess(process: isize, exit_code: *mut u32) -> i32;
            fn CloseHandle(object: isize) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid_u32);
            if handle == 0 {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(not(windows))]
    {
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let res = unsafe { kill(pid_u32 as i32, 0) };
        if res == 0 {
            true
        } else {
            matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(1) // EPERM: process exists
            )
        }
    }
}

fn terminate_pid(pid: i64) {
    if !is_pid_alive(pid) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = ProcessCommand::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let pid_i32 = pid as i32;
        unsafe {
            kill(-pid_i32, 15); // SIGTERM group
            kill(pid_i32, 15);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        if is_pid_alive(pid) {
            unsafe {
                kill(-pid_i32, 9); // SIGKILL
                kill(pid_i32, 9);
            }
        }
    }
}

fn spawn_detached_pi_host(
    executable: &PathBuf,
    script_path: &PathBuf,
    args: &[String],
    data_directory: &PathBuf,
    db_path: &PathBuf,
    storage_root: &PathBuf,
    host_id: &str,
    host_generation: &str,
    runtime_audit_executable: Option<&PathBuf>,
    extra_env: &HashMap<String, String>,
) -> crate::Result<u32> {
    if !executable.exists() {
        return Err(format!("Pi Host executable not found: {}", executable.display()).into());
    }
    if !script_path.exists() {
        return Err(format!("Pi Host script not found: {}", script_path.display()).into());
    }
    let logs_dir = data_directory.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let log_file = logs_dir.join("pi-node-host.log");
    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    let mut cmd = ProcessCommand::new(executable);
    cmd.arg(script_path);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(data_directory);
    cmd.env("ELECTRON_RUN_AS_NODE", "1");
    cmd.env("MYBUDDY_PI_HOST", "1");
    cmd.env("MYBUDDY_PI_HOST_ID", host_id);
    cmd.env("MYBUDDY_PI_HOST_GENERATION", host_generation);
    cmd.env("MYBUDDY_DATA_DIR", data_directory);
    cmd.env("MYBUDDY_DB_PATH", db_path);
    cmd.env("MYBUDDY_PI_STORAGE_ROOT", storage_root);
    if let Some(ra) = runtime_audit_executable {
        cmd.env("MYBUDDY_RUNTIME_AUDIT_EXE", ra);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(stdout_file);
    cmd.stderr(stderr_file);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                unsafe extern "C" {
                    fn setsid() -> i32;
                }
                setsid();
                Ok(())
            });
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn isolated Pi Node Host: {e}"))?;
    Ok(child.id())
}

fn read_all_hosts(db: &Connection) -> crate::Result<Vec<PiHostRecord>> {
    let mut stmt = db.prepare(
        "SELECT host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version, status,
                started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
         FROM core_pi_hosts
         ORDER BY started_at_ms DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            let pid: i64 = row.get(1)?;
            let status: String = row.get(7)?;
            let alive = (status == "starting" || status == "bootstrapping" || status == "running")
                && pid > 0
                && is_pid_alive(pid);
            Ok(PiHostRecord {
                host_id: row.get(0)?,
                pid,
                alive,
                core_generation: row.get(2)?,
                host_generation: row.get(3)?,
                storage_root: row.get(4)?,
                db_path: row.get(5)?,
                pi_version: row.get(6)?,
                status,
                started_at_ms: row.get(8)?,
                last_heartbeat_ms: row.get(9)?,
                stopped_at_ms: row.get(10)?,
                last_error: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    let hosts_table_exists = crate::database::table_exists(db, "core_pi_hosts")?;
    match command {
        Command::Status => {
            if !hosts_table_exists {
                return Ok(json!({ "activeHost": null, "hosts": [], "fencedCount": 0 }));
            }
            let hosts = read_all_hosts(db)?;
            let active = hosts
                .iter()
                .find(|h| {
                    (h.status == "running" || h.status == "bootstrapping" || h.status == "starting")
                        && h.alive
                })
                .cloned();
            let fenced_count: i64 = db.query_row(
                "SELECT COUNT(*) FROM core_pi_host_fences",
                [],
                |row| row.get(0),
            )?;
            Ok(json!({
                "activeHost": active,
                "hosts": hosts,
                "fencedCount": fenced_count,
            }))
        }
        Command::VerifyLease {
            host_generation,
            storage_root,
        } => {
            if !hosts_table_exists {
                return Ok(json!({ "valid": false, "reason": "not_initialized" }));
            }
            if is_generation_fenced(db, &host_generation) {
                return Ok(json!({ "valid": false, "fenced": true, "reason": "generation_fenced" }));
            }
            let row: Option<(String, i64, String, String)> = db
                .query_row(
                    "SELECT host_id, pid, storage_root, status FROM core_pi_hosts WHERE host_generation = ?1",
                    [&host_generation],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let Some((host_id, pid, row_root, status)) = row else {
                return Ok(json!({ "valid": false, "reason": "unknown_host_generation" }));
            };
            if let Some(expected_root) = storage_root
                && expected_root != row_root
            {
                return Ok(json!({ "valid": false, "reason": "storage_root_mismatch" }));
            }
            let alive = is_pid_alive(pid);
            let active =
                (status == "starting" || status == "bootstrapping" || status == "running") && alive;
            Ok(json!({
                "valid": active,
                "fenced": false,
                "hostId": host_id,
                "pid": pid,
                "alive": alive,
                "status": status,
            }))
        }
        _ => Err("Invalid read-only PiHost command".into()),
    }
}

fn simple_fx(data: Value) -> WriteSideEffects {
    WriteSideEffects {
        data,
        events: Vec::new(),
        dispatches: Vec::new(),
        shutdown_after_reply: false,
    }
}

pub fn execute_write(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    execute_write_with_gate(db, tracker, client, command, |op| {
        op();
        Ok(())
    })
}

struct LaunchPlan {
    next_host_id: String,
    next_gen: String,
    prev_pid_to_terminate: Option<i64>,
    executable: PathBuf,
    script_path: PathBuf,
    args: Vec<String>,
    data_directory: PathBuf,
    db_path: PathBuf,
    storage_root: PathBuf,
    pi_version: String,
    expected_pi_version: String,
    runtime_audit_executable: Option<PathBuf>,
    extra_env: HashMap<String, String>,
    auto_restart_flag: i64,
}

fn cleanup_failed_launch(db: &mut Connection, host_id: &str, host_generation: &str, error_msg: &str) {
    let now = now_ms();
    if let Ok(tx) = db.transaction() {
        let _ = tx.execute(
            "UPDATE core_pi_hosts SET status = 'failed', stopped_at_ms = ?1, last_error = ?2
             WHERE host_id = ?3 AND host_generation = ?4 AND status = 'launching'",
            params![now, error_msg, host_id, host_generation],
        );
        let _ = crate::request_control::commit_finalization(tx, "failed Pi host launch");
    }
}

fn cleanup_cancelled_launch(db: &mut Connection, host_id: &str, host_generation: &str, pid: i64) {
    let now = now_ms();
    if let Ok(tx) = db.transaction() {
        let _ = tx.execute(
            "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
             VALUES (?1, 'cancelled_during_launch', ?2) ON CONFLICT DO NOTHING",
            params![host_generation, now],
        );
        let _ = tx.execute(
            "UPDATE core_pi_hosts SET pid = ?1, status = 'stopped', stopped_at_ms = ?2, last_error = 'cancelled_during_launch'
             WHERE host_id = ?3 AND host_generation = ?4
               AND ((status = 'launching' AND pid = 0)
                    OR (pid = ?1 AND status IN ('starting', 'bootstrapping', 'running')))",
            params![pid, now, host_id, host_generation],
        );
        let _ = crate::request_control::commit_finalization(tx, "cancelled Pi host launch");
    }
}

fn confirm_spawned_host(
    tx: &duckdb::Transaction<'_>,
    host_id: &str,
    host_generation: &str,
    pid: u32,
    now: i64,
) -> crate::Result<Option<String>> {
    let fenced = tx.query_row(
        "SELECT 1 FROM core_pi_host_fences WHERE host_generation = ?1",
        [host_generation],
        |row| row.get::<_, i32>(0),
    ).optional()?.is_some();
    if fenced {
        return Ok(None);
    }
    let pid = i64::from(pid);
    let updated = tx.execute(
        "UPDATE core_pi_hosts SET pid = ?1, status = 'starting', last_heartbeat_ms = ?2
         WHERE host_id = ?3 AND host_generation = ?4 AND status = 'launching' AND pid = 0",
        params![pid, now, host_id, host_generation],
    )?;
    if updated == 1 {
        return Ok(Some("starting".into()));
    }
    // The child can bootstrap or register before its parent finishes the spawn call.
    tx.query_row(
        "SELECT status FROM core_pi_hosts WHERE host_id = ?1 AND host_generation = ?2
         AND pid = ?3 AND status IN ('starting', 'bootstrapping', 'running')",
        params![host_id, host_generation, pid],
        |row| row.get(0),
    ).optional().map_err(Into::into)
}

fn defer_interrupted_goals(
    tx: &duckdb::Transaction<'_>,
    host_generation: &str,
    now: i64,
) -> crate::Result<usize> {
    let mut stmt = tx.prepare(
        "SELECT c.work_id, c.task_id, c.intent_revision, c.attempt_serial, w.user_id
         FROM conversation_goal_continuations c LEFT JOIN works w USING (work_id)
         WHERE c.state = 'igniting' ORDER BY c.work_id",
    )?;
    let interrupted = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?, row.get::<_, Option<String>>(4)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let operation_id = format!("pi-host-bootstrap:{host_generation}");
    for (batch_index, (work_id, task_id, intent_revision, attempt_serial, user_id)) in
        interrupted.iter().enumerate()
    {
        tx.execute(
            "UPDATE conversation_goal_continuations
             SET state = 'deferred', defer_reason = 'restart', deferred_at = ?1, updated_at = GREATEST(updated_at, ?1)
             WHERE work_id = ?2 AND state = 'igniting'",
            params![now, work_id],
        )?;
        let group_id = format!("goal-continuation-restart:{}", json!([host_generation, work_id]));
        append_outbox_group_in_tx(
            tx,
            &OutboxGroupDraft {
                group_id: group_id.clone(),
                operation_id: operation_id.clone(),
                batch_index: batch_index as i64,
                entity_key: format!("work:{work_id}"),
                entity_revision: None,
                previous_revision: None,
                depends_on_group_id: None,
                work_projection_user_id: user_id.clone(),
            },
            &[OutboxEventDraft {
                event_id: group_id,
                owner_generation: host_generation.into(),
                domain: "work".into(),
                kind: "work.goalContinuationDeferred".into(),
                task_id: Some(task_id.clone()),
                entity_id: work_id.clone(),
                revision: *intent_revision,
                command_id: Some(operation_id.clone()),
                payload_json: json!({
                    "taskId": task_id,
                    "workId": work_id,
                    "intentRevision": intent_revision,
                    "attemptSerial": attempt_serial,
                    "state": "deferred",
                    "reason": "restart",
                }).to_string(),
            }],
            now,
        )?;
    }
    Ok(interrupted.len())
}

pub enum AfterProcessEffect {
    Resume,
    Finish,
}

pub trait PiHostPhase {
    fn connection(&mut self) -> crate::Result<&mut Connection>;
    fn process_effect(&mut self, next: AfterProcessEffect, effect: &mut dyn FnMut()) -> crate::Result<()>;
}

struct DirectPhase<'a, F> {
    db: &'a mut Connection,
    without_gate: F,
}

impl<F: FnMut(&mut dyn FnMut()) -> crate::Result<()>> PiHostPhase for DirectPhase<'_, F> {
    fn connection(&mut self) -> crate::Result<&mut Connection> {
        Ok(self.db)
    }

    fn process_effect(&mut self, _next: AfterProcessEffect, effect: &mut dyn FnMut()) -> crate::Result<()> {
        (self.without_gate)(effect)
    }
}

pub struct PiHostWritePhase<'a> {
    engine: &'a DuckDbEngine,
    request_id: Option<&'a str>,
    timeout: Duration,
    connection: Option<PooledConnection>,
    lease: Option<ResourceLease>,
}

impl<'a> PiHostWritePhase<'a> {
    pub fn new(engine: &'a DuckDbEngine, lease: ResourceLease, request_id: Option<&'a str>, timeout: Duration) -> Self {
        Self { engine, request_id, timeout, connection: None, lease: Some(lease) }
    }
}

impl PiHostPhase for PiHostWritePhase<'_> {
    fn connection(&mut self) -> crate::Result<&mut Connection> {
        if self.lease.is_none() {
            return Err("PiHost phase has no write permit".into());
        }
        if self.connection.is_none() {
            let mut connection = self.engine.checkout_writer(self.timeout)?;
            if let (Some(id), Some(control)) = (self.request_id, crate::request_control::shared()) {
                connection.bind_request(id, control.clone());
            }
            self.connection = Some(connection);
        }
        Ok(self.connection.as_mut().expect("writer checked out").conn_mut())
    }

    fn process_effect(&mut self, next: AfterProcessEffect, effect: &mut dyn FnMut()) -> crate::Result<()> {
        drop(self.connection.take());
        let lease = self.lease.take().ok_or("PiHost phase has no permit to release")?;
        match next {
            AfterProcessEffect::Resume => {
                let suspended = lease.suspend();
                effect();
                self.lease = Some(suspended.resume(self.timeout)
                    .map_err(|error| format!("PiHost phase could not resume: {error:?}"))?);
            }
            AfterProcessEffect::Finish => {
                drop(lease);
                effect();
            }
        }
        Ok(())
    }
}

/// Direct adapter for callers that already own a connection, including in-memory tests.
pub fn execute_write_with_gate<F>(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
    without_gate: F,
) -> crate::Result<WriteSideEffects>
where
    F: FnMut(&mut dyn FnMut()) -> crate::Result<()>,
{
    execute_write_in_phase(&mut DirectPhase { db, without_gate }, tracker, client, command)
}

pub fn execute_write_in_phase(
    phase: &mut impl PiHostPhase,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    ensure_pi_host_tables(phase.connection()?)?;
    let now = now_ms();
    let core_gen = current_core_generation();
    let mut events: Vec<EmittedEvent> = Vec::new();
    let mut dispatches: Vec<Value> = Vec::new();
    let data = match command {
        Command::Status | Command::VerifyLease { .. } => execute_read(phase.connection()?, command)?,
        Command::Launch {
            executable,
            script_path,
            args,
            data_directory,
            db_path,
            storage_root,
            pi_version,
            expected_pi_version,
            host_id,
            force_restart,
            runtime_audit_executable,
            extra_env,
            auto_restart,
        } => {
            if pi_version != expected_pi_version {
                crate::request_control::known_failure();
                return Err(format!(
                    "Pi version mismatch: expected {expected_pi_version}, got {pi_version}"
                )
                .into());
            }
            let storage_root_str = storage_root.to_string_lossy().into_owned();
            let db_path_str = db_path.to_string_lossy().into_owned();
            let auto_restart_flag = if auto_restart == Some(false) { 0 } else { 1 };
            let startup_grace = env_duration_ms("MYBUDDY_PI_HOST_STARTUP_GRACE_MS", DEFAULT_STARTUP_GRACE_MS);
            let hb_timeout = env_duration_ms("MYBUDDY_PI_HOST_HEARTBEAT_TIMEOUT_MS", DEFAULT_HEARTBEAT_TIMEOUT_MS);

            // Phase 1: short IMMEDIATE transaction records intent ('launching') & fences stale owners.
            let plan = {
                let tx = phase.connection()?.transaction()?;
                let existing: Option<(String, i64, String, String, i64, i64)> = tx
                    .query_row(
                        "SELECT host_id, pid, host_generation, status, started_at_ms, last_heartbeat_ms
                         FROM core_pi_hosts
                         WHERE storage_root = ?1 AND status IN ('launching', 'starting', 'bootstrapping', 'running')
                         ORDER BY started_at_ms DESC LIMIT 1",
                        [&storage_root_str],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                            ))
                        },
                    )
                    .optional()?;

                let mut prev_pid_to_terminate: Option<i64> = None;
                if let Some((prev_id, prev_pid, prev_gen, prev_status, prev_started, prev_hb)) = existing {
                    let healthy_alive = prev_pid > 0
                        && is_pid_alive(prev_pid)
                        && (((prev_status == "starting" || prev_status == "bootstrapping")
                            && now.saturating_sub(prev_started) <= startup_grace)
                            || (prev_status == "running" && now.saturating_sub(prev_hb) <= hb_timeout));
                    let launch_in_progress = prev_status == "launching"
                        && now.saturating_sub(prev_started) <= startup_grace;
                    if (healthy_alive || launch_in_progress) && force_restart != Some(true) {
                        crate::request_control::commit(tx)?;
                        return Ok(simple_fx(json!({
                            "launched": false,
                            "alreadyRunning": true,
                            "hostId": prev_id,
                            "pid": prev_pid,
                            "hostGeneration": prev_gen,
                            "status": prev_status,
                        })));
                    }
                    let fence_reason = if force_restart == Some(true) {
                        "force_restart"
                    } else if prev_status == "launching" {
                        "abandoned_launch"
                    } else if prev_pid > 0 && is_pid_alive(prev_pid) {
                        "heartbeat_timeout"
                    } else {
                        "dead_reaped"
                    };
                    tx.execute(
                        "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                         VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                        params![&prev_gen, fence_reason, now],
                    )?;
                    tx.execute(
                        "UPDATE core_pi_hosts SET status = ?1, stopped_at_ms = ?2, last_error = ?3 WHERE host_id = ?4",
                        params![
                            if force_restart == Some(true) {
                                "stopped"
                            } else if prev_status == "launching" {
                                "failed"
                            } else {
                                "crashed"
                            },
                            now,
                            fence_reason,
                            &prev_id
                        ],
                    )?;
                    if prev_pid > 0 && is_pid_alive(prev_pid) {
                        prev_pid_to_terminate = Some(prev_pid);
                    }
                }

                let seq = HOST_GEN_SEQ.fetch_add(1, Ordering::Relaxed);
                let next_host_id = host_id.unwrap_or_else(|| format!("pi-host-{now}-{seq}"));
                let next_gen = format!("pi-gen-{now}-{seq}");
                tx.execute(
                    "INSERT INTO core_pi_hosts (
                        host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                        status, started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
                     ) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, 'launching', ?7, ?7, NULL, NULL)",
                    params![
                        &next_host_id,
                        &core_gen,
                        &next_gen,
                        &storage_root_str,
                        &db_path_str,
                        &pi_version,
                        now
                    ],
                )?;
                crate::request_control::commit(tx)?;
                LaunchPlan {
                    next_host_id,
                    next_gen,
                    prev_pid_to_terminate,
                    executable,
                    script_path,
                    args,
                    data_directory,
                    db_path,
                    storage_root,
                    pi_version,
                    expected_pi_version,
                    runtime_audit_executable,
                    extra_env,
                    auto_restart_flag,
                }
            };

            let LaunchPlan {
                next_host_id,
                next_gen,
                prev_pid_to_terminate,
                executable,
                script_path,
                args,
                data_directory,
                db_path,
                storage_root,
                pi_version,
                expected_pi_version,
                runtime_audit_executable,
                extra_env,
                auto_restart_flag,
            } = plan;

            if let Err(error) = crate::request_control::checkpoint() {
                cleanup_cancelled_launch(phase.connection()?, &next_host_id, &next_gen, 0);
                return Err(error);
            }
            // Phase 2: terminate previous host (if forced) & spawn detached child OUTSIDE TX and write_gate.
            let mut spawn_result: Option<crate::Result<u32>> = None;
            let resumed = phase.process_effect(AfterProcessEffect::Resume, &mut || {
                if let Some(prev_pid) = prev_pid_to_terminate {
                    terminate_pid(prev_pid);
                }
                spawn_result = Some(spawn_detached_pi_host(
                    &executable,
                    &script_path,
                    &args,
                    &data_directory,
                    &db_path,
                    &storage_root,
                    &next_host_id,
                    &next_gen,
                    runtime_audit_executable.as_ref(),
                    &extra_env,
                ));
            });

            if let Err(error) = resumed {
                if let Some(Ok(pid)) = spawn_result {
                    terminate_pid(i64::from(pid));
                }
                return Err(error);
            }

            // Phase 3: finalize 'launching' -> 'starting' or clean up on failure/cancellation.
            let pid = match spawn_result.expect("spawn executed") {
                Ok(pid) => pid,
                Err(err) => {
                    cleanup_failed_launch(phase.connection()?, &next_host_id, &next_gen, &err.to_string());
                    if prev_pid_to_terminate.is_none() {
                        crate::request_control::known_failure();
                    }
                    return Err(err);
                }
            };

            if let Err(cancel_err) = crate::request_control::checkpoint() {
                phase.process_effect(AfterProcessEffect::Resume, &mut || {
                    terminate_pid(pid as i64);
                })?;
                cleanup_cancelled_launch(phase.connection()?, &next_host_id, &next_gen, pid as i64);
                return Err(cancel_err);
            }

            let finalize_res = (|| -> crate::Result<(EmittedEvent, String)> {
                let fin_now = now_ms();
                let tx = phase.connection()?.transaction()?;
                let status = confirm_spawned_host(&tx, &next_host_id, &next_gen, pid, fin_now)?
                    .ok_or("PiHost launch intent was superseded before finalization")?;
                let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
                let extra_env_json = serde_json::to_string(&extra_env).unwrap_or_else(|_| "{}".into());
                let runtime_exec_str = runtime_audit_executable.as_ref().map(|p| p.to_string_lossy().into_owned());
                tx.execute(
                    "INSERT INTO core_pi_host_launch_specs (
                        storage_root, executable, script_path, args_json, data_directory, db_path,
                        pi_version, expected_pi_version, runtime_audit_executable, extra_env_json,
                        auto_restart, consecutive_failures, next_restart_at_ms, last_error, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, NULL, ?12)
                     ON CONFLICT(storage_root) DO UPDATE SET
                        executable = excluded.executable,
                        script_path = excluded.script_path,
                        args_json = excluded.args_json,
                        data_directory = excluded.data_directory,
                        db_path = excluded.db_path,
                        pi_version = excluded.pi_version,
                        expected_pi_version = excluded.expected_pi_version,
                        runtime_audit_executable = excluded.runtime_audit_executable,
                        extra_env_json = excluded.extra_env_json,
                        auto_restart = excluded.auto_restart,
                        consecutive_failures = 0,
                        next_restart_at_ms = 0,
                        last_error = NULL,
                        updated_at_ms = excluded.updated_at_ms",
                    params![
                        &storage_root_str,
                        executable.to_string_lossy().as_ref(),
                        script_path.to_string_lossy().as_ref(),
                        &args_json,
                        data_directory.to_string_lossy().as_ref(),
                        db_path.to_string_lossy().as_ref(),
                        &pi_version,
                        &expected_pi_version,
                        runtime_exec_str.as_deref(),
                        &extra_env_json,
                        auto_restart_flag,
                        fin_now
                    ],
                )?;
                let ev = append_event(
                    &tx,
                    &core_gen,
                    &next_gen,
                    "pi-host",
                    "piHostLaunched",
                    &next_host_id,
                    1,
                    None,
                    &json!({
                        "hostId": next_host_id,
                        "pid": pid,
                        "hostGeneration": next_gen,
                        "piVersion": pi_version,
                        "storageRoot": storage_root_str,
                    }),
                )?;
                crate::request_control::commit(tx)?;
                Ok((ev, status))
            })();

            match finalize_res {
                Ok((ev, status)) => {
                    events.push(ev);
                    json!({
                        "launched": true,
                        "alreadyRunning": false,
                        "hostId": next_host_id,
                        "pid": pid,
                        "hostGeneration": next_gen,
                        "status": status,
                    })
                }
                Err(err) => {
                    phase.process_effect(AfterProcessEffect::Resume, &mut || {
                        terminate_pid(pid as i64);
                    })?;
                    cleanup_cancelled_launch(phase.connection()?, &next_host_id, &next_gen, pid as i64);
                    return Err(err);
                }
            }
        }
        Command::Bootstrap {
            host_id,
            pid,
            host_generation,
            storage_root,
            db_path,
            pi_version,
            expected_pi_version,
        } => {
            if pi_version != expected_pi_version {
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": format!("Pi version mismatch: expected {expected_pi_version}, got {pi_version}"),
                })));
            }
            let tx = phase.connection()?.transaction()?;
            if is_generation_fenced(&tx, &host_generation) {
                crate::request_control::commit(tx)?;
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": "stale_host_generation",
                })));
            }
            let identities = {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation, storage_root, status FROM core_pi_hosts
                     WHERE host_id = ?1 OR host_generation = ?2",
                )?;
                stmt.query_map(params![&host_id, &host_generation], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?, row.get::<_, String>(4)?))
                })?.collect::<Result<Vec<_>, _>>()?
            };
            let existing = match identities.as_slice() {
                [] => false,
                [(stored_id, stored_pid, generation, root, status)]
                    if stored_id == &host_id && generation == &host_generation && root == &storage_root
                        && (*stored_pid == pid || (*stored_pid == 0 && status == "launching")) =>
                {
                    if status == "bootstrapping" || status == "running" {
                        crate::request_control::commit(tx)?;
                        return Ok(simple_fx(json!({
                            "accepted": true,
                            "fenced": false,
                            "status": status,
                            "hostId": host_id,
                            "pid": pid,
                            "hostGeneration": host_generation,
                            "deferredGoals": 0,
                        })));
                    }
                    if matches!(status.as_str(), "launching" | "starting") {
                        true
                    } else {
                        crate::request_control::commit(tx)?;
                        return Ok(simple_fx(json!({
                            "accepted": false,
                            "fenced": true,
                            "reason": "inactive_host_generation",
                        })));
                    }
                }
                _ => {
                    crate::request_control::commit(tx)?;
                    return Ok(simple_fx(json!({
                        "accepted": false,
                        "fenced": true,
                        "reason": "host_identity_mismatch",
                    })));
                }
            };

            let competing_owners = {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation, storage_root FROM core_pi_hosts h
                     WHERE status IN ('starting', 'bootstrapping', 'running') AND host_generation <> ?1
                       AND NOT EXISTS (SELECT 1 FROM core_pi_host_fences f WHERE f.host_generation = h.host_generation)
                     ORDER BY started_at_ms DESC, host_id",
                )?;
                stmt.query_map([&host_generation], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
                })?.collect::<Result<Vec<_>, _>>()?
            };
            let mut another_live_owner = false;
            for (active_id, active_pid, active_gen, active_root) in competing_owners {
                let live = is_pid_alive(active_pid);
                if active_root != storage_root {
                    another_live_owner |= live;
                    continue;
                }
                if live {
                    tx.execute(
                        "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                         VALUES (?1, 'superseded_by_live_host', ?2) ON CONFLICT DO NOTHING",
                        params![&host_generation, now],
                    )?;
                    crate::request_control::commit(tx)?;
                    return Ok(simple_fx(json!({
                        "accepted": false,
                        "fenced": true,
                        "reason": "active_owner_exists",
                        "activeHostId": active_id,
                        "activeHostGeneration": active_gen,
                    })));
                }
                tx.execute(
                    "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, 'dead_owner_superseded', ?2) ON CONFLICT DO NOTHING",
                    params![&active_gen, now],
                )?;
                tx.execute(
                    "UPDATE core_pi_hosts SET status = 'crashed', stopped_at_ms = ?1 WHERE host_id = ?2",
                    params![now, &active_id],
                )?;
            }

            if existing {
                tx.execute(
                    "UPDATE core_pi_hosts
                     SET pid = ?1, core_generation = ?2, host_generation = ?3, status = 'bootstrapping',
                         last_heartbeat_ms = ?4, stopped_at_ms = NULL
                     WHERE host_id = ?5",
                    params![pid, &core_gen, &host_generation, now, &host_id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO core_pi_hosts (
                        host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                        status, started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'bootstrapping', ?8, ?8, NULL, NULL)",
                    params![
                        &host_id,
                        pid,
                        &core_gen,
                        &host_generation,
                        &storage_root,
                        db_path.unwrap_or_default(),
                        &pi_version,
                        now
                    ],
                )?;
            }
            // The continuation ledger is database-wide. A different live root can still own an attempt.
            let deferred_goals = if another_live_owner {
                0
            } else {
                defer_interrupted_goals(&tx, &host_generation, now)?
            };
            let ev = append_event(
                &tx,
                &core_gen,
                &host_generation,
                "pi-host",
                "piHostBootstrapping",
                &host_id,
                1,
                None,
                &json!({
                    "hostId": host_id,
                    "pid": pid,
                    "hostGeneration": host_generation,
                    "storageRoot": storage_root,
                }),
            )?;
            events.push(ev);
            crate::request_control::commit(tx)?;
            tracker.set_bootstrapping();
            json!({
                "accepted": true,
                "fenced": false,
                "status": "bootstrapping",
                "hostId": host_id,
                "pid": pid,
                "hostGeneration": host_generation,
                "deferredGoals": deferred_goals,
            })
        }
        Command::Register {
            host_id,
            pid,
            host_generation,
            storage_root,
            db_path,
            pi_version,
            expected_pi_version,
            capabilities,
            recovered_task_ids,
            require_manifest,
        } => {
            if pi_version != expected_pi_version {
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": format!("Pi version mismatch: expected {expected_pi_version}, got {pi_version}"),
                })));
            }
            if require_manifest && capabilities.as_ref().is_none_or(|c| c.is_empty()) {
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": false,
                    "reason": "capability_manifest_required",
                })));
            }
            let tx = phase.connection()?.transaction()?;
            if is_generation_fenced(&tx, &host_generation) {
                crate::request_control::commit(tx)?;
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": "stale_host_generation",
                })));
            }
            let conflicting: Option<(String, i64, String)> = tx
                .query_row(
                    "SELECT host_id, pid, host_generation FROM core_pi_hosts
                     WHERE storage_root = ?1 AND status IN ('bootstrapping', 'running') AND host_generation != ?2
                     ORDER BY started_at_ms DESC LIMIT 1",
                    params![&storage_root, &host_generation],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((active_id, active_pid, active_gen)) = conflicting {
                if active_pid != pid && is_pid_alive(active_pid) {
                    tx.execute(
                        "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                         VALUES (?1, 'superseded_by_live_host', ?2) ON CONFLICT DO NOTHING",
                        params![&host_generation, now],
                    )?;
                    crate::request_control::commit(tx)?;
                    return Ok(simple_fx(json!({
                        "accepted": false,
                        "fenced": true,
                        "reason": "active_owner_exists",
                        "activeHostId": active_id,
                        "activeHostGeneration": active_gen,
                    })));
                }
                // Prior owner is dead; fence its generation before admitting recovery generation.
                tx.execute(
                    "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, 'dead_owner_superseded', ?2) ON CONFLICT DO NOTHING",
                    params![&active_gen, now],
                )?;
                tx.execute(
                    "UPDATE core_pi_hosts SET status = 'crashed', stopped_at_ms = ?1 WHERE host_id = ?2",
                    params![now, &active_id],
                )?;
            }

            let exists: Option<String> = tx
                .query_row(
                    "SELECT host_id FROM core_pi_hosts WHERE host_id = ?1",
                    [&host_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                tx.execute(
                    "UPDATE core_pi_hosts
                     SET pid = ?1, core_generation = ?2, host_generation = ?3, status = 'running',
                         last_heartbeat_ms = ?4, stopped_at_ms = NULL
                     WHERE host_id = ?5",
                    params![pid, &core_gen, &host_generation, now, &host_id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO core_pi_hosts (
                        host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                        status, started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?8, NULL, NULL)",
                    params![
                        &host_id,
                        pid,
                        &core_gen,
                        &host_generation,
                        &storage_root,
                        db_path.unwrap_or_default(),
                        &pi_version,
                        now
                    ],
                )?;
            }
            let _ = tx.execute(
                "UPDATE core_pi_host_launch_specs
                 SET consecutive_failures = 0, next_restart_at_ms = 0, last_error = NULL, updated_at_ms = ?1
                 WHERE storage_root = ?2",
                params![now, &storage_root],
            );
            let ev = append_event(
                &tx,
                &core_gen,
                &host_generation,
                "pi-host",
                "piHostReady",
                &host_id,
                1,
                None,
                &json!({
                    "hostId": host_id,
                    "pid": pid,
                    "hostGeneration": host_generation,
                    "storageRoot": storage_root,
                    "capabilities": capabilities,
                }),
            )?;
            events.push(ev);
            for task_id in &recovered_task_ids {
                tx.execute(
                    "UPDATE core_execution_runs
                     SET status = 'running', owner_generation = ?1, wait_reason = 'recovered_in_host', revision = revision + 1
                     WHERE task_id = ?2 AND status IN ('queued', 'waiting_executor')",
                    params![&host_generation, task_id],
                )?;
            }
            tracker.set_ready_capabilities(
                capabilities.clone().map(|v| v.into_iter().collect()),
                require_manifest,
            );
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            crate::request_control::commit(tx)?;
            crate::work_scheduler::apply_committed_promotion_dispatches(tracker, &dispatches);
            let _ = client;
            json!({
                "accepted": true,
                "fenced": false,
                "hostId": host_id,
                "pid": pid,
                "hostGeneration": host_generation,
                "capabilities": capabilities,
            })
        }
        Command::Heartbeat {
            host_id,
            pid,
            host_generation,
        } => {
            let tx = phase.connection()?.transaction()?;
            if is_generation_fenced(&tx, &host_generation) {
                crate::request_control::commit(tx)?;
                return Ok(simple_fx(json!({ "accepted": false, "fenced": true, "reason": "generation_fenced" })));
            }
            let updated = tx.execute(
                "UPDATE core_pi_hosts
                 SET last_heartbeat_ms = ?1
                 WHERE host_id = ?2 AND host_generation = ?3 AND pid = ?4 AND status IN ('starting', 'bootstrapping', 'running')",
                params![now, &host_id, &host_generation, pid],
            )?;
            crate::request_control::commit(tx)?;
            if updated == 0 {
                json!({ "accepted": false, "fenced": true, "reason": "not_active_owner" })
            } else {
                json!({ "accepted": true, "fenced": false, "heartbeatAt": now })
            }
        }
        Command::Stop { host_id, reason } => {
            let tx = phase.connection()?.transaction()?;
            let targets: Vec<(String, i64, String, String)> = if let Some(ref hid) = host_id {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation, storage_root FROM core_pi_hosts WHERE host_id = ?1 AND status IN ('launching', 'starting', 'bootstrapping', 'running')",
                )?;
                stmt.query_map([hid], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation, storage_root FROM core_pi_hosts WHERE status IN ('launching', 'starting', 'bootstrapping', 'running')",
                )?;
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let reason_str = reason.unwrap_or_else(|| "explicit_stop".into());
            for (hid, _pid, hgen, sroot) in &targets {
                tx.execute(
                    "UPDATE core_pi_host_launch_specs SET auto_restart = 0, updated_at_ms = ?1 WHERE storage_root = ?2",
                    params![now, sroot],
                )?;
                tx.execute(
                    "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                    params![hgen, &reason_str, now],
                )?;
                tx.execute(
                    "UPDATE core_pi_hosts SET status = 'stopped', stopped_at_ms = ?1, last_error = ?2 WHERE host_id = ?3",
                    params![now, &reason_str, hid],
                )?;
                let ev = append_event(
                    &tx,
                    &core_gen,
                    hgen,
                    "pi-host",
                    "piHostStopped",
                    hid,
                    1,
                    None,
                    &json!({ "hostId": hid, "hostGeneration": hgen, "reason": reason_str }),
                )?;
                events.push(ev);
            }
            if host_id.is_none() {
                tx.execute(
                    "UPDATE core_pi_host_launch_specs SET auto_restart = 0, updated_at_ms = ?1",
                    params![now],
                )?;
            }
            crate::request_control::commit(tx)?;
            phase.process_effect(AfterProcessEffect::Finish, &mut || {
                for (_hid, pid, _hgen, _sroot) in &targets {
                    if *pid > 0 {
                        terminate_pid(*pid);
                    }
                }
            })?;
            json!({ "stopped": targets.len(), "reason": reason_str })
        }
        Command::FenceGeneration {
            host_generation,
            reason,
        } => {
            let tx = phase.connection()?.transaction()?;
            let reason_str = reason.unwrap_or_else(|| "manual_fence".into());
            tx.execute(
                "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                 VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                params![&host_generation, &reason_str, now],
            )?;
            tx.execute(
                "UPDATE core_pi_hosts SET status = 'fenced', stopped_at_ms = ?1, last_error = ?2
                 WHERE host_generation = ?3 AND status IN ('launching', 'starting', 'bootstrapping', 'running')",
                params![now, &reason_str, &host_generation],
            )?;
            crate::request_control::commit(tx)?;
            json!({ "fenced": true, "hostGeneration": host_generation })
        }
    };
    Ok(WriteSideEffects {
        data,
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

/// Core-owned unattended Pi Node Host recovery tick: detects dead or heartbeat-stale
/// hosts whose launch spec has `auto_restart = 1`, fences the dead generation, and
/// respawns a new host generation with bounded crash backoff.
#[cfg(test)]
pub fn supervise_tick<F>(
    db: &mut Connection,
    _tracker: &ExecutorTracker,
    without_gate: F,
) -> crate::Result<Option<WriteSideEffects>>
where
    F: FnMut(&mut dyn FnMut()) -> crate::Result<()>,
{
    supervise_tick_in_phase(&mut DirectPhase { db, without_gate }, _tracker)
}

pub fn supervise_tick_in_phase(
    phase: &mut impl PiHostPhase,
    _tracker: &ExecutorTracker,
) -> crate::Result<Option<WriteSideEffects>> {
    if !crate::business_protocol::table_exists(phase.connection()?, "core_pi_host_launch_specs")? {
        return Ok(None);
    }
    let now = now_ms();
    let core_gen = current_core_generation();
    let startup_grace = env_duration_ms("MYBUDDY_PI_HOST_STARTUP_GRACE_MS", DEFAULT_STARTUP_GRACE_MS);
    let hb_timeout = env_duration_ms("MYBUDDY_PI_HOST_HEARTBEAT_TIMEOUT_MS", DEFAULT_HEARTBEAT_TIMEOUT_MS);

    #[derive(Clone)]
    struct LaunchSpecRow {
        storage_root: String,
        executable: String,
        script_path: String,
        args_json: String,
        data_directory: String,
        db_path: String,
        pi_version: String,
        expected_pi_version: String,
        runtime_audit_executable: Option<String>,
        extra_env_json: String,
        consecutive_failures: i64,
        next_restart_at_ms: i64,
    }

    let specs: Vec<LaunchSpecRow> = {
        let mut stmt = phase.connection()?.prepare(
            "SELECT storage_root, executable, script_path, args_json, data_directory, db_path,
                    pi_version, expected_pi_version, runtime_audit_executable, extra_env_json,
                    consecutive_failures, next_restart_at_ms
             FROM core_pi_host_launch_specs
             WHERE auto_restart = 1",
        )?;
        stmt.query_map([], |row| {
            Ok(LaunchSpecRow {
                storage_root: row.get(0)?,
                executable: row.get(1)?,
                script_path: row.get(2)?,
                args_json: row.get(3)?,
                data_directory: row.get(4)?,
                db_path: row.get(5)?,
                pi_version: row.get(6)?,
                expected_pi_version: row.get(7)?,
                runtime_audit_executable: row.get(8)?,
                extra_env_json: row.get(9)?,
                consecutive_failures: row.get(10)?,
                next_restart_at_ms: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    if specs.is_empty() {
        return Ok(None);
    }

    let mut events = Vec::new();
    let mut recovered_count = 0usize;

    for spec in specs {
        let latest: Option<(String, i64, String, String, i64, i64)> = phase.connection()?
            .query_row(
                "SELECT host_id, pid, host_generation, status, started_at_ms, last_heartbeat_ms
                 FROM core_pi_hosts
                 WHERE storage_root = ?1
                 ORDER BY started_at_ms DESC LIMIT 1",
                [&spec.storage_root],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;

        let mut pid_to_terminate: Option<i64> = None;
        let recovery_reason: Option<&'static str> = match latest {
            None => Some("missing_host"),
            Some((_, _, _, ref st, _, _)) if st == "stopped" => None,
            Some((_, _, _, ref st, _, _)) if matches!(st.as_str(), "crashed" | "failed" | "fenced") => {
                Some("previous_host_terminated")
            }
            Some((_, _, _, ref st, started, _)) if st == "launching" => {
                if now.saturating_sub(started) > startup_grace {
                    Some("abandoned_launch")
                } else {
                    None
                }
            }
            Some((_, pid, _, ref st, started, last_hb))
                if st == "starting" || st == "bootstrapping" || st == "running" =>
            {
                if pid <= 0 || !is_pid_alive(pid) {
                    Some("process_died")
                } else if (st == "starting" || st == "bootstrapping")
                    && now.saturating_sub(started) > startup_grace
                {
                    pid_to_terminate = Some(pid);
                    Some("startup_timeout")
                } else if st == "running" && now.saturating_sub(last_hb) > hb_timeout {
                    pid_to_terminate = Some(pid);
                    Some("heartbeat_timeout")
                } else {
                    None
                }
            }
            _ => None,
        };

        let Some(reason) = recovery_reason else {
            continue;
        };

        if spec.pi_version != spec.expected_pi_version {
            continue;
        }

        if spec.consecutive_failures >= MAX_CONSECUTIVE_CRASH_RESTARTS {
            let tx = phase.connection()?.transaction()?;
            tx.execute(
                "UPDATE core_pi_host_launch_specs
                 SET auto_restart = 0, last_error = 'crash_restart_budget_exhausted', updated_at_ms = ?1
                 WHERE storage_root = ?2",
                params![now, &spec.storage_root],
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "pi-host",
                "piHostRestartExhausted",
                &spec.storage_root,
                spec.consecutive_failures + 1,
                None,
                &json!({
                    "storageRoot": spec.storage_root,
                    "consecutiveFailures": spec.consecutive_failures,
                    "reason": reason,
                }),
            )?;
            crate::request_control::commit(tx)?;
            events.push(ev);
            continue;
        }

        if now < spec.next_restart_at_ms {
            continue;
        }

        // Phase 1: fence stale host generation and insert launching intent inside a short TX.
        let (next_host_id, next_gen) = {
            let tx = phase.connection()?.transaction()?;
            let active_rows: Vec<(String, i64, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation, status
                     FROM core_pi_hosts
                     WHERE storage_root = ?1 AND status IN ('launching', 'starting', 'bootstrapping', 'running')",
                )?;
                stmt.query_map([&spec.storage_root], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            for (prev_id, prev_pid, prev_gen, prev_status) in active_rows {
                tx.execute(
                    "INSERT INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                    params![&prev_gen, reason, now],
                )?;
                tx.execute(
                    "UPDATE core_pi_hosts SET status = 'crashed', stopped_at_ms = ?1, last_error = ?2 WHERE host_id = ?3",
                    params![
                        now,
                        if prev_status == "launching" { "abandoned_launch" } else { reason },
                        &prev_id
                    ],
                )?;
                if prev_pid > 0 && is_pid_alive(prev_pid) && pid_to_terminate.is_none() {
                    pid_to_terminate = Some(prev_pid);
                }
            }

            let next_failures = spec.consecutive_failures + 1;
            let next_restart_at = now + crash_backoff_ms(next_failures);
            tx.execute(
                "UPDATE core_pi_host_launch_specs
                 SET consecutive_failures = ?1, next_restart_at_ms = ?2, last_error = ?3, updated_at_ms = ?4
                 WHERE storage_root = ?5",
                params![next_failures, next_restart_at, reason, now, &spec.storage_root],
            )?;

            let seq = HOST_GEN_SEQ.fetch_add(1, Ordering::Relaxed);
            let next_host_id = format!("pi-host-{now}-{seq}");
            let next_gen = format!("pi-gen-{now}-{seq}");
            tx.execute(
                "INSERT INTO core_pi_hosts (
                    host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                    status, started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
                 ) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, 'launching', ?7, ?7, NULL, NULL)",
                params![
                    &next_host_id,
                    &core_gen,
                    &next_gen,
                    &spec.storage_root,
                    &spec.db_path,
                    &spec.pi_version,
                    now
                ],
            )?;
            crate::request_control::commit(tx)?;
            (next_host_id, next_gen)
        };

        // Phase 2: terminate hung PID if needed and spawn detached child outside write_gate & TX.
        let args: Vec<String> = serde_json::from_str(&spec.args_json).unwrap_or_default();
        let extra_env: HashMap<String, String> = serde_json::from_str(&spec.extra_env_json).unwrap_or_default();
        let exec_pb = PathBuf::from(&spec.executable);
        let script_pb = PathBuf::from(&spec.script_path);
        let data_pb = PathBuf::from(&spec.data_directory);
        let db_pb = PathBuf::from(&spec.db_path);
        let root_pb = PathBuf::from(&spec.storage_root);
        let rt_exec_pb = spec.runtime_audit_executable.as_ref().map(PathBuf::from);
        let mut spawn_res: Option<crate::Result<u32>> = None;
        let resumed = phase.process_effect(AfterProcessEffect::Resume, &mut || {
            if let Some(pid) = pid_to_terminate {
                terminate_pid(pid);
            }
            spawn_res = Some(spawn_detached_pi_host(
                &exec_pb,
                &script_pb,
                &args,
                &data_pb,
                &db_pb,
                &root_pb,
                &next_host_id,
                &next_gen,
                rt_exec_pb.as_ref(),
                &extra_env,
            ));
        });
        if let Err(error) = resumed {
            if let Some(Ok(pid)) = spawn_res {
                terminate_pid(i64::from(pid));
            }
            return Err(error);
        }

        // Phase 3: finalize 'starting' or mark failed.
        match spawn_res.expect("spawn executed") {
            Ok(new_pid) => {
                let finalized = (|| -> crate::Result<Option<EmittedEvent>> {
                    let tx = phase.connection()?.transaction()?;
                    if confirm_spawned_host(&tx, &next_host_id, &next_gen, new_pid, now_ms())?.is_none() {
                        return Ok(None);
                    }
                    let event = append_event(
                        &tx,
                        &core_gen,
                        &next_gen,
                        "pi-host",
                        "piHostRecovered",
                        &next_host_id,
                        1,
                        None,
                        &json!({
                            "hostId": next_host_id,
                            "pid": new_pid,
                            "hostGeneration": next_gen,
                            "storageRoot": spec.storage_root,
                            "reason": reason,
                            "attempt": spec.consecutive_failures + 1,
                        }),
                    )?;
                    crate::request_control::commit(tx)?;
                    Ok(Some(event))
                })();
                match finalized {
                    Ok(Some(event)) => {
                        events.push(event);
                        recovered_count += 1;
                    }
                    other => {
                        phase.process_effect(AfterProcessEffect::Resume, &mut || terminate_pid(i64::from(new_pid)))?;
                        if let Err(error) = other {
                            cleanup_cancelled_launch(phase.connection()?, &next_host_id, &next_gen, i64::from(new_pid));
                            return Err(error);
                        }
                    }
                }
            }
            Err(err) => {
                cleanup_failed_launch(phase.connection()?, &next_host_id, &next_gen, &err.to_string());
            }
        }
    }

    if events.is_empty() && recovered_count == 0 {
        return Ok(None);
    }
    Ok(Some(WriteSideEffects {
        data: json!({ "recoveredHosts": recovered_count }),
        events,
        dispatches: Vec::new(),
        shutdown_after_reply: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;

    fn setup_test_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::database::CANONICAL_DUCKDB_SCHEMA_SQL)
            .unwrap();
        let _ = crate::business_protocol::ensure_tables(&db, &current_core_generation());
        db
    }

    #[test]
    fn process_effect_makes_the_only_writer_connection_available() -> crate::Result<()> {
        use crate::database::DuckDbPoolConfig;
        use crate::resource_gate::{ResourceGate, ResourceKey, ResourceRequirement};

        let dir = std::env::temp_dir().join(format!("mybuddy-pi-effect-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir)?;
        let config = DuckDbPoolConfig { write_pool_size: 1, ..Default::default() };
        let (engine, _) = DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        let gate = ResourceGate::new(8);
        let lease = gate.acquire(
            vec![ResourceRequirement::exclusive(ResourceKey::PublisherOrder)],
            Duration::from_secs(1),
            || false,
        ).expect("initial Pi host permit");
        let mut phase = PiHostWritePhase::new(&engine, lease, None, Duration::from_secs(1));
        phase.connection()?;
        let mut other_writer_count = 0_i64;
        phase.process_effect(AfterProcessEffect::Resume, &mut || {
            if let Ok(other) = engine.checkout_writer(Duration::from_millis(100)) {
                other_writer_count = other.conn().query_row("SELECT 1", [], |row| row.get(0)).unwrap();
            }
        })?;
        assert_eq!(other_writer_count, 1);
        let finalized: i64 = phase.connection()?.query_row("SELECT 2", [], |row| row.get(0))?;
        assert_eq!(finalized, 2);
        phase.process_effect(AfterProcessEffect::Finish, &mut || {})?;
        assert!(phase.connection().is_err());
        drop(phase);
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn pi_host_registration_fences_stale_generation_and_preserves_version_pin() {
        let mut db = setup_test_db();
        let tracker = ExecutorTracker::new();
        let ctx = ClientContext::synthetic(&current_core_generation());
        let my_pid = std::process::id() as i64;

        let bad_ver = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Register {
                host_id: "h-old".into(),
                pid: my_pid,
                host_generation: "gen-old".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "0.99.2".into(),
                expected_pi_version: "1.5.0".into(),
                capabilities: None,
                recovered_task_ids: vec![],
                require_manifest: false,
            },
        )
        .unwrap();
        assert_eq!(bad_ver.data["accepted"], false);
        assert_eq!(bad_ver.data["fenced"], true);

        let reg1 = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Register {
                host_id: "h1".into(),
                pid: my_pid,
                host_generation: "gen-1".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
                capabilities: Some(vec!["pi_turn".into(), "pi_control".into()]),
                recovered_task_ids: vec![],
                require_manifest: false,
            },
        )
        .unwrap();
        assert_eq!(reg1.data["accepted"], true);
        assert!(tracker.supports_kind("pi_turn"));
        assert!(!tracker.supports_kind("dots_control"));

        let hb1 = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Heartbeat {
                host_id: "h1".into(),
                pid: my_pid,
                host_generation: "gen-1".into(),
            },
        )
        .unwrap();
        assert_eq!(hb1.data["accepted"], true);

        let _ = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::FenceGeneration {
                host_generation: "gen-1".into(),
                reason: Some("crash_recovery_takeover".into()),
            },
        )
        .unwrap();

        let hb_stale = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Heartbeat {
                host_id: "h1".into(),
                pid: my_pid,
                host_generation: "gen-1".into(),
            },
        )
        .unwrap();
        assert_eq!(hb_stale.data["accepted"], false);
        assert_eq!(hb_stale.data["fenced"], true);

        let lease_check = execute_read(
            &db,
            Command::VerifyLease {
                host_generation: "gen-1".into(),
                storage_root: Some("/tmp/store".into()),
            },
        )
        .unwrap();
        assert_eq!(lease_check["valid"], false);
        assert_eq!(lease_check["fenced"], true);

        let reg2 = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Register {
                host_id: "h2".into(),
                pid: my_pid,
                host_generation: "gen-2".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
                capabilities: Some(vec!["pi_turn".into(), "dots_control".into()]),
                recovered_task_ids: vec![],
                require_manifest: false,
            },
        )
        .unwrap();
        assert_eq!(reg2.data["accepted"], true);
        assert!(tracker.supports_kind("dots_control"));
    }

    #[test]
    fn three_phase_bootstrap_fences_dispatch_until_manifest_and_skips_recovered() {
        let mut db = setup_test_db();
        let tracker = ExecutorTracker::new();
        tracker.set_presence(true, 1, "pi-client".into());
        let ctx = ClientContext::synthetic(&current_core_generation());
        let my_pid = std::process::id() as i64;
        let now = now_ms();

        // Seed two waiting executions: one recovered during phase 2, one fresh waiting dispatch.
        for (eid, tid, key) in [
            ("exec-recovered", "task-recovered", "k-rec"),
            ("exec-fresh", "task-fresh", "k-fresh"),
        ] {
            db.execute(
                "INSERT INTO core_execution_runs (
                    execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                    task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, 'core-1', 'gateway', 'cli', 1, ?3, 'pi_turn', '{}', 'waiting_executor', 1, 0, ?4, ?4)",
                params![eid, key, tid, now],
            )
            .unwrap();
        }

        // Phase 1: Bootstrap keeps tracker unready & blocks dispatch
        let boot = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Bootstrap {
                host_id: "h-3p".into(),
                pid: my_pid,
                host_generation: "gen-3p".into(),
                storage_root: "/tmp/store-3p".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
            },
        )
        .unwrap();
        assert_eq!(boot.data["accepted"], true);
        assert_eq!(boot.data["status"], "bootstrapping");
        assert!(boot.dispatches.is_empty());
        assert!(!tracker.is_ready());
        assert!(!tracker.supports_kind("pi_turn"));

        // Register with require_manifest=true and empty manifest must be refused & keep waiting
        let empty_reg = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Register {
                host_id: "h-3p".into(),
                pid: my_pid,
                host_generation: "gen-3p".into(),
                storage_root: "/tmp/store-3p".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
                capabilities: Some(vec![]),
                recovered_task_ids: vec![],
                require_manifest: true,
            },
        )
        .unwrap();
        assert_eq!(empty_reg.data["accepted"], false);
        assert_eq!(empty_reg.data["reason"], "capability_manifest_required");
        assert!(!tracker.is_ready());

        // Phase 3: Register with non-empty manifest & recovered task IDs skips recovered task
        let reg = execute_write(
            &mut db,
            &tracker,
            &ctx,
            Command::Register {
                host_id: "h-3p".into(),
                pid: my_pid,
                host_generation: "gen-3p".into(),
                storage_root: "/tmp/store-3p".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
                capabilities: Some(vec!["pi_turn".into()]),
                recovered_task_ids: vec!["task-recovered".into()],
                require_manifest: true,
            },
        )
        .unwrap();
        assert_eq!(reg.data["accepted"], true);
        assert!(tracker.is_ready());
        assert!(tracker.supports_kind("pi_turn"));
        assert!(!tracker.supports_kind("other_kind"));
        assert_eq!(reg.dispatches.len(), 1);
        assert_eq!(reg.dispatches[0]["coreExecutionDispatch"]["execution"]["executionId"], "exec-fresh");
        let rec_status: String = db
            .query_row(
                "SELECT status FROM core_execution_runs WHERE execution_id = 'exec-recovered'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rec_status, "running");
    }

    #[test]
    fn pi_host_bootstrap_defers_interrupted_goals_once_and_preserves_live_attempts() {
        let mut db = setup_test_db();
        let tracker = ExecutorTracker::new();
        tracker.set_presence(true, 1, "pi-client".into());
        let ctx = ClientContext::synthetic(&current_core_generation());
        let pid = i64::from(std::process::id());
        let root = "/tmp/goal-restart-store";
        let version = "current-test-version";
        let boot = |db: &mut Connection, host_id: &str, generation: &str, reported_pid: i64| {
            execute_write(db, &tracker, &ctx, Command::Bootstrap {
                host_id: host_id.into(), pid: reported_pid, host_generation: generation.into(),
                storage_root: root.into(), db_path: None, pi_version: version.into(),
                expected_pi_version: version.into(),
            }).unwrap()
        };
        db.execute_batch(
            "INSERT INTO core_pi_hosts
                (host_id,pid,core_generation,host_generation,storage_root,db_path,pi_version,status,started_at_ms,last_heartbeat_ms)
             VALUES ('old-host',0,'old-core','old-gen','/tmp/goal-restart-store','db','version','running',1,1);
             INSERT INTO works (work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,
                input_snapshot_id,created_by,created_at,updated_at)
             VALUES ('old-goal','goal-user','bot','Goal','{}','goal-intent','goal-input','user',1,1);
             INSERT INTO conversation_goal_continuations
               (work_id,task_id,intent_revision,attempts,attempt_serial,tokens_used,tokens_budget,time_used_seconds,
                usage_cursor,progress_fingerprint,progress_stalls,run_cursor,last_token_at,last_continuation_at,state,updated_at)
             VALUES ('old-goal','old-task',2,3,4,500,600,7,8,'seen-progress',9,10,11,12,'igniting',13),
                    ('new-goal','new-task',1,0,0,0,NULL,0,0,NULL,0,0,NULL,NULL,'idle',13);",
        ).unwrap();

        let first = boot(&mut db, "host", "current", pid);
        assert_eq!(first.data["deferredGoals"], 1);
        assert!(first.dispatches.is_empty());
        assert!(is_generation_fenced(&db, "old-gen"));
        let interrupted: (String, String, i64, i64, i64, i64, i64, i64, String, i64, i64, i64, i64) = db.query_row(
            "SELECT state,defer_reason,attempts,attempt_serial,tokens_used,tokens_budget,time_used_seconds,usage_cursor,
                progress_fingerprint,progress_stalls,run_cursor,last_token_at,last_continuation_at
             FROM conversation_goal_continuations WHERE work_id = 'old-goal' AND deferred_at IS NOT NULL",
            [],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,
                    r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?)),
        ).unwrap();
        let (state, reason, attempts, serial, used, budget, seconds, usage, fingerprint, stalls, run, token_at, wake_at) = interrupted;
        assert_eq!((state.as_str(), reason.as_str(), fingerprint.as_str()), ("deferred", "restart", "seen-progress"));
        assert_eq!([attempts, serial, used, budget, seconds, usage, stalls, run, token_at, wake_at], [3, 4, 500, 600, 7, 8, 9, 10, 11, 12]);
        let checkpoint = |db: &Connection| db.query_row(
            "SELECT state FROM conversation_goal_continuations WHERE work_id = 'new-goal'",
            [], |row| row.get::<_, String>(0),
        ).unwrap();
        assert_eq!(checkpoint(&db), "idle");

        let duplicate = boot(&mut db, "host", "current", pid);
        assert_eq!(duplicate.data["deferredGoals"], 0);
        assert!(duplicate.events.is_empty());
        assert_eq!(boot(&mut db, "other-id", "current", pid).data["reason"], "host_identity_mismatch");
        assert_eq!(boot(&mut db, "old-host", "old-gen", pid).data["reason"], "stale_host_generation");
        let registered = execute_write(&mut db, &tracker, &ctx, Command::Register {
            host_id: "host".into(), pid, host_generation: "current".into(), storage_root: root.into(),
            db_path: None, pi_version: version.into(), expected_pi_version: version.into(),
            capabilities: Some(vec!["pi_turn".into()]), recovered_task_ids: vec![], require_manifest: true,
        }).unwrap();
        assert_eq!(registered.data["accepted"], true);
        db.execute("UPDATE conversation_goal_continuations SET state = 'igniting' WHERE work_id = 'new-goal'", []).unwrap();
        assert_eq!(boot(&mut db, "host", "current", pid).data["status"], "running");
        assert_eq!(boot(&mut db, "another-host", "another-gen", pid).data["reason"], "active_owner_exists");
        assert!(tracker.is_ready());
        assert_eq!(checkpoint(&db), "igniting");

        let mut stmt = db.prepare(
            "SELECT task_id, entity_id, work_projection_user_id FROM domain_outbox_events JOIN domain_outbox_groups USING (group_id)
             WHERE kind = 'work.goalContinuationDeferred'",
        ).unwrap();
        let pending = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap().collect::<Result<Vec<(String, String, String)>, _>>().unwrap();
        assert_eq!(pending, vec![("old-task".into(), "old-goal".into(), "goal-user".into())]);
    }

    #[test]
    fn failed_launch_cleans_up_launching_intent_and_releases_gate() {
        let mut db = setup_test_db();
        let tracker = ExecutorTracker::new();
        let ctx = ClientContext::synthetic(&current_core_generation());
        let mut gate_toggled = false;
        let err = execute_write_with_gate(
            &mut db,
            &tracker,
            &ctx,
            Command::Launch {
                executable: PathBuf::from("nonexistent-pi-host-binary-xyz"),
                script_path: PathBuf::from("nonexistent-pi-host-script.cjs"),
                args: vec![],
                data_directory: PathBuf::from("/tmp/data"),
                db_path: PathBuf::from("/tmp/app.db"),
                storage_root: PathBuf::from("/tmp/store-fail"),
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
                host_id: Some("h-fail".into()),
                force_restart: None,
                runtime_audit_executable: None,
                extra_env: HashMap::new(),
                auto_restart: Some(false),
            },
            |op| {
                gate_toggled = true;
                op();
                Ok(())
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not found"));
        assert!(gate_toggled, "spawn must run via without_gate");
        let status: String = db
            .query_row(
                "SELECT status FROM core_pi_hosts WHERE host_id = 'h-fail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
        let st = execute_read(&db, Command::Status).unwrap();
        assert!(st["activeHost"].is_null());
    }

    #[test]
    fn spawn_finalization_accepts_early_bootstrap_of_the_same_process_only() {
        let mut db = setup_test_db();
        db.execute(
            "INSERT INTO core_pi_hosts
                (host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                 status, started_at_ms, last_heartbeat_ms)
             VALUES ('host', 123, 'core', 'current', 'store', 'app.duckdb', 'test', 'bootstrapping', 1, 1)",
            [],
        ).unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(confirm_spawned_host(&tx, "host", "current", 123, 2).unwrap().as_deref(), Some("bootstrapping"));
        assert_eq!(confirm_spawned_host(&tx, "host", "old", 123, 2).unwrap(), None);
        assert_eq!(confirm_spawned_host(&tx, "host", "current", 456, 2).unwrap(), None);
        tx.execute("UPDATE core_pi_hosts SET status = 'stopped' WHERE host_id = 'host'", []).unwrap();
        assert_eq!(confirm_spawned_host(&tx, "host", "current", 123, 2).unwrap(), None);
        tx.commit().unwrap();
    }

    #[test]
    fn supervise_tick_caps_crash_restart_loop_when_launch_repeatedly_fails() {
        let mut db = setup_test_db();
        let tracker = ExecutorTracker::new();
        let now = now_ms();
        db.execute(
            "INSERT INTO core_pi_host_launch_specs (
                storage_root, executable, script_path, args_json, data_directory, db_path,
                pi_version, expected_pi_version, runtime_audit_executable, extra_env_json,
                auto_restart, consecutive_failures, next_restart_at_ms, last_error, updated_at_ms
             ) VALUES ('/tmp/loop', 'missing-exe', 'missing.cjs', '[]', '/tmp', '/tmp/a.db',
                       '1.5.0', '1.5.0', NULL, '{}', 1, 5, 0, 'spawn_error', ?1)",
            params![now],
        )
        .unwrap();
        let fx = supervise_tick(&mut db, &tracker, |op| {
            op();
            Ok(())
        })
            .unwrap()
            .expect("exhausted budget should emit event");
        assert_eq!(fx.events[0].kind, "piHostRestartExhausted");
        let auto_restart: i64 = db
            .query_row(
                "SELECT auto_restart FROM core_pi_host_launch_specs WHERE storage_root = '/tmp/loop'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(auto_restart, 0);
    }
}
