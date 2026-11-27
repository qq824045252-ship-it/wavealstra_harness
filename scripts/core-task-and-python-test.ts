import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId, type EntryId, type SubmissionId } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy, maxAnswerRuleVersions, newAnswerRule } from "../src/shared/answer-routing";
import { DOTS_TASK_ID, type DotsAssistantReply } from "../src/shared/dots";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { TaskWriteQueue } from "../src/main/db/TaskWriteQueue";
import { readSoulProfile, writeSoulProfile } from "../src/main/agent/SoulProfileData";
import { migratePiAzureProviderAsync } from "../src/main/agent/PiAzureProviderMigration";
import { DurableTaskProjection } from "../src/main/agent/durable/DurableTaskProjection";
import { DurableWorkspaceMoves } from "../src/main/agent/durable/DurableWorkspaceMoves";
import { DuckDbStorage, StorageFencedError, duckDbStoreInfo, resolveStoreId } from "../src/main/agent/durable/DuckDbStorage";
import { appendDurableDotsProactive, readDotsProactive } from "../src/main/agent/durable/DurableDotsProactive";
import { appendDurableDotsReply, DOTS_REPLY_ENTRY, DOTS_OUTBOX_WRITE_REVOKED, readCommittedDotsDeliveries } from "../src/main/agent/durable/DurableDotsReply";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { createArtifactDomain, ensureTaskLegacyMigrated } from "../src/main/artifact/ArtifactDomainSetup";
import { DotsActivity } from "../src/main/dots/DotsActivity";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";
import { DotsForegroundReads } from "../src/main/dots/DotsForegroundReads";
import { DotsProactiveDelivery } from "../src/main/dots/DotsProactiveDelivery";
import { gatewayInboundAccepted, type GatewayInboundHandler } from "../src/main/gateway/channels";
import { GatewayDeliveryJournal } from "../src/main/gateway/GatewayDeliveryJournal";
import { GatewayPlatformRegistry, gatewaySessionQueueKey, type RegisteredGatewayAdapter } from "../src/main/gateway/GatewayPlatformRegistry";
import { assertExpectedPiVersion } from "../src/main/host/pi-version";
import { LibraryService } from "../src/main/library/LibraryService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import { hashContent } from "../src/main/memory/MemoryCandidateExtraction";
import { updateMemoryWrite } from "../src/main/memory/MemoryRecordWrite";
import { readCoreMemoryContext } from "../src/main/agent/CoreMemoryContextProjection";
import { MemoryTurnRepository, prepareMemoryTurn } from "../src/main/memory/MemoryTurnRepository";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { locateRuntimeAudit, RuntimeAuditReader, RuntimeAuditUnknownOperationError } from "../src/main/platform/runtime-audit";
import { deleteProjectWithLifecycle } from "../src/main/project/ProjectDeletion";
import { ProjectNotesService } from "../src/main/project/ProjectNotesService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { PythonProjectBindingStore } from "../src/main/runtime/PythonProjectBindingStore";
import { PythonRuntimeService } from "../src/main/runtime/PythonRuntimeService";
import { ArchivedContentDeletion } from "../src/main/task/ArchivedContentDeletion";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";
import { pythonProjectDirKey } from "../src/main/runtime/python-environment-spec";
import { WorkspaceNotesService } from "../src/main/workspace/WorkspaceNotesService";
import { DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS, emptyProjectPolicies } from "../src/shared/project-domain";
import { verifyTaskExpertPackages } from "./task-expert-package-cases";
import { verifyTaskWorkspaceAuthority } from "./task-workspace-authority-cases";
import { verifyConversationBranchLineage } from "./conversation-branch-lineage-cases";
import { verifyExternalAgentHistory } from "./external-agent-history-cases";
import { verifyTaskWriteGrants } from "./task-write-grants-cases";
import { verifyDurableToolPersistence } from "./durable-tool-core-cases";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const home = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-task-python-")));
const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const root = join(home, ".mybuddy");
mkdirSync(root);
const database = join(root, "app.duckdb");
const legacy = join(root, "app.db");
writeFileSync(legacy, "isolated legacy profile fixture");
const background = new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole: "background-service" });
const backgroundBindings = new PythonProjectBindingStore(background);
const at = Date.now();
const task = (id: string, title = id) => ({ id, title, at, preserveTitle: false, preserveWorkspace: false });
let application: AppDatabase | undefined;
let reopened: AppDatabase | undefined;
const coreOptions = { runtimeAuditExecutable: executable, runtimeAuditSupervised: true };

try {
  const coldBackground = background.applicationDatabaseIdentity();
  application = await AppDatabase.open(undefined, coreOptions);
  const ui = application.runtimeAuditReader!;
  const identity = application.coreIdentity;
  assert(identity?.databaseGeneration && identity.schemaVersion > 0);
  assert.deepEqual(await coldBackground, identity);
  assert.equal(application.databasePath, database);
  assert.equal(application.fixtureConnection, undefined);
  assert.equal(readFileSync(legacy, "utf8"), "isolated legacy profile fixture");
  assert.equal((await readSoulProfile(application)).name, "MyBuddy");
  const bindings = new PythonProjectBindingStore(ui);
  console.log("PASS concurrent cold startup converges on the same Core-owned app.duckdb and leaves app.db untouched");

  const event = { channelId: "telegram-default", chatId: "core-chat", direction: "in",
    senderId: "sender-1", senderName: "Local test sender", text: "First message", at } as const;
  const replay = await Promise.all([
    application.writeGatewayMessage(event),
    background.appendGatewayMessage(event),
    application.writeGatewayMessage({ ...event, text: "Second message", at: at + 1 }),
    background.appendGatewayMessage({ ...event, chatId: "other-chat", text: "Unrelated message" }),
  ]);
  assert.deepEqual(replay[1], { status: "saved" });
  assert.deepEqual(replay[3], { status: "saved" });
  const gatewayMessages = await application.readGatewayMessages({ channelId: event.channelId, chatId: event.chatId });
  assert.deepEqual(gatewayMessages.map(({ id: _id, ...row }) => row), [event, { ...event, text: "Second message", at: at + 1 }]);
  assert.deepEqual((await application.readGatewayMessages({ channelId: event.channelId, chatId: event.chatId, limit: 1 }))
    .map(row => row.text), ["Second message"]);
  console.log("PASS two Core clients persist a replayed gateway event once and read only the selected chat");

  const channelConfig = { id: "discord-default", type: "discord", name: "Discord", connected: true,
    configJson: JSON.stringify({ encryptedSecrets: "isolated-ciphertext", allowUsers: ["fixture-owner"] }), statusText: "connected" };
  assert.deepEqual(await application.readGatewayChannels(channelConfig.id), []);
  assert.equal(await application.writeGatewayChannel(channelConfig, null), true);
  const [channelBefore] = await background.readGatewayChannels(channelConfig.id) ?? [];
  assert.deepEqual(channelBefore, channelConfig);
  const manualDisconnect = { ...channelConfig, connected: false, statusText: "disconnected" };
  const credentialUpdate = { ...channelConfig, configJson: JSON.stringify({ encryptedSecrets: "isolated-replacement" }) };
  const slackChannel = { ...channelConfig, id: "slack-default", type: "slack", name: "Slack" };
  const [disconnected, changed, independentChannel] = await Promise.all([
    application.writeGatewayChannel(manualDisconnect, channelBefore),
    background.writeGatewayChannel("concurrent-gateway-update", credentialUpdate, channelBefore),
    background.writeGatewayChannel("independent-gateway-channel", slackChannel, null),
  ]);
  assert.deepEqual(changed, { status: disconnected ? "conflict" : "saved" });
  assert.deepEqual(independentChannel, { status: "saved" });
  const channelAfter = disconnected ? manualDisconnect : credentialUpdate;
  assert.deepEqual(await application.readGatewayChannels(), [channelAfter, slackChannel]);

  const configSent = ui.writeGatewayChannel.bind(ui);
  const finalChannel = { ...channelAfter, name: "Discord test channel" };
  let lostChannelOperation: string | undefined;
  ui.writeGatewayChannel = async (...args) => {
    if (lostChannelOperation !== undefined) {
      assert.equal(args[0], lostChannelOperation);
      return configSent(...args);
    }
    assert.deepEqual(await configSent(...args), { status: "saved" });
    lostChannelOperation = args[0];
    throw new RuntimeAuditUnknownOperationError(args[0], "writeGatewayChannel");
  };
  try {
    assert.equal(await application.writeGatewayChannel(finalChannel, channelAfter), true);
  } finally {
    ui.writeGatewayChannel = configSent;
  }
  assert(lostChannelOperation);
  assert.deepEqual(await background.readGatewayChannels(channelConfig.id), [finalChannel]);
  assert.deepEqual(await background.writeGatewayChannel(lostChannelOperation, channelConfig, finalChannel), { status: "operationReused" });
  assert.deepEqual(await background.readGatewayChannels(channelConfig.id), [finalChannel]);
  console.log("PASS competing gateway channel edits preserve one winner, disjoint channels persist and lost replies replay the original receipt");

  const accountKey = "a".repeat(64);
  const telegram = { id: "telegram-default", type: "telegram", name: "Telegram", connected: true,
    configJson: JSON.stringify({ allowUsers: ["admitted-owner", "second-sender"] }) };
  await application.writeGatewayChannel(telegram, null);
  assert.equal((await ui.gatewayScheduler({ action: "channelConnected", channelId: telegram.id, channelType: telegram.type, accountKey }))?.status, "ok");
  const gatewayInput = (msgId: string, msg: string, sender = "admitted-owner") => ({ platform: "telegram", accountKey,
    sessionKey: "admission-thread", payloadJson: JSON.stringify({ version: 1, channelId: telegram.id,
      chatId: "admission-group", messageId: msgId, sender: { id: sender }, text: msg }), replayNativeReceipts: true,
    maxPending: 100, maxReceipts: 100, retentionMs: 60_000,
  });
  const assignmentOrigin = (messageId: string, senderId = "admitted-owner") => ({ messageId, senderId,
    channelId: telegram.id, chatId: "admission-group", connectionKey: accountKey });
  const [admitted, capacity] = await Promise.all([
    ui.admitGatewayInbound({ ...gatewayInput("admission-1", "Before reset"), maxPending: 1 }),
    background.admitGatewayInbound({ ...gatewayInput("admission-peer", "Same capacity", "second-sender"), maxPending: 1 }),
  ]);
  assert.deepEqual([admitted?.status, capacity?.status].sort(), ["accepted", "rejected"]);
  const beforeReset = await ui.admitGatewayInbound(gatewayInput("admission-1", "Before reset"));
  assert(beforeReset?.status === "accepted");
  const oldRoute = await background.readGatewayAssignment(assignmentOrigin("admission-1"));
  assert(oldRoute?.status === "assigned" && !oldRoute.command);
  const reset = await background.admitGatewayInbound(gatewayInput("admission-new", "/new"));
  assert(reset?.status === "accepted");
  const resetRoute = await ui.readGatewayAssignment(assignmentOrigin("admission-new"));
  assert(resetRoute?.status === "assigned" && resetRoute.command && resetRoute.taskId !== oldRoute.taskId);
  const duplicateRoute = await background.admitGatewayInbound({ ...gatewayInput("admission-1", "Before reset"), maxPending: 1 });
  assert.deepEqual(duplicateRoute, { status: "accepted", duplicate: true, entry: beforeReset.entry });
  assert.deepEqual(await ui.admitGatewayInbound(gatewayInput("admission-1", "/new")), { status: "rejected", code: "PAYLOAD_CONFLICT" });
  assert.deepEqual(await ui.admitGatewayInbound({ ...gatewayInput("rejected-reset", "/new"), maxPending: 1 }), { status: "rejected", code: "CAPACITY" });
  assert.deepEqual(await background.readGatewayAssignment(assignmentOrigin("rejected-reset")), { status: "rejected", code: "NOT_ADMITTED" });
  const afterReset = await ui.admitGatewayInbound(gatewayInput("admission-2", "After reset"));
  assert(afterReset?.status === "accepted");
  assert.deepEqual(await background.readGatewayAssignment(assignmentOrigin("admission-2")), {
    status: "assigned", taskId: resetRoute.taskId, currentTaskId: resetRoute.taskId, command: false,
    oldTaskAvailable: true, personalMemoryBindingId: null,
  });
  assert.deepEqual(await ui.readGatewayAssignment(assignmentOrigin("admission-1")), {
    ...oldRoute, currentTaskId: resetRoute.taskId, oldTaskAvailable: false,
  });
  await application.writeTaskRecord({ id: oldRoute.taskId, title: "Original provider conversation", updatedAt: at });
  assert.deepEqual(await ui.readGatewayAssignment(assignmentOrigin("admission-1")), {
    ...oldRoute, currentTaskId: resetRoute.taskId, oldTaskAvailable: true,
  });
  await application.archiveTaskAsync(oldRoute.taskId, true);
  assert.deepEqual(await ui.readGatewayAssignment(assignmentOrigin("admission-1")), {
    ...oldRoute, currentTaskId: resetRoute.taskId, oldTaskAvailable: false,
  });
  assert.deepEqual(await ui.readGatewayAssignment(assignmentOrigin("admission-1", "second-sender")), { status: "rejected", code: "AUTHORIZATION_CHANGED" });
  assert.deepEqual(await background.batch4aWrite({ kind: "gatewayDeliveryOp", op: "enqueue", deliveryId: "isolated-route-conflict",
    platform: "telegram", channelId: telegram.id, accountKey, chatId: "admission-group", sessionKey: "admission-thread",
    messageId: "conflicting-reset", payloadJson: gatewayInput("conflicting-reset", "/new").payloadJson,
    payloadHash: "fixture-only-conflict", receiptMode: "pi-durable", now: at }), { ok: true });
  await assert.rejects(ui.admitGatewayInbound(gatewayInput("conflicting-reset", "/new")));
  assert.deepEqual(await ui.readGatewayAssignment(assignmentOrigin("conflicting-reset")), { status: "rejected", code: "NOT_ADMITTED" });
  assert.equal((await ui.admitGatewayInbound(gatewayInput("after-conflict", "After rejected insert")))?.status, "accepted");
  assert.deepEqual(await background.readGatewayAssignment(assignmentOrigin("after-conflict")), {
    status: "assigned", taskId: resetRoute.taskId, currentTaskId: resetRoute.taskId, command: false,
    oldTaskAvailable: true, personalMemoryBindingId: null,
  });
  console.log("PASS Gateway commits admission capacity and per-sender routing together; duplicate messages keep their assignment across /new");

  const { GatewayRouter } = await import("../src/main/gateway/GatewayRouter");
  const { AppSettingsStore } = await import("../src/main/AppSettingsStore");
  const { createIdempotencyGuard } = await import("../src/main/gateway/GatewayRateLimiter");
  const routed: Array<{ taskId: string; text: string }> = [];
  const replies: string[] = [];
  const settings = new AppSettingsStore();
  const router = new GatewayRouter({ db: application,
    agent: { runGatewayTurn: async ({ taskId, text }) => { routed.push({ taskId, text }); return "Answer from the assigned conversation"; } },
    adapters: new Map([[telegram.id, { id: telegram.id, type: "telegram", name: telegram.name,
      connect: async () => {}, disconnect: async () => {}, isConnected: () => true, statusText: () => "active", workConnectionKey: () => accountKey }]]),
    readSettings: () => settings.read(), isStopping: () => false, slackId: () => "slack-default",
    isAuthorized: () => true, isAllowed: () => true, isConversationAuthorized: () => true,
    processed: createIdempotencyGuard(), emitEvent: () => {}, redact: text => text, outboundFilter: () => text => text, safeError: String,
  }).handler();
  const routeTurn = (messageId: string, text: string, deliveryId: string) => router({ channelId: telegram.id,
    chatId: "admission-group", messageId, text, sender: { id: "admitted-owner" }, gatewayDelivery: { id: deliveryId, replay: false },
    reply: async response => { replies.push(response); },
  });
  await routeTurn("admission-2", "After reset", afterReset.entry.delivery_id);
  await routeTurn("admission-1", "Before reset", beforeReset.entry.delivery_id);
  await routeTurn("never-admitted", "Unverified assignment", afterReset.entry.delivery_id);
  assert.deepEqual(routed, [{ taskId: resetRoute.taskId, text: "After reset" }]);
  assert.deepEqual(replies, ["Answer from the assigned conversation", "这条旧消息所属会话不可用，未转入当前新会话。",
    "处理失败：Error: Core 未确认渠道会话或收件授权"]);
  assert.deepEqual(await ui.batch2Write({ kind: "deleteTask", id: oldRoute.taskId }), { ok: true });
  console.log("PASS GatewayRouter hands only committed Core assignments to the Agent port");

  const qq = { id: "qq-default", type: "qq", name: "QQ", connected: true,
    configJson: JSON.stringify({ allowUsers: ["private-owner"] }) };
  const emptyChannel = await ui.readGatewayChannelState(qq.id);
  assert(emptyChannel && emptyChannel.channel === null);
  const consent = { kind: "connect", accountKey, personalMemoryOwnerId: "private-owner" } as const;
  assert.deepEqual(await background.writeGatewayChannel("grant-disallowed-owner", qq, null, emptyChannel.revision,
    { ...consent, personalMemoryOwnerId: "someone-else" }), { status: "invalid" });
  assert.deepEqual(await ui.readGatewayChannelState(qq.id), emptyChannel);
  assert.deepEqual(await background.writeGatewayChannel("grant-qq", qq, null, emptyChannel.revision, consent), { status: "saved" });
  const connectedQq = await ui.readGatewayChannelState(qq.id);
  assert(connectedQq && connectedQq.channel);
  const privateOrigin = { channelId: qq.id, connectionKey: accountKey, chatId: "c2c:private-owner", senderId: "private-owner", messageId: "private-1" };
  const privateInput = { ...gatewayInput("ignored", "ignored"), platform: "qq", sessionKey: "private-thread",
    payloadJson: JSON.stringify({ version: 1, channelId: qq.id, chatId: privateOrigin.chatId, messageId: privateOrigin.messageId,
      text: "Owner note", sender: { id: privateOrigin.senderId }, audience: "private",
      replyRoute: { kind: "qq", recipient: privateOrigin.senderId, group: false } }),
  };
  const privateReceipt = await ui.admitGatewayInbound(privateInput);
  assert(privateReceipt?.status === "accepted");
  const privateRoute = await background.readGatewayAssignment(privateOrigin);
  assert(privateRoute?.status === "assigned" && privateRoute.personalMemoryBindingId);
  const sharedOrigin = { ...privateOrigin, messageId: "shared-1" };
  assert.equal((await ui.admitGatewayInbound({ ...privateInput, payloadJson: JSON.stringify({ ...JSON.parse(privateInput.payloadJson),
    audience: "shared", messageId: sharedOrigin.messageId }) }))?.status, "accepted");
  const sharedRoute = await background.readGatewayAssignment(sharedOrigin);
  assert(sharedRoute?.status === "assigned" && sharedRoute.personalMemoryBindingId === null && sharedRoute.taskId !== privateRoute.taskId);
  assert.deepEqual(await ui.admitGatewayInbound({ ...privateInput, payloadJson: JSON.stringify({ ...JSON.parse(privateInput.payloadJson),
    replyRoute: { kind: "qq", recipient: "another-user", group: false } }) }), { status: "rejected", code: "AUTHORIZATION_CHANGED" });
  const disconnectedQq = { ...qq, connected: false };
  const [disconnectRace, restoreRace] = await Promise.all([
    background.writeGatewayChannel("disconnect-qq", disconnectedQq, qq, connectedQq.revision, { kind: "disconnect" }),
    ui.writeGatewayChannel("restore-qq", qq, qq, connectedQq.revision, { kind: "restore", accountKey }),
  ]);
  assert.deepEqual([disconnectRace?.status, restoreRace?.status].sort(), ["conflict", "saved"]);
  if (restoreRace?.status === "saved") {
    assert.deepEqual(await ui.readGatewayAssignment(privateOrigin), privateRoute);
    const restoredQq = await ui.readGatewayChannelState(qq.id);
    assert(restoredQq?.channel);
    assert.deepEqual(await background.writeGatewayChannel("disconnect-after-restore", disconnectedQq, qq, restoredQq.revision,
      { kind: "disconnect" }), { status: "saved" });
  }
  const offlineQq = await ui.readGatewayChannelState(qq.id);
  assert(offlineQq && offlineQq.channel);
  assert.deepEqual(await ui.writeGatewayChannel("ordinary-qq", qq, offlineQq.channel, offlineQq.revision,
    { kind: "connect", accountKey }), { status: "saved" });
  assert.deepEqual(await ui.writeGatewayChannel("late-qq-consent", qq, qq, connectedQq.revision, consent), { status: "conflict" });
  assert.deepEqual(await ui.writeGatewayChannel("grant-qq", qq, null, emptyChannel.revision, consent), { status: "saved" });
  assert.deepEqual(await ui.readGatewayAssignment(privateOrigin), { status: "rejected", code: "AUTHORIZATION_CHANGED" });
  assert.deepEqual(await ui.admitGatewayInbound(privateInput), { status: "rejected", code: "AUTHORIZATION_CHANGED" });
  assert.deepEqual(await background.readGatewayInbox(privateReceipt.entry.delivery_id), privateReceipt.entry);
  const ordinaryOrigin = { ...privateOrigin, messageId: "ordinary-private" };
  assert.equal((await ui.admitGatewayInbound({ ...privateInput, payloadJson: JSON.stringify({ ...JSON.parse(privateInput.payloadJson),
    messageId: ordinaryOrigin.messageId }) }))?.status, "accepted");
  const ordinaryRoute = await ui.readGatewayAssignment(ordinaryOrigin);
  assert(ordinaryRoute?.status === "assigned" && ordinaryRoute.personalMemoryBindingId === null);
  console.log("PASS Gateway stores consent with the channel, allows one winner for concurrent restore and disconnect, and never revives a revoked grant on stale writes or replay");

  const replacementAccount = "b".repeat(64);
  assert.equal((await ui.gatewayScheduler({ action: "channelConnected", channelId: telegram.id, channelType: telegram.type,
    accountKey: replacementAccount }))?.status, "ok");
  assert.deepEqual(await background.admitGatewayInbound(gatewayInput("admission-2", "After reset")), { status: "rejected", code: "AUTHORIZATION_CHANGED" });
  const switched = await background.admitGatewayInbound({ ...gatewayInput("admission-2", "New account"), accountKey: replacementAccount });
  assert(switched?.status === "accepted" && switched.entry.delivery_id !== afterReset.entry.delivery_id);
  const replacementRoute = await ui.readGatewayAssignment({ ...assignmentOrigin("admission-2"), connectionKey: replacementAccount });
  assert(replacementRoute?.status === "assigned" && replacementRoute.taskId !== resetRoute.taskId);
  assert.equal((await ui.gatewayScheduler({ action: "channelConnected", channelId: telegram.id, channelType: telegram.type, accountKey }))?.status, "ok");
  console.log("PASS replacing a channel account refuses the old replay without inheriting its conversation");

  const journal = new GatewayDeliveryJournal(undefined, { native: ui });
  const delivered: string[] = [];
  const registry = new GatewayPlatformRegistry({ journal, replayNativeReceipts: true, coreControlled: true,
    onScheduleRecover: () => undefined, authorize: message => message.sender?.id === "admitted-owner" });
  let receive!: GatewayInboundHandler;
  const adapter: RegisteredGatewayAdapter = { ...telegram, type: "telegram", connect: async () => {}, disconnect: async () => {},
    isConnected: () => true, statusText: () => "connected", workConnectionKey: () => accountKey,
    setInboundHandler: handler => { receive = handler; }, restoreGatewayReply: () => async text => { delivered.push(text); } };
  const earlierStarted = Promise.withResolvers<void>();
  const releaseEarlier = Promise.withResolvers<void>();
  const executed: string[] = [];
  registry.register(adapter, async ({ message }) => {
    executed.push(message.text);
    if (message.text === "earlier-1") {
      earlierStarted.resolve();
      await releaseEarlier.promise;
    }
    await message.reply(`reply:${message.text}`);
  });
  const input = (chatId: string, messageId: string, text: string) => ({ channelId: telegram.id, chatId, messageId, text,
    sender: { id: "admitted-owner" }, replyRoute: { kind: "telegram" as const, chatId, replyToMessageId: Number(messageId) } });
  const seedStored = async (message: ReturnType<typeof input>) => {
    const result = await background.admitGatewayInbound({ ...gatewayInput(message.messageId, message.text),
      sessionKey: gatewaySessionQueueKey(adapter, accountKey, message), payloadJson: JSON.stringify({ version: 1, ...message }) });
    assert(result?.status === "accepted");
    return result.entry.delivery_id;
  };
  await seedStored(input("901", "1", "earlier-1"));
  await seedStored(input("901", "2", "earlier-2"));
  await seedStored(input("902", "1", "second-chat-old"));
  const limited = await journal.readRecovery({ channelId: telegram.id, accountKey, sessionKey: gatewaySessionQueueKey(adapter, accountKey, { chatId: "901" }),
    cutoff: Date.now(), limit: 1, retryBlocked: false, continuationsOnly: false });
  assert.deepEqual(limited.pending.map(entry => entry.message_id), ["1"]);
  assert.equal(limited.truncated, true);
  const acceptLive = (message: ReturnType<typeof input>) => receive({ ...message, reply: async text => { delivered.push(text); } });
  const fresh = acceptLive(input("901", "3", "fresh"));
  try {
    await gatewayInboundAccepted(fresh);
    await earlierStarted.promise;
    await acceptLive(input("902", "2", "second-chat-new"));
    assert.deepEqual(executed, ["earlier-1", "second-chat-old", "second-chat-new"]);
    assert.deepEqual(delivered, ["reply:second-chat-old", "reply:second-chat-new"]);
  } finally {
    releaseEarlier.resolve();
  }
  await fresh;
  assert.deepEqual(executed, ["earlier-1", "second-chat-old", "second-chat-new", "earlier-2", "fresh"]);
  assert.deepEqual(delivered, ["reply:second-chat-old", "reply:second-chat-new", "reply:earlier-1", "reply:earlier-2", "reply:fresh"]);

  const paused = await seedStored(input("903", "1", "paused-replay"));
  const snapshotRead = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  const readRecovery = journal.readRecovery.bind(journal);
  journal.readRecovery = async query => {
    const state = await readRecovery(query);
    snapshotRead.resolve();
    await resumeRead.promise;
    return state;
  };
  const pausedFresh = acceptLive(input("903", "2", "paused-fresh"));
  await snapshotRead.promise;
  registry.pause(telegram.id);
  registry.recoverScheduled(telegram.id);
  resumeRead.resolve();
  await assert.rejects(gatewayInboundAccepted(pausedFresh), /连接或授权已变化/);
  await assert.rejects(gatewayInboundAccepted(acceptLive(input("903", "2", "paused-fresh"))), /消息尚未接收/);
  assert.equal((await ui.readGatewayInbox(paused))?.status, "pending");
  assert.equal(executed.some(text => text.startsWith("paused-")), false);

  const receiptReached = Promise.withResolvers<string>();
  const releaseReceipt = Promise.withResolvers<void>();
  const admit = journal.admit.bind(journal);
  journal.admit = async draft => {
    const receipt = await admit(draft);
    receiptReached.resolve(receipt.entry.delivery_id);
    await releaseReceipt.promise;
    return receipt;
  };
  const receivingRegistry = new GatewayPlatformRegistry({ journal, replayNativeReceipts: true, coreControlled: true,
    onScheduleRecover: () => undefined });
  receivingRegistry.register(adapter, async ({ message }) => { executed.push(message.text); });
  const inFlightReceipt = acceptLive(input("904", "1", "paused-after-commit"));
  const acceptedDuringPause = await receiptReached.promise;
  receivingRegistry.pause(telegram.id);
  releaseReceipt.resolve();
  await gatewayInboundAccepted(inFlightReceipt);
  await inFlightReceipt;
  assert.equal((await ui.readGatewayInbox(acceptedDuringPause))?.status, "pending");
  assert.equal(executed.includes("paused-after-commit"), false);
  receivingRegistry.suspend();
  registry.suspend();
  console.log("PASS Gateway Core recovery preserves FIFO per chat and fences late reads and committed ACKs after pause");

  const seedGatewayInput = async (id: string) => {
    assert.deepEqual(await ui.batch4aWrite({ kind: "gatewayDeliveryOp", op: "enqueue", deliveryId: id,
      platform: "telegram", channelId: "telegram-default", accountKey: "fixture-account", chatId: "core-claims",
      sessionKey: "core-claims", messageId: id, payloadJson: "{}", payloadHash: "fixture-hash", receiptMode: "pi-durable", now: at }), { ok: true });
  };
  const claimDelivery = "gateway-racing-claims";
  await seedGatewayInput(claimDelivery);
  const claimOp = ["claim-from-ui", "claim-from-background"] as const;
  const executions = await Promise.all([
    ui.gatewayDeliveryControl(claimDelivery, claimOp[0], { action: "claimExecution" }),
    background.gatewayDeliveryControl(claimDelivery, claimOp[1], { action: "claimExecution" }),
  ]);
  assert.deepEqual(executions.map(reply => reply?.status).sort(), ["claimed", "unavailable"]);
  const winningOp = executions[0]?.status === "claimed" ? claimOp[0] : claimOp[1];
  assert.deepEqual(await background.batch4aWrite({ kind: "gatewayDeliveryOp", op: "blockUnclaimed",
    deliveryId: claimDelivery, reason: "foreign_validation_failed", now: at }), { ok: true });
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, winningOp, { action: "claimExecution" }), { status: "claimed", attempt: 1 });
  assert.deepEqual(await background.gatewayDeliveryControl(claimDelivery, "wrong-attempt-answer", {
    action: "queueReply", attempt: 2, text: "Stale answer",
  }), { status: "stale" });
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, "save-reply", {
    action: "queueReply", attempt: 1, text: "Durable answer",
  }), { status: "applied" });
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, winningOp, { action: "claimExecution" }), { status: "stale" });

  const sendOp = ["send-from-ui", "send-from-background"] as const;
  const sends = await Promise.all([
    ui.gatewayDeliveryControl(claimDelivery, sendOp[0], { action: "claimReply", maxAttempts: 3 }),
    background.gatewayDeliveryControl(claimDelivery, sendOp[1], { action: "claimReply", maxAttempts: 3 }),
  ]);
  assert.deepEqual(sends.map(reply => reply?.status).sort(), ["sending", "unavailable"]);
  const sendWinner = sends[0]?.status === "sending" ? 0 : 1;
  const sending = sends[sendWinner];
  assert(sending?.status === "sending" && sending.entry.reply_text === "Durable answer" && sending.entry.retry_count === 1);
  assert.deepEqual(await background.batch4aWrite({ kind: "gatewayDeliveryOp", op: "blockUnclaimed",
    deliveryId: claimDelivery, reason: "foreign_validation_failed", now: at }), { ok: true });
  assert.equal((await background.gatewayScheduler({ action: "start" }))?.status, "ok");
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, sendOp[sendWinner], { action: "claimReply", maxAttempts: 3 }), sending);
  assert.deepEqual(await background.gatewayDeliveryControl(claimDelivery, "return-to-queue", {
    action: "finishReply", attempt: 1, outcome: "pending", reason: "provider_not_sent", nextAttemptAt: at,
  }), { status: "applied" });
  const secondSend = await ui.gatewayDeliveryControl(claimDelivery, "retry-confirmed-not-sent", { action: "claimReply", maxAttempts: 3 });
  assert(secondSend?.status === "sending" && secondSend.entry.retry_count === 2);
  assert.deepEqual(await background.gatewayDeliveryControl(claimDelivery, "late-provider-response", {
    action: "finishReply", attempt: 1, outcome: "sent",
  }), { status: "stale" });
  const sendReceipt = { action: "finishReply", attempt: 2, outcome: "sent" } as const;
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, "confirm-provider-send", sendReceipt), { status: "applied" });
  assert.deepEqual(await background.gatewayDeliveryControl(claimDelivery, "confirm-provider-send", sendReceipt), { status: "applied" });
  assert.deepEqual(await ui.gatewayDeliveryControl(claimDelivery, "try-after-sent", { action: "claimReply", maxAttempts: 3 }), { status: "sent" });
  assert.equal((await background.readGatewayOutbox(claimDelivery))?.reply_text, "Durable answer");
  console.log("PASS competing Gateway clients acquire one execution and one send; a later attempt rejects the earlier provider response");

  const reconciled = "gateway-provider-reconcile";
  const unqueryable = "gateway-provider-unqueryable";
  const trackUnknown = (id: string, attempt: number, queryable: boolean) => background.gatewayScheduler({
    action: "trackOutbound", deliveryId: id, attempt, channelId: "telegram-default", channelType: "telegram",
    accountKey: "fixture-account", queryable, state: "unknown",
  });
  const settleUnknown = (id: string, attempt: number, outcome: "confirmed_sent" | "confirmed_not_sent") =>
    ui.gatewayScheduler({ action: "settleUnknown", deliveryId: id, attempt, outcome });
  for (const id of [reconciled, unqueryable]) {
    const inbound = { action: "admitInbound", deliveryId: id, platform: "telegram", channelId: "telegram-default",
      accountKey: "fixture-account", sessionKey: "core-claims", messageId: id, payloadJson: '{"chatId":"core-claims"}',
      payloadHash: `fixture-${id}` };
    assert.equal((await ui.gatewayScheduler(inbound))?.duplicate, false);
    assert.equal((await background.gatewayScheduler(inbound))?.duplicate, true);
    assert.deepEqual(await ui.gatewayDeliveryControl(id, "claim-for-reconciliation", { action: "claimExecution" }), { status: "claimed", attempt: 1 });
    assert.deepEqual(await ui.gatewayDeliveryControl(id, "queue-for-reconciliation", {
      action: "queueReply", attempt: 1, text: "Reply to reconcile",
    }), { status: "applied" });
    assert.equal((await ui.gatewayDeliveryControl(id, "first-reconcile-send", { action: "claimReply", maxAttempts: 3 }))?.status, "sending");
    assert.deepEqual(await ui.gatewayDeliveryControl(id, "unknown-first-send", {
      action: "finishReply", attempt: 1, outcome: "unknown", reason: "provider_receipt_unknown",
    }), { status: "applied" });
  }
  assert.equal((await trackUnknown(reconciled, 1, true))?.state, "pending_reconcile");
  assert.equal((await trackUnknown(unqueryable, 1, false))?.state, "unknown_unqueryable");
  assert.equal((await settleUnknown(unqueryable, 1, "confirmed_not_sent"))?.code, "STALE_OUTBOUND_ATTEMPT");
  assert.equal((await background.readGatewayOutbox(unqueryable))?.status, "unknown");
  assert.equal((await settleUnknown(reconciled, 1, "confirmed_not_sent"))?.state, "confirmed_not_sent");
  const nextReconcileSend = await ui.gatewayDeliveryControl(reconciled, "second-reconcile-send", { action: "claimReply", maxAttempts: 3 });
  assert(nextReconcileSend?.status === "sending" && nextReconcileSend.entry.retry_count === 2);
  assert.deepEqual(await ui.gatewayDeliveryControl(reconciled, "unknown-second-send", {
    action: "finishReply", attempt: 2, outcome: "unknown", reason: "provider_receipt_unknown",
  }), { status: "applied" });
  assert.equal((await trackUnknown(reconciled, 2, true))?.state, "pending_reconcile");
  assert.equal((await settleUnknown(reconciled, 1, "confirmed_not_sent"))?.code, "STALE_OUTBOUND_ATTEMPT");
  assert.equal((await settleUnknown(reconciled, 2, "confirmed_sent"))?.state, "confirmed_sent");
  assert.equal((await trackUnknown(reconciled, 2, true))?.code, "STALE_OUTBOUND_ATTEMPT");
  assert.equal((await background.readGatewayOutbox(reconciled))?.status, "sent");
  console.log("PASS Gateway reconciliation rejects answers from an older send and only requeues queryable proof of non-delivery");

  const futureReply = "gateway-future-retry";
  const deadline = Date.now() + 60_000;
  await seedGatewayInput(futureReply);
  assert.deepEqual(await ui.gatewayDeliveryControl(futureReply, "claim-future", { action: "claimExecution" }), { status: "claimed", attempt: 1 });
  assert.deepEqual(await ui.gatewayDeliveryControl(futureReply, "save-future", {
    action: "queueReply", attempt: 1, text: "Scheduled retry",
  }), { status: "applied" });
  assert.equal((await ui.gatewayDeliveryControl(futureReply, "send-before-retry", { action: "claimReply", maxAttempts: 3 }))?.status, "sending");
  assert.deepEqual(await ui.gatewayDeliveryControl(futureReply, "schedule-future", {
    action: "finishReply", attempt: 1, outcome: "pending", reason: "provider_not_sent", nextAttemptAt: deadline,
  }), { status: "applied" });
  const claimScope = { channelId: telegram.id, accountKey: "fixture-account", sessionKey: "core-claims",
    limit: 64, retryBlocked: true, continuationsOnly: false };
  const beforeDeadline = await journal.readRecovery({ ...claimScope, cutoff: deadline - 1 });
  assert.deepEqual(beforeDeadline.pending, []);
  assert.equal(beforeDeadline.nextRetryAt, deadline);
  const atDeadline = await journal.readRecovery({ ...claimScope, cutoff: deadline });
  assert.deepEqual(atDeadline.pending.map(entry => entry.delivery_id), [futureReply]);
  assert.equal(atDeadline.nextRetryAt, null);
  assert.equal((await background.readGatewayOutbox(unqueryable))?.status, "unknown");
  const onlyContinuations = await journal.readRecovery({ ...claimScope, cutoff: deadline, continuationsOnly: true });
  assert.deepEqual(onlyContinuations.pending, []);
  console.log("PASS Gateway recovery moves a retry into the due list at its deadline without resending unknown replies");

  const restartRunning = "gateway-restart-running";
  const restartSending = "gateway-restart-sending";
  for (const id of [restartRunning, restartSending]) {
    await seedGatewayInput(id);
    assert.deepEqual(await ui.gatewayDeliveryControl(id, "before-restart", { action: "claimExecution" }), { status: "claimed", attempt: 1 });
  }
  assert.deepEqual(await ui.gatewayDeliveryControl(restartSending, "reply-before-restart", {
    action: "queueReply", attempt: 1, text: "Might have reached the provider",
  }), { status: "applied" });
  assert.equal((await ui.gatewayDeliveryControl(restartSending, "send-before-restart", { action: "claimReply", maxAttempts: 3 }))?.status, "sending");

  const uiBots = new BotRegistry(undefined, ui);
  const backgroundBots = new BotRegistry(undefined, background);
  const [defaultBot, sameBot] = await Promise.all([
    uiBots.ensureDefaultBotSaved(LOCAL_USER_ID), backgroundBots.ensureDefaultBotSaved(LOCAL_USER_ID),
  ]);
  assert.deepEqual(defaultBot, sameBot);
  assert.equal(defaultBot.botId, DEFAULT_BOT_ID);
  assert.equal(defaultBot.organizationRole, "primary");
  assert.equal(defaultBot.expertProfile.activeVersion, defaultBot.expertProfile.desiredVersion);
  assert.deepEqual(await backgroundBots.registerSaved({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID,
    displayName: "Different name", status: "disabled", expertProfile: { desiredVersion: 12 } }), defaultBot);
  await assert.rejects(backgroundBots.ensureDefaultBotSaved("different-user"), /Bot 不属于该用户/);
  assert.deepEqual(await uiBots.readBots(LOCAL_USER_ID), [defaultBot]);
  assert.deepEqual(await backgroundBots.readBots("different-user"), []);

  const sendBot: RuntimeAuditReader["registerBot"] = ui.registerBot.bind(ui);
  let lostBot: { request: Parameters<typeof sendBot>[0]; reply: Awaited<ReturnType<typeof sendBot>> } | undefined;
  ui.registerBot = async registration => {
    const result = await sendBot(registration);
    if (lostBot) return result;
    assert.equal(result?.ok, true);
    lostBot = { request: registration, reply: result };
    throw new RuntimeAuditUnknownOperationError("lost-registration", "batch4bWrite");
  };
  try {
    await Promise.all([
      uiBots.registerSaved({ botId: "candidate-a", userId: "another-user", displayName: "First" }, true),
      backgroundBots.registerSaved({ botId: "candidate-b", userId: "another-user", displayName: "Second" }, true),
    ]);
  } finally {
    ui.registerBot = sendBot;
  }
  assert(lostBot);
  const candidates = await backgroundBots.readBots("another-user");
  assert.deepEqual(candidates.map(bot => bot.botId).sort(), ["candidate-a", "candidate-b"]);
  assert.equal(candidates.filter(bot => bot.organizationRole === "primary").length, 1);
  const primary = candidates.find(bot => bot.organizationRole === "primary")!;
  const ordinary = candidates.find(bot => bot.organizationRole === "ordinary")!;
  assert.deepEqual(await background.batch4bWrite({ op: "botDelete", botId: primary.botId }), { ok: true });
  assert.equal(await uiBots.readBot(primary.botId), undefined);
  assert.equal((await uiBots.registerSaved(ordinary, true)).organizationRole, "primary");
  await background.batch4bWrite({ op: "botDelete", botId: lostBot.request.botId });
  assert.deepEqual(await sendBot(lostBot.request), lostBot.reply);
  await assert.rejects(sendBot({ ...lostBot.request, displayName: "Different request" }));
  assert.equal(await uiBots.readBot(lostBot.request.botId), undefined);
  assert.deepEqual(await ui.batch4bWrite({ op: "botChannelBind", channelType: "desktop", channelIdentifier: "registry-fixture",
    botId: DEFAULT_BOT_ID, boundAt: at }), { ok: true });
  assert.deepEqual(await backgroundBots.readChannelBot(LOCAL_USER_ID, "desktop", "registry-fixture"), defaultBot);
  assert.equal(await backgroundBots.readChannelBot("another-user", "desktop", "registry-fixture"), undefined);
  console.log("PASS concurrent default registration preserves identity, role and expert version; retry and conflicting owners cannot replace it");

  assert.equal(await ui.taskRecord("unknown", false), null);
  const dotsOpens = await Promise.all([ui, background].map(reader => reader.batch2Write({ kind: "openDots", at })));
  assert.deepEqual(dotsOpens, [{ ok: true }, { ok: true }]);
  assert.equal((await background.taskRecord(DOTS_TASK_ID, true))?.title, "Dots");
  assert.deepEqual(await background.taskList(DOTS_TASK_ID, true), []);

  const ids = Array.from({ length: 8 }, (_, index) => `task-${index}`);
  const saved = await Promise.all(ids.map((id, index) => [ui, background][index % 2].upsertTaskRecord(task(id))));
  assert(saved.every(reply => reply?.status === "saved"));
  await Promise.all([
    ui.upsertTaskRecord(task(ids[0], "Current title")),
    background.upsertTaskRecord({ ...task(ids[0], "Stale title"), preserveTitle: true, expectedTitle: "Older title" }),
  ]);
  const rows = await background.taskList(DOTS_TASK_ID, false);
  assert.deepEqual(rows?.map(row => row.id).sort(), ids);
  assert.equal((await ui.taskRecord(ids[0], true))?.title, "Current title");

  const queue = new TaskWriteQueue();
  const pause = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const slow = queue.run([ids[1]], async () => {
    entered.resolve();
    await pause.promise;
    return ui.upsertTaskRecord(task(ids[1], "First edit"));
  });
  await entered.promise;
  const following = queue.run([ids[1], ids[2]], () => ui.upsertTaskRecord(task(ids[1], "Second edit")));
  const independent = queue.run([ids[3]], () => background.upsertTaskRecord(task(ids[3], "Other task saved")));
  let drained = false;
  const drain = queue.flush().then(() => { drained = true; });
  try {
    const receipt = await Promise.race([independent, delay(5000, undefined, { ref: false })]);
    assert.equal(receipt?.status, "saved", "Unrelated writes must complete while the first task waits");
    assert.equal((await background.taskRecord(ids[3], false))?.title, "Other task saved");
    assert.equal((await background.taskRecord(ids[1], false))?.title, ids[1]);
    assert.equal(drained, false);
  } finally {
    pause.resolve();
    await Promise.allSettled([slow, following, independent, drain]);
  }
  assert.equal((await ui.taskRecord(ids[1], false))?.title, "Second edit");
  assert.equal(drained, true);
  console.log("PASS an independent task commits while another task waits, and same-task writes stay ordered");

  const trashed = ids.at(-1)!;
  assert.deepEqual(await ui.batch2Write({ kind: "upsertTaskExecutionWorkspaceState", taskId: trashed,
    directoryName: trashed, state: "trashed", createdAt: at, updatedAt: at, trashedAt: at }), { ok: true });
  assert.equal((await background.taskRecord(trashed, false))?.title, trashed);
  assert.deepEqual((await background.taskList(DOTS_TASK_ID, false))?.map(row => row.id).sort(), ids.slice(0, -1));

  const taskLifecycle = new TaskExecutionWorkspaceLifecycle({ db: application, trashRoot: join(root, "task-lifecycle-trash") });
  const archiveId = ids[0];
  await taskLifecycle.writeArchive(archiveId, true);
  assert.equal((await background.taskRecord(archiveId, false))?.archived, 1);
  await taskLifecycle.writeArchive(archiveId, false);
  assert.equal((await background.taskRecord(archiveId, false))?.archived, 0);
  await assert.rejects(taskLifecycle.writeArchive(trashed, false), /请用 restore/);
  assert.deepEqual((await taskLifecycle.listTrashedTasks()).filter(row => row.id === trashed)
    .map(row => [row.id, row.directoryMissing]), [[trashed, true]]);
  const archiveDeletion = new ArchivedContentDeletion({ db: application, lifecycle: taskLifecycle });
  const rejectedSelection = await archiveDeletion.purge({ spaceIds: ["missing-archive-space"], taskIds: [archiveId] });
  assert.deepEqual(rejectedSelection.deletedTaskIds, []);
  assert.deepEqual(rejectedSelection.deletedSpaceIds, []);
  assert.deepEqual(rejectedSelection.failures.map(({ kind, id }) => [kind, id]), [
    ["space", "missing-archive-space"], ["task", archiveId],
  ]);
  console.log("PASS archives and unarchives through the lifecycle, while recycle-bin tasks keep a separate state");

  const samePath = join(root, "same-workspace");
  const fallback = { name: "Same workspace", path: samePath };
  const attached = await Promise.all([
    ui.upsertTaskRecord({ ...task("attached-1"), spaceId: "requested-1", workspaceFallback: fallback }),
    background.upsertTaskRecord({ ...task("attached-2"), spaceId: "requested-2", workspaceFallback: fallback }),
  ]);
  assert(attached.every(reply => reply?.status === "saved"));
  const firstAttached = await ui.taskRecord("attached-1", false);
  const secondAttached = await background.taskRecord("attached-2", false);
  assert(firstAttached?.space_id && firstAttached.space_id === secondAttached?.space_id);
  const missingProject = await ui.upsertTaskRecord({ ...task("rejected-with-workspace"), spaceId: "orphan-workspace",
    workspaceFallback: { name: "Orphan workspace" }, projectId: "missing-project" });
  assert.equal(missingProject?.status, "rejected");
  assert.equal(await background.taskRecord("rejected-with-workspace", false), null);
  const spaces = await ui.workspaceData({ kind: "spaces" });
  assert.deepEqual(spaces?.spaces.map(space => space.id), [firstAttached.space_id]);

  for (let index = 0; index < 8; index++) {
    const spaceId = `concurrent-space-${index}`;
    const taskId = `concurrent-task-${index}`;
    assert.equal((await ui.upsertWorkspace({ id: spaceId, name: spaceId, at }))?.status, "saved");
    const [created, deleted] = await Promise.all([
      background.upsertTaskRecord({ ...task(taskId), spaceId }),
      ui.deleteWorkspace({ id: spaceId, dotsTaskId: DOTS_TASK_ID }),
    ]);
    if (created?.status === "saved") {
      assert.equal(deleted?.status, "rejected", "A connected workspace cannot be deleted");
      assert.equal((await ui.taskRecord(taskId, false))?.space_id, spaceId);
    } else {
      assert.equal(created?.status, "missingWorkspace");
      assert.equal(deleted?.status, "saved");
      assert.equal(await ui.taskRecord(taskId, false), null);
    }
  }
  console.log("PASS exact task reads, Dots visibility, concurrent updates, atomic workspace resolution and delete races");

  const oldWorkspaces = join(root, "projects");
  const newWorkspaces = join(root, "task-workspaces");
  const oldTrash = join(root, "projects-trash");
  const newTrash = join(root, "task-workspaces-trash");
  const currentCwd = join(root, "user-changed-workspace");
  const aliveLegacy = join(oldWorkspaces, "still-present");
  mkdirSync(aliveLegacy, { recursive: true });
  for (const [id, cwd] of [["relocate", join(oldWorkspaces, "relocate")], ["edited", join(oldWorkspaces, "edited")], ["existing", aliveLegacy]]) {
    await application.writeTaskRecord({ id, title: id, cwd, updatedAt: at });
  }
  assert.deepEqual(await background.batch2Write({ kind: "upsertTaskExecutionWorkspaceState", taskId: "relocate", directoryName: "relocate",
    state: "trashed", createdAt: at, updatedAt: at, trashedAt: at, trashPath: join(oldTrash, "relocate") }), { ok: true });
  const readPaths = ui.taskWorkspacePaths.bind(ui);
  ui.taskWorkspacePaths = async () => {
    const snapshot = await readPaths();
    assert.equal((await background.upsertTaskRecord({ ...task("edited"), cwd: currentCwd }))?.status, "saved");
    return snapshot;
  };
  assert.deepEqual(await application.writeLegacyTaskWorkspacePaths(oldWorkspaces, newWorkspaces, oldTrash, newTrash), { cwds: 1, trashPaths: 1 });
  ui.taskWorkspacePaths = readPaths;
  assert.deepEqual((await readPaths())?.trashPaths, [{ id: "relocate", path: join(newTrash, "relocate") }]);
  assert.equal((await application.readTask("relocate"))?.cwd, join(newWorkspaces, "relocate"));
  assert.equal((await application.readTask("edited"))?.cwd, currentCwd);
  assert.equal((await application.readTask("existing"))?.cwd, aliveLegacy);
  assert.deepEqual(await application.writeLegacyTaskWorkspacePaths(oldWorkspaces, newWorkspaces, oldTrash, newTrash), { cwds: 0, trashPaths: 0 });
  console.log("PASS startup path repair commits once, preserves existing folders and leaves concurrent user edits intact");

  const azureCwd = join(root, "azure-task");
  const azureSettings = join(azureCwd, ".pi", "settings.json");
  mkdirSync(join(azureCwd, ".pi"), { recursive: true });
  writeFileSync(azureSettings, JSON.stringify({ defaultProvider: "azure-openai-responses", defaultModelId: "azure-openai-responses/fixture" }));
  await application.writeTaskRecord({ id: "azure-task", title: "Azure task", cwd: azureCwd,
    modelId: "azure-openai-responses/fixture", updatedAt: at });
  assert.deepEqual(await migratePiAzureProviderAsync(root, application.fixtureConnection, background), { files: 1, selections: 1 });
  assert.deepEqual(JSON.parse(readFileSync(azureSettings, "utf8")), { defaultProvider: "azure", defaultModelId: "azure/fixture" });
  assert.equal((await application.readTask("azure-task"))?.modelId, "azure/fixture");
  assert.deepEqual(await migratePiAzureProviderAsync(root, application.fixtureConnection, ui), { files: 0, selections: 0 });
  console.log("PASS Pi startup reads workspace paths and repairs provider selections across Core clients without a local connection");

  const bindingCwd = join(root, "binding-workspace");
  const directory = join(root, "binding-store");
  const projection = new DurableTaskProjection(application.fixtureConnection, background);
  const desktopProjection = new DurableTaskProjection(application.fixtureConnection, ui);
  await application.writeTaskRecord({ id: "binding-race", title: "Concurrent binding", cwd: bindingCwd, updatedAt: at });
  const offered = [join(root, "race-store-a"), join(root, "race-store-b")];
  const contenders = await Promise.allSettled([
    projection.bindBot("binding-race", offered[0], bindingCwd),
    desktopProjection.bindBot("binding-race", offered[1], bindingCwd),
  ]);
  assert.deepEqual(contenders.map(reply => reply.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await ui.readDurableTaskBinding("binding-race"))?.directory,
    offered[contenders.findIndex(reply => reply.status === "fulfilled")]);

  await application.writeTaskRecord({ id: "resume-binding", title: "Bound task", cwd: bindingCwd, updatedAt: at });
  assert.equal(await ui.readDurableTaskBinding("resume-binding"), null);
  await projection.bindBot("resume-binding", directory, bindingCwd);
  await projection.bindBot("resume-binding", directory, bindingCwd);
  await assert.rejects(desktopProjection.bindBot("resume-binding", join(root, "different-store"), bindingCwd),
    /已经绑定到另一个目录/);
  const resumePage = await ui.readDurableResumePage();
  assert(resumePage?.taskIds.includes("resume-binding"));
  assert.deepEqual(await ui.readDurableTaskBinding("resume-binding"), { cwd: bindingCwd, directory, trashed: false });
  const moves = new DurableWorkspaceMoves(application);
  const destination = join(root, "binding-moved-workspace");
  const move = { taskId: "resume-binding", fromCwd: bindingCwd, toCwd: destination };
  await moves.write({ kind: "stage", ...move });
  assert.deepEqual(await background.readDurableTaskBinding("resume-binding"), { cwd: bindingCwd, directory, trashed: false });
  await moves.write({ kind: "commit", ...move, cwd: destination, at });
  await projection.bindBot("resume-binding", directory, bindingCwd);
  assert.deepEqual(await background.readDurableTaskBinding("resume-binding"), { cwd: destination, directory, trashed: false });
  assert.deepEqual(await background.batch2Write({ kind: "upsertTaskExecutionWorkspaceState", taskId: "resume-binding",
    directoryName: "resume-binding", state: "trashed", createdAt: at, updatedAt: at, trashedAt: at }), { ok: true });
  assert.deepEqual(await ui.readDurableTaskBinding("resume-binding"), { cwd: destination, directory, trashed: true });
  await assert.rejects(projection.bindBot("resume-binding", directory, bindingCwd), /任务已删除或在回收站中/);
  const originalStoreId = await resolveStoreId(ui, directory);
  const otherStoreId = await resolveStoreId(ui, join(root, "unrelated-pi-store"));
  const staleWriter = await DuckDbStorage.openWriter(ui, originalStoreId);
  const otherWriter = await DuckDbStorage.openWriter(background, otherStoreId);
  try {
    assert.equal(await staleWriter.mintId(), 2);
    assert.equal(await otherWriter.mintId(), 2);
    assert.deepEqual(await background.batch2Write({ kind: "deleteTask", id: "resume-binding" }), { ok: true });
    assert.equal((await duckDbStoreInfo(ui, originalStoreId)).exists, false);
    await assert.rejects(staleWriter.mintId(), StorageFencedError);
    assert.equal(await otherWriter.mintId(), 3);
  } finally {
    await Promise.all([staleWriter.close(BACKGROUND_CONTEXT), otherWriter.close(BACKGROUND_CONTEXT)]);
  }
  await assert.rejects(projection.bindBot("resume-binding", directory, bindingCwd), /任务已删除或在回收站中/);
  assert.equal(await ui.readDurableTaskBinding("resume-binding"), null);
  assert.equal((await ui.readDurableResumePage())?.taskIds.includes("resume-binding"), false);
  await application.writeTaskRecord({ id: "resume-binding", title: "Recreated task", updatedAt: at });
  assert.equal(await ui.readDurableTaskBinding("resume-binding"), null);
  console.log("PASS two hosts agree on one binding; deletion retires only that Pi store and a recreated task does not inherit it");

  const library = new LibraryService(application, { libraryRoot: join(root, "library") });
  await writeSoulProfile(application, { name: "Library Owner" });
  const space = await application.writeWorkspaceUpsert({ id: "catalog-workspace", name: "Workspace" });
  const projectNotes = new ProjectNotesService(application);
  await assert.rejects(projectNotes.read("missing-project"), /项目不存在/);
  const notes = new WorkspaceNotesService(application);
  const workspaceId = space.id;
  assert.deepEqual(await notes.read(workspaceId), { workspaceId, content: "", revision: 0, updatedAt: 0 });
  const [localNote, remoteNote] = await Promise.allSettled([
    notes.save({ workspaceId, content: "Local note", expectedRevision: 0 }),
    background.saveScopedNote("workspace", workspaceId, { content: "Remote note", expectedRevision: 0, updatedAt: at }),
  ]);
  assert(remoteNote.status === "fulfilled" && remoteNote.value);
  assert.equal(Number(localNote.status === "fulfilled") + Number(remoteNote.value.status === "ok"), 1);
  if (localNote.status === "rejected") assert.match(String(localNote.reason), /便签已在其他窗口或任务中更新/);
  const sendNote = ui.saveScopedNote.bind(ui);
  ui.saveScopedNote = async (...args) => {
    assert.equal((await sendNote(...args))?.status, "ok");
    return undefined;
  };
  try {
    const recovered = await notes.save({ workspaceId, content: "Saved after losing acknowledgment", expectedRevision: 1 });
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.content, "Saved after losing acknowledgment");
    assert.deepEqual(await notes.read(workspaceId), recovered);
  } finally {
    ui.saveScopedNote = sendNote;
  }
  console.log("PASS scoped notes mount on Core, reject a concurrent stale editor and confirm a committed note after the reply is lost");
  await application.writeTaskRecord({ id: "catalog-task", title: "Catalog Task", spaceId: space.id, updatedAt: at });
  for (const [id, spaceKind, workspaceId] of [["catalog-personal", "personal", undefined], ["catalog-work", "team", space.id]] as const) {
    assert.deepEqual(await ui.batch3Write({ kind: "libraryInsertSpace", id, name: id, spaceKind, workspaceId, createdAt: at, updatedAt: at }), { ok: true });
  }
  const outputs = createArtifactDomain(undefined, undefined, ui, join(root, "artifacts")).service;
  const result = await outputs.register({ taskId: "catalog-task", id: "catalog-output", kind: "markdown", title: "Output", content: "# Actual output", spaceId: space.id });
  const catalog = await library.readSnapshot();
  assert.equal(catalog.ownerName, "Library Owner");
  assert.deepEqual(catalog.artifacts.map(row => [row.id, row.title, row.location]), [[result.id, "Output", "Workspace · Catalog Task"]]);
  assert.deepEqual((await library.readSnapshot({ owner: { type: "workspace", workspaceId: space.id } })).spaces.map(row => row.id), ["catalog-work"]);
  const crossOwner = await library.readSnapshot({ owner: { type: "personal" }, spaceId: "catalog-work" });
  assert.deepEqual([crossOwner.spaces, crossOwner.items, crossOwner.artifacts], [[], [], []]);
  console.log("PASS the production library snapshot reads profile, artifacts and owner scopes through Core");

  for (const [id, createdAt] of [["stale-candidate", at - 15 * 60_000], ["recent-candidate", at]] as const) {
    assert.deepEqual(await ui.batch3Write({ kind: "memoryInsertCandidate", id, taskId: "catalog-task", memoryKind: "fact",
      title: id, content: id, scopeType: "global", confidence: 0.8, importance: 1, explicit: false, operationHint: "create",
      status: "pending", rawJson: "{}", createdAt }), { ok: true });
  }
  const memory = new MemoryService(application, { semantic: false });
  await memory.flushWrites();
  assert.deepEqual((await memory.repository.readCandidates("needs_review")).map(row => row.id), ["stale-candidate"]);
  assert.deepEqual((await memory.repository.readCandidates("pending")).map(row => row.id), ["recent-candidate"]);
  console.log("PASS startup recovery makes stale memory candidates reviewable and leaves active candidates alone");

  const recallTask = "ordinary-core-recall";
  const recallProject = "ordinary-core-recall-project";
  const recallParent = await application.writeWorkspaceUpsert({ id: "recall-parent", name: "Recall parent" });
  const recallChild = await application.writeWorkspaceUpsert({ id: "recall-child", name: "Recall child", parentId: recallParent.id });
  const recallSibling = await application.writeWorkspaceUpsert({ id: "recall-sibling", name: "Recall sibling", parentId: recallParent.id });
  const recallProjectReply = await ui.writeProject("create-recall-scope", { kind: "create", policiesJson: JSON.stringify(emptyProjectPolicies()), resources: [],
    project: { id: recallProject, name: "Recall project", createdAt: at, updatedAt: at, resourceBudgetChars: DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS } });
  assert.equal(recallProjectReply, "changed");
  await application.writeTaskRecord({ id: recallTask, title: "Ordinary recall", projectId: recallProject, spaceId: recallChild.id, updatedAt: at });
  const lookup = "recallwitness792";
  const createRecallMemory = (tag: string, input: Pick<Parameters<MemoryService["createSettingsMemory"]>[0], "scopeType" | "scopeId" | "sourceType" | "sourceId" | "sourceTaskId" | "evidence" | "metadata">) =>
    memory.createSettingsMemory({ kind: "fact", title: `${lookup} ${tag}`, content: `${lookup} ${tag}`,
      explicit: input.sourceType !== "agent", sourceType: "user", ...input });
  const [privateTask, projectMemory, inheritedMemory, siblingMemory, gatewayMemory, automaticMemory] = await Promise.all([
    createRecallMemory("task", { scopeType: "task", scopeId: recallTask }),
    createRecallMemory("project", { scopeType: "project", scopeId: recallProject, metadata: { sourceQuote: "withheld private source metadata" },
      evidence: [{ evidenceKind: "external", refId: "recall-source", excerpt: "withheld original source excerpt" }] }),
    createRecallMemory("ancestor", { scopeType: "workspace", scopeId: recallParent.id }),
    createRecallMemory("sibling", { scopeType: "workspace", scopeId: recallSibling.id }),
    createRecallMemory("gateway-origin", { scopeType: "global", sourceTaskId: `gateway-chat-${"a".repeat(64)}` }),
    createRecallMemory("legacy-automatic", { scopeType: "global", sourceType: "agent", sourceId: "bot-conversation-legacy" }),
  ]);
  const recallRequest = { taskId: recallTask, workspaceId: recallSibling.id, projectId: "forged-project", query: lookup };
  const authority = await memory.readCoreRecallAuthority(recallRequest);
  assert.deepEqual(authority.scopes.map(({ scopeType, scopeId }) => [scopeType, scopeId]), [
    ["task", recallTask], ["project", recallProject], ["workspace", recallChild.id], ["workspace", recallParent.id], ["global", undefined],
  ]);
  const hits = await memory.searchCoreLexical(recallRequest, authority);
  assert.deepEqual(new Set(hits.map(hit => hit.memory.id)), new Set([privateTask.id, projectMemory.id, inheritedMemory.id]));
  for (const excluded of [siblingMemory, gatewayMemory, automaticMemory]) assert.equal(await memory.readCoreRecallAtom(excluded.id, recallRequest, authority), undefined);
  const atom = await memory.readCoreRecallAtom(projectMemory.id, recallRequest, authority);
  assert.equal(atom?.revision, 1);
  assert.equal(atom?.memory.content, `${lookup} project`);
  assert.deepEqual(atom?.memory.evidence, []);
  assert.deepEqual((await memory.searchLexical({ ...recallRequest, query: undefined, scopeTypes: ["project"] })).map(row => row.memory.id), [projectMemory.id]);
  const evidence = await readCoreMemoryContext(memory, { ...recallRequest, budgetChars: 2_000 });
  assert.deepEqual(new Set(evidence.sourceRevisions.map(source => `${source.id}@${source.revision}`)),
    new Set([privateTask.id, projectMemory.id, inheritedMemory.id].map(id => `${id}@1`)));
  assert.match(evidence.text, new RegExp(`\\[L1 ${projectMemory.id}@1\\]`));
  const editedContent = `${lookup} edited project`;
  const edit = await background.writeMemoryRecord(updateMemoryWrite({ ...projectMemory, content: editedContent,
    contentHash: hashContent(projectMemory.kind, projectMemory.title, editedContent), updatedAt: Date.now() }, 1, "manual", "settings edit"));
  assert.equal(edit?.status, "applied");
  const prior = await memory.readCoreContextSnapshot({ id: projectMemory.id, revision: 1 }, recallRequest);
  assert.equal(prior?.content, `${lookup} project`);
  assert.equal(prior?.revision, 1);
  type RecallToolResult = { isError?: boolean; content: Array<{ text: string }>; details: unknown };
  type RecallTool = { name: string; execute: (callId: string, params: { id: string }) => Promise<RecallToolResult> };
  const recallTools = new Map<string, RecallTool>();
  await createMemoryExtension({ taskId: recallTask, service: memory })({
    registerTool: (tool: RecallTool) => recallTools.set(tool.name, tool),
  } as never);
  const getMemoryTool = recallTools.get("memory_get")!;
  const currentReply = await getMemoryTool.execute("read-memory-current", { id: projectMemory.id });
  assert.equal(currentReply.isError, undefined);
  assert.match(currentReply.content[0].text, /revision=2/);
  assert.match(currentReply.content[0].text, new RegExp(editedContent));
  assert.equal((currentReply.details as { revision: number }).revision, 2);
  assert.doesNotMatch(JSON.stringify(currentReply), /withheld/);
  assert.equal((await getMemoryTool.execute("read-memory-sibling", { id: siblingMemory.id })).isError, true);
  const sendRecall = ui.memoryLexical.bind(ui);
  try {
    ui.memoryLexical = async request => {
      const result = await sendRecall(request);
      await application!.writeTaskRecord({ id: recallTask, title: "Ordinary recall moved", projectId: null, spaceId: recallSibling.id, updatedAt: at + 1 });
      return result;
    };
    await assert.rejects(memory.searchCoreLexical(recallRequest, authority), /可见范围已变化/);
  } finally { ui.memoryLexical = sendRecall; }
  assert.equal(await memory.readCoreContextSnapshot({ id: projectMemory.id, revision: 1 }, recallRequest), undefined);
  assert.equal((await getMemoryTool.execute("read-memory-revoked", { id: projectMemory.id })).isError, true);
  await assert.rejects(memory.searchLexical({ taskId: DOTS_TASK_ID, query: lookup }), /暂未确认/);
  console.log("PASS ordinary Core recall uses persisted scopes, keeps exact revisions, and drops results when task authority changes");

  const staleView = { id: "unverified-dots-scenario", title: "Unverified Dots view",
    summary: "An old quote without a current source", sourceMemoryIdsJson: '["absent-source"]',
    contentHash: "unverified", createdAt: at, updatedAt: at };
  assert.deepEqual(await ui.batch3Write({ kind: "memoryProjectionSyncScenarios", scopeType: "task",
    scopeId: DOTS_TASK_ID, rows: [staleView], now: at }), { ok: true });
  const refreshWarnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args[0] === "[MemoryKernel] Dots projection refresh failed") refreshWarnings.push(args[1]);
    else warn(...args);
  };
  try {
    memory.cognition.queueDotsViews();
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { console.warn = warn; }
  assert.deepEqual(refreshWarnings, []);
  assert.deepEqual(memory.cognition.getContextSources({ taskId: DOTS_TASK_ID }), { scenarios: [], profiles: [] });
  assert.equal(memory.cognition.projections.getActiveDotsView(staleView.id, "scenario"), undefined);
  assert.equal(memory.cognition.projections.isRevoked(staleView.id, "scenario"), true);
  console.log("PASS Core startup skips the fixture refresh and excludes stored Dots views without verified sources");

  const turns = new MemoryTurnRepository(application);
  const extractionTask = "memory-extraction-concurrent";
  await application.writeTaskRecord({ id: extractionTask, title: "Concurrent extraction", updatedAt: at });
  const turn = prepareMemoryTurn({ taskId: extractionTask, userText: "Keep the original evidence", assistantText: "Recorded",
    assistantMessageId: "memory-extraction-message", capturedAt: at });
  assert.equal(await ui.captureMemory({ kind: "turn", turn }), 1);
  assert.equal(await turns.hasPending(extractionTask), true);
  const first = { kind: "claim", taskId: extractionTask, owner: "desktop", token: "desktop-claim", capturedThrough: at, limit: 1 } as const;
  const second = { ...first, owner: "background", token: "background-claim" } as const;
  const firstClaim = ui.writeMemoryTurnExtraction(first, LOCAL_USER_ID);
  const secondClaim = background.writeMemoryTurnExtraction(second, LOCAL_USER_ID);
  const [left, right] = await Promise.all([firstClaim, secondClaim]);
  assert.deepEqual([left?.status, right?.status].sort(), ["busy", "claimed"]);
  const winner = left?.status === "claimed" ? first : second;
  const stale = winner === first ? second : first;
  const granted = left?.status === "claimed" ? left : right;
  assert(granted?.status === "claimed");
  assert.deepEqual(granted.turns.map(item => [item.id, item.attemptCount]), [[turn.id, 1]]);
  assert.deepEqual(await ui.writeMemoryTurnExtraction(winner, LOCAL_USER_ID), granted);
  assert.equal(await turns.settleExtraction(stale, "completed"), "stale");
  assert.equal(await turns.extractionCurrent(winner), true);
  assert((await turns.renewExtraction(winner) ?? 0) >= granted.leaseExpiresAt);
  assert.equal(await turns.settleExtraction(winner, "release"), "released");
  assert.equal(await turns.hasPending(extractionTask), true);
  const replacement = { ...stale, token: "replacement-claim" };
  const reclaimed = await turns.claimExtraction(replacement, { limit: 1, capturedThrough: at });
  assert(reclaimed.status === "claimed");
  assert.deepEqual(reclaimed.turns.map(item => [item.id, item.attemptCount]), [[turn.id, 1]]);
  assert.equal(await turns.settleExtraction(winner, "completed"), "stale");
  await ui.batch3Write({ kind: "memoryTurnDelete", deleteAll: false, ids: [turn.id], now: Date.now() });
  assert.equal(await turns.extractionCurrent(replacement), false);
  assert.equal(await turns.settleExtraction(replacement, "completed"), "stale");
  assert.equal(await turns.readDetail(turn.id), undefined);
  assert.equal(await turns.hasPending(extractionTask), false);
  console.log("PASS concurrent Core memory extraction grants one owner, replays its request and fences deleted evidence");

  const removedProject = "project-lost-deletion-receipt";
  assert.equal(await ui.writeProject("prepare-project-deletion", { kind: "create", policiesJson: JSON.stringify(emptyProjectPolicies()), resources: [],
    project: { id: removedProject, name: "Project to delete", createdAt: at, updatedAt: at, resourceBudgetChars: DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS } }), "changed");
  const boundTask = "retained-after-project-deletion";
  await application.writeTaskRecord({ id: boundTask, title: "Retained task", projectId: removedProject, updatedAt: at });
  const deletedSpace = "project-library-to-delete";
  assert.deepEqual(await ui.batch3Write({ kind: "libraryInsertSpace", id: deletedSpace, name: "Project library", spaceKind: "team",
    projectId: removedProject, createdAt: at, updatedAt: at }), { ok: true });
  const deletedFolder = join(library.root, deletedSpace);
  mkdirSync(deletedFolder, { recursive: true });
  writeFileSync(join(deletedFolder, "fixture.txt"), "Project-owned file");
  const deletedPlan = "project-schedule-to-delete";
  assert.equal(await ui.writeCronPlan({ kind: "save", expected: null, row: encodeCronPlan({ id: deletedPlan, name: "Project schedule",
    prompt: "Fixture", projectId: removedProject, scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", enabled: false,
    createdAt: at, updatedAt: at }) }), true);
  const projects = new ProjectService(new ProjectRepository(undefined, ui), memory);
  const publishRemoved: string[] = [];
  const cancelledCadences: string[] = [];
  const requestDeletion = ui.deleteProject.bind(ui);
  const deletionCalls: Parameters<typeof requestDeletion>[] = [];
  ui.deleteProject = async (...args) => {
    deletionCalls.push(args);
    const receipt = await requestDeletion(...args);
    assert.deepEqual(receipt, { status: "deleted" as const, itemIds: [], jobIds: [deletedPlan] });
    if (deletionCalls.length === 1) throw new RuntimeAuditUnknownOperationError(args[0], "deleteProject");
    return receipt;
  };
  try {
    await deleteProjectWithLifecycle(removedProject, { db: application, projects, library,
      cron: { withPlanMaintenance: async run => run(), removeProjectData: () => assert.fail("SQLite project deletion fallback"),
        publishRemovedProjectJobs: ids => publishRemoved.push(...ids) },
      cancelCadence: id => cancelledCadences.push(id) });
  } finally {
    ui.deleteProject = requestDeletion;
  }
  assert.equal(deletionCalls.length, 2);
  assert.deepEqual(deletionCalls[0], deletionCalls[1]);
  assert.equal(await projects.readDetails(removedProject), undefined);
  assert.equal((await application.readTask(boundTask))?.title, "Retained task");
  assert.equal((await application.readTask(boundTask))?.projectId, undefined);
  assert.equal((await application.readCronJobs()).some(job => job.id === deletedPlan), false);
  assert.equal(existsSync(deletedFolder), false);
  assert.deepEqual([cancelledCadences, publishRemoved], [[removedProject], [deletedPlan]]);
  console.log("PASS project deletion recovers the same Core receipt, cleans project files and publishes plan removal once after a lost reply");

  const project = join(root, "示例 项目");
  const subproject = join(project, "nested");
  const source = join(subproject, "src");
  mkdirSync(source, { recursive: true });
  const python = join(project, "parent-python");
  const nestedPython = join(subproject, "nested-python");
  writeFileSync(python, "fixture interpreter path");
  writeFileSync(nestedPython, "fixture interpreter path");
  const parent = { projectDir: project, pythonPath: python, dirKey: pythonProjectDirKey(project),
    pythonVersion: "3.11.9", manifestPath: null, boundAt: at };
  const nested = { projectDir: subproject, pythonPath: nestedPython, dirKey: pythonProjectDirKey(subproject),
    pythonVersion: "3.12.1", manifestPath: null, boundAt: at + 1 };
  assert.equal(await bindings.resolveForDir(source), null);
  await Promise.all([bindings.save(parent), backgroundBindings.save(nested)]);
  assert.equal((await bindings.resolveForDir(source))?.pythonPath, nestedPython);
  assert.equal((await backgroundBindings.resolveForDir(project))?.pythonPath, python);
  assert.deepEqual((await bindings.list()).map(row => row.pythonVersion), ["3.12.1", "3.11.9"]);

  const runtime = new PythonRuntimeService({
    runtimeDir: root, environmentsDir: join(root, "environments"), manifestsDir: join(root, "manifests"),
    stagingDir: join(root, "staging"), interpretersDir: join(root, "interpreters"),
    cacheDir: join(root, "cache"), toolchainDir: join(root, "toolchain"),
  });
  runtime.setProjectBindingStore(backgroundBindings);
  assert.equal((await runtime.inspectProject(source)).source, "override");
  const resolution = await runtime.resolveForExecution(undefined, { taskRoot: source, useProjectBinding: true });
  assert(resolution.ok && resolution.pythonPath === nestedPython);
  rmSync(nestedPython);
  assert.equal((await runtime.inspectProject(source)).available, false);
  const unavailable = await runtime.resolveForExecution(undefined, { taskRoot: source, useProjectBinding: true });
  assert(!unavailable.ok && unavailable.failureStage === "verify-failed");
  assert.equal((await runtime.unbindProject(subproject)).ok, true);
  assert.equal(await bindings.remove(subproject), false);
  assert.equal((await runtime.inspectProject(source)).pythonPath, python);

  const { AgentService } = await import("../src/main/agent/AgentService");
  const agent = await AgentService.open(application, undefined, { executionMode: "isolated-client" });
  try {
    await agent.init();
    await application.writeTaskRecord({ id: "goal-assembly-user", title: "User goal", updatedAt: at });
    await application.writeTaskRecord({ id: "goal-assembly-tool", title: "Tool goal", updatedAt: at });
    const created = await agent.createSavedConversationGoal({ taskId: "goal-assembly-user", title: "Keep a user goal" });
    assert(created.ok);
    const published = await agent.readConversationRuntimeSnapshot("goal-assembly-user");
    assert.equal(published?.activeGoal?.id, created.goal.id);
    assert.match(await agent.conversationGoalPrompt("goal-assembly-user"), /Keep a user goal/);
    const toolReply = await background.createConversationGoal("goal-created-by-tool", {
      userId: LOCAL_USER_ID, defaultBotId: DEFAULT_BOT_ID, taskId: "goal-assembly-tool", title: "Keep a tool goal",
      criteria: ["Check the result"], createdBy: "bot", originMessageId: "request-from-the-user",
    });
    assert(toolReply?.ok);
    const observed = await agent.readLiveConversationGoalForTool("goal-assembly-tool", toolReply.goal.work_id);
    assert.equal(observed?.goal.createdBy, "agent_explicit_request");
    assert.equal(observed?.goal.sourceMessageId, "request-from-the-user");
    assert.deepEqual(observed?.versionGuard, { expectedStateVersion: 1, expectedIntentRevision: 1, expectedOwnerEpoch: 1 });
    assert.equal(await agent.readLiveConversationGoalForTool("goal-assembly-user", toolReply.goal.work_id), undefined);
    console.log("PASS AgentService assembles with Core and reads a model-created Goal with its source and version guard");
    const historyPath = join(root, "usage-archive-session.jsonl");
    const trashHistoryPath = join(root, "usage-trash-session.jsonl");
    await application.writeTaskRecord({ id: "usage-archived", title: "Archived usage", sessionFile: historyPath, archived: true, updatedAt: at });
    await application.writeTaskRecord({ id: "usage-trashed", title: "Trashed usage", sessionFile: trashHistoryPath, updatedAt: at });
    assert.deepEqual(await ui.batch2Write({ kind: "upsertTaskExecutionWorkspaceState", taskId: "usage-trashed",
      directoryName: "usage-trashed", state: "trashed", createdAt: at, updatedAt: at, trashedAt: at }), { ok: true });
    const paths = (await agent.usageStats.listSessionFiles()).map(file => file.sessionFile);
    assert(paths.includes(historyPath) && paths.includes(trashHistoryPath));
    console.log("PASS startup usage backfill discovers stored session paths through Core");
    await verifyExternalAgentHistory(application, agent, root);
  } finally {
    agent.dispose();
  }

  await application.flushPersistenceWrites();
  const recoveryTask = "dots-recovery-worker";
  const recoveryOperation = "dots-input-auto-core-recovery";
  const recoverySource = "dots-recovery-original-conversation";
  const originalDirectory = join(root, "dots-recovery-original");
  const originalTask = { ...task(recoveryTask, "Original assignment"), cwd: originalDirectory };
  assert.equal((await ui.upsertTaskRecord(originalTask))?.status, "saved");
  const originalRequest = { taskId: recoveryTask, userMessageId: recoveryOperation, assistantMessageId: "original-answer", text: "Original worker input" };
  const delegation = { kind: "dotsDelegationLink", taskId: recoveryTask, operationId: recoveryOperation, sourceMessageId: recoverySource,
    now: at, supersedes: false, requestJson: JSON.stringify(originalRequest), goalId: null };
  const linked = await Promise.all([ui.batch4aWrite<{ inserted: boolean }>(delegation), background.batch4aWrite<{ inserted: boolean }>(delegation)]);
  assert.deepEqual(linked.map(result => result?.inserted).sort(), [false, true]);
  assert.deepEqual(await background.batch4aWrite({ ...delegation, requestJson: JSON.stringify({ ...originalRequest, text: "Changed by retry" }) }), { inserted: false });
  await assert.rejects(background.batch4aWrite({ ...delegation, sourceMessageId: "another-dots-conversation" }));
  const listed = await ui.readDotsDelegations([recoverySource]);
  assert.deepEqual(listed.map(row => [row.id, row.taskId, row.sourceMessageId, row.status]), [[recoveryOperation, recoveryTask, recoverySource, "pending"]]);
  assert.deepEqual(await ui.readDotsDelegations([recoverySource], ["another-workspace"]), []);
  const candidate = (await ui.readDotsRecoveryPage(0))?.rows.find(row => row.operationId === recoveryOperation);
  assert(candidate && candidate.sequence > 0);
  const guard = { sequence: candidate.sequence, spaceIds: null, allowAutomatic: true };
  assert.equal(await ui.dotsRecoveryCurrent(recoveryTask, recoveryOperation, { ...guard, allowAutomatic: false }), false);
  const dataDirectory = root;
  const recoveryClient = await CoreBusinessClient.connect(executable, database, { dataDirectory, role: "ui", clientId: "dots-recovery-test-one" });
  const recoveryPeer = await CoreBusinessClient.connect(executable, database, { dataDirectory, role: "ui", clientId: "dots-recovery-test-two" });
  const recoveryExecutor = await CoreBusinessClient.connect(executable, database, { dataDirectory, role: "execution-host", clientId: "dots-recovery-test-executor" });
  const submittedRecovery = { executionId: `pi:${recoveryTask}:${recoveryOperation}`, idempotencyKey: recoveryOperation,
    taskId: recoveryTask, kind: "pi_turn", dotsRecovery: guard };
  try {
    assert.equal((await recoveryClient.submitExecution({ ...submittedRecovery, dotsRecovery: { ...guard, allowAutomatic: false } })).code,
      "DOTS_RECOVERY_NOT_CURRENT");
    const initial = await Promise.all([recoveryExecutor.submitExecution(submittedRecovery), recoveryPeer.submitExecution(submittedRecovery)]);
    assert.deepEqual(initial.map(reply => reply.deduplicated).sort(), [false, true]);
    assert.deepEqual(initial[0].execution, initial[1].execution);
    assert.equal((initial[0].execution?.payload as { text: string }).text, originalRequest.text);
    assert.equal((await recoveryExecutor.executorAck(submittedRecovery.executionId, 1)).status, "ok");
    assert.equal((await recoveryExecutor.executorSettled({ executionId: submittedRecovery.executionId, attempt: 1,
      status: "paused", result: { dotsRecoveryDeferred: true } })).status, "ok");
    assert.equal((await ui.upsertTaskRecord({ ...originalTask, cwd: join(root, "dots-recovery-moved") }))?.status, "saved");
    assert.equal(await background.dotsRecoveryCurrent(recoveryTask, recoveryOperation, guard), false);
    assert.equal((await recoveryPeer.submitExecution(submittedRecovery)).code, "DOTS_RECOVERY_NOT_CURRENT");
    assert.equal((await recoveryClient.executionStatus(submittedRecovery.executionId)).execution?.attempt, 1);
    assert.equal((await background.upsertTaskRecord(originalTask))?.status, "saved");
    const retried = await Promise.all([recoveryClient.submitExecution(submittedRecovery), recoveryPeer.submitExecution(submittedRecovery)]);
    assert.deepEqual(retried.map(reply => reply.deduplicated).sort(), [false, true]);
    assert.equal(retried[0].execution?.attempt, 2);
    assert.equal((await recoveryExecutor.executorAck(submittedRecovery.executionId, 2)).status, "ok");
    assert.equal((await recoveryExecutor.executorSettled({ executionId: submittedRecovery.executionId, attempt: 2, status: "completed",
      result: { receipt: "ordinary-worker-accepted" } })).status, "ok");
    assert.equal((await recoveryPeer.submitExecution(submittedRecovery)).deduplicated, true);
    assert.equal((await recoveryClient.executionStatus(submittedRecovery.executionId)).execution?.attempt, 2);
    assert.equal((await ui.readDotsRecoveryPage(0))?.rows.some(row => row.operationId === recoveryOperation), false);

    const manualOperation = "dots-manual-pause-check";
    assert.deepEqual(await ui.batch4aWrite({ ...delegation, operationId: manualOperation,
      requestJson: JSON.stringify({ ...originalRequest, userMessageId: manualOperation, assistantMessageId: "manual-answer" }) }), { inserted: true });
    const manual = (await ui.readDotsRecoveryPage(0))?.rows.find(row => row.operationId === manualOperation);
    assert(manual);
    const manualExecution = `pi:${recoveryTask}:${manualOperation}`;
    const pausedInput = { executionId: manualExecution, idempotencyKey: manualOperation, taskId: recoveryTask, kind: "pi_turn",
      dotsRecovery: { ...guard, sequence: manual.sequence } };
    assert.equal((await recoveryPeer.submitExecution(pausedInput)).status, "ok");
    assert.equal((await recoveryExecutor.executorAck(manualExecution, 1)).status, "ok");
    assert.equal((await recoveryClient.pauseExecution(manualExecution)).execution?.status, "pause_requested");
    assert.equal((await recoveryExecutor.executorSettled({ executionId: manualExecution, attempt: 1, status: "paused",
      result: { dotsRecoveryDeferred: true } })).status, "ok");
    assert.equal((await recoveryPeer.submitExecution(pausedInput)).deduplicated, true);
    assert.equal((await recoveryClient.executionStatus(manualExecution)).execution?.status, "paused");
    assert.equal((await ui.readDotsRecoveryPage(0))?.rows.some(row => row.operationId === manualOperation), false);

    const ordinary = await recoveryPeer.submitExecution({ executionId: "pi:ordinary-dots-guard-check", idempotencyKey: "ordinary-dots-guard-check",
      taskId: recoveryTask, kind: "pi_turn", payload: { text: "Ordinary input", dotsRecovery: guard } });
    assert.equal(ordinary.status, "ok");
    assert.deepEqual(ordinary.execution?.payload, { text: "Ordinary input" });
    assert.equal((await recoveryExecutor.executorAck("pi:ordinary-dots-guard-check", 1)).status, "ok");
    assert.equal((await recoveryExecutor.executorSettled({ executionId: "pi:ordinary-dots-guard-check", attempt: 1, status: "completed" })).status, "ok");
  } finally {
    await Promise.all([recoveryExecutor.close(), recoveryClient.close(), recoveryPeer.close()]);
  }
  console.log("PASS Dots persists one original delegation and fences concurrent recovery, workspace moves, and already accepted requests");

  const raceTask = { ...task("dots-reconcile-race", "Concurrent Dots reconciliation"), cwd: join(root, "dots-reconcile-original") };
  const raceSource = "dots-reconcile-original-source";
  const raceOperation = "dots-reconcile-original-operation";
  assert.equal((await ui.upsertTaskRecord(raceTask))?.status, "saved");
  let oldReads = 0;
  const olderRead = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const oldWorker = new DotsDelegations(undefined, async () => {
    if (++oldReads !== 1) return;
    olderRead.resolve();
    await releaseOld.promise;
    return { status: "running", text: "Delayed state", artifacts: [] };
  }, () => {}, undefined, ui);
  const newerWorker = new DotsDelegations(undefined, async () => ({
    status: "running", text: "Current worker state", artifacts: [],
  }), () => {}, undefined, background);
  try {
    const request = { taskId: raceTask.id, userMessageId: raceOperation, assistantMessageId: "dots-reconcile-assistant", text: "Original request" };
    await Promise.all([oldWorker.link(raceTask.id, raceOperation, raceSource, false, request),
      newerWorker.link(raceTask.id, raceOperation, raceSource, false, request)]);
    oldWorker.refresh(raceTask.id);
    await Promise.race([olderRead.promise, delay(10_000, undefined, { ref: false }).then(() => assert.fail("Old observer never read the delegation"))]);
    newerWorker.refresh(raceTask.id);
    await newerWorker.drain();
    assert.equal((await background.readDotsDelegations([raceSource]))[0]?.text, "Current worker state");
    releaseOld.resolve();
    await oldWorker.drain();
    const saved = await ui.readDotsDelegations([raceSource]);
    assert.deepEqual(saved.map(row => [row.id, row.status, row.text]), [[raceOperation, "running", "Current worker state"]]);
    assert.equal(oldReads, 2, "A version conflict should re-read the result");

    const tool = { sourceKind: "main" as const, taskId: raceTask.id, dotsOperationId: raceOperation, name: "read",
      callId: "observe-read", conversationId: "reconcile-observation", toolTaskId: 1, phase: "start" as const, at };
    oldWorker.observeTool(tool);
    oldWorker.observeProgress(raceTask.id, raceOperation, "checkpoint", at + 1);
    await oldWorker.flushWrites();
    newerWorker.observeTool({ ...tool, at: at + 5 });
    newerWorker.observeProgress(raceTask.id, raceOperation, "checkpoint", at + 6);
    await newerWorker.flushWrites();
    assert.deepEqual((await background.readDotsDelegations([raceSource]))[0]?.activity,
      { lastActivityAt: at, tool: "read", phase: "start", lastProgressAt: at + 1 });
  } finally {
    releaseOld.resolve();
    oldWorker.close();
    newerWorker.close();
    await Promise.all([oldWorker.drain(), newerWorker.drain()]);
  }

  const movedRead = Promise.withResolvers<void>();
  const releaseMoved = Promise.withResolvers<void>();
  const movedWorker = new DotsDelegations(undefined, async () => {
    movedRead.resolve();
    await releaseMoved.promise;
    return { status: "completed", text: "Result from the former workspace", artifacts: [] };
  }, () => {}, undefined, ui);
  try {
    movedWorker.refresh(raceTask.id);
    await Promise.race([movedRead.promise, delay(10_000, undefined, { ref: false }).then(() => assert.fail("Worker never inspected the original workspace"))]);
    assert.equal((await background.upsertTaskRecord({ ...raceTask, cwd: join(root, "dots-reconcile-moved") }))?.status, "saved");
    releaseMoved.resolve();
    await movedWorker.drain();
    assert.deepEqual((await ui.readDotsDelegations([raceSource])).map(row => [row.status, row.text, row.proactiveReply]),
      [["running", "Current worker state", true]]);
  } finally {
    releaseMoved.resolve();
    movedWorker.close();
    await movedWorker.drain();
  }
  console.log("PASS interleaved Dots observers can neither overwrite newer state nor publish an outcome after the original workspace changed");

  const foreground = new DotsForegroundReads(undefined, ui);
  const foregroundPeer = new DotsForegroundReads(undefined, background);
  const foregroundRules = await ui.answerRoutingData({ kind: "list" });
  assert(foregroundRules?.status === "rules");
  const defaultForegroundRule = foregroundRules.rows.find(row => row.id === defaultAnswerRuleId);
  assert(defaultForegroundRule);
  const foregroundPolicy = { ...defaultDotsSchedulingPolicy(), foregroundReadLimits: { characters: 5, sources: 2, calls: 3 } };
  const foregroundRule = { ...newAnswerRule(), title: "Foreground budget fixture", policy: foregroundPolicy };
  const savedForegroundRule = await ui.answerRoutingData({ kind: "save", draft: {
    id: defaultForegroundRule.id, expectedRevision: defaultForegroundRule.revision, projectId: null, title: foregroundRule.title,
    enabled: true, config: JSON.stringify(foregroundRule),
    at, maxVersions: maxAnswerRuleVersions, source: "save",
  } });
  assert(savedForegroundRule?.status === "saved");
  const foregroundRuleRef = { id: defaultForegroundRule.id, revision: savedForegroundRule.revision };
  const recordForegroundPolicy = async (inputId: string, status: "applied" | "revoked" = "applied") => {
    assert.deepEqual(await ui.answerRoutingData({ kind: "recordTurn", taskId: DOTS_TASK_ID, inputId,
      ruleId: foregroundRuleRef.id, revision: foregroundRuleRef.revision, title: foregroundRule.title, at,
      detail: "Foreground fixture policy", phrase: "fixture", evidence: null, scope: "shared", status,
      snapshot: JSON.stringify(foregroundRule),
    }), { status: "saved", revision: foregroundRuleRef.revision });
  };
  const foregroundInput = "dots-foreground-concurrent-turn";
  await recordForegroundPolicy(foregroundInput);
  const frozenForeground = await foreground.freezeForInput(foregroundInput);
  assert.deepEqual(frozenForeground?.policy.foregroundReadLimits, { characters: 5, sources: 2, calls: 3 });
  const concurrentSources = [
    { callId: "file-read", source: "file:" + join(root, "foreground-budget.txt"), text: "A😀B" },
    { callId: "material-read", source: "material:foreground-budget", text: "C😀D" },
  ];
  const concurrentCharges = await Promise.all(concurrentSources.map((read, index) =>
    (index === 0 ? foreground : foregroundPeer).chargeRead(foregroundInput, read.callId, read.source, "fixture evidence", read.text)));
  assert.deepEqual(concurrentCharges.map(result => result.text.length).sort((a, b) => a - b), [1, 4]);
  for (const [index, read] of concurrentSources.entries()) {
    const admitted = concurrentCharges[index].text;
    assert.equal(admitted, read.text.slice(0, admitted.length));
    const duplicate = await foregroundPeer.chargeRead(foregroundInput, read.callId, read.source, "fixture evidence", read.text);
    assert.equal(duplicate.text, admitted, "Replay returns the same charged prefix even after exhaustion");
  }
  await assert.rejects(foregroundPeer.chargeRead(foregroundInput, "file-read", "material:substitute", "fixture evidence", "replacement"));
  const chargedState = await foreground.readState(foregroundInput);
  assert.deepEqual([chargedState.calls, chargedState.characters, chargedState.exhausted], [2, 5, true]);

  const automaticInput = "dots-foreground-prefetch";
  assert.deepEqual(await foregroundPeer.chargeRead(automaticInput, "automatic-pre-read", "material:configured-rule", "fixture evidence", "ABCDEF",
    { rule: foregroundRuleRef }), { text: "ABCDE", exhausted: true });
  assert.deepEqual((await foreground.readState(automaticInput)).policy.foregroundReadLimits, { characters: 5, sources: 2, calls: 3 });

  const splitInput = "dots-foreground-surrogate";
  await recordForegroundPolicy(splitInput);
  const splitSource = "file:" + join(root, "foreground-surrogate.txt");
  assert.equal((await foreground.chargeRead(splitInput, "fill", splitSource, "fixture evidence", "ABCD")).text, "ABCD");
  assert.deepEqual(await foregroundPeer.chargeRead(splitInput, "split", splitSource, "fixture evidence", "😀!"),
    { text: "", exhausted: true });
  assert.equal((await foreground.readState(splitInput)).characters, 4);

  const revisedInput = "dots-foreground-revoked-revision";
  const activeRootInput = "dots-foreground-root-with-revision";
  await Promise.all([recordForegroundPolicy(revisedInput), recordForegroundPolicy(activeRootInput)]);
  assert.equal((await foregroundPeer.chargeRead(activeRootInput, "authorized", "material:revision", "fixture evidence", "OK",
    { relatedInputIds: [revisedInput] })).text, "OK");
  await recordForegroundPolicy(revisedInput, "revoked");
  await assert.rejects(foregroundPeer.readState(revisedInput));
  await assert.rejects(foregroundPeer.chargeRead(activeRootInput, "revoked", "material:old-revision", "fixture evidence", "secret",
    { relatedInputIds: [revisedInput] }));
  const stateAfterRevocation = await foreground.readState(activeRootInput);
  assert.deepEqual([stateAfterRevocation.calls, stateAfterRevocation.characters], [1, 2]);
  console.log("PASS Dots foreground readers share one Core budget, replay each call once, and respect revoked revisions");

  const dotsDirectory = join(root, "dots-outbox-store");
  mkdirSync(dotsDirectory);
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindBot", taskId: DOTS_TASK_ID,
    directory: dotsDirectory, cwd: dotsDirectory }))?.status, "applied");
  const dotsStore = await resolveStoreId(ui, dotsDirectory);
  const replyWorker = { ...task("dots-reply-worker", "Retained worker result"), cwd: join(root, "original-reply-workspace") };
  assert.equal((await ui.upsertTaskRecord(replyWorker))?.status, "saved");
  const replyModels = await ModelRuntime.create({ authPath: join(root, "outbox-auth.json"), modelsPath: null,
    modelsStorePath: join(root, "outbox-models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let loseReplyAck = true;
  let lostReplyAcks = 0;
  const droppingClient: Pick<RuntimeAuditReader, "piStorage"> = {
    async piStorage<T>(request: Record<string, unknown> & { action: string }, signal?: AbortSignal): Promise<T | undefined> {
      const result = await ui.piStorage<T>(request, signal);
      if (loseReplyAck && request.action === "commit" && JSON.stringify(request.batches).includes("dotsOutboxEventKey")) {
        const committed = result as { ok?: boolean; data?: { stored?: number } } | undefined;
        assert(committed?.ok && committed.data?.stored === 1, "Both dropped acknowledgements must follow the same committed delivery");
        lostReplyAcks += 1;
        throw new RuntimeAuditUnknownOperationError("dots-publish-test", "piStorage.commit");
      }
      return result;
    },
  };
  let writer = await DuckDbStorage.openWriter(droppingClient, dotsStore);
  const originId = await writer.mintId<ConversationId>();
  const otherConversationId = await writer.mintId<ConversationId>();
  const originEntry = await writer.mintId<EntryId>();
  const otherEntry = await writer.mintId<EntryId>();
  const submission = await writer.mintId<SubmissionId>();
  const otherSubmission = await writer.mintId<SubmissionId>();
  const originalSource = "dots-original-reply-source";
  const userEntry = (id: EntryId, conversationId: ConversationId) => ({ type: "entry" as const,
    value: { id, conversationId, kind: "mybuddy.user", data: { mybuddyInput: { inputRequestId: originalSource } } } });
  const inputReceipt = (id: SubmissionId, conversationId: ConversationId, entry: EntryId) => ({ type: "submission" as const,
    value: { id, conversationId, requestId: originalSource, type: "input" as const, status: "unanswered" as const, reason: "interrupted", entry } });
  const seeded = await writer.commit([[{ type: "conversation", value: { id: originId } },
    { type: "conversation", value: { id: otherConversationId } }, userEntry(originEntry, originId), userEntry(otherEntry, otherConversationId),
    inputReceipt(submission, originId, originEntry), inputReceipt(otherSubmission, otherConversationId, otherEntry)]], () => undefined, BACKGROUND_CONTEXT);
  assert.equal(seeded.stored, 1, seeded.refused instanceof Error ? seeded.refused.message : undefined);
  await ui.batch4aWrite({ kind: "dotsReplyRememberOrigin", source: originalSource, conversationId: originId, entryId: originEntry });
  await recordForegroundPolicy(originalSource);
  const handoffDraft = { spaceId: space.id, text: "First proposed handoff",
    inputs: [{ id: originalSource, text: "Original instruction", entryId: originEntry }],
    origin: { conversationId: originId, entryId: originEntry } };
  const otherDraft = { ...handoffDraft, text: "Competing proposed handoff" };
  const [firstHandoff, competingHandoff] = await Promise.all([
    foreground.prepareHandoff(originalSource, handoffDraft), foregroundPeer.prepareHandoff(originalSource, otherDraft),
  ]);
  assert.deepEqual(firstHandoff, competingHandoff);
  assert([handoffDraft.text, otherDraft.text].includes(firstHandoff.text));
  await assert.rejects(foregroundPeer.prepareHandoff(originalSource, { ...handoffDraft,
    origin: { conversationId: otherConversationId, entryId: otherEntry },
  }));
  assert.deepEqual((await foregroundPeer.readUnlinked()).filter(row => row.inputs[0]?.id === originalSource), [firstHandoff]);
  await foreground.markLinked(originalSource);
  await foregroundPeer.markLinked(originalSource);
  assert.deepEqual(await foregroundPeer.prepareHandoff(originalSource, otherDraft), firstHandoff);
  assert.deepEqual((await foregroundPeer.readUnlinked()).filter(row => row.inputs[0]?.id === originalSource), []);
  console.log("PASS Dots foreground handoff returns one committed candidate and remains linked after replay");
  const artifactPath = join(root, "outbox-result.txt");
  writeFileSync(artifactPath, "Retained artifact");
  const artifact = { id: "retained-file", name: "outbox-result.txt", saved: { snapshotPath: artifactPath, name: "outbox-result.txt" } };
  const observeReply = async (operationId: string, body: string) => {
    const requestJson = JSON.stringify({ taskId: replyWorker.id, userMessageId: operationId, text: "Collect the retained result" });
    assert.deepEqual(await ui.batch4aWrite({ ...delegation, taskId: replyWorker.id, operationId, sourceMessageId: originalSource, requestJson }), { inserted: true });
    const timestamp = Date.now();
    const previous = (await ui.readDotsDelegations([originalSource])).find(item => item.id === operationId);
    const sequence = (await ui.readDotsRecoveryPage(0))?.rows.find(item => item.operationId === operationId)?.sequence;
    assert(previous && sequence !== undefined);
    // The native worker supplies the original completed result and the shared outbox event key.
    const eventKey = `outbox:${operationId}`;
    const snapshot = JSON.stringify({ ...previous, status: "completed", text: body, artifacts: [artifact], updatedAt: timestamp });
    assert.equal((await ui.batch4aWrite<{ changed: boolean }>({ kind: "dotsDelegationReconcile", seq: sequence,
      taskId: replyWorker.id, operationId, status: "completed", text: body, interactionId: null, files: JSON.stringify([artifact]),
      expectedUpdatedAt: previous.updatedAt, updatedAt: timestamp, dependencyWait: null, verifiedCommit: null, clearObsNextAt: true,
      observation: { eventKey, taskId: replyWorker.id, operationId, status: "completed", interactionId: null,
        snapshot, restoreSilentlySettled: false },
    }))?.changed, true);
    return { eventKey, snapshot, timestamp, reply: { deliveryKey: eventKey, operationId, taskId: replyWorker.id,
      sourceMessageId: originalSource, origin: { conversationId: originId, entryId: originEntry }, title: replyWorker.title,
      kind: "conclusion", text: body, artifacts: [artifact] } satisfies DotsAssistantReply };
  };
  let outboxHarness = await Harness.open(writer, { models: replyModels, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const activity = new DotsActivity(undefined, () => assert.fail("Core activity opened the SQLite fixture"), undefined, ui);
  try {
    const result = await observeReply("worker-result-delivery", "Original worker result");
    const wrong = { ...result.reply, origin: { conversationId: otherConversationId, entryId: otherEntry } };
    assert.deepEqual(await background.prepareDotsReply(result.eventKey, result.snapshot, wrong), { status: "invalid" });
    const [first, competing] = await Promise.all([ui.prepareDotsReply(result.eventKey, result.snapshot, result.reply),
      background.prepareDotsReply(result.eventKey, result.snapshot, { ...result.reply, text: "Competing candidate" })]);
    assert(first?.status === "prepared");
    assert.deepEqual(first, competing);
    const awaitingActivity = (await activity.readList(null)).find(item => item.taskId === replyWorker.id);
    assert(awaitingActivity?.state === "running" && awaitingActivity.phase === "following");
    assert.equal(awaitingActivity.presentation?.text, first.reply.text);
    const body = "最终确认库存 37 件 \uE000";
    assert.deepEqual(await ui.batch4aWrite({ kind: "dotsReportSaveText", deliveryKey: first.reply.deliveryKey,
      operationId: first.reply.operationId, body }), { ok: true, text: body });
    assert.deepEqual(await background.batch4aWrite({ kind: "dotsReportSaveText", deliveryKey: first.reply.deliveryKey,
      operationId: first.reply.operationId, body: "A late draft" }), { ok: true, text: body });
    assert.equal((await ui.readDotsReportContext(first.reply.operationId, first.reply.deliveryKey))?.saved, body);
    const published = { ...first.reply, presentation: "report" as const, text: body };
    const original = await outboxHarness.conversation(originId, BACKGROUND_CONTEXT);
    assert(original);
    await assert.rejects(appendDurableDotsReply(original, published, () => true, result.eventKey), RuntimeAuditUnknownOperationError);
    assert.equal(lostReplyAcks, 2);
    assert.deepEqual(await background.inspectDotsReply(result.eventKey), { status: "settled" });
    assert.deepEqual(await background.readLatestDotsReply(replyWorker.id, null), { deliveryKey: published.deliveryKey,
      operationId: published.operationId, artifacts: [artifact] });
    assert.equal(await background.readLatestDotsReply(replyWorker.id, ["different-space"]), undefined);
    const deliveredActivity = (await activity.readList(null)).find(item => item.taskId === replyWorker.id);
    assert(deliveredActivity?.state === "delivered");
    assert.deepEqual([deliveredActivity.deliveryKey, deliveredActivity.fileCount], [published.deliveryKey, 1]);
    assert.equal((await activity.readList([space.id])).some(item => item.taskId === replyWorker.id), false);
    const committed = await readCommittedDotsDeliveries(dotsDirectory, [published.deliveryKey]);
    assert.equal(committed.length, 1);
    assert.equal(committed[0].reply.text, body);
    assert.deepEqual(committed[0].reply.origin, published.origin);

    await outboxHarness.close(BACKGROUND_CONTEXT);
    loseReplyAck = false;
    writer = await DuckDbStorage.openWriter(droppingClient, dotsStore);
    outboxHarness = await Harness.open(writer, { models: replyModels, registry: createRegistry() }, BACKGROUND_CONTEXT);
    const reopenedOrigin = await outboxHarness.conversation(originId, BACKGROUND_CONTEXT);
    assert(reopenedOrigin);
    assert.equal((await appendDurableDotsReply(reopenedOrigin, published, () => true, result.eventKey)).status, "existing");

    const proactiveKey = "dots-core-proactive-replay";
    const notice = { key: proactiveKey, source: "RSS" as const, title: "Digest", body: "First body" };
    let appendedNotices = 0;
    let recoveredNotices = 0;
    const append = async (key: string, text: string, current: () => boolean) => {
      const outcome = await appendDurableDotsProactive(reopenedOrigin, key, text, current);
      if (outcome.status === "appended") {
        appendedNotices++;
        throw new Error("Fixture dropped the committed proactive acknowledgement");
      }
      if (outcome.status === "existing") recoveredNotices++;
      return outcome;
    };
    const proactive = new DotsProactiveDelivery(undefined, () => false, append, ui);
    const proactivePeer = new DotsProactiveDelivery(undefined, () => false, append, background);
    const pendingProactive = async () => {
      const pending = await background.readDotsProactiveData<{ deliveryKey: string; text: string }[]>({ kind: "pending" });
      assert(pending);
      return pending.filter(row => row.deliveryKey === proactiveKey).map(row => row.text);
    };
    let savedNotice: string | undefined;
    try {
      await Promise.all([proactive.post(notice), proactivePeer.post({ ...notice, body: "Competing body" })]);
      await Promise.all([proactive.flushWrites(), proactivePeer.flushWrites()]);
      const pending = await pendingProactive();
      assert.equal(pending.length, 1);
      savedNotice = pending[0];
      assert(["**Digest**\n\nFirst body", "**Digest**\n\nCompeting body"].includes(savedNotice));
      assert.deepEqual(await background.writeDotsProactiveData({ kind: "confirm", deliveryKey: proactiveKey, messageId: `durable-${originEntry}` }),
        { status: "pending" });
      assert.deepEqual(await pendingProactive(), [savedNotice]);

      proactive.start();
      await assert.rejects(proactive.refresh(), /Fixture dropped the committed proactive acknowledgement/);
      assert.deepEqual([appendedNotices, recoveredNotices], [1, 0]);
      assert.deepEqual(await pendingProactive(), [savedNotice]);
      await proactive.close();
      proactivePeer.start();
      await proactivePeer.refresh();
      assert.deepEqual([appendedNotices, recoveredNotices], [1, 1]);
      assert.deepEqual(await pendingProactive(), []);

      await proactivePeer.post({ ...notice, body: "Repeated body" });
      await proactivePeer.flushWrites();
      await proactivePeer.refresh();
      assert.deepEqual([appendedNotices, recoveredNotices], [1, 1]);
      assert.deepEqual(await pendingProactive(), []);
    } finally {
      await Promise.all([proactive.close(), proactivePeer.close()]);
    }

    const changed = await observeReply("worker-result-stale", "A result whose task later moved");
    assert.equal((await ui.prepareDotsReply(changed.eventKey, changed.snapshot, changed.reply))?.status, "prepared");
    assert.equal((await background.upsertTaskRecord({ ...replyWorker, cwd: join(root, "different-reply-workspace") }))?.status, "saved");
    await assert.rejects(appendDurableDotsReply(reopenedOrigin, changed.reply, () => true, changed.eventKey), new RegExp(DOTS_OUTBOX_WRITE_REVOKED));
    assert.deepEqual(await ui.inspectDotsReply(changed.eventKey), { status: "stale" });
    assert.deepEqual(await readCommittedDotsDeliveries(dotsDirectory, [changed.eventKey]), []);
    const passive = await DuckDbStorage.openReadOnly(ui, dotsStore);
    try {
      const origPage = await passive.scanEntries({ conversationId: originId }, 20, undefined, BACKGROUND_CONTEXT);
      const otherPage = await passive.scanEntries({ conversationId: otherConversationId }, 20, undefined, BACKGROUND_CONTEXT);
      assert.equal(origPage.items.filter(entry => entry.kind === DOTS_REPLY_ENTRY).length, 1);
      assert.equal(otherPage.items.filter(entry => entry.kind === DOTS_REPLY_ENTRY).length, 0);
      assert.deepEqual(origPage.items.map(readDotsProactive).filter(item => item?.key === proactiveKey).map(item => item?.text), [savedNotice]);
      assert.equal(otherPage.items.map(readDotsProactive).filter(item => item?.key === proactiveKey).length, 0);
    } finally { await passive.close(BACKGROUND_CONTEXT); }
  } finally {
    await outboxHarness.close(BACKGROUND_CONTEXT);
    await writer.close(BACKGROUND_CONTEXT);
  }
  console.log("PASS Dots commits the prepared reply, original conversation receipt and outbox together even when both acknowledgement attempts are lost");
  console.log("PASS Dots activity exposes a clickable delivery only after the original Pi conversation entry exists and respects workspace scope");
  console.log("PASS Dots rejects a changed workspace at Pi commit and preserves the previously delivered original-conversation artifact");
  console.log("PASS Dots proactive posts retain one body and recover a dropped Pi acknowledgement without another append");

  const legacyArtifactTask = "artifact-legacy-core-snapshot";
  await application.writeTaskRecord({ id: legacyArtifactTask, title: "Existing artifact history", updatedAt: at });
  let historyLoads = 0;
  const legacySource = { loadLegacyArtifacts: async () => {
    historyLoads += 1;
    return { artifacts: [{ kind: "markdown", name: "Recovered report", content: "Published before hydration" }] };
  } };
  await Promise.all(Array.from({ length: 3 }, () => ensureTaskLegacyMigrated(outputs, legacySource, legacyArtifactTask)));
  await ensureTaskLegacyMigrated(outputs, legacySource, legacyArtifactTask);
  assert.equal(historyLoads, 1);
  const [hydratedArtifact] = (await outputs.readTaskSnapshots([legacyArtifactTask]))[0].artifacts;
  assert.equal(hydratedArtifact?.title, "Recovered report");
  console.log("PASS concurrent legacy artifact hydration reads the Core migration flag and publishes once");

  await verifyTaskExpertPackages(application, root);
  await verifyTaskWorkspaceAuthority(application, background, root);
  await verifyConversationBranchLineage(application, background, root);
  await verifyTaskWriteGrants(application, background, root);
  await verifyDurableToolPersistence(application, background);

  const workerSpace = await application.writeWorkspaceUpsert({ id: "dots-worker-authority-space", name: "Worker authority", path: root });
  const authorityTask = { ...task("dots-worker-authority-task", "Worker authority"), spaceId: workerSpace.id, cwd: root };
  assert.equal((await ui.upsertTaskRecord(authorityTask))?.status, "saved");
  const workerDraft = { kind: "dotsDelegationLink", taskId: authorityTask.id, operationId: "dots-worker-authority-first",
    sourceMessageId: "dots-worker-authority-input", now: at, supersedes: false, goalId: null };
  assert.deepEqual(await ui.batch4aWrite(workerDraft), { inserted: true });
  const workerHost = await CoreBusinessClient.connect(executable, database, { dataDirectory: root, role: "execution-host", clientId: "dots-worker-authority-host" });
  const workerGeneration = "dots-worker-authority-generation";
  try {
    const version = assertExpectedPiVersion(process.cwd());
    const boot = await workerHost.piHost<{ accepted?: boolean }>({ action: "bootstrap", hostId: "dots-worker-authority-host", pid: process.pid,
      hostGeneration: workerGeneration, storageRoot: join(root, "dots-worker-authority-host"), dbPath: database,
      piVersion: version.actual, expectedPiVersion: version.expected });
    assert.equal(boot?.accepted, true);
    const allowed = { spaceId: workerSpace.id, privateCwd: null };
    const active = () => ui.readDotsWorkerAuthority(authorityTask.id, workerDraft.operationId, [workerSpace.id], workerGeneration);
    assert.deepEqual(await active(), allowed);
    assert.equal(await background.readDotsWorkerAuthority(authorityTask.id, workerDraft.operationId, [], workerGeneration), null);
    assert.equal(await background.readDotsWorkerAuthority(authorityTask.id, workerDraft.operationId, null, "unregistered-host"), null);
    assert.deepEqual(await background.batch4aWrite({ kind: "dotsActionTargetControl", mode: "control", taskId: authorityTask.id,
      operationId: "hold-original-worker", state: "paused", scheduleOps: [] }), { ok: true });
    assert.equal(await active(), null);
    assert.deepEqual(await background.batch4aWrite({ kind: "dotsActionTargetControl", mode: "deleteByOp", taskId: authorityTask.id,
      operationId: "hold-original-worker", scheduleOps: [] }), { changes: 1 });
    assert.deepEqual(await active(), allowed);
    assert.equal((await background.upsertTaskRecord({ ...authorityTask, cwd: join(root, "new-worker-workspace") }))?.status, "saved");
    assert.equal(await active(), null);
    assert.equal((await background.upsertTaskRecord(authorityTask))?.status, "saved");
    const nextWorkerOperation = "dots-worker-authority-next";
    assert.deepEqual(await background.batch4aWrite({ ...workerDraft, operationId: nextWorkerOperation, supersedes: true }), { inserted: true });
    assert.equal(await active(), null);
    assert.deepEqual(await ui.readDotsWorkerAuthority(authorityTask.id, nextWorkerOperation, null, workerGeneration), allowed);
    assert.equal((await workerHost.piHost<{ fenced?: boolean }>({ action: "fenceGeneration", hostGeneration: workerGeneration,
      reason: "test_dots_worker_authority" }))?.fenced, true);
    assert.equal(await ui.readDotsWorkerAuthority(authorityTask.id, nextWorkerOperation, null, workerGeneration), null);
  } finally {
    await workerHost.piHost({ action: "fenceGeneration", hostGeneration: workerGeneration, reason: "test_cleanup" }).catch(() => undefined);
    await workerHost.close();
  }
  console.log("PASS Core Dots allows only the latest delegation in scope and revokes worker tools on hold, workspace move, or host fence");

  await ui.close();
  application.close();
  await background.close();
  await shutdownCoreWorker(root, database);
  reopened = await AppDatabase.open(undefined, coreOptions);
  assert.deepEqual(reopened.coreIdentity, identity);
  const afterRestart = reopened.runtimeAuditReader!;
  const foregroundAfterRestart = new DotsForegroundReads(undefined, afterRestart);
  const reloadedForeground = await foregroundAfterRestart.readState(foregroundInput);
  assert.deepEqual([reloadedForeground.calls, reloadedForeground.characters, reloadedForeground.exhausted], [2, 5, true]);
  assert.deepEqual((await foregroundAfterRestart.readUnlinked()).filter(row => row.inputs[0]?.id === originalSource), []);
  assert.deepEqual(await afterRestart.inspectDotsReply("outbox:worker-result-delivery"), { status: "settled" });
  assert.deepEqual(await afterRestart.readLatestDotsReply(replyWorker.id, null), {
    deliveryKey: "outbox:worker-result-delivery", operationId: "worker-result-delivery", artifacts: [artifact],
  });
  console.log("PASS restarting Core preserves the original Dots delivery receipt and attached artifact");
  assert.equal((await afterRestart.gatewayScheduler({ action: "start" }))?.status, "ok");
  assert.deepEqual(await afterRestart.gatewayDeliveryControl(restartRunning, "before-restart", { action: "claimExecution" }), { status: "stale" });
  assert.deepEqual(await afterRestart.gatewayDeliveryControl(restartRunning, "after-restart", { action: "claimExecution" }), { status: "claimed", attempt: 2 });
  assert.equal((await afterRestart.readGatewayOutbox(restartSending))?.status, "unknown");
  assert.deepEqual(await afterRestart.gatewayDeliveryControl(restartSending, "send-after-restart", { action: "claimReply", maxAttempts: 3 }), { status: "unavailable" });
  console.log("PASS restarting Core recovers Pi-backed execution under a new attempt and preserves an interrupted send without resending");
  assert.equal((await reopened.readTask(ids[0]))?.title, "Current title");
  assert.equal((await readSoulProfile(reopened)).name, "Library Owner");
  assert.deepEqual(await new BotRegistry(undefined, reopened.runtimeAuditReader).readBot(DEFAULT_BOT_ID), defaultBot);
  assert.deepEqual(await reopened.runtimeAuditReader!.registerBot(lostBot.request), lostBot.reply);
  assert.equal(await reopened.runtimeAuditReader!.readBotRegistry({ kind: "bot", botId: lostBot.request.botId }), null);
  const persisted = await new PythonProjectBindingStore(reopened.runtimeAuditReader!).resolveForDir(source);
  assert.equal(persisted?.pythonPath, python);
  assert.equal(persisted?.pythonVersion, "3.11.9");
  console.log("PASS closest Python binding, stale interpreter refusal, idempotent unbind and Core restart");
} finally {
  await reopened?.runtimeAuditReader?.close();
  await application?.runtimeAuditReader?.close();
  reopened?.close();
  application?.close();
  await background.close();
  await shutdownCoreWorker(root, database);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
