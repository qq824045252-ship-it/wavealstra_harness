import type Database from "better-sqlite3";
import type { ReportBlockerParams, WorkActor, WorkControlErrorCode, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { userInputBlockerSnapshot, type ReplyUserInputParams, type ReplyLegacyUserInputParams } from "../../../shared/bot-work-review";
import type { WorkPhase5Facts } from "./WorkPhase5Facts";
import { WorkRepository, newId } from "./WorkRepository";
import { legacyUserInputSource } from "./WorkLegacyUserInput";

interface ResolvedInputActor {
  kind: WorkActor["kind"];
  userId: string;
  bot?: { botId: string };
  binding?: WorkExecutionBindingDto;
}
type Mutation = { ok: true } | { ok: false; code: WorkControlErrorCode; message: string };

/** These mutations run only inside WorkService.runWorkControl: the service owns
 * authorization, CAS, lifecycle, transaction boundaries and idempotency receipts.
 * They never dispatch work or relax action/resource/acceptance guards. */
export function reportWorkBlockerMutation(
  { repo, phase5 }: { repo: WorkRepository; phase5: Pick<WorkPhase5Facts, "recordEscalation" | "refreshSummary"> },
  work: WorkDto, resolved: ResolvedInputActor, params: ReportBlockerParams, now: number, ownerOrUser: boolean,
): Mutation {
  if (resolved.kind !== "user" && resolved.kind !== "worker" && !ownerOrUser) {
    return { ok: false, code: "unauthorized_actor", message: "只有负责人、协作者或执行者可上报阻碍" };
  }
  if (params.userInput && (params.userInput.kind !== "reply" || params.kind && params.kind !== "operational"
    || params.unknownExternalEffectRef || !params.waitingForUserInput || work.inputSnapshotId === "snapshot:unbound")) {
    return { ok: false, code: "invalid_request", message: "信息回复不能替代授权、资源或未知效果核对" };
  }
  if (params.userInput && resolved.binding && (resolved.binding.inputSnapshotId !== work.inputSnapshotId
    || resolved.binding.intentRevision !== work.intentRevision || resolved.binding.ownerEpoch !== work.ownerEpoch
    || resolved.binding.invalidatedAt !== undefined)) {
    return { ok: false, code: "version_conflict", message: "旧执行不能对当前版本提出信息问题" };
  }
  repo.insertBlocker({
    blockerId: newId("blocker"),
    workId: work.workId,
    reportedByBotId: resolved.bot?.botId,
    reason: params.reason.trim().slice(0, 2000),
    ...(params.userInput ? { reasonCode: "user-input" as const, sourceRef: `user-input:${params.operationId}`,
      details: { userInput: { kind: "reply", inputSnapshotId: work.inputSnapshotId,
        intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch } } } : {}),
    kind: params.kind ?? "operational",
    unknownExternalEffectRef: params.unknownExternalEffectRef,
    waitingForUserInput: Boolean(params.waitingForUserInput),
    status: "open",
    createdAt: now,
  });
  const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
  repo.updateWork(next);
  if (params.waitingForUserInput) phase5.recordEscalation(next, params.reason, now);
  else phase5.refreshSummary(next.workId);
  return { ok: true };
}

export function replyUserInputMutation(
  { repo }: { repo: WorkRepository }, work: WorkDto, resolved: ResolvedInputActor, params: ReplyUserInputParams, now: number,
): Mutation {
  if (resolved.kind !== "user" || resolved.userId !== work.userId)
    return { ok: false, code: "unauthorized_actor", message: "信息回复必须来自已认证用户" };
  const blocker = repo.getBlocker(params.blockerId);
  if (!blocker || blocker.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到问题" };
  const snapshot = userInputBlockerSnapshot(blocker);
  if (!snapshot || blocker.status !== "open")
    return { ok: false, code: "invalid_request", message: "此阻碍不能用普通回复解除，请使用对应的专门控制" };
  const source = blocker.details!.userInput as { inputSnapshotId: string; intentRevision: number; ownerEpoch: number };
  if (snapshot !== params.blockerSnapshot || params.inputSnapshotId !== work.inputSnapshotId
    || source.inputSnapshotId !== work.inputSnapshotId || source.intentRevision !== work.intentRevision
    || source.ownerEpoch !== work.ownerEpoch)
    return { ok: false, code: "version_conflict", message: "问题依据已变化，请由负责人按当前版本重新提出问题" };
  if (!params.reply?.trim() || !params.evidenceRef?.trim())
    return { ok: false, code: "invalid_request", message: "请填写回复和可核对的依据" };
  const response = { operationId: params.operationId, userId: resolved.userId, reply: params.reply.trim(),
    evidenceRef: params.evidenceRef.trim(), sourceSnapshot: snapshot, recordedAt: now };
  repo.recordBlockerResponse(blocker, response, now);
  repo.insertEvidence({ evidenceId: newId("evidence"), workId: work.workId, criterionIds: [],
    kind: "user_attestation", provenance: "user", sourceRef: `user-input-response:${params.operationId}`,
    inputSnapshotId: work.inputSnapshotId, intentRevision: work.intentRevision,
    detail: JSON.stringify(response), recordedAt: now });
  repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
  return { ok: true };
}

export function replyLegacyUserInputMutation(
  { repo, db }: { repo: WorkRepository; db: Database.Database },
  work: WorkDto, resolved: ResolvedInputActor, params: ReplyLegacyUserInputParams, now: number,
): Mutation {
  if (resolved.kind !== "user" || resolved.userId !== work.userId)
    return { ok: false, code: "unauthorized_actor", message: "历史问题分类与回复必须由用户确认" };
  const blocker = repo.getBlocker(params.blockerId);
  const source = blocker && legacyUserInputSource(db, work, blocker);
  if (!blocker || !source) return { ok: false, code: "invalid_request", message: "无法唯一证明此问题的原始负责人报告，不能解除阻碍" };
  if (source.reportOperationId !== params.reportOperationId || source.blockerSnapshot !== params.blockerSnapshot
    || source.inputSnapshotId !== params.inputSnapshotId)
    return { ok: false, code: "version_conflict", message: "问题来源已变化，请重新核对原始报告" };
  if (params.confirmedInformationOnly !== true || !params.reply?.trim() || !params.evidenceRef?.trim())
    return { ok: false, code: "invalid_request", message: "请确认这仅是信息问题，并填写回复及依据" };
  const response = { operationId: params.operationId, userId: resolved.userId, reply: params.reply.trim(),
    evidenceRef: params.evidenceRef.trim(), sourceSnapshot: source.blockerSnapshot,
    reportOperationId: source.reportOperationId, classification: "information_only", recordedAt: now };
  repo.recordBlockerResponse(blocker, response, now);
  repo.insertEvidence({ evidenceId: newId("evidence"), workId: work.workId, criterionIds: [],
    kind: "user_attestation", provenance: "user", sourceRef: `legacy-user-input-response:${params.operationId}`,
    inputSnapshotId: source.inputSnapshotId, intentRevision: source.intentRevision,
    detail: JSON.stringify(response), recordedAt: now });
  repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
  return { ok: true };
}
