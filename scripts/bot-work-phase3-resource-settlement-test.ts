import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { fileResource, resourceOwnerKey, type WorkResourceOwner } from "../src/main/agent/work/WorkResourceGate";
import { WorkResourceRecovery, readResourceEffectEvidence, readResourceNotStartedEvidence } from "../src/main/agent/work/WorkResourceRecovery";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { prepareFileEffect, verifyFileEffect } from "../src/main/agent/durable/DurableEffectRecovery";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto, type WorkProjectionDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase3-resource-settlement-"));
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });

async function assertExactNotStartedRecovery(): Promise<void> {
  for (const variant of ["exact", "unknown-effect", "forged-verifier", "wrong-task", "wrong-attempt", "wrong-call", "ambiguous-attempt"] as const) {
    const databasePath = join(root, `not-started-${variant}.db`), taskId = `not-started-${variant}`;
    let db = new AppDatabase(databasePath);
    let bots = new BotRegistry(db.connection);
    bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "not-started fixture", authorization: DESKTOP_USER_GRANTS });
    let works = new WorkService(db.connection, { bots, resourceHostId: "original-host" });
    try {
      const work = unwrap(works.createWork(user, { operationId: `create-${variant}`, title: variant,
        inputSnapshotId: `input-${variant}`, workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
      db.upsertTask({ id: taskId, title: variant, cwd: root, updatedAt: Date.now() });
      unwrap(works.dispatchExecution(user, { operationId: `dispatch-${variant}`, workId: work.workId, botId: DEFAULT_BOT_ID, taskId,
        durableStoreKey: `store:${variant}`, conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read", "workspace:write"] }));
      const binding = works.repo.bindingForTask(taskId)!;
      const owner: WorkResourceOwner = { taskId, workId: work.workId, bindingId: binding.bindingId,
        durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding };
      const nativeTaskId = "10", callId = "rejected:command", operationId = `tool:1:${nativeTaskId}:${callId}`;
      works.repo.updateBinding({ ...binding, status: "running", attemptId: `active-parent-${variant}`, submittedAt: Date.now() });
      const actor = { kind: "worker" as const, botId: binding.botId, bindingId: binding.bindingId };
      const original = works.admitNewAction(actor, { admissionId: `denied-${variant}`, workId: work.workId,
        bindingId: binding.bindingId, operationId, actionKind: "workspace:write" });
      const unrelated = works.admitNewAction(actor, { admissionId: `other-${variant}`, workId: work.workId,
        bindingId: binding.bindingId, operationId: "tool:1:11:unrelated", actionKind: "workspace:write" });
      assert(original.ok && unrelated.ok);
      const granted = works.resourceGate.acquire({ actionId: `resource:${resourceOwnerKey(owner)}:${nativeTaskId}:${callId}`, owner,
        resources: [{ kind: "host", scope: "local-host", key: "unclassified-tool", mode: "write" }] });
      assert(granted.ok); const lease = granted.lease;
      const attempts = new ExecutionAttemptRepository(db.connection);
      const context = { taskId, executionId: `durable:${taskId}:1:${nativeTaskId}`, assistantMessageId: "guard-observation" };
      const attempt = attempts.beginDurable({ ...context, toolCallId: callId, toolName: "bash", target: `durable-tool:1:${nativeTaskId}`,
        verifierId: "durable-resource-admission", verifierVersion: 1 });
      attempts.update({ ...attempt, status: "failed", phase: "finished", causeCode: "resource-admission-denied", finishedAt: Date.now(),
        verification: { ...context, attemptId: attempt.id, verifierId: "durable-resource-admission", verifierVersion: 1,
          target: attempt.target, canonicalTarget: attempt.target, status: "failed", expected: { admitted: true },
          observed: { admitted: false, effect: "not_started" }, checkedAt: Date.now() } });
      // Deliberately mismatched ledger contents exercise proof rejection, not any
      // user's database. A failed tool/error string alone must never grant release.
      const row = z.object({ record_json: z.string() }).parse(db.connection.prepare("SELECT record_json FROM execution_attempts WHERE id=?").get(attempt.id));
      const record = JSON.parse(row.record_json);
      if (variant === "unknown-effect") record.verification.observed.effect = "unknown";
      if (variant === "forged-verifier") record.verification.verifierId = "model-claimed-not-started";
      if (variant === "wrong-task") record.verification.taskId = "another-task";
      if (variant === "wrong-attempt") record.verification.attemptId = "another-attempt";
      if (variant === "wrong-call") record.toolCallId = "another-call";
      db.connection.prepare("UPDATE execution_attempts SET record_json=? WHERE id=?").run(JSON.stringify(record), attempt.id);
      if (variant === "ambiguous-attempt") attempts.begin({ ...context, toolCallId: callId, toolName: "bash", target: attempt.target });
      assert.equal(readResourceNotStartedEvidence(db.connection, lease).known, variant === "exact");
      assert(works.settleAdmission(original.admission.admissionId, "unknown", "legacy missing guard settlement").ok);
      works.resourceGate.release(lease, "unknown", "legacy guard rejection incorrectly isolated");
      const originalBlocker = works.repo.listOpenBlockers(work.workId).find(item => item.unknownExternalEffectRef === original.admission.admissionId)!;
      assert(originalBlocker);
      const beforeBinding = works.repo.getBinding(binding.bindingId)!;
      const beforeBudget = works.getWork(work.workId)!.budget;
      const clock = Date.now();
      db.connection.prepare("INSERT INTO work_resource_recovery(token,attempts,next_at,exhausted_at,reason) VALUES (?,4,?,?,?)")
        .run(lease.token, clock + 60_000, clock, "parent still active; automatic attempts exhausted");
      // Read the proof from disk after restart, while the parent is still active.
      db.close(); db = new AppDatabase(databasePath); bots = new BotRegistry(db.connection);
      works = new WorkService(db.connection, { bots, resourceHostId: "recovered-host" });
      let parentProbes = 0, callbacks = 0;
      const recovery = new WorkResourceRecovery(db.connection, works.resourceGate, {
        transaction: fn => works.transaction(fn),
        inspectExecution: async () => { parentProbes++; return { executionStopped: false, ownedChildrenStopped: false, receipt: "parent-still-running" }; },
        drainInput: async () => { throw new Error("must not infer input cleanup for a running action"); },
        verifyEffect: async () => { throw new Error("must use exact durable not-started evidence only"); },
        onRecovered: originalLease => { callbacks++; works.finalizeRecoveredResource(originalLease); },
      }, () => clock);
      await recovery.recover();
      assert.equal(parentProbes, 0, "exact not-started proof does not require the whole parent to finish; exhausted nonproof stays fenced");
      assert.equal(callbacks, variant === "exact" ? 1 : 0);
      assert.equal(works.resourceGate.leaseState(lease), variant === "exact" ? "released" : "quarantined");
      assert.equal(works.repo.getAdmission(original.admission.admissionId)?.state, variant === "exact" ? "released" : "unknown");
      assert.equal(works.repo.getAdmission(unrelated.admission.admissionId)?.state, "admitted", "only the original admission can settle");
      assert.equal(works.repo.getBlocker(originalBlocker.blockerId)?.status, variant === "exact" ? "cleared" : "open");
      assert.deepEqual(works.repo.getBinding(binding.bindingId), beforeBinding, "recovery does not settle, stop or restart the active parent");
      assert.deepEqual(works.getWork(work.workId)!.budget, beforeBudget);
      const saved = z.object({ attempts: z.number(), exhausted_at: z.number().nullable(), receipt_json: z.string().nullable() })
        .parse(db.connection.prepare("SELECT attempts,exhausted_at,receipt_json FROM work_resource_recovery WHERE token=?").get(lease.token));
      assert.equal(saved.attempts, 4, "exact receipt reconciliation does not spend/rearm the whole-execution probe budget");
      assert.equal(saved.exhausted_at === null, variant === "exact");
      if (variant === "exact") assert.equal(JSON.parse(saved.receipt_json!).notStarted, true);
      await recovery.recover(); assert.equal(callbacks, variant === "exact" ? 1 : 0, "settlement is idempotent");
      console.log(`PASS exact not-started ${variant}: exhausted restart recovery, parent retained, exact admission only`);
    } finally { db.close(); }
  }
}

async function assertUserEffectReview(): Promise<void> {
  for (const conclusion of ["not_occurred", "occurred"] as const) {
    const path = join(root, `user-review-${conclusion}.db`), taskId = `user-review-${conclusion}`;
    let db = new AppDatabase(path), bots = new BotRegistry(db.connection);
    bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "review fixture", authorization: DESKTOP_USER_GRANTS });
    let works = new WorkService(db.connection, { bots, resourceHostId: "host" });
    try {
      const created = unwrap(works.createWork(user, { operationId: "create", title: conclusion, inputSnapshotId: "snapshot", workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
      db.upsertTask({ id: taskId, title: conclusion, cwd: root, updatedAt: Date.now() });
      unwrap(works.dispatchExecution(user, { operationId: "dispatch", workId: created.workId, botId: DEFAULT_BOT_ID,
        taskId, durableStoreKey: path + ".native", conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:write"] }));
      const binding = works.repo.bindingForTask(taskId)!;
      const owner: WorkResourceOwner = { taskId, workId: created.workId, bindingId: binding.bindingId, durableStoreKey: binding.durableStoreKey,
        conversationId: binding.conversationId, workspaceBinding: root };
      const admitted = works.admitNewAction({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
        admissionId: "effect", workId: created.workId, bindingId: binding.bindingId, operationId: "tool:1:10:call", actionKind: "workspace:write" });
      assert(admitted.ok);
      const acquired = works.resourceGate.acquire({ actionId: `resource:${resourceOwnerKey(owner)}:10:call`, owner,
        resources: [{ kind: "host", scope: "local-host", key: "unclassified-tool", mode: "write" }] });
      assert(acquired.ok); const lease = acquired.lease;
      works.resourceGate.release(lease, "unknown", "legacy original effect missing");
      works.settleAdmission(admitted.admission.admissionId, "unknown", "original receipt missing");
      const exhaustedAt = Date.now();
      db.connection.prepare("INSERT INTO work_resource_recovery(token,attempts,next_at,exhausted_at,reason) VALUES (?,4,0,?,?)")
        .run(lease.token, exhaustedAt, "original effect unknown");
      const params = { operationId: "review", workId: created.workId, token: lease.token, actionId: lease.actionId,
        expectedAttempts: 4, expectedExhaustedAt: exhaustedAt, expectedReadyAt: 0, conclusion, evidence: "Checked the exact original workspace files and operation effects.",
        confirmScopeReviewed: true as const, confirmStopOriginal: true as const, versionGuard: guard(works.getWork(created.workId)!) };
      assert(!works.reconcileResourceEffect({ kind: "user", userId: "other", grants: DESKTOP_USER_GRANTS }, params).ok);
      assert(!works.reconcileResourceEffect(user, { ...params, actionId: "different" }).ok);
      assert(!works.reconcileResourceEffect(user, { ...params, expectedAttempts: 3 }).ok);
      assert(!works.reconcileResourceEffect(user, params).ok, "cannot attest an effect before native execution has stopped");
      const prepared = works.prepareResourceEffect(user, { operationId: "prepare-review", workId: created.workId, token: lease.token,
        actionId: lease.actionId, expectedAttempts: 4, expectedExhaustedAt: exhaustedAt, confirmStopOriginal: true,
        versionGuard: guard(works.getWork(created.workId)!) });
      assert(prepared.ok);
      assert(works.repo.getBinding(binding.bindingId)?.invalidatedAt, "fences new original tools before stop");
      let stopCalls = 0;
      const preparationRecovery = new WorkResourceRecovery(db.connection, works.resourceGate, {
        transaction: fn => works.transaction(fn), stopOriginal: async () => { stopCalls++; },
        inspectExecution: async () => ({ executionStopped: true, ownedChildrenStopped: true, receipt: "stopped-execution-proof" }),
        drainInput: async () => ({ queueDrained: true, inputReleased: true, receipt: "input-released-proof" }),
        verifyEffect: async () => { throw new Error("prepare cannot reconcile unknown effect"); },
      });
      await preparationRecovery.recover(); assert.equal(stopCalls, 1);
      assert.equal(works.resourceGate.leaseState(lease), "quarantined");
      const readiness = works.getProjection(created.workId)!.phase3!.resourceRecoveries[0]!;
      assert(readiness.effectReviewPrepared?.readyAt !== undefined);
      params.expectedAttempts = readiness.attempts; params.expectedExhaustedAt = readiness.exhaustedAt!;
      params.expectedReadyAt = readiness.effectReviewPrepared.readyAt;
      params.versionGuard = guard(works.getWork(created.workId)!);
      db.connection.exec("CREATE TRIGGER reject_user_review BEFORE UPDATE ON works BEGIN SELECT RAISE(ABORT,'review crash'); END");
      assert.throws(() => works.reconcileResourceEffect(user, params), /review crash/);
      assert.equal(db.connection.prepare("SELECT 1 FROM work_resource_effect_reviews").get(), undefined, "audit and rearm rollback together");
      db.connection.exec("DROP TRIGGER reject_user_review");
      const result = works.reconcileResourceEffect(user, params); assert(result.ok);
      assert.equal(works.resourceGate.leaseState(lease), "quarantined", "user evidence alone cannot release running effects");
      const replay = works.reconcileResourceEffect(user, params); assert(replay.ok && replay.replayed);
      assert.equal(readResourceNotStartedEvidence(db.connection, lease).known, false, "human conclusion is not a fabricated native proof");
      assert(readResourceEffectEvidence(db.connection, lease).known);
      db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection);
      works = new WorkService(db.connection, { bots, resourceHostId: "restart" });
      let quiet = conclusion === "occurred", inputReleased = false, clock = Date.now() + 10000, stops = 0;
      const recovery = new WorkResourceRecovery(db.connection, works.resourceGate, {
        transaction: fn => works.transaction(fn),
        stopOriginal: async () => { stops++; },
        inspectExecution: async () => ({ executionStopped: quiet, ownedChildrenStopped: quiet, receipt: "native-graph-proof" }),
        drainInput: async () => ({ queueDrained: inputReleased, inputReleased, receipt: "native-cleanup-proof" }),
        verifyEffect: async original => readResourceEffectEvidence(db.connection, original),
        onRecovered: original => works.finalizeRecoveredResource(original),
      }, () => clock);
      await recovery.recover(); assert.equal(stops, 0, "final review does not issue a new stop after user inspection");
      assert.equal(works.resourceGate.leaseState(lease), "quarantined", "active children still fence a human reviewed effect");
      quiet = true; inputReleased = true; clock += 10000; await recovery.recover();
      assert.equal(works.resourceGate.leaseState(lease), "quarantined", "later quiet probe must not resurrect stale human evidence");
      assert.equal(readResourceEffectEvidence(db.connection, lease).known, false);
      assert.equal(db.connection.prepare("SELECT 1 FROM work_resource_effect_preparations WHERE token=?").get(lease.token), undefined);
      const invalidated = works.getProjection(created.workId)!.phase3!.resourceRecoveries[0]!;
      assert(invalidated.exhaustedAt !== undefined);
      assert(!works.reconcileResourceEffect(user, { ...params, operationId: "stale-review",
        expectedAttempts: invalidated.attempts, expectedExhaustedAt: invalidated.exhaustedAt!,
        versionGuard: guard(works.getWork(created.workId)!) }).ok, "old readyAt cannot attest after failed quiet/input probe");
      assert(works.prepareResourceEffect(user, { operationId: "renew-prepare", workId: created.workId, token: lease.token,
        actionId: lease.actionId, expectedAttempts: invalidated.attempts, expectedExhaustedAt: invalidated.exhaustedAt!,
        confirmStopOriginal: true, versionGuard: guard(works.getWork(created.workId)!) }).ok);
      clock = Date.now(); await recovery.recover();
      assert.equal(stops, 1, "new inspection requires a newly authorized stop and quiet proof");
      const renewed = works.getProjection(created.workId)!.phase3!.resourceRecoveries[0]!;
      assert(renewed.effectReviewPrepared?.readyAt !== undefined);
      assert(works.reconcileResourceEffect(user, { ...params, operationId: "renew-review",
        expectedAttempts: renewed.attempts, expectedExhaustedAt: renewed.exhaustedAt!,
        expectedReadyAt: renewed.effectReviewPrepared.readyAt, versionGuard: guard(works.getWork(created.workId)!) }).ok);
      clock = Date.now(); await recovery.recover();
      assert.equal(stops, 1, "fresh final review is not followed by another stop");
      assert.equal(works.resourceGate.leaseState(lease), "released");
      assert.equal(works.repo.getAdmission(admitted.admission.admissionId)?.state, conclusion === "not_occurred" ? "released" : "consumed");
      assert(!works.repo.listOpenBlockers(created.workId).some(item => item.unknownExternalEffectRef === admitted.admission.admissionId));
      assert.equal(works.repo.listBindings(created.workId).length, 1, "no business replay");
      works.repo.updateBinding({ ...works.repo.getBinding(binding.bindingId)!, status: "stopped", settledAt: Date.now() });
      const nextWork = unwrap(works.createWork(user, { operationId: "next-create", title: "new write after reconciliation",
        inputSnapshotId: "next-input", workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
      db.upsertTask({ id: "next-task", title: "next", cwd: root, updatedAt: Date.now() });
      unwrap(works.dispatchExecution(user, { operationId: "next-dispatch", workId: nextWork.workId, botId: DEFAULT_BOT_ID,
        taskId: "next-task", durableStoreKey: "next-store", conversationId: "2", workspaceBinding: root, delegatedScope: ["workspace:write"] }));
      let submissions = 0;
      const adapter = new WorkExecutionAdapter(works, {
        resourceBoundary: "host-action-gate", prepare: async () => { throw new Error("already prepared"); },
        find: async () => undefined,
        submit: async candidate => { submissions++; return { taskId: candidate.taskId, operationId: candidate.operationId, submissionId: 2, status: "done" }; },
        inspect: async () => ({ status: "completed", summary: "transport accepted", hasWriteConflicts: false, artifactRefs: [], usageTokens: 0 }),
        stop: async () => {},
      }, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
      await adapter.flush(); await adapter.close();
      assert.equal(submissions, 1, "cleared exact external effect no longer silently blocks new pending dispatch");
      const before = works.getWork(created.workId)!.stateVersion; await recovery.recover();
      assert.equal(works.getWork(created.workId)!.stateVersion, before);
      console.log(`PASS audited user effect ${conclusion}: identity/CAS/rollback/restart/quiet proof/exact settlement`);
    } finally { db.close(); }
  }
}

try {
  await assertExactNotStartedRecovery();
  await assertUserEffectReview();
  for (const injectRollback of [false, true]) {
    const label = injectRollback ? "rollback-closing" : "active-exact-blocker";
    const path = join(root, `${label}.db`), effectPath = join(root, `${label}.txt`), taskId = `native-${label}`;
    let db = new AppDatabase(path), bots = new BotRegistry(db.connection);
    const emissions:Array<{stateVersion:number;lifecycle:WorkDto["lifecycle"];inTransaction:boolean}>=[];
    const emitProjection=(projection:WorkProjectionDto)=>emissions.push({stateVersion:projection.stateVersion,lifecycle:projection.lifecycle,inTransaction:db.connection.inTransaction});
    bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
    let works = new WorkService(db.connection, { bots, resourceHostId: "old-authority",emitProjection });
    try {
      const created = unwrap(works.createWork(user, { operationId: `create-${label}`, title: label, inputSnapshotId: `input-${label}`, workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
      const windowId = created.budget.windowId;
      db.upsertTask({ id: taskId, title: label, cwd: root, updatedAt: Date.now() });
      unwrap(works.dispatchExecution(user, { operationId: `dispatch-${label}`, workId: created.workId, botId: DEFAULT_BOT_ID, taskId,
        durableStoreKey: `store:${label}`, conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read", "workspace:write"], reserveTokens: 10 }));
      const binding = works.repo.bindingForTask(taskId)!;
      const owner: WorkResourceOwner = { taskId, durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId,
        workspaceBinding: binding.workspaceBinding, bindingId: binding.bindingId, workId: binding.workId };
      const callId = "file-call", nativeTaskId = "9", operationId = `tool:1:${nativeTaskId}:${callId}`;
      const admitted = works.admitNewAction({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
        admissionId: "host-injected", workId: created.workId, bindingId: binding.bindingId, operationId, actionKind: "workspace:write" });
      assert(admitted.ok);
      await writeFile(effectPath, "before");
      const leaseResult = works.resourceGate.acquire({ actionId: `resource:${resourceOwnerKey(owner)}:${nativeTaskId}:${callId}`, owner, resources: [fileResource(effectPath, "write")] });
      assert(leaseResult.ok); const lease = leaseResult.lease;
      const execution = { taskId, executionId: `durable:${taskId}:1:${nativeTaskId}`, assistantMessageId: "actual-file-attempt" };
      const attempts = new ExecutionAttemptRepository(db.connection);
      const attempt = attempts.beginDurable({ ...execution, toolCallId: callId, toolName: "write", target: `durable-tool:1:${nativeTaskId}`, verifierId: "durable-file-content", verifierVersion: 1 });
      const intent = await prepareFileEffect({ type: "toolCall", id: callId, name: "write", arguments: { path: effectPath, content: "one actual file effect\n" } }, root);
      assert(intent?.kind === "file");
      await writeFile(effectPath, "one actual file effect\n");
      const proof = await verifyFileEffect(intent); assert.equal(proof.status, "passed");
      attempts.update({ ...attempt, phase: "finished", status: "passed", finishedAt: Date.now(), verification: {
        ...execution, attemptId: attempt.id, verifierId: proof.verifierId, verifierVersion: 1, target: attempt.target, canonicalTarget: proof.canonicalTarget,
        status: "passed", expected: proof.expected, observed: proof.observed, checkedAt: proof.checkedAt,
      } });
      assert(readResourceEffectEvidence(db.connection, lease).known);
      assert(works.settleAdmission(admitted.admission.admissionId, "unknown", "lost managed action receipt").ok);
      works.resourceGate.release(lease, "unknown", "original action outcome is pending reconciliation");
      unwrap(works.reconcileExecution({ kind: "system", reason: "fixture-native-terminal" }, { bindingId: binding.bindingId, outcome: "completed", usageTokens: 3 }));
      const originalBlocker = works.repo.listOpenBlockers(created.workId).find(blocker => blocker.unknownExternalEffectRef === admitted.admission.admissionId)!;
      assert(originalBlocker);
      let otherBlockerId: string | undefined;
      if (!injectRollback) {
        unwrap(works.reportBlocker(user, { operationId: "unrelated-blocker", workId: created.workId, kind: "operational", reason: "independent human decision", waitingForUserInput: true, versionGuard: guard(works.getWork(created.workId)!) }));
        otherBlockerId = works.repo.listOpenBlockers(created.workId).find(blocker => blocker.blockerId !== originalBlocker.blockerId)!.blockerId;
      }
      assert.equal(works.closeWork(user, { operationId: `cannot-close-${label}`, workId: created.workId, conclusion: "succeeded", versionGuard: guard(works.getWork(created.workId)!) }).ok, false);
      if (injectRollback) assert.equal(unwrap(works.cancelWork(user, { operationId: "cancel-pending", workId: created.workId, versionGuard: guard(works.getWork(created.workId)!) })).lifecycle, "closing");
      assert.equal(works.repo.getAdmission(admitted.admission.admissionId)?.state, "unknown");
      const budgetBefore = works.getWork(created.workId)!.budget;
      db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots, resourceHostId: "new-authority",emitProjection });
      assert.equal(works.resourceGate.leaseState(lease), "quarantined");
      if (injectRollback) {
        db.connection.exec(`CREATE TEMP TABLE phase3_finalize_fault(admission_id TEXT PRIMARY KEY);
          CREATE TEMP TRIGGER reject_admission_finalize BEFORE UPDATE OF state ON work_action_admissions
          WHEN OLD.state='unknown' AND NEW.state='consumed' AND EXISTS (SELECT 1 FROM phase3_finalize_fault fault WHERE fault.admission_id=OLD.admission_id)
          BEGIN SELECT RAISE(ABORT,'injected admission finalize failure'); END;`);
        db.connection.prepare("INSERT INTO phase3_finalize_fault(admission_id) VALUES (?)").run(admitted.admission.admissionId);
      }
      let callbacks = 0, recoveryClock = Date.now();
      const recovery = new WorkResourceRecovery(db.connection, works.resourceGate, {
        transaction:fn=>works.transaction(fn),
        inspectExecution: async () => ({ executionStopped: true, ownedChildrenStopped: true, receipt: "fixture-original-execution-and-owned-tasks-terminal" }),
        drainInput: async () => ({ queueDrained: true, inputReleased: true, receipt: "file-only-action-no-input-driver" }),
        verifyEffect: async original => readResourceEffectEvidence(db.connection, original),
        onRecovered: original => { callbacks++; works.finalizeRecoveredResource(original); },
      }, () => recoveryClock);
      const beforeRecoveryEmissions=emissions.length;
      await recovery.recover();
      if (injectRollback) {
        assert.equal(callbacks, 1);
        assert.equal(works.resourceGate.leaseState(lease), "quarantined", "resource release rolls back when business admission settlement fails");
        assert.equal(works.repo.getAdmission(admitted.admission.admissionId)?.state, "unknown");
        assert.equal(works.repo.getBlocker(originalBlocker.blockerId)?.status, "open");
        assert.equal(works.getWork(created.workId)?.lifecycle, "closing");
        assert(emissions.slice(beforeRecoveryEmissions).every(value => value.lifecycle === "closing"), "recovery status may publish, but rolled-back admission settlement cannot publish closed work");
        const failed = z.object({ receipt_json: z.string().nullable(), reason: z.string().nullable() }).parse(db.connection.prepare("SELECT receipt_json,reason FROM work_resource_recovery WHERE token=?").get(lease.token));
        assert.equal(failed.receipt_json, null); assert(failed.reason?.includes("injected admission finalize failure"));
        db.connection.exec("DROP TRIGGER reject_admission_finalize; DROP TABLE phase3_finalize_fault;");
        // A later failure occurs after Work finalization has queued its projection.
        // The outer WorkService transaction must discard that projection too.
        db.connection.exec(`CREATE TEMP TRIGGER reject_recovery_receipt BEFORE UPDATE OF receipt_json ON work_resource_recovery
          WHEN NEW.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected recovery receipt failure'); END;`);
        recoveryClock += 10_000; await recovery.recover(); assert.equal(callbacks,2);
        assert.equal(works.resourceGate.leaseState(lease),"quarantined");assert.equal(works.repo.getAdmission(admitted.admission.admissionId)?.state,"unknown");
        assert.equal(works.repo.getBlocker(originalBlocker.blockerId)?.status,"open");assert.equal(works.getWork(created.workId)?.lifecycle,"closing");
        assert(emissions.slice(beforeRecoveryEmissions).every(value => value.lifecycle === "closing"), "post-finalization rollback cannot leak a closed snapshot");
        db.connection.exec("DROP TRIGGER reject_recovery_receipt;");
        recoveryClock += 10_000; await recovery.recover(); assert.equal(callbacks, 3);
      }
      assert.equal(works.resourceGate.leaseState(lease), "released");
      assert.equal(works.repo.getAdmission(admitted.admission.admissionId)?.state, "consumed");
      assert.equal(works.repo.getBlocker(originalBlocker.blockerId)?.status, "cleared");
      assert.equal(await readFile(effectPath, "utf8"), "one actual file effect\n", "recovery only verifies the original effect");
      assert.deepEqual(works.getWork(created.workId)!.budget, budgetBefore); assert.equal(works.getWork(created.workId)!.budget.windowId, windowId);
      if (injectRollback) {
        assert.equal(works.getWork(created.workId)?.lifecycle, "closed"); assert.equal(works.getWork(created.workId)?.closureConclusion, "cancelled");
      } else {
        assert(otherBlockerId); assert.equal(works.repo.getBlocker(otherBlockerId)?.status, "open", "recovery cannot erase unrelated blockers");
        assert.equal(works.getWork(created.workId)?.lifecycle, "active");
        unwrap(works.clearBlocker(user, { operationId: "resolve-independent-decision", workId: created.workId, blockerId: otherBlockerId, resolutionNote: "user resolved the independent decision", versionGuard: guard(works.getWork(created.workId)!) }));
        const closed = unwrap(works.closeWork(user, { operationId: "close-after-recovery", workId: created.workId, conclusion: "succeeded", versionGuard: guard(works.getWork(created.workId)!) }));
        assert.equal(closed.lifecycle, "closed"); assert.equal(closed.closureConclusion, "succeeded");
      }
      await recovery.recover(); assert.equal(callbacks, injectRollback ? 3 : 1, "settled recovery never finalizes twice");
      assert(emissions.every(emission=>!emission.inTransaction),"projection delivery only occurs after its full database commit");
      console.log(`PASS ${label}: real file verifier -> exact native namespace -> resource/admission/blocker transaction; original effect once, usage3 unchanged, ${injectRollback ? "failure fully rolled back then cancelled closure settled" : "unrelated blocker retained then success closure possible"}`);
    } finally { db.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
