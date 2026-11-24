import type { ConversationId, EntryId, SubmissionId, ToolExecutionApi, Cursor } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { readDotsReply } from "./DurableDotsReply";
import { isDotsAutomaticInput } from "../../../shared/dots";

/**
 * Resolve a host's original input from the exact native run receipt. No timestamp or
 * 'last message' fallback is safe for an external recipient. Multiple inputs are ambiguous.
 */
export async function durableSourceInput(
  native: Pick<ToolExecutionApi, "commit">, context: Context,
  conversationId: ConversationId, inputs: readonly SubmissionId[], latest = false,
) {
  if (!inputs.length || (!latest && inputs.length !== 1)) return undefined;
  const source = inputs.at(-1);
  return native.commit(async tx => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        if (entry.kind !== "mybuddy.user") continue;
        const input = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
          ? entry.data.mybuddyInput : undefined;
        const audit = input && typeof input === "object" && !Array.isArray(input) ? input.audit : undefined;
        const id = audit && typeof audit === "object" && !Array.isArray(audit) ? audit.userMessageId : undefined;
        if (typeof id !== "string" || !id.trim()) continue;
        const receipt = await tx.submissionByRequest(conversationId, id);
        if (receipt?.type === "input" && receipt.id === source && receipt.entry === entry.id && input && typeof input === "object" && !Array.isArray(input)) {
          const message = entry.model?.find(item => item.role === "user");
          return { id, entryId: entry.id, text: typeof input.displayText === "string" ? input.displayText : "",
            createdAt: message?.timestamp };
        }
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  }, context);
}

export async function durableSourceUserMessageId(...args: Parameters<typeof durableSourceInput>): Promise<string | undefined> {
  return (await durableSourceInput(...args))?.id;
}

export async function durableEarlierUserText(native: Pick<ToolExecutionApi, "commit">, context: Context,
  conversationId: ConversationId, before: number, matches: (text: string) => boolean) {
  return native.commit(async tx => {
    let cursor: Cursor | undefined;
    let remaining = 12;
    while (remaining > 0) {
      const page = await tx.scanEntries({ conversationId, maxEntryId: (before - 1) as EntryId, order: "descending" }, 80, cursor);
      for (const entry of page.items) {
        if (entry.kind !== "mybuddy.user") continue;
        const data = entry.data;
        const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
        if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.displayText !== "string") continue;
        const audit = input.audit;
        const id = audit && typeof audit === "object" && !Array.isArray(audit) ? audit.userMessageId : undefined;
        if (typeof id !== "string" || isDotsAutomaticInput(id)) continue;
        if (matches(input.displayText)) {
          const receipt = await tx.submissionByRequest(conversationId, id);
          if (receipt?.type === "input" && receipt.entry === entry.id) return input.displayText;
        }
        if (--remaining === 0) return;
      }
      cursor = page.next;
      if (!cursor) return;
    }
  }, context);
}

export async function durableDotsRetryQuestion(native: Pick<ToolExecutionApi, "commit">, context: Context,
  conversationId: ConversationId, before: number) {
  return native.commit(async tx => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId, maxEntryId: (before - 1) as EntryId, order: "descending" }, 80, cursor);
      for (const entry of page.items) {
        const reply = readDotsReply(entry);
        if (reply?.kind === "progress") continue;
        if (reply?.kind === "question") return reply;
        if (reply || entry.kind === "mybuddy.user" || entry.kind === "pi.user" || entry.model?.some(message =>
          message.role === "assistant" && message.stopReason !== "toolUse" && message.content.some(block => block.type === "text" && block.text.trim()))) return;
      }
      cursor = page.next;
    } while (cursor);
  }, context);
}


// Reading may use the first placed input as its accounting root even when
// steering has placed more inputs. The normal side-effect provenance stays strict.
export async function durableForegroundInputs(native: Pick<ToolExecutionApi, "commit">, context: Context,
  conversationId: ConversationId, inputs: readonly SubmissionId[], first?: EntryId, includeAttachments = false) {
  return native.commit(async tx => {
    const remaining = new Set(inputs);
    const resolved = new Map<SubmissionId, import("../../dots/DotsForegroundReads").ForegroundInput>();
    let cursor: Cursor | undefined;
    while (remaining.size) {
      const page = await tx.scanEntries({ conversationId, minEntryId: first, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        if (entry.kind !== "mybuddy.user") continue;
        const data = entry.data;
        const meta = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
        if (!meta || typeof meta !== "object" || Array.isArray(meta) || typeof meta.displayText !== "string") continue;
        const audit = meta.audit;
        const raw = audit && typeof audit === "object" && !Array.isArray(audit) ? audit.userMessageId : undefined;
        const requestId = typeof meta.inputRequestId === "string" ? meta.inputRequestId : raw;
        if (typeof requestId !== "string") continue;
        const receipt = await tx.submissionByRequest(conversationId, requestId);
        if (receipt?.type !== "input" || receipt.entry !== entry.id || !remaining.delete(receipt.id)) continue;
        const attachments = includeAttachments && Array.isArray(meta.attachments) ? meta.attachments.flatMap(attachment => {
          if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)
            || typeof attachment.name !== "string" || !attachment.name.trim() || typeof attachment.path !== "string" || !attachment.path.trim()) return [];
          return [{ name: attachment.name, path: attachment.path }];
        }) : undefined;
        resolved.set(receipt.id, { id: requestId, entryId: entry.id, text: meta.displayText,
          createdAt: entry.model?.find(message => message.role === "user")?.timestamp, ...(attachments?.length ? { attachments } : {}) });
      }
      cursor = page.next;
      if (!cursor) break;
    }
    return remaining.size ? undefined : inputs.map(id => resolved.get(id)!);
  }, context);
}
