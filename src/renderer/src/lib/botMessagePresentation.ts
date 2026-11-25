import type { ChatMessage, MessageBlock } from "@/types";
import type { DurableBotSnapshot } from "@shared/durable-bot";
import { DOTS_NO_CHANGE, isDotsAutomaticInput } from "@shared/dots";

export function isQuietDotsReply(message: ChatMessage, automatic: boolean): boolean {
  if (!automatic || message.role !== "assistant") return false;
  const reply = message.finalBlocks?.length ? message.finalBlocks : message.blocks;
  return reply.flatMap(block => block.type === "text" ? [block.text] : []).join("").trim() === DOTS_NO_CHANGE;
}

export function hasUnreadDotsReply(messages: readonly ChatMessage[], seenAt: number): boolean {
  let automatic = false;
  for (const message of botMessagePresentation(messages)) {
    if (message.role === "user") {
      automatic = isDotsAutomaticInput(message.inputRequestId ?? "");
    } else if (message.createdAt > seenAt && message.dotsDelivery?.kind !== "progress"
      && (message.dotsDelivery || !isQuietDotsReply(message, automatic))) {
      return true;
    }
  }
  return false;
}

/** Render one Bot reply per user turn while retaining the native Durable records in the store. */
export function botMessagePresentation(
  messages: readonly ChatMessage[],
  pendingInputs: readonly DurableBotSnapshot["pendingInputs"][number][] = [],
  localInputs: readonly ChatMessage[] = [],
  dotsBusy = false,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  let userId: string | undefined;
  let replies: ChatMessage[] = [];
  let afterDelivery: string | undefined;
  const flush = (): void => {
    if (!replies.length) return;
    const first = replies[0];
    const last = replies[replies.length - 1];
    const blocks: MessageBlock[] = [];
    const toolIndices = new Map<string, number>();
    for (const [index, reply] of replies.entries()) {
      const step = [...reply.blocks];
      if (index < replies.length - 1 && reply.finalBlocks?.length) {
        const toolIndex = step.findIndex(block => block.type === "tool");
        step.splice(toolIndex < 0 ? step.length : toolIndex, 0, ...reply.finalBlocks);
      }
      for (const block of step) {
        const prior = block.type === "tool" ? toolIndices.get(block.toolCall.id) : undefined;
        if (prior !== undefined) blocks[prior] = block;
        else {
          if (block.type === "tool") toolIndices.set(block.toolCall.id, blocks.length);
          blocks.push(block);
        }
      }
    }
    const artifactIds = [...new Set(replies.flatMap(reply => reply.artifactIds ?? []))];
    const interactions = [...new Map(replies.flatMap(reply => reply.interactions ?? []).map(interaction => [interaction.id, interaction])).values()];
    result.push({ ...last, blocks,
      sourceMessageIds: [...new Set(replies.flatMap(reply => [reply.id, ...reply.sourceMessageIds ?? []]))],
      presentationKey: afterDelivery ? `durable-turn-after-${afterDelivery}` : `durable-turn-${userId ?? first.presentationKey ?? first.id}`,
      createdAt: first.createdAt,
      modelName: [...replies].reverse().find(reply => reply.modelName)?.modelName,
      streaming: replies.some(reply => reply.streaming),
      artifactIds: artifactIds.length ? artifactIds : undefined,
      interactions: interactions.length ? interactions : undefined,
    });
    replies = [];
  };
  for (const message of messages) {
    if (message.dotsDelivery || message.dotsProactive) {
      flush();
      result.push(message);
      afterDelivery = message.id;
    } else if (message.role === "user") {
      flush();
      afterDelivery = undefined;
      userId = message.inputRequestId ?? message.id;
      result.push(message.inputRequestId ? { ...message, presentationKey: `durable-input-${message.inputRequestId}` } : message);
    }
    else replies.push(message);
  }
  flush();
  // Queue previews belong only to this display projection. The next native
  // snapshot removes them when it consumes the input and adds the real records.
  for (const input of pendingInputs) {
    result.push(
      { id: `durable-queued-user-${input.id}`, role: "user", createdAt: 0,
        inputRequestId: input.inputRequestId,
        presentationKey: input.inputRequestId ? `durable-input-${input.inputRequestId}` : undefined,
        blocks: [{ type: "text", text: input.text }] },
      { id: `durable-queued-reply-${input.id}`, role: "assistant", createdAt: 0,
        blocks: [], streaming: true, pendingBehavior: input.mode },
    );
  }
  for (const input of localInputs) result.push({ ...input, presentationKey: `durable-input-${input.id}` });
  const tail = result.at(-1);
  if (dotsBusy && tail?.role === "user" && !tail.submissionFailed && !tail.goalContinuation && !isDotsAutomaticInput(tail.inputRequestId ?? tail.id)) {
    result.push({ id: `dots-activity-${tail.id}`, presentationKey: `durable-turn-${tail.inputRequestId ?? tail.id}`,
      role: "assistant", createdAt: 0, blocks: [], streaming: true });
  } else if (dotsBusy && tail?.role === "assistant" && !tail.finalAssistantReply && !tail.dotsDelivery && !tail.dotsProactive
    && !tail.streaming && tail.generationStats?.outcome !== "aborted" && tail.generationStats?.outcome !== "error") {
    result[result.length - 1] = { ...tail, streaming: true };
  }
  return result;
}
