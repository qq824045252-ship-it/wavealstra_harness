import type { WorkBlockerDto, WorkDto, WorkExecutionStatus, WorkProjectionDto } from "../../../shared/bot-work";
import { criterionNeedsEnvironment, isCriterionResolved, isRequiredCriterion } from "../../../shared/bot-work";
import type { WorkSubscriptionMonitorDto } from "../../../shared/bot-work-phase4";
import type { WorkRepository } from "./WorkRepository";
import type { WorkPartialResults } from "./WorkPartialResults";
import type { WorkNotificationDelivery } from "./WorkNotificationDelivery";
import type { WorkTeamService } from "./WorkTeamService";
import type { WorkRecordArchive } from "./WorkRecordArchive";
import type { WorkGeneratedArtifacts } from "./WorkGeneratedArtifacts";
import type { WorkRuntimeObservation } from "./WorkRuntimeObservation";
import type { WorkResultCards } from "./WorkResultCards";
import type { WorkWatchScheduler } from "./WorkWatchScheduler";
import type { WorkCausalGuard } from "./WorkCausalGuard";
import type { WorkPausedBacklog } from "./WorkPausedBacklog";
import type { WorkArtifactValidation } from "./WorkArtifactValidation";
import type { WorkCollaborationService } from "./WorkCollaborationService";
import type { WorkWatchIngress } from "./WorkWatchIngress";
import type { legacyUserInputSource } from "./WorkLegacyUserInput";
import { currentAcceptedDeliverableIds } from "./WorkControlNormalization";
import { projectDeliverableReport } from "./WorkReportPresentation";

/** Read capabilities only: control transactions and publication remain in WorkService. */
export interface WorkProjectionSources {
  repo: Pick<WorkRepository, "listDeliverables" | "listBlockers" | "listBindings" | "listNotifications"
    | "listSubscriptions" | "listAdmissions" | "reportContext">;
  legacyUserInput: (work: WorkDto, blocker: WorkBlockerDto) => ReturnType<typeof legacyUserInputSource>;
  notifications: Pick<WorkNotificationDelivery, "identity">;
  partialResults: Pick<WorkPartialResults, "gaps" | "list" | "plans">;
  teams?: Pick<WorkTeamService, "get">;
  recordArchive?: Pick<WorkRecordArchive, "get">;
  generatedArtifacts: Pick<WorkGeneratedArtifacts, "list">;
  runtimeObservations: Pick<WorkRuntimeObservation, "forWork">;
  cards: Pick<WorkResultCards, "list">;
  scheduler: Pick<WorkWatchScheduler, "gaps" | "hostState">;
  causal: Pick<WorkCausalGuard, "list">;
  pausedBacklog: Pick<WorkPausedBacklog, "count">;
  artifacts: Pick<WorkArtifactValidation, "currentSnapshotId">;
  collaboration: Pick<WorkCollaborationService, "history">;
  ingress: Pick<WorkWatchIngress, "queueStats" | "listCursors">;
}

const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);

/** Builds the existing DTO from current facts; never writes, publishes, or dispatches. */
export class WorkProjectionBuilder {
  constructor(private readonly sources: WorkProjectionSources) {}

  build(work: WorkDto): WorkProjectionDto {
    const deliverables = this.sources.repo.listDeliverables(work.workId);
    const blockers = this.sources.repo.listBlockers(work.workId).map(blocker => {
      const legacyUserInput = this.sources.legacyUserInput(work, blocker);
      return legacyUserInput ? { ...blocker, legacyUserInput } : blocker;
    });
    const executions = this.sources.repo.listBindings(work.workId);
    const notifications = this.sources.repo.listNotifications(work.workId).map(notification => ({ ...notification, ...this.sources.notifications.identity(notification.notificationId) }));
    const subscriptions = this.sources.repo.listSubscriptions(work.workId);
    const currentResultIds = new Set(currentAcceptedDeliverableIds(work, deliverables, executions));
    const unresolved = work.criteria.filter((criterion) => isRequiredCriterion(criterion) && !isCriterionResolved(criterion));
    const uncoveredScope = [...new Set(deliverables
      .filter((deliverable) => currentResultIds.has(deliverable.deliverableId))
      .flatMap((deliverable) => deliverable.uncoveredScope))];
    const nextSteps: string[] = [];
    if (work.lifecycle === "closing") nextSteps.push(work.watchRule?.termination ? "已停止新检查，等待在途回执与最后一轮汇报" : "等待在途执行结束");
    const settlingActions = this.sources.repo.listAdmissions(work.workId).filter(item => item.state === "admitted").length;
    const gaps = this.sources.partialResults.gaps(work.workId);
    if (work.lifecycle === "paused") nextSteps.push(settlingActions ? "已暂停，正在结算在途操作" : "事项已暂停，恢复后继续");
    if (gaps.length && !work.watchRule?.termination) nextSteps.push(`保留已确认成果，仍有 ${gaps.length} 项必要缺口待核对：未执行动作可关联后续证据覆盖，其余缺口按原身份处理`);
    if (work.lifecycle !== "closed" && !work.watchRule?.termination) {
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
      watchPlan: work.watchRule ? { endsAt: work.watchRule.endsAt, termination: work.watchRule.termination, scheduleBasis: work.watchRule.scheduleBasis, scheduleRationale: work.watchRule.scheduleRationale } : undefined,
      lifecycle: work.lifecycle,
      pendingConclusion: work.pendingConclusion,
      closureConclusion: work.closureConclusion,
      closureSummary: work.closureSummary,
      ownerBotId: work.ownerBotId,
      team: this.sources.teams?.get(work.workId),
      archive: this.sources.recordArchive?.get(work.workId),
      ownerEpoch: work.ownerEpoch,
      intentRevision: work.intentRevision,
      sourceVersion: work.sourceVersion,
      stateVersion: work.stateVersion,
      inputSnapshotId: work.inputSnapshotId,
      inputSnapshotBound: work.inputSnapshotId !== "snapshot:unbound",
      goalSources: work.goalSources,
      criteria: work.criteria,
      acceptedDeliverableIds: [...currentResultIds],
      deliverables: deliverables.map(result => projectDeliverableReport(result, executions, binding => this.sources.repo.reportContext(binding))),
      generatedArtifacts: this.sources.generatedArtifacts.list(work.workId),
      historicalGeneratedArtifacts: this.sources.generatedArtifacts.list(work.workId, true).filter(artifact =>
        !executions.some(binding => binding.bindingId === artifact.bindingId
          && binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId)),
      runtimeObservations: this.sources.runtimeObservations.forWork(work.workId),
      blockers,
      executions,
      notifications,
      cards: this.sources.cards.list(work),
      subscriptionIds: subscriptions.map(subscription => subscription.subscriptionId),
      phase4: {
        subscriptions: this.projectSubscriptions(work),
        offlineGaps: this.sources.scheduler.gaps(work.workId),
        causal: this.sources.causal.list(work.workId, 10).map(item => ({ chainId: item.chain_id, rootEventId: item.root_event_id,
          parentChainId: item.parent_chain_id ?? undefined, originWorkId: item.origin_work_id,
          targetWorkId: item.target_work_id, depth: item.depth, hops: item.hops,
          dispatchCount: item.dispatch_count, decision: item.decision,
          reasonCode: item.reason_code ?? undefined, createdAt: item.created_at })),
        deadlineAt: work.deadlineAt, deadlineRevision: work.deadlineRevision,
        host: this.sources.scheduler.hostState(),
      },
      phase3: {
        subitems: this.sources.partialResults.list(work.workId), continuations: this.sources.partialResults.plans(work.workId),
        gaps, settlingActions, pausedEventCount: this.sources.pausedBacklog.count(work.workId),
        artifactSnapshotId: this.sources.artifacts.currentSnapshotId(work.workId),
        handoffs: this.sources.collaboration.history(work.workId).filter(message => message.kind === "handoff"),
        collaborationMessages: this.sources.collaboration.history(work.workId),
      },
      uncoveredScope,
      nextSteps,
      updatedAt: work.updatedAt,
      closedAt: work.closedAt,
    };
  }

  private projectSubscriptions(work: WorkDto): WorkSubscriptionMonitorDto[] {
    const host = this.sources.scheduler.hostState();
    return this.sources.repo.listSubscriptions(work.workId, { includeStopped: true }).map(subscription => {
      const stats = this.sources.ingress.queueStats(subscription);
      const cursors = this.sources.ingress.listCursors(subscription.subscriptionId).map(cursor => ({
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
}
