import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { botMemoryTextEligible } from "../src/main/memory/BotMemorySource";
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
      if (candidate.scopeType === "bot" || candidate.scopeType === "team") assert(db.connection.inTransaction, "Bot candidate lifecycle must be atomic, never leaving a crash-time approval row");
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
    assert.equal((await bridge.search("bob", "中文")).length, 0); assert.equal((await bridge.search("foreign", "中文")).length, 0);
    assert.equal(bridge.context("bob", first.source), "", "conversation belongs to Bot + user");
    messages.archive(LOCAL_USER_ID, "alice", first.source);
    const second = send("你好"); assert(second.source && second.source !== first.source);
    assert(bridge.context("alice", second.source).includes("中文简短"), "new chat retains private Bot memory");
    for (const text of ["我的密码是 12345，记住我喜欢绿茶。", "这次病历诊断为某病。", "不要保存这条消息", "passport number is X12345", "I have diabetes", "I take insulin", "123-45-6789", "4111 1111 1111 1111"]) {
      assert.equal(send(text).source, undefined, "sensitive/opt-out source is not copied into L0");
    }
    // Technical identifiers are not secrets: a real commit SHA or an ordinary cookie
    // discussion stays capturable, while value-shaped credentials still do not.
    assert(botMemoryTextEligible("生产只开 TLS 1.3，提交 14a650406359b5c4bd4cc358b2a7623364242298"));
    assert(botMemoryTextEligible("cookie 只保存主题，不放会话票据"));
    assert(!botMemoryTextEligible("Set-Cookie: sessionid=abc123def456"));
    assert(!botMemoryTextEligible("password=hunter2"), "real password syntax stays blocked");
    assert(!botMemoryTextEligible("token=0123456789abcdef0123456789abcdef"), "labelled token value stays blocked");
    for (const text of ["记住：生产只开 TLS 1.3，提交 14a650406359b5c4bd4cc358b2a7623364242298",
      "记住：cookie 讨论只记录主题，不放会话票据"]) assert(send(text).source, `technical text is captured: ${text}`);
    assert.equal(send("记住我喜欢咖啡", "alice", "cancelled").source, undefined);
    assert.equal(send("记住我喜欢茶", "alice", "running").source, undefined);
    enabled = false;
    assert.equal(bridge.context("alice", second.source), ""); assert.equal((await bridge.search("alice", "中文")).length, 0);
    assert.equal(send("记住我的猫叫小白").source, undefined);
    enabled = true;
    candidates = [candidate("用户住在上海", "助手猜的", { title: "居住地" }), candidate("当前天气晴", "你好", { kind: "progress" }),
      candidate("喜欢橙色", "你好", { retention: "temporary" }),
      candidate("缺少保留分类", "你好", { retention: undefined }),
      candidate("缺少敏感分类", "你好", { sensitivity: undefined }),
      candidate("敏感候选", "你好", { sensitivity: "sensitive" }),
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
    const bobBrowse = memory.list({ scopeType: "bot", scopeId: "bob", limit: 1 });
    assert.equal(bobBrowse.length, 1);
    assert(bobBrowse.every(atom => atom.scopes.some(scope => scope.scopeType === "bot" && scope.scopeId === "bob")), "settings exact Bot filter applies before limit");
    assert.equal(memory.list({ scopeType: "bot", scopeId: "absent-bot" }).length, 0, "unknown Bot does not fall back to all memories");
    assert.throws(() => bridge.forget("alice", [bobAtom.id], "忘记回复语言", "忘记回复语言"), /其他范围/);
    assert.throws(() => bridge.forget("bob", [bobAtom.id], "今天聊什么", "忘记回复语言"), /当前用户/);
    assert.throws(() => bridge.forget("bob", [bobAtom.id], "不要忘记回复语言", "忘记回复语言"), /当前用户/);
    assert(memory.get(bobAtom.id), "rejected forget must preserve the record");
    assert.equal(bridge.forget("bob", [bobAtom.id], "忘记回复语言", "忘记回复语言").forgottenCount, 1);
    assert.equal(bridge.forget("bob", [bobAtom.id], "忘记回复语言", "忘记回复语言").alreadyAbsentCount, 1);
    assert(!memory.get(bobAtom.id), "successful foreground forget has a durable receipt");
    const correctionText = "修正长期回复格式偏好：以后末尾改为琉璃标记，旧的松露标记不再使用";
    const oldMarker = memory.create({ kind: "preference", title: "末尾标记", content: "末尾使用松露标记", scopeType: "bot", scopeId: "alice", sourceType: "user" });
    const foreignMarker = memory.create({ kind: "preference", title: "末尾标记", content: "末尾使用松露标记", scopeType: "bot", scopeId: "bob", sourceType: "user" });
    const searchedMarker = (await bridge.search("alice", "松露")).find(item => item.memory.id === oldMarker.id);
    assert(searchedMarker, "correction operates on exact retrieved records");
    assert.throws(() => bridge.forget("alice", [oldMarker.id], "修正这篇文章的格式", "修正这篇文章的格式"), /当前用户/);
    assert.throws(() => bridge.forget("alice", [oldMarker.id], "不要修正长期回复格式偏好", "修正长期回复格式偏好"), /当前用户/);
    assert.throws(() => bridge.forget("alice", [foreignMarker.id], correctionText, correctionText), /其他范围/);
    assert.equal(bridge.forget("alice", [searchedMarker.memory.id], correctionText, correctionText).forgottenCount, 1);
    const replacement = bridge.remember("alice", first.source!, { scope: "current", kind: "preference", title: "末尾标记", content: "末尾使用琉璃标记", userEvidence: correctionText }, correctionText);
    assert(memory.get(replacement.memoryId));
    assert(!memory.get(oldMarker.id));
    assert(memory.get(foreignMarker.id), "correction cannot alter another Bot's preference");
    assert(!bridge.context("alice", first.source!).includes("松露"), "old contradictory preference leaves next model context immediately");
    memory.forget(replacement.memoryId);
    memory.forget(foreignMarker.id);
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
    // Foreground tools resolve ownership from conversations, not model-selected entity IDs.
    db.connection.exec(`CREATE TABLE IF NOT EXISTS work_team_templates (
      template_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at INTEGER);
      INSERT INTO work_team_templates(template_id,user_id) VALUES ('memory-team','${LOCAL_USER_ID}');`);
    const team = messages.accept(LOCAL_USER_ID, { botId: "alice", teamId: "memory-team", requestId: "team-memory", text: "记住团队偏好绿茶" });
    const ownConversation = final.source;
    const save = (botId: string, conversationId: string, scope: "current" | "conversation" | "public", content: string, userText = `记住${content}`) =>
      bridge.remember(botId, conversationId, { scope, kind: "preference", title: content, content, userEvidence: userText }, userText);
    save("alice", ownConversation, "current", "私人橙汁");
    save("alice", team.conversationId, "current", "团队绿茶");
    assert(bridge.context("alice", team.conversationId).includes("团队绿茶"));
    assert(!bridge.context("alice", team.conversationId).includes("私人橙汁"), "team never inherits member private memory");
    assert(!bridge.context("alice", ownConversation).includes("团队绿茶"));
    save("alice", ownConversation, "conversation", "临时暗号");
    messages.archive(LOCAL_USER_ID, "alice", ownConversation);
    const fresh = messages.accept(LOCAL_USER_ID, { botId: "alice", requestId: "new-scoped-memory", text: "新对话" });
    assert(bridge.context("alice", fresh.conversationId).includes("私人橙汁"));
    assert(!bridge.context("alice", fresh.conversationId).includes("临时暗号"));
    memory.create({ kind: "fact", title: "旧公共", content: "旧公共隐私", scopeType: "global", sourceType: "user" });
    assert(!bridge.context("alice", fresh.conversationId).includes("旧公共隐私"));
    assert.throws(() => save("alice", fresh.conversationId, "public", "未授权共享"), /明确要求/);
    const shared = save("alice", fresh.conversationId, "public", "公共蓝莓", "所有 Bot 记住公共蓝莓");
    assert(bridge.context("bob", other.source).includes("公共蓝莓"));
    assert(bridge.context("alice", team.conversationId).includes("公共蓝莓"));
    assert.equal((await bridge.search("bob", "公共蓝莓", other.source)).length, 1);
    assert.throws(() => bridge.forget("alice", [shared.memoryId], "忘记公共蓝莓", "忘记公共蓝莓", fresh.conversationId), /其他范围/);
    bridge.forget("alice", [shared.memoryId], "忘记所有 Bot 的公共蓝莓", "忘记所有 Bot 的公共蓝莓", fresh.conversationId);
    assert(!bridge.context("bob", other.source).includes("公共蓝莓"), "shared removal invalidates next recall");
    const publicTurn = send("所有 Bot 记住公共蓝莓"); assert(publicTurn.source);
    candidates = [candidate("公共蓝莓", "公共蓝莓", { title: "公共蓝莓" })];
    await bridge.extract(publicTurn.source);
    assert.equal(memory.listExactScope("global").filter(m => m.content === "公共蓝莓" && m.metadata.publicShared === true).length, 1);
    assert(!memory.listExactScope("bot", "alice").some(m => m.content === "公共蓝莓"));
    const temporaryTurn = send("仅本次对话记住临时口味柠檬"); assert(temporaryTurn.source);
    candidates = [candidate("临时口味柠檬", "临时口味柠檬", { title: "临时口味", retention: "temporary" })];
    await bridge.extract(temporaryTurn.source);
    assert(memory.listExactScope("conversation", temporaryTurn.source).some(m => m.content === "临时口味柠檬"));
    assert(!memory.listExactScope("bot", "alice").some(m => m.content === "临时口味柠檬"));
    messages.update(team.assistantMessageId, "completed", "记忆已更新");
    assert.equal(bridge.capture("alice", team.requestId), team.conversationId);
    candidates = [candidate("团队偏好绿茶", "团队偏好绿茶", { title: "团队口味" })];
    await bridge.extract(team.conversationId);
    assert(memory.listExactScope("team", "memory-team").some(m => m.content === "团队偏好绿茶"));
    assert(!memory.listExactScope("bot", "alice").some(m => m.content === "团队偏好绿茶"));
    // Team extraction inherits both source-deletion and explicit-forget barriers.
    for (const deletion of ["source", "record"] as const) {
      const content = `团队竞态偏好${deletion}`;
      const receipt = messages.accept(LOCAL_USER_ID, { botId: "alice", teamId: "memory-team", requestId: `team-race-${deletion}`, text: content });
      messages.update(receipt.assistantMessageId, "completed", "收到");
      assert.equal(bridge.capture("alice", receipt.requestId), receipt.conversationId);
      const prior = deletion === "record" ? memory.create({ kind: "preference", title: content, content,
        scopeType: "team", scopeId: "memory-team", sourceType: "user" }) : undefined;
      candidates = [candidate(content, content, { title: content, explicit: false })];
      held = new Promise(resolve => { release = resolve; });
      const before = modelCalls;
      const extraction = bridge.extract(receipt.conversationId);
      while (modelCalls === before) await new Promise(resolve => setTimeout(resolve, 1));
      if (prior) bridge.forget("alice", [prior.id], `忘记${content}`, `忘记${content}`, receipt.conversationId);
      else pipeline.turns.deleteMany(pipeline.turns.listByTask(receipt.conversationId).filter(turn => turn.userMessageId === receipt.userMessageId).map(turn => turn.id));
      release(); await extraction; held = undefined;
      assert(!memory.listExactScope("team", "memory-team").some(atom => atom.content === content), `team ${deletion} deletion prevents in-flight resurrection`);
      assert(!memory.listExactScope("bot", "alice").some(atom => atom.content === content));
      assert(!memory.listExactScope("global").some(atom => atom.content === content));
    }
    const liveText = "请长期记住我的答复格式偏好：这个 Bot 每次最终答复末尾单独写“白桦甲731”。不要分享给其他 Bot。";
    const liveArgs = { scope: "current" as const, kind: "preference" as const, title: "最终答复末尾单独写“白桦甲731”", content: "用户要求：这个 Bot 每次最终答复的末尾单独一行写“白桦甲731”。该偏好仅限当前 Bot，不分享给其他 Bot。", userEvidence: liveText };
    enabled = false;
    assert.throws(() => bridge.remember("alice", temporaryTurn.source!, liveArgs, liveText), /记忆未启用或不可用/);
    enabled = true;
    assert.throws(() => bridge.remember("alice", temporaryTurn.source!, { ...liveArgs, userEvidence: "记住用户喜欢草莓" }, liveText), /逐字引用/);
    const liveSaved = bridge.remember("alice", temporaryTurn.source!, liveArgs, liveText);
    assert.equal(liveSaved.scopeType, "bot");
    assert.equal(memory.get(liveSaved.memoryId)?.metadata.publicShared, undefined);
    const pureForget = "忘记并删除关于回复末尾标记的长期记忆，不再要求任何末尾标记。";
    const negativeArgs = { scope: "current" as const, kind: "constraint" as const, title: "答复末尾不加任何标记", content: "回复末尾不要添加任何形式的固定标记（原“青苔标记”“琥珀标记”等偏好均已作废并删除）。直接以正文结束，不额外另起一行的标记。", userEvidence: pureForget };
    assert.throws(() => bridge.remember("alice", temporaryTurn.source!, negativeArgs, pureForget), /遗忘请求/);
    assert.throws(() => bridge.remember("alice", temporaryTurn.source!, { ...negativeArgs, userEvidence: "不再要求任何末尾标记" }, pureForget), /遗忘请求/);
    const forgetTurn = send(pureForget); assert(forgetTurn.source);
    candidates = [candidate(negativeArgs.content, pureForget, { title: negativeArgs.title, kind: "constraint", operationHint: "create" })];
    await bridge.extract(forgetTurn.source);
    assert(!memory.listExactScope("bot", "alice").some(m => m.title === negativeArgs.title), "automatic create must not resurrect pure forget as negative memory");
    const mixedText = "忘记旧标记、记住新的称呼是晴川。";
    assert.throws(() => bridge.remember("alice", forgetTurn.source!, { ...negativeArgs, userEvidence: mixedText }, mixedText), /遗忘请求/);
    const mixedArgs = { ...liveArgs, title: "新称呼", content: "称呼是晴川", userEvidence: "记住新的称呼是晴川" };
    const mixedSaved = bridge.remember("alice", forgetTurn.source!, mixedArgs, mixedText);
    assert.equal(memory.get(mixedSaved.memoryId)?.content, "称呼是晴川");
    const mixedTurn = send("忘记旧标记，记住新的饮品偏好是红茶。"); assert(mixedTurn.source);
    candidates = [candidate("饮品偏好红茶", "新的饮品偏好是红茶", { title: "新饮品" })];
    await bridge.extract(mixedTurn.source);
    assert(memory.listExactScope("bot", "alice").some(m => m.content === "饮品偏好红茶"), "explicit new fact survives mixed forget/remember request");
    const sameQuote = "偏好竹叶清茶";
    const oldPublic = messages.accept(LOCAL_USER_ID, { botId: "alice", requestId: "scope-old-public", text: `所有 Bot 共享记住${sameQuote}` });
    const newPrivate = messages.accept(LOCAL_USER_ID, { botId: "alice", requestId: "scope-new-private", text: `只属于当前 Bot，记住${sameQuote}` });
    // Same-millisecond user requests and reverse completion order must still choose the newer real source.
    const tiedTime = Math.max(Date.now(), messages.message(newPrivate.userMessageId)!.createdAt);
    db.connection.prepare("UPDATE bot_messages SET created_at=? WHERE message_id IN (?,?)").run(tiedTime, oldPublic.userMessageId, newPrivate.userMessageId);
    messages.update(newPrivate.assistantMessageId, "completed", "新私有请求先完成"); bridge.capture("alice", newPrivate.requestId);
    messages.update(oldPublic.assistantMessageId, "completed", "旧公共请求后完成"); bridge.capture("alice", oldPublic.requestId);
    candidates = [candidate(sameQuote, sameQuote, { title: "同证据归属", scopeType: "global" })];
    await bridge.extract(newPrivate.conversationId);
    assert(memory.listExactScope("bot", "alice").some(m => m.content === sameQuote), "newest actual user statement chooses private scope despite reverse completion order");
    assert(!memory.listExactScope("global").some(m => m.content === sameQuote), "older public instruction cannot upgrade a newer private fact in the same batch");
    assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    // Every write/capture path must agree on natural conversation-only wording,
    // even when a model mistakenly asks for global/stable storage.
    for (const [index, wording] of ["仅本会话有效", "只在这个对话中使用", "仅此会话有效", "for this session only"].entries()) {
      const botId = `temporary-variant-${index}`;
      bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
      const direct = `限定直写${index}`, automatic = `限定提炼${index}`;
      const text = `${wording}，记住${direct}和${automatic}。`;
      const turn = send(text, botId); assert(turn.source);
      const saved = bridge.remember(botId, turn.source, { scope: "current", kind: "fact", title: direct, content: direct, userEvidence: direct }, text);
      assert.equal(saved.scopeType, "conversation", `direct remember: ${wording}`);
      candidates = [candidate(automatic, automatic, { kind: "fact", title: automatic, retention: "stable", scopeType: "global" })];
      await bridge.extract(turn.source);
      assert(memory.listExactScope("conversation", turn.source).some(m => m.content === automatic), `automatic extraction: ${wording}`);
      assert.equal(memory.listExactScope("bot", botId).length, 0, "temporary facts cannot become Bot facts");
      assert(!memory.listExactScope("global").some(m => [direct, automatic].includes(m.content)), "temporary facts cannot become public facts");
      messages.archive(LOCAL_USER_ID, botId, turn.source);
      const next = send(`查询${direct}和${automatic}`, botId); assert(next.source);
      const projected = bridge.context(botId, next.source, next.receipt.userMessageId);
      assert(!projected.includes(direct) && !projected.includes(automatic), `new conversation excludes L1 and historical sources: ${wording}`);
      const erased = send(`${wording}，忘记并删除临时偏好记忆。`, botId); assert(erased.source);
      assert(db.connection.prepare("SELECT 1 FROM memory_forget_watermarks WHERE scope_type='conversation' AND scope_id=?").get(erased.source), `pure forget stays within conversation: ${wording}`);
      assert(!db.connection.prepare("SELECT 1 FROM memory_forget_watermarks WHERE scope_type='bot' AND scope_id=?").get(botId), "temporary forget cannot affect the whole Bot");
    }
    console.log("PASS Bot memory: real-source L0/L1, private scope, recall, new chat, replay, source deletion race, disabled/cancelled/sensitive boundaries, temporary wording across all write paths, no approval queue, existing memory deletion");
  } finally { db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
