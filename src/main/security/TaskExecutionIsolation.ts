/**
 * TaskExecutionIsolation — Shell 执行隔离后端等级（P2 / Batch 12）
 *
 * 等级：
 *  - cwd-only：只设 cwd，不安全，仅兼容/对比
 *  - guarded：默认；cwd + writePaths 策略预检，不抵抗任意脚本
 *  - os-sandbox：实验性加固执行（默认关闭，需设置显式开启）
 *      · 强制 cwd=taskRoot、清理危险 env、超时杀进程树
 *      · writePaths 策略预检
 *      · 未通过完整逃逸测试 → experimental=true, escapeTested=false，不得对外宣称 OS 强制沙箱
 *
 * 默认等级 = guarded；os-sandbox 仅 opt-in。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { TaskFileAccessPolicy } from "./TaskFileAccessPolicy";

export type IsolationLevel = "cwd-only" | "guarded" | "os-sandbox";

export interface ExecutionRequest {
  taskId: string;
  taskRoot: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** 可选：预检路径（若调用方能解析出写目标） */
  writePaths?: string[];
}

export interface ExecutionResult {
  level: IsolationLevel;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  blocked?: boolean;
  reason?: string;
  /** os-sandbox 为 true：实验性，未通过完整逃逸证明 */
  experimental?: boolean;
}

export interface IsolationCapability {
  level: IsolationLevel;
  /** 是否为产品默认 */
  isDefault: boolean;
  /** 实验性（未完成逃逸测试） */
  experimental: boolean;
  /** 是否已通过逃逸测试矩阵 */
  escapeTested: boolean;
  description: string;
}

export interface TaskExecutionIsolationBackend {
  readonly level: IsolationLevel;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}

/** 当前产品默认等级（os-sandbox 不默认开启） */
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = "guarded";

const VALID_LEVELS: ReadonlySet<string> = new Set(["cwd-only", "guarded", "os-sandbox"]);

export function normalizeIsolationLevel(raw: unknown): IsolationLevel {
  if (typeof raw === "string" && VALID_LEVELS.has(raw)) return raw as IsolationLevel;
  return DEFAULT_ISOLATION_LEVEL;
}

export function getIsolationCapability(level: IsolationLevel): IsolationCapability {
  switch (level) {
    case "cwd-only":
      return {
        level,
        isDefault: false,
        experimental: false,
        escapeTested: false,
        description: "仅设置工作目录，无写范围强制（不安全）",
      };
    case "guarded":
      return {
        level,
        isDefault: true,
        experimental: false,
        escapeTested: false,
        description: "工作目录 + 已知越界预检；任意脚本仍可能写外部（非 OS 沙箱）",
      };
    case "os-sandbox":
      return {
        level,
        isDefault: false,
        experimental: true,
        escapeTested: false,
        description:
          "实验性加固：强制 cwd、清理危险环境变量、超时杀进程树、写路径预检。未通过完整逃逸测试，默认关闭",
      };
    default:
      return {
        level: "guarded",
        isDefault: true,
        experimental: false,
        escapeTested: false,
        description: describeIsolationLevel("guarded"),
      };
  }
}

function baseBlocked(level: IsolationLevel, reason: string, experimental?: boolean): ExecutionResult {
  return {
    level,
    exitCode: null,
    stdout: "",
    stderr: reason,
    timedOut: false,
    blocked: true,
    reason,
    experimental,
  };
}

function assertWritePaths(
  level: IsolationLevel,
  request: ExecutionRequest,
  experimental?: boolean,
): ExecutionResult | null {
  if (!request.writePaths?.length) return null;
  const policy = new TaskFileAccessPolicy({
    taskId: request.taskId,
    taskRoot: request.taskRoot,
  });
  for (const p of request.writePaths) {
    const d = policy.decide("write", p);
    if (!d.allowed) {
      return baseBlocked(level, `${level} 预检拒绝写路径：${p}（${d.reason}）`, experimental);
    }
  }
  return null;
}

/** cwd-only：仅设置 cwd 后执行（不安全） */
export class CwdOnlyExecutionBackend implements TaskExecutionIsolationBackend {
  readonly level = "cwd-only" as const;

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!request.command?.trim()) return Promise.resolve(baseBlocked(this.level, "空命令被拒绝"));
    return spawnCommand(this.level, request, { treeKill: false, sanitizeEnv: false });
  }
}

/**
 * guarded（默认）：
 *  - 空命令拒绝
 *  - writePaths 策略预检
 *  - 仍无法阻止脚本内任意路径写入
 */
export class GuardedExecutionBackend implements TaskExecutionIsolationBackend {
  readonly level = "guarded" as const;

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!request.command?.trim()) return baseBlocked(this.level, "空命令被拒绝");
    const denied = assertWritePaths(this.level, request);
    if (denied) return denied;
    return spawnCommand(this.level, request, { treeKill: false, sanitizeEnv: false });
  }
}

/**
 * os-sandbox（实验性，opt-in）：
 *  - 默认不启用；由 settings.shellIsolationLevel = "os-sandbox" 打开
 *  - 强制 cwd、sanitize env、超时杀进程树、writePaths 预检
 *  - experimental=true / escapeTested=false：不得标称「已通过 OS 沙箱认证」
 */
export class OsSandboxExecutionBackend implements TaskExecutionIsolationBackend {
  readonly level = "os-sandbox" as const;

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!request.command?.trim()) {
      return baseBlocked(this.level, "空命令被拒绝", true);
    }
    if (!request.taskRoot?.trim()) {
      return baseBlocked(this.level, "os-sandbox 需要有效 taskRoot", true);
    }
    const denied = assertWritePaths(this.level, request, true);
    if (denied) return denied;

    const result = await spawnCommand(this.level, request, {
      treeKill: true,
      sanitizeEnv: true,
    });
    return { ...result, experimental: true };
  }
}

export function createExecutionBackend(level: IsolationLevel): TaskExecutionIsolationBackend {
  const normalized = normalizeIsolationLevel(level);
  switch (normalized) {
    case "cwd-only":
      return new CwdOnlyExecutionBackend();
    case "guarded":
      return new GuardedExecutionBackend();
    case "os-sandbox":
      return new OsSandboxExecutionBackend();
    default: {
      const _exhaustive: never = normalized;
      return _exhaustive;
    }
  }
}

/** 从设置值创建后端；非法值回退 guarded */
export function createExecutionBackendFromSettings(level: unknown): TaskExecutionIsolationBackend {
  return createExecutionBackend(normalizeIsolationLevel(level));
}

interface SpawnOptions {
  treeKill: boolean;
  sanitizeEnv: boolean;
}

function buildEnv(
  taskRoot: string,
  level: IsolationLevel,
  extra: Record<string, string | undefined> | undefined,
  sanitize: boolean,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = sanitize
    ? { ...process.env }
    : { ...process.env, ...extra };

  if (sanitize) {
    // 去掉可注入运行时行为的危险变量；再合并调用方 env（调用方显式传入仍可用）
    delete base.NODE_OPTIONS;
    delete base.ELECTRON_RUN_AS_NODE;
    delete base.ELECTRON_NO_ASAR;
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete base[k];
        else base[k] = v;
      }
    }
  }

  base.PWD = taskRoot;
  base.MYBUDDY_TASK_ROOT = taskRoot;
  base.MYBUDDY_SHELL_ISOLATION = level;
  return base;
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) {
    try {
      child.kill();
    } catch {
      /* */
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      /* fall through */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a process group leader */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* */
  }
}

function spawnCommand(
  level: IsolationLevel,
  request: ExecutionRequest,
  opts: SpawnOptions,
): Promise<ExecutionResult> {
  const timeoutMs = request.timeoutMs ?? 15_000;
  const args = request.args ?? [];
  const env = buildEnv(request.taskRoot, level, request.env, opts.sanitizeEnv);

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(request.command, args, {
      cwd: request.taskRoot,
      env,
      shell: false,
      windowsHide: true,
      // Unix：新进程组便于超时杀整树；Windows 用 taskkill /T
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (opts.treeKill) killProcessTree(child);
      else {
        try {
          child.kill();
        } catch {
          /* */
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        level,
        exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]`.trim() : stderr,
        timedOut,
        blocked: false,
        experimental: level === "os-sandbox",
      });
    };

    child.on("error", (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export function describeIsolationLevel(level: IsolationLevel): string {
  return getIsolationCapability(level).description;
}

/**
 * 给 pi bash spawnHook / 自定义 BashOperations 用：
 *  - 始终强制 cwd = taskRoot（任务目录隔离）
 *  - os-sandbox：清理危险环境变量
 *  - 注入 MYBUDDY_TASK_ROOT / MYBUDDY_SHELL_ISOLATION 便于诊断
 */
export function applyShellIsolationSpawnContext(
  level: IsolationLevel | unknown,
  taskRoot: string,
  ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv },
): { command: string; cwd: string; env: NodeJS.ProcessEnv } {
  const normalized = normalizeIsolationLevel(level);
  const root = taskRoot.trim() || ctx.cwd;
  const env: NodeJS.ProcessEnv = { ...ctx.env };

  if (normalized === "os-sandbox") {
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
  }

  env.PWD = root;
  env.MYBUDDY_TASK_ROOT = root;
  env.MYBUDDY_SHELL_ISOLATION = normalized;

  return {
    command: ctx.command,
    cwd: root,
    env,
  };
}
