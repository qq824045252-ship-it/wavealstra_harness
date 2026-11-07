import type Database from "better-sqlite3";

/**
 * Phase 4 business ledgers: source-target watermarks, frozen merge batches, logical
 * schedule instances, observed offline gaps, causal admissions, a three-bucket budget
 * window ledger and per-provider-request reservations.
 *
 * Only the current schema is created. Incompatible file databases keep the existing
 * AppDatabase backup/reset contract; no old-schema migration or dual read path exists.
 */
export function ensureBotWorkPhase4Tables(db: Database.Database): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
  const add = (table: string, name: string, ddl: string): void => {
    const existing = columns(table);
    if (!existing.size || existing.has(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  // Source facts keep the receipt clock separate from the provider's own occurred time.
  add("work_source_events", "occurred_at", "occurred_at INTEGER");
  add("work_source_events", "target_key", "target_key TEXT");
  add("work_source_events", "payload_bytes", "payload_bytes INTEGER NOT NULL DEFAULT 0");
  add("work_source_events", "adapter", "adapter TEXT");
  add("work_source_events", "trusted_origin", "trusted_origin TEXT");

  // Per-target watermarks replace one global last_processed_source_version.
  add("work_subscriptions", "schedule_revision", "schedule_revision INTEGER NOT NULL DEFAULT 1");
  add("work_subscriptions", "config_revision", "config_revision INTEGER NOT NULL DEFAULT 1");
  add("work_subscriptions", "source_target", "source_target TEXT");
  add("work_subscriptions", "version_mode", "version_mode TEXT NOT NULL DEFAULT 'readback'");
  add("work_subscriptions", "dst_policy", "dst_policy TEXT NOT NULL DEFAULT 'first-valid'");
  add("work_subscriptions", "max_backlog_events", "max_backlog_events INTEGER NOT NULL DEFAULT 400");
  add("work_subscriptions", "max_backlog_bytes", "max_backlog_bytes INTEGER NOT NULL DEFAULT 8388608");
  add("work_subscriptions", "last_checked_at", "last_checked_at INTEGER");
  add("work_subscriptions", "stopped_reason", "stopped_reason TEXT");
  add("work_subscriptions", "config_json", "config_json TEXT NOT NULL DEFAULT '{}'");

  // Immutable frozen batches and each-event payload references.
  add("work_events_inbox", "batch_id", "batch_id TEXT");
  add("work_events_inbox", "batch_deadline_at", "batch_deadline_at INTEGER");
  add("work_events_inbox", "frozen_at", "frozen_at INTEGER");
  add("work_events_inbox", "frozen_payload_json", "frozen_payload_json TEXT");
  add("work_events_inbox", "claim_version", "claim_version INTEGER NOT NULL DEFAULT 0");
  add("work_events_inbox", "target_key", "target_key TEXT");
  add("work_events_inbox", "process_reason", "process_reason TEXT");

  // Reservations stay the only ledger; actual quantity and request identity are separate.
  add("work_budget_reservations", "reported_tokens", "reported_tokens INTEGER");
  add("work_budget_reservations", "request_kind", "request_kind TEXT");
  add("work_budget_reservations", "request_id", "request_id TEXT");
  add("work_budget_reservations", "binding_id", "binding_id TEXT");
  add("work_budget_reservations", "attempt_id", "attempt_id TEXT");
  add("work_budget_reservations", "attempt_identity", "attempt_identity TEXT");
  add("work_budget_reservations", "receipt_key", "receipt_key TEXT");
  add("work_budget_reservations", "metering", "metering TEXT CHECK(metering IS NULL OR metering IN ('reserved','reported','unknown','released'))");

  // The execution binding remembers which immutable each event it was dispatched for.
  add("work_execution_bindings", "inbox_event_id", "inbox_event_id TEXT");
  add("work_dispatch_requests", "inbox_event_id", "inbox_event_id TEXT");

  // Business commitment deadline is independent from authorization/budget expiry.
  add("works", "deadline_at", "deadline_at INTEGER");
  add("works", "deadline_revision", "deadline_revision INTEGER NOT NULL DEFAULT 1");
  add("works", "deadline_set_at", "deadline_set_at INTEGER");
  add("works", "budget_policy_json", "budget_policy_json TEXT NOT NULL DEFAULT '{}'");
  add("works", "causal_policy_json", "causal_policy_json TEXT NOT NULL DEFAULT '{}'");

  // Stable blocker reason codes and structured detail; kind keeps its existing CHECK set.
  add("work_blockers", "reason_code", "reason_code TEXT");
  add("work_blockers", "details_json", "details_json TEXT NOT NULL DEFAULT '{}'");
  add("work_blockers", "source_ref", "source_ref TEXT");
  add("work_blockers", "subscription_id", "subscription_id TEXT");
  add("work_blockers", "window_id", "window_id TEXT");
  add("work_blockers", "causal_chain_id", "causal_chain_id TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_subscription_cursors (
      subscription_id TEXT NOT NULL,
      source TEXT NOT NULL,
      target_key TEXT NOT NULL,
      highest_accepted_version TEXT,
      highest_consumed_version TEXT,
      highest_frozen_version TEXT,
      replay_cursor TEXT,
      enumeration_watermark TEXT,
      accepted_events INTEGER NOT NULL DEFAULT 0,
      consumed_events INTEGER NOT NULL DEFAULT 0,
      accepted_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subscription_id, source, target_key)
    );

    CREATE TABLE IF NOT EXISTS work_ingress_routes (
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      inbox_event_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','merged','skipped','blocked','duplicate','rejected')),
      reason_code TEXT,
      source_version TEXT,
      trust TEXT NOT NULL DEFAULT 'adapter' CHECK (trust IN ('adapter','host','system')),
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (source, source_event_id, subscription_id),
      FOREIGN KEY (source, source_event_id) REFERENCES work_source_events(source, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_subscription
      ON work_ingress_routes(subscription_id, state, accepted_at);
    CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_inbox
      ON work_ingress_routes(inbox_event_id);

    CREATE TABLE IF NOT EXISTS work_schedule_ticks (
      tick_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,
      logical_slot_key TEXT NOT NULL,
      planned_at INTEGER NOT NULL,
      effective_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','dispatched','skipped','blocked')),
      merged_from_slot_keys_json TEXT NOT NULL DEFAULT '[]',
      inbox_event_id TEXT,
      offline_gap_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (subscription_id, schedule_revision, logical_slot_key)
    );
    CREATE INDEX IF NOT EXISTS idx_work_schedule_ticks_work
      ON work_schedule_ticks(work_id, status, effective_at);

    CREATE TABLE IF NOT EXISTS work_offline_gaps (
      gap_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      subscription_id TEXT,
      work_id TEXT,
      offline_gap_from INTEGER NOT NULL,
      offline_gap_to INTEGER NOT NULL,
      detected_by TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('evidence','inferred')),
      policy TEXT NOT NULL CHECK (policy IN ('latest','each','skip')),
      policy_revision INTEGER NOT NULL,
      source_cursor TEXT,
      queryable INTEGER NOT NULL DEFAULT 0 CHECK (queryable IN (0,1)),
      recovered_count INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER,
      unknown_count INTEGER,
      state TEXT NOT NULL CHECK (state IN ('open','recovering','recovered','unqueryable')),
      continuation_cursor TEXT,
      gap_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (host_session_id, subscription_id, offline_gap_from)
    );
    CREATE INDEX IF NOT EXISTS idx_work_offline_gaps_work
      ON work_offline_gaps(work_id, state, offline_gap_from);

    CREATE TABLE IF NOT EXISTS work_causal_chains (
      chain_id TEXT PRIMARY KEY,
      root_event_id TEXT NOT NULL,
      parent_chain_id TEXT,
      parent_causal_event_id TEXT,
      origin_work_id TEXT NOT NULL,
      origin_bot_id TEXT,
      target_work_id TEXT NOT NULL,
      target_subscription_id TEXT,
      source TEXT NOT NULL,
      source_event_id TEXT,
      input_snapshot_id TEXT,
      target_state_hash TEXT,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      hops INTEGER NOT NULL CHECK (hops >= 0),
      dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
      admission_key TEXT NOT NULL UNIQUE,
      decision TEXT NOT NULL CHECK (decision IN ('admitted','blocked-loop','blocked-depth','blocked-hops','blocked-budget','unknown-attribution')),
      reason_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_causal_chains_state
      ON work_causal_chains(target_work_id, target_state_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_causal_chains_root
      ON work_causal_chains(root_event_id);

    CREATE TABLE IF NOT EXISTS work_budget_windows (
      window_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'work' CHECK (scope IN ('work','window')),
      period_start_at INTEGER NOT NULL,
      period_end_at INTEGER,
      timezone TEXT,
      limit_tokens INTEGER NOT NULL CHECK (limit_tokens >= 0),
      auto_rollover INTEGER NOT NULL DEFAULT 0 CHECK (auto_rollover IN (0,1)),
      carry_policy TEXT NOT NULL DEFAULT 'none' CHECK (carry_policy IN ('none','outstanding')),
      status TEXT NOT NULL CHECK (status IN ('open','closed','exhausted')),
      committed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (committed_tokens >= 0),
      reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      unknown_tokens INTEGER NOT NULL DEFAULT 0 CHECK (unknown_tokens >= 0),
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      UNIQUE (work_id, policy_revision, period_start_at)
    );
    CREATE INDEX IF NOT EXISTS idx_work_budget_windows_work
      ON work_budget_windows(work_id, status, period_start_at);

    CREATE TABLE IF NOT EXISTS work_budget_requests (
      request_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      binding_id TEXT,
      task_id TEXT NOT NULL,
      conversation_id TEXT,
      generation_task_id INTEGER,
      request_kind TEXT NOT NULL,
      attempt_identity TEXT NOT NULL UNIQUE,
      estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
      reported_tokens INTEGER,
      metering TEXT NOT NULL CHECK (metering IN ('reserved','reported','unknown','released')),
      receipt_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_budget_requests_work
      ON work_budget_requests(work_id, metering, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_budget_requests_task
      ON work_budget_requests(task_id, generation_task_id, metering);

    CREATE TABLE IF NOT EXISTS work_budget_request_sequences (
      task_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS work_watch_host_state (
      authority_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_scan_at INTEGER,
      last_scan_cursor TEXT,
      active_since INTEGER,
      last_seen_at INTEGER NOT NULL,
      suspend_evidence TEXT,
      stopped_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_deadline_instances (
      work_id TEXT NOT NULL,
      deadline_revision INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('armed','followed-up','cancelled')),
      inbox_event_id TEXT,
      created_at INTEGER NOT NULL,
      followed_at INTEGER,
      PRIMARY KEY (work_id, deadline_revision, deadline_at)
    );
    CREATE INDEX IF NOT EXISTS idx_work_deadline_instances_pending
      ON work_deadline_instances(state, deadline_at);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_blocker_reason
      ON work_blockers(work_id, reason_code) WHERE status='open' AND reason_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_work_inbox_batch
      ON work_events_inbox(batch_id, status, merge_deadline_at);
    CREATE INDEX IF NOT EXISTS idx_work_inbox_target
      ON work_events_inbox(subscription_id, target_key, status, received_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_budget_reservation_attempt
      ON work_budget_reservations(attempt_identity) WHERE attempt_identity IS NOT NULL;
  `);

  // New business tables join the existing per-user projection journal.
  const sources: Array<[string, (row: string) => string]> = [
    ["work_schedule_ticks", row => `${row}.work_id`],
    ["work_offline_gaps", row => `${row}.work_id`],
    ["work_causal_chains", row => `${row}.target_work_id`],
    ["work_budget_windows", row => `${row}.work_id`],
    ["work_budget_requests", row => `${row}.work_id`],
    ["work_ingress_routes", row => `${row}.work_id`],
    ["work_events_inbox", row => `${row}.work_id`],
    ["work_subscriptions", row => `${row}.work_id`],
    ["work_budget_reservations", row => `${row}.work_id`],
  ];
  for (const [table, reference] of sources) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const workId = reference(operation === "DELETE" ? "OLD" : "NEW");
    const userId = `(SELECT user_id FROM works WHERE work_id=${workId})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS phase4_projection_${table}_${operation} AFTER ${operation} ON ${table}
      WHEN ${workId} IS NOT NULL AND ${userId} IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT ${userId}
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=${userId});
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=${userId};
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,${workId} FROM work_projection_streams WHERE user_id=${userId};
    END;`);
  }
}
