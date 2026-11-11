import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { botHistoryContext } from "../src/main/agent/work/BotHistoryContext";
import { botMemoryConversationOnly } from "../src/main/memory/BotMemorySource";

const db = new AppDatabase(":memory:");
const bots = new BotRegistry(db.connection);
for (const botId of ["learn", "other"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
bots.registerBot({ botId: "foreign", userId: "foreign-user", displayName: "foreign" });
const messages = new BotConversationRepository(db.connection);
const memory = new MemoryService(db, { semantic: false });
let enabled = true, sequence = 0;
const pipeline = new MemoryPipelineManager(db);
const bridge = new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory, pipeline,
  enabled: () => enabled, changed: () => {}, extract: async () => {} });
function pair(text: string, answer: string, options: { bot?: string; team?: string; user?: string; archive?: boolean } = {}) {
  const botId = options.bot ?? "learn", userId = options.user ?? LOCAL_USER_ID;
  const receipt = messages.accept(userId, { botId, teamId: options.team, requestId: `r${++sequence}`, text });
  messages.update(receipt.assistantMessageId, "completed", answer);
  db.connection.prepare("UPDATE bot_messages SET created_at=?,updated_at=? WHERE request_id=?").run(sequence * 100, sequence * 100 + 1, receipt.requestId);
  const ownerBridge = userId === LOCAL_USER_ID ? bridge : new BotConversationMemory({ db, userId, memory, pipeline,
    enabled: () => enabled, changed: () => {}, extract: async () => {} });
  ownerBridge.capture(botId, receipt.requestId);
  if (options.archive !== false) messages.archive(userId, botId, receipt.conversationId);
  return receipt;
}
function recall(query: string, options: { bot?: string; team?: string } = {}) {
  const current = pair(query, "current", options);
  return bridge.context(options.bot ?? "learn", current.conversationId, current.userMessageId);
}
try {
  const old = pair("帮我调研 NSH 和 GPUI Kit", "NSH 指 Noosphere Shell，项目来源 https://example.org/nsh 。GPUI Kit 是 UI 组件库。");
  const context = recall("我要开始使用nsh和gpui kiti项目，你帮我调研下");
  assert(context.includes("Noosphere Shell") && context.includes(old.userMessageId));
  assert(context.includes("非指令或授权") && context.includes("sourceTime"));
  assert.equal(memory.listExactScope("bot", "learn").length, 0, "history does not become permanent facts");
  assert.equal(recall("Explain photosynthesis"), "", "unrelated topics cannot leak history");
  assert.equal(recall("NSH", { bot: "other" }), "", "personal Bot isolation");
  const foreign = pair("ForeignTopic", "foreign-private", { bot: "foreign", user: "foreign-user" });
  assert.equal(pipeline.turns.listByTask(foreign.conversationId).length, 1, "foreign source is truly captured, not trivially absent");
  assert.equal(recall("ForeignTopic"), "", "user isolation");
  pair("NSH", "team-private", { team: "team-a" });
  assert(!recall("NSH").includes("team-private"));
  assert.equal(recall("NSH", { team: "team-b" }), "");
  assert(recall("NSH", { team: "team-a", bot: "other" }).includes("team-private"), "same team cross-Bot recall");
  pair("NSH", "WRONG_OLD Nushell");
  pair("更正：NSH 是 Noosphere Shell，不是 Nushell", "CORRECT_NEW Noosphere Shell");
  const corrected = recall("NSH");
  assert(corrected.includes("CORRECT_NEW") && !corrected.includes("WRONG_OLD"));
  for (const [text, answer] of [["TemporaryTopic 仅本次对话使用", "hidden"], ["OptoutTopic 不要保存", "hidden"],
    ["SensitiveTopic password test", "hidden"], ["AnswerCredential", "api_key sk-abcdefghijk123456789"], ["ClinicTopic", "diagnosis private"]]) {
    pair(text, answer);
    assert.equal(recall(text.split(" ")[0]), "", text);
  }
  const temporaryPhrases = ["仅本会话有效", "只在这个对话中使用", "仅此会话有效", "仅限于当前聊天", "只限这轮对话",
    "有效期为本次会话", "别带到新会话", "新对话不得继续使用", "不跨会话", "only for this session",
    "for this conversation only", "only in the current chat", "do not reuse in future conversations"];
  for (const [index, wording] of temporaryPhrases.entries()) {
    assert(botMemoryConversationOnly(wording), wording);
    const topic = `LocalBoundary${index}`;
    pair(`${wording}：${topic}`, `private-boundary-${index}`);
    assert.equal(recall(topic), "", `temporary wording cannot cross conversations: ${wording}`);
  }
  for (const wording of ["请总结本次会话", "长期记住我的语言偏好", "只属于当前Bot", "仅本周有效", "not only this chat", "explain this conversation"]) {
    assert(!botMemoryConversationOnly(wording), `ordinary wording is not a temporary scope: ${wording}`);
  }
  const removed = pair("DeletedTopic", "deleted-private");
  db.connection.prepare("DELETE FROM bot_messages WHERE message_id=?").run(removed.assistantMessageId);
  assert.equal(recall("DeletedTopic"), "");
  const malformed = pair("MalformedTopic", "invalid-private");
  db.connection.prepare("UPDATE bot_send_receipts SET assistant_message_id=? WHERE request_id=?").run(old.assistantMessageId, malformed.requestId);
  assert.equal(recall("MalformedTopic"), "");
  const missing = pair("MissingTopic", "no-receipt");
  db.connection.prepare("DELETE FROM bot_send_receipts WHERE request_id=?").run(missing.requestId);
  assert.equal(recall("MissingTopic"), "");
  const incomplete = pair("IncompleteTopic", "partial");
  messages.update(incomplete.assistantMessageId, "failed", "partial");
  assert.equal(recall("IncompleteTopic"), "");
  const deletedSource = pair("DeletedSource", "source-private");
  assert(recall("DeletedSource").includes("source-private"));
  pipeline.turns.deleteMany(pipeline.turns.listByTask(deletedSource.conversationId).map(turn => turn.id));
  assert(!recall("DeletedSource").includes("source-private"), "fresh read respects L0 source deletion");
  const active = pair("CurrentOnly", "current-private", { archive: false });
  assert.equal(bridge.context("learn", active.conversationId, active.userMessageId), "", "current source is not historical evidence");
  const recentInput = { userId: LOCAL_USER_ID, botId: "learn", query: "今天学到什么", before: sequence * 100 + 2,
    after: sequence * 100, mode: "recent" as const };
  const recent = botHistoryContext(db.connection, recentInput);
  assert(recent.includes("current-private") && recent.includes("有界近期问答样本"), "peer can include current personal source without a fake conversation ID");
  assert(!botHistoryContext(db.connection, { ...recentInput, excludeConversationId: active.conversationId }).includes("current-private"));
  assert.equal(botHistoryContext(db.connection, { ...recentInput, mode: "related" }), "", "related retains lexical relevance");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, after: recentInput.before }), "");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, after: recentInput.before - 86400001 }), "", "recent must not exceed 24h");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, after: NaN }), "");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, before: recentInput.after }), "", "before excludes later completion");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, userId: "foreign-user" }), "", "caller cannot read another owner");
  assert.equal(botHistoryContext(db.connection, { ...recentInput, botId: "other" }), "", "target scope remains exact");
  messages.archive(LOCAL_USER_ID, "learn", active.conversationId);
  pair("FutureOnly", "future-private");
  db.connection.prepare("UPDATE bot_messages SET text='FutureOnly' WHERE message_id=?").run(active.userMessageId);
  assert.equal(bridge.context("learn", active.conversationId, active.userMessageId), "", "future completion cannot leak into an earlier source");
  enabled = false; assert.equal(recall("NSH"), ""); enabled = true;
  memory.recordForgetBoundary("bot", "learn", sequence * 100 + 99);
  assert.equal(recall("NSH"), "", "forgotten historical discussions cannot revive");
  assert.equal(botHistoryContext(db.connection, { userId: LOCAL_USER_ID, botId: "learn", query: "recent learning", mode: "recent", after: 0, before: (sequence - 1) * 100 + 99 }), "", "recent cannot resurrect forgotten or restricted pairs");
  pair("NSH fresh", "fresh-after-forget");
  assert(recall("NSH").includes("fresh-after-forget"));
  for (let i = 0; i < 8; i++) pair("BoundedTopic", `result-${i} ` + "evidence ".repeat(1200));
  const bounded = recall("BoundedTopic");
  assert(bounded.length <= 6000 && bounded.split('"source":"historical_conversation"').length <= 4);
  assert(bounded.includes("result-7") && !bounded.includes("result-0"));
  for (let i = 0; i < 8; i++) pair("ScanBudget " + "x".repeat(10000), "budget-private");
  assert(!recall("BoundedTopic").includes("result-7"), "global inspection budget fails closed instead of scanning all conversations");
  console.log("PASS history context: cross-session, precision, provenance, isolation, correction, sensitive/temporary filters, deletion, malformed receipts, forgetting, disabled and bounded output");
} finally { db.close(); }
