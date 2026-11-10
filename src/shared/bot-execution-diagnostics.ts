import { z } from "zod";
import type { TaskDiagnosticsDto } from "./task-diagnostics";
export const botExecutionDiagnosticsRequestSchema = z.union([
  z.object({ kind: z.literal("foreground"), botId: z.string().min(1), teamId: z.string().optional(), conversationId: z.string().optional() }),
  z.object({ kind: z.literal("work"), workId: z.string().min(1) }),
]);
export type BotExecutionDiagnosticsRequest = z.infer<typeof botExecutionDiagnosticsRequestSchema>;
export interface BotExecutionDiagnosticsDto {
  groups: Array<{ id: string; label: string; value: TaskDiagnosticsDto }>;
  conversations: Array<{ id: string; label: string }>;
  conversationId?: string;
  note: string;
}
