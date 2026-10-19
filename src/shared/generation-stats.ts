/** Ephemeral UI telemetry. Token estimates must never enter billing/usage records. */
export interface GenerationStats {
  phase: "waiting" | "generating" | "tools" | "retrying" | "compacting" | "complete";
  startedAt: number;
  updatedAt: number;
  /** Provider attempts this reply has used; 1 means the first attempt has not failed yet. */
  attempts?: number;
  /**
   * Pi retried a failed provider attempt. Kept after the backoff so the reply can keep
   * saying "attempt N, last error X" while the retried request is streaming again.
   */
  retry?: {
    /** 1-based retry counter reported by Pi (1 = first retry after the initial attempt). */
    attempt: number;
    /** Pi's retry budget for this run, when the host knows it. */
    maxAttempts?: number;
    /** Backoff before that retry started, when known. */
    delayMs?: number;
    /** Provider error that scheduled the retry, e.g. `terminated`. */
    error: string;
  };
  /** Current request while streaming; duration-weighted reply average after completion. */
  tps: number | null;
  estimated: boolean;
  /** Authoritative total only; null if any request omitted usable output usage. */
  outputTokens: number | null;
  /** First model response in this reply, including thinking/tool-call output. */
  ttftMs: number | null;
  outcome?: "completed" | "aborted" | "error";
}

/** Provider errors are long and noisy; keep the label readable without inventing detail. */
function retryErrorText(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (!text) return "连接中断";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/**
 * Display native events without inventing a model-thinking timer/state machine.
 * Retry state comes from Pi's own `auto_retry_start`; the host only renders it.
 */
export function nativeRunPhaseLabel(
  phase: GenerationStats["phase"] | undefined,
  activeTools: string[],
  answering = false,
  retry?: GenerationStats["retry"],
  attempts?: number,
): string {
  if (activeTools.includes("request_user_input") || activeTools.includes("conversation_goal_propose_complete")) return "等待用户回答…";
  if (activeTools.length) return `正在执行 ${activeTools[0]}…`;
  if (phase === "retrying") {
    if (!retry) return "连接重试中…";
    const budget = retry.maxAttempts !== undefined ? `/${retry.maxAttempts}` : "";
    return `连接重试中（重试 ${retry.attempt}${budget}）：${retryErrorText(retry.error)}`;
  }
  if (phase === "compacting") return "压缩上下文中…";
  if (phase === "tools") return "等待工具完成…";
  // A retry already happened: the current attempt is the one that can take minutes (large tool arguments),
  // so keep the failure visible instead of showing a plain spinner.
  const retried = retry && (attempts ?? 0) > 1 ? `（第 ${attempts} 次尝试，上次中断：${retryErrorText(retry.error)}）` : "";
  if (phase === "generating") return `${answering ? "生成回复中…" : "模型生成中…"}${retried}`;
  return `正在准备回复…${retried}`;
}
