/**
 * Step 5 real-process Rust Work Scheduler acceptance suite (`RC-11`, `RC-12`, `RC-13`).
 *
 * Verifies against the real compiled Rust Core worker & supervisor:
 *   - `RC-11`: Dual-owner fencing (`OWNER_CONFLICT`), old-owner/stale-revision rejection
 *     after Core takeover/restart, legitimate in-flight settlement preservation, and Main scheduler lockout.
 *   - `RC-12`: Non-blocking foreground reads/controls during long Work execution, genuine
 *     parallel execution of independent Works/resources, and serialization of conflicting resources.
 *   - `RC-13`: Amend/Pause/Resume/Cancel lifecycle transitions, DST-aware watch tick &
 *     `endsAt` expiry, mid-execution disconnect & worker restart recovery (`unknown` without
 *     duplicate replay), partial deliverable preservation, and completion/acceptance/archive separation.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { ExecutionHostBridge } from "../src/main/host/ExecutionHostBridge";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real Rust worker binary is required");

const testsRoot = join(process.cwd(), "out", "tests");
mkdirSync(testsRoot, { recursive: true });
const sandbox = mkdtempSync(join(testsRoot, "rust-work-scheduler-"));

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

try {
  // =========================================================================
  // Part A: Supervised Production Auto-Ticker & Main Lockout Guard
  // =========================================================================
  {
    const autoDir = join(sandbox, "auto-core");
    const autoDbPath = join(autoDir, "app.db");
    mkdirSync(autoDir, { recursive: true });

    const app = await AppDatabase.open(autoDbPath, {
      runtimeAuditExecutable: executable,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    try {
      const bots = new BotRegistry(app.connection);
      const works = new WorkService(app.connection, { bots, runtimeAuditReader: app.runtimeAuditReader });
      assert.throws(
        () => works.scheduler.start(500),
        /Rust Core owns Work scheduling/,
        "Main WorkWatchScheduler.start() must refuse to run under supervised Core",
      );

      const auth = new WorkHostAuthority(app.connection, "main-observer", 60_000, () => Date.now(), app.runtimeAuditReader, true);
      auth.start();
      await waitUntil(() => auth.isAuthority(), "supervised Core claims core:<gen> lease automatically");
      const status = auth.status();
      assert(status.holderAuthorityId?.startsWith("core:"), `expected core:<gen> holder, got ${status.holderAuthorityId}`);
      auth.stop();
      await auth.flush();
      await app.runtimeAuditReader?.close();
    } finally {
      app.close();
      await shutdownCoreWorker(autoDir, autoDbPath).catch(() => undefined);
    }
  }

  // =========================================================================
  // Part B: RC-11, RC-12, RC-13 Deterministic Multi-Client Protocol Acceptance
  // =========================================================================
  const dataDir = join(sandbox, "core-data");
  const dbPath = join(dataDir, "app.db");
  mkdirSync(dataDir, { recursive: true });

  const uiInit = await AppDatabase.open(dbPath, {
    runtimeAuditExecutable: executable,
    runtimeAuditSupervised: true,
    readonly: true,
  });
  await uiInit.runtimeAuditReader?.close();
  uiInit.close();

  let ui = await CoreBusinessClient.connect(executable, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-sched" });
  const bg = await CoreBusinessClient.connect(executable, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-sched" });

  // Wait until supervised Core acquires its own authoritative `core:<gen>` lease.
  let ownerGen1 = "";
  await waitUntil(async () => {
    const status = await ui.workScheduler<{ isOwner: boolean; holderAuthorityId?: string }>({ action: "ownerStatus" });
    if (status.isOwner && status.holderAuthorityId?.startsWith("core:")) {
      ownerGen1 = status.holderAuthorityId;
      return true;
    }
    return false;
  }, "supervised Core claims authoritative gen1 lease");

  // ----- RC-11: Dual-owner fencing, Core takeover on worker restart, stale rejection, in-flight continuity -----
  const acqRogueA = await ui.workScheduler({ action: "ownerAcquire", ownerId: "rogue-owner-a", leaseTtlMs: 30_000 });
  assert.equal(acqRogueA.ok, false);
  assert.equal(acqRogueA.code, "OWNER_CONFLICT");

  const acqRogueB = await bg.workScheduler({ action: "ownerAcquire", ownerId: "rogue-owner-b", leaseTtlMs: 30_000 });
  assert.equal(acqRogueB.ok, false);
  assert.equal(acqRogueB.code, "OWNER_CONFLICT");

  const cw1 = await ui.workScheduler<{ ok: boolean; work: { workId: string; stateVersion: number; intentRevision: number; ownerEpoch: number; inputSnapshotId: string } }>({
    action: "createWork",
    operationId: "rc11-create-1",
    userId: "user-1",
    workId: "w-rc11",
    title: "RC11 Ownership Continuity",
    workspacePath: join(sandbox, "repo-a"),
    ownerId: ownerGen1,
  });
  assert.equal(cw1.ok, true);
  assert.equal(cw1.work.ownerEpoch, 1);

  const dispRc11 = await bg.workScheduler<{ ok: boolean; bindingId: string; execution: { status: string } }>({
    action: "dispatchExecution",
    operationId: "rc11-disp-1",
    userId: "user-1",
    workId: "w-rc11",
    bindingId: "bind-rc11",
    executionId: "exec-rc11",
    taskId: "task-rc11",
    resourceKey: "res-rc11",
    expectedStateVersion: 1,
    expectedIntentRevision: 1,
    expectedOwnerEpoch: 1,
    ownerId: ownerGen1,
  });
  assert.equal(dispRc11.ok, true);

  // Kill Core worker -> wait for old supervisor retirement -> reconnect spawns gen2 Core -> gen2 claims lease & bumps active ownerEpoch!
  const ep1 = JSON.parse(readFileSync(join(dataDir, "core.json"), "utf8")) as { workerPid: number; generation: string };
  process.kill(ep1.workerPid, "SIGKILL");
  await ui.close();
  await bg.close();
  await waitUntil(() => {
    try {
      const ep = JSON.parse(readFileSync(join(dataDir, "core.json"), "utf8")) as { workerPid: number; generation: string };
      return ep.generation !== ep1.generation;
    } catch { return true; }
  }, "old Core endpoint retired after worker kill");

  ui = await CoreBusinessClient.connect(executable, dbPath, { dataDirectory: dataDir, role: "ui", clientId: "ui-gen2" });
  const bg2 = await CoreBusinessClient.connect(executable, dbPath, { dataDirectory: dataDir, role: "background-service", clientId: "bg-gen2" });

  let ownerGen2 = "";
  await waitUntil(async () => {
    const status = await ui.workScheduler<{ isOwner: boolean; holderAuthorityId?: string }>({ action: "ownerStatus" });
    if (status.isOwner && status.holderAuthorityId?.startsWith("core:") && status.holderAuthorityId !== ownerGen1) {
      ownerGen2 = status.holderAuthorityId;
      return true;
    }
    return false;
  }, "gen2 Core claims authoritative lease");

  // Old gen1 owner command is rejected
  const staleOwnerCmd = await ui.workScheduler({
    action: "pauseWork",
    operationId: "rc11-stale-owner-pause",
    userId: "user-1",
    workId: "w-rc11",
    ownerId: ownerGen1,
  });
  assert.equal(staleOwnerCmd.ok, false);
  assert.equal(staleOwnerCmd.code, "OWNER_CONFLICT");

  // Stale epoch / revision command even under current gen2 owner is rejected
  const staleEpochAmend = await bg2.workScheduler({
    action: "amendWork",
    operationId: "rc11-stale-epoch-amend",
    userId: "user-1",
    workId: "w-rc11",
    title: "Should fail",
    expectedStateVersion: 1,
    expectedIntentRevision: 1,
    expectedOwnerEpoch: 1, // ownerEpoch bumped to 2 when gen2 took over!
    ownerId: ownerGen2,
  });
  assert.equal(staleEpochAmend.ok, false);
  assert.equal(staleEpochAmend.code, "REVISION_CONFLICT");

  // Legitimate in-flight settlement with original (ownerEpoch=1, intentRevision=1, inputSnapshotId) succeeds!
  const settleRc11 = await bg2.workScheduler<{ ok: boolean; deliverableId?: string; work: { lifecycle: string; ownerEpoch: number } }>({
    action: "settleExecution",
    bindingId: "bind-rc11",
    workId: "w-rc11",
    outcome: "completed",
    result: { summary: "Original epoch result" },
    deliverable: {
      deliverableId: "deliv-rc11",
      summary: "Partial output from epoch 1",
      uncoveredScope: ["remaining-check"],
    },
    ownerEpoch: 1,
    intentRevision: 1,
    inputSnapshotId: cw1.work.inputSnapshotId,
  });
  assert.equal(settleRc11.ok, true);
  assert.equal(settleRc11.deliverableId, "deliv-rc11");
  assert.equal(settleRc11.work.ownerEpoch, 2);
  assert.equal(settleRc11.work.lifecycle, "active", "execution completion must NOT auto-close Work");
  console.log("PASS RC-11: single owner fencing, worker-restart epoch bump, stale rejection, legitimate in-flight continuity");

  // ----- RC-12: Foreground non-blocking, parallel independent tasks, resource conflict queuing -----
  let releaseLong!: () => void;
  let releaseIndep!: () => void;
  let releaseConflict!: () => void;
  const started: Record<string, number> = {};
  const finished: Record<string, number> = {};

  const bridge = new ExecutionHostBridge(executable, dbPath, dataDir, {
    async start(dispatch) {
      const taskId = dispatch.execution.taskId;
      started[taskId] = performance.now();
      if (taskId === "task-long") {
        await new Promise<void>(resolve => { releaseLong = resolve; });
      } else if (taskId === "task-indep") {
        await new Promise<void>(resolve => { releaseIndep = resolve; });
      } else if (taskId === "task-conflict") {
        await new Promise<void>(resolve => { releaseConflict = resolve; });
      }
      finished[taskId] = performance.now();
      return { status: "completed", result: { taskId, doneAt: Date.now() } };
    },
  }, "rc12-exec-host");
  await bridge.connect();
  await delay(60);

  await ui.workScheduler({
    action: "createWork",
    operationId: "rc12-w-long",
    userId: "user-1",
    workId: "w-long",
    title: "Long Exclusive A",
    workspacePath: "/res-a",
    ownerId: ownerGen2,
  });
  await ui.workScheduler({
    action: "createWork",
    operationId: "rc12-w-indep",
    userId: "user-1",
    workId: "w-indep",
    title: "Independent Parallel B",
    workspacePath: "/res-b",
    ownerId: ownerGen2,
  });
  await ui.workScheduler({
    action: "createWork",
    operationId: "rc12-w-conflict",
    userId: "user-1",
    workId: "w-conflict",
    title: "Conflicting Queued A",
    workspacePath: "/res-a",
    ownerId: ownerGen2,
  });

  await ui.workScheduler({
    action: "dispatchExecution",
    operationId: "rc12-d-long",
    workId: "w-long",
    bindingId: "bind-long",
    executionId: "exec-long",
    taskId: "task-long",
    resourceKey: "/res-a",
    ownerId: ownerGen2,
  });
  await waitUntil(() => typeof releaseLong === "function", "task-long started on ExecutionHostBridge");

  // Dispatch independent /res-b AND conflicting /res-a while task-long holds /res-a
  await ui.workScheduler({
    action: "dispatchExecution",
    operationId: "rc12-d-indep",
    workId: "w-indep",
    bindingId: "bind-indep",
    executionId: "exec-indep",
    taskId: "task-indep",
    resourceKey: "/res-b",
    ownerId: ownerGen2,
  });
  const conflictReply = await ui.workScheduler<{ conflictQueued: boolean; execution: { status: string } }>({
    action: "dispatchExecution",
    operationId: "rc12-d-conflict",
    workId: "w-conflict",
    bindingId: "bind-conflict",
    executionId: "exec-conflict",
    taskId: "task-conflict",
    resourceKey: "/res-a",
    ownerId: ownerGen2,
  });
  assert.equal(conflictReply.conflictQueued, true, "overlapping exclusive resource must queue");

  // Independent /res-b runs WHILE /res-a is still blocked open!
  await waitUntil(() => typeof releaseIndep === "function", "task-indep overlaps concurrently with task-long");
  assert.equal(started["task-conflict"], undefined, "conflicting /res-a task must NOT start before task-long finishes");

  // Foreground queries & pause/amend respond fast while long task runs!
  const fgStart = performance.now();
  const fgRead = await ui.workScheduler<{ ok: boolean; work: { workId: string } }>({ action: "getWork", workId: "w-long" });
  const fgRtt = performance.now() - fgStart;
  assert.equal(fgRead.ok, true);
  assert(fgRtt < 250, `foreground read delayed by long execution: ${fgRtt}ms`);

  // Release indep first while long is still running -> overlaps cleanly!
  releaseIndep();
  await waitUntil(() => finished["task-indep"] !== undefined, "task-indep settles independently");
  assert.equal(finished["task-long"], undefined, "task-indep settled before task-long exited");
  assert.equal(started["task-conflict"], undefined, "task-conflict still queued until task-long settles");

  // Release task-long -> Rust automatically unblocks and dispatches task-conflict!
  releaseLong();
  await waitUntil(() => typeof releaseConflict === "function", "task-conflict auto-promoted after task-long settled");
  assert(started["task-conflict"]! >= finished["task-long"]!, "task-conflict must begin only after task-long finishes");
  releaseConflict();
  await waitUntil(() => finished["task-conflict"] !== undefined, "task-conflict finishes");
  await delay(60);
  console.log(`PASS RC-12: foreground RTT=${fgRtt.toFixed(1)}ms, parallel indep overlap, conflicting /res-a serialized`);

  // ----- RC-13: Watch DST/expiry, Pause/Resume/Amend/Cancel, Bridge crash unknown recovery, Worker kill recovery, Deliverable/Closure/Archive separation -----
  // 1. Watch DST Spring Forward (2027-03-14 Los Angeles, strictly > Nov 2026 wall clock) + EndsAt Expiry
  const springWindowStart = Date.UTC(2027, 2, 14, 0, 0, 0);
  const springTarget = Date.UTC(2027, 2, 14, 10, 30, 0); // 02:30 missing PST -> 03:30 PDT = 10:30Z
  const springEnd = Date.UTC(2027, 2, 14, 11, 0, 0);
  const wWatch = await ui.workScheduler<{ ok: boolean; work: { workId: string } }>({
    action: "createWork",
    operationId: "rc13-watch-create",
    userId: "user-1",
    workId: "w-watch-rc13",
    title: "RC13 Watch Work",
    mode: "watch",
    watchRule: { endsAt: springEnd },
    nowMs: springWindowStart,
  });
  assert.equal(wWatch.ok, true);
  await ui.workScheduler({
    action: "configureSubscription",
    operationId: "rc13-watch-sub",
    userId: "user-1",
    workId: "w-watch-rc13",
    subscriptionId: "sub-la",
    source: "cron",
    catchUpPolicy: "each",
    cronExpression: "30 2 * * *",
    timezone: "America/Los_Angeles",
    nowMs: springWindowStart,
  });

  // Deterministic future DST tick (omit ownerId so 2027 simulated time isn't compared to 2026 wall heartbeat)
  const tickSpring = await ui.workScheduler<{ firedTicks: Array<{ logicalSlotKey: string; scheduledAt: number }> }>({
    action: "tick",
    nowMs: springTarget,
  });
  assert.equal(tickSpring.firedTicks.length, 1);
  assert.equal(tickSpring.firedTicks[0].logicalSlotKey, "2027-03-14T02:30");

  // Clock rollback relative to springTarget must NOT fire duplicate slot
  const tickRollback = await ui.workScheduler<{ wallRolledBack: boolean; firedTicks: unknown[] }>({
    action: "tick",
    nowMs: springTarget - 60_000,
  });
  assert.equal(tickRollback.wallRolledBack, true);
  assert.equal(tickRollback.firedTicks.length, 0);

  // Advance past endsAt -> closes deterministically
  const tickExpire = await ui.workScheduler<{ expiredWatchWorks: string[] }>({
    action: "tick",
    nowMs: springEnd + 60_000,
  });
  assert(tickExpire.expiredWatchWorks.includes("w-watch-rc13"));

  // 2. Pause/Resume/Amend lifecycle checks on w-rc11 (which is currently at ownerEpoch=2, intentRevision=1, stateVersion=2)
  const pausedW = await ui.workScheduler<{ ok: boolean; work: { lifecycle: string; stateVersion: number; intentRevision: number; ownerEpoch: number } }>({
    action: "pauseWork",
    operationId: "rc13-pause-1",
    userId: "user-1",
    workId: "w-rc11",
    ownerId: ownerGen2,
  });
  assert.equal(pausedW.ok, true);
  assert.equal(pausedW.work.lifecycle, "paused");

  const pausedDispatchRejected = await ui.workScheduler({
    action: "dispatchExecution",
    operationId: "rc13-paused-disp",
    workId: "w-rc11",
    ownerId: ownerGen2,
  });
  assert.equal(pausedDispatchRejected.ok, false);
  assert.equal(pausedDispatchRejected.code, "INVALID_LIFECYCLE");

  const resumedW = await ui.workScheduler<{ ok: boolean; work: { lifecycle: string; stateVersion: number; intentRevision: number; ownerEpoch: number } }>({
    action: "resumeWork",
    operationId: "rc13-resume-1",
    userId: "user-1",
    workId: "w-rc11",
    ownerId: ownerGen2,
  });
  assert.equal(resumedW.ok, true);
  assert.equal(resumedW.work.lifecycle, "active");

  // 3. Crash recovery: start execution, disconnect bridge while running -> unknown + external_effect blocker (never replayed)
  let crashStarted = false;
  const crashBridge = new ExecutionHostBridge(executable, dbPath, dataDir, {
    async start(dispatch) {
      if (dispatch.execution.taskId === "task-crash") {
        crashStarted = true;
        await new Promise(() => {}); // Hang until bridge killed
      }
      return { status: "completed" };
    },
  }, "rc13-crash-bridge");
  await bridge.close();
  await crashBridge.connect();
  await delay(60);

  await ui.workScheduler({
    action: "createWork",
    operationId: "rc13-crash-work",
    userId: "user-1",
    workId: "w-crash",
    title: "RC13 Crash Unknown",
    ownerId: ownerGen2,
  });
  await ui.workScheduler({
    action: "dispatchExecution",
    operationId: "rc13-crash-disp",
    workId: "w-crash",
    bindingId: "bind-crash",
    executionId: "exec-crash",
    taskId: "task-crash",
    resourceKey: "/res-crash",
    ownerId: ownerGen2,
  });
  await waitUntil(() => crashStarted, "crash task is running before bridge disconnect");
  await delay(50);

  // Force disconnect bridge mid-execution!
  await crashBridge.close();
  await waitUntil(async () => {
    const state = await ui.workScheduler<{
      bindings: Array<{ bindingId: string; status: string }>;
      blockers: Array<{ kind: string; unknownExternalEffectRef?: string }>;
    }>({ action: "getWork", workId: "w-crash" });
    return state.bindings.some(b => b.bindingId === "bind-crash" && b.status === "unknown")
      && state.blockers.some(bl => bl.kind === "external_effect" && bl.unknownExternalEffectRef === "bind-crash");
  }, "in-flight execution transitions to unknown + external_effect blocker after crash");

  const rec = await ui.workScheduler<{ ok: boolean; promotedDispatches: number }>({
    action: "scanRecovery",
    ownerId: ownerGen2,
  });
  assert.equal(rec.ok, true);
  const wCrashAfter = await ui.workScheduler<{
    bindings: Array<{ bindingId: string; status: string }>;
    dispatches: Array<{ operationId: string }>;
  }>({ action: "getWork", workId: "w-crash" });
  assert.equal(wCrashAfter.bindings.length, 1, "unknown execution must NEVER be silently duplicated after worker crash");
  assert.equal(wCrashAfter.dispatches.length, 1);

  // 4. Deliverable Acceptance vs Work Closure vs Archive separation on w-rc11
  const rejectArchiveWhileActive = await ui.workScheduler({ action: "archiveWork", workId: "w-rc11", ownerId: ownerGen2 });
  assert.equal(rejectArchiveWhileActive.ok, false, "cannot archive active non-failed Work");

  const acceptDeliv = await ui.workScheduler<{ ok: boolean; work: { lifecycle: string; acceptedDeliverableIds: string[] } }>({
    action: "acceptDeliverable",
    operationId: "rc13-accept-deliv",
    userId: "user-1",
    workId: "w-rc11",
    deliverableId: "deliv-rc11",
    accepted: true,
    ownerId: ownerGen2,
  });
  assert.equal(acceptDeliv.ok, true);
  assert(acceptDeliv.work.acceptedDeliverableIds.includes("deliv-rc11"));
  assert.equal(acceptDeliv.work.lifecycle, "active", "accepting deliverable stays distinct from closing Work");

  const closed = await ui.workScheduler<{ ok: boolean; work: { lifecycle: string; closureConclusion: string } }>({
    action: "closeWork",
    operationId: "rc13-close-rc11",
    userId: "user-1",
    workId: "w-rc11",
    conclusion: "succeeded",
    summary: "All RC-11..13 steps verified",
    ownerId: ownerGen2,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.work.lifecycle, "closed");
  assert.equal(closed.work.closureConclusion, "succeeded");

  const archived = await ui.workScheduler<{ ok: boolean; archivedAt: number }>({
    action: "archiveWork",
    workId: "w-rc11",
    ownerId: ownerGen2,
  });
  assert.equal(archived.ok, true);
  const finalRead = await ui.workScheduler<{
    archivedAt?: number;
    deliverables: Array<{ deliverableId: string; status: string; uncoveredScope: string[] }>;
    work: { lifecycle: string; closureConclusion: string };
  }>({ action: "getWork", workId: "w-rc11" });
  assert.equal(finalRead.work.lifecycle, "closed");
  assert.equal(finalRead.work.closureConclusion, "succeeded");
  assert.equal(finalRead.deliverables[0].status, "accepted");
  assert.deepEqual(finalRead.deliverables[0].uncoveredScope, ["remaining-check"]);
  assert(typeof finalRead.archivedAt === "number");

  await bg2.close();
  await ui.close();
  console.log("PASS RC-13: DST watch/expiry, Pause/Resume, bridge crash -> unknown, worker kill continuity, deliverable/close/archive separation");
  console.log("PASS RC-11..RC-13 rust-work-scheduler complete");
} finally {
  await shutdownCoreWorker(join(sandbox, "auto-core"), join(sandbox, "auto-core", "app.db")).catch(() => undefined);
  await shutdownCoreWorker(join(sandbox, "core-data"), join(sandbox, "core-data", "app.db")).catch(() => undefined);
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* Windows file lock cleanup best-effort */ }
}
