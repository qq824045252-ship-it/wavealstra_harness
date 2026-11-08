import type Database from "better-sqlite3";
import type { WorkActor, WorkControlResult, WorkDto } from "../../../shared/bot-work";
import { retryResourceRecoverySchema, type RetryResourceRecoveryParams } from "../../../shared/bot-work-phase3-control";
import type { WorkRepository } from "./WorkRepository";
import type { WorkResourceGate } from "./WorkResourceGate";
import { hasPendingResourceRecoveryProbe, retryWorkResourceRecovery } from "./WorkResourceRecovery";

export function resourceRecoveryProjection(db: Database.Database, gate: WorkResourceGate, workId: string) {
  const resourceRecoveries = gate.recoveryStatus(workId).map(recovery => ({ ...recovery,
    pendingProbe: hasPendingResourceRecoveryProbe(db, recovery.token) }));
  const nextSteps = resourceRecoveries.some(recovery => recovery.exhaustedAt !== undefined && !recovery.pendingProbe)
    ? ["需要你的决定：资源核对已停止，请确认环境安全后重新核对隔离资源"] : [];
  return { resourceRecoveries, nextSteps };
}

type Mutation = { ok: true; outboxEventId?: string } | Extract<WorkControlResult, { ok: false }>;
type RunControl = (actor: WorkActor, operationType: string, params: RetryResourceRecoveryParams,
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
