import type Database from "better-sqlite3";
import { botCallSchema, type BotCallDto } from "../../../shared/bot-conversation";

/** Host-owned exchange records. They are not user messages in the recipient's inbox. */
export class BotPeerCallRepository {
  constructor(private readonly db: Database.Database) {
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
  get(callId: string): { parentMessageId: string; call: BotCallDto } | undefined {
    const row = this.db.prepare("SELECT parent_message_id,value_json FROM bot_peer_calls WHERE call_id=?").get(callId) as { parent_message_id: string; value_json: string } | undefined;
    return row && { parentMessageId: row.parent_message_id, call: botCallSchema.parse(JSON.parse(row.value_json)) };
  }
  list(parentMessageId: string): BotCallDto[] {
    return (this.db.prepare("SELECT value_json FROM bot_peer_calls WHERE parent_message_id=? ORDER BY rowid").all(parentMessageId) as Array<{ value_json: string }>)
      .map(row => botCallSchema.parse(JSON.parse(row.value_json)));
  }
  create(parentMessageId: string, call: BotCallDto): BotCallDto {
    const prior = this.get(call.callId);
    if (prior) {
      if (prior.parentMessageId !== parentMessageId || prior.call.targetBotId !== call.targetBotId || prior.call.requestText !== call.requestText)
        throw new Error("同一次 Bot 沟通不能换目标或正文");
      return prior.call;
    }
    this.db.prepare("INSERT INTO bot_peer_calls(call_id,parent_message_id,value_json) VALUES (?,?,?)")
      .run(call.callId, parentMessageId, JSON.stringify(botCallSchema.parse(call)));
    return call;
  }
  update(callId: string, patch: Partial<Pick<BotCallDto, "status" | "replyText" | "error">>): BotCallDto {
    const row = this.get(callId);
    if (!row) throw new Error("Bot 沟通记录不存在");
    const call = botCallSchema.parse({ ...row.call, ...patch, updatedAt: Date.now() });
    this.db.prepare("UPDATE bot_peer_calls SET value_json=? WHERE call_id=?").run(JSON.stringify(call), callId);
    return call;
  }
  unfinished(): Array<{ parentMessageId: string; call: BotCallDto }> {
    return (this.db.prepare("SELECT call_id FROM bot_peer_calls WHERE json_extract(value_json,'$.status') IN ('queued','running')").all() as Array<{ call_id: string }>)
      .map(row => this.get(row.call_id)!);
  }
}
