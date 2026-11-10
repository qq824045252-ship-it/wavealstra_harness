/**
 * subagentDetails.ts — subagent 工具调用 details 的解析与缓存（纯函数）。
 *
 * 为什么单独一层：details 里带着每个子会话的 messages（可能几十万 token），
 * 而渲染层的流式刷新会每秒/每 token 重跑 view-model。同一份 detail 全文 → 同一结果，
 * 所以按字符串键做 LRU 缓存，避免反复 JSON.parse 几 MB 的载荷。
 *
 * 约定：所有字段防御性解析；拿不到就不给，不补默认值、不猜。
 */
import { formatDuration } from "@/store/app/format";
import { parseSubagentResultDetails, type SubagentResultRecord } from "@shared/subagent-model-config";

/** 子会话消息里一个 content part（pi Message 的原始形状，宽松类型：只读我们认识的字段）。 */
export interface ChildContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

/** 子会话消息（pi Message 投影到 details 后的形状）。 */
export interface ChildMessage {
  role?: string;
  content?: ChildContentPart[] | string;
  timestamp?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

export interface SubagentPlanItem {
  itemId: string;
  index?: number;
  agent?: string;
  displayName?: string;
  task?: string;
  cwd?: string;
  isolation?: string | null;
}

export interface SubagentResultRun {
  subagentId: string;
  /** 子会话 id：诊断里的 conversationId 就是它，用来把子代理的名字挂到对应标签页上 */
  nativeConversationId?: string;
  displayName?: string;
  agent?: string;
  task?: string;
  status?: string;
  exitCode?: number;
  errorMessage?: string;
  resolvedModel?: string;
  model?: string;
  /** 该子会话实际运行目录（worktree 或 shared cwd）；拿不到则 undefined */
  cwd?: string;
  /** 该子会话的完整消息流（用于子代理对话页）；旧 details 可能没有 */
  messages: ChildMessage[];
  /** 首条到末条消息的时间跨度；时间戳缺失或异常则 undefined（不伪造时长） */
  durationMs?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    contextTokens?: number;
    turns?: number;
  };
}

export interface SubagentDetails {
  mode?: string;
  concurrency?: { workers?: number; queued?: number; maxConcurrency?: number; serializedReason?: string };
  plan: SubagentPlanItem[];
  results: SubagentResultRun[];
}

const CACHE_LIMIT = 16;
const cache = new Map<string, SubagentDetails | null>();

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function planItem(raw: unknown): SubagentPlanItem | null {
  const item = record(raw);
  if (!item) return null;
  const itemId = str(item.itemId);
  if (!itemId) return null;
  return {
    itemId,
    index: num(item.index),
    agent: str(item.agent),
    displayName: str(item.displayName),
    task: str(item.task),
    cwd: str(item.cwd),
    isolation: item.isolation === null ? null : str(item.isolation),
  };
}

function childMessages(value: unknown): ChildMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChildMessage => Boolean(record(item)));
}

/** 子会话时间跨度：首末 timestamp 都有效才给，否则 undefined（时钟回拨/缺失都不编造）。 */
function span(messages: ChildMessage[]): number | undefined {
  const times = messages.map((message) => num(message.timestamp)).filter((t): t is number => t !== undefined);
  if (times.length < 2) return undefined;
  const d = Math.max(...times) - Math.min(...times);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

function resultRun(raw: unknown): SubagentResultRun | null {
  const item = record(raw);
  if (!item) return null;
  const subagentId = str(item.subagentId);
  if (!subagentId) return null;
  const messages = childMessages(item.messages);
  const workspace = record(item.workspace);
  return {
    subagentId,
    nativeConversationId: num(item.nativeConversationId) === undefined ? undefined : String(item.nativeConversationId),
    displayName: str(item.displayName),
    agent: str(item.agent),
    task: str(item.task),
    status: str(item.status),
    exitCode: num(item.exitCode),
    errorMessage: str(item.errorMessage),
    resolvedModel: str(item.resolvedModel),
    model: str(item.model),
    cwd: str(workspace?.cwd),
    messages,
    durationMs: span(messages),
    usage: record(item.usage) as SubagentResultRun["usage"],
  };
}

/** 解析一份 subagent details；不是 JSON 对象、或与 subagent 无关 → null。 */
function parse(detail: string): SubagentDetails | null {
  const text = detail.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = record(parsed);
  if (!obj) return null;
  // 只认 subagent 派发的 details：有 plan 或 results 才算，避免把别的工具 details 当成本结构
  if (!Array.isArray(obj.plan) && !Array.isArray(obj.results)) return null;
  const concurrency = record(obj.concurrency);
  return {
    mode: str(obj.mode),
    concurrency: concurrency
      ? {
          workers: num(concurrency.workers),
          queued: num(concurrency.queued),
          maxConcurrency: num(concurrency.maxConcurrency),
          serializedReason: str(concurrency.serializedReason),
        }
      : undefined,
    plan: (Array.isArray(obj.plan) ? obj.plan : []).map(planItem).filter((i): i is SubagentPlanItem => Boolean(i)),
    results: (Array.isArray(obj.results) ? obj.results : []).map(resultRun).filter((i): i is SubagentResultRun => Boolean(i)),
  };
}

/**
 * details 全文 → 解析结果（带 LRU 缓存）。
 * 同一实例在流式刷新中传入的是同一个字符串引用内容，命中缓存为 O(1)。
 */
export function parseSubagentDetails(detail: string | undefined): SubagentDetails | null {
  const text = (detail ?? "").trim();
  if (!text) return null;
  const cached = cache.get(text);
  if (cached !== undefined) {
    // LRU：命中后移到队尾
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }
  const parsed = parse(text);
  cache.set(text, parsed);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return parsed;
}

/** 子会话的最终文本（最后一条 assistant 的 text parts）；没有则空串。 */
export function childFinalText(messages: ChildMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    return childMessageText(message);
  }
  return "";
}

/** assistant 单条消息的正文（content 可能是字符串或 parts 数组）。 */
export function childMessageText(message: ChildMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

/** 子会话时长的界面口径（与主聊天「已完成，用时 xx」同一套格式）。 */
export function childDurationLabel(durationMs: number | undefined): string | undefined {
  return durationMs === undefined ? undefined : formatDuration(durationMs);
}

/**
 * 结构化结果记录的缓存层：与 details 解析共用同一字符串键。
 * 渲染层流式刷新会反复传同一份 detail，shared 解析器每次都会 JSON.parse 全文，
 * 这里让它也只做一次。
 */
const recordCache = new Map<string, SubagentResultRecord[]>();
const RECORD_CACHE_LIMIT = 16;

export function parseSubagentResultRecords(detail: string | undefined): SubagentResultRecord[] {
  const text = (detail ?? "").trim();
  if (!text) return [];
  const cached = recordCache.get(text);
  if (cached !== undefined) {
    recordCache.delete(text);
    recordCache.set(text, cached);
    return cached;
  }
  const records = parseSubagentResultDetails("subagent", text);
  recordCache.set(text, records);
  if (recordCache.size > RECORD_CACHE_LIMIT) {
    const oldest = recordCache.keys().next();
    if (!oldest.done) recordCache.delete(oldest.value);
  }
  return records;
}
