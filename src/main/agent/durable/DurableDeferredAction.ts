import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineTask, NestedCallDoc, ToolTask,
  type Harness, type ConversationId, type JsonObject, type TaskId } from "@earendil-works/pi-durable";

/** Only the host writes this document, atomically with creation of the exact native leaf. */
export const DeferredActionIdentity = defineDoc<{ approvalId: string; deliveryId: string }>({
  kind: "mybuddy.work-deferred-action-identity", version: 1, scope: "task",
  initial: () => ({ approvalId: "", deliveryId: "" }), checkpointWhen: () => false,
});
const DeferredActionReceipt = defineDocFamily<{ taskId?: number; fingerprint?: string }, null>({
  kind: "mybuddy.work-deferred-action-receipt", version: 1, scope: "session", family: true,
  initial: () => ({}), checkpointWhen: () => false,
});
export type DeferredNativeInput = {
  approvalId: string; deliveryId: string; sourceConversationId: string; toolName: string; arguments: JsonObject;
};
type Checkpoint = { phase: "prepare" } | { phase: "settle"; childId: number };
/** No model, rewritten prompt, or application retry scheduler: Pi owns this exact leaf and recovery. */
export const DeferredActionTask = defineTask<DeferredNativeInput, Checkpoint, JsonObject>({
  name: "mybuddy.work-deferred-action", version: 1, initial: () => ({ phase: "prepare" }),
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "续跑已停止，原动作不重放" } }), ctx);
  },
  phases: {
    prepare: async (task, runtime, ctx) => {
      await runtime.commit(async tx => {
        const key = "approved-action";
        const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
        const callId = `approved:${task.input.approvalId}`;
        const childId = state.taskId ?? await tx.createTask(ToolTask, {
          kind: "nested", parent: runtime.taskId, parentCallId: callId, key,
          call: { type: "toolCall", id: `${callId}/${key}`, name: task.input.toolName, arguments: task.input.arguments },
          progress: false,
        }, { ownership: { kind: "task", taskId: runtime.taskId } });
        state.taskId = childId;
        const identity = await tx.doc(DeferredActionIdentity, childId);
        identity.approvalId = task.input.approvalId;
        identity.deliveryId = task.input.deliveryId;
        return { status: "waiting", checkpoint: { phase: "settle", childId }, on: [childId], policy: "allSettled" };
      }, ctx);
    },
    settle: async (task, runtime, ctx) => {
      await runtime.commit(async tx => {
        const state = await tx.doc(NestedCallDoc, runtime.taskId, "approved-action", null);
        const child = await tx.task(task.state.checkpoint.childId as TaskId);
        const result: JsonObject = state.result ? { result: state.result } : {
          isError: true, reason: "原生动作没有完整回执；未创建替代调用", childStatus: child?.state.status ?? "missing",
        };
        await tx.appendEntry(runtime.conversationId, { kind: "mybuddy.work-deferred-result",
          data: { approvalId: task.input.approvalId, ...result } });
        return { status: "terminal", outcome: { status: "completed", result } };
      }, ctx);
    },
  },
});

/** Admission deduplicates in the native log, even if SQLite delivery acknowledgement is lost. */
export async function submitDeferredNativeAction(harness: Harness, input: DeferredNativeInput): Promise<number> {
  const conversationId = Number(input.sourceConversationId) as ConversationId;
  if (!Number.isSafeInteger(conversationId) || !await harness.conversation(conversationId, context)) {
    throw new Error("审批动作的原始执行会话不存在，不能改用另一身份执行");
  }
  const fingerprint = JSON.stringify(input);
  const id = await harness.commit(async tx => {
    const receipt = await tx.doc(DeferredActionReceipt, input.deliveryId, null);
    if (receipt.taskId !== undefined) {
      if (receipt.fingerprint !== fingerprint) throw new Error("同一审批的持久执行内容已变化");
      return receipt.taskId;
    }
    const taskId = await tx.createTask(DeferredActionTask, input, { ownership: { kind: "conversation" }, conversationId });
    receipt.taskId = taskId;
    receipt.fingerprint = fingerprint;
    return taskId;
  }, context);
  harness.resume();
  return id;
}
