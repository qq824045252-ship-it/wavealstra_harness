import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * A held SQLite exclusive transaction is the writer mutex, including between handles
 * in the same process. The OS releases it on process death. Never unlink the lock DB:
 * replacing its inode would let another process lock a different file concurrently.
 * JSON metadata is diagnostic and supports conservative legacy-owner refusal.
 * Requires a local filesystem with working SQLite locks, not a distributed lease.
 */

const LOCK_FILE = ".mybuddy-owner.json";
const MUTEX_FILE = ".mybuddy-writer-lock.sqlite";
const HEARTBEAT_INTERVAL_MS = 10_000;

export interface DurableStorageOwner {
  format: 1;
  pid: number;
  token: string;
  startedAt: number;
  updatedAt: number;
}

export class DurableStorageOwnedError extends Error {
  readonly code = "DURABLE_STORAGE_OWNED";
  constructor(readonly owner: DurableStorageOwner, readonly lockPath: string) {
    super(`Bot 会话存储已被另一个 MyBuddy 实例占用（PID ${owner.pid}）`);
    this.name = "DurableStorageOwnedError";
  }
}

export interface DurableStorageLease {
  readonly owner: DurableStorageOwner;
  readonly lockPath: string;
  heartbeat(): void;
  release(): void;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不可发信号（Windows 上常见于系统进程），同样视为存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): DurableStorageOwner | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<DurableStorageOwner>;
    if (value?.format !== 1) return undefined;
    if (!Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.updatedAt)) return undefined;
    if (typeof value.token !== "string" || value.token.length === 0) return undefined;
    return { format: 1, pid: value.pid as number, token: value.token, startedAt: value.startedAt as number, updatedAt: value.updatedAt as number };
  } catch {
    return undefined;
  }
}

/** Passive status never claims ownership or rewrites a dead owner's lock. */
export function durableStorageOwnerState(directory: string): "active" | "inactive" | "unknown" {
  const path = join(directory, LOCK_FILE);
  const owner = readOwner(path);
  if (!owner) return existsSync(path) ? "unknown" : "inactive";
  return processAlive(owner.pid) ? "active" : "inactive";
}

function writeOwner(lockPath: string, owner: DurableStorageOwner): void {
  const temporary = `${lockPath}.tmp-${owner.token}`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, JSON.stringify(owner));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, lockPath);
}

export function claimDurableStorageLease(directory: string): DurableStorageLease {
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, LOCK_FILE);
  const now = Date.now();
  const owner: DurableStorageOwner = { format: 1, pid: process.pid, token: randomUUID(), startedAt: now, updatedAt: now };
  let mutex: Database.Database | undefined;
  try {
    mutex = new Database(join(directory, MUTEX_FILE), { timeout: 0 });
    if (mutex.pragma("journal_mode", { simple: true }) !== "delete") {
      throw new Error("Durable writer mutex requires DELETE journal mode");
    }
    mutex.exec("BEGIN EXCLUSIVE");
    const held = readOwner(lockPath);
    // Old versions do not take this mutex. Never steal a live legacy lease,
    // including same-process handles. Dead owners can be safely replaced.
    if (held && processAlive(held.pid)) throw new DurableStorageOwnedError(held, lockPath);
    writeOwner(lockPath, owner);
  } catch (error) {
    mutex?.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY" || (error as { code?: string }).code === "SQLITE_LOCKED") {
      throw new DurableStorageOwnedError(readOwner(lockPath) ?? { ...owner, pid: 0 }, lockPath);
    }
    throw error;
  }
  const heldMutex = mutex;
  let released = false;
  let heartbeatAt = now;
  return {
    owner,
    lockPath,
    heartbeat() {
      if (released) return;
      const at = Date.now();
      if (at - heartbeatAt < HEARTBEAT_INTERVAL_MS) return;
      heartbeatAt = at;
      // 租约被别人接管后就不要再往回写，避免抢回已经不属于自己的锁。
      if (readOwner(lockPath)?.token !== owner.token) return;
      try {
        writeOwner(lockPath, { ...owner, updatedAt: at });
      } catch {
        /* 心跳是尽力而为：写盘失败不应影响会话本身 */
      }
    },
    release() {
      if (released) return;
      released = true;
      try {
        // Remove metadata while still holding the mutex, never after unlocking.
        if (readOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
      } catch {
        /* Metadata is advisory. Always release the actual OS lock. */
      } finally {
        heldMutex.close();
      }
    },
  };
}
