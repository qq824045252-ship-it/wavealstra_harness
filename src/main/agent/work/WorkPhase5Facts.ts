import type Database from "better-sqlite3";
import type { WorkDto, WorkDeliverableDto } from "../../../shared/bot-work";
import {
  capabilityOfGuarantee, externalDeliveryStatus, workCardReadRequestSchema, workDiagnosticsRequestSchema,
  workManualResendRequestSchema, type WorkCardReadResult, type WorkDeliveryGuarantee,
  type WorkDiagnosticsSection, type WorkExpandedDiagnosticsDto, type WorkSummaryProjectionDto,
} from "../../../shared/bot-work-phase5";
import type { ExpectedVersionGuard, WorkActor, WorkControlResult } from "../../../shared/bot-work";
import { WorkResultCards } from "./WorkResultCards";
import { WorkOwnerSummary } from "./WorkOwnerSummary";
import type { WorkService } from "./WorkService";

const ALL_SECTIONS = ["requirements", "responsibility", "executions", "acceptance", "resources", "delivery"] as const;

/**
 * Phase 5 facts: the stable card written inside the acceptance transaction, card reads,
 * the owner summary and the expanded diagnostics view.
 *
 * Keeping them here rather than in WorkService keeps the control service focused on
 * control transitions; every write still runs in the caller's transaction.
 */
export class WorkPhase5Facts {
  private readonly repo: WorkService["repo"];
  private readonly cards: WorkResultCards;
  readonly ownerSummaries: WorkOwnerSummary;
  constructor(private readonly works: WorkService, private readonly now: () => number, db: Database.Database) {
    this.repo = works.repo;
    this.cards = works.cards;
    this.ownerSummaries = new WorkOwnerSummary(db, works, now);
  }

  /** Host lifecycle seam: bounded recovery of durable team-notification obligations. */
  flushOwnerSummaries(): number { return this.ownerSummaries.flush(this.now()); }
  observeOwnerSummary(workId: string, now = this.now()): void { this.ownerSummaries.observe(workId, now); }
  isOwnerSummaryCurrent(work: WorkDto, cardKey: string | undefined): boolean { return this.ownerSummaries.isCurrent(work, cardKey); }
  nextOwnerSummaryDeadline(): number | undefined { return this.ownerSummaries.nextDeadline(); }

  // ------------------------------------------------------------- writes

  /** Runs inside acceptDeliverable's transaction; returns the one card for this outcome. */
  recordAcceptance(work: WorkDto, deliverable: WorkDeliverableDto, now: number) {
    const card = this.cards.ensure({
      work, kind: "accepted_result",
      outcome: WorkResultCards.acceptedOutcome(work, this.repo.listDeliverables(work.workId)),
      title: `成果已采纳：${work.title}`,
      summary: deliverable.summary,
      unverifiedScope: this.unverifiedText(work),
      now,
    });
    this.cards.refreshSummary(work, now);
    if (this.ownerSummaries.isManaged(work)) this.ownerSummaries.observe(work.workId, now);
    else this.repo.insertNotification({
      notificationId: `notification-${work.workId}-${deliverable.deliverableId}`,
      workId: work.workId, semanticKey: `work:${work.workId}:result:${deliverable.deliverableId}`,
      kind: "result", title: `成果已采纳：${work.title}`, body: deliverable.summary,
      stateVersion: work.stateVersion, intentRevision: work.intentRevision, delivery: "pending", createdAt: now,
      attemptCount: 0, cardKey: card.cardKey,
    });
    return card;
  }

  recordClosure(work: WorkDto, conclusion: NonNullable<WorkDto["closureConclusion"]>, now: number) {
    const kind = conclusion === "succeeded" ? "closure_succeeded" as const
      : conclusion === "cancelled" ? "closure_cancelled" as const : "closure_failed" as const;
    // Closing an already accepted outcome confirms the same substantive result: reuse it
    // instead of minting a mechanically duplicated card. An independent closure decision
    // (cancelled / ended) carries new substance of its own.
    const confirmed = conclusion === "succeeded" ? this.cards.latestAcceptedCard(work) : undefined;
    const card = confirmed ?? this.cards.ensure({
      work, kind,
      outcome: WorkResultCards.closureOutcome(work, this.repo.listDeliverables(work.workId), conclusion),
      title: `事项已结束：${work.title}`,
      summary: conclusion === "succeeded" ? "验收条件已满足" : work.closureSummary ?? "",
      unverifiedScope: this.unverifiedText(work),
      now,
    });
    this.cards.refreshSummary(work, now);
    const team = this.ownerSummaries.isManaged(work);
    if (team) this.ownerSummaries.observe(work.workId, now);
    // The team summary already owns delivery of the same accepted outcome. Cancellation
    // and unsuccessful endings remain independent closure decisions.
    return { ...card, suppressNotification: team && conclusion === "succeeded" };
  }

  /** A blocker waiting for a human is substantive; internal retries are not. */
  recordEscalation(work: WorkDto, reason: string, now: number) {
    const open = this.repo.listOpenBlockers(work.workId)
      .filter(blocker => blocker.waitingForUserInput || blocker.kind === "external_effect");
    const card = this.cards.ensure({
      work, kind: "blocked_escalation", outcome: WorkResultCards.escalationOutcome(work, open),
      title: `${work.title}：需要你的决定`, summary: open.map(blocker => blocker.reason).join("\n"),
      unverifiedScope: [], now,
    });
    if (!this.ownerSummaries.isManaged(work)) this.repo.insertNotification({
      notificationId: `notification-${work.workId}-blocked-${card.semanticCardKey.slice(0, 16)}`,
      workId: work.workId, semanticKey: `work:${work.workId}:blocked:${card.semanticCardKey}`,
      kind: "blocked", title: `${work.title}：需要你的决定`,
      body: reason.trim().slice(0, 1000), stateVersion: work.stateVersion,
      intentRevision: work.intentRevision, delivery: "pending", createdAt: now, attemptCount: 0,
      cardKey: card.cardKey,
    });
    this.cards.refreshSummary(work, now);
    this.ownerSummaries.observe(work.workId, now);
    return card;
  }

  refreshSummary(workId: string): void {
    const work = this.repo.getWork(workId);
    if (work) {
      this.cards.refreshSummary(work, this.now());
      this.ownerSummaries.observe(workId, this.now());
    }
  }

  /**
   * Card reads are facts about attention, not about the Work. They never advance
   * stateVersion/intentRevision/ownerEpoch, never admit an action and never schedule work.
   */
  markRead(actor: WorkActor, input: unknown): WorkCardReadResult {
    const parsed = workCardReadRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "阅读请求无效" };
    const resolved = this.works.resolveWorkActor(actor);
    if (typeof resolved === "string") return { ok: false, message: resolved };
    const work = this.repo.getWork(parsed.data.workId);
    if (!work || work.userId !== resolved.userId) return { ok: false, message: "找不到结果卡片" };
    const now = this.now();
    // A client clock may not run ahead of the host; a future timestamp never locks others.
    const readAt = Math.min(parsed.data.readAt ?? now, now);
    return this.works.transaction((): WorkCardReadResult => {
      const result = this.cards.markRead({ workId: work.workId, semanticCardKey: parsed.data.semanticCardKey,
        userId: resolved.userId, readAt });
      if (result.ok) this.works.emitCurrentProjection(work.workId, { force: true });
      return result;
    });
  }

  /** Explicit, attributable resend of a delivery whose external outcome is unresolved. */
  resend(actor: WorkActor, request: unknown): WorkControlResult {
    const parsed = workManualResendRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message ?? "重发请求无效" };
    const input = parsed.data;
    return this.works.runCardControl(actor, "resendWorkNotification", input as unknown as
      { operationId: string; workId: string; versionGuard?: ExpectedVersionGuard }, {
      guard: "full", ownerOnly: true, allowLifecycles: ["active", "paused", "closing", "closed"],
    }, (work) => {
      const notification = this.repo.getNotification(input.notificationId);
      if (!notification || notification.workId !== work.workId) return { ok: false, code: "not_found", message: "找不到通知" };
      const authorized = this.works.notifications.authorizeResend({ notificationId: notification.notificationId,
        operationId: input.operationId, reason: input.reason });
      if (!authorized.ok) return { ok: false, code: "invalid_request", message: authorized.message };
      const next: WorkDto = { ...work, stateVersion: work.stateVersion + 1, updatedAt: this.now() };
      this.repo.updateWork(next);
      return { ok: true, outboxEventId: this.works.emitNotificationResent(next, {
        notificationId: notification.notificationId, effectKey: authorized.effectKey,
        reason: input.reason, operationId: input.operationId }) };
    });
  }

  // ------------------------------------------------------------ read views

  /** Decision-shaped view: no bindings, retries or ledgers. */
  summary(userId: string, workId: string): WorkSummaryProjectionDto | undefined {
    const work = this.repo.getWork(workId);
    if (!work || work.userId !== userId) return undefined;
    const projection = this.works.getProjection(workId);
    if (!projection) return undefined;
    const currentCards = this.cards.list(work).filter(card => card.currency === "current");
    const notifications = this.repo.listNotifications(workId);
    const decisions = this.cards.pendingDecisions(workId);
    return {
      workId: work.workId, title: work.title, goal: work.goalDescription, lifecycle: work.lifecycle, mode: work.mode,
      closureConclusion: work.closureConclusion,
      ownerBotId: work.ownerBotId, ownerEpoch: work.ownerEpoch, intentRevision: work.intentRevision,
      inputSnapshotId: work.inputSnapshotId, stateVersion: work.stateVersion,
      artifactSnapshotId: projection.phase3?.artifactSnapshotId,
      acceptedCount: projection.acceptedDeliverableIds.length,
      currentCardKeys: currentCards.map(card => card.cardKey),
      currentConclusion: work.closureConclusion ?? (currentCards.find(card => card.kind === "owner_summary")?.summary || currentCards.at(-1)?.summary || undefined),
      pendingUserDecisions: [...new Set([...decisions.map(blocker => blocker.reason), ...this.ownerSummaries.pendingDecisions(work)])],
      nextSteps: projection.nextSteps.slice(0, 6),
      unverifiedScope: this.cards.unverifiedScope(work, projection.phase3?.artifactSnapshotId),
      delivery: notifications.map(notification => {
        const attempts = this.works.notifications.attempts(notification.notificationId);
        const last = attempts.at(-1);
        const capability = last ? capabilityOfGuarantee(last.guarantee as WorkDeliveryGuarantee) : undefined;
        return { notificationId: notification.notificationId, cardKey: notification.cardKey,
          kind: notification.kind, state: notification.delivery,
          externalStatus: externalDeliveryStatus({ delivery: notification.delivery, capability,
            attemptCount: attempts.length }),
          attemptCount: attempts.length, readAt: notification.readAt };
      }),
      updatedAt: work.updatedAt, closedAt: work.closedAt,
    };
  }

  /**
   * Expanded view: versioned evidence read on demand with bounded pages. Anything the host
   * cannot read is reported as a gap; it is never rendered as verified.
   */
  diagnostics(userId: string, request: unknown): WorkExpandedDiagnosticsDto | undefined {
    const parsed = workDiagnosticsRequestSchema.safeParse(request);
    if (!parsed.success) return undefined;
    const work = this.repo.getWork(parsed.data.workId);
    if (!work || work.userId !== userId) return undefined;
    const limit = Math.min(200, Math.max(1, parsed.data.limit ?? 50));
    const wanted = new Set<string>(parsed.data.sections ?? ALL_SECTIONS);
    const offsets = parseDiagnosticsCursor(parsed.data.cursor);
    const slice = <T>(name: string, rows: T[]): { items: T[]; truncated: boolean; at: number } => {
      if (!wanted.has(name)) return { items: [], truncated: false, at: 0 };
      const from = offsets[name] ?? 0;
      return { items: rows.slice(from, from + limit), truncated: from + limit < rows.length, at: from + limit };
    };

    const deliverables = this.repo.listDeliverables(work.workId);
    const cards = this.cards.list(work);
    const notifications = this.repo.listNotifications(work.workId);
    const missing: string[] = [];
    for (const evidenceId of new Set(cards.flatMap(card => card.evidenceIds))) {
      if (!this.repo.getEvidence(evidenceId)) missing.push(`证据 ${evidenceId} 已不可读`);
    }
    const attempts = notifications.flatMap(notification => {
      try { return this.works.notifications.attempts(notification.notificationId); }
      catch { missing.push(`通知 ${notification.notificationId} 的投递尝试不可读`); return []; }
    });

    const requirements = slice("requirements", this.repo.listIntentSnapshots(work.workId).map(snapshot => ({
      intentRevision: snapshot.intentRevision, inputSnapshotId: snapshot.inputSnapshotId,
      sourceVersion: snapshot.sourceVersion, createdAt: snapshot.createdAt,
      deliverableIds: deliverables.filter(item => item.intentRevision === snapshot.intentRevision
        && item.inputSnapshotId === snapshot.inputSnapshotId).map(item => item.deliverableId),
    })));
    const responsibility = slice("responsibility", this.responsibilityRows(work));
    const executions = slice("executions", this.repo.listBindings(work.workId).map(binding => ({
      bindingId: binding.bindingId, taskId: binding.taskId, status: binding.status,
      intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
      invalidatedAt: binding.invalidatedAt,
      artifactRefs: deliverables.filter(item => item.executionId === binding.bindingId).flatMap(item => item.artifactRefs),
      blocked: binding.settlementNote,
      writeConflicts: deliverables.some(item => item.executionId === binding.bindingId && item.hasWriteConflicts),
      isError: binding.status === "failed" })));
    const acceptance = slice("acceptance", cards.map(card => ({ cardKey: card.cardKey,
      semanticCardKey: card.semanticCardKey, kind: card.kind, canonicalOutcomeHash: card.canonicalOutcomeHash,
      currency: card.currency, createdAt: card.createdAt, deliverableIds: card.deliverableIds,
      evidenceIds: card.evidenceIds, readAt: card.readAt })));
    const resources = slice("resources", this.resourceRows(work));
    const delivery = slice("delivery", attempts);

    const nextOffsets: Record<string, number> = {};
    for (const [name, part] of Object.entries({ requirements, responsibility, executions, acceptance, resources, delivery })) {
      if (part.truncated) nextOffsets[name] = part.at;
    }
    const section = <T>(part: { items: T[]; truncated: boolean }): WorkDiagnosticsSection<T> =>
      ({ items: part.items, truncated: part.truncated, ...(missing.length ? { missing } : {}) });
    const artifactSnapshotId = this.works.artifacts.currentSnapshotId(work.workId);
    return {
      workId: work.workId, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
      stateVersion: work.stateVersion, artifactSnapshotId,
      requirements: section(requirements), responsibility: section(responsibility),
      executions: section(executions), acceptance: section(acceptance),
      resources: section(resources), delivery: section(delivery),
      unverifiedScope: this.cards.unverifiedScope(work, artifactSnapshotId),
      ...(Object.keys(nextOffsets).length ? { nextCursor: JSON.stringify(nextOffsets) } : {}),
    };
  }

  // --------------------------------------------------------------- helpers

  private unverifiedText(work: WorkDto): string[] {
    return this.cards.unverifiedScope(work).filter(entry => !["auto_verified", "user_verified"].includes(entry.reason))
      .map(entry => entry.text);
  }

  private responsibilityRows(work: WorkDto): WorkExpandedDiagnosticsDto["responsibility"]["items"] {
    const handoffs = this.works.collaboration.history(work.workId).filter(message => message.kind === "handoff");
    const rows = handoffs.map(message => ({ ownerEpoch: message.ownerEpoch,
      ownerBotId: message.senderBotId ?? work.ownerBotId,
      reason: message.body, at: message.createdAt, adoptionState: "adopted" as const }));
    return [...rows, { ownerEpoch: work.ownerEpoch, ownerBotId: work.ownerBotId,
      at: work.updatedAt, adoptionState: "adopted" as const }];
  }

  private resourceRows(work: WorkDto): WorkExpandedDiagnosticsDto["resources"]["items"] {
    const rows: WorkExpandedDiagnosticsDto["resources"]["items"] = [];
    for (const subscription of this.repo.listSubscriptions(work.workId, { includeStopped: true })) {
      rows.push({ kind: "subscription", ref: subscription.subscriptionId,
        state: subscription.stoppedAt ? "stopped" : subscription.source,
        detail: subscription.stopConditionText, at: subscription.nextWakeAt });
    }
    for (const chain of this.works.causal.list(work.workId, 50)) {
      rows.push({ kind: "causal", ref: chain.chain_id, state: chain.decision,
        detail: chain.reason_code ?? undefined, at: chain.created_at });
    }
    return rows;
  }
}

/** Diagnostics pages resume per section; an unreadable cursor restarts that section. */
export function parseDiagnosticsCursor(cursor?: string): Record<string, number> {
  if (!cursor) return {};
  try {
    const raw = JSON.parse(cursor) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    }
    return result;
  } catch { return {}; }
}

