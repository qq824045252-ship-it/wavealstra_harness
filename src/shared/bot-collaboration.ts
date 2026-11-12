import { z } from "zod";
import { workFeedbackSchema } from "./bot-work-feedback";
import type { BotSendReceipt, BotMessageDto } from "./bot-conversation";

const id = z.string().trim().min(1).max(500);
const time = z.number().int().nonnegative();
export const botCollaborationStatusSchema = z.enum([
  "sent", "delivered", "accepted", "started", "ended", "returning", "returned", "failed", "cancelled", "unknown",
]);
export const botCollaborationTimesSchema = z.object({
  sentAt: time.nullable(), deliveredAt: time.nullable(), acceptedAt: time.nullable(),
  startedAt: time.nullable(), endedAt: time.nullable(), returningAt: time.nullable(), returnedAt: time.nullable(),
}).strict();
export const botCollaborationWorkSchema = z.object({
  workId: id, title: z.string(), lifecycle: z.enum(["active", "paused", "closing", "closed"]),
  executionStatus: z.enum(["pending", "submitted", "running", "completed", "failed", "stopped", "unknown", "invalidated"]).optional(),
  closureConclusion: z.enum(["succeeded", "cancelled", "ended_unsuccessfully"]).optional(),
  progressSummary: z.string().optional(), startedAt: time.nullable(), endedAt: time.nullable(), closedAt: time.nullable().optional(),
}).strict();
export const botCollaborationSchema = z.object({
  collaborationId: id, userId: id, sourceBotId: id, sourceDisplayName: z.string(),
  sourceConversationId: id, sourceRequestId: id, sourceUserMessageId: id, sourceAssistantMessageId: id,
  targetBotId: id, targetDisplayName: z.string(), workId: id.nullable(),
  createdAt: time, updatedAt: time, messageCount: z.number().int().nonnegative(),
  status: botCollaborationStatusSchema, times: botCollaborationTimesSchema,
  originAvailable: z.boolean(),
  /** Bounded excerpts from persisted exchanges, never streaming previews. */
  requestPreview: z.string().max(500).optional(), replyPreview: z.string().max(500).optional(),
  work: botCollaborationWorkSchema.optional(),
}).strict();
export type BotCollaborationDto = z.infer<typeof botCollaborationSchema>;
export type BotCollaborationStatus = z.infer<typeof botCollaborationStatusSchema>;
export type BotCollaborationTimes = z.infer<typeof botCollaborationTimesSchema>;

export const botCollaborationMessageSchema = z.object({
  messageId: id, collaborationId: id, ordinal: z.number().int().positive(),
  senderBotId: id, senderDisplayName: z.string(),
  kind: z.enum(["request", "reply", "progress", "result"]), text: z.string(), createdAt: time,
  operationId: id, exchangeId: id.optional(),
  workFeedback: workFeedbackSchema.optional(),
}).strict();
export type BotCollaborationMessageDto = z.infer<typeof botCollaborationMessageSchema>;
export const botCollaborationEventSchema = z.object({
  eventId: id, collaborationId: id, ordinal: z.number().int().positive(), kind: botCollaborationStatusSchema, createdAt: time,
  operationId: id, exchangeId: id.optional(), workId: id.optional(), detail: z.string().optional(),
}).strict();
export type BotCollaborationEventDto = z.infer<typeof botCollaborationEventSchema>;
export const botCollaborationPreviewSchema = z.object({
  collaborationId: id, exchangeId: id, senderBotId: id, senderDisplayName: z.string(),
  text: z.string(), updatedAt: time,
}).strict();
export type BotCollaborationPreviewDto = z.infer<typeof botCollaborationPreviewSchema>;

export const botCollaborationsQuerySchema = z.object({
  botId: id, conversationId: id.optional(), otherBotId: id.optional(), cursor: z.string().max(4000).optional(),
  direction: z.enum(["all", "incoming", "outgoing"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type BotCollaborationsQuery = z.infer<typeof botCollaborationsQuerySchema>;
export interface BotCollaborationsPage { items: BotCollaborationDto[]; total: number; nextCursor: string | null }
export const botCollaborationHistoryQuerySchema = z.object({
  botId: id, collaborationId: id, cursor: z.string().max(4000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type BotCollaborationHistoryQuery = z.infer<typeof botCollaborationHistoryQuerySchema>;
export interface BotCollaborationHistoryPage {
  collaboration: BotCollaborationDto;
  /** Messages/events share a journal position. Each page is chronological;
   * cursor loads the preceding page of logical messages and receipt events. */
  messages: BotCollaborationMessageDto[];
  events: BotCollaborationEventDto[];
  previews: BotCollaborationPreviewDto[];
  totalMessages: number;
  nextCursor: string | null;
  receivers?: BotCollaborationReceiver[];
}
export type BotCollaborationReceiver = Omit<BotSendReceipt, "teamId" | "replayed"> & {
  exchangeId: string; status: BotMessageDto["status"]; acceptedAt: number; startedAt: number | null; endedAt: number | null;
};
