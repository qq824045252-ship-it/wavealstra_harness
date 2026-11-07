import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkDto, WorkInboxEventDto, WorkSourceEventDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import type { WorkSourceAdapterCapability, WorkVersionMode } from "../../../shared/bot-work-phase4";
import { newId } from "./WorkRepository";
import { matchesFilter } from "./WorkControlNormalization";
import type { WorkService } from "./WorkService";

export type IngressRouteOutcome = "pending" | "accepted" | "merged" | "skipped" | "blocked" | "duplicate" | "rejected";

export interface WorkIngressAcceptInput {
  source: string;
  sourceEventId: string;
  eventType: string;
  sourceVersion?: string;
  causalEventId?: string;
  occurredAt?: number;
  payload?: Record<string, unknown>;
  /** Trusted host-provided namespace; payload claims are never trusted. */
  trustedOrigin?: string;
}

export interface WorkIngressAcceptOptions {
  workId?: string;
  subscriptionId?: string;
  /** Offline replay must not pretend the host ran continuously. */
  offline?: boolean;
  offlineGapId?: string;
  /** System facts (cron deadline, host events) bypass external source adapters. */
  trust?: "adapter" | "host" | "system";
  trustedOrigin?: string;
}

export interface WorkIngressRouteResult {
  workId: string;
  subscriptionId: string;
  outcome: IngressRouteOutcome;
  reasonCode?: string;
  inboxEventId?: string;
  targetKey: string;
}

export interface WorkIngressAcceptResult {
  sourceNew: boolean;
  /** True only when every legal route was durably accepted, merged, skipped or already handled. */
  acknowledged: boolean;
  outcomes: WorkIngressRouteResult[];
}

export interface WorkQueueStats {
  ready: number;
  frozen: number;
  blocked: number;
  bytes: number;
  maxEvents: number;
  maxBytes: number;
  oldestAt?: number;
  mergeDeadlineAt?: number;
  readySince?: number;
  waitReason?: string;
}

export interface WorkSubscriptionCursor {
  subscriptionId: string;
  source: string;
  targetKey: string;
  highestAcceptedVersion?: string;
  highestConsumedVersion?: string;
  highestFrozenVersion?: string;
  replayCursor?: string;
  enumerationWatermark?: string;
  acceptedEvents: number;
  consumedEvents: number;
  acceptedBytes: number;
}

const BUILTIN_ADAPTERS: WorkSourceAdapterCapability[] = [
  { source: "cron", namespace: "host-cron", versionMode: "monotonic", targetKeyOf: input => String(input.payload.slot ?? "default"),
    canQueryHistory: true, supportsRetry: true, maxPayloadBytes: 64 * 1024 },
  { source: "system", namespace: "host-system", versionMode: "readback", targetKeyOf: () => "default",
    canQueryHistory: false, supportsRetry: true, maxPayloadBytes: 64 * 1024 },
  { source: "hook", namespace: "host-hook", versionMode: "readback", targetKeyOf: input =>
    String(input.payload.target ?? input.payload.targetKey ?? "default"), canQueryHistory: false, supportsRetry: true,
    maxPayloadBytes: 1024 * 1024 },
  { source: "user", namespace: "local-user", versionMode: "readback", targetKeyOf: () => "default",
    canQueryHistory: false, supportsRetry: true, maxPayloadBytes: 1024 * 1024 },
  { source: "foreground_bot", namespace: "local-bot", versionMode: "readback", targetKeyOf: () => "default",
    canQueryHistory: false, supportsRetry: true, maxPayloadBytes: 1024 * 1024 },
  { source: "durable_host", namespace: "local-durable", versionMode: "readback", targetKeyOf: () => "default",
    canQueryHistory: false, supportsRetry: true, maxPayloadBytes: 1024 * 1024 },
];

/**
 * One durable ingress for every event source.
 *
 * Source facts are deduped once; each legal subscription keeps its own route receipt and
 * per-target watermark. `latest` merges only within a fixed, frozen-first deadline; `each`
 * keeps one immutable obligation per event; capacity limits cover the whole acceptance
 * chain and refuse (never silently acknowledge) when the hard limit is reached.
 */
export class WorkWatchIngress {
  private readonly adapters = new Map<string, WorkSourceAdapterCapability>();
  constructor(
    private readonly db: Database.Database,
    private readonly works: WorkService,
    private readonly options: { now?: () => number; isAuthority?: () => boolean } = {},
  ) {
    for (const adapter of BUILTIN_ADAPTERS) this.adapters.set(adapter.source, adapter);
  }

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }
  private authority(): boolean { return !this.options.isAuthority || this.options.isAuthority(); }

  registerAdapter(capability: WorkSourceAdapterCapability): void {
    if (!capability.source || !capability.namespace) throw new Error("来源适配器缺少可信命名空间");
    this.adapters.set(capability.source, capability);
  }

  adapter(source: string): WorkSourceAdapterCapability | undefined { return this.adapters.get(source); }
  canQueryHistory(source: string): boolean { return this.adapters.get(source)?.canQueryHistory ?? false; }

  /** Freeze every batch whose fixed first-received deadline has elapsed. Safe to call repeatedly. */
  freezeDueBatches(now = this.now(), workId?: string): number {
    return this.works.transaction(() => {
      if (!this.authority()) return 0;
      const rows = this.db.prepare(`SELECT event_id,subscription_id,source,source_version,target_key,payload_json,merge_deadline_at
        FROM work_events_inbox WHERE status='merged' AND frozen_at IS NULL AND merge_deadline_at IS NOT NULL
        AND merge_deadline_at<=? ${workId ? "AND work_id=?" : ""} ORDER BY received_at ASC`)
        .all(...[now, ...(workId ? [workId] : [])]) as Array<{ event_id: string; subscription_id: string | null;
          source: string; source_version: string | null; target_key: string | null; payload_json: string;
          merge_deadline_at: number }>;
      let frozen = 0;
      for (const row of rows) {
        const result = this.db.prepare(`UPDATE work_events_inbox SET frozen_at=?,frozen_payload_json=payload_json,
          claim_version=claim_version+1,process_reason='merge-deadline' WHERE event_id=? AND frozen_at IS NULL`)
          .run(now, row.event_id);
        if (!result.changes || !row.subscription_id) continue;
        frozen++;
        if (row.source_version) this.setCursor(row.subscription_id, row.source, row.target_key ?? "default", { highestFrozenVersion: row.source_version });
        this.db.prepare(`UPDATE work_events_inbox SET batch_deadline_at=merge_deadline_at WHERE event_id=? AND batch_deadline_at IS NULL`).run(row.event_id);
      }
      return frozen;
    });
  }

  /**
   * Accept one source fact. Callers must treat `acknowledged=false` as "keep/retry the event":
   * a capacity refusal is never converted into a durable dedupe success.
   */
  accept(event: WorkIngressAcceptInput, input: WorkIngressAcceptOptions = {}): WorkIngressAcceptResult {
    const now = this.now();
    return this.works.transaction((): WorkIngressAcceptResult => {
      if (!this.authority()) throw new Error("当前宿主不是事项控制权威，拒绝接纳来源事件");
      const subscriptions = this.resolveSubscriptions(event, input);
      const payload = event.payload ?? {};
      const payloadText = JSON.stringify(payload);
      const payloadBytes = Buffer.byteLength(payloadText, "utf8");
      const firstAdapter = subscriptions.map(sub => this.adapters.get(sub.source)).find(Boolean);
      if (!subscriptions.length && input.trust === "adapter" && !firstAdapter) {
        return { sourceNew: false, acknowledged: false, outcomes: [] };
      }
      const sourceNew = this.works.repo.recordSourceEvent({
        source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType,
        sourceVersion: event.sourceVersion, causalEventId: event.causalEventId, payload,
        receivedAt: now, occurredAt: event.occurredAt, targetKey: undefined,
        adapter: firstAdapter?.namespace, trustedOrigin: input.trustedOrigin ?? input.trust ?? "adapter",
      });
      const outcomes: WorkIngressRouteResult[] = [];
      for (const subscription of subscriptions) {
        const result = this.route(subscription, event, payload, payloadBytes, now, sourceNew, input);
        if (result) outcomes.push(result);
      }
      return { sourceNew, acknowledged: outcomes.every(item => item.outcome !== "rejected"), outcomes };
    });
  }

  private resolveSubscriptions(event: WorkIngressAcceptInput, input: WorkIngressAcceptOptions): WorkSubscriptionDto[] {
    if (input.subscriptionId) {
      const subscription = this.works.repo.getSubscription(input.subscriptionId);
      // An explicit id cannot cross a source, Work or user boundary.
      if (!subscription || subscription.source !== event.source || subscription.stoppedAt !== undefined) return [];
      if (input.workId && subscription.workId !== input.workId) return [];
      const work = this.works.getWork(subscription.workId);
      if (!work || !["active", "paused"].includes(work.lifecycle)) return [];
      return [subscription];
    }
    return this.works.repo.listActiveSubscriptions().filter(subscription => {
      if (subscription.source !== event.source) return false;
      if (input.workId && subscription.workId !== input.workId) return false;
      const work = this.works.getWork(subscription.workId);
      if (!work || !["active", "paused"].includes(work.lifecycle)) return false;
      if (subscription.sourceTarget && subscription.sourceTarget !== this.targetKeyFor(subscription, event, event.payload ?? {})) return false;
      return matchesFilter(subscription.filter, event.payload ?? {});
    });
  }

  private route(subscription: WorkSubscriptionDto, event: WorkIngressAcceptInput, payload: Record<string, unknown>,
    payloadBytes: number, now: number, sourceNew: boolean, input: WorkIngressAcceptOptions): WorkIngressRouteResult | undefined {
    const work = this.works.getWork(subscription.workId);
    if (!work) return undefined;
    const targetKey = this.targetKeyFor(subscription, event, payload);
    if (subscription.sourceTarget && subscription.sourceTarget !== targetKey) {
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "skipped",
        reasonCode: "target-mismatch", targetKey };
    }
    const existingRoute = this.getRoute(event.source, event.sourceEventId, subscription.subscriptionId);
    if (existingRoute && existingRoute.state !== "rejected") {
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "duplicate",
        reasonCode: existingRoute.reason_code ?? undefined, inboxEventId: existingRoute.inbox_event_id ?? undefined, targetKey };
    }
    this.freezeDueBatches(now, work.workId);
    const stats = this.queueStats(subscription);
    const policy = subscription.catchUpPolicy;
    const openBatch = this.openLatestBatch(subscription.subscriptionId, targetKey);
    const stale = policy === "latest" && event.sourceVersion !== undefined
      ? this.isStale(subscription, targetKey, event.sourceVersion) : false;

    if (work.lifecycle === "paused") {
      return this.safePausedRoute(work, subscription, event, payloadBytes, now, input);
    }
    if (work.lifecycle !== "active") {
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, state: "rejected", reasonCode: "work-not-active", sourceVersion: event.sourceVersion,
        trust: input.trust ?? "adapter", acceptedAt: now });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "rejected",
        reasonCode: "work-not-active", targetKey };
    }
    if (input.offline && policy === "skip") {
      const eventId = newId("event");
      this.works.repo.insertInbox({ eventId, dedupeKey: this.dedupeKey(subscription, event.sourceEventId),
        source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType, workId: work.workId,
        subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
        ownerEpoch: work.ownerEpoch, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
        payload: { ...payload, skipped: true, offlineGapId: input.offlineGapId }, status: "skipped", mergedCount: 1,
        receivedAt: now, processedAt: now, targetKey, processReason: "offline-skip" });
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, inboxEventId: eventId, state: "skipped", reasonCode: "offline-skip",
        sourceVersion: event.sourceVersion, trust: input.trust ?? "adapter", acceptedAt: now });
      this.setCursor(subscription.subscriptionId, event.source, targetKey, { highestAcceptedVersion: event.sourceVersion,
        highestConsumedVersion: event.sourceVersion });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "skipped",
        reasonCode: "offline-skip", targetKey };
    }
    if (stale) {
      const eventId = newId("event");
      this.works.repo.insertInbox({ eventId, dedupeKey: this.dedupeKey(subscription, event.sourceEventId),
        source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType, workId: work.workId,
        subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
        ownerEpoch: work.ownerEpoch, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
        payload: { ...payload, staleVersion: true }, status: "skipped", mergedCount: 1, receivedAt: now,
        processedAt: now, targetKey, processReason: "stale-source-version" });
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, inboxEventId: eventId, state: "skipped", reasonCode: "stale-source-version",
        sourceVersion: event.sourceVersion, trust: input.trust ?? "adapter", acceptedAt: now });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "skipped",
        reasonCode: "stale-source-version", inboxEventId: eventId, targetKey };
    }

    const canMerge = policy === "latest" && openBatch !== undefined;
    const withinSoftLimit = stats.ready + stats.frozen + stats.blocked < subscription.maxQueueDepth;
    const withinOverflow = this.pendingBytes(subscription.subscriptionId) + payloadBytes <= (subscription.maxBacklogBytes ?? 8 * 1024 * 1024)
      && stats.ready + stats.frozen + stats.blocked < (subscription.maxBacklogEvents ?? subscription.maxQueueDepth * 4);
    if (!canMerge && (!withinSoftLimit || !withinOverflow)) {
      if (!withinOverflow) {
        this.openBackpressure(work, subscription, event, targetKey, stats, now, payloadBytes);
        return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "rejected",
          reasonCode: "capacity-refused", targetKey };
      }
      this.openBackpressure(work, subscription, event, targetKey, stats, now, payloadBytes);
      // Accepted into the finite overflow region as a blocked obligation.
      const eventId = this.insertBlocked(work, subscription, event, payload, targetKey, now, input);
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, inboxEventId: eventId, state: "blocked", reasonCode: "backlog-overflow",
        sourceVersion: event.sourceVersion, trust: input.trust ?? "adapter", acceptedAt: now });
      this.setCursor(subscription.subscriptionId, event.source, targetKey, { highestAcceptedVersion: event.sourceVersion,
        acceptedEvents: 1, acceptedBytes: payloadBytes });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "blocked",
        reasonCode: "backlog-overflow", inboxEventId: eventId, targetKey };
    }

    if (policy === "latest") {
      const authoritative = !this.canCompare(subscription, event.sourceVersion) || event.payload?.authoritativeReadbackRequired === true;
      if (openBatch) {
        const mergedPayload = authoritative
          ? { ...payload, authoritativeReadbackRequired: true, batchEventIds: [...this.batchEventIds(openBatch.eventId), event.sourceEventId] }
          : payload;
        const updated = this.db.prepare(`UPDATE work_events_inbox SET event_type=?,source_version=?,source_event_id=?,
          causal_event_id=?,payload_json=?,merged_count=merged_count+1,target_key=? WHERE event_id=?
          AND frozen_at IS NULL AND status='merged'`).run(event.eventType, event.sourceVersion ?? null,
          event.sourceEventId, event.causalEventId ?? null, JSON.stringify(mergedPayload), targetKey, openBatch.eventId);
        if (updated.changes) {
          this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
            workId: work.workId, targetKey, inboxEventId: openBatch.eventId, state: "merged",
            reasonCode: authoritative ? "authoritative-readback" : "latest-merge", sourceVersion: event.sourceVersion,
            trust: input.trust ?? "adapter", acceptedAt: now });
          this.setCursor(subscription.subscriptionId, event.source, targetKey, { highestAcceptedVersion: event.sourceVersion,
            acceptedEvents: 1, acceptedBytes: payloadBytes });
          return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "merged",
            reasonCode: authoritative ? "authoritative-readback" : "latest-merge", inboxEventId: openBatch.eventId, targetKey };
        }
        // The batch froze between the read and this CAS; fall through to a new batch.
      }
      const eventId = newId("event");
      const deadline = now + subscription.maxMergeWaitMs;
      const inserted = this.works.repo.insertInbox({
        eventId, dedupeKey: this.dedupeKey(subscription, event.sourceEventId), source: event.source,
        sourceEventId: event.sourceEventId, eventType: event.eventType, workId: work.workId,
        subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
        ownerEpoch: work.ownerEpoch, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
        payload: authoritative ? { ...payload, authoritativeReadbackRequired: true } : payload,
        status: "merged", mergedCount: 1, receivedAt: now, processAfter: deadline, batchId:
          `${subscription.subscriptionId}:${targetKey}:${event.sourceEventId}`, batchDeadlineAt: deadline,
        targetKey, processReason: "merge-open",
      });
      if (!inserted) return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "duplicate", targetKey };
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, inboxEventId: eventId, state: "merged",
        reasonCode: authoritative ? "authoritative-readback" : "latest-batch", sourceVersion: event.sourceVersion,
        trust: input.trust ?? "adapter", acceptedAt: now });
      this.setCursor(subscription.subscriptionId, event.source, targetKey, { highestAcceptedVersion: event.sourceVersion,
        acceptedEvents: 1, acceptedBytes: payloadBytes });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "merged",
        reasonCode: authoritative ? "authoritative-readback" : "latest-batch", inboxEventId: eventId, targetKey };
    }

    const eventId = newId("event");
    const inserted = this.works.repo.insertInbox({
      eventId, dedupeKey: this.dedupeKey(subscription, event.sourceEventId), source: event.source,
      sourceEventId: event.sourceEventId, eventType: event.eventType, workId: work.workId,
      subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
      ownerEpoch: work.ownerEpoch, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
      payload, status: "pending", mergedCount: 1, receivedAt: now,
      batchId: `${subscription.subscriptionId}:${targetKey}:each:${event.sourceEventId}`,
      targetKey, processReason: "each-obligation",
    });
    if (!inserted) return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "duplicate", targetKey };
    this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
      workId: work.workId, targetKey, inboxEventId: eventId, state: "accepted", reasonCode: "each-obligation",
      sourceVersion: event.sourceVersion, trust: input.trust ?? "adapter", acceptedAt: now });
    this.setCursor(subscription.subscriptionId, event.source, targetKey, { highestAcceptedVersion: event.sourceVersion,
      acceptedEvents: 1, acceptedBytes: payloadBytes });
    return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "pending",
      reasonCode: "each-obligation", inboxEventId: eventId, targetKey };
  }

  private safePausedRoute(work: WorkDto, subscription: WorkSubscriptionDto, event: WorkIngressAcceptInput,
    payloadBytes: number, now: number, input: WorkIngressAcceptOptions): WorkIngressRouteResult {
    const targetKey = this.targetKeyFor(subscription, event, event.payload ?? {});
    const stats = this.queueStats(subscription);
    const hardEventLimit = subscription.maxBacklogEvents ?? Math.max(16, subscription.maxQueueDepth * 4);
    const hardByteLimit = subscription.maxBacklogBytes ?? 8 * 1024 * 1024;
    if (stats.blocked >= hardEventLimit || this.pendingBytes(subscription.subscriptionId) + payloadBytes > hardByteLimit) {
      this.openBackpressure(work, subscription, event, targetKey, stats, now, payloadBytes);
      this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
        workId: work.workId, targetKey, state: "rejected", reasonCode: "capacity-refused", sourceVersion: event.sourceVersion,
        trust: input.trust ?? "adapter", acceptedAt: now });
      return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: "rejected",
        reasonCode: "capacity-refused", targetKey };
    }
    const route = this.works.pausedBacklog.enqueue(work, subscription, this.toSourceEvent(event, now), now);
    this.upsertRoute({ source: event.source, sourceEventId: event.sourceEventId, subscriptionId: subscription.subscriptionId,
      workId: work.workId, targetKey, state: route === "blocked" ? "blocked" : route === "duplicate" ? "duplicate" : route,
      reasonCode: route === "blocked" ? "backlog-overflow" : undefined, sourceVersion: event.sourceVersion,
      trust: input.trust ?? "adapter", acceptedAt: now });
    return { workId: work.workId, subscriptionId: subscription.subscriptionId, outcome: route, targetKey };
  }

  private toSourceEvent(event: WorkIngressAcceptInput, now: number): WorkSourceEventDto {
    return { source: event.source as WorkSourceEventDto["source"], sourceEventId: event.sourceEventId,
      eventType: event.eventType, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
      timestamp: event.occurredAt ?? now, payload: event.payload ?? {} };
  }

  private insertBlocked(work: WorkDto, subscription: WorkSubscriptionDto, event: WorkIngressAcceptInput,
    payload: Record<string, unknown>, targetKey: string, now: number, input: WorkIngressAcceptOptions): string {
    const eventId = newId("event");
    this.works.repo.insertInbox({ eventId, dedupeKey: this.dedupeKey(subscription, event.sourceEventId),
      source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType, workId: work.workId,
      subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
      ownerEpoch: work.ownerEpoch, sourceVersion: event.sourceVersion, causalEventId: event.causalEventId,
      payload: { ...payload, overflow: true }, status: "blocked", mergedCount: 1, receivedAt: now,
      batchId: `${subscription.subscriptionId}:${targetKey}:overflow:${event.sourceEventId}`, targetKey,
      processReason: "backlog-overflow" });
    return eventId;
  }

  private openBackpressure(work: WorkDto, subscription: WorkSubscriptionDto, event: WorkIngressAcceptInput,
    targetKey: string, stats: WorkQueueStats, now: number, payloadBytes: number): void {
    const blockerId = `backpressure:${subscription.subscriptionId}:${targetKey}`;
    const details = { subscriptionId: subscription.subscriptionId, targetKey, queue: stats.ready + stats.frozen + stats.blocked,
      bytes: stats.bytes + payloadBytes, maxEvents: subscription.maxQueueDepth, maxBytes: subscription.maxBacklogBytes,
      sourceVersion: event.sourceVersion, oldestAt: stats.oldestAt };
    const blocker = this.works.repo.getBlocker(blockerId);
    if (!blocker) this.works.repo.insertBlocker({ blockerId, workId: work.workId, kind: "backpressure",
      reasonCode: "backlog-overflow", reason: `订阅 ${subscription.subscriptionId} 的合法事件超出有限接纳容量`,
      details, sourceRef: `${event.source}:${event.sourceEventId}`, subscriptionId: subscription.subscriptionId,
      waitingForUserInput: false, status: "open", createdAt: now });
    else this.works.repo.reopenBlocker(blockerId, work.workId);
  }

  private dedupeKey(subscription: WorkSubscriptionDto, sourceEventId: string): string {
    return `sub:${subscription.subscriptionId}:src:${sourceEventId}`;
  }

  private targetKeyFor(subscription: WorkSubscriptionDto, event: WorkIngressAcceptInput, payload: Record<string, unknown>): string {
    const adapter = this.adapters.get(subscription.source);
    return adapter?.targetKeyOf({ eventType: event.eventType, payload }) ?? subscription.sourceTarget ?? "default";
  }

  private canCompare(subscription: WorkSubscriptionDto, version: string | undefined): boolean {
    if (version === undefined) return false;
    const mode = this.versionMode(subscription);
    return mode === "monotonic" || mode === "provider-sequence";
  }

  private versionMode(subscription: WorkSubscriptionDto): WorkVersionMode {
    const adapter = this.adapters.get(subscription.source);
    const mode = subscription.versionMode ?? adapter?.versionMode ?? "readback";
    return mode === "none" ? "readback" : mode;
  }

  private compare(subscription: WorkSubscriptionDto, left: string, right: string): number | undefined {
    const adapter = this.adapters.get(subscription.source);
    if (adapter?.compareVersion) {
      const direct = adapter.compareVersion(left, right);
      if (direct !== undefined) return direct;
    }
    const mode = this.versionMode(subscription);
    if (mode !== "monotonic" && mode !== "provider-sequence") return undefined;
    if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) return Number(left) - Number(right);
    if (/^\d{4,}[a-z]?$/i.test(left) && /^\d{4,}[a-z]?$/i.test(right)) {
      const a = Number(left.match(/^\d+/)?.[0]), b = Number(right.match(/^\d+/)?.[0]);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    }
    return undefined;
  }

  private isStale(subscription: WorkSubscriptionDto, targetKey: string, version: string): boolean {
    const cursor = this.cursor(subscription.subscriptionId, subscription.source, targetKey);
    const watermark = cursor?.highestConsumedVersion ?? cursor?.highestFrozenVersion ?? cursor?.highestAcceptedVersion;
    if (!watermark) return false;
    const order = this.compare(subscription, version, watermark);
    return order !== undefined && order <= 0;
  }

  private openLatestBatch(subscriptionId: string, targetKey: string): WorkInboxEventDto | undefined {
    const row = this.db.prepare(`SELECT event_id FROM work_events_inbox WHERE subscription_id=? AND target_key=?
      AND status='merged' AND frozen_at IS NULL ORDER BY received_at ASC,rowid ASC LIMIT 1`).get(subscriptionId, targetKey) as
      { event_id: string } | undefined;
    return row ? this.works.repo.getInbox(row.event_id) : undefined;
  }

  private batchEventIds(eventId: string): string[] {
    const row = this.db.prepare("SELECT payload_json FROM work_events_inbox WHERE event_id=?").get(eventId) as
      { payload_json: string } | undefined;
    if (!row) return [];
    try {
      const payload = JSON.parse(row.payload_json) as { batchEventIds?: unknown };
      return Array.isArray(payload.batchEventIds) ? payload.batchEventIds.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  }

  /** Ready rows in readiness order; `latest` batches appear once, each obligations individually. */
  listReady(workId: string, now = this.now()): WorkInboxEventDto[] {
    this.freezeDueBatches(now, workId);
    const work = this.works.getWork(workId);
    if (!work || work.lifecycle !== "active") return [];
    const rows = this.db.prepare(`SELECT * FROM work_events_inbox WHERE work_id=? AND status IN ('pending','merged')
      AND (status='pending' OR frozen_at IS NOT NULL) ORDER BY received_at ASC,rowid ASC`).all(workId) as Array<Record<string, unknown>>;
    const seenBatches = new Set<string>();
    const ready: WorkInboxEventDto[] = [];
    for (const row of rows) {
      const event = this.works.repo.getInbox(String(row.event_id));
      if (!event) continue;
      if (event.status === "merged" && event.batchId) {
        if (seenBatches.has(event.batchId)) continue;
        seenBatches.add(event.batchId);
      }
      ready.push(event);
    }
    return ready;
  }

  /** Promote finite overflow rows when the active queue has room; one bounded page per call. */
  refillBlocked(subscription: WorkSubscriptionDto, limit = 32): number {
    return this.works.transaction(() => {
      if (!this.authority()) return 0;
      let promoted = 0;
      for (const event of this.works.repo.listInbox(subscription.workId, ["blocked"])) {
        if (promoted >= limit) break;
        if (event.subscriptionId !== subscription.subscriptionId) continue;
        const stats = this.queueStats(subscription);
        if (stats.ready + stats.frozen >= subscription.maxQueueDepth) break;
        this.db.prepare("UPDATE work_events_inbox SET status='pending',payload_json=?,process_reason='backlog-refill' WHERE event_id=? AND status='blocked'")
          .run(JSON.stringify({ ...event.payload, overflow: false }), event.eventId);
        promoted++;
      }
      if (promoted) {
        const work = this.works.getWork(subscription.workId);
        if (work) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: this.now() });
        if (this.queueStats(subscription).blocked === 0) {
          this.works.repo.clearBlocker(`backpressure:${subscription.subscriptionId}:${subscription.sourceTarget ?? "default"}`,
            subscription.workId, this.now());
        }
      }
      return promoted;
    });
  }

  /** Mark an accepted obligation consumed, commit its watermark and route receipt together. */
  markConsumed(eventId: string, consumed: { providerSourceVersion?: string; inputSnapshotId?: string; reason?: string } = {}): void {
    const event = this.works.repo.getInbox(eventId);
    if (!event?.subscriptionId) return;
    const subscription = this.works.repo.getSubscription(event.subscriptionId);
    if (!subscription) return;
    const targetKey = event.targetKey ?? "default";
    this.works.repo.setInboxStatus(eventId, "processed", this.now());
    this.db.prepare("UPDATE work_ingress_routes SET reason_code='processed' WHERE source=? AND source_event_id=? AND subscription_id=?")
      .run(event.source, event.sourceEventId, event.subscriptionId);
    const providerVersion = consumed.providerSourceVersion ?? event.sourceVersion;
    const current = this.cursor(subscription.subscriptionId, event.source, targetKey)?.highestConsumedVersion;
    const regresses = providerVersion !== undefined && current !== undefined
      ? (this.compare(subscription, providerVersion, current) ?? 0) < 0 : false;
    this.setCursor(subscription.subscriptionId, event.source, targetKey, {
      highestConsumedVersion: regresses ? current : providerVersion,
      consumedEvents: 1,
    });
    this.works.repo.updateSubscription({ ...subscription, lastCheckedAt: this.now(), updatedAt: this.now() });
    const blocker = `backpressure:${subscription.subscriptionId}:${targetKey}`;
    if (this.works.repo.getBlocker(blocker)?.status === "open" && this.queueStats(subscription).blocked === 0) {
      this.works.repo.clearBlocker(blocker, event.workId, this.now());
    }
  }

  queueStats(subscription: WorkSubscriptionDto): WorkQueueStats {
    const rows = this.db.prepare(`SELECT status,frozen_at,merge_deadline_at,received_at,payload_json FROM work_events_inbox
      WHERE subscription_id=? AND status IN ('pending','merged','blocked')`).all(subscription.subscriptionId) as Array<{
        status: string; frozen_at: number | null; merge_deadline_at: number | null; received_at: number; payload_json: string }>;
    let ready = 0, frozen = 0, blocked = 0, bytes = 0, oldestAt: number | undefined;
    let mergeDeadlineAt: number | undefined, readySince: number | undefined;
    for (const row of rows) {
      if (row.status === "blocked") blocked++;
      else if (row.frozen_at !== null) frozen++;
      else ready++;
      bytes += Buffer.byteLength(row.payload_json, "utf8");
      if (oldestAt === undefined || row.received_at < oldestAt) oldestAt = row.received_at;
      if (row.status === "merged" && row.frozen_at === null && row.merge_deadline_at !== null
        && (mergeDeadlineAt === undefined || row.merge_deadline_at < mergeDeadlineAt)) mergeDeadlineAt = row.merge_deadline_at;
      if (row.status !== "blocked" && (readySince === undefined || row.received_at < readySince)) readySince = row.received_at;
    }
    return { ready, frozen, blocked, bytes, maxEvents: subscription.maxQueueDepth,
      maxBytes: subscription.maxBacklogBytes ?? 8_388_608, oldestAt, mergeDeadlineAt, readySince,
      waitReason: blocked ? "有限溢出区等待回填" : undefined };
  }

  private pendingBytes(subscriptionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(event.payload_bytes),0) AS bytes FROM work_events_inbox inbox
      LEFT JOIN work_source_events event ON event.source=inbox.source AND event.source_event_id=inbox.source_event_id
      WHERE inbox.subscription_id=? AND inbox.status IN ('pending','merged','blocked')`).get(subscriptionId) as { bytes: number };
    return Number(row.bytes);
  }

  cursor(subscriptionId: string, source: string, targetKey: string): WorkSubscriptionCursor | undefined {
    const row = this.db.prepare("SELECT * FROM work_subscription_cursors WHERE subscription_id=? AND source=? AND target_key=?")
      .get(subscriptionId, source, targetKey) as Record<string, unknown> | undefined;
    return row ? {
      subscriptionId, source, targetKey: String(row.target_key),
      highestAcceptedVersion: row.highest_accepted_version as string | undefined ?? undefined,
      highestConsumedVersion: row.highest_consumed_version as string | undefined ?? undefined,
      highestFrozenVersion: row.highest_frozen_version as string | undefined ?? undefined,
      replayCursor: row.replay_cursor as string | undefined ?? undefined,
      enumerationWatermark: row.enumeration_watermark as string | undefined ?? undefined,
      acceptedEvents: Number(row.accepted_events), consumedEvents: Number(row.consumed_events),
      acceptedBytes: Number(row.accepted_bytes),
    } : undefined;
  }

  listCursors(subscriptionId: string): WorkSubscriptionCursor[] {
    return (this.db.prepare("SELECT source,target_key FROM work_subscription_cursors WHERE subscription_id=? ORDER BY source,target_key")
      .all(subscriptionId) as Array<{ source: string; target_key: string }>)
      .map(row => this.cursor(subscriptionId, row.source, row.target_key)!);
  }

  setCursor(subscriptionId: string, source: string, targetKey: string, update: Partial<Pick<WorkSubscriptionCursor,
    "highestAcceptedVersion" | "highestConsumedVersion" | "highestFrozenVersion" | "replayCursor" | "enumerationWatermark">> & {
    acceptedEvents?: number; consumedEvents?: number; acceptedBytes?: number;
  }): void {
    const current = this.cursor(subscriptionId, source, targetKey);
    const next = {
      accepted: update.highestAcceptedVersion ?? current?.highestAcceptedVersion,
      consumed: update.highestConsumedVersion ?? current?.highestConsumedVersion,
      frozen: update.highestFrozenVersion ?? current?.highestFrozenVersion,
      replay: update.replayCursor ?? current?.replayCursor,
      enumeration: update.enumerationWatermark ?? current?.enumerationWatermark,
      acceptedEvents: (current?.acceptedEvents ?? 0) + (update.acceptedEvents ?? 0),
      consumedEvents: (current?.consumedEvents ?? 0) + (update.consumedEvents ?? 0),
      acceptedBytes: (current?.acceptedBytes ?? 0) + (update.acceptedBytes ?? 0),
    };
    this.db.prepare(`INSERT INTO work_subscription_cursors
      (subscription_id,source,target_key,highest_accepted_version,highest_consumed_version,highest_frozen_version,
       replay_cursor,enumeration_watermark,accepted_events,consumed_events,accepted_bytes,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(subscription_id,source,target_key) DO UPDATE SET
        highest_accepted_version=excluded.highest_accepted_version,
        highest_consumed_version=excluded.highest_consumed_version,
        highest_frozen_version=excluded.highest_frozen_version,
        replay_cursor=excluded.replay_cursor,enumeration_watermark=excluded.enumeration_watermark,
        accepted_events=excluded.accepted_events,consumed_events=excluded.consumed_events,
        accepted_bytes=excluded.accepted_bytes,updated_at=excluded.updated_at`)
      .run(subscriptionId, source, targetKey, next.accepted ?? null, next.consumed ?? null, next.frozen ?? null,
        next.replay ?? null, next.enumeration ?? null, next.acceptedEvents, next.consumedEvents, next.acceptedBytes, this.now());
  }

  getRoute(source: string, sourceEventId: string, subscriptionId: string): {
    state: IngressRouteOutcome; reason_code: string | null; inbox_event_id: string | null } | undefined {
    return this.db.prepare("SELECT state,reason_code,inbox_event_id FROM work_ingress_routes WHERE source=? AND source_event_id=? AND subscription_id=?")
      .get(source, sourceEventId, subscriptionId) as { state: IngressRouteOutcome; reason_code: string | null; inbox_event_id: string | null } | undefined;
  }

  routesForEvent(source: string, sourceEventId: string): Array<{ subscriptionId: string; state: IngressRouteOutcome; inboxEventId?: string }> {
    return (this.db.prepare("SELECT subscription_id,state,inbox_event_id FROM work_ingress_routes WHERE source=? AND source_event_id=?")
      .all(source, sourceEventId) as Array<{ subscription_id: string; state: IngressRouteOutcome; inbox_event_id: string | null }>)
      .map(row => ({ subscriptionId: row.subscription_id, state: row.state, inboxEventId: row.inbox_event_id ?? undefined }));
  }

  private upsertRoute(input: { source: string; sourceEventId: string; subscriptionId: string; workId: string;
    targetKey: string; inboxEventId?: string; state: IngressRouteOutcome; reasonCode?: string; sourceVersion?: string;
    trust: "adapter" | "host" | "system"; acceptedAt: number }): void {
    this.db.prepare(`INSERT INTO work_ingress_routes
      (source,source_event_id,subscription_id,work_id,target_key,inbox_event_id,state,reason_code,source_version,trust,accepted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source,source_event_id,subscription_id) DO UPDATE SET
        work_id=excluded.work_id,target_key=excluded.target_key,inbox_event_id=COALESCE(excluded.inbox_event_id,work_ingress_routes.inbox_event_id),
        state=excluded.state,reason_code=excluded.reason_code,source_version=excluded.source_version,
        trust=excluded.trust,accepted_at=excluded.accepted_at`)
      .run(input.source, input.sourceEventId, input.subscriptionId, input.workId, input.targetKey,
        input.inboxEventId ?? null, input.state, input.reasonCode ?? null, input.sourceVersion ?? null,
        input.trust, input.acceptedAt);
  }

  /** Stable content identity for diagnostics and causal fingerprints. */
  payloadDigest(payload: unknown): string {
    return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  }
}
