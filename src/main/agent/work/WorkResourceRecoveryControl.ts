import { readResourceEffectPreparation } from "./WorkResourceEffectReview";
import { workActionApprovalSchema } from "../../../shared/bot-work-approval";
import type Database from "better-sqlite3";
import type { WorkActor, WorkControlResult, WorkDto } from "../../../shared/bot-work";
import { prepareResourceEffectSchema, type PrepareResourceEffectParams, reconcileResourceEffectSchema, retryResourceRecoverySchema, type ReconcileResourceEffectParams, type RetryResourceRecoveryParams } from "../../../shared/bot-work-phase3-control";
import type { WorkRepository } from "./WorkRepository";
import type { WorkResourceGate } from "./WorkResourceGate";
import { hasPendingResourceRecoveryProbe, retryWorkResourceRecovery } from "./WorkResourceRecovery";

export function resourceRecoveryProjection(db: Database.Database, gate: WorkResourceGate, workId: string) {
  const resourceRecoveries = gate.recoveryStatus(workId).map(recovery => {
    const lease = gate.live().find(item => item.token === recovery.token);
    const parts = lease?.actionId.startsWith("resource:") ? lease.actionId.split(":") : undefined;
    const operationId = parts && lease ? `tool:${lease.owner.childId ?? lease.owner.conversationId}:${parts[2]}:${parts.slice(3).join(":")}` : undefined;
    const approvalRow = operationId && lease?.owner.bindingId ? db.prepare("SELECT data_json FROM work_action_approvals WHERE binding_id=? AND operation_id=?")
      .get(lease.owner.bindingId, operationId) as { data_json: string } | undefined : undefined;
    const approval = approvalRow ? workActionApprovalSchema.parse(JSON.parse(approvalRow.data_json)) : undefined;
    const prepared = lease ? readResourceEffectPreparation(db, lease) : undefined;
    const review = db.prepare("SELECT conclusion,evidence,reviewed_at FROM work_resource_effect_reviews WHERE token=?").get(recovery.token) as
      { conclusion: "not_occurred" | "occurred"; evidence: string; reviewed_at: number } | undefined;
    return { ...recovery, pendingProbe: hasPendingResourceRecoveryProbe(db, recovery.token),
      actionId: lease?.actionId, actionDescription: approval ? `${approval.toolName}: ${approval.summary}\n${approval.detail}` : undefined, taskId: lease?.owner.taskId, workspacePath: lease?.owner.workspaceBinding,
      resourceScope: lease?.resources.map(item => `${item.kind}:${item.scope}:${item.path ?? item.key} (${item.mode})`),
      effectReviewPrepared: prepared ? { preparedAt: prepared.preparedAt, readyAt: prepared.readyAt } : undefined,
      effectReview: review ? { conclusion: review.conclusion, evidence: review.evidence, reviewedAt: review.reviewed_at } : undefined };
  });
  const nextSteps = resourceRecoveries.some(recovery => recovery.exhaustedAt !== undefined && !recovery.pendingProbe)
    ? ["需要你的决定：资源核对已停止，请确认环境安全后重新核对隔离资源"] : [];
  return { resourceRecoveries, nextSteps };
}

type Mutation = { ok: true; outboxEventId?: string } | Extract<WorkControlResult, { ok: false }>;
type RunControl = (actor: WorkActor, operationType: string, params: RetryResourceRecoveryParams | ReconcileResourceEffectParams | PrepareResourceEffectParams,
  options: { guard: "full"; ownerOnly: boolean; allowLifecycles: WorkDto["lifecycle"][] },
  mutate: (work: WorkDto, resolved: unknown, now: number) => Mutation) => WorkControlResult;
type AppendOutbox = (entry: { work: WorkDto; eventType: string; operationId: string; payload: Record<string, unknown> }) => string;

/** User confirmation reopens checks within the existing control/receipt transaction. */
export function runResourceRecoveryControl(actor: WorkActor, params: RetryResourceRecoveryParams,
  db: Database.Database, gate: WorkResourceGate, repo: WorkRepository, runControl: RunControl, appendOutbox: AppendOutbox): WorkControlResult {
  const parsed = retryResourceRecoverySchema.safeParse(params);
  if (!parsed.success) return { ok: false, code: "invalid_request", message: "重新核对需要完整的资源身份、版本和环境安全确认" };
  if (actor.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "只有用户确认环境安全后才能重新核对隔离资源" };
  return runControl(actor, "retryResourceRecovery", parsed.data, {
    guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing", "closed"],
  }, (work, _resolved, now) => {
    if (!retryWorkResourceRecovery(db, gate, parsed.data))
      return { ok: false, code: "version_conflict", message: "隔离资源状态已变化或旧核对仍未退出，请读取最新状态" };
    const next = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
    repo.updateWork(next);
    const outboxEventId = appendOutbox({ work: next, eventType: "work.resource_recovery_requested", operationId: parsed.data.operationId,
      payload: { token: parsed.data.token, previousAttempts: parsed.data.expectedAttempts,
        previousExhaustedAt: parsed.data.expectedExhaustedAt, confirmEnvironmentSafe: true } });
    return { ok: true, outboxEventId };
  });
}

/** Record a user's inspection, then request native stop/quiet/input checks. Never releases directly. */
export function runResourceEffectReviewControl(actor: WorkActor, params: ReconcileResourceEffectParams,
  db: Database.Database, gate: WorkResourceGate, repo: WorkRepository, runControl: RunControl, appendOutbox: AppendOutbox): WorkControlResult {
  const parsed = reconcileResourceEffectSchema.safeParse(params);
  if (!parsed.success) return { ok: false, code: "invalid_request", message: "请核对原动作、作用范围与实际效果，填写依据并确认停止原执行" };
  if (actor.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "只有用户可以记录原操作的实际效果核对" };
  return runControl(actor, "reconcileResourceEffect", parsed.data, {
    guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing", "closed"],
  }, (work, _resolved, now) => {
    const input = parsed.data;
    const lease = gate.live().find(item => item.token === input.token && item.actionId === input.actionId && item.owner.workId === work.workId);
    const binding = lease?.owner.bindingId ? repo.getBinding(lease.owner.bindingId) : undefined;
    if (!lease || gate.leaseState(lease) !== "quarantined" || !binding || binding.workId !== work.workId
      || binding.taskId !== lease.owner.taskId || binding.durableStoreKey !== lease.owner.durableStoreKey
      || binding.conversationId !== lease.owner.conversationId || binding.workspaceBinding !== lease.owner.workspaceBinding)
      return { ok: false, code: "version_conflict", message: "原动作或执行绑定已变化，请重新读取来源事项；不能核对其他动作" };
    const prepared = readResourceEffectPreparation(db, lease);
    if (!prepared?.readyAt || prepared.readyAt !== input.expectedReadyAt || prepared.userId !== actor.userId)
      return { ok: false, code: "version_conflict", message: "请先停止原执行并等待核对准备完成，再检查实际效果和提交结论" };
    if (!retryWorkResourceRecovery(db, gate, input))
      return { ok: false, code: "version_conflict", message: "资源代次已变化或旧探针仍在运行，请等待退出后读取最新状态" };
    const receipt = { kind: "user-effect-review", token: lease.token, actionId: lease.actionId, owner: lease.owner,
      resources: lease.resources, userId: actor.userId, operationId: input.operationId, conclusion: input.conclusion,
      evidence: input.evidence, reviewedAt: now, workStateVersion: work.stateVersion, confirmScopeReviewed: true, confirmStopOriginal: true };
    db.prepare(`INSERT INTO work_resource_effect_reviews(token,action_id,owner_json,resources_json,user_id,operation_id,conclusion,evidence,reviewed_at,receipt_json)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET action_id=excluded.action_id,owner_json=excluded.owner_json,
      resources_json=excluded.resources_json,user_id=excluded.user_id,operation_id=excluded.operation_id,conclusion=excluded.conclusion,
      evidence=excluded.evidence,reviewed_at=excluded.reviewed_at,receipt_json=excluded.receipt_json`)
      .run(lease.token, lease.actionId, JSON.stringify(lease.owner), JSON.stringify(lease.resources), actor.userId,
        input.operationId, input.conclusion, input.evidence, now, JSON.stringify(receipt));
    const next = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
    repo.updateWork(next);
    const outboxEventId = appendOutbox({ work: next, eventType: "work.resource_effect_reviewed", operationId: input.operationId, payload: receipt });
    return { ok: true, outboxEventId };
  });
}

export function runPrepareResourceEffectControl(actor: WorkActor, params: PrepareResourceEffectParams,
  db: Database.Database, gate: WorkResourceGate, repo: WorkRepository, runControl: RunControl, appendOutbox: AppendOutbox): WorkControlResult {
  const parsed = prepareResourceEffectSchema.safeParse(params);
  if (!parsed.success) return { ok: false, code: "invalid_request", message: "请确认停止原执行，并提供当前隔离身份和版本" };
  if (actor.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "只有用户可以停止原执行并准备效果核对" };
  return runControl(actor, "prepareResourceEffect", parsed.data, {
    guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing", "closed"],
  }, (work, _resolved, now) => {
    const input = parsed.data;
    const lease = gate.live().find(item => item.token === input.token && item.actionId === input.actionId && item.owner.workId === work.workId);
    const binding = lease?.owner.bindingId ? repo.getBinding(lease.owner.bindingId) : undefined;
    if (!lease || gate.leaseState(lease) !== "quarantined" || !binding || binding.workId !== work.workId
      || binding.taskId !== lease.owner.taskId || binding.durableStoreKey !== lease.owner.durableStoreKey
      || binding.conversationId !== lease.owner.conversationId || binding.workspaceBinding !== lease.owner.workspaceBinding)
      return { ok: false, code: "version_conflict", message: "原动作或执行绑定已变化，请重新读取来源事项" };
    if (!retryWorkResourceRecovery(db, gate, input))
      return { ok: false, code: "version_conflict", message: "资源代次已变化或探针尚未退出，请读取最新状态" };
    // Fence all future tools before the asynchronous original-native stop. Preserve historical outcome and receipts.
    repo.updateBinding({ ...binding, invalidatedAt: binding.invalidatedAt ?? now });
    db.prepare(`INSERT INTO work_resource_effect_preparations(token,action_id,owner_json,resources_json,user_id,operation_id,prepared_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET action_id=excluded.action_id,owner_json=excluded.owner_json,
      resources_json=excluded.resources_json,user_id=excluded.user_id,operation_id=excluded.operation_id,prepared_at=excluded.prepared_at,
      ready_at=NULL,quiet_receipt=NULL`).run(lease.token, lease.actionId, JSON.stringify(lease.owner), JSON.stringify(lease.resources),
        actor.userId, input.operationId, now);
    db.prepare("DELETE FROM work_resource_effect_reviews WHERE token=?").run(lease.token);
    const next = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
    repo.updateWork(next);
    return { ok: true, outboxEventId: appendOutbox({ work: next, eventType: "work.resource_effect_preparation_requested", operationId: input.operationId,
      payload: { token: lease.token, actionId: lease.actionId, owner: lease.owner, resources: lease.resources,
        userId: actor.userId, preparedAt: now, confirmStopOriginal: true } }) };
  });
}
