import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const botInboxId = (userId: string, botId: string): string =>
  `bot-inbox-${createHash("sha256").update(JSON.stringify([userId, botId])).digest("hex")}`;

/** A separate, read-only message destination. Never select whichever chat is live. */
export function ensureBotInbox(db: Database.Database, userId: string, botId: string): string | undefined {
  if (!db.prepare("SELECT 1 FROM bots WHERE user_id=? AND bot_id=?").get(userId, botId)) return;
  const id = botInboxId(userId, botId), now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO bot_conversations(conversation_id,bot_id,user_id,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, botId, userId, now, now, now);
  return id;
}

/** Called inside Work creation: UI/native/Gateway Work without a Bot chat gets
 * an explicit owner inbox. This does not replace Gateway delivery targets. */
export function recordWorkDelivery(db: Database.Database, work: { workId: string; userId: string; ownerBotId: string },
  input: { conversationId?: string; sourceMessageId?: string }): void {
  const source = input.sourceMessageId ? db.prepare(`SELECT c.conversation_id FROM bot_messages m
    JOIN bot_conversations c ON c.conversation_id=m.conversation_id
    JOIN bot_send_receipts r ON r.user_message_id=m.message_id AND r.conversation_id=c.conversation_id AND r.user_id=c.user_id AND r.bot_id=c.bot_id
    WHERE m.message_id=? AND m.role='user' AND c.user_id=?`)
    .get(input.sourceMessageId, work.userId) as { conversation_id: string } | undefined : undefined;
  const explicit = input.conversationId ? db.prepare(`SELECT conversation_id FROM bot_conversations
    WHERE conversation_id=? AND user_id=? AND bot_id=?`).get(input.conversationId, work.userId, work.ownerBotId) as { conversation_id: string } | undefined : undefined;
  const target = source?.conversation_id ?? explicit?.conversation_id ?? ensureBotInbox(db, work.userId, work.ownerBotId);
  if (target) db.prepare(`INSERT OR IGNORE INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at)
    VALUES (?,?,'bot-delivery',?)`).run(work.workId, target, Date.now());
}
