import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileResource, resourceOwnerKey, WorkResourceGate, type WorkResourceOwner } from "../src/main/agent/work/WorkResourceGate";
import { WorkToolResourcePolicy, type ToolResourceCall } from "../src/main/agent/work/WorkToolResourcePolicy";
import { WorkResourceRecovery, readResourceEffectEvidence } from "../src/main/agent/work/WorkResourceRecovery";
import { EXECUTION_ATTEMPT_SCHEMA, ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { prepareFileEffect, verifyFileEffect } from "../src/main/agent/durable/DurableEffectRecovery";
import { installWorkManagedResourceBoundary } from "../src/main/agent/work/WorkManagedResourceBoundary";
import { setManagedResourceBoundary, withManagedResource } from "../src/main/platform/managed-resources";
import { releaseHeldInput, setHeldInputReleaser, waitForHeldInputRelease } from "../src/main/platform/computer-use/heldInput";

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
  for (let check = 0; check < 5; check++) { recoveryClock += 10_000; await recovery.recover(); }
  const beforeExhausted = inspections; recoveryClock += 10_000; await recovery.recover(); assert.equal(inspections, beforeExhausted);
  assert.equal(recoveredGate.leaseState(unknownLease.lease), "quarantined");
  recovery.retryWork("recovery-work"); await recovery.recover(); assert.equal(inspections, beforeExhausted + 1);
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
  console.log("Phase3 persisted resource recovery passed: original native/file verifier checkpoint, restart quarantine, owned-child and backend barriers, one actual effect, bounded unknown and explicit retry.");
  console.log("Phase3 focus contracts passed: shared browser+desktop resources, direct-entry exclusion, multiple held controls, awaited cleanup failure and unknown quarantine. Real desktop is a separate test.");
} finally {
  setManagedResourceBoundary(undefined); setHeldInputReleaser(undefined); db.close(); rmSync(directory, { recursive: true, force: true });
}
