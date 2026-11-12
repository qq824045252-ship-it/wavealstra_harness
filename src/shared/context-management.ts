import type { TaskCompactionStatusDto } from "./compaction";

/** 当前生效的上下文管理引擎。`native` 表示 Pi Durable 原生压缩，`billion-context` 表示内嵌 acp-kernel 适配层。 */
export type ContextManagementEngine = "billion-context" | "native";

/** 产品设置默认引擎：内嵌分层摘要（带原文回查）；用户可显式切换为 Pi 原生按比例压缩。 */
export const DEFAULT_COMPACTION_ENGINE: ContextManagementEngine = "billion-context";

export function normalizeCompactionEngine(raw: unknown): ContextManagementEngine {
  return raw === "native" ? "native" : DEFAULT_COMPACTION_ENGINE;
}

/** 一次上下文维护操作的生命周期。 */
export type ContextManagementPhase =
  | "idle" | "analyzing" | "summarizing" | "applying" | "completed" | "skipped" | "cancelled" | "failed";

/** 为什么发生维护：自动高水位、内核增长建议、用户手动、provider 溢出、原生回退。 */
export type ContextManagementReason = "threshold" | "growth" | "manual" | "overflow" | "fallback";

/** 一个已提交的分层摘要块。refs 是内核 ref 区间，entryIds 是原始 Durable entry 位置。 */
export interface ContextManagementSummaryDto {
  blockId: string;
  refs: string;
  entryIds: number[];
  tokens: number;
  createdAt: number;
  topic?: string;
}

/** 会话级上下文管理状态。只读投影，不含原文或内核 state。 */
export interface ContextManagementStatusDto {
  engine: ContextManagementEngine;
  /** 自动上下文管理是否生效（产品设置 + 运行时可用性）。 */
  enabled: boolean;
  phase: ContextManagementPhase;
  reason?: ContextManagementReason;
  automatic: boolean;
  /** 当前会话模型窗口与产品阈值（估算口径同设置页）。 */
  contextWindow: number;
  triggerTokens: number;
  /** 本轮实际出站输入的完整估算（含 system、工具 schema、摘要、待发输入）。 */
  estimatedInputTokens?: number;
  /** 压缩前/后有效输入估算；`estimated` 标注口径。 */
  beforeTokens?: number;
  afterTokens?: number;
  estimated: boolean;
  /** 已提交摘要块数量与最近几块（供 UI 原文回查入口）。 */
  blocks?: number;
  summaries?: ContextManagementSummaryDto[];
  /** 最近一次操作处理的消息数/范围。 */
  processedMessages?: number;
  operationId?: string;
  revision?: number;
  /** False only when a local error could not be written; revision remains the last durable revision. */
  durable?: boolean;
  interrupted?: boolean;
  sessionId?: string;
  conversationId?: number;
  sourceRevision?: number;
  viewDigest?: string;
  configDigest?: string;
  message?: string;
  lastError?: string;
  updatedAt: number;
  /** 与任务压缩状态的对应关系（手动操作时由 AgentService 生成）。 */
  compaction?: TaskCompactionStatusDto;
}

/** 手动“立即整理上下文”的结果。 */
export interface ContextManagementResultDto {
  ok: boolean;
  status: ContextManagementStatusDto;
  code?: "TASK_BUSY" | "NO_SESSION" | "NOTHING_TO_COMPRESS" | "CONTEXT_MANAGEMENT_FAILED";
}
