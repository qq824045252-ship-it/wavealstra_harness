import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase4-fanout-"));
const path = join(root, "business.db");
const clock = { at: Date.UTC(2026, 0, 5, 12, 0, 0) };
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots, now: () => clock.at });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`, authorization: DESKTOP_USER_GRANTS, workspacePath: root }));
function subscribe(work: WorkDto, id: string, policy: "latest" | "each" | "skip", depth: number, target?: string, backlog = 8) {
  const result = works.phase4Control(user, { kind: "configure-subscription", operationId: id, workId: work.workId,
    source: "hook", catchUpPolicy: policy, maxMergeWaitMs: 1_000, maxQueueDepth: depth, targetKey: target,
    versionMode: "monotonic", maxBacklogEvents: backlog, versionGuard: guard(works.getWork(work.workId)!) });
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.subscriptionId!;
}
const event = (id: string, version: string | undefined, target: string, value: number, workId?: string) =>
  works.ingestSourceEvent({ source: "hook", sourceEventId: id, eventType: "changed", sourceVersion: version,
    workId, payload: { target, value } });
const inbox = (work: WorkDto, statuses?: Parameters<typeof works.repo.listInbox>[1]) => works.repo.listInbox(work.workId, statuses);

try {
  const sharedA = create("fanout-a");
  const latestA = subscribe(sharedA, "sub-a-latest", "latest", 4, "A");
  const sharedEach = create("fanout-each");
  const eachA = subscribe(sharedEach, "sub-a-each", "each", 4, "A");
  const sharedB = create("fanout-b");
  const latestB = subscribe(sharedB, "sub-b-latest", "latest", 4, "B");

  // One hook fact fans out to every legal route exactly once; the other target is untouched.
  const first = event("evt-1", "4", "A", 4);
  assert.equal(first.sourceNew, true); assert.equal(first.acknowledged, true);
  assert.deepEqual(first.outcomes.map(item => item.subscriptionId).sort(), [latestA, eachA].sort());
  assert.equal(new Set(first.outcomes.map(item => item.workId)).size, 2);
  assert.equal(first.outcomes.every(item => item.outcome === "merged" || item.outcome === "pending"), true);
  assert.equal(inbox(sharedA).length, 1); assert.equal(inbox(sharedEach).length, 1); assert.equal(inbox(sharedB).length, 0);
  const duplicate = event("evt-1", "4", "A", 4);
  assert.equal(duplicate.sourceNew, false);
  assert.equal(duplicate.outcomes.every(item => item.outcome === "duplicate"), true);
  assert.equal(inbox(sharedA).length, 1); assert.equal(inbox(sharedEach).length, 1);
  assert.equal(works.ingress.routesForEvent("hook", "evt-1").length, 2);

  // latest-source wins over last-arrival; each keeps the older obligation as audit.
  const stale = event("evt-2", "1", "A", 1);
  const latestRoute = stale.outcomes.find(item => item.subscriptionId === latestA)!;
  const eachRoute = stale.outcomes.find(item => item.subscriptionId === eachA)!;
  assert.equal(latestRoute.outcome, "skipped"); assert.equal(latestRoute.reasonCode, "stale-source-version");
  assert.equal(eachRoute.outcome, "pending");
  const latestOpen = works.repo.listInbox(sharedA.workId).find(item => item.subscriptionId === latestA && item.status === "merged")!;
  assert.equal(latestOpen.payload.value, 4, "an older source version never overwrites the open batch payload");
  assert.equal(latestOpen.sourceVersion, "4");

  // Numeric ordering v9 < v10, and the first-received deadline is never extended.
  event("evt-3", "9", "A", 9);
  const firstDeadline = works.repo.listInbox(sharedA.workId).find(item => item.subscriptionId === latestA && item.status === "merged")!.batchDeadlineAt!;
  clock.at += 400;
  const tenth = event("evt-4", "10", "A", 10);
  assert.equal(tenth.outcomes.find(item => item.subscriptionId === latestA)!.outcome, "merged");
  const merged = works.repo.listInbox(sharedA.workId).find(item => item.subscriptionId === latestA && item.status === "merged")!;
  assert.equal(merged.payload.value, 10); assert.equal(merged.mergedCount, 3);
  assert.equal(merged.batchDeadlineAt, firstDeadline, "new input cannot postpone the merge deadline");

  // Same source version with different each events stays two obligations with immutable content.
  const sameVersion = create("same-version");
  const sameVersionSub = subscribe(sameVersion, "sub-same-version", "each", 4, "S");
  event("sv-1", "7", "S", 1); event("sv-2", "7", "S", 2);
  const sameVersionPending = works.repo.listInbox(sameVersion.workId, ["pending"]).filter(item => item.subscriptionId === sameVersionSub);
  assert.equal(sameVersionPending.length, 2, "each events with the same version are not version-deduped");
  const eachPending = works.repo.listInbox(sharedEach.workId, ["pending"]).filter(item => item.subscriptionId === eachA);
  assert.equal(eachPending.length, 4);
  const firstEach = eachPending.find(item => item.sourceEventId === "evt-1")!;
  const secondEach = eachPending.find(item => item.sourceEventId === "evt-2")!;
  for (const eventRow of [firstEach, secondEach]) {
    unwrap(works.dispatchExecution(user, { operationId: `bind-${eventRow.eventId}`, workId: sharedEach.workId, botId: DEFAULT_BOT_ID,
      taskId: `task-${eventRow.eventId}`, durableStoreKey: `store:${eventRow.eventId}`, conversationId: "1",
      workspaceBinding: root, inboxEventId: eventRow.eventId, causal: { source: "hook", sourceEventId: eventRow.sourceEventId, trustedRoot: true } }));
    const binding = works.repo.bindingForTask(`task-${eventRow.eventId}`)!;
    assert.equal(binding.inboxEventId, eventRow.eventId);
    const input = works.repo.executionInput(binding);
    assert.equal(JSON.parse(input).sourceEvent.payload.value, eventRow.payload.value);
  }
  const inputOne = works.repo.executionInput(works.repo.bindingForTask(`task-${firstEach.eventId}`)!);
  const inputTwo = works.repo.executionInput(works.repo.bindingForTask(`task-${secondEach.eventId}`)!);
  assert.notEqual(inputOne, inputTwo, "each workers receive their own immutable event content");
  for (const eventRow of sameVersionPending) {
    unwrap(works.dispatchExecution(user, { operationId: `same-${eventRow.eventId}`, workId: sameVersion.workId, botId: DEFAULT_BOT_ID,
      taskId: `task-${eventRow.eventId}`, durableStoreKey: `store:${eventRow.eventId}`, conversationId: "1",
      workspaceBinding: root, inboxEventId: eventRow.eventId, causal: { source: "hook", sourceEventId: eventRow.sourceEventId, trustedRoot: true } }));
    assert.equal(JSON.parse(works.repo.executionInput(works.repo.bindingForTask(`task-${eventRow.eventId}`)!)).sourceEvent.payload.value,
      eventRow.payload.value);
  }

  // Target partitions are independent: target B accepts v1 even though target A consumed v4.
  const bEvent = event("evt-b-1", "1", "B", 1);
  assert.equal(bEvent.outcomes.find(item => item.subscriptionId === latestB)!.outcome, "merged");
  assert.equal(inbox(sharedA, ["merged"]).filter(item => item.subscriptionId === latestA).length, 1);
  assert.equal(inbox(sharedA, ["skipped"]).filter(item => item.subscriptionId === latestA).length, 1);
  assert.equal(inbox(sharedA).some(item => item.subscriptionId === latestB), false);

  // Freeze is fixed and immutable: later ingress opens a new batch instead of rewriting it.
  clock.at += 2_000;
  const due = works.listDueInbox(sharedA.workId, clock.at);
  const frozen = due.find(item => item.subscriptionId === latestA)!;
  assert(frozen.frozenAt !== undefined); assert.equal(frozen.frozenPayload?.value, 10);
  assert.equal(frozen.batchDeadlineAt, firstDeadline);
  const afterFreeze = event("evt-7", "11", "A", 11);
  assert.equal(afterFreeze.outcomes.find(item => item.subscriptionId === latestA)!.outcome, "merged");
  const latestRows = works.repo.listInbox(sharedA.workId).filter(item => item.subscriptionId === latestA && item.status === "merged");
  assert.equal(latestRows.length, 2);
  assert.equal(latestRows.find(item => item.eventId === frozen.eventId)!.payload.value, 10);
  assert.equal(latestRows.find(item => item.eventId !== frozen.eventId)!.payload.value, 11);
  assert.equal(works.ingress.cursor(latestA, "hook", "A")!.highestFrozenVersion, "10");

  // Older consumed/frozen watermarks must not hide a newer accepted source version.
  const watermarkWork = create("watermark-order");
  const watermarkSub = subscribe(watermarkWork, "watermark-sub", "latest", 8, "watermark");
  event("watermark-1", "1", "watermark", 1);
  clock.at += 1_001;
  const consumedBatch = works.listDueInbox(watermarkWork.workId, clock.at)[0];
  assert(works.completeInboxEvent(consumedBatch.eventId, () => {}).ok);
  event("watermark-3", "3", "watermark", 3);
  const lateAfterConsume = event("watermark-2", "2", "watermark", 2);
  assert.equal(lateAfterConsume.outcomes[0].outcome, "skipped",
    "a lower consumed watermark cannot let a late source overwrite a newer accepted batch");
  clock.at += 1_001;
  works.listDueInbox(watermarkWork.workId, clock.at);
  event("watermark-5", "5", "watermark", 5);
  assert.equal(event("watermark-4", "4", "watermark", 4).outcomes[0].outcome, "skipped");
  const watermarks = works.ingress.cursor(watermarkSub, "hook", "watermark")!;
  assert.equal(watermarks.highestAcceptedVersion, "5");
  assert.equal(watermarks.highestFrozenVersion, "3");
  assert.equal(watermarks.highestConsumedVersion, "1");

  // Source counters may exceed JavaScript's exact integer range.
  const preciseWork = create("precise-source-version");
  const preciseSub = subscribe(preciseWork, "precise-source-sub", "latest", 8, "precise");
  event("precise-1", "9007199254740992", "precise", 1);
  assert.equal(event("precise-2", "9007199254740993", "precise", 2).outcomes[0].outcome, "merged");
  assert.equal(works.ingress.cursor(preciseSub, "hook", "precise")?.highestAcceptedVersion, "9007199254740993");

  // each keeps every obligation, while its high watermarks and consume counters stay monotonic/idempotent.
  const orderEach = create("each-watermark");
  const orderEachSub = subscribe(orderEach, "each-watermark-sub", "each", 8, "ordered-each");
  event("each-watermark-9", "9", "ordered-each", 9);
  event("each-watermark-2", "2", "ordered-each", 2);
  const outOfOrder = works.repo.listInbox(orderEach.workId, ["pending"]);
  assert.equal(outOfOrder.length, 2);
  assert.equal(works.ingress.cursor(orderEachSub, "hook", "ordered-each")?.highestAcceptedVersion, "9");
  for (const row of outOfOrder) works.ingress.markConsumed(row.eventId);
  works.ingress.markConsumed(outOfOrder[0].eventId);
  const eachCursor = works.ingress.cursor(orderEachSub, "hook", "ordered-each")!;
  assert.equal(eachCursor.highestConsumedVersion, "9");
  assert.equal(eachCursor.consumedEvents, 2, "repeated settlement does not increment the consumed counter twice");

  // A readback of an open batch cannot consume a different batch snapshot after an online merge.
  const readbackWork = create("readback-cas");
  subscribe(readbackWork, "readback-cas-sub", "latest", 8, "readback-cas");
  event("readback-cas-1", "1", "readback-cas", 1);
  const readbackBatch = works.repo.listInbox(readbackWork.workId, ["merged"])[0];
  let applyCount = 0;
  const racedRead = await works.pausedBacklog.consume(readbackBatch.eventId, async () => {
    event("readback-cas-2", "2", "readback-cas", 2);
    return "snapshot-before-merge";
  }, () => { applyCount++; });
  assert.equal(racedRead.ok, false, "an online merge during readback forces a fresh read of the saved batch");
  assert.equal(applyCount, 0);
  assert.equal(works.repo.getInbox(readbackBatch.eventId)?.status, "merged");
  assert.equal(works.repo.getInbox(readbackBatch.eventId)?.payload.value, 2);

  // Pause/replay preserves target partitions and the same accepted source watermarks.
  const pausedWork = create("paused-targets");
  const pausedSub = subscribe(pausedWork, "paused-targets-sub", "latest", 8);
  unwrap(works.pauseWork(user, { operationId: "paused-targets-pause", workId: pausedWork.workId,
    versionGuard: guard(works.getWork(pausedWork.workId)!) }));
  event("paused-a10", "10", "paused-A", 10, pausedWork.workId);
  event("paused-b11", "11", "paused-B", 11, pausedWork.workId);
  event("paused-a12", "12", "paused-A", 12, pausedWork.workId);
  assert.equal(event("paused-a9", "9", "paused-A", 9, pausedWork.workId).outcomes[0].outcome, "skipped");
  assert.equal(works.ingress.cursor(pausedSub, "hook", "paused-A")?.highestAcceptedVersion, "12");
  unwrap(works.resumeWork(user, { operationId: "paused-targets-resume", workId: pausedWork.workId,
    versionGuard: guard(works.getWork(pausedWork.workId)!) }));
  const resumedTargets = works.repo.listInbox(pausedWork.workId, ["merged"]);
  assert.deepEqual(resumedTargets.map(row => row.targetKey).sort(), ["paused-A", "paused-B"]);
  assert.equal(resumedTargets.find(row => row.targetKey === "paused-A")?.sourceVersion, "12");
  assert.equal(works.ingress.getRoute("hook", "paused-a10", pausedSub)?.inbox_event_id,
    works.ingress.getRoute("hook", "paused-a12", pausedSub)?.inbox_event_id,
    "all paused facts merged into one target batch keep a receipt pointing to that batch");
  assert(works.phase4Control(user, { kind: "stop-subscription", operationId: "paused-targets-stop",
    workId: pausedWork.workId, subscriptionId: pausedSub, versionGuard: guard(works.getWork(pausedWork.workId)!) }).ok);

  // Bounded each queue: finite overflow, then an explicit refusal that never pretends success.
  const tight = create("backpressure");
  const tightSub = subscribe(tight, "sub-tight", "each", 1, "tight", 2);
  assert.equal(event("tight-1", "1", "tight", 1).outcomes[0].outcome, "pending");
  const overflow = event("tight-2", "2", "tight", 2);
  assert.equal(overflow.outcomes[0].outcome, "blocked"); assert.equal(overflow.acknowledged, true);
  const refused = event("tight-3", "3", "tight", 3);
  assert.equal(refused.outcomes[0].outcome, "rejected"); assert.equal(refused.acknowledged, false,
    "hard capacity refusal is never acknowledged as success");
  assert.equal(works.repo.listInbox(tight.workId, ["pending", "blocked"]).length, 2);
  assert(works.repo.listInbox(tight.workId, ["blocked"]).length === 1);
  assert.equal(works.repo.listOpenBlockers(tight.workId).find(item => item.reasonCode === "backlog-overflow")?.kind, "backpressure");
  assert(works.completeInboxEvent(works.repo.listInbox(tight.workId, ["pending"])[0].eventId, () => {}).ok);
  assert(works.phase4Control(user, { kind: "retry-backlog", operationId: "retry-tight", workId: tight.workId,
    subscriptionId: tightSub, versionGuard: guard(works.getWork(tight.workId)!) }).ok);
  assert.equal(works.repo.listInbox(tight.workId, ["blocked"]).length, 0, "bounded overflow is refilled, not dropped");
  const retried = event("tight-3", "3", "tight", 3);
  assert.equal(retried.outcomes[0].outcome, "blocked", "a previously refused route can be redelivered");
  assert.equal(works.repo.listInbox(tight.workId, ["pending", "blocked"]).length, 2);
  assert.equal(works.repo.listInbox(tight.workId, ["processed"]).length, 1);

  // Two independent SQLite connections: the version comparison already owns the write
  // transaction, and another connection cannot observe or alter a partial route/cursor.
  const atomicOne = create("atomic-fanout-one");
  const atomicSub = subscribe(atomicOne, "atomic-sub-one", "latest", 8, "atomic");
  const atomicTwo = create("atomic-fanout-two");
  const atomicOtherSub = subscribe(atomicTwo, "atomic-sub-two", "latest", 8, "atomic");
  event("atomic-10", "10", "atomic", 10);
  const competingDb = new AppDatabase(path);
  competingDb.connection.pragma("busy_timeout = 0");
  const competing = new WorkService(competingDb.connection, {
    bots: new BotRegistry(competingDb.connection), now: () => clock.at,
  });
  const originalAdapter = works.ingress.adapter("hook")!;
  let lockChecks = 0;
  try {
    works.ingress.registerAdapter({ ...originalAdapter, compareVersion: (left, right) => {
      if (left === "12" && right === "10") {
        assert.equal(db.connection.inTransaction, true);
        assert.equal(competing.ingress.cursor(atomicSub, "hook", "atomic")?.highestAcceptedVersion, "10");
        assert.equal(competing.ingress.getRoute("hook", "atomic-12", atomicSub), undefined);
        assert.throws(() => competingDb.connection.exec("BEGIN IMMEDIATE"),
          error => (error as { code?: string }).code === "SQLITE_BUSY",
          "a competing writer cannot change the cursor between version admission and the Inbox update");
        lockChecks++;
      }
      return undefined;
    } });
    event("atomic-12", "12", "atomic", 12);
    assert(lockChecks > 0);
    works.ingress.registerAdapter(originalAdapter);
    const late = competing.ingestSourceEvent({ source: "hook", sourceEventId: "atomic-11", eventType: "changed",
      sourceVersion: "11", payload: { target: "atomic", value: 11 } });
    assert.equal(late.outcomes.every(route => route.outcome === "skipped"), true);
    assert.equal(competing.ingress.cursor(atomicSub, "hook", "atomic")?.highestAcceptedVersion, "12");

    // Failure in the second subscription rolls the entire source fanout back, including
    // the first subscription's merged payload, receipt and high watermark.
    db.connection.exec(`CREATE TEMP TRIGGER fail_atomic_fanout BEFORE INSERT ON work_ingress_routes
      WHEN NEW.source_event_id='atomic-14' AND NEW.subscription_id='${atomicOtherSub}'
      BEGIN SELECT RAISE(ABORT, 'injected atomic fanout failure'); END;`);
    assert.throws(() => event("atomic-14", "14", "atomic", 14), /injected atomic fanout failure/);
    db.connection.exec("DROP TRIGGER fail_atomic_fanout");
    assert.equal(competingDb.connection.prepare("SELECT 1 FROM work_source_events WHERE source='hook' AND source_event_id='atomic-14'").get(), undefined);
    assert.equal(competing.ingress.getRoute("hook", "atomic-14", atomicSub), undefined);
    assert.equal(competing.ingress.cursor(atomicSub, "hook", "atomic")?.highestAcceptedVersion, "12");
    assert.equal(competing.repo.listInbox(atomicOne.workId, ["merged"])[0].payload.value, 12);
    assert.equal(event("atomic-14", "14", "atomic", 14).sourceNew, true,
      "the rolled-back event can be delivered again as a new durable source fact");
  } finally {
    works.ingress.registerAdapter(originalAdapter);
    db.connection.exec("DROP TRIGGER IF EXISTS fail_atomic_fanout");
    competingDb.close();
  }

  // watchRule.subscriptions is a source-name set, never a subscription primary key.
  const watchSource = unwrap(works.createWork(user, { operationId: "watch-source-identity", title: "watch source identity",
    inputSnapshotId: "input:watch-source", authorization: DESKTOP_USER_GRANTS, workspacePath: root, mode: "watch",
    watchRule: { subscriptions: ["hook"], catchUpPolicy: "latest", maxMergeWaitMs: 1_000, maxQueueDepth: 8 } }));
  const installed = works.repo.listSubscriptions(watchSource.workId);
  assert.equal(installed.length, 1); assert.equal(installed[0].source, "hook");
  const addedSameSource = works.addSubscription(user, watchSource.workId, { source: "hook", catchUpPolicy: "latest",
    maxMergeWaitMs: 2_000, maxQueueDepth: 4 });
  assert.equal(addedSameSource.ok, true);
  assert.equal(addedSameSource.ok ? addedSameSource.subscription.subscriptionId : "", installed[0].subscriptionId,
    "the same source is idempotent instead of creating a second subscription");
  assert.deepEqual(works.getWork(watchSource.workId)!.watchRule!.subscriptions, ["hook"],
    "addSubscription records the source name, not the subscription key");
  unwrap(works.amendWork(user, { operationId: "watch-source-amend", workId: watchSource.workId,
    watchRule: { subscriptions: ["hook"], catchUpPolicy: "latest", maxMergeWaitMs: 2_000, maxQueueDepth: 4 },
    versionGuard: guard(works.getWork(watchSource.workId)!) }));
  const steady = works.repo.listSubscriptions(watchSource.workId);
  assert.equal(steady.length, 1, "a watchRule update keeps the existing source subscription");
  assert.equal(steady[0].source, "hook"); assert.equal(steady[0].stoppedAt, undefined);
  assert.equal(steady.some(item => item.source === item.subscriptionId), false,
    "no subscription row is created from a subscription primary key");
  assert.deepEqual(works.getWork(watchSource.workId)!.watchRule!.subscriptions, ["hook"]);

  // Close/reopen preserves route receipts and target cursors.
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection); bots.registerBot({ userId: LOCAL_USER_ID,
    botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  const reopened = new WorkService(db.connection, { bots, now: () => clock.at });
  assert.equal(reopened.ingress.routesForEvent("hook", "evt-1").length, 2);
  assert.equal(reopened.repo.listInbox(sharedEach.workId).length, 4);
  assert.equal(reopened.ingress.listCursors(tightSub).length, 1);
  console.log("Phase 4 BW-A36 fanout: per-route receipts, latest-source ordering, immutable each content, target partitions, bounded overflow and durable restart passed");
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
