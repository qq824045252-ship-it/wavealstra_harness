import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BotCollaborationRepository, type BotCollaborationInitiation } from "../src/main/agent/work/BotCollaborationRepository";

const directory = mkdtempSync(join(tmpdir(), "bot-collaboration-store-"));
const file = join(directory, "app.db");
let db = new Database(file);
try {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE bots(bot_id TEXT PRIMARY KEY,user_id TEXT NOT NULL);
    CREATE TABLE bot_conversations(conversation_id TEXT PRIMARY KEY,user_id TEXT,bot_id TEXT,team_id TEXT,archived_at INTEGER,revision INTEGER DEFAULT 0);
    CREATE TABLE bot_messages(message_id TEXT PRIMARY KEY,conversation_id TEXT,bot_id TEXT,request_id TEXT,role TEXT);
    CREATE TABLE bot_message_revisions(message_id TEXT PRIMARY KEY,revision INTEGER DEFAULT 0);
    CREATE TABLE bot_send_receipts(user_id TEXT,bot_id TEXT,conversation_id TEXT,request_id TEXT,user_message_id TEXT,assistant_message_id TEXT);
    CREATE TABLE works(work_id TEXT PRIMARY KEY,user_id TEXT,owner_bot_id TEXT,title TEXT DEFAULT 'Actual target work',lifecycle TEXT DEFAULT 'active',closure_conclusion TEXT,progress_summary TEXT,
      intent_revision INTEGER DEFAULT 1,input_snapshot_id TEXT DEFAULT 'input-v1',owner_epoch INTEGER DEFAULT 1,closed_at INTEGER,updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO bots VALUES ('source','u'),('target','u'),('other','u'),('foreign','v');
    INSERT INTO works(work_id,user_id,owner_bot_id) VALUES ('work-target','u','target'),('work-source','u','source'),('work-foreign','v','foreign');
  `);
  const source = (requestId: string, conversationId = "source-conversation", botId = "source", userId = "u", teamId: string | null = null) => {
    db.prepare("INSERT OR IGNORE INTO bot_conversations(conversation_id,user_id,bot_id,team_id) VALUES (?,?,?,?)").run(conversationId, userId, botId, teamId);
    db.prepare("INSERT INTO bot_messages VALUES (?,?,?,?,?)").run(`user-${requestId}`, conversationId, botId, requestId, "user");
    db.prepare("INSERT INTO bot_messages VALUES (?,?,?,?,?)").run(`assistant-${requestId}`, conversationId, botId, requestId, "assistant");
    db.prepare("INSERT INTO bot_message_revisions(message_id) VALUES (?), (?)").run(`user-${requestId}`, `assistant-${requestId}`);
    db.prepare("INSERT INTO bot_send_receipts VALUES (?,?,?,?,?,?)").run(userId, botId, conversationId, requestId, `user-${requestId}`, `assistant-${requestId}`);
    return { userId, sourceBotId: botId, sourceDisplayName: botId, sourceConversationId: conversationId,
      sourceRequestId: requestId, sourceUserMessageId: `user-${requestId}`, sourceAssistantMessageId: `assistant-${requestId}`,
      targetBotId: "target", targetDisplayName: "Target", operationId: `operation-${requestId}`, now: 1000 } satisfies BotCollaborationInitiation;
  };
  const initial = source("first");
  const repo = new BotCollaborationRepository(db);
  const relation = repo.ensure(initial);
  assert.equal(relation.messageCount, 0);
  assert.deepEqual(relation.times, { sentAt: 1000, deliveredAt: null, acceptedAt: null, startedAt: null, endedAt: null, returningAt: null, returnedAt: null });
  assert.equal(repo.ensure({ ...initial, now: 5000, targetDisplayName: "Renamed" }).collaborationId, relation.collaborationId);
  assert.throws(() => repo.ensure({ ...initial, targetBotId: "other" }), /idempotency_conflict/);
  assert.throws(() => repo.ensure({ ...source("foreign-target"), targetBotId: "foreign" }), /当前用户/);
  assert.throws(() => repo.ensure(source("team", "team-conversation", "source", "u", "team")), /私人会话/);
  assert.throws(() => repo.ensure({ ...source("tampered"), sourceUserMessageId: "user-first" }), /原始回执/);
  assert.throws(() => repo.ensure({ ...initial, operationId: "self", targetBotId: "source" }), /自己/);

  const second = repo.ensure({ ...initial, operationId: "separate-goal", now: 2000 });
  assert.notEqual(second.collaborationId, relation.collaborationId, "new independent goal has a distinct relation even for same Bot pair");
  assert.deepEqual(repo.list("u", { botId: "source" }).items.map(item => item.collaborationId), [second.collaborationId, relation.collaborationId]);
  assert.equal(repo.list("u", { botId: "target" }).total, 2, "recipient sees the same real relations");
  assert.equal(repo.get("v", relation.collaborationId), undefined);
  assert.throws(() => repo.scoped("u", "other", relation.collaborationId), /当前用户与 Bot/);
  assert.throws(() => repo.scoped("u", "source", relation.collaborationId, "wrong-conversation"), /来源会话/);
  assert.throws(() => repo.list("v", { botId: "source" }), /当前用户/);
  repo.appendMessage("u", second.collaborationId, { operationId: "unicode-request", senderBotId: "source", senderDisplayName: "Source",
    kind: "request", text: "🙂".repeat(600) });
  assert.equal(repo.get("u", second.collaborationId)?.requestPreview, "🙂".repeat(500), "bounded previews retain complete Unicode characters");

  const request = repo.appendMessage("u", relation.collaborationId, { operationId: "ask", senderBotId: "source", senderDisplayName: "Source", kind: "request", text: "Actual question", createdAt: 1100 });
  assert.equal(repo.appendMessage("u", relation.collaborationId, { operationId: "ask", senderBotId: "source", senderDisplayName: "Source", kind: "request", text: "Actual question", createdAt: 9900 }).messageId, request.messageId);
  assert.throws(() => repo.appendMessage("u", relation.collaborationId, { operationId: "ask", senderBotId: "source", senderDisplayName: "Source", kind: "request", text: "Changed question" }), /idempotency_conflict/);
  assert.throws(() => repo.appendMessage("u", relation.collaborationId, { operationId: "blank", senderBotId: "source", senderDisplayName: "Source", kind: "request", text: "  " }), /空文本/);
  assert.throws(() => repo.appendMessage("u", relation.collaborationId, { operationId: "foreign-sender", senderBotId: "other", senderDisplayName: "Other", kind: "reply", text: "forged" }), /发送者/);
  for (let i = 0; i < 50; i++) repo.setPreview("u", relation.collaborationId, { exchangeId: "exchange-ask", senderBotId: "target", senderDisplayName: "Target", text: `chunk ${i}`, updatedAt: 1200 + i });
  assert.equal(repo.get("u", relation.collaborationId)?.messageCount, 1, "stream chunks never inflate message count");
  const delivered = repo.event("u", relation.collaborationId, { operationId: "ask", kind: "delivered", createdAt: 1250 });
  assert.equal(repo.event("u", relation.collaborationId, { operationId: "ask", kind: "delivered", createdAt: 7000 }).eventId, delivered.eventId, "re-observation retains first real event timestamp");
  const reply = repo.appendMessage("u", relation.collaborationId, { operationId: "ask", senderBotId: "target", senderDisplayName: "Target", kind: "reply", text: "Original target reply", createdAt: 1300 });
  repo.clearPreview("u", relation.collaborationId, "exchange-ask");
  repo.event("u", relation.collaborationId, { operationId: "ask", kind: "returned", createdAt: 1350 });
  assert.equal(repo.get("u", relation.collaborationId)?.messageCount, 2);
  const received = repo.list("u", { botId: "target", direction: "incoming" });
  assert.equal(received.total, 2);
  assert.equal(received.items.find(item => item.collaborationId === relation.collaborationId)?.requestPreview, "Actual question");
  assert.equal(received.items.find(item => item.collaborationId === relation.collaborationId)?.replyPreview, "Original target reply");
  assert.equal(repo.list("u", { botId: "target", direction: "outgoing" }).total, 0);
  assert.equal(repo.list("u", { botId: "source", direction: "incoming" }).total, 0, "source never receives its own outgoing request in its inbox");
  const incomingPage = repo.list("u", { botId: "target", direction: "incoming", limit: 1 });
  assert(incomingPage.nextCursor);
  assert.throws(() => repo.list("u", { botId: "target", direction: "outgoing", cursor: incomingPage.nextCursor ?? undefined }), /筛选不匹配/);
  assert.equal(repo.get("u", relation.collaborationId)?.times.startedAt, null, "unknown start time is not inferred");
  assert.throws(() => repo.event("u", relation.collaborationId, { operationId: "bad-work", kind: "accepted", workId: "work-source" }), /Work 不属于/);

  assert.throws(() => repo.linkWork("u", relation.collaborationId, "work-source"), /目标 Bot/);
  assert.throws(() => repo.linkWork("u", relation.collaborationId, "work-foreign"), /目标 Bot/);
  repo.linkWork("u", relation.collaborationId, "work-target");
  assert.equal(repo.get("u", relation.collaborationId)?.times.returnedAt, null, "consultation times do not masquerade as Work times");
  assert.equal(repo.get("u", relation.collaborationId)?.times.deliveredAt, null);
  assert.equal(repo.linkWork("u", relation.collaborationId, "work-target").workId, "work-target");
  assert.throws(() => repo.linkWork("u", second.collaborationId, "work-target"), /另一协作/);
  assert.equal(repo.byWork("u", "work-target")?.collaborationId, relation.collaborationId);
  assert.equal(repo.byWork("v", "work-target"), undefined);
  assert.throws(() => repo.appendMessage("u", relation.collaborationId, { operationId: "foreign-feedback", senderBotId: "target",
    senderDisplayName: "Target", kind: "result", text: "forged unrelated result",
    workFeedback: { workId: "work-source", eventId: "foreign-result", kind: "result", category: "result" } }), /Work 不属于/);
  repo.event("u", relation.collaborationId, { operationId: "delegate", kind: "accepted", workId: "work-target", createdAt: 1400 });
  repo.event("u", relation.collaborationId, { operationId: "delegate", kind: "delivered", workId: "work-target", createdAt: 1420 });
  const follow = source("follow");
  repo.linkRequest("u", relation.collaborationId, { conversationId: follow.sourceConversationId, requestId: follow.sourceRequestId,
    userMessageId: follow.sourceUserMessageId, assistantMessageId: follow.sourceAssistantMessageId });
  assert.equal(repo.summariesForMessage("u", "assistant-follow")[0]?.workId, "work-target");
  assert.equal(repo.summariesForMessage("v", "assistant-follow").length, 0);
  assert.throws(() => repo.linkRequest("u", relation.collaborationId, { conversationId: "different", requestId: "follow", userMessageId: "user-follow", assistantMessageId: "assistant-follow" }), /来源|回执|身份|请求/);

  const listFirst = repo.list("u", { botId: "source", limit: 1 });
  assert(listFirst.nextCursor);
  repo.event("u", relation.collaborationId, { operationId: "new-activity", kind: "started", createdAt: 9000 });
  assert.equal(repo.list("u", { botId: "source", limit: 1, cursor: listFirst.nextCursor }).items[0]?.collaborationId, relation.collaborationId, "activity does not destabilize relation pagination");
  assert.throws(() => repo.list("u", { botId: "target", cursor: listFirst.nextCursor ?? undefined }), /筛选不匹配/);

  const seenMessages: string[] = [], seenEvents: string[] = [];
  let cursor: string | undefined;
  do {
    const page = repo.history("u", { botId: "target", collaborationId: relation.collaborationId, cursor, limit: 2 });
    assert.equal(page.totalMessages, 2);
    assert.equal(page.previews.length, 0);
    assert(page.messages.every((item, index, values) => index === 0 || values[index - 1].ordinal < item.ordinal));
    seenMessages.push(...page.messages.map(item => item.messageId));
    seenEvents.push(...page.events.map(item => item.eventId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(new Set(seenMessages), new Set([request.messageId, reply.messageId]));
  assert.equal(seenMessages.length, 2);
  assert.equal(seenEvents.length, 5, "all receipt events are paged, no unbounded event side channel");
  assert.equal(repo.get("u", relation.collaborationId)?.work?.startedAt, null, "a later consultation start does not become a Work start");
  const revision = db.prepare("SELECT revision FROM bot_message_revisions WHERE message_id='assistant-first'").get();
  assert(revision && typeof revision === "object" && "revision" in revision && Number(revision.revision) > 2,
    "communication facts advance the real source message revision");
  const historyFirst = repo.history("u", { botId: "target", collaborationId: relation.collaborationId, limit: 1 });
  assert(historyFirst.nextCursor);
  assert.throws(() => repo.history("u", { botId: "source", collaborationId: relation.collaborationId, cursor: historyFirst.nextCursor ?? undefined }), /筛选不匹配/);
  assert.throws(() => repo.history("u", { botId: "other", collaborationId: relation.collaborationId }), /当前用户与 Bot/);
  db.exec(`CREATE TABLE work_execution_bindings(binding_id TEXT PRIMARY KEY,work_id TEXT,status TEXT,settled_at INTEGER,
    admitted_at INTEGER,intent_revision INTEGER,input_snapshot_id TEXT,owner_epoch INTEGER,invalidated_at INTEGER);
    INSERT INTO work_execution_bindings VALUES ('binding-v1','work-target','completed',9100,1450,1,'input-v1',1,NULL);`);
  repo.event("u", relation.collaborationId, { operationId: "old-start", kind: "started", workId: "work-target", exchangeId: "binding-v1", createdAt: 1450 });
  repo.event("u", relation.collaborationId, { operationId: "old-end", kind: "ended", workId: "work-target", exchangeId: "binding-v1", createdAt: 9100 });
  assert.equal(repo.get("u", relation.collaborationId)?.work?.endedAt, 9100);
  db.exec("UPDATE works SET intent_revision=2,input_snapshot_id='input-v2' WHERE work_id='work-target'");
  assert.equal(repo.get("u", relation.collaborationId)?.work?.startedAt, null,
    "a queued new revision without a binding cannot inherit the previous revision start");
  db.exec("INSERT INTO work_execution_bindings VALUES ('binding-v2','work-target','running',NULL,9200,2,'input-v2',1,NULL)");
  repo.event("u", relation.collaborationId, { operationId: "new-start", kind: "started", workId: "work-target", exchangeId: "binding-v2", createdAt: 9210 });
  assert.equal(repo.get("u", relation.collaborationId)?.work?.startedAt, 9210);
  assert.equal(repo.get("u", relation.collaborationId)?.work?.endedAt, null, "old revision terminal time cannot end a running current revision");
  repo.event("u", relation.collaborationId, { operationId: "partial-delivery", kind: "returned", workId: "work-target", createdAt: 9300 });
  repo.event("u", relation.collaborationId, { operationId: "final-delivery", kind: "returned", workId: "work-target", createdAt: 9400 });
  assert.equal(repo.get("u", relation.collaborationId)?.times.returnedAt, 9400, "latest actual source return advances the summary, without rewriting earlier events");
  assert.equal(repo.event("u", relation.collaborationId, { operationId: "partial-delivery", kind: "returned", workId: "work-target", createdAt: 9999 }).createdAt, 9300);
  assert.equal(repo.get("u", relation.collaborationId)?.times.returnedAt, 9400);
  assert.equal(repo.get("u", relation.collaborationId)?.work?.closedAt, null);
  db.exec("UPDATE works SET lifecycle='closed',closed_at=9450,updated_at=9450 WHERE work_id='work-target'");
  assert.equal(repo.get("u", relation.collaborationId)?.work?.closedAt, 9450, "Work closure time comes from the actual Work fact");

  const before = repo.list("u", { botId: "target" }).total;
  assert.throws(() => db.transaction(() => {
    const rolled = repo.ensure(source("rollback"));
    repo.appendMessage("u", rolled.collaborationId, { operationId: "rollback-message", senderBotId: "other", senderDisplayName: "Other", kind: "reply", text: "bad" });
  })(), /发送者/);
  assert.equal(repo.list("u", { botId: "target" }).total, before, "acceptance caller can atomically roll back relation and message");

  db.prepare("UPDATE bot_conversations SET archived_at=1500 WHERE conversation_id=?").run(initial.sourceConversationId);
  assert.equal(repo.get("u", relation.collaborationId)?.originAvailable, true, "archived source remains exact delivery destination");
  db.prepare("DELETE FROM bot_send_receipts WHERE conversation_id=?").run(initial.sourceConversationId);
  db.prepare("DELETE FROM bot_messages WHERE conversation_id=?").run(initial.sourceConversationId);
  db.prepare("DELETE FROM bot_conversations WHERE conversation_id=?").run(initial.sourceConversationId);
  assert.equal(repo.get("u", relation.collaborationId)?.originAvailable, false);
  assert.equal(repo.get("u", relation.collaborationId)?.sourceConversationId, initial.sourceConversationId);
  assert.equal(repo.ensure(initial).collaborationId, relation.collaborationId, "accepted initiation remains replayable after source deletion");
  repo.appendMessage("u", relation.collaborationId, { operationId: "work-result", version: "v1", senderBotId: "target", senderDisplayName: "Target", kind: "result", text: "Real partial output", createdAt: 9500 });
  assert.equal(repo.get("u", relation.collaborationId)?.messageCount, 3, "deleted source does not discard returned target facts");
  assert.equal(repo.get("u", relation.collaborationId)?.workId, "work-target");
  db.close();
  db = new Database(file);
  const reopened = new BotCollaborationRepository(db);
  assert.equal(reopened.history("u", { botId: "target", collaborationId: relation.collaborationId }).totalMessages, 3);
  assert.equal(reopened.byWork("u", "work-target")?.times.acceptedAt, 1400);
  assert.equal(reopened.get("u", relation.collaborationId)?.times.deliveredAt, 1420);
  assert.equal(reopened.list("u", { botId: "target", direction: "incoming" }).items.find(item => item.collaborationId === relation.collaborationId)?.replyPreview,
    "Real partial output", "received summaries survive restart and deletion of source chat without fabricated messages");
  const beforeDeletion = reopened.get("u", relation.collaborationId)!;
  assert.equal(beforeDeletion.sourceBotExists, true);
  assert.equal(beforeDeletion.targetBotExists, true);
  db.prepare("DELETE FROM bots WHERE bot_id=?").run("target");
  const deleted = reopened.list("u", { botId: "source", participants: "deleted" }).items.find(item => item.collaborationId === relation.collaborationId)!;
  assert.equal(deleted.targetBotExists, false, "current registry deletion is projected on next list read");
  assert.equal(deleted.sourceBotExists, true);
  assert.equal(deleted.targetDisplayName, beforeDeletion.targetDisplayName, "historical identity remains readable");
  assert.equal(deleted.messageCount, beforeDeletion.messageCount);
  assert.equal(reopened.history("u", { botId: "source", collaborationId: relation.collaborationId }).totalMessages, 3);
  assert.equal(deleted.workId, "work-target", "deletion must not discard or relink the historical Work");
  const currentPage = reopened.list("u", { botId: "source", limit: 1 });
  assert.equal(currentPage.total, 0, "default listing excludes deleted participant records in SQL count");
  assert.equal(currentPage.items.length, 0);
  assert.equal(currentPage.nextCursor, null);
  const historyPage = reopened.list("u", { botId: "source", participants: "deleted", limit: 1 });
  assert(historyPage.total >= 2);
  assert.equal(historyPage.items.length, 1);
  assert(historyPage.nextCursor);
  assert.throws(() => reopened.list("u", { botId: "source", cursor: historyPage.nextCursor! }), /筛选不匹配/,
    "historical cursor cannot be reused in current scope");
  const nextHistory = reopened.list("u", { botId: "source", participants: "deleted", limit: 1, cursor: historyPage.nextCursor! });
  assert.equal(nextHistory.total, historyPage.total);
  assert.notEqual(nextHistory.items[0]?.collaborationId, historyPage.items[0].collaborationId);
  const surviving = reopened.ensure({...source("surviving", "live-conversation"), targetBotId: "other"});
  const survivingPage = reopened.list("u", { botId: "source" });
  assert.equal(survivingPage.total, 1);
  assert.deepEqual(survivingPage.items.map(item=>item.collaborationId), [surviving.collaborationId]);
  assert.equal(reopened.list("u", {botId:"source", participants:"deleted"}).total, historyPage.total);
  assert.throws(() => reopened.list("v", {botId:"source", participants:"deleted"}), /当前用户|Bot/);
  db.prepare("DELETE FROM bots WHERE bot_id=?").run("source");
  assert.equal(reopened.get("u", relation.collaborationId)?.sourceBotExists, false);
  assert.equal(reopened.get("u", relation.collaborationId)?.originAvailable, false);
  console.log("bot collaboration repository: durable identity, original scope, replay, pagination, receipts and deletion PASS");
} finally {
  db.close();
  const target = relative(tmpdir(), directory);
  if (!target.startsWith("..") && target.startsWith("bot-collaboration-store-")) rmSync(directory, { recursive: true, force: true });
}
