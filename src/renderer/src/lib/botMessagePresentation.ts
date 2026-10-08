import type { ChatMessage, MessageBlock } from "@/types";

/** Render one Bot reply per user turn while retaining the native Durable records in the store. */
export function botMessagePresentation(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let userId: string | undefined;
  let replies: ChatMessage[] = [];
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
    result.push({ ...last, blocks,
      sourceMessageIds: [...new Set(replies.flatMap(reply => [reply.id, ...reply.sourceMessageIds ?? []]))],
      presentationKey: `durable-turn-${userId ?? first.presentationKey ?? first.id}`,
      createdAt: first.createdAt,
      modelName: [...replies].reverse().find(reply => reply.modelName)?.modelName,
      streaming: replies.some(reply => reply.streaming),
      artifactIds: artifactIds.length ? artifactIds : undefined,
    });
    replies = [];
  };
  for (const message of messages) {
    if (message.role === "user") { flush(); userId = message.id; result.push(message); }
    else replies.push(message);
  }
  flush();
  return result;
}
