import type Database from "better-sqlite3";

/** Source provenance is independent of the current Work input revision. */
export function ensureBotTurnOriginSchema(db: Database.Database): void {
  const columns = db.pragma("table_info(bot_conversations)") as Array<{ name: string }>;
  if (!columns.some(column => column.name === "ingress_kind"))
    db.exec("ALTER TABLE bot_conversations ADD COLUMN ingress_kind TEXT NOT NULL DEFAULT 'desktop' CHECK(ingress_kind IN ('desktop','gateway'))");
  const personalIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_bot_personal_live'").get() as { sql: string } | undefined;
  if (personalIndex && !personalIndex.sql.includes("ingress_kind")) db.exec("DROP INDEX uq_bot_personal_live");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_personal_live ON bot_conversations(user_id,bot_id)
    WHERE archived_at IS NULL AND team_id IS NULL AND ingress_kind='desktop'`);
  db.exec(`CREATE TABLE IF NOT EXISTS bot_gateway_conversations (
    conversation_id TEXT PRIMARY KEY REFERENCES bot_conversations(conversation_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, bot_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    connection_key TEXT NOT NULL, chat_id TEXT NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('private','shared'))
  );
  CREATE TABLE IF NOT EXISTS bot_turn_origins (
    user_message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK(json_valid(origin_json))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_turn_origins_conversation ON bot_turn_origins(conversation_id);
  CREATE TABLE IF NOT EXISTS bot_gateway_references (
    user_message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
    context_text TEXT NOT NULL
  );
  `);
}
