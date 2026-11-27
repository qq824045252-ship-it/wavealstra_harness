import { createHash, randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { z } from "zod";
import {
  CronIpc,
  type CronJobDto,
  type CronOverviewDto,
  type CronRunDto,
  type AgentPromptRequest,
  type AgentPromptResult,
  type AgentSubmissionReceipt,
  type TaskHistoryDto,
} from "../../shared/agent-ipc";
import { assertSingleExpertId, normalizeSingleExpertId } from "../../shared/expert-id";
import { parseCronExecution } from "../../shared/cron-execution";
import { DOTS_NO_CHANGE, DOTS_TASK_ID, isDotsAutomaticInput } from "../../shared/dots";
import { resolveDotsPreferences, type DotsSettings } from "../../shared/dots-settings";
import type { AppDatabase } from "../db/AppDatabase";
import type { CronGeneratedTask, CronRunWrite } from "../db/CronRunPersistence";
import { encodeCronPlan, type CronPlanGuard, type CronPlanProvenance } from "../db/CronPlanPersistence";
import { TaskWriteQueue } from "../db/TaskWriteQueue";
import { DotsIntentChanged } from "../dots/DotsNativeIntent";
import { computeNextRunAt, validateSchedule, withinEffectiveRange, scheduleTimer, type SegmentedTimer } from "./CronSchedule";

type CronJobState = NonNullable<Awaited<ReturnType<AppDatabase["readCronJobState"]>>>;

function taskPlanId(operation?: string): string {
  return operation ? `cron-request-${operation}` : randomUUID();
}

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
const BUSY_TASK_SKIP = "目标任务正忙，已跳过，未排队";
type TaskPlanInput = Pick<CronJobDto,
  "name" | "prompt" | "scheduleType" | "scheduleExpr" | "timezone" | "effectiveTo" | "maxRuns" | "restartPolicy" | "missedRuns"
> & { target: "current-task" | "new-task" };
type TaskPlanPatch = Partial<Omit<TaskPlanInput, "target">>;

export interface CronAgent {
  dotsSubmission?(taskId: string, operation: string): Promise<{ text: string } | undefined>;
  prompt(request: AgentPromptRequest): Promise<AgentPromptResult>;
  waitForSubmission(receipt: AgentSubmissionReceipt): Promise<AgentPromptResult>;
  loadTaskHistory(taskId: string): Promise<TaskHistoryDto>;
  isTaskBusy(taskId: string): boolean;
  getAppSettings(): { defaultModelId?: string | null; dotsSettings?: Partial<DotsSettings> };
  resolveAvailableModelId(id: string): Promise<{ modelId: string; repairedFrom?: string } | undefined>;
  listSkills(): Array<{ id: string; name: string }> | Promise<Array<{ id: string; name: string }>>;
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
  private readonly pendingRunWrites = new Set<Promise<boolean>>();
  private readonly planWrites = new TaskWriteQueue();
  private coreConfigWrites: Promise<void> = Promise.resolve();
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
    if (this.coreOwnsScheduling || db.readonly) return;
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
  }

  private get coreOwnsScheduling(): boolean {
    return Boolean(this.db.runtimeAuditReader?.supervised);
  }

  private syncCoreConfig(): Promise<void> {
    const reader = this.db.runtimeAuditReader;
    if (!reader?.cronScheduler) return Promise.resolve();
    const write = this.coreConfigWrites.then(async () => {
      const skillNames: Record<string, string> = {};
      try {
        for (const s of await this.agent.listSkills()) {
          if (s.id) skillNames[s.id] = s.name;
          if (s.name) skillNames[s.name] = s.name;
        }
      } catch { /* ignore */ }
      const settings = this.agent.getAppSettings();
      const prefs = resolveDotsPreferences(settings.dotsSettings);
      const connectors: Record<string, { name: string; skillNames: string[] }> = {};
      try {
        for (const c of this.agent.listConnectors()) {
          connectors[c.id] = { name: c.name, skillNames: c.installedSkillNames ?? [] };
        }
      } catch { /* ignore */ }
      await reader.cronScheduler({
        action: "syncConfig",
        dotsFollowupMode: prefs.followupMode,
        dotsSpaceIds: prefs.spaceIds,
        dotsSuspended: this.dotsSuspended,
        defaultModelId: settings.defaultModelId ?? null,
        skillNames,
        connectors,
      });
    });
    this.coreConfigWrites = write.catch(() => {});
    return write;
  }

  handleCoreEvent(event: { domain: string; kind: string; entityId: string; payload: unknown }): void {
    if (event.domain !== "cron" || this.stopped) return;
    const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    if (event.kind === "cron.jobUpdated" || event.kind === "cron.runStarted" || event.kind === "cron.runSkipped" || event.kind === "cron.runSettled") {
      broadcast(CronIpc.event, payload);
      return;
    }
    if (event.kind === "cron.dotsReminder") {
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      const jobName = typeof payload.jobName === "string" ? payload.jobName : "";
      const occurrence = typeof payload.occurrence === "number" ? payload.occurrence : 0;
      if (jobId) this.dotsReminderSink?.({ jobId, jobName, occurrence });
      return;
    }
    if (event.kind === "cron.runSummary") {
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      const jobName = typeof payload.jobName === "string" ? payload.jobName : "";
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
      const projectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
      const status = payload.status === "success" ? "success" : "failed";
      const error = typeof payload.error === "string" ? payload.error : undefined;
      const message = typeof payload.message === "string" ? payload.message : undefined;
      const notifyUser = payload.notifyUser === true;
      if (projectId) this.notifyProjectRun({ id: jobId, name: jobName, projectId }, runId, status, error);
      if (notifyUser && taskId) {
        const publish = () => this.runNotificationSink?.({ runId, jobId, jobName, taskId, projectId, status, error, ...(message ? { message } : {}) });
        if (taskId !== DOTS_TASK_ID) publish();
        else void this.readDotsRunAuthorization({ kind: "dotsRunAuthorization", source: `cron-${runId}-input`, purpose: "notification" })
          .then(allowed => { if (allowed && !this.stopped) publish(); })
          .catch(error => console.warn("[CronService] 无法复核 Dots 定时消息授权", error));
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.dotsSuspended = false;
    this.weeklyMaintenance?.start();
    if (this.coreOwnsScheduling && this.db.runtimeAuditReader?.cronScheduler) {
      // Production / supervised Core owns all Cron scheduling timers & crash recovery.
      void this.syncCoreConfig()
        .then(() => this.db.runtimeAuditReader?.cronScheduler?.({ action: "start" }))
        .catch(error => console.warn("[CronService] Core cron start failed", error));
      return;
    }
    const jobs = this.db.listCronJobs();
    for (const job of jobs) {
      if (job.sourceTaskId === DOTS_TASK_ID && job.restartPolicy === "pause" && !job.reminder && job.cancelledAt === undefined)
        this.setUserEnabled(job.id, false);
    }
    for (const run of this.db.listRunningCronRuns()) {
      const job = this.db.getCronJob(run.jobId);
      if (job?.reminder || job && !job.cancelledAt && this.dotsPolicy(job) !== "continue") continue;
      this.runningJobs.add(run.jobId);
      void this.resumeRun(run).catch(error => console.error("[CronService] recovery failed", run.id, error));
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

  async flushWrites(): Promise<void> {
    await this.planWrites.flush();
    await Promise.allSettled(this.pendingRunWrites);
  }

  private queuePlanWrite<T>(jobId: string | null, write: () => T | Promise<T>): Promise<T> {
    const run = () => {
      if (this.stopped) throw new Error("自动化调度已停止");
      return write();
    };
    return jobId === null ? this.planWrites.runExclusive(run) : this.planWrites.run([jobId], run);
  }

  withPlanMaintenance<T>(maintain: () => T | Promise<T>): Promise<T> {
    return this.queuePlanWrite(null, maintain);
  }

  private async writeRun(mutation: CronRunWrite): Promise<boolean> {
    const pending = Promise.resolve(this.db.writeCronRun(mutation));
    this.pendingRunWrites.add(pending);
    try { return await pending; }
    finally { this.pendingRunWrites.delete(pending); }
  }

  suspendDotsTimers(): void {
    if (!this.started) return;
    this.dotsSuspended = true;
    if (this.coreOwnsScheduling) {
      void this.syncCoreConfig().catch(() => undefined);
      return;
    }
    for (const job of this.listForTask(DOTS_TASK_ID)) this.disarm(job.id);
  }

  resumeDotsTimers(): void {
    if (!this.started || !this.dotsSuspended) return;
    this.dotsSuspended = false;
    if (this.coreOwnsScheduling) {
      void this.syncCoreConfig().catch(() => undefined);
      return;
    }
    for (const job of this.listForTask(DOTS_TASK_ID)) {
      if (job.enabled && !this.runningJobs.has(job.id)) this.arm(job, true);
    }
  }

  refreshDotsPolicy(): void {
    if (!this.started) return;
    if (this.coreOwnsScheduling) {
      void this.syncCoreConfig()
        .then(() => this.db.runtimeAuditReader?.cronScheduler?.({ action: "scanRecovery" }))
        .catch(() => undefined);
      return;
    }
    for (const run of this.db.listRunningCronRuns()) {
      const job = this.db.getCronJob(run.jobId);
      if (job?.sourceTaskId !== DOTS_TASK_ID || this.runningJobs.has(job.id)) continue;
      if (job.cancelledAt === undefined && this.dotsPolicy(job) !== "continue") continue;
      this.runningJobs.add(job.id);
      void this.resumeRun(run).catch(error => console.error("[CronService] recovery failed", run.id, error));
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

  async readOverview(): Promise<CronOverviewDto> {
    const { jobs, runs } = await this.db.readCronOverview(80);
    return { jobs: jobs.map(job => this.withNext(job)), runs };
  }

  listRuns(limit = 50): Promise<CronRunDto[]> {
    return this.db.readCronRuns(limit);
  }

  listForTask(taskId: string): CronJobDto[] {
    return this.list().filter(job => job.sourceTaskId === taskId);
  }

  private scheduleOwner(jobId: string) {
    return this.db.connection.prepare("SELECT task_id AS taskId, space_id AS spaceId FROM dots_schedule_scopes WHERE job_id=?")
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
    if (scope === null) return true;
    const spaceId = this.scheduleOwner(jobId)?.spaceId;
    return Boolean(spaceId && scope.includes(spaceId));
  }

  private dotsPolicy(job: CronJobDto): DotsSettings["followupMode"] {
    if (job.sourceTaskId !== DOTS_TASK_ID) return "continue";
    return this.dotsScheduleVisible(job.id) ? resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).followupMode : "paused";
  }

  private readonly pendingScheduleHolds = new Map<string, Set<string>>();

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.db.runtimeAuditReader?.supervised);
  }

  private hasScheduleHold(jobId: string, ignoreManualHold = false): boolean {
    const pending = this.pendingScheduleHolds.get(jobId);
    if (pending !== undefined) {
      for (const holder of pending) {
        if (!ignoreManualHold || holder !== "manual") return true;
      }
      return false;
    }
    return Boolean(this.db.connection.prepare("SELECT 1 FROM dots_schedule_holds WHERE job_id=? AND (holder<>'manual' OR ?=0)")
      .get(jobId, Number(ignoreManualHold)));
  }

  private currentScheduleHolders(jobId: string): Set<string> {
    const pending = this.pendingScheduleHolds.get(jobId);
    if (pending !== undefined) return new Set(pending);
    const rows = this.db.connection.prepare("SELECT holder FROM dots_schedule_holds WHERE job_id=?").all(jobId) as Array<{ holder: string }>;
    return new Set(rows.map(r => r.holder));
  }

  private enqueueDotsHoldWrite(jobId: string, holders: Set<string>, holder: string, pause: boolean): void {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error("只读模式下缺少 Cron Dots 暂停状态写入通道");
    this.pendingScheduleHolds.set(jobId, holders);
    const now = Date.now();
    void this.planWrites.run([jobId], async () => {
      try {
        await reader.batch4aWrite({ kind: "cronHoldDotsSchedule", id: jobId, holder, pause, now, setEnabled: null });
      } catch (error) {
        console.warn("[CronService] holdDotsSchedule write failed", error);
      } finally {
        if (this.pendingScheduleHolds.get(jobId) === holders) this.pendingScheduleHolds.delete(jobId);
      }
    });
  }

  private dotsFollowupPaused(taskId?: string, jobId?: string, spaceId?: string, ignoreManualHold = false): boolean {
    if (taskId !== DOTS_TASK_ID) return false;
    const owner = jobId ? this.scheduleOwner(jobId) : undefined;
    if (jobId && this.hasScheduleHold(jobId, ignoreManualHold)) return true;
    if (owner?.taskId && this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_target_controls'").get()
      && this.db.connection.prepare("SELECT 1 FROM dots_target_controls WHERE task_id=?").get(owner.taskId)) return true;
    return !!this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='dots_proactive_pauses'").get() &&
      !!this.db.connection.prepare("SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?)").get(spaceId ?? owner?.spaceId ?? "");
  }

  holdDotsSchedule(id: string, holder: string, pause: boolean) {
    if (this.requiresRustWrites) {
      const job = this.requireTaskJob(DOTS_TASK_ID, id);
      const holders = this.currentScheduleHolders(id);
      if (pause && !job.cancelledAt && (job.enabled || holders.size > 0)) {
        holders.add(holder);
        this.enqueueDotsHoldWrite(id, holders, holder, true);
        if (job.enabled) this.setEnabled(id, false);
      } else if (!pause) {
        const had = holders.delete(holder);
        this.enqueueDotsHoldWrite(id, holders, holder, false);
        if (had && !job.cancelledAt && (job.maxRuns === undefined || (job.runCount ?? 0) < job.maxRuns)
          && !this.unavailableReason(job) && !this.dotsFollowupPaused(DOTS_TASK_ID, id)) this.setEnabled(id, true);
      }
      return this.getForTask(DOTS_TASK_ID, id).status;
    }
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

  assertDotsInputCurrent(source: string, request?: AgentPromptRequest): void | Promise<void> {
    if (!source.startsWith("cron-") || !isDotsAutomaticInput(source)) return;
    if (!this.db.fixtureConnection) {
      if (request && (request.taskId !== DOTS_TASK_ID || request.userMessageId !== source || request.attachments?.length || request.terminalContext)) {
        throw new DotsIntentChanged("定时输入与已登记运行不一致");
      }
      return this.readDotsRunAuthorization(request ? {
        kind: "dotsRunAuthorization", source, purpose: "admission", assistantMessageId: request.assistantMessageId,
        textHash: createHash("sha256").update(request.text).digest("hex"),
      } : { kind: "dotsRunAuthorization", source, purpose: "continuation" }).then(allowed => {
        if (!allowed) throw new DotsIntentChanged("原定时跟进已暂停、取消或不可用");
      });
    }
    const run = this.db.connection.prepare("SELECT job_id FROM cron_runs WHERE id=? AND task_id=?")
      .get(source.slice("cron-".length, -"-input".length), DOTS_TASK_ID) as { job_id: string } | undefined;
    const job = run && this.db.getCronJob(run.job_id);
    if (!job || job.sourceTaskId !== DOTS_TASK_ID || job.cancelledAt !== undefined || this.unavailableReason(job) || this.dotsPolicy(job) !== "continue"
      || this.dotsSuspended || this.dotsFollowupPaused(job.sourceTaskId, job.id)) {
      throw new DotsIntentChanged("原定时跟进已暂停、取消或不可用");
    }
  }

  private async readDotsRunAuthorization(query: Extract<import("../platform/runtime-audit").RuntimeCronDataQuery, { kind: "dotsRunAuthorization" }>): Promise<boolean> {
    await this.coreConfigWrites;
    const state = await this.db.runtimeAuditReader?.cronData<{ allowed: boolean; ownerSpaceId: string | null }>(query);
    if (state?.allowed !== true) return false;
    const current = resolveDotsPreferences(this.agent.getAppSettings().dotsSettings);
    return !this.dotsSuspended && (query.purpose === "notification" || current.followupMode === "continue") &&
      (current.spaceIds === null || state.ownerSpaceId !== null && current.spaceIds.includes(state.ownerSpaceId));
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
    return this.taskPlanView(saved, this.unavailableReason(saved), this.db.listCronJobRuns(id, 1, undefined, "running")[0] ?? null,
      this.db.listCronJobRuns(id, 1)[0] ?? null);
  }

  async readForTask(taskId: string, id: string, restrictDotsScope = false) {
    const state = await this.db.readCronJobState(id);
    if (!state || state.job.sourceTaskId !== taskId || state.job.reminder) throw new Error("Automation does not belong to the current task");
    if (restrictDotsScope) this.assertDotsPlanVisible(state);
    const unavailable = state.unavailableReason === undefined ? this.unavailableReason(state.job) : state.unavailableReason ?? undefined;
    return this.taskPlanView(state.job, unavailable, state.activeRun, state.latestRun);
  }

  private assertDotsPlanVisible(state: CronJobState): void {
    const spaces = resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).spaceIds;
    if (spaces === null) return;
    const space = state.owner === undefined ? this.scheduleOwner(state.job.id)?.spaceId : state.owner?.spaceId;
    if (!space || !spaces.includes(space)) throw new Error("计划不在 Dots 已授权的空间内");
  }

  private taskPlanView(saved: CronJobDto, unavailable: string | undefined, activeRun: CronRunDto | null, latestRun: CronRunDto | null) {
    const job = this.withNext(saved);
    const now = Date.now();
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
      activeRun, latestRun,
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

  private prepareTaskCreation(taskId: string, cwd: string, input: TaskPlanInput, id: string, operation?: string, provenance?: CronPlanProvenance) {
    const existing = operation ? this.db.getCronJob(id) : undefined;
    if (existing) {
      if (existing.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
      if (taskId === DOTS_TASK_ID && !this.dotsScheduleVisible(id)) throw new Error("计划不在 Dots 已授权的空间内");
      return { job: existing, existing: true };
    }
    const task = this.db.getTask(taskId);
    const spaces = taskId === DOTS_TASK_ID ? resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).spaceIds : null;
    if (spaces && (!provenance?.owner?.spaceId || !spaces.includes(provenance.owner.spaceId)))
      throw new Error("请为定时跟进指定 Dots 已授权的任务或空间");
    if (this.dotsFollowupPaused(taskId, undefined, provenance?.owner?.spaceId)) throw new Error("Dots 主动跟进已暂停，恢复后可创建计划");
    if (!task || task.archived) throw new Error("来源任务不存在或已归档");
    if (this.listForTask(taskId).filter(job => job.enabled).length >= 20) throw new Error("每个任务最多启用 20 个计划");
    return { job: this.newTaskPlan(task, id, cwd, input), existing: false };
  }

  private newTaskPlan(task: NonNullable<ReturnType<AppDatabase["getTask"]>>, id: string, cwd: string, input: TaskPlanInput): CronJobDto {
    const now = Date.now();
    return {
      ...input, id, sourceTaskId: task.id,
      target: input.target === "current-task" ? { kind: "task", taskId: task.id } : { kind: "new-task" },
      enabled: true, createdAt: now, updatedAt: now, cwd,
      permissionMode: task.permissionMode ?? "default", welcomeMode: task.welcomeMode,
      projectId: task.projectId ?? undefined, spaceId: task.spaceId ?? undefined,
      modelId: task.modelId, expertId: task.expertId,
    };
  }

  createForTask(taskId: string, cwd: string, input: TaskPlanInput, operation?: string, provenance?: CronPlanProvenance): CronJobDto {
    const prepared = this.prepareTaskCreation(taskId, cwd, input, taskPlanId(operation), operation, provenance);
    if (prepared.existing) return this.withNext(prepared.job);
    const create = () => this.upsert(prepared.job);
    if (taskId !== DOTS_TASK_ID || !provenance) return create();
    if (this.requiresRustWrites) {
      const job = create();
      this.db.enqueueCronBatch4a({
        kind: "cronSaveDotsProvenance",
        jobId: job.id,
        source: provenance.source,
        conversationId: provenance.origin.conversationId,
        entryId: provenance.origin.entryId,
        ownerTaskId: provenance.owner?.taskId ?? null,
        ownerSpaceId: provenance.owner?.spaceId ?? null,
      }, "saveDotsProvenance");
      if (job.enabled && this.started) this.arm(job, true);
      return job;
    }
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

  createTaskPlan(taskId: string, cwd: string, input: TaskPlanInput, operation?: string, provenance?: CronPlanProvenance): Promise<CronJobDto> {
    const id = taskPlanId(operation);
    return this.queuePlanWrite(id, async () => {
      const { job, existing } = this.coreOwnsScheduling
        ? await this.prepareCoreTaskCreation(taskId, cwd, input, id, operation, provenance)
        : this.prepareTaskCreation(taskId, cwd, input, id, operation, provenance);
      if (existing) return this.withNext(job);
      const next = this.preparePlan(job);
      const origin = taskId === DOTS_TASK_ID ? provenance : undefined;
      await this.commitPlan(next, null, {
        guard: await this.planGuard(next, { enabledLimitForTask: taskId, owner: origin?.owner, checkDotsHold: next.enabled }),
        provenance: origin,
      });
      return this.publishConfirmedPlan(next, false, Boolean(origin));
    });
  }

  private async prepareCoreTaskCreation(taskId: string, cwd: string, input: TaskPlanInput, id: string, operation?: string, provenance?: CronPlanProvenance) {
    const prior = operation ? await this.db.readCronJobState(id) : undefined;
    const spaces = taskId === DOTS_TASK_ID ? resolveDotsPreferences(this.agent.getAppSettings().dotsSettings).spaceIds : null;
    if (prior) {
      if (prior.job.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
      if (spaces && (!prior.owner?.spaceId || !spaces.includes(prior.owner.spaceId))) throw new Error("计划不在 Dots 已授权的空间内");
      return { job: prior.job, existing: true };
    }
    const space = provenance?.owner?.spaceId;
    if (spaces && (!space || !spaces.includes(space))) throw new Error("请为定时跟进指定 Dots 已授权的任务或空间");
    const task = await this.db.readTask(taskId, { includeExpertBinding: false });
    if (!task || task.archived) throw new Error("来源任务不存在或已归档");
    return { job: this.newTaskPlan(task, id, cwd, input), existing: false };
  }

  private prepareTaskUpdate(taskId: string, job: CronJobDto | undefined, patch: TaskPlanPatch) {
    if (!job || job.sourceTaskId !== taskId || job.reminder) throw new Error("计划不属于当前任务");
    // Whitelist mutable configuration; never replace identity, execution history or authority.
    const next = { ...job };
    for (const key of ["name", "prompt", "scheduleType", "scheduleExpr", "timezone", "effectiveTo", "maxRuns", "restartPolicy", "missedRuns"] as const) {
      if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
    }
    if (!next.name.trim() || !next.prompt.trim()) throw new Error("name and prompt must not be blank");
    new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format();
    if (JSON.stringify(next) === JSON.stringify(job)) return { next: job, existing: job, changed: false, preserveTimer: true };
    const scheduleChanged = (["scheduleType", "scheduleExpr", "timezone", "effectiveTo", "maxRuns"] as const)
      .some(key => next[key] !== job[key]);
    return { next, existing: job, changed: true, preserveTimer: !scheduleChanged };
  }

  updateForTask(taskId: string, id: string, patch: TaskPlanPatch): CronJobDto {
    const { next, changed, preserveTimer } = this.prepareTaskUpdate(taskId, this.db.getCronJob(id), patch);
    return changed ? this.saveJob(next, preserveTimer) : this.withNext(next);
  }

  updateTaskPlan(taskId: string, id: string, patch: TaskPlanPatch): Promise<CronJobDto> {
    return this.queuePlanWrite(id, async () => {
      const state = await this.db.readCronJobState(id);
      const { next, changed, preserveTimer } = this.prepareTaskUpdate(taskId, state?.job, patch);
      if (state && taskId === DOTS_TASK_ID) this.assertDotsPlanVisible(state);
      if (!changed) return this.withNext(next);
      return this.savePlan(next, preserveTimer, state);
    });
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

  changeTaskPlan(taskId: string, id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    return this.queuePlanWrite(id, async () => {
      const state = await this.db.readCronJobState(id);
      if (!state || state.job.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
      if (action !== "cancel") return this.setPlanEnabled(state, action === "resume");
      if (state.job.cancelledAt !== undefined) return;
      const now = Date.now();
      const cancelled = { ...state.job, enabled: false, cancelledAt: now, updatedAt: now };
      await this.commitPlan(cancelled, state.expectedJob, {});
      await this.publishConfirmedPlan(cancelled, false);
    });
  }

  upsert(job: CronJobDto): CronJobDto {
    return this.saveJob(job);
  }

  private saveJob(job: CronJobDto, preserveTimer = false): CronJobDto {
    const next = this.preparePlan(job, this.db.getCronJob(job.id));
    this.db.upsertCronJob(next);
    return this.publishPlanSave(next, preserveTimer);
  }

  saveUserPlan(job: CronJobDto): Promise<CronJobDto> {
    return this.queuePlanWrite(job.id, async () => this.savePlan(job, false, await this.db.readCronJobState(job.id)));
  }

  private async savePlan(job: CronJobDto, preserveTimer: boolean, state?: CronJobState): Promise<CronJobDto> {
    const next = this.preparePlan(job, state?.job);
    const guard = await this.planGuard(next, { checkDotsHold: next.enabled, owner: state?.owner });
    await this.commitPlan(next, state?.expectedJob ?? null, { guard });
    return this.publishConfirmedPlan(next, preserveTimer);
  }

  private preparePlan(job: CronJobDto, existing?: CronJobDto): CronJobDto {
    assertSingleExpertId(job.expertId);
    validateSchedule(job);
    parseCronExecution({ reminder: job.reminder, sourceTaskId: job.sourceTaskId, target: job.target, maxRuns: job.maxRuns, restartPolicy: job.restartPolicy, missedRuns: job.missedRuns, cancelledAt: job.cancelledAt });
    if (job.missedRuns === "coalesce" && (job.sourceTaskId !== DOTS_TASK_ID || job.target?.kind !== "task" || job.target.taskId !== DOTS_TASK_ID))
      throw new Error("离线补办仅支持回到 Dots 的计划");
    const now = Date.now();
    if (job.enabled && !existing?.enabled && !this.coreOwnsScheduling && this.dotsFollowupPaused(job.sourceTaskId, job.id)) throw new Error("Dots 主动跟进已暂停");
    if ((existing?.cancelledAt !== undefined || job.cancelledAt !== undefined) && job.enabled) throw new Error("Cancelled automation cannot be enabled");
    const next: CronJobDto = {
      ...job,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: existing ? existing.lastRunAt : job.lastRunAt,
      projectId: job.projectId ?? existing?.projectId,
      cancelledAt: existing?.cancelledAt ?? job.cancelledAt,
    };
    const unavailable = this.coreOwnsScheduling ? (next.reminder ? "Bot 提醒功能已移除" : undefined) : this.unavailableReason(next);
    if (unavailable) throw new Error(unavailable);
    delete next.nextRunAt;
    delete next.runCount;
    return next;
  }

  private publishPlanSave(next: CronJobDto, preserveTimer: boolean, restoring = false): CronJobDto {
    return this.publishSavedPlan(this.db.getCronJob(next.id), next, preserveTimer, restoring);
  }

  private async publishConfirmedPlan(next: CronJobDto, preserveTimer: boolean, restoring = false): Promise<CronJobDto> {
    const saved = await this.db.readCronJobState(next.id);
    return this.publishSavedPlan(saved?.job, next, preserveTimer, restoring);
  }

  private publishSavedPlan(saved: CronJobDto | undefined, next: CronJobDto, preserveTimer: boolean, restoring: boolean): CronJobDto {
    if (!saved) return this.withNext({ ...next, enabled: false });
    if (!preserveTimer) {
      this.disarm(next.id);
      if (saved.enabled && !this.stopped) this.arm(saved, restoring && this.started);
    }
    const enriched = this.withNext(saved);
    broadcast(CronIpc.event, { type: "upsert", job: enriched });
    return enriched;
  }

  private async planGuard(job: CronJobDto, options: {
    checkDotsHold?: boolean; ignoreManualHold?: boolean; enabledLimitForTask?: string;
    owner?: { taskId?: string | null; spaceId?: string | null } | null;
  }): Promise<CronPlanGuard> {
    const target = job.target?.kind === "task" ? await this.db.readTask(job.target.taskId, { includeExpertBinding: false }) : undefined;
    const guard: CronPlanGuard = {
      tasks: [job.sourceTaskId, job.target?.kind === "task" ? job.target.taskId : undefined].filter((id): id is string => Boolean(id)),
      projects: [job.projectId, target?.projectId].filter((id): id is string => Boolean(id)),
      targetTaskId: job.target?.kind === "task" ? job.target.taskId : undefined,
      enabledLimitForTask: options.enabledLimitForTask,
    };
    if (options.checkDotsHold && job.sourceTaskId === DOTS_TASK_ID) {
      const owner = options.owner ?? (this.coreOwnsScheduling ? undefined : this.scheduleOwner(job.id));
      guard.dots = { taskId: owner?.taskId ?? undefined, spaceId: owner?.spaceId ?? undefined, ignoreManualHold: options.ignoreManualHold ?? false };
    }
    return guard;
  }

  private async commitPlan(next: CronJobDto, expected: Record<string, unknown> | null, options: {
    guard?: CronPlanGuard; provenance?: CronPlanProvenance; manualHold?: "add" | "remove";
  }): Promise<void> {
    if (!await this.db.writeCronPlan({ kind: "save", row: encodeCronPlan(next), expected, ...options })) {
      throw new Error("自动化计划或关联任务已变化，请刷新后重试");
    }
  }

  setEnabled(id: string, enabled: boolean, reminderState?: "cancelled"): void {
    const job = this.db.getCronJob(id);
    if (!job) return;
    if (enabled) this.validatePlanEnable(job);
    if (job.reminder) this.db.upsertCronJob({ ...job, enabled, updatedAt: Date.now(), reminder: { ...job.reminder, state: enabled ? "scheduled" : reminderState ?? "paused" } });
    else this.db.setCronEnabled(id, enabled);
    this.disarm(id);
    if (enabled) this.arm({ ...job, enabled: true });
    broadcast(CronIpc.event, { type: "upsert", job: this.withNext(this.db.getCronJob(id) ?? { ...job, enabled }) });
  }

  private validatePlanEnable(job: CronJobDto, ignoreManualHold = false): void {
    if (this.dotsFollowupPaused(job.sourceTaskId, job.id, undefined, ignoreManualHold)) throw new Error("Dots 主动跟进已暂停");
    if (job.cancelledAt !== undefined) throw new Error("Cancelled automation cannot be resumed");
    const unavailable = this.unavailableReason(job);
    if (unavailable) throw new Error(unavailable);
    validateSchedule(job);
  }

  setUserPlanEnabled(id: string, enabled: boolean): Promise<void> {
    return this.queuePlanWrite(id, async () => {
      const state = await this.db.readCronJobState(id);
      if (state) await this.setPlanEnabled(state, enabled);
    });
  }

  private async setPlanEnabled({ job, expectedJob, owner, unavailableReason }: CronJobState, enabled: boolean): Promise<void> {
    const manualHold = job.sourceTaskId === DOTS_TASK_ID && job.cancelledAt === undefined ? (enabled ? "remove" : "add") : undefined;
    if (enabled) {
      if (unavailableReason === undefined) this.validatePlanEnable(job, manualHold === "remove");
      else {
        if (job.cancelledAt !== undefined) throw new Error("Cancelled automation cannot be resumed");
        if (unavailableReason) throw new Error(unavailableReason);
        validateSchedule(job);
      }
    }
    const next: CronJobDto = { ...job, enabled, updatedAt: Date.now(),
      reminder: job.reminder && { ...job.reminder, state: enabled ? "scheduled" : "paused" } };
    await this.commitPlan(next, expectedJob, {
      guard: enabled ? await this.planGuard(next, { checkDotsHold: true, ignoreManualHold: manualHold === "remove", owner }) : undefined,
      manualHold,
    });
    await this.publishConfirmedPlan(next, false);
  }

  setUserEnabled(id: string, enabled: boolean): void {
    const job = this.db.getCronJob(id);
    if (job?.sourceTaskId !== DOTS_TASK_ID || job.cancelledAt !== undefined) {
      this.setEnabled(id, enabled);
      return;
    }
    if (this.requiresRustWrites) {
      const holders = this.currentScheduleHolders(id);
      if (enabled) holders.delete("manual");
      else holders.add("manual");
      this.enqueueDotsHoldWrite(id, holders, "manual", !enabled);
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

  deleteUserPlan(id: string): Promise<void> {
    return this.queuePlanWrite(id, async () => {
      const expected = (await this.db.readCronJobState(id))?.expectedJob ?? null;
      if (!await this.db.writeCronPlan({ kind: "remove", id, expected })) {
        throw new Error("自动化计划已变化，请刷新后删除");
      }
      this.disarm(id);
      broadcast(CronIpc.event, { type: "remove", id });
    });
  }

  /** 归档项目会暂停全部自动化；恢复项目时不自动恢复，避免后台任务意外重启。 */
  async disableProject(projectId: string): Promise<void> {
    if (this.requiresRustWrites) {
      // Core pauses these jobs in the same transaction that archives the project.
      for (const job of await this.db.readCronJobs()) {
        if (job.projectId !== projectId || job.enabled) continue;
        this.disarm(job.id);
        broadcast(CronIpc.event, { type: "upsert", job: withNextRun(job) });
      }
      return;
    }
    for (const job of this.db.listCronJobs().filter((item) => item.projectId === projectId)) {
      if (!job.enabled) continue;
      this.db.setCronEnabled(job.id, false);
      this.disarm(job.id);
      broadcast(CronIpc.event, { type: "upsert", job: withNextRun({ ...job, enabled: false }) });
    }
  }

  async disableTask(taskId: string): Promise<void> {
    const applies = (job: CronJobDto) => job.sourceTaskId === taskId || (job.target?.kind === "task" && job.target.taskId === taskId);
    for (const job of await this.db.readCronJobs()) {
      if (!applies(job)) continue;
      const state = await this.db.readCronJobState(job.id);
      if (!state || !applies(state.job) || !state.job.enabled) continue;
      const next: CronJobDto = { ...state.job, enabled: false, updatedAt: Date.now(),
        reminder: state.job.reminder && { ...state.job.reminder, state: "paused" } };
      await this.commitPlan(next, state.expectedJob, {});
      await this.publishConfirmedPlan(next, false);
    }
  }

  removeProject(projectId: string): void {
    const ids = this.requiresRustWrites
      ? this.removeProjectData(projectId)
      : this.db.connection.transaction(() => this.removeProjectData(projectId)).immediate();
    this.publishRemovedProjectJobs(ids);
  }

  removeProjectData(projectId: string): string[] {
    const ids = this.db.listCronJobs().filter(job => job.projectId === projectId).map(job => job.id);
    for (const id of ids) this.db.removeCronJob(id);
    return ids;
  }

  publishRemovedProjectJobs(ids: string[]): void {
    for (const id of ids) {
      this.disarm(id);
      broadcast(CronIpc.event, { type: "remove", id });
    }
  }

  /**
   * 测试运行：立即返回，在后台执行。
   * 不同 job 可并行；正式调度时间不受影响。
   */
  async runNow(id: string): Promise<void> {
    const reader = this.db.runtimeAuditReader;
    if (reader?.supervised) {
      await this.syncCoreConfig();
      const reply = await reader.cronScheduler<{ status: string; message?: string }>({ action: "runNow", jobId: id });
      if (reply?.status !== "ok") throw new Error(reply?.message ?? "自动化运行未获 Rust 核心确认");
      return;
    }
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
    if (this.coreOwnsScheduling) {
      if (!this.stopped && this.db.runtimeAuditReader?.cronScheduler) {
        void this.db.runtimeAuditReader.cronScheduler({ action: "refreshJob", jobId: job.id, restoring }).catch(() => undefined);
      }
      return;
    }
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
    let retryCheckpoint = false;
    try {
      if (!latest || (!latest.enabled && !opts?.force)) return;
      latest = { ...latest, expertId: normalizeSingleExpertId(latest.expertId) };
      const policy = this.dotsPolicy(latest);
      if (policy !== "continue") {
        if (policy === "notify" && opts?.occurrence !== undefined && !this.dotsFollowupPaused(latest.sourceTaskId, latest.id)
          && !this.unavailableReason(latest)) {
          const event = {jobId:latest.id,jobName:latest.name,occurrence:opts.occurrence};
          if (this.requiresRustWrites) {
            const reader = this.db.runtimeAuditReader;
            if (!reader) throw new Error("只读模式下缺少 Cron 提醒通知 Rust 写入通道");
            const notice = await reader.batch4aWrite<{ changed?: boolean }>({
              kind: "cronRecordDotsNotice",
              jobId: event.jobId,
              occurrence: event.occurrence,
            });
            if (notice?.changed) this.dotsReminderSink?.(event);
          } else {
            this.db.connection.transaction(() => {
              const written = this.db.connection.prepare(`INSERT INTO dots_schedule_notices VALUES(?,?) ON CONFLICT(job_id)
                DO UPDATE SET occurrence=excluded.occurrence WHERE occurrence<excluded.occurrence`).run(event.jobId,event.occurrence);
              if (written.changes) this.dotsReminderSink?.(event);
            })();
          }
        }
        return;
      }
      const unavailable = this.unavailableReason(latest);
      if (unavailable) {
        await this.recordTerminalRun(latest, "skipped", unavailable);
        if (!this.stopped) this.setEnabled(job.id, false);
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
      const state = this.db.getCronJobForExecution(job.id);
      if (!state) return;
      const persisted = state.job;
      if (persisted.cancelledAt !== undefined || (!persisted.enabled && !opts?.force) || withinEffectiveRange(persisted) === "after") return;
      // Content-only edits keep the pending timer/revision; use the current
      // configuration after asynchronous preparation, before committing input.
      latest = { ...persisted, expertId: normalizeSingleExpertId(persisted.expertId) };
      if (this.dotsPolicy(latest) !== "continue") return;
      const currentUnavailable = this.unavailableReason(persisted);
      if (currentUnavailable) {
        await this.recordTerminalRun(persisted, "skipped", currentUnavailable);
        if (!this.stopped) this.setEnabled(job.id, false);
        return;
      }
      const target = targetId ? this.db.getTask(targetId) : undefined;
      if (targetId && !target) return;
      if (this.dotsFollowupPaused(latest.sourceTaskId, job.id)) return;
      const queueInDots = targetId === DOTS_TASK_ID && latest.sourceTaskId === DOTS_TASK_ID && latest.missedRuns === "coalesce";
      if (targetId && !queueInDots && this.agent.isTaskBusy(targetId)) {
        await this.recordTerminalRun(persisted, "skipped", BUSY_TASK_SKIP);
        return;
      }
      const taskId = targetId ?? `cron-${latest.id}-${randomUUID()}`;
      newTask = !targetId;
      const generated: CronGeneratedTask | undefined = newTask ? {
        id: taskId, title: latest.name || "任务", spaceId: latest.spaceId ?? null, projectId: latest.projectId,
        status: "in_progress", updatedAt: Date.now(), cwd: latest.cwd,
        modelId: resolved?.modelId ?? requestedModelId, permissionMode: latest.permissionMode ?? "auto",
        expertId: latest.expertId, welcomeMode: latest.welcomeMode ?? "working",
      } : undefined;
      const task = target ?? generated!;
      const text = await this.composePrompt(latest);
      if (this.stopped || this.revisions.get(job.id) !== revision
        || this.dotsFollowupPaused(latest.sourceTaskId, job.id)) return;
      const pendingRun: CronRunDto = { id: randomUUID(), jobId: job.id, taskId, startedAt: Date.now(), status: "running" };
      const request: AgentPromptRequest = {
        taskId, text,
        ...(latest.sourceTaskId === DOTS_TASK_ID && { displayText: latest.prompt }),
        permissionMode: task.permissionMode ?? "default",
        welcomeMode: task.welcomeMode, spaceId: task.spaceId ?? undefined,
        modelId: task.modelId, expertId: task.expertId, modePresetId: target?.modePresetId,
        connectorIds: target ? undefined : latest.connectorIds,
        streamingBehavior: queueInDots ? "followUp" : undefined,
        assistantMessageId: `cron-${pendingRun.id}-assistant`, userMessageId: `cron-${pendingRun.id}-input`,
      };
      const written = await this.writeRun({
        kind: "start", run: pendingRun, expectedJob: state.expectedJob, newTask: generated,
        requiredTasks: [latest.sourceTaskId, targetId].filter((id): id is string => Boolean(id)),
        requiredProjects: [latest.projectId, target?.projectId].filter((id): id is string => Boolean(id)),
        inputJson: JSON.stringify({ request, newTask, job: { id: latest.id, name: latest.name, projectId: latest.projectId } }),
      });
      if (!written) {
        const refreshed = this.stopped ? undefined : this.db.getCronJobForExecution(job.id);
        retryCheckpoint = !!refreshed && JSON.stringify(refreshed.expectedJob) !== JSON.stringify(state.expectedJob);
        return;
      }
      run = pendingRun;
      if (this.stopped || !this.db.getCronJob(job.id)) return;
      if (targetId && !queueInDots && this.agent.isTaskBusy(targetId)) {
        const finishedAt = Date.now();
        const saved = await this.writeRun({
          kind: "finish", runId: run.id, status: "skipped", finishedAt, error: BUSY_TASK_SKIP,
          skippedStart: { jobId: run.jobId, startedAt: run.startedAt, previousLastRunAt: persisted.lastRunAt, previousUpdatedAt: persisted.updatedAt },
        });
        if (saved && !this.stopped) broadcast(CronIpc.event, { type: "run", run: {
          ...run, taskId: undefined, finishedAt, status: "skipped", error: BUSY_TASK_SKIP,
        } });
        return;
      }
      if (latest.sourceTaskId === DOTS_TASK_ID) await this.assertDotsInputCurrent(request.userMessageId!, request);
      broadcast(CronIpc.event, { type: "run", run });
      await this.runInput(request);
      if (this.stopped) return;
      await this.finishRun(latest, run, "success", newTask);
    } catch (error) {
      if (this.stopped) return;
      if (!latest) throw error;
      const current = run && this.db.getCronJob(job.id);
      if (current && current.cancelledAt === undefined && this.dotsPolicy(current) !== "continue") return;
      const message = error instanceof Error ? error.message : String(error);
      if (run) await this.finishRun(latest, run, "error", newTask, message);
      else await this.recordTerminalRun(latest, "error", message);
    } finally {
      this.runningJobs.delete(job.id);
      const current = this.stopped ? undefined : this.db.getCronJob(job.id);
      if (retryCheckpoint && current && current.cancelledAt === undefined &&
          (current.enabled || opts?.force) && this.revisions.get(job.id) === revision) {
        queueMicrotask(() => {
          if (this.revisions.get(job.id) === revision) void this.execute(current, opts)
            .catch(error => console.error("[CronService] checkpoint retry failed", job.id, error));
        });
      } else if (current?.enabled) {
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
      if (job.sourceTaskId === DOTS_TASK_ID) await this.assertDotsInputCurrent(request.userMessageId, request);
      await this.runInput(request);
      if (!this.stopped) await this.finishRun(saved.job, run, "success", saved.newTask);
    } catch (error) {
      if (!this.stopped) {
        const current = job && this.db.getCronJob(job.id);
        if (current && current.cancelledAt === undefined && this.dotsPolicy(current) !== "continue") return;
        const message = error instanceof Error ? error.message : String(error);
        if (saved) await this.finishRun(saved.job, run, "error", saved.newTask, message);
        else if (job) await this.finishRun(job, run, "error", false, message);
        else await this.writeRun({ kind: "finish", runId: run.id, status: "error", finishedAt: Date.now(), error: message });
      }
    } finally {
      this.runningJobs.delete(run.jobId);
      const current = this.stopped ? undefined : this.db.getCronJob(run.jobId);
      if (current?.enabled && !this.timers.has(run.jobId)) this.arm(current);
    }
  }

  private async finishRun(job: RunJob, run: CronRunDto, status: "success" | "error", newTask: boolean, error?: string): Promise<void> {
    const finishedAt = Date.now();
    if (!await this.writeRun({
      kind: "finish", runId: run.id, finishedAt, status, error, taskId: run.taskId,
      generatedTaskTitle: newTask ? job.name : undefined,
    }) || this.stopped) return;
    this.publishFinishedRun(job, { ...run, status, error, finishedAt });
  }

  private publishFinishedRun(job: RunJob, run: CronRunDto): void {
    broadcast(CronIpc.event, { type: "run", run });
    const status = run.status === "success" ? "success" : "failed";
    this.notifyProjectRun(job, run.id, status, run.error);
    if (run.taskId) void this.notifyRun(job, run.id, run.taskId, status, run.error);
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

  private async composePrompt(job: CronJobDto): Promise<string> {
    if (job.sourceTaskId === DOTS_TASK_ID) return job.prompt + "\n\n这是之前约定的主动跟进。到点提醒直接给提醒内容。检查有实质进展、成果或阻塞时直接给结果。检查没有变化时，只返回 " + DOTS_NO_CHANGE;
    let skills: Awaited<ReturnType<CronAgent["listSkills"]>> = [];
    if (job.skillIds?.length) {
      try { skills = await this.agent.listSkills(); } catch { /* use the configured skill IDs */ }
    }
    return buildExecutionPrompt(
      job,
      (id) => skills.find(s => s.id === id || s.name === id)?.name,
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

  private async recordTerminalRun(job: CronJobDto, status: "error" | "skipped", error: string): Promise<void> {
    const at = Date.now();
    const run: CronRunDto = {
      id: randomUUID(), jobId: job.id, startedAt: at, finishedAt: at, status, error,
    };
    if (!await this.writeRun({ kind: "record", run }) || this.stopped) return;
    if (status === "error") this.publishFinishedRun(job, run);
    else broadcast(CronIpc.event, { type: "run", run });
  }
}
