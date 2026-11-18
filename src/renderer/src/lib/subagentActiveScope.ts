/**
 * subagentActiveScope.ts — 「运行中子代理」快照必须连同它的作用域一起读。
 *
 * 为什么需要：active(taskId) 是异步的，切任务时上一个任务的响应/旧 state 仍会留在
 * 组件里一帧。若把那一帧的列表直接喂给 buildRuntimeOverview，`accumulateSubagentRuns`
 * 会把别的任务的实例**永久记账**到新任务名下（子代理已经不在新任务里 → 下一帧降级成
 * 「已结束 / 状态未知」）。用户看到的就是：右上角子代理面板把上一个任务的子代理串到
 * 每一个任务里，而且重启前不会消失。
 *
 * 规则：快照自带它采集时的 taskId，只有与当前 taskId 完全一致才返回列表；
 * 任何「还没取到/取错了作用域」的情况一律返回稳定的空表，绝不做跨任务并集。
 */
import type { SubagentSummaryDto } from "@shared/agent-ipc";

export interface ActiveSubagentSnapshot {
  /** 这份列表是在哪个 taskId 下取的；空串表示「没有作用域」 */
  taskId: string;
  list: SubagentSummaryDto[];
}

/** 稳定的空表：让 useMemo 依赖不会因为每次新建数组而失效。 */
export const EMPTY_ACTIVE_SUBAGENTS: SubagentSummaryDto[] = [];
// 冻结可防止任一调用方往里 push 后把它当成“当前任务的列表”。
Object.freeze(EMPTY_ACTIVE_SUBAGENTS);

/** 作用域归一：非字符串/空白一律视为无作用域（与主进程 subagent-ipc-host 同一口径）。 */
function normalizeScope(taskId: string | null | undefined): string {
  return typeof taskId === "string" ? taskId.trim() : "";
}

/**
 * 只在快照作用域与当前任务一致时返回列表。
 * 不一致（切任务后的过渡帧、旧响应、空作用域）→ 空表，调用方不会把别处实例记进当前任务。
 */
export function scopeActiveSubagents(
  snapshot: ActiveSubagentSnapshot,
  taskId: string | null | undefined,
): SubagentSummaryDto[] {
  const scope = normalizeScope(taskId);
  if (!scope) return EMPTY_ACTIVE_SUBAGENTS;
  return snapshot.taskId === scope ? snapshot.list : EMPTY_ACTIVE_SUBAGENTS;
}
