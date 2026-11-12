/**
 * 文件安全（platform/fs-security）：可执行位（POSIX chmod）与 Windows ACL 收紧。
 *
 * 迁自 memory/ExternalCliMemoryAssets.ts（可执行位）与 memory/MemoryGatewayFileSecurity.ts
 * （Windows：whoami 取 SID + icacls 去继承、只授权当前用户与 SYSTEM）。
 * Windows 逻辑逐字保留；POSIX 上 chmod 才是权威，`ensureExecutableFile` 在 Windows 上必须是空操作。
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";
import { hashWindowsSnapshots, type SnapshotHashResult, type SnapshotReadResult, type WindowsSnapshotRequest } from "./windows-snapshot";

/** Windows has no filesystem FIFO and Node does not expose O_NOFOLLOW there.
 * Restrict opening to local disk paths, then verify the opened object's identity.
 * Device namespaces, DOS devices and alternate streams are not disk snapshots. */
function assertDiskPath(path: string, platform: PlatformId): void {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Snapshot path must be absolute");
  if (platform !== "windows") return;
  if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(":")) throw new Error("Snapshot requires a local disk path");
  for (const part of path.slice(3).split(/[\\/]/)) {
    if (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error("Snapshot path contains a device or ambiguous component");
    }
  }
}

function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function inspectDiskPath(path: string, platform: PlatformId): BigIntStats {
  let cursor = path;
  const root = parse(path).root;
  while (true) {
    const item = lstatSync(cursor, { bigint: true });
    if (item.isSymbolicLink() || (cursor !== path && !item.isDirectory())) throw new Error("Snapshot path contains a link or special ancestor");
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Snapshot root is invalid");
    cursor = parent;
  }
  const canonical = realpathSync.native(path);
  const normalize = (value: string) => platform === "windows" ? value.toLowerCase() : value;
  if (normalize(canonical) !== normalize(path)) throw new Error("Snapshot path is redirected");
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile()) throw new Error("Snapshot is not a regular file");
  return file;
}

/** The callback receives only a proven regular descriptor. Revalidate the path
 * and descriptor after use so replacement, truncation and in-place mutation fail
 * closed. Callers own their read limits and still charge bytes on failure. */
function withVerifiedPosixRegularFile<T>(path: string, read: (fd: number) => T): T {
  const platform = currentPlatformId;
  assertDiskPath(path, platform);
  const absolute = resolve(path);
  const before = inspectDiskPath(absolute, platform);
  if (platform === "windows" || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error("Safe file flags unavailable");
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(absolute, flags);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameObject(before, opened) || !sameObject(opened, inspectDiskPath(absolute, platform))) {
      throw new Error("Snapshot identity changed before reading");
    }
    const result = read(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!sameObject(opened, after) || !sameObject(after, inspectDiskPath(absolute, platform))) throw new Error("Snapshot changed during reading");
    return result;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Platform-owned regular-handle hashing with an explicit content I/O bound. */
function hashPosixSnapshot(path: string, size: number, chunkBytes: number): SnapshotHashResult {
  let bytesRead = 0;
  try {
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("Invalid read limits");
    assertDiskPath(path, currentPlatformId);
    return withVerifiedPosixRegularFile(path, fd => {
      if (fstatSync(fd).size !== size) return { valid: false, bytesRead };
      const hash = createHash("sha256"), chunk = Buffer.alloc(chunkBytes);
      while (bytesRead < size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - bytesRead), bytesRead);
        if (!count) return { valid: false, bytesRead };
        bytesRead += count; hash.update(chunk.subarray(0, count));
      }
      return { valid: true, bytesRead, digest: hash.digest("hex") };
    });
  } catch { return { valid: false, bytesRead }; }
}

/** The complete list shares one native Windows process and one content budget. */
export function hashVerifiedRegularFiles(requests: Array<{ path: string; size: number }>,
  limits: { fileBytes: number; totalBytes: number; chunkBytes: number }): SnapshotReadResult[] {
  const results: SnapshotReadResult[] = requests.map(() => ({ status: "read", valid: false, bytesRead: 0 }));
  const native: Array<{ index: number; request: WindowsSnapshotRequest }> = [];
  let remaining = limits.totalBytes;
  for (const [index, request] of requests.entries()) {
    if (!Number.isSafeInteger(request.size) || request.size < 0) continue;
    if (request.size > limits.fileBytes || request.size > remaining) {
      results[index] = { status: "budget", valid: false, bytesRead: 0 }; continue;
    }
    if (currentPlatformId === "windows") {
      try {
        assertDiskPath(request.path, currentPlatformId);
        const path = resolve(request.path), identity = inspectDiskPath(path, currentPlatformId);
        native.push({ index, request: { path, size: request.size, identity } });
      } catch {
        // Keep its position: earlier reads may exhaust the shared budget before
        // this invalid path, which must still report budget rather than unreadable.
        native.push({ index, request: { path: "", size: request.size, identity: { dev: 0n, ino: 0n } } });
      }
    } else {
      const result = hashPosixSnapshot(request.path, request.size, limits.chunkBytes);
      results[index] = { status: "read", ...result }; remaining -= result.bytesRead;
    }
  }
  if (native.some(item => item.request.path)) {
    const reads = hashWindowsSnapshots(native.map(item => item.request), limits.totalBytes, limits.chunkBytes);
    for (const [index, entry] of native.entries()) results[entry.index] = reads[index];
  }
  return results;
}

export interface FsSecurityDeps {
  chmodSync?(path: string, mode: number): void;
  execFileSync?(file: string, args: readonly string[], options: { encoding?: "utf-8"; stdio?: "ignore"; windowsHide?: boolean }): string;
  execSync?(command: string, options: { encoding: "utf-8"; timeout: number }): string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 给托管脚本补可执行位（仅 POSIX 有意义）。
 * 对应各处的 `if (executable && process.platform !== "win32") chmodSync(path, 0o755)`；
 * 失败是 best effort（与迁移前一样吞掉）。
 */
export function ensureExecutable(
  path: string,
  platform: PlatformId = currentPlatformId,
  deps: Pick<FsSecurityDeps, "chmodSync"> = {},
): void {
  if (platform === "windows") return;
  const chmod = deps.chmodSync ?? chmodSync;
  try {
    chmod(path, 0o755);
  } catch {
    /* best effort */
  }
}

/** 兼容旧名（memory/ExternalCliMemoryAssets 等既有调用点）。 */
export const ensureExecutableFile = ensureExecutable;

export interface DiskSpaceSnapshot {
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

/**
 * 解析 PowerShell `(Get-PSDrive X).Used,(Get-PSDrive X).Free` 的两行输出。
 * 解析失败按 0 处理（与迁移前 `parseInt(...) || 0` 完全一致；只有命令本身失败才返回 null）。
 */
export function parsePowerShellDiskSpace(raw: string): DiskSpaceSnapshot {
  const [usedStr, freeStr] = raw.trim().split(/\r?\n/);
  const usedBytes = parseInt(usedStr ?? "", 10) || 0;
  const freeBytes = parseInt(freeStr ?? "", 10) || 0;
  return { usedBytes, totalBytes: usedBytes + freeBytes, freeBytes };
}

/**
 * 磁盘容量兜底（statfsSync 不可用/NTFS 语义差异时）：Windows 用 PowerShell 的 Get-PSDrive。
 * 逐字搬迁自 AppSettingsStore.getDiskSpace 的 fallback 分支：
 *   powershell -NoProfile -Command "(Get-PSDrive C).Used,(Get-PSDrive C).Free"
 * 其它平台没有等价命令，返回 null（AppSettingsStore 继续用 statfs 或 0 兜底）。
 */
export function readDiskSpaceFallback(
  dir: string,
  platform: PlatformId = currentPlatformId,
  deps: Pick<FsSecurityDeps, "execSync"> = {},
): DiskSpaceSnapshot | null {
  if (platform !== "windows") return null;
  try {
    const driveLetter = dir.substring(0, 1).toUpperCase();
    const cmd = `powershell -NoProfile -Command "(Get-PSDrive ${driveLetter}).Used,(Get-PSDrive ${driveLetter}).Free"`;
    const run = deps.execSync ?? ((command: string, options: { encoding: "utf-8"; timeout: number }) => String(execSync(command, options)));
    const raw = run(cmd, { encoding: "utf-8", timeout: 8000 });
    return parsePowerShellDiskSpace(raw);
  } catch {
    return null;
  }
}

/**
 * 收紧 Memory Gateway 密钥文件权限：POSIX 用 0600；Windows 额外用 icacls 去掉继承，
 * 只授权当前账户与 SYSTEM（icacls 失败是致命的——不能带着"只靠 no-op mode"的密钥文件启动网关）。
 * 逐字搬迁自 MemoryGatewayFileSecurity.protectMemoryGatewaySecretFile。
 */
export function protectSecretFile(
  path: string,
  platform: PlatformId = currentPlatformId,
  deps: FsSecurityDeps = {},
): void {
  const chmod = deps.chmodSync ?? chmodSync;
  chmod(path, 0o600);
  if (platform !== "windows") return;

  const env = deps.env ?? process.env;
  const exec = deps.execFileSync ?? (execFileSync as FsSecurityDeps["execFileSync"])!;
  const systemRoot = env.SystemRoot || "C:\\Windows";
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const identity = String(
    exec(whoami, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf-8",
      windowsHide: true,
    }),
  );
  const sid = identity.match(/S-1-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new Error("无法确定当前 Windows 用户 SID，拒绝使用未受保护的 Memory Gateway 密钥文件");
  exec(icacls, [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}
