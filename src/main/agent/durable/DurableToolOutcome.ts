import { currentDurableInvocation } from "./DurableExecutionContext";

/** Host-only checkpoint; never accept this proof from tool output or model arguments. */
export const TOOL_NOT_STARTED_MEMO = "mybuddy.host-tool-not-started-v1";
export async function recordHostToolNotStarted(toolName: string): Promise<void> {
  const active = currentDurableInvocation();
  if (!active) return;
  await active.native.memo(TOOL_NOT_STARTED_MEMO, {
    toolName, callId: active.native.callId, taskId: active.native.taskId,
    conversationId: active.native.conversationId, phase: "validation",
  }, active.context);
}
