import type Database from "better-sqlite3";

/**
 * Phase 5 facts: the stable semantic result card, the provider-level effect identity
 * behind a notification intent, and the current owner's summary watermark.
 *
 * `work_result_cards` projects an acceptance fact that already committed. It is the only
 * write point for card read state, and it never owns Work lifecycle, ownership, budget or
 * execution authority, so it cannot become a second Work table.
 *
 * Only the current schema is created. Incompatible files keep the AppDatabase
 * backup-then-recreate contract; there is no old-schema migration or dual read path.
 */
export function ensureBotWorkPhase5Tables(db: Database.Database): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
  const add = (table: string, name: string, ddl: string): void => {
    const existing = columns(table);
    if (!existing.size || existing.has(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  // A notification intent points at the card it announces; delivery stays separate.
  add("work_notifications", "card_key", "card_key TEXT");
  add("work_notifications", "target_key", "target_key TEXT");
  add("work_notifications", "effect_key", "effect_key TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_result_cards (
      card_key TEXT PRIMARY KEY,
      semantic_card_key TEXT NOT NULL UNIQUE,
      work_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('accepted_result','closure_succeeded','closure_cancelled','closure_failed','blocked_escalation')),
      intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
      input_snapshot_id TEXT NOT NULL,
      origin_owner_epoch INTEGER NOT NULL CHECK (origin_owner_epoch > 0),
      canonical_outcome_hash TEXT NOT NULL,
      canonical_outcome_json TEXT NOT NULL CHECK (json_valid(canonical_outcome_json)),
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      deliverable_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deliverable_ids_json)),
      evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
      artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
      unverified_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unverified_scope_json)),
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      read_by_user_id TEXT,
      read_version INTEGER NOT NULL DEFAULT 0 CHECK (read_version >= 0),
      CHECK (read_at IS NULL OR read_by_user_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_work_result_cards_work
      ON work_result_cards(work_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_result_cards_outcome
      ON work_result_cards(work_id, intent_revision, input_snapshot_id, canonical_outcome_hash);
    CREATE INDEX IF NOT EXISTS idx_work_result_cards_unread
      ON work_result_cards(user_id, read_at) WHERE read_at IS NULL;

    CREATE TABLE IF NOT EXISTS work_notification_effects (
      effect_key TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES work_notifications(notification_id),
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      channel TEXT NOT NULL,
      target_key TEXT,
      delivery_guarantee TEXT NOT NULL CHECK (delivery_guarantee IN ('idempotent-queryable','idempotent-unqueryable','best-effort-unqueryable')),
      supports_idempotency_key INTEGER NOT NULL CHECK (supports_idempotency_key IN (0,1)),
      supports_receipt_query INTEGER NOT NULL CHECK (supports_receipt_query IN (0,1)),
      authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('initial','manual-resend')),
      authorization_operation_id TEXT NOT NULL,
      authorization_reason TEXT,
      resend_of_attempt_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_notification_effects_notification
      ON work_notification_effects(notification_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_notification_effect_initial
      ON work_notification_effects(notification_id) WHERE authorization_kind = 'initial';

    CREATE TABLE IF NOT EXISTS work_owner_summaries (
      work_id TEXT PRIMARY KEY,
      intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
      input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
      digest TEXT NOT NULL,
      card_key TEXT,
      pending_decision_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_decision_codes_json)),
      handled_watermark_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(handled_watermark_json)),
      updated_at INTEGER NOT NULL
    );
  `);

  // Card reads, effect settlement and summary watermarks are independent facts: they must
  // wake the user stream without inventing a new Work control version.
  const sources: Array<[string, (row: string) => string]> = [
    ["work_result_cards", row => `${row}.work_id`],
    ["work_owner_summaries", row => `${row}.work_id`],
    ["work_notification_effects", row => `(SELECT work_id FROM work_notifications WHERE notification_id=${row}.notification_id)`],
  ];
  for (const [table, reference] of sources) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const workId = reference(operation === "DELETE" ? "OLD" : "NEW");
    const userId = `(SELECT user_id FROM works WHERE work_id=${workId})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS phase5_projection_${table}_${operation} AFTER ${operation} ON ${table}
      WHEN ${workId} IS NOT NULL AND ${userId} IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT ${userId}
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=${userId});
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=${userId};
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,${workId} FROM work_projection_streams WHERE user_id=${userId};
    END;`);
  }
}
