import type Database from "better-sqlite3";
import { botCallSchema, type BotCallDto } from "../../../shared/bot-conversation";
import { enqueueWorkOp, overlayFindAll, overlayReadOne, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";

type PeerCallRow = { call_id: string; parent_message_id: string; value_json: string };

/** Host-owned exchange records. They are not user messages in the recipient's inbox. */
export class BotPeerCallRepository {
  constructor(private readonly db: Database.Database) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS bot_peer_calls (
      call_id TEXT PRIMARY KEY, parent_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      value_json TEXT NOT NULL CHECK(json_valid(value_json))
    );
    CREATE INDEX IF NOT EXISTS idx_bot_peer_calls_parent ON bot_peer_calls(parent_message_id);
    CREATE TRIGGER IF NOT EXISTS bot_peer_call_insert AFTER INSERT ON bot_peer_calls BEGIN
      UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id=NEW.parent_message_id;
      UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=(SELECT conversation_id FROM bot_messages WHERE message_id=NEW.parent_message_id);
    END;
    CREATE TRIGGER IF NOT EXISTS bot_peer_call_update AFTER UPDATE ON bot_peer_calls BEGIN
      UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id=NEW.parent_message_id;
      UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=(SELECT conversation_id FROM bot_messages WHERE message_id=NEW.parent_message_id);
    END;`);
    }
  }
  get(callId: string): { parentMessageId: string; call: BotCallDto } | undefined {
    const row = overlayReadOne<PeerCallRow>(this.db, "bot_peer_calls", callId, () =>
      this.db.prepare("SELECT call_id,parent_message_id,value_json FROM bot_peer_calls WHERE call_id=?").get(callId) as PeerCallRow | undefined);
    return row && { parentMessageId: row.parent_message_id, call: botCallSchema.parse(JSON.parse(row.value_json)) };
  }
  list(parentMessageId: string): BotCallDto[] {
    const dbRows = this.db.prepare("SELECT call_id,parent_message_id,value_json FROM bot_peer_calls WHERE parent_message_id=? ORDER BY rowid").all(parentMessageId) as PeerCallRow[];
    return overlayFindAll(this.db, "bot_peer_calls", dbRows, r => r.call_id, r => r.parent_message_id === parentMessageId)
      .map(row => botCallSchema.parse(JSON.parse(row.value_json)));
  }
  create(parentMessageId: string, call: BotCallDto): BotCallDto {
    const prior = this.get(call.callId);
    if (prior) {
      if (prior.parentMessageId !== parentMessageId || prior.call.targetBotId !== call.targetBotId || prior.call.requestText !== call.requestText)
        throw new Error("同一次 Bot 沟通不能换目标或正文");
      return prior.call;
    }
    const valueJson = JSON.stringify(botCallSchema.parse(call));
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "bot_peer_calls", call.callId, { call_id: call.callId, parent_message_id: parentMessageId, value_json: valueJson });
      enqueueWorkOp(this.db, { op: "botPeerCallInsert", callId: call.callId, parentMessageId, valueJson });
      return call;
    }
    this.db.prepare("INSERT INTO bot_peer_calls(call_id,parent_message_id,value_json) VALUES (?,?,?)")
      .run(call.callId, parentMessageId, valueJson);
    return call;
  }
  update(callId: string, patch: Partial<Pick<BotCallDto, "status" | "replyText" | "error">>): BotCallDto {
    const row = this.get(callId);
    if (!row) throw new Error("Bot 沟通记录不存在");
    const call = botCallSchema.parse({ ...row.call, ...patch, updatedAt: Date.now() });
    const valueJson = JSON.stringify(call);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "bot_peer_calls", callId, { call_id: callId, parent_message_id: row.parentMessageId, value_json: valueJson });
      enqueueWorkOp(this.db, { op: "botPeerCallUpdate", callId, valueJson });
      return call;
    }
    this.db.prepare("UPDATE bot_peer_calls SET value_json=? WHERE call_id=?").run(valueJson, callId);
    return call;
  }
  unfinished(): Array<{ parentMessageId: string; call: BotCallDto }> {
    const dbRows = this.db.prepare("SELECT call_id,parent_message_id,value_json FROM bot_peer_calls WHERE json_extract(value_json,'$.status') IN ('queued','running')").all() as PeerCallRow[];
    return overlayFindAll(this.db, "bot_peer_calls", dbRows, r => r.call_id, r => {
      const s = (JSON.parse(r.value_json) as { status?: string }).status;
      return s === "queued" || s === "running";
    }).map(row => ({ parentMessageId: row.parent_message_id, call: botCallSchema.parse(JSON.parse(row.value_json)) }));
  }
}
