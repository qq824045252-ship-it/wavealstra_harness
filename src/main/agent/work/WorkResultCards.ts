import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { isWorkEffectDiagnostic } from "../../../shared/work-effect-policy";
import type {
  WorkBlockerDto, WorkDeliverableDto, WorkDto,
} from "../../../shared/bot-work";
import {
  canonicalJson, semanticCardTuple, workResultCardKindSchema, workOwnerSummaryPayloadSchema,
  type WorkCardReadResult, type WorkCardCurrency,
  type WorkOutcomePayload, type WorkResultCardDto, type WorkResultCardKind,
  type WorkUnverifiedScopeDto, type WorkUnverifiedReason,
} from "../../../shared/bot-work-phase5";
import type { WorkRepository } from "./WorkRepository";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from "./WorkDomainRuntime";

const cardRowSchema = z.object({
  card_key: z.string(), semantic_card_key: z.string(), work_id: z.string(), user_id: z.string(),
  kind: workResultCardKindSchema, previous_card_key: z.string().nullable(),
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
    && !isWorkEffectDiagnostic(blocker) && blocker.waitingForUserInput);
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
      sourceRefs: [...new Set([...work.goalSources.map(source => source.sourceRef),
        ...(blockers.some(blocker => blocker.sourceRef?.startsWith("user-input:completion:"))
          ? blockers.map(blocker => `work-blocker:${blocker.blockerId}`) : [])])].sort(),
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
    previousCardKey?: string;
    /** Physical source references are traceable, but replay identities do not change the outcome. */
    provenanceRefs?: string[];
    now: number;
  }): WorkResultCardDto {
    const outcomeHash = WorkResultCards.computeOutcomeHash(input.outcome);
    // Same substantive outcome for the same requirement is one card, even across
    // accepted→closed: only new substance may create a second card.
    const dbMatching = this.db.prepare(`SELECT * FROM work_result_cards
      WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND canonical_outcome_hash=?
      ORDER BY created_at ASC`).all(input.work.workId, input.work.intentRevision, input.work.inputSnapshotId, outcomeHash) as Array<Record<string, unknown>>;
    const existing = overlayFindAll(this.db, "work_result_cards", dbMatching, r => String(r.card_key), r =>
      r.work_id === input.work.workId && r.intent_revision === input.work.intentRevision
      && r.input_snapshot_id === input.work.inputSnapshotId && r.canonical_outcome_hash === outcomeHash,
    (a, b) => Number(a.created_at) - Number(b.created_at))[0];
    if (existing) return this.toDto(cardRowSchema.parse(existing), input.work);

    const semanticKey = WorkResultCards.computeSemanticKey({ workId: input.work.workId,
      intentRevision: input.work.intentRevision, inputSnapshotId: input.work.inputSnapshotId,
      kind: input.kind, canonicalOutcomeHash: outcomeHash });
    const cardKey = `card:${semanticKey}`;
    const deliverableIds = input.outcome.deliverables.map(deliverable => deliverable.deliverableId);
    const canonicalOutcomeJson = canonicalJson(input.outcome);
    const deliverableIdsJson = listText(deliverableIds);
    const evidenceIdsJson = listText(input.outcome.criteria.flatMap(criterion => criterion.evidenceRefs));
    const sourceRefsJson = listText([...input.outcome.sourceRefs, ...input.provenanceRefs ?? []]);
    const artifactRefsJson = listText(input.outcome.artifactRefs);
    const unverifiedScopeJson = listText(input.unverifiedScope);
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_result_cards", cardKey, () =>
        this.db.prepare("SELECT * FROM work_result_cards WHERE card_key=?").get(cardKey) as Record<string, unknown> | undefined,
      cur => cur ?? {
        card_key: cardKey, semantic_card_key: semanticKey, work_id: input.work.workId, user_id: input.work.userId,
        kind: input.kind, intent_revision: input.work.intentRevision, input_snapshot_id: input.work.inputSnapshotId,
        origin_owner_epoch: input.work.ownerEpoch, canonical_outcome_hash: outcomeHash,
        canonical_outcome_json: canonicalOutcomeJson, title: input.title, summary: input.summary,
        deliverable_ids_json: deliverableIdsJson, evidence_ids_json: evidenceIdsJson,
        source_refs_json: sourceRefsJson, artifact_refs_json: artifactRefsJson,
        unverified_scope_json: unverifiedScopeJson, created_at: input.now,
        previous_card_key: input.previousCardKey ?? null, read_at: null, read_by_user_id: null, read_version: 0,
      });
      enqueueWorkOp(this.db, {
        op: "workResultCardInsert", cardKey, semanticCardKey: semanticKey, workId: input.work.workId,
        userId: input.work.userId, kind: input.kind, intentRevision: input.work.intentRevision,
        inputSnapshotId: input.work.inputSnapshotId, originOwnerEpoch: input.work.ownerEpoch,
        canonicalOutcomeHash: outcomeHash, canonicalOutcomeJson, title: input.title, summary: input.summary,
        deliverableIdsJson, evidenceIdsJson, sourceRefsJson, artifactRefsJson, unverifiedScopeJson,
        createdAt: input.now, previousCardKey: input.previousCardKey ?? null,
      });
      const row = overlayReadOne(this.db, "work_result_cards", cardKey, () =>
        this.db.prepare("SELECT * FROM work_result_cards WHERE card_key=?").get(cardKey) as Record<string, unknown> | undefined);
      return this.toDto(cardRowSchema.parse(row), input.work);
    }
    this.db.prepare(`INSERT OR IGNORE INTO work_result_cards (
      card_key,semantic_card_key,work_id,user_id,kind,intent_revision,input_snapshot_id,origin_owner_epoch,
      canonical_outcome_hash,canonical_outcome_json,title,summary,deliverable_ids_json,evidence_ids_json,
      source_refs_json,artifact_refs_json,unverified_scope_json,created_at,previous_card_key,read_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      cardKey, semanticKey, input.work.workId, input.work.userId, input.kind, input.work.intentRevision,
      input.work.inputSnapshotId, input.work.ownerEpoch, outcomeHash, canonicalOutcomeJson,
      input.title, input.summary, deliverableIdsJson, evidenceIdsJson, sourceRefsJson, artifactRefsJson,
      unverifiedScopeJson, input.now, input.previousCardKey ?? null,
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
    const existingRaw = overlayReadOne(this.db, "work_owner_summaries", work.workId, () =>
      this.db.prepare("SELECT * FROM work_owner_summaries WHERE work_id=?").get(work.workId) as Record<string, unknown> | undefined);
    const existing = summaryRowSchema.optional().parse(existingRaw);
    if (!existing || existing.digest !== summaryDigest) {
      const pendingDecisionCodesJson = JSON.stringify([...new Set(pendingDecisionCodes)].sort());
      const handledWatermarkJson = JSON.stringify({
        ...(existing ? JSON.parse(existing.handled_watermark_json) as Record<string, unknown> : {}),
        cardKeys: current.map(card => card.cardKey), acceptedCount: work.acceptedDeliverableIds.length,
      });
      if (requiresWorkRustWrites(this.db)) {
        overlaySet(this.db, "work_owner_summaries", work.workId, {
          work_id: work.workId, intent_revision: work.intentRevision, input_snapshot_id: work.inputSnapshotId,
          owner_epoch: work.ownerEpoch, digest: summaryDigest, card_key: cardKey ?? null,
          pending_decision_codes_json: pendingDecisionCodesJson, handled_watermark_json: handledWatermarkJson,
          updated_at: now,
        });
        enqueueWorkOp(this.db, {
          op: "workOwnerSummaryUpsert", workId: work.workId, intentRevision: work.intentRevision,
          inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch, digest: summaryDigest,
          cardKey: cardKey ?? null, pendingDecisionCodesJson, handledWatermarkJson, updatedAt: now,
        });
      } else {
        this.db.prepare(`INSERT INTO work_owner_summaries (work_id,intent_revision,input_snapshot_id,owner_epoch,digest,
          card_key,pending_decision_codes_json,handled_watermark_json,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET
          intent_revision=excluded.intent_revision, input_snapshot_id=excluded.input_snapshot_id,
          owner_epoch=excluded.owner_epoch, digest=excluded.digest, card_key=excluded.card_key,
          pending_decision_codes_json=excluded.pending_decision_codes_json,
          handled_watermark_json=excluded.handled_watermark_json, updated_at=excluded.updated_at`)
          .run(work.workId, work.intentRevision, work.inputSnapshotId, work.ownerEpoch, summaryDigest,
            cardKey ?? null, pendingDecisionCodesJson, handledWatermarkJson, now);
      }
    }
    return { digest: summaryDigest, cardKey, pendingDecisionCodes };
  }

  /** Read facts only: no Work control version, ownership, execution change. */
  markRead(input: {
    workId: string; semanticCardKey: string; userId: string; readAt: number;
  }): WorkCardReadResult {
    // The public facade already owns a transaction. Keep the helper atomic as well:
    // independent callers must commit authorization, the read fact, its Journal wake
    // and the returned read version together. Nesting uses a SQLite savepoint.
    return workDomainRunTx(this.db, (): WorkCardReadResult => {
      const dbMatching = this.db.prepare(
        "SELECT * FROM work_result_cards WHERE work_id=? AND (semantic_card_key=? OR card_key=?)")
        .all(input.workId, input.semanticCardKey, input.semanticCardKey) as Array<Record<string, unknown>>;
      const raw = overlayFindAll(this.db, "work_result_cards", dbMatching, r => String(r.card_key),
        r => r.work_id === input.workId && (r.semantic_card_key === input.semanticCardKey || r.card_key === input.semanticCardKey))[0];
      const row = cardRowSchema.optional().parse(raw);
      if (!row) return { ok: false, message: "找不到结果卡片" };
      if (row.user_id !== input.userId) return { ok: false, message: "无权标记其他用户的结果卡片" };
      if (requiresWorkRustWrites(this.db)) {
        const shouldAdvance = row.read_at === null || row.read_at < input.readAt;
        if (shouldAdvance) {
          overlaySet(this.db, "work_result_cards", row.card_key, {
            ...row, read_at: input.readAt, read_by_user_id: input.userId, read_version: row.read_version + 1,
          });
        }
        enqueueWorkOp(this.db, {
          op: "workResultCardMarkRead", cardKey: row.card_key, userId: input.userId, readAt: input.readAt,
        });
        return {
          ok: true, cardKey: row.card_key, semanticCardKey: row.semantic_card_key,
          readAt: shouldAdvance ? input.readAt : (row.read_at ?? input.readAt),
          readVersion: shouldAdvance ? row.read_version + 1 : row.read_version,
          replayed: !shouldAdvance,
        };
      }
      const advanced = this.db.prepare(`UPDATE work_result_cards
        SET read_at=?, read_by_user_id=?, read_version=read_version+1
        WHERE card_key=? AND (read_at IS NULL OR read_at < ?)`)
        .run(input.readAt, input.userId, row.card_key, input.readAt);
      const current = cardRowSchema.parse(this.db.prepare("SELECT * FROM work_result_cards WHERE card_key=?").get(row.card_key));
      return { ok: true, cardKey: row.card_key, semanticCardKey: row.semantic_card_key,
        readAt: current.read_at ?? input.readAt, readVersion: current.read_version, replayed: advanced.changes === 0 };
    });
  }

  // ---------------------------------------------------------------- reading

  list(work: WorkDto): WorkResultCardDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_result_cards WHERE work_id=? ORDER BY created_at ASC, card_key ASC")
      .all(work.workId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "work_result_cards", dbRows, r => String(r.card_key),
      r => r.work_id === work.workId,
      (a, b) => Number(a.created_at) - Number(b.created_at) || String(a.card_key).localeCompare(String(b.card_key)))
      .map(row => this.toDto(cardRowSchema.parse(row), work));
  }

  listByUser(userId: string, limit = 200): WorkResultCardDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_result_cards WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
      .all(userId, Math.min(200, Math.max(1, limit))) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "work_result_cards", dbRows, r => String(r.card_key),
      r => r.user_id === userId, (a, b) => Number(b.created_at) - Number(a.created_at))
      .slice(0, Math.min(200, Math.max(1, limit)))
      .map(row => this.toDto(cardRowSchema.parse(row), this.workOf(String(row.work_id))));
  }

  /** Current approval-based view of what is verified for the artifact in play. */
  unverifiedScope(work: WorkDto, artifactSnapshotId?: string): WorkUnverifiedScopeDto[] {
    return work.criteria.filter(criterion => criterion.origin !== "assistant_proposal" && criterion.status !== "waived").map(criterion => {
      const evidence = criterion.evidenceRefs.map(id => this.repo.getEvidence(id)).filter(item => item !== undefined);
      // sourceSha identifies source code, not the aggregate artifacts: snapshot. Artifact
      // validation reopens criteria and clears their evidence refs when content changes.
      const currentEvidence = evidence.filter(item => item.intentRevision === work.intentRevision
        && item.inputSnapshotId === work.inputSnapshotId);
      const reason: WorkUnverifiedReason = criterion.status === "satisfied" && currentEvidence.length > 0
        ? currentEvidence.some(item => item.provenance === "user") ? "user_verified" : "auto_verified"
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
    const notificationIds = this.repo.listNotifications(work.workId)
      .filter(item => item.cardKey === row.card_key)
      .map(item => item.notificationId);
    return {
      cardKey: row.card_key, semanticCardKey: row.semantic_card_key, workId: row.work_id, userId: row.user_id,
      kind: row.kind, intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id,
      originOwnerEpoch: row.origin_owner_epoch, canonicalOutcomeHash: row.canonical_outcome_hash,
      previousCardKey: row.previous_card_key ?? undefined,
      ...(row.kind === "owner_summary" ? { ownerSummary: workOwnerSummaryPayloadSchema.parse(
        (JSON.parse(row.canonical_outcome_json) as WorkOutcomePayload).ownerSummary) } : {}),
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
    if (row.kind === "owner_summary") {
      const summaryRow = overlayReadOne<{ handled_watermark_json: string }>(this.db, "work_owner_summaries", work.workId, () =>
        this.db.prepare("SELECT work_id, handled_watermark_json FROM work_owner_summaries WHERE work_id=?")
          .get(work.workId) as { work_id: string; handled_watermark_json: string } | undefined);
      const latestCardKey = summaryRow
        ? (JSON.parse(summaryRow.handled_watermark_json) as { ownerNotification?: { publishedCardKey?: string } }).ownerNotification?.publishedCardKey
        : undefined;
      if (latestCardKey && latestCardKey !== row.card_key) return "superseded";
    }
    const outcome = JSON.parse(row.canonical_outcome_json) as WorkOutcomePayload;
    if (["closure_succeeded", "closure_failed", "closure_cancelled"].includes(row.kind)
      && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_closure_review_corrections'").get()) {
      const dbCorr = this.db.prepare(
        "SELECT operation_id, work_id, created_at FROM work_closure_review_corrections WHERE work_id=? ORDER BY created_at DESC,rowid DESC")
        .all(work.workId) as Array<{ operation_id: string; work_id: string; created_at: number }>;
      const correction = overlayFindAll(this.db, "work_closure_review_corrections", dbCorr, r => String(r.operation_id),
        r => r.work_id === work.workId, (a, b) => Number(b.created_at) - Number(a.created_at))[0];
      if (correction && !outcome.sourceRefs.includes(`closure-review-correction:${correction.operation_id}`)) return "superseded";
    }
    if (row.kind === "blocked_escalation") {
      if (row.origin_owner_epoch !== work.ownerEpoch) return "historical";
      const sourceIds = outcome.sourceRefs.filter(ref => ref.startsWith("work-blocker:")).map(ref => ref.slice("work-blocker:".length));
      const blockers = this.repo.listBlockers(work.workId);
      if (sourceIds.length) {
        const exactSources = blockers.filter(blocker => sourceIds.includes(blocker.blockerId));
        if (exactSources.length === sourceIds.length && !pendingDecisionBlockers(exactSources).length) return "superseded";
      } else {
      // Legacy escalation cards saved codes and the exact joined reasons, not
      // blocker IDs. Require both to identify their sources conservatively:
      // another/new question in this Work must not keep an old effect alert alive.
      const sources = blockers.filter(blocker => blocker.createdAt <= row.created_at
        && outcome.pendingBlockerCodes.includes(blocker.reasonCode ?? blocker.kind)
        && (`\n${row.summary}\n`).includes(`\n${blocker.reason}\n`));
      const sameSources = sources.map(blocker => blocker.reason).join("\n") === row.summary
        && listText(sources.map(blocker => blocker.reasonCode ?? blocker.kind)) === listText(outcome.pendingBlockerCodes);
      if (sameSources && !pendingDecisionBlockers(sources).length) return "superseded";
      }
    }
    const superseded = outcome.deliverables.some(item => this.repo.getDeliverable(item.deliverableId)?.status === "superseded");
    return superseded ? "superseded" : "current";
  }
}
