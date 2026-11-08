import assert from "node:assert/strict";
import { DingTalkStreamAdapter, type DingTalkSocket } from "../src/main/gateway/DingTalkStreamAdapter";
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
  const adapter = new DingTalkStreamAdapter("ding", "钉钉", {
    deferInboundUntilActivated: true, reconnectDelayMs: 1, heartbeatTimeoutMs: 100_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("connections/open")) return Response.json({ endpoint: "wss://wss-open-connection.dingtalk.com/connect", ticket: "ticket" });
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
  console.log("PASS DingTalk Stream: authentication, activation, identities, ACK/ping, replay, SSRF, receipts, reconnect and stale connection fencing");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
