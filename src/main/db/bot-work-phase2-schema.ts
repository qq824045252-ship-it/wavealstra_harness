import type Database from "better-sqlite3";

/** Per-user replay window; older cursors recover through an authoritative snapshot. */
export const WORK_PROJECTION_EVENT_RETENTION = 10_000;

/** Only the current schema is created; old databases retain the existing backup/reset contract. */
export function ensureBotWorkPhase2Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_conversations (
      conversation_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(bot_id), user_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, current_request_id TEXT, archived_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_live_conversation ON bot_conversations(user_id,bot_id) WHERE archived_at IS NULL;
    CREATE TABLE IF NOT EXISTS bot_messages (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), bot_id TEXT NOT NULL,
      request_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','unknown','failed')),
      work_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(work_ids_json)), error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id,request_id,role)
    );
    CREATE TABLE IF NOT EXISTS bot_send_receipts (
      user_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id),
      user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, selected_work_id TEXT,
      reference_message_id TEXT, PRIMARY KEY(user_id,bot_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS bot_cancel_intents (
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), request_id TEXT NOT NULL,
      confirmed_at INTEGER, PRIMARY KEY(conversation_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS work_dispatch_requests (
      operation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), task_id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatched','cancelled','blocked')),
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_pending_dispatch ON work_dispatch_requests(work_id,intent_revision,input_snapshot_id) WHERE state='pending';
    CREATE TABLE IF NOT EXISTS bot_work_reads (
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), request_id TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id), guard_json TEXT NOT NULL CHECK(json_valid(guard_json)),
      PRIMARY KEY(conversation_id,request_id,work_id)
    );
    CREATE TABLE IF NOT EXISTS work_native_inbox (
      fact_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
      namespace_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      received_at INTEGER NOT NULL, consumed_at INTEGER, consume_error TEXT
    );
    CREATE TABLE IF NOT EXISTS work_native_cursors (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), fact_id TEXT NOT NULL,
      read_failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_native_recovery (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), failures INTEGER NOT NULL DEFAULT 0,
      cycle_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      first_failure_at INTEGER NOT NULL, last_error TEXT NOT NULL, exhausted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS work_projection_streams (
      user_id TEXT PRIMARY KEY, epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS work_projection_events (
      user_id TEXT NOT NULL, sequence INTEGER NOT NULL, work_id TEXT NOT NULL,
      PRIMARY KEY(user_id,sequence)
    );
    CREATE TRIGGER IF NOT EXISTS projection_event_retention AFTER INSERT ON work_projection_events BEGIN
      DELETE FROM work_projection_events
        WHERE user_id=NEW.user_id AND sequence<=NEW.sequence-${WORK_PROJECTION_EVENT_RETENTION};
    END;
  `);
  // Run at startup as well, including when there are no connected readers or new writes.
  // Keep the stream epoch/sequence: pruning must never reuse a tombstone's sequence.
  db.prepare(`DELETE FROM work_projection_events WHERE sequence <= (
    SELECT sequence - ? FROM work_projection_streams WHERE user_id=work_projection_events.user_id
  )`).run(WORK_PROJECTION_EVENT_RETENTION);
  for (const [name, table, operation, workId, userId] of [
    ["work_insert", "works", "INSERT", "NEW.work_id", "NEW.user_id"],
    ["work_update", "works", "UPDATE", "NEW.work_id", "NEW.user_id"],
    ["work_delete", "works", "DELETE", "OLD.work_id", "OLD.user_id"],
    ["notification_update", "work_notifications", "UPDATE", "NEW.work_id", "(SELECT user_id FROM works WHERE work_id=NEW.work_id)"],
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS projection_${name} AFTER ${operation} ON ${table} BEGIN
      INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (${userId});
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=${userId};
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,${workId} FROM work_projection_streams WHERE user_id=${userId};
    END;`);
  }
}
