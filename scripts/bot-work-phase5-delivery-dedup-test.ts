import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkResultCards } from "../src/main/agent/work/WorkResultCards";
import { resolveChannelCapability } from "../src/main/agent/work/WorkNotificationDelivery";
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

check("a restart reads the desktop effect back instead of notifying twice", () => {
  const f = accepted("host-restart");
  const notifications = new NotificationService(db, { read: () => ({}) } as unknown as AppSettingsStore);
  const host = new WorkNotificationHost(works, { isAuthority: () => true, channels: () => [createDesktopWorkChannel(notifications)] });
  host.drain(f.work.workId);
  const before = notifications.list({}).filter(item => item.dedupeKey?.startsWith("work-delivery:")).length;
  // A fresh host on the same database must reconcile the original effect.
  const reopened = new WorkNotificationHost(works, { isAuthority: () => true, channels: () => [createDesktopWorkChannel(notifications)] });
  const outcomes = reopened.drain(f.work.workId);
  assert.equal(notifications.list({}).filter(item => item.dedupeKey?.startsWith("work-delivery:")).length, before,
    "the second drain does not publish a duplicate");
  assert.ok(outcomes.every(item => item.delivery !== "pending"));
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

console.log(`Phase 5 delivery dedup: ${passes.length} passed`);
