//! Step 6.3: Rust Core authoritative Gateway channel lifecycle, reconnect backoff,
//! duplicate-inbound prevention, and queryable vs non-queryable outbound reconciliation (`RC-15`).

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, dispatch_waiting_executions, ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::{now_ms, sha256_hex};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RECONNECT_BACKOFF_MS: &[i64] = &[1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONCILE_ATTEMPTS: i64 = 12;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGatewayConfig {
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub suspended: bool,
    #[serde(default)]
    pub last_tick_at_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status {
        channel_id: Option<String>,
    },
    Start {
        now_ms: Option<i64>,
    },
    Stop {
        now_ms: Option<i64>,
    },
    ChannelConnected {
        channel_id: String,
        channel_type: String,
        account_key: Option<String>,
        generation: Option<i64>,
        now_ms: Option<i64>,
    },
    ChannelDisconnected {
        channel_id: String,
        channel_type: Option<String>,
        paused: Option<bool>,
        reason: Option<String>,
        retry_after_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    ScheduleRecover {
        channel_id: String,
        delay_ms: i64,
        now_ms: Option<i64>,
    },
    AdmitInbound {
        delivery_id: String,
        platform: String,
        channel_id: String,
        account_key: String,
        session_key: String,
        message_id: String,
        payload_json: String,
        payload_hash: String,
        receipt_mode: Option<String>,
        now_ms: Option<i64>,
    },
    TrackOutbound {
        delivery_id: String,
        channel_id: String,
        channel_type: String,
        account_key: Option<String>,
        provider_message_id: Option<String>,
        queryable: bool,
        state: String,
        detail: Option<String>,
        now_ms: Option<i64>,
    },
    SettleUnknown {
        delivery_id: String,
        outcome: String,
        provider_message_id: Option<String>,
        detail: Option<String>,
        now_ms: Option<i64>,
    },
    Tick {
        now_ms: Option<i64>,
    },
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Command::Status { .. })
    }
}

pub fn ensure_gateway_scheduler_tables(db: &Connection) -> crate::Result<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS core_gateway_config (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_gateway_channels (
            channel_id TEXT PRIMARY KEY,
            channel_type TEXT NOT NULL,
            account_key TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            paused INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1,
            offline_attempts INTEGER NOT NULL DEFAULT 0,
            next_reconnect_at_ms INTEGER,
            next_recover_at_ms INTEGER,
            last_connected_at_ms INTEGER,
            error_message TEXT,
            in_flight INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_gateway_outbound_reconcile (
            delivery_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            channel_type TEXT NOT NULL,
            account_key TEXT,
            provider_message_id TEXT,
            queryable INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL,
            last_checked_at_ms INTEGER,
            check_attempts INTEGER NOT NULL DEFAULT 0,
            detail TEXT,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_core_gw_reconcile_state
            ON core_gateway_outbound_reconcile(state, queryable, updated_at_ms);
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

fn load_config(db: &Connection) -> crate::Result<RuntimeGatewayConfig> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM core_gateway_config WHERE key = 'runtime'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save_config(tx: &Connection, cfg: &RuntimeGatewayConfig) -> crate::Result<()> {
    tx.execute(
        "INSERT INTO core_gateway_config (key, value_json) VALUES ('runtime', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [serde_json::to_string(cfg)?],
    )?;
    Ok(())
}

fn dispatch_gateway_cycle(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    channel_id: &str,
    cycle: &str,
    extra: Value,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<bool> {
    let exec_id = format!(
        "gw-ctrl-{}-{}-{now}",
        cycle,
        &sha256_hex(&format!("{channel_id}:{cycle}:{now}"))[..8]
    );
    let idemp_key = format!("gw-ctrl:{channel_id}:{cycle}:{now}");
    let payload = json!({
        "resourceKey": format!("gateway:{channel_id}:{cycle}"),
        "gatewayControlCycle": cycle,
        "channelId": channel_id,
        "extra": extra,
    });
    let inserted = tx.execute(
        "INSERT INTO core_execution_runs (
            execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
            task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, 'service', 'core-gateway', 0, ?4, 'gateway_control', ?5, 'waiting_executor', 1, 0, ?6, ?6)
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            exec_id,
            idemp_key,
            core_gen,
            format!("gateway:{channel_id}"),
            serde_json::to_string(&payload)?,
            now,
        ],
    )?;
    if inserted > 0 {
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "gateway",
            &format!("gateway.{cycle}Due"),
            channel_id,
            now,
            None,
            &json!({ "channelId": channel_id, "cycle": cycle, "executionId": exec_id, "extra": extra }),
        )?);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn tick_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Value> {
    let mut cfg = load_config(tx)?;
    if cfg.suspended {
        cfg.last_tick_at_ms = Some(now);
        save_config(tx, &cfg)?;
        return Ok(json!({ "status": "ok", "suspended": true, "dispatched": [] }));
    }
    let mut stmt = tx.prepare(
        "SELECT channel_id, channel_type, status, paused, enabled, next_reconnect_at_ms, next_recover_at_ms, in_flight
         FROM core_gateway_channels
         WHERE enabled = 1 AND paused = 0",
    )?;
    let channels: Vec<(String, String, String, i64, i64, Option<i64>, Option<i64>, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut dispatched = Vec::new();
    let has_inbox = table_exists(tx, "gateway_inbox")?;
    let has_outbox = table_exists(tx, "gateway_outbox")?;

    for (channel_id, _ctype, status, _paused, _enabled, next_reconn, next_recover, in_flight) in channels {
        if in_flight != 0 {
            continue;
        }
        if status != "connected"
            && let Some(due) = next_reconn
            && due <= now
        {
            if dispatch_gateway_cycle(tx, core_gen, client_gen, &channel_id, "reconnect", json!({}), now, events)? {
                tx.execute(
                    "UPDATE core_gateway_channels SET in_flight = 1, next_reconnect_at_ms = NULL, updated_at_ms = ?1 WHERE channel_id = ?2",
                    params![now, channel_id],
                )?;
                dispatched.push(format!("{channel_id}:reconnect"));
            }
            continue;
        }
        if status == "connected" {
            let due_recover = next_recover.is_some_and(|due| due <= now)
                || (has_inbox && has_outbox && tx.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM gateway_inbox i
                        LEFT JOIN gateway_outbox o ON o.delivery_id = i.delivery_id
                        WHERE i.channel_id = ?1
                          AND ((i.status IN ('pending', 'reply_pending') AND (o.delivery_id IS NULL OR (o.status = 'pending' AND o.next_attempt_at <= ?2)))
                               OR (o.status = 'pending' AND o.next_attempt_at <= ?2))
                     )",
                    params![channel_id, now],
                    |r| r.get::<_, i64>(0),
                )? != 0);
            if due_recover
                && dispatch_gateway_cycle(tx, core_gen, client_gen, &channel_id, "recoverOutbox", json!({}), now, events)?
            {
                tx.execute(
                    "UPDATE core_gateway_channels SET next_recover_at_ms = NULL, updated_at_ms = ?1 WHERE channel_id = ?2",
                    params![now, channel_id],
                )?;
                dispatched.push(format!("{channel_id}:recoverOutbox"));
            }

            // Reconcile queryable unknown outbound sends; NEVER retry or touch unknown_unqueryable.
            let mut rstmt = tx.prepare(
                "SELECT delivery_id, provider_message_id, check_attempts
                 FROM core_gateway_outbound_reconcile
                 WHERE channel_id = ?1 AND queryable = 1 AND state = 'pending_reconcile' AND check_attempts < ?2
                 ORDER BY updated_at_ms ASC LIMIT 16",
            )?;
            let unknowns: Vec<(String, Option<String>, i64)> = rstmt
                .query_map(params![channel_id, MAX_RECONCILE_ATTEMPTS], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(rstmt);
            for (delivery_id, provider_msg_id, _attempts) in unknowns {
                tx.execute(
                    "UPDATE core_gateway_outbound_reconcile
                     SET check_attempts = check_attempts + 1, last_checked_at_ms = ?1, updated_at_ms = ?1
                     WHERE delivery_id = ?2",
                    params![now, delivery_id],
                )?;
                if dispatch_gateway_cycle(
                    tx,
                    core_gen,
                    client_gen,
                    &channel_id,
                    "reconcileUnknown",
                    json!({ "deliveryId": delivery_id, "providerMessageId": provider_msg_id }),
                    now,
                    events,
                )? {
                    dispatched.push(format!("{channel_id}:reconcileUnknown:{delivery_id}"));
                }
            }
        }
    }

    cfg.last_tick_at_ms = Some(now);
    save_config(tx, &cfg)?;
    Ok(json!({ "status": "ok", "nowMs": now, "dispatched": dispatched }))
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
    if !execution_id.starts_with("gw-ctrl-")
        || !matches!(exec_status, "completed" | "failed" | "cancelled" | "paused" | "unknown")
    {
        return Ok(());
    }
    if !table_exists(tx, "core_gateway_channels")? {
        return Ok(());
    }
    let payload_raw: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM core_execution_runs WHERE execution_id = ?1",
            [execution_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(channel_id) = payload_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("channelId").and_then(Value::as_str).map(ToOwned::to_owned))
    else {
        return Ok(());
    };
    tx.execute(
        "UPDATE core_gateway_channels SET in_flight = 0, updated_at_ms = ?1 WHERE channel_id = ?2",
        params![now, channel_id],
    )?;
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "gateway",
        "gateway.controlSettled",
        &channel_id,
        now,
        None,
        &json!({ "channelId": channel_id, "status": exec_status }),
    )?);
    Ok(())
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    if !table_exists(db, "core_gateway_config")? {
        return Ok(json!({ "status": "ok", "config": RuntimeGatewayConfig::default(), "channels": [], "reconciliations": [] }));
    }
    match command {
        Command::Status { channel_id } => {
            let cfg = load_config(db)?;
            let mut cstmt = db.prepare(
                "SELECT channel_id, channel_type, account_key, enabled, paused, status, generation,
                        offline_attempts, next_reconnect_at_ms, next_recover_at_ms, last_connected_at_ms,
                        error_message, in_flight, updated_at_ms
                 FROM core_gateway_channels
                 WHERE (?1 IS NULL OR channel_id = ?1)
                 ORDER BY channel_id",
            )?;
            let channels: Vec<Value> = cstmt
                .query_map([channel_id.as_deref()], |r| {
                    Ok(json!({
                        "channelId": r.get::<_, String>(0)?,
                        "channelType": r.get::<_, String>(1)?,
                        "accountKey": r.get::<_, Option<String>>(2)?,
                        "enabled": r.get::<_, i64>(3)? != 0,
                        "paused": r.get::<_, i64>(4)? != 0,
                        "status": r.get::<_, String>(5)?,
                        "generation": r.get::<_, i64>(6)?,
                        "offlineAttempts": r.get::<_, i64>(7)?,
                        "nextReconnectAtMs": r.get::<_, Option<i64>>(8)?,
                        "nextRecoverAtMs": r.get::<_, Option<i64>>(9)?,
                        "lastConnectedAtMs": r.get::<_, Option<i64>>(10)?,
                        "errorMessage": r.get::<_, Option<String>>(11)?,
                        "inFlight": r.get::<_, i64>(12)? != 0,
                        "updatedAtMs": r.get::<_, i64>(13)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut rstmt = db.prepare(
                "SELECT delivery_id, channel_id, channel_type, account_key, provider_message_id,
                        queryable, state, last_checked_at_ms, check_attempts, detail, updated_at_ms
                 FROM core_gateway_outbound_reconcile
                 WHERE (?1 IS NULL OR channel_id = ?1)
                 ORDER BY updated_at_ms DESC LIMIT 100",
            )?;
            let reconciliations: Vec<Value> = rstmt
                .query_map([channel_id.as_deref()], |r| {
                    Ok(json!({
                        "deliveryId": r.get::<_, String>(0)?,
                        "channelId": r.get::<_, String>(1)?,
                        "channelType": r.get::<_, String>(2)?,
                        "accountKey": r.get::<_, Option<String>>(3)?,
                        "providerMessageId": r.get::<_, Option<String>>(4)?,
                        "queryable": r.get::<_, i64>(5)? != 0,
                        "state": r.get::<_, String>(6)?,
                        "lastCheckedAtMs": r.get::<_, Option<i64>>(7)?,
                        "checkAttempts": r.get::<_, i64>(8)?,
                        "detail": r.get::<_, Option<String>>(9)?,
                        "updatedAtMs": r.get::<_, i64>(10)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({
                "status": "ok",
                "config": cfg,
                "channels": channels,
                "reconciliations": reconciliations,
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
    ensure_gateway_scheduler_tables(db)?;

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut events = Vec::new();
    let mut dispatches = Vec::new();

    let data = match command {
        Command::Start { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let mut cfg = load_config(&tx)?;
            cfg.started = true;
            cfg.suspended = false;
            save_config(&tx, &cfg)?;
            if table_exists(&tx, "gateway_channels")? {
                let mut gstmt = tx.prepare("SELECT id, type, connected FROM gateway_channels")?;
                let rows: Vec<(String, String, i64)> = gstmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                drop(gstmt);
                for (cid, ctype, connected) in rows {
                    tx.execute(
                        "INSERT INTO core_gateway_channels (
                            channel_id, channel_type, enabled, paused, status, next_reconnect_at_ms, updated_at_ms
                         ) VALUES (?1, ?2, ?3, 0, CASE WHEN ?3=1 THEN 'reconnecting' ELSE 'disconnected' END, CASE WHEN ?3=1 THEN ?4 ELSE NULL END, ?4)
                         ON CONFLICT(channel_id) DO UPDATE SET
                           enabled = excluded.enabled,
                           paused = 0,
                           next_reconnect_at_ms = CASE WHEN excluded.enabled=1 AND status<>'connected' THEN COALESCE(core_gateway_channels.next_reconnect_at_ms, ?4) ELSE core_gateway_channels.next_reconnect_at_ms END,
                           updated_at_ms = excluded.updated_at_ms",
                        params![cid, ctype, connected, now],
                    )?;
                }
            }
            if table_exists(&tx, "gateway_outbox")? && table_exists(&tx, "gateway_inbox")? {
                tx.execute(
                    "UPDATE gateway_outbox SET status = 'unknown', updated_at = ?1, last_error = COALESCE(last_error, 'interrupted_before_receipt')
                     WHERE status = 'sending'",
                    [now],
                )?;
                tx.execute(
                    "UPDATE gateway_inbox SET status = 'unknown', updated_at = ?1, last_error = COALESCE(last_error, 'interrupted_before_receipt')
                     WHERE delivery_id IN (SELECT delivery_id FROM gateway_outbox WHERE status = 'unknown') AND status IN ('running', 'reply_pending')",
                    [now],
                )?;
            }
            let res = tick_tx(&tx, &core_gen, &client.generation, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "started": true, "tick": res })
        }
        Command::Stop { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let mut cfg = load_config(&tx)?;
            cfg.started = false;
            cfg.suspended = true;
            save_config(&tx, &cfg)?;
            tx.execute(
                "UPDATE core_gateway_channels
                 SET paused = 1, in_flight = 0, next_reconnect_at_ms = NULL, next_recover_at_ms = NULL, updated_at_ms = ?1",
                [now],
            )?;
            tx.execute(
                "UPDATE core_execution_runs SET status = 'cancelled', updated_at_ms = ?1
                 WHERE kind = 'gateway_control' AND status IN ('queued', 'waiting_executor')",
                [now],
            )?;
            json!({ "status": "ok", "stopped": true })
        }
        Command::ChannelConnected {
            channel_id,
            channel_type,
            account_key,
            generation,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let next_gen = generation.unwrap_or(1);
            tx.execute(
                "INSERT INTO core_gateway_channels (
                    channel_id, channel_type, account_key, enabled, paused, status, generation,
                    offline_attempts, next_reconnect_at_ms, last_connected_at_ms, error_message, in_flight, updated_at_ms
                 ) VALUES (?1, ?2, ?3, 1, 0, 'connected', ?4, 0, NULL, ?5, NULL, 0, ?5)
                 ON CONFLICT(channel_id) DO UPDATE SET
                   channel_type = excluded.channel_type,
                   account_key = COALESCE(excluded.account_key, core_gateway_channels.account_key),
                   enabled = 1,
                   paused = 0,
                   status = 'connected',
                   generation = MAX(core_gateway_channels.generation + 1, excluded.generation),
                   offline_attempts = 0,
                   next_reconnect_at_ms = NULL,
                   last_connected_at_ms = excluded.last_connected_at_ms,
                   error_message = NULL,
                   in_flight = 0,
                   updated_at_ms = excluded.updated_at_ms",
                params![channel_id, channel_type, account_key, next_gen, now],
            )?;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "gateway",
                "gateway.channelConnected",
                &channel_id,
                now,
                None,
                &json!({ "channelId": channel_id, "channelType": channel_type }),
            )?);
            let _ = tick_tx(&tx, &core_gen, &client.generation, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "channelId": channel_id, "connected": true })
        }
        Command::ChannelDisconnected {
            channel_id,
            channel_type,
            paused,
            reason,
            retry_after_ms,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let current_attempts: i64 = tx
                .query_row(
                    "SELECT offline_attempts FROM core_gateway_channels WHERE channel_id = ?1",
                    [&channel_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            let is_paused = paused.unwrap_or(false);
            let delay = retry_after_ms.unwrap_or_else(|| {
                RECONNECT_BACKOFF_MS[(current_attempts as usize).min(RECONNECT_BACKOFF_MS.len() - 1)]
            });
            let next_reconnect = if is_paused { None } else { Some(now + delay.max(200)) };
            let next_attempts = if is_paused { current_attempts } else { (current_attempts + 1).min(8) };
            tx.execute(
                "INSERT INTO core_gateway_channels (
                    channel_id, channel_type, enabled, paused, status, offline_attempts,
                    next_reconnect_at_ms, error_message, in_flight, updated_at_ms
                 ) VALUES (?1, ?2, CASE WHEN ?3=1 THEN 0 ELSE 1 END, ?3, CASE WHEN ?3=1 THEN 'disconnected' ELSE 'reconnecting' END, ?4, ?5, ?6, 0, ?7)
                 ON CONFLICT(channel_id) DO UPDATE SET
                   enabled = CASE WHEN ?3=1 THEN 0 ELSE 1 END,
                   paused = ?3,
                   status = CASE WHEN ?3=1 THEN 'disconnected' ELSE 'reconnecting' END,
                   offline_attempts = ?4,
                   next_reconnect_at_ms = ?5,
                   error_message = ?6,
                   in_flight = 0,
                   updated_at_ms = ?7",
                params![
                    channel_id,
                    channel_type.as_deref().unwrap_or("unknown"),
                    if is_paused { 1 } else { 0 },
                    next_attempts,
                    next_reconnect,
                    reason,
                    now,
                ],
            )?;
            json!({ "status": "ok", "channelId": channel_id, "paused": is_paused, "nextReconnectAtMs": next_reconnect })
        }
        Command::ScheduleRecover {
            channel_id,
            delay_ms,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let due = now + delay_ms.max(1);
            tx.execute(
                "INSERT INTO core_gateway_channels (
                    channel_id, channel_type, enabled, paused, status, next_recover_at_ms, updated_at_ms
                 ) VALUES (?1, 'unknown', 1, 0, 'connected', ?2, ?3)
                 ON CONFLICT(channel_id) DO UPDATE SET
                   next_recover_at_ms = CASE
                     WHEN core_gateway_channels.next_recover_at_ms IS NOT NULL
                      AND core_gateway_channels.next_recover_at_ms <= ?2
                     THEN core_gateway_channels.next_recover_at_ms
                     ELSE ?2 END,
                   updated_at_ms = ?3",
                params![channel_id, due, now],
            )?;
            json!({ "status": "ok", "channelId": channel_id, "nextRecoverAtMs": due })
        }
        Command::AdmitInbound {
            delivery_id,
            platform,
            channel_id,
            account_key,
            session_key,
            message_id,
            payload_json,
            payload_hash,
            receipt_mode,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let existing: Option<(String, String)> = tx
                .query_row(
                    "SELECT payload_hash, status FROM gateway_inbox WHERE delivery_id = ?1",
                    [&delivery_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((prev_hash, prev_status)) = existing {
                if prev_hash != payload_hash {
                    return Ok(WriteSideEffects {
                        data: json!({
                            "status": "rejected",
                            "code": "PAYLOAD_CONFLICT",
                            "deliveryId": delivery_id,
                            "existingStatus": prev_status,
                        }),
                        events,
                        dispatches,
                        shutdown_after_reply: false,
                    });
                }
                events.push(append_event(
                    &tx,
                    &core_gen,
                    &client.generation,
                    "gateway",
                    "gateway.inboundDeduplicated",
                    &delivery_id,
                    now,
                    None,
                    &json!({ "deliveryId": delivery_id, "channelId": channel_id, "status": prev_status }),
                )?);
                json!({
                    "status": "ok",
                    "duplicate": true,
                    "deliveryId": delivery_id,
                    "inboxStatus": prev_status,
                })
            } else {
                tx.execute(
                    "INSERT INTO gateway_inbox (
                        delivery_id, platform, channel_id, account_key, session_key, message_id,
                        chat_id, payload_json, payload_hash, status, retry_count, receipt_mode, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(json_extract(?7, '$.chatId'), ''), ?7, ?8, 'pending', 0, ?9, ?10, ?10)",
                    params![
                        delivery_id,
                        platform,
                        channel_id,
                        account_key,
                        session_key,
                        message_id,
                        payload_json,
                        payload_hash,
                        receipt_mode.as_deref().unwrap_or("pi-durable"),
                        now,
                    ],
                )?;
                events.push(append_event(
                    &tx,
                    &core_gen,
                    &client.generation,
                    "gateway",
                    "gateway.inboundAdmitted",
                    &delivery_id,
                    now,
                    None,
                    &json!({ "deliveryId": delivery_id, "channelId": channel_id }),
                )?);
                json!({
                    "status": "ok",
                    "duplicate": false,
                    "accepted": true,
                    "deliveryId": delivery_id,
                })
            }
        }
        Command::TrackOutbound {
            delivery_id,
            channel_id,
            channel_type,
            account_key,
            provider_message_id,
            queryable,
            state,
            detail,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let mapped_state = if state == "unknown" {
                if queryable {
                    "pending_reconcile".to_owned()
                } else {
                    "unknown_unqueryable".to_owned()
                }
            } else {
                state.clone()
            };
            tx.execute(
                "INSERT INTO core_gateway_outbound_reconcile (
                    delivery_id, channel_id, channel_type, account_key, provider_message_id,
                    queryable, state, last_checked_at_ms, check_attempts, detail, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0, ?8, ?9)
                 ON CONFLICT(delivery_id) DO UPDATE SET
                   provider_message_id = COALESCE(excluded.provider_message_id, core_gateway_outbound_reconcile.provider_message_id),
                   queryable = excluded.queryable,
                   state = excluded.state,
                   detail = COALESCE(excluded.detail, core_gateway_outbound_reconcile.detail),
                   updated_at_ms = excluded.updated_at_ms",
                params![
                    delivery_id,
                    channel_id,
                    channel_type,
                    account_key,
                    provider_message_id,
                    if queryable { 1 } else { 0 },
                    mapped_state,
                    detail,
                    now,
                ],
            )?;
            if state == "unknown" && table_exists(&tx, "gateway_outbox")? {
                tx.execute(
                    "UPDATE gateway_outbox SET status = 'unknown', last_error = COALESCE(?1, last_error), updated_at = ?2
                     WHERE delivery_id = ?3",
                    params![detail, now, delivery_id],
                )?;
                tx.execute(
                    "UPDATE gateway_inbox SET status = 'unknown', last_error = COALESCE(?1, last_error), updated_at = ?2
                     WHERE delivery_id = ?3",
                    params![detail, now, delivery_id],
                )?;
            }
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "gateway",
                "gateway.outboundTracked",
                &delivery_id,
                now,
                None,
                &json!({ "deliveryId": delivery_id, "state": mapped_state, "queryable": queryable }),
            )?);
            json!({ "status": "ok", "deliveryId": delivery_id, "state": mapped_state, "queryable": queryable })
        }
        Command::SettleUnknown {
            delivery_id,
            outcome,
            provider_message_id,
            detail,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let current_rec: Option<(i64, String)> = tx
                .query_row(
                    "SELECT queryable, state FROM core_gateway_outbound_reconcile WHERE delivery_id = ?1",
                    [&delivery_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let mut next_state = outcome.clone();
            match outcome.as_str() {
                "confirmed_sent" => {
                    if table_exists(&tx, "gateway_outbox")? {
                        tx.execute(
                            "UPDATE gateway_outbox SET status = 'sent', sent_at = COALESCE(sent_at, ?1), last_error = NULL, updated_at = ?1 WHERE delivery_id = ?2",
                            params![now, delivery_id],
                        )?;
                        tx.execute(
                            "UPDATE gateway_inbox SET status = 'completed', last_error = NULL, updated_at = ?1 WHERE delivery_id = ?2",
                            params![now, delivery_id],
                        )?;
                    }
                }
                "confirmed_not_sent" => {
                    // Only queryable proof of non-delivery may safely requeue once.
                    if current_rec.as_ref().is_some_and(|(q, _)| *q != 0)
                        && table_exists(&tx, "gateway_outbox")?
                    {
                        tx.execute(
                            "UPDATE gateway_outbox SET status = 'pending', next_attempt_at = ?1, last_error = ?2, updated_at = ?1 WHERE delivery_id = ?3",
                            params![now, detail, delivery_id],
                        )?;
                        tx.execute(
                            "UPDATE gateway_inbox SET status = 'reply_pending', updated_at = ?1 WHERE delivery_id = ?2",
                            params![now, delivery_id],
                        )?;
                    } else {
                        next_state = "unknown_unqueryable".to_owned();
                    }
                }
                _ => {
                    next_state = if current_rec.as_ref().is_some_and(|(q, _)| *q == 0) {
                        "unknown_unqueryable".to_owned()
                    } else {
                        "pending_reconcile".to_owned()
                    };
                }
            }
            tx.execute(
                "UPDATE core_gateway_outbound_reconcile
                 SET state = ?1, provider_message_id = COALESCE(?2, provider_message_id),
                     detail = COALESCE(?3, detail), last_checked_at_ms = ?4, updated_at_ms = ?4
                 WHERE delivery_id = ?5",
                params![next_state, provider_message_id, detail, now, delivery_id],
            )?;
            events.push(append_event(
                &tx,
                &core_gen,
                &client.generation,
                "gateway",
                "gateway.outboundReconciled",
                &delivery_id,
                now,
                None,
                &json!({ "deliveryId": delivery_id, "state": next_state }),
            )?);
            json!({ "status": "ok", "deliveryId": delivery_id, "state": next_state })
        }
        Command::Tick { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let res = tick_tx(&tx, &core_gen, &client.generation, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            res
        }
        Command::Status { .. } => json!({ "status": "rejected", "code": "READ_ONLY" }),
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
    if !table_exists(db, "core_gateway_config")? {
        return Ok(None);
    }
    let cfg = load_config(db)?;
    if !cfg.started || cfg.suspended {
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
        ensure_gateway_scheduler_tables(&conn).expect("gateway tables");
        conn
    }

    #[test]
    fn gateway_reconnect_dedup_and_queryable_vs_unqueryable_unknown() {
        let mut conn = setup_db();
        let tracker = ExecutorTracker::default();
        let ctx = ClientContext::synthetic("test-gen");
        let t0 = 1_700_000_000_000i64;
        let acct = "a".repeat(64);
        let payload = json!({
            "version": 1,
            "channelId": "slack-default",
            "chatId": "C123",
            "messageId": "m-1",
            "text": "hello",
        })
        .to_string();
        let hash = sha256_hex(&payload);

        // 1. Admit inbound once, then replay on reconnect -> duplicate: true, 1 row total
        let a1 = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::AdmitInbound {
                delivery_id: "del-1".into(),
                platform: "slack".into(),
                channel_id: "slack-default".into(),
                account_key: acct.clone(),
                session_key: "[\"slack-default\",\"C123\"]".into(),
                message_id: "m-1".into(),
                payload_json: payload.clone(),
                payload_hash: hash.clone(),
                receipt_mode: Some("pi-durable".into()),
                now_ms: Some(t0),
            },
        )
        .unwrap();
        assert_eq!(a1.data["duplicate"], json!(false));

        let a2 = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::AdmitInbound {
                delivery_id: "del-1".into(),
                platform: "slack".into(),
                channel_id: "slack-default".into(),
                account_key: acct.clone(),
                session_key: "[\"slack-default\",\"C123\"]".into(),
                message_id: "m-1".into(),
                payload_json: payload,
                payload_hash: hash,
                receipt_mode: Some("pi-durable".into()),
                now_ms: Some(t0 + 500),
            },
        )
        .unwrap();
        assert_eq!(a2.data["duplicate"], json!(true));
        let inbox_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gateway_inbox WHERE delivery_id = 'del-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(inbox_count, 1);

        // 2. Outbound lost receipt: queryable channel vs non-queryable channel
        conn.execute(
            "INSERT INTO gateway_outbox (delivery_id, reply_text, reply_hash, status, retry_count, next_attempt_at, created_at, updated_at)
             VALUES ('del-1', 'ok', 'h1', 'sending', 1, 0, ?1, ?1)",
            [t0],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO gateway_inbox (delivery_id, platform, channel_id, account_key, chat_id, session_key, message_id, payload_json, payload_hash, status, retry_count, receipt_mode, created_at, updated_at)
             VALUES ('del-unq', 'wecom', 'wecom-default', ?1, 'chat2', 's2', 'm-2', '{}', 'h2', 'reply_pending', 0, 'none', ?2, ?2)",
            params![acct, t0],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO gateway_outbox (delivery_id, reply_text, reply_hash, status, retry_count, next_attempt_at, created_at, updated_at)
             VALUES ('del-unq', 'ok2', 'h2', 'sending', 1, 0, ?1, ?1)",
            [t0],
        )
        .unwrap();

        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::ChannelConnected {
                channel_id: "slack-default".into(),
                channel_type: "slack".into(),
                account_key: Some(acct.clone()),
                generation: Some(1),
                now_ms: Some(t0 + 1000),
            },
        )
        .unwrap();
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::ChannelConnected {
                channel_id: "wecom-default".into(),
                channel_type: "wecom".into(),
                account_key: Some(acct),
                generation: Some(1),
                now_ms: Some(t0 + 1000),
            },
        )
        .unwrap();

        let q = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::TrackOutbound {
                delivery_id: "del-1".into(),
                channel_id: "slack-default".into(),
                channel_type: "slack".into(),
                account_key: None,
                provider_message_id: Some("ts-1".into()),
                queryable: true,
                state: "unknown".into(),
                detail: Some("receipt_lost".into()),
                now_ms: Some(t0 + 2000),
            },
        )
        .unwrap();
        assert_eq!(q.data["state"], json!("pending_reconcile"));

        let uq = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::TrackOutbound {
                delivery_id: "del-unq".into(),
                channel_id: "wecom-default".into(),
                channel_type: "wecom".into(),
                account_key: None,
                provider_message_id: None,
                queryable: false,
                state: "unknown".into(),
                detail: Some("no_lookup_api".into()),
                now_ms: Some(t0 + 2000),
            },
        )
        .unwrap();
        assert_eq!(uq.data["state"], json!("unknown_unqueryable"));

        let t_res = execute_write(&mut conn, &tracker, &ctx, Command::Tick { now_ms: Some(t0 + 3000) }).unwrap();
        let dispatches = t_res.data["dispatched"].as_array().unwrap();
        assert!(dispatches.iter().any(|v| v == "slack-default:reconcileUnknown:del-1"));
        assert!(!dispatches.iter().any(|v| v.as_str().unwrap().contains("del-unq")));

        // Settle queryable delivery as confirmed_sent without blind re-send
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::SettleUnknown {
                delivery_id: "del-1".into(),
                outcome: "confirmed_sent".into(),
                provider_message_id: Some("ts-1".into()),
                detail: Some("found_via_conversations_history".into()),
                now_ms: Some(t0 + 4000),
            },
        )
        .unwrap();
        let q_outbox: String = conn
            .query_row("SELECT status FROM gateway_outbox WHERE delivery_id = 'del-1'", [], |r| r.get(0))
            .unwrap();
        let uq_outbox: String = conn
            .query_row("SELECT status FROM gateway_outbox WHERE delivery_id = 'del-unq'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(q_outbox, "sent");
        assert_eq!(uq_outbox, "unknown");
    }
}
