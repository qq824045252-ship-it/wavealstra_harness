import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkNotificationChannel, WorkNotificationDto } from "../../../shared/bot-work";
import type { WorkNotificationIdentity } from "../../../shared/bot-work-collaboration";
import {
  canonicalJson, capabilityOfGuarantee, capabilityIsConsistent, deliveryRecoveryAction,
  type WorkChannelCapability, type WorkDeliveryAttemptDto, type WorkDeliveryGuarantee,
} from "../../../shared/bot-work-phase5";
import type { WorkArtifactValidation } from "./WorkArtifactValidation";
import { ensureWorkCollaborationTables } from "./WorkCollaborationService";
import type { WorkService } from "./WorkService";

const identitySchema = z.object({ input_snapshot_id: z.string(), owner_epoch: z.number(), sender_bot_id: z.string(),
  semantic_validity: z.enum(["active", "superseded", "cancelled"]) });
const attemptSchema = z.object({ attempt_id: z.string(), notification_id: z.string(), ordinal: z.number(), channel: z.string(),
  idempotency_key: z.string(), payload_json: z.string(), status: z.enum(["unknown", "sent", "missing", "failed"]),
  provider_effect_key: z.string().nullable().optional(), payload_hash: z.string().nullable().optional(),
  delivery_guarantee: z.string().nullable().optional(), claim_generation: z.number().nullable().optional(),
  claimed_at: z.number().optional(), settled_at: z.number().nullable().optional(), receipt: z.string().nullable().optional() });
const effectSchema = z.object({ effect_key: z.string(), notification_id: z.string(), payload_hash: z.string(),
  payload_json: z.string(), channel: z.string(), target_key: z.string().nullable(), delivery_guarantee: z.string(),
  supports_idempotency_key: z.number(), supports_receipt_query: z.number(),
  authorization_kind: z.enum(["initial", "manual-resend"]), authorization_operation_id: z.string(),
  authorization_reason: z.string().nullable(), resend_of_attempt_id: z.string().nullable(), created_at: z.number() });
// Persisted channel payloads are immutable and parsed at the database boundary.
const notificationSchema = z.object({ notificationId: z.string(), workId: z.string(), semanticKey: z.string(),
  kind: z.enum(["result", "blocked", "closed", "handoff"]), title: z.string(), body: z.string().optional(),
  stateVersion: z.number(), intentRevision: z.number(), delivery: z.enum(["pending", "sent", "unknown", "failed"]),
  channel: z.string().optional(), idempotencyKey: z.string().optional(), attemptCount: z.number(),
  externalReceipt: z.string().optional(), readAt: z.number().optional(), createdAt: z.number(), sentAt: z.number().optional(),
  inputSnapshotId: z.string().optional(), ownerEpoch: z.number().optional(), senderBotId: z.string().optional(),
  semanticValidity: z.enum(["active", "superseded", "cancelled"]).optional(),
  cardKey: z.string().optional(), effectKey: z.string().optional(), targetKey: z.string().optional(),
});
type Attempt = z.infer<typeof attemptSchema>;
type Effect = z.infer<typeof effectSchema>;
type Options = { now?: () => number; isAuthority?: () => boolean; artifacts?: Pick<WorkArtifactValidation, "capture" | "validate"> };
type Outcome = { notificationId: string; delivery: WorkNotificationDto["delivery"] };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Declared capability of a real endpoint. A channel may not claim replay safety without a
 * stable effect key, nor read-back without that key, and conflicting declarations throw
 * instead of silently downgrading to "best effort".
 */
export function resolveChannelCapability(channel: WorkNotificationChannel): WorkChannelCapability {
  if (channel.deliveryGuarantee) {
    const base = capabilityOfGuarantee(channel.deliveryGuarantee);
    const capability: WorkChannelCapability = {
      deliveryGuarantee: channel.deliveryGuarantee,
      supportsIdempotencyKey: channel.supportsIdempotencyKey ?? base.supportsIdempotencyKey,
      supportsReceiptQuery: channel.supportsReceiptQuery ?? base.supportsReceiptQuery,
    };
    if (!capabilityIsConsistent(capability)) {
      throw new Error(`通知渠道 ${channel.channel} 的能力声明自相矛盾（${capability.deliveryGuarantee}）`);
    }
    // Claiming receipt read-back without implementing it would turn an unknown delivery
    // into an endless safe-replay loop, so the adapter must back its declaration.
    if (capability.supportsReceiptQuery && !channel.lookup) {
      throw new Error(`通知渠道 ${channel.channel} 声明可回查但未提供 lookup`);
    }
    return capability;
  }
  // Legacy adapters only expose one boolean plus an optional read-back.
  const idempotent = channel.idempotent === true;
  const queryable = Boolean(channel.lookup);
  if (idempotent) return capabilityOfGuarantee(queryable ? "idempotent-queryable" : "idempotent-unqueryable");
  return { deliveryGuarantee: "best-effort-unqueryable", supportsIdempotencyKey: false, supportsReceiptQuery: queryable };
}

/** Fresh-fact claim, immutable attempt, external call, and receipt settlement are separate steps. */
export class WorkNotificationDelivery {
  private readonly sending = new Set<string>();
  constructor(private readonly db: Database.Database, private readonly works: WorkService, private readonly options: Options = {}) {
    ensureWorkCollaborationTables(db);
  }

  identity(notificationId: string): WorkNotificationIdentity | undefined {
    const row = identitySchema.optional().parse(this.db.prepare("SELECT * FROM work_notification_identity WHERE notification_id=?").get(notificationId));
    return row ? { inputSnapshotId: row.input_snapshot_id, ownerEpoch: row.owner_epoch,
      senderBotId: row.sender_bot_id, semanticValidity: row.semantic_validity } : undefined;
  }

  supersede(workId: string, validity: "superseded" | "cancelled"): void {
    this.db.prepare(`UPDATE work_notification_identity SET semantic_validity=? WHERE notification_id IN (
      SELECT notification_id FROM work_notifications WHERE work_id=? AND kind='result')`)
      .run(validity, workId);
  }

  /** Persisted attempts for the expanded diagnostics view. */
  attempts(notificationId: string): WorkDeliveryAttemptDto[] {
    return this.db.prepare("SELECT * FROM work_notification_attempts WHERE notification_id=? ORDER BY ordinal ASC")
      .all(notificationId).map(row => this.toAttemptDto(attemptSchema.parse(row)));
  }

  /**
   * Authorize one new external delivery identity for a notification whose outcome is
   * unresolved. The frozen payload is stored with the authorization, so the resend cannot
   * silently follow later wording or owner changes.
   */
  authorizeResend(input: { notificationId: string; operationId: string; reason: string; targetKey?: string }):
    { ok: true; effectKey: string } | { ok: false; message: string } {
    const notification = this.works.repo.getNotification(input.notificationId);
    if (!notification) return { ok: false, message: "找不到通知" };
    const prior = this.lastAttempt(input.notificationId);
    if (!prior || (prior.status !== "unknown" && notification.delivery !== "unknown")) {
      return { ok: false, message: "只有外部投递结果未知的通知需要人工重发" };
    }
    const capability = capabilityOfGuarantee((prior.delivery_guarantee as WorkDeliveryGuarantee | null) ?? "best-effort-unqueryable");
    const payload: WorkNotificationDto = { ...notification, delivery: "pending",
      attemptCount: notification.attemptCount + 1, channel: notification.channel ?? prior.channel,
      targetKey: input.targetKey ?? notification.targetKey, semanticValidity: "active" };
    const payloadHash = sha256(canonicalJson(payload));
    const effectKey = `effect:${input.notificationId}:resend:${input.operationId}`;
    this.db.prepare(`INSERT OR IGNORE INTO work_notification_effects (
      effect_key,notification_id,payload_hash,payload_json,channel,target_key,delivery_guarantee,
      supports_idempotency_key,supports_receipt_query,authorization_kind,authorization_operation_id,
      authorization_reason,resend_of_attempt_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?, 'manual-resend', ?,?,?,?)`).run(
      effectKey, input.notificationId, payloadHash, canonicalJson(payload), prior.channel,
      input.targetKey ?? null, capability.deliveryGuarantee,
      capability.supportsIdempotencyKey ? 1 : 0, capability.supportsReceiptQuery ? 1 : 0,
      input.operationId, input.reason, prior.attempt_id, this.now(),
    );
    this.works.repo.updateNotificationLinks(input.notificationId, { effectKey, cardKey: notification.cardKey, targetKey: input.targetKey });
    this.works.repo.updateNotificationDelivery(input.notificationId, { delivery: "pending", channel: notification.channel ?? prior.channel });
    return { ok: true, effectKey };
  }

  deliver(channel: WorkNotificationChannel, workId?: string): Outcome[] {
    this.assertAuthority();
    const capability = resolveChannelCapability(channel);
    const works = workId ? [this.works.getWork(workId)].filter((value): value is WorkDto => Boolean(value))
      : this.works.repo.listWorksForNotifications();
    const outcomes: Outcome[] = [];
    // Only IDs survive this loop. A previous send/lookup can synchronously change the next Work.
    for (const work of works) for (const id of this.works.repo.listNotifications(work.workId).map(item => item.notificationId)) {
      if (this.sending.has(id)) continue;
      const current = this.works.repo.getNotification(id);
      if (!current || current.delivery === "sent" || current.delivery === "failed") continue;
      if (current.channel && current.channel !== channel.channel) continue;
      if (current.targetKey && channel.targetKey && current.targetKey !== channel.targetKey) continue;
      const prior = this.lastAttempt(id);
      // An explicit resend authorization outranks the automatic recovery path: the user has
      // already accepted the duplicate risk, and the frozen payload is what gets sent.
      const resendAuthorized = this.pendingResendEffect(id, channel, capability) !== undefined;

      if (!resendAuthorized && prior?.status === "unknown") {
        // Resolve the original effect even if its payload is now semantically obsolete.
        let lookup: "delivered" | "missing" | "unknown" | "unavailable" = "unavailable";
        if (capability.supportsReceiptQuery && channel.lookup) {
          try {
            const payload = notificationSchema.parse(JSON.parse(prior.payload_json));
            lookup = channel.lookup({ notification: payload, idempotencyKey: prior.provider_effect_key ?? prior.idempotency_key });
          } catch { lookup = "unknown"; }
        }
        const action = deliveryRecoveryAction({ lookup, capability });
        if (action === "settle-sent") {
          this.settle(prior, "sent", "reconciled-by-provider-receipt");
          outcomes.push({ notificationId: id, delivery: "sent" });
          continue;
        }
        if (action === "stay-unknown" || action === "manual-resend-only") {
          outcomes.push({ notificationId: id, delivery: "unknown" });
          continue;
        }
        // Safe replay: reuse the original effect key and the original, immutable payload.
        const replayed = this.claimReplay(id, prior, capability, channel);
        if (!replayed) { outcomes.push({ notificationId: id, delivery: "unknown" }); continue; }
        outcomes.push(this.dispatch(channel, replayed));
        continue;
      }
      if (current.delivery === "unknown") {
        // Unknown without an immutable claim is a recovery blocker, never a fresh send.
        outcomes.push({ notificationId: id, delivery: "unknown" });
        continue;
      }
      const claim = this.claim(id, channel, capability);
      if (!claim) {
        const latest = this.works.repo.getNotification(id);
        if (latest) outcomes.push({ notificationId: id, delivery: latest.delivery });
        continue;
      }
      outcomes.push(this.dispatch(channel, claim));
    }
    return outcomes;
  }

  /** File reads/hash work stays outside the short claim transaction. */
  private claim(notificationId: string, channel: WorkNotificationChannel,
    capability: WorkChannelCapability): { attempt: Attempt; notification: WorkNotificationDto } | undefined {
    const workId = this.works.repo.getNotification(notificationId)?.workId;
    if (!workId) return undefined;
    const inspection = this.options.artifacts?.capture(workId);
    return this.works.transaction((): { attempt: Attempt; notification: WorkNotificationDto } | undefined => {
      this.assertAuthority();
      const notification = this.works.repo.getNotification(notificationId);
      const latest = this.works.getWork(workId);
      if (!notification || !latest || notification.delivery === "sent" || notification.delivery === "failed") return undefined;
      // An unresolved earlier attempt blocks automatic sends, but an explicitly authorized
      // resend is a new physical attempt under a new effect identity and may proceed.
      const authorized = this.pendingResendEffect(notificationId, channel, capability);
      if (!authorized && this.lastAttempt(notificationId)?.status === "unknown") return undefined;
      const identity = this.identity(notificationId);
      if (!identity || identity.semanticValidity !== "active") return undefined;
      const cancelled = notification.kind === "result" && (latest.lifecycle === "closing" && latest.pendingConclusion === "cancelled"
        || latest.lifecycle === "closed" && latest.closureConclusion === "cancelled");
      const revisionChanged = notification.intentRevision !== latest.intentRevision || identity.inputSnapshotId !== latest.inputSnapshotId;
      const hasArtifacts = this.works.repo.listDeliverables(latest.workId).some(item => latest.acceptedDeliverableIds.includes(item.deliverableId) && item.artifactRefs.length > 0);
      const needsArtifactProof = notification.kind === "result" || notification.kind === "closed" && latest.closureConclusion === "succeeded";
      const artifactsValid = !needsArtifactProof || (inspection !== undefined ? this.options.artifacts!.validate(inspection, this.now()) : !hasArtifacts);
      const currentDeliverable = notification.kind !== "result" || this.works.repo.listDeliverables(latest.workId).some(item =>
        latest.acceptedDeliverableIds.includes(item.deliverableId) && item.status === "accepted"
        && item.intentRevision === latest.intentRevision && item.inputSnapshotId === latest.inputSnapshotId
        && (`notification-${latest.workId}-${item.deliverableId}` === notification.notificationId
          || notification.semanticKey === `work:${latest.workId}:result:${item.deliverableId}`));
      // Closed:succeeded still has a valid delivery obligation.
      if (cancelled || revisionChanged || !artifactsValid || !currentDeliverable) {
        this.db.prepare("UPDATE work_notification_identity SET semantic_validity=? WHERE notification_id=?")
          .run(cancelled ? "cancelled" : "superseded", notificationId);
        const changed = this.works.getWork(latest.workId)!;
        this.works.repo.updateWork({ ...changed, stateVersion: changed.stateVersion + 1, updatedAt: this.now() });
        this.works.emitCurrentProjection(latest.workId);
        return undefined;
      }
      const ownerChanged = identity.ownerEpoch !== latest.ownerEpoch || identity.senderBotId !== latest.ownerBotId;
      const ownerName = z.object({ display_name: z.string() }).parse(this.db.prepare("SELECT display_name FROM bots WHERE bot_id=?").get(latest.ownerBotId)).display_name;
      const ordinal = notification.attemptCount + 1;
      if (!authorized && ordinal > 3) { this.works.repo.updateNotificationDelivery(notificationId, { delivery: "failed" }); return undefined; }
      // Content identity for the external effect. Delivery bookkeeping (attempt counter,
      // claim state) is not part of the message, so a safe retry of the same intent keeps
      // one provider effect. A changed target, owner line or payload still requires a new
      // explicit authorization instead of silently reusing the key.
      const candidate: WorkNotificationDto = {
        notificationId, workId: notification.workId, semanticKey: notification.semanticKey,
        kind: notification.kind, title: notification.title,
        body: ownerChanged ? `${notification.body ?? ""}
当前负责人：${ownerName}` : notification.body,
        stateVersion: notification.stateVersion, intentRevision: notification.intentRevision,
        delivery: "pending", attemptCount: 0, createdAt: notification.createdAt,
        cardKey: notification.cardKey,
        ...{ inputSnapshotId: latest.inputSnapshotId, ownerEpoch: latest.ownerEpoch,
          senderBotId: latest.ownerBotId, semanticValidity: "active" as const },
        channel: channel.channel, targetKey: channel.targetKey,
      };
      const candidateHash = sha256(canonicalJson(candidate));
      const effect = authorized ?? this.ensureInitialEffect(notificationId, candidate, candidateHash, channel, capability);
      if (!effect) return undefined;
      if (!authorized && effect.payload_hash !== candidateHash) return undefined;
      // The physical attempt always sends the frozen effect payload, never a rebuilt one.
      const payload = notificationSchema.parse(JSON.parse(effect.payload_json));
      const payloadHash = effect.payload_hash;
      const attemptKey = `${notificationId}:${ordinal}`;
      const providerEffectKey = effect.effect_key;
      // A changed payload is assigned a fresh provider identity only after the old
      // attempt has an explicit missing/failed receipt. Unknown is never overwritten.
      const attempt: Attempt = { attempt_id: attemptKey, notification_id: notificationId, ordinal,
        channel: channel.channel, idempotency_key: providerEffectKey, payload_json: JSON.stringify(payload), status: "unknown",
        provider_effect_key: providerEffectKey, payload_hash: payloadHash,
        delivery_guarantee: capability.deliveryGuarantee, claim_generation: 1, claimed_at: this.now() };
      this.db.prepare(`INSERT INTO work_notification_attempts(attempt_id,notification_id,ordinal,channel,idempotency_key,
        provider_effect_key,payload_hash,delivery_guarantee,claim_generation,payload_json,status,claimed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'unknown',?)`).run(attempt.attempt_id, notificationId, ordinal, channel.channel,
        attempt.idempotency_key, providerEffectKey, payloadHash, capability.deliveryGuarantee, 1, attempt.payload_json, this.now());
      this.db.prepare("UPDATE work_notification_identity SET owner_epoch=?,sender_bot_id=? WHERE notification_id=?")
        .run(latest.ownerEpoch, latest.ownerBotId, notificationId);
      this.works.repo.updateNotificationLinks(notificationId, { cardKey: notification.cardKey, effectKey: providerEffectKey, targetKey: channel.targetKey });
      this.works.repo.updateNotificationDelivery(notificationId, { delivery: "unknown", channel: channel.channel,
        attemptCount: ordinal, idempotencyKey: attempt.idempotency_key });
      return { attempt, notification: payload };
    });
  }

  /** Safe replay keeps the original effect identity and payload; only the ordinal advances. */
  private claimReplay(notificationId: string, prior: Attempt, capability: WorkChannelCapability,
    channel: WorkNotificationChannel): { attempt: Attempt; notification: WorkNotificationDto } | undefined {
    return this.works.transaction((): { attempt: Attempt; notification: WorkNotificationDto } | undefined => {
      this.assertAuthority();
      const notification = this.works.repo.getNotification(notificationId);
      if (!notification) return undefined;
      const effectKey = prior.provider_effect_key ?? prior.idempotency_key;
      const effect = effectSchema.optional().parse(this.db.prepare("SELECT * FROM work_notification_effects WHERE effect_key=?").get(effectKey));
      if (!effect) return undefined;
      if (effect.payload_hash !== (prior.payload_hash ?? sha256(canonicalJson(JSON.parse(prior.payload_json))))) return undefined;
      const siblingAttempts = (this.db.prepare("SELECT COUNT(*) AS count FROM work_notification_attempts WHERE provider_effect_key=?")
        .get(effectKey) as { count: number }).count;
      if (siblingAttempts >= 3) { this.works.repo.updateNotificationDelivery(notificationId, { delivery: "failed" }); return undefined; }
      const ordinal = notification.attemptCount + 1;
      const payload = notificationSchema.parse(JSON.parse(prior.payload_json));
      const attempt: Attempt = { attempt_id: `${notificationId}:${ordinal}`, notification_id: notificationId, ordinal,
        channel: channel.channel, idempotency_key: effectKey, payload_json: prior.payload_json, status: "unknown",
        provider_effect_key: effectKey, payload_hash: effect.payload_hash, delivery_guarantee: effect.delivery_guarantee,
        claim_generation: siblingAttempts + 1, claimed_at: this.now() };
      this.db.prepare(`INSERT INTO work_notification_attempts(attempt_id,notification_id,ordinal,channel,idempotency_key,
        provider_effect_key,payload_hash,delivery_guarantee,claim_generation,payload_json,status,claimed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'unknown',?)`).run(attempt.attempt_id, notificationId, ordinal, channel.channel,
        effectKey, effectKey, effect.payload_hash, effect.delivery_guarantee, attempt.claim_generation, prior.payload_json, this.now());
      this.works.repo.updateNotificationLinks(notificationId, { effectKey });
      this.works.repo.updateNotificationDelivery(notificationId, { delivery: "unknown", channel: channel.channel,
        attemptCount: ordinal, idempotencyKey: effectKey });
      return { attempt, notification: payload };
    });
  }

  /** One initial effect per notification intent; the payload hash freezes what was sent. */
  private ensureInitialEffect(notificationId: string, payload: WorkNotificationDto, payloadHash: string,
    channel: WorkNotificationChannel, capability: WorkChannelCapability): Effect | undefined {
    const effectKey = `effect:${notificationId}:initial`;
    this.db.prepare(`INSERT OR IGNORE INTO work_notification_effects (
      effect_key,notification_id,payload_hash,payload_json,channel,target_key,delivery_guarantee,
      supports_idempotency_key,supports_receipt_query,authorization_kind,authorization_operation_id,
      authorization_reason,resend_of_attempt_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?, 'initial', ?, NULL, NULL, ?)`).run(
      effectKey, notificationId, payloadHash, canonicalJson(payload), channel.channel, channel.targetKey ?? null,
      capability.deliveryGuarantee, capability.supportsIdempotencyKey ? 1 : 0,
      capability.supportsReceiptQuery ? 1 : 0, `notification:${notificationId}`, this.now(),
    );
    return effectSchema.optional().parse(this.db.prepare("SELECT * FROM work_notification_effects WHERE effect_key=?").get(effectKey));
  }

  /** A manual resend authorization waiting for its physical attempt. */
  private pendingResendEffect(notificationId: string, channel: WorkNotificationChannel,
    capability: WorkChannelCapability): Effect | undefined {
    const effect = effectSchema.optional().parse(this.db.prepare(`SELECT * FROM work_notification_effects
      WHERE notification_id=? AND authorization_kind='manual-resend'
        AND effect_key NOT IN (SELECT provider_effect_key FROM work_notification_attempts WHERE provider_effect_key IS NOT NULL)
      ORDER BY created_at DESC LIMIT 1`).get(notificationId));
    if (!effect) return undefined;
    if (effect.channel !== channel.channel) return undefined;
    if (effect.delivery_guarantee !== capability.deliveryGuarantee) return undefined;
    return effect;
  }

  private dispatch(channel: WorkNotificationChannel,
    claim: { attempt: Attempt; notification: WorkNotificationDto }): Outcome {
    const id = claim.attempt.notification_id;
    let response: ReturnType<WorkNotificationChannel["send"]>;
    this.sending.add(id);
    try { response = channel.send({ notification: claim.notification, idempotencyKey: claim.attempt.provider_effect_key ?? claim.attempt.idempotency_key }); }
    catch { return { notificationId: id, delivery: "unknown" }; }
    finally { this.sending.delete(id); }
    if (response.ok) this.settle(claim.attempt, "sent", response.receipt);
    else if (response.responseLost) {
      const capability = resolveChannelCapability(channel);
      let lookup: "delivered" | "missing" | "unknown" | "unavailable" = "unavailable";
      if (capability.supportsReceiptQuery && channel.lookup) {
        try { lookup = channel.lookup({ notification: claim.notification, idempotencyKey: claim.attempt.provider_effect_key ?? claim.attempt.idempotency_key }); }
        catch { lookup = "unknown"; }
      }
      if (lookup === "delivered") this.settle(claim.attempt, "sent", "reconciled-by-provider-receipt");
      else if (lookup === "missing") this.settle(claim.attempt, "missing", undefined, capability.supportsIdempotencyKey);
    } else this.settle(claim.attempt, "failed", undefined, response.retryable && claim.attempt.ordinal < 3);
    return { notificationId: id, delivery: this.works.repo.getNotification(id)?.delivery ?? "unknown" };
  }

  /** Settles exactly the claimed attempt; a late receipt can never overwrite a later one. */
  private settle(attempt: Attempt, status: Attempt["status"], receipt?: string, retryable = false): void {
    this.works.transaction(() => {
      this.assertAuthority();
      const updated = this.db.prepare(`UPDATE work_notification_attempts SET status=?,settled_at=?,receipt=?
        WHERE attempt_id=? AND status='unknown' AND claim_generation=?`)
        .run(status, this.now(), receipt ?? null, attempt.attempt_id, attempt.claim_generation ?? 1);
      if (!updated.changes) return;
      this.works.repo.updateNotificationDelivery(attempt.notification_id, {
        delivery: status === "sent" ? "sent" : status === "missing" || retryable ? "pending" : status === "failed" ? "failed" : "unknown",
        attemptCount: attempt.ordinal, channel: attempt.channel, idempotencyKey: attempt.idempotency_key,
        externalReceipt: receipt, sentAt: status === "sent" ? this.now() : undefined,
      });
      const notification = this.works.repo.getNotification(attempt.notification_id);
      const work = notification ? this.works.getWork(notification.workId) : undefined;
      if (work) {
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: this.now() });
        this.works.emitCurrentProjection(work.workId);
      }
    });
  }

  private lastAttempt(notificationId: string): Attempt | undefined {
    return attemptSchema.optional().parse(this.db.prepare("SELECT * FROM work_notification_attempts WHERE notification_id=? ORDER BY ordinal DESC LIMIT 1").get(notificationId));
  }

  private toAttemptDto(row: Attempt): WorkDeliveryAttemptDto {
    return { attemptId: row.attempt_id, notificationId: row.notification_id, ordinal: row.ordinal, channel: row.channel,
      providerEffectKey: row.provider_effect_key ?? row.idempotency_key,
      payloadHash: row.payload_hash ?? sha256(canonicalJson(JSON.parse(row.payload_json))),
      guarantee: (row.delivery_guarantee as WorkDeliveryGuarantee | null) ?? "best-effort-unqueryable",
      claimGeneration: row.claim_generation ?? 1, status: row.status,
      claimedAt: row.claimed_at ?? 0, settledAt: row.settled_at ?? undefined, receipt: row.receipt ?? undefined };
  }

  private assertAuthority(): void { if (this.options.isAuthority && !this.options.isAuthority()) throw new Error("当前宿主不持有通知权威"); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
