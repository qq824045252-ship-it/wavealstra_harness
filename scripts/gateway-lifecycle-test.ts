import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { GatewayDeliveryJournal } from "../src/main/gateway/GatewayDeliveryJournal";
import { gatewaySessionQueueKey } from "../src/main/gateway/GatewayPlatformRegistry";
import { openGatewayProviderConfig, sealGatewayProviderConfig, validateGatewayProviderConfig } from "../src/main/gateway/GatewayProviderConfig";
import { gatewayConnectionKey } from "../src/main/gateway/work-outbound";
import type { ChannelConfig, GatewayInboundMessage } from "../src/main/gateway/channels";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const mpConfig = { appId: "wx-lifecycle-fixture", appSecret: "mp-lifecycle-secret", token: "mp-lifecycle-verify",
  encodingAESKey: "a".repeat(43), allowUsers: ["owner"] };

/** Real Service, SQLite, Telegram and MP lifecycle; only provider HTTP is faked. */
async function fixture(run: (value: {
  db: AppDatabase;
  gateway: GatewayService;
  counters: { turns: number; replies: number; mpAuthorizations: number };
  holdGetMe(token: string): ReturnType<typeof deferred> & { entered: Promise<void> };
  holdMpAuthorization(): ReturnType<typeof deferred> & { entered: Promise<void> };
  track<T>(operation: Promise<T>): Promise<unknown>;
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "gateway-lifecycle-"));
  const db = new AppDatabase(join(directory, "test.db"));
  const counters = { turns: 0, replies: 0, mpAuthorizations: 0 };
  const operations: Promise<unknown>[] = [];
  const authGates = new Map<string, { hold: ReturnType<typeof deferred>; entered: ReturnType<typeof deferred> }>();
  const polls: Array<(response: Response) => void> = [];
  const originalFetch = globalThis.fetch;
  const hold = (key: string) => {
    const gate = { hold: deferred(), entered: deferred() };
    authGates.set(key, gate);
    return { ...gate.hold, entered: gate.entered.promise };
  };
  globalThis.fetch = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.telegram.org") {
      const token = url.pathname.split("/")[1].slice("bot".length);
      if (url.pathname.endsWith("/getMe")) {
        const gate = authGates.get(token);
        if (gate) { gate.entered.release(); await gate.hold.promise; }
        return json({ ok: true, result: { id: Number(token.split(":")[0]), username: "lifecycle_fixture" } });
      }
      if (url.pathname.endsWith("/getUpdates")) return new Promise<Response>(resolve => { polls.push(resolve); });
      if (url.pathname.endsWith("/sendMessage")) {
        counters.replies++;
        return json({ ok: true, result: { message_id: 1 } });
      }
    }
    if (url.hostname === "api.weixin.qq.com" && url.pathname === "/cgi-bin/token") {
      counters.mpAuthorizations++;
      const gate = authGates.get("mp");
      if (gate) { gate.entered.release(); await gate.hold.promise; }
      return json({ access_token: "mp-lifecycle-access", expires_in: 7200 });
    }
    if (url.hostname === "api.weixin.qq.com" && url.pathname === "/cgi-bin/message/custom/send") {
      counters.replies++;
      return json({ errcode: 0 });
    }
    throw new Error("Unexpected provider request in lifecycle fixture");
  };
  const gateway = new GatewayService(db, { runGatewayTurn: async () => { counters.turns++; return "saved answer"; } });
  try {
    await run({ db, gateway, counters, holdGetMe: token => hold(token), holdMpAuthorization: () => hold("mp"),
      track: operation => {
        // Cancellation is an expected result in these races; observe it as soon
        // as the operation starts, before releasing a deferred HTTP response.
        const settled = operation.then(() => undefined, error => error);
        operations.push(settled);
        return settled;
      } });
  } finally {
    await gateway.stop();
    for (const gate of authGates.values()) gate.hold.release();
    await within(Promise.all(operations), "outstanding lifecycle operations");
    // Also clean up an incorrectly revived listener when an assertion fails.
    await gateway.stop();
    for (const resolve of polls) resolve(json({ ok: true, result: [] }));
    await new Promise(resolve => setImmediate(resolve));
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function saveConnected(db: AppDatabase, type: "telegram" | "wechat", config: ChannelConfig): void {
  db.upsertGatewayChannel({ id: `${type}-default`, type, name: type, connected: true,
    configJson: JSON.stringify(sealGatewayProviderConfig(type, validateGatewayProviderConfig(type, config))) });
}

for (const action of ["stop", "suspend"] as const) {
  await fixture(async ({ db, gateway, counters, holdGetMe, track }) => {
    saveConnected(db, "telegram", { botToken: "9001:lifecycle-first", allowUsers: ["1"] });
    saveConnected(db, "wechat", mpConfig);
    const journal = new GatewayDeliveryJournal(db.connection);
    const accountKey = gatewayConnectionKey("wechat", [mpConfig.appId]);
    const pending: GatewayInboundMessage = { channelId: "wechat-default", chatId: "owner", messageId: "queued-before-start",
      text: "preserved native input", sender: { id: "owner" }, replyRoute: { kind: "wechat", openId: "owner" }, reply: async () => {} };
    const { entry } = journal.accept({ platform: "wechat", accountKey,
      sessionKey: gatewaySessionQueueKey({ id: "wechat-default", type: "wechat" }, accountKey, pending),
      message: pending, replayNativeReceipts: true });
    const first = holdGetMe("9001:lifecycle-first");
    const restoring = track(gateway.restoreChannels());
    await within(first.entered, "first restored provider authorization");
    await within(gateway[action](), action);
    first.release();
    await within(restoring, "cancelled restore");
    assert.equal(counters.mpAuthorizations, 0, `${action} must cancel the remaining restore loop`);
    assert.equal(gateway.status().running, false);
    assert(gateway.status().channels.every(channel => !channel.connected), "no late channel activation");
    assert.equal((gateway as unknown as { webhookServer: unknown }).webhookServer, null, "no listener revival after cancellation");
    assert.equal(counters.turns, 0, "a cancelled restore cannot execute the saved native input");
    assert.equal(counters.replies, 0);
    assert.equal(journal.get(entry.delivery_id)?.status, "pending", "the accepted input must remain recoverable");

    assert.equal(await within(track(gateway.restoreChannels()), "explicit fresh restore"), undefined);
    await until(() => journal.get(entry.delivery_id)?.status === "completed", "saved input after explicit restore");
    assert.equal(counters.turns, 1, "a new authorized restore executes the retained input exactly once");
    assert.equal(counters.replies, 1);
  });
  console.log(`PASS ${action} cancels stale multi-provider restore, listener and pending execution; explicit restore recovers once`);
}

await fixture(async ({ db, gateway, counters, holdMpAuthorization, track }) => {
  const authorization = holdMpAuthorization();
  const connecting = track(gateway.connect("wechat-default", mpConfig));
  await within(authorization.entered, "MP connect authorization");
  await within(gateway.stop(), "stop during connect");
  authorization.release();
  assert(await within(connecting, "cancelled connect") instanceof Error, "a stale connect must not report success");
  assert.equal(gateway.status().running, false);
  assert(gateway.status().channels.every(channel => !channel.connected), "late connect must not retain a live adapter");
  assert.equal((gateway as unknown as { webhookServer: unknown }).webhookServer, null);
  assert(!db.listGatewayChannels().some(row => row.connected), "cancelled connect must not save new enabled credentials");
  assert.equal(counters.turns, 0); assert.equal(counters.replies, 0);
});
console.log("PASS stop during direct webhook connect prevents late activation and config commit");

await fixture(async ({ db, gateway, holdGetMe, track }) => {
  const first = holdGetMe("9001:lifecycle-old");
  const oldConnect = track(gateway.connect("telegram-default", { botToken: "9001:lifecycle-old", allowUsers: ["1"] }));
  await within(first.entered, "older Telegram connect");
  assert.equal(await within(track(gateway.connect("telegram-default", { botToken: "9002:lifecycle-current", allowUsers: ["2"] })),
    "newer Telegram connect"), undefined);
  first.release();
  assert(await within(oldConnect, "superseded Telegram connect") instanceof Error);
  assert.equal(gateway.status().channels.find(channel => channel.id === "telegram-default")?.connected, true,
    "an older cancelled operation cannot disconnect the newer account");
  const saved = db.listGatewayChannels().find(row => row.id === "telegram-default")!;
  assert.equal(openGatewayProviderConfig("telegram", JSON.parse(saved.configJson)).botToken, "9002:lifecycle-current");
  const target = { version: 1 as const, channelType: "telegram" as const, channelId: "telegram-default",
    connectionKey: gatewayConnectionKey("telegram", ["9002"]), chatId: "2", senderId: "2", address: { chatId: "2" } };
  assert.equal(gateway.checkWorkTarget(target), undefined, "the newer account's allowlist remains active");
  assert.match(gateway.checkWorkTarget({ ...target, senderId: "1" }) ?? "", /允许名单/);
});
console.log("PASS superseded connect failure preserves the newer account, encrypted credentials and allowlist");
