import type { PauseWorkParams, ResumeWorkParams, WorkDto } from "../../../shared/bot-work";
import type { WorkRepository } from "./WorkRepository";
import type { WorkRecordArchive } from "./WorkRecordArchive";
import type { WorkPausedBacklog } from "./WorkPausedBacklog";
import type { Mutation } from "./WorkControlTypes";

interface PauseResumeMutationDeps {
  repo: Pick<WorkRepository, "updateWork" | "listInbox">;
  recordArchive: Pick<WorkRecordArchive, "clearOnExplicitResume">;
  pausedBacklog: Pick<WorkPausedBacklog, "resume">;
  outbox: (params: { work: WorkDto; eventType: string; operationId: string; payload: Record<string, unknown> }) => string;
}

/** Pause/resume facts are part of the caller's control transaction. */
export function pauseWorkMutation(deps: PauseResumeMutationDeps, work: WorkDto, params: PauseWorkParams, now: number): Mutation {
  const next: WorkDto = {
    ...work, lifecycle: "paused", stateVersion: work.stateVersion + 1, updatedAt: now,
  };
  deps.repo.updateWork(next);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.paused", operationId: params.operationId,
    payload: { reason: params.reason, activeExecutionIds: work.activeExecutionIds },
  });
  return { ok: true, outboxEventId };
}

export function resumeWorkMutation(deps: PauseResumeMutationDeps, work: WorkDto, params: ResumeWorkParams, now: number): Mutation {
  if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now) {
    return { ok: false, code: "unauthorized_actor", message: "Work 授权已过期，恢复前需要重新授权" };
  }
  deps.recordArchive.clearOnExplicitResume(work.workId);
  const next: WorkDto = {
    ...work, lifecycle: "active", stateVersion: work.stateVersion + 1, updatedAt: now,
  };
  deps.repo.updateWork(next);
  deps.pausedBacklog.resume(next, now);
  const outboxEventId = deps.outbox({
    work: next, eventType: "work.resumed", operationId: params.operationId,
    payload: { pendingEvents: deps.repo.listInbox(work.workId).length },
  });
  return { ok: true, outboxEventId };
}
