import type { AdmitActionParams, WorkAdmissionDto, WorkDto, WorkExecutionBindingDto, WorkExecutionStatus } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";
import type { Fail, ResolvedActor } from "./WorkControlTypes";
import { newId, type WorkRepository } from "./WorkRepository";

interface ActionAdmissionDeps {
  repo: Pick<WorkRepository, "getBinding" | "listAdmissions" | "insertAdmission" | "updateWork">;
  bots: Pick<BotRegistry, "getBot">;
  isDelegationAdopted: (binding: WorkExecutionBindingDto, work: WorkDto) => boolean;
  scheduledBindingCurrent: (binding: WorkExecutionBindingDto) => boolean;
  now: () => number;
}
const TERMINAL_BINDING_STATUSES = new Set<WorkExecutionStatus>(["completed", "failed", "stopped", "invalidated"]);

/** Inside the facade transaction, after actor/access/version validation. No transaction or public control entry of its own. */
export function admitWorkActionMutation(deps: ActionAdmissionDeps, work: WorkDto, resolved: ResolvedActor, params: AdmitActionParams): { ok: true; admission: WorkAdmissionDto } | Fail {
  if (work.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", message: `事项处于 ${work.lifecycle}，拒绝新的业务动作` };
  }
  if (deps.bots.getBot(work.ownerBotId)?.status !== "active") {
    return { ok: false, code: "bot_disabled", message: "主负责人已停用，不能准入新业务动作" };
  }
  // A worker's execution identity comes from the host actor, including when
  // the business payload omits bindingId. Never turn that omission into an
  // unbound admission that skips the current execution/delegation checks.
  const bindingId = params.bindingId ?? resolved.binding?.bindingId;
  if (bindingId) {
    const binding = deps.repo.getBinding(bindingId);
    if (!binding || binding.workId !== work.workId) {
      return { ok: false, code: "not_found", message: "找不到有效执行绑定" };
    }
    if (binding.invalidatedAt || TERMINAL_BINDING_STATUSES.has(binding.status)) {
      return { ok: false, code: "version_conflict", message: "执行绑定已失效或被停止" };
    }
    if (binding.intentRevision !== work.intentRevision) {
      return { ok: false, code: "version_conflict", message: "执行绑定基于旧要求，拒绝新的业务副作用" };
    }
    if (binding.inputSnapshotId !== work.inputSnapshotId) {
      return { ok: false, code: "version_conflict", message: "执行绑定基于旧输入快照，拒绝新的业务副作用" };
    }
    if (!deps.isDelegationAdopted(binding, work)) {
      return { ok: false, code: "epoch_mismatch", message: "当前负责人尚未接管原执行委派" };
    }
    if (resolved.kind === "worker" && resolved.binding?.bindingId !== binding.bindingId) {
      return { ok: false, code: "unauthorized_actor", message: "worker 只能为自己的绑定申请业务动作" };
    }
    if (!deps.scheduledBindingCurrent(binding))
      return { ok: false, code: "version_conflict", message: "检查计划已停止或变更，旧检查不再准入新动作" };
    if (deps.bots.getBot(binding.botId)?.status !== "active") {
      return { ok: false, code: "bot_disabled", message: "执行 Bot 已暂停或停用，不能准入新业务动作" };
    }
  }
  const existing = deps.repo.listAdmissions(work.workId).find(item => item.operationId === params.operationId);
  if (existing) return { ok: true, admission: existing };
  const now = deps.now();
  const admission: WorkAdmissionDto = {
    admissionId: newId("admission"),
    workId: work.workId,
    bindingId,
    operationId: params.operationId,
    actionKind: params.actionKind,
    state: "admitted",
    intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch,
    admittedAt: now,
  };
  deps.repo.insertAdmission(admission);
  const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
  deps.repo.updateWork(next);
  return { ok: true, admission };
}

