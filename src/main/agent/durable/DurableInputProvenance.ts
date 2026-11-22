import type { ConversationId, SubmissionId, ToolExecutionApi, Cursor } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

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
