import type Database from "better-sqlite3";
import { z } from "zod";
import { workListRequestSchema, type WorkListUpdate } from "../../../shared/bot-conversation";
import type { WorkListQuery } from "./WorkListQuery";
import type { WorkService } from "./WorkService";

const streamSchema = z.object({ epoch: z.string(), sequence: z.number().int().nonnegative() });
const eventSchema = z.object({ sequence: z.number().int().positive(), work_id: z.string() });

/** The SQLite transaction is also the snapshot/watermark boundary. Push is only a wakeup. */
export class WorkProjectionJournal {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {}

  sync(userId: string, input: unknown): WorkListUpdate {
    const request = workListRequestSchema.parse(input);
    return this.db.transaction((): WorkListUpdate => {
      this.db.prepare("INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (?)").run(userId);
      const stream = streamSchema.parse(this.db.prepare("SELECT epoch,sequence FROM work_projection_streams WHERE user_id=?").get(userId));
      const scope = request.includeClosed ? "all" as const : "open" as const;
      const cursor = { ...stream, scope };
      const summaries = this.works.listQuery;
      if (!request.cursor) {
        // The stream is a bounded bootstrap/invalidation feed, never the complete
        // list. Filtered pages and counts come from queryWorks in their own snapshot.
        const ids = this.db.prepare(`SELECT work_id FROM works WHERE user_id=?
          AND NOT EXISTS(SELECT 1 FROM work_record_archive a WHERE a.work_id=works.work_id AND a.deleted_at IS NOT NULL)
          ${request.includeClosed ? "" : "AND lifecycle != 'closed'"}
          ORDER BY updated_at DESC, work_id ASC LIMIT 24`).all(userId) as Array<{ work_id: string }>;
        return { kind: "snapshot", cursor, works: ids.flatMap(row => {
          const summary = summaries.get(userId, row.work_id);
          return summary && !summary.archive?.deletedAt ? [summary] : [];
        }) };
      }
      if (request.cursor.epoch !== stream.epoch || request.cursor.scope !== scope || request.cursor.sequence > stream.sequence) {
        return { kind: "resync_required" };
      }
      const rows = this.db.prepare("SELECT sequence,work_id FROM work_projection_events WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT 200")
        .all(userId, request.cursor.sequence).map(row => eventSchema.parse(row));
      if ((rows[0]?.sequence ?? stream.sequence + 1) !== request.cursor.sequence + 1
        || rows.some((row, index) => row.sequence !== request.cursor!.sequence + index + 1)) return { kind: "resync_required" };
      const current = new Map<string, ReturnType<WorkListQuery["get"]>>();
      const events = rows.map(row => {
        if (!current.has(row.work_id)) current.set(row.work_id, summaries.get(userId, row.work_id));
        const projection = current.get(row.work_id);
        if (!projection || projection.archive?.deletedAt) return { kind: "remove" as const, sequence: row.sequence,
          workId: row.work_id, reason: "removed" as const, stateVersion: 0 };
        if (!request.includeClosed && projection.lifecycle === "closed") return { kind: "remove" as const, sequence: row.sequence,
          workId: row.work_id, reason: "closed" as const, stateVersion: projection.stateVersion };
        return { kind: "upsert" as const, sequence: row.sequence, projection };
      });
      const sequence = rows.at(-1)?.sequence ?? request.cursor.sequence;
      return { kind: "delta", cursor: { ...cursor, sequence }, from: request.cursor.sequence, events, hasMore: sequence < stream.sequence };
    }).immediate();
  }
}
