import type { AddParticipantParams, HandoffOwnerParams, WorkActor, WorkDto, BotDto } from "../../../shared/bot-work";
import { WORK_MAX_PARTICIPANTS } from "../../../shared/bot-work";
import type { WorkRepository } from "./WorkRepository";
import type { BotRegistry } from "./BotRegistry";
import type { WorkCollaborationService } from "./WorkCollaborationService";
import type { WorkPhase5Facts } from "./WorkPhase5Facts";
import type { Mutation } from "./WorkControlTypes";

interface DelegationMutationDeps {
  repo: Pick<WorkRepository, "upsertParticipant" | "updateWork" | "getWork">;
  bots: Pick<BotRegistry, "getBot">;
  collaboration: Pick<WorkCollaborationService, "handoffError" | "prepareHandoff" | "preparationError" | "commitHandoffFacts">;
  phase5: Pick<WorkPhase5Facts, "refreshSummary">;
  snapshotOf: (bot: BotDto) => NonNullable<ReturnType<BotRegistry["activeSnapshot"]>>;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; payload: Record<string, unknown> }) => string;
}

/** Delegation facts share the caller's control transaction and receipt. */
export function handoffOwnerMutation(deps: DelegationMutationDeps, work: WorkDto, params: HandoffOwnerParams, now: number, actor: WorkActor): Mutation {
  const target = deps.bots.getBot(params.targetBotId);
  if (!target) return { ok: false, code: "not_found", message: "找不到目标 Bot" };
  if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "目标 Bot 不属于该事项用户" };
  if (target.status !== "active") return { ok: false, code: "bot_disabled", message: "目标 Bot 已停用" };
  const scopeError = deps.collaboration.handoffError(work, params.targetBotId);
  if (scopeError)
    return { ok: false, code: "unauthorized_actor", message: scopeError };
  const preparationId = params.preparationId ?? deps.collaboration.prepareHandoff(actor, work.workId, params.targetBotId).preparationId;
  const preparationError = deps.collaboration.preparationError(preparationId, work, params.targetBotId);
  if (preparationError) return { ok: false, code: "version_conflict", message: preparationError };
  deps.repo.upsertParticipant({
    workId: work.workId, botId: target.botId, role: "collaborator",
    delegatedScope: params.delegatedScope ?? [], expertSnapshot: deps.snapshotOf(target), addedAt: now,
  });
  const next: WorkDto = {
    ...work,
    ownerBotId: target.botId,
    ownerEpoch: work.ownerEpoch + 1,
    stateVersion: work.stateVersion + 1,
    updatedAt: now,
  };
  deps.repo.updateWork(next);
  deps.collaboration.commitHandoffFacts(work, next, params.operationId, now);
  deps.phase5.refreshSummary(work.workId);
  const outboxEventId = deps.outbox({
    work: deps.repo.getWork(work.workId)!, eventType: "work.owner_handed_off", operationId: params.operationId,
    payload: {
      previousOwnerBotId: work.ownerBotId, newOwnerBotId: target.botId,
      previousEpoch: work.ownerEpoch, newEpoch: next.ownerEpoch,
    },
  });
  return { ok: true, outboxEventId };
}

export function addParticipantMutation(deps: DelegationMutationDeps, work: WorkDto, params: AddParticipantParams, now: number): Mutation {
  const target = deps.bots.getBot(params.botId);
  if (!target) return { ok: false, code: "not_found", message: "找不到目标 Bot" };
  if (target.userId !== work.userId) return { ok: false, code: "unauthorized_actor", message: "目标 Bot 不属于该事项用户" };
  if (work.participants.length >= WORK_MAX_PARTICIPANTS) {
    return { ok: false, code: "invalid_request", message: "参与者数量已达上限" };
  }
  deps.repo.upsertParticipant({
    workId: work.workId, botId: target.botId, role: params.role ?? "worker",
    delegatedScope: params.delegatedScope ?? [], expertSnapshot: deps.snapshotOf(target), addedAt: now,
  });
  const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: now };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.participant_added", operationId: params.operationId,
    payload: { botId: target.botId, role: params.role ?? "worker" },
  });
  return { ok: true, outboxEventId };
}
