import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { z } from "zod";
import {
  CronIpc,
  type CronJobDto,
  type CronRunDto,
  type AgentPromptRequest,
  type AgentPromptResult,
  type AgentSubmissionReceipt,
  type TaskHistoryDto,
} from "../../shared/agent-ipc";
import { assertSingleExpertId, normalizeSingleExpertId } from "../../shared/expert-id";
import { parseCronExecution } from "../../shared/cron-execution";
import { DOTS_NO_CHANGE, DOTS_TASK_ID } from "../../shared/dots";
import { resolveDotsPreferences, type DotsSettings } from "../../shared/dots-settings";
import type { AppDatabase } from "../db/AppDatabase";
import { DotsIntentChanged } from "../dots/DotsNativeIntent";
import { computeNextRunAt, validateSchedule, withinEffectiveRange, scheduleTimer, type SegmentedTimer } from "./CronSchedule";

const storedCronInput = z.object({
  taskId: z.string().min(1), text: z.string(), userMessageId: z.string().min(1), assistantMessageId: z.string().min(1),
  displayText: z.string().optional(),
  permissionMode: z.enum(["default", "auto", "readonly"]).optional(), welcomeMode: z.enum(["working", "coding", "general"]).optional(),
  spaceId: z.string().optional(), modelId: z.string().optional(), expertId: z.string().optional(),
  modePresetId: z.string().nullable().optional(), connectorIds: z.array(z.string()).optional(),
  streamingBehavior: z.literal("followUp").optional(),
});
const storedCronRun = z.object({
  request: storedCronInput,
  newTask: z.boolean(),
  job: z.object({ id: z.string(), name: z.string(), projectId: z.string().optional() }),
});
type RunJob = z.infer<typeof storedCronRun>["job"];

export interface CronAgent {
  dotsSubmission?(taskId: string, operation: string): Promise<{ text: string } | undefined>;
  prompt(request: AgentPromptRequest): Promise<AgentPromptResult>;
  waitForSubmission(receipt: AgentSubmissionReceipt): Promise<AgentPromptResult>;
  loadTaskHistory(taskId: string): Promise<TaskHistoryDto>;
  isTaskBusy(taskId: string): boolean;
  getAppSettings(): { defaultModelId?: string | null; dotsSettings?: Partial<DotsSettings> };
  resolveAvailableModelId(id: string): Promise<{ modelId: string; repairedFrom?: string } | undefined>;
  listSkills(): Array<{ id: string; name: string }>;
  listConnectors(): Array<{ id: string; name: string; installedSkillNames?: string[] }>;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function withNextRun(job: CronJobDto): CronJobDto {
  return { ...job, expertId: normalizeSingleExpertId(job.expertId), nextRunAt: computeNextRunAt(job) };
}

function buildExecutionPrompt(
  job: CronJobDto,
  resolveSkillName: (id: string) => string | undefined,
  resolveConnector: (id: string) => { name: string; skillNames: string[] } | undefined,
): string {
  const lines: string[] = [];

  const skillNames = (job.skillIds ?? [])
    .map((id) => resolveSkillName(id) ?? id)
    .filter(Boolean);
  if (skillNames.length > 0) {
    lines.push(`请优先使用以下技能（若已安装且可用）：${skillNames.join("、")}。`);
  }

  const connectorNotes: string[] = [];
  for (const id of job.connectorIds ?? []) {
    const c = resolveConnector(id);
    if (!c) continue;
    if (c.skillNames.length > 0) {
      connectorNotes.push(`${c.name}（技能：${c.skillNames.join("、")}）`);
    } else {
      connectorNotes.push(c.name);
    }
  }
  if (connectorNotes.length > 0) {
    lines.push(
      `已授权连接器（任务中可免确认使用其能力）：${connectorNotes.join("；")}。`,
    );
  }

  if (lines.length === 0) return job.prompt;
  return `【自动化任务配置】\n${lines.join("\n")}\n\n${job.prompt}`;
}

export class CronService {
  private readonly timers = new Map<string, SegmentedTimer>();
  private readonly runningJobs = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private stopped = false;
  private started = false;
  private dotsSuspended = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: CronAgent,
    /** 项目 run 摘要钩子（可选注入）：project-bound job 完成/失败时调用一次；只传摘要+stable ref，不传敏感输出 */
    private readonly projectRunSink?: (projectId: string, summary: { runId: string; jobName: string; status: "success" | "failed"; error?: string }) => void,
    private readonly runNotificationSink?: (summary: {
      runId: string;
      jobId: string;
      jobName: string;
      taskId: string;
      projectId?: string;
      status: "success" | "failed";
      error?: string;
      message?: string;
    }) => void,
    private readonly weeklyMaintenance?: {start(): void; stopSchedule(): void},
    private readonly dotsReminderSink?: (event: { jobId: string; jobName: string; occurrence: number }) => void,
  ) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS cron_run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES cron_runs(id) ON DELETE CASCADE, request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_schedule_origins(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        source TEXT NOT NULL, conversation INTEGER NOT NULL, entry INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_schedule_scopes(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        task_id TEXT, space_id TEXT);
      CREATE TABLE IF NOT EXISTS dots_schedule_holds(job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        holder TEXT NOT NULL, PRIMARY KEY(job_id,holder));
      CREATE TABLE IF NOT EXISTS dots_schedule_notices(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        occurrence INTEGER NOT NULL)`);
    if (db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_proactive_pauses'").get()) {
      db.connection.exec(`INSERT OR IGNORE INTO dots_schedule_holds
        SELECT j.id, 'proactive:' || p.scope FROM dots_proactive_pauses p
        JOIN json_each(p.timer_ids) x JOIN cron_jobs j ON j.id=x.value
        WHERE j.enabled=0 AND json_extract(j.execution_json,'$.cancelledAt') IS NULL
          AND NOT EXISTS (SELECT 1 FROM dots_schedule_holds h WHERE h.job_id=j.id)`);
    }
    try {
      db.connection.prepare(`UPDATE cron_run_inputs
        SET request_json = json_set(request_json, '$.request.welcomeMode', 'general')
        WHERE json_valid(request_json) AND json_extract(request_json, '$.request.welcomeMode') = 'bot'`).run();
    } catch (error) {
      console.warn("[Cron] legacy welcomeMode migration skipped", error);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.dotsSuspended = false;
    this.weeklyMaintenance?.start();
    const jobs = this.db.listCronJobs();
    for (const job of jobs) {
      if (job.sourceTaskId === DOTS_TASK_ID && job.restartPolicy === "pause" && !job.reminder && job.cancelledAt === undefined)
        this.setUserEnabled(job.id, false);
    }
    for (const run of this.db.listRunningCronRuns()) {
      const job = this.db.getCronJob(run.jobId);
      if (job?.reminder || job && !job.cancelledAt && this.dotsPolicy(job) !== "continue") continue;
      this.runningJobs.add(run.jobId);
      void this.resumeRun(run);
    }
    for (const job of jobs) {
      if (!job.enabled || job.reminder || job.sourceTaskId === DOTS_TASK_ID && job.restartPolicy === "pause") continue;
      const unavailable = this.unavailableReason(job);
      if (unavailable || job.restartPolicy === "pause") {
        this.db.setCronEnabled(job.id, false);
        console.info(`[CronService] disabled project job ${job.id}: ${unavailable}`);
        continue;
      }
      try {
        validateSchedule(job);
        if (job.missedRuns !== "coalesce" || !this.runningJobs.has(job.id)) this.arm(job, true);
      }
      catch (error) {
        this.setEnabled(job.id, false);
        console.warn("[CronService] invalid persisted schedule", job.id, error);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.weeklyMaintenance?.stopSchedule();
    this.started = false;
    for (const id of this.revisions.keys()) this.disarm(id);
  }

  suspendDotsTimers(): void {
    if (!this.started) return;
    this.dotsSuspended = true;
    for (const job of this.listForTask(DOTS_TASK_ID)) this.disarm(job.id);
  }

  resumeDotsTimers(): void {
    if (!this.started || !this.dotsSuspended) return;
    this.dotsSuspended = false;
    for (const job of this.listForTask(DOTS_TASK_ID)) {
      if (job.enabled && !this.runningJobs.has(job.id)) this.arm(job, true);
    }
  }

  refreshDotsPolicy(): void {
    if (!this.started) return;
    for (const run of this.db.listRunningCronRuns()) {
      const job = this.db.getCronJob(run.jobId);
      if (job?.sourceTaskId !== DOTS_TASK_ID || this.runningJobs.has(job.id)) continue;
      if (job.cancelledAt === undefined && this.dotsPolicy(job) !== "continue") continue;
      this.runningJobs.add(job.id);
      void this.resumeRun(run);
    }
    for (const job of this.listForTask(DOTS_TASK_ID)) {
      if (this.runningJobs.has(job.id)) continue;
      if (job.enabled) this.arm(job, true);
      else this.disarm(job.id);
    }
  }

  list(): CronJobDto[] {
    return this.db.listCronJobs().map(job => this.withNext(job));
  }

  async readJobs(): Promise<CronJobDto[]> {
    return (await this.db.readCronJobs()).map(job => this.withNext(job));
  }

  listRuns(limit = 50): Promise<CronRunDto[]> {
    return this.db.readCronRuns(limit);
  }

  listForTask(taskId: string): CronJobDto[] {
    return this.list().filter(job => job.sourceTaskId === taskId);
  }

  private scheduleOwner(jobId: string) {
    const owner = this.db.connection.prepare("SELECT task_id AS taskId, space_id AS spaceId FROM dots_schedule_scopes WHERE job_id=?")
      .get(jobId) as { taskId?: string; spaceId?: string } | undefined;
    if (owner || !this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_delegations'").get()) return owner;
    // Older schedules only stored the original message. Link it only when that message has one distinct target.
    return this.db.connection.prepare(`SELECT MIN(d.task_id) AS taskId, MIN(d.space_id) AS spaceId FROM dots_schedule_origins o
      JOIN dots_delegations d ON d.source_message_id=o.source WHERE o.job_id=?
      HAVING COUNT(DISTINCT d.task_id)=1 AND COUNT(DISTINCT COALESCE(d.space_id,''))=1`)
      .get(jobId) as { taskId?: string; spaceId?: string } | undefined;
  }

  inDotsScope(jobId: string, scope: { taskId?: string; spaceId?: string }) {
    const owner = this.scheduleOwner(jobId);
    return !!owner && (!scope.taskId || owner.taskId === scope.taskId) && (!scope.spaceId || owner.spaceId === scope.spaceId);
  }

  dotsScheduleOwnerTask(jobId: string): string | undefined {
    return this.scheduleOwner(jobId)?.taskId ?? undefined;
  }

  dotsScheduleVisible(jobId: string): boolean {
    const scope = resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).spaceIds;
    const spaceId = this.scheduleOwner(jobId)?.spaceId;
    return scope === null || Boolean(spaceId && scope.includes(spaceId));
  }

  private dotsPolicy(job: CronJobDto): DotsSettings["followupMode"] {
    if (job.sourceTaskId !== DOTS_TASK_ID) return "continue";
    return this.dotsScheduleVisible(job.id) ? resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).followupMode : "paused";
  }

  private dotsFollowupPaused(taskId?: string, jobId?: string, spaceId?: string): boolean {
    if (taskId !== DOTS_TASK_ID) return false;
    const owner = jobId ? this.scheduleOwner(jobId) : undefined;
    if (jobId && this.db.connection.prepare("SELECT 1 FROM dots_schedule_holds WHERE job_id=?").get(jobId)) return true;
    if (owner?.taskId && this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_target_controls'").get()
      && this.db.connection.prepare("SELECT 1 FROM dots_target_controls WHERE task_id=?").get(owner.taskId)) return true;
    return !!this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_proactive_pauses'").get() &&
      !!this.db.connection.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?)").get(spaceId ?? owner?.spaceId ?? "");
  }

  holdDotsSchedule(id: string, holder: string, pause: boolean) {
    return this.db.connection.transaction(() => {
      const job = this.requireTaskJob(DOTS_TASK_ID, id);
      const holds = this.db.connection.prepare("SELECT 1 FROM dots_schedule_holds WHERE job_id=?");
      if (pause && !job.cancelledAt && (job.enabled || holds.get(id))) {
        this.db.connection.prepare("INSERT OR IGNORE INTO dots_schedule_holds VALUES(?,?)").run(id, holder);
        if (job.enabled) this.setEnabled(id, false);
      } else if (!pause) {
        const changed = this.db.connection.prepare("DELETE FROM dots_schedule_holds WHERE job_id=? AND holder=?").run(id, holder).changes;
        if (changed && !job.cancelledAt && (job.maxRuns === undefined || (job.runCount ?? 0) < job.maxRuns)
          && !this.unavailableReason(job) && !this.dotsFollowupPaused(DOTS_TASK_ID, id)) this.setEnabled(id, true);
      }
      return this.getForTask(DOTS_TASK_ID,id).status;
    })();
  }

  assertDotsInputCurrent(source: string): void {
    if (!source.startsWith("cron-") || !source.endsWith("-input")) return;
    const run = this.db.connection.prepare("SELECT job_id FROM cron_runs WHERE id=? AND task_id=?")
      .get(source.slice("cron-".length, -"-input".length), DOTS_TASK_ID) as { job_id: string } | undefined;
    const job = run && this.db.getCronJob(run.job_id);
    if (!job || job.sourceTaskId !== DOTS_TASK_ID || job.cancelledAt !== undefined || this.unavailableReason(job) || this.dotsPolicy(job) !== "continue"
      || this.dotsSuspended || this.dotsFollowupPaused(job.sourceTaskId, job.id)) {
      throw new DotsIntentChanged("原定时跟进已暂停、取消或不可用");
    }
  }

  async runsForTask(taskId: string, limit = 50, allowed = (_jobId: string) => true): Promise<CronRunDto[]> {
    const jobs = await this.db.readCronJobs();
    const ids = jobs.filter(job => job.sourceTaskId === taskId && allowed(job.id)).map(job => job.id);
    return (await this.db.readCronRuns(Math.max(1, Math.min(200, limit)), ids)).filter(run => allowed(run.jobId));
  }

  private requireTaskJob(taskId: string, id: string): CronJobDto {
    const job = this.db.getCronJob(id);
    if (!job || job.sourceTaskId !== taskId || job.reminder) throw new Error("Automation does not belong to the current task");
    return job;
  }

  getForTask(taskId: string, id: string) {
    const saved = this.requireTaskJob(taskId, id);
    const job = this.withNext(saved);
    const now = Date.now();
    const unavailable = this.unavailableReason(saved);
    const reason = saved.cancelledAt !== undefined ? "cancelled"
      : unavailable ? "unavailable"
      : saved.maxRuns !== undefined && (saved.runCount ?? 0) >= saved.maxRuns ? "max_runs_reached"
      : saved.effectiveTo !== undefined && saved.effectiveTo <= now ? "expired"
      : saved.scheduleType === "at" && Date.parse(saved.scheduleExpr) <= now ? "scheduled_time_passed"
      : !saved.enabled ? "paused"
      : this.stopped ? "scheduler_stopped"
      : job.nextRunAt === undefined ? "no_future_occurrence" : undefined;
    return {
      job: reason ? { ...job, nextRunAt: undefined } : job,
      status: reason ?? "scheduled", ...(unavailable && reason === "unavailable" ? { detail: unavailable } : {}),
      hostMustBeRunning: true, missedRuns: saved.missedRuns ?? "skip",
      activeRun: this.db.listCronJobRuns(id, 1, undefined, "running")[0] ?? null,
      latestRun: this.db.listCronJobRuns(id, 1)[0] ?? null,
    };
  }

  async runPageForTask(taskId: string, id: string, limit = 25, cursor?: string, allowed = (_jobId: string) => true) {
    this.requireTaskJob(taskId, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid run page size");
    const schema = z.tuple([z.literal(id), z.number().int().nonnegative(), z.string().min(1).max(256)]);
    let before: { startedAt: number; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
        const [, startedAt, runId] = schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        before = { startedAt, id: runId };
      } catch { throw new Error("Invalid automation run cursor"); }
    }
    const rows = await this.db.readCronJobRuns(id, limit + 1, before);
    this.requireTaskJob(taskId, id);
    if (!allowed(id)) throw new Error("计划不在 Dots 已授权的空间内");
    const runs = rows.slice(0, limit);
    const last = runs.at(-1);
    return {
      id, runs,
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([id, last.startedAt, last.id]), "utf8").toString("base64url") : null,
    };
  }

  createForTask(taskId: string, cwd: string, input: Pick<CronJobDto,
    "name" | "prompt" | "scheduleType" | "scheduleExpr" | "timezone" | "effectiveTo" | "maxRuns" | "restartPolicy" | "missedRuns"
  > & { target: "current-task" | "new-task" }, operation?: string,
    provenance?: { source: string; origin: import("../../shared/dots").DotsReplyOrigin; owner?: {taskId?: string; spaceId?: string} }): CronJobDto {
    const id = operation ? "cron-request-" + operation : randomUUID();
    const existing = operation ? this.db.getCronJob(id) : undefined;
    if (existing) {
      if (existing.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
      if (taskId === DOTS_TASK_ID && !this.dotsScheduleVisible(id)) throw new Error("计划不在 Dots 已授权的空间内");
      return this.withNext(existing);
    }
    const task = this.db.getTask(taskId);
    const spaces = taskId === DOTS_TASK_ID ? resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).spaceIds : null;
    if (spaces && (!provenance?.owner?.spaceId || !spaces.includes(provenance.owner.spaceId)))
      throw new Error("请为定时跟进指定 Dots 已授权的任务或空间");
    if (this.dotsFollowupPaused(taskId, undefined, provenance?.owner?.spaceId)) throw new Error("Dots 主动跟进已暂停，恢复后可创建计划");
    if (!task || task.archived) throw new Error("来源任务不存在或已归档");
    if (this.listForTask(taskId).filter(job => job.enabled).length >= 20) throw new Error("每个任务最多启用 20 个计划");
    const create = () => this.upsert({
      ...input, id, sourceTaskId: taskId,
      target: input.target === "current-task" ? { kind: "task", taskId } : { kind: "new-task" },
      enabled: true, createdAt: Date.now(), updatedAt: Date.now(), cwd,
      permissionMode: task.permissionMode ?? "default", welcomeMode: task.welcomeMode,
      projectId: task.projectId ?? undefined, spaceId: task.spaceId ?? undefined,
      modelId: task.modelId, expertId: task.expertId,
    });
    if (taskId !== DOTS_TASK_ID || !provenance) return create();
    return this.db.connection.transaction(() => {
      const job = create();
      this.db.connection.prepare("INSERT INTO dots_schedule_origins VALUES(?,?,?,?)")
        .run(job.id, provenance.source, provenance.origin.conversationId, provenance.origin.entryId);
      if (provenance.owner) this.db.connection.prepare("INSERT INTO dots_schedule_scopes VALUES(?,?,?)")
        .run(job.id, provenance.owner.taskId ?? null, provenance.owner.spaceId ?? null);
      if (job.enabled && this.started) this.arm(job, true);
      return job;
    })();
  }

  updateForTask(taskId: string, id: string, patch: Partial<Pick<CronJobDto,
    "name" | "prompt" | "scheduleType" | "scheduleExpr" | "timezone" | "effectiveTo" | "maxRuns" | "restartPolicy" | "missedRuns"
  >>): CronJobDto {
    const job = this.db.getCronJob(id);
    if (!job || job.sourceTaskId !== taskId || job.reminder) throw new Error("计划不属于当前任务");
    // Whitelist mutable configuration; never replace identity, execution history or authority.
    const next = { ...job };
    for (const key of ["name", "prompt", "scheduleType", "scheduleExpr", "timezone", "effectiveTo", "maxRuns", "restartPolicy", "missedRuns"] as const) {
      if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
    }
    if (!next.name.trim() || !next.prompt.trim()) throw new Error("name and prompt must not be blank");
    new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format();
    if (JSON.stringify(next) === JSON.stringify(job)) return this.withNext(job);
    const scheduleChanged = (["scheduleType", "scheduleExpr", "timezone", "effectiveTo", "maxRuns"] as const)
      .some(key => next[key] !== job[key]);
    return this.saveJob(next, !scheduleChanged);
  }

  changeForTask(taskId: string, id: string, action: "pause" | "resume" | "cancel"): void {
    const job = this.db.getCronJob(id);
    if (!job || job.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
    if (action !== "cancel") {
      this.setUserEnabled(id, action === "resume");
      return;
    }
    if (job.cancelledAt !== undefined) return;
    const now = Date.now();
    const cancelled = { ...job, enabled: false, cancelledAt: now, updatedAt: now };
    this.db.upsertCronJob(cancelled);
    this.disarm(id);
    broadcast(CronIpc.event, { type: "upsert", job: this.withNext(cancelled) });
  }

  upsert(job: CronJobDto): CronJobDto {
    return this.saveJob(job);
  }

  private saveJob(job: CronJobDto, preserveTimer = false): CronJobDto {
    assertSingleExpertId(job.expertId);
    validateSchedule(job);
    parseCronExecution({ reminder: job.reminder, sourceTaskId: job.sourceTaskId, target: job.target, maxRuns: job.maxRuns, restartPolicy: job.restartPolicy, missedRuns: job.missedRuns, cancelledAt: job.cancelledAt });
    if (job.missedRuns === "coalesce" && (job.sourceTaskId !== DOTS_TASK_ID || job.target?.kind !== "task" || job.target.taskId !== DOTS_TASK_ID))
      throw new Error("离线补办仅支持回到 Dots 的计划");
    const now = Date.now();
    const existing = this.db.getCronJob(job.id);
    if (job.enabled && !existing?.enabled && this.dotsFollowupPaused(job.sourceTaskId, job.id)) throw new Error("Dots 主动跟进已暂停");
    if ((existing?.cancelledAt !== undefined || job.cancelledAt !== undefined) && job.enabled) throw new Error("Cancelled automation cannot be enabled");
    const next: CronJobDto = {
      ...job,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      projectId: job.projectId ?? existing?.projectId,
      cancelledAt: existing?.cancelledAt ?? job.cancelledAt,
    };
    const unavailable = this.unavailableReason(next);
    if (unavailable) throw new Error(unavailable);
    delete next.nextRunAt;
    delete next.runCount;
    this.db.upsertCronJob(next);
    if (!preserveTimer) {
      this.disarm(next.id);
      if (next.enabled) this.arm(this.db.getCronJob(next.id) ?? next);
    }
    const enriched = this.withNext(this.db.getCronJob(next.id) ?? next);
    broadcast(CronIpc.event, { type: "upsert", job: enriched });
    return enriched;
  }

  setEnabled(id: string, enabled: boolean, reminderState?: "cancelled"): void {
    const job = this.db.getCronJob(id);
    if (!job) return;
    if (enabled) {
      if (this.dotsFollowupPaused(job.sourceTaskId, job.id)) throw new Error("Dots 主动跟进已暂停");
      if (job.cancelledAt !== undefined) throw new Error("Cancelled automation cannot be resumed");
      const unavailable = this.unavailableReason(job);
      if (unavailable) throw new Error(unavailable);
      validateSchedule(job);
    }
    if (job.reminder) this.db.upsertCronJob({ ...job, enabled, updatedAt: Date.now(), reminder: { ...job.reminder, state: enabled ? "scheduled" : reminderState ?? "paused" } });
    else this.db.setCronEnabled(id, enabled);
    this.disarm(id);
    if (enabled) this.arm({ ...job, enabled: true });
    broadcast(CronIpc.event, { type: "upsert", job: this.withNext(this.db.getCronJob(id) ?? { ...job, enabled }) });
  }

  setUserEnabled(id: string, enabled: boolean): void {
    const job = this.db.getCronJob(id);
    if (job?.sourceTaskId !== DOTS_TASK_ID || job.cancelledAt !== undefined) {
      this.setEnabled(id, enabled);
      return;
    }
    this.db.connection.transaction(() => {
      if (enabled) {
        this.db.connection.prepare("DELETE FROM dots_schedule_holds WHERE job_id=? AND holder='manual'").run(id);
        this.setEnabled(id, true);
      } else {
        this.db.connection.prepare("INSERT OR IGNORE INTO dots_schedule_holds VALUES(?,'manual')").run(id);
        this.setEnabled(id, false);
      }
    })();
  }

  snoozeReminder(_id: string, _dueAt: number): CronJobDto {
    throw new Error("Bot 提醒功能已移除");
  }

  remove(id: string): void {
    this.disarm(id);
    this.db.removeCronJob(id);
    broadcast(CronIpc.event, { type: "remove", id });
  }

  /** 归档项目会暂停全部自动化；恢复项目时不自动恢复，避免后台任务意外重启。 */
  disableProject(projectId: string): void {
    for (const job of this.db.listCronJobs().filter((item) => item.projectId === projectId)) {
      if (!job.enabled) continue;
      this.db.setCronEnabled(job.id, false);
      this.disarm(job.id);
      broadcast(CronIpc.event, { type: "upsert", job: withNextRun({ ...job, enabled: false }) });
    }
  }

  disableTask(taskId: string): void {
    for (const job of this.db.listCronJobs()) {
      if (job.sourceTaskId === taskId || (job.target?.kind === "task" && job.target.taskId === taskId)) this.setEnabled(job.id, false);
    }
  }

  /** 项目永久删除时同步删除所属 job（run history 由数据库外键级联）。 */
  removeProject(projectId: string): void {
    for (const job of this.db.listCronJobs().filter((item) => item.projectId === projectId)) {
      this.remove(job.id);
    }
  }

  /**
   * 测试运行：立即返回，在后台执行。
   * 不同 job 可并行；正式调度时间不受影响。
   */
  async runNow(id: string): Promise<void> {
    const job = this.db.getCronJob(id);
    if (!job) throw new Error(`cron job not found: ${id}`);
    if (job.cancelledAt !== undefined) throw new Error("Cancelled automation cannot be run");
    const unavailable = this.unavailableReason(job);
    if (unavailable) throw new Error(unavailable);
    void this.execute(job, { force: true }).catch((err) => {
      console.error("[CronService] runNow failed", id, err);
    });
  }

  private arm(job: CronJobDto, restoring = false): void {
    this.disarm(job.id);
    const policy = this.dotsPolicy(job);
    if (this.stopped || job.reminder || policy === "paused" || (this.dotsSuspended && job.sourceTaskId === DOTS_TASK_ID)) return;
    const now = Date.now();
    let nextRun = computeNextRunAt(job, now);
    let occurrence = nextRun;
    if (restoring && job.sourceTaskId === DOTS_TASK_ID && job.missedRuns === "coalesce" && withinEffectiveRange(job, now) === "ok") {
      const since = Math.max(job.createdAt, job.updatedAt, job.lastRunAt ?? 0);
      const missed = computeNextRunAt(job, since);
      if (missed !== undefined && missed <= now) { nextRun = now; occurrence = missed; }
    }
    if (nextRun === undefined) {
      if (policy !== "notify") this.setEnabled(job.id, false);
      return;
    }
    const timer = scheduleTimer(nextRun, () => {
      if (this.timers.get(job.id) !== timer) return;
      this.timers.delete(job.id);
      void this.execute(job, { occurrence }).catch((error) => console.error("[CronService] timer failed", job.id, error));
    });
    this.timers.set(job.id, timer);
  }

  private disarm(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    const t = this.timers.get(id);
    if (t) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
      this.timers.delete(id);
    }
  }

  private async execute(job: CronJobDto, opts?: { force?: boolean; occurrence?: number }): Promise<void> {
    if (this.stopped || this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id);
    const revision = this.revisions.get(job.id);
    let run: CronRunDto | undefined;
    let latest = this.db.getCronJob(job.id);
    let newTask = false;
    try {
      if (!latest || (!latest.enabled && !opts?.force)) return;
      latest = { ...latest, expertId: normalizeSingleExpertId(latest.expertId) };
      const policy = this.dotsPolicy(latest);
      if (policy !== "continue") {
        if (policy === "notify" && opts?.occurrence !== undefined && !this.dotsFollowupPaused(latest.sourceTaskId, latest.id)
          && !this.unavailableReason(latest)) {
          const event = {jobId:latest.id,jobName:latest.name,occurrence:opts.occurrence};
          this.db.connection.transaction(() => {
            const written = this.db.connection.prepare(`INSERT INTO dots_schedule_notices VALUES(?,?) ON CONFLICT(job_id)
              DO UPDATE SET occurrence=excluded.occurrence WHERE occurrence<excluded.occurrence`).run(event.jobId,event.occurrence);
            if (written.changes) this.dotsReminderSink?.(event);
          })();
        }
        return;
      }
      const unavailable = this.unavailableReason(latest);
      if (unavailable) {
        await this.recordSkipped(latest, unavailable);
        this.setEnabled(job.id, false);
        return;
      }
      if ((latest.maxRuns != null && (latest.runCount ?? 0) >= latest.maxRuns) ||
        withinEffectiveRange(latest) === "after") {
        this.setEnabled(job.id, false);
        return;
      }
      if (!opts?.force && withinEffectiveRange(latest) === "before") return;

      const targetId = latest.target?.kind === "task" ? latest.target.taskId : undefined;
      // 当前任务由 AgentService 读取自己的模型与上下文，不用计划的快照覆盖。
      const requestedModelId = targetId ? undefined : latest.modelId?.trim() || this.agent.getAppSettings().defaultModelId || undefined;
      const resolved = requestedModelId ? await this.agent.resolveAvailableModelId(requestedModelId) : undefined;
      if (this.stopped || this.revisions.get(job.id) !== revision) return;
      const persisted = this.db.getCronJob(job.id);
      if (!persisted || (!persisted.enabled && !opts?.force) || withinEffectiveRange(persisted) === "after") return;
      // Content-only edits keep the pending timer/revision; use the current
      // configuration after asynchronous preparation, before committing input.
      latest = { ...persisted, expertId: normalizeSingleExpertId(persisted.expertId) };
      if (this.dotsPolicy(latest) !== "continue") return;
      const currentUnavailable = this.unavailableReason(persisted);
      if (currentUnavailable) {
        await this.recordSkipped(persisted, currentUnavailable);
        this.setEnabled(job.id, false);
        return;
      }
      const target = targetId ? this.db.getTask(targetId) : undefined;
      if (this.dotsFollowupPaused(latest.sourceTaskId, job.id)) return;
      const queueInDots = targetId === DOTS_TASK_ID && latest.sourceTaskId === DOTS_TASK_ID && latest.missedRuns === "coalesce";
      if (targetId && !queueInDots && this.agent.isTaskBusy(targetId)) {
        await this.recordSkipped(persisted, "目标任务正忙，已跳过，未排队");
        return;
      }
      const taskId = targetId ?? `cron-${latest.id}-${randomUUID()}`;
      newTask = !targetId;
      const task = target ?? {
        id: taskId, title: latest.name, spaceId: latest.spaceId ?? null, projectId: latest.projectId,
        status: "in_progress", updatedAt: Date.now(), cwd: latest.cwd,
        modelId: resolved?.modelId ?? requestedModelId, permissionMode: latest.permissionMode ?? "auto",
        expertId: latest.expertId, welcomeMode: latest.welcomeMode ?? "working",
      };
      if (newTask) this.db.upsertTask(task);
      run = { id: randomUUID(), jobId: job.id, taskId, startedAt: Date.now(), status: "running" };
      const request: AgentPromptRequest = {
        taskId, text: this.composePrompt(latest),
        ...(latest.sourceTaskId === DOTS_TASK_ID && { displayText: latest.prompt }),
        permissionMode: task.permissionMode ?? "default",
        welcomeMode: task.welcomeMode, spaceId: task.spaceId ?? undefined,
        modelId: task.modelId, expertId: task.expertId, modePresetId: target?.modePresetId,
        connectorIds: target ? undefined : latest.connectorIds,
        streamingBehavior: queueInDots ? "followUp" : undefined,
        assistantMessageId: `cron-${run.id}-assistant`, userMessageId: `cron-${run.id}-input`,
      };
      const pendingRun = run;
      this.db.connection.transaction(() => {
        this.db.insertCronRun(pendingRun);
        this.db.touchCronLastRun(job.id);
        this.db.connection.prepare("INSERT INTO cron_run_inputs VALUES (?, ?)").run(pendingRun.id, JSON.stringify({
          request, newTask, job: { id: latest!.id, name: latest!.name, projectId: latest!.projectId },
        }));
      })();
      broadcast(CronIpc.event, { type: "run", run });
      await this.runInput(request);
      if (this.stopped) return;
      this.finishRun(latest, run, "success", newTask);
    } catch (error) {
      if (this.stopped && run) return;
      if (!latest) throw error;
      const current = run && this.db.getCronJob(job.id);
      if (current && current.cancelledAt === undefined && this.dotsPolicy(current) !== "continue") return;
      const message = error instanceof Error ? error.message : String(error);
      if (!run && this.db.getCronJob(job.id)) {
        run = { id: randomUUID(), jobId: job.id, startedAt: Date.now(), status: "running" };
        this.db.insertCronRun(run);
      }
      if (run) this.finishRun(latest, run, "error", newTask, message);
    } finally {
      this.runningJobs.delete(job.id);
      const current = this.db.getCronJob(job.id);
      if (current?.enabled && !this.stopped) {
        // Only the owning revision may consume a one-time plan. A newer timer
        // may have fired while this run was busy; reconcile its latest schedule.
        if (this.dotsPolicy(current) === "continue" && ((!opts?.force && !current.reminder && current.scheduleType === "at" && this.revisions.get(job.id) === revision) ||
          (current.maxRuns != null && (current.runCount ?? 0) >= current.maxRuns))) this.setEnabled(job.id, false);
        else if (!this.timers.has(job.id)) this.arm(current);
      }
    }
  }

  private async runInput(request: AgentPromptRequest): Promise<void> {
    const accepted = await this.agent.prompt(request);
    if (accepted.error) throw new Error(accepted.error.message);
    if (accepted.cancelled) throw new Error("执行已取消");
    if (!accepted.receipt) throw new Error("执行服务未返回持久回执");
    const result = await this.agent.waitForSubmission(accepted.receipt);
    if (result.error) throw new Error(result.error.message);
    if (result.cancelled) throw new Error("执行已取消");
    if (result.queued || result.receipt?.status !== "done") throw new Error("该次输入尚未完成");
  }

  private async resumeRun(run: CronRunDto): Promise<void> {
    let job = this.db.getCronJob(run.jobId);
    let saved: z.infer<typeof storedCronRun> | undefined;
    try {
      if (!job || !run.taskId) throw new Error("找不到待恢复的计划或任务");
      const stored = await this.db.readCronRunInput(run.id);
      if (this.stopped) return;
      job = this.db.getCronJob(run.jobId);
      if (!job) throw new Error("找不到待恢复的计划或任务");
      if (job.reminder || job.cancelledAt === undefined && this.dotsPolicy(job) !== "continue") return;
      if (stored === undefined) throw new Error("旧运行未保存操作身份，不能自动重放");
      saved = storedCronRun.parse(JSON.parse(stored));
      const { request } = saved;
      if (request.taskId !== run.taskId || request.userMessageId !== `cron-${run.id}-input`) throw new Error("计划运行的操作身份不一致");
      if (saved.job.id !== run.jobId) throw new Error("计划运行的来源身份不一致");
      if (job.sourceTaskId === DOTS_TASK_ID) this.assertDotsInputCurrent(request.userMessageId);
      await this.runInput(request);
      if (!this.stopped) this.finishRun(saved.job, run, "success", saved.newTask);
    } catch (error) {
      if (!this.stopped) {
        const current = job && this.db.getCronJob(job.id);
        if (current && current.cancelledAt === undefined && this.dotsPolicy(current) !== "continue") return;
        const message = error instanceof Error ? error.message : String(error);
        if (saved) this.finishRun(saved.job, run, "error", saved.newTask, message);
        else if (job) this.finishRun(job, run, "error", false, message);
        else this.db.finishCronRun(run.id, "error", message);
      }
    } finally {
      this.runningJobs.delete(run.jobId);
      const current = this.db.getCronJob(run.jobId);
      if (current?.enabled && !this.stopped && !this.timers.has(run.jobId)) this.arm(current);
    }
  }

  private finishRun(job: RunJob, run: CronRunDto, status: "success" | "error", newTask: boolean, error?: string): void {
    this.db.finishCronRun(run.id, status, error, run.taskId);
    if (newTask && run.taskId) {
      const task = this.db.getTask(run.taskId);
      if (task) this.db.upsertTask({ ...task, title: job.name, status: status === "success" ? "completed" : "failed", updatedAt: Date.now() });
    }
    broadcast(CronIpc.event, { type: "run", run: { ...run, status, error, finishedAt: Date.now() } });
    this.notifyProjectRun(job, run.id, status === "success" ? "success" : "failed", error);
    if (run.taskId) void this.notifyRun(job, run.id, run.taskId, status === "success" ? "success" : "failed", error);
  }

  private withNext(job: CronJobDto): CronJobDto {
    return job.reminder ? { ...job, enabled: false, nextRunAt: undefined } : withNextRun(job);
  }

  private unavailableReason(job: CronJobDto): string | undefined {
    if (job.reminder) return "Bot 提醒功能已移除";
    const project = this.projectUnavailableReason(job.projectId);
    if (project) return project;
    if (job.sourceTaskId) {
      const source = this.db.getTask(job.sourceTaskId);
      if (!source || source.archived) return "来源任务不存在或已归档，自动化已停用";
    }
    if (job.sourceTaskId === DOTS_TASK_ID) {
      const owner = this.scheduleOwner(job.id);
      if (owner?.spaceId && !this.db.getSpace(owner.spaceId)) return "跟进空间已删除，自动化已停用";
      if (owner?.taskId) {
        const task = this.db.getTask(owner.taskId);
        if (!task || this.db.isTaskEffectiveArchived(task.id) || (task.spaceId ?? null) !== (owner.spaceId ?? null)
          || this.db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed") return "跟进事项已移动、归档或删除，自动化已停用";
      }
    }
    if (job.target?.kind === "task") {
      const target = this.db.getTask(job.target.taskId);
      if (!target || target.archived) return "目标任务不存在或已归档，自动化已停用";
      return this.projectUnavailableReason(target.projectId ?? undefined);
    }
    return undefined;
  }

  private async notifyRun(job: RunJob, runId: string, taskId: string, status: "success" | "failed", error?: string): Promise<void> {
    try {
      if (!this.runNotificationSink) return;
      let message: string | undefined;
      if (taskId === DOTS_TASK_ID) {
        if (this.db.getCronJob(job.id)?.cancelledAt !== undefined || !this.dotsScheduleVisible(job.id) || this.dotsFollowupPaused(taskId, job.id)) return;
        if (status === "success") {
          const result = await this.agent.dotsSubmission?.(taskId, `cron-${runId}-input`);
          message = result?.text.trim();
          if (!message || message === DOTS_NO_CHANGE || this.stopped || this.db.getCronJob(job.id)?.cancelledAt !== undefined
            || !this.dotsScheduleVisible(job.id) || this.dotsFollowupPaused(taskId, job.id)) return;
        }
      }
      this.runNotificationSink?.({
        runId,
        jobId: job.id,
        jobName: job.name,
        taskId,
        projectId: job.projectId,
        status,
        error,
        ...(message ? { message } : {}),
      });
    } catch (err) {
      console.warn(`[CronService] 通知投递失败 ${job.id}：`, err);
    }
  }

  /** 项目 run 摘要钩子（fail-open：不改变既有执行语义；未绑定项目/无钩子时 no-op） */
  private notifyProjectRun(job: RunJob, runId: string, status: "success" | "failed", error?: string): void {
    if (!job.projectId) return;
    try {
      this.projectRunSink?.(job.projectId, { runId, jobName: job.name, status, error });
    } catch (err) {
      console.warn(`[CronService] 项目 run 摘要投递失败 ${job.projectId}：`, err);
    }
  }

  private composePrompt(job: CronJobDto): string {
    if (job.sourceTaskId === DOTS_TASK_ID) return job.prompt + "\n\n这是之前约定的主动跟进。到点提醒直接给提醒内容。检查有实质进展、成果或阻塞时直接给结果。检查没有变化时，只返回 " + DOTS_NO_CHANGE;
    return buildExecutionPrompt(
      job,
      (id) => {
        try {
          const skills = this.agent.listSkills();
          const hit = skills.find((s) => s.id === id || s.name === id);
          return hit?.name;
        } catch {
          return undefined;
        }
      },
      (id) => {
        try {
          const connectors = this.agent.listConnectors();
          const hit = connectors.find((c) => c.id === id);
          if (!hit) return undefined;
          return {
            name: hit.name,
            skillNames: hit.installedSkillNames ?? [],
          };
        } catch {
          return undefined;
        }
      },
    );
  }

  private projectUnavailableReason(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    const row = this.db.connection
      .prepare("SELECT archived FROM projects WHERE id = ?")
      .get(projectId) as { archived: number } | undefined;
    if (!row) return "所属项目不存在，自动化已停用";
    if (row.archived) return "所属项目已归档，自动化已停用；恢复项目后请手动重新启用";
    return undefined;
  }

  private async recordSkipped(job: CronJobDto, reason: string): Promise<void> {
    const runId = randomUUID();
    const run: CronRunDto = {
      id: runId,
      jobId: job.id,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: "skipped",
      error: reason,
    };
    this.db.insertCronRun(run);
    this.db.finishCronRun(runId, "skipped", reason);
    broadcast(CronIpc.event, { type: "run", run });
  }
}
