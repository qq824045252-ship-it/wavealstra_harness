import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import type { WorkExecutionObservation } from "../src/main/agent/work/WorkExecutionAdapter";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import type { WorkActor, WorkControlResult, WorkDto, WorkNotificationChannel, WorkNotificationDto } from "../src/shared/bot-work";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "phase3-handoff-"));
const path = join(root, "work.db");
const db = new AppDatabase(path);
const effectDb = new Database(join(root, "notification-effects.db"));
effectDb.exec("CREATE TABLE deliveries(idempotency_key TEXT PRIMARY KEY,payload TEXT NOT NULL)");
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
for (const botId of [DEFAULT_BOT_ID, "next-owner", "concurrent-owner"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
const works = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
let sequence = 0;
function fixture(name: string, _retiredReservationFixture = 0) {
  const suffix = `${name}-${++sequence}`;
  let work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix,
    authorization: grants, inputSnapshotId: `input:${suffix}`, criteria: [{ text: "Current checked evidence" }] }));
  const taskId = `task:${suffix}`;
  db.upsertTask({ id: taskId, title: suffix, updatedAt: Date.now() });
  work = unwrap(works.dispatchExecution(user, { operationId: `dispatch:${suffix}`, workId: work.workId, botId: DEFAULT_BOT_ID,
    taskId, durableStoreKey: `store:${suffix}`, conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read", "workspace:write"] }));
  const binding = works.repo.listBindings(work.workId)[0];
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  return { suffix, work, binding, worker };
}
function awaitingAdoption(name: string) {
  const f = fixture(name, 30);
  unwrap(works.handoffOwner(user, { operationId: `handoff:${f.suffix}`, workId: f.work.workId, targetBotId: "next-owner" }));
  // Fault injection only: production handoff inserts these rows atomically. A
  // missing row must still preserve native facts without granting new authority.
  db.connection.prepare("DELETE FROM work_delegation_adoptions WHERE binding_id=?").run(f.binding.bindingId);
  return f;
}
const nativeReceipt = (f: ReturnType<typeof fixture>): AgentSubmissionReceipt => ({
  taskId: f.binding.taskId, operationId: f.binding.operationId, submissionId: 1, status: "done",
});
const nativeResult: WorkExecutionObservation = { status: "completed", summary: "Original worker retained its result",
  artifactRefs: [], hasWriteConflicts: false, usageTokens: 7, subitems: [
    { itemId: "success", task: "Successful original item", required: true, dependencies: [], criterionIds: [],
      nativeStatus: "completed", outcome: "completed", artifactRefs: [], writeConflicts: [], summary: "Retain this success" },
    { itemId: "gap", task: "Blocked original item", required: true, dependencies: [], criterionIds: [],
      nativeStatus: "blocked", outcome: "blocked", artifactRefs: [], writeConflicts: [], summary: "Still needs review" },
  ] };
function accepted(name: string, artifactPath?: string) {
  const f = fixture(name);
  if (artifactPath) {
    const fingerprints = works.artifacts.register(f.binding, [artifactPath]);
    works.transaction(() => works.artifacts.record(f.binding, fingerprints));
  }
  unwrap(works.submitDeliverable(f.worker, { operationId: `deliver:${f.suffix}`, workId: f.work.workId, bindingId: f.binding.bindingId,
    deliverableId: `deliverable:${f.suffix}`, summary: "Confirmed partial result", artifactRefs: artifactPath ? [artifactPath] : [],
    evidence: [{ kind: "tool_receipt", sourceRef: `receipt:${f.suffix}` }] }));
  const current = unwrap(works.acceptDeliverable(user, { operationId: `accept:${f.suffix}`, workId: f.work.workId, deliverableId: `deliverable:${f.suffix}` }));
  const notification = works.repo.listNotifications(current.workId).find(item => item.kind === "result")!;
  return { ...f, work: current, notification };
}
const sentPayloads: WorkNotificationDto[] = [];
let sends = 0;
let lookupMode: "delivered" | "missing" | "unknown" | "actual" = "actual";
const channel: WorkNotificationChannel = { channel: "phase3-local-effect-endpoint", idempotent: true,
  send: ({ notification, idempotencyKey }) => {
    sends++;
    effectDb.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?)").run(idempotencyKey, JSON.stringify(notification));
    sentPayloads.push(notification);
    return { ok: true, receipt: `stored:${idempotencyKey}` };
  },
  lookup: ({ idempotencyKey }) => lookupMode === "actual"
    ? effectDb.prepare("SELECT 1 FROM deliveries WHERE idempotency_key=?").get(idempotencyKey) ? "delivered" : "missing"
    : lookupMode,
};

try {
  // Two independent SQLite connections prepare decisions on the same control version.
  const f = fixture("handoff");
  const before = works.getWork(f.work.workId)!;
  // Tool permission scopes are retired; identity and availability boundaries remain.
  bots.registerBot({ botId: "default-grants-owner", userId: LOCAL_USER_ID, displayName: "Default grants owner" });
  const defaultGrants = fixture("default-grants-handoff");
  const defaultHanded = unwrap(works.handoffOwner(user, { operationId: "default-grants-handoff", workId: defaultGrants.work.workId, targetBotId: "default-grants-owner" }));
  assert.equal(defaultHanded.ownerBotId, "default-grants-owner", "omitted legacy permissions do not block handoff");
  assert.equal(works.collaboration.isDelegationAdopted(defaultGrants.binding, defaultHanded), true);
  bots.registerBot({ botId: "foreign-owner", userId: "another-user", displayName: "Foreign owner" });
  bots.registerBot({ botId: "disabled-owner", userId: LOCAL_USER_ID, displayName: "Disabled owner", status: "disabled" });
  for (const targetBotId of ["missing-owner", "foreign-owner", "disabled-owner", before.ownerBotId]) {
    const rejected = works.handoffOwner(user, { operationId: `invalid-handoff:${targetBotId}`, workId: before.workId, targetBotId });
    assert.equal(rejected.ok, false, `${targetBotId} cannot become the new owner`);
    assert.deepEqual(works.getWork(before.workId), before, "rejected handoff leaves control state unchanged");
  }
  const prep = works.collaboration.prepareHandoff(owner, before.workId, "next-owner");
  const db2 = new AppDatabase(path);
  const works2 = new WorkService(db2.connection, { bots: new BotRegistry(db2.connection) });
  const competing = works2.collaboration.prepareHandoff(user, before.workId, "concurrent-owner");
  const intermediate: Array<{ epoch: number; adoptionVisible: boolean }> = [];
  db.connection.function("phase3_observe_handoff", (workId: string) => {
    intermediate.push({ epoch: works2.getWork(workId)!.ownerEpoch, adoptionVisible: Boolean(db2.connection.prepare(
      "SELECT 1 FROM work_delegation_adoptions WHERE binding_id=? AND owner_epoch=?",
    ).get(f.binding.bindingId, before.ownerEpoch + 1)) });
    return 0;
  });
  db.connection.exec("CREATE TRIGGER phase3_observe_handoff AFTER UPDATE OF owner_epoch ON works WHEN NEW.owner_epoch!=OLD.owner_epoch BEGIN SELECT phase3_observe_handoff(NEW.work_id); END");
  const handed = unwrap(works.handoffOwner(owner, { operationId: "handoff:once", workId: before.workId, targetBotId: "next-owner", preparationId: prep.preparationId, versionGuard: guard(before) }));
  db.connection.exec("DROP TRIGGER phase3_observe_handoff");
  assert.deepEqual(intermediate, [{ epoch: before.ownerEpoch, adoptionVisible: false }], "another SQLite connection cannot see the new epoch before adoption commits");
  assert.equal(works2.collaboration.isDelegationAdopted(f.binding, works2.getWork(before.workId)!), true, "new epoch and adoption become visible together");
  assert.equal(handed.ownerEpoch, before.ownerEpoch + 1);
  assert.equal(handed.stateVersion, before.stateVersion + 1);
  assert.equal(handed.inputSnapshotId, before.inputSnapshotId);
  assert.equal(handed.intentRevision, before.intentRevision);
  assert.equal("budget" in handed, false);
  const race = works2.handoffOwner(user, { operationId: "handoff:race", workId: before.workId, targetBotId: "concurrent-owner", preparationId: competing.preparationId, versionGuard: guard(before) });
  assert.equal(race.ok, false);
  assert.equal(works2.getWork(before.workId)!.ownerBotId, "next-owner");
  const oldReplay = works.handoffOwner(owner, { operationId: "handoff:once", workId: before.workId, targetBotId: "next-owner", preparationId: prep.preparationId, versionGuard: guard(before) });
  assert.equal(oldReplay.ok, false, "old owner cannot replay a control after losing authority");
  assert.equal(works.pauseWork(owner, { operationId: "old-control", workId: before.workId, versionGuard: guard(before) }).ok, false);
  assert.equal(works.collaboration.isDelegationAdopted(f.binding, handed), true);
  const late = unwrap(works.submitDeliverable(f.worker, { operationId: "late-worker-result", workId: before.workId,
    bindingId: f.binding.bindingId, summary: "Original worker finished after handoff", artifactRefs: [],
    evidence: [{ kind: "tool_receipt", sourceRef: "original-root-receipt" }] }));
  const lateDeliverable = works.repo.listDeliverables(late.workId)[0];
  assert.equal(lateDeliverable.ownerEpoch, before.ownerEpoch, "producer epoch stays historical");
  assert.equal(lateDeliverable.status, "proposed", "valid original delegation is not discarded");
  assert.equal(works.repo.listBindings(before.workId).length, 1);
  assert.equal(works.repo.getBinding(f.binding.bindingId)!.durableStoreKey, f.binding.durableStoreKey);
  db2.close();

  const rollback = fixture("rollback");
  const initial = works.getWork(rollback.work.workId)!;
  db.connection.exec("CREATE TRIGGER phase3_fail_handoff BEFORE INSERT ON work_collaboration_messages WHEN NEW.kind='handoff' BEGIN SELECT RAISE(ABORT,'injected handoff crash'); END");
  assert.throws(() => works.handoffOwner(user, { operationId: "rollback-handoff", workId: initial.workId, targetBotId: "next-owner" }), /injected handoff crash/);
  assert.deepEqual(works.getWork(initial.workId), initial);
  assert.equal(works.repo.getReceipt(LOCAL_USER_ID, "rollback-handoff"), undefined);
  assert.deepEqual(db.connection.prepare("SELECT * FROM work_delegation_adoptions WHERE binding_id=?").all(rollback.binding.bindingId), [], "adoption rolls back with the owner and message");
  db.connection.exec("DROP TRIGGER phase3_fail_handoff");

  const pending = awaitingAdoption("pending-native-receipt");
  assert.deepEqual(works.nativeResults.receive(pending.binding, nativeReceipt(pending), nativeResult), []);
  const deferred = db.connection.prepare("SELECT payload_json,namespace_hash,consumed_at,consume_error FROM work_native_inbox WHERE binding_id=?").get(pending.binding.bindingId) as {
    payload_json: string; namespace_hash: string; consumed_at: number | null; consume_error: string;
  };
  assert.equal(deferred.consumed_at, null);
  assert.match(deferred.consume_error, /^pending_adoption:/);
  assert.deepEqual(JSON.parse(deferred.payload_json), nativeResult);
  assert.equal(works.repo.getBinding(pending.binding.bindingId)!.status, "completed", "actual native completion settles even before adoption");
  assert.equal("budget" in works.getWork(pending.work.workId)!, false);
  assert.equal("budget" in works.getWork(pending.work.workId)!, false);
  assert.equal(works.repo.listDeliverables(pending.work.workId).length, 0, "unadopted native results are not published");
  assert.equal(works.partialResults.list(pending.work.workId).length, 0, "partial publication follows the same adoption gate");
  assert.equal(works.repo.getBlocker(`adoption:${pending.binding.bindingId}`)!.status, "open");
  const deferredVersion = works.getWork(pending.work.workId)!.stateVersion;
  assert.deepEqual(works.nativeResults.consume(), []);
  assert.deepEqual(works.nativeResults.receive(pending.binding, nativeReceipt(pending), nativeResult), []);
  assert.equal(works.getWork(pending.work.workId)!.stateVersion, deferredVersion, "repeated pending consumption does not churn control versions or charge usage again");
  assert.equal(works.repo.listOutbox(pending.work.workId).some(event => event.eventType === "work.deliverable_proposed"), false);
  const directPending = works.submitDeliverable(pending.worker, { operationId: `direct:${pending.suffix}`, workId: pending.work.workId,
    bindingId: pending.binding.bindingId, summary: "Direct submit cannot bypass adoption", artifactRefs: [] });
  assert.equal(directPending.ok, false);
  if (!directPending.ok) assert.equal(directPending.code, "epoch_mismatch");

  const pendingDb = new AppDatabase(path);
  try {
    const recovered = new WorkService(pendingDb.connection, { bots: new BotRegistry(pendingDb.connection) });
    assert.deepEqual(recovered.nativeResults.consume(), []);
    assert.equal(recovered.repo.listDeliverables(pending.work.workId).length, 0, "restart keeps the pending fact pending");
    const adopted = unwrap(recovered.handoffOwner(user, { operationId: "adopt-retained-native-result", workId: pending.work.workId, targetBotId: "concurrent-owner" }));
    assert.equal("budget" in works.getWork(pending.work.workId)!, false);
    const outputs = recovered.repo.listDeliverables(pending.work.workId);
    assert.equal(outputs.length, 2, "adoption immediately replays aggregate and completed partial facts");
    assert(outputs.every(output => output.status === "proposed" && output.ownerEpoch === pending.binding.ownerEpoch && output.producerBotId === pending.binding.botId));
    assert.equal(recovered.partialResults.gaps(pending.work.workId)[0].itemId, "gap");
    assert.equal(recovered.repo.getBlocker(`adoption:${pending.binding.bindingId}`)!.status, "cleared");
    assert.deepEqual(pendingDb.connection.prepare("SELECT count(*) AS n FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NULL").get(pending.binding.bindingId), { n: 0 });
    assert.equal(recovered.repo.listBindings(pending.work.workId).length, 1);
    assert.equal(recovered.repo.getBinding(pending.binding.bindingId)!.durableStoreKey, pending.binding.durableStoreKey);
    const completedVersion = adopted.stateVersion;
    assert.deepEqual(recovered.nativeResults.receive(pending.binding, nativeReceipt(pending), nativeResult), []);
    assert.deepEqual(works.nativeResults.receive(pending.binding, nativeReceipt(pending), nativeResult), [], "the original connection may replay its pre-handoff binding snapshot safely");
    assert.equal(recovered.getWork(pending.work.workId)!.stateVersion, completedVersion);
    assert.equal("budget" in works.getWork(pending.work.workId)!, false);
    assert.equal(recovered.repo.listDeliverables(pending.work.workId).length, outputs.length);
  } finally { pendingDb.close(); }

  const pendingReview = fixture("unadopted-review");
  unwrap(works.submitDeliverable(pendingReview.worker, { operationId: "before-review-handoff", workId: pendingReview.work.workId,
    bindingId: pendingReview.binding.bindingId, deliverableId: "before-review-handoff", summary: "Retained before handoff", artifactRefs: [] }));
  unwrap(works.handoffOwner(user, { operationId: "review-handoff", workId: pendingReview.work.workId, targetBotId: "next-owner" }));
  db.connection.prepare("DELETE FROM work_delegation_adoptions WHERE binding_id=?").run(pendingReview.binding.bindingId);
  const unadoptedReview = works.acceptDeliverable(user, { operationId: "unadopted-review", workId: pendingReview.work.workId, deliverableId: "before-review-handoff" });
  assert.equal(unadoptedReview.ok, false);
  if (!unadoptedReview.ok) assert.equal(unadoptedReview.code, "epoch_mismatch");
  assert.equal(works.repo.getDeliverable("before-review-handoff")!.status, "proposed");

  for (const change of ["intent", "input", "revoked", "revoked_at_zero", "invalidated_status"] as const) {
    const stalePending = awaitingAdoption(`pending-${change}`);
    assert.deepEqual(works.nativeResults.receive(stalePending.binding, nativeReceipt(stalePending), nativeResult), []);
    if (change === "revoked_at_zero" || change === "invalidated_status") {
      // Exercise both persisted invalidation signals independently. Neither a
      // zero timestamp nor a status-only invalidation may be adopted again.
      const binding = works.repo.getBinding(stalePending.binding.bindingId)!;
      works.transaction(() => works.repo.updateBinding({ ...binding,
        ...(change === "revoked_at_zero" ? { invalidatedAt: 0 } : { status: "invalidated" }) }));
    } else unwrap(works.amendWork(user, { operationId: `invalidate:${stalePending.suffix}`, workId: stalePending.work.workId,
      ...(change === "intent" ? { title: "Changed requirement" } : change === "input" ? { inputSnapshotId: "new-pending-input" } : { invalidateExecutionIds: [stalePending.binding.bindingId] }) }));
    const changed = unwrap(works.handoffOwner(user, { operationId: `handoff-after:${stalePending.suffix}`, workId: stalePending.work.workId, targetBotId: "concurrent-owner" }));
    assert.equal(works.collaboration.isDelegationAdopted(works.repo.getBinding(stalePending.binding.bindingId)!, changed), false);
    assert.equal(works.collaboration.isDelegationPending(works.repo.getBinding(stalePending.binding.bindingId)!, changed), false);
    assert(works.repo.listDeliverables(stalePending.work.workId).every(output => output.status === "superseded"), `${change} cannot become a current adopted result`);
    assert.equal(works.repo.getBlocker(`adoption:${stalePending.binding.bindingId}`)!.status, "cleared");
    assert.equal("budget" in works.getWork(pending.work.workId)!, false);
    assert.equal(works.partialResults.gaps(stalePending.work.workId).length, 0, "revoked or stale facts cannot authorize new gap work");
    const staleContinuation = works.continueWork(user, { operationId: `continue-stale:${stalePending.suffix}`, workId: stalePending.work.workId,
      sourceBindingId: stalePending.binding.bindingId, gapItemIds: ["gap"], reason: "stale gap must stay historical", versionGuard: guard(changed) });
    assert.equal(staleContinuation.ok, false);
    assert.deepEqual(db.connection.prepare("SELECT count(*) AS n FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NULL").get(stalePending.binding.bindingId), { n: 0 });
    assert.deepEqual(db.connection.prepare("SELECT * FROM work_delegation_adoptions WHERE binding_id=? AND owner_epoch=?").all(stalePending.binding.bindingId, changed.ownerEpoch), []);
  }

  const cancelledPending = awaitingAdoption("pending-cancelled");
  assert.deepEqual(works.nativeResults.receive(cancelledPending.binding, nativeReceipt(cancelledPending), nativeResult), []);
  const cancelling = unwrap(works.cancelWork(user, { operationId: "cancel-awaiting-adoption", workId: cancelledPending.work.workId }));
  assert.equal(cancelling.lifecycle, "closing");
  assert.deepEqual(works.nativeResults.consume(cancelledPending.work.workId), []);
  const cancelledState = works.getWork(cancelledPending.work.workId)!;
  assert.equal(cancelledState.lifecycle, "closed", "cancellation can settle without a new handoff");
  assert.equal(cancelledState.closureConclusion, "cancelled");
  assert.equal("budget" in works.getWork(pending.work.workId)!, false);
  assert(works.repo.listDeliverables(cancelledPending.work.workId).every(output => output.status === "superseded"));
  assert.equal(works.repo.listNotifications(cancelledPending.work.workId).some(notification => notification.kind === "result"), false);
  assert.equal(works.repo.getBlocker(`adoption:${cancelledPending.binding.bindingId}`)!.status, "cleared");
  assert.deepEqual(db.connection.prepare("SELECT count(*) AS n FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NULL").get(cancelledPending.binding.bindingId), { n: 0 });

  const stale = accepted("before-change");
  unwrap(works.amendWork(user, { operationId: "changed-before-claim", workId: stale.work.workId, inputSnapshotId: "new-input" }));
  const beforeSend = sends;
  works.deliverPendingNotifications(channel, stale.work.workId);
  assert.equal(sends, beforeSend);
  assert.equal(works.notifications.identity(stale.notification.notificationId)!.semanticValidity, "superseded");
  assert.equal(works.repo.getNotification(stale.notification.notificationId)!.readAt, undefined);

  const cancelled = accepted("before-cancel");
  unwrap(works.cancelWork(user, { operationId: "cancel-before-send", workId: cancelled.work.workId }));
  works.deliverPendingNotifications(channel, cancelled.work.workId);
  assert.equal(sends, beforeSend);
  assert.equal(works.notifications.identity(cancelled.notification.notificationId)!.semanticValidity, "cancelled");
  assert.equal(works.repo.getNotification(cancelled.notification.notificationId)!.readAt, undefined);

  const artifactPath = join(root, "external-artifact.txt");
  writeFileSync(artifactPath, "original");
  const artifact = accepted("external-change", artifactPath);
  const times = statSync(artifactPath);
  writeFileSync(artifactPath, "modified");
  utimesSync(artifactPath, times.atime, times.mtime);
  works.deliverPendingNotifications(channel, artifact.work.workId);
  assert.equal(sends, beforeSend, "same mtime/size external artifact edit must block an obsolete notification");
  assert.equal(works.notifications.identity(artifact.notification.notificationId)!.semanticValidity, "superseded");
  assert.equal(works.repo.getDeliverable(`deliverable:${artifact.suffix}`)!.status, "superseded");

  const succeeded = accepted("closed-succeeded");
  unwrap(works.reconcileExecution({ kind: "system", reason: "fixture-native-result" }, { bindingId: succeeded.binding.bindingId, outcome: "completed", usageTokens: 0 }));
  unwrap(works.attestCriteria(user, { operationId: "closed-criterion", workId: succeeded.work.workId,
    criterionUpdates: [{ criterionId: succeeded.work.criteria[0].id, status: "met", evidence: "explicit user check" }] }));
  unwrap(works.closeWork(user, { operationId: "close-success", workId: succeeded.work.workId, conclusion: "succeeded" }));
  assert.equal(works.getWork(succeeded.work.workId)!.lifecycle, "closed");
  works.deliverPendingNotifications(channel, succeeded.work.workId);
  assert.equal(works.repo.getNotification(succeeded.notification.notificationId)!.delivery, "sent", "closed:succeeded retains valid completion delivery");

  const transferred = accepted("notify-handoff");
  const transferBefore = works.getWork(transferred.work.workId)!;
  unwrap(works.handoffOwner(user, { operationId: "notify-handoff", workId: transferBefore.workId, targetBotId: "next-owner" }));
  works.deliverPendingNotifications(channel, transferBefore.workId);
  assert.equal(works.repo.listNotifications(transferBefore.workId)[0].notificationId, transferred.notification.notificationId);
  assert.equal(works.repo.getNotification(transferred.notification.notificationId)!.delivery, "sent");
  const deliveredTransfer = sentPayloads.find(item => item.notificationId === transferred.notification.notificationId)!;
  assert.equal(deliveredTransfer.senderBotId, "next-owner");
  assert.match(deliveredTransfer.body!, /当前负责人：next-owner/);

  // The first external call changes the next notification's Work. That second send
  // must re-read current facts rather than reuse the loop's captured Work object.
  const loopFirst = accepted("loop-first");
  const loopSecond = accepted("loop-second");
  const loopChannel: WorkNotificationChannel = { ...channel, send: input => {
    const result = channel.send(input);
    if (input.notification.notificationId === loopSecond.notification.notificationId) {
      unwrap(works.amendWork(user, { operationId: "change-during-send-loop", workId: loopFirst.work.workId, inputSnapshotId: "loop-current-input" }));
    }
    return result;
  } };
  works.deliverPendingNotifications(loopChannel);
  assert.equal(works.repo.getNotification(loopFirst.notification.notificationId)!.delivery, "pending");
  assert.equal(works.notifications.identity(loopFirst.notification.notificationId)!.semanticValidity, "superseded");

  const inFlight = accepted("in-flight");
  const inflightChannel: WorkNotificationChannel = { ...channel, send: input => {
    const result = channel.send(input);
    unwrap(works.amendWork(user, { operationId: "after-claim", workId: inFlight.work.workId, inputSnapshotId: "changed-in-flight" }));
    return result;
  } };
  works.deliverPendingNotifications(inflightChannel, inFlight.work.workId);
  assert.equal(works.repo.getNotification(inFlight.notification.notificationId)!.delivery, "sent", "already admitted effect still settles after input changes");

  const untracked = accepted("non-idempotent-unknown");
  let untrackedSends = 0;
  const untrackedChannel: WorkNotificationChannel = { channel: "non-idempotent-endpoint", idempotent: false, send: () => {
    untrackedSends++; return { ok: false, responseLost: true, retryable: true, error: "no lookup contract" };
  } };
  works.deliverPendingNotifications(untrackedChannel, untracked.work.workId);
  works.deliverPendingNotifications(untrackedChannel, untracked.work.workId);
  assert.equal(untrackedSends, 1);
  assert.equal(works.repo.getNotification(untracked.notification.notificationId)!.delivery, "unknown");

  const beforeEffect = accepted("claim-before-effect");
  const claimOnlyChannel: WorkNotificationChannel = { ...channel, send: () => { throw new Error("injected crash after persisted claim, before effect"); } };
  works.deliverPendingNotifications(claimOnlyChannel, beforeEffect.work.workId);
  assert.equal(works.repo.getNotification(beforeEffect.notification.notificationId)!.delivery, "unknown");
  assert.equal(effectDb.prepare("SELECT 1 FROM deliveries WHERE idempotency_key=?").get(`work-notify:${beforeEffect.notification.notificationId}`), undefined);
  works.deliverPendingNotifications(channel, beforeEffect.work.workId);
  assert.equal(works.repo.getNotification(beforeEffect.notification.notificationId)!.delivery, "sent");
  assert.equal(works.repo.getNotification(beforeEffect.notification.notificationId)!.attemptCount, 2);
  assert.deepEqual(effectDb.prepare("SELECT count(*) AS n FROM deliveries WHERE payload LIKE ?").get(`%${beforeEffect.notification.notificationId}%`), { n: 1 });

  const lost = accepted("lost-receipt");
  let lostSends = 0;
  const lostChannel: WorkNotificationChannel = { ...channel, send: input => {
    lostSends++; channel.send(input);
    return { ok: false, responseLost: true, retryable: true, error: "effect recorded, receipt lost" };
  } };
  lookupMode = "unknown";
  works.deliverPendingNotifications(lostChannel, lost.work.workId);
  assert.equal(works.repo.getNotification(lost.notification.notificationId)!.delivery, "unknown");
  unwrap(works.amendWork(user, { operationId: "lost-changed", workId: lost.work.workId, inputSnapshotId: "lost-new-input" }));
  const oldAttempt = db.connection.prepare("SELECT payload_json,idempotency_key FROM work_notification_attempts WHERE notification_id=?").get(lost.notification.notificationId);
  db.close();
  const reopened = new AppDatabase(path);
  const reopenedWorks = new WorkService(reopened.connection, { bots: new BotRegistry(reopened.connection) });
  reopenedWorks.deliverPendingNotifications(lostChannel, lost.work.workId);
  assert.equal(lostSends, 1, "unknown effect cannot be blindly resent after crash/reopen or input change");
  assert.deepEqual(reopened.connection.prepare("SELECT payload_json,idempotency_key FROM work_notification_attempts WHERE notification_id=?").get(lost.notification.notificationId), oldAttempt);
  lookupMode = "actual";
  reopenedWorks.deliverPendingNotifications(lostChannel, lost.work.workId);
  assert.equal(reopenedWorks.repo.getNotification(lost.notification.notificationId)!.delivery, "sent");
  assert.equal(lostSends, 1);
  reopened.close();
  console.log("Phase 3 handoff/notifications: atomic epoch/adoption visibility, retained pending receipts/restart/replay, once-only usage, revoked/stale/cancelled history, transactional rollback, and immutable notification recovery passed");
} finally {
  try { db.close(); } catch { /* closed for restart */ }
  effectDb.close(); rmSync(root, { recursive: true, force: true });
}
