import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

async function main() {
  const db = new AppDatabase(":memory:");
  try {
    const bots = new BotRegistry(db.connection);
    for (const id of ["alice", "bob"]) bots.registerBot({ botId: id, userId: LOCAL_USER_ID, displayName: id });
    bots.registerBot({ botId: "foreign", userId: "another-user", displayName: "foreign" });
    const memory = new MemoryService(db, { semantic: false });
    const insertCandidate = memory.repository.insertCandidate.bind(memory.repository);
    memory.repository.insertCandidate = candidate => {
      if (candidate.scopeType === "bot") assert(db.connection.inTransaction, "Bot candidate lifecycle must be atomic, never leaving a crash-time approval row");
      return insertCandidate(candidate);
    };
    const pipeline = new MemoryPipelineManager(db);
    const messages = new BotConversationRepository(db.connection);
    let enabled = true, sequence = 0, modelCalls = 0;
    let candidates: unknown[] = [];
    let held: Promise<void> | undefined;
    const runtime = { completeSimple: async (_: unknown, input: { messages: Array<{ content: string }> }) => {
      modelCalls++;
      const payload = JSON.parse(input.messages[0].content);
      assert(!JSON.stringify(payload).includes("UNSUPPORTED_ASSISTANT"));
      await held;
      return { content: [{ type: "text", text: JSON.stringify({ candidates }) }], stopReason: "stop" };
    } } as unknown as ModelRuntime;
    const bridge = new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory, pipeline, enabled: () => enabled,
      changed: () => {}, extract: async id => {
        const turns = pipeline.turns.listPending(id);
        pipeline.beginL1(turns);
        const isEnabled = () => enabled && pipeline.turns.canExtractTask(id) && pipeline.turns.allExist(turns.map(turn => turn.id));
        const result = await memory.extractAndStore({ taskId: id, userText: turns.at(-1)?.userText ?? "", assistantText: "",
          sourceTurns: turns, modelRuntime: runtime, model: { maxTokens: 4096 } as never, isEnabled });
        assert.equal(result.reviewCount, 0);
        if (isEnabled()) pipeline.completeL1(id, turns);
      } });
    const send = (text: string, botId = "alice", status: "completed" | "cancelled" | "running" = "completed") => {
      const receipt = messages.accept(LOCAL_USER_ID, { botId, requestId: `request-${++sequence}`, text });
      messages.update(receipt.assistantMessageId, status, "UNSUPPORTED_ASSISTANT: 我猜用户住在上海");
      return { receipt, source: bridge.capture(botId, receipt.requestId) };
    };
    const candidate = (content: string, quote: string, patch: Record<string, unknown> = {}) => ({ kind: "preference", title: "回复语言",
      content, userEvidence: quote, retention: "stable", sensitivity: "none", scopeType: "global", confidence: 0.99, importance: 2, explicit: true, operationHint: "create", ...patch });
    const first = send("记住：以后请用中文简短回答。");
    assert(first.source); assert.equal(db.getTask(first.source), undefined, "no fake Task row");
    assert(pipeline.turns.canExtractTask(first.source));
    assert.equal(pipeline.turns.listByTask(first.source)[0].userText, "", "L0 stores a verified source pointer, not copied user text");
    candidates = [candidate("以后用中文简短回答。", "以后请用中文简短回答")];
    await bridge.extract(first.source);
    assert.equal(bridge.capture("alice", first.receipt.requestId), undefined, "completed-turn replay is idempotent");
    assert.equal(modelCalls, 1);
    const atoms = memory.listExactScope("bot", "alice");
    assert.equal(atoms.length, 1); assert.equal(memory.listExactScope("global").length, 0);
    assert(atoms[0].evidence.some(e => e.evidenceKind === "conversation"));
    assert(!JSON.stringify(atoms).includes("UNSUPPORTED_ASSISTANT"));
    assert(bridge.context("alice", first.source).includes("中文简短"), "automatic active L1 recall");
    assert.equal(bridge.search("bob", "中文").length, 0); assert.equal(bridge.search("foreign", "中文").length, 0);
    assert.equal(bridge.context("bob", first.source), "", "conversation belongs to Bot + user");
    messages.archive(LOCAL_USER_ID, "alice", first.source);
    const second = send("你好"); assert(second.source && second.source !== first.source);
    assert(bridge.context("alice", second.source).includes("中文简短"), "new chat retains private Bot memory");
    for (const text of ["我的密码是 12345，记住我喜欢绿茶。", "这次病历诊断为某病。", "不要保存这条消息", "passport number is X12345", "I have diabetes", "I take insulin", "123-45-6789", "4111 1111 1111 1111"]) {
      assert.equal(send(text).source, undefined, "sensitive/opt-out source is not copied into L0");
    }
    assert.equal(send("记住我喜欢咖啡", "alice", "cancelled").source, undefined);
    assert.equal(send("记住我喜欢茶", "alice", "running").source, undefined);
    enabled = false;
    assert.equal(bridge.context("alice", second.source), ""); assert.equal(bridge.search("alice", "中文").length, 0);
    assert.equal(send("记住我的猫叫小白").source, undefined);
    enabled = true;
    candidates = [candidate("用户住在上海", "助手猜的", { title: "居住地" }), candidate("当前天气晴", "你好", { kind: "progress" }),
      candidate("喜欢橙色", "你好", { retention: "temporary" }),
      candidate("喜欢粉色", "你好", { replaces: "api_key_hidden_should_not_persist" })];
    await bridge.extract(second.source);
    assert.equal(memory.listExactScope("bot", "alice").length, 1, "unsupported/ephemeral facts never commit");
    assert.equal(memory.listCandidates("needs_review").length, 0, "no new Bot approval workflow");
    assert(!JSON.stringify(memory.listCandidates()).includes("api_key_hidden_should_not_persist"));
    const corrected = send("修正：以后请用英文简短回答，不再用中文。"); assert(corrected.source);
    candidates = [candidate("以后用英文简短回答。", "以后请用英文简短回答", { operationHint: "supersede", replaces: "回复语言" })];
    await bridge.extract(corrected.source);
    assert.equal(memory.listExactScope("bot", "alice").filter(atom => atom.status === "active").length, 1);
    assert(bridge.context("alice", corrected.source).includes("英文简短"));
    assert(!bridge.context("alice", corrected.source).includes("以后用中文简短回答"));
    const other = send("记住：以后请用日文简短回答。", "bob"); assert(other.source);
    candidates = [candidate("以后用日文简短回答。", "以后请用日文简短回答")]; await bridge.extract(other.source);
    const erase = send("忘记我的回复语言偏好。"); assert(erase.source);
    candidates = [candidate("删除回复语言偏好", "忘记我的回复语言偏好", { operationHint: "forget", replaces: "回复语言" })];
    await bridge.extract(erase.source);
    const correctedAtom = memory.listExactScope("bot", "alice").find(atom => atom.status === "active")!;
    assert(correctedAtom, "post-reply extractor must not repeat a fuzzy forget mutation");
    bridge.forget("alice", [correctedAtom.id], "忘记我的回复语言偏好。", "忘记我的回复语言偏好");
    assert.equal(memory.listExactScope("bot", "alice").filter(atom => atom.status === "active").length, 0);
    assert(bridge.context("bob", other.source).includes("日文简短"), "forget cannot delete another Bot's same-title fact");
    const bobAtom = memory.listExactScope("bot", "bob")[0];
    assert.throws(() => bridge.forget("alice", [bobAtom.id], "忘记回复语言", "忘记回复语言"), /其他范围/);
    assert.throws(() => bridge.forget("bob", [bobAtom.id], "今天聊什么", "忘记回复语言"), /当前用户/);
    assert.throws(() => bridge.forget("bob", [bobAtom.id], "不要忘记回复语言", "忘记回复语言"), /当前用户/);
    assert(memory.get(bobAtom.id), "rejected forget must preserve the record");
    assert.equal(bridge.forget("bob", [bobAtom.id], "忘记回复语言", "忘记回复语言").forgottenCount, 1);
    assert.equal(bridge.forget("bob", [bobAtom.id], "忘记回复语言", "忘记回复语言").alreadyAbsentCount, 1);
    assert(!memory.get(bobAtom.id), "successful foreground forget has a durable receipt");
    memory.forget(atoms[0].id);
    assert(!bridge.context("alice", second.source).includes("中文简短"), "deletion affects next provider context");
    const pending = send("记住我喜欢蓝色"); assert(pending.source);
    candidates = [candidate("喜欢蓝色", "我喜欢蓝色", { title: "颜色" })];
    let release!: () => void; held = new Promise(resolve => { release = resolve; });
    const beforePendingCalls = modelCalls;
    const running = bridge.extract(pending.source);
    while (modelCalls === beforePendingCalls) await new Promise(resolve => setTimeout(resolve, 1));
    pipeline.turns.deleteMany(pipeline.turns.listByTask(pending.source).map(turn => turn.id));
    release(); await running; held = undefined;
    assert.equal(memory.listExactScope("bot", "alice").length, 0, "deleted in-flight source cannot resurrect memory");
    const final = send("记住我喜欢绿色"); assert(final.source);
    candidates = [candidate("喜欢绿色", "我喜欢绿色", { title: "颜色", scopeType: "bot" })]; await bridge.extract(final.source);
    assert.equal(memory.listExactScope("bot", "alice").length, 1);
    const priorAtom = memory.listExactScope("bot", "alice")[0];
    const forgotten = send("记住我喜欢绿色"); assert(forgotten.source);
    const beforeDeleteCalls = modelCalls;
    held = new Promise(resolve => { release = resolve; });
    const deleteRace = bridge.extract(forgotten.source);
    while (modelCalls === beforeDeleteCalls) await new Promise(resolve => setTimeout(resolve, 1));
    memory.forget(priorAtom.id);
    release(); await deleteRace; held = undefined;
    assert.equal(memory.listExactScope("bot", "alice").length, 0, "L1 deletion invalidates in-flight extraction of the deleted fact");
    pipeline.turns.deleteAll();
    assert.equal(memory.listExactScope("bot", "alice").length, 0);
    assert.equal(pipeline.turns.listByTask(final.source).length, 0);
    assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    console.log("PASS Bot memory: real-source L0/L1, private scope, recall, new chat, replay, source deletion race, disabled/cancelled/sensitive boundaries, no approval queue, existing memory deletion");
  } finally { db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
