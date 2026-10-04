import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

/**
 * Restrict gateway secret material to the current Windows account and SYSTEM.
 * chmod is authoritative on POSIX; on Windows an icacls failure is fatal so the
 * gateway never starts with a token/grant store protected only by a no-op mode.
 */
export function protectMemoryGatewaySecretFile(path: string): void {
  chmodSync(path, 0o600);
  if (process.platform !== "win32") return;

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const identity = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf-8",
    windowsHide: true,
  });
  const sid = identity.match(/S-1-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new Error("无法确定当前 Windows 用户 SID，拒绝使用未受保护的 Memory Gateway 密钥文件");
  execFileSync(icacls, [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}
