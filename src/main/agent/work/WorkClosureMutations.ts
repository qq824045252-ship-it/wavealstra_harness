import type { CloseWorkParams, WorkActor, WorkDto, WorkExecutionStatus } from "../../../shared/bot-work";
import { isCriterionResolved, isRequiredCriterion } from "../../../shared/bot-work";
import { newId, type WorkRepository } from "./WorkRepository";
import type { WorkArtifactValidation, ArtifactInspection } from "./WorkArtifactValidation";
import type { WorkNotificationDelivery } from "./WorkNotificationDelivery";
import type { WorkPartialResults } from "./WorkPartialResults";
import type { WorkPhase5Facts } from "./WorkPhase5Facts";
import type { Mutation, ResolvedActor } from "./WorkControlTypes";

interface ClosureMutationDeps {
  repo: Pick<WorkRepository, "updateWork" | "listBindings" | "listAdmissions" | "listOpenBlockers" | "getBlocker" | "clearBlocker" | "stopSubscriptionsForWork" | "insertNotification">;
  notifications: Pick<WorkNotificationDelivery, "supersede">;
  partialResults: Pick<WorkPartialResults, "gaps">;
  artifacts: Pick<WorkArtifactValidation, "validate">;
  phase5: Pick<WorkPhase5Facts, "recordClosure">;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; bindingId?: string; payload: Record<string, unknown> }) => string;
  emitCurrentProjection: (workId: string) => unknown;
}
const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);

/** Closing mutations use their caller's transaction. They do not own receipts or publication. */
export class WorkClosureMutations {
  constructor(private readonly deps: ClosureMutationDeps) {}

  applyCancellation(work: WorkDto, params: { operationId: string; reason?: string }, now: number): Mutation {
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
      this.deps.repo.updateWork(next);
      this.deps.notifications.supersede(work.workId, "cancelled");
      this.deps.outbox({
        work: next, eventType: "work.cancel_requested", operationId: params.operationId,
        payload: { reason: params.reason, activeExecutionIds: next.activeExecutionIds },
      });
      for (const binding of this.deps.repo.listBindings(next.workId)) {
        if (UNSETTLED_BINDING_STATUSES.has(binding.status)) {
          this.deps.outbox({
            work: next, eventType: "work.execution.stop_requested", operationId: params.operationId,
            bindingId: binding.bindingId, payload: { bindingId: binding.bindingId, reason: "cancel_requested" },
          });
        }
      }
    }
    const settled = this.tryCloseSettled(next, now);
    return { ok: true, outboxEventId: settled.ok ? settled.outboxEventId : undefined };
  }

  close(work: WorkDto, _resolved: ResolvedActor, params: CloseWorkParams, now: number, artifactInspection?: ArtifactInspection): Mutation {
    if (artifactInspection && !this.deps.artifacts.validate(artifactInspection, now)) {
      this.deps.emitCurrentProjection(work.workId);
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
      const gaps = this.deps.partialResults.gaps(work.workId);
      if (gaps.length) return { ok: false, code: "unmet_acceptance_criteria", message: `必要子项仍有未覆盖缺口，不能按完成关闭：${gaps.slice(0, 10).map(item => `${item.task || item.itemId}（${item.outcome}）：${item.summary || "缺少完成凭据"}`).join("；")}${gaps.length > 10 ? `；另有 ${gaps.length - 10} 项，请查看必要子项缺口列表` : ""}` };
      const unmet = work.criteria.find((criterion) => isRequiredCriterion(criterion) && !isCriterionResolved(criterion));
      if (unmet) {
        return {
          ok: false, code: "unmet_acceptance_criteria",
          message: `验收条件尚未在当前要求下满足：${unmet.text}`,
        };
      }
      const openBlockers = this.deps.repo.listOpenBlockers(work.workId);
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
    this.clearStoppedExecutionBlockers(work.workId, now);
    if (this.isSettled(work)) {
      return this.closeWithConclusion(work, "ended_unsuccessfully", params, now);
    }
    const next: WorkDto = {
      ...work, lifecycle: "closing", pendingConclusion: "ended_unsuccessfully",
      closureSummary: params.closureSummary, stateVersion: work.stateVersion + 1, updatedAt: now,
    };
    this.deps.repo.updateWork(next);
    this.deps.outbox({
      work: next, eventType: "work.cancel_requested", operationId: params.operationId,
      payload: { reason: params.closureSummary, conclusion: "ended_unsuccessfully" },
    });
    return { ok: true };
  }

  /** Only system-owned blockers for future execution become moot when stopping.
   * Unknown external effects and reconciliation conflicts must still be settled. */
  private clearStoppedExecutionBlockers(workId: string, now: number): void {
    for (const blocker of this.deps.repo.listOpenBlockers(workId)) {
      if (blocker.blockerId.startsWith("offline:") && blocker.kind === "operational" && !blocker.unknownExternalEffectRef
        && (blocker.reasonCode === "deadline-follow-up" || blocker.reasonCode === "unqueryable-offline-gap"))
        this.deps.repo.clearBlocker(blocker.blockerId, workId, now);
    }
    for (const binding of this.deps.repo.listBindings(workId)) {
      const blocker = this.deps.repo.getBlocker(`continuation:${binding.bindingId}`);
      if (blocker?.kind === "operational" && !blocker.unknownExternalEffectRef) this.deps.repo.clearBlocker(blocker.blockerId, workId, now);
    }
  }

  closeWithConclusion(
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
    this.deps.repo.updateWork(next);
    this.deps.repo.stopSubscriptionsForWork(work.workId, now);
    const outboxEventId = this.deps.outbox({
      work: next, eventType: "work.closed", operationId: params.operationId,
      payload: { conclusion, closureSummary: next.closureSummary, closedAt: now },
    });
    const card = this.deps.phase5.recordClosure(next, conclusion ?? "ended_unsuccessfully", now);
    if (!card.suppressNotification) this.deps.repo.insertNotification({
      notificationId: newId("notification"),
      workId: work.workId,
      semanticKey: `work:${work.workId}:closed:${conclusion}`,
      kind: "closed",
      title: `事项已结束：${work.title}`,
      body: next.closureSummary ?? (conclusion === "succeeded" ? "事项已完成" : undefined),
      stateVersion: next.stateVersion,
      intentRevision: next.intentRevision,
      delivery: "pending",
      createdAt: now,
      attemptCount: 0,
      cardKey: card.cardKey,
    });
    return { ok: true, outboxEventId };
  }

  /** In-flight work still settles normally. Recorded uncertainty is not a lock
   * and accepting that risk never supplies success/acceptance evidence. */
  private isSettled(work: WorkDto): boolean {
    const bindings = this.deps.repo.listBindings(work.workId);
    if (bindings.some((binding) => UNSETTLED_BINDING_STATUSES.has(binding.status))) return false;
    const admissions = this.deps.repo.listAdmissions(work.workId);
    if (admissions.some((admission) => admission.state === "admitted")) return false;
    if (this.deps.repo.listOpenBlockers(work.workId).length > 0) return false;
    return true;
  }

  tryCloseSettled(work: WorkDto, now: number): Mutation {
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

}

function resolvedIsBot(actor: { kind: WorkActor["kind"] }): boolean { return actor.kind === "bot" || actor.kind === "worker"; }
