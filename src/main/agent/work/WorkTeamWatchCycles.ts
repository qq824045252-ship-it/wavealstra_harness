import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";
import { workAdmissionInFlight, workExecutionInFlight } from "../../../shared/work-effect-policy";
import { scheduledFollowUpCurrent } from "./WorkScheduledFollowUp";
import type { WorkService } from "./WorkService";

type Cycle = { work_id: string; inbox_event_id: string; sequence: number; created_at: number };
/** Read-only projection of historical team watch rounds. */
export class WorkTeamWatchCycles {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {
    if (!db.readonly) db.exec(`CREATE TABLE IF NOT EXISTS work_team_watch_cycles (
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
}
