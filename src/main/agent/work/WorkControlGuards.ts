import type { AmendWorkParams, ExpectedVersionGuard, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";

/** Minimum actor shape the version guards reason about; no authority is derived here. */
export interface GuardActor {
  kind: "user" | "bot" | "worker" | "system";
}

export type GuardFailure = { ok: false; code: "invalid_request" | "epoch_mismatch" | "version_conflict"; message: string; latestWorkSnapshot?: WorkDto };

/**
 * Version/epoch authority for a control decision.
 *
 * A decision carries the versions it was based on: a stale intent revision, owner epoch or
 * state version is refused instead of being silently applied to newer facts.
 */
export function checkControlGuard(
  work: WorkDto,
  resolved: GuardActor,
  guard: ExpectedVersionGuard | undefined,
  mode: "full" | "versions" | "none",
): GuardFailure | undefined {
  if (mode === "none" || resolved.kind === "system" || resolved.kind === "worker") return undefined;
  if (resolved.kind === "bot") {
    if (guard?.expectedStateVersion === undefined || guard.expectedIntentRevision === undefined) {
      return { ok: false, code: "invalid_request", message: "控制决定必须携带依据的 stateVersion 与 intentRevision" };
    }
    if (mode === "full" && guard.expectedOwnerEpoch === undefined) {
      return { ok: false, code: "invalid_request", message: "控制决定必须携带依据的 ownerEpoch" };
    }
  }
  if (guard?.expectedOwnerEpoch !== undefined && guard.expectedOwnerEpoch !== work.ownerEpoch) {
    return {
      ok: false, code: "epoch_mismatch",
      message: `负责人代次已变更（期望 ${guard.expectedOwnerEpoch}，当前 ${work.ownerEpoch}），旧决定失效`,
      latestWorkSnapshot: work,
    };
  }
  if (guard?.expectedIntentRevision !== undefined && guard.expectedIntentRevision !== work.intentRevision) {
    return {
      ok: false, code: "version_conflict",
      message: `要求版本已更新（期望 r${guard.expectedIntentRevision}，当前 r${work.intentRevision}），请基于最新要求重新评估`,
      latestWorkSnapshot: work,
    };
  }
  if (guard?.expectedStateVersion !== undefined && guard.expectedStateVersion !== work.stateVersion) {
    return {
      ok: false, code: "version_conflict",
      message: `状态版本冲突（期望 ${guard.expectedStateVersion}，当前 ${work.stateVersion}）`,
      latestWorkSnapshot: work,
    };
  }
  return undefined;
}

/** Worker reports may update only progress text, never goal, evidence acceptance or authority. */
export function isWorkerProgressAmend(params: AmendWorkParams): boolean {
  return typeof params.progressSummary === "string" && Object.entries(params).every(([key, value]) =>
    value === undefined || ["operationId", "workId", "progressSummary", "versionGuard"].includes(key));
}

export function checkWorkerProgress(work: WorkDto, params: AmendWorkParams, binding: WorkExecutionBindingDto | undefined): GuardFailure | undefined {
  if (!isWorkerProgressAmend(params) || work.lifecycle !== "active" || !binding || binding.workId !== work.workId
    || binding.status !== "running" || binding.invalidatedAt !== undefined
    || binding.ownerEpoch !== work.ownerEpoch || binding.intentRevision !== work.intentRevision
    || binding.inputSnapshotId !== work.inputSnapshotId)
    return { ok: false, code: "invalid_request", message: "只有当前活动执行绑定能报告进展，不能修改目标或恢复暂停事项" };
  return checkControlGuard(work, { kind: "bot" }, params.versionGuard, "full");
}
