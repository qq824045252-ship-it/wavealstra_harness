import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { EntryId, TaskId } from "@earendil-works/pi-durable";
import type { ExecutionFailureDto } from "../../../shared/execution-recovery";
import type { ComputerExecOutput } from "../../platform/computer-use/protocol";
import { isComputerUseObservationFeedback } from "../ComputerUseFailureRecovery";
import { openDurablePassiveStorage } from "./DurableStorage";

/** Old notices omitted the individual checks. Read the owning tool's receipt by ID
 * before deciding whether the reported mismatch was ordinary tool feedback. */
export async function computerToolFeedbackIds(directory: string, rows: ExecutionFailureDto[]): Promise<Set<string>> {
  const feedback = new Set<string>();
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) return feedback;
  try {
    for (const row of rows) {
      const prefix = `durable:${row.taskId}:`;
      if (!row.executionId?.startsWith(prefix)) continue;
      const ids = /^(\d+):(\d+)$/.exec(row.executionId.slice(prefix.length));
      if (!ids) continue;
      const task = await storage.task(Number(ids[2]) as TaskId, ctx);
      if (task?.kind !== "pi.tool" || Number(task.conversationId) !== Number(ids[1])
        || task.state.status !== "terminal" || task.state.outcome.status !== "completed"
        || task.startedAt === undefined || task.endedAt === undefined || row.createdAt < task.startedAt || row.createdAt > task.endedAt) continue;
      const call = task.input;
      const result = task.state.outcome.result;
      if (!call || typeof call !== "object" || Array.isArray(call) || call.kind !== "model" || row.assistantMessageId !== `durable-${call.assistant}`
        || !result || typeof result !== "object" || Array.isArray(result) || result.kind !== "model" || typeof result.entryId !== "number") continue;
      const receipt = (await storage.entry(task.conversationId, result.entryId as EntryId, ctx))?.entry;
      if (receipt?.byTaskId !== task.id) continue;
      const message = receipt.model?.find(m => m.role === "toolResult" && m.toolName === "computer_exec" && m.toolCallId === call.callId);
      if (message?.role !== "toolResult" || message.isError || !message.details) continue;
      const output = message.details as ComputerExecOutput;
      const status = row.causeCode === "computer-semantic-verification-failed" ? "failed" : "not_evaluable";
      if (row.target?.startsWith(`computer:${output.action}:`) && output.semanticOutcome?.status === status && isComputerUseObservationFeedback(output)) {
        feedback.add(row.id);
      }
    }
  } finally { await storage.close(ctx); }
  return feedback;
}
