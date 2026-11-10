import type { AcceptDeliverableParams, AttestCriteriaParams, RecordUserFeedbackParams, RejectDeliverableParams, SubmitDeliverableParams, WorkDto, WorkDeliverableDto, WorkEvidenceDto, WorkEvidenceKind } from "../../../shared/bot-work";
import { criterionNeedsEnvironment } from "../../../shared/bot-work";
import { newId, type WorkRepository } from "./WorkRepository";
import { normalizeTexts } from "./WorkControlNormalization";
import type { WorkArtifactValidation, ArtifactInspection } from "./WorkArtifactValidation";
import type { WorkCollaborationService } from "./WorkCollaborationService";
import type { WorkPhase5Facts } from "./WorkPhase5Facts";
import type { Fail, Mutation, ResolvedActor } from "./WorkControlTypes";

interface DeliverableMutationDeps {
  repo: Pick<WorkRepository, "getBinding" | "getDeliverable" | "getEvidence" | "insertDeliverable" | "insertEvidence" | "updateDeliverableReview" | "updateWork">;
  collaboration: Pick<WorkCollaborationService, "isDelegationPending" | "isDelegationAdopted">;
  artifacts: Pick<WorkArtifactValidation, "validate" | "snapshotId">;
  phase5: Pick<WorkPhase5Facts, "recordAcceptance">;
  emitCurrentProjection: (workId: string) => unknown;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; bindingId?: string; payload: Record<string, unknown> }) => string;
}
const EXECUTION_EVIDENCE_KINDS = new Set<WorkEvidenceKind>(["automated_test", "tool_receipt", "inspection", "artifact"]);

/** Mutations execute inside WorkService's existing transaction, never open or publish their own. */
export function submitDeliverableMutation(deps: DeliverableMutationDeps, work: WorkDto, resolved: ResolvedActor, params: SubmitDeliverableParams, readNow: () => number): { ok: true; work: WorkDto; outboxEventId: string; now: number } | Fail {
  const binding = deps.repo.getBinding(params.bindingId);
  if (!binding || binding.workId !== work.workId) {
    return { ok: false, code: "unauthorized_actor", message: "提交成果必须绑定本事项的有效执行" };
  }
  if (resolved.kind === "worker" && resolved.binding?.bindingId !== binding.bindingId) {
    return { ok: false, code: "unauthorized_actor", message: "worker 只能提交自己执行的成果" };
  }
  if (resolved.kind === "bot" && resolved.bot?.botId !== binding.botId && resolved.bot?.botId !== work.ownerBotId) {
    return { ok: false, code: "unauthorized_actor", message: "该 Bot 没有这次执行的委派" };
  }
  const pendingAdoption = deps.collaboration.isDelegationPending(binding, work);
  if (pendingAdoption && (work.lifecycle === "active" || work.lifecycle === "paused")) {
    return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管此执行委派；接管后可重试成果提交，当前输入未作废" };
  }
  // A late result from an invalidated/unknown execution is still recorded, but with
  // the binding's own revision/snapshot as a historical deliverable (R04/R06).
  const now = readNow();
  const stale = pendingAdoption || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
    || binding.invalidatedAt !== undefined || binding.status === "invalidated";
  const deliverableId = params.deliverableId?.trim() || newId("deliverable");
  const evidenceIds: string[] = [];
  const evidenceRows: WorkEvidenceDto[] = [];
  for (const input of params.evidence ?? []) {
    if (!EXECUTION_EVIDENCE_KINDS.has(input.kind) || input.kind === "real_environment") {
      return { ok: false, code: "invalid_request", message: "执行结果只能记录自动化/工具/检查类证据，实测反馈必须由用户或宿主提供" };
    }
    if (!input.sourceRef?.trim()) {
      return { ok: false, code: "invalid_request", message: "证据必须带可追溯来源" };
    }
    const evidenceId = newId("evidence");
    evidenceIds.push(evidenceId);
    evidenceRows.push({
      evidenceId,
      workId: work.workId,
      deliverableId,
      executionId: binding.bindingId,
      criterionIds: input.criterionIds ?? [],
      kind: input.kind,
      provenance: "execution",
      sourceRef: input.sourceRef,
      sourceSha: input.sourceSha,
      inputSnapshotId: binding.inputSnapshotId,
      environment: input.environment,
      intentRevision: binding.intentRevision,
      detail: input.detail,
      recordedAt: now,
    });
  }
  const deliverable: WorkDeliverableDto = {
    deliverableId,
    workId: work.workId,
    producerBotId: binding.botId,
    executionId: binding.bindingId,
    intentRevision: binding.intentRevision,
    ownerEpoch: binding.ownerEpoch,
    inputSnapshotId: binding.inputSnapshotId,
    status: stale ? "superseded" : "proposed",
    // This is the authoritative result relayed to the originating Bot chat,
    // not a card preview. Truncation can remove caveats, sources and images.
    summary: params.summary.trim(),
    artifactRefs: normalizeTexts(params.artifactRefs),
    evidenceRefs: evidenceIds,
    uncoveredScope: normalizeTexts(params.uncoveredScope),
    uncoveredCriterionIds: params.uncoveredCriterionIds
      ?? (params.hasWriteConflicts ? work.criteria.map(criterion => criterion.id) : []),
    isSpeculation: Boolean(params.isSpeculation),
    hasWriteConflicts: Boolean(params.hasWriteConflicts),
    createdAt: now,
  };
  deps.repo.insertDeliverable(deliverable);
  for (const evidence of evidenceRows) deps.repo.insertEvidence(evidence);
  const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: stale ? "work.deliverable_historical" : "work.deliverable_proposed",
    operationId: params.operationId, bindingId: binding.bindingId,
    payload: { deliverableId, intentRevision: binding.intentRevision, stale },
  });
  return { ok: true, work: next, outboxEventId, now };
}

export function acceptDeliverableMutation(deps: DeliverableMutationDeps, work: WorkDto, resolved: ResolvedActor, params: AcceptDeliverableParams, now: number, artifactInspection: ArtifactInspection, isOwnerOrUser: boolean): Mutation {
  if (!deps.artifacts.validate(artifactInspection, now)) {
    deps.emitCurrentProjection(work.workId);
    return { ok: false, code: "version_conflict", message: "产物版本发生变化，已保留历史成果并重新打开相关验收项" };
  }

  if (!isOwnerOrUser) {
    return { ok: false, code: "unauthorized_actor", message: "仅当前主负责人或用户可验收成果" };
  }
  const deliverable = deps.repo.getDeliverable(params.deliverableId);
  if (!deliverable || deliverable.workId !== work.workId) {
    return { ok: false, code: "not_found", message: "找不到成果记录" };
  }
  if (deliverable.status === "superseded") return { ok: false, code: "version_conflict", message: "历史成果需要重新核验，不能直接验收" };
  if (deliverable.status === "accepted") {
    return { ok: false, code: "invalid_request", message: "成果已采纳；重试请使用原操作 ID" };
  }
  if (deliverable.isSpeculation) {
    return { ok: false, code: "speculation_not_acceptable", message: "未经确认的推测不能成为已确认事实" };
  }
  if (deliverable.hasWriteConflicts && !params.partialAcceptance) {
    return { ok: false, code: "unmet_acceptance_criteria", message: "成果包含被阻止的必需写入，补齐前不能验收" };
  }
  if (params.partialAcceptance && (!params.partialAcceptance.reason?.trim()
    || (params.criterionUpdates ?? []).some(update => !params.partialAcceptance!.criterionIds.includes(update.criterionId)))) {
    return { ok: false, code: "invalid_request", message: "部分采纳必须记录依据，且只能核验明确覆盖的验收项" };
  }
  const binding = deps.repo.getBinding(deliverable.executionId);
  if (!binding || binding.workId !== work.workId) {
    return { ok: false, code: "not_found", message: "成果缺少有效执行来源" };
  }
  if (binding.invalidatedAt || binding.status === "invalidated") {
    return { ok: false, code: "version_conflict", message: "执行已被新要求失效，不能按当前成果验收" };
  }
  if (!deps.collaboration.isDelegationAdopted(binding, work)) {
    return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管此执行委派，不能验收成果" };
  }
  if (deliverable.intentRevision !== work.intentRevision) {
    return {
      ok: false, code: "version_conflict",
      message: `成果基于要求 r${deliverable.intentRevision}，当前为 r${work.intentRevision}；保留为历史证据`,
    };
  }
  if (deliverable.inputSnapshotId !== work.inputSnapshotId) {
    return {
      ok: false, code: "version_conflict",
      message: "成果基于旧的输入快照，不能确认当前目标",
    };
  }
  const waivers = new Map((params.waivers ?? []).map((waiver) => [waiver.criterionId, waiver]));
  if (waivers.size > 0 && resolved.kind !== "user") {
    return { ok: false, code: "unauthorized_actor", message: "只有用户可以豁免必要验收条件" };
  }
  const nextCriteria = work.criteria.map(criterion => ({ ...criterion }));
  for (const update of params.criterionUpdates ?? []) {
    if (deliverable.uncoveredCriterionIds.includes(update.criterionId)) {
      return { ok: false, code: "unmet_acceptance_criteria", message: "该验收项仍有未补齐的成果缺口" };
    }
    const criterion = nextCriteria.find(item => item.id === update.criterionId);
    if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${update.criterionId}` };
    if (update.evidenceIds.length === 0) {
      return { ok: false, code: "unmet_acceptance_criteria", message: `验收条件「${criterion.text}」没有依据证据` };
    }
    for (const evidenceId of update.evidenceIds) {
      const evidence = deps.repo.getEvidence(evidenceId);
      if (!evidence || evidence.workId !== work.workId) {
        return { ok: false, code: "not_found", message: "找不到验收证据" };
      }
      if (evidence.provenance === "execution") {
        return { ok: false, code: "unmet_acceptance_criteria", message: "执行者自述只作为待核验材料，必须使用宿主核对后的证据" };
      }
      if (evidence.deliverableId !== deliverable.deliverableId && evidence.executionId !== binding.bindingId) {
        return { ok: false, code: "unmet_acceptance_criteria", message: "证据不属于该成果或执行" };
      }
      if (evidence.intentRevision !== work.intentRevision || evidence.inputSnapshotId !== work.inputSnapshotId) {
        return { ok: false, code: "version_conflict", message: "证据对应旧要求或旧输入快照，不能确认当前目标" };
      }
      if (!evidence.criterionIds.includes(criterion.id)) {
        return { ok: false, code: "unmet_acceptance_criteria", message: `证据没有覆盖验收条件「${criterion.text}」` };
      }
      if (criterionNeedsEnvironment(criterion)) {
        if (evidence.kind !== "real_environment" || evidence.provenance !== "user") {
          return {
            ok: false, code: "unmet_acceptance_criteria",
            message: `验收条件「${criterion.text}」要求真实环境实测反馈，不能由自动测试或推测代替`,
          };
        }
        if (!evidence.environment?.trim()) {
          return { ok: false, code: "unmet_acceptance_criteria", message: "实测证据必须注明环境" };
        }
        if (criterion.requiredEnvironment
          && evidence.environment.trim().toLowerCase() !== criterion.requiredEnvironment.trim().toLowerCase()) {
          return {
            ok: false, code: "unmet_acceptance_criteria",
            message: `实测环境 ${evidence.environment} 与要求环境 ${criterion.requiredEnvironment} 不一致`,
          };
        }
      }
      criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidence.evidenceId])];
    }
    criterion.status = "satisfied";
    criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
  }
  for (const waiver of waivers.values()) {
    const criterion = nextCriteria.find(item => item.id === waiver.criterionId);
    if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${waiver.criterionId}` };
    if (!waiver.reason?.trim()) return { ok: false, code: "invalid_request", message: "豁免必须记录原因" };
    criterion.status = "waived";
    criterion.waivedReason = waiver.reason.trim().slice(0, 1000);
    criterion.waivedByUserId = resolved.userId;
  }
  deps.repo.updateDeliverableReview(deliverable.deliverableId, {
    status: "accepted", reviewedAt: now, reviewedByBotId: resolved.bot?.botId ?? `user:${resolved.userId}`,
  });
  const next: WorkDto = {
    ...work,
    criteria: nextCriteria,
    acceptedDeliverableIds: [...new Set([...work.acceptedDeliverableIds, deliverable.deliverableId])],
    progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
    stateVersion: work.stateVersion + 1,
    updatedAt: now,
  };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.deliverable_accepted", operationId: params.operationId,
    bindingId: binding.bindingId, payload: { deliverableId: deliverable.deliverableId, partialAcceptance: params.partialAcceptance },
  });
  // Same transaction: the one card for this accepted outcome. A replay lands on the
  // same key, so a re-observed result never mints a second card.
  deps.phase5.recordAcceptance(next, deliverable, now);
  return { ok: true, outboxEventId };
}

export function rejectDeliverableMutation(deps: DeliverableMutationDeps, work: WorkDto, resolved: ResolvedActor, params: RejectDeliverableParams, now: number): Mutation {
  const deliverable = deps.repo.getDeliverable(params.deliverableId);
  if (!deliverable || deliverable.workId !== work.workId) {
    return { ok: false, code: "not_found", message: "找不到成果记录" };
  }
  if (deliverable.status !== "proposed") {
    return { ok: false, code: "invalid_request", message: "只有待验收成果可以拒绝" };
  }
  deps.repo.updateDeliverableReview(deliverable.deliverableId, {
    status: "rejected", reviewedAt: now, reviewedByBotId: work.ownerBotId, rejectedReason: params.reason,
  });
  const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
  deps.repo.updateWork(next);
  return { ok: true };
}

export function recordUserFeedbackMutation(deps: DeliverableMutationDeps, work: WorkDto, resolved: ResolvedActor, params: RecordUserFeedbackParams, now: number, artifactInspection: ArtifactInspection): Mutation {
  if (!deps.artifacts.validate(artifactInspection, now)) {
    deps.emitCurrentProjection(work.workId);
    return { ok: false, code: "version_conflict", message: "产物版本发生变化，已保留历史成果并重新打开相关验收项" };
  }

  if (work.userId !== resolved.userId) return { ok: false, code: "not_found", message: "找不到 Work" };
  if (!params.environment?.trim()) return { ok: false, code: "invalid_request", message: "实测反馈必须注明环境" };
  if (!params.sourceRef?.trim()) return { ok: false, code: "invalid_request", message: "实测反馈必须注明被测版本" };
  const inputSnapshotId = params.inputSnapshotId?.trim();
  if (!inputSnapshotId || inputSnapshotId === "snapshot:unbound") {
    return { ok: false, code: "invalid_request", message: "实测反馈必须明确绑定被测输入快照，不能默认使用当前版本" };
  }
  if (artifactInspection.observed.length && params.artifactSnapshotId !== deps.artifacts.snapshotId(artifactInspection))
    return { ok: false, code: "version_conflict", message: "实测反馈必须绑定被测产物版本，旧产物反馈不能验证当前结果" };
  const historical = inputSnapshotId !== work.inputSnapshotId;
  const criteria = work.criteria.map(criterion => ({ ...criterion }));
  const evidenceId = newId("evidence");
  const affected: string[] = [];
  for (const criterionId of params.criterionIds) {
    const criterion = criteria.find(item => item.id === criterionId);
    if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${criterionId}` };
    if (historical) {
      affected.push(criterion.id);
      continue;
    }
    if (criterion.requiredEnvironment
      && criterion.requiredEnvironment.trim().toLowerCase() !== params.environment.trim().toLowerCase()) {
      return {
        ok: false, code: "unmet_acceptance_criteria",
        message: `反馈环境 ${params.environment} 与要求环境 ${criterion.requiredEnvironment} 不一致`,
      };
    }
    criterion.status = params.failed ? "failed" : "satisfied";
    // Explicit user feedback adopts this check as a user requirement, even
    // when the initial check was only a model suggestion.
    delete criterion.origin;
    criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
    criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidenceId])];
    affected.push(criterion.id);
  }
  deps.repo.insertEvidence({
    evidenceId,
    workId: work.workId,
    criterionIds: affected,
    kind: "real_environment",
    provenance: "user",
    sourceRef: params.sourceRef.trim(),
    sourceSha: params.sourceSha,
    inputSnapshotId,
    environment: params.environment.trim(),
    intentRevision: work.intentRevision,
    detail: params.detail,
    recordedAt: now,
  });
  const next: WorkDto = { ...work, criteria, stateVersion: work.stateVersion + 1, updatedAt: now };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.user_feedback_recorded", operationId: params.operationId,
    payload: { evidenceId, failed: params.failed, environment: params.environment, historical },
  });
  return { ok: true, outboxEventId };
}

export function attestCriteriaMutation(deps: DeliverableMutationDeps, work: WorkDto, resolved: ResolvedActor, params: AttestCriteriaParams, now: number, artifactInspection: ArtifactInspection | undefined): Mutation {
  if (resolved.kind !== "user" || resolved.userId !== work.userId) {
    return { ok: false, code: "unauthorized_actor", message: "只有用户可以确认验收条件" };
  }
  if (params.inputSnapshotId !== undefined && (params.inputSnapshotId !== work.inputSnapshotId
    || params.inputSnapshotId === "snapshot:unbound" || !artifactInspection
    || !deps.artifacts.validate(artifactInspection, now)
    || artifactInspection.observed.length > 0 && params.artifactSnapshotId !== deps.artifacts.snapshotId(artifactInspection))) {
    return { ok: false, code: "version_conflict", message: "验收依据的输入或产物已变化，请核对当前版本" };
  }
  const criteria = work.criteria.map(criterion => ({ ...criterion }));
  const evidenceId = newId("evidence");
  const evidenceCriteria: string[] = [];
  for (const update of params.criterionUpdates) {
    const criterion = criteria.find(item => item.id === update.criterionId);
    if (!criterion) return { ok: false, code: "not_found", message: `找不到验收条件 ${update.criterionId}` };
    delete criterion.origin;
    if (update.status === "pending") {
      criterion.status = "pending";
      criterion.verifiedIntentRevision = undefined;
      criterion.evidenceRefs = [];
      criterion.waivedReason = undefined;
      criterion.waivedByUserId = undefined;
      continue;
    }
    if (update.status === "waived") {
      if (!update.evidence?.trim()) return { ok: false, code: "invalid_request", message: "豁免验收条件必须记录原因" };
      criterion.status = "waived";
      criterion.waivedReason = update.evidence.trim().slice(0, 1000);
      criterion.waivedByUserId = resolved.userId;
      continue;
    }
    if (update.status === "met" && criterionNeedsEnvironment(criterion)) {
      return {
        ok: false, code: "unmet_acceptance_criteria",
        message: `验收条件「${criterion.text}」要求注明环境与版本的实测反馈，请在 Bot 模式提交实测结果`,
      };
    }
    criterion.status = update.status === "met" ? "satisfied" : "failed";
    criterion.verifiedIntentRevision = criterion.requiredIntentRevision;
    criterion.evidenceRefs = [...new Set([...criterion.evidenceRefs, evidenceId])];
    evidenceCriteria.push(criterion.id);
  }
  if (evidenceCriteria.length > 0) {
    deps.repo.insertEvidence({
      evidenceId,
      workId: work.workId,
      criterionIds: evidenceCriteria,
      kind: "user_attestation",
      provenance: "user",
      sourceRef: `user-attestation:${params.operationId}`,
      inputSnapshotId: work.inputSnapshotId,
      intentRevision: work.intentRevision,
      detail: params.progressSummary
        ?? params.criterionUpdates.map(update => update.evidence).filter(Boolean).join("; ").slice(0, 2000),
      recordedAt: now,
    });
  }
  const next: WorkDto = {
    ...work,
    criteria,
    progressSummary: params.progressSummary?.trim().slice(0, 2000) || work.progressSummary,
    stateVersion: work.stateVersion + 1,
    updatedAt: now,
  };
  deps.repo.updateWork(next);
  return { ok: true };
}
