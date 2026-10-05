import type { ChatMessageDto, ContextUsageDto } from "./agent-ipc";

export type BotToolMode = "native" | "codemode";
export interface DurableBotSnapshot {
  backend: "pi-durable";
  epoch: string;
  revision: number;
  conversationId: string;
  toolMode: BotToolMode;
  busy: boolean;
  queued: number;
  pendingInputs: Array<{ id: string; mode: "steer" | "followUp"; text: string }>;
  retry?: { at: number; error: string };
  compacting: boolean;
  messages: ChatMessageDto[];
  error?: string;
  outcome?: "completed" | "failed" | "aborted";
  contextUsage?: Omit<ContextUsageDto, "taskId">;
}
