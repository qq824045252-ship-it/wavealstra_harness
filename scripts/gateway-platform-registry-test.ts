import assert from "node:assert/strict";
import { GatewayPlatformRegistry, GATEWAY_CAPABILITIES, gatewayCapabilities, type GatewayMessageEvent, type RegisteredGatewayAdapter } from "../src/main/gateway/GatewayPlatformRegistry";
import type { GatewayInboundHandler, GatewayInboundMessage } from "../src/main/gateway/channels";
import type { GatewayChannelType } from "../src/shared/agent-ipc";
class FakeAdapter implements RegisteredGatewayAdapter {
  readonly id: string;
  readonly name = "test";
  live = true;
  key = "a".repeat(64);
  generation = 0;
  gatewayConnectionGeneration(): unknown { return this.generation; }
  handler!: GatewayInboundHandler;
  constructor(readonly type: GatewayChannelType) { this.id = `${type}-default`; }
  setInboundHandler(handler: GatewayInboundHandler): void { this.handler = handler; }
  async connect(): Promise<void> { this.live = true; }
  async disconnect(): Promise<void> { this.live = false; }
  isConnected(): boolean { return this.live; }
  statusText(): string { return "test"; }
  workConnectionKey(): string | undefined { return this.live ? this.key : undefined; }
}
for (const platform of Object.keys(GATEWAY_CAPABILITIES) as GatewayChannelType[]) {
  const registry = new GatewayPlatformRegistry();
  const adapter = new FakeAdapter(platform);
  let event: GatewayMessageEvent | undefined;
  let replies = 0;
  registry.register(adapter, async value => { event = value; });
  assert.throws(() => registry.register(adapter, async () => {}), /重复/);
  const message: GatewayInboundMessage = { channelId: adapter.id, chatId: "chat", messageId: "message", text: "hello",
    sender: { id: "sender", name: "name" }, reply: async () => { replies++; } };
  await adapter.handler(message);
  assert.equal(event?.platform, platform);
  assert.equal(event?.source.accountKey, adapter.key);
  assert.equal(event?.text, "hello");
  assert.equal(event?.message.messageId, "message");
  assert.equal(event?.capabilities.media, ["discord", "dingtalk"].includes(platform) ? "bidirectional" : ["telegram", "feishu", "slack", "weixin", "qq"].includes(platform) ? "inbound" : false);
  await event!.message.reply("reply");
  assert.equal(replies, 1);
  await assert.rejects(() => adapter.handler({ ...message, channelId: "another-default" }), /身份/);
  await assert.rejects(() => adapter.handler({ ...message, chatId: " " }), /消息/);
  adapter.key = "b".repeat(64);
  await assert.rejects(() => event!.message.reply("stale"), /已改变/);
  assert.equal(replies, 1);
  adapter.live = false;
  await assert.rejects(() => adapter.handler(message), /身份/);
}
const registry = new GatewayPlatformRegistry();
const adapter = new FakeAdapter("telegram");
let received: GatewayMessageEvent | undefined;
registry.register(adapter, async event => { received = event; });
const message: GatewayInboundMessage = { channelId: adapter.id, chatId: "123", sender: { id: "456" }, text: "thread", reply: async () => {},
  workTarget: { version: 1, channelType: "telegram", channelId: adapter.id, connectionKey: adapter.key,
    chatId: "123", senderId: "456", address: { chatId: "123", messageThreadId: 7 } } };
await adapter.handler(message);
assert.equal(received?.source.threadId, "7");
for (const patch of [{ channelId: "other" }, { connectionKey: "b".repeat(64) }, { chatId: "124" }, { senderId: "other" }]) {
  await assert.rejects(() => adapter.handler({ ...message, workTarget: { ...message.workTarget!, ...patch } }), /来源/);
}
assert.equal(GATEWAY_CAPABILITIES.slack.durableInbound, true);
assert.equal(GATEWAY_CAPABILITIES.dingtalk.workNotifications, true);
assert.equal(GATEWAY_CAPABILITIES.discord.workNotifications, true);
// A slow turn cannot overlap the next turn in the same native conversation.
{
  const registry = new GatewayPlatformRegistry();
  const adapter = new FakeAdapter("telegram");
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  registry.register(adapter, async event => {
    seen.push(`start:${event.text}`);
    if (event.text === "first") await gate;
    if (event.text === "fail") throw new Error("expected failure");
    seen.push(`end:${event.text}`);
  });
  const msg = (text: string, chatId = "same"): GatewayInboundMessage => ({ channelId: adapter.id, chatId, text, reply: async () => {} });
  const first = adapter.handler(msg("first"));
  const second = adapter.handler(msg("second"));
  await adapter.handler(msg("other", "other"));
  assert.deepEqual(seen, ["start:first", "start:other", "end:other"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(seen.slice(3), ["end:first", "start:second", "end:second"]);
  await assert.rejects(adapter.handler(msg("fail")), /expected failure/);
  await adapter.handler(msg("after-fail"));
  assert.equal(seen.at(-1), "end:after-fail");
}
// Admission is bounded, and queued deliveries are rejected after account replacement.
{
  const registry = new GatewayPlatformRegistry();
  const adapter = new FakeAdapter("qq");
  let release!: () => void;
  let started!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  registry.register(adapter, async () => { calls++; started(); await gate; });
  const msg: GatewayInboundMessage = { channelId: adapter.id, chatId: "same", text: "hello", reply: async () => {} };
  const first = adapter.handler(msg);
  await ready;
  const pending = Array.from({ length: 63 }, () => adapter.handler(msg));
  const results = Promise.allSettled(pending);
  await assert.rejects(adapter.handler(msg), /队列已满/);
  adapter.key = "b".repeat(64);
  release(); await first;
  for (const result of await results) assert.equal(result.status, "rejected");
  assert.equal(calls, 1);
  await adapter.handler(msg);
  assert.equal(calls, 2);
}
console.log("PASS gateway registry: all platform contracts, provenance, account replacement, bounded session FIFO, failure recovery, disconnected delivery, target integrity, thread preservation");

// A runtime transport selection cannot falsely advertise Work notifications.
{
  const adapter = Object.assign(new FakeAdapter("wecom"), {
    gatewayCapabilities: () => ({ transport: "socket" as const, workNotifications: false }),
  });
  assert.equal(gatewayCapabilities(adapter).transport, "socket");
  assert.equal(gatewayCapabilities(adapter).workNotifications, false);
  assert.equal(gatewayCapabilities(new FakeAdapter("wecom")).transport, "webhook");
}

// Same-account reconnect must fence queued execution and captured replies too.
{
  const registry = new GatewayPlatformRegistry();
  const adapter = new FakeAdapter("qq");
  let release!: () => void;
  let calls = 0;
  let reply: (() => Promise<void>) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  registry.register(adapter, async event => { calls++; reply = () => event.message.reply("answer"); if (calls === 1) await gate; });
  const msg: GatewayInboundMessage = { channelId: adapter.id, chatId: "same", text: "hello", reply: async () => {} };
  const first = adapter.handler(msg);
  await Promise.resolve();
  const queued = assert.rejects(adapter.handler(msg), /已改变/);
  adapter.generation++; // Same account digest, different socket/configuration epoch.
  release(); await first; await queued;
  assert.equal(calls, 1);
  await assert.rejects(reply!, /已改变/);
  await adapter.handler(msg); assert.equal(calls, 2);
}
