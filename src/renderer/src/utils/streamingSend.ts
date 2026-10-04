export type StreamingSendIntent = "continue" | "steer" | "interrupt";

export interface StreamingSendPlan {
  /** 发送前是否必须先 abort 当前 Session（仅 interrupt 为 true）。 */
  abortBeforeSend: boolean;
  /** 传给主进程 SDK 的流式投递语义；不 abort 时才有值。 */
  behavior?: "steer" | "followUp";
}

/**
 * 将输入框意图解析为唯一投递计划（方案 Problem Two 4.3）。
 *
 * 关键语义：
 * - `continue`  → 不 abort，主进程等待当前完整执行结束后处理（SDK followUp 作流式兜底）。
 * - `steer`     → 不 abort，在安全边界改变当前方向（引导 ≠ 打断）。
 * - `interrupt` → 先由调用方等待 abort 完成，再作为普通 prompt 启动新一轮。
 *
 * 该函数是 abort/behavior 决策的唯一权威，杜绝"同一个意图既 abort 又 steer"的矛盾。
 */
export function resolveStreamingSendPlan(
  executing: boolean,
  intent: StreamingSendIntent,
): StreamingSendPlan {
  if (!executing) return { abortBeforeSend: false };
  if (intent === "continue") return { abortBeforeSend: false, behavior: "followUp" };
  if (intent === "steer") return { abortBeforeSend: false, behavior: "steer" };
  return { abortBeforeSend: true };
}
