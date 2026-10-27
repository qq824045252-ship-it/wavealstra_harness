import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, sep } from "node:path";
import {
  configureCrashReporting,
  createProcessGoneReporter,
  describeProcessGone,
  formatFaultReport,
  installFaultHandlers,
  normalizeFaultError,
  resolveCrashDumpsDir,
  collectProcessInfo,
  type CrashReporterStartOptions,
  type FaultProcessLike,
  type ProcessGoneDetails,
} from "../src/main/crash-reporting";
import {
  RuntimeLogger,
  dailyLogFileName,
  formatLogLine,
  formatLogTimestamp,
  logDayStamp,
  parseLogFileName,
  planLogRetention,
  resolveRuntimeLogsDir,
  rotatedLogFileName,
  type RuntimeLoggerFileDeps,
} from "../src/main/runtime-logging";

/**
 * 沙箱日志目录：用 join() 归一化后再用。
 * 内存 fs 的键是 `join(dir, name)` 的结果，若把 posix 字面量 "/sandbox/logs" 直接当 dir，
 * Windows 上 join 会把它变成 "\sandbox\logs"，两边对不上（readdir 永远返回空）。
 */
const LOGS_DIR = join("/sandbox", "logs");

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

/** 内存文件系统：RuntimeLogger 测试不触碰真实 ~/.mybuddy。 */
function memoryFs(): { files: Map<string, string>; deps: RuntimeLoggerFileDeps } {
  const files = new Map<string, string>();
  const deps: RuntimeLoggerFileDeps = {
    mkdir: () => undefined,
    appendFile: (file, data) => files.set(file, (files.get(file) ?? "") + data),
    // 键是 join(dir, name) 的结果，分隔符随宿主（Windows 是 "\\"），不能写死 "/"。
    readdir: (dir) =>
      [...files.keys()]
        .filter((file) => file.startsWith(`${dir}${sep}`))
        .map((file) => file.slice(dir.length + sep.length)),
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`rename missing ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    unlink: (file) => {
      files.delete(file);
    },
    sizeOf: (file) => Buffer.byteLength(files.get(file) ?? ""),
    exists: (file) => files.has(file),
  };
  return { files, deps };
}

const loggerStub = () => {
  const lines: string[] = [];
  return {
    lines,
    info: (_scope: string, message: string) => lines.push(`INFO ${message}`),
    warn: (_scope: string, message: string) => lines.push(`WARN ${message}`),
    error: (_scope: string, message: string) => lines.push(`ERROR ${message}`),
  };
};

/* ---------------- runtime-logging：纯函数 ---------------- */

test("formatLogTimestamp is deterministic local time with milliseconds", () => {
  const at = new Date(2026, 9, 26, 21, 5, 7, 42);
  assert.equal(formatLogTimestamp(at), "2026-10-26 21:05:07.042");
  assert.equal(logDayStamp(at), "20261026");
});

test("daily and size-rotated file names are predictable and parsable", () => {
  const at = new Date(2026, 9, 26, 23, 59, 59, 999);
  assert.equal(dailyLogFileName(at), "main-20261026.log");
  assert.equal(rotatedLogFileName(at, 1), "main-20261026-1.log");
  assert.deepEqual(parseLogFileName("main-20261026.log"), { day: "20261026", index: 0 });
  assert.deepEqual(parseLogFileName("main-20261026-3.log"), { day: "20261026", index: 3 });
  assert.equal(parseLogFileName("other-20261026.log"), null);
  assert.equal(parseLogFileName("main-2026102.log"), null);
  assert.throws(() => rotatedLogFileName(at, 0), RangeError);
});

test("retention keeps the newest N owned files and never deletes foreign files", () => {
  const names = [
    "main-20261024.log",
    "main-20261025-2.log",
    "main-20261025.log",
    "main-20261026.log",
    "unrelated.txt",
    "other-20261023.log",
  ];
  assert.deepEqual(planLogRetention(names, 2), ["main-20261024.log", "main-20261025.log"]);
  assert.deepEqual(planLogRetention(names, 3), ["main-20261024.log"]);
  assert.deepEqual(planLogRetention(names, 4), []);
  assert.deepEqual(planLogRetention(names, 100), []);
  // retention 下限为 1（5 个 owned 文件中删 3 个）
  assert.equal(planLogRetention(names, 0).length, 3);
});

test("log line format is `time LEVEL [scope] message`, stack appended for errors", () => {
  const at = new Date(2026, 9, 26, 21, 5, 7, 42);
  assert.equal(
    formatLogLine({ at, level: "info", scope: "main", message: "ready" }),
    "2026-10-26 21:05:07.042 INFO [main] ready",
  );
  const error = new Error("boom");
  const line = formatLogLine({ at, level: "error", scope: "", message: "failed", error });
  assert.match(line, /^2026-10-26 21:05:07\.042 ERROR \[main\] failed\nError: boom/);
  assert.match(line, /at /);
});

/* ---------------- runtime-logging：落盘/轮转/保留 ---------------- */

test("RuntimeLogger writes today's file and rotates by size", () => {
  const { files, deps } = memoryFs();
  const at = new Date(2026, 9, 26, 12, 0, 0, 0);
  const logger = new RuntimeLogger({
    dir: LOGS_DIR,
    retention: 7,
    maxBytes: 1024,
    deps,
    now: () => at,
  });
  const payload = "x".repeat(400);
  for (let i = 0; i < 4; i += 1) logger.info("main", `${i}:${payload}`);
  // 期望路径用 join() 拼：实现内部也是 join(dir, name)，宿主分隔符必须一致。
  const current = join(LOGS_DIR, "main-20261026.log");
  assert.ok(files.has(current), "current daily file exists");
  assert.ok(files.has(join(LOGS_DIR, "main-20261026-1.log")), "size rotation created -1 file");
  assert.equal(logger.currentFilePath, current);
  assert.match(files.get(current) ?? "", /INFO \[main\] 3:/);
});

test("RuntimeLogger prunes old days on day change", () => {
  const { files, deps } = memoryFs();
  let now = new Date(2026, 9, 26, 8, 0, 0, 0);
  const logger = new RuntimeLogger({ dir: LOGS_DIR, retention: 2, deps, now: () => now });
  logger.info("main", "day1");
  now = new Date(2026, 9, 27, 8, 0, 0, 0);
  logger.info("main", "day2");
  now = new Date(2026, 9, 28, 8, 0, 0, 0);
  logger.info("main", "day3");
  assert.deepEqual(
    [...files.keys()].sort(),
    [join(LOGS_DIR, "main-20261027.log"), join(LOGS_DIR, "main-20261028.log")],
  );
});

test("RuntimeLogger never throws when the filesystem fails", () => {
  const errors: unknown[] = [];
  const logger = new RuntimeLogger({
    dir: LOGS_DIR,
    deps: {
      mkdir: () => {
        throw new Error("read-only fs");
      },
    },
    onWriteError: (error) => errors.push(error),
  });
  assert.doesNotThrow(() => logger.error("main", "should not throw"));
  assert.equal(errors.length, 1);
});

test("log directory resolves under the MyBuddy profile", () => {
  assert.equal(resolveRuntimeLogsDir("/home/u/.mybuddy"), join("/home/u/.mybuddy", "logs"));
});

/* ---------------- crash-reporting：crashDumps / crashReporter ---------------- */

test("crashDumps path is <MyBuddyDir>/crashdumps", () => {
  assert.equal(resolveCrashDumpsDir("/home/u/.mybuddy"), join("/home/u/.mybuddy", "crashdumps"));
});

test("configureCrashReporting sets crashDumps and starts a local-only reporter", () => {
  const logger = loggerStub();
  const paths: Record<string, string> = {};
  const started: CrashReporterStartOptions[] = [];
  const createdDirs: string[] = [];
  const result = configureCrashReporting({
    app: { setPath: (name, path) => { paths[name] = path; } },
    crashReporter: { start: (options) => started.push(options) },
    logger,
    myBuddyDir: "/home/u/.mybuddy",
    productName: "MyBuddy",
    version: "0.1.49",
    platform: "linux",
    mkdir: (dir) => { createdDirs.push(dir); },
  });
  assert.equal(result.started, true);
  // 实现用 join(myBuddyDir, "crashdumps")，期望值必须同样随宿主分隔符。
  const expectedCrashes = join("/home/u/.mybuddy", "crashdumps");
  assert.equal(result.crashDumpsDir, expectedCrashes);
  assert.deepEqual(createdDirs, [expectedCrashes]);
  assert.equal(paths.crashDumps, expectedCrashes);
  assert.equal(started.length, 1);
  assert.equal(started[0].productName, "MyBuddy");
  assert.equal(started[0].uploadToServer, false);
  assert.equal(started[0].compress, true);
  assert.equal(started[0].version, "0.1.49");
  assert.equal(started[0].platform, "linux");
  assert.match(logger.lines.join("\n"), /crashDumps|crashdumps/);
});

test("configureCrashReporting degrades safely when start throws", () => {
  const logger = loggerStub();
  const result = configureCrashReporting({
    app: { setPath: () => undefined },
    crashReporter: { start: () => { throw new Error("crashpad unavailable"); } },
    logger,
    myBuddyDir: "/tmp/mb",
    mkdir: () => undefined,
  });
  assert.equal(result.started, false);
  assert.match(logger.lines.join("\n"), /crashReporter\.start 失败/);
});

/* ---------------- crash-reporting：process gone ---------------- */

test("describeProcessGone covers renderer and GPU/Utility children", () => {
  const renderer = describeProcessGone("renderer", { reason: "crashed", exitCode: 133 });
  assert.equal(renderer.notification.type, "runtime.failed");
  assert.equal(renderer.notification.level, "error");
  assert.equal(renderer.notification.sourceType, "runtime");
  assert.match(renderer.notification.body, /reason=crashed/);
  assert.match(renderer.notification.body, /exitCode=133/);

  const gpu = describeProcessGone("child", { type: "GPU", reason: "crashed", exitCode: 1 });
  assert.equal(gpu.notification.level, "warning");
  assert.match(gpu.summary, /type=GPU/);
  const utility = describeProcessGone("child", { type: "Utility", reason: "killed", exitCode: 9, serviceName: "network.mojom.NetworkService" });
  assert.equal(utility.notification.level, "error");
  assert.match(utility.notification.body, /service=network\.mojom\.NetworkService/);
  // 同一 kind/reason/exitCode 的 dedupeKey 稳定（节流与通知中心去重依赖它）
  assert.equal(
    describeProcessGone("renderer", { reason: "crashed", exitCode: 133 }).notification.dedupeKey,
    describeProcessGone("renderer", { reason: "crashed", exitCode: 133 }).notification.dedupeKey,
  );
});

test("createProcessGoneReporter logs every event, publishes once per throttle window", () => {
  const logger = loggerStub();
  const published: string[] = [];
  let now = 1_000_000;
  const report = createProcessGoneReporter({
    logger,
    publish: (notification) => published.push(notification.title),
    throttleMs: 60_000,
    now: () => now,
  });
  const details: ProcessGoneDetails = { reason: "crashed", exitCode: 133 };

  assert.deepEqual(report("renderer", details), { published: true, throttled: false });
  now += 5_000;
  assert.deepEqual(report("renderer", details), { published: false, throttled: true });
  now += 60_000;
  assert.deepEqual(report("renderer", details), { published: true, throttled: false });
  assert.equal(published.length, 2);
  // 日志不节流：3 次事件都留下了记录
  assert.equal(logger.lines.filter((line) => line.startsWith("ERROR")).length, 3);

  // 不带 publish 时只写日志
  const noNotify = createProcessGoneReporter({ logger, now: () => now });
  assert.deepEqual(noNotify("child", { type: "Utility", reason: "killed", exitCode: 9 }), {
    published: false,
    throttled: false,
  });
});

test("createProcessGoneReporter swallows publish errors after logging", () => {
  const logger = loggerStub();
  const report = createProcessGoneReporter({
    logger,
    publish: () => { throw new Error("notification service down"); },
  });
  assert.doesNotThrow(() => report("renderer", { reason: "oom", exitCode: 137 }));
  assert.match(logger.lines.join("\n"), /发布进程异常通知失败/);
});

/* ---------------- crash-reporting：fault handlers ---------------- */

function fakeProcess(): { emitter: EventEmitter; processLike: FaultProcessLike } {
  const emitter = new EventEmitter();
  const processLike: FaultProcessLike = {
    on: (event, listener) => { emitter.on(event, listener); return emitter; },
    removeListener: (event, listener) => { emitter.removeListener(event, listener); return emitter; },
    listenerCount: (event) => emitter.listenerCount(event),
    pid: 1234,
    platform: "linux",
    arch: "x64",
    versions: { electron: "44.5.1", node: "22.0.0" },
    uptime: () => 42.4,
    memoryUsage: () => ({ rss: 300 * 1024 * 1024 }),
  };
  return { emitter, processLike };
}

test("installFaultHandlers logs uncaughtException with stack and rethrows", () => {
  const logger = loggerStub();
  const { emitter, processLike } = fakeProcess();
  const rethrown: Error[] = [];
  const handle = installFaultHandlers({ logger, processLike, rethrow: (error) => rethrown.push(error) });
  const error = new Error("renderer bridge exploder");
  emitter.emit("uncaughtException", error);
  const logged = logger.lines.join("\n");
  assert.match(logged, /uncaughtException: renderer bridge exploder/);
  assert.match(logged, /at /);
  assert.match(logged, /"pid":1234/);
  assert.match(logged, /"electron":"44\.5\.1"/);
  assert.equal(rethrown.length, 1);
  assert.equal(rethrown[0], error);
  assert.equal(emitter.listenerCount("uncaughtException"), 0, "own listener detached before rethrow");
  handle.uninstall();
});

test("installFaultHandlers leaves exit policy alone when another listener exists", () => {
  const logger = loggerStub();
  const { emitter, processLike } = fakeProcess();
  const rethrown: Error[] = [];
  const other: unknown[] = [];
  emitter.on("uncaughtException", (value) => other.push(value));
  installFaultHandlers({ logger, processLike, rethrow: (error) => rethrown.push(error) });
  const error = new Error("handled elsewhere");
  emitter.emit("uncaughtException", error);
  assert.equal(rethrown.length, 0, "existing listener owns the outcome");
  assert.deepEqual(other, [error]);
  assert.match(logger.lines.join("\n"), /handled elsewhere/);
});

test("installFaultHandlers normalizes unhandled rejections and logs them", () => {
  const logger = loggerStub();
  const { emitter, processLike } = fakeProcess();
  const rethrown: Error[] = [];
  installFaultHandlers({ logger, processLike, rethrow: (error) => rethrown.push(error) });
  emitter.emit("unhandledRejection", "promise blew up");
  const logged = logger.lines.join("\n");
  assert.match(logged, /unhandledRejection: promise blew up/);
  assert.equal(rethrown.length, 1);
  assert.equal(rethrown[0].message, "promise blew up");
  assert.equal(normalizeFaultError({ code: 500 }).message, 'Non-error thrown: {"code":500}');
});

test("formatFaultReport and collectProcessInfo keep diagnostics complete", () => {
  const { processLike } = fakeProcess();
  const info = collectProcessInfo(processLike);
  assert.equal(info.pid, 1234);
  assert.equal(info.uptimeSec, 42);
  assert.equal(info.rssMb, 300);
  const report = formatFaultReport("uncaughtException", new Error("kaput"), info);
  assert.match(report, /^uncaughtException: kaput\n/);
  assert.match(report, /process: \{"pid":1234/);
});

test("uninstall removes both fault listeners", () => {
  const logger = loggerStub();
  const { emitter, processLike } = fakeProcess();
  const handle = installFaultHandlers({ logger, processLike });
  assert.equal(emitter.listenerCount("uncaughtException"), 1);
  assert.equal(emitter.listenerCount("unhandledRejection"), 1);
  handle.uninstall();
  assert.equal(emitter.listenerCount("uncaughtException"), 0);
  assert.equal(emitter.listenerCount("unhandledRejection"), 0);
});

console.log(`\n${passed} crash-reporting tests passed`);
