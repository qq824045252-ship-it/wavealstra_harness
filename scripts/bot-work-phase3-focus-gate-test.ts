import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileResource, resourceOwnerKey, WorkResourceGate, type WorkResourceOwner } from "../src/main/agent/work/WorkResourceGate";
import { WorkToolResourcePolicy, type ToolResourceCall } from "../src/main/agent/work/WorkToolResourcePolicy";
import { WorkResourceRecovery, readResourceEffectEvidence, retryWorkResourceRecovery, hasPendingResourceRecoveryProbe, type ResourceRecoveryAttempt, type WorkResourceRecoveryPort } from "../src/main/agent/work/WorkResourceRecovery";
import { EXECUTION_ATTEMPT_SCHEMA, ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { prepareFileEffect, verifyFileEffect } from "../src/main/agent/durable/DurableEffectRecovery";
import { installWorkManagedResourceBoundary } from "../src/main/agent/work/WorkManagedResourceBoundary";
import { setManagedResourceBoundary, withManagedResource } from "../src/main/platform/managed-resources";
import { releaseHeldInput, setHeldInputReleaser, waitForHeldInputRelease, onHeldInputReleased, heldInputCleanupGeneration } from "../src/main/platform/computer-use/heldInput";

import { ComputerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";

const directory = mkdtempSync(join(tmpdir(), "work-phase3-focus-"));
const db = new Database(join(directory, "focus.db"));
const gate = new WorkResourceGate(db, { hostId: "focus-host" });
const owner = (taskId = "direct"): WorkResourceOwner => ({ taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: directory });
let effects = 0;
try {
  installWorkManagedResourceBoundary(gate, owner);
  let release = () => {};
  const barrier = new Promise<void>(done => { release = done; });
  let started = () => {};
  const startedBarrier = new Promise<void>(done => { started = done; });
  const operation = withManagedResource({ kind: "browser", action: "press", taskId: "a", readonly: false }, async () => {
    started(); await barrier; effects++; return "first actual managed effect";
  });
  await startedBarrier;
  await assert.rejects(withManagedResource({ kind: "desktop", action: "click", taskId: "b", readonly: false }, async () => { effects++; }), /等待共享资源/);
  assert.equal(effects, 0); release(); await operation; assert.equal(effects, 1);
  await withManagedResource({ kind: "desktop", action: "key_down", inputKey: "CTRL", taskId: "a", readonly: false }, async () => { effects++; });
  await withManagedResource({ kind: "desktop", action: "mouse_down_client", inputKey: "left", taskId: "a", readonly: false }, async () => { effects++; });
  await withManagedResource({ kind: "desktop", action: "key_up", inputKey: "CTRL", taskId: "a", readonly: false }, async () => { effects++; });
  await assert.rejects(withManagedResource({ kind: "browser", action: "click", taskId: "b", readonly: false }, async () => { effects++; }), /等待共享资源/);
  await withManagedResource({ kind: "desktop", action: "mouse_up_client", inputKey: "left", taskId: "a", readonly: false }, async () => { effects++; });
  await withManagedResource({ kind: "browser", action: "click", taskId: "b", readonly: false }, async () => { effects++; });
  assert.equal(effects, 6); assert.equal(gate.live().length, 0);

  let cleanupFinished = false;
  setHeldInputReleaser(async () => { await new Promise<void>(done => setImmediate(done)); cleanupFinished = true; });
  releaseHeldInput("owned-input"); assert.equal(cleanupFinished, false);
  const receipt = await waitForHeldInputRelease("owned-input");
  assert.equal(cleanupFinished, true); assert(receipt.queueDrained && receipt.inputReleased);
  await withManagedResource({ kind: "desktop", action: "key_down", inputKey: "CTRL", taskId: "cleanup-reuse", readonly: false }, async () => {});
  releaseHeldInput("cleanup-reuse"); await waitForHeldInputRelease("cleanup-reuse");
  assert.equal(gate.live().length, 0);
  await withManagedResource({ kind: "desktop", action: "key_down", inputKey: "CTRL", taskId: "cleanup-reuse", readonly: false }, async () => {});
  await withManagedResource({ kind: "desktop", action: "key_up", inputKey: "CTRL", taskId: "cleanup-reuse", readonly: false }, async () => {});
  assert.equal(gate.live().length, 0, "verified cleanup clears the cached held lease for the next real operation");

  const policy = new WorkToolResourcePolicy(gate, context => owner(context.taskId));
  const resourceCall = (id: string, action: string): ToolResourceCall => ({ call: { type: "toolCall", id, name: "computer_exec", arguments: { action, key: "CTRL" } },
    context: { taskId: "policy-cleanup", conversationId: "1", nativeTaskId: "9", taskRoot: directory }, sideEffect: true, paths: [] });
  const policyDown = resourceCall("first-down", "key_down"); assert.equal(policy.before(policyDown), undefined); policy.after(policyDown, "consumed");
  releaseHeldInput("policy-cleanup"); await waitForHeldInputRelease("policy-cleanup");
  const nextDown = resourceCall("next-down", "key_down"); assert.equal(policy.before(nextDown), undefined); policy.after(nextDown, "consumed");
  const policyUp = resourceCall("up", "key_up"); assert.equal(policy.before(policyUp), undefined); policy.after(policyUp, "consumed");
  assert.equal(gate.live().length, 0, "tool policy cache observes verified cleanup before the next native input");

  setHeldInputReleaser(async () => { throw new Error("queue or owned input cleanup failed"); });
  releaseHeldInput("failed-cleanup"); await assert.rejects(waitForHeldInputRelease("failed-cleanup"), /cleanup failed/);
  await assert.rejects(withManagedResource({ kind: "desktop", action: "press", taskId: "unknown", readonly: false }, async () => { effects++; throw new Error("effect occurred, lost receipt"); }), /lost receipt/);
  await assert.rejects(withManagedResource({ kind: "desktop", action: "press", taskId: "new", readonly: false }, async () => { effects++; }), /隔离/);
  assert.equal(effects, 7, "unknown original effect was never repeated or handed to another execution");
  // Reopen real storage after an effect + verifier checkpoint but before resource release.
  const recoveryPath = join(directory, "recovery.db"), effectPath = join(directory, "effect.txt");
  let recoveryDb = new Database(recoveryPath);
  recoveryDb.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks(id) VALUES ('native-task')"); recoveryDb.exec(EXECUTION_ATTEMPT_SCHEMA);
  const oldGate = new WorkResourceGate(recoveryDb, { hostId: "lost-host" });
  const namespace: WorkResourceOwner = { taskId: "native-task", durableStoreKey: "original-store", conversationId: "1", workspaceBinding: directory, workId: "recovery-work" };
  writeFileSync(effectPath, "before");
  const leaseResult = oldGate.acquire({ actionId: `resource:${resourceOwnerKey(namespace)}:9:file-call`, owner: namespace, resources: [fileResource(effectPath, "write")] });
  assert(leaseResult.ok);
  const attempts = new ExecutionAttemptRepository(recoveryDb), execution = { taskId: namespace.taskId, executionId: "durable:native-task:1:9", assistantMessageId: "assistant" };
  const attempt = attempts.beginDurable({ ...execution, toolCallId: "file-call", toolName: "write", target: "durable-tool:1:9", verifierId: "durable-file-content", verifierVersion: 1 });
  const intent = await prepareFileEffect({ type: "toolCall", id: "file-call", name: "write", arguments: { path: effectPath, content: "one external effect" } }, directory);
  assert(intent?.kind === "file"); writeFileSync(effectPath, "one external effect");
  const proof = await verifyFileEffect(intent); assert.equal(proof.status, "passed");
  attempts.update({ ...attempt, phase: "finished", status: "passed", finishedAt: Date.now(), verification: {
    ...execution, attemptId: attempt.id, verifierId: proof.verifierId, verifierVersion: 1, target: attempt.target, canonicalTarget: proof.canonicalTarget,
    status: "passed", expected: proof.expected, observed: proof.observed, checkedAt: proof.checkedAt,
  } });
  recoveryDb.close(); recoveryDb = new Database(recoveryPath);
  let recoveryClock = Date.now(), quiet = false, drained = false, inspections = 0;
  const recoveredGate = new WorkResourceGate(recoveryDb, { hostId: "new-host" });
  const recovery = new WorkResourceRecovery(recoveryDb, recoveredGate, {
    inspectExecution: async () => { inspections++; return { executionStopped: true, ownedChildrenStopped: quiet, receipt: "root-and-owned-graph-readback" }; },
    drainInput: async () => ({ queueDrained: drained, inputReleased: drained, receipt: drained ? "backend-queue-and-owned-input-receipt" : "" }),
    verifyEffect: async lease => readResourceEffectEvidence(recoveryDb, lease),
  }, () => recoveryClock);
  await recovery.recover(); assert.equal(recoveredGate.leaseState(leaseResult.lease), "quarantined");
  quiet = true; recoveryClock += 10_000; await recovery.recover(); assert.equal(recoveredGate.leaseState(leaseResult.lease), "quarantined");
  drained = true; recoveryClock += 10_000; await recovery.recover(); assert.equal(recoveredGate.leaseState(leaseResult.lease), "released");
  assert.equal(readFileSync(effectPath, "utf8"), "one external effect");
  recoveryDb.exec("CREATE TABLE recovered_callbacks(id TEXT PRIMARY KEY)");
  const rollbackLease = recoveredGate.acquire({ actionId: "rollback-recovery", owner: namespace, resources: [fileResource(effectPath, "read")] }); assert(rollbackLease.ok);
  recoveredGate.release(rollbackLease.lease, "unknown");
  const callbacks = {
    inspectExecution: async () => ({ executionStopped: true, ownedChildrenStopped: true, receipt: "quiet-graph" }),
    drainInput: async () => ({ queueDrained: true, inputReleased: true, receipt: "drained-backend" }),
    verifyEffect: async () => ({ known: true, receipt: "verified" }),
  };
  const rollbackRecovery = new WorkResourceRecovery(recoveryDb, recoveredGate, { ...callbacks, onRecovered: () => {
    recoveryDb.prepare("INSERT INTO recovered_callbacks VALUES ('same-business-transaction')").run(); throw new Error("business callback rollback");
  } }, () => recoveryClock);
  await rollbackRecovery.recover(); assert.equal(recoveredGate.leaseState(rollbackLease.lease), "quarantined");
  assert.equal(z.object({ count: z.number() }).parse(recoveryDb.prepare("SELECT count(*) count FROM recovered_callbacks").get()).count, 0);
  recoveryClock += 10_000;
  const committedRecovery = new WorkResourceRecovery(recoveryDb, recoveredGate, { ...callbacks,
    onRecovered: () => { recoveryDb.prepare("INSERT INTO recovered_callbacks VALUES ('same-business-transaction')").run(); },
  }, () => recoveryClock);
  await committedRecovery.recover(); assert.equal(recoveredGate.leaseState(rollbackLease.lease), "released");
  assert.equal(z.object({ count: z.number() }).parse(recoveryDb.prepare("SELECT count(*) count FROM recovered_callbacks").get()).count, 1);

  const unknownLease = recoveredGate.acquire({ actionId: "direct-unknown-action", owner: namespace, resources: [fileResource(effectPath, "write")] }); assert(unknownLease.ok);
  recoveredGate.release(unknownLease.lease, "unknown");
  const beforeLimit = inspections;
  for (let check = 0; check < 4; check++) { recoveryClock += 10_000; await recovery.recover(); }
  assert.equal(inspections - beforeLimit, 4, "four failed probes exhaust the automatic budget, not five");
  const beforeExhausted = inspections; recoveryClock += 10_000; await recovery.recover(); assert.equal(inspections, beforeExhausted);
  assert.equal(recoveredGate.leaseState(unknownLease.lease), "quarantined");
  const exhausted = recoveryState(recoveryDb, unknownLease.lease.token); assert.equal(exhausted.attempts, 4); assert(exhausted.exhausted_at !== null);
  assert(retryWorkResourceRecovery(recoveryDb, recoveredGate, { workId: "recovery-work", token: unknownLease.lease.token, expectedAttempts: 4, expectedExhaustedAt: exhausted.exhausted_at }));
  await recovery.recover(); assert.equal(inspections, beforeExhausted + 1);
  assert.equal(recoveryState(recoveryDb, unknownLease.lease.token).attempts, 5, "manual rearming never reuses an attempt identity");
  recoveryDb.close();
  for (const mode of ["direct", "policy"]) {
    const inputDb = new Database(":memory:"), inputGate = new WorkResourceGate(inputDb, { hostId: `unknown-${mode}` });
    installWorkManagedResourceBoundary(inputGate, owner); setHeldInputReleaser(async () => {});
    const inputPolicy = new WorkToolResourcePolicy(inputGate, context => owner(context.taskId));
    const action = async (id: string, name: string, key: string, unknown = false) => {
      if (mode === "direct") {
        const operation = withManagedResource({ kind: "desktop", taskId: "unknown-held", action: name, inputKey: key, readonly: false }, async () => { if (unknown) throw new Error("unknown click effect"); });
        if (unknown) await assert.rejects(operation, /unknown click/); else await operation;
      } else {
        const call: ToolResourceCall = { call: { type: "toolCall", id, name: "computer_exec", arguments: { action: name, key } },
          context: { taskId: "unknown-held", conversationId: "1", nativeTaskId: "9", taskRoot: directory }, sideEffect: true, paths: [] };
        assert.equal(inputPolicy.before(call), undefined); inputPolicy.after(call, unknown ? "unknown" : "consumed");
      }
    };
    await action("down-ctrl", "key_down", "CTRL"); await action("down-shift", "key_down", "SHIFT");
    await action("unknown-click", "click_client", "", true); await action("up-ctrl", "key_up", "CTRL");
    releaseHeldInput("unknown-held"); await waitForHeldInputRelease("unknown-held");
    const retained = inputGate.live(); assert.equal(retained.length, 1); assert.equal(inputGate.leaseState(retained[0]!), "quarantined");
    await assert.rejects(withManagedResource({ kind: "desktop", taskId: "other", action: "click", readonly: false }, async () => {}), /隔离/);
    inputDb.close();
  }
  await recoveryTimeoutRegressions();
  console.log("Phase3 persisted resource recovery passed: original native/file verifier checkpoint, restart quarantine, owned-child and backend barriers, one actual effect, bounded unknown and explicit retry.");
  console.log("Phase3 focus contracts passed: shared browser+desktop resources, direct-entry exclusion, multiple held controls, awaited cleanup failure and unknown quarantine. Real desktop is a separate test.");
} finally {
  setManagedResourceBoundary(undefined); setHeldInputReleaser(undefined); db.close(); rmSync(directory, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function recoveryState(database: Database.Database, token: number) {
  return z.object({ attempts: z.number(), exhausted_at: z.number().nullable(), receipt_json: z.string().nullable() })
    .parse(database.prepare("SELECT attempts,exhausted_at,receipt_json FROM work_resource_recovery WHERE token=?").get(token));
}
function nextTurn() { return new Promise<void>(done => setImmediate(done)); }

async function recoveryTimeoutRegressions() {
  const quiet = { executionStopped: true, ownedChildrenStopped: true, receipt: "original-tree-quiet" };
  const drained = { queueDrained: true, inputReleased: true, receipt: "original-backend-drained" };
  const known = { known: true, receipt: "original-effect-read-back" };
  const callbacks: WorkResourceRecoveryPort = { inspectExecution: async () => quiet, drainInput: async () => drained, verifyEffect: async () => known };
  for (const phase of ["inspectExecution", "drainInput", "verifyEffect"] as const) {
    const database = new Database(":memory:");
    let clock = 10_000, completed = 0, calls = 0;
    const resourceGate = new WorkResourceGate(database, { hostId: `timeout-${phase}`, now: () => clock });
    const admission = resourceGate.acquire({ actionId: phase, owner: { ...owner(phase), workId: phase },
      resources: [{ kind: "desktop", key: "focus:desktop", scope: "host", mode: "write" }] }); assert(admission.ok);
    resourceGate.release(admission.lease, "unknown");
    const late = deferred<typeof quiet & typeof drained & typeof known>();
    let context: ResourceRecoveryAttempt | undefined;
    const probe = (recovery: ResourceRecoveryAttempt) => {
      calls++; context = recovery;
      return calls === 1 ? late.promise : Promise.resolve({ ...quiet, ...drained, ...known });
    };
    const port: WorkResourceRecoveryPort = { ...callbacks, onRecovered: () => { completed++; } };
    if (phase === "inspectExecution") port.inspectExecution = (_lease, recovery) => probe(recovery);
    if (phase === "drainInput") port.drainInput = (_lease, _execution, recovery) => probe(recovery);
    if (phase === "verifyEffect") port.verifyEffect = (_lease, recovery) => probe(recovery);
    const runner = new WorkResourceRecovery(database, resourceGate, port, () => clock, { probeTimeoutMs: 15 });
    await runner.recover();
    assert(context); const first = context;
    assert.equal(first.token, admission.lease.token); assert.equal(first.attempt, 1); assert(first.signal.aborted);
    assert(hasPendingResourceRecoveryProbe(database, admission.lease.token));
    assert.equal(resourceGate.leaseState(admission.lease), "quarantined"); assert.equal(completed, 0);
    clock += 10_000;
    await new WorkResourceRecovery(database, resourceGate, port, () => clock, { probeTimeoutMs: 15 }).recover();
    assert.equal(calls, 1, `${phase}: an unresolved original probe blocks replacement runners`);
    // Unrelated in-memory databases may use the same SQLite token without sharing a fence.
    const isolated = new Database(":memory:");
    const isolatedGate = new WorkResourceGate(isolated, { hostId: "isolated" });
    const isolatedAdmission = isolatedGate.acquire({ actionId: "isolated", owner: owner("isolated"),
      resources: [{ kind: "desktop", key: "focus:desktop", scope: "host", mode: "write" }] }); assert(isolatedAdmission.ok);
    isolatedGate.release(isolatedAdmission.lease, "unknown");
    await new WorkResourceRecovery(isolated, isolatedGate, callbacks).recover();
    assert.equal(isolatedGate.leaseState(isolatedAdmission.lease), "released"); isolated.close();
    late.resolve({ ...quiet, ...drained, ...known }); await nextTurn();
    assert(!hasPendingResourceRecoveryProbe(database, admission.lease.token));
    assert.equal(completed, 0, `${phase}: a late success must not settle the old attempt`);
    assert.throws(() => first.assertCurrent(), /超时/);
    await runner.recover();
    assert.equal(completed, 1); assert.equal(resourceGate.leaseState(admission.lease), "released");
    assert.equal(recoveryState(database, admission.lease.token).attempts, 2);
    database.close();
  }

  // A genuinely non-cooperative native drain is allowed to finish its old effect,
  // but no replacement drain, observer settlement or takeover may race it.
  const path = join(directory, "late-drain.db");
  const database = new Database(path);
  let clock = 10_000, nativeReleases = 0, drainCalls = 0, completed = 0, notifications = 0;
  const namespace = { ...owner("late-input"), workId: "late-input-work" };
  const resourceGate = new WorkResourceGate(database, { hostId: "same-host", now: () => clock });
  const admitted = resourceGate.acquire({ actionId: "late-input", owner: namespace, leaseMs: 100,
    resources: [{ kind: "desktop", key: "host-session", scope: "physical-input", mode: "write" }] }); assert(admitted.ok);
  resourceGate.markInputHeld(admitted.lease, ["key:CTRL"]); clock += 101;
  installWorkManagedResourceBoundary(resourceGate, () => namespace);
  database.prepare("INSERT INTO work_resource_recovery(token,attempts,next_at) VALUES (?,3,0)").run(admitted.lease.token);
  const late = deferred<void>(); let oldContext: ResourceRecoveryAttempt | undefined;
  const stopListening = onHeldInputReleased(() => { notifications++; });
  const oldGeneration = heldInputCleanupGeneration(namespace.taskId);
  setHeldInputReleaser(async (taskId, recovery) => {
    assert.equal(taskId, namespace.taskId); assert(recovery); drainCalls++;
    if (drainCalls === 1) { oldContext = recovery; await late.promise; }
    nativeReleases++; // deliberately ignores AbortSignal to exercise the retained barrier
  });
  const coordinator = new ComputerUseRunCoordinator();
  const port: WorkResourceRecoveryPort = { ...callbacks,
    drainInput: (lease, _execution, recovery) => coordinator.cancelAndWait(lease.owner.taskId, recovery),
    onRecovered: () => { completed++; },
  };
  await new WorkResourceRecovery(database, resourceGate, port, () => clock, { probeTimeoutMs: 15 }).recover();
  const exhausted = recoveryState(database, admitted.lease.token);
  assert.equal(exhausted.attempts, 4); assert(exhausted.exhausted_at !== null); assert(oldContext?.signal.aborted);
  const otherDb = new Database(path), otherGate = new WorkResourceGate(otherDb, { hostId: "same-host", now: () => clock });
  const retry = { workId: namespace.workId, token: admitted.lease.token, expectedAttempts: 4, expectedExhaustedAt: exhausted.exhausted_at };
  assert(hasPendingResourceRecoveryProbe(otherDb, admitted.lease.token), "reopened persistent storage shares the original native fence");
  assert.equal(retryWorkResourceRecovery(otherDb, otherGate, retry), false, "human confirmation cannot outrun a hanging native drain");
  clock += 10_000;
  const restarted = new WorkResourceRecovery(otherDb, otherGate, port, () => clock, { probeTimeoutMs: 15 });
  await restarted.recover(); assert.equal(drainCalls, 1); assert.equal(nativeReleases, 0);
  assert.equal(otherGate.acquire({ actionId: "new-owner", owner: owner("next-owner"), resources: admitted.lease.resources }).ok, false);
  late.resolve(); await nextTurn();
  assert.equal(nativeReleases, 1); assert.equal(completed, 0); assert.equal(notifications, 0);
  assert.equal(heldInputCleanupGeneration(namespace.taskId), oldGeneration, "cancelled cleanup cannot clear another execution's held-input generation");
  assert.equal(resourceGate.leaseState(admitted.lease), "quarantined", "late cleanup observer cannot bypass effect verification");
  assert(!hasPendingResourceRecoveryProbe(otherDb, admitted.lease.token)); database.close();
  assert(retryWorkResourceRecovery(otherDb, otherGate, retry)); await restarted.recover();
  assert.equal(drainCalls, 2); assert.equal(nativeReleases, 2); assert.equal(completed, 1); assert.equal(notifications, 0);
  assert.equal(recoveryState(otherDb, admitted.lease.token).attempts, 5, "restart plus manual rearm preserves monotonic attempts");
  assert.equal(otherGate.leaseState(admitted.lease), "released"); otherDb.close(); stopListening();

  // Revoked authority cannot advance to the mutating cleanup stage or persist a receipt.
  const revokedDb = new Database(":memory:"); let authority = true, drainedAfterLoss = 0;
  const revokedGate = new WorkResourceGate(revokedDb, { hostId: "revoked-host", isAuthority: () => authority });
  const revoked = revokedGate.acquire({ actionId: "revoked", owner: owner("revoked"), resources: [{ kind: "desktop", key: "focus:desktop", scope: "host", mode: "write" }] }); assert(revoked.ok);
  revokedGate.release(revoked.lease, "unknown");
  let revokedContext: ResourceRecoveryAttempt | undefined;
  const revokedRunner = new WorkResourceRecovery(revokedDb, revokedGate, { ...callbacks,
    inspectExecution: async (_lease, recovery) => { revokedContext = recovery; authority = false; return quiet; },
    drainInput: async () => { drainedAfterLoss++; return drained; },
  });
  await assert.rejects(revokedRunner.recover(), /authority/);
  assert(revokedContext?.signal.aborted); assert.equal(drainedAfterLoss, 0);
  assert.equal(revokedGate.leaseState(revoked.lease), "quarantined"); assert.equal(recoveryState(revokedDb, revoked.lease.token).receipt_json, null);
  assert(!hasPendingResourceRecoveryProbe(revokedDb, revoked.lease.token)); revokedDb.close();

  // A synchronous queue refusal replaces any cached success rather than proving takeover.
  setHeldInputReleaser(async () => {}); releaseHeldInput("sync-refusal"); await waitForHeldInputRelease("sync-refusal");
  setHeldInputReleaser(() => { throw new Error("synchronous native queue refusal"); });
  releaseHeldInput("sync-refusal"); await assert.rejects(waitForHeldInputRelease("sync-refusal"), /queue refusal/);
  console.log("Phase3 recovery timeout regressions passed: all probe deadlines abort, late native drains retain fencing, observer receipts stay scoped, persistent attempts remain monotonic, authority loss fails closed.");
}
