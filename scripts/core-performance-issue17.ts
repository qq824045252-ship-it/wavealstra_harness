/**
 * Issue #17 measurement entry (headless, synthetic).
 *
 * Scope: this script measures the renderer/store and admission code paths that Issue #17 A–C
 * change, with fixed fixtures. It deliberately does NOT measure Electron startup, renderer TTI,
 * React commits, IPC round trips or provider latency — those need the real app (GUI suite) and a
 * matching source SHA, and must not be inferred from these numbers.
 *
 * Output: artifacts/performance/issue-17/<sha>/<run-id>/raw.json (git-ignored) plus a summary.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";
import type { AppContext } from "../src/renderer/src/store/app/context";
import type { Task } from "../src/renderer/src/types";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import { prepareTestEnv } from "./test-store-harness";
import { ResumeAdmission } from "../src/main/agent/durable/ResumeAdmission";

prepareTestEnv();
// The renderer theme bootstrap reads matchMedia; node has no window media query implementation.
const testWindow = (globalThis as unknown as { window: Record<string, unknown> }).window;
testWindow.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
  return {
    n: values.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    totalMs: values.reduce((sum, value) => sum + value, 0),
  };
};

const sha = execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim();
// Measurements run against the working tree; record whether it differs from HEAD so the
// evidence cannot be mistaken for the clean commit's numbers.
const worktreeDirty = execSync("git status --porcelain", { cwd: process.cwd(), encoding: "utf8" }).trim().length > 0;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function store(api: object = {}) {
  return createAppStore({ getApi: () => api as ReturnType<AppContext["getApi"]> });
}

function sidebarTask(index: number): Task {
  return {
    id: `task-${index}`,
    title: `Task ${index}`,
    updatedAt: 1_700_000_000_000 + index * 60_000,
    status: "completed",
    messages: Array.from({ length: 20 }, (_, messageIndex) => ({
      id: `m-${index}-${messageIndex}`,
      role: (messageIndex % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      createdAt: messageIndex,
      blocks: [{ type: "text" as const, text: "content ".repeat(8) }],
    })),
  };
}

function measureSidebarSelector(taskCount: number, iterations: number) {
  const { useAppStore: api, appSelectors } = store({});
  const tasks = Array.from({ length: taskCount }, (_, index) => sidebarTask(index));
  api.setState({ tasks });
  appSelectors.selectSidebarTasks(api.getState()); // warm one cached pass

  const sameRef: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    appSelectors.selectSidebarTasks(api.getState());
    sameRef.push(performance.now() - started);
  }

  // A different object with identical summary fields is the pre-fast-path cost that still runs.
  const clone = (task: Task): Task => ({
    ...task,
    messages: task.messages.map((message) => ({ ...message })),
  });
  const distinct: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    api.setState({ tasks: tasks.map(clone) });
    const started = performance.now();
    appSelectors.selectSidebarTasks(api.getState());
    distinct.push(performance.now() - started);
  }
  return { taskCount, iterations, sameReference: quantiles(sameRef), distinctObjects: quantiles(distinct) };
}

function message(id: string, role: "user" | "assistant", artifactIds?: string[]) {
  return { id, role, createdAt: 1, blocks: [], ...(artifactIds ? { artifactIds } : {}) };
}

function measureArtifactReconcile(messageCount: number, iterations: number) {
  const descriptor: ArtifactDescriptor = {
    id: "artifact",
    taskId: "task",
    kind: "markdown",
    title: "note.md",
    version: 1,
    source: { type: "managed-content", rootDir: "/test", storagePath: "task/note.md" },
    capabilities: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const messages = Array.from({ length: messageCount }, (_, index) =>
    message(`m-${index}`, index % 2 === 0 ? "user" : "assistant", index === messageCount - 1 ? ["artifact"] : undefined),
  );
  const { useAppStore: api } = store({});
  api.setState({ tasks: [{ id: "task", title: "task", updatedAt: 1, status: "completed", messages }] });
  const projection = api.getState().artifactProjection;
  api.setState({ artifactProjection: { ...projection, artifactsByTask: { task: [descriptor] } } });

  let notifications = 0;
  const unsubscribe = api.subscribe(() => { notifications += 1; });
  const samples: number[] = [];
  let identityHolds = true;
  for (let index = 0; index < iterations; index += 1) {
    const before = api.getState().tasks;
    const started = performance.now();
    api.getState().reconcileTaskMessageArtifacts("task");
    samples.push(performance.now() - started);
    if (api.getState().tasks !== before) identityHolds = false;
  }
  unsubscribe();
  return { messageCount, iterations, sameArrayIdentity: identityHolds, noOpNotifications: notifications, timings: quantiles(samples) };
}

async function measureAdmission(taskCount: number, concurrency: number, openMs: number) {
  let active = 0;
  let peak = 0;
  const admission = new ResumeAdmission({
    concurrency,
    shouldSkip: () => undefined,
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(openMs);
      active -= 1;
    },
  });
  admission.enqueue(Array.from({ length: taskCount }, (_, index) => `task-${index}`));
  const started = performance.now();
  const report = await admission.drain();
  const wallMs = performance.now() - started;
  return {
    taskCount,
    concurrency,
    syntheticOpenMs: openMs,
    wallMs,
    theoreticalUnboundedMs: taskCount * openMs,
    maxConcurrent: report.maxConcurrent,
    delivered: report.delivered.length,
    failed: report.failed.length,
    skipped: report.skipped.length,
    observedPeak: peak,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sidebar = measureSidebarSelector(500, 200);
  const reconcile = measureArtifactReconcile(200, 500);
  const admission = await measureAdmission(200, 4, 2);

  const report = {
    issue: 17,
    scope: "headless synthetic: renderer store selector/reconcile + resume admission scheduling. Not Electron startup, TTI, React commits, IPC or provider latency.",
    source: { sha, worktreeDirty, recordedAt: startedAt, runId },
    environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, arch: process.arch },
    fixtures: {
      sidebar: { tasks: sidebar.taskCount, messagesPerTask: 20, iterations: sidebar.iterations },
      reconcile: { messages: reconcile.messageCount, iterations: reconcile.iterations, descriptors: 1 },
      admission: { tasks: admission.taskCount, concurrency: admission.concurrency, syntheticOpenMs: admission.syntheticOpenMs },
    },
    results: { sidebar, reconcile, admission },
    notes: [
      "sameReference measures the new fast path; distinctObjects measures the comparison path that still exists for changed objects.",
      "noOpNotifications is the store notification count for an already-correct artifact association; it must be 0.",
      "admission wall time is scheduling only; it says nothing about native work after resume().",
    ],
  };
  const directory = join(process.cwd(), "artifacts", "performance", "issue-17", sha, runId);
  mkdirSync(directory, { recursive: true });
  const output = join(directory, "raw.json");
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, sidebar: report.results.sidebar, reconcile: report.results.reconcile, admission: report.results.admission }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
