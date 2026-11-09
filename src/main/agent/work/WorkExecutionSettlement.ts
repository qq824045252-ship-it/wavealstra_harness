import type { ReconcileExecutionParams, WorkControlResult, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { newId, type WorkRepository } from "./WorkRepository";

const terminal = new Set(["completed", "failed", "stopped", "invalidated"]);
interface SettlementInput {
  repo: WorkRepository;
  work: WorkDto;
  binding: WorkExecutionBindingDto;
  params: ReconcileExecutionParams;
  now: number;
  tryClose: (work: WorkDto, now: number) => { ok: boolean; outboxEventId?: string };
}

/** Called only inside the authenticated WorkService write transaction. */
export function settleWorkExecution({ repo, work, binding, params, now, tryClose }: SettlementInput): WorkControlResult {
  const status = params.outcome;
  const settled = terminal.has(status);
  const unknownRef = params.unknownExternalEffectRef ?? binding.bindingId;
  const needsBlocker = status === "unknown" && !repo.listBlockers(work.workId).some(item => item.unknownExternalEffectRef === unknownRef);
  const settleOrphanedAdmissions = () => {
    if (!settled) return;
    for (const admission of repo.listAdmissions(work.workId)) {
      if (admission.bindingId === binding.bindingId && admission.state === "admitted") {
        settleWorkAdmission({ repo, admissionId: admission.admissionId, outcome: "unknown",
          note: "原执行已结束，工具回执未确认；保留诊断并继续独立步骤，不自动重放原操作", now, tryClose });
      }
    }
  };
  if (terminal.has(binding.status) && status !== binding.status
    || binding.status === status && !needsBlocker) {
    // A retained native fact may have already settled execution while adoption was
    // pending. Clearing its final blocker must still finish a later cancellation.
    settleOrphanedAdmissions();
    const settlement = tryClose(repo.getWork(work.workId)!, now);
    const latest = repo.getWork(work.workId)!;
    return { ok: true, replayed: latest.stateVersion === work.stateVersion, operationId: binding.operationId,
      work: latest, outboxEventId: settlement.ok ? settlement.outboxEventId : undefined };
  }
  repo.updateBinding({
    ...binding,
    status,
    submissionReceipt: params.submissionReceipt ?? binding.submissionReceipt,
    settlementNote: params.note ?? binding.settlementNote,
    settledAt: status === "unknown" ? undefined : (settled ? now : binding.settledAt),
    attemptId: binding.attemptId,
  });
  if (settled) {
    const instruction = repo.listOutbox(work.workId, ["pending", "attempted", "unknown"])
      .find(item => item.bindingId === binding.bindingId);
    if (instruction) repo.markOutboxStatus(instruction.eventId, "delivered");
  }
  if (needsBlocker) {
    repo.insertBlocker({
      blockerId: newId("blocker"),
      workId: work.workId,
      reason: params.unknownExternalEffectRef
        ? `外部效果未知，需要核对：${params.unknownExternalEffectRef}`
        : "执行结果未知，需要核对",
      kind: "external_effect",
      unknownExternalEffectRef: params.unknownExternalEffectRef ?? binding.bindingId,
      waitingForUserInput: false,
      status: "open",
      createdAt: now,
    });
  }
  const next: WorkDto = {
    ...work,
    activeExecutionIds: settled || status === "unknown"
      ? work.activeExecutionIds.filter(id => id !== binding.bindingId)
      : [...new Set([...work.activeExecutionIds, binding.bindingId])],
    stateVersion: work.stateVersion + 1,
    updatedAt: now,
  };
  repo.updateWork(next);
  // A final native observation can arrive after an interrupted host lost
  // afterTool. Do not strand those admissions as permanently in-flight. Preserve
  // their uncertainty (never success/no-effect) and original operation identity.
  settleOrphanedAdmissions();
  const settlement = tryClose(repo.getWork(work.workId)!, now);
  const latest = repo.getWork(work.workId)!;
  return {
    ok: true, replayed: false, operationId: binding.operationId,
    work: latest, outboxEventId: settlement.ok ? settlement.outboxEventId : undefined,
  };
}

/** Admission and its effect blocker settle within the caller's Work transaction. */
export function settleWorkAdmission({ repo, admissionId, outcome, note, now, tryClose }: {
  repo: WorkRepository; admissionId: string; outcome: "consumed" | "released" | "unknown"; note?: string; now: number;
  tryClose: (work: WorkDto, now: number) => unknown;
}): { ok: boolean; message?: string } {
  const admission = repo.getAdmission(admissionId);
  if (!admission) return { ok: false, message: "找不到准入记录" };
  if (admission.state === outcome) return { ok: true };
  // A late uncertain result cannot replace a confirmed completed invocation.
  if (admission.state !== "admitted" && admission.state !== "unknown") return { ok: true };
  repo.updateAdmissionState(admission.admissionId, outcome, now);
  if (outcome === "unknown" && !repo.listBlockers(admission.workId).some(item => item.unknownExternalEffectRef === admission.admissionId)) {
    repo.insertBlocker({
      blockerId: newId("blocker"), workId: admission.workId,
      reason: note ? `外部效果未知：${note}` : "外部效果未知，需要核对",
      kind: "external_effect", unknownExternalEffectRef: admission.admissionId,
      waitingForUserInput: false, status: "open", createdAt: now,
    });
  }
  if (outcome !== "unknown") for (const blocker of repo.listOpenBlockers(admission.workId)) {
    if (blocker.unknownExternalEffectRef === admission.admissionId) repo.clearBlocker(blocker.blockerId, admission.workId, now);
  }
  const work = repo.getWork(admission.workId);
  if (work) {
    const next = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
    repo.updateWork(next);
    tryClose(next, now);
  }
  return { ok: true };
}
