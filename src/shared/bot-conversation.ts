import { z } from "zod";
import type { WorkProjectionDto } from "./bot-work";

const id = z.string().trim().min(1).max(200);
export const botAttachmentSchema = z.object({ name: z.string().trim().min(1).max(255), path: z.string().min(1).max(8192) }).strict();
export type BotAttachmentDto = z.infer<typeof botAttachmentSchema>;
export const botSendSchema = z.object({
  botId: id, requestId: id, text: z.string().trim().max(32000), attachments: z.array(botAttachmentSchema).max(10).optional(),
  conversationId: id.optional(), selectedWorkId: id.optional(), referenceMessageId: id.optional(),
}).strict().refine(input => input.text.length > 0 || (input.attachments?.length ?? 0) > 0, "请输入消息或添加附件");
export type BotSendRequest = z.infer<typeof botSendSchema>;
export const botHistorySchema = z.object({ botId: id, conversationId: id.optional(), before: z.number().int().positive().optional() }).strict();
export type BotHistoryRequest = z.infer<typeof botHistorySchema>;
/** Host-authored durable Work feedback, never inferred from message wording. */
export const workFeedbackSchema = z.object({
  workId: id, eventId: z.string().min(1).max(500), kind: z.enum(["binding", "result", "blocker", "closure"]),
  category: z.enum(["progress", "decision", "result"]), executionId: id.optional(),
  intentRevision: z.number().int().positive().optional(), inputSnapshotId: z.string().min(1).max(2000).optional(),
  /** Immutable host projection of this exact result version; text retains the full original record. */
  report: z.object({
    title: z.string(), summary: z.string(), artifactRefs: z.array(z.string()),
    files: z.array(z.object({ ref: z.string(), name: z.string(), openPath: z.string().optional() }).strict()).optional(),
    reviewStatus: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    current: z.boolean(), notices: z.array(z.string()),
  }).strict().optional(),
}).strict();
export type WorkFeedbackDto = z.infer<typeof workFeedbackSchema>;
/** One host-observed activity, separate from the model's answer. Never tool input/output. */
export const botActivitySchema = z.object({
  tool: z.string().min(1).max(200), status: z.enum(["running", "success", "error"]),
}).strict();
export type BotActivityDto = z.infer<typeof botActivitySchema>;
export const botMessageSchema = z.object({
  messageId: id, conversationId: id, botId: id, requestId: id, ordinal: z.number().int().positive(),
  role: z.enum(["user", "assistant"]), text: z.string(), attachments: z.array(botAttachmentSchema).optional(),
  status: z.enum(["queued", "running", "completed", "cancelled", "unknown", "failed"]),
  workIds: z.array(id), workFeedback: workFeedbackSchema.optional(), activity: botActivitySchema.optional(), error: z.string().optional(), createdAt: z.number(), updatedAt: z.number(),
});
/** Host-resolved, message-only image scope. No active-task or owner fallback. */
export interface BotReportImages {
  taskId: string;
  artifacts: import("./artifact-types").ArtifactDescriptor[];
  sources: Record<string, string>;
}
export type BotMessageDto = z.infer<typeof botMessageSchema> & { reportImages?: BotReportImages };
export interface BotHistoryDto { conversationId: string; botId: string; revision: number; archived: boolean; messages: BotMessageDto[]; before?: number }
export interface BotMessageEvent { botId: string; conversationId: string; revision: number; message: BotMessageDto }

export interface BotSendReceipt { conversationId: string; botId: string; requestId: string; userMessageId: string; assistantMessageId: string; replayed: boolean }

export interface WorkListCursor { epoch: string; sequence: number; scope: "open" | "all" }
export type WorkListEvent = { sequence: number } & (
  | { kind: "upsert"; projection: WorkProjectionDto }
  | { kind: "remove"; workId: string; reason: "closed" | "removed"; stateVersion: number }
);
export type WorkListUpdate =
  | { kind: "snapshot"; cursor: WorkListCursor; works: WorkProjectionDto[] }
  | { kind: "delta"; cursor: WorkListCursor; from: number; events: WorkListEvent[]; hasMore: boolean }
  | { kind: "resync_required" };
export const workListRequestSchema = z.object({ includeClosed: z.boolean(), cursor: z.object({
  epoch: id, sequence: z.number().int().nonnegative(), scope: z.enum(["open", "all"]),
}).strict().optional() }).strict();
export type WorkListRequest = z.infer<typeof workListRequestSchema>;
