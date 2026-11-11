import type { ReconcileExecutionParams, WorkControlResult, WorkDto } from "../../../shared/bot-work";
import type { Fail, Mutation, ResolvedActor } from "./WorkControlTypes";
import type { WorkRepository } from "./WorkRepository";
import { settleWorkExecution } from "./WorkExecutionSettlement";

interface ReconciliationDeps {
  repo: WorkRepository;
  authorityError: () => Fail | undefined;
  now: () => number;
  tryClose: (work: WorkDto, now: number) => Mutation;
}

/** Binding-specific reconciliation; caller owns actor resolution and the original transaction.
 * Deliberately not routed through new-business lifecycle filtering: stopped/cancelled work
 * must still accept facts from its original execution. Settlement itself remains shared.
 */
export function reconcileWorkExecution(deps: ReconciliationDeps, resolved: ResolvedActor, params: ReconcileExecutionParams): WorkControlResult {
  const binding = deps.repo.getBinding(params.bindingId);
  if (!binding) return { ok: false, code: "not_found", message: "找不到执行绑定" };
  const work = deps.repo.getWork(binding.workId);
  if (!work) return { ok: false, code: "not_found", message: "找不到 Work" };
  if (resolved.kind !== "system") {
    if (resolved.kind === "worker") {
      if (resolved.binding?.bindingId !== binding.bindingId) {
        return { ok: false, code: "unauthorized_actor", message: "worker 只能结算自己的执行" };
      }
    } else if (work.userId !== resolved.userId) {
      return { ok: false, code: "not_found", message: "找不到 Work" };
    } else if (resolved.kind === "bot" && resolved.bot?.botId !== work.ownerBotId) {
      return { ok: false, code: "unauthorized_actor", message: "只有当前负责人可以结算执行" };
    }
  }
  const authorityError = deps.authorityError();
  if (authorityError) return authorityError;
  return settleWorkExecution({ repo: deps.repo, work, binding, params, now: deps.now(),
    tryClose: (next, now) => deps.tryClose(next, now) });
}
