import type { WorkNotificationChannel } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

/**
 * Production delivery loop for Work notifications.
 *
 * It runs only while this host holds the Work authority, drains every pending/unknown
 * intent through the configured real channels, and never starts a second concurrent drain.
 * Delivery is a background obligation: it must not depend on the user opening a page, and
 * it must survive a host restart by resuming from persisted attempts.
 */
export class WorkNotificationHost {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private wakeRequested = false;
  private started = false;

  constructor(private readonly works: WorkService, private readonly options: {
    isAuthority: () => boolean;
    channels: () => WorkNotificationChannel[];
    intervalMs?: number;
    /** Injected for tests; the host does not read the wall clock directly. */
    now?: () => number;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const interval = this.options.intervalMs ?? 15_000;
    this.timer = setInterval(() => this.drain(), interval);
    this.timer.unref?.();
    this.drain();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Called after a Work fact changes; coalesced so a burst of projections is one drain. */
  wake(): void {
    if (!this.started || this.wakeRequested) return;
    this.wakeRequested = true;
    setTimeout(() => {
      this.wakeRequested = false;
      this.drain();
    }, 0).unref?.();
  }

  /** One bounded pass over every configured channel. Exposed for tests. */
  drain(workId?: string): Array<{ channel: string; notificationId: string; delivery: string }> {
    if (this.draining) return [];
    if (!this.options.isAuthority()) return [];
    this.draining = true;
    const results: Array<{ channel: string; notificationId: string; delivery: string }> = [];
    try {
      for (const channel of this.options.channels()) {
        if (!this.options.isAuthority()) break;
        try {
          for (const outcome of this.works.deliverPendingNotifications(channel, workId)) {
            results.push({ channel: channel.channel, ...outcome });
          }
        } catch (error) {
          // One broken channel must not stop the others or crash the host loop.
          this.options.onError?.(error);
        }
      }
    } finally {
      this.draining = false;
    }
    return results;
  }
}
