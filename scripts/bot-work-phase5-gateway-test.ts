import { createGatewayBotFixture } from "./gateway-bot-fixture";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import assert from "node:assert/strict";
import type { AgentPromptRequest } from "../src/shared/agent-ipc";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import type { AppSettingsStore } from "../src/main/AppSettingsStore";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkNotificationHost } from "../src/main/agent/work/WorkNotificationHost";
import { WorkGatewayNotificationChannels, workGatewayText } from "../src/main/agent/work/WorkGatewayNotificationChannel";
import { GatewayService, GATEWAY_REDACTED } from "../src/main/gateway/GatewayService";
import { GatewayReplyNotSentError } from "../src/main/gateway/GatewayReply";
import { GatewayWorkTargets } from "../src/main/gateway/GatewayWorkTargets";
import { gatewayWorkTargetSchema, type GatewayWorkTarget, type GatewayWorkSendInput } from "../src/main/gateway/work-outbound";
import { FeishuChannelAdapter, WecomChannelAdapter, WechatMpChannelAdapter, TelegramChannelAdapter } from "../src/main/gateway/channels";
import { SlackSocketModeAdapter, type SlackSocket } from "../src/main/gateway/SlackSocketModeAdapter";
import { SlackGatewayJournal } from "../src/main/gateway/SlackGatewayJournal";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

// Real production adapters and SQLite, mocked provider transport only. No credentials,
// external recipients, native execution or secondary Work delivery ledger are used.
const root = mkdtempSync(join(tmpdir(), "phase5-gateway-"));
const originalFetch = globalThis.fetch;
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const config = { appId: "cli-fixture", appSecret: "fixture-secret", verificationToken: "fixture-verify", allowUsers: ["user-1"] };
type Request = { url: URL; body: Record<string, unknown>; signal?: AbortSignal | null };
const posts: Request[] = [];
let respond: ((request: Request) => Promise<Response> | Response) | undefined;
let refresh: (() => Promise<Response>) | undefined;
let serial = 0;
let passed = 0;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture condition timed out"); await wait(2); }
}
const unwrap = (result: WorkControlResult): WorkDto => { if (!result.ok) throw new Error(result.code + ": " + result.message); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const isWorkPost = (request: Request) => JSON.stringify(request.body).includes("MyBuddy 结果卡");
const workPosts = () => posts.filter(isWorkPost);
const success = (request: Request, receipt = "message-" + ++serial): Response => {
  if (request.url.hostname === "open.feishu.cn") return json({ code: 0, data: { message_id: receipt, chat_id: request.body.receive_id } });
  if (request.url.hostname === "slack.com") return json({ ok: true, channel: request.body.channel, ts: "1700000001.000001" });
  if (request.url.hostname === "api.telegram.org") return json({ ok: true, result: { message_id: 17, chat: { id: Number(request.body.chat_id) }, message_thread_id: request.body.message_thread_id } });
  return json({ errcode: 0, msgid: receipt });
};
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) {
    return refresh ? refresh() : json({ code: 0, tenant_access_token: "fixture-tenant-token", expire: 7200 });
  }
  if (url.pathname.endsWith("/gettoken") || url.pathname.endsWith("/token")) return refresh ? refresh() : json({ access_token: "fixture-token", expires_in: 7200 });
  if (url.pathname.endsWith("/getMe")) return json({ ok: true, result: { id: 9001, username: "fixture_bot" } });
  if (url.pathname.endsWith("/getUpdates")) return new Promise<Response>(() => {});
  if (url.pathname.endsWith("/auth.test")) return json({ ok: true, team_id: "TTEST", user_id: "UBOT", bot_id: "BTEST" });
  if (url.pathname.endsWith("/apps.connections.open")) return json({ ok: true, url: "wss://wss.slack.com/link/?ticket=fixture" });
  assert(["open.feishu.cn", "qyapi.weixin.qq.com", "api.weixin.qq.com", "api.telegram.org", "slack.com"].includes(url.hostname), "no unmocked network request");
  const request: Request = { url, body: JSON.parse(String(init?.body)), signal: init?.signal };
  posts.push(request);
  return respond ? respond(request) : success(request);
}) as typeof fetch;

type Harness = ReturnType<typeof harness>;
const harnesses: Array<{ close(): Promise<void> }> = [];
function harness(path = join(root, "db-" + ++serial + ".db")) {
  const db = new AppDatabase(path);
  const bots = new BotRegistry(db.connection);
  if (!db.connection.prepare("SELECT 1 FROM bots WHERE bot_id=?").get(DEFAULT_BOT_ID)) {
    bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "Owner", authorization: grants });
  }
  const state = { authority: true, executions: 0, answerGate: undefined as Promise<void> | undefined, host: undefined as WorkNotificationHost | undefined, closed: false };
  const works = new WorkService(db.connection, { bots, isAuthority: () => state.authority,
    emitProjection: () => state.host?.wake() });
  const created: WorkDto[] = [];
  const requests: AgentPromptRequest[] = [];
  const feishu = new FeishuChannelAdapter("feishu-default", "Fixture Feishu");
  const model:any={provider:"fixture",id:"native",name:"fixture",api:"openai-completions",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const models:any={getAuth:async()=>undefined,refresh:async()=>{},getAvailable:async()=>[model],getModel:()=>model,
    streamSimple:()=>{const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:"done",reason:"stop",message:{role:"assistant",content:[{type:"text",text:"fixture native receipt"}],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});stream.end();});return stream;}};
  const foreground=createGatewayBotFixture({db,models,root,botId:DEFAULT_BOT_ID});
  const gateway = new GatewayService(db, { runGatewayTurn: async request => {
    state.executions++;
    requests.push(request);
    const receipt=foreground.botConversations.acceptGateway({botId:DEFAULT_BOT_ID,requestId:"gateway:"+request.userMessageId,
      text:request.text,attachments:request.attachments,origin:request.gatewayOrigin});
    const work = unwrap(works.createWork(user, { operationId: "create:" + request.userMessageId,
      title: request.text, conversationId: receipt.conversationId, sourceMessageId: receipt.userMessageId,
      authorization: grants, inputSnapshotId: "input:" + request.userMessageId, criteria: [{ text: "Checked evidence" }] }));
    created.push(work); await state.answerGate; return foreground.botConversations.awaitReply(receipt);
  } }, undefined, { settingsStore: { read: () => ({}) as ReturnType<AppSettingsStore["read"]> }, adapters: { feishu } });
  const bridge = new WorkGatewayNotificationChannels(db.connection, works, gateway, { isAuthority: () => state.authority });
  const result = { path, db, bots, works, state, gateway, feishu, bridge, created, requests,
    async close() { if (state.closed) return; await state.host?.close(); await gateway.stop(); await foreground.close(); db.close(); state.closed = true; } };
  harnesses.push(result);
  return result;
}
function payload(id: string, chat = "chat-1") {
  return { schema: "2.0", header: { event_type: "im.message.receive_v1", app_id: config.appId, token: config.verificationToken },
    event: { message: { chat_id: chat, message_id: id, content: JSON.stringify({ text: "Work " + id }), message_type: "text" },
      sender: { sender_id: { open_id: "user-1" } } } };
}
async function accepted(h: Harness, label: string, chat = "chat-1") {
  const id = label + ":" + ++serial;
  await h.feishu.handleWebhookPayload(payload(id, chat));
  const work = h.created.at(-1)!;
  assert(work && work.title === "Work " + id, "authenticated native input created the Work");
  const taskId = "execution:" + id;
  h.db.upsertTask({ id: taskId, title: label, updatedAt: Date.now() });
  unwrap(h.works.dispatchExecution(user, { operationId: "dispatch:" + id, workId: work.workId, botId: DEFAULT_BOT_ID,
    taskId, durableStoreKey: "store:" + id, conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read", "workspace:write"] }));
  const binding = h.works.repo.listBindings(work.workId)[0]!;
  const worker: WorkActor = { kind: "worker", botId: DEFAULT_BOT_ID, bindingId: binding.bindingId };
  unwrap(h.works.submitDeliverable(worker, { operationId: "submit:" + id, workId: work.workId, bindingId: binding.bindingId,
    deliverableId: "deliverable:" + id, summary: "Verified outcome", artifactRefs: [], evidence: [{ kind: "tool_receipt", sourceRef: "receipt:" + id }] }));
  unwrap(h.works.acceptDeliverable(user, { operationId: "accept:" + id, workId: work.workId, deliverableId: "deliverable:" + id }));
  h.works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
  h.bridge.materialize();
  const notification = h.works.repo.listNotifications(work.workId).find(item => item.channel === "gateway:feishu-default")!;
  assert(notification, "a trusted source yields an addressed Gateway intent");
  const channel = h.bridge.channels().find(item => item.targetKey === notification.targetKey)!;
  return { workId: work.workId, notification, channel, binding, input: payload(id, chat) };
}
async function check(name: string, run: () => void | Promise<void>) { respond = undefined; refresh = undefined; await run(); passed++; console.log("PASS " + name); }

class FixtureSocket implements SlackSocket {
  onmessage: SlackSocket["onmessage"] = null; onclose: SlackSocket["onclose"] = null; onerror: SlackSocket["onerror"] = null;
  send(): void {} close(): void { this.onclose?.(); }
}

try {
  const h = harness();
  await h.gateway.connect("feishu-default", config);
  await check("native inputs isolate accounts and preserve receipt identity across reconnect and restart", async () => {
    const local = harness();
    const requests = local.requests;
    await local.gateway.connect("feishu-default", config);
    await local.feishu.handleWebhookPayload(payload("same-provider-id"));
    await local.feishu.handleWebhookPayload(payload("same-provider-id"));
    assert.equal(requests.length, 1, "same-account duplicate is ignored");
    await local.gateway.connect("feishu-default", { ...config, appId: "other-account" });
    const other = payload("same-provider-id"); other.header.app_id = "other-account";
    await local.feishu.handleWebhookPayload(other);
    assert.equal(requests.length, 2, "other account is not suppressed by the old dedupe entry");
    assert.notEqual(requests[0]!.taskId, requests[1]!.taskId);
    assert.notEqual(requests[0]!.userMessageId, requests[1]!.userMessageId);
    assert.notEqual(requests[0]!.assistantMessageId, requests[1]!.assistantMessageId);
    assert.equal(local.created.length, 2, "other account creates a separate native Work");
    await local.gateway.connect("feishu-default", config);
    await local.feishu.handleWebhookPayload(payload("another-provider-id"));
    assert.equal(requests[2]!.taskId, requests[0]!.taskId, "returning account resumes its own session");
    const path = local.path; await local.close();
    const reopened = harness(path); await reopened.gateway.restoreChannels();
    await reopened.feishu.handleWebhookPayload(payload("same-provider-id"));
    assert.equal(reopened.requests.length, 0, "a completed transport receipt suppresses redelivery before the native Agent");
    assert.equal(reopened.created.length, 0, "restart must not recreate a Work for an already answered message");
    const receipts = reopened.db.connection.prepare(
      "SELECT account_key,status FROM gateway_inbox WHERE message_id=? ORDER BY account_key",
    ).all("same-provider-id") as Array<{ account_key: string; status: string }>;
    assert.equal(receipts.length, 2, "both independently authenticated accounts retain their own receipts");
    assert.notEqual(receipts[0].account_key, receipts[1].account_key);
    assert(receipts.every(receipt => receipt.status === "completed"));
    await reopened.close();
  });
  await check("account changes during native execution cannot send the old answer through the new account", async () => {
    const local = harness(); await local.gateway.connect("feishu-default", config);
    const gate = deferred<void>(); local.state.answerGate = gate.promise;
    const count = posts.length;
    const handling = local.feishu.handleWebhookPayload(payload("switch-during-native"));
    const rejected = assert.rejects(handling, /连接账号已改变/);
    await until(() => local.state.executions === 1);
    await local.gateway.connect("feishu-default", { ...config, appId: "new-account" });
    gate.resolve(); await rejected;
    assert.equal(posts.length, count, "no answer POST crosses the account boundary");
    await local.close();
  });
  await check("reply generation fences same-account reconnect and token-refresh waits", async () => {
    const adapter = new FeishuChannelAdapter("reply-fixture", "Reply fixture");
    try {
      await adapter.connect(config);
      let reply: ((text: string) => Promise<void>) | undefined;
      adapter.setInboundHandler(async message => { reply = message.reply; });
      await adapter.handleWebhookPayload(payload("capture-reply"));
      const oldReply = reply!;
      await adapter.connect(config);
      const count = posts.length;
      await assert.rejects(oldReply("old answer"), /回复连接已改变/);
      assert.equal(posts.length, count);
      await adapter.handleWebhookPayload(payload("refresh-reply"));
      const held = deferred<Response>(); let refreshing = false;
      refresh = () => { refreshing = true; return held.promise; };
      (adapter as unknown as { tokenExpireAt: number }).tokenExpireAt = 0;
      const sending = reply!("answer awaiting refresh");
      const rejected = assert.rejects(sending, /连接已改变/);
      await until(() => refreshing);
      refresh = undefined;
      await adapter.connect({ ...config, appId: "changed-during-refresh" });
      held.resolve(json({ code: 0, tenant_access_token: "old-token", expire: 7200 }));
      await rejected;
      assert.equal(posts.length, count, "refresh completion cannot send through a replaced connection");
    } finally { refresh = undefined; await adapter.disconnect(); }
  });
  await check("WeCom and WeChat ordinary reply token waits stay fenced after reconnect", async () => {
    const adapters = [new WecomChannelAdapter("reply-wecom", "WeCom"), new WechatMpChannelAdapter("reply-wechat", "WeChat")];
    for (const adapter of adapters) {
      const credentials = { corpId: "corp", agentId: "7", secret: "fixture", appId: "wx-app", appSecret: "fixture",
        token: "verify", encodingAESKey: "a".repeat(43) };
      try {
        await adapter.connect(credentials);
        const internals = adapter as unknown as { generation: number; tokenExpireAt: number;
          sendText(...args: Array<string | number>): Promise<void> };
        const generation = internals.generation;
        const send = () => adapter.type === "wecom"
          ? internals.sendText("member", "member", "answer", generation)
          : internals.sendText("member", "answer", generation);
        const held = deferred<Response>(); let refreshing = false;
        refresh = () => { refreshing = true; return held.promise; };
        internals.tokenExpireAt = 0;
        const count = posts.length;
        const sending = send(); const rejected = assert.rejects(sending, /连接已改变/);
        await until(() => refreshing); refresh = undefined;
        await adapter.connect({ ...credentials, corpId: "new-corp", appId: "new-app" });
        held.resolve(json({ access_token: "old-token", expires_in: 7200 }));
        await rejected;
        await assert.rejects(send(), /回复连接已改变/);
        assert.equal(posts.length, count, "neither a stale token refresh nor old reply may send");
      } finally { refresh = undefined; await adapter.disconnect(); }
    }
  });
  await check("Telegram chunk continuation and HTML fallback cannot use a reconnected bot", async () => {
    const adapter = new TelegramChannelAdapter("reply-telegram", "Reply Telegram");
    try {
      await adapter.connect({ botToken: "9001:fixture" });
      let reply: ((text: string) => Promise<void>) | undefined;
      adapter.setInboundHandler(async message => { reply = message.reply; });
      const input = () => (adapter as unknown as { handleUpdate(update: unknown): Promise<void> }).handleUpdate({
        update_id: 1, message: { message_id: 1, chat: { id: 7 }, from: { id: 8 }, text: "hello" },
      });
      for (const fallback of [false, true]) {
        await input();
        const held = deferred<Response>(); let started = false;
        respond = () => { started = true; return held.promise; };
        const count = posts.length;
        const sending = reply!(fallback ? "html" : "x".repeat(5000));
        const rejected = assert.rejects(sending, error => {
          assert(error instanceof Error);
          if (fallback) assert(error instanceof GatewayReplyNotSentError && /回复连接已改变/.test(error.message));
          else assert(!(error instanceof GatewayReplyNotSentError) && /部分已发送/.test(error.message),
            "one accepted chunk makes the whole reply non-retryable even after reconnect");
          return true;
        });
        await until(() => started);
        await adapter.connect({ botToken: "9001:replacement" });
        held.resolve(fallback ? json({ description: "can't parse entities" }, 400) : json({ ok: true }));
        await rejected;
        assert.equal(posts.length, count + 1, "only the original account's in-flight request is allowed");
        respond = undefined;
      }
    } finally { respond = undefined; await adapter.disconnect(); }
  });
  await check("Feishu verification fails closed before native execution and keeps its token redacted", async () => {
    const isolated = new FeishuChannelAdapter("isolated", "Feishu");
    await assert.rejects(isolated.connect({ appId: config.appId, appSecret: config.appSecret, transport: "webhook" }), /verificationToken/);
    const before = h.state.executions;
    for (const input of [
      { ...payload("bad-token"), header: { ...payload("x").header, token: "forged" } },
      { ...payload("bad-app"), header: { ...payload("x").header, app_id: "foreign-app" } },
      { ...payload("bad-schema"), schema: "1.0" },
      { encrypt: "unverified ciphertext" },
      { type: "url_verification", token: "forged", challenge: "challenge" },
    ]) await assert.rejects(h.feishu.handleWebhookPayload(input));
    assert.equal(h.state.executions, before);
    assert.equal((await h.feishu.handleWebhookPayload({ type: "url_verification", token: config.verificationToken, challenge: "challenge" }))?.challenge, "challenge");
    assert.equal(h.gateway.getChannelConfig("feishu-default").config.verificationToken, GATEWAY_REDACTED);
  });
  await check("authenticated input records one immutable exact source route, with no latest-conversation fallback", async () => {
    const f = await accepted(h, "source");
    const targets = new GatewayWorkTargets(h.db.connection);
    const routes = targets.forWork(f.workId, LOCAL_USER_ID);
    assert.equal(routes.length, 1);
    const route = routes[0]!;
    assert.equal(route.sourceMessageId, h.works.getWork(f.workId)!.sourceMessageId);
    const duplicate = targets.record({ ...route, createdAt: Date.now() });
    assert.equal(duplicate.targetKey, route.targetKey);
    assert.throws(() => targets.record({ ...route, target: { ...route.target, senderId: "other-user" }, createdAt: Date.now() }), /来源|目标|身份|不可/);
    assert.equal(targets.forWork(f.workId, "foreign-user").length, 0);
    const unrelated = unwrap(h.works.createWork(user, { operationId: "unrelated", title: "No exact source", conversationId: route.conversationId,
      sourceMessageId: "different-native-input", authorization: grants, criteria: [] }));
    unwrap(h.works.closeWork(user, { operationId: "unrelated:close", workId: unrelated.workId, conclusion: "cancelled", closureSummary: "No route" }));
    h.bridge.materialize();
    assert.equal(h.works.repo.listNotifications(unrelated.workId).filter(item => item.channel?.startsWith("gateway:")).length, 0);
    const count = h.works.cards.list(h.works.getWork(f.workId)!).length;
    assert.equal(h.bridge.materialize(), 0);
    assert.equal(h.works.cards.list(h.works.getWork(f.workId)!).length, count);
    assert.equal(f.channel.deliveryGuarantee, "best-effort-unqueryable");
    assert.equal(f.channel.supportsIdempotencyKey, false);
    assert.equal(f.channel.supportsReceiptQuery, false);
  });
  await check("accepted result clone keeps its card and awaits the actual HTTP receipt", async () => {
    const f = await accepted(h, "await");
    const held = deferred<Response>();
    respond = request => isWorkPost(request) ? held.promise : success(request);
    const before = workPosts().length;
    const sending = h.works.notifications.deliverAsync(f.channel, f.workId);
    await until(() => workPosts().length === before + 1);
    assert.equal(h.works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
    assert.equal(h.works.repo.getNotification(f.notification.notificationId)!.externalReceipt, undefined);
    const secondDb = new AppDatabase(h.path);
    try {
      const secondWorks = new WorkService(secondDb.connection, { bots: new BotRegistry(secondDb.connection) });
      const secondBridge = new WorkGatewayNotificationChannels(secondDb.connection, secondWorks, h.gateway, { isAuthority: () => true });
      const secondChannel = secondBridge.channels().find(item => item.targetKey === f.notification.targetKey)!;
      await secondWorks.notifications.deliverAsync(secondChannel, f.workId);
      assert.equal(workPosts().length, before + 1, "a different connection cannot claim a second best-effort send");
    } finally { secondDb.close(); }
    held.resolve(success(workPosts().at(-1)!, "awaited-receipt"));
    await sending;
    const saved = h.works.repo.getNotification(f.notification.notificationId)!;
    assert.equal(saved.delivery, "sent");
    assert.equal(saved.externalReceipt, "feishu:awaited-receipt");
    assert.equal(saved.cardKey, f.notification.cardKey);
    assert.equal(h.works.notifications.attempts(saved.notificationId).length, 1);
  });
  await check("HTTP success with a provider error fails, and a malformed success remains unknown", async () => {
    const rejected = await accepted(h, "provider-reject");
    respond = request => isWorkPost(request) ? json({ code: 230002, msg: "rejected" }) : success(request);
    await h.works.notifications.deliverAsync(rejected.channel, rejected.workId);
    assert.equal(h.works.repo.getNotification(rejected.notification.notificationId)!.delivery, "failed");
    respond = undefined;
    const malformed = await accepted(h, "provider-malformed");
    respond = request => isWorkPost(request) ? json({ code: 0, data: {} }) : success(request);
    await h.works.notifications.deliverAsync(malformed.channel, malformed.workId);
    assert.equal(h.works.repo.getNotification(malformed.notification.notificationId)!.delivery, "unknown");
    const count = workPosts().length;
    await h.works.notifications.deliverAsync(malformed.channel, malformed.workId);
    assert.equal(workPosts().length, count, "unknown is never blindly retried");
  });
  await check("offline, changed account, allowlist and disabled owner block before any physical claim", async () => {
    const f = await accepted(h, "authorization");
    const before = workPosts().length;
    await h.gateway.disconnect("feishu-default");
    let result = await h.works.notifications.deliverAsync(f.channel, f.workId);
    assert.match(result[0]!.blockedReason!, /连接|停用/);
    await h.gateway.connect("feishu-default", { ...config, appId: "another-app" });
    result = await h.works.notifications.deliverAsync(f.channel, f.workId);
    assert.match(result[0]!.blockedReason!, /账号/);
    await h.gateway.connect("feishu-default", { ...config, allowUsers: ["different-user"] });
    result = await h.works.notifications.deliverAsync(f.channel, f.workId);
    assert.match(result[0]!.blockedReason!, /允许名单/);
    await h.gateway.connect("feishu-default", config);
    h.db.connection.prepare("UPDATE bots SET status='paused' WHERE bot_id=?").run(DEFAULT_BOT_ID);
    result = await h.works.notifications.deliverAsync(f.channel, f.workId);
    assert.match(result[0]!.blockedReason!, /Bot/);
    h.db.connection.prepare("UPDATE bots SET status='active' WHERE bot_id=?").run(DEFAULT_BOT_ID);
    assert.equal(workPosts().length, before);
    assert.equal(h.works.notifications.attempts(f.notification.notificationId).length, 0);
    await h.works.notifications.deliverAsync(f.channel, f.workId);
    assert.equal(h.works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
  });
  await check("a source target never receives another chat's Work", async () => {
    const first = await accepted(h, "chat-one", "room-1");
    const second = await accepted(h, "chat-two", "room-2");
    const before = workPosts().length;
    await h.works.notifications.deliverAsync(first.channel, second.workId);
    assert.equal(workPosts().length, before);
    await h.works.notifications.deliverAsync(first.channel, first.workId);
    await h.works.notifications.deliverAsync(second.channel, second.workId);
    assert.deepEqual([first.input.event.message.chat_id, second.input.event.message.chat_id], ["room-1", "room-2"]);
    assert.deepEqual(workPosts().slice(before).map(item => decodeURIComponent(item.url.pathname)),
      [first, second].map(source => `/open-apis/im/v1/messages/${source.input.event.message.message_id}/reply`));
    assert.ok(workPosts().slice(before).every(item => item.body.reply_in_thread === false));
  });
  await check("manual resend needs current version and duplicate-risk acknowledgement; late old receipts stay fenced", async () => {
    const f = await accepted(h, "late-receipt");
    const held = deferred<Response>();
    let firstRequest: Request | undefined;
    respond = request => {
      if (isWorkPost(request) && !firstRequest) { firstRequest = request; return held.promise; }
      return success(request, "new-manual-receipt");
    };
    const firstSend = h.works.notifications.deliverAsync(f.channel, f.workId);
    await until(() => !!firstRequest);
    const current = h.works.getWork(f.workId)!;
    const request = { operationId: "manual:" + serial, workId: f.workId, notificationId: f.notification.notificationId,
      reason: "Reviewed unknown delivery", acknowledgedDuplicateRisk: true, versionGuard: guard(current) };
    assert.equal(h.works.resendWorkNotification(user, { ...request, acknowledgedDuplicateRisk: false }).ok, false);
    assert.equal(h.works.resendWorkNotification(user, { ...request, versionGuard: { ...guard(current), expectedStateVersion: 0 } }).ok, false);
    unwrap(h.works.resendWorkNotification(user, request));
    const secondDb = new AppDatabase(h.path);
    try {
      const secondWorks = new WorkService(secondDb.connection, { bots: new BotRegistry(secondDb.connection) });
      const secondBridge = new WorkGatewayNotificationChannels(secondDb.connection, secondWorks, h.gateway, { isAuthority: () => true });
      await secondWorks.notifications.deliverAsync(secondBridge.channels().find(item => item.targetKey === f.notification.targetKey)!, f.workId);
    } finally { secondDb.close(); }
    assert.equal(h.works.repo.getNotification(f.notification.notificationId)!.externalReceipt, "feishu:new-manual-receipt");
    held.resolve(success(firstRequest!, "old-late-receipt")); await firstSend;
    assert.equal(h.works.repo.getNotification(f.notification.notificationId)!.externalReceipt, "feishu:new-manual-receipt");
    const attempts = h.works.notifications.attempts(f.notification.notificationId);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]!.providerEffectKey, attempts[1]!.providerEffectKey);
    assert.equal((h.db.connection.prepare("SELECT authorization_kind FROM work_notification_effects WHERE effect_key=?")
      .get(attempts[1]!.providerEffectKey) as { authorization_kind: string }).authorization_kind, "manual-resend");
  });
  await check("lost provider response survives actual close/reopen without rerun or resend", async () => {
    const before = h.state.executions;
    const original = harness(); await original.gateway.connect("feishu-default", config);
    const f = await accepted(original, "restart");
    respond = request => { if (isWorkPost(request)) throw new Error("response lost after provider effect"); return success(request); };
    await original.works.notifications.deliverAsync(f.channel, f.workId);
    assert.equal(original.works.repo.getNotification(f.notification.notificationId)!.delivery, "unknown");
    const count = workPosts().length;
    await original.close(); respond = undefined;
    const reopened = harness(original.path); await reopened.gateway.restoreChannels();
    const endpoint = reopened.bridge.channels().find(item => item.targetKey === f.notification.targetKey)!;
    await reopened.works.notifications.deliverAsync(endpoint, f.workId);
    assert.equal(workPosts().length, count);
    assert.equal(reopened.state.executions, 0);
    assert.equal(h.state.executions, before);
    unwrap(reopened.works.resendWorkNotification(user, { operationId: "restart-manual", workId: f.workId,
      notificationId: f.notification.notificationId, acknowledgedDuplicateRisk: true, reason: "Confirmed risk after reopen",
      versionGuard: guard(reopened.works.getWork(f.workId)!) }));
    await reopened.works.notifications.deliverAsync(endpoint, f.workId);
    assert.equal(workPosts().length, count + 1);
    assert.equal(reopened.works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
    assert.equal(reopened.works.notifications.attempts(f.notification.notificationId)[0]!.status, "unknown");
    await reopened.close();
  });
  await check("a token refresh wait rechecks Work validity before issuing the provider POST", async () => {
    const f = await accepted(h, "stale-during-refresh");
    const held = deferred<Response>(); let refreshing = false;
    refresh = () => { refreshing = true; return held.promise; };
    (h.feishu as unknown as { tokenExpireAt: number }).tokenExpireAt = 0;
    const before = workPosts().length;
    const sending = h.works.notifications.deliverAsync(f.channel, f.workId);
    await until(() => refreshing);
    unwrap(h.works.closeWork(user, { operationId: "cancel-before-http", workId: f.workId, conclusion: "cancelled", closureSummary: "Cancelled during auth refresh" }));
    held.resolve(json({ code: 0, tenant_access_token: "new-token", expire: 7200 }));
    await sending;
    assert.equal(workPosts().length, before);
    assert.notEqual(h.works.repo.getNotification(f.notification.notificationId)!.delivery, "sent");
    assert.equal(h.works.notifications.identity(f.notification.notificationId)!.semanticValidity, "cancelled");
  });
  await check("async host preserves wakes during I/O and aborts before shutdown settlement", async () => {
    const local = harness(); await local.gateway.connect("feishu-default", config);
    const first = await accepted(local, "host-first");
    const held = deferred<Response>(); let request: Request | undefined;
    respond = incoming => { if (isWorkPost(incoming) && !request) { request = incoming; return held.promise; } return success(incoming); };
    const errors: unknown[] = [];
    local.state.host = new WorkNotificationHost(local.works, { isAuthority: () => local.state.authority, channels: () => [],
      asyncChannels: () => local.bridge.channels(), intervalMs: 60_000, onError: error => errors.push(error) });
    local.gateway.setWorkNotificationWake(() => local.state.host?.wake());
    local.state.host.start(); await until(() => !!request);
    const second = await accepted(local, "host-second", "host-room-2");
    local.state.host.wake(); held.resolve(success(request!));
    await until(() => local.works.repo.getNotification(second.notification.notificationId)!.delivery === "sent");
    assert.equal(local.works.repo.getNotification(first.notification.notificationId)!.delivery, "sent");
    assert.deepEqual(errors, []);
    const third = await accepted(local, "host-stop", "host-room-3");
    let pending = false;
    respond = incoming => {
      if (!isWorkPost(incoming)) return success(incoming);
      pending = true;
      return new Promise<Response>((_resolve, reject) => { incoming.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    };
    local.state.host.wake(); await until(() => pending);
    await local.state.host.close();
    assert.equal(local.works.repo.getNotification(third.notification.notificationId)!.delivery, "unknown");
    await local.close();
  });
  await check("summary deadline is honored independently of the much longer periodic interval", async () => {
    const deadline = Date.now() + 35; let flushed = false;
    const host = new WorkNotificationHost({ deliverPendingNotifications: () => [], phase5: {
      flushOwnerSummaries: () => { if (Date.now() >= deadline) flushed = true; return 0; },
      nextOwnerSummaryDeadline: () => flushed ? undefined : deadline,
    } as WorkService["phase5"] }, { isAuthority: () => true, channels: () => [], intervalMs: 60_000 });
    host.start(); await until(() => flushed); await host.close();
    assert(Date.now() - deadline < 1000);
  });
  await check("WeCom, WeChat, Telegram and Slack await their actual provider contract and exact destination", async () => {
    const wecom = new WecomChannelAdapter("wecom-fixture", "WeCom");
    const wechat = new WechatMpChannelAdapter("wechat-fixture", "WeChat");
    const telegram = new TelegramChannelAdapter("telegram-fixture", "Telegram");
    const journal = new SlackGatewayJournal(() => join(root, "slack-journal.json"));
    const slack = new SlackSocketModeAdapter("slack-fixture", "Slack", { journal, fetch: globalThis.fetch,
      socketFactory: () => { const socket = new FixtureSocket(); setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: "hello", connection_info: { app_id: "ATEST" } }) }), 0); return socket; } });
    try {
      await wecom.connect({ corpId: "corp", agentId: "7", secret: "fixture", token: "verify", encodingAESKey: "a".repeat(43) });
      await wechat.connect({ appId: "wx-app", appSecret: "fixture", token: "verify", encodingAESKey: "a".repeat(43) });
      await telegram.connect({ botToken: "9001:fixture" });
      await slack.connect({ teamId: "TTEST", appId: "ATEST", botToken: "xoxb-fixture", appToken: "xapp-fixture", allowUsers: ["UUSER"] });
      slack.activate();
      const targets: Array<{ adapter: typeof wecom | typeof wechat | typeof telegram | typeof slack; target: GatewayWorkTarget }> = [
        { adapter: wecom, target: { version: 1, channelId: wecom.id, channelType: "wecom", connectionKey: wecom.workConnectionKey()!, chatId: "room-a", senderId: "member-a", address: { chatId: "room-a", userId: "member-a" } } },
        { adapter: wechat, target: { version: 1, channelId: wechat.id, channelType: "wechat", connectionKey: wechat.workConnectionKey()!, chatId: "openid-a", senderId: "openid-a", address: { openId: "openid-a" } } },
        { adapter: telegram, target: { version: 1, channelId: telegram.id, channelType: "telegram", connectionKey: telegram.workConnectionKey()!, chatId: "-100123", senderId: "8", address: { chatId: "-100123", messageThreadId: 42, directMessagesTopicId: 9 } } },
        { adapter: slack, target: { version: 1, channelId: slack.id, channelType: "slack", connectionKey: slack.workConnectionKey()!, chatId: "TTEST:CTEST:1700000000.000001", senderId: "UUSER", address: { teamId: "TTEST", appId: "ATEST", channel: "CTEST", threadTs: "1700000000.000001" } } },
      ];
      const start = posts.length;
      for (const { adapter, target } of targets) {
        gatewayWorkTargetSchema.parse(target);
        const input: GatewayWorkSendInput = { target, text: "protocol-test", effectKey: "effect:protocol", assertCurrent: () => {} };
        const result = await adapter.sendWorkNotification(input); assert.equal(result.ok, true);
        const count = posts.length;
        await assert.rejects(adapter.sendWorkNotification({ ...input, target: { ...target, connectionKey: "0".repeat(64) } }));
        assert.equal(posts.length, count);
      }
      const sent = posts.slice(start);
      assert.equal(sent.length, 4);
      assert.equal(sent[0]!.url.pathname, "/cgi-bin/appchat/send"); assert.equal(sent[0]!.body.chatid, "room-a");
      assert.equal(sent[1]!.body.touser, "openid-a");
      assert.equal(sent[2]!.body.chat_id, "-100123"); assert.equal(sent[2]!.body.message_thread_id, 42); assert.equal(sent[2]!.body.direct_messages_topic_id, 9);
      assert.equal(sent[3]!.body.channel, "CTEST"); assert.equal(sent[3]!.body.thread_ts, "1700000000.000001"); assert.equal(sent[3]!.body.reply_broadcast, false);
      assert.equal(journal.list().length, 0, "Work delivery does not create a parallel Slack reply ledger");
      respond = () => json({ ok: false, error: "missing_scope" });
      const denied = await slack.sendWorkNotification({ target: targets[3]!.target, text: "protocol-test", effectKey: "denied", assertCurrent: () => {} });
      assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.responseLost, false);
      respond = () => json({ ok: true, result: { message_id: 19, chat: { id: 123 }, message_thread_id: 42 } });
      const wrongChat = await telegram.sendWorkNotification({ target: targets[2]!.target, text: "protocol-test", effectKey: "wrongchat", assertCurrent: () => {} });
      assert.equal(wrongChat.ok, false); assert.equal(!wrongChat.ok && wrongChat.responseLost, true);
    } finally { await slack.disconnect(); await telegram.disconnect(); await wechat.disconnect(); await wecom.disconnect(); }
  });
  await check("blocked explanation remains readable while attachment state uses frozen files", () => {
    const question = "已附草稿。请确认目标读者是工程师还是管理者？";
    const empty = workGatewayText({ title: "等待补充", kind: "blocked", body: question, deliveryFiles: [] });
    assert(empty.includes("本次通知没有附件。"));
    assert(empty.includes("执行方说明（不代表渠道投递回执）：\n> " + question));
    const attached = workGatewayText({ title: "等待补充", kind: "blocked", body: "原用户待补充要求：我稍后补充目标读者", deliveryFiles: [
      {name:"draft.txt",sha256:"a".repeat(64),bytes:0,base64:""},
    ] });
    assert(attached.includes("本次请求包含文件：draft.txt"));
    assert(attached.includes("文件送达以渠道实际附件和回执为准"));
    assert(attached.includes("> 原用户待补充要求：我稍后补充目标读者"));
    assert(!attached.includes("本次通知没有附件"));
  });
  await check("one bounded UTF-8 provider request preserves a complete result-card pointer", () => {
    const text = workGatewayText({ title: "成果".repeat(500), body: "🚀".repeat(5000) });
    assert(Buffer.byteLength(text, "utf8") <= 1800);
    assert(text.endsWith("完整成果、待决事项和验证范围请在 MyBuddy 结果卡中查看。"));
    assert(!text.includes("\ufffd"));
  });
  console.log(`\n${passed} passed / 0 failed — Phase 5 Gateway production adapters, async claim and recovery`);
} finally {
  respond = undefined; refresh = undefined;
  for (const item of harnesses.reverse()) await item.close();
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
