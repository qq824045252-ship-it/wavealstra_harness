import type { AmendWorkParams, CreateWorkParams, WorkDto, WorkCriterionDto, WorkExecutionBindingDto, WorkExecutionStatus, WorkWatchRuleDto, WorkIntentSnapshotDto, BotDto, ExpertConfigSnapshotDto } from "../../../shared/bot-work";
import { DEFAULT_BOT_ID, WORK_MAX_CRITERIA, intersectAuthorization } from "../../../shared/bot-work";
import { newId, type WorkRepository } from "./WorkRepository";
import type { BotRegistry } from "./BotRegistry";
import type { WorkTeamService } from "./WorkTeamService";
import { checkWorkerProgress } from "./WorkControlGuards";
import { watchRuleProblem, type WorkNextWake } from "./WorkSchedule";
import { normalizeCriteria, normalizeTexts, normalizeSources, normalizeWatchRule, currentAcceptedDeliverableIds } from "./WorkControlNormalization";
import type { Fail, Mutation, ResolvedActor } from "./WorkControlTypes";

interface IntentMutationDeps {
  repo: Pick<WorkRepository, "insertWork" | "insertIntentSnapshot" | "linkConversation" | "listBindings" | "getBinding" | "updateBinding" | "supersedeStaleDeliverables" | "listDeliverables" | "supersedeNotifications" | "updateWork" | "listEvidence">;
  bots: Pick<BotRegistry, "getBot">;
  teams: Pick<WorkTeamService, "get">;
  now: () => number;
  computeNextWake: WorkNextWake;
  requestExpert?: (work: WorkDto, botId: string) => ExpertConfigSnapshotDto | undefined;
  snapshotOf: (bot: BotDto) => ExpertConfigSnapshotDto;
  recordDelivery: (work: WorkDto, params: CreateWorkParams) => void;
  installSubscriptions: (work: WorkDto, rule: WorkWatchRuleDto, now: number) => void;
  syncSubscriptions: (work: WorkDto, now: number, previous?: WorkWatchRuleDto) => void;
  armDeadline: (work: WorkDto, now: number) => void;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; bindingId?: string; causalEventId?: string; payload: Record<string, unknown> }) => string;
}
const TERMINAL_BINDING_STATUSES = new Set<WorkExecutionStatus>(["completed", "failed", "stopped", "invalidated"]);
const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);

/** Intent facts share the caller's transaction; control, replay and receipt stay in the facade. */
export class WorkIntentMutations {
  constructor(private readonly deps: IntentMutationDeps) {}

  create(resolved: ResolvedActor, params: CreateWorkParams): { ok: true; work: WorkDto; outboxEventId: string; now: number } | Fail {
    if (!params.title?.trim()) return { ok: false, code: "invalid_request", message: "Work 标题不能为空" };
    const ownerBot = this.deps.bots.getBot(params.ownerBotId ?? (resolved.bot?.botId ?? DEFAULT_BOT_ID));
    if (!ownerBot) return { ok: false, code: "not_found", message: "找不到负责人 Bot" };
    if (ownerBot.userId !== resolved.userId) {
      return { ok: false, code: "unauthorized_actor", message: "负责人 Bot 不属于当前用户" };
    }
    if (ownerBot.status !== "active") {
      return { ok: false, code: "bot_disabled", message: "Bot 已停用，不能分配新事项" };
    }
    const now = this.deps.now();
    const workId = newId("work");
    const criteria = normalizeCriteria(params.criteria, 1, now);
    if (typeof criteria === "string") return { ok: false, code: "invalid_request", message: criteria };
    const authorization = intersectAuthorization(params.authorization, resolved.grants);
    const inputSnapshotId = params.inputSnapshotId?.trim() || "snapshot:unbound";
    const goalSources = normalizeSources(params.goalSources, now);
    const watchRule = normalizeWatchRule(params.watchRule);
    const scheduleProblem = watchRuleProblem(watchRule, now, this.deps.computeNextWake);
    if (scheduleProblem) return { ok: false, code: "invalid_request", message: scheduleProblem };
    const mode = params.mode ?? (watchRule ? "watch" : "once");
    if (mode === "once" && watchRule) return { ok: false, code: "invalid_request", message: "持续跟踪规则需要 watch 模式" };
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
      mode,
      lifecycle: "active",
      deadlineAt: params.deadlineAt,
      deadlineRevision: 1,
      deadlineSetAt: params.deadlineAt === undefined ? undefined : now,
      acceptedDeliverableIds: [],
      activeExecutionIds: [],
      stateVersion: 1,
      watchRule,
      createdBy: resolved.kind === "user" ? "user" : "bot",
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.insertWork(work);
    this.deps.recordDelivery(work, params);
    this.deps.repo.insertIntentSnapshot(this.intentSnapshot(work, ownerBot, params.sourceMessageId, work.createdBy));
    if (params.conversationId) this.deps.repo.linkConversation(workId, params.conversationId, "desktop", now);
    if (watchRule) this.deps.installSubscriptions(work, watchRule, now);
    if (work.deadlineAt !== undefined) this.deps.armDeadline(work, now);
    const outboxEventId = this.deps.outbox({
      work, eventType: "work.created", operationId: params.operationId,
      bindingId: undefined, causalEventId: params.causalEventId,
      payload: { title: work.title, mode: work.mode },
    });
    return { ok: true, work, outboxEventId, now };
  }

  applyAmend(work: WorkDto, resolved: ResolvedActor, params: AmendWorkParams, now: number): Mutation {
    const progressError = resolved.kind === "worker" ? checkWorkerProgress(work, params, resolved.binding) : undefined;
    if (progressError) return progressError;
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
    const nextWatchRule = params.watchRule === null ? undefined : params.watchRule === undefined ? work.watchRule
      : normalizeWatchRule({ ...work.watchRule, ...params.watchRule,
        ...(params.watchRule.cronExpression !== undefined && params.watchRule.nextWakeAt === undefined ? { nextWakeAt: undefined } : {}),
        ...(params.watchRule.nextWakeAt !== undefined && params.watchRule.cronExpression === undefined ? { cronExpression: undefined } : {}) });
    if (params.watchRule && nextWatchRule) {
      const timingChanged = nextWatchRule.cronExpression !== work.watchRule?.cronExpression
        || nextWatchRule.timezone !== work.watchRule?.timezone
        || nextWatchRule.nextWakeAt !== work.watchRule?.nextWakeAt;
      // Provenance describes a particular schedule, not the Work forever.
      if (timingChanged && params.watchRule.scheduleBasis === undefined) {
        delete nextWatchRule.scheduleBasis;
        delete nextWatchRule.scheduleRationale;
      } else if (params.watchRule.scheduleBasis === "user_specified"
        || timingChanged && params.watchRule.scheduleRationale === undefined) {
        delete nextWatchRule.scheduleRationale;
      }
    }
    const nextMode = params.mode ?? (params.watchRule === null ? "once" : params.watchRule ? "watch" : work.mode);
    if (params.mode === "once" && nextWatchRule) return { ok: false, code: "invalid_request", message: "清除持续跟踪规则后才可改为一次性事项" };
    const scheduleProblem = params.watchRule ? watchRuleProblem({ ...nextWatchRule!,
      // An unchanged, already-fired first wake is history, not a new invalid date.
      nextWakeAt: params.watchRule.nextWakeAt }, now, this.deps.computeNextWake) : undefined;
    if (scheduleProblem) return { ok: false, code: "invalid_request", message: scheduleProblem };
    const nextDeadlineAt = params.deadlineAt === undefined ? work.deadlineAt : params.deadlineAt ?? undefined;
    const deadlineChanged = nextDeadlineAt !== work.deadlineAt;
    if (this.deps.teams.get(work.workId) && (params.watchRule != null || deadlineChanged && nextDeadlineAt !== undefined))
      return { ok: false, code: "invalid_request", message: "团队委托暂不支持附加定时关注或期限检查；请新建独立的只读关注事项" };
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
    const definition = (criterion: WorkCriterionDto) => [criterion.id, criterion.text, criterion.origin, criterion.requiresRealEnvironmentCheck, criterion.requiredEnvironment ?? ""];
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
      mode: nextMode,
      deadlineAt: nextDeadlineAt,
      deadlineRevision: deadlineChanged ? work.deadlineRevision + 1 : work.deadlineRevision,
      deadlineSetAt: deadlineChanged ? now : work.deadlineSetAt,
      progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
      stateVersion: nextStateVersion,
      updatedAt: now,
    };

    const invalidated = new Set(params.invalidateExecutionIds ?? []);
    if (intentChanged || sourceChanged) {
      for (const binding of this.deps.repo.listBindings(work.workId)) {
        if (!TERMINAL_BINDING_STATUSES.has(binding.status)) invalidated.add(binding.bindingId);
      }
    }
    const invalidatedBindings: WorkExecutionBindingDto[] = [];
    for (const bindingId of invalidated) {
      const binding = this.deps.repo.getBinding(bindingId);
      if (!binding || binding.workId !== work.workId) continue;
      if (binding.invalidatedAt) continue;
      const neverSubmitted = binding.status === "pending" && !binding.attemptId && !binding.submissionReceipt;
      const nextBinding: WorkExecutionBindingDto = {
        ...binding,
        invalidatedAt: now,
        status: neverSubmitted ? "invalidated" : binding.status,
        settledAt: neverSubmitted ? now : binding.settledAt,
      };
      this.deps.repo.updateBinding(nextBinding);
      invalidatedBindings.push(nextBinding);
    }
    nextWork.activeExecutionIds = this.deps.repo.listBindings(work.workId)
      .filter(binding => UNSETTLED_BINDING_STATUSES.has(binding.status)).map(binding => binding.bindingId);

    const ownerBot = this.deps.bots.getBot(nextWork.ownerBotId);
    if (!ownerBot) return { ok: false, code: "not_found", message: "找不到负责人 Bot" };
    if (snapshotChanged) {
      this.deps.repo.insertIntentSnapshot(this.intentSnapshot(nextWork, ownerBot, params.sourceMessageId, resolved.kind === "user" ? "user" : "bot"));
    }
    this.deps.repo.supersedeStaleDeliverables(work.workId, nextIntentRevision, nextInputSnapshotId);
    nextWork.acceptedDeliverableIds = currentAcceptedDeliverableIds(
      nextWork, this.deps.repo.listDeliverables(work.workId), this.deps.repo.listBindings(work.workId),
    );
    this.deps.repo.supersedeNotifications(work.workId, nextIntentRevision, nextInputSnapshotId);
    this.deps.repo.updateWork(nextWork);
    if (params.watchRule !== undefined) this.deps.syncSubscriptions(nextWork, now, work.watchRule);
    if (deadlineChanged) this.deps.armDeadline(nextWork, now);
    const outboxEventId = this.deps.outbox({
      work: nextWork, eventType: "work.amended", operationId: params.operationId,
      causalEventId: params.causalEventId,
      payload: {
        previousRevision: work.intentRevision, nextRevision: nextIntentRevision,
        previousSourceVersion: work.sourceVersion, nextSourceVersion,
        invalidatedExecutions: invalidatedBindings.map(binding => binding.bindingId),
      },
    });
    for (const binding of invalidatedBindings) {
      this.deps.outbox({
        work: nextWork, eventType: "work.execution.stop_requested", operationId: params.operationId,
        bindingId: binding.bindingId, payload: { bindingId: binding.bindingId, reason: "requirement_changed" },
      });
    }
    return { ok: true, outboxEventId };
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
      expertSnapshot: this.deps.requestExpert?.(work, ownerBot.botId) ?? this.deps.snapshotOf(ownerBot),
      inputSnapshotId: work.inputSnapshotId,
      goalSources: work.goalSources,
      createdBy,
      sourceMessageId,
      createdAt: work.updatedAt,
    };
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
        && before.origin === input.origin
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
        ...(input.origin === "assistant_proposal" ? { origin: input.origin } : {}),
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
    const evidence = new Map(this.deps.repo.listEvidence(work.workId).map(item => [item.evidenceId, item]));
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
