/**
 * 文件安全（platform/fs-security）：可执行位（POSIX chmod）与 Windows ACL 收紧。
 *
 * 迁自 memory/ExternalCliMemoryAssets.ts（可执行位）与 memory/MemoryGatewayFileSecurity.ts
 * （Windows：whoami 取 SID + icacls 去继承、只授权当前用户与 SYSTEM）。
 * Windows 逻辑逐字保留；POSIX 上 chmod 才是权威，`ensureExecutableFile` 在 Windows 上必须是空操作。
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

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
