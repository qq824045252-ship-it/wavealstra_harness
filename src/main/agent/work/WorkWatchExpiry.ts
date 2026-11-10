import type { WorkDto } from "../../../shared/bot-work";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import type { WorkService } from "./WorkService";

type Instruction = { work: WorkDto; eventType: string; operationId: string; bindingId?: string; payload: Record<string, unknown> };
/** Called in a host-authority transaction. Terminal facts use existing nullable
 * conclusion + an explicit reason: never encode an expiry as cancelled/failed. */
export function expireWatchTime(works: WorkService, workId: string, now: number, reviewDelivered: boolean,
  outbox: (input: Instruction) => string): void {
  let work = works.getWork(workId);
  if (!work || work.lifecycle === "closed") return;
  const requested = work.watchRule?.termination;
  if (!watchTimeExpired(work, now) && !(requested && requested.scheduledEndsAt === work.watchRule?.endsAt)) return;
  const rule = work.watchRule!;
  // A prior human cancellation/failure retains its own meaning and control path.
  if (work.lifecycle === "closing" && (!rule.termination || work.pendingConclusion)) return;
  const operationId = `watch-expiry:${workId}:${rule.endsAt}`;
  if (!rule.termination) {
    work = { ...work, lifecycle: "closing", pendingConclusion: undefined,
      watchRule: { ...rule, termination: { reason: "schedule_expired", scheduledEndsAt: rule.endsAt!, requestedAt: now } },
      closureSummary: "持续追踪期限已到，已停止新检查，正在结算在途执行和最后一轮汇报。", stateVersion: work.stateVersion + 1, updatedAt: now };
    works.repo.updateWork(work);
    works.repo.stopSubscriptionsForWork(workId, now);
    outbox({ work, eventType: "work.watch_expiry_requested", operationId,
      payload: { scheduledEndsAt: rule.endsAt, requestedAt: now } });
    for (const binding of works.repo.listBindings(workId)) {
      if (["pending", "submitted", "running", "unknown"].includes(binding.status))
        outbox({ work, eventType: "work.execution.stop_requested", operationId, bindingId: binding.bindingId,
          payload: { bindingId: binding.bindingId, reason: "watch_schedule_expired" } });
    }
    works.emitCurrentProjection(workId);
  }
  // Old expiry cannot terminate a subsequently changed plan.
  if (work.watchRule?.termination?.scheduledEndsAt !== work.watchRule?.endsAt) return;
  const bindings = works.repo.listBindings(workId);
  if (bindings.some(binding => ["pending", "submitted", "running", "unknown"].includes(binding.status))
    || works.repo.listAdmissions(workId).some(item => item.state === "admitted")
    || (bindings.length > 0 && !reviewDelivered)) return;
  const next: WorkDto = { ...work, lifecycle: "closed", closureConclusion: undefined, pendingConclusion: undefined,
    watchRule: { ...work.watchRule!, termination: { ...work.watchRule!.termination!, settledAt: now } },
    closureSummary: bindings.length ? "持续追踪已到期结束；在途执行已结算，最后一轮汇报已处理。期限结束不代表目标已达成，已有结果与未覆盖内容仍保留。"
      : "持续追踪已到期结束。本次期限内未产生执行轮次，不代表已进行检查或目标已达成。",
    closedAt: now, closeOperationId: operationId, activeExecutionIds: [], stateVersion: work.stateVersion + 1, updatedAt: now };
  works.repo.updateWork(next);
  works.cards.refreshSummary(next, now);
  outbox({ work: next, eventType: "work.closed", operationId,
    payload: { terminationReason: "schedule_expired", scheduledEndsAt: rule.endsAt, closedAt: now, closureSummary: next.closureSummary } });
  works.repo.insertNotification({ notificationId: operationId, workId, semanticKey: operationId, kind: "closed",
    title: `追踪到期结束：${next.title}`, body: next.closureSummary, stateVersion: next.stateVersion,
    intentRevision: next.intentRevision, delivery: "pending", createdAt: now, attemptCount: 0 });
  works.emitCurrentProjection(workId);
}
