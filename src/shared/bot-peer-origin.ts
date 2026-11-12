import { z } from "zod";

const id = z.string().min(1).max(500);
/** Host provenance, never accepted from botSendSchema or a model tool. */
const source = {
  collaborationId: id, exchangeId: id,
  senderBotId: id, senderDisplayName: z.string(),
  sourceBotId: id, sourceConversationId: id, sourceRequestId: id,
  sourceUserMessageId: id, sourceAssistantMessageId: id,
};
export const botPeerOriginSchema = z.discriminatedUnion("kind", [
  z.object({ ...source, kind: z.literal("request"), configuration: z.object({
    organizationIntentId: id, expectedRevision: z.number().int().nonnegative(),
  }).strict().optional() }).strict(),
  z.object({ ...source, kind: z.literal("return"), replyMessageId: id }).strict(),
]);
export type BotPeerOrigin = z.infer<typeof botPeerOriginSchema>;
