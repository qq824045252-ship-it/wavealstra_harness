import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import type { WorkOfflineGapDto, WorkWatchHostStateDto } from "../../../shared/bot-work-phase4";
import { Cron } from "croner";
import { newId } from "./WorkRepository";
import { cronNextWake } from "./WorkSchedule";
import type { WorkService } from "./WorkService";

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

  /** Register the scheduler on the real host lifecycle; the caller owns process exit. */
  start(intervalMs = 5_000): void {
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

  /** Apply the saved policy for an observed gap; repeated resume notifications reuse the same gap. */
  applyGap(gapId: string, options: { queryable?: boolean; unknownCount?: number; skippedCount?: number;
    events?: Array<{ sourceEventId: string; eventType: string; sourceVersion?: string; payload?: Record<string, unknown>; occurredAt?: number }> } = {}): WorkOfflineGapDto | undefined {
    return this.works.transaction(() => {
      const row = this.gapRow(gapId);
      if (!row || !row.subscription_id) return undefined;
      if (!this.authority() || row.state === "recovered") return this.toGapDto(row);
      const subscription = this.works.repo.getSubscription(String(row.subscription_id));
      if (!subscription) return undefined;
      // A cron gap is recoverable from the persisted schedule, not from an external
      // business-history query. Do not enqueue a second generic latest readback.
      if (subscription.source === "cron") {
        this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovering',
          gap_reason='等待持久调度游标恢复；不代表业务来源历史已回查',updated_at=? WHERE gap_id=?`)
          .run(this.now(), gapId);
        this.settleScheduleGaps(subscription);
        return this.toGapDto(this.gapRow(gapId)!);
      }
      const queryable = options.queryable ?? (this.works.ingress.adapter(subscription.source)?.canQueryHistory === true);
      const policy = subscription.catchUpPolicy;
      if (!queryable) {
        this.db.prepare("UPDATE work_offline_gaps SET queryable=0,state='unqueryable',unknown_count=?,updated_at=? WHERE gap_id=?")
          .run(options.unknownCount ?? null, this.now(), gapId);
        this.gapBlocker(row.work_id ? String(row.work_id) : undefined, gapId, "unqueryable-offline-gap",
          "来源没有历史回查能力，离线区间内的触发与业务变化无法补查", subscription.subscriptionId);
        return this.toGapDto(this.gapRow(gapId)!);
      }
      if (policy === "skip") {
        this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',skipped_count=?,updated_at=? WHERE gap_id=?")
          .run(options.skippedCount ?? null, this.now(), gapId);
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
          this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',merged_count=merged_count+?,updated_at=? WHERE gap_id=?")
            .run(inserted ? 1 : 0, this.now(), gapId);
        } else {
          this.db.prepare("UPDATE work_offline_gaps SET queryable=1,state='recovered',updated_at=? WHERE gap_id=?").run(this.now(), gapId);
        }
      } else {
        // Capability metadata is not a completed history query. Host resume calls this
        // before an adapter has supplied a page; keep that gap visibly unresolved.
        if (options.events === undefined) {
          this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovering',
            gap_reason='等待来源历史回查结果',updated_at=? WHERE gap_id=?`).run(this.now(), gapId);
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
        this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state=?,recovered_count=recovered_count+?,
          skipped_count=COALESCE(skipped_count,0)+?,continuation_cursor=?,gap_reason=?,updated_at=? WHERE gap_id=?`)
          .run(page.length ? "recovering" : "recovered", ingested, skipped + (options.skippedCount ?? 0),
            cursor, refused ? "来源回放受背压阻碍，保留游标等待重试" : null, this.now(), gapId);
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
      for (const row of this.db.prepare(`SELECT work_id FROM works WHERE mode='watch' AND lifecycle IN ('active','paused','closing')
        AND ((json_type(watch_rule_json,'$.endsAt') IN ('integer','real') AND json_extract(watch_rule_json,'$.endsAt')<=?)
          OR json_extract(watch_rule_json,'$.termination.reason')='schedule_expired')`).all(now) as Array<{ work_id: string }>)
        this.works.expireWatchTime(row.work_id, now, this.expiryReviewDelivered(row.work_id));
      const cursor = this.db.prepare(`SELECT last_scan_cursor FROM work_watch_host_state
        WHERE last_scan_cursor IS NOT NULL ORDER BY (authority_id=?) DESC,rowid DESC LIMIT 1`)
        .get(this.authorityId()) as { last_scan_cursor: string | null } | undefined;
      const after = cursor?.last_scan_cursor ?? "";
      const due = (comparison: ">" | "<=", limit: number) => this.db.prepare(`SELECT subscription.subscription_id
        FROM work_subscriptions subscription JOIN works work ON work.work_id=subscription.work_id
        WHERE subscription.stopped_at IS NULL AND work.lifecycle='active' AND subscription.next_wake_at<=?
          AND subscription.subscription_id ${comparison} ? ORDER BY subscription.subscription_id LIMIT ?`)
        .all(now, after, limit) as Array<{ subscription_id: string }>;
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
      if (rows.length) this.db.prepare("UPDATE work_watch_host_state SET last_scan_cursor=? WHERE authority_id=?")
        .run(rows.at(-1)!.subscription_id, this.authorityId());
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
    const depth = this.db.prepare(`SELECT COUNT(*) AS count FROM work_events_inbox
      WHERE subscription_id=? AND status IN ('pending','merged','blocked')`)
      .get(subscription.subscriptionId) as { count: number };
    let available = Math.max(0, subscription.maxQueueDepth - depth.count);
    if (!available) return fired;
    while (cursor <= now && guard++ < 64) {
      // Keep the persisted continuation intact until capacity becomes available.
      if (available <= 0) break;
      const slot = this.logicalSlot(cursor, subscription.cronExpression, timezone);
      const effectiveAt = cursor;
      const mergedInto = this.db.prepare(`SELECT tick_id,inbox_event_id,merged_from_slot_keys_json FROM work_schedule_ticks
        WHERE subscription_id=? AND schedule_revision=? AND effective_at=? AND status='dispatched' LIMIT 1`)
        .get(subscription.subscriptionId, revision, effectiveAt) as { tick_id: string; inbox_event_id: string | null;
          merged_from_slot_keys_json: string } | undefined;
      const tickId = newId("tick");
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO work_schedule_ticks
        (tick_id,subscription_id,work_id,schedule_revision,logical_slot_key,planned_at,effective_at,status,
         merged_from_slot_keys_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,'[]',?)`).run(
        tickId, subscription.subscriptionId, work.workId, revision, slot.key, cursor, effectiveAt,
        mergedInto ? "skipped" : "pending", this.now(),
      );
      if (inserted.changes && !mergedInto) {
        const eventId = newId("event");
        const dedupeKey = `sub:${subscription.subscriptionId}:tick:${revision}:${slot.key}`;
        this.works.repo.insertInbox({ eventId, dedupeKey, source: "cron", sourceEventId: dedupeKey,
          eventType: "work.tick", workId: work.workId, subscriptionId: subscription.subscriptionId,
          intentRevision: work.intentRevision, stateVersion: work.stateVersion, ownerEpoch: work.ownerEpoch,
          sourceVersion: String(cursor), payload: { scheduledAt: cursor, plannedAt: cursor, effectiveAt,
            logicalSlotKey: slot.key, plannedWallTime: slot.wallTime, scheduleRevision: revision,
            timezone: timezone ?? null, dstNormalized: slot.normalized,
            ...(subscription.catchUpPolicy === "latest" ? { authoritativeReadbackRequired: true,
              catchUpFrom: scheduledAt, catchUpTo: cursor } : {}) }, status: "pending", mergedCount: 1,
          receivedAt: now, targetKey: subscription.sourceTarget, processReason: "schedule-tick" });
        available--;
        this.db.prepare("UPDATE work_schedule_ticks SET status='dispatched',inbox_event_id=? WHERE tick_id=?")
          .run(eventId, tickId);
        fired.push({ subscriptionId: subscription.subscriptionId, workId: work.workId, scheduledAt: cursor });
      } else if (inserted.changes && mergedInto) {
        // Multiple logical (e.g. missing-hour) slots that resolve to one real instant share
        // one business work item; the first tick records the covered slot identities.
        const covered = new Set<string>(JSON.parse(mergedInto.merged_from_slot_keys_json) as string[]);
        covered.add(slot.key);
        this.db.prepare("UPDATE work_schedule_ticks SET merged_from_slot_keys_json=? WHERE tick_id=?")
          .run(JSON.stringify([...covered].sort()), mergedInto.tick_id);
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
    this.db.prepare(`UPDATE work_offline_gaps SET queryable=1,state='recovered',
      gap_reason='已按策略恢复调度槽；业务来源需由后续检查读取',updated_at=?
      WHERE subscription_id=? AND state IN ('open','recovering','unqueryable')
        AND (? IS NULL OR offline_gap_to<?)`)
      .run(this.now(), subscription.subscriptionId, subscription.nextWakeAt ?? null, subscription.nextWakeAt ?? null);
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

  private expireDeadlines(now: number): void {
    // Filter settled instances before the bounded scan. Otherwise the first 64
    // historical deadlines permanently hide every newer commitment.
    const rows = this.db.prepare(`SELECT w.* FROM works w LEFT JOIN work_deadline_instances d
      ON d.work_id=w.work_id AND d.deadline_revision=w.deadline_revision AND d.deadline_at=w.deadline_at
      WHERE w.lifecycle IN ('active','paused') AND w.deadline_at IS NOT NULL AND w.deadline_at<=?
      AND (d.work_id IS NULL OR d.state='armed'
        OR (w.lifecycle='active' AND d.state='followed-up' AND d.inbox_event_id IS NULL))
      ORDER BY w.deadline_at ASC,w.work_id ASC LIMIT 64`).all(now) as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const work = this.works.getWork(String(raw.work_id));
      if (!work || work.deadlineAt === undefined || work.deadlineAt > now) continue;
      const revision = work.deadlineRevision;
      const at = work.deadlineAt;
      let instance = this.db.prepare("SELECT * FROM work_deadline_instances WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
        .get(work.workId, revision, at) as { state: string; inbox_event_id: string | null } | undefined;
      if (!instance) {
        this.db.prepare(`INSERT OR IGNORE INTO work_deadline_instances
          (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?,?,?,'armed',?)`)
          .run(work.workId, revision, at, now);
        instance = this.db.prepare("SELECT * FROM work_deadline_instances WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
          .get(work.workId, revision, at) as { state: string; inbox_event_id: string | null } | undefined;
      }
      // A paused expiry records the fact but has no dispatched event. Once
      // resumed it still owes exactly one follow-up, unlike an emitted expiry.
      if (!instance || !(instance.state === "armed" || work.lifecycle === "active"
        && instance.state === "followed-up" && instance.inbox_event_id === null)) continue;
      if (work.lifecycle === "paused") {
        this.db.prepare("UPDATE work_deadline_instances SET state='followed-up',followed_at=? WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
          .run(now, work.workId, revision, at);
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
        this.db.prepare("UPDATE work_deadline_instances SET state='followed-up',inbox_event_id=?,followed_at=? WHERE work_id=? AND deadline_revision=? AND deadline_at=?")
          .run(eventId, now, work.workId, revision, at);
        this.works.repo.clearBlocker(`offline:${work.workId}:deadline-follow-up`, work.workId, now);
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
      }
    }
  }

  private recordGap(input: WorkOfflineGapInput): WorkOfflineGapDto | undefined {
    const existing = this.db.prepare(`SELECT gap_id FROM work_offline_gaps WHERE host_session_id=?
      AND COALESCE(subscription_id,'')=COALESCE(?,'') AND offline_gap_from=?`)
      .get(input.hostSessionId, input.subscriptionId ?? null, input.from) as { gap_id: string } | undefined;
    if (existing) return this.toGapDto(this.gapRow(existing.gap_id)!);
    const gapId = newId("gap");
    this.db.prepare(`INSERT INTO work_offline_gaps
      (gap_id,host_session_id,subscription_id,work_id,offline_gap_from,offline_gap_to,detected_by,confidence,
       policy,policy_revision,source_cursor,queryable,recovered_count,merged_count,skipped_count,unknown_count,
       state,continuation_cursor,gap_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,NULL,?,NULL,?,?,?)`).run(
      gapId, input.hostSessionId, input.subscriptionId ?? null, input.workId ?? null, input.from, input.to,
      input.detectedBy, input.confidence, input.policy, input.policyRevision, input.sourceCursor ?? null,
      input.queryable ? 1 : 0, input.queryable ? "open" : "unqueryable", input.gapReason ?? null,
      this.now(), this.now(),
    );
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
      this.db.prepare("UPDATE work_blockers SET details_json=?,source_ref=?,subscription_id=?,status='open',cleared_at=NULL WHERE blocker_id=?")
        .run(JSON.stringify({ gapRefs: [...refs] }), ref, subscriptionId ?? null, blockerId);
    }
  }

  private gapsForHostSession(hostSessionId: string, to: number): WorkOfflineGapDto[] {
    return (this.db.prepare("SELECT * FROM work_offline_gaps WHERE host_session_id=? AND offline_gap_to=? ORDER BY gap_id")
      .all(hostSessionId, to) as Array<Record<string, unknown>>).map(row => this.toGapDto(row));
  }

  gaps(workId: string): WorkOfflineGapDto[] {
    return (this.db.prepare("SELECT * FROM work_offline_gaps WHERE work_id=? ORDER BY offline_gap_from DESC LIMIT 20")
      .all(workId) as Array<Record<string, unknown>>).map(row => this.toGapDto(row));
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
      this.db.prepare("UPDATE work_watch_host_state SET stopped_at=?,updated_at=? WHERE authority_id=?")
        .run(at, at, this.authorityId());
    });
  }

  private upsertHostState(input: { sessionId: string; now: number; stopped?: boolean; suspendEvidence?: string }): void {
    const authorityId = this.authorityId();
    const existing = this.hostStateRow();
    this.db.prepare(`INSERT INTO work_watch_host_state
      (authority_id,session_id,last_scan_at,last_scan_cursor,active_since,last_seen_at,suspend_evidence,stopped_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(authority_id) DO UPDATE SET session_id=excluded.session_id,last_scan_at=excluded.last_scan_at,
        last_scan_cursor=excluded.last_scan_cursor,active_since=excluded.active_since,last_seen_at=excluded.last_seen_at,
        suspend_evidence=excluded.suspend_evidence,stopped_at=excluded.stopped_at,updated_at=excluded.updated_at`).run(
      authorityId, input.sessionId, input.now, existing?.last_scan_cursor ?? null,
      existing?.active_since ?? input.now, input.now, input.suspendEvidence ?? null,
      input.stopped ? input.now : null, input.now,
    );
  }

  private authorityId(): string {
    const host = this.db.prepare("SELECT authority_id FROM work_host_lease WHERE lease_id='singleton'").get() as { authority_id: string } | undefined;
    return host?.authority_id ?? `authority:${this.sessionId}`;
  }

  private hostStateRow(): { authority_id: string; session_id: string; last_scan_at: number | null;
    last_scan_cursor: string | null; active_since: number | null; suspend_evidence: string | null;
    stopped_at: number | null } | undefined {
    return this.db.prepare("SELECT * FROM work_watch_host_state WHERE authority_id=?").get(this.authorityId()) as
      { authority_id: string; session_id: string; last_scan_at: number | null; last_scan_cursor: string | null;
        active_since: number | null; suspend_evidence: string | null; stopped_at: number | null } | undefined;
  }

  private gapRow(gapId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM work_offline_gaps WHERE gap_id=?").get(gapId) as Record<string, unknown> | undefined;
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
