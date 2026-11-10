/**
 * useSubagentRuns — 当前任务子代理运行态的唯一数据源。
 *
 * 侧栏「概览」与顶栏子代理查看器都读这里，保证两处显示的是同一批实例、同一套名字、
 * 同一份用量与状态（用户能看到的差异只允许是排版，不允许是数据）。
 *
 * 数据源沿用既有、task-scoped 的事实：
 * - 运行中：window.api.subagent.active(taskId)（主进程按 taskId 过滤）；
 * - 排队/完成：当前 task 消息里 subagent 工具调用的 details（plan / results）；
 * - 后台任务：终端会话 + 运行中 bash 调用。
 * 这里只做聚合与 1s tick（让耗时自然增长），不新增 IPC、不伪造状态。
 */
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import {
  buildRuntimeOverview,
  type RuntimeOverviewVm,
} from "@/components/artifact/overview/overviewRuntime";
import { accumulateSubagentRuns } from "@/lib/subagentRunsAccumulator";

export interface SubagentRuns {
  vm: RuntimeOverviewVm;
  /** 运行中 + 排队中 + 已完成（去重后的展示条目数） */
  total: number;
  running: number;
  queued: number;
  /** 运行中子代理的实例 id 集合（对话页判断「是否还能 steer」） */
  runningIds: Set<string>;
  /** 按 id 找一条当前可见的子代理（对话页标题与状态） */
  find: (id: string | null | undefined) =>
    | { kind: "running"; row: RuntimeOverviewVm["runningSubagents"][number] }
    | { kind: "queued"; row: RuntimeOverviewVm["queuedSubagents"][number] }
    | { kind: "done"; row: RuntimeOverviewVm["doneSubagents"][number] }
    | null;
}

export function useSubagentRuns(taskId: string | null | undefined, nowOverride?: number): SubagentRuns {
  const tasks = useAppStore((s) => s.tasks);
  const terminalSessions = useAppStore((s) => s.terminalSessions);
  const activeModelId = useAppStore((s) => s.activeModelId);
  const models = useAppStore((s) => s.models);
  const [activeSubagents, setActiveSubagents] = useState<SubagentSummaryDto[]>([]);
  const [internalNow, setInternalNow] = useState(() => Date.now());
  // 调用方已有自己的 tick（侧栏还要驱动外部子任务与终端的耗时）时复用它，不造第二个定时器
  const now = nowOverride ?? internalNow;

  const task = useMemo(() => tasks.find((t) => t.id === taskId) ?? null, [tasks, taskId]);
  const messages = task?.messages ?? [];

  // 运行中实例：事件驱动 + 任务切换重置（旧任务的响应不得污染新任务）
  useEffect(() => {
    if (!taskId) {
      setActiveSubagents([]);
      return;
    }
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const list = await window.api?.subagent?.active?.(taskId);
        if (!disposed) setActiveSubagents(list ?? []);
      } catch {
        if (!disposed) setActiveSubagents([]);
      }
    };
    void refresh();
    const unsub = window.api?.subagent?.onEvent?.(() => void refresh());
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [taskId]);

  const modelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const model of models ?? []) {
      const id = (model?.id ?? "").trim();
      if (id) map[id] = model.name;
    }
    return map;
  }, [models]);

  const fallbackModel = useMemo(
    () => ({ id: activeModelId, name: activeModelId ? modelNames[activeModelId] : undefined }),
    [activeModelId, modelNames],
  );

  const vm = useMemo(
    () =>
      // 记账是幂等的（同一份派生连跑两次结果一致），为了不出现「消失一帧再回来」的闪烁，
      // 这里同步合并，而不是等 effect 补。
      accumulateSubagentRuns(
        taskId ?? "",
        buildRuntimeOverview({
          taskId: taskId ?? "",
          workspaceId: task?.spaceId,
          messages,
          activeSubagents,
          terminalSessions,
          now,
          mainModel: fallbackModel,
          modelNames,
        }),
      ),
    [taskId, task?.spaceId, messages, activeSubagents, terminalSessions, now, fallbackModel, modelNames],
  );

  // 只有存在运行中条目时才有「耗时在涨」需要刷新；空闲概览不产生无意义重渲染
  const hasRunning = vm.runningSubagents.length > 0;
  useEffect(() => {
    if (!hasRunning || nowOverride !== undefined) return;
    const timer = setInterval(() => setInternalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning, nowOverride]);

  const runningIds = useMemo(() => new Set(vm.runningSubagents.map((row) => row.id)), [vm.runningSubagents]);

  return useMemo<SubagentRuns>(() => {
    const find: SubagentRuns["find"] = (id) => {
      if (!id) return null;
      const running = vm.runningSubagents.find((row) => row.id === id);
      if (running) return { kind: "running", row: running };
      const queuedRow = vm.queuedSubagents.find((row) => row.id === id);
      if (queuedRow) return { kind: "queued", row: queuedRow };
      const done = vm.doneSubagents.find((row) => row.id === id);
      return done ? { kind: "done", row: done } : null;
    };
    return {
      vm,
      total: vm.runningSubagents.length + vm.queuedSubagents.length + vm.doneSubagents.length,
      running: vm.runningSubagents.length,
      queued: vm.queuedSubagents.length,
      runningIds,
      find,
    };
  }, [vm, runningIds]);
}
