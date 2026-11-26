import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkInboxEventDto, WorkSourceEventDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import { newId } from "./WorkRepository";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainInTx } from "./WorkDomainRuntime";
import type { WorkService } from "./WorkService";

/** A late read belongs to exactly the original frozen/merged Inbox obligation. */
export function sameSourceReadbackClaim(event: WorkInboxEventDto, stored: WorkInboxEventDto): boolean {
  return stored.claimVersion === event.claimVersion && stored.frozenAt === event.frozenAt
    && stored.sourceVersion === event.sourceVersion && stored.sourceEventId === event.sourceEventId
    && stored.mergedCount === event.mergedCount && JSON.stringify(stored.payload) === JSON.stringify(event.payload)
    && JSON.stringify(stored.frozenPayload) === JSON.stringify(event.frozenPayload);
}

export function ensureWorkPausedTables(db: Database.Database): void {
  if (db.readonly) return;
  const names = db.prepare("PRAGMA table_info(work_events_inbox)").all().map(row => z.object({ name: z.string() }).parse(row).name);
  if (names.length && !names.includes("queued_while_paused")) db.exec("ALTER TABLE work_events_inbox ADD COLUMN queued_while_paused INTEGER NOT NULL DEFAULT 0 CHECK(queued_while_paused IN (0,1))");
  db.exec(`CREATE TABLE IF NOT EXISTS work_paused_source_routes (
    source TEXT NOT NULL, source_event_id TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES work_subscriptions(subscription_id),
    catch_up_policy TEXT NOT NULL CHECK(catch_up_policy IN ('latest','each','skip')), inbox_event_id TEXT REFERENCES work_events_inbox(event_id),
    PRIMARY KEY(source,source_event_id,subscription_id), FOREIGN KEY(source,source_event_id) REFERENCES work_source_events(source,source_event_id)
  );`);
}
/** Paused obligations remain in the original Inbox. No second event store exists. */
export class WorkPausedBacklog {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) { ensureWorkPausedTables(db); }
  enqueue(work: WorkDto, subscription: WorkSubscriptionDto, event: WorkSourceEventDto, now: number, targetKey = "default"): "pending" | "merged" | "blocked" | "duplicate" {
    if (!workDomainInTx(this.db) || work.lifecycle !== "paused") throw new Error("暂停积压必须在暂停事项的事件事务内提交");
    const rust = requiresWorkRustWrites(this.db);
    this.works.repo.recordSourceEvent({source:event.source,sourceEventId:event.sourceEventId,eventType:event.eventType,sourceVersion:event.sourceVersion,
      causalEventId:event.causalEventId,payload:event.payload ?? {},receivedAt:now});
    const routePk = `${event.source}\0${event.sourceEventId}\0${subscription.subscriptionId}`;
    // Routing only: event content lives in source_events and consumption in events_inbox.
    if (rust) {
      overlayMutate(this.db, "work_paused_source_routes", routePk, () =>
        this.db.prepare("SELECT * FROM work_paused_source_routes WHERE source=? AND source_event_id=? AND subscription_id=?")
          .get(event.source, event.sourceEventId, subscription.subscriptionId) as Record<string, unknown> | undefined,
      cur => cur ?? {
        source: event.source, source_event_id: event.sourceEventId, subscription_id: subscription.subscriptionId,
        catch_up_policy: subscription.catchUpPolicy, inbox_event_id: null,
      });
      enqueueWorkOp(this.db, {
        op: "workPausedSourceRouteWrite", source: event.source, sourceEventId: event.sourceEventId,
        subscriptionId: subscription.subscriptionId, catchUpPolicy: subscription.catchUpPolicy, inboxEventId: null,
      });
    } else {
      this.db.prepare("INSERT OR IGNORE INTO work_paused_source_routes(source,source_event_id,subscription_id,catch_up_policy) VALUES (?,?,?,?)")
        .run(event.source,event.sourceEventId,subscription.subscriptionId,subscription.catchUpPolicy);
    }
    const dedupeKey = `sub:${subscription.subscriptionId}:src:${event.sourceEventId}`;
    const dbPrior = this.db.prepare("SELECT * FROM work_events_inbox WHERE dedupe_key=?").all(dedupeKey) as Array<Record<string, unknown>>;
    const prior = overlayFindAll(this.db, "work_events_inbox", dbPrior, r => String(r.event_id), r => r.dedupe_key === dedupeKey)[0];
    if(prior) {
      const priorEventId = String(prior.event_id);
      if (rust) {
        overlayMutate(this.db, "work_paused_source_routes", routePk, () => undefined,
          cur => cur ? { ...cur, inbox_event_id: priorEventId } : cur);
        enqueueWorkOp(this.db, {
          op: "workPausedSourceRouteWrite", source: event.source, sourceEventId: event.sourceEventId,
          subscriptionId: subscription.subscriptionId, catchUpPolicy: subscription.catchUpPolicy, inboxEventId: priorEventId,
        });
      } else {
        this.db.prepare("UPDATE work_paused_source_routes SET inbox_event_id=? WHERE source=? AND source_event_id=? AND subscription_id=?")
          .run(priorEventId, event.source, event.sourceEventId, subscription.subscriptionId);
      }
      return "duplicate";
    }
    const pending = this.works.repo.listInbox(work.workId,["pending","merged","blocked"]).filter(item => item.subscriptionId === subscription.subscriptionId);
    if (pending.length >= subscription.maxQueueDepth) {
      const id = `paused-backpressure:${subscription.subscriptionId}`;
      const existing = this.works.repo.listOpenBlockers(work.workId).find(item => item.reasonCode === "backlog-overflow")
        ?? this.works.repo.getBlocker(id);
      if (!existing) this.works.repo.insertBlocker({ blockerId: id, workId: work.workId, kind: "backpressure",
        reasonCode: "backlog-overflow", reason: "暂停积压达到上限，后续来源事实保留且等待显式补读",
        details: { subscriptionId: subscription.subscriptionId, maxEvents: subscription.maxQueueDepth },
        status: "open", waitingForUserInput: false, createdAt: now });
      else this.works.repo.reopenBlocker(existing.blockerId, work.workId);
      return "blocked";
    }
    const eventId = newId("event");
    this.works.repo.insertInbox({ eventId, dedupeKey, workId: work.workId, subscriptionId: subscription.subscriptionId,
      source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType, sourceVersion: event.sourceVersion,
      intentRevision: work.intentRevision, stateVersion: work.stateVersion, ownerEpoch: work.ownerEpoch,
      payload: event.payload ?? {}, causalEventId: event.causalEventId, status: "pending", mergedCount: 1, receivedAt: now, targetKey });
    if (rust) {
      overlayMutate(this.db, "work_events_inbox", eventId, () =>
        this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, queued_while_paused: 1 } : cur);
      enqueueWorkOp(this.db, {
        op: "workInboxUpdate", mode: "markQueuedWhilePaused", eventId, subscriptionId: null, workId: null,
        eventType: null, sourceVersion: null, causalEventId: null, payloadJson: null, status: null,
        mergeDeadlineAt: null, mergedCount: null, targetKey: null, batchId: null, batchDeadlineAt: null, now: null,
      });
      overlayMutate(this.db, "work_paused_source_routes", routePk, () => undefined,
        cur => cur ? { ...cur, inbox_event_id: eventId } : cur);
      enqueueWorkOp(this.db, {
        op: "workPausedSourceRouteWrite", source: event.source, sourceEventId: event.sourceEventId,
        subscriptionId: subscription.subscriptionId, catchUpPolicy: subscription.catchUpPolicy, inboxEventId: eventId,
      });
    } else {
      this.db.prepare("UPDATE work_events_inbox SET queued_while_paused=1 WHERE event_id=?").run(eventId);
      this.db.prepare("UPDATE work_paused_source_routes SET inbox_event_id=? WHERE source=? AND source_event_id=? AND subscription_id=?").run(eventId,event.source,event.sourceEventId,subscription.subscriptionId);
    }
    this.works.repo.updateWork({ ...this.works.getWork(work.workId)!, stateVersion: this.works.getWork(work.workId)!.stateVersion + 1, updatedAt: now });
    return "pending";
  }
  refill(workId:string,now:number):void {
    if(!workDomainInTx(this.db))throw Error("积压回填必须在业务事务内执行");
    const rust = requiresWorkRustWrites(this.db);
    const work=this.works.getWork(workId);if(!work || work.lifecycle!=="active")return;
    let changed=false;
    for(const event of this.works.repo.listInbox(workId,["blocked"])) {
      if(event.payload._sourceReadbackError && event.payload._sourceReadbackFailedAtSourceVersion!==work.sourceVersion) {
        this.works.repo.setInboxStatus(event.eventId,"pending");this.works.repo.clearBlocker(`source-readback:${event.eventId}`,workId,now);changed=true;
      }
    }
    const pausedRouteSchema = z.object({source:z.string(),source_event_id:z.string(),catch_up_policy:z.enum(["latest","each","skip"]),event_type:z.string(),source_version:z.string().nullable(),causal_event_id:z.string().nullable(),payload_json:z.string(),received_at:z.number()});
    for(const subscription of this.works.repo.listSubscriptions(workId)) {
      const dbJoined = this.db.prepare(`SELECT route.source,route.source_event_id,route.catch_up_policy,event.event_type,event.source_version,event.causal_event_id,event.payload_json,event.received_at
        FROM work_paused_source_routes route JOIN work_source_events event ON event.source=route.source AND event.source_event_id=route.source_event_id
        WHERE route.subscription_id=? AND route.inbox_event_id IS NULL ORDER BY event.received_at,event.rowid LIMIT ?`)
        .all(subscription.subscriptionId, Math.min(256, Math.max(8, subscription.maxQueueDepth))) as Array<Record<string, unknown>>;
      const dbRoutes = this.db.prepare("SELECT * FROM work_paused_source_routes WHERE subscription_id=? AND inbox_event_id IS NULL")
        .all(subscription.subscriptionId) as Array<Record<string, unknown>>;
      const unlinkedRoutes = overlayFindAll(this.db, "work_paused_source_routes", dbRoutes,
        r => `${r.source}\0${r.source_event_id}\0${r.subscription_id}`,
        r => r.subscription_id === subscription.subscriptionId && (r.inbox_event_id ?? null) === null);
      const joinedByKey = new Map(dbJoined.map(r => [`${r.source}\0${r.source_event_id}`, pausedRouteSchema.parse(r)]));
      const rows = unlinkedRoutes.flatMap(r => {
        const k = `${r.source}\0${r.source_event_id}`;
        const existingJoined = joinedByKey.get(k);
        if (existingJoined) return [existingJoined];
        const ev = overlayReadOne<Record<string, unknown>>(this.db, "work_source_events", k, () =>
          this.db.prepare("SELECT * FROM work_source_events WHERE source=? AND source_event_id=?").get(r.source, r.source_event_id) as Record<string, unknown> | undefined);
        return ev ? [pausedRouteSchema.parse({
          source: r.source, source_event_id: r.source_event_id, catch_up_policy: r.catch_up_policy,
          event_type: ev.event_type, source_version: ev.source_version ?? null, causal_event_id: ev.causal_event_id ?? null,
          payload_json: ev.payload_json, received_at: ev.received_at,
        })] : [];
      }).sort((a, b) => a.received_at - b.received_at).slice(0, Math.min(256, Math.max(8, subscription.maxQueueDepth)));
      for(const row of rows) {
        const pending=this.works.repo.listInbox(workId,["pending","merged","blocked"]).filter(item=>item.subscriptionId===subscription.subscriptionId);
        if(row.catch_up_policy!=="skip" && pending.length>=subscription.maxQueueDepth)break;
        const eventId=newId("event");const skip=row.catch_up_policy==="skip";
        const latest=row.catch_up_policy==="latest";
        const payload=z.record(z.string(),z.unknown()).parse(JSON.parse(row.payload_json));
        const targetKey=this.works.ingress.adapter(subscription.source)?.targetKeyOf({eventType:row.event_type,payload})
          ?? subscription.sourceTarget ?? "default";
        this.works.repo.insertInbox({eventId,dedupeKey:`sub:${subscription.subscriptionId}:src:${row.source_event_id}`,workId,subscriptionId:subscription.subscriptionId,
          source:row.source,sourceEventId:row.source_event_id,eventType:row.event_type,sourceVersion:row.source_version ?? undefined,causalEventId:row.causal_event_id ?? undefined,
          intentRevision:work.intentRevision,stateVersion:work.stateVersion,ownerEpoch:work.ownerEpoch,status:skip?"skipped":latest?"merged":"pending",mergedCount:1,
          payload:latest?{authoritativeReadbackRequired:true}:payload,receivedAt:row.received_at,targetKey,
          processAfter:latest?Math.min(now,row.received_at+subscription.maxMergeWaitMs):undefined,processedAt:skip?now:undefined});
        if (rust) {
          const pausedPk = `${row.source}\0${row.source_event_id}\0${subscription.subscriptionId}`;
          overlayMutate(this.db, "work_paused_source_routes", pausedPk, () => undefined,
            cur => cur ? { ...cur, inbox_event_id: eventId } : cur);
          enqueueWorkOp(this.db, {
            op: "workPausedSourceRouteWrite", source: row.source, sourceEventId: row.source_event_id,
            subscriptionId: subscription.subscriptionId, catchUpPolicy: row.catch_up_policy, inboxEventId: eventId,
          });
          overlayMutate(this.db, "work_ingress_routes", pausedPk, () =>
            this.db.prepare("SELECT * FROM work_ingress_routes WHERE source=? AND source_event_id=? AND subscription_id=?")
              .get(row.source, row.source_event_id, subscription.subscriptionId) as Record<string, unknown> | undefined,
          cur => cur ? { ...cur, inbox_event_id: eventId, state: skip ? "skipped" : latest ? "merged" : "accepted", reason_code: "paused-backlog-refill" } : cur);
          enqueueWorkOp(this.db, {
            op: "workIngressRouteWrite", mode: "pausedBacklogUpdate", source: row.source, sourceEventId: row.source_event_id,
            subscriptionId: subscription.subscriptionId, workId: null, targetKey: null, inboxEventId: eventId,
            state: skip ? "skipped" : latest ? "merged" : "accepted", reasonCode: "paused-backlog-refill",
            sourceVersion: null, trust: null, acceptedAt: null,
          });
        } else {
          this.db.prepare("UPDATE work_paused_source_routes SET inbox_event_id=? WHERE source=? AND source_event_id=? AND subscription_id=?").run(eventId,row.source,row.source_event_id,subscription.subscriptionId);
          this.db.prepare(`UPDATE work_ingress_routes SET inbox_event_id=?,state=?,reason_code='paused-backlog-refill'
            WHERE source=? AND source_event_id=? AND subscription_id=?`).run(eventId,skip?"skipped":latest?"merged":"accepted",
            row.source,row.source_event_id,subscription.subscriptionId);
        }
        changed=true;
      }
    }
    if (this.works.ingress.reconcileBackpressure(workId, now)) changed = true;
    if(changed){const latest=this.works.getWork(workId)!;this.works.repo.updateWork({...latest,stateVersion:latest.stateVersion+1,updatedAt:now});this.works.emitCurrentProjection(workId);}
  }
  /** Called in resume's control transaction. Latest queues an authoritative read, not the last arrival payload. */
  resume(work: WorkDto, now: number): void {
    if (!workDomainInTx(this.db)) throw new Error("恢复积压必须与恢复控制同事务提交");
    const rust = requiresWorkRustWrites(this.db);
    for(const event of this.works.repo.listInbox(work.workId,["blocked"])) if(event.payload._sourceReadbackError) {
      this.works.repo.setInboxStatus(event.eventId,"pending");this.works.repo.clearBlocker(`source-readback:${event.eventId}`,work.workId,now);
    }
    for (const subscription of this.works.repo.listSubscriptions(work.workId)) {
      const dbPaused = this.db.prepare("SELECT * FROM work_events_inbox WHERE work_id=? AND queued_while_paused=1")
        .all(work.workId) as Array<Record<string, unknown>>;
      const pausedIds = new Set(overlayFindAll(this.db, "work_events_inbox", dbPaused, r => String(r.event_id),
        r => r.work_id === work.workId && Number(r.queued_while_paused ?? 0) === 1).map(row => String(row.event_id)));
      const queued = this.works.repo.listInbox(work.workId,["pending","merged"]).filter(event => event.subscriptionId === subscription.subscriptionId && pausedIds.has(event.eventId));
      if (!queued.length) continue;
      if (subscription.catchUpPolicy === "skip") for (const event of queued) this.works.repo.setInboxStatus(event.eventId,"skipped",now);
      else if (subscription.catchUpPolicy === "latest") {
        const targets = new Map<string, WorkInboxEventDto[]>();
        for (const event of queued) {
          const target = event.targetKey ?? "default";
          const group = targets.get(target) ?? [];
          group.push(event); targets.set(target, group);
        }
        for (const [target, group] of targets) {
          const first = group[0];
          const deadline = Math.min(now + subscription.maxMergeWaitMs, first.receivedAt + subscription.maxMergeWaitMs);
          const sourceVersion = this.works.ingress.cursor(subscription.subscriptionId, subscription.source, target)?.highestAcceptedVersion;
          const payloadJson = JSON.stringify({ authoritativeReadbackRequired: true, pausedEventIds: group.map(event => event.eventId),
            source: subscription.source, target });
          const resolvedVersion = sourceVersion ?? first.sourceVersion ?? null;
          const batchId = `paused:${subscription.subscriptionId}:${target}:${first.eventId}`;
          if (rust) {
            overlayMutate(this.db, "work_events_inbox", first.eventId, () =>
              this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(first.eventId) as Record<string, unknown> | undefined,
            cur => cur ? {
              ...cur, payload_json: payloadJson, status: "merged", merge_deadline_at: deadline,
              merged_count: group.length, target_key: target, source_version: resolvedVersion,
              batch_id: batchId, batch_deadline_at: deadline, claim_version: Number(cur.claim_version ?? 0) + 1,
            } : cur);
            enqueueWorkOp(this.db, {
              op: "workInboxUpdate", mode: "mergePausedLatest", eventId: first.eventId,
              subscriptionId: null, workId: null, eventType: null, sourceVersion: resolvedVersion,
              causalEventId: null, payloadJson, status: null, mergeDeadlineAt: deadline,
              mergedCount: group.length, targetKey: target, batchId, batchDeadlineAt: deadline, now: null,
            });
          } else {
            this.db.prepare(`UPDATE work_events_inbox SET payload_json=?,status='merged',merge_deadline_at=?,merged_count=?,
              target_key=?,source_version=?,batch_id=?,batch_deadline_at=?,claim_version=claim_version+1 WHERE event_id=?`)
              .run(payloadJson, deadline, group.length, target, resolvedVersion, batchId, deadline, first.eventId);
          }
          for (const event of group) {
            if (rust) {
              const pk = `${event.source}\0${event.sourceEventId}\0${subscription.subscriptionId}`;
              overlayMutate(this.db, "work_ingress_routes", pk, () =>
                this.db.prepare("SELECT * FROM work_ingress_routes WHERE source=? AND source_event_id=? AND subscription_id=?")
                  .get(event.source, event.sourceEventId, subscription.subscriptionId) as Record<string, unknown> | undefined,
              cur => cur ? { ...cur, inbox_event_id: first.eventId, state: "merged", reason_code: "paused-latest" } : cur);
              enqueueWorkOp(this.db, {
                op: "workIngressRouteWrite", mode: "pausedBacklogUpdate", source: event.source, sourceEventId: event.sourceEventId,
                subscriptionId: subscription.subscriptionId, workId: null, targetKey: null, inboxEventId: first.eventId,
                state: "merged", reasonCode: "paused-latest", sourceVersion: null, trust: null, acceptedAt: null,
              });
            } else {
              this.db.prepare(`UPDATE work_ingress_routes SET inbox_event_id=?,state='merged',reason_code='paused-latest'
                WHERE source=? AND source_event_id=? AND subscription_id=?`).run(first.eventId,event.source,event.sourceEventId,subscription.subscriptionId);
            }
          }
          for (const event of group.slice(1)) this.works.repo.setInboxStatus(event.eventId,"skipped",now);
        }
      }
      if (rust) {
        const dbSub = this.db.prepare("SELECT * FROM work_events_inbox WHERE work_id=? AND subscription_id=?")
          .all(work.workId, subscription.subscriptionId) as Array<Record<string, unknown>>;
        for (const row of overlayFindAll(this.db, "work_events_inbox", dbSub, r => String(r.event_id),
          r => r.work_id === work.workId && r.subscription_id === subscription.subscriptionId)) {
          overlaySet(this.db, "work_events_inbox", String(row.event_id), { ...row, queued_while_paused: 0 });
        }
        enqueueWorkOp(this.db, {
          op: "workInboxUpdate", mode: "clearQueuedWhilePaused", eventId: null,
          subscriptionId: subscription.subscriptionId, workId: work.workId, eventType: null,
          sourceVersion: null, causalEventId: null, payloadJson: null, status: null,
          mergeDeadlineAt: null, mergedCount: null, targetKey: null, batchId: null, batchDeadlineAt: null, now: null,
        });
      } else {
        this.db.prepare("UPDATE work_events_inbox SET queued_while_paused=0 WHERE work_id=? AND subscription_id=?").run(work.workId,subscription.subscriptionId);
      }
    }
  }
  due(workId: string, now: number): WorkInboxEventDto[] {
    if (this.works.getWork(workId)?.lifecycle !== "active") return [];
    return this.works.repo.listInbox(workId,["pending","merged"]).filter(event => event.status === "pending" || (event.processAfter ?? 0) <= now);
  }
  count(workId: string): number { return this.works.repo.listInbox(workId,["pending","merged","blocked"]).length; }
  /** readCurrent performs real source I/O outside SQLite; apply is a trusted host CAS consumer. */
  async consume<T>(eventId: string, readCurrent: (event: WorkInboxEventDto) => Promise<T>, apply: (work: WorkDto, event: WorkInboxEventDto, current: T) => void,
    isActive: () => boolean = () => true): Promise<{ ok: boolean; message?: string }> {
    if (!isActive()) return { ok: false, message: "来源读取宿主已失效，保留原事件" };
    const event = this.works.repo.getInbox(eventId); const before = event && this.works.getWork(event.workId);
    if (!event || !before || before.lifecycle !== "active") return { ok: false, message: "事项尚未恢复或事件不存在" };
    if (event.status === "processed") return { ok: true };
    const current = await readCurrent(event);
    // The host may have closed SQLite while an uncooperative reader was pending.
    // Test lifecycle/authority before opening a transaction or reading any row.
    if (!isActive()) return { ok: false, message: "来源读取宿主已失效，保留原事件" };
    return this.works.transaction(() => {
      if (!isActive()) return { ok: false, message: "来源读取宿主已失效，保留原事件" };
      const latest = this.works.getWork(before.workId);
      if (!latest || latest.lifecycle !== "active" || latest.stateVersion !== before.stateVersion || latest.ownerEpoch !== before.ownerEpoch
        || latest.ownerBotId !== before.ownerBotId || latest.intentRevision !== before.intentRevision || latest.inputSnapshotId !== before.inputSnapshotId)
        return { ok: false, message: "读取期间事项或负责人变化，保留原事件重读" };
      const stored = this.works.repo.getInbox(eventId);
      if (!stored || stored.status === "processed") return { ok: true };
      if (!["pending","merged"].includes(stored.status)) return { ok: false, message: "事件不可消费" };
      if (!sameSourceReadbackClaim(event, stored))
        return { ok: false, message: "读取期间事件批次已变化，保留最新批次重新回读" };
      apply(latest,stored,current);
      this.works.ingress.markConsumed(eventId, { providerSourceVersion: stored.payload.authoritativeReadbackRequired
        ? undefined : stored.sourceVersion });
      return { ok: true };
    });
  }
}
