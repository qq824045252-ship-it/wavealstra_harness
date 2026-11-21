import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDocFamily, type ConversationId, type Cursor, type Storage, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import type { SubagentSteerReceipt } from "../../../shared/agent-ipc";
import { openDurablePassiveStorage } from "./DurableStorage";

export const DurableSteerChild = defineDocFamily({
  kind: "mybuddy.subagent-steer-child", version: 1, family: true, scope: "session",
  checkpointWhen: () => true,
  initial: (_seed: null): { conversationId: number | null } => ({ conversationId: null }),
});

const DurableSteerInstruction = defineDocFamily({
  kind: "mybuddy.subagent-steer-instruction", version: 1, family: true, scope: "conversation",
  history: "latest", fork: "initial", checkpointWhen: () => true,
  initial: (_seed: null): { instruction: string; origin?: "user" | "parent" } => ({ instruction: "" }),
});

const PREFIX = "mybuddy:subagent-steer:";
export const STEER_ENTRY_KIND = "mybuddy.subagent-steer";
export const steerRequestKey = (requestId: string): string => PREFIX + requestId;

export function readSteerReceipt(record: SubmissionRecord | undefined, instruction: string, origin?: SubagentSteerReceipt["origin"]): SubagentSteerReceipt | undefined {
  if (record?.type !== "input" || !record.requestId?.startsWith(PREFIX)) return undefined;
  const status = record.status === "queued" ? "queued" : record.status === "placed" ? "processed"
    : record.status === "done" ? "settled" : record.reason === "aborted" ? "cancelled"
      : record.entry === undefined ? "unprocessed" : "unanswered";
  return {
    requestId: record.requestId.slice(PREFIX.length),
    submissionId: record.id,
    accepted: true,
    instruction,
    ...(origin && { origin }),
    status,
    nativeStatus: record.status,
    ...(record.entry !== undefined ? { entryId: record.entry } : {}),
    ...(record.status === "done" ? { answerEntryId: record.answer } : {}),
    ...(record.status === "unanswered" ? { reason: record.reason, ...(typeof record.detail === "string" ? { detail: record.detail } : {}) } : {}),
  };
}

export async function readSteerByRequest(tx: Tx, childId: ConversationId, key: string): Promise<SubagentSteerReceipt | undefined> {
  const submission = await tx.submissionByRequest(childId, key);
  if (!submission) return undefined;
  const metadata = await tx.doc(DurableSteerInstruction, childId, key, null);
  return readSteerReceipt(submission, metadata.instruction, metadata.origin);
}

export async function recordSteerInstruction(tx: Tx, childId: ConversationId, key: string, instruction: string, origin: "user" | "parent"): Promise<void> {
  Object.assign(await tx.doc(DurableSteerInstruction, childId, key, null), { instruction, origin });
}

export async function storedSteerReceipt(storage: Storage, row: SubmissionRecord) {
  if (!row.requestId?.startsWith(PREFIX)) return;
  const doc = await storage.findDocument({ kind: DurableSteerInstruction.definition.kind,
    scope: { kind: "conversation", conversationId: row.conversationId }, key: row.requestId }, "current", ctx);
  const metadata = doc && (await storage.document(doc.id, "current", ctx))?.value;
  const origin = metadata?.origin;
  return readSteerReceipt(row, typeof metadata?.instruction === "string" ? metadata.instruction : "",
    origin === "user" || origin === "parent" ? origin : undefined);
}

export async function readDurableSteerReceipts(directory: string, childId: string): Promise<SubagentSteerReceipt[]> {
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) return [];
  try {
    const address = { kind: DurableSteerChild.definition.kind, scope: { kind: "session" } as const, key: childId };
    const index = await storage.findDocument(address, "current", ctx);
    const id = index && (await storage.document(index.id, "current", ctx))?.value.conversationId;
    if (typeof id !== "number") return [];
    const receipts: SubagentSteerReceipt[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: id as ConversationId }, 100, cursor, ctx);
      for (const row of page.items) {
        const receipt = await storedSteerReceipt(storage, row);
        if (receipt) receipts.push(receipt);
      }
      cursor = page.next;
    } while (cursor);
    return receipts;
  } finally { await storage.close(ctx); }
}
