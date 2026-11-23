import { AsyncLocalStorage } from "node:async_hooks";

// This proof is supplied only by the host after reading Pi's durable ToolTask
// checkpoint, never by tool output, diagnostics, or a model-authored message.
const notStarted = new AsyncLocalStorage<{ taskId: number; conversationId: string; assistantEntryId?: number; notStarted?: boolean }>();
export function withNativeToolOrigin<T>(origin: { taskId: number; conversationId: string; assistantEntryId?: number; notStarted?: boolean }, fn: () => T): T {
  return notStarted.run(origin, fn);
}
function nativeToolOrigin(taskId: number, conversationId: string) {
  const origin = notStarted.getStore();
  return origin?.taskId === taskId && origin.conversationId === conversationId ? origin : undefined;
}
export function isNativeNotStarted(taskId: number, conversationId: string): boolean {
  return nativeToolOrigin(taskId, conversationId)?.notStarted === true;
}
export function nativeAssistantEntry(taskId: number, conversationId: string): number | undefined {
  return nativeToolOrigin(taskId, conversationId)?.assistantEntryId;
}
