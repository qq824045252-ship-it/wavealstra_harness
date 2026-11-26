import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";

/** Named schedule persistence operations; transaction ownership stays with WorkService. */
export class WorkSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  discardPendingSchedule(subscriptionId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const rows = overlayFindAll(
        this.db,
        "work_events_inbox",
        this.db.prepare("SELECT * FROM work_events_inbox WHERE subscription_id=? AND event_type='work.tick' AND status IN ('pending','merged','blocked')")
          .all(subscriptionId) as Array<Record<string, unknown>>,
        r => String(r.event_id),
        r => r.subscription_id === subscriptionId && r.event_type === "work.tick" && ["pending", "merged", "blocked"].includes(String(r.status)),
      );
      for (const row of rows) {
        overlaySet(this.db, "work_events_inbox", String(row.event_id), { ...row, status: "skipped", processed_at: now });
      }
      enqueueWorkOp(this.db, { op: "workInboxUpdate", mode: "discardPendingSchedule", subscriptionId, now });
      return;
    }
    this.db.prepare(`UPDATE work_events_inbox SET status='skipped',processed_at=?
      WHERE subscription_id=? AND event_type='work.tick' AND status IN ('pending','merged','blocked')`).run(now, subscriptionId);
  }

  rearmDeadline(work: WorkDto, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const armed = overlayFindAll(
        this.db,
        "work_deadline_instances",
        this.db.prepare("SELECT * FROM work_deadline_instances WHERE work_id=? AND state='armed'").all(work.workId) as Array<Record<string, unknown>>,
        r => `${r.work_id}\0${r.deadline_revision}\0${r.deadline_at}`,
        r => r.work_id === work.workId && r.state === "armed",
      );
      for (const row of armed) {
        const pk = `${row.work_id}\0${row.deadline_revision}\0${row.deadline_at}`;
        overlaySet(this.db, "work_deadline_instances", pk, { ...row, state: "cancelled" });
      }
      if (work.deadlineAt !== undefined) {
        const pk = `${work.workId}\0${work.deadlineRevision}\0${work.deadlineAt}`;
        overlayMutate(this.db, "work_deadline_instances", pk, () => undefined, cur => cur ?? {
          work_id: work.workId, deadline_revision: work.deadlineRevision, deadline_at: work.deadlineAt, state: "armed",
          inbox_event_id: null, followed_at: null, created_at: now,
        });
      }
      enqueueWorkOp(this.db, {
        op: "workDeadlineInstanceWrite", mode: "rearm", workId: work.workId,
        deadlineRevision: work.deadlineAt !== undefined ? work.deadlineRevision : null,
        deadlineAt: work.deadlineAt ?? null, now,
      });
      return;
    }
    this.db.prepare("UPDATE work_deadline_instances SET state='cancelled' WHERE work_id=? AND state='armed'").run(work.workId);
    if (work.deadlineAt !== undefined) this.db.prepare(`INSERT OR IGNORE INTO work_deadline_instances
      (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?,?,?,'armed',?)`)
      .run(work.workId, work.deadlineRevision, work.deadlineAt, now);
  }

  discardRejectedRoutes(subscriptionId: string): void {
    if (requiresWorkRustWrites(this.db)) {
      const rejected = overlayFindAll(
        this.db,
        "work_ingress_routes",
        this.db.prepare("SELECT * FROM work_ingress_routes WHERE subscription_id=? AND state='rejected'").all(subscriptionId) as Array<Record<string, unknown>>,
        r => `${r.source}\0${r.source_event_id}\0${r.subscription_id}`,
        r => r.subscription_id === subscriptionId && r.state === "rejected",
      );
      for (const row of rejected) {
        overlaySet(this.db, "work_ingress_routes", `${row.source}\0${row.source_event_id}\0${row.subscription_id}`, { ...row, state: "__deleted__" });
      }
      enqueueWorkOp(this.db, { op: "workIngressRouteWrite", mode: "deleteRejected", subscriptionId });
      return;
    }
    this.db.prepare("DELETE FROM work_ingress_routes WHERE subscription_id=? AND state='rejected'").run(subscriptionId);
  }
}
