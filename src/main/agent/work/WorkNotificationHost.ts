import type { WorkNotificationChannel } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { AsyncWorkNotificationChannel, WorkNotificationOutcome } from "./WorkNotificationDelivery";

type HostOutcome = WorkNotificationOutcome & { channel: string };
type HostWork = Pick<WorkService, "deliverPendingNotifications"> & Partial<Pick<WorkService, "notifications" | "phase5">>;
const MAX_INLINE_PASSES = 8;

/** One authority-owned pump for synchronous desktop and asynchronous external delivery. */
export class WorkNotificationHost {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDrain = false;
  private lifecycleGeneration = 0;
  private started = false;
  private abortDrain: AbortController | undefined;
  private activeAsyncDrain: Promise<HostOutcome[]> | undefined;
  private summaryTimer: ReturnType<typeof setTimeout> | undefined;
  private summaryDeadline: number | undefined;

  constructor(private readonly works: HostWork, private readonly options: {
    isAuthority: () => boolean;
    channels: () => WorkNotificationChannel[];
    asyncChannels?: () => AsyncWorkNotificationChannel[];
    intervalMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
    onBlocked?: (outcome: HostOutcome) => void;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => { void this.drainAsync(); }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
    void this.drainAsync();
  }

  stop(): void {
    this.started = false;
    this.lifecycleGeneration++;
    this.pendingDrain = false;
    this.abortDrain?.abort();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    this.summaryDeadline = undefined;
  }

  /** Stop new claims and finish/abort the current provider wait before the database closes. */
  async close(): Promise<void> {
    this.stop();
    await this.activeAsyncDrain;
  }

  wake(): void {
    if (!this.started) return;
    if (this.draining) { this.pendingDrain = true; return; }
    if (this.wakeTimer) return;
    const generation = this.lifecycleGeneration;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.started && generation === this.lifecycleGeneration) void this.drainAsync();
    }, 0);
    this.wakeTimer.unref?.();
  }

  /** Existing synchronous callers can still drain desktop adapters without a Promise. */
  drain(workId?: string): HostOutcome[] {
    if (!this.options.isAuthority()) return [];
    if (this.draining) { this.pendingDrain = true; return []; }
    this.draining = true;
    const generation = this.lifecycleGeneration;
    const results: HostOutcome[] = [];
    let scope = workId;
    let passes = 0;
    try {
      do {
        this.pendingDrain = false;
        this.flushSummaries();
        this.drainSynchronous(scope, generation, results);
        scope = undefined;
      } while (++passes < MAX_INLINE_PASSES && this.pendingDrain && this.active(generation));
    } finally { this.release(generation); }
    return results;
  }

  /** Production entry: a provider Promise is awaited, never mistaken for a success receipt. */
  drainAsync(workId?: string): Promise<HostOutcome[]> {
    if (!this.options.isAuthority()) return Promise.resolve([]);
    if (this.draining) { this.pendingDrain = true; return Promise.resolve([]); }
    const running = this.runAsyncDrain(workId).catch(error => { this.options.onError?.(error); return []; });
    this.activeAsyncDrain = running;
    void running.then(() => { if (this.activeAsyncDrain === running) this.activeAsyncDrain = undefined; });
    return running;
  }

  private async runAsyncDrain(workId?: string): Promise<HostOutcome[]> {
    this.draining = true;
    const generation = this.lifecycleGeneration;
    const controller = new AbortController();
    this.abortDrain = controller;
    const results: HostOutcome[] = [];
    let scope = workId;
    let passes = 0;
    try {
      do {
        this.pendingDrain = false;
        this.flushSummaries();
        this.drainSynchronous(scope, generation, results);
        if (!this.active(generation)) break;
        for (const channel of this.options.asyncChannels?.() ?? []) {
          if (!this.active(generation)) break;
          try {
            if (!this.works.notifications) throw new Error("异步通知投递服务未接线");
            const outcomes = await this.works.notifications.deliverAsync(channel, scope, {
              signal: controller.signal, isActive: () => this.active(generation), limit: 25,
            });
            for (const outcome of outcomes) {
              const row = { channel: channel.channel, ...outcome };
              results.push(row);
              if (row.blockedReason) this.options.onBlocked?.(row);
            }
          } catch (error) { this.options.onError?.(error); }
        }
        scope = undefined;
      } while (++passes < MAX_INLINE_PASSES && this.pendingDrain && this.active(generation));
    } finally {
      if (this.abortDrain === controller) this.abortDrain = undefined;
      this.release(generation);
    }
    return results;
  }

  private drainSynchronous(workId: string | undefined, generation: number, results: HostOutcome[]): void {
    for (const channel of this.options.channels()) {
      if (!this.active(generation)) break;
      try {
        for (const outcome of this.works.deliverPendingNotifications(channel, workId)) results.push({ channel: channel.channel, ...outcome });
      } catch (error) { this.options.onError?.(error); }
    }
  }

  private flushSummaries(): void { this.works.phase5?.flushOwnerSummaries(); }
  private active(generation: number): boolean { return generation === this.lifecycleGeneration && this.options.isAuthority(); }
  private release(generation: number): void {
    const trailing = this.pendingDrain && this.started && this.active(generation);
    this.pendingDrain = false;
    this.draining = false;
    if (this.started && this.active(generation)) this.scheduleSummaryDeadline(generation);
    // Bound inline work under an event storm while preserving its wake for the next turn.
    if (trailing) this.wake();
  }

  private scheduleSummaryDeadline(generation: number): void {
    const deadline = this.works.phase5?.nextOwnerSummaryDeadline();
    if (deadline === this.summaryDeadline && this.summaryTimer) return;
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    this.summaryDeadline = deadline;
    if (deadline === undefined) return;
    const remaining = deadline - (this.options.now?.() ?? Date.now());
    // An overdue obligation that cannot flush must not create a zero-delay busy loop.
    const delay = remaining > 0 ? remaining : this.options.intervalMs ?? 15_000;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined;
      this.summaryDeadline = undefined;
      if (this.started && this.active(generation)) this.wake();
    }, Math.min(delay, 2_147_483_647));
    this.summaryTimer.unref?.();
  }
}
