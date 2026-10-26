/**
 * 进程发现（platform/processes）：端口归属 / 镜像名 → pid / pid → 可执行文件路径。
 *
 * 背景：这三件事原来以 `defaultListListeningPids` / `defaultRunningPidsByImageName` /
 * `defaultPidExecutablePath` 内联在 `professional-tools/ProfessionalToolRuntime.ts` 里，
 * 且开头都写着 `if (process.platform !== "win32") return []`——Linux 上端口归属能力恒为空。
 * 按平台边界约定搬到这里，并补齐 Linux 的真实实现（Windows 逻辑逐字保留）。
 *
 * 三个函数签名与 `ProfessionalToolPlatformOps` 对应成员一致：
 *   listListeningPids(port): Promise<number[]>        —— netstat（win）/ ss（linux）
 *   listPidsByImageName(name): Promise<number[]>      —— tasklist（win）/ /proc/*\/comm（linux）
 *   pidExecutablePath(pid): Promise<string | null>    —— PowerShell CIM（win）/ /proc/<pid>/exe（linux）
 * 失败/不可用一律返回 [] / null（探测型 API，不抛错），与搬迁前行为一致。
 *
 * 可测性：`createProcessDiscovery(platform, { runner, fs })` 允许注入假 runner / 假 /proc，
 * 解析逻辑同时导出纯函数（`parseSsListeningPids` / `parseProcCommMatches`），测试不依赖真实进程。
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { currentPlatformId, type PlatformId } from "./index";

export interface ProcessRunResult {
  code: number;
  output: string;
}

export interface ProcessRunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** 可注入的异步执行器（默认 spawn 实现，与搬迁前 `defaultRun` 逐字一致）。 */
export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

/** 可注入的 /proc 读取（Linux 专用；测试用假实现，避免依赖真实进程）。 */
export interface ProcessFsDeps {
  readdir(path: string): string[];
  readFile(path: string, encoding: "utf-8"): string;
  readlink(path: string): string;
}

export interface ProcessDiscoveryDeps {
  runner?: ProcessRunner;
  fs?: ProcessFsDeps;
}

export interface ProcessDiscovery {
  listListeningPids(port: number): Promise<number[]>;
  listPidsByImageName(imageName: string): Promise<number[]>;
  pidExecutablePath(pid: number): Promise<string | null>;
}

/**
 * 子进程执行（原 `ProfessionalToolRuntime.defaultRun`）：stdout+stderr 合并、整体超时后 kill。
 * 超时时输出 `[timed out after Nms]` 标记（调用方据此区分「没输出」与「超时」）。
 */
export function runProcess(
  command: string,
  args: string[],
  options?: ProcessRunOptions,
): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    });
    let output = "";
    const timer =
      options?.timeoutMs != null
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* best effort */
            }
          }, options.timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        output: timer && output.length === 0 ? `[timed out after ${options?.timeoutMs}ms]` : output,
      });
    });
  });
}

export const defaultProcessRunner: ProcessRunner = { run: runProcess };

const defaultFsDeps: ProcessFsDeps = {
  readdir: (path) => readdirSync(path),
  readFile: (path, encoding) => readFileSync(path, encoding),
  readlink: (path) => readlinkSync(path),
};

function uniquePositivePids(pids: Iterable<number>): number[] {
  const out: number[] = [];
  for (const pid of pids) {
    if (Number.isFinite(pid) && pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

// ---------------------------------------------------------------- Windows

/**
 * netstat 端口归属：`netstat -ano -p tcp` 解析 LISTENING 行 → pid 列表。
 * 逻辑与搬迁前一致（含既有近似匹配 `line.includes(":port")`，不做「顺手修 bug」以免行为漂移）。
 */
async function windowsListeningPids(runner: ProcessRunner, port: number): Promise<number[]> {
  try {
    const { code, output } = await runner.run("netstat", ["-ano", "-p", "tcp"], { timeoutMs: 5_000 });
    if (code !== 0) return [];
    const wanted = `:${port}`;
    const pids: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      // TCP    127.0.0.1:9876    0.0.0.0:0    LISTENING    1234
      const m = /\s+LISTENING\s+(\d+)\s*$/i.exec(line.trim());
      if (!m) continue;
      if (!line.includes(wanted)) continue;
      const pid = Number(m[1]);
      if (Number.isFinite(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

/** tasklist 镜像名 → pid 列表（Windows；`/FO CSV /NH`）。 */
async function windowsPidsByImageName(runner: ProcessRunner, imageName: string): Promise<number[]> {
  try {
    const { code, output } = await runner.run(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      { timeoutMs: 5_000 },
    );
    if (code !== 0) return [];
    const pids: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      // "blender.exe","1234","Console","1","123,456 K"
      const m = /^"[^"]*","(\d+)"/.exec(line.trim());
      if (!m) continue;
      const pid = Number(m[1]);
      if (Number.isFinite(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

/** 进程可执行文件路径（PowerShell Get-CimInstance；比已废弃的 wmic 稳）。 */
async function windowsPidExecutablePath(runner: ProcessRunner, pid: number): Promise<string | null> {
  try {
    // 单行输出避免编码问题
    const ps = [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").ExecutablePath`,
    ];
    const { code, output } = await runner.run("powershell", ps, { timeoutMs: 5_000 });
    if (code !== 0) return null;
    const path = output.trim().split(/\r?\n/)[0]?.trim();
    return path ? path : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Linux

/**
 * `ss -ltnp` 输出 → 监听指定端口的 pid 列表。
 *
 * 行格式（列宽会变）：
 *   LISTEN 0 511 127.0.0.1:36899 0.0.0.0:* users:(("node-MainThread",pid=53918,fd=22))
 * 说明：
 * - 本地地址列（第 4 列）末尾的 `:<port>` 才计入；IPv6 形如 `[::]:8080`；
 * - 一行可能列出多个 pid（SO_REUSEPORT / 多进程 fork），全部收集；
 * - 没有 `users:` 段的行（权限不足或 `-p` 不可用）不会产生 pid——这是保守行为：
 *   调用方据此走「归属未知」分支，而不是伪造归属。
 */
export function parseSsListeningPids(output: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^state\s/i.test(trimmed)) continue; // 表头
    const cols = trimmed.split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[0]!.toUpperCase() !== "LISTEN") continue;
    const local = cols[3]!;
    const portMatch = /:(\d+)$/.exec(local);
    if (!portMatch) continue;
    if (Number(portMatch[1]) !== port) continue;
    for (const hit of trimmed.matchAll(/\bpid=(\d+)/g)) {
      const pid = Number(hit[1]);
      if (Number.isFinite(pid) && pid > 0) pids.push(pid);
    }
  }
  return uniquePositivePids(pids);
}

/**
 * 镜像名匹配（/proc/<pid>/comm 是**内核裁剪到 15 字符**且通常不带 `.exe`）。
 * 规则（大小写不敏感）：comm == imageName，或 comm + ".exe" == imageName，
 * 或 comm == imageName 去掉 ".exe" 后缀。
 */
export function imageNameMatchesComm(comm: string, imageName: string): boolean {
  const name = imageName.trim().toLowerCase();
  const proc = comm.trim().replace(/\0/g, "").toLowerCase();
  if (!proc || !name) return false;
  if (proc === name) return true;
  // 两侧都去掉可选的 .exe 再比：comm 通常不带扩展名，调用方传的是 imageName（如 blender.exe）。
  const stripExe = (value: string): string => value.replace(/\.exe$/i, "");
  return stripExe(proc) === stripExe(name);
}

/** 已读到的 (pid, comm) 列表 → 匹配的 pid（纯函数，便于测试）。 */
export function parseProcCommMatches(
  entries: Iterable<{ pid: number; comm: string }>,
  imageName: string,
): number[] {
  const pids: number[] = [];
  for (const entry of entries) {
    if (imageNameMatchesComm(entry.comm, imageName)) pids.push(entry.pid);
  }
  return uniquePositivePids(pids);
}

/** 扫 /proc/*\/comm（Linux）。逐进程容错：读不到（权限/退出竞态）就跳过。 */
async function linuxPidsByImageName(fs: ProcessFsDeps, imageName: string): Promise<number[]> {
  try {
    const entries: Array<{ pid: number; comm: string }> = [];
    for (const name of fs.readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        entries.push({ pid, comm: fs.readFile(`/proc/${name}/comm`, "utf-8") });
      } catch {
        /* 进程已退出 / 权限不足 */
      }
    }
    return parseProcCommMatches(entries, imageName);
  } catch {
    return [];
  }
}

/** `ss -ltnp`。ss 缺失（精简容器）或非 0 退出 => []。 */
async function linuxListeningPids(runner: ProcessRunner, port: number): Promise<number[]> {
  try {
    const { code, output } = await runner.run("ss", ["-ltnp"], { timeoutMs: 5_000 });
    if (code !== 0) return [];
    return parseSsListeningPids(output, port);
  } catch {
    return [];
  }
}

/**
 * pid → 可执行文件路径（`/proc/<pid>/exe` 是符号链接）。
 * 进程已退出（ENOENT）/ 属于其他用户（EACCES）=> null。
 * 二进制被替换后内核会给出 `/path (deleted)` 后缀，这里剥掉以便调用方做前缀比较。
 */
async function linuxPidExecutablePath(fs: ProcessFsDeps, pid: number): Promise<string | null> {
  try {
    const target = fs.readlink(`/proc/${pid}/exe`);
    const path = target.replace(/\s+\(deleted\)$/, "").trim();
    return path ? path : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 工厂

/**
 * 按平台构造进程发现实现。
 *
 * @param platform 目标平台，默认当前进程
 * @param deps     runner/fs 注入（测试用）
 */
export function createProcessDiscovery(
  platform: PlatformId = currentPlatformId,
  deps: ProcessDiscoveryDeps = {},
): ProcessDiscovery {
  const runner = deps.runner ?? defaultProcessRunner;
  const fs = deps.fs ?? defaultFsDeps;
  switch (platform) {
    case "windows":
      return {
        listListeningPids: (port) => windowsListeningPids(runner, port),
        listPidsByImageName: (name) => windowsPidsByImageName(runner, name),
        pidExecutablePath: (pid) => windowsPidExecutablePath(runner, pid),
      };
    case "linux":
      return {
        listListeningPids: (port) => linuxListeningPids(runner, port),
        listPidsByImageName: (name) => linuxPidsByImageName(fs, name),
        pidExecutablePath: (pid) => linuxPidExecutablePath(fs, pid),
      };
    case "macos":
    default:
      // macOS 暂未接入（lsof / libproc 需要额外依赖）；先保持与搬迁前等价的「无信息」语义。
      return {
        listListeningPids: async () => [],
        listPidsByImageName: async () => [],
        pidExecutablePath: async () => null,
      };
  }
}

// ---------------------------------------------------------------- 当前平台便捷导出
// 业务侧默认用这三个（与 ProfessionalToolPlatformOps 同名同签名），需要注入时用工厂。

export function listListeningPids(port: number): Promise<number[]> {
  return createProcessDiscovery().listListeningPids(port);
}

export function listPidsByImageName(imageName: string): Promise<number[]> {
  return createProcessDiscovery().listPidsByImageName(imageName);
}

export function pidExecutablePath(pid: number): Promise<string | null> {
  return createProcessDiscovery().pidExecutablePath(pid);
}
