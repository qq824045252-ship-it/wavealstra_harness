import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { prepareTaskWorkspace } from "../src/main/task/prepareTaskWorkspace";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { PythonRuntimeService } from "../src/main/runtime/PythonRuntimeService";
import { venvPythonRelativePath } from "../src/main/runtime/PythonEnvironmentStore";
import type { UvExecResult, UvExecutor, UvToolchainInfo } from "../src/main/runtime/UvToolchain";
import { LibraryService } from "../src/main/library/LibraryService";
import { previewWorkspaceFile, snapshotWorkspace } from "../src/main/workspace/WorkspaceService";
import { loadTaskHistoryFromSession } from "../src/main/agent/session-history";
import { estimateMessageHeight } from "../src/renderer/src/lib/messageSizeEstimate";
import { prepareTestEnv, minimalTask } from "./test-store-harness";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { TerminalHost, type PtyLike } from "../src/main/terminal/TerminalHost";

interface Metric { name: string; samples: number[]; p50: number; p95: number; min: number; max: number; }
class PerfPty implements PtyLike {
  readonly pid = 1;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb; }
  write(_data: string): void {}
  resize(_cols: number, _rows: number): void {}
  kill(): void { this.exitCb?.({ exitCode: 0 }); }
  emitData(data: string): void { this.dataCb?.(data); }
}
class PerfFakeUv implements UvExecutor {
  locate(): UvToolchainInfo { return { available: true, path: "Z:\\fake\\uv.exe", version: "0.12.13", source: "env" }; }
  async ensure(): Promise<UvToolchainInfo> { return this.locate(); }
  async exec(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<UvExecResult> {
    const ok = (stdout = ""): UvExecResult => ({ code: 0, stdout, stderr: "", cancelled: false });
    if (options?.signal?.aborted) return { code: null, stdout: "", stderr: "", cancelled: true };
    if (args[0] === "python" && args[1] === "find") return ok("fake-python");
    if (args[0] === "lock") {
      if (options?.cwd) writeFileSync(join(options.cwd, "uv.lock"), "perf-lock", "utf8");
      return ok();
    }
    if (args[0] === "sync") {
      const target = options?.env?.UV_PROJECT_ENVIRONMENT;
      if (!target) return { code: 1, stdout: "", stderr: "missing UV_PROJECT_ENVIRONMENT", cancelled: false };
      const python = join(target, venvPythonRelativePath("win32"));
      mkdirSync(join(python, ".."), { recursive: true });
      writeFileSync(python, "fake interpreter", "utf8");
      return ok();
    }
    if (args[0] === "pip" && args[1] === "freeze") return ok("six==1.17.0");
    if (args[0] === "-c" || command === "fake-python") return ok("3.12.7");
    return ok();
  }
}
function pythonRuntimeOptions(root: string) {
  return {
    uv: new PerfFakeUv(), platform: "win32" as NodeJS.Platform,
    runtimeDir: root, environmentsDir: join(root, "environments"), manifestsDir: join(root, "manifests"),
    stagingDir: join(root, "staging"), interpretersDir: join(root, "interpreters"),
    cacheDir: join(root, "cache"), toolchainDir: join(root, "toolchain"),
  };
}
function percentile(sorted: number[], p: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}
function summarize(name: string, samples: number[]): Metric {
  const sorted = [...samples].sort((a, b) => a - b);
  return { name, samples, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}
const REFERENCE_P95_BUDGET_MS: Record<string, number> = {
  "startup.db-schema/cold": 100,
  "startup.db-open/warm": 40,
  "prompt.local-preflight/100-files": 10,
  "runtime.python-orchestration/cold": 20,
  "runtime.python-orchestration/hot": 3,
  "library.search specific/800": 10,
  "library.search miss/800": 10,
  "library.search short/800": 75,
  "workspace.snapshot/5000": 120,
  "workspace.preview-text/16MB": 75,
  "terminal.background-open/100": 120,
  "session.history/1000-turns": 50,
  "renderer.setActiveTask/300x120": 5,
  "chat.height-estimate/5000": 5,
};
const REFERENCE_MAX_RSS_MB = 512;
function fmt(metric: Metric): string {
  return `${metric.name}: p50=${metric.p50.toFixed(2)}ms p95=${metric.p95.toFixed(2)}ms min=${metric.min.toFixed(2)}ms max=${metric.max.toFixed(2)}ms n=${metric.samples.length}`;
}
function measure(name: string, rounds: number, fn: () => void): Metric {
  for (let i = 0; i < 3; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return summarize(name, samples);
}
async function measureAsync(name: string, rounds: number, fn: () => Promise<void>): Promise<Metric> {
  for (let i = 0; i < 2; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarize(name, samples);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-core-perf-"));
  const metrics: Metric[] = [];
  try {
    const memoryStart = process.memoryUsage();
    let observedMaxRss = memoryStart.rss;
    let observedMaxHeap = memoryStart.heapUsed;
    const observeMemory = (): void => {
      const current = process.memoryUsage();
      observedMaxRss = Math.max(observedMaxRss, current.rss);
      observedMaxHeap = Math.max(observedMaxHeap, current.heapUsed);
    };

    // 0a) Core startup storage: schema creation versus reopening an initialized DB.
    const coldDbSamples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const cold = new AppDatabase(join(root, `startup-cold-${i}.db`));
      cold.close();
      coldDbSamples.push(performance.now() - t0);
    }
    metrics.push(summarize("startup.db-schema/cold", coldDbSamples));
    const warmDbPath = join(root, "startup-warm.db");
    new AppDatabase(warmDbPath).close();
    metrics.push(measure("startup.db-open/warm", 30, () => {
      const warm = new AppDatabase(warmDbPath);
      warm.close();
    }));
    observeMemory();

    // 0b) Local prompt preflight subset before model I/O: canonical workspace resolution + workspace observation.
    const preflightDb = new AppDatabase(join(root, "preflight.db"));
    preflightDb.upsertTask({ id: "perf-preflight", title: "Perf preflight", updatedAt: Date.now() });
    const preflightWorkspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
    const preflightFailures = new ExecutionFailureRepository(preflightDb.connection);
    const preflightCwd = prepareTaskWorkspace(preflightDb, preflightWorkspace, preflightFailures, "perf-preflight", "assistant-perf");
    for (let i = 0; i < 100; i++) writeFileSync(join(preflightCwd, `local-${i}.txt`), `local ${i}`);
    metrics.push(await measureAsync("prompt.local-preflight/100-files", 20, async () => {
      const cwd = prepareTaskWorkspace(preflightDb, preflightWorkspace, preflightFailures, "perf-preflight", "assistant-perf");
      const snapshot = await snapshotWorkspace(cwd);
      if (snapshot.size !== 100) throw new Error(`preflight snapshot=${snapshot.size}`);
    }));
    preflightDb.close();
    observeMemory();

    // 0c) Python Runtime orchestration. Fake uv removes network/download/process cost and measures MyBuddy's cold/hot control path only.
    const pythonColdSamples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const runtimeRoot = join(root, `python-cold-${i}`);
      const runtime = new PythonRuntimeService(pythonRuntimeOptions(runtimeRoot));
      const t0 = performance.now();
      const resolution = await runtime.resolveForExecution({ dependencies: ["six"] }, { label: "perf" });
      pythonColdSamples.push(performance.now() - t0);
      if (!resolution.ok) throw new Error("python cold orchestration failed");
    }
    metrics.push(summarize("runtime.python-orchestration/cold", pythonColdSamples));
    const hotRuntime = new PythonRuntimeService(pythonRuntimeOptions(join(root, "python-hot")));
    const firstHot = await hotRuntime.resolveForExecution({ dependencies: ["six"] }, { label: "perf" });
    if (!firstHot.ok) throw new Error("python hot setup failed");
    metrics.push(await measureAsync("runtime.python-orchestration/hot", 30, async () => {
      const resolution = await hotRuntime.resolveForExecution({ dependencies: ["six"] }, { label: "perf" });
      if (!resolution.ok) throw new Error("python hot orchestration failed");
    }));
    observeMemory();

    // 1) Library search: 800 managed markdown docs. Specific FTS query should not need a full file scan.
    const db = new AppDatabase(join(root, "library.db"));
    const libRoot = join(root, "library");
    const lib = new LibraryService(db, { libraryRoot: libRoot });
    const personal = lib.ensureReady();
    const filler = "工业测量 仪表 数据 分析 可靠性 ".repeat(80);
    let targetId = "";
    for (let i = 0; i < 800; i++) {
      const item = (lib as any).createItem({ spaceId: personal.id, kind: "markdown", title: `性能文档-${String(i).padStart(4, "0")}` });
      const anchor = i === 420 ? "UNIQUE-PERF-NEEDLE-420" : `ordinary-${i}`;
      (lib as any).writeContent({ id: item.id, content: `# 文档 ${i}\n${filler}\n${anchor}\n` });
      if (i === 420) targetId = item.id;
    }
    await lib.flushPendingIndexes();
    const libraryMetric = measure("library.search specific/800", 25, () => {
      const rows = lib.search("UNIQUE-PERF-NEEDLE-420");
      if (!rows.some((row) => row.id === targetId)) throw new Error("library benchmark target missing");
    });
    metrics.push(libraryMetric);
    metrics.push(measure("library.search miss/800", 12, () => {
      const rows = lib.search("THIS-TERM-DOES-NOT-EXIST-998877");
      if (rows.length !== 0) throw new Error("library miss benchmark unexpectedly matched");
    }));
    metrics.push(measure("library.search short/800", 12, () => {
      const rows = lib.search("仪");
      if (rows.length === 0) throw new Error("library short benchmark should match filler text");
    }));

    // 2) Workspace snapshot: hard ceiling is 5000 files in production code.
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    for (let d = 0; d < 50; d++) {
      const dir = join(workspace, `dir-${String(d).padStart(2, "0")}`);
      mkdirSync(dir);
      for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f-${String(f).padStart(3, "0")}.txt`), `${d}:${f}\n`);
    }
    const snapshotMetric = await measureAsync("workspace.snapshot/5000", 20, async () => {
      const snapshot = await snapshotWorkspace(workspace);
      if (snapshot.size !== 5000) throw new Error(`workspace snapshot size=${snapshot.size}`);
    });
    metrics.push(snapshotMetric);

    // 2b) Large managed-file preview: current product path reads the whole text file.
    const largePath = join(workspace, "large-16mb.md");
    writeFileSync(largePath, "L".repeat(16 * 1024 * 1024), "utf8");
    metrics.push(await measureAsync("workspace.preview-text/16MB", 7, async () => {
      const preview = await previewWorkspaceFile(largePath);
      if (preview.content.length !== 16 * 1024 * 1024) throw new Error(`large preview chars=${preview.content.length}`);
    }));
    observeMemory();

    // 2c) Background terminal orchestration: real TerminalHost, fake PTY (no shell/process cost).
    const terminalRoot = join(root, "terminal");
    mkdirSync(terminalRoot);
    const makeTerminalHost = (): TerminalHost => new TerminalHost({
      resolveCwd: () => terminalRoot,
      resolveWorkspaceCwd: () => terminalRoot,
      ptyFactory: () => new PerfPty(),
      flushIntervalMs: 1,
      flushMaxBytes: 8 * 1024,
    });
    metrics.push(measure("terminal.background-open/100", 20, () => {
      const host = makeTerminalHost();
      for (let i = 0; i < 100; i++) host.open({ taskId: `background-${i}`, cols: 100, rows: 30 });
      if (host.sessionCount() !== 100) throw new Error(`terminal sessions=${host.sessionCount()}`);
      host.dispose();
    }));
    observeMemory();

    // 3) Session history: 1000 user/assistant turns, re-open + parse every sample.
    const sessionCwd = join(root, "session-work");
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionCwd);
    const sm = SessionManager.create(sessionCwd, sessionDir);
    for (let i = 0; i < 1000; i++) {
      sm.appendMessage({ role: "user", content: `用户问题 ${i} ` + "x".repeat(80) });
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `助手回答 ${i} ` + "y".repeat(160) }] });
    }
    const sessionFile = sm.getSessionFile();
    const historyMetric = measure("session.history/1000-turns", 12, () => {
      const history = loadTaskHistoryFromSession(sessionFile, sessionCwd);
      if (history.messages.length !== 2000) throw new Error(`history messages=${history.messages.length}`);
    });
    metrics.push(historyMetric);

    // 4) Renderer task switch synchronous path: 300 task rows, 120 messages each.
    prepareTestEnv();
    const api = (globalThis as any).window.api;
    api.agent = {
      ...(api.agent ?? {}),
      getContextUsage: async () => undefined,
      loadTaskHistory: async () => ({ messages: [] }),
    };
    api.conversationRuntime = { snapshot: async () => ({ todos: [], interactions: [], activeGoal: null }) };
    api.artifactDomain = { snapshot: async ({ taskId }: { taskId: string }) => ({ taskId, artifacts: [], revision: 1, state: "ready" }) };
    api.db = { ...(api.db ?? {}), getTaskBranchInfo: async () => null, listTaskBranches: async () => [] };
    const tasks = Array.from({ length: 300 }, (_, taskIndex) => ({
      ...minimalTask(`perf-task-${taskIndex}`, `Perf ${taskIndex}`),
      messages: Array.from({ length: 120 }, (_, messageIndex) => ({
        id: `m-${taskIndex}-${messageIndex}`,
        role: messageIndex % 2 === 0 ? "user" : "assistant",
        createdAt: messageIndex,
        blocks: [{ type: "text", text: `message ${messageIndex}` }],
        finalBlocks: messageIndex % 2 ? [{ type: "text", text: `answer ${messageIndex}` }] : undefined,
        streaming: false,
      })),
    }));
    useAppStore.setState({ tasks: tasks as any, activeTaskId: null, artifactProjection: { artifactsByTask: {}, artifactRevisions: {}, artifactLoadState: {} } });
    let switchIndex = 0;
    const taskSwitchMetric = measure("renderer.setActiveTask/300x120", 80, () => {
      switchIndex = (switchIndex + 1) % tasks.length;
      useAppStore.getState().setActiveTask(tasks[switchIndex]!.id);
    });
    metrics.push(taskSwitchMetric);

    // 5) Long-conversation virtualization prep: height estimate for 5000 mixed messages.
    const longMessages = Array.from({ length: 5000 }, (_, i) => ({
      id: `long-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      createdAt: i,
      blocks: [{ type: "text", text: "正文".repeat((i % 20) + 10) }],
      finalBlocks: i % 2 ? [{ type: "text", text: "长回复".repeat((i % 50) + 20) }] : undefined,
      artifactIds: i % 13 === 0 ? ["a1", "a2"] : undefined,
      streaming: false,
    }));
    const estimateMetric = measure("chat.height-estimate/5000", 30, () => {
      let total = 0;
      for (const message of longMessages) total += estimateMessageHeight(message as any);
      if (total <= 0) throw new Error("height estimate invalid");
    });
    metrics.push(estimateMetric);

    console.log("\n=== MyBuddy E performance baseline ===");
    console.log(`machine=${process.platform}/${process.arch} node=${process.version}`);
    for (const metric of metrics) console.log(fmt(metric));
    console.log(JSON.stringify(Object.fromEntries(metrics.map((m) => [m.name, { p50: +m.p50.toFixed(3), p95: +m.p95.toFixed(3), min: +m.min.toFixed(3), max: +m.max.toFixed(3), n: m.samples.length }])), null, 2));
    observeMemory();
    const memoryEnd = process.memoryUsage();
    console.log(`memory: startRss=${(memoryStart.rss / 1048576).toFixed(1)}MB endRss=${(memoryEnd.rss / 1048576).toFixed(1)}MB observedMaxRss=${(observedMaxRss / 1048576).toFixed(1)}MB startHeap=${(memoryStart.heapUsed / 1048576).toFixed(1)}MB observedMaxHeap=${(observedMaxHeap / 1048576).toFixed(1)}MB`);
    const budgetFailures = metrics.flatMap((metric) => {
      const budget = REFERENCE_P95_BUDGET_MS[metric.name];
      if (budget === undefined) return [];
      const ok = metric.p95 <= budget;
      console.log(`budget ${ok ? "PASS" : "FAIL"}: ${metric.name} p95=${metric.p95.toFixed(2)}ms <= ${budget}ms`);
      return ok ? [] : [`${metric.name} p95 ${metric.p95.toFixed(2)}ms > ${budget}ms`];
    });
    const maxRssMb = observedMaxRss / 1048576;
    const rssOk = maxRssMb <= REFERENCE_MAX_RSS_MB;
    console.log(`budget ${rssOk ? "PASS" : "FAIL"}: node synthetic max RSS ${maxRssMb.toFixed(1)}MB <= ${REFERENCE_MAX_RSS_MB}MB`);
    if (!rssOk) budgetFailures.push(`node synthetic max RSS ${maxRssMb.toFixed(1)}MB > ${REFERENCE_MAX_RSS_MB}MB`);
    if (process.env.MYBUDDY_PERF_GATE === "1" && budgetFailures.length) throw new Error(`Performance budget exceeded: ${budgetFailures.join("; ")}`);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});