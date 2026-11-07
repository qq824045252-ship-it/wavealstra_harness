import type { NotificationService } from "../../notification/NotificationService";
import type { WorkNotificationChannel } from "../../../shared/bot-work";
import { capabilityOfGuarantee } from "../../../shared/bot-work-phase5";

/**
 * Real desktop channel for Work cards.
 *
 * The effect is a row in the shared notification store keyed by the provider effect key,
 * so re-running the same logical delivery after a crash reads the row back instead of
 * publishing a second notice. A user preference that mutes this kind of notice is a
 * deliberate choice: it is recorded as done (`suppressed:<reason>`) and never retried.
 */
export function createDesktopWorkChannel(notifications: NotificationService): WorkNotificationChannel {
  const effectDedupeKey = (idempotencyKey: string) => `work-delivery:${idempotencyKey}`;
  return {
    channel: "desktop",
    ...capabilityOfGuarantee("idempotent-queryable"),
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
      return { ok: true, receipt: `notification:${published.id}` };
    },
    lookup({ idempotencyKey }) {
      return notifications.findByDedupeKey(effectDedupeKey(idempotencyKey)) ? "delivered" : "missing";
    },
  };
}
