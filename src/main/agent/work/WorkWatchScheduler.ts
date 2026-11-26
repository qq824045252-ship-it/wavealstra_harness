import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import type { WorkOfflineGapDto, WorkWatchHostStateDto } from "../../../shared/bot-work-phase4";
import { Cron } from "croner";
import { newId } from "./WorkRepository";
import { cronNextWake } from "./WorkSchedule";
import type { WorkService } from "./WorkService";
import {
  enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites,
} from "./WorkDomainRuntime";

export interface WorkTickResult {
  subscriptionId: string;
  workId: string;
  scheduledAt: number;
  fired: Array<{ subscriptionId: string; workId: string; scheduledAt: number }>;
}

export interface HostLeaseSnapshot {
  authorityId?: string;
  heartbeatAt?: number;
  releasedAt?: number;
  acquiredAt?: number;
}

export interface WorkOfflineGapInput {
  hostSessionId: string;
  subscriptionId?: string;
  workId?: string;
  from: number;
  to: number;
  detectedBy: string;
  confidence: "evidence" | "inferred";
  policy: "latest" | "each" | "skip";
  policyRevision: number;
  sourceCursor?: string;
  queryable: boolean;
  gapReason?: string;
}

/**
 * The only scheduler. It produces business events inside the authoritative host lease and
 * never starts Durable execution itself. Every logical slot has a database identity, and
 * offline gaps are persisted facts rather than "the app was probably running" claims.
 */
export class WorkWatchScheduler {
  private expiryReviewDelivered: (workId: string) => boolean = () => false;
  setExpiryReviewGate(delivered: (workId: string) => boolean): void { this.expiryReviewDelivered = delivered; }
  private timer?: ReturnType<typeof setInterval>;
  private intervalMs = 5_000;
  private sessionId = newId("host-session");
  private lastMonotonic?: { at: number; value: number };

  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly options: { now?: () => number; isAuthority?: () => boolean; monotonicMs?: () => number } = {}) {}

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }
  private monotonic(): number { return this.options.monotonicMs ? this.options.monotonicMs() : Date.now(); }
  private authority(): boolean { return !this.options.isAuthority || this.options.isAuthority(); }

  getSessionId(): string { return this.sessionId; }

  /** Register the scheduler on the real host lifecycle; supervised Core owns scheduling. */
  start(intervalMs = 5_000): void {
    if (requiresWorkRustWrites(this.db)) {
      throw new Error("Rust Core owns Work scheduling; Main cannot start WorkWatchScheduler");
    }
    if (this.timer) return;
    this.intervalMs = Math.max(500, intervalMs);
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { console.warn("[Work] 调度 tick 失败", error); }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Must run before the lease heartbeat is overwritten: the old watermark is the offline evidence. */
  beginHostSession(previous: HostLeaseSnapshot | undefined, now = this.now()): WorkOfflineGapDto[] {
    return this.works.transaction(() => {
      if (!this.authority()) return [];
      const authorityId = this.db.prepare("SELECT authority_id,heartbeat_at,acquired_at,released_at FROM work_host_lease WHERE lease_id='singleton'")
        .get() as { authority_id: string; heartbeat_at: number; acquired_at: number; released_at: number | null } | undefined;
      const old = previous ?? (authorityId ? { authorityId: authorityId.authority_id,
        heartbeatAt: authorityId.heartbeat_at, acquiredAt: authorityId.acquired_at,
        releasedAt: authorityId.released_at ?? undefined } : undefined);
      const state = this.hostStateRow();
      const from = old?.releasedAt ?? old?.heartbeatAt ?? state?.last_scan_at ?? undefined;
      const hostSessionId = state?.session_id && state.last_scan_at === from ? state.session_id : this.sessionId;
      this.sessionId = hostSessionId;
      const gaps: WorkOfflineGapDto[] = [];
      if (from !== undefined && now - from > 1_000) {
        const evidence = old?.releasedAt !== undefined ? "host-stop" : old?.heartbeatAt !== undefined ? "heartbeat-stale" : "scan-gap";
        for (const subscription of this.works.repo.listActiveSubscriptions()) {
          const work = this.works.getWork(subscription.workId);
          if (!work || work.lifecycle === "closed") continue;
          const adapter = this.works.ingress.adapter(subscription.source);
          const gap = this.recordGap({
            hostSessionId, subscriptionId: subscription.subscriptionId, workId: subscription.workId,
            from, to: now, detectedBy: evidence, confidence: evidence === "heartbeat-stale" ? "inferred" : "evidence",
            policy: subscription.catchUpPolicy, policyRevision: subscription.scheduleRevision ?? 1,
            sourceCursor: this.works.ingress.cursor(subscription.subscriptionId, subscription.source,
              subscription.sourceTarget ?? adapter?.targetKeyOf({ eventType: "", payload: {} }) ?? "default")?.highestConsumedVersion,
            queryable: adapter?.canQueryHistory === true,
          });
          if (gap) gaps.push(gap);
        }
        if (!gaps.length) {
          const gap = this.recordGap({ hostSessionId, from, to: now, detectedBy: evidence,
            confidence: evidence === "heartbeat-stale" ? "inferred" : "evidence", policy: "skip",
            policyRevision: 1, queryable: false, gapReason: "宿主离线区间没有活跃订阅" });
          if (gap) gaps.push(gap);
        }
      }
      this.upsertHostState({ sessionId: hostSessionId, now, stopped: false });
      return gaps;
    });
  }

  /** System suspend/resume is host lifecycle evidence, not a guess from a client heartbeat. */
  suspend(at = this.now()): void {
    this.works.transaction(() => {
      this.upsertHostState({ sessionId: this.sessionId, now: at, suspendEvidence: `suspend:${at}` });
    });
  }

  resume(at = this.now()): WorkOfflineGapDto[] {
    return this.works.transaction(() => {
      const state = this.hostStateRow();
      const from = state?.last_scan_at ?? state?.active_since ?? at;
      if (at <= from) return this.gapsForHostSession(this.sessionId, at);
      const gaps: WorkOfflineGapDto[] = [];
      for (const subscription of this.works.repo.listActiveSubscriptions()) {
        const adapter = this.works.ingress.adapter(subscription.source);
        const gap = this.recordGap({ hostSessionId: this.sessionId, subscriptionId: subscription.subscriptionId,
          workId: subscription.workId, from, to: at, detectedBy: "system-resume", confidence: "evidence",
          policy: subscription.catchUpPolicy, policyRevision: subscription.scheduleRevision ?? 1,
          queryable: adapter?.canQueryHistory === true });
        if (gap) gaps.push(gap);
      }
      this.upsertHostState({ sessionId: this.sessionId, now: at, suspendEvidence: undefined });
      return gaps;
    });
  }

  private updateGap(gapId: string, cur: Record<string, unknown>, fields: {
    queryable: number;
    state: string;
    recoveredCountDelta?: number;
    mergedCountDelta?: number;
    skippedCount?: number | null;
    unknownCount?: number | null;
    continuationCursor?: string | null;
    gapReason?: string | null;
    updatedAt: number;
  }): void {
    const recoveredDelta = fields.recoveredCountDelta ?? 0;
    const mergedDelta = fields.mergedCountDelta ?? 0;
    const nextSkipped = fields.skippedCount ?? null;
    const nextUnknown = fields.unknownCount ?? null;
    const nextCursor = fields.continuationCursor ?? null;
    const nextReason = fields.gapReason ?? null;
    overlaySet(this.db, "work_offline_gaps", gapId, {
      ...cur,
      queryable: fields.queryable,
      state: fields.state,
      recovered_count: Number(cur.recovered_count ?? 0) + recoveredDelta,
      merged_count: Number(cur.merged_count ?? 0) + mergedDelta,
      skipped_count: nextSkipped,
      unknown_count: nextUnknown,
      continuation_cursor: nextCursor,
      gap_reason: nextReason,
      updated_at: fields.updatedAt,
    });
    enqueueWorkOp(this.db, {
      op: "workOfflineGapWrite",
      mode: "update",
      gapId,
      hostSessionId: null,
      subscriptionId: null,
      workId: null,
      offlineGapFrom: null,
      offlineGapTo: null,
      detectedBy: null,
      confidence: null,
      policy: null,
      policyRevision: null,
      sourceCursor: null,
      queryable: fields.queryable,
      recoveredCountDelta: recoveredDelta,
      mergedCountDelta: mergedDelta,
      skippedCount: nextSkipped,
      unknownCount: nextUnknown,
      state: fields.state,
      continuationCursor: nextCursor,
      gapReason: nextReason,
      nextWakeAt: null,
      now: fields.updatedAt,
    });
  }

  /** Apply the saved policy for an observed gap; repeated resume notifications reuse the same gap. */
  applyGap(gapId: string, options: { queryable?: boolean; unknownCount?: number; skippedCount?: number;
    events?: Array<{ sourceEventId: string; eventType: string; sourceVersion?: string; payload?: Record<string, unknown>; occurredAt?: number }> } = {}): WorkOfflineGapDto | undefined {
    return this.works.transaction(() => {
      const row = this.gapRow(gapId);
      if (!row || !row.subscription_id) return undefined;
      if (!this.authority() || row.state === "recovered") return this.toGapDto(row);
      const subscription = this.works.repo.getSubscription(String(row.subscription_id));
      if (!subscription) return undefined;
      const rust = requiresWorkRustWrites(this.db);
      // A cron gap is recoverable from the persisted schedule, not from an external
      // business-history query. Do not enqueue a second generic latest readback.
      if (subscription.source === "cron") {
        const now = this.now();
        const reason = "等待持久调度游标恢复；不代表业务来源历史已回查";
        if (rust) {
          this.updateGap(gapId, row, {
            queryable: 1, state: "recovering",
            skippedCount: (row.skipped_count as number | null | undefined) ?? null,
            unknownCount: (row.unknown_count as number | null | undefined) ?? null,
            continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
            gapReason: reason, updatedAt: now,
          });
        } else {
          this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovering',
            gap_reason='等待持久调度游标恢复；不代表业务来源历史已回查',updated_at=? WHERE gap_id=?`)
            .run(now, gapId);
        }
        this.settleScheduleGaps(subscription);
        return this.toGapDto(this.gapRow(gapId)!);
      }
      const queryable = options.queryable ?? (this.works.ingress.adapter(subscription.source)?.canQueryHistory === true);
      const policy = subscription.catchUpPolicy;
      if (!queryable) {
        const now = this.now();
        if (rust) {
          this.updateGap(gapId, row, {
            queryable: 0, state: "unqueryable",
            skippedCount: (row.skipped_count as number | null | undefined) ?? null,
            unknownCount: options.unknownCount ?? null,
            continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
            gapReason: (row.gap_reason as string | null | undefined) ?? null,
            updatedAt: now,
          });
        } else {
          this.db.prepare("UPDATE work_offline_gaps SET queryable=0,state='unqueryable',unknown_count=?,updated_at=? WHERE gap_id=?")
            .run(options.unknownCount ?? null, now, gapId);
        }
        this.gapBlocker(row.work_id ? String(row.work_id) : undefined, gapId, "unqueryable-offline-gap",
          "来源没有历史回查能力，离线区间内的触发与业务变化无法补查", subscription.subscriptionId);
        return this.toGapDto(this.gapRow(gapId)!);
      }
      if (policy === "skip") {
        const now = this.now();
        if (rust) {
          this.updateGap(gapId, row, {
            queryable: 1, state: "recovered",
            skippedCount: options.skippedCount ?? null,
            unknownCount: (row.unknown_count as number | null | undefined) ?? null,
            continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
            gapReason: (row.gap_reason as string | null | undefined) ?? null,
            updatedAt: now,
          });
        } else {
          this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',skipped_count=?,updated_at=? WHERE gap_id=?")
            .run(options.skippedCount ?? null, now, gapId);
        }
      } else if (policy === "latest") {
        // One authoritative readback, merged into a single follow-up, never the last arrival payload.
        const work = this.works.getWork(String(row.work_id));
        if (work && work.lifecycle === "active") {
          const eventId = newId("event");
          const inserted = this.works.repo.insertInbox({ eventId,
            dedupeKey: `gap-latest:${gapId}:${subscription.subscriptionId}`, source: subscription.source,
            sourceEventId: gapId, eventType: "work.offline_catchup", workId: work.workId,
            subscriptionId: subscription.subscriptionId, intentRevision: work.intentRevision, stateVersion: work.stateVersion,
            ownerEpoch: work.ownerEpoch, payload: { authoritativeReadbackRequired: true, offlineGapId: gapId,
              offlineGapFrom: row.offline_gap_from, offlineGapTo: row.offline_gap_to }, status: "merged",
            mergedCount: 1, receivedAt: this.now(), processAfter: this.now() + subscription.maxMergeWaitMs,
            batchId: `gap:${gapId}:${subscription.subscriptionId}`, batchDeadlineAt: this.now() + subscription.maxMergeWaitMs,
            targetKey: subscription.sourceTarget, processReason: "offline-latest" });
          const now = this.now();
          if (rust) {
            this.updateGap(gapId, row, {
              queryable: 1, state: "recovered", mergedCountDelta: inserted ? 1 : 0,
              skippedCount: (row.skipped_count as number | null | undefined) ?? null,
              unknownCount: (row.unknown_count as number | null | undefined) ?? null,
              continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
              gapReason: (row.gap_reason as string | null | undefined) ?? null,
              updatedAt: now,
            });
          } else {
            this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',merged_count=merged_count+?,updated_at=? WHERE gap_id=?")
              .run(inserted ? 1 : 0, now, gapId);
          }
        } else {
          const now = this.now();
          if (rust) {
            this.updateGap(gapId, row, {
              queryable: 1, state: "recovered",
              skippedCount: (row.skipped_count as number | null | undefined) ?? null,
              unknownCount: (row.unknown_count as number | null | undefined) ?? null,
              continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
              gapReason: (row.gap_reason as string | null | undefined) ?? null,
              updatedAt: now,
            });
          } else {
            this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',updated_at=? WHERE gap_id=?").run(now, gapId);
          }
        }
      } else {
        // Capability metadata is not a completed history query. Host resume calls this
        // before an adapter has supplied a page; keep that gap visibly unresolved.
        if (options.events === undefined) {
          const now = this.now();
          const reason = "等待来源历史回查结果";
          if (rust) {
            this.updateGap(gapId, row, {
              queryable: 1, state: "recovering",
              skippedCount: (row.skipped_count as number | null | undefined) ?? null,
              unknownCount: (row.unknown_count as number | null | undefined) ?? null,
              continuationCursor: (row.continuation_cursor as string | null | undefined) ?? null,
              gapReason: reason, updatedAt: now,
            });
          } else {
            this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovering',
              gap_reason='等待来源历史回查结果',updated_at=? WHERE gap_id=?`).run(now, gapId);
          }
          return this.toGapDto(this.gapRow(gapId)!);
        }
        const page = options.events.slice(0, 32);
        let ingested = 0;
        let skipped = 0;
        let cursor = row.continuation_cursor as string | null;
        let refused = false;
        // A retry may include the already-committed prefix of the same ordered page.
        const committedPrefix = page.findIndex(item => item.sourceEventId === cursor);
        for (const item of page.slice(committedPrefix + 1)) {
          const accepted = this.works.ingress.accept({ source: subscription.source, sourceEventId: item.sourceEventId,
            eventType: item.eventType, sourceVersion: item.sourceVersion, occurredAt: item.occurredAt,
            payload: item.payload ?? {}, trustedOrigin: "offline-replay" },
          { workId: subscription.workId, subscriptionId: subscription.subscriptionId, offline: true,
            offlineGapId: gapId, trust: "host" });
          const route = accepted.outcomes.find(item => item.subscriptionId === subscription.subscriptionId);
          if (!accepted.acknowledged || !route || route.outcome === "rejected") {
            refused = true;
            break;
          }
          if (route.outcome === "skipped") skipped++;
          else if (route.outcome !== "duplicate") ingested++;
          cursor = item.sourceEventId;
        }
        const now = this.now();
        const nextState = page.length ? "recovering" : "recovered";
        const gapReason = refused ? "来源回放受背压阻碍，保留游标等待重试" : null;
        if (rust) {
          const nextSkipped = Number(row.skipped_count ?? 0) + skipped + (options.skippedCount ?? 0);
          this.updateGap(gapId, row, {
            queryable: 1, state: nextState, recoveredCountDelta: ingested,
            skippedCount: nextSkipped,
            unknownCount: (row.unknown_count as number | null | undefined) ?? null,
            continuationCursor: cursor ?? null, gapReason, updatedAt: now,
          });
        } else {
          this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state=?,recovered_count=recovered_count+?,
            skipped_count=COALESCE(skipped_count,0)+?,continuation_cursor=?,gap_reason=?,updated_at=? WHERE gap_id=?`)
            .run(nextState, ingested, skipped + (options.skippedCount ?? 0),
              cursor, gapReason, now, gapId);
        }
      }
      return this.toGapDto(this.gapRow(gapId)!);
    });
  }

  /** One bounded scheduling pass; produces at most one durable tick per logical slot. */
  tick(now = this.now()): WorkTickResult[] {
    const wallJumped = this.detectClockJump(now);
    return this.works.transaction(() => {
      if (!this.authority()) return [];
      this.upsertHostState({ sessionId: this.sessionId, now });
      const results: WorkTickResult[] = [];
      const rust = requiresWorkRustWrites(this.db);
      const expiringWorkIds: string[] = rust
        ? overlayFindAll(
            this.db,
            "works",
            this.db.prepare("SELECT * FROM works WHERE mode='watch' AND lifecycle IN ('active','paused','closing')").all() as Array<Record<string, unknown>>,
            r => String(r.work_id),
            r => {
              if (r.mode !== "watch" || !["active", "paused", "closing"].includes(String(r.lifecycle))) return false;
              if (!r.watch_rule_json) return false;
              try {
                const rule = JSON.parse(String(r.watch_rule_json)) as { endsAt?: unknown; termination?: { reason?: unknown } };
                return (typeof rule.endsAt === "number" && rule.endsAt <= now) || rule.termination?.reason === "schedule_expired";
              } catch { return false; }
            },
          ).map(r => String(r.work_id))
        : (this.db.prepare(`SELECT work_id FROM works WHERE mode='watch' AND lifecycle IN ('active','paused','closing')
            AND ((json_type(watch_rule_json,'$.endsAt') IN ('integer','real') AND json_extract(watch_rule_json,'$.endsAt')<=?)
              OR json_extract(watch_rule_json,'$.termination.reason')='schedule_expired')`).all(now) as Array<{ work_id: string }>).map(r => r.work_id);
      for (const workId of expiringWorkIds)
        this.works.expireWatchTime(workId, now, this.expiryReviewDelivered(workId));
      const authId = this.authorityId();
      const after = rust
        ? (() => {
            const dbStates = this.db.prepare("SELECT rowid,* FROM work_watch_host_state WHERE last_scan_cursor IS NOT NULL").all() as Array<Record<string, unknown>>;
            const rows = overlayFindAll(
              this.db, "work_watch_host_state", dbStates, r => String(r.authority_id),
              r => r.last_scan_cursor !== null && r.last_scan_cursor !== undefined,
              (a, b) => (a.authority_id === authId ? 0 : 1) - (b.authority_id === authId ? 0 : 1) || Number(b.rowid ?? 0) - Number(a.rowid ?? 0),
            );
            return (rows[0]?.last_scan_cursor as string | null | undefined) ?? "";
          })()
        : ((this.db.prepare(`SELECT last_scan_cursor FROM work_watch_host_state
            WHERE last_scan_cursor IS NOT NULL ORDER BY (authority_id=?) DESC,rowid DESC LIMIT 1`)
            .get(authId) as { last_scan_cursor: string | null } | undefined)?.last_scan_cursor ?? "");
      const due = (comparison: ">" | "<=", limit: number): Array<{ subscription_id: string }> => {
        if (rust) {
          const allDue = overlayFindAll(
            this.db,
            "work_subscriptions",
            this.db.prepare(`SELECT subscription.* FROM work_subscriptions subscription
              JOIN works work ON work.work_id=subscription.work_id
              WHERE subscription.stopped_at IS NULL AND work.lifecycle='active' AND subscription.next_wake_at<=?`)
              .all(now) as Array<Record<string, unknown>>,
            r => String(r.subscription_id),
            r => (r.stopped_at === null || r.stopped_at === undefined)
              && r.next_wake_at !== null && r.next_wake_at !== undefined && Number(r.next_wake_at) <= now
              && this.works.getWork(String(r.work_id))?.lifecycle === "active",
            (a, b) => String(a.subscription_id) < String(b.subscription_id) ? -1 : String(a.subscription_id) > String(b.subscription_id) ? 1 : 0,
          );
          return allDue
            .filter(r => comparison === ">" ? String(r.subscription_id) > after : String(r.subscription_id) <= after)
            .slice(0, limit)
            .map(r => ({ subscription_id: String(r.subscription_id) }));
        }
        return this.db.prepare(`SELECT subscription.subscription_id
          FROM work_subscriptions subscription JOIN works work ON work.work_id=subscription.work_id
          WHERE subscription.stopped_at IS NULL AND work.lifecycle='active' AND subscription.next_wake_at<=?
            AND subscription.subscription_id ${comparison} ? ORDER BY subscription.subscription_id LIMIT ?`)
          .all(now, after, limit) as Array<{ subscription_id: string }>;
      };
      // A capacity-blocked each subscription must not starve the rest of the
      // user's watches. Persist a bounded round-robin cursor across restarts.
      const rows = due(">", 128);
      if (rows.length < 128) rows.push(...due("<=", 128 - rows.length));
      for (const row of rows) {
        const subscription = this.works.repo.getSubscription(row.subscription_id)!;
        const work = this.works.getWork(subscription.workId);
        if (!work || work.lifecycle !== "active") continue;
        const fired = this.tickSubscription(work, subscription, now, wallJumped);
        this.settleScheduleGaps(this.works.repo.getSubscription(subscription.subscriptionId)!);
        results.push({ subscriptionId: subscription.subscriptionId, workId: work.workId,
          scheduledAt: subscription.nextWakeAt ?? now, fired });
      }
      if (rows.length) {
        const nextCursor = rows.at(-1)!.subscription_id;
        if (rust) {
          overlayMutate(this.db, "work_watch_host_state", authId,
            () => this.db.prepare("SELECT * FROM work_watch_host_state WHERE authority_id=?").get(authId) as Record<string, unknown> | undefined,
            cur => cur ? { ...cur, last_scan_cursor: nextCursor } : undefined);
          enqueueWorkOp(this.db, {
            op: "workWatchHostStateWrite", mode: "updateCursor", authorityId: authId,
            sessionId: null, lastScanAt: null, lastScanCursor: nextCursor,
            activeSince: null, lastSeenAt: null, suspendEvidence: null, stoppedAt: null, updatedAt: now,
          });
        } else {
          this.db.prepare("UPDATE work_watch_host_state SET last_scan_cursor=? WHERE authority_id=?")
            .run(nextCursor, authId);
        }
      }
      this.expireDeadlines(now);
      return results;
    });
  }

  private tickSubscription(work: WorkDto, subscription: WorkSubscriptionDto, now: number, wallJumped: boolean): WorkTickResult["fired"] {
    const fired: WorkTickResult["fired"] = [];
    if (!subscription.cronExpression && subscription.nextWakeAt === undefined) return fired;
    const revision = subscription.scheduleRevision ?? 1;
    const timezone = subscription.timezone;
    const scheduledAt = subscription.nextWakeAt;
    if (scheduledAt === undefined || scheduledAt > now) return fired;
    let cursor = scheduledAt;
    let guard = 0;
    const rust = requiresWorkRustWrites(this.db);
    // A wall-clock rollback never replays a persisted slot; the high-water mark wins.
    const highWater = this.highestTickAt(subscription.subscriptionId, revision);
    if (wallJumped && highWater !== undefined && now < highWater) return fired;
    // Coalesce an arbitrarily long gap without enumerating every missed minute.
    // nextSlot is monotone: binary search its last starting instant whose successor
    // is due. This is bounded by the timestamp width, not the offline duration.
    if (subscription.cronExpression && subscription.catchUpPolicy !== "each") {
      cursor = this.latestDueSlot(subscription, cursor, now);
    }
    if (subscription.catchUpPolicy === "skip" && cursor < now - this.intervalMs) {
      this.works.repo.updateSubscription({ ...subscription,
        nextWakeAt: this.nextSlot(subscription, now), updatedAt: this.now() });
      return fired;
    }
    if (subscription.catchUpPolicy === "latest") {
      // Replace only unclaimed checks. A frozen batch or an admitted execution owns
      // its snapshot even if it has not yet changed the Inbox status.
      if (rust) {
        const dbBound = this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=?").all(work.workId) as Array<Record<string, unknown>>;
        const boundInboxIds = new Set(
          overlayFindAll(this.db, "work_execution_bindings", dbBound, r => String(r.binding_id),
            r => r.inbox_event_id !== null && r.inbox_event_id !== undefined)
            .map(r => String(r.inbox_event_id)),
        );
        const dbTicks = this.db.prepare("SELECT * FROM work_schedule_ticks WHERE subscription_id=? AND schedule_revision=? AND planned_at<?")
          .all(subscription.subscriptionId, revision, cursor) as Array<Record<string, unknown>>;
        const candidateTicks = overlayFindAll(
          this.db, "work_schedule_ticks", dbTicks, r => String(r.tick_id),
          r => r.subscription_id === subscription.subscriptionId && Number(r.schedule_revision) === revision
            && Number(r.planned_at) < cursor && r.inbox_event_id !== null && r.inbox_event_id !== undefined,
        );
        const staleEventIds = new Set<string>();
        for (const tick of candidateTicks) {
          const eid = String(tick.inbox_event_id);
          if (boundInboxIds.has(eid)) continue;
          const inboxRow = overlayReadOne<Record<string, unknown>>(this.db, "work_events_inbox", eid,
            () => this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eid) as Record<string, unknown> | undefined);
          if (inboxRow && inboxRow.subscription_id === subscription.subscriptionId
            && inboxRow.event_type === "work.tick" && inboxRow.status === "pending"
            && (inboxRow.frozen_at === null || inboxRow.frozen_at === undefined)) {
            staleEventIds.add(eid);
          }
        }
        const allSubTicks = overlayFindAll(
          this.db, "work_schedule_ticks",
          this.db.prepare("SELECT * FROM work_schedule_ticks WHERE subscription_id=?").all(subscription.subscriptionId) as Array<Record<string, unknown>>,
          r => String(r.tick_id), r => r.subscription_id === subscription.subscriptionId,
        );
        for (const eventId of staleEventIds) {
          overlayMutate(this.db, "work_events_inbox", eventId,
            () => this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
            cur => cur ? { ...cur, status: "skipped", processed_at: now, process_reason: "schedule-latest-coalesced" } : undefined);
          enqueueWorkOp(this.db, {
            op: "workInboxUpdate", mode: "coalesceTick", eventId, subscriptionId: null, workId: null,
            eventType: null, sourceVersion: null, causalEventId: null, payloadJson: null, status: null,
            mergeDeadlineAt: null, mergedCount: null, targetKey: null, batchId: null, batchDeadlineAt: null, now,
          });
          for (const t of allSubTicks) {
            if (t.inbox_event_id === eventId) {
              overlaySet(this.db, "work_schedule_ticks", String(t.tick_id), { ...t, status: "skipped" });
            }
          }
          enqueueWorkOp(this.db, {
            op: "workScheduleTickWrite", mode: "skipByInbox", tickId: null, subscriptionId: null, workId: null,
            scheduleRevision: null, logicalSlotKey: null, plannedAt: null, effectiveAt: null, status: null,
            inboxEventId: eventId, mergedFromSlotKeysJson: null, createdAt: null,
          });
        }
      } else {
        const stale = this.db.prepare(`SELECT inbox.event_id FROM work_events_inbox inbox
          JOIN work_schedule_ticks tick ON tick.inbox_event_id=inbox.event_id
          WHERE inbox.subscription_id=? AND inbox.event_type='work.tick'
            AND inbox.status='pending' AND inbox.frozen_at IS NULL
            AND tick.schedule_revision=? AND tick.planned_at<?
            AND NOT EXISTS (SELECT 1 FROM work_execution_bindings binding WHERE binding.inbox_event_id=inbox.event_id)`)
          .all(subscription.subscriptionId, revision, cursor) as Array<{ event_id: string }>;
        for (const event of stale) {
          this.db.prepare("UPDATE work_events_inbox SET status='skipped',processed_at=?,process_reason='schedule-latest-coalesced' WHERE event_id=?")
            .run(now, event.event_id);
          this.db.prepare("UPDATE work_schedule_ticks SET status='skipped' WHERE inbox_event_id=?").run(event.event_id);
        }
      }
    }
    const depthCount = rust
      ? overlayFindAll(
          this.db,
          "work_events_inbox",
          this.db.prepare("SELECT * FROM work_events_inbox WHERE subscription_id=? AND status IN ('pending','merged','blocked')")
            .all(subscription.subscriptionId) as Array<Record<string, unknown>>,
          r => String(r.event_id),
          r => r.subscription_id === subscription.subscriptionId && ["pending", "merged", "blocked"].includes(String(r.status)),
        ).length
      : (this.db.prepare(`SELECT COUNT(*) AS count FROM work_events_inbox
          WHERE subscription_id=? AND status IN ('pending','merged','blocked')`)
          .get(subscription.subscriptionId) as { count: number }).count;
    let available = Math.max(0, subscription.maxQueueDepth - depthCount);
    if (!available) return fired;
    while (cursor <= now && guard++ < 64) {
      // Keep the persisted continuation intact until capacity becomes available.
      if (available <= 0) break;
      const slot = this.logicalSlot(cursor, subscription.cronExpression, timezone);
      const effectiveAt = cursor;
      const mergedInto = rust
        ? overlayFindAll(
            this.db,
            "work_schedule_ticks",
            this.db.prepare("SELECT * FROM work_schedule_ticks WHERE subscription_id=? AND schedule_revision=? AND effective_at=? AND status='dispatched'")
              .all(subscription.subscriptionId, revision, effectiveAt) as Array<Record<string, unknown>>,
            r => String(r.tick_id),
            r => r.subscription_id === subscription.subscriptionId && Number(r.schedule_revision) === revision
              && Number(r.effective_at) === effectiveAt && r.status === "dispatched",
          )[0] as { tick_id: string; inbox_event_id: string | null; merged_from_slot_keys_json: string } | undefined
        : this.db.prepare(`SELECT tick_id,inbox_event_id,merged_from_slot_keys_json FROM work_schedule_ticks
            WHERE subscription_id=? AND schedule_revision=? AND effective_at=? AND status='dispatched' LIMIT 1`)
            .get(subscription.subscriptionId, revision, effectiveAt) as { tick_id: string; inbox_event_id: string | null;
              merged_from_slot_keys_json: string } | undefined;
      const tickId = newId("tick");
      const initialStatus = mergedInto ? "skipped" : "pending";
      const createdAt = this.now();
      let inserted = false;
      if (rust) {
        const existingSlot = overlayFindAll(
          this.db,
          "work_schedule_ticks",
          this.db.prepare("SELECT * FROM work_schedule_ticks WHERE subscription_id=? AND schedule_revision=? AND logical_slot_key=?")
            .all(subscription.subscriptionId, revision, slot.key) as Array<Record<string, unknown>>,
          r => String(r.tick_id),
          r => r.subscription_id === subscription.subscriptionId && Number(r.schedule_revision) === revision
            && r.logical_slot_key === slot.key,
        )[0];
        if (!existingSlot) {
          inserted = true;
          overlaySet(this.db, "work_schedule_ticks", tickId, {
            tick_id: tickId, subscription_id: subscription.subscriptionId, work_id: work.workId,
            schedule_revision: revision, logical_slot_key: slot.key, planned_at: cursor,
            effective_at: effectiveAt, status: initialStatus, merged_from_slot_keys_json: "[]",
            inbox_event_id: null, offline_gap_id: null, created_at: createdAt,
          });
          enqueueWorkOp(this.db, {
            op: "workScheduleTickWrite", mode: "insert", tickId, subscriptionId: subscription.subscriptionId,
            workId: work.workId, scheduleRevision: revision, logicalSlotKey: slot.key,
            plannedAt: cursor, effectiveAt, status: initialStatus, inboxEventId: null,
            mergedFromSlotKeysJson: null, createdAt,
          });
        }
      } else {
        inserted = this.db.prepare(`INSERT OR IGNORE INTO work_schedule_ticks
          (tick_id,subscription_id,work_id,schedule_revision,logical_slot_key,planned_at,effective_at,status,
           merged_from_slot_keys_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,'[]',?)`).run(
          tickId, subscription.subscriptionId, work.workId, revision, slot.key, cursor, effectiveAt,
          initialStatus, createdAt,
        ).changes > 0;
      }
      if (inserted && !mergedInto) {
        const eventId = newId("event");
        const dedupeKey = `sub:${subscription.subscriptionId}:tick:${revision}:${slot.key}`;
        this.works.repo.insertInbox({ eventId, dedupeKey, source: "cron", sourceEventId: dedupeKey,
          eventType: "work.tick", workId: work.workId, subscriptionId: subscription.subscriptionId,
          intentRevision: work.intentRevision, stateVersion: work.stateVersion, ownerEpoch: work.ownerEpoch,
          sourceVersion: String(cursor), payload: { scheduledAt: cursor, plannedAt: cursor, effectiveAt,
            continuousExecution: work.watchRule?.executionMode === "continuous",
            logicalSlotKey: slot.key, plannedWallTime: slot.wallTime, scheduleRevision: revision,
            timezone: timezone ?? null, dstNormalized: slot.normalized,
            ...(subscription.catchUpPolicy === "latest" ? { authoritativeReadbackRequired: true,
              catchUpFrom: scheduledAt, catchUpTo: cursor } : {}) }, status: "pending", mergedCount: 1,
          receivedAt: now, targetKey: subscription.sourceTarget, processReason: "schedule-tick" });
        available--;
        if (rust) {
          overlayMutate(this.db, "work_schedule_ticks", tickId,
            () => this.db.prepare("SELECT * FROM work_schedule_ticks WHERE tick_id=?").get(tickId) as Record<string, unknown> | undefined,
            cur => cur ? { ...cur, status: "dispatched", inbox_event_id: eventId } : undefined);
          enqueueWorkOp(this.db, {
            op: "workScheduleTickWrite", mode: "dispatched", tickId, subscriptionId: null, workId: null,
            scheduleRevision: null, logicalSlotKey: null, plannedAt: null, effectiveAt: null, status: null,
            inboxEventId: eventId, mergedFromSlotKeysJson: null, createdAt: null,
          });
        } else {
          this.db.prepare("UPDATE work_schedule_ticks SET status='dispatched',inbox_event_id=? WHERE tick_id=?")
            .run(eventId, tickId);
        }
        fired.push({ subscriptionId: subscription.subscriptionId, workId: work.workId, scheduledAt: cursor });
      } else if (inserted && mergedInto) {
        // Multiple logical (e.g. missing-hour) slots that resolve to one real instant share
        // one business work item; the first tick records the covered slot identities.
        const covered = new Set<string>(JSON.parse(mergedInto.merged_from_slot_keys_json) as string[]);
        covered.add(slot.key);
        const mergedJson = JSON.stringify([...covered].sort());
        if (rust) {
          overlayMutate(this.db, "work_schedule_ticks", mergedInto.tick_id,
            () => this.db.prepare("SELECT * FROM work_schedule_ticks WHERE tick_id=?").get(mergedInto.tick_id) as Record<string, unknown> | undefined,
            cur => cur ? { ...cur, merged_from_slot_keys_json: mergedJson } : undefined);
          enqueueWorkOp(this.db, {
            op: "workScheduleTickWrite", mode: "mergedSlots", tickId: mergedInto.tick_id, subscriptionId: null,
            workId: null, scheduleRevision: null, logicalSlotKey: null, plannedAt: null, effectiveAt: null,
            status: null, inboxEventId: null, mergedFromSlotKeysJson: mergedJson, createdAt: null,
          });
        } else {
          this.db.prepare("UPDATE work_schedule_ticks SET merged_from_slot_keys_json=? WHERE tick_id=?")
            .run(mergedJson, mergedInto.tick_id);
        }
      }
      const next = this.nextSlot(subscription, effectiveAt);
      if (next === undefined || next <= cursor) { cursor = cursor + 60_000; break; }
      cursor = next;
      if (guard >= 64) break;
    }
    // A one-shot wake has no cron slot to enumerate; it fires once.
    const nextWakeAt = subscription.cronExpression ? cursor : undefined;
    if (nextWakeAt !== subscription.nextWakeAt) this.works.repo.updateSubscription({ ...subscription, nextWakeAt, updatedAt: this.now() });
    return fired;
  }

  private settleScheduleGaps(subscription: WorkSubscriptionDto): void {
    if (subscription.source !== "cron") return;
    // Recovered means the scheduling policy was applied. It says nothing about
    // changes that happened in the watched business source while the host was away.
    const now = this.now();
    const reason = "已按策略恢复调度槽；业务来源需由后续检查读取";
    if (requiresWorkRustWrites(this.db)) {
      const candidates = overlayFindAll(
        this.db,
        "work_offline_gaps",
        this.db.prepare("SELECT * FROM work_offline_gaps WHERE subscription_id=? AND state IN ('open','recovering','unqueryable')")
          .all(subscription.subscriptionId) as Array<Record<string, unknown>>,
        r => String(r.gap_id),
        r => r.subscription_id === subscription.subscriptionId
          && ["open", "recovering", "unqueryable"].includes(String(r.state))
          && (subscription.nextWakeAt === undefined || Number(r.offline_gap_to) < subscription.nextWakeAt),
      );
      for (const row of candidates) {
        overlaySet(this.db, "work_offline_gaps", String(row.gap_id), {
          ...row, queryable: 1, state: "recovered", gap_reason: reason, updated_at: now,
        });
      }
      enqueueWorkOp(this.db, {
        op: "workOfflineGapWrite", mode: "settleCron", gapId: null, hostSessionId: null,
        subscriptionId: subscription.subscriptionId, workId: null, offlineGapFrom: null,
        offlineGapTo: null, detectedBy: null, confidence: null, policy: null, policyRevision: null,
        sourceCursor: null, queryable: null, recoveredCountDelta: null, mergedCountDelta: null,
        skippedCount: null, unknownCount: null, state: null, continuationCursor: null,
        gapReason: null, nextWakeAt: subscription.nextWakeAt ?? null, now,
      });
      return;
    }
    this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovered',
      gap_reason='已按策略恢复调度槽；业务来源需由后续检查读取',updated_at=?
      WHERE subscription_id=? AND state IN ('open','recovering','unqueryable')
        AND (? IS NULL OR offline_gap_to<?)`)
      .run(now, subscription.subscriptionId, subscription.nextWakeAt ?? null, subscription.nextWakeAt ?? null);
  }

  private latestDueSlot(subscription: WorkSubscriptionDto, first: number, now: number): number {
    let low = first;
    let high = now;
    let latest = first;
    for (let iteration = 0; low <= high && iteration < 64; iteration++) {
      const middle = low + Math.floor((high - low) / 2);
      const next = this.nextSlot(subscription, middle);
      if (next !== undefined && next <= now) {
        latest = Math.max(latest, next);
        low = middle + 1;
      } else high = middle - 1;
    }
    return latest;
  }

  private nextSlot(subscription: WorkSubscriptionDto, from: number): number | undefined {
    try {
      return cronNextWake({ cronExpression: subscription.cronExpression, timezone: subscription.timezone }, from);
    } catch {
      return undefined;
    }
  }

  private highestTickAt(subscriptionId: string, revision: number): number | undefined {
    if (requiresWorkRustWrites(this.db)) {
      const rows = overlayFindAll(
        this.db,
        "work_schedule_ticks",
        this.db.prepare("SELECT * FROM work_schedule_ticks WHERE subscription_id=? AND schedule_revision=?")
          .all(subscriptionId, revision) as Array<Record<string, unknown>>,
        r => String(r.tick_id),
        r => r.subscription_id === subscriptionId && Number(r.schedule_revision) === revision,
      );
      if (!rows.length) return undefined;
      return rows.reduce((max, r) => Math.max(max, Number(r.planned_at)), -Infinity);
    }
    const row = this.db.prepare(`SELECT MAX(planned_at) AS at FROM work_schedule_ticks
      WHERE subscription_id=? AND schedule_revision=?`).get(subscriptionId, revision) as { at: number | null };
    return row.at ?? undefined;
  }

  /**
   * Logical identity is the nominal local calendar slot, not croner's normalized UTC
   * instant. A spring-forward 02:30 plan maps once to 03:30 (same slot identity); a
   * fall-back repeated hour keeps croner's first occurrence rather than creating a
   * second business slot.
   */
  private logicalSlot(ms: number, cronExpression: string | undefined, timezone: string | undefined): {
    key: string; normalized: boolean; wallTime: string } {
    const effective = localParts(ms, timezone);
    if (!cronExpression) {
      return { key: `${effective.date}T${effective.time}`, normalized: false, wallTime: effective.time };
    }
    const wall = nominalWallSlot(cronExpression, ms, timezone);
    return { key: `${wall.date}T${wall.time}`, normalized: wall.normalized, wallTime: wall.time };
  }

  /** Wall clock rollback detection via persisted watermarks; monotonic time distinguishes real waits. */
  private detectClockJump(now: number): boolean {
    const state = this.hostStateRow();
    const last = state?.last_scan_at ?? undefined;
    const nowMono = this.monotonic();
    const mono = this.lastMonotonic;
    this.lastMonotonic = { at: now, value: nowMono };
    if (last === undefined) return false;
    if (now < last) return true;
    if (mono && nowMono - mono.value < (now - mono.at) / 2) {
      // Wall time advanced far more than elapsed monotonic time: a forward jump.
      return true;
    }
    return false;
  }

  private deadlineRow(workId: string, revision: number, at: number): { state: string; inbox_event_id: string | null } | undefined {
    const pk = `${workId}\0${revision}\0${at}`;
    const row = overlayReadOne<Record<string, unknown>>(this.db, "work_deadline_instances", pk,
      () => this.db.prepare("SELECT * FROM work_deadline_instances WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
        .get(workId, revision, at) as Record<string, unknown> | undefined);
    return row ? { state: String(row.state), inbox_event_id: (row.inbox_event_id as string | null | undefined) ?? null } : undefined;
  }

  private expireDeadlines(now: number): void {
    const rust = requiresWorkRustWrites(this.db);
    // Filter settled instances before the bounded scan. Otherwise the first 64
    // historical deadlines permanently hide every newer commitment.
    const candidateWorkIds: string[] = rust
      ? (() => {
          const allWorks = overlayFindAll(
            this.db, "works",
            this.db.prepare("SELECT * FROM works WHERE lifecycle IN ('active','paused') AND deadline_at IS NOT NULL AND deadline_at<=?")
              .all(now) as Array<Record<string, unknown>>,
            r => String(r.work_id),
            r => ["active", "paused"].includes(String(r.lifecycle)) && r.deadline_at !== null && r.deadline_at !== undefined && Number(r.deadline_at) <= now,
            (a, b) => Number(a.deadline_at) - Number(b.deadline_at) || (String(a.work_id) < String(b.work_id) ? -1 : String(a.work_id) > String(b.work_id) ? 1 : 0),
          );
          const matched: string[] = [];
          for (const w of allWorks) {
            const inst = this.deadlineRow(String(w.work_id), Number(w.deadline_revision ?? 1), Number(w.deadline_at));
            if (!inst || inst.state === "armed" || (w.lifecycle === "active" && inst.state === "followed-up" && inst.inbox_event_id === null)) {
              matched.push(String(w.work_id));
              if (matched.length >= 64) break;
            }
          }
          return matched;
        })()
      : (this.db.prepare(`SELECT w.work_id FROM works w LEFT JOIN work_deadline_instances d
          ON d.work_id=w.work_id AND d.deadline_revision=w.deadline_revision AND d.deadline_at=w.deadline_at
          WHERE w.lifecycle IN ('active','paused') AND w.deadline_at IS NOT NULL AND w.deadline_at<=?
          AND (d.work_id IS NULL OR d.state='armed'
            OR (w.lifecycle='active' AND d.state='followed-up' AND d.inbox_event_id IS NULL))
          ORDER BY w.deadline_at ASC,w.work_id ASC LIMIT 64`).all(now) as Array<{ work_id: string }>).map(r => r.work_id);
    for (const workId of candidateWorkIds) {
      const work = this.works.getWork(workId);
      if (!work || work.deadlineAt === undefined || work.deadlineAt > now) continue;
      const revision = work.deadlineRevision;
      const at = work.deadlineAt;
      let instance = this.deadlineRow(work.workId, revision, at);
      if (!instance) {
        if (rust) {
          const pk = `${work.workId}\0${revision}\0${at}`;
          overlayMutate(this.db, "work_deadline_instances", pk, () => undefined, cur => cur ?? {
            work_id: work.workId, deadline_revision: revision, deadline_at: at,
            state: "armed", inbox_event_id: null, created_at: now, followed_at: null,
          });
          enqueueWorkOp(this.db, {
            op: "workDeadlineInstanceWrite", mode: "insertArmed", workId: work.workId,
            deadlineRevision: revision, deadlineAt: at, state: null, inboxEventId: null, now,
          });
          instance = this.deadlineRow(work.workId, revision, at);
        } else {
          this.db.prepare(`INSERT OR IGNORE INTO work_deadline_instances
            (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?,?,?,'armed',?)`)
            .run(work.workId, revision, at, now);
          instance = this.deadlineRow(work.workId, revision, at);
        }
      }
      // A paused expiry records the fact but has no dispatched event. Once
      // resumed it still owes exactly one follow-up, unlike an emitted expiry.
      if (!instance || !(instance.state === "armed" || work.lifecycle === "active"
        && instance.state === "followed-up" && instance.inbox_event_id === null)) continue;
      if (work.lifecycle === "paused") {
        if (rust) {
          const pk = `${work.workId}\0${revision}\0${at}`;
          overlayMutate(this.db, "work_deadline_instances", pk, () => undefined, cur => ({
            work_id: work.workId, deadline_revision: revision, deadline_at: at,
            inbox_event_id: cur?.inbox_event_id ?? null, created_at: cur?.created_at ?? now,
            state: "followed-up", followed_at: now,
          }));
          enqueueWorkOp(this.db, {
            op: "workDeadlineInstanceWrite", mode: "followedUp", workId: work.workId,
            deadlineRevision: revision, deadlineAt: at, state: null, inboxEventId: null, now,
          });
        } else {
          this.db.prepare("UPDATE work_deadline_instances SET state='followed-up',followed_at=? WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
            .run(now, work.workId, revision, at);
        }
        this.gapBlocker(work.workId, `deadline:${revision}:${at}`, "deadline-follow-up",
          "事项承诺期限已到，但事项处于暂停状态；保留到期事实，恢复后再决定跟进", undefined, now);
        continue;
      }
      const eventId = newId("event");
      const dedupeKey = `work:${work.workId}:deadline:${revision}:${at}`;
      const event = this.works.repo.insertInbox({ eventId, dedupeKey, source: "system",
        sourceEventId: dedupeKey, eventType: "deadline_expired", workId: work.workId,
        intentRevision: work.intentRevision, stateVersion: work.stateVersion, ownerEpoch: work.ownerEpoch,
        payload: { deadlineExpired: true, readOnlyFollowUp: true, deadlineRevision: revision,
          deadlineAt: at, inputSnapshotId: work.inputSnapshotId }, status: "pending", mergedCount: 1,
        receivedAt: now, batchId: `deadline:${work.workId}:${revision}:${at}`, processReason: "deadline-expired" });
      if (event) {
        if (rust) {
          const pk = `${work.workId}\0${revision}\0${at}`;
          overlayMutate(this.db, "work_deadline_instances", pk, () => undefined, cur => ({
            work_id: work.workId, deadline_revision: revision, deadline_at: at,
            created_at: cur?.created_at ?? now, state: "followed-up", inbox_event_id: eventId, followed_at: now,
          }));
          enqueueWorkOp(this.db, {
            op: "workDeadlineInstanceWrite", mode: "followedUp", workId: work.workId,
            deadlineRevision: revision, deadlineAt: at, state: null, inboxEventId: eventId, now,
          });
        } else {
          this.db.prepare("UPDATE work_deadline_instances SET state='followed-up',inbox_event_id=?,followed_at=? WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
            .run(eventId, now, work.workId, revision, at);
        }
        this.works.repo.clearBlocker(`offline:${work.workId}:deadline-follow-up`, work.workId, now);
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
      }
    }
  }

  private recordGap(input: WorkOfflineGapInput): WorkOfflineGapDto | undefined {
    const rust = requiresWorkRustWrites(this.db);
    const existing = rust
      ? overlayFindAll(
          this.db,
          "work_offline_gaps",
          this.db.prepare(`SELECT * FROM work_offline_gaps WHERE host_session_id=?
            AND COALESCE(subscription_id,'')=COALESCE(?,'') AND offline_gap_from=?`)
            .all(input.hostSessionId, input.subscriptionId ?? null, input.from) as Array<Record<string, unknown>>,
          r => String(r.gap_id),
          r => r.host_session_id === input.hostSessionId
            && String(r.subscription_id ?? "") === String(input.subscriptionId ?? "")
            && Number(r.offline_gap_from) === input.from,
        )[0]
      : this.db.prepare(`SELECT * FROM work_offline_gaps WHERE host_session_id=?
          AND COALESCE(subscription_id,'')=COALESCE(?,'') AND offline_gap_from=?`)
          .get(input.hostSessionId, input.subscriptionId ?? null, input.from) as Record<string, unknown> | undefined;
    if (existing) return this.toGapDto(existing);
    const gapId = newId("gap");
    const now = this.now();
    const state = input.queryable ? "open" : "unqueryable";
    if (rust) {
      overlaySet(this.db, "work_offline_gaps", gapId, {
        gap_id: gapId, host_session_id: input.hostSessionId, subscription_id: input.subscriptionId ?? null,
        work_id: input.workId ?? null, offline_gap_from: input.from, offline_gap_to: input.to,
        detected_by: input.detectedBy, confidence: input.confidence, policy: input.policy,
        policy_revision: input.policyRevision, source_cursor: input.sourceCursor ?? null,
        queryable: input.queryable ? 1 : 0, recovered_count: 0, merged_count: 0,
        skipped_count: 0, unknown_count: null, state, continuation_cursor: null,
        gap_reason: input.gapReason ?? null, created_at: now, updated_at: now,
      });
      enqueueWorkOp(this.db, {
        op: "workOfflineGapWrite", mode: "insert", gapId, hostSessionId: input.hostSessionId,
        subscriptionId: input.subscriptionId ?? null, workId: input.workId ?? null,
        offlineGapFrom: input.from, offlineGapTo: input.to, detectedBy: input.detectedBy,
        confidence: input.confidence, policy: input.policy, policyRevision: input.policyRevision,
        sourceCursor: input.sourceCursor ?? null, queryable: input.queryable ? 1 : 0,
        recoveredCountDelta: null, mergedCountDelta: null, skippedCount: null, unknownCount: null,
        state, continuationCursor: null, gapReason: input.gapReason ?? null, nextWakeAt: null, now,
      });
    } else {
      this.db.prepare(`INSERT INTO work_offline_gaps
        (gap_id,host_session_id,subscription_id,work_id,offline_gap_from,offline_gap_to,detected_by,confidence,
         policy,policy_revision,source_cursor,queryable,recovered_count,merged_count,skipped_count,unknown_count,
         state,continuation_cursor,gap_reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,NULL,?,NULL,?,?,?)`).run(
        gapId, input.hostSessionId, input.subscriptionId ?? null, input.workId ?? null, input.from, input.to,
        input.detectedBy, input.confidence, input.policy, input.policyRevision, input.sourceCursor ?? null,
        input.queryable ? 1 : 0, state, input.gapReason ?? null,
        now, now,
      );
    }
    if (!input.queryable && input.subscriptionId) {
      this.gapBlocker(input.workId, gapId, "unqueryable-offline-gap",
        "来源没有历史回查能力，无法证明离线区间内没有错过事件", input.subscriptionId);
    }
    return this.toGapDto(this.gapRow(gapId)!);
  }

  private gapBlocker(workId: string | undefined, ref: string, reasonCode: "unqueryable-offline-gap" | "deadline-follow-up",
    reason: string, subscriptionId?: string, now = this.now()): void {
    if (!workId) return;
    const work = this.works.getWork(workId);
    if (!work) return;
    const blockerId = `offline:${workId}:${reasonCode}`;
    const existing = this.works.repo.getBlocker(blockerId);
    if (!existing) {
      this.works.repo.insertBlocker({ blockerId, workId, kind: "operational", reasonCode,
        reason, details: { gapRefs: [ref] }, sourceRef: ref, subscriptionId,
        waitingForUserInput: false, status: "open", createdAt: now });
      this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
    } else {
      const refs = new Set<string>([...(Array.isArray(existing.details?.gapRefs) ? existing.details.gapRefs as string[] : []), ref]);
      const detailsJson = JSON.stringify({ gapRefs: [...refs] });
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "work_blockers", blockerId,
          () => this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as Record<string, unknown> | undefined,
          cur => cur ? { ...cur, details_json: detailsJson, source_ref: ref, subscription_id: subscriptionId ?? null, status: "open", cleared_at: null } : undefined);
        enqueueWorkOp(this.db, {
          op: "workBlockerUpdate", blockerId, workId, mode: "gapReopen", reason: null,
          detailsJson, sourceRef: ref, subscriptionId: subscriptionId ?? null, causalChainId: null, clearedAt: null,
        });
      } else {
        this.db.prepare("UPDATE work_blockers SET details_json=?,source_ref=?,subscription_id=?,status='open',cleared_at=NULL WHERE blocker_id=?")
          .run(detailsJson, ref, subscriptionId ?? null, blockerId);
      }
    }
  }

  private gapsForHostSession(hostSessionId: string, to: number): WorkOfflineGapDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_offline_gaps WHERE host_session_id=? AND offline_gap_to=? ORDER BY gap_id")
      .all(hostSessionId, to) as Array<Record<string, unknown>>;
    const rows = requiresWorkRustWrites(this.db)
      ? overlayFindAll(this.db, "work_offline_gaps", dbRows, r => String(r.gap_id),
          r => r.host_session_id === hostSessionId && Number(r.offline_gap_to) === to,
          (a, b) => String(a.gap_id) < String(b.gap_id) ? -1 : String(a.gap_id) > String(b.gap_id) ? 1 : 0)
      : dbRows;
    return rows.map(row => this.toGapDto(row));
  }

  gaps(workId: string): WorkOfflineGapDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_offline_gaps WHERE work_id=? ORDER BY offline_gap_from DESC LIMIT 20")
      .all(workId) as Array<Record<string, unknown>>;
    const rows = requiresWorkRustWrites(this.db)
      ? overlayFindAll(this.db, "work_offline_gaps", dbRows, r => String(r.gap_id),
          r => r.work_id === workId, (a, b) => Number(b.offline_gap_from) - Number(a.offline_gap_from)).slice(0, 20)
      : dbRows;
    return rows.map(row => this.toGapDto(row));
  }

  hostState(): WorkWatchHostStateDto {
    const row = this.hostStateRow();
    const host = this.db.prepare("SELECT authority_id,released_at,heartbeat_at FROM work_host_lease WHERE lease_id='singleton'")
      .get() as { authority_id: string; released_at: number | null; heartbeat_at: number } | undefined;
    return { authorityId: host?.authority_id, sessionId: row?.session_id ?? this.sessionId,
      online: Boolean(host && host.released_at === null && this.authority()),
      lastScanAt: row?.last_scan_at ?? undefined, lastScanCursor: row?.last_scan_cursor ?? undefined,
      activeSince: row?.active_since ?? undefined, stoppedAt: row?.stopped_at ?? undefined,
      suspendEvidence: row?.suspend_evidence ?? undefined };
  }

  /** Leave an explicit stop watermark; the next start can separate a stop from a guessed pause. */
  markStopped(at = this.now()): void {
    this.works.transaction(() => {
      const authId = this.authorityId();
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "work_watch_host_state", authId,
          () => this.db.prepare("SELECT * FROM work_watch_host_state WHERE authority_id=?").get(authId) as Record<string, unknown> | undefined,
          cur => cur ? { ...cur, stopped_at: at, updated_at: at } : undefined);
        enqueueWorkOp(this.db, {
          op: "workWatchHostStateWrite", mode: "markStopped", authorityId: authId,
          sessionId: null, lastScanAt: null, lastScanCursor: null, activeSince: null,
          lastSeenAt: null, suspendEvidence: null, stoppedAt: at, updatedAt: at,
        });
        return;
      }
      this.db.prepare("UPDATE work_watch_host_state SET stopped_at=?,updated_at=? WHERE authority_id=?")
        .run(at, at, authId);
    });
  }

  private upsertHostState(input: { sessionId: string; now: number; stopped?: boolean; suspendEvidence?: string }): void {
    const authorityId = this.authorityId();
    const existing = this.hostStateRow();
    const lastScanCursor = existing?.last_scan_cursor ?? null;
    const activeSince = existing?.active_since ?? input.now;
    const suspendEvidence = input.suspendEvidence ?? null;
    const stoppedAt = input.stopped ? input.now : null;
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_watch_host_state", authorityId, {
        authority_id: authorityId, session_id: input.sessionId, last_scan_at: input.now,
        last_scan_cursor: lastScanCursor, active_since: activeSince, last_seen_at: input.now,
        suspend_evidence: suspendEvidence, stopped_at: stoppedAt, updated_at: input.now,
      });
      enqueueWorkOp(this.db, {
        op: "workWatchHostStateWrite", mode: "upsert", authorityId, sessionId: input.sessionId,
        lastScanAt: input.now, lastScanCursor, activeSince, lastSeenAt: input.now,
        suspendEvidence, stoppedAt, updatedAt: input.now,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_watch_host_state
      (authority_id,session_id,last_scan_at,last_scan_cursor,active_since,last_seen_at,suspend_evidence,stopped_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(authority_id) DO UPDATE SET session_id=excluded.session_id,last_scan_at=excluded.last_scan_at,
        last_scan_cursor=excluded.last_scan_cursor,active_since=excluded.active_since,last_seen_at=excluded.last_seen_at,
        suspend_evidence=excluded.suspend_evidence,stopped_at=excluded.stopped_at,updated_at=excluded.updated_at`).run(
      authorityId, input.sessionId, input.now, lastScanCursor,
      activeSince, input.now, suspendEvidence, stoppedAt, input.now,
    );
  }

  private authorityId(): string {
    const host = this.db.prepare("SELECT authority_id FROM work_host_lease WHERE lease_id='singleton'").get() as { authority_id: string } | undefined;
    return host?.authority_id ?? `authority:${this.sessionId}`;
  }

  private hostStateRow(): { authority_id: string; session_id: string; last_scan_at: number | null;
    last_scan_cursor: string | null; active_since: number | null; suspend_evidence: string | null;
    stopped_at: number | null } | undefined {
    const authId = this.authorityId();
    return overlayReadOne(this.db, "work_watch_host_state", authId,
      () => this.db.prepare("SELECT * FROM work_watch_host_state WHERE authority_id=?").get(authId) as Record<string, unknown> | undefined) as {
      authority_id: string; session_id: string; last_scan_at: number | null;
      last_scan_cursor: string | null; active_since: number | null; suspend_evidence: string | null;
      stopped_at: number | null;
    } | undefined;
  }

  private gapRow(gapId: string): Record<string, unknown> | undefined {
    return overlayReadOne<Record<string, unknown>>(this.db, "work_offline_gaps", gapId,
      () => this.db.prepare("SELECT * FROM work_offline_gaps WHERE gap_id=?").get(gapId) as Record<string, unknown> | undefined);
  }

  private toGapDto(row: Record<string, unknown>): WorkOfflineGapDto {
    return { gapId: String(row.gap_id), subscriptionId: row.subscription_id as string | undefined ?? undefined,
      workId: row.work_id as string | undefined ?? undefined, offlineGapFrom: Number(row.offline_gap_from),
      offlineGapTo: Number(row.offline_gap_to), detectedBy: String(row.detected_by),
      confidence: row.confidence as "evidence" | "inferred", policy: row.policy as "latest" | "each" | "skip",
      policyRevision: Number(row.policy_revision), queryable: Number(row.queryable) === 1,
      recoveredCount: Number(row.recovered_count), mergedCount: Number(row.merged_count),
      skippedCount: row.skipped_count === null ? undefined : Number(row.skipped_count),
      unknownCount: row.unknown_count === null ? undefined : Number(row.unknown_count),
      state: row.state as WorkOfflineGapDto["state"], gapReason: row.gap_reason as string | undefined ?? undefined };
  }
}

/** Local wall-clock parts with explicit DST metadata; no fixed 24h day is assumed. */
export function localParts(ms: number, timezone?: string): { date: string; time: string; offsetMinutes: number; fallback?: boolean } {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
  const offsetMinutes = (Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - Math.floor(ms / 1000) * 1000) / 60_000;
  return { date, time, offsetMinutes };
}

/** Stable schedule identity shared by the scheduler and the exact tick row. */
export function logicalSlotKey(subscriptionId: string, revision: number, slot: { date: string; time: string }): string {
  return createHash("sha256").update(`${subscriptionId}:${revision}:${slot.date}T${slot.time}`).digest("hex");
}

/**
 * The nominal wall-clock slot for an effective instant: interpret the local wall time as
 * UTC, ask croner (UTC) for candidates, and keep the closest candidate not after it. This
 * preserves a missing spring-forward 02:30 as 02:30 even though croner schedules 03:30.
 */
export function nominalWallSlot(cronExpression: string, effectiveAt: number,
  timezone: string | undefined): { date: string; time: string; normalized: boolean } {
  const local = localParts(effectiveAt, timezone);
  const [year, month, day] = local.date.split("-").map(Number);
  const [hour, minute] = local.time.split(":").map(Number);
  const pseudo = Date.UTC(year, month - 1, day, hour, minute);
  const cron = new Cron(cronExpression, { timezone: "UTC", paused: true });
  try {
    let candidate: Date | null = cron.nextRun(new Date(pseudo - 3 * 3_600_000));
    let best: Date | null = null;
    let guard = 0;
    while (candidate && candidate.getTime() <= pseudo + 60_000 && guard++ < 512) {
      if (candidate.getTime() <= pseudo) best = candidate;
      candidate = cron.nextRun(candidate);
    }
    if (!best) return { ...local, normalized: false };
    const date = `${best.getUTCFullYear()}-${String(best.getUTCMonth() + 1).padStart(2, "0")}-${String(best.getUTCDate()).padStart(2, "0")}`;
    const time = `${String(best.getUTCHours()).padStart(2, "0")}:${String(best.getUTCMinutes()).padStart(2, "0")}`;
    return { date, time, normalized: time !== local.time };
  } finally {
    cron.stop();
  }
}
