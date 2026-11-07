import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import type { RemoteWorkCardReadResult, RemoteWorkSummary, RemoteWorkUpdate } from "../shared/src/remote-contract";
import { RemoteApiError, RemoteClient } from "../app/remote/src/api/RemoteClient";
import { useRemoteWorkStore } from "../app/remote/src/store/remoteWork";
import { workCardCompletionLabel } from "../app/remote/src/components/WorkPanel";
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
const client = new RemoteClient(`http://127.0.0.1:${address.port}`, device.token);
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

    useRemoteWorkStore.getState().setClient(client);
    await useRemoteWorkStore.getState().refresh(client);
    const reviewed = useRemoteWorkStore.getState().works.find(item => item.workId === work.workId)!;
    const bindings = works.repo.listBindings(work.workId).length;
    let confirmedRequest: Parameters<RemoteClient["workResend"]>[2] | undefined;
    const originalResend = client.workResend.bind(client);
    client.workResend = (workId, notificationId, request) => {
      confirmedRequest = request;
      return originalResend(workId, notificationId, request);
    };
    const accepted = await useRemoteWorkStore.getState().resendNotification(client, work.workId,
      notification.notificationId, { reason: "用户确认重发", acknowledgedDuplicateRisk: true, versionGuard: guard(reviewed) });
    client.workResend = originalResend;
    assert.equal(accepted.ok, true, accepted.message);
    assert.deepEqual(accepted, { ok: true, replayed: false },
      "HTTP resend success must expose only the device receipt, not work/operation/outbox internals");
    assert.ok(confirmedRequest);
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
    const summary = await client.workSummary(work.workId);
    assert.equal(summary.artifactSnapshotId, works.artifacts.currentSnapshotId(work.workId));
    assert.ok(summary.artifactSnapshotId?.startsWith("artifacts:"));
    const request = { operationId: "artifact-feedback", criterionIds: [works.getWork(work.workId)!.criteria[1]!.id],
      environment: "omarchy", sourceRef: "reviewed-artifact", inputSnapshotId: summary.inputSnapshotId,
      artifactSnapshotId: summary.artifactSnapshotId, versionGuard: guard(summary), failed: false };
    const route = `/v1/work/${work.workId}/feedback`;
    assert.equal((await call("POST", route, { ...request, versionGuard: undefined })).status, 400);
    assert.equal((await call("POST", route, { ...request, artifactSnapshotId: undefined })).status, 409);
    assert.equal((await call("POST", route, { ...request, artifactSnapshotId: "artifacts:old" })).status, 409);
    await assert.rejects(client.workFeedback(work.workId, { ...request,
      versionGuard: { ...request.versionGuard, expectedStateVersion: summary.stateVersion - 1 } }),
    error => error instanceof RemoteApiError && error.status === 409 && error.code === "version_conflict"
      && error.message !== "HTTP 409");
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "failed");
    const accepted = await useRemoteWorkStore.getState().submitFeedback(client, work.workId, request);
    assert.equal(accepted.ok, true, accepted.message);
    assert.deepEqual(accepted, { ok: true, replayed: false },
      "HTTP feedback success must not serialize the host Work, workspace, authorization or budget");
    assert.equal(works.getWork(work.workId)!.criteria[1]!.status, "satisfied");
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

  await check("a reused acceptance card displays successful closure without another card", async () => {
    const current = works.getWork(work.workId)!;
    unwrap(works.recordUserFeedback(user, { operationId: "ready-to-close", workId: work.workId,
      criterionIds: current.criteria.map(item => item.id), environment: "omarchy", sourceRef: "final-review",
      inputSnapshotId: current.inputSnapshotId, artifactSnapshotId: works.artifacts.currentSnapshotId(work.workId),
      versionGuard: guard(current), failed: false }));
    unwrap(works.closeWork(user, { operationId: "close", workId: work.workId, conclusion: "succeeded",
      versionGuard: guard(works.getWork(work.workId)!) }));
    const summary = await client.workSummary(work.workId);
    assert.equal(summary.lifecycle, "closed");
    assert.equal(summary.closureConclusion, "succeeded");
    assert.equal(summary.cards.length, 1);
    const accepted = summary.cards[0]!;
    assert.equal(accepted.kind, "accepted_result");
    assert.equal(workCardCompletionLabel(summary, accepted), "已完成并关闭");
    for (const closureConclusion of ["cancelled", "ended_unsuccessfully"] as const)
      assert.equal(workCardCompletionLabel({ ...summary, closureConclusion }, accepted), undefined);
    assert.equal(workCardCompletionLabel({ ...summary, lifecycle: "active" }, accepted), undefined);
    assert.equal(workCardCompletionLabel(summary, { ...accepted, currency: "historical" }), undefined);
    assert.equal(workCardCompletionLabel(summary, { ...accepted, currency: "superseded" }), undefined);
    assert.equal(workCardCompletionLabel(summary, { ...accepted, kind: "blocked_escalation" }), undefined);
  });

  // These are real Zustand store transitions. Deferred transports expose races that the
  // HTTP-only tests above cannot exercise without depending on timers or network speed.
  const sample: RemoteWorkSummary = { ...await client.workSummary(work.workId), lifecycle: "active",
    closureConclusion: undefined, stateVersion: 1 };
  sample.cards = sample.cards.map(item => ({ ...item, readAt: undefined, readVersion: 0 }));
  const snapshot = (epoch: string, sequence = 1, entries = [sample], scope: "open" | "all" = "open"):
    Extract<RemoteWorkUpdate, { kind: "snapshot" }> => ({ kind: "snapshot", cursor: { epoch, sequence, scope }, works: entries });
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const fakeClient = (name: string) => {
    const fake = new RemoteClient(`https://${name}.invalid`, "fixture-token");
    fake.workSync = async () => snapshot("epoch-a");
    fake.workCardRead = async () => ({ ok: true, readAt: 100, readVersion: 1 });
    fake.workDiagnostics = async () => ({ source: name });
    fake.workFeedback = async () => { throw new Error("unexpected stale feedback request"); };
    fake.workResend = async () => { throw new Error("unexpected stale resend request"); };
    return fake;
  };
  const bind = (fake: RemoteClient) => {
    useRemoteWorkStore.getState().setClient(null);
    useRemoteWorkStore.getState().setIncludeClosed(false);
    useRemoteWorkStore.getState().setClient(fake);
  };

  await check("an epoch replacement discards high local versions, reads and diagnostics", async () => {
    const fake = fakeClient("epoch"); bind(fake);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-old", 70, [{ ...sample, stateVersion: 900,
      cards: sample.cards.map(item => ({ ...item, readAt: 500, readVersion: 7 })) }]));
    useRemoteWorkStore.getState().setSelectedWork(sample.workId);
    await useRemoteWorkStore.getState().loadDiagnostics(fake, sample.workId);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-new"));
    const state = useRemoteWorkStore.getState();
    assert.equal(state.works[0]!.stateVersion, 1);
    assert.equal(state.works[0]!.cards[0]!.readAt, undefined);
    assert.equal(state.works[0]!.cards[0]!.readVersion, 0);
    assert.equal(state.selectedWorkId, null);
    assert.deepEqual(state.diagnostics, {});
  });

  await check("client replacement fences every old response and cannot revive the old session", async () => {
    const old = fakeClient("old"); const next = fakeClient("next"); bind(old);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    const oldSync = deferred<RemoteWorkUpdate>(); const nextSync = deferred<RemoteWorkUpdate>();
    const oldRead = deferred<RemoteWorkCardReadResult>(); const oldDiagnostics = deferred<unknown>();
    let oldSyncCalls = 0;
    old.workSync = () => { oldSyncCalls += 1; return oldSync.promise; };
    old.workCardRead = () => oldRead.promise; old.workDiagnostics = () => oldDiagnostics.promise;
    next.workSync = () => nextSync.promise;
    const sync = useRemoteWorkStore.getState().refresh(old);
    const read = useRemoteWorkStore.getState().markCardRead(old, sample.workId, sample.cards[0]!.semanticCardKey);
    const diagnostics = useRemoteWorkStore.getState().loadDiagnostics(old, sample.workId);
    useRemoteWorkStore.getState().setClient(next);
    assert.deepEqual(useRemoteWorkStore.getState().works, []);
    assert.equal(useRemoteWorkStore.getState().cursor, null);
    const newSync = useRemoteWorkStore.getState().refresh(next);
    oldSync.resolve(snapshot("epoch-a", 40)); oldRead.resolve({ ok: true, readAt: 900, readVersion: 90 });
    oldDiagnostics.resolve({ privateOldSession: true });
    await Promise.all([sync, read, diagnostics]);
    await useRemoteWorkStore.getState().refresh(old);
    assert.equal(oldSyncCalls, 1, "a late component callback cannot bind the old client again");
    assert.equal(useRemoteWorkStore.getState().loading, true, "old completion cannot clear new loading");
    assert.deepEqual(useRemoteWorkStore.getState().works, []);
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics, {});
    assert.equal((await useRemoteWorkStore.getState().resendNotification(old, sample.workId, "n", {
      reason: "stale", acknowledgedDuplicateRisk: true, versionGuard: guard(sample) })).ok, false);
    assert.equal((await useRemoteWorkStore.getState().submitFeedback(old, sample.workId, { operationId: "stale",
      criterionIds: ["c"], environment: "omarchy", sourceRef: "old", inputSnapshotId: sample.inputSnapshotId,
      versionGuard: guard(sample), failed: false })).ok, false);
    nextSync.resolve(snapshot("epoch-a", 1)); await newSync;
    assert.equal(useRemoteWorkStore.getState().client, next);
    assert.equal(useRemoteWorkStore.getState().works[0]!.cards[0]!.readAt, undefined);
  });

  await check("disconnect clears data immediately and late failures stay out of the next session", async () => {
    const old = fakeClient("disconnect"); bind(old);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    await useRemoteWorkStore.getState().loadDiagnostics(old, sample.workId);
    const pending = deferred<RemoteWorkUpdate>(); old.workSync = () => pending.promise;
    const first = useRemoteWorkStore.getState().refresh(old);
    useRemoteWorkStore.getState().setClient(null);
    assert.deepEqual(useRemoteWorkStore.getState().works, []);
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics, {});
    const next = fakeClient("after-disconnect"); useRemoteWorkStore.getState().setClient(next);
    await useRemoteWorkStore.getState().refresh(next);
    pending.reject(new Error("private previous host error")); await first;
    assert.equal(useRemoteWorkStore.getState().error, null);
    assert.equal(useRemoteWorkStore.getState().client, next);
  });

  await check("scope changes invalidate pages before a replacement refresh begins", async () => {
    const fake = fakeClient("scope"); bind(fake);
    useRemoteWorkStore.getState().setIncludeClosed(true);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a", 5, [{ ...sample, lifecycle: "closed" }], "all"));
    const pending = deferred<RemoteWorkUpdate>();
    fake.workSync = request => { assert.equal(request.includeClosed, true); return pending.promise; };
    const first = useRemoteWorkStore.getState().refresh(fake);
    useRemoteWorkStore.getState().setIncludeClosed(false);
    pending.resolve(snapshot("epoch-a", 6, [{ ...sample, lifecycle: "closed" }], "all")); await first;
    assert.deepEqual(useRemoteWorkStore.getState().works, []);
    assert.equal(useRemoteWorkStore.getState().cursor, null);
    fake.workSync = async request => { assert.equal(request.includeClosed, false); assert.equal(request.cursor, undefined);
      return snapshot("epoch-a", 7); };
    await useRemoteWorkStore.getState().refresh(fake);
    assert.equal(useRemoteWorkStore.getState().cursor?.scope, "open");
    assert.equal(useRemoteWorkStore.getState().works[0]!.lifecycle, "active");
  });

  await check("late read and diagnostics replies cannot cross a host epoch", async () => {
    const fake = fakeClient("late-epoch"); bind(fake);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    const readReply = deferred<RemoteWorkCardReadResult>(); const diagnosticReply = deferred<unknown>();
    fake.workCardRead = () => readReply.promise; fake.workDiagnostics = () => diagnosticReply.promise;
    const read = useRemoteWorkStore.getState().markCardRead(fake, sample.workId, sample.cards[0]!.semanticCardKey);
    const diagnostics = useRemoteWorkStore.getState().loadDiagnostics(fake, sample.workId);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-b"));
    readReply.resolve({ ok: true, readAt: 900, readVersion: 20 }); diagnosticReply.resolve({ oldEpoch: true });
    assert.equal((await read).ok, false); await diagnostics;
    assert.equal(useRemoteWorkStore.getState().works[0]!.cards[0]!.readAt, undefined);
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics, {});
  });

  await check("out-of-order read receipts and snapshots preserve one monotonic read watermark", async () => {
    const fake = fakeClient("read-order"); bind(fake);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    const firstReply = deferred<RemoteWorkCardReadResult>(); const secondReply = deferred<RemoteWorkCardReadResult>();
    let calls = 0; fake.workCardRead = () => ++calls === 1 ? firstReply.promise : secondReply.promise;
    const first = useRemoteWorkStore.getState().markCardRead(fake, sample.workId, sample.cards[0]!.semanticCardKey);
    const second = useRemoteWorkStore.getState().markCardRead(fake, sample.workId, sample.cards[0]!.semanticCardKey);
    secondReply.resolve({ ok: true, readAt: 300, readVersion: 3 }); await second;
    firstReply.resolve({ ok: true, readAt: 200, readVersion: 2 }); await first;
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a", 2));
    const observed = useRemoteWorkStore.getState().works[0]!;
    assert.equal(observed.cards[0]!.readAt, 300);
    assert.equal(observed.cards[0]!.readVersion, 3);
    assert.equal(observed.stateVersion, sample.stateVersion);
  });

  await check("diagnostics are fenced by both Work version and latest diagnostics request", async () => {
    const fake = fakeClient("diagnostics-version"); bind(fake);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    const old = deferred<unknown>(); fake.workDiagnostics = () => old.promise;
    const first = useRemoteWorkStore.getState().loadDiagnostics(fake, sample.workId);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a", 2, [{ ...sample, stateVersion: 2 }]));
    old.resolve({ stateVersion: 1 }); await first;
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics, {});
    const earlier = deferred<unknown>(); const newer = deferred<unknown>();
    let calls = 0; fake.workDiagnostics = () => ++calls === 1 ? earlier.promise : newer.promise;
    const a = useRemoteWorkStore.getState().loadDiagnostics(fake, sample.workId);
    const b = useRemoteWorkStore.getState().loadDiagnostics(fake, sample.workId);
    newer.resolve({ newest: true }); await b; earlier.resolve({ older: true }); await a;
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics[sample.workId], { newest: true });
    useRemoteWorkStore.getState().applyUpdate({ kind: "delta", from: 2,
      cursor: { epoch: "epoch-a", scope: "open", sequence: 3 }, hasMore: false,
      events: [{ kind: "remove", sequence: 3, workId: sample.workId, reason: "closed" }] });
    assert.deepEqual(useRemoteWorkStore.getState().diagnostics, {});
  });

  await check("a discontinuous delta requests one authoritative snapshot", async () => {
    const fake = fakeClient("gap"); bind(fake);
    useRemoteWorkStore.getState().applyUpdate(snapshot("epoch-a"));
    let calls = 0;
    fake.workSync = async request => {
      if (++calls === 1) return { kind: "delta", from: 1, cursor: { epoch: "epoch-a", scope: "open", sequence: 3 },
        hasMore: false, events: [{ kind: "upsert", sequence: 2, work: sample }] };
      assert.equal(request.cursor, undefined);
      return snapshot("epoch-a", 3, [{ ...sample, title: "authoritative" }]);
    };
    await useRemoteWorkStore.getState().refresh(fake);
    assert.equal(calls, 2);
    assert.equal(useRemoteWorkStore.getState().works[0]!.title, "authoritative");
  });

  console.log(`Remote Work sync: ${passes.length} passed`);
} finally {
  useRemoteWorkStore.getState().setClient(null);
  await server.stop();
}
