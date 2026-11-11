import type Database from "better-sqlite3";

/**
 * BOT-WORK-1.0 authoritative store.
 *
 * `works` replaces `conversation_goals`: one delegation record, no parallel live goal
 * table and no legacy data copy. Schema changes bump CURRENT_DATABASE_SCHEMA_VERSION;
 * incompatible files are backed up by resetIncompatibleDatabaseFile before opening.
 * Intent snapshots keep one row per requirement revision and source version.
 */
export function ensureBotWorkTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      responsibility_summary TEXT NOT NULL DEFAULT '',
      expert_profile_json TEXT NOT NULL CHECK (json_valid(expert_profile_json)),
      memory_scope_json TEXT NOT NULL CHECK (json_valid(memory_scope_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      foreground_allowed_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(foreground_allowed_tools_json)),
      notification_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notification_policy_json)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bots_user_status ON bots(user_id, status);

    CREATE TABLE IF NOT EXISTS bot_channel_bindings (
      channel_type TEXT NOT NULL CHECK (channel_type IN ('desktop','mobile','remote','gateway')),
      channel_identifier TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      PRIMARY KEY (channel_type, channel_identifier),
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS bot_expert_versions (
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','active','superseded')),
      expert_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      system_prompt_hash TEXT NOT NULL,
      configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
      skill_packages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_packages_json)),
      allowed_mcp_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_mcp_ids_json)),
      allowed_skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_skill_ids_json)),
      allowed_connector_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_connector_ids_json)),
      staged_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      adopted_at INTEGER,
      PRIMARY KEY (bot_id, version),
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_expert_pending
      ON bot_expert_versions(bot_id) WHERE state = 'pending';

    CREATE TABLE IF NOT EXISTS works (
      work_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      workspace_path TEXT,
      source_message_id TEXT,
      legacy_task_id TEXT,
      owner_bot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
      intent_revision INTEGER NOT NULL DEFAULT 1 CHECK (intent_revision > 0),
      source_version INTEGER NOT NULL DEFAULT 1 CHECK (source_version > 0),
      title TEXT NOT NULL,
      goal_description TEXT,
      constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
      criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      active_intent_snapshot_id TEXT NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      goal_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
      mode TEXT NOT NULL DEFAULT 'once' CHECK (mode IN ('once','watch')),
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','paused','closing','closed')),
      pending_conclusion TEXT CHECK (pending_conclusion IS NULL OR pending_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
      cancel_requested_at INTEGER,
      closure_conclusion TEXT CHECK (closure_conclusion IS NULL OR closure_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
      closure_summary TEXT,
      accepted_deliverable_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accepted_deliverable_ids_json)),
      active_execution_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(active_execution_ids_json)),
      progress_summary TEXT,
      watch_rule_json TEXT CHECK (watch_rule_json IS NULL OR json_valid(watch_rule_json)),
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
      created_by TEXT NOT NULL CHECK (created_by IN ('user','bot')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      close_operation_id TEXT,
      FOREIGN KEY (owner_bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_works_owner_lifecycle ON works(owner_bot_id, lifecycle);
    CREATE INDEX IF NOT EXISTS idx_works_user_lifecycle ON works(user_id, lifecycle, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_works_legacy_task ON works(legacy_task_id, lifecycle);

    CREATE TABLE IF NOT EXISTS work_intent_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      source_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      goal_description TEXT,
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      input_snapshot_id TEXT NOT NULL,
      goal_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
      created_by TEXT NOT NULL CHECK (created_by IN ('user','bot')),
      source_message_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (work_id, intent_revision, source_version)
    );

    CREATE TABLE IF NOT EXISTS work_conversations (
      work_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'desktop',
      last_referenced_at INTEGER NOT NULL,
      PRIMARY KEY (work_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_conversations_conv
      ON work_conversations(conversation_id, last_referenced_at DESC);

    CREATE TABLE IF NOT EXISTS work_message_refs (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE RESTRICT,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (work_id, conversation_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS work_participants (
      work_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('collaborator','worker','watcher')),
      delegated_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      added_at INTEGER NOT NULL,
      PRIMARY KEY (work_id, bot_id)
    );

    CREATE TABLE IF NOT EXISTS work_execution_bindings (
      binding_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      durable_store_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      delegated_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
      workspace_binding TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','submitted','running','completed','failed','stopped','unknown','invalidated')),
      attempt_id TEXT,
      submission_receipt TEXT,
      settlement_note TEXT,
      admitted_at INTEGER NOT NULL,
      submitted_at INTEGER,
      invalidated_at INTEGER,
      settled_at INTEGER,
      UNIQUE (work_id, operation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_bindings_work
      ON work_execution_bindings(work_id, status, admitted_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_binding_namespace
      ON work_execution_bindings(task_id, durable_store_key, conversation_id, operation_id);

    CREATE TABLE IF NOT EXISTS work_action_admissions (
      admission_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      binding_id TEXT,
      operation_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('admitted','consumed','released','unknown')),
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      admitted_at INTEGER NOT NULL,
      settled_at INTEGER,
      UNIQUE (work_id, operation_id, admission_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_admissions_open
      ON work_action_admissions(work_id, state);

    CREATE TABLE IF NOT EXISTS work_deliverables (
      deliverable_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      producer_bot_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
      summary TEXT NOT NULL,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
      evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
      uncovered_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_scope_json)),
      uncovered_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_criterion_ids_json)),
      is_speculation INTEGER NOT NULL DEFAULT 0 CHECK (is_speculation IN (0,1)),
      has_write_conflicts INTEGER NOT NULL DEFAULT 0 CHECK (has_write_conflicts IN (0,1)),
      rejected_reason TEXT,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      reviewed_by_bot_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_deliverables_work
      ON work_deliverables(work_id, status, intent_revision);

    CREATE TABLE IF NOT EXISTS work_evidence (
      evidence_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      deliverable_id TEXT,
      execution_id TEXT,
      criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criterion_ids_json)),
      kind TEXT NOT NULL CHECK (kind IN ('automated_test','tool_receipt','inspection','artifact','real_environment','user_attestation')),
      provenance TEXT NOT NULL CHECK (provenance IN ('execution','user','system')),
      source_ref TEXT NOT NULL,
      source_sha TEXT,
      input_snapshot_id TEXT NOT NULL,
      environment TEXT,
      intent_revision INTEGER NOT NULL,
      detail TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_evidence_work ON work_evidence(work_id, criterion_ids_json);
    CREATE INDEX IF NOT EXISTS idx_work_evidence_snapshot ON work_evidence(work_id, input_snapshot_id);

    CREATE TABLE IF NOT EXISTS work_blockers (
      blocker_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      reported_by_bot_id TEXT,
      reason TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('external_effect','backpressure','write_conflict','operational')),
      unknown_external_effect_ref TEXT,
      waiting_for_user_input INTEGER NOT NULL DEFAULT 0 CHECK (waiting_for_user_input IN (0,1)),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared')),
      created_at INTEGER NOT NULL,
      cleared_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_blockers_work_status ON work_blockers(work_id, status);

    CREATE TABLE IF NOT EXISTS work_operation_receipts (
      user_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      work_id TEXT,
      operation_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_snapshot_json TEXT NOT NULL CHECK (json_valid(result_snapshot_json)),
      outbox_event_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, operation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_receipts_work ON work_operation_receipts(work_id, created_at);

    CREATE TABLE IF NOT EXISTS work_host_lease (
      lease_id TEXT PRIMARY KEY CHECK (lease_id = 'singleton'),
      authority_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      released_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS work_telemetry_state (
      work_id TEXT PRIMARY KEY,
      active_execution_id TEXT,
      streaming_text TEXT,
      tokens_per_second REAL,
      last_heartbeat_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_source_events (
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_version TEXT,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      received_at INTEGER NOT NULL,
      PRIMARY KEY (source, source_event_id)
    );

    CREATE TABLE IF NOT EXISTS work_events_inbox (
      event_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      work_id TEXT NOT NULL,
      subscription_id TEXT,
      intent_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      source_version TEXT,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','skipped','blocked','processed')),
      merged_count INTEGER NOT NULL DEFAULT 1,
      merge_deadline_at INTEGER,
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_inbox_pending
      ON work_events_inbox(work_id, status, received_at);
    CREATE INDEX IF NOT EXISTS idx_work_inbox_subscription
      ON work_events_inbox(subscription_id, status, received_at);

    CREATE TABLE IF NOT EXISTS work_events_outbox (
      event_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      work_id TEXT NOT NULL,
      binding_id TEXT,
      intent_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','attempted','delivered','unknown','invalidated')),
      attempt_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_outbox_pending ON work_events_outbox(delivery_status, created_at ASC);

    CREATE TABLE IF NOT EXISTS work_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      source TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filter_json)),
      catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('latest','each','skip')),
      max_merge_wait_ms INTEGER NOT NULL,
      max_queue_depth INTEGER NOT NULL,
      stop_condition_text TEXT,
      timezone TEXT,
      cron_expression TEXT,
      next_wake_at INTEGER,
      last_processed_source_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      stopped_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_subscriptions_work ON work_subscriptions(work_id, stopped_at);
    CREATE INDEX IF NOT EXISTS idx_work_subscriptions_source_active ON work_subscriptions(source, stopped_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_subscriptions_wake ON work_subscriptions(next_wake_at);

    CREATE TABLE IF NOT EXISTS work_notifications (
      notification_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      semantic_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('result','blocked','closed','handoff','summary')),
      title TEXT NOT NULL,
      body TEXT,
      state_version INTEGER NOT NULL,
      intent_revision INTEGER NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending','sent','unknown','failed')),
      channel TEXT,
      idempotency_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_receipt TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_notifications_work ON work_notifications(work_id, created_at DESC);
  `);
}
