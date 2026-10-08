/** Ephemeral UI telemetry. Token estimates must never enter billing/usage records. */
export interface GenerationStats {
  phase: "waiting" | "generating" | "tools" | "retrying" | "compacting" | "complete";
  startedAt: number;
  updatedAt: number;
  /** Current request while streaming; duration-weighted reply average after completion. */
  tps: number | null;
  estimated: boolean;
  /** Authoritative total only; null if any request omitted usable output usage. */
  outputTokens: number | null;
  /** First model response in this reply, including thinking/tool-call output. */
  ttftMs: number | null;
  outcome?: "completed" | "aborted" | "error";
}

/** Display native events without inventing a model-thinking timer/state machine. */
export function nativeRunPhaseLabel(phase: GenerationStats["phase"] | undefined, activeTools: string[], answering = false): string {
  if (activeTools.includes("request_user_input") || activeTools.includes("conversation_goal_propose_complete")) return "等待用户回答…";
  if (activeTools.length) return `正在执行 ${activeTools[0]}…`;
  if (phase === "retrying") return "连接重试中…";
  if (phase === "compacting") return "压缩上下文中…";
  if (phase === "tools") return "等待工具完成…";
  if (phase === "generating") return answering ? "生成回复中…" : "模型生成中…";
  return "正在准备回复…";
}
