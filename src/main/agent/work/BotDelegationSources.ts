import { z } from "zod";
import { botAttachmentSchema, type BotMessageDto } from "../../../shared/bot-conversation";
import { botPeerOriginSchema } from "../../../shared/bot-peer-origin";

export const botDelegationSourceSchema = z.object({
  messageId: z.string(), conversationId: z.string(), botId: z.string(), requestId: z.string(),
  role: z.enum(["user", "assistant"]), text: z.string(), ordinal: z.number(),
  attachments: z.array(botAttachmentSchema).optional(), peerOrigin: botPeerOriginSchema.optional(),
});
export type BotDelegationSource = z.infer<typeof botDelegationSourceSchema>;

/** These are the exact projected messages visible when this request started. */
export function freezeBotDelegationSources(messages: readonly BotMessageDto[], visibleIds: readonly string[]): BotDelegationSource[] {
  const visible = new Set(visibleIds);
  return [...new Map(messages.filter(message => visible.has(message.messageId)
    && message.status === "completed" && message.text !== "[该历史证据已撤销]")
    .map(message => [message.messageId, botDelegationSourceSchema.parse(message)])).values()];
}

export function botDelegationSourceIndex(sources: readonly BotDelegationSource[] = []) {
  return sources.map(source => ({ messageId: source.messageId, role: source.role,
    ...(source.peerOrigin ? { source: "bot_collaboration", humanStatement: false } : {}),
    text: source.text.slice(0, 320), truncated: source.text.length > 320,
    attachments: source.attachments?.map(attachment => attachment.name) }));
}
