import type Database from "better-sqlite3";

interface LeaseRow {
  lease_id: string;
  authority_id: string;
  acquired_at: number;
  heartbeat_at: number;
  released_at: number | null;
}

export interface HostAuthorityStatus {
  authorityId: string;
  isAuthority: boolean;
  online: boolean;
  heartbeatAt?: number;
  acquiredAt?: number;
  holderAuthorityId?: string;
}

/**
 * Single authoritative host for Work scheduling (F14 / BW-A13).
 *
 * Two clients may both hold a local scheduler object; only the holder of the persisted
 * lease may create Work instructions. A stale heartbeat can be taken over, a live one
 * cannot. The lease deliberately lives in the business database, not in memory.
 */
export class WorkHostAuthority {
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database.Database,
    private readonly authorityId: string,
    private readonly leaseTtlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the previous holder's watermark before `start()` overwrites the heartbeat. */
  snapshot(): { authorityId?: string; heartbeatAt?: number; releasedAt?: number; acquiredAt?: number } {
    const row = this.row();
    return row ? { authorityId: row.authority_id, heartbeatAt: row.heartbeat_at,
      releasedAt: row.released_at ?? undefined, acquiredAt: row.acquired_at } : {};
  }

  start(): ReturnType<WorkHostAuthority["acquire"]> {
    const acquired = this.acquire();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeat()) this.acquire();
      }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
      this.heartbeatTimer.unref?.();
    }
    return acquired;
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.release();
  }

  acquire(): { ok: boolean; previousAuthorityId?: string; message?: string } {
    return this.db.transaction(() => {
      const now = this.now();
      const row = this.row();
      if (!row || row.released_at !== null || now - row.heartbeat_at > this.leaseTtlMs) {
        this.db.prepare(`INSERT INTO work_host_lease (lease_id, authority_id, acquired_at, heartbeat_at, released_at)
          VALUES ('singleton', ?, ?, ?, NULL)
          ON CONFLICT(lease_id) DO UPDATE SET authority_id=excluded.authority_id,
            acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, released_at=NULL`)
          .run(this.authorityId, now, now);
        return { ok: true, previousAuthorityId: row?.authority_id };
      }
      if (row.authority_id === this.authorityId) {
        this.db.prepare("UPDATE work_host_lease SET heartbeat_at=? WHERE lease_id='singleton'").run(now);
        return { ok: true };
      }
      return {
        ok: false,
        previousAuthorityId: row.authority_id,
        message: `另一宿主 ${row.authority_id} 仍持有 Work 调度权，拒绝双主调度`,
      };
    }).immediate();
  }

  heartbeat(): boolean {
    return this.db.transaction(() => {
      const row = this.row();
      if (!row || row.released_at !== null || row.authority_id !== this.authorityId) return false;
      this.db.prepare("UPDATE work_host_lease SET heartbeat_at=? WHERE lease_id='singleton'").run(this.now());
      return true;
    }).immediate();
  }

  release(): void {
    this.db.prepare("UPDATE work_host_lease SET released_at=? WHERE lease_id='singleton' AND authority_id=?")
      .run(this.now(), this.authorityId);
  }

  isAuthority(): boolean {
    const row = this.row();
    if (!row || row.released_at !== null) return false;
    return row.authority_id === this.authorityId && this.now() - row.heartbeat_at <= this.leaseTtlMs;
  }

  status(): HostAuthorityStatus {
    const row = this.row();
    return {
      authorityId: this.authorityId,
      isAuthority: this.isAuthority(),
      online: this.isAuthority(),
      heartbeatAt: row?.heartbeat_at,
      acquiredAt: row?.acquired_at,
      holderAuthorityId: row?.authority_id,
    };
  }

  private row(): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM work_host_lease WHERE lease_id='singleton'").get() as LeaseRow | undefined;
  }
}
