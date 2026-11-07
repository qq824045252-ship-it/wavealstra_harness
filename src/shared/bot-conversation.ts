import { z } from "zod";
import type { WorkProjectionDto } from "./bot-work";

const id = z.string().trim().min(1).max(200);
export const botSendSchema = z.object({
  botId: id, requestId: id, text: z.string().trim().min(1).max(32000),
  conversationId: id.optional(), selectedWorkId: id.optional(), referenceMessageId: id.optional(),
}).strict();
export type BotSendRequest = z.infer<typeof botSendSchema>;
export const botHistorySchema = z.object({ botId: id, conversationId: id.optional(), before: z.number().int().positive().optional() }).strict();
export type BotHistoryRequest = z.infer<typeof botHistorySchema>;
export const botMessageSchema = z.object({
  messageId: id, conversationId: id, botId: id, requestId: id, ordinal: z.number().int().positive(),
  role: z.enum(["user", "assistant"]), text: z.string(),
  status: z.enum(["queued", "running", "completed", "cancelled", "unknown", "failed"]),
  workIds: z.array(id), error: z.string().optional(), createdAt: z.number(), updatedAt: z.number(),
});
export type BotMessageDto = z.infer<typeof botMessageSchema>;
export interface BotHistoryDto { conversationId: string; botId: string; revision: number; archived: boolean; messages: BotMessageDto[]; before?: number }
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
