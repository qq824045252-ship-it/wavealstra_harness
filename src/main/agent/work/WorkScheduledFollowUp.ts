import type { WorkDto, WorkInboxEventDto, WorkSubscriptionDto } from "../../../shared/bot-work";

/** A timer asks for a new observation, never a replay of the original write task. */
export function isScheduledFollowUp(event: WorkInboxEventDto | undefined): boolean {
  return event?.eventType === "deadline_expired" || event?.eventType === "work.tick"
    || event?.eventType === "work.offline_catchup" && event.payload.readOnlyFollowUp === true;
}

export function scheduledFollowUpCurrent(work: WorkDto, event: WorkInboxEventDto | undefined,
  subscription?: WorkSubscriptionDto): boolean {
  if (!event || event.workId !== work.workId) return false;
  if (event.eventType === "deadline_expired") return event.payload.deadlineRevision === work.deadlineRevision
    && event.payload.deadlineAt === work.deadlineAt;
  if (event.eventType === "work.tick") return Boolean(subscription && !subscription.stoppedAt
    && event.payload.scheduleRevision === (subscription.scheduleRevision ?? 1));
  return true;
}
