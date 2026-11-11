import type { WorkProjectionDto } from "../../../../../shared/bot-work";
import type { WorkListCursor, WorkListUpdate } from "../../../../../shared/bot-conversation";

/**
 * Merge one projection with what the client already shows.
 *
 * `authoritative` marks a server snapshot, which is the truth at its cursor: a locally
 * cached higher `stateVersion` from an older epoch/scope must not shadow it. Inside one
 * epoch a stale delta still loses to a newer local fact, so a late page cannot roll back
 * an accepted result.
 */
export function reconcileWorkProjection(incoming: WorkProjectionDto, observed?: WorkProjectionDto,
  options: { authoritative?: boolean } = {}): WorkProjectionDto {
  if (!observed) return incoming;
  if (!options.authoritative && observed.stateVersion > incoming.stateVersion) return observed;
  const readAtById = new Map(observed.notifications.map(item => [item.notificationId, item.readAt]));
  const cardReadAt = new Map((observed.cards ?? []).map(card => [card.semanticCardKey, card.readAt]));
  const merged: WorkProjectionDto = {
    ...incoming,
    notifications: incoming.notifications.map(item => {
      const readAt = Math.max(item.readAt ?? 0, readAtById.get(item.notificationId) ?? 0);
      return readAt ? { ...item, readAt } : item;
    }),
  };
  if (!incoming.cards) return merged;
  return {
    ...merged,
    cards: incoming.cards.map(card => {
      // Read facts are monotonic per card; a later server receipt is kept by the newer copy.
      const readAt = Math.max(card.readAt ?? 0, cardReadAt.get(card.semanticCardKey) ?? 0);
      return readAt && readAt !== card.readAt ? { ...card, readAt } : card;
    }),
  };
}

export function mergeWorkList(works: WorkProjectionDto[], cursor: WorkListCursor | null, update: WorkListUpdate):
  { works: WorkProjectionDto[]; cursor: WorkListCursor } | undefined {
  if (update.kind === "resync_required") return undefined;
  if (update.kind === "snapshot") {
    const sameEpoch = cursor?.epoch === update.cursor.epoch && cursor.scope === update.cursor.scope;
    // Same epoch and a strictly older cursor: the local view is already ahead of this page.
    if (sameEpoch && cursor.sequence > update.cursor.sequence) return { works, cursor };
    // Every other snapshot replaces the whole set. Cross-epoch/scope replacement is atomic,
    // so works that no longer exist, their owner bindings and their diagnostics disappear.
    const observed = new Map(works.map(work => [work.workId, work]));
    return {
      works: update.works.map(work => reconcileWorkProjection(work, observed.get(work.workId), { authoritative: true })),
      cursor: update.cursor,
    };
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
  return { works: [...next.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.workId.localeCompare(b.workId)).slice(0, 100), cursor: update.cursor };
}
