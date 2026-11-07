import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";
import type { WorkService } from "./WorkService";
import type { WorkResourceOwner, WorkResource, ResourceLease } from "./WorkResourceGate";
import { readResourceEffectEvidence } from "./WorkResourceRecovery";

export function authorizeWorkResourceOwner(input: { service: WorkService; bots: BotRegistry; now: () => number;
  owner: WorkResourceOwner; resources: WorkResource[] }): string | undefined {
  const { service, bots, now, owner, resources } = input;
  const binding = service.repo.bindingForTask(owner.taskId);
  if (!binding) return owner.bindingId || owner.workId ? "资源执行缺少原绑定" : undefined;
  if (binding.bindingId !== owner.bindingId || binding.workId !== owner.workId
    || binding.durableStoreKey !== owner.durableStoreKey || binding.conversationId !== owner.conversationId
    || binding.workspaceBinding !== owner.workspaceBinding) return "资源执行命名空间不匹配";
  const work = service.repo.getWork(binding.workId);
  if (!work || work.lifecycle !== "active" || binding.invalidatedAt
    || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
    || ["completed", "failed", "stopped", "invalidated"].includes(binding.status)) return "事项暂停、终止或执行输入已失效，拒绝新动作";
  if (!service.collaboration.isDelegationAdopted(binding, work)) return "新负责人尚未接管此执行委派";
  const action = resources.some(resource => resource.mode === "write") ? "workspace:write" : "workspace:read";
  if (!work.authorization.allowedScopes.includes(action) || binding.delegatedScope.length > 0 && !binding.delegatedScope.includes(action))
    return "实际资源动作超出事项或执行委派范围";
  if (bots.getBot(binding.botId)?.status !== "active" || bots.getBot(work.ownerBotId)?.status !== "active") return "Bot 不可受理新资源动作";
  if (work.budget.windowExpiresAt !== undefined && work.budget.windowExpiresAt <= now() || work.budget.usedTokens >= work.budget.maxTokens)
    return "事项预算或期限已用尽";
  if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now()) return "事项授权已过期";
  return undefined;
}

/** Runs in WorkService's control transaction after the verified resource release. */
export function finalizeWorkResource(input: { db: Database.Database; service: WorkService; lease: ResourceLease;
  now: () => number; tryClose: (work: WorkDto, now: number) => unknown }): void {
  const { db, service, lease, now, tryClose } = input;
  if (!db.inTransaction) throw new Error("资源和业务结算必须在同一事务中提交");
  if (service.resourceGate.leaseState(lease) !== "released") throw new Error("资源尚未通过原始核对，不能结算业务准入");
  const binding = lease.owner.bindingId ? service.repo.getBinding(lease.owner.bindingId) : undefined;
  if (!binding) return;
  if (binding.taskId !== lease.owner.taskId || binding.durableStoreKey !== lease.owner.durableStoreKey
    || binding.conversationId !== lease.owner.conversationId || binding.workspaceBinding !== lease.owner.workspaceBinding)
    throw new Error("恢复结算的资源执行命名空间不匹配");
  const work = service.repo.getWork(binding.workId); if (!work) return;
  const parts = lease.actionId.split(":");
  const operationId = lease.actionId.startsWith("resource:")
    ? `tool:${lease.owner.childId ?? lease.owner.conversationId}:${parts[2]}:${parts.slice(3).join(":")}` : undefined;
  const admission = service.repo.listAdmissions(work.workId).find(item => operationId && item.operationId === operationId);
  let changed = false;
  if (admission && (admission.state === "unknown" || admission.state === "admitted")) {
    if (admission.bindingId !== binding.bindingId) throw new Error("资源恢复准入不属于原执行绑定");
    if (!lease.resources.every(resource => resource.mode === "read") && !readResourceEffectEvidence(db, lease).known)
      throw new Error("业务准入尚无原始文件或供应商回执证明");
    service.repo.updateAdmissionState(admission.admissionId, "consumed", now());
    for (const blocker of service.repo.listOpenBlockers(work.workId)) if (blocker.unknownExternalEffectRef === admission.admissionId)
      service.repo.clearBlocker(blocker.blockerId, work.workId, now());
    changed = true;
  }
  if (changed || work.lifecycle === "closing") {
    const latest = service.repo.getWork(work.workId)!;
    service.repo.updateWork({ ...latest, stateVersion: latest.stateVersion + 1, updatedAt: now() });
    tryClose(service.repo.getWork(work.workId)!, now());
    service.emitCurrentProjection(work.workId);
  }
}
