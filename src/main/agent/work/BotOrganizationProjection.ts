import type Database from "better-sqlite3";
import { z } from "zod";
import { botOrganizationSummarySchema, type BotOrganizationSummaryDto } from "../../../shared/bot-organization";

/** Read model only. The organization owner commits facts and links; reading a
 * personal conversation never creates an organization or a bilateral message. */
export function botOrganizationsForMessage(db: Database.Database, userId: string, messageId: string): BotOrganizationSummaryDto[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_organization_records'").get()) return [];
  return db.prepare(`SELECT r.value_json FROM bot_organization_records r JOIN bot_organization_message_links l
    ON l.organization_id=r.organization_id WHERE r.user_id=? AND l.message_id=? ORDER BY r.created_at,r.organization_id LIMIT 20`)
    .all(userId, messageId).map(row => botOrganizationSummarySchema.parse(JSON.parse(z.object({ value_json: z.string() }).parse(row).value_json)));
}
