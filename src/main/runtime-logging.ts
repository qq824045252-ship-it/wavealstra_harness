/**
 * 主进程运行日志（§5-7 崩溃可观测性）
 *
 * - 落点：`<MyBuddyDir>/logs/main-YYYYMMDD.log`（打包版与 dev 一致）。
 * - 行格式：`YYYY-MM-DD HH:mm:ss.SSS LEVEL [scope] message`；带 error 时追加换行后的 stack。
 * - 轮转：按天 + 单文件超限；总保留份数默认 7（含当天文件）。
 * - 关键错误由调用方同时 `console.error`（保持既有 dev 日志行为）与本 logger 双写。
 *
 * 设计：路径/命名/排序/保留计划/格式化都是纯函数；`RuntimeLogger` 通过可注入的文件操作
 * 与时钟落盘，测试不需要写真实 `~/.mybuddy`。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";

export const RUNTIME_LOG_PREFIX = "main";
export const RUNTIME_LOG_DIR_NAME = "logs";
export const DEFAULT_LOG_RETENTION = 7;
export const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024;

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogEntry {
  at: Date;
  level: RuntimeLogLevel;
  scope: string;
  message: string;
  error?: unknown;
}

export interface LogFileNameParts {
  /** `YYYYMMDD`（本地时区）。 */
  day: string;
  /** 0 = 当天当前文件；N>=1 = 当天因大小轮转产生的旧文件。 */
  index: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLogTimestamp(at: Date): string {
  return (
    `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ` +
    `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}` +
    `.${String(at.getMilliseconds()).padStart(3, "0")}`
  );
}

/** 本地时区日戳 `YYYYMMDD`，日志按天轮转的唯一依据。 */
export function logDayStamp(at: Date): string {
  return `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}`;
}

export function dailyLogFileName(at: Date, prefix = RUNTIME_LOG_PREFIX): string {
  return `${prefix}-${logDayStamp(at)}.log`;
}

export function rotatedLogFileName(at: Date, index: number, prefix = RUNTIME_LOG_PREFIX): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`rotated log index must be a positive integer (got ${index})`);
  }
  return `${prefix}-${logDayStamp(at)}-${index}.log`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析本 logger 认领的文件名；非本 logger 文件（包括其它前缀）返回 null。 */
export function parseLogFileName(name: string, prefix = RUNTIME_LOG_PREFIX): LogFileNameParts | null {
  const match = new RegExp(`^${escapeRegExp(prefix)}-(\\d{8})(?:-(\\d+))?\\.log$`).exec(name);
  if (!match) return null;
  const index = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { day: match[1], index };
}

/** 越新越大（最旧在前），用于保留计划；无法解析的名字排最旧。 */
export function compareLogFileRecency(a: string, b: string, prefix = RUNTIME_LOG_PREFIX): number {
  const pa = parseLogFileName(a, prefix);
  const pb = parseLogFileName(b, prefix);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.day !== pb.day) return pa.day < pb.day ? -1 : 1;
  return pa.index - pb.index;
}

/**
 * 保留策略：只保留最新 `retention` 份，返回应删除的文件名（旧→新）。
 * `retention` 至少为 1；非本 logger 的文件不参与、也不会被删。
 */
export function planLogRetention(
  names: readonly string[],
  retention = DEFAULT_LOG_RETENTION,
  prefix = RUNTIME_LOG_PREFIX,
): string[] {
  const keep = Math.max(1, Math.floor(retention));
  const owned = names
    .filter((name) => parseLogFileName(name, prefix) !== null)
    .sort((a, b) => compareLogFileRecency(a, b, prefix));
  const excess = owned.length - keep;
  return excess > 0 ? owned.slice(0, excess) : [];
}

export function formatLogError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack?.trim() ? error.stack : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function formatLogLine(entry: RuntimeLogEntry): string {
  const scope = entry.scope.trim() || "main";
  const head = `${formatLogTimestamp(entry.at)} ${entry.level.toUpperCase()} [${scope}] ${entry.message}`;
  return entry.error === undefined ? head : `${head}\n${formatLogError(entry.error)}`;
}

export function resolveRuntimeLogsDir(myBuddyDir: string = getMyBuddyDir()): string {
  return join(myBuddyDir, RUNTIME_LOG_DIR_NAME);
}

/** 可注入的文件系统操作（测试用内存实现；生产默认同步 fs）。 */
export interface RuntimeLoggerFileDeps {
  mkdir(dir: string): void;
  appendFile(file: string, data: string): void;
  readdir(dir: string): string[];
  rename(from: string, to: string): void;
  unlink(file: string): void;
  sizeOf(file: string): number;
  exists(file: string): boolean;
}

export interface RuntimeLoggerOptions {
  dir: string;
  prefix?: string;
  retention?: number;
  maxBytes?: number;
  now?: () => Date;
  deps?: Partial<RuntimeLoggerFileDeps>;
  /** 落盘失败时的兜底（默认 console.error）；日志系统自身绝不能打断主进程。 */
  onWriteError?: (error: unknown) => void;
}

const defaultFileDeps: RuntimeLoggerFileDeps = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  appendFile: (file, data) => appendFileSync(file, data),
  readdir: (dir) => readdirSync(dir),
  rename: (from, to) => renameSync(from, to),
  unlink: (file) => unlinkSync(file),
  sizeOf: (file) => statSync(file).size,
  exists: (file) => existsSync(file),
};

export class RuntimeLogger {
  readonly dir: string;
  readonly prefix: string;
  readonly retention: number;
  readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly deps: RuntimeLoggerFileDeps;
  private readonly onWriteError: (error: unknown) => void;
  private lastDay: string | null = null;
  private currentFile: string | null = null;

  constructor(options: RuntimeLoggerOptions) {
    this.dir = options.dir;
    this.prefix = options.prefix ?? RUNTIME_LOG_PREFIX;
    this.retention = Math.max(1, Math.floor(options.retention ?? DEFAULT_LOG_RETENTION));
    this.maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_LOG_BYTES));
    this.now = options.now ?? (() => new Date());
    this.deps = { ...defaultFileDeps, ...options.deps };
    this.onWriteError = options.onWriteError ?? ((error) => console.error("[runtime-logging] write failed", error));
  }

  /** 最近一次成功写入的文件路径；尚未写入时为 null。 */
  get currentFilePath(): string | null {
    return this.currentFile;
  }

  debug(scope: string, message: string, error?: unknown): void {
    this.write("debug", scope, message, error);
  }

  info(scope: string, message: string, error?: unknown): void {
    this.write("info", scope, message, error);
  }

  warn(scope: string, message: string, error?: unknown): void {
    this.write("warn", scope, message, error);
  }

  error(scope: string, message: string, error?: unknown): void {
    this.write("error", scope, message, error);
  }

  private write(level: RuntimeLogLevel, scope: string, message: string, error?: unknown): void {
    try {
      const at = this.now();
      const line = `${formatLogLine({ at, level, scope, message, error })}\n`;
      this.deps.mkdir(this.dir);
      const name = dailyLogFileName(at, this.prefix);
      const file = join(this.dir, name);
      if (this.deps.exists(file) && this.deps.sizeOf(file) + Buffer.byteLength(line) > this.maxBytes) {
        this.rotateDayFile(at);
        this.prune();
      }
      this.deps.appendFile(file, line);
      const dayChanged = this.lastDay !== null && this.lastDay !== logDayStamp(at);
      this.currentFile = file;
      this.lastDay = logDayStamp(at);
      if (dayChanged) this.prune();
    } catch (writeError) {
      try {
        this.onWriteError(writeError);
      } catch {
        /* 兜底回调也不能抛出 */
      }
    }
  }

  /** 当天文件超限：重命名为 `main-YYYYMMDD-N.log`，N 取当天已有最大 index + 1。 */
  private rotateDayFile(at: Date): void {
    const day = logDayStamp(at);
    const currentName = dailyLogFileName(at, this.prefix);
    const indexes = this.listLogNames()
      .map((name) => parseLogFileName(name, this.prefix))
      .filter((parts): parts is LogFileNameParts => parts !== null && parts.day === day)
      .map((parts) => parts.index);
    const nextIndex = (indexes.length > 0 ? Math.max(...indexes) : 0) + 1;
    this.deps.rename(join(this.dir, currentName), join(this.dir, rotatedLogFileName(at, nextIndex, this.prefix)));
  }

  /** 保留最新 `retention` 份（含当天文件），删除更旧的。 */
  prune(): string[] {
    const removed: string[] = [];
    const names = this.listLogNames();
    for (const name of planLogRetention(names, this.retention, this.prefix)) {
      try {
        this.deps.unlink(join(this.dir, name));
        removed.push(name);
      } catch (error) {
        this.onWriteError(error);
      }
    }
    return removed;
  }

  private listLogNames(): string[] {
    try {
      return this.deps.readdir(this.dir);
    } catch {
      return [];
    }
  }
}

let defaultLogger: RuntimeLogger | null = null;

/** 主进程唯一 logger（落盘到 ~/.mybuddy/logs）。首次调用时才创建，测试不会碰真实目录。 */
export function getRuntimeLogger(): RuntimeLogger {
  if (!defaultLogger) defaultLogger = new RuntimeLogger({ dir: resolveRuntimeLogsDir() });
  return defaultLogger;
}
