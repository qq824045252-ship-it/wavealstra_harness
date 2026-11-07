import { randomUUID } from "node:crypto";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import {
  CONVERSATION_GOAL_MAX_CRITERIA,
  type ConversationGoalCreateRequest,
  type ConversationGoalDto,
  type ConversationGoalStatus,
  type ConversationGoalUpdateRequest,
  type GoalCriterionDto,
  type GoalCriterionStatus,
} from "../../shared/conversation-goal";
import type { ConversationGoalMutationResult } from "../../shared/conversation-runtime";
import type {
  ExpectedVersionGuard,
  WorkActor,
  WorkControlErrorCode,
  WorkControlResult,
  WorkDto,
  WorkProjectionDto,
} from "../../shared/bot-work";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../../shared/bot-work";
import { DESKTOP_USER_GRANTS, WorkService } from "./work/WorkService";

export interface GoalCallContext {
  actor?: WorkActor;
  versionGuard?: ExpectedVersionGuard;
}

export interface ConversationGoalServiceOptions {
  userId?: string;
  botId?: string;
  resolveBotId?: (taskId: string) => string;
}

/**
 * Projection adapter over the single Work authority.
 *
 * The conversation chip keeps its historical DTO shape, but every write goes through
 * WorkService (idempotency receipts, version guards, evidence-based acceptance). This
 * class never owns a second live record.
 */
export class ConversationGoalService {
  constructor(
    private readonly work: WorkService,
    private readonly emit: (patch: AgentUiPatch) => void,
    private readonly options: ConversationGoalServiceOptions = {},
  ) {}

  get workService(): WorkService {
    return this.work;
  }

  modelActor(taskId: string): WorkActor {
    const binding = this.work.repo.bindingForTask(taskId);
    if (binding) return { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
    return defaultBotActor(this.options.resolveBotId?.(taskId) ?? this.options.botId ?? DEFAULT_BOT_ID,
      this.options.userId ?? LOCAL_USER_ID);
  }

  create(request: ConversationGoalCreateRequest, context: GoalCallContext = {}): ConversationGoalMutationResult {
    if (!request.taskId?.trim() || !request.title?.trim()) {
      return { ok: false, code: "invalid_request", message: "Task 与目标标题不能为空" };
    }
    if (this.work.listWorksByConversation(request.taskId).length) {
      return { ok: false, code: "conflict", message: "当前对话已有进行中的事项，请先更新或结束它" };
    }
    const actor = context.actor ?? this.userActor();
    const result = this.work.createWork(actor, {
      operationId: `goal-create-${randomUUID()}`,
      title: request.title,
      goalDescription: request.description,
      criteria: (request.criteria ?? []).slice(0, CONVERSATION_GOAL_MAX_CRITERIA)
        .map((criterion) => ({ text: criterion.text })),
      conversationId: request.taskId,
      legacyTaskId: request.taskId,
      ownerBotId: this.options.resolveBotId?.(request.taskId) ?? this.options.botId ?? DEFAULT_BOT_ID,
      inputSnapshotId: `conversation:${request.taskId}`,
    });
    if (!result.ok) return { ok: false, code: mapErrorCode(result.code), message: result.message };
    const goal = this.toGoal(result.work, request.taskId);
    if (!result.replayed) this.publish(goal);
    return { ok: true, goal };
  }

  update(request: ConversationGoalUpdateRequest, context: GoalCallContext = {}): ConversationGoalMutationResult {
    // Completion is one Work control operation. Its own transaction commits the
    // validation and closure; file evidence is read before entering that boundary.
    if (request.status === "achieved") {
      const result = this.applyUpdate(request, context);
      if (result.ok) this.publish(result.goal);
      return result;
    }

    try {
      const result = this.work.transaction(() => {
        const changed = this.applyUpdate(request, context);
        if (!changed.ok) throw new GoalMutationRejected(changed);
        return changed;
      });
      if (result.ok) this.publish(result.goal);
      return result;
    } catch (error) {
      if (error instanceof GoalMutationRejected) return error.result;
      throw error;
    }
  }

  private applyUpdate(request: ConversationGoalUpdateRequest, context: GoalCallContext): ConversationGoalMutationResult {
    const work = this.work.getWork(request.goalId);
    if (!work) return { ok: false, code: "not_found", message: "找不到该 Goal" };
    const conversationId = this.primaryConversation(work);
    const actor = context.actor ?? this.userActor();
    let guard = context.versionGuard;

    const status = request.status;
    if (status === "achieved") {
      const result = this.work.closeWork(actor, {
        operationId: `goal-close-${randomUUID()}`,
        workId: work.workId,
        conclusion: "succeeded",
        closureSummary: request.progressSummary,
        versionGuard: guard,
      });
      return this.finish(result, request.goalId, conversationId);
    }
    if (status === "cancelled") {
      const result = this.work.cancelWork(actor, {
        operationId: `goal-cancel-${randomUUID()}`,
        workId: work.workId,
        reason: request.progressSummary,
        versionGuard: guard,
      });
      return this.finish(result, request.goalId, conversationId);
    }
    if (status === "paused" && work.lifecycle === "active") {
      const result = this.work.pauseWork(actor, {
        operationId: `goal-pause-${randomUUID()}`,
        workId: work.workId,
        reason: request.progressSummary,
        versionGuard: guard,
      });
      return this.finish(result, request.goalId, conversationId);
    }
    if (status === "active" && work.lifecycle === "paused") {
      const result = this.work.resumeWork(actor, {
        operationId: `goal-resume-${randomUUID()}`, workId: work.workId, versionGuard: guard,
      });
      return this.finish(result, request.goalId, conversationId);
    }
    if (status === "blocked") {
      return { ok: false, code: "invalid_request", message: "阻碍由执行或用户反馈产生，不能直接设置" };
    }

    const criterionUpdates = (request.criterionUpdates ?? []).filter(update => update.status !== undefined);
    const textUpdates = (request.criterionUpdates ?? []).filter(update => update.text !== undefined);
    if (textUpdates.some(update => !work.criteria.some(criterion => criterion.id === update.id))) {
      return { ok: false, code: "not_found", message: "找不到待修改的验收项" };
    }
    const replacementCriteria = request.criteria ?? (textUpdates.length ? work.criteria.map(criterion => ({
      id: criterion.id, text: textUpdates.find(update => update.id === criterion.id)?.text ?? criterion.text,
    })) : undefined);
    const needsAttestation = criterionUpdates.length > 0;
    const needsAmend = request.title !== undefined
      || request.description !== undefined
      || request.progressSummary !== undefined
      || replacementCriteria !== undefined;
    if (!needsAttestation && !needsAmend) {
      return { ok: false, code: "invalid_request", message: "没有可应用的 Goal 变更" };
    }
    if (work.lifecycle === "closed" || work.lifecycle === "closing") {
      return { ok: false, code: "conflict", message: `事项处于 ${work.lifecycle}，不能直接修改要求` };
    }

    let last: WorkControlResult | undefined;
    if (needsAttestation) {
      if (actor.kind !== "user") {
        return { ok: false, code: "invalid_request", message: "模型不能直接写入验收事实，请提交证据" };
      }
      last = this.work.attestCriteria(actor, {
        operationId: `goal-attest-${randomUUID()}`,
        workId: work.workId,
        criterionUpdates: criterionUpdates.map((update) => ({
          criterionId: update.id,
          status: legacyCriterionStatus(update.status),
          evidence: update.evidence ?? update.text,
        })),
        progressSummary: request.progressSummary,
        versionGuard: guard,
      });
      if (!last.ok) return this.finish(last, request.goalId, conversationId) as ConversationGoalMutationResult;
      guard = { expectedStateVersion: last.work.stateVersion, expectedIntentRevision: last.work.intentRevision,
        expectedOwnerEpoch: last.work.ownerEpoch };
    }
    if (needsAmend) {
      if (actor.kind !== "user" && (replacementCriteria !== undefined || request.title !== undefined
        || request.description !== undefined)) {
        return { ok: false, code: "invalid_request", message: "模型不能直接改写目标或验收条件" };
      }
      last = this.work.amendWork(actor, {
        operationId: `goal-amend-${randomUUID()}`,
        workId: work.workId,
        title: request.title,
        goalDescription: request.description,
        progressSummary: request.progressSummary,
        criteria: replacementCriteria?.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
        })),
        versionGuard: guard,
      });
      if (!last.ok) return this.finish(last, request.goalId, conversationId) as ConversationGoalMutationResult;
    }
    return this.finish(last!, request.goalId, conversationId) as ConversationGoalMutationResult;
  }

  cancel(goalId: string, context: GoalCallContext = {}): ConversationGoalMutationResult {
    return this.update({ goalId, status: "cancelled" }, context);
  }

  getLive(taskId: string, workId?: string): ConversationGoalDto | undefined {
    const binding = this.work.repo.bindingForTask(taskId);
    const boundWork = binding ? this.work.getWork(binding.workId) : undefined;
    const visibleWorks = binding
      ? boundWork && boundWork.lifecycle !== "closed" ? [boundWork] : []
      : this.work.listWorksByConversation(taskId);
    const candidates = visibleWorks.filter(candidate => candidate.userId === (this.options.userId ?? LOCAL_USER_ID)
      && (!workId || candidate.workId === workId));
    if (candidates.length > 1) throw new Error("当前对话涉及多个 Work，请明确事项引用");
    const work = candidates[0];
    return work ? this.toGoal(work, taskId) : undefined;
  }

  listByTask(taskId: string): ConversationGoalDto[] {
    return this.work.listWorksByConversation(taskId).map(work => this.toGoal(work, taskId));
  }

  /**
   * A conversation branch stays a conversation of the same Work. Duplicating a goal
   * here would create a second live authority for one delegation.
   */
  cloneLive(sourceTaskId: string, childTaskId: string): ConversationGoalDto | undefined {
    const work = this.work.findLiveWorkForConversation(sourceTaskId);
    if (!work) return undefined;
    this.work.transaction(() => {
      this.work.repo.linkConversation(work.workId, childTaskId);
    });
    return this.toGoal(work, childTaskId);
  }

  /** Re-read the current fact and publish it; replays never take this path. */
  publishForTask(taskId: string): void {
    const work = this.work.findLiveWorkForConversation(taskId);
    if (work) this.publish(this.toGoal(work, taskId));
  }

  publishProjection(projection: WorkProjectionDto, taskId: string): void {
    const work = this.work.getWork(projection.workId);
    if (work) this.publish(this.toGoal(work, taskId));
  }

  toGoal(work: WorkDto, taskId: string): ConversationGoalDto {
    return {
      id: work.workId,
      taskId,
      title: work.title,
      description: work.goalDescription,
      status: goalStatus(work),
      criteria: work.criteria.map(toGoalCriterion),
      progressSummary: work.progressSummary ?? this.fallbackSummary(work),
      version: work.stateVersion,
      createdBy: work.createdBy === "user" ? "user" : "agent_explicit_request",
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
      achievedAt: work.lifecycle === "closed" && work.closureConclusion === "succeeded" ? work.closedAt : undefined,
    };
  }

  private finish(result: WorkControlResult, goalId: string, conversationId: string): ConversationGoalMutationResult {
    if (!result.ok) return { ok: false, code: mapErrorCode(result.code), message: result.message };
    const goal = this.toGoal(result.work, conversationId);
    return { ok: true, goal };
  }

  private publish(goal: ConversationGoalDto): void {
    this.emit({ type: "conversation_goal_snapshot", taskId: goal.taskId, goal });
  }

  private fallbackSummary(work: WorkDto): string | undefined {
    if (work.lifecycle === "closing") return "正在结算在途操作";
    if (work.lifecycle === "closed") return work.closureSummary;
    return undefined;
  }

  private primaryConversation(work: WorkDto): string {
    return work.legacyTaskId ?? this.work.repo.listConversationIds(work.workId)[0] ?? work.workId;
  }

  private userActor(): WorkActor {
    return {
      kind: "user",
      userId: this.options.userId ?? LOCAL_USER_ID,
      entry: "desktop",
      grants: DESKTOP_USER_GRANTS,
    };
  }
}

class GoalMutationRejected extends Error {
  constructor(readonly result: Extract<ConversationGoalMutationResult, { ok: false }>) { super(result.message); }
}

export function defaultBotActor(botId = DEFAULT_BOT_ID, userId = LOCAL_USER_ID): WorkActor {
  return {
    kind: "bot", botId, userId, host: "foreground", grants: DESKTOP_USER_GRANTS,
  };
}

function goalStatus(work: WorkDto): ConversationGoalStatus {
  if (work.lifecycle === "closed") {
    return work.closureConclusion === "succeeded" ? "achieved" : "cancelled";
  }
  if (work.lifecycle === "paused") return "paused";
  if (work.lifecycle === "closing") return "active";
  return "active";
}

function toGoalCriterion(criterion: WorkDto["criteria"][number]): GoalCriterionDto {
  return {
    id: criterion.id,
    text: criterion.text,
    status: goalCriterionStatus(criterion.status),
    evidence: criterion.evidenceRefs.length > 0
      ? `${criterion.evidenceRefs.length} 项证据${criterion.waivedReason ? `；豁免：${criterion.waivedReason}` : ""}`
      : criterion.waivedReason,
  };
}

function goalCriterionStatus(status: WorkDto["criteria"][number]["status"]): GoalCriterionStatus {
  if (status === "satisfied") return "met";
  if (status === "waived") return "waived";
  if (status === "failed" || status === "blocked") return "not_met";
  return "pending";
}

function legacyCriterionStatus(status: GoalCriterionStatus | undefined): "pending" | "met" | "not_met" | "waived" {
  if (status === "pending" || status === undefined) return "pending";
  if (status === "not_met") return "not_met";
  if (status === "waived") return "waived";
  return "met";
}

function mapErrorCode(code: WorkControlErrorCode): "not_found" | "invalid_request" | "conflict" {
  if (code === "not_found") return "not_found";
  if (code === "invalid_request") return "invalid_request";
  return "conflict";
}
