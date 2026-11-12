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
import type { BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
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
      input: ["text"], contextWindow: 32768, maxTokens: 1024,
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
  const collaborations = new BotCollaborationService(options, messages, peer, publish);
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
  return { app, db, bots, works, messages, settings, creator, peer, collaborations, organization, request, command, discover, count };
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
  const workspace = join(root, "target-workspace");
  mkdirSync(workspace);
  const ordinary = f.creator.createBot({ requestId: randomUUID(), displayName: "普通助理",
    responsibilitySummary: "长期主负责人。该文案不能赋予组织主角色。" });
  assert(ordinary.ok);
  assert(f.bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID));
  assert.equal(f.bots.isPrimaryBot(LOCAL_USER_ID, ordinary.bot.botId), false);
  const primaryBeforeRename = f.bots.getBot(DEFAULT_BOT_ID);
  assert(primaryBeforeRename);
  const renamed = f.creator.renameBot({ botId: DEFAULT_BOT_ID, expectedUpdatedAt: primaryBeforeRename.updatedAt,
    displayName: "重命名后的主助理" });
  assert(renamed.ok);
  assert.equal(renamed.bot.botId, DEFAULT_BOT_ID);
  assert(f.bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID), "rename cannot transfer primary role");
  const denied = f.request("Create a Bot using a copied management action", ordinary.bot.botId);
  await assert.rejects(f.discover(denied.assistantMessageId), /主|primary|组织|权限|管理/);
  const authorityRequest = f.request("Discover matching personal executors");
  state.authority = false;
  await assert.rejects(f.discover(authorityRequest.assistantMessageId), /宿主|authority/);
  state.authority = true;
  const team = f.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, teamId: "organization-team-fixture",
    requestId: randomUUID(), text: "A team cannot organize personal Bots" });
  await assert.rejects(f.discover(team.assistantMessageId), /个人|私人|团队|team|管理|组织/);
  const gatewayOrigin = { channelId: "organization-test", connectionKey: "a".repeat(64), chatId: "shared-chat",
    senderId: "fixture-user", messageId: randomUUID(), audience: "shared" as const };
  const sharedFixture = await openFixture(join(root, "shared-audience"));
  const sharedConversation = sharedFixture.messages.origins.gatewayConversation(LOCAL_USER_ID, DEFAULT_BOT_ID,
    { channelId: "fixture-shared", connectionKey: "a".repeat(64), chatId: "organization-shared-fixture",
      senderId: "fixture-sender", messageId: "fixture-message", audience: "shared" });
  const shared = sharedFixture.db.transaction(() => {
    const receipt = sharedFixture.request("A shared audience cannot organize Bots", DEFAULT_BOT_ID, sharedConversation);

    return receipt;
  })();
  await assert.rejects(sharedFixture.discover(shared.assistantMessageId), /共享|shared|个人|私人|管理|组织/);
  console.log("PASS stable primary role, ordinary prose, host lease, team and shared-audience boundaries");

  const originalText = "USER ORIGINAL: compute 3*17 + 5*23, preserve this request and attachment identity";
  const originalAttachment = { name: "source-stock.csv", path: join(root, "source-stock.csv") };
  writeFileSync(originalAttachment.path, "item,quantity,unit_price\nCedar,3,17\nBirch,5,23\n");
  const first = f.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: randomUUID(),
    text: originalText, attachments: [originalAttachment] });
  const beforeBots = f.count("bots");
  await assert.rejects(f.command(first.assistantMessageId, "before-discovery", createCommand("核对助理", workspace)), /查询|discov|查找|目录/);
  assert.equal(f.count("bots"), beforeBots);
  const searched = await f.discover(first.assistantMessageId, "discover-main");
  assert.equal(searched.kind, "discovery");
  assert.equal(searched.sourceUserMessageId, first.userMessageId);
  assert.equal(searched.sourceConversationId, first.conversationId);
  assert(searched.receipts.some(receipt => receipt.step === "discovery" && receipt.status === "succeeded"));
  await assert.rejects(f.command(first.assistantMessageId, "forged-actor", {
    action: "arrange", actor: { botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID },
    target: { kind: "existing", botId: ordinary.bot.botId }, contact: { kind: "none" },
  }), z.ZodError, "model input cannot supply the authenticated management actor");
  const arranged = linked(await f.command(first.assistantMessageId, "arrange-main", createCommand("核对助理", workspace)));
  const targetId = arranged.target.botId;
  const relation = f.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: arranged.collaborationId });
  assert(relation.collaboration.workId);
  const work = f.works.getWork(relation.collaboration.workId);
  assert(work);
  assert.equal(work.ownerBotId, targetId);
  assert.equal(work.sourceMessageId, first.userMessageId);
  const preservedInput = z.object({ messages_json: z.string() }).parse(f.db.prepare(
    "SELECT messages_json FROM bot_work_user_inputs WHERE work_id=? ORDER BY rowid LIMIT 1").get(work.workId));
  assert(preservedInput.messages_json.includes(originalText), "Work preserves the original user text rather than only the model plan");
  const preservedAttachment = z.object({ attachments_json: z.string() }).parse(f.db.prepare(
    "SELECT attachments_json FROM bot_work_attachments WHERE work_id=? ORDER BY rowid LIMIT 1").get(work.workId));
  assert(preservedAttachment.attachments_json.includes(originalAttachment.name));
  assert.equal(f.works.teams.get(work.workId), undefined);
  assert.equal(new BotWorkQuery(f.db, LOCAL_USER_ID, DEFAULT_BOT_ID).page({}).total, 0);
  assert.equal(new BotWorkQuery(f.db, LOCAL_USER_ID, targetId).page({}).total, 1);
  assert.equal(f.settings.forWork(work.workId, targetId).modelId, modelId);
  assert.equal(f.settings.forWork(work.workId, targetId).effectiveWorkspacePath, workspace);
  const selectedSkill = f.bots.activeSnapshot(targetId)?.skillPackages?.find(item => item.id === "organization-check");
  assert(selectedSkill);
  assert.equal(readFileSync(join(selectedSkill.directory, "references", "marker.txt"), "utf8"), "ORGANIZATION_SELECTED_SKILL");
  assert(arranged.times.botCreatedAt !== null && arranged.times.configuredAt !== null && arranged.times.linkedAt !== null);
  assert.equal(relation.collaboration.times.startedAt, null, "acceptance must not fabricate execution start");
  assert.equal(relation.collaboration.times.returnedAt, null, "creation must not fabricate a result return");
  const results = await Promise.all(["arrange-main", "arrange-duplicate"].map(operation =>
    f.command(first.assistantMessageId, operation, createCommand("核对助理", workspace))));
  assert(results.every(result => linked(result).intentId === arranged.intentId));
  assert.equal(f.count("bots"), beforeBots + 1);
  assert.equal(f.count("works"), 1);
  assert.equal(audit.scheduled.filter(id => id === work.workId).length, 1);
  await assert.rejects(f.command(first.assistantMessageId, "arrange-main", createCommand("改过参数", workspace)), /冲突|conflict|不同|更改/);
  const duplicateSend = f.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: randomUUID(),
    conversationId: first.conversationId, text: originalText, attachments: [originalAttachment] });
  await f.discover(duplicateSend.assistantMessageId, "repeat-send-discovery");
  const repeatedSend = linked(await f.command(duplicateSend.assistantMessageId, "repeat-send-arrange", createCommand("核对助理", workspace)));
  assert.equal(repeatedSend.intentId, arranged.intentId, "the same exact request in a new accepted user message reuses its saved intent");
  assert.equal(repeatedSend.sourceUserMessageId, first.userMessageId, "duplicate send does not replace the original provenance");
  assert.equal(repeatedSend.collaborationId, arranged.collaborationId);
  assert.equal(f.count("bots"), beforeBots + 1);
  assert.equal(f.count("works"), 1);
  f.messages.update(first.assistantMessageId, "completed", "Original creation and acceptance completed.");
  await assert.rejects(f.command(first.assistantMessageId, "stale-parent-query", { action: "query", intentId: arranged.intentId }), /当前|有效|私人|source/);
  assert.equal(intent(await f.command(duplicateSend.assistantMessageId, "fresh-parent-query", { action: "query", intentId: arranged.intentId })).intentId, arranged.intentId);
  const foreign = f.bots.registerBot({ userId: "organization-foreign-user", botId: "organization-foreign-bot", displayName: "Foreign primary claim" });
  const foreignReceipt = f.messages.accept(foreign.userId, { botId: foreign.botId, requestId: randomUUID(), text: "Query a known foreign intent ID" });
  await assert.rejects(f.command(foreignReceipt.assistantMessageId, "foreign-known-intent", {
    action: "query", intentId: arranged.intentId,
  }), /来源|用户|主|权限|管理|source|owner/);
  console.log("PASS actual create/configure/accept, target model/workspace/skill, original input, counts and duplicate admission");

  const concurrent = f.request("A single creation intent is admitted through two real SQLite connections");
  await f.discover(concurrent.assistantMessageId);
  const contender = await openFixture(join(root, "main"));
  const concurrentBefore = f.count("bots");
  const concurrentInput = createCommand("并发助理", workspace, "none");
  const concurrentResults = await Promise.all([
    f.command(concurrent.assistantMessageId, "concurrent-left", concurrentInput),
    contender.command(concurrent.assistantMessageId, "concurrent-right", concurrentInput),
  ]);
  const leftIntent = intent(concurrentResults[0]);
  const rightIntent = intent(concurrentResults[1]);
  assert.equal(leftIntent.phase, "ready");
  assert.equal(rightIntent.phase, "ready");
  assert(leftIntent.target && rightIntent.target);
  assert.equal(leftIntent.intentId, rightIntent.intentId);
  assert.equal(leftIntent.target.botId, rightIntent.target.botId);
  assert.equal(f.count("bots"), concurrentBefore + 1);
  contender.app.close();
  fixtures.splice(fixtures.indexOf(contender.app), 1);
  console.log("PASS same intent admitted through two actual SQLite connections produces one target");

  const existingSettings = f.settings.get(targetId);
  const reuse = f.request("Ask the existing reviewer a read-only question");
  const beforeWorks = f.count("works");
  const providerBefore = audit.providerCalls;
  const askedResult = await f.command(reuse.assistantMessageId, "reuse-ask", {
    action: "arrange", target: { kind: "existing", botId: targetId },
    contact: { kind: "ask", text: "Compute 19 times 23 without creating Work" },
  });
  if (askedResult.kind === "intent" && askedResult.phase !== "linked") console.error("ACTUAL_PEER_FAILURE", JSON.stringify({
    organization: askedResult,
    collaboration: f.collaborations.organizationCollaboration(askedResult.intentId),
    peerCalls: f.messages.peerCalls.list(reuse.assistantMessageId).map(call => ({ callId: call.callId, status: call.status, error: call.error, replyText: call.replyText?.slice(0, 500) })),
    actualProviderCalls: audit.providerCalls - providerBefore,
  }));
  const asked = linked(askedResult);
  const askHistory = f.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: asked.collaborationId });
  assert.equal(askHistory.collaboration.workId, null);
  assert(askHistory.messages.some(message => message.kind === "reply" && message.senderBotId === targetId && message.text.includes("437")));
  assert(audit.providerCalls > providerBefore, "the real peer runtime reached only the controlled inference boundary");
  assert.equal(f.count("works"), beforeWorks);
  assert.deepEqual(f.settings.get(targetId), existingSettings, "reuse leaves unrelated settings untouched");
  assert.equal(asked.times.botCreatedAt, null);
  const ordinaryReply = await f.collaborations.command(denied.assistantMessageId, "ordinary-personal-ask", {
    action: "ask", targetBotId: targetId, text: "Compute 19 times 23 using the ordinary personal collaboration path",
  });
  assert(JSON.stringify(ordinaryReply).includes("437"), "ordinary management refusal must preserve ordinary collaboration");
  const sanitized = await f.organization.command(reuse.assistantMessageId, "scoped-discovery", { action: "discover" });
  assert(!JSON.stringify(sanitized).includes("ORGANIZATION_SELECTED_SKILL"), "discovery never returns selected Skill bodies");
  console.log("PASS existing-target consultation through real peer runtime, no Work and no settings overwrite");

  const failure = f.request("Create a reviewer, retry a real creation storage failure");
  await f.discover(failure.assistantMessageId);
  const botsBeforeFailure = f.count("bots");
  f.db.exec("CREATE TRIGGER organization_creation_fault BEFORE INSERT ON bot_expert_versions BEGIN SELECT RAISE(ABORT,'organization real creation failure'); END");
  const creationFailed = intent(await f.command(failure.assistantMessageId, "creation-fault", createCommand("创建失败助理", workspace, "none")));
  assert.equal(creationFailed.phase, "creation_failed");
  assert.equal(f.count("bots"), botsBeforeFailure);
  f.db.exec("DROP TRIGGER organization_creation_fault");
  const recoveredCreation = intent(await f.command(failure.assistantMessageId, "creation-retry", { action: "resume", intentId: creationFailed.intentId }));
  assert.equal(recoveredCreation.intentId, creationFailed.intentId);
  assert.equal(recoveredCreation.phase, "ready");
  assert.equal(f.count("bots"), botsBeforeFailure + 1);
  assert.equal(f.count("works"), beforeWorks);
  console.log("PASS real creation transaction rollback and same-intent resume");

  const configureFailure = f.request("A created Bot survives a real settings storage failure");
  await f.discover(configureFailure.assistantMessageId);
  const beforeConfigureBots = f.count("bots");
  f.db.exec("CREATE TRIGGER organization_configuration_fault BEFORE INSERT ON bot_execution_settings BEGIN SELECT RAISE(ABORT,'organization real configuration failure'); END");
  const configurationFailed = intent(await f.command(configureFailure.assistantMessageId, "configuration-fault", createCommand("配置失败助理", workspace, "none")));
  assert.equal(configurationFailed.phase, "configuration_failed");
  assert(configurationFailed.target);
  assert.equal(f.count("bots"), beforeConfigureBots + 1, "committed creation survives later settings failure");
  assert.equal(f.settings.get(configurationFailed.target.botId).revision, 0);
  assert.equal(configurationFailed.times.configuredAt, null);
  f.db.exec("DROP TRIGGER organization_configuration_fault");
  const configured = intent(await f.command(configureFailure.assistantMessageId, "configuration-resume", { action: "resume", intentId: configurationFailed.intentId }));
  assert.equal(configured.phase, "ready");
  assert(configured.target);
  assert.equal(configured.target.botId, configurationFailed.target.botId);
  assert.equal(f.settings.get(configured.target.botId).revision, 1);
  assert.equal(f.count("bots"), beforeConfigureBots + 1);
  console.log("PASS actual settings storage failure preserves the created target and resumes only configuration");

  const handoff = f.request("ORIGINAL HANDOFF: preserve this exact source when a fresh conversation continues");
  await f.discover(handoff.assistantMessageId);
  state.failSchedule = true;
  const failedHandoff = intent(await f.command(handoff.assistantMessageId, "handoff-fault", createCommand("续接助理", workspace)));
  state.failSchedule = false;
  assert.equal(failedHandoff.phase, "contact_failed");
  assert(failedHandoff.target);
  const stableTarget = failedHandoff.target.botId;
  const stableRevision = f.settings.get(stableTarget).revision;
  assert.equal(f.count("works"), beforeWorks);
  f.messages.update(handoff.assistantMessageId, "completed", "The target was created; delegation failed and can continue.");
  f.messages.archive(LOCAL_USER_ID, DEFAULT_BOT_ID, handoff.conversationId);
  const current = f.request("Continue the saved creation intent from this fresh active request");
  assert.notEqual(current.conversationId, handoff.conversationId);
  const resumed = linked(await f.command(current.assistantMessageId, "handoff-resume", { action: "resume", intentId: failedHandoff.intentId }));
  assert.equal(resumed.target.botId, stableTarget);
  assert.equal(resumed.sourceConversationId, handoff.conversationId);
  assert.equal(f.settings.get(stableTarget).revision, stableRevision);
  const resumedHistory = f.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: resumed.collaborationId });
  assert.equal(resumedHistory.collaboration.sourceConversationId, handoff.conversationId);
  assert(resumedHistory.collaboration.workId);
  assert.equal(f.works.getWork(resumedHistory.collaboration.workId)?.sourceMessageId, handoff.userMessageId);
  console.log("PASS actual handoff rollback, completed original turn, fresh authority and exact archived provenance");

  const changed = f.request("Create a target; do not overwrite my settings edit after failed handoff");
  await f.discover(changed.assistantMessageId);
  state.failSchedule = true;
  const beforeEdit = intent(await f.command(changed.assistantMessageId, "user-edit-handoff", createCommand("用户改配助理", workspace)));
  state.failSchedule = false;
  assert(beforeEdit.target);
  const beforeUserEdit = f.settings.get(beforeEdit.target.botId);
  const edited = await f.settings.save({ expectedRevision: beforeUserEdit.revision,
    botId: beforeEdit.target.botId, workspacePath: workspace, modelId, expertId: "", skillIds: [],
    mcpIds: ["fixture-mcp"], connectorIds: ["fixture-connector"] });
  const afterEdit = intent(await f.command(changed.assistantMessageId, "do-not-overwrite", { action: "resume", intentId: beforeEdit.intentId }));
  assert.notEqual(afterEdit.phase, "linked", "a later user edit blocks acceptance of the stale saved configuration");
  assert.deepEqual(f.settings.get(beforeEdit.target.botId), edited.settings);
  console.log("PASS settings CAS reconciliation preserves a later real user edit");

  const deleted = f.request("Create an executor but never redirect a deleted source");
  await f.discover(deleted.assistantMessageId);
  state.failSchedule = true;
  const orphan = intent(await f.command(deleted.assistantMessageId, "delete-origin-handoff", createCommand("删除来源助理", workspace)));
  state.failSchedule = false;
  removeConversation(f, deleted.conversationId);
  const replacement = f.request("Inspect this saved intent without changing its original destination");
  const beforeDeletedResume = f.count("works");
  const noFallback = intent(await f.command(replacement.assistantMessageId, "deleted-origin-resume", { action: "resume", intentId: orphan.intentId }));
  assert.notEqual(noFallback.phase, "linked");
  assert.equal(noFallback.sourceConversationId, deleted.conversationId);
  assert.equal(f.count("works"), beforeDeletedResume);
  assert.equal(f.messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: replacement.conversationId }).messages.length, 2);
  console.log("PASS deleted original source retains facts without new Work or fallback delivery");

  const pending = f.request("Persist a configured target and resume after a real database reopen");
  await f.discover(pending.assistantMessageId);
  state.failSchedule = true;
  const pendingIntent = intent(await f.command(pending.assistantMessageId, "restart-handoff", createCommand("重启助理", workspace)));
  state.failSchedule = false;
  assert(pendingIntent.target);
  const targetBeforeRestart = pendingIntent.target.botId;
  const settingsBeforeRestart = f.settings.get(targetBeforeRestart);
  f.app.close();
  fixtures.splice(fixtures.indexOf(f.app), 1);
  const reopened = await openFixture(join(root, "main"));
  reopened.organization.recover();
  const afterRestart = linked(await reopened.command(pending.assistantMessageId, "restart-resume", { action: "resume", intentId: pendingIntent.intentId }));
  assert.equal(afterRestart.target.botId, targetBeforeRestart);
  assert.equal(afterRestart.times.botCreatedAt, pendingIntent.times.botCreatedAt);
  assert.equal(afterRestart.times.configuredAt, pendingIntent.times.configuredAt);
  assert.deepEqual(reopened.settings.get(targetBeforeRestart), settingsBeforeRestart);
  assert(reopened.bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID));
  const queried = intent(await reopened.command(pending.assistantMessageId, "query-restarted", { action: "query", intentId: pendingIntent.intentId }));
  assert.equal(queried.collaborationId, afterRestart.collaborationId);
  console.log("PASS database close/reopen preserves role, intent, target, settings, times and exact accepted relation");

  await regression("a failed peer inference never becomes contact success", async () => {
    const peerFixture = await openFixture(join(root, "regression-peer-failed"));
    const target = peerFixture.creator.createBot({ requestId: randomUUID(), displayName: "失败咨询目标", responsibilitySummary: "只读咨询" });
    assert(target.ok);
    const source = peerFixture.request("Ask the actual peer runtime; the inference boundary will fail");
    peerInferenceFailure = true;
    try {
      const failed = intent(await peerFixture.command(source.assistantMessageId, "peer-inference-fails", {
        action: "arrange", target: { kind: "existing", botId: target.bot.botId },
        contact: { kind: "ask", text: "There will be no successful receiver reply" },
      }));
      const relation = peerFixture.collaborations.organizationCollaboration(failed.intentId);
      assert(relation);
      assert.equal(relation.status, "failed", "the real peer failure is persisted in the actual collaboration");
      assert.equal(relation.times.returnedAt, null);
      assert.equal(peerFixture.works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, 0);
      assert.equal(failed.phase, "contact_failed", JSON.stringify({ phase: failed.phase, relationStatus: relation.status, receipts: failed.receipts }));
      assert(!failed.receipts.some(receipt => receipt.step === "contact" && receipt.status === "succeeded"));
      const callsAfterFailure = audit.providerCalls;
      const originalRelationId = relation.collaborationId;
      peerInferenceFailure = false;
      peerFixture.messages.update(source.assistantMessageId, "completed", "The peer failed; the known failure is resumable.");
      const continuation = peerFixture.request("Retry this known failed read-only consultation using its original intent");
      const resumed = linked(await peerFixture.command(continuation.assistantMessageId, "retry-known-failed-ask", {
        action: "resume", intentId: failed.intentId,
      }));
      assert.equal(resumed.intentId, failed.intentId);
      assert.equal(resumed.target.botId, target.bot.botId);
      assert.equal(resumed.collaborationId, originalRelationId, "a known failed consultation retries inside its original relation");
      assert.equal(audit.providerCalls, callsAfterFailure + 1, "known failure permits one actual new inference attempt");
      const returned = peerFixture.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: originalRelationId });
      assert.equal(returned.collaboration.status, "returned");
      assert(returned.collaboration.times.returnedAt !== null);
      assert.equal(returned.messages.filter(message => message.kind === "reply" && message.text.includes("437")).length, 1);
      assert.equal(resumed.receipts.filter(receipt => receipt.step === "contact" && receipt.status === "succeeded").length, 1);
      assert.equal(peerFixture.count("works"), 0);
    } finally { peerInferenceFailure = false; }
  });

  await regression("an unknown peer effect is preserved without blind resend on a fresh continuation", async () => {
    const unknown = await openFixture(join(root, "regression-peer-unknown"));
    const target = unknown.creator.createBot({ requestId: randomUUID(), displayName: "待核对咨询目标", responsibilitySummary: "只读咨询" });
    assert(target.ok);
    const source = unknown.request("The actual provider call will lose its host receipt before reply");
    const entered = deferred(), release = deferred();
    peerBarrier = { entered: entered.resolve, released: release.promise };
    const pending = unknown.command(source.assistantMessageId, "peer-result-unknown", {
      action: "arrange", target: { kind: "existing", botId: target.bot.botId },
      contact: { kind: "ask", text: "Keep this original question without automatically resending unknown calls" },
    });
    let finished = false;
    try {
      await entered.promise;
      const listed = z.object({ items: z.array(botOrganizationSummarySchema) }).parse(
        await unknown.organization.command(source.assistantMessageId, "inspect-unknown", { action: "query" }));
      const current = listed.items.find(item => item.kind === "intent");
      assert(current?.kind === "intent");
      unknown.peer.recover();
      unknown.collaborations.recover();
      unknown.organization.recover();
      const beforeRelease = unknown.collaborations.organizationCollaboration(current.intentId);
      assert(beforeRelease);
      assert.equal(beforeRelease.status, "unknown", "the real peer and collaboration recovery recorded uncertainty");
      assert.equal(beforeRelease.times.returnedAt, null);
      const closing = unknown.peer.close();
      peerBarrier = undefined;
      release.resolve();
      await closing;
      const unresolved = intent(await pending);
      finished = true;
      assert.equal(unresolved.phase, "contact_unknown", "an interrupted actual peer call has a distinct truthful unknown phase");
      assert(unresolved.receipts.some(receipt => receipt.step === "contact" && receipt.status === "unknown"));
      assert(!unresolved.receipts.some(receipt => receipt.step === "contact" && receipt.status === "succeeded"));
      const callsBeforeResume = audit.providerCalls;
      const historyBeforeResume = unknown.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: beforeRelease.collaborationId });
      unknown.app.close();
      fixtures.splice(fixtures.indexOf(unknown.app), 1);
      const restored = await openFixture(join(root, "regression-peer-unknown"));
      restored.organization.recover();
      const continuation = restored.request("Inspect the saved unknown consultation without resending the original call");
      const afterResume = intent(await restored.command(continuation.assistantMessageId, "resume-unknown-ask", {
        action: "resume", intentId: current.intentId,
      }));
      assert.equal(afterResume.intentId, current.intentId);
      assert.equal(afterResume.phase, "contact_unknown", "fresh continuation preserves uncertainty after a real database reopen");
      assert(afterResume.receipts.some(receipt => receipt.step === "contact" && receipt.status === "unknown"));
      assert.equal(afterResume.times.linkedAt, null);
      assert.equal(audit.providerCalls, callsBeforeResume, "a new active caller does not authorize blind replay of an unknown recipient operation");
      const historyAfterResume = restored.collaborations.history({ botId: DEFAULT_BOT_ID, collaborationId: beforeRelease.collaborationId });
      assert.equal(historyAfterResume.collaboration.times.returnedAt, null);
      assert.deepEqual(historyAfterResume.messages, historyBeforeResume.messages, "querying/continuing unknown state invents no recipient reply or new logical request");
      assert(!afterResume.receipts.some(receipt => receipt.step === "contact" && receipt.status === "succeeded"));
      assert.equal(restored.count("works"), 0);
    } finally {
      peerBarrier = undefined;
      release.resolve();
      if (!finished) await pending;
      peerInferenceFailure = false;
    }
  });

  await regression("recovery cannot infer successful consultation from a relation without returned receipt", async () => {
    const peerFixture = await openFixture(join(root, "regression-peer-pending"));
    const target = peerFixture.creator.createBot({ requestId: randomUUID(), displayName: "未回执咨询目标", responsibilitySummary: "只读咨询" });
    assert(target.ok);
    const source = peerFixture.request("Hold a real provider request after its relation is admitted");
    const entered = deferred(), release = deferred();
    peerBarrier = { entered: entered.resolve, released: release.promise };
    peerInferenceFailure = true;
    const pending = peerFixture.command(source.assistantMessageId, "peer-pending-at-recovery", {
      action: "arrange", target: { kind: "existing", botId: target.bot.botId },
      contact: { kind: "ask", text: "Hold the inference until after local receipt reconciliation" },
    });
    let pendingContinuation: Promise<ReturnType<typeof botOrganizationSummarySchema.parse>> | undefined;
    let callsAtPendingContinuation: number | undefined;
    try {
      await entered.promise;
      const listed = z.object({ items: z.array(botOrganizationSummarySchema) }).parse(
        await peerFixture.organization.command(source.assistantMessageId, "inspect-pending", { action: "query" }));
      const pendingIntent = listed.items.find(item => item.kind === "intent");
      assert(pendingIntent?.kind === "intent");
      const admitted = peerFixture.collaborations.organizationCollaboration(pendingIntent.intentId);
      assert(admitted);
      assert.equal(admitted.times.returnedAt, null);
      peerFixture.organization.recover();
      const recovered = intent(await peerFixture.command(source.assistantMessageId, "inspect-recovered", { action: "query", intentId: pendingIntent.intentId }));
      assert.notEqual(recovered.phase, "linked", JSON.stringify({ phase: recovered.phase, relationStatus: admitted.status, returnedAt: admitted.times.returnedAt }));
      assert(!recovered.receipts.some(receipt => receipt.step === "contact" && receipt.status === "succeeded"));
      const fresh = peerFixture.request("Inspect and continue the same still-pending consultation without another recipient call");
      callsAtPendingContinuation = audit.providerCalls;
      const query = intent(await peerFixture.command(fresh.assistantMessageId, "query-held-peer", { action: "query", intentId: pendingIntent.intentId }));
      assert.notEqual(query.phase, "linked");
      pendingContinuation = peerFixture.command(fresh.assistantMessageId, "resume-held-peer", { action: "resume", intentId: pendingIntent.intentId });
      await Promise.resolve();
      assert.equal(audit.providerCalls, callsAtPendingContinuation, "fresh continuation while the actual provider is held starts no second inference");
    } finally {
      peerBarrier = undefined;
      peerInferenceFailure = false;
      release.resolve();
      await pending;
      if (pendingContinuation) {
        await pendingContinuation;
        assert.equal(audit.providerCalls, callsAtPendingContinuation, "the queued continuation also cannot resend after the original held call returns");
      }
    }
  });

  await regression("file baseline await rechecks the actual target settings revision before Work acceptance", async () => {
    const race = await openFixture(join(root, "regression-settings-race"));
    const target = race.creator.createBot({ requestId: randomUUID(), displayName: "文件监看目标", responsibilitySummary: "监看真实文件" });
    assert(target.ok);
    const watchedPath = join(root, "organization-real-watched.txt");
    writeFileSync(watchedPath, "actual file baseline before the concurrent settings update");
    const receiver = new WorkFileEventSource(race.works, () => true, () => {});
    try {
      const source = race.request("Watch this actual file, keeping my later settings edit authoritative");
      const settingsBefore = race.settings.get(target.bot.botId);
      const pending = race.command(source.assistantMessageId, "watch-settings-race", {
        action: "arrange", target: { kind: "existing", botId: target.bot.botId },
        contact: { kind: "delegate", plan: { title: "真实文件版本竞态", requestedOutcome: "ongoing", mode: "watch", startImmediately: false,
          watchRule: { eventSource: "file", eventTarget: watchedPath, triggerMode: "next_event", executionMode: "continuous",
            catchUpPolicy: "latest", scheduleBasis: "user_specified", notificationMode: "changes_only" } } },
      });
      const inFlight = z.object({ items: z.array(botOrganizationSummarySchema) }).parse(
        await race.organization.command(source.assistantMessageId, "inspect-baseline-await", { action: "query" }));
      const current = inFlight.items.find(item => item.kind === "intent");
      assert(current?.kind === "intent");
      assert(current.times.contactStartedAt !== null, "the pre-contact revision check has already run");
      assert(race.collaborations.organizationCollaboration(current.intentId), "the real relation was admitted before asynchronous file read");
      assert.equal(race.count("works"), 0, "the actual file source read has not accepted Work yet");
      const edited = await race.settings.save({ botId: target.bot.botId, expectedRevision: settingsBefore.revision,
        workspacePath: "", modelId, expertId: "", skillIds: [], mcpIds: ["fixture-mcp"], connectorIds: [] });
      const completed = intent(await pending);
      assert.deepEqual(race.settings.get(target.bot.botId), edited.settings, "a concurrent real settings save is retained");
      assert.equal(race.count("works"), 0, JSON.stringify({ phase: completed.phase, oldRevision: settingsBefore.revision,
        newRevision: edited.settings.revision, works: race.works.listWorks(LOCAL_USER_ID, { includeClosed: true }).map(item => ({ workId: item.workId, ownerBotId: item.ownerBotId })) }));
      assert.equal(completed.phase, "contact_failed");
      assert(!completed.receipts.some(receipt => receipt.step === "contact" && receipt.status === "succeeded"));
    } finally { await receiver.close(); }
  });

  await regression("a changed rationale does not create a second intent for the same executor and work", async () => {
    const equivalent = await openFixture(join(root, "regression-rationale"));
    const source = equivalent.request("Create one specialized executor for this single request");
    await equivalent.discover(source.assistantMessageId);
    const input = createCommand("同一职责执行者", workspace);
    const firstIntent = linked(await equivalent.command(source.assistantMessageId, "rationale-first", input));
    const differentlyExplained = intent(await equivalent.command(source.assistantMessageId, "rationale-second", {
      ...input, target: { ...input.target, whyExistingBotsDoNotFit: "No installed specialist currently matches this exact responsibility." },
    }));
    assert.equal(equivalent.count("bots"), 2);
    assert.equal(equivalent.count("works"), 1);
    assert.equal(differentlyExplained.intentId, firstIntent.intentId,
      JSON.stringify({ originalIntent: firstIntent.intentId, replayIntent: differentlyExplained.intentId, phase: differentlyExplained.phase }));
    assert.equal(differentlyExplained.phase, "linked");
  });
  await regression("actual per-request attachment snapshots dedupe by bytes while changed bytes remain distinct", async () => {
    const snapshots = await openFixture(join(root, "regression-snapshot-bytes"));
    const sourcePath = join(root, "repeated-ui-file.csv");
    const originalBytes = "item,quantity,unit_price\nCedar,3,17\nBirch,5,23\n";
    writeFileSync(sourcePath, originalBytes);
    const attachment = { name: "repeated-ui-file.csv", path: sourcePath };
    const text = "Create one reviewer for the exact CSV I am attaching";
    const originalRequestId = randomUUID();
    const firstSnapshots = snapshotBotAttachments(root, `${LOCAL_USER_ID}:${DEFAULT_BOT_ID}:${originalRequestId}`, [attachment]);
    const original = snapshots.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID,
      requestId: originalRequestId, text, attachments: [attachment] }, firstSnapshots);
    await snapshots.discover(original.assistantMessageId);
    const input = createCommand("附件快照核对员", workspace);
    const firstIntent = linked(await snapshots.command(original.assistantMessageId, "snapshot-original", input));
    const originalRelation = snapshots.collaborations.organizationCollaboration(firstIntent.intentId);
    assert(originalRelation?.workId);
    const duplicateRequestId = randomUUID();
    const duplicateSnapshots = snapshotBotAttachments(root, `${LOCAL_USER_ID}:${DEFAULT_BOT_ID}:${duplicateRequestId}`, [attachment]);
    assert(firstSnapshots[0] && duplicateSnapshots[0]);
    assert.notEqual(firstSnapshots[0].path, duplicateSnapshots[0].path, "the actual UI host snapshot directories differ by accepted request");
    assert.equal(readFileSync(firstSnapshots[0].path, "utf8"), readFileSync(duplicateSnapshots[0].path, "utf8"));
    const duplicate = snapshots.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID,
      requestId: duplicateRequestId, conversationId: original.conversationId, text, attachments: [attachment] }, duplicateSnapshots);
    await snapshots.discover(duplicate.assistantMessageId);
    const repeated = linked(await snapshots.command(duplicate.assistantMessageId, "snapshot-duplicate", input));
    assert.equal(repeated.intentId, firstIntent.intentId, "different immutable snapshot paths with identical file bytes preserve one creation intent");
    assert.equal(repeated.collaborationId, firstIntent.collaborationId);
    assert.equal(snapshots.collaborations.organizationCollaboration(repeated.intentId)?.workId, originalRelation.workId);
    assert.equal(snapshots.count("bots"), 2);
    assert.equal(snapshots.count("works"), 1);

    writeFileSync(sourcePath, "item,quantity,unit_price\nCedar,3,17\nBirch,6,23\n");
    const changedRequestId = randomUUID();
    const changedSnapshots = snapshotBotAttachments(root, `${LOCAL_USER_ID}:${DEFAULT_BOT_ID}:${changedRequestId}`, [attachment]);
    assert(changedSnapshots[0]);
    assert.equal(changedSnapshots[0].name, firstSnapshots[0].name);
    assert.equal(readFileSync(firstSnapshots[0].path, "utf8"), originalBytes, "the earlier host snapshot is still immutable");
    assert.notEqual(readFileSync(changedSnapshots[0].path, "utf8"), originalBytes);
    const changed = snapshots.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID,
      requestId: changedRequestId, conversationId: original.conversationId, text, attachments: [attachment] }, changedSnapshots);
    await snapshots.discover(changed.assistantMessageId);
    const changedIntent = intent(await snapshots.command(changed.assistantMessageId, "snapshot-changed-bytes", input));
    assert.notEqual(changedIntent.intentId, firstIntent.intentId, "the same filename with different actual bytes must not merge into the prior accepted Work");
    assert.notEqual(changedIntent.phase, "linked", "a new conflicting creation request cannot masquerade as the earlier successful handoff");
    assert.equal(snapshots.collaborations.organizationCollaboration(firstIntent.intentId)?.workId, originalRelation.workId);
    assert.equal(snapshots.count("works"), 1);
  });
  await regression("discovery pages beyond 100 targets without hiding truncation", async () => {
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
  });
  await regression("discovery exposes actual CAS metadata for a bounded existing-target configuration patch", async () => {
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
  });
  if (regressionFailures.length) throw new AggregateError(regressionFailures, `${regressionFailures.length} organization behavior regressions failed`);
} finally {
  state.failSchedule = false;
  for (const fixture of fixtures) fixture.close();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const relativeRoot = relative(tmpdir(), root);
  assert(relativeRoot && !relativeRoot.startsWith("..") && !isAbsolute(relativeRoot));
  assert(root.includes("bot-organization-behavior-"));
  rmSync(root, { recursive: true, force: true });
}
