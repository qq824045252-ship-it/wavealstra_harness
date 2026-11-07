import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { OWNER_SUMMARY_MAX_WAIT_MS } from "../src/main/agent/work/WorkOwnerSummary";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto,
  type WorkExecutionBindingDto, type WorkNotificationDto } from "../src/shared/bot-work";
import type { WorkCollaborationInput } from "../src/shared/bot-work-collaboration";

/** BW-A44: real member ledgers, persisted owner watermarks and independent notification intent. */
const root = mkdtempSync(join(tmpdir(), "phase5-owner-summary-"));
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const bot = (botId: string): WorkActor => ({ kind: "bot", userId: LOCAL_USER_ID, botId, host: "foreground", grants });
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion,
  expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const unwrap = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
let sequence = 0;
const open = new Set<AppDatabase>();
function environment(path = join(root, `work-${++sequence}.db`)) {
  const clock = { now: 1_800_000_000_000, authority: true };
  let db: AppDatabase;
  let works: WorkService;
  const connect = () => {
    db = new AppDatabase(path);
    open.add(db);
    const bots = new BotRegistry(db.connection);
    for (const [botId, displayName] of [[DEFAULT_BOT_ID, "负责人"], ["expert-a", "资料专家"],
      ["expert-b", "检查专家"], ["next-owner", "接任负责人"]]) {
      bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName, authorization: grants });
    }
    works = new WorkService(db.connection, { bots, now: () => clock.now, isAuthority: () => clock.authority });
  };
  connect();
  return { path, clock, get db() { return db; }, get works() { return works; },
    close() { open.delete(db); db.close(); }, restart() { open.delete(db); db.close(); connect(); } };
}
type Env = ReturnType<typeof environment>;
function fixture(e: Env, team = true, realEnvironment = false) {
  const work = unwrap(e.works.createWork(user, { operationId: "create", title: "核对两个专家的成果",
    authorization: grants, inputSnapshotId: "inputs:current", criteria: [{ text: "用户核对成果" },
      ...(realEnvironment ? [{ text: "在设备上核验", requiresRealEnvironmentCheck: true, requiredEnvironment: "windows" }] : [])] }));
  const bindings: WorkExecutionBindingDto[] = [];
  for (const botId of team ? ["expert-a", "expert-b"] : [DEFAULT_BOT_ID]) {
    if (botId !== DEFAULT_BOT_ID) unwrap(e.works.addParticipant(user, {
      operationId: `participant:${botId}`, workId: work.workId, botId, delegatedScope: grants.allowedScopes,
    }));
    e.db.upsertTask({ id: `task:${botId}`, title: botId, updatedAt: e.clock.now });
    unwrap(e.works.dispatchExecution(user, { operationId: `dispatch:${botId}`, workId: work.workId, botId,
      taskId: `task:${botId}`, durableStoreKey: `store:${botId}`, conversationId: "1", workspaceBinding: root,
      delegatedScope: grants.allowedScopes }));
    bindings.push(e.works.repo.listBindings(work.workId).find(binding => binding.botId === botId)!);
  }
  return { workId: work.workId, bindings };
}
function propose(e: Env, binding: WorkExecutionBindingDto, artifactRefs: string[] = []) {
  unwrap(e.works.submitDeliverable({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
    operationId: `deliver:${binding.botId}`, workId: binding.workId, bindingId: binding.bindingId,
    deliverableId: `deliverable:${binding.botId}`, summary: `${binding.botId} 的核对结果`, artifactRefs, evidence: [],
  }));
}
function accept(e: Env, binding: WorkExecutionBindingDto) {
  return e.works.acceptDeliverable(user, { operationId: `accept:${binding.botId}`, workId: binding.workId,
    deliverableId: `deliverable:${binding.botId}` });
}
function settle(e: Env, binding: WorkExecutionBindingDto) {
  unwrap(e.works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" }));
}
function accepted(e: Env, f: ReturnType<typeof fixture>, order = [0, 1]) {
  for (const index of order) { propose(e, f.bindings[index]!); settle(e, f.bindings[index]!); unwrap(accept(e, f.bindings[index]!)); }
}
function message(e: Env, binding: WorkExecutionBindingDto, kind: WorkCollaborationInput["kind"], id: string, body: string) {
  return e.works.collaboration.send(bot(binding.botId), { messageId: id, workId: binding.workId, kind,
    recipientBotIds: [e.works.getWork(binding.workId)!.ownerBotId], body,
    executionRefs: ["result", "blocked"].includes(kind) ? [{ bindingId: binding.bindingId, taskId: binding.taskId,
      durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding }] : [],
    versionGuard: guard(e.works.getWork(binding.workId)!),
  });
}
const cards = (e: Env, workId: string) => e.works.cards.list(e.works.getWork(workId)!).filter(card => card.kind === "owner_summary");
const notifications = (e: Env, workId: string) => e.works.repo.listNotifications(workId);
const watermark = (e: Env, workId: string) => {
  const row = e.db.connection.prepare("SELECT handled_watermark_json FROM work_owner_summaries WHERE work_id=?").get(workId) as
    { handled_watermark_json: string } | undefined;
  return row ? JSON.parse(row.handled_watermark_json).ownerNotification as { deadlineAt?: number; pendingSince?: number;
    publishedCardKey?: string; publishedDigest?: string; ownerEpoch: number; ownerBotId: string } | undefined : undefined;
};
const passes: string[] = [];
function check(name: string, run: () => void) { run(); passes.push(name); console.log(`PASS ${name}`); }

try {
  check("ordinary Work retains its accepted-result identity and does not enter the team pipeline", () => {
    const e = environment(), f = fixture(e, false);
    accepted(e, f, [0]);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(cards(e, f.workId).length, 0);
    assert.equal(notifications(e, f.workId).length, 1);
    assert.equal(notifications(e, f.workId)[0]!.notificationId, `notification-${f.workId}-deliverable:${DEFAULT_BOT_ID}`);
    assert.equal(notifications(e, f.workId)[0]!.semanticKey, `work:${f.workId}:result:deliverable:${DEFAULT_BOT_ID}`);
    assert.equal(notifications(e, f.workId)[0]!.kind, "result");
  });

  check("all accepted members produce one independent summary with no member notification spam", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f, [0]);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0, "one finished expert waits for the other within the bound");
    const deadline = watermark(e, f.workId)!.deadlineAt;
    accepted(e, f, [1]);
    const before = e.works.getWork(f.workId)!;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1, "clear completion publishes without waiting for the timer");
    assert.equal(cards(e, f.workId).length, 1);
    const card = cards(e, f.workId)[0]!;
    assert.equal(card.ownerSummary!.items.filter(item => item.kind === "accepted").length, 2);
    assert.deepEqual(card.ownerSummary!.waitingForBotIds, []);
    assert.equal(notifications(e, f.workId).length, 1);
    assert.equal(notifications(e, f.workId)[0]!.kind, "summary");
    assert.deepEqual(e.works.getWork(f.workId), before, "publishing does not change control, ownership, budget or lifecycle");
    assert.equal(deadline, e.clock.now + OWNER_SUMMARY_MAX_WAIT_MS);
    assert.equal(watermark(e, f.workId)!.deadlineAt, undefined);
    assert.equal(accept(e, f.bindings[0]!).ok, true);
    message(e, f.bindings[0]!, "result", "replayed-result", "Late repeated report of the accepted execution");
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(cards(e, f.workId).length, 1, "accepted execution reports cannot replace accepted proof with new chatter");
    assert.equal(e.works.repo.listBindings(f.workId).length, 2);
  });

  check("member return order yields the same canonical summary and stable notification identity", () => {
    const base = environment(), f = fixture(base);
    base.close();
    const paths = [join(root, "order-ab.db"), join(root, "order-ba.db")];
    for (const path of paths) copyFileSync(base.path, path);
    const runs = paths.map(path => environment(path));
    const keys = runs.map((e, index) => {
      for (const member of index ? [1, 0] : [0, 1]) {
        accepted(e, f, [member]);
        e.works.phase5.flushOwnerSummaries();
      }
      assert.equal(cards(e, f.workId).length, 1);
      assert.equal(notifications(e, f.workId).length, 1);
      return { semantic: cards(e, f.workId)[0]!.semanticCardKey, notification: notifications(e, f.workId)[0]!.notificationId };
    });
    assert.deepEqual(keys[0], keys[1]);
  });

  check("the first-fact deadline survives later messages, generic refresh and process restart", () => {
    const e = environment(), f = fixture(e);
    message(e, f.bindings[0]!, "result", "first-result", "Preliminary finding, not an accepted deliverable");
    const deadline = watermark(e, f.workId)!.deadlineAt!;
    assert.equal(deadline, e.clock.now + OWNER_SUMMARY_MAX_WAIT_MS);
    e.clock.now += 7_000;
    message(e, f.bindings[0]!, "result", "retry-result", "  Preliminary finding,   not an accepted deliverable  ");
    message(e, f.bindings[0]!, "question", "question", "Which environment should be checked?");
    e.works.transaction(() => e.works.phase5.refreshSummary(f.workId));
    assert.equal(watermark(e, f.workId)!.deadlineAt, deadline, "chatter cannot slide the user's deadline");
    assert.equal(e.works.phase5.nextOwnerSummaryDeadline(), deadline);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    e.restart();
    e.clock.now = deadline;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const card = cards(e, f.workId)[0]!;
    assert.equal(card.ownerSummary!.items.filter(item => item.kind === "reported").length, 1);
    assert.ok(card.ownerSummary!.items.every(item => item.kind !== "accepted"));
    assert.match(card.summary, /待核验/);
    assert.deepEqual(card.ownerSummary!.waitingForBotIds, ["expert-b"]);
    assert.deepEqual(e.works.getWork(f.workId)!.acceptedDeliverableIds, []);
    assert.equal(e.works.repo.listBindings(f.workId).length, 2);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.ok(e.works.phase5.summary(LOCAL_USER_ID, f.workId)!.pendingUserDecisions.includes("Which environment should be checked?"));
  });

  check("user blockers are immediately visible and repeated/internal retries do not notify again", () => {
    const e = environment(), f = fixture(e);
    const report = (operationId: string, reason: string, waitingForUserInput: boolean) => unwrap(e.works.reportBlocker(bot(DEFAULT_BOT_ID), {
      operationId, workId: f.workId, reason, waitingForUserInput, versionGuard: guard(e.works.getWork(f.workId)!),
    }));
    report("needs-user", "需要确认外部发布范围", true);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    report("duplicate-user-blocker", "需要确认外部发布范围", true);
    report("internal-retry", "内部连接重试", false);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    e.clock.now += OWNER_SUMMARY_MAX_WAIT_MS * 2;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.deepEqual(notifications(e, f.workId).map(item => item.kind), ["summary"]);
    assert.equal(cards(e, f.workId)[0]!.ownerSummary!.items.filter(item => item.kind === "blocked").length, 1);
    assert.doesNotMatch(cards(e, f.workId)[0]!.summary, /内部连接重试/);
    assert.ok(e.works.phase5.summary(LOCAL_USER_ID, f.workId)!.pendingUserDecisions.includes("需要确认外部发布范围"));
  });

  check("native child rejection, conflicts and errors survive aggregation without being accepted", () => {
    const e = environment(), f = fixture(e, true, true);
    e.works.transaction(() => e.works.partialResults.record(f.bindings[0]!, [
      { itemId: "blocked", task: "Wait for permission", required: true, dependencies: [], criterionIds: [],
        nativeStatus: "blocked", outcome: "blocked", artifactRefs: [], writeConflicts: ["shared-file.ts"], summary: "写入冲突待人工核对" },
      { itemId: "rejected", task: "Review rejected response", required: true, dependencies: [], criterionIds: [],
        nativeStatus: "rejected", outcome: "rejected", artifactRefs: [], writeConflicts: [], summary: "提供者拒绝了请求" },
      { itemId: "failed", task: "Check failed receipt", required: true, dependencies: [], criterionIds: [],
        nativeStatus: "error", outcome: "failed", artifactRefs: [], writeConflicts: [], summary: "执行回执报错" },
      { itemId: "done", task: "Preserve partial output", required: true, dependencies: [], criterionIds: [],
        nativeStatus: "done", outcome: "completed", artifactRefs: [], writeConflicts: [], summary: "已保留但待核验的子项" },
      { itemId: "done-conflicted", task: "Preserve output with a blocked write", required: true, dependencies: [], criterionIds: [],
        nativeStatus: "done", outcome: "completed", artifactRefs: [], writeConflicts: ["completed-conflict.ts"], summary: "原生成功标签不能覆盖被阻止的写入" },
    ], e.clock.now));
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0, "discovery preserves the original native fact time");
    e.clock.now += OWNER_SUMMARY_MAX_WAIT_MS;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const payload = cards(e, f.workId)[0]!.ownerSummary!;
    assert.ok(payload.items.some(item => item.kind === "blocked" && item.isError && item.writeConflicts.includes("shared-file.ts")));
    assert.ok(payload.items.some(item => item.kind === "rejected" && item.isError));
    assert.ok(payload.items.some(item => item.kind === "error" && item.isError));
    assert.ok(payload.items.some(item => item.kind === "awaiting_review"));
    assert.ok(payload.items.some(item => item.kind === "reported" && item.isError && item.writeConflicts.includes("completed-conflict.ts")
      && payload.pendingDecisionKeys.includes(item.key)));
    assert.ok(payload.items.some(item => item.kind === "awaiting_environment"));
    assert.ok(payload.items.every(item => item.kind !== "accepted"));
    assert.deepEqual(e.works.getWork(f.workId)!.acceptedDeliverableIds, []);
    assert.equal(e.works.partialResults.gaps(f.workId).length, 3);
    assert.equal(e.works.getWork(f.workId)!.lifecycle, "active");
  });

  check("new substance links to the prior summary while identical message retries remain quiet", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const first = cards(e, f.workId)[0]!;
    message(e, f.bindings[0]!, "question", "new-question", "Is a mobile device check required?");
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, first.cardKey), false);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const next = cards(e, f.workId).find(card => card.cardKey !== first.cardKey)!;
    assert.equal(next.previousCardKey, first.cardKey);
    assert.equal(cards(e, f.workId).find(card => card.cardKey === first.cardKey)!.currency, "superseded");
    assert.equal(next.currency, "current");
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, next.cardKey), true);
    message(e, f.bindings[0]!, "question", "same-question-retry", "  Is a mobile device check required?  ");
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(cards(e, f.workId).length, 2);
    assert.equal(notifications(e, f.workId).length, 2);
  });

  check("partial acceptance preserves its uncovered scope and blocked-write decision", () => {
    const e = environment(), f = fixture(e);
    const first = f.bindings[0]!, criterionId = e.works.getWork(f.workId)!.criteria[0]!.id;
    unwrap(e.works.submitDeliverable({ kind: "worker", botId: first.botId, bindingId: first.bindingId }, {
      operationId: "partial", workId: f.workId, bindingId: first.bindingId, deliverableId: "deliverable:expert-a",
      summary: "可保留的局部成果", hasWriteConflicts: true, uncoveredScope: ["尚未完成文件写入"], uncoveredCriterionIds: [criterionId],
    }));
    settle(e, first);
    unwrap(e.works.acceptDeliverable(user, { operationId: "partial-accept", workId: f.workId, deliverableId: "deliverable:expert-a",
      partialAcceptance: { reason: "只保留已核对的局部成果", criterionIds: [] } }));
    accepted(e, f, [1]);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const card = cards(e, f.workId)[0]!, item = card.ownerSummary!.items.find(value => value.botId === "expert-a")!;
    assert.equal(item.kind, "accepted");
    assert.equal(item.isError, true);
    assert.ok(item.writeConflicts.length > 0);
    assert.ok(card.ownerSummary!.pendingDecisionKeys.includes(item.key));
    assert.match(card.summary, /仍未覆盖.*尚未完成文件写入/);
    assert.equal(e.works.getWork(f.workId)!.lifecycle, "active");
    assert.equal(e.works.getWork(f.workId)!.criteria[0]!.status, "pending");
  });

  check("handoff retains the pending deadline and rejects the old owner's summary decision", () => {
    const e = environment(), f = fixture(e);
    message(e, f.bindings[0]!, "result", "handoff-result", "Original worker produced retained evidence");
    const before = e.works.getWork(f.workId)!, deadline = watermark(e, f.workId)!.deadlineAt;
    e.clock.now += 5_000;
    unwrap(e.works.handoffOwner(user, { operationId: "handoff", workId: f.workId, targetBotId: "next-owner" }));
    assert.equal(watermark(e, f.workId)!.deadlineAt, deadline);
    const stale = e.works.phase5.ownerSummaries.publish(bot(DEFAULT_BOT_ID), { workId: f.workId, versionGuard: guard(before) });
    assert.equal(stale.ok, false);
    assert.equal(cards(e, f.workId).length, 0);
    assert.ok(f.bindings.every(binding => e.works.collaboration.isDelegationAdopted(binding, e.works.getWork(f.workId)!)));
    e.clock.now = deadline!;
    const published = e.works.phase5.ownerSummaries.publish(bot("next-owner"), {
      workId: f.workId, versionGuard: guard(e.works.getWork(f.workId)!),
    });
    assert.equal(published.ok, true);
    assert.equal(published.changed, true);
    assert.equal(cards(e, f.workId)[0]!.originOwnerEpoch, before.ownerEpoch + 1);
    assert.match(cards(e, f.workId)[0]!.title, /接任负责人/);
    assert.match(cards(e, f.workId)[0]!.summary, /Original worker/);
    assert.equal(e.works.repo.listBindings(f.workId).length, 2);
  });

  check("an unsent summary survives handoff with the same identity and current owner's presentation", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const first = cards(e, f.workId)[0]!, intent = notifications(e, f.workId)[0]!;
    unwrap(e.works.handoffOwner(user, { operationId: "handoff", workId: f.workId, targetBotId: "next-owner" }));
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, first.cardKey), true);
    assert.equal(cards(e, f.workId).length, 1);
    const delivered: WorkNotificationDto[] = [];
    e.works.deliverPendingNotifications({ channel: "owner-summary-test", idempotent: true,
      lookup: () => "missing", send: input => { delivered.push(input.notification); return { ok: true, receipt: "sent" }; } }, f.workId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.notificationId, intent.notificationId);
    assert.equal(delivered[0]!.senderBotId, "next-owner");
    assert.match(delivered[0]!.body!, /当前负责人：接任负责人/);
  });

  check("a newly recorded fact fences the old summary before a new physical send", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const old = notifications(e, f.workId)[0]!;
    message(e, f.bindings[0]!, "question", "new-evidence", "The user must confirm the external target");
    const sent: string[] = [];
    const channel = { channel: "owner-summary-stale", idempotent: true, lookup: () => "missing" as const,
      send: ({ notification }: { notification: WorkNotificationDto }) => {
        sent.push(notification.notificationId); return { ok: true as const, receipt: "sent" };
      } };
    e.works.deliverPendingNotifications(channel, f.workId);
    assert.deepEqual(sent, []);
    assert.equal(e.works.notifications.identity(old.notificationId)!.semanticValidity, "superseded");
    assert.equal(e.works.notifications.attempts(old.notificationId).length, 0);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    e.works.deliverPendingNotifications(channel, f.workId);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0], old.notificationId);
  });

  check("changed accepted artifacts fence old success while the new verification gap can still notify", () => {
    const e = environment(), f = fixture(e);
    const artifact = join(root, `accepted-artifact-${sequence}.txt`);
    writeFileSync(artifact, "accepted content");
    const fingerprints = e.works.artifacts.register(f.bindings[0]!, [artifact]);
    e.works.transaction(() => e.works.artifacts.record(f.bindings[0]!, fingerprints));
    propose(e, f.bindings[0]!, [artifact]); settle(e, f.bindings[0]!); unwrap(accept(e, f.bindings[0]!));
    const retainedArtifact = join(root, `retained-artifact-${sequence}.txt`);
    writeFileSync(retainedArtifact, "unchanged accepted content");
    const retainedFingerprints = e.works.artifacts.register(f.bindings[1]!, [retainedArtifact]);
    e.works.transaction(() => e.works.artifacts.record(f.bindings[1]!, retainedFingerprints));
    propose(e, f.bindings[1]!, [retainedArtifact]); settle(e, f.bindings[1]!); unwrap(accept(e, f.bindings[1]!));
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const original = cards(e, f.workId)[0]!;
    writeFileSync(artifact, "modified content");
    const sent: WorkNotificationDto[] = [];
    const channel = { channel: "owner-summary-artifacts", idempotent: true, lookup: () => "missing" as const,
      send: ({ notification }: { notification: WorkNotificationDto }) => {
        sent.push(notification); return { ok: true as const, receipt: "sent" };
      } };
    e.works.deliverPendingNotifications(channel, f.workId);
    assert.equal(sent.length, 0);
    assert.equal(e.works.repo.getDeliverable("deliverable:expert-a")!.status, "superseded");
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, original.cardKey), false);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const gap = cards(e, f.workId).find(card => card.currency === "current")!;
    assert.ok(gap.ownerSummary!.items.some(item => item.kind === "blocked" && item.artifactRefs.includes(artifact)));
    assert.equal(gap.ownerSummary!.items.filter(item => item.kind === "accepted").length, 1);
    e.works.deliverPendingNotifications(channel, f.workId);
    assert.equal(sent.length, 1, "a recorded stale artifact is a visible gap, not an endless notification veto");
    assert.equal(sent[0]!.cardKey, gap.cardKey);
    assert.equal(e.works.repo.listBindings(f.workId).length, 2, "notification recovery never reruns the business work");
  });

  check("loss of host authority cannot write owner watermarks, cards or delivery intents", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    const before = watermark(e, f.workId);
    e.clock.authority = false;
    assert.throws(() => e.works.phase5.observeOwnerSummary(f.workId), /权威|authorit/i);
    assert.throws(() => e.works.phase5.flushOwnerSummaries(), /权威|authorit/i);
    assert.throws(() => e.works.phase5.ownerSummaries.publish(bot(DEFAULT_BOT_ID), {
      workId: f.workId, versionGuard: guard(e.works.getWork(f.workId)!),
    }), /权威|authorit/i);
    assert.deepEqual(watermark(e, f.workId), before);
    assert.equal(cards(e, f.workId).length, 0);
    assert.equal(notifications(e, f.workId).length, 0);
    e.clock.authority = true;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
  });

  check("card, handled watermark and intent roll back together when notification persistence fails", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    const before = watermark(e, f.workId), workBefore = e.works.getWork(f.workId);
    const journalBefore = e.db.connection.prepare("SELECT * FROM work_projection_streams").all();
    e.db.connection.exec(`CREATE TEMP TRIGGER fail_owner_summary BEFORE INSERT ON work_notifications
      WHEN NEW.kind='summary' BEGIN SELECT RAISE(ABORT,'injected-summary-intent-failure'); END`);
    assert.throws(() => e.works.phase5.flushOwnerSummaries(), /injected-summary-intent-failure/);
    assert.equal(cards(e, f.workId).length, 0);
    assert.equal(notifications(e, f.workId).length, 0);
    assert.deepEqual(watermark(e, f.workId), before);
    assert.deepEqual(e.db.connection.prepare("SELECT * FROM work_projection_streams").all(), journalBefore);
    assert.deepEqual(e.works.getWork(f.workId), workBefore);
    e.db.connection.exec("DROP TRIGGER fail_owner_summary");
    e.restart();
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(cards(e, f.workId).length, 1);
  });

  check("summary reads only advance attention facts and a successful close adds no duplicate delivery", () => {
    const e = environment(), f = fixture(e);
    unwrap(e.works.attestCriteria(user, { operationId: "checked", workId: f.workId,
      criterionUpdates: [{ criterionId: e.works.getWork(f.workId)!.criteria[0]!.id, status: "met", evidence: "Explicit user check" }] }));
    accepted(e, f);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const card = cards(e, f.workId)[0]!, before = e.works.getWork(f.workId)!;
    e.clock.now += 1_000;
    assert.equal(e.works.markWorkCardRead(user, { workId: f.workId, semanticCardKey: card.semanticCardKey }).ok, true);
    assert.deepEqual(e.works.getWork(f.workId), before);
    assert.equal(e.works.markWorkCardRead(user, { workId: f.workId, semanticCardKey: card.semanticCardKey,
      readAt: e.clock.now - 1 }).replayed, true);
    unwrap(e.works.closeWork(user, { operationId: "close", workId: f.workId, conclusion: "succeeded" }));
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    assert.equal(cards(e, f.workId).length, 1);
    assert.equal(notifications(e, f.workId).length, 1);
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, card.cardKey), true);
    assert.equal(e.works.getWork(f.workId)!.closureConclusion, "succeeded");
  });

  check("owner answers resolve decisions and those committed answers survive an ordinary handoff", () => {
    const e = environment(), f = fixture(e);
    accepted(e, f);
    message(e, f.bindings[0]!, "question", "question", "Is the scope sufficient?");
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    e.works.collaboration.send(bot(DEFAULT_BOT_ID), { messageId: "answer", workId: f.workId, kind: "accepted",
      recipientBotIds: ["expert-a"], replyToMessageId: "question", body: "The current scope is sufficient",
      versionGuard: guard(e.works.getWork(f.workId)!),
    });
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    const second = cards(e, f.workId).find(card => card.currency === "current")!;
    assert.ok(second.ownerSummary!.items.every(item => item.kind !== "question"));
    message(e, f.bindings[0]!, "question", "resolved-question-retry", "  Is the scope sufficient?  ");
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0, "an identical retry cannot reopen a handled decision");
    unwrap(e.works.handoffOwner(user, { operationId: "handoff", workId: f.workId, targetBotId: "next-owner" }));
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0, "ownership alone cannot reopen resolved questions");
    assert.equal(e.works.phase5.isOwnerSummaryCurrent(e.works.getWork(f.workId)!, second.cardKey), true);
  });

  check("expired authorization becomes a visible summary obligation without rerunning work", () => {
    const e = environment(), f = fixture(e);
    unwrap(e.works.amendWork(user, { operationId: "expiry", workId: f.workId,
      authorization: { ...grants, expiresAt: e.clock.now + 5_000 } }));
    const before = e.works.getWork(f.workId)!;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
    e.clock.now += 5_000;
    assert.equal(e.works.phase5.flushOwnerSummaries(), 1);
    assert.ok(cards(e, f.workId)[0]!.ownerSummary!.items.some(item => item.kind === "authorization"));
    assert.deepEqual(e.works.getWork(f.workId), before);
    assert.equal(e.works.phase5.flushOwnerSummaries(), 0);
  });
  console.log(`\n${passes.length} owner-summary scenarios passed`);
} finally {
  for (const db of open) db.close();
  rmSync(root, { recursive: true, force: true });
}
