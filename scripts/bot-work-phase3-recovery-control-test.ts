import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { syncExhaustedResourceBlockers } from "../src/main/agent/work/WorkResourceBlockers";
import { WorkResourceRecovery } from "../src/main/agent/work/WorkResourceRecovery";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import { workPhase3ControlSchema, type RetryResourceRecoveryParams } from "../src/shared/bot-work-phase3-control";

const root = mkdtempSync(join(tmpdir(), "phase3-recovery-control-"));
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
let now = 10_000, authority = true;
const works = new WorkService(db.connection, { bots, now: () => now, resourceHostId: "host", isAuthority: () => authority });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (value: WorkControlResult) => { assert(value.ok, value.ok ? "" : value.message); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const state = (token: number) => z.object({ attempts: z.number(), exhausted_at: z.number().nullable() }).parse(
  db.connection.prepare("SELECT attempts,exhausted_at FROM work_resource_recovery WHERE token=?").get(token));
const stream = () => z.object({ sequence: z.number() }).parse(db.connection.prepare("SELECT sequence FROM work_projection_streams WHERE user_id=?").get(LOCAL_USER_ID)).sequence;

try {
  let work = unwrap(works.createWork(user, { operationId: "create", title: "quarantined input", inputSnapshotId: "input",
    workspacePath: root, authorization: { ...DESKTOP_USER_GRANTS, expiresAt: now + 50 } }));
  db.upsertTask({ id: "task", title: "fixture", cwd: root, updatedAt: now });
  unwrap(works.dispatchExecution(user, { operationId: "dispatch", workId: work.workId, botId: DEFAULT_BOT_ID, taskId: "task",
    durableStoreKey: "store", conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:write"] }));
  const binding = works.repo.bindingForTask("task")!;
  const admission = works.resourceGate.acquire({ actionId: "desktop-action", owner: { taskId: "task", workId: work.workId,
    bindingId: binding.bindingId, durableStoreKey: "store", conversationId: "1", workspaceBinding: root },
    resources: [{ kind: "desktop", scope: "host-input", key: "focus:desktop", mode: "write" }] });
  assert(admission.ok);
  const lease = admission.lease;
  works.resourceGate.release(lease, "unknown", "original input effect still unknown");
  const beforeStream = stream();
  db.connection.prepare("INSERT INTO work_resource_recovery(token,attempts,next_at,exhausted_at,reason) VALUES (?,4,?,?,?)")
    .run(lease.token, now, now, "fixture exhausted checks");
  assert(stream() > beforeStream, "recovery-only changes must enter the reconnect projection journal");
  syncExhaustedResourceBlockers(works, LOCAL_USER_ID);
  assert(works.repo.listOpenBlockers(work.workId).some(item => item.reasonCode === "resource-recovery-exhausted"));
  const exhaustedVersion = works.getWork(work.workId)!.stateVersion;
  syncExhaustedResourceBlockers(works, LOCAL_USER_ID);
  assert.equal(works.getWork(work.workId)!.stateVersion, exhaustedVersion, "polling exhaustion must not spam status changes");
  const projected = works.getProjection(work.workId)!.phase3!.resourceRecoveries;
  assert.equal(projected.length, 1); assert.equal(projected[0]!.exhaustedAt, now);
  assert(works.getProjection(work.workId)!.nextSteps.some(step => step.includes("确认环境安全")));
  work = unwrap(works.pauseWork(user, { operationId: "pause", workId: work.workId }));
  const request: RetryResourceRecoveryParams = { operationId: "retry", workId: work.workId, token: lease.token,
    expectedAttempts: 4, expectedExhaustedAt: now, confirmEnvironmentSafe: true, versionGuard: guard(work) };
  assert(workPhase3ControlSchema.safeParse({ kind: "retry_resource_recovery", request }).success);
  assert(!workPhase3ControlSchema.safeParse({ kind: "retry_resource_recovery", request: { ...request, confirmEnvironmentSafe: false } }).success);
  assert(!workPhase3ControlSchema.safeParse({ kind: "retry_resource_recovery", request: { ...request, versionGuard: undefined } }).success);
  assert(!works.retryResourceRecovery({ kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants: DESKTOP_USER_GRANTS }, request).ok);
  assert(!works.retryResourceRecovery({ ...user, userId: "another-user" }, request).ok);
  assert(!works.retryResourceRecovery(user, { ...request, expectedExhaustedAt: now - 1 }).ok);
  assert(!works.retryResourceRecovery(user, { ...request, expectedAttempts: 3 }).ok);
  assert(!works.retryResourceRecovery(user, { ...request, token: lease.token + 1 }).ok);
  assert(!works.retryResourceRecovery(user, { ...request, versionGuard: { ...guard(work), expectedStateVersion: work.stateVersion - 1 } }).ok);
  authority = false; assert(!works.retryResourceRecovery(user, request).ok); authority = true;
  assert.equal(state(lease.token).exhausted_at, now, "refused controls must leave recovery state untouched");
  db.connection.exec("CREATE TRIGGER fail_recovery_control BEFORE UPDATE ON works BEGIN SELECT RAISE(ABORT,'injected retry control crash'); END");
  assert.throws(() => works.retryResourceRecovery(user, request), /injected retry control crash/);
  assert.equal(state(lease.token).exhausted_at, now, "failure after rearming rolls the resource state back with the Work control");
  assert.equal(works.repo.getReceipt(LOCAL_USER_ID, request.operationId), undefined);
  db.connection.exec("DROP TRIGGER fail_recovery_control");

  now += 100; // Expired business authorization must not block safe cleanup of an original action.
  const accepted = works.retryResourceRecovery(user, request);
  work = unwrap(accepted);
  assert.equal(work.lifecycle, "paused", "recheck does not resume business work");
  assert.equal(work.stateVersion, request.versionGuard.expectedStateVersion + 1);
  assert.equal(state(lease.token).exhausted_at, null);
  assert.equal(works.resourceGate.leaseState(lease), "quarantined", "human confirmation never releases a lease");
  assert.equal(works.repo.listBindings(work.workId).length, 1, "recheck never creates or repeats a business execution");
  syncExhaustedResourceBlockers(works, LOCAL_USER_ID);
  assert(!works.repo.listOpenBlockers(work.workId).some(item => item.reasonCode === "resource-recovery-exhausted"));
  work = works.getWork(work.workId)!;
  const retryState = state(lease.token);
  const replay = works.retryResourceRecovery(user, request);
  assert(replay.ok && replay.replayed); assert.deepEqual(state(lease.token), retryState);
  assert(!works.retryResourceRecovery(user, { ...request, operationId: "stale-retry", versionGuard: guard(work) }).ok);

  let effectKnown = false;
  const recovery = new WorkResourceRecovery(db.connection, works.resourceGate, {
    transaction: fn => works.transaction(fn),
    inspectExecution: async () => ({ executionStopped: true, ownedChildrenStopped: true, receipt: "original-graph-stopped" }),
    drainInput: async () => ({ queueDrained: true, inputReleased: true, receipt: "owned-input-released" }),
    verifyEffect: async () => ({ known: effectKnown, receipt: effectKnown ? "original-effect-read-back" : "still-unknown" }),
  }, () => now);
  now += 10_000; await recovery.recover();
  assert.equal(works.resourceGate.leaseState(lease), "quarantined", "unknown effect remains isolated after explicit recheck");
  effectKnown = true; now += 10_000; await recovery.recover();
  assert.equal(works.resourceGate.leaseState(lease), "released");
  assert.equal(works.getProjection(work.workId)!.phase3!.resourceRecoveries.length, 0);
  assert.equal(works.getWork(work.workId)!.lifecycle, "paused");
  assert.deepEqual(works.getWork(work.workId)!.budget, work.budget);
  // A restored closed Work can still own an unresolved historical lease. Rechecking
  // that lease must be possible without reopening or resubmitting the Work.
  const closed = { ...works.getWork(work.workId)!, lifecycle: "closed" as const,
    closureConclusion: "cancelled" as const, closedAt: now, stateVersion: works.getWork(work.workId)!.stateVersion + 1 };
  works.repo.updateWork(closed);
  db.connection.prepare("UPDATE work_resource_leases SET state='quarantined' WHERE token=?").run(lease.token);
  db.connection.prepare("UPDATE work_resource_recovery SET attempts=8,exhausted_at=?,next_at=? WHERE token=?").run(now, now, lease.token);
  const closedRetry = works.retryResourceRecovery(user, { operationId: "closed-recheck", workId: closed.workId,
    token: lease.token, expectedAttempts: 8, expectedExhaustedAt: now, confirmEnvironmentSafe: true, versionGuard: guard(closed) });
  assert(closedRetry.ok);
  assert.equal(works.getWork(work.workId)!.lifecycle, "closed");
  assert.equal(works.resourceGate.leaseState(lease), "quarantined", "closed recheck must not force release");
  assert.equal(works.repo.listBindings(work.workId).length, 1);
  console.log("Phase3 recovery control passed: user confirmation, authority/ownership/CAS, exact exhausted lease, idempotent receipt, durable projection, and three-proof release without business resume.");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
