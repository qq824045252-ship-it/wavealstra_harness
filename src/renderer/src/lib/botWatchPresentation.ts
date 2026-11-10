import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkStatusGroup } from "./botWorkspacePresentation";

/** Display persisted observations, not a promise that a watcher is always running. */
export function watchPresentation(work: WorkProjectionDto): { label: string; group: WorkStatusGroup } {
  const blockers = work.blockers.filter(item => item.status === "open" && item.kind !== "external_effect" && !item.unknownExternalEffectRef);
  if (blockers.some(item => item.waitingForUserInput)) return { label: "等待补充信息", group: "attention" };
  if (blockers.length) return { label: "检查受阻", group: "attention" };
  // Prior attempts and previous input snapshots must not revive an old failure.
  const attempts = work.executions.filter(item => item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && item.ownerEpoch === work.ownerEpoch
    && !item.invalidatedAt && item.status !== "invalidated");
  const latest = new Map<string, (typeof attempts)[number]>();
  for (const item of attempts) {
    const previous = latest.get(item.taskId);
    if (!previous || item.admittedAt >= previous.admittedAt) latest.set(item.taskId, item);
  }
  const current = [...latest.values()];
  if (current.some(item => item.status === "unknown")) return { label: "检查结果待核对", group: "attention" };
  if (work.phase4 && !work.phase4.host.online) return { label: "等待宿主恢复", group: "waiting" };
  if (current.some(item => item.status === "running")) return { label: "正在检查", group: "running" };
  if (current.some(item => item.status === "submitted" || item.status === "pending")) return { label: "等待检查执行", group: "waiting" };
  if (current.some(item => item.status === "failed" || item.status === "stopped")) return { label: "上次检查未完成", group: "attention" };
  if (!work.phase4) return { label: "跟踪状态待读取", group: "waiting" };
  const subscriptions = work.phase4.subscriptions.filter(item => item.status !== "stopped");
  if (!subscriptions.length) return { label: "暂无后续检查", group: "waiting" };
  if (subscriptions.every(item => item.status === "paused")) return { label: "检查订阅已暂停", group: "paused" };
  if (subscriptions.every(item => item.status !== "online")) return { label: "等待检查源恢复", group: "waiting" };
  const online = subscriptions.filter(item => item.status === "online");
  if (online.some(item => item.queue.blocked > 0)) return { label: "检查事件受阻", group: "attention" };
  if (online.some(item => item.queue.ready > 0 || item.queue.frozen > 0)) return { label: "等待处理检查事件", group: "waiting" };
  if (online.some(item => item.nextWakeAt !== undefined)) return { label: "等待下次检查", group: "watching" };
  // Event subscriptions are valid without a timer. A cron with no next wake is not.
  if (online.some(item => item.source !== "cron" && !item.cronExpression)) return { label: "等待来源变化", group: "watching" };
  return { label: "暂无后续检查", group: "waiting" };
}

export function nextWatchCheckAt(work: WorkProjectionDto): number | undefined {
  if (work.mode !== "watch" || work.lifecycle !== "active" || work.archive?.archivedAt) return undefined;
  const times = work.phase4?.subscriptions.filter(item => item.status === "online" && Number.isFinite(item.nextWakeAt))
    .map(item => item.nextWakeAt!) ?? [];
  return times.length ? Math.min(...times) : undefined;
}
