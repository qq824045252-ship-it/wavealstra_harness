import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkNotificationHost } from "../src/main/agent/work/WorkNotificationHost";
import type { AsyncWorkNotificationChannel } from "../src/main/agent/work/WorkNotificationDelivery";
import { DiscordGatewayAdapter, type DiscordSocket } from "../src/main/gateway/DiscordGatewayAdapter";
import { gatewayWorkTargetSchema } from "../src/main/gateway/work-outbound";
import { capabilityOfGuarantee } from "../src/shared/bot-work-phase5";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) await turn();
  assert(predicate(), "controlled asynchronous condition did not complete");
}
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
let fixtureSequence = 0;
function harness(path: string) {
  const db = new AppDatabase(path);
  const bots = new BotRegistry(db.connection);
  for (const botId of [DEFAULT_BOT_ID, "next-owner"]) if (!bots.getBot(botId))
    bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
  const state = { authority: true, host: undefined as WorkNotificationHost | undefined };
  const works = new WorkService(db.connection, { bots, isAuthority: () => state.authority,
    emitProjection: () => state.host?.wake() });
  const notice = (name: string, channel: string, targetKey: string) => {
    const suffix = `${name}-${++fixtureSequence}`;
    let work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix,
      authorization: grants, inputSnapshotId: `input:${suffix}`, criteria: [{ text: "Checked evidence" }] }));
    const taskId = `task:${suffix}`;
    db.upsertTask({ id: taskId, title: suffix, updatedAt: Date.now() });
    work = unwrap(works.dispatchExecution(user, { operationId: `dispatch:${suffix}`, workId: work.workId,
      botId: DEFAULT_BOT_ID, taskId, durableStoreKey: `store:${suffix}`, conversationId: "1", workspaceBinding: tmpdir(),
      delegatedScope: ["workspace:read"] }));
    const binding = works.repo.listBindings(work.workId)[0];
    unwrap(works.submitDeliverable({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
      operationId: `result:${suffix}`, workId: work.workId, bindingId: binding.bindingId,
      deliverableId: `deliverable:${suffix}`, summary: name, artifactRefs: [],
      evidence: [{ kind: "tool_receipt", sourceRef: `receipt:${suffix}` }] }));
    unwrap(works.acceptDeliverable(user, { operationId: `accept:${suffix}`, workId: work.workId,
      deliverableId: `deliverable:${suffix}` }));
    works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
    const notification = works.repo.listNotifications(work.workId).find(item => item.kind === "result")!;
    db.connection.prepare("UPDATE work_notifications SET channel=?,target_key=?,created_at=? WHERE notification_id=?")
      .run(channel, targetKey, fixtureSequence, notification.notificationId);
    return { workId: work.workId, notificationId: notification.notificationId };
  };
  return { db, bots, works, state, notice, sent: (id: string) => works.repo.getNotification(id)?.delivery === "sent" };
}
type Harness = ReturnType<typeof harness>;
const endpoint = (channel: string, targetKey: string,
  send: AsyncWorkNotificationChannel["send"]): AsyncWorkNotificationChannel => ({ channel, targetKey,
  ...capabilityOfGuarantee("best-effort-unqueryable"), send });

/** Issue #57: real SQLite/WorkService/Host and real Discord adapter; all external I/O is controlled. */
export async function testWorkNotificationConcurrency(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "work-notification-flights-"));
  let count = 0;
  const check = async (name: string, run: () => Promise<void>) => { await run(); count++; console.log(`PASS ${name}`); };
  try {
    await check("held routes preserve bounded, fair delivery of new routes and new desktop notifications", async () => {
      const h = harness(join(root, "fair.db"));
      const gate = deferred<void>();
      const events: Array<{ event: string; elapsedMs: number }> = [];
      const startedAt = performance.now();
      const record = (event: string) => events.push({ event, elapsedMs: +(performance.now() - startedAt).toFixed(3) });
      const sends: string[] = [];
      let active = 0, peak = 0, providerActive = 0, providerPeak = 0;
      const slow = Array.from({ length: 7 }, (_, index) => h.notice(`slow-${index}`, "provider-one", `slow-${index}`));
      const firstRouteNext = h.notice("same-target-next", "provider-one", "slow-0");
      const fast = h.notice("independent", "provider-two", "fast");
      const channels = slow.map((_, index) => endpoint("provider-one", `slow-${index}`, async ({ notification, assertCurrent }) => {
        active++; providerActive++; peak = Math.max(peak, active); providerPeak = Math.max(providerPeak, providerActive);
        sends.push(notification.notificationId); record(`start:${notification.notificationId}`);
        try { await gate.promise; assertCurrent(); record(`sent:${notification.notificationId}`); return { ok: true, receipt: notification.notificationId }; }
        finally { active--; providerActive--; }
      }));
      channels.push(endpoint("provider-two", "fast", async ({ notification, assertCurrent }) => {
        assertCurrent(); sends.push(notification.notificationId); record("fast-sent"); return { ok: true, receipt: "fast" };
      }));
      h.state.host = new WorkNotificationHost(h.works, { isAuthority: () => h.state.authority,
        maxConcurrentRoutes: 3, maxConcurrentRoutesPerChannel: 2, intervalMs: 60_000, asyncChannels: () => channels,
        channels: () => [{ channel: "desktop", targetKey: "desktop", ...capabilityOfGuarantee("best-effort-unqueryable"),
          send: ({ notification }) => { record("new-desktop-sent"); return { ok: true, receipt: notification.notificationId }; } }] });
      try {
        h.state.host.start(); await until(() => h.sent(fast.notificationId));
        for (let index = 0; index < 20; index++) h.state.host.wake();
        const newRoute = h.notice("new-route", "provider-three", "new");
        channels.push(endpoint("provider-three", "new", async ({ assertCurrent }) => {
          assertCurrent(); record("new-route-sent"); return { ok: true, receipt: "new-route" };
        }));
        const desktop = h.notice("desktop-during-hold", "desktop", "desktop");
        h.state.host.wake(); await until(() => h.sent(newRoute.notificationId) && h.sent(desktop.notificationId));
        assert(!h.sent(slow[0].notificationId));
        assert.equal(sends.filter(id => id === slow[0].notificationId).length, 1);
        assert(!sends.includes(firstRouteNext.notificationId), "same target cannot overtake its unresolved first send");
        assert.equal(providerActive, 2); assert(providerPeak <= 2); assert(peak <= 3);
        record("release-held-routes"); gate.resolve();
        await until(() => [...slow, firstRouteNext].every(item => h.sent(item.notificationId)));
        assert.equal(new Set(sends).size, sends.length, "each intent is claimed once through repeated wakes");
        assert(sends.indexOf(firstRouteNext.notificationId) > sends.indexOf(slow[0].notificationId));
        for (const name of ["fast-sent", "new-route-sent", "new-desktop-sent"])
          assert(events.findIndex(item => item.event === name) < events.findIndex(item => item.event === "release-held-routes"));
        console.log("Controlled notification timeline (not device latency): " + JSON.stringify(events));
      } finally { gate.resolve(); await h.state.host.close(); h.db.close(); }
    });

    await check("unqueryable unknown routes exceed capacity without causing an internal retry spin", async () => {
      const h = harness(join(root, "finite-sweep.db"));
      let physical = 0, scans = 0;
      const channels = Array.from({ length: 24 }, (_, index) => endpoint("unknown-provider", `target-${index}`, async () => {
        physical++; return { ok: false, retryable: false, responseLost: true, error: "lost response" };
      }));
      for (const channel of channels) {
        const f = h.notice(channel.targetKey!, channel.channel, channel.targetKey!);
        await h.works.notifications.deliverAsync(channel, f.workId);
      }
      const deliver = h.works.notifications.deliverAsync.bind(h.works.notifications);
      h.works.notifications.deliverAsync = (...args) => { scans++; return deliver(...args); };
      const host = new WorkNotificationHost(h.works, { isAuthority: () => true, channels: () => [],
        asyncChannels: () => channels, maxConcurrentRoutes: 4, maxConcurrentRoutesPerChannel: 2, intervalMs: 60_000 });
      try {
        host.start(); await until(() => scans >= channels.length);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(scans, channels.length, "capacity continuation must finish one sweep and then become idle");
        for (let index = 0; index < 20; index++) host.wake();
        await until(() => scans >= channels.length * 2);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(scans, channels.length * 2, "one external wake starts one more finite sweep");
        assert.equal(physical, channels.length, "unknown effects cannot be resent by pump fairness");
      } finally { await host.close(); h.db.close(); }
    });

    await check("direct overlapping drains keep one target sequential without consuming its pending cursor", async () => {
      const h = harness(join(root, "direct.db"));
      const first = h.notice("first", "direct", "target"), second = h.notice("second", "direct", "target");
      const gate = deferred<void>(); const sent: string[] = [];
      const channel = endpoint("direct", "target", async ({ notification, assertCurrent }) => {
        if (notification.notificationId === first.notificationId) await gate.promise;
        assertCurrent(); sent.push(notification.notificationId); return { ok: true, receipt: notification.notificationId };
      });
      try {
        const initial = h.works.notifications.deliverAsync(channel, first.workId);
        await turn();
        assert.deepEqual(await h.works.notifications.deliverAsync(channel, second.workId), []);
        assert.equal(h.works.notifications.attempts(second.notificationId).length, 0);
        gate.resolve(); await initial;
        await h.works.notifications.deliverAsync(channel, second.workId);
        assert.deepEqual(sent, [first.notificationId, second.notificationId]);
        assert.equal(h.works.notifications.attempts(first.notificationId).length, 1);
      } finally { gate.resolve(); h.db.close(); }
    });

    await check("close fences noncooperative send/progress/lookup after SQLite closes and recovers the original effect", async () => {
      const path = join(root, "restart.db");
      let h = harness(path);
      const f = h.notice("late", "queryable", "target");
      const gate = deferred<void>();
      let input: Parameters<AsyncWorkNotificationChannel["send"]>[0] | undefined;
      let sends = 0;
      const channel: AsyncWorkNotificationChannel = { channel: "queryable", targetKey: "target",
        ...capabilityOfGuarantee("idempotent-queryable"),
        async send(current) { input = current; sends++; current.recordProgress("confirmed-body"); await gate.promise; return { ok: true, receipt: "late-success" }; },
        async lookup() { return "delivered"; } };
      const attach = (current: Harness, endpoint: AsyncWorkNotificationChannel) => current.state.host = new WorkNotificationHost(current.works,
        { isAuthority: () => current.state.authority, channels: () => [], asyncChannels: () => [endpoint], intervalMs: 60_000 });
      attach(h, channel).start(); await until(() => Boolean(input));
      const original = h.works.notifications.attempts(f.notificationId)[0];
      let closed = false;
      const closing = h.state.host!.close().then(() => { closed = true; });
      await until(() => closed); await closing;
      assert.equal(h.works.repo.getNotification(f.notificationId)?.delivery, "unknown");
      assert.equal(h.works.notifications.attempts(f.notificationId)[0].receipt, "confirmed-body");
      h.db.close();
      assert.doesNotThrow(() => input!.recordProgress("late-part"));
      assert.throws(() => input!.assertCurrent(), /停止|权威/);
      gate.resolve(); await turn();
      h = harness(path);
      const lookupGate = deferred<"delivered">(); let lookupStarted = false;
      attach(h, { ...channel, async lookup() { lookupStarted = true; return lookupGate.promise; } }).start();
      await until(() => lookupStarted); await h.state.host!.close(); h.db.close();
      lookupGate.resolve("delivered"); await turn();
      h = harness(path);
      try {
        assert.equal(h.works.repo.getNotification(f.notificationId)?.delivery, "unknown");
        assert.equal(h.works.notifications.attempts(f.notificationId)[0].receipt, "confirmed-body");
        await h.works.notifications.deliverAsync(channel);
        assert(h.sent(f.notificationId)); assert.equal(sends, 1);
        const attempts = h.works.notifications.attempts(f.notificationId);
        assert.equal(attempts.length, 1); assert.equal(attempts[0].providerEffectKey, original.providerEffectKey);
      } finally { h.db.close(); }
    });

    for (const change of ["amend", "cancel", "owner", "authority-reacquired", "connection"] as const) {
      await check(`an in-flight notification cannot physically send after ${change}`, async () => {
        const h = harness(join(root, `${change}.db`));
        const authority = new WorkHostAuthority(h.db.connection, "host"); authority.acquire();
        const f = h.notice(change, "guarded", "target");
        const gate = deferred<void>(); let entered = false, physical = 0, connected = true;
        const channel = { ...endpoint("guarded", "target", async ({ assertCurrent }) => {
          entered = true; await gate.promise; assertCurrent(); physical++; return { ok: true, receipt: "physical" };
        }), admit: () => connected ? undefined : "connection changed" };
        const pending = h.works.notifications.deliverAsync(channel);
        await until(() => entered);
        if (change === "amend") unwrap(h.works.amendWork(user, { operationId: change, workId: f.workId, inputSnapshotId: "changed" }));
        else if (change === "cancel") unwrap(h.works.closeWork(user, { operationId: change, workId: f.workId, conclusion: "cancelled" }));
        else if (change === "owner") unwrap(h.works.handoffOwner(user, { operationId: change, workId: f.workId, targetBotId: "next-owner" }));
        else if (change === "authority-reacquired") { authority.release(); authority.acquire(); }
        else connected = false;
        gate.resolve(); await pending;
        assert.equal(physical, 0); assert.equal(h.works.notifications.attempts(f.notificationId).length, 1);
        assert.equal(h.works.notifications.attempts(f.notificationId)[0].status, "unknown"); h.db.close();
      });
    }

    await check("real Discord 300-second 429 waits preserve nonce/payload/retries while another route and new desktop advance", async () => {
      const h = harness(join(root, "discord.db"));
      class Socket implements DiscordSocket {
        onmessage: DiscordSocket["onmessage"] = null; onclose: DiscordSocket["onclose"] = null; onerror: DiscordSocket["onerror"] = null;
        send(raw: string) { if (JSON.parse(raw).op === 2) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 0, t: "READY", s: 1,
          d: { user: { id: "100", bot: true }, application: { id: "200" }, session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } }) })); }
        close() { this.onclose?.({ code: 1000 }); }
      }
      const requests: Array<{ at: number; body: string }> = [];
      const adapter = new DiscordGatewayAdapter("discord-test", "Discord", {
        socketFactory: () => { const socket = new Socket(); queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) })); return socket; },
        fetch: (async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/users/@me")) return Response.json({ id: "100", bot: true });
          if (path.endsWith("/oauth2/applications/@me")) return Response.json({ id: "200" });
          if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10 } });
          assert(path.endsWith("/channels/500/messages"));
          requests.push({ at: Date.now(), body: String((init!.body as FormData).get("payload_json")) });
          return Response.json({ retry_after: 300 }, { status: 429 });
        }) as typeof fetch,
      });
      await adapter.connect({ botToken: "fixture", applicationId: "200", allowUsers: ["300"], allowDirectMessages: true });
      const target = gatewayWorkTargetSchema.parse({ version: 1, channelType: "discord", channelId: adapter.id,
        connectionKey: adapter.workConnectionKey(), chatId: "discord-test:200:100:dm:500:300", senderId: "300",
        address: { channelId: "500", guildId: null, applicationId: "200", botId: "100", messageId: "600" } });
      const slow = h.notice("discord-429", "gateway:discord-test", "discord-target");
      const fast = h.notice("other-provider", "other-provider", "other-target");
      const events: Array<{ event: string; simulatedAt: number }> = [];
      const channels = [endpoint("gateway:discord-test", "discord-target", input => adapter.sendWorkNotification({ target,
        text: input.notification.body ?? "result", effectKey: input.idempotencyKey, signal: input.signal,
        assertCurrent: input.assertCurrent, recordProgress: input.recordProgress })),
      endpoint("other-provider", "other-target", async () => { events.push({ event: "other-provider-sent", simulatedAt: Date.now() }); return { ok: true, receipt: "other" }; })];
      mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 }); syncBuiltinESMExports();
      h.state.host = new WorkNotificationHost(h.works, { isAuthority: () => h.state.authority, intervalMs: 60_000,
        asyncChannels: () => channels, channels: () => [{ channel: "desktop", targetKey: "desktop", ...capabilityOfGuarantee("best-effort-unqueryable"),
          send: () => { events.push({ event: "desktop-sent", simulatedAt: Date.now() }); return { ok: true, receipt: "desktop" }; } }] });
      try {
        h.state.host.start(); await until(() => requests.length === 1 && h.sent(fast.notificationId));
        const original = h.works.notifications.attempts(slow.notificationId)[0];
        const desktop = h.notice("arrived-during-429", "desktop", "desktop");
        h.state.host.wake(); mock.timers.tick(0); await until(() => h.sent(desktop.notificationId));
        for (let attempt = 1; attempt < 4; attempt++) {
          mock.timers.tick(299_999); await turn(); assert.equal(requests.length, attempt, "server delay cannot be shortened");
          mock.timers.tick(1); await until(() => requests.length === attempt + 1); await turn();
        }
        await until(() => h.works.repo.getNotification(slow.notificationId)?.delivery === "failed");
        assert.equal(requests.length, 4, "429 does not reset the bounded adapter retry count");
        assert.equal(new Set(requests.map(item => item.body)).size, 1, "immutable payload and nonce survive every retry");
        const body = JSON.parse(requests[0].body); assert.equal(body.enforce_nonce, true); assert.equal(typeof body.nonce, "string");
        assert.deepEqual(requests.map(item => item.at - requests[0].at), [0, 300_000, 600_000, 900_000]);
        assert(events.every(item => item.simulatedAt < requests[1].at), "both independent deliveries finish before Discord's first retry");
        const attempts = h.works.notifications.attempts(slow.notificationId);
        assert.equal(attempts.length, 1); assert.equal(attempts[0].providerEffectKey, original.providerEffectKey);
        const cancelled = h.notice("cancel-during-provider-backoff", "gateway:discord-test", "discord-target");
        h.state.host.wake(); mock.timers.tick(0);
        await until(() => h.works.notifications.attempts(cancelled.notificationId).length === 1);
        await h.state.host.close(); mock.timers.tick(300_000); await turn();
        assert.equal(requests.length, 4, "shutdown cancels the real provider backoff before any new POST");
        assert.equal(h.works.repo.getNotification(cancelled.notificationId)?.delivery, "unknown");
        console.log("Controlled Discord timeline (simulated clock): " + JSON.stringify({ events, retries: requests.map(item => item.at) }));
      } finally {
        await h.state.host.close(); mock.timers.reset(); syncBuiltinESMExports(); await adapter.disconnect(); h.db.close();
      }
    });
    console.log(`Issue 57 notification concurrency: ${count} passed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
