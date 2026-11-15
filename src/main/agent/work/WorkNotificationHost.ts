import type { WorkNotificationChannel } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { AsyncWorkNotificationChannel, WorkNotificationOutcome } from "./WorkNotificationDelivery";

type HostOutcome = WorkNotificationOutcome & { channel: string };
type HostWork = Pick<WorkService, "deliverPendingNotifications"> & Partial<Pick<WorkService, "notifications" | "phase5">>;
const MAX_INLINE_PASSES = 8;
const routeLimit = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value)
  ? Math.min(64, Math.max(1, Math.floor(value))) : fallback;
type RouteFlight = {
  channel: string;
  controller: AbortController;
  completion: Promise<HostOutcome[]>;
  rescan: boolean;
};

/** One authority-owned pump for synchronous desktop and asynchronous external delivery. */
export class WorkNotificationHost {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDrain = false;
  private lifecycleGeneration = 0;
  private started = false;
  private stopped = false;
  private closed = false;
  private readonly routeFlights = new Map<string, RouteFlight>();
  private routeCursor = 0;
  private waitingRoutes = false;
  private readonly routeSweep = new Set<string>();
  private resetRouteSweep = true;
  private summaryTimer: ReturnType<typeof setTimeout> | undefined;
  private summaryDeadline: number | undefined;

  constructor(private readonly works: HostWork, private readonly options: {
    isAuthority: () => boolean;
    channels: () => WorkNotificationChannel[];
    asyncChannels?: () => AsyncWorkNotificationChannel[];
    intervalMs?: number;
    maxConcurrentRoutes?: number;
    maxConcurrentRoutesPerChannel?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
    onBlocked?: (outcome: HostOutcome) => void;
  }) {}

  start(): void {
    if (this.started || this.closed) return;
    this.stopped = false;
    this.started = true;
    this.timer = setInterval(() => { void this.drainAsync(); }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
    void this.drainAsync();
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    this.lifecycleGeneration++;
    this.pendingDrain = false;
    for (const flight of this.routeFlights.values()) flight.controller.abort();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    this.summaryDeadline = undefined;
  }

  /** Stop claims without waiting indefinitely for a provider that ignores cancellation. */
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await Promise.all([...this.routeFlights.values()].map(flight => flight.completion));
  }

  wake(): void {
    this.resetRouteSweep = true;
    this.queueWake();
  }

  private queueWake(): void {
    if (!this.started) return;
    if (this.draining) { this.pendingDrain = true; return; }
    if (this.wakeTimer) return;
    const generation = this.lifecycleGeneration;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.started && generation === this.lifecycleGeneration) void this.runAsyncScan();
    }, 0);
    this.wakeTimer.unref?.();
  }

  /** Existing synchronous callers can still drain desktop adapters without a Promise. */
  drain(workId?: string): HostOutcome[] {
    if (!this.active(this.lifecycleGeneration)) { this.abortInactiveRoutes(); return []; }
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

  /** Explicit receipt barrier; wake/timer scans release their scheduling lock before I/O. */
  drainAsync(workId?: string): Promise<HostOutcome[]> {
    this.resetRouteSweep = true;
    return this.runAsyncScan(workId);
  }

  private runAsyncScan(workId?: string): Promise<HostOutcome[]> {
    if (!this.active(this.lifecycleGeneration)) { this.abortInactiveRoutes(); return Promise.resolve([]); }
    if (this.draining) { this.pendingDrain = true; return Promise.resolve([]); }
    try {
      const { results, flights } = this.scheduleAsyncDrain(workId);
      return Promise.all(flights).then(outcomes => [...results, ...outcomes.flat()]);
    } catch (error) { this.options.onError?.(error); return Promise.resolve([]); }
  }

  private scheduleAsyncDrain(workId?: string): { results: HostOutcome[]; flights: Promise<HostOutcome[]>[] } {
    this.draining = true;
    const generation = this.lifecycleGeneration;
    const results: HostOutcome[] = [];
    const flights: Promise<HostOutcome[]>[] = [];
    let scope = workId;
    let passes = 0;
    try {
      do {
        this.pendingDrain = false;
        this.flushSummaries();
        this.drainSynchronous(scope, generation, results);
        if (!this.active(generation)) break;
        this.scheduleRoutes(scope, generation, flights);
        scope = undefined;
      } while (++passes < MAX_INLINE_PASSES && this.pendingDrain && this.active(generation));
    } finally { this.release(generation); }
    return { results, flights };
  }

  private scheduleRoutes(workId: string | undefined, generation: number, completions: Promise<HostOutcome[]>[]): void {
    if (this.resetRouteSweep) { this.routeSweep.clear(); this.resetRouteSweep = false; }
    const channels = this.options.asyncChannels?.() ?? [];
    const totalLimit = routeLimit(this.options.maxConcurrentRoutes, 16);
    // A single provider's internal REST queue must not occupy the whole host.
    const channelLimit = Math.min(totalLimit, routeLimit(this.options.maxConcurrentRoutesPerChannel, 4));
    const counts = new Map<string, number>();
    for (const flight of this.routeFlights.values()) counts.set(flight.channel, (counts.get(flight.channel) ?? 0) + 1);
    const start = this.routeCursor % Math.max(1, channels.length);
    const seen = new Set<string>();
    let resumeFrom: number | undefined;
    this.waitingRoutes = false;
    for (let offset = 0; offset < channels.length; offset++) {
      if (!this.active(generation)) break;
      const index = (start + offset) % channels.length;
      const channel = channels[index];
      const key = JSON.stringify([channel.channel, channel.targetKey]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.routeSweep.has(key)) continue;
      const existing = this.routeFlights.get(key);
      if (existing) { existing.rescan = true; this.routeSweep.add(key); continue; }
      if (this.routeFlights.size >= totalLimit || (counts.get(channel.channel) ?? 0) >= channelLimit) {
        resumeFrom ??= index;
        this.waitingRoutes = true; continue;
      }
      this.routeSweep.add(key);
      counts.set(channel.channel, (counts.get(channel.channel) ?? 0) + 1);
      this.routeCursor = (index + 1) % channels.length;
      const controller = new AbortController();
      const flight: RouteFlight = { channel: channel.channel, controller, completion: Promise.resolve([]), rescan: false };
      this.routeFlights.set(key, flight);
      const running = (async (): Promise<HostOutcome[]> => {
        try {
          if (!this.works.notifications) throw new Error("异步通知投递服务未接线");
          const outcomes = await this.works.notifications.deliverAsync(channel, workId, {
            signal: controller.signal, isActive: () => this.active(generation), limit: 25,
          });
          if (!this.active(generation) || controller.signal.aborted) return [];
          return outcomes.map(outcome => {
            const row = { channel: channel.channel, ...outcome };
            if (row.blockedReason) this.options.onBlocked?.(row);
            return row;
          });
        } catch (error) {
          if (this.active(generation) && !controller.signal.aborted) this.options.onError?.(error);
          return [];
        }
      })().finally(() => {
        if (this.routeFlights.get(key) === flight) this.routeFlights.delete(key);
        if (flight.rescan) this.routeSweep.delete(key);
        if (this.started && !this.closed && (flight.rescan || this.waitingRoutes)) this.queueWake();
      });
      // Keep the actual route lock until the provider returns, including across stop/start.
      // Its cancellable completion lets shutdown finish even for noncooperative adapters.
      flight.completion = this.untilAborted(running, controller.signal);
      completions.push(flight.completion);
    }
    // Resume the first capacity-skipped route, not the last fast provider in the batch.
    if (resumeFrom !== undefined) this.routeCursor = resumeFrom;
  }

  private untilAborted(running: Promise<HostOutcome[]>, signal: AbortSignal): Promise<HostOutcome[]> {
    if (signal.aborted) return Promise.resolve([]);
    return new Promise(resolve => {
      const abort = () => { signal.removeEventListener("abort", abort); resolve([]); };
      signal.addEventListener("abort", abort, { once: true });
      void running.then(results => { signal.removeEventListener("abort", abort); resolve(results); }, () => abort());
    });
  }

  private abortInactiveRoutes(): void {
    for (const flight of this.routeFlights.values()) flight.controller.abort();
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
  private active(generation: number): boolean { return !this.closed && !this.stopped && generation === this.lifecycleGeneration && this.options.isAuthority(); }
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
