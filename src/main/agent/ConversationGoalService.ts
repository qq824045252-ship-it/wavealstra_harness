import { createHash, randomUUID } from "node:crypto";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import {
  CONVERSATION_GOAL_MAX_CRITERIA,
  type ConversationGoalContinuationDto,
  type ConversationGoalCreateRequest,
  type ConversationGoalDto,
  type ConversationGoalEvidenceDto,
  type ConversationGoalStatus,
  type ConversationGoalSourceDto,
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
import { DEFAULT_BOT_ID, LOCAL_USER_ID, isCriterionResolved, isRequiredCriterion } from "../../shared/bot-work";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { GoalCompletionObservation } from "./work/WorkClosureMutations";
import { DESKTOP_USER_GRANTS, WorkService } from "./work/WorkService";

export interface GoalCallContext {
  actor?: WorkActor;
  versionGuard?: ExpectedVersionGuard;
  source?: ConversationGoalSourceDto;
}

export interface ConversationGoalServiceOptions {
  userId?: string;
  botId?: string;
  resolveBotId?: (taskId: string) => string;
  resolveSourceMessageId?: (taskId: string) => string | undefined;
  /** Read-only ledger projection supplied by the host scheduler. */
  resolveContinuation?: (workId: string) => ConversationGoalContinuationDto | undefined;
  /** Foreground pause/resume is a scheduling event, not a second goal authority. */
  onStatusChange?: (goal: ConversationGoalDto, status: "paused" | "active") => void;
  /** A freshly created Goal gets a ledger baseline before its first turn, so its
   * budget window starts at creation instead of at the first settle. */
  onCreate?: (goal: ConversationGoalDto) => void;
  /** A Work is linked to its canonical Bot conversation and the desktop task; only
   * the latter is a schedulable task. Fallback: reported linked conversations. */
  resolvePrimaryTask?: (workId: string) => string | undefined;
}

/**
 * Projection adapter over the single Work authority.
 *
 * The conversation chip keeps its historical DTO shape, but every write goes through
 * WorkService (idempotency receipts, version guards, evidence-based acceptance). This
 * class never owns a second live record.
 */
type DotsCompletionPolicy = { stale: true } | { stale: false; evidenceOrigin: string; userAcceptance: boolean };

export class ConversationGoalService {
  private dotsCompletion?: (taskId: string, operationId: string, workId: string, revision: number) => DotsCompletionPolicy | undefined;

  private recoverDotsCompletionLink?: (taskId: string, operationId: string, workId: string, revision: number) => Promise<void>;

  bindDotsCompletion(resolver: NonNullable<ConversationGoalService["dotsCompletion"]>,
    recover: NonNullable<ConversationGoalService["recoverDotsCompletionLink"]>) {
    this.dotsCompletion = resolver;
    this.recoverDotsCompletionLink = recover;
  }

  async resolveDotsCompletion(taskId: string, operationId: string, work: WorkDto) {
    const known = this.dotsCompletionPolicy(taskId, operationId, work);
    if (known || !operationId.startsWith("goal-continuation:")) return known;
    await this.recoverDotsCompletionLink?.(taskId, operationId, work.workId, work.intentRevision);
    return this.dotsCompletionPolicy(taskId, operationId, work);
  }

  dotsCompletionPolicy(taskId: string, operationId: string, work: WorkDto) {
    return this.dotsCompletion?.(taskId, operationId, work.workId, work.intentRevision);
  }

  completeFromDots(taskId: string, operationId: string, workId: string, guard: ExpectedVersionGuard, summary: string,
    observations: readonly GoalCompletionObservation[], userConfirmed: boolean): ConversationGoalMutationResult {
    const work = this.work.getWork(workId);
    const policy = work && this.dotsCompletionPolicy(taskId, operationId, work);
    if (!work || !policy || policy.stale || (policy.userAcceptance && !userConfirmed) || this.work.repo.bindingForTask(taskId)
      || work.mode === "watch" || !observations.length)
      return { ok: false, code: "conflict", message: "原交办已变化，或缺少当前成果依据或约定的用户验收" };
    if (observations.some(item => item.criterionId && !work.criteria.some(criterion => criterion.id === item.criterionId)))
      return { ok: false, code: "invalid_request", message: "验收依据应引用当前 Goal 的条件编号" };
    const result = this.finish(this.work.closeWork(this.modelActor(taskId), {
      operationId: `dots-goal-close:${operationId}`, workId, conclusion: "succeeded",
      closureSummary: summary, versionGuard: guard,
    }, observations), workId, this.primaryConversation(work));
    if (result.ok) this.publish(result.goal);
    return result;
  }

  completeFromConfirmation(context: ConversationExecutionContext, workId: string, guard: ExpectedVersionGuard,
    summary: string): ConversationGoalMutationResult {
    const work = this.scopedWork(context.taskId, workId);
    if (!work || this.work.repo.bindingForTask(context.taskId) || work.mode === "watch")
      return { ok: false, code: "conflict", message: "当前对话没有可由用户确认完成的 Goal" };
    const operationId = `goal-confirm:${context.executionId}`;
    const observations: GoalCompletionObservation[] = work.criteria
      .filter(criterion => isRequiredCriterion(criterion) && !isCriterionResolved(criterion))
      .map(criterion => ({ criterionId: criterion.id, sourceRef: operationId, detail: summary, kind: "user_attestation" }));
    const result = this.finish(this.work.closeWork(this.userActor(), {
      operationId, workId, conclusion: "succeeded", closureSummary: summary, versionGuard: guard,
    }, observations), workId, context.taskId);
    if (result.ok) this.publish(result.goal);
    return result;
  }

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
    const actor = context.actor ?? this.userActor();
    const source = context.source;
    const inputSnapshotId = source ? `message:sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`
      : `conversation:${request.taskId}`;
    const result = this.work.transaction(() => {
      if (source && actor.kind === "user") {
        const prior = this.work.repo.findWorkByGoalSource(actor.userId, source);
        if (prior) return { ok: true as const, work: prior, replayed: true };
      }
      if (this.work.listWorksByConversation(request.taskId).length) {
        return { ok: false as const, code: "conflict" as const, message: "当前对话已有进行中的事项，请先更新或结束它" };
      }
      const created = this.work.createWork(actor, {
        operationId: `goal-create-${randomUUID()}`,
        title: request.title,
        goalDescription: request.description,
        criteria: (request.criteria ?? []).slice(0, CONVERSATION_GOAL_MAX_CRITERIA)
          .map((criterion) => ({ text: criterion.text })),
        conversationId: request.taskId,
        sourceMessageId: source?.messageId ?? this.options.resolveSourceMessageId?.(request.taskId),
        legacyTaskId: request.taskId,
        ownerBotId: this.options.resolveBotId?.(request.taskId) ?? this.options.botId ?? DEFAULT_BOT_ID,
        inputSnapshotId,
      });
      if (created.ok && !created.replayed && source) this.work.repo.saveGoalSource(created.work.workId, source);
      return created;
    });
    if (!result.ok) return { ok: false, code: result.code === "conflict" ? "conflict" : mapErrorCode(result.code), message: result.message };
    const goal = this.toGoal(result.work, request.taskId);
    if (!result.replayed) {
      this.publish(goal);
      this.options.onCreate?.(goal);
    }
    return { ok: true, goal };
  }

  update(request: ConversationGoalUpdateRequest, context: GoalCallContext = {}): ConversationGoalMutationResult {
    // Completion is one Work control operation. Its own transaction commits the
    // validation and closure; file evidence is read before entering that boundary.
    // Only a real paused → active transition is a resume; an update that merely
    // includes status:"active" must not clear a host deferral.
    const lifecycleBefore = request.status === "active" ? this.work.getWork(request.goalId)?.lifecycle : undefined;
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
      if (result.ok) {
        this.publish(result.goal);
        if (request.status === "paused") this.options.onStatusChange?.(result.goal, "paused");
        else if (request.status === "active" && lifecycleBefore === "paused") this.options.onStatusChange?.(result.goal, "active");
      }
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

    if (actor.kind === "worker" && request.criterionUpdates?.some(update => update.status === "pending")) {
      if (request.criterionUpdates.some(update => update.status === "pending"
        && !work.criteria.some(criterion => criterion.id === update.id && criterion.status === "pending")))
        return { ok: false, code: "invalid_request", message: "不能将已有验收事实改回 pending；请仅提交 id/evidence 并使用最新版本" };
      request = { ...request, criterionUpdates: request.criterionUpdates.map(update => {
        if (update.status !== "pending") return update;
        const { status: _status, ...evidenceOnly } = update;
        return evidenceOnly;
      }) };
    }

    // Worker evidence is a report, never an attestation. Preserve it visibly in
    // the progress journal instead of silently discarding evidence-only updates.
    const reported = (request.criterionUpdates ?? []).filter(update => update.status === undefined && update.evidence !== undefined);
    if (actor.kind === "worker" && reported.length) {
      if (reported.some(update => !work.criteria.some(criterion => criterion.id === update.id)))
        return { ok: false, code: "not_found", message: "找不到待报告证据的验收项" };
      const summary = [request.progressSummary, ...reported.map(update => `待核验证据 [${update.id}]：${update.evidence}`)].filter(Boolean).join("\n");
      if (summary.length > 2000) return { ok: false, code: "invalid_request", message: "进展和待核验证据超过2000字符，请精简或分次提交" };
      request = { ...request, progressSummary: summary };
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

  scopedWork(taskId: string, goalId: string): WorkDto | undefined {
    const work = this.work.getWork(goalId);
    return work?.userId === (this.options.userId ?? LOCAL_USER_ID)
      && this.work.repo.listConversationIds(goalId).includes(taskId) ? work : undefined;
  }

  listByTask(taskId: string): ConversationGoalDto[] {
    return this.work.repo.listWorksByTaskForUser(taskId, this.options.userId ?? LOCAL_USER_ID)
      .map(work => this.toGoal(work, taskId));
  }

  readEvidence(taskId: string, goalId: string): ConversationGoalEvidenceDto | undefined {
    const work = this.work.repo.getWorkByTaskForUser(goalId, taskId, this.options.userId ?? LOCAL_USER_ID);
    return work ? this.goalEvidence(work) : undefined;
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
    const continuation = this.options.resolveContinuation?.(work.workId);
    const blocker = work.lifecycle === "active" ? this.work.repo.listOpenBlockers(work.workId)[0] : undefined;
    return {
      id: work.workId,
      taskId,
      title: work.title,
      description: work.goalDescription,
      status: blocker ? "blocked" : goalStatus(work),
      criteria: work.criteria.map(toGoalCriterion),
      progressSummary: work.progressSummary ?? this.fallbackSummary(work),
      version: work.stateVersion,
      createdBy: work.createdBy === "user" ? "user" : "agent_explicit_request",
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
      closedAt: work.closedAt,
      sourceMessageId: work.sourceMessageId,
      source: this.work.repo.getGoalSource(work.workId),
      waitingReason: blocker?.reason ?? (work.lifecycle === "closing" ? "正在结算在途操作" : undefined),
      closureConclusion: work.closureConclusion,
      achievedAt: work.lifecycle === "closed" && work.closureConclusion === "succeeded" ? work.closedAt : undefined,
      ...(continuation ? { continuation } : {}),
    };
  }

  private finish(result: WorkControlResult, goalId: string, conversationId: string): ConversationGoalMutationResult {
    if (!result.ok) return { ok: false, code: mapErrorCode(result.code), message: result.message };
    const goal = this.toGoal(result.work, conversationId);
    return { ok: true, goal };
  }

  private goalEvidence(work: WorkDto): ConversationGoalEvidenceDto {
    const current = (item: { intentRevision: number; inputSnapshotId: string }): boolean =>
      item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId;
    const sameOwner = (item: { ownerEpoch: number }): boolean => item.ownerEpoch === work.ownerEpoch;
    const executions = this.work.repo.listBindings(work.workId)
      .filter(item => current(item) && sameOwner(item) && item.invalidatedAt === undefined)
      .map(({ bindingId, botId, taskId, conversationId, status, metrics }) =>
        ({ bindingId, botId, taskId, conversationId, status, metrics }));
    const executionIds = new Set(executions.map(item => item.bindingId));
    const evidence = this.work.repo.listEvidence(work.workId).filter(item => current(item)
      && (item.executionId === undefined || executionIds.has(item.executionId)));
    return {
      ownerBotId: work.ownerBotId, userId: work.userId, intentRevision: work.intentRevision,
      inputSnapshotId: work.inputSnapshotId === "snapshot:unbound" ? undefined : work.inputSnapshotId,
      executions,
      deliverables: this.work.repo.listDeliverables(work.workId)
        .filter(item => current(item) && sameOwner(item) && executionIds.has(item.executionId))
        .map(({ deliverableId, executionId, summary, status, artifactRefs }) =>
          ({ deliverableId, executionId, summary, status, artifactRefs })),
      verification: work.criteria.filter(item => item.status === "satisfied"
        && item.verifiedIntentRevision === item.requiredIntentRevision)
        .map(criterion => ({
          criterionId: criterion.id,
          evidence: evidence.filter(item => item.provenance !== "execution"
            && item.criterionIds.includes(criterion.id) && criterion.evidenceRefs.includes(item.evidenceId)),
        })).filter(item => item.evidence.length > 0),
      artifacts: this.work.artifacts.goalArtifacts(work.workId, executionIds),
      schedules: this.work.repo.listSubscriptions(work.workId, { includeStopped: true })
        .map(({ subscriptionId, source, nextWakeAt, lastCheckedAt, stoppedAt, stoppedReason }) =>
          ({ subscriptionId, source, nextWakeAt, lastCheckedAt, stoppedAt, stoppedReason })),
    };
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
    return this.options.resolvePrimaryTask?.(work.workId)
      ?? work.legacyTaskId ?? this.work.repo.listConversationIds(work.workId)[0] ?? work.workId;
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
