import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { WeixinIlinkAdapter } from "../src/main/gateway/WeixinIlinkAdapter";
import { WeixinQrLogin, type WeixinCredentials, type WeixinQrState } from "../src/main/gateway/WeixinQrLogin";
import { openGatewayProviderConfig } from "../src/main/gateway/GatewayProviderConfig";
import { setEncryptionAvailable, setStorageBackend } from "./gateway-electron-stub";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";

type WeixinQrOptions = ConstructorParameters<typeof WeixinQrLogin>[0];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const credentials: WeixinCredentials = { accountId: "123", botToken: "fixture-secret-not-for-renderer", userId: "scan-owner", baseUrl: "https://ilinkai.weixin.qq.com" };
class FakeAdapter extends WeixinIlinkAdapter {
  live = false; active = false; connections = 0; capturedInbound?: GatewayInboundHandler; wait?: ReturnType<typeof deferred>;
  override setInboundHandler(handler: GatewayInboundHandler): void { this.capturedInbound = handler; }
  override async connect(): Promise<void> { this.connections++; this.active = false; if (this.wait) await this.wait.promise; this.live = true; }
  override activate(): void { assert(this.live); this.active = true; }
  override async disconnect(): Promise<void> { this.live = false; this.active = false; }
  override isConnected(): boolean { return this.live; }
  override workConnectionKey(): string | undefined { return this.live && this.active ? "b".repeat(64) : undefined; }
}
class FakeLogin extends WeixinQrLogin {
  view: WeixinQrState = { status: "idle" }; starts = 0;
  fakeController = new AbortController();
  constructor(readonly callbacks: WeixinQrOptions) { super(callbacks); }
  override getState(): WeixinQrState { return { ...this.view }; }
  override async start(approved: boolean): Promise<WeixinQrState> {
    assert.equal(approved, true); this.fakeController = new AbortController();
    this.view = { status: "waiting", sessionId: `session-${++this.starts}`, qrUrl: "https://q.qq.com/test" }; return this.getState();
  }
  override cancel(sessionId?: string): void {
    if (sessionId && sessionId !== this.view.sessionId) return;
    this.fakeController.abort(); this.view = { status: "cancelled", sessionId: this.view.sessionId };
  }
  async authorize(value = credentials): Promise<void> {
    const signal = this.fakeController.signal;
    this.view = { ...this.view, status: "scanned", qrUrl: undefined };
    await this.callbacks.onAuthorized(value, () => { if (signal.aborted) throw new Error("cancelled"); }, signal);
    if (!signal.aborted) this.view = { status: "authorized", sessionId: this.view.sessionId };
  }
}
const root = mkdtempSync(join(tmpdir(), "qq-qr-integration-"));
const db = new AppDatabase(join(root, "test.db"));
const adapter = new FakeAdapter("weixin-default", "Weixin");
let login!: FakeLogin;
const authorities: Array<string | undefined> = [];
const service = new GatewayService(db, { runGatewayTurn: async ({ gatewayOrigin }) => {
  authorities.push(gatewayOrigin.personalMemoryBindingId);
  return "fixture reply";
} }, undefined,
  { adapters: { weixin: adapter }, weixinQrLoginFactory: options => (login = new FakeLogin(options)) });
const sendPrivate = async (messageId: string) => {
  const replies: string[] = [];
  await adapter.capturedInbound!({ channelId: adapter.id, chatId: credentials.userId, sender: { id: credentials.userId },
    audience: "private", messageId, text: "private fixture", replyRoute: { kind: "weixin", peer: credentials.userId },
    reply: async text => { replies.push(text); } });
  assert.deepEqual(replies, ["fixture reply"]);
};
try {
  await assert.rejects(service.startWeixinQrLogin(false)); assert.equal(login.starts, 0);
  setEncryptionAvailable(false);
  await assert.rejects(service.startWeixinQrLogin(true)); assert.equal(login.starts, 0);
  setEncryptionAvailable(true);
  setStorageBackend("basic_text");
  await assert.rejects(service.startWeixinQrLogin(true)); assert.equal(login.starts, 0);
  setStorageBackend("gnome_libsecret");
  await assert.rejects(service.connect("weixin-default", { ...credentials, allowUsers: ["anyone"] }));
  assert.equal(adapter.connections, 0);
  const state = await service.startWeixinQrLogin(true, true);
  assert.equal(state.state, "waiting");
  await login.authorize();
  assert.equal(adapter.active, true);
  const row = db.listGatewayChannels().find(value => value.id === "weixin-default")!;
  const saved = JSON.parse(row.configJson);
  assert.equal(saved.botToken, undefined);
  assert.deepEqual(saved.allowUsers, [credentials.userId]);
  assert.equal(openGatewayProviderConfig("weixin", saved).botToken, credentials.botToken);
  assert.equal(service.getChannelConfig("weixin-default").config.botToken, "••••••");
  Object.assign(login.view, { botToken: credentials.botToken, token: "private-token" });
  assert(!JSON.stringify(service.getWeixinQrLoginState()).includes(credentials.botToken));
  assert.equal((service.getWeixinQrLoginState() as unknown as Record<string, unknown>).token, undefined);
  assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);
  await adapter.capturedInbound!({ channelId: adapter.id, chatId: "other", sender: { id: "not-scanner" }, text: "ignored", reply: async () => {} });
  assert.equal(authorities.length, 0);
  await sendPrivate("approved");
  const firstBinding = authorities.at(-1);
  assert(firstBinding, "verified QR enrollment selected the authorized Dots memory identity");
  await service.stop();
  await service.restoreChannels();
  assert(adapter.active); assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);
  await sendPrivate("restored");
  assert.equal(authorities.at(-1), firstBinding);

  const original = db.listGatewayChannels().find(value => value.id === "weixin-default")!.configJson;
  await service.startWeixinQrLogin(true);
  adapter.wait = deferred();
  const binding = login.authorize({ ...credentials, accountId: "456" });
  const cancelled = service.cancelWeixinQrLogin(login.getState().sessionId);
  adapter.wait.resolve();
  await assert.rejects(binding); await cancelled; adapter.wait = undefined;
  assert.equal(adapter.active, false);
  assert.equal(db.listGatewayChannels().find(value => value.id === "weixin-default")!.configJson, original);

  await service.startWeixinQrLogin(true);
  const save = db.upsertGatewayChannel.bind(db);
  db.upsertGatewayChannel = () => { throw new Error("fixture storage failure"); };
  await assert.rejects(login.authorize({ ...credentials, accountId: "789" }));
  db.upsertGatewayChannel = save;
  assert.equal(adapter.active, false);
  assert.equal(db.listGatewayChannels().find(value => value.id === "weixin-default")!.configJson, original);

  const newer = await service.startWeixinQrLogin(true);
  await service.cancelWeixinQrLogin("old-session");
  assert.equal(service.getWeixinQrLoginState().sessionId, newer.sessionId);
  assert.equal(service.getWeixinQrLoginState().state, "waiting");
  await service.disconnect("weixin-default");
  assert.equal(service.getWeixinQrLoginState().state, "cancelled");
  assert.equal(db.listGatewayChannels().find(value => value.id === "weixin-default")!.connected, false);
  assert.equal(service.getChannelConfig("weixin-default").config.botToken, "••••••");
  await service.startWeixinQrLogin(true);
  await login.authorize();
  await sendPrivate("ordinary-only");
  assert.equal(authorities.at(-1), undefined, "QR transport authorization alone does not approve personal memory");
  console.log("Dots QR binding PASS: explicit personal-memory opt-in, native route admission, cold grant restore and ordinary reauthorization");
  console.log("Weixin QR integration PASS: explicit consent, encrypted persistence, owner allowlist, activation, cancellation, restore and no HTTP listener");
} finally { await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); setEncryptionAvailable(true); }
