import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";

/** Named schedule persistence operations; transaction ownership stays with WorkService. */
export class WorkSubscriptionStore {
  constructor(private readonly db: Pick<Database.Database, "prepare">) {}

  discardPendingSchedule(subscriptionId: string, now: number): void {
    this.db.prepare(`UPDATE work_events_inbox SET status='skipped',processed_at=?
      WHERE subscription_id=? AND event_type='work.tick' AND status IN ('pending','merged','blocked')`).run(now, subscriptionId);
  }

  rearmDeadline(work: WorkDto, now: number): void {
    this.db.prepare("UPDATE work_deadline_instances SET state='cancelled' WHERE work_id=? AND state='armed'").run(work.workId);
    if (work.deadlineAt !== undefined) this.db.prepare(`INSERT OR IGNORE INTO work_deadline_instances
      (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?,?,?,'armed',?)`)
      .run(work.workId, work.deadlineRevision, work.deadlineAt, now);
  }

  discardRejectedRoutes(subscriptionId: string): void {
    this.db.prepare("DELETE FROM work_ingress_routes WHERE subscription_id=? AND state='rejected'").run(subscriptionId);
  }
}
