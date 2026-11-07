import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase4-offline-"));
const path = join(root, "business.db");
const clock = { at: Date.UTC(2026, 0, 10, 12, 0, 0) };
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
// Previous host heartbeat is one hour old: an evidenced offline interval, not a guess.
db.connection.prepare(`INSERT INTO work_host_lease(lease_id,authority_id,acquired_at,heartbeat_at,released_at)
  VALUES ('singleton','old-host',?,?,NULL)`).run(clock.at - 3_600_000, clock.at - 3_600_000);
let authority = new WorkHostAuthority(db.connection, "authority-offline", 60_000, () => clock.at);
const previous = authority.snapshot();
authority.start();
let works = new WorkService(db.connection, { bots, now: () => clock.at, isAuthority: () => authority.isAuthority() });
works.ingress.registerAdapter({ source: "repo", namespace: "fixture-repo", versionMode: "monotonic",
  targetKeyOf: input => String(input.payload.target ?? "default"), canQueryHistory: true, supportsRetry: true,
  maxPayloadBytes: 1024 * 1024 });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const file = join(root, "watched.txt");
await writeFile(file, "v1");
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, workspacePath: root,
  inputSnapshotId: `sha256:v1`, goalSources: [{ sourceType: "file", sourceRef: file, inputSnapshotId: "sha256:v1", observedAt: clock.at }],
  authorization: DESKTOP_USER_GRANTS, mode: "watch" }));
function subscribe(work: WorkDto, id: string, source: string, policy: "latest" | "each" | "skip", target = "default") {
  const result = works.phase4Control(user, { kind: "configure-subscription", operationId: id, workId: work.workId,
    source, catchUpPolicy: policy, maxMergeWaitMs: 1_000, maxQueueDepth: 8, targetKey: target, versionMode: "monotonic",
    versionGuard: guard(works.getWork(work.workId)!) });
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.subscriptionId!;
}

try {
  const work = create("offline-work");
  const latestSub = subscribe(work, "sub-latest", "repo", "latest");
  const eachSub = subscribe(work, "sub-each", "repo", "each", "each-target");
  const skipSub = subscribe(work, "sub-skip", "repo", "skip", "skip-target");
  const unknownSub = subscribe(work, "sub-unknown", "hook", "latest", "hook-target");
  const gaps = works.scheduler.beginHostSession(previous, clock.at);
  assert.equal(gaps.length, 4, "one durable gap per active subscription");
  assert.equal(gaps.every(gap => gap.offlineGapFrom === clock.at - 3_600_000 && gap.offlineGapTo === clock.at), true);
  assert.equal(gaps.find(gap => gap.subscriptionId === latestSub)!.policy, "latest");
  assert.equal(gaps.find(gap => gap.subscriptionId === unknownSub)!.queryable, false);
  assert.equal(new Set(gaps.map(gap => gap.gapId)).size, 4);

  // latest: one authoritative readback batch; the local Inbox is never treated as proof of no events.
  const latestGap = gaps.find(gap => gap.subscriptionId === latestSub)!;
  const applied = works.scheduler.applyGap(latestGap.gapId)!;
  assert.equal(applied.state, "recovered"); assert.equal(applied.queryable, true);
  assert.equal(works.scheduler.applyGap(latestGap.gapId)!.mergedCount, 1, "duplicate recovery notification reuses the gap");
  const catchup = works.repo.listInbox(work.workId, ["merged"]).filter(item => item.subscriptionId === latestSub);
  assert.equal(catchup.length, 1); assert.equal(catchup[0].payload.authoritativeReadbackRequired, true);
  assert.equal(catchup[0].payload.offlineGapId, latestGap.gapId);
  assert.equal(works.getWork(work.workId)!.inputSnapshotId, "sha256:v1", "catch-up does not pretend the old target is current");
  clock.at += 1_500;
  assert(works.listDueInbox(work.workId, clock.at).some(item => item.subscriptionId === latestSub),
    "the latest catch-up is ready after the fixed merge deadline");

  // each: bounded replay through the same ingress; worker obligations carry their original payloads.
  const eachGap = gaps.find(gap => gap.subscriptionId === eachSub)!;
  const awaitingHistory = works.scheduler.applyGap(eachGap.gapId)!;
  assert.equal(awaitingHistory.state, "recovering",
    "a queryable adapter declaration is not an empty history result");
  assert.equal(awaitingHistory.recoveredCount, 0);
  assert(awaitingHistory.gapReason?.includes("回查"));
  const replay = works.scheduler.applyGap(eachGap.gapId, { events: [
    { sourceEventId: "offline-e1", eventType: "changed", sourceVersion: "1", payload: { target: "each-target", n: 1 } },
    { sourceEventId: "offline-e2", eventType: "changed", sourceVersion: "2", payload: { target: "each-target", n: 2 } },
  ] })!;
  assert.equal(replay.recoveredCount, 2); assert.equal(replay.state, "recovering");
  const eachRows = works.repo.listInbox(work.workId, ["pending"]).filter(item => item.subscriptionId === eachSub);
  assert.equal(eachRows.length, 2);
  assert.deepEqual(eachRows.map(item => item.payload.n).sort(), [1, 2]);

  // Backpressure cannot advance the recovery cursor past an unacknowledged obligation.
  assert(works.phase4Control(user, { kind: "configure-subscription", operationId: "each-offline-capacity",
    workId: work.workId, subscriptionId: eachSub, source: "repo", catchUpPolicy: "each", maxQueueDepth: 2,
    maxBacklogEvents: 2, versionGuard: guard(works.getWork(work.workId)!) }).ok);
  const nextPage = [
    { sourceEventId: "offline-e3", eventType: "changed", sourceVersion: "3", payload: { target: "each-target", n: 3 } },
    { sourceEventId: "offline-e4", eventType: "changed", sourceVersion: "4", payload: { target: "each-target", n: 4 } },
  ];
  const cursor = () => (db.connection.prepare("SELECT continuation_cursor FROM work_offline_gaps WHERE gap_id=?")
    .get(eachGap.gapId) as { continuation_cursor: string | null }).continuation_cursor;
  const refusedPage = works.scheduler.applyGap(eachGap.gapId, { events: nextPage })!;
  assert.equal(refusedPage.recoveredCount, 2); assert.equal(refusedPage.state, "recovering");
  assert.equal(cursor(), "offline-e2", "the first refused event leaves the last accepted cursor unchanged");
  assert.equal(works.ingress.getRoute("repo", "offline-e4", eachSub), undefined,
    "replay stops at the first refusal instead of accepting later events out of order");
  assert(works.completeInboxEvent(eachRows[0].eventId, () => {}).ok);
  const partialPage = works.scheduler.applyGap(eachGap.gapId, { events: nextPage })!;
  assert.equal(partialPage.recoveredCount, 3); assert.equal(cursor(), "offline-e3");
  const repeatedPartial = works.scheduler.applyGap(eachGap.gapId, { events: nextPage })!;
  assert.equal(repeatedPartial.recoveredCount, 3, "replaying an accepted prefix does not inflate the recovered count");
  assert.equal(cursor(), "offline-e3");
  assert(works.completeInboxEvent(eachRows[1].eventId, () => {}).ok);
  const lastPage = works.scheduler.applyGap(eachGap.gapId, { events: nextPage })!;
  assert.equal(lastPage.recoveredCount, 4); assert.equal(cursor(), "offline-e4");
  assert.equal(works.scheduler.applyGap(eachGap.gapId, { events: nextPage })!.recoveredCount, 4);
  const finished = works.scheduler.applyGap(eachGap.gapId, { events: [] })!;
  assert.equal(finished.state, "recovered", "only an explicit terminal history page closes the gap");

  // skip: the missed interval is an explicit, unknowable count; new online events still work.
  const skipGap = gaps.find(gap => gap.subscriptionId === skipSub)!;
  const skipped = works.scheduler.applyGap(skipGap.gapId)!;
  assert.equal(skipped.state, "recovered"); assert.equal(skipped.skippedCount, undefined);
  assert.equal(works.repo.listInbox(work.workId).filter(item => item.subscriptionId === skipSub).length, 0);
  const online = works.ingestSourceEvent({ source: "repo", sourceEventId: "online-after-gap", eventType: "changed",
    sourceVersion: "3", payload: { target: "skip-target", n: 3 } });
  assert.equal(online.outcomes.find(item => item.subscriptionId === skipSub)!.outcome, "pending");

  // A source without history cannot erase the unknown gap with its current state.
  const unknownGap = gaps.find(gap => gap.subscriptionId === unknownSub)!;
  const unqueryable = works.scheduler.applyGap(unknownGap.gapId)!;
  assert.equal(unqueryable.state, "unqueryable"); assert.equal(unqueryable.queryable, false);
  const blocker = works.repo.listOpenBlockers(work.workId).find(item => item.reasonCode === "unqueryable-offline-gap");
  assert(blocker); assert.equal(blocker.kind, "operational");

  // Resume notifications are idempotent: same session/from yields the same gap rows.
  clock.at += 300_000;
  const resumed = works.scheduler.resume(clock.at);
  const resumedAgain = works.scheduler.resume(clock.at);
  assert.equal(resumed.length, 4); assert.equal(resumedAgain.length, 4);
  assert.deepEqual(resumed.map(item => item.gapId).sort(), resumedAgain.map(item => item.gapId).sort());

  authority.heartbeat();
  const projection = works.getProjection(work.workId)!;
  assert.equal(projection.phase4!.offlineGaps.length >= 4, true);
  assert.equal(projection.phase4!.offlineGaps.some(item => item.state === "unqueryable" && item.unknownCount === undefined), true);
  assert.equal(projection.phase4!.subscriptions.every(item => item.status === "online"), true);
  authority.release();
  assert.equal(works.scheduler.hostState().online, false, "a released host is never shown as continuously running");
  assert.equal(works.getProjection(work.workId)!.phase4!.subscriptions.every(item => item.status === "offline"), true);

  // Restart keeps gaps, policy snapshots and route receipts.
  const gapCount = db.connection.prepare("SELECT COUNT(*) AS n FROM work_offline_gaps").get() as { n: number };
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  authority = new WorkHostAuthority(db.connection, "authority-offline-2", 60_000, () => clock.at);
  authority.start();
  works = new WorkService(db.connection, { bots, now: () => clock.at, isAuthority: () => authority.isAuthority() });
  const reopened = works.getProjection(work.workId)!;
  assert.equal(reopened.phase4!.offlineGaps.length, gapCount.n);
  assert.equal(reopened.phase4!.offlineGaps.some(item => item.state === "unqueryable"), true);
  assert.equal(works.repo.listInbox(work.workId, ["pending"]).filter(item => item.subscriptionId === eachSub).length, 2);
  console.log("Phase 4 BW-A37 offline: evidenced gaps, bounded latest/each/skip recovery, unqueryable history, idempotent resume and honest offline projection passed");
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
