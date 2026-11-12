import { createHash, randomUUID } from "node:crypto";
import { defineDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { activeBlocks, type CompressionState } from "../../../../../vendor/acp-kernel/src/index.ts";
import type { ContextManagementStatusDto } from "../../../../shared/context-management";

/** 内核 ref 指向的原始 Durable entry 位置；长期唯一标识，禁止用数组下标或文本 hash 代替。 */
export type DurableContextRefLocator = {
  entryId: number;
  /** entry.model 内的消息槽位，通常为 0。 */
  slot: number;
  role: string;
}

/** 已提交摘要块的只读镜像，供 UI 与原文回查入口展示；正文仍在内核 state 里。 */
export type DurableContextSummaryRecord = {
  blockId: string;
  refs: string;
  entryIds: number[];
  tokens: number;
  createdAt: number;
  topic?: string;
  tier: number;
  epoch: number;
}

export type DurableContextLastOperation = {
  operationId: string;
  revision: number;
  sessionId: string;
  conversationId: number;
  sourceRevision: number;
  source: { headEntryId: number | null; watermarkEntryId: number; epoch: number; viewDigest: string };
  configDigest: string;
  contextWindow: number;
  triggerTokens: number;
  phase: "summarizing" | "applying" | "completed" | "skipped" | "failed" | "cancelled";
  reason: "threshold" | "growth" | "manual" | "overflow" | "fallback";
  engine: "billion-context" | "native";
  automatic: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  estimated: boolean;
  blocks?: number;
  message?: string;
  lastError?: string;
  interrupted?: boolean;
  nativeCommit?: { taskId: number; firstKept: number; summaryDigest: string };
  at: number;
}

/** Store identity is independent of paths, product task IDs and process lifetimes. */
export const DurableContextSessionDoc = defineDoc({
  kind: "mybuddy.context-session", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ sessionId: randomUUID() }),
});

/** 会话级上下文管理持久状态。`stateJson` 是 acp-kernel 的纯 JSON state（无版本字段，由外部信封定版）。 */
export type DurableContextPersistedState = {
  schemaVersion: 1;
  sessionId?: string;
  revision?: number;
  kernelVersion: string;
  configDigest: string;
  /** 原生压缩边界（head entry id）；内核 state 只对同一边界有效。 */
  headEntryId: number | null;
  /** 最近处理到的 entry；用于状态展示与增量诊断。 */
  watermarkEntryId: number;
  /** 原生压缩/分支导致 state 重建时的代次。 */
  epoch: number;
  /** 当前代次的 ref → 原始 entry 映射。 */
  refs: Record<string, DurableContextRefLocator>;
  /** 已退役代次的 ref 映射，保证旧摘要里引用的 ref 仍能回查原文。 */
  archivedRefs: Array<{ epoch: number; refs: Record<string, DurableContextRefLocator> }>;
  /** 内核 state 的 JSON 序列化。 */
  stateJson: string;
  /** 摘要块只读镜像（跨代次保留）。 */
  summaries: DurableContextSummaryRecord[];
  stats: {
    rounds: number;
    folds: number;
    tokensCompressed: number;
    lastBeforeTokens?: number;
    lastAfterTokens?: number;
  };
  lastOperation?: DurableContextLastOperation;
}

const EMPTY_STATE: DurableContextPersistedState = {
  schemaVersion: 1,
  kernelVersion: "",
  configDigest: "",
  headEntryId: null,
  watermarkEntryId: 0,
  epoch: 1,
  refs: {},
  archivedRefs: [],
  stateJson: "",
  summaries: [],
  stats: { rounds: 0, folds: 0, tokensCompressed: 0 },
};

/**
 * 会话作用域的上下文管理文档。
 * `rewindable + asOf` 让会话分支拿到锚点当时的压缩状态，而不是源会话“现在”的摘要。
 */
export const DurableContextStateDoc = defineDoc({
  kind: "mybuddy.context-management",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  checkpointWhen: () => true,
  initial: (): DurableContextPersistedState => structuredClone(EMPTY_STATE),
});

export function emptyPersistedState(): DurableContextPersistedState {
  return structuredClone(EMPTY_STATE);
}

export function normalizePersisted(value: DurableContextPersistedState | undefined): DurableContextPersistedState {
  const base = emptyPersistedState();
  if (!value || typeof value !== "object") return base;
  return {
    ...base, ...value,
    revision: Number.isSafeInteger(value.revision) && value.revision! >= 0 ? value.revision : 0,
    refs: value.refs && typeof value.refs === "object" ? value.refs : {},
    archivedRefs: Array.isArray(value.archivedRefs) ? value.archivedRefs : [],
    summaries: Array.isArray(value.summaries) ? value.summaries : [],
    stats: { ...base.stats, ...(value.stats ?? {}) },
  };
}

/** Pure projection, including honest recovery of an operation whose owner is no longer running. */
export function persistedContextStatus(value: DurableContextPersistedState, passive = true): ContextManagementStatusDto {
  const state = normalizePersisted(value);
  const operation = state.lastOperation;
  const interrupted = passive && (operation?.phase === "summarizing" || operation?.phase === "applying");
  const kernel = parseKernelState(state);
  const blocks = kernel ? activeBlocks(kernel) : [];
  const children = new Set(blocks.flatMap(block => block.directBlockIds));
  return {
    engine: operation?.engine ?? "billion-context", enabled: true,
    phase: interrupted ? "failed" : operation?.phase ?? "idle", automatic: operation?.automatic ?? true,
    reason: operation?.reason, contextWindow: operation?.contextWindow ?? 0, triggerTokens: operation?.triggerTokens ?? 0,
    beforeTokens: operation?.beforeTokens, afterTokens: operation?.afterTokens, estimated: operation?.estimated ?? true,
    blocks: blocks.filter(block => !children.has(block.blockId)).length, operationId: operation?.operationId, revision: state.revision ?? 0, durable: true,
    sessionId: state.sessionId, conversationId: operation?.conversationId, sourceRevision: operation?.sourceRevision,
    viewDigest: operation?.source?.viewDigest, configDigest: operation?.configDigest ?? state.configDigest,
    interrupted: interrupted || operation?.interrupted,
    message: interrupted ? "上次上下文整理被中断，已保留原文和已提交摘要；未自动重放" : operation?.message,
    lastError: interrupted ? "维护进程在提交终态前结束" : operation?.lastError,
    summaries: state.summaries.slice(-5).map(record => ({ blockId: record.blockId, refs: record.refs,
      entryIds: record.entryIds, tokens: record.tokens, createdAt: record.createdAt, ...(record.topic ? { topic: record.topic } : {}) })),
    updatedAt: operation?.at ?? 0,
  };
}

export function nativeSummaryDigest(summary: string): string {
  return createHash("sha256").update(`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`).digest("hex");
}

/** The exact native placement is the authority, not an arbitrary newer head or a late callback. */
export async function matchesNativeContextCommit(operation: DurableContextLastOperation, head: EntryRecord | undefined,
  submission: (requestId: string) => Promise<{ type: string; entry?: number } | undefined>): Promise<boolean> {
  const proof = operation.nativeCommit;
  if (!proof || head?.kind !== "pi.compaction" || head.head !== proof.firstKept) return false;
  const text = (head.model ?? []).map(message => typeof message.content === "string" ? message.content
    : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")).join("\n");
  if (createHash("sha256").update(text).digest("hex") !== proof.summaryDigest) return false;
  if (head.byTaskId === proof.taskId) return true;
  const placed = await submission(`compaction:${proof.taskId}`);
  return placed?.type === "write" && placed.entry === head.id;
}

export function parseKernelState(persisted: DurableContextPersistedState): CompressionState | undefined {
  if (!persisted.stateJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(persisted.stateJson);
    if (parsed && typeof parsed === "object") return parsed as CompressionState;
  } catch {
    // 损坏的 state 视为缺失，由调用方从当前 head 重建；原文仍在 Durable entry 中。
  }
  return undefined;
}

export function serializeKernelState(state: CompressionState): string {
  return JSON.stringify(state);
}

/** 配置摘要只用于诊断：窗口/阈值/模型变化时记录，不因此丢弃历史摘要。 */
export function contextConfigDigest(input: {
  contextWindow: number;
  triggerTokens: number;
  keepRecentTokens: number;
  modelKey?: string;
  outputReserveTokens?: number;
  engine?: string;
}): string {
  return createHash("sha256")
    .update(`${input.contextWindow}|${input.triggerTokens}|${input.keepRecentTokens}|${input.modelKey ?? ""}|${input.outputReserveTokens ?? ""}|${input.engine ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/** ref 映射合并：已存在的同一 ref 绝不重写，避免旧摘要引用漂移到新消息。 */
export function mergeRefLocators(
  target: Record<string, DurableContextRefLocator>,
  entries: Record<string, DurableContextRefLocator>,
): void {
  for (const [ref, locator] of Object.entries(entries)) {
    if (target[ref] === undefined) target[ref] = locator;
  }
}

export function summaryRefSpan(startRef: string, endRef: string): string {
  return startRef === endRef ? startRef : `${startRef}–${endRef}`;
}
