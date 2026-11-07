import { z } from "zod";
import type { Cursor, EntryRecord, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import type { WorkExecutionObservation } from "../work/WorkExecutionAdapter";
import { DurableHistoryProjection, durableContentText } from "./DurableHistoryProjection";

/**
 * Read the accepted input-to-answer span from its original persisted conversation.
 * Pi may settle several steered inputs with one answer; this span is shared run
 * evidence, not exclusive causal attribution to an input. The Work admission
 * gate rejects new business operation IDs on a bound execution task.
 */
export async function readDurableWorkExecution(
  tx: Pick<Tx, "scanEntries">,
  record: SubmissionRecord,
): Promise<WorkExecutionObservation> {
  if (record.status === "queued" || record.status === "placed") return { status: "running" };
  if (record.status === "unanswered") {
    let usageTokens = 0;
    let cursor: Cursor | undefined;
    let reported = false;
    let nextInput = false;
    if (record.type === "input" && record.entry !== undefined) do {
      const page = await tx.scanEntries({ conversationId: record.conversationId, minEntryId: record.entry, order: "ascending" }, 200, cursor);
      for (const entry of page.items) {
        if (entry.id !== record.entry && entry.model?.some(message => message.role === "user")) { nextInput = true; break; }
        for (const message of entry.model ?? []) if (message.role === "assistant") {
          reported = true; usageTokens += message.usage.totalTokens;
        }
      }
      cursor = page.next;
    } while (cursor && !nextInput);
    return { status: record.reason === "aborted" ? "stopped" : "failed",
      summary: typeof record.detail === "string" ? record.detail : record.reason, hasWriteConflicts: false, artifactRefs: [],
      // An interrupted provider may have unreported spend. Never call that zero.
      usageTokens: reported && record.reason !== "aborted" ? usageTokens : undefined };
  }
  if (record.type !== "input" || record.status !== "done" || record.answer === undefined) {
    throw new Error("原生回执不是已结束的业务输入");
  }
  const projection = new DurableHistoryProjection();
  let answerEntry: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  let usageTokens = 0;
  do {
    const page = await tx.scanEntries({ conversationId: record.conversationId,
      minEntryId: record.entry, maxEntryId: record.answer, order: "ascending" }, 200, cursor);
    projection.merge(page.items, new Map(), {});
    usageTokens += page.items.reduce((sum, entry) => sum + (entry.model ?? []).reduce((tokens, message) =>
      tokens + (message.role === "assistant" ? message.usage.totalTokens : 0), 0), 0);
    answerEntry ??= page.items.find(entry => entry.id === record.answer);
    cursor = page.next;
  } while (cursor);
  const answer = answerEntry?.model?.find(message => message.role === "assistant");
  return {
    sourceEntryId: record.answer,
    usageTokens,
    status: !answer || ["error", "length"].includes(answer.stopReason) ? "failed" : answer.stopReason === "aborted" ? "stopped" : "completed",
    summary: answer ? durableContentText(answer.content) : "原生输入未产生可核对的成果",
    hasWriteConflicts: projection.messages.some(message => message.tools?.some(tool => nativeWriteConflicts(tool.detail))),
    artifactRefs: [...new Set(projection.messages.flatMap(message => (message.artifacts ?? [])
      .flatMap(artifact => artifact.path ? [artifact.path] : [])))],
  };
}

function nativeWriteConflicts(detail: string | undefined): boolean {
  if (!detail) return false;
  try {
    const value = z.json().parse(JSON.parse(detail));
    const contains = (item: typeof value): boolean => {
      if (!item || typeof item !== "object") return false;
      if (Array.isArray(item)) return item.some(contains);
      if (Array.isArray(item.writeConflicts) && item.writeConflicts.length > 0) return true;
      return Object.values(item).some(contains);
    };
    return contains(value);
  } catch { return false; }
}
