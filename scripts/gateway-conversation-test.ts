import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";
import { withGatewayMedia } from "../src/main/gateway/GatewayMedia";

const root = mkdtempSync(join(tmpdir(), "mybuddy-gateway-conversation-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");

const skillMarker = "PRIVATE_SKILL_GATEWAY_FIXTURE";
const { getSkillsDir } = await import("../src/main/paths");
const skills = join(getSkillsDir(), "gateway-private-fixture");
mkdirSync(skills, { recursive: true });
writeFileSync(join(skills, "SKILL.md"), "---\nname: gateway-private-fixture\ndescription: " + skillMarker + "\n---\n" + skillMarker);
const { AppSettingsStore } = await import("../src/main/AppSettingsStore");
new AppSettingsStore().write({ memoryEnabled: false });
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { GatewayService } = await import("../src/main/gateway/GatewayService");
const { gatewayConversationId } = await import("../src/main/gateway/GatewayConversation");
const { assignedGatewayConversation, reserveGatewayConversation, NEW_CONVERSATION_REPLY } = await import("../src/main/gateway/GatewayConversationSession");
const { gatewayInboundIdentity } = await import("../src/main/gateway/gateway-inbound-identity");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const { GATEWAY_CAPABILITIES } = await import("../src/main/gateway/GatewayCapabilities");
const { FeishuChannelAdapter } = await import("../src/main/gateway/channels");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { TaskExecutionWorkspaceLifecycle } = await import("../src/main/task/TaskExecutionWorkspaceLifecycle");

const dbPath = join(root, "app.db");
const db = new AppDatabase(dbPath);
const channelId = "qq-default", chatId = "group-fixture", connectionKey = "a".repeat(64);
const origin = (senderId: string) => ({ channelId, chatId, connectionKey, senderId, messageId: "origin", audience: "shared" as const });
const old = gatewayInboundIdentity(channelId, connectionKey, chatId).taskId;
const alice = gatewayConversationId(origin("alice")), bob = gatewayConversationId(origin("bob"));
const privateMarker = "PRIVATE_DESKTOP_TRANSCRIPT_FIXTURE";
const requests: Array<{ latest: string; transcript: string; tools: string[]; prompt: string }> = [];
const text = (message: TranscriptContext["messages"][number]): string =>
  typeof message.content === "string" ? message.content :
    message.content.filter(part => part.type === "text").map(part => part.text).join("");
let providerFailures = 0;
let duringModel: (() => void) | undefined;
const start = () => createAgentDurableFixture(root, db, input => {
  const latest = text(input.messages.findLast(message => message.role === "user")!);
  requests.push({ latest, transcript: JSON.stringify(input.messages),
    tools: getCurrentTools(input.messages).map(tool => tool.name), prompt: getCurrentSystemPrompt(input.messages) });
  if (latest === "REVOKE_IN_FLIGHT") duringModel?.();
  if (latest === "EMPTY_PROVIDER") return [];
  if (latest === "FAIL_PROVIDER") {
    providerFailures++;
    return { content: [{ type: "text", text: "PARTIAL_NOT_SUCCESS" }], errorMessage: "synthetic provider rejection" };
  }
  if (latest.startsWith("AFTER_TRASH_") || latest === "BLOCKED_WRITE" || latest.startsWith("READ_ATTACHMENT")) {
    const last = input.messages.at(-1)!;
    if (last.role !== "toolResult") {
      const attachment = latest.startsWith("READ_ATTACHMENT");
      const args: Record<string, string> = attachment ? { path: latest.trim().split("\n").at(-1)! }
        : { path: "channel-result.txt", content: latest };
      return [{ type: "toolCall", id: "file-" + input.messages.length,
        name: attachment ? "read" : "write", arguments: args }];
    }
    return [{ type: "text", text: last.isError ? "TOOL DENIED" : latest.startsWith("READ_ATTACHMENT") ? text(last) : "REPLY " + latest }];
  }
  return [{ type: "text", text: "REPLY " + latest }];
});

function openGateway(fixture: Awaited<ReturnType<typeof start>>) {
  const gateway = new GatewayService(db, fixture.agent);
  const internal = gateway as unknown as {
    settingsStore: { read(): { defaultModelId: string } };
    adapters: Map<string, { workConnectionKey(): string }>;
    channelPolicies: Map<string, { allowUsers: string[] }>;
    createInboundHandler(): GatewayInboundHandler;
  };
  internal.settingsStore = { read: () => ({ defaultModelId: "fixture/model" }) };
  internal.adapters.get(channelId)!.workConnectionKey = () => connectionKey;
  internal.adapters.get("telegram-default")!.workConnectionKey = () => connectionKey;
  internal.channelPolicies.set("telegram-default", { allowUsers: ["alice"] });
  const allow = (allowUsers: string[]) => internal.channelPolicies.set(channelId, { allowUsers });
  allow(["alice", "bob"]);
  const inbound = internal.createInboundHandler();
  const send = async (sender: string, messageId: string, message: string, replies: string[] = [], channel = channelId,
    attachments?: Array<{ name: string; path: string }>): Promise<string[]> => {
    await inbound({ channelId: channel, chatId, sender: { id: sender }, messageId, text: message, attachments,
      reply: async reply => { replies.push(reply); } });
    return replies;
  };
  return { gateway, allow, send };
}

function storedConversation(id: string, channel: string): string {
  const directory = join(root, "gateway", "spaces", channel);
  assert.equal(db.getSpace("sp-gw-" + channel)?.path, directory);
  const expected = join(directory, createHash("sha256").update(id).digest("hex"));
  const binding = db.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id = ?").get(id) as { directory: string };
  assert.equal(binding.directory, expected);
  return expected;
}

async function verifyTrashedConversations(fixture: Awaited<ReturnType<typeof start>>) {
  const lifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace: new TaskExecutionWorkspace(join(root, "task-workspaces")),
    trashRoot: join(root, "task-workspaces-trash"), beforeTrash: id => fixture.agent.releaseTaskForDeletion(id),
    prepareGatewayWorkspaceRestore: (id, from, to) => fixture.agent.prepareGatewayTrashRestore(id, from, to),
    onPurge: id => fixture.agent.purgeDurableTask(id) });
  const handlers = new Map<string, GatewayInboundHandler>();
  // Stand in for the connected transports. GatewayService registers the actual admission callbacks.
  const adapters = Object.fromEntries(Object.keys(GATEWAY_CAPABILITIES).map(type => {
    const id = type + "-default";
    return [type, { id, type, name: type, isConnected: () => true, workConnectionKey: () => connectionKey,
      setInboundHandler: (handler: GatewayInboundHandler) => handlers.set(id, handler), disconnect: async () => {} }];
  }));
  const feishu = new FeishuChannelAdapter("feishu-default", "飞书");
  const gateway = new GatewayService(db, fixture.agent, undefined, { adapters: { ...adapters, feishu } });
  gateway.setTrashedWorkspaceRestorer(id => lifecycle.restore(id));
  const { channelPolicies } = gateway as unknown as { channelPolicies: Map<string, { allowUsers: string[] }> };
  const feishuReplies = new Map<string, string[]>();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal") {
        return Response.json({ code: 0, tenant_access_token: "fixture-token", expire: 3600 });
      }
      const reply = /^https:\/\/open\.feishu\.cn\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(String(url));
      assert(reply, "unexpected platform request: " + url);
      const body = JSON.parse(String(init?.body));
      const answers = feishuReplies.get(reply[1]!) ?? [];
      answers.push(JSON.parse(body.content).text);
      feishuReplies.set(reply[1]!, answers);
      return Response.json({ code: 0 });
    };
    await feishu.connect({ appId: "app", appSecret: "secret", verificationToken: "verify", allowUsers: ["owner"] });
    for (const type of Object.keys(GATEWAY_CAPABILITIES)) {
      const channel = type + "-default";
      channelPolicies.set(channel, { allowUsers: ["owner"] });
      const send = async (messageId: string, message: string) => {
        if (channel === feishu.id) {
          await feishu.handleWebhookPayload({ schema: "2.0", header: { event_type: "im.message.receive_v1", app_id: "app", token: "verify" },
            event: { sender: { sender_id: { open_id: "owner" } }, message: { chat_id: "restore-chat", message_id: messageId,
              message_type: "text", content: JSON.stringify({ text: message }) } } });
          return feishuReplies.get(messageId) ?? [];
        }
        const inbound = handlers.get(channel);
        assert(inbound, `no registered inbound handler for ${channel}`);
        const replies: string[] = [];
        await inbound({ channelId: channel, chatId: "restore-chat", sender: { id: "owner" }, messageId, text: message,
          ...(type === "slack" ? { taskId: "slack-transport-task", userMessageId: "user-" + messageId, assistantMessageId: "assistant-" + messageId } : {}),
          reply: async answer => { replies.push(answer); } });
        return replies;
      };
      const first = "BEFORE_TRASH_" + type;
      assert.deepEqual(await send("first", first), ["REPLY " + first]);
      const original = db.listNonTrashedTasks().find(task => task.title === first);
      assert(original?.cwd);
      assert.equal(original.gatewaySidebarChannelId, channel);
      assert.equal(original.spaceId, "sp-gw-" + channel);
      assert.equal(db.getSpace(original.spaceId!)?.parentId, "sp-gw-root");
      const marker = join(original.cwd, "kept.txt");
      writeFileSync(marker, first);
      if (type === "qq") {
        lifecycle.archive(original.id);
        const before = requests.length;
        assert.match((await send("archived", "ARCHIVED_NO_RUN"))[0]!, /先恢复/);
        assert.equal(requests.length, before);
        lifecycle.unarchive(original.id);
      }
      const trash = await lifecycle.trash(original.id, { strict: true });
      assert(trash.trashPath);
      assert.equal(readFileSync(join(trash.trashPath, "kept.txt"), "utf8"), first);
      assert.equal(existsSync(original.cwd), false);
      assert.throws(() => db.deleteSpace(original.spaceId!));
      assert.throws(() => db.deleteSpaceTree(original.spaceId!));

      channelPolicies.set(channel, { allowUsers: ["someone-else"] });
      assert.deepEqual(await send("denied", "DENIED"), []);
      assert.equal(db.getTaskExecutionWorkspaceState(original.id)?.state, "trashed");
      channelPolicies.set(channel, { allowUsers: ["owner"] });

      if (type === "qq") {
        mkdirSync(original.cwd);
        writeFileSync(join(original.cwd, "collision.txt"), "keep both copies");
        assert.throws(() => lifecycle.restore(original.id), /不覆盖/);
        await assert.rejects(lifecycle.purge(original.id, { force: true }), /仍有原位数据/);
        assert.equal(readFileSync(join(trash.trashPath, "kept.txt"), "utf8"), first);
        rmSync(original.cwd, { recursive: true });
        const persist = db.upsertTaskExecutionWorkspaceState.bind(db);
        db.upsertTaskExecutionWorkspaceState = row => {
          if (row.taskId === original.id && row.state === "active") throw Error("fixture SQLite failure");
          persist(row);
        };
        try { assert.throws(() => lifecycle.restore(original.id), /fixture SQLite failure/); }
        finally { db.upsertTaskExecutionWorkspaceState = persist; }
        assert.equal(existsSync(original.cwd), false);
        assert.equal(readFileSync(join(trash.trashPath, "kept.txt"), "utf8"), first);
      }

      const next = "AFTER_TRASH_" + type;
      assert.deepEqual(await send("next", next), ["REPLY " + next]);
      assert.equal(readFileSync(join(original.cwd, "channel-result.txt"), "utf8"), next);
      assert.equal(join(original.cwd, ".."), db.getSpace(original.spaceId!)?.path);
      const turn = requests.at(-1)!;
      assert.equal(turn.latest, next);
      assert(turn.transcript.includes(first), "resumed model turn includes the original conversation");
      const restored = db.listNonTrashedTasks().find(task => task.id === original.id);
      assert.equal(restored?.gatewaySidebarChannelId, channel);
      assert.equal(restored?.spaceId, original.spaceId);
      assert.equal(restored?.archived, false);
      assert.equal(restored?.cwd, original.cwd);
      assert.equal(db.getTaskExecutionWorkspaceState(original.id)?.state, "active");
      assert.equal(readFileSync(marker, "utf8"), first);
      assert.equal(existsSync(trash.trashPath), false);
      const history = new Database(join(storedConversation(original.id, channel), "durable.sqlite"), { readonly: true, fileMustExist: true });
      try {
        for (const content of [first, next, "REPLY " + next]) {
          assert(history.prepare("SELECT 1 FROM entries WHERE instr(record, ?) > 0").get(content), content);
        }
      } finally { history.close(); }
      const oldTrash = await lifecycle.trash(original.id, { strict: true });
      const beforeReset = requests.length;
      channelPolicies.set(channel, { allowUsers: ["someone-else"] });
      assert.deepEqual(await send("denied-new", "/new"), []);
      channelPolicies.set(channel, { allowUsers: ["owner"] });
      assert.deepEqual(await send("reset", " /new "), [NEW_CONVERSATION_REPLY]);
      assert.equal(requests.length, beforeReset, "reset never invokes the model or restores the prior target");
      assert.equal(db.getTaskExecutionWorkspaceState(original.id)?.state, "trashed");
      assert.equal(readFileSync(join(oldTrash.trashPath!, "kept.txt"), "utf8"), first);
      const freshText = "NEW_AFTER_TRASH_" + type;
      assert.deepEqual(await send("fresh", freshText), ["REPLY " + freshText]);
      assert(!requests.at(-1)?.transcript.includes(first));
      const fresh = db.listNonTrashedTasks().find(task => task.title === freshText);
      assert(fresh?.cwd && fresh.id !== original.id && fresh.cwd !== original.cwd);
      assert.equal(fresh.spaceId, original.spaceId);
      assert.notEqual(storedConversation(fresh.id, channel), storedConversation(original.id, channel));
      assert.equal(db.getTaskExecutionWorkspaceState(original.id)?.state, "trashed");
    }

    const fake = handlers.get(channelId)!;
    const raceChat = "route-order-fixture";
    const sendQueued = (messageId: string, text: string, reply: (answer: string) => Promise<void> = async () => {}) =>
      fake({ channelId, chatId: raceChat, sender: { id: "owner" }, messageId, text, reply });
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const inReply = new Promise<void>(resolve => { entered = resolve; });
    const first = sendQueued("seed", "PREVIOUS_IN_FLIGHT", async answer => {
      assert.equal(answer, "REPLY PREVIOUS_IN_FLIGHT");
      entered(); await hold;
    });
    try {
      await Promise.race([inReply, first]);
      const delayed = sendQueued("pending", "PENDING_PREVIOUS");
      const reset = sendQueued("reset-one", "/new");
      const next = sendQueued("first-new", "FIRST_FRESH");
      await Promise.all([delayed.accepted, reset.accepted, next.accepted]);
      const r = (messageId: string) => ({ channelId, chatId: raceChat, connectionKey, senderId: "owner", messageId });
      const original = gatewayConversationId(r("pending"));
      const selected = assignedGatewayConversation(db.connection, r("first-new"))!;
      assert.equal(assignedGatewayConversation(db.connection, r("pending")), original, "pin older queued message before reset");
      assert.notEqual(selected, original);
      assert.equal(db.getTask(selected), undefined, "fresh task is lazy before first prompt runs");
      release();
      await Promise.all([first, delayed, reset, next]);
      assert(requests.find(request => request.latest === "PENDING_PREVIOUS")?.transcript.includes("PREVIOUS_IN_FLIGHT"));
      assert(!requests.find(request => request.latest === "FIRST_FRESH")!.transcript.includes("PENDING_PREVIOUS"));
      const oldSession = storedConversation(original, channelId);
      const newSession = storedConversation(selected, channelId);
      assert.notEqual(oldSession, newSession);
      const reopen = new AppDatabase(dbPath);
      try {
        assert.equal(reserveGatewayConversation(reopen.connection, r("reset-one"), true).taskId, selected);
        const newest = reserveGatewayConversation(reopen.connection, r("reset-two"), true).taskId;
        assert.notEqual(newest, selected);
        assert.equal(reserveGatewayConversation(reopen.connection, r("reset-one"), true).currentTaskId, newest,
          "old command replay cannot change the newest pointer");
        assert.equal(reserveGatewayConversation(reopen.connection, r("pending"), false).taskId, original,
          "replayed ordinary receipt stays on the original generation after restart");
        for (const independent of [{ chatId: "another-chat" }, { connectionKey: "b".repeat(64) },
          { senderId: "alice" }, { channelId: "telegram-default" }]) {
          const other = { ...r("other-prompt"), ...independent };
          assert.equal(reserveGatewayConversation(reopen.connection, other, false).taskId, gatewayConversationId(other));
        }
        assert.throws(() => reserveGatewayConversation(reopen.connection, r("local:generated"), true), /缺少稳定标识/);
        const legacy = { ...r("prefeature-ordinary"), chatId: "pre-feature-journal" };
        const legacyTask = gatewayConversationId(legacy);
        const moved = reserveGatewayConversation(reopen.connection, { ...legacy, messageId: "reset-later" }, true, { acceptedAt: 200 }).taskId;
        assert.notEqual(moved, legacyTask);
        assert.equal(reserveGatewayConversation(reopen.connection, legacy, false,
          { acceptedAt: 100, recovered: true }).taskId, legacyTask, "legacy inbox must not inject older text into fresh history");
        const stale = reserveGatewayConversation(reopen.connection, { ...legacy, messageId: "stale-slack-reset" }, true,
          { acceptedAt: 99, recovered: true });
        assert.equal(stale.currentTaskId, moved);
        assert.notEqual(stale.taskId, moved);
        assert.equal(reserveGatewayConversation(reopen.connection, { ...legacy, messageId: "normal-later" }, false).taskId, moved);

      } finally { reopen.close(); }
    } finally { release(); }

    console.log("PASS Gateway /new across all nine registered adapters: no old restore/model, fresh files/history, durable queued delivery and replay");
    console.log("PASS Gateway restores the same conversation, directory, history and reply for", [feishu.id, ...handlers.keys()].join(", "));
    const removed = storedConversation(bob, "qq-default");
    const kept = storedConversation(alice, "qq-default");
    assert.notEqual(removed, kept);
    await lifecycle.trash(bob, { strict: true });
    await lifecycle.purge(bob, { force: true, strict: true });
    assert.equal(existsSync(removed), false);
    assert(existsSync(join(kept, "durable.sqlite")));
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
  }
}

let fixture: Awaited<ReturnType<typeof start>> | undefined;
let bridge: ReturnType<typeof openGateway> | undefined;
try {
  fixture = await start();
  db.upsertTask({ id: old, title: privateMarker, updatedAt: 1 });
  assert.match(alice, /^gateway-chat-[a-f0-9]{64}$/);
  assert.equal(alice, gatewayConversationId({ ...origin("alice"), messageId: "later" }));
  for (const different of [bob, old, gatewayConversationId({ ...origin("alice"), connectionKey: "b".repeat(64) }),
    gatewayConversationId({ ...origin("alice"), channelId: "telegram-default" }),
    gatewayConversationId({ ...origin("alice"), chatId: "other-chat" })]) assert.notEqual(alice, different);
  await assert.rejects(fixture.agent.runGatewayTurn({ taskId: old, text: "LEGACY DENIED",
    modelId: "fixture/model", userMessageId: "legacy-user", assistantMessageId: "legacy-assistant", gatewayOrigin: origin("alice") }));
  bridge = openGateway(fixture);
  await fixture.prompt({ taskId: "desktop-gateway-fixture", text: privateMarker, userMessageId: "desktop-user", assistantMessageId: "desktop-assistant" });
  const desktop = requests.at(-1)!;
  assert(desktop.tools.length, "control requests on desktop must actually expose tools");
  assert(desktop.prompt.includes(skillMarker), "desktop positive control must actually receive the local skill");
  assert(desktop.transcript.includes(privateMarker), "desktop-only transcript exists before any gateway message");
  const first = requests.length;
  assert.deepEqual(await bridge.send("alice", "a1", "ALICE_FIRST"), ["REPLY ALICE_FIRST"]);
  assert.deepEqual(await bridge.send("alice", "a1", "DUPLICATE"), []);
  const [aliceReplies, bobReplies] = await Promise.all([
    bridge.send("alice", "a2", "ALICE_CONTINUE"), bridge.send("bob", "b1", "BOB_FIRST"),
  ]);
  assert.deepEqual(aliceReplies, ["REPLY ALICE_CONTINUE"]);
  assert.deepEqual(bobReplies, ["REPLY BOB_FIRST"]);
  const live = requests.slice(first);
  assert.equal(live.length, 3);
  const aliceContinue = live.find(request => request.latest === "ALICE_CONTINUE")!;
  assert(aliceContinue.transcript.includes("ALICE_FIRST"), "own history is available");
  assert(!live.find(request => request.latest === "BOB_FIRST")!.transcript.includes("ALICE_FIRST"));
  assert(db.getTask(alice) && db.getTask(bob));
  assert.equal(db.getTask(old)?.title, privateMarker, "legacy task must not be adopted or rewritten");
  bridge.allow([]);
  assert.deepEqual(await bridge.send("alice", "a3", "DENIED_EMPTY"), []);
  bridge.allow(["alice", "bob"]);
  assert.deepEqual(await bridge.send("unknown", "a4", "DENIED_STRANGER"), []);
  assert.equal(requests.length, first + 3);
  assert.deepEqual(await bridge.send("alice", "tg1", "TELEGRAM_FIRST", [], "telegram-default"), ["REPLY TELEGRAM_FIRST"]);
  const telegram = gatewayConversationId({ ...origin("alice"), channelId: "telegram-default" });
  const expectedGroups = new Map([[alice, "qq-default"], [bob, "qq-default"], [telegram, "telegram-default"]]);
  const assertSidebar = (database: InstanceType<typeof AppDatabase>) => {
    const list = database.listNonTrashedTasks();
    assert.equal(list.filter(task => task.gatewaySidebarChannelId).length, 3);
    for (const [taskId, channel] of expectedGroups) {
      const row = list.find(task => task.id === taskId);
      assert.equal(row?.gatewaySidebarChannelId, channel);
      assert.equal(row?.spaceId, "sp-gw-" + channel);
      assert.equal(database.getSpace(row.spaceId!)?.parentId, "sp-gw-root");
      assert.equal(row?.projectId, undefined);
    }
    assert.equal(list.find(task => task.id === old)?.gatewaySidebarChannelId, undefined);
  };
  const impostor = gatewayConversationId(origin("not-authorized"));
  db.upsertTask({ id: impostor, title: "A carried DTO cannot create a trusted group", updatedAt: Date.now(), gatewaySidebarChannelId: "qq-default" });
  assert.equal(db.getTask(impostor)?.gatewaySidebarChannelId, undefined);
  db.createSpace({ id: "normal-workspace", name: "Ordinary workspace" });
  assert.throws(() => db.moveTaskInWorkspaceTree({ taskId: alice, targetSpaceId: "normal-workspace" }), /不能移入/);
  assert.throws(() => db.upsertTask({ id: alice, title: "scope spoof", updatedAt: Date.now(), spaceId: "normal-workspace" }), /不能绑定/);
  assert.throws(() => db.upsertTask({ id: alice, title: "scope spoof", updatedAt: Date.now(), projectId: "not-a-project" }), /不能绑定/);
  assertSidebar(db);
  assert.throws(() => db.moveTaskInWorkspaceTree({ taskId: alice, targetSpaceId: null }));
  assert.throws(() => db.upsertTask({ id: alice, title: "detach", updatedAt: Date.now(), spaceId: null }));
  assert.throws(() => db.upsertTask({ id: alice, title: "wrong channel", updatedAt: Date.now(), spaceId: "sp-gw-telegram-default" }));
  assert.equal(bridge.gateway.listMessages({ channelId }).filter(event =>
    event.direction === "system" && event.text.includes("发送者")).length, 2);

  await bridge.gateway.stop(); bridge = undefined;
  const models = fixture.models;
  await fixture.close(); fixture = undefined;
  // Reopen SQLite itself (not only the agent object), ensuring groups are persisted.
  const channelStore = storedConversation(alice, "qq-default");
  const channelCwd = db.getTask(alice)!.cwd!;
  const previousWorkspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
  const { qqTaskWorkspace, prepareQQWorkspaceParent } = await import("../src/main/task/QQTaskWorkspace");
  prepareQQWorkspaceParent(previousWorkspace, true);
  const oldCwd = qqTaskWorkspace(previousWorkspace, alice);
  renameSync(channelCwd, oldCwd);
  writeFileSync(join(oldCwd, "previous-note.txt"), "old workspace file");
  const { DurableBotRuntime } = await import("../src/main/agent/durable/DurableBotRuntime");
  const oldRuntime = await DurableBotRuntime.open({ directory: channelStore, cwd: oldCwd, workspaceMigrationFrom: channelCwd,
    models, model: { provider: "fixture", modelId: "model" }, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  await oldRuntime.close();
  const oldStore = join(root, ".mybuddy", "durable", createHash("sha256").update(alice).digest("hex"));
  renameSync(channelStore, oldStore);
  db.connection.prepare("UPDATE durable_bot_bindings SET directory = ?, cwd = ? WHERE task_id = ?").run(oldStore, oldCwd, alice);
  db.bindTaskExecutionWorkspaceCwd(alice, oldCwd);
  db.connection.prepare("UPDATE tasks SET space_id = NULL WHERE id = ?").run(bob);
  const reopenedDb = new AppDatabase(dbPath);
  try { assertSidebar(reopenedDb); } finally { reopenedDb.close(); }
  fixture = await start(); bridge = openGateway(fixture);
  const olderLifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace: previousWorkspace,
    trashRoot: join(root, "older-qq-trash"), beforeTrash: id => fixture!.agent.releaseTaskForDeletion(id),
    prepareGatewayWorkspaceRestore: (id, from, to) => fixture!.agent.prepareGatewayTrashRestore(id, from, to) });
  assert(!olderLifecycle.scanOrphans().some(row => row.directoryName === "gateway"));
  assert.throws(() => olderLifecycle.moveOrphanToTrash("gateway"), /托管容器/);
  assert.throws(() => olderLifecycle.adoptOrphan("gateway", "ordinary-task"), /托管容器/);
  await olderLifecycle.trash(alice, { strict: true });
  bridge.gateway.setTrashedWorkspaceRestorer(id => olderLifecycle.restore(id));
  assert.equal(storedConversation(alice, "qq-default"), channelStore);
  assert(existsSync(join(channelStore, "durable.sqlite")));
  assert.deepEqual(await bridge.send("alice", "a5", "ALICE_REOPEN"), ["REPLY ALICE_REOPEN"]);
  assert.equal(db.getTask(alice)?.cwd, channelCwd);
  assert.equal(readFileSync(join(channelCwd, "previous-note.txt"), "utf8"), "old workspace file");
  const { runTaskIsolationAudit } = await import("../src/main/task/TaskIsolationAudit");
  assert.equal(runTaskIsolationAudit({ db, dbPath, workspacesRoot: previousWorkspace.getTaskExecutionWorkspacesRoot(),
    taskId: alice }).summary.canonicalCount, 1);
  assert.equal(existsSync(oldStore), false);
  const reopened = requests.at(-1)!;
  assert(reopened.transcript.includes("ALICE_FIRST") && !reopened.transcript.includes("BOB_FIRST"));
  assert(reopened.tools.includes("read") && reopened.tools.includes("write"), "Gateway must expose the configured ordinary task file tools");
  assert(!reopened.transcript.includes(privateMarker), "desktop conversation history stays separate");
  const attachmentReply = await withGatewayMedia([{ name: "note.txt", url: "https://media.example/note.txt",
    allowedHosts: ["media.example"], fetch: async () => new Response("ATTACHED_FILE_CONTENT_731") }],
    async files => {
      const reply = await bridge!.send("alice", "a-file", "READ_ATTACHMENT", [], channelId, files);
      const localCopy = requests.at(-1)!.latest.trim().split("\n").at(-1)!;
      assert.equal(relative(channelCwd, localCopy).split(sep)[0], "attachments");
      assert.equal(readFileSync(localCopy, "utf8"), "ATTACHED_FILE_CONTENT_731");
      writeFileSync(localCopy, "Alice's edited copy");
      assert.deepEqual(await bridge!.send("bob", "b-file", "READ_ATTACHMENT", [], channelId, files), ["ATTACHED_FILE_CONTENT_731"]);
      assert.equal(readFileSync(files[0]!.path, "utf8"), "ATTACHED_FILE_CONTENT_731");
      return reply;
    });
  assert.deepEqual(attachmentReply, ["ATTACHED_FILE_CONTENT_731"]);
  db.upsertTask({ ...db.getTask(alice)!, welcomeMode: "coding", modePresetId: "readonly-explain" });
  assert.deepEqual(await bridge.send("alice", "a6", "BLOCKED_WRITE"), ["TOOL DENIED"]);
  assert.equal(db.getTask(alice)?.modePresetId, "readonly-explain");
  assert(!existsSync(join(db.getTask(alice)!.cwd!, "channel-result.txt")));
  const inFlightReplies: string[] = [];
  let revokedAfterAdmission = false;
  duringModel = () => { revokedAfterAdmission = true; bridge!.allow(["bob"]); };
  await assert.rejects(bridge.send("alice", "a7", "REVOKE_IN_FLIGHT", inFlightReplies), /未发送/);
  duringModel = undefined;
  assert(revokedAfterAdmission, "the freshly revoked sender reached the provider while authorized");
  assert.deepEqual(inFlightReplies, [], "no response may be delivered after mid-turn revocation");
  const failure = await bridge.send("bob", "b2", "FAIL_PROVIDER");
  assert(providerFailures > 0, "the deterministic provider failure was actually exercised");
  assert.equal(failure.length, 1);
  assert.match(failure[0]!, /^处理失败：/);
  assert(!failure[0]!.includes("PARTIAL_NOT_SUCCESS"), "partial assistant text from a failed provider is not a successful reply");
  const empty = await bridge.send("bob", "b3", "EMPTY_PROVIDER");
  assert.equal(requests.at(-1)?.latest, "EMPTY_PROVIDER", "the fixture actually produced an empty model result");
  assert.equal(empty.length, 1);
  assert.match(empty[0]!, /^处理失败：/);
  assert(!empty[0]!.includes("任务已处理"), "empty provider results cannot become synthetic success");
  console.log("PASS Gateway task tools, configured write restriction, sender isolation, deduplication and cold reopen");
  await verifyTrashedConversations(fixture);
} finally {
  await bridge?.gateway.stop();
  await fixture?.close();
  db.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
