import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Durable 会话存储的**单写者租约**。
 *
 * pi-durable 的 JSONL 格式没有跨进程锁，两个 MyBuddy 实例同时持有同一个目录会交错写入
 * commit seq，使日志永久无法打开（真实事故，见 DurableLogRepair）。应用级单实例锁只在
 * 相同 userData 目录内生效（打包版与 dev 版 userData 不同），所以必须在存储目录上加锁。
 *
 * 约定：锁文件 <directory>/.mybuddy-owner.json
 * - 持有者进程活着（同名进程 + 同 pid）→ 第二个实例拒绝打开，并给出可读错误；
 * - 持有者进程已退出（崩溃/被强杀）→ 后启动者接管，不会被死锁挡死；
 * - 心跳节流 10s，仅在 refresh 时刷新 updatedAt，对正常写入没有压力。
 */

const LOCK_FILE = ".mybuddy-owner.json";
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

/** 每个进程一个 token：同进程内重复打开同一目录是合法的（open() 本身按 task 去重）。 */
const processToken = randomUUID();

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
  const temporary = `${lockPath}.tmp-${process.pid}`;
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
  const held = readOwner(lockPath);
  // 另一个进程（不是我们）正持有 → 拒绝。同一 pid 一定是本进程的历史残留，可直接接管。
  if (held && held.token !== processToken && held.pid !== process.pid && processAlive(held.pid)) {
    throw new DurableStorageOwnedError(held, lockPath);
  }
  const now = Date.now();
  const owner: DurableStorageOwner = { format: 1, pid: process.pid, token: processToken, startedAt: now, updatedAt: now };
  writeOwner(lockPath, owner);
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
      if (readOwner(lockPath)?.token !== owner.token) return;
      try {
        unlinkSync(lockPath);
      } catch {
        /* 已被删除或占用者已切换 */
      }
    },
  };
}
