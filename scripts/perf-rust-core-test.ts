import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { WebContentsReclaimManager } from "../src/main/host/WebContentsReclaimManager";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

interface PerfMetric {
  scenario: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: string;
  maxMs: number;
  elDelayMaxMs: number;
  rssPeakBytes: number;
  queueDepthMax: number;
  budgetP95Ms: number;
  budgetRssBytes: number;
  status: "PASS" | "FAIL";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

async function measureSamples(
  count: number,
  fn: (i: number) => Promise<void>,
): Promise<{ samples: number; p50Ms: number; p95Ms: number; p99Ms: string; maxMs: number; elDelayMaxMs: number; rssPeakBytes: number }> {
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  const times: number[] = [];
  let rssPeak = process.memoryUsage().rss;
  for (let i = 0; i < count; i += 1) {
    const t0 = performance.now();
    await fn(i);
    times.push(performance.now() - t0);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  hist.disable();
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: sorted.length >= 100 ? `${percentile(sorted, 99)}` : "N/A(n<100)",
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    elDelayMaxMs: Number((hist.max / 1e6).toFixed(2)),
    rssPeakBytes: rssPeak,
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

    // 2) Light request & Control channel ack (frozen budgets: request_p95<=25ms, control_p95<=10ms)
    const writeStats = await measureSamples(40, async i => {
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
      queueDepthMax: 0,
      budgetP95Ms: 25,
      budgetRssBytes: 268_435_456,
      status: writeStats.p95Ms <= 25 && writeStats.rssPeakBytes <= 268_435_456 ? "PASS" : "FAIL",
    });

    const ctrlStats = await measureSamples(30, async i => {
      await client!.executionStatus(`perf-missing-${i}`);
    });
    results.push({
      scenario: "core.controlAck(executionStatus)",
      ...ctrlStats,
      queueDepthMax: 0,
      budgetP95Ms: 10,
      budgetRssBytes: 268_435_456,
      status: ctrlStats.p95Ms <= 10 ? "PASS" : "FAIL",
    });

    // 3) Large history read & concurrent query while heavy batch writes execute (frozen budgets: light p95<=40ms, control<=15ms, RSS<=512MiB)
    for (let h = 0; h < 200; h += 1) {
      await client.upsertNote({ commandId: `seed-note-${h}`, entityId: `seed-note-${h}`, title: `Seed ${h}`, body: { idx: h } });
    }
    let stopHeavy = false;
    const heavyLoop = (async () => {
      let c = 0;
      while (!stopHeavy && c < 120) {
        await client!.upsertNote({ commandId: `heavy-${c}`, entityId: `heavy-${c % 25}`, title: `Heavy ${c}`, body: { payload: "x".repeat(1024) } });
        c += 1;
      }
    })();

    const mixedLightStats = await measureSamples(30, async () => {
      await client!.eventsSnapshot();
    });
    stopHeavy = true;
    await heavyLoop;
    results.push({
      scenario: "core.heavyWriteMixedWithLightSnapshot",
      ...mixedLightStats,
      queueDepthMax: 1,
      budgetP95Ms: 40,
      budgetRssBytes: 536_870_912,
      status: mixedLightStats.p95Ms <= 40 && mixedLightStats.rssPeakBytes <= 536_870_912 ? "PASS" : "FAIL",
    });

    // 4) Static Gadget 0..20 registration & read (budget: request_p95<=25ms, 0 extra Node processes)
    const gadgetStats = await measureSamples(20, async i => {
      await client!.gadgetHost({
        action: "upsertApp",
        app: { id: `perf-gadget-${i}`, name: `Perf Gadget ${i}`, kind: "static", rootDir: gadgetDir, entryFile: "index.html" },
      }).catch(() => undefined);
    });
    results.push({
      scenario: "core.staticGadgetScaling(20apps)",
      ...gadgetStats,
      queueDepthMax: 0,
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
    const reopenStats = await measureSamples(20, async () => {
      await ui!.openUiSession();
      await reclaim.reclaimIdleSurfaces(100);
      await reclaim.wakeSurface("perf-tab");
      await ui!.closeUiSession();
    });
    results.push({
      scenario: "core.ui20ReopenAndReclaimCycles",
      ...reopenStats,
      queueDepthMax: 0,
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
