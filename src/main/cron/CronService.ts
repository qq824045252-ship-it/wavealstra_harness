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
import type { AppDatabase } from "../db/AppDatabase";
import { computeNextRunAt, validateSchedule, withinEffectiveRange, scheduleTimer, type SegmentedTimer } from "./CronSchedule";

const storedCronInput = z.object({
  taskId: z.string().min(1), text: z.string(), userMessageId: z.string().min(1), assistantMessageId: z.string().min(1),
  permissionMode: z.enum(["default", "auto", "readonly"]).optional(), welcomeMode: z.enum(["working", "coding", "bot"]).optional(),
  spaceId: z.string().optional(), modelId: z.string().optional(), expertId: z.string().optional(),
  modePresetId: z.string().nullable().optional(), connectorIds: z.array(z.string()).optional(),
});
const storedCronRun = z.object({
  request: storedCronInput,
  newTask: z.boolean(),
  job: z.object({ id: z.string(), name: z.string(), projectId: z.string().optional() }),
});
type RunJob = z.infer<typeof storedCronRun>["job"];

export interface CronAgent {
  prompt(request: AgentPromptRequest): Promise<AgentPromptResult>;
  waitForSubmission(receipt: AgentSubmissionReceipt): Promise<AgentPromptResult>;
  loadTaskHistory(taskId: string): Promise<TaskHistoryDto>;
  isTaskBusy(taskId: string): boolean;
  getAppSettings(): { defaultModelId?: string | null };
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
    }) => void,
  ) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS cron_run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES cron_runs(id) ON DELETE CASCADE, request_json TEXT NOT NULL)`);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    for (const run of this.db.listRunningCronRuns()) {
      this.runningJobs.add(run.jobId);
      void this.resumeRun(run);
    }
    for (const job of this.db.listCronJobs()) {
      if (!job.enabled) continue;
      const unavailable = this.unavailableReason(job);
      if (unavailable || job.restartPolicy === "pause") {
        this.db.setCronEnabled(job.id, false);
        console.info(`[CronService] disabled project job ${job.id}: ${unavailable}`);
        continue;
      }
      try { validateSchedule(job); this.arm(job); }
      catch (error) {
        this.setEnabled(job.id, false);
        console.warn("[CronService] invalid persisted schedule", job.id, error);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const id of this.revisions.keys()) this.disarm(id);
  }

  list(): CronJobDto[] {
    return this.db.listCronJobs().map(withNextRun);
  }

  listRuns(limit = 50): CronRunDto[] {
    return this.db.listCronRuns(limit);
  }

  listForTask(taskId: string): CronJobDto[] {
    return this.list().filter(job => job.sourceTaskId === taskId);
  }

  runsForTask(taskId: string, limit = 50): CronRunDto[] {
    return this.db.listCronRuns(Math.max(1, Math.min(200, limit)), this.listForTask(taskId).map(job => job.id));
  }

  createForTask(taskId: string, cwd: string, input: Pick<CronJobDto,
    "name" | "prompt" | "scheduleType" | "scheduleExpr" | "timezone" | "effectiveTo" | "maxRuns" | "restartPolicy"
  > & { target: "current-task" | "new-task" }): CronJobDto {
    const task = this.db.getTask(taskId);
    if (!task || task.archived) throw new Error("来源任务不存在或已归档");
    if (this.listForTask(taskId).filter(job => job.enabled).length >= 20) throw new Error("每个任务最多启用 20 个计划");
    return this.upsert({
      ...input, id: randomUUID(), sourceTaskId: taskId,
      target: input.target === "current-task" ? { kind: "task", taskId } : { kind: "new-task" },
      enabled: true, createdAt: Date.now(), updatedAt: Date.now(), cwd,
      permissionMode: task.permissionMode ?? "default", welcomeMode: task.welcomeMode,
      projectId: task.projectId ?? undefined, spaceId: task.spaceId ?? undefined,
      modelId: task.modelId, expertId: task.expertId,
    });
  }

  changeForTask(taskId: string, id: string, action: "pause" | "resume" | "cancel"): void {
    const job = this.db.getCronJob(id);
    if (!job || job.sourceTaskId !== taskId) throw new Error("计划不属于当前任务");
    if (action === "cancel") this.remove(id);
    else this.setEnabled(id, action === "resume");
  }

  upsert(job: CronJobDto): CronJobDto {
    assertSingleExpertId(job.expertId);
    validateSchedule(job);
    parseCronExecution({ sourceTaskId: job.sourceTaskId, target: job.target, maxRuns: job.maxRuns, restartPolicy: job.restartPolicy });
    const now = Date.now();
    const existing = this.db.getCronJob(job.id);
    const next: CronJobDto = {
      ...job,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      projectId: job.projectId ?? existing?.projectId,
    };
    const unavailable = this.unavailableReason(next);
    if (unavailable) throw new Error(unavailable);
    delete next.nextRunAt;
    delete next.runCount;
    this.db.upsertCronJob(next);
    this.disarm(next.id);
    if (next.enabled) this.arm(this.db.getCronJob(next.id) ?? next);
    const enriched = withNextRun(this.db.getCronJob(next.id) ?? next);
    broadcast(CronIpc.event, { type: "upsert", job: enriched });
    return enriched;
  }

  setEnabled(id: string, enabled: boolean): void {
    const job = this.db.getCronJob(id);
    if (!job) return;
    if (enabled) {
      const unavailable = this.unavailableReason(job);
      if (unavailable) throw new Error(unavailable);
      validateSchedule(job);
    }
    this.db.setCronEnabled(id, enabled);
    this.disarm(id);
    if (enabled) this.arm({ ...job, enabled: true });
    broadcast(CronIpc.event, { type: "upsert", job: withNextRun(this.db.getCronJob(id) ?? { ...job, enabled }) });
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
    const unavailable = this.unavailableReason(job);
    if (unavailable) throw new Error(unavailable);
    void this.execute(job, { force: true }).catch((err) => {
      console.error("[CronService] runNow failed", id, err);
    });
  }

  private arm(job: CronJobDto): void {
    this.disarm(job.id);
    if (this.stopped) return;
    const nextRun = computeNextRunAt(job);
    if (nextRun === undefined) {
      this.setEnabled(job.id, false);
      return;
    }
    const timer = scheduleTimer(nextRun, () => {
      void this.execute(job).catch((error) => console.error("[CronService] timer failed", job.id, error));
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

  private async execute(job: CronJobDto, opts?: { force?: boolean }): Promise<void> {
    if (this.stopped || this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id);
    const revision = this.revisions.get(job.id);
    let run: CronRunDto | undefined;
    let latest = this.db.getCronJob(job.id);
    let newTask = false;
    try {
      if (!latest || (!latest.enabled && !opts?.force)) return;
      latest = { ...latest, expertId: normalizeSingleExpertId(latest.expertId) };
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
      const currentUnavailable = this.unavailableReason(persisted);
      if (currentUnavailable) {
        await this.recordSkipped(persisted, currentUnavailable);
        this.setEnabled(job.id, false);
        return;
      }
      const target = targetId ? this.db.getTask(targetId) : undefined;
      if (targetId && this.agent.isTaskBusy(targetId)) {
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
        permissionMode: task.permissionMode ?? "default",
        welcomeMode: task.welcomeMode, spaceId: task.spaceId ?? undefined,
        modelId: task.modelId, expertId: task.expertId, modePresetId: target?.modePresetId,
        connectorIds: target ? undefined : latest.connectorIds,
        assistantMessageId: `cron-${run.id}-assistant`, userMessageId: `cron-${run.id}-input`,
      };
      const pendingRun = run;
      this.db.connection.transaction(() => {
        this.db.insertCronRun(pendingRun);
        this.db.connection.prepare("INSERT INTO cron_run_inputs VALUES (?, ?)").run(pendingRun.id, JSON.stringify({
          request, newTask, job: { id: latest!.id, name: latest!.name, projectId: latest!.projectId },
        }));
      })();
      this.db.touchCronLastRun(job.id);
      broadcast(CronIpc.event, { type: "run", run });
      await this.runInput(request);
      if (this.stopped) return;
      this.finishRun(latest, run, "success", newTask);
    } catch (error) {
      if (this.stopped && run) return;
      if (!latest) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!run && this.db.getCronJob(job.id)) {
        run = { id: randomUUID(), jobId: job.id, startedAt: Date.now(), status: "running" };
        this.db.insertCronRun(run);
      }
      if (run) this.finishRun(latest, run, "error", newTask, message);
    } finally {
      this.runningJobs.delete(job.id);
      const current = this.db.getCronJob(job.id);
      if (current?.enabled && !this.stopped && this.revisions.get(job.id) === revision) {
        if ((!opts?.force && current.scheduleType === "at") ||
          (current.maxRuns != null && (current.runCount ?? 0) >= current.maxRuns)) this.setEnabled(job.id, false);
        else this.arm(current);
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
    const job = this.db.getCronJob(run.jobId);
    let saved: z.infer<typeof storedCronRun> | undefined;
    try {
      if (!job || !run.taskId) throw new Error("找不到待恢复的计划或任务");
      const stored = this.db.connection.prepare("SELECT request_json FROM cron_run_inputs WHERE run_id = ?").get(run.id) as { request_json: string } | undefined;
      if (!stored) throw new Error("旧运行未保存操作身份，不能自动重放");
      saved = storedCronRun.parse(JSON.parse(stored.request_json));
      const { request } = saved;
      if (request.taskId !== run.taskId || request.userMessageId !== `cron-${run.id}-input`) throw new Error("计划运行的操作身份不一致");
      if (saved.job.id !== run.jobId) throw new Error("计划运行的来源身份不一致");
      await this.runInput(request);
      if (!this.stopped) this.finishRun(saved.job, run, "success", saved.newTask);
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        if (saved) this.finishRun(saved.job, run, "error", saved.newTask, message);
        else if (job) this.finishRun(job, run, "error", false, message);
        else this.db.finishCronRun(run.id, "error", message);
      }
    } finally {
      this.runningJobs.delete(run.jobId);
      const current = this.db.getCronJob(run.jobId);
      if (current?.enabled && !this.stopped) this.arm(current);
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
    if (run.taskId) this.notifyRun(job, run.id, run.taskId, status === "success" ? "success" : "failed", error);
  }

  private unavailableReason(job: CronJobDto): string | undefined {
    const project = this.projectUnavailableReason(job.projectId);
    if (project) return project;
    if (job.sourceTaskId) {
      const source = this.db.getTask(job.sourceTaskId);
      if (!source || source.archived) return "来源任务不存在或已归档，自动化已停用";
    }
    if (job.target?.kind === "task") {
      const target = this.db.getTask(job.target.taskId);
      if (!target || target.archived) return "目标任务不存在或已归档，自动化已停用";
      return this.projectUnavailableReason(target.projectId ?? undefined);
    }
    return undefined;
  }

  private notifyRun(job: RunJob, runId: string, taskId: string, status: "success" | "failed", error?: string): void {
    try {
      this.runNotificationSink?.({
        runId,
        jobId: job.id,
        jobName: job.name,
        taskId,
        projectId: job.projectId,
        status,
        error,
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
