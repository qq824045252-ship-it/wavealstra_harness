import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import type { HookApi, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ConversationExecutionContext } from "../ConversationExecutionContext";

const executionMemo = "mybuddy.execution-context";
type IdentityApi = Pick<HookApi, "memo" | "taskId" | "conversationId">;
interface Invocation {
  execution: ConversationExecutionContext;
  cwd: string;
  runId: string;
  native: ToolExecutionApi;
  context: Context;
}
const invocation = new AsyncLocalStorage<Invocation>();

/** The host binds product identity; native IDs scope each call, including Code Mode's nested calls. */
export async function durableExecutionContext(taskId: string, api: IdentityApi, context: Context, assistantMessageId?: string): Promise<ConversationExecutionContext> {
  const executionId = `durable:${taskId}:${api.conversationId}:${api.taskId}`;
  const stored = await api.memo(executionMemo, context);
  if (stored !== undefined) {
    if (stored && typeof stored === "object" && !Array.isArray(stored)
      && stored.taskId === taskId && stored.executionId === executionId && typeof stored.assistantMessageId === "string") {
      return { taskId, executionId: stored.executionId, assistantMessageId: stored.assistantMessageId };
    }
    throw new Error("持久工具执行身份与宿主任务不一致");
  }
  const identity = { taskId, executionId,
    assistantMessageId: assistantMessageId ?? `durable-tool-${api.taskId}` };
  await api.memo(executionMemo, identity, context);
  return identity;
}

export function withDurableExecution<T>(value: Invocation, run: () => Promise<T>): Promise<T> {
  return invocation.run(value, run);
}

export function currentDurableExecutionContext(): ConversationExecutionContext | undefined {
  return invocation.getStore()?.execution;
}

export function currentDurableExecutionCwd(): string | undefined {
  return invocation.getStore()?.cwd;
}

export function currentDurableRunId(): string | undefined {
  return invocation.getStore()?.runId;
}

export function currentDurableInvocation(): Invocation | undefined {
  return invocation.getStore();
}
