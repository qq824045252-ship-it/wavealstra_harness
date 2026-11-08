import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

import type { RemoteCloudflaredStatus } from "../../../shared/src/remote-contract";

/**
 * 只做「本机有没有 cloudflared CLI」的探测：
 * 解析 PATH（GUI 启动的进程常常拿不到完整的 shell PATH，因此再补几个常见安装目录），
 * 找到后用 `--version` 读出版本号。**绝不启动隧道、不改任何配置、不联网。**
 */

/** PATH 之外的常见安装目录（只用于「找不到」时兜底；PATH 命中优先） */
const WELL_KNOWN_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"],
  darwin: ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"],
};

const VERSION_PATTERNS = [
  /cloudflared\s+version\s+([0-9][0-9A-Za-z.+_-]*)/i,
  /\bversion\s+(\d{4}\.\d+\.\d+[0-9A-Za-z.+_-]*)/i,
];

/** 从 `cloudflared version 2026.10.2 (built ...)` / `Version 2026.10.2 (...)` 里取版本号 */
export function parseCloudflaredVersion(output: string): string | undefined {
  for (const pattern of VERSION_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows 上 X_OK 与 F_OK 等价；这里只是排除「存在但不可执行」的占位文件。
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveCloudflaredOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 传 [] 可关闭常见目录兜底（测试用） */
  wellKnownDirs?: readonly string[];
}

/** 返回 PATH（含兜底目录）里第一个可执行的 cloudflared 绝对路径 */
export function resolveCloudflaredPath(options: ResolveCloudflaredOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const binaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";

  const pathValue = platform === "win32" ? env.PATH ?? env.Path ?? "" : env.PATH ?? "";
  const pathDirs = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const fallbackDirs = options.wellKnownDirs ?? WELL_KNOWN_DIRS[platform] ?? [];
  const windowsFallbacks = platform === "win32"
    ? [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : undefined]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => join(dir, "cloudflared"))
    : [];

  for (const dir of [...pathDirs, ...fallbackDirs, ...windowsFallbacks]) {
    const candidate = join(dir, binaryName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export interface DetectCloudflaredOptions extends ResolveCloudflaredOptions {
  timeoutMs?: number;
}

/** 探测结果永不抛错：找不到就是 `{ installed: false }`，跑不起来带上 `error` */
export function detectCloudflared(options: DetectCloudflaredOptions = {}): Promise<RemoteCloudflaredStatus> {
  const binary = resolveCloudflaredPath(options);
  if (!binary) return Promise.resolve({ installed: false });
  return new Promise<RemoteCloudflaredStatus>((resolveResult) => {
    execFile(
      binary,
      ["--version"],
      { timeout: options.timeoutMs ?? 2000, windowsHide: true, maxBuffer: 64 * 1024, env: options.env ?? process.env },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const version = parseCloudflaredVersion(output);
        if (version) {
          resolveResult({ installed: true, binary, version });
          return;
        }
        resolveResult({
          installed: true,
          binary,
          error: output ? output.slice(0, 200) : error?.message ?? "无法读取 cloudflared 版本",
        });
      },
    );
  });
}
