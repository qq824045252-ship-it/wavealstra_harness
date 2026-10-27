import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { SlackSocketModeAdapter, redactSlackText, safeSlackError, splitSlackReply, type SlackSocket } from "../src/main/gateway/SlackSocketModeAdapter";
import { SlackGatewayJournal, slackTaskId, type SlackDelivery } from "../src/main/gateway/SlackGatewayJournal";
import { runGatewayAgentTurn, withSlackChannelHistory, type GatewayAgentPort } from "../src/main/gateway/GatewayAgentTurn";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { sealSlackGatewayConfig, openSlackGatewayConfig, slackGatewayConfigView } from "../src/main/gateway/SlackGatewayCredentials";
import { setEncryptionAvailable } from "./gateway-electron-stub";
import type { AgentPromptRequest } from "../src/shared/agent-ipc";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai/compat";

const root = mkdtempSync(join(tmpdir(), "mybuddy-slack-test-"));
const config = { teamId: "T0C5V7WTE8P", appId: "A0C6PPDAB1S", allowUsers: ["U0C750DCY4Q"],
  botToken: "xoxb-local-fixture-only", appToken: "xapp-local-fixture-only" };
const adapters: SlackSocketModeAdapter[] = [];
let passed = 0;
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// 5s 是本地机器上的经验值；CI runner 只有 2-4 vCPU 且同时跑多个套件，
// 回调链会慢好几倍（曾因 "Timed out: native write result returned" 误报失败）。
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Timed out: " + label); await wait(5); }
}
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  await run(); passed++; console.log("PASS " + name);
}
class FakeSocket implements SlackSocket {
  onmessage: SlackSocket["onmessage"] = null;
  onclose: SlackSocket["onclose"] = null;
  onerror: SlackSocket["onerror"] = null;
  sent: Array<{ envelope_id: string }> = [];
  closed = false;
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(): void { if (!this.closed) { this.closed = true; this.onclose?.(); } }
  emit(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
function event(id: string, ts = "1700000000.000001", overrides: Record<string, unknown> = {}): Record<string, any> {
  return { type: "events_api", envelope_id: "envelope-" + id, payload: {
    type: "event_callback", api_app_id: config.appId, team_id: config.teamId, event_id: id,
    event: { type: "message", channel_type: "im", channel: "D01234567", user: config.allowUsers[0], ts, text: "local fixture task", ...overrides },
  } };
}
function fixture(name: string, options: { journalPath?: string; helloAppId?: string; auth?: Record<string, unknown>; deferInbound?: boolean; history?: Record<string, unknown>; blockHistory?: Promise<void> } = {}) {
  const sockets: FakeSocket[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const historyRequests: Array<{ channel: string | null; latest: string | null; inclusive: string | null; limit: string | null }> = [];
  const historyReports: unknown[] = [];
  const journal = new SlackGatewayJournal(() => options.journalPath ?? join(root, name + ".json"));
  const state = { failPosts: 0, apiCalls: 0 };
  const adapter = new SlackSocketModeAdapter("slack-default", "Slack", {
    journal, reconnectDelayMs: 5, replyRetryDelayMs: 5, helloTimeoutMs: 300,
    deferInboundUntilActivated: options.deferInbound,
    onHistoryRead: value => { historyReports.push(value); },
    socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket);
      setTimeout(() => socket.emit({ type: "hello", connection_info: { app_id: options.helloAppId ?? config.appId } }), 0);
      return socket;
    },
    fetch: (async (url, init) => {
      state.apiCalls++;
      const requestUrl = new URL(String(url));
      const method = requestUrl.pathname.split("/").at(-1);
      if (method === "auth.test") return new Response(JSON.stringify({ ok: true, bot_id: "B01234567", user_id: "U012BOT", team_id: config.teamId, ...options.auth }));
      if (method === "apps.connections.open") return new Response(JSON.stringify({ ok: true, url: "wss://wss.slack.com/link/?ticket=local-fixture" }));
      if (method === "conversations.history") {
        assert.equal(init?.method, "GET");
        historyRequests.push({ channel: requestUrl.searchParams.get("channel"), latest: requestUrl.searchParams.get("latest"), inclusive: requestUrl.searchParams.get("inclusive"), limit: requestUrl.searchParams.get("limit") });
        if (options.blockHistory) await options.blockHistory;
        return new Response(JSON.stringify(options.history ?? { ok: true, messages: [], has_more: false }));
      }
      assert.equal(method, "chat.postMessage");
      posts.push(JSON.parse(String(init?.body)));
      if (state.failPosts > 0) { state.failPosts--; return new Response("{}", { status: 503 }); }
      return new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }));
    }) as typeof fetch,
  });
  adapters.push(adapter);
  return { adapter, sockets, posts, journal, state, historyRequests, historyReports };
}
const delivery = (eventId: string, state: SlackDelivery["state"]): SlackDelivery => ({
  eventId, state, appId: config.appId, teamId: config.teamId, channel: "D01234567",
  threadTs: "1700000000.000001", userId: config.allowUsers[0], text: "fixture task", acceptedAt: Date.now(),
});

try {
  await check("fail closed on empty allowlist; no network", async () => {
    const f = fixture("scope");
    await assert.rejects(f.adapter.connect({ ...config, allowUsers: [] }), /允许用户不能为空/);
    assert.equal(f.state.apiCalls, 0);
  });
  await check("reject user token, wrong Bot workspace and wrong App Token binding", async () => {
    const f = fixture("identity");
    await assert.rejects(f.adapter.connect({ ...config, botToken: "xoxp-local-fixture-only" }), /MCP 用户 OAuth/);
    const wrongTeam = fixture("wrong-team", { auth: { team_id: "TOTHER" } });
    await assert.rejects(wrongTeam.adapter.connect(config), /安装工作区/);
    assert.equal(wrongTeam.sockets.length, 0);
    const wrongApp = fixture("wrong-app", { helloAppId: "AOTHER" });
    await assert.rejects(wrongApp.adapter.connect(config), /App ID 不一致/);
  });
  await check("ACK precedes task completion; duplicate event executes once", async () => {
    const f = fixture("ack");
    let calls = 0; let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    f.adapter.setInboundHandler(async message => { calls++; await blocked; await message.reply("completed"); });
    await f.adapter.connect(config);
    const frame = event("EvACK"); const socket = f.sockets.at(-1)!;
    socket.emit(frame);
    assert.equal(socket.sent.length, 1);
    assert.equal(calls, 0, "ACK must not wait for the task promise");
    socket.emit({ ...frame, envelope_id: "retry-envelope" });
    assert.equal(socket.sent.length, 2);
    await until(() => calls === 1, "one native task begins");
    assert.equal(f.posts.length, 0);
    finish();
    await until(() => f.journal.list()[0].state === "replied", "reply persisted");
    assert.equal(calls, 1);
    assert.equal(f.posts[0].thread_ts, frame.payload.event.ts);
    assert.equal(f.posts[0].channel, frame.payload.event.channel);
    await f.adapter.disconnect();
  });
  await check("reject foreign workspace/app/user, non-DM, bot loops and edited messages", async () => {
    const f = fixture("filters"); let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("unexpected"); });
    await f.adapter.connect(config);
    const frames = [
      event("EvBOT", undefined, { bot_id: "B123" }), event("EvSELF", undefined, { user: "U012BOT" }),
      event("EvEDIT", undefined, { subtype: "message_changed" }), event("EvUSER", undefined, { user: "UOTHER" }),
      event("EvCHANNEL", undefined, { channel_type: "channel", channel: "C01234567" }),
      event("EvTEAM"), event("EvAPP"),
    ];
    frames[5].payload.team_id = "TOTHER"; frames[6].payload.api_app_id = "AOTHER";
    for (const frame of frames) f.sockets.at(-1)!.emit(frame);
    await wait(10);
    assert.equal(calls, 0); assert.equal(f.journal.list().length, 0);
    assert.equal(f.sockets.at(-1)!.sent.length, frames.length);
    await f.adapter.disconnect();
  });
  await check("owner app mentions work across public/private channels; strip only this bot and dedupe", async () => {
    const f = fixture("mentions"); const received: Array<{ taskId?: string; text: string }> = [];
    f.adapter.setInboundHandler(async message => { received.push({ taskId: message.taskId, text: message.text }); await message.reply("mention reply"); });
    await f.adapter.connect(config);
    const first = event("EvMENTION", undefined, { type: "app_mention", channel_type: undefined, channel: "CANYCHANNEL", text: "<@U012BOT> do a task with <@UOTHER> <@U012BOT>" });
    f.sockets[0].emit(first); f.sockets[0].emit({ ...first, envelope_id: "mention-retry" });
    await until(() => f.posts.length === 1, "channel mention reply");
    assert.equal(received.length, 1); assert.equal(received[0].text, "do a task with <@UOTHER>");
    assert.equal(f.posts[0].channel, "CANYCHANNEL"); assert.equal(f.posts[0].thread_ts, first.payload.event.ts);
    f.sockets[0].emit(event("EvPRIVATE", "1700000001.000001", { type: "app_mention", channel_type: undefined, channel: "GANYPRIVATE", text: "<@U012BOT> private task" }));
    await until(() => f.posts.length === 2, "private channel mention reply");
    assert.equal(f.posts[1].channel, "GANYPRIVATE"); assert.equal(received[1].text, "private task");
    await f.adapter.disconnect();
  });
  await check("mention ACK precedes bounded Bot history read; history stays in the mentioned channel and before the instruction", async () => {
    let release!: () => void;
    const blockHistory = new Promise<void>(resolve => { release = resolve; });
    const f = fixture("history-context", { blockHistory, history: { ok: true, has_more: true, messages: [
      { ts: "1700000009.000001", user: "UOTHER", text: "newer channel material" },
      { ts: "1700000008.000001", user: "UOTHER", text: "older channel material " + config.botToken },
      { ts: "1700000010.000001", text: "current mention must be excluded" },
      { ts: "1700000011.000001", text: "future message must be excluded" },
    ] } });
    const received: any[] = [];
    f.adapter.setInboundHandler(async msg => { received.push(msg); await msg.reply("history read reply"); });
    await f.adapter.connect(config);
    f.sockets[0].emit(event("EvHISTORY", "1700000010.000001", { type: "app_mention", channel_type: undefined,
      channel: "CHISTORY", thread_ts: "1700000000.000001", text: "<@U012BOT> 总结下内容" }));
    assert.equal(f.sockets[0].sent.length, 1);
    await until(() => f.historyRequests.length === 1, "history request starts after ACK");
    assert.equal(received.length, 0);
    assert.deepEqual(f.historyRequests[0], { channel: "CHISTORY", latest: "1700000010.000001", inclusive: "false", limit: "15" });
    release();
    await until(() => f.posts.length === 1, "native handoff after history");
    assert.equal(received[0].text, "总结下内容");
    assert.equal(received[0].slackHistory.status, "loaded");
    assert.equal(received[0].slackHistory.messages.length, 2);
    assert.equal(received[0].slackHistory.messages[0].ts, "1700000008.000001");
    assert(!JSON.stringify(received[0].slackHistory).includes(config.botToken));
    const prompt = withSlackChannelHistory(received[0].text, received[0].slackHistory);
    assert(prompt.includes("older channel material") && prompt.includes("newer channel material"));
    assert(prompt.includes("仅是参考资料") && prompt.endsWith("总结下内容"));
    assert(!prompt.includes("future message") && !prompt.includes("current mention"));
    assert.equal(f.posts[0].channel, "CHISTORY"); assert.equal(f.posts[0].thread_ts, "1700000000.000001");
    assert(!JSON.stringify(f.historyReports).includes("channel material"));
    await f.adapter.disconnect();
  });
  await check("missing history scope is explicit metadata; DM keeps its existing input and performs no history fetch", async () => {
    const f = fixture("history-no-scope", { history: { ok: false, error: "missing_scope", needed: "channels:history" } });
    const received: any[] = [];
    f.adapter.setInboundHandler(async msg => { received.push(msg); await msg.reply("scope failure handled"); });
    await f.adapter.connect(config);
    f.sockets[0].emit(event("EvNOSCOPE", undefined, { type: "app_mention", channel_type: undefined, channel: "CNOSCOPE", text: "<@U012BOT> 总结下内容" }));
    await until(() => received.length === 1, "scope metadata handed off");
    assert.equal(received[0].slackHistory.status, "unavailable");
    assert.equal(received[0].slackHistory.errorCode, "missing_scope");
    assert.deepEqual(received[0].slackHistory.requiredScopes, ["channels:history"]);
    assert.deepEqual(received[0].slackHistory.messages, []);
    f.sockets[0].emit(event("EvDMSAME", "1700000012.000001", { text: "DM original instruction" }));
    await until(() => received.length === 2, "DM still works");
    assert.equal(received[1].slackHistory, undefined);
    assert.equal(withSlackChannelHistory(received[1].text), "DM original instruction");
    assert.equal(f.historyRequests.length, 1);
    await f.adapter.disconnect();
  });
  await check("disconnect during history fetch leaves delivery pending and never executes the native task", async () => {
    let release!: () => void;
    const blockHistory = new Promise<void>(resolve => { release = resolve; });
    const f = fixture("history-disconnect", { blockHistory }); let calls = 0;
    f.adapter.setInboundHandler(async () => { calls++; });
    await f.adapter.connect(config);
    f.sockets[0].emit(event("EvHCANCEL", undefined, { type: "app_mention", channel_type: undefined, channel: "CCANCEL", text: "<@U012BOT> summarize" }));
    await until(() => f.historyRequests.length === 1, "history read starts");
    await f.adapter.disconnect(); release(); await wait(10);
    assert.equal(calls, 0); assert.equal(f.journal.list()[0].state, "pending");
  });
  await check("mention threads reuse native task; different channels and DM remain isolated", async () => {
    const f = fixture("mention-thread"); const ids: string[] = [];
    f.adapter.setInboundHandler(async message => { ids.push(message.taskId!); await message.reply("thread answer"); });
    await f.adapter.connect(config);
    const mention = { type: "app_mention", channel_type: undefined, channel: "CONE", text: "<@U012BOT> task" };
    f.sockets[0].emit(event("EvMROOT", "1700000000.000001", mention));
    f.sockets[0].emit(event("EvMFOLLOW", "1700000001.000001", { ...mention, thread_ts: "1700000000.000001" }));
    f.sockets[0].emit(event("EvMOTHERCHANNEL", "1700000000.000001", { ...mention, channel: "CTWO" }));
    f.sockets[0].emit(event("EvMOTHERTHREAD", "1700000002.000001", mention));
    f.sockets[0].emit(event("EvMDM", "1700000000.000001"));
    await until(() => f.posts.length === 5, "isolated native task replies");
    const journal = f.journal.list();
    const getTask = (id: string): string => slackTaskId(journal.find(d => d.eventId === id)!);
    assert.equal(getTask("EvMROOT"), getTask("EvMFOLLOW"));
    for (const id of ["EvMOTHERCHANNEL", "EvMOTHERTHREAD", "EvMDM"]) assert.notEqual(getTask("EvMROOT"), getTask(id));
    assert.equal(f.posts.filter(p => p.channel === "CONE" && p.thread_ts === "1700000000.000001").length, 2);
    await f.adapter.disconnect();
  });
  await check("only owner can trigger app mentions; ordinary messages, bare pings and foreign events are ignored", async () => {
    const f = fixture("mention-filters"); let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("unexpected"); });
    await f.adapter.connect({ ...config, allowUsers: [...config.allowUsers, "UOTHER"] });
    const mention = { type: "app_mention", channel_type: undefined, channel: "CANY", text: "<@U012BOT> task" };
    const frames = [
      event("EvMOTHERUSER", undefined, { ...mention, user: "UOTHER" }),
      event("EvMBOT", undefined, { ...mention, bot_id: "BOTHER" }),
      event("EvMSELF", undefined, { ...mention, user: "U012BOT" }),
      event("EvMEDIT", undefined, { ...mention, subtype: "message_changed" }),
      event("EvMEMPTY", undefined, { ...mention, text: "<@U012BOT>  " }),
      event("EvMWRONGBOT", undefined, { ...mention, text: "<@UOLDBOT> task" }),
      event("EvMORDINARY", undefined, { ...mention, type: "message", channel_type: "channel" }),
      event("EvMWRONGCHANNEL", undefined, { ...mention, channel: "D01234567" }),
      event("EvMTEAM", undefined, mention), event("EvMAPP", undefined, mention),
    ];
    frames[8].payload.team_id = "TOTHER"; frames[9].payload.api_app_id = "AOTHER";
    for (const frame of frames) f.sockets[0].emit(frame);
    await wait(15); assert.equal(calls, 0); assert.equal(f.journal.list().length, 0);
    assert.equal(f.sockets[0].sent.length, frames.length);
    await f.adapter.disconnect();
  });
  await check("channel mentions follow the configured allowlist instead of a previous owner id", async () => {
    const f = fixture("configured-owner"); const received: string[] = [];
    f.adapter.setInboundHandler(async message => { received.push(message.text); await message.reply("ok"); });
    await f.adapter.connect({ ...config, allowUsers: ["U0C8F24C8Q4"] });
    const mention = { type: "app_mention", channel_type: undefined, channel: "CCHANNEL", text: "<@U012BOT> 帮我看看有什么更新" };
    f.sockets[0].emit(event("EvCONFIGURED", "1700000003.000001", { ...mention, user: "U0C8F24C8Q4" }));
    f.sockets[0].emit(event("EvPREVIOUS", "1700000004.000001", { ...mention, user: "U0C750DCY4Q" }));
    await until(() => f.posts.length === 1, "configured owner mention replies");
    assert.deepEqual(received, ["帮我看看有什么更新"]);
    await wait(15);
    assert.equal(f.posts.length, 1);
    await f.adapter.disconnect();
  });
  await check("same thread serializes and reuses task; independent threads remain independent", async () => {
    const f = fixture("ordering"); const tasks: string[] = [];
    let finish!: () => void; const blocked = new Promise<void>(resolve => { finish = resolve; });
    f.adapter.setInboundHandler(async message => {
      tasks.push(message.taskId!);
      if (message.messageId === "EvFIRST") await blocked;
      await message.reply("completed");
    });
    await f.adapter.connect(config);
    f.sockets[0].emit(event("EvFIRST"));
    f.sockets[0].emit(event("EvNEXT", "1700000000.000002", { thread_ts: "1700000000.000001" }));
    f.sockets[0].emit(event("EvOTHER", "1700000002.000001"));
    await until(() => tasks.length === 2, "independent thread runs");
    assert.notEqual(tasks[0], tasks[1]);
    finish();
    await until(() => tasks.length === 3 && f.journal.list().every(item => item.state === "replied"), "same-thread next turn");
    assert.equal(tasks[0], tasks[2]);
    await f.adapter.disconnect();
  });
  await check("reply retries outbox only, with stable message identity", async () => {
    const f = fixture("outbox"); f.state.failPosts = 1; let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("original answer"); });
    await f.adapter.connect(config); f.sockets[0].emit(event("EvRETRY"));
    await until(() => f.journal.list()[0]?.state === "replied", "retry succeeds");
    assert.equal(calls, 1); assert.equal(f.posts.length, 2);
    assert.equal(f.posts[0].client_msg_id, f.posts[1].client_msg_id);
    assert.equal(f.posts[1].text, "original answer");
    await f.adapter.disconnect();
  });
  await check("socket reconnect preserves dedupe receipts", async () => {
    const f = fixture("reconnect"); let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("done"); });
    await f.adapter.connect(config); f.sockets[0].emit(event("EvREC"));
    await until(() => f.journal.list()[0]?.state === "replied", "first event completes");
    f.sockets[0].close();
    await until(() => f.sockets.length === 2 && f.adapter.isConnected(), "automatic reconnect");
    f.sockets[1].emit(event("EvREC")); await wait(10); assert.equal(calls, 1);
    await f.adapter.disconnect();
  });
  await check("restart resumes pending/outbox, reports interrupted run without reexecuting it", async () => {
    const file = join(root, "restart.json");
    const seed = new SlackGatewayJournal(() => file);
    seed.accept(delivery("EvPENDING", "pending"));
    seed.accept({ ...delivery("EvOUTBOX", "reply_pending"), replyText: "preserved answer" });
    seed.accept(delivery("EvINTERRUPTED", "running"));
    seed.accept(delivery("EvDONE", "replied"));
    const f = fixture("restart", { journalPath: file }); let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("new answer"); });
    await f.adapter.connect(config);
    await until(() => f.journal.list().every(item => item.state === "replied"), "durable restore");
    assert.equal(calls, 1); assert.equal(f.posts.length, 3);
    assert(f.posts.some(post => post.text === "preserved answer"));
    assert(f.posts.some(post => String(post.text).includes("不会自动重复")));
    await f.adapter.disconnect();
  });
  await check("shutdown preserves a native receipt and restart reacquires its exact input/history", async () => {
    const file = join(root, "native-restart.json");
    const first = fixture("native-restart", { journalPath: file,
      history: { ok: true, messages: [{ ts: "1699999999.000001", user: config.allowUsers[0], text: "persisted context" }] } });
    let rejectWait!: (error: Error) => void;
    let original: any;
    first.adapter.setInboundHandler(async message => {
      original = message;
      await new Promise<void>((_, reject) => { rejectWait = reject; });
    });
    await first.adapter.connect(config);
    first.sockets[0].emit(event("EvNATIVE_RESTART", undefined, { type: "app_mention", channel_type: undefined,
      channel: "C01234567", text: "<@U012BOT> continue after restart" }));
    await until(() => Boolean(original), "native receipt admitted");
    assert.equal(first.journal.list()[0].backend, "pi-durable");
    await first.adapter.disconnect();
    rejectWait(new Error("Harness closed"));
    await wait(10);
    assert.equal(first.journal.list()[0].state, "running");
    assert.equal(first.posts.length, 0);
    const restored = fixture("native-restarted", { journalPath: file });
    let calls = 0;
    restored.adapter.setInboundHandler(async message => {
      calls++;
      assert.equal(message.taskId, original.taskId);
      assert.equal(message.userMessageId, original.userMessageId);
      assert.equal(message.text, original.text);
      assert.deepEqual(message.slackHistory, original.slackHistory);
      await message.reply("native persisted answer");
    });
    await restored.adapter.connect(config);
    await until(() => restored.journal.list()[0].state === "replied", "native answer delivered after restart");
    assert.equal(calls, 1);
    assert.equal(restored.historyRequests.length, 0);
    assert.equal(restored.posts[0].text, "native persisted answer");
    await restored.adapter.disconnect();
  });
  await check("journal commit failure never ACKs or executes", async () => {
    const f = fixture("disk-failure"); let calls = 0;
    f.adapter.setInboundHandler(async () => { calls++; });
    await f.adapter.connect(config);
    f.journal.accept = () => { throw new Error("simulated disk failure"); };
    f.sockets[0].emit(event("EvDISK"));
    await wait(10); assert.equal(f.sockets[0].sent.length, 0); assert.equal(calls, 0);
    await f.adapter.disconnect();
  });
  await check("identity-verified socket ACKs but waits for host configuration commit before execution", async () => {
    const f = fixture("activation", { deferInbound: true }); let calls = 0;
    f.adapter.setInboundHandler(async message => { calls++; await message.reply("committed"); });
    await f.adapter.connect(config); f.sockets[0].emit(event("EvACTIVATE"));
    assert.equal(f.sockets[0].sent.length, 1);
    await wait(10); assert.equal(calls, 0); assert.equal(f.journal.list()[0].state, "pending");
    f.adapter.activate();
    await until(() => f.journal.list()[0].state === "replied", "host releases committed configuration");
    assert.equal(calls, 1); await f.adapter.disconnect();
  });
  await check("Gateway persists encrypted config before activation; disconnect/restore preserve secrets and Pi policy", async () => {
    let stored: any; let connected = false; let activations = 0; let failSave = false;
    const requests: AgentPromptRequest[] = [];
    const db = {
      listGatewayChannels: () => stored ? [stored] : [],
      upsertGatewayChannel: (row: any) => { if (failSave) throw new Error("fixture store failure"); stored = { ...row }; },
      insertGatewayMessage: () => undefined,
      getTask: () => ({ id: "native-task", welcomeMode: "coding", sessionFile: "fixture-session.jsonl" }),
    };
    const agent: GatewayAgentPort = {
      runGatewayTurn: async request => {
        requests.push(request);
        return "native-policy-reply";
      },
    };
    const service = new GatewayService(db as any, agent as any);
    const fakeAdapter = {
      id: "slack-default", type: "slack", name: "Slack",
      connect: async (raw: any) => { assert.equal(raw.botToken, config.botToken); connected = true; },
      disconnect: async () => { connected = false; }, isConnected: () => connected, statusText: () => connected ? "connected" : "disconnected",
      activate: () => { assert(stored?.connected); assert(stored.configJson.includes("encryptedSecrets")); activations++; },
    };
    const internals = service as any;
    internals.slack = fakeAdapter; internals.adapters.set(fakeAdapter.id, fakeAdapter);
    internals.settingsStore = { read: () => ({ permissionMode: "readonly", defaultModelId: "fixture/native-model" }) };
    await service.connect(fakeAdapter.id, config);
    assert.equal(activations, 1); assert.equal(internals.webhookServer, null, "Socket Mode must not open an HTTP listener");
    assert(!stored.configJson.includes(config.botToken));
    const view = service.getChannelConfig(fakeAdapter.id);
    assert.equal(view.config.botToken, "••••••"); assert.equal(view.config.encryptedSecrets, undefined);
    await service.disconnect(fakeAdapter.id); assert.equal(stored.connected, false);
    await service.connect(fakeAdapter.id, { ...config, botToken: "••••••", appToken: "••••••" });
    assert.equal(activations, 2);
    const replies: string[] = [];
    await internals.createInboundHandler()({ channelId: "slack-default", chatId: "fixture-thread", taskId: "native-task",
      userMessageId: "user-turn", assistantMessageId: "assistant-turn", text: "fixture",
      sender: { id: config.allowUsers[0] }, reply: async (text: string) => { replies.push(text); } });
    assert.equal(requests[0].modelId, "fixture/native-model"); assert.equal(requests[0].permissionMode, undefined);
    assert.equal(requests[0].sessionFile, undefined); assert.equal(requests[0].welcomeMode, "bot");
    assert.equal(requests[0].modePresetId, "native"); assert.equal(requests[0].taskId, "gw-bot-native-task");
    await internals.createInboundHandler()({ channelId: "slack-default", chatId: "fixture-channel", taskId: "native-channel",
      userMessageId: "channel-user", assistantMessageId: "channel-assistant", text: "总结下内容", sender: { id: config.allowUsers[0] },
      slackHistory: { channelId: "CFIXTURE", beforeTs: "1700000010.000001", status: "loaded", hasMore: false,
        messages: [{ ts: "1700000009.000001", text: "actual channel reference material" }] },
      reply: async (text: string) => { replies.push(text); } });
    assert(requests[1].text.includes("actual channel reference material"));
    assert.equal(requests[1].displayText, "总结下内容");
    const requestCount = requests.length;
    await internals.createInboundHandler()({ channelId: "slack-default", chatId: "fixture-scope", taskId: "native-denied",
      userMessageId: "denied-user", assistantMessageId: "denied-assistant", text: "总结下内容", sender: { id: config.allowUsers[0] },
      slackHistory: { channelId: "CFIXTURE", beforeTs: "1700000010.000001", status: "unavailable", hasMore: false,
        messages: [], errorCode: "missing_scope", requiredScopes: ["channels:history"] },
      reply: async (text: string) => { replies.push(text); } });
    assert.equal(requests.length, requestCount, "failed channel read must not execute a task against unrelated sources");
    assert(replies.at(-1)?.includes("missing_scope"));
    assert.equal(requests[0].streamingBehavior, "followUp"); assert.equal(replies[0], "native-policy-reply");
    await service.stop(); await service.restoreChannels(); assert.equal(activations, 3);
    failSave = true;
    await assert.rejects(service.connect(fakeAdapter.id, config), /配置保存失败/);
    assert.equal(connected, false); assert.equal(activations, 3, "failed host commit must not release inbound execution");
    failSave = false; await service.stop();
  });
  await check("Gateway awaits its native answer and forces Bot/native without legacy policy", async () => {
    let finish!: (text: string) => void;
    const request = { taskId: "task", text: "fixture", assistantMessageId: "assistant", userMessageId: "user" };
    const port: GatewayAgentPort = {
      runGatewayTurn: async input => {
        assert.equal(input.welcomeMode,"bot"); assert.equal(input.modePresetId,"native");
        return new Promise<string>(resolve => { finish = resolve; });
      },
    };
    let settled = false; const promise = runGatewayAgentTurn(port, request).then(text => { settled = true; return text; });
    await wait(0); assert.equal(settled, false);
    finish("final answer"); assert.equal(await promise, "final answer");
    await assert.rejects(runGatewayAgentTurn({ runGatewayTurn: async () => { throw new Error("native failure"); } }, request), /native failure/);
  });
  await check("secure config readback has placeholders; missing OS encryption refuses persistence", () => {
    const sealed = sealSlackGatewayConfig(config);
    assert(!JSON.stringify(sealed).includes(config.botToken));
    assert(!JSON.stringify(sealed).includes(config.appToken));
    const view = slackGatewayConfigView(sealed);
    assert.equal(view.botToken, "••••••"); assert.equal(view.appToken, "••••••");
    assert.equal(view.encryptedSecrets, undefined);
    assert.equal(openSlackGatewayConfig(sealed).appToken, config.appToken);
    setEncryptionAvailable(false);
    assert.throws(() => sealSlackGatewayConfig(config), /加密不可用/);
    setEncryptionAvailable(true);
    assert(!safeSlackError(new Error("Bearer " + config.botToken + " wss://wss.slack.com/?ticket=secret")).includes(config.botToken));
    assert.equal(redactSlackText("read https://example.com/doc"), "read https://example.com/doc");
    const long = "😀".repeat(8100); const chunks = splitSlackReply(long);
    assert.equal(chunks.length, 3); assert.equal(chunks.join(""), long);
  });

  await check("native Pi tool task executes once and same Slack thread continues its session (local scripted provider)", async () => {
    const f = fixture("pi-native");
    const cwd = join(root, "native-task");
    mkdirSync(cwd);
    const model: Model<any> = {
      id: "slack-local-fixture", provider: "fixture", api: "openai-completions", name: "Local fixture",
      baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let writes = 0;
    const runtime = {
      hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }), getModel: () => model,
      streamSimple: (_model: Model<any>, context: Context) => {
        const stream = createAssistantMessageEventStream();
        const userIndex = context.messages.findLastIndex(message => message.role === "user");
        const afterUser = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
        const userText = JSON.stringify(context.messages[userIndex]);
        const isFollowUp = userText.includes("read-created-file");
        let content: AssistantMessage["content"];
        if (!afterUser.length) {
          if (!isFollowUp) writes++;
          content = [{ type: "toolCall", id: isFollowUp ? "read-native" : "write-native", name: isFollowUp ? "read" : "write",
            arguments: isFollowUp ? { path: "slack-result.txt" } : { path: "slack-result.txt", content: "NATIVE_PI_SLACK_OK\n" } }];
        } else {
          assert(!afterUser.some(message => message.isError), "native tool succeeds");
          content = [{ type: "text", text: isFollowUp ? "SAME_SESSION_READ_OK" : "NATIVE_PI_WRITE_OK" }];
        }
        const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" as const : "stop" as const;
        const response: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason: stopReason, message: response }); stream.end();
        return stream;
      },
    } as any;
    const session = await DurableBotRuntime.open({ directory: join(cwd,"durable"), cwd, models: runtime,
      model: { provider:model.provider,modelId:model.id }, toolMode:"native", instructions:()=>"fixture", onSnapshot:()=>{} });
    const requests: AgentPromptRequest[] = [];
    const port: GatewayAgentPort = {
      runGatewayTurn: async request => {
        requests.push(request);
        return session.reply(await session.submit(request.text,request.userMessageId));
      },
    };
    f.adapter.setInboundHandler(async message => {
      const reply = await runGatewayAgentTurn(port, { taskId: message.taskId!, text: message.text,
        assistantMessageId: message.assistantMessageId!, userMessageId: message.userMessageId!, streamingBehavior: "followUp" });
      await message.reply(reply);
    });
    try {
      await f.adapter.connect(config);
      const first = event("EvNATIVE", undefined, { text: "create-file" });
      f.sockets[0].emit(first); f.sockets[0].emit(first);
      await until(() => f.posts.length === 1, "native write result returned");
      assert.equal(readFileSync(join(cwd, "slack-result.txt"), "utf8"), "NATIVE_PI_SLACK_OK\n"); assert.equal(writes, 1);
      f.sockets[0].emit(event("EvFOLLOWUP", "1700000000.000002", { thread_ts: first.payload.event.ts, text: "read-created-file" }));
      await until(() => f.posts.length === 2, "same-session read reply");
      assert.equal(requests[0].taskId, requests[1].taskId);
      assert.equal(f.posts[0].text, "NATIVE_PI_WRITE_OK"); assert.equal(f.posts[1].text, "SAME_SESSION_READ_OK");
      await session.refresh(); assert.equal(session.snapshot.messages.filter(message=>message.role==='user').length,2);
    } finally { await f.adapter.disconnect(); await session.close(); }
  });
  console.log("SLACK_GATEWAY_TESTS_PASSED " + passed);
} finally {
  for (const adapter of adapters) await adapter.disconnect();
  const resolved = resolve(root);
  if (!resolved.startsWith(resolve(tmpdir()) + sep) || !basename(resolved).startsWith("mybuddy-slack-test-")) throw new Error("Unsafe fixture cleanup path");
  rmSync(resolved, { recursive: true, force: true });
}
