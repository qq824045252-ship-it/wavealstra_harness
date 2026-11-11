import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import type { BotDto, DispatchExecutionParams, ExpertConfigSnapshotDto, WorkDto, WorkExecutionStatus, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";
import type { WorkTeamService } from "./WorkTeamService";
import type { WorkCausalGuard } from "./WorkCausalGuard";
import { newId, type WorkRepository } from "./WorkRepository";
import { isReadOnlyScheduledFollowUp, isScheduledFollowUp, scheduledFollowUpCurrent } from "./WorkScheduledFollowUp";
import type { Mutation } from "./WorkControlTypes";

interface DispatchMutationDeps {
  repo: Pick<WorkRepository, "getBindingByOperation" | "bindingForTask" | "getInbox" | "getSubscription" | "getBinding" | "insertBinding" | "updateWork">;
  bots: Pick<BotRegistry, "getBot">;
  teams: Pick<WorkTeamService, "dispatchError" | "allowsRecoveryBinding">;
  causal: Pick<WorkCausalGuard, "admit">;
  recoveryRequest: (taskId: string) => { source_binding_id: string } | undefined;
  requestExpert?: (work: WorkDto, botId: string) => ExpertConfigSnapshotDto | undefined;
  snapshotOf: (bot: BotDto) => ExpertConfigSnapshotDto;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; bindingId?: string; payload: Record<string, unknown> }) => string;
}
const UNSETTLED_BINDING_STATUSES = new Set<WorkExecutionStatus>(["pending", "submitted", "running", "unknown"]);

/** Runs synchronously inside the facade's existing runWorkControl transaction. */
export function dispatchExecutionMutation(deps: DispatchMutationDeps, work: WorkDto, params: DispatchExecutionParams, now: number): Mutation {
  if (!params.taskId?.trim() || !params.durableStoreKey?.trim() || !params.conversationId?.trim()) {
    return { ok: false, code: "invalid_request", message: "执行绑定必须包含 task、Durable 存储与接收 conversation 身份" };
  }
  if (deps.bots.getBot(work.ownerBotId)?.status !== "active") {
    return { ok: false, code: "bot_disabled", message: "主负责人已停用，不能启动新执行" };
  }
  const existing = deps.repo.getBindingByOperation(work.workId, params.operationId);
  if (existing) {
    if (existing.taskId !== params.taskId || existing.durableStoreKey !== params.durableStoreKey
      || existing.conversationId !== params.conversationId) {
      return { ok: false, code: "idempotency_conflict", message: "重试不能重新分配 task、存储命名空间或 conversation" };
    }
    return { ok: true };
  }
  if (watchTimeExpired(work, now)) return { ok: false, code: "invalid_lifecycle_transition", message: "持续追踪期限已到，不再启动新的检查" };
  const teamError = deps.teams.dispatchError(work.workId, params.taskId, params.botId, params.delegatedScope, params.operationId);
  if (teamError) return { ok: false, code: "unauthorized_actor", message: teamError };
  const occupied = deps.repo.bindingForTask(params.taskId);
  if (occupied && (occupied.workId !== work.workId || occupied.botId !== params.botId)) {
    return { ok: false, code: "invalid_request", message: "执行 Task 已属于另一事项或 Bot，不能复用其上下文" };
  }
  if (occupied && UNSETTLED_BINDING_STATUSES.has(occupied.status)
    && !deps.teams.allowsRecoveryBinding(work.workId, params.taskId, params.operationId, occupied)) {
    return { ok: false, code: "unsettled_effects", message: "该 task 已绑定未结算执行，不能同时承接另一次派发" };
  }
  const target = deps.bots.getBot(params.botId);
  if (!target) return { ok: false, code: "not_found", message: "找不到执行 Bot" };
  if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "执行 Bot 不属于该事项用户" };
  if (target.status !== "active") return { ok: false, code: "bot_disabled", message: "执行 Bot 已停用" };
  if (!work.inputSnapshotId || work.inputSnapshotId === "snapshot:unbound") {
    return { ok: false, code: "invalid_request", message: "启动执行前必须绑定可追溯的输入快照" };
  }
  const inboxEvent = params.inboxEventId ? deps.repo.getInbox(params.inboxEventId) : undefined;
  if (inboxEvent && inboxEvent.workId !== work.workId) return { ok: false, code: "invalid_request", message: "派发引用了另一事项的事件" };
  if (params.causal) {
    const admission = deps.causal.admit({ workId: work.workId, subscriptionId: inboxEvent?.subscriptionId ?? undefined,
      source: params.causal.source, sourceEventId: params.causal.sourceEventId,
      causalEventId: params.causal.causalEventId, parentChainId: params.causal.parentChainId,
      originWorkId: work.workId, inputSnapshotId: work.inputSnapshotId,
      actionKind: params.causal.actionKind ?? "dispatch", operationId: params.operationId,
      trustedRoot: params.causal.trustedRoot });
    if (!admission.allowed) return { ok: false, code: "causal_guard", message: admission.message ?? "因果链已触限" };
  }
  const readOnlyFollowUp = isScheduledFollowUp(inboxEvent);
  if (readOnlyFollowUp && !scheduledFollowUpCurrent(work, inboxEvent, inboxEvent?.subscriptionId ? deps.repo.getSubscription(inboxEvent.subscriptionId) : undefined))
    return { ok: false, code: "invalid_request", message: "检查时间表或承诺期限已变更，旧触发不再派发" };
  const delegatedScope = isReadOnlyScheduledFollowUp(inboxEvent,work) ? ["workspace:read"] as string[] : params.delegatedScope ?? [...work.authorization.allowedScopes];
  const recoveryRequest = deps.recoveryRequest(params.taskId);
  const recoverySource = recoveryRequest && deps.repo.getBinding(recoveryRequest.source_binding_id);
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
    expertSnapshot: recoverySource?.expertSnapshot ?? deps.requestExpert?.(work, target.botId) ?? deps.snapshotOf(target),
    delegatedScope,
    workspaceBinding: params.workspaceBinding,
    inboxEventId: params.inboxEventId,
    status: "pending",
    admittedAt: now,
  };
  deps.repo.insertBinding(binding);
  const next: WorkDto = {
    ...work,
    activeExecutionIds: [...new Set([...work.activeExecutionIds, binding.bindingId])],
    stateVersion: work.stateVersion + 1,
    updatedAt: now,
  };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.execution.dispatch_requested", operationId: params.operationId,
    bindingId: binding.bindingId,
    payload: {
      bindingId: binding.bindingId, taskId: binding.taskId, durableStoreKey: binding.durableStoreKey,
      conversationId: binding.conversationId, botId: binding.botId, intentRevision: binding.intentRevision,
    },
  });
  return { ok: true, outboxEventId };
}
