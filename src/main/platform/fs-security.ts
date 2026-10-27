/**
 * 文件安全（platform/fs-security）：可执行位（POSIX chmod）与 Windows ACL 收紧。
 *
 * 迁自 memory/ExternalCliMemoryAssets.ts（可执行位）与 memory/MemoryGatewayFileSecurity.ts
 * （Windows：whoami 取 SID + icacls 去继承、只授权当前用户与 SYSTEM）。
 * Windows 逻辑逐字保留；POSIX 上 chmod 才是权威，`ensureExecutableFile` 在 Windows 上必须是空操作。
 */
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

export interface FsSecurityDeps {
  chmodSync?(path: string, mode: number): void;
  execFileSync?(file: string, args: readonly string[], options: { encoding?: "utf-8"; stdio?: "ignore"; windowsHide?: boolean }): string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 给托管脚本补可执行位（仅 POSIX 有意义）。
 * 对应各处的 `if (executable && process.platform !== "win32") chmodSync(path, 0o755)`；
 * 失败是 best effort（与迁移前一样吞掉）。
 */
export function ensureExecutableFile(
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
