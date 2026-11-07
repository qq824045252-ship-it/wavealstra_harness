import type { ReconcileExecutionParams, WorkBudgetReservationDto, WorkControlResult, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { newId, type WorkRepository } from "./WorkRepository";

const terminal = new Set(["completed", "failed", "stopped", "invalidated"]);
interface SettlementInput {
  repo: WorkRepository;
  work: WorkDto;
  binding: WorkExecutionBindingDto;
  params: ReconcileExecutionParams;
  now: number;
  commitUsage: (reservation: WorkBudgetReservationDto, tokens: number, now: number) => void;
  tryClose: (work: WorkDto, now: number) => { ok: boolean; outboxEventId?: string };
}

/** Called only inside the authenticated WorkService write transaction. */
export function settleWorkExecution({ repo, work, binding, params, now, commitUsage, tryClose }: SettlementInput): WorkControlResult {
  const status = params.outcome;
  if (params.reservationId && params.reservationId !== binding.reservationId) {
    return { ok: false, code: "invalid_request", message: "预算结算身份不属于该执行绑定" };
  }
  const reservation = binding.reservationId ? repo.getReservation(binding.reservationId) : undefined;
  if (params.usageTokens !== undefined && (!Number.isSafeInteger(params.usageTokens) || params.usageTokens < 0)) {
    return { ok: false, code: "invalid_request", message: "原生用量必须是非负整数" };
  }
  const hasUsage = status !== "unknown" && params.usageTokens !== undefined;
  const usagePending = hasUsage && reservation && ["reserved", "unknown"].includes(reservation.state);
  const settled = terminal.has(status);
  const usageUnknown = settled && reservation && ["reserved", "unknown"].includes(reservation.state) && !hasUsage;
  const usageBlocker = repo.getBlocker(`usage:${binding.bindingId}`);
  const needsUsageBlocker = usageUnknown && usageBlocker?.status !== "open";
  const unknownRef = params.unknownExternalEffectRef ?? binding.bindingId;
  const needsBlocker = status === "unknown" && !repo.listOpenBlockers(work.workId).some(item => item.unknownExternalEffectRef === unknownRef);
  if (terminal.has(binding.status) && status !== binding.status
    || binding.status === status && !usagePending && !needsBlocker && !needsUsageBlocker && !(usageUnknown && reservation?.state === "reserved")) {
    // A retained native fact may have already settled usage while adoption was
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
  if ((status === "unknown" || usageUnknown) && reservation?.state === "reserved") {
    repo.updateReservation(reservation.reservationId, "unknown", now);
    repo.updateWork({ ...work, budget: { ...work.budget, unknownUsageCount: work.budget.unknownUsageCount + 1 } });
  }
  if (needsUsageBlocker && usageBlocker) repo.reopenBlocker(usageBlocker.blockerId, work.workId);
  else if (needsUsageBlocker) repo.insertBlocker({
    blockerId: `usage:${binding.bindingId}`, workId: work.workId, reason: "原生用量尚未完整返回，保留原预算预留待核对",
    kind: "operational", waitingForUserInput: false, status: "open", createdAt: now,
  });
  if (hasUsage && reservation && reservation.workId === work.workId) {
    commitUsage(reservation, params.usageTokens!, now);
    repo.clearBlocker(`usage:${binding.bindingId}`, work.workId, now);
  }
  const next: WorkDto = {
    ...work,
    budget: repo.getWork(work.workId)!.budget,
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
