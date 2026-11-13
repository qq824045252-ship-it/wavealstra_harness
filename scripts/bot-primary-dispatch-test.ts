import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotOrganizationService } from "../src/main/agent/work/BotOrganizationService";
import { BotCreationService } from "../src/main/agent/work/BotCreationService";
import { ExpertService } from "../src/main/experts/ExpertService";
import { TaskExpertBindingService } from "../src/main/experts/TaskExpertBindingService";
import { BotExpertBindingService } from "../src/main/agent/work/BotExpertBindingService";
import { BotSettingsService } from "../src/main/agent/work/BotSettingsService";
import { BotConversationService, type BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

// Inference and Work scheduling are explicit controlled doubles. This verifies
// production prompt/catalogue/tool wiring with real SQLite and foreground/peer
// services, not real model semantics or actual Work execution/artifact quality.
const root = mkdtempSync(join(tmpdir(), "primary-dispatch-"));
const app = new AppDatabase(join(root, "app.db")), db = app.connection;
const bots = new BotRegistry(db); bots.ensureDefaultBot(LOCAL_USER_ID);
const responsibility = { learner: "制定认知巩固方案、讲解概念、持续辅导与复盘", tester: "设计软件质量验证方案、复现缺陷、核对边界和验收证据" };
for (const [id, summary] of Object.entries(responsibility)) bots.registerBot({ botId: id, userId: LOCAL_USER_ID,
  // Deliberately misleading names; the configured responsibilities are authority.
  displayName: id === "learner" ? "测试专家" : "学习搭子", responsibilitySummary: summary, authorization: DESKTOP_USER_GRANTS });
bots.registerBot({ botId: "foreign", userId: "someone-else", displayName: "别人的 Bot", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db, { bots });
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
  modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
const catalogueSchema = z.object({ bots: z.array(z.object({ botId: z.string(), displayName: z.string(), responsibilitySummary: z.string(),
  status: z.string(), settingsRevision: z.number() })), totalBots: z.number(), nextBotId: z.string().nullable() });
const cases = new Map<string, { text: string; responsibility?: string; explicitBotId?: string; direct?: boolean; work?: boolean }>([
  ["learn", { text: "我总记不住条件概率，给我安排三天循序渐进的巩固练习并复盘薄弱点", responsibility: responsibility.learner }],
  ["test", { text: "替这个登录流程逐项验证越权、失效令牌和异常输入，整理可复现的证据", responsibility: responsibility.tester }],
  ["explicit", { text: "让学习搭子负责给我准备条件概率的练习", responsibility: responsibility.learner, explicitBotId: "tester" }],
  ["chat", { text: "你好，今天心情不错", direct: true }],
  ["self", { text: "这次请你自己给我安排概率巩固计划，不交给其他人", direct: true }],
  ["missing", { text: "帮我制定架子鼓巡演的布台方案", direct: true }],
  ["unavailable", { text: "把条件概率巩固交给测试专家，不可用时请继续处理", explicitBotId: "learner" }],
  ["work", { text: "为登录异常路径产出一份完整核验报告", responsibility: responsibility.tester, work: true }],
]);
const observed: Array<{ model: string; tag: string; context: Context }> = [];
let sequence = 0, receiverRelease: (() => void) | undefined;
let receiverGate: Promise<void> | undefined;
const contentText = (value: Context["messages"][number]["content"]) => typeof value === "string" ? value
  : value.filter(part => part.type === "text").map(part => part.text).join("\n");
const requestText = (value: Context["messages"][number]["content"]) => {
  if (typeof value === "string") return value;
  const part = value.find(part => part.type === "text");
  return part?.type === "text" ? part.text : "";
};
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
models.registerProvider("dispatch-fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [DEFAULT_BOT_ID, "learner", "tester"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, context) => {
    const stream = createAssistantMessageEventStream();
    const user = [...context.messages].reverse().find(item => item.role === "user");
    const input = user ? requestText(user.content) : "";
    const tag = [...input.matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] ?? "plain";
    observed.push({ model: model.id, tag, context: structuredClone(context) });
    queueMicrotask(async () => {
      try {
        if (model.id !== DEFAULT_BOT_ID && receiverGate) await receiverGate;
        const scenario = cases.get(tag), afterTool = context.messages.at(-1)?.role === "toolResult";
        const isReturn = input.includes("成果回流");
        let content: AssistantMessage["content"] = [{ type: "text", text: model.id === DEFAULT_BOT_ID
          ? `主 Bot ${isReturn ? "整理成果" : "直接答复或确认真实回执"} CASE:${tag}` : `目标实际答复 CASE:${tag}` }];
        if (model.id === DEFAULT_BOT_ID && scenario && !scenario.direct && !afterTool && !isReturn) {
          const instructions = context.messages.filter(item => item.role === "system").map(item => [contentText(item.content), ...Object.values(item.sections ?? {})].join("\n")).join("\n");
          assert(instructions.includes("主 Bot 默认选派策略"));
          const directoryText = instructions.split("宿主实时职责/能力目录（按 ID 提供给你判断，未作相关性排名）：")[1].split("。目录有 nextBotId")[0];
          const directory = catalogueSchema.parse(JSON.parse(directoryText));
          assert(!directory.bots.some(item => item.botId === "foreign"));
          const target = scenario.explicitBotId ? directory.bots.find(item => item.botId === scenario.explicitBotId)
            : directory.bots.find(item => item.responsibilitySummary === scenario.responsibility && item.status === "active");
          assert(target, "scripted semantic choice consumes actual configured metadata");
          content = [{ type: "toolCall", id: `dispatch-${++sequence}`, name: "bot_organize", arguments: {
            action: "dispatch", targetBotId: target.botId, settingsRevision: target.settingsRevision,
            text: scenario.text + ` CASE:${tag}`, reason: scenario.explicitBotId ? "用户明确点名覆盖默认职责匹配" : `原目标与职责关联：${target.responsibilitySummary}` } }];
        } else if (model.id !== DEFAULT_BOT_ID && scenario?.work && !afterTool) content = [{ type: "toolCall", id: `work-${++sequence}`,
          name: "work_create", arguments: { title: `目标自主计划 CASE:${tag}`, goalDescription: "接收前台自主决定的报告任务", mode: "once", requestedOutcome: "one_time" } }];
        const message: AssistantMessage = { role: "assistant", content, stopReason: content.some(item => item.type === "toolCall") ? "toolUse" : "stop",
          provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), usage: usage() };
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end();
      } catch (error) {
        const message: AssistantMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: String(error),
          provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), usage: usage() };
        stream.push({ type: "error", reason: "error", error: message }); stream.end();
      }
    }); return stream;
  } });
const experts = new ExpertService();
const tasks = new TaskExpertBindingService(app, experts, { rootDir: join(root, "task-experts"), isSkillEnabled: () => true });
const binding = new BotExpertBindingService(bots, experts, tasks, { rootDir: join(root, "bot-experts") });
const settings = new BotSettingsService(app, bots, LOCAL_USER_ID, join(root, "workspaces"), async () => ({
  models: [DEFAULT_BOT_ID, "learner", "tester"].map(id => ({ id: `dispatch-fixture/${id}`, name: id, available: true })),
  experts: [], skills: [], mcps: [], connectors: [],
}), input => binding.assembleSettings(input, LOCAL_USER_ID));
const creator = new BotCreationService(db, bots, { userId: LOCAL_USER_ID, isAuthority: () => true });
for (const botId of [DEFAULT_BOT_ID, "learner", "tester"]) {
  const workspacePath = join(root, botId); mkdirSync(workspacePath);
  await settings.save({ botId, expectedRevision: 0, workspacePath, modelId: `dispatch-fixture/${botId}`,
    expertId: "", skillIds: [], mcpIds: [], connectorIds: [] });
}
const schedules: string[] = [];
let failPreparation = false;
const options: BotConversationServiceOptions = { db, bots, works, models, userId: LOCAL_USER_ID, directory: join(root, "durable"),
  defaultModel: () => `dispatch-fixture/${DEFAULT_BOT_ID}`, isAuthority: () => true, memorySearch: () => [],
  botModel: botId => settings.get(botId).modelId, botWorkspace: botId => settings.resolveWorkspace(botId, true),
  prepareMessage: botId => { if (failPreparation && botId === "learner") throw Error("controlled target freeze unavailable");
    return settings.prepareMessage(botId); }, captureSettings: (id, botId, value) => settings.captureMessage(id, botId, value),
  messageSettings: (id, botId) => settings.messageSettings(id, botId), organization: { settings, creator },
  schedule: work => { schedules.push(work.workId); }, wake: () => {} };
let service = new BotConversationService(options);
const count = (table: string) => z.object({ n: z.number() }).parse(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n;
const wait = async (predicate: () => boolean, description: string) => {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(20); } throw Error(`timeout ${description}: ${JSON.stringify(db.prepare("SELECT bot_id,role,status,error FROM bot_messages").all())}; calls=${JSON.stringify(observed.map(item => ({ model: item.model, tag: item.tag })))}`);
};
const send = (tag: string) => { const scenario = cases.get(tag)!; return service.send({ botId: DEFAULT_BOT_ID,
  requestId: `request-${tag}`, text: `${scenario.text} CASE:${tag}` }); };
const dispatch = (parent: string, targetBotId: string, text = "同一用户目标", revision = settings.get(targetBotId).revision) =>
  service.organizations!.command(parent, randomUUID(), { action: "dispatch", targetBotId, settingsRevision: revision, text, reason: "受控语义选择替身" });
const boundaryFailures: Error[] = [];
async function boundary(name: string, check: () => Promise<void>) {
  try { await check(); console.log(`PASS boundary: ${name}`); }
  catch (error) { const failure = error instanceof Error ? error : Error(String(error)); boundaryFailures.push(failure); console.error(`FAIL boundary: ${name}: ${failure.message}`); }
}
const request = (text: string) => service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: randomUUID(), text });
async function checkpoint(targetBotId: string) {
  const origin = request(`原始用户目标 checkpoint ${randomUUID()}`);
  const crashing = new BotOrganizationService({ ...options, settings, creator, messages: service.messages,
    collaborations: service.collaborations, publish: () => { throw Error("controlled crash after journal commit"); } });
  await assert.rejects(crashing.command(origin.assistantMessageId, "admit-before-crash", { action: "dispatch",
    targetBotId, settingsRevision: settings.get(targetBotId).revision, text: "持久派送目标", reason: "故障注入" }), /controlled crash/);
  const row = z.object({ organization_id: z.string(), expected_revision: z.number(), applied_revision: z.number().nullable(), value_json: z.string() }).parse(
    db.prepare("SELECT * FROM bot_organization_records WHERE json_extract(origin_json,'$.user_message_id')=?").get(origin.userMessageId));
  assert.equal(JSON.parse(row.value_json).phase, "configuring"); assert.equal(row.applied_revision, null);
  return { origin, row };
}
const intentSchema = z.object({ organization: z.object({ intentId: z.string(), phase: z.string(), collaborationId: z.string().nullable(),
  target: z.object({ botId: z.string() }) }) });
try {
  for (const [tag, expected] of [["learn", "learner"], ["test", "tester"], ["explicit", "tester"]]) {
    const receipt = send(tag);
    await wait(() => service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, receipt.assistantMessageId).some(item => item.status === "returned"), `dispatch and return ${tag}`);
    const relation = service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, receipt.assistantMessageId)[0];
    assert.equal(relation.targetBotId, expected); assert.equal(relation.sourceUserMessageId, receipt.userMessageId);
    assert.equal(relation.workId, null); assert(relation.times.deliveredAt); assert(relation.times.returnedAt);
    if (tag === "test") {
      const turn = observed.find(item => item.model === DEFAULT_BOT_ID && item.tag === tag)!;
      const current = [...turn.context.messages].reverse().find(message => message.role === "user")!;
      assert.equal(requestText(current.content), `${cases.get(tag)!.text} CASE:${tag}`);
      assert(contentText(current.content).includes("CASE:learn"), "the fixture must route the current request even when a different prior goal remains in its source index");
    }
    assert(observed.some(item => item.model === DEFAULT_BOT_ID && item.tag === tag && item.context.messages.some(message => contentText(message.content).includes("目标实际答复"))), "result returns through A foreground");
  }
  assert.equal(count("bots"), 4); assert.equal(count("works"), 0); assert.equal(count("work_teams"), 0);
  console.log("PASS scripted semantic routing through actual foreground: unnamed learning/testing, misleading display names, explicit target override, actual return to A");
  for (const tag of ["chat", "self", "missing"]) {
    const before = count("bot_collaborations"), receipt = send(tag);
    await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", tag);
    assert.equal(count("bot_collaborations"), before); assert.equal(count("works"), 0);
  }
  console.log("PASS direct chat, user asks primary to handle, no suitable Bot: no invented delegation/creation");
  db.prepare("UPDATE bots SET status='paused' WHERE bot_id='learner'").run();
  const unavailableReceipt = send("unavailable");
  await wait(() => service.messages.message(unavailableReceipt.assistantMessageId)?.status === "completed", "primary continues after unavailable target tool error");
  assert.equal(service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, unavailableReceipt.assistantMessageId).length, 0);
  assert(observed.filter(item => item.tag === "unavailable" && item.model === DEFAULT_BOT_ID).length >= 2, "foreground continues after actual dispatch failure");
  const manual = service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "manual", text: "原始用户目标" });
  const before = count("bot_organization_records");
  await assert.rejects(dispatch(manual.assistantMessageId, "learner"), /dispatch_not_sent/);
  await assert.rejects(dispatch(manual.assistantMessageId, "foreign", "intent", 0), /dispatch_not_sent/);
  await assert.rejects(dispatch(manual.assistantMessageId, "tester", "intent", -0 + 999), /dispatch_not_sent/);
  assert.equal(count("bot_organization_records"), before);
  db.prepare("UPDATE bots SET status='active' WHERE bot_id='learner'").run();
  const ordinary = service.messages.accept(LOCAL_USER_ID, { botId: "learner", requestId: "ordinary", text: "普通 Bot 不继承管理权限" });
  await assert.rejects(dispatch(ordinary.assistantMessageId, "tester"), /主 Bot/);
  console.log("PASS unavailable/foreign/stale configuration rejected before send; ordinary Bot denied management");
  receiverGate = new Promise(resolve => { receiverRelease = resolve; });
  const first = intentSchema.parse(await dispatch(manual.assistantMessageId, "learner"));
  assert.equal(first.organization.phase, "linked");
  const relation = service.collaborations.repo.get(LOCAL_USER_ID, first.organization.collaborationId!)!;
  assert.equal(relation.workId, null); assert.notEqual(relation.status, "returned");
  const peer = service.messages.peers.deliveries(LOCAL_USER_ID).find(item => JSON.parse(item.origin_json).collaborationId === relation.collaborationId)!;
  assert(peer.accepted_message_id);
  assert.equal(service.organizations!.eligible(peer.accepted_message_id!), false, "peer source never inherits primary management");
  const duplicate = intentSchema.parse(await dispatch(manual.assistantMessageId, "tester", "different model draft"));
  assert.equal(duplicate.organization.intentId, first.organization.intentId); assert.equal(duplicate.organization.target.botId, "learner");
  const [concurrentA, concurrentB] = await Promise.all([dispatch(manual.assistantMessageId, "learner"), dispatch(manual.assistantMessageId, "tester")]);
  assert.equal(intentSchema.parse(concurrentA).organization.collaborationId, intentSchema.parse(concurrentB).organization.collaborationId);
  const deliveryCount = service.messages.peers.deliveries(LOCAL_USER_ID).length;
  // New service over the same actual SQLite store models a restarted adapter.
  const restarted = new BotConversationService(options);
  const replay = intentSchema.parse(await restarted.organizations!.command(manual.assistantMessageId, "after-restart", {
    action: "dispatch", targetBotId: "tester", settingsRevision: settings.get("tester").revision, text: "replayed", reason: "new draft" }));
  assert.equal(replay.organization.intentId, first.organization.intentId);
  assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, deliveryCount);
  assert.equal(restarted.collaborations.repo.get(LOCAL_USER_ID, relation.collaborationId)?.times.deliveredAt, relation.times.deliveredAt);
  await restarted.close(); receiverRelease!(); receiverGate = undefined;
  await wait(() => service.collaborations.repo.get(LOCAL_USER_ID, relation.collaborationId)?.status === "returned", "held receiver return");
  console.log("PASS acceptance is not completion; duplicate/concurrent/new-draft/restarted-adapter retains one target and one receiver");
  const unknownSource = service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "unknown", text: "不能盲目改派的原始目标" });
  failPreparation = true;
  const uncertain = intentSchema.parse(await dispatch(unknownSource.assistantMessageId, "learner"));
  assert.equal(uncertain.organization.phase, "contact_unknown");
  const uncertainRelation = service.collaborations.organizationCollaboration(uncertain.organization.intentId)!;
  assert.equal(uncertainRelation.status, "unknown");
  const pending = service.messages.peers.deliveries(LOCAL_USER_ID).find(item => JSON.parse(item.origin_json).collaborationId === uncertainRelation.collaborationId)!;
  assert.equal(pending.accepted_message_id, null);
  const unknownReplay = intentSchema.parse(await dispatch(unknownSource.assistantMessageId, "tester"));
  assert.equal(unknownReplay.organization.intentId, uncertain.organization.intentId);
  assert.equal(unknownReplay.organization.target.botId, "learner");
  failPreparation = false;
  const resumed = intentSchema.parse(await service.organizations!.command(unknownSource.assistantMessageId, "resume-unknown", {
    action: "resume", intentId: uncertain.organization.intentId }));
  assert.equal(resumed.organization.phase, "linked");
  await wait(() => service.collaborations.repo.get(LOCAL_USER_ID, uncertainRelation.collaborationId)?.status === "returned", "original uncertain target returns");
  assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).filter(item => JSON.parse(item.origin_json).collaborationId === uncertainRelation.collaborationId
    && JSON.parse(item.origin_json).kind === "request").length, 1);
  console.log("PASS uncertain admission retains original target/outbox; resume delivers once without blind reassignment");
  receiverGate = new Promise(resolve => { receiverRelease = resolve; });
  const parallelSources = ["parallel-one", "parallel-two"].map(requestId => service.messages.accept(LOCAL_USER_ID, {
    botId: DEFAULT_BOT_ID, requestId, text: requestId }));
  const parallel = await Promise.all(parallelSources.map((source, index) => dispatch(source.assistantMessageId, index ? "tester" : "learner")));
  const parallelIds = parallel.map(item => intentSchema.parse(item).organization.collaborationId!);
  assert.notEqual(parallelIds[0], parallelIds[1]);
  assert(parallelIds.every(id => service.collaborations.repo.get(LOCAL_USER_ID, id)?.times.deliveredAt !== null));
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, parallelIds[0])?.targetBotId, "learner");
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, parallelIds[1])?.targetBotId, "tester");
  receiverRelease!(); receiverGate = undefined;
  await wait(() => parallelIds.every(id => service.collaborations.repo.get(LOCAL_USER_ID, id)?.status === "returned"), "independent parallel returns");
  console.log("PASS independent dispatches to two targets admit concurrently without global serialization or crossed results");
  const existingSource = service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "existing-peer", text: "先问后做复用原协作" });
  await service.collaborations.command(existingSource.assistantMessageId, "first-question", { action: "ask", targetBotId: "learner", text: "先咨询同一目标" });
  await assert.rejects(dispatch(existingSource.assistantMessageId, "tester"), /dispatch_existing_collaboration/);
  console.log("PASS preexisting personal collaboration cannot be duplicated by default dispatch; follow-up keeps original identity");
  receiverGate = new Promise(resolve => { receiverRelease = resolve; });
  await boundary("persisted configuring must retain original configuration revision after change", async () => {
    const { origin, row } = await checkpoint("learner");
    const previous = settings.get("learner"), changedWorkspace = join(root, "changed-by-user"); mkdirSync(changedWorkspace);
    const changed = await settings.save({ botId: previous.botId, expectedRevision: previous.revision,
      workspacePath: changedWorkspace, modelId: previous.modelId, expertId: previous.expertId,
      skillIds: previous.skillIds, mcpIds: previous.mcpIds, connectorIds: previous.connectorIds });
    assert.equal(changed.settings.revision, row.expected_revision + 1);
    const priorDeliveries = service.messages.peers.deliveries(LOCAL_USER_ID).length;
    const controller = request("恢复中断的原派送，不覆盖用户已修改的配置");
    const result = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, "resume-changed", { action: "resume", intentId: row.organization_id }));
    assert.equal(result.organization.phase, "configuration_failed", "changed settings must fail closed rather than silently become approved");
    assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, priorDeliveries);
    assert.equal(settings.get("learner").revision, changed.settings.revision);
    assert.equal(settings.get("learner").workspacePath, changedWorkspace);
    assert.equal(z.object({ applied_revision: z.number().nullable() }).parse(db.prepare("SELECT applied_revision FROM bot_organization_records WHERE organization_id=?").get(row.organization_id)).applied_revision, null);
    assert.equal(service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, origin.assistantMessageId).length, 0);
  });
  await boundary("unchanged configuring resume, pause, deletion and valid source", async () => {
    const saved = await checkpoint("learner");
    db.prepare("UPDATE bots SET status='paused' WHERE bot_id='learner'").run();
    const controller = request("目标暂停时只恢复原身份");
    const paused = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, "resume-paused", { action: "resume", intentId: saved.row.organization_id }));
    assert.equal(paused.organization.phase, "configuration_failed");
    assert.equal(service.collaborations.organizationCollaboration(saved.row.organization_id), undefined);
    db.prepare("UPDATE bots SET status='active' WHERE bot_id='learner'").run();
    const recovered = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, "resume-unchanged", { action: "resume", intentId: saved.row.organization_id }));
    assert.equal(recovered.organization.phase, "linked");
    const approved = z.object({ applied_revision: z.number() }).parse(db.prepare("SELECT applied_revision FROM bot_organization_records WHERE organization_id=?").get(saved.row.organization_id));
    assert.equal(approved.applied_revision, saved.row.expected_revision);
    const target = bots.registerBot({ botId: "deleted-checkpoint", userId: LOCAL_USER_ID, displayName: "临时夹具", authorization: DESKTOP_USER_GRANTS });
    const removed = await checkpoint(target.botId); assert(bots.deleteBot(target.botId).ok);
    const deleted = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, "resume-deleted", { action: "resume", intentId: removed.row.organization_id }));
    assert.equal(deleted.organization.phase, "configuration_failed");
    assert.equal(deleted.organization.target.botId, target.botId);
    assert.equal(service.collaborations.organizationCollaboration(removed.row.organization_id), undefined);
    const ordinaryController = service.messages.accept(LOCAL_USER_ID, { botId: "learner", requestId: randomUUID(), text: "普通 Bot 不可恢复主 Bot 管理意图" });
    await assert.rejects(service.organizations!.command(ordinaryController.assistantMessageId, "forbidden-resume", { action: "resume", intentId: saved.row.organization_id }), /主 Bot/);
  });
  const boundaryRelations: string[] = [];
  for (const state of ["accepted", "unknown"] as const) {
    const origin = request(`原请求 ${state} 保持唯一派送`);
    failPreparation = state === "unknown";
    const initial = intentSchema.parse(await dispatch(origin.assistantMessageId, "learner", "唯一派送目标"));
    assert.equal(initial.organization.phase, state === "accepted" ? "linked" : "contact_unknown");
    const id = service.collaborations.organizationCollaboration(initial.organization.intentId)!.collaborationId;
    boundaryRelations.push(id);
    for (const variant of [
      { action: "delegate", targetBotId: "learner", text: "唯一派送目标" },
      { action: "ask", targetBotId: "learner", text: "同一请求的新模型改写" },
      { action: "delegate", targetBotId: "tester", text: "不能静默转给另一个目标" },
      { action: "delegate", collaborationId: id, text: "有原协作 ID 也不能重发同一来源" },
      { action: "follow_up", collaborationId: id, text: "不能把同源重试伪装成新用户补充" },
    ]) await boundary(`${state} dispatch then legacy ${JSON.stringify(variant)} remains one receipt`, async () => {
      const beforeRelations = count("bot_collaborations"), beforeDeliveries = service.messages.peers.deliveries(LOCAL_USER_ID).length;
      let response: unknown;
      try { response = await service.collaborations.command(origin.assistantMessageId, randomUUID(), variant); } catch { /* Assert durable effects even when an admission fails. */ }
      assert.equal(count("bot_collaborations"), beforeRelations, "legacy tool must not create a second collaboration");
      assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, beforeDeliveries, "legacy tool must not create a second receiver/outbox operation");
      assert.equal(z.object({ collaboration: z.object({ collaborationId: z.string() }) }).parse(response).collaboration.collaborationId, id);
    });
    failPreparation = false;
    const controller = request(`明确恢复 ${state} 原身份`);
    const resumed = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, "resume-original", { action: "resume", intentId: initial.organization.intentId }));
    assert.equal(resumed.organization.collaborationId, id);
    const peer = service.messages.peers.deliveries(LOCAL_USER_ID).find(item => JSON.parse(item.origin_json).collaborationId === id && JSON.parse(item.origin_json).kind === "request")!;
    assert(peer.accepted_message_id);
    await boundary(`${state} peer source cannot inherit management or send a loop`, async () => {
      const peerParent = peer.accepted_message_id!;
      assert.equal(service.organizations!.eligible(peerParent), false);
      await assert.rejects(service.organizations!.command(peerParent, "peer-manage", { action: "resume", intentId: initial.organization.intentId }), /管理权限/);
      const before = service.messages.peers.deliveries(LOCAL_USER_ID).length;
      await assert.rejects(service.collaborations.command(peerParent, "peer-loop", { action: "delegate", targetBotId: DEFAULT_BOT_ID, text: "不得把 Bot 转述当用户新授权" }), /转述|用户授权/);
      assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, before);
    });
  }
  for (const state of ["accepted", "unknown"] as const) {
    const origin = request(`新增入口绕行 ${state}`); failPreparation = state === "unknown";
    const first = intentSchema.parse(await dispatch(origin.assistantMessageId, "learner", "同一派送事项"));
    await service.organizations!.command(origin.assistantMessageId, randomUUID(), { action: "discover" });
    for (const next of [
      { action: "arrange", target: { kind: "existing", botId: "tester" }, contact: { kind: "delegate", text: "换入口和目标的重试" } },
      { action: "arrange", target: { kind: "existing", botId: "learner" }, contact: { kind: "ask", text: "同一事项的新模型改写" } },
      { action: "arrange", target: { kind: "create", displayName: `不应重复创建-${state}`, responsibilitySummary: "不得绕过派送身份", whyExistingBotsDoNotFit: "受控重复入口测试" }, contact: { kind: "delegate", text: "同一事项不另造 Bot" } },
    ]) await boundary(`${state} dispatch then arrange ${next.target.kind}/${next.contact.kind} reuses original`, async () => {
      const before = [count("bots"), count("bot_organization_records"), count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
      const result = intentSchema.parse(await service.organizations!.command(origin.assistantMessageId, randomUUID(), next));
      assert.deepEqual([count("bots"), count("bot_organization_records"), count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before, "arrange must not create/configure/contact a second executor");
      assert.equal(result.organization.intentId, first.organization.intentId); assert.equal(result.organization.target.botId, "learner");
    });
    failPreparation = false;
    const resume = request("仅恢复原入口事项");
    await service.organizations!.command(resume.assistantMessageId, randomUUID(), { action: "resume", intentId: first.organization.intentId });
    await boundary(`${state} contact:none remains a real configuration operation`, async () => {
      const previous = settings.get("tester"), workspacePath = join(root, `configuration-only-${state}`); mkdirSync(workspacePath);
      const before = [count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
      const result = intentSchema.parse(await service.organizations!.command(origin.assistantMessageId, randomUUID(), { action: "arrange",
        target: { kind: "existing", botId: "tester", configuration: { expectedRevision: previous.revision, changes: { workspacePath } } }, contact: { kind: "none" } }));
      assert.equal(result.organization.phase, "ready"); assert.equal(settings.get("tester").workspacePath, workspacePath);
      assert.equal(settings.get("tester").revision, previous.revision + 1);
      assert.deepEqual([count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before);
    });
    const reverse = request(`先 arrange 再 dispatch ${state}`); failPreparation = state === "unknown";
    const arranged = intentSchema.parse(await service.organizations!.command(reverse.assistantMessageId, randomUUID(), {
      action: "arrange", target: { kind: "existing", botId: "learner" }, contact: { kind: "delegate", text: "原始 arrange 事项" } }));
    await boundary(`${state} arrange then dispatch creates no other intent`, async () => {
      const before = [count("bots"), count("bot_organization_records"), count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
      let response: unknown;
      try { response = await dispatch(reverse.assistantMessageId, "tester", "不同入口不能分叉原事项"); }
      catch (error) { assert.match(String(error), /existing_collaboration|existing_intent/); }
      assert.deepEqual([count("bots"), count("bot_organization_records"), count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before);
      if (response) assert.equal(intentSchema.parse(response).organization.intentId, arranged.organization.intentId);
    });
    failPreparation = false;
    const controller = request("恢复原 arrange 意图");
    await service.organizations!.command(controller.assistantMessageId, randomUUID(), { action: "resume", intentId: arranged.organization.intentId });
  }
  await boundary("arrange journal committed before contact is respected by initial dispatch", async () => {
    const origin = request("中断在 arrange 日志提交后，尚未联系");
    const crashing = new BotOrganizationService({ ...options, settings, creator, messages: service.messages,
      collaborations: service.collaborations, publish: () => { throw Error("controlled arrange journal interruption"); } });
    await assert.rejects(crashing.command(origin.assistantMessageId, "arrange-before-crash", { action: "arrange",
      target: { kind: "existing", botId: "learner" }, contact: { kind: "delegate", text: "原事项" } }), /controlled arrange/);
    const row = z.object({ organization_id: z.string() }).parse(db.prepare("SELECT organization_id FROM bot_organization_records WHERE json_extract(origin_json,'$.user_message_id')=?").get(origin.userMessageId));
    const before = [count("bot_organization_records"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
    const existing = intentSchema.parse(await dispatch(origin.assistantMessageId, "tester"));
    assert.equal(existing.organization.intentId, row.organization_id); assert.equal(existing.organization.phase, "configuring");
    assert.deepEqual([count("bot_organization_records"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before);
    const controller = request("恢复日志中原 arrange 意图");
    const resumed = intentSchema.parse(await service.organizations!.command(controller.assistantMessageId, randomUUID(), { action: "resume", intentId: row.organization_id }));
    assert.equal(resumed.organization.phase, "linked"); assert.equal(resumed.organization.target.botId, "learner");
  });
  for (const first of ["dispatch", "arrange"] as const) await boundary(`concurrent ${first} first and other entry admit only one choice`, async () => {
    const origin = request(`同源并发 ${first}`), before = [count("bot_organization_records"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
    const sendDispatch = () => dispatch(origin.assistantMessageId, "learner");
    const sendArrange = () => service.organizations!.command(origin.assistantMessageId, randomUUID(), { action: "arrange", target: { kind: "existing", botId: "tester" }, contact: { kind: "delegate", text: "同一并发事项" } });
    const results = (await Promise.all(first === "dispatch" ? [sendDispatch(), sendArrange()] : [sendArrange(), sendDispatch()])).map(item => intentSchema.parse(item));
    assert.equal(results[0].organization.intentId, results[1].organization.intentId);
    assert.deepEqual([count("bot_organization_records"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before.map(value => value + 1));
  });
  await boundary("contact:none first does not consume a later legitimate dispatch", async () => {
    const origin = request("先核对配置再委派原目标");
    const configured = intentSchema.parse(await service.organizations!.command(origin.assistantMessageId, randomUUID(), { action: "arrange", target: { kind: "existing", botId: "tester" }, contact: { kind: "none" } }));
    const delivered = intentSchema.parse(await dispatch(origin.assistantMessageId, "learner"));
    assert.notEqual(configured.organization.intentId, delivered.organization.intentId); assert.equal(delivered.organization.phase, "linked");
  });
  await boundary("host acceptance and final outbox guard reject alternate organization identities", async () => {
    const origin = request("接收与 outbox 也必须保留原派送身份");
    const original = intentSchema.parse(await dispatch(origin.assistantMessageId, "learner"));
    const source = service.messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, service.messages.message(origin.assistantMessageId)!.requestId)!;
    const before = [count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length];
    await assert.rejects(service.collaborations.acceptOrganization({ intentId: "alternate-host-intent", currentParentMessageId: origin.assistantMessageId,
      origin: source, targetBotId: "tester", configurationGuard: () => {}, targetSettingsRevision: settings.get("tester").revision,
      retryFailedAsk: false, contact: { kind: "delegate", text: "不能绕开组织命令" } }), /dispatch_existing_intent/);
    assert.deepEqual([count("bot_collaborations"), service.messages.peers.deliveries(LOCAL_USER_ID).length], before);
    // Explicit fixture staging of a different relation proves that even a host
    // adapter cannot forge the default intent ID to prepare another outbox row.
    const alternate = service.collaborations.repo.ensure({ userId: LOCAL_USER_ID, sourceBotId: DEFAULT_BOT_ID, sourceDisplayName: "MyBuddy",
      sourceConversationId: source.conversation_id, sourceRequestId: source.request_id, sourceUserMessageId: source.user_message_id,
      sourceAssistantMessageId: source.assistant_message_id, targetBotId: "tester", targetDisplayName: "tester", operationId: "fixture-other-adapter" });
    await assert.rejects(service.collaborations.delivery!.send(alternate, source, "fixture-forged-intent", "不得创建第二投递", undefined,
      { organizationIntentId: original.organization.intentId, expectedRevision: settings.get("tester").revision }), /不匹配/);
    assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, before[1]);
  });
  await boundary("fresh explicit user requests keep normal ask/delegate/follow-up", async () => {
    const first = request("新的真实用户请求，另问一件事");
    const ask = z.object({ collaboration: z.object({ collaborationId: z.string() }) }).parse(await service.collaborations.command(first.assistantMessageId, "new-ask", { action: "ask", targetBotId: "tester", text: "新的明确咨询" }));
    const second = request("新的真实用户请求，明确委托新目标");
    const delegated = z.object({ collaboration: z.object({ collaborationId: z.string() }) }).parse(await service.collaborations.command(second.assistantMessageId, "new-delegate", { action: "delegate", targetBotId: "learner", text: "新的明确委托" }));
    assert.notEqual(ask.collaboration.collaborationId, delegated.collaboration.collaborationId);
    const continued = request("新的真实用户要求继续原主 Bot 派送");
    const continuedResult = z.object({ collaboration: z.object({ collaborationId: z.string() }) }).parse(await service.collaborations.command(continued.assistantMessageId, "explicit-new-delegate", {
      action: "delegate", collaborationId: boundaryRelations[0], text: "用户明确提出新的后续要求" }));
    assert.equal(continuedResult.collaboration.collaborationId, boundaryRelations[0]);
    const follow = request("用户明确补充原咨询");
    const before = service.messages.peers.deliveries(LOCAL_USER_ID).length;
    await service.collaborations.command(follow.assistantMessageId, "fresh-follow-up", { action: "follow_up", collaborationId: ask.collaboration.collaborationId, text: "新的真实补充" });
    assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID).length, before + 1);
  });
  receiverRelease!(); receiverGate = undefined;
  if (boundaryFailures.length) throw new AggregateError(boundaryFailures, "primary dispatch boundary regressions");
  const workReceipt = send("work");
  await wait(() => Boolean(service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, workReceipt.assistantMessageId)[0]?.workId), "B independently creates Work");
  const workRelation = service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, workReceipt.assistantMessageId)[0];
  const work = works.getWork(workRelation.workId!)!;
  assert.equal(work.ownerBotId, "tester"); assert.equal(work.sourceMessageId, workReceipt.userMessageId);
  assert.equal(schedules.filter(id => id === work.workId).length, 1); assert.equal(work.lifecycle, "active");
  assert.notEqual(workRelation.status, "returned", "receiver foreground acknowledgement cannot finish active Work");
  assert.equal(count("work_teams"), 0);
  console.log("PASS B normal foreground autonomously creates unique owned Work; acknowledgement never claims completion; no temporary team");
  console.log("NOT TESTED: real model routing quality, live Electron/desktop, external channels. Controlled inference/scheduling + real SQLite/services only; actual Work execution/artifacts untested.");
} finally { receiverRelease?.(); await service.close(); app.close(); rmSync(root, { recursive: true, force: true }); }
