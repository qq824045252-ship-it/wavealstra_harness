import type Database from "better-sqlite3";
import { z } from "zod";
import { botOrganizationSummarySchema, type BotOrganizationSummaryDto } from "../../../shared/bot-organization";

const stored = z.object({ value_json: z.string() });

/** Bounded display label; the full title stays on the Work and the collaboration entry. */
function taskTitleOf(db: Database.Database, userId: string, intentId: string): string | undefined {
  const title = z.object({ title: z.string() }).optional().parse(db.prepare(`SELECT w.title FROM bot_collaboration_organization_links l
    JOIN bot_collaborations c ON c.collaboration_id=l.collaboration_id AND c.user_id=l.user_id
    JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
    WHERE l.user_id=? AND l.intent_id=?`).get(userId, intentId))?.title.trim();
  return title ? title.slice(0, 2000) : undefined;
}

/** Read model only. The organization owner commits facts and links; reading a
 * personal conversation never creates an organization or a bilateral message.
 * The linked task name is joined now, so a Work rename shows without a new receipt. */
export function botOrganizationsForMessage(db: Database.Database, userId: string, messageId: string): BotOrganizationSummaryDto[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_organization_records'").get()) return [];
  const linked = ["bot_collaboration_organization_links", "bot_collaborations", "works"]
    .every(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  return db.prepare(`SELECT r.value_json FROM bot_organization_records r JOIN bot_organization_message_links l
    ON l.organization_id=r.organization_id WHERE r.user_id=? AND l.message_id=? ORDER BY r.created_at,r.organization_id LIMIT 20`)
    .all(userId, messageId).map(row => {
      const summary = botOrganizationSummarySchema.parse(JSON.parse(stored.parse(row).value_json));
      if (!linked || summary.kind !== "intent") return summary;
      const taskTitle = taskTitleOf(db, userId, summary.intentId);
      return taskTitle ? botOrganizationSummarySchema.parse({ ...summary, taskTitle }) : summary;
    });
}
