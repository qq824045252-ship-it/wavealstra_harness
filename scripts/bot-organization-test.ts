import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExpertService } from "../src/main/experts/ExpertService";
import { TaskExpertBindingService } from "../src/main/experts/TaskExpertBindingService";
import { BotExpertBindingService } from "../src/main/agent/work/BotExpertBindingService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotCreationService } from "../src/main/agent/work/BotCreationService";
import { BotSettingsService } from "../src/main/agent/work/BotSettingsService";
import { BotOrganizationService } from "../src/main/agent/work/BotOrganizationService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { snapshotBotAttachments } from "../src/main/agent/work/BotAttachmentStorage";
import { BotPeerCallService } from "../src/main/agent/work/BotPeerCallService";
import { BotCollaborationService } from "../src/main/agent/work/BotCollaborationService";
import { BotConversationService, type BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { BotWorkQuery } from "../src/main/agent/work/BotWorkQuery";
import { WorkFileEventSource } from "../src/main/agent/work/WorkFileEventSource";
import { WorkService } from "../src/main/agent/work/WorkService";
import { botOrganizationSummarySchema } from "../src/shared/bot-organization";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const envelope = z.object({ organization: botOrganizationSummarySchema });
const countSchema = z.object({ count: z.number().int().nonnegative() });
const root = mkdtempSync(join(tmpdir(), "bot-organization-behavior-"));
const previousEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = root;
process.env.USERPROFILE = root;
const modelId = "organization-fixture/reader";
const audit: { scheduled: string[]; providerCalls: number; published: string[] } = {
  scheduled: [], providerCalls: 0, published: [],
};
const state = { authority: true, failSchedule: false };
const fixtures: AppDatabase[] = [];
const foregrounds: BotConversationService[] = [];
let peerInferenceFailure = false;
let peerBarrier: { entered: () => void; released: Promise<void> } | undefined;
const regressionFailures: Error[] = [];
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function regression(name: string, check: () => Promise<void>) {
  try { await check(); console.log(`PASS regression: ${name}`); }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    regressionFailures.push(failure);
    console.error(`FAIL regression: ${name}\n${failure.stack ?? failure.message}`);
  }
}

async function openFixture(directory: string) {
  mkdirSync(directory, { recursive: true });
  const app = new AppDatabase(join(directory, "app.db"));
  fixtures.push(app);
  const db = app.connection;
  const bots = new BotRegistry(db);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db, { bots, isAuthority: () => state.authority });
  const messages = new BotConversationRepository(db);
  const models = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "model-cache.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  // Only model inference is replaced. Creation, configuration, identity,
  // collaboration, Work acceptance and database persistence remain real.
  models.registerProvider("organization-fixture", {
    api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "reader", name: "organization fixture reader", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: model => {
      audit.providerCalls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const finish = () => {
          const reply: AssistantMessage = { role: "assistant", content: peerInferenceFailure ? [] : [{ type: "text", text: "CONSULTATION_ONLY: 19 × 23 = 437." }],
            stopReason: peerInferenceFailure ? "error" : "stop",
            errorMessage: peerInferenceFailure ? "Controlled peer inference failure; no reply was returned" : undefined,
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          if (peerInferenceFailure) stream.push({ type: "error", reason: "error", error: reply });
          else stream.push({ type: "done", reason: "stop", message: reply });
          stream.end();
        };
        const barrier = peerBarrier;
        if (barrier) { barrier.entered(); void barrier.released.then(finish); }
        else finish();
      });
      return stream;
    },
  });
  const experts = new ExpertService();
  const taskExperts = new TaskExpertBindingService(app, experts, {
    rootDir: join(directory, "task-experts"), isSkillEnabled: () => true,
  });
  const skillRoot = join(directory, "fixture-skill");
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: organization-check\ndescription: Read the exact fixture marker.\n---\nRead references/marker.txt before using the marker.\n");
  writeFileSync(join(skillRoot, "references", "marker.txt"), "ORGANIZATION_SELECTED_SKILL");
  const binding = new BotExpertBindingService(bots, experts, taskExperts, {
    rootDir: join(directory, "bot-experts"),
    resolveSkillDirectory: id => id === "organization-check" ? skillRoot : undefined,
  });
  const choice = (id: string) => ({ id, name: id, available: true });
  const settings = new BotSettingsService(app, bots, LOCAL_USER_ID, join(directory, "workspaces"), async () => ({
    models: [choice(modelId)], experts: [], skills: [choice("organization-check")],
    mcps: [choice("fixture-mcp")], connectors: [choice("fixture-connector")],
  }), input => binding.assembleSettings(input, LOCAL_USER_ID));
  const options = {
    db, userId: LOCAL_USER_ID, bots, works, models, directory,
    defaultModel: () => modelId, isAuthority: () => state.authority,
    prepareMessage: botId => settings.prepareMessage(botId),
    captureSettings: (id, botId, frozen) => settings.captureMessage(id, botId, frozen),
    messageSettings: (id, botId) => settings.messageSettings(id, botId),
    memorySearch: () => [], botWorkspace: (botId, prepare) => settings.resolveWorkspace(botId, prepare),
    botModel: botId => settings.get(botId).modelId || modelId,
    captureWorkSettings: work => { settings.forWork(work.workId, work.ownerBotId, work.workspacePath); },
    schedule: work => {
      if (state.failSchedule) throw new Error("organization fixture schedule transaction failure");
      audit.scheduled.push(work.workId);
    },
    wake: () => {},
  } satisfies BotConversationServiceOptions;
  const publish = (messageId: string) => { audit.published.push(messageId); };
  const peer = new BotPeerCallService(options, messages, publish);
  const foreground = new BotConversationService(options); foregrounds.push(foreground);
  const collaborations = foreground.collaborations;
  const creator = new BotCreationService(db, bots, { userId: LOCAL_USER_ID, isAuthority: () => state.authority });
  const organization = new BotOrganizationService({ ...options, settings, creator, collaborations, messages, publish });
  const request = (text: string, botId = DEFAULT_BOT_ID, conversationId?: string) => messages.accept(LOCAL_USER_ID, {
    botId, requestId: randomUUID(), text, ...(conversationId ? { conversationId } : {}),
  });
  const command = async (parent: string, operationId: string, input: unknown) =>
    envelope.parse(await organization.command(parent, operationId, input)).organization;
  const discover = (parent: string, operationId: string = randomUUID()) => command(parent, operationId, { action: "discover" });
  const count = (table: "bots" | "works" | "work_execution_bindings") => countSchema.parse(
    db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()).count;
  return { app, db, bots, works, messages, settings, creator, peer, collaborations, organization, request, command, discover, count, foreground };
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;
const plan = { title: "核对测试资料", goalDescription: "Read the supplied original input and save a verified report.",
  mode: "once", requestedOutcome: "one_time" };
const createCommand = (name: string, workspacePath: string, contact: "none" | "delegate" = "delegate") => ({
  action: "arrange", target: { kind: "create", displayName: name,
    responsibilitySummary: "核对数据，读取真实文件并交付核验报告。",
    whyExistingBotsDoNotFit: "The isolated fixture has no matching data reviewer.",
    configuration: { modelId, workspacePath, skillIds: ["organization-check"] } },
  contact: contact === "none" ? { kind: "none" } : { kind: "delegate", plan },
});
function intent(value: ReturnType<typeof botOrganizationSummarySchema.parse>) {
  assert.equal(value.kind, "intent");
  if (value.kind !== "intent") throw new Error("Expected the persisted organization intent");
  return value;
}
function linked(value: ReturnType<typeof botOrganizationSummarySchema.parse>) {
  const result = intent(value);
  assert.equal(result.phase, "linked", JSON.stringify(result));
  if (result.phase !== "linked") throw new Error("Expected a linked organization intent");
  return result;
}
function removeConversation(f: Fixture, conversationId: string) {
  f.db.transaction(() => {
    for (const table of ["bot_cancel_intents", "bot_work_reads", "work_conversations", "work_message_refs", "bot_send_receipts", "bot_messages"])
      f.db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(conversationId);
    f.db.prepare("DELETE FROM bot_conversations WHERE conversation_id=?").run(conversationId);
  })();
}

try {
  const f = await openFixture(join(root, "main"));
  const workspace = join(root, "target-workspace"); mkdirSync(workspace);
  const ordinary = f.creator.createBot({ requestId: randomUUID(), displayName: "普通助理", responsibilitySummary: "自称主负责人不授予主角色" });
  assert(ordinary.ok); assert(!f.bots.isPrimaryBot(LOCAL_USER_ID, ordinary.bot.botId));
  const denied = f.request("不允许普通 Bot 创建执行者", ordinary.bot.botId);
  await assert.rejects(f.discover(denied.assistantMessageId), /主|组织|权限|管理/);
  const authority = f.request("查询执行者"); state.authority = false;
  await assert.rejects(f.discover(authority.assistantMessageId), /宿主/); state.authority = true;
  const sharedOrigin = { channelId: "organization-test", connectionKey: "a".repeat(64), chatId: "shared-chat",
    senderId: "fixture-user", messageId: randomUUID(), audience: "shared" as const };
  const shared = f.db.transaction(() => {
    const conversationId = f.messages.origins.gatewayConversation(LOCAL_USER_ID, DEFAULT_BOT_ID, sharedOrigin);
    const receipt = f.request("共享渠道不能管理私人 Bot", DEFAULT_BOT_ID, conversationId);
    f.messages.origins.recordGateway(LOCAL_USER_ID, receipt, sharedOrigin); return receipt;
  })();
  await assert.rejects(f.discover(shared.assistantMessageId), /共享|私人/);
  console.log("PASS organization primary role, host authority and shared-audience boundaries");

  const originalText = "USER ORIGINAL: compute the attachment, keep this exact original and its file";
  const attachment = { name: "source-stock.csv", path: join(root, "source-stock.csv") };
  writeFileSync(attachment.path, "item,quantity,unit_price\nCedar,3,17\nBirch,5,23\n");
  const first = f.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: randomUUID(), text: originalText, attachments: [attachment] });
  await assert.rejects(f.command(first.assistantMessageId, "before-discovery", createCommand("核对助理", workspace)), /查询|discov|查找|目录/);
  await f.discover(first.assistantMessageId, "discover-main");
  await assert.rejects(f.command(first.assistantMessageId, "forged-actor", { action: "arrange", actor: { botId: DEFAULT_BOT_ID },
    target: { kind: "existing", botId: ordinary.bot.botId }, contact: { kind: "none" } }), z.ZodError);
  const held = deferred(), entered = deferred(); peerBarrier = { entered: entered.resolve, released: held.promise };
  const beforeBots = f.count("bots");
  const arranged = linked(await f.command(first.assistantMessageId, "arrange-main", createCommand("核对助理", workspace)));
  const relation = f.collaborations.organizationCollaboration(arranged.intentId)!;
  assert.equal(arranged.phase, "linked", "linked means durable foreground delivery, not a finished answer or Work");
  assert(relation.times.deliveredAt !== null); assert.equal(relation.workId, null);
  assert.equal(f.count("works"), 0); assert.equal(f.count("bots"), beforeBots + 1);
  const receives = f.messages.peers.deliveries(LOCAL_USER_ID).filter(item => JSON.parse(item.origin_json).collaborationId === relation.collaborationId);
  assert.equal(receives.length, 1); assert(receives[0].accepted_message_id);
  const receiver = f.messages.message(receives[0].accepted_message_id)!;
  assert.equal(receiver.botId, arranged.target.botId); assert.equal(receiver.peerOrigin?.sourceUserMessageId, first.userMessageId);
  const receivedSettings = f.settings.messageSettings(f.messages.receipt(LOCAL_USER_ID, receiver.botId, receiver.requestId)!.user_message_id, receiver.botId);
  assert(receivedSettings); assert.equal(receivedSettings.settings.modelId, modelId);
  assert.equal(receivedSettings.settings.effectiveWorkspacePath, realpathSync(workspace));
  assert(receivedSettings.settings.skillIds.includes("organization-check"));
  assert.deepEqual(receivedSettings.settings.mcpIds, f.settings.get(receiver.botId).mcpIds);
  assert.deepEqual(receivedSettings.settings.connectorIds, f.settings.get(receiver.botId).connectorIds);
  const selectedSkill = receivedSettings.profile.skillPackages?.find(item => item.id === "organization-check"); assert(selectedSkill);
  assert.equal(readFileSync(join(selectedSkill.directory, "references", "marker.txt"), "utf8"), "ORGANIZATION_SELECTED_SKILL");
  const peerManagement = await f.organization.eligible(receiver.messageId); assert.equal(peerManagement, false);
  const duplicate = linked(await f.command(first.assistantMessageId, "arrange-duplicate", createCommand("核对助理", workspace)));
  assert.equal(duplicate.intentId, arranged.intentId); assert.equal(duplicate.collaborationId, arranged.collaborationId);
  assert.equal(f.messages.peers.deliveries(LOCAL_USER_ID).length, 1);
  held.resolve(); peerBarrier = undefined;
  const deadline = Date.now() + 15000;
  while (f.messages.message(receiver.messageId)?.status !== "completed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.messages.message(receiver.messageId)?.status, "completed");
  assert.equal(f.count("works"), 0, "a delegate suggestion can be completed directly by B, without manufacturing a Work");
  console.log("PASS organization creates/configures one target then delivers to its real foreground; no synchronous Work prerequisite");

  const existing = f.request("仅复用执行者，保留未指定配置");
  const prior = f.settings.get(arranged.target.botId);
  const ask = linked(await f.command(existing.assistantMessageId, "existing-ask", { action: "arrange",
    target: { kind: "existing", botId: arranged.target.botId }, contact: { kind: "ask", text: "Compute 19 times 23" } }));
  assert.equal(ask.target.botId, arranged.target.botId); assert.equal(ask.times.botCreatedAt, null);
  assert.deepEqual(f.settings.get(arranged.target.botId), prior); assert.equal(f.count("works"), 0);
  const noneSource = f.request("只创建配置，不联系"); await f.discover(noneSource.assistantMessageId);
  const noContact = intent(await f.command(noneSource.assistantMessageId, "contact-none", createCommand("只配置助理", workspace, "none")));
  assert.equal(noContact.phase, "ready"); assert.equal(noContact.collaborationId, null);
  console.log("PASS existing target and contact:none preserve settings, separate delivery from answer and Work");

  const faulty = await openFixture(join(root, "faults"));
  const original = faulty.request("创建失败后继续同一个意图"); await faulty.discover(original.assistantMessageId);
  faulty.db.exec("CREATE TEMP TRIGGER fail_creation BEFORE INSERT ON bots BEGIN SELECT RAISE(ABORT,'fixture creation failure'); END");
  const failed = intent(await faulty.command(original.assistantMessageId, "creation-fails", createCommand("恢复助理", workspace, "none")));
  assert.equal(failed.phase, "creation_failed");
  faulty.db.exec("DROP TRIGGER fail_creation");
  const resumed = intent(await faulty.command(original.assistantMessageId, "creation-resume", { action: "resume", intentId: failed.intentId }));
  assert.equal(resumed.intentId, failed.intentId); assert.equal(resumed.phase, "ready"); assert(resumed.target);
  assert.equal(faulty.count("bots"), 2); assert.equal(faulty.count("works"), 0);
  const settingsBefore = faulty.settings.get(resumed.target.botId);
  const folderB = join(root, "settings-b"); mkdirSync(folderB);
  const changed = await faulty.settings.save({ botId: settingsBefore.botId, expectedRevision: settingsBefore.revision,
    workspacePath: folderB, modelId: settingsBefore.modelId, expertId: settingsBefore.expertId,
    skillIds: settingsBefore.skillIds, mcpIds: settingsBefore.mcpIds, connectorIds: settingsBefore.connectorIds });
  const continuation = faulty.request("重新查询已经配置的执行者");
  const unchanged = intent(await faulty.command(continuation.assistantMessageId, "query-stable", { action: "query", intentId: resumed.intentId }));
  assert.equal(unchanged.target?.botId, resumed.target.botId); assert.deepEqual(faulty.settings.get(resumed.target.botId), changed.settings);
  console.log("PASS creation rollback/resume keeps one executor; query never overwrites a later real settings revision");

  const foreign = await openFixture(join(root, "deleted-source"));
  const old = foreign.request("原来源删除后不改投"); await foreign.discover(old.assistantMessageId);
  const configured = intent(await foreign.command(old.assistantMessageId, "prepare-none", createCommand("来源保留助理", workspace, "none")));
  assert(configured.target); const createdCount = foreign.count("bots"); removeConversation(foreign, old.conversationId);
  const fresh = foreign.request("保留创建结果，查询原意图");
  const read = intent(await foreign.command(fresh.assistantMessageId, "query-deleted-origin", { action: "query", intentId: configured.intentId }));
  assert.equal(read.target?.botId, configured.target.botId); assert.equal(foreign.count("bots"), createdCount); assert.equal(foreign.count("works"), 0);
  console.log("PASS deleted source preserves original executor facts without creating replacement execution");
  await (async () => { console.log("discovery pages beyond 100 targets without hiding truncation");
    const fixture = await openFixture(join(root, "discovery-pagination"));
    for (let index = 0; index < 105; index++) fixture.bots.registerBot({ userId: LOCAL_USER_ID,
      botId: `page-bot-${String(index).padStart(3, "0")}`, displayName: `执行者${index}`, responsibilitySummary: index === 104 ? "唯一适配执行者" : "其他职责" });
    const source = fixture.request("查找唯一适配执行者，不要重复创建");
    const resultSchema = z.object({ bots: z.array(z.object({ botId: z.string() })), totalBots: z.number(), nextBotId: z.string().nullable(), limitations: z.array(z.string()) });
    const first = resultSchema.parse(await fixture.organization.command(source.assistantMessageId, "page-first", { action: "discover" }));
    assert.equal(first.bots.length, 100); assert.equal(first.totalBots, 105); assert(first.nextBotId);
    assert(first.limitations.some(item => item.includes("尚未读取完整")));
    const second = resultSchema.parse(await fixture.organization.command(source.assistantMessageId, "page-second", { action: "discover", afterBotId: first.nextBotId }));
    assert.equal(second.bots.length, 5); assert.equal(second.nextBotId, null);
    assert(second.bots.some(bot => bot.botId === "page-bot-104"));
    assert.equal(new Set([...first.bots, ...second.bots].map(bot => bot.botId)).size, 105);
    assert.equal(fixture.count("bots"), 106); assert.equal(fixture.count("works"), 0);
  })();
  await (async () => { console.log("discovery exposes actual CAS metadata for a bounded existing-target configuration patch");
    const metadata = await openFixture(join(root, "regression-discovery-metadata"));
    const target = metadata.creator.createBot({ requestId: randomUUID(), displayName: "已有配置执行者", responsibilitySummary: "保存自己的执行配置" });
    assert(target.ok);
    const folderA = join(root, "metadata-workspace-a"), folderB = join(root, "metadata-workspace-b");
    mkdirSync(folderA); mkdirSync(folderB);
    const saved = await metadata.settings.save({ botId: target.bot.botId, expectedRevision: 0,
      workspacePath: folderA, modelId, expertId: "", skillIds: ["organization-check"],
      mcpIds: ["fixture-mcp"], connectorIds: ["fixture-connector"] });
    const source = metadata.request("Discover this existing executor and use its actual version for a workspace-only change");
    const discovery = z.object({ organization: botOrganizationSummarySchema, bots: z.array(z.object({
      botId: z.string(), settingsRevision: z.number().int().nonnegative(), workspacePath: z.string(),
      effectiveWorkspacePath: z.string(), modelId: z.string(), expertId: z.string(),
    })) }).parse(await metadata.organization.command(source.assistantMessageId, "discover-actual-settings", { action: "discover" }));
    const selected = discovery.bots.find(item => item.botId === target.bot.botId);
    assert(selected);
    assert.deepEqual(selected, { botId: target.bot.botId, settingsRevision: saved.settings.revision,
      workspacePath: saved.settings.workspacePath, effectiveWorkspacePath: saved.settings.effectiveWorkspacePath,
      modelId: saved.settings.modelId, expertId: saved.settings.expertId });
    assert.equal(selected.settingsRevision, 1, "this is the persisted nonzero version, not an invented initial revision");
    const configured = intent(await metadata.command(source.assistantMessageId, "configure-from-discovery", {
      action: "arrange", target: { kind: "existing", botId: selected.botId,
        configuration: { expectedRevision: selected.settingsRevision, changes: { workspacePath: folderB } } },
      contact: { kind: "none" },
    }));
    assert.equal(configured.phase, "ready");
    assert(configured.target);
    assert.equal(configured.target.botId, target.bot.botId);
    assert.equal(configured.times.botCreatedAt, null);
    assert(configured.times.configuredAt !== null);
    assert.deepEqual(metadata.settings.get(target.bot.botId), { ...saved.settings,
      revision: saved.settings.revision + 1, workspacePath: folderB, effectiveWorkspacePath: realpathSync(folderB) },
    "only the explicitly patched workspace and CAS revision change; model, expert, Skill, MCP and connector settings survive");
    assert.equal(metadata.count("bots"), 2);
    assert.equal(metadata.count("works"), 0);
  })();
  await (async () => { console.log("lost create acknowledgement cannot split one task through arrange existing and original resume");
    const cross = await openFixture(join(root, "create-existing-bridge"));
    const source = cross.request("Create one translation Bot and delegate the translation; also permit a separate calculation task.");
    await cross.discover(source.assistantMessageId);
    const original = createCommand("跨路径恢复", workspace);
    const create = cross.creator.createBot.bind(cross.creator);
    let committedTarget = "";
    cross.creator.createBot = request => {
      const result = create(request);
      if (result.ok) { committedTarget = result.bot.botId; throw new Error("lost committed creation acknowledgement"); }
      return result;
    };
    const lost = intent(await cross.command(source.assistantMessageId, "lost-create", original));
    cross.creator.createBot = create;
    assert.equal(lost.phase, "creation_failed");
    assert.equal(lost.target, null, "view does not know the committed identity yet");
    assert(committedTarget);
    assert.equal(cross.count("works"), 0);
    const changed = { action: "arrange", target: { kind: "existing", botId: committedTarget,
      configuration: { expectedRevision: 0, changes: original.target.configuration } },
      contact: { kind: "delegate", plan: { ...plan, constraints: ["Reworded condition, not silently adopted"] } } };
    const conflict = await cross.organization.command(source.assistantMessageId, "retry-as-existing", changed) as { organization: ReturnType<typeof botOrganizationSummarySchema.parse>; error?: string };
    assert.equal(intent(conflict.organization).intentId, lost.intentId);
    assert.match(conflict.error ?? "", /same_request_existing_intent/);
    assert.equal(cross.count("works"), 0);
    assert.equal(cross.settings.get(committedTarget).revision, 0, "conflicting plan must not alter configuration");
    cross.messages.update(source.assistantMessageId, "completed", "The saved intent is retained.");
    const fresh = cross.request("Resume that original saved intent only.");
    const accepted = linked(await cross.command(fresh.assistantMessageId, "resume-original", { action: "resume", intentId: lost.intentId }));
    assert.equal(accepted.target.botId, committedTarget);
    assert.equal(cross.count("bots"), 2);
    assert.equal(cross.count("works"), 0);
    const workId = cross.collaborations.organizationCollaboration(lost.intentId)?.workId;
    assert.equal(workId, null);
    assert.equal(cross.messages.peers.deliveries(LOCAL_USER_ID).length, 1);
    const scheduled = audit.scheduled.length;
    linked(await cross.command(fresh.assistantMessageId, "resume-again", { action: "resume", intentId: lost.intentId }));
    assert.equal(cross.count("works"), 0);
    assert.equal(audit.scheduled.length, scheduled);
    // A distinct task for that same target and original user request is not merged.
    cross.messages.update(source.assistantMessageId, "running", "Continuing the independently requested calculation.");
    const separate = linked(await cross.command(source.assistantMessageId, "independent-task", {
      action: "arrange", target: { kind: "existing", botId: committedTarget },
      contact: { kind: "delegate", plan: { ...plan, title: "独立核算", goalDescription: "Calculate the separate requested total." } },
    }));
    assert.notEqual(separate.intentId, lost.intentId);
    assert.equal(cross.count("works"), 0);
    const same = linked(await cross.command(source.assistantMessageId, "equivalent-existing", {
      action: "arrange", target: { kind: "existing", botId: committedTarget }, contact: original.contact,
    }));
    assert.equal(same.intentId, lost.intentId);
    assert.equal(cross.count("works"), 0);
  })();
} finally {
  peerBarrier = undefined; peerInferenceFailure = false; state.failSchedule = false;
  for (const foreground of foregrounds) await foreground.close();
  for (const fixture of fixtures) fixture.close();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const relativeRoot = relative(tmpdir(), root); assert(relativeRoot && !relativeRoot.startsWith("..") && !isAbsolute(relativeRoot));
  rmSync(root, { recursive: true, force: true });
}
