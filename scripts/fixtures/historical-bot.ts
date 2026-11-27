import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BotAttachmentDto, BotMessageDto, BotReplySegment } from "../../src/shared/bot-conversation";

type TurnFixture = {
  botId: string;
  requestId: string;
  text: string;
  conversationId?: string;
  teamId?: string;
  attachments?: BotAttachmentDto[];
};

/** Seed records a historical reader would find on disk, without running a Bot. */
export function seedHistoricalBotTurn(db: Database.Database, userId: string, input: TurnFixture) {
  return db.transaction(() => {
    const storedConversationId = db.prepare(
      "SELECT conversation_id FROM bot_conversations WHERE user_id=? AND bot_id=? AND team_id IS ? AND archived_at IS NULL",
    ).pluck().get(userId, input.botId, input.teamId ?? null) as string | undefined;
    const conversationId = input.conversationId ?? storedConversationId ?? randomUUID();
    const now = Date.now();
    const userMessageId = "bot-message-" + randomUUID();
    const assistantMessageId = "bot-message-" + randomUUID();
    db.prepare(
      "INSERT OR IGNORE INTO bot_conversations(conversation_id,bot_id,user_id,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run(conversationId, input.botId, userId, input.teamId ?? null, now, now);
    const message = db.prepare(
      "INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    message.run(userMessageId, conversationId, input.botId, input.requestId, "user", input.text, "completed", now, now);
    message.run(assistantMessageId, conversationId, input.botId, input.requestId, "assistant", "", "queued", now, now);
    db.prepare(
      "INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,assistant_message_id) VALUES (?,?,?,?,?,?,?)",
    ).run(userId, input.botId, input.requestId, "fixture", conversationId, userMessageId, assistantMessageId);
    if (input.attachments?.length) {
      db.prepare("INSERT INTO bot_message_attachments(message_id,attachments_json) VALUES (?,?)")
        .run(userMessageId, JSON.stringify(input.attachments));
    }
    db.prepare("UPDATE bot_conversations SET revision=revision+1,updated_at=? WHERE conversation_id=?").run(now, conversationId);
    return { conversationId, userMessageId, assistantMessageId };
  })();
}

export function setHistoricalBotReply(db: Database.Database, messageId: string, status: BotMessageDto["status"], text: string, segments?: BotReplySegment[]) {
  db.prepare("UPDATE bot_messages SET status=?,text=?,updated_at=? WHERE message_id=?").run(status, text, Date.now(), messageId);
  if (segments) {
    db.prepare("INSERT INTO bot_message_segments(message_id,segments_json) VALUES (?,?)").run(messageId, JSON.stringify(segments));
  }
}
