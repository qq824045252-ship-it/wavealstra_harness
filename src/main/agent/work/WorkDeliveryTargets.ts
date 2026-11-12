import { createHash, randomUUID } from "node:crypto";
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

/** Personal work binds its owner identity at creation/delivery, not the UI selection. */
export function ensurePersonalConversation(db: Database.Database, userId: string, botId: string): string | undefined {
  if (!db.prepare("SELECT 1 FROM bots WHERE user_id=? AND bot_id=?").get(userId, botId)) return;
  const prior = db.prepare("SELECT conversation_id FROM bot_conversations WHERE user_id=? AND bot_id=? AND team_id IS NULL AND ingress_kind='desktop' AND archived_at IS NULL")
    .get(userId, botId) as { conversation_id: string } | undefined;
  if (prior) return prior.conversation_id;
  const id = `bot-conversation-${randomUUID()}`, now = Date.now();
  db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, botId, userId, now, now);
  return id;
}

/** Stable team scope survives changes to the executing leader. */
export function ensureTeamConversation(db: Database.Database, userId: string, botId: string, teamId: string): string {
  const prior = db.prepare("SELECT conversation_id FROM bot_conversations WHERE user_id=? AND team_id=? AND archived_at IS NULL")
    .get(userId, teamId) as { conversation_id: string } | undefined;
  if (prior) return prior.conversation_id;
  const id = `bot-conversation-${randomUUID()}`, now = Date.now();
  db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, botId, userId, teamId, now, now);
  return id;
}

/** Called inside Work creation: UI/native/Gateway Work without a Bot chat gets
 * an explicit owner conversation. This does not replace Gateway delivery targets. */
export function recordWorkDelivery(db: Database.Database, work: { workId: string; userId: string; ownerBotId: string },
  input: { conversationId?: string; sourceMessageId?: string }): void {
  const source = input.sourceMessageId ? db.prepare(`SELECT c.conversation_id FROM bot_messages m
    JOIN bot_conversations c ON c.conversation_id=m.conversation_id
    JOIN bot_send_receipts r ON r.user_message_id=m.message_id AND r.conversation_id=c.conversation_id AND r.user_id=c.user_id AND r.bot_id=m.bot_id
    WHERE m.message_id=? AND m.role='user' AND c.user_id=?`)
    .get(input.sourceMessageId, work.userId) as { conversation_id: string } | undefined : undefined;
  const explicit = input.conversationId ? db.prepare(`SELECT conversation_id FROM bot_conversations
    WHERE conversation_id=? AND user_id=? AND (bot_id=? OR team_id IS NOT NULL)`).get(input.conversationId, work.userId, work.ownerBotId) as { conversation_id: string } | undefined : undefined;
  const target = source?.conversation_id ?? explicit?.conversation_id ?? ensurePersonalConversation(db, work.userId, work.ownerBotId);
  if (target) db.prepare(`INSERT OR IGNORE INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at)
    VALUES (?,?,'bot-delivery',?) ON CONFLICT(work_id,conversation_id) DO UPDATE SET channel_type='bot-delivery'`).run(work.workId, target, Date.now());
}
