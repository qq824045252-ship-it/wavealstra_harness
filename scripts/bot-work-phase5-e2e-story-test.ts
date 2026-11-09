import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { OWNER_SUMMARY_MAX_WAIT_MS } from "../src/main/agent/work/WorkOwnerSummary";
import { mergeWorkList } from "../src/renderer/src/store/app/slices/botWorkSync";
import { capabilityOfGuarantee } from "../src/shared/bot-work-phase5";
import type { WorkActor, WorkControlResult, WorkDto, WorkNotificationChannel, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkListCursor } from "../src/shared/bot-conversation";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

/**
 * Service-level regression for acceptance §9. The separate native-story test owns
 * the actual Pi Durable processes, child execution and SIGKILL acceptance evidence.
 *
 * The story drives the real Work service, the real watch ingress, the real projection
 * journal and the real notification chain. Two host restarts reopen the same SQLite file
 * instead of rebuilding a fresh fixture, so recovery is what is exercised. Native model
 * turns and the Omarchy desktop itself are injected as observations; this script does not
 * replace them with a fake agent loop, and it does not claim a real desktop run.
 */

const root = mkdtempSync(join(tmpdir(), "phase5-story-"));
const dbPath = join(root, "business.db");
const durablePath = join(root, "durable-submissions.json");
const effectPath = join(root, "effects.db");
const clock = { at: Date.UTC(2026, 10, 7, 9, 0, 0) };
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };

/** Minimal durable submission store: what the native side accepted, independent of Work. */
type DurableLog = { submissions: Array<{ submissionId: number; taskId: string; operationId: string; text: string }> };
const readDurable = (): DurableLog => {
  try { return JSON.parse(readFileSync(durablePath, "utf8")) as DurableLog; } catch { return { submissions: [] }; }
};
const writeDurable = (log: DurableLog) => writeFileSync(durablePath, JSON.stringify(log, null, 2));
readDurable();

function openHost() {
  const db = new AppDatabase(dbPath);
  const bots = new BotRegistry(db.connection);
  for (const botId of [DEFAULT_BOT_ID, "next-owner"]) {
    if (!bots.getBot(botId)) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
  }
  const works = new WorkService(db.connection, { bots, now: () => clock.at });
  return { db, bots, works, journal: new WorkProjectionJournal(db.connection, works) };
}
let host = openHost();
let { db, works, journal } = host;
/** Service fixture reopen only; this is not a process kill or a native recovery proof. */
function crashAndReopen() {
  db.connection.close();
  host = openHost();
  db = host.db; works = host.works; journal = host.journal;
  return host;
}
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const effectDb = new Database(effectPath);
effectDb.exec("CREATE TABLE IF NOT EXISTS effects(effect_key TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL)");
const effectCount = () => (effectDb.prepare("SELECT COUNT(*) AS count FROM effects").get() as { count: number }).count;
const steps: string[] = [];
const step = (name: string, run: () => void) => { run(); steps.push(name); console.log(`STEP ${steps.length}. ${name}`); };

const WORK_A = "watch A";
const WORK_B = "watch B";
let workA = "" as string;
let workB = "" as string;
let subA = "";
let subB = "";
let bindingB = "";

step("委托立项：A 记录停止条件与实测要求，B 是同宿主对照", () => {
  const created = unwrap(works.createWork(user, { operationId: "create-a", title: WORK_A, mode: "watch",
    authorization: grants, inputSnapshotId: "input:a@1", workspacePath: root,
    criteria: [{ text: "自动检查通过" }, { text: "Omarchy 实测通过", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }],
    watchRule: { catchUpPolicy: "each", maxMergeWaitMs: 1_000, maxQueueDepth: 8, stopConditionText: "Omarchy 实测通过且无回归" } }));
  workA = created.workId;
  const b = unwrap(works.createWork(user, { operationId: "create-b", title: WORK_B, mode: "watch",
    authorization: grants, inputSnapshotId: "input:b@1", workspacePath: root,
    criteria: [{ text: "自动检查通过" }],
    watchRule: { catchUpPolicy: "each", maxMergeWaitMs: 1_000, maxQueueDepth: 8, stopConditionText: "B 自身停止条件" } }));
  workB = b.workId;
  const configure = (work: WorkDto, id: string, target: string) => {
    const result = works.phase4Control(user, { kind: "configure-subscription", operationId: `sub:${id}`, workId: work.workId,
      source: "hook", catchUpPolicy: "each", maxMergeWaitMs: 1_000, maxQueueDepth: 8, targetKey: target,
      stopConditionText: work.watchRule?.stopConditionText, versionGuard: guard(works.getWork(work.workId)!) });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.subscriptionId!;
  };
  subA = configure(created, "a", "A");
  subB = configure(b, "b", "B");
  assert.notEqual(subA, subB);
  assert.equal(works.getWork(workA)!.ownerEpoch, 1);
  assert.ok(works.repo.listSubscriptions(workA).length >= 1);
  assert.ok(works.repo.listSubscriptions(workB).length >= 1);
  assert.equal("budget" in works.getWork(workA)!, false);
  assert.equal("budget" in works.getWork(workB)!, false);
  assert.equal(works.getWork(workA)!.criteria[1]!.status, "pending", "A 未提前通过实测");
});

step("真实 Hook：一个逻辑检查，重复与乱序不新派发，前台只读持久事实", () => {
  const executionsBefore = works.repo.listBindings(workA).length;
  const first = works.ingestSourceEvent({ source: "hook", sourceEventId: "hook-1", eventType: "changed",
    sourceVersion: "1", workId: workA, payload: { target: "A", value: 1 } });
  assert.equal(first.acknowledged, true);
  assert.ok(first.outcomes.some(item => item.subscriptionId === subA));
  const duplicate = works.ingestSourceEvent({ source: "hook", sourceEventId: "hook-1", eventType: "changed",
    sourceVersion: "1", workId: workA, payload: { target: "A", value: 1 } });
  assert.equal(duplicate.sourceNew, false);
  const stale = works.ingestSourceEvent({ source: "hook", sourceEventId: "hook-0", eventType: "changed",
    sourceVersion: "0", workId: workA, payload: { target: "A", value: 0 } });
  assert.ok(stale.outcomes.every(item => item.outcome === "skipped" || item.outcome === "duplicate" || item.outcome === "pending"));
  const inbox = works.repo.listInbox(workA);
  assert.equal(inbox.filter(item => item.sourceEventId === "hook-1").length, 1, "重复 Hook 只有一个逻辑事实");
  // Foreground status/queries never create background work.
  const summary = works.getWorkSummary(LOCAL_USER_ID, workA)!;
  assert.equal(summary.lifecycle, "active");
  journal.sync(LOCAL_USER_ID, { includeClosed: false });
  assert.equal(works.repo.listBindings(workA).length, executionsBefore, "前台查询不新建任务");
});

step("中途改要求：intentRevision 升到 2，旧执行失效，新快照冻结", () => {
  const before = works.getWork(workA)!;
  unwrap(works.dispatchExecution(user, { operationId: "dispatch-a-r1", workId: workA, botId: DEFAULT_BOT_ID,
    taskId: "task-a-r1", durableStoreKey: "store-a", conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"], versionGuard: guard(before) }));
  const amended = unwrap(works.amendWork(user, { operationId: "amend-a", workId: workA,
    constraints: ["只检查 Linux，先别发布"], inputSnapshotId: "input:a@2",
    invalidateExecutionIds: works.repo.listBindings(workA).filter(item => item.status !== "invalidated").map(item => item.bindingId),
    versionGuard: guard(works.getWork(workA)!) }));
  assert.equal(amended.intentRevision, 2);
  assert.equal(amended.inputSnapshotId, "input:a@2");
  assert.ok(works.repo.listBindings(workA).every(item => item.status === "invalidated" || item.invalidatedAt));
  const snapshots = works.repo.listIntentSnapshots(workA);
  assert.deepEqual(snapshots.map(item => item.intentRevision).sort(), [1, 2]);
});

step("提交回执窗口：原生已接受、业务回执未保存时宿主重启", () => {
  const work = works.getWork(workA)!;
  unwrap(works.dispatchExecution(user, { operationId: "dispatch-a-r2", workId: workA, botId: DEFAULT_BOT_ID,
    taskId: "task-a-r2", durableStoreKey: "store-a", conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"], versionGuard: guard(work) }));
  const binding = works.repo.listBindings(workA).find(item => item.operationId === "dispatch-a-r2")!;
  works.markDispatchAttempt(binding.bindingId, "attempt-a-1");
  // The native side accepted submission 1; the business receipt write never happened.
  const durable = readDurable();
  durable.submissions.push({ submissionId: 1, taskId: "task-a-r2", operationId: "dispatch-a-r2", text: "check linux" });
  writeDurable(durable);
  crashAndReopen();
  const recovered = works.repo.listBindings(workA).filter(item => item.operationId === "dispatch-a-r2");
  assert.equal(recovered.length, 1, "重启后不得创建第二个 root 补回执");
  assert.equal(recovered[0]!.bindingId, binding.bindingId, "原执行身份被找回");
  assert.equal(recovered[0]!.submissionReceipt, undefined, "业务回执确实还未保存");
  assert.equal(readDurable().submissions.length, 1, "原生提交没有被重放");
  // Recovery settles the original identity instead of resubmitting.
  assert.equal(works.recordSubmissionReceipt(binding.bindingId, "submission:1").ok, true);
  assert.equal(works.repo.getBinding(binding.bindingId)!.submissionReceipt, "submission:1");
  assert.equal(readDurable().submissions.length, 1);
});

step("旧结果晚到：r1 结果归档为历史，不覆盖当前成果", () => {
  const oldBinding = works.repo.listBindings(workA).find(item => item.operationId === "dispatch-a-r1")!;
  const late = works.submitDeliverable({ kind: "worker", botId: oldBinding.botId, bindingId: oldBinding.bindingId },
    { operationId: "late-result", workId: workA, bindingId: oldBinding.bindingId, deliverableId: "deliverable-late",
      summary: "旧要求的检查结果", evidence: [{ kind: "tool_receipt", sourceRef: "old-receipt" }] });
  // The late fact is kept as history; it can never become the current result.
  const lateWork = works.getWork(workA)!;
  assert.equal(lateWork.intentRevision, 2);
  const accepted = works.acceptDeliverable(user, { operationId: "accept-late", workId: workA,
    deliverableId: "deliverable-late", versionGuard: guard(lateWork) });
  assert.equal(accepted.ok, false, "旧执行的结果不能按当前要求验收");
  assert.equal(accepted.ok === false && accepted.code, "version_conflict");
  assert.deepEqual(works.getWork(workA)!.acceptedDeliverableIds, []);
  assert.equal(works.cards.list(works.getWork(workA)!).length, 0);
  assert.equal(works.repo.listNotifications(workA).filter(item => item.kind === "result").length, 0);
});

step("部分成果与缺口：成功分支保留，写入冲突阻塞验收，运行完成不关闭事项", () => {
  const binding = works.repo.listBindings(workA).find(item => item.operationId === "dispatch-a-r2")!;
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  unwrap(works.submitDeliverable(worker, { operationId: "deliver-conflict", workId: workA, bindingId: binding.bindingId,
    deliverableId: "deliverable-conflict", summary: "一半成功一半被阻止", hasWriteConflicts: true,
    evidence: [{ kind: "tool_receipt", sourceRef: "partial-receipt" }] }));
  const refused = works.acceptDeliverable(user, { operationId: "accept-conflict", workId: workA,
    deliverableId: "deliverable-conflict", versionGuard: guard(works.getWork(workA)!) });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "unmet_acceptance_criteria");
  works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
  assert.equal(works.getWork(workA)!.lifecycle, "active", "run completed 不等于事项关闭");
  assert.equal(works.cards.list(works.getWork(workA)!).length, 0);
});

step("等待实测：自动检查通过，主视图要求 Omarchy 反馈且事项仍 active", () => {
  const binding = works.repo.listBindings(workA).find(item => item.operationId === "dispatch-a-r2")!;
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  unwrap(works.submitDeliverable(worker, { operationId: "deliver-clean", workId: workA, bindingId: binding.bindingId,
    deliverableId: "deliverable-clean", summary: "自动检查全部通过", evidence: [{ kind: "tool_receipt", sourceRef: "receipt-clean" }] }));
  unwrap(works.attestCriteria(user, { operationId: "attest-auto", workId: workA,
    criterionUpdates: [{ criterionId: works.getWork(workA)!.criteria[0]!.id, status: "met", evidence: "pnpm -s typecheck" }],
    versionGuard: guard(works.getWork(workA)!) }));
  unwrap(works.acceptDeliverable(user, { operationId: "accept-clean", workId: workA, deliverableId: "deliverable-clean",
    versionGuard: guard(works.getWork(workA)!) }));
  const summary = works.getWorkSummary(LOCAL_USER_ID, workA)!;
  assert.equal(summary.lifecycle, "active");
  assert.ok(summary.nextSteps.some(text => text.includes("实测")), "主视图显示等待实测");
  assert.ok(summary.unverifiedScope.some(entry => entry.reason === "pending_real_environment"));
  assert.equal(works.getWork(workA)!.criteria[1]!.status, "pending");
});

step("手机失败与交接：反馈绑定原测试版本，旧负责人失效，worker 成果被继承", () => {
  const card = works.cards.list(works.getWork(workA)!)[0]!;
  const criterion = works.getWork(workA)!.criteria[1]!;
  // Feedback from the phone is bound to the version that was actually tested.
  const feedback = works.recordUserFeedback(user, { operationId: "phone-fail", workId: workA,
    criterionIds: [criterion.id], environment: "omarchy", sourceRef: "omarchy:d6151a8", failed: true,
    inputSnapshotId: "input:a@2", versionGuard: guard(works.getWork(workA)!) });
  assert.equal(feedback.ok, true);
  assert.equal(works.getWork(workA)!.criteria[1]!.status, "failed", "失败的实测如实记录");
  // The handler handoff moves the owner; the old owner's decision is now refused.
  const handoff = unwrap(works.handoffOwner(user, { operationId: "handoff-a", workId: workA,
    targetBotId: "next-owner", versionGuard: guard(works.getWork(workA)!) }));
  assert.equal(handoff.ownerEpoch, 2);
  const oldOwnerAttempt = works.closeWork(owner, { operationId: "old-owner-close", workId: workA,
    conclusion: "cancelled", closureSummary: "旧负责人决定", versionGuard: { ...guard(works.getWork(workA)!), expectedOwnerEpoch: 1 } });
  assert.equal(oldOwnerAttempt.ok, false, "旧负责人的决定被拒绝");
  assert.ok(oldOwnerAttempt.ok === false && ["epoch_mismatch", "unauthorized_actor"].includes(oldOwnerAttempt.code));
  assert.equal(works.getWork(workA)!.lifecycle, "active", "旧决定没有关闭事项");
  const summary = works.getWorkSummary(LOCAL_USER_ID, workA)!;
  assert.ok(summary.unverifiedScope.some(entry => entry.criterionId === criterion.id
    && entry.reason !== "auto_verified"), "失败的实测仍显示为未验证");
  assert.ok(summary.nextSteps.some(text => text.includes("实测") || text.includes("验收")));
  assert.equal(card.kind, "accepted_result");
});

step("当前版本通过并关闭：可信入口关闭 A，B 的订阅/游标/预算不受影响", () => {
  const bBefore = works.getWork(workB)!;
  const bCursorBefore = works.ingress.cursor(subB, "hook", "B");
  const criterion = works.getWork(workA)!.criteria[1]!;
  const passed = works.recordUserFeedback(user, { operationId: "phone-pass", workId: workA,
    criterionIds: [criterion.id], environment: "omarchy", sourceRef: "omarchy:d6151a8+fix", failed: false,
    inputSnapshotId: works.getWork(workA)!.inputSnapshotId, versionGuard: guard(works.getWork(workA)!) });
  assert.equal(passed.ok, true);
  const work = works.getWork(workA)!;
  assert.equal(work.criteria[1]!.status, "satisfied");
  unwrap(works.closeWork(user, { operationId: "close-a", workId: workA, conclusion: "succeeded",
    closureSummary: "Omarchy 实测通过且无回归", versionGuard: guard(work) }));
  const closed = works.getWork(workA)!;
  assert.equal(closed.lifecycle, "closed");
  assert.equal(closed.closureConclusion, "succeeded");
  assert.ok(works.repo.listSubscriptions(workA, { includeStopped: true }).every(item => item.stoppedAt !== undefined),
    "关闭后专属订阅停用");
  const bAfter = works.getWork(workB)!;
  assert.equal(bAfter.lifecycle, "active", "B 仍活跃");
  assert.equal(bAfter.ownerEpoch, bBefore.ownerEpoch);
  assert.deepEqual(works.ingress.cursor(subB, "hook", "B"), bCursorBefore, "B 的游标未被 A 的清理改动");
  assert.equal("budget" in bAfter, false);
  // A closed work keeps its history for the all-scope view.
  const all = journal.sync(LOCAL_USER_ID, { includeClosed: true });
  assert.equal(all.kind, "snapshot");
  assert.ok(all.kind === "snapshot" && all.works.some(item => item.workId === workA));
});

step("通知恢复与双端追溯：验收后未发送即崩溃，恢复只补通知不重跑工作", () => {
  // B produces and accepts a result; the host dies before any external delivery.
  const work = works.getWork(workB)!;
  unwrap(works.dispatchExecution(user, { operationId: "dispatch-b", workId: workB, botId: DEFAULT_BOT_ID,
    taskId: "task-b", durableStoreKey: "store-b", conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"], versionGuard: guard(work) }));
  bindingB = works.repo.listBindings(workB)[0]!.bindingId;
  const binding = works.repo.getBinding(bindingB)!;
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  unwrap(works.submitDeliverable(worker, { operationId: "deliver-b", workId: workB, bindingId: binding.bindingId,
    deliverableId: "deliverable-b", summary: "B 的检查完成", evidence: [{ kind: "tool_receipt", sourceRef: "receipt-b" }] }));
  unwrap(works.acceptDeliverable(user, { operationId: "accept-b", workId: workB, deliverableId: "deliverable-b" }));
  works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
  const cardsBefore = works.cards.list(works.getWork(workB)!).length;
  const bindingAttempts = works.repo.listBindings(workB).length;
  const notification = works.repo.listNotifications(workB).find(item => item.kind === "result")!;
  assert.equal(notification.delivery, "pending", "业务已提交、外部未发送");

  crashAndReopen();
  const after = works.repo.listNotifications(workB).find(item => item.notificationId === notification.notificationId)!;
  assert.equal(after.cardKey, notification.cardKey, "卡片身份跨重启不变");
  assert.equal(works.cards.list(works.getWork(workB)!).length, cardsBefore, "重启不生成第二张卡片");

  const sends = effectCount();
  const delivered = works.deliverPendingNotifications({ channel: "desktop", ...capabilityOfGuarantee("idempotent-queryable"),
    send({ idempotencyKey, notification: payload }) {
      effectDb.prepare("INSERT OR IGNORE INTO effects(effect_key,payload,at) VALUES (?,?,?)")
        .run(idempotencyKey, JSON.stringify({ title: payload.title }), clock.at);
      return { ok: true, receipt: `receipt:${idempotencyKey}` };
    },
    lookup({ idempotencyKey }) {
      return effectDb.prepare("SELECT 1 AS hit FROM effects WHERE effect_key=?").get(idempotencyKey) ? "delivered" : "missing";
    } } as WorkNotificationChannel, workB);
  assert.equal(delivered.find(item => item.notificationId === notification.notificationId)?.delivery, "sent");
  assert.equal(effectCount(), sends + 1, "恢复只补一次原投递");
  assert.equal(works.repo.listBindings(workB).length, bindingAttempts, "恢复没有重跑工作");

  // A channel that cannot report keeps an honest unknown and is not resent blindly.
  const unknownWork = works.getWork(workA)!;
  assert.equal(unknownWork.lifecycle, "closed");
  clock.at += OWNER_SUMMARY_MAX_WAIT_MS;
  works.phase5.flushOwnerSummaries();
  const summaryNotification = works.repo.listNotifications(workA).find(item => item.kind === "summary")!;
  assert(summaryNotification, "the current owner has one independent team summary intent");
  assert.equal(works.repo.listNotifications(workA).filter(item => item.kind === "closed").length, 0,
    "successful closure does not duplicate the team's accepted-outcome notification");
  works.deliverPendingNotifications({ channel: "gateway", ...capabilityOfGuarantee("best-effort-unqueryable"),
    send() { return { ok: false, retryable: false, responseLost: true, error: "no receipt" }; } }, workA);
  assert.equal(works.repo.getNotification(summaryNotification.notificationId)!.delivery, "unknown");
  const attempts = works.notifications.attempts(summaryNotification.notificationId).length;
  works.deliverPendingNotifications({ channel: "gateway", ...capabilityOfGuarantee("best-effort-unqueryable"),
    send() { return { ok: false, retryable: false, responseLost: true, error: "no receipt" }; } }, workA);
  assert.equal(works.notifications.attempts(summaryNotification.notificationId).length, attempts, "unknown 不盲目重发");

  // Both ends converge on the same persisted facts.
  const desktop: { works: WorkProjectionDto[]; cursor: WorkListCursor | null } = { works: [], cursor: null };
  const phone: typeof desktop = { works: [], cursor: null };
  const syncInto = (client: typeof desktop) => {
    const update = journal.sync(LOCAL_USER_ID, { includeClosed: true, ...(client.cursor ? { cursor: client.cursor } : {}) });
    const merged = mergeWorkList(client.works, client.cursor, update);
    assert.ok(merged, "重连不应产生缺口");
    client.works = merged!.works; client.cursor = merged!.cursor;
  };
  syncInto(desktop); syncInto(phone);
  assert.deepEqual(desktop.works.map(item => [item.workId, item.stateVersion, item.cards?.length]).sort(),
    phone.works.map(item => [item.workId, item.stateVersion, item.cards?.length]).sort());
  const aCard = desktop.works.find(item => item.workId === workA)!.cards!.find(card => card.kind === "accepted_result")!;
  assert.equal(aCard.kind, "accepted_result");
  assert.equal(desktop.works.find(item => item.workId === workB)!.lifecycle, "active");
});

console.log(`Phase 5 e2e story: ${steps.length} steps passed`);
