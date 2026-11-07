import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkNotificationChannel, WorkNotificationDto } from "../../../shared/bot-work";
import type { WorkNotificationIdentity } from "../../../shared/bot-work-collaboration";
import {
  canonicalJson, capabilityOfGuarantee, capabilityIsConsistent, deliveryRecoveryAction,
  type WorkChannelCapability, type WorkDeliveryAttemptDto, type WorkDeliveryGuarantee,
} from "../../../shared/bot-work-phase5";
import type { ArtifactInspection, WorkArtifactValidation } from "./WorkArtifactValidation";
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
  kind: z.enum(["result", "blocked", "closed", "handoff", "summary"]), title: z.string(), body: z.string().optional(),
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
export type WorkNotificationOutcome = { notificationId: string; delivery: WorkNotificationDto["delivery"]; blockedReason?: string };
type Outcome = WorkNotificationOutcome;
type ScanPosition = { notification_id: string; created_at: number };
type SendResult = ReturnType<WorkNotificationChannel["send"]>;
type Endpoint = Omit<WorkNotificationChannel, "send" | "lookup"> & {
  send?: unknown;
  lookup?: unknown;
  admit?: (notification: WorkNotificationDto) => string | undefined;
};
export interface AsyncWorkNotificationChannel extends Omit<Endpoint, "lookup"> {
  send(input: { notification: WorkNotificationDto; idempotencyKey: string; signal?: AbortSignal;
    assertCurrent: () => void }): Promise<SendResult>;
  lookup?(input: { notification: WorkNotificationDto; idempotencyKey: string; signal?: AbortSignal }): Promise<"delivered" | "missing" | "unknown">;
}
export interface WorkAsyncDeliveryOptions { signal?: AbortSignal; isActive?: () => boolean; limit?: number }


const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Declared capability of a real endpoint. A channel may not claim replay safety without a
 * stable effect key, nor read-back without that key, and conflicting declarations throw
 * instead of silently downgrading to "best effort".
 */
export function resolveChannelCapability(channel: Endpoint): WorkChannelCapability {
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
  // Scheduling cursors only: delivery truth stays in the persisted attempt ledger.
  // Scope by endpoint and optional Work so one targeted drain cannot move another's scan.
  private readonly asyncCursors = new Map<string, { after?: ScanPosition; through: ScanPosition }>();
  // Runtime endpoint declarations are admission evidence, not a second delivery ledger.
  private readonly channelCapabilities = new Map<string, WorkChannelCapability>();
  private readonly channelAdmissions = new Map<string, NonNullable<Endpoint["admit"]>>();
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
    if (!prior || prior.status !== "unknown" || notification.delivery !== "unknown") {
      return { ok: false, message: "只有外部投递结果未知的通知需要人工重发" };
    }
    const work = this.works.getWork(notification.workId);
    const identity = this.identity(notification.notificationId);
    if (!work || !identity || identity.semanticValidity !== "active" || notification.intentRevision !== work.intentRevision
      || identity.inputSnapshotId !== work.inputSnapshotId) return { ok: false, message: "过期通知不能授权为当前结论重发" };
    if (notification.kind === "summary" && (!this.works.phase5.isOwnerSummaryCurrent(work, notification.cardKey)
      || work.lifecycle === "closing" && work.pendingConclusion === "cancelled")) {
      return { ok: false, message: "主负责人汇总已过期或事项正在取消，不能作为当前结论重发" };
    }
    const targetKey = input.targetKey ?? notification.targetKey;
    const endpointKey = this.channelKey(prior.channel, targetKey);
    const blocked = this.channelAdmissions.get(endpointKey)?.(notification);
    if (blocked) return { ok: false, message: blocked };
    const capability = this.channelCapabilities.get(endpointKey);
    if (!capability) return { ok: false, message: "通知渠道尚未在当前宿主核验，请等待渠道恢复后再确认重发" };
    const payload: WorkNotificationDto = { ...notification, delivery: "pending",
      attemptCount: notification.attemptCount + 1, channel: notification.channel ?? prior.channel,
      targetKey, inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch,
      senderBotId: work.ownerBotId, semanticValidity: "active" };
    const payloadHash = sha256(canonicalJson(payload));
    const effectKey = `effect:${input.notificationId}:resend:${input.operationId}`;
    this.db.prepare(`INSERT OR IGNORE INTO work_notification_effects (
      effect_key,notification_id,payload_hash,payload_json,channel,target_key,delivery_guarantee,
      supports_idempotency_key,supports_receipt_query,authorization_kind,authorization_operation_id,
      authorization_reason,resend_of_attempt_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?, 'manual-resend', ?,?,?,?)`).run(
      effectKey, input.notificationId, payloadHash, canonicalJson(payload), prior.channel,
      targetKey ?? null, capability.deliveryGuarantee,
      capability.supportsIdempotencyKey ? 1 : 0, capability.supportsReceiptQuery ? 1 : 0,
      input.operationId, input.reason, prior.attempt_id, this.now(),
    );
    this.works.repo.updateNotificationLinks(input.notificationId, { effectKey, cardKey: notification.cardKey, targetKey });
    this.works.repo.updateNotificationDelivery(input.notificationId, { delivery: "pending", channel: notification.channel ?? prior.channel });
    return { ok: true, effectKey };
  }

  deliver(channel: WorkNotificationChannel, workId?: string): Outcome[] {
    this.assertAuthority();
    const capability = resolveChannelCapability(channel);
    this.channelCapabilities.set(this.channelKey(channel.channel, channel.targetKey), capability);
    const works = workId ? [this.works.getWork(workId)].filter((value): value is WorkDto => Boolean(value))
      : this.works.repo.listWorksForNotifications();
    const outcomes: Outcome[] = [];
    // Only IDs survive this loop. A previous send/lookup can synchronously change the next Work.
    for (const work of works) for (const id of this.works.repo.listNotifications(work.workId).map(item => item.notificationId)) {
      if (this.sending.has(id)) continue;
      this.assertAuthority();
      const current = this.works.repo.getNotification(id);
      if (!current || current.delivery === "sent" || current.delivery === "failed") continue;
      if (current.channel && current.channel !== channel.channel) continue;
      if (current.targetKey && current.targetKey !== channel.targetKey) continue;
      const prior = this.lastAttempt(id);
      // An explicit resend authorization outranks the automatic recovery path: the user has
      // already accepted the duplicate risk, and the frozen payload is what gets sent.
      const authorizedEffect = this.authorizedEffect(current, prior, channel, capability);
      const resendAuthorized = authorizedEffect !== undefined;

      if (!resendAuthorized && prior?.status === "unknown") {
        // Resolve the original effect even if its payload is now semantically obsolete.
        // Its endpoint contract and target must still be the ones that admitted it.
        const effect = this.effectOf(prior);
        if (!effect || !this.matchesChannel(effect, channel, capability)) {
          outcomes.push({ notificationId: id, delivery: "unknown" }); continue;
        }
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
          outcomes.push({ notificationId: id, delivery: this.works.repo.getNotification(id)!.delivery });
          continue;
        }
        if (action === "stay-unknown" || action === "manual-resend-only") {
          outcomes.push({ notificationId: id, delivery: "unknown" });
          continue;
        }
        // Safe replay: reuse the original effect key and the original, immutable payload.
        const replayed = this.claimReplay(id, prior, capability, channel);
        if (!replayed) { outcomes.push({ notificationId: id, delivery: this.works.repo.getNotification(id)!.delivery }); continue; }
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

  /** Network waits never hold SQLite transactions. A route must be explicit before async delivery. */
  async deliverAsync(channel: AsyncWorkNotificationChannel, workId?: string, options: WorkAsyncDeliveryOptions = {}): Promise<Outcome[]> {
    if (!this.asyncActive(options)) return [];
    if (!channel.targetKey) throw new Error("异步通知必须绑定明确接收目标");
    const capability = resolveChannelCapability(channel);
    const endpointKey = this.channelKey(channel.channel, channel.targetKey);
    this.channelCapabilities.set(endpointKey, capability);
    if (channel.admit) this.channelAdmissions.set(endpointKey, channel.admit);
    const scanKey = canonicalJson([channel.channel, channel.targetKey, workId ?? null]);
    let cursor = this.asyncCursors.get(scanKey);
    if (!cursor) {
      // Freeze the tail for this sweep: continuous arrivals must not prevent a return
      // to old unknown/temporarily blocked intents that now need another check.
      const through = this.db.prepare(`SELECT notification_id, created_at FROM work_notifications
        WHERE channel=? AND target_key=? AND delivery IN ('pending','unknown') AND (? IS NULL OR work_id=?)
        ORDER BY created_at DESC, notification_id DESC LIMIT 1`)
        .get(channel.channel, channel.targetKey, workId ?? null, workId ?? null) as ScanPosition | undefined;
      if (!through) return [];
      cursor = { through };
      this.asyncCursors.set(scanKey, cursor);
    }
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    // Rotate a bounded batch through ALL unresolved intents. Permanently inadmissible
    // pending rows must not pin the head, and unknown attempts still need receipt lookup
    // even when their semantic identity has since been superseded or cancelled.
    const ids = this.db.prepare(`SELECT notification_id, created_at FROM work_notifications
      WHERE channel=? AND target_key=? AND delivery IN ('pending','unknown') AND (? IS NULL OR work_id=?)
        AND (? IS NULL OR (created_at, notification_id) > (?, ?))
        AND (created_at, notification_id) <= (?, ?)
      ORDER BY created_at, notification_id LIMIT ?`)
      .all(channel.channel, channel.targetKey, workId ?? null, workId ?? null,
        cursor.after?.created_at ?? null, cursor.after?.created_at ?? null, cursor.after?.notification_id ?? null,
        cursor.through.created_at, cursor.through.notification_id, limit) as ScanPosition[];
    if (!ids.length) this.asyncCursors.delete(scanKey);
    const outcomes: Outcome[] = [];
    for (const position of ids) {
      if (!this.asyncActive(options)) break;
      const id = position.notification_id;
      cursor.after = position;
      if (position === ids.at(-1) && (ids.length < limit
        || position.created_at === cursor.through.created_at && id === cursor.through.notification_id)) {
        this.asyncCursors.delete(scanKey);
      }
      if (this.sending.has(id)) continue;
      const current = this.works.repo.getNotification(id);
      if (!current || !["pending", "unknown"].includes(current.delivery)
        || current.channel !== channel.channel || current.targetKey !== channel.targetKey) continue;
      const blockedReason = channel.admit?.(current);
      if (blockedReason) { outcomes.push({ notificationId: id, delivery: current.delivery, blockedReason }); continue; }
      const prior = this.lastAttempt(id);
      const authorized = this.authorizedEffect(current, prior, channel, capability);
      if (!authorized && prior?.status === "unknown") {
        const effect = this.effectOf(prior);
        if (!effect || !this.matchesChannel(effect, channel, capability)) {
          outcomes.push({ notificationId: id, delivery: "unknown", blockedReason: "原投递渠道契约已改变，不能自动恢复" }); continue;
        }
        let lookup: "delivered" | "missing" | "unknown" | "unavailable" = "unavailable";
        if (capability.supportsReceiptQuery && channel.lookup) {
          this.sending.add(id);
          try { lookup = await channel.lookup({ notification: notificationSchema.parse(JSON.parse(prior.payload_json)),
            idempotencyKey: prior.provider_effect_key ?? prior.idempotency_key, signal: options.signal }); }
          catch { lookup = "unknown"; }
          finally { this.sending.delete(id); }
          if (!this.asyncActive(options)) break;
        }
        const action = deliveryRecoveryAction({ lookup, capability });
        if (action === "settle-sent") {
          this.settle(prior, "sent", "reconciled-by-provider-receipt");
          outcomes.push({ notificationId: id, delivery: this.works.repo.getNotification(id)!.delivery });
          continue;
        }
        if (action === "stay-unknown" || action === "manual-resend-only") {
          outcomes.push({ notificationId: id, delivery: "unknown" }); continue;
        }
        const claim = this.claimReplay(id, prior, capability, channel);
        outcomes.push(claim ? await this.dispatchAsync(channel, claim, options)
          : { notificationId: id, delivery: this.works.repo.getNotification(id)!.delivery });
        continue;
      }
      if (current.delivery === "unknown") { outcomes.push({ notificationId: id, delivery: "unknown" }); continue; }
      // Proven pre-send failures can retry, but projection wakes do not erase backoff.
      if (!authorized && prior?.settled_at && this.now() - prior.settled_at < 1000 * 2 ** Math.min(2, (prior.claim_generation ?? 1) - 1)) {
        outcomes.push({ notificationId: id, delivery: current.delivery }); continue;
      }
      const claim = this.claim(id, channel, capability);
      outcomes.push(claim ? await this.dispatchAsync(channel, claim, options)
        : { notificationId: id, delivery: this.works.repo.getNotification(id)!.delivery });
    }
    return outcomes;
  }

  private async dispatchAsync(channel: AsyncWorkNotificationChannel,
    claim: { attempt: Attempt; notification: WorkNotificationDto }, options: WorkAsyncDeliveryOptions): Promise<Outcome> {
    const id = claim.attempt.notification_id;
    this.sending.add(id);
    try {
      let response: SendResult;
      try {
        this.assertAsyncClaimCurrent(claim, channel, options);
        response = await channel.send({ notification: claim.notification,
          idempotencyKey: claim.attempt.provider_effect_key ?? claim.attempt.idempotency_key, signal: options.signal,
          assertCurrent: () => this.assertAsyncClaimCurrent(claim, channel, options) });
      } catch { return { notificationId: id, delivery: "unknown" }; }
      if (!this.asyncActive(options)) return { notificationId: id, delivery: "unknown" };
      if (response.ok) this.settle(claim.attempt, "sent", response.receipt);
      else if (!response.responseLost) this.settle(claim.attempt, "failed", undefined,
        response.retryable && (claim.attempt.claim_generation ?? 1) < 3);
      // A lost response stays unknown. A subsequent drain may query the same immutable
      // attempt only if that endpoint actually declares a receipt-query contract.
      return { notificationId: id, delivery: this.works.repo.getNotification(id)?.delivery ?? "unknown" };
    } finally { this.sending.delete(id); }
  }

  private assertAsyncClaimCurrent(claim: { attempt: Attempt; notification: WorkNotificationDto },
    channel: AsyncWorkNotificationChannel, options: WorkAsyncDeliveryOptions): void {
    if (!this.asyncActive(options)) throw new Error("通知宿主已停止或不再持有权威");
    const inspection = this.options.artifacts?.capture(claim.notification.workId);
    const admitted = this.works.transaction(() => {
      this.assertAuthority();
      if (!this.asyncActive(options)) throw new Error("通知宿主已停止");
      const current = this.works.repo.getNotification(claim.attempt.notification_id);
      const work = this.works.getWork(claim.notification.workId);
      const latest = this.lastAttempt(claim.attempt.notification_id);
      const effect = this.effectOf(claim.attempt);
      if (!current || !work || current.effectKey !== claim.attempt.provider_effect_key
        || current.attemptCount !== claim.attempt.ordinal || latest?.attempt_id !== claim.attempt.attempt_id
        || latest.status !== "unknown" || latest.claim_generation !== claim.attempt.claim_generation
        || latest.payload_hash !== claim.attempt.payload_hash || !effect
        || !this.matchesChannel(effect, channel, resolveChannelCapability(channel))
        || !this.payloadIsCurrent(claim.notification, work) || channel.admit?.(current)) return false;
      return Boolean(this.admit(current, work, inspection));
    });
    if (!admitted) throw new Error("通知发送认领或语义授权已过期");
  }

  private asyncActive(options: WorkAsyncDeliveryOptions): boolean {
    return !options.signal?.aborted && (options.isActive?.() ?? true) && (this.options.isAuthority?.() ?? true);
  }

  private authorizedEffect(notification: WorkNotificationDto, prior: Attempt | undefined,
    channel: Endpoint, capability: WorkChannelCapability): Effect | undefined {
    const effect = this.pendingResendEffect(notification.notificationId);
    if (effect && !this.matchesChannel(effect, channel, capability)) {
      this.works.transaction(() => {
        this.assertAuthority();
        const latest = this.works.repo.getNotification(notification.notificationId);
        if (latest?.delivery !== "pending" || latest.effectKey !== effect.effect_key) return;
        this.works.repo.updateNotificationLinks(notification.notificationId, { effectKey: prior?.provider_effect_key ?? prior?.idempotency_key });
        this.works.repo.updateNotificationDelivery(notification.notificationId, { delivery: "unknown" });
        const work = this.works.getWork(latest.workId);
        if (work) {
          this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: this.now() });
          this.works.emitCurrentProjection(work.workId);
        }
      });
      throw new Error(`通知 ${notification.notificationId} 的人工重发渠道能力已改变；未发送，原回执仍未知，请重新确认重复风险`);
    }
    return effect;
  }

  /** File reads/hash work stays outside the short claim transaction. */
  private claim(notificationId: string, channel: Endpoint,
    capability: WorkChannelCapability): { attempt: Attempt; notification: WorkNotificationDto } | undefined {
    const workId = this.works.repo.getNotification(notificationId)?.workId;
    if (!workId) return undefined;
    const inspection = this.options.artifacts?.capture(workId);
    return this.works.transaction((): { attempt: Attempt; notification: WorkNotificationDto } | undefined => {
      this.assertAuthority();
      const notification = this.works.repo.getNotification(notificationId);
      const latest = this.works.getWork(workId);
      if (!notification || !latest || notification.delivery === "sent" || notification.delivery === "failed"
        || channel.admit?.(notification)) return undefined;
      // An unresolved earlier attempt blocks automatic sends, but an explicitly authorized
      // resend is a new physical attempt under a new effect identity and may proceed.
      const authorized = this.pendingResendEffect(notificationId);
      if (authorized && !this.matchesChannel(authorized, channel, capability)) return undefined;
      const prior = this.lastAttempt(notificationId);
      if (!authorized && prior?.status === "unknown") return undefined;
      const identity = this.admit(notification, latest, inspection);
      if (!identity) return undefined;
      const ownerChanged = identity.ownerEpoch !== latest.ownerEpoch || identity.senderBotId !== latest.ownerBotId;
      const ownerName = z.object({ display_name: z.string() }).parse(this.db.prepare("SELECT display_name FROM bots WHERE bot_id=?").get(latest.ownerBotId)).display_name;
      const ordinal = notification.attemptCount + 1;
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
      const continuing = !authorized && prior ? this.effectOf(prior) : undefined;
      const effect = authorized ?? continuing ?? this.ensureInitialEffect(notificationId, candidate, candidateHash, channel, capability);
      if (!effect || !this.matchesChannel(effect, channel, capability)) return undefined;
      if (effect.authorization_kind === "initial" && effect.payload_hash !== candidateHash) return undefined;
      // The physical attempt always sends the frozen effect payload, never a rebuilt one.
      const payload = notificationSchema.parse(JSON.parse(effect.payload_json));
      if (!this.payloadIsCurrent(payload, latest) || sha256(canonicalJson(payload)) !== effect.payload_hash) return undefined;
      const siblings = (this.db.prepare("SELECT COUNT(*) AS count FROM work_notification_attempts WHERE provider_effect_key=?")
        .get(effect.effect_key) as { count: number }).count;
      if (siblings >= 3) { this.works.repo.updateNotificationDelivery(notificationId, { delivery: "failed" }); return undefined; }
      const payloadHash = effect.payload_hash;
      const attemptKey = `${notificationId}:${ordinal}`;
      const providerEffectKey = effect.effect_key;
      // A changed payload is assigned a fresh provider identity only after the old
      // attempt has an explicit missing/failed receipt. Unknown is never overwritten.
      const attempt: Attempt = { attempt_id: attemptKey, notification_id: notificationId, ordinal,
        channel: channel.channel, idempotency_key: providerEffectKey, payload_json: JSON.stringify(payload), status: "unknown",
        provider_effect_key: providerEffectKey, payload_hash: payloadHash,
        delivery_guarantee: capability.deliveryGuarantee, claim_generation: siblings + 1, claimed_at: this.now() };
      this.db.prepare(`INSERT INTO work_notification_attempts(attempt_id,notification_id,ordinal,channel,idempotency_key,
        provider_effect_key,payload_hash,delivery_guarantee,claim_generation,payload_json,status,claimed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'unknown',?)`).run(attempt.attempt_id, notificationId, ordinal, channel.channel,
        attempt.idempotency_key, providerEffectKey, payloadHash, capability.deliveryGuarantee, attempt.claim_generation, attempt.payload_json, this.now());
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
    channel: Endpoint): { attempt: Attempt; notification: WorkNotificationDto } | undefined {
    const workId = this.works.repo.getNotification(notificationId)?.workId;
    if (!workId) return undefined;
    const inspection = this.options.artifacts?.capture(workId);
    return this.works.transaction((): { attempt: Attempt; notification: WorkNotificationDto } | undefined => {
      this.assertAuthority();
      const notification = this.works.repo.getNotification(notificationId);
      const latest = this.works.getWork(workId);
      if (!notification || !latest || notification.delivery !== "unknown"
        || this.lastAttempt(notificationId)?.attempt_id !== prior.attempt_id
        || notification.effectKey !== (prior.provider_effect_key ?? prior.idempotency_key)) return undefined;
      if (channel.admit?.(notification) || !this.admit(notification, latest, inspection)) return undefined;
      const effectKey = prior.provider_effect_key ?? prior.idempotency_key;
      const effect = this.effectOf(prior);
      if (!effect || !this.matchesChannel(effect, channel, capability)) return undefined;
      if (effect.payload_hash !== (prior.payload_hash ?? sha256(canonicalJson(JSON.parse(prior.payload_json))))) return undefined;
      const siblingAttempts = (this.db.prepare("SELECT COUNT(*) AS count FROM work_notification_attempts WHERE provider_effect_key=?")
        .get(effectKey) as { count: number }).count;
      // Exhausting the automatic budget does not prove that an earlier external
      // effect failed. Keep unknown so receipt reconciliation/manual resend remain valid.
      if (siblingAttempts >= 3) return undefined;
      const ordinal = notification.attemptCount + 1;
      const payload = notificationSchema.parse(JSON.parse(prior.payload_json));
      if (!this.payloadIsCurrent(payload, latest) || sha256(canonicalJson(payload)) !== effect.payload_hash) return undefined;
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

  /** Every new physical send, including recovery, needs current semantic/artifact proof. */
  private admit(notification: WorkNotificationDto, latest: WorkDto, inspection?: ArtifactInspection): WorkNotificationIdentity | undefined {
    const notificationId = notification.notificationId;
    const identity = this.identity(notificationId);
    if (!identity || identity.semanticValidity !== "active") return undefined;
    const cancelled = ["result", "summary"].includes(notification.kind) && (latest.lifecycle === "closing" && latest.pendingConclusion === "cancelled"
      || latest.lifecycle === "closed" && latest.closureConclusion === "cancelled");
    const revisionChanged = notification.intentRevision !== latest.intentRevision || identity.inputSnapshotId !== latest.inputSnapshotId;
    const card = notification.cardKey ? this.works.cards.list(latest).find(item => item.cardKey === notification.cardKey) : undefined;
    const accepted = this.works.repo.listDeliverables(latest.workId).filter(item => item.status === "accepted"
      && latest.acceptedDeliverableIds.includes(item.deliverableId) && item.intentRevision === latest.intentRevision
      && item.inputSnapshotId === latest.inputSnapshotId);
    const summaryBindings = notification.kind === "summary"
      ? accepted.filter(item => card?.deliverableIds.includes(item.deliverableId)).map(item => item.executionId) : undefined;
    const hasArtifacts = accepted.some(item => item.artifactRefs.length > 0);
    const needsArtifactProof = ["result", "summary"].includes(notification.kind)
      || notification.kind === "closed" && latest.closureConclusion === "succeeded";
    const artifactsValid = !needsArtifactProof || (inspection !== undefined
      ? this.options.artifacts!.validate(inspection, this.now(), summaryBindings) : !hasArtifacts);
    const currentDeliverable = notification.kind !== "result" || this.works.repo.listDeliverables(latest.workId).some(item =>
      latest.acceptedDeliverableIds.includes(item.deliverableId) && item.status === "accepted"
      && item.intentRevision === latest.intentRevision && item.inputSnapshotId === latest.inputSnapshotId
      && (`notification-${latest.workId}-${item.deliverableId}` === notification.notificationId
        || notification.semanticKey === `work:${latest.workId}:result:${item.deliverableId}`
        || card?.currency !== "historical" && ["accepted_result", "closure_succeeded"].includes(card?.kind ?? "")
          && card?.deliverableIds.includes(item.deliverableId)));
    const currentSummary = notification.kind !== "summary" || this.works.phase5.isOwnerSummaryCurrent(latest, notification.cardKey);
    // Closed:succeeded still has a valid delivery obligation.
    if (cancelled || revisionChanged || !artifactsValid || !currentDeliverable || !currentSummary) {
      this.db.prepare("UPDATE work_notification_identity SET semantic_validity=? WHERE notification_id=?")
        .run(cancelled ? "cancelled" : "superseded", notificationId);
      const changed = this.works.getWork(latest.workId)!;
      this.works.repo.updateWork({ ...changed, stateVersion: changed.stateVersion + 1, updatedAt: this.now() });
      this.works.emitCurrentProjection(latest.workId);
      return undefined;
    }
    return identity;
  }

  private channelKey(channel: string, targetKey?: string): string { return canonicalJson([channel, targetKey ?? null]); }

  private matchesChannel(effect: Effect, channel: Endpoint, capability: WorkChannelCapability): boolean {
    return effect.channel === channel.channel && (effect.target_key ?? undefined) === channel.targetKey
      && effect.delivery_guarantee === capability.deliveryGuarantee
      && Boolean(effect.supports_idempotency_key) === capability.supportsIdempotencyKey
      && Boolean(effect.supports_receipt_query) === capability.supportsReceiptQuery;
  }

  private effectOf(attempt: Attempt): Effect | undefined {
    return effectSchema.optional().parse(this.db.prepare("SELECT * FROM work_notification_effects WHERE effect_key=?")
      .get(attempt.provider_effect_key ?? attempt.idempotency_key));
  }

  private payloadIsCurrent(payload: WorkNotificationDto, work: WorkDto): boolean {
    return payload.workId === work.workId && payload.intentRevision === work.intentRevision
      && payload.inputSnapshotId === work.inputSnapshotId && payload.ownerEpoch === work.ownerEpoch
      && payload.senderBotId === work.ownerBotId;
  }

  /** One initial effect per notification intent; the payload hash freezes what was sent. */
  private ensureInitialEffect(notificationId: string, payload: WorkNotificationDto, payloadHash: string,
    channel: Endpoint, capability: WorkChannelCapability): Effect | undefined {
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
  private pendingResendEffect(notificationId: string): Effect | undefined {
    const effect = effectSchema.optional().parse(this.db.prepare(`SELECT * FROM work_notification_effects
      WHERE notification_id=? AND authorization_kind='manual-resend'
        AND effect_key=(SELECT effect_key FROM work_notifications WHERE notification_id=?)
        AND effect_key NOT IN (SELECT provider_effect_key FROM work_notification_attempts WHERE provider_effect_key IS NOT NULL)
      ORDER BY created_at DESC LIMIT 1`).get(notificationId, notificationId));
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
    } else this.settle(claim.attempt, "failed", undefined, response.retryable && (claim.attempt.claim_generation ?? 1) < 3);
    return { notificationId: id, delivery: this.works.repo.getNotification(id)?.delivery ?? "unknown" };
  }

  /** Settles exactly the claimed attempt; a late receipt can never overwrite a later one. */
  private settle(attempt: Attempt, status: Attempt["status"], receipt?: string, retryable = false): void {
    this.works.transaction(() => {
      this.assertAuthority();
      const effect = this.effectOf(attempt);
      const payload = notificationSchema.parse(JSON.parse(attempt.payload_json));
      if (!effect || effect.channel !== attempt.channel || effect.payload_hash !== attempt.payload_hash
        || (effect.target_key ?? undefined) !== payload.targetKey
        || sha256(canonicalJson(payload)) !== effect.payload_hash) return;
      const updated = this.db.prepare(`UPDATE work_notification_attempts SET status=?,settled_at=?,receipt=?
        WHERE attempt_id=? AND status='unknown' AND claim_generation=? AND payload_hash=? AND provider_effect_key=? AND channel=?`)
        .run(status, this.now(), receipt ?? null, attempt.attempt_id, attempt.claim_generation ?? 1,
          attempt.payload_hash, attempt.provider_effect_key, attempt.channel);
      if (!updated.changes) return;
      const notification = this.works.repo.getNotification(attempt.notification_id);
      // The receipt belongs to this original attempt. A newer manual authorization or
      // claim may already own the notification; its delivery state cannot be overwritten.
      if (notification?.attemptCount === attempt.ordinal && notification.effectKey === attempt.provider_effect_key
        && this.lastAttempt(attempt.notification_id)?.attempt_id === attempt.attempt_id) {
        this.works.repo.updateNotificationDelivery(attempt.notification_id, {
          delivery: status === "sent" ? "sent" : status === "missing" || retryable ? "pending" : status === "failed" ? "failed" : "unknown",
          attemptCount: attempt.ordinal, channel: attempt.channel, idempotencyKey: attempt.idempotency_key,
          externalReceipt: receipt, sentAt: status === "sent" ? this.now() : undefined,
        });
      }
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
