import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { CompressionState } from "../../../../../vendor/acp-kernel/src/index.ts";

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
  phase: "completed" | "skipped" | "failed" | "cancelled";
  reason: "threshold" | "growth" | "manual" | "overflow" | "fallback";
  engine: "billion-context" | "native";
  automatic: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  estimated: boolean;
  blocks?: number;
  message?: string;
  lastError?: string;
  at: number;
}

/** 会话级上下文管理持久状态。`stateJson` 是 acp-kernel 的纯 JSON state（无版本字段，由外部信封定版）。 */
export type DurableContextPersistedState = {
  schemaVersion: 1;
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
}): string {
  return createHash("sha256")
    .update(`${input.contextWindow}|${input.triggerTokens}|${input.keepRecentTokens}|${input.modelKey ?? ""}`)
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