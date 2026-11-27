import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const MUTEX_FILE = ".mybuddy-writer-lock.json";
const LEGACY_MUTEX_PREFIX = ".mybuddy-writer-lock.sqlite";

export interface DurableStorageOwner {
  pid: number;
  host: string;
  startedAt: number;
  token?: string;
}

export class DurableStorageOwnedError extends Error {
  readonly code = "DURABLE_STORAGE_OWNED";
  readonly owner: DurableStorageOwner;
  readonly lockPath: string;

  constructor(owner: DurableStorageOwner, lockPath: string) {
    const pid = owner.pid > 0 ? `PID ${owner.pid}` : "未知进程";
    super(`Durable 存储正被另一实例占用（${pid} @ ${owner.host || "unknown"}）：${lockPath}`);
    this.name = "DurableStorageOwnedError";
    this.owner = owner;
    this.lockPath = lockPath;
  }
}

export function isDurableLeaseFile(name: string): boolean {
  return name === MUTEX_FILE || name.startsWith(LEGACY_MUTEX_PREFIX);
}

export interface DurableStorageLease {
  readonly lockPath: string;
  readonly owner: DurableStorageOwner;
  heartbeat(): void;
  release(): void;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // A killed writer can retain a PID until its parent reaps it.
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        if (/^State:\s+[ZX]\b/m.test(status)) return false;
      } catch {
        // An unavailable procfs cannot prove that the writer exited.
      }
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readOwner(lockPath: string): DurableStorageOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<DurableStorageOwner>;
    if (typeof raw.pid !== "number") return undefined;
    return {
      pid: raw.pid,
      host: typeof raw.host === "string" ? raw.host : "",
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      ...(typeof raw.token === "string" ? { token: raw.token } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Determine whether the lockfile represents an active local writer without acquiring it. */
export function durableStorageOwnerState(directory: string): "active" | "inactive" | "unknown" {
  const lockPath = join(directory, MUTEX_FILE);
  const owner = readOwner(lockPath);
  if (!owner) return "inactive";
  if (owner.host && owner.host !== hostname()) return "unknown";
  return isProcessAlive(owner.pid) ? "active" : "inactive";
}

export function claimDurableStorageLease(directory: string): DurableStorageLease {
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, MUTEX_FILE);
  const owner: DurableStorageOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
    token: randomUUID(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        lockPath,
        owner,
        heartbeat(): void {
          if (released) return;
          const current = readOwner(lockPath);
          if (!current || (current.token && current.token === owner.token) || (!current.token && current.pid === owner.pid)) {
            try {
              const fdUpdate = openSync(lockPath, "w", 0o600);
              try {
                writeSync(fdUpdate, JSON.stringify({ ...owner, startedAt: Date.now() }));
              } finally {
                closeSync(fdUpdate);
              }
            } catch { /* ignore */ }
          }
        },
        release(): void {
          if (released) return;
          released = true;
          const current = readOwner(lockPath);
          if (!current || (current.token && current.token === owner.token) || (!current.token && current.pid === owner.pid)) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = readOwner(lockPath);
      if (existing && (!existing.host || existing.host === owner.host) && !isProcessAlive(existing.pid)) {
        try {
          rmSync(lockPath, { force: true });
          continue;
        } catch {
          // Contended with another cleaner; fall through to recheck.
        }
      }
      throw new DurableStorageOwnedError(existing ?? { ...owner, pid: 0 }, lockPath);
    }
  }
  throw new DurableStorageOwnedError(readOwner(lockPath) ?? { ...owner, pid: 0 }, lockPath);
}
