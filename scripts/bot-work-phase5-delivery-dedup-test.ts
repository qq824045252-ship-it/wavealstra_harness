import type { QQSocket } from "../src/main/gateway/QQChannelAdapter";
import { qqWorkMessageSequence } from "../src/main/agent/work/WorkGatewayNotificationChannel";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkResultCards } from "../src/main/agent/work/WorkResultCards";
import { resolveChannelCapability } from "../src/main/agent/work/WorkNotificationDelivery";
import type { AsyncWorkNotificationChannel } from "../src/main/agent/work/WorkNotificationDelivery";
import { WorkNotificationHost } from "../src/main/agent/work/WorkNotificationHost";
import { createDesktopWorkChannel } from "../src/main/agent/work/WorkDesktopNotificationChannel";
import { NotificationService } from "../src/main/notification/NotificationService";
import type { AppSettingsStore } from "../src/main/AppSettingsStore";
import {
  capabilityOfGuarantee, deliveryRecoveryAction, encodeSemanticTuple, semanticCardTuple,
} from "../src/shared/bot-work-phase5";
import type { WorkActor, WorkControlResult, WorkDto, WorkNotificationChannel } from "../src/shared/bot-work";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

/**
 * BW-A42/BW-A43/BW-A44: atomic acceptance with one stable card, honest external
 * delivery, and reads that cannot change the Work.
 */

const root = mkdtempSync(join(tmpdir(), "phase5-delivery-"));
const path = join(root, "work.db");
const db = new AppDatabase(path);
// External effects live in their own file so "actual sends" is a count we can trust.
const effectDb = new Database(join(root, "effects.db"));
effectDb.exec(`CREATE TABLE deliveries(idempotency_key TEXT PRIMARY KEY, payload TEXT NOT NULL, sent_at INTEGER NOT NULL)`);
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
for (const botId of [DEFAULT_BOT_ID, "expert-one", "expert-two"]) {
  bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
}
let clock = 1_700_000_000_000;
const works = new WorkService(db.connection, { bots, now: () => clock });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const sendCount = () => (effectDb.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count;
const passes: string[] = [];
const check = (name: string, run: () => void) => { run(); passes.push(name); console.log(`PASS ${name}`); };

let sequence = 0;
function fixture(name: string) {
  const suffix = `${name}-${++sequence}`;
  let work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix,
    authorization: grants, inputSnapshotId: `input:${suffix}`, criteria: [{ text: "Current checked evidence" }] }));
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
    artifactRefs: [], evidence: [{ kind: "tool_receipt", sourceRef: `receipt:${f.suffix}` }] }));
  const work = unwrap(works.acceptDeliverable(user, { operationId: `accept:${f.suffix}`, workId: f.work.workId,
    deliverableId: `deliverable:${f.suffix}` }));
  // The execution settles after its result is accepted; closing requires a settled effect.
  works.reconcileExecution(user, { bindingId: f.binding.bindingId, outcome: "completed" });
  const notification = works.repo.listNotifications(work.workId).find(item => item.kind === "result")!;
  return { ...f, work, notification };
}
const cardsOf = (workId: string) => works.cards.list(works.getWork(workId)!);

/** A real external endpoint: the row is the effect, the key makes replay visible. */
function channel(kind: "queryable" | "unqueryable" | "best-effort", behaviour: {
  responseLost?: boolean; ok?: boolean; lookup?: "delivered" | "missing" | "unknown";
} = {}): WorkNotificationChannel {
  const capability = kind === "queryable" ? capabilityOfGuarantee("idempotent-queryable")
    : kind === "unqueryable" ? capabilityOfGuarantee("idempotent-unqueryable")
      : capabilityOfGuarantee("best-effort-unqueryable");
  return {
    channel: `test-${kind}`,
    ...capability,
    send({ idempotencyKey }) {
      if (behaviour.responseLost) {
        // The request may have reached the endpoint; we just never learned the outcome.
        effectDb.prepare("INSERT OR IGNORE INTO deliveries(idempotency_key,payload,sent_at) VALUES (?,?,?)")
          .run(idempotencyKey, "lost-response", clock);
        return { ok: false, retryable: false, responseLost: true, error: "response lost" };
      }
      if (behaviour.ok === false) return { ok: false, retryable: true, responseLost: false, error: "endpoint rejected" };
      effectDb.prepare("INSERT OR IGNORE INTO deliveries(idempotency_key,payload,sent_at) VALUES (?,?,?)")
        .run(idempotencyKey, "delivered", clock);
      return { ok: true, receipt: `receipt:${idempotencyKey}` };
    },
    ...(capability.supportsReceiptQuery ? { lookup: () => behaviour.lookup ?? "delivered" as const } : {}),
  };
}

// Historical effect alerts must stop before any physical send, without hiding
// a real question that shared the original card.
for (const scenario of ["effect-only", "reference-only", "mixed", "later-question"] as const) {
  check(`retired effect escalation delivery: ${scenario}`, () => {
    const f = fixture(`retired-${scenario}`);
    const effect = { blockerId: `effect:${f.suffix}`, workId: f.work.workId,
      kind: scenario === "reference-only" ? "operational" as const : "external_effect" as const,
      reason: "Original uncertain operation", unknownExternalEffectRef: `receipt:${f.suffix}`,
      status: "open" as const, waitingForUserInput: true, createdAt: clock };
    const question = { blockerId: `question:${f.suffix}`, workId: f.work.workId,
      kind: "operational" as const, reason: "Choose the actual destination", reasonCode: "user-input" as const,
      status: "open" as const, waitingForUserInput: true, createdAt: clock };
    works.repo.insertBlocker(effect);
    if (scenario === "mixed") works.repo.insertBlocker(question);
    const originalSources = scenario === "mixed" ? [effect, question] : [effect];
    const card = works.cards.ensure({ work: f.work, kind: "blocked_escalation",
      outcome: WorkResultCards.escalationOutcome(f.work, originalSources), title: "Needs your decision",
      summary: originalSources.map(item => item.reason).join("\n"), unverifiedScope: [], now: clock });
    const notificationId = `old-effect-alert:${f.suffix}`;
    works.repo.insertNotification({ notificationId, workId: f.work.workId, semanticKey: notificationId,
      kind: "blocked", title: "Needs your decision", body: effect.reason, stateVersion: f.work.stateVersion,
      intentRevision: f.work.intentRevision, delivery: "pending", createdAt: clock, attemptCount: 0, cardKey: card.cardKey });
    if (scenario === "later-question") works.repo.insertBlocker({ ...question, createdAt: clock + 1 });
    const before = sendCount();
    works.deliverPendingNotifications(channel("queryable"), f.work.workId);
    assert.equal(sendCount() - before, scenario === "mixed" ? 1 : 0);
    assert.equal(cardsOf(f.work.workId)[0].currency, scenario === "mixed" ? "current" : "superseded");
    assert.equal(works.repo.listBlockers(f.work.workId).find(item => item.blockerId === effect.blockerId)?.unknownExternalEffectRef,
      effect.unknownExternalEffectRef, "original diagnostic remains available");
    if (scenario === "mixed" || scenario === "later-question") assert.equal(works.cards.pendingDecisions(f.work.workId).length, 1);
  });
}

// ---------------------------------------------------------------- BW-A42 cards

check("acceptance commits exactly one semantic card with the notification", () => {
  const f = accepted("one-card");
  const cards = cardsOf(f.work.workId);
  assert.equal(cards.length, 1, "one substantive outcome owns one card");
  assert.equal(cards[0]!.kind, "accepted_result");
  assert.equal(cards[0]!.currency, "current");
  assert.equal(cards[0]!.deliverableIds[0], `deliverable:${f.suffix}`);
  const notification = works.repo.getNotification(f.notification.notificationId)!;
  assert.equal(notification.cardKey, cards[0]!.cardKey, "the intent announces the card");
  assert.match(cards[0]!.semanticCardKey, /^[0-9a-f]{64}$/);
});

check("a replayed acceptance returns the original receipt and adds no card", () => {
  const f = accepted("replay");
  const before = cardsOf(f.work.workId).length;
  const replay = works.acceptDeliverable(user, { operationId: `accept:${f.suffix}`, workId: f.work.workId,
    deliverableId: `deliverable:${f.suffix}` });
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(cardsOf(f.work.workId).length, before);
});

check("a second acceptance attempt on the same deliverable is refused, not silently duplicated", () => {
  const f = accepted("second-accept");
  const other = works.acceptDeliverable(user, { operationId: `accept-again:${f.suffix}`, workId: f.work.workId,
    deliverableId: `deliverable:${f.suffix}`, versionGuard: guard(works.getWork(f.work.workId)!) });
  assert.equal(other.ok, false);
  assert.equal(other.ok === false && other.code, "invalid_request");
  assert.equal(cardsOf(f.work.workId).length, 1);
});

check("the semantic key is stable and collision-free across a different outcome", () => {
  const first = WorkResultCards.computeSemanticKey({ workId: "w", intentRevision: 1, inputSnapshotId: "i",
    kind: "accepted_result", canonicalOutcomeHash: "a" });
  const same = WorkResultCards.computeSemanticKey({ workId: "w", intentRevision: 1, inputSnapshotId: "i",
    kind: "accepted_result", canonicalOutcomeHash: "a" });
  const otherKind = WorkResultCards.computeSemanticKey({ workId: "w", intentRevision: 1, inputSnapshotId: "i",
    kind: "closure_cancelled", canonicalOutcomeHash: "a" });
  const otherRevision = WorkResultCards.computeSemanticKey({ workId: "w", intentRevision: 2, inputSnapshotId: "i",
    kind: "accepted_result", canonicalOutcomeHash: "a" });
  assert.equal(first, same);
  assert.notEqual(first, otherKind);
  assert.notEqual(first, otherRevision);
  // Length-prefixed tuples keep "a:bc" and "ab:c" apart.
  assert.notEqual(encodeSemanticTuple(["a", "bc"]), encodeSemanticTuple(["ab", "c"]));
  assert.equal(semanticCardTuple({ workId: "a:b", intentRevision: 1, inputSnapshotId: "c", kind: "accepted_result",
    canonicalOutcomeHash: "d" }), semanticCardTuple({ workId: "a:b", intentRevision: 1, inputSnapshotId: "c",
    kind: "accepted_result", canonicalOutcomeHash: "d" }));
});

check("closing after acceptance does not mint a second identical card", () => {
  const f = accepted("close-no-dup");
  const current = works.getWork(f.work.workId)!;
  unwrap(works.attestCriteria(user, { operationId: `attest:${f.suffix}`, workId: current.workId,
    criterionUpdates: [{ criterionId: current.criteria[0]!.id, status: "met", evidence: "checked" }],
    versionGuard: guard(current) }));
  unwrap(works.closeWork(user, { operationId: `close:${f.suffix}`, workId: current.workId,
    conclusion: "succeeded", closureSummary: "done", versionGuard: guard(works.getWork(current.workId)!) }));
  const cards = cardsOf(f.work.workId);
  assert.equal(cards.length, 1, "accepted→closed reuses the same substantiated card");
  assert.equal(cards[0]!.kind, "accepted_result");
  const notifications = works.repo.listNotifications(f.work.workId);
  assert.equal(notifications.filter(item => item.kind === "closed")[0]?.cardKey, cards[0]!.cardKey);
});

check("a cancellation with new substance is its own card", () => {
  const f = fixture("cancel-card");
  works.reconcileExecution(user, { bindingId: f.binding.bindingId, outcome: "stopped" });
  unwrap(works.closeWork(user, { operationId: `cancel:${f.suffix}`, workId: f.work.workId,
    conclusion: "cancelled", closureSummary: "not needed" }));
  assert.equal(works.getWork(f.work.workId)!.lifecycle, "closed");
  const cards = cardsOf(f.work.workId);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.kind, "closure_cancelled");
});

check("two connections cannot insert the same semantic key twice", () => {
  const f = accepted("unique-key");
  const card = cardsOf(f.work.workId)[0]!;
  const second = new Database(path);
  try {
    assert.throws(() => second.prepare(`INSERT INTO work_result_cards (card_key,semantic_card_key,work_id,user_id,kind,
      intent_revision,input_snapshot_id,origin_owner_epoch,canonical_outcome_hash,canonical_outcome_json,title,summary,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'{}','dup','dup',1)`).run("card:dup", card.semanticCardKey, card.workId, card.userId,
      card.kind, card.intentRevision, card.inputSnapshotId, 1, card.canonicalOutcomeHash));
  } finally { second.close(); }
});

check("a rolled-back acceptance leaves neither card nor notification", () => {
  const f = fixture("rollback");
  unwrap(works.submitDeliverable(f.worker, { operationId: `deliver:${f.suffix}`, workId: f.work.workId,
    bindingId: f.binding.bindingId, deliverableId: `deliverable:${f.suffix}`, summary: "Confirmed result", evidence: [] }));
  const before = cardsOf(f.work.workId).length;
  assert.throws(() => works.transaction(() => {
    works.acceptDeliverable(user, { operationId: `accept:${f.suffix}`, workId: f.work.workId,
      deliverableId: `deliverable:${f.suffix}` });
    throw new Error("中间故障");
  }));
  assert.equal(cardsOf(f.work.workId).length, before, "the card is inside the acceptance transaction");
  assert.equal(works.repo.listNotifications(f.work.workId).filter(item => item.kind === "result").length, 0);
  assert.equal(works.getWork(f.work.workId)!.acceptedDeliverableIds.length, 0);
});

// --------------------------------------------------------- BW-A43 delivery

check("a queryable endpoint settles a lost response from the original effect key", () => {
  const f = accepted("queryable");
  const sendsBefore = sendCount();
  const outcomes = works.deliverPendingNotifications(channel("queryable", { responseLost: true, lookup: "delivered" }), f.work.workId);
  assert.equal(outcomes.find(item => item.notificationId === f.notification.notificationId)?.delivery, "sent");
  const attempts = works.notifications.attempts(f.notification.notificationId);
  assert.equal(attempts.length, 1, "a reconciled receipt is not a second send");
  assert.equal(sendCount(), sendsBefore + 1);
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
});

check("a confirmed-missing request is resent under the same effect key", () => {
  const f = accepted("same-effect");
  const first = channel("queryable", { responseLost: true, lookup: "missing" });
  works.deliverPendingNotifications(first, f.work.workId);
  const attempts = works.notifications.attempts(f.notification.notificationId);
  const replay = channel("queryable", { ok: true });
  works.deliverPendingNotifications(replay, f.work.workId);
  const after = works.notifications.attempts(f.notification.notificationId);
  assert.equal(after.length, attempts.length + 1, "the replay is a new physical attempt");
  assert.equal(after.at(-1)!.providerEffectKey, attempts[0]!.providerEffectKey, "the provider effect is reused");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
});

check("an unreconcilable unknown stays unknown and is never resent blindly", () => {
  const f = accepted("best-effort");
  const sendsBefore = sendCount();
  const best = channel("best-effort", { responseLost: true });
  const first = works.deliverPendingNotifications(best, f.work.workId);
  assert.equal(first.find(item => item.notificationId === f.notification.notificationId)?.delivery, "unknown");
  const attemptsAfterFirst = works.notifications.attempts(f.notification.notificationId).length;
  works.deliverPendingNotifications(best, f.work.workId);
  works.deliverPendingNotifications(best, f.work.workId);
  assert.equal(works.notifications.attempts(f.notification.notificationId).length, attemptsAfterFirst,
    "unknown is not retried without new authorization");
  assert.equal(sendCount(), sendsBefore + 1, "exactly one external request happened");
  const summary = works.getWorkSummary(LOCAL_USER_ID, f.work.workId)!;
  const row = summary.delivery.find(item => item.notificationId === f.notification.notificationId)!;
  assert.equal(row.externalStatus, "unconfirmed_no_auto_retry");
  assert.equal(row.state, "unknown");
});

check("manual resend needs an explicit authorization and keeps the original unknown", () => {
  const f = accepted("resend");
  const best = channel("best-effort", { responseLost: true });
  works.deliverPendingNotifications(best, f.work.workId);
  const before = works.notifications.attempts(f.notification.notificationId);
  assert.equal(before[0]!.status, "unknown");
  const refused = works.resendWorkNotification(user, { operationId: `resend-bad:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "try again" });
  assert.equal(refused.ok, false, "duplicate-risk acknowledgement is required");
  const authorized = works.resendWorkNotification(user, { operationId: `resend:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "user asked again", acknowledgedDuplicateRisk: true,
    versionGuard: guard(works.getWork(f.work.workId)!) });
  assert.equal(authorized.ok, true);
  works.deliverPendingNotifications(channel("best-effort", { ok: true }), f.work.workId);
  const attempts = works.notifications.attempts(f.notification.notificationId);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1]!.providerEffectKey, attempts[0]!.providerEffectKey, "a new effect identity is authorized");
  assert.equal(attempts[0]!.status, "unknown", "the unresolved original is preserved");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
});

check("the recovery matrix distinguishes read-back from replay safety", () => {
  const queryable = capabilityOfGuarantee("idempotent-queryable");
  const replayOnly = capabilityOfGuarantee("idempotent-unqueryable");
  const neither = capabilityOfGuarantee("best-effort-unqueryable");
  assert.equal(deliveryRecoveryAction({ lookup: "delivered", capability: neither }), "settle-sent");
  assert.equal(deliveryRecoveryAction({ lookup: "unknown", capability: queryable }), "stay-unknown");
  assert.equal(deliveryRecoveryAction({ lookup: "missing", capability: queryable }), "safe-resend-same-effect");
  assert.equal(deliveryRecoveryAction({ lookup: "unavailable", capability: replayOnly }), "safe-resend-same-effect");
  assert.equal(deliveryRecoveryAction({ lookup: "unavailable", capability: neither }), "stay-unknown");
});

check("a contradictory capability declaration fails instead of downgrading", () => {
  assert.throws(() => resolveChannelCapability({ channel: "liar", deliveryGuarantee: "idempotent-queryable",
    supportsIdempotencyKey: true, supportsReceiptQuery: false, send: () => ({ ok: true, receipt: "x" }) }));
  // Declaring read-back without implementing lookup is a contradiction, not a capability.
  assert.throws(() => resolveChannelCapability({ channel: "hollow", deliveryGuarantee: "idempotent-queryable",
    send: () => ({ ok: true, receipt: "x" }) }));
  const legacy = resolveChannelCapability({ channel: "legacy", idempotent: true, send: () => ({ ok: true, receipt: "x" }) });
  assert.deepEqual(legacy, capabilityOfGuarantee("idempotent-unqueryable"));
});

// ------------------------------------------------------------- BW-A44 reads

check("reading a card changes only read facts", () => {
  const f = accepted("read");
  const card = cardsOf(f.work.workId)[0]!;
  const before = works.getWork(f.work.workId)!;
  const executions = works.repo.listBindings(f.work.workId).length;
  const result = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: card.semanticCardKey });
  assert.equal(result.ok, true);
  assert.equal(result.readVersion, 1);
  const after = works.getWork(f.work.workId)!;
  assert.equal(after.stateVersion, before.stateVersion, "a read is not a control version");
  assert.equal(after.intentRevision, before.intentRevision);
  assert.equal(after.ownerEpoch, before.ownerEpoch);
  assert.equal(after.lifecycle, before.lifecycle);
  assert.equal(works.repo.listBindings(f.work.workId).length, executions, "a read creates no execution");
});

check("reads are monotonic, idempotent and refuse a future clock", () => {
  const f = accepted("read-order");
  const card = cardsOf(f.work.workId)[0]!;
  const first = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: card.semanticCardKey });
  assert.equal(first.readAt, clock);
  clock += 1_000;
  const later = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: card.semanticCardKey });
  assert.equal(later.readAt, clock);
  clock += 60_000;
  const future = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: card.semanticCardKey, readAt: clock + 3_600_000 });
  assert.equal(future.readAt, clock, "a client clock cannot run ahead of the host");
  const backwards = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: card.semanticCardKey, readAt: 5 });
  assert.equal(backwards.readAt, clock, "an older read never regresses the watermark");
});

check("another user cannot read or address this card", () => {
  const f = accepted("read-foreign");
  const card = cardsOf(f.work.workId)[0]!;
  const foreign = works.markWorkCardRead({ kind: "user", userId: "user-other", grants }, { workId: f.work.workId,
    semanticCardKey: card.semanticCardKey });
  assert.equal(foreign.ok, false);
  const missing = works.markWorkCardRead(user, { workId: f.work.workId, semanticCardKey: "0".repeat(64) });
  assert.equal(missing.ok, false);
});

check("the owner summary watermark moves only with substance", () => {
  const f = accepted("summary");
  const first = works.cards.refreshSummary(works.getWork(f.work.workId)!, clock);
  const second = works.cards.refreshSummary(works.getWork(f.work.workId)!, clock);
  assert.equal(first.digest, second.digest, "an unchanged outcome is not a new summary");
  const blocked = unwrap(works.reportBlocker(owner, { operationId: `block:${f.suffix}`, workId: f.work.workId,
    reason: "需要你确认部署窗口", waitingForUserInput: true,
    versionGuard: guard(works.getWork(f.work.workId)!) }));
  const afterBlock = works.cards.refreshSummary(works.getWork(blocked.workId)!, clock);
  assert.notEqual(afterBlock.digest, first.digest);
  const summary = works.getWorkSummary(LOCAL_USER_ID, f.work.workId)!;
  assert.ok(summary.pendingUserDecisions.some(text => text.includes("部署窗口")));
});

check("a user-facing blocker becomes one card, and repeats stay one", () => {
  const f = fixture("blocked-card");
  unwrap(works.reportBlocker(owner, { operationId: `block-a:${f.suffix}`, workId: f.work.workId,
    reason: "需要你确认镜像地址", waitingForUserInput: true, versionGuard: guard(f.work) }));
  unwrap(works.reportBlocker(owner, { operationId: `block-b:${f.suffix}`, workId: f.work.workId,
    reason: "需要你确认镜像地址（再次提示）", waitingForUserInput: true,
    versionGuard: guard(works.getWork(f.work.workId)!) }));
  const cards = cardsOf(f.work.workId).filter(card => card.kind === "blocked_escalation");
  assert.equal(cards.length, 1, "the same unresolved decision is one card");
  assert.equal(works.repo.listNotifications(f.work.workId).filter(item => item.kind === "blocked").length, 1);
});

check("internal progress is not a card", () => {
  const f = fixture("no-internal");
  unwrap(works.dispatchExecution(user, { operationId: `dispatch-again:${f.suffix}`, workId: f.work.workId,
    botId: "expert-one", taskId: `task-two-${f.suffix}`, durableStoreKey: `store-two-${f.suffix}`,
    conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read"],
    versionGuard: guard(f.work) }));
  assert.equal(cardsOf(f.work.workId).length, 0, "dispatch alone is not a result");
});

// ---------------------------------------------- production host drain (P5-02)

check("the production host drains only while it holds the authority", () => {
  const f = accepted("host-authority");
  const notifications = new NotificationService(db, { read: () => ({}) } as unknown as AppSettingsStore);
  const channel = createDesktopWorkChannel(notifications);
  let authority = false;
  const host = new WorkNotificationHost(works, { isAuthority: () => authority, channels: () => [channel] });
  assert.deepEqual(host.drain(f.work.workId), [], "a non-authority host sends nothing");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "pending");
  authority = true;
  const result = host.drain(f.work.workId);
  assert.ok(result.some(item => item.notificationId === f.notification.notificationId && item.delivery === "sent"));
  const rows = notifications.list({});
  assert.equal(rows.filter(item => item.dedupeKey?.startsWith("work-delivery:")).length, 1, "one real desktop notice");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
});

check("a lost desktop response stays unknown after restart until explicit manual resend", () => {
  const f = accepted("host-restart");
  const settings = { read: () => ({ notificationPreferences: {
    inAppEnabled: false, desktopEnabled: true, desktopBackgroundOnly: false,
  } }) } as unknown as AppSettingsStore;
  let presentations = 0;
  const notifications = new NotificationService(db, settings);
  notifications.setDesktopDelivery(() => { presentations++; });
  const desktop = createDesktopWorkChannel(notifications);
  assert.equal(resolveChannelCapability(desktop).deliveryGuarantee, "best-effort-unqueryable");
  works.deliverPendingNotifications({ ...desktop, send(input) {
    desktop.send(input);
    throw new Error("host crashed after desktop presentation, before receipt persistence");
  } }, f.work.workId);
  assert.equal(presentations, 1);
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  const reopenedWorks = new WorkService(db.connection, { bots, now: () => clock });
  const beforeChannelRecovery = reopenedWorks.resendWorkNotification(user, {
    operationId: `resend-before-channel:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "retry after restart", acknowledgedDuplicateRisk: true,
    versionGuard: guard(reopenedWorks.getWork(f.work.workId)!),
  });
  assert.equal(beforeChannelRecovery.ok, false, "resend admission needs a live observed endpoint contract");
  // Reopening the service loses its transient dedupe map. Neither that map nor an OS
  // toast is a durable provider receipt, so automatic recovery must not send again.
  const reopenedNotifications = new NotificationService(db, settings);
  reopenedNotifications.setDesktopDelivery(() => { presentations++; });
  const reopened = new WorkNotificationHost(reopenedWorks, {
    isAuthority: () => true, channels: () => [createDesktopWorkChannel(reopenedNotifications)],
  });
  reopened.drain(f.work.workId);
  assert.equal(presentations, 1);
  assert.equal(reopenedWorks.notifications.attempts(f.notification.notificationId).length, 1);
  assert.equal(reopenedWorks.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  unwrap(reopenedWorks.resendWorkNotification(user, {
    operationId: `resend-desktop:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "user confirms duplicate risk", acknowledgedDuplicateRisk: true,
    versionGuard: guard(reopenedWorks.getWork(f.work.workId)!),
  }));
  reopened.drain(f.work.workId);
  const attempts = reopenedWorks.notifications.attempts(f.notification.notificationId);
  assert.equal(presentations, 2, "only the explicit new authorization permits another presentation request");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.status, "unknown");
  assert.notEqual(attempts[0]!.providerEffectKey, attempts[1]!.providerEffectKey);
  assert.match(attempts[1]!.receipt ?? "", /^accepted-notification:/,
    "the receipt denotes service acceptance, not a persisted or OS presentation receipt");
});

check("a muted preference is a deliberate end state, not a retry loop", () => {
  const f = accepted("host-muted");
  const muted = { read: () => ({ notificationPreferences: { taskCompleted: false, actionRequired: false } }) } as unknown as AppSettingsStore;
  const notifications = new NotificationService(db, muted);
  const host = new WorkNotificationHost(works, { isAuthority: () => true, channels: () => [createDesktopWorkChannel(notifications)] });
  host.drain(f.work.workId);
  const stored = works.repo.getNotification(f.notification.notificationId)!;
  assert.equal(stored.delivery, "sent", "the user's mute is recorded, not retried forever");
  assert.match(stored.externalReceipt ?? "", /^suppressed:/);
  const attempts = works.notifications.attempts(f.notification.notificationId).length;
  host.drain(f.work.workId);
  assert.equal(works.notifications.attempts(f.notification.notificationId).length, attempts);
});

check("a throwing channel is contained and leaves an honest unknown", () => {
  const f = accepted("host-broken");
  const notifications = new NotificationService(db, { read: () => ({}) } as unknown as AppSettingsStore);
  const broken = { channel: "broken", ...capabilityOfGuarantee("best-effort-unqueryable"), targetKey: "broken",
    send() { throw new Error("channel crashed"); } };
  // The desktop channel is configured but never reached: a broken attempt blocks the intent
  // instead of silently switching endpoints.
  const host = new WorkNotificationHost(works, { isAuthority: () => true,
    channels: () => [broken, createDesktopWorkChannel(notifications)] });
  const outcomes = host.drain(f.work.workId);
  assert.equal(outcomes.find(item => item.channel === "broken")?.delivery, "unknown");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  assert.equal(outcomes.filter(item => item.channel === "desktop").length, 0,
    "an unresolved attempt is never re-routed to another channel automatically");
  const after = works.notifications.attempts(f.notification.notificationId).length;
  host.drain(f.work.workId);
  assert.equal(works.notifications.attempts(f.notification.notificationId).length, after,
    "the host loop does not hammer a broken channel");
});

// ---------------------------------------------- post-review boundary regressions

check("synchronous reentry records a global trailing scan for newly queued work", () => {
  const scopes: Array<string | undefined> = [];
  const queue = ["first"];
  let host: WorkNotificationHost;
  host = new WorkNotificationHost({ deliverPendingNotifications(_channel, workId) {
    scopes.push(workId);
    const snapshot = queue.splice(0);
    if (snapshot.includes("first")) {
      queue.push("second");
      assert.deepEqual(host.drain("another-work"), []);
    }
    return snapshot.map(notificationId => ({ notificationId, delivery: "sent" as const }));
  } }, { isAuthority: () => true, channels: () => [channel("best-effort")] });
  const result = host.drain("first-work");
  assert.deepEqual(result.map(item => item.notificationId), ["first", "second"]);
  assert.deepEqual(scopes, ["first-work", undefined], "a reentrant request may be outside the original Work scope");
});

check("stop invalidates reentrant scans and prevents later channels in that drain", () => {
  let scans = 0;
  let host: WorkNotificationHost;
  host = new WorkNotificationHost({ deliverPendingNotifications() {
    scans++;
    host.drain();
    host.stop();
    return [];
  } }, { isAuthority: () => true, channels: () => [channel("queryable"), channel("best-effort")] });
  host.drain();
  assert.equal(scans, 1);
});

check("authority loss during a callback prevents the pending trailing scan", () => {
  let authority = true;
  let scans = 0;
  let host: WorkNotificationHost;
  host = new WorkNotificationHost({ deliverPendingNotifications() {
    scans++;
    host.drain();
    authority = false;
    return [];
  } }, { isAuthority: () => authority, channels: () => [channel("best-effort")] });
  host.drain();
  assert.equal(scans, 1);
});

check("projection wakes terminate at the replay budget while preserving unknown", () => {
  const f = accepted("wake-budget");
  let host: WorkNotificationHost;
  const wakingWorks = new WorkService(db.connection, { bots, now: () => clock,
    emitProjection: () => host.wake() });
  let sends = 0;
  let scans = 0;
  const endpoint: WorkNotificationChannel = { channel: "wake-replay",
    ...capabilityOfGuarantee("idempotent-unqueryable"), send() {
      sends++;
      // Real production wiring: an event emitted while send is on the stack wakes
      // the host through WorkService.emitProjection, rather than an async API assumption.
      wakingWorks.emitCurrentProjection(f.work.workId, { force: true });
      return { ok: false, retryable: false, responseLost: true, error: "receipt unavailable" };
    } };
  host = new WorkNotificationHost({ deliverPendingNotifications(active) {
    scans++;
    assert.ok(scans < 6, "trailing scans must terminate instead of spinning on unknown");
    return wakingWorks.deliverPendingNotifications(active, f.work.workId);
  } }, { isAuthority: () => true, channels: () => [endpoint] });
  try { host.start(); } finally { host.stop(); }
  assert.equal(sends, 3);
  assert.equal(scans, 4);
  assert.equal(wakingWorks.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  assert.ok(wakingWorks.notifications.attempts(f.notification.notificationId).every(item => item.status === "unknown"));
  wakingWorks.deliverPendingNotifications(endpoint, f.work.workId);
  assert.equal(sends, 3, "later lifecycle wakes cannot reset the same effect's automatic budget");
  unwrap(wakingWorks.resendWorkNotification(user, {
    operationId: `budget-manual:${f.suffix}`, workId: f.work.workId, notificationId: f.notification.notificationId,
    reason: "manual risk confirmed", acknowledgedDuplicateRisk: true, versionGuard: guard(wakingWorks.getWork(f.work.workId)!),
  }));
  wakingWorks.deliverPendingNotifications({ ...endpoint, send() { return { ok: true, receipt: "manual-receipt" }; } }, f.work.workId);
  assert.equal(wakingWorks.notifications.attempts(f.notification.notificationId).at(-1)!.claimGeneration, 1);
});

check("best-effort unknown ignores trailing projection wakes without a second send", () => {
  const f = accepted("best-effort-wake");
  let host: WorkNotificationHost;
  const wakingWorks = new WorkService(db.connection, { bots, now: () => clock, emitProjection: () => host.wake() });
  let sends = 0;
  const endpoint: WorkNotificationChannel = { channel: "wake-best-effort",
    ...capabilityOfGuarantee("best-effort-unqueryable"), send() {
      sends++;
      wakingWorks.emitCurrentProjection(f.work.workId, { force: true });
      return { ok: false, retryable: false, responseLost: true, error: "lost response" };
    } };
  host = new WorkNotificationHost({ deliverPendingNotifications(active) {
    return wakingWorks.deliverPendingNotifications(active, f.work.workId);
  } }, { isAuthority: () => true, channels: () => [endpoint] });
  try { host.start(); } finally { host.stop(); }
  assert.equal(sends, 1);
  assert.equal(wakingWorks.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
});

check("recovery cannot send a frozen result after its inputs change or cancellation", () => {
  for (const change of ["amend", "cancel"] as const) {
    const f = accepted(`stale-replay-${change}`);
    let sends = 0;
    const endpoint: WorkNotificationChannel = { channel: `stale-${change}`,
      ...capabilityOfGuarantee("idempotent-unqueryable"), send({ notification }) {
        if (notification.notificationId === f.notification.notificationId) sends++;
        return { ok: false, retryable: false, responseLost: true, error: "lost response" };
      } };
    works.deliverPendingNotifications(endpoint, f.work.workId);
    if (change === "amend") unwrap(works.amendWork(user, {
      operationId: `amend-replay:${f.suffix}`, workId: f.work.workId, inputSnapshotId: `new-input:${f.suffix}`,
    }));
    else unwrap(works.cancelWork(user, { operationId: `cancel-replay:${f.suffix}`, workId: f.work.workId }));
    works.deliverPendingNotifications(endpoint, f.work.workId);
    assert.equal(sends, 1);
    assert.equal(works.notifications.attempts(f.notification.notificationId).length, 1);
    assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  }
});

check("manual resend retries retain their own effect and budget", () => {
  const f = accepted("manual-retry");
  const endpoint = channel("best-effort", { responseLost: true });
  works.deliverPendingNotifications(endpoint, f.work.workId);
  unwrap(works.resendWorkNotification(user, { operationId: `manual-retry:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "retry explicitly", acknowledgedDuplicateRisk: true,
    versionGuard: guard(works.getWork(f.work.workId)!) }));
  const duplicateAuthorization = works.resendWorkNotification(user, {
    operationId: `duplicate-manual-retry:${f.suffix}`, workId: f.work.workId,
    notificationId: f.notification.notificationId, reason: "repeat request", acknowledgedDuplicateRisk: true,
    versionGuard: guard(works.getWork(f.work.workId)!),
  });
  assert.equal(duplicateAuthorization.ok, false, "one pending authorization cannot be multiplied");
  works.deliverPendingNotifications(channel("best-effort", { ok: false }), f.work.workId);
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "pending");
  works.deliverPendingNotifications(channel("best-effort", { ok: true }), f.work.workId);
  const attempts = works.notifications.attempts(f.notification.notificationId);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0]!.status, "unknown");
  assert.notEqual(attempts[1]!.providerEffectKey, attempts[0]!.providerEffectKey);
  assert.equal(attempts[2]!.providerEffectKey, attempts[1]!.providerEffectKey);
  assert.equal(attempts[2]!.claimGeneration, 2);
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
});

check("a changed endpoint contract retires an unsent authorization with an honest unknown", () => {
  const f = accepted("capability-drift");
  const original = { ...channel("best-effort", { responseLost: true }), channel: "changing-endpoint", targetKey: "same-target" };
  works.deliverPendingNotifications(original, f.work.workId);
  const authorize = (suffix: string) => works.resendWorkNotification(user, {
    operationId: `${suffix}:${f.suffix}`, workId: f.work.workId, notificationId: f.notification.notificationId,
    reason: "user accepts duplication", acknowledgedDuplicateRisk: true, versionGuard: guard(works.getWork(f.work.workId)!),
  });
  unwrap(authorize("before-capability-change"));
  let sends = 0;
  const changed: WorkNotificationChannel = { channel: original.channel, targetKey: original.targetKey,
    ...capabilityOfGuarantee("idempotent-unqueryable"), send() { sends++; return { ok: true, receipt: "new-contract-receipt" }; } };
  assert.throws(() => works.deliverPendingNotifications(changed, f.work.workId), /渠道能力已改变/);
  assert.equal(sends, 0);
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
  assert.equal(works.notifications.attempts(f.notification.notificationId).length, 1);
  works.deliverPendingNotifications(changed, f.work.workId);
  assert.equal(sends, 0, "an old unknown is not reinterpreted under a stronger capability");
  unwrap(authorize("after-capability-change"));
  works.deliverPendingNotifications(changed, f.work.workId);
  assert.equal(sends, 1);
  assert.equal(works.notifications.attempts(f.notification.notificationId).at(-1)!.guarantee, "idempotent-unqueryable");
});

check("a late original receipt cannot consume a newly authorized resend", () => {
  const f = accepted("late-receipt");
  works.deliverPendingNotifications(channel("queryable", { responseLost: true, lookup: "unknown" }), f.work.workId);
  let authorized = false;
  const endpoint = { ...channel("queryable"), lookup: () => {
    if (!authorized) {
      authorized = true;
      unwrap(works.resendWorkNotification(user, {
        operationId: `late-receipt-resend:${f.suffix}`, workId: f.work.workId, notificationId: f.notification.notificationId,
        reason: "explicit resend racing receipt", acknowledgedDuplicateRisk: true,
        versionGuard: guard(works.getWork(f.work.workId)!),
      }));
    }
    return "delivered" as const;
  } };
  works.deliverPendingNotifications(endpoint, f.work.workId);
  assert.equal(works.notifications.attempts(f.notification.notificationId)[0]!.status, "sent");
  assert.equal(works.repo.getNotification(f.notification.notificationId)!.delivery, "pending",
    "late receipt settles only its original attempt, not the new authorization");
  works.deliverPendingNotifications(endpoint, f.work.workId);
  const attempts = works.notifications.attempts(f.notification.notificationId);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1]!.providerEffectKey, attempts[0]!.providerEffectKey);
  assert.equal(attempts[1]!.status, "sent");
});

{
  let scans = 0;
  const host = new WorkNotificationHost({ deliverPendingNotifications() { scans++; return []; } }, {
    isAuthority: () => true, channels: () => [channel("best-effort")],
  });
  host.start();
  host.wake();
  host.stop();
  await new Promise(resolve => setTimeout(resolve, 5));
  check("stop cancels an already queued asynchronous wake callback", () => assert.equal(scans, 1));
}

// Real WorkService/SQLite regressions for the production async pump's bounded scan.
{
  const route = (name: string, targetKey: string, createdAt: number) => {
    const f = accepted(name);
    db.connection.prepare("UPDATE work_notifications SET channel=?,target_key=?,created_at=? WHERE notification_id=?")
      .run("fair-async", targetKey, createdAt, f.notification.notificationId);
    return f;
  };
  const sent: string[] = [];
  const endpoint: AsyncWorkNotificationChannel = {
    channel: "fair-async", targetKey: "busy",
    ...capabilityOfGuarantee("idempotent-queryable"),
    async send({ notification, assertCurrent }) {
      assertCurrent();
      sent.push(notification.notificationId);
      return { ok: true, receipt: `receipt:${notification.notificationId}` };
    },
    async lookup() { return "delivered"; },
  };
  const stale = Array.from({ length: 25 }, (_, i) => {
    const f = route(`starved-old-${i}`, "busy", i);
    works.notifications.supersede(f.work.workId, i % 2 ? "cancelled" : "superseded");
    return f;
  });
  const valid = route("starved-current", "busy", 25);
  const other = route("independent-target", "quiet", 0);
  const host = new WorkNotificationHost(works, {
    isAuthority: () => true, channels: () => [],
    asyncChannels: () => [endpoint, { ...endpoint, targetKey: "quiet" }],
  });
  const first = await host.drainAsync();
  check("a full blocked batch stays bounded and does not consume another target's turn", () => {
    assert.equal(first.filter(item => stale.some(f => f.notification.notificationId === item.notificationId)).length, 25);
    assert.deepEqual(sent, [other.notification.notificationId]);
  });
  await host.drainAsync();
  check("25 obsolete pending notifications cannot permanently starve a valid intent", () => {
    assert.ok(sent.includes(valid.notification.notificationId));
    assert.equal(works.repo.getNotification(valid.notification.notificationId)!.delivery, "sent");
    assert.ok(stale.every(f => works.notifications.attempts(f.notification.notificationId).length === 0));
  });

  // A lost response is older than a new pending backlog. It must still get its
  // original receipt queried, even after its conclusion becomes obsolete.
  const unknown = route("old-unknown", "unknown-target", 0);
  let physicalSends = 0;
  let lookups = 0;
  const uncertain: AsyncWorkNotificationChannel = {
    ...endpoint, targetKey: "unknown-target",
    async send() {
      physicalSends++;
      return { ok: false, retryable: false, responseLost: true, error: "lost response" };
    },
    async lookup() { lookups++; return "delivered"; },
  };
  await works.notifications.deliverAsync(uncertain, unknown.work.workId);
  const originalAttempt = works.notifications.attempts(unknown.notification.notificationId)[0]!;
  works.notifications.supersede(unknown.work.workId, "superseded");
  for (let i = 0; i < 25; i++) {
    const f = route(`unknown-backlog-${i}`, "unknown-target", i + 1);
    works.notifications.supersede(f.work.workId, "superseded");
  }
  await works.notifications.deliverAsync(uncertain);
  check("pending backlog cannot starve receipt recovery of a superseded unknown", () => {
    assert.equal(lookups, 1);
    assert.equal(physicalSends, 1, "receipt reconciliation must not perform a second send");
    const attempts = works.notifications.attempts(unknown.notification.notificationId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.providerEffectKey, originalAttempt.providerEffectKey);
    assert.equal(attempts[0]!.status, "sent");
  });

  const blocked = route("temporarily-blocked", "wrap-target", 0);
  const later = route("wrap-current", "wrap-target", 1);
  let block = true;
  const wrapping: AsyncWorkNotificationChannel = { ...endpoint, targetKey: "wrap-target",
    admit: item => block && item.notificationId === blocked.notification.notificationId ? "temporarily unavailable" : undefined };
  await works.notifications.deliverAsync(wrapping, undefined, { limit: 1 });
  await works.notifications.deliverAsync(wrapping, undefined, { limit: 1 });
  block = false;
  await works.notifications.deliverAsync(wrapping, undefined, { limit: 1 });
  check("a skipped intent is reconsidered after cursor wrap and later intents make progress", () => {
    assert.equal(works.repo.getNotification(later.notification.notificationId)!.delivery, "sent");
    assert.equal(works.repo.getNotification(blocked.notification.notificationId)!.delivery, "sent");
  });

  const revisit = route("continuous-old", "continuous-target", 0);
  route("continuous-tail", "continuous-target", 1);
  let blockedInitially = true;
  const continuous: AsyncWorkNotificationChannel = { ...endpoint, targetKey: "continuous-target",
    admit: item => blockedInitially && item.notificationId === revisit.notification.notificationId ? "wait" : undefined };
  await works.notifications.deliverAsync(continuous, undefined, { limit: 1 });
  blockedInitially = false;
  for (let i = 0; i < 4; i++) {
    route(`continuous-new-${i}`, "continuous-target", i + 2);
    await works.notifications.deliverAsync(continuous, undefined, { limit: 1 });
  }
  check("continuous arrivals cannot postpone revisiting the frozen sweep's blocked head", () => {
    assert.equal(works.repo.getNotification(revisit.notification.notificationId)!.delivery, "sent");
  });
}

console.log(`Phase 5 delivery dedup: ${passes.length} passed`);
{
  const created = fixture("gateway-multipart-receipts");
  const snapshotPath = join(root, "immutable-delivery.txt"); writeFileSync(snapshotPath, "frozen payload bytes");
  works.transaction(() => works.generatedArtifacts.record(created.binding, [{ path: join(root, "mutable-source.txt"), snapshotPath,
    digest: createHash("sha256").update("frozen payload bytes").digest("hex"), sizeBytes: 20, registeredAt: clock, sourceEntryId: 1 }]));
  unwrap(works.submitDeliverable(created.worker, { operationId: "multipart-submit", workId: created.work.workId, bindingId: created.binding.bindingId,
    deliverableId: "multipart-deliverable", summary: "file delivered", artifactRefs: [snapshotPath], evidence: [{kind: "tool_receipt", sourceRef: "multipart-proof"}] }));
  unwrap(works.acceptDeliverable(user, { operationId: "multipart-accept", workId: created.work.workId, deliverableId: "multipart-deliverable" }));
  works.reconcileExecution(user, { bindingId: created.binding.bindingId, outcome: "completed" });
  const f = {...created, notification: works.repo.listNotifications(created.work.workId).find(item => item.kind === "result")!};
  let calls = 0;
  const endpoint: AsyncWorkNotificationChannel = {
    channel: "gateway:multipart-test", targetKey: "multipart-original-route", ...capabilityOfGuarantee("best-effort-unqueryable"),
    send: async input => {
      calls++;
      input.assertCurrent();
      assert.equal(Buffer.from(input.notification.deliveryFiles![0].base64, "base64").toString(), "frozen payload bytes");
      writeFileSync(snapshotPath, "file changed after claim");
      input.recordProgress(JSON.stringify([{ part: "text", receipt: "provider-text-1" }, { part: "upload:file-hash", receipt: "provider-media-1" }]));
      return { ok: false, retryable: false, responseLost: true, error: "file-send response lost after text success" };
    },
  };
  works.repo.updateNotificationLinks(f.notification.notificationId, { targetKey: "multipart-original-route", cardKey: f.notification.cardKey });
  works.repo.updateNotificationDelivery(f.notification.notificationId, { channel: endpoint.channel, delivery: "pending" });
  await works.notifications.deliverAsync(endpoint, f.work.workId);
  await works.notifications.deliverAsync(endpoint, f.work.workId);
  const row = db.connection.prepare("SELECT receipt,payload_json FROM work_notification_attempts WHERE notification_id=?").get(f.notification.notificationId) as { receipt: string; payload_json: string };
  assert.equal(Buffer.from(JSON.parse(row.payload_json).deliveryFiles[0].base64, "base64").toString(), "frozen payload bytes");
  assert.equal(calls, 1, "unknown multipart attempt never blind-retries");
  assert.equal(JSON.parse(row.receipt)[0].receipt, "provider-text-1");
  assert.equal(JSON.parse(row.receipt)[1].part, "upload:file-hash");
  assert.equal(works.repo.getNotification(f.notification.notificationId)?.delivery, "unknown");
  const reader = new Database(path, {readonly: true});
  assert.equal((reader.prepare("SELECT receipt FROM work_notification_attempts WHERE notification_id=?").get(f.notification.notificationId) as {receipt: string}).receipt, row.receipt);
  reader.close();
  console.log("PASS multipart partial receipts survive independent SQLite read and unknown never retries");
}

{
  const sequenceByEffect = new Map<string, number>();
  let providerCalls = 0;
  const endpoint: AsyncWorkNotificationChannel = { channel: "gateway:qq-ledger", targetKey: "same-qq-source-target",
    ...capabilityOfGuarantee("best-effort-unqueryable"), send: async input => {
      const sequence = qqWorkMessageSequence(db.connection, "same-qq-source-target", "gateway:qq-ledger", input.idempotencyKey);
      assert.equal(qqWorkMessageSequence(db.connection, "same-qq-source-target", "gateway:qq-ledger", input.idempotencyKey), sequence);
      sequenceByEffect.set(input.idempotencyKey, sequence); providerCalls++;
      return { ok: true, receipt: "qq-" + sequence };
    } };
  for(let i=0;i<5;i++) {
    const f=accepted("shared-qq-source-"+i);
    works.repo.updateNotificationLinks(f.notification.notificationId, {targetKey:endpoint.targetKey,cardKey:f.notification.cardKey});
    works.repo.updateNotificationDelivery(f.notification.notificationId, {channel:endpoint.channel,delivery:"pending"});
    await works.notifications.deliverAsync(endpoint,f.work.workId);
  }
  assert.equal(providerCalls,4,"passive slot 1 leaves only Work slots 2..5 across all Works from one source");
  assert.deepEqual([...sequenceByEffect.values()],[2,3,4,5]);
  const reader=new Database(path,{readonly:true});
  for(const [effectKey,sequence] of sequenceByEffect) assert.equal(qqWorkMessageSequence(reader,"same-qq-source-target","gateway:qq-ledger",effectKey),sequence);
  assert.throws(()=>qqWorkMessageSequence(reader,"other-source","gateway:qq-ledger",[...sequenceByEffect.keys()][0]),/持久/);
  reader.close();console.log("PASS QQ source-wide sequence reservations derive from real effect ledger and survive reopen");
}
{
  const { QQChannelAdapter } = await import("../src/main/gateway/QQChannelAdapter");
  const { gatewayWorkTargetSchema } = await import("../src/main/gateway/work-outbound");
  class Socket implements QQSocket {
    onmessage: QQSocket["onmessage"]=null; onclose: QQSocket["onclose"]=null; onerror: QQSocket["onerror"]=null;
    constructor(){setImmediate(()=>this.emit({op:10,d:{heartbeat_interval:10000}}));}
    emit(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
    send(raw:string){const value=JSON.parse(raw);if(value.op===2)setImmediate(()=>this.emit({op:0,s:1,t:"READY",d:{session_id:"ledger"}}));if(value.op===1)this.emit({op:11});}
    close(){}
  }
  let posts=0,uploads=0; const bodies:Array<Record<string,unknown>>=[];
  const adapter=new QQChannelAdapter("qq-ledger-real","QQ",{socketFactory:()=>new Socket(),fetch:async(url,init)=>{
    const href=String(url);
    if(href.endsWith("getAppAccessToken"))return Response.json({access_token:"token",expires_in:7200});
    if(href.endsWith("/gateway"))return Response.json({url:"wss://gateway.qq.com/ws"});
    if(href.endsWith("/files")){uploads++;assert.equal(JSON.parse(String(init?.body)).srv_send_msg,false);return Response.json({file_info:"qq-file-info",ttl:3600});}
    assert.equal(href,"https://api.sgroup.qq.com/v2/users/user/messages");
    posts++;bodies.push(JSON.parse(String(init?.body)));return Response.json({id:"provider-qq-summary"});
  }});
  await adapter.connect({appId:"123",appSecret:"fixture",allowUsers:["user"]});
  try {
    const created=fixture("qq-bundled-files");
    const snapshotPath=join(root,"qq-report.txt"),secondSnapshot=join(root,"qq-report-2.txt");writeFileSync(snapshotPath,"a");writeFileSync(secondSnapshot,"b");
    works.transaction(()=>works.generatedArtifacts.record(created.binding,[{path:join(root,"qq-source.txt"),snapshotPath,
      digest:createHash("sha256").update("a").digest("hex"),sizeBytes:1,registeredAt:clock,sourceEntryId:1},
      {path:join(root,"qq-source-2.txt"),snapshotPath:secondSnapshot,digest:createHash("sha256").update("b").digest("hex"),sizeBytes:1,registeredAt:clock,sourceEntryId:2}]));
    unwrap(works.submitDeliverable(created.worker,{operationId:"qq-submit",workId:created.work.workId,bindingId:created.binding.bindingId,
      deliverableId:"qq-file-deliverable",summary:"file delivered",artifactRefs:[snapshotPath,secondSnapshot],evidence:[{kind:"tool_receipt",sourceRef:"qq-proof"}]}));
    unwrap(works.acceptDeliverable(user,{operationId:"qq-accept",workId:created.work.workId,deliverableId:"qq-file-deliverable"}));
    works.reconcileExecution(user,{bindingId:created.binding.bindingId,outcome:"completed"});
    const f={...created,notification:works.repo.listNotifications(created.work.workId).find(item=>item.kind==="result")!};
    const target=gatewayWorkTargetSchema.parse({version:1,channelType:"qq",channelId:adapter.id,connectionKey:adapter.workConnectionKey(),
      chatId:"c2c:user",senderId:"user",address:{recipient:"user",group:false,messageId:"original",expiresAt:Date.now()+60000}});
    const {GatewayWorkTargets}=await import('../src/main/gateway/GatewayWorkTargets');
    const {workDeliveryContext}=await import('../src/main/agent/work/WorkDeliveryContext');
    const originMessage=`qq-source:${f.suffix}`,originConversation=`qq-conversation:${f.suffix}`;
    works.repo.updateWork({...works.getWork(f.work.workId)!,sourceMessageId:originMessage});
    db.connection.prepare('INSERT INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES(?,?,?,?)')
      .run(f.work.workId,originConversation,'bot-delivery',clock);
    const recorded=new GatewayWorkTargets(db.connection).record({userId:LOCAL_USER_ID,conversationId:originConversation,sourceMessageId:originMessage,target,createdAt:clock});
    db.connection.prepare("INSERT INTO gateway_channels(id,type,name,connected) VALUES(?,?,?,?)").run(adapter.id,'qq','QQ fixture',0);
    const endpoint:AsyncWorkNotificationChannel={channel:"gateway:qq-ledger-real",targetKey:recorded.targetKey,...capabilityOfGuarantee("best-effort-unqueryable"),
      send:async input=>adapter.sendWorkNotification({target,text:"成果摘要",effectKey:input.idempotencyKey,
        qqMessageSequence:qqWorkMessageSequence(db.connection,recorded.targetKey,"gateway:qq-ledger-real",input.idempotencyKey),
        files:input.notification.deliveryFiles,
        assertCurrent:input.assertCurrent,recordProgress:input.recordProgress})};
    works.repo.updateNotificationLinks(f.notification.notificationId,{targetKey:endpoint.targetKey,cardKey:f.notification.cardKey});
    works.repo.updateNotificationDelivery(f.notification.notificationId,{channel:endpoint.channel,delivery:"pending"});
    const pending=workDeliveryContext(db.connection,f.binding)!;
    assert.equal(pending.routes[0].connection,'disconnected');assert.equal(pending.routes[0].summaryDelivery.state,'pending');
    assert.equal(pending.routes[0].fileDelivery.capability,'supported');
    await works.notifications.deliverAsync(endpoint,f.work.workId);await works.notifications.deliverAsync(endpoint,f.work.workId);
    assert.equal(posts,1);assert.equal(uploads,1);
    assert.match(String(bodies[0].content),/压缩包.*2.*原始文件/);assert.match(String(bodies[0].content),/成果摘要/);assert.equal(bodies[0].msg_type,7);assert.equal(bodies[0].msg_seq,2);
    assert.equal(works.repo.getNotification(f.notification.notificationId)?.delivery,"sent");
    const row=db.connection.prepare("SELECT status,receipt FROM work_notification_attempts WHERE notification_id=?").get(f.notification.notificationId) as {status:string;receipt:string};
    assert.equal(row.status,"sent");const parts=JSON.parse(row.receipt);
    assert.equal(parts[0].receipt,"provider-qq-summary");assert.equal(parts[0].part,`file:${createHash("sha256").update("a").digest("hex")}`);
    assert.equal(parts[0].via,"zip");assert.equal(parts[1].part,`file:${createHash("sha256").update("b").digest("hex")}`);assert.equal(parts[1].via,"zip");assert.equal(parts[2].via,"media_content");
    const reader=new Database(path,{readonly:true});
    const facts=workDeliveryContext(reader,f.binding)!;
    assert.equal(facts.routes[0].summaryDelivery.state,'sent');assert.equal(facts.routes[0].fileDelivery.state,'sent');
    assert.equal(facts.scope,'reply_to_original_request_only');
    const serialized=JSON.stringify(facts);
    for(const hidden of [recorded.targetKey,target.connectionKey,originMessage,originConversation,'provider-qq-summary','c2c:user'])assert(!serialized.includes(hidden));
    assert.equal(workDeliveryContext(reader,{...f.binding,intentRevision:f.binding.intentRevision+1}),undefined);
    assert.equal(workDeliveryContext(reader,{...f.binding,botId:'other-user-bot'}),undefined);
    reader.close();
    db.connection.prepare("UPDATE work_notification_attempts SET status='unknown',receipt=NULL WHERE notification_id=?").run(f.notification.notificationId);
    assert.equal(workDeliveryContext(db.connection,f.binding)?.routes[0].summaryDelivery.state,'unknown');
    db.connection.prepare("UPDATE work_notification_attempts SET status=?,receipt=? WHERE notification_id=?").run(row.status,row.receipt,f.notification.notificationId);
    const before=works.getWork(f.work.workId)!;
    db.connection.prepare('UPDATE works SET user_id=? WHERE work_id=?').run('other-user',before.workId);
    assert.equal(workDeliveryContext(db.connection,f.binding),undefined,'other user cannot acquire the original recipient context');
    db.connection.prepare('UPDATE works SET user_id=? WHERE work_id=?').run(before.userId,before.workId);
    console.log('PASS host delivery facts project QQ media+content receipt, keep disconnect and unknown honest, reject other user/version and expose no route identifiers');

    console.log("PASS QQ adapter explicitly bundles two frozen files and summary in one reserved slot; persisted success prevents repeat upload/send");
  } finally {await adapter.disconnect();}
}
{
  const {freezeCardDeliveryFiles}=await import('../src/main/agent/work/WorkDeliveryArtifacts');
  const f=fixture('automatic-proposed-file-card');
  const snapshot=join(root,'automatic-final.txt');writeFileSync(snapshot,'FINAL_BETA');
  const unselected=join(root,'automatic-unselected.txt');writeFileSync(unselected,'private intermediate');
  const digest=createHash('sha256').update('FINAL_BETA').digest('hex');
  works.transaction(()=>works.generatedArtifacts.record(f.binding,[{path:join(root,'final.txt'),snapshotPath:snapshot,digest,sizeBytes:10,registeredAt:clock,sourceEntryId:17},
    {path:join(root,'intermediate.txt'),snapshotPath:unselected,digest:createHash('sha256').update('private intermediate').digest('hex'),sizeBytes:20,registeredAt:clock,sourceEntryId:18}]));
  unwrap(works.submitDeliverable(f.worker,{operationId:'automatic-proposed-submit',workId:f.work.workId,bindingId:f.binding.bindingId,
    deliverableId:'automatic-proposed-deliverable',summary:'file ready',artifactRefs:[snapshot,unselected],evidence:[{kind:'tool_receipt',sourceRef:'read-exact-bytes'}]}));
  works.reconcileExecution(user,{bindingId:f.binding.bindingId,outcome:'completed'});
  db.connection.exec('CREATE TABLE IF NOT EXISTS work_completion_turns(binding_id TEXT PRIMARY KEY,context_json TEXT NOT NULL,decision_json TEXT,state TEXT,attempts INTEGER,retry_at INTEGER,error TEXT)');
  db.connection.prepare('INSERT INTO work_completion_turns(binding_id,context_json,decision_json,state) VALUES(?,?,?,?)').run(f.binding.bindingId,'{}',JSON.stringify({decision:'deliver',outcome:'completed',artifactRefs:[snapshot]}),'running');
  works.automaticCompletion.recordDelivery(f.binding.bindingId,'ready','completed',true);
  const work={...works.getWork(f.work.workId)!,closeOperationId:'automatic-completion:'+f.binding.bindingId};
  const card=works.transaction(()=>works.phase5.recordClosure(work,'succeeded',clock));
  assert.deepEqual(card.deliverableIds,['automatic-proposed-deliverable']);assert.deepEqual(card.artifactRefs,[snapshot]);
  assert.deepEqual(works.getWork(f.work.workId)!.acceptedDeliverableIds,[],'automatic delivery must not manufacture user acceptance');
  const files=freezeCardDeliveryFiles(works,{workId:f.work.workId,cardKey:card.cardKey});
  assert.equal(files.length,1);assert.equal(files[0].sha256,digest);assert.equal(files[0].name,'final.txt');
  assert.equal(Buffer.from(files[0].base64,'base64').toString(),'FINAL_BETA');
  console.log('PASS automatic closure card keeps exact reviewed proposed file without fake acceptance');
}
{
  const f=fixture('reviewed-wait-partial');
  const snapshot=join(root,'wait-draft.txt');writeFileSync(snapshot,'DRAFT_ALPHA');
  const digest=createHash('sha256').update('DRAFT_ALPHA').digest('hex');
  works.transaction(()=>works.generatedArtifacts.record(f.binding,[{path:join(root,'draft.txt'),snapshotPath:snapshot,digest,sizeBytes:11,registeredAt:clock,sourceEntryId:21}]));
  unwrap(works.submitDeliverable(f.worker,{operationId:'wait-proposed-submit',workId:f.work.workId,bindingId:f.binding.bindingId,
    deliverableId:'wait-proposed-deliverable',summary:'draft needs user direction',artifactRefs:[snapshot],evidence:[{kind:'tool_receipt',sourceRef:'read-draft'}]}));
  works.reconcileExecution(user,{bindingId:f.binding.bindingId,outcome:'completed'});
  db.connection.prepare('INSERT INTO work_completion_turns(binding_id,context_json,decision_json,state) VALUES(?,?,?,?)')
    .run(f.binding.bindingId,JSON.stringify({originalRequest:{userRequest:{messages:[{text:'先交草稿，我稍后补充目标读者。'}]}}}),JSON.stringify({decision:'wait',outcome:'partial',artifactRefs:[snapshot],userInput:{requestExcerpt:'我稍后补充目标读者'}}),'running');
  unwrap(works.reportBlocker(owner,{operationId:`completion:${f.binding.bindingId}:question`,workId:f.work.workId,
    reason:'Please confirm the draft',kind:'operational',waitingForUserInput:true,userInput:{kind:'reply'},
    versionGuard:guard(works.getWork(f.work.workId)!)},f.binding.bindingId));
  const work=works.getWork(f.work.workId)!;
  assert.equal(work.lifecycle,'active');assert.deepEqual(work.acceptedDeliverableIds,[]);
  const card=works.cards.list(work).find(item=>item.kind==='blocked_escalation')!;
  assert.deepEqual(card.deliverableIds,['wait-proposed-deliverable']);assert.deepEqual(card.artifactRefs,[snapshot]);
  const notification=works.repo.listNotifications(work.workId).find(item=>item.cardKey===card.cardKey)!;
  assert.equal(notification.body,'原用户待补充要求：我稍后补充目标读者');
  let sends=0;
  const channel:AsyncWorkNotificationChannel={channel:'gateway:reviewed-wait-test',targetKey:'original-wait-route',...capabilityOfGuarantee('best-effort-unqueryable'),
    send:async input=>{sends++;input.assertCurrent();assert.equal(input.notification.kind,'blocked');
      assert.equal(input.notification.deliveryFiles?.length,1);const file=input.notification.deliveryFiles![0];
      assert.equal(file.name,'draft.txt');assert.equal(file.sha256,digest);assert.equal(Buffer.from(file.base64,'base64').toString(),'DRAFT_ALPHA');
      return {ok:true,receipt:'real-fixture-partial-receipt'};}};
  works.repo.updateNotificationLinks(notification.notificationId,{targetKey:channel.targetKey,cardKey:card.cardKey});
  works.repo.updateNotificationDelivery(notification.notificationId,{channel:channel.channel,delivery:'pending'});
  await works.notifications.deliverAsync(channel,work.workId);await works.notifications.deliverAsync(channel,work.workId);
  assert.equal(sends,1);assert.equal(works.repo.getNotification(notification.notificationId)?.delivery,'sent');
  assert.equal(works.notifications.attempts(notification.notificationId).at(-1)?.receipt,'real-fixture-partial-receipt');
  console.log('PASS reviewed wait sends exact partial file via existing notification ledger once without accepting or closing Work');
}
for (const recovery of [false,true]) {
  const f=fixture(`same-revision-wait-${recovery}`);
  const stage=(binding:typeof f.binding,label:string)=>{
    const snapshot=join(root,`${f.suffix}-${label}.txt`);writeFileSync(snapshot,label);
    works.transaction(()=>works.generatedArtifacts.record(binding,[{path:join(root,`${label}.txt`),snapshotPath:snapshot,
      digest:createHash('sha256').update(label).digest('hex'),sizeBytes:label.length,registeredAt:clock,sourceEntryId:31}]));
    unwrap(works.submitDeliverable({kind:'worker',botId:binding.botId,bindingId:binding.bindingId},{operationId:`submit:${binding.bindingId}`,workId:f.work.workId,bindingId:binding.bindingId,
      deliverableId:`deliverable:${binding.bindingId}`,summary:label,artifactRefs:[snapshot],evidence:[{kind:'tool_receipt',sourceRef:'read-stage'}]}));
    works.reconcileExecution(user,{bindingId:binding.bindingId,outcome:'completed'});
    db.connection.prepare('INSERT INTO work_completion_turns(binding_id,context_json,decision_json,state) VALUES(?,?,?,?)')
      .run(binding.bindingId,'{}',JSON.stringify({decision:'ask',outcome:'partial',artifactRefs:[snapshot]}),'running');
    unwrap(works.reportBlocker(owner,{operationId:`completion:${binding.bindingId}:question`,workId:f.work.workId,
      reason:'Which audience?',kind:'operational',waitingForUserInput:true,userInput:{kind:'reply'},
      versionGuard:guard(works.getWork(f.work.workId)!)},binding.bindingId));
    const card=works.cards.list(works.getWork(f.work.workId)!).find(item=>item.deliverableIds.includes(`deliverable:${binding.bindingId}`))!;
    const notification=works.repo.listNotifications(f.work.workId).find(item=>item.cardKey===card.cardKey)!;
    return {card,notification};
  };
  const first=stage(f.binding,'old-draft');let oldSends=0,newSends=0;
  const channel:AsyncWorkNotificationChannel={channel:`gateway:wait-replacement-${recovery}`,targetKey:`route:${f.suffix}`,
    ...capabilityOfGuarantee('idempotent-queryable'),lookup:async()=> 'missing',send:async input=>{
      input.assertCurrent();if(input.notification.notificationId===first.notification.notificationId){oldSends++;return {ok:false,retryable:false,responseLost:true,error:'response lost'};}
      newSends++;assert.equal(input.notification.deliveryFiles?.length,1);
      assert.equal(Buffer.from(input.notification.deliveryFiles![0].base64,'base64').toString(),'new-draft');
      return {ok:true,receipt:'new-draft-provider-receipt'};
    }};
  const route=(notificationId:string,cardKey:string)=>{works.repo.updateNotificationLinks(notificationId,{targetKey:channel.targetKey,cardKey});
    works.repo.updateNotificationDelivery(notificationId,{channel:channel.channel,delivery:'pending'});};
  route(first.notification.notificationId,first.card.cardKey);
  if(recovery)await works.notifications.deliverAsync(channel,f.work.workId);
  const oldBlocker=works.repo.listOpenBlockers(f.work.workId)[0];works.repo.clearBlocker(oldBlocker.blockerId,f.work.workId,clock);
  assert.equal(works.cards.list(works.getWork(f.work.workId)!).find(item=>item.cardKey===first.card.cardKey)?.currency,'superseded');
  const taskId=`second:${f.suffix}`;db.upsertTask({id:taskId,title:taskId,updatedAt:clock});
  unwrap(works.dispatchExecution(user,{operationId:`dispatch:${taskId}`,workId:f.work.workId,botId:DEFAULT_BOT_ID,taskId,
    durableStoreKey:`store:${taskId}`,conversationId:'2',workspaceBinding:root,delegatedScope:['workspace:read','workspace:write']}));
  const secondBinding=works.repo.listBindings(f.work.workId).find(item=>item.taskId===taskId)!;
  assert.equal(secondBinding.intentRevision,f.binding.intentRevision);
  const second=stage(secondBinding,'new-draft');route(second.notification.notificationId,second.card.cardKey);
  const cards=works.cards.list(works.getWork(f.work.workId)!);
  assert.equal(cards.find(item=>item.cardKey===first.card.cardKey)?.currency,'superseded','same text and timestamp of new question cannot revive old card');
  assert.equal(cards.find(item=>item.cardKey===second.card.cardKey)?.currency,'current');
  await works.notifications.deliverAsync(channel,f.work.workId);await works.notifications.deliverAsync(channel,f.work.workId);
  assert.equal(oldSends,recovery?1:0,'cleared question cannot send pending or retry missing delivery');assert.equal(newSends,1);
  console.log(`PASS same-revision replacement fences old ${recovery?'queryable recovery':'pending'} partial and delivers only new snapshot`);
}
for (const priorDelivery of ['unknown','sent'] as const) {
  const f=fixture(`closure-review-card-${priorDelivery}`);
  const files=['prior-choice','corrected-choice'].map((text,index)=>{const snapshot=join(root,`${f.suffix}-${index}.txt`);writeFileSync(snapshot,text);
    return {path:join(root,`${text}.txt`),snapshotPath:snapshot,digest:createHash('sha256').update(text).digest('hex'),sizeBytes:text.length,registeredAt:clock,sourceEntryId:40+index};});
  works.transaction(()=>works.generatedArtifacts.record(f.binding,files));
  unwrap(works.submitDeliverable(f.worker,{operationId:`submit:${f.suffix}`,workId:f.work.workId,bindingId:f.binding.bindingId,
    deliverableId:`deliverable:${f.suffix}`,summary:'two registered versions',artifactRefs:files.map(file=>file.snapshotPath),evidence:[{kind:'tool_receipt',sourceRef:'read-files'}]}));
  works.reconcileExecution(user,{bindingId:f.binding.bindingId,outcome:'completed'});
  db.connection.prepare('INSERT INTO work_completion_turns(binding_id,context_json,decision_json,state) VALUES(?,?,?,?)')
    .run(f.binding.bindingId,'{}',JSON.stringify({decision:'deliver',outcome:'partial',artifactRefs:[files[0].snapshotPath]}),'delivered');
  works.automaticCompletion.recordDelivery(f.binding.bindingId,'mistaken transport failure','partial',true);
  const failed={...works.getWork(f.work.workId)!,closeOperationId:`automatic-completion:${f.binding.bindingId}`};
  const oldCard=works.transaction(()=>works.phase5.recordClosure(failed,'ended_unsuccessfully',clock));
  const {DiscordGatewayAdapter}=await import('../src/main/gateway/DiscordGatewayAdapter');
  const {closureCorrectionNotice}=await import('../src/main/agent/work/WorkClosureCorrectionDelivery');
  const {workGatewayText}=await import('../src/main/agent/work/WorkGatewayNotificationChannel');
  class CorrectionSocket {
    onmessage: ((event:{data:unknown})=>void)|null=null;
    onclose: ((event:{code?:number})=>void)|null=null;
    onerror: (()=>void)|null=null;
    frame(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
    send(value:string){const op=JSON.parse(value).op;if(op===2)queueMicrotask(()=>this.frame({op:0,t:'READY',s:1,d:{user:{id:'100',bot:true},application:{id:'200'},session_id:'correction',resume_gateway_url:'wss://gateway.discord.gg'}}));if(op===1)this.frame({op:11});}
    close(){}
  }
  let filePosts=0,textPosts=0;
  const adapter=new DiscordGatewayAdapter(`correction-${f.suffix}`,'Discord',{
    socketFactory:()=>{const socket=new CorrectionSocket();queueMicrotask(()=>socket.frame({op:10,d:{heartbeat_interval:60000}}));return socket;},
    fetch:async(url,init)=>{
      if(String(url).endsWith('/users/@me'))return Response.json({id:'100',bot:true});
      if(String(url).endsWith('/oauth2/applications/@me'))return Response.json({id:'200'});
      if(String(url).endsWith('/gateway/bot'))return Response.json({url:'wss://gateway.discord.gg'});
      assert(init?.body instanceof FormData);const body=JSON.parse(String(init.body.get('payload_json')));
      if(body.attachments.length){filePosts++;assert.equal(await (init.body.get('files[0]') as Blob).text(),'prior-choice');if(priorDelivery==='unknown')throw new Error('provider accepted file but response lost');}
      else {textPosts++;assert.match(body.content,/结论更正/);assert.match(body.content,priorDelivery==='unknown'?/回执未知/:/已有发送回执/);assert.equal(init.body.get('files[0]'),null);}
      return Response.json({id:'900',channel_id:'500'});
    }});
  await adapter.connect({botToken:'fixture',applicationId:'200',allowUsers:['300'],allowDirectMessages:true});
  const target={version:1 as const,channelType:'discord' as const,channelId:adapter.id,connectionKey:adapter.workConnectionKey()!,chatId:'chat',senderId:'300',
    address:{channelId:'500',guildId:null,applicationId:'200',botId:'100',messageId:'600'}};
  const endpoint:AsyncWorkNotificationChannel={channel:`gateway:${adapter.id}`,targetKey:`target:${f.suffix}`,...capabilityOfGuarantee('best-effort-unqueryable'),
    send:async input=>adapter.sendWorkNotification({target,text:workGatewayText(closureCorrectionNotice(db.connection,input.notification)?{...input.notification,deliveryFiles:undefined}:input.notification),
      files:input.notification.deliveryFiles,effectKey:input.idempotencyKey,assertCurrent:input.assertCurrent,recordProgress:input.recordProgress,signal:input.signal})};
  const notify=(cardKey:string,id:string)=>works.repo.insertNotification({notificationId:id,workId:f.work.workId,semanticKey:id,kind:'closed',title:'closure',body:'closure summary',
    stateVersion:failed.stateVersion,intentRevision:failed.intentRevision,delivery:'pending',createdAt:clock,attemptCount:0,cardKey,channel:endpoint.channel,targetKey:endpoint.targetKey});
  const oldId=`old:${f.suffix}`;notify(oldCard.cardKey,oldId);
  await works.notifications.deliverAsync(endpoint,f.work.workId);
  assert.equal(filePosts,1);assert.equal(works.repo.getNotification(oldId)?.delivery,priorDelivery);
  const oldAttempts=JSON.stringify(works.notifications.attempts(oldId));
  db.connection.exec(`CREATE TABLE IF NOT EXISTS work_closure_review_corrections (
    operation_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,binding_id TEXT NOT NULL,
    original_close_operation_id TEXT NOT NULL,original_conclusion TEXT NOT NULL,original_summary TEXT,
    original_closed_at INTEGER NOT NULL,evidence_json TEXT NOT NULL,decision_json TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  const operationId=`correct:${f.suffix}`;
  db.connection.prepare('INSERT INTO work_closure_review_corrections VALUES(?,?,?,?,?,?,?,?,?,?)').run(operationId,f.work.workId,f.binding.bindingId,
    failed.closeOperationId,'ended_unsuccessfully','mistaken transport failure',clock,'{}',JSON.stringify({decision:'deliver',outcome:'completed',
      correction:{kind:'host_delivery_responsibility'},artifactRefs:[files[1].snapshotPath]}),clock);
  const corrected=works.transaction(()=>works.phase5.recordClosure(failed,'succeeded',clock,{correctionOperationId:operationId}));
  assert.deepEqual(corrected.artifactRefs,[files[1].snapshotPath],'new readonly review selection replaces original review selection');
  assert.notEqual(corrected.cardKey,oldCard.cardKey);
  const cards=works.cards.list(works.getWork(f.work.workId)!);
  assert.equal(cards.find(card=>card.cardKey===oldCard.cardKey)?.currency,'superseded');
  assert.equal(cards.find(card=>card.cardKey===corrected.cardKey)?.currency,'current');
  assert.deepEqual(cards.find(card=>card.cardKey===oldCard.cardKey)?.artifactRefs,[files[0].snapshotPath],'old failed card evidence preserved');
  assert.deepEqual(works.getWork(f.work.workId)?.acceptedDeliverableIds,[]);
  const {freezeCardDeliveryFiles}=await import('../src/main/agent/work/WorkDeliveryArtifacts');
  const frozen=freezeCardDeliveryFiles(works,{workId:f.work.workId,cardKey:corrected.cardKey});
  assert.equal(frozen.length,1);assert.equal(Buffer.from(frozen[0].base64,'base64').toString(),'corrected-choice');
  const correctionId=`new:${f.suffix}`;notify(corrected.cardKey,correctionId);
  await works.notifications.deliverAsync(endpoint,f.work.workId);await works.notifications.deliverAsync(endpoint,f.work.workId);
  assert.equal(filePosts,1,'conclusion correction must never replay original attachments');assert.equal(textPosts,1);
  assert.equal(JSON.stringify(works.notifications.attempts(oldId)),oldAttempts,'old receipts and unknown state remain immutable');
  const newPayload=JSON.parse((db.connection.prepare('SELECT payload_json FROM work_notification_attempts WHERE notification_id=?').get(correctionId) as {payload_json:string}).payload_json);
  assert.deepEqual(newPayload.deliveryFiles,[],'existing effect freezes text-only correction');
  await adapter.disconnect();
  assert.throws(()=>works.phase5.recordClosure(failed,'succeeded',clock,{correctionOperationId:'unknown-correction'}));
  console.log('PASS closure correction card uses new persisted review exact file and preserves superseded failed card without fake acceptance');
}
