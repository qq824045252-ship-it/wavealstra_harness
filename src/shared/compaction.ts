export interface TaskCompactionStatusDto {
  taskId: string;
  status: "idle" | "running" | "completed" | "skipped" | "cancelled" | "failed";
  reason?: "manual" | "threshold" | "overflow";
  operationId?: string;
  tokensBefore?: number;
  /** 压缩后的真实/估算输入 token；`estimatedTokensAfter` 保留给上下文用量估算的历史口径。 */
  tokensAfter?: number;
  estimatedTokensAfter?: number;
  /** 本次操作实际使用的引擎：`billion-context` 为内嵌上下文管理，`native` 为 Pi 原生压缩。 */
  engine?: "billion-context" | "native";
  /** 本次整理提交的摘要块数量；内嵌引擎才有。 */
  blocks?: number;
  /** 是否为自动维护（阈值/增长/溢出触发），而不是用户手动点击。 */
  automatic?: boolean;
  /** 前后 token 是否为估算口径（billion-context 与 native 都只能估算）；UI 据此显示「约」。 */
  estimated?: boolean;
  message?: string;
}
export interface TaskCompactionResultDto {
  ok: boolean;
  state: TaskCompactionStatusDto;
  /** `NOTHING_TO_COMPRESS` 与失败区分：没有可整理的历史，不是错误。 */
  code?: "TASK_BUSY" | "NO_SESSION" | "COMPACTION_FAILED" | "NOTHING_TO_COMPRESS";
}

/** Preserve Pi's post-compaction estimate only while the exact context leaf is unchanged. */
export function resolveContextTokenEstimate(tokens: number | null | undefined, leafId: string | null,
  estimate?: { leafId: string; tokens: number }): { usedTokens: number | null; estimated: boolean } {
  if (tokens != null && Number.isFinite(tokens) && tokens >= 0) return { usedTokens: tokens, estimated: false };
  if (estimate && estimate.leafId === leafId && Number.isFinite(estimate.tokens) && estimate.tokens >= 0)
    return { usedTokens: estimate.tokens, estimated: true };
  return { usedTokens: null, estimated: false };
}

/** Manual compaction is exclusive; native automatic compaction still supports queued input. */
export function isManualCompactionRunning(state: TaskCompactionStatusDto | undefined): boolean {
  return state?.status === "running" && state.reason === "manual";
}
