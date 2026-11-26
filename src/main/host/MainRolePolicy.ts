/**
 * Explicit process role policy & categorized timer registry (`P1-07`, T12).
 *
 * When Core supervisor owns the background runtime (`role === "supervised-ui"`),
 * Electron Main owns ONLY UI lifecycle, desktop platform capabilities, event projection,
 * and narrow IPC facades. Non-UI background maintenance (`library_maintenance`,
 * `project_cadence`, `trash_purge`, `snapshot_compaction`, `dots`/`cron`/`gateway` loops)
 * is owned by Rust Core and executed by PiNodeHost so closing Main UI never loses
 * background maintenance.
 */

export type MainProcessRole = "supervised-ui" | "standalone";
export type MainTimerCategory = "ui" | "background-maintenance";

export interface MainRolePolicy {
  readonly role: MainProcessRole;
  readonly ownsBackgroundMaintenance: boolean;
  readonly ownsProjectCadence: boolean;
  readonly ownsTrashPurgeTimer: boolean;
  readonly ownsLibraryBackgroundRecovery: boolean;
  readonly ownsDotsAndCronLoops: boolean;
  readonly ownsSnapshotCompaction: boolean;
}

export function resolveMainRolePolicy(supervised: boolean): MainRolePolicy {
  if (supervised) {
    return {
      role: "supervised-ui",
      ownsBackgroundMaintenance: false,
      ownsProjectCadence: false,
      ownsTrashPurgeTimer: false,
      ownsLibraryBackgroundRecovery: false,
      ownsDotsAndCronLoops: false,
      ownsSnapshotCompaction: false,
    };
  }
  return {
    role: "standalone",
    ownsBackgroundMaintenance: true,
    ownsProjectCadence: true,
    ownsTrashPurgeTimer: true,
    ownsLibraryBackgroundRecovery: true,
    ownsDotsAndCronLoops: true,
    ownsSnapshotCompaction: true,
  };
}

export interface RegisteredMainTimer {
  name: string;
  category: MainTimerCategory;
  active: boolean;
  updatedAt: number;
}

export class MainTimerRegistry {
  private readonly timers = new Map<string, RegisteredMainTimer>();

  mark(name: string, category: MainTimerCategory, active: boolean): void {
    this.timers.set(name, { name, category, active, updatedAt: Date.now() });
  }

  list(category?: MainTimerCategory): RegisteredMainTimer[] {
    const entries = Array.from(this.timers.values());
    return category ? entries.filter(e => e.category === category) : entries;
  }

  activeBackgroundTimers(): RegisteredMainTimer[] {
    return this.list("background-maintenance").filter(e => e.active);
  }
}
