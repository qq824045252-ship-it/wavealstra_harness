import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { Cron } from "croner";
import {
  CronIpc,
  type CronJobDto,
  type CronRunDto,
  type PermissionMode,
} from "../../shared/agent-ipc";
import { assertSingleExpertId, normalizeSingleExpertId } from "../../shared/expert-id";
import type { AgentService } from "../agent/AgentService";
import type { AppDatabase } from "../db/AppDatabase";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function everyToCron(expr: string): string | null {
  const m = /^(\d+)([smhd])$/i.exec(expr.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === "s") return n >= 60 ? `*/${Math.floor(n / 60)} * * * * *` : `*/${n} * * * * *`;
  if (u === "m") return `0 */${n} * * * *`;
  if (u === "h") return `0 0 */${n} * * *`;
  if (u === "d") return `0 0 0 */${n} * *`;
  return null;
}

/** 是否处于生效区间内（两端含边界） */
function withinEffectiveRange(job: CronJobDto, now = Date.now()): "ok" | "before" | "after" {
  if (job.effectiveFrom != null && now < job.effectiveFrom) return "before";
  if (job.effectiveTo != null && now > job.effectiveTo) return "after";
  return "ok";
}

function computeNextRunAt(job: CronJobDto): number | undefined {
  if (!job.enabled) return undefined;
  if (withinEffectiveRange(job) === "after") return undefined;

  if (job.scheduleType === "at") {
    const at = new Date(job.scheduleExpr).getTime();
    if (Number.isNaN(at) || at <= Date.now()) return undefined;
    if (withinEffectiveRange(job, at) !== "ok") return undefined;
    return at;
  }

  let pattern = job.scheduleExpr;
  if (job.scheduleType === "every") {
    const converted = everyToCron(job.scheduleExpr);
    if (!converted) return undefined;
    pattern = converted;
  }

  try {
    const cron = new Cron(pattern, {
      timezone: job.timezone || "Asia/Shanghai",
    });
    const runs = cron.nextRuns(32);
    for (const d of runs) {
      const t = d.getTime();
      if (withinEffectiveRange(job, t) === "ok") return t;
    }
    return undefined;
  } catch {
    return undefined;
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
  private readonly timers = new Map<string, Cron>();

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: AgentService,
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
  ) {}

  start(): void {
    for (const job of this.db.listCronJobs()) {
      if (!job.enabled) continue;
      const unavailable = this.projectUnavailableReason(job.projectId);
      if (unavailable) {
        this.db.setCronEnabled(job.id, false);
        console.info(`[CronService] disabled project job ${job.id}: ${unavailable}`);
        continue;
      }
      this.arm(job);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
  }

  list(): CronJobDto[] {
    return this.db.listCronJobs().map(withNextRun);
  }

  listRuns(limit = 50): CronRunDto[] {
    return this.db.listCronRuns(limit);
  }

  upsert(job: CronJobDto): CronJobDto {
    assertSingleExpertId(job.expertId);
    const now = Date.now();
    const existing = this.db.getCronJob(job.id);
    const next: CronJobDto = {
      ...job,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      projectId: job.projectId ?? existing?.projectId,
    };
    const unavailable = this.projectUnavailableReason(next.projectId);
    if (unavailable) throw new Error(unavailable);
    delete (next as { nextRunAt?: number }).nextRunAt;
    this.db.upsertCronJob(next);
    this.disarm(next.id);
    if (next.enabled) this.arm(next);
    const enriched = withNextRun(this.db.getCronJob(next.id) ?? next);
    broadcast(CronIpc.event, { type: "upsert", job: enriched });
    return enriched;
  }

  setEnabled(id: string, enabled: boolean): void {
    const job = this.db.getCronJob(id);
    if (!job) return;
    if (enabled) {
      const unavailable = this.projectUnavailableReason(job.projectId);
      if (unavailable) throw new Error(unavailable);
    }
    this.db.setCronEnabled(id, enabled);
    this.disarm(id);
    if (enabled) this.arm({ ...job, enabled: true });
    broadcast(CronIpc.event, { type: "upsert", job: withNextRun({ ...job, enabled }) });
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
    const unavailable = this.projectUnavailableReason(job.projectId);
    if (unavailable) throw new Error(unavailable);
    void this.execute(job, { force: true }).catch((err) => {
      console.error("[CronService] runNow failed", id, err);
    });
  }

  private arm(job: CronJobDto): void {
    this.disarm(job.id);

    if (job.effectiveTo != null && Date.now() > job.effectiveTo) {
      console.info("[CronService] skip arm (expired)", job.id);
      return;
    }

    if (job.scheduleType === "at") {
      const at = new Date(job.scheduleExpr);
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return;
      if (withinEffectiveRange(job, at.getTime()) !== "ok") {
        console.info("[CronService] skip arm at (outside effective range)", job.id);
        return;
      }
      const delay = at.getTime() - Date.now();
      const handle = setTimeout(() => {
        void this.execute(job);
      }, delay);
      this.timers.set(
        job.id,
        {
          stop: () => clearTimeout(handle),
        } as unknown as Cron,
      );
      return;
    }

    let pattern = job.scheduleExpr;
    if (job.scheduleType === "every") {
      const converted = everyToCron(job.scheduleExpr);
      if (!converted) {
        console.warn("[CronService] invalid every expr", job.scheduleExpr);
        return;
      }
      pattern = converted;
    }

    try {
      const cron = new Cron(
        pattern,
        {
          timezone: job.timezone || "Asia/Shanghai",
          protect: true,
        },
        () => {
          void this.execute(job);
        },
      );
      this.timers.set(job.id, cron);
    } catch (err) {
      console.warn("[CronService] failed to arm", job.id, err);
    }
  }

  private disarm(id: string): void {
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
    const persisted = this.db.getCronJob(job.id) ?? job;
    const latest: CronJobDto = { ...persisted, expertId: normalizeSingleExpertId(persisted.expertId) };
    if (!latest.enabled && !opts?.force) return;

    const unavailable = this.projectUnavailableReason(latest.projectId);
    if (unavailable) {
      this.db.setCronEnabled(latest.id, false);
      this.disarm(latest.id);
      await this.recordSkipped(latest, unavailable);
      broadcast(CronIpc.event, { type: "upsert", job: withNextRun({ ...latest, enabled: false }) });
      return;
    }

    const range = withinEffectiveRange(latest);
    if (!opts?.force && range !== "ok") {
      const reason =
        range === "before" ? "未到生效日期，已跳过" : "已过生效日期，已跳过";
      await this.recordSkipped(latest, reason);
      if (range === "after") {
        this.db.setCronEnabled(latest.id, false);
        this.disarm(latest.id);
        broadcast(CronIpc.event, {
          type: "upsert",
          job: { ...latest, enabled: false },
        });
      }
      return;
    }

    const runId = randomUUID();
    const taskId = `cron-${latest.id}-${Date.now()}`;
    const permissionMode: PermissionMode = latest.permissionMode ?? "auto";
    const welcomeMode =
      latest.welcomeMode === "coding" || latest.welcomeMode === "design"
        ? latest.welcomeMode
        : "working";
    // 默认模型：任务未指定时走应用默认，避免空 model 导致秒退空回复
    const modelId =
      latest.modelId?.trim() ||
      this.agent.getAppSettings?.()?.defaultModelId ||
      undefined;

    // 必须先落库任务（正确标题），再广播 run；否则 UI 竞态拿到「定时任务」占位标题，
    // 且 agent 事件到达时侧栏还没有 task，流式补丁会被丢弃。
    this.db.upsertTask({
      id: taskId,
      title: latest.name,
      spaceId: latest.spaceId ?? null,
      projectId: latest.projectId,
      status: "in_progress",
      updatedAt: Date.now(),
      modelId,
      permissionMode,
      expertId: latest.expertId,
      welcomeMode,
    });

    const run: CronRunDto = {
      id: runId,
      jobId: latest.id,
      startedAt: Date.now(),
      status: "running",
      taskId,
    };
    this.db.insertCronRun(run);
    this.db.touchCronLastRun(latest.id);
    broadcast(CronIpc.event, { type: "run", run });

    const assistantMessageId = `asst-${randomUUID()}`;
    const userMessageId = `user-${randomUUID()}`;
    const promptText = this.composePrompt(latest);

    try {
      await this.agent.prompt({
        taskId,
        text: promptText,
        permissionMode,
        welcomeMode,
        spaceId: latest.spaceId,
        modelId,
        expertId: latest.expertId,
        assistantMessageId,
        userMessageId,
      });

      // 校验是否真有助手产出（空回复 / 秒退 视为失败，避免 UI 显示「已完成 0ms」空白）
      const history = await this.agent.loadTaskHistory(taskId);
      const assistantText = (history.messages ?? [])
        .filter((m) => m.role === "assistant")
        .map((m) => (m.text ?? "").trim())
        .join("\n")
        .trim();
      if (!assistantText) {
        const errMsg = "模型未返回有效内容（请检查模型配置与网络后重试）";
        this.db.finishCronRun(runId, "error", errMsg, taskId);
        this.db.upsertTask({
          id: taskId,
          title: latest.name,
          spaceId: latest.spaceId ?? null,
          projectId: latest.projectId,
          status: "failed",
          updatedAt: Date.now(),
          modelId,
          permissionMode,
          expertId: latest.expertId,
          welcomeMode,
        });
        broadcast(CronIpc.event, {
          type: "run",
          run: { ...run, status: "error", error: errMsg, finishedAt: Date.now() },
        });
        this.notifyProjectRun(latest, runId, "failed", errMsg);
        this.notifyRun(latest, runId, taskId, "failed", errMsg);
        return;
      }

      this.db.finishCronRun(runId, "success", undefined, taskId);
      // 再次写回标题：createSession / bindTaskExecutionWorkspaceCwd 可能把标题改成「定时任务」
      this.db.upsertTask({
        id: taskId,
        title: latest.name,
        spaceId: latest.spaceId ?? null,
        projectId: latest.projectId,
        status: "completed",
        updatedAt: Date.now(),
        modelId,
        permissionMode,
        expertId: latest.expertId,
        welcomeMode,
      });
      broadcast(CronIpc.event, {
        type: "run",
        run: { ...run, status: "success", finishedAt: Date.now() },
      });
      this.notifyProjectRun(latest, runId, "success");
      this.notifyRun(latest, runId, taskId, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.finishCronRun(runId, "error", message, taskId);
      this.db.upsertTask({
        id: taskId,
        title: latest.name,
        spaceId: latest.spaceId ?? null,
        projectId: latest.projectId,
        status: "failed",
        updatedAt: Date.now(),
        modelId,
        permissionMode,
        expertId: latest.expertId,
        welcomeMode,
      });
      broadcast(CronIpc.event, {
        type: "run",
        run: { ...run, status: "error", error: message, finishedAt: Date.now() },
      });
      this.notifyProjectRun(latest, runId, "failed", message);
      this.notifyRun(latest, runId, taskId, "failed", message);
    }
  }

  private notifyRun(job: CronJobDto, runId: string, taskId: string, status: "success" | "failed", error?: string): void {
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
  private notifyProjectRun(job: CronJobDto, runId: string, status: "success" | "failed", error?: string): void {
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
