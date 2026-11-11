import { reconcileWorkExecution } from "./WorkExecutionReconciliation";
import { admitWorkActionMutation } from "./WorkActionAdmission";
import { markWorkDispatchAttempt, recordWorkSubmissionReceipt } from "./WorkSubmissionMutations";
import { expireWatchTime } from "./WorkWatchExpiry";
import { WorkSubscriptionMutations } from "./WorkSubscriptionMutations";
import { WorkSubscriptionStore } from "./WorkSubscriptionStore";
import { dispatchExecutionMutation } from "./WorkDispatchMutation";
import { WorkIntentMutations } from "./WorkIntentMutations";
import { pauseWorkMutation, resumeWorkMutation } from "./WorkPauseResumeMutations";
import { handoffOwnerMutation, addParticipantMutation } from "./WorkDelegationMutations";
import { WorkClosureMutations } from "./WorkClosureMutations";
import type { Fail, Mutation, ResolvedActor } from "./WorkControlTypes";
import { WorkProjectionBuilder } from "./WorkProjectionBuilder";
import { submitDeliverableMutation, acceptDeliverableMutation, rejectDeliverableMutation, recordUserFeedbackMutation, attestCriteriaMutation } from "./WorkDeliverableMutations";
import { WorkRecordArchive } from "./WorkRecordArchive";
import { recordWorkDelivery } from "./WorkDeliveryTargets";
import { WorkAutomaticCompletion } from "./WorkAutomaticCompletion";
import { isScheduledFollowUp, scheduledFollowUpCurrent } from "./WorkScheduledFollowUp";
import { WorkRuntimeObservation } from "./WorkRuntimeObservation";
import { WorkGeneratedArtifacts } from "./WorkGeneratedArtifacts";
import { reportWorkBlockerMutation, replyUserInputMutation, replyLegacyUserInputMutation } from "./WorkUserInputControls";
import { legacyUserInputSource } from "./WorkLegacyUserInput";
import type { ReplyUserInputParams, ReplyLegacyUserInputParams } from "../../../shared/bot-work-review";
import { settleWorkAdmission } from "./WorkExecutionSettlement";
import { WorkResultCards } from "./WorkResultCards";
import { WorkPhase5Facts } from "./WorkPhase5Facts";
import { checkControlGuard, isWorkerProgressAmend } from "./WorkControlGuards";
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
  WorkControlResult,
  WorkDto,
  WorkEvidenceDto,
  WorkExecutionBindingDto,
  WorkExecutionStatus,
  WorkGoalSourceDto,
  WorkInboxEventDto,
  WorkNotificationChannel,
  WorkNotificationDto,
  WorkOutboxInstructionDto,
  WorkProjectionDto,
  WorkSourceEventDto,
  WorkSubscriptionDto,
  WorkSubscriptionInput,
  WorkWatchRuleDto,
} from "../../../shared/bot-work";
import {
  assertNoActorField,
  canonicalControlInput,
  intersectAuthorization,
  minimumAuthorization,
} from "../../../shared/bot-work";
import type { BotDto } from "../../../shared/bot-work";
import type { WorkPhase4ControlRequest, WorkPhase4ControlResult } from "../../../shared/bot-work-phase4";
import { phase4ControlRequestSchema } from "../../../shared/bot-work-phase4";
import { BotRegistry } from "./BotRegistry";
import { WorkTeamService } from "./WorkTeamService";
import { WorkRepository, newId } from "./WorkRepository";
import { cronNextWake, type WorkNextWake } from "./WorkSchedule";
import { matchesFilter } from "./WorkControlNormalization";
import { WorkNativeResultInbox } from "./WorkNativeResultInbox";
import { WorkPartialResults } from "./WorkPartialResults";
import { WorkArtifactValidation } from "./WorkArtifactValidation";
import { WorkCollaborationService } from "./WorkCollaborationService";
import { WorkNotificationDelivery } from "./WorkNotificationDelivery";
import { WorkPausedBacklog } from "./WorkPausedBacklog";
import { WorkWatchIngress } from "./WorkWatchIngress";
import { WorkCausalGuard } from "./WorkCausalGuard";
import { WorkWatchScheduler } from "./WorkWatchScheduler";
import { continuationWorkSchema, type ContinuationWorkParams } from "../../../shared/bot-work-phase3";
/** Local desktop entry envelope. It never creates branch/worktree implicitly. */
export const DESKTOP_USER_GRANTS: WorkAuthorizationDto = {
  allowedScopes: ["workspace:read", "workspace:write"],
  targetWhitelist: [],
  allowGitBranchOrWorktree: false,
  allowRedelegation: false,
};
export interface WorkServiceOptions {
  bots: BotRegistry;
  requestExpert?: (work: WorkDto, botId: string) => import("../../../shared/bot-work").ExpertConfigSnapshotDto | undefined;
  now?: () => number;
  emitProjection?: (projection: WorkProjectionDto) => void;
  computeNextWake?: WorkNextWake;
  /** Only the authoritative host may create control instructions (F14 / BW-A13). */
  isAuthority?: () => boolean;
}
const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);
export class WorkService {
  readonly automaticCompletion: WorkAutomaticCompletion;
  readonly teams: WorkTeamService;
  readonly repo: WorkRepository;
  readonly nativeResults: WorkNativeResultInbox;
  readonly partialResults: WorkPartialResults;
  readonly artifacts: WorkArtifactValidation;
  readonly generatedArtifacts: WorkGeneratedArtifacts;
  readonly runtimeObservations: WorkRuntimeObservation;
  readonly collaboration: WorkCollaborationService;
  readonly notifications: WorkNotificationDelivery;
  readonly pausedBacklog: WorkPausedBacklog;
  readonly ingress: WorkWatchIngress;
  readonly causal: WorkCausalGuard;
  readonly scheduler: WorkWatchScheduler;
  readonly cards: WorkResultCards;
  readonly phase5: WorkPhase5Facts;
  private readonly bots: BotRegistry;
  readonly recordArchive: WorkRecordArchive;
  private readonly requestExpert?: WorkServiceOptions["requestExpert"];
  private readonly now: () => number;
  private readonly emit?: (projection: WorkProjectionDto) => void;
  private readonly computeNextWake: WorkNextWake;
  private readonly authority?: () => boolean;
  private readonly lastEmitted = new Map<string, number>();
  private transactionDepth = 0;
  private readonly pendingProjections = new Set<string>();

  constructor(private readonly db: Database.Database, options: WorkServiceOptions) {
    this.repo = new WorkRepository(db);
    this.nativeResults = new WorkNativeResultInbox(db, this, () => !this.authority || this.authority());
    this.bots = options.bots;
    this.requestExpert = options.requestExpert;
    this.now = options.now ?? (() => Date.now());
    this.emit = options.emitProjection;
    this.computeNextWake = options.computeNextWake ?? cronNextWake;
    this.authority = options.isAuthority;
    this.ingress = new WorkWatchIngress(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.causal = new WorkCausalGuard(db, this, { now: this.now });
    this.scheduler = new WorkWatchScheduler(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.partialResults = new WorkPartialResults(db, this);
    this.artifacts = new WorkArtifactValidation(db, this);
    this.generatedArtifacts = new WorkGeneratedArtifacts(db, this);
    this.runtimeObservations = new WorkRuntimeObservation(id => this.repo.listBindings(id));
    this.collaboration = new WorkCollaborationService(db, this, this.bots, { now: this.now, isAuthority: () => !this.authority || this.authority() });
    this.notifications = new WorkNotificationDelivery(db, this, { now: this.now, isAuthority: () => !this.authority || this.authority(), artifacts: this.artifacts });
    this.cards = new WorkResultCards(db, this.repo);
    this.phase5 = new WorkPhase5Facts(this, this.now, db);
    this.pausedBacklog = new WorkPausedBacklog(db, this);
    this.teams = new WorkTeamService(db, this, this.bots, this.now);
    this.recordArchive = new WorkRecordArchive(db, this, this.now, () => !this.authorityError());
    this.automaticCompletion = new WorkAutomaticCompletion(db, this, (work, conclusion, summary, bindingId) => {
      this.closeWithConclusion(work, conclusion, { operationId: `automatic-completion:${bindingId}`, closureSummary: summary }, this.now());
    }, () => !this.authorityError());
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
    return new WorkProjectionBuilder({
      repo: this.repo,
      legacyUserInput: (source, blocker) => legacyUserInputSource(this.db, source, blocker),
      notifications: this.notifications, partialResults: this.partialResults,
      teams: this.teams, recordArchive: this.recordArchive,
      generatedArtifacts: this.generatedArtifacts, runtimeObservations: this.runtimeObservations,
      cards: this.cards, scheduler: this.scheduler, causal: this.causal,
      pausedBacklog: this.pausedBacklog, artifacts: this.artifacts,
      collaboration: this.collaboration, ingress: this.ingress,
    }).build(work);
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
      const mutation = this.intentMutations().create(resolved, params);
      if (!mutation.ok) return mutation;
      const { work, outboxEventId, now } = mutation;
      const workId = work.workId;
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
    return this.runWorkControl(actor, "amendWork", params, { guard: "full", ownerOnly: !(actor.kind === "worker" && isWorkerProgressAmend(params)), allowLifecycles: actor.kind === "worker" ? ["active"] : ["active", "paused"] },
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

  private intentMutations(): WorkIntentMutations {
    return new WorkIntentMutations({
      repo: this.repo, bots: this.bots, teams: this.teams, now: () => this.now(),
      computeNextWake: this.computeNextWake, requestExpert: (work, botId) => this.requestExpert?.(work, botId),
      snapshotOf: bot => this.snapshotOf(bot),
      recordDelivery: (work, params) => recordWorkDelivery(this.db, work, params),
      installSubscriptions: (work, rule, now) => this.installSubscriptions(work, rule, now),
      syncSubscriptions: (work, now, previous) => this.syncSubscriptions(work, now, previous),
      armDeadline: (work, now) => this.armDeadline(work, now),
      outbox: params => this.outbox(params),
    });
  }

  private applyAmend(work: WorkDto, resolved: ResolvedActor, params: AmendWorkParams, now: number): Mutation {
    return this.intentMutations().applyAmend(work, resolved, params, now);
  }

  // ============================================================ lifecycle

  private pauseResumeMutationDeps() {
    return {
      repo: this.repo, recordArchive: this.recordArchive, pausedBacklog: this.pausedBacklog,
      outbox: (params: Parameters<WorkService["outbox"]>[0]) => this.outbox(params),
    };
  }

  pauseWork(actor: WorkActor, params: PauseWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "pauseWork", params, { guard: "full", ownerOnly: true, allowLifecycles: ["active"] },
      (work, _resolved, now) => pauseWorkMutation(this.pauseResumeMutationDeps(), work, params, now));
  }

  resumeWork(actor: WorkActor, params: ResumeWorkParams): WorkControlResult {
    return this.runWorkControl(actor, "resumeWork", params, { guard: "full", ownerOnly: true, allowLifecycles: ["paused"] },
      (work, _resolved, now) => resumeWorkMutation(this.pauseResumeMutationDeps(), work, params, now));
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

  private closureMutations(): WorkClosureMutations {
    return new WorkClosureMutations({
      repo: this.repo, notifications: this.notifications, partialResults: this.partialResults,
      artifacts: this.artifacts, phase5: this.phase5,
      outbox: params => this.outbox(params),
      emitCurrentProjection: workId => this.emitCurrentProjection(workId),
    });
  }

  private applyCancellation(work: WorkDto, params: { operationId: string; reason?: string }, now: number): Mutation {
    return this.closureMutations().applyCancellation(work, params, now);
  }

  closeWork(actor: WorkActor, params: CloseWorkParams): WorkControlResult {
    const artifactInspection = params.conclusion === "succeeded" ? this.artifacts.capture(params.workId) : undefined;
    return this.runWorkControl(actor, "closeWork", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, resolved, now) => this.closureMutations().close(work, resolved, params, now, artifactInspection));
  }

  private closeWithConclusion(work: WorkDto, conclusion: WorkDto["closureConclusion"],
    params: { operationId: string; closureSummary?: string }, now: number): Mutation {
    return this.closureMutations().closeWithConclusion(work, conclusion, params, now);
  }

  private tryCloseSettled(work: WorkDto, now: number): Mutation {
    return this.closureMutations().tryCloseSettled(work, now);
  }

  /** Re-evaluate a previously requested stop after historical diagnostic
   * retirement, even when every native terminal receipt was already read. */
  settlePendingClosure(workId: string): void {
    if (this.authorityError()) return;
    this.transaction(() => {
      const work = this.repo.getWork(workId);
      if (work?.lifecycle !== "closing") return;
      this.tryCloseSettled(work, this.now());
      this.emitCurrentProjection(workId);
    });
  }

  /** Scheduler-owned deterministic termination, not an approval or success decision. */
  expireWatchTime(workId: string, now: number, reviewDelivered: boolean): void {
    if (this.authorityError()) return;
    this.transaction(() => expireWatchTime(this, workId, now, reviewDelivered, params => this.outbox(params)));
  }

  /** Host-only result lane: stop new rounds, settle native work, never ask for acceptance. */
  beginReviewedWatchCompletion(workId: string, bindingId: string, summary: string): void {
    if (this.authorityError()) return;
    const work = this.repo.getWork(workId);
    if (!work || work.mode !== "watch" || work.lifecycle !== "active") return;
    const now = this.now();
    const next: WorkDto = { ...work, lifecycle: "closing", pendingConclusion: undefined,
      closureSummary: summary, stateVersion: work.stateVersion + 1, updatedAt: now };
    this.repo.updateWork(next);
    this.repo.stopSubscriptionsForWork(workId, now);
    for (const binding of this.repo.listBindings(workId)) if (["pending","submitted","running","unknown"].includes(binding.status))
      this.outbox({work:next,eventType:"work.execution.stop_requested",operationId:`watch-goal:${bindingId}`,bindingId:binding.bindingId,
        payload:{bindingId:binding.bindingId,reason:"watch_goal_met"}});
    this.emitCurrentProjection(workId);
  }
  settleReviewedWatchCompletion(workId: string, bindingId: string, summary: string): boolean {
    if (this.authorityError()) return false;
    const work = this.repo.getWork(workId);
    const binding = this.repo.getBinding(bindingId);
    if (!work || !binding || work.mode !== "watch" || work.lifecycle !== "closing" || work.pendingConclusion
      || work.watchRule?.termination || binding.invalidatedAt || binding.ownerEpoch !== work.ownerEpoch
      || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId) return false;
    if (this.repo.listBindings(workId).some(b=>["pending","submitted","running","unknown"].includes(b.status))
      || this.repo.listAdmissions(workId).some(a=>a.state === "admitted")) return false;
    this.closeWithConclusion(work,"succeeded",{operationId:`watch-goal:${bindingId}`,closureSummary:summary},this.now());
    this.emitCurrentProjection(workId);
    return true;
  }

  // ============================================================ delegation

  private delegationMutationDeps() {
    return {
      repo: this.repo, bots: this.bots, collaboration: this.collaboration, phase5: this.phase5,
      snapshotOf: (bot: BotDto) => this.snapshotOf(bot),
      outbox: (params: Parameters<WorkService["outbox"]>[0]) => this.outbox(params),
    };
  }

  handoffOwner(actor: WorkActor, params: HandoffOwnerParams): WorkControlResult {
    return this.runWorkControl(actor, "handoffOwner", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"],
    }, (work, _resolved, now) => handoffOwnerMutation(this.delegationMutationDeps(), work, params, now, actor));
  }

  addParticipant(actor: WorkActor, params: AddParticipantParams): WorkControlResult {
    return this.runWorkControl(actor, "addParticipant", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused"],
    }, (work, _resolved, now) => addParticipantMutation(this.delegationMutationDeps(), work, params, now));
  }

  // ============================================================ executions

  checkTaskInput(taskId: string, operationId: string): string | undefined {
    const binding = this.repo.bindingForTask(taskId);
    if (!binding) return undefined;
    const work = this.repo.getWork(binding.workId);
    if (this.authorityError() || !work || work.lifecycle !== "active" || binding.invalidatedAt
      || !this.scheduledBindingCurrent(binding)
      || binding.operationId !== operationId || binding.intentRevision !== work.intentRevision
      || binding.inputSnapshotId !== work.inputSnapshotId || this.bots.getBot(binding.botId)?.status !== "active"
      || this.bots.getBot(work.ownerBotId)?.status !== "active"
      || (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= this.now())) {
      return "Work 当前状态不允许新的业务输入；原提交仍可查回和停止";
    }
    return undefined;
  }

  /** Validate the original timer even for continuations recovered under a new task. */
  scheduledBindingCurrent(binding: WorkExecutionBindingDto): boolean {
    const work = this.repo.getWork(binding.workId);
    return !!work && this.partialResults.recovery.ancestry(binding).every(source => {
      const event = source.inboxEventId ? this.repo.getInbox(source.inboxEventId) : undefined;
      return !isScheduledFollowUp(event) || scheduledFollowUpCurrent(work, event,
        event?.subscriptionId ? this.repo.getSubscription(event.subscriptionId) : undefined);
    });
  }

  admitTaskAction(taskId: string, input: { operationId: string; actionKind: string; paths?: string[] }): string | undefined {
    if (this.partialResults.recovery.readOnlyTask(taskId) && input.actionKind !== "workspace:read")
      return "本次恢复只读取并交付已有成果，不重做未知业务效果；请使用读取或查询工具核对原结果。";
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
      if (admission && (admission.state === "admitted" || admission.state === "unknown")) this.settleAdmission(admission.admissionId, outcome);
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
    }, (work, _resolved, now) => dispatchExecutionMutation({
      repo: this.repo, bots: this.bots, teams: this.teams, causal: this.causal,
      authorizedFor: (source, kind) => this.authorizedFor(source, kind),
      recoveryRequest: taskId => this.db.prepare(`SELECT plan.source_binding_id FROM work_dispatch_requests request
        JOIN work_continuation_plans plan ON plan.plan_id=request.continuation_plan_id
        JOIN work_automatic_recovery recovery ON recovery.plan_id=plan.plan_id WHERE request.task_id=?`).get(taskId) as { source_binding_id: string } | undefined,
      requestExpert: this.requestExpert,
      snapshotOf: bot => this.snapshotOf(bot),
      outbox: params => this.outbox(params),
    }, work, params, now));
  }

  /** Allowed regardless of lifecycle: it is recovery of an already-attempted submission. */
  markDispatchAttempt(bindingId: string, attemptId: string): { ok: boolean; message?: string } {
    const binding = this.repo.getBinding(bindingId);
    if (!binding) return { ok: false, message: "找不到执行绑定" };
    this.transaction(() => {
      markWorkDispatchAttempt(this.repo, binding, attemptId);
    });
    return { ok: true };
  }

  /** Saves the native submission receipt while still in the original namespace. */
  recordSubmissionReceipt(bindingId: string, submissionReceipt: string): { ok: boolean; message?: string } {
    const binding = this.repo.getBinding(bindingId);
    if (!binding) return { ok: false, message: "找不到执行绑定" };
    this.transaction(() => {
      recordWorkSubmissionReceipt(this.repo, binding, submissionReceipt, this.now);
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
      return reconcileWorkExecution({ repo: this.repo, authorityError: () => this.authorityError(), now: this.now,
        tryClose: (work, now) => this.tryCloseSettled(work, now) }, resolved, params);
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
      return admitWorkActionMutation({
        repo: this.repo, bots: this.bots, now: this.now,
        isDelegationAdopted: (binding, source) => this.collaboration.isDelegationAdopted(binding, source),
        scheduledBindingCurrent: binding => this.scheduledBindingCurrent(binding),
        sourceReadOnly: binding => this.partialResults.recovery.sourceReadOnly(binding),
      }, work, resolved, params);
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

  private deliverableMutationDeps() {
    return {
      repo: this.repo, collaboration: this.collaboration, artifacts: this.artifacts, phase5: this.phase5,
      emitCurrentProjection: (workId: string) => this.emitCurrentProjection(workId),
      outbox: (params: Parameters<WorkService["outbox"]>[0]) => this.outbox(params),
    };
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
      const mutation = submitDeliverableMutation(this.deliverableMutationDeps(), work, resolved, params, () => this.now());
      if (!mutation.ok) return mutation;
      const { work: next, outboxEventId, now } = mutation;
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
    }, (work, resolved, now) => acceptDeliverableMutation(this.deliverableMutationDeps(), work, resolved, params, now, artifactInspection, this.isOwnerOrUser(work, resolved)));
  }

  rejectDeliverable(actor: WorkActor, params: RejectDeliverableParams): WorkControlResult {
    return this.runWorkControl(actor, "rejectDeliverable", params, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing"],
    }, (work, resolved, now) => rejectDeliverableMutation(this.deliverableMutationDeps(), work, resolved, params, now));
  }

  // ============================================================ user feedback

  recordUserFeedback(actor: WorkActor, params: RecordUserFeedbackParams): WorkControlResult {
    const resolved = this.resolveActor(actor);
    if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
    if (resolved.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "实测反馈必须来自已认证用户入口" };
    const artifactInspection = this.artifacts.capture(params.workId);
    return this.runWorkControl(actor, "recordUserFeedback", params, {
      guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused", "closing"],
    }, (work, _resolved, now) => recordUserFeedbackMutation(this.deliverableMutationDeps(), work, resolved, params, now, artifactInspection));
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
    }, (work, resolved, now) => attestCriteriaMutation(this.deliverableMutationDeps(), work, resolved, params, now, artifactInspection));
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
   * No tool permission, effect, execution or acceptance fact is changed. */
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
      return this.subscriptionMutations().addSubscription(work, input);
    });
  }

  stopSubscription(actor: WorkActor, workId: string, subscriptionId: string): { ok: true } | Fail {
    return this.transaction(() => {
      const resolved = this.resolveActor(actor);
      if (typeof resolved === "string") return { ok: false, code: "unauthorized_actor", message: resolved };
      const work = this.repo.getWork(workId);
      if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (!this.isOwnerOrUser(work, resolved)) return { ok: false, code: "unauthorized_actor", message: "只有负责人或用户可停止关注规则" };
      return this.subscriptionMutations().stopSubscription(work, subscriptionId);
    });
  }

  private subscriptionMutations(): WorkSubscriptionMutations {
    return new WorkSubscriptionMutations({
      repo: this.repo, teams: this.teams, ingress: this.ingress,
      storage: new WorkSubscriptionStore(this.db), now: () => this.now(),
      computeNextWake: (...args) => this.computeNextWake(...args),
    });
  }

  private installSubscriptions(work: WorkDto, rule: WorkWatchRuleDto, now: number): void {
    this.subscriptionMutations().installSubscriptions(work, rule, now);
  }

  private syncSubscriptions(work: WorkDto, now: number, previous?: WorkWatchRuleDto): void {
    this.subscriptionMutations().syncSubscriptions(work, now, previous);
  }

  private armDeadline(work: WorkDto, now: number): void {
    this.subscriptionMutations().armDeadline(work, now);
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

  /** Guarded IPC/API entry for subscription and deadline changes. */
  phase4Control(actor: WorkActor, request: unknown): WorkPhase4ControlResult {
    const parsed = phase4ControlRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message ?? "Phase 4 控制请求无效" };
    const input = parsed.data as WorkPhase4ControlRequest;
    let subscriptionId: string | undefined = "subscriptionId" in input ? input.subscriptionId : undefined;
    const result = this.runWorkControl(actor, `phase4:${input.kind}`, input as unknown as
      { operationId: string; workId: string; versionGuard?: ExpectedVersionGuard }, {
      guard: "full", ownerOnly: true,
      allowLifecycles: ["active", "paused"],
    }, (work, resolved, now) => this.applyPhase4Control(work, input, resolved, now));
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    if (input.kind === "configure-subscription") {
      // Read the original operation's durable result, never another call's scratch state.
      // Legacy receipts without this metadata can only identify explicitly supplied IDs.
      const receipt = this.repo.getReceipt(result.work.userId, input.operationId);
      let recordedId: unknown;
      try { recordedId = receipt && JSON.parse(receipt.result_snapshot_json)._controlResult?.subscriptionId; } catch { /* historical receipt */ }
      subscriptionId = typeof recordedId === "string" ? recordedId : input.subscriptionId;
    }
    if (input.kind === "retry-backlog") subscriptionId = input.subscriptionId;
    return { ok: true, replayed: result.replayed, operationId: input.operationId, workId: result.work.workId,
      subscriptionId, deadlineAt: result.work.deadlineAt };
  }

  private applyPhase4Control(work: WorkDto, input: WorkPhase4ControlRequest, resolved: ResolvedActor, now: number): Mutation {
    return this.subscriptionMutations().applyPhase4Control(work, input, resolved, now);
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
        && !(operationType === "cancelWork" || operationType === "closeWork")) {
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
        outboxEventId: mutation.outboxEventId, receiptMetadata: mutation.receiptMetadata,
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
    const timing = params as { deadlineAt?: unknown; mode?: unknown };
    if (["createWork", "amendWork"].includes(operationType)) {
      if (timing.deadlineAt !== undefined && !(operationType === "amendWork" && timing.deadlineAt === null)
        && (typeof timing.deadlineAt !== "number" || !Number.isSafeInteger(timing.deadlineAt) || timing.deadlineAt < 0))
        return { ok: false, code: "invalid_request", message: "承诺期限必须是 Unix 毫秒时间戳" };
      if (timing.mode !== undefined && timing.mode !== "once" && timing.mode !== "watch")
        return { ok: false, code: "invalid_request", message: "事项模式无效" };
    }
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


}

function parseWork(value: string): WorkDto | undefined {
  try {
    const snapshot = JSON.parse(value) as WorkDto & { budget?: unknown; budgetPolicy?: unknown; _controlResult?: unknown };
    // Historical receipts stay unchanged on disk, but replay uses today's DTO.
    delete snapshot.budget; delete snapshot.budgetPolicy; delete snapshot._controlResult;
    if (snapshot.authorization) {
      const authorization = { ...snapshot.authorization } as WorkDto["authorization"] & { budgetLimitTokens?: unknown };
      delete authorization.budgetLimitTokens;
      snapshot.authorization = authorization;
    }
    return snapshot;
  } catch { return undefined; }
}
