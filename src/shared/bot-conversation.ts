import { z } from "zod";
import { requestConsultForMessage } from "./multi-model-consult";
import type { WorkProjectionDto } from "./bot-work";

/** Remove only product-authored context wrappers for a Bot bubble or editable retry. */
export function botMessageDisplayText(text: string): string {
  const prefix = requestConsultForMessage("");
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return body.replace(/<!-- mybuddy:reference-context -->[\s\S]*?<!-- \/mybuddy:reference-context -->/g, "").trim();
}

/** Host-generated Bot-chat identity namespace, distinct from native Task input IDs. */
export const botExternalAgentTaskId = (assistantMessageId: string): string => `bot-acp-${assistantMessageId}`;

export const BOT_MESSAGE_ID_PREFIX = "bot-message-";
export const isBotConversationMessageId = (value: string): boolean => value.startsWith(BOT_MESSAGE_ID_PREFIX);

const id = z.string().trim().min(1).max(200);
export const botAttachmentSchema = z.object({ name: z.string().trim().min(1).max(255), path: z.string().min(1).max(8192) }).strict();
export type BotAttachmentDto = z.infer<typeof botAttachmentSchema>;
export const botReferenceFileSchema = z.object({
  id, name: z.string().min(1).max(255), path: z.string().max(8192).optional(),
  content: z.string().max(128000).optional(), source: z.enum(["artifact", "attachment", "change"]),
}).strict();
export const botReferenceTaskSchema = z.object({
  id, title: z.string().max(2000), spaceName: z.string().max(2000).optional(), cwd: z.string().max(8192).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(128000) }).strict()).max(100).optional(),
  files: z.array(botReferenceFileSchema).max(100).optional(),
}).strict();
export const botComposerSelectionSchema = z.object({
  consultRequested: z.boolean().optional(), externalAgentId: id.optional(),
  refTasks: z.array(botReferenceTaskSchema).max(20).optional(), refFiles: z.array(botReferenceFileSchema).max(100).optional(),
  reasoningPreference: z.object({enabled:z.boolean().optional(),effort:z.string().max(40).optional(),budgetTokens:z.number().int().nonnegative().optional()}).strict().optional(),
  modelId: z.string().trim().max(500), expertId: z.string().trim().max(240),
  skillIds: z.array(id).max(100), mcpIds: z.array(id).max(100), connectorIds: z.array(id).max(100),
}).strict();
export type BotComposerSelection = z.infer<typeof botComposerSelectionSchema>;
export const botSendSchema = z.object({
  botId: id, teamId: id.optional(), requestId: id, text: z.string().trim().max(32000), attachments: z.array(botAttachmentSchema).max(10).optional(),
  selection: botComposerSelectionSchema.optional(),
  conversationId: id.optional(), selectedWorkId: id.optional(), referenceMessageId: id.optional(),
}).strict().refine(input => input.text.length > 0 || (input.attachments?.length ?? 0) > 0, "请输入消息或添加附件");
export type BotSendRequest = z.infer<typeof botSendSchema>;
export const botHistorySchema = z.object({ inbox: z.boolean().optional(), botId: id, teamId: id.optional(), conversationId: id.optional(), before: z.number().int().positive().optional(), after: z.number().int().nonnegative().optional(), messageIds: z.array(id).min(1).max(100).optional() }).strict();
export type BotHistoryRequest = z.infer<typeof botHistorySchema>;
/** Host-authored durable Work feedback, never inferred from message wording. */
export const workFeedbackSchema = z.object({
  workId: id, eventId: z.string().min(1).max(500), kind: z.enum(["binding", "result", "blocker", "closure"]),
  category: z.enum(["progress", "decision", "result"]), executionId: id.optional(),
  intentRevision: z.number().int().positive().optional(), inputSnapshotId: z.string().min(1).max(2000).optional(),
  /** Immutable host projection of this exact result version; text retains the full original record. */
  report: z.object({
    title: z.string(), summary: z.string(), artifactRefs: z.array(z.string()),
    /** Display-only verified partial progress, never a goal-completion review. */
    milestone: z.literal(true).optional(),
    /** This is the foreground goal review, not the worker's execution status. */
    completion: z.object({ outcome: z.enum(["completed", "partial", "unknown"]), nextStep: z.enum(["deliver", "continue", "ask"]) }).strict().optional(),
    primaryArtifactRefs: z.array(z.string()).optional(),
    sourceNotices: z.array(z.string()).optional(),
    files: z.array(z.object({ ref: z.string(), name: z.string(), openPath: z.string().optional(), previewManifestPath: z.string().optional() }).strict()).optional(),
    reviewStatus: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    current: z.boolean(), notices: z.array(z.string()),
    teamFacts: z.array(z.object({ displayName: z.string(), responsibility: z.string(), executionStatus: z.string(),
      failureReason: z.string().optional(), failureSummary: z.string().optional(), sourceRefs: z.array(z.string()) }).strict()).optional(),
    structured: z.object({ version: z.literal(1), conclusions: z.array(z.object({ text: z.string(), requestMessageId: z.string(),
      requestText: z.string(), sources: z.array(z.object({ ref: z.string(), label: z.string() }).strict()) }).strict()),
      observations: z.array(z.string()) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type WorkFeedbackDto = z.infer<typeof workFeedbackSchema>;
/** One host-observed activity, separate from the model's answer. Never tool input/output. */
export const botActivitySchema = z.object({
  tool: z.string().min(1).max(200), status: z.enum(["running", "success", "error"]),
}).strict();
export type BotActivityDto = z.infer<typeof botActivitySchema>;
/** Receipt is host-authored acknowledgment only; other segments contain public model text. */
export const botReplySegmentSchema = z.object({
  id: id, kind: z.enum(["receipt", "commentary", "answer"]), text: z.string(),
  createdAt: z.number(), updatedAt: z.number(),
}).strict();
export type BotReplySegment = z.infer<typeof botReplySegmentSchema>;
export interface BotForegroundMetrics {
  totalInputTokens?: number | null; evidenceVersion?: 1;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  reportedCalls: number; contextTokens: number | null; contextWindow: number | null; contextEstimated: boolean;
  generation?: import("./generation-stats").GenerationStats; modelName?: string; durationMs?: number;
}
/** A real recipient-model exchange, projected by the host rather than parsed from @ text. */
export const botCallSchema = z.object({
  callId: id, sourceBotId: id, sourceDisplayName: z.string(), targetBotId: id, targetDisplayName: z.string(),
  requestText: z.string(), replyText: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "unknown"]),
  error: z.string().optional(), createdAt: z.number(), updatedAt: z.number(),
}).strict();
export type BotCallDto = z.infer<typeof botCallSchema>;
export const botMessageSchema = z.object({
  messageId: id, conversationId: id, botId: id, teamId: id.optional(), requestId: id, ordinal: z.number().int().positive(),
  messageRevision: z.number().int().nonnegative().optional(),
  metrics: z.custom<BotForegroundMetrics>().optional(),
  segments: z.array(botReplySegmentSchema).optional(),
  botCalls: z.array(botCallSchema).optional(),
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
export interface BotHistoryDto { conversationId: string; botId: string; teamId?: string; revision: number; archived: boolean; messages: BotMessageDto[]; before?: number }
export interface BotMessageEvent { botId: string; teamId?: string; conversationId: string; revision: number; message: BotMessageDto }

export interface BotSendReceipt { conversationId: string; botId: string; teamId?: string; requestId: string; userMessageId: string; assistantMessageId: string; replayed: boolean }

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

/** Unfinished foreground requests, including archived conversations; read-only. */
export interface BotActiveRequestDto { message: BotMessageDto; prompt?: BotMessageDto; archived: boolean }
