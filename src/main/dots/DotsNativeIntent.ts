import { InboxDoc, type ConversationId, type Cursor, type Tx } from "@earendil-works/pi-durable";

/** An admitted input has the same submission id before and after it leaves the inbox. */
export async function dotsInputVersion(tx: Tx, conversationId: ConversationId) {
  const inbox = await tx.doc(InboxDoc, conversationId);
  let latest = inbox.items.reduce((max, item) => item.mode === "write" ? max : Math.max(max, item.id), 0);
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 80, cursor);
    for (const entry of page.items) {
      if (entry.kind !== "mybuddy.user") continue;
      const data = entry.data;
      const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
      const key = input && typeof input === "object" && !Array.isArray(input) ? input.inputRequestId : undefined;
      const receipt = typeof key === "string" ? await tx.submissionByRequest(conversationId, key) : undefined;
      return JSON.stringify([conversationId, Math.max(latest, receipt?.id ?? 0), receipt ? undefined : entry.id]);
    }
    cursor = page.next;
  } while (cursor);
  return JSON.stringify([conversationId, latest, null]);
}

export class DotsIntentChanged extends Error {}
