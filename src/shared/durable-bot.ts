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

/**
 * 一次「更早历史」读取的独立块。
 *
 * 与 DurableBotSnapshot 刻意分开：块不携带 revision / busy / queued 等实时窗口状态，
 * 读取块也不推进任何游标，因此客户端拿到块只能做一件事——追加到可见列表前端。
 *
 * 不变量：
 * 1. messages 尽量非空：不产生可见行的 entry（toolResult / context-import / skill-read）会被跳过，
 *    服务端因此多向前预取几页；若已经扫到最老仍无可见行，空块仍然合法，客户端必须容忍；
 * 2. before 是下一页的 maxEntryId（端点在下一页会再读到一次，所以相邻块重叠至多一条 entry，
 *    客户端按消息 id 去重）；before 严格小于本块最老 entry，反复前插必然收敛；undefined = 已到最老；
 */
export interface DurableHistoryBlock {
  epoch: string;
  before?: number;
  messages: ChatMessageDto[];
}

export type DurableBotState = Omit<DurableBotSnapshot, "messages" | "epoch" | "revision">;
export type DurableBotDelta = DurableStreamDelta<ChatMessageDto, DurableBotState>;
