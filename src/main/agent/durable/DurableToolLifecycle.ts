import { AsyncLocalStorage } from "node:async_hooks";

// This proof is supplied only by the host after reading Pi's durable ToolTask
// checkpoint, never by tool output, diagnostics, or a model-authored message.
const notStarted = new AsyncLocalStorage<{ taskId: number; conversationId: string }>();
export function withNativeNotStarted<T>(proof: { taskId: number; conversationId: string } | undefined, fn: () => T): T {
  return proof ? notStarted.run(proof, fn) : fn();
}
export function isNativeNotStarted(taskId: number, conversationId: string): boolean {
  const proof = notStarted.getStore();
  return proof?.taskId === taskId && proof.conversationId === conversationId;
}
