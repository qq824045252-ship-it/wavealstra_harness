import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase4-backpressure-"));
const path = join(root, "business.db");
const clock = { at: Date.UTC(2026, 0, 5, 12, 0, 0) };
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots, now: () => clock.at });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`,
  authorization: DESKTOP_USER_GRANTS, workspacePath: root, mode: "watch" }));
function subscribe(work: WorkDto, id: string, policy: "latest" | "each" | "skip", depth: number, mergeWait: number, backlog?: number) {
  const result = works.phase4Control(user, { kind: "configure-subscription", operationId: id, workId: work.workId,
    source: "hook", catchUpPolicy: policy, maxMergeWaitMs: mergeWait, maxQueueDepth: depth, maxBacklogEvents: backlog,
    versionMode: "monotonic", versionGuard: guard(works.getWork(work.workId)!) });
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.subscriptionId!;
}
const event = (id: string, version: string, payload: Record<string, unknown> = {}) =>
  works.ingestSourceEvent({ source: "hook", sourceEventId: id, eventType: "changed", sourceVersion: version, payload });

try {
  // Continuous latest input cannot postpone the first deadline forever.
  const continuous = create("continuous");
  const continuousSub = subscribe(continuous, "continuous-sub", "latest", 64, 100);
  const start = clock.at;
  for (let n = 0; n < 6; n++) { clock.at = start + n * 20; event(`continuous-${n}`, String(n), { n }); }
  const firstBatch = works.repo.listInbox(continuous.workId, ["merged"])[0];
  assert.equal(firstBatch.batchDeadlineAt, start + 100);
  assert.equal(firstBatch.payload.n, 4, "the deadline freezes the batch before the next input can merge into it");
  clock.at = start + 101;
  const ready = works.listDueInbox(continuous.workId, clock.at);
  assert.equal(ready.length, 1); assert(ready[0].frozenAt !== undefined);
  const frozenPayload = ready[0].frozenPayload!.n;
  const afterFreeze = event("continuous-6", "6", { n: 6 });
  assert.equal(afterFreeze.outcomes[0].outcome, "merged");
  const batches = works.repo.listInbox(continuous.workId, ["merged"]);
  assert.equal(batches.length, 2, "events after the frozen deadline start a new batch");
  assert.equal(batches.find(item => item.eventId === ready[0].eventId)!.payload.n, frozenPayload, "the frozen snapshot is immutable");
  assert.equal(works.repo.listInbox(continuous.workId, ["merged"]).filter(item => item.frozenAt !== undefined).length, 1);

  // each queue and the finite overflow both have hard limits; refusal is explicit.
  const bounded = create("bounded");
  const boundedSub = subscribe(bounded, "bounded-sub", "each", 2, 100, 4);
  const outcomeFor = (id: string, version: string, subscriptionId: string) =>
    event(id, version).outcomes.find(item => item.subscriptionId === subscriptionId)!;
  for (const n of [1, 2]) assert.equal(outcomeFor(`bounded-${n}`, String(n), boundedSub).outcome, "pending");
  for (const n of [3, 4]) assert.equal(outcomeFor(`bounded-${n}`, String(n), boundedSub).outcome, "blocked");
  const refused = event("bounded-5", "5");
  assert.equal(refused.outcomes.find(item => item.subscriptionId === boundedSub)!.outcome, "rejected");
  assert.equal(refused.acknowledged, false, "hard capacity refusal is never ACKed");
  assert.equal(works.repo.listInbox(bounded.workId, ["pending", "blocked"]).length, 4);
  assert.equal(works.repo.listInbox(bounded.workId, ["blocked"]).length, 2);
  const backpressure = works.repo.listOpenBlockers(bounded.workId).find(item => item.reasonCode === "backlog-overflow")!;
  assert.equal(backpressure.kind, "backpressure");
  assert.equal(backpressure.details?.maxEvents, 2);
  assert.equal(backpressure.details?.maxBytes, 8 * 1024 * 1024);
  assert.equal(works.getProjection(bounded.workId)!.phase4!.subscriptions[0].queue.blocked, 2);
  assert(works.getProjection(bounded.workId)!.phase4!.subscriptions[0].queue.waitReason);

  // Slow consumer: a re-delivery of the same source fact never doubles the obligation.
  const beforeDuplicate = works.repo.listInbox(bounded.workId, ["pending", "blocked"]).length;
  const duplicate = event("bounded-1", "1");
  assert.equal(duplicate.outcomes.find(item => item.subscriptionId === boundedSub)!.outcome, "duplicate");
  assert.equal(works.repo.listInbox(bounded.workId, ["pending", "blocked"]).length, beforeDuplicate);

  // Consume, refill, and let the refused source retry; no accepted fact is silently lost.
  const pending = works.repo.listInbox(bounded.workId, ["pending"]);
  for (const row of pending) assert(works.completeInboxEvent(row.eventId, () => {}).ok);
  assert(works.phase4Control(user, { kind: "retry-backlog", operationId: "refill-1", workId: bounded.workId,
    subscriptionId: boundedSub, versionGuard: guard(works.getWork(bounded.workId)!) }).ok);
  assert.equal(works.repo.listInbox(bounded.workId, ["pending"]).length, 2);
  assert.equal(works.repo.listInbox(bounded.workId, ["blocked"]).length, 0);
  const retried = event("bounded-5", "5");
  assert.equal(retried.outcomes.find(item => item.subscriptionId === boundedSub)!.outcome, "blocked",
    "the previously refused route accepts a redelivery");
  assert.equal(works.repo.listInbox(bounded.workId, ["pending", "blocked"]).length, 3);
  assert.equal(works.repo.listInbox(bounded.workId, ["processed"]).length, 2);
  const promoted = works.repo.listInbox(bounded.workId, ["pending"])[0];
  unwrap(works.dispatchExecution(user, { operationId: "bounded-bind", workId: bounded.workId, botId: DEFAULT_BOT_ID,
    taskId: "bounded-task", durableStoreKey: "store:bounded", conversationId: "1", workspaceBinding: root,
    inboxEventId: promoted.eventId, causal: { source: "hook", sourceEventId: promoted.sourceEventId, trustedRoot: true } }));
  assert.equal(JSON.parse(works.repo.executionInput(works.repo.bindingForTask("bounded-task")!)).sourceEvent.eventId, promoted.sourceEventId);

  // Stop the earlier subscriptions so the fairness measurement has no unrelated fan-out.
  for (const [work, subscription] of [[continuous, continuousSub], [bounded, boundedSub]] as const) {
    works.phase4Control(user, { kind: "stop-subscription", operationId: `stop-${work.workId}`, workId: work.workId,
      subscriptionId: subscription, reason: "fairness fixture", versionGuard: guard(works.getWork(work.workId)!) });
  }
  // One high-volume subscription cannot starve another Work's fixed deadline.
  const noisy = create("noisy");
  subscribe(noisy, "noisy-sub", "latest", 64, 1_000);
  const quiet = create("quiet");
  subscribe(quiet, "quiet-sub", "latest", 8, 50);
  clock.at = Date.UTC(2026, 0, 6, 9, 0, 0);
  event("quiet-1", "1", { q: 1 });
  for (let n = 0; n < 100; n++) event(`noisy-${n}`, String(n), { n });
  clock.at += 51;
  assert(works.listDueInbox(quiet.workId, clock.at).some(item => item.frozenAt !== undefined),
    "the bounded deadline is honored while another subscription is flooded");
  assert.equal(works.repo.listInbox(quiet.workId, ["merged"]).length, 1);

  // A blocked queue does not block other Works' deadlines or result settlement.
  const deadlineWork = create("deadline-other");
  works.phase4Control(user, { kind: "set-deadline", operationId: "deadline-other-set", workId: deadlineWork.workId,
    deadlineAt: clock.at + 10, versionGuard: guard(works.getWork(deadlineWork.workId)!) });
  clock.at += 20;
  works.tick(clock.at);
  assert.equal(works.repo.listInbox(deadlineWork.workId, ["pending"]).filter(item => item.eventType === "deadline_expired").length, 1);
  assert.equal("budget" in works.getWork(bounded.workId)!, false, "backpressure does not introduce quota state");

  // Resolve the remaining overflow and clear the single persistent blocker.
  for (const row of works.repo.listInbox(bounded.workId, ["pending"])) works.completeInboxEvent(row.eventId, () => {});
  works.phase4Control(user, { kind: "retry-backlog", operationId: "refill-2", workId: bounded.workId,
    subscriptionId: boundedSub, versionGuard: guard(works.getWork(bounded.workId)!) });
  for (const row of works.repo.listInbox(bounded.workId, ["pending"])) works.completeInboxEvent(row.eventId, () => {});
  works.phase4Control(user, { kind: "retry-backlog", operationId: "refill-3", workId: bounded.workId,
    subscriptionId: boundedSub, versionGuard: guard(works.getWork(bounded.workId)!) });
  assert.equal(works.repo.listInbox(bounded.workId, ["blocked"]).length, 0);
  assert.equal(works.repo.listOpenBlockers(bounded.workId).some(item => item.reasonCode === "backlog-overflow"), false,
    "the same projection removes the resolved backpressure blocker");

  // Paused overflow stored as source routes counts toward the same hard limits.
  const paused = create("paused-capacity");
  const pausedSub = subscribe(paused, "paused-capacity-sub", "each", 1, 100, 2);
  unwrap(works.pauseWork(user, { operationId: "pause-capacity", workId: paused.workId,
    versionGuard: guard(works.getWork(paused.workId)!) }));
  const pausedEvent = (id: string) => works.ingestSourceEvent({ workId: paused.workId, subscriptionId: pausedSub,
    source: "hook", sourceEventId: id, eventType: "changed", sourceVersion: id,
    payload: { target: "paused-capacity", id } });
  assert.equal(pausedEvent("paused-capacity-1").outcomes[0].outcome, "pending");
  assert.equal(pausedEvent("paused-capacity-2").outcomes[0].outcome, "blocked");
  const pausedRefused = pausedEvent("paused-capacity-3");
  assert.equal(pausedRefused.outcomes[0].outcome, "rejected");
  assert.equal(pausedRefused.acknowledged, false, "source-only overflow is bounded before it is acknowledged");
  assert.equal(works.ingress.queueStats(works.repo.getSubscription(pausedSub)!).blocked, 1);
  unwrap(works.resumeWork(user, { operationId: "resume-capacity", workId: paused.workId,
    versionGuard: guard(works.getWork(paused.workId)!) }));
  assert(works.completeInboxEvent(works.repo.listInbox(paused.workId, ["pending"])[0].eventId, () => {}).ok);
  works.transaction(() => works.pausedBacklog.refill(paused.workId, clock.at));
  const refilled = works.repo.listInbox(paused.workId, ["pending"])[0];
  assert.equal(refilled.sourceEventId, "paused-capacity-2");
  assert.equal(refilled.targetKey, "paused-capacity");
  assert.equal(works.ingress.getRoute("hook", "paused-capacity-2", pausedSub)?.inbox_event_id, refilled.eventId);

  // Restart keeps the bounded state, routes and batch identities.
  const frozenIds = works.repo.listInbox(continuous.workId, ["merged"]).map(item => item.eventId).sort();
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection, { bots, now: () => clock.at });
  assert.deepEqual(works.repo.listInbox(continuous.workId, ["merged"]).map(item => item.eventId).sort(), frozenIds);
  assert.equal(works.ingress.getRoute("hook", "bounded-1", boundedSub)?.state, "accepted");
  assert.equal(works.ingress.getRoute("hook", "bounded-5", boundedSub)?.state, "blocked");
  console.log("Phase 4 BW-A41 backpressure: fixed merge deadlines, immutable frozen batches, bounded each queue/overflow, explicit refusal and redelivery, fairness and restart passed");
} finally {
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
