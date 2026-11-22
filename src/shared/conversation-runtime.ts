import type { ConversationGoalCreateRequest, ConversationGoalDto, ConversationGoalEvidenceDto, ConversationGoalUpdateRequest, GoalSavedArtifactDto } from "./conversation-goal";
import type {
  ConversationInteractionDto,
  ConversationInteractionMutationResult,
  ConversationInteractionRespondRequest,
} from "./conversation-interaction";

export const ConversationRuntimeIpc = {
  snapshot: "conversation-runtime:snapshot",
  goalEvidence: "conversation-runtime:goal-evidence",
  readGoalArtifactText: "conversation-runtime:read-goal-artifact-text",
  verifyGoalArtifact: "conversation-runtime:verify-goal-artifact",
  respondInteraction: "conversation-runtime:respond-interaction",
  cancelInteraction: "conversation-runtime:cancel-interaction",
  createGoal: "conversation-runtime:create-goal",
  updateGoal: "conversation-runtime:update-goal",
  cancelGoal: "conversation-runtime:cancel-goal",
  resumeGoalContinuation: "conversation-runtime:resume-goal-continuation",
} as const;

export interface ConversationRuntimeSnapshotDto {
  taskId: string;
  interactions: ConversationInteractionDto[];
  activeGoal?: ConversationGoalDto;
  goals?: ConversationGoalDto[];
}

export interface ConversationInteractionCancelRequest {
  interactionId: string;
}

export type ConversationGoalMutationResult =
  | { ok: true; goal: ConversationGoalDto }
  | { ok: false; code: "not_found" | "conflict" | "invalid_request"; message: string };

export interface ConversationRuntimeApi {
  snapshot(taskId: string): Promise<ConversationRuntimeSnapshotDto>;
  goalEvidence(taskId: string, goalId: string): Promise<ConversationGoalEvidenceDto | undefined>;
  readGoalArtifactText(taskId: string, goalId: string, artifactId: string): Promise<string | undefined>;
  verifyGoalArtifact(taskId: string, goalId: string, artifactId: string): Promise<GoalSavedArtifactDto | undefined>;
  respondInteraction(request: ConversationInteractionRespondRequest): Promise<ConversationInteractionMutationResult>;
  cancelInteraction(request: ConversationInteractionCancelRequest): Promise<ConversationInteractionMutationResult>;
  createGoal(request: ConversationGoalCreateRequest): Promise<ConversationGoalMutationResult>;
  updateGoal(request: ConversationGoalUpdateRequest): Promise<ConversationGoalMutationResult>;
  cancelGoal(goalId: string, taskId?: string): Promise<ConversationGoalMutationResult>;
  /** Clear the host deferral, reset the attempt/budget window, and try to continue now. */
  resumeGoalContinuation(goalId: string, taskId?: string): Promise<ConversationGoalMutationResult>;
}
