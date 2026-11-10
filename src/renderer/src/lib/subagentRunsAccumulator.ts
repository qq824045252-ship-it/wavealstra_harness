/**
 * subagentRunsAccumulator.ts — 让「已经出现过的子代理」不会凭空消失。
 *
 * 为什么需要：概览的完成态是从当前 task 的内存消息窗口派生的（tool call details.results[]）。
 * 窗口会随上下文压缩/历史前滚驱逐旧消息，一次长任务里几百轮之后，早些完成的那批
 * 子代理就整体消失了；对用户来说这读作「我的子代理丢了」。
 *
 * 规则（只补可见性，不伪造状态）：
 * - 本次派生里存在的条目永远用最新的（最新态优先，同一 id 只会出现一次）；
 * - 本次派生里消失、但之前见过的条目 → 补成「已结束」，状态记 unknown（不是 completed）；
 * - 运行中/排队中消失且没有结果 → 同样降级为已结束/unknown，不猜成功与否；
 * - 每 task 最多记住 MAX_REMEMBERED_RUNS 条，超出丢最旧的。
 *
 * 纯函数在上面、模块级 Map 只按 taskId 记账（渲染层单会话内的事实）。
 */
import type {
  DoneSubagentVm,
  RunningSubagentVm,
  RuntimeOverviewVm,
} from "@/components/artifact/overview/overviewRuntime";
import { oneLine } from "@/components/artifact/overview/overviewRuntime";

export const MAX_REMEMBERED_RUNS = 200;

/** 运行中条目消失且没有结果时的降级行：状态未知，绝不写成“已完成”。 */
export function runningToDone(row: RunningSubagentVm): DoneSubagentVm {
  return {
    id: row.id,
    state: "unknown",
    name: row.name,
    displayName: row.displayName,
    summary: oneLine(row.work, 64),
    count: 1,
    task: row.work,
    cwd: row.cwd,
    durationMs: row.elapsedMs > 0 ? row.elapsedMs : undefined,
    model: row.model,
    usage: row.usage,
  };
}

/**
 * 排队中条目不记账：它从未真正开始（没有子会话、没有结果），派发取消后把
 * 一个「没跑过的计划」永久留在完成态只是噪声。排队行永远只反映当前活着的 plan。
 */

/**
 * 把「记住的、但本次派生里已经不存在」的条目并回完成态列表。
 * 记忆里的行优先（它们更早），当前完成态跟在后面（与消息时间线同序）。
 */
export function mergeRememberedRuns(
  remembered: DoneSubagentVm[],
  vm: RuntimeOverviewVm,
): DoneSubagentVm[] {
  if (remembered.length === 0) return vm.doneSubagents;
  const present = new Set<string>([
    ...vm.runningSubagents.map((row) => row.id),
    ...vm.queuedSubagents.map((row) => row.id),
    ...vm.doneSubagents.map((row) => row.id),
  ]);
  const carried = remembered.filter((row) => !present.has(row.id));
  return carried.length === 0 ? vm.doneSubagents : [...carried, ...vm.doneSubagents];
}

type Entry =
  | { order: number; kind: "done"; done: DoneSubagentVm }
  | { order: number; kind: "running"; running: RunningSubagentVm };

const store = new Map<string, Map<string, Entry>>();
let sequence = 0;

/** 记忆条目 → 补进完成态的行（只用于「本次派生里已不存在」的条目）。 */
function entryToDone(entry: Entry): DoneSubagentVm {
  return entry.kind === "done" ? entry.done : runningToDone(entry.running);
}

/**
 * 记一笔并按上面规则返回合并后的概览。
 * 幂等：同一份派生连跑两次（React StrictMode）结果一致。
 */
export function accumulateSubagentRuns(taskId: string, vm: RuntimeOverviewVm): RuntimeOverviewVm {
  if (!taskId) return vm;
  let entries = store.get(taskId);
  if (!entries) {
    entries = new Map();
    store.set(taskId, entries);
  }
  const set = (id: string, entry: Entry): void => {
    const previous = entries!.get(id);
    entries!.set(id, { ...entry, order: previous?.order ?? sequence++ } as Entry);
  };
  // 最新态优先：同一 id 在本次派生里只应归入一个分组
  for (const row of vm.runningSubagents) set(row.id, { order: 0, kind: "running", running: row });
  for (const row of vm.doneSubagents) set(row.id, { order: 0, kind: "done", done: row });

  const ordered = [...entries.entries()].sort((a, b) => a[1].order - b[1].order);
  // 上限保护：一直跑的长任务不能无限记账
  if (ordered.length > MAX_REMEMBERED_RUNS) {
    for (const [id] of ordered.slice(0, ordered.length - MAX_REMEMBERED_RUNS)) entries.delete(id);
  }
  const remembered = [...entries.values()]
    .sort((a, b) => a.order - b.order)
    .map(entryToDone);
  return { ...vm, doneSubagents: mergeRememberedRuns(remembered, vm) };
}

/** 仅测试用：清空记账。 */
export function resetSubagentRunsAccumulator(taskId?: string): void {
  if (taskId) store.delete(taskId);
  else store.clear();
}
