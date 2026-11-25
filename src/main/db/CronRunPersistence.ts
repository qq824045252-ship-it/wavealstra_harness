import type Database from "better-sqlite3";
import type { CronRunDto, TaskDto } from "../../shared/agent-ipc";

export type CronGeneratedTask = Pick<TaskDto,
  "id" | "title" | "spaceId" | "projectId" | "updatedAt" | "cwd" | "welcomeMode" | "modelId" | "permissionMode" | "expertId">
  & { status: "in_progress" };

type StartRun = {
  kind: "start";
  run: CronRunDto;
  expectedJob: Record<string, unknown>;
  inputJson: string;
  newTask?: CronGeneratedTask;
  requiredTasks: string[];
  requiredProjects: string[];
};

type FinishRun = {
  kind: "finish";
  runId: string;
  finishedAt: number;
  status: "success" | "error" | "skipped";
  error?: string;
  taskId?: string;
  generatedTaskTitle?: string;
  skippedStart?: { jobId: string; startedAt: number; previousLastRunAt?: number; previousUpdatedAt: number };
};

export type CronRunWrite = StartRun | { kind: "record"; run: CronRunDto } | FinishRun;

export function insertCronRun(db: Database.Database, run: CronRunDto): void {
  db.prepare(`INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(run.id, run.jobId, run.startedAt, run.finishedAt ?? null, run.status, run.error ?? null, run.taskId ?? null);
}

function start(db: Database.Database, mutation: StartRun, createTask: (task: CronGeneratedTask) => void): boolean {
  const { run, expectedJob, inputJson, newTask, requiredTasks, requiredProjects } = mutation;
  const existing = db.prepare(`SELECT r.job_id, r.task_id, r.started_at, r.status, i.request_json
    FROM cron_runs r LEFT JOIN cron_run_inputs i ON i.run_id = r.id WHERE r.id = ?`).get(run.id) as
    { job_id: string; task_id: string | null; started_at: number; status: string; request_json: string | null } | undefined;
  if (existing) return existing.job_id === run.jobId && existing.task_id === (run.taskId ?? null) &&
    existing.started_at === run.startedAt && existing.status === "running" && existing.request_json === inputJson;
  const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(run.jobId);
  if (JSON.stringify(job) !== JSON.stringify(expectedJob)) return false;
  const activeTask = db.prepare("SELECT 1 FROM tasks WHERE id = ? AND archived = 0");
  const activeProject = db.prepare("SELECT 1 FROM projects WHERE id = ? AND archived = 0");
  if (requiredTasks.some(id => !activeTask.get(id)) || requiredProjects.some(id => !activeProject.get(id))) return false;
  if (newTask) createTask(newTask);
  insertCronRun(db, run);
  db.prepare("INSERT INTO cron_run_inputs (run_id, request_json) VALUES (?, ?)").run(run.id, inputJson);
  db.prepare("UPDATE cron_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?").run(run.startedAt, run.startedAt, run.jobId);
  return true;
}

function finish(db: Database.Database, mutation: FinishRun): boolean {
  const { runId, finishedAt, status, error, taskId, generatedTaskTitle, skippedStart } = mutation;
  const row = db.prepare("SELECT status, finished_at, error, task_id FROM cron_runs WHERE id = ?").get(runId) as
    { status: string; finished_at: number | null; error: string | null; task_id: string | null } | undefined;
  if (row && row.status !== "running") return row.status === status && row.finished_at === finishedAt &&
    row.error === (error ?? null) && (taskId === undefined || row.task_id === taskId);
  db.prepare(`UPDATE cron_runs SET finished_at = ?, status = ?, error = ?,
    task_id = CASE WHEN ? THEN NULL ELSE COALESCE(?, task_id) END WHERE id = ?`)
    .run(finishedAt, status, error ?? null, skippedStart ? 1 : 0, taskId ?? null, runId);
  if (skippedStart && row) {
    db.prepare("DELETE FROM cron_run_inputs WHERE run_id = ?").run(runId);
    db.prepare(`UPDATE cron_jobs SET last_run_at = ?, updated_at = CASE WHEN updated_at = ? THEN ? ELSE updated_at END
      WHERE id = ? AND last_run_at = ?`).run(skippedStart.previousLastRunAt ?? null, skippedStart.startedAt,
      skippedStart.previousUpdatedAt, skippedStart.jobId, skippedStart.startedAt);
  }
  if (generatedTaskTitle !== undefined && taskId) {
    db.prepare("UPDATE tasks SET title = CASE WHEN ? = '' THEN title ELSE ? END, status = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
      .run(generatedTaskTitle, generatedTaskTitle, status === "success" ? "completed" : "failed", finishedAt, taskId);
  }
  return true;
}

export function writeCronRun(db: Database.Database, mutation: CronRunWrite, createTask: (task: CronGeneratedTask) => void): boolean {
  return db.transaction(() => {
    if (mutation.kind === "start") return start(db, mutation, createTask);
    if (mutation.kind === "finish") return finish(db, mutation);
    if (!db.prepare("SELECT 1 FROM cron_jobs WHERE id = ?").get(mutation.run.jobId)) return false;
    const run = mutation.run;
    const existing = db.prepare("SELECT job_id, started_at, finished_at, status, error, task_id FROM cron_runs WHERE id = ?").get(run.id) as
      { job_id: string; started_at: number; finished_at: number | null; status: string; error: string | null; task_id: string | null } | undefined;
    if (existing) return existing.job_id === run.jobId && existing.started_at === run.startedAt &&
      existing.finished_at === (run.finishedAt ?? null) && existing.status === run.status &&
      existing.error === (run.error ?? null) && existing.task_id === (run.taskId ?? null);
    insertCronRun(db, run);
    return true;
  }).immediate();
}
