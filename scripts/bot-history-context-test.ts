import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { botHistoryContext } from "../src/main/agent/work/BotHistoryContext";
import { botMemoryConversationOnly, botMemoryTextEligible } from "../src/main/memory/BotMemorySource";

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
/** One real conversation with many completed turns, so source size is under test. */
function conversation(turns: Array<[string, string]>, options: { bot?: string; team?: string } = {}) {
  const botId = options.bot ?? "learn";
  let conversationId: string | undefined;
  for (const [text, answer] of turns) {
    const receipt = messages.accept(LOCAL_USER_ID, { botId, teamId: options.team, conversationId, requestId: `r${++sequence}`, text });
    messages.update(receipt.assistantMessageId, "completed", answer);
    db.connection.prepare("UPDATE bot_messages SET created_at=?,updated_at=? WHERE request_id=?").run(sequence * 100, sequence * 100 + 1, receipt.requestId);
    bridge.capture(botId, receipt.requestId);
    conversationId = receipt.conversationId;
  }
  if (conversationId) messages.archive(LOCAL_USER_ID, botId, conversationId);
  return conversationId!;
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
  assert.equal(botHistoryContext(db.connection, { ...recentInput, after: recentInput.before - 25 * 60 * 60 * 1000 - 1 }), "", "recent must not exceed one local day (25h DST bound)");
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

  // ── Issue #28: relevance-first retrieval, no source-inspection cliff ─────────
  const longSource = conversation([["LongSourceTopic 旧方案：用 NSH 的 MTLS 灰度回滚演练", "长会话答案：MTLS 灰度回滚演练旧结论是 NSH"],
    ...Array.from({ length: 304 }, (_, i) => [`LongSourceNoise ${i}`, `长会话噪声回答 ${i}`] as [string, string])]);
  const longRecall = recall("MTLS 灰度回滚演练的旧方案");
  assert(longRecall.includes("长会话答案"), "a clean 305-turn source is recallable: the 300/301 scan boundary is gone");
  assert(longRecall.includes(longSource), "provenance keeps the exact source conversation");

  // Explicit 299/300/301-turn sources: the previous scan budget refused all three.
  const boundary: Array<[number, string]> = [[299, "Boundary299Topic"], [300, "Boundary300Topic"], [301, "Boundary301Topic"]];
  for (const [size, topic] of boundary) {
    conversation([[`${topic} 的旧方案结论`, `${topic} 答案`],
      ...Array.from({ length: size - 1 }, (_, i) => [`${topic}Noise ${i}`, `边界噪声回答 ${i}`] as [string, string])]);
  }
  for (const [size, topic] of boundary) assert(recall(`${topic} 的旧方案结论`).includes(`${topic} 答案`),
    `a ${size}-turn source still recalls its oldest relevant pair`);

  for (let c = 0; c < 6; c++) conversation(Array.from({ length: 250 }, (_, i) => [`BudgetNoise ${c}-${i}`, `规模噪声回答 ${c}-${i}`] as [string, string]));
  assert(recall("MTLS 灰度回滚演练的旧方案").includes("长会话答案"), "unrelated large sources cannot consume a shared inspection budget");

  conversation([["StoneTopic 不要保存：内部定价草稿 v1", "禁止保存的回答"],
    ...Array.from({ length: 304 }, (_, i) => [`StoneNoise ${i}`, `禁止噪声回答 ${i}`] as [string, string]),
    ["StoneTopic 后续补充：内部定价草稿 v2", "后续回答"]]);
  assert.equal(recall("StoneTopic 内部定价草稿"), "", "do-not-save still protects every follow-up in a long source");

  conversation([["仅本次对话有效：LocalScopeTopic 调度参数", "只在本会话"],
    ...Array.from({ length: 120 }, (_, i) => [`LocalScopeNoise ${i}`, `范围噪声回答 ${i}`] as [string, string])]);
  assert.equal(recall("LocalScopeTopic 调度参数"), "", "conversation-only wording keeps protecting a long source");

  conversation([["SkipTopic 不要保存 旧内容", "禁止来源回答"]]);
  pair("SkipTopic 合法的新结论", "合法来源回答");
  assert(recall("SkipTopic 合法的新结论").includes("合法来源回答"), "one prohibited source cannot hide an allowed match");

  const buried = pair("BuriedTopic 旧方案：NSH 的 MTLS 灰度回滚演练步骤",
    "埋藏答案：NSH 的 MTLS 灰度回滚演练步骤见第 812 号记录");
  for (let i = 0; i < 700; i++) {
    pair(`BacklogTopic ${i} 的界面调整讨论`, `批量回答 ${i}`);
    if (i % 2) pair(`TeamBacklog ${i} 的排期讨论`, `团队回答 ${i}`, { team: "team-long" });
  }
  const buriedRecall = recall("BuriedTopic NSH 的 MTLS 灰度回滚演练步骤");
  assert(buriedRecall.includes(buried.userMessageId) && buriedRecall.includes("第 812 号记录"),
    "a relevant pair older than 1000 interleaved pairs is retrieved with its original message ids");
  assert(buriedRecall.includes(buried.conversationId) && buriedRecall.includes("sourceTime"), "source time and conversation survive retrieval");
  assert(!recall("BuriedTopic NSH 的 MTLS 灰度回滚演练步骤", { bot: "other" }).includes(buried.userMessageId), "old personal recall stays inside the owning Bot");
  assert(!recall("BuriedTopic NSH 的 MTLS 灰度回滚演练步骤", { team: "team-long" }).includes(buried.userMessageId), "old personal recall is not promoted into a team scope");

  const gitSha = "14a650406359b5c4bd4cc358b2a7623364242298";
  const shaPair = pair(`GitShaTopic 记住：生产只跑 TLS 1.3，参考提交 ${gitSha}`, `GitShaTopic 已记录 ${gitSha}`);
  assert(recall("GitShaTopic TLS 1.3").includes(shaPair.userMessageId), "a full Git SHA is a technical identifier, not a blocked secret");
  const cookiePair = pair("CookieTopic cookie 技术讨论：只记录主题，不放会话票据", "CookieTopic 讨论记录");
  assert(recall("CookieTopic cookie 技术讨论").includes(cookiePair.userMessageId), "ordinary cookie discussion is recallable");
  for (const [text, answer] of [["SecretTopic password=hunter2", "真实密码回答"],
    ["SecretTopic2 Set-Cookie: session=abc123def456", "真实 Cookie 回答"], ["SecretTopic3 api_key={{API_KEY_live_9x}}", "真实令牌回答"]]) {
    pair(text, answer);
    assert.equal(recall(text.split(" ")[0]), "", `real secret syntax is still excluded: ${text}`);
  }
  const longAnswer = pair("LongAnswerTopic 超长答案主题", "LongAnswerTopic MARKER " + "补充说明 ".repeat(6000));
  assert(recall("LongAnswerTopic 超长答案主题").includes("MARKER"), "an oversized answer is quoted instead of silently dropping the pair");
  pair("OversizeTopic 超限内容", "x".repeat(210000) + "MARKER");
  assert.equal(recall("OversizeTopic 超限内容"), "", "a message above the per-pair size bound is excluded, never truncated into a leak");

  // ── Review follow-up: final-context assertions, not only entry booleans ──────────
  for (const secret of ["Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz",
    "请求头：Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz",
    "排查失败的请求：" + String.fromCharCode(10) + "Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz",
    'curl -H "Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz" https://example.invalid',
    '{"Cookie": "sid=FAKE_REVIEW_ONLY_abcdEFGHxyz"}']) {
    assert(!botMemoryTextEligible(secret), `value-shaped cookie is rejected: ${secret}`);
    const receipt = pair(secret, "登录排查记录");
    // Even if such a pair somehow reached L0, recall must not replay the value.
    db.connection.prepare(`INSERT INTO memory_turns(id,task_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,captured_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(`forced-${receipt.userMessageId}`, receipt.conversationId,
      receipt.userMessageId, receipt.assistantMessageId, "", "", "forced", 0);
    const context = recall(`AcmePortal 登录排查 ${receipt.requestId}`);
    assert(!context.includes("FAKE_REVIEW_ONLY_abcdEFGHxyz"), "secret value never reaches the final history context");
  }
  assert(botMemoryTextEligible("cookie 只保存主题，不放会话票据"));

  // Correction time relations: an older correction must never suppress a newer fact.
  pair("更正 NSH port is 8080", "STALE_8080");
  pair("NSH port is now 9090", "LATEST_9090");
  assert(recall("NSH port").includes("LATEST_9090"), "a newer fact survives an older explicit correction");
  for (const port of [8080, 8081, 8082]) pair(`更正 NSH production service port is ${port}`, `STALE_${port}`);
  pair("更正 NSH port is 9090", "LATEST_CORRECTION_9090");
  const correctionContext = recall("NSH production service port");
  assert(correctionContext.includes("LATEST_CORRECTION_9090"), "the newest correction always earns an evidence slot");

  // Substring false positives and prohibited sources must not starve the valid pair.
  const exact = pair("NSH", "EXACT_ALLOWED_REFERENCE");
  for (let i = 0; i < 200; i++) pair(`NSH2 unrelated deployment ${i}`, `unrelated answer ${i}`);
  assert(recall("NSH").includes("EXACT_ALLOWED_REFERENCE"), "200 substring matches cannot starve the exact token pair");
  const maple = pair("MapleTopic exact decision", "MAPLE_ALLOWED_REFERENCE");
  const noiseSource = conversation([["MapleTopic 不要保存：旧草稿", "禁止来源首条"],
    ...Array.from({ length: 200 }, (_, i) => [`MapleTopic follow-up ${i}`, `禁止来源 follow-up ${i}`] as [string, string])]);
  assert(noiseSource && recall("MapleTopic").includes("MAPLE_ALLOWED_REFERENCE"), "a prohibited source cannot starve the valid one");
  assert(!recall("MapleTopic").includes("禁止来源 follow-up"), "the prohibited source itself stays excluded");

  // Work cap is expressed, never reported as "no history".
  for (let i = 0; i < 1250; i++) pair(`CapTopic2 entry ${i}`, `cap answer ${i}`);
  const capped = recall("CapTopic");
  assert(capped.includes("工作上限") && !capped.includes('"source":"historical_conversation"'), "reaching the work cap is stated separately from an empty history");

  // A long answer is quoted around the matching passage, not from its head.
  const longMatch = pair("PortsTopic operational decision", "preface ".repeat(300) + "NSH exact operational decision: port 9090");
  const longContext = recall("PortsTopic NSH operational decision port 9090");
  assert(longContext.includes(longMatch.userMessageId) && longContext.includes("9090"), "a long answer is excerpted around the match");
  const longLine = longContext.split(String.fromCharCode(10)).find(line => line.includes(longMatch.userMessageId))!;
  const longQuote = JSON.parse(longLine).assistantQuote as string;
  assert(longQuote.startsWith("…") && longQuote.includes("9090") && longQuote.length <= 1501, "the long-answer excerpt is a window around the match");

  // Follow-up review on e35fafd6: a harmless first cookie / URL encoding / short
  // values must not hide later credential bytes, including existing L0 pointers.
  for (const [index, header] of ["Cookie: a=b; sid=FAKE_REVIEW_ONLY_abcdefghijk", "Cookie: sid=%46%41%4B%45", "Cookie: s=abc", '{"Cookie": "a=b; sid=FAKE_REVIEW_ONLY_abcdefghijk"}'].entries()) {
    const receipt = pair(`CookieSyntax${index} ${header}`, "legacy private answer");
    pipeline.capture({ taskId: receipt.conversationId, sessionId: receipt.conversationId,
      userMessageId: receipt.userMessageId, assistantMessageId: receipt.assistantMessageId,
      userText: "", assistantText: "", metadata: {} });
    assert(!recall(`CookieSyntax${index}`).includes(receipt.userMessageId), "Cookie syntax must not escape through historical replay");
  }
  // Three survivors in the first page do not prove a later-ranked, newer correction
  // has been examined. The query score deliberately ranks the 205 old rows first.
  for (let i = 0; i < 205; i++) pair(`PagedCorrectionTopic production service port is 808${i}`, `STALE_PAGED_${i}`);
  pair("更正 PagedCorrectionTopic port is 9090", "LATEST_PAGED_9090");
  assert(recall("PagedCorrectionTopic production service port").includes("LATEST_PAGED_9090"), "latest lower-score correction beyond page 1 must reserve an evidence slot");
  const tiedOld = pair("TieCorrectionTopic port is 8080", "STALE_TIED_8080");
  const tiedNew = pair("更正 TieCorrectionTopic port is 9090", "LATEST_TIED_9090");
  db.connection.prepare("UPDATE bot_messages SET created_at=? WHERE message_id IN (?,?)").run(sequence * 100, tiedOld.userMessageId, tiedNew.userMessageId);
  const tiedRecall = recall("TieCorrectionTopic port");
  assert(tiedRecall.includes("LATEST_TIED_9090") && !tiedRecall.includes("STALE_TIED_8080"), "same-millisecond correction uses durable ordinal to retire older evidence");

  for (let i = 0; i < 43; i++) pair("BoundedInspectionTopic", "x".repeat(190000));
  assert(recall("BoundedInspectionTopic").includes("工作上限"), "streaming inspection has an explicit total-text bound even with fewer than 1200 rows");

  console.log("PASS history context: relevance-first retrieval beyond 1000 pairs, no 300/301 or shared-budget cliff, exact per-source prohibition, provenance, isolation, correction, Git SHA/cookie eligibility, secrets, deletion, receipts, forgetting, disabled and bounded output");
} finally { db.close(); }
