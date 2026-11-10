import type { WorkDto, WorkSubscriptionDto, WorkSubscriptionInput, WorkWatchRuleDto } from "../../../shared/bot-work";
import type { WorkPhase4ControlRequest } from "../../../shared/bot-work-phase4";
import { newId, type WorkRepository } from "./WorkRepository";
import type { WorkTeamService } from "./WorkTeamService";
import type { WorkWatchIngress } from "./WorkWatchIngress";
import type { WorkNextWake } from "./WorkSchedule";
import type { WorkSubscriptionStore } from "./WorkSubscriptionStore";
import type { Fail, Mutation, ResolvedActor } from "./WorkControlTypes";

interface SubscriptionMutationDeps {
  repo: Pick<WorkRepository, "getSubscription" | "listSubscriptions" | "updateSubscription" | "insertSubscription" | "updateWork" | "listOpenBlockers" | "clearBlocker">;
  teams: Pick<WorkTeamService, "get">;
  ingress: Pick<WorkWatchIngress, "setCursor" | "adapter" | "refillBlocked">;
  storage: Pick<WorkSubscriptionStore, "discardPendingSchedule" | "rearmDeadline" | "discardRejectedRoutes">;
  now: () => number;
  computeNextWake: WorkNextWake;
}

/** Subscription facts use the facade's transaction; scheduling and replay semantics are unchanged. */
export class WorkSubscriptionMutations {
  constructor(private readonly deps: SubscriptionMutationDeps) {}

  addSubscription(work: WorkDto, input: WorkSubscriptionInput): { ok: true; subscription: WorkSubscriptionDto } | Fail {
    if (this.deps.teams.get(work.workId)) return { ok: false, code: "invalid_request", message: "团队委托暂不支持附加关注规则；请新建独立的只读关注事项" };
    if (!input.source?.trim()) return { ok: false, code: "invalid_request", message: "订阅来源不能为空" };
    if (!input.catchUpPolicy) return { ok: false, code: "invalid_request", message: "订阅必须显式保存补处理策略" };
    const now = this.deps.now();
    const existing = input.subscriptionId
      ? this.deps.repo.getSubscription(input.subscriptionId)
      : this.deps.repo.listSubscriptions(work.workId).find(item => !item.stoppedAt && item.source === input.source);
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
      nextWakeAt: input.nextWakeAt ?? this.deps.computeNextWake({ cronExpression: input.cronExpression ?? existing.cronExpression,
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
      nextWakeAt: input.nextWakeAt ?? this.deps.computeNextWake({
        cronExpression: input.cronExpression, timezone: input.timezone, nextWakeAt: input.nextWakeAt,
      }, now),
      createdAt: now,
      updatedAt: now,
    };
    if (existing) this.deps.repo.updateSubscription(subscription);
    else {
      this.deps.repo.insertSubscription(subscription);
      this.deps.ingress.setCursor(subscription.subscriptionId, subscription.source,
        subscription.sourceTarget ?? this.deps.ingress.adapter(subscription.source)?.targetKeyOf({ eventType: "", payload: {} }) ?? "default", {});
    }
    this.deps.repo.updateWork({
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
  }

  stopSubscription(work: WorkDto, subscriptionId: string): { ok: true } | Fail {
    const subscription = this.deps.repo.getSubscription(subscriptionId);
    if (!subscription || subscription.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
    const now = this.deps.now();
    this.deps.repo.updateSubscription({ ...subscription, stoppedAt: now, updatedAt: now });
    this.deps.repo.updateWork(this.syncWatchRuleSources(work, now));
    return { ok: true };
  }

  /** watchRule.subscriptions is a source-name set; it never stores subscription primary keys. */
  private syncWatchRuleSources(work: WorkDto, now: number): WorkDto {
    if (!work.watchRule) return work;
    const active = [...new Set(this.deps.repo.listSubscriptions(work.workId).filter(item => !item.stoppedAt).map(item => item.source))];
    const current = work.watchRule.subscriptions;
    const next = [...new Set([...current.filter(source => active.includes(source)), ...active])];
    if (JSON.stringify(next) === JSON.stringify(current)) return work;
    return { ...work, watchRule: { ...work.watchRule, subscriptions: next },
      stateVersion: work.stateVersion + 1, updatedAt: now };
  }

  installSubscriptions(work: WorkDto, rule: WorkWatchRuleDto, now: number): void {
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
        nextWakeAt: this.deps.computeNextWake({ cronExpression: rule.cronExpression, timezone: rule.timezone, nextWakeAt: rule.nextWakeAt }, now),
        createdAt: now,
        updatedAt: now,
      };
      this.deps.repo.insertSubscription(subscription);
    }
  }

  syncSubscriptions(work: WorkDto, now: number, previous?: WorkWatchRuleDto): void {
    const rule = work.watchRule;
    const existing = this.deps.repo.listSubscriptions(work.workId);
    const wanted = new Set(rule?.subscriptions ?? []);
    for (const subscription of existing) {
      if (!wanted.has(subscription.source) && !subscription.stoppedAt) {
        this.deps.repo.updateSubscription({ ...subscription, stoppedAt: now, stoppedReason: "用户停止持续跟踪", updatedAt: now });
        this.discardPendingSchedule(subscription.subscriptionId, now);
      }
    }
    if (!rule) return;
    for (const source of wanted) {
      const current = existing.find(subscription => subscription.source === source && !subscription.stoppedAt);
      const scheduleChanged = !current || current.cronExpression !== rule.cronExpression || current.timezone !== rule.timezone
        || previous?.nextWakeAt !== rule.nextWakeAt || current.catchUpPolicy !== rule.catchUpPolicy;
      if (current && scheduleChanged) this.discardPendingSchedule(current.subscriptionId, now);
      const subscription: WorkSubscriptionDto = {
        ...current, subscriptionId: current?.subscriptionId ?? newId("subscription"), workId: work.workId, source,
        filter: current?.filter ?? {}, catchUpPolicy: rule.catchUpPolicy, maxMergeWaitMs: rule.maxMergeWaitMs,
        maxQueueDepth: rule.maxQueueDepth, stopConditionText: rule.stopConditionText, timezone: rule.timezone,
        cronExpression: rule.cronExpression,
        nextWakeAt: scheduleChanged ? this.deps.computeNextWake({ cronExpression: rule.cronExpression, timezone: rule.timezone,
          nextWakeAt: rule.nextWakeAt !== undefined && rule.nextWakeAt > now ? rule.nextWakeAt : undefined }, now) : current.nextWakeAt,
        scheduleRevision: current ? (current.scheduleRevision ?? 1) + (scheduleChanged ? 1 : 0) : 1,
        configRevision: (current?.configRevision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now,
      };
      if (current) this.deps.repo.updateSubscription(subscription); else this.deps.repo.insertSubscription(subscription);
    }
  }

  private discardPendingSchedule(subscriptionId: string, now: number): void {
    this.deps.storage.discardPendingSchedule(subscriptionId, now);
  }

  armDeadline(work: WorkDto, now: number): void {
    // The superseded deadline remains in history but must not block a later
    // cancelled/finished responsibility after the user changed that commitment.
    for (const blocker of this.deps.repo.listOpenBlockers(work.workId)) if (blocker.reasonCode === "deadline-follow-up")
      this.deps.repo.clearBlocker(blocker.blockerId, work.workId, now);
    this.deps.storage.rearmDeadline(work, now);
  }

  applyPhase4Control(work: WorkDto, input: WorkPhase4ControlRequest, resolved: ResolvedActor, now: number): Mutation {
    if (this.deps.teams.get(work.workId) && (input.kind === "configure-subscription" || input.kind === "set-deadline" && input.deadlineAt != null))
      return { ok: false, code: "invalid_request", message: "团队委托暂不支持附加定时关注或期限检查；请新建独立的只读关注事项" };
    if (input.kind === "configure-subscription") {
      const existing = input.subscriptionId
        ? this.deps.repo.getSubscription(input.subscriptionId)
        : this.deps.repo.listSubscriptions(work.workId).find(item => !item.stoppedAt && item.source === input.source
          && (input.targetKey === undefined ? item.sourceTarget === undefined : item.sourceTarget === input.targetKey));
      if (existing && existing.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
      const timezone = input.timezone ?? existing?.timezone;
      const cronExpression = input.cronExpression ?? existing?.cronExpression;
      if (timezone !== undefined && !validTimezone(timezone)) return { ok: false, code: "invalid_request", message: "时区必须是可以解析的 IANA 名称" };
      const timingChanged = cronExpression !== existing?.cronExpression || timezone !== existing?.timezone
        || input.nextWakeAt !== undefined && input.nextWakeAt !== existing?.nextWakeAt;
      const scheduleChanged = timingChanged
        || existing !== undefined && input.catchUpPolicy !== existing.catchUpPolicy;
      let nextWakeAt: number | undefined;
      try { nextWakeAt = input.nextWakeAt ?? this.deps.computeNextWake({ cronExpression, timezone }, now); }
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
      if (existing && scheduleChanged) this.discardPendingSchedule(existing.subscriptionId, now);
      if (existing) this.deps.repo.updateSubscription(subscription);
      else {
        this.deps.repo.insertSubscription(subscription);
        this.deps.ingress.setCursor(subscription.subscriptionId, subscription.source,
          subscription.sourceTarget ?? this.deps.ingress.adapter(subscription.source)?.targetKeyOf({ eventType: "", payload: {} }) ?? "default", {});
      }
      this.deps.repo.updateWork({ ...work, watchRule: {
        ...(work.watchRule ?? { subscriptions: [], catchUpPolicy: subscription.catchUpPolicy,
          maxMergeWaitMs: subscription.maxMergeWaitMs, maxQueueDepth: subscription.maxQueueDepth }),
        subscriptions: [...new Set([...(work.watchRule?.subscriptions ?? []), subscription.source])],
        nextWakeAt: subscription.nextWakeAt ?? work.watchRule?.nextWakeAt,
        ...(timingChanged ? { scheduleBasis: undefined, scheduleRationale: undefined } : {}),
      }, stateVersion: work.stateVersion + 1, updatedAt: now });
      return { ok: true, receiptMetadata: { subscriptionId: subscription.subscriptionId } };
    }
    if (input.kind === "stop-subscription") {
      const subscription = this.deps.repo.getSubscription(input.subscriptionId);
      if (!subscription || subscription.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
      this.deps.repo.updateSubscription({ ...subscription, stoppedAt: now, stoppedReason: input.reason, updatedAt: now });
      this.discardPendingSchedule(subscription.subscriptionId, now);
      this.deps.repo.updateWork(this.syncWatchRuleSources(work, now));
      return { ok: true };
    }
    if (input.kind === "set-deadline") {
      const changed = (work.deadlineAt ?? null) !== (input.deadlineAt ?? null);
      const revision = changed ? work.deadlineRevision + 1 : work.deadlineRevision;
      const next = { ...work, deadlineAt: input.deadlineAt ?? undefined, deadlineRevision: revision,
        deadlineSetAt: now, stateVersion: work.stateVersion + 1, updatedAt: now };
      if (changed) this.armDeadline(next, now);
      this.deps.repo.updateWork(next);
      return { ok: true };
    }
    // retry-backlog: allow the source to redeliver hard-refused routes and refill the finite overflow.
    const subscription = this.deps.repo.getSubscription(input.subscriptionId);
    if (!subscription || subscription.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到订阅" };
    this.deps.storage.discardRejectedRoutes(subscription.subscriptionId);
    this.deps.ingress.refillBlocked(subscription);
    this.deps.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
    return { ok: true };
  }

}

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); return true; } catch { return false; }
}
