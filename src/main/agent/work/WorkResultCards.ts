import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type {
  WorkBlockerDto, WorkDeliverableDto, WorkDto,
} from "../../../shared/bot-work";
import {
  canonicalJson, semanticCardTuple, type WorkCardReadResult, type WorkCardCurrency,
  type WorkOutcomePayload, type WorkResultCardDto, type WorkResultCardKind,
  type WorkUnverifiedScopeDto, type WorkUnverifiedReason,
} from "../../../shared/bot-work-phase5";
import type { WorkRepository } from "./WorkRepository";

const cardRowSchema = z.object({
  card_key: z.string(), semantic_card_key: z.string(), work_id: z.string(), user_id: z.string(),
  kind: z.enum(["accepted_result", "closure_succeeded", "closure_cancelled", "closure_failed", "blocked_escalation"]),
  intent_revision: z.number(), input_snapshot_id: z.string(), origin_owner_epoch: z.number(),
  canonical_outcome_hash: z.string(), canonical_outcome_json: z.string(), title: z.string(), summary: z.string(),
  deliverable_ids_json: z.string(), evidence_ids_json: z.string(), source_refs_json: z.string(),
  artifact_refs_json: z.string(), unverified_scope_json: z.string(), created_at: z.number(),
  read_at: z.number().nullable(), read_by_user_id: z.string().nullable(),
  read_version: z.number(),
});
type CardRow = z.infer<typeof cardRowSchema>;

const summaryRowSchema = z.object({
  work_id: z.string(), intent_revision: z.number(), input_snapshot_id: z.string(), owner_epoch: z.number(),
  digest: z.string(), card_key: z.string().nullable(), pending_decision_codes_json: z.string(),
  handled_watermark_json: z.string(), updated_at: z.number(),
});

const jsonList = (value: string): string[] => z.array(z.string()).parse(JSON.parse(value));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const listText = (values: ReadonlyArray<string>): string => JSON.stringify([...new Set(values)].sort());

/** Blockers that must reach the user; internal retries/backoff stay in the diagnostics ledger. */
export function pendingDecisionBlockers(blockers: WorkBlockerDto[]): WorkBlockerDto[] {
  return blockers.filter(blocker => blocker.status === "open"
    && (blocker.waitingForUserInput || blocker.kind === "external_effect"));
}

/**
 * Writes the stable semantic card inside the caller's acceptance transaction.
 *
 * One substantive outcome owns exactly one card: the caller's transaction either commits
 * the acceptance fact and its card together or rolls back both. Replays land on the same
 * semantic key, so a re-observed result cannot mint a second card.
 */
export class WorkResultCards {
  constructor(private readonly db: Database.Database, private readonly repo: WorkRepository) {}

  // ------------------------------------------------------------- identities

  static computeSemanticKey(input: {
    workId: string; intentRevision: number; inputSnapshotId: string;
    kind: WorkResultCardKind; canonicalOutcomeHash: string;
  }): string {
    return digest(semanticCardTuple(input));
  }

  static computeOutcomeHash(outcome: WorkOutcomePayload): string {
    return digest(canonicalJson(outcome));
  }

  /** Canonical outcome for an acceptance fact; wording and clocks never enter it. */
  static acceptedOutcome(work: WorkDto, deliverables: WorkDeliverableDto[], kind: WorkResultCardKind = "accepted_result"): WorkOutcomePayload {
    const current = deliverables.filter(deliverable => deliverable.status === "accepted"
      && deliverable.intentRevision === work.intentRevision && deliverable.inputSnapshotId === work.inputSnapshotId);
    return {
      version: 1, kind, workId: work.workId, intentRevision: work.intentRevision,
      inputSnapshotId: work.inputSnapshotId,
      deliverables: current.map(deliverable => ({
        deliverableId: deliverable.deliverableId,
        artifactRefs: [...deliverable.artifactRefs].sort(),
        evidenceRefs: [...deliverable.evidenceRefs].sort(),
        uncoveredCriterionIds: [...deliverable.uncoveredCriterionIds].sort(),
      })).sort((left, right) => left.deliverableId.localeCompare(right.deliverableId)),
      criteria: work.criteria.map(criterion => ({ id: criterion.id, status: criterion.status,
        requiredIntentRevision: criterion.requiredIntentRevision,
        evidenceRefs: [...criterion.evidenceRefs].sort() })).sort((left, right) => left.id.localeCompare(right.id)),
      sourceRefs: [...new Set(work.goalSources.map(source => source.sourceRef))].sort(),
      artifactRefs: [...new Set(current.flatMap(deliverable => deliverable.artifactRefs))].sort(),
      pendingBlockerCodes: [],
    };
  }

  /** Canonical outcome for a closure. A successful close of unchanged accepted facts
   * reuses the acceptance outcome, so accepted→closed never mints a second card. */
  static closureOutcome(work: WorkDto, deliverables: WorkDeliverableDto[],
    conclusion: NonNullable<WorkDto["closureConclusion"]>): WorkOutcomePayload {
    const current = deliverables.filter(deliverable => deliverable.status === "accepted"
      && deliverable.intentRevision === work.intentRevision && deliverable.inputSnapshotId === work.inputSnapshotId);
    if (conclusion === "succeeded" && current.length > 0) return WorkResultCards.acceptedOutcome(work, deliverables);
    const kind: WorkResultCardKind = conclusion === "cancelled" ? "closure_cancelled"
      : conclusion === "succeeded" ? "closure_succeeded" : "closure_failed";
    return { ...WorkResultCards.acceptedOutcome(work, deliverables, kind), conclusion };
  }

  /** A blocker that needs a human decision is substantive; internal retries are not. */
  static escalationOutcome(work: WorkDto, blockers: WorkBlockerDto[]): WorkOutcomePayload {
    return {
      version: 1, kind: "blocked_escalation", workId: work.workId, intentRevision: work.intentRevision,
      inputSnapshotId: work.inputSnapshotId, deliverables: [],
      criteria: work.criteria.map(criterion => ({ id: criterion.id, status: criterion.status,
        requiredIntentRevision: criterion.requiredIntentRevision,
        evidenceRefs: [...criterion.evidenceRefs].sort() })).sort((left, right) => left.id.localeCompare(right.id)),
      sourceRefs: [...new Set(work.goalSources.map(source => source.sourceRef))].sort(),
      artifactRefs: [],
      pendingBlockerCodes: [...new Set(blockers.map(blocker => blocker.reasonCode ?? blocker.kind))].sort(),
    };
  }

  /** The card that already records this requirement's confirmed result, if any. */
  latestAcceptedCard(work: WorkDto): WorkResultCardDto | undefined {
    return this.list(work).filter(card => card.kind === "accepted_result" && card.currency !== "historical").at(-1);
  }

  // ---------------------------------------------------------------- writing

  /**
   * Ensure the card for this outcome exists and return it. Called only inside a Work
   * transaction; a duplicate key means the outcome is already recorded.
   */
  ensure(input: {
    work: WorkDto;
    kind: WorkResultCardKind;
    outcome: WorkOutcomePayload;
    summary: string;
    title: string;
    unverifiedScope: string[];
    now: number;
  }): WorkResultCardDto {
    const outcomeHash = WorkResultCards.computeOutcomeHash(input.outcome);
    // Same substantive outcome for the same requirement is one card, even across
    // accepted→closed: only new substance may create a second card.
    const existing = this.db.prepare(`SELECT * FROM work_result_cards
      WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND canonical_outcome_hash=?
      ORDER BY created_at ASC LIMIT 1`)
      .get(input.work.workId, input.work.intentRevision, input.work.inputSnapshotId, outcomeHash) as CardRow | undefined;
    if (existing) return this.toDto(cardRowSchema.parse(existing), input.work);

    const semanticKey = WorkResultCards.computeSemanticKey({ workId: input.work.workId,
      intentRevision: input.work.intentRevision, inputSnapshotId: input.work.inputSnapshotId,
      kind: input.kind, canonicalOutcomeHash: outcomeHash });
    const cardKey = `card:${semanticKey}`;
    const deliverableIds = input.outcome.deliverables.map(deliverable => deliverable.deliverableId);
    this.db.prepare(`INSERT OR IGNORE INTO work_result_cards (
      card_key,semantic_card_key,work_id,user_id,kind,intent_revision,input_snapshot_id,origin_owner_epoch,
      canonical_outcome_hash,canonical_outcome_json,title,summary,deliverable_ids_json,evidence_ids_json,
      source_refs_json,artifact_refs_json,unverified_scope_json,created_at,read_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      cardKey, semanticKey, input.work.workId, input.work.userId, input.kind, input.work.intentRevision,
      input.work.inputSnapshotId, input.work.ownerEpoch, outcomeHash, canonicalJson(input.outcome),
      input.title, input.summary, listText(deliverableIds),
      listText(input.outcome.criteria.flatMap(criterion => criterion.evidenceRefs)),
      listText(input.outcome.sourceRefs), listText(input.outcome.artifactRefs),
      listText(input.unverifiedScope), input.now,
    );
    const row = this.db.prepare("SELECT * FROM work_result_cards WHERE card_key=?").get(cardKey);
    return this.toDto(cardRowSchema.parse(row), input.work);
  }

  /** Persisted owner summary watermark; the digest is what prevents repeated summaries. */
  /** Open blockers that still need a human decision (stable, deduplicated view). */
  pendingDecisions(workId: string): WorkBlockerDto[] {
    return pendingDecisionBlockers(this.repo.listBlockers(workId));
  }

  refreshSummary(work: WorkDto, now: number): { digest: string; cardKey?: string; pendingDecisionCodes: string[] } {
    const cards = this.list(work);
    const current = cards.filter(card => card.currency === "current");
    const blockers = pendingDecisionBlockers(this.repo.listBlockers(work.workId));
    const pendingDecisionCodes = blockers.map(blocker => blocker.reasonCode ?? blocker.kind);
    const substantive = {
      workId: work.workId, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
      outcomes: current.map(card => card.canonicalOutcomeHash).sort(),
      openBlockerCodes: pendingDecisionCodes.slice().sort(),
      acceptedDeliverableIds: [...work.acceptedDeliverableIds].sort(),
    };
    const summaryDigest = digest(canonicalJson(substantive));
    const cardKey = current.at(-1)?.cardKey;
    const existing = summaryRowSchema.optional().parse(
      this.db.prepare("SELECT * FROM work_owner_summaries WHERE work_id=?").get(work.workId));
    if (!existing || existing.digest !== summaryDigest) {
      this.db.prepare(`INSERT INTO work_owner_summaries (work_id,intent_revision,input_snapshot_id,owner_epoch,digest,
        card_key,pending_decision_codes_json,handled_watermark_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET
        intent_revision=excluded.intent_revision, input_snapshot_id=excluded.input_snapshot_id,
        owner_epoch=excluded.owner_epoch, digest=excluded.digest, card_key=excluded.card_key,
        pending_decision_codes_json=excluded.pending_decision_codes_json,
        handled_watermark_json=excluded.handled_watermark_json, updated_at=excluded.updated_at`)
        .run(work.workId, work.intentRevision, work.inputSnapshotId, work.ownerEpoch, summaryDigest,
          cardKey ?? null, JSON.stringify([...new Set(pendingDecisionCodes)].sort()),
          JSON.stringify({ cardKeys: current.map(card => card.cardKey), acceptedCount: current.reduce((total, card) => total + card.deliverableIds.length, 0) }),
          now);
    }
    return { digest: summaryDigest, cardKey, pendingDecisionCodes };
  }

  /** Read facts only: no Work control version, ownership, execution or budget change. */
  markRead(input: {
    workId: string; semanticCardKey: string; userId: string; readAt: number;
  }): WorkCardReadResult {
    // The public facade already owns a transaction. Keep the helper atomic as well:
    // independent callers must commit authorization, the read fact, its Journal wake
    // and the returned read version together. Nesting uses a SQLite savepoint.
    return this.db.transaction((): WorkCardReadResult => {
      const row = cardRowSchema.optional().parse(this.db.prepare(
        "SELECT * FROM work_result_cards WHERE work_id=? AND (semantic_card_key=? OR card_key=?)")
        .get(input.workId, input.semanticCardKey, input.semanticCardKey));
      if (!row) return { ok: false, message: "找不到结果卡片" };
      if (row.user_id !== input.userId) return { ok: false, message: "无权标记其他用户的结果卡片" };
      const advanced = this.db.prepare(`UPDATE work_result_cards
        SET read_at=?, read_by_user_id=?, read_version=read_version+1
        WHERE card_key=? AND (read_at IS NULL OR read_at < ?)`)
        .run(input.readAt, input.userId, row.card_key, input.readAt);
      const current = cardRowSchema.parse(this.db.prepare("SELECT * FROM work_result_cards WHERE card_key=?").get(row.card_key));
      return { ok: true, cardKey: row.card_key, semanticCardKey: row.semantic_card_key,
        readAt: current.read_at ?? input.readAt, readVersion: current.read_version, replayed: advanced.changes === 0 };
    }).immediate();
  }

  // ---------------------------------------------------------------- reading

  list(work: WorkDto): WorkResultCardDto[] {
    const rows = this.db.prepare("SELECT * FROM work_result_cards WHERE work_id=? ORDER BY created_at ASC, card_key ASC")
      .all(work.workId) as CardRow[];
    return rows.map(row => this.toDto(cardRowSchema.parse(row), work));
  }

  listByUser(userId: string, limit = 200): WorkResultCardDto[] {
    const rows = this.db.prepare("SELECT * FROM work_result_cards WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
      .all(userId, Math.min(200, Math.max(1, limit))) as CardRow[];
    return rows.map(row => this.toDto(cardRowSchema.parse(row), this.workOf(row.work_id)));
  }

  /** Current approval-based view of what is verified for the artifact in play. */
  unverifiedScope(work: WorkDto, artifactSnapshotId?: string): WorkUnverifiedScopeDto[] {
    return work.criteria.filter(criterion => criterion.status !== "waived").map(criterion => {
      const evidence = criterion.evidenceRefs.map(id => this.repo.getEvidence(id)).filter(item => item !== undefined);
      // sourceSha identifies source code, not the aggregate artifacts: snapshot. Artifact
      // validation reopens criteria and clears their evidence refs when content changes.
      const currentEvidence = evidence.filter(item => item.intentRevision === work.intentRevision
        && item.inputSnapshotId === work.inputSnapshotId);
      const reason: WorkUnverifiedReason = criterion.status === "satisfied" && currentEvidence.length > 0
        ? "auto_verified"
        : criterion.status === "satisfied"
          ? "historical_version_only"
          : criterion.requiresRealEnvironmentCheck
            ? (evidence.length > 0 ? "artifact_changed" : "pending_real_environment")
            : "no_evidence";
      return {
        criterionId: criterion.id, text: criterion.text, reason,
        requiredEnvironment: criterion.requiredEnvironment,
        intentRevision: currentEvidence.at(-1)?.intentRevision ?? evidence.at(-1)?.intentRevision,
        inputSnapshotId: currentEvidence.at(-1)?.inputSnapshotId ?? evidence.at(-1)?.inputSnapshotId,
        artifactSnapshotId,
        evidenceIds: criterion.evidenceRefs,
      };
    });
  }

  private workOf(workId: string): WorkDto {
    const work = this.repo.getWork(workId);
    if (!work) throw new Error(`找不到事项 ${workId}`);
    return work;
  }

  private toDto(row: CardRow, work: WorkDto): WorkResultCardDto {
    const notificationIds = (this.db.prepare("SELECT notification_id FROM work_notifications WHERE card_key=?").all(row.card_key) as Array<{ notification_id: string }>)
      .map(item => item.notification_id);
    return {
      cardKey: row.card_key, semanticCardKey: row.semantic_card_key, workId: row.work_id, userId: row.user_id,
      kind: row.kind, intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id,
      originOwnerEpoch: row.origin_owner_epoch, canonicalOutcomeHash: row.canonical_outcome_hash,
      title: row.title, summary: row.summary,
      deliverableIds: jsonList(row.deliverable_ids_json), evidenceIds: jsonList(row.evidence_ids_json),
      sourceRefs: jsonList(row.source_refs_json), artifactRefs: jsonList(row.artifact_refs_json),
      unverifiedScope: jsonList(row.unverified_scope_json), createdAt: row.created_at,
      currency: this.currencyOf(row, work), readAt: row.read_at ?? undefined,
      readByUserId: row.read_by_user_id ?? undefined, readVersion: row.read_version,
      notificationIds,
    };
  }

  private currencyOf(row: CardRow, work: WorkDto): WorkCardCurrency {
    if (row.intent_revision !== work.intentRevision || row.input_snapshot_id !== work.inputSnapshotId) return "historical";
    const outcome = JSON.parse(row.canonical_outcome_json) as WorkOutcomePayload;
    const superseded = outcome.deliverables.some(item => this.repo.getDeliverable(item.deliverableId)?.status === "superseded");
    return superseded ? "superseded" : "current";
  }
}
