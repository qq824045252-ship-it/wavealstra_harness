import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import { projectMemoryContext } from "../src/main/agent/MemoryContextProjection";
import { DOTS_TASK_ID } from "../src/shared/dots";
import type { MemoryRecordDto, MemoryTurnDto } from "../src/shared/memory-kernel";

const directory = mkdtempSync(join(tmpdir(), "dots-revision-source-"));
const database = join(directory, "test.db");
let db = new AppDatabase(database);
try {
  db.openDots();
  const memory = new MemoryService(db, { semantic: false });
  const pipeline = new MemoryPipelineManager(db);
  let n = 0;
  function capture(userText: string) {
    n++;
    return pipeline.capture({ taskId: DOTS_TASK_ID, userMessageId: "ground-user-" + n, assistantMessageId: "ground-reply-" + n,
      userText, assistantText: "Assistant output supplies no user evidence.", capturedAt: Date.now() + n }).turn;
  }
  let beforeExtractionResponse = async () => {};
  function extract(turn: MemoryTurnDto, ...candidates: Record<string, unknown>[]) {
    const answer = JSON.stringify({ candidates: candidates.map(c => ({ scopeType: "task", kind: "decision", operationHint: "create",
      sourceTurnId: turn.id, explicit: true, confidence: .99, importance: 1, ...c })) });
    return memory.extractAndStore({ taskId: DOTS_TASK_ID, userText: turn.userText, assistantText: turn.assistantText, sourceTurns: [turn],
      model: { maxTokens: 4096 } as never, modelRuntime: { completeSimple: async () => {
        await beforeExtractionResponse();
        return { stopReason: "stop", content: [{ type: "text", text: answer }] };
      } } as unknown as ModelRuntime,
      isEnabled: () => true });
  }
  const all = () => memory.list({ scopeType: "task", scopeId: DOTS_TASK_ID, status: "active" });
  const quote = (record: MemoryRecordDto, revision: number) => memory.getDotsRevisionSource(record.id, revision);
  const perf = "排练记录固定先列灯光队，再列音响队。";
  const old = capture(perf);
  await extract(old, { kind: "preference", scopeType: "global", title: "排练记录的名单顺序", content: "先出灯光名单，之后提交音响名单", userEvidence: perf });
  const [order] = all();
  const profileRows = () => memory.cognition.projections.listCoreProfiles({ scopeType: "task", scopeId: DOTS_TASK_ID });
  await setImmediate();
  const firstProfile = profileRows()[0];
  assert(firstProfile?.content.includes(perf), "extraction must update the stored view before any context read");
  memory.cognition.queueDotsViews();
  const beforeRefresh = db.connection.prepare("SELECT total_changes()").pluck().get();
  await setImmediate();
  assert.equal(db.connection.prepare("SELECT total_changes()").pluck().get(), beforeRefresh,
    "an unchanged refresh must not rewrite projection rows");
  const readDots = (service = memory, query = "排练记录", limit = 8) =>
    projectMemoryContext(service, { taskId: DOTS_TASK_ID, query, limit, budgetChars: 9000, trackRecall: false });
  const initial = readDots();
  assert(initial.blocks.some(block => block.profileIds.length && block.text.includes(perf)
    && block.sources.some(source => source.id === order!.id && source.revision === 1)));
  assert.equal(memory.listProjectionProposals().length, 0);
  assert.equal(projectMemoryContext(memory, { query: perf }).profileIds?.length, 0);
  const move = capture("刚才说的顺序反过来，先混音，再照明。以后一直照这个办。");
  await extract(move, { kind: "preference", title: "排练记录的名单顺序", content: "排练记录顺序为音响队、灯光队",
    userEvidence: "先混音，再照明", replaces: "排练记录的名单顺序", operationHint: "update" });
  assert.equal(memory.history(order!.id)[0]?.revision, 2);
  assert.equal(quote(order!, 1)?.messageId, old.userMessageId);
  assert.equal(quote(order!, 2)?.messageId, move.userMessageId);
  assert.equal(quote(order!, 2)?.quote, "刚才说的顺序反过来，先混音，再照明。");
  assert.equal(new MemoryService(db, { semantic: false }).getDotsRevisionSource(order!.id, 2)?.turnId, move.id);

  const current = readDots();
  assert(current.blocks.some(block => block.profileIds.length && block.text.includes("先混音，再照明")
    && block.sources.some(source => source.id === order!.id && source.revision === 2)));
  assert(!current.text.includes(perf));
  const once = capture("本次例外。改为先打光，再混音。");
  await extract(once, { kind: "preference", title: "排练记录的名单顺序", content: once.userText,
    userEvidence: "先打光，再混音", replaces: "排练记录的名单顺序", operationHint: "supersede" });
  assert(!all().some(record => record.content.includes("先打光")));
  assert.equal(memory.get(order!.id)?.status, "active");
  assert(readDots().text.includes("先混音，再照明"));

  const scopeOnly = capture("只在雾岭项目先打光，再混音。");
  await extract(scopeOnly, { kind: "preference", title: "排练记录的名单顺序", content: scopeOnly.userText,
    userEvidence: "雾岭项目", replaces: "排练记录的名单顺序", operationHint: "supersede" });
  assert.equal(memory.get(order!.id)?.status, "active");
  const exception = all().find(record => record.content === scopeOnly.userText)!;
  assert.deepEqual(exception.metadata.dotsApplicability, { kind: "project", name: "雾岭" });
  assert.deepEqual(quote(exception, 1)?.applicability, { kind: "project", name: "雾岭" });
  assert(readDots(memory, "雾岭项目的排练记录").items.some(item => item.id === exception.id));
  assert(!readDots(memory, "雾岭项目的排练记录").items.some(item => item.id === order!.id));
  assert(readDots(memory, "海港项目的排练记录").items.some(item => item.id === order!.id));
  assert(!readDots(memory, "雾岭空间的排练记录").items.some(item => item.id === exception.id));
  assert(!readDots(memory, "新雾岭项目的排练记录").items.some(item => item.id === exception.id));
  assert(!readDots().blocks.filter(block => block.profileIds.length).some(block => block.text.includes("雾岭项目")));

  const booking = "会议场地确定在旧车站。";
  const adopted = capture(booking);
  await extract(adopted, { title: "会议场地", content: booking, userEvidence: booking });
  const venue = all().find(r => r.content === booking)!;
  const proposal = capture("颜料仓尚未选定通风材料。杨工程师提议用白桦炭，我只负责记下提案，下次再决定。");
  await extract(proposal, { title: "通风材料", content: "负责人已最终决定使用白桦炭。", userEvidence: "白桦炭" });
  const charcoal = all().find(r => r.content.includes("白桦炭"))!;
  assert.equal(charcoal.explicit, false);
  assert.equal(charcoal.kind, "fact");
  assert.equal(quote(charcoal, 1)?.stance, "reported");
  assert(!charcoal.content.includes("已最终决定"));
  const reported = capture("策展人提议把会议场地换到剧院。");
  await extract(reported, { title: "会议场地", content: "已改到剧院。", userEvidence: "剧院", replaces: "会议场地", operationHint: "supersede" });
  assert.equal(memory.get(venue.id)?.status, "active");
  assert.equal(memory.history(venue.id)[0]?.revision, 1);

  const two = capture("   🚉 会場は金沢にします。\n\nLa entrega será el martes.");
  const ja = "🚉 会場は金沢にします。", es = "La entrega será el martes.";
  await extract(two, { title: "会場", content: ja, userEvidence: "金沢" }, { title: "entrega", content: es, userEvidence: "martes" });
  const hall = all().find(r => r.content === ja)!, parcel = all().find(r => r.content === es)!;
  assert.equal(hall.kind, "decision");
  assert.equal(parcel.kind, "decision");
  assert.equal(quote(hall, 1)?.quote, ja);
  assert.equal(quote(parcel, 1)?.quote, es);
  assert(hall.evidence.every(e => !e.excerpt?.includes("martes")));
  assert(parcel.evidence.every(e => !e.excerpt?.includes("金沢")));
  const amendment = capture("El jueves.");
  await extract(amendment, { title: "entrega", content: "El jueves.", userEvidence: "jueves", replaces: "entrega", operationHint: "update" });
  assert.equal(quote(parcel, 2)?.quote, "El jueves.");

  type ToolResult = { content: { text: string }[]; isError?: boolean; details: { memory: MemoryRecordDto; originalId?: string; newId?: string } };
  const execute = new Map<string, (id: string, params: Record<string, unknown>) => Promise<ToolResult>>();
  let source = { messageId: "tool-1", createdAt: Date.now(), text: "  预算定为四百元。🚲 交车选在周三。" };
  createMemoryExtension({ taskId: DOTS_TASK_ID, service: memory, sourceInput: () => source })({
    registerTool(tool: { name: string; execute: any }) { execute.set(tool.name, tool.execute); }
  } as never);
  const tool = async (name: string, params: Record<string, unknown>) => {
    const result = await execute.get(name)!("call", params);
    assert(!result.isError);
    return result.details.memory;
  };
  const globalDefault = memory.create({ kind: "preference", title: "交付清单语言", content: "交付清单默认用中文。", scopeType: "global" });
  const projectQuote = "只在远山项目，交付清单用英文。";
  source = { messageId: "scope-exception", createdAt: Date.now(), text: projectQuote };
  const projectOverride = await tool("memory_update", { id: globalDefault.id, content: projectQuote });
  assert.notEqual(projectOverride.id, globalDefault.id);
  assert.deepEqual(projectOverride.metadata, { dotsApplicability: { kind: "project", name: "远山" }, dotsOverrides: globalDefault.id });
  assert.equal(memory.get(globalDefault.id)?.content, "交付清单默认用中文。");
  assert(readDots(memory, "远山项目的交付清单").items.some(item => item.id === projectOverride.id));
  assert(!readDots(memory, "远山项目的交付清单").items.some(item => item.id === globalDefault.id));
  assert(!readDots(memory, "蓝湾项目的交付清单").items.some(item => item.id === projectOverride.id));
  const projectCorrection = "只在远山项目，交付清单改用德文。";
  source = { messageId: "scope-correction", createdAt: Date.now(), text: projectCorrection };
  const corrected = await tool("memory_update", { id: projectOverride.id, content: projectCorrection });
  assert.equal(corrected.id, projectOverride.id);
  const correctedContext = readDots(memory, "远山项目的交付清单");
  assert(correctedContext.text.includes("改用德文") && !correctedContext.text.includes("用英文"));
  assert(!correctedContext.items.some(item => item.id === globalDefault.id));
  source = { messageId: "scope-ambiguous", createdAt: Date.now(), text: "只在远山项目。交付清单换为德文。" };
  const ambiguous = await execute.get("memory_update")!("ambiguous", {
    id: globalDefault.id, content: "交付清单换为德文。", sourceQuote: "交付清单换为德文。",
  });
  assert(!ambiguous.isError);
  assert.equal(ambiguous.details.memory.metadata.dotsApplicability && (ambiguous.details.memory.metadata.dotsApplicability as { kind: string }).kind, "unresolved");
  assert.equal(memory.get(globalDefault.id)?.content, "交付清单默认用中文。");
  const defaultCurrency = memory.create({ kind: "preference", title: "报价币种", content: "报价默认用人民币。", scopeType: "global" });
  source = { messageId: "independent-next-decision", createdAt: Date.now(), text: "这里先用日元。以后默认发票都走财务系统。" };
  const separateSubjects = await tool("memory_update", { id: defaultCurrency.id, content: "这里先用日元。", sourceQuote: "先用日元",
    applicability: { kind: "general", evidence: "以后默认" } });
  assert.notEqual(separateSubjects.id, defaultCurrency.id);
  assert.equal(memory.get(defaultCurrency.id)?.content, "报价默认用人民币。");
  source = { messageId: "unnamed-customer-project", createdAt: Date.now(), text: "给甲方的这个项目改用美元。" };
  const unresolved = await tool("memory_update", { id: defaultCurrency.id, content: source.text });
  assert.deepEqual(unresolved.metadata.dotsApplicability, { kind: "unresolved", name: "" });
  assert.equal(memory.get(defaultCurrency.id)?.content, "报价默认用人民币。");
  assert(!readDots(memory, "报价币种").items.some(item => item.id === unresolved.id));
  const projectId = "pricing-violet";
  db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(projectId, "紫岚", Date.now(), Date.now());
  const crossSentence = "重点是紫岚这单。报价要以加元做预算。";
  const currencyTurn = capture(crossSentence);
  await extract(currencyTurn, { kind: "preference", content: "报价要以加元做预算。", title: "报价币种", replaces: "报价币种", operationHint: "update",
    userEvidence: "报价要以加元做预算。", applicability: { kind: "project", name: "紫岚", id: projectId, evidence: "重点是紫岚这单。" } });
  const resolvedCurrency = all().find(record => record.content === crossSentence)!;
  assert.deepEqual(resolvedCurrency.metadata.dotsApplicability, { kind: "project", name: "紫岚", id: projectId });
  assert.equal(quote(resolvedCurrency, 1)?.quote, crossSentence);
  assert(readDots(memory, "紫岚项目报价币种").items.some(item => item.id === resolvedCurrency.id));
  assert(!readDots(memory, "紫岚项目报价币种").items.some(item => item.id === defaultCurrency.id));
  source = { messageId: "multi-topic-general", createdAt: Date.now(), text: "客户这单沿用日元。今后默认报价用英镑。" };
  const general = await tool("memory_update", { id: defaultCurrency.id, content: "今后默认报价用英镑。", sourceQuote: "今后默认报价用英镑。",
    applicability: { kind: "general", evidence: "今后默认" } });
  assert.equal(general.id, defaultCurrency.id);
  assert.equal(general.content, "今后默认报价用英镑。");
  source = { messageId: "indirect-structured", createdAt: Date.now(), text: "预算改用欧元的是紫岚，报价其他照旧。" };
  const novel = await tool("memory_update", { id: resolvedCurrency.id, content: source.text,
    applicability: { kind: "project", name: "紫岚", id: projectId, evidence: "预算改用欧元的是紫岚" } });
  assert.equal(novel.id, resolvedCurrency.id);
  assert(readDots(memory, "紫岚项目报价币种").text.includes("预算改用欧元"));
  assert.equal(memory.get(defaultCurrency.id)?.content, "今后默认报价用英镑。");
  db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)").run("pricing-other", "另一个项目", Date.now(), Date.now());
  source = { messageId: "mismatched-project-id", createdAt: Date.now(), text: "换成澳元的报价是紫岚的。" };
  const wrongId = await tool("memory_update", { id: defaultCurrency.id, content: source.text,
    applicability: { kind: "project", name: "紫岚", id: "pricing-other", evidence: "换成澳元的报价是紫岚的。" } });
  assert.equal(wrongId.metadata.dotsApplicability && (wrongId.metadata.dotsApplicability as { kind: string }).kind, "unresolved");
  assert.equal(memory.get(defaultCurrency.id)?.content, "今后默认报价用英镑。");
  const knownTaskId = "quote-project-task";
  db.upsertTask({ id: knownTaskId, projectId, title: "当前项目报价", welcomeMode: "general", updatedAt: Date.now() });
  source = { messageId: "scope-from-real-task", createdAt: Date.now(), text: "把 quote-project-task 的报价改用新西兰元。" };
  const taskBound = await tool("memory_update", { id: resolvedCurrency.id, content: source.text,
    applicability: { kind: "project", id: knownTaskId, evidence: source.text } });
  assert.equal(taskBound.id, resolvedCurrency.id);
  assert.deepEqual(taskBound.metadata.dotsApplicability, { kind: "project", name: "紫岚", id: projectId });
  const mixedExtraction = capture("给这个客户的项目用瑞郎。所有项目默认报价换回人民币。");
  await extract(mixedExtraction,
    { kind: "preference", content: "给这个客户的项目用瑞郎。", title: "报价币种", replaces: "报价币种", operationHint: "update",
      userEvidence: "给这个客户的项目用瑞郎。" },
    { kind: "preference", content: "所有项目默认报价换回人民币。", title: "报价币种", replaces: "报价币种", operationHint: "update",
      userEvidence: "所有项目默认报价换回人民币。", applicability: { kind: "general", evidence: "所有项目默认" } });
  assert(all().some(record => record.content.includes("这个客户的项目用瑞郎") && (record.metadata.dotsApplicability as { kind: string }).kind === "unresolved"));
  assert.equal(memory.get(defaultCurrency.id)?.content, "所有项目默认报价换回人民币。");
  memory.forget(projectOverride.id);
  assert(readDots(memory, "远山项目的交付清单").items.some(item => item.id === globalDefault.id));
  source = { messageId: "tool-1", createdAt: Date.now(), text: "  预算定为四百元。🚲 交车选在周三。" };
  const delivery = await tool("memory_create", { kind: "decision", title: "交车", content: "🚲 交车选在周三。", sourceQuote: "周三" });
  assert.equal(quote(delivery, 1)?.quote, "🚲 交车选在周三。");
  assert.equal(quote(delivery, 1)?.messageId, "tool-1");
  assert(delivery.evidence.every(e => !e.excerpt?.includes("四百")));
  source = { messageId: "tool-2", createdAt: Date.now(), text: "换成周五。" };
  const adjusted = await tool("memory_update", { id: delivery.id, content: "换成周五。" });
  assert.equal(adjusted.id, delivery.id);
  assert.equal(quote(adjusted, 2)?.messageId, "tool-2");
  source = { messageId: "tool-3", createdAt: Date.now(), text: "我猜周日也可能可以，等我核对。" };
  const separate = await execute.get("memory_update")!("suggestion", { id: delivery.id, content: "周日已确认", sourceQuote: "周日" });
  const provisional = separate.details.memory;
  assert(separate.content[0]?.text.includes(delivery.id) && separate.content[0]?.text.includes(provisional.id));
  assert.equal(separate.details.originalId, delivery.id);
  assert.equal(separate.details.newId, provisional.id);
  assert.notEqual(provisional.id, delivery.id);
  assert.equal(quote(provisional, 1)?.stance, "uncertain");
  assert.equal(memory.get(delivery.id)?.content, "换成周五。");
  source = { messageId: "tool-4", createdAt: Date.now(), text: "我在田野记样时先写方位，再抄标尺。这是我多年的习惯，帮我记住。" };
  const field = await tool("memory_create", { title: "田野记样", kind: "preference", content: "地理位置列放在尺度列之前", sourceQuote: "先写方位" });
  assert.equal(field.kind, "preference");
  assert.equal(quote(field, 1)?.quote, "我在田野记样时先写方位，再抄标尺。");
  const shipping = capture("出海的样本箱一律放在干舱。");
  await extract(shipping, { title: "样本箱", kind: "constraint", content: "禁止把样品放置于露天", userEvidence: "放在干舱" });
  assert.equal(all().find(r => r.content === shipping.userText)?.kind, "constraint");

  const scene = readDots(memory, "会议场地");
  assert(scene.blocks.some(block => block.scenarioIds.length && block.text.includes(booking)));
  assert(!memory.listScenarios().some(item => item.summary.includes("白桦炭") || item.summary.includes("换到剧院")));
  memory.forget(parcel.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeExtractionResponse = async () => { entered.resolve(); await release.promise; };
  const slow = extract(move, { kind: "preference", title: "排练记录的名单顺序",
    content: "刚才说的顺序反过来，先混音，再照明。", userEvidence: "先混音，再照明" });
  await entered.promise;
  source = { messageId: "forget-order", createdAt: Date.now() + n + 1, text: "忘记排练记录的名单顺序。" };
  const removal = await execute.get("memory_forget")!("withdraw-order", { id: order!.id });
  assert(!removal.isError);
  release.resolve();
  assert.equal((await slow).committedCount, 0);
  assert(!memory.listCoreProfiles().some(item => item.content.includes("先混音")));
  assert(!memory.listScenarios().some(item => item.summary.includes("先混音") || item.summary.includes("El jueves")));
  // Exercise fresh materialization and the existing FTS repair on a cold reopen.
  db.connection.exec("DELETE FROM memory_core_profiles; DELETE FROM memory_scenarios; DELETE FROM memory_fts");
  const shared = memory.create({ kind: "fact", title: "公共借用记录", content: "北侧储藏室的登记表由值班人员保管。", scopeType: "global" });
  const priorScene = memory.cognition.projections.replaceScenarios({ scopeType: "global" }, [
    { title: "借用登记", summary: shared.content, sourceMemoryIds: [shared.id] },
  ])[0]!;
  const priorProfile = memory.cognition.projections.replaceCoreProfile({ scopeType: "global" }, {
    title: "值班流程", content: shared.content, sourceScenarioIds: [priorScene.id],
  })!;
  // Open a current-version database with the previous projection scope constraint.
  for (const table of ["memory_scenarios", "memory_core_profiles"]) {
    const ddl = db.connection.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(table) as string;
    const former = ddl.replace(` OR (scope_type='task' AND scope_id='${DOTS_TASK_ID}')`, "");
    db.connection.exec(`ALTER TABLE ${table} RENAME TO ${table}_fixture; ${former};
      INSERT INTO ${table} SELECT * FROM ${table}_fixture; DROP TABLE ${table}_fixture;`);
  }
  assert.equal(quote(parcel, 1), undefined);
  assert.equal(quote(parcel, 2), undefined);
  assert.equal(quote(hall, 1)?.quote, ja);
  db.close();
  db = new AppDatabase(database);
  const reopened = new MemoryService(db, { semantic: false });
  assert.equal(reopened.getDotsRevisionSource(hall.id, 1)?.quote, ja);
  assert.equal(reopened.getDotsRevisionSource(adjusted.id, 2)?.messageId, "tool-2");
  assert.equal(reopened.getDotsRevisionSource(parcel.id, 1), undefined);
  assert.deepEqual(reopened.get(exception.id)?.metadata.dotsApplicability, { kind: "project", name: "雾岭" });
  assert(readDots(reopened, "雾岭项目的排练记录").items.some(item => item.id === exception.id));
  assert.deepEqual(reopened.cognition.projections.listScenarios({ scopeType: "global" }), [priorScene]);
  assert.deepEqual(reopened.cognition.projections.listCoreProfiles({ scopeType: "global" }), [priorProfile]);
  const rebuilt = readDots(reopened, "样本箱");
  assert(rebuilt.blocks.some(block => block.profileIds.length && block.text.includes("放在干舱")));
  assert(rebuilt.items.some(item => item.content.includes("放在干舱")));
  assert(!rebuilt.text.includes("先混音") && !rebuilt.text.includes("El jueves"));
  console.log("PASS Dots revision-bound extraction, exceptions, personal views, and withdrawal after cold FTS/view rebuild");
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
