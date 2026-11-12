import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { botMemoryTextEligible } from "../src/main/memory/BotMemorySource";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { GatewayBotOrigin } from "../src/main/agent/work/BotTurnOrigins";

async function main() {
  const db = new AppDatabase(":memory:");
  try {
    const bots = new BotRegistry(db.connection);
    for (const id of ["alice", "bob"]) bots.registerBot({ botId: id, userId: LOCAL_USER_ID, displayName: id });
    bots.registerBot({ botId: "foreign", userId: "another-user", displayName: "foreign" });
    const works = new WorkService(db.connection,{bots});
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
    const send = (text: string, botId = "alice", status: "completed" | "cancelled" | "running" = "completed", origin?: GatewayBotOrigin) => {
      const receipt = db.connection.transaction(() => {
        const conversationId = origin ? messages.origins.gatewayConversation(LOCAL_USER_ID, botId, origin) : undefined;
        const accepted = messages.accept(LOCAL_USER_ID, { botId, requestId: `request-${++sequence}`, text, conversationId });
        if (origin) messages.origins.recordGateway(LOCAL_USER_ID, accepted, origin);
        return accepted;
      })();
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
    db.connection.prepare(`INSERT INTO work_team_templates(template_id,user_id,operation_id,request_hash,name,plan_json,created_at)
      VALUES ('memory-team',?,'memory-team','fixture','Memory team','{}',?)`).run(LOCAL_USER_ID,Date.now());
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
      assert(db.connection.prepare("SELECT 1 FROM memory_forget_targets WHERE scope_type='conversation' AND scope_id=?").get(erased.source), `targeted forget stays within conversation: ${wording}`);
      assert(!db.connection.prepare("SELECT 1 FROM memory_forget_watermarks WHERE scope_type='bot' AND scope_id=?").get(botId), "temporary forget cannot affect the whole Bot");
    }
    // ── Review follow-up: kernel L1 uses the same technical/secret boundary ────────
    const sha = "14a650406359b5c4bd4cc358b2a7623364242298";
    const shaRecord = memory.create({ kind: "fact", title: "生产只开 TLS 1.3", content: `提交 ${sha}`,
      scopeType: "bot", scopeId: "alice", sourceType: "user", explicit: true });
    assert(shaRecord.content.includes(sha), "direct remember keeps a full Git SHA");
    const cookieRecord = memory.create({ kind: "decision", title: "cookie 讨论", content: "cookie 只保存主题，不放会话票据",
      scopeType: "bot", scopeId: "alice", sourceType: "user", explicit: true });
    assert(cookieRecord.title.includes("cookie"), "ordinary cookie terminology is not a secret in L1");
    assert.throws(() => memory.create({ kind: "fact", title: "密码", content: "password=hunter2",
      scopeType: "bot", scopeId: "alice", sourceType: "user" }), /敏感/);
    // Extraction keeps the same text (candidate level) and the saved record is recallable.
    const keep = send("记住：发布说明要带上提交 14a650406359b5c4bd4cc358b2a7623364242298"); assert(keep.source);
    candidates = [candidate(`发布说明附提交 ${sha}`, "发布说明要带上提交", { kind: "fact", title: "发布说明" })];
    await bridge.extract(keep.source);
    assert(memory.listExactScope("bot", "alice").some(record => record.content.includes(sha)),
      "extraction no longer drops a candidate that quotes a Git SHA");
    assert((await bridge.search("alice", "发布说明")).some(hit => hit.memory.content.includes(sha)),
      "hybrid search finds the saved SHA fact");
    assert((await bridge.search("alice", "TLS 1.3")).some(hit => hit.memory.id === shaRecord.id),
      "a directly remembered technical fact is recallable through the same hybrid entry");
    assert((await bridge.search("alice", "cookie 主题")).some(hit => hit.memory.id === cookieRecord.id),
      "a cookie terminology record is recallable, not silently dropped");
    candidates = [candidate("api_key=sk_live_abcdefghijklmnop", "api_key", { kind: "fact", title: "密钥" })];
    const secretTurn = send("记住这个配置入口"); assert(secretTurn.source);
    await bridge.extract(secretTurn.source);
    assert(!memory.listExactScope("bot", "alice").some(record => record.content.includes("sk_live")),
      "extraction still drops a real credential");

    // ── Review follow-up: peer prefetch is re-authorized per evidence rebuild ─────
    const revisable = memory.create({ kind: "fact", title: "Peer revisable fact", content: "PEER_REVISABLE_VALUE",
      scopeType: "bot", scopeId: "alice", sourceType: "user" });
    memory.promote(revisable.id, "bot", "bob");
    assert(bridge.activeFact("alice", revisable.id), "current scope may read the hit");
    assert(bridge.activeFact("bob", revisable.id), "the other bound scope may read the same record");
    memory.detachScope(revisable.id, "bot", "alice");
    assert.equal(bridge.activeFact("alice", revisable.id), undefined, "scope detach withdraws the cached hit");
    assert(bridge.activeFact("bob", revisable.id), "another still-bound scope keeps its own access");
    const expiring = memory.create({ kind: "fact", title: "Peer expiring fact", content: "PEER_EXPIRING_VALUE",
      scopeType: "bot", scopeId: "alice", sourceType: "user", validUntil: Date.now() - 1000 });
    assert.equal(bridge.activeFact("alice", expiring.id), undefined, "an expired record cannot be injected");
    const future = memory.create({ kind: "fact", title: "Peer future fact", content: "PEER_FUTURE_VALUE",
      scopeType: "bot", scopeId: "alice", sourceType: "user", validFrom: Date.now() + 60_000 });
    assert.equal(bridge.activeFact("alice", future.id), undefined, "a not-yet-valid record cannot be injected");
    // Normal technical identifiers must survive the entire L1 path, not only capture.
    for (const [index, content] of ["生产只开 TLS 1.3", "生产只开 TLS 1.3，提交 14a650406359b5c4bd4cc358b2a7623364242298", "cookie 只保存主题，不放会话票据"].entries()) {
      const botId = `technical-${index}`;
      bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
      const directBot = `${botId}-direct`;
      bots.registerBot({ botId: directBot, userId: LOCAL_USER_ID, displayName: directBot });
      const directTurn = send(`记住：${content}`, directBot); assert(directTurn.source);
      const direct = bridge.remember(directBot, directTurn.source, { scope: "current", kind: "fact", title: "技术直写", content, userEvidence: content }, `记住：${content}`);
      const turn = send(`记住：${content}`, botId); assert(turn.source);
      assert.equal(memory.get(direct.memoryId)?.content, content);
      messages.archive(LOCAL_USER_ID, directBot, directTurn.source);
      const nextDirect = send("请回忆技术决定", directBot); assert(nextDirect.source);
      assert((await bridge.search(directBot, index === 2 ? "cookie" : "TLS", nextDirect.source)).some(hit => hit.memory.id === direct.memoryId), "direct remember survives a new conversation");
      candidates = [candidate(content, content, { title: "技术提炼", kind: "fact", scopeType: "bot" })];
      await bridge.extract(turn.source);
      assert(memory.listExactScope("bot", botId).some(m => m.title === "技术提炼" && m.content === content), "background extraction commits the same safe fact");
      messages.archive(LOCAL_USER_ID, botId, turn.source);
      const next = send("请回忆技术决定", botId); assert(next.source);
      const recalled = await bridge.search(botId, index === 2 ? "cookie" : "TLS", next.source);
      assert(recalled.some(hit => hit.memory.content === content), "new conversation recalls persisted technical content");
    }
    for (const text of ["Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz", "请求头：Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz", "header\nCookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz", 'curl -H "Cookie: sid=FAKE_REVIEW_ONLY_abcdEFGHxyz"', '{"Cookie": "sid=FAKE_REVIEW_ONLY_abcdEFGHxyz"}']) {
      assert(!botMemoryTextEligible(text));
      assert.equal(send(text).source, undefined);
      assert.throws(() => memory.create({ kind: "fact", title: "unsafe fixture", content: text, scopeType: "bot", scopeId: "alice", sourceType: "user" }), /敏感秘密/);
    }
    bots.registerBot({ botId: "unsafe-extraction", userId: LOCAL_USER_ID, displayName: "unsafe-extraction" });
    const safeExtraction = send("记住我的正常技术偏好", "unsafe-extraction"); assert(safeExtraction.source);
    candidates = [candidate('{"Cookie": "sid=FAKE_REVIEW_ONLY_abcdEFGHxyz"}', "正常技术偏好", { title: "敏感候选拒绝", kind: "fact", scopeType: "bot" })];
    await bridge.extract(safeExtraction.source);
    assert.equal(memory.listExactScope("bot", "unsafe-extraction").length, 0, "secret-bearing model candidates cannot enter L1 even from an eligible source");
    for (const reverse of [false, true]) {
      const botId = reverse ? "gateway-to-desktop" : "desktop-to-gateway";
      bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
      const route: GatewayBotOrigin = { channelId: "qq-default", connectionKey: "a".repeat(64), chatId: "c2c:owner",
        senderId: "owner", messageId: `first-${botId}`, audience: "private" };
      const original = send("记住：以后请用中文简短回答。", botId, "completed", reverse ? route : undefined);
      assert(original.source);
      candidates = [candidate("以后用中文简短回答。", "以后请用中文简短回答")];
      await bridge.extract(original.source);
      const correction = send("更正：以后请用英文简短回答，不再用中文。", botId, "completed",
        reverse ? undefined : { ...route, messageId: `correct-${botId}` });
      assert(correction.source);
      candidates = [candidate("以后用英文简短回答。", "以后请用英文简短回答", {
        operationHint: "update", replaces: "以后用中文简短回答。" })];
      await bridge.extract(correction.source);
      const stable = memory.listExactScope("bot", botId).filter(item => item.status === "active");
      assert(stable.some(item => item.content.includes("英文简短")));
      assert(!stable.some(item => item.content.includes("中文简短")), "latest automatic correction retires the old private Bot fact across entrances");
      const desktopConversation = reverse ? correction.source : original.source;
      messages.archive(LOCAL_USER_ID, botId, desktopConversation);
      const fresh = send("你好", botId, "completed", reverse ? { ...route, messageId: `new-${botId}` } : undefined);
      assert(fresh.source);
      assert(bridge.context(botId, fresh.source).includes("英文简短"));
      assert(!bridge.context(botId, fresh.source).includes("中文简短"));
      assert.equal((await bridge.search("alice", "英文简短")).some(item => item.memory.scopes.some(scope => scope.scopeId === botId)), false);
      const shared = send("记住：本群以后先列依据。", botId, "completed", {
        ...route, messageId: `group-${botId}`, chatId: "group:room", audience: "shared" });
      assert(shared.source);
      candidates = [candidate("本群以后先列依据。", "本群以后先列依据", { title: "群内偏好" })];
      await bridge.extract(shared.source);
      assert(memory.listExactScope("conversation", shared.source).some(item => item.title === "群内偏好"));
      assert(!memory.listExactScope("bot", botId).some(item => item.title === "群内偏好"));
      assert(!bridge.context(botId, shared.source).includes("英文简短"));
    }
    console.log("PASS automatic desktop/QQ preferences and natural corrections in both directions; shared audience extraction and recall stay conversation-local");
    // Production L0 capture -> model candidate extraction -> L1 SQLite reconciliation.
    const actor = {kind:"user" as const,userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
    const localBot="work-source-memory";bots.registerBot({botId:localBot,userId:LOCAL_USER_ID,displayName:localBot});
    const mixedSource=send("工作小结先结论后依据。final.txt逐字FINAL_QQ_29。只建一个B Work不组队。",localBot);
    assert(mixedSource.source);
    const created=works.createWork(actor,{operationId:"memory-work-original",title:"输出文件",ownerBotId:localBot,
      sourceMessageId:mixedSource.receipt.userMessageId,inputSnapshotId:"input:memory-original",authorization:DESKTOP_USER_GRANTS});
    assert(created.ok,JSON.stringify(created));
    candidates=[candidate("工作小结先结论后依据","工作小结先结论后依据",{title:"稳定小结偏好",explicit:false}),
      candidate("final.txt逐字FINAL_QQ_29","final.txt逐字FINAL_QQ_29",{title:"本次文件字节",kind:"constraint",explicit:false,scopeType:"global",scopeId:"model-invented-work"}),
      candidate("只建一个B Work不组队","只建一个B Work不组队",{title:"本次委派决定",kind:"decision",explicit:false})];
    await bridge.extract(mixedSource.source);
    assert(memory.listExactScope("bot",localBot).some(item=>item.title==="稳定小结偏好"));
    assert.deepEqual(memory.listExactScope("work",created.work.workId).map(item=>item.title).sort(),["本次委派决定","本次文件字节"]);
    assert(!memory.listExactScope("bot",localBot).some(item=>item.kind==="constraint" || item.kind==="decision"));
    const amendedSource=send("amend原Work，不要另建，final.txt逐字FINAL_QQ_30。",localBot);assert(amendedSource.source);
    const amended=works.amendWork(actor,{operationId:"memory-work-amend",workId:created.work.workId,goalDescription:"改为FINAL_QQ_30",
      sourceMessageId:amendedSource.receipt.userMessageId,inputSnapshotId:"input:memory-amended",versionGuard:{expectedStateVersion:created.work.stateVersion,
        expectedIntentRevision:created.work.intentRevision,expectedOwnerEpoch:created.work.ownerEpoch}});
    assert(amended.ok,JSON.stringify(amended));
    candidates=[candidate("amend原Work，不要另建","amend原Work，不要另建",{title:"本次改向",kind:"decision",explicit:false})];
    await bridge.extract(amendedSource.source);
    assert(memory.listExactScope("work",created.work.workId).some(item=>item.title==="本次改向"),"amend source is resolved through saved intent, not original source replacement");
    const unbound=send("临时文件取名 temp.txt。",localBot);assert(unbound.source);
    candidates=[candidate("临时文件取名 temp.txt","临时文件取名 temp.txt",{title:"无Work的临时事实",kind:"fact",retention:"temporary",explicit:false,scopeType:"work",scopeId:created.work.workId})];
    await bridge.extract(unbound.source);
    assert(memory.listExactScope("conversation",unbound.source).some(item=>item.title==="无Work的临时事实"));
    assert(!memory.listExactScope("work",created.work.workId).some(item=>item.title==="无Work的临时事实"),"candidate cannot claim another Work by ID");
    const explicit=send("记住：生产环境只开TLS1.3。",localBot);assert(explicit.source);
    candidates=[candidate("生产环境只开TLS1.3","生产环境只开TLS1.3",{title:"明确保存的约束",kind:"constraint",explicit:true})];
    await bridge.extract(explicit.source);
    assert(memory.listExactScope("bot",localBot).some(item=>item.title==="明确保存的约束"));
    const sourceTurn=pipeline.turns.listByTask(mixedSource.source).find(turn=>turn.userMessageId===mixedSource.receipt.userMessageId)!;
    const legacy=memory.create({kind:"constraint",title:"旧自动跨域记录",content:"final.txt逐字FINAL_QQ_29",scopeType:"bot",scopeId:localBot,
      explicit:false,sourceType:"agent",sourceId:mixedSource.source,evidence:[{evidenceKind:"conversation",refId:sourceTurn.id,
        excerpt:"用户：final.txt逐字FINAL_QQ_29\n助手："}]});
    assert.equal(memory.canAccess(legacy.id,{botId:localBot}),false,"legacy automatic Work fact cannot enter broad Bot recall");
    assert.equal(memory.canAccess(legacy.id,{workId:created.work.workId}),true,"proven original Work remains the only authorized runtime scope");
    const another=works.createWork(actor,{operationId:"unrelated-memory-work",title:"unrelated",ownerBotId:localBot,inputSnapshotId:"unrelated-input",authorization:DESKTOP_USER_GRANTS});
    assert(another.ok,JSON.stringify(another));assert.equal(memory.canAccess(legacy.id,{workId:another.work.workId}),false);
    assert(memory.get(legacy.id)?.scopes.some(scope=>scope.scopeType==="bot"),"read repair preserves original scope/history for auditable migration");
    assert(!memory.search({botId:localBot,query:"FINAL_QQ_29",statuses:["active"]}).some(hit=>hit.memory.id===legacy.id));
    messages.archive(LOCAL_USER_ID,localBot,mixedSource.source);
    const futureWorkTurn=send("新工作，请回忆要求。",localBot);assert(futureWorkTurn.source);
    const context=bridge.context(localBot,futureWorkTurn.source);
    assert(context.includes("先结论后依据"));
    assert(!context.includes("FINAL_QQ_29") && !context.includes("FINAL_QQ_30") && !context.includes("只建一个B Work"),"new Work cannot inherit old local requirements through Bot L1");
    console.log("PASS automatic L0/L1 splits stable preferences from original/amended Work facts; unbound temporary facts stay conversation-local; explicit durable scope remains authorized");
    const hybrid = memory.searchHybrid.bind(memory);
    let releaseSearch!: () => void;
    let prefetchCount = 0;
    memory.searchHybrid = async request => { const hits = await hybrid(request); prefetchCount = hits.length; await new Promise<void>(resolve => { releaseSearch = resolve; }); return hits; };
    const pendingSearch = bridge.search("bob", "PEER_REVISABLE_VALUE");
    while (!releaseSearch) await new Promise(resolve => setTimeout(resolve, 1));
    assert(prefetchCount > 0, "deferred search must hold a real visible hit before disabling");
    enabled = false; releaseSearch();
    assert.deepEqual(await pendingSearch, [], "disable while hybrid is pending withdraws the returned DTO");
    enabled = true; memory.searchHybrid = hybrid;
    console.log("PASS Bot memory: real-source L0/L1, private scope, recall, new chat, replay, source deletion race, disabled/cancelled/sensitive boundaries, temporary wording across all write paths, no approval queue, existing memory deletion");
  } finally { db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
