export type SurfaceKind = "browser-tab" | "artifact-preview" | "aux";

export interface ReclaimableSurfaceSnapshot {
  surfaceId: string;
  kind: SurfaceKind;
  url: string;
  partition?: string;
  draftInput?: string;
  scrollY?: number;
  reclaimedAt: number;
}

export interface ManagedWebSurface {
  surfaceId: string;
  kind: SurfaceKind;
  isVisible: () => boolean;
  isLiveViewPresent: () => boolean;
  getUrl: () => string;
  getPartition?: () => string | undefined;
  getDraftInput?: () => string | undefined;
  getScrollY?: () => number | undefined;
  hasUnsavedInput?: () => boolean;
  hasActivePlatformTask?: () => boolean;
  lastActiveAt: () => number;
  destroyView: () => Promise<void> | void;
  restoreView: (snapshot: ReclaimableSurfaceSnapshot) => Promise<void> | void;
}

export interface WebContentsReclaimEvent {
  at: number;
  action: "reclaimed" | "restored" | "skipped";
  surfaceId: string;
  kind: SurfaceKind;
  reason?: string;
  rssBytes: number;
  heapUsedBytes: number;
}

export interface WebContentsReclaimMetrics {
  totalReclaimed: number;
  totalRestored: number;
  registeredCount: number;
  liveViewCount: number;
  reclaimedCount: number;
  lastRssBytes: number;
  history: WebContentsReclaimEvent[];
}

/**
 * Policy manager for reclaiming hidden / idle WebContents surfaces and restoring them (`RC-24`).
 *
 * Preserves visible pages, unsaved user input, active platform/capture tasks, and
 * persistent Chromium storage partitions (`persist:*`), emitting observable reclaim
 * audit logs and process memory metrics.
 */
export class WebContentsReclaimManager {
  private readonly surfaces = new Map<string, ManagedWebSurface>();
  private readonly reclaimedSnapshots = new Map<string, ReclaimableSurfaceSnapshot>();
  private readonly history: WebContentsReclaimEvent[] = [];
  private totalReclaimed = 0;
  private totalRestored = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: { idleThresholdMs?: number; maxHistory?: number } = {}) {}

  register(surface: ManagedWebSurface): () => void {
    this.surfaces.set(surface.surfaceId, surface);
    return () => {
      this.unregister(surface.surfaceId);
    };
  }

  unregister(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
    this.reclaimedSnapshots.delete(surfaceId);
  }

  startPeriodicSweep(intervalMs = 30_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.reclaimIdleSurfaces().catch(() => undefined);
    }, Math.max(250, intervalMs));
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  getReclaimedSnapshot(surfaceId: string): ReclaimableSurfaceSnapshot | undefined {
    return this.reclaimedSnapshots.get(surfaceId);
  }

  getMetrics(): WebContentsReclaimMetrics {
    const mem = process.memoryUsage();
    let liveViewCount = 0;
    for (const s of this.surfaces.values()) {
      if (s.isLiveViewPresent()) liveViewCount += 1;
    }
    return {
      totalReclaimed: this.totalReclaimed,
      totalRestored: this.totalRestored,
      registeredCount: this.surfaces.size,
      liveViewCount,
      reclaimedCount: this.reclaimedSnapshots.size,
      lastRssBytes: mem.rss,
      history: [...this.history],
    };
  }

  private recordEvent(event: Omit<WebContentsReclaimEvent, "rssBytes" | "heapUsedBytes">): void {
    const mem = process.memoryUsage();
    this.history.push({
      ...event,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    });
    const cap = this.options.maxHistory ?? 200;
    if (this.history.length > cap) {
      this.history.splice(0, this.history.length - cap);
    }
  }

  async reclaimIdleSurfaces(now = Date.now(), overrideIdleThresholdMs?: number): Promise<string[]> {
    const thresholdMs = overrideIdleThresholdMs ?? this.options.idleThresholdMs ?? 5 * 60_000;
    const reclaimed: string[] = [];

    for (const surface of this.surfaces.values()) {
      if (!surface.isLiveViewPresent()) continue;
      if (surface.isVisible()) continue;

      if (surface.hasActivePlatformTask?.()) {
        this.recordEvent({
          at: now,
          action: "skipped",
          surfaceId: surface.surfaceId,
          kind: surface.kind,
          reason: "active_platform_task",
        });
        continue;
      }
      if (surface.hasUnsavedInput?.()) {
        this.recordEvent({
          at: now,
          action: "skipped",
          surfaceId: surface.surfaceId,
          kind: surface.kind,
          reason: "unsaved_user_input",
        });
        continue;
      }

      const idleMs = now - surface.lastActiveAt();
      if (idleMs < thresholdMs) continue;

      const snapshot: ReclaimableSurfaceSnapshot = {
        surfaceId: surface.surfaceId,
        kind: surface.kind,
        url: surface.getUrl(),
        partition: surface.getPartition?.(),
        draftInput: surface.getDraftInput?.(),
        scrollY: surface.getScrollY?.(),
        reclaimedAt: now,
      };
      this.reclaimedSnapshots.set(surface.surfaceId, snapshot);
      await surface.destroyView();
      this.totalReclaimed += 1;
      reclaimed.push(surface.surfaceId);
      this.recordEvent({
        at: now,
        action: "reclaimed",
        surfaceId: surface.surfaceId,
        kind: surface.kind,
        reason: `idle_${idleMs}ms`,
      });
    }
    return reclaimed;
  }

  async wakeSurface(surfaceId: string): Promise<boolean> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return false;
    const snapshot = this.reclaimedSnapshots.get(surfaceId);
    if (surface.isLiveViewPresent() || !snapshot) return false;

    await surface.restoreView(snapshot);
    this.reclaimedSnapshots.delete(surfaceId);
    this.totalRestored += 1;
    this.recordEvent({
      at: Date.now(),
      action: "restored",
      surfaceId: surface.surfaceId,
      kind: surface.kind,
      reason: "surface_activated",
    });
    return true;
  }
}
