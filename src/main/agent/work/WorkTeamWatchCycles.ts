import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import { workAdmissionInFlight, workExecutionInFlight } from "../../../shared/work-effect-policy";
import { isScheduledFollowUp, scheduledFollowUpCurrent } from "./WorkScheduledFollowUp";
import type { WorkService } from "./WorkService";

type Cycle = { work_id: string; inbox_event_id: string; sequence: number; created_at: number };
/** The existing scheduler owns time. This journal only materializes one team
 * assignment per consumed timer event; it never starts a second timer/executor. */
export class WorkTeamWatchCycles {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_team_watch_cycles (
      work_id TEXT NOT NULL, inbox_event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(work_id,sequence))`);
  }
  current(workId: string): Cycle | undefined {
    return this.db.prepare("SELECT * FROM work_team_watch_cycles WHERE work_id=? ORDER BY sequence DESC LIMIT 1").get(workId) as Cycle | undefined;
  }
  eligible(work: WorkDto): boolean {
    const cycle = this.current(work.workId);
    const event = cycle && this.works.repo.getInbox(cycle.inbox_event_id);
    return scheduledFollowUpCurrent(work,event,event?.subscriptionId ? this.works.repo.getSubscription(event.subscriptionId) : undefined);
  }
  pending(workId: string): boolean {
    if (!this.current(workId)) return false;
    const rows = this.db.prepare("SELECT task_id,role,reported_binding_id FROM work_team_executions WHERE work_id=?").all(workId) as Array<{task_id:string;role:string;reported_binding_id:string|null}>;
    const ids = new Set(rows.map(r => r.task_id));
    const bindings = this.works.repo.listBindings(workId).filter(b => ids.has(b.taskId));
    if (bindings.some(b => workExecutionInFlight(b.status))
      || this.works.repo.listAdmissions(workId).some(a => bindings.some(b => b.bindingId === a.bindingId) && workAdmissionInFlight(a))) return true;
    const work = this.works.getWork(workId);
    if (!work || !this.eligible(work)) return false;
    if (this.db.prepare("SELECT 1 FROM work_team_recovery_attempts WHERE work_id=? AND state IN ('pending','claimed','dispatched') LIMIT 1").get(workId)) return true;
    const owner = rows.find(r => r.role === "owner_summary");
    const binding = owner && this.works.repo.bindingForTask(owner.task_id);
    return !binding || !["completed","failed","stopped"].includes(binding.status) || owner?.reported_binding_id !== binding.bindingId;
  }
  enqueue(work: WorkDto, inboxEventId: string | undefined): boolean {
    if (work.mode !== "watch" || !inboxEventId) return true;
    if (this.db.prepare("SELECT 1 FROM work_team_watch_cycles WHERE inbox_event_id=? AND work_id=?").get(inboxEventId,work.workId)) return true;
    const event = this.works.repo.getInbox(inboxEventId);
    if (!isScheduledFollowUp(event) || !scheduledFollowUpCurrent(work,event,event?.subscriptionId ? this.works.repo.getSubscription(event.subscriptionId) : undefined)) return true;
    if (work.lifecycle !== "active" || watchTimeExpired(work,this.now())) return true;
    if (this.pending(work.workId)) return false;
    this.works.transaction(() => {
      this.works.collaboration.assertAuthority();
      const prior = this.current(work.workId);
      this.db.prepare("UPDATE work_team_recovery_attempts SET state='stopped',outcome='superseded',settled_at=? WHERE work_id=? AND state IN ('pending','claimed','dispatched')")
        .run(this.now(),work.workId);
      const rows = this.db.prepare("SELECT * FROM work_team_executions WHERE work_id=? ORDER BY ordinal").all(work.workId) as Array<{task_id:string;input_json:string|null;ordinal:number}>;
      // Preserve immutable assignment envelopes so prior receipts/results retain
      // their member/round attribution after the current projection advances.
      for (const row of rows) {
        if (prior) this.db.prepare("INSERT OR IGNORE INTO work_team_execution_history(task_id,work_id,input_json,execution_json,archived_at) VALUES (?,?,?,?,?)")
          .run(row.task_id,work.workId,row.input_json,JSON.stringify(row),this.now());
        this.db.prepare(`UPDATE work_team_executions SET task_id=?,input_json=NULL,original_input_json=NULL,
          scopes_json='["workspace:read"]',error=NULL,cancelled=0,reported=0,reported_binding_id=NULL WHERE work_id=? AND ordinal=?`)
          .run(`team-execution-${randomUUID()}`,work.workId,row.ordinal);
      }
      this.db.prepare("INSERT INTO work_team_watch_cycles(work_id,inbox_event_id,sequence,created_at) VALUES (?,?,?,?)")
        .run(work.workId,inboxEventId,(prior?.sequence ?? 0)+1,this.now());
      this.works.emitCurrentProjection(work.workId);
    });
    return true;
  }
}
