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
import { execFile, spawn } from "node:child_process";
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

// ---------------------------------------------------------------- 进程树终止
// 迁自四处各自的实现，语义按调用方保留（Windows 一律 taskkill /T /F，POSIX 走进程组信号）：
//   · security/TaskExecutionIsolation.ts  —— Windows taskkill；POSIX SIGKILL 组杀；回退 child.kill
//   · cad/FreeCadInterop.ts               —— Windows taskkill；POSIX 只 child.kill（不组杀）
//   · capabilities/web-access/github-extract.ts —— Windows execFile taskkill（失败回退）；
//                                            POSIX SIGTERM 组杀 → 3s 后 SIGKILL（unref）
//   · runtime/PythonExecutor.ts           —— Windows taskkill（error 回退 child.kill）；
//                                            POSIX SIGTERM 组杀 → 1s 后 SIGKILL（保留 timer 供清理）

export interface KillableChild {
  pid?: number | null;
  exitCode?: number | null;
  kill(signal?: NodeJS.Signals): void;
}

export interface KillProcessTreeOptions {
  platform?: PlatformId;
  /** Windows：`spawn`（默认，stdio ignore）或 `execFile`（github-extract 的回调语义）。 */
  windowsMode?: "spawn" | "execFile";
  /** Windows taskkill 失败/异步 error 时的回退（不传则不回退，与各调用点原行为一致）。 */
  onWindowsError?: () => void;
  /** taskkill 子进程是否 unref（github-extract 会立即返回）。 */
  unref?: boolean;
  /** Windows taskkill 命令名（PythonExecutor 原用 "taskkill.exe"，其余用 "taskkill"）。 */
  windowsTaskkillCommand?: string;
  /** 测试注入：POSIX 信号发送（默认 process.kill）。 */
  killProcess?(pid: number, signal: NodeJS.Signals): boolean;
  /** 测试注入：Windows spawn 版 taskkill（默认 spawn(taskkill, …, {stdio:"ignore"})）。 */
  spawnTaskkill?(command: string, args: string[]): {
    on?(event: "error", listener: () => void): unknown;
    unref?(): void;
  };
  /** 测试注入：Windows execFile 版 taskkill（默认 execFile(..., cb)）。 */
  execFileTaskkill?(command: string, args: string[], done: (error: Error | null) => void): { unref?(): void };
  /** POSIX 是否做进程组杀（FreeCadInterop 传 false）。 */
  groupKill?: boolean;
  /** POSIX 首个信号（默认 SIGKILL，匹配 TaskExecutionIsolation / FreeCadInterop）。 */
  posixSignal?: NodeJS.Signals;
  /** POSIX 升级信号（github-extract / PythonExecutor 用 SIGTERM → SIGKILL）。 */
  escalateSignal?: NodeJS.Signals;
  escalateAfterMs?: number;
  /** 升级计时器是否 unref。 */
  unrefEscalation?: boolean;
  /** POSIX 信号失败后的回退（默认 child.kill）；传 false 表示不回退。 */
  onPosixError?: (() => void) | false;
  /** 拿不到 pid 时的回退（TaskExecutionIsolation：child.kill()；其它：什么都不做）。 */
  onMissingPid?: () => void;
  /** POSIX 组杀成功但需要额外动作时不用；保留给将来。 */
  afterPosixSignal?: () => void;
  /**
   * 子进程级升级（不做进程组杀的调用方用，如 UvToolchain）：
   * 先 child.kill()，afterMs 后仍未退出再 child.kill(signal)。
   */
  childEscalation?: { signal: NodeJS.Signals; afterMs: number };
}

function safeKill(child: KillableChild, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* 进程已退出 */
  }
}

/** 子进程级升级计时（UvToolchain 语义：不组杀，超时后对同一子进程补 SIGKILL）。 */
function scheduleChildEscalation(
  child: KillableChild,
  options: KillProcessTreeOptions,
): ReturnType<typeof setTimeout> | undefined {
  const escalate = options.childEscalation;
  if (!escalate) return undefined;
  const timer = setTimeout(() => {
    if (child.exitCode == null) safeKill(child, escalate.signal);
  }, escalate.afterMs);
  if (options.unrefEscalation) timer.unref();
  return timer;
}

/**
 * 终止子进程树。返回升级计时器（调用方可 clearTimeout；无升级时 undefined）。
 */
export function killProcessTree(
  child: KillableChild,
  options: KillProcessTreeOptions = {},
): ReturnType<typeof setTimeout> | undefined {
  const platform = options.platform ?? currentPlatformId;
  const pid = child.pid;
  if (pid == null) {
    options.onMissingPid?.();
    return undefined;
  }
  // Reserved/invalid PIDs must not reach signals, child fallbacks or timers:
  // POSIX -1 broadcasts to other processes, while 0 targets the current group.
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;

  if (platform === "windows") {
    const args = ["/PID", String(pid), "/T", "/F"];
    const taskkill = options.windowsTaskkillCommand ?? "taskkill";
    if (options.windowsMode === "execFile") {
      const execTaskkill = options.execFileTaskkill
        ?? ((command: string, cmdArgs: string[], done: (error: Error | null) => void) =>
          execFile(command, cmdArgs, { windowsHide: true }, done));
      const killer = execTaskkill(taskkill, args, (error) => {
        if (error) options.onWindowsError?.();
      });
      if (options.unref) killer.unref?.();
      return undefined;
    }
    const spawnTaskkill = options.spawnTaskkill
      ?? ((command: string, cmdArgs: string[]) => spawn(command, cmdArgs, { windowsHide: true, stdio: "ignore" }));
    try {
      const killer = spawnTaskkill(taskkill, args);
      if (options.onWindowsError) killer.on?.("error", () => options.onWindowsError?.());
    } catch {
      if (options.onWindowsError) options.onWindowsError();
      else if (options.childEscalation) {
        // 与迁移前 UvToolchain 一致：taskkill 起不来时回退到 child.kill + 升级
        safeKill(child);
        scheduleChildEscalation(child, options);
      }
    }
    return undefined;
  }

  const onPosixError = options.onPosixError;
  if (options.groupKill === false) {
    safeKill(child);
    return scheduleChildEscalation(child, options);
  }
  const signal = options.posixSignal ?? "SIGKILL";
  const killProcess = options.killProcess ?? ((target: number, sig: NodeJS.Signals) => process.kill(target, sig));
  try {
    killProcess(-pid, signal);
  } catch {
    // 组杀失败（不是进程组组长/已退出）：按调用方语义回退到 child.kill，
    // 但**仍继续**设置升级计时器（与 github-extract / PythonExecutor 原实现一致）。
    if (onPosixError === false) return undefined;
    if (onPosixError) onPosixError();
    else safeKill(child, signal);
  }

  if (!options.escalateSignal || !options.escalateAfterMs) return undefined;
  const timer = setTimeout(() => {
    try {
      killProcess(-pid, options.escalateSignal!);
    } catch {
      if (onPosixError !== false) safeKill(child, options.escalateSignal);
    }
  }, options.escalateAfterMs);
  if (options.unrefEscalation) timer.unref();
  return timer;
}
