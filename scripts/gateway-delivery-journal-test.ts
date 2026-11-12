import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayDeliveryJournal } from "../src/main/gateway/GatewayDeliveryJournal";
import { GatewayPlatformRegistry, gatewaySessionQueueKey, type RegisteredGatewayAdapter } from "../src/main/gateway/GatewayPlatformRegistry";
import { GatewayReplyNotSentError, type GatewayReplyRestoreInput } from "../src/main/gateway/GatewayReply";
import { WechatMpChannelAdapter, WecomChannelAdapter, type GatewayInboundHandler, type GatewayInboundMessage } from "../src/main/gateway/channels";
import { WxCrypt } from "../src/main/gateway/wx-crypt";
import { assertGatewayWorkSend, type GatewayWorkSendInput, type GatewayWorkSendResult } from "../src/main/gateway/work-outbound";

class Adapter implements RegisteredGatewayAdapter {
  readonly id = "telegram-default";
  readonly type = "telegram" as const;
  readonly name = "fixture";
  key = "a".repeat(64);
  generation = 1;
  live = true;
  inbound!: GatewayInboundHandler;
  sent: string[] = [];
  send: (text: string) => Promise<void> = async text => { this.sent.push(text); };
  connect = async () => { this.live = true; };
  disconnect = async () => { this.live = false; this.generation++; };
  isConnected = () => this.live;
  statusText = () => "fixture";
  gatewayConnectionGeneration = () => this.generation;
  workConnectionKey = () => this.live ? this.key : undefined;
  setInboundHandler(handler: GatewayInboundHandler): void { this.inbound = handler; }
  restoreGatewayReply(input: GatewayReplyRestoreInput): (text: string) => Promise<void> {
    assert.equal(input.route?.kind, "telegram");
    const generation = this.generation, key = this.key;
    return async text => {
      if (!this.live || generation !== this.generation || key !== this.key) throw new GatewayReplyNotSentError("fixture connection changed");
      await this.send(text);
    };
  }
  message(id = "1", text = "hello", chatId = "100"): GatewayInboundMessage {
    const generation = this.generation, key = this.key;
    return { channelId: this.id, chatId, messageId: id, text, sender: { id: "owner" },
      replyRoute: { kind: "telegram", chatId, replyToMessageId: Number(id) },
      reply: async answer => {
        if (generation !== this.generation || key !== this.key) throw new GatewayReplyNotSentError("stale captured reply");
        await this.send(answer);
      } };
  }
}
const roots: string[] = [];
const databases: Database.Database[] = [];
const registries: GatewayPlatformRegistry[] = [];
function fixture(options: ConstructorParameters<typeof GatewayDeliveryJournal>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-journal-test-")); roots.push(directory);
  const path = join(directory, "app.db"), media = join(directory, "media"); mkdirSync(media);
  const db = new Database(path); databases.push(db); db.pragma("journal_mode=WAL"); db.pragma("foreign_keys=ON");
  const journal = new GatewayDeliveryJournal(db, { mediaDirectory: media, ...options });
  const adapter = new Adapter();
  const registry = (extra: ConstructorParameters<typeof GatewayPlatformRegistry>[0] = {}) => {
    const value = new GatewayPlatformRegistry({ journal, replayNativeReceipts: true, retryDelayMs: () => 5, ...extra });
    registries.push(value); return value;
  };
  const accept = (message = adapter.message(), replayNativeReceipts = true) => journal.accept({ platform: adapter.type,
    accountKey: adapter.key, sessionKey: gatewaySessionQueueKey(adapter, adapter.key, message), message, replayNativeReceipts }).entry;
  return { db, path, media, journal, adapter, registry, accept };
}
const until = async (check: () => boolean, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error("gateway journal fixture timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
};
let passed = 0;
async function check(name: string, test: () => Promise<void> | void) {
  await test(); passed++; console.log("PASS " + name);
}

try {
  for (const crossedBy of [0, 1]) {
    await check(`retry deadline crossing between recovery queries is not lost (${crossedBy}ms past)`, async () => {
      let clock = 100;
      const now = () => clock, deadline = 101;
      const f = fixture({ now });
      const entry = f.accept();
      f.journal.begin(entry.delivery_id);
      f.journal.queueReply(entry.delivery_id, "saved answer");
      f.journal.beginSend(entry.delivery_id);
      f.journal.sendFailed(entry.delivery_id, { status: "pending", reason: "provider_not_sent", nextAttemptAt: deadline });
      const registry = f.registry({ now });
      registry.register(f.adapter, async () => { assert.fail("outbox recovery must not rerun native work"); });
      const recoverable = f.journal.recoverable.bind(f.journal);
      let crossed = false;
      f.journal.recoverable = (...args) => {
        const rows = recoverable(...args);
        if (!crossed) {
          assert.equal(rows.length, 0, "reply is not yet due at the recovery cutoff");
          clock = deadline + crossedBy;
          crossed = true;
        }
        return rows;
      };
      registry.resume(f.adapter.id);
      assert.equal(f.journal.nextRetryAt(f.adapter.id, f.adapter.key), undefined,
        "already-due outboxes must not create a hot retry loop while queued");
      // No second resume or inbound message may rescue a lost timer.
      await until(() => f.journal.outbox(entry.delivery_id)?.status === "sent");
      assert.equal(crossed, true);
      assert.equal(f.journal.outbox(entry.delivery_id)?.retry_count, 2);
      assert.deepEqual(f.adapter.sent, ["saved answer"]);
      assert.equal(f.journal.get(entry.delivery_id)?.status, "completed");
      registry.suspend();
    });
  }

  await check("canonical queue tuples preserve sessions and cannot collide on delimiters or object field order", () => {
    const adapter = new Adapter();
    assert.equal(gatewaySessionQueueKey(adapter, adapter.key, { chatId: "x:y", taskId: "a" }), gatewaySessionQueueKey(adapter, adapter.key, { taskId: "b", chatId: "x:y" }));
    assert.notEqual(gatewaySessionQueueKey(adapter, "a:b", { chatId: "c" }), gatewaySessionQueueKey(adapter, "a", { chatId: "b:c" }));
    assert.notEqual(gatewaySessionQueueKey({ ...adapter, type: "slack" }, adapter.key, { chatId: "chat", taskId: "thread-a" }),
      gatewaySessionQueueKey({ ...adapter, type: "slack" }, adapter.key, { chatId: "chat", taskId: "thread-b" }));
  });

  await check("admission is committed before execution/ACK and completed retries do not call the handler", async () => {
    const f = fixture(); const registry = f.registry();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    registry.register(f.adapter, async event => { calls.push(event.message.messageId!); if (calls.length === 1) await gate; await event.message.reply("answer:" + event.text); });
    const first = f.adapter.inbound(f.adapter.message("1", "first"));
    const second = f.adapter.inbound(f.adapter.message("2", "second"));
    await Promise.all([first.accepted, second.accepted]);
    const read = new Database(f.path, { readonly: true });
    try {
      const states = read.prepare("SELECT status FROM gateway_inbox ORDER BY rowid").all() as Array<{ status: string }>;
      assert.deepEqual(states.map(row => row.status), ["running", "pending"]);
    } finally { read.close(); }
    assert.deepEqual(calls, ["1"]);
    release(); await Promise.all([first, second]);
    await f.adapter.inbound(f.adapter.message("1", "first"));
    assert.deepEqual(calls, ["1", "2"]); assert.deepEqual(f.adapter.sent, ["answer:first", "answer:second"]);
    registry.suspend();
  });

  await check("pending inputs resume with the original IDs; unsafe handler recovery is fenced", async () => {
    const f = fixture(); const pending = f.accept(); const unsafe = f.accept(f.adapter.message("2"), false);
    f.journal.begin(unsafe.delivery_id);
    const registry = f.registry(); let received: GatewayInboundMessage | undefined;
    registry.register(f.adapter, async event => { received = event.message; await event.message.reply("saved"); });
    registry.resume(f.adapter.id); await until(() => f.journal.get(pending.delivery_id)?.status === "completed");
    assert.equal(received?.messageId, "1"); assert.equal(received?.gatewayDelivery?.replay, false);
    assert.equal(f.journal.get(unsafe.delivery_id)?.status, "unknown");
    assert.deepEqual(f.adapter.sent, ["saved"]); registry.suspend();
  });

  await check("native receipt replay marks an interrupted input and does not replace its content", async () => {
    const f = fixture(); const entry = f.accept(); f.journal.begin(entry.delivery_id);
    const registry = f.registry(); let replay = false;
    registry.register(f.adapter, async event => { replay = event.message.gatewayDelivery?.replay === true; await event.message.reply(event.text); });
    registry.resume(f.adapter.id); await until(() => f.journal.get(entry.delivery_id)?.status === "completed");
    assert.equal(replay, true); assert.equal(f.journal.get(entry.delivery_id)?.retry_count, 2);
    const changed = f.adapter.inbound(f.adapter.message("1", "changed"));
    await assert.rejects(changed.accepted!, /不一致/); await assert.rejects(changed, /不一致/);
    assert.deepEqual(f.adapter.sent, ["hello"]); registry.suspend();
  });

  await check("known not-sent replies retry a saved outbox without rerunning native work", async () => {
    const f = fixture(); const registry = f.registry(); let work = 0, attempts = 0;
    f.adapter.send = async text => { if (++attempts < 3) throw new GatewayReplyNotSentError("rate limited", true); f.adapter.sent.push(text); };
    registry.register(f.adapter, async event => { work++; await event.message.reply("saved answer"); });
    await assert.rejects(f.adapter.inbound(f.adapter.message()), /结果已保存/);
    const row = f.db.prepare("SELECT delivery_id FROM gateway_inbox").get() as { delivery_id: string };
    await until(() => f.journal.get(row.delivery_id)?.status === "completed");
    assert.equal(work, 1); assert.equal(attempts, 3); assert.deepEqual(f.adapter.sent, ["saved answer"]);
    registry.suspend();
  });

  await check("unknown provider receipts and interrupted sending are never automatically resent", async () => {
    const f = fixture(); const registry = f.registry(); let work = 0, sends = 0;
    f.adapter.send = async () => { sends++; throw new Error("timeout after provider may have accepted"); };
    registry.register(f.adapter, async event => { work++; await event.message.reply("answer"); });
    await assert.rejects(f.adapter.inbound(f.adapter.message()), /未确认/);
    const row = f.db.prepare("SELECT delivery_id FROM gateway_inbox").get() as { delivery_id: string };
    assert.equal(f.journal.outbox(row.delivery_id)?.status, "unknown");
    registry.resume(f.adapter.id); await assert.rejects(f.adapter.inbound(f.adapter.message()), /未确认/);
    assert.equal(work, 1); assert.equal(sends, 1); registry.suspend();
    const sending = f.accept(f.adapter.message("2")); f.journal.begin(sending.delivery_id); f.journal.queueReply(sending.delivery_id, "in-flight"); f.journal.beginSend(sending.delivery_id);
    const reopened = f.registry(); reopened.register(f.adapter, async () => { assert.fail("uncertain reply cannot rerun the Agent"); });
    reopened.resume(f.adapter.id);
    assert.equal(f.journal.outbox(sending.delivery_id)?.status, "unknown"); assert.equal(sends, 1); reopened.suspend();
  });

  await check("reply retry exhaustion is bounded and retains the unsent answer", async () => {
    const f = fixture(); const registry = f.registry({ maxReplyAttempts: 3 }); let attempts = 0, work = 0;
    f.adapter.send = async () => { attempts++; throw new GatewayReplyNotSentError("rate limited", true); };
    registry.register(f.adapter, async event => { work++; await event.message.reply("answer"); });
    await assert.rejects(f.adapter.inbound(f.adapter.message()));
    await until(() => f.db.prepare("SELECT 1 FROM gateway_outbox WHERE status='failed'").get() !== undefined);
    assert.equal(attempts, 3); assert.equal(work, 1);
    registry.resume(f.adapter.id); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(attempts, 3); registry.suspend();
  });

  await check("same-account reconnect rebinds the original reply route after a long native turn", async () => {
    const f = fixture(); const registry = f.registry(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    registry.register(f.adapter, async event => { await gate; await event.message.reply("after reconnect"); });
    const run = f.adapter.inbound(f.adapter.message()); await run.accepted; await Promise.resolve();
    f.adapter.generation++; registry.resume(f.adapter.id); release(); await run;
    assert.deepEqual(f.adapter.sent, ["after reconnect"]); registry.suspend();
  });

  await check("account replacement cannot run queued old input or send its answer to the new account", async () => {
    const f = fixture(); const first = f.accept();
    const registry = f.registry(); let work = 0;
    registry.register(f.adapter, async event => { work++; await event.message.reply("answer"); });
    f.adapter.key = "b".repeat(64); f.adapter.generation++; registry.resume(f.adapter.id);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(work, 0); assert.equal(f.journal.get(first.delivery_id)?.status, "pending");
    await f.adapter.inbound(f.adapter.message()); assert.equal(work, 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM gateway_inbox").get() as { count: number }).count, 2);
    registry.suspend();
  });

  await check("an internal reconnect recovers accepted work even without a new provider event", async () => {
    const f = fixture(); const entry = f.accept(); const registry = f.registry();
    registry.register(f.adapter, async event => { await event.message.reply("after offline"); });
    f.adapter.live = false; registry.resume(f.adapter.id);
    await new Promise(resolve => setTimeout(resolve, 10)); f.adapter.live = true; f.adapter.generation++;
    await until(() => f.journal.get(entry.delivery_id)?.status === "completed", 7_000);
    assert.deepEqual(f.adapter.sent, ["after offline"]); registry.suspend();
  });

  await check("fresh delivery cannot overtake older committed inputs after an internal reconnect", async () => {
    const f = fixture(); f.accept(f.adapter.message("1", "old"));
    const registry = f.registry(); const calls: string[] = [];
    registry.register(f.adapter, async event => { calls.push(event.text); await event.message.reply(event.text); });
    await f.adapter.inbound(f.adapter.message("2", "fresh"));
    assert.deepEqual(calls, ["old", "fresh"]); assert.deepEqual(f.adapter.sent, ["old", "fresh"]); registry.suspend();
  });

  await check("explicit disconnect pauses recovery until the channel is explicitly resumed", async () => {
    const f = fixture(); const entry = f.accept(); const registry = f.registry(); let work = 0;
    registry.register(f.adapter, async event => { work++; await event.message.reply("resumed"); });
    f.adapter.live = false; registry.resume(f.adapter.id); registry.pause(f.adapter.id);
    f.adapter.live = true; f.adapter.generation++;
    const newInput = f.adapter.inbound(f.adapter.message("2"));
    await assert.rejects(newInput.accepted!, /关闭/); await assert.rejects(newInput, /关闭/);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(work, 0); assert.equal(f.journal.get(entry.delivery_id)?.status, "pending");
    registry.resume(f.adapter.id); await until(() => f.journal.get(entry.delivery_id)?.status === "completed");
    assert.equal(work, 1); registry.suspend();
  });

  await check("corrupt saved reply is terminally fenced rather than causing a hot retry loop", async () => {
    const f = fixture(); const entry = f.accept(); f.journal.begin(entry.delivery_id); f.journal.queueReply(entry.delivery_id, "accepted answer");
    f.db.prepare("UPDATE gateway_outbox SET reply_text='changed' WHERE delivery_id=?").run(entry.delivery_id);
    let reports = 0;
    const registry = f.registry({ onStatus: () => { reports++; } });
    registry.register(f.adapter, async () => { assert.fail("must not re-run work"); });
    registry.resume(f.adapter.id); await until(() => f.journal.outbox(entry.delivery_id)?.status === "failed");
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(reports, 1); assert.equal(f.adapter.sent.length, 0);
    registry.suspend();
  });

  await check("revoked current policy blocks outbox-only recovery and ignores new unauthorized input", async () => {
    const f = fixture(); const entry = f.accept(); f.journal.begin(entry.delivery_id); f.journal.queueReply(entry.delivery_id, "old answer");
    let allowed = false, work = 0;
    const registry = f.registry({ authorize: () => allowed });
    registry.register(f.adapter, async event => { work++; await event.message.reply("new answer"); });
    registry.resume(f.adapter.id);
    await until(() => f.journal.outbox(entry.delivery_id)?.status === "blocked");
    assert.equal(f.adapter.sent.length, 0); assert.equal(work, 0);
    await f.adapter.inbound(f.adapter.message("2"));
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM gateway_inbox").get() as { count: number }).count, 1);
    allowed = true; registry.resume(f.adapter.id); await until(() => f.journal.outbox(entry.delivery_id)?.status === "sent");
    assert.deepEqual(f.adapter.sent, ["old answer"]); assert.equal(work, 0); registry.suspend();
  });

  await check("missing or modified cached attachments cannot silently change a recovered input", async () => {
    const f = fixture(); const bytes = Buffer.from("accepted media"), hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(f.media, hash + ".txt"); writeFileSync(path, bytes);
    const input = { ...f.adapter.message(), attachments: [{ name: "source.txt", path }] };
    const entry = f.accept(input); writeFileSync(path, "tampered");
    const registry = f.registry(); let work = 0;
    registry.register(f.adapter, async () => { work++; }); registry.resume(f.adapter.id);
    assert.equal(f.journal.get(entry.delivery_id)?.status, "blocked"); assert.equal(work, 0); registry.suspend();
    writeFileSync(path, bytes); const answered = f.accept({ ...input, messageId: "2", replyRoute: { kind: "telegram", chatId: "100", replyToMessageId: 2 } });
    f.journal.begin(answered.delivery_id); f.journal.queueReply(answered.delivery_id, "already answered"); unlinkSync(path);
    const outbox = f.registry(); outbox.register(f.adapter, async () => { assert.fail("saved outbox must not need the input file or model"); });
    outbox.resume(f.adapter.id); await until(() => f.journal.outbox(answered.delivery_id)?.status === "sent");
    assert.deepEqual(f.adapter.sent, ["already answered"]); outbox.suspend();
  });

  await check("callback transports cannot acknowledge a failed durable admission", async () => {
    for (const type of ["wechat", "wecom"] as const) {
      const f = fixture({ maxPending: 1 });
      f.accept(); // Fill the bounded persistent inbox without beginning execution.
      const token = "verify", aes = Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""), identity = type === "wechat" ? "app" : "corp";
      const crypt = new WxCrypt(token, aes, identity);
      const adapter = type === "wechat" ? new WechatMpChannelAdapter("wechat-default", "WeChat") : new WecomChannelAdapter("wecom-default", "WeCom");
      Object.assign(adapter, { connected: true, activated: true, crypt, config: { token, appId: "app", corpId: "corp", agentId: "1" } });
      const registry = f.registry(); registry.register(adapter, async () => { assert.fail("full inbox must not execute"); });
      const xml = "<xml><MsgType>text</MsgType><FromUserName>owner</FromUserName><Content>hello</Content><MsgId>2</MsgId></xml>";
      const timestamp = "123", nonce = "nonce", encrypted = crypt.encrypt(xml);
      const query = new URLSearchParams({ timestamp, nonce, msg_signature: crypt.sha1Signature(timestamp, nonce, encrypted) });
      await assert.rejects(adapter.handleHttp({ method: "POST", query, rawBody: `<xml><Encrypt>${encrypted}</Encrypt></xml>` }), /已满/);
      registry.suspend(); await adapter.disconnect();
    }
  });

  await check("detached failures do not become unhandled rejections and do not poison later turns", async () => {
    const registry = new GatewayPlatformRegistry(); registries.push(registry); const adapter = new Adapter();
    const unhandled: unknown[] = []; const record = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", record);
    try {
      registry.register(adapter, async event => { if (event.text === "fail") throw new Error("handler failure"); });
      void adapter.inbound(adapter.message("1", "fail"));
      void adapter.inbound({ ...adapter.message(), channelId: "spoofed" });
      await new Promise(resolve => setTimeout(resolve, 10)); await adapter.inbound(adapter.message("2", "after"));
      assert.deepEqual(unhandled, []);
      await assert.rejects(adapter.inbound(adapter.message("3", "fail")), /handler failure/);
    } finally { process.removeListener("unhandledRejection", record); registry.suspend(); }
  });

  await check("retention only removes terminal receipts and empty display names are optional", () => {
    const f = fixture({ maxReceipts: 1 });
    const pending = f.accept({ ...f.adapter.message("1"), sender: { id: "owner", name: "" } });
    const old = f.accept(f.adapter.message("2")); f.journal.complete(old.delivery_id);
    const next = f.accept(f.adapter.message("3"));
    assert.equal(f.journal.get(old.delivery_id), undefined); assert.equal(f.journal.get(pending.delivery_id)?.status, "pending");
    assert.equal(f.journal.get(next.delivery_id)?.status, "pending");
    assert.equal(f.journal.decode(pending).sender?.name, undefined);
    assert.throws(() => f.accept({ ...f.adapter.message("4"), replyRoute: { kind: "telegram", chatId: "100", sessionWebhook: "secret" } as never }));
  });
  await check("Bot continuation replies reuse the exact original route without rerunning a human turn", async () => {
    const f = fixture(), registry = f.registry(); let turns = 0;
    registry.register(f.adapter, async event => { turns++; await event.message.reply("initial answer"); });
    const original = { ...f.adapter.message("701", "ask another Bot"), audience: "private" as const };
    await f.adapter.inbound(original);
    const origin = { channelId: f.adapter.id, connectionKey: f.adapter.key, chatId: "100", senderId: "owner", messageId: "701", audience: "private" as const };
    await registry.continueBotReply(origin, "return-43", "A summarized B's result");
    await registry.continueBotReply(origin, "return-43", "A summarized B's result");
    assert.deepEqual(f.adapter.sent, ["initial answer", "A summarized B's result"]); assert.equal(turns, 1);
    await assert.rejects(registry.continueBotReply(origin, "return-43", "changed result"), /conflict/);
    await assert.rejects(registry.continueBotReply({ ...origin, senderId: "someone-else" }, "spoof", "not sent"), /原私人/);
    const staged = f.journal.continueReply(origin, "return-after-restart", "persisted answer");
    assert(f.journal.outbox(staged.delivery_id)); registry.suspend();
    const restored = f.registry(); let unexpectedTurns = 0;
    restored.register(f.adapter, async () => { unexpectedTurns++; }); restored.resume(f.adapter.id);
    await until(() => f.journal.outbox(staged.delivery_id)?.status === "sent");
    assert.equal(unexpectedTurns, 0); assert.equal(f.adapter.sent.at(-1), "persisted answer");
    const before = f.adapter.sent.length; f.adapter.key = "b".repeat(64);
    await assert.rejects(restored.continueBotReply(origin, "stale-account", "never retarget"), /原渠道/);
    assert.equal(f.adapter.sent.length, before);
  });
  await check("Slack continuations preserve the authenticated private thread and recover only the response outbox", async () => {
    const f = fixture();
    class SlackAdapter implements RegisteredGatewayAdapter {
      readonly id = "slack-default"; readonly type = "slack" as const; readonly name = "Slack fixture";
      key = "c".repeat(64); sent: GatewayWorkSendInput[] = [];
      connect = async () => {}; disconnect = async () => {};
      isConnected = () => true; statusText = () => "connected"; workConnectionKey = () => this.key;
      setInboundHandler(_handler: GatewayInboundHandler) {}
      async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
        assertGatewayWorkSend(input, this); this.sent.push(input); return { ok: true, receipt: "slack-ts" };
      }
    }
    const adapter = new SlackAdapter(), registry = f.registry();
    let turns = 0; registry.register(adapter, async () => { turns++; });
    const target = { version: 1 as const, channelType: "slack" as const, channelId: adapter.id, connectionKey: adapter.key,
      chatId: "TTEST:DTEST:100.123", senderId: "UOWNER", address: { teamId: "TTEST", appId: "ATEST", channel: "DTEST", threadTs: "100.123" } };
    const origin = { channelId: adapter.id, connectionKey: adapter.key, chatId: target.chatId, senderId: target.senderId,
      messageId: "100.124", audience: "private" as const, workTarget: target };
    await registry.continueBotReply(origin, "slack-return", "A's direct answer");
    await registry.continueBotReply(origin, "slack-return", "A's direct answer");
    assert.equal(turns, 0); assert.equal(adapter.sent.length, 1); assert.deepEqual(adapter.sent[0]?.target, target);
    assert.equal(adapter.sent[0]?.text, "A's direct answer");
    const staged = f.journal.continueReply(origin, "slack-restart", "saved Slack reply"); registry.suspend();
    const restored = f.registry(); restored.register(adapter, async () => { assert.fail("response-only recovery cannot run a human turn"); });
    restored.resume(adapter.id); await until(() => f.journal.outbox(staged.delivery_id)?.status === "sent");
    assert.equal(adapter.sent.length, 2); assert.deepEqual(adapter.sent[1]?.target, target);
    await assert.rejects(restored.continueBotReply({ ...origin, senderId: "UOTHER" }, "slack-forged", "never send"), /原私人/);
    await assert.rejects(restored.continueBotReply({ ...origin, audience: "shared" }, "slack-shared", "never send"), /原私人/);
    const sharedTarget = { ...target, chatId: "TTEST:CTEST:100.123", address: { ...target.address, channel: "CTEST" } };
    await assert.rejects(restored.continueBotReply({ ...origin, chatId: sharedTarget.chatId, workTarget: sharedTarget }, "slack-channel", "never send"), /原私人/);
    adapter.key = "d".repeat(64);
    await assert.rejects(restored.continueBotReply(origin, "slack-account", "never send"), /原渠道/);
    assert.equal(adapter.sent.length, 2); restored.suspend();
  });
  console.log(`Gateway SQLite delivery journal: ${passed} checks passed`);
} finally {
  for (const registry of registries) registry.suspend();
  for (const db of databases) if (db.open) db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
