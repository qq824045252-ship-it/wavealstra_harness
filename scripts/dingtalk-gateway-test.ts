import assert from "node:assert/strict";
import { DingTalkStreamAdapter, type DingTalkSocket } from "../src/main/gateway/DingTalkStreamAdapter";
import { GatewayReplyNotSentError } from "../src/main/gateway/GatewayReply";
import type { GatewayInboundMessage } from "../src/main/gateway/channels";

class Socket implements DingTalkSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Array<{ code: number; data: string; headers: { messageId: string } }> = [];
  closed = false;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const config = { clientId: "app", clientSecret: "secret", corpId: "corp", robotCode: "robot", allowUsers: ["employee"] };
function frame(overrides: Record<string, unknown> = {}, messageId = "transport") {
  return { type: "CALLBACK", headers: { messageId, topic: "/v1.0/im/bot/messages/get" }, data: JSON.stringify({
    chatbotCorpId: "corp", senderCorpId: "corp", robotCode: "robot", senderStaffId: "employee", senderNick: "Member",
    conversationId: "room", conversationType: "2", isInAtList: true, msgId: "event", msgtype: "text", text: { content: "hello" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=secret-session", sessionWebhookExpiredTime: Date.now() + 100_000,
    ...overrides,
  }) };
}
async function main() {
  let calls: { url: string; init?: RequestInit }[] = [];
  const sockets: Socket[] = [];
  let failReply = false;
  let failFileReceipt = false;
  let onWorkAuth: (() => void) | undefined;
  const adapter = new DingTalkStreamAdapter("ding", "钉钉", {
    deferInboundUntilActivated: true, reconnectDelayMs: 1, heartbeatTimeoutMs: 100_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("connections/open")) return Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" });
      if (String(url).includes('oauth2/accessToken')) { onWorkAuth?.(); return Response.json({ accessToken: 'test-token' }); }
      if (String(url).includes('/gettoken')) return Response.json({ access_token: 'test-old-token' });
      if (String(url).includes('/media/upload')) return Response.json({ errcode: 0, media_id: '@media' });
      if (String(url).includes('/robot/groupMessages/send')) return (failReply || failFileReceipt && JSON.parse(String(init?.body)).msgKey === 'sampleFile') ? Response.json({}, {status: 503}) : Response.json({ processQueryKey: 'receipt-' + calls.length });
      return failReply ? Response.json({ errcode: 130101 }, { status: 429 }) : Response.json({ errcode: 0 });
    },
    socketFactory: url => { assert.match(url, /^wss:\/\/wss-open-connection\.dingtalk\.com\/connect\?ticket=ticket$/); const s = new Socket(); sockets.push(s); setTimeout(() => s.onopen?.(), 0); return s; },
  });
  const inbound: GatewayInboundMessage[] = [];
  adapter.setInboundHandler(async message => { inbound.push(message); });
  await assert.rejects(adapter.connect({ ...config, allowUsers: [] }));
  assert.equal(calls.length, 0);
  await adapter.connect(config);
  assert.equal(adapter.isConnected(), true);
  const s = sockets[0];
  assert.equal(adapter.workConnectionKey(), undefined);
  s.emit(frame()); await tick(); assert.equal(inbound.length, 0); assert.equal(s.sent.at(-1)?.code, 503);
  adapter.activate();
  assert.match(adapter.workConnectionKey()!, /^[a-f0-9]{64}$/);
  const connectionKey = adapter.workConnectionKey();
  s.emit({ type: "SYSTEM", headers: { topic: "ping", messageId: "ping-1" }, data: '{"opaque":"challenge"}' });
  assert.equal(s.sent.at(-1)?.data, '{"opaque":"challenge"}');
  s.emit(frame()); await tick(); assert.equal(inbound.length, 1); assert.equal(inbound[0].sender?.id, "employee");
  {
    const { createHash } = await import('node:crypto');
    const bytes = Buffer.from('immutable file');
    const file = { name: 'result.txt', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, base64: bytes.toString('base64') };
    const progress: string[] = [];
    const result = await adapter.sendWorkNotification({ target: inbound[0].workTarget!, text: 'done', files: [file], effectKey: 'work', assertCurrent: () => {}, recordProgress: receipt => progress.push(receipt) });
    assert(result.ok); assert.equal(progress.length, 3, 'text, upload, file each persist a receipt');
    const body = JSON.parse(String(calls.at(-1)?.init?.body)); assert.equal(body.msgKey, 'sampleFile');
    assert.equal(JSON.parse(body.msgParam).mediaId, '@media');
    const originalHash=file.sha256;
    onWorkAuth=()=>{file.name='changed.bin';file.sha256='0'.repeat(64);};
    const stable=await adapter.sendWorkNotification({target:inbound[0].workTarget!,text:'immutable metadata',files:[file],effectKey:'snapshot',assertCurrent:()=>{}});
    onWorkAuth=undefined;
    assert(stable.ok);
    const immutableBody=JSON.parse(String(calls.at(-1)?.init?.body));
    assert.equal(JSON.parse(immutableBody.msgParam).fileName,'result.txt','async credential wait must not change frozen filename');
    const uploaded=calls.findLast(call=>call.url.includes('/media/upload'))!.init!.body as FormData;
    const uploadedFile=uploaded.get('media') as File;
    assert.equal(uploadedFile.name,'result.txt');
    assert.equal(createHash('sha256').update(Buffer.from(await uploadedFile.arrayBuffer())).digest('hex'),originalHash,'actual uploaded bytes match persisted frozen hash');
    assert(JSON.parse(stable.receipt).some((part:{part:string})=>part.part===`file:${originalHash}`),'receipt must identify the bytes actually validated');
    file.name='result.txt';file.sha256=originalHash;
    failFileReceipt=true;const failureProgress:string[]=[];const failStart=calls.length;
    const partialFile=await adapter.sendWorkNotification({target:inbound[0].workTarget!,text:'partial',files:[file],effectKey:'partial-file',assertCurrent:()=>{},recordProgress:receipt=>failureProgress.push(receipt)});
    assert(!partialFile.ok && partialFile.responseLost && !partialFile.retryable);
    assert.equal(failureProgress.length,2,'text and upload receipts retained, failed file send is not recorded as delivered');
    const afterFailure=calls.length;await tick();assert.equal(calls.length,afterFailure,'unknown file send is never retried implicitly');
    assert.equal(calls.slice(failStart).filter(call=>call.url.includes('/media/upload')).length,1);
    assert(!JSON.parse(failureProgress.at(-1)!).some((part:{part:string})=>part.part.startsWith('file:')));
    failFileReceipt=false;
    failReply = true;
    const unknown = await adapter.sendWorkNotification({ target: inbound[0].workTarget!, text: 'unknown', effectKey: 'work-2', assertCurrent: () => {} });
    assert(!unknown.ok && unknown.responseLost); failReply = false;
    calls = calls.slice(0, 1);
  }
  s.emit(frame({}, "new-envelope")); await tick(); assert.equal(inbound.length, 1);
  for (const invalid of [{ chatbotCorpId: "other" }, { senderCorpId: "other" }, { robotCode: "other" },
    { senderStaffId: "intruder" }, { isInAtList: false }, { sessionWebhook: "https://evil.example/send" },
    { sessionWebhook: "https://oapi.dingtalk.com@evil.example/robot/sendBySession" }, { sessionWebhookExpiredTime: 0 }]) {
    s.emit(frame({ ...invalid, msgId: JSON.stringify(invalid) })); await tick(); assert.equal(inbound.length, 1);
  }
  await inbound[0].reply("reply"); assert.equal(calls.length, 2);
  assert.equal(calls[1].init?.redirect, "error");
  failReply = true;
  await assert.rejects(inbound[0].reply("reply"), /未确认/); assert.equal(calls.length, 3);
  failReply = false;
  for (let i = 0; i < 18; i++) await inbound[0].reply("limited");
  const sendsBeforeLimit = calls.length;
  await assert.rejects(inbound[0].reply("over limit"), /速率上限/);
  assert.equal(calls.length, sendsBeforeLimit);
  const oldMessage = s.onmessage;
  s.emit({ type: "SYSTEM", headers: { topic: "disconnect" }, data: "{}" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets.length, 2); assert.equal(adapter.isConnected(), true);
  assert.equal(adapter.workConnectionKey(), connectionKey);
  await assert.rejects(inbound[0].reply("old reply"), /连接已改变/);
  oldMessage?.({ data: JSON.stringify(frame({ msgId: "old-socket" })) }); await tick(); assert.equal(inbound.length, 1);
  await adapter.disconnect();
  assert.equal(adapter.isConnected(), false);
  assert.equal(adapter.workConnectionKey(), undefined);
  await adapter.connect({ ...config, robotCode: "new-robot" }); adapter.activate();
  assert.notEqual(adapter.workConnectionKey(), connectionKey);
  await adapter.disconnect();

  let hostileSocketCreated = false;
  const hostile = new DingTalkStreamAdapter("bad", "bad", { fetch: async () => Response.json({ endpoint: "wss://evil.example/connect", ticket: "ticket" }),
    socketFactory: () => { hostileSocketCreated = true; return new Socket(); } });
  await assert.rejects(hostile.connect(config)); assert.equal(hostileSocketCreated, false);
  let resolveOpen!: (response: Response) => void;
  let cancelledSocketCreated = false;
  const cancelled = new DingTalkStreamAdapter("cancelled", "cancelled", {
    fetch: () => new Promise<Response>(resolve => { resolveOpen = resolve; }),
    socketFactory: () => { cancelledSocketCreated = true; return new Socket(); },
  });
  const opening = cancelled.connect(config);
  await tick(); await cancelled.disconnect();
  resolveOpen(Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" }));
  await assert.rejects(opening);
  assert.equal(cancelledSocketCreated, false);
  assert.equal(cancelled.isConnected(), false);
  // ACK is a durable-admission receipt, not merely "handler was called".
  {
    const transport = new Socket(); let admissions = 0;
    let accept!: () => void; let finish!: () => void; let rejectAdmission!: (error: Error) => void;
    const admission = new Promise<void>((resolve, reject) => { accept = resolve; rejectAdmission = reject; });
    const execution = new Promise<void>(resolve => { finish = resolve; });
    const durable = new DingTalkStreamAdapter("durable", "钉钉", {
      fetch: async () => Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" }),
      socketFactory: () => { setTimeout(() => transport.onopen?.(), 0); return transport; },
    });
    durable.setInboundHandler(() => { admissions++; return Object.assign(execution, { accepted: admission }); });
    await durable.connect(config);
    transport.emit(frame({ msgId: "admission" }, "first")); await tick();
    assert.equal(transport.sent.length, 0, "cannot ACK before the inbox commit");
    transport.emit(frame({ msgId: "admission" }, "duplicate-before")); await tick();
    assert.equal(transport.sent.at(-1)?.code, 503); assert.equal(admissions, 1);
    accept(); await tick();
    assert.equal(transport.sent.at(-1)?.headers.messageId, "first"); assert.equal(transport.sent.at(-1)?.code, 200);
    transport.emit(frame({ msgId: "admission" }, "duplicate-after")); await tick();
    assert.equal(transport.sent.at(-1)?.code, 200); assert.equal(admissions, 1);
    finish(); await tick();
    let attempt = 0;
    durable.setInboundHandler(() => { attempt++;
      if (attempt > 1) return Promise.resolve();
      const pending = new Promise<void>((_resolve, reject) => { rejectAdmission = reject; });
      return Object.assign(pending, { accepted: pending });
    });
    transport.emit(frame({ msgId: "rejected-admission" }, "rejected")); await tick();
    rejectAdmission(new Error("disk unavailable")); await tick();
    assert.equal(transport.sent.at(-1)?.code, 503);
    transport.emit(frame({ msgId: "rejected-admission" }, "retried")); await tick();
    assert.equal(attempt, 2); assert.equal(transport.sent.at(-1)?.code, 200);
    let acceptOld!: () => void;
    durable.setInboundHandler(() => Object.assign(Promise.resolve(), { accepted: new Promise<void>(resolve => { acceptOld = resolve; }) }));
    transport.emit(frame({ msgId: "generation-race" }, "old-generation")); await tick();
    await durable.disconnect(); await durable.connect(config);
    const ackCount = transport.sent.length;
    acceptOld(); await tick(); assert.equal(transport.sent.length, ackCount, "late admission cannot ACK an obsolete transport");
    let currentCalls = 0; durable.setInboundHandler(async () => { currentCalls++; });
    transport.emit(frame({ msgId: "generation-race" }, "new-generation")); await tick();
    assert.equal(currentCalls, 1, "late admission cannot populate the new connection's dedup cache");
    await durable.disconnect();
  }
  // The real 10,000-entry bound must evict old IDs, not reject all new traffic.
  {
    const transport = new Socket(); let count = 0;
    const saturated = new DingTalkStreamAdapter("capacity", "钉钉", {
      fetch: async () => Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" }),
      socketFactory: () => { setTimeout(() => transport.onopen?.(), 0); return transport; },
    });
    saturated.setInboundHandler(async () => { count++; }); await saturated.connect(config);
    const originalNow = Date.now; let simulatedNow = originalNow();
    Date.now = () => simulatedNow;
    try {
      for (let i = 0; i <= 10_000; i++) {
        simulatedNow += 60_001; // Independent local rate windows; cache clock remains monotonic.
        transport.emit(frame({ msgId: `capacity-${i}` }, `wire-${i}`));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(transport.sent.at(-1)?.code, 200);
      }
      assert.equal(count, 10_001);
      transport.emit(frame({ msgId: "capacity-10000" })); await tick(); assert.equal(count, 10_001);
      transport.emit(frame({ msgId: "capacity-0" })); await tick(); assert.equal(count, 10_002);
    } finally { Date.now = originalNow; await saturated.disconnect(); }
  }
  // A restart can recover a temporary route only through the host codec, with all
  // bindings revalidated. This mock models opaque encryption, not cryptography.
  {
    const vault = new Map<string, string>();
    const codec = { seal(value: string) { const key = `opaque-${vault.size}`; vault.set(key, value); return key; },
      open(key: string) { const value = vault.get(key); if (!value) throw new Error("unavailable keyring"); return value; } };
    let transport!: Socket; let sends = 0; let captured!: GatewayInboundMessage;
    const recovery = new DingTalkStreamAdapter("sealed", "钉钉", {
      replySecrets: codec,
      fetch: async url => {
        if (String(url).includes("connections/open")) return Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" });
        sends++; assert.equal(new URL(String(url)).hostname, "oapi.dingtalk.com"); return Response.json({ errcode: 0 });
      },
      socketFactory: () => { transport = new Socket(); setTimeout(() => transport.onopen?.(), 0); return transport; },
    });
    recovery.setInboundHandler(async message => { captured = message; });
    await recovery.connect(config); transport.emit(frame({ msgId: "sealed-message" })); await tick();
    assert.equal(captured.replyRoute?.kind, "dingtalk");
    const route = captured.replyRoute!; if (route.kind !== "dingtalk") throw new Error("missing route");
    assert.ok(route.encryptedCapability); assert.doesNotMatch(JSON.stringify(route), /secret-session|sendBySession/);
    const envelope = JSON.parse(codec.open(route.encryptedCapability!));
    const input = { deliveryId: "journal-reply", chatId: captured.chatId, messageId: captured.messageId!, sender: captured.sender, route };
    await recovery.disconnect(); await recovery.connect(config);
    const restored = recovery.restoreGatewayReply(input); assert.ok(restored); await restored("after restart"); assert.equal(sends, 1);
    for (const mutation of [{ accountKey: "other" }, { messageId: "other" }, { senderId: "other" },
      { webhook: "https://evil.example/robot/sendBySession" }, { expiresAt: Date.now() - 1 }]) {
      const encryptedCapability = codec.seal(JSON.stringify({ ...envelope, ...mutation }));
      const wrong = recovery.restoreGatewayReply({ ...input, route: { ...route, encryptedCapability } });
      assert.ok(wrong); await assert.rejects(wrong("must not send"), GatewayReplyNotSentError);
    }
    const unavailable = recovery.restoreGatewayReply({ ...input, route: { ...route, encryptedCapability: "missing-key" } });
    assert.ok(unavailable); await assert.rejects(unavailable("must not send"), GatewayReplyNotSentError);
    assert.equal(recovery.restoreGatewayReply({ ...input, sender: { id: "stranger" } }), undefined);
    assert.equal(sends, 1);
    await recovery.disconnect(); await recovery.connect({ ...config, corpId: "changed-corp" });
    await assert.rejects(recovery.restoreGatewayReply(input)!("wrong account"), GatewayReplyNotSentError);
    assert.equal(sends, 1); await recovery.disconnect();
  }
  console.log("PASS DingTalk Stream: authentication, activation, identities, ACK/ping, replay, SSRF, receipts, reconnect and stale connection fencing");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
