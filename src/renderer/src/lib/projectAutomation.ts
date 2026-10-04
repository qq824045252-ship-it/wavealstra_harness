/**
 * 项目配置里的自动化：按 projectId 划分全局 / 项目任务。
 * 纯计算，方便 node 测试。
 */
import type { CronJobDto, CronRunDto } from "@shared/agent-ipc";

/** 无 projectId → 全部（全局页）；有则只返回绑在该项目上的任务 */
export function jobsForProject(jobs: readonly CronJobDto[], projectId?: string | null): CronJobDto[] {
  if (!projectId) return [...jobs];
  return jobs.filter((job) => job.projectId === projectId);
}

/** 只保留属于给定任务集合的运行记录 */
export function runsForJobs(runs: readonly CronRunDto[], jobs: readonly CronJobDto[]): CronRunDto[] {
  const ids = new Set(jobs.map((job) => job.id));
  return runs.filter((run) => ids.has(run.jobId));
}

/**
 * 保存时的项目绑定：已有任务保持原绑定；新建则用当前作用域。
 * 全局页新建 → undefined；项目弹窗新建 → 当前项目。
 */
export function resolveJobProjectId(args: {
  existingProjectId?: string;
  scopeProjectId?: string;
}): string | undefined {
  return args.existingProjectId ?? args.scopeProjectId;
}
