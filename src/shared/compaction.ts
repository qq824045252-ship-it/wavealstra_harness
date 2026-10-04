export interface TaskCompactionStatusDto {
  taskId: string;
  status: "idle" | "running" | "completed" | "skipped" | "cancelled" | "failed";
  reason?: "manual" | "threshold" | "overflow";
  operationId?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  message?: string;
}
export interface TaskCompactionResultDto {
  ok: boolean;
  state: TaskCompactionStatusDto;
  code?: "TASK_BUSY" | "NO_SESSION" | "COMPACTION_FAILED";
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
