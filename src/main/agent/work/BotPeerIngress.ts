import type Database from "better-sqlite3";
import { z } from "zod";
import { botPeerOriginSchema, type BotPeerOrigin } from "../../../shared/bot-peer-origin";

/** Read-only provenance for historical peer messages. */
export class BotPeerIngress {
  constructor(private readonly db: Database.Database) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS bot_peer_inputs (
      user_message_id TEXT PRIMARY KEY, assistant_message_id TEXT NOT NULL UNIQUE,
      origin_json TEXT NOT NULL CHECK(json_valid(origin_json))
    );
    CREATE TABLE IF NOT EXISTS bot_peer_deliveries (
      operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
      text TEXT NOT NULL, target_bot_id TEXT NOT NULL, conversation_id TEXT, request_id TEXT NOT NULL UNIQUE,
      accepted_message_id TEXT, cancelled_at INTEGER, error TEXT,
      journal_message_id TEXT, observed_status TEXT, returned_at INTEGER
    );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_peer_pending ON bot_peer_deliveries(user_id) WHERE accepted_message_id IS NULL AND cancelled_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_bot_peer_journal ON bot_peer_deliveries(journal_message_id);
      CREATE INDEX IF NOT EXISTS idx_bot_peer_collaboration ON bot_peer_deliveries(user_id,json_extract(origin_json,'$.collaborationId'),json_extract(origin_json,'$.kind'));
      CREATE INDEX IF NOT EXISTS idx_bot_peer_assistant ON bot_peer_deliveries(accepted_message_id);
      CREATE INDEX IF NOT EXISTS idx_bot_peer_input_source ON bot_peer_inputs(json_extract(origin_json,'$.sourceConversationId'),json_extract(origin_json,'$.kind'));`);
    }
  }
  origin(messageId: string): BotPeerOrigin | undefined {
    const row = z.object({ origin_json: z.string() }).optional().parse(this.db.prepare(
      "SELECT origin_json FROM bot_peer_inputs WHERE user_message_id=? OR assistant_message_id=?").get(messageId, messageId));
    return row ? botPeerOriginSchema.parse(JSON.parse(row.origin_json)) : undefined;
  }

}
