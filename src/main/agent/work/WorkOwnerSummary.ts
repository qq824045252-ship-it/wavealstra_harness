import type Database from "better-sqlite3";
import { z } from "zod";
import type { ExpectedVersionGuard, WorkActor, WorkDto } from "../../../shared/bot-work";
import { canonicalJson } from "../../../shared/bot-work-phase5";
import { collectOwnerSummaryFacts, renderOwnerSummary, type WorkOwnerSummaryFacts } from "./WorkOwnerSummaryFacts";
import type { WorkService } from "./WorkService";

/** A persisted first-fact deadline, not a sliding debounce. Host scans also run on startup. */
export const OWNER_SUMMARY_MAX_WAIT_MS = 15_000;
export const OWNER_SUMMARY_SCAN_LIMIT = 100;
const watermarkSchema = z.object({
  version: z.literal(1), managed: z.literal(true), intentRevision: z.number(), inputSnapshotId: z.string(),
  ownerBotId: z.string(), ownerEpoch: z.number(), observedStateVersion: z.number(), observedDigest: z.string(),
  pendingSince: z.number().optional(), deadlineAt: z.number().optional(), publishReady: z.boolean(),
  publishedDigest: z.string().optional(), publishedCardKey: z.string().optional(),
  handledKeys: z.array(z.string()), handledDecisionKeys: z.array(z.string()), authorizationExpired: z.boolean(),
}).strict();
type Watermark = z.infer<typeof watermarkSchema>;
const rowSchema = z.object({ digest: z.string(), card_key: z.string().nullable(), handled_watermark_json: z.string() });
type Row = z.infer<typeof rowSchema>;
export interface OwnerSummaryPublishResult { ok: boolean; changed?: boolean; cardKey?: string; code?: string; message?: string; }

/**
 * One current owner's derived notification over existing member facts. It neither owns
 * Work control nor decides acceptance. Watermarks, semantic card and intent commit in
 * the same SQLite transaction; retries only revisit that durable obligation.
 */
export class WorkOwnerSummary {
  constructor(private readonly db: Database.Database, private readonly works: WorkService, private readonly now: () => number) {}

  isManaged(work: WorkDto): boolean {
    return Boolean(this.watermark(this.row(work.workId))?.managed) || collectOwnerSummaryFacts(this.works, work, this.now()).managed;
  }

  pendingDecisions(work: WorkDto): string[] {
    const facts = collectOwnerSummaryFacts(this.works, work, this.now());
    if (!facts.managed && !this.watermark(this.row(work.workId))?.managed) return [];
    return facts.payload.items.filter(item => facts.payload.pendingDecisionKeys.includes(item.key)).map(item => item.text);
  }

  /** Observe after a member/acceptance/blocker transaction; publication is coalesced by the host. */
  observe(workId: string, now = this.now()): boolean {
    this.assertAuthority();
    return this.works.transaction(() => {
      this.assertAuthority();
      const work = this.works.getWork(workId);
      if (!work) return false;
      return Boolean(this.prepare(work, now));
    });
  }

  /** Owner decisions carry the same full version fence as all other owner controls. */
  publish(actor: WorkActor, input: { workId: string; versionGuard: Required<ExpectedVersionGuard> }): OwnerSummaryPublishResult {
    this.assertAuthority();
    const result = this.works.transaction((): OwnerSummaryPublishResult => {
      this.assertAuthority();
      const work = this.works.getWork(input.workId);
      const resolved = this.works.resolveWorkActor(actor);
      if (!work || typeof resolved === "string") return { ok: false, code: "not_found", message: "找不到可汇总事项" };
      if (resolved.kind !== "bot" || resolved.bot?.botId !== work.ownerBotId || resolved.userId !== work.userId)
        return { ok: false, code: "unauthorized_actor", message: "只有当前主负责人可以提交团队汇总" };
      if (input.versionGuard.expectedOwnerEpoch !== work.ownerEpoch)
        return { ok: false, code: "epoch_mismatch", message: "负责人代次已改变，旧汇总决定失效" };
      if (input.versionGuard.expectedStateVersion !== work.stateVersion || input.versionGuard.expectedIntentRevision !== work.intentRevision)
        return { ok: false, code: "version_conflict", message: "事项事实已改变，请重新读取后汇总" };
      return this.publishCurrent(work, this.now());
    });
    if (result.changed) this.works.emitCurrentProjection(input.workId, { force: true });
    return result;
  }

  /** Bounded durable discovery includes native results even when the original wake was lost. */
  flush(now = this.now()): number {
    this.assertAuthority();
    const rows = this.db.prepare(`SELECT w.work_id FROM works w
      LEFT JOIN work_owner_summaries s ON s.work_id=w.work_id
      WHERE (w.lifecycle!='closed' OR w.closure_conclusion='succeeded') AND (
        json_extract(s.handled_watermark_json,'$.ownerNotification.managed')=1
        OR EXISTS (SELECT 1 FROM work_participants p WHERE p.work_id=w.work_id AND p.bot_id!=w.owner_bot_id AND p.role!='watcher')
        OR EXISTS (SELECT 1 FROM work_execution_bindings b WHERE b.work_id=w.work_id AND b.bot_id!=w.owner_bot_id
          AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL)
        OR (SELECT COUNT(*) FROM work_subitem_results r JOIN work_execution_bindings b ON b.binding_id=r.binding_id
          WHERE r.work_id=w.work_id AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id)>1
      ) AND (
        COALESCE(json_extract(s.handled_watermark_json,'$.ownerNotification.observedStateVersion'),-1)!=w.state_version
        OR COALESCE(json_extract(s.handled_watermark_json,'$.ownerNotification.ownerEpoch'),-1)!=w.owner_epoch
        OR json_extract(s.handled_watermark_json,'$.ownerNotification.deadlineAt')<=?
        OR (json_extract(s.handled_watermark_json,'$.ownerNotification.pendingSince') IS NOT NULL
          AND json_extract(s.handled_watermark_json,'$.ownerNotification.publishReady')=1)
        OR (json_extract(w.authorization_json,'$.expiresAt')<=?
          AND COALESCE(json_extract(s.handled_watermark_json,'$.ownerNotification.authorizationExpired'),0)=0)
      ) ORDER BY COALESCE(json_extract(s.handled_watermark_json,'$.ownerNotification.deadlineAt'),w.updated_at),w.work_id LIMIT ?`)
      .all(now, now, OWNER_SUMMARY_SCAN_LIMIT) as Array<{ work_id: string }>;
    let changed = 0;
    for (const row of rows) {
      this.assertAuthority();
      const result = this.works.transaction((): OwnerSummaryPublishResult => {
        this.assertAuthority();
        const current = this.works.getWork(row.work_id);
        return current ? this.publishCurrent(current, now) : { ok: false };
      });
      if (result.changed) {
        changed += 1;
        this.works.emitCurrentProjection(row.work_id, { force: true });
      }
    }
    return changed;
  }

  /** Delivery may reconcile old effects, but a new send needs this exact current outcome. */
  isCurrent(work: WorkDto, cardKey: string | undefined): boolean {
    if (!cardKey || work.lifecycle === "closed" && work.closureConclusion !== "succeeded") return false;
    const current = this.works.getWork(work.workId);
    if (!current || current.ownerBotId !== work.ownerBotId || current.ownerEpoch !== work.ownerEpoch
      || current.intentRevision !== work.intentRevision || current.inputSnapshotId !== work.inputSnapshotId) return false;
    const state = this.watermark(this.row(work.workId));
    if (state?.publishedCardKey !== cardKey) return false;
    const card = this.db.prepare(`SELECT kind,intent_revision,input_snapshot_id,canonical_outcome_hash
      FROM work_result_cards WHERE card_key=? AND work_id=?`).get(cardKey, work.workId) as {
        kind: string; intent_revision: number; input_snapshot_id: string; canonical_outcome_hash: string;
      } | undefined;
    return Boolean(card?.kind === "owner_summary" && card.intent_revision === work.intentRevision
      && card.input_snapshot_id === work.inputSnapshotId
      && card.canonical_outcome_hash === collectOwnerSummaryFacts(this.works, current, this.now()).digest);
  }

  /** Exposes the next persisted deadline so a host may schedule sooner than its periodic scan. */
  nextDeadline(): number | undefined {
    const row = this.db.prepare(`SELECT MIN(json_extract(handled_watermark_json,'$.ownerNotification.deadlineAt')) AS deadline
      FROM work_owner_summaries`).get() as { deadline: number | null };
    return row.deadline ?? undefined;
  }

  private prepare(work: WorkDto, now: number): { state: Watermark; facts: WorkOwnerSummaryFacts } | undefined {
    const row = this.row(work.workId);
    const previous = this.watermark(row);
    const facts = collectOwnerSummaryFacts(this.works, work, now);
    if (!previous?.managed && !facts.managed) return undefined;
    const sameInput = previous?.intentRevision === work.intentRevision && previous.inputSnapshotId === work.inputSnapshotId;
    const state: Watermark = {
      version: 1, managed: true, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
      ownerBotId: work.ownerBotId, ownerEpoch: work.ownerEpoch, observedStateVersion: work.stateVersion, observedDigest: facts.digest,
      publishedCardKey: previous?.publishedCardKey, publishedDigest: sameInput ? previous?.publishedDigest : undefined,
      handledKeys: sameInput ? previous?.handledKeys ?? [] : [],
      handledDecisionKeys: sameInput ? previous?.handledDecisionKeys ?? [] : [],
      authorizationExpired: work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now,
      publishReady: facts.ready || facts.urgentDecisionKeys.some(key => !previous?.handledDecisionKeys.includes(key)),
    };
    if (facts.hasSubstance && facts.digest !== state.publishedDigest
      && (work.lifecycle !== "closed" || work.closureConclusion === "succeeded")) {
      // Only the first observation fixes the deadline. Later results, retries and handoff
      // can change the outcome but never postpone the existing user's obligation.
      state.pendingSince = sameInput && previous?.pendingSince !== undefined ? previous.pendingSince
        : previous?.publishedDigest ? now : Math.min(now, facts.firstFactAt);
      state.deadlineAt = state.pendingSince + OWNER_SUMMARY_MAX_WAIT_MS;
    }
    if (!previous || canonicalJson(previous) !== canonicalJson(state)) this.save(work, row, state, facts, now);
    return { state, facts };
  }

  private publishCurrent(work: WorkDto, now: number): OwnerSummaryPublishResult {
    const prepared = this.prepare(work, now);
    if (!prepared) return { ok: true, changed: false };
    const { state, facts } = prepared;
    const urgent = facts.urgentDecisionKeys.some(key => !state.handledDecisionKeys.includes(key));
    if (state.pendingSince === undefined || !(facts.ready || urgent || state.deadlineAt! <= now))
      return { ok: true, changed: false, cardKey: state.publishedCardKey };
    // The caller selected this owner inside the same immediate transaction. Re-read before
    // writing; stale owner callbacks cannot replace current responsibility by implication.
    this.assertAuthority();
    const current = this.works.getWork(work.workId);
    if (!current || current.ownerBotId !== work.ownerBotId || current.ownerEpoch !== work.ownerEpoch
      || current.intentRevision !== work.intentRevision || current.inputSnapshotId !== work.inputSnapshotId)
      return { ok: false, code: "epoch_mismatch", message: "汇总提交前负责人或要求已变化" };
    const name = (botId: string) => (this.db.prepare("SELECT display_name FROM bots WHERE bot_id=?").get(botId) as
      { display_name: string } | undefined)?.display_name ?? "协作成员";
    const body = renderOwnerSummary(facts.payload, name);
    const card = this.works.cards.ensure({ work: current, kind: "owner_summary", outcome: facts.outcome,
      title: `${name(current.ownerBotId)}汇总：${current.title}`, summary: body,
      previousCardKey: state.publishedCardKey, provenanceRefs: facts.provenanceRefs,
      unverifiedScope: facts.payload.items.filter(item => facts.payload.pendingDecisionKeys.includes(item.key)).map(item => item.text), now });
    const inserted = this.works.repo.insertNotification({
      notificationId: `notification-${current.workId}-summary-${card.semanticCardKey}`,
      workId: current.workId, semanticKey: `work:${current.workId}:summary:${card.semanticCardKey}`,
      kind: "summary", title: card.title, body, stateVersion: current.stateVersion,
      intentRevision: current.intentRevision, delivery: "pending", createdAt: now, attemptCount: 0, cardKey: card.cardKey,
    });
    state.publishedDigest = facts.digest;
    state.publishedCardKey = card.cardKey;
    state.handledKeys = facts.handledKeys;
    state.handledDecisionKeys = facts.payload.pendingDecisionKeys;
    delete state.pendingSince;
    delete state.deadlineAt;
    this.save(current, this.row(current.workId), state, facts, now);
    return { ok: true, changed: inserted, cardKey: card.cardKey };
  }

  private save(work: WorkDto, row: Row | undefined, state: Watermark, facts: WorkOwnerSummaryFacts, now: number): void {
    if (!this.db.inTransaction) throw new Error("负责人汇总水位必须与 Work 事实同事务提交");
    this.assertAuthority();
    const handled = row ? z.record(z.string(), z.unknown()).parse(JSON.parse(row.handled_watermark_json)) : {};
    this.db.prepare(`INSERT INTO work_owner_summaries(work_id,intent_revision,input_snapshot_id,owner_epoch,digest,card_key,
      pending_decision_codes_json,handled_watermark_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(work_id) DO UPDATE SET intent_revision=excluded.intent_revision,input_snapshot_id=excluded.input_snapshot_id,
      owner_epoch=excluded.owner_epoch,digest=excluded.digest,card_key=excluded.card_key,
      pending_decision_codes_json=excluded.pending_decision_codes_json,handled_watermark_json=excluded.handled_watermark_json,updated_at=excluded.updated_at`)
      .run(work.workId, work.intentRevision, work.inputSnapshotId, work.ownerEpoch, row?.digest ?? facts.digest,
        state.publishedCardKey ?? row?.card_key ?? null, JSON.stringify(facts.payload.pendingDecisionKeys),
        JSON.stringify({ ...handled, ownerNotification: state }), now);
  }
  private row(workId: string): Row | undefined {
    return rowSchema.optional().parse(this.db.prepare("SELECT * FROM work_owner_summaries WHERE work_id=?").get(workId));
  }
  private watermark(row: Row | undefined): Watermark | undefined {
    return row ? watermarkSchema.optional().parse((JSON.parse(row.handled_watermark_json) as Record<string, unknown>).ownerNotification) : undefined;
  }
  private assertAuthority(): void { this.works.collaboration.assertAuthority(); }
}
