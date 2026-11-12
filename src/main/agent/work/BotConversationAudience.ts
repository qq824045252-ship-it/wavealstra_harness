import type Database from "better-sqlite3";

/** Read the canonical channel audience without creating another origin store. */
export function isSharedBotConversation(db: Database.Database, conversationId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_gateway_conversations'").get()) return false;
  return Boolean(db.prepare("SELECT 1 FROM bot_gateway_conversations WHERE conversation_id=? AND audience='shared'").get(conversationId));
}
