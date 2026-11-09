import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "work-conversation-feedback-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let authority = true;
const open = () => {
  const bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
  const messages = new BotConversationRepository(db.connection);
  const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => authority });
  return { bots, works, messages, feedback };
};
try {
  let { bots, works, messages, feedback } = open();
  const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "source", text: "完成后台任务" });
  messages.update(source.assistantMessageId, "completed", "已开始处理");
  const create = (operationId: string, linked = true) => {
    const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS }, {
      operationId, title: operationId, ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: `input:${operationId}`,
      authorization: DESKTOP_USER_GRANTS, criteria: [{ id: `${operationId}-criterion`, text: "核验完成" }],
      ...(linked ? { conversationId: source.conversationId, sourceMessageId: source.userMessageId } : {}),
    });
    assert(result.ok); return result.work;
  };
  const work = create("feedback-work");
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, "source")!, work.workId);
  works.repo.insertBinding({ bindingId: "binding-1", workId: work.workId, operationId: "binding-operation", botId: DEFAULT_BOT_ID,
    taskId: "background-task", durableStoreKey: "store", conversationId: "background-native-conversation", intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
    delegatedScope: [], workspaceBinding: root, status: "completed", admittedAt: 1, settledAt: 2, settlementNote: "产出成果" });
  works.repo.insertDeliverable({ deliverableId: "result:binding-1", workId: work.workId, executionId: "binding-1", producerBotId: DEFAULT_BOT_ID,
    intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, status: "proposed",
    summary: "产出成果", artifactRefs: ["artifact:report"], evidenceRefs: [], uncoveredScope: ["发行包验证"], uncoveredCriterionIds: [],
    isSpeculation: false, hasWriteConflicts: false, createdAt: 3 });
  works.repo.insertBlocker({ blockerId: "blocker-1", workId: work.workId, reason: "需要确认范围", kind: "operational",
    status: "open", waitingForUserInput: true, createdAt: 4 });
  const before = works.getWork(work.workId)!;
  authority = false; assert.equal(feedback.drain(), 0); authority = true;
  assert.equal(feedback.drain(), 3);
  assert.equal(feedback.drain(), 0);
  assert.deepEqual(works.getWork(work.workId), before, "feedback cannot accept, close or otherwise mutate Work");
  const history = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId });
  assert.equal(history().messages.length, 5);
  assert(history().messages.some(m => m.text.includes("不代表用户已验收")));
  assert(history().messages.some(m => m.text.includes("需要你补充信息")));
  assert(history().messages.slice(2).every(m => m.role === "assistant" && m.status === "completed" && m.workIds[0] === work.workId));
  assert.equal(messages.next(source.conversationId), undefined, "feedback must not queue a model turn");
  assert.equal(history().messages.filter(m => m.text.includes("产出成果")).length, 1, "one native observation is not repeated as binding + deliverable bodies");
  const initialFeedback = history().messages.slice(2);
  assert.deepEqual(initialFeedback.map(m => m.workFeedback?.category), ["progress", "result", "decision"]);
  assert.equal(initialFeedback[0].workFeedback?.executionId, "binding-1");
  assert.equal(initialFeedback[1].workFeedback?.executionId, "binding-1");
  // Upgrade an already-delivered legacy history in place: only additive metadata,
  // no reset, no body mutation, no repeated send, and no lifecycle/criteria change.
  db.connection.exec("DELETE FROM bot_work_feedback");
  const legacyBodies = history().messages.map(m => [m.messageId, m.text]);
  assert.equal(feedback.drain(), 0);
  assert.deepEqual(history().messages.map(m => [m.messageId, m.text]), legacyBodies);
  assert(history().messages.slice(2).every(m => m.workFeedback));
  assert.deepEqual(works.getWork(work.workId), before);

  const revision = history().revision;
  assert.throws(() => db.connection.transaction(() => { messages.appendWorkFeedback(messages.workOrigin(LOCAL_USER_ID, work.workId)!, work.workId, "crash", "1", "rollback"); throw Error("crash"); })());
  assert.equal(history().revision, revision, "failed delivery rolls back message and revision together");

  messages.archive(LOCAL_USER_ID, DEFAULT_BOT_ID, source.conversationId);
  const unrelated = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "unrelated", text: "新对话" });
  messages.update(unrelated.assistantMessageId, "completed", "新对话回复");
  bots.registerBot({ botId: "new-owner", userId: LOCAL_USER_ID, displayName: "New owner", authorization: DESKTOP_USER_GRANTS });
  const other = messages.accept(LOCAL_USER_ID, { botId: "new-owner", requestId: "other", text: "接管" });
  messages.update(other.assistantMessageId, "completed", "收到");
  messages.linkWork(messages.receipt(LOCAL_USER_ID, "new-owner", "other")!, work.workId);
  works.repo.updateWork({ ...before, ownerBotId: "new-owner", ownerEpoch: 2, sourceMessageId: other.userMessageId, stateVersion: before.stateVersion + 1 });
  works.repo.clearBlocker("blocker-1", work.workId, 5);
  assert.equal(feedback.drain(work.workId), 1, "clear goes to original archived chat after handoff");
  works.repo.clearBlocker("blocker-1", work.workId, 6);
  assert.equal(works.repo.getBlocker("blocker-1")?.clearedAt, 5, "repeat settlement retains the original clearance receipt");
  assert.equal(feedback.drain(work.workId), 0, "approval then consumption cannot send duplicate blocker-cleared feedback");
  db.connection.exec("DELETE FROM bot_work_feedback"); // Also upgrade older event versions after a status change.
  works.repo.reopenBlocker("blocker-1", work.workId);
  assert.equal(feedback.drain(work.workId), 1, "reopened blocker gets a new version");
  assert(history().messages.filter(m => m.requestId.startsWith("work-feedback:")).every(m => m.workFeedback));
  const blockerVersions = history().messages.filter(m => m.workFeedback?.eventId === "blocker:blocker-1");
  assert.equal(blockerVersions.at(-1)?.workFeedback?.category, "decision");
  assert(blockerVersions.slice(0, -1).every(m => m.workFeedback?.category === "progress"));
  assert.equal(feedback.drain(work.workId), 0);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.length, 2);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: "new-owner" }).messages.length, 2);
  assert.equal(history().archived, true);

  const orphan = create("unlinked-work", false);
  works.repo.insertBlocker({ blockerId: "orphan-blocker", workId: orphan.workId, reason: "No origin", kind: "operational", status: "open", waitingForUserInput: true, createdAt: 6 });
  assert.equal(feedback.drain(orphan.workId), 0, "unlinked Work never falls back to active chat");
  works.repo.updateWork({ ...works.getWork(work.workId)!, lifecycle: "closed", closedAt: 8, closureConclusion: "cancelled", closureSummary: "已取消" });
  const finalCount = history().messages.length;
  db.connection.exec("DROP TABLE bot_work_feedback"); // Existing v35 database upgrade, not a schema reset.
  db.close(); db = new AppDatabase(path);
  ({ bots, works, messages, feedback } = open());
  assert.equal(feedback.recover(), 1, "recovery discovers closure after restart");
  assert.equal(feedback.recover(), 0, "persisted result/blocker deliveries dedupe across restart");
  assert.equal(history().messages.length, finalCount + 1);
  assert(history().messages.at(-1)!.text.includes("cancelled"));
  assert.equal(messages.next(source.conversationId), undefined);
  works.repo.insertBlocker({ blockerId: "retry-blocker", workId: work.workId, reason: "等待重试", kind: "operational",
    status: "open", waitingForUserInput: true, createdAt: 9 });
  const countBeforeRetry = history().messages.length;
  db.connection.exec(`CREATE TEMP TRIGGER fail_feedback BEFORE INSERT ON bot_messages
    WHEN NEW.request_id LIKE 'work-feedback:%' BEGIN SELECT RAISE(ABORT, 'injected feedback failure'); END`);
  feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => authority, pollIntervalMs: 10 });
  try {
    assert.doesNotThrow(() => feedback.start(), "startup delivery failure must not escape");
    assert.equal(history().messages.length, countBeforeRetry, "failed append is not acknowledged");
    db.connection.exec("DROP TRIGGER fail_feedback");
    const until = Date.now() + 2000;
    while (history().messages.length === countBeforeRetry && Date.now() < until) await delay(10);
    assert.equal(history().messages.length, countBeforeRetry + 1, "timer retries without a new Work event");
    feedback.start(); // Idempotent start must not create duplicate loops/deliveries.
    await delay(30);
    assert.equal(history().messages.length, countBeforeRetry + 1);
    feedback.close();
    works.repo.clearBlocker("retry-blocker", work.workId, 10);
    await delay(30);
    assert.equal(history().messages.length, countBeforeRetry + 1, "close cancels background polling");
    assert.equal(feedback.drain(), 1, "synchronous drain remains available");
  } finally { feedback.close(); }
  const independent = create("independent-results");
  for (const id of ["member-a", "member-b"]) {
    works.repo.insertBinding({ bindingId: id, workId: independent.workId, operationId: `operation:${id}`, botId: DEFAULT_BOT_ID,
      taskId: `task:${id}`, durableStoreKey: "store", conversationId: `native:${id}`, intentRevision: independent.intentRevision,
      ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
      delegatedScope: [], workspaceBinding: root, status: "completed", admittedAt: 1, settledAt: 2, settlementNote: "独立同文成果" });
    works.repo.insertDeliverable({ deliverableId: `result:${id}`, workId: independent.workId, executionId: id, producerBotId: DEFAULT_BOT_ID,
      intentRevision: independent.intentRevision, ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, status: "proposed",
      summary: "独立同文成果", artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [],
      isSpeculation: false, hasWriteConflicts: false, createdAt: 3 });
  }
  assert.equal(feedback.drain(independent.workId), 4);
  const memberReports = history().messages.filter(m => m.workFeedback?.workId === independent.workId);
  assert.equal(memberReports.filter(m => m.text.includes("独立同文成果")).length, 2, "identical outputs from different bindings both remain visible");
  assert.equal(new Set(memberReports.filter(m => m.workFeedback?.kind === "result").map(m => m.workFeedback?.executionId)).size, 2);
  assert.equal(feedback.drain(independent.workId), 0);
  for (const status of ["unknown", "stopped", "completed"] as const) {
    const id = `partial-${status}`;
    works.repo.insertBinding({ bindingId: id, workId: independent.workId, operationId: `operation:${id}`, botId: DEFAULT_BOT_ID,
      taskId: `task:${id}`, durableStoreKey: "store", conversationId: `native:${id}`, intentRevision: independent.intentRevision,
      ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
      delegatedScope: [], workspaceBinding: root, status, admittedAt: 1, settledAt: 2, settlementNote: `独立诊断:${status}` });
    works.repo.insertDeliverable({ deliverableId: `partial:${id}`, workId: independent.workId, executionId: id, producerBotId: DEFAULT_BOT_ID,
      intentRevision: independent.intentRevision, ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, status: "proposed",
      summary: "仅部分步骤成功", artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [],
      isSpeculation: false, hasWriteConflicts: false, createdAt: 3 });
  }
  assert.equal(feedback.drain(independent.workId), 6);
  for (const status of ["unknown", "stopped", "completed"]) {
    const diagnostic = history().messages.find(m => m.workFeedback?.eventId === `binding:partial-${status}`);
    assert(diagnostic);
    assert(diagnostic.text.includes(`独立诊断:${status}`), "a partial deliverable must not erase its parent binding diagnostic");
    assert.equal(diagnostic.workFeedback?.category, "progress", "terminal execution failures are not requests for a user decision");
  }

  const recovery = create("automatic-recovery-feedback");
  for (const [blockerId, waitingForUserInput] of [["continuation:old-failure", true], ["recovery-ended:no-progress", false]] as const) {
    works.repo.insertBlocker({ blockerId, workId: recovery.workId, reason: "自动恢复仍有执行缺口", kind: "operational",
      status: "open", waitingForUserInput, createdAt: 11 });
  }
  assert.equal(feedback.drain(recovery.workId), 2);
  const recoveryMessages = history().messages.filter(message => message.workFeedback?.workId === recovery.workId);
  assert(recoveryMessages.every(message => message.workFeedback?.category === "progress"));
  assert(recoveryMessages.every(message => !message.text.includes("需要你补充信息")));
  for (const blockerId of ["continuation:old-failure", "recovery-ended:no-progress"]) works.repo.clearBlocker(blockerId, recovery.workId, 12);
  assert.equal(feedback.drain(recovery.workId), 0, "clearing internal recovery blockers does not spam the conversation");
  assert.equal(works.repo.listBlockers(recovery.workId).filter(blocker => blocker.status === "cleared").length, 2,
    "feedback suppression never discards durable blocker history");

  const origin = messages.workOrigin(LOCAL_USER_ID, independent.workId)!;
  const spoofKey = createHash("sha256").update(JSON.stringify([independent.workId, "blocker:spoof"])).digest("hex");
  const spoofVersion = createHash("sha256").update("1").digest("hex");
  const spoofRequest = `work-feedback:${spoofKey}:0000000000000000:${spoofVersion}`;
  // A normal user-chosen request ID can resemble feedback but its message ID
  // was allocated by accept(), not the host's feedback delivery namespace.
  db.connection.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
    VALUES ('bot-message-spoof',?,?,?,'assistant','ordinary reply','completed',1,1)`)
    .run(origin.conversation_id, origin.bot_id, spoofRequest);
  assert.equal(messages.appendWorkFeedback(origin, independent.workId, "blocker:spoof", "1", "real alert", {
    workId: independent.workId, eventId: "blocker:spoof", kind: "blocker", category: "decision",
  }), true, "a user-controlled request ID cannot suppress host feedback");
  assert.equal(messages.message("bot-message-spoof")?.workFeedback, undefined, "ordinary model reply cannot be relabeled by a forged event key");
  console.log("PASS durable Work feedback: origin, archive, handoff, result/blocker versions, restart, rollback, authority, no model turns, retry lifecycle");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
