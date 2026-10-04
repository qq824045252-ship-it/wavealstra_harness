/**
 * overviewRuntime.ts — 「概览」Runtime Observatory 的纯 view-model 派生（可测）。
 *
 * 数据源（全部现有、task-scoped、事件驱动，无新增轮询 IPC）：
 * - 主 Agent：当前 task 消息（streaming 标志 + 运行中 tool call 摘要）；
 * - 运行中子代理：window.api.subagent.active()（主进程按当前 session scope 过滤）；
 * - 完成态子代理：当前 task 消息中的 subagent tool calls（task 生命周期内短暂记录；
 *   Subagent 本体仍 disposable，terminal 即销毁，此处只是聊天时间线派生视图）；
 * - 后台任务：当前 task 的终端会话（TerminalSessionInfo：alive/exitCode/startedAt）
 *   + 运行中的 bash 工具调用（无 exit code 事件 → 不伪造 exit）。
 *
 * 约定：所有解析均防御性；无法可靠判断的字段宁缺毋伪造。
 */
import type { ChatMessage } from "@/types";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import type { TerminalSessionInfo } from "@shared/terminal-ipc";
import { extractSubagentIdFromToolResult } from "@shared/subagent-model-config";

// ---------- 类型 ----------

export type MainAgentState = "idle" | "working";

export interface MainAgentVm {
  state: MainAgentState;
  /** 紧凑状态文案：运行中 / 空闲 / 等待 */
  label: string;
  /** 一行动作摘要（如「正在实现 WebAccess」）；无则 undefined */
  action?: string;
}

export interface RunningSubagentVm {
  id: string;
  role: string;
  work: string;
  elapsedMs: number;
  model?: string;
}

export type DoneSubagentState = "completed" | "failed" | "cancelled";

export interface DoneSubagentVm {
  id: string;
  state: DoneSubagentState;
  /** 结果摘要（finalText/错误首行截断） */
  summary: string;
  /** 该实例在本 task 内的工具调用次数（去重后的聚合计数） */
  count: number;
}

export type BackgroundState = "running" | "completed" | "failed";

export interface BackgroundTaskVm {
  key: string;
  name: string;
  state: BackgroundState;
  /** 仅当真实数据有 exit code 时提供；bash 工具调用无该事件 → 不伪造 */
  exitCode?: number;
  elapsedMs?: number;
}

export interface RuntimeOverviewVm {
  mainAgent: MainAgentVm;
  runningSubagents: RunningSubagentVm[];
  doneSubagents: DoneSubagentVm[];
  backgroundTasks: BackgroundTaskVm[];
}

export interface OverviewInputs {
  taskId: string;
  /** 当前任务所属空间；有绑定文件夹时终端会话键是 workspaceId */
  workspaceId?: string;
  messages: ChatMessage[];
  activeSubagents: SubagentSummaryDto[];
  terminalSessions: Record<string, TerminalSessionInfo>;
  now: number;
}

// ---------- 纯工具 ----------

/** 紧凑耗时：<1s → "刚刚"；<60s → "12s"；<1h → "1m 32s"；其余 → "1h 05m"。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const s = Math.floor(ms / 1000);
  if (s < 1) return "刚刚";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 运行中子代理的可读 role：DTO role 优先，缺失回退 id 短形式（防御性）。 */
export function readableRole(id: string, role?: string | null): string {
  const r = (role ?? "").trim();
  if (r) return r;
  if (id && id.length > 12) return `${id.slice(0, 12)}…`;
  return id || "subagent";
}

/** 单行截断（保留换行仅取首行 + 限长）。 */
export function oneLine(text: string, max = 64): string {
  const first = (text ?? "").split("\n")[0]?.trim() ?? "";
  if (!first) return "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

// ---------- 主 Agent ----------

export function buildMainAgent(messages: ChatMessage[]): MainAgentVm {
  // 最后一条消息是 user：agent 尚未开始响应（无 streaming 标记可区分）→ 等待
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    return { state: "idle", label: "等待" };
  }
  // 从后往前找最后一条 assistant 消息（其 streaming 标志是主 Agent 运行态）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const running = msg.streaming === true;
    if (!running) return { state: "idle", label: "空闲" };
    // 动作摘要：最近一个运行中 tool call（从后往前）
    for (let b = (msg.blocks ?? []).length - 1; b >= 0; b--) {
      const block = msg.blocks[b];
      if (block.type === "tool" && block.toolCall.status === "running") {
        const summary = oneLine(block.toolCall.summary || block.toolCall.tool, 48);
        return { state: "working", label: "运行中", action: summary ? `正在 ${summary}` : undefined };
      }
    }
    return { state: "working", label: "运行中", action: "正在生成回复…" };
  }
  return { state: "idle", label: "等待" };
}

// ---------- 子代理 ----------

/** 运行中子代理：status=running，或 idle 但 worker 存活（工具调用间隙）。 */
function isActiveInstance(dto: SubagentSummaryDto): boolean {
  return dto.status === "running" || (dto.status === "idle" && dto.workerAlive === true);
}

export function buildRunningSubagents(dtos: SubagentSummaryDto[], now: number): RunningSubagentVm[] {
  return (dtos ?? [])
    .filter(isActiveInstance)
    .map((d) => ({
      id: d.subagentId,
      role: readableRole(d.subagentId, d.role),
      work: oneLine(d.lastTask || (d.status === "running" ? "运行中" : "等待工具调用"), 56) || "运行中",
      elapsedMs: now - (d.lastPromptAt ?? d.createdAt ?? now),
      model: d.model,
    }));
}

/**
 * 完成态子代理：当前 task 消息中的 subagent 工具调用（RESULT/FAILED/CANCELLED 后
 * 扩展已销毁实例，聊天时间线是唯一残留；随 task 生命周期自然消失，不进全局历史）。
 * 防御性：无法提取 id 的调用直接忽略（与 ToolCallCard chip 同语义）。
 * 同一实例多次调用（复用运行中）：状态与摘要取**最后一次**（最终态），计数累计 ×N。
 */
export function buildDoneSubagents(messages: ChatMessage[]): DoneSubagentVm[] {
  const map = new Map<string, { state: DoneSubagentState; summary: string; count: number }>();
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "subagent") continue;
      const tc = block.toolCall;
      if (tc.status === "pending_approval" || tc.status === "running") continue; // 未终结：运行中由 IPC 侧覆盖
      const id = extractSubagentId(tc.output, tc.detail);
      if (!id) continue;
      const state: DoneSubagentState =
        tc.status === "success" ? "completed" : tc.status === "error" ? "failed" : "cancelled";
      const prev = map.get(id);
      const summary = pickSummary(tc, state, prev?.summary);
      // 状态取最新（后一次调用覆盖前一次）；空摘要保留旧值
      map.set(id, { state, summary, count: (prev?.count ?? 0) + 1 });
    }
  }
  return [...map.entries()].map(([id, v]) => ({ id, state: v.state, summary: v.summary, count: v.count }));
}

/** 集中式 subagent id 解析：统一复用 shared 单 parser（与 ToolCallCard chip 同源）。 */
export function extractSubagentId(output: string | undefined, detail: string | undefined): string | null {
  return extractSubagentIdFromToolResult("subagent", output, detail);
}

/** 完成态摘要：优先 output 中 finalText（去 id 行），否则按状态给默认文案。 */
function pickSummary(tc: { output?: string }, state: DoneSubagentState, prev?: string): string {
  const output = (tc.output ?? "").trim();
  if (output) {
    const lines = output.split("\n").filter((l) => !/^\s*>\s*subagent:/.test(l) && l.trim());
    const last = lines.length > 0 ? lines[lines.length - 1] : "";
    if (last) return oneLine(last, 64);
  }
  // 新调用无文本：保留上一次摘要；仍无 → 状态默认文案
  return prev ?? (state === "completed" ? "已完成" : state === "failed" ? "执行失败" : "已取消");
}

// ---------- 后台任务 ----------

export function buildBackgroundTasks(
  messages: ChatMessage[],
  terminalSessions: Record<string, TerminalSessionInfo>,
  taskId: string,
  now: number,
  workspaceId?: string,
): BackgroundTaskVm[] {
  const out: BackgroundTaskVm[] = [];
  // 1) 当前上下文的终端会话：空间任务优先 workspace 会话，独立任务仍按 taskId
  const term =
    (workspaceId ? terminalSessions?.[workspaceId] : undefined) ?? terminalSessions?.[taskId];
  if (term) {
    if (term.alive) {
      out.push({ key: `term:${taskId}`, name: shellLabel(term.shell), state: "running", elapsedMs: now - term.startedAt });
    } else if (term.exitCode !== null && term.exitCode !== undefined) {
      out.push({
        key: `term:${taskId}`,
        name: shellLabel(term.shell),
        state: term.exitCode === 0 ? "completed" : "failed",
        exitCode: term.exitCode,
      });
    }
    // !alive && 无 exitCode：无明确 lifecycle → 不展示（不伪造）
  }
  // 2) 运行中的 bash 工具调用（同步执行中的长命令；无 exit code 事件 → 不显示 exit）
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "bash") continue;
      if (block.toolCall.status !== "running") continue;
      out.push({
        key: `bash:${block.toolCall.id}`,
        name: oneLine(block.toolCall.summary, 48) || "bash",
        state: "running",
      });
    }
  }
  // running 在前，其余按原始顺序
  return out.sort((a, b) => (a.state === "running" ? -1 : 1) - (b.state === "running" ? -1 : 1));
}

/** 终端会话可读名：shell 路径取 basename（如 powershell/bash）。 */
export function shellLabel(shell: string | undefined): string {
  const s = (shell ?? "").trim();
  if (!s) return "terminal";
  const base = s.split(/[\\/]/).pop() ?? s;
  return base.replace(/\.exe$/i, "") || "terminal";
}

// ---------- 总入口 ----------

export function buildRuntimeOverview(inputs: OverviewInputs): RuntimeOverviewVm {
  const { taskId, workspaceId, messages, activeSubagents, terminalSessions, now } = inputs;
  const runningSubagents = buildRunningSubagents(activeSubagents ?? [], now);
  // 同 id 复用运行中：done 旧记录让位给 running（当前活跃状态优先，避免双条目）
  const runningIds = new Set(runningSubagents.map((s) => s.id));
  return {
    mainAgent: buildMainAgent(messages ?? []),
    runningSubagents,
    doneSubagents: buildDoneSubagents(messages ?? []).filter((d) => !runningIds.has(d.id)),
    backgroundTasks: buildBackgroundTasks(messages ?? [], terminalSessions ?? {}, taskId, now, workspaceId),
  };
}
