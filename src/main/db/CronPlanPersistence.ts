import type Database from "better-sqlite3";
import type { CronJobDto } from "../../shared/agent-ipc";

export function encodeCronPlan(job: CronJobDto) {
  return {
    id: job.id, name: job.name, prompt: job.prompt, schedule_type: job.scheduleType,
    schedule_expr: job.scheduleExpr, timezone: job.timezone, space_id: job.spaceId ?? null,
    cwd: job.cwd ?? null, enabled: job.enabled ? 1 : 0, created_at: job.createdAt,
    updated_at: job.updatedAt, last_run_at: job.lastRunAt ?? null, permission_mode: job.permissionMode ?? null,
    welcome_mode: job.welcomeMode ?? null, model_id: job.modelId ?? null, expert_id: job.expertId ?? null,
    skill_ids_json: JSON.stringify(job.skillIds ?? []), connector_ids_json: JSON.stringify(job.connectorIds ?? []),
    effective_from: job.effectiveFrom ?? null, effective_to: job.effectiveTo ?? null, project_id: job.projectId ?? null,
    execution_json: JSON.stringify({
      reminder: job.reminder, sourceTaskId: job.sourceTaskId, target: job.target, maxRuns: job.maxRuns,
      restartPolicy: job.restartPolicy, missedRuns: job.missedRuns, cancelledAt: job.cancelledAt,
    }),
  };
}

export type CronPlanRow = ReturnType<typeof encodeCronPlan>;
export type CronPlanProvenance = {
  source: string;
  origin: { conversationId: number; entryId: number };
  owner?: { taskId?: string; spaceId?: string };
};

export type CronPlanGuard = {
  tasks: string[];
  projects: string[];
  targetTaskId?: string;
  enabledLimitForTask?: string;
  dots?: { spaceId?: string; taskId?: string; ignoreManualHold: boolean };
};

export type CronPlanWrite =
  | { kind: "save"; row: CronPlanRow; expected: Record<string, unknown> | null; guard?: CronPlanGuard;
      provenance?: CronPlanProvenance; manualHold?: "add" | "remove" }
  | { kind: "remove"; id: string; expected: Record<string, unknown> | null };

export function upsertCronPlanRow(db: Database.Database, row: CronPlanRow): void {
  const columns = Object.keys(row);
  const mutableColumns = columns.filter(name => name !== "id" && name !== "created_at");
  db.prepare(`INSERT INTO cron_jobs (${columns.join(", ")}) VALUES (${columns.map(name => `@${name}`).join(", ")})
    ON CONFLICT(id) DO UPDATE SET ${mutableColumns.map(name => `${name}=excluded.${name}`).join(", ")}`).run(row);
}

function guardAllows(db: Database.Database, id: string, guard: CronPlanGuard): boolean {
  const task = db.prepare("SELECT 1 FROM tasks WHERE id=? AND archived=0");
  const project = db.prepare("SELECT 1 FROM projects WHERE id=? AND archived=0");
  if (guard.tasks.some(taskId => !task.get(taskId)) || guard.projects.some(projectId => !project.get(projectId))) return false;
  if (guard.enabledLimitForTask) {
    const count = db.prepare(`SELECT COUNT(*) FROM cron_jobs WHERE enabled=1 AND id<>?
      AND json_extract(execution_json,'$.sourceTaskId')=? AND json_extract(execution_json,'$.reminder.kind') IS NOT 'bot-reminder'`)
      .pluck().get(id, guard.enabledLimitForTask) as number;
    if (count >= 20) return false;
  }
  if (!guard.dots) return true;
  const { spaceId, taskId, ignoreManualHold } = guard.dots;
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name=?");
  if (db.prepare("SELECT 1 FROM dots_schedule_holds WHERE job_id=? AND (holder<>'manual' OR ?=0)").get(id, Number(ignoreManualHold))) return false;
  if (hasTable.get("dots_proactive_pauses") && db.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?)").get(spaceId ?? "")) return false;
  if (taskId && hasTable.get("dots_target_controls") && db.prepare("SELECT 1 FROM dots_target_controls WHERE task_id=?").get(taskId)) return false;
  if (spaceId && !db.prepare("SELECT 1 FROM spaces WHERE id=?").get(spaceId)) return false;
  return !taskId || Boolean(db.prepare(`WITH RECURSIVE parents(id, parent_id, archived) AS (
      SELECT id, parent_id, archived FROM spaces WHERE id=@spaceId
      UNION SELECT s.id, s.parent_id, s.archived FROM spaces s JOIN parents p ON p.parent_id=s.id
    ) SELECT 1 FROM tasks WHERE id=@taskId AND space_id IS @spaceId AND archived=0
      AND NOT EXISTS (SELECT 1 FROM parents WHERE archived<>0)
      AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state WHERE task_id=@taskId AND state='trashed')`)
    .get({ spaceId: spaceId ?? null, taskId }));
}

export function removeCronPlanRow(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM cron_runs WHERE job_id=?").run(id);
  db.prepare("DELETE FROM cron_jobs WHERE id=?").run(id);
}

function sameProvenance(db: Database.Database, id: string, provenance: CronPlanProvenance): boolean {
  if (!db.prepare(`SELECT 1 FROM dots_schedule_origins WHERE job_id=? AND source=? AND conversation=? AND entry=?`)
    .get(id, provenance.source, provenance.origin.conversationId, provenance.origin.entryId)) return false;
  if (!provenance.owner) return !db.prepare("SELECT 1 FROM dots_schedule_scopes WHERE job_id=?").get(id);
  return Boolean(db.prepare("SELECT 1 FROM dots_schedule_scopes WHERE job_id=? AND task_id IS ? AND space_id IS ?")
    .get(id, provenance.owner.taskId ?? null, provenance.owner.spaceId ?? null));
}

export function writeCronPlan(db: Database.Database, mutation: CronPlanWrite): boolean {
  return db.transaction(() => {
    const id = mutation.kind === "save" ? mutation.row.id : mutation.id;
    const current = (db.prepare("SELECT * FROM cron_jobs WHERE id=?").get(id) ?? null) as Record<string, unknown> | null;
    if (mutation.kind === "remove" && !current) return true;
    if (mutation.kind === "save" && current && Object.entries(mutation.row).every(([key, value]) => current[key] === value)) {
      const provenanceReady = !mutation.provenance || sameProvenance(db, id, mutation.provenance);
      const manualHold = mutation.manualHold && db.prepare("SELECT 1 FROM dots_schedule_holds WHERE job_id=? AND holder='manual'").get(id);
      if (provenanceReady && (!mutation.manualHold || Boolean(manualHold) === (mutation.manualHold === "add"))) return true;
    }
    if (JSON.stringify(current) !== JSON.stringify(mutation.expected)) return false;
    if (mutation.kind === "remove") {
      removeCronPlanRow(db, id);
      return true;
    }
    if (mutation.guard && !guardAllows(db, id, mutation.guard)) return false;
    upsertCronPlanRow(db, mutation.row);
    const provenance = mutation.provenance;
    if (provenance) {
      db.prepare("INSERT INTO dots_schedule_origins VALUES(?,?,?,?)").run(id, provenance.source, provenance.origin.conversationId, provenance.origin.entryId);
      if (provenance.owner) db.prepare("INSERT INTO dots_schedule_scopes VALUES(?,?,?)")
        .run(id, provenance.owner.taskId ?? null, provenance.owner.spaceId ?? null);
    }
    if (mutation.manualHold === "add") db.prepare("INSERT OR IGNORE INTO dots_schedule_holds VALUES(?,'manual')").run(id);
    if (mutation.manualHold === "remove") db.prepare("DELETE FROM dots_schedule_holds WHERE job_id=? AND holder='manual'").run(id);
    return true;
  }).immediate();
}
