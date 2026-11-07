import type Database from "better-sqlite3";
import type { WorkProjectionDto } from "../../shared/bot-work";
import type { WorkSummaryProjectionDto } from "../../shared/bot-work-phase5";
import type { RemoteWorkCard, RemoteWorkSummary } from "../../../shared/src/remote-contract";
import { encodeSemanticTuple } from "../../shared/bot-work-phase5";
import type { WorkService } from "../agent/work/WorkService";
import { DESKTOP_USER_GRANTS } from "../agent/work/WorkService";
import { WorkProjectionJournal } from "../agent/work/WorkProjectionJournal";

/**
 * Narrow a host projection to what a paired device needs.
 *
 * The mobile contract deliberately has no bindings, tokens, budget internals or other
 * bots' private context; only the decision surface plus the addressable card identity.
 */
export function toRemoteWorkCard(card: NonNullable<WorkProjectionDto["cards"]>[number]): RemoteWorkCard {
  return {
    cardKey: card.cardKey,
    semanticCardKey: card.semanticCardKey,
    kind: card.kind,
    intentRevision: card.intentRevision,
    inputSnapshotId: card.inputSnapshotId,
    title: card.title,
    summary: card.summary,
    deliverables: card.deliverableIds,
    artifacts: card.artifactRefs,
    unverifiedScope: card.unverifiedScope,
    currency: card.currency,
    createdAt: card.createdAt,
    readAt: card.readAt,
    readVersion: card.readVersion,
  };
}

export function toRemoteWork(summary: WorkSummaryProjectionDto, cards: RemoteWorkCard[]): RemoteWorkSummary {
  return {
    workId: summary.workId,
    title: summary.title,
    goal: summary.goal,
    lifecycle: summary.lifecycle,
    mode: summary.mode,
    ownerEpoch: summary.ownerEpoch,
    intentRevision: summary.intentRevision,
    inputSnapshotId: summary.inputSnapshotId,
    stateVersion: summary.stateVersion,
    acceptedCount: summary.acceptedCount,
    currentCardKeys: summary.currentCardKeys,
    currentConclusion: summary.currentConclusion,
    pendingUserDecisions: summary.pendingUserDecisions,
    nextSteps: summary.nextSteps,
    unverifiedScope: summary.unverifiedScope.map(entry => ({
      criterionId: entry.criterionId, text: entry.text, reason: entry.reason,
      requiredEnvironment: entry.requiredEnvironment,
    })),
    delivery: summary.delivery,
    cards,
    updatedAt: summary.updatedAt,
    closedAt: summary.closedAt,
  };
}

/** Stable device-side cursor label; never derived from an SSE event id. */
export function encodeWorkCursor(epoch: string, sequence: number, scope: "open" | "all"): string {
  return encodeSemanticTuple([epoch, sequence, scope]);
}

/** Project one journal page onto the device contract; unknown works are dropped, not faked. */
export function toRemoteWorkUpdate(
  update: { kind: string; [key: string]: unknown },
  load: (workId: string) => RemoteWorkSummary | undefined,
): unknown {
  if (update.kind === "resync_required") return { kind: "resync_required" };
  const cursor = update.cursor as { epoch: string; sequence: number; scope: "open" | "all" };
  if (update.kind === "snapshot") {
    const works = (update.works as Array<{ workId: string }>)
      .map(item => load(item.workId)).filter((item): item is RemoteWorkSummary => Boolean(item));
    return { kind: "snapshot", cursor, works };
  }
  type RemoteEvent = { kind: "upsert"; sequence: number; work: RemoteWorkSummary }
    | { kind: "remove"; sequence: number; workId: string; reason: "closed" | "removed" };
  const events: RemoteEvent[] = [];
  for (const event of update.events as Array<{ kind: "upsert" | "remove"; sequence: number; workId?: string;
    reason?: string; projection?: { workId: string } }>) {
    if (event.kind === "remove") {
      events.push({ kind: "remove", sequence: event.sequence, workId: event.workId!,
        reason: event.reason === "closed" ? "closed" : "removed" });
      continue;
    }
    // Upsert events carry the projection; the host re-reads the current summary
    // (the projection in the journal is a historical snapshot).
    const work = load(event.projection?.workId ?? event.workId ?? "");
    if (work) events.push({ kind: "upsert", sequence: event.sequence, work });
  }
  return { kind: "delta", cursor, from: update.from as number, hasMore: Boolean(update.hasMore), events };
}

/**
 * The single Work bridge used by both the server wiring and its tests.
 *
 * All reads and writes go through the desktop host service for the authenticated local
 * user, so a paired device can never act as another actor or bypass a version guard.
 */
export function createRemoteWorkBridge(input: { db: Database.Database; works: WorkService; userId: string }) {
  const journal = new WorkProjectionJournal(input.db, input.works);
  const load = (workId: string) => {
    const projection = input.works.getProjection(workId);
    const summary = input.works.getWorkSummary(input.userId, workId);
    return projection && summary ? toRemoteWork(summary, (projection.cards ?? []).map(toRemoteWorkCard)) : undefined;
  };
  return {
    sync: (request: { includeClosed: boolean; cursor?: { epoch: string; sequence: number; scope: "open" | "all" } }) =>
      toRemoteWorkUpdate(journal.sync(input.userId, request) as unknown as { kind: string }, load),
    summary: (workId: string) => load(workId),
    diagnostics: (request: { workId: string; sections?: string[]; limit?: number; cursor?: string }) =>
      input.works.getWorkDiagnostics(input.userId, request),
    markCardRead: (request: { workId: string; semanticCardKey: string; readAt?: number }) =>
      input.works.markWorkCardRead({ kind: "user", userId: input.userId, entry: "remote", grants: DESKTOP_USER_GRANTS }, request),
    recordFeedback: (request: unknown) =>
      input.works.recordUserFeedback({ kind: "user", userId: input.userId, entry: "remote", grants: DESKTOP_USER_GRANTS }, request as never),
    resend: (request: unknown) =>
      input.works.resendWorkNotification({ kind: "user", userId: input.userId, entry: "remote", grants: DESKTOP_USER_GRANTS }, request),
  };
}
