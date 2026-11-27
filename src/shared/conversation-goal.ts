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
  ownerEpoch?: number;
  attempt: number;
  taskId?: string;
  attemptSerial?: number;
  claimOperationId?: string;
  hostGeneration?: string;
  storeId?: string;
};

/** Ledger projection shown on the Goal chip. The Work remains the completion authority. */
export interface ConversationGoalContinuationDto {
  state: GoalContinuationState;
  attempts: number;
  maxAttempts: number;
  tokensUsed: number;
  tokenBudget?: number | null;
  /** Stored per-Goal override. Null follows the global policy. */
  tokenBudgetOverride?: number | null;
  /** Monotonic Core ledger revision independent of the Work version. */
  revision?: number;
  deferReason?: GoalContinuationDeferReason;
  lastContinuationAt?: number;
  enabled?: boolean;
  taskId?: string;
  lastCheck?: { trigger: "settled" | "resumed" | "continued"; reason: string; at: number };
  lastWake?: { trigger: NonNullable<ConversationGoalContinuationDto["lastCheck"]>["trigger"]; at: number };
  lastStoppedAt?: number;
  progressStalls?: number;
  stallLimit?: number;
}

export interface ConversationGoalSourceDto {
  taskId: string;
  conversationId: string;
  messageId: string;
  entryId?: string;
  inputRequestId?: string;
  role: "user" | "assistant";
  text: string;
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
  intentRevision?: number;
  ownerEpoch?: number;
  createdBy: "user" | "agent_explicit_request";
  createdAt: number;
  updatedAt: number;
  achievedAt?: number;
  closedAt?: number;
  sourceMessageId?: string;
  source?: ConversationGoalSourceDto;
  waitingReason?: string;
  closureConclusion?: import("./bot-work").WorkClosureConclusion;
  /** Host-side auto-continuation ledger. Absent only for hosts that predate it. */
  continuation?: ConversationGoalContinuationDto;
}

export interface ConversationGoalEvidenceDto {
  ownerBotId: string;
  userId: string;
  intentRevision: number;
  inputSnapshotId?: string;
  executions: Array<Pick<import("./bot-work").WorkExecutionBindingDto, "bindingId" | "botId" | "taskId" | "conversationId" | "status" | "metrics">>;
  deliverables: Array<Pick<import("./bot-work").WorkDeliverableDto, "deliverableId" | "executionId" | "summary" | "status" | "artifactRefs">>;
  verification: Array<{ criterionId: string; evidence: import("./bot-work").WorkEvidenceDto[] }>;
  artifacts: Array<{ bindingId: string; path: string; sha256?: string }>;
  activity?: import("./conversation-goal-activity").GoalActivityDto;
  savedArtifacts?: GoalSavedArtifactDto[];
  schedules?: Array<Pick<import("./bot-work").WorkSubscriptionDto, "subscriptionId" | "source" | "nextWakeAt" | "lastCheckedAt" | "stoppedAt" | "stoppedReason">>;
}

export interface GoalSavedArtifactDto {
  id: string;
  path: string;
  digest: string;
  /** Per-path ordinal of the first registration of these immutable contents. */
  version: number;
  registeredAt: number;
  request: import("./saved-artifact").SavedArtifactRequest;
  verification?: { kind: "user"; verifiedAt: number };
}

export interface ConversationGoalCreateRequest {
  taskId: string;
  sourceMessage?: { messageId: string; entryId?: string; historyId?: string };
  title: string;
  description?: string;
  criteria?: Array<{ id?: string; text: string }>;
  createdBy?: ConversationGoalDto["createdBy"];
  tokenBudget?: number | null;
}

export interface ConversationGoalVersionWitness {
  expectedVersion: number;
  expectedIntentRevision?: number;
  expectedOwnerEpoch?: number;
  expectedContinuationRevision?: number;
}

export interface ConversationGoalUpdateRequest extends Partial<ConversationGoalVersionWitness> {
  goalId: string;
  taskId?: string;
  title?: string;
  description?: string;
  progressSummary?: string;
  status?: ConversationGoalStatus;
  criteria?: Array<{ id?: string; text: string; status?: GoalCriterionStatus; evidence?: string }>;
  criterionUpdates?: Array<{ id: string; status?: GoalCriterionStatus; evidence?: string; text?: string }>;
  /** Per-goal auto-continuation budget. null = follow the global default, undefined = unchanged. */
  tokenBudget?: number | null;
}
