import { reportWorkBlockerMutation, replyUserInputMutation, replyLegacyUserInputMutation } from "./WorkUserInputControls";
import { legacyUserInputSource } from "./WorkLegacyUserInput";
import type { ReplyUserInputParams, ReplyLegacyUserInputParams } from "../../../shared/bot-work-review";
import { settleWorkAdmission, settleWorkExecution } from "./WorkExecutionSettlement";
import { WorkResultCards } from "./WorkResultCards";
import { WorkPhase5Facts } from "./WorkPhase5Facts";
import { checkControlGuard } from "./WorkControlGuards";
import type {
  WorkCardReadResult, WorkExpandedDiagnosticsDto, WorkSummaryProjectionDto,
} from "../../../shared/bot-work-phase5";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AcceptDeliverableParams,
  AddParticipantParams,
  AdmitActionParams,
  AmendWorkParams,
  AttestCriteriaParams,
  CancelWorkParams,
  ClearBlockerParams,
  CloseWorkParams,
  CreateWorkParams,
  DispatchExecutionParams,
  ExpectedVersionGuard,
  HandoffOwnerParams,
  PauseWorkParams,
  ReconcileExecutionParams,
  RecordUserFeedbackParams,
  RejectDeliverableParams,
  ReportBlockerParams,
  ResumeWorkParams,
  SubmitDeliverableParams,
  WorkActor,
  WorkAdmissionDto,
  WorkAuthorizationDto,
  WorkBlockerDto,
  WorkBudgetReservationDto,
  WorkControlErrorCode,
  WorkControlResult,
  WorkCriterionDto,
  WorkDeliverableDto,
  WorkDto,
  WorkEvidenceDto,
  WorkEvidenceKind,
  WorkEvidenceProvenance,
  WorkExecutionBindingDto,
  WorkExecutionStatus,
  WorkGoalSourceDto,
  WorkInboxEventDto,
  WorkIntentSnapshotDto,
  WorkNotificationChannel,
  WorkNotificationDto,
  WorkOutboxInstructionDto,
  WorkParticipantDto,
  WorkProjectionDto,
  WorkSourceEventDto,
  WorkSubscriptionDto,
  WorkSubscriptionInput,
  WorkWatchRuleDto,
} from "../../../shared/bot-work";
import {
  DEFAULT_BOT_ID,
  WORK_MAX_CRITERIA,
  WORK_MAX_PARTICIPANTS,
  assertNoActorField,
  canonicalControlInput,
  criterionNeedsEnvironment,
  intersectAuthorization,
  isCriterionResolved,
  minimumAuthorization,
} from "../../../shared/bot-work";
import type { BotDto } from "../../../shared/bot-work";
import type { WorkSubscriptionMonitorDto, WorkPhase4ControlRequest, WorkPhase4ControlResult } from "../../../shared/bot-work-phase4";
import { phase4ControlRequestSchema } from "../../../shared/bot-work-phase4";
import { BotRegistry } from "./BotRegistry";
import { WorkTeamService } from "./WorkTeamService";
import { WorkRepository, newId } from "./WorkRepository";
import { cronNextWake, type WorkNextWake } from "./WorkSchedule";
import { normalizeTexts, normalizeSources, normalizeWatchRule, normalizeCriteria, currentAcceptedDeliverableIds, matchesFilter } from "./WorkControlNormalization";
import { WorkNativeResultInbox } from "./WorkNativeResultInbox";
import { WorkResourceGate, type ResourceLease } from "./WorkResourceGate";
import { WorkPartialResults } from "./WorkPartialResults";
import { WorkArtifactValidation } from "./WorkArtifactValidation";
import { WorkCollaborationService } from "./WorkCollaborationService";
import { WorkNotificationDelivery } from "./WorkNotificationDelivery";
import { WorkPausedBacklog } from "./WorkPausedBacklog";
import { WorkWatchIngress } from "./WorkWatchIngress";
import { WorkBudgetService } from "./WorkBudgetService";
import { WorkCausalGuard } from "./WorkCausalGuard";
import { WorkWatchScheduler } from "./WorkWatchScheduler";
import { WorkActionApprovals } from "./WorkActionApprovals";
import { authorizeWorkResourceOwner, finalizeWorkResource } from "./WorkResourceSettlement";
import { continuationWorkSchema, type ContinuationWorkParams } from "../../../shared/bot-work-phase3";
import type { PrepareResourceEffectParams, ReconcileResourceEffectParams, RetryResourceRecoveryParams } from "../../../shared/bot-work-phase3-control";
import { resourceRecoveryProjection, runResourceRecoveryControl, runResourceEffectReviewControl, runPrepareResourceEffectControl } from "./WorkResourceRecoveryControl";

/** Local desktop entry envelope. It never creates branch/worktree implicitly. */
export const DESKTOP_USER_GRANTS: WorkAuthorizationDto = {
  allowedScopes: ["workspace:read", "workspace:write"],
  targetWhitelist: [],
  allowGitBranchOrWorktree: false,
  allowRedelegation: false,
};

export interface WorkServiceOptions {
  bots: BotRegistry;
  resourceHostId?: string;
  now?: () => number;
  emitProjection?: (projection: WorkProjectionDto) => void;
  computeNextWake?: WorkNextWake;
  /** Only the authoritative host may create control instructions (F14 / BW-A13). */
  isAuthority?: () => boolean;
}

type Fail = { ok: false; code: WorkControlErrorCode; message: string; latestWorkSnapshot?: WorkDto };
type Mutation = { ok: true; outboxEventId?: string } | Fail;

interface ResolvedActor {
  userId: string;
  kind: WorkActor["kind"];
  bot?: BotDto;
  grants: WorkAuthorizationDto;
  binding?: WorkExecutionBindingDto;
}

const TERMINAL_BINDING_STATUSES = new Set<WorkExecutionStatus>(["completed", "failed", "stopped", "invalidated"]);
const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);
const EXECUTION_EVIDENCE_KINDS = new Set<WorkEvidenceKind>(["automated_test", "tool_receipt", "inspection", "artifact"]);

export class WorkService {
  readonly teams: WorkTeamService;
  readonly repo: WorkRepository;
  readonly nativeResults: WorkNativeResultInbox;
  readonly resourceGate: WorkResourceGate;
  readonly partialResults: WorkPartialResults;
  readonly artifacts: WorkArtifactValidation;
  readonly collaboration: WorkCollaborationService;
  readonly notifications: WorkNotificationDelivery;
  readonly pausedBacklog: WorkPausedBacklog;
  readonly ingress: WorkWatchIngress;
  readonly approvals: WorkActionApprovals;
  readonly budget: WorkBudgetService;
  readonly causal: WorkCausalGuard;
  readonly scheduler: WorkWatchScheduler;
  readonly cards: WorkResultCards;
  readonly phase5: WorkPhase5Facts;
  private readonly bots: BotRegistry;
  private readonly now: () => number;
  private readonly emit?: (projection: WorkProjectionDto) => void;
  private readonly computeNextWake: WorkNextWake;
  private readonly authority?: () => boolean;
  private readonly lastEmitted = new Map<string, number>();
  private lastPhase4SubscriptionId?: string;
  private transactionDepth = 0;
  private readonly pendingProjections = new Set<string>();

  constructor(private readonly db: Database.Database, options: WorkServiceOptions) {
    this.repo = new WorkRepository(db);
    this.nativeResults = new WorkNativeResultInbox(db, this, () => !this.authority || this.authority());
    this.bots = options.bots;
    this.now = options.now ?? (() => Date.now());
    this.emit = options.emitProjection;
    this.computeNextWake = options.computeNextWake ?? cronNextWake;
    this.authority = options.isAuthority;
    this.approvals = new WorkActionApprovals(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.budget = new WorkBudgetService(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.ingress = new WorkWatchIngress(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.causal = new WorkCausalGuard(db, this, { now: this.now });
    this.scheduler = new WorkWatchScheduler(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.resourceGate = new WorkResourceGate(db, { hostId: options.resourceHostId ?? newId("resource-host"),
      isAuthority: () => !this.authority || this.authority(), now: this.now,
      authorize: (owner, resources, actionId) => authorizeWorkResourceOwner({ service: this, bots: this.bots, now: this.now, owner, resources, actionId }) });
    this.partialResults = new WorkPartialResults(db, this);
    this.artifacts = new WorkArtifactValidation(db, this);
    this.collaboration = new WorkCollaborationService(db, this, this.bots, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.notifications = new WorkNotificationDelivery(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority(), artifacts: this.artifacts });
    this.cards = new WorkResultCards(db, this.repo);
    this.phase5 = new WorkPhase5Facts(this, this.now, db);
    this.pausedBacklog = new WorkPausedBacklog(db, this);
    this.teams = new WorkTeamService(db, this, this.bots, this.now);
  }

  private authorityError(): Fail | undefined {
    if (!this.authority || this.authority()) return undefined;
    return { ok: false, code: "unauthorized_actor", message: "当前宿主不是事项控制权威，拒绝写入" };
  }

  transaction<T>(fn: () => T): T {
    const pendingBefore = new Set(this.pendingProjections);
    this.transactionDepth++;
    try {
      return this.db.transaction(fn).immediate();
    } catch (error) {
      this.pendingProjections.clear();
      for (const workId of pendingBefore) this.pendingProjections.add(workId);
      throw error;
    } finally {
      this.transactionDepth--;
      if (this.transactionDepth === 0) {
        const committed = [...this.pendingProjections];
        this.pendingProjections.clear();
        for (const workId of committed) this.emitCurrentProjection(workId);
      }
    }
  }

  // =========================================================== queries / UI

  getWork(workId: string): WorkDto | undefined {
    return this.repo.getWork(workId);
  }

  listWorks(userId: string, options?: { includeClosed?: boolean }): WorkDto[] {
    return this.repo.listWorks(userId, options);
  }

  listWorksByConversation(conversationId: string): WorkDto[] {
    return this.repo.listLiveWorksByTask(conversationId);
  }

  findLiveWorkForConversation(conversationId: string): WorkDto | undefined {
    const works = this.listWorksByConversation(conversationId);
    if (works.length > 1) throw new Error("当前对话涉及多个 Work，请明确事项引用");
    return works[0];
  }

  getProjection(workId: string): WorkProjectionDto | undefined {
    const work = this.repo.getWork(workId);
    return work ? this.project(work) : undefined;
  }

  listProjections(userId: string, options?: { includeClosed?: boolean }): WorkProjectionDto[] {
    return this.repo.listWorks(userId, options).map((work) => this.project(work));
  }

  /** R10: emit only the current fact; replays never publish a historical snapshot. */
  emitCurrentProjection(workId: string, options: { force?: boolean } = {}): WorkProjectionDto | undefined {
    if (this.transactionDepth > 0) {
      this.pendingProjections.add(workId);
      return undefined;
    }
    const work = this.repo.getWork(workId);
    if (!work || !this.emit) return undefined;
    const last = this.lastEmitted.get(workId) ?? 0;
    // A read/effect fact can change without a Work control version; it still has to reach
    // the other devices, so those paths force the push while the client reads facts back.
    if (!options.force && work.stateVersion <= last) return undefined;
    this.lastEmitted.set(workId, Math.max(last, work.stateVersion));
    const projection = this.project(work);
    this.emit(projection);
    return projection;
  }

  private project(work: WorkDto): WorkProjectionDto {
    const deliverables = this.repo.listDeliverables(work.workId);
    const blockers = this.repo.listBlockers(work.workId).map(blocker => {
      const legacyUserInput = legacyUserInputSource(this.db, work, blocker);
      return legacyUserInput ? { ...blocker, legacyUserInput } : blocker;
    });
    const executions = this.repo.listBindings(work.workId);
    const notifications = this.repo.listNotifications(work.workId).map(notification => ({ ...notification, ...this.notifications.identity(notification.notificationId) }));
    const subscriptions = this.repo.listSubscriptions(work.workId);
    const currentResultIds = new Set(currentAcceptedDeliverableIds(work, deliverables, executions));
    const unresolved = work.criteria.filter((criterion) => !isCriterionResolved(criterion));
    const uncoveredScope = [...new Set(deliverables
      .filter((deliverable) => currentResultIds.has(deliverable.deliverableId))
      .flatMap((deliverable) => deliverable.uncoveredScope))];
    const nextSteps: string[] = [];
    if (work.lifecycle === "closing") nextSteps.push("等待在途执行与外部效果结算");
    const resourceWaits = this.resourceGate.waiting(work.workId);
    const { resourceRecoveries, nextSteps: recoverySteps } = resourceRecoveryProjection(this.db, this.resourceGate, work.workId);
    const settlingActions = Math.max(this.repo.listAdmissions(work.workId).filter(item => item.state === "admitted" || item.state === "unknown").length,
      this.resourceGate.live().filter(lease => lease.owner.workId === work.workId).length);
    const gaps = this.partialResults.gaps(work.workId);
    if (work.lifecycle === "paused") nextSteps.push(settlingActions ? "已暂停，正在结算在途操作" : "事项已暂停，恢复后继续");
    for (const reason of resourceWaits) nextSteps.push(reason);
    nextSteps.push(...recoverySteps);
    if (gaps.length) nextSteps.push(`保留已确认成果，仍有 ${gaps.length} 项必要缺口待核对：未执行动作可关联后续证据覆盖，其余缺口按原身份处理`);
    if (work.lifecycle !== "closed") {
      for (const blocker of blockers.filter((item) => item.status === "open" && item.waitingForUserInput)) {
        nextSteps.push(`需要你的决定：${blocker.reason}`);
      }
      const realEnvironment = unresolved.filter(criterion => criterionNeedsEnvironment(criterion));
      if (realEnvironment.length > 0) {
        nextSteps.push(`等待实测反馈：${realEnvironment.map(criterion => criterion.text).join("、")}`);
      }
      const pendingText = unresolved.filter(criterion => !criterionNeedsEnvironment(criterion));
      if (pendingText.length > 0) nextSteps.push(`待验收：${pendingText.map(criterion => criterion.text).join("、")}`);
      const hasCurrentExecution = executions.some(binding => UNSETTLED_BINDING_STATUSES.has(binding.status)
        && binding.invalidatedAt === undefined && binding.intentRevision === work.intentRevision
        && binding.inputSnapshotId === work.inputSnapshotId);
      const hasPendingResult = deliverables.some(deliverable => deliverable.status === "proposed"
        && deliverable.intentRevision === work.intentRevision && deliverable.inputSnapshotId === work.inputSnapshotId);
      if (currentResultIds.size === 0 && !hasCurrentExecution && !hasPendingResult) nextSteps.push("安排后台执行");
    }
    return {
      workId: work.workId,
      title: work.title,
      mode: work.mode,
      lifecycle: work.lifecycle,
      pendingConclusion: work.pendingConclusion,
      closureConclusion: work.closureConclusion,
      closureSummary: work.closureSummary,
      ownerBotId: work.ownerBotId,
      team: this.teams?.get(work.workId),
      ownerEpoch: work.ownerEpoch,
      intentRevision: work.intentRevision,
      sourceVersion: work.sourceVersion,
      stateVersion: work.stateVersion,
      inputSnapshotId: work.inputSnapshotId,
      inputSnapshotBound: work.inputSnapshotId !== "snapshot:unbound",
      goalSources: work.goalSources,
      criteria: work.criteria,
      acceptedDeliverableIds: [...currentResultIds],
      deliverables,
      blockers,
      approvals: this.approvals.list(work.workId),
      executions,
      notifications,
      cards: this.cards.list(work),
      subscriptionIds: subscriptions.map(subscription => subscription.subscriptionId),
      phase4: {
        subscriptions: this.projectSubscriptions(work),
        offlineGaps: this.scheduler.gaps(work.workId),
        budget: this.budget.snapshot(work.workId),
        causal: this.causal.list(work.workId, 10).map(item => ({ chainId: item.chain_id, rootEventId: item.root_event_id,
          parentChainId: item.parent_chain_id ?? undefined, originWorkId: item.origin_work_id,
          targetWorkId: item.target_work_id, depth: item.depth, hops: item.hops,
          dispatchCount: item.dispatch_count, decision: item.decision,
          reasonCode: item.reason_code ?? undefined, createdAt: item.created_at })),
        deadlineAt: work.deadlineAt, deadlineRevision: work.deadlineRevision,
        host: this.scheduler.hostState(),
      },
      phase3: {
        subitems: this.partialResults.list(work.workId), continuations: this.partialResults.plans(work.workId),
        gaps, resourceWaits, resourceRecoveries, settlingActions, pausedEventCount: this.pausedBacklog.count(work.workId),
        artifactSnapshotId: this.artifacts.currentSnapshotId(work.workId),
        handoffs: this.collaboration.history(work.workId).filter(message => message.kind === "handoff"),
        collaborationMessages: this.collaboration.history(work.workId),
      },
      uncoveredScope,
      nextSteps,
      updatedAt: work.updatedAt,
      closedAt: work.closedAt,
    };
  }

  // ================================================================ create

  createWork(actor: WorkActor, params: CreateWorkParams): WorkControlResult {
    const authorityError = this.authorityError();
    if (authorityError) return authorityError;
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    if (resolved.kind === "worker") {
      return { ok: false, code: "unauthorized_actor", message: "执行者只能处理已绑定的事项，不能创建新的长期责任" };
    }
    const invalid = this.validatePayload("createWork", params);
    if (invalid) return invalid;
    const payloadHash = this.hash("createWork", params);

    const outcome = this.transaction((): WorkControlResult => {
      // A lease or Bot binding can change while waiting for the SQLite write
      // lock. New control facts must be authorized in the same commit order.
      const authorityError = this.authorityError();
      if (authorityError) return authorityError;
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const existing = this.repo.getReceipt(resolved.userId, params.operationId);
      if (existing) {
        if (existing.operation_type !== "createWork" || existing.payload_hash !== payloadHash) {
          return {
            ok: false, code: "idempotency_conflict",
            message: `操作 ${params.operationId} 已绑定不同的创建请求`,
          };
        }
        const snapshot = parseWork(existing.result_snapshot_json);
        if (!snapshot) return { ok: false, code: "not_found", message: "历史回执不可用" };
        if (snapshot.userId !== resolved.userId) {
          return { ok: false, code: "not_found", message: "找不到该操作的历史回执" };
        }
        const current = this.repo.getWork(snapshot.workId);
        if (!current) return { ok: false, code: "not_found", message: "原事项已不存在" };
        const access = this.requireAccess(current, resolved);
        if (access) return access;
        return {
          ok: true, replayed: true, operationId: params.operationId,
          work: snapshot, outboxEventId: existing.outbox_event_id ?? undefined,
        };
      }
      if (!params.title?.trim()) return { ok: false, code: "invalid_request", message: "Work 标题不能为空" };
      const ownerBot = this.bots.getBot(params.ownerBotId ?? (resolved.bot?.botId ?? DEFAULT_BOT_ID));
      if (!ownerBot) return { ok: false, code: "not_found", message: "找不到负责人 Bot" };
      if (ownerBot.userId !== resolved.userId) {
        return { ok: false, code: "unauthorized_actor", message: "负责人 Bot 不属于当前用户" };
      }
      if (ownerBot.status !== "active") {
        return { ok: false, code: "bot_disabled", message: "Bot 已停用，不能分配新事项" };
      }
      const now = this.now();
      const workId = newId("work");
      const criteria = normalizeCriteria(params.criteria, 1, now);
      if (typeof criteria === "string") return { ok: false, code: "invalid_request", message: criteria };
      const authorization = intersectAuthorization(params.authorization, resolved.grants);
      const inputSnapshotId = params.inputSnapshotId?.trim() || "snapshot:unbound";
      const goalSources = normalizeSources(params.goalSources, now);
      const budget = this.initialBudget(workId, params, authorization, now);
      const watchRule = normalizeWatchRule(params.watchRule);
      const snapshotId = `snap-${workId}-r1-s1`;
      const work: WorkDto = {
        workId,
        userId: resolved.userId,
        projectId: params.projectId,
        workspacePath: params.workspacePath,
        sourceMessageId: params.sourceMessageId,
        legacyTaskId: undefined,
        ownerBotId: ownerBot.botId,
        ownerEpoch: 1,
        participants: [],
        intentRevision: 1,
        sourceVersion: 1,
        title: params.title.trim().slice(0, 240),
        goalDescription: params.goalDescription?.trim().slice(0, 2000) || undefined,
        constraints: normalizeTexts(params.constraints),
        criteria,
        authorization,
        activeIntentSnapshotId: snapshotId,
        inputSnapshotId,
        goalSources,
        mode: params.mode ?? "once",
        lifecycle: "active",
        deadlineRevision: 1,
        acceptedDeliverableIds: [],
        activeExecutionIds: [],
        stateVersion: 1,
        budget,
        watchRule,
        createdBy: resolved.kind === "user" ? "user" : "bot",
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insertWork(work);
      this.budget.ensureWindow(work);
      this.repo.insertIntentSnapshot(this.intentSnapshot(work, ownerBot, params.sourceMessageId, work.createdBy));
      if (params.conversationId) this.repo.linkConversation(workId, params.conversationId, "desktop", now);
      if (watchRule) this.installSubscriptions(work, watchRule, now);
      const outboxEventId = this.outbox({
        work, eventType: "work.created", operationId: params.operationId,
        bindingId: undefined, causalEventId: params.causalEventId,
        payload: { title: work.title, mode: work.mode },
      });
      this.repo.saveReceipt({
        userId: resolved.userId, operationId: params.operationId, workId,
        operationType: "createWork", payloadHash, workSnapshot: work,
        outboxEventId, now,
      });
      return { ok: true, replayed: false, operationId: params.operationId, work, outboxEventId };
    });
    if (outcome.ok && !outcome.replayed) this.emitCurrentProjection(outcome.work.workId);
    return outcome;
  }

  // ================================================================= amend

  amendWork(actor: WorkActor, params: AmendWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "amendWork", params, { guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"] },
      (work, resolved, now) => this.applyAmend(work, resolved, params, now));
  }

  /** Trusted host source readback. Not exposed as a model tool or IPC actor. */
  applyObservedSources(workId: string, operationId: string, readBefore: WorkDto,
    current: { inputSnapshotId: string; sources: WorkGoalSourceDto[] }): WorkControlResult {
    const params: AmendWorkParams = { operationId, workId, inputSnapshotId: current.inputSnapshotId, goalSources: current.sources };
    const invalid = this.validatePayload("amendWork", params);
    if (invalid) return invalid;
    const outcome = this.transaction((): WorkControlResult => {
      const denied = this.authorityError(); if (denied) return denied;
      const work = this.repo.getWork(workId);
      if (!work || readBefore.workId !== workId) return { ok: false, code: "not_found", message: "找不到 Work" };
      const payloadHash = this.hash("observedSources", params);
      const receipt = this.repo.getReceipt(work.userId, operationId);
      if (receipt) {
        if (receipt.work_id !== workId || receipt.operation_type !== "observedSources" || receipt.payload_hash !== payloadHash)
          return { ok: false, code: "idempotency_conflict", message: "来源操作身份已用于不同观察" };
        return { ok: true, replayed: true, operationId, work };
      }
      if (work.stateVersion !== readBefore.stateVersion || work.ownerEpoch !== readBefore.ownerEpoch
        || work.intentRevision !== readBefore.intentRevision || work.inputSnapshotId !== readBefore.inputSnapshotId)
        return { ok: false, code: "version_conflict", message: "来源读取期间事项已变化，需要重新观察" };
      if (!["active", "paused"].includes(work.lifecycle))
        return { ok: false, code: "invalid_lifecycle_transition", message: "结束中的事项不受理新的来源变化" };
      const mutation = this.applyAmend(work, { kind: "system", userId: work.userId, grants: work.authorization }, params, this.now());
      if (!mutation.ok) return mutation;
      const updated = this.repo.getWork(workId)!;
      if (updated.inputSnapshotId !== readBefore.inputSnapshotId) this.outbox({ work: updated,
        eventType: "work.source_dispatch_requested", operationId: `source-dispatch:${operationId}`,
        payload: { inputSnapshotId: updated.inputSnapshotId, sourceOperationId: operationId } });
      this.repo.saveReceipt({ userId: work.userId, operationId, workId, operationType: "observedSources", payloadHash,
        workSnapshot: updated, outboxEventId: mutation.outboxEventId, now: this.now() });
      this.emitCurrentProjection(workId);
      return { ok: true, replayed: false, operationId, work: updated, outboxEventId: mutation.outboxEventId };
    });
    return outcome;
  }

  private applyAmend(work: WorkDto, resolved: ResolvedActor, params: AmendWorkParams, now: number): Mutation {
    const nextTitle = params.title?.trim().slice(0, 240) ?? work.title;
    const nextDescription = params.goalDescription === undefined
      ? work.goalDescription
      : params.goalDescription.trim().slice(0, 2000) || undefined;
    const nextConstraints = params.constraints === undefined ? work.constraints : normalizeTexts(params.constraints);
    const nextAuthorization = resolved.kind === "user"
      ? intersectAuthorization({ ...work.authorization, ...params.authorization }, resolved.grants)
      : intersectAuthorization({ ...work.authorization, ...params.authorization }, work.authorization);
    const nextInputSnapshotId = params.inputSnapshotId?.trim() || work.inputSnapshotId;
    const nextSources = params.goalSources === undefined ? work.goalSources : normalizeSources(params.goalSources, now);
    const hasNewCriteria = Array.isArray(params.criteria);
    const nextWatchRule = params.watchRule === undefined
      ? work.watchRule
      : normalizeWatchRule(params.watchRule) ?? work.watchRule;
    const sourceChanged = nextInputSnapshotId !== work.inputSnapshotId
      || JSON.stringify(nextSources) !== JSON.stringify(work.goalSources);
    if (sourceChanged && nextInputSnapshotId === work.inputSnapshotId) {
      return { ok: false, code: "invalid_request", message: "变更目标来源时必须提供新的输入快照身份" };
    }

    // Requirement identity changes only when the goal/constraints/criteria text or the
    // authorization changes. A target-input change bumps sourceVersion, not intentRevision.
    const candidateCriteria = hasNewCriteria
      ? this.mergeCriteria(work, params.criteria ?? [], work.intentRevision + 1, resolved, false)
      : work.criteria;
    if (typeof candidateCriteria === "string") return { ok: false, code: "invalid_request", message: candidateCriteria };
    const definition = (criterion: WorkCriterionDto) => [criterion.id, criterion.text, criterion.requiresRealEnvironmentCheck, criterion.requiredEnvironment ?? ""];
    const criteriaDefinitionsChanged = hasNewCriteria
      && JSON.stringify(candidateCriteria.map(definition)) !== JSON.stringify(work.criteria.map(definition));
    const requirementChanged = nextTitle !== work.title
      || nextDescription !== work.goalDescription
      || JSON.stringify(nextConstraints) !== JSON.stringify(work.constraints)
      || JSON.stringify(nextAuthorization) !== JSON.stringify(work.authorization)
      || criteriaDefinitionsChanged;
    const intentChanged = requirementChanged;
    const nextIntentRevision = intentChanged ? work.intentRevision + 1 : work.intentRevision;
    const nextSourceVersion = sourceChanged ? work.sourceVersion + 1 : work.sourceVersion;
    const nextStateVersion = work.stateVersion + 1;
    // Progress and other control facts bump stateVersion only. A second row at the
    // same requirement revision is stored only when the source version moves.
    const snapshotChanged = intentChanged || sourceChanged;
    const snapshotId = snapshotChanged
      ? `snap-${work.workId}-r${nextIntentRevision}-s${nextSourceVersion}`
      : work.activeIntentSnapshotId;
    let nextCriteria = sourceChanged
      ? this.resetCriteriaForNewInput({ ...work, criteria: candidateCriteria }, nextInputSnapshotId)
      : candidateCriteria;
    if (intentChanged) nextCriteria = nextCriteria.map(criterion => ({
      ...criterion, status: "pending", requiredIntentRevision: nextIntentRevision,
      verifiedIntentRevision: undefined, evidenceRefs: [], waivedReason: undefined, waivedByUserId: undefined,
    }));
    for (const input of params.criteria ?? []) {
      if (input.status !== "waived") continue;
      const criterion = nextCriteria.find(item => item.id === input.id);
      if (criterion && resolved.kind === "user") {
        criterion.status = "waived";
        criterion.waivedReason = input.waiveReason;
        criterion.waivedByUserId = resolved.userId;
      }
    }

    const nextWork: WorkDto = {
      ...work,
      title: nextTitle,
      goalDescription: nextDescription,
      constraints: nextConstraints,
      criteria: nextCriteria,
      authorization: nextAuthorization,
      intentRevision: nextIntentRevision,
      sourceVersion: nextSourceVersion,
      inputSnapshotId: nextInputSnapshotId,
      goalSources: nextSources,
      activeIntentSnapshotId: snapshotId,
      watchRule: nextWatchRule,
      progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
      stateVersion: nextStateVersion,
      updatedAt: now,
    };

    const invalidated = new Set(params.invalidateExecutionIds ?? []);
    if (intentChanged || sourceChanged) {
      for (const binding of this.repo.listBindings(work.workId)) {
        if (!TERMINAL_BINDING_STATUSES.has(binding.status)) invalidated.add(binding.bindingId);
      }
    }
    const invalidatedBindings: WorkExecutionBindingDto[] = [];
    for (const bindingId of invalidated) {
      const binding = this.repo.getBinding(bindingId);
      if (!binding || binding.workId !== work.workId) continue;
      if (binding.invalidatedAt) continue;
      const neverSubmitted = binding.status === "pending" && !binding.attemptId && !binding.submissionReceipt;
      const nextBinding: WorkExecutionBindingDto = {
        ...binding,
        invalidatedAt: now,
        status: neverSubmitted ? "invalidated" : binding.status,
        settledAt: neverSubmitted ? now : binding.settledAt,
      };
      this.repo.updateBinding(nextBinding);
      if (neverSubmitted && binding.reservationId) this.commitBudgetUsage(binding.workId, binding.reservationId, 0);
      invalidatedBindings.push(nextBinding);
    }
    nextWork.budget = this.repo.getWork(work.workId)!.budget;
    nextWork.activeExecutionIds = this.repo.listBindings(work.workId)
      .filter(binding => UNSETTLED_BINDING_STATUSES.has(binding.status)).map(binding => binding.bindingId);

    const ownerBot = this.bots.getBot(nextWork.ownerBotId);
    if (!ownerBot) return { ok: false, code: "not_found", message: "找不到负责人 Bot" };
    if (snapshotChanged) {
      this.repo.insertIntentSnapshot(this.intentSnapshot(nextWork, ownerBot, params.sourceMessageId, resolved.kind === "user" ? "user" : "bot"));
    }
    this.repo.supersedeStaleDeliverables(work.workId, nextIntentRevision, nextInputSnapshotId);
    nextWork.acceptedDeliverableIds = currentAcceptedDeliverableIds(
      nextWork, this.repo.listDeliverables(work.workId), this.repo.listBindings(work.workId),
    );
    this.repo.supersedeNotifications(work.workId, nextIntentRevision, nextInputSnapshotId);
    this.repo.updateWork(nextWork);
    if (params.watchRule !== undefined) this.syncSubscriptions(nextWork, now);
    const outboxEventId = this.outbox({
      work: nextWork, eventType: "work.amended", operationId: params.operationId,
      causalEventId: params.causalEventId,
      payload: {
        previousRevision: work.intentRevision, nextRevision: nextIntentRevision,
        previousSourceVersion: work.sourceVersion, nextSourceVersion,
        invalidatedExecutions: invalidatedBindings.map(binding => binding.bindingId),
      },
    });
    for (const binding of invalidatedBindings) {
      this.outbox({
        work: nextWork, eventType: "work.execution.stop_requested", operationId: params.operationId,
        bindingId: binding.bindingId, payload: { bindingId: binding.bindingId, reason: "requirement_changed" },
      });
    }
    return { ok: true, outboxEventId };
  }

  // ============================================================ lifecycle

  pauseWork(actor: WorkActor, params: PauseWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "pauseWork", params, { guard: "full", ownerOnly: true, allowLifecycles: ["active"] },
      (work, _resolved, now) => {
        const next: WorkDto = {
          ...work, lifecycle: "paused", stateVersion: work.stateVersion + 1, updatedAt: now,
        };
        this.repo.updateWork(next);
        this.resourceGate.cancelWaiting({ workId: work.workId });
        const outboxEventId = this.outbox({
          work: next, eventType: "work.paused", operationId: params.operationId,
          payload: { reason: params.reason, activeExecutionIds: work.activeExecutionIds },
        });
        return { ok: true, outboxEventId };
      });
  }

  resumeWork(actor: WorkActor, params: ResumeWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "resumeWork", params, { guard: "full", ownerOnly: true, allowLifecycles: ["paused"] },
      (work, _resolved, now) => {
        if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now) {
          return { ok: false, code: "unauthorized_actor", message: "Work 授权已过期，恢复前需要重新授权" };
        }
        const next: WorkDto = {
          ...work, lifecycle: "active", stateVersion: work.stateVersion + 1, updatedAt: now,
        };
        this.repo.updateWork(next);
        this.pausedBacklog.resume(next, now);
        const outboxEventId = this.outbox({
          work: next, eventType: "work.resumed", operationId: params.operationId,
          payload: { pendingEvents: this.repo.listInbox(work.workId).length },
        });
        return { ok: true, outboxEventId };
      });
  }

  continueWork(actor: WorkActor, params: ContinuationWorkParams): WorkControlResult {
    const parsed = continuationWorkSchema.safeParse(params);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "缺口补跑请求无效" };
    return this.runWorkControl(actor, "continueWork", parsed.data, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active"],
    }, (work, _resolved, now) => this.partialResults.continue(work, parsed.data, now));
  }

  cancelWork(actor: WorkActor, params: CancelWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "cancelWork", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => this.applyCancellation(work, params, now));
  }

  private applyCancellation(work: WorkDto, params: { operationId: string; reason?: string }, now: number): Mutation {
    this.resourceGate.cancelWaiting({ workId: work.workId });
    let next = work;
    if (work.lifecycle !== "closed" && work.lifecycle !== "closing") {
      next = {
        ...work,
        lifecycle: "closing",
        pendingConclusion: "cancelled",
        cancelRequestedAt: now,
        closureSummary: params.reason ?? work.closureSummary,
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      };
      this.repo.updateWork(next);
      this.notifications.supersede(work.workId, "cancelled");
      this.outbox({
        work: next, eventType: "work.cancel_requested", operationId: params.operationId,
        payload: { reason: params.reason, activeExecutionIds: next.activeExecutionIds },
      });
      for (const binding of this.repo.listBindings(next.workId)) {
        if (UNSETTLED_BINDING_STATUSES.has(binding.status)) {
          this.outbox({
            work: next, eventType: "work.execution.stop_requested", operationId: params.operationId,
            bindingId: binding.bindingId, payload: { bindingId: binding.bindingId, reason: "cancel_requested" },
          });
        }
      }
    }
    const settled = this.tryCloseSettled(next, now);
    return { ok: true, outboxEventId: settled.ok ? settled.outboxEventId : undefined };
  }

  closeWork(actor: WorkActor, params: CloseWorkParams): WorkControlResult {
    const artifactInspection = params.conclusion === "succeeded" ? this.artifacts.capture(params.workId) : undefined;
    return this.runWorkControl(actor, "closeWork", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => {
      if (artifactInspection && !this.artifacts.validate(artifactInspection, now)) {
        this.emitCurrentProjection(work.workId);
        return { ok: false, code: "version_conflict", message: "产物版本发生变化，已保留历史成果并重新打开相关验收项" };
      }

      if (work.lifecycle === "closed") {
        return {
          ok: false, code: "invalid_lifecycle_transition",
          message: `事项已关闭（${work.closureConclusion ?? "已结束"}），普通关闭请求不能改写终局结论`,
        };
      }
      if (params.conclusion === "cancelled") {
        return this.applyCancellation(work, { operationId: params.operationId, reason: params.closureSummary }, now);
      }
      if (params.conclusion === "ended_unsuccessfully" && !params.closureSummary?.trim()) {
        return { ok: false, code: "invalid_request", message: "以未达成结束时必须记录停止依据与缺口" };
      }
      if (params.conclusion === "succeeded") {
        if (work.mode === "watch" && (resolvedIsBot(_resolved) || !work.watchRule?.stopConditionText || !params.closureSummary?.trim())) {
          return { ok: false, code: "unmet_acceptance_criteria", message: "持续关注的一轮成果不结束职责；履行停止条件后须由可信入口记录结束依据" };
        }
        if (work.lifecycle !== "active") {
          return { ok: false, code: "invalid_lifecycle_transition", message: "只有进行中的事项可以按完成关闭" };
        }
        const gaps = this.partialResults.gaps(work.workId);
        if (gaps.length) return { ok: false, code: "unmet_acceptance_criteria", message: `必要子项仍有未覆盖缺口，不能按完成关闭：${gaps.slice(0, 10).map(item => `${item.task || item.itemId}（${item.outcome}）：${item.summary || "缺少完成凭据"}`).join("；")}${gaps.length > 10 ? `；另有 ${gaps.length - 10} 项，请查看必要子项缺口列表` : ""}` };
        const unmet = work.criteria.find((criterion) => !isCriterionResolved(criterion));
        if (unmet) {
          return {
            ok: false, code: "unmet_acceptance_criteria",
            message: `验收条件尚未在当前要求下满足：${unmet.text}`,
          };
        }
        const openBlockers = this.repo.listOpenBlockers(work.workId);
        if (openBlockers.length > 0) {
          return { ok: false, code: "unmet_acceptance_criteria", message: `仍存在未解除阻碍：${openBlockers[0].reason}` };
        }
        if (!this.isSettled(work)) {
          return {
            ok: false, code: "unsettled_effects",
            message: "仍有在途执行或未核对的外部效果，不能按完成关闭",
          };
        }
        return this.closeWithConclusion(work, "succeeded", params, now);
      }
      // ended_unsuccessfully: settle first, then close.
      this.resourceGate.cancelWaiting({ workId: work.workId });
      this.clearStoppedExecutionBlockers(work.workId, now);
      if (this.isSettled(work)) {
        return this.closeWithConclusion(work, "ended_unsuccessfully", params, now);
      }
      const next: WorkDto = {
        ...work, lifecycle: "closing", pendingConclusion: "ended_unsuccessfully",
        closureSummary: params.closureSummary, stateVersion: work.stateVersion + 1, updatedAt: now,
      };
      this.repo.updateWork(next);
      this.outbox({
        work: next, eventType: "work.cancel_requested", operationId: params.operationId,
        payload: { reason: params.closureSummary, conclusion: "ended_unsuccessfully" },
      });
      return { ok: true };
    });
  }

  /** Only system-owned blockers for future execution become moot when stopping.
   * Unknown usage/effects and reconciliation conflicts must still be settled. */
  private clearStoppedExecutionBlockers(workId: string, now: number): void {
    this.approvals.retireForStop(workId);
    for (const binding of this.repo.listBindings(workId)) {
      const blocker = this.repo.getBlocker(`continuation:${binding.bindingId}`);
      if (blocker?.kind === "operational" && !blocker.unknownExternalEffectRef) this.repo.clearBlocker(blocker.blockerId, workId, now);
    }
    const budget = this.repo.getBlocker(`budget:exhausted:${workId}`);
    if (budget?.kind === "operational" && budget.reasonCode === "budget-exhausted" && !budget.unknownExternalEffectRef) {
      this.repo.clearBlocker(budget.blockerId, workId, now);
    }
  }

  private closeWithConclusion(
    work: WorkDto,
    conclusion: WorkDto["closureConclusion"],
    params: { operationId: string; closureSummary?: string },
    now: number,
  ): Mutation {
    const next: WorkDto = {
      ...work,
      lifecycle: "closed",
      closureConclusion: conclusion,
      pendingConclusion: undefined,
      closureSummary: params.closureSummary ?? work.closureSummary,
      closedAt: now,
      closeOperationId: params.operationId,
      activeExecutionIds: [],
      stateVersion: work.stateVersion + 1,
      updatedAt: now,
    };
    this.repo.updateWork(next);
    this.repo.stopSubscriptionsForWork(work.workId, now);
    const outboxEventId = this.outbox({
      work: next, eventType: "work.closed", operationId: params.operationId,
      payload: { conclusion, closureSummary: next.closureSummary, closedAt: now },
    });
    const card = this.phase5.recordClosure(next, conclusion ?? "ended_unsuccessfully", now);
    if (!card.suppressNotification) this.repo.insertNotification({
      notificationId: newId("notification"),
      workId: work.workId,
      semanticKey: `work:${work.workId}:closed:${conclusion}`,
      kind: "closed",
      title: `事项已结束：${work.title}`,
      body: conclusion === "succeeded" ? "验收条件已满足" : next.closureSummary,
      stateVersion: next.stateVersion,
      intentRevision: next.intentRevision,
      delivery: "pending",
      createdAt: now,
      attemptCount: 0,
      cardKey: card.cardKey,
    });
    return { ok: true, outboxEventId };
  }

  /** Called by the trusted recovery coordinator within the Work transaction. */
  finalizeRecoveredResource(lease: ResourceLease): void {
    this.transaction(() => {
      const denied = this.authorityError(); if (denied) throw new Error(denied.message);
      finalizeWorkResource({ db: this.db, service: this, lease, now: this.now,
        tryClose: (work, now) => this.tryCloseSettled(work, now) });
    });
  }

  /** Closing work may only finish when no execution, admission, blocker or unknown effect remains. */
  private isSettled(work: WorkDto): boolean {
    if (this.resourceGate.live().some(lease => lease.owner.workId === work.workId)) return false;
    const bindings = this.repo.listBindings(work.workId);
    if (bindings.some((binding) => UNSETTLED_BINDING_STATUSES.has(binding.status))) return false;
    // Provider requests can reserve independently of an execution binding.
    if (this.repo.listReservations(work.workId).some(reservation => reservation.state === "reserved" || reservation.state === "unknown")) return false;
    const admissions = this.repo.listAdmissions(work.workId);
    if (admissions.some((admission) => admission.state === "admitted" || admission.state === "unknown")) return false;
    if (this.repo.listOpenBlockers(work.workId).length > 0) return false;
    return true;
  }

  private tryCloseSettled(work: WorkDto, now: number): Mutation {
    if (work.lifecycle !== "closing" || !work.pendingConclusion) return { ok: true };
    if (work.pendingConclusion === "cancelled" || work.pendingConclusion === "ended_unsuccessfully") {
      this.clearStoppedExecutionBlockers(work.workId, now);
    }
    if (!this.isSettled(work)) return { ok: true };
    return this.closeWithConclusion(work, work.pendingConclusion, {
      operationId: `settle-${work.workId}-${work.stateVersion}`,
      closureSummary: work.closureSummary,
    }, now);
  }

  // ============================================================ delegation

  prepareResourceEffect = (actor: WorkActor, params: PrepareResourceEffectParams): WorkControlResult =>
    runPrepareResourceEffectControl(actor, params, this.db, this.resourceGate, this.repo, this.runWorkControl.bind(this), this.outbox.bind(this));
  reconcileResourceEffect = (actor: WorkActor, params: ReconcileResourceEffectParams): WorkControlResult =>
    runResourceEffectReviewControl(actor, params, this.db, this.resourceGate, this.repo, this.runWorkControl.bind(this), this.outbox.bind(this));

  retryResourceRecovery = (actor: WorkActor, params: RetryResourceRecoveryParams): WorkControlResult =>
    runResourceRecoveryControl(actor, params, this.db, this.resourceGate, this.repo, this.runWorkControl.bind(this), this.outbox.bind(this));

  handoffOwner(actor: WorkActor, params: HandoffOwnerParams): WorkControlResult {
    return this.runWorkControl(actor, "handoffOwner", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"],
    }, (work, _resolved, now) => {
      const target = this.bots.getBot(params.targetBotId);
      if (!target) return { ok: false, code: "not_found", message: "找不到目标 Bot" };
      if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "目标 Bot 不属于该事项用户" };
      if (target.status !== "active") return { ok: false, code: "bot_disabled", message: "目标 Bot 已停用" };
      if (!work.authorization.allowRedelegation) {
        return { ok: false, code: "unauthorized_actor", message: "事项授权不允许转交负责" };
      }
      const scopeError = this.collaboration.handoffError(work, params.targetBotId);
      if (scopeError || params.delegatedScope?.some(scope => !work.authorization.allowedScopes.includes(scope)))
        return { ok: false, code: "unauthorized_actor", message: scopeError ?? "交接范围超出授权" };
      const preparationId = params.preparationId ?? this.collaboration.prepareHandoff(actor, work.workId, params.targetBotId).preparationId;
      const preparationError = this.collaboration.preparationError(preparationId, work, params.targetBotId);
      if (preparationError) return { ok: false, code: "version_conflict", message: preparationError };
      this.repo.upsertParticipant({
        workId: work.workId, botId: target.botId, role: "collaborator",
        delegatedScope: params.delegatedScope ?? [], expertSnapshot: this.snapshotOf(target), addedAt: now,
      });
      const next: WorkDto = {
        ...work,
        ownerBotId: target.botId,
        ownerEpoch: work.ownerEpoch + 1,
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      };
      this.repo.updateWork(next);
      this.collaboration.commitHandoffFacts(work, next, params.operationId, now);
      this.phase5.refreshSummary(work.workId);
      const outboxEventId = this.outbox({
        work: this.repo.getWork(work.workId)!, eventType: "work.owner_handed_off", operationId: params.operationId,
        payload: {
          previousOwnerBotId: work.ownerBotId, newOwnerBotId: target.botId,
          previousEpoch: work.ownerEpoch, newEpoch: next.ownerEpoch,
        },
      });
      return { ok: true, outboxEventId };
    });
  }

  addParticipant(actor: WorkActor, params: AddParticipantParams): WorkControlResult {
    return this.runWorkControl(actor, "addParticipant", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"],
    }, (work, _resolved, now) => {
      const target = this.bots.getBot(params.botId);
      if (!target) return { ok: false, code: "not_found", message: "找不到目标 Bot" };
      if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "目标 Bot 不属于该事项用户" };
      if (!work.authorization.allowRedelegation) {
        return { ok: false, code: "unauthorized_actor", message: "事项授权不允许新增委派" };
      }
      if (work.participants.length >= WORK_MAX_PARTICIPANTS) {
        return { ok: false, code: "invalid_request", message: "参与者数量已达上限" };
      }
      this.repo.upsertParticipant({
        workId: work.workId, botId: target.botId, role: params.role ?? "worker",
        delegatedScope: params.delegatedScope ?? [], expertSnapshot: this.snapshotOf(target), addedAt: now,
      });
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      const outboxEventId = this.outbox({
        work: next, eventType: "work.participant_added", operationId: params.operationId,
        payload: { botId: target.botId, role: params.role ?? "worker" },
      });
      return { ok: true, outboxEventId };
    });
  }

  // ============================================================ executions

  checkTaskInput(taskId: string, operationId: string): string | undefined {
    const binding = this.repo.bindingForTask(taskId);
    if (!binding) return undefined;
    const work = this.repo.getWork(binding.workId);
    if (this.authorityError() || !work || work.lifecycle !== "active" || binding.invalidatedAt
      || binding.operationId !== operationId || binding.intentRevision !== work.intentRevision
      || binding.inputSnapshotId !== work.inputSnapshotId || this.bots.getBot(binding.botId)?.status !== "active"
      || this.bots.getBot(work.ownerBotId)?.status !== "active"
      || (work.budget.windowExpiresAt !== undefined && work.budget.windowExpiresAt <= this.now())
      || (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= this.now())) {
      return "Work 当前状态不允许新的业务输入；原提交仍可查回和停止";
    }
    return undefined;
  }

  admitTaskAction(taskId: string, input: { operationId: string; actionKind: string }): string | undefined {
    const binding = this.repo.bindingForTask(taskId);
    if (!binding) return undefined;
    const admitted = this.admitNewAction({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
      ...input, admissionId: input.operationId, workId: binding.workId, bindingId: binding.bindingId,
    });
    return admitted.ok ? undefined : admitted.message;
  }

  settleTaskAction(taskId: string, operationId: string, outcome: "consumed" | "released" | "unknown"): void {
    this.transaction(() => {
      const binding = this.repo.bindingForTask(taskId);
      if (!binding) return;
      const admission = this.repo.listAdmissions(binding.workId).find(item => item.operationId === operationId);
      if (admission && admission.state === "admitted") this.settleAdmission(admission.admissionId, outcome);
      this.approvals.settleAction(taskId, operationId, outcome);
    });
  }

  /**
   * Phase 2 dependency #1: dispatch persists the immutable namespace before any
   * business input is submitted. Recovery instructions are NOT filtered by lifecycle;
   * only new business admission is.
   */
  dispatchExecution(actor: WorkActor, params: DispatchExecutionParams): WorkControlResult {
    return this.runWorkControl(actor, "dispatchExecution", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active"],
    }, (work, _resolved, now) => {
      if (!params.taskId?.trim() || !params.durableStoreKey?.trim() || !params.conversationId?.trim()) {
        return { ok: false, code: "invalid_request", message: "执行绑定必须包含 task、Durable 存储与接收 conversation 身份" };
      }
      if (this.bots.getBot(work.ownerBotId)?.status !== "active") {
        return { ok: false, code: "bot_disabled", message: "主负责人已停用，不能启动新执行" };
      }
      const existing = this.repo.getBindingByOperation(work.workId, params.operationId);
      if (existing) {
        if (existing.taskId !== params.taskId || existing.durableStoreKey !== params.durableStoreKey
          || existing.conversationId !== params.conversationId) {
          return { ok: false, code: "idempotency_conflict", message: "重试不能重新分配 task、存储命名空间或 conversation" };
        }
        return { ok: true };
      }
      const teamError = this.teams.dispatchError(work.workId, params.taskId, params.botId, params.delegatedScope);
      if (teamError) return { ok: false, code: "unauthorized_actor", message: teamError };
      const occupied = this.repo.bindingForTask(params.taskId);
      if (occupied && (occupied.workId !== work.workId || occupied.botId !== params.botId)) {
        return { ok: false, code: "invalid_request", message: "执行 Task 已属于另一事项或 Bot，不能复用其上下文" };
      }
      if (occupied && UNSETTLED_BINDING_STATUSES.has(occupied.status)) {
        return { ok: false, code: "unsettled_effects", message: "该 task 已绑定未结算执行，不能同时承接另一次派发" };
      }
      if (!this.authorizedFor(work, params.delegatedScope?.every(scope => scope === "workspace:read") ? "workspace:read" : "workspace:write")) {
        return { ok: false, code: "unauthorized_actor", message: "事项授权未包含工作区写入范围" };
      }
      const target = this.bots.getBot(params.botId);
      if (!target) return { ok: false, code: "not_found", message: "找不到执行 Bot" };
      if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "执行 Bot 不属于该事项用户" };
      if (target.status !== "active") return { ok: false, code: "bot_disabled", message: "执行 Bot 已停用" };
      if (!work.inputSnapshotId || work.inputSnapshotId === "snapshot:unbound") {
        return { ok: false, code: "invalid_request", message: "启动执行前必须绑定可追溯的输入快照" };
      }
      const inboxEvent = params.inboxEventId ? this.repo.getInbox(params.inboxEventId) : undefined;
      if (inboxEvent && inboxEvent.workId !== work.workId) return { ok: false, code: "invalid_request", message: "派发引用了另一事项的事件" };
      if (params.causal) {
        const admission = this.causal.admit({ workId: work.workId, subscriptionId: inboxEvent?.subscriptionId ?? undefined,
          source: params.causal.source, sourceEventId: params.causal.sourceEventId,
          causalEventId: params.causal.causalEventId, parentChainId: params.causal.parentChainId,
          originWorkId: work.workId, inputSnapshotId: work.inputSnapshotId,
          actionKind: params.causal.actionKind ?? "dispatch", operationId: params.operationId,
          trustedRoot: params.causal.trustedRoot, budgetAvailable: this.budget.availableTokens(work.workId)! > 0 });
        if (!admission.allowed) return { ok: false, code: "causal_guard", message: admission.message ?? "因果链已触限" };
      }
      const readOnlyFollowUp = inboxEvent?.eventType === "deadline_expired"
        || (inboxEvent?.payload.readOnlyFollowUp === true && inboxEvent?.eventType === "work.offline_catchup");
      const delegatedScope = readOnlyFollowUp ? ["workspace:read"] as string[] : params.delegatedScope ?? [...work.authorization.allowedScopes];
      const reservationOutcome = params.reserveTokens && params.reserveTokens > 0
        ? this.reserveBudgetInternal(work, newId("budget"), params.reserveTokens, now)
        : undefined;
      if (typeof reservationOutcome === "string") {
        return { ok: false, code: "budget_exhausted", message: reservationOutcome };
      }
      const reservation = reservationOutcome as WorkBudgetReservationDto | undefined;
      const binding: WorkExecutionBindingDto = {
        bindingId: newId("binding"),
        workId: work.workId,
        operationId: params.operationId,
        botId: target.botId,
        taskId: params.taskId,
        durableStoreKey: params.durableStoreKey,
        conversationId: params.conversationId,
        intentRevision: work.intentRevision,
        ownerEpoch: work.ownerEpoch,
        inputSnapshotId: work.inputSnapshotId,
        expertSnapshot: this.snapshotOf(target),
        delegatedScope,
        workspaceBinding: params.workspaceBinding,
        reservationId: reservation?.reservationId,
        inboxEventId: params.inboxEventId,
        status: "pending",
        admittedAt: now,
      };
      this.repo.insertBinding(binding);
      const next: WorkDto = {
        ...work,
        budget: this.repo.getWork(work.workId)!.budget,
        activeExecutionIds: [...new Set([...work.activeExecutionIds, binding.bindingId])],
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      };
      this.repo.updateWork(next);
      const outboxEventId = this.outbox({
        work: next, eventType: "work.execution.dispatch_requested", operationId: params.operationId,
        bindingId: binding.bindingId,
        payload: {
          bindingId: binding.bindingId, taskId: binding.taskId, durableStoreKey: binding.durableStoreKey,
          conversationId: binding.conversationId, botId: binding.botId, intentRevision: binding.intentRevision,
          reservationId: reservation?.reservationId,
        },
      });
      return { ok: true, outboxEventId };
    });
  }

  /** Allowed regardless of lifecycle: it is recovery of an already-attempted submission. */
  markDispatchAttempt(bindingId: string, attemptId: string): { ok: boolean; message?: string } {
    const binding = this.repo.getBinding(bindingId);
    if (!binding) return { ok: false, message: "找不到执行绑定" };
    this.transaction(() => {
      this.repo.updateBinding({ ...binding, attemptId, status: binding.status === "pending" ? "submitted" : binding.status });
      const instruction = this.repo.listOutbox(binding.workId, ["pending", "attempted"])
        .find(item => item.bindingId === bindingId && item.eventType === "work.execution.dispatch_requested");
      if (instruction) this.repo.markOutboxAttempt(instruction.eventId, attemptId);
    });
    return { ok: true };
  }

  /** Saves the native submission receipt while still in the original namespace. */
  recordSubmissionReceipt(bindingId: string, submissionReceipt: string): { ok: boolean; message?: string } {
    const binding = this.repo.getBinding(bindingId);
    if (!binding) return { ok: false, message: "找不到执行绑定" };
    this.transaction(() => {
      this.repo.updateBinding({
        ...binding, submissionReceipt, status: binding.status === "pending" ? "submitted" : binding.status,
        submittedAt: binding.submittedAt ?? this.now(),
      });
      const instruction = this.repo.listOutbox(binding.workId, ["pending", "attempted"])
        .find(item => item.bindingId === bindingId && item.eventType === "work.execution.dispatch_requested");
      if (instruction) this.repo.markOutboxDelivered(instruction.eventId, this.now());
    });
    return { ok: true };
  }

  /**
   * Settlement / stop read-back. This entry point is deliberately outside the
   * "no new business" filter: a cancelled work still has to reconcile what it started.
   */
  reconcileExecution(actor: WorkActor, params: ReconcileExecutionParams): WorkControlResult {
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    return this.transaction((): WorkControlResult => {
      const binding = this.repo.getBinding(params.bindingId);
      if (!binding) return { ok: false, code: "not_found", message: "找不到执行绑定" };
      const work = this.repo.getWork(binding.workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (resolved.kind !== "system") {
        if (resolved.kind === "worker") {
          if (resolved.binding?.bindingId !== binding.bindingId) {
            return { ok: false, code: "unauthorized_actor", message: "worker 只能结算自己的执行" };
          }
        } else if (work.userId !== resolved.userId) {
          return { ok: false, code: "not_found", message: "找不到 Work" };
        } else if (resolved.kind === "bot" && resolved.bot?.botId !== work.ownerBotId) {
          return { ok: false, code: "unauthorized_actor", message: "只有当前负责人可以结算执行" };
        }
      }
      const authorityError = this.authorityError();
      if (authorityError) return authorityError;
      return settleWorkExecution({ repo: this.repo, work, binding, params, now: this.now(),
        commitUsage: (reservation, tokens, now) => this.commitBudgetInternal(work, reservation, tokens, now),
        tryClose: (next, now) => this.tryCloseSettled(next, now) });
    });
  }

  /** New business side effect admission. Blocked in paused/closing/closed. */
  admitNewAction(actor: WorkActor, params: AdmitActionParams): { ok: true; admission: WorkAdmissionDto } | Fail {
    const authorityError = this.authorityError();
    if (authorityError) return authorityError;
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    return this.transaction((): { ok: true; admission: WorkAdmissionDto } | Fail => {
      const authorityError = this.authorityError();
      if (authorityError) return authorityError;
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(params.workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      const access = this.requireAccess(work, resolved);
      if (access) return access;
      const guardError = this.checkGuard(work, resolved, params.versionGuard, "full");
      if (guardError) return guardError;
      if (work.lifecycle !== "active") {
        return { ok: false, code: "invalid_lifecycle_transition", message: `事项处于 ${work.lifecycle}，拒绝新的业务动作` };
      }
      if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= this.now()) {
        return { ok: false, code: "unauthorized_actor", message: "事项授权已过期" };
      }
      if (this.bots.getBot(work.ownerBotId)?.status !== "active") {
        return { ok: false, code: "bot_disabled", message: "主负责人已停用，不能准入新业务动作" };
      }
      const scopedApproval = !!resolved.binding && this.approvals.permits(resolved.binding.bindingId, params.operationId, params.actionKind);
      if (!this.authorizedFor(work, params.actionKind) && !scopedApproval) {
        return { ok: false, code: "unauthorized_actor", message: `事项授权不允许动作 ${params.actionKind}` };
      }
      if (work.budget.windowExpiresAt !== undefined && work.budget.windowExpiresAt <= this.now()) {
        return { ok: false, code: "budget_exhausted", message: "预算期限已到，拒绝新的业务动作" };
      }
      // A worker's execution identity comes from the host actor, including when
      // the business payload omits bindingId. Never turn that omission into an
      // unbound admission that skips the current execution/delegation checks.
      const bindingId = params.bindingId ?? resolved.binding?.bindingId;
      if (bindingId) {
        const binding = this.repo.getBinding(bindingId);
        if (!binding || binding.workId !== work.workId) {
          return { ok: false, code: "not_found", message: "找不到有效执行绑定" };
        }
        if (binding.invalidatedAt || TERMINAL_BINDING_STATUSES.has(binding.status)) {
          return { ok: false, code: "version_conflict", message: "执行绑定已失效或被停止" };
        }
        if (binding.intentRevision !== work.intentRevision) {
          return { ok: false, code: "version_conflict", message: "执行绑定基于旧要求，拒绝新的业务副作用" };
        }
        if (binding.inputSnapshotId !== work.inputSnapshotId) {
          return { ok: false, code: "version_conflict", message: "执行绑定基于旧输入快照，拒绝新的业务副作用" };
        }
        if (!this.collaboration.isDelegationAdopted(binding, work)) {
          return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管原执行委派" };
        }
        if (resolved.kind === "worker" && resolved.binding?.bindingId !== binding.bindingId) {
          return { ok: false, code: "unauthorized_actor", message: "worker 只能为自己的绑定申请业务动作" };
        }
        if (this.bots.getBot(binding.botId)?.status !== "active") {
          return { ok: false, code: "bot_disabled", message: "执行 Bot 已暂停或停用，不能准入新业务动作" };
        }
        if (binding.delegatedScope.length > 0 && !binding.delegatedScope.includes(params.actionKind) && !scopedApproval) {
          return { ok: false, code: "unauthorized_actor", message: "业务动作超出了本执行的委派范围" };
        }
      }
      const existing = this.repo.listAdmissions(work.workId).find(item => item.operationId === params.operationId);
      if (existing) return { ok: true, admission: existing };
      const now = this.now();
      const admission: WorkAdmissionDto = {
        admissionId: newId("admission"),
        workId: work.workId,
        bindingId,
        operationId: params.operationId,
        actionKind: params.actionKind,
        state: "admitted",
        intentRevision: work.intentRevision,
        ownerEpoch: work.ownerEpoch,
        admittedAt: now,
      };
      this.repo.insertAdmission(admission);
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      return { ok: true, admission };
    });
  }

  settleAdmission(admissionId: string, outcome: "consumed" | "released" | "unknown", note?: string): { ok: boolean; message?: string } {
    return this.transaction(() => settleWorkAdmission({ repo: this.repo, admissionId, outcome, note, now: this.now(),
      tryClose: (work, now) => this.tryCloseSettled(work, now) }));
  }

  // ============================================================ deliverables

  /** Host-only verifier callback. Worker claims never enter this path via tools/IPC. */
  verifyExecutionEvidence(bindingId: string, input: {
    criterionIds: string[]; sourceRef: string; kind: "automated_test" | "tool_receipt" | "inspection";
    verify: () => { passed: boolean; detail: string; sourceSha?: string; environment?: string };
  }): WorkEvidenceDto {
    const binding = this.repo.getBinding(bindingId);
    if (!binding || !input.sourceRef.trim()) throw new Error("核验证据缺少执行绑定或来源");
    const result = input.verify();
    if (!result.passed) throw new Error("宿主核验未通过，不能产生通过证据");
    return this.transaction(() => {
      const evidence: WorkEvidenceDto = { evidenceId: newId("evidence"), workId: binding.workId,
        executionId: binding.bindingId, criterionIds: [...input.criterionIds], kind: input.kind,
        provenance: "system", sourceRef: input.sourceRef, sourceSha: result.sourceSha,
        inputSnapshotId: binding.inputSnapshotId, intentRevision: binding.intentRevision,
        detail: result.detail, environment: result.environment, recordedAt: this.now() };
      this.repo.insertEvidence(evidence);
      return evidence;
    });
  }

  submitDeliverable(actor: WorkActor, params: SubmitDeliverableParams): WorkControlResult {
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    const invalid = this.validatePayload("submitDeliverable", params);
    if (invalid) return invalid;
    const payloadHash = this.hash("submitDeliverable", params);
    const outcome = this.transaction((): WorkControlResult => {
      const work = this.repo.getWork(params.workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      const access = this.requireAccess(work, resolved);
      if (access) return access;
      const receipt = this.repo.getReceipt(resolved.userId, params.operationId);
      if (receipt) {
        if (receipt.operation_type !== "submitDeliverable" || receipt.payload_hash !== payloadHash) {
          return { ok: false, code: "idempotency_conflict", message: "同一操作 ID 被用于不同成果提交" };
        }
        return {
          ok: true, replayed: true, operationId: params.operationId,
          work, outboxEventId: receipt.outbox_event_id ?? undefined,
        };
      }
      const binding = this.repo.getBinding(params.bindingId);
      if (!binding || binding.workId !== work.workId) {
        return { ok: false, code: "unauthorized_actor", message: "提交成果必须绑定本事项的有效执行" };
      }
      if (resolved.kind === "worker" && resolved.binding?.bindingId !== binding.bindingId) {
        return { ok: false, code: "unauthorized_actor", message: "worker 只能提交自己执行的成果" };
      }
      if (resolved.kind === "bot" && resolved.bot?.botId !== binding.botId && resolved.bot?.botId !== work.ownerBotId) {
        return { ok: false, code: "unauthorized_actor", message: "该 Bot 没有这次执行的委派" };
      }
      const pendingAdoption = this.collaboration.isDelegationPending(binding, work);
      if (pendingAdoption && (work.lifecycle === "active" || work.lifecycle === "paused")) {
        return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管此执行委派；接管后可重试成果提交，当前输入未作废" };
      }
      // A late result from an invalidated/unknown execution is still recorded, but with
      // the binding's own revision/snapshot as a historical deliverable (R04/R06).
      const now = this.now();
      const stale = pendingAdoption || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
        || binding.invalidatedAt !== undefined || binding.status === "invalidated";
      const deliverableId = params.deliverableId?.trim() || newId("deliverable");
      const evidenceIds: string[] = [];
      const evidenceRows: WorkEvidenceDto[] = [];
      for (const input of params.evidence ?? []) {
        if (!EXECUTION_EVIDENCE_KINDS.has(input.kind) || input.kind === "real_environment") {
          return { ok: false, code: "invalid_request", message: "执行结果只能记录自动化/工具/检查类证据，实测反馈必须由用户或宿主提供" };
        }
        if (!input.sourceRef?.trim()) {
          return { ok: false, code: "invalid_request", message: "证据必须带可追溯来源" };
        }
        const evidenceId = newId("evidence");
        evidenceIds.push(evidenceId);
        evidenceRows.push({
          evidenceId,
          workId: work.workId,
          deliverableId,
          executionId: binding.bindingId,
          criterionIds: input.criterionIds ?? [],
          kind: input.kind,
          provenance: "execution",
          sourceRef: input.sourceRef,
          sourceSha: input.sourceSha,
          inputSnapshotId: binding.inputSnapshotId,
          environment: input.environment,
          intentRevision: binding.intentRevision,
          detail: input.detail,
          recordedAt: now,
        });
      }
      const deliverable: WorkDeliverableDto = {
        deliverableId,
        workId: work.workId,
        producerBotId: binding.botId,
        executionId: binding.bindingId,
        intentRevision: binding.intentRevision,
        ownerEpoch: binding.ownerEpoch,
        inputSnapshotId: binding.inputSnapshotId,
        status: stale ? "superseded" : "proposed",
        summary: params.summary.trim().slice(0, 2000),
        artifactRefs: normalizeTexts(params.artifactRefs),
        evidenceRefs: evidenceIds,
        uncoveredScope: normalizeTexts(params.uncoveredScope),
        uncoveredCriterionIds: params.uncoveredCriterionIds
          ?? (params.hasWriteConflicts ? work.criteria.map(criterion => criterion.id) : []),
        isSpeculation: Boolean(params.isSpeculation),
        hasWriteConflicts: Boolean(params.hasWriteConflicts),
        createdAt: now,
      };
      this.repo.insertDeliverable(deliverable);
      for (const evidence of evidenceRows) this.repo.insertEvidence(evidence);
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      const outboxEventId = this.outbox({
        work: next, eventType: stale ? "work.deliverable_historical" : "work.deliverable_proposed",
        operationId: params.operationId, bindingId: binding.bindingId,
        payload: { deliverableId, intentRevision: binding.intentRevision, stale },
      });
      this.repo.saveReceipt({
        userId: resolved.userId, operationId: params.operationId, workId: work.workId,
        operationType: "submitDeliverable", payloadHash, workSnapshot: next, outboxEventId, now,
      });
      return { ok: true, replayed: false, operationId: params.operationId, work: next, outboxEventId };
    });
    if (outcome.ok && !outcome.replayed) this.emitCurrentProjection(outcome.work.workId);
    return outcome;
  }

  acceptDeliverable(actor: WorkActor, params: AcceptDeliverableParams): WorkControlResult {
    const artifactInspection = this.artifacts.capture(params.workId);
    return this.runWorkControl(actor, "acceptDeliverable", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused", "closing"],
    }, (work, resolved, now) => {
      if (!this.artifacts.validate(artifactInspection, now)) {
        this.emitCurrentProjection(work.workId);
        return { ok: false, code: "version_conflict", message: "产物版本发生变化，已保留历史成果并重新打开相关验收项" };
      }

      if (!this.isOwnerOrUser(work, resolved)) {
        return { ok: false, code: "unauthorized_actor", message: "仅当前主负责人或用户可验收成果" };
      }
      const deliverable = this.repo.getDeliverable(params.deliverableId);
      if (!deliverable || deliverable.workId !== work.workId) {
        return { ok: false, code: "not_found", message: "找不到成果记录" };
      }
      if (deliverable.status === "superseded") return { ok: false, code: "version_conflict", message: "历史成果需要重新核验，不能直接验收" };
      if (deliverable.status === "accepted") {
        return { ok: false, code: "invalid_request", message: "成果已采纳；重试请使用原操作 ID" };
      }
      if (deliverable.isSpeculation) {
        return { ok: false, code: "speculation_not_acceptable", message: "未经确认的推测不能成为已确认事实" };
      }
      if (deliverable.hasWriteConflicts && !params.partialAcceptance) {
        return { ok: false, code: "unmet_acceptance_criteria", message: "成果包含被阻止的必需写入，补齐前不能验收" };
      }
      if (params.partialAcceptance && (!params.partialAcceptance.reason?.trim()
        || (params.criterionUpdates ?? []).some(update => !params.partialAcceptance!.criterionIds.includes(update.criterionId)))) {
        return { ok: false, code: "invalid_request", message: "部分采纳必须记录依据，且只能核验明确覆盖的验收项" };
      }
      const binding = this.repo.getBinding(deliverable.executionId);
      if (!binding || binding.workId !== work.workId) {
        return { ok: false, code: "not_found", message: "成果缺少有效执行来源" };
      }
      if (binding.invalidatedAt || binding.status === "invalidated") {
        return { ok: false, code: "version_conflict", message: "执行已被新要求失效，不能按当前成果验收" };
      }
      if (!this.collaboration.isDelegationAdopted(binding, work)) {
        return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管此执行委派，不能验收成果" };
      }
      if (deliverable.intentRevision !== work.intentRevision) {
        return {
          ok: false, code: "version_conflict",
          message: `成果基于要求 r${deliverable.intentRevision}，当前为 r${work.intentRevision}；保留为历史证据`,
        };
      }
      if (deliverable.inputSnapshotId !== work.inputSnapshotId) {
        return {
          ok: false, code: "version_conflict",
          message: "成果基于旧的输入快照，不能确认当前目标",
        };
      }
      const waivers = new Map((params.waivers ?? []).map((waiver) => [waiver.criterionId, waiver]));
      if (waivers.size > 0 && resolved.kind !== "user") {
        return { ok: false, code: "unauthorized_actor", message: "只有用户可以豁免必要验收条件" };
      }
      const nextCriteria = work.criteria.map(criterion => ({ ...criterion }));
      for (const update of params.criterionUpdates ?? []) {
        if (deliverable.uncoveredCriterionIds.includes(update.criterionId)) {
          return { ok: false, code: "unmet_acceptance_criteria", message: "该验收项仍有未补齐的成果缺口" };
        }
        const criterion = nextCriteria.find(item => item.id === update.criterionId);
        if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${update.criterionId}` };
        if (update.evidenceIds.length === 0) {
          return { ok: false, code: "unmet_acceptance_criteria", message: `验收条件「${criterion.text}」没有依据证据` };
        }
        for (const evidenceId of update.evidenceIds) {
          const evidence = this.repo.getEvidence(evidenceId);
          if (!evidence || evidence.workId !== work.workId) {
            return { ok: false, code: "not_found", message: "找不到验收证据" };
          }
          if (evidence.provenance === "execution") {
            return { ok: false, code: "unmet_acceptance_criteria", message: "执行者自述只作为待核验材料，必须使用宿主核对后的证据" };
          }
          if (evidence.deliverableId !== deliverable.deliverableId && evidence.executionId !== binding.bindingId) {
            return { ok: false, code: "unmet_acceptance_criteria", message: "证据不属于该成果或执行" };
          }
          if (evidence.intentRevision !== work.intentRevision || evidence.inputSnapshotId !== work.inputSnapshotId) {
            return { ok: false, code: "version_conflict", message: "证据对应旧要求或旧输入快照，不能确认当前目标" };
          }
          if (!evidence.criterionIds.includes(criterion.id)) {
            return { ok: false, code: "unmet_acceptance_criteria", message: `证据没有覆盖验收条件「${criterion.text}」` };
          }
          if (criterionNeedsEnvironment(criterion)) {
            if (evidence.kind !== "real_environment" || evidence.provenance !== "user") {
              return {
                ok: false, code: "unmet_acceptance_criteria",
                message: `验收条件「${criterion.text}」要求真实环境实测反馈，不能由自动测试或推测代替`,
              };
            }
            if (!evidence.environment?.trim()) {
              return { ok: false, code: "unmet_acceptance_criteria", message: "实测证据必须注明环境" };
            }
            if (criterion.requiredEnvironment
              && evidence.environment.trim().toLowerCase() !== criterion.requiredEnvironment.trim().toLowerCase()) {
              return {
                ok: false, code: "unmet_acceptance_criteria",
                message: `实测环境 ${evidence.environment} 与要求环境 ${criterion.requiredEnvironment} 不一致`,
              };
            }
          }
          criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidence.evidenceId])];
        }
        criterion.status = "satisfied";
        criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
      }
      for (const waiver of waivers.values()) {
        const criterion = nextCriteria.find(item => item.id === waiver.criterionId);
        if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${waiver.criterionId}` };
        if (!waiver.reason?.trim()) return { ok: false, code: "invalid_request", message: "豁免必须记录原因" };
        criterion.status = "waived";
        criterion.waivedReason = waiver.reason.trim().slice(0, 1000);
        criterion.waivedByUserId = resolved.userId;
      }
      this.repo.updateDeliverableReview(deliverable.deliverableId, {
        status: "accepted", reviewedAt: now, reviewedByBotId: resolved.bot?.botId ?? `user:${resolved.userId}`,
      });
      const next: WorkDto = {
        ...work,
        criteria: nextCriteria,
        acceptedDeliverableIds: [...new Set([...work.acceptedDeliverableIds, deliverable.deliverableId])],
        progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      };
      this.repo.updateWork(next);
      const outboxEventId = this.outbox({
        work: next, eventType: "work.deliverable_accepted", operationId: params.operationId,
        bindingId: binding.bindingId, payload: { deliverableId: deliverable.deliverableId, partialAcceptance: params.partialAcceptance },
      });
      // Same transaction: the one card for this accepted outcome. A replay lands on the
      // same key, so a re-observed result never mints a second card.
      this.phase5.recordAcceptance(next, deliverable, now);
      return { ok: true, outboxEventId };
    });
  }

  rejectDeliverable(actor: WorkActor, params: RejectDeliverableParams): WorkControlResult {
    return this.runWorkControl(actor, "rejectDeliverable", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => {
      const deliverable = this.repo.getDeliverable(params.deliverableId);
      if (!deliverable || deliverable.workId !== work.workId) {
        return { ok: false, code: "not_found", message: "找不到成果记录" };
      }
      if (deliverable.status !== "proposed") {
        return { ok: false, code: "invalid_request", message: "只有待验收成果可以拒绝" };
      }
      this.repo.updateDeliverableReview(deliverable.deliverableId, {
        status: "rejected", reviewedAt: now, reviewedByBotId: work.ownerBotId, rejectedReason: params.reason,
      });
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      return { ok: true };
    });
  }

  // ============================================================ user feedback

  recordUserFeedback(actor: WorkActor, params: RecordUserFeedbackParams): WorkControlResult {
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    if (resolved.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "实测反馈必须来自已认证用户入口" };
    const artifactInspection = this.artifacts.capture(params.workId);
    return this.runWorkControl(actor, "recordUserFeedback", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => {
      if (!this.artifacts.validate(artifactInspection, now)) {
        this.emitCurrentProjection(work.workId);
        return { ok: false, code: "version_conflict", message: "产物版本发生变化，已保留历史成果并重新打开相关验收项" };
      }

      if (work.userId !== resolved.userId) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (!params.environment?.trim()) return { ok: false, code: "invalid_request", message: "实测反馈必须注明环境" };
      if (!params.sourceRef?.trim()) return { ok: false, code: "invalid_request", message: "实测反馈必须注明被测版本" };
      const inputSnapshotId = params.inputSnapshotId?.trim();
      if (!inputSnapshotId || inputSnapshotId === "snapshot:unbound") {
        return { ok: false, code: "invalid_request", message: "实测反馈必须明确绑定被测输入快照，不能默认使用当前版本" };
      }
      if (artifactInspection.observed.length && params.artifactSnapshotId !== this.artifacts.snapshotId(artifactInspection))
        return { ok: false, code: "version_conflict", message: "实测反馈必须绑定被测产物版本，旧产物反馈不能验证当前结果" };
      const historical = inputSnapshotId !== work.inputSnapshotId;
      const criteria = work.criteria.map(criterion => ({ ...criterion }));
      const evidenceId = newId("evidence");
      const affected: string[] = [];
      for (const criterionId of params.criterionIds) {
        const criterion = criteria.find(item => item.id === criterionId);
        if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${criterionId}` };
        if (historical) {
          affected.push(criterion.id);
          continue;
        }
        if (criterion.requiredEnvironment
          && criterion.requiredEnvironment.trim().toLowerCase() !== params.environment.trim().toLowerCase()) {
          return {
            ok: false, code: "unmet_acceptance_criteria",
            message: `反馈环境 ${params.environment} 与要求环境 ${criterion.requiredEnvironment} 不一致`,
          };
        }
        criterion.status = params.failed ? "failed" : "satisfied";
        criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
        criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidenceId])];
        affected.push(criterion.id);
      }
      this.repo.insertEvidence({
        evidenceId,
        workId: work.workId,
        criterionIds: affected,
        kind: "real_environment",
        provenance: "user",
        sourceRef: params.sourceRef.trim(),
        sourceSha: params.sourceSha,
        inputSnapshotId,
        environment: params.environment.trim(),
        intentRevision: work.intentRevision,
        detail: params.detail,
        recordedAt: now,
      });
      const next: WorkDto = { ...work, criteria, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      const outboxEventId = this.outbox({
        work: next, eventType: "work.user_feedback_recorded", operationId: params.operationId,
        payload: { evidenceId, failed: params.failed, environment: params.environment, historical },
      });
      return { ok: true, outboxEventId };
    });
  }

  /**
   * User-confirmed criterion change from the conversation UI. It is recorded as
   * user-attestation evidence bound to the current input snapshot. Real-environment
   * criteria cannot be satisfied here: they need explicit environment feedback.
   */
  attestCriteria(actor: WorkActor, params: AttestCriteriaParams): WorkControlResult {
    const artifactInspection = params.inputSnapshotId !== undefined ? this.artifacts.capture(params.workId) : undefined;
    return this.runWorkControl(actor, "attestCriteria", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused", "closing"],
    }, (work, resolved, now) => {
      if (resolved.kind !== "user" || resolved.userId !== work.userId) {
        return { ok: false, code: "unauthorized_actor", message: "只有用户可以确认验收条件" };
      }
      if (params.inputSnapshotId !== undefined && (params.inputSnapshotId !== work.inputSnapshotId
        || params.inputSnapshotId === "snapshot:unbound" || !artifactInspection
        || !this.artifacts.validate(artifactInspection, now)
        || artifactInspection.observed.length > 0 && params.artifactSnapshotId !== this.artifacts.snapshotId(artifactInspection))) {
        return { ok: false, code: "version_conflict", message: "验收依据的输入或产物已变化，请核对当前版本" };
      }
      const criteria = work.criteria.map(criterion => ({ ...criterion }));
      const evidenceId = newId("evidence");
      const evidenceCriteria: string[] = [];
      for (const update of params.criterionUpdates) {
        const criterion = criteria.find(item => item.id === update.criterionId);
        if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${update.criterionId}` };
        if (update.status === "pending") {
          criterion.status = "pending";
          criterion.verifiedIntentRevision = undefined;
          criterion.evidenceRefs = [];
          criterion.waivedReason = undefined;
          criterion.waivedByUserId = undefined;
          continue;
        }
        if (update.status === "waived") {
          if (!update.evidence?.trim()) return { ok: false, code: "invalid_request", message: "豁免验收条件必须记录原因" };
          criterion.status = "waived";
          criterion.waivedReason = update.evidence.trim().slice(0, 1000);
          criterion.waivedByUserId = resolved.userId;
          continue;
        }
        if (update.status === "met" && criterionNeedsEnvironment(criterion)) {
          return {
            ok: false, code: "unmet_acceptance_criteria",
            message: `验收条件「${criterion.text}」要求注明环境与版本的实测反馈，请在 Bot 模式提交实测结果`,
          };
        }
        criterion.status = update.status === "met" ? "satisfied" : "failed";
        criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
        criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidenceId])];
        evidenceCriteria.push(criterion.id);
      }
      if (evidenceCriteria.length > 0) {
        this.repo.insertEvidence({
          evidenceId,
          workId: work.workId,
          criterionIds: evidenceCriteria,
          kind: "user_attestation",
          provenance: "user",
          sourceRef: `user-attestation:${params.operationId}`,
          inputSnapshotId: work.inputSnapshotId,
          intentRevision: work.intentRevision,
          detail: params.progressSummary
            ?? params.criterionUpdates.map(update => update.evidence).filter(Boolean).join("; ").slice(0, 2000),
          recordedAt: now,
        });
      }
      const next: WorkDto = {
        ...work,
        criteria,
        progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      };
      this.repo.updateWork(next);
      return { ok: true };
    });
  }

  // ============================================================== blockers

  reportBlocker(actor: WorkActor, params: ReportBlockerParams): WorkControlResult {
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    return this.runWorkControl(actor, "reportBlocker", params, {
      guard: "versions", ownerOnly: false, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => reportWorkBlockerMutation({ repo: this.repo, phase5: this.phase5 }, work, resolved, params, now, this.isOwnerOrUser(work, resolved))
    );
  }

  /** Records an explicit answer, not authorization to resume or perform an action. */
  replyUserInput(actor: WorkActor, params: ReplyUserInputParams): WorkControlResult {
    return this.runWorkControl(actor, "replyUserInput", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused"],
    }, (work, resolved, now) => replyUserInputMutation({ repo: this.repo }, work, resolved, params, now)
    );
  }

  /** Trusted user classification of a uniquely proven historical owner report.
   * No tool permission, effect, budget, execution or acceptance fact is changed. */
  replyLegacyUserInput(actor: WorkActor, params: ReplyLegacyUserInputParams): WorkControlResult {
    return this.runWorkControl(actor, "replyLegacyUserInput", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused"],
    }, (work, resolved, now) => replyLegacyUserInputMutation({ repo: this.repo, db: this.db }, work, resolved, params, now)
    );
  }

  clearBlocker(actor: WorkActor, params: ClearBlockerParams): WorkControlResult {
    return this.runWorkControl(actor, "clearBlocker", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => {
      const blocker = this.repo.getBlocker(params.blockerId);
      if (!blocker || blocker.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到阻碍" };
      this.repo.clearBlocker(blocker.blockerId, work.workId, now);
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.repo.updateWork(next);
      if (next.lifecycle === "closing") this.tryCloseSettled(next, now);
      return { ok: true };
    });
  }

  // ================================================================ budgets

  reserveBudget(workId: string, reservationId: string, tokens: number): { ok: true; reservation: WorkBudgetReservationDto } | Fail {
    const result = this.budget.reserve({ workId, reservationId, tokens });
    return result.ok ? result : { ok: false, code: result.code, message: result.message };
  }

  /**
   * Phase 4 dependency #3: reservations/usage survive restarts, retries and handoff.
   * A missing provider report is counted as unknown, never as zero consumption.
   */
  commitBudgetUsage(workId: string, reservationId: string, reportedTokens?: number): { ok: boolean; message?: string } {
    return this.budget.commit(workId, reservationId, reportedTokens);
  }

  /** Only a persisted policy may open the next window; handoff/restart never does. */
  openBudgetWindow(actor: WorkActor, workId: string, input: { windowId: string; maxTokens: number; windowExpiresAt?: number }): Fail | { ok: true; work: WorkDto } {
    return this.transaction(() => {
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (!this.isOwnerOrUser(work, resolved)) return { ok: false, code: "unauthorized_actor", message: "只有负责人或用户可开启预算窗口" };
      const opened = this.budget.openExplicitWindow(work, { ...input, allowNextWindow: work.budget.allowNextWindow });
      return typeof opened === "string"
        ? { ok: false, code: opened === "policy" ? "invalid_lifecycle_transition" : "unsettled_effects", message: opened }
        : { ok: true, work: opened };
    });
  }

  private initialBudget(workId: string, params: CreateWorkParams, authorization: WorkAuthorizationDto, now: number): WorkDto["budget"] {
    const requested = params.budget?.maxTokens;
    const maxTokens = Math.min(
      typeof requested === "number" && requested > 0 ? requested : 500_000,
      authorization.budgetLimitTokens ?? Number.MAX_SAFE_INTEGER,
    );
    return {
      windowId: `win-${workId}-1`,
      maxTokens,
      usedTokens: 0,
      reservedTokens: 0,
      unknownUsageCount: 0,
      windowStartAt: now,
      windowExpiresAt: params.budget?.windowExpiresAt,
      allowNextWindow: Boolean(params.budget?.allowNextWindow),
    };
  }

  private reserveBudgetInternal(work: WorkDto, reservationId: string, tokens: number, _now: number,
    detail: { requestKind?: WorkBudgetReservationDto["requestKind"]; bindingId?: string; attemptIdentity?: string } = {}): WorkBudgetReservationDto | string {
    const result = this.budget.reserve({ workId: work.workId, reservationId, tokens, ...detail });
    return result.ok ? result.reservation : result.message;
  }

  private commitBudgetInternal(_work: WorkDto, reservation: WorkBudgetReservationDto, reportedTokens: number, _now: number): void {
    this.budget.commit(reservation.workId, reservation.reservationId, reportedTokens);
  }

  // ============================================================ telemetry

  /** High-frequency progress never advances intentRevision or stateVersion. */
  recordTelemetryProgress(params: { workId: string; executionId?: string; streamingText?: string; tokensPerSecond?: number }): { ok: boolean; message?: string } {
    const work = this.repo.getWork(params.workId);
    if (!work) return { ok: false, message: "找不到 Work" };
    this.repo.recordTelemetry({ ...params, now: this.now() });
    return { ok: true };
  }

  // ========================================================== subscriptions

  addSubscription(actor: WorkActor, workId: string, input: WorkSubscriptionInput): { ok: true; subscription: WorkSubscriptionDto } | Fail {
    return this.transaction(() => {
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (!this.isOwnerOrUser(work, resolved)) return { ok: false, code: "unauthorized_actor", message: "只有负责人或用户可添加关注规则" };
      if (!input.source?.trim()) return { ok: false, code: "invalid_request", message: "订阅来源不能为空" };
      if (!input.catchUpPolicy) return { ok: false, code: "invalid_request", message: "订阅必须显式保存补处理策略" };
      const now = this.now();
      const existing = input.subscriptionId
        ? this.repo.getSubscription(input.subscriptionId)
        : this.repo.listSubscriptions(work.workId).find(item => !item.stoppedAt && item.source === input.source);
      if (existing && (existing.workId !== work.workId || existing.source !== input.source)) {
        return { ok: false, code: "idempotency_conflict", message: "订阅身份已用于另一事项或来源" };
      }
      const subscription: WorkSubscriptionDto = existing ? {
        ...existing,
        filter: input.filter ?? existing.filter,
        catchUpPolicy: input.catchUpPolicy,
        maxMergeWaitMs: input.maxMergeWaitMs ?? existing.maxMergeWaitMs,
        maxQueueDepth: input.maxQueueDepth ?? existing.maxQueueDepth,
        stopConditionText: input.stopConditionText ?? existing.stopConditionText,
        timezone: input.timezone ?? existing.timezone,
        cronExpression: input.cronExpression ?? existing.cronExpression,
        nextWakeAt: input.nextWakeAt ?? this.computeNextWake({ cronExpression: input.cronExpression ?? existing.cronExpression,
          timezone: input.timezone ?? existing.timezone, nextWakeAt: input.nextWakeAt }, now),
        updatedAt: now,
      } : {
        subscriptionId: input.subscriptionId?.trim() || newId("subscription"),
        workId: work.workId,
        source: input.source,
        filter: input.filter ?? {},
        catchUpPolicy: input.catchUpPolicy,
        maxMergeWaitMs: input.maxMergeWaitMs ?? 60_000,
        maxQueueDepth: input.maxQueueDepth ?? 100,
        scheduleRevision: 1, configRevision: 1, versionMode: "readback", dstPolicy: "first-valid",
        maxBacklogEvents: input.maxQueueDepth ? Math.max(input.maxQueueDepth * 4, 16) : 400,
        maxBacklogBytes: 8 * 1024 * 1024,
        stopConditionText: input.stopConditionText,
        timezone: input.timezone,
        cronExpression: input.cronExpression,
        nextWakeAt: input.nextWakeAt ?? this.computeNextWake({
          cronExpression: input.cronExpression, timezone: input.timezone, nextWakeAt: input.nextWakeAt,
        }, now),
        createdAt: now,
        updatedAt: now,
      };
      if (existing) this.repo.updateSubscription(subscription);
      else {
        this.repo.insertSubscription(subscription);
        this.ingress.setCursor(subscription.subscriptionId, subscription.source,
          subscription.sourceTarget ?? this.ingress.adapter(subscription.source)?.targetKeyOf({ eventType: "", payload: {} }) ?? "default", {});
      }
      this.repo.updateWork({
        ...work,
        watchRule: {
          ...(work.watchRule ?? { subscriptions: [], catchUpPolicy: subscription.catchUpPolicy, maxMergeWaitMs: subscription.maxMergeWaitMs, maxQueueDepth: subscription.maxQueueDepth }),
          subscriptions: [...new Set([...(work.watchRule?.subscriptions ?? []), subscription.source])],
          nextWakeAt: subscription.nextWakeAt ?? work.watchRule?.nextWakeAt,
        },
        stateVersion: work.stateVersion + 1,
        updatedAt: now,
      });
      return { ok: true, subscription };
    });
  }

  stopSubscription(actor: WorkActor, workId: string, subscriptionId: string): { ok: true } | Fail {
    return this.transaction(() => {
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (!this.isOwnerOrUser(work, resolved)) return { ok: false, code: "unauthorized_actor", message: "只有负责人或用户可停止关注规则" };
      const subscription = this.repo.getSubscription(subscriptionId);
      if (!subscription || subscription.workId !== workId) return { ok: false, code: "not_found", message: "找不到订阅" };
      const now = this.now();
      this.repo.updateSubscription({ ...subscription, stoppedAt: now, updatedAt: now });
      this.repo.updateWork(this.syncWatchRuleSources(work, now));
      return { ok: true };
    });
  }

  /** watchRule.subscriptions is a source-name set; it never stores subscription primary keys. */
  private syncWatchRuleSources(work: WorkDto, now: number): WorkDto {
    if (!work.watchRule) return work;
    const active = [...new Set(this.repo.listSubscriptions(work.workId).filter(item => !item.stoppedAt).map(item => item.source))];
    const current = work.watchRule.subscriptions;
    const next = [...new Set([...current.filter(source => active.includes(source)), ...active])];
    if (JSON.stringify(next) === JSON.stringify(current)) return work;
    return { ...work, watchRule: { ...work.watchRule, subscriptions: next },
      stateVersion: work.stateVersion + 1, updatedAt: now };
  }

  private installSubscriptions(work: WorkDto, rule: WorkWatchRuleDto, now: number): void {
    for (const source of rule.subscriptions) {
      const subscription: WorkSubscriptionDto = {
        subscriptionId: newId("subscription"),
        workId: work.workId,
        source,
        filter: {},
        catchUpPolicy: rule.catchUpPolicy,
        maxMergeWaitMs: rule.maxMergeWaitMs,
        maxQueueDepth: rule.maxQueueDepth,
        stopConditionText: rule.stopConditionText,
        timezone: rule.timezone,
        cronExpression: rule.cronExpression,
        nextWakeAt: this.computeNextWake({ cronExpression: rule.cronExpression, timezone: rule.timezone, nextWakeAt: rule.nextWakeAt }, now),
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insertSubscription(subscription);
    }
  }

  private syncSubscriptions(work: WorkDto, now: number): void {
    if (!work.watchRule) return;
    const existing = this.repo.listSubscriptions(work.workId);
    const wanted = new Set(work.watchRule.subscriptions);
    for (const subscription of existing) {
      if (!wanted.has(subscription.source) && !subscription.stoppedAt) {
        this.repo.updateSubscription({ ...subscription, stoppedAt: now, updatedAt: now });
      }
    }
    for (const source of wanted) {
      if (existing.some(subscription => subscription.source === source && !subscription.stoppedAt)) continue;
      this.repo.insertSubscription({
        subscriptionId: newId("subscription"),
        workId: work.workId,
        source,
        filter: {},
        catchUpPolicy: work.watchRule.catchUpPolicy,
        maxMergeWaitMs: work.watchRule.maxMergeWaitMs,
        maxQueueDepth: work.watchRule.maxQueueDepth,
        stopConditionText: work.watchRule.stopConditionText,
        timezone: work.watchRule.timezone,
        cronExpression: work.watchRule.cronExpression,
        nextWakeAt: this.computeNextWake({
          cronExpression: work.watchRule.cronExpression,
          timezone: work.watchRule.timezone,
          nextWakeAt: work.watchRule.nextWakeAt,
        }, now),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Source-level dedupe first, then one durable processing identity per subscription. */
  ingestSourceEvent(event: WorkSourceEventDto, options: { hostOnline?: boolean } = {}): {
    sourceNew: boolean;
    acknowledged: boolean;
    outcomes: Array<{ workId: string; subscriptionId?: string; outcome: "pending" | "accepted" | "merged" | "skipped" | "blocked" | "duplicate" | "rejected"; reasonCode?: string }>;
  } {
    const accepted = this.ingress.accept({
      source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType,
      sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
      occurredAt: event.timestamp, payload: event.payload ?? {}, trustedOrigin: "host",
    }, { workId: event.workId, subscriptionId: event.subscriptionId, offline: options.hostOnline === false, trust: "host" });
    return { sourceNew: accepted.sourceNew, acknowledged: accepted.acknowledged, outcomes: accepted.outcomes.map(item => ({
      workId: item.workId, subscriptionId: item.subscriptionId, outcome: item.outcome, reasonCode: item.reasonCode,
    })) };
  }

  /** Due inbox rows: `merged` rows become ready at their bounded merge deadline. */
  listDueInbox(workId: string, now = this.now()): WorkInboxEventDto[] {
    return this.ingress.listReady(workId, now);
  }

  /**
   * Single transaction: consume the inbox event, apply the business change and mark
   * it processed together or not at all.
   */
  completeInboxEvent(eventId: string, apply: (event: WorkInboxEventDto) => void): { ok: boolean; message?: string } {
    return this.transaction(() => {
      const denied = this.authorityError(); if (denied) return { ok: false, message: denied.message };
      const event = this.repo.getInbox(eventId);
      if (!event) return { ok: false, message: "找不到事件" };
      if (event.status === "processed") return { ok: true };
      if (event.status !== "pending" && event.status !== "merged") return { ok: false, message: `事件状态 ${event.status} 不能处理` };
      if (this.getWork(event.workId)?.lifecycle !== "active") return { ok: false, message: "暂停或结束的事项不能处理新业务事件" };
      if (event.payload.authoritativeReadbackRequired) return { ok: false, message: "合并事件必须通过可信来源回读入口消费" };

      apply(event);
      this.ingress.markConsumed(event.eventId, { providerSourceVersion: event.sourceVersion });
      return { ok: true };
    });
  }

  /** Deterministic trigger tick: one stable identity per subscription and logical slot. */
  tick(now = this.now()): Array<{ subscriptionId: string; workId: string; scheduledAt: number }> {
    return this.scheduler.tick(now).flatMap(item => item.fired);
  }

  // ========================================================== notifications

  /**
   * Delivery is separate from acceptance. A channel that cannot prove delivery keeps
   * `unknown`; it is never turned into a second blind send.
   */
  deliverPendingNotifications(channel: WorkNotificationChannel, workId?: string): Array<{ notificationId: string; delivery: WorkNotificationDto["delivery"] }> {
    return this.notifications.deliver(channel, workId);
  }

  markNotificationRead(notificationId: string): { ok: boolean; message?: string } {
    const notification = this.repo.getNotification(notificationId);
    if (!notification) return { ok: false, message: "找不到通知" };
    if (!notification.readAt) this.repo.markNotificationRead(notificationId, this.now());
    return { ok: true };
  }

  // ============================================================= phase 5 facts

  /** Card reads, resends, the summary and the expanded view live in WorkPhase5Facts. */
  markWorkCardRead(actor: WorkActor, input: unknown): WorkCardReadResult {
    return this.phase5.markRead(actor, input);
  }

  resendWorkNotification(actor: WorkActor, request: unknown): WorkControlResult {
    return this.phase5.resend(actor, request);
  }

  getWorkSummary(userId: string, workId: string): WorkSummaryProjectionDto | undefined {
    return this.phase5.summary(userId, workId);
  }

  getWorkDiagnostics(userId: string, request: unknown): WorkExpandedDiagnosticsDto | undefined {
    return this.phase5.diagnostics(userId, request);
  }

  /** Internal seams used by WorkPhase5Facts; the control path and receipts stay the same. */
  resolveWorkActor(actor: WorkActor): ResolvedActor | string {
    return this.resolveActor(actor);
  }

  runCardControl<TParams extends { operationId: string; workId: string; versionGuard?: ExpectedVersionGuard }>(
    actor: WorkActor, operationType: string, params: TParams,
    options: { guard: "full" | "versions" | "none"; ownerOnly: boolean; allowLifecycles: WorkDto["lifecycle"][] },
    mutate: (work: WorkDto, resolved: ResolvedActor, now: number) => Mutation,
  ): WorkControlResult {
    return this.runWorkControl(actor, operationType, params, options, mutate);
  }

  emitNotificationResent(work: WorkDto, input: { notificationId: string; effectKey: string; reason: string; operationId: string }): string {
    return this.outbox({ work, eventType: "work.notification_resent", operationId: input.operationId,
      payload: { notificationId: input.notificationId, effectKey: input.effectKey, reason: input.reason } });
  }

  // ============================================================= phase 4 control

  /** Guarded IPC/API entry for subscription, deadline, budget policy and receipt reconciliation. */
  phase4Control(actor: WorkActor, request: unknown): WorkPhase4ControlResult {
    const parsed = phase4ControlRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message ?? "Phase 4 控制请求无效" };
    const input = parsed.data as WorkPhase4ControlRequest;
    let subscriptionId: string | undefined = "subscriptionId" in input ? input.subscriptionId : undefined;
    const result = this.runWorkControl(actor, `phase4:${input.kind}`, input as unknown as
      { operationId: string; workId: string; versionGuard?: ExpectedVersionGuard }, {
      guard: "full", ownerOnly: true,
      // Accounting for an existing request must remain possible after execution stops.
      allowLifecycles: input.kind === "reconcile-budget-reservation" ? ["active", "paused", "closing", "closed"] : ["active", "paused"],
    }, (work, resolved, now) => this.applyPhase4Control(work, input, resolved, now));
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    if (input.kind === "configure-subscription") subscriptionId = this.lastPhase4SubscriptionId ?? input.subscriptionId;
    if (input.kind === "retry-backlog") subscriptionId = input.subscriptionId;
    return { ok: true, replayed: result.replayed, operationId: input.operationId, workId: result.work.workId,
      subscriptionId, deadlineAt: result.work.deadlineAt, budgetWindowId: result.work.budget.windowId };
  }

  private applyPhase4Control(work: WorkDto, input: WorkPhase4ControlRequest, resolved: ResolvedActor, now: number): Mutation {
    if (input.kind === "reconcile-budget-reservation") {
      if (resolved.kind !== "user" && resolved.kind !== "bot") {
        return { ok: false, code: "unauthorized_actor", message: "只有当前主负责人或用户可以核对未知用量" };
      }
      const result = this.budget.reconcileUnknown(work, input, {
        kind: resolved.kind, userId: resolved.userId, botId: resolved.bot?.botId,
      });
      if (result.ok) this.tryCloseSettled(this.repo.getWork(work.workId)!, now);
      return result;
    }
    if (input.kind === "configure-subscription") {
      const existing = input.subscriptionId
        ? this.repo.getSubscription(input.subscriptionId)
        : this.repo.listSubscriptions(work.workId).find(item => !item.stoppedAt && item.source === input.source
          && (input.targetKey === undefined ? item.sourceTarget === undefined : item.sourceTarget === input.targetKey));
      if (existing && existing.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
      const timezone = input.timezone ?? existing?.timezone;
      const cronExpression = input.cronExpression ?? existing?.cronExpression;
      if (timezone !== undefined && !validTimezone(timezone)) return { ok: false, code: "invalid_request", message: "时区必须是可以解析的 IANA 名称" };
      const scheduleChanged = cronExpression !== existing?.cronExpression || timezone !== existing?.timezone;
      let nextWakeAt: number | undefined;
      try { nextWakeAt = input.nextWakeAt ?? this.computeNextWake({ cronExpression, timezone }, now); }
      catch { return { ok: false, code: "invalid_request", message: "Cron 表达式或时区无法解析" }; }
      const subscription: WorkSubscriptionDto = {
        subscriptionId: existing?.subscriptionId ?? input.subscriptionId ?? newId("subscription"),
        workId: work.workId, source: input.source, filter: input.filter ?? existing?.filter ?? {},
        catchUpPolicy: input.catchUpPolicy, maxMergeWaitMs: input.maxMergeWaitMs ?? existing?.maxMergeWaitMs ?? 60_000,
        maxQueueDepth: input.maxQueueDepth ?? existing?.maxQueueDepth ?? 100,
        stopConditionText: input.stopConditionText ?? existing?.stopConditionText,
        timezone, cronExpression, nextWakeAt,
        scheduleRevision: existing ? (scheduleChanged ? (existing.scheduleRevision ?? 1) + 1 : input.scheduleRevision ?? existing.scheduleRevision ?? 1)
          : 1,
        configRevision: (existing?.configRevision ?? 1) + 1,
        sourceTarget: input.targetKey ?? existing?.sourceTarget,
        versionMode: input.versionMode ?? existing?.versionMode ?? "readback",
        dstPolicy: input.dstPolicy ?? existing?.dstPolicy ?? "first-valid",
        maxBacklogEvents: input.maxBacklogEvents ?? existing?.maxBacklogEvents ?? 400,
        maxBacklogBytes: input.maxBacklogBytes ?? existing?.maxBacklogBytes ?? 8 * 1024 * 1024,
        lastCheckedAt: existing?.lastCheckedAt, stoppedReason: existing?.stoppedReason,
        createdAt: existing?.createdAt ?? now, updatedAt: now, stoppedAt: existing?.stoppedAt,
      };
      this.lastPhase4SubscriptionId = subscription.subscriptionId;
      if (existing) this.repo.updateSubscription(subscription);
      else {
        this.repo.insertSubscription(subscription);
        this.ingress.setCursor(subscription.subscriptionId, subscription.source,
          subscription.sourceTarget ?? this.ingress.adapter(subscription.source)?.targetKeyOf({ eventType: "", payload: {} }) ?? "default", {});
      }
      this.repo.updateWork({ ...work, watchRule: {
        ...(work.watchRule ?? { subscriptions: [], catchUpPolicy: subscription.catchUpPolicy,
          maxMergeWaitMs: subscription.maxMergeWaitMs, maxQueueDepth: subscription.maxQueueDepth }),
        subscriptions: [...new Set([...(work.watchRule?.subscriptions ?? []), subscription.source])],
        nextWakeAt: subscription.nextWakeAt ?? work.watchRule?.nextWakeAt,
      }, stateVersion: work.stateVersion + 1, updatedAt: now });
      return { ok: true };
    }
    if (input.kind === "stop-subscription") {
      const subscription = this.repo.getSubscription(input.subscriptionId);
      if (!subscription || subscription.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
      this.repo.updateSubscription({ ...subscription, stoppedAt: now, stoppedReason: input.reason, updatedAt: now });
      this.repo.updateWork(this.syncWatchRuleSources(work, now));
      return { ok: true };
    }
    if (input.kind === "set-deadline") {
      const changed = (work.deadlineAt ?? null) !== (input.deadlineAt ?? null);
      const revision = changed ? work.deadlineRevision + 1 : work.deadlineRevision;
      if (changed) {
        this.db.prepare("UPDATE work_deadline_instances SET state='cancelled' WHERE work_id=? AND state='armed'").run(work.workId);
        if (input.deadlineAt !== null) {
          this.db.prepare(`INSERT OR IGNORE INTO work_deadline_instances
            (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?,?,?,'armed',?)`)
            .run(work.workId, revision, input.deadlineAt, now);
        }
      }
      this.repo.updateWork({ ...work, deadlineAt: input.deadlineAt ?? undefined, deadlineRevision: revision,
        deadlineSetAt: now, stateVersion: work.stateVersion + 1, updatedAt: now });
      return { ok: true };
    }
    if (input.kind === "set-budget-policy") {
      const updated = this.budget.setPolicy(work, { maxTokens: input.maxTokens, windowMs: input.windowMs,
        timezone: input.timezone, autoRollover: input.autoRollover });
      if (typeof updated === "string") return { ok: false, code: "invalid_request", message: updated };
      return { ok: true };
    }
    // retry-backlog: allow the source to redeliver hard-refused routes and refill the finite overflow.
    const subscription = this.repo.getSubscription(input.subscriptionId);
    if (!subscription || subscription.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
    this.db.prepare("DELETE FROM work_ingress_routes WHERE subscription_id=? AND state='rejected'").run(subscription.subscriptionId);
    this.ingress.refillBlocked(subscription);
    this.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
    return { ok: true };
  }

  private projectSubscriptions(work: WorkDto): WorkSubscriptionMonitorDto[] {
    const host = this.scheduler.hostState();
    return this.repo.listSubscriptions(work.workId, { includeStopped: true }).map(subscription => {
      const stats = this.ingress.queueStats(subscription);
      const cursors = this.ingress.listCursors(subscription.subscriptionId).map(cursor => ({
        source: cursor.source, targetKey: cursor.targetKey, highestAcceptedVersion: cursor.highestAcceptedVersion,
        highestConsumedVersion: cursor.highestConsumedVersion, highestFrozenVersion: cursor.highestFrozenVersion,
        replayCursor: cursor.replayCursor, enumerationWatermark: cursor.enumerationWatermark,
      }));
      const status = subscription.stoppedAt !== undefined ? "stopped" as const
        : work.lifecycle === "paused" ? "paused" as const : work.lifecycle === "closing" ? "closing" as const
          : host.online ? "online" as const : "offline" as const;
      return { subscriptionId: subscription.subscriptionId, workId: work.workId, source: subscription.source,
        targetKey: subscription.sourceTarget, status, catchUpPolicy: subscription.catchUpPolicy,
        timezone: subscription.timezone, cronExpression: subscription.cronExpression,
        scheduleRevision: subscription.scheduleRevision ?? 1, configRevision: subscription.configRevision ?? 1,
        nextWakeAt: subscription.nextWakeAt, lastCheckedAt: subscription.lastCheckedAt,
        versionMode: subscription.versionMode ?? "readback", queue: stats, cursors };
    });
  }

  // ================================================================ internal

  private runWorkControl<TParams extends { operationId: string; workId: string; versionGuard?: ExpectedVersionGuard }>(
    actor: WorkActor,
    operationType: string,
    params: TParams,
    options: {
      guard: "full" | "versions" | "none";
      ownerOnly: boolean;
      allowLifecycles: WorkDto["lifecycle"][];
    },
    mutate: (work: WorkDto, resolved: ResolvedActor, now: number) => Mutation,
  ): WorkControlResult {
    const authorityError = this.authorityError();
    if (authorityError) return authorityError;
    const payloadHash = this.hash(operationType, params);
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    const invalid = this.validatePayload(operationType, params);
    if (invalid) return invalid;

    const outcome = this.transaction((): WorkControlResult => {
      const authorityError = this.authorityError();
      if (authorityError) return authorityError;
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(params.workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      const access = this.requireAccess(work, resolved);
      if (access) return access;
      if (options.ownerOnly && !this.isOwnerOrUser(work, resolved)) {
        return { ok: false, code: "unauthorized_actor", message: "只有当前主负责人或用户可以执行该控制操作" };
      }
      const receipt = this.repo.getReceipt(resolved.userId, params.operationId);
      if (receipt) {
        if (receipt.operation_type !== operationType || receipt.payload_hash !== payloadHash
          || receipt.work_id !== params.workId) {
          return {
            ok: false, code: "idempotency_conflict",
            message: `操作 ${params.operationId} 已用于另一请求或另一事项`,
          };
        }
        const snapshot = parseWork(receipt.result_snapshot_json);
        if (!snapshot) return { ok: false, code: "not_found", message: "历史回执不可用" };
        if (snapshot.userId !== resolved.userId) {
          return { ok: false, code: "not_found", message: "找不到该操作的历史回执" };
        }
        return {
          ok: true, replayed: true, operationId: params.operationId,
          work: snapshot, outboxEventId: receipt.outbox_event_id ?? undefined,
        };
      }
      if (resolved.kind === "worker" && resolved.binding?.workId !== work.workId) {
        return { ok: false, code: "not_found", message: "找不到 Work" };
      }
      if (options.allowLifecycles.length > 0 && !options.allowLifecycles.includes(work.lifecycle)) {
        return {
          ok: false, code: "invalid_lifecycle_transition",
          message: `事项处于 ${work.lifecycle}，不能执行 ${operationType}`,
          latestWorkSnapshot: work,
        };
      }
      const now = this.now();
      if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now
        && !(operationType === "cancelWork" || operationType === "closeWork" || operationType === "retryResourceRecovery" || operationType === "reconcileResourceEffect" || operationType === "prepareResourceEffect"
          || operationType === "phase4:reconcile-budget-reservation")) {
        // Renewing an expired delegation is a user authorization change, not new
        // business execution. Models cannot renew themselves, and the new deadline
        // and capabilities still intersect the current authenticated host grant.
        const requested = operationType === "amendWork" && resolved.kind === "user"
          ? (params as AmendWorkParams).authorization
          : undefined;
        const renewed = requested?.expiresAt !== undefined && Number.isFinite(requested.expiresAt)
          ? intersectAuthorization({ ...work.authorization, ...requested }, resolved.grants)
          : undefined;
        if (renewed?.expiresAt === undefined || renewed.expiresAt <= now) {
          return { ok: false, code: "unauthorized_actor", message: "事项授权已过期，需要用户在当前授权范围内明确续权" };
        }
      }
      const guardError = this.checkGuard(work, resolved, params.versionGuard, options.guard);
      if (guardError) return guardError;
      const mutation = mutate(work, resolved, now);
      if (!mutation.ok) {
        return {
          ...mutation,
          latestWorkSnapshot: mutation.latestWorkSnapshot ?? this.repo.getWork(work.workId),
        };
      }
      const updated = this.repo.getWork(work.workId)!;
      this.repo.saveReceipt({
        userId: resolved.userId,
        operationId: params.operationId,
        workId: work.workId,
        operationType,
        payloadHash,
        workSnapshot: updated,
        outboxEventId: mutation.outboxEventId,
        now,
      });
      return { ok: true, replayed: false, operationId: params.operationId, work: updated, outboxEventId: mutation.outboxEventId };
    });
    if (outcome.ok && !outcome.replayed) this.emitCurrentProjection(outcome.work.workId);
    return outcome;
  }

  private resolveActor(actor: WorkActor): ResolvedActor | string {
    if (actor.kind === "user") {
      if (!actor.userId?.trim()) return "缺少已认证用户身份";
      return { userId: actor.userId, kind: actor.kind, grants: actor.grants ?? minimumAuthorization() };
    }
    if (actor.kind === "bot") {
      if (!actor.botId?.trim() || !actor.userId?.trim()) return "缺少宿主 Bot 绑定";
      const bot = this.bots.getBot(actor.botId);
      if (!bot || bot.userId !== actor.userId) return "Bot 绑定与用户不匹配";
      if (bot.status === "disabled") return "Bot 已停用";
      return { userId: actor.userId, kind: actor.kind, bot, grants: actor.grants ?? bot.authorization };
    }
    if (actor.kind === "worker") {
      const binding = this.repo.getBinding(actor.bindingId);
      if (!binding) return "找不到有效执行绑定";
      if (binding.botId !== actor.botId) return "worker 身份与执行绑定不匹配";
      const work = this.repo.getWork(binding.workId);
      if (!work) return "找不到 Work";
      return { userId: work.userId, kind: actor.kind, binding, grants: minimumAuthorization() };
    }
    return { userId: "", kind: actor.kind, grants: minimumAuthorization() };
  }

  private requireAccess(work: WorkDto, resolved: ResolvedActor): Fail | undefined {
    if (resolved.kind === "system") return undefined;
    if (resolved.kind === "worker") {
      return resolved.binding?.workId === work.workId
        ? undefined
        : { ok: false, code: "not_found", message: "找不到 Work" };
    }
    if (resolved.userId !== work.userId) return { ok: false, code: "not_found", message: "找不到 Work" };
    if (resolved.kind === "bot" && resolved.bot?.botId !== work.ownerBotId
      && !work.participants.some(participant => participant.botId === resolved.bot?.botId)) {
      return { ok: false, code: "unauthorized_actor", message: "该 Bot 没有此事项的委派" };
    }
    return undefined;
  }

  private isOwnerOrUser(work: WorkDto, resolved: ResolvedActor): boolean {
    if (resolved.kind === "user") return resolved.userId === work.userId;
    if (resolved.kind === "bot") return resolved.bot?.botId === work.ownerBotId;
    return false;
  }

  /**
   * Version guard contract. Async bot/model decisions must carry state+intent versions;
   * ownership-sensitive decisions also carry the owner epoch. The authenticated user
   * entry is the separate trusted instant-command contract (guards optional).
   */
  private checkGuard(work: WorkDto, resolved: ResolvedActor, guard: ExpectedVersionGuard | undefined,
    mode: "full" | "versions" | "none"): Fail | undefined {
    return checkControlGuard(work, resolved, guard, mode);
  }

  private validatePayload(operationType: string, params: unknown): Fail | undefined {
    const problem = assertNoActorField(params);
    if (problem) return { ok: false, code: "invalid_request", message: problem };
    const operationId = (params as { operationId?: unknown }).operationId;
    const title = (params as { title?: unknown }).title;
    if ((operationType === "createWork" || title !== undefined)
      && (typeof title !== "string" || !title.trim())) {
      return { ok: false, code: "invalid_request", message: "Work 标题不能为空" };
    }
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 200) {
      return { ok: false, code: "invalid_request", message: "操作 ID 无效" };
    }
    if (operationType !== "createWork" && typeof (params as { workId?: unknown }).workId !== "string") {
      return { ok: false, code: "invalid_request", message: "缺少目标 Work" };
    }
    return undefined;
  }

  private hash(operationType: string, params: unknown): string {
    return createHash("sha256").update(canonicalControlInput(operationType, params)).digest("hex");
  }

  private authorizedFor(work: WorkDto, actionKind: string): boolean {
    if (actionKind === "git:branch" || actionKind === "git:worktree") return work.authorization.allowGitBranchOrWorktree;
    if (actionKind === "delegate") return work.authorization.allowRedelegation;
    return work.authorization.allowedScopes.includes(actionKind);
  }

  private snapshotOf(bot: BotDto) {
    return this.bots.activeSnapshot(bot.botId)!;
  }

  private intentSnapshot(work: WorkDto, ownerBot: BotDto, sourceMessageId: string | undefined, createdBy: "user" | "bot"): WorkIntentSnapshotDto {
    return {
      snapshotId: work.activeIntentSnapshotId,
      workId: work.workId,
      intentRevision: work.intentRevision,
      sourceVersion: work.sourceVersion,
      title: work.title,
      goalDescription: work.goalDescription,
      constraints: work.constraints,
      criteria: work.criteria,
      authorization: work.authorization,
      expertSnapshot: this.snapshotOf(ownerBot),
      inputSnapshotId: work.inputSnapshotId,
      goalSources: work.goalSources,
      createdBy,
      sourceMessageId,
      createdAt: work.updatedAt,
    };
  }

  private outbox(params: {
    work: WorkDto;
    eventType: string;
    operationId: string;
    bindingId?: string;
    causalEventId?: string;
    payload: Record<string, unknown>;
  }): string {
    const eventId = newId("instruction");
    const instruction: WorkOutboxInstructionDto = {
      eventId,
      dedupeKey: `work:${params.work.workId}:op:${params.operationId}:${params.eventType}${params.bindingId ? `:${params.bindingId}` : ""}`,
      eventType: params.eventType,
      workId: params.work.workId,
      bindingId: params.bindingId,
      intentRevision: params.work.intentRevision,
      stateVersion: params.work.stateVersion,
      ownerEpoch: params.work.ownerEpoch,
      requestId: params.operationId,
      causalEventId: params.causalEventId,
      deliveryStatus: "pending",
      attemptCount: 0,
      payload: params.payload,
      createdAt: this.now(),
    };
    this.repo.insertOutbox(instruction);
    return eventId;
  }

  private mergeCriteria(
    work: WorkDto,
    inputs: NonNullable<AmendWorkParams["criteria"]>,
    nextIntentRevision: number,
    resolved: ResolvedActor,
    sourceChanged: boolean,
  ): WorkCriterionDto[] | string {
    if (inputs.length > WORK_MAX_CRITERIA) return `验收条件最多 ${WORK_MAX_CRITERIA} 项`;
    const previous = new Map(work.criteria.map(criterion => [criterion.id, criterion]));
    const next: WorkCriterionDto[] = [];
    for (const input of inputs) {
      const text = input.text?.trim().slice(0, 500);
      if (!text) continue;
      const id = input.id?.trim() || newId("criterion");
      const before = previous.get(id);
      const sameDefinition = before
        && before.text === text
        && Boolean(before.requiresRealEnvironmentCheck) === Boolean(input.requiresRealEnvironmentCheck)
        && (before.requiredEnvironment ?? "") === (input.requiredEnvironment ?? "");
      const waiverRequested = input.status === "waived";
      if (input.status && input.status !== "pending" && input.status !== "waived") {
        return "修改要求不能直接写入已满足/已失败；请提交证据或由用户豁免";
      }
      if (waiverRequested) {
        if (resolved.kind !== "user") return "只有用户可以豁免必要验收条件";
        if (!input.waiveReason?.trim()) return "豁免验收条件必须记录原因";
      }
      if (sameDefinition && !sourceChanged) {
        next.push({ ...before, text });
        continue;
      }
      next.push({
        id,
        text,
        status: waiverRequested ? "waived" : "pending",
        requiredIntentRevision: nextIntentRevision,
        requiresRealEnvironmentCheck: Boolean(input.requiresRealEnvironmentCheck),
        requiredEnvironment: input.requiredEnvironment?.trim() || undefined,
        evidenceRefs: [],
        waivedReason: waiverRequested ? input.waiveReason?.trim().slice(0, 1000) : undefined,
        waivedByUserId: waiverRequested ? resolved.userId : undefined,
      });
    }
    return next;
  }

  private resetCriteriaForNewInput(work: WorkDto, nextInputSnapshotId: string): WorkCriterionDto[] {
    if (nextInputSnapshotId === work.inputSnapshotId) return work.criteria;
    const evidence = new Map(this.repo.listEvidence(work.workId).map(item => [item.evidenceId, item]));
    return work.criteria.map(criterion => {
      const refsSnapshot = criterion.evidenceRefs
        .map(id => evidence.get(id))
        .some(item => item && item.inputSnapshotId !== nextInputSnapshotId);
      if (!refsSnapshot) return criterion;
      return {
        ...criterion,
        status: "pending",
        verifiedIntentRevision: undefined,
        evidenceRefs: [],
      };
    });
  }
}

function parseWork(value: string): WorkDto | undefined {
  try { return JSON.parse(value) as WorkDto; } catch { return undefined; }
}

function resolvedIsBot(actor: { kind: WorkActor["kind"] }): boolean { return actor.kind === "bot" || actor.kind === "worker"; }



function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); return true; } catch { return false; }
}
