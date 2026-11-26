//! Step 8: Rust Core Pi Node Host Supervisor & Generation Lease Fencing (`RC-20`..`RC-22`).
//!
//! Launches, registers, heartbeats, fences, and stops the isolated `pi-node-host` OS process
//! under Rust Core so Electron Main can exit or crash without interrupting active non-desktop
//! Pi execution, while fenced/stale Pi Host generations are rejected at Core commit boundaries.

use crate::business_protocol::{
    ClientContext, EmittedEvent, WriteSideEffects, append_event, current_core_generation,
    ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::now_ms;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static HOST_GEN_SEQ: AtomicU64 = AtomicU64::new(1);

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
    },
    Register {
        host_id: String,
        pid: i64,
        host_generation: String,
        storage_root: String,
        db_path: Option<String>,
        pi_version: String,
        expected_pi_version: String,
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

pub fn ensure_pi_host_tables(db: &Connection) -> crate::Result<()> {
    let core_gen = current_core_generation();
    ensure_protocol_tables(db, &core_gen)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS core_pi_hosts (
            host_id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            core_generation TEXT NOT NULL,
            host_generation TEXT NOT NULL,
            storage_root TEXT NOT NULL,
            db_path TEXT NOT NULL,
            pi_version TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            last_heartbeat_ms INTEGER NOT NULL,
            stopped_at_ms INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_core_pi_hosts_status
            ON core_pi_hosts(status, storage_root, last_heartbeat_ms DESC);
        CREATE TABLE IF NOT EXISTS core_pi_host_fences (
            host_generation TEXT PRIMARY KEY,
            reason TEXT,
            fenced_at_ms INTEGER NOT NULL
        );",
    )?;
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
            let alive = (status == "starting" || status == "running") && is_pid_alive(pid);
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
    let hosts_table_exists: Option<i64> = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_pi_hosts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    match command {
        Command::Status => {
            if hosts_table_exists.is_none() {
                return Ok(json!({ "activeHost": null, "hosts": [], "fencedCount": 0 }));
            }
            let hosts = read_all_hosts(db)?;
            let active = hosts
                .iter()
                .find(|h| (h.status == "running" || h.status == "starting") && h.alive)
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
            if hosts_table_exists.is_none() {
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
            let active = (status == "starting" || status == "running") && alive;
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
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    ensure_pi_host_tables(db)?;
    let now = now_ms();
    let core_gen = current_core_generation();
    let mut events: Vec<EmittedEvent> = Vec::new();
    let data = match command {
        Command::Status | Command::VerifyLease { .. } => execute_read(db, command)?,
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
        } => {
            if pi_version != expected_pi_version {
                return Err(format!(
                    "Pi version mismatch: expected {expected_pi_version}, got {pi_version}"
                )
                .into());
            }
            let storage_root_str = storage_root.to_string_lossy().into_owned();
            let db_path_str = db_path.to_string_lossy().into_owned();

            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing: Option<(String, i64, String, String)> = tx
                .query_row(
                    "SELECT host_id, pid, host_generation, status
                     FROM core_pi_hosts
                     WHERE storage_root = ?1 AND status IN ('starting', 'running')
                     ORDER BY started_at_ms DESC LIMIT 1",
                    [&storage_root_str],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;

            if let Some((prev_id, prev_pid, prev_gen, prev_status)) = existing {
                if is_pid_alive(prev_pid) && force_restart != Some(true) {
                    tx.commit()?;
                    return Ok(simple_fx(json!({
                        "launched": false,
                        "alreadyRunning": true,
                        "hostId": prev_id,
                        "pid": prev_pid,
                        "hostGeneration": prev_gen,
                        "status": prev_status,
                    })));
                }
                tx.execute(
                    "INSERT OR IGNORE INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, ?2, ?3)",
                    params![
                        &prev_gen,
                        if force_restart == Some(true) { "force_restart" } else { "dead_reaped" },
                        now
                    ],
                )?;
                tx.execute(
                    "UPDATE core_pi_hosts SET status = ?1, stopped_at_ms = ?2 WHERE host_id = ?3",
                    params![
                        if force_restart == Some(true) { "stopped" } else { "crashed" },
                        now,
                        &prev_id
                    ],
                )?;
                if force_restart == Some(true) {
                    terminate_pid(prev_pid);
                }
            }

            let seq = HOST_GEN_SEQ.fetch_add(1, Ordering::Relaxed);
            let next_host_id = host_id.unwrap_or_else(|| format!("pi-host-{now}-{seq}"));
            let next_gen = format!("pi-gen-{now}-{seq}");
            let pid = spawn_detached_pi_host(
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
            )?;
            tx.execute(
                "INSERT INTO core_pi_hosts (
                    host_id, pid, core_generation, host_generation, storage_root, db_path, pi_version,
                    status, started_at_ms, last_heartbeat_ms, stopped_at_ms, last_error
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'starting', ?8, ?8, NULL, NULL)",
                params![
                    &next_host_id,
                    pid as i64,
                    &core_gen,
                    &next_gen,
                    &storage_root_str,
                    &db_path_str,
                    &pi_version,
                    now
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
            events.push(ev);
            tx.commit()?;
            json!({
                "launched": true,
                "alreadyRunning": false,
                "hostId": next_host_id,
                "pid": pid,
                "hostGeneration": next_gen,
                "status": "starting",
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
        } => {
            if pi_version != expected_pi_version {
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": format!("Pi version mismatch: expected {expected_pi_version}, got {pi_version}"),
                })));
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if is_generation_fenced(&tx, &host_generation) {
                tx.commit()?;
                return Ok(simple_fx(json!({
                    "accepted": false,
                    "fenced": true,
                    "reason": "stale_host_generation",
                })));
            }
            let conflicting: Option<(String, i64, String)> = tx
                .query_row(
                    "SELECT host_id, pid, host_generation FROM core_pi_hosts
                     WHERE storage_root = ?1 AND status = 'running' AND host_generation != ?2
                     ORDER BY started_at_ms DESC LIMIT 1",
                    params![&storage_root, &host_generation],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((active_id, active_pid, active_gen)) = conflicting {
                if active_pid != pid && is_pid_alive(active_pid) {
                    tx.execute(
                        "INSERT OR IGNORE INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                         VALUES (?1, 'superseded_by_live_host', ?2)",
                        params![&host_generation, now],
                    )?;
                    tx.commit()?;
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
                    "INSERT OR IGNORE INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, 'dead_owner_superseded', ?2)",
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
                }),
            )?;
            events.push(ev);
            tx.commit()?;
            let _ = client;
            json!({
                "accepted": true,
                "fenced": false,
                "hostId": host_id,
                "pid": pid,
                "hostGeneration": host_generation,
            })
        }
        Command::Heartbeat {
            host_id,
            pid,
            host_generation,
        } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if is_generation_fenced(&tx, &host_generation) {
                tx.commit()?;
                return Ok(simple_fx(json!({ "accepted": false, "fenced": true, "reason": "generation_fenced" })));
            }
            let updated = tx.execute(
                "UPDATE core_pi_hosts
                 SET last_heartbeat_ms = ?1
                 WHERE host_id = ?2 AND host_generation = ?3 AND pid = ?4 AND status IN ('starting', 'running')",
                params![now, &host_id, &host_generation, pid],
            )?;
            tx.commit()?;
            if updated == 0 {
                json!({ "accepted": false, "fenced": true, "reason": "not_active_owner" })
            } else {
                json!({ "accepted": true, "fenced": false, "heartbeatAt": now })
            }
        }
        Command::Stop { host_id, reason } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let targets: Vec<(String, i64, String)> = if let Some(ref hid) = host_id {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation FROM core_pi_hosts WHERE host_id = ?1 AND status IN ('starting', 'running')",
                )?;
                stmt.query_map([hid], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                let mut stmt = tx.prepare(
                    "SELECT host_id, pid, host_generation FROM core_pi_hosts WHERE status IN ('starting', 'running')",
                )?;
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let reason_str = reason.unwrap_or_else(|| "explicit_stop".into());
            for (hid, _pid, hgen) in &targets {
                tx.execute(
                    "INSERT OR IGNORE INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                     VALUES (?1, ?2, ?3)",
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
            tx.commit()?;
            for (_hid, pid, _hgen) in &targets {
                terminate_pid(*pid);
            }
            json!({ "stopped": targets.len(), "reason": reason_str })
        }
        Command::FenceGeneration {
            host_generation,
            reason,
        } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let reason_str = reason.unwrap_or_else(|| "manual_fence".into());
            tx.execute(
                "INSERT OR IGNORE INTO core_pi_host_fences (host_generation, reason, fenced_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![&host_generation, &reason_str, now],
            )?;
            tx.execute(
                "UPDATE core_pi_hosts SET status = 'fenced', stopped_at_ms = ?1, last_error = ?2
                 WHERE host_generation = ?3 AND status IN ('starting', 'running')",
                params![now, &reason_str, &host_generation],
            )?;
            tx.commit()?;
            json!({ "fenced": true, "hostGeneration": host_generation })
        }
    };
    Ok(WriteSideEffects {
        data,
        events,
        dispatches: Vec::new(),
        shutdown_after_reply: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn pi_host_registration_fences_stale_generation_and_preserves_version_pin() {
        let mut db = Connection::open_in_memory().unwrap();
        ensure_pi_host_tables(&db).unwrap();
        let ctx = ClientContext::synthetic(&current_core_generation());
        let my_pid = std::process::id() as i64;

        let bad_ver = execute_write(
            &mut db,
            &ctx,
            Command::Register {
                host_id: "h-old".into(),
                pid: my_pid,
                host_generation: "gen-old".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "0.99.2".into(),
                expected_pi_version: "1.5.0".into(),
            },
        )
        .unwrap();
        assert_eq!(bad_ver.data["accepted"], false);
        assert_eq!(bad_ver.data["fenced"], true);

        let reg1 = execute_write(
            &mut db,
            &ctx,
            Command::Register {
                host_id: "h1".into(),
                pid: my_pid,
                host_generation: "gen-1".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
            },
        )
        .unwrap();
        assert_eq!(reg1.data["accepted"], true);

        let hb1 = execute_write(
            &mut db,
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
            &ctx,
            Command::FenceGeneration {
                host_generation: "gen-1".into(),
                reason: Some("crash_recovery_takeover".into()),
            },
        )
        .unwrap();

        let hb_stale = execute_write(
            &mut db,
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
            &ctx,
            Command::Register {
                host_id: "h2".into(),
                pid: my_pid,
                host_generation: "gen-2".into(),
                storage_root: "/tmp/store".into(),
                db_path: None,
                pi_version: "1.5.0".into(),
                expected_pi_version: "1.5.0".into(),
            },
        )
        .unwrap();
        assert_eq!(reg2.data["accepted"], true);
    }
}
