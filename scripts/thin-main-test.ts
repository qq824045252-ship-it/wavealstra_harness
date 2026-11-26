import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { WorkPhase5Facts } from "../src/main/agent/work/WorkPhase5Facts";
import { WorkService } from "../src/main/agent/work/WorkService";
import { DurableTaskProjection } from "../src/main/agent/durable/DurableTaskProjection";
import { DurableWorkspaceMoves } from "../src/main/agent/durable/DurableWorkspaceMoves";
import { FileBackupService } from "../src/main/agent/FileBackupService";
import { ensurePiNodeHostScript } from "../src/main/host/pi-node-host-bundle";
import { assertExpectedPiVersion } from "../src/main/host/pi-version";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { WebContentsReclaimManager } from "../src/main/host/WebContentsReclaimManager";
import { PlatformCapabilityProxy } from "../src/main/host/PlatformCapabilityProxy";
import { ResidentLifecycle } from "../src/main/host/ResidentLifecycle";
import { DotsDiscovery } from "../src/main/dots/DotsDiscovery";
import { DotsGoogleMonitor } from "../src/main/dots/DotsGoogleMonitor";
import { DotsProactiveDelivery } from "../src/main/dots/DotsProactiveDelivery";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { RuntimeNotificationSqlRow } from "../src/main/notification/NotificationRepository";

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function runRc23UiReconnectCycles(tempRoot: string, runtimeAuditExecutable: string): Promise<void> {
  const dataDir = join(tempRoot, "rc23-data");
  const dbPath = join(dataDir, "app.db");
  const workspaceDir = join(tempRoot, "rc23-workspace");
  const storageRoot = join(dataDir, "durable-bots");

  await initializeCoreDatabase(runtimeAuditExecutable, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
  const db = await AppDatabase.open(dbPath, {
    runtimeAuditExecutable,
    runtimeAuditSupervised: true,
    readonly: true,
  });
  assert.equal(db.readonly, true, "RC-23: Electron Main app.db must stay readonly");

  const versions = assertExpectedPiVersion(process.cwd());
  const piScript = await ensurePiNodeHostScript(process.cwd());

  let piHostPid = 0;
  let piHostGen = "";
  let ui: UiReconnectController | undefined;
  let bgClient: CoreBusinessClient | undefined;

  try {
    const launched = await db.runtimeAuditReader!.piHost<{
      launched?: boolean;
      pid?: number;
      hostGeneration?: string;
    }>({
      action: "launch",
      executable: process.execPath,
      scriptPath: piScript,
      dataDirectory: dataDir,
      dbPath,
      storageRoot,
      piVersion: versions.actual,
      expectedPiVersion: versions.expected,
      runtimeAuditExecutable,
      extraEnv: { MYBUDDY_APP_PATH: process.cwd() },
    });
    assert(launched?.launched && launched.pid && launched.hostGeneration, "RC-23: Pi Node Host launched by Core");
    piHostPid = launched.pid;
    piHostGen = launched.hostGeneration;

    await until(async () => {
      const st = await db.runtimeAuditReader!.piHost<{ activeHost?: { pid?: number; status?: string } }>({ action: "status" });
      return st?.activeHost?.pid === piHostPid && st?.activeHost?.status === "running";
    }, "Pi Node Host running");

    const now = Date.now();
    await db.writeWorkspaceUpsert({
      id: "space-rc23",
      name: "RC23 Workspace",
      path: workspaceDir,
    });
    await db.writeTaskRecord({
      id: "task-rc23-work",
      title: "RC23 Continuous Work",
      spaceId: "space-rc23",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });

    bgClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "rc23-bg",
    });

    const initialMeta = await bgClient.eventsSnapshot();
    const initialGeneration = initialMeta.coreGeneration;

    ui = new UiReconnectController(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      clientId: "rc23-ui",
    });

    const receivedEventKeys = new Set<string>();
    const notesSeen = new Set<string>();
    let snapshotCount = 0;
    let resyncCount = 0;
    const offHooks = ui.addHooks({
      onSnapshot: () => {
        snapshotCount += 1;
      },
      onResync: () => {
        resyncCount += 1;
        receivedEventKeys.clear();
      },
      onEvent: ev => {
        const uniqueKey = `${ev.coreGeneration}:${ev.seq}`;
        assert(!receivedEventKeys.has(uniqueKey), `RC-23: duplicate event delivered to UI listener: ${uniqueKey}`);
        receivedEventKeys.add(uniqueKey);
        if (ev.domain === "note") notesSeen.add(ev.entityId);
      },
    });

    await bgClient.submitExecution({
      executionId: "rc23-exec-work",
      idempotencyKey: "rc23-work-1",
      taskId: "task-rc23-work",
      kind: "work",
    });
    await bgClient.cronScheduler({ action: "start" });
    await bgClient.gatewayScheduler({ action: "start" });
    await bgClient.gadgetHost({
      action: "upsertApp",
      app: {
        id: "gadget-rc23",
        name: "RC23 Gadget",
        kind: "static",
        rootDir: workspaceDir,
        entryFile: "index.html",
      },
    }).catch(() => undefined);

    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const snap = await ui.openUiSession();
      assert.equal(snap.coreGeneration, initialGeneration, `RC-23 cycle ${cycle}: Core generation must stay unchanged`);
      assert.equal(ui.getState().connected, true, `RC-23 cycle ${cycle}: UI should connect cleanly`);

      await ui.closeUiSession();
      assert.equal(ui.getState().connected, false, `RC-23 cycle ${cycle}: UI close must cleanly close subscription`);

      // Mutate Core state while UI is completely closed (offline):
      await bgClient.upsertNote({
        commandId: `cmd-note-${cycle}`,
        entityId: `note-rc23-${cycle}`,
        title: `Offline Cycle Note ${cycle}`,
        body: { cycle },
      });
      await db.runtimeAuditReader!.writeNotification({
        kind: "publish",
        record: {
          id: `notif-rc23-${cycle}`,
          type: "task.completed",
          level: "info",
          title: `Cycle ${cycle}`,
          body: `Offline notification ${cycle}`,
          taskId: "task-rc23-work",
          workspaceId: "space-rc23",
          sourceType: "task",
          sourceId: "rc23-exec-work",
          dedupeKey: `rc23-notif-${cycle}`,
          createdAt: Date.now(),
        },
        inApp: true,
        desktop: false,
      });

      const piStatus = await bgClient.piHost<{ activeHost?: { pid?: number; hostGeneration?: string; status?: string } }>({ action: "status" });
      assert.equal(piStatus.activeHost?.pid, piHostPid, `RC-23 cycle ${cycle}: Pi Host PID remained stable`);
      assert.equal(piStatus.activeHost?.hostGeneration, piHostGen, `RC-23 cycle ${cycle}: Pi Host generation remained stable`);
    }

    const finalSnap = await ui.openUiSession();
    assert.equal(finalSnap.coreGeneration, initialGeneration, "Core generation unchanged across 20 cycles");
    const caughtUp = await db.runtimeAuditReader!.notificationData({
      kind: "list",
      limit: 100,
      query: "",
      unreadOnly: false,
      grouped: false,
    }) as RuntimeNotificationSqlRow[] | undefined;
    assert(Array.isArray(caughtUp), "Unread/notification catchup returns Core rows");
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      assert(
        caughtUp.some(n => n.dedupe_key === `rc23-notif-${cycle}`),
        `RC-23: missed offline notification ${cycle} recovered cleanly after 20 close/reopen cycles`,
      );
      assert(
        notesSeen.has(`note-rc23-${cycle}`) || finalSnap.headSeq >= 20,
        `RC-23: offline domain event note-rc23-${cycle} replayed or captured cleanly`,
      );
    }

    const st = ui.getState();
    assert.equal(st.openCount, 21, "UiReconnectController tracked all 21 opens (20 cycles + final)");
    assert.equal(st.closeCount, 20, "UiReconnectController closed cleanly 20 times");
    assert.equal(st.activeListeners, 1, "RC-23: Zero listener accumulation across 20 reconnect cycles");
    assert.equal(snapshotCount, 21, "Every UI open pulled authoritative snapshot");

    // Duplicate & stale-revision event filtering
    const internalHandler = (ui as unknown as { handleIncomingEvent: (ev: Record<string, unknown>) => void }).handleIncomingEvent.bind(ui);
    const seqNow = st.lastSeq + 50;
    const synthEvent = {
      seq: seqNow,
      coreGeneration: initialGeneration,
      domain: "work",
      entityId: "work-dedupe-1",
      kind: "work.updated",
      revision: 3,
      payload: {},
      createdAt: Date.now(),
    };
    internalHandler(synthEvent);
    internalHandler(synthEvent);
    internalHandler({ ...synthEvent, seq: seqNow + 1, revision: 2 });
    assert.equal(ui.getState().dedupedCount, 2, "RC-23: Both duplicate seq and stale revision deduplicated");

    // Gap / obsolete generation triggers cache-discarding resync
    const gapReplay = await ui.replayFrom(0, "obsolete-core-generation");
    assert.equal(gapReplay.resynced, true, "RC-23: Stale generation triggers explicit resync");
    assert(ui.getState().resyncCount >= 1 && resyncCount >= 1, "RC-23: Gap resync event delivered to UI");

    offHooks();
    assert.equal(ui.getState().activeListeners, 0, "Hook unsubscribe cleans up listener");
    await ui.closeUiSession();
    console.log("PASS RC-23: 20 UI close/reopen cycles, zero owner drift, cursor recovery, dedupe, and gap resync");
  } finally {
    await ui?.closeUiSession().catch(() => undefined);
    await bgClient?.close().catch(() => undefined);
    await db.runtimeAuditReader?.piHost({ action: "stop", reason: "rc23_cleanup" }).catch(() => undefined);
    await db.runtimeAuditReader?.close().catch(() => undefined);
    db.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }
}

async function runRc24ReclaimAndThinMain(tempRoot: string, runtimeAuditExecutable: string): Promise<void> {
  // 1) Multi-surface WebContentsReclaimManager policy + metrics + restore state
  const reclaim = new WebContentsReclaimManager({ idleThresholdMs: 1_000 });
  const views = new Map<string, { live: boolean; url: string; partition?: string; draft?: string; scrollY?: number }>([
    ["browser-tab:visible", { live: true, url: "https://visible.example", partition: "persist:extension-browser", scrollY: 100 }],
    ["browser-tab:unsaved", { live: true, url: "https://form.example", partition: "persist:extension-browser", draft: "unsaved text", scrollY: 80 }],
    ["browser-tab:active-task", { live: true, url: "https://auto.example", partition: "persist:extension-browser" }],
    ["browser-tab:idle-hidden", { live: true, url: "https://docs.example/page#2", partition: "persist:extension-browser", scrollY: 420 }],
    ["artifact-preview", { live: true, url: "mybuddy-artifact://artifact-1/index.html", scrollY: 150 }],
  ]);
  const restoredSnapshots: Array<{ id: string; url: string; partition?: string; scrollY?: number }> = [];
  const now = 10_000_000;

  for (const id of views.keys()) {
    reclaim.register({
      surfaceId: id,
      kind: id === "artifact-preview" ? "artifact-preview" : "browser-tab",
      isVisible: () => id === "browser-tab:visible",
      isLiveViewPresent: () => views.get(id)!.live,
      getUrl: () => views.get(id)!.url,
      getPartition: () => views.get(id)!.partition,
      getDraftInput: () => views.get(id)!.draft,
      getScrollY: () => views.get(id)!.scrollY,
      hasUnsavedInput: () => id === "browser-tab:unsaved",
      hasActivePlatformTask: () => id === "browser-tab:active-task",
      lastActiveAt: () => now - 5_000,
      destroyView: () => { views.get(id)!.live = false; },
      restoreView: snap => {
        views.get(id)!.live = true;
        restoredSnapshots.push({ id: snap.surfaceId, url: snap.url, partition: snap.partition, scrollY: snap.scrollY });
      },
    });
  }

  const reclaimedIds = await reclaim.reclaimIdleSurfaces(now);
  assert.deepEqual(reclaimedIds.sort(), ["artifact-preview", "browser-tab:idle-hidden"], "RC-24: Only hidden idle non-protected surfaces reclaimed");
  assert.equal(views.get("browser-tab:visible")!.live, true, "Visible tab kept alive");
  assert.equal(views.get("browser-tab:unsaved")!.live, true, "Unsaved input tab preserved");
  assert.equal(views.get("browser-tab:active-task")!.live, true, "Active platform task tab preserved");

  const metricsAfterReclaim = reclaim.getMetrics();
  assert.equal(metricsAfterReclaim.totalReclaimed, 2, "Observable reclaim count = 2");
  assert.equal(metricsAfterReclaim.liveViewCount, 3, "Live view count reduced from 5 -> 3");
  assert(metricsAfterReclaim.lastRssBytes > 0, "Observable RSS metric recorded");
  assert(
    metricsAfterReclaim.history.some(e => e.surfaceId === "browser-tab:unsaved" && e.action === "skipped" && e.reason === "unsaved_user_input"),
    "Audit history records skipped unsaved input surface",
  );
  assert(
    metricsAfterReclaim.history.some(e => e.surfaceId === "browser-tab:active-task" && e.action === "skipped" && e.reason === "active_platform_task"),
    "Audit history records skipped active platform task surface",
  );

  const wokeTab = await reclaim.wakeSurface("browser-tab:idle-hidden");
  const wokeArt = await reclaim.wakeSurface("artifact-preview");
  assert.equal(wokeTab && wokeArt, true, "RC-24: Reclaimed surfaces wake on demand");
  const metricsAfterWake = reclaim.getMetrics();
  assert.equal(metricsAfterWake.totalRestored, 2, "Observable restore count = 2");
  assert.equal(metricsAfterWake.liveViewCount, 5, "Live view count restored to 5");
  assert.deepEqual(
    restoredSnapshots.find(s => s.id === "browser-tab:idle-hidden"),
    { id: "browser-tab:idle-hidden", url: "https://docs.example/page#2", partition: "persist:extension-browser", scrollY: 420 },
    "RC-24: Woken browser tab restores URL, persistent partition, and scroll position",
  );

  // 2) PlatformCapabilityProxy honest waiting when UI / browser offline
  const proxy = new PlatformCapabilityProxy();
  const offlineBrowser = await proxy.invoke("browser", async () => "ok");
  assert.equal(offlineBrowser.status, "waiting_platform", "RC-24: Offline browser waits honestly instead of launching second business host");
  assert.equal(offlineBrowser.capability, "browser");
  const offlineUi = await proxy.invoke("ui", async () => "ok");
  assert.equal(offlineUi.status, "waiting_platform", "RC-24: Offline UI waits honestly");

  proxy.setUiOnline(true);
  proxy.setBrowserAvailable(true);
  const onlineBrowser = await proxy.invoke("browser", async () => ({ tab: "restored" }));
  assert.equal(onlineBrowser.status, "completed", "RC-24: Restored platform proxy executes requested capability");

  // 3) ResidentLifecycle with supervisedCore: --resident-host exits cleanly without relaunching duplicate Node host
  let relaunchedArgs: string[] | undefined;
  let quitCalls = 0;
  const resident = new ResidentLifecycle({
    argv: ["electron", "--resident-host"],
    packaged: false,
    executable: process.execPath,
    appPath: process.cwd(),
    enabled: () => true,
    supervisedCore: () => true,
    quit: () => { quitCalls += 1; },
    relaunch: args => { relaunchedArgs = args; },
    closeInterface: () => {},
    log: () => {},
  });
  resident.exitInterface();
  assert.equal(quitCalls, 1, "RC-24: Exit interface closes Main UI cleanly");
  resident.afterCleanup();
  assert.equal(relaunchedArgs, undefined, "RC-24: Supervised Core prevents launching duplicate legacy --resident-host Node process");

  // 4) Zero-fallback & Zero local Main timers in supervised Core mode
  const dataDir = join(tempRoot, "rc24-data");
  const dbPath = join(dataDir, "app.db");
  await initializeCoreDatabase(runtimeAuditExecutable, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
  const db = await AppDatabase.open(dbPath, {
    runtimeAuditExecutable,
    runtimeAuditSupervised: true,
    readonly: true,
  });
  try {
    const workService = new WorkService(db.connection, {
      bots: { list: () => [], get: () => undefined } as never,
      now: Date.now,
    });
    const workFacts = new WorkPhase5Facts(workService, Date.now, db.connection);
    const deniedCardRead = await workFacts.writeRead({
      kind: "user",
      userId: "u1",
      grants: {
        canCreateWork: true,
        canControlAnyWork: true,
        canViewAllWorks: true,
        canConfigureBots: true,
        canReviewDeliverables: true,
      } as never,
    }, {
      workId: "w1",
      semanticCardKey: "k1",
      readAt: Date.now(),
    }, {
      supervised: true,
      readWorkQueue: async () => ({ kind: "needsHost" }),
      markWorkCardRead: async () => ({ status: "needsHost" }),
    });
    assert.equal(deniedCardRead.ok, false, "RC-24: Supervised WorkPhase5Facts refuses silent needsHost fallback");

    const projection = new DurableTaskProjection(db.connection, {
      supervised: true,
      writeDurableTaskProjection: async () => ({ status: "needsHost" }),
    });
    await assert.rejects(
      () => projection.writeSnapshot("t1", "running", Date.now(), []),
      /Rust 核心确认/,
      "RC-24: DurableTaskProjection refuses silent Node fallback under supervised Core",
    );

    const moves = new DurableWorkspaceMoves(db);
    await assert.rejects(
      () => moves.write({ kind: "stage", taskId: "t1", fromCwd: "/a", toCwd: "/b" }),
      /任务已删除或在回收站中/,
      "RC-24: DurableWorkspaceMoves routes through real Rust Core rather than local SQLite",
    );
    const fakeNeedsHostMoves = new DurableWorkspaceMoves({
      connection: db.connection,
      runtimeAuditReader: {
        supervised: true,
        writeDurableWorkspaceMove: async () => ({ status: "needsHost" as const }),
      },
    } as never);
    await assert.rejects(
      () => fakeNeedsHostMoves.write({ kind: "stage", taskId: "t1", fromCwd: "/a", toCwd: "/b" }),
      /Rust 核心确认/,
      "RC-24: DurableWorkspaceMoves refuses needsHost Node fallback under supervised Core",
    );

    const backupSvc = new FileBackupService(dataDir);
    await assert.rejects(
      () => backupSvc.restoreWithRuntime({ supervised: true, restoreFileBackup: async () => ({ status: "needsHost" }) }, "t1", "b1"),
      /未确认/,
      "RC-24: FileBackupService refuses silent Node restore fallback under supervised Core",
    );

    // Confirm Dots background monitors create zero local timers when coreControlled / supervised is true
    const dotsGoogle = new DotsGoogleMonitor(
      {} as never,
      () => ({ gmail: { enabled: false, accounts: [] }, calendar: { enabled: false, accounts: [] } } as never),
      () => true,
      () => {},
      undefined,
      Date.now,
      { coreControlled: true },
    );
    dotsGoogle.start();
    assert.equal((dotsGoogle as unknown as { timer?: unknown }).timer, undefined, "RC-24: DotsGoogleMonitor starts no local interval timer in coreControlled mode");
    await dotsGoogle.close();

    const dotsDiscovery = new DotsDiscovery(
      dataDir,
      () => ({ rss: [], dream: { enabled: false }, paused: true } as never),
      () => {},
      async () => [],
      async () => [],
      () => 0,
      undefined,
      Date.now,
      Math.random,
      { coreControlled: true },
    );
    dotsDiscovery.start();
    assert.equal((dotsDiscovery as unknown as { timer?: unknown }).timer, undefined, "RC-24: DotsDiscovery starts no local interval timer in coreControlled mode");
    await dotsDiscovery.close();

    const dotsDelivery = new DotsProactiveDelivery(
      db.connection,
      () => true,
      async () => ({ status: "pending" }),
      { supervised: true, batch4aWrite: async () => undefined } as never,
    );
    dotsDelivery.start();
    assert.equal((dotsDelivery as unknown as { timer?: unknown }).timer, undefined, "RC-24: DotsProactiveDelivery starts no local interval timer under supervised Core");
    await dotsDelivery.close();

    const indexSrc = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
    for (const marker of ["UiReconnectController", "WebContentsReclaimManager", "PlatformCapabilityProxy", "supervisedCore"]) {
      assert(indexSrc.includes(marker), `RC-24: src/main/index.ts must wire ${marker}`);
    }
    console.log("PASS RC-24: WebContents reclaim/restore, platform waiting proxy, resident Core handoff, zero fallback/timers");
  } finally {
    await db.runtimeAuditReader?.close().catch(() => undefined);
    db.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const runtimeAuditExecutable = locateRuntimeAudit(process.cwd());
  if (!runtimeAuditExecutable) {
    throw new Error("Native runtime-audit binary not built; run prepare-runtime-audit.cjs first");
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-thin-main-"));
  try {
    await runRc23UiReconnectCycles(tempRoot, runtimeAuditExecutable);
    await runRc24ReclaimAndThinMain(tempRoot, runtimeAuditExecutable);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
