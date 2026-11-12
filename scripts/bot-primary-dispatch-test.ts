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
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
models.registerProvider("dispatch-fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [DEFAULT_BOT_ID, "learner", "tester"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, context) => {
    const stream = createAssistantMessageEventStream();
    const user = [...context.messages].reverse().find(item => item.role === "user");
    const input = user ? contentText(user.content) : "";
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
const intentSchema = z.object({ organization: z.object({ intentId: z.string(), phase: z.string(), collaborationId: z.string().nullable(),
  target: z.object({ botId: z.string() }) }) });
try {
  for (const [tag, expected] of [["learn", "learner"], ["test", "tester"], ["explicit", "tester"]]) {
    const receipt = send(tag);
    await wait(() => service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, receipt.assistantMessageId).some(item => item.status === "returned"), `dispatch and return ${tag}`);
    const relation = service.collaborations.repo.summariesForMessage(LOCAL_USER_ID, receipt.assistantMessageId)[0];
    assert.equal(relation.targetBotId, expected); assert.equal(relation.sourceUserMessageId, receipt.userMessageId);
    assert.equal(relation.workId, null); assert(relation.times.deliveredAt); assert(relation.times.returnedAt);
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
