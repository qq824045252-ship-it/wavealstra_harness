import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { QQChannelAdapter } from "../src/main/gateway/QQChannelAdapter";
import { QQBotQrLogin, type QQBotQrLoginOptions, type QQBoundCredentials, type QQQrLoginState } from "../src/main/gateway/QQBotQrLogin";
import { openGatewayProviderConfig } from "../src/main/gateway/GatewayProviderConfig";
import { setEncryptionAvailable, setStorageBackend } from "./gateway-electron-stub";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const credentials: QQBoundCredentials = { appId: "123", appSecret: "fixture-secret-not-for-renderer", userOpenid: "scan-owner" };
class FakeAdapter extends QQChannelAdapter {
  live = false; active = false; connections = 0; capturedInbound?: GatewayInboundHandler; wait?: ReturnType<typeof deferred>;
  override setInboundHandler(handler: GatewayInboundHandler): void { this.capturedInbound = handler; }
  override async connect(): Promise<void> { this.connections++; this.active = false; if (this.wait) await this.wait.promise; this.live = true; }
  override activate(): void { assert(this.live); this.active = true; }
  override async disconnect(): Promise<void> { this.live = false; this.active = false; }
  override isConnected(): boolean { return this.live; }
  override workConnectionKey(): string | undefined { return this.live && this.active ? "b".repeat(64) : undefined; }
}
class FakeLogin extends QQBotQrLogin {
  view: QQQrLoginState = { state: "idle", message: "idle" }; starts = 0;
  controller = new AbortController();
  constructor(readonly callbacks: QQBotQrLoginOptions) { super(callbacks); }
  override getState(): QQQrLoginState { return { ...this.view }; }
  override async start(approved: boolean): Promise<QQQrLoginState> {
    assert.equal(approved, true); this.controller = new AbortController();
    this.view = { state: "waiting", sessionId: `session-${++this.starts}`, qrUrl: "https://q.qq.com/test", message: "scan" }; return this.getState();
  }
  override cancel(sessionId?: string): void {
    if (sessionId && sessionId !== this.view.sessionId) return;
    this.controller.abort(); this.view = { state: "cancelled", sessionId: this.view.sessionId, message: "cancelled" };
  }
  async authorize(value = credentials): Promise<void> {
    const signal = this.controller.signal;
    this.view = { ...this.view, state: "binding", qrUrl: undefined };
    await this.callbacks.onAuthorized(value, () => { if (signal.aborted) throw new Error("cancelled"); }, signal);
    if (!signal.aborted) this.view = { state: "connected", sessionId: this.view.sessionId, appId: value.appId, message: "connected" };
  }
}
const root = mkdtempSync(join(tmpdir(), "qq-qr-integration-"));
const db = new AppDatabase(join(root, "test.db"));
const adapter = new FakeAdapter("qq-default", "QQ");
let login!: FakeLogin;
let turns = 0;
const service = new GatewayService(db, { runGatewayTurn: async () => { turns++; throw new Error("unexpected"); } }, undefined,
  { adapters: { qq: adapter }, qqQrLoginFactory: options => (login = new FakeLogin(options)) });
try {
  await assert.rejects(service.startQQQrLogin(false)); assert.equal(login.starts, 0);
  setEncryptionAvailable(false);
  await assert.rejects(service.startQQQrLogin(true)); assert.equal(login.starts, 0);
  setEncryptionAvailable(true);
  setStorageBackend("basic_text");
  await assert.rejects(service.startQQQrLogin(true)); assert.equal(login.starts, 0);
  setStorageBackend("gnome_libsecret");
  await assert.rejects(service.connect("qq-default", { ...credentials, allowUsers: ["anyone"] }));
  assert.equal(adapter.connections, 0);
  const state = await service.startQQQrLogin(true);
  assert.equal(state.state, "waiting");
  await login.authorize();
  assert.equal(adapter.active, true);
  const row = db.listGatewayChannels().find(value => value.id === "qq-default")!;
  const saved = JSON.parse(row.configJson);
  assert.equal(saved.appSecret, undefined);
  assert.deepEqual(saved.allowUsers, [credentials.userOpenid]);
  assert.equal(openGatewayProviderConfig("qq", saved).appSecret, credentials.appSecret);
  assert.equal(service.getChannelConfig("qq-default").config.appSecret, "••••••");
  Object.assign(login.view, { appSecret: credentials.appSecret, token: "private-token" });
  assert(!JSON.stringify(service.getQQQrLoginState()).includes(credentials.appSecret));
  assert.equal((service.getQQQrLoginState() as unknown as Record<string, unknown>).token, undefined);
  assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);
  await adapter.capturedInbound!({ channelId: adapter.id, chatId: "other", sender: { id: "not-scanner" }, text: "ignored", reply: async () => {} });
  assert.equal(turns, 0);
  await service.stop();
  await service.restoreChannels();
  assert(adapter.active); assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);

  const original = db.listGatewayChannels().find(value => value.id === "qq-default")!.configJson;
  await service.startQQQrLogin(true);
  adapter.wait = deferred();
  const binding = login.authorize({ ...credentials, appId: "456" });
  const cancelled = service.cancelQQQrLogin(login.getState().sessionId);
  adapter.wait.resolve();
  await assert.rejects(binding); await cancelled; adapter.wait = undefined;
  assert.equal(adapter.active, false);
  assert.equal(db.listGatewayChannels().find(value => value.id === "qq-default")!.configJson, original);

  await service.startQQQrLogin(true);
  const save = db.upsertGatewayChannel.bind(db);
  db.upsertGatewayChannel = () => { throw new Error("fixture storage failure"); };
  await assert.rejects(login.authorize({ ...credentials, appId: "789" }));
  db.upsertGatewayChannel = save;
  assert.equal(adapter.active, false);
  assert.equal(db.listGatewayChannels().find(value => value.id === "qq-default")!.configJson, original);

  const newer = await service.startQQQrLogin(true);
  await service.cancelQQQrLogin("old-session");
  assert.equal(service.getQQQrLoginState().sessionId, newer.sessionId);
  assert.equal(service.getQQQrLoginState().state, "waiting");
  await service.disconnect("qq-default");
  assert.equal(service.getQQQrLoginState().state, "cancelled");
  assert.equal(db.listGatewayChannels().find(value => value.id === "qq-default")!.connected, false);
  assert.equal(service.getChannelConfig("qq-default").config.appSecret, "••••••");
  console.log("QQ QR integration PASS: explicit consent, encrypted persistence, owner allowlist, activation, cancellation, restore and no HTTP listener");
} finally { await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); setEncryptionAvailable(true); }
