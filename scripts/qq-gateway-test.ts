import assert from "node:assert/strict";
import { QQChannelAdapter, type QQSocket } from "../src/main/gateway/QQChannelAdapter";
import { QQBotQrLogin } from "../src/main/gateway/QQBotQrLogin";
import type { GatewayInboundMessage } from "../src/main/gateway/channels";
import { createCipheriv, createHash } from "node:crypto";

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await pause(5); } throw new Error("mock condition timed out"); }
class Socket implements QQSocket {
  onmessage: QQSocket["onmessage"] = null;
  onclose: QQSocket["onclose"] = null;
  onerror: QQSocket["onerror"] = null;
  sent: Array<Record<string, any>> = [];
  closed = false;
  constructor() { setImmediate(() => this.event({ op: 10, d: { heartbeat_interval: 1000 } })); }
  event(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  send(raw: string) {
    const value = JSON.parse(raw); this.sent.push(value);
    if (value.op === 2 || value.op === 6) setImmediate(() => this.event({ op: 0, s: 1, t: value.op === 2 ? "READY" : "RESUMED", d: { session_id: "synthetic-session" } }));
    if (value.op === 1) this.event({ op: 11 });
  }
  close(code = 1000) { if (this.closed) return; this.closed = true; this.onclose?.({ code }); }
}
const sockets: Socket[] = [];
const requests: Array<{ url: string; body: Record<string, any>; headers?: HeadersInit }> = [];
let failedSend = false;
let afterUpload: (() => void) | undefined;
let unknownMessage = false;
let failUpload = false;
let missingMessageId = false;
const fetcher = (async (url, init) => {
  const href = String(url), body = JSON.parse(String(init?.body ?? "{}"));
  requests.push({ url: href, body, headers: init?.headers });
  assert.equal(init?.redirect, "error");
  if (href.endsWith("/files")) { if(failUpload) throw new Error("synthetic upload timeout"); afterUpload?.(); return new Response(JSON.stringify({ file_info: "synthetic-file-info", file_uuid: "upload-only", ttl: 3600 })); }
  if (missingMessageId && href.endsWith("/messages")) return Response.json({});
  if (unknownMessage && href.endsWith("/messages")) throw new Error("synthetic lost receipt");
  return new Response(JSON.stringify(href.endsWith("getAppAccessToken") ? { access_token: "synthetic-token", expires_in: 7200 }
    : href.endsWith("/gateway") ? { url: "wss://gateway.qq.com/ws" }
      : failedSend ? { code: 400 } : { id: "receipt" }), { status: failedSend && href.endsWith("/messages") ? 400 : 200 });
}) as typeof fetch;
const inbound: GatewayInboundMessage[] = [];
const adapter = new QQChannelAdapter("qq-default", "QQ", { fetch: fetcher, deferInboundUntilActivated: true,
  reconnectDelayMs: 1, readyTimeoutMs: 200, socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
adapter.setInboundHandler(async message => { inbound.push(message); });
const config = { appId: "123", appSecret: "synthetic-secret", allowUsers: ["user", "member"] };
function event(id: string, group = false, age = 0, sender?: string) {
  return { op: 0, s: 10, t: group ? "GROUP_AT_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE", d: { id, content: "hello",
    timestamp: new Date(Date.now() - age).toISOString(), group_openid: "group", author: group ? { member_openid: sender ?? "member" } : { user_openid: sender ?? "user" } } };
}
try {
  await assert.rejects(() => adapter.connect({ ...config, allowUsers: [] }), /允许用户/);
  await adapter.connect(config);
  assert.equal(adapter.isConnected(), true);
  assert.equal(adapter.workConnectionKey(), undefined);
  sockets[0].event(event("before-activation")); await pause(); assert.equal(inbound.length, 0);
  adapter.activate();
  await until(() => inbound.length === 1);
  assert.equal(inbound[0].messageId, "before-activation");
  adapter.activate(); await pause(); assert.equal(inbound.length, 1);
  inbound.length = 0;
  const account = adapter.workConnectionKey(); assert.match(account!, /^[a-f0-9]{64}$/);
  assert.equal(sockets[0].sent[0].op, 2);
  assert.equal(sockets[0].sent[0].d.intents, 1 << 25);
  sockets[0].event(event("unauthorized", false, 0, "stranger"));
  sockets[0].event(event("one")); sockets[0].event(event("one")); await until(() => inbound.length === 1);
  assert.equal(inbound[0].chatId, "c2c:user");
  assert.equal(inbound[0].workTarget?.channelType, "qq"); assert.equal("sendWorkNotification" in adapter, true);
  const target = inbound[0].workTarget!;
  if (target.channelType !== "qq") throw new Error("wrong route");
  await assert.rejects(adapter.sendWorkNotification({target: {...target, address: {...target.address, expiresAt: 1}}, text: "late", effectKey: "late", assertCurrent: () => {}}), /过期/);
  await Promise.all(Array.from({ length: 5 }, () => inbound[0].reply("answer")));
  await assert.rejects(() => inbound[0].reply("sixth"), /5 次/);
  const sends = requests.filter(v => v.url.endsWith("/messages"));
  assert.deepEqual(sends.map(v => v.body.msg_seq), [1, 2, 3, 4, 5]);
  assert(sends.every(v => v.body.msg_id === "one"));
  const beforeWorkSend = requests.length;
  const workInput = { target, text: "Work completion", effectKey: "existing-effect", qqMessageSequence: 2, assertCurrent: () => {} };
  assert.equal((await adapter.sendWorkNotification(workInput)).ok, true);
  assert.equal(requests.at(-1)?.url, "https://api.sgroup.qq.com/v2/users/user/messages");
  assert.equal(new Headers(requests.at(-1)?.headers).get("X-Union-Appid"), config.appId);
  assert.equal(new Headers(requests.at(-1)?.headers).get("Authorization"), "QQBot synthetic-token");
  assert.equal(requests.at(-1)?.body.msg_seq, 2); assert.equal(requests.at(-1)?.body.msg_id, "one");
  assert.equal((await adapter.sendWorkNotification(workInput)).ok, true);
  assert.equal(requests.at(-1)?.body.msg_seq, 2, "same effect must retain the same provider sequence");
  const afterValidWorkSend = requests.length;
  await assert.rejects(adapter.sendWorkNotification({...workInput, qqMessageSequence: 6}), /槽位/);
  await assert.rejects(adapter.sendWorkNotification({...workInput, qqMessageSequence: undefined}), /槽位/);
  assert.equal(requests.length, afterValidWorkSend, "missing/exhausted reservations never call provider");
  assert(afterValidWorkSend > beforeWorkSend);
  const progress: string[]=[];
  const bytes = Buffer.from("isolated report");
  const file = {name:"report.txt",sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,base64:bytes.toString("base64")};
  const startFile = requests.length;
  const partial = await adapter.sendWorkNotification({...workInput, files:[file],recordProgress:receipt=>progress.push(receipt)});
  assert(partial.ok);
  assert.equal(requests.length, startFile + 2);
  const upload = requests[startFile], media = requests[startFile+1];
  assert.equal(upload.url, "https://api.sgroup.qq.com/v2/users/user/files");
  assert.deepEqual(upload.body, {file_type:4,file_data:file.base64,file_name:file.name,srv_send_msg:false});
  assert.equal(media.body.msg_type,7); assert.equal(media.body.msg_seq,2);
  assert.equal(media.body.content,workInput.text); assert.deepEqual(media.body.media,{file_info:"synthetic-file-info"});
  assert.equal(JSON.parse(progress[0])[0].receipt,"receipt");
  assert.equal(JSON.parse(progress[0])[0].part,`file:${file.sha256}`);
  assert.equal(JSON.parse(progress[0])[1].via,"media_content");
  const noSendStart=requests.length;
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[{...file,sha256:"0".repeat(64)}]}),/哈希/);
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[file,file]}),/多文件/);
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[{...file,bytes:11*1024*1024}]}),/大小/);
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[{...file,name:"../secret"}]}),/名称/);
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[file],target:{...target,chatId:"group:group",address:{...target.address,group:true,recipient:"group"}}}),/群文件/);
  assert.equal(requests.length,noSendStart,"invalid files, group and multipart never upload or consume another provider slot");
  let revised=false; afterUpload=()=>{revised=true;};
  const beforeRevision=requests.length;
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[file],assertCurrent:()=>{if(revised)throw new Error("revision");}}),/授权/);
  assert.equal(requests.length,beforeRevision+1,"revision after upload prevents message");
  const controller=new AbortController(); afterUpload=()=>controller.abort();
  const beforeCancel=requests.length;
  await assert.rejects(adapter.sendWorkNotification({...workInput,files:[file],signal:controller.signal}),/停止/);
  assert.equal(requests.length,beforeCancel+1);
  afterUpload=undefined; failUpload=true;
  const beforeUploadFailure=requests.length;
  const uploadFailure=await adapter.sendWorkNotification({...workInput,files:[file]});
  assert(!uploadFailure.ok && !uploadFailure.responseLost && !uploadFailure.retryable);
  assert.equal(requests.length,beforeUploadFailure+1,"unknown upload is not a delivered message and must not send");
  failUpload=false;
  const clockNow=Date.now; afterUpload=()=>{Date.now=()=>target.address.expiresAt+1;};
  try { await assert.rejects(adapter.sendWorkNotification({...workInput,files:[file]}),/过期/); }
  finally { Date.now=clockNow; afterUpload=undefined; }
  missingMessageId=true;
  const noId=await adapter.sendWorkNotification({...workInput,files:[file]});
  assert(!noId.ok && noId.responseLost && !noId.retryable,"HTTP 200 without message id is unknown, not a rejection");
  missingMessageId=false; unknownMessage=true;
  const beforeUnknown=requests.length;
  const unknown=await adapter.sendWorkNotification({...workInput,files:[file]});
  assert(!unknown.ok && unknown.responseLost && !unknown.retryable);
  await pause(10); assert.equal(requests.length,beforeUnknown+2,"unknown send does not replay upload or message");
  unknownMessage=false;
  const fileOnly=await adapter.sendWorkNotification({...workInput,text:"",files:[file]});
  assert(fileOnly.ok && JSON.parse(fileOnly.receipt)[0].receipt==="receipt");

  sockets[0].event(event("group", true)); await until(() => inbound.length === 2);
  assert.equal(inbound[1].chatId, "group:group");
  sockets[0].event(event("expired-group", true, 301_000));
  sockets[0].event(event("expired-c2c", false, 3601_000));
  sockets[0].event(event("valid-c2c", false, 301_000)); await until(() => inbound.length === 3);
  failedSend = true;
  const before = requests.length;
  await assert.rejects(() => inbound[2].reply("will fail"), /未自动重试/); assert.equal(requests.length, before + 1); failedSend = false;
  sockets[0].close(4009);
  await until(() => sockets.length === 2 && adapter.isConnected());
  assert.equal(sockets[1].sent[0].op, 6); assert.equal(sockets[1].sent[0].d.session_id, "synthetic-session");
  sockets[1].event(event("one")); await pause(10); assert.equal(inbound.length, 3);
  sockets[1].event({ op: 9, d: false }); await until(() => sockets.length === 3 && adapter.isConnected());
  assert.equal(sockets[2].sent[0].op, 2);
  await pause(850);
  assert(sockets[2].sent.some(value => value.op === 1));
  assert.equal(adapter.isConnected(), true); // Heartbeat ACK keeps the connection alive.
  const originalNow = Date.now;
  Date.now = () => originalNow() + 5 * 60_000;
  try { await assert.rejects(() => inbound[1].reply("expired group reply"), /窗口/); }
  finally { Date.now = originalNow; }
  const savedSocket = sockets[2];
  await adapter.connect({ ...config, appId: "456" }); adapter.activate();
  assert.notEqual(adapter.workConnectionKey(), account);
  savedSocket.event(event("stale-socket")); await pause(10); assert.equal(inbound.length, 3);
  await assert.rejects(() => inbound[2].reply("old account"), /账号/);
  await adapter.disconnect(); assert.equal(adapter.isConnected(), false);
  const malicious = new QQChannelAdapter("qq", "QQ", { fetch: (async (url, init) => String(url).endsWith("/gateway") ? new Response(JSON.stringify({ url: "wss://evil.test/ws" })) : fetcher(url, init)) as typeof fetch });
  await assert.rejects(() => malicious.connect(config), /未就绪/); await malicious.disconnect();

  // The persistence gap must preserve ordered, authorized messages, not just READY.
  const bufferedSockets: Socket[] = [], delivered: GatewayInboundMessage[] = [];
  const buffered = new QQChannelAdapter("qq-buffer", "QQ", { fetch: fetcher, deferInboundUntilActivated: true,
    reconnectDelayMs: 1, readyTimeoutMs: 200, socketFactory: () => { const socket = new Socket(); bufferedSockets.push(socket); return socket; } });
  buffered.setInboundHandler(async message => { delivered.push(message); });
  try {
    await buffered.connect(config);
    bufferedSockets[0].event(event("first")); bufferedSockets[0].event(event("first"));
    bufferedSockets[0].event(event("denied", false, 0, "stranger"));
    bufferedSockets[0].event(event("expires-during-persistence", true, 299_000));
    await pause(); assert.equal(delivered.length, 0);
    const firstConnection = buffered.gatewayConnectionGeneration();
    bufferedSockets[0].close(4009);
    await until(() => bufferedSockets.length === 2 && buffered.isConnected());
    assert.notEqual(buffered.gatewayConnectionGeneration(), firstConnection);
    assert.equal(bufferedSockets[1].sent[0].op, 6);
    assert.equal(bufferedSockets[1].sent[0].d.seq, 10);
    bufferedSockets[1].event(event("first")); bufferedSockets[1].event(event("second")); await pause();
    const now = Date.now; Date.now = () => now() + 2000;
    try { buffered.activate(); } finally { Date.now = now; }
    await until(() => delivered.length === 2);
    assert.deepEqual(delivered.map(message => message.messageId), ["first", "second"]);
    buffered.activate(); await pause(); assert.equal(delivered.length, 2);

    const pendingReply = delivered[0];
    const restoredReply = buffered.restoreGatewayReply({ deliveryId:"qq-durable", chatId:pendingReply.chatId,
      messageId:pendingReply.messageId!, sender:pendingReply.sender, route:pendingReply.replyRoute });
    assert.ok(restoredReply); await restoredReply("durable reply");
    assert.equal(requests.at(-1)?.body.msg_seq,1); assert.equal(requests.at(-1)?.body.msg_id,"first");
    let admissionAttempts = 0;
    buffered.setInboundHandler(() => { admissionAttempts++; const result = admissionAttempts === 1 ? Promise.reject(new Error("commit failed")) : Promise.resolve();
      return Object.assign(result,{accepted:result}); });
    bufferedSockets.at(-1)!.event(event("durable-admission")); await pause(); await pause();
    bufferedSockets.at(-1)!.event(event("durable-admission")); await until(() => admissionAttempts === 2);
    bufferedSockets.at(-1)!.event(event("durable-admission")); await pause(); assert.equal(admissionAttempts,2);
    buffered.setInboundHandler(async message => { delivered.push(message); });

    // A failed persistence/cancel flow calls disconnect; never drain its data later.
    await buffered.connect(config);
    bufferedSockets.at(-1)!.event(event("cancelled")); await pause();
    await buffered.disconnect(); assert.throws(() => buffered.activate(), /尚未连接/);
    await buffered.connect({ ...config, appId: "456" }); buffered.activate();
    await pause(); assert.equal(delivered.length, 2);
    // Even a message already scheduled for activation cannot escape cancellation.
    await buffered.connect(config);
    bufferedSockets.at(-1)!.event(event("cancel-during-flush")); await pause();
    buffered.activate(); await buffered.disconnect(); await pause(); assert.equal(delivered.length, 2);

    await buffered.connect(config);
    bufferedSockets.at(-1)!.event(event("terminal")); await pause();
    bufferedSockets.at(-1)!.close(4014);
    assert.throws(() => buffered.activate(), /尚未连接/);
    await buffered.connect(config); buffered.activate(); await pause(); assert.equal(delivered.length, 2);

    // Bounded buffering must fail closed rather than silently discard early messages.
    await buffered.connect(config);
    for (let i = 0; i <= 256; i++) bufferedSockets.at(-1)!.event(event(`overflow-${i}`));
    await until(() => !buffered.isConnected());
    assert.match(buffered.statusText(), /待激活消息过多/);
    assert.throws(() => buffered.activate(), /尚未连接/);
    await buffered.connect(config); buffered.activate(); await pause(); assert.equal(delivered.length, 2);
  } finally { await buffered.disconnect(); }

  let key: Buffer, authorized = 0, badTag = false, missingUser = false, pending = false;
  const qrFetch = (async (url, init) => {
    assert(String(url).startsWith("https://q.qq.com/lite/")); assert.equal(init?.redirect, "error");
    if (String(url).endsWith("create_bind_task")) {
      key = Buffer.from(JSON.parse(String(init?.body)).key, "base64");
      return new Response(JSON.stringify({ retcode: 0, data: { task_id: "synthetic/task" } }));
    }
    if (pending) return new Response(JSON.stringify({ retcode: 0, data: { status: 1 } }));
    const iv = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([iv, cipher.update("synthetic-bound-secret"), cipher.final(), cipher.getAuthTag()]);
    if (badTag) encrypted[encrypted.length - 1] ^= 1;
    return new Response(JSON.stringify({ retcode: 0, data: { status: 2, bot_appid: "123", user_openid: missingUser ? "" : "scanner",
      bot_encrypt_secret: encrypted.toString("base64") } }));
  }) as typeof fetch;
  const qr = new QQBotQrLogin({ fetch: qrFetch, pollIntervalMs: 1, onAuthorized: async (credentials, check, signal) => {
    check(); assert.equal(signal.aborted, false); assert.equal(credentials.appSecret, "synthetic-bound-secret"); authorized++;
  } });
  await assert.rejects(() => qr.start(false), /明确批准/);
  const state = await qr.start(true); assert.equal(state.state, "waiting");
  assert(state.qrUrl?.startsWith("https://q.qq.com/qqbot/openclaw/connect.html?task_id=synthetic%2Ftask"));
  await until(() => qr.getState().state === "connected"); assert.equal(authorized, 1);
  assert(!JSON.stringify(qr.getState()).includes("secret"));
  badTag = true; await qr.start(true); await until(() => qr.getState().state === "error"); assert.equal(authorized, 1);
  badTag = false; missingUser = true; await qr.start(true); await until(() => qr.getState().state === "error"); assert.equal(authorized, 1);
  missingUser = false; pending = true;
  const cancelState = await qr.start(true); qr.cancel("unrelated"); assert.equal(qr.getState().state, "waiting");
  qr.cancel(cancelState.sessionId); pending = false; await pause(10); assert.equal(qr.getState().state, "cancelled"); assert.equal(authorized, 1);
  const timeout = new QQBotQrLogin({ fetch: qrFetch, pollIntervalMs: 1, deadlineMs: 5, onAuthorized: async () => { throw new Error("must not run"); } });
  pending = true; await timeout.start(true); await until(() => timeout.getState().state === "expired"); timeout.cancel();
  qr.cancel();
  // Cancel while an authorized callback is waiting: it cannot commit afterward.
  pending = false;
  let releaseBinding: (() => void) | undefined, bindingSignal: AbortSignal | undefined, committed = false;
  const duringBinding = new QQBotQrLogin({ fetch: qrFetch, pollIntervalMs: 1, onAuthorized: async (_credentials, check, signal) => {
    bindingSignal = signal;
    await new Promise<void>(resolve => { releaseBinding = resolve; });
    check(); committed = true;
  } });
  await duringBinding.start(true); await until(() => !!releaseBinding);
  duringBinding.cancel(); assert.equal(bindingSignal!.aborted, true); releaseBinding!();
  await pause(10); assert.equal(committed, false); assert.equal(duringBinding.getState().state, "cancelled");
  // Cancel a websocket handshake that has not received HELLO/READY.
  let hangingSocket: Socket | undefined;
  const handshake = new QQChannelAdapter("qq", "QQ", { fetch: fetcher, readyTimeoutMs: 500,
    socketFactory: () => { const socket = new Socket(); socket.event = () => {}; hangingSocket = socket; return socket; } });
  const pendingConnect = handshake.connect(config);
  await until(() => !!hangingSocket); await handshake.disconnect();
  await assert.rejects(() => pendingConnect, /未就绪/);
  assert.equal(handshake.isConnected(), false);
  console.log("QQ Hermes gateway PASS: QR consent/decryption/cancellation, READY/RESUME, account identity, activation, allowlist, dedup, reply limits and safe failures");
} finally { await adapter.disconnect(); }
