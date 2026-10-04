/**
 * ProjectCadence — 项目时间边界调度器（Time Boundary / Cadence Engine）。
 *
 * 必要性：Attention/Proposal 有纯时间派生规则（todo 逾期、3 天临期、doing/active 任务 7 天停滞），
 * 即使零业务写入，时间越过边界也会改变注意度。纯事件驱动会漏报，故为每个项目维护
 * “下一个可能改变状态的时间边界”，到点触发重算（不后台执行任何业务写）。
 *
 * 约束：
 * - 每项目至多一个 timer（有界；不按 source 建定时器，无全库扫描循环）；
 * - 触发仅做：proposal 确定性重生成（只写审计/建议层）+ Attention 重算广播（由 onBoundary 注入）；
 * - 启动调用 scheduleAll 从真源重建边界；resume/时钟跳变调用 catchUp（一次性有界重算，
 *   指纹去重广播，错过边界不丢——状态即真源，重算即 catch-up）；
 * - 极远边界：delay 钳制到 2^31-1 ms（Node setTimeout 上限），提前触发后重算并重新调度（安全环）；
 * - 时钟回拨/跳变：触发与调度一律以注入 now 重算，不信任旧 timeout。
 */
import type { ProjectDto } from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";

export const STALE_TASK_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const NEAR_DUE_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const MAX_TIMER_DELAY_MS = 0x7fffffff;

export interface CadenceScheduler {
  schedule(fn: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const defaultScheduler: CadenceScheduler = {
  schedule: (fn, delayMs) => setTimeout(fn, Math.min(delayMs, MAX_TIMER_DELAY_MS)),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ProjectCadenceOptions {
  /** 边界触发回调（调用方注入：proposal 重生成 + Attention 重算广播；绝不 apply） */
  onBoundary?: (projectId: string) => void;
  scheduler?: CadenceScheduler;
  now?: () => number;
}

export class ProjectCadence {
  private readonly timers = new Map<string, unknown>();
  private readonly scheduler: CadenceScheduler;
  private readonly now: () => number;

  constructor(
    private readonly projects: ProjectService,
    private readonly opts: ProjectCadenceOptions = {},
  ) {
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 纯计算：项目下一个可能改变注意度的时间边界（epoch ms）。
   * - 计划项（非 done）：dueAt（进入 overdue）、dueAt-3d（进入 near-risk）；
   * - 任务（active：非 archived/completed/failed）：updatedAt+7d（进入 stale）；
   * 只取未来（> now）的最近边界；无未来边界 → null。
   */
  nextBoundary(projectId: string, now = this.now()): number | null {
    let project: ProjectDto | undefined;
    try {
      project = this.projects.get(projectId);
    } catch {
      return null;
    }
    if (!project) return null;
    let next: number | null = null;
    const consider = (t: number): void => {
      if (t > now && (next === null || t < next)) next = t;
    };
    const todos = this.projects.listTodos(projectId);
    for (const todo of todos) {
      if (todo.status === "done" || todo.dueAt === undefined) continue;
      consider(todo.dueAt);
      consider(todo.dueAt - NEAR_DUE_WINDOW_MS);
    }
    const tasks = this.projects.listTasksByProject(projectId);
    for (const task of tasks) {
      if (task.archived || task.status === "completed" || task.status === "failed") continue;
      consider(task.updated_at + STALE_TASK_WINDOW_MS);
    }
    return next;
  }

  /** 为项目调度下一个边界（先清旧 timer；无边界则取消；读源失败安全取消不抛出） */
  schedule(projectId: string, now = this.now()): void {
    this.cancel(projectId);
    let boundary: number | null;
    try {
      boundary = this.nextBoundary(projectId, now);
    } catch {
      return; // 读源失败：不保留 timer（fail-safe），后续业务写入/启动会重建
    }
    if (boundary === null) return;
    // 钳制到 JS timer 上限：极远边界提前触发 → fire 重算后重新调度（安全环）
    const delay = Math.min(Math.max(0, boundary - now), MAX_TIMER_DELAY_MS);
    const handle = this.scheduler.schedule(() => this.fire(projectId), delay);
    this.timers.set(projectId, handle);
  }

  /** 取消项目边界（项目删除/归档） */
  cancel(projectId: string): void {
    const handle = this.timers.get(projectId);
    if (handle !== undefined) {
      this.scheduler.clear(handle);
      this.timers.delete(projectId);
    }
  }

  /** 启动/恢复：从真源重建全部边界（先清后建；已过期边界自然被忽略，状态即真源 catch-up） */
  scheduleAll(now = this.now()): void {
    for (const projectId of [...this.timers.keys()]) this.cancel(projectId);
    let projects: ProjectDto[];
    try {
      projects = this.projects.list(true);
    } catch {
      return;
    }
    for (const project of projects) this.schedule(project.id, now);
  }

  /**
   * 错过边界 catch-up：按当前 now 对全部项目各触发一次 onBoundary（重算+指纹去重广播）。
   * 一次性有界扫描（非定时）；休眠恢复/时钟跳变后调用，保证错过边界不“永远漏掉”。
   * timer 重建由调用方随后 scheduleAll（或 onBoundary 内部自带 schedule）完成。
   */
  catchUp(): void {
    let projects: ProjectDto[];
    try {
      projects = this.projects.list(true);
    } catch {
      return;
    }
    for (const project of projects) {
      try {
        this.opts.onBoundary?.(project.id);
      } catch (err) {
        console.warn(`[ProjectCadence] catch-up 触发失败 ${project.id}：`, err);
      }
    }
  }

  /** 进行中的 timer 数（有界性审计/测试） */
  activeCount(): number {
    return this.timers.size;
  }

  shutdown(): void {
    for (const projectId of [...this.timers.keys()]) this.cancel(projectId);
  }

  private fire(projectId: string): void {
    // 先释放已触发的 handle（真实 setTimeout 是 no-op；可注入 scheduler 需显式释放），
    // 再触发回调、以当前时间重算下一个边界（时钟回拨/跳变安全：不信任旧 timeout）
    const handle = this.timers.get(projectId);
    if (handle !== undefined) {
      this.scheduler.clear(handle);
      this.timers.delete(projectId);
    }
    try {
      this.opts.onBoundary?.(projectId);
    } catch (err) {
      console.warn(`[ProjectCadence] 边界触发失败 ${projectId}：`, err);
    }
    this.schedule(projectId);
  }
}
