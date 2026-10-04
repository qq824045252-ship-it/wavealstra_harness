export const CONVERSATION_GOAL_MAX_CRITERIA = 12;

export type ConversationGoalStatus = "active" | "paused" | "blocked" | "achieved" | "cancelled";
export type GoalCriterionStatus = "pending" | "met" | "not_met" | "waived";

export interface GoalCriterionDto {
  id: string;
  text: string;
  status: GoalCriterionStatus;
  evidence?: string;
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
}
