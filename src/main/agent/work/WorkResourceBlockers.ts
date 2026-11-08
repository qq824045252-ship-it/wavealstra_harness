import { createHash } from "node:crypto";
import type { WorkBlockerReasonCode, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export interface ResourceDispatchBlock { reason: string; sourceWorkId?: string; token?: number }

/** Persist actionable waiting facts; polling/restart never creates another execution. */
export function syncResourceDispatchBlocker(service: WorkService, binding: WorkExecutionBindingDto, blocked?: ResourceDispatchBlock): void {
  const prefix = `resource-dispatch:${binding.bindingId}:`;
  const key = blocked ? prefix + createHash("sha256").update(JSON.stringify(blocked)).digest("hex").slice(0, 20) : undefined;
  sync(service, binding.workId, prefix, key ? [{ id: key, reason: `后台执行尚未提交：${blocked!.reason}。原执行身份已保留，资源核对完成后自动继续，不会重新创建整个任务。`,
    reasonCode: "resource-dispatch-wait", details: { bindingId: binding.bindingId, ...blocked } }] : []);
}

export function syncExhaustedResourceBlockers(service: WorkService, userId: string): void {
  for (const work of service.listWorks(userId, { includeClosed: true })) {
    const exhausted = service.resourceGate.recoveryStatus(work.workId).filter(item => item.exhaustedAt !== undefined);
    sync(service, work.workId, "resource-recovery:", exhausted.map(item => ({ id: `resource-recovery:${item.token}`,
      reason: `共享资源 ${item.token} 自动恢复核对已耗尽。请在“执行情况”中重新核对隔离资源；只有旧执行、输入清理和效果均已核实后才能释放。`,
      reasonCode: "resource-recovery-exhausted", details: { token: item.token, sourceWorkId: work.workId } })));
  }
}

function sync(service: WorkService, workId: string, prefix: string,
  desired: Array<{ id: string; reason: string; reasonCode: WorkBlockerReasonCode; details: Record<string, unknown> }>): void {
  const changed = service.transaction(() => {
    const work = service.getWork(workId); if (!work) return false;
    const now = Date.now(); let changed = false;
    for (const old of service.repo.listOpenBlockers(workId)) if (old.blockerId.startsWith(prefix) && !desired.some(item => item.id === old.blockerId)) {
      service.repo.clearBlocker(old.blockerId, workId, now); changed = true;
    }
    for (const item of desired) {
      const old = service.repo.getBlocker(item.id);
      if (!old) { service.repo.insertBlocker({ blockerId: item.id, workId, kind: "operational", reason: item.reason,
        reasonCode: item.reasonCode, details: item.details, waitingForUserInput: true, status: "open", createdAt: now }); changed = true; }
      else if (old.status !== "open") { service.repo.reopenBlocker(old.blockerId, workId); changed = true; }
    }
    if (changed) service.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
    return changed;
  });
  if (changed) service.emitCurrentProjection(workId);
}
