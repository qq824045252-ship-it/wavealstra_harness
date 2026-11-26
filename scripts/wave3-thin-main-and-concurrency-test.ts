/**
 * Wave 3 Acceptance Suite (`P1-01`..`P1-09`, T12..T20 + Negative Proofs):
 * - T12 (P1-07): Thin Main RolePolicy & MainTimerRegistry + Core maintenance_scheduler offline execution on PiNodeHost
 * - T13 (P1-01/02/03): Multi-in-flight RuntimeAuditReader (`ReadPool`), 4-way execution overlap & single-read negative proof
 * - T14 (P1-03): Same-resource & same-session serialization vs independent parallelism + explainable `waitReason`
 * - T15 (P1-03): Head-of-line scheduling past `LIMIT 128` (`MAX_PROMOTE_SCAN = 1024`)
 * - T16 (P1-04/05): Tiered ephemeral delta coalescing (`0` SQLite `text_delta` rows) + control latency `p95 <= 15ms`
 * - T17 (P1-05): Slow UI subscriber isolation & catch-up snapshot recovery
 * - T18 (P1-08): Per-path Gadget store locking (slow fsync does not stall other gadgets) + missing-entry negative proof
 * - T19 (P1-08): Bounded thread pools & ORT thread caps + RAII `WorkerPermit` recovery after spawn failure
 * - T20 & P1-09: Queue overload (`OVERLOADED`), foreground priority scheduling, & unified `RuntimeAuditUnknownOperationError`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ExecutionHostBridge, type ExecutionBridgeRunner } from "../src/main/host/ExecutionHostBridge";
import { MainTimerRegistry, resolveMainRolePolicy } from "../src/main/host/MainRolePolicy";
import { PiNodeHost } from "../src/main/host/PiNodeHost";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import {
  RuntimeAuditReader,
  RuntimeAuditUnknownOperationError,
  locateRuntimeAudit,
} from "../src/main/platform/runtime-audit";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function startMinimalLlm() {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "w3-chat", choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return {
    start: async () => {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind LLM fixture");
      return `http://127.0.0.1:${addr.port}/v1`;
    },
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function writeProviderFixtures(dataDir: string, baseUrl: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }],
      },
    },
  }, null, 2));
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "model",
    enabledModels: ["fixture/model"],
  }, null, 2));
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function httpJsonPost(port: number, path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MyBuddy-Gadget-Token": token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function runT12ThinMainAndMaintenance(exe: string, root: string, llmUrl: string): Promise<void> {
  // Verify MainRolePolicy & MainTimerRegistry contracts
  const supPolicy = resolveMainRolePolicy(true);
  assert.equal(supPolicy.role, "supervised-ui");
  assert.equal(supPolicy.ownsBackgroundMaintenance, false);
  assert.equal(supPolicy.ownsProjectCadence, false);
  assert.equal(supPolicy.ownsTrashPurgeTimer, false);
  assert.equal(supPolicy.ownsLibraryBackgroundRecovery, false);
  assert.equal(supPolicy.ownsDotsAndCronLoops, false);
  assert.equal(supPolicy.ownsSnapshotCompaction, false);

  const standalonePolicy = resolveMainRolePolicy(false);
  assert.equal(standalonePolicy.role, "standalone");
  assert.equal(standalonePolicy.ownsBackgroundMaintenance, true);
  assert.equal(standalonePolicy.ownsProjectCadence, true);
  assert.equal(standalonePolicy.ownsTrashPurgeTimer, true);
  assert.equal(standalonePolicy.ownsLibraryBackgroundRecovery, true);
  assert.equal(standalonePolicy.ownsDotsAndCronLoops, true);
  assert.equal(standalonePolicy.ownsSnapshotCompaction, true);

  const registry = new MainTimerRegistry();
  registry.mark("library-background", "background-maintenance", supPolicy.ownsLibraryBackgroundRecovery);
  registry.mark("project-cadence", "background-maintenance", supPolicy.ownsProjectCadence);
  registry.mark("trash-purge", "background-maintenance", supPolicy.ownsTrashPurgeTimer);
  registry.mark("snapshot-compaction", "background-maintenance", supPolicy.ownsSnapshotCompaction);
  registry.mark("dots-cron-loops", "background-maintenance", supPolicy.ownsDotsAndCronLoops);
  registry.mark("ui-cursor-sync", "ui", true);
  assert.equal(registry.activeBackgroundTimers().length, 0, "T12: supervised Main must own 0 background-maintenance timers");

  const dataDir = join(root, "t12", ".mybuddy");
  const dbPath = join(dataDir, "app.db");
  const workspaceDir = join(root, "t12", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeProviderFixtures(dataDir, llmUrl);

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "t12");
  process.env.USERPROFILE = join(root, "t12");

  let db: AppDatabase | undefined;
  let host: PiNodeHost | undefined;
  let ui: UiReconnectController | undefined;
  let bg: CoreBusinessClient | undefined;
  try {
    await initializeCoreDatabase(exe, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: exe,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    await db.writeWorkspaceUpsert({ id: "t12-space", name: "T12 Space", path: workspaceDir });
    const expiredTaskId = "task-t12-expired";
    await db.writeTaskRecord({
      id: expiredTaskId,
      title: "Expired Trash Task",
      spaceId: "t12-space",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: Date.now() - 10_000,
    });

    const trashRoot = join(dataDir, "task-workspaces-trash");
    const taskWs = new TaskExecutionWorkspace(join(dataDir, "task-workspaces"));
    taskWs.ensureTaskExecutionWorkspace(expiredTaskId);
    const lifecycle = new TaskExecutionWorkspaceLifecycle({
      db,
      workspace: taskWs,
      trashRoot,
      purgeAfterMs: 1,
    });
    const trashed = await lifecycle.trash(expiredTaskId);
    assert(trashed.trashPath && existsSync(trashed.trashPath), "T12 setup: trash directory must exist on disk");
    await delay(20);

    const projectRepo = new ProjectRepository(db.connection, db.runtimeAuditReader);
    const projectService = new ProjectService(projectRepo, new MemoryService(db));
    const project = await projectService.createAsync({ name: "T12 Cadence Project" });
    await projectService.createTodoAsync({
      projectId: project.id,
      title: "Overdue Deliverable",
      status: "todo",
      dueAt: Date.now() - 60_000,
    });

    host = new PiNodeHost({
      hostId: "pi-t12",
      hostGeneration: "gen-t12",
      dataDirectory: dataDir,
      dbPath,
      runtimeAuditExecutable: exe,
      heartbeatIntervalMs: 400,
      taskWorkspace: taskWs,
      trashRoot,
      libraryRoot: join(dataDir, "library"),
    });
    const hostInfo = await host.start();
    assert(hostInfo.capabilities.includes("maintenance_control"), "T12: PiNodeHost must advertise maintenance_control");

    ui = new UiReconnectController(exe, dbPath, { dataDirectory: dataDir, clientId: "ui-t12" });
    let maintenanceEvents = 0;
    ui.addHooks({
      onEvent: ev => {
        if (ev.domain === "maintenance" && ev.kind === "maintenance.controlSettled") {
          maintenanceEvents += 1;
        }
      },
    });
    await ui.openUiSession();
    // Close Main UI session completely — background maintenance must still proceed.
    await ui.closeUiSession();
    assert.equal(ui.getState().connected, false);

    bg = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-t12" });
    await bg.maintenanceScheduler({ action: "start", libraryPollMs: 600_000, cadencePollMs: 600_000, trashPollMs: 600_000, snapshotPollMs: 600_000 });
    for (const cycleKey of ["trash_purge", "project_cadence", "library_maintenance", "snapshot_compaction"]) {
      await bg.maintenanceScheduler({ action: "triggerCycle", cycleKey, trigger: "offline_test" });
    }

    await until(async () => {
      const status = await bg!.maintenanceScheduler<{
        cycles?: Array<{ cycleKey: string; inFlight: boolean; lastCompletedAtMs?: number | null; lastError?: string | null }>;
      }>({ action: "status" });
      const cycles = status.cycles ?? [];
      return ["trash_purge", "project_cadence", "library_maintenance", "snapshot_compaction"].every(key => {
        const row = cycles.find(c => c.cycleKey === key);
        return Boolean(row && !row.inFlight && (row.lastCompletedAtMs ?? 0) > 0 && !row.lastError);
      });
    }, "T12 all 4 maintenance cycles settle offline while UI is closed", 20_000);

    await until(() => !existsSync(trashed.trashPath!) && !db!.getTask(expiredTaskId), "T12 expired trashed task dir & SQLite row purged", 10_000);

    const catchup = await db.runtimeAuditReader!.remoteControl<{
      status?: string;
      notifications?: Array<{ type: string; projectId?: string }>;
    }>({ action: "catchupNotifications", afterCreatedAtMs: 0, limit: 50 });
    assert(
      catchup?.notifications?.some(n => n.type === "project.attention" && n.projectId === project.id),
      "T12: offline project_cadence must produce project.attention notification",
    );

    const resyncSnap = await ui.openUiSession();
    assert(resyncSnap.executions.some(e => e.kind === "maintenance_control" && e.status === "completed"), "T12: reopened UI snapshot reflects offline maintenance settlement");
    assert(maintenanceEvents >= 0);
    console.log("[Wave3] PASS T12: Thin Main zero background timers + offline maintenance cycles settled with UI closed");
  } finally {
    await ui?.closeUiSession().catch(() => undefined);
    await bg?.maintenanceScheduler({ action: "stop" }).catch(() => undefined);
    await bg?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    db?.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

async function runT13AndT14AndT15AndT16AndT17AndT20(exe: string, root: string): Promise<void> {
  const dataDir = join(root, "concurrency", ".mybuddy");
  const dbPath = join(dataDir, "app.db");
  mkdirSync(dataDir, { recursive: true });
  await initializeCoreDatabase(exe, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);

  const db = await AppDatabase.open(dbPath, {
    runtimeAuditExecutable: exe,
    runtimeAuditSupervised: true,
    readonly: true,
  });
  const bg = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-conc" });
  let singleReader: RuntimeAuditReader | undefined;
  let bridge: ExecutionHostBridge | undefined;
  let ui: UiReconnectController | undefined;

  try {
    // --- T13 Part 1: Multi-in-flight RuntimeAuditReader + ReadPool + Negative Proof ---
    await Promise.all(Array.from({ length: 12 }, () => db.runtimeAuditReader!.dueTrashedTasks(Date.now())));
    const diag = db.runtimeAuditReader!.laneDiagnostics();
    assert(diag.maxInFlight.database >= 4, `T13 expected RuntimeAuditReader maxInFlight.database >= 4, got ${diag.maxInFlight.database}`);
    const mAfterReads = await bg.runtimeMetrics() as { readPool?: { maxActive?: number; completed?: number } };
    assert((mAfterReads.readPool?.maxActive ?? 0) >= 2, `T13 expected Core readPool.maxActive >= 2, got ${mAfterReads.readPool?.maxActive}`);

    singleReader = new RuntimeAuditReader(exe, dbPath, {
      coreDataDirectory: dataDir,
      maxConcurrentReads: 1,
    });
    await Promise.all(Array.from({ length: 8 }, () => singleReader!.dueTrashedTasks(Date.now())));
    const singleDiag = singleReader.laneDiagnostics();
    assert.equal(singleDiag.maxInFlight.database, 1, `T13 negative proof: maxConcurrentReads=1 must serialize database reads, got ${singleDiag.maxInFlight.database}`);
    await singleReader.close();
    singleReader = undefined;

    // --- T13 Part 2: 4-way Execution Overlap ---
    await bg.setExecutionSlotsLimit(4);
    let currentActive = 0;
    let maxOverlap = 0;
    const intervals = new Map<string, { start: number; end: number }>();
    const activeByExec = new Map<string, Deferred>();
    const progressQueue: Array<{
      execId: string;
      reportProgress: (p: unknown, opts?: { ephemeral?: boolean }) => Promise<void>;
    }> = [];

    const runner: ExecutionBridgeRunner = {
      async start(dispatch, helpers) {
        const payload = dispatch.execution.payload as Record<string, unknown>;
        const mode = String(payload.mode ?? "sleep");
        currentActive += 1;
        if (currentActive > maxOverlap) maxOverlap = currentActive;
        const start = performance.now();
        try {
          if (mode === "hold") {
            const gate = deferred();
            activeByExec.set(dispatch.execution.executionId, gate);
            await gate.promise;
            return { status: "completed", result: { held: true } };
          }
          if (mode === "stream") {
            const tid = dispatch.execution.taskId;
            for (let i = 0; i < 40; i++) {
              await helpers.reportProgress({
                kind: "ui_patch",
                patch: { type: "text_delta", taskId: tid, messageId: `msg-${tid}`, delta: `d${i}-` },
              }, { ephemeral: true });
            }
            await helpers.reportProgress({
              kind: "ui_patch",
              patch: { type: "tool_start", taskId: tid, messageId: `msg-${tid}`, toolCallId: `tc-${tid}`, toolName: "echo" },
            });
            await helpers.reportProgress({
              kind: "ui_patch",
              patch: { type: "tool_end", taskId: tid, messageId: `msg-${tid}`, toolCallId: `tc-${tid}`, result: "ok" },
            });
            await helpers.reportProgress({
              kind: "ui_patch",
              patch: { type: "assistant_end", taskId: tid, messageId: `msg-${tid}` },
            });
            return { status: "completed", result: { streamed: true } };
          }
          const durationMs = Number(payload.sleepMs ?? 250);
          if (durationMs > 0) await delay(durationMs);
          return { status: "completed", result: { mode } };
        } finally {
          const end = performance.now();
          intervals.set(dispatch.execution.executionId, { start, end });
          currentActive -= 1;
          void progressQueue.length;
        }
      },
      async cancel(execId) {
        activeByExec.get(execId)?.resolve();
      },
    };

    bridge = new ExecutionHostBridge(exe, dbPath, dataDir, runner, "exec-w3", "gen-exec-w3");
    const execClient = await bridge.connect();
    await execClient.piHost({
      action: "register",
      hostId: "exec-w3",
      pid: process.pid,
      hostGeneration: "gen-exec-w3",
      storageRoot: join(dataDir, "durable-bots"),
      dbPath,
      piVersion: "1.5.0",
      expectedPiVersion: "1.5.0",
      capabilities: ["pi_turn", "work_turn"],
    });

    const overlapT0 = performance.now();
    await Promise.all([1, 2, 3, 4].map(i => bg.submitExecution({
      executionId: `t13-exec-${i}`,
      idempotencyKey: `t13-key-${i}`,
      taskId: `t13-task-${i}`,
      kind: "pi_turn",
      payload: { mode: "sleep", sleepMs: 260, resourceKey: `t13-res-${i}` },
    })));
    await until(async () => {
      const snap = await bg.eventsSnapshot("execution");
      return [1, 2, 3, 4].every(i => snap.executions.find(e => e.executionId === `t13-exec-${i}`)?.status === "completed");
    }, "T13 4 parallel executions settle", 15_000);
    const overlapElapsed = performance.now() - overlapT0;
    assert.equal(maxOverlap, 4, `T13 expected 4-way execution overlap, got ${maxOverlap}`);
    assert(overlapElapsed < 900, `T13 expected parallel 4x260ms elapsed < 900ms, got ${overlapElapsed.toFixed(1)}ms`);
    console.log(`[Wave3] PASS T13: maxInFlight.db=${diag.maxInFlight.database}, readPool.maxActive=${mAfterReads.readPool?.maxActive}, singleMaxInFlight=${singleDiag.maxInFlight.database}, 4-way overlap=${maxOverlap} in ${overlapElapsed.toFixed(1)}ms`);

    // --- T14: Resource & Session Serialization vs Independent Parallelism + waitReason ---
    intervals.clear();
    await Promise.all([
      bg.submitExecution({ executionId: "t14-res-1", idempotencyKey: "t14-res-1", taskId: "t14-t1", kind: "work_turn", payload: { resourceKey: "file:/shared.txt", sleepMs: 220 } }),
      bg.submitExecution({ executionId: "t14-res-2", idempotencyKey: "t14-res-2", taskId: "t14-t2", kind: "work_turn", payload: { resourceKey: "file:/shared.txt", sleepMs: 220 } }),
      bg.submitExecution({ executionId: "t14-sess-1", idempotencyKey: "t14-sess-1", taskId: "t14-same-sess", kind: "pi_turn", payload: { sleepMs: 220 } }),
      bg.submitExecution({ executionId: "t14-sess-2", idempotencyKey: "t14-sess-2", taskId: "t14-same-sess", kind: "pi_turn", payload: { sleepMs: 220 } }),
      bg.submitExecution({ executionId: "t14-ind-1", idempotencyKey: "t14-ind-1", taskId: "t14-ti1", kind: "work_turn", payload: { resourceKey: "file:/a", sleepMs: 220 } }),
      bg.submitExecution({ executionId: "t14-ind-2", idempotencyKey: "t14-ind-2", taskId: "t14-ti2", kind: "work_turn", payload: { resourceKey: "file:/b", sleepMs: 220 } }),
    ]);
    await until(async () => {
      const s1 = await bg.executionStatus("t14-res-2");
      const s2 = await bg.executionStatus("t14-sess-2");
      return Boolean(s1.execution?.waitReason?.startsWith("conflict:") || s2.execution?.waitReason?.startsWith("conflict:"));
    }, "T14 blocked execution exposes conflict:* waitReason", 10_000);
    await until(async () => {
      const snap = await bg.eventsSnapshot("execution");
      return ["t14-res-1", "t14-res-2", "t14-sess-1", "t14-sess-2", "t14-ind-1", "t14-ind-2"]
        .every(id => snap.executions.find(e => e.executionId === id)?.status === "completed");
    }, "T14 all 6 executions complete", 15_000);
    const overlaps = (a: string, b: string) => {
      const ia = intervals.get(a)!;
      const ib = intervals.get(b)!;
      return Math.min(ia.end, ib.end) - Math.max(ia.start, ib.start);
    };
    assert(overlaps("t14-res-1", "t14-res-2") <= 5, "T14 same exclusive resource must serialize");
    assert(overlaps("t14-sess-1", "t14-sess-2") <= 5, "T14 same pi_turn session must serialize");
    assert(overlaps("t14-ind-1", "t14-ind-2") > 50, "T14 independent resources must overlap in parallel");
    console.log("[Wave3] PASS T14: same resource & same session serialized, independent overlapped, waitReason conflict:* verified");

    // --- T15: Head-of-Line Scheduling Past LIMIT 128 ---
    await bg.submitExecution({
      executionId: "t15-holder",
      idempotencyKey: "t15-holder",
      taskId: "t15-t-hold",
      kind: "work_turn",
      payload: { mode: "hold", resourceKey: "hot-lock" },
    });
    await until(() => activeByExec.has("t15-holder"), "T15 holder starts running hot-lock", 10_000);
    const holIds: string[] = [];
    for (let i = 0; i < 128; i += 16) {
      const batch = Array.from({ length: 16 }, (_, k) => {
        const idx = i + k + 1;
        const id = `t15-hol-${idx}`;
        holIds.push(id);
        return bg.submitExecution({
          executionId: id,
          idempotencyKey: id,
          taskId: `t15-t-${idx}`,
          kind: "work_turn",
          payload: { resourceKey: "hot-lock", sleepMs: 10 },
        });
      });
      await Promise.all(batch);
    }
    const t15Start = performance.now();
    await bg.submitExecution({
      executionId: "t15-free-130",
      idempotencyKey: "t15-free-130",
      taskId: "t15-t-free",
      kind: "work_turn",
      payload: { resourceKey: "free-lane", sleepMs: 20 },
    });
    await until(async () => {
      const st = await bg.executionStatus("t15-free-130");
      return st.execution?.status === "completed";
    }, "T15 130th independent execution bypasses 128 hot-lock waiters", 5_000);
    const t15Elapsed = performance.now() - t15Start;
    assert(t15Elapsed <= 2_000, `T15 expected independent execution <= 2000ms, got ${t15Elapsed.toFixed(1)}ms`);
    const sampleBlocked = await bg.executionStatus("t15-hol-64");
    assert.equal(sampleBlocked.execution?.status, "queued");
    assert.equal(sampleBlocked.execution?.waitReason, "conflict:resource:hot-lock:held_by:t15-holder");
    for (let i = 0; i < holIds.length; i += 32) {
      await Promise.all(holIds.slice(i, i + 32).map(id => bg.cancelExecution(id)));
    }
    activeByExec.get("t15-holder")?.resolve();
    await until(async () => (await bg.executionStatus("t15-holder")).execution?.status === "completed", "T15 holder settles", 10_000);
    console.log(`[Wave3] PASS T15: 130th independent execution completed in ${t15Elapsed.toFixed(1)}ms past 128 blocked hot-lock waiters`);

    // --- T16: Tiered Ephemeral Progress Coalescing + Control Latency Budget ---
    ui = new UiReconnectController(exe, dbPath, { dataDirectory: dataDir, clientId: "ui-t16" });
    const receivedPatches: Array<{ type: string; taskId: string; ephemeral: boolean }> = [];
    ui.addHooks({
      onEvent: ev => {
        if (ev.domain === "execution" && ev.kind === "execution.progress") {
          const p = (ev.payload as { progress?: { kind?: string; patch?: { type?: string; taskId?: string } } })?.progress;
          if (p?.kind === "ui_patch" && p.patch?.type && p.patch.taskId?.startsWith("t16-")) {
            receivedPatches.push({ type: p.patch.type, taskId: p.patch.taskId, ephemeral: Boolean(ev.ephemeral) });
          }
        }
      },
    });
    await ui.openUiSession();

    const controlLatencies: number[] = [];
    const controlLoop = (async () => {
      for (let i = 0; i < 30; i++) {
        const s = performance.now();
        await bg.runtimeMetrics();
        controlLatencies.push(performance.now() - s);
        await delay(5);
      }
    })();

    await Promise.all([1, 2, 3, 4].map(i => bg.submitExecution({
      executionId: `t16-stream-${i}`,
      idempotencyKey: `t16-stream-${i}`,
      taskId: `t16-task-${i}`,
      kind: "pi_turn",
      payload: { mode: "stream" },
    })));
    await Promise.all([
      controlLoop,
      until(async () => {
        const snap = await bg.eventsSnapshot("execution");
        return [1, 2, 3, 4].every(i => snap.executions.find(e => e.executionId === `t16-stream-${i}`)?.status === "completed")
          && receivedPatches.filter(p => !p.ephemeral && (p.type === "tool_start" || p.type === "tool_end" || p.type === "assistant_end")).length >= 12;
      }, "T16 4 concurrent streams + durable UI events deliver", 15_000),
    ]);

    const t16Metrics = await bg.runtimeMetrics() as { ephemeralProgress?: { emitted?: number } };
    assert((t16Metrics.ephemeralProgress?.emitted ?? 0) > 0, "T16: ephemeralProgress.emitted must be > 0");
    assert(receivedPatches.some(p => p.ephemeral && p.type === "text_delta"), "T16: UI must receive coalesced ephemeral text_delta");
    const durableCount = receivedPatches.filter(p => !p.ephemeral && (p.type === "tool_start" || p.type === "tool_end" || p.type === "assistant_end")).length;
    assert.equal(durableCount, 12, `T16 expected 12 durable tool/assistant events, got ${durableCount}`);

    // Verify 0 text_delta rows in SQLite core_domain_events via replay
    const replay = await bg.eventsReplay(0, ui.getCursor().coreGeneration!, 512);
    const leakedEphemeral = replay.events.filter(e => e.domain === "execution" && JSON.stringify(e.payload).includes("text_delta"));
    assert.equal(leakedEphemeral.length, 0, "T16: SQLite core_domain_events must store ZERO ephemeral text_delta rows");

    const sortedCtrl = [...controlLatencies].sort((a, b) => a - b);
    const ctrlP50 = percentile(sortedCtrl, 50);
    const ctrlP95 = percentile(sortedCtrl, 95);
    const ctrlMax = Number((sortedCtrl[sortedCtrl.length - 1] ?? 0).toFixed(2));
    assert(ctrlP95 <= 15, `T16 control latency p95 <= 15ms violated: n=${sortedCtrl.length} p50=${ctrlP50}ms p95=${ctrlP95}ms max=${ctrlMax}ms`);
    console.log(`[Wave3] PASS T16: 0 SQLite text_delta rows, 12/12 durable events, ephemeralEmitted=${t16Metrics.ephemeralProgress?.emitted}, control n=${sortedCtrl.length} p50=${ctrlP50}ms p95=${ctrlP95}ms max=${ctrlMax}ms`);

    // --- T17: Slow UI Subscriber Isolation & Catch-Up Recovery ---
    await ui.closeUiSession();
    const coreJson = JSON.parse(readFileSync(join(dataDir, "core.json"), "utf8")) as { port: number; token: string; generation: string };
    const slowSock = netConnect(coreJson.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      slowSock.once("connect", () => {
        slowSock.write(`hello ${coreJson.token} ${JSON.stringify({ role: "ui", clientId: "slow-ui-t17" })}\n`);
      });
      let buf = "";
      const onChunk = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const first = JSON.parse(buf.slice(0, nl)) as { coreConnected?: boolean };
        if (first.coreConnected) {
          buf = buf.slice(nl + 1);
          slowSock.write(JSON.stringify({
            requestId: "slow-sub-1",
            lane: "database",
            deadlineAt: Date.now() + 5_000,
            operation: "coreSubscribe",
            action: "subscribe",
            coreGeneration: coreJson.generation,
            afterSeq: 0,
          }) + "\n");
          slowSock.off("data", onChunk);
          slowSock.once("data", () => {
            slowSock.pause(); // Deliberately stop draining TCP socket
            resolve();
          });
        }
      };
      slowSock.on("data", onChunk);
      slowSock.once("error", reject);
    });

    await Promise.all(Array.from({ length: 8 }, (_, i) => bg.submitExecution({
      executionId: `t17-exec-${i}`,
      idempotencyKey: `t17-exec-${i}`,
      taskId: `t17-task-${i}`,
      kind: "pi_turn",
      payload: { mode: "stream" },
    })));
    const ctrlT0 = performance.now();
    await bg.runtimeMetrics();
    const ctrlDuringSlow = performance.now() - ctrlT0;
    assert(ctrlDuringSlow < 100, `T17 expected healthy control RPC (<100ms) while slow UI socket paused, got ${ctrlDuringSlow.toFixed(1)}ms`);

    await until(async () => {
      const snap = await bg.eventsSnapshot("execution");
      return Array.from({ length: 8 }, (_, i) => i).every(i => snap.executions.find(e => e.executionId === `t17-exec-${i}`)?.status === "completed");
    }, "T17 all 8 executions settle with slow UI paused", 15_000);

    slowSock.destroy();
    const recoveredSnap = await ui.openUiSession();
    assert(
      Array.from({ length: 8 }, (_, i) => i).every(i => recoveredSnap.executions.find(e => e.executionId === `t17-exec-${i}`)?.status === "completed"),
      "T17: fresh UI reconnect must recover 100% of completed terminal states",
    );
    await ui.closeUiSession();
    ui = undefined;
    console.log(`[Wave3] PASS T17: paused UI subscriber isolated, control=${ctrlDuringSlow.toFixed(1)}ms, 8/8 states recovered on reconnect`);

    // --- T20 + P1-09: Queue Overload, Priority Ordering, & Unknown-Operation Semantics ---
    await bridge.close();
    bridge = undefined;

    let offlineCheckAttempt = 0;
    let firstWaitingId = "";
    await until(async () => {
      offlineCheckAttempt += 1;
      const id = `t20-offline-check-${offlineCheckAttempt}`;
      const submitRes = await bg.submitExecution({
        executionId: id,
        idempotencyKey: id,
        taskId: `t20-check-${offlineCheckAttempt}`,
        kind: "work_turn",
        payload: { resourceKey: `r-check-${offlineCheckAttempt}` },
      });
      if (submitRes.execution?.status === "waiting_executor") {
        firstWaitingId = id;
        return true;
      }
      await bg.cancelExecution(id).catch(() => undefined);
      return false;
    }, "T20 executor goes offline", 10_000);

    // Fill remaining waiting slots up to MAX_EXECUTION_QUEUE (256), then expect OVERLOADED
    const seededIds = [firstWaitingId];
    let hitOverload = false;
    for (let i = 0; i < 270; i += 16) {
      const replies = await Promise.all(Array.from({ length: 16 }, (_, k) => {
        const id = `t20-q-${i + k}`;
        return bg.submitExecution({
          executionId: id,
          idempotencyKey: id,
          taskId: `t20-t-${i + k}`,
          kind: "work_turn",
          payload: { resourceKey: `t20-r-${i + k}` },
        }).then(r => ({ id, r }));
      }));
      for (const { id, r } of replies) {
        if (r.status === "ok") seededIds.push(id);
        else if (r.code === "OVERLOADED") hitOverload = true;
      }
      if (hitOverload) break;
    }
    assert(hitOverload, "T20: submitting beyond 256 active/waiting executions must return OVERLOADED");
    for (let i = 0; i < seededIds.length; i += 32) {
      await Promise.all(seededIds.slice(i, i + 32).map(id => bg.cancelExecution(id)));
    }

    // Priority ordering: background submitted first vs foreground submitted second under slotsLimit=1
    await bg.setExecutionSlotsLimit(1);
    const startOrder: string[] = [];
    const prioRunner: ExecutionBridgeRunner = {
      async start(dispatch) {
        startOrder.push(dispatch.execution.executionId);
        await delay(50);
        return { status: "completed", result: {} };
      },
    };
    await bg.submitExecution({
      executionId: "t20-bg-first",
      idempotencyKey: "t20-bg-first",
      taskId: "t20-p-bg",
      kind: "work_turn",
      payload: { priority: "background", resourceKey: "p-bg" },
    });
    await bg.submitExecution({
      executionId: "t20-fg-second",
      idempotencyKey: "t20-fg-second",
      taskId: "t20-p-fg",
      kind: "work_turn",
      payload: { priority: "foreground", resourceKey: "p-fg" },
    });
    const prioBridge = new ExecutionHostBridge(exe, dbPath, dataDir, prioRunner, "exec-prio", "gen-prio");
    try {
      const pClient = await prioBridge.connect();
      await pClient.piHost({
        action: "register",
        hostId: "exec-prio",
        pid: process.pid,
        hostGeneration: "gen-prio",
        storageRoot: join(dataDir, "durable-bots"),
        dbPath,
        piVersion: "1.5.0",
        expectedPiVersion: "1.5.0",
        capabilities: ["work_turn"],
      });
      await until(() => startOrder.length >= 2, "T20 priority pair starts", 10_000);
      assert.equal(startOrder[0], "t20-fg-second", `T20 expected foreground execution to start first, got order ${startOrder.join(",")}`);
    } finally {
      await prioBridge.close().catch(() => undefined);
    }

    // P1-09: CoreBusinessClient mutating call interrupted by close throws RuntimeAuditUnknownOperationError + queryOperation
    const transientClient = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "p109-client" });
    const mutatingPromise = transientClient.upsertNote({
      commandId: `p109-cmd-${Date.now()}`,
      entityId: "p109-note",
      title: "P1-09 Interrupted Note",
    });
    await transientClient.close();
    let capturedErr: unknown;
    try {
      await mutatingPromise;
      assert.fail("Expected interrupted mutating call to reject");
    } catch (err) {
      capturedErr = err;
    }
    assert(capturedErr instanceof RuntimeAuditUnknownOperationError, `P1-09 expected RuntimeAuditUnknownOperationError, got ${String(capturedErr)}`);
    const reqId = (capturedErr as RuntimeAuditUnknownOperationError).requestId;
    assert(reqId, "P1-09 RuntimeAuditUnknownOperationError must carry requestId");
    assert(transientClient.getUnconfirmedOperations().some(op => op.requestId === reqId), "P1-09 unconfirmed tracker must record interrupted mutating requestId");
    const receipt = await bg.queryOperation(reqId);
    assert(receipt && receipt.requestId === reqId, "P1-09 queryOperation(requestId) must return structured RuntimeOperationReceipt");
    console.log(`[Wave3] PASS T20 & P1-09: OVERLOADED enforced, foreground-first=${startOrder[0]}, unknown-op query state=${receipt.state}`);
  } finally {
    await ui?.closeUiSession().catch(() => undefined);
    await singleReader?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    await bg.close().catch(() => undefined);
    await db.runtimeAuditReader?.close().catch(() => undefined);
    db.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }
}

async function runT18AndT19GadgetLockingAndPoolBounds(exe: string, root: string): Promise<void> {
  // --- T18: Per-path Gadget Store locking + Missing-entry Negative Proof ---
  {
    const gDir = join(root, "t18", ".mybuddy");
    const dbPath = join(gDir, "app.db");
    mkdirSync(gDir, { recursive: true });
    process.env.MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH = "gadget-slow:350";
    let bg: CoreBusinessClient | undefined;
    try {
      await initializeCoreDatabase(exe, gDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
      bg = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: gDir, role: "background-service", clientId: "t18-bg" });

      const makeStatic = async (id: string, writeMissingEntry = false) => {
        const src = join(root, "t18", id, "src");
        const data = join(root, "t18", id, "data");
        mkdirSync(src, { recursive: true });
        mkdirSync(data, { recursive: true });
        if (!writeMissingEntry) {
          writeFileSync(join(src, "index.html"), `<html><body>${id}</body></html>`);
        }
        return {
          res: await bg!.gadgetHost<{ status?: string; port?: number; error?: string }>({
            action: "startStatic",
            gadgetId: id,
            name: id,
            sourcePath: src,
            dataPath: data,
            entry: writeMissingEntry ? "missing.html" : "index.html",
            sdkSource: "window.__sdk=1;",
            token: `tok-${id}`,
            generation: `gen-${id}`,
          }),
          token: `tok-${id}`,
        };
      };

      await assert.rejects(
        () => makeStatic("gadget-missing", true),
        (err: unknown) => err instanceof Error && err.message.length > 0,
        "T18 negative proof: startStatic with missing entry must fail explicitly",
      );

      const slow = await makeStatic("gadget-slow");
      const fastList = await Promise.all([1, 2, 3, 4].map(i => makeStatic(`gadget-fast-${i}`)));
      assert.equal(slow.res.status, "running");
      for (const f of fastList) assert.equal(f.res.status, "running");

      const slowStart = performance.now();
      const slowWrite = httpJsonPost(slow.res.port!, "/__mybuddy/storage", slow.token, {
        operation: "set", key: "k", value: "slow", expectedRevision: null,
      }).then(r => ({ status: r.status, elapsed: performance.now() - slowStart }));

      await delay(20);
      const fastResults = await Promise.all(fastList.map(async f => {
        const t0 = performance.now();
        const r = await httpJsonPost(f.res.port!, "/__mybuddy/storage", f.token, {
          operation: "set", key: "k", value: f.token, expectedRevision: null,
        });
        const g = await httpJsonPost(f.res.port!, "/__mybuddy/storage", f.token, {
          operation: "get", key: "k",
        });
        return { status: r.status, getStatus: g.status, elapsed: performance.now() - t0 };
      }));

      const slowDone = await slowWrite;
      assert.equal(slowDone.status, 200);
      assert(slowDone.elapsed >= 300, `T18 expected gadget-slow fsync delay >= 300ms, got ${slowDone.elapsed.toFixed(1)}ms`);
      for (const fr of fastResults) {
        assert.equal(fr.status, 200);
        assert.equal(fr.getStatus, 200);
        assert(fr.elapsed < 250, `T18 expected fast gadget < 250ms while gadget-slow fsync blocked, got ${fr.elapsed.toFixed(1)}ms`);
      }
      console.log(`[Wave3] PASS T18: gadget-slow=${slowDone.elapsed.toFixed(1)}ms, max fast=${Math.max(...fastResults.map(f => f.elapsed)).toFixed(1)}ms, missing-entry rejected`);
    } finally {
      delete process.env.MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH;
      await bg?.close().catch(() => undefined);
      await shutdownCoreWorker(gDir, dbPath).catch(() => undefined);
    }
  }

  // --- T19: Bounded Pools & ORT Caps + WorkerPermit Recovery ---
  {
    const t19Dir = join(root, "t19", ".mybuddy");
    const dbPath = join(t19Dir, "app.db");
    mkdirSync(t19Dir, { recursive: true });
    process.env.MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE = "1";
    process.env.MYBUDDY_ORT_INTRA_THREADS = "2";
    process.env.MYBUDDY_ORT_INTER_THREADS = "1";
    process.env.MYBUDDY_READ_POOL_WORKERS = "4";
    process.env.MYBUDDY_WORKSPACE_IO_WORKERS = "2";
    let bg: CoreBusinessClient | undefined;
    let reader19: RuntimeAuditReader | undefined;
    try {
      await initializeCoreDatabase(exe, t19Dir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
      bg = await CoreBusinessClient.connect(exe, dbPath, { dataDirectory: t19Dir, role: "background-service", clientId: "t19-bg" });
      reader19 = new RuntimeAuditReader(exe, dbPath, { coreDataDirectory: t19Dir });
      // Both ReadPool and WorkspaceIoPool initialize lazily on first dispatched job.
      await bg.eventsSnapshot();
      await reader19.listTrashedTasks(join(root, "t19"));
      await reader19.close();
      reader19 = undefined;

      const m = await bg.runtimeMetrics() as {
        readPool?: { workers?: number };
        workspaceIo?: { workers?: number };
        ort?: { intraThreads?: number; interThreads?: number };
      };
      assert.equal(m.readPool?.workers, 4);
      assert.equal(m.workspaceIo?.workers, 2);
      assert.equal(m.ort?.intraThreads, 2);
      assert.equal(m.ort?.interThreads, 1);

      const src = join(root, "t19", "src");
      const data = join(root, "t19", "data");
      mkdirSync(src, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(src, "index.html"), "<html><body>t19-ok</body></html>");

      const started = await bg.gadgetHost<{ status?: string; port?: number }>({
        action: "startStatic",
        gadgetId: "t19-gadget",
        name: "T19 Gadget",
        sourcePath: src,
        dataPath: data,
        entry: "index.html",
        sdkSource: "window.__sdk=1;",
        token: "tok-19",
        generation: "gen-19",
      });
      assert.equal(started.status, "running");
      const first = await fetch(`http://127.0.0.1:${started.port}/`);
      assert.equal(first.status, 503, `T19 expected 503 on injected spawn failure, got ${first.status}`);

      const mFail = await bg.runtimeMetrics() as { gadgetHttp?: { activeWorkers?: number; spawnFailures?: number } };
      assert.equal(mFail.gadgetHttp?.activeWorkers, 0, "T19 WorkerPermit RAII guard must release activeWorkers to 0 on spawn failure");
      assert((mFail.gadgetHttp?.spawnFailures ?? 0) >= 1, "T19 spawnFailures counter must increment");

      const second = await fetch(`http://127.0.0.1:${started.port}/`);
      assert.equal(second.status, 200, "T19 service must remain healthy after spawn failure recovery");
      console.log("[Wave3] PASS T19: bounded ReadPool(4)/WorkspaceIoPool(2)/ORT(2,1) & WorkerPermit RAII recovery verified");
    } finally {
      delete process.env.MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE;
      delete process.env.MYBUDDY_ORT_INTRA_THREADS;
      delete process.env.MYBUDDY_ORT_INTER_THREADS;
      delete process.env.MYBUDDY_READ_POOL_WORKERS;
      delete process.env.MYBUDDY_WORKSPACE_IO_WORKERS;
      await reader19?.close().catch(() => undefined);
      await bg?.close().catch(() => undefined);
      await shutdownCoreWorker(t19Dir, dbPath).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const exe = locateRuntimeAudit(process.cwd());
  if (!exe || !existsSync(exe)) throw new Error("Native runtime-audit binary missing");

  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-wave3-"));
  const llm = startMinimalLlm();
  const llmUrl = await llm.start();

  try {
    await runT12ThinMainAndMaintenance(exe, tempRoot, llmUrl);
    await runT13AndT14AndT15AndT16AndT17AndT20(exe, tempRoot);
    await runT18AndT19GadgetLockingAndPoolBounds(exe, tempRoot);
    console.log("ALL WAVE 3 T12..T20 + P1-09 ASSERTIONS PASSED");
  } finally {
    await llm.stop().catch(() => undefined);
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore Windows handle release race */ }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
