/** Step 3 real-process acceptance suite (`RC-06`, `RC-07`, `RC-08`). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreBusinessClient, type CoreDomainEvent } from "../src/main/platform/core-business-client";
import { connectCoreWorker, shutdownCoreWorker } from "../src/main/platform/core-client";
import { buildCoreAutostartSpec, launchCoreWatchdog, syncCoreAutostart } from "../src/main/platform/core-autostart";
import { ExecutionHostBridge, createDurableBotExecutionRunner } from "../src/main/host/ExecutionHostBridge";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real Rust worker binary is required");

const testsRoot = join(process.cwd(), "out", "tests");
mkdirSync(testsRoot, { recursive: true });
const sandbox = mkdtempSync(join(testsRoot, "core-business-protocol-"));
const trackedPids = new Set<number>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout (${timeoutMs}ms): ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function verifyMultiRoleIsolationAndDomainCommands(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "rc06-"));
  const dataDir = join(dir, "data");
  const dbPath = join(dir, "app.db");
  const gadgetDir = join(dir, "gadget");
  mkdirSync(dataDir);
  mkdirSync(gadgetDir);
  writeFileSync(dbPath, "");

  let ui1: CoreBusinessClient | undefined;
  let ui2: CoreBusinessClient | undefined;
  let bg: CoreBusinessClient | undefined;
  let execClient: CoreBusinessClient | undefined;

  try {
    ui1 = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-1" }), "ui-1 connect");
    ui2 = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-2" }), "ui-2 connect");
    bg = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-1" }), "bg-1 connect");
    execClient = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "execution-host", clientId: "exec-1" }), "exec-1 connect");

    // Force socket chunks to split both three- and four-byte code points.
    let streamed: unknown;
    const stop = ui1.onCoreEvent(event => { streamed = event.payload.text; });
    const frame = Buffer.from(JSON.stringify({ coreStreamEvent: { payload: { text: "你好🌊" } } }) + "\n");
    for (const byte of frame) ui1.transport.stdout.write(Buffer.from([byte]));
    stop();
    assert.equal(streamed, "你好🌊");

    assert.equal(ui1.workerPid, bg.workerPid);
    assert.equal(execClient.workerPid, ui1.workerPid);
    assert.notEqual(ui1.connectionEpoch, ui2.connectionEpoch);

    // Duplicate exclusive role must be rejected without disturbing live clients.
    await assert.rejects(
      connectCoreWorker(executable!, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-dup", timeoutMs: 700 }),
      /role_busy|Core did not become available/,
    );

    // Named domain command: optimistic revision check and commandId deduplication.
    const first = await ui1.upsertNote({
      commandId: "cmd-note-1",
      entityId: "note-a",
      expectedRevision: 0,
      title: "v1",
      body: { text: "alpha" },
    });
    assert.equal(first.status, "committed");
    assert.equal(first.revision, 1);

    const dup = await ui2.upsertNote({
      commandId: "cmd-note-1",
      entityId: "note-a",
      title: "should-dedup",
    });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.revision, 1);

    const conflict = await ui2.upsertNote({
      commandId: "cmd-note-conflict",
      entityId: "note-a",
      expectedRevision: 0,
      title: "stale",
    });
    assert.equal(conflict.code, "REVISION_CONFLICT");

    // Cross-role isolation: UI cannot impersonate execution-host.
    const spoofAck = await ui1.request<Record<string, unknown>>({
      operation: "coreExecution",
      action: "executorAck",
      executionId: "missing",
      attempt: 1,
    });
    assert.equal(spoofAck.code, "FORBIDDEN_ROLE");

    // Open Gadget on background-service while UI disconnects; UI disconnect must not revoke bg generation.
    const opened = await bg.request<Record<string, unknown>>({ operation: "gadgetState", request: { kind: "open", path: gadgetDir } });
    assert.equal(opened.kind, "opened");
    const bgGen = randomUUID();
    const bgWrite = await bg.request<Record<string, unknown>>({
      operation: "gadgetState",
      request: {
        kind: "access",
        path: gadgetDir,
        canonicalPath: opened.canonicalPath,
        bucket: "storage",
        action: { operation: "set", key: [98], valueJson: JSON.stringify("bg-alive"), writeId: randomUUID() },
        authorization: { generation: bgGen, invocationId: "bg-inv-1", expiresAt: Date.now() + 30_000 },
      },
    });
    assert.equal(bgWrite.kind, "value");

    // Start an execution on execClient, then disconnect UI -> execution & bg-1 stay healthy.
    const submitted = await ui1.submitExecution({
      executionId: "exec-ui-disconnect",
      idempotencyKey: "key-ui-disconnect",
      taskId: "task-bg",
      kind: "pi_turn",
      payload: { prompt: "keep going" },
    });
    assert.equal(submitted.execution?.status, "dispatching");
    const acked = await execClient.executorAck("exec-ui-disconnect", 1);
    assert.equal((acked.execution as { status: string }).status, "running");

    await ui1.close();
    ui1 = undefined;
    await delay(50);

    // Background Gadget generation and in-flight execution must survive UI disconnect.
    const bgWrite2 = await bg.request<Record<string, unknown>>({
      operation: "gadgetState",
      request: {
        kind: "access",
        path: gadgetDir,
        canonicalPath: opened.canonicalPath,
        bucket: "storage",
        action: { operation: "set", key: [99], valueJson: JSON.stringify("after-ui-drop"), writeId: randomUUID() },
        authorization: { generation: bgGen, invocationId: "bg-inv-2", expiresAt: Date.now() + 30_000 },
      },
    });
    assert.equal(bgWrite2.kind, "value");

    const settled = await execClient.executorSettled({
      executionId: "exec-ui-disconnect",
      attempt: 1,
      status: "completed",
      result: { text: "done-without-ui" },
    });
    assert.equal((settled.execution as { status: string }).status, "completed");

    console.log("PASS RC-06 multi-role isolation, optimistic revision, command dedup, and UI disconnect independence");
  } finally {
    await ui1?.close().catch(() => undefined);
    await ui2?.close().catch(() => undefined);
    await bg?.close().catch(() => undefined);
    await execClient?.close().catch(() => undefined);
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }
}

async function verifyEventSnapshotCursorAndGapResync(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "rc07-"));
  const dataDir = join(dir, "data");
  const dbPath = join(dir, "app.db");
  mkdirSync(dataDir);
  writeFileSync(dbPath, "");

  let bg: CoreBusinessClient | undefined;
  let ui: CoreBusinessClient | undefined;

  try {
    bg = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg" }), "rc07 bg");
    ui = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-sub" }), "rc07 ui");

    const received: CoreDomainEvent[] = [];
    const resyncs: Array<{ headSeq: number; reason: string }> = [];
    let sub = await ui.openEventSubscription({
      domain: "domainNote",
      onEvent: ev => received.push(ev),
      onResync: (snap, reason) => resyncs.push({ headSeq: snap.headSeq, reason }),
    });
    const cursorBeforeDrop = sub.getCursor();
    assert.equal(cursorBeforeDrop.lastSeq, 0);

    await sub.close();
    await ui.close();

    // Commit 3 updates while UI subscriber is offline.
    for (let i = 1; i <= 3; i++) {
      await bg.upsertNote({
        commandId: `offline-cmd-${i}`,
        entityId: `note-${i}`,
        title: `Offline ${i}`,
      });
    }

    // Reconnect and incrementally catch up from the saved cursor.
    ui = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-rejoin" }), "rc07 ui rejoin");
    const replayEvents: CoreDomainEvent[] = [];
    sub = await ui.openEventSubscription({
      domain: "domainNote",
      onEvent: ev => replayEvents.push(ev),
      onResync: (snap, reason) => resyncs.push({ headSeq: snap.headSeq, reason }),
    });
    assert.equal(sub.initialSnapshot.headSeq, 3);
    assert.equal(sub.initialSnapshot.notes.length, 3);

    const directReplay = await ui.eventsReplay(cursorBeforeDrop.lastSeq, cursorBeforeDrop.coreGeneration);
    assert.equal(directReplay.gap, false);
    assert.deepEqual(directReplay.events.map(e => e.seq), [1, 2, 3]);

    // Shrink retention window so earlier events are pruned and stale cursor triggers gap resync.
    await bg.setEventRetention(2);
    for (let i = 4; i <= 7; i++) {
      await bg.upsertNote({
        commandId: `prune-cmd-${i}`,
        entityId: `note-${i}`,
        title: `Pruned ${i}`,
      });
    }

    // Replaying from expired seq=0 must return gap=true and trigger full resync in openEventSubscription.
    const staleReplay = await ui.eventsReplay(0, cursorBeforeDrop.coreGeneration);
    assert.equal(staleReplay.gap, true);
    assert.equal(staleReplay.reason, "cursor_expired");

    const gapResult = await sub.replayFrom(0, cursorBeforeDrop.coreGeneration);
    assert.equal(gapResult.resynced, true);
    assert.equal(resyncs.length, 1);
    assert.equal(resyncs[0].reason, "cursor_expired");
    assert.equal(sub.getCursor().lastSeq, 7);

    // Generation mismatch triggers gap resync instead of silently mixing cursors.
    const wrongGen = await ui.eventsReplay(1, "previous-core-generation");
    assert.equal(wrongGen.gap, true);
    assert.equal(wrongGen.reason, "generation_mismatch");

    // Replaying or reading snapshots never re-executes domain commands (revisions stay strictly 1).
    const snap = await ui.eventsSnapshot("domainNote");
    assert.equal(snap.notes.every(n => n.revision === 1), true);

    await sub.close();
    const subscribe = ui.subscribeCursor.bind(ui);
    ui.subscribeCursor = async (...args) => {
      await bg!.upsertNote({ commandId: "before-live-attachment", entityId: "note-8", title: "Before attachment" });
      const attached = await subscribe(...args);
      await bg!.upsertNote({ commandId: "after-live-attachment", entityId: "note-9", title: "After attachment" });
      return attached;
    };
    const overlap: CoreDomainEvent[] = [];
    sub = await ui.openEventSubscription({ domain: "domainNote", onEvent: event => overlap.push(event) });
    assert.equal(sub.initialSnapshot.headSeq, 7);
    await waitUntil(() => overlap.some(event => event.seq === 9), "live and replayed events delivered");
    assert.deepEqual(overlap.map(event => [event.seq, event.entityId]), [[8, "note-8"], [9, "note-9"]]);
    assert.equal(sub.getCursor().lastSeq, 9);
    await sub.close();
    console.log("PASS RC-07 atomic snapshot watermark, incremental cursor catch-up, dedup, and retention-gap full resync");
  } finally {
    await ui?.close().catch(() => undefined);
    await bg?.close().catch(() => undefined);
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }
}

async function verifyExecutionBridgeAndWatchdogRecovery(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "rc08-"));
  const dataDir = join(dir, "data");
  const dbPath = join(dir, "app.db");
  mkdirSync(dataDir);
  writeFileSync(dbPath, "");

  // 1) Offline executor must honestly wait (`waiting_executor`), never report running/completed.
  let ui: CoreBusinessClient | undefined;
  let bridge: ExecutionHostBridge | undefined;
  try {
    ui = await within(CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-exec" }), "rc08 ui");
    const offline = await ui.submitExecution({
      executionId: "exec-offline-1",
      idempotencyKey: "idem-offline-1",
      taskId: "task-offline",
      kind: "pi_turn",
      payload: { prompt: "wait for executor" },
    });
    assert.equal(offline.execution?.status, "waiting_executor");

    // Now start ExecutionHostBridge with a controllable fixture runner; waiting_executor auto-dispatches!
    let finishSlow!: () => void;
    const slowGate = new Promise<void>(resolve => { finishSlow = resolve; });
    let runCount = 0;
    bridge = new ExecutionHostBridge(executable!, dbPath, dataDir, {
      async start(dispatch, helpers) {
        runCount += 1;
        await helpers.reportProgress({ step: dispatch.execution.executionId });
        if (dispatch.execution.executionId === "exec-disconnect") {
          await slowGate;
        }
        return { status: "completed", result: { runCount, executionId: dispatch.execution.executionId } };
      },
    });
    await within(bridge.connect(), "connect ExecutionHostBridge");

    await waitUntil(async () => {
      const s = await ui!.executionStatus("exec-offline-1");
      return s.execution?.status === "completed";
    }, "offline queued execution dispatched and completed once executor arrived");
    assert.equal(runCount, 1);

    // Mid-run executor disconnect transitions running execution honestly to `unknown` without auto-replaying.
    await ui.submitExecution({
      executionId: "exec-disconnect",
      idempotencyKey: "idem-disconnect",
      taskId: "task-disconnect",
      kind: "pi_turn",
      payload: { prompt: "drop mid-flight" },
    });
    await waitUntil(async () => (await ui!.executionStatus("exec-disconnect")).execution?.status === "running", "exec-disconnect running");
    await bridge.close();
    finishSlow();

    await waitUntil(async () => (await ui!.executionStatus("exec-disconnect")).execution?.status === "unknown", "executor disconnect marked unknown");
    const reconciled = await ui.reconcileExecution({
      executionId: "exec-disconnect",
      status: "completed",
      attempt: 1,
      result: { reconciledBy: "test" },
    });
    assert.equal(reconciled.execution?.status, "completed");

    // Duplicate idempotencyKey reuses original execution and does NOT increment runCount.
    const dup = await ui.submitExecution({
      executionId: "exec-disconnect-dup",
      idempotencyKey: "idem-disconnect",
      taskId: "task-disconnect",
      kind: "pi_turn",
    });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.execution?.executionId, "exec-disconnect");

    // Queue / slot cap (1) + pause -> resume -> cancel lifecycle transitions.
    await ui.setExecutionSlotsLimit(1);
    const pausedBeforeExec = await ui.submitExecution({
      executionId: "exec-pause-resume",
      idempotencyKey: "idem-pause-resume",
      taskId: "task-pause",
      kind: "pi_turn",
      payload: { prompt: "pausable" },
    });
    assert.equal(pausedBeforeExec.execution?.status, "waiting_executor");
    const paused = await ui.pauseExecution("exec-pause-resume", pausedBeforeExec.execution!.revision);
    assert.equal(paused.execution?.status, "paused");
    const resumed = await ui.resumeExecution("exec-pause-resume", paused.execution!.revision);
    assert.equal(resumed.execution?.status, "waiting_executor");
    const cancelled = await ui.cancelExecution("exec-pause-resume", resumed.execution!.revision);
    assert.equal(cancelled.execution?.status, "cancelled");

    // Verify transitional Main Pi adapter maps DurableExecutionTarget states cleanly.
    const mockTarget = {
      async submit(req: { taskId: string; userMessageId: string }) {
        return { queued: true, receipt: { taskId: req.taskId, operationId: req.userMessageId, submissionId: 1, status: "queued" as const } };
      },
      async waitForSubmission(receipt: { taskId: string; operationId: string; submissionId: number }) {
        return { queued: false, receipt: { ...receipt, status: "done" as const } };
      },
      abort() { return undefined; },
      async findSubmission() { return undefined; },
    };
    const piRunner = createDurableBotExecutionRunner(mockTarget);
    const runnerOut = await piRunner.start(
      { targetRole: "execution-host", targetEpoch: 1, coreGeneration: "g", action: "start", execution: cancelled.execution! },
      { reportProgress: async () => undefined },
    );
    assert.equal(runnerOut.status, "completed");

    await ui.close();
    ui = undefined;
  } finally {
    await bridge?.close().catch(() => undefined);
    await ui?.close().catch(() => undefined);
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
  }

  // 2) Unattended watchdog: worker kill -> recover, supervisor kill -> recover, crash streak -> circuit_open,
  // --recover -> clears breaker, explicit `stop` (`停止助理`) -> exits cleanly and stays down.
  const wdDir = join(dir, "watchdog-data");
  const wdDb = join(dir, "watchdog.db");
  mkdirSync(wdDir);
  writeFileSync(wdDb, "");
  const endpointFile = join(wdDir, "core.json");
  const statusFile = join(wdDir, "core-status.json");
  const lifecycleFile = join(wdDir, "core-lifecycle.json");

  const wdEnv = {
    MYBUDDY_CORE_BACKOFF_MS: "40",
    MYBUDDY_CORE_RESTART_WINDOW_MS: "20000",
    MYBUDDY_CORE_MAX_RESTARTS: "3",
  };
  const wd = await launchCoreWatchdog(executable!, wdDir, wdDb, { env: wdEnv });
  if (wd.pid) trackedPids.add(wd.pid);

  await waitUntil(() => Boolean(readJson<{ workerPid?: number; pid?: number }>(endpointFile)?.workerPid), "watchdog initial supervisor ready");
  const ep1 = readJson<{ pid: number; workerPid: number; generation: string }>(endpointFile)!;
  trackedPids.add(ep1.pid); trackedPids.add(ep1.workerPid);

  // Kill WORKER with zero UI connected -> watchdog + Core recover with new worker/generation.
  process.kill(ep1.workerPid, "SIGKILL");
  await waitUntil(() => {
    const next = readJson<{ workerPid?: number; generation?: string }>(endpointFile);
    return Boolean(next?.workerPid && next.workerPid !== ep1.workerPid && next.generation !== ep1.generation);
  }, "unattended worker crash recovery");
  const ep2 = readJson<{ pid: number; workerPid: number; generation: string }>(endpointFile)!;
  trackedPids.add(ep2.pid); trackedPids.add(ep2.workerPid);

  // Kill SUPERVISOR directly -> watchdog relaunches supervisor + worker without UI.
  // The orphan worker may still hold the database while processing EOF after its
  // supervisor dies. Simulate a descheduled process, then let it finish normally.
  if (process.platform === "linux") process.kill(ep2.workerPid, "SIGSTOP");
  try {
    process.kill(ep2.pid, "SIGKILL");
    if (process.platform === "linux") await delay(500);
  } finally {
    if (process.platform === "linux") process.kill(ep2.workerPid, "SIGCONT");
  }
  await waitUntil(() => {
    const next = readJson<{ pid?: number; workerPid?: number; generation?: string }>(endpointFile);
    return Boolean(next?.pid && next.pid !== ep2.pid && next.generation !== ep2.generation);
  }, "unattended supervisor crash recovery");

  // Push crash streak past MYBUDDY_CORE_MAX_RESTARTS=3 -> circuit_open.
  const ep3 = readJson<{ pid: number; workerPid: number }>(endpointFile)!;
  process.kill(ep3.workerPid, "SIGKILL");
  await waitUntil(() => readJson<{ circuitOpen?: boolean; state?: string }>(statusFile)?.circuitOpen === true, "circuit breaker open");
  const openedStatus = readJson<{ circuitOpen: boolean; state: string; workerRestartCount: number }>(statusFile)!;
  assert.equal(openedStatus.state, "circuit_open");
  assert(openedStatus.workerRestartCount >= 2);

  // Watchdog refuses to spin while circuit_open unless `--recover` is supplied.
  const refusedCode = await new Promise<number | null>(resolve => {
    const child = spawn(wd.executable, ["--watchdog", wdDir, wdDb], { windowsHide: true, env: { ...process.env, ...wdEnv } });
    child.once("exit", code => resolve(code));
  });
  assert.notEqual(refusedCode, 0);

  // Explicit recovery clears breaker and restores Core cleanly.
  const recoveredWd = await launchCoreWatchdog(executable!, wdDir, wdDb, { recover: true, env: wdEnv });
  if (recoveredWd.pid) trackedPids.add(recoveredWd.pid);
  await waitUntil(() => Boolean(readJson<{ workerPid?: number }>(endpointFile)?.workerPid), "explicit --recover restart");

  // Explicit stop (`停止助理`): sets `stopped_explicitly`, shuts down Core, and prevents watchdog re-spawn.
  const ctrl = await within(CoreBusinessClient.connect(executable!, wdDb, { dataDirectory: wdDir, role: "background-service", clientId: "stop-ctrl" }), "connect stop-ctrl");
  const stopReply = await ctrl.assistantLifecycle("stop", { reason: "explicit_user_stop" });
  assert.equal(stopReply.state.mode, "stopped_explicitly");
  await waitUntil(() => !existsSync(endpointFile), "explicit stop tears down endpoint");
  await ctrl.close().catch(() => undefined);

  assert.equal(readJson<{ mode: string }>(lifecycleFile)?.mode, "stopped_explicitly");
  await delay(200);
  assert.equal(existsSync(endpointFile), false, "watchdog must not restart after stopped_explicitly");

  // Launching watchdog directly while stopped_explicitly must exit 0 immediately without starting Core.
  const skippedExit = await new Promise<number | null>(resolve => {
    const child = spawn(wd.executable, ["--watchdog", wdDir, wdDb], { windowsHide: true });
    child.once("exit", code => resolve(code));
  });
  assert.equal(skippedExit, 0);
  assert.equal(existsSync(endpointFile), false);

  // Autostart OS registration helper respects stop fence on both Windows and Linux specs.
  const invoked: Array<{ cmd: string; args: string[] }> = [];
  const resOff = await syncCoreAutostart({
    executable: executable!,
    dataDirectory: wdDir,
    dbPath: wdDb,
    autostartEnabled: true,
    platform: "windows",
    runner: async (cmd, args) => { invoked.push({ cmd, args }); },
  });
  assert.equal(resOff.enabled, false, "autostart must stay disabled when core-lifecycle is stopped_explicitly");
  assert.equal(invoked.some(i => i.args[0] === "delete"), true);

  const linuxSpec = buildCoreAutostartSpec(executable!, dataDir, dbPath, "linux", dir);
  assert.equal(linuxSpec.kind, "linux-systemd-xdg");
  assert.match(linuxSpec.commandLine, /--watchdog/);

  console.log("PASS RC-08 offline wait, execution bridge, unknown/reconcile, unattended watchdog/circuit-breaker, and explicit stop fence");
}

async function verifyDurableExecutionProgress(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "durable-progress-"));
  const dbPath = join(dir, "app.duckdb");
  const progressDrainTimeoutMs = 60_000;
  let releaseBuffered!: () => void;
  const buffered = new Promise<void>(resolve => { releaseBuffered = resolve; });
  let releaseCancelledRun!: () => void;
  const cancelledRun = new Promise<void>(resolve => { releaseCancelledRun = resolve; });
  let allowCancelProgress!: () => void;
  const pendingCancelProgress = new Promise<void>(resolve => { allowCancelProgress = resolve; });
  let releaseDisconnected!: () => void;
  const pendingDisconnect = new Promise<void>(resolve => { releaseDisconnected = resolve; });
  const overflowAdmission = Promise.withResolvers<Promise<unknown>[]>();
  let cancelRequested = false;
  let reports: Promise<unknown>[] = [];
  let liveSendStarted = false;
  const firstReply = Promise.withResolvers<void>();
  const textOnlyReply = Promise.withResolvers<void>();
  const textOnlyEnd = Promise.withResolvers<void>();
  const tailSubmitted = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const submittedSequences: Array<number | undefined> = [];
  const bridge = new ExecutionHostBridge(executable!, dbPath, dir, {
    async start({ execution }, { reportProgress }) {
      if (execution.executionId === "text-only") {
        for (const delta of ["前", "后"]) {
          await reportProgress({ patch: { type: "text_delta", taskId: "text-only", messageId: "reply", delta } }, { ephemeral: true });
        }
        await textOnlyEnd.promise;
        return { status: "completed" };
      }
      if (execution.executionId === "instant-stream") {
        await reportProgress({ patch: { type: "text_delta", taskId: "instant-stream", messageId: "reply", delta: "即时" } }, { ephemeral: true });
        await reportProgress({ patch: { type: "thinking_delta", delta: "思考" } }, { ephemeral: true });
        await reportProgress({ patch: { type: "text_delta", delta: "末尾" } }, { ephemeral: true });
        tailSubmitted.resolve();
        assert(liveSendStarted, "idle execution stream must send before the next timer tick");
      }
      const count = execution.executionId === "overflow" ? 193 : execution.executionId === "buffered" ? 70 : 1;
      reports = Array.from({ length: count }, (_, index) => reportProgress({ index }).catch(error => error));
      if (execution.executionId === "overflow") overflowAdmission.resolve(reports);
      if (execution.executionId === "cancelled-run") await cancelledRun;
      return { status: "completed" };
    },
    async cancel() { cancelRequested = true; },
  });
  let ui: CoreBusinessClient | undefined;
  try {
    ui = await CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dir, role: "ui", clientId: "progress-ui" });
    const initial = await ui.eventsSnapshot();
    const executor = await bridge.connect();
    const send = executor.executorProgress.bind(executor);
    let firstBuffered = false;
    let cancelProgress = false;
    let lostReply = false;
    let disconnectProgress = false;
    const lost: { request?: Parameters<CoreBusinessClient["executorProgress"]> } = {};
    const exhaustedIds: (string | undefined)[] = [];
    executor.executorProgress = async (...args) => {
      if (args[0] === "text-only" && args[5]?.streamSeq === 1) {
        const reply = await send(...args);
        await textOnlyReply.promise;
        return reply;
      }
      if (args[0] === "instant-stream" && args[5]?.ephemeral) {
        const delta = (args[2] as {patch:{delta:string}}).patch.delta;
        delivered.push(delta);
        submittedSequences.push(args[5].streamSeq);
        if (!liveSendStarted) {
          liveSendStarted = true;
          const reply = await send(...args);
          await firstReply.promise;
          return reply;
        }
      }
      if (args[0] === "buffered") {
        firstBuffered = true;
        await buffered;
      }
      if (args[0] === "cancelled-run") {
        cancelProgress = true;
        await pendingCancelProgress;
      }
      if (args[0] === "disconnected-run") {
        disconnectProgress = true;
        await pendingDisconnect;
      }
      if (args[0] === "retry-exhausted") {
        exhaustedIds.push(args[5]?.progressId);
        throw new Error("fixture transport failure");
      }
      // Exercise the real Core rejection path with an invalid attempt.
      if (args[0] === "rejected") args[1] = 0;
      const reply = await send(...args);
      if (args[0] === "lost-reply" && !lostReply) {
        assert.equal(reply.status, "ok");
        lostReply = true;
        lost.request = args;
        throw new Error("fixture lost reply after Core committed the progress");
      }
      return reply;
    };
    const submit = (id: string) => ui!.submitExecution({
      executionId: id, idempotencyKey: id, taskId: id, kind: "pi_turn",
    });
    const status = async (id: string) => (await ui!.executionStatus(id)).execution;
    const eventsFor = async (id: string) => {
      const replay = await ui!.eventsReplay(initial.headSeq, initial.coreGeneration, 1000);
      assert.equal(replay.gap, false);
      return replay.events.filter(ev => ev.entityId === id);
    };

    const received: string[] = [];
    const textOnlyReceived: string[] = [];
    const subscription = await ui.openEventSubscription({ onEvent(event) {
      if (!event.ephemeral || !["instant-stream", "text-only"].includes(event.entityId)) return;
      if (event.entityId === "text-only") {
        textOnlyReceived.push((event.payload.progress as {patch: {delta: string}}).patch.delta);
        return;
      }
      const progress = event.payload.progress as { patch: { delta: string } };
      received.push(progress.patch.delta);
    } });
    await submit("instant-stream");
    await within(tailSubmitted.promise, "tail produced while first RPC waits");
    await waitUntil(() => received.length === 3, "UI receives the next text before the first RPC acknowledgement is released");
    assert.deepEqual(submittedSequences, [1, 2, 3]);
    assert.equal((await status("instant-stream"))?.status, "running");
    firstReply.resolve();
    await waitUntil(async () => (await status("instant-stream"))?.status === "completed", "settlement follows confirmed stream delivery");
    assert.deepEqual(delivered, ["即时", "思考", "末尾"]);
    assert.deepEqual(received, delivered);
    await submit("text-only");
    await waitUntil(() => textOnlyReceived.length === 2, "Core publishes both texts while the first acknowledgement waits");
    assert.deepEqual(textOnlyReceived, ["前", "后"]);
    textOnlyEnd.resolve();
    await waitUntil(async () => (await status("text-only"))?.status === "completed", "Core confirms the full stream before the delayed acknowledgement returns");
    textOnlyReply.resolve();
    console.log("PASS text-only completion confirmed by Core while first RPC acknowledgement is still withheld");
    await subscription.close();
    console.log("PASS active UI receives text, thinking and final text in order while the first RPC acknowledgement is withheld");
    await submit("buffered");
    await waitUntil(() => firstBuffered, "first durable progress reached the transport");
    assert.equal((await status("buffered"))?.status, "running");
    releaseBuffered();
    await within(Promise.all(reports), "buffered progress acknowledged", progressDrainTimeoutMs);
    await waitUntil(async () => (await status("buffered"))?.status === "completed", "settlement waits for the entire burst");
    const bufferedEvents = await eventsFor("buffered");
    assert.deepEqual(
      bufferedEvents.filter(ev => ev.kind === "execution.progress").map(ev => ev.payload?.progress),
      Array.from({ length: 70 }, (_, index) => ({ index })),
    );
    assert.equal(bufferedEvents.at(-1)?.kind, "execution.completed");

    await submit("overflow");
    const overflowReports = await within(overflowAdmission.promise, "overflow burst admitted");
    const excess = await within(overflowReports.at(-1)!, "overflow report rejected at admission");
    assert(excess instanceof Error && /overloaded/i.test(excess.message));
    // Every admitted report receives a separate durable Core acknowledgement in order.
    const admittedReports = overflowReports.slice(0, -1);
    const acknowledged = await within(Promise.all(admittedReports), "admitted overflow reports acknowledged", progressDrainTimeoutMs);
    assert.deepEqual(acknowledged, admittedReports.map(() => undefined));
    await waitUntil(async () => ["completed", "unknown"].includes((await status("overflow"))?.status ?? ""), "overflow settlement published after drain");
    const overflowResult = await status("overflow");
    assert.equal(overflowResult?.status, "unknown", "A synchronous burst must respect admission bounds");
    assert.match(overflowResult?.errorMessage ?? "", /overloaded/i);

    await submit("rejected");
    await waitUntil(async () => ["completed", "unknown"].includes((await status("rejected"))?.status ?? ""), "Core rejection settled");
    assert.equal((await status("rejected"))?.status, "unknown", "Core's rejected reply cannot confirm durable progress");
    assert.match(String((await Promise.all(reports))[0]), /STALE_EXECUTOR_OWNER/);

    await submit("lost-reply");
    await waitUntil(async () => (await status("lost-reply"))?.status === "completed", "committed progress reply is recovered");
    assert(lostReply);
    assert.deepEqual((await eventsFor("lost-reply")).filter(ev => ev.kind === "execution.progress").map(ev => ev.payload?.progress), [{ index: 0 }]);
    const firstAttempt = lost.request;
    assert(firstAttempt?.[5]?.progressId);
    firstAttempt[2] = { index: 100 };
    assert.equal((await send(...firstAttempt)).code, "PROGRESS_ID_CONFLICT");

    await submit("retry-exhausted");
    await waitUntil(async () => ["completed", "unknown"].includes((await status("retry-exhausted"))?.status ?? ""), "retry exhaustion settled");
    assert.equal((await status("retry-exhausted"))?.status, "unknown");
    assert.equal(exhaustedIds.length, 3);
    assert(exhaustedIds[0]);
    assert.equal(new Set(exhaustedIds).size, 1);
    assert.match(String((await Promise.all(reports))[0]), /after 3 attempts/);

    await submit("cancelled-run");
    await waitUntil(() => cancelProgress, "cancellable run queued its durable progress");
    assert.equal((await ui.cancelExecution("cancelled-run")).execution?.status, "cancel_requested");
    await waitUntil(() => cancelRequested, "Host received the cancel dispatch");
    assert.equal((await status("cancelled-run"))?.status, "cancel_requested");
    allowCancelProgress();
    await waitUntil(async () => (await status("cancelled-run"))?.status === "cancelled", "cancel waits for progress confirmation");
    releaseCancelledRun();
    const cancelledEvents = await eventsFor("cancelled-run");
    assert.deepEqual(cancelledEvents.slice(-2).map(ev => ev.kind), ["execution.progress", "execution.cancelled"]);
    assert.equal((await status("cancelled-run"))?.status, "cancelled");

    await submit("disconnected-run");
    await waitUntil(() => disconnectProgress, "disconnected run has unconfirmed durable progress");
    await bridge.close();
    releaseDisconnected();
    await waitUntil(async () => (await status("disconnected-run"))?.status === "unknown", "Core records disconnect before settlement");
    assert((await Promise.all(reports))[0] instanceof Error);
    console.log("PASS IN-11 bounded bursts, ordered settlement/cancel, Core rejection, stable retries, disconnect, and lost-reply replay");
  } finally {
    textOnlyEnd.resolve();
    textOnlyReply.resolve();
    firstReply.resolve();
    releaseBuffered();
    releaseCancelledRun();
    allowCancelProgress();
    releaseDisconnected();
    await bridge.close().catch(() => undefined);
    await ui?.close().catch(() => undefined);
    await shutdownCoreWorker(dir, dbPath).catch(() => undefined);
  }
}

async function verifySequencedStreams(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "sequenced-stream-"));
  const dbPath = join(dir, "app.duckdb");
  const ui = await CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dir, role: "ui", clientId: "sequence-ui" });
  let host: CoreBusinessClient | undefined;
  try {
    host = await CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dir, role: "execution-host", clientId: "sequence-host" });
    const observed: Array<[string, number, number, string]> = [];
    const subscription = await ui.openEventSubscription({ onEvent(event) {
      if (!event.ephemeral || event.kind !== "execution.progress") return;
      const progress = event.payload.progress as { patch: { delta: string } };
      observed.push([event.entityId, Number(event.payload.attempt), Number(event.payload.streamSeq), progress.patch.delta]);
    } });
    const [a, b] = ["stream-a", "stream-b"];
    const send = (id: string, attempt: number, seq: number, delta: string) => host!.executorProgress(id, attempt,
      { patch: { type: "text_delta", taskId: id, messageId: "reply", delta } }, undefined, undefined, { ephemeral: true, streamSeq: seq });
    const settle = (executionId: string, attempt: number, lastStreamSeq: number, status: "completed" | "paused" = "completed") =>
      host!.executorSettled({ executionId, attempt, lastStreamSeq, status });
    try {
      for (const id of [a, b]) {
        assert.equal((await ui.submitExecution({ executionId: id, taskId: id, idempotencyKey: id, kind: "pi_turn" })).status, "ok");
        assert.equal((await host.executorAck(id, 1)).status, "ok");
      }
      const initial = await Promise.all([send(a, 1, 2, "二"), send(b, 1, 1, "并行")]);
      assert(initial.every(reply => reply.status === "ok"));
      await waitUntil(() => observed.some(([id]) => id === b), "second task bypasses the first task's missing sequence");
      assert.deepEqual(observed, [[b, 1, 1, "并行"]]);
      assert.equal((await settle(a, 1, 2)).status, "rejected");
      assert.equal((await ui.executionStatus(a)).execution?.status, "running");
      assert.equal((await settle(b, 1, 1)).status, "ok");
      assert.equal((await send(a, 1, 1, "一")).status, "ok");
      assert.equal((await send(a, 1, 3, "三")).status, "ok");
      await waitUntil(() => observed.length === 4, "all three frames replay in order");
      assert.equal((await settle(a, 1, 3, "paused")).status, "ok");
      assert.equal((await ui.resumeExecution(a)).execution?.attempt, 2);
      assert.equal((await host.executorAck(a, 2)).status, "ok");
      assert.equal((await send(a, 1, 1, "过期")).status, "rejected");
      assert.equal((await settle(a, 1, 3)).status, "rejected");
      assert.equal((await settle(a, 2, 1)).status, "rejected");
      assert.equal((await send(a, 2, 1, "恢复")).status, "ok");
      assert.equal((await settle(a, 2, 1)).status, "ok");
      await waitUntil(() => observed.length === 5, "new attempt starts at one");
      assert.deepEqual(observed, [[b, 1, 1, "并行"], [a, 1, 1, "一"], [a, 1, 2, "二"], [a, 1, 3, "三"], [a, 2, 1, "恢复"]]);
      assert.equal((await ui.executionStatus(a)).execution?.status, "completed");
      assert.equal((await ui.executionStatus(b)).execution?.status, "completed");
      assert(existsSync(dbPath));
      assert(!existsSync(join(dir, "app.db")));
      console.log("PASS independent tasks, gap rejection, ordered live delivery and stale-attempt fencing across pause/resume");
    } finally {
      await subscription.close();
    }
  } finally {
    await host?.close().catch(() => undefined);
    await ui.close().catch(() => undefined);
    await shutdownCoreWorker(dir, dbPath).catch(() => undefined);
  }
}

async function verifyPiControlsWhenTurnSlotsAreFull(): Promise<void> {
  const dir = mkdtempSync(join(sandbox, "pi-control-capacity-"));
  const dbPath = join(dir, "app.db");
  writeFileSync(dbPath, "");
  let ui: CoreBusinessClient | undefined;
  const held = new Map<string, () => void>();
  const bridge = new ExecutionHostBridge(executable!, dbPath, dir, {
    async start({ execution }) {
      if (execution.executionId.startsWith("held-")) await new Promise<void>(resolve => held.set(execution.executionId, resolve));
      return { status: "completed", result: { executionId: execution.executionId } };
    },
  });
  try {
    ui = await CoreBusinessClient.connect(executable!, dbPath, { dataDirectory: dir, role: "ui", clientId: "pi-control-capacity" });
    await bridge.connect();
    const submit = (executionId: string, kind: string, payload: Record<string, unknown>, taskId = `task-${executionId}`) =>
      ui!.submitExecution({ executionId, idempotencyKey: executionId, taskId, kind, payload });
    const state = async (executionId: string) => (await ui!.executionStatus(executionId)).execution;
    const expectCompleted = (id: string) => waitUntil(async () => (await state(id))?.status === "completed", id);
    const turns = Array.from({ length: 8 }, (_, index) => `held-turn-${index}`);
    await Promise.all(turns.map(id => submit(id, "pi_turn", { resourceKey: `workspace-${id}` })));
    await waitUntil(() => turns.every(id => held.has(id)), "eight independent Pi turns occupy the default execution slots");

    for (const [action, payload] of [
      ["abort", {}], ["findSubmission", {}], ["submissionStatus", { wait: false }], ["authRespond", {}], ["authCancel", {}],
    ] as const) {
      const id = `control-${action}`;
      assert.equal((await submit(id, "pi_control", { controlAction: action, ...payload })).status, "ok");
      await expectCompleted(id);
    }
    for (const [id, kind, payload] of [
      ["result-wait", "pi_control", { controlAction: "submissionStatus", wait: true }],
      ["malformed-wait", "pi_control", { controlAction: "submissionStatus", wait: "true" }],
      ["title", "pi_control", { controlAction: "generateTaskTitle" }],
      ["login", "pi_control", { controlAction: "login" }],
      ["compact", "pi_compact", {}],
      ["ninth-turn", "pi_turn", {}],
    ] as const) {
      const result = await submit(id, kind, payload);
      assert.equal(result.execution?.status, "queued", id);
      assert.equal((await state(id))?.waitReason, "slots_exhausted", id);
    }
    await submit("locked-control", "pi_control", { controlAction: "findSubmission", resourceKey: "workspace-held-turn-0" });
    assert.match((await state("locked-control"))?.waitReason ?? "", /^conflict:resource:/);
    await submit("same-session-turn", "pi_turn", {}, "task-held-turn-0");
    assert.match((await state("same-session-turn"))?.waitReason ?? "", /^conflict:session:/);

    const controls = Array.from({ length: 5 }, (_, index) => `held-control-${index}`);
    for (const id of controls) await submit(id, "pi_control", { controlAction: "findSubmission" });
    await waitUntil(() => controls.slice(0, 4).every(id => held.has(id)), "four independent Pi controls start even with eight active turns");
    assert.equal((await state(controls[4]))?.waitReason, "pi_control_slots_exhausted");
    held.get(controls[0])!();
    await waitUntil(() => held.has(controls[4]), "the next control starts after only a control slot frees up");
    for (const id of controls.slice(1)) held.get(id)!();
    await Promise.all(controls.map(expectCompleted));

    let saturated = false;
    for (let start = 0; start < 288 && !saturated; start += 16) {
      const replies = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        submit(`backlog-${start + index}`, "pi_turn", {}, "task-held-turn-0")));
      saturated = replies.some(reply => reply.code === "OVERLOADED");
    }
    assert(saturated, "a full ordinary backlog is still bounded");
    assert.equal((await submit("reserved-auth-cancel", "pi_control", { controlAction: "authCancel" })).status, "ok");
    await expectCompleted("reserved-auth-cancel");
    const reserved = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      submit(`held-reserve-${index}`, "pi_control", { controlAction: "findSubmission" })));
    assert(reserved.some(reply => reply.status === "ok"));
    assert(reserved.some(reply => reply.code === "OVERLOADED"), "the independent control admission reserve is bounded");
    console.log("PASS Pi controls run through independent bounded slots and admission reserve while long turns remain active");
  } finally {
    await bridge.close().catch(() => undefined);
    for (const release of held.values()) release();
    await ui?.close().catch(() => undefined);
    await shutdownCoreWorker(dir, dbPath).catch(() => undefined);
  }
}

try {
  await verifyMultiRoleIsolationAndDomainCommands();
  await verifyEventSnapshotCursorAndGapResync();
  await verifyExecutionBridgeAndWatchdogRecovery();
  await verifySequencedStreams();
  await verifyDurableExecutionProgress();
  await verifyPiControlsWhenTurnSlotsAreFull();
} finally {
  for (const pid of trackedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
  }
  await delay(150);
  rmSync(sandbox, { recursive: true, force: true });
}
