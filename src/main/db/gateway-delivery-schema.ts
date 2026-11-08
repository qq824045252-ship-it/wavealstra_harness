import type Database from "better-sqlite3";

/** Auxiliary transport journal, separate from the Agent WAL and Work outbox.
 * Additive materialization leaves existing native task/receipt identities intact. */
export function ensureGatewayDeliveryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_inbox (
      delivery_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','reply_pending','completed','blocked','unknown')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      receipt_mode TEXT NOT NULL CHECK(receipt_mode IN ('pi-durable','none')),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel_id,account_key,chat_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS gateway_inbox_resume ON gateway_inbox(channel_id,account_key,status,created_at,delivery_id);
    CREATE INDEX IF NOT EXISTS gateway_inbox_retention ON gateway_inbox(status,updated_at,delivery_id);
    CREATE TABLE IF NOT EXISTS gateway_outbox (
      delivery_id TEXT PRIMARY KEY REFERENCES gateway_inbox(delivery_id) ON DELETE CASCADE,
      reply_text TEXT NOT NULL,
      reply_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','blocked','failed','unknown')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS gateway_outbox_retry ON gateway_outbox(status,next_attempt_at,delivery_id);
  `);
}
