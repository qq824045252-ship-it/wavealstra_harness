import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { mergeWorkList, reconcileWorkProjection } from "../src/renderer/src/store/app/slices/botWorkSync";
import type { WorkActor, WorkControlResult, WorkDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkListCursor } from "../src/shared/bot-conversation";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

/**
 * BW-A45/BW-A46: reconnect from the durable journal, atomic replacement across
 * epoch/scope, and a summary that stays decision-shaped next to on-demand evidence.
 */

const root = mkdtempSync(join(tmpdir(), "phase5-reconnect-"));
const db = new AppDatabase(join(root, "work.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: DEFAULT_BOT_ID, authorization: grants });
let clock = 1_700_000_000_000;
const works = new WorkService(db.connection, { bots, now: () => clock });
const journal = new WorkProjectionJournal(db.connection, works);
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const passes: string[] = [];
const check = (name: string, run: () => void) => { run(); passes.push(name); console.log(`PASS ${name}`); };

let sequence = 0;
function fixture(name: string) {
  const suffix = `${name}-${++sequence}`;
  let work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix,
    authorization: grants, inputSnapshotId: `input:${suffix}`,
    criteria: [{ text: "Automated evidence" }, { text: "Omarchy desktop check", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }] }));
  const taskId = `task:${suffix}`;
  db.upsertTask({ id: taskId, title: suffix, updatedAt: clock });
  work = unwrap(works.dispatchExecution(user, { operationId: `dispatch:${suffix}`, workId: work.workId, botId: DEFAULT_BOT_ID,
    taskId, durableStoreKey: `store:${suffix}`, conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"] }));
  const binding = works.repo.listBindings(work.workId)[0];
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  return { suffix, work, binding, worker };
}
function accepted(name: string) {
  const f = fixture(name);
  unwrap(works.submitDeliverable(f.worker, { operationId: `deliver:${f.suffix}`, workId: f.work.workId,
    bindingId: f.binding.bindingId, deliverableId: `deliverable:${f.suffix}`, summary: "Confirmed result",
    evidence: [{ kind: "tool_receipt", sourceRef: `receipt:${f.suffix}` }] }));
  const work = unwrap(works.acceptDeliverable(user, { operationId: `accept:${f.suffix}`, workId: f.work.workId,
    deliverableId: `deliverable:${f.suffix}` }));
  works.reconcileExecution(user, { bindingId: f.binding.bindingId, outcome: "completed" });
  return { ...f, work, card: works.cards.list(works.getWork(work.workId)!)[0]! };
}
const sync = (cursor: WorkListCursor | undefined, includeClosed = false) =>
  journal.sync(LOCAL_USER_ID, { includeClosed, ...(cursor ? { cursor } : {}) });
const stateOf = (update: ReturnType<typeof sync>): { works: WorkProjectionDto[]; cursor: WorkListCursor } => {
  if (update.kind === "snapshot") return { works: update.works, cursor: update.cursor };
  if (update.kind === "delta") return { works: [], cursor: update.cursor };
  throw new Error("unexpected resync_required");
};

// ------------------------------------------------------- journal and cursors

check("a read fact reaches another device without changing the Work version", () => {
  const f = accepted("read-sync");
  const snapshot = sync(undefined);
  const cursor = snapshot.kind === "snapshot" ? snapshot.cursor : assert.fail("expected snapshot");
  const before = works.getWork(f.work.workId)!;
  clock += 5_000;
  works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: f.card.semanticCardKey });
  const delta = sync(cursor);
  assert.equal(delta.kind, "delta");
  if (delta.kind !== "delta") return;
  const event = delta.events.find(item => item.kind === "upsert" && item.projection.workId === f.work.workId);
  assert.ok(event && event.kind === "upsert");
  if (event?.kind !== "upsert") return;
  const after = works.getWork(f.work.workId)!;
  assert.equal(after.stateVersion, before.stateVersion, "the read did not bump the Work version");
  assert.equal(event.projection.cards?.[0]?.readAt, clock, "the read still reaches the other device");
  assert.equal(event.projection.stateVersion, before.stateVersion);
});

check("the card-read helper commits its read fact and Journal wake together", () => {
  const f = accepted("read-helper-snapshot");
  const observer = new Database(db.connection.name, { readonly: true });
  const readCard = () => observer.prepare("SELECT read_at,read_version FROM work_result_cards WHERE card_key=?").get(f.card.cardKey);
  const readSequence = () => observer.prepare("SELECT sequence FROM work_projection_streams WHERE user_id=?").get(LOCAL_USER_ID);
  const beforeCard = readCard();
  const beforeSequence = readSequence();
  const beforeWork = works.getWork(f.work.workId)!;
  let observations = 0;
  db.connection.function("phase5_observe_read", () => {
    observations += 1;
    assert.deepEqual(readCard(), beforeCard, "another connection sees no intermediate read fact");
    assert.deepEqual(readSequence(), beforeSequence, "the Journal wake stays uncommitted with the read fact");
    return 1;
  });
  db.connection.exec(`CREATE TEMP TRIGGER phase5_observe_read AFTER UPDATE OF read_at ON work_result_cards
    BEGIN SELECT phase5_observe_read(); END`);
  try {
    const result = works.cards.markRead({ workId: f.work.workId, semanticCardKey: f.card.semanticCardKey,
      userId: LOCAL_USER_ID, readAt: clock });
    assert.equal(result.ok, true);
    assert.equal(result.readVersion, 1);
    assert.equal(result.replayed, false);
    assert.equal(observations, 1);
    assert.deepEqual(readCard(), { read_at: clock, read_version: result.readVersion });
    assert.notDeepEqual(readSequence(), beforeSequence, "both facts become visible after commit");
    assert.deepEqual(works.getWork(f.work.workId), beforeWork, "reading has no Work control side effects");

    const committedSequence = readSequence();
    const replay = works.cards.markRead({ workId: f.work.workId, semanticCardKey: f.card.semanticCardKey,
      userId: LOCAL_USER_ID, readAt: clock - 1 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.readAt, clock);
    assert.equal(replay.readVersion, result.readVersion);
    assert.deepEqual(readSequence(), committedSequence, "an older read does not invent a Journal event");
    assert.equal(observations, 1, "an older read does not update the card");
    const foreign = works.cards.markRead({ workId: f.work.workId, semanticCardKey: f.card.semanticCardKey,
      userId: "another-user", readAt: clock + 1 });
    assert.equal(foreign.ok, false);
    assert.deepEqual(readSequence(), committedSequence, "a rejected reader cannot wake the owner stream");
    assert.deepEqual(readCard(), { read_at: clock, read_version: result.readVersion });
  } finally {
    db.connection.exec("DROP TRIGGER phase5_observe_read");
    observer.close();
  }
});

check("a card-read readback failure rolls back its update and Journal wake", () => {
  const f = accepted("read-helper-rollback");
  const beforeWork = works.getWork(f.work.workId)!;
  const beforeCard = works.cards.list(beforeWork)[0]!;
  const readStream = () => db.connection.prepare("SELECT * FROM work_projection_streams WHERE user_id=?").get(LOCAL_USER_ID);
  const beforeStream = readStream();
  const beforeEvents = db.connection.prepare("SELECT * FROM work_projection_events WHERE user_id=? ORDER BY sequence").all(LOCAL_USER_ID);
  // A valid SQLite write with an invalid DTO forces the failure after UPDATE and its
  // Journal trigger. Without a surrounding transaction these writes would be retained.
  db.connection.exec(`CREATE TEMP TRIGGER phase5_corrupt_readback AFTER UPDATE OF read_at ON work_result_cards
    BEGIN UPDATE work_result_cards SET read_version='invalid-read-version' WHERE card_key=NEW.card_key; END`);
  try {
    assert.throws(() => works.cards.markRead({ workId: f.work.workId,
      semanticCardKey: f.card.semanticCardKey, userId: LOCAL_USER_ID, readAt: clock }),
    error => error instanceof Error && error.name === "ZodError");
    assert.deepEqual(works.cards.list(works.getWork(f.work.workId)!)[0], beforeCard);
    assert.deepEqual(readStream(), beforeStream, "a failed readback cannot advance the Journal cursor");
    assert.deepEqual(db.connection.prepare("SELECT * FROM work_projection_events WHERE user_id=? ORDER BY sequence").all(LOCAL_USER_ID), beforeEvents);
    assert.deepEqual(works.getWork(f.work.workId), beforeWork);
  } finally {
    db.connection.exec("DROP TRIGGER phase5_corrupt_readback");
  }
  assert.equal(works.cards.markRead({ workId: f.work.workId, semanticCardKey: f.card.semanticCardKey,
    userId: LOCAL_USER_ID, readAt: clock }).readVersion, 1, "the next read starts from the rolled-back version");
});

check("a stale delta cannot roll back a locally newer accepted result", () => {
  const f = accepted("stale");
  const fresh = works.getProjection(f.work.workId)!;
  const older = { ...fresh, stateVersion: fresh.stateVersion - 1 };
  assert.equal(reconcileWorkProjection(older, fresh).stateVersion, fresh.stateVersion);
});

check("an epoch change replaces the whole view even when the cache looks newer", () => {
  const f = accepted("epoch");
  const first = sync(undefined);
  const cursor = first.kind === "snapshot" ? first.cursor : assert.fail("expected snapshot");
  // The host reset the stream epoch (restored backup / new device pairing).
  // A restored stream restarts its event log under a new epoch.
  db.connection.prepare("DELETE FROM work_projection_events WHERE user_id=?").run(LOCAL_USER_ID);
  db.connection.prepare("UPDATE work_projection_streams SET epoch=?,sequence=0 WHERE user_id=?")
    .run("epoch-restored", LOCAL_USER_ID);
  const resync = sync(cursor);
  assert.equal(resync.kind, "resync_required", "a cursor from the old epoch cannot resume");
  const replacement = sync(undefined);
  assert.equal(replacement.kind, "snapshot");
  const cached: WorkProjectionDto[] = [{ ...works.getProjection(f.work.workId)!, stateVersion: 99_999, title: "陈旧缓存" }];
  const merged = mergeWorkList(cached, cursor, replacement);
  assert.ok(merged);
  assert.equal(merged!.works.length, replacement.kind === "snapshot" ? replacement.works.length : 0);
  assert.ok(merged!.works.every(work => work.title !== "陈旧缓存"), "a higher local version cannot shadow the new epoch");
  assert.equal(merged!.cursor.epoch, "epoch-restored");
});

check("switching scope replaces the set instead of merging old rows", () => {
  const kept = accepted("scope-kept");
  const closed = accepted("scope-closed");
  unwrap(works.closeWork(user, { operationId: `close:${closed.suffix}`, workId: closed.work.workId,
    conclusion: "cancelled", closureSummary: "not needed", versionGuard: guard(works.getWork(closed.work.workId)!) }));
  const all = sync(undefined, true);
  assert.equal(all.kind, "snapshot");
  if (all.kind !== "snapshot") return;
  assert.ok(all.works.some(work => work.workId === closed.work.workId), "the all-scope keeps the closed fact");
  const openOnly = sync(all.cursor);
  assert.equal(openOnly.kind, "resync_required", "an all-scope cursor cannot resume the open view");
  const openSnapshot = sync(undefined, false);
  assert.equal(openSnapshot.kind, "snapshot");
  if (openSnapshot.kind !== "snapshot") return;
  assert.ok(openSnapshot.works.some(work => work.workId === kept.work.workId));
  assert.ok(!openSnapshot.works.some(work => work.workId === closed.work.workId), "open scope drops the closed tombstone");
});

check("paging stays continuous and a gap asks for a full resync", () => {
  const snapshot = sync(undefined);
  const start = snapshot.kind === "snapshot" ? snapshot.cursor : assert.fail("expected snapshot");
  for (let index = 0; index < 4; index += 1) accepted(`page-${index}`);
  const events = (db.connection.prepare("SELECT sequence FROM work_projection_events WHERE user_id=? AND sequence>? ORDER BY sequence")
    .all(LOCAL_USER_ID, start.sequence) as Array<{ sequence: number }>).map(row => row.sequence);
  assert.ok(events.length > 0);
  // A cursor that skips an event must not be guessed past.
  const gap = sync({ ...start, sequence: events.at(-1)! + 5 });
  assert.equal(gap.kind, "resync_required");
  const future = sync({ ...start, sequence: events.at(-1)! + 1 });
  assert.equal(future.kind, "resync_required", "a cursor beyond the stream is not trusted");
});

check("a large backlog is read in bounded pages", () => {
  const f = accepted("bounded");
  const snapshot = sync(undefined);
  const start = snapshot.kind === "snapshot" ? snapshot.cursor : assert.fail("expected snapshot");
  const stream = (db.connection.prepare("SELECT sequence FROM work_projection_streams WHERE user_id=?").get(LOCAL_USER_ID) as { sequence: number }).sequence;
  const delta = sync(start);
  assert.equal(delta.kind, "delta");
  if (delta.kind !== "delta") return;
  assert.ok(delta.events.length <= 200, "one page never exceeds the 200 event bound");
  assert.equal(delta.hasMore, delta.cursor.sequence < stream);
  assert.ok(works.getProjection(f.work.workId));
});

check("an unknown user stream is created lazily and stays isolated", () => {
  const snapshot = journal.sync("user-nobody", { includeClosed: false });
  assert.equal(snapshot.kind, "snapshot");
  assert.deepEqual(snapshot.kind === "snapshot" ? snapshot.works : [], []);
});

// -------------------------------------------------------------- BW-A46 views

check("the summary carries decisions, not ledgers", () => {
  const f = accepted("summary-shape");
  const summary = works.getWorkSummary(LOCAL_USER_ID, f.work.workId)!;
  assert.equal(summary.acceptedCount, 1);
  assert.deepEqual(summary.currentCardKeys, [f.card.cardKey]);
  assert.ok(!("executions" in summary), "executions stay in the expanded view");
  assert.ok(!("notifications" in summary));
  assert.ok(summary.nextSteps.some(step => step.includes("实测")), "the pending real-environment step is visible");
  assert.ok(summary.nextSteps.length <= 6, "the summary stays a short decision list");
  assert.equal(works.getWorkSummary("user-other", f.work.workId), undefined);
});

check("unverified scope states why a criterion is not confirmed", () => {
  const f = accepted("unverified");
  const scope = works.cards.unverifiedScope(works.getWork(f.work.workId)!);
  const environment = scope.find(entry => entry.text.includes("Omarchy"))!;
  assert.equal(environment.reason, "pending_real_environment");
  assert.equal(environment.requiredEnvironment, "omarchy");
  const automated = scope.find(entry => entry.text.includes("Automated"))!;
  assert.equal(automated.reason, "no_evidence", "an unmet criterion is not reported as verified");
});

check("expanded diagnostics page their sections and expose gaps as gaps", () => {
  const f = accepted("diagnostics");
  for (let index = 0; index < 3; index += 1) {
    unwrap(works.reportBlocker(owner, { operationId: `block-${index}:${f.suffix}`, workId: f.work.workId,
      reason: `需要你确认第 ${index} 项`, waitingForUserInput: true,
      versionGuard: guard(works.getWork(f.work.workId)!) }));
  }
  const first = works.getWorkDiagnostics(LOCAL_USER_ID, { workId: f.work.workId, limit: 1 })!;
  assert.equal(first.acceptance.items.length, 1);
  assert.equal(first.acceptance.truncated, true, "a bounded page reports that more evidence exists");
  assert.ok(first.nextCursor, "the page carries a resume token");
  assert.equal(first.executions.items.length, 1);
  assert.ok(first.requirements.items.length >= 1);
  assert.equal(first.workId, f.work.workId);
  assert.equal(works.getWorkDiagnostics("user-other", { workId: f.work.workId }), undefined);
  // A missing evidence reference is reported, never rendered as a pass.
  db.connection.prepare("UPDATE work_result_cards SET evidence_ids_json='[\"evidence-gone\"]' WHERE work_id=?").run(f.work.workId);
  const gapped = works.getWorkDiagnostics(LOCAL_USER_ID, { workId: f.work.workId })!;
  assert.ok(gapped.acceptance.missing?.some(text => text.includes("evidence-gone")));
});

check("artifact identity never falls back to a semantic card key", () => {
  const f = accepted("artifact-identity");
  const work = works.getWork(f.work.workId)!;
  const withoutArtifact = works.cards.unverifiedScope(work);
  assert.ok(withoutArtifact.every(entry => entry.artifactSnapshotId === undefined),
    "absence of an artifact snapshot stays unknown even after a card was accepted");
  const snapshotId = works.artifacts.currentSnapshotId(work.workId);
  assert.notEqual(snapshotId, f.card.cardKey);
  const scope = works.cards.unverifiedScope(work, snapshotId);
  assert.ok(scope.every(entry => entry.artifactSnapshotId === snapshotId));
  const diagnostics = works.getWorkDiagnostics(LOCAL_USER_ID, { workId: work.workId })!;
  assert.equal(diagnostics.artifactSnapshotId, snapshotId);
  assert.ok(diagnostics.unverifiedScope.every(entry => entry.artifactSnapshotId === snapshotId));
});

check("a source commit SHA is not confused with the artifact snapshot identity", () => {
  const f = fixture("source-sha");
  const criterion = f.work.criteria.find(item => item.requiresRealEnvironmentCheck)!;
  const snapshotId = works.artifacts.currentSnapshotId(f.work.workId);
  const sourceSha = "a".repeat(40);
  const current = unwrap(works.recordUserFeedback(user, {
    operationId: `feedback:${f.suffix}`, workId: f.work.workId, criterionIds: [criterion.id],
    environment: "omarchy", sourceRef: `git:${sourceSha}`, sourceSha,
    inputSnapshotId: f.work.inputSnapshotId, artifactSnapshotId: snapshotId, failed: false,
    versionGuard: guard(works.getWork(f.work.workId)!),
  }));
  const scope = works.cards.unverifiedScope(current, snapshotId).find(item => item.criterionId === criterion.id)!;
  assert.notEqual(sourceSha, snapshotId);
  assert.equal(scope.reason, "user_verified", "current user evidence keeps its provenance and can name a source commit independently of its artifact snapshot");
  assert.equal(scope.artifactSnapshotId, snapshotId);
  assert.equal(works.repo.getEvidence(scope.evidenceIds[0]!)!.sourceSha, sourceSha);
  const historical = works.cards.unverifiedScope({ ...current, inputSnapshotId: "a-new-input" }, snapshotId)
    .find(item => item.criterionId === criterion.id)!;
  assert.equal(historical.reason, "historical_version_only", "the actual input-version boundary still rejects old evidence");
});

check("diagnostics respect the requested sections", () => {
  const f = accepted("sections");
  const only = works.getWorkDiagnostics(LOCAL_USER_ID, { workId: f.work.workId, sections: ["acceptance"] })!;
  assert.equal(only.acceptance.items.length, 1);
  assert.deepEqual(only.executions.items, []);
  assert.deepEqual(only.delivery.items, []);
});

check("the delivery chain is traceable from the expanded view", () => {
  const f = accepted("delivery-chain");
  const attemptless = works.getWorkSummary(LOCAL_USER_ID, f.work.workId)!;
  assert.equal(attemptless.delivery[0]?.externalStatus, "in_app_only");
  const audit = works.getWorkDiagnostics(LOCAL_USER_ID, { workId: f.work.workId, sections: ["delivery", "acceptance"] })!;
  assert.deepEqual(audit.delivery.items, [], "no attempt before a channel is used");
  assert.equal(audit.resources.items.length, 0, "unrequested sections stay out of the payload");
  assert.equal(audit.acceptance.items[0]!.canonicalOutcomeHash.length, 64);
  assert.equal(audit.acceptance.items[0]!.cardKey, f.card.cardKey);
});

check("a reused acceptance card carries the authoritative successful closure in its projection", () => {
  const f = accepted("closed-success-card");
  let current = works.getWork(f.work.workId)!;
  current = unwrap(works.attestCriteria(user, { operationId: `attest:${f.suffix}`, workId: current.workId,
    criterionUpdates: [{ criterionId: current.criteria[0]!.id, status: "met", evidence: "checked" }],
    versionGuard: guard(current) }));
  current = unwrap(works.recordUserFeedback(user, { operationId: `feedback:${f.suffix}`, workId: current.workId,
    criterionIds: [current.criteria[1]!.id], environment: "omarchy", sourceRef: "fixture:desktop",
    inputSnapshotId: current.inputSnapshotId, artifactSnapshotId: works.artifacts.currentSnapshotId(current.workId), failed: false,
    versionGuard: guard(current) }));
  unwrap(works.closeWork(user, { operationId: `close-card:${f.suffix}`, workId: current.workId,
    conclusion: "succeeded", closureSummary: "verified and complete", versionGuard: guard(current) }));
  const projection = works.getProjection(current.workId)!;
  assert.equal(projection.lifecycle, "closed");
  assert.equal(projection.closureConclusion, "succeeded");
  assert.equal(projection.cards?.length, 1);
  assert.equal(projection.cards?.[0]?.kind, "accepted_result", "closing preserves the original card identity");
  assert.equal(projection.cards?.[0]?.cardKey, f.card.cardKey);
  assert.equal(projection.cards?.[0]?.currency, "current");
  assert.equal(works.getWorkSummary(LOCAL_USER_ID, current.workId)!.closureConclusion, "succeeded");
});

check("the acceptance card survives closing and stays addressable", () => {
  const f = accepted("closed-card");
  const work = works.getWork(f.work.workId)!;
  unwrap(works.closeWork(user, { operationId: `close-card:${f.suffix}`, workId: work.workId,
    conclusion: "cancelled", closureSummary: "stop", versionGuard: guard(work) }));
  const cards = works.cards.list(works.getWork(f.work.workId)!);
  assert.equal(cards.length, 2, "cancelling after an accepted result records an independent closure fact");
  assert.deepEqual(cards.map(card => card.kind).sort(), ["accepted_result", "closure_cancelled"]);
  const projection = works.getProjection(work.workId)!;
  assert.equal(projection.lifecycle, "closed");
  assert.equal(projection.closureConclusion, "cancelled", "a retained acceptance card does not make cancellation successful");
  assert.equal(works.getWorkSummary(LOCAL_USER_ID, work.workId)!.closureConclusion, "cancelled");
  assert.ok(cards.every(card => card.currency === "historical" || card.currency === "current"));
  const read = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: cards[1]!.semanticCardKey });
  assert.equal(read.ok, true, "a closed Work can still be read");
});

check("an unsuccessful closure keeps its own conclusion beside an accepted result", () => {
  const f = accepted("closed-failed-card");
  const work = works.getWork(f.work.workId)!;
  unwrap(works.closeWork(user, { operationId: `close-card:${f.suffix}`, workId: work.workId,
    conclusion: "ended_unsuccessfully", closureSummary: "remaining check failed", versionGuard: guard(work) }));
  const projection = works.getProjection(work.workId)!;
  assert.equal(projection.lifecycle, "closed");
  assert.equal(projection.closureConclusion, "ended_unsuccessfully");
  assert.deepEqual(projection.cards?.map(card => card.kind).sort(), ["accepted_result", "closure_failed"]);
  assert.equal(works.getWorkSummary(LOCAL_USER_ID, work.workId)!.closureConclusion, "ended_unsuccessfully");
});

console.log(`Phase 5 reconnect diagnostics: ${passes.length} passed`);
