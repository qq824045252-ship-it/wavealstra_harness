import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { botHistoryContext } from "../src/main/agent/work/BotHistoryContext";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { MemoryForgetWatermarks } from "../src/main/memory/MemoryForgetWatermarks";
import { MemorySemanticProvider } from "../src/main/memory/MemorySemanticProvider";
import { SemanticRuntime, SemanticUnavailableError } from "../src/main/retrieval/SemanticRuntime";
import { SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/SemanticModelManager";
import type { MemoryTurnDto } from "../src/shared/memory-kernel";
import type { GatewayBotOrigin } from "../src/main/agent/work/BotTurnOrigins";
import { memorySearchWhere } from "../src/main/memory/MemorySearchScope";

function fixture(file = ":memory:") {
  const db = new AppDatabase(file);
  const bots = new BotRegistry(db.connection);
  for (const botId of ["owner", "peer"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
  const memory = new MemoryService(db, { semantic: false });
  const pipeline = new MemoryPipelineManager(db);
  const messages = new BotConversationRepository(db.connection);
  const bridge = new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory, pipeline,
    enabled: () => true, extract: async () => {}, changed: () => {} });
  let n = 0;
  const prefix = randomUUID();
  const send = (text: string, botId = "owner") => {
    const r = messages.accept(LOCAL_USER_ID, { botId, requestId: `${prefix}-${++n}`, text });
    messages.update(r.assistantMessageId, "completed", "收到");
    bridge.capture(botId, r.requestId);
    return r;
  };
  const history = (query: string, botId = "owner") => botHistoryContext(db.connection,
    { userId: LOCAL_USER_ID, botId, query, before: Date.now() + 1000 });
  return { db, memory, pipeline, messages, bridge, send, history };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function extract(s: ReturnType<typeof fixture>, conversationId: string, facts: Array<{ title: string; content: string; userEvidence: string }>,
  afterRequest = async () => {}) {
  const modelRuntime = { completeSimple: async () => {
    await afterRequest();
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates: facts.map(fact => ({ ...fact,
      kind: "preference", scopeType: "bot", confidence: 1, importance: 1, explicit: true, operationHint: "create", retention: "stable", sensitivity: "none" })) }) }] };
  } } as unknown as ModelRuntime;
  return s.memory.extractAndStore({ taskId: conversationId, sourceTurns: s.pipeline.turns.listPending(conversationId, 50),
    userText: "", assistantText: "", modelRuntime, model: { maxTokens: 4096 } as never, isEnabled: () => true });
}

let failures = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}

await check("#40 distribute/save adverb is not an opt-out; real prohibitions still reject", () => {
  for (const [text, allowed] of [
    ["请长期记住两条独立事实：AsterPreference 的标记是紫杉7319；HeliosCalibration 的标记是青丘8264。分别保存，不要共享给其他Bot。", true],
    ["请分别记住：HeliosCalibration 的标记是青丘8264。", true],
    ["请别保存：HeliosCalibration 的标记是青丘8264。", false],
    ["千万别记住：HeliosCalibration 的标记是青丘8264。", false],
    ["不要保存：HeliosCalibration 的标记是青丘8264。", false],
    ["Do not save HeliosCalibration 的标记是青丘8264。", false],
  ] as const) {
    const s = fixture();
    try {
      const r=s.send(text);
      const action=()=>s.bridge.remember("owner",r.conversationId,{scope:"current",kind:"fact",title:"HeliosCalibration",content:"标记是青丘8264",userEvidence:"HeliosCalibration 的标记是青丘8264"},text);
      if (allowed) { assert(action().saved,text); assert.equal(s.pipeline.turns.listPending(r.conversationId,50).length,1,text); }
      else { assert.throws(action,/敏感秘密|不保存/,text); assert.equal(s.pipeline.turns.listPending(r.conversationId,50).length,0,text); }
      assert.equal((s.db.connection.prepare("SELECT count(*) n FROM memory_forget_watermarks").get() as { n: number }).n,0);
    } finally { s.db.close(); }
  }
});

await check("#40 non-delete wording keeps history and permits evidence", () => {
  for (const text of ["不要忘记我的回复偏好是先给结论。", "别忘记后续用中文回答。",
    "Don't forget my preferred output is Markdown.", "Never forget my preferred output is Markdown.",
    "你是不是忘记了 HeliosCalibration 的方案？", "请帮我实现 forget 命令的单元测试。"]) {
    const s = fixture();
    try {
      s.send("HeliosCalibration 的校准常数是 17.25。");
      assert(s.history("HeliosCalibration").includes("17.25"));
      const r = s.send(text);
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), [], text);
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_targets").all(), [], text);
      assert.throws(() => s.bridge.forget("owner", [], text, text), /当前用户/, text);
      assert(s.history("HeliosCalibration").includes("17.25"), text);
      if (text.startsWith("不要忘记")) {
        assert(s.bridge.remember("owner", r.conversationId, { scope: "current", kind: "preference", title: "回答顺序",
          content: "先给结论", userEvidence: "我的回复偏好是先给结论" }, text).saved);
      }
    } finally { s.db.close(); }
  }
});

await check("#40 complete messages retain examples, quotations, prohibitions and questions", () => {
  for (const text of [
    "示例命令：\n删除我的全部记忆\n这里只是文档，不要执行",
    "帮我解释以下示例，不要执行：\n忘记 A\n记住 B",
    "请解释以下命令：\n```text\n删除我的全部记忆\n```",
    "引用：\n> 删除我的全部记忆\n请解释，不要执行。",
    "示例：\n现在请执行：\n删除我的全部记忆",
    "示例：\n执行以下操作：\n删除我的全部记忆",
    "删除我的记忆会怎样？", "忘记我的名字吗？",
    '下面这句话是什么意思：“忘记 A，删除我的全部记忆，记住 B”？',
    '忘记我的全部记忆，是不是就没有个性化了？',
    'What does "forget A, delete all my memories, remember B" mean?',
    '这句话是引用：\n“忘记 A，\n删除我的全部记忆，记住 B”',
    '这句话是引用：\n“删除我的全部记忆',
  ]) {
    const s = fixture();
    try {
      s.send("HeliosCalibration 的校准常数是17.25。");
      s.send(text);
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), [], text);
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_targets").all(), [], text);
      assert(s.history("HeliosCalibration").includes("17.25"), text);
      assert.throws(() => s.bridge.forget("owner", [], text, text), /当前用户/, text);
    } finally { s.db.close(); }
  }
});

await check("#40 explicit top-level execution survives reference parsing", () => {
  const s = fixture();
  try {
    s.send("记住 ValidPreference 是绿茶。");
    s.send("示例：\n忘记 ExamplePreference\n示例结束。\n现在请执行：\n忘记 ValidPreference");
    assert(!s.history("ValidPreference").includes("绿茶"));
    s.send("记住 PossessivePreference 是红茶。");
    assert(s.history("PossessivePreference").includes("红茶"));
    s.send('请解释 "James\' preferences"\n示例结束。\n请忘记 PossessivePreference');
    assert(!s.history("PossessivePreference").includes("红茶"), "possessive apostrophe cannot keep a reference open");
    s.send("记住 SeparatePreference 是白茶。");
    assert(s.history("SeparatePreference").includes("白茶"));
    s.send("请忘记 SeparatePreference；现在还有多少记忆？");
    assert(!s.history("SeparatePreference").includes("白茶"), "independent command before a question remains executable");
    s.send("HeliosCalibration 是17.25。");
    s.send("请执行以下操作：\n删除我的全部记忆");
    assert.equal(s.history("HeliosCalibration"), "");
  } finally { s.db.close(); }
});

await check("#41 category titles cannot revoke independent facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-category-review-"));
  const file = join(root, "app.db");
  let s = fixture(file);
  try {
    const a = { title: "回复偏好", content: "先给结论", userEvidence: "回复偏好：先给结论" };
    const b = { title: "回复偏好", content: "使用中文", userEvidence: "我的回复偏好还包括使用中文" };
    const r = s.send(`记住${a.userEvidence}；记住${b.userEvidence}。`);
    s.send("项目回复偏好是附上代码链接。");
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "preference", title: a.title,
      content: a.content, evidence: [{ evidenceKind: "conversation", refId: r.conversationId, excerpt: a.userEvidence }] });
    const gate = deferred(), entered = deferred();
    const pending = extract(s, r.conversationId, [a, b], async () => { entered.release(); await gate.promise; });
    await entered.promise;
    const deletion = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: "precise-generic", text: "忘记回复偏好" });
    const user = s.messages.message(deletion.userMessageId)!;
    s.bridge.forget("owner", [atom.id], user.text, user.text, deletion.conversationId, { createdAt: user.createdAt, messageId: user.messageId });
    s.messages.update(deletion.assistantMessageId, "completed", "已忘记这一项"); s.bridge.capture("owner", deletion.requestId);
    gate.release();
    assert.equal((await pending).committedCount, 1, "same-title B commits while A is withdrawn");
    assert(!s.history("回复偏好").includes("先给结论"));
    assert(s.history("使用中文").includes("使用中文"));
    assert(s.history("代码链接").includes("附上代码链接"));
    s.db.close(); s = fixture(file);
    assert(!s.history("回复偏好").includes("先给结论"));
    assert(s.history("使用中文").includes("使用中文"));
    assert(s.history("代码链接").includes("附上代码链接"));
    assert.equal((await extract(s, r.conversationId, [a])).committedCount, 0);
  } finally { s.db.close(); rmSync(root, { recursive: true, force: true }); }
});

await check("#41 exact forget receipts do not swallow another unresolved forget clause", async () => {
  const s = fixture();
  try {
    const old = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: "old-missing", text: "记住 DelayedPreference 是绿茶" });
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "preference", title: "已存偏好", content: "先给结论", sourceType: "user" });
    const deletion = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: "two-removals", text: "忘记已存偏好，忘记 DelayedPreference。" });
    const source = s.messages.message(deletion.userMessageId)!;
    s.bridge.forget("owner", [atom.id], source.text, "忘记已存偏好", deletion.conversationId, { createdAt: source.createdAt, messageId: source.messageId });
    s.messages.update(deletion.assistantMessageId, "completed", "处理完成"); s.bridge.capture("owner", deletion.requestId);
    s.messages.update(old.assistantMessageId, "completed", "迟到完成"); s.bridge.capture("owner", old.requestId);
    assert.equal((await extract(s, old.conversationId, [{ title: "DelayedPreference", content: "DelayedPreference 是绿茶", userEvidence: "DelayedPreference 是绿茶" }])).committedCount, 0);
  } finally { s.db.close(); }
});

await check("#40 team and shared-channel reminders keep the authorized scope", () => {
  for (const shared of [false, true]) {
    const s = fixture();
    try {
      s.send("PrivateHelios 的常数是17.25。");
      s.db.connection.exec(`CREATE TABLE IF NOT EXISTS work_team_templates(template_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,deleted_at INTEGER)`);
      s.db.connection.prepare("INSERT INTO work_team_templates(template_id,user_id) VALUES ('test-team',?)").run(LOCAL_USER_ID);
      const origin: GatewayBotOrigin = { channelId: "qq-default", connectionKey: "a".repeat(64), chatId: "group:test",
        senderId: "test", messageId: "reminder", audience: "shared" };
      const text = "不要忘记我的回复偏好是先给结论。";
      const r = s.db.connection.transaction(() => {
        const conversationId = shared ? s.messages.origins.gatewayConversation(LOCAL_USER_ID, "owner", origin) : undefined;
        const receipt = s.messages.accept(LOCAL_USER_ID, { botId: "owner", conversationId,
          teamId: shared ? undefined : "test-team", requestId: "scoped-reminder", text });
        if (shared) s.messages.origins.recordGateway(LOCAL_USER_ID, receipt, origin);
        return receipt;
      })();
      s.messages.update(r.assistantMessageId, "completed", "记住了"); s.bridge.capture("owner", r.requestId);
      const saved = s.bridge.remember("owner", r.conversationId, { scope: "current", kind: "preference", title: "回复顺序",
        content: "先给结论", userEvidence: "我的回复偏好是先给结论" }, text);
      assert.equal(saved.scopeType, shared ? "conversation" : "team");
      assert.equal(saved.scopeId, shared ? r.conversationId : "test-team");
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_targets").all(), []);
      assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), []);
      assert(s.history("PrivateHelios").includes("17.25"));
    } finally { s.db.close(); }
  }
});

await check("#41 precise forget preserves earlier unrelated history", () => {
  const s = fixture();
  try {
    s.send("记住 AsterPreference 是先画图；HeliosCalibration 的校准常数是 17.25。");
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "preference",
      title: "AsterPreference", content: "AsterPreference 是先画图" });
    assert(s.history("HeliosCalibration").includes("17.25"));
    s.bridge.forget("owner", [atom.id], "忘记 AsterPreference 这条记忆。", "忘记 AsterPreference 这条记忆。");
    assert.equal(s.memory.get(atom.id), undefined);
    assert(s.history("HeliosCalibration").includes("17.25"), "unrelated B predates deletion and shares A's source");
    assert(!s.history("AsterPreference").includes("先画图"), "forgotten A must not appear in history");
    s.send("RainfallGauge 的常数是23.75。");
    s.send("忘记 AI。");
    assert(s.history("RainfallGauge").includes("23.75"), "short Latin target AI cannot withdraw the substring in RainfallGauge");
    s.send("Remember A is the old tag.");
    s.send("Forget A.");
    assert(!s.history("old tag").includes("old tag"), "a single-letter exact target is still withdrawn");
    assert(s.history("HeliosCalibration").includes("17.25"), "single-letter A cannot withdraw a substring inside Calibration");
  } finally { s.db.close(); }
});

await check("#40 clause-local negation and mixed operations", () => {
  const s = fixture();
  try {
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "preference", title: "旧称呼", content: "旧称呼是阿青" });
    const text = "不要忘记回复偏好是中文，忘记旧称呼。";
    const r = s.send(text);
    assert(s.bridge.remember("owner", r.conversationId, { scope: "current", kind: "preference", title: "语言",
      content: "回复偏好是中文", userEvidence: "回复偏好是中文" }, text).saved);
    assert.equal(s.bridge.forget("owner", [atom.id], text, "忘记旧称呼", r.conversationId).forgottenCount, 1);
    assert.throws(() => s.bridge.forget("owner", [], "你是不是忘记旧称呼？", "忘记旧称呼"));
    assert.throws(() => s.bridge.forget("owner", [], "请帮我实现 forget 命令的测试", "forget"));
    s.send("Forget everything about AsterPreference.");
    assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), [], "all facts about A is still a targeted removal");
  } finally { s.db.close(); }
});

await check("#41 persisted evidence withdrawal keeps B and blocks A, including in-flight extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-correctness-"));
  const file = join(root, "app.db");
  let s = fixture(file);
  const a = { title: "AsterPreference", content: "偏爱先绘图", userEvidence: "我习惯先画图" };
  const b = { title: "HeliosCalibration", content: "HeliosCalibration 常数是17.25", userEvidence: "HeliosCalibration 常数是17.25" };
  try {
    const r = s.send(`记住${a.userEvidence}；记住${b.userEvidence}。`);
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "preference", title: a.title, content: a.content,
      evidence: [{ evidenceKind: "conversation", refId: r.conversationId, excerpt: a.userEvidence }] });
    const gate = deferred(), entered = deferred();
    const pending = extract(s, r.conversationId, [a, b], async () => { entered.release(); await gate.promise; });
    await entered.promise;
    s.memory.detachScope(atom.id, "bot", "owner");
    gate.release();
    const result = await pending;
    assert.equal(result.committedCount, 1, "B commits from an old in-flight source while A is rejected");
    assert(!s.memory.listExactScope("bot", "owner").some(item => item.title === a.title));
    assert(s.history("HeliosCalibration").includes("17.25"));
    assert(!s.history("AsterPreference").includes(a.userEvidence));
    const count = s.db.connection.prepare("SELECT count(*) n FROM bot_messages").get();
    s.db.close(); s = fixture(file);
    assert.deepEqual(s.db.connection.prepare("SELECT count(*) n FROM bot_messages").get(), count);
    assert(s.history("HeliosCalibration").includes("17.25"), "B survives reopen");
    assert.equal((await extract(s, r.conversationId, [a])).committedCount, 0, "A cannot retry after reopen");
    const targets = JSON.stringify(s.db.connection.prepare("SELECT * FROM memory_forget_targets").all());
    assert(!targets.includes(a.title) && !targets.includes(a.content) && !targets.includes(a.userEvidence));
    // New statements sharing a millisecond with a forget still have durable ordinal ordering.
    const deletion = s.send("忘记同毫秒偏好。");
    const source = s.messages.message(deletion.userMessageId)!;
    const fresh = s.send("记住同毫秒偏好是绿茶。");
    s.db.connection.prepare("UPDATE bot_messages SET created_at=? WHERE message_id=?").run(source.createdAt, fresh.userMessageId);
    assert.equal((await extract(s, fresh.conversationId, [{ title: "同毫秒偏好", content: "同毫秒偏好是绿茶", userEvidence: "同毫秒偏好是绿茶" }])).committedCount, 1);
    const schema = s.db.schemaVersion;
    s.memory.recordForgetBoundary("bot", "owner", Date.now() + 1);
    const coarse = s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all();
    s.db.close(); s = fixture(file);
    assert.equal(s.db.schemaVersion, schema, "new target metadata does not reset a current database");
    assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), coarse,
      "pre-existing coarse boundaries are preserved, never guessed away");
    assert.equal(s.history("HeliosCalibration"), "");
  } finally { s.db.close(); rmSync(root, { recursive: true, force: true }); }
});

await check("#41 global targeted removal preserves another Bot's private history", () => {
  const s = fixture();
  try {
    s.send("所有 Bot 记住 SharedFormat 是短句。");
    s.send("PrivateHelios 的常数是 23.75。", "peer");
    const atom = s.memory.create({ scopeType: "global", sourceType: "user", kind: "preference", title: "SharedFormat",
      content: "SharedFormat 是短句", metadata: { publicShared: true } });
    s.bridge.forget("owner", [atom.id], "忘记所有 Bot 的 SharedFormat 共享记忆。", "忘记所有 Bot 的 SharedFormat 共享记忆。");
    assert(s.history("PrivateHelios", "peer").includes("23.75"));
    assert(!s.history("SharedFormat").includes("短句"));
    assert.deepEqual(s.db.connection.prepare("SELECT * FROM memory_forget_watermarks").all(), []);
  } finally { s.db.close(); }
});

await check("#41 all eight scope filters and explicit whole-scope boundary", () => {
  const s = fixture();
  try {
    const withdrawals = new MemoryForgetWatermarks(s.db.connection);
    const turn: MemoryTurnDto = { id: "turn", taskId: "task", userText: "AsterPreference 是先画图；HeliosCalibration 是17.25。",
      assistantText: "AsterPreference 是先画图", capturedAt: 1, contentHash: "", extractionState: "pending", attemptCount: 0, metadata: {} };
    for (const scopeType of ["global", "workspace", "project", "task", "bot", "team", "conversation", "work"] as const) {
      const scopeId = scopeType === "global" ? undefined : "scope";
      withdrawals.withdraw([{ scopeType, scopeId }], ["AsterPreference"], 2);
      const allowed = withdrawals.newerSources(scopeType, scopeId, [turn]);
      assert.equal(allowed.length, 1);
      assert(allowed[0].userText.includes("17.25"));
      assert(!allowed[0].userText.includes("先画图") && !allowed[0].assistantText);
      assert.equal(withdrawals.candidateSources(scopeType, scopeId, [turn], "AsterPreference 是先画图").length, 0);
      assert.equal(withdrawals.candidateSources(scopeType, scopeId, [turn], "HeliosCalibration 是17.25").length, 1);
    }
    s.send("HeliosCalibration 是17.25。");
    s.send("忘记全部历史记忆。");
    assert(s.db.connection.prepare("SELECT 1 FROM memory_forget_watermarks WHERE scope_type='bot' AND scope_id='owner'").get());
    assert.equal(s.history("HeliosCalibration"), "");
    s.send("Forget all my memories.", "peer");
    assert(s.db.connection.prepare("SELECT 1 FROM memory_forget_watermarks WHERE scope_type='bot' AND scope_id='peer'").get());
    const earlier = s.send("记住同刻来源 A");
    const later = s.send("记住同刻来源 B");
    const tiedCutoff = Date.now() + 10000;
    for (const kind of ["target", "scope"] as const) {
      const put = (id: string) => kind === "target"
        ? withdrawals.withdraw([{ scopeType: "bot", scopeId: "owner" }], ["同刻来源"], tiedCutoff, id)
        : withdrawals.advance([{ scopeType: "bot", scopeId: "owner" }], tiedCutoff, id);
      put(later.userMessageId); put(earlier.userMessageId);
      const table = kind === "target" ? "memory_forget_targets" : "memory_forget_watermarks";
      const boundary = s.db.connection.prepare(`SELECT allowed_message_id FROM ${table} WHERE scope_type='bot' AND scope_id='owner' AND cutoff_at=?`)
        .get(tiedCutoff) as { allowed_message_id: string };
      assert.equal(boundary.allowed_message_id, later.userMessageId, "reverse completion cannot move a tied boundary backwards");
    }
  } finally { s.db.close(); }
});

await check("#42 lexical fallback preserves Unicode and punctuation normalization", () => {
  const s = fixture();
  try {
    const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "fact",
      title: "ＡＢＣ－１２３", content: "设备型号" });
    assert(s.memory.search({ botId: "owner", query: "abc123" }).some(hit => hit.memory.id === atom.id));
  } finally { s.db.close(); }
});

await check("#42 old L1 fact remains searchable beyond candidate windows", async () => {
  const s = fixture();
  try {
    const target = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "fact",
      title: "QZVXNEEDLE", content: "Calibration constant 17.25", importance: 0 });
    let size = 1;
    const insertBatch = (total: number) => s.db.connection.transaction(() => {
      const insert = s.db.connection.prepare(`INSERT INTO memory_records SELECT ?,kind,'Unrelated filler','Other content',status,
        3,confidence,explicit,source_type,source_id,source_task_id,valid_from,valid_until,content_hash,created_at,updated_at+1,
        last_recalled_at,recall_count,metadata_json FROM memory_records WHERE id=?`);
      const scope = s.db.connection.prepare("INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at) VALUES (?,?,'bot','owner','owned',?)");
      while (size < total) { const i = size++; const id = `filler-${i}`; insert.run(id, target.id); scope.run(`scope-${i}`, id, Date.now()); }
    })();
    for (const total of [600, 601, 1600, 1601, 1800, 1801, 2000, 2001, 5000, 10000]) {
      insertBatch(total);
      assert(s.memory.search({ botId: "owner", query: "QZVXNEEDLE", limit: 20 }).some(hit => hit.memory.id === target.id), `search at ${total}`);
      const hits = await s.bridge.search("owner", "QZVXNEEDLE");
      assert(hits.length <= 20 && hits.some(hit => hit.memory.id === target.id), `foreground hybrid at ${total}`);
    }
    assert(!(await s.bridge.search("peer", "QZVXNEEDLE")).length);
    s.memory.promote(target.id, "bot", "owner");
    assert.equal((await s.bridge.search("owner", "QZVXNEEDLE")).filter(hit => hit.memory.id === target.id).length, 1, "multiple bindings consume one result slot");
    assert((await s.bridge.search("owner", "QZ")).some(hit => hit.memory.id === target.id), "two-character queries use complete scoped lexical matching");
    const originalGet = s.memory.repository.get.bind(s.memory.repository);
    let expanded = 0, hydrationMs = 0;
    s.memory.repository.get = id => { const started = performance.now(); expanded++; const result = originalGet(id); hydrationMs += performance.now() - started; return result; };
    const samples: number[] = [];
    const before = process.memoryUsage();
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      assert((await s.bridge.search("owner", "QZVXNEEDLE")).some(hit => hit.memory.id === target.id));
      samples.push(performance.now() - started);
    }
    assert(expanded < 5000, `five queries discover and reauthorize bounded candidates rather than 10K DTOs per query: ${expanded}`);
    const where = memorySearchWhere({ scopes: [{ scopeType: "bot", scopeId: "owner" }] });
    const plan = s.db.connection.prepare(`EXPLAIN QUERY PLAN SELECT m.id,bm25(memory_fts,0.0,3.0,1.0) score FROM memory_fts
      JOIN memory_records m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND ${where.sql} ORDER BY score,m.id`)
      .all('"qzvxneedle" OR "qzv" OR "zvx" OR "vxn" OR "xne" OR "nee" OR "eed" OR "edl" OR "dle"', ...where.args);
    const q = "qzvxneedle";
    const grams = [q, ...Array.from({ length: q.length - 1 }, (_, i) => q.slice(i, i + 2))];
    const score = grams.map(() => "(CASE WHEN instr(m.title,?)>0 OR instr(m.content,?)>0 THEN 1 ELSE 0 END)").join("+");
    const lexicalPlan = s.db.connection.prepare(`EXPLAIN QUERY PLAN WITH searchable AS MATERIALIZED (
      SELECT m.id,m.importance,m.updated_at,memory_search_normalize(m.title) title,memory_search_normalize(m.content) content
      FROM memory_records m WHERE ${where.sql}
      ) SELECT m.id,(${score}) relevance,
      (CASE WHEN instr(m.title,?)>0 OR instr(m.content,?)>0 THEN 1 ELSE 0 END) exact
      FROM searchable m WHERE relevance>0
      ORDER BY exact DESC,relevance DESC,m.importance DESC,m.updated_at DESC,m.id`)
      .all(...where.args, ...grams.flatMap(gram => [gram, gram]), q, q);
    console.log("DIAGNOSTIC 10K lexical", JSON.stringify({ samplesMs: samples, expanded, hydrationMs, rssDelta: process.memoryUsage().rss - before.rss, plan, lexicalPlan }));

    const originalEmbed = SemanticRuntime.prototype.embed;
    const vector = new Float32Array(SEMANTIC_DIMENSION); vector[0] = 1;
    try {
      SemanticRuntime.prototype.embed = async () => vector;
      // Use real persisted vectors and the production provider; only embedding computation is controlled.
      s.db.connection.prepare(`INSERT INTO memory_embeddings(memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
        SELECT id,?,?,content_hash,?,?,? FROM memory_records WHERE id=?`)
        .run(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION, Buffer.from(vector.buffer), Date.now(), target.id);
      const semanticMemory = new MemoryService(s.db);
      const semanticHits = await semanticMemory.searchHybrid({ botId: "owner", query: "ZZYXYX", limit: 20 });
      assert(semanticHits.some(hit => hit.memory.id === target.id && hit.reasons.includes("semantic")), "old semantic-only candidate is discovered beyond every prior window");
      SemanticRuntime.prototype.embed = async () => { throw new SemanticUnavailableError("controlled unavailable runtime"); };
      assert((await semanticMemory.searchHybrid({ botId: "owner", query: "QZVXNEEDLE", limit: 20 })).some(hit => hit.memory.id === target.id));
      for (const mutation of ["delete", "detach", "update", "expire"] as const) {
        const candidate = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "fact", title: `semantic-${mutation}`, content: "old vector", sourceType: "user" });
        s.db.connection.prepare(`INSERT INTO memory_embeddings(memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(candidate.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, candidate.contentHash, SEMANTIC_DIMENSION, Buffer.from(vector.buffer), Date.now());
        const gate = deferred(), entered = deferred();
        SemanticRuntime.prototype.embed = async () => { entered.release(); await gate.promise; return vector; };
        const pending = semanticMemory.searchHybrid({ botId: "owner", query: "ZZYXYX", limit: 20 });
        await entered.promise;
        if (mutation === "delete") s.memory.forget(candidate.id);
        else if (mutation === "detach") s.memory.detachScope(candidate.id, "bot", "owner");
        else if (mutation === "update") s.memory.update({ id: candidate.id, content: "new revision" });
        else s.memory.update({ id: candidate.id, validUntil: Date.now() - 1 });
        gate.release();
        assert(!(await pending).some(hit => hit.memory.id === candidate.id), `${mutation} during embed cannot return a stale DTO`);
      }
      const late = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "fact", title: "late embedding", content: "withdrawn", sourceType: "user" });
      const gate = deferred(), entered = deferred();
      SemanticRuntime.prototype.embed = async () => { entered.release(); await gate.promise; return vector; };
      const indexing = new MemorySemanticProvider(s.db).index(late);
      await entered.promise;
      s.memory.forget(late.id); gate.release(); await indexing;
      assert(!s.db.connection.prepare("SELECT 1 FROM memory_embeddings WHERE memory_id=?").get(late.id), "late index writes cannot revive deleted memory");
    } finally { SemanticRuntime.prototype.embed = originalEmbed; }
    for (const mutation of ["delete", "detach", "update", "expire"] as const) {
      const word = `YieldNeedle${mutation}`;
      const atom = s.memory.create({ scopeType: "bot", scopeId: "owner", sourceType: "user", kind: "fact", title: word, content: "old batch value" });
      const change = new Promise<void>((resolve, reject) => setImmediate(() => {
        try {
          if (mutation === "delete") s.memory.forget(atom.id);
          else if (mutation === "detach") s.memory.detachScope(atom.id, "bot", "owner");
          else if (mutation === "update") s.memory.update({ id: atom.id, content: "replacement without the old value" });
          else s.memory.update({ id: atom.id, validUntil: Date.now() - 1 });
          resolve();
        } catch (error) { reject(error); }
      }));
      const pending = s.bridge.search("owner", word);
      await change;
      assert(!(await pending).some(hit => hit.memory.id === atom.id), `${mutation} during actual lexical pagination must withdraw cached hits`);
    }
    s.db.connection.exec("DROP TABLE memory_fts");
    assert((await s.bridge.search("owner", "QZVXNEEDLE")).some(hit => hit.memory.id === target.id), "an unavailable FTS index retains a complete lexical fallback");
  } finally { s.db.close(); }
});
assert.equal(failures, 0, `${failures} memory correctness checks failed`);
