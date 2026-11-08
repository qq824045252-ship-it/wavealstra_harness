import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewaySecrets, redactGatewayText } from "../src/main/gateway/GatewaySecrets";
import { sealGatewayProviderConfig, openGatewayProviderConfig, gatewayProviderConfigView,
  validateGatewayProviderConfig } from "../src/main/gateway/GatewayProviderConfig";
import { sealSlackGatewayConfig, openSlackGatewayConfig } from "../src/main/gateway/SlackGatewayCredentials";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { GatewayLifecycleManager } from "../src/main/gateway/GatewayLifecycleManager";
import { gatewayReplySecretCodec } from "../src/main/gateway/GatewayRouteCredentials";
import { GatewayRouteEncodingError } from "../src/main/gateway/GatewayReply";
import { WeixinIlinkAdapter } from "../src/main/gateway/WeixinIlinkAdapter";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { TelegramChannelAdapter, type ChannelConfig, type GatewayInboundHandler } from "../src/main/gateway/channels";
import type { GatewayWorkSendInput, GatewayWorkSendResult } from "../src/main/gateway/work-outbound";
import { safeStorage, setStorageBackend, setEncryptionAvailable } from "./gateway-electron-stub";

const token = "9001:private_telegram_fixture";
const otherSecret = "private/+nested-secret";
const secrets = new GatewaySecrets();
secrets.remember("telegram", "telegram", { botToken: token });
secrets.remember("wechat", "wechat", { appSecret: otherSecret, token: "mp-verification", encodingAESKey: "mp-aes-key" });
const hidden = secrets.redact(`${token} ${encodeURIComponent(otherSecret)} mp-aes-key Bearer provider-access-token`);
assert(!hidden.includes(token)); assert(!hidden.includes(encodeURIComponent(otherSecret)));
assert(!hidden.includes("mp-aes-key")); assert(!hidden.includes("provider-access-token"));
assert.equal(redactGatewayText("普通答案与正常 URL https://example.com/file"), "普通答案与正常 URL https://example.com/file");
assert(!redactGatewayText('token="opaque"').includes("opaque"));
assert.equal(redactGatewayText("ordinary message", ["bad-\ud800-secret"]), "ordinary message");
assert.equal(redactGatewayText("bad-\ud800-secret", ["bad-\ud800-secret"]), "[凭据已隐藏]");
assert(!redactGatewayText('https://api.telegram.org/file/bot123:private/file.jpg').includes("123:private"));
assert(!secrets.error(new Error(`request https://example.com/?token=${token}`)).includes("example.com"));
secrets.remember("telegram", "telegram", { botToken: "replacement-credential" });
const turnFilter = secrets.outboundFilter();
secrets.remember("telegram", "telegram", { botToken: "third-credential" });
secrets.remember("telegram", "telegram", { botToken: "fourth-credential" });
assert(!turnFilter(`long turn ${token}`).includes(token), "a running turn retains its own filter across multiple rotations");
secrets.remember("telegram", "telegram", { botToken: token });
secrets.remember("telegram", "telegram", { botToken: "replacement-credential" });
assert(!secrets.redact(`late ${token}; current replacement-credential`).includes(token), "late replies redact the previous credential generation");

for (const [type, raw, secretField] of [
  ["telegram", { botToken: token }, "botToken"],
  ["wechat", { appId: "wx-app", appSecret: otherSecret, token: "verify", encodingAESKey: "a".repeat(43) }, "appSecret"],
] as const) {
  const config = validateGatewayProviderConfig(type, { ...raw, unexpectedSecret: "not-persisted" });
  const sealed = sealGatewayProviderConfig(type, config);
  assert.equal(sealed[secretField], undefined);
  assert.equal(sealed.unexpectedSecret, undefined);
  assert.equal(openGatewayProviderConfig(type, sealed)[secretField], raw[secretField]);
  assert.equal(gatewayProviderConfigView(type, sealed)[secretField], "••••••");
  assert.equal(gatewayProviderConfigView(type, sealed).encryptedSecrets, undefined);
  setEncryptionAvailable(false);
  assert.throws(() => sealGatewayProviderConfig(type, config));
  assert.throws(() => openGatewayProviderConfig(type, sealed));
  setEncryptionAvailable(true);
}
const slack = { teamId: "TTEST", appId: "ATEST", botToken: "xoxb-fixture", appToken: "xapp-fixture", allowUsers: ["UOWNER"] };
const sealedSlack = sealSlackGatewayConfig(slack);
const routeSecret = gatewayReplySecretCodec.seal("temporary-reply-capability");
assert(routeSecret.startsWith("v1:"));
assert(!routeSecret.includes("temporary-reply-capability"));
assert.equal(gatewayReplySecretCodec.open(routeSecret), "temporary-reply-capability");
const longCapability = JSON.stringify({ contextToken: "x".repeat(16_383), accountKey: "a".repeat(64), peer: "owner", messageId: "message", expiresAt: Date.now() });
assert.equal(gatewayReplySecretCodec.open(gatewayReplySecretCodec.seal(longCapability)), longCapability);
const oversizedCapabilities = ["quote-fixture-" + '"'.repeat(8_192), "unicode-fixture-" + "界".repeat(10_000)];
for (const contextToken of oversizedCapabilities) {
  const boundCapability = JSON.stringify({ kind: "weixin", contextToken, accountKey: "a".repeat(64), peer: "owner", messageId: "message", expiresAt: Date.now() });
  assert(contextToken.length < 16_384 && boundCapability.length <= 24_576, "the adapter and plaintext limits admit this fixture");
  assert.throws(() => gatewayReplySecretCodec.seal(boundCapability), error => {
    assert(error instanceof GatewayRouteEncodingError);
    assert.equal(error.reason, "too-large");
    assert(!error.message.includes(contextToken));
    return true;
  });
}
assert.throws(() => gatewayReplySecretCodec.seal(""), GatewayRouteEncodingError);
assert.throws(() => gatewayReplySecretCodec.seal("x".repeat(24_577)), GatewayRouteEncodingError);
assert.throws(() => gatewayReplySecretCodec.open("v0:invalid"));
assert.throws(() => gatewayReplySecretCodec.open("v1:broken"));
setStorageBackend("basic_text");
assert.throws(() => gatewayReplySecretCodec.seal("temporary"), /安全凭据/);
assert.throws(() => gatewayReplySecretCodec.open(routeSecret), /安全凭据/);
assert.throws(() => sealSlackGatewayConfig(slack), /安全凭据/);
assert.throws(() => openSlackGatewayConfig(sealedSlack), /安全凭据/);
assert.throws(() => sealGatewayProviderConfig("telegram", { botToken: token }), /安全凭据/);
setStorageBackend("gnome_libsecret");
console.log("PASS exact/encoded credential redaction, Telegram/MP encryption, weak-backend rejection");

// Exercise the production route codec through the real poll/admission path.
// Only Electron's storage backend is stubbed; no synthetic codec classification.
const weixinConfig = { accountId: "bot", userId: "owner", baseUrl: "https://ilinkai.weixin.qq.com", botToken: "weixin-fixture", allowUsers: ["owner"] };
const weixinMessage = (message_id: string, contextToken?: string) => ({ message_id, from_user_id: "owner", to_user_id: "bot",
  message_type: 1, message_state: 2, ...(contextToken ? { context_token: contextToken } : {}), item_list: [{ type: 1, text_item: { text: message_id } }] });
const waitForWeixin = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(condition(), "Weixin poll did not reach the expected checkpoint");
};
const pendingWeixinPoll = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) =>
  signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
{
  const cursors: string[] = [], received: string[] = [], statuses: string[] = [], sentTokens: string[] = [];
  const freshContext = "fresh-context-fixture";
  const encoded = new WeixinIlinkAdapter("encoding-weixin", "微信", {
    replySecrets: gatewayReplySecretCodec, onStatus: status => statuses.push(status),
    fetch: async (url, init) => {
      if (String(url).endsWith("sendmessage")) {
        sentTokens.push(JSON.parse(String(init?.body)).msg.context_token);
        return new Response(JSON.stringify({ ret: 0 }));
      }
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      if (cursors.length === 1) return new Response(JSON.stringify({ ret: 0, get_updates_buf: "after-rejections", msgs: [
        weixinMessage("quote", oversizedCapabilities[0]), weixinMessage("unicode", oversizedCapabilities[1]),
        weixinMessage("good", freshContext), weixinMessage("quote", oversizedCapabilities[0]), weixinMessage("following"),
      ] }));
      return pendingWeixinPoll(init?.signal);
    },
  });
  encoded.setInboundHandler(async message => {
    received.push(message.messageId!);
    assert(oversizedCapabilities.every(capability => !JSON.stringify(message.replyRoute).includes(capability)));
    await message.reply("accepted");
  });
  try {
    await encoded.connect(weixinConfig);
    await waitForWeixin(() => cursors.length === 2);
    assert.deepEqual(cursors, ["", "after-rejections"], "permanent capability rejection must advance the poll cursor");
    assert.deepEqual(received, ["good", "following"], "rejected capabilities never reach the agent or block later messages");
    assert.equal(statuses.filter(status => status.includes("已拒绝此消息")).length, 2);
    assert(oversizedCapabilities.every(capability => !statuses.join(" ").includes(capability)), "diagnostics must not expose capability contents");
    assert.equal(sentTokens.length, 2);
    assert(sentTokens.every(value => value === freshContext), "a rejected duplicate cannot overwrite the newer usable context");
  } finally { await encoded.disconnect(); }
}
for (const outage of ["keyring", "encryption"] as const) {
  const cursors: string[] = [], received: string[] = [], statuses: string[] = [];
  const encryptString = safeStorage.encryptString;
  const recoverStorage = () => { setEncryptionAvailable(true); safeStorage.encryptString = encryptString; };
  if (outage === "keyring") setEncryptionAvailable(false);
  else safeStorage.encryptString = () => { throw new Error("private encryption backend failure"); };
  assert.throws(() => gatewayReplySecretCodec.seal("valid-capability"), error => error instanceof Error && !(error instanceof GatewayRouteEncodingError));
  const recovering = new WeixinIlinkAdapter("recovering-weixin", "微信", {
    replySecrets: gatewayReplySecretCodec, onStatus: status => statuses.push(status),
    fetch: async (_url, init) => {
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      if (cursors.length === 2) recoverStorage();
      if (cursors.length <= 2) return new Response(JSON.stringify({ ret: 0, get_updates_buf: "committed-after-recovery", msgs: [
        weixinMessage("first", "recoverable-context-fixture"), weixinMessage("second", "recoverable-context-fixture"),
      ] }));
      return pendingWeixinPoll(init?.signal);
    },
  });
  recovering.setInboundHandler(message => {
    received.push(message.messageId!);
    return Object.assign(Promise.resolve(), { accepted: Promise.resolve() });
  });
  try {
    await recovering.connect(weixinConfig);
    await waitForWeixin(() => cursors.length === 3);
    assert.deepEqual(cursors, ["", "", "committed-after-recovery"], "storage failures must retry the original cursor before checkpointing");
    assert.deepEqual(received, ["first", "second"], "both inputs survive the storage outage and are admitted exactly once");
    assert(statuses.some(status => status.includes("暂时失败")));
    assert(!statuses.some(status => status.includes("已拒绝此消息") || status.includes("private encryption")));
  } finally { recoverStorage(); await recovering.disconnect(); }
}
console.log("PASS Weixin terminal route encoding rejection, safe diagnostics and keyring/encryption outage replay");

class TestTelegram extends TelegramChannelAdapter {
  live = false;
  handler?: GatewayInboundHandler;
  receivedConfig: ChannelConfig = {};
  connectError?: Error;
  workText = "";
  override setInboundHandler(handler: GatewayInboundHandler): void { this.handler = handler; }
  override async connect(config: ChannelConfig): Promise<void> {
    this.receivedConfig = config; this.live = true;
    if (this.connectError) throw this.connectError;
  }
  override async disconnect(): Promise<void> { this.live = false; }
  override isConnected(): boolean { return this.live; }
  override workConnectionKey(): string | undefined { return this.live ? "a".repeat(64) : undefined; }
  override async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    input.assertCurrent(); this.workText = input.text; return { ok: true, receipt: "fixture-receipt" };
  }
}
const directory = mkdtempSync(join(tmpdir(), "gateway-security-"));
const db = new AppDatabase(join(directory, "test.db"));
const adapter = new TestTelegram("telegram-default", "Telegram");
let fail = false;
const gateway = new GatewayService(db, { runGatewayTurn: async () => {
  if (fail) throw new Error(`request ${token} https://api.telegram.org/bot${token}/sendMessage`);
  return `answer ${token}`;
} }, undefined, { adapters: { telegram: adapter } });
try {
  await gateway.connect(adapter.id, { botToken: token, allowUsers: ["owner"] });
  assert.equal(JSON.parse(db.listGatewayChannels()[0].configJson).botToken, undefined);
  assert.equal(gateway.getChannelConfig(adapter.id).config.botToken, "••••••");
  const replies: string[] = [];
  await adapter.handler!({ channelId: adapter.id, chatId: "123", messageId: "first", sender: { id: "owner" },
    text: "hello", reply: async text => { replies.push(text); } });
  assert.equal(replies[0], "answer [凭据已隐藏]", "provider reply is filtered before its outbox");
  fail = true;
  await adapter.handler!({ channelId: adapter.id, chatId: "123", messageId: "second", sender: { id: "owner" },
    text: "error", reply: async text => { replies.push(text); } });
  assert(!replies[1].includes(token)); assert(!replies[1].includes("api.telegram.org"));
  await gateway.sendWorkNotification({ target: { version: 1, channelType: "telegram", channelId: adapter.id,
    connectionKey: "a".repeat(64), chatId: "123", senderId: "owner", address: { chatId: "123" } },
    text: `work ${token}`, effectKey: "fixture", assertCurrent: () => {} });
  assert.equal(adapter.workText, "work [凭据已隐藏]");
  assert(!JSON.stringify(gateway.listMessages({})).includes(token), "history/UI never persist leaked outgoing secrets");
  await gateway.disconnect(adapter.id);
  assert.equal(gateway.getChannelConfig(adapter.id).config.botToken, "••••••", "disconnect keeps encrypted configuration");
  await gateway.connect(adapter.id, { botToken: "••••••", allowUsers: ["owner"] });
  assert.equal(adapter.receivedConfig.botToken, token);
  await gateway.stop();
  await gateway.restoreChannels();
  assert.equal(adapter.receivedConfig.botToken, token);
  await gateway.stop();
  const row = db.listGatewayChannels()[0];
  db.upsertGatewayChannel({ ...row, connected: true, configJson: JSON.stringify({ botToken: token, allowUsers: ["owner"] }) });
  await gateway.restoreChannels();
  assert.equal(JSON.parse(db.listGatewayChannels()[0].configJson).botToken, undefined, "legacy plaintext is sealed before restore");
  adapter.connectError = new Error(`provider rejected ${token} https://api.telegram.org/bot${token}`);
  await assert.rejects(gateway.connect(adapter.id, { botToken: token }), error => {
    assert(error instanceof Error); assert(!error.message.includes(token)); assert(!error.message.includes("api.telegram.org"));
    return true;
  });
  assert.equal(adapter.live, false, "failed replacement connection is disconnected before exposing its sanitized error");
} finally { await gateway.stop(); db.close(); rmSync(directory, { recursive: true, force: true }); }
console.log("PASS actual Service reply/error/Work/history boundary, masked reconnect and encrypted restore");

const lifecycle = new GatewayLifecycleManager({
  feishu: { handleWebhookPayload: async () => { throw new Error(`Bearer ${token}`); } },
  wecom: { handleHttp: async () => ({ status: 200, body: "ok" }) },
  wechat: { handleHttp: async () => ({ status: 200, body: "ok" }) },
  safeError: error => secrets.error(error),
});
lifecycle.port = 0;
try {
  await Promise.all([lifecycle.start(), lifecycle.start()]);
  const address = lifecycle.server!.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const invalid = await fetch(url + "/feishu", { method: "POST", body: "bad json" });
  assert.equal(invalid.status, 400);
  const denied = await fetch(url + "/feishu-unrelated", { method: "POST", body: "{}" });
  assert.equal(denied.status, 404);
  const failed = await fetch(url + "/feishu", { method: "POST", body: "{}" });
  assert.equal(failed.status, 500); assert(!(await failed.text()).includes(token));
  const alive = await fetch(url + "/wecom");
  assert.equal(alive.status, 200, "one rejected async webhook does not poison the listener");
} finally { await lifecycle.stop(); }
assert.equal(lifecycle.server, null);
console.log("PASS concurrent listener start, exact routes, async rejection containment and shutdown");
