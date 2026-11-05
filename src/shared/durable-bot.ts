import type { ChatMessageDto, ContextUsageDto } from "./agent-ipc";
import type { DurableStreamDelta } from "../../shared/src/durable-sync";

export type BotToolMode = "native" | "codemode";
export interface DurableBotSnapshot {
  backend: "pi-durable";
  epoch: string;
  revision: number;
  conversationId: string;
  toolMode: BotToolMode;
  busy: boolean;
  status?: "idle" | "running" | "queued" | "retrying" | "waiting_input" | "stopped" | "failed" | "completed";
  /** Last entry preceding the loaded history window; omitted at the beginning. */
  historyBefore?: number;
  queued: number;
  pendingInputs: Array<{ id: string; mode: "steer" | "followUp"; text: string }>;
  retry?: { at: number; error: string };
  compacting: boolean;
  messages: ChatMessageDto[];
  error?: string;
  outcome?: "completed" | "failed" | "aborted";
  contextUsage?: Omit<ContextUsageDto, "taskId">;
}

export type DurableBotState = Omit<DurableBotSnapshot, "messages" | "epoch" | "revision">;
export type DurableBotDelta = DurableStreamDelta<ChatMessageDto, DurableBotState>;
