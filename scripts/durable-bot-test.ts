import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { modelKey, resolveBotModel } from "../src/main/agent/durable/BotModelCatalog";
import { DurableMcp } from "../src/main/agent/durable/DurableMcp";
import { needsFreshUserInput } from "../src/main/agent/durable/DurableInputFreshness";
import { persistDurableImages } from "../src/main/agent/durable/DurableImages";
import { createServer } from "node:http";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { AnswerRoutingService } from "../src/main/agent/AnswerRoutingService";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import { currentDurableInvocation } from "../src/main/agent/durable/DurableExecutionContext";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LibraryService } from "../src/main/library/LibraryService";
import { answerRuleExamples } from "../src/shared/answer-routing";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { clearResults, getResult } from "../src/main/capabilities/web-access/storage";
import { generalModeConfiguration, emptyModePolicy, artifactVisibleForDisplay } from "../src/shared/mode-profile";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";
import { isActivityTime } from "../shared/src/activity-time";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-test-"));
console.log("Isolated test directory:", root);
const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ref = { provider: model.provider, modelId: model.id };
function models(reply: (context: any, options: any) => any): any {
  const api: any = { getAuth: async () => undefined, getModel: () => model, streamSimple: (_model: any, context: any, options: any) => {
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => reply(context, options)).then(content => {
      const stopReason = content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop";
      const message: any = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message }); stream.end();
    }).catch(error => {
      stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", errorMessage: String(error), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end();
    });
    return stream;
  } };
  api.completeSimple = (model: any, context: any, options: any) => api.streamSimple(model, context, options).result();
  return api;
}
const text = (value: string) => [{ type: "text" as const, text: value }];
let toolCallSequence = 0;
const call = (name: string, args: object) => [{ type: "toolCall", id: `fixture-call-${++toolCallSequence}`, name, arguments: args }];
const forbidden = { ...emptyModePolicy(), artifactPolicy: { mode: "hard" as const, allow: ["pdf"], deny: ["py"] }, presets: [{id: "old", label: "kept", promptAddon: "user prompt", mcpPolicy: { mode: "hard" as const, allow: [], deny: ["*"] } }] };
const policy = generalModeConfiguration(forbidden);
assert.equal(policy.presets?.[0].promptAddon, "user prompt");
assert.equal(policy.presets?.[0].mcpPolicy, undefined);
// Bot 产物策略 soft + unfiltered：任何产物都不隐藏（含 .py；不再有 CAD/FreeCAD 临时脚本特判）
assert(artifactVisibleForDisplay("scripts/generated/report.py", policy.artifactPolicy));
assert(artifactVisibleForDisplay("pages/a.html", policy.artifactPolicy, ["deck.pptd"]));

// The provider boundary sees the route/file for its own input, including after a reopen.
{
  const cwd = join(root, "answer-routing"); await mkdir(cwd);
  const db = new AppDatabase(join(cwd, "app.db"));
  const taskId = DOTS_TASK_ID;
  db.upsertTask({ id: taskId, title: "调度对话", cwd, modelId: "fixture/fixture", updatedAt: 1 });
  const memories = new MemoryService(db);
  const capture = new MemoryPipelineManager(db);
  const source = memories.create({ title: "天气", content: "天气简报优先出行时段。", kind: "procedure", sourceType: "manual", scopeType: "global" });
  const routing = new AnswerRoutingService(db, (id, task) => task ? memories.getForRecall(id, { taskId: task }) : memories.get(id));
  const weather = routing.save({ ...answerRuleExamples[0], instruction: source.content + "\n" + answerRuleExamples[0].instruction, sourceMemoryId: source.id, sourceHash: source.contentHash });
  const report = routing.save({ ...answerRuleExamples[1], evidenceFile: "release.md" });
  const translated = routing.save({ ...report, exclude: ["翻译周报"] }, report);
  assert.equal(routing.preview("帮我翻译这份周报为英文：项目周报已整理。", null)?.rule.id, "dots-default-policy");
  assert.equal(routing.preview("帮我写项目周报", null)?.rule.id, translated.id);
  db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES('route-project','验收项目',1,1)").run();
  const projectRule = routing.save({ ...answerRuleExamples[1], projectId: "route-project", title: "本项目周报" });
  db.upsertTask({ id: "project-chat", title: "本项目", projectId: "route-project", updatedAt: 1 });
  assert.ok(!routing.rulesForTask(taskId).some(rule => rule.id === projectRule.id));
  assert.throws(() => routing.saveForTask(taskId, { version: { id: projectRule.id, revision: projectRule.revision }, changes: { enabled: false } }));
  const local = routing.saveForTask("project-chat", { scope: "project", changes: { title: "城市天气", include: ["天气"], instruction: "按出行时段列出降水。" } });
  assert.notEqual(local.id, weather.id);
  assert.equal(local.projectId, "route-project");
  assert.equal(routing.preview("上海天气", "route-project")?.rule.id, local.id);
  assert.equal(routing.preview("上海天气", null)?.rule.id, weather.id);
  assert.equal(routing.preview("把天气规则改成先查气温", "route-project")?.rule.id, "dots-default-policy");
  const localVersion = { id: local.id, revision: local.revision };
  const disabled = routing.saveForTask("project-chat", { version: localVersion, changes: { enabled: false } });
  assert.throws(() => routing.saveForTask("project-chat", { version: localVersion, changes: { title: "旧版本写入" } }), /规则已变化/);
  assert.equal(disabled.enabled, false);
  routing.remove(local.id, disabled.revision);
  assert.equal(routing.preview("写项目周报", "route-project")?.rule.title, "本项目周报");
  assert.equal(routing.preview("写项目周报", null)?.rule.title, "周报核对发布记录");
  assert.equal(routing.preview("润色文字\n## 用户附带文件\n天气 项目周报", "route-project")?.rule.id, "dots-default-policy");
  routing.remove(projectRule.id, projectRule.revision);
  await writeFile(join(cwd, "release.md"), "需求 R-37 已提测，尚无发布记录。");
  const payloads: string[] = [];
  let canRead = true;
  let forgetOnNextRequest: string | undefined;
  let replaceReleaseOnNextRequest = false;
  const service = new DurableBotService({ db, agentDir: cwd, mcpDir: join(cwd, "mcp"),
    models: { ...models(async context => {
      payloads.push(JSON.stringify(context.messages));
      if (forgetOnNextRequest) {
        const id = forgetOnNextRequest;
        forgetOnNextRequest = undefined;
        return call("memory_forget", { id });
      }
      if (replaceReleaseOnNextRequest) {
        replaceReleaseOnNextRequest = false;
        await writeFile(join(cwd, "release.md"), "需求 R-38 已上线。");
        return call("read", { path: "tool-note.md" });
      }
      return text("fixture reply");
    }),
      refresh: async () => ({}), getAvailable: async () => [model] },
    answerRouting: routing, onTurns: (_id, turns) => { for (const turn of turns) capture.capture(turn); },
    evidenceProjection: task => ({ memory: memories, enabled: () => true, scope: () => ({ taskId: task.id }), supplementalEvidence: () => [] }),
    auditInput: request => ({ userMessageId: request.userMessageId, assistantMessageId: request.assistantMessageId, cwd, skills: [],
      recommendation: { query: request.text, mode: "general", context: { memoryIds: [], scenarioIds: [], profileIds: [] }, capabilities: [] } }),
    tools: task => durableDomainTools([createMemoryExtension({ taskId: task.id, service: memories, sourceInput: () => currentDurableInvocation()?.memorySource })],
      { taskId: task.id, cwd, models: models(() => text("")) as any }),
    resolveCwd: () => cwd, instructions: () => "", toolMode: () => "native",
    toolAllowed: (_task, name) => name !== "read" || canRead, defaultModel: () => "fixture/fixture", emit: () => {} });
  const ask = async (id: string, question: string) => {
    const count = payloads.length;
    const result = await service.prompt({ taskId, text: question, userMessageId: id, assistantMessageId: "answer-" + id }, false);
    assert.ok(!result.error, JSON.stringify(result));
    assert.equal(payloads.length, count + 1, JSON.stringify(result));
    return payloads[count];
  };
  try {
    db.upsertTask({ id: "ordinary", title: "普通任务", cwd, updatedAt: 1 });
    await service.prompt({ taskId: "ordinary", text: "帮我写项目周报", userMessageId: "ordinary-input", assistantMessageId: "ordinary-output" }, false);
    assert.doesNotMatch(payloads.at(-1)!, /需求 R-37/);
    assert.deepEqual(routing.history({ taskId: "ordinary", inputId: "ordinary-input" }), []);
    db.connection.exec("CREATE TABLE dots_delegations(operation_id TEXT,task_id TEXT)");
    db.connection.prepare("INSERT INTO dots_delegations VALUES(?,?)").run("dots-input-synthetic", "ordinary");
    await service.prompt({ taskId: "ordinary", text: "委派转述", userMessageId: "dots-input-synthetic", assistantMessageId: "generated-output" }, false);
    assert.deepEqual(capture.turns.listByTask("ordinary").map(turn => turn.userText), ["帮我写项目周报"]);
    const localPreference = memories.create({ title: "交付标记", kind: "preference", content: "本轮标记为 JADE-1234。",
      sourceType: "manual", scopeType: "task", scopeId: taskId });
    assert.match(await ask("local-preference", "三加三等于多少？"), /JADE-1234/);
    assert.equal(capture.turns.listByTask(taskId).length, 1);
    const revised = memories.update({ id: localPreference.id, content: "本轮标记为 BLUE-5267。" });
    const newPayload = await ask("local-revision", "四加四等于多少？");
    assert.match(newPayload, /BLUE-5267/);
    assert.doesNotMatch(newPayload, /JADE-1234/);
    await service.release(taskId);
    const view = memories.getForRecall(localPreference.id, { taskId });
    assert.equal(view?.contentHash, revised.contentHash);
    assert.equal(memories.getForRecall(localPreference.id, { taskId: "ordinary" }), undefined);
    forgetOnNextRequest = localPreference.id;
    await service.prompt({ taskId, text: "忘记交付标记", userMessageId: "forget", assistantMessageId: "forgot" }, false);
    assert.equal(memories.get(localPreference.id), undefined);
    assert.match(payloads.at(-1)!, /本轮遗忘工具已成功/);
    assert.doesNotMatch(payloads.at(-1)!, /JADE-1234|BLUE-5267/);
    await service.release(taskId);
    assert.match(await ask("weather", "上海明早出门要带伞吗"), /逐小时预报/);
    assert.doesNotMatch(await ask("translate", "翻译：上海天气好"), /逐小时预报/);
    await service.release(taskId);
    assert.match(await ask("report", "帮我写项目周报"), /需求 R-37 已提测，尚无发布记录/);
    const history = (await service.history(taskId)).messages;
    assert.equal(history.filter(item => item.role === "user").at(-1)?.text, "帮我写项目周报");
    assert.deepEqual(routing.history().filter(item => item.ruleId !== "dots-default-policy").map(item => [item.inputId, item.title]),
      [["report", "周报核对发布记录"], ["weather", "查询出行天气"]]);
    assert.match(routing.history()[0].detail, /已预读 release.md/);
    const defaultReceipt = routing.history({ taskId, inputId: "translate" })[0];
    assert.equal(defaultReceipt.ruleId, "dots-default-policy");
    assert.equal(defaultReceipt.policy?.routeMode, "auto");
    const rephrased = await ask("translate-paraphrase", "请将“上海阳光明媚”译成英文。");
    assert.doesNotMatch(rephrased, /逐小时预报/);
    const paraphraseReceipt = routing.history({ taskId, inputId: "translate-paraphrase" })[0];
    assert.equal(paraphraseReceipt.ruleId, defaultReceipt.ruleId);
    assert.equal(paraphraseReceipt.revision, defaultReceipt.revision);
    const fallback = routing.list().find(rule => rule.id === defaultReceipt.ruleId)!;
    const nextFallback = routing.save({ ...fallback, policy: { ...fallback.policy!, routeMode: "direct" } }, fallback);
    const reopenRouting = () => new AnswerRoutingService(db, () => undefined);
    const resolveDefault = (inputId: string) => reopenRouting().prepare({
      taskId, inputId, cwd, query: "翻译：上海天气好", canRead: () => false,
    });
    assert.equal((await resolveDefault("translate"))?.rule.revision, fallback.revision);
    assert.equal((await resolveDefault("new-default"))?.rule.revision, nextFallback.revision);
    assert.match((await resolveDefault("translate"))?.text ?? "", /选择直答、查询或委派/);
    assert.match(await ask("next-policy-payload", "请把一段简短句子翻译为法语。"), /优先依据已有事实和有界读取直接回答/);

    await writeFile(join(cwd, "tool-note.md"), "本次工具调用结束");
    const start = payloads.length;
    replaceReleaseOnNextRequest = true;
    await service.prompt({ taskId, text: "帮我写项目周报", userMessageId: "two-requests", assistantMessageId: "reply-to-two" }, false);
    assert.equal(payloads.length, start + 2);
    for (const payload of payloads.slice(start)) {
      assert.match(payload, /需求 R-37 已提测/);
      assert.doesNotMatch(payload, /需求 R-38 已上线/);
    }
    const firstReceipt = routing.history({ taskId, inputId: "two-requests" });
    assert.equal(firstReceipt.length, 1);
    const updated = await ask("updated-file", "帮我写项目周报");
    assert.match(updated, /需求 R-38 已上线/);
    assert.match(updated, /资料的内容已从上次读取的版本更新/);
    assert.notEqual(routing.history({ taskId, inputId: "updated-file" })[0].evidence?.contentHash,
      firstReceipt[0].evidence?.contentHash);
    assert.deepEqual(routing.history({ taskId, inputId: "two-requests" }), firstReceipt);
    const skipped = await ask("override", "帮我写项目周报，这次不要读取文件，只用下面的文字。");
    assert.doesNotMatch(skipped, /需求 R-38 已上线/);
    assert.equal(routing.history({ taskId, inputId: "override" })[0]?.evidence?.status, "skipped");

    const instruction = "调度对照用暗号为铜鹤。";
    const taught = memories.create({ title: "调度对照", content: instruction, kind: "constraint", sourceType: "manual", scopeType: "global" });
    const linked = routing.save({ ...answerRuleExamples[0], title: "调度对照", include: ["调度对照"],
      sourceMemoryId: taught.id, sourceHash: taught.contentHash, instruction });
    assert.doesNotMatch((db.connection.prepare("SELECT config FROM answer_rules WHERE id=?").get(linked.id) as {config:string}).config, /铜鹤/);
    const once = await ask("deduplicate", "按调度对照给我暗号");
    assert.match(once, new RegExp(taught.id));
    assert.equal(once.split(instruction).length - 1, 1, "same memory instruction appears once in the provider request");
    routing.remove(linked.id, linked.revision);
    const independent = routing.save({ ...report, include: ["调度对照"], instruction });
    const independentPayload = await ask("independent-dedup", "按调度对照整理资料");
    assert.match(independentPayload, /本轮规则采用记忆/);
    assert.equal(independentPayload.split(instruction).length - 1, 1);
    assert.match(independentPayload, /需求 R-38 已上线/);
    routing.remove(independent.id, independent.revision);
    const extra = "额外保留交付编号。";
    const combined = routing.save({ ...report, include: ["调度对照"], sourceMemoryId: taught.id,
      sourceHash: taught.contentHash, sourcePrefixLength: instruction.length, instruction: instruction + "\n" + extra });
    const combinedPayload = await ask("composed-dedup", "按调度对照核对编号");
    assert.equal(combinedPayload.split(instruction).length - 1, 1);
    assert.match(combinedPayload, /额外保留交付编号/);
    assert.equal(routing.history({ taskId, inputId: "composed-dedup" })[0]?.evidence?.status, "read");
    routing.remove(combined.id, combined.revision);
    const longInstruction = "调度截断核对".repeat(130) + "保留末尾这一句。";
    const longMemory = memories.create({ title: "调度截断核对", content: longInstruction, kind: "constraint", sourceType: "manual", scopeType: "global" });
    const longRule = routing.save({ ...report, include: ["调度截断核对"], instruction: longInstruction,
      sourceMemoryId: longMemory.id, sourceHash: longMemory.contentHash });
    assert.ok((await ask("clipped-dedup", "调度截断核对")).includes(longInstruction), "clipped memory keeps the complete rule");
    routing.remove(longRule.id, longRule.revision);
    canRead = false;
    const denied = await ask("denied", "整理周报");
    assert.match(denied, /未取得资料 release.md/);
    assert.doesNotMatch(denied, /需求 R-37/);
    routing.save({ ...weather, enabled: false }, weather);
    assert.doesNotMatch(await ask("off", "明天的天气如何"), /逐小时预报/);
    assert.throws(() => routing.remove(weather.id, weather.revision), /规则已变化/);
    const restored = routing.save(weather, { id: weather.id, revision: 2 });
    memories.update({ id: source.id, content: "天气简报先核对所在城市。" });
    assert.equal(routing.preview("明天天气如何", null, taskId)?.rule.instruction, "天气简报先核对所在城市。\n" + answerRuleExamples[0].instruction);
    assert.equal(routing.list().find(item => item.id === weather.id)?.sourceUnavailable, false);
    assert.throws(() => routing.save(restored, restored), /来源记忆已变化/);
    assert.throws(() => routing.save({ ...translated, evidenceFile: "../other.md" }, translated), /相对路径/);
    routing.remove(translated.id, translated.revision);
    assert.deepEqual(routing.history({ taskId, inputId: "two-requests" }), firstReceipt);
    memories.forget(source.id);
    assert.deepEqual(routing.list().map(rule => rule.id), ["dots-default-policy"]);
    assert.equal(routing.history({ taskId, inputId: "weather" })[0].title, "查询出行天气");
  } finally { await service.close(); db.close(); }
}

// Bound project materials use the live Library scope and keep the first successful read.
{
  const cwd = join(root, "answer-routing-project-material");
  await mkdir(cwd);
  const db = new AppDatabase(join(cwd, "app.db"));
  const taskId = "project-material-task";
  const projectId = "material-project";
  const otherProjectId = "another-material-project";
  const addProject = db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,1,1)");
  addProject.run(projectId, "资料项目");
  addProject.run(otherProjectId, "其它项目");
  const task = { id: taskId, title: "项目资料验证", cwd, projectId, updatedAt: 1 };
  db.upsertTask(task);
  const library = new LibraryService(db, { libraryRoot: join(cwd, "library") });
  const space = library.createSpace({ name: "受管资料", projectId });
  const item = library.createItem({ kind: "markdown", title: "发布记录", spaceId: space.id });
  const firstText = "项目资料版本 10";
  const secondText = "项目资料版本 11";
  library.writeContent({ id: item.id, content: firstText });
  const routing = new AnswerRoutingService(db, () => undefined, undefined, () => library);
  const rule = routing.save({ ...answerRuleExamples[1], evidenceLibraryItemId: item.id });
  let allowed = true;
  const prepare = (inputId: string, source = routing) => source.prepare({ taskId, inputId, query: "写项目周报", cwd,
    canRead: () => false, canReadLibrary: () => allowed });
  try {
    const a = await prepare("input-a");
    assert(a);
    assert.match(a.text, /项目资料版本 10/);
    const aReceipt = routing.history({ taskId, inputId: "input-a" })[0];
    assert.equal(aReceipt.evidence?.reference, item.id);
    assert.equal(aReceipt.evidence?.path, library.absolutePath(item));
    assert.equal(aReceipt.evidence?.contentHash, createHash("sha256").update(firstText).digest("hex"));
    const reopened = new AnswerRoutingService(db, () => undefined, undefined, () => library);
    assert.match((await prepare("input-a", reopened))?.text ?? "", /项目资料版本 10/);
    assert.deepEqual(reopened.history({ taskId, inputId: "input-a" })[0], aReceipt);
    library.writeContent({ id: item.id, content: secondText });
    const b = await prepare("input-b");
    assert(b);
    assert.match(b.text, /项目资料版本 11/);
    assert.match((await prepare("input-a"))?.text ?? "", /项目资料版本 10/);
    await assert.rejects(prepare("input-a", new AnswerRoutingService(db, () => undefined, undefined, () => library)), /原始调度快照/);
    assert.deepEqual(routing.history({ taskId, inputId: "input-a" })[0], aReceipt);
    const revised = routing.save({ ...rule, instruction: "新的周报做法。" }, rule);
    a.validate();
    assert.equal((await prepare("input-a"))?.rule.revision, rule.revision);
    assert.equal((await prepare("new-revision"))?.rule.revision, revised.revision);
    allowed = false;
    assert.throws(() => a.validate(), /权限或来源已撤销/);
    assert.equal(routing.history({ taskId, inputId: "input-a" })[0].evidence?.status, "revoked");
    assert.equal(routing.history({ taskId, inputId: "input-a" })[0].routeStatus, "revoked");
    assert.doesNotMatch((await prepare("denied"))?.text ?? "", /项目资料版本 11/);
    assert.equal(routing.history({ taskId, inputId: "denied" })[0].evidence?.status, "denied");
    allowed = true;
    db.upsertTask({ ...task, projectId: otherProjectId });
    assert.throws(() => b.validate(), /作用域已变化/);
    assert.doesNotMatch((await prepare("other-project"))?.text ?? "", /项目资料版本 11/);
    assert.equal(routing.history({ taskId, inputId: "other-project" })[0].evidence?.status, "denied");
    db.upsertTask(task);
    const beforeDeletion = await prepare("before-delete");
    assert(beforeDeletion);
    library.deleteItem(item.id);
    assert.throws(() => beforeDeletion.validate(), /权限或来源已撤销/);
    await prepare("missing-material");
    assert.equal(routing.history({ taskId, inputId: "missing-material" })[0].evidence?.status, "not-found");
    const batchIds = Array.from({ length: 52 }, (_, index) => `batch-${index}`);
    for (const id of batchIds) await prepare(id);
    assert.equal(routing.history().length, 50);
    assert.deepEqual(new Set(routing.history({ taskId, inputIds: [...batchIds, "absent"] }).map(use => use.inputId)),
      new Set(batchIds));
    const disabled = routing.save({ ...revised, enabled: false }, revised);
    routing.save({ ...disabled, enabled: true }, disabled);
    const afterRevocation = new AnswerRoutingService(db, () => undefined, undefined, () => library);
    await assert.rejects(prepare("new-revision", afterRevocation), /原始调度快照/);
  } finally { db.close(); }
}

// Drop an actual emitted revision between the native writer and the desktop store.
{
  const cwd = join(root, "desktop-sync"); await mkdir(cwd);
  const db = new AppDatabase(join(cwd, "app.db"));
  const taskId = "gap";
  db.upsertTask({ id: taskId, title: taskId, cwd, modelId: "fixture/fixture", updatedAt: 1 });
  let reads = 0, drop = false;
  const desktop = createAppStore({ getApi: () => ({ agent: {
    loadTaskHistory: async (id: string) => { reads++; return service.history(id, undefined, "current"); },
  } }) as Window["api"] });
  const service = new DurableBotService({ db, agentDir: cwd, mcpDir: join(cwd, "mcp"), models: { ...models(() => text("actual reply")), refresh: async () => ({}), getAvailable: async () => [model] },
    resolveCwd: () => cwd, instructions: () => "", toolMode: () => "native", defaultModel: () => "fixture/fixture",
    emit: patch => { if (!drop) desktop.useAppStore.getState().applyAgentPatch(patch); } });
  const drain = async () => {
    const deadline = Date.now() + 5000;
    while (desktop.context.runtime.durableResyncs.size) {
      assert(Date.now() < deadline, "desktop resync did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await service.prompt({ taskId, text: "actual question", userMessageId: "q", assistantMessageId: "a" }, false);
    await drain();
    const writer = await service.inspect(taskId);
    assert(writer);
    drop = true; await service.refresh(taskId); drop = false;
    const before = reads;
    for (let n = 0; n < 5; n++) { await service.refresh(taskId); await drain(); }
    const projected = desktop.useAppStore.getState().tasks.find(task => task.id === taskId)?.durable;
    console.log("desktop gap", { reads: reads - before, writer: writer.epoch, received: projected?.epoch });
    assert.equal(reads - before, 1, "five delivered revisions after one gap should need one read");
    assert.equal(projected?.epoch, writer.epoch);
    assert.equal(projected?.revision, (await service.history(taskId, undefined, "current")).durable?.revision);
    assert.equal((await service.history(taskId)).durable?.epoch, undefined, "stored reads beside a writer have no stream cursor");
    assert.equal(projected?.messages.at(-1)?.text, "actual reply");
    await service.release(taskId);
    const archive = await service.history(taskId, undefined, "current");
    assert.equal(archive.durable?.epoch, undefined, "a closed session has history but no live stream cursor");
    assert.equal(archive.messages.at(-1)?.text, "actual reply");
    const reopened = await service.inspect(taskId);
    assert(reopened && reopened.epoch !== writer.epoch && reopened.historyId === writer.historyId);
    assert.equal(desktop.useAppStore.getState().tasks[0].durable?.epoch, reopened.epoch);
  } finally { await service.close(); db.close(); }
}

{
  const cwd = join(root, "input-freshness-before-admission"); await mkdir(cwd);
  const db = new AppDatabase(join(cwd, "app.db"));
  const taskId = "publish-with-new-requirement";
  db.upsertTask({ id: taskId, title: "Publish fixture", cwd, modelId: "fixture/fixture", updatedAt: 1 });
  const oldProviderReached = Promise.withResolvers<void>();
  const releaseOldProvider = Promise.withResolvers<void>();
  const pendingInputReachedPreparation = Promise.withResolvers<void>();
  const releaseInputPreparation = Promise.withResolvers<void>();
  const oldResultSeen = Promise.withResolvers<string>();
  const publishStarted = Promise.withResolvers<void>();
  const finishStartedPublish = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const effects: string[] = [];
  const publish = defineTool({
    name: "mcp__fixture__publish", description: "Record the published revision",
    parameters: Type.Object({ revision: Type.String() }), replay: "unsafe",
    execute: async ({ revision }) => {
      effects.push(revision);
      if (revision === "revised") {
        publishStarted.resolve();
        await finishStartedPublish.promise;
        await writeFile(join(cwd, "published.txt"), revision);
        published.resolve();
      }
      return { output: text(revision) };
    },
  });
  const service = new DurableBotService({
    db, agentDir: cwd, mcpDir: join(cwd, "mcp"), resolveCwd: () => cwd, instructions: () => "",
    toolMode: () => "native", defaultModel: () => "fixture/fixture", emit: () => {},
    tools: async () => ({ tools: [publish], contextHooks: [] }),
    prepareInput: async request => {
      if (request.userMessageId === "revised") {
        pendingInputReachedPreparation.resolve();
        await releaseInputPreparation.promise;
      }
      return request.text;
    },
    models: { ...models(async context => {
      const last = context.messages.at(-1);
      const payload = JSON.stringify(last?.content ?? "");
      if (last?.role === "toolResult") {
        if (!effects.length) oldResultSeen.resolve(payload);
        return text("turn finished");
      }
      if (last?.role === "user" && payload.includes("publish old")) {
        oldProviderReached.resolve();
        await releaseOldProvider.promise;
        return call(publish.name, { revision: "old" });
      }
      if (last?.role === "user" && payload.includes("publish revised")) return call(publish.name, { revision: "revised" });
      return text("later requirement received");
    }), refresh: async () => ({}), getAvailable: async () => [model] },
  });
  const send = (id: string, value: string) => service.submit({ taskId, text: value, userMessageId: id, assistantMessageId: `assistant-${id}` });
  const wait = <T>(operation: Promise<T>) => Promise.race([operation,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fresh input fixture did not progress")), 10_000).unref())]);
  try {
    await send("old", "publish old");
    await wait(oldProviderReached.promise);
    const next = send("revised", "publish revised");
    await wait(pendingInputReachedPreparation.promise);
    releaseOldProvider.resolve();
    assert.match(await wait(oldResultSeen.promise), /较新的用户输入等待处理/);
    assert.deepEqual(effects, [], "input blocked in host preparation still prevents an outdated side effect");
    releaseInputPreparation.resolve();
    await next;
    await wait(publishStarted.promise);
    await send("later", "new requirement arrived after publish began");
    finishStartedPublish.resolve();
    await wait(published.promise);
    assert.deepEqual(effects, ["revised"]);
    assert.equal(await readFile(join(cwd, "published.txt"), "utf8"), "revised");
  } finally {
    releaseOldProvider.resolve();
    releaseInputPreparation.resolve();
    finishStartedPublish.resolve();
    await service.close();
    db.close();
  }
  console.log("PASS host preparation is covered by the freshness barrier and an already-started publish completes once");
}

{
  assert.equal(needsFreshUserInput("bash", { command: "git push origin main" }), true);
  assert.equal(needsFreshUserInput("bash", { command: "cat result.txt" }), false);
  assert.equal(needsFreshUserInput("browser_exec", { action: "click" }), true);
  assert.equal(needsFreshUserInput("browser_exec", { action: "inspect" }), false);
  assert.equal(needsFreshUserInput("conversation_goal_propose_complete", {}), true);
  assert.equal(needsFreshUserInput("mcp_call_tool", { server: "workspace", tool: "send_email", arguments: {} }), true);
  const cwd = join(root, "freshness-host-admission"); await mkdir(cwd);
  const db = new AppDatabase(join(cwd, "app.db"));
  for (const id of ["admission-a", "admission-b"]) db.upsertTask({ id, title: id, cwd, modelId: "fixture/fixture", updatedAt: 1 });
  const began = Promise.withResolvers<void>();
  const releaseProposal = Promise.withResolvers<void>();
  const preparing = Promise.withResolvers<void>();
  const releasePreparation = Promise.withResolvers<void>();
  const effects: string[] = [];
  const service = new DurableBotService({ db, agentDir: cwd, mcpDir: join(cwd, "mcp"), resolveCwd: () => cwd,
    defaultModel: () => "fixture/fixture", instructions: () => "", toolMode: () => "native", emit: () => {},
    tools: async () => ({contextHooks: [], tools: [defineTool({
      name: "gmail_send", description: "Record a fixture effect", replay: "unsafe",
      parameters: Type.Object({ message: Type.String() }),
      execute: async args => { effects.push(args.message); return { output: text("sent") }; }
    })]}),
    async prepareInput(request) {
      if (request.text === "prevent send") { preparing.resolve(); await releasePreparation.promise; }
      return request.text;
    },
    models: { ...models(async context => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") return text("settled");
      const payload = JSON.stringify(last);
      if (payload.includes("original send")) {
        began.resolve();
        await releaseProposal.promise;
        return call("gmail_send", { message: "original" });
      }
      if (payload.includes("independent send")) return call("gmail_send", { message: "independent" });
      return text("held");
    }), refresh: async () => ({}), getAvailable: async () => [model] },
  });
  const ask = (taskId: string, id: string, message: string) => service.prompt({ taskId, text: message, userMessageId: id, assistantMessageId: "answer-" + id }, false);
  try {
    const original = ask("admission-a", "first", "original send");
    await began.promise;
    const incoming = ask("admission-a", "second", "prevent send");
    await preparing.promise;
    releaseProposal.resolve();
    assert.equal((await original).error, undefined);
    assert.deepEqual(effects, [], "host arrival blocks dispatch before Pi admission");
    assert.equal((await ask("admission-b", "other", "independent send")).error, undefined);
    assert.deepEqual(effects, ["independent"], "one task's pending user input does not block independent dispatch");
    releasePreparation.resolve();
    assert.equal((await incoming).error, undefined);
  } finally { releaseProposal.resolve(); releasePreparation.resolve(); await service.close(); db.close(); }
  console.log("PASS host input arrival fences dispatch before native admission without blocking another task");
}

for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, "input-freshness-" + mode); await mkdir(cwd);
  const calls: string[] = [];
  const { promise: proposed, resolve: modelProposing } = Promise.withResolvers<void>();
  const { promise: release, resolve: releaseModel } = Promise.withResolvers<void>();
  let effectObserved = false;
  const publish = defineTool({
    name: "gmail_send", description: "Record a fixture effect.",
    parameters: Type.Object({ version: Type.String() }),
    replay: "unsafe",
    execute: async args => { calls.push(args.version); return { output: text("published") }; },
  });
  const proposal = (version: string) => mode === "native" ? call(publish.name, { version }) :
    call("codemode", { code: `text(await tools.gmail_send({version:${JSON.stringify(version)}}));` });
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref,
    toolMode: mode, instructions: () => "fixture", onSnapshot: () => {}, tools: [publish],
    models: models(async context => {
      const last = context.messages.at(-1);
      if (context.messages.some((message: any) => message.role === "toolResult" && /较新的用户输入/.test(JSON.stringify(message)))) {
        effectObserved = true;
      }
      if (last?.role === "toolResult") return text("settled");
      const payload = JSON.stringify(last);
      if (payload.includes("old command")) {
        modelProposing();
        await release;
        return proposal("old");
      }
      if (payload.includes("do not publish")) return text("held");
      if (payload.includes("publish revision two")) return proposal("new");
      throw new Error("unexpected fixture input " + payload);
    }) });
  try {
    const old = await runtime.submit("old command", "initial");
    await proposed;
    const stop = await runtime.submit("do not publish", "stop", mode === "native" ? "steer" : "followUp");
    assert.equal((await stop.status(ctx)).status, "queued");
    releaseModel();
    assert.equal((await old.wait(ctx)).status, "done");
    assert.equal((await stop.wait(ctx)).status, "done");
    assert.equal(effectObserved, true);
    assert.deepEqual(calls, []);
    const next = await runtime.submit("publish revision two", "authorized");
    assert.equal((await next.wait(ctx)).status, "done");
    assert.deepEqual(calls, ["new"]);
  } finally { releaseModel(); await runtime.close(); }
}

for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode); await mkdir(cwd);
  let calls = 0;
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode, instructions: () => "fixture", onSnapshot: () => {},
    models: models((context) => {
      const names = getCurrentTools(context.messages).map(t => t.name);
      assert(names.includes(mode === "native" ? "write" : "codemode"), JSON.stringify(names));
      if (++calls === 1) return mode === "native" ? call("write", { path: "proof.py", content: "native durable" })
        : call("codemode", { code: 'await tools.write({path:"proof.py",content:"native durable"}); const r=await tools.read({path:"proof.py"}); text(r); store("n",7);' });
      assert(context.messages.some((m: any) => m.role === "toolResult" && !m.isError), JSON.stringify(context.messages));
      return text("complete");
    }) });
  try {
    const submission = await runtime.submit("run", `request-${mode}`);
    assert.equal((await submission.wait(ctx)).status, "done");
    assert.equal(await readFile(join(cwd, "proof.py"), "utf8"), "native durable");
    await runtime.conversation.waitForIdle(ctx);
    await runtime.refresh();
    assert.equal(runtime.snapshot.messages.at(-1)?.text, "complete");
    assert.equal(runtime.snapshot.busy, false);
    const duplicate = await runtime.submit("run", `request-${mode}`);
    assert.equal(duplicate.id, submission.id);
  } finally { await runtime.close(); }
  const reopened = await DurableBotRuntime.open({directory: join(cwd,"state"), cwd, model:ref, toolMode:mode, instructions:()=>"fixture", onSnapshot:()=>{}, models:models(()=> { throw new Error("history must not infer"); })});
  assert.equal(reopened.snapshot.messages.at(-1)?.text,"complete");
  await reopened.close();
  console.log("PASS",mode,"real native tools, no artifact blacklist, deduplication and reopen");
}
{
  const cwd = join(root, "document-semantics"); await mkdir(cwd);
  let code = 'store("n",1);';
  const api = models(context => {
    const last = context.messages.at(-1);
    if (last?.role !== "toolResult") return call("codemode", { code });
    assert.equal(last.isError, false, JSON.stringify(last.content));
    return text("document turn complete");
  });
  const options = { directory: join(cwd, "state"), cwd, model: ref, toolMode: "codemode" as const, instructions: () => "fixture", onSnapshot: () => {}, models: api };
  let runtime = await DurableBotRuntime.open(options);
  try {
    for (const n of [1, 2]) {
      code = `store("n",${n});`;
      const metadata = { text: `raw-${n}`, displayText: `visible-${n}`, attachments: [{ name: `file-${n}`, path: join(cwd, `file-${n}`) }] };
      assert.equal((await (await runtime.submit(metadata.text, `document-${n}`, "followUp", metadata)).wait(ctx)).status, "done");
    }
    await runtime.conversation.waitForIdle(ctx);
    const history = await runtime.conversation.entries({ order: "ascending" }, 100, undefined, ctx);
    const firstAnswer = history.items.find(entry => entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.stopReason === "stop"));
    assert(firstAnswer);
    const fork = await runtime.conversation.fork(firstAnswer.id, { ownership: { kind: "ownerless" } }, ctx);
    code = 'if(load("n")!==1)throw Error("fork must copy store as of its entry"); store("n",3);';
    assert.equal((await (await fork.submit({ type: "input", content: "fork", requestId: "fork" }, ctx)).wait(ctx)).status, "done");
    await fork.waitForIdle(ctx);
    const sibling = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: ref, tools: (await runtime.conversation.agent(ctx)).tools } }, ctx);
    code = 'if(load("n")!==undefined)throw Error("conversation store leaked"); store("n",9);';
    assert.equal((await (await sibling.submit({ type: "input", content: "sibling", requestId: "sibling" }, ctx)).wait(ctx)).status, "done");
    await sibling.waitForIdle(ctx);
    const before = (await runtime.refresh()).messages;
    // 「最后活动时间」端到端契约：它必须是真实时刻，且与投影窗口无关（旧实现从
    // messages.at(-1) 推算，长任务里占位行会把它变成 epoch 0 → 侧栏 20774 天）。
    const activity = (await runtime.refresh()).activityAt;
    assert(isActivityTime(activity), `activity must be a real instant, got ${String(activity)}`);
    const newestMessageAt = Math.max(...before.map(message => message.createdAt));
    assert.equal(activity, newestMessageAt, "activity is the newest real message instant, not a placeholder's");
    assert.deepEqual(before.filter(message => message.role === "user").map(message => message.text), ["visible-1", "visible-2"]);
    assert.deepEqual(before.filter(message => message.role === "user").map(message => message.attachments?.[0].name), ["file-1", "file-2"]);
    assert(before.filter(message => message.role === "assistant").every(message => message.durationMs !== undefined));
    await runtime.close();
    runtime = await DurableBotRuntime.open(options);
    assert.deepEqual(runtime.snapshot.messages, before, "input display metadata, response timing and complete history survive reopen");
    assert.equal(runtime.snapshot.activityAt, activity, "activity survives reopen: the window no longer decides it");
    code = 'if(load("n")!==2)throw Error("reopen lost root store or fork/sibling mutated it"); text(load("n"));';
    assert.equal((await (await runtime.submit("read persisted store", "document-reopen")).wait(ctx)).status, "done");
  } finally { await runtime.close(); }
  console.log("PASS conversation documents preserve entry-time forks, isolate siblings and restore store, input metadata, timing and history");
}
if (process.platform === "win32") for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode + "-powershell"); await mkdir(cwd);
  const fileName = "argv 空格 & [x].txt", proof = "中文 durable $ & argv";
  const command = [
    `$file = Join-Path (Get-Location) '${fileName}'`,
    `[IO.File]::WriteAllText($file, '${proof}', [Text.UTF8Encoding]::new($false))`,
    "[Console]::WriteLine('POWERSHELL_UTF8_中文')",
    "[Console]::WriteLine((Get-Location).Path)",
  ].join("\n");
  let requests = 0;
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode,
    instructions: () => "fixture", onSnapshot: () => {}, models: models(context => {
      const offered = getCurrentTools(context.messages);
      assert(mode === "native" ? offered.some(tool => tool.name === "powershell")
        : offered.find(tool => tool.name === "codemode")?.description.includes("powershell"), "PowerShell must remain offered after configuration refresh");
      if (++requests === 1) return mode === "native" ? call("powershell", { command })
        : call("codemode", { code: `text(await tools.powershell(${JSON.stringify({ command })}));` });
      const results = context.messages.filter((message: any) => message.role === "toolResult");
      assert(results.some((message: any) => !message.isError && JSON.stringify(message.content).includes("POWERSHELL_UTF8_中文")), JSON.stringify(results));
      return text("powershell complete");
    }) });
  try {
    await runtime.configure(ref, mode, undefined, []);
    assert.equal((await (await runtime.submit("use PowerShell", `powershell-${mode}`)).wait(ctx)).status, "done");
    assert.equal(await readFile(join(cwd, fileName), "utf8"), proof, "argv execution preserves UTF-8, spaces and shell metacharacters");
    await runtime.refresh();
    assert(runtime.snapshot.messages.some(message => message.tools?.some(tool => tool.tool === "powershell" && tool.status === "success")));
  } finally { await runtime.close(); }
  console.log("PASS", mode, "native PowerShell argv execution, UTF-8, workspace cwd and refreshed tool configuration");
}
{
  const cwd = join(root, "provider-session"); await mkdir(cwd);
  const sessionIds: string[] = [];
  const api = models((_context, options) => { sessionIds.push(options.sessionId); return text("session affinity"); });
  const options = { directory: join(cwd, "state"), cwd, model: ref, toolMode: "native" as const,
    instructions: () => "fixture", models: api, onSnapshot: () => {} };
  let runtime = await DurableBotRuntime.open(options);
  try { await (await runtime.submit("first", "provider-first")).wait(ctx); }
  finally { await runtime.close(); }
  runtime = await DurableBotRuntime.open(options);
  try { await (await runtime.submit("after reopen", "provider-reopen")).wait(ctx); }
  finally { await runtime.close(); }
  const sibling = await DurableBotRuntime.open({ ...options, directory: join(cwd, "sibling-state") });
  try { await (await sibling.submit("sibling", "provider-sibling")).wait(ctx); }
  finally { await sibling.close(); }
  assert(sessionIds[0] && /^[0-9a-f-]{36}$/i.test(sessionIds[0]), "Durable forwards its native provider session UUID");
  assert.equal(sessionIds[1], sessionIds[0], "provider session identity survives JSONL reopen");
  assert.notEqual(sessionIds[2], sessionIds[0], "separate Bot conversations have separate provider cache affinity");
  console.log("PASS native provider session UUID persists on reopen and isolates conversations");
}
// Generated and decoded successfully by Pi's Photon runtime, including its strict PNG decoder.
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AACA//8EggJ/LF23YQAAAABJRU5ErkJggg==";
const decodedPng = await resizeImage(Buffer.from(tinyPng, "base64"), "image/png");
assert(decodedPng?.width === 1 && decodedPng.height === 1, "image fixture must pass Pi's real decoder rather than the raw-byte fallback");
for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode + "-image"); await mkdir(cwd);
  await writeFile(join(cwd, "input.png"), Buffer.from(tinyPng, "base64"));
  let requests = 0, restored = false;
  let outputImages: any[] = [];
  const api = models(context => {
    const input = context.messages.find((message: any) => message.role === "user" && Array.isArray(message.content) && message.content.some((part: any) => part.type === "image"));
    assert(input, "persisted user image reaches provider context before and after reopen");
    if (restored) return text("image reopen complete");
    if (++requests === 1) return mode === "native" ? call("read", { path: "input.png" })
      : call("codemode", { code: 'const r=await tools.read({path:"input.png"}); const img=r; if(img.type!=="image")throw Error("Image missing"); image(img); image(img);' });
    outputImages = context.messages.filter((message: any) => message.role === "toolResult").flatMap((message: any) => message.content.filter((part: any) => part.type === "image"));
    assert(outputImages.length >= (mode === "codemode" ? 2 : 1), "native read and Code Mode forward actual image blocks");
    return text("image complete");
  });
  api.getModel = () => ({ ...model, input: ["text", "image"] });
  const options = { directory: join(cwd, "state"), cwd, model: ref, toolMode: mode, instructions: () => "fixture", models: api, onSnapshot: () => {} };
  let runtime = await DurableBotRuntime.open(options);
  let imagePath: string | undefined;
  try {
    assert.equal((await (await runtime.submit([{ type: "text", text: "read image" }, { type: "image", data: tinyPng, mimeType: "image/png" }], `image-${mode}`)).wait(ctx)).status, "done");
    await runtime.refresh();
    if (mode === "codemode") {
      const artifacts = runtime.snapshot.messages.flatMap(message => message.artifacts ?? []);
      assert.equal(artifacts.length, 1, "duplicate image outputs share one persisted file/artifact");
      imagePath = artifacts[0].path;
      assert(imagePath && imagePath.startsWith(join(options.directory, "images")));
      assert((await readFile(imagePath)).equals(Buffer.from(outputImages[0].data, "base64")));
      assert(runtime.snapshot.messages.some(message => message.tools?.some(tool => tool.output?.includes(`Image saved to ${imagePath}`))), "model and transcript receive the real image file path");
    }
  } finally { await runtime.close(); }
  restored = true;
  runtime = await DurableBotRuntime.open(options);
  try {
    if (imagePath) assert(runtime.snapshot.messages.some(message => message.artifacts?.some(artifact => artifact.path === imagePath)), "saved image artifact restores from native results");
    assert.equal((await (await runtime.submit("after image reopen", `image-reopen-${mode}`)).wait(ctx)).status, "done");
  } finally { await runtime.close(); }
  console.log("PASS", mode, "native image read, provider image content, persistence, deduplication and reopen");
}
{
  const blocked = join(root, "blocked-image-directory"); await writeFile(blocked, "file prevents mkdir");
  const result = await persistDurableImages([{ type: "image", mimeType: "image/png", data: tinyPng }], join(blocked, "images"));
  assert.equal(result.paths.length, 0);
  assert(result.content.some(item => item.type === "image"));
  assert(result.content.some(item => item.type === "text" && item.text.includes("could not be saved")), "persistence errors remain diagnostic and keep the completed image output");
  console.log("PASS Code Mode image persistence failure retains model image content and a visible diagnostic");
}
{
  let refreshes = 0, locks = 0, baseUrl = "";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/metadata") {
      response.end(JSON.stringify({ issuer: baseUrl, authorization_endpoint: baseUrl + "/authorize", token_endpoint: baseUrl + "/token",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true }));
    } else if (request.url === "/token") {
      refreshes++; let body = ""; for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get("grant_type"), "refresh_token"); assert.equal(params.get("refresh_token"), "fixture-refresh");
      response.end(JSON.stringify({ access_token: "fixture-fresh", refresh_token: "fixture-rotated", token_type: "Bearer", expires_in: 3600 }));
    } else if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
      response.end(JSON.stringify({ resource: baseUrl + "/mcp", authorization_servers: [baseUrl] }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const serverUrl = baseUrl + "/mcp";
  let state: any = { serverUrl, clientInformation: { client_id: "fixture-client" },
    tokens: { access_token: "fixture-expired", refresh_token: "fixture-refresh", token_type: "Bearer" }, tokensExpireAt: 0 };
  const credentials: any = { forServer: (name: string, url: string) => {
    assert.equal(name, "fixture"); assert.equal(url, serverUrl);
    return { load: () => structuredClone(state), save: (next: any) => { state = structuredClone(next); },
      withRefreshLock: async (run: () => Promise<unknown>) => { locks++; return run(); } };
  } };
  const host = new DurableMcp();
  try {
    const auth = await (host as any).auth("fixture", { url: serverUrl, oauth: { clientRegistration: "cimd", clientId: "fixture-client", authServerMetadataUrl: baseUrl + "/metadata" } }, credentials, {});
    assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => auth.token())), Array(4).fill("fixture-fresh"));
    assert.equal(refreshes, 1); assert.equal(locks, 1, "concurrent requests share the native cross-process refresh lock");
    assert.equal(state.tokens.refresh_token, "fixture-rotated", "rotated tokens are durably saved before use");
    await assert.rejects(auth.onUnauthorized({ token: "fixture-fresh", response: new Response(null, { status: 401,
      headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="additional"' } }), fetch: globalThis.fetch }), (error: any) => error.name === "McpOAuthAuthorizationRequiredError");
    assert.equal(refreshes, 1, "additional scope requires plugin sign-in instead of repeated refresh");
    assert.equal(await (host as any).auth("fixture", { url: serverUrl, headers: { Authorization: "fixture-explicit" } }, credentials, {}), undefined);
  } finally { await host.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  console.log("PASS Bot native MCP OAuth: CIMD settings, metadata URL, proactive refresh, shared lock, rotated-token persistence and required sign-in for more scope");
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Durable test timed out"); await new Promise(r => setTimeout(r, 10)); }
}
// The original tool passes its initial guard, then waits for the actual MCP
// connection to initialize. A new input arriving here must stop tools/call.
for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, "late-mcp-fresh-" + mode); await mkdir(cwd);
  const audit = join(cwd, "audit.jsonl"), allowInitialize = join(cwd, "initialize");
  const config = { errors: [], servers: [{ name: "fixture", source: "isolated-mcp-fixture", config: {
    command: process.execPath, timeout: 20,
    args: [join(process.cwd(), "scripts/durable-mcp-lazy-fixture.mjs"), audit, allowInitialize],
  } }] };
  const host = await DurableMcp.open(config, {} as any, {} as any, cwd);
  const toolResults: string[] = [];
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref,
    toolMode: mode, tools: host.tools, prepareCodeMode: (code, context) => host.codeModeTools(code, context),
    instructions: () => "fixture", onSnapshot: () => {}, models: models(request => {
      const last = request.messages.at(-1);
      if (last?.role === "toolResult") toolResults.push(JSON.stringify(last.content));
      if (last?.role !== "user") return text("turn settled");
      const args = { server: "fixture", tool: "publish", arguments: { revision: JSON.stringify(last.content).includes("publish revised") ? "revised" : "original" } };
      return mode === "native" ? call("mcp_call_tool", args)
        : call("codemode", { code: `console.log(await tools.mcp_call_tool(${JSON.stringify(args)}));` });
    }) });
  try {
    const original = await runtime.submit("publish old", "original");
    await until(() => existsSync(audit));
    const revised = await runtime.submit("publish revised", "revised");
    assert.equal((await revised.status(ctx)).status, "queued");
    await writeFile(allowInitialize, "");
    assert.equal((await original.wait(ctx)).status, "done");
    assert.equal((await revised.wait(ctx)).status, "done");
    const events = (await readFile(audit, "utf8")).trim().split("\n").map(row => JSON.parse(row));
    assert.deepEqual(events.filter(row => row.event === "publish"), [{ event: "publish", revision: "revised" }]);
    assert.match(toolResults[0] ?? "", /较新的用户输入等待处理/);
    assert.match(toolResults[1] ?? "", /published revised/);
  } finally {
    await writeFile(allowInitialize, "");
    await runtime.close();
    await host.close();
  }
}
console.log("PASS real MCP stdio tools/call rechecks after initialization, in native and nested Code Mode");
// An MCP which never answers initialize must not delay a greeting or a different healthy tool.
{
  let blockedRequests = 0;
  const blocked = createServer(request => { assert.equal(request.headers.authorization, "fixture"); blockedRequests++; });
  await new Promise<void>(resolve => blocked.listen(0, "127.0.0.1", resolve));
  const config: any = { errors: [], servers: [
    { name: "fixture", config: { command: process.execPath, args: [join(process.cwd(), "scripts/durable-mcp-lazy-fixture.mjs"), join(root, "lazy-audit.jsonl")], toolExposure: { hidden_tool: "hidden" } } },
    { name: "blocked", config: { url: `http://127.0.0.1:${(blocked.address() as any).port}`, headers: { Authorization: "fixture" }, timeout: 0.2 } },
  ] };
  const audit = async () => { try { return (await readFile(join(root, "lazy-audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
  try {
    for (const mode of ["native", "codemode"] as const) {
      const cwd = join(root, "lazy-" + mode); await mkdir(cwd);
      const host = await DurableMcp.open(config, {} as any, {} as any, cwd);
      let phase = "greet", step = 0;
      const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode, instructions: () => "fixture", onSnapshot: () => {},
        tools: host.tools, restoreTools: names => host.restoreTools(names), prepareCodeMode: (code, context) => host.codeModeTools(code, context),
        models: models(context => {
          if (phase === "greet") return text("hello without MCP");
          const last = context.messages.at(-1);
          if (last?.role === "toolResult") assert(!last.isError, JSON.stringify(last));
          if (phase === "legacy") return ++step === 1 ? call("codemode", { code: 'text(await tools.mcp__fixture__read_cwd({label:"legacy"}));' }) : text("legacy works");
          if (phase === "enumerate") return ++step === 1 ? call("codemode", { code: 'const t=ALL_TOOLS.find(t=>t.name==="mcp__fixture__read_cwd"); if(!t)throw Error("missing"); text(await tools[t.name]({label:"enumerated"}));' }) : text("enumeration works");
          if (++step === 1) return mode === "native" ? call("mcp_list_tools", { server: "fixture" })
            : call("codemode", { code: 'const list=await tools.mcp_list_tools({server:"fixture"}); text(list); text(await tools.mcp_call_tool({server:"fixture",tool:"read_cwd",arguments:{label:"codemode"}}));' });
          if (mode === "native" && step === 2) return call("mcp_call_tool", { server: "fixture", tool: "read_cwd", arguments: { label: "native" } });
          return text("tool complete");
        }) });
      try {
        const before = (await audit()).length;
        const start = performance.now();
        await (await runtime.submit("hello", "greeting")).wait(ctx);
        assert(performance.now() - start < 1500, "greeting must not wait for MCP timeout");
        assert.equal((await audit()).length, before, "unused stdio server must not start");
        assert.equal(blockedRequests, 0, "unused HTTP server must not connect");
        phase = "tool";
        await (await runtime.submit("use fixture", "tool")).wait(ctx);
        await runtime.refresh(); assert.equal(runtime.snapshot.messages.at(-1)?.text, "tool complete");
        const events = await audit();
        assert.equal(events.filter(event => event.event === "start" && event.cwd === cwd).length, 1);
        assert(events.some(event => event.event === "call" && event.cwd === cwd && event.label === mode), JSON.stringify(events));
        assert.equal(blockedRequests, 0, "one tool must not connect another server");
        const list = host.tools.find(tool => tool.name === "mcp_list_tools")!;
        const results = await Promise.all([list.execute({server:"fixture"}, {} as any, ctx), list.execute({server:"fixture"}, {} as any, ctx)]);
        for (const result of results) { assert(result.output); assert(!JSON.parse((result.output[0] as any).text).tools.some((tool: any) => tool.name === "hidden_tool")); }
        const caller = host.tools.find(tool => tool.name === "mcp_call_tool")!;
        await assert.rejects(caller.execute({server:"fixture",tool:"hidden_tool",arguments:{}}, {} as any, ctx), /hidden/);
        await assert.rejects(caller.execute({server:"fixture",tool:"read_cwd",arguments:{}}, {} as any, ctx), /label/);
        const resources = await host.tools.find(tool => tool.name === "mcp_list_resources")!.execute({server:"fixture"}, {} as any, ctx);
        assert(JSON.stringify(resources).includes("fixture://cwd"));
        if (mode === "codemode") for (const legacy of ["legacy", "enumerate"]) {
          phase = legacy; step = 0;
          await (await runtime.submit(legacy, legacy)).wait(ctx);
          assert.equal(runtime.snapshot.error, undefined);
        }
        const state = await host.tools.find(tool => tool.name === "mcp_status")!.execute({}, {} as any, ctx);
        assert(state.output);
        assert.equal(JSON.parse((state.output[0] as any).text).servers.find((server: any) => server.name === "blocked").state, "idle");
        assert.equal(caller.replay, "unsafe");
        await assert.rejects(list.execute({server:"blocked"}, {} as any, ctx), /timed out|timeout/i);
        const again = await caller.execute({server:"fixture",tool:"read_cwd",arguments:{label:"after-failure"}}, {} as any, ctx);
        assert(JSON.stringify(again).includes("after-failure"), "failed server must not break healthy calls");
        blockedRequests = 0;
      } finally { await runtime.close(); await host.close(); }
      const reopenedHost = await DurableMcp.open(config, {} as any, {} as any, cwd);
      const reopened = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode, instructions: () => "fixture", onSnapshot: () => {}, tools: reopenedHost.tools,
        restoreTools: names => reopenedHost.restoreTools(names), prepareCodeMode: (code, context) => reopenedHost.codeModeTools(code, context), models: models(() => text("reopened greeting")) });
      try {
        const before = (await audit()).length;
        await (await reopened.submit("hello again", "reopened")).wait(ctx);
        assert.equal((await audit()).length, before, "restoring history must not reconnect MCP");
      } finally { await reopened.close(); await reopenedHost.close(); }
      console.log("PASS", mode, "lazy MCP: no startup gate, task CWD, discovery/call/resources, hidden/schema checks, reuse, failure isolation and history reopening");
    }
    const cwd = join(root, "legacy-mcp-native"); await mkdir(cwd);
    const oldHost = await DurableMcp.open(config, {} as any, {} as any, cwd);
    const old = await DurableBotRuntime.open({ directory: join(cwd,"state"), cwd, model: ref, toolMode: "native", instructions: () => "fixture", onSnapshot: () => {},
      tools: oldHost.restoreTools(["mcp__fixture__read_cwd"]), models: models(() => text("old history")) });
    await (await old.submit("old input", "old-input")).wait(ctx); await old.close(); await oldHost.close();
    const startCount = (await audit()).filter(event => event.event === "start").length;
    const host = await DurableMcp.open(config, {} as any, {} as any, cwd);
    let steps = 0;
    const resumed = await DurableBotRuntime.open({ directory: join(cwd,"state"), cwd, model: ref, toolMode: "native", instructions: () => "fixture", onSnapshot: () => {},
      tools: host.tools, restoreTools: names => host.restoreTools(names), models: models(context => {
        assert(getCurrentTools(context.messages).some(tool => tool.name === "mcp__fixture__read_cwd"), "stored native selections must resolve before reconfiguration");
        return ++steps === 1 ? call("mcp__fixture__read_cwd", { label: "legacy-native" }) : text("legacy native complete");
      }) });
    try {
      assert.equal((await audit()).filter(event => event.event === "start").length, startCount);
      await (await resumed.submit("continue old native selection", "legacy-native")).wait(ctx); await resumed.refresh();
      assert.equal(resumed.snapshot.messages.at(-1)?.text, "legacy native complete");
      assert((await audit()).some(event => event.cwd === cwd && event.label === "legacy-native"));
      console.log("PASS old persisted MCP names resolve and execute through native Durable after reopen");
    } finally { await resumed.close(); await host.close(); }
  } finally { blocked.closeAllConnections(); await new Promise<void>(resolve => blocked.close(() => resolve())); }
}
for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode + "-recovery"); await mkdir(cwd);
  let calls = 0, started = 0, received = 0;
  const external = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/fixture-effect");
    request.resume();
    request.once("end", () => { received++; });
    // External acceptance has happened, but the tool cannot observe a receipt.
    response.on("error", () => {});
  });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  const port = (external.address() as { port: number }).port;
  const hold = defineTool({ name: "hold", description: "fixture HTTP effect", parameters: Type.Object({}), replay: "unsafe",
    execute: async (_args, _api, context) => { started++;
      await fetch(`http://127.0.0.1:${port}/fixture-effect`, { method: "POST", body: "fixture", signal: context.abortSignal });
      return {output:text("unexpected receipt")};
    } });
  try {
  const options = { directory:join(cwd,"state"), cwd, model:ref, toolMode:mode, instructions:()=>"fixture", tools:[hold],onSnapshot:()=>{},
    models:models(()=> ++calls === 1 ? mode === "native" ? call("hold",{}) : call("codemode",{code:"await tools.hold({});"}) : text("recovered")) };
  let runtime = await DurableBotRuntime.open(options);
  const first = await runtime.submit("hold", "hold-request");
  await until(()=>started === 1 && received === 1);
  const queued = await runtime.submit("after restart", "queued-request", "followUp");
  assert.equal((await queued.status(ctx)).status,"queued");
  assert.equal(runtime.snapshot.pendingInputs[0]?.text,"after restart");
  await runtime.close();
  runtime = await DurableBotRuntime.open({...options,toolMode:mode === "native" ? "codemode" : "native"});
  assert.equal(runtime.snapshot.toolMode, mode, "persisted agent must win over default on restart");
  runtime.resume();
  assert.equal((await (await runtime.harness.submission(first.id,ctx))!.wait(ctx)).status,"done");
  assert.equal((await (await runtime.harness.submission(queued.id,ctx))!.wait(ctx)).status,"done");
  assert.equal(started,1,"unsafe tool must not execute twice after restart");
  assert.equal(received,1,"fake third party received the write exactly once");
  assert(!runtime.snapshot.messages.some(message => message.text.includes("unexpected receipt")));

  await runtime.conversation.waitForIdle(ctx);
  await runtime.refresh(); assert.equal(runtime.snapshot.busy,false);
  assert(runtime.snapshot.messages.some(m=>m.tools?.some(t=>t.status==="error")),"interrupted tool must be visible");
  await runtime.configure(ref,"native");
  assert.equal((await runtime.submit("new turn", "switch-tag")).id > first.id,true);
  await runtime.close();
  console.log("PASS",mode,"HTTP accepted once without receipt, preserved submission, no unsafe replay", { submissionId: first.id, received });
  } finally { external.closeAllConnections(); await new Promise<void>(resolve => external.close(() => resolve())); }
}
{
  const cwd=join(root,"abort"); await mkdir(cwd);
  let started=false;
  const runtime=await DurableBotRuntime.open({directory:join(cwd,"state"),cwd,model:ref,toolMode:"native",instructions:()=>"fixture",onSnapshot:()=>{},
    models:models(()=>call("hold",{})),tools:[defineTool({name:"hold",description:"hold",parameters:Type.Object({}),replay:"unsafe",execute:async(_a,_api,c)=>{
      started=true; const signal = c.abortSignal; assert(signal); await new Promise((_r,reject)=>signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true})); return {};
    }})]});
  const first=await runtime.submit("hold","first"); await until(()=>started);
  const second=await runtime.submit("queued","second"); await runtime.abort();
  assert.equal((await first.wait(ctx)).status,"unanswered"); assert.equal((await second.wait(ctx)).status,"unanswered");
  assert.equal(runtime.snapshot.busy,false); assert.equal(runtime.snapshot.queued,0);
  await runtime.close(); console.log("PASS native abort stops tool and withdraws queued input");
}
{
  const cwd = join(root,"compaction"); await mkdir(cwd);
  let summaries = 0;
  const api = models((context) => {
    if (JSON.stringify(context.messages[0]).includes("summar")) { summaries++; return text("persisted checkpoint summary"); }
    return text("completed turn");
  });
  const options = {directory:join(cwd,"state"),cwd,model:ref,toolMode:"native" as const,instructions:()=>"fixture",models:api,onSnapshot:()=>{}};
  let runtime = await DurableBotRuntime.open(options);
  for(let i=0;i<3;i++) await (await runtime.submit(`turn ${i} ` + "context ".repeat(12000), `compact-${i}`)).wait(ctx);
  await runtime.conversation.waitForIdle(ctx);
  const before = (await runtime.refresh()).messages;
  await runtime.compact();
  assert(summaries > 0, "native summarizer must actually run");
  assert.deepEqual(runtime.snapshot.messages,before,"compaction must not truncate full UI history");
  await runtime.close(); runtime = await DurableBotRuntime.open(options);
  assert.deepEqual(runtime.snapshot.messages,before,"reopen restores messages preceding compaction");
  await runtime.close(); console.log("PASS native compaction keeps complete UI snapshot across restart");
}
{
  const cwd=join(root,"stream-retry"); await mkdir(cwd);
  let attempts=0, sawRetry=false, sawStreaming=false;
  const sessionIds: string[] = [];
  const api=models(()=>text("stream complete"));
  const real=api.streamSimple;
  api.streamSimple=(model:any,context:any,options:any)=>{
    sessionIds.push(options.sessionId);
    const stream=createAssistantMessageEventStream();
    if(++attempts===1) {
      void real(model,context,options).result().then((base:any)=>{
        stream.push({type:"error",reason:"error",error:{...base,stopReason:"error",errorMessage:"429 rate limit"}});stream.end();
      });
      return stream;
    }
    void real(model,context,options).result().then(async(base:any)=>{
      const partial={...base,content:[{type:"text",text:"stream"}]};
      stream.push({type:"start",partial:structuredClone(partial)});
      stream.push({type:"text_delta",contentIndex:0,delta:"stream",partial:structuredClone(partial)});
      await new Promise(r=>setTimeout(r,120));
      stream.push({type:"done",reason:"stop",message:base}); stream.end();
    });
    return stream;
  };
  const runtime=await DurableBotRuntime.open({directory:join(cwd,"state"),cwd,model:ref,toolMode:"native",instructions:()=>"fixture",models:api,
    onSnapshot:s=>{sawRetry ||= !!s.retry;sawStreaming ||= s.messages.some(m=>m.streaming&&m.text==="stream");}});
  await (await runtime.submit("retry and stream","retry-stream")).wait(ctx);await runtime.refresh();
  assert.equal(attempts,2);assert(sawRetry,"native retry status projected");assert(sawStreaming,"native streaming partial projected");
  assert(sessionIds[0]); assert.equal(sessionIds[1],sessionIds[0],"native retry keeps provider session affinity");
  assert.equal(runtime.snapshot.messages.at(-1)?.text,"stream complete");await runtime.close();
  console.log("PASS native retry and streaming snapshot");
}
{
  const agentDir = join(root, "purge-profile"); await mkdir(agentDir);
  const db = new AppDatabase(join(agentDir, "app.db"));
  const taskId = "purge-bot", siblingId = "keep-bot";
  const directory = (id: string) => join(agentDir, "durable", createHash("sha256").update(id).digest("hex"));
  for (const id of [taskId, siblingId]) {
    db.upsertTask({ id, title: id, welcomeMode: "general", updatedAt: Date.now() });
    await mkdir(directory(id), { recursive: true });
    await writeFile(join(directory(id), "history.jsonl"), id);
  }
  const service = new DurableBotService({ db, agentDir, mcpDir: join(agentDir, "mcp"), models: {} as any,
    resolveCwd: () => root, instructions: () => "", toolMode: () => "native", defaultModel: () => undefined, emit: () => {} });
  try {
    await assert.rejects(service.purge(taskId), /permanently deleted/);
    db.archiveTask(taskId, true);
    await assert.rejects(service.purge(taskId), /permanently deleted/, "archived history must remain recoverable");
    db.deleteTask(taskId);
    await service.purge(taskId);
    await assert.rejects(access(directory(taskId)));
    assert.equal(await readFile(join(directory(siblingId), "history.jsonl"), "utf8"), siblingId);
    await service.purge(taskId); // Idempotent lifecycle cleanup.
  } finally { await service.close(); db.close(); }
  console.log("PASS permanent purge removes only its Durable history; active/archive and sibling data preserved");
}
{
  const cwd = join(root, "extension-metadata"); await mkdir(cwd);
  let stage = "save";
  const api = models(context => context.messages.at(-1)?.role === "toolResult" ? text("metadata complete")
    : call("codemode", { code: stage === "save" ? "await tools.remember_fixture({});" : "text(await tools.recall_fixture({}));" }));
  const domain = await durableDomainTools([pi => {
    pi.registerTool({ name: "remember_fixture", label: "remember", description: "fixture", parameters: Type.Object({}), execute: async () => {
      pi.appendEntry("web-search-results", { id: "native-search-fixture", type: "search", timestamp: Date.now(), queries: [{ query: "q", answer: "persisted source", results: [], error: null }] });
      return { content: text("saved") as any, details: {} };
    } });
    pi.registerTool({ name: "recall_fixture", label: "recall", description: "fixture", parameters: Type.Object({}), execute: async () => {
      assert.equal(getResult("native-search-fixture")?.queries?.[0]?.answer, "persisted source");
      return { content: text("restored source") as any, details: {} };
    } });
  }], { cwd, models: api });
  const options = { directory: join(cwd, "state"), cwd, model: ref, toolMode: "codemode" as const, instructions: () => "fixture", models: api, tools: domain.tools, contextHooks: domain.contextHooks, onSnapshot: () => {} };
  let runtime = await DurableBotRuntime.open(options);
  await (await runtime.submit("save", "save-metadata")).wait(ctx);
  await runtime.close(); clearResults(); stage = "recall";
  runtime = await DurableBotRuntime.open(options);
  try {
    await (await runtime.submit("recall", "recall-metadata")).wait(ctx);
    await runtime.conversation.waitForIdle(ctx);
    await runtime.refresh();
    assert(runtime.snapshot.messages.some(m => m.tools?.some(t => t.tool === "recall_fixture" && t.status === "success")), "metadata lookup must succeed after restart");
    assert(runtime.snapshot.messages.some(m => m.tools?.some(t => t.tool === "codemode" && t.status === "success" && t.output?.includes("restored source"))), "restored metadata must reach the persisted Code Mode output");
  } finally { await runtime.close(); clearResults(); }
  console.log("PASS extension metadata survives restart and new Code Mode child ownership");
}
{
  // 真实事故：网关路由重组把 magpie/commandcode/* 整组下线，任务里持久化的 model_id 变成悬空坐标，
  // 打开历史时被当成会话损坏（「会话记录打不开 / Bot 模型不存在」）。解析规则必须确定且可解释。
  const magpie = (id: string, name: string): any => ({ ...model, provider: "magpie", id, name });
  const catalogModels = [magpie("workbuddy/glm-5.3-flash", "GLM-5.3-Flash · WorkBuddy"),
    magpie("opendesign/glm-5.3-flash", "GLM 5.3 Flash"), magpie("workbuddy/deepseek-v4.1-flash", "Deepseek-V4.1-Flash · WorkBuddy")];
  const catalog: any = {
    getModel: (provider: string, id: string) => catalogModels.find(candidate => candidate.provider === provider && candidate.id === id),
    getModels: () => catalogModels,
    getAvailable: async () => catalogModels,
  };
  const exact = await resolveBotModel(catalog, "magpie/workbuddy/glm-5.3-flash");
  assert.equal(modelKey(exact.target), "magpie/workbuddy/glm-5.3-flash");
  assert.equal(exact.repairedFrom, undefined, "目录里仍可解析的任务模型必须原样使用");
  const drift = await resolveBotModel(catalog, "magpie/commandcode/z-ai/glm-5.3-flash");
  assert.equal(modelKey(drift.target), "magpie/workbuddy/glm-5.3-flash", "同 provider 同名模型换路由：保留模型家族与网关");
  assert.equal(drift.repairedFrom, "magpie/commandcode/z-ai/glm-5.3-flash");
  assert.equal(drift.reason, "same-model-other-route");
  const defaulted = await resolveBotModel(catalog, "magpie/commandcode/z-ai/kimi-k2.6", "magpie/workbuddy/deepseek-v4.1-flash");
  assert.equal(modelKey(defaulted.target), "magpie/workbuddy/deepseek-v4.1-flash", "同名路由不存在时退到全局默认模型");
  assert.equal(defaulted.reason, "default-model");
  const variant = await resolveBotModel(catalog, "magpie/commandcode/deepseek/deepseek-v4.1-flash-fast");
  assert.equal(modelKey(variant.target), "magpie/workbuddy/deepseek-v4.1-flash", "路由变体（-fast）没有对应目录项时按同一模型匹配，而不是跳默认模型");
  await assert.rejects(resolveBotModel({ getModel: () => undefined, getModels: () => [], getAvailable: async () => [] },
    "magpie/commandcode/z-ai/glm-5.3-flash"), /已不在模型目录中，且当前没有其它可用模型/, "无任何可用模型时必须明确报错，不能静默成功");
  console.log("PASS 模型目录漂移解析：精确命中 / 同名换路由 / 默认模型 / 无模型明确报错");
}
{
  // 历史读取不修复配置；进入执行运行时后才修复悬空模型并如实告知用户。
  const agentDir = join(root, "model-drift"); await mkdir(agentDir);
  const cwd = join(agentDir, "cwd"); await mkdir(cwd);
  const db = new AppDatabase(join(agentDir, "app.db"));
  const taskId = "drifted-bot", staleId = "magpie/commandcode/z-ai/glm-5.3-flash";
  db.upsertTask({ id: taskId, title: "录音笔", welcomeMode: "general", modelId: staleId, cwd, updatedAt: Date.now() });
  const directory = join(agentDir, "durable", createHash("sha256").update(taskId).digest("hex"));
  await mkdir(directory, { recursive: true });
  const magpie = (id: string, name: string): any => ({ ...model, provider: "magpie", id, name });
  const catalogModels = [magpie("workbuddy/glm-5.3-flash", "GLM-5.3-Flash · WorkBuddy"), magpie("workbuddy/deepseek-v4.1-flash", "Deepseek-V4.1-Flash · WorkBuddy")];
  const modelsStub: any = {
    getAuth: async () => undefined,
    getModel: (provider: string, id: string) => catalogModels.find(candidate => candidate.provider === provider && candidate.id === id),
    getModels: () => catalogModels, getAvailable: async () => catalogModels, refresh: async () => ({}),
  };
  const service = new DurableBotService({ db, agentDir, mcpDir: join(agentDir, "mcp"), models: modelsStub,
    resolveCwd: () => cwd, instructions: () => "", toolMode: () => "native", defaultModel: () => "magpie/workbuddy/deepseek-v4.1-flash", emit: () => {} });
  db.connection.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
  try {
    const history = await service.history(taskId);
    assert.equal(history.historyError, undefined, "模型下线不能被当成会话损坏（这才是「会话记录打不开」的根因）");
    assert.equal(history.modelRecovery, undefined, "只读历史不能触发模型修复");
    assert.equal(history.modelId, staleId);
    assert.equal(db.getTask(taskId)!.modelId, staleId);
    // This explicit execution-session operation may open/configure the writer; no provider request is needed.
    assert.equal(await service.findSubmission(taskId, "missing-fixture-operation"), undefined);
    const configured = await service.history(taskId);
    assert.deepEqual(configured.modelRecovery, { from: staleId, to: "magpie/workbuddy/glm-5.3-flash" });
    assert.equal(configured.modelId, "magpie/workbuddy/glm-5.3-flash");
    assert.equal(db.getTask(taskId)!.modelId, "magpie/workbuddy/glm-5.3-flash", "修复必须写回任务，输入框才不会继续显示已下线模型");
    await service.release(taskId);
    const reopened = await service.history(taskId);
    assert.equal(reopened.modelRecovery, undefined, "任务模型已修复，重开不再重复提示");
    assert.equal(db.getTask(taskId)!.modelId, "magpie/workbuddy/glm-5.3-flash");
  } finally { await service.close(); db.close(); }
  console.log("PASS 悬空模型不阻塞只读历史：仅执行运行时修复同名路由 + 写回任务 + 一次性告知");
}
{
  // 真实事故 2：图片淘汰这类扩展钩子 `pi.on("context")` 被 Durable 桥接层直接拒绝，
  // 报「Unsupported execution hook: context」，让所有 Bot 会话打不开 —— 与读历史毫无关系。
  const cwd = join(root, "context-hook"); await mkdir(cwd);
  const domain = await durableDomainTools([pi => {
    pi.on("context", (event: any) => ({
      messages: event.messages.map((message: any) => message.role === "user" && typeof message.content === "string"
        ? { ...message, content: `[aged] ${message.content}` } : message),
    }));
    pi.on("session_start", () => { throw new Error("ignored hook must never run"); });
  }], { cwd, models: models(() => text("unused")) });
  assert.equal(domain.contextHooks.length, 1, "context 钩子必须被收集，而不是抛错");
  assert.equal(domain.tools.length, 0);
  let seen: any[] = [];
  const api = models(context => { seen = context.messages; return text("hooked"); });
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: "native",
    instructions: () => "fixture", models: api, tools: domain.tools, contextHooks: domain.contextHooks, onSnapshot: () => {} });
  try {
    await (await runtime.submit("hello", "context-hook")).wait(ctx);
    const userTexts = seen.filter(message => message.role === "user")
      .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    assert(userTexts.some(value => value.includes("[aged] hello")), "context 钩子必须在真实请求前改写模型上下文");
  } finally { await runtime.close(); }
  console.log("PASS 扩展 context 钩子转发到 Durable beforeRequest；未知钩子不再让 Bot 打不开");
}
{
  // 设计边界：读历史 = 读 Durable 存储，不应经过模型解析。模型目录为空也必须能打开，且不改写任务配置。
  const agentDir = join(root, "no-model-history"); await mkdir(agentDir);
  const cwd = join(agentDir, "cwd"); await mkdir(cwd);
  const db = new AppDatabase(join(agentDir, "app.db"));
  const taskId = "no-model-bot", storedModel = "magpie/commandcode/z-ai/glm-5.3-flash";
  db.upsertTask({ id: taskId, title: "录音笔", welcomeMode: "general", modelId: storedModel, cwd, updatedAt: Date.now() });
  const directory = join(agentDir, "durable", createHash("sha256").update(taskId).digest("hex"));
  await mkdir(directory, { recursive: true });
  const emptyModels: any = { getAuth: async () => undefined, getModel: () => undefined, getModels: () => [], getAvailable: async () => [], refresh: async () => ({}) };
  const seeded = await DurableBotRuntime.open({ directory, cwd, model: ref, toolMode: "native",
    models: models(() => text("persisted history without a model catalog")), instructions: () => "fixture", onSnapshot: () => {} });
  await (await seeded.submit("seed actual history", "history-seed")).wait(ctx);
  await seeded.conversation.waitForIdle(ctx);
  await seeded.close();
  const service = new DurableBotService({ db, agentDir, mcpDir: join(agentDir, "mcp"), models: emptyModels,
    // 扩展工厂自身抛错同样不能阻断只读历史；发请求时才严格重新装配。
    tools: () => { throw new Error("extension factory boom"); },
    resolveCwd: () => cwd, instructions: () => "", toolMode: () => "native", defaultModel: () => undefined, emit: () => {} });
  db.connection.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
  try {
    const history = await service.history(taskId);
    assert.equal(history.historyError, undefined, "模型目录为空不能把历史变成打不开（模型只属于发请求）");
    assert.equal(history.durable?.backend, "pi-durable");
    assert(history.messages.some(message => message.text === "persisted history without a model catalog"));
    assert.equal(db.getTask(taskId)!.modelId, storedModel, "只读打开不得改写任务配置");
    await assert.rejects(service.submit({ taskId, userMessageId: "must-not-run", assistantMessageId: "must-not-run-answer", text: "not a history read" }),
      /extension factory boom/, "execution must rebuild the real tool factory and fail, rather than use the viewer");
  } finally { await service.close(); db.close(); }
  console.log("PASS 只读历史与模型目录解耦：没有可用模型也能打开，且不改写任务");
}
await (await import("./durable-dots-reply-test")).verifyDurableDotsReplies(join(root, "dots-assistant-replies"));
console.log("Durable Bot tests passed");
