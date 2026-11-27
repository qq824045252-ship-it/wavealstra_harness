import type { WorkDto } from "../../shared/bot-work";
import type { ConversationGoalContinuationDto, ConversationGoalDto, ConversationGoalSourceDto, GoalCriterionStatus } from "../../shared/conversation-goal";
import type { ConversationGoalMutationResult, ConversationRuntimeSnapshotDto } from "../../shared/conversation-runtime";
import { mapConversationInteraction, type RuntimeConversationInteractionRow } from "./ConversationInteractionRepository";

type GoalWork = Pick<WorkDto, "workId" | "title" | "goalDescription" | "lifecycle" | "closureConclusion" | "closureSummary"
  | "progressSummary" | "criteria" | "stateVersion" | "createdBy" | "createdAt" | "updatedAt" | "closedAt" | "sourceMessageId">;

export interface WorkTaskAccess {
  taskExists: boolean;
  hasWorkBinding: boolean;
}

interface RuntimeGoalRow {
  work_id: string;
  title: string;
  goal_description: string | null;
  criteria_json: string;
  lifecycle: WorkDto["lifecycle"];
  closure_conclusion: NonNullable<WorkDto["closureConclusion"]> | null;
  closure_summary: string | null;
  progress_summary: string | null;
  state_version: number;
  intent_revision: number;
  owner_epoch: number;
  created_by: WorkDto["createdBy"];
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  source_message_id: string | null;
  source_json: string | null;
  linked: boolean;
  live: boolean;
  blocker: string | null;
  continuation_task_id: string | null;
  continuation_state: ConversationGoalContinuationDto["state"] | null;
  continuation_attempt_serial: number | null;
  continuation_updated_at: number | null;
  continuation_intent_revision: number | null;
  attempts: number | null;
  tokens_used: number | null;
  tokens_budget: number | null;
  progress_stalls: number | null;
  defer_reason: NonNullable<ConversationGoalContinuationDto["deferReason"]> | null;
  deferred_at: number | null;
  last_continuation_at: number | null;
  check_trigger: NonNullable<ConversationGoalContinuationDto["lastCheck"]>["trigger"] | null;
  check_reason: string | null;
  check_at: number | null;
  wake_trigger: NonNullable<ConversationGoalContinuationDto["lastWake"]>["trigger"] | null;
  wake_at: number | null;
}

export interface RuntimeConversationSnapshot {
  goals: RuntimeGoalRow[];
  interactions: RuntimeConversationInteractionRow[];
}

export interface GoalUserInputWitness {
  taskId: string;
  workId: string;
  intentRevision: number;
  stateVersion: number;
  ownerEpoch: number;
  attemptSerial: number;
  deferredAt: number;
  continuationUpdatedAt: number;
  deferReason: NonNullable<ConversationGoalContinuationDto["deferReason"]>;
}

export interface RuntimeConversationGoalDraft {
  userId: string;
  taskId: string;
  defaultBotId: string;
  title: string;
  description?: string;
  criteria: string[];
  source?: ConversationGoalSourceDto;
  createdBy?: "bot";
  originMessageId?: string;
}

export type RuntimeConversationGoalCreateReply =
  | { ok: true; replayed: boolean; goal: RuntimeGoalRow }
  | Extract<ConversationGoalMutationResult, { ok: false }>;

export const GOAL_CONTINUATION_STALL_LIMIT = 2;

export function normalizeGoalContinuationAttempts(configured: number): number {
  return Number.isFinite(configured) ? Math.min(10, Math.max(1, Math.round(configured))) : 3;
}

function criterionStatus(status: WorkDto["criteria"][number]["status"]): GoalCriterionStatus {
  if (status === "satisfied") return "met";
  if (status === "waived") return "waived";
  if (status === "failed" || status === "blocked") return "not_met";
  return "pending";
}

function goalStatus(work: GoalWork, blocker: string | undefined): ConversationGoalDto["status"] {
  if (blocker !== undefined) return "blocked";
  if (work.lifecycle === "closed") return work.closureConclusion === "succeeded" ? "achieved" : "cancelled";
  return work.lifecycle === "paused" ? "paused" : "active";
}

export function projectConversationGoal(work: GoalWork, taskId: string, source?: ConversationGoalSourceDto,
  blocker?: string, continuation?: ConversationGoalContinuationDto): ConversationGoalDto {
  const closing = work.lifecycle === "closing" ? "正在结算在途操作" : undefined;
  const achieved = work.lifecycle === "closed" && work.closureConclusion === "succeeded";
  return {
    id: work.workId, taskId, title: work.title, description: work.goalDescription, status: goalStatus(work, blocker),
    criteria: work.criteria.map(criterion => ({
      id: criterion.id, text: criterion.text, status: criterionStatus(criterion.status),
      evidence: criterion.evidenceRefs.length
        ? `${criterion.evidenceRefs.length} 项证据${criterion.waivedReason ? `；豁免：${criterion.waivedReason}` : ""}`
        : criterion.waivedReason,
    })),
    progressSummary: (work.lifecycle === "closed" ? work.closureSummary : undefined) ?? work.progressSummary ?? closing,
    version: work.stateVersion, createdBy: work.createdBy === "user" ? "user" : "agent_explicit_request",
    createdAt: work.createdAt, updatedAt: work.updatedAt, closedAt: work.closedAt,
    sourceMessageId: work.sourceMessageId, source, waitingReason: blocker ?? closing, closureConclusion: work.closureConclusion,
    achievedAt: achieved ? work.closedAt : undefined, ...(continuation ? { continuation } : {}),
  };
}

type ContinuationSettings = { maxAttempts: number; tokenBudget: number | null; enabled: boolean };

export function projectCoreConversationGoal(taskId: string, row: RuntimeGoalRow, settings: ContinuationSettings): ConversationGoalDto {
  const continuation: ConversationGoalContinuationDto = {
    state: row.continuation_state ?? "idle", attempts: row.attempts ?? 0, tokensUsed: row.tokens_used ?? 0,
    maxAttempts: settings.maxAttempts, tokenBudget: row.tokens_budget ?? settings.tokenBudget, enabled: settings.enabled,
  };
  if (row.continuation_task_id !== null) {
    continuation.taskId = row.continuation_task_id;
    continuation.progressStalls = row.progress_stalls ?? 0;
    continuation.stallLimit = GOAL_CONTINUATION_STALL_LIMIT;
    continuation.deferReason = row.defer_reason ?? undefined;
    continuation.lastStoppedAt = row.deferred_at ?? undefined;
    continuation.lastContinuationAt = row.last_continuation_at ?? undefined;
    if (row.check_trigger && row.check_at !== null && row.check_reason !== null) {
      continuation.lastCheck = { trigger: row.check_trigger, at: row.check_at, reason: row.check_reason };
    }
    if (row.wake_trigger && row.wake_at !== null) continuation.lastWake = { trigger: row.wake_trigger, at: row.wake_at };
  }
  return projectConversationGoal({
    workId: row.work_id, title: row.title, goalDescription: row.goal_description ?? undefined,
    criteria: JSON.parse(row.criteria_json), lifecycle: row.lifecycle,
    closureConclusion: row.closure_conclusion ?? undefined, closureSummary: row.closure_summary ?? undefined,
    progressSummary: row.progress_summary ?? undefined, stateVersion: row.state_version, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
  }, taskId, row.source_json ? JSON.parse(row.source_json) : undefined, row.blocker ?? undefined, continuation);
}

export function projectConversationRuntime(taskId: string, snapshot: RuntimeConversationSnapshot,
  settings: ContinuationSettings): ConversationRuntimeSnapshotDto {
  const live = snapshot.goals.filter(row => row.live);
  if (live.length > 1) throw new Error("当前对话涉及多个 Work，请明确事项引用");
  const project = (row: RuntimeGoalRow) => projectCoreConversationGoal(taskId, row, settings);
  return { taskId, interactions: snapshot.interactions.map(mapConversationInteraction),
    activeGoal: live.length ? project(live[0]) : undefined, goals: snapshot.goals.filter(row => row.linked).map(project) };
}
