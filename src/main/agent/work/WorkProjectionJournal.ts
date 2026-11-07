import type Database from "better-sqlite3";
import { z } from "zod";
import { workListRequestSchema, type WorkListUpdate } from "../../../shared/bot-conversation";
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
      if (!request.cursor) return { kind: "snapshot", cursor,
        works: this.works.listProjections(userId, { includeClosed: request.includeClosed }) };
      if (request.cursor.epoch !== stream.epoch || request.cursor.scope !== scope || request.cursor.sequence > stream.sequence) {
        return { kind: "resync_required" };
      }
      const rows = this.db.prepare("SELECT sequence,work_id FROM work_projection_events WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT 200")
        .all(userId, request.cursor.sequence).map(row => eventSchema.parse(row));
      if ((rows[0]?.sequence ?? stream.sequence + 1) !== request.cursor.sequence + 1
        || rows.some((row, index) => row.sequence !== request.cursor!.sequence + index + 1)) return { kind: "resync_required" };
      const events = rows.map(row => {
        const projection = this.works.getProjection(row.work_id);
        if (!projection || this.works.getWork(row.work_id)?.userId !== userId) return { kind: "remove" as const, sequence: row.sequence,
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
