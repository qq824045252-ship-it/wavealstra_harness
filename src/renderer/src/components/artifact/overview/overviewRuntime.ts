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
  type SubagentUsage,
} from "@shared/subagent-model-config";
import { parseSubagentDetails, parseSubagentResultRecords } from "@/lib/subagentDetails";
import { formatCount, formatRateDash, formatTokenCount } from "@shared/token-format";
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
  /**
   * 统一显示名（displayName → role → id 短形式）。侧栏、顶栏与对话页只读这个字段，
   * 避免同一实例在不同位置叫不同名字。
   */
  name: string;
  /** 可选显示名（允许中文）；有则优先展示，id 仍用于操作 */
  displayName?: string;
  work: string;
  /** 实际工作目录（DTO.project）；拿不到则不显示 */
  cwd?: string;
  elapsedMs: number;
  /** 该实例真正使用的模型（actual/resolved 记录值；拿不到则不显示） */
  model?: ModelBadge;
  /** 该实例累计用量（还没有任何模型调用时不提供） */
  usage?: SubagentUsage;
}

/**
 * 完成态状态。"unknown" 只用于「曾经存在、但结果里没有终态」的条目（窗口驱逐/派发被取消），
 * 界面写「已结束」而不写成「已完成」—— 不伪造成功。
 */
export type DoneSubagentState = "completed" | "failed" | "cancelled" | "unknown";

export interface DoneSubagentVm {
  id: string;
  state: DoneSubagentState;
  /** 统一显示名（displayName → role → id 短形式）：与侧栏/顶栏/对话页同一个字段 */
  name: string;
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
  /** 实际工作目录（结构化结果的 workspace.cwd）；拿不到则不显示 */
  cwd?: string;
  /** 首条到末条消息的真实时间跨度；无时间戳则不提供（不伪造） */
  durationMs?: number;
  /** 工具结果证据行解析出的模型（无证据则不显示） */
  model?: ModelBadge;
  /** 该实例累计用量（旧消息的 details 无 usage 时不提供） */
  usage?: SubagentUsage;
}

export type BackgroundState = "running" | "completed" | "failed";

/** 排队中的并行项：计划已定，但并发名额还没轮到（子会话尚未创建，故 IPC 索引里没有它）。 */
export interface QueuedSubagentVm {
  /** 计划里的 itemId（子会话尚不存在，不能用来打开抽屉） */
  id: string;
  role: string;
  /** 统一显示名（displayName → agent → id 短形式）：顶栏与侧栏同一个字段 */
  name: string;
  displayName?: string;
  /** 任务首行（截断）；计划里一定有任务正文 */
  task: string;
  /** 计划里的工作目录（尚未创建子会话，不可能有运行时 cwd） */
  cwd?: string;
}

/** 运行中 parallel 派发的真实并发口径（来自工具 details 的 concurrency）。 */
export interface SubagentConcurrencyVm {
  workers: number;
  /** 仍在排队的项数（渲染时以实际排队项为准，不用主进程的静态初值） */
  queued: number;
  maxConcurrency: number;
  /** 并发被压到 1 的原因（仓库禁止 worktree 且工具集可写）；无则 undefined */
  serializedReason?: string;
}

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
  /** 已计划但还没轮到并发名额的项（parallel 派发）：主进程索引里没有子会话，但用户得看得见 */
  queuedSubagents: QueuedSubagentVm[];
  doneSubagents: DoneSubagentVm[];
  backgroundTasks: BackgroundTaskVm[];
  /** 运行中 parallel 派发的真实并发口径；无则不显示（chain/single 不谈并发） */
  subagentConcurrency?: SubagentConcurrencyVm;
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

/**
 * 子代理实例的显示名（唯一入口）：displayName → role / agent → id 短形式。
 * 侧栏、顶栏子代理查看器与子代理对话页都只能经这里取名，
 * 否则同一个实例在三个位置会出现三种叫法。
 */
export function subagentRunName(input: {
  displayName?: string | null;
  role?: string | null;
  agent?: string | null;
  id: string;
}): string {
  const display = (input.displayName ?? "").trim();
  if (display) return display;
  return readableRole(input.id, input.role ?? input.agent ?? undefined);
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

/**
 * 只有真的产生过调用才展示用量：turns=0 且 token 全零（刚 spawn、被拒绝）时
 * 显示一排 0 只是噪声，宁可整块不显示。
 */
function usableUsage(usage: SubagentUsage | undefined): SubagentUsage | undefined {
  if (!usage) return undefined;
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return total > 0 || usage.turns > 0 ? usage : undefined;
}

/**
 * 缓存命中率：cacheRead / (cacheRead + 新输入 + 缓存写)，与用量统计面板同一口径
 * （shared/usage-stats.cacheHitRate）。分母为 0 → null（界面显示「—」，不伪装成 0%）。
 */
export function subagentCacheHitRate(usage: SubagentUsage): number | null {
  const denom = usage.cacheRead + usage.input + usage.cacheWrite;
  if (!(denom > 0)) return null;
  return usage.cacheRead / denom;
}

/** 子代理用量的一格（label + 已格式化 value）；命中率带好坏标记供着色。 */
export interface SubagentUsageField {
  key: "input" | "cacheRead" | "output" | "hit";
  label: string;
  value: string;
  tone?: "normal" | "good" | "warn";
}

/**
 * 四个显示参数：输入 / 缓存读 / 输出 / 缓存命中率。
 * token 一律 M 口径（产品统一）；命中率无分母时「—」。
 */
export function subagentUsageFields(usage: SubagentUsage): SubagentUsageField[] {
  const hit = subagentCacheHitRate(usage);
  return [
    { key: "input", label: "输入", value: formatTokenCount(usage.input) },
    { key: "cacheRead", label: "缓存读", value: formatTokenCount(usage.cacheRead) },
    { key: "output", label: "输出", value: formatTokenCount(usage.output) },
    {
      key: "hit",
      label: "命中",
      value: formatRateDash(hit),
      // 与上下文弹窗的阈值一致：≥60% 绿，低于则提醒
      tone: hit == null ? "normal" : hit >= 0.6 ? "good" : "warn",
    },
  ];
}

/** 悬停展示的完整分解（含缓存写 / 轮次 / 费用，不进窄行）。 */
export function subagentUsageTitle(usage: SubagentUsage): string {
  const parts = [
    `新输入 ${formatTokenCount(usage.input)}`,
    `缓存读 ${formatTokenCount(usage.cacheRead)}`,
    `缓存写 ${formatTokenCount(usage.cacheWrite)}`,
    `输出 ${formatTokenCount(usage.output)}`,
  ];
  const hit = subagentCacheHitRate(usage);
  parts.push(`缓存命中率 ${formatRateDash(hit)}`);
  if (usage.turns > 0) parts.push(`${formatCount(usage.turns)} 轮模型调用`);
  if (usage.cost > 0) parts.push(`费用 $${usage.cost.toFixed(4)}`);
  return `子代理累计用量：${parts.join(" · ")}`;
}

export function buildRunningSubagents(
  dtos: SubagentSummaryDto[],
  now: number,
  modelNames?: Record<string, string>,
): RunningSubagentVm[] {
  return (dtos ?? [])
    .filter(isActiveInstance)
    .map((d) => {
      const role = readableRole(d.subagentId, d.role);
      const displayName = typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim() : undefined;
      return {
        id: d.subagentId,
        role,
        name: subagentRunName({ displayName, role, id: d.subagentId }),
        displayName,
        work: oneLine(d.lastTask || (d.status === "running" ? "运行中" : "等待工具调用"), 56) || "运行中",
        cwd: typeof d.project === "string" && d.project.trim() ? d.project.trim() : undefined,
        elapsedMs: now - (d.lastPromptAt ?? d.createdAt ?? now),
        model: subagentModelBadge(d, modelNames),
        usage: usableUsage(d.usage),
      };
    });
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
      cwd?: string;
      durationMs?: number;
      model?: ModelBadge;
      displayName?: string;
      role?: string;
      usage?: SubagentUsage;
    }
  >();
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "subagent") continue;
      const tc = block.toolCall;
      // 未开始的不算完成；**运行中的派发必须算**：rolling pool 里已跑完的 child 会立刻从
      // IPC 索引移除，只有 details.results[] 还留着它们——以前在这里一律 skip，“完成态”
      // 就会在整批派发结束前集体消失。
      if (tc.status === "pending_approval") continue;
      // Durable 架构：完成态工具的 detail 是结构化结果（details.results[]），优先按它建条目；
      // 旧消息没有结构化结果时回退到文本标记解析。
      const structured = parseSubagentResultRecords(tc.detail);
      // 工作目录与真实时长只在结构化结果的原始 messages / workspace 里；共用同一份缓存解析。
      const runs = parseSubagentDetails(tc.detail)?.results ?? [];
      if (structured.length > 0) {
        for (const item of structured) {
          const state: DoneSubagentState =
            item.status === "cancelled" ? "cancelled"
              : item.status === "failed" || item.status === "timedout" || item.status === "error" ? "failed"
                : (item.exitCode ?? 0) === 0 ? "completed" : "failed";
          const prev = map.get(item.subagentId);
          const run = runs.find((r) => r.subagentId === item.subagentId);
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
            cwd: run?.cwd ?? prev?.cwd,
            durationMs: run?.durationMs ?? prev?.durationMs,
            model,
            displayName: item.displayName ?? prev?.displayName,
            role: run?.agent ?? prev?.role,
            // results[].usage 已是该实例的累计值：后一次结果直接覆盖，不重复累加
            usage: item.usage ?? prev?.usage,
          });
        }
        continue;
      }
      // 运行中的派发没有 legacy 文本结果可解析；等它真正终结后再走回退路径。
      if (tc.status === "running") continue;
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
        cwd: prev?.cwd,
        durationMs: prev?.durationMs,
        model,
        displayName: displayName ?? prev?.displayName,
        role: prev?.role,
      });
    }
  }
  return [...map.entries()].map(([id, v]) => ({
    id,
    state: v.state,
    name: subagentRunName({ displayName: v.displayName, role: v.role, id }),
    displayName: v.displayName,
    summary: v.summary,
    count: v.count,
    task: v.task,
    detail: v.detail,
    cwd: v.cwd,
    durationMs: v.durationMs,
    model: v.model,
    usage: usableUsage(v.usage),
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

// ---------- 并行排队（运行中派发的 details） ----------

function toCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** concurrency 只在三个计数都合法时才成立（宁缺不伪造）。 */
function toConcurrency(
  raw: ReturnType<typeof parseSubagentDetails>,
): SubagentConcurrencyVm | undefined {
  const source = raw?.concurrency;
  if (!source) return undefined;
  const workers = toCount(source.workers);
  const queued = toCount(source.queued);
  const maxConcurrency = toCount(source.maxConcurrency);
  if (workers === undefined || queued === undefined || maxConcurrency === undefined) return undefined;
  return { workers, queued, maxConcurrency, ...(source.serializedReason ? { serializedReason: source.serializedReason } : {}) };
}

/**
 * 运行中 parallel 派发的排队项与并发口径。
 *
 * 数据源是运行中 subagent 工具调用的 details：`plan` 是入参快照，`results` 是本派发已完结项，
 * `runningIds` 是真正建好子会话的项，三者差集即「已计划、尚未启动」——主进程 rolling pool 里的
 * queued。这样面板不必猜，也不需要 IPC 新增状态；派发一结束调用不再 running，排队行自然消失。
 *
 * 只认 mode=parallel：chain 的未执行项是「等上一步」，不是并发排队。
 * 旧格式（无 mode / 无 concurrency）仍能列出排队项，只是不显示并发口径。
 */
export function buildQueuedSubagents(
  messages: ChatMessage[],
  runningIds: Set<string>,
): { queued: QueuedSubagentVm[]; concurrency?: SubagentConcurrencyVm } {
  const queued: QueuedSubagentVm[] = [];
  const seen = new Set<string>();
  let concurrency: SubagentConcurrencyVm | undefined;
  for (const msg of messages ?? []) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool" || block.toolCall.tool !== "subagent") continue;
      if (block.toolCall.status !== "running") continue;
      const details = parseSubagentDetails(block.toolCall.detail);
      if (!details) continue;
      // 只认 parallel：chain 的未执行项是「等上一步」，不是并发排队。
      // 旧 details 可能没有 mode，此时才用 concurrency 当作 parallel 线索。
      const isParallel = details.mode === "parallel" || (details.mode === undefined && details.concurrency !== undefined);
      if (!isParallel) continue;
      // 多个并行派发同时运行时以第一个为准：面板只显示一行并发口径，宁少不猜
      concurrency ??= toConcurrency(details);
      const finished = new Set(details.results.map((run) => run.subagentId));
      for (const item of details.plan) {
        if (finished.has(item.itemId) || runningIds.has(item.itemId) || seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        const displayName = item.displayName;
        const role = readableRole(item.itemId, item.agent);
        queued.push({
          id: item.itemId,
          role,
          name: subagentRunName({ displayName, role, id: item.itemId }),
          displayName,
          task: oneLine(item.task ?? "", 56),
          cwd: item.cwd,
        });
      }
    }
  }
  return concurrency ? { queued, concurrency } : { queued };
}

// ---------- 总入口 ----------

export function buildRuntimeOverview(inputs: OverviewInputs): RuntimeOverviewVm {
  const { taskId, workspaceId, messages, activeSubagents, terminalSessions, now, mainModel, modelNames } = inputs;
  const runningSubagents = buildRunningSubagents(activeSubagents ?? [], now, modelNames);
  // 同 id 复用运行中：done 旧记录让位给 running（当前活跃状态优先，避免双条目）
  const runningIds = new Set(runningSubagents.map((s) => s.id));
  const queue = buildQueuedSubagents(messages ?? [], runningIds);
  return {
    mainAgent: buildMainAgent(messages ?? [], mainModel),
    runningSubagents,
    queuedSubagents: queue.queued,
    doneSubagents: buildDoneSubagents(messages ?? [], modelNames).filter((d) => !runningIds.has(d.id)),
    subagentConcurrency: queue.concurrency ? { ...queue.concurrency, queued: queue.queued.length } : undefined,
    backgroundTasks: buildBackgroundTasks(messages ?? [], terminalSessions ?? {}, taskId, now, workspaceId),
  };
}
