//! Step 6.2: Rust Core authoritative Dots control loops (Google/Discovery/ProactiveDelivery/
//! FileWatches/Delegations observation & dependency deadlines), sleep/jump coalescing,
//! causal deduplication, and Core execution-bridge coordination.

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, dispatch_waiting_executions, ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::{now_ms, sha256_hex};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEFAULT_GOOGLE_POLL_MS: i64 = 15_000;
const DEFAULT_DISCOVERY_POLL_MS: i64 = 15_000;
const DEFAULT_PROACTIVE_POLL_MS: i64 = 5_000;
const DEFAULT_FILE_WATCH_POLL_MS: i64 = 30_000;
const STALE_INFLIGHT_MS: i64 = 120_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDotsConfig {
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "default_google_ms")]
    pub google_poll_ms: i64,
    #[serde(default = "default_discovery_ms")]
    pub discovery_poll_ms: i64,
    #[serde(default = "default_proactive_ms")]
    pub proactive_poll_ms: i64,
    #[serde(default = "default_file_watch_ms")]
    pub file_watch_poll_ms: i64,
    #[serde(default)]
    pub last_tick_at_ms: Option<i64>,
}

fn default_google_ms() -> i64 {
    DEFAULT_GOOGLE_POLL_MS
}
fn default_discovery_ms() -> i64 {
    DEFAULT_DISCOVERY_POLL_MS
}
fn default_proactive_ms() -> i64 {
    DEFAULT_PROACTIVE_POLL_MS
}
fn default_file_watch_ms() -> i64 {
    DEFAULT_FILE_WATCH_POLL_MS
}

impl Default for RuntimeDotsConfig {
    fn default() -> Self {
        Self {
            started: false,
            paused: false,
            google_poll_ms: DEFAULT_GOOGLE_POLL_MS,
            discovery_poll_ms: DEFAULT_DISCOVERY_POLL_MS,
            proactive_poll_ms: DEFAULT_PROACTIVE_POLL_MS,
            file_watch_poll_ms: DEFAULT_FILE_WATCH_POLL_MS,
            last_tick_at_ms: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status,
    SyncState {
        paused: Option<bool>,
        started: Option<bool>,
        google_poll_ms: Option<i64>,
        discovery_poll_ms: Option<i64>,
        proactive_poll_ms: Option<i64>,
        file_watch_poll_ms: Option<i64>,
    },
    Start {
        paused: Option<bool>,
        now_ms: Option<i64>,
    },
    Stop,
    Tick {
        now_ms: Option<i64>,
        simulate_sleep_jump: Option<bool>,
    },
    TriggerCycle {
        cycle_key: String,
        now_ms: Option<i64>,
    },
    CompleteCycle {
        cycle_key: String,
        next_due_at_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    RecordCausalEvent {
        dedup_key: String,
        kind: String,
        source_id: String,
        detail: Option<Value>,
        now_ms: Option<i64>,
    },
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Command::Status)
    }
}

pub fn ensure_dots_scheduler_tables(db: &Connection) -> crate::Result<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS core_dots_control_config (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_dots_control_cycles (
            cycle_key TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            next_due_at_ms INTEGER,
            last_dispatched_at_ms INTEGER,
            last_completed_at_ms INTEGER,
            in_flight INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_dots_causal_dedup (
            dedup_key TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            detail_json TEXT,
            recorded_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_core_dots_causal_time
            ON core_dots_causal_dedup(recorded_at_ms);
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

fn load_config(db: &Connection) -> crate::Result<RuntimeDotsConfig> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM core_dots_control_config WHERE key = 'runtime'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save_config(tx: &Connection, cfg: &RuntimeDotsConfig) -> crate::Result<()> {
    tx.execute(
        "INSERT INTO core_dots_control_config (key, value_json) VALUES ('runtime', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [serde_json::to_string(cfg)?],
    )?;
    Ok(())
}

fn ensure_cycle_row(
    tx: &Connection,
    cycle_key: &str,
    kind: &str,
    default_due_ms: i64,
    now: i64,
) -> crate::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO core_dots_control_cycles (
            cycle_key, kind, next_due_at_ms, last_dispatched_at_ms, last_completed_at_ms, in_flight, updated_at_ms
         ) VALUES (?1, ?2, ?3, NULL, NULL, 0, ?4)",
        params![cycle_key, kind, default_due_ms, now],
    )?;
    Ok(())
}

fn seed_cycles(tx: &Connection, now: i64) -> crate::Result<()> {
    ensure_cycle_row(tx, "google", "google", now, now)?;
    ensure_cycle_row(tx, "discovery", "discovery", now, now)?;
    ensure_cycle_row(tx, "proactive_delivery", "proactive_delivery", now, now)?;
    ensure_cycle_row(tx, "file_watch", "file_watch", now, now)?;
    ensure_cycle_row(tx, "delegation_recover", "delegation_recover", now, now)?;
    Ok(())
}

fn dispatch_cycle_execution(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    cycle_key: &str,
    interval_ms: i64,
    now: i64,
    force: bool,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<bool> {
    let row: Option<(Option<i64>, Option<i64>, i64)> = tx
        .query_row(
            "SELECT next_due_at_ms, last_dispatched_at_ms, in_flight
             FROM core_dots_control_cycles WHERE cycle_key = ?1",
            [cycle_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (due_opt, last_disp, in_flight) = match row {
        Some(r) => r,
        None => {
            ensure_cycle_row(tx, cycle_key, cycle_key, now, now)?;
            (Some(now), None, 0)
        }
    };
    if in_flight != 0 {
        let stale = last_disp.is_some_and(|d| now - d > STALE_INFLIGHT_MS);
        if !stale && !force {
            return Ok(false);
        }
    }
    if !force && due_opt.is_none_or(|due| now < due) {
        return Ok(false);
    }

    let next_due = now + interval_ms.max(250);
    tx.execute(
        "UPDATE core_dots_control_cycles
         SET next_due_at_ms = ?1, last_dispatched_at_ms = ?2, in_flight = 1, updated_at_ms = ?2
         WHERE cycle_key = ?3",
        params![next_due, now, cycle_key],
    )?;

    let exec_id = format!(
        "dots-ctrl-{}-{}-{now}",
        cycle_key,
        &sha256_hex(&format!("{cycle_key}:{now}"))[..8]
    );
    let idemp_key = format!("dots-ctrl:{cycle_key}:{now}");
    let payload = json!({
        "resourceKey": format!("dots-cycle:{cycle_key}"),
        "dotsControlCycle": cycle_key,
        "scheduledAtMs": now,
    });
    tx.execute(
        "INSERT INTO core_execution_runs (
            execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
            task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, 'service', 'core-dots', 0, ?4, 'dots_control', ?5, 'waiting_executor', 1, 0, ?6, ?6)
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            exec_id,
            idemp_key,
            core_gen,
            "dots-internal",
            serde_json::to_string(&payload)?,
            now,
        ],
    )?;
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "dots",
        "dots.controlDispatch",
        cycle_key,
        now,
        None,
        &json!({ "cycleKey": cycle_key, "executionId": exec_id, "scheduledAtMs": now, "nextDueAtMs": next_due }),
    )?);
    Ok(true)
}

fn check_due_observations(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<usize> {
    if !table_exists(tx, "dots_tool_observations")? || !table_exists(tx, "dots_delegations")? {
        return Ok(0);
    }
    let mut stmt = tx.prepare(
        "SELECT o.operation_id, d.task_id, d.status, o.at, o.tool, o.phase, o.next_at
         FROM dots_tool_observations o
         JOIN dots_delegations d USING(operation_id)
         WHERE o.next_at IS NOT NULL AND o.next_at <= ?1",
    )?;
    let due: Vec<(String, String, String, i64, String, String, i64)> = stmt
        .query_map([now], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let count = due.len();
    for (op_id, task_id, status, at, tool, phase, due_at) in due {
        let dedup_key = format!("dots:obs:{op_id}:{due_at}");
        let claimed = tx.execute(
            "INSERT OR IGNORE INTO core_dots_causal_dedup (dedup_key, kind, source_id, detail_json, recorded_at_ms)
             VALUES (?1, 'observation', ?2, NULL, ?3)",
            params![dedup_key, op_id, now],
        )?;
        if claimed == 0 {
            continue;
        }
        if status == "running" || status == "pending" {
            // Advance heartbeat cleanly by 15s (or clear when Host/DotsDelegations updates).
            tx.execute(
                "UPDATE dots_tool_observations SET next_at = ?1 WHERE operation_id = ?2 AND next_at = ?3",
                params![now + 15_000, op_id, due_at],
            )?;
            events.push(append_event(
                tx,
                core_gen,
                client_gen,
                "dots",
                "dots.observationDue",
                &op_id,
                now,
                None,
                &json!({
                    "operationId": op_id,
                    "taskId": task_id,
                    "status": status,
                    "tool": tool,
                    "phase": phase,
                    "at": at,
                    "dueAt": due_at,
                }),
            )?);
        } else {
            tx.execute(
                "UPDATE dots_tool_observations SET next_at = NULL WHERE operation_id = ?1",
                [&op_id],
            )?;
        }
    }
    Ok(count)
}

fn check_due_dependencies(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<usize> {
    if !table_exists(tx, "dots_dependency_waits")? || !table_exists(tx, "dots_delegations")? {
        return Ok(0);
    }
    let mut stmt = tx.prepare(
        "SELECT w.operation_id, d.task_id, w.deadline_at
         FROM dots_dependency_waits w
         JOIN dots_delegations d ON d.operation_id = w.operation_id AND d.status = 'blocked'
         WHERE w.deadline_at <= ?1",
    )?;
    let due: Vec<(String, String, i64)> = stmt
        .query_map([now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut count = 0usize;
    for (op_id, task_id, deadline_at) in due {
        let dedup_key = format!("dots:dep_deadline:{op_id}:{deadline_at}");
        let claimed = tx.execute(
            "INSERT OR IGNORE INTO core_dots_causal_dedup (dedup_key, kind, source_id, detail_json, recorded_at_ms)
             VALUES (?1, 'dependency_deadline', ?2, NULL, ?3)",
            params![dedup_key, op_id, now],
        )?;
        if claimed == 0 {
            continue;
        }
        count += 1;
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "dots",
            "dots.dependencyDue",
            &op_id,
            now,
            None,
            &json!({ "operationId": op_id, "taskId": task_id, "deadlineAt": deadline_at }),
        )?);
    }
    Ok(count)
}

fn tick_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    simulate_sleep_jump: bool,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Value> {
    let mut cfg = load_config(tx)?;
    let prev_tick = cfg.last_tick_at_ms;
    let clock_jumped_back = prev_tick.is_some_and(|p| now < p - 5_000);
    seed_cycles(tx, now)?;
    if clock_jumped_back {
        // Re-anchor due times cleanly without re-firing past windows.
        tx.execute(
            "UPDATE core_dots_control_cycles SET next_due_at_ms = CASE
                WHEN next_due_at_ms IS NOT NULL AND next_due_at_ms > ?1 THEN ?1 + 1000
                ELSE next_due_at_ms END,
             updated_at_ms = ?1",
            [now],
        )?;
    }

    let mut dispatched = Vec::new();
    let has_pending_delegations = table_exists(tx, "dots_delegations")?
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dots_delegations WHERE status='pending' AND request_json IS NOT NULL)",
            [],
            |r| r.get::<_, i64>(0),
        )? != 0;
    if has_pending_delegations
        && dispatch_cycle_execution(tx, core_gen, client_gen, "delegation_recover", 10_000, now, false, events)?
    {
        dispatched.push("delegation_recover");
    }

    let obs_due = check_due_observations(tx, core_gen, client_gen, now, events)?;
    let dep_due = check_due_dependencies(tx, core_gen, client_gen, now, events)?;

    let has_active_watches = table_exists(tx, "dots_file_watches")?
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dots_file_watches WHERE state IN ('watching', 'sending'))",
            [],
            |r| r.get::<_, i64>(0),
        )? != 0;
    if has_active_watches
        && dispatch_cycle_execution(tx, core_gen, client_gen, "file_watch", cfg.file_watch_poll_ms, now, false, events)?
    {
        dispatched.push("file_watch");
    }

    if !cfg.paused {
        let has_proactive = table_exists(tx, "dots_proactive_delivery")?
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_proactive_delivery WHERE message_id IS NULL OR (workspace IS NOT NULL AND archived_at IS NULL AND coalesce(archive_retry_at, 0) <= ?1))",
                [now],
                |r| r.get::<_, i64>(0),
            )? != 0;
        if has_proactive
            && dispatch_cycle_execution(tx, core_gen, client_gen, "proactive_delivery", cfg.proactive_poll_ms, now, false, events)?
        {
            dispatched.push("proactive_delivery");
        }
        // Coalesce missed Google/Discovery windows into at most 1 due trigger per cycle even after sleep/jump.
        if dispatch_cycle_execution(tx, core_gen, client_gen, "google", cfg.google_poll_ms, now, simulate_sleep_jump, events)? {
            dispatched.push("google");
        }
        if dispatch_cycle_execution(tx, core_gen, client_gen, "discovery", cfg.discovery_poll_ms, now, simulate_sleep_jump, events)? {
            dispatched.push("discovery");
        }
    }

    cfg.last_tick_at_ms = Some(now);
    save_config(tx, &cfg)?;
    Ok(json!({
        "status": "ok",
        "nowMs": now,
        "clockJumpedBack": clock_jumped_back,
        "dispatched": dispatched,
        "observationsDue": obs_due,
        "dependenciesDue": dep_due,
    }))
}

pub(crate) fn on_core_execution_state_change(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    execution_id: &str,
    exec_status: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<()> {
    if !execution_id.starts_with("dots-ctrl-")
        || !matches!(exec_status, "completed" | "failed" | "cancelled" | "paused" | "unknown")
    {
        return Ok(());
    }
    if !table_exists(tx, "core_dots_control_cycles")? {
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
        .and_then(|v| v.get("dotsControlCycle").and_then(Value::as_str).map(ToOwned::to_owned));
    let Some(key) = cycle_key else {
        return Ok(());
    };
    if exec_status == "completed" {
        tx.execute(
            "UPDATE core_dots_control_cycles
             SET in_flight = 0, last_completed_at_ms = ?1, updated_at_ms = ?1
             WHERE cycle_key = ?2",
            params![now, key],
        )?;
    } else {
        tx.execute(
            "UPDATE core_dots_control_cycles
             SET in_flight = 0, updated_at_ms = ?1
             WHERE cycle_key = ?2",
            params![now, key],
        )?;
    }
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "dots",
        "dots.controlSettled",
        &key,
        now,
        None,
        &json!({ "cycleKey": key, "status": exec_status, "settledAtMs": now }),
    )?);
    Ok(())
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    if !table_exists(db, "core_dots_control_config")? {
        return Ok(json!({ "status": "ok", "config": RuntimeDotsConfig::default(), "cycles": [], "causalCount": 0 }));
    }
    match command {
        Command::Status => {
            let cfg = load_config(db)?;
            let mut stmt = db.prepare(
                "SELECT cycle_key, kind, next_due_at_ms, last_dispatched_at_ms, last_completed_at_ms, in_flight, updated_at_ms
                 FROM core_dots_control_cycles ORDER BY cycle_key",
            )?;
            let cycles: Vec<Value> = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "cycleKey": r.get::<_, String>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "nextDueAtMs": r.get::<_, Option<i64>>(2)?,
                        "lastDispatchedAtMs": r.get::<_, Option<i64>>(3)?,
                        "lastCompletedAtMs": r.get::<_, Option<i64>>(4)?,
                        "inFlight": r.get::<_, i64>(5)? != 0,
                        "updatedAtMs": r.get::<_, i64>(6)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let causal_count: i64 = db.query_row(
                "SELECT COUNT(*) FROM core_dots_causal_dedup",
                [],
                |r| r.get(0),
            )?;
            Ok(json!({
                "status": "ok",
                "config": cfg,
                "cycles": cycles,
                "causalCount": causal_count,
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
    ensure_dots_scheduler_tables(db)?;

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut events = Vec::new();
    let mut dispatches = Vec::new();

    let data = match command {
        Command::SyncState {
            paused,
            started,
            google_poll_ms,
            discovery_poll_ms,
            proactive_poll_ms,
            file_watch_poll_ms,
        } => {
            let mut cfg = load_config(&tx)?;
            if let Some(p) = paused {
                cfg.paused = p;
            }
            if let Some(s) = started {
                cfg.started = s;
            }
            if let Some(v) = google_poll_ms {
                cfg.google_poll_ms = v.clamp(250, 3_600_000);
            }
            if let Some(v) = discovery_poll_ms {
                cfg.discovery_poll_ms = v.clamp(250, 3_600_000);
            }
            if let Some(v) = proactive_poll_ms {
                cfg.proactive_poll_ms = v.clamp(250, 3_600_000);
            }
            if let Some(v) = file_watch_poll_ms {
                cfg.file_watch_poll_ms = v.clamp(250, 3_600_000);
            }
            save_config(&tx, &cfg)?;
            json!({ "status": "ok", "config": cfg })
        }
        Command::Start { paused, now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let mut cfg = load_config(&tx)?;
            cfg.started = true;
            if let Some(p) = paused {
                cfg.paused = p;
            }
            save_config(&tx, &cfg)?;
            seed_cycles(&tx, now)?;
            let summary = tick_tx(&tx, &core_gen, &client.generation, now, false, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "started": true, "tick": summary })
        }
        Command::Stop => {
            let now = now_ms();
            let mut cfg = load_config(&tx)?;
            cfg.started = false;
            save_config(&tx, &cfg)?;
            tx.execute(
                "UPDATE core_dots_control_cycles SET in_flight = 0, updated_at_ms = ?1",
                [now],
            )?;
            tx.execute(
                "UPDATE core_execution_runs SET status = 'cancelled', updated_at_ms = ?1
                 WHERE kind = 'dots_control' AND status IN ('queued', 'waiting_executor')",
                [now],
            )?;
            json!({ "status": "ok", "stopped": true })
        }
        Command::Tick {
            now_ms: at,
            simulate_sleep_jump,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let res = tick_tx(
                &tx,
                &core_gen,
                &client.generation,
                now,
                simulate_sleep_jump.unwrap_or(false),
                &mut events,
            )?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            res
        }
        Command::TriggerCycle {
            cycle_key,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let cfg = load_config(&tx)?;
            let interval = match cycle_key.as_str() {
                "google" => cfg.google_poll_ms,
                "discovery" => cfg.discovery_poll_ms,
                "proactive_delivery" => cfg.proactive_poll_ms,
                "file_watch" => cfg.file_watch_poll_ms,
                _ => 10_000,
            };
            let triggered = dispatch_cycle_execution(
                &tx,
                &core_gen,
                &client.generation,
                &cycle_key,
                interval,
                now,
                true,
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
                "UPDATE core_dots_control_cycles
                 SET in_flight = 0, last_completed_at_ms = ?1,
                     next_due_at_ms = COALESCE(?2, next_due_at_ms), updated_at_ms = ?1
                 WHERE cycle_key = ?3",
                params![now, next_due_at_ms, cycle_key],
            )?;
            json!({ "status": "ok", "cycleKey": cycle_key })
        }
        Command::RecordCausalEvent {
            dedup_key,
            kind,
            source_id,
            detail,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let detail_json = detail.as_ref().map(serde_json::to_string).transpose()?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO core_dots_causal_dedup (dedup_key, kind, source_id, detail_json, recorded_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![dedup_key, kind, source_id, detail_json, now],
            )?;
            let accepted = inserted > 0;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "dots",
                if accepted {
                    "dots.causalAccepted"
                } else {
                    "dots.causalDeduplicated"
                },
                &source_id,
                now,
                None,
                &json!({ "dedupKey": dedup_key, "kind": kind, "sourceId": source_id, "accepted": accepted }),
            )?);
            json!({ "status": "ok", "accepted": accepted, "deduplicated": !accepted })
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
    if !table_exists(db, "core_dots_control_config")? {
        return Ok(None);
    }
    let cfg = load_config(db)?;
    if !cfg.started {
        return Ok(None);
    }
    let core_gen = current_core_generation();
    let ctx = ClientContext::synthetic(&core_gen);
    let fx = execute_write(
        db,
        tracker,
        &ctx,
        Command::Tick {
            now_ms: None,
            simulate_sleep_jump: None,
        },
    )?;
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
        ensure_dots_scheduler_tables(&conn).expect("dots tables");
        conn
    }

    #[test]
    fn dots_causal_dedup_sleep_coalescing_and_no_self_excitation() {
        let mut conn = setup_db();
        let tracker = ExecutorTracker::default();
        let ctx = ClientContext::synthetic("test-gen");
        let t0 = 1_700_000_000_000i64;

        // Causal event deduplication
        let first = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::RecordCausalEvent {
                dedup_key: "file_watch:w1:rev42".into(),
                kind: "file_watch".into(),
                source_id: "w1".into(),
                detail: None,
                now_ms: Some(t0),
            },
        )
        .unwrap();
        assert_eq!(first.data["accepted"], json!(true));
        let dup = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::RecordCausalEvent {
                dedup_key: "file_watch:w1:rev42".into(),
                kind: "file_watch".into(),
                source_id: "w1".into(),
                detail: None,
                now_ms: Some(t0 + 100),
            },
        )
        .unwrap();
        assert_eq!(dup.data["accepted"], json!(false));
        assert_eq!(dup.data["deduplicated"], json!(true));

        // Sleep jump coalescing & in-flight anti-self-excitation
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Start {
                paused: Some(false),
                now_ms: Some(t0),
            },
        )
        .unwrap();
        // While google & discovery are in_flight, ticking across a huge sleep jump must NOT stack dispatches!
        let r2 = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(t0 + 600_000),
                simulate_sleep_jump: Some(true),
            },
        )
        .unwrap();
        // Since STALE_INFLIGHT_MS is 120s and we jumped 600s, at most 1 coalesced dispatch occurs (never 40 intervals).
        let disp_count = r2.data["dispatched"].as_array().unwrap().len();
        assert!(disp_count <= 2);
        let run_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM core_execution_runs WHERE kind = 'dots_control' AND json_extract(payload_json, '$.dotsControlCycle') = 'google'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run_count, 2); // Only initial Start (1) + 1 coalesced after 600s sleep jump, NOT 40!

        // Failed control cycles must clear in_flight without advancing last_completed_at_ms
        let mut settle_events = Vec::new();
        let failed_exec_id: String = conn
            .query_row(
                "SELECT execution_id FROM core_execution_runs WHERE kind = 'dots_control' AND json_extract(payload_json, '$.dotsControlCycle') = 'google' ORDER BY created_at_ms DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            on_core_execution_state_change(
                &tx,
                &ctx.generation,
                &ctx.generation,
                &failed_exec_id,
                "failed",
                t0 + 601_000,
                &mut settle_events,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let (in_flight_after_fail, last_completed_after_fail): (i64, Option<i64>) = conn
            .query_row(
                "SELECT in_flight, last_completed_at_ms FROM core_dots_control_cycles WHERE cycle_key = 'google'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(in_flight_after_fail, 0);
        assert_eq!(last_completed_after_fail, None);
    }
}
