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
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDrain = false;
  private lifecycleGeneration = 0;
  private started = false;

  constructor(private readonly works: Pick<WorkService, "deliverPendingNotifications">, private readonly options: {
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
    this.lifecycleGeneration++;
    this.pendingDrain = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Called after a Work fact changes; coalesced so a burst of projections is one drain. */
  wake(): void {
    if (!this.started) return;
    if (this.draining) { this.pendingDrain = true; return; }
    if (this.wakeTimer) return;
    const generation = this.lifecycleGeneration;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.started && generation === this.lifecycleGeneration) this.drain();
    }, 0);
    this.wakeTimer.unref?.();
  }

  /** Drain, then rescan facts if a synchronous channel or projection callback reenters. */
  drain(workId?: string): Array<{ channel: string; notificationId: string; delivery: string }> {
    if (!this.options.isAuthority()) return [];
    if (this.draining) { this.pendingDrain = true; return []; }
    this.draining = true;
    const results: Array<{ channel: string; notificationId: string; delivery: string }> = [];
    const generation = this.lifecycleGeneration;
    let scope = workId;
    try {
      do {
        this.pendingDrain = false;
        for (const channel of this.options.channels()) {
          if (generation !== this.lifecycleGeneration || !this.options.isAuthority()) break;
          try {
            for (const outcome of this.works.deliverPendingNotifications(channel, scope)) {
              results.push({ channel: channel.channel, ...outcome });
            }
          } catch (error) {
            // One broken channel must not stop the others or crash the host loop.
            this.options.onError?.(error);
          }
        }
        // Reentrant requests may concern another Work, so the trailing scan is global.
        scope = undefined;
      } while (this.pendingDrain && generation === this.lifecycleGeneration && this.options.isAuthority());
    } finally {
      this.pendingDrain = false;
      this.draining = false;
    }
    return results;
  }
}
