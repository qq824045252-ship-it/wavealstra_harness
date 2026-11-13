import type { NotificationActivation } from "@shared/notification";

/** A failed navigation consumes only this click, never its persistent notification target. */
export async function deliverNotificationActivation(
  activation: NotificationActivation,
  host: {
    disposed: () => boolean;
    navigate: () => Promise<void>;
    markRead: (id: string) => Promise<void>;
    acknowledge: (id: string) => Promise<void>;
    showError: (message: string) => void;
  },
): Promise<boolean> {
  try {
    await host.navigate();
    if (host.disposed()) return false;
    await host.markRead(activation.notificationId);
  } catch (error) {
    if (host.disposed()) return false;
    host.showError(error instanceof Error ? error.message : String(error));
  }
  if (host.disposed()) return false;
  // Let an acknowledgement transport failure escape to the drain's outer catch.
  // It must stop rather than spin on an unchanged queue head.
  await host.acknowledge(activation.notificationId);
  return !host.disposed();
}
