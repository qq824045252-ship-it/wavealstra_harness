import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkDto, WorkNotificationChannel, WorkNotificationDto } from "../../../shared/bot-work";
import type { WorkNotificationIdentity } from "../../../shared/bot-work-collaboration";
import type { WorkArtifactValidation } from "./WorkArtifactValidation";
import { ensureWorkCollaborationTables } from "./WorkCollaborationService";
import type { WorkService } from "./WorkService";

const identitySchema = z.object({ input_snapshot_id: z.string(), owner_epoch: z.number(), sender_bot_id: z.string(),
  semantic_validity: z.enum(["active", "superseded", "cancelled"]) });
const attemptSchema = z.object({ attempt_id: z.string(), notification_id: z.string(), ordinal: z.number(), channel: z.string(),
  idempotency_key: z.string(), payload_json: z.string(), status: z.enum(["unknown", "sent", "missing", "failed"]) });
// Persisted channel payloads are immutable and parsed at the database boundary.
const notificationSchema = z.object({ notificationId: z.string(), workId: z.string(), semanticKey: z.string(),
  kind: z.enum(["result", "blocked", "closed", "handoff"]), title: z.string(), body: z.string().optional(),
  stateVersion: z.number(), intentRevision: z.number(), delivery: z.enum(["pending", "sent", "unknown", "failed"]),
  channel: z.string().optional(), idempotencyKey: z.string().optional(), attemptCount: z.number(),
  externalReceipt: z.string().optional(), readAt: z.number().optional(), createdAt: z.number(), sentAt: z.number().optional(),
  inputSnapshotId: z.string().optional(), ownerEpoch: z.number().optional(), senderBotId: z.string().optional(),
  semanticValidity: z.enum(["active", "superseded", "cancelled"]).optional(),
});
type Attempt = z.infer<typeof attemptSchema>;
type Options = { now?: () => number; isAuthority?: () => boolean; artifacts?: Pick<WorkArtifactValidation, "capture" | "validate"> };
type Outcome = { notificationId: string; delivery: WorkNotificationDto["delivery"] };

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

  deliver(channel: WorkNotificationChannel, workId?: string): Outcome[] {
    this.assertAuthority();
    const works = workId ? [this.works.getWork(workId)].filter((value): value is WorkDto => Boolean(value))
      : this.works.repo.listWorksForNotifications();
    const outcomes: Outcome[] = [];
    // Only IDs survive this loop. A previous send/lookup can synchronously change the next Work.
    for (const work of works) for (const id of this.works.repo.listNotifications(work.workId).map(item => item.notificationId)) {
      if (this.sending.has(id)) continue;
      const current = this.works.repo.getNotification(id);
      if (!current || current.delivery === "sent" || current.delivery === "failed" || current.channel && current.channel !== channel.channel) continue;
      const unresolved = this.lastAttempt(id);
      if (current.delivery === "unknown" && unresolved?.status === "unknown") {
        const payload = notificationSchema.parse(JSON.parse(unresolved.payload_json));
        let lookup: "delivered" | "missing" | "unknown" = "unknown";
        // Resolve the original effect even if its payload is now semantically obsolete.
        if (channel.idempotent) try { lookup = channel.lookup?.({ notification: payload, idempotencyKey: unresolved.idempotency_key }) ?? "unknown"; } catch { /* retain unknown */ }
        if (lookup === "delivered") {
          this.settle(unresolved, "sent", "reconciled-by-idempotency-key");
          outcomes.push({ notificationId: id, delivery: "sent" }); continue;
        }
        if (lookup === "unknown") { outcomes.push({ notificationId: id, delivery: "unknown" }); continue; }
        this.settle(unresolved, "missing");
      } else if (current.delivery === "unknown") {
        // Unknown without an immutable claim is a recovery blocker, never a fresh send.
        outcomes.push({ notificationId: id, delivery: "unknown" }); continue;
      }
      // File reads/hash work stays outside the short claim transaction.
      const inspection = this.options.artifacts?.capture(work.workId);
      const claim = this.works.transaction((): { attempt: Attempt; notification: WorkNotificationDto } | undefined => {
        this.assertAuthority();
        const notification = this.works.repo.getNotification(id);
        const latest = this.works.getWork(work.workId);
        if (!notification || !latest || notification.delivery === "sent" || notification.delivery === "failed") return;
        if (this.lastAttempt(id)?.status === "unknown") return;
        const identity = this.identity(id);
        if (!identity || identity.semanticValidity !== "active") return;
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
            .run(cancelled ? "cancelled" : "superseded", id);
          const changed = this.works.getWork(latest.workId)!;
          this.works.repo.updateWork({ ...changed, stateVersion: changed.stateVersion + 1, updatedAt: this.now() });
          this.works.emitCurrentProjection(latest.workId);
          return;
        }
        const ordinal = notification.attemptCount + 1;
        if (ordinal > 3) { this.works.repo.updateNotificationDelivery(id, { delivery: "failed" }); return; }
        const previous = this.lastAttempt(id);
        const ownerChanged = identity.ownerEpoch !== latest.ownerEpoch || identity.senderBotId !== latest.ownerBotId;
        const ownerName = z.object({ display_name: z.string() }).parse(this.db.prepare("SELECT display_name FROM bots WHERE bot_id=?").get(latest.ownerBotId)).display_name;
        const key = previous ? `work-notify:${id}:attempt:${ordinal}` : `work-notify:${id}`;
        const attemptPayload: WorkNotificationDto = { ...notification, stateVersion: latest.stateVersion,
          body: ownerChanged ? `${notification.body ?? ""}\n当前负责人：${ownerName}` : notification.body,
          ...{ inputSnapshotId: latest.inputSnapshotId, ownerEpoch: latest.ownerEpoch, senderBotId: latest.ownerBotId, semanticValidity: "active" },
          delivery: "pending", attemptCount: ordinal, channel: channel.channel, idempotencyKey: key };
        // A changed payload is assigned a fresh provider identity only after the old
        // attempt has an explicit missing/failed receipt. Unknown is never overwritten.
        const attempt: Attempt = { attempt_id: `${id}:${ordinal}`, notification_id: id, ordinal,
          channel: channel.channel, idempotency_key: key, payload_json: JSON.stringify(attemptPayload), status: "unknown" };
        this.db.prepare(`INSERT INTO work_notification_attempts(attempt_id,notification_id,ordinal,channel,idempotency_key,payload_json,status,claimed_at)
          VALUES (?,?,?,?,?,?,'unknown',?)`).run(attempt.attempt_id, id, ordinal, channel.channel, key, attempt.payload_json, this.now());
        this.db.prepare("UPDATE work_notification_identity SET owner_epoch=?,sender_bot_id=? WHERE notification_id=?")
          .run(latest.ownerEpoch, latest.ownerBotId, id);
        this.works.repo.updateNotificationDelivery(id, { delivery: "unknown", channel: channel.channel, attemptCount: ordinal, idempotencyKey: key });
        return { attempt, notification: attemptPayload };
      });
      if (!claim) {
        const latest = this.works.repo.getNotification(id);
        if (latest) outcomes.push({ notificationId: id, delivery: latest.delivery });
        continue;
      }
      let response: ReturnType<WorkNotificationChannel["send"]>;
      this.sending.add(id);
      try { response = channel.send({ notification: claim.notification, idempotencyKey: claim.attempt.idempotency_key }); }
      catch { outcomes.push({ notificationId: id, delivery: "unknown" }); continue; }
      finally { this.sending.delete(id); }
      if (response.ok) this.settle(claim.attempt, "sent", response.receipt);
      else if (response.responseLost) {
        let lookup: "delivered" | "missing" | "unknown" = "unknown";
        if (channel.idempotent) try { lookup = channel.lookup?.({ notification: claim.notification, idempotencyKey: claim.attempt.idempotency_key }) ?? "unknown"; } catch { /* retain original attempt */ }
        if (lookup === "delivered") this.settle(claim.attempt, "sent", "reconciled-by-idempotency-key");
        else if (lookup === "missing") this.settle(claim.attempt, "missing");
      } else this.settle(claim.attempt, "failed", undefined, response.retryable && claim.attempt.ordinal < 3);
      outcomes.push({ notificationId: id, delivery: this.works.repo.getNotification(id)?.delivery ?? "unknown" });
    }
    return outcomes;
  }

  private settle(attempt: Attempt, status: Attempt["status"], receipt?: string, retryable = false): void {
    this.works.transaction(() => {
      this.assertAuthority();
      const updated = this.db.prepare("UPDATE work_notification_attempts SET status=?,settled_at=?,receipt=? WHERE attempt_id=? AND status='unknown'")
        .run(status, this.now(), receipt ?? null, attempt.attempt_id);
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
  private assertAuthority(): void { if (this.options.isAuthority && !this.options.isAuthority()) throw new Error("当前宿主不持有通知权威"); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
