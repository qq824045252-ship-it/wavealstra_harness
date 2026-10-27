/**
 * 外部程序发现（platform/apps）：where/which、可执行后缀优先级、adb / npx 候选、
 * 外部 CLI 启动方式（.ps1 → powershell、.cmd/.bat → cmd）、连接器平台键、Windows 漫游目录。
 *
 * 迁自 ProfessionalToolRuntime.resolveNpx / RemoteUsbBridge.findAdb / ConnectorService.platformKey /
 * ExternalAgentRuntime.whereFirst / spawnCommand / resolveNativeCommand / launch 的 Windows 分支。
 * Windows 逻辑逐字保留；Linux/macOS 用 where/which、PATH 分隔符等真实等价。
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentNodePlatform, pathListSeparator } from "./runtime";

export interface WhereFirstDeps {
  /** 测试注入：默认 execFileSync（同步、失败抛错），统一返回字符串。 */
  execFileSync?(command: string, args: string[], options: { encoding: "utf8"; windowsHide: boolean; stdio: ["ignore", "pipe", "ignore"] }): string;
}

const defaultExecFileSync: NonNullable<WhereFirstDeps["execFileSync"]> = (command, args, options) =>
  String(execFileSync(command, args, options));

/** `where`（Windows）/ `which`（POSIX）。`exe: true` 时 Windows 用 `where.exe`。 */
export function whereCommand(platform: NodeJS.Platform = currentNodePlatform, options: { exe?: boolean } = {}): string {
  if (platform === "win32") return options.exe ? "where.exe" : "where";
  return "which";
}

/**
 * Windows 上 npm 同时产出无扩展名的 POSIX shim 与 .cmd/.ps1 启动器：
 * 优先返回 Windows 能直接执行的扩展名，.ps1 作为最后回落。POSIX 取第一行。
 */
export function pickExecutablePath(rows: readonly string[], platform: NodeJS.Platform = currentNodePlatform): string | null {
  const cleaned = rows.map((line) => line.trim()).filter(Boolean);
  if (platform !== "win32") return cleaned[0] ?? null;
  const priority = [".exe", ".com", ".cmd", ".bat", ".ps1"];
  for (const ext of priority) {
    const hit = cleaned.find((row) => row.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return cleaned[0] ?? null;
}

/** `where`/`which` 找第一个可执行路径（迁自 ExternalAgentRuntime.whereFirst）。 */
export function whereFirst(
  command: string,
  platform: NodeJS.Platform = currentNodePlatform,
  deps: WhereFirstDeps = {},
): string | null {
  const run = deps.execFileSync ?? defaultExecFileSync;
  try {
    const output = run(whereCommand(platform, { exe: true }), [command], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return pickExecutablePath(output.split(/\r?\n/), platform);
  } catch {
    return null;
  }
}

/**
 * Devin 桌面端自带的 CLI（仅 Windows）。迁自 ExternalAgentRuntime.resolveNativeCommand 的 devin 分支。
 */
export function devinDesktopBundledCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = currentNodePlatform,
  deps: { exists?(path: string): boolean } = {},
): string | null {
  if (platform !== "win32") return null;
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const exists = deps.exists ?? existsSync;
  const candidate = join(
    localAppData,
    "Programs",
    "Devin",
    "resources",
    "app",
    "extensions",
    "windsurf",
    "devin",
    "bin",
    "devin.exe",
  );
  return exists(candidate) ? candidate : null;
}

function quoteCmdArg(value: string): string {
  if (!/[\s&|<>^()"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 启动外部 CLI。Windows：
 * - `.ps1` → powershell -File；
 * - `.cmd`/`.bat`（以及无 .exe/.com 后缀的）→ cmd.exe /d /s /c；
 * - 其余直接 spawn。
 * 迁自 ExternalAgentRuntime.spawnCommand（逐字保留判定顺序与参数）。
 */
export function spawnExternalCliCommand(
  command: string,
  args: string[],
  cwd: string,
  platform: NodeJS.Platform = currentNodePlatform,
  deps: WhereFirstDeps & { spawn?(...a: Parameters<typeof spawn>): ChildProcessWithoutNullStreams } = {},
): ChildProcessWithoutNullStreams {
  const resolved = whereFirst(command, platform, deps) ?? command;
  const spawnImpl = deps.spawn ?? (spawn as (...a: Parameters<typeof spawn>) => ChildProcessWithoutNullStreams);
  if (platform === "win32") {
    const lower = resolved.toLowerCase();
    if (lower.endsWith(".ps1")) {
      return spawnImpl("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    }
    if (lower.endsWith(".cmd") || lower.endsWith(".bat") || (!lower.endsWith(".exe") && !lower.endsWith(".com"))) {
      const line = [resolved, ...args].map(quoteCmdArg).join(" ");
      return spawnImpl("cmd.exe", ["/d", "/s", "/c", line], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    }
  }
  return spawnImpl(resolved, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
}

/**
 * Command Code ACP 的入口注入（迁自 ExternalAgentRuntime.launch 的 `manifest.id === "command"` 分支）。
 * Windows 上 npm 的 `cmdc` 是无扩展名 shim，ACP 需要显式 node 入口。
 */
export function commandCodeAcpEnv(
  commandCodePath: string,
  platform: NodeJS.Platform = currentNodePlatform,
  deps: { exists?(path: string): boolean } = {},
): Record<string, string> {
  if (platform !== "win32") return { COMMAND_CODE_ACP_CMD_PATH: commandCodePath };
  const exists = deps.exists ?? existsSync;
  const nodeEntry = join(dirname(commandCodePath), "node_modules", "command-code", "dist", "index.mjs");
  if (!exists(nodeEntry)) throw new Error("未找到 Command Code Node 入口");
  return { COMMAND_CODE_ACP_NODE_ENTRY: nodeEntry };
}

/** adb 可执行文件名（Windows 需 .exe）。 */
export function adbExecutableName(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "adb.exe" : "adb";
}

/**
 * adb 候选路径（顺序与 RemoteUsbBridge.findAdb 完全一致）：
 * MYBUDDY_ADB_PATH → ANDROID_SDK_ROOT/ANDROID_HOME → Windows 默认 SDK 目录 → PATH → 裸名。
 */
export function adbCandidatePaths(
  platform: NodeJS.Platform = currentNodePlatform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const executable = adbExecutableName(platform);
  const candidates = new Set<string>();
  if (env.MYBUDDY_ADB_PATH?.trim()) candidates.add(env.MYBUDDY_ADB_PATH.trim());
  for (const sdk of [env.ANDROID_SDK_ROOT, env.ANDROID_HOME]) {
    if (sdk?.trim()) candidates.add(join(sdk.trim(), "platform-tools", executable));
  }
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.add(join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", executable));
    if (env.USERPROFILE) {
      candidates.add(join(env.USERPROFILE, "AppData", "Local", "Android", "Sdk", "platform-tools", executable));
    }
  }
  for (const entry of (env.PATH || "").split(pathListSeparator(platform)).filter(Boolean)) {
    candidates.add(join(entry, executable));
  }
  candidates.add(executable);
  return [...candidates];
}

/** npx 的 PATH 探测命令（where/which）。 */
export function npxProbeCommand(platform: NodeJS.Platform = currentNodePlatform): string {
  return whereCommand(platform);
}

/** npx 的常见安装路径（PATH 探测失败时的回退）。 */
export function npxFallbackPaths(platform: NodeJS.Platform = currentNodePlatform): string[] {
  return platform === "win32"
    ? ["C:\\Program Files\\nodejs\\npx.cmd", "C:\\Program Files (x86)\\nodejs\\npx.cmd"]
    : ["/usr/bin/npx", "/usr/local/bin/npx"];
}

/**
 * 连接器外部 CLI 清单的平台键：清单用 NodeJS 的 platform 名（"win32"/"darwin"/"linux"）索引。
 * 迁自 ConnectorService.platformKey。
 */
export function connectorPlatformKey(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform;
}

/**
 * 当前平台的漫游配置目录（Windows：%APPDATA% 或 `<home>/AppData/Roaming`；其它平台返回空串，
 * 表示"该平台没有这个概念"，调用方据此跳过对应导入路径）。迁自 McpConfigService 的 apdata。
 */
export function roamingAppDataDir(
  home: string,
  platform: NodeJS.Platform = currentNodePlatform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return "";
}
