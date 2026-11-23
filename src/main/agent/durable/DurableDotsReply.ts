import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDocFamily, LiveDoc, type Conversation, type Cursor, type EntryRecord, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { readReplyCitations, type ReplyCitation } from "../../../shared/chat-reply-content";
import type { DotsAssistantReply } from "../../../shared/dots";
import { ActiveDurableConversation } from "./DurableConversationBranch";

export const DOTS_REPLY_ENTRY = "mybuddy.dots-assistant-reply";
export type DotsAppendOutcome = "appended" | "existing" | "pending" | "discarded";
class DeliveryRevoked extends Error {}
const origin = z.object({ conversationId: z.number().int().positive(), entryId: z.number().int().positive() });
const replySchema = z.object({
  deliveryKey: z.string().min(1), operationId: z.string().min(1), sourceMessageId: z.string().min(1),
  taskId: z.string().min(1), title: z.string(), text: z.string(), kind: z.enum(["question","conclusion","progress"]),
  citations: z.unknown().transform(value => {
    const citations: ReplyCitation[] = readReplyCitations(value);
    return citations.length ? citations : undefined;
  }).optional(),
  origin: origin.optional(), artifacts: z.array(z.object({ id: z.string(), name: z.string(), version: z.number().optional(),
    saved: z.object({ snapshotPath: z.string(), name: z.string(), manifestPath: z.string().optional() }).optional() })),
  completion: z.object({ id: z.string(), workId: z.string(), intentRevision: z.number().int(),
    stateVersion: z.number().int() }).optional(),
}).refine(reply => Boolean(reply.text.trim()) || reply.kind === "conclusion" && reply.artifacts.length > 0,
  "Dots 交付需要正文或结果文件");
const receipts = defineDocFamily({ kind: "mybuddy.dots-delivery-receipts", family: true, version: 1, scope: "session",
  checkpointWhen: () => true, initial: (_seed: null): { entryId: number | null } => ({ entryId: null }) });

export function readDotsReply(entry: EntryRecord): DotsAssistantReply | undefined {
  if (entry.kind !== DOTS_REPLY_ENTRY) return;
  const result = replySchema.safeParse(entry.data);
  if (!result.success) throw new Error("Dots 交付消息数据损坏");
  return result.data;
}

export function dotsReplyTimestamp(entry: EntryRecord): number {
  const timestamp = entry.model?.find(message => message.role === "assistant")?.timestamp
    ?? z.object({ deliveredAt: z.number().positive() }).parse(entry.data).deliveredAt;
  return timestamp;
}

// Older in-flight delegations recorded only the request id. Native request ids
// are conversation-scoped; reject ambiguous duplicates on another branch.
async function uniqueLegacySource(tx: Tx, reply: DotsAssistantReply, conversation: Conversation) {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const other of page.items) if (other.id !== conversation.id
      && await tx.submissionByRequest(other.id, reply.sourceMessageId)) return false;
    cursor = page.next;
  } while (cursor);
  return true;
}

export async function appendDurableDotsReply(conversation: Conversation, input: DotsAssistantReply,
  isCurrent: () => boolean): Promise<DotsAppendOutcome> {
  const reply = replySchema.parse(input);
  return conversation.commit<DotsAppendOutcome>(async tx => {
    const receipt = await tx.doc(receipts, reply.deliveryKey, null);
    if (receipt.entryId !== null) {
      const prior = await tx.entry(receipt.entryId as EntryRecord["id"]);
      const saved = prior && readDotsReply(prior);
      if (saved?.operationId !== reply.operationId || saved.taskId !== reply.taskId || saved.sourceMessageId !== reply.sourceMessageId
        || saved.kind !== reply.kind || ((saved.completion || reply.completion) &&
          (JSON.stringify(saved.completion) !== JSON.stringify(reply.completion) || saved.text !== reply.text ||
            JSON.stringify(saved.artifacts) !== JSON.stringify(reply.artifacts)))
        || reply.origin && (prior?.conversationId !== reply.origin.conversationId
          || saved.origin && saved.origin.entryId !== reply.origin.entryId)) {
        throw new Error("Dots 交付身份冲突");
      }
      return "existing";
    }
    const active = await tx.doc(ActiveDurableConversation);
    if (!isCurrent() || active.conversationId !== null && active.conversationId !== conversation.id
      || reply.origin && reply.origin.conversationId !== conversation.id) return "discarded";
    const source = await tx.submissionByRequest(conversation.id, reply.sourceMessageId);
    if (source?.type !== "input" || source.conversationId !== conversation.id
      || source.status === "unanswered" && (source.reason === "aborted" || source.reason === "reset")) return "discarded";
    if (!reply.origin && !await uniqueLegacySource(tx, reply, conversation)) return "discarded";
    if (source.status === "queued") return "pending";
    if (source.entry === undefined) return "discarded";
    const user = await tx.entry(source.entry);
    const data = user?.data;
    const meta = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
    if (user?.conversationId !== conversation.id || user.kind !== "mybuddy.user" || reply.origin && source.entry !== reply.origin.entryId
      || !meta || typeof meta !== "object" || Array.isArray(meta) || meta.inputRequestId !== reply.sourceMessageId) return "discarded";
    if (source.status === "placed") return "pending";
    const acknowledged = source.status === "done" ? await tx.entry(source.answer) : undefined;
    const answer = acknowledged?.model?.find(m => m.role === "assistant");
    if (source.status === "done" && (!answer || acknowledged?.conversationId !== conversation.id || answer.stopReason === "aborted")) return "discarded";
    // Never cut between a native tool call and its result, even on a later turn.
    if ((await tx.doc(LiveDoc, conversation.id)).run) return "pending";
    if (!isCurrent()) return "discarded";
    const userTimestamp = user.model?.find(message => message.role === "user")?.timestamp ?? 0;
    const timestamp = Math.max(Date.now(), (answer?.timestamp ?? userTimestamp) + 1);
    const deliveryData = JSON.parse(JSON.stringify({ ...reply, deliveredAt: timestamp })) as JsonObject;
    const entry = await tx.appendEntry(conversation.id, { kind: DOTS_REPLY_ENTRY, data: deliveryData,
      ...(reply.text.trim() ? { model: [{ role: "assistant", content: [{ type: "text", text: reply.text }], timestamp, stopReason: "stop",
        api: "mybuddy-delivery", provider: "mybuddy", model: "Dots", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] } : {}) });
    if (!isCurrent()) throw new DeliveryRevoked();
    receipt.entryId = entry.id;
    return "appended";
  }, ctx).catch(error => {
    if (error instanceof DeliveryRevoked) return "discarded" as const;
    throw error;
  });
}
