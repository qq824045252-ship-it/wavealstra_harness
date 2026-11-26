//! Step 4 (`P1-07`): Rust Core authoritative background maintenance scheduler.
//!
//! Owns background library maintenance (`library_maintenance`), project time-boundary
//! cadence (`project_cadence`), 6-hour expired trash purge (`trash_purge`), and periodic
//! snapshot compaction (`snapshot_compaction`) so closing Electron Main UI never loses
//! non-UI background maintenance.

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, dispatch_waiting_executions, ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::{now_ms, sha256_hex};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

const DEFAULT_LIBRARY_POLL_MS: i64 = 1_800_000; // 30 minutes
const DEFAULT_CADENCE_POLL_MS: i64 = 60_000; // 1 minute
const DEFAULT_TRASH_POLL_MS: i64 = 21_600_000; // 6 hours
const DEFAULT_SNAPSHOT_POLL_MS: i64 = 21_600_000; // 6 hours
const STALE_INFLIGHT_MS: i64 = 180_000;
const TRASH_DUE_COOLDOWN_MS: i64 = 5_000;
const NEAR_DUE_WINDOW_MS: i64 = 3 * 24 * 3_600 * 1_000;
const STALE_TASK_WINDOW_MS: i64 = 7 * 24 * 3_600 * 1_000;

static MAINT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMaintenanceConfig {
    #[serde(default)]
    pub started: bool,
    #[serde(default = "default_library_ms")]
    pub library_poll_ms: i64,
    #[serde(default = "default_cadence_ms")]
    pub cadence_poll_ms: i64,
    #[serde(default = "default_trash_ms")]
    pub trash_poll_ms: i64,
    #[serde(default = "default_snapshot_ms")]
    pub snapshot_poll_ms: i64,
    #[serde(default)]
    pub last_tick_at_ms: Option<i64>,
}

fn default_library_ms() -> i64 {
    DEFAULT_LIBRARY_POLL_MS
}
fn default_cadence_ms() -> i64 {
    DEFAULT_CADENCE_POLL_MS
}
fn default_trash_ms() -> i64 {
    DEFAULT_TRASH_POLL_MS
}
fn default_snapshot_ms() -> i64 {
    DEFAULT_SNAPSHOT_POLL_MS
}

impl Default for RuntimeMaintenanceConfig {
    fn default() -> Self {
        Self {
            started: false,
            library_poll_ms: DEFAULT_LIBRARY_POLL_MS,
            cadence_poll_ms: DEFAULT_CADENCE_POLL_MS,
            trash_poll_ms: DEFAULT_TRASH_POLL_MS,
            snapshot_poll_ms: DEFAULT_SNAPSHOT_POLL_MS,
            last_tick_at_ms: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status,
    Start {
        library_poll_ms: Option<i64>,
        cadence_poll_ms: Option<i64>,
        trash_poll_ms: Option<i64>,
        snapshot_poll_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    Stop,
    Tick {
        now_ms: Option<i64>,
    },
    TriggerCycle {
        cycle_key: String,
        now_ms: Option<i64>,
        trigger: Option<String>,
    },
    CompleteCycle {
        cycle_key: String,
        next_due_at_ms: Option<i64>,
        now_ms: Option<i64>,
    },
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Command::Status)
    }
}

pub fn ensure_maintenance_scheduler_tables(db: &Connection) -> crate::Result<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS core_maintenance_config (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_maintenance_cycles (
            cycle_key TEXT PRIMARY KEY,
            next_due_at_ms INTEGER,
            last_dispatched_at_ms INTEGER,
            last_completed_at_ms INTEGER,
            in_flight INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at_ms INTEGER NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn table_exists(db: &Connection, name: &str) -> crate::Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_config(db: &Connection) -> crate::Result<RuntimeMaintenanceConfig> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM core_maintenance_config WHERE key = 'runtime'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save_config(tx: &Connection, cfg: &RuntimeMaintenanceConfig) -> crate::Result<()> {
    tx.execute(
        "INSERT INTO core_maintenance_config (key, value_json) VALUES ('runtime', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [serde_json::to_string(cfg)?],
    )?;
    Ok(())
}

fn ensure_cycle_row(
    tx: &Connection,
    cycle_key: &str,
    default_due_ms: i64,
    now: i64,
) -> crate::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO core_maintenance_cycles (
            cycle_key, next_due_at_ms, last_dispatched_at_ms, last_completed_at_ms, in_flight, last_error, updated_at_ms
         ) VALUES (?1, ?2, NULL, NULL, 0, NULL, ?3)",
        params![cycle_key, default_due_ms, now],
    )?;
    Ok(())
}

fn seed_cycles(tx: &Connection, now: i64) -> crate::Result<()> {
    ensure_cycle_row(tx, "library_maintenance", now, now)?;
    ensure_cycle_row(tx, "project_cadence", now, now)?;
    ensure_cycle_row(tx, "trash_purge", now, now)?;
    ensure_cycle_row(tx, "snapshot_compaction", now + 2_000, now)?;
    Ok(())
}

fn interval_for_cycle(cfg: &RuntimeMaintenanceConfig, cycle_key: &str) -> i64 {
    match cycle_key {
        "library_maintenance" => cfg.library_poll_ms.clamp(250, 86_400_000),
        "project_cadence" => cfg.cadence_poll_ms.clamp(250, 86_400_000),
        "trash_purge" => cfg.trash_poll_ms.clamp(250, 86_400_000),
        "snapshot_compaction" => cfg.snapshot_poll_ms.clamp(250, 86_400_000),
        _ => 60_000,
    }
}

fn cycle_info(tx: &Connection, cycle_key: &str) -> crate::Result<(Option<i64>, Option<i64>, Option<i64>, i64)> {
    Ok(tx
        .query_row(
            "SELECT next_due_at_ms, last_dispatched_at_ms, last_completed_at_ms, in_flight
             FROM core_maintenance_cycles WHERE cycle_key = ?1",
            [cycle_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .unwrap_or((None, None, None, 0)))
}

fn has_due_trashed_tasks(tx: &Connection, now: i64) -> crate::Result<bool> {
    if !table_exists(tx, "task_execution_workspace_state")? {
        return Ok(false);
    }
    let found: i64 = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM task_execution_workspace_state
            WHERE state = 'trashed' AND purge_after IS NOT NULL AND purge_after <= ?1
         )",
        [now],
        |r| r.get(0),
    )?;
    Ok(found != 0)
}

fn find_due_cadence_projects(
    tx: &Connection,
    now: i64,
    last_completed: Option<i64>,
) -> crate::Result<Vec<String>> {
    let prev = last_completed.unwrap_or(0);
    let mut projects = BTreeSet::new();

    if table_exists(tx, "project_todos")? {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT project_id FROM project_todos
             WHERE status != 'done' AND due_at IS NOT NULL
               AND ((due_at <= ?1 AND due_at > ?2)
                 OR (due_at - ?3 <= ?1 AND due_at - ?3 > ?2))",
        )?;
        let rows = stmt.query_map(params![now, prev, NEAR_DUE_WINDOW_MS], |r| r.get::<_, String>(0))?;
        for row in rows {
            projects.insert(row?);
        }
    }

    if table_exists(tx, "tasks")? {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT project_id FROM tasks
             WHERE project_id IS NOT NULL AND archived = 0
               AND COALESCE(status, '') NOT IN ('completed', 'failed')
               AND (updated_at + ?3 <= ?1 AND updated_at + ?3 > ?2)",
        )?;
        let rows = stmt.query_map(params![now, prev, STALE_TASK_WINDOW_MS], |r| r.get::<_, String>(0))?;
        for row in rows {
            projects.insert(row?);
        }
    }

    Ok(projects.into_iter().collect())
}

#[allow(clippy::too_many_arguments)]
fn dispatch_cycle_execution(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    cycle_key: &str,
    interval_ms: i64,
    now: i64,
    trigger: &str,
    force: bool,
    extra_payload: Option<Value>,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<bool> {
    if tx
        .query_row(
            "SELECT 1 FROM core_maintenance_cycles WHERE cycle_key = ?1",
            [cycle_key],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        ensure_cycle_row(tx, cycle_key, now, now)?;
    }

    let (due_opt, last_disp, last_comp, in_flight) = cycle_info(tx, cycle_key)?;
    if in_flight != 0 {
        let stale = last_disp.is_some_and(|d| now - d > STALE_INFLIGHT_MS);
        let active_exec_exists: i64 = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM core_execution_runs
                WHERE kind = 'maintenance_control'
                  AND json_extract(payload_json, '$.cycle') = ?1
                  AND status IN ('queued', 'waiting_executor', 'dispatching', 'running', 'pause_requested', 'cancel_requested')
            )",
            [cycle_key],
            |r| r.get(0),
        )?;
        if active_exec_exists != 0 && !force {
            return Ok(false);
        }
        if !stale && !force && active_exec_exists != 0 {
            return Ok(false);
        }
    }

    if !force && due_opt.is_none_or(|due| now < due) {
        return Ok(false);
    }

    let next_due = now + interval_ms.max(250);
    tx.execute(
        "UPDATE core_maintenance_cycles
         SET next_due_at_ms = ?1, last_dispatched_at_ms = ?2, in_flight = 1, updated_at_ms = ?2
         WHERE cycle_key = ?3",
        params![next_due, now, cycle_key],
    )?;

    let seq = MAINT_SEQ.fetch_add(1, Ordering::AcqRel);
    let exec_id = format!(
        "maint-ctrl-{}-{}-{now}-{seq}",
        cycle_key,
        &sha256_hex(&format!("{cycle_key}:{now}:{seq}"))[..8]
    );
    let idemp_key = format!("maint-ctrl:{cycle_key}:{now}:{seq}");
    let effective_trigger = if last_comp.is_none() && trigger == "scheduled" {
        "startup"
    } else {
        trigger
    };
    let mut payload = json!({
        "resourceKey": format!("maintenance-cycle:{cycle_key}"),
        "maintenanceCycle": cycle_key,
        "cycle": cycle_key,
        "trigger": effective_trigger,
        "priority": "background",
        "scheduledAtMs": now,
    });
    if let (Some(obj), Some(Value::Object(extra))) = (payload.as_object_mut(), extra_payload) {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }

    tx.execute(
        "INSERT INTO core_execution_runs (
            execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
            task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, 'service', 'core-maintenance', 0, ?4, 'maintenance_control', ?5, 'waiting_executor', 1, 0, ?6, ?6)
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            exec_id,
            idemp_key,
            core_gen,
            format!("maintenance:{cycle_key}"),
            serde_json::to_string(&payload)?,
            now,
        ],
    )?;
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "maintenance",
        "maintenance.controlDispatch",
        cycle_key,
        now,
        None,
        &json!({
            "cycleKey": cycle_key,
            "executionId": exec_id,
            "trigger": effective_trigger,
            "scheduledAtMs": now,
            "nextDueAtMs": next_due
        }),
    )?);
    Ok(true)
}

fn tick_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Value> {
    let mut cfg = load_config(tx)?;
    seed_cycles(tx, now)?;
    let mut dispatched = Vec::new();

    if dispatch_cycle_execution(
        tx,
        core_gen,
        client_gen,
        "library_maintenance",
        cfg.library_poll_ms,
        now,
        "scheduled",
        false,
        None,
        events,
    )? {
        dispatched.push("library_maintenance");
    }

    let (_, cadence_last_disp, cadence_last_comp, _) = cycle_info(tx, "project_cadence")?;
    let due_projects = find_due_cadence_projects(tx, now, cadence_last_comp)?;
    let cadence_cooldown_ok = cadence_last_disp.is_none_or(|d| now - d >= 5_000);
    let force_cadence = !due_projects.is_empty() && cadence_cooldown_ok;
    let cadence_extra = if due_projects.is_empty() {
        None
    } else {
        Some(json!({ "projectIds": due_projects }))
    };
    if dispatch_cycle_execution(
        tx,
        core_gen,
        client_gen,
        "project_cadence",
        cfg.cadence_poll_ms,
        now,
        if force_cadence { "boundary" } else { "scheduled" },
        force_cadence,
        cadence_extra,
        events,
    )? {
        dispatched.push("project_cadence");
    }

    let (_, trash_last_disp, _, _) = cycle_info(tx, "trash_purge")?;
    let trash_cooldown_ok = trash_last_disp.is_none_or(|d| now - d >= TRASH_DUE_COOLDOWN_MS);
    let trash_due_early = trash_cooldown_ok && has_due_trashed_tasks(tx, now)?;
    if dispatch_cycle_execution(
        tx,
        core_gen,
        client_gen,
        "trash_purge",
        cfg.trash_poll_ms,
        now,
        if trash_due_early { "expired_rows" } else { "scheduled" },
        trash_due_early,
        None,
        events,
    )? {
        dispatched.push("trash_purge");
    }

    if dispatch_cycle_execution(
        tx,
        core_gen,
        client_gen,
        "snapshot_compaction",
        cfg.snapshot_poll_ms,
        now,
        "scheduled",
        false,
        None,
        events,
    )? {
        dispatched.push("snapshot_compaction");
    }

    cfg.last_tick_at_ms = Some(now);
    save_config(tx, &cfg)?;
    Ok(json!({
        "status": "ok",
        "nowMs": now,
        "dispatched": dispatched,
    }))
}

pub(crate) fn on_core_execution_state_change(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    execution_id: &str,
    exec_status: &str,
    error_message: Option<&str>,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<()> {
    if !execution_id.starts_with("maint-ctrl-")
        || !matches!(
            exec_status,
            "completed" | "failed" | "cancelled" | "paused" | "unknown"
        )
    {
        return Ok(());
    }
    if !table_exists(tx, "core_maintenance_cycles")? {
        return Ok(());
    }
    let payload_raw: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM core_execution_runs WHERE execution_id = ?1",
            [execution_id],
            |r| r.get(0),
        )
        .optional()?;
    let cycle_key = payload_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| {
            v.get("maintenanceCycle")
                .or_else(|| v.get("cycle"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    let Some(key) = cycle_key else {
        return Ok(());
    };
    let cfg = load_config(tx)?;
    let next_due = now + interval_for_cycle(&cfg, &key);
    if exec_status == "completed" {
        tx.execute(
            "UPDATE core_maintenance_cycles
             SET in_flight = 0, last_completed_at_ms = ?1, next_due_at_ms = ?2, last_error = NULL, updated_at_ms = ?1
             WHERE cycle_key = ?3",
            params![now, next_due, key],
        )?;
    } else {
        tx.execute(
            "UPDATE core_maintenance_cycles
             SET in_flight = 0, next_due_at_ms = ?1, last_error = ?2, updated_at_ms = ?3
             WHERE cycle_key = ?4",
            params![next_due, error_message, now, key],
        )?;
    }
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "maintenance",
        "maintenance.controlSettled",
        &key,
        now,
        None,
        &json!({
            "cycleKey": key,
            "executionId": execution_id,
            "status": exec_status,
            "errorMessage": error_message,
            "settledAtMs": now,
        }),
    )?);
    Ok(())
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    if !table_exists(db, "core_maintenance_config")? {
        return Ok(json!({
            "status": "ok",
            "config": RuntimeMaintenanceConfig::default(),
            "cycles": [],
        }));
    }
    match command {
        Command::Status => {
            let cfg = load_config(db)?;
            let mut stmt = db.prepare(
                "SELECT cycle_key, next_due_at_ms, last_dispatched_at_ms, last_completed_at_ms, in_flight, last_error, updated_at_ms
                 FROM core_maintenance_cycles ORDER BY cycle_key",
            )?;
            let cycles: Vec<Value> = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "cycleKey": r.get::<_, String>(0)?,
                        "nextDueAtMs": r.get::<_, Option<i64>>(1)?,
                        "lastDispatchedAtMs": r.get::<_, Option<i64>>(2)?,
                        "lastCompletedAtMs": r.get::<_, Option<i64>>(3)?,
                        "inFlight": r.get::<_, i64>(4)? != 0,
                        "lastError": r.get::<_, Option<String>>(5)?,
                        "updatedAtMs": r.get::<_, i64>(6)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({
                "status": "ok",
                "config": cfg,
                "cycles": cycles,
            }))
        }
        _ => Ok(json!({ "status": "rejected", "code": "NOT_READ_ONLY" })),
    }
}

pub fn execute_write(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_protocol_tables(db, &core_gen)?;
    ensure_maintenance_scheduler_tables(db)?;

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut events = Vec::new();
    let mut dispatches = Vec::new();

    let data = match command {
        Command::Start {
            library_poll_ms,
            cadence_poll_ms,
            trash_poll_ms,
            snapshot_poll_ms,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let mut cfg = load_config(&tx)?;
            cfg.started = true;
            if let Some(v) = library_poll_ms {
                cfg.library_poll_ms = v.clamp(250, 86_400_000);
            }
            if let Some(v) = cadence_poll_ms {
                cfg.cadence_poll_ms = v.clamp(250, 86_400_000);
            }
            if let Some(v) = trash_poll_ms {
                cfg.trash_poll_ms = v.clamp(250, 86_400_000);
            }
            if let Some(v) = snapshot_poll_ms {
                cfg.snapshot_poll_ms = v.clamp(250, 86_400_000);
            }
            save_config(&tx, &cfg)?;
            seed_cycles(&tx, now)?;
            let tick = tick_tx(&tx, &core_gen, &client.generation, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "started": true, "tick": tick, "config": cfg })
        }
        Command::Stop => {
            let now = now_ms();
            let mut cfg = load_config(&tx)?;
            cfg.started = false;
            save_config(&tx, &cfg)?;
            tx.execute(
                "UPDATE core_maintenance_cycles SET in_flight = 0, updated_at_ms = ?1",
                [now],
            )?;
            tx.execute(
                "UPDATE core_execution_runs SET status = 'cancelled', updated_at_ms = ?1
                 WHERE kind = 'maintenance_control' AND status IN ('queued', 'waiting_executor')",
                [now],
            )?;
            json!({ "status": "ok", "stopped": true })
        }
        Command::Tick { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let res = tick_tx(&tx, &core_gen, &client.generation, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            res
        }
        Command::TriggerCycle {
            cycle_key,
            now_ms: at,
            trigger,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let cfg = load_config(&tx)?;
            let interval = interval_for_cycle(&cfg, &cycle_key);
            let trig = trigger.as_deref().unwrap_or("manual");
            let triggered = dispatch_cycle_execution(
                &tx,
                &core_gen,
                &client.generation,
                &cycle_key,
                interval,
                now,
                trig,
                true,
                None,
                &mut events,
            )?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "cycleKey": cycle_key, "triggered": triggered })
        }
        Command::CompleteCycle {
            cycle_key,
            next_due_at_ms,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            tx.execute(
                "UPDATE core_maintenance_cycles
                 SET in_flight = 0, last_completed_at_ms = ?1,
                     next_due_at_ms = COALESCE(?2, next_due_at_ms), last_error = NULL, updated_at_ms = ?1
                 WHERE cycle_key = ?3",
                params![now, next_due_at_ms, cycle_key],
            )?;
            json!({ "status": "ok", "cycleKey": cycle_key })
        }
        Command::Status => json!({ "status": "rejected", "code": "READ_ONLY" }),
    };

    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data,
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

pub fn run_supervised_tick(
    db: &mut Connection,
    tracker: &ExecutorTracker,
) -> crate::Result<Option<WriteSideEffects>> {
    if !table_exists(db, "core_maintenance_config")? {
        return Ok(None);
    }
    let cfg = load_config(db)?;
    if !cfg.started {
        return Ok(None);
    }
    let core_gen = current_core_generation();
    let ctx = ClientContext::synthetic(&core_gen);
    let fx = execute_write(db, tracker, &ctx, Command::Tick { now_ms: None })?;
    if fx.events.is_empty() && fx.dispatches.is_empty() {
        Ok(None)
    } else {
        Ok(Some(fx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_schema::CANONICAL_SCHEMA_SQL;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(CANONICAL_SCHEMA_SQL).expect("schema");
        let core_gen = current_core_generation();
        ensure_protocol_tables(&conn, &core_gen).expect("protocol tables");
        ensure_maintenance_scheduler_tables(&conn).expect("maintenance tables");
        conn
    }

    #[test]
    fn start_tick_dispatches_and_failure_preserves_last_completed() {
        let mut conn = setup_db();
        let tracker = ExecutorTracker::new();
        let ctx = ClientContext::synthetic(&current_core_generation());
        let t0 = 1_700_000_000_000i64;

        let started = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Start {
                library_poll_ms: None,
                cadence_poll_ms: None,
                trash_poll_ms: None,
                snapshot_poll_ms: None,
                now_ms: Some(t0),
            },
        )
        .unwrap();
        let dispatched = started.data["tick"]["dispatched"].as_array().unwrap();
        assert!(dispatched.iter().any(|v| v == "library_maintenance"));
        assert!(dispatched.iter().any(|v| v == "trash_purge"));

        let exec_id: String = conn
            .query_row(
                "SELECT execution_id FROM core_execution_runs WHERE kind = 'maintenance_control' AND json_extract(payload_json, '$.cycle') = 'library_maintenance' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        {
            let mut events = Vec::new();
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            on_core_execution_state_change(
                &tx,
                &ctx.generation,
                &ctx.generation,
                &exec_id,
                "failed",
                Some("boom"),
                t0 + 1_000,
                &mut events,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let (in_flight, last_completed, last_error): (i64, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT in_flight, last_completed_at_ms, last_error FROM core_maintenance_cycles WHERE cycle_key = 'library_maintenance'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(in_flight, 0);
        assert_eq!(last_completed, None);
        assert_eq!(last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn expired_trash_triggers_purge_before_six_hour_interval() {
        let mut conn = setup_db();
        let tracker = ExecutorTracker::new();
        let ctx = ClientContext::synthetic(&current_core_generation());
        let t0 = 1_700_000_000_000i64;

        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Start {
                library_poll_ms: None,
                cadence_poll_ms: None,
                trash_poll_ms: Some(21_600_000),
                snapshot_poll_ms: None,
                now_ms: Some(t0),
            },
        )
        .unwrap();

        let first_trash_id: String = conn
            .query_row(
                "SELECT execution_id FROM core_execution_runs WHERE kind = 'maintenance_control' AND json_extract(payload_json, '$.cycle') = 'trash_purge' ORDER BY created_at_ms DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        {
            let mut events = Vec::new();
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            on_core_execution_state_change(
                &tx,
                &ctx.generation,
                &ctx.generation,
                &first_trash_id,
                "completed",
                None,
                t0 + 500,
                &mut events,
            )
            .unwrap();
            tx.commit().unwrap();
        }

        // Seed an expired trashed row before the 6h interval elapses.
        conn.execute(
            "INSERT INTO task_execution_workspace_state (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
             VALUES ('t-expired', 't-expired', 'trashed', ?1, ?1, ?1, ?2, '/tmp/t-expired')",
            params![t0, t0 + 10_000],
        )
        .unwrap();

        let res = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(t0 + 15_000),
            },
        )
        .unwrap();
        assert!(res.data["dispatched"].as_array().unwrap().iter().any(|v| v == "trash_purge"));
    }
}
