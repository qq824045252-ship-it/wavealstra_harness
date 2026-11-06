/**
 * overviewRuntime.ts — 「概览」Runtime Observatory 的纯 view-model 派生（可测）。
 *
 * 数据源（全部现有、task-scoped、事件驱动，无新增轮询 IPC）：
 * - 主 Agent：当前 task 消息（streaming 标志 + 运行中 tool call 摘要）；
 * - 运行中子代理：window.api.subagent.active(taskId)（主进程按 taskId 过滤）；
 * - 完成态子代理：当前 task 消息中的 subagent tool calls（task 生命周期内短暂记录；
 *   Subagent 本体仍 disposable，terminal 即销毁，此处只是聊天时间线派生视图）；
 * - 后台任务：当前 task 的终端会话（TerminalSessionInfo：alive/exitCode/startedAt）
 *   + 运行中的 bash 工具调用（无 exit code 事件 → 不伪造 exit）。
 *
 * 约定：所有解析均防御性；无法可靠判断的字段宁缺毋伪造。
 *
 * 模型展示（「这是哪个模型在跑」）：主 Agent 用任务级 activeModelId + 目录名称；
 * 运行中子代理用运行时记录的 actualModel/resolvedModel（含来源）；
 * 完成态子代理从工具结果的结构化证据行解析；拿不到就不显示，不猜。
 */
import type { ChatMessage } from "@/types";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import type { TerminalSessionInfo } from "@shared/terminal-ipc";
import {
  extractSubagentDisplayNameFromToolResult,
  extractSubagentIdFromToolResult,
  parseSubagentResultDetails,
} from "@shared/subagent-model-config";
import {
  buildModelBadge,
  parseModelEvidenceFromOutput,
  subagentModelBadge,
  type ModelBadge,
} from "@/lib/modelBadge";

// ---------- 类型 ----------

export type MainAgentState = "idle" | "working";

export interface MainAgentVm {
  state: MainAgentState;
  /** 紧凑状态文案：运行中 / 空闲 / 等待 */
  label: string;
  /** 一行动作摘要（如「正在实现 WebAccess」）；无则 undefined */
  action?: string;
  /** 当前任务模型（任务级 activeModelId；无则不显示） */
  model?: ModelBadge;
}

export interface RunningSubagentVm {
  id: string;
  role: string;
  /** 可选显示名（允许中文）；有则优先展示，id 仍用于操作 */
  displayName?: string;
  work: string;
  elapsedMs: number;
  /** 该实例真正使用的模型（actual/resolved 记录值；拿不到则不显示） */
  model?: ModelBadge;
}

export type DoneSubagentState = "completed" | "failed" | "cancelled";

export interface DoneSubagentVm {
  id: string;
  state: DoneSubagentState;
  /** 可选显示名（从工具结果文本解析；允许中文） */
  displayName?: string;
  /** 结果摘要（finalText/错误首行截断） */
  summary: string;
  /** 该实例在本 task 内的工具调用次数（去重后的聚合计数） */
  count: number;
  /** 任务输入/要求目标 */
  task?: string;
  /** 完整输出详情结果 */
  detail?: string;
  /** 工具结果证据行解析出的模型（无证据则不显示） */
  model?: ModelBadge;
}

export type BackgroundState = "running" | "completed" | "failed";

export interface BackgroundTaskVm {
  key: string;
  name: string;
  state: BackgroundState;
  /** 仅当真实数据有 exit code 时提供；bash 工具调用无该事件 → 不伪造 */
  exitCode?: number;
  elapsedMs?: number;
  terminalId?: string;
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
  /** 主 Agent 当前模型（任务级 activeModelId + 目录名称；仅展示用） */
  mainModel?: { id?: string; name?: string };
  /** 模型 id → 目录展示名（只用于 badge 短标签，不参与运行判断） */
  modelNames?: Record<string, string>;
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

export function buildMainAgent(
  messages: ChatMessage[],
  mainModel?: { id?: string; name?: string },
): MainAgentVm {
  const model = buildModelBadge(mainModel?.id, { displayName: mainModel?.name });
  const withModel = (vm: MainAgentVm): MainAgentVm => (model ? { ...vm, model } : vm);
  // 最后一条消息是 user：agent 尚未开始响应（无 streaming 标记可区分）→ 等待
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    return withModel({ state: "idle", label: "等待" });
  }
  // 从后往前找最后一条 assistant 消息（其 streaming 标志是主 Agent 运行态）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const running = msg.streaming === true;
    if (!running) return withModel({ state: "idle", label: "空闲" });
    // 动作摘要：最近一个运行中 tool call（从后往前）
    for (let b = (msg.blocks ?? []).length - 1; b >= 0; b--) {
      const block = msg.blocks[b];
      if (block.type === "tool" && block.toolCall.status === "running") {
        const summary = oneLine(block.toolCall.summary || block.toolCall.tool, 48);
        return withModel({ state: "working", label: "运行中", action: summary ? `正在 ${summary}` : undefined });
      }
    }
    return withModel({ state: "working", label: "运行中", action: "正在生成回复…" });
  }
  return withModel({ state: "idle", label: "等待" });
}

// ---------- 子代理 ----------

/** 运行中子代理：status=running，或 idle 但 worker 存活（工具调用间隙）。 */
function isActiveInstance(dto: SubagentSummaryDto): boolean {
  return dto.status === "running" || (dto.status === "idle" && dto.workerAlive === true);
}

export function buildRunningSubagents(
  dtos: SubagentSummaryDto[],
  now: number,
  modelNames?: Record<string, string>,
): RunningSubagentVm[] {
  return (dtos ?? [])
    .filter(isActiveInstance)
    .map((d) => ({
      id: d.subagentId,
      role: readableRole(d.subagentId, d.role),
      displayName: typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim() : undefined,
      work: oneLine(d.lastTask || (d.status === "running" ? "运行中" : "等待工具调用"), 56) || "运行中",
      elapsedMs: now - (d.lastPromptAt ?? d.createdAt ?? now),
      model: subagentModelBadge(d, modelNames),
    }));
}

/**
 * 完成态子代理：当前 task 消息中的 subagent 工具调用（RESULT/FAILED/CANCELLED 后
 * 扩展已销毁实例，聊天时间线是唯一残留；随 task 生命周期自然消失，不进全局历史）。
 * 防御性：无法提取 id 的调用直接忽略（与 ToolCallCard chip 同语义）。
 * 同一实例多次调用（复用运行中）：状态与摘要取**最后一次**（最终态），计数累计 ×N。
 */
function extractSubagentTask(detail?: string, summary?: string): string {
  const text = (detail || summary || "").trim();
  if (!text) return "";
  try {
    const obj = JSON.parse(text);
    if (typeof obj === "object" && obj !== null) {
      if (typeof obj.task === "string") return obj.task;
      if (typeof obj.prompt === "string") return obj.prompt;
    }
  } catch {
    const m = text.match(/"task"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return text;
}

export function buildDoneSubagents(
  messages: ChatMessage[],
  modelNames?: Record<string, string>,
): DoneSubagentVm[] {
  const map = new Map<
    string,
    {
      state: DoneSubagentState;
      summary: string;
      count: number;
      task?: string;
      detail?: string;
      model?: ModelBadge;
      displayName?: string;
    }
  >();
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "subagent") continue;
      const tc = block.toolCall;
      if (tc.status === "pending_approval" || tc.status === "running") continue; // 未终结：运行中由 IPC 侧覆盖
      // Durable 架构：完成态工具的 detail 是结构化结果（details.results[]），优先按它建条目；
      // 旧消息没有结构化结果时回退到文本标记解析。
      const structured = parseSubagentResultDetails("subagent", tc.detail);
      if (structured.length > 0) {
        for (const item of structured) {
          const state: DoneSubagentState =
            item.status === "cancelled" ? "cancelled"
              : item.status === "failed" || item.status === "timedout" || item.status === "error" ? "failed"
                : (item.exitCode ?? 0) === 0 ? "completed" : "failed";
          const prev = map.get(item.subagentId);
          const summary = oneLine(
            item.finalText || item.errorMessage
              || (state === "completed" ? "已完成" : state === "failed" ? "执行失败" : "已取消"),
            64,
          );
          const model = buildModelBadge(item.resolvedModel ?? item.model, {
            displayName: item.resolvedModel ? modelNames?.[item.resolvedModel] : undefined,
          }) ?? prev?.model;
          map.set(item.subagentId, {
            state,
            summary: summary || prev?.summary || "",
            count: (prev?.count ?? 0) + 1,
            task: item.task || prev?.task,
            detail: item.finalText || item.errorMessage || tc.output || prev?.detail,
            model,
            displayName: item.displayName ?? prev?.displayName,
          });
        }
        continue;
      }
      const id = extractSubagentId(tc.output, tc.detail);
      if (!id) continue;
      const displayName = extractSubagentDisplayNameFromToolResult("subagent", tc.output, tc.detail);
      const state: DoneSubagentState =
        tc.status === "success" ? "completed" : tc.status === "error" ? "failed" : "cancelled";
      const prev = map.get(id);
      const summary = pickSummary(tc, state, prev?.summary);
      const task = extractSubagentTask(tc.detail, tc.summary);
      const detail = tc.output || tc.detail || "";
      // 模型只认工具结果里的结构化证据行（Resolved/Observed model）；无证据保留旧值
      const evidenceModel = parseModelEvidenceFromOutput(tc.output);
      const model =
        buildModelBadge(evidenceModel, { displayName: evidenceModel ? modelNames?.[evidenceModel] : undefined }) ??
        prev?.model;
      // 状态取最新（后一次调用覆盖前一次）；空摘要保留旧值
      map.set(id, {
        state,
        summary,
        count: (prev?.count ?? 0) + 1,
        task: task || prev?.task,
        detail: detail || prev?.detail,
        model,
        displayName: displayName ?? prev?.displayName,
      });
    }
  }
  return [...map.entries()].map(([id, v]) => ({
    id,
    state: v.state,
    displayName: v.displayName,
    summary: v.summary,
    count: v.count,
    task: v.task,
    detail: v.detail,
    model: v.model,
  }));
}

/** 集中式 subagent id 解析：统一复用 shared 单 parser（与 ToolCallCard chip 同源）。 */
export function extractSubagentId(output: string | undefined, detail: string | undefined): string | null {
  return extractSubagentIdFromToolResult("subagent", output, detail);
}

/** 完成态摘要：优先 output 中 finalText（去 id 行），否则按状态给默认文案。 */
function pickSummary(tc: { output?: string }, state: DoneSubagentState, prev?: string): string {
  const output = (tc.output ?? "").trim();
  if (output) {
    const lines = output.split("\n").filter((l) => !/^\s*>\s*(?:subagent-name|subagent):/.test(l) && l.trim());
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
  // 1) 收集当前任务/空间关联的终端会话
  const seenSessions = new Set<string>();
  for (const [key, term] of Object.entries(terminalSessions ?? {})) {
    if (!term) continue;
    const matches =
      term.taskId === taskId ||
      (workspaceId && term.workspaceId === workspaceId) ||
      key === taskId ||
      (workspaceId && key === workspaceId);
    if (!matches) continue;
    const sessionUniqueId = term.sessionId || key;
    if (seenSessions.has(sessionUniqueId)) continue;
    seenSessions.add(sessionUniqueId);
    if (term.alive) {
      out.push({
        key: `term:${key}`,
        name: shellLabel(term.shell),
        state: "running",
        elapsedMs: now - term.startedAt,
        terminalId: term.terminalId,
      });
    } else if (term.exitCode !== null && term.exitCode !== undefined) {
      out.push({
        key: `term:${key}`,
        name: shellLabel(term.shell),
        state: term.exitCode === 0 ? "completed" : "failed",
        exitCode: term.exitCode,
        terminalId: term.terminalId,
      });
    }
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
  const { taskId, workspaceId, messages, activeSubagents, terminalSessions, now, mainModel, modelNames } = inputs;
  const runningSubagents = buildRunningSubagents(activeSubagents ?? [], now, modelNames);
  // 同 id 复用运行中：done 旧记录让位给 running（当前活跃状态优先，避免双条目）
  const runningIds = new Set(runningSubagents.map((s) => s.id));
  return {
    mainAgent: buildMainAgent(messages ?? [], mainModel),
    runningSubagents,
    doneSubagents: buildDoneSubagents(messages ?? [], modelNames).filter((d) => !runningIds.has(d.id)),
    backgroundTasks: buildBackgroundTasks(messages ?? [], terminalSessions ?? {}, taskId, now, workspaceId),
  };
}
