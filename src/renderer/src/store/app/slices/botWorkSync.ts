import type { WorkProjectionDto } from "../../../../../shared/bot-work";
import type { WorkListCursor, WorkListUpdate } from "../../../../../shared/bot-conversation";

export function reconcileWorkProjection(incoming: WorkProjectionDto, observed?: WorkProjectionDto): WorkProjectionDto {
  if (!observed) return incoming;
  if (observed.stateVersion > incoming.stateVersion) return observed;
  const readAtById = new Map(observed.notifications.map(item => [item.notificationId, item.readAt]));
  return { ...incoming, notifications: incoming.notifications.map(item => {
    const readAt = Math.max(item.readAt ?? 0, readAtById.get(item.notificationId) ?? 0);
    return readAt ? { ...item, readAt } : item;
  }) };
}

export function mergeWorkList(works: WorkProjectionDto[], cursor: WorkListCursor | null, update: WorkListUpdate):
  { works: WorkProjectionDto[]; cursor: WorkListCursor } | undefined {
  if (update.kind === "resync_required") return undefined;
  if (update.kind === "snapshot") {
    if (cursor?.epoch === update.cursor.epoch && cursor.scope === update.cursor.scope && cursor.sequence > update.cursor.sequence) return { works, cursor };
    const observed = new Map(works.map(work => [work.workId, work]));
    return { works: update.works.map(work => reconcileWorkProjection(work, observed.get(work.workId))), cursor: update.cursor };
  }
  if (!cursor || cursor.epoch !== update.cursor.epoch || cursor.scope !== update.cursor.scope) return undefined;
  if (update.cursor.sequence <= cursor.sequence) return { works, cursor };
  if (update.from !== cursor.sequence || update.events.some((event, index) => event.sequence !== update.from + index + 1)
    || update.cursor.sequence !== update.from + update.events.length) return undefined;
  const next = new Map(works.map(work => [work.workId, work]));
  for (const event of update.events) {
    if (event.kind === "remove") next.delete(event.workId);
    else next.set(event.projection.workId, reconcileWorkProjection(event.projection, next.get(event.projection.workId)));
  }
  return { works: [...next.values()], cursor: update.cursor };
}
