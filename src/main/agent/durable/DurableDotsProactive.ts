import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDocFamily, LiveDoc, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";
import { ActiveDurableConversation } from "./DurableConversationBranch";

const entryKind = "mybuddy.dots-proactive";
const receipt = defineDocFamily({
  kind: "mybuddy.dots-proactive-receipt", family: true, version: 1, scope: "session",
  checkpointWhen: () => true, initial: (_seed: null): { entryId: number | null; workspace?: string } => ({ entryId: null }),
});
const entryData = z.object({ key: z.string().min(1), text: z.string().min(1), deliveredAt: z.number().positive() });
export type DotsProactiveOutcome = { status: "appended" | "existing"; messageId: string; workspace?: string } | { status: "pending" };
class DeliveryPaused extends Error {}

export function readDotsProactive(entry: EntryRecord) {
  return entry.kind === entryKind ? entryData.parse(entry.data) : undefined;
}

export async function appendDurableDotsProactive(conversation: Conversation, key: string, text: string,
  isCurrent: () => boolean): Promise<DotsProactiveOutcome> {
  try {
    return await conversation.commit<DotsProactiveOutcome>(async tx => {
      const saved = await tx.doc(receipt, key, null);
      if (saved.entryId !== null) return { status: "existing", messageId: `durable-${saved.entryId}`, workspace: saved.workspace };
      const active = await tx.doc(ActiveDurableConversation);
      if (!isCurrent() || active.conversationId !== null && active.conversationId !== conversation.id
        || (await tx.doc(LiveDoc, conversation.id)).run) return { status: "pending" };
      const data = entryData.parse({ key, text, deliveredAt: Date.now() });
      // The notification is visible history only. External text never becomes model context.
      const entry = await tx.appendEntry(conversation.id, { kind: entryKind, data });
      if (!isCurrent()) throw new DeliveryPaused();
      saved.entryId = entry.id;
      saved.workspace = active.dotsWorkspace;
      return { status: "appended", messageId: `durable-${entry.id}`, workspace: active.dotsWorkspace };
    }, context);
  } catch (error) {
    if (error instanceof DeliveryPaused) return { status: "pending" };
    throw error;
  }
}
