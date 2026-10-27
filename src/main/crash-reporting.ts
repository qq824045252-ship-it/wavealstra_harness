/**
 * 崩溃可观测性（§5-7）
 *
 * 1. `configureCrashReporting`：在 app ready 前把 Electron crashDumps 指向
 *    `~/.mybuddy/crashdumps` 并启动 crashReporter（uploadToServer:false）。
 * 2. `installFaultHandlers`：记录 uncaughtException / unhandledRejection 的完整栈与进程信息，
 *    记录后移除自身监听并重新抛出，保持 Node/Electron 既有默认处理（不吞错、不改变退出策略）。
 * 3. `createProcessGoneReporter`：渲染进程/子进程异常退出时写日志 + 发用户可见通知，
 *    同类事件在节流窗口内只提示一次，避免崩溃循环刷屏。
 *
 * 本模块不 import electron：`app` / `crashReporter` / `NotificationService.publish` 都由
 * `src/main/index.ts` 注入，纯逻辑因此可以在 node 测试里直接跑。
 */
import { mkdirSync } from "node:fs";
import { currentNodePlatform } from "./platform/runtime";
import { join } from "node:path";
import { getMyBuddyDir } from "./paths";
import type { RuntimeLogger } from "./runtime-logging";

export const CRASH_DUMPS_DIR_NAME = "crashdumps";
export const PROCESS_GONE_THROTTLE_MS = 5 * 60_000;

export function resolveCrashDumpsDir(myBuddyDir: string = getMyBuddyDir()): string {
  return join(myBuddyDir, CRASH_DUMPS_DIR_NAME);
}

/* ------------------------------------------------------------------ */
/* crashReporter / crashDumps 装配                                      */
/* ------------------------------------------------------------------ */

export interface CrashReporterStartOptions {
  productName: string;
  uploadToServer: boolean;
  compress: boolean;
  version: string;
  platform: string;
  extra?: Record<string, string>;
}

export interface CrashReporterLike {
  start(options: CrashReporterStartOptions): void;
}

export interface CrashAppPathLike {
  setPath(name: "crashDumps", path: string): void;
}

export interface ConfigureCrashReportingInput {
  app: CrashAppPathLike;
  crashReporter: CrashReporterLike;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  myBuddyDir?: string;
  productName?: string;
  version?: string;
  platform?: string;
  mkdir?: (path: string) => void;
}

export interface CrashReportingResult {
  crashDumpsDir: string;
  started: boolean;
}

/**
 * 必须在 `app.whenReady()` 之前调用。目录创建 / setPath / start 都用 try/catch 包住：
 * 崩溃上报只是可观测性，任何失败都不能阻断应用启动。
 */
export function configureCrashReporting(input: ConfigureCrashReportingInput): CrashReportingResult {
  const crashDumpsDir = resolveCrashDumpsDir(input.myBuddyDir ?? getMyBuddyDir());
  const createDir = input.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  try {
    createDir(crashDumpsDir);
  } catch (error) {
    // 目录建不了不阻断启动：crashReporter 仍会尝试在 setPath 指定的位置初始化；
    // 真正的失败在 start 或后续 dump 时才暴露，这里留下日志即可。
    input.logger.warn("crash", `创建 crashDumps 目录失败：${crashDumpsDir}`, error);
  }
  try {
    input.app.setPath("crashDumps", crashDumpsDir);
  } catch (error) {
    input.logger.warn("crash", "app.setPath('crashDumps') 失败", error);
    return { crashDumpsDir, started: false };
  }
  const options: CrashReporterStartOptions = {
    productName: input.productName ?? "MyBuddy",
    uploadToServer: false,
    compress: true,
    version: input.version ?? "unknown",
    platform: input.platform ?? currentNodePlatform,
    extra: { electron: process.versions.electron ?? "unknown", node: process.versions.node ?? "unknown" },
  };
  try {
    input.crashReporter.start(options);
  } catch (error) {
    input.logger.warn("crash", "crashReporter.start 失败", error);
    return { crashDumpsDir, started: false };
  }
  input.logger.info(
    "crash",
    `crashReporter started（product=${options.productName} version=${options.version} uploadToServer=false compress=true）` +
      `；本地 dump 目录：${crashDumpsDir}`,
  );
  return { crashDumpsDir, started: true };
}

/* ------------------------------------------------------------------ */
/* 进程异常退出 → 日志 + 用户可见通知                                    */
/* ------------------------------------------------------------------ */

export type ProcessGoneKind = "renderer" | "child";

export interface ProcessGoneDetails {
  reason?: string;
  exitCode?: number;
  type?: string;
  serviceName?: string;
  name?: string;
}

export interface CrashRuntimeNotification {
  type: "runtime.failed";
  level: "warning" | "error";
  title: string;
  body: string;
  sourceType: "runtime";
  sourceId: string;
  dedupeKey: string;
}

export interface ProcessGoneDescription {
  notification: CrashRuntimeNotification;
  /** 写日志用的单行摘要（不含用户隐私数据）。 */
  summary: string;
}

export function describeProcessGone(kind: ProcessGoneKind, details: ProcessGoneDetails): ProcessGoneDescription {
  const reason = (details.reason ?? "unknown").trim() || "unknown";
  const exitCode = typeof details.exitCode === "number" ? details.exitCode : -1;
  const childType = (details.type ?? "unknown").trim() || "unknown";
  const service = details.serviceName?.trim() || details.name?.trim() || "";
  const summary = `kind=${kind} type=${kind === "child" ? childType : "renderer"} reason=${reason} exitCode=${exitCode}${
    service ? ` service=${service}` : ""
  }`;
  if (kind === "renderer") {
    return {
      summary,
      notification: {
        type: "runtime.failed",
        level: "error",
        title: "界面进程异常退出",
        body: `渲染进程已退出（reason=${reason} exitCode=${exitCode}）。应用会尝试自动重载；若仍白屏请重启 MyBuddy。日志：~/.mybuddy/logs/`,
        sourceType: "runtime",
        sourceId: "renderer-process",
        dedupeKey: `runtime:process-gone:renderer:${reason}:${exitCode}`,
      },
    };
  }
  const isGpu = childType.toUpperCase() === "GPU";
  return {
    summary,
    notification: {
      type: "runtime.failed",
      level: isGpu ? "warning" : "error",
      title: isGpu ? "图形进程异常退出" : "后台进程异常退出",
      body: `${isGpu ? "GPU" : childType} 进程已退出（reason=${reason} exitCode=${exitCode}${
        service ? ` service=${service}` : ""
      }）。应用会尝试恢复；若界面异常请重启 MyBuddy。日志：~/.mybuddy/logs/`,
      sourceType: "runtime",
      sourceId: isGpu ? "gpu-process" : "child-process",
      dedupeKey: `runtime:process-gone:child:${childType}:${reason}:${exitCode}`,
    },
  };
}

export interface CreateProcessGoneReporterInput {
  logger: Pick<RuntimeLogger, "warn" | "error">;
  publish?: (notification: CrashRuntimeNotification) => unknown;
  throttleMs?: number;
  now?: () => number;
}

export interface ProcessGoneReportResult {
  published: boolean;
  throttled: boolean;
}

/**
 * 返回 reporter：每次异常退出写日志；`publish` 存在且未被节流时发通知。
 * 节流键包含 kind/type/reason/exitCode —— 崩溃循环期间用户只看到一次同类提示。
 */
export function createProcessGoneReporter(
  input: CreateProcessGoneReporterInput,
): (kind: ProcessGoneKind, details: ProcessGoneDetails) => ProcessGoneReportResult {
  const throttleMs = Math.max(0, input.throttleMs ?? PROCESS_GONE_THROTTLE_MS);
  const now = input.now ?? (() => Date.now());
  const lastPublishedAt = new Map<string, number>();
  return (kind, details) => {
    const description = describeProcessGone(kind, details);
    if (kind === "renderer") {
      input.logger.error("process", `render-process-gone ${description.summary}`);
    } else {
      input.logger.warn("process", `child-process-gone ${description.summary}`);
    }
    const publish = input.publish;
    if (!publish) return { published: false, throttled: false };
    const at = now();
    const last = lastPublishedAt.get(description.notification.dedupeKey);
    if (last !== undefined && at - last < throttleMs) {
      input.logger.warn(
        "process",
        `同类 ${kind} 退出通知已节流（${Math.max(0, at - last)}ms < ${throttleMs}ms）：${description.summary}`,
      );
      return { published: false, throttled: true };
    }
    lastPublishedAt.set(description.notification.dedupeKey, at);
    try {
      publish(description.notification);
      return { published: true, throttled: false };
    } catch (error) {
      input.logger.warn("process", "发布进程异常通知失败", error);
      return { published: false, throttled: false };
    }
  };
}

/* ------------------------------------------------------------------ */
/* uncaughtException / unhandledRejection                              */
/* ------------------------------------------------------------------ */

export type FaultKind = "uncaughtException" | "unhandledRejection";

export interface FaultProcessLike {
  on(event: FaultKind, listener: (value: unknown) => void): unknown;
  removeListener(event: FaultKind, listener: (value: unknown) => void): unknown;
  listenerCount?(event: FaultKind): number;
  pid?: number;
  platform?: string;
  arch?: string;
  versions?: Partial<Record<string, string | undefined>>;
  uptime?: () => number;
  memoryUsage?: () => { rss?: number };
}

export function normalizeFaultError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(`Non-error thrown: ${JSON.stringify(value)}`);
  } catch {
    return new Error(`Non-error thrown: ${String(value)}`);
  }
}

export interface FaultProcessInfo {
  pid?: number;
  platform?: string;
  arch?: string;
  electron?: string;
  node?: string;
  uptimeSec?: number;
  rssMb?: number;
}

export function collectProcessInfo(processLike: FaultProcessLike = process as unknown as FaultProcessLike): FaultProcessInfo {
  const info: FaultProcessInfo = {
    pid: processLike.pid,
    platform: processLike.platform,
    arch: processLike.arch,
    electron: processLike.versions?.electron,
    node: processLike.versions?.node,
  };
  try {
    if (processLike.uptime) info.uptimeSec = Math.round(processLike.uptime());
  } catch {
    /* 进程信息尽力采集 */
  }
  try {
    const rss = processLike.memoryUsage?.().rss;
    if (typeof rss === "number") info.rssMb = Math.round(rss / (1024 * 1024));
  } catch {
    /* 同上 */
  }
  return info;
}

export function formatFaultReport(kind: FaultKind, value: unknown, info: FaultProcessInfo): string {
  const error = normalizeFaultError(value);
  const stack = error.stack?.trim() ? error.stack : `${error.name}: ${error.message}`;
  return `${kind}: ${error.message}\n${stack}\nprocess: ${JSON.stringify(info)}`;
}

export interface InstallFaultHandlersInput {
  logger: Pick<RuntimeLogger, "error">;
  processLike?: FaultProcessLike;
  processInfo?: () => FaultProcessInfo;
  /** 默认：setImmediate 重新抛出，让 Node/Electron 默认处理（打印 + 退出）继续生效。 */
  rethrow?: (error: Error) => void;
}

export interface FaultHandlersHandle {
  uninstall(): void;
  handlers: Record<FaultKind, (value: unknown) => void>;
}

/**
 * 关键点：记录后先摘掉自己的监听，再把错误重新抛给默认处理器 —— 既不吞错，也不改变
 * 进程退出方式。若进程中还有其它 uncaughtException/unhandledRejection 监听者，
 * 则不再重抛（由既有监听者决定行为），避免重复处理。
 */
export function installFaultHandlers(input: InstallFaultHandlersInput): FaultHandlersHandle {
  const processLike = input.processLike ?? (process as unknown as FaultProcessLike);
  const rethrow = input.rethrow ?? ((error: Error) => {
    setImmediate(() => {
      throw error;
    });
  });
  const collect = input.processInfo ?? (() => collectProcessInfo(processLike));
  const handlers = {} as Record<FaultKind, (value: unknown) => void>;
  let installed = true;

  const record = (kind: FaultKind, value: unknown): void => {
    try {
      input.logger.error("fatal", formatFaultReport(kind, value, collect()));
    } catch {
      /* 日志失败不能改变崩溃处理 */
    }
  };

  const detach = (): void => {
    if (!installed) return;
    installed = false;
    try {
      processLike.removeListener("uncaughtException", handlers.uncaughtException);
      processLike.removeListener("unhandledRejection", handlers.unhandledRejection);
    } catch {
      /* 移除失败时仍继续重抛 */
    }
  };

  const othersListening = (event: FaultKind): boolean => {
    try {
      return typeof processLike.listenerCount === "function" && processLike.listenerCount(event) > 0;
    } catch {
      return false;
    }
  };

  handlers.uncaughtException = (value: unknown) => {
    record("uncaughtException", value);
    detach();
    if (!othersListening("uncaughtException")) rethrow(normalizeFaultError(value));
  };
  handlers.unhandledRejection = (value: unknown) => {
    record("unhandledRejection", value);
    detach();
    if (!othersListening("uncaughtException") && !othersListening("unhandledRejection")) {
      rethrow(normalizeFaultError(value));
    }
  };

  processLike.on("uncaughtException", handlers.uncaughtException);
  processLike.on("unhandledRejection", handlers.unhandledRejection);

  return {
    uninstall: detach,
    handlers,
  };
}
