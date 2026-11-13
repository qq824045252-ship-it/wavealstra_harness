import { z } from "zod";

const id = z.string().min(1).max(500);
export const botPeerReviewSchema = z.object({
  returnExchangeId: id, replyMessageId: id, requestExcerpt: z.string().min(1).max(4000),
  evidenceQuote: z.string().min(1).max(4000), gap: z.string().min(1).max(8000),
  work: z.object({ workId: id, intentRevision: z.number().int().positive(), inputSnapshotId: z.string(), ownerEpoch: z.number().int().nonnegative() }).strict().optional(),
}).strict();
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
  }).strict().optional(), review: botPeerReviewSchema.optional() }).strict(),
  z.object({ ...source, kind: z.literal("return"), replyMessageId: id }).strict(),
]);
export type BotPeerOrigin = z.infer<typeof botPeerOriginSchema>;
