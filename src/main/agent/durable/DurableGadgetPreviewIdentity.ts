import { defineEntry, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import { currentDurableInvocation } from "./DurableExecutionContext";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function origin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return `http://127.0.0.1:${url.port || "80"}`;
  } catch { /* Non-URL tool fields carry no preview identity. */ }
}

export const GadgetPreviewEntry = defineEntry<{ gadgetId: string; url: string }>("mybuddy.gadget-preview");

/** This accepts only typed host result fields, never text output. */
export function gadgetPreviewIdentities(toolName: string, details: unknown): Array<{ gadgetId: string; url: string }> {
  const receipts: Array<{ gadgetId: string; url: string }> = [];
  const add = (value: unknown) => {
    if (!record(value) || typeof value.gadgetId !== "string" || !/^gdt-[a-zA-Z0-9_-]+$/.test(value.gadgetId)) return;
    const url = origin(value.url); if (url) receipts.push({ gadgetId: value.gadgetId, url });
  };
  if (!record(details)) return receipts;
  if (toolName === "browser_exec" && details.action === "navigate" && record(details.outcome) && details.outcome.effect === "confirmed") add(details);
  if (toolName === "gadget_open" && details.status === "running") add(details);
  if (toolName === "gadget_update" && record(details.runtime) && details.runtime.status === "running") add(details.runtime);
  if (toolName === "gadget_list" && Array.isArray(details.gadgets)) for (const item of details.gadgets) {
    if (record(item) && record(item.runtime) && item.id === item.runtime.gadgetId && item.runtime.status === "running") add(item.runtime);
  }
  return receipts;
}

/** Read successful host receipts, never assistant/user prose or HTML. */
export function gadgetIdsForPreview(entries: readonly Pick<EntryRecord, "kind" | "model" | "data">[], url: string): Set<string> {
  const wanted = origin(url), ids = new Set<string>();
  if (!wanted) return ids;
  for (const entry of entries) {
    if (entry.kind === GadgetPreviewEntry.kind && record(entry.data) && typeof entry.data.gadgetId === "string" && /^gdt-[a-zA-Z0-9_-]+$/.test(entry.data.gadgetId) && origin(entry.data.url) === wanted) ids.add(entry.data.gadgetId);
    if (entry.kind !== "pi.tool-result") continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult" || message.isError) continue;
      for (const receipt of gadgetPreviewIdentities(message.toolName, message.details)) if (receipt.url === wanted) ids.add(receipt.gadgetId);
    }
  }
  return ids;
}

export async function resolveDurableGadgetPreview(url: string, taskId: string): Promise<string | undefined> {
  const active = currentDurableInvocation();
  if (!origin(url) || !active || active.execution.taskId !== taskId) return;
  return active.native.commit(async tx => {
    let conversationId = active.native.conversationId;
    const seen = new Set<typeof conversationId>();
    for (;;) {
      if (seen.has(conversationId)) throw new Error("浏览器历史归属出现循环");
      seen.add(conversationId);
      const conversation = await tx.conversation(conversationId);
      if (!conversation?.owner) break;
      conversationId = conversation.owner.conversationId;
    }
    const ids = new Set<string>(), visited = new Set<typeof conversationId>();
    const conversations = [conversationId];
    for (let index = 0; index < conversations.length; index++) {
      const id = conversations[index];
      if (visited.has(id)) continue;
      visited.add(id);
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: id, order: "descending" }, 100, cursor);
        for (const gadgetId of gadgetIdsForPreview(page.items, url)) ids.add(gadgetId);
        if (ids.size > 1) throw new Error("历史中该预览端口属于多个 Gadget，请显式提供 gadgetId；不会猜测归属");
        cursor = page.next;
      } while (cursor);
      // Follow native ownership edges, not conversation IDs found in model text.
      do {
        const page = await tx.scanConversations({ ownerConversationId: id }, 100, cursor);
        for (const child of page.items) conversations.push(child.id);
        cursor = page.next;
      } while (cursor);
    }
    return ids.values().next().value;
  }, active.context);
}
