import type { ChatMessageDto } from "../../../../../shared/agent-ipc";
import type { ChatMessage } from "../../../types";
import { formatDuration } from "../format";

export function historyMessageToChatMessage(m: ChatMessageDto): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    modelName: m.modelName,
    externalAgent: m.externalAgent,
    durationLabel: formatDuration(m.durationMs),
    entryId: m.entryId,
    attachments: m.attachments,
    blocks:
      m.role === "user"
        ? [{ type: "text" as const, text: m.text }]
        : [
            ...(m.thinking
              ? [{ type: "thinking" as const, text: m.thinking }]
              : []),
            ...(m.tools ?? []).map((tool) => ({
              type: "tool" as const,
              toolCall: { ...tool },
            })),
            ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
          ],
    finalBlocks:
      m.role === "assistant" && m.text
        ? [{ type: "text" as const, text: m.text }]
        : undefined,
    artifactIds: m.artifactIds,
    streaming: false,
  };
}

/** Durable keeps intermediate blocks separate from the final reply. */
export function durableMessageToChatMessage(message: ChatMessageDto): ChatMessage {
  const row = historyMessageToChatMessage(message);
  return { ...row, presentationKey: message.presentationKey, generationStats: message.generationStats, streaming: message.streaming,
    blocks: message.role === "assistant" ? row.blocks.filter(block => block.type !== "text") : row.blocks };
}
