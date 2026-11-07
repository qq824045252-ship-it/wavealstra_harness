import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import type { BotMessageDto, BotSendReceipt } from "../src/shared/bot-conversation";

const root = mkdtempSync(join(tmpdir(), "bot-work-read-lifecycle-"));
const databasePath = join(root, "work.db");
let db = new AppDatabase(databasePath);
let messages = new BotConversationRepository(db.connection);
let bots = new BotRegistry(db.connection);
let works = new WorkService(db.connection, { bots });
const otherBot = "read-lifecycle-other-bot";
const otherUser = "read-lifecycle-other-user";
const foreignBot = "read-lifecycle-foreign-bot";
for (const [botId, userId] of [[DEFAULT_BOT_ID, LOCAL_USER_ID], [otherBot, LOCAL_USER_ID], [foreignBot, otherUser]]) {
  bots.registerBot({ botId: botId!, userId: userId!, displayName: botId! });
}
let sequence = 0;
const workIds = Array.from({ length: 2 }, () => {
  const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS }, {
    operationId: `read-lifecycle-work-${++sequence}`, title: "读取生命周期测试", authorization: DESKTOP_USER_GRANTS,
  });
  assert.ok(result.ok);
  return result.work.workId;
});
const accept = (requestId = `request-${++sequence}`, botId = DEFAULT_BOT_ID, userId = LOCAL_USER_ID) =>
  works.transaction(() => messages.accept(userId, { botId, requestId, text: "查询后修改事项" }));
const seed = (receipt: BotSendReceipt) => {
  for (const workId of workIds) db.connection.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json)
    VALUES (?,?,?,?)`).run(receipt.conversationId, receipt.requestId, workId,
    JSON.stringify({ expectedStateVersion: 1, expectedIntentRevision: 1, expectedOwnerEpoch: 1 }));
};
const count = (receipt: BotSendReceipt): number => (db.connection.prepare(`SELECT COUNT(*) AS total FROM bot_work_reads
  WHERE conversation_id=? AND request_id=?`).get(receipt.conversationId, receipt.requestId) as { total: number }).total;
const rawStatus = (receipt: BotSendReceipt, status: BotMessageDto["status"]) => db.connection.prepare("UPDATE bot_messages SET status=? WHERE message_id=?")
  .run(status, receipt.assistantMessageId);
const failures: string[] = [];
let passed = 0;
const check = (name: string, test: () => void) => {
  try { test(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
};

try {
  check("completed user messages do not end the assistant request's read scope", () => {
    const receipt = accept(); seed(receipt);
    messages.update(receipt.userMessageId, "completed", "已持久化用户输入");
    assert.equal(count(receipt), 2);
    assert.equal(messages.pruneTerminalWorkReads(LOCAL_USER_ID), 0);
    assert.equal(count(receipt), 2);
  });

  check("queued, running and unknown requests keep guards without an age cutoff", () => {
    const receipt = accept(); seed(receipt);
    for (const status of ["queued", "running", "unknown"] as const) {
      messages.update(receipt.assistantMessageId, status, "请求仍可恢复");
      db.connection.prepare("UPDATE bot_messages SET created_at=1,updated_at=1 WHERE message_id=?").run(receipt.assistantMessageId);
      assert.equal(messages.pruneTerminalWorkReads(LOCAL_USER_ID), 0);
      assert.equal(count(receipt), 2, status);
    }
  });

  for (const status of ["completed", "cancelled", "failed"] as const) {
    check(`${status} assistant transitions prune only that request and retain durable history`, () => {
      const receipt = accept(); seed(receipt);
      const adjacent = accept(); seed(adjacent);
      const collision = accept(receipt.requestId, otherBot); seed(collision);
      const foreign = accept(receipt.requestId, foreignBot, otherUser); seed(foreign);
      messages.update(receipt.assistantMessageId, status, "请求已终结");
      assert.equal(count(receipt), 0);
      assert.equal(count(adjacent), 2);
      assert.equal(count(collision), 2);
      assert.equal(count(foreign), 2);
      assert.equal(messages.message(receipt.assistantMessageId)?.status, status);
      assert.equal(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, receipt.requestId)?.assistant_message_id, receipt.assistantMessageId);
      assert.equal(messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: receipt.requestId, text: "查询后修改事项" }).replayed, true);
      assert.equal(count(receipt), 0, "send receipt replay must not recreate temporary reads");
    });
  }

  check("an outer transaction rollback restores message state, revision and read guards", () => {
    const receipt = accept(); seed(receipt);
    const before = messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, receipt.conversationId)!;
    assert.throws(() => works.transaction(() => {
      messages.update(receipt.assistantMessageId, "completed", "不应提交");
      assert.equal(count(receipt), 0);
      throw new Error("rollback terminal transition");
    }), /rollback terminal transition/);
    assert.equal(messages.message(receipt.assistantMessageId)?.status, "queued");
    assert.equal(messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, receipt.conversationId)?.revision, before.revision);
    assert.equal(count(receipt), 2);
  });

  check("a cleanup failure cannot commit a terminal transition without its cleanup", () => {
    const receipt = accept(); seed(receipt);
    const before = messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, receipt.conversationId)!;
    db.connection.exec(`CREATE TEMP TRIGGER fail_work_read_cleanup BEFORE DELETE ON bot_work_reads
      BEGIN SELECT RAISE(ABORT, 'test cleanup failure'); END;`);
    try { assert.throws(() => messages.update(receipt.assistantMessageId, "failed", "不应提交"), /test cleanup failure/); }
    finally { db.connection.exec("DROP TRIGGER fail_work_read_cleanup"); }
    assert.equal(messages.message(receipt.assistantMessageId)?.status, "queued");
    assert.equal(messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, receipt.conversationId)?.revision, before.revision);
    assert.equal(count(receipt), 2);
  });

  check("startup cleanup is user scoped, assistant scoped and idempotent", () => {
    const receipts = ["completed", "cancelled", "failed"].map(status => {
      const receipt = accept(); seed(receipt); rawStatus(receipt, status as BotMessageDto["status"]); return receipt;
    });
    const foreign = accept(undefined, foreignBot, otherUser); seed(foreign); rawStatus(foreign, "completed");
    const malformed = accept(); seed(malformed); rawStatus(malformed, "completed");
    db.connection.prepare("UPDATE bot_send_receipts SET assistant_message_id=user_message_id WHERE request_id=?").run(malformed.requestId);
    assert.equal(messages.pruneTerminalWorkReads(LOCAL_USER_ID), 6);
    for (const receipt of receipts) assert.equal(count(receipt), 0);
    assert.equal(count(foreign), 2);
    assert.equal(count(malformed), 2, "an inconsistent receipt is not evidence of a terminal assistant request");
    assert.equal(messages.pruneTerminalWorkReads(LOCAL_USER_ID), 0);
  });

  check("reopening storage preserves unknown requests and cleans recovered terminal reads", () => {
    const unknown = accept(); seed(unknown); messages.update(unknown.assistantMessageId, "unknown", "等待恢复");
    const terminal = accept(); seed(terminal); rawStatus(terminal, "completed");
    db.close();
    db = new AppDatabase(databasePath);
    messages = new BotConversationRepository(db.connection);
    bots = new BotRegistry(db.connection);
    works = new WorkService(db.connection, { bots });
    assert.equal(messages.pruneTerminalWorkReads(LOCAL_USER_ID), 2);
    assert.equal(count(terminal), 0);
    assert.equal(count(unknown), 2);
    messages.update(unknown.assistantMessageId, "running", "恢复成功，仍在处理");
    assert.equal(count(unknown), 2);
    messages.update(unknown.assistantMessageId, "completed", "已恢复并完成");
    assert.equal(count(unknown), 0);
  });

  check("service recovery cleans terminal guards only on the authoritative host", () => {
    const userId = "terminal-recovery-user";
    const botId = "terminal-recovery-bot";
    bots.registerBot({ botId, userId, displayName: "终态恢复" });
    const receipt = accept(undefined, botId, userId); seed(receipt); rawStatus(receipt, "failed");
    let authority = false;
    const service = new BotConversationService({ db: db.connection, userId, bots, works, directory: root,
      models: new Proxy({} as ModelRuntime, { get: () => { throw new Error("terminal recovery must not open a model runtime"); } }),
      defaultModel: () => undefined, isAuthority: () => authority, memorySearch: () => [], schedule: () => {}, wake: () => {} });
    service.recover();
    assert.equal(count(receipt), 2);
    authority = true;
    service.recover();
    assert.equal(count(receipt), 0);
  });
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
