import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { botPeerOriginSchema, type BotPeerOrigin } from "../../../shared/bot-peer-origin";
import type { BotSendReceipt } from "../../../shared/bot-conversation";

export const peerKey = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const deliverySchema = z.object({ operation_id: z.string(), origin_json: z.string(), text: z.string(),
  target_bot_id: z.string(), conversation_id: z.string().nullable(), request_id: z.string(),
  accepted_message_id: z.string().nullable(), cancelled_at: z.number().nullable(), error: z.string().nullable(),
  journal_message_id: z.string().nullable(), observed_status: z.string().nullable(), returned_at: z.number().nullable() });
export type BotPeerDelivery = z.infer<typeof deliverySchema>;

/** Durable outbox and provenance only; BotConversationService owns all execution. */
export class BotPeerIngress {
  constructor(private readonly db: Database.Database) {
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
  origin(messageId: string): BotPeerOrigin | undefined {
    const row = z.object({ origin_json: z.string() }).optional().parse(this.db.prepare(
      "SELECT origin_json FROM bot_peer_inputs WHERE user_message_id=? OR assistant_message_id=?").get(messageId, messageId));
    return row ? botPeerOriginSchema.parse(JSON.parse(row.origin_json)) : undefined;
  }
  record(receipt: BotSendReceipt, origin: BotPeerOrigin): void {
    if (!this.db.inTransaction) throw new Error("协作来源必须与前台受理原子保存");
    const json = JSON.stringify(botPeerOriginSchema.parse(origin));
    const previous = this.origin(receipt.userMessageId);
    if (previous && JSON.stringify(previous) !== json) throw new Error("idempotency_conflict: 协作来源不能改变");
    this.db.prepare("INSERT OR IGNORE INTO bot_peer_inputs VALUES(?,?,?)").run(receipt.userMessageId, receipt.assistantMessageId, json);
  }
  prepare(userId: string, operationId: string, origin: BotPeerOrigin, text: string, targetBotId: string, conversationId?: string, journalMessageId?: string): BotPeerDelivery {
    const json = JSON.stringify(botPeerOriginSchema.parse(origin));
    const previous = this.get(operationId);
    if (previous && (previous.origin_json !== json || previous.text !== text || previous.target_bot_id !== targetBotId
      || previous.conversation_id !== (conversationId ?? null))) throw new Error("idempotency_conflict: 已保存通信不能改变");
    this.db.prepare(`INSERT OR IGNORE INTO bot_peer_deliveries
      (operation_id,user_id,origin_json,text,target_bot_id,conversation_id,request_id,journal_message_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(operationId, userId, json, text, targetBotId, conversationId ?? null, `peer-${peerKey(operationId)}`, journalMessageId ?? null);
    return this.get(operationId)!;
  }
  get(operationId: string): BotPeerDelivery | undefined {
    return deliverySchema.optional().parse(this.db.prepare("SELECT * FROM bot_peer_deliveries WHERE operation_id=?").get(operationId));
  }
  earlier(userId: string, collaborationId: string, operationId: string): BotPeerDelivery | undefined {
    return deliverySchema.optional().parse(this.db.prepare(`SELECT d.* FROM bot_peer_deliveries d WHERE d.user_id=?
      AND json_extract(d.origin_json,'$.collaborationId')=? AND json_extract(d.origin_json,'$.kind')='request'
      AND d.rowid<(SELECT rowid FROM bot_peer_deliveries WHERE operation_id=?) AND d.accepted_message_id IS NULL
      AND d.cancelled_at IS NULL ORDER BY d.rowid LIMIT 1`).get(userId, collaborationId, operationId));
  }
  deliveries(userId: string, collaborationId?: string): BotPeerDelivery[] {
    const rows = collaborationId ? this.db.prepare(`SELECT * FROM bot_peer_deliveries WHERE user_id=?
      AND json_extract(origin_json,'$.collaborationId')=? ORDER BY rowid`).all(userId, collaborationId)
      : this.db.prepare("SELECT * FROM bot_peer_deliveries WHERE user_id=? ORDER BY rowid").all(userId);
    return rows.map(row => deliverySchema.parse(row));
  }
  pending(userId: string): BotPeerDelivery[] {
    return this.db.prepare(`SELECT * FROM bot_peer_deliveries WHERE user_id=? AND accepted_message_id IS NULL AND cancelled_at IS NULL
      ORDER BY rowid`).all(userId).map(row => deliverySchema.parse(row));
  }
  unobserved(userId: string): BotPeerDelivery[] {
    return this.db.prepare(`SELECT d.* FROM bot_peer_deliveries d JOIN bot_messages m ON m.message_id=d.accepted_message_id
      WHERE d.user_id=? AND d.cancelled_at IS NULL AND d.returned_at IS NULL AND (d.observed_status IS NULL OR d.observed_status<>m.status
        OR json_extract(d.origin_json,'$.kind')='return' AND m.status='completed') ORDER BY d.rowid`)
      .all(userId).map(row => deliverySchema.parse(row));
  }
  cancelledRequests(userId: string): BotPeerDelivery[] {
    return this.db.prepare(`SELECT d.* FROM bot_peer_deliveries d JOIN bot_messages m ON m.message_id=d.accepted_message_id
      WHERE d.user_id=? AND d.cancelled_at IS NOT NULL AND m.status IN ('queued','running','unknown') ORDER BY d.rowid`)
      .all(userId).map(row => deliverySchema.parse(row));
  }
  conversation(userId: string, botId: string, collaborationId: string): string {
    const conversationId = `bot-peer-${peerKey(userId, botId, collaborationId)}`, now = Date.now();
    // source_kind is orthogonal to transport. Existing gateway CHECKs and valid
    // data remain intact; the desktop personal-conversation index excludes peers.
    this.db.prepare(`INSERT OR IGNORE INTO bot_conversations
      (conversation_id,bot_id,user_id,created_at,updated_at,source_kind) VALUES(?,?,?,?,?,'peer')`)
      .run(conversationId, botId, userId, now, now);
    return conversationId;
  }
}
