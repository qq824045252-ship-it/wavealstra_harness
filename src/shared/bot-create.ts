import { z } from "zod";
import type { BotDto } from "./bot-work";

export const BOT_DISPLAY_NAME_MAX_LENGTH = 80;
export const BOT_RESPONSIBILITY_MAX_LENGTH = 2000;

/** Identity, permissions and tools are always assigned by the host, never the renderer. */
export const botCreateSchema = z.object({
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  displayName: z.string().max(BOT_DISPLAY_NAME_MAX_LENGTH * 2).trim().min(1)
    .max(BOT_DISPLAY_NAME_MAX_LENGTH).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  responsibilitySummary: z.string().max(BOT_RESPONSIBILITY_MAX_LENGTH * 2).trim()
    .max(BOT_RESPONSIBILITY_MAX_LENGTH).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    .optional().default(""),
}).strict();
export const botCreateRequestSchema = botCreateSchema;

export type BotCreateRequest = z.input<typeof botCreateSchema>;
export type BotCreateErrorCode = "invalid_request" | "duplicate_name" | "request_conflict"
  | "forbidden" | "not_authority" | "storage_error";
export type BotCreateResult =
  | { ok: true; bot: BotDto; replayed: boolean }
  | { ok: false; code: BotCreateErrorCode; message: string };
