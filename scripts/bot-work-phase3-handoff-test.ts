import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
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
function fixture(name: string) {
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
  bots.registerBot({ botId: "under-authorized-owner", userId: LOCAL_USER_ID, displayName: "read-only owner" });
  assert.equal(works.handoffOwner(user, { operationId: "under-authorized-handoff", workId: before.workId, targetBotId: "under-authorized-owner" }).ok, false);
  assert.equal(works.getWork(before.workId)!.ownerBotId, before.ownerBotId);
  const prep = works.collaboration.prepareHandoff(owner, before.workId, "next-owner");
  const db2 = new AppDatabase(path);
  const works2 = new WorkService(db2.connection, { bots: new BotRegistry(db2.connection) });
  const competing = works2.collaboration.prepareHandoff(user, before.workId, "concurrent-owner");
  const handed = unwrap(works.handoffOwner(owner, { operationId: "handoff:once", workId: before.workId, targetBotId: "next-owner", preparationId: prep.preparationId, versionGuard: guard(before) }));
  assert.equal(handed.ownerEpoch, before.ownerEpoch + 1);
  assert.equal(handed.stateVersion, before.stateVersion + 1);
  assert.equal(handed.inputSnapshotId, before.inputSnapshotId);
  assert.equal(handed.intentRevision, before.intentRevision);
  assert.deepEqual(handed.budget, before.budget);
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
  db.connection.exec("DROP TRIGGER phase3_fail_handoff");

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
  console.log("Phase 3 handoff/notifications: two SQLite connections, transactional rollback, preserved producer/budget, latest-fact claims, in-flight settlement, immutable unknown recovery and actual endpoint effects passed");
} finally {
  try { db.close(); } catch { /* closed for restart */ }
  effectDb.close(); rmSync(root, { recursive: true, force: true });
}
