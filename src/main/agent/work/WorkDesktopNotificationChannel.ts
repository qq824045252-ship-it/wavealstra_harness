import type { NotificationService } from "../../notification/NotificationService";
import type { WorkNotificationChannel } from "../../../shared/bot-work";
import { capabilityOfGuarantee } from "../../../shared/bot-work-phase5";

/**
 * Real desktop channel for Work cards.
 *
 * The local notification store provides best-effort duplicate suppression, not a durable
 * provider receipt: rows are retained for a limited period and in-app-disabled delivery
 * uses only an in-memory key. OS presentation also has no queryable receipt. A lost send
 * therefore stays unknown across restart; only an explicit manual resend may try again.
 * A muted preference is a deliberate end state and is recorded as suppressed.
 */
export function createDesktopWorkChannel(notifications: NotificationService): WorkNotificationChannel {
  const effectDedupeKey = (idempotencyKey: string) => `work-delivery:${idempotencyKey}`;
  return {
    channel: "desktop",
    ...capabilityOfGuarantee("best-effort-unqueryable"),
    targetKey: "desktop",
    send({ notification, idempotencyKey }) {
      const dedupeKey = effectDedupeKey(idempotencyKey);
      const existing = notifications.findByDedupeKey(dedupeKey);
      if (existing) return { ok: true, receipt: `notification:${existing.id}` };
      const published = notifications.publish({
        type: notification.kind === "blocked" ? "task.action_required" : "task.completed",
        level: notification.kind === "blocked" ? "warning" : notification.kind === "closed" ? "info" : "success",
        title: notification.title,
        body: notification.body,
        sourceType: "task",
        sourceId: notification.workId,
        dedupeKey,
        createdAt: notification.createdAt,
      });
      if (!published) return { ok: true, receipt: `suppressed:${dedupeKey}` };
      // The service accepted this notification; its DTO may be transient when in-app
      // history is disabled. This is not a persisted or OS-level presentation receipt.
      return { ok: true, receipt: `accepted-notification:${published.id}` };
    },
  };
}
