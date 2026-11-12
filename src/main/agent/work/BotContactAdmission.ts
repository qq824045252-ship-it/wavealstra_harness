import type Database from "better-sqlite3";
import { z } from "zod";
import type { BotMessageReceipt } from "./BotConversationRepository";
import { botDispatchIdentity } from "./BotDispatchIdentity";

type Source = Pick<BotMessageReceipt, "user_id" | "bot_id" | "user_message_id">;
const row = z.object({ organization_id: z.string() }).optional();

/** Read existing organization facts, never invent another registry or user
 * source. A default dispatch reserves one choice across all sending adapters.
 * Initial dispatch also respects an earlier arrange/contact for that source.
 * Pure configuration is deliberately excluded. */
export function botContactIntent(db: Database.Database, source: Source, selection: "dispatch" | "any" = "dispatch"): string | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_organization_records'").get()) return;
  const dispatch = row.parse(db.prepare("SELECT organization_id FROM bot_organization_records WHERE user_id=? AND source_bot_id=? AND organization_id=?")
    .get(source.user_id, source.bot_id, `bot-organization-${botDispatchIdentity(source.bot_id, source.user_message_id)}`));
  // A committed default choice always keeps precedence on replay, including
  // stores containing older organization records from before this guard.
  if (dispatch || selection === "dispatch") return dispatch?.organization_id;
  return row.parse(db.prepare(`SELECT organization_id FROM bot_organization_records
    WHERE user_id=? AND source_bot_id=? AND json_extract(origin_json,'$.user_message_id')=?
      AND json_extract(request_json,'$.action')='arrange'
      AND json_extract(request_json,'$.contact.kind') IN ('ask','delegate')
    ORDER BY created_at,rowid LIMIT 1`).get(source.user_id, source.bot_id, source.user_message_id))?.organization_id;
}

/** Final host-side admission guard: neither an alternate organization intent
 * nor a different tool can send around the existing default choice. */
export function assertBotContactAdmission(db: Database.Database, source: Source, intentId?: string, collaborationId?: string): void {
  const saved = botContactIntent(db, source);
  if (!saved) return;
  if (saved !== intentId) throw new Error(`dispatch_existing_intent: 原请求已保留唯一派送 ${saved}，不得从另一入口新建投递；query/resume 原意图。`);
  if (collaborationId && !db.prepare(`SELECT 1 FROM bot_collaboration_organization_links
    WHERE user_id=? AND intent_id=? AND collaboration_id=?`).get(source.user_id, saved, collaborationId))
    throw new Error("dispatch_existing_intent: 协作与原派送意图不匹配，不创建投递");
}
