import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { WebContentsReclaimManager } from "../src/main/host/WebContentsReclaimManager";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

interface ProcessMemoryBreakdown {
  driverRssBytes: number;
  coreSupervisorRssBytes: number;
  coreWorkerRssBytes: number;
  combinedRssBytes: number;
  note: string;
}

interface PerfMetric {
  scenario: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: string;
  maxMs: number;
  elDelayMaxMs: number;
  rssPeakBytes: number;
  processMemory: ProcessMemoryBreakdown;
  queueDepthMax: number;
  budgetP95Ms: number;
  budgetRssBytes: number;
  status: "PASS" | "FAIL";
}

function readProcessMemoryBytes(pids: number[]): Map<number, number> {
  const unique = Array.from(new Set(pids.filter(p => Number.isInteger(p) && p > 0)));
  const out = new Map<number, number>();
  if (unique.length === 0) return out;
  if (process.platform === "win32") {
    try {
      const cmd = `$ids=@(${unique.join(",")}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`;
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      }).trim();
      if (raw) {
        const parsed = JSON.parse(raw) as { Id?: number; WorkingSet64?: number } | Array<{ Id?: number; WorkingSet64?: number }>;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows) {
          if (typeof row.Id === "number" && typeof row.WorkingSet64 === "number") {
            out.set(row.Id, row.WorkingSet64);
          }
        }
      }
    } catch { /* fall back to process.memoryUsage for driver only */ }
  } else {
    for (const pid of unique) {
      try {
        const statm = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
        const residentPages = Number(statm[1] ?? 0);
        if (Number.isFinite(residentPages) && residentPages > 0) {
          out.set(pid, residentPages * 4096);
        }
      } catch { /* ignore */ }
    }
  }
  if (!out.has(process.pid)) {
    out.set(process.pid, process.memoryUsage().rss);
  }
  return out;
}

function readCoreEndpointPids(dataDir: string): { supervisorPid: number; workerPid: number } {
  try {
    const file = join(dataDir, "core.json");
    if (!existsSync(file)) return { supervisorPid: 0, workerPid: 0 };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; workerPid?: number };
    return {
      supervisorPid: typeof parsed.pid === "number" ? parsed.pid : 0,
      workerPid: typeof parsed.workerPid === "number" ? parsed.workerPid : 0,
    };
  } catch {
    return { supervisorPid: 0, workerPid: 0 };
  }
}

class InFlightDepthTracker {
  current = 0;
  max = 0;
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.current += 1;
    if (this.current > this.max) this.max = this.current;
    try {
      return await fn();
    } finally {
      this.current -= 1;
    }
  }
  reset(): void {
    this.current = 0;
    this.max = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

async function measureSamples(
  count: number,
  dataDir: string,
  tracker: InFlightDepthTracker,
  fn: (i: number) => Promise<void>,
): Promise<{
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: string;
  maxMs: number;
  elDelayMaxMs: number;
  rssPeakBytes: number;
  processMemory: ProcessMemoryBreakdown;
  queueDepthMax: number;
}> {
  tracker.max = tracker.current;
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  const times: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const t0 = performance.now();
    await tracker.track(() => fn(i));
    times.push(performance.now() - t0);
  }
  hist.disable();
  const { supervisorPid, workerPid } = readCoreEndpointPids(dataDir);
  const memMap = readProcessMemoryBytes([process.pid, supervisorPid, workerPid]);
  const driverRssBytes = memMap.get(process.pid) ?? process.memoryUsage().rss;
  const coreSupervisorRssBytes = supervisorPid > 0 ? (memMap.get(supervisorPid) ?? 0) : 0;
  const coreWorkerRssBytes = workerPid > 0 ? (memMap.get(workerPid) ?? 0) : 0;
  const combinedRssBytes = driverRssBytes + coreSupervisorRssBytes + coreWorkerRssBytes;
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: sorted.length >= 100 ? `${percentile(sorted, 99)}` : "N/A(n<100)",
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    elDelayMaxMs: Number((hist.max / 1e6).toFixed(2)),
    rssPeakBytes: combinedRssBytes,
    processMemory: {
      driverRssBytes,
      coreSupervisorRssBytes,
      coreWorkerRssBytes,
      combinedRssBytes,
      note: "Per-PID WorkingSet64/RSS sum (shared OS pages may be counted per process)",
    },
    queueDepthMax: tracker.max,
  };
}

async function main(): Promise<void> {
  const exe = locateRuntimeAudit(process.cwd());
  if (!exe) throw new Error("Native runtime-audit binary not found; run prepare-runtime-audit.cjs first");
  const exeSha256 = createHash("sha256").update(readFileSync(exe)).digest("hex");

  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-perf-rust-core-"));
  const dataDir = join(tempRoot, "data");
  const dbPath = join(dataDir, "app.db");
  const workspaceDir = join(tempRoot, "workspace");
  const gadgetDir = join(tempRoot, "gadgets");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(gadgetDir, { recursive: true });
  writeFileSync(join(gadgetDir, "index.html"), "<html><body>perf</body></html>\n", "utf8");

  const results: PerfMetric[] = [];
  let db: AppDatabase | undefined;
  let client: CoreBusinessClient | undefined;
  let ui: UiReconnectController | undefined;
  let gadgetRuntime: GadgetRuntime | undefined;
  const tracker = new InFlightDepthTracker();

  try {
    // 1) Cold DB init & connect
    const tCold0 = performance.now();
    await initializeCoreDatabase(exe, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: exe,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    const coldMs = Number((performance.now() - tCold0).toFixed(2));
    assert(coldMs <= 4_000, `Cold Core boot exceeded 4,000ms recovery budget: ${coldMs}ms`);

    client = await CoreBusinessClient.connect(exe, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "perf-driver",
    });

    await db.writeWorkspaceUpsert({ id: "perf-space", name: "Perf Space", path: workspaceDir });
    await db.writeTaskRecord({
      id: "perf-task",
      title: "Perf Task",
      spaceId: "perf-space",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: Date.now(),
    });

    // Warm up 5 calls
    for (let w = 0; w < 5; w += 1) {
      await client.upsertNote({ commandId: `warmup-${w}`, entityId: `warmup-note-${w}`, title: "W", body: { w } });
    }

    // 2) Light request & Control channel ack (frozen budgets: request_p95<=25ms, control_p95<=10ms, n=100)
    const writeStats = await measureSamples(100, dataDir, tracker, async i => {
      await db!.writeTaskRecord({
        id: "perf-task",
        title: `Perf Task ${i}`,
        spaceId: "perf-space",
        cwd: workspaceDir,
        modelId: "fixture/model",
        welcomeMode: "general",
        updatedAt: Date.now(),
      });
    });
    results.push({
      scenario: "core.writeTaskRecord(warm)",
      ...writeStats,
      budgetP95Ms: 25,
      budgetRssBytes: 268_435_456,
      status: writeStats.p95Ms <= 25 && writeStats.rssPeakBytes <= 268_435_456 ? "PASS" : "FAIL",
    });

    const ctrlStats = await measureSamples(100, dataDir, tracker, async i => {
      await client!.executionStatus(`perf-missing-${i}`);
    });
    results.push({
      scenario: "core.controlAck(executionStatus)",
      ...ctrlStats,
      budgetP95Ms: 10,
      budgetRssBytes: 268_435_456,
      status: ctrlStats.p95Ms <= 10 && ctrlStats.rssPeakBytes <= 268_435_456 ? "PASS" : "FAIL",
    });

    // 3) Large history read & concurrent query while heavy batch writes execute (frozen budgets: light p95<=40ms, RSS<=512MiB, n=100)
    for (let h = 0; h < 200; h += 1) {
      await client.upsertNote({ commandId: `seed-note-${h}`, entityId: `seed-note-${h}`, title: `Seed ${h}`, body: { idx: h } });
    }
    tracker.reset();
    let stopHeavy = false;
    const heavyLoop = (async () => {
      let c = 0;
      while (!stopHeavy && c < 250) {
        await tracker.track(() => client!.upsertNote({ commandId: `heavy-${c}`, entityId: `heavy-${c % 25}`, title: `Heavy ${c}`, body: { payload: "x".repeat(1024) } }));
        c += 1;
      }
    })();

    const mixedLightStats = await measureSamples(100, dataDir, tracker, async () => {
      await client!.eventsSnapshot();
    });
    stopHeavy = true;
    await heavyLoop;
    assert(mixedLightStats.queueDepthMax >= 2, `Expected concurrent mixed scenario queueDepthMax >= 2, got ${mixedLightStats.queueDepthMax}`);
    results.push({
      scenario: "core.heavyWriteMixedWithLightSnapshot",
      ...mixedLightStats,
      budgetP95Ms: 40,
      budgetRssBytes: 536_870_912,
      status: mixedLightStats.p95Ms <= 40 && mixedLightStats.rssPeakBytes <= 536_870_912 ? "PASS" : "FAIL",
    });

    // 4) Static Gadget 0..20 real start + HTTP check via Rust Shared Host (budget: request_p95<=25ms, RSS<=384MiB, 0 extra Node processes)
    const reader = db.runtimeAuditReader!;
    const gadgetRepository = new GadgetRepository(db.connection, reader);
    const gadgetStorage = new GadgetStorage(join(dataDir, "gadgets"), reader);
    const gadgetRegistry = new GadgetRegistry();
    gadgetRuntime = new GadgetRuntime(gadgetStorage, gadgetRegistry, undefined, reader, { idleTimeoutMs: 60_000 });
    const gadgetService = new GadgetService({
      repository: gadgetRepository,
      storage: gadgetStorage,
      registry: gadgetRegistry,
      runtime: gadgetRuntime,
      workspaceExists: () => false,
      workspaceEffectiveArchived: () => false,
      taskExists: () => false,
      taskWorkspaceId: () => null,
      workspaceAncestors: () => [],
    });
    const staticIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const desc = await gadgetService.createAsync({
        name: `Perf-Static-${i}`,
        scope: { type: "global" },
        defaultConfig: { idx: i },
        files: [{ path: "index.html", content: `<!doctype html><html><head></head><body><h1>Perf Gadget ${i}</h1></body></html>` }],
      });
      staticIds.push(desc.id);
    }

    const gadgetStats = await measureSamples(20, dataDir, tracker, async i => {
      const state = await gadgetService.start(staticIds[i]);
      assert.equal(state.status, "running");
      assert.equal(state.hostKind, "rust-shared");
      assert(state.url, "Static Gadget must return URL");
    });
    assert.equal(gadgetRuntime.activeProcessCount(), 0, "Expected 0 dedicated Node processes for 20 static gadgets");
    const hostList = await client.gadgetHost<{ staticHosts: Array<{ gadgetId: string; status: string }>; backends: unknown[] }>({
      action: "list",
    });
    assert.equal(hostList.staticHosts.filter(h => h.status === "running").length, 20);
    for (const id of staticIds) {
      const state = gadgetRegistry.runtime(id);
      const res = await fetch(state.url!);
      assert.equal(res.status, 200, `Static gadget ${id} HTTP read failed`);
      await gadgetService.stop(id);
    }
    const postStopList = await client.gadgetHost<{ staticHosts: Array<{ gadgetId: string; status: string }> }>({
      action: "list",
    });
    assert.equal(postStopList.staticHosts.filter(h => h.status === "running").length, 0);
    results.push({
      scenario: "core.staticGadgetScaling(20apps)",
      ...gadgetStats,
      budgetP95Ms: 25,
      budgetRssBytes: 402_653_184,
      status: gadgetStats.p95Ms <= 25 && gadgetStats.rssPeakBytes <= 402_653_184 ? "PASS" : "FAIL",
    });

    // 5) 20 UI close/reopen snapshot+delta + page reclaim cycles (frozen budget: request_p95<=150ms, rss<=998_244_352)
    ui = new UiReconnectController(exe, dbPath, { dataDirectory: dataDir, clientId: "perf-ui" });
    const reclaim = new WebContentsReclaimManager({ idleThresholdMs: 1 });
    let live = true;
    reclaim.register({
      surfaceId: "perf-tab",
      kind: "browser-tab",
      isVisible: () => false,
      isLiveViewPresent: () => live,
      getUrl: () => "https://perf.example",
      getPartition: () => "persist:extension-browser",
      lastActiveAt: () => 0,
      destroyView: () => { live = false; },
      restoreView: () => { live = true; },
    });
    const reopenStats = await measureSamples(20, dataDir, tracker, async () => {
      await ui!.openUiSession();
      await reclaim.reclaimIdleSurfaces(100);
      await reclaim.wakeSurface("perf-tab");
      await ui!.closeUiSession();
    });
    results.push({
      scenario: "core.ui20ReopenAndReclaimCycles",
      ...reopenStats,
      budgetP95Ms: 150,
      budgetRssBytes: 998_244_352,
      status: reopenStats.p95Ms <= 150 && reopenStats.rssPeakBytes <= 998_244_352 ? "PASS" : "FAIL",
    });

    // 6) Warm Core recovery benchmark (budget <= 4,000ms)
    await db.runtimeAuditReader?.close();
    db.close();
    await client.close();
    client = undefined;
    await shutdownCoreWorker(dataDir, dbPath);

    const tRecover0 = performance.now();
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: exe,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    const recoveryMs = Number((performance.now() - tRecover0).toFixed(2));
    assert(recoveryMs <= 4_000, `Core restart recovery exceeded 4,000ms budget: ${recoveryMs}ms`);

    console.log(JSON.stringify({
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      coreSha256: exeSha256,
      coldBootMs: coldMs,
      recoveryMs,
      results,
    }, null, 2));

    const failed = results.filter(r => r.status !== "PASS");
    assert.equal(failed.length, 0, `Performance regression against frozen budgets: ${failed.map(f => f.scenario).join(", ")}`);
    console.log("PASS perf:rust-core — all frozen Step 1 budgets satisfied");
  } finally {
    await gadgetRuntime?.disposeAll().catch(() => undefined);
    await ui?.closeUiSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    try { db?.close(); } catch { /* */ }
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
    } catch { /* ignore cleanup delay */ }
  }
}

await main();
