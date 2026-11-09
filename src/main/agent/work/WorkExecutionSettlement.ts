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
  const needsBlocker = status === "unknown" && !repo.listOpenBlockers(work.workId).some(item => item.unknownExternalEffectRef === unknownRef);
  if (terminal.has(binding.status) && status !== binding.status
    || binding.status === status && !needsBlocker) {
    // A retained native fact may have already settled execution while adoption was
    // pending. Clearing its final blocker must still finish a later cancellation.
    const settlement = tryClose(work, now);
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
  const settlement = tryClose(next, now);
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
  repo.updateAdmissionState(admission.admissionId, outcome, now);
  if (outcome === "unknown") {
    repo.insertBlocker({
      blockerId: newId("blocker"), workId: admission.workId,
      reason: note ? `外部效果未知：${note}` : "外部效果未知，需要核对",
      kind: "external_effect", unknownExternalEffectRef: admission.admissionId,
      waitingForUserInput: false, status: "open", createdAt: now,
    });
  }
  const work = repo.getWork(admission.workId);
  if (work) {
    const next = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
    repo.updateWork(next);
    tryClose(next, now);
  }
  return { ok: true };
}
