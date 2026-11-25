import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
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
 * Work（主机侧事项日志）对已配对设备的 HTTP 面：同步游标、卡片已读、诊断、版本绑定的反馈与人工重发。
 * 全部断言都打在电脑端服务与 HTTP 收条上——安卓端不再有 Bot 入口（那套 UI/store 已随入口删除），
 * 这条用例只负责主机 API 不被改坏。
 */

const root = mkdtempSync(join(tmpdir(), "remote-work-"));
const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));
const db = new AppDatabase(join(root, "work.db"), { runtimeAuditExecutable });
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS };
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: DEFAULT_BOT_ID, authorization: grants });
let clock = 1_700_000_000_000;
const works = new WorkService(db.connection, { bots, now: () => clock, runtimeAuditReader: db.runtimeAuditReader });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: Pick<WorkDto, "stateVersion" | "intentRevision" | "ownerEpoch">) =>
  ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });

let work = unwrap(works.createWork(user, { operationId: "create", title: "远程同步事项", authorization: grants,
  inputSnapshotId: "input:remote@1", workspacePath: root,
  criteria: [{ text: "自动检查通过" }, { text: "Omarchy 实测通过", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }] }));
db.upsertTask({ id: "task-remote", title: "远程同步事项", updatedAt: clock });
work = unwrap(works.dispatchExecution(user, { operationId: "dispatch", workId: work.workId, botId: DEFAULT_BOT_ID,
  taskId: "task-remote", durableStoreKey: "store-remote", conversationId: "1", workspaceBinding: root,
  delegatedScope: ["workspace:read"] }));
const binding = works.repo.listBindings(work.workId)[0]!;
const artifactPath = join(root, "result.txt");
writeFileSync(artifactPath, "reviewed artifact version 1");
assert.deepEqual(works.nativeResults.receive(binding, { taskId: binding.taskId, operationId: binding.operationId,
  submissionId: 1, status: "done" }, { status: "completed", summary: "远程可见的成果", artifactRefs: [artifactPath],
  hasWriteConflicts: false, usageTokens: 0 }), []);
work = unwrap(works.acceptDeliverable(user, { operationId: "accept", workId: work.workId,
  deliverableId: `result:${binding.bindingId}` }));
assert.equal(works.artifacts.capture(work.workId).observed.length, 1, "the native receive path records real file dependencies");
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
    const stream = db.connection.prepare("SELECT epoch,sequence FROM main.work_projection_streams WHERE user_id=?")
      .get(LOCAL_USER_ID) as { epoch: string; sequence: number };
    if (useNative) {
      db.connection.exec("CREATE TEMP TABLE work_projection_streams(user_id TEXT PRIMARY KEY,epoch TEXT,sequence INTEGER)");
      db.connection.prepare("INSERT INTO temp.work_projection_streams VALUES (?,'host-shadow',0)").run(LOCAL_USER_ID);
    }
    let sync;
    try {
      sync = await call("GET", "/v1/work/sync?includeClosed=0");
    } finally {
      if (useNative) db.connection.exec("DROP TABLE temp.work_projection_streams");
    }
    assert.equal(sync.status, 200);
    const update = sync.json as RemoteWorkUpdate;
    assert.equal(update.kind, "snapshot");
    if (update.kind !== "snapshot") return;
    assert.deepEqual(update.cursor, { ...stream, scope: "open" });
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
    if (useNative) db.connection.exec("CREATE TEMP TABLE work_projection_events AS SELECT * FROM main.work_projection_events WHERE 0");
    let delta: RemoteWorkUpdate;
    try {
      delta = (await call("GET", `/v1/work/sync?includeClosed=0&${cursor}`)).json as RemoteWorkUpdate;
    } finally {
      if (useNative) db.connection.exec("DROP TABLE temp.work_projection_events");
    }
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
    if (useNative) db.connection.pragma("query_only = ON");
    const route = `/v1/work/${work.workId}/cards/${encodeURIComponent(card.semanticCardKey)}/read`;
    let read;
    try {
      read = await call("POST", route, { readAt: clock + 60_000 });
      const replay = await call("POST", route, { readAt: clock - 1_000 });
      assert.deepEqual(replay.json, { ...read.json, replayed: true }, "earlier client timestamps cannot roll back a card read");
    } finally {
      if (useNative) db.connection.pragma("query_only = OFF");
    }
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
      environment: "omarchy", sourceRef: "omarchy:old", inputSnapshotId: "input:remote@0", failed: false,
      artifactSnapshotId: works.artifacts.currentSnapshotId(work.workId), versionGuard: guard(works.getWork(work.workId)!) });
    assert.equal(stale.status, 200);
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "pending",
      "a different input snapshot cannot verify the current artifact");
    const current = works.getWork(work.workId)!;
    const fresh = await call("POST", `/v1/work/${work.workId}/feedback`, {
      operationId: "phone-fresh", criterionIds: [current.criteria[1]!.id], environment: "omarchy",
      sourceRef: "omarchy:new", inputSnapshotId: current.inputSnapshotId, failed: true,
      artifactSnapshotId: works.artifacts.currentSnapshotId(work.workId), versionGuard: guard(current) });
    assert.equal(fresh.status, 200);
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "failed");
  });

  await check("resend is refused when nothing is unresolved", async () => {
    const notification = works.repo.listNotifications(work.workId).find(item => item.kind === "result")!;
    const resend = await call("POST", `/v1/work/${work.workId}/notifications/${notification.notificationId}/resend`,
      { operationId: "phone-resend", reason: "重发", acknowledgedDuplicateRisk: true,
        versionGuard: guard(works.getWork(work.workId)!) });
    assert.equal(resend.status, 409);
    assert.equal(resend.json.ok, false);
  });

  await check("invalid input is rejected before it reaches the service", async () => {
    const bad = await call("POST", `/v1/work/${work.workId}/feedback`, { operationId: "x" });
    assert.equal(bad.status, 400);
  });

  await check("remote resend requires explicit risk acknowledgement and all reviewed versions", async () => {
    const notification = works.repo.listNotifications(work.workId).find(item => item.kind === "result")!;
    works.deliverPendingNotifications({ channel: "remote-test", deliveryGuarantee: "best-effort-unqueryable",
      send: () => ({ ok: false, retryable: true, responseLost: true, error: "receipt lost" }) }, work.workId);
    assert.equal(works.repo.getNotification(notification.notificationId)!.delivery, "unknown");
    const route = `/v1/work/${work.workId}/notifications/${notification.notificationId}/resend`;
    const versionGuard = guard(works.getWork(work.workId)!);
    for (const body of [
      { operationId: "no-risk", reason: "重发", versionGuard },
      { operationId: "risk-declined", reason: "重发", acknowledgedDuplicateRisk: false, versionGuard },
      { operationId: "no-version", reason: "重发", acknowledgedDuplicateRisk: true },
      { operationId: "partial-version", reason: "重发", acknowledgedDuplicateRisk: true,
        versionGuard: { expectedStateVersion: versionGuard.expectedStateVersion } },
    ]) assert.equal((await call("POST", route, body)).status, 400);
    const stale = await call("POST", route, { operationId: "old-version", reason: "重发", acknowledgedDuplicateRisk: true,
      versionGuard: { ...versionGuard, expectedStateVersion: versionGuard.expectedStateVersion - 1 } });
    assert.equal(stale.status, 409);
    assert.deepEqual(Object.keys(stale.json).sort(), ["code", "message", "ok"],
      "resend conflicts must not serialize latestWorkSnapshot or any internal Work field");
    assert.equal(stale.json.code, "version_conflict");
    assert.equal(works.notifications.attempts(notification.notificationId).length, 1);
    assert.equal(works.repo.getNotification(notification.notificationId)!.delivery, "unknown");

    const reviewed = (await call("GET", `/v1/work/${work.workId}`)).json as RemoteWorkSummary;
    const bindings = works.repo.listBindings(work.workId).length;
    const confirmedRequest = { operationId: "phone-resend-confirmed", reason: "用户确认重发",
      acknowledgedDuplicateRisk: true, versionGuard: guard(reviewed) };
    const accepted = await call("POST", route, confirmedRequest);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.deepEqual(accepted.json, { ok: true, replayed: false },
      "HTTP resend success must expose only the device receipt, not work/operation/outbox internals");
    const versionAfterResend = works.getWork(work.workId)!.stateVersion;
    const replay = await call("POST", route, confirmedRequest);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, { ok: true, replayed: true }, "resend receipt replay must remain equally narrow");
    assert.equal(works.getWork(work.workId)!.stateVersion, versionAfterResend);
    works.deliverPendingNotifications({ channel: "remote-test", deliveryGuarantee: "best-effort-unqueryable",
      send: () => ({ ok: true, receipt: "confirmed-resend" }) }, work.workId);
    const attempts = works.notifications.attempts(notification.notificationId);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]!.providerEffectKey, attempts[1]!.providerEffectKey);
    assert.equal(attempts[0]!.status, "unknown");
    assert.equal(attempts[1]!.status, "sent");
    assert.equal(works.repo.listBindings(work.workId).length, bindings, "manual resend does not execute the Work again");
  });

  await check("phone feedback carries the real artifact snapshot and rejects stale controls", async () => {
    const summary = (await call("GET", `/v1/work/${work.workId}`)).json as RemoteWorkSummary;
    assert.equal(summary.artifactSnapshotId, works.artifacts.currentSnapshotId(work.workId));
    assert.ok(summary.artifactSnapshotId?.startsWith("artifacts:"));
    const request = { operationId: "artifact-feedback", criterionIds: [works.getWork(work.workId)!.criteria[1]!.id],
      environment: "omarchy", sourceRef: "reviewed-artifact", inputSnapshotId: summary.inputSnapshotId,
      artifactSnapshotId: summary.artifactSnapshotId, versionGuard: guard(summary), failed: false };
    const route = `/v1/work/${work.workId}/feedback`;
    assert.equal((await call("POST", route, { ...request, versionGuard: undefined })).status, 400);
    assert.equal((await call("POST", route, { ...request, artifactSnapshotId: undefined })).status, 409);
    assert.equal((await call("POST", route, { ...request, artifactSnapshotId: "artifacts:old" })).status, 409);
    const staleControl = await call("POST", route, { ...request,
      versionGuard: { ...request.versionGuard, expectedStateVersion: summary.stateVersion - 1 } });
    assert.equal(staleControl.status, 409);
    assert.equal(staleControl.json.code, "version_conflict");
    assert.notEqual(staleControl.json.message, "HTTP 409", "a version conflict must carry a human reason");
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "failed");
    const accepted = await call("POST", route, request);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.json, { ok: true, replayed: false },
      "HTTP feedback success must not serialize the host Work, workspace, authorization or budget");
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "satisfied");
    const verified = (await call("GET", `/v1/work/${work.workId}`)).json as RemoteWorkSummary;
    assert.equal(verified.unverifiedScope.find(item => item.criterionId === request.criterionIds[0])?.reason,
      "user_verified", "the real HTTP projection preserves user verification provenance for the phone");
    const versionAfterFeedback = works.getWork(work.workId)!.stateVersion;
    const replay = await call("POST", route, request);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, { ok: true, replayed: true }, "feedback replay cannot expose a saved Work snapshot");
    assert.equal(works.getWork(work.workId)!.stateVersion, versionAfterFeedback);
    const conflict = await call("POST", route, { ...request, operationId: "feedback-conflict-isolation" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "version_conflict");
    assert.deepEqual(Object.keys(conflict.json).sort(), ["code", "message", "ok"],
      "feedback version conflicts must not expose latestWorkSnapshot");
  });

  await check("a reused acceptance card stays current after a successful close", async () => {
    const current = works.getWork(work.workId)!;
    unwrap(works.recordUserFeedback(user, { operationId: "ready-to-close", workId: work.workId,
      criterionIds: current.criteria.map(item => item.id), environment: "omarchy", sourceRef: "final-review",
      inputSnapshotId: current.inputSnapshotId, artifactSnapshotId: works.artifacts.currentSnapshotId(work.workId),
      versionGuard: guard(current), failed: false }));
    unwrap(works.closeWork(user, { operationId: "close", workId: work.workId, conclusion: "succeeded",
      versionGuard: guard(works.getWork(work.workId)!) }));
    const summary = (await call("GET", `/v1/work/${work.workId}`)).json as RemoteWorkSummary;
    assert.equal(summary.lifecycle, "closed");
    assert.equal(summary.closureConclusion, "succeeded");
    assert.equal(summary.cards.length, 1);
    const accepted = summary.cards[0]!;
    assert.equal(accepted.kind, "accepted_result");
    assert.equal(accepted.currency, "current");
    assert.equal(accepted.intentRevision, summary.intentRevision);
  });

  if (db.runtimeAuditReader) await check("a concurrent writer cannot make a Rust cursor conceal newer Work", async () => {
    const worker = db.runtimeAuditReader!;
    const read = worker.readWorkQueue.bind(worker);
    let newWork: WorkDto | undefined;
    worker.readWorkQueue = async query => {
      const snapshot = await read(query);
      assert.equal(snapshot?.kind, "snapshot");
      newWork = unwrap(works.createWork(user, { operationId: "changed-during-sync", title: "快照后新增事项", authorization: grants }));
      return snapshot;
    };
    try {
      const result = await call("GET", "/v1/work/sync?includeClosed=0");
      assert.equal(result.status, 200);
      assert.equal(result.json.kind, "snapshot");
      assert.deepEqual(result.json.works.map((item: RemoteWorkSummary) => [item.workId, item.title]),
        [[newWork?.workId, "快照后新增事项"]]);
    } finally {
      worker.readWorkQueue = read;
    }
  });

  if (db.runtimeAuditReader) await check("Rust returns the complete first snapshot beyond a thousand Work records", async () => {
    const ownWork = works.getWork(work.workId)!;
    const userId = "wide-queue-fixture";
    db.connection.transaction(() => {
      db.connection.prepare("INSERT INTO work_projection_streams(user_id,epoch) VALUES (?,'wide-epoch')").run(userId);
      for (let index = 0; index < 1005; index += 1) {
        works.repo.insertWork({ ...ownWork, userId, workId: `wide-${index}`, lifecycle: "active", updatedAt: clock + index });
      }
    })();
    const snapshot = await db.runtimeAuditReader!.readWorkQueue({ userId, includeClosed: false });
    assert.ok(snapshot?.kind === "snapshot");
    assert.deepEqual(snapshot.cursor, { epoch: "wide-epoch", sequence: 1005, scope: "open" });
    assert.deepEqual([snapshot.workIds.length, snapshot.workIds[0], snapshot.workIds.at(-1)], [1005, "wide-1004", "wide-0"]);
  });

  console.log(`Remote Work sync: ${passes.length} passed`);
} finally {
  await server.stop();
  await db.runtimeAuditReader?.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
