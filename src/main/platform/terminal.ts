/**
 * 终端/Shell 平台差异（platform/terminal）。
 *
 * 迁自 terminal/TerminalHost.ts：默认 shell 选择（Windows 优先 PowerShell 7，回退 Windows PowerShell 5.1；
 * POSIX 用 $SHELL 或 /bin/zsh、/bin/bash）与 ConPTY 使用判定。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";
import { killProcessTree, type KillableChild } from "./processes";

export interface DefaultShellDeps {
  exists?(path: string): boolean;
  env?: NodeJS.ProcessEnv;
}

/** PWSH (PowerShell 7) 的安装位置。 */
export function pwshPath(env: NodeJS.ProcessEnv = process.env, platform: PlatformId = currentPlatformId): string {
  if (platform !== "windows") return "pwsh";
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  return join(programFiles, "PowerShell", "7", "pwsh.exe");
}

/** Windows PowerShell 5.1 的安装位置。 */
export function windowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: PlatformId = currentPlatformId,
): string {
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return platform === "windows"
    ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** POSIX 默认 shell（macOS 用 zsh，其余 bash）。 */
export function posixDefaultShell(platform: PlatformId = currentPlatformId): string {
  return platform === "macos" ? "/bin/zsh" : "/bin/bash";
}

/**
 * 平台默认 shell。
 * - windows：`%ProgramFiles%\PowerShell\7\pwsh.exe` 存在则用，否则 Windows PowerShell 5.1；
 * - POSIX：`$SHELL`，未设置时按 macOS/其它回落 zsh/bash。
 */
export function defaultShellForPlatform(
  platform: PlatformId = currentPlatformId,
  deps: DefaultShellDeps = {},
): string {
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  if (platform === "windows") {
    const pwsh = pwshPath(env, platform);
    if (exists(pwsh)) return pwsh;
    return windowsPowerShellPath(env, platform);
  }
  return env.SHELL || posixDefaultShell(platform);
}

export function terminateTerminalProcess(pty: KillableChild, platform: PlatformId = currentPlatformId): void {
  // ConPTY 的 kill 同时释放已退出 shell 遗留的原生句柄，不能按进程存活省略。
  if (platform !== "windows" && pty.pid) killProcessTree(pty, { platform });
  pty.kill();
}

/** 终端后端是否使用 ConPTY（仅 Windows 有）。 */
export function useConpty(platform: PlatformId = currentPlatformId): boolean {
  return platform === "windows";
}
