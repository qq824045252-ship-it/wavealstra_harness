import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { QQChannelAdapter } from "../src/main/gateway/QQChannelAdapter";
import { QQBotQrLogin, type QQBotQrLoginOptions, type QQBoundCredentials, type QQQrLoginState } from "../src/main/gateway/QQBotQrLogin";
import { openGatewayProviderConfig } from "../src/main/gateway/GatewayProviderConfig";
import { setEncryptionAvailable, setStorageBackend } from "./gateway-electron-stub";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { shutdownCoreWorker } from "../src/main/platform/core-client";

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
  override gatewayPreparedConnectionKey(): string | undefined { return this.live ? "b".repeat(64) : undefined; }
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
const coreMode = process.argv.includes("--core");
const native = coreMode ? locateRuntimeAudit(process.cwd()) : undefined;
if (coreMode) assert(native && existsSync(native), "Core QR integration requires the verified worker");
const dbPath = join(root, coreMode ? "app.duckdb" : "test.db");
const db = await AppDatabase.open(dbPath, { runtimeAuditExecutable: native, runtimeAuditSupervised: coreMode });
const readSaved = async () => (await db.readGatewayChannels("qq-default"))[0]!;
if (coreMode) assert.equal(db.fixtureConnection, undefined);
const inheritedHome = process.env.HOME;
const inheritedProfile = process.env.USERPROFILE;
process.env.HOME = root;
process.env.USERPROFILE = root;
const adapter = new FakeAdapter("qq-default", "QQ");
let login!: FakeLogin;
const authorities: Array<string | undefined> = [];
const service = new GatewayService(db, { runGatewayTurn: async ({ gatewayOrigin }) => {
  authorities.push(gatewayOrigin.personalMemoryBindingId);
  return "fixture reply";
} }, undefined,
  { adapters: { qq: adapter }, qqQrLoginFactory: options => (login = new FakeLogin(options)) });
const sendPrivate = async (messageId: string) => {
  const replies: string[] = [];
  await adapter.capturedInbound!({ channelId: adapter.id, chatId: `c2c:${credentials.userOpenid}`, sender: { id: credentials.userOpenid },
    audience: "private", messageId, text: "private fixture", replyRoute: { kind: "qq", recipient: credentials.userOpenid, group: false, messageId, expiresAt: Date.now() + 60_000 },
    reply: async text => { replies.push(text); } });
  assert.deepEqual(replies, ["fixture reply"]);
};
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
  const state = await service.startQQQrLogin(true, true);
  assert.equal(state.state, "waiting");
  await login.authorize();
  assert.equal(adapter.active, true);
  const row = await readSaved();
  const saved = JSON.parse(row.configJson);
  assert.equal(saved.appSecret, undefined);
  assert.deepEqual(saved.allowUsers, [credentials.userOpenid]);
  assert.equal(openGatewayProviderConfig("qq", saved).appSecret, credentials.appSecret);
  assert.equal((await service.getChannelConfig("qq-default")).config.appSecret, "••••••");
  Object.assign(login.view, { appSecret: credentials.appSecret, token: "private-token" });
  assert(!JSON.stringify(service.getQQQrLoginState()).includes(credentials.appSecret));
  assert.equal((service.getQQQrLoginState() as unknown as Record<string, unknown>).token, undefined);
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

  const original = (await readSaved()).configJson;
  await service.startQQQrLogin(true);
  adapter.wait = deferred();
  const binding = login.authorize({ ...credentials, appId: "456" });
  const cancelled = service.cancelQQQrLogin(login.getState().sessionId);
  adapter.wait.resolve();
  await assert.rejects(binding); await cancelled; adapter.wait = undefined;
  assert.equal(adapter.active, false);
  assert.equal((await readSaved()).configJson, original);

  await service.startQQQrLogin(true);
  const save = db.writeGatewayChannel.bind(db);
  db.writeGatewayChannel = async () => { throw new Error("fixture storage failure"); };
  await assert.rejects(login.authorize({ ...credentials, appId: "789" }));
  db.writeGatewayChannel = save;
  assert.equal(adapter.active, false);
  assert.equal((await readSaved()).configJson, original);

  if (coreMode) {
    const written = deferred();
    const received = deferred();
    db.writeGatewayChannel = async (...args) => {
      const result = await save(...args);
      if (args[0].connected) { written.resolve(); await received.promise; }
      return result;
    };
    await service.startQQQrLogin(true, true);
    const late = login.authorize({ ...credentials, appId: "901" });
    await Promise.race([written.promise, late.then(() => assert.fail("QR activated before its held receipt"))]);
    assert.equal(adapter.active, false);
    const cancelling = service.cancelQQQrLogin(login.getState().sessionId);
    received.resolve();
    await assert.rejects(late);
    await cancelling;
    db.writeGatewayChannel = save;
    assert.equal(adapter.active, false);
    assert.equal((await readSaved()).connected, false);
    assert.equal((await readSaved()).configJson, original);
    assert.deepEqual(await db.runtimeAuditReader!.readGatewayAssignment({ channelId: "qq-default", connectionKey: "b".repeat(64),
      chatId: `c2c:${credentials.userOpenid}`, senderId: credentials.userOpenid, messageId: "approved" }),
    { status: "rejected", code: "AUTHORIZATION_CHANGED" });
    console.log("PASS Core QR cancellation after durable save revokes only the committed enrollment and never activates transport");
  }

  const newer = await service.startQQQrLogin(true);
  await service.cancelQQQrLogin("old-session");
  assert.equal(service.getQQQrLoginState().sessionId, newer.sessionId);
  assert.equal(service.getQQQrLoginState().state, "waiting");
  await service.disconnect("qq-default");
  assert.equal(service.getQQQrLoginState().state, "cancelled");
  assert.equal((await readSaved()).connected, false);
  assert.equal((await service.getChannelConfig("qq-default")).config.appSecret, "••••••");
  await service.startQQQrLogin(true);
  await login.authorize();
  await sendPrivate("ordinary-only");
  assert.equal(authorities.at(-1), undefined, "QR transport authorization alone does not approve personal memory");
  console.log("Dots QR binding PASS: explicit personal-memory opt-in, native route admission, cold grant restore and ordinary reauthorization");
  console.log("QQ QR integration PASS: explicit consent, encrypted persistence, owner allowlist, activation, cancellation, restore and no HTTP listener");
} finally {
  await service.stop();
  await db.runtimeAuditReader?.close();
  db.close();
  if (coreMode) await shutdownCoreWorker(root, dbPath);
  if (inheritedHome === undefined) delete process.env.HOME; else process.env.HOME = inheritedHome;
  if (inheritedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = inheritedProfile;
  rmSync(root, { recursive: true, force: true });
  setEncryptionAvailable(true);
}
