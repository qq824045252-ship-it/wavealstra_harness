export const CONVERSATION_GOAL_MAX_CRITERIA = 12;

export type ConversationGoalStatus = "active" | "paused" | "blocked" | "achieved" | "cancelled";
export type GoalCriterionStatus = "pending" | "met" | "not_met" | "waived";

export interface GoalCriterionDto {
  id: string;
  text: string;
  status: GoalCriterionStatus;
  evidence?: string;
}

export type GoalContinuationState = "idle" | "igniting" | "deferred" | "exhausted";
export type GoalContinuationDeferReason =
  | "user_interrupt"
  | "turn_aborted"
  | "run_failed"
  | "restart"
  | "no_progress"
  | "manual_stop"
  | "attempts"
  | "budget";

/**
 * Host identity of a Goal continuation input. It is metadata on the persisted
 * user row, not a second message kind: the projection still reads one user entry
 * per input and the renderer can collapse it into a narrow "auto-continuation" bar.
 */
export type GoalContinuationOrigin = {
  workId: string;
  intentRevision: number;
  attempt: number;
};

/** Ledger projection shown on the Goal chip. The Work remains the completion authority. */
export interface ConversationGoalContinuationDto {
  state: GoalContinuationState;
  attempts: number;
  maxAttempts: number;
  tokensUsed: number;
  tokenBudget?: number | null;
  deferReason?: GoalContinuationDeferReason;
  lastContinuationAt?: number;
}

export interface ConversationGoalDto {
  id: string;
  taskId: string;
  title: string;
  description?: string;
  status: ConversationGoalStatus;
  criteria: GoalCriterionDto[];
  progressSummary?: string;
  version: number;
  createdBy: "user" | "agent_explicit_request";
  createdAt: number;
  updatedAt: number;
  achievedAt?: number;
  /** Host-side auto-continuation ledger. Absent only for hosts that predate it. */
  continuation?: ConversationGoalContinuationDto;
}

export interface ConversationGoalCreateRequest {
  taskId: string;
  title: string;
  description?: string;
  criteria?: Array<{ id?: string; text: string }>;
  createdBy?: ConversationGoalDto["createdBy"];
}

export interface ConversationGoalUpdateRequest {
  goalId: string;
  title?: string;
  description?: string;
  progressSummary?: string;
  status?: ConversationGoalStatus;
  criteria?: Array<{ id?: string; text: string; status?: GoalCriterionStatus; evidence?: string }>;
  criterionUpdates?: Array<{ id: string; status?: GoalCriterionStatus; evidence?: string; text?: string }>;
  /** Per-goal auto-continuation budget. null = follow the global default, undefined = unchanged. */
  tokenBudget?: number | null;
}
