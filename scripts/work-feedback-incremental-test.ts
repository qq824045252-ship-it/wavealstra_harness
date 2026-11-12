import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

if (process.argv[2] === "--crash-worker") {
  const workerDb = new AppDatabase(z.string().parse(process.argv[3]));
  workerDb.connection.prepare("UPDATE works SET closed_at=11 WHERE work_id=?").run(z.string().parse(process.argv[4]));
  process.stdout.write("committed-before-feedback\n", () => process.kill(process.pid, "SIGKILL"));
  await new Promise(() => {});
}

for (const size of process.argv.includes("--recovery-only") ? [] : [100, 1_000, 10_000]) {
  const root = mkdtempSync(join(tmpdir(), "work-feedback-incremental-"));
  const db = new AppDatabase(join(root, "business.db"));
  try {
    const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
    const works = new WorkService(db.connection, { bots });
    const messages = new BotConversationRepository(db.connection);
    const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "source", text: "核验成果" });
    messages.update(source.assistantMessageId, "completed", "已受理");
    const created = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
      { operationId: "template", title: "已关闭事项", conversationId: source.conversationId, sourceMessageId: source.userMessageId });
    assert(created.ok);
    works.repo.updateWork({ ...created.work, lifecycle: "closed", closureConclusion: "succeeded", closedAt: 10 });
    const template = works.getWork(created.work.workId)!;
    db.connection.transaction(() => {
      for (let i = 1; i < size; i++) works.repo.insertWork({ ...template, workId: `history-${String(i).padStart(6, "0")}` });
    })();
    const images: string[] = [];
    const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works,
      isAuthority: () => true, prepareImages: async id => { images.push(id); return "complete"; } });
    // Reconcile the entire historical fixture in bounded pages before measuring idle.
    const firstBatch = mock.method(works.repo, "getWork");
    feedback.drain();
    assert.equal(firstBatch.mock.callCount(), 64, "startup reconciliation processes at most one bounded batch");
    firstBatch.mock.restore();
    works.repo.insertWork({ ...template, workId: "000-inserted-before-recovery-cursor" });
    for (let i = 0; i < Math.ceil(size / 64) + 2; i++) { feedback.drain(); await Promise.resolve(); await Promise.resolve(); }
    const hydrate = mock.method(works.repo, "getWork");
    const statements = mock.method(db.connection, "prepare");
    const messageCount = () => z.object({ count: z.number() }).parse(db.connection.prepare(
      "SELECT COUNT(*) count FROM bot_messages WHERE conversation_id=?").get(source.conversationId)).count;
    const countBefore = messageCount();
    const imageCount = images.length;
    feedback.drain(); await Promise.resolve(); await Promise.resolve();
    assert.equal(hydrate.mock.callCount(), 0, `${size} unchanged closed Works: idle has zero full hydration`);
    assert.equal(images.length, imageCount, "unchanged history never schedules image preparation");
    assert(!statements.mock.calls.some(call => /SELECT \* FROM works/i.test(String(call.arguments[0]))), "idle has no full Work SELECT");
    hydrate.mock.restore(); statements.mock.restore();

    // A side-table-only change must be discovered even though works.updated_at is untouched.
    works.repo.insertBlocker({ blockerId: `blocker-${size}`, workId: template.workId, reason: "补充原始资料",
      kind: "operational", status: "open", waitingForUserInput: true, createdAt: 20 });
    const changedHydrate = mock.method(works.repo, "getWork");
    assert.equal(feedback.drain(), 1);
    assert.equal(changedHydrate.mock.callCount(), 1, "only the changed Work is hydrated, once");
    changedHydrate.mock.restore();
    const historyAfter = messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId });
    assert.equal(messageCount(), countBefore + 1);
    assert.match(historyAfter.messages.at(-1)!.text, /补充原始资料/);
    assert.equal(feedback.drain(), 0, "the side-table change is delivered exactly once");
    assert.equal(z.object({ count: z.number() }).parse(db.connection.prepare(
      "SELECT COUNT(*) count FROM bot_work_feedback WHERE json_extract(metadata_json,'$.workId')=? AND json_extract(metadata_json,'$.kind')='closure'")
      .get("000-inserted-before-recovery-cursor")).count, 1, "insert before a live pagination cursor cannot be lost");
    feedback.close();
    console.log(`PASS #34 ${size} closed Works: zero idle hydration/image scheduling; one side-table change hydrates one Work once`);
  } finally {
    mock.restoreAll(); db.close(); rmSync(root, { recursive: true, force: true });
  }
}

const root = mkdtempSync(join(tmpdir(), "work-feedback-recovery-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let imagesFail = true;
let imagesGate: Promise<void> | undefined;
let images = 0;
const open = () => {
  const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots });
  const messages = new BotConversationRepository(db.connection);
  const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works,
    pollIntervalMs: 10, isAuthority: () => true, prepareImages: async () => {
      images++; if (imagesFail) throw Error("fixture image preparation failed"); await imagesGate; return "complete";
    } });
  return { bots, works, messages, feedback };
};
let { bots, works, messages, feedback } = open();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
try {
  const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "source", text: "原会话成果" });
  messages.update(source.assistantMessageId, "completed", "已受理");
  const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
    { operationId: "recovery", title: "恢复回流", conversationId: source.conversationId, sourceMessageId: source.userMessageId });
  assert(result.ok); const work = result.work;
  works.repo.insertBinding({ bindingId: "binding", workId: work.workId, operationId: "binding-operation", botId: DEFAULT_BOT_ID,
    taskId: "native-task", durableStoreKey: "store", conversationId: "native-conversation", intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
    delegatedScope: [], workspaceBinding: root, status: "completed", admittedAt: 1, settledAt: 2, settlementNote: "真实成果" });
  assert(works.submitDeliverable({ kind: "worker", botId: DEFAULT_BOT_ID, bindingId: "binding" }, {
    operationId: "result", deliverableId: "result:binding", workId: work.workId, bindingId: "binding", summary: "真实成果",
    artifactRefs: [], uncoveredScope: [], uncoveredCriterionIds: [], isSpeculation: false, hasWriteConflicts: false }).ok);
  assert.equal(feedback.drain(work.workId), 2);
  await flush();
  assert.equal(images, 1);
  imagesFail = false;
  const retryHydration = mock.method(works.repo, "getWork");
  await delay(15); feedback.drain(); await flush();
  assert.equal(images, 2); assert.equal(retryHydration.mock.callCount(), 0, "image retry does not rehydrate or reproject Work");
  retryHydration.mock.restore();

  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let releaseImage = () => {};
  imagesGate = new Promise<void>(resolve => { releaseImage = resolve; });
  db.connection.prepare("UPDATE work_deliverables SET summary='同毫秒版本一' WHERE deliverable_id='result:binding'").run();
  assert.equal(feedback.drain(), 1); await flush();
  db.connection.prepare("UPDATE work_deliverables SET summary='同毫秒版本二' WHERE deliverable_id='result:binding'").run();
  assert.equal(feedback.drain(), 1);
  releaseImage(); imagesGate = undefined; await flush();
  mock.timers.tick(11); feedback.drain(); await flush();
  const delivered = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId }).messages;
  assert.equal(delivered().at(-1)?.workFeedback?.report?.summary, "同毫秒版本二");
  assert.equal(images, 4, "old image acknowledgement cannot erase the newer candidate generation");
  mock.timers.reset();
  assert.throws(() => works.transaction(() => {
    works.repo.insertBlocker({ blockerId: "rolled-back", workId: work.workId, reason: "不可投递", kind: "operational",
      status: "open", waitingForUserInput: true, createdAt: 1 }); throw Error("rollback");
  }), /rollback/);
  assert.equal(feedback.drain(), 0);
  assert(!delivered().some(message => message.text.includes("不可投递")));

  messages.archive(LOCAL_USER_ID, DEFAULT_BOT_ID, source.conversationId);
  db.connection.prepare("UPDATE works SET lifecycle='closed',closure_conclusion='succeeded',closed_at=10 WHERE work_id=?").run(work.workId);
  works.repo.insertBlocker({ blockerId: "restart-blocker", workId: work.workId, reason: "重启补投", kind: "operational",
    status: "open", waitingForUserInput: true, createdAt: 1 });
  db.connection.exec("CREATE TRIGGER fail_feedback BEFORE INSERT ON bot_messages WHEN NEW.message_id LIKE 'work-feedback-%' BEGIN SELECT RAISE(ABORT,'fixture projection failed'); END");
  assert.equal(feedback.drain(), 0);
  db.connection.exec("DROP TRIGGER fail_feedback");
  feedback.close(); db.close();
  const killed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-worker", path, work.workId], { encoding: "utf8" });
  assert.ifError(killed.error);
  assert.match(killed.stdout, /committed-before-feedback/);
  assert.notEqual(killed.status, 0, "fixture process is killed before feedback delivery or graceful database close");
  db = new AppDatabase(path);
  ({ bots, works, messages, feedback } = open());
  await delay(15);
  assert.equal(feedback.recover(), 2, "closed Work pending feedback survives a database reopen");
  assert.equal(feedback.drain(), 0);
  assert.equal(delivered().filter(message => message.text.includes("重启补投")).length, 1);
  assert.equal(delivered().filter(message => message.workFeedback?.kind === "closure").length, 1);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId }).archived, true);
  console.log("PASS #34 image failure/retry, same-millisecond generations, in-flight acknowledgement fencing, transaction rollback, closed/archived restart recovery");
} finally {
  mock.timers.reset(); feedback.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
