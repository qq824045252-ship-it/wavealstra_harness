/**
 * Wave 2 Acceptance Suite (T01..T06, T10, T11 + Negative Proofs):
 * - T01 (P0-01): PiNodeHost wires Artifact/Gadget/Cron/Dots domains & full ModelRuntime isolated-client control proxy.
 * - T02 (P0-02): ExecutorTracker capability filtering + honest CAPABILITY_UNAVAILABLE failure + dots_scheduler failed non-completion.
 * - T03 (P0-03): PiNodeHost <-> Core <-> Main PlatformCapabilityProxy RPC, AbortSignal cancellation, offline wait & disconnect handling.
 * - T04/T05 (P0-05): Unattended Core SIGKILL watchdog recovery + automatic PiNodeHost & UiReconnectController reconnect.
 * - T06/T10/T11 (P1-06): Offline cursor replay in order with zero loss/duplication + gap resync & hydration hook.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { AgentService } from "../src/main/agent/AgentService";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { createDurableBotExecutionRunner } from "../src/main/host/ExecutionHostBridge";
import { PiNodeHost } from "../src/main/host/PiNodeHost";
import { PlatformCapabilityProxy } from "../src/main/host/PlatformCapabilityProxy";
import { UiReconnectController } from "../src/main/host/UiReconnectController";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
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

function startMinimalLlm() {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "w2-chat", choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`);
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

async function runNegativeRunnerAndDotsSchedulerProofs(dataDir: string, dbPath: string, exe: string): Promise<void> {
  // Negative proof 1: Missing runDotsControlCycle / runGatewayControlCycle must fail honestly, never fake completed.
  const bareRunner = createDurableBotExecutionRunner({
    submit: async () => ({ queued: false }),
    abort: async () => undefined,
    findSubmission: async () => undefined,
  });
  const missingDots = await bareRunner.start({
    execution: {
      executionId: "dots-ctrl-neg-1",
      idempotencyKey: "dots-neg-1",
      ownerGeneration: "g1",
      sourceRole: "service",
      sourceClientId: "core-dots",
      sourceEpoch: 0,
      taskId: DOTS_TASK_ID,
      kind: "dots_control",
      payload: { dotsControlCycle: "google" },
      status: "dispatching",
      revision: 1,
      attempt: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  } as never, { reportProgress: async () => undefined });
  assert.equal(missingDots.status, "failed", "Negative proof: missing runDotsControlCycle must fail honestly");
  assert.match(missingDots.errorMessage ?? "", /CAPABILITY_UNAVAILABLE/);

  const missingGw = await bareRunner.start({
    execution: {
      executionId: "gw-ctrl-neg-1",
      idempotencyKey: "gw-neg-1",
      ownerGeneration: "g1",
      sourceRole: "service",
      sourceClientId: "core-gw",
      sourceEpoch: 0,
      taskId: "gateway:c1",
      kind: "gateway_control",
      payload: { gatewayControlCycle: "reconnect", channelId: "c1" },
      status: "dispatching",
      revision: 1,
      attempt: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  } as never, { reportProgress: async () => undefined });
  assert.equal(missingGw.status, "failed", "Negative proof: missing runGatewayControlCycle must fail honestly");
  assert.match(missingGw.errorMessage ?? "", /CAPABILITY_UNAVAILABLE/);

  // Negative proof 2: dots_scheduler settled as failed does NOT advance lastCompletedAtMs.
  const bg = await CoreBusinessClient.connect(exe, dbPath, {
    dataDirectory: dataDir,
    role: "background-service",
    clientId: "w2-dots-neg",
  });
  try {
    await bg.dotsScheduler({ action: "start", paused: false });
    await bg.dotsScheduler({ action: "triggerCycle", cycleKey: "google" });
    const execId = await (async () => {
      const snap = await bg.eventsSnapshot("execution");
      assert(snap.headSeq >= 0);
      const list = await bg.dotsScheduler<{ cycles?: Array<{ cycleKey: string; inFlight: boolean; lastCompletedAtMs?: number | null }> }>({ action: "status" });
      assert(list.cycles?.some(c => c.cycleKey === "google"));
      return `dots-ctrl-fail-proof-${Date.now()}`;
    })();
    await bg.submitExecution({
      executionId: execId,
      idempotencyKey: execId,
      taskId: DOTS_TASK_ID,
      kind: "dots_control",
      payload: { dotsControlCycle: "google" },
    });
    await bg.reconcileExecution({
      executionId: execId,
      status: "failed",
      errorMessage: "synthetic failure",
    });
    const st = await bg.dotsScheduler<{ cycles?: Array<{ cycleKey: string; lastCompletedAtMs?: number | null }> }>({ action: "status" });
    const googleCycle = st.cycles?.find(c => c.cycleKey === "google");
    assert.equal(googleCycle?.lastCompletedAtMs ?? null, null, "Failed dots_control settlement must NOT advance lastCompletedAtMs");
    await bg.dotsScheduler({ action: "stop" });
  } finally {
    await bg.close();
  }
}

async function main(): Promise<void> {
  const exe = locateRuntimeAudit(process.cwd());
  if (!exe) throw new Error("Native runtime-audit binary missing");

  const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-wave2-"));
  const dataDir = join(tempRoot, ".mybuddy");
  const dbPath = join(dataDir, "app.db");
  const workspaceDir = join(tempRoot, "workspace");
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAutoTick = process.env.MYBUDDY_WORK_AUTO_TICK_MS;
  process.env.HOME = tempRoot;
  process.env.USERPROFILE = tempRoot;
  process.env.MYBUDDY_WORK_AUTO_TICK_MS = "150";
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const llm = startMinimalLlm();
  const baseUrl = await llm.start();
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

  let db: AppDatabase | undefined;
  let partialHost: PiNodeHost | undefined;
  let fullHost: PiNodeHost | undefined;
  let ui: UiReconnectController | undefined;
  let bg: CoreBusinessClient | undefined;
  let mainAgent: AgentService | undefined;

  try {
    await initializeCoreDatabase(exe, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    await runNegativeRunnerAndDotsSchedulerProofs(dataDir, dbPath, exe);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: exe,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    await db.writeWorkspaceUpsert({ id: "w2-space", name: "Wave2 Space", path: workspaceDir });
    await db.writeTaskRecord({
      id: "task-w2-1",
      title: "Wave2 Task",
      spaceId: "w2-space",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: Date.now(),
    });

    // T02 Part 1 (Negative proof): Capability-restricted PiNodeHost leaves unsupported dots_control waiting_executor.
    partialHost = new PiNodeHost({
      hostId: "pi-partial",
      hostGeneration: "gen-partial",
      dataDirectory: dataDir,
      dbPath,
      runtimeAuditExecutable: exe,
      heartbeatIntervalMs: 500,
      capabilities: { piCore: true, cron: false, dotsControl: false, gatewayControl: false },
    });
    const partialInfo = await partialHost.start();
    assert(!partialInfo.capabilities.includes("dots_control"), "Partial host does not advertise dots_control");

    bg = await CoreBusinessClient.connect(exe, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "w2-bg",
    });
    const heldSubmit = await bg.submitExecution({
      executionId: "w2-dots-held-1",
      idempotencyKey: "w2-dots-held-1",
      taskId: DOTS_TASK_ID,
      kind: "dots_control",
      payload: { dotsControlCycle: "discovery" },
    });
    assert.equal(heldSubmit.execution?.status, "waiting_executor", "T02 Negative Proof: unsupported dots_control stays waiting_executor cleanly");
    await partialHost.close();
    partialHost = undefined;

    // T01 & T02 Part 2: Full PiNodeHost drains waiting dots_control, wires Artifact/Gadget domains & ModelRuntime control proxy.
    fullHost = new PiNodeHost({
      hostId: "pi-full",
      hostGeneration: "gen-full",
      dataDirectory: dataDir,
      dbPath,
      runtimeAuditExecutable: exe,
      heartbeatIntervalMs: 500,
    });
    const fullInfo = await fullHost.start();
    assert(fullInfo.capabilities.includes("dots_control"), "Full host advertises dots_control");
    await until(async () => {
      const st = await bg!.executionStatus("w2-dots-held-1");
      return st.execution?.status === "completed";
    }, "T02: Full PiNodeHost drained previously held dots_control execution");

    // Verify ArtifactDomain inside PiNodeHost persists to SQLite artifacts table cleanly.
    const artFile = join(workspaceDir, "w2-report.md");
    writeFileSync(artFile, "# Wave 2\nArtifact content\n", "utf8");
    const artifact = await fullHost.getArtifactDomain()!.service.registerWorkspaceOutput({
      taskId: "task-w2-1",
      kind: "markdown",
      title: "w2-report.md",
      workspaceFile: { entryFile: artFile, rootDir: workspaceDir },
    });
    assert(artifact.id, "T01: PiNodeHost ArtifactDomain registered artifact");
    const artRow = db.connection.prepare("SELECT id, title, kind FROM artifacts WHERE id = ?").get(artifact.id) as { id: string; title: string; kind: string } | undefined;
    assert.equal(artRow?.id, artifact.id, "T01: Artifact persisted into readonly AppDatabase SQLite");

    // Verify GadgetService inside PiNodeHost.
    const createdGadget = await fullHost.getGadgetService()!.createAsync({
      name: "w2-gadget",
      scope: { type: "task", taskId: "task-w2-1" },
      files: [{ path: "index.html", content: "<html><body><h1>Wave 2 Gadget</h1></body></html>" }],
    });
    assert(createdGadget.id, "T01: PiNodeHost GadgetService created gadget under supervised Core");

    // T06 / T10 / T11 + T01 ModelRuntime Proxy + T03 Platform RPC + T04/T05 Auto-Recovery:
    ui = new UiReconnectController(exe, dbPath, {
      dataDirectory: dataDir,
      clientId: "w2-ui",
    });
    const replayedIds: string[] = [];
    let resyncCount = 0;
    let hydrateCount = 0;
    const proxy = new PlatformCapabilityProxy();
    proxy.registerDomainHandler("browser", async (_action, payload) => ({ echoed: payload, from: "main-browser" }));
    let desktopAborted = false;
    proxy.registerDomainHandler("desktop", async (action, _payload, signal) => {
      if (action === "slow") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            desktopAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      return { screen: "captured" };
    });

    const attachMainPlatform = () => {
      const c = ui?.getClient();
      if (c) proxy.attachCoreClient(c, { platformGeneration: "w2-main" });
    };

    ui.addHooks({
      onSnapshot: () => attachMainPlatform(),
      onEvent: ev => {
        mainAgent?.handleCoreExecutionEvent(ev);
        if (ev.domain === "domainNote" && ev.entityId.startsWith("note-w2-")) {
          replayedIds.push(ev.entityId);
        }
      },
      onResync: () => {
        resyncCount += 1;
        attachMainPlatform();
      },
      onHydrate: () => {
        hydrateCount += 1;
      },
    });

    const snap1 = await ui.openUiSession();
    const coreGen1 = snap1.coreGeneration;

    mainAgent = await AgentService.open(db, undefined, {
      executionMode: "isolated-client",
      coreClient: () => ui?.getClient(),
    });
    await mainAgent.init();

    // T01: Isolated-client ModelRuntime control proxy calls
    const models = await mainAgent.listModels();
    assert(models.some(m => m.id === "fixture/model"), "T01: isolated-client listModels proxied via Core -> PiNodeHost");
    const providers = await mainAgent.listLoginProviders();
    assert(Array.isArray(providers), "T01: isolated-client listLoginProviders proxied via Core -> PiNodeHost");
    const creds = await mainAgent.listCredentials();
    assert(Array.isArray(creds), "T01: isolated-client listCredentials proxied via Core -> PiNodeHost");
    const reloaded = await mainAgent.reloadModels();
    assert(Array.isArray(reloaded.models), "T01: isolated-client reloadModels proxied via Core -> PiNodeHost");
    const authResp = await mainAgent.authRespond("nonexistent-req", "tok");
    assert.equal(authResp, false, "T01: isolated-client authRespond awaits real boolean from PiNodeHost");

    // T03: PlatformRpcClient roundtrip, offline waiting, AbortSignal cancel, and mid-flight Main disconnect
    const platformRpc = fullHost.getPlatformRpcClient()!;
    proxy.setUiOnline(false);
    proxy.setBrowserAvailable(false);
    await new Promise(r => setTimeout(r, 50));
    const offRes = await platformRpc.invoke("browser", "eval", { x: 1 });
    assert.equal(offRes.status, "waiting_platform", "T03 Negative Proof: offline browser waits honestly");

    proxy.setUiOnline(true);
    proxy.setBrowserAvailable(true);
    proxy.setDesktopAvailable(true);
    await until(() => platformRpc.isDomainAvailable("browser") && platformRpc.isDomainAvailable("desktop"), "PiNodeHost received Core platform availability");

    const okBrowser = await platformRpc.invoke<{ echoed: { q: string }; from: string }>("browser", "eval", { q: "ping" });
    assert.equal(okBrowser.status, "completed", "T03: browser RPC completed through Core -> Main");
    assert.equal(okBrowser.result.from, "main-browser");

    const ac = new AbortController();
    const slowPromise = platformRpc.invoke("desktop", "slow", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const cancelledRes = await slowPromise;
    assert.equal(cancelledRes.status, "cancelled", "T03: caller AbortSignal propagates cancellation cleanly");
    await until(() => desktopAborted, "T03: Main platform handler observed AbortSignal");

    // T03 Negative proof: Disconnect Main mid-flight -> returns uncertain_platform_disconnect without hanging
    const disconnectFlight = platformRpc.invoke("desktop", "slow", {});
    await new Promise(r => setTimeout(r, 50));
    await ui.closeUiSession();
    const crashedOutcome = await disconnectFlight;
    assert.equal(crashedOutcome.status, "uncertain_platform_disconnect", "T03 Negative Proof: UI disconnect drains in-flight platform call cleanly");

    // T06 / T10 / T11: Offline notes emitted while UI closed -> reopened UI replays exact sequence in order
    await bg.upsertNote({ commandId: "w2-n1", entityId: "note-w2-1", title: "Note 1", body: { n: 1 } });
    await bg.upsertNote({ commandId: "w2-n2", entityId: "note-w2-2", title: "Note 2", body: { n: 2 } });
    await ui.openUiSession();
    assert.deepEqual(replayedIds, ["note-w2-1", "note-w2-2"], "T06: Offline events replayed in order with zero drops");

    // T11: Gap resync triggers onResync & onHydrate
    const gap = await ui.replayFrom(0, "stale-gen-proof");
    assert.equal(gap.resynced, true);
    assert(resyncCount >= 1 && hydrateCount >= 1, "T11: Gap/generation change triggered both onResync and onHydrate");

    // T04 / T05: Kill Core worker -> watchdog respawns Core with new generation; BOTH UiReconnectController AND PiNodeHost auto-reconnect!
    const corePid1 = ui.getClient()!.workerPid;
    try { process.kill(corePid1, "SIGKILL"); } catch { /* */ }
    await until(() => !alive(corePid1), "Killed Core worker exited");

    await until(() => {
      const curGen = ui!.getCursor().coreGeneration;
      return Boolean(ui!.getState().connected && curGen && curGen !== coreGen1);
    }, "T05: UiReconnectController auto-reconnected to watchdog-recovered Core generation", 25_000);
    assert(hydrateCount >= 2, "T05: Auto-reconnect onto new Core generation invoked onHydrate");

    await until(async () => {
      const piClient = fullHost!.getClient();
      if (!piClient || piClient.isClosed) return false;
      const status = await piClient.piHost<{ activeHost?: { hostGeneration?: string; status?: string } }>({ action: "status" }).catch(() => undefined);
      return status?.activeHost?.hostGeneration === fullHost!.hostGeneration && status.activeHost.status === "running";
    }, "T05: PiNodeHost ExecutionHostBridge auto-reconnected and re-registered after Core crash", 25_000);

    console.log("PASS Wave 2 (T01..T06, T10, T11 + negative proofs): capabilities, domain wiring, Platform RPC, unattended recovery, and cursor resync verified");
  } finally {
    await ui?.closeUiSession().catch(() => undefined);
    await partialHost?.close().catch(() => undefined);
    await fullHost?.close().catch(() => undefined);
    await bg?.close().catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    db?.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    await llm.stop().catch(() => undefined);
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
    if (prevAutoTick !== undefined) process.env.MYBUDDY_WORK_AUTO_TICK_MS = prevAutoTick; else delete process.env.MYBUDDY_WORK_AUTO_TICK_MS;
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch { /* Windows async handle release */ }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
