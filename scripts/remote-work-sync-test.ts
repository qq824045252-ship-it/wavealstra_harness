import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { createRemoteWorkBridge } from "../src/main/remote/work-mapper";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemoteEventBus } from "../src/main/remote/RemoteEventBus";
import type { RemoteWorkSummary, RemoteWorkUpdate } from "../shared/src/remote-contract";
import type { WorkActor, WorkControlResult, WorkDto } from "../src/shared/bot-work";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

/**
 * BW-A45 (paired-device half): Work sync, card read, diagnostics, version-bound feedback
 * and manual resend over the authenticated Remote API. Nothing here bypasses the host
 * service — the bridge is the same one the desktop wiring installs.
 */

const root = mkdtempSync(join(tmpdir(), "remote-work-"));
const db = new AppDatabase(join(root, "work.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS };
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: DEFAULT_BOT_ID, authorization: grants });
let clock = 1_700_000_000_000;
const works = new WorkService(db.connection, { bots, now: () => clock });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });

let work = unwrap(works.createWork(user, { operationId: "create", title: "远程同步事项", authorization: grants,
  inputSnapshotId: "input:remote@1", workspacePath: root,
  criteria: [{ text: "自动检查通过" }, { text: "Omarchy 实测通过", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }] }));
db.upsertTask({ id: "task-remote", title: "远程同步事项", updatedAt: clock });
work = unwrap(works.dispatchExecution(user, { operationId: "dispatch", workId: work.workId, botId: DEFAULT_BOT_ID,
  taskId: "task-remote", durableStoreKey: "store-remote", conversationId: "1", workspaceBinding: root,
  delegatedScope: ["workspace:read"] }));
const binding = works.repo.listBindings(work.workId)[0]!;
const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
unwrap(works.submitDeliverable(worker, { operationId: "deliver", workId: work.workId, bindingId: binding.bindingId,
  deliverableId: "deliverable-remote", summary: "远程可见的成果", evidence: [{ kind: "tool_receipt", sourceRef: "receipt-remote" }] }));
work = unwrap(works.acceptDeliverable(user, { operationId: "accept", workId: work.workId, deliverableId: "deliverable-remote" }));
works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
const card = works.cards.list(works.getWork(work.workId)!)[0]!;

const devices = new RemoteDeviceStore(join(root, "devices.json"));
const pairing = new RemoteAccessPairing(devices);
const events = new RemoteEventBus();
const server = new RemoteAccessServer({
  port: 0,
  devices,
  pairing,
  service: { bootstrap: async () => ({ server: { apiVersion: "1" }, spaces: [], tasks: [], models: [] }),
    listNotifications: () => [], markNotificationRead: () => undefined, markAllNotificationsRead: () => undefined,
    clearAllNotifications: () => undefined, history: async () => undefined, runtime: () => undefined,
    image: async () => { throw new Error("unused"); }, serverInfo: () => ({ apiVersion: "1" }) } as never,
  commands: {} as never,
  events,
  work: createRemoteWorkBridge({ db: db.connection, works, userId: LOCAL_USER_ID }),
});
const address = await server.start();
const device = devices.issue("Test Phone", randomUUID());
const call = (method: string, path: string, body?: unknown, token = device.token) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request({ host: "127.0.0.1", port: address.port, method, path,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, res => {
    let text = "";
    res.on("data", chunk => { text += String(chunk); });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
  });
  req.on("error", reject);
  req.end(payload);
});
const passes: string[] = [];
const check = async (name: string, run: () => Promise<void>) => { await run(); passes.push(name); console.log(`PASS ${name}`); };

try {
  await check("an unpaired device cannot read Work facts", async () => {
    const unauthorized = await call("GET", "/v1/work/sync", undefined, "");
    assert.equal(unauthorized.status, 401);
    const sync = await call("GET", "/v1/work/sync?includeClosed=0");
    assert.equal(sync.status, 200);
    const update = sync.json as RemoteWorkUpdate;
    assert.equal(update.kind, "snapshot");
    if (update.kind !== "snapshot") return;
    const remote = update.works.find(item => item.workId === work.workId)!;
    assert.ok(remote, "the paired device sees the work");
    assert.equal(remote.cards.length, 1);
    assert.equal(remote.cards[0]!.cardKey, card.cardKey);
    assert.equal(remote.cards[0]!.readAt, undefined);
    assert.equal(remote.ownerEpoch, 1);
    assert.ok(!JSON.stringify(remote).includes("bindingId"), "no execution internals leak to the phone");
  });

  await check("a cursor page continues from the device watermark", async () => {
    const first = await call("GET", "/v1/work/sync?includeClosed=0");
    const snapshot = first.json as Extract<RemoteWorkUpdate, { kind: "snapshot" }>;
    clock += 1_000;
    const versionBeforeRead = works.getWork(work.workId)!.stateVersion;
    works.markWorkCardRead(user, { workId: work.workId, semanticCardKey: card.semanticCardKey });
    const cursor = `epoch=${encodeURIComponent(snapshot.cursor.epoch)}&sequence=${snapshot.cursor.sequence}&scope=${snapshot.cursor.scope}`;
    const delta = (await call("GET", `/v1/work/sync?includeClosed=0&${cursor}`)).json as RemoteWorkUpdate;
    assert.equal(delta.kind, "delta");
    if (delta.kind !== "delta") return;
    const event = delta.events.find(item => item.kind === "upsert" && item.work.workId === work.workId);
    assert.ok(event && event.kind === "upsert");
    if (event?.kind !== "upsert") return;
    assert.equal(event.work.cards[0]!.readAt, clock, "the phone learns the read fact");
    assert.equal(event.work.stateVersion, versionBeforeRead, "a read is not a control version");
  });

  await check("the phone can mark a card read without touching the Work", async () => {
    const before = works.getWork(work.workId)!;
    clock += 5_000;
    const read = await call("POST", `/v1/work/${work.workId}/cards/${encodeURIComponent(card.semanticCardKey)}/read`, {});
    assert.equal(read.status, 200);
    assert.equal(read.json.ok, true);
    const after = works.getWork(work.workId)!;
    assert.equal(after.stateVersion, before.stateVersion);
    assert.equal(works.repo.listBindings(work.workId).length, 1);
    const cards = works.cards.list(after);
    assert.equal(cards[0]!.readAt, clock);
  });

  await check("a summary without the ledger is what the phone receives", async () => {
    const detail = await call("GET", `/v1/work/${work.workId}`);
    assert.equal(detail.status, 200);
    const summary = detail.json as RemoteWorkSummary;
    assert.equal(summary.workId, work.workId);
    assert.equal(summary.lifecycle, "active");
    assert.ok(summary.nextSteps.some(text => text.includes("实测")));
    assert.ok(!("executions" in summary));
  });

  const denied = await call("GET", "/v1/work/work-does-not-exist");
  assert.equal(denied.status, 404);

  await check("diagnostics are bounded and owner scoped", async () => {
    const diagnostics = await call("POST", `/v1/work/${work.workId}/diagnostics`, { sections: ["acceptance"], limit: 1 });
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.json.acceptance.items.length, 1);
    assert.equal(diagnostics.json.executions.items.length, 0);
  });

  await check("feedback must bind the tested version", async () => {
    const stale = await call("POST", `/v1/work/${work.workId}/feedback`, {
      operationId: "phone-stale", criterionIds: [works.getWork(work.workId)!.criteria[1]!.id],
      environment: "omarchy", sourceRef: "omarchy:old", inputSnapshotId: "input:remote@0", failed: false });
    assert.equal(stale.status, 200);
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "pending",
      "a different input snapshot cannot verify the current artifact");
    const current = works.getWork(work.workId)!;
    const fresh = await call("POST", `/v1/work/${work.workId}/feedback`, {
      operationId: "phone-fresh", criterionIds: [current.criteria[1]!.id], environment: "omarchy",
      sourceRef: "omarchy:new", inputSnapshotId: current.inputSnapshotId, failed: true });
    assert.equal(fresh.status, 200);
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "failed");
  });

  await check("resend is refused when nothing is unresolved", async () => {
    const notification = works.repo.listNotifications(work.workId).find(item => item.kind === "result")!;
    const resend = await call("POST", `/v1/work/${work.workId}/notifications/${notification.notificationId}/resend`,
      { operationId: "phone-resend", reason: "重发" });
    assert.equal(resend.status, 409);
    assert.equal(resend.json.ok, false);
  });

  await check("invalid input is rejected before it reaches the service", async () => {
    const bad = await call("POST", `/v1/work/${work.workId}/feedback`, { operationId: "x" });
    assert.equal(bad.status, 400);
  });

  console.log(`Remote Work sync: ${passes.length} passed`);
} finally {
  await server.stop();
}
