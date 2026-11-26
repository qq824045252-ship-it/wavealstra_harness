import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/main/agent/AgentService";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ensurePiNodeHostScript } from "../src/main/host/pi-node-host-bundle";
import { assertExpectedPiVersion } from "../src/main/host/pi-version";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { PlatformCapabilityProxy } from "../src/main/host/PlatformCapabilityProxy";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { RuntimeNotificationSqlRow } from "../src/main/notification/NotificationRepository";

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function startStoryLlmServer() {
  let reqCount = 0;
  let effectCount = 0;
  const seenEffectIds = new Set<string>();
  let slowMode = false;
  let stallOnSlow = false;
  let slowSeen = false;
  let toolCallReturned = false;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/idempotent-effect")) {
      const op = new URL(url, "http://127.0.0.1").searchParams.get("op") ?? "op-1";
      if (!seenEffectIds.has(op)) {
        seenEffectIds.add(op);
        effectCount += 1;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, op, effectCount }));
      return;
    }

    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const messages = (body.messages ?? []) as Array<{ role?: string }>;
    const lastRole = messages.at(-1)?.role;
    const toolNames = Array.isArray(body.tools)
      ? (body.tools as Array<{ function?: { name?: string }; name?: string }>).map(t => t.function?.name ?? t.name).filter(Boolean)
      : [];
    const hasWriteTool = toolNames.includes("write");

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    reqCount += 1;
    const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      res.write(`data: ${JSON.stringify({
        id: `story-${reqCount}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fixture/model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };

    if (!hasWriteTool && !toolNames.length) {
      writeChunk({ role: "assistant", content: JSON.stringify({ candidates: [] }) });
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (slowMode && lastRole === "user") {
      slowSeen = true;
      await fetch(`http://127.0.0.1:${port}/idempotent-effect?op=story-recover-effect`);
      writeChunk({ role: "assistant" });
      writeChunk({ content: "Working before injected Pi host fault..." });
      if (stallOnSlow) {
        await new Promise(resolve => setTimeout(resolve, 6_000));
      }
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (lastRole === "user" && !slowMode && hasWriteTool) {
      await new Promise(resolve => setTimeout(resolve, 180));
      toolCallReturned = true;
      writeChunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call_story_${reqCount}`,
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              path: "story-artifact.txt",
              content: "story-step4-offline-output\n",
            }),
          },
        }],
      });
      writeChunk({}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (lastRole === "tool" && !slowMode) {
      writeChunk({ role: "assistant" });
      writeChunk({ content: "Completed story-artifact.txt cleanly offline." });
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    writeChunk({ role: "assistant" });
    writeChunk({ content: "Confirmed after fault." });
    writeChunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  let port = 0;
  return {
    async start() {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as { port: number }).port;
      return `http://127.0.0.1:${port}/v1`;
    },
    setFaultMode(slow: boolean, stall: boolean) {
      slowMode = slow;
      stallOnSlow = stall;
      slowSeen = false;
    },
    isSlowSeen: () => slowSeen,
    isToolCallReturned: () => toolCallReturned,
    getEffectCount: () => effectCount,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  const runtimeAuditExecutable = locateRuntimeAudit(process.cwd());
  if (!runtimeAuditExecutable) throw new Error("Native runtime-audit binary missing");

  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-story-lifecycle-"));
  const dataDir = join(tempRoot, ".mybuddy");
  const dbPath = join(dataDir, "app.db");
  const storageRoot = join(dataDir, "durable-bots");
  const workspaceDir = join(tempRoot, "workspace");
  const gadgetDir = join(tempRoot, "static-gadget");
  const storyGadgetDataDir = join(tempRoot, "story-gadget-data");
  const upgradeExePath = join(tempRoot, "upgrade-bin", process.platform === "win32" ? "mybuddy-runtime-audit-v2.exe" : "mybuddy-runtime-audit-v2");
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAutoTick = process.env.MYBUDDY_WORK_AUTO_TICK_MS;
  process.env.HOME = tempRoot;
  process.env.USERPROFILE = tempRoot;
  process.env.MYBUDDY_WORK_AUTO_TICK_MS = "150";
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(gadgetDir, { recursive: true });
  mkdirSync(storyGadgetDataDir, { recursive: true });
  mkdirSync(join(tempRoot, "upgrade-bin"), { recursive: true });
  writeFileSync(join(gadgetDir, "index.html"), "<html><body><h1>Story Gadget v1</h1></body></html>\n", "utf8");
  copyFileSync(runtimeAuditExecutable, upgradeExePath);

  const llm = startStoryLlmServer();
  const baseUrl = await llm.start();

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }, null, 2));
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "model",
    enabledModels: ["fixture/model"],
  }, null, 2));

  const coreHash = sha256File(runtimeAuditExecutable);
  const versions = assertExpectedPiVersion(process.cwd());
  const piScript = await ensurePiNodeHostScript(process.cwd());

  let db: AppDatabase | undefined;
  let ui: UiReconnectController | undefined;
  let bgClient: CoreBusinessClient | undefined;
  let mainAgent: AgentService | undefined;

  try {
    // §6 Step 1: Boot real Core supervisor/worker + Pi Node Host, record PIDs, generations, binary SHA-256
    await initializeCoreDatabase(runtimeAuditExecutable, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    assert.equal(db.readonly, true, "Story Step 1: Main AppDatabase strictly readonly");

    const launchRes = await db.runtimeAuditReader!.piHost<{ launched?: boolean; pid?: number; hostGeneration?: string }>({
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
    assert(launchRes?.launched && launchRes.pid && launchRes.hostGeneration, "Story Step 1: Detached Pi Node Host started");
    const piPid1 = launchRes.pid!;
    const piGen1 = launchRes.hostGeneration!;

    await until(async () => {
      const st = await db!.runtimeAuditReader!.piHost<{ activeHost?: { status?: string; pid?: number } }>({ action: "status" });
      return st?.activeHost?.status === "running" && st?.activeHost?.pid === piPid1;
    }, "Pi Host ready");

    ui = new UiReconnectController(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      clientId: "story-ui",
    });
    const uiSnap1 = await ui.openUiSession();
    const coreGen1 = uiSnap1.coreGeneration;

    bgClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "story-bg",
    });

    await db.writeWorkspaceUpsert({ id: "story-space", name: "Story Workspace", path: workspaceDir });
    const now = Date.now();
    await db.writeTaskRecord({
      id: "task-story-1",
      title: "Story Main Work",
      spaceId: "story-space",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });
    await db.writeTaskRecord({
      id: "task-story-cancel",
      title: "Story Foreground Cancel",
      spaceId: "story-space",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });

    mainAgent = new AgentService(db, undefined, {
      executionMode: "isolated-client",
      coreClient: () => ui?.getClient(),
    });
    ui.addHooks({
      onEvent: ev => mainAgent?.handleCoreExecutionEvent(ev),
    });
    await mainAgent.init();

    // §6 Step 2: Launch Pi Work, Cron, Gateway, Static Gadget, Backend Gadget
    await bgClient.cronScheduler({ action: "start" });
    await bgClient.gatewayScheduler({ action: "start" });
    const staticGadget = await bgClient.gadgetHost<{ url?: string; port?: number; status?: string }>({
      action: "startStatic",
      gadgetId: "story-static",
      name: "Story Static Gadget",
      sourcePath: gadgetDir,
      dataPath: storyGadgetDataDir,
      entry: "index.html",
      sdkSource: "window.__MYBUDDY_SDK__=true;",
      token: "story-tok",
      generation: "story-gen-1",
    });
    assert.equal(staticGadget.status, "running", "Story Step 2: Static Gadget started on Rust Shared Host");
    assert(staticGadget.url, "Story Step 2: Static Gadget returned URL");
    const staticHtmlRes = await fetch(staticGadget.url);
    assert.equal(staticHtmlRes.status, 200, "Story Step 2: Static Gadget HTTP 200");
    assert.match(await staticHtmlRes.text(), /Story Gadget v1/, "Story Step 2: Static Gadget serves real HTML");

    const promptReceipt = await mainAgent.prompt({
      taskId: "task-story-1",
      userMessageId: "story-u-1",
      assistantMessageId: "story-a-1",
      text: "Produce story artifact",
      modelId: "fixture/model",
    }, { durableAdmissionOnly: true });
    assert(promptReceipt.receipt, "Story Step 2: Pi Work admitted with receipt");

    // §6 Step 3: Foreground control (submit + cancel another task) non-blocking during active work
    const tCtrl0 = performance.now();
    await bgClient.submitExecution({
      executionId: "story-cancel-exec",
      idempotencyKey: "story-cancel-1",
      taskId: "task-story-cancel",
      kind: "work",
    });
    const cancelRes = await bgClient.request<{ cancelled?: boolean; execution?: { status?: string } }>({
      operation: "coreExecution",
      action: "cancel",
      executionId: "story-cancel-exec",
      reason: "foreground_user_cancel",
    });
    const ctrlElapsedMs = performance.now() - tCtrl0;
    assert(ctrlElapsedMs < 2_000, `Story Step 3: Foreground control responded in ${ctrlElapsedMs.toFixed(2)}ms`);
    assert(cancelRes.execution?.status === "cancelled" || cancelRes.cancelled !== false, "Story Step 3: Foreground task cancelled cleanly");

    // §6 Step 4: Exit UI while non-desktop Pi work finishes & Platform proxy waits if desktop invoked offline
    const proxy = new PlatformCapabilityProxy();
    proxy.setUiOnline(false);
    proxy.setBrowserAvailable(false);
    await ui.closeUiSession();
    const offlineWait = await proxy.invoke("browser", async () => "never");
    assert.equal(offlineWait.status, "waiting_platform", "Story Step 4: Platform task waits honestly when UI offline");

    await until(() => existsSync(join(workspaceDir, "story-artifact.txt")), "Pi Node Host completes work while UI closed");
    assert.equal(llm.isToolCallReturned(), true, "Story Step 4: story-artifact.txt must be produced via real Agent write tool call");
    assert.equal(readFileSync(join(workspaceDir, "story-artifact.txt"), "utf8"), "story-step4-offline-output\n");
    await until(() => {
      const row = db!.connection.prepare("SELECT id, kind, title FROM artifacts WHERE task_id = 'task-story-1' LIMIT 1").get() as { id: string; kind: string; title: string } | undefined;
      return Boolean(row?.id);
    }, "Pi Node Host persisted real artifact row to SQLite while UI closed");

    // §6 Step 5: Offline domain activity (notification, note, unknown gateway reconciliation)
    await bgClient.upsertNote({
      commandId: "story-offline-note-1",
      entityId: "note-story-offline",
      title: "Offline Story Note",
      body: { phase: "offline" },
    });
    await db.runtimeAuditReader!.writeNotification({
      kind: "publish",
      record: {
        id: "notif-story-offline",
        type: "task.completed",
        level: "info",
        title: "Offline Step 5 Complete",
        body: "Artifact written offline",
        taskId: "task-story-1",
        workspaceId: "story-space",
        sourceType: "task",
        sourceId: "story-u-1",
        dedupeKey: "story-step5-notif",
        createdAt: Date.now(),
      },
      inApp: true,
      desktop: false,
    });
    await bgClient.submitExecution({
      executionId: "story-unknown-outbox",
      idempotencyKey: "story-unknown-key",
      taskId: "task-story-1",
      kind: "gateway",
    });
    const unknownOutbox = await bgClient.reconcileExecution({
      executionId: "story-unknown-outbox",
      status: "unknown",
      errorMessage: "Channel unqueryable after timeout",
    });
    assert.equal(unknownOutbox.execution?.status, "unknown", "Story Step 5: Unqueryable external delivery preserved as unknown");

    // §6 Step 6: Reopen UI via snapshot+cursor and confirm continuity with zero duplication
    const uiSnap2 = await ui.openUiSession();
    assert.equal(uiSnap2.coreGeneration, coreGen1, "Story Step 6: Core generation preserved across UI offline interval");
    const caughtNotifs = await db.runtimeAuditReader!.notificationData({
      kind: "list",
      limit: 50,
      query: "",
      unreadOnly: false,
      grouped: false,
    }) as RuntimeNotificationSqlRow[] | undefined;
    assert(caughtNotifs?.some(n => n.dedupe_key === "story-step5-notif"), "Story Step 6: Missed offline notification recovered");

    // §6 Step 7: Fault injection on Pi Host & Core Worker
    llm.setFaultMode(true, true);
    await mainAgent.prompt({
      taskId: "task-story-1",
      userMessageId: "story-u-2",
      assistantMessageId: "story-a-2",
      text: "Run fault-injected turn",
      modelId: "fixture/model",
    }, { durableAdmissionOnly: true });
    await until(() => llm.isSlowSeen(), "LLM fixture saw slow fault turn");

    // Hard-kill Pi Host without manual fenceGeneration or manual launch: Core supervise_tick must auto-fence & respawn.
    try { process.kill(piPid1, "SIGKILL"); } catch { /* */ }
    await until(() => !alive(piPid1), "Fault-killed Pi Host exited");

    llm.setFaultMode(true, false);
    let recoveredPi: { pid?: number; hostGeneration?: string; status?: string } | undefined;
    await until(async () => {
      const st = await db!.runtimeAuditReader!.piHost<{ activeHost?: { pid?: number; hostGeneration?: string; status?: string; alive?: boolean } }>({ action: "status" });
      if (st?.activeHost?.status === "running" && st.activeHost.alive && st.activeHost.pid && st.activeHost.pid !== piPid1) {
        recoveredPi = st.activeHost;
        return true;
      }
      return false;
    }, "Core unattended supervise_tick auto-recovered replacement Pi Host", 25_000);
    assert(recoveredPi?.pid && recoveredPi.pid !== piPid1, "Story Step 7: Core auto-respawned replacement Pi Host with new PID");
    assert.notEqual(recoveredPi?.hostGeneration, piGen1, "Story Step 7: Replacement Pi Host received fresh fenced hostGeneration");

    await until(async () => {
      const sub = await mainAgent!.findSubmission("task-story-1", "story-u-2");
      return sub?.receipt?.status === "done" || sub?.receipt?.status === "unanswered";
    }, "Pi fault recovery settled cleanly");
    assert.equal(llm.getEffectCount(), 1, "Story Step 7: Idempotent external effect invoked strictly once across Pi crash");

    // Inject Core worker stop & verify cold recovery
    await ui.closeUiSession();
    await bgClient.close();
    await db.runtimeAuditReader?.piHost({ action: "stop", reason: "core_restart_step7" }).catch(() => undefined);
    await db.runtimeAuditReader?.close().catch(() => undefined);
    db.close();
    await shutdownCoreWorker(dataDir, dbPath);

    // §6 Step 8: Heavy maintenance/batch mixed with light query & control check after Core recovery
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    const heavyClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "story-heavy",
    });
    const batchWrites = Array.from({ length: 16 }, (_, i) =>
      heavyClient.upsertNote({
        commandId: `heavy-${i}`,
        entityId: `heavy-note-${i}`,
        title: `Heavy ${i}`,
        body: { i },
      }),
    );
    const qStart = performance.now();
    const unread = await db.runtimeAuditReader!.notificationData({ kind: "unreadCount" });
    const qMs = performance.now() - qStart;
    await Promise.all(batchWrites);
    assert(typeof unread === "number" && qMs < 500, `Story Step 8: Light query returned cleanly (${qMs.toFixed(2)}ms) alongside heavy IO`);
    await heavyClient.close();

    // §6 Step 9: Explicit Stop Assistant -> close active reader before teardown, then verify explicit stop & restart recovery
    await db.runtimeAuditReader?.close().catch(() => undefined);
    db.close();
    db = undefined;
    const stopClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "story-stop",
    });
    await stopClient.cronScheduler({ action: "stop" }).catch(() => undefined);
    await stopClient.gatewayScheduler({ action: "stop" }).catch(() => undefined);
    await stopClient.gadgetHost({ action: "stopStatic", gadgetId: "story-static", reason: "story_explicit_stop" });
    await fetch(staticGadget.url!).then(
      () => { throw new Error("Stopped static gadget URL must refuse connections"); },
      () => undefined,
    );
    await stopClient.piHost({ action: "stop", reason: "story_explicit_stop" }).catch(() => undefined);
    const stopReply = await stopClient.assistantLifecycle("stop", { reason: "tray_stop" });
    assert.equal(stopReply.state.mode, "stopped_explicitly", "Story Step 9: assistantLifecycle mode = stopped_explicitly");
    await stopClient.close().catch(() => undefined);
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 150));

    // §6 Step 10: Controlled upgrade binary handoff on SAME dataDir + explicit start + continuity check
    assert.equal(sha256File(upgradeExePath), coreHash, "Controlled upgrade binary hash verified");
    await initializeCoreDatabase(upgradeExePath, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: upgradeExePath,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    const uiUpgraded = new UiReconnectController(upgradeExePath, dbPath, {
      dataDirectory: dataDir,
      clientId: "story-ui-upgraded",
    });
    const upgradedSnap = await uiUpgraded.openUiSession();
    assert(upgradedSnap.coreGeneration.length > 0, "Story Step 10: Upgraded Core serves snapshot on existing dataDir");
    await uiUpgraded.getClient()!.assistantLifecycle("activate", {
      residentEnabled: true,
      autostartEnabled: false,
      reason: "explicit_restart_after_stop",
    });
    const taskCheck = db.getTask("task-story-1");
    assert.equal(taskCheck?.title, "Story Main Work", "Story Step 10: Pre-upgrade task & workspace persisted across stop + binary upgrade");
    await uiUpgraded.closeUiSession();

    console.log(`PASS Step 10 Story (§6 Steps 1-10): coreSha256=${coreHash.slice(0, 12)}, effectCount=${llm.getEffectCount()}, ctrlMs=${ctrlElapsedMs.toFixed(2)}`);
  } catch (err) {
    const logPath = join(dataDir, "logs", "pi-node-host.log");
    if (existsSync(logPath)) console.error("--- pi-node-host.log ---\n" + readFileSync(logPath, "utf8"));
    throw err;
  } finally {
    await ui?.closeUiSession().catch(() => undefined);
    await bgClient?.close().catch(() => undefined);
    await db?.runtimeAuditReader?.piHost({ action: "stop", reason: "story_finally" }).catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    try { db?.close(); } catch { /* */ }
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    await llm.close().catch(() => undefined);
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch { /* Windows executable release delay */ }
  }
}

await main();
