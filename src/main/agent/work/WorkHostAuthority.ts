import type Database from "better-sqlite3";

interface LeaseRow {
  lease_id: string;
  authority_id: string;
  acquired_at: number;
  heartbeat_at: number;
  released_at: number | null;
}

/** Stable across heartbeats, different after release or reacquisition. Check lifecycle before reading it. */
export function workHostLeaseIdentity(db: Database.Database): string {
  const row = db.prepare("SELECT authority_id,acquired_at,released_at FROM work_host_lease WHERE lease_id='singleton'")
    .get() as Pick<LeaseRow, "authority_id" | "acquired_at" | "released_at"> | undefined;
  return row ? JSON.stringify([row.authority_id, row.acquired_at, row.released_at]) : "";
}

export interface HostAuthorityStatus {
  authorityId: string;
  isAuthority: boolean;
  online: boolean;
  heartbeatAt?: number;
  acquiredAt?: number;
  holderAuthorityId?: string;
}

export interface RuntimeWorkHostLeaseRequest {
  action: "acquire" | "heartbeat" | "release";
  authorityId: string;
  now: number;
  leaseTtlMs: number;
}

export interface RuntimeWorkHostLeaseReply {
  ok: boolean;
  authorityId: string;
  holderAuthorityId?: string | null;
  heartbeatAt?: number | null;
  acquiredAt?: number | null;
  releasedAt?: number | null;
}

export interface WorkHostLeaseWriter {
  workHostLease(request: RuntimeWorkHostLeaseRequest): Promise<RuntimeWorkHostLeaseReply | undefined>;
  workScheduler?<T = Record<string, unknown>>(command: Record<string, unknown> & { action: string }): Promise<T | undefined>;
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
  private retryTimer?: ReturnType<typeof setTimeout>;
  private nativeTail: Promise<void> = Promise.resolve();
  private nativeRefresh?: Promise<void>;
  private nativeState?: RuntimeWorkHostLeaseReply;
  private stopped = false;
  private generation = 0;
  private retryDelayMs = 100;
  private lastWarningAt = 0;
  private readonly acquiredListeners = new Set<() => void>();

  constructor(
    private readonly db: Database.Database,
    private readonly authorityId: string,
    private readonly leaseTtlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly writer?: WorkHostLeaseWriter,
    private readonly delegatedToCore = false,
  ) {}

  /** Read the previous holder's watermark before `start()` overwrites the heartbeat. */
  snapshot(): { authorityId?: string; heartbeatAt?: number; releasedAt?: number; acquiredAt?: number } {
    const row = this.row();
    return row ? { authorityId: row.authority_id, heartbeatAt: row.heartbeat_at,
      releasedAt: row.released_at ?? undefined, acquiredAt: row.acquired_at } : {};
  }

  start(): ReturnType<WorkHostAuthority["acquire"]> {
    this.stopped = false;
    const acquired = this.acquire();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.writer) { void this.refreshNative(); return; }
        try { if (!this.heartbeat()) this.acquire(); }
        catch (error) { this.warn(error); }
      }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
      this.heartbeatTimer.unref?.();
    }
    return acquired;
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.release();
  }

  /** Shutdown waits for the owner-specific release before disconnecting from Core. */
  async flush(): Promise<void> { await this.nativeTail; }

  /** Startup/recovery work waits for confirmed ownership, including a later retry. */
  onAcquired(listener: () => void): () => void {
    this.acquiredListeners.add(listener);
    if (this.isAuthority()) this.notifyAcquired(listener);
    return () => { this.acquiredListeners.delete(listener); };
  }

  acquire(): { ok: boolean; previousAuthorityId?: string; message?: string } {
    if (this.writer) {
      void this.refreshNative();
      return { ok: this.isAuthority(), message: this.isAuthority() ? undefined : "正在确认 Work 调度权" };
    }
    const acquired = this.nonblockingWrite<{ ok: boolean; previousAuthorityId?: string; message?: string }>(() => this.db.transaction(() => {
      const now = this.now();
      const row = this.row();
      if (!row || row.released_at !== null || now - row.heartbeat_at > this.leaseTtlMs) {
        // Reacquisition can occur within one clock tick (or after a clock rollback).
        // Keep the existing acquisition watermark monotonic so in-flight I/O from
        // a previous lease cannot become current again under the same authority ID.
        const acquiredAt = Math.max(now, (row?.acquired_at ?? now - 1) + 1);
        this.db.prepare(`INSERT INTO work_host_lease (lease_id, authority_id, acquired_at, heartbeat_at, released_at)
          VALUES ('singleton', ?, ?, ?, NULL)
          ON CONFLICT(lease_id) DO UPDATE SET authority_id=excluded.authority_id,
            acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, released_at=NULL`)
          .run(this.authorityId, acquiredAt, now);
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
    }).immediate(), { ok: false, message: "数据库繁忙，尚未取得 Work 调度权" });
    if (acquired.ok) for (const listener of this.acquiredListeners) this.notifyAcquired(listener);
    return acquired;
  }

  heartbeat(): boolean {
    if (this.writer) { void this.refreshNative(); return this.isAuthority(); }
    return this.nonblockingWrite(() => this.db.transaction(() => {
      const row = this.row();
      if (!row || row.released_at !== null || row.authority_id !== this.authorityId) return false;
      this.db.prepare("UPDATE work_host_lease SET heartbeat_at=? WHERE lease_id='singleton'").run(this.now());
      return true;
    }).immediate(), false);
  }

  release(): void {
    if (this.writer) {
      this.generation += 1;
      this.nativeState = undefined;
      this.nativeRefresh = undefined;
      if (this.delegatedToCore) return;
      const writer = this.writer;
      this.nativeTail = this.nativeTail.then(async () => {
        await writer.workHostLease(this.request("release"));
      }).catch(error => this.warn(error));
      return;
    }
    this.nonblockingWrite(() => {
      this.db.prepare("UPDATE work_host_lease SET released_at=? WHERE lease_id='singleton' AND authority_id=?")
        .run(this.now(), this.authorityId);
    }, undefined);
  }

  isAuthority(): boolean {
    if (this.writer) {
      const state = this.nativeState;
      const holderMatch = this.delegatedToCore
        ? typeof state?.holderAuthorityId === "string" && state.holderAuthorityId.startsWith("core:")
        : state?.holderAuthorityId === this.authorityId;
      return !this.stopped && state?.ok === true && holderMatch
        && state.releasedAt == null && typeof state.heartbeatAt === "number"
        && this.now() - state.heartbeatAt < this.leaseTtlMs;
    }
    const row = this.row();
    if (!row || row.released_at !== null) return false;
    return row.authority_id === this.authorityId && this.now() - row.heartbeat_at <= this.leaseTtlMs;
  }

  status(): HostAuthorityStatus {
    if (this.writer) {
      const current = this.nativeState;
      return { authorityId: this.delegatedToCore ? (current?.holderAuthorityId ?? this.authorityId) : this.authorityId,
        isAuthority: this.isAuthority(), online: this.isAuthority(),
        heartbeatAt: current?.heartbeatAt ?? undefined, acquiredAt: current?.acquiredAt ?? undefined,
        holderAuthorityId: current?.holderAuthorityId ?? undefined };
    }
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

  private request(action: RuntimeWorkHostLeaseRequest["action"]): RuntimeWorkHostLeaseRequest {
    return { action, authorityId: this.authorityId, now: this.now(), leaseTtlMs: this.leaseTtlMs };
  }

  /** One renewal at a time. An unconfirmed reply never extends local authority. */
  private refreshNative(): Promise<void> {
    if (!this.writer || this.stopped) return Promise.resolve();
    if (this.nativeRefresh) return this.nativeRefresh;
    const writer = this.writer;
    const generation = this.generation;
    const refresh = this.nativeTail.then(async () => {
      if (this.stopped || generation !== this.generation) return;
      let reply: RuntimeWorkHostLeaseReply | undefined;
      if (this.delegatedToCore && writer.workScheduler) {
        const status = await writer.workScheduler<{
          isOwner?: boolean;
          holderAuthorityId?: string | null;
          acquiredAt?: number | null;
          heartbeatAt?: number | null;
          releasedAt?: number | null;
        }>({ action: "ownerStatus", nowMs: this.now(), leaseTtlMs: this.leaseTtlMs });
        if (status) {
          reply = {
            ok: Boolean(status.isOwner && typeof status.holderAuthorityId === "string" && status.holderAuthorityId.startsWith("core:")),
            authorityId: this.authorityId,
            holderAuthorityId: status.holderAuthorityId ?? null,
            acquiredAt: status.acquiredAt ?? null,
            heartbeatAt: status.heartbeatAt ?? null,
            releasedAt: status.releasedAt ?? null,
          };
        }
      } else {
        const action = this.isAuthority() ? "heartbeat" : "acquire";
        reply = await writer.workHostLease(this.request(action));
      }
      if (this.stopped || generation !== this.generation) return;
      const previouslyAuthoritative = this.isAuthority();
      this.nativeState = reply;
      if (this.isAuthority()) {
        this.retryDelayMs = 100;
        if (!previouslyAuthoritative) for (const listener of this.acquiredListeners) this.notifyAcquired(listener);
      }
      else {
        if (!reply) this.warn(new Error("Work lease reply is unavailable"));
        this.scheduleRetry();
      }
    }).catch(error => {
      if (generation !== this.generation) return;
      this.nativeState = undefined;
      this.warn(error);
      this.scheduleRetry();
    }).finally(() => {
      if (this.nativeRefresh === refresh) this.nativeRefresh = undefined;
    });
    this.nativeRefresh = refresh;
    this.nativeTail = refresh;
    return refresh;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(2_000, delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.refreshNative();
    }, delay);
    this.retryTimer.unref?.();
  }

  private warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 5_000) return;
    this.lastWarningAt = now;
    console.warn("[WorkHostAuthority] lease update unconfirmed; scheduling requires a confirmed live lease", error);
  }

  private notifyAcquired(listener: () => void): void {
    try { listener(); }
    catch (error) { console.warn("[WorkHostAuthority] ownership recovery callback failed", error); }
  }

  /** Host-only callers also must not block the UI on a write lock. */
  private nonblockingWrite<T>(operation: () => T, busy: T): T {
    const timeout = Number(this.db.pragma("busy_timeout", { simple: true }));
    try {
      this.db.pragma("busy_timeout = 0");
      return operation();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
          && /^SQLITE_(BUSY|LOCKED)/.test(String(error.code))) return busy;
      throw error;
    } finally {
      if (this.db.open) this.db.pragma(`busy_timeout = ${timeout}`);
    }
  }
}
