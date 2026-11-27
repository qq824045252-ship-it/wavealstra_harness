import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingActionRegistry } from "../src/main/agent/PendingActionRegistry";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { TaskExpertBindingService } from "../src/main/experts/TaskExpertBindingService";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { mapRemoteSpace, mapRemoteTask } from "../src/main/remote/RemoteDtoMapper";
import { RemoteEventBus, mapAgentPatchToRemoteEvent } from "../src/main/remote/RemoteEventBus";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemotePairWindow } from "../src/main/remote/RemotePairWindow";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteAccessService } from "../src/main/remote/RemoteAccessService";
import { cleanupRemoteUploads, RemoteConflictError, RemoteTaskCommandService, RemoteValidationError } from "../src/main/remote/RemoteTaskCommandService";
import { RemoteClient } from "../app/remote/src/api/RemoteClient";
import { coalesceAssistantTurnMessages, reconcileLiveMessagesWithHistory, useRemoteStore } from "../app/remote/src/store/remoteStore";
import { DOTS_TASK_ID } from "../src/shared/dots";

const modeProfiles = {
  working: { labelZh: '日常办公', policy: { presets: [{ id: 'general-office', label: '通用办公', promptAddon: 'private prompt' }] } },
  coding: { labelZh: '代码开发', policy: { presets: [{ id: 'custom-dev', label: '自定义开发', promptAddon: 'private prompt' }] } },
  general: { labelZh: '通用模式', policy: { presets: [{ id: 'native', label: '原生模式' }, { id: 'codemode', label: 'Code Mode' }] } },
};

const catalogService = new RemoteAccessService({
  readSpaces: async () => [], readNonTrashedTasks: async () => [],
  getTask: () => undefined,
  openDots: () => ({ id: DOTS_TASK_ID, title: "Dots", updatedAt: 1 }),
  openDotsAsync: async () => ({ id: DOTS_TASK_ID, title: "Dots", updatedAt: 1 }),
} as any,
  { listModels: async () => [], isTaskBusy: () => false, listPendingActions: () => [],
    getModeProfile: (id: keyof typeof modeProfiles) => modeProfiles[id] } as any,
  { unreadCount: () => 0 } as any, { readList: async () => [] } as any, { read: () => ({ permissionMode: 'default' }) } as any);
const catalogBootstrap = await catalogService.bootstrap({ id: 'test', name: 'Test', createdAt: 1, lastSeenAt: 1, capabilities: [] });
assert.equal(catalogBootstrap.taskModes?.find(mode => mode.id === 'coding')?.tags[0].label, '自定义开发');
assert.equal(JSON.stringify(catalogBootstrap).includes('private prompt'), false, 'catalog must only expose display metadata');

let remoteReloadCalls = 0;
const refreshCatalogService = new RemoteAccessService({} as any, {
  listModels: async () => [{ id: 'cached/old', name: 'Old', vendor: 'cached', enabled: true, available: true, kind: 'chat' }],
  reloadModels: async () => {
    remoteReloadCalls += 1;
    return { models: [
      { id: 'fresh/ok', name: 'Fresh', vendor: 'fresh', enabled: true, available: true, kind: 'chat', supportsReasoning: true, supportsImages: false },
      { id: 'fresh/hidden', name: 'Hidden', vendor: 'fresh', enabled: false, available: true, kind: 'chat' },
    ], requestedProviderIds: ['fresh'], errors: [{ providerId: 'partial', message: 'timeout' }] };
  },
} as any, {} as any, {} as any, {} as any);
await refreshCatalogService.listModels();
const refreshedCatalog = await refreshCatalogService.refreshModels();
assert.equal(remoteReloadCalls, 1, 'remote refresh must delegate once to AgentService.reloadModels');
assert.deepEqual(refreshedCatalog, { models: [{ id: 'fresh/ok', name: 'Fresh', vendor: 'fresh', contextWindow: undefined, supportsReasoning: true, supportsImages: false }], errors: [{ providerId: 'partial', message: 'timeout' }] }, 'refresh must replace the cache with safe remote model projections');
assert.deepEqual(await refreshCatalogService.listModels(), refreshedCatalog.models, 'subsequent bootstrap reads must use the refreshed projection cache');

let enabledIds: string[] | undefined;
const settingCatalog = [
  { id: 'p/a', name: 'A', vendor: 'p', available: true, kind: 'chat', apiKey: 'secret' },
  { id: 'p/b', name: 'B', vendor: 'p', available: true, kind: 'chat', apiKey: 'secret' },
  { id: 'p/offline', name: 'Offline', vendor: 'p', available: false, kind: 'chat' },
  { id: 'p/c', name: 'C', vendor: 'p', available: true, kind: 'chat' },
  { id: 'p/image', name: 'Image', vendor: 'p', available: true, kind: 'image-generation' },
];
const settingService = new RemoteAccessService({} as any, {
  listModels: async () => settingCatalog.map(model => ({ ...model, enabled: enabledIds === undefined || enabledIds.includes(model.id) })),
  updateAppSettings: async (settings: { enabledModels?: string[]; defaultModelId?: string }) => { if (settings.enabledModels) enabledIds = settings.enabledModels; return { defaultModelId: settings.defaultModelId ?? '' }; },
  getAppSettings: () => ({ defaultModelId: '' }),
  getSubagentConfig: () => ({}),
} as any, {} as any, {} as any, {} as any);
enabledIds = ['p/a', 'p/b', 'p/offline'];
const visibleSettings = await settingService.modelSettings();
assert.equal(JSON.stringify(visibleSettings).includes('secret'), false);
assert.deepEqual(visibleSettings.map(model => [model.id, model.enabled]), [['p/a', true], ['p/b', true], ['p/c', false]], 'settings include enabled and disabled models from configured providers, excluding unavailable and image models');
await settingService.listModels();
await settingService.setModelEnabled('p/a', false);
assert.deepEqual(enabledIds, ['p/b', 'p/offline'], 'wildcard scope expands from the complete enabled chat catalog');
assert.deepEqual((await settingService.listModels()).map(model => model.id), ['p/b'], 'toggle invalidates cached selectable models');
await assert.rejects(settingService.setModelEnabled('p/b', false), /至少保留一个/);
await assert.rejects(settingService.setModelEnabled('p/image', true), /模型不存在/);
await assert.rejects(settingService.setModelEnabled('p/offline', false), /模型不存在/);
await Promise.all([settingService.setModelEnabled('p/a', true), settingService.setModelEnabled('p/c', true)]);
assert.deepEqual(enabledIds, ['p/a', 'p/b', 'p/offline', 'p/c'], 'concurrent changes preserve hidden model settings');

const stateBeforeModelRefresh = useRemoteStore.getState();
useRemoteStore.setState({
  client: { refreshModels: async () => ({ models: [{ id: 'store/fresh', name: 'Store Fresh', vendor: 'store', supportsReasoning: false, supportsImages: false }], errors: [] }) } as never,
  bootstrap: { ...catalogBootstrap, models: [{ id: 'store/old', name: 'Store Old', vendor: 'store', supportsReasoning: false, supportsImages: false }], defaultModelId: 'store/default' },
  selectedModelId: 'store/selected',
});
await useRemoteStore.getState().refreshModels();
const stateAfterModelRefresh = useRemoteStore.getState();
assert.deepEqual(stateAfterModelRefresh.bootstrap?.models, [{ id: 'store/fresh', name: 'Store Fresh', vendor: 'store', supportsReasoning: false, supportsImages: false }], 'Android store refresh must replace bootstrap.models');
assert.equal(stateAfterModelRefresh.bootstrap?.defaultModelId, 'store/default', 'Android store refresh must not mutate the desktop default');
assert.equal(stateAfterModelRefresh.selectedModelId, 'store/selected', 'Android store refresh must not mutate selection');
useRemoteStore.setState(stateBeforeModelRefresh);

/** Node fetch（undici）会按 fetch 规范丢弃 Origin 头，Origin 相关断言必须走原生 http */
function httpJson(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const pending = new PendingActionRegistry();
pending.register({ taskId: "t1", assistantMessageId: "a1", toolCallId: "x", tool: "bash", summary: "run", dangerous: true, approvalKind: "tool", createdAt: 1 });
pending.register({ taskId: "t2", assistantMessageId: "a2", toolCallId: "x", tool: "write", summary: "write", dangerous: true, approvalKind: "external-write", createdAt: 2, externalWrite: { targetPath: "C:\\target.txt", taskRoot: "C:\\task", canonicalDir: "C:\\" } });
assert.equal(pending.list("t1").length, 1);
assert.equal(pending.get("t2", "x")?.externalWrite?.canonicalDir, "C:\\");
pending.remove("t1", "x");
assert.equal(pending.list("t1").length, 0);
assert.equal(pending.list("t2").length, 1, "same toolCallId must remain task-scoped");
pending.removeTask("t2");
assert.equal(pending.list().length, 0);

const task = mapRemoteTask({ id: "t", title: "T", cwd: "C:\\secret", sessionFile: "C:\\secret.jsonl", updatedAt: 1 }, { busy: false, pendingActionCount: 0 });
assert.equal("cwd" in task, false);
assert.equal("sessionFile" in task, false);
const space = mapRemoteSpace({ id: "s", name: "S", path: "C:\\secret" });
assert.equal("path" in space, false);

const events = new RemoteEventBus();
const runtimeService = new RemoteAccessService({ getTask: () => ({ id: "legacy-chat" }) } as any, {
  readConversationRuntimeSnapshot: async () => ({ taskId: "legacy-chat", interactions: [], activeGoal: null,
    todos: [{ id: "retired-todo" }], activePlan: { id: "retired-plan" } }),
  isTaskBusy: () => false, listPendingActions: () => [],
} as any, {} as any, {} as any, {} as any);
const runtimeProjection = (await runtimeService.runtime("legacy-chat"))!;
assert(!("todos" in runtimeProjection) && !("activePlan" in runtimeProjection), "remote runtime must omit removed chat state even from a legacy snapshot");
assert.deepEqual(runtimeProjection.interactions, []);
assert.equal(runtimeProjection.activeGoal, null);
assert.deepEqual(
  mapAgentPatchToRemoteEvent({ type: "assistant_message_start", taskId: "t", messageId: "m" }),
  { type: "assistant_message_start", taskId: "t", messageId: "m" },
  "provider message boundaries survive remote event projection",
);
const first = events.publish("task.changed", { taskId: "t" });
const second = events.publish("task.changed", { taskId: "t" });
assert.equal(second.id, first.id + 1);
assert.deepEqual(events.replayAfter(first.id)?.map((event) => event.id), [second.id]);
const unsubscribe = events.subscribe(() => undefined);
assert.equal(events.subscriberCount, 1);
unsubscribe();
assert.equal(events.subscriberCount, 0);

assert.deepEqual(
  mapAgentPatchToRemoteEvent({ type: "user_message", taskId: "t", messageId: "u", text: "来自 Android", createdAt: 123 }),
  { type: "user_message", taskId: "t", messageId: "u", text: "来自 Android", createdAt: 123 },
  "cross-client user messages must survive the remote patch mapping",
);


{
  const history = {
    taskId: "timeline",
    messages: [
      { id: "u1", role: "user" as const, text: "first", createdAt: 100 },
      { id: "a-hist", role: "assistant" as const, text: "", thinking: "history", createdAt: 110, tools: [{ id: "t1", tool: "shell", summary: "old", status: "success" }] },
      { id: "u2", role: "user" as const, text: "continue", createdAt: 200 },
    ],
  };
  const reconciled = reconcileLiveMessagesWithHistory({
    "a-stale": { id: "a-stale", role: "assistant", text: "", thinking: "stale", createdAt: 150, tools: [{ id: "t2", tool: "shell", summary: "stale", status: "running" }] },
    "a-current": { id: "a-current", role: "assistant", text: "", thinking: "current", createdAt: 210, tools: [{ id: "t3", tool: "shell", summary: "current", status: "running" }] },
  }, history);
  assert.ok(reconciled["a-stale"], "a later user alone is not proof that history has persisted an unmatched assistant; never drop visible data");
  assert.ok(reconciled["a-current"], "assistant live in the current user turn must remain");

  const coalesced = coalesceAssistantTurnMessages([
    history.messages[0],
    history.messages[1],
    { id: "a-live", role: "assistant", text: "", thinking: "live", createdAt: 120, tools: [{ id: "t2", tool: "shell", summary: "new", status: "running" }] },
    history.messages[2],
    { id: "a-next", role: "assistant", text: "", thinking: "next", createdAt: 220, tools: [{ id: "t3", tool: "shell", summary: "next", status: "running" }] },
  ]);
  assert.equal(coalesced.length, 4, "contiguous assistant fragments must render as one assistant turn");
  const firstAssistant = coalesced[1];
  assert.equal(firstAssistant.role, "assistant");
  assert.deepEqual(firstAssistant.tools?.map((tool) => tool.id), ["t1", "t2"]);
  assert.match(firstAssistant.thinking ?? "", /history/);
  assert.match(firstAssistant.thinking ?? "", /live/);
}

const originalFetch = globalThis.fetch;
let capturedPairBody = '';
globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
  capturedPairBody = String(init?.body ?? '');
  return new Response(JSON.stringify({
    deviceId: 'rdev_test',
    deviceToken: 'token_test',
    server: { apiVersion: 1, service: 'mybuddy-remote', name: 'MyBuddy', now: Date.now() },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
try {
  await RemoteClient.pair('http://127.0.0.1:3352', {
    pairingId: 'rpair_test',
    secret: '1234567890123456',
    deviceName: 'Android',
    installationId: 'install-test-12345678',
    baseUrl: 'http://127.0.0.1:3352',
  } as never);
  assert.deepEqual(JSON.parse(capturedPairBody), {
    pairingId: 'rpair_test',
    secret: '1234567890123456',
    deviceName: 'Android',
    installationId: 'install-test-12345678',
  }, 'pair payload must keep stable installationId but not leak baseUrl');
} finally {
  globalThis.fetch = originalFetch;
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-remote-test-"));
try {
  const devices = new RemoteDeviceStore(join(root, "devices.json"));
  const pairing = new RemoteAccessPairing(devices, 60_000);
  const pair = pairing.create("http://127.0.0.1:3352");
  assert.throws(() => pairing.exchange(pair.pairingId, `${pair.secret}x`, "Bad"));
  const issued = pairing.exchange(pair.pairingId, pair.secret, "Phone");
  assert.equal(devices.authenticate(issued.token)?.device.name, "Phone");
  assert.equal(readFileSync(join(root, "devices.json"), "utf8").includes(issued.token), false, "device token must never be persisted in plaintext");
  assert.equal(devices.revoke(issued.device.id), true);
  assert.equal(devices.authenticate(issued.token), null);

  const stableFirst = devices.issue("Android", "installation-stable-1");
  const stableSecond = devices.issue("Android renamed", "installation-stable-1");
  assert.equal(stableSecond.device.id, stableFirst.device.id, "same installationId must reuse the same device row");
  assert.equal(devices.authenticate(stableFirst.token), null, "re-pair must rotate and invalidate the previous token");
  assert.equal(devices.authenticate(stableSecond.token)?.device.name, "Android renamed");
  assert.equal(devices.list(false).filter((device) => device.id === stableFirst.device.id).length, 1);
  const expiredPairing = new RemoteAccessPairing(devices, -1);
  const expired = expiredPairing.create("http://localhost:3352");
  assert.throws(() => expiredPairing.exchange(expired.pairingId, expired.secret, "Late"));

  const webRoot = join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Remote</title>");
  const token = devices.issue("Test client").token;
  const service = {
    serverInfo: () => ({ apiVersion: 1, service: "mybuddy-remote", name: "MyBuddy", now: Date.now() }),
    bootstrap: (device: unknown) => ({ apiVersion: 1, server: { apiVersion: 1, service: "mybuddy-remote", name: "MyBuddy", now: Date.now() }, spaces: [], projects: [], tasks: [], unreadNotificationCount: 0, device }),
    refreshModels: () => ({ models: [{ id: "safe/model", name: "Safe", vendor: "safe", supportsReasoning: false, supportsImages: false }], errors: [{ providerId: "partial", message: "timeout" }] }),
    listTasks: () => [], history: async () => null, runtime: () => null,
    listNotifications: () => [], markNotificationRead: () => undefined, markAllNotificationsRead: () => undefined,
  };
  let capturedPrompt: unknown = null;
  let capturedInteraction: unknown = null;
  const makeInteraction = (id: string, status: "pending" | "resolved" | "cancelled", answer?: boolean | string | string[]) => ({
    id, taskId: "t", executionId: "e", assistantMessageId: "a", kind: "single_select" as const,
    title: "请选择处理方式", options: [{ id: "one", label: "方案一" }, { id: "two", label: "方案二" }],
    status, answer, version: status === "pending" ? 1 : 2, createdAt: 1, resolvedAt: status === "pending" ? undefined : 2,
  });
  let remoteModelCacheInvalidations = 0;
  const commands = {
    invalidateModelCache: () => { remoteModelCacheInvalidations += 1; },
    createAndPrompt: async (request: never) => {
      capturedPrompt = request;
      return { task: { id: "remote-1", title: "T" }, userMessageId: "u1", assistantMessageId: "a1", queued: true };
    },
    promptExisting: async () => { throw new Error("unused"); }, abort: async () => undefined,
    respondToInteraction: (taskId: string, interactionId: string, answer: boolean | string | string[]) => {
      if (interactionId === "stale") throw new RemoteConflictError("stale");
      capturedInteraction = { taskId, interactionId, answer };
      return { ok: true as const, interaction: makeInteraction(interactionId, "resolved", answer) };
    },
    cancelInteraction: (taskId: string, interactionId: string) => {
      if (interactionId === "stale") throw new RemoteConflictError("stale");
      capturedInteraction = { taskId, interactionId, cancelled: true };
      return { ok: true as const, interaction: makeInteraction(interactionId, "cancelled") };
    },
    respondToAction: (_taskId: string, toolCallId: string) => { if (toolCallId === "stale") throw new RemoteConflictError("stale"); },
  };
  const server = new RemoteAccessServer({ port: 0, staticRoot: webRoot, devices, pairing, service: service as never, commands: commands as never, events });
  assert.doesNotThrow(() => pairing.create("http://192.168.1.20:3352"));
  assert.throws(() => pairing.create("http://8.8.8.8:3352"));
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);

  const useNative = process.argv.includes("--native");
  const executable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
  if (useNative) assert.ok(executable && existsSync(executable));

  {
    const db = new AppDatabase(join(root, "sidebar.db"), { runtimeAuditExecutable: executable });
    const sidebarHost = new RemoteAccessService(
      db,
      { isTaskBusy: () => false, listPendingActions: () => [], listModels: async () => [],
        getModeProfile: (id: keyof typeof modeProfiles) => modeProfiles[id] } as never,
      { unreadCount: () => 0 } as never, { readList: async () => [] } as never,
      { read: () => ({ permissionMode: "default" }) } as never,
    );
    const sidebarServer = new RemoteAccessServer({
      port: 0, staticRoot: webRoot, devices, pairing, service: sidebarHost, commands: commands as never, events,
    });
    try {
      db.openDots();
      db.upsertTask({ id: "archived", title: "上周报告", updatedAt: 10 });
      db.archiveTask("archived", true);
      db.upsertTask({ id: "active", title: "本周报告", updatedAt: Date.now() + 60_000, isFavorited: true });
      db.upsertTask({ id: "trashed", title: "删除的报告", updatedAt: 30 });
      db.upsertTaskExecutionWorkspaceState({
        taskId: "trashed", directoryName: "sidebar-fixture-trash", state: "trashed",
        createdAt: 1, updatedAt: 30, trashedAt: 30, purgeAfter: 100,
      });
      const bindings = new TaskExpertBindingService(db, {} as never, { rootDir: join(root, "sidebar-experts") });
      bindings.save({ taskId: "active", custom: {
        name: "验收专家", instructions: "保留原始数据。", skillIds: [], connectorIds: [], mcpIds: [],
      } });
      bindings.promote("active");
      bindings.save({ taskId: "active", custom: {
        name: "待生效专家", instructions: "汇总本周数据。", skillIds: [], connectorIds: [], mcpIds: [],
      } });

      const summarize = (rows: Array<{ id: string; title: string; archived?: boolean; isFavorited?: boolean }>) =>
        rows.map(task => [task.id, task.title, task.archived, task.isFavorited]);
      const expected = [["active", "本周报告", false, true], ["archived", "上周报告", true, false]];
      const desktop = await db.readNonTrashedTasks();
      assert.deepEqual(summarize(desktop), expected);
      assert.deepEqual(desktop.map(({ expertBinding }) => expertBinding
        ? [expertBinding.active?.name, expertBinding.desired?.name, expertBinding.pending]
        : null), [["验收专家", "待生效专家", true], null]);

      const { port } = await sidebarServer.start();
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(url + "/v1/tasks", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      const mobile = await response.json() as Parameters<typeof summarize>[0];
      assert.deepEqual(summarize(mobile), expected);
      assert.equal(Object.hasOwn(mobile[0], "expertBinding"), false);
      const bootstrap = await new RemoteClient(url, token).bootstrap();
      assert.deepEqual(summarize(bootstrap.tasks), expected);
      assert.equal(bootstrap.dots?.title, "Dots");
      console.log("PASS sidebar data: task visibility, expert binding and real phone HTTP responses");
    } finally {
      await sidebarServer.stop();
      await db.runtimeAuditReader?.close();
      db.close();
    }
  }

  {
    const db = new AppDatabase(join(root, "remote-image.db"), { runtimeAuditExecutable: executable });
    const artifacts = new ArtifactService(new ArtifactStorage(join(root, "managed-images")),
      new ArtifactRepository(db.connection), new ArtifactRegistry(), undefined, db.runtimeAuditReader);
    const imageHost = new RemoteAccessService(db, {} as never, {} as never, {} as never, {} as never, undefined, () => artifacts);
    const imageServer = new RemoteAccessServer({ port: 0, staticRoot: webRoot, devices, pairing, service: imageHost, commands: commands as never, events });
    try {
      db.upsertTask({ id: "photo-task", title: "图片成果", updatedAt: 1 });
      db.upsertTask({ id: "other-task", title: "其他任务", updatedAt: 2 });
      const work = join(root, "image-workspace");
      mkdirSync(work);
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW9kAAAAASUVORK5CYII=", "base64");
      const photo = Buffer.alloc(2 * 1024 * 1024 + 11, 0x4a);
      png.copy(photo);
      const path = join(work, "图.jpg");
      writeFileSync(path, photo);
      const workspaceImage = await artifacts.register({
        taskId: "photo-task", kind: "image", mimeType: "image/jpeg", workspaceFile: { entryFile: path, rootDir: work },
      });
      const fileRootImage = await artifacts.register({
        taskId: "photo-task", kind: "image", workspaceFile: { entryFile: path, rootDir: path },
      });
      const encoded = photo.toString("base64");
      const managedImage = await artifacts.register({
        taskId: "photo-task", kind: "image", content: " \ufeff DATA:image/jpg;BASE64,"
          + encoded.slice(0, 5) + "\r\n\u202f" + encoded.slice(5) + " ",
      });
      const invalidImage = await artifacts.register({
        taskId: "photo-task", kind: "image", content: "data:image/png;base64,AA_A",
      });
      const largePath = join(work, "大图.png");
      writeFileSync(largePath, png);
      truncateSync(largePath, 16 * 1024 * 1024 + 1);
      const largeImage = await artifacts.register({
        taskId: "photo-task", kind: "image", workspaceFile: { entryFile: largePath, rootDir: work },
      });
      const outside = join(root, "outside-workspace");
      mkdirSync(outside);
      writeFileSync(join(outside, "outside.png"), png);
      symlinkSync(outside, join(work, "outside"), "junction");
      const linkedImage = await artifacts.register({
        taskId: "photo-task", kind: "image", workspaceFile: { entryFile: join(work, "outside", "outside.png"), rootDir: work },
      });

      const { port } = await imageServer.start();
      const imageUrl = (artifactId: string, taskId = "photo-task", version = 1) =>
        `http://127.0.0.1:${port}/v1/tasks/${taskId}/artifacts/${artifactId}/image?v=${version}`;
      const headers = { authorization: `Bearer ${token}` };
      const phone = new RemoteClient(`http://127.0.0.1:${port}`, token);
      for (const item of [workspaceImage, managedImage, fileRootImage]) {
        const blob = await phone.image("photo-task", item.id, 1);
        assert.equal(blob.type, "image/png");
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), photo);
        const head = await fetch(imageUrl(item.id), { method: "HEAD", headers });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-length"), "2097163");
        assert.equal(head.headers.get("cache-control"), "no-store");
        assert.equal((await head.arrayBuffer()).byteLength, 0);
      }
      for (const [url, status] of [
        [imageUrl(workspaceImage.id, "other-task"), 404],
        [imageUrl(workspaceImage.id, "photo-task", 2), 409],
        [imageUrl(largeImage.id), 413],
        [imageUrl(invalidImage.id), 415],
        [imageUrl(linkedImage.id), 404],
      ] as const) {
        const response = await fetch(url, { headers });
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.code, "image_unavailable");
      }
      const cancelled = await fetch(imageUrl(workspaceImage.id), { headers });
      const body = cancelled.body!.getReader();
      assert.deepEqual(Buffer.from((await body.read()).value!).subarray(0, png.length), png);
      await body.cancel();
      const retried = await phone.image("photo-task", workspaceImage.id, 1);
      assert.deepEqual(Buffer.from(await retried.arrayBuffer()), photo);
      console.log(`PASS phone image HTTP: exact workspace and managed bytes, HEAD, task scope, version, size and type (${useNative ? "Rust" : "Node"})`);
    } finally {
      await imageServer.stop();
      await artifacts.flushWrites();
      await db.runtimeAuditReader?.close();
      db.close();
    }
  }

  // P0-1：Origin 白名单——未知浏览器来源 403，不回显 CORS；可信来源放行并回显
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: `http://evil.example:${address.port}` })).status, 403);
  assert.equal((await httpJson(address.port, "POST", "/v1/pair/exchange", { origin: `http://evil.example:${address.port}` })).status, 403, "未配对写接口同样受 Origin 管控");
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: `http://localhost:${address.port + 1}` })).status, 403, "端口不匹配的同名来源必须拒绝");
  const capacitorOrigin = await httpJson(address.port, "GET", "/v1/bootstrap", { origin: "capacitor://localhost", authorization: `Bearer ${token}` });
  assert.equal(capacitorOrigin.status, 200);
  assert.equal(capacitorOrigin.headers["access-control-allow-origin"], "capacitor://localhost", "放行的 Origin 必须回显 CORS 头");
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: `http://localhost:${address.port}`, authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: `http://127.0.0.1:${address.port}`, authorization: `Bearer ${token}` })).status, 200);
  // P2：WebView 壳 Origin（无端口 localhost）= Capacitor androidScheme 默认形态，必须放行；
  // 本项目 capacitor.config.ts 未覆盖 androidScheme → Android 实际 Origin 是 https://localhost
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: "https://localhost", authorization: `Bearer ${token}` })).status, 200, "Capacitor Android WebView（androidScheme 默认 https）Origin 必须放行");
  assert.equal((await httpJson(address.port, "GET", "/v1/bootstrap", { origin: "http://localhost", authorization: `Bearer ${token}` })).status, 200, "Capacitor WebView 配 http scheme 时的 Origin 必须放行");

  // baseUrl（Tailscale serve 等反代）必须放行其 https origin，且不放大到其它 https 站点
  const proxied = new RemoteAccessServer({ port: 0, baseUrl: "https://mybuddy.example.ts.net", staticRoot: webRoot, devices, pairing, service: service as never, commands: commands as never, events });
  const proxiedAddress = await proxied.start();
  assert.equal((await httpJson(proxiedAddress.port, "GET", "/v1/bootstrap", { origin: "https://mybuddy.example.ts.net", authorization: `Bearer ${token}` })).status, 200, "baseUrl origin 必须放行（https 反代通道）");
  assert.equal((await httpJson(proxiedAddress.port, "GET", "/v1/bootstrap", { origin: "https://other.example.ts.net", authorization: `Bearer ${token}` })).status, 403);
  await proxied.stop();

  const badPair = pairing.create(base);
  assert.equal((await fetch(`${base}/v1/pair/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: badPair.pairingId, secret: `${badPair.secret}x`, deviceName: "Bad" }) })).status, 400);
  assert.equal((await fetch(`${base}/v1/bootstrap`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models/settings`)).status, 401, "model settings must require authentication");
  assert.equal((await fetch(`${base}/v1/models/settings`, { method: "POST" })).status, 401, "model changes must require authentication");
  const invalidModelSettings = await fetch(`${base}/v1/models/settings`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "p/a", enabled: "true" }) });
  assert.equal(invalidModelSettings.status, 400, "model changes validate types");
  assert.equal((await fetch(`${base}/v1/models/refresh`, { method: "POST" })).status, 401, "model refresh must require device authentication");
  const refreshedModels = await fetch(`${base}/v1/models/refresh`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(refreshedModels.status, 200);
  assert.deepEqual(await refreshedModels.json(), { models: [{ id: "safe/model", name: "Safe", vendor: "safe", supportsReasoning: false, supportsImages: false }], errors: [{ providerId: "partial", message: "timeout" }] }, "model refresh must return only the service projection and provider errors");
  assert.equal(remoteModelCacheInvalidations, 1, "model refresh must invalidate the prompt model whitelist");
  assert.equal((await fetch(`${base}/v1/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/tasks/t/actions/stale/respond`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) })).status, 409);
  const interactionResponse = await fetch(`${base}/v1/tasks/t/interactions/i1/respond`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answer: "two" }),
  });
  assert.equal(interactionResponse.status, 200, "Android 回答选项必须有认证写接口");
  assert.deepEqual(capturedInteraction, { taskId: "t", interactionId: "i1", answer: "two" }, "回答必须原样进入主执行链");
  assert.equal((await fetch(`${base}/v1/tasks/t/interactions/i1/respond`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answer: { invalid: true } }),
  })).status, 400, "回答 payload 必须经过严格 schema 校验");
  assert.equal((await fetch(`${base}/v1/tasks/t/interactions/stale/respond`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answer: "one" }),
  })).status, 409, "失效回答不得误唤醒执行");
  assert.equal((await fetch(`${base}/v1/tasks/t/interactions/i2/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  })).status, 200, "Android 必须能够取消等待回答");
  assert.deepEqual(capturedInteraction, { taskId: "t", interactionId: "i2", cancelled: true });
  assert.equal((await fetch(`${base}/v1/tasks/t/actions/a/respond`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "deny", targetPath: "C:\\client-controlled" }) })).status, 400);
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x", cwd: "C:\\secret" }) })).status, 400);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  // prompt 路由体积护栏已放宽到 17MB（base64 附件）：513KB 文本落入 zod 校验失败，17MB+ 才 413
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(513 * 1024) }) })).status, 400);
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(17 * 1024 * 1024 + 64) }) })).status, 413);
  // 非 prompt 路由（审批）维持 512KB 上限
  assert.equal((await fetch(`${base}/v1/tasks/t/actions/a/respond`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "deny", pad: "x".repeat(512 * 1024) }) })).status, 413);

  // P0-2：模型 / 权限模式 / 附件随 prompt 原样透传到命令层
  const richPrompt = { operationId: randomUUID(), text: "hi", modelId: "model-x", permissionMode: "auto", attachments: [{ name: "a.png", data: Buffer.from("file-bytes").toString("base64"), mimeType: "image/png" }] };
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(richPrompt) })).status, 201);
  assert.deepEqual(capturedPrompt, richPrompt, "modelId / permissionMode / attachments 必须原样到达命令层");
  // P1：纯附件消息合法（text 空串 + 附件）；纯空白文本且无附件必须 400
  const pureAttachment = { operationId: randomUUID(), text: "", attachments: [{ name: "photo.jpg", data: Buffer.from("jpeg-bytes").toString("base64"), mimeType: "image/jpeg" }] };
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(pureAttachment) })).status, 201, "纯附件消息（拍照直接发送）必须被接受");
  assert.equal((capturedPrompt as { attachments?: unknown[] }).attachments?.length, 1);
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "   " }) })).status, 400, "空文本且无附件必须 400");
  // 附件 base64 超过 4M 上限被 zod 拒绝
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x", attachments: [{ name: "big", data: "A".repeat(4_000_001) }] }) })).status, 400);
  // 未知字段（webSearch 等契约外字段）仍被 .strict() 拒绝
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x", webSearch: true }) })).status, 400);
  const streamAbort = new AbortController();
  const streamRequest = fetch(`${base}/v1/events`, {
    headers: { authorization: `Bearer ${token}`, "last-event-id": String(second.id) },
    signal: streamAbort.signal,
  });
  setTimeout(() => events.publish("task.changed", { taskId: "stream-test" }), 20);
  const streamResponse = await streamRequest;
  const streamChunk = await streamResponse.body!.getReader().read();
  assert.match(new TextDecoder().decode(streamChunk.value), /stream-test/);
  streamAbort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.subscriberCount, 0, "SSE disconnect must release subscriber");
  const revoked = devices.issue("Revoked HTTP client");
  assert.equal((await fetch(`${base}/v1/bootstrap`, { headers: { authorization: `Bearer ${revoked.token}` } })).status, 200);
  devices.revoke(revoked.device.id);
  assert.equal((await fetch(`${base}/v1/bootstrap`, { headers: { authorization: `Bearer ${revoked.token}` } })).status, 401);

  // ---- RemoteTaskCommandService 行为单测（P0 权限保留 / P1 纯附件 / P2 附件生命周期） ----
  {
    const uploadsRoot = join(root, "uploads");
    const savedTasks = new Map<string, Record<string, unknown>>();
    const upsertCalls: Array<Record<string, unknown>> = [];
    const prompts: Array<Record<string, unknown>> = [];
    const db = {
      getTask: (id: string) => savedTasks.get(id),
      openDots: () => {
        const dots = { id: DOTS_TASK_ID, title: "Dots", updatedAt: 1, welcomeMode: "general", modePresetId: "native" };
        savedTasks.set(DOTS_TASK_ID, dots);
        return dots;
      },
      openDotsAsync: async () => {
        const dots = { id: DOTS_TASK_ID, title: "Dots", updatedAt: 1, welcomeMode: "general", modePresetId: "native" };
        savedTasks.set(DOTS_TASK_ID, dots);
        return dots;
      },
      readSpaces: async () => [],
      readNonTrashedTasks: async () => Array.from(savedTasks.values()).filter(task => task.id !== DOTS_TASK_ID),
      writeTaskRecord: async (task: Record<string, unknown>) => { upsertCalls.push(task); savedTasks.set(String(task.id), task); },
      isTaskEffectiveArchived: () => false,
      getSpace: () => undefined,
      deleteTask: (id: string) => { savedTasks.delete(id); },
    };
    const models = [
      { id: "vendor/ok", name: "OK", vendor: "vendor", contextWindow: 8192, supportsToolCall: true, supportsImages: false, supportsReasoning: false, enabled: true, available: true },
      { id: "vendor/unauthed", name: "Unauthed", vendor: "vendor", contextWindow: 8192, supportsToolCall: true, supportsImages: false, supportsReasoning: false, enabled: true, available: false },
    ];
    let failNextPrompt = false;
    const agent = {
      getModeProfile: (id: keyof typeof modeProfiles) => modeProfiles[id],
      findSubmission: async () => undefined,
      prompt: (req: Record<string, unknown>) => {
        prompts.push(req);
        // Admission failure reaches HTTP before success is returned.
        if (failNextPrompt) { failNextPrompt = false; return Promise.reject(new Error("agent runtime boom")); }
        return Promise.resolve({ queued: true, receipt: { taskId: req.taskId, operationId: req.userMessageId, submissionId: 1, status: "placed" } });
      },
      listModels: () => Promise.resolve(models),
      isTaskBusy: () => false,
      listPendingActions: () => [],
      loadTaskHistory: async (taskId: string) => ({ messages: taskId === DOTS_TASK_ID ? [{
        id: "delivery", role: "assistant", text: "", createdAt: 2,
        dotsDelivery: { taskId: "t-ro", kind: "conclusion", title: "报告", artifacts: [
          { id: "file-1", name: "报告.pdf", saved: { snapshotPath: "C:/private/snapshot.pdf" } },
        ] },
      }] : [] }),
      getConversationRuntimeSnapshot: () => ({ interactions: [] }),
      readConversationRuntimeSnapshot: async () => ({ interactions: [] }),
    };
    const settings = { read: () => ({ defaultModelId: null, permissionMode: "default" }), getTaskConnectorIds: () => [] };
    const commands = new RemoteTaskCommandService(db as never, agent as never, settings as never, { get: () => undefined } as never, uploadsRoot);

    for (const [welcomeMode, modePresetId] of [['working', 'general-office'], ['coding', 'custom-dev'], ['general', 'native'], ['general', 'codemode']] as const) {
      const result = await commands.createAndPrompt({ operationId: randomUUID(), text: 'selected configuration', welcomeMode, modePresetId });
      assert.equal(result.task.welcomeMode, welcomeMode);
      assert.equal(result.task.modePresetId, modePresetId);
      assert.equal(prompts.at(-1)?.welcomeMode, welcomeMode);
      assert.equal(prompts.at(-1)?.modePresetId, modePresetId);
    }
    const beforeInvalid = savedTasks.size;
    await assert.rejects(() => commands.createAndPrompt({ operationId: randomUUID(), text: 'wrong tag', welcomeMode: 'general', modePresetId: 'general-office' }), RemoteValidationError);
    assert.equal(savedTasks.size, beforeInvalid, 'invalid mode/tag must not create a task or invoke the runtime');

    // P0：readonly 任务、手机端未显式覆盖权限 → 不写回任务（权限保持 readonly），agent 收到 readonly
    savedTasks.set("t-ro", { id: "t-ro", title: "RO", updatedAt: 1, permissionMode: "readonly", modelId: undefined, sessionFile: "s.jsonl", welcomeMode: "coding" });
    upsertCalls.length = 0;
    await commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi" });
    assert.equal(upsertCalls.length, 0, "未显式覆盖权限时必须保持任务 readonly，不得写回 default");
    assert.equal((prompts.at(-1) as { permissionMode?: string }).permissionMode, "readonly", "agent 必须收到任务自身的 readonly 权限");

    // P0：用户在手机上显式切到 auto → 写回任务并生效
    await commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi", permissionMode: "auto" });
    assert.equal(upsertCalls.length, 1, "显式覆盖权限必须写回任务");
    assert.equal(upsertCalls[0].permissionMode, "auto");

    // P1：纯附件消息（text 空串）到达 agent，附件真实落盘
    await commands.promptExisting("t-ro", { operationId: randomUUID(), text: "", attachments: [{ name: "photo.jpg", data: Buffer.from("jpeg-bytes").toString("base64") }] });
    const lastPrompt = prompts.at(-1) as { text: string; attachments?: Array<{ name: string; path: string }> };
    assert.equal(lastPrompt.text, "");
    assert.equal(lastPrompt.attachments?.length, 1);
    assert.equal(existsSync(lastPrompt.attachments![0].path), true, "附件必须真实落盘到任务上传目录");

    // P2：附件超 4MB 原始字节 → RemoteValidationError，且历史附件不被连带删除
    await assert.rejects(
      () => commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi", attachments: [{ name: "big.bin", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] }),
      (error: unknown) => error instanceof RemoteValidationError,
      "超限附件必须是校验错误而非 500",
    );
    assert.equal(existsSync(lastPrompt.attachments![0].path), true, "回滚只清本次失败写入，不得误删历史附件");

    // 模型白名单：available=false（Provider 未认证）的模型不允许远程指定
    await assert.rejects(
      () => commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi", modelId: "vendor/unauthed" }),
      (error: unknown) => error instanceof RemoteValidationError,
      "未认证模型必须被可执行白名单拒绝",
    );
    await commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi", modelId: "vendor/ok" });

    // P1：纯附件新任务标题兜底取附件名；cleanupRemoteUploads 删除任务附件目录
    const created = await commands.createAndPrompt({ operationId: randomUUID(), text: "", attachments: [{ name: "cam.jpg", data: Buffer.from("x").toString("base64") }] });
    assert.equal(created.task.title, "附件：cam.jpg", "纯附件新任务标题应取附件名");
    assert.equal(existsSync(join(uploadsRoot, created.task.id)), true);
    await cleanupRemoteUploads(created.task.id, uploadsRoot);
    assert.equal(existsSync(join(uploadsRoot, created.task.id)), false, "cleanupRemoteUploads 必须删除任务附件目录");

    // Failed admission cannot report HTTP success; retain its stable task/input for safe retry.
    failNextPrompt = true;
    const retryInput = { operationId: randomUUID(), text: "hi", attachments: [{ name: "cam2.jpg", data: Buffer.from("x").toString("base64") }] };
    const beforeRetry = savedTasks.size;
    await assert.rejects(commands.createAndPrompt(retryInput), /agent runtime boom/);
    const rejectedPrompt = prompts.at(-1)!;
    const reopenedCommands = new RemoteTaskCommandService(db as never, agent as never, settings as never, { get: () => undefined } as never, uploadsRoot);
    const retry = await reopenedCommands.createAndPrompt(retryInput);
    assert.equal(savedTasks.size, beforeRetry + 1, "lost response or retry reuses the original task");
    assert.equal(retry.userMessageId, rejectedPrompt.userMessageId);
    assert.deepEqual(prompts.at(-1)?.attachments, rejectedPrompt.attachments, "retry reuses immutable attachment paths");
    assert.equal(retry.receipt.operationId, retry.userMessageId);
    await cleanupRemoteUploads(retry.task.id, uploadsRoot);

    // P1：附件写盘失败时任务的模型/权限不得半提交（先附件后 upsert 的事务顺序）
    savedTasks.set("t-ro", { id: "t-ro", title: "RO", updatedAt: 1, permissionMode: "readonly", modelId: undefined, sessionFile: "s.jsonl", welcomeMode: "coding" });
    const upsertsBefore = upsertCalls.length;
    await assert.rejects(
      () => commands.promptExisting("t-ro", { operationId: randomUUID(), text: "hi", permissionMode: "auto", attachments: [{ name: "big2.bin", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] }),
      (error: unknown) => error instanceof RemoteValidationError,
      "超限附件仍必须是校验错误",
    );
    assert.equal((savedTasks.get("t-ro") as { permissionMode?: string }).permissionMode, "readonly", "附件写盘失败时权限覆盖不得写回任务（无半提交）");
    assert.equal(upsertCalls.length, upsertsBefore, "附件写盘失败时不得触发任务 upsert");

    // P2：新任务创建失败（模型校验抛错）→ 任务行回滚，remote-uploads 不留新任务目录
    const savedBefore = new Set(savedTasks.keys());
    const failedCreate = await commands.createAndPrompt({ operationId: randomUUID(), text: "hi", modelId: "vendor/unauthed" }).then(() => undefined, (error: unknown) => error);
    assert.ok(failedCreate instanceof RemoteValidationError);
    assert.deepEqual([...savedTasks.keys()].filter((id) => !savedBefore.has(id)), [], "失败的新任务必须回滚任务行");
    assert.deepEqual(readdirSync(uploadsRoot).filter((entry) => entry !== "t-ro"), [], "失败的新任务不得残留附件目录");
    const commandHost = new RemoteAccessService(
      db as never, agent as never, { unreadCount: () => 0 } as never, { readList: async () => [] } as never, settings as never,
    );
    const promptServer = new RemoteAccessServer({ port: 0, staticRoot: webRoot, devices, pairing, service: commandHost, commands, events });
    const promptAddress = await promptServer.start();
    try {
      const phone = new RemoteClient(`http://127.0.0.1:${promptAddress.port}`, token);
      const dots = (await phone.bootstrap()).dots;
      assert.equal(dots?.id, DOTS_TASK_ID);
      assert.deepEqual((await phone.bootstrap()).dots, dots, "paired bootstrap reuses the same Dots conversation");
      assert.equal((await phone.bootstrap()).tasks.some(task => task.id === DOTS_TASK_ID), false);
      const listing = await fetch(`http://127.0.0.1:${promptAddress.port}/v1/tasks`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(listing.status, 200);
      const visible = await listing.json() as Array<{ id: string; permissionMode?: string }>;
      assert.equal(visible.find(task => task.id === "t-ro")?.permissionMode, "readonly");
      assert.equal(visible.some(task => task.id === DOTS_TASK_ID), false);
      assert.deepEqual((await phone.history(DOTS_TASK_ID)).messages[0]?.dotsDelivery, {
        taskId: "t-ro", kind: "conclusion", title: "报告", files: [{ id: "file-1", name: "报告.pdf" }],
      });
      assert.equal((await phone.runtime(DOTS_TASK_ID)).busy, false);
      await assert.rejects(phone.prompt(DOTS_TASK_ID, { text: "override", permissionMode: "auto" }), /电脑端配置/);
      await assert.rejects(phone.acpPrompt(DOTS_TASK_ID, { agentId: "codex", text: "override" }), /不支持切换/);
      await assert.rejects(phone.deleteTask(DOTS_TASK_ID), /不能删除/);
      await phone.prompt(DOTS_TASK_ID, { text: "帮我跟进报告" });
      assert.equal(prompts.at(-1)?.taskId, DOTS_TASK_ID);
      assert.equal(prompts.at(-1)?.text, "帮我跟进报告");
      assert.equal(prompts.at(-1)?.modePresetId, "native");
      assert.equal(prompts.at(-1)?.permissionMode, undefined);
      const count = prompts.length;
      await assert.rejects(phone.prompt("t-ro", { text: "correct rejected model", modelId: "vendor/unauthed" }), /不可用/);
      assert.equal(prompts.length, count, "HTTP rejection precedes Durable submission");
      await phone.prompt("t-ro", { text: "correct rejected model", modelId: "vendor/ok" });
      assert.equal(prompts.at(-1)?.modelId, "vendor/ok");
      failNextPrompt = true;
      await assert.rejects(phone.prompt("t-ro", { text: "unknown admission", modelId: "vendor/ok" }));
      const uncertain = prompts.at(-1);
      await phone.prompt("t-ro", { text: "unknown admission", modelId: "vendor/unauthed" });
      assert.equal(prompts.at(-1)?.userMessageId, uncertain?.userMessageId);
      assert.equal(prompts.at(-1)?.modelId, "vendor/ok", "post-dispatch HTTP failure retains the original payload");
    } finally { await promptServer.stop(); }

  }

  // ---- remoteStore 提交语义单测（P1：POST 成功即提交，后续同步失败不得伪装成发送失败） ----
  {
    const realFetch = globalThis.fetch;
    // 覆盖全局 fetch：按 URL/方法路由到可编程的模拟实现
    let route: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (route) return route(url, init);
      return realFetch(input, init);
    }) as typeof fetch;
    const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const networkFail = () => Promise.reject(new TypeError("fetch failed (模拟瞬时断网)"));
    const store = useRemoteStore.getState();
    const stubClient = new RemoteClient("http://127.0.0.1:9", "stub-token");

    try {
      const operationIds: string[] = [];
      let loseResponse = true;
      route = async (_url, init) => {
        const request: unknown = JSON.parse(String(init?.body));
        assert(request && typeof request === 'object' && 'operationId' in request && typeof request.operationId === 'string');
        operationIds.push(request.operationId);
        if (loseResponse) { loseResponse = false; throw new TypeError('response lost after admission'); }
        return jsonResponse({ task: { id: 'retry-task' }, userMessageId: 'retry-user', assistantMessageId: 'retry-assistant', queued: true,
          receipt: { taskId: 'retry-task', operationId: request.operationId, submissionId: 17, status: 'placed' } });
      };
      const once = new RemoteClient('http://retry-fixture', 'token');
      await assert.rejects(once.createTask({ text: 'one logical input' }), /response lost/);
      const reconnected = new RemoteClient('http://retry-fixture', 'token');
      await reconnected.createTask({ text: 'one logical input' });
      await reconnected.createTask({ text: 'one logical input' });
      assert.equal(operationIds[0], operationIds[1], 'lost response and client reconstruction must reuse persisted operation id');
      assert.notEqual(operationIds[1], operationIds[2], 'a new send after acknowledged receipt gets a new operation id');

      useRemoteStore.setState({ client: stubClient, activeTaskId: "t1", sending: false, creating: false, live: {} });

      // P1：prompt POST 成功后 runtime 刷新失败 → send() 必须成功 resolve（消息已提交，不得恢复草稿）
      route = (url, init) => {
        if (url.endsWith("/v1/tasks/t1/prompt") && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ task: { id: "t1" }, userMessageId: "u1", assistantMessageId: "a1", queued: true }));
        }
        return networkFail(); // runtime GET 失败
      };
      useRemoteStore.setState({ selectedModelId: "m1", toolAccessMode: "auto", selectedProjectId: "p1" });
      await store.send("hello"); // 不得 reject
      assert.equal(useRemoteStore.getState().live.t1?.u1?.text, "hello", "提交成功后 live 气泡必须落地");
      assert.equal(useRemoteStore.getState().sending, false);
      // transient 覆盖随提交复位（模型/权限/项目的一次性语义）
      assert.equal(useRemoteStore.getState().selectedModelId, null, "发送成功后 selectedModelId 必须复位");
      assert.equal(useRemoteStore.getState().toolAccessMode, "follow", "发送成功后 toolAccessMode 必须复位");
      assert.equal(useRemoteStore.getState().selectedProjectId, null, "发送成功后 selectedProjectId 必须复位");

      // request_user_input：POST 成功后立即把 resolved 状态投影到 runtime，避免等待轮询或旧快照回滚。
      const pendingInteraction = {
        id: "interaction-mobile", taskId: "t1", executionId: "e1", assistantMessageId: "a1",
        kind: "single_select" as const, title: "选择", options: [{ id: "one", label: "一" }, { id: "two", label: "二" }],
        status: "pending" as const, version: 1, createdAt: 1,
      };
      useRemoteStore.setState({
        runtimes: { t1: { taskId: "t1", busy: true, pendingActions: [], interactions: [pendingInteraction], activeGoal: null } },
      });
      route = (url, init) => {
        if (url.endsWith("/v1/tasks/t1/interactions/interaction-mobile/respond") && init?.method === "POST") {
          assert.deepEqual(JSON.parse(String(init.body)), { answer: "two" });
          return Promise.resolve(jsonResponse({ ok: true, interaction: { ...pendingInteraction, status: "resolved", answer: "two", version: 2, resolvedAt: 2 } }));
        }
        return networkFail();
      };
      await useRemoteStore.getState().respondInteraction("interaction-mobile", "two");
      assert.equal(useRemoteStore.getState().runtimes.t1.interactions[0]?.status, "resolved");
      assert.equal(useRemoteStore.getState().runtimes.t1.interactions[0]?.answer, "two");

      // 反向对照：prompt POST 本身失败 → send() 必须 reject（composer 才会恢复草稿）
      route = () => networkFail();
      await assert.rejects(() => useRemoteStore.getState().send("again"), "POST 失败必须向 composer 抛错以恢复草稿");

      // P1：createTask POST 成功后 refresh/openTask 全部失败 → create() 必须成功 resolve（任务已创建）
      route = (url, init) => {
        if (url.endsWith("/v1/tasks") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          assert.equal(body.welcomeMode, "working", "必须提交用户选择的模式");
          assert.equal(body.modePresetId, "general-office", "必须提交用户选择的 Tag");
          assert.equal(body.spaceId, "s1", "文件夹选择必须随创建请求传到服务端");
          assert.equal(body.projectId, "p1", "空间与项目归属必须同时保留");
          return Promise.resolve(jsonResponse({ task: { id: "created-1" }, userMessageId: "u2", assistantMessageId: "a2", queued: true }, 201));
        }
        return networkFail(); // bootstrap / notifications / history / runtime 全部失败
      };
      useRemoteStore.setState({ selectedModelId: "m1", toolAccessMode: "auto", selectedProjectId: "p1", selectedSpaceId: "s1", activeTaskId: null,
        selectedWelcomeMode: 'working', selectedModePresetId: 'general-office',
        bootstrap: { taskModes: catalogBootstrap.taskModes, projects: [{ id: "p1", name: "Project", archived: false }], spaces: [{ id: "s1", name: "Workspace", archived: false, effectiveArchived: false, pathMissing: false }] } as never });
      await useRemoteStore.getState().create("new task"); // 不得 reject
      assert.equal(useRemoteStore.getState().activeTaskId, "created-1", "创建成功后必须进入新任务（同步失败不回滚 activeTaskId）");
      assert.equal(useRemoteStore.getState().live["created-1"]?.u2?.text, "new task");
      assert.equal(useRemoteStore.getState().selectedProjectId, null, "创建成功后 selectedProjectId 必须复位（一次性选择）");
      assert.equal(useRemoteStore.getState().selectedSpaceId, null, "创建成功后空间必须复位，即使后续同步失败");
      assert.equal(useRemoteStore.getState().selectedWelcomeMode, null);
      assert.equal(useRemoteStore.getState().selectedModePresetId, null);
    } finally {
      globalThis.fetch = realFetch;
      useRemoteStore.setState({ client: null, activeTaskId: null, sending: false, creating: false, live: {} });
    }
  }

  await server.stop();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("remote access tests passed");
