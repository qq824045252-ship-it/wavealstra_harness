import type { ConversationGoalCreateRequest, ConversationGoalDto, ConversationGoalUpdateRequest } from "./conversation-goal";
import type {
  ConversationInteractionDto,
  ConversationInteractionMutationResult,
  ConversationInteractionRespondRequest,
} from "./conversation-interaction";

export const ConversationRuntimeIpc = {
  snapshot: "conversation-runtime:snapshot",
  respondInteraction: "conversation-runtime:respond-interaction",
  cancelInteraction: "conversation-runtime:cancel-interaction",
  createGoal: "conversation-runtime:create-goal",
  updateGoal: "conversation-runtime:update-goal",
  cancelGoal: "conversation-runtime:cancel-goal",
} as const;

export interface ConversationRuntimeSnapshotDto {
  taskId: string;
  interactions: ConversationInteractionDto[];
  activeGoal?: ConversationGoalDto;
}

export interface ConversationInteractionCancelRequest {
  interactionId: string;
}

export type ConversationGoalMutationResult =
  | { ok: true; goal: ConversationGoalDto }
  | { ok: false; code: "not_found" | "conflict" | "invalid_request"; message: string };

export interface ConversationRuntimeApi {
  snapshot(taskId: string): Promise<ConversationRuntimeSnapshotDto>;
  respondInteraction(request: ConversationInteractionRespondRequest): Promise<ConversationInteractionMutationResult>;
  cancelInteraction(request: ConversationInteractionCancelRequest): Promise<ConversationInteractionMutationResult>;
  createGoal(request: ConversationGoalCreateRequest): Promise<ConversationGoalMutationResult>;
  updateGoal(request: ConversationGoalUpdateRequest): Promise<ConversationGoalMutationResult>;
  cancelGoal(goalId: string): Promise<ConversationGoalMutationResult>;
}
