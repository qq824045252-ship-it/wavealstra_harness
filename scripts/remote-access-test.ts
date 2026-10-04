import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingActionRegistry } from "../src/main/agent/PendingActionRegistry";
import { mapRemoteSpace, mapRemoteTask } from "../src/main/remote/RemoteDtoMapper";
import { RemoteEventBus, mapAgentPatchToRemoteEvent } from "../src/main/remote/RemoteEventBus";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteAccessService } from "../src/main/remote/RemoteAccessService";
import { parseAdbDevices } from "../src/main/remote/RemoteUsbBridge";
import { listLanIpv4Addresses, resolveRemotePairingBaseUrl } from "../src/main/remote/RemoteNetwork";
import { cleanupRemoteUploads, RemoteConflictError, RemoteTaskCommandService, RemoteValidationError } from "../src/main/remote/RemoteTaskCommandService";
import { RemoteClient } from "../app/remote/src/api/RemoteClient";
import { coalesceAssistantTurnMessages, reconcileLiveMessagesWithHistory, useRemoteStore } from "../app/remote/src/store/remoteStore";

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
  getConversationRuntimeSnapshot: () => ({ taskId: "legacy-chat", interactions: [], activeGoal: null,
    todos: [{ id: "retired-todo" }], activePlan: { id: "retired-plan" } }),
  isTaskBusy: () => false, listPendingActions: () => [],
} as any, {} as any, {} as any, {} as any);
const runtimeProjection = runtimeService.runtime("legacy-chat")!;
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
assert.deepEqual(events.replayAfter(first.id).map((event) => event.id), [second.id]);
const unsubscribe = events.subscribe(() => undefined);
assert.equal(events.subscriberCount, 1);
unsubscribe();
assert.equal(events.subscriberCount, 0);

assert.deepEqual(
  mapAgentPatchToRemoteEvent({ type: "user_message", taskId: "t", messageId: "u", text: "来自 Android", createdAt: 123 }),
  { type: "user_message", taskId: "t", messageId: "u", text: "来自 Android", createdAt: 123 },
  "cross-client user messages must survive the remote patch mapping",
);

const parsedUsb = parseAdbDevices("List of devices attached\r\nABC123 device product:foo model:Pixel_9 device:tokay transport_id:7\r\nXYZ unauthorized usb:1-2\r\n");
assert.equal(parsedUsb.length, 2);
assert.deepEqual(parsedUsb[0], { serial: "ABC123", state: "device", product: "foo", model: "Pixel 9", device: "tokay", transportId: "7" });
assert.equal(parsedUsb[1]?.state, "unauthorized");
assert.equal(resolveRemotePairingBaseUrl({ baseUrl: "https://desktop.example.ts.net", bindMode: "loopback", port: 3352, lanAddresses: [] }), "https://desktop.example.ts.net");
assert.equal(resolveRemotePairingBaseUrl({ baseUrl: "", bindMode: "lan", port: 3352, lanAddresses: ["192.168.10.12"] }), "http://192.168.10.12:3352");
assert.equal(resolveRemotePairingBaseUrl({ baseUrl: "", bindMode: "loopback", port: 3352, lanAddresses: ["192.168.10.12"] }), null, "network pairing must not emit an unusable loopback URL");

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
  const commands = {
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
  assert.doesNotThrow(() => new RemoteAccessServer({ port: 0, host: "0.0.0.0", devices, pairing, service: service as never, commands: commands as never, events }));
  assert.throws(() => new RemoteAccessServer({ port: 0, host: "192.168.1.10", devices, pairing, service: service as never, commands: commands as never, events }));
  assert.doesNotThrow(() => pairing.create("http://192.168.1.20:3352"));
  assert.throws(() => pairing.create("http://8.8.8.8:3352"));
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);

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

  const lanAddress = listLanIpv4Addresses()[0];
  if (lanAddress) {
    const lanServer = new RemoteAccessServer({ port: 0, host: "0.0.0.0", staticRoot: webRoot, devices, pairing, service: service as never, commands: commands as never, events });
    const lanBound = await lanServer.start();
    assert.equal((await fetch(`http://${lanAddress}:${lanBound.port}/healthz`)).status, 200, "LAN bind must be reachable through the physical RFC1918 address");
    assert.equal((await httpJson(lanBound.port, "GET", "/v1/bootstrap", { origin: `http://${lanAddress}:${lanBound.port}`, authorization: `Bearer ${token}` })).status, 200, "LAN 模式必须放行私网 IP 同端口来源");
    assert.equal((await httpJson(lanBound.port, "GET", "/v1/bootstrap", { origin: `http://8.8.8.8:${lanBound.port}`, authorization: `Bearer ${token}` })).status, 403, "LAN 模式仍须拒绝公网来源");
    await lanServer.stop();
  }
  const badPair = pairing.create(base);
  assert.equal((await fetch(`${base}/v1/pair/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: badPair.pairingId, secret: `${badPair.secret}x`, deviceName: "Bad" }) })).status, 400);
  assert.equal((await fetch(`${base}/v1/bootstrap`)).status, 401);
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
  const richPrompt = { text: "hi", modelId: "model-x", permissionMode: "auto", attachments: [{ name: "a.png", data: Buffer.from("file-bytes").toString("base64"), mimeType: "image/png" }] };
  assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(richPrompt) })).status, 201);
  assert.deepEqual(capturedPrompt, richPrompt, "modelId / permissionMode / attachments 必须原样到达命令层");
  // P1：纯附件消息合法（text 空串 + 附件）；纯空白文本且无附件必须 400
  const pureAttachment = { text: "", attachments: [{ name: "photo.jpg", data: Buffer.from("jpeg-bytes").toString("base64"), mimeType: "image/jpeg" }] };
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
      upsertTask: (task: Record<string, unknown>) => { upsertCalls.push(task); savedTasks.set(String(task.id), task); },
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
      prompt: (req: Record<string, unknown>) => {
        prompts.push(req);
        // 模拟 agent runtime 异步失败（preflight 拒绝 / provider 抛错），detached catch 负责回滚
        if (failNextPrompt) { failNextPrompt = false; return Promise.reject(new Error("agent runtime boom")); }
        return Promise.resolve({ queued: true });
      },
      listModels: () => Promise.resolve(models),
      isTaskBusy: () => false,
      listPendingActions: () => [],
    };
    const settings = { read: () => ({ defaultModelId: null, permissionMode: "default" }), getTaskConnectorIds: () => [] };
    const commands = new RemoteTaskCommandService(db as never, agent as never, settings as never, { get: () => undefined } as never, uploadsRoot);

    // P0：readonly 任务、手机端未显式覆盖权限 → 不写回任务（权限保持 readonly），agent 收到 readonly
    savedTasks.set("t-ro", { id: "t-ro", title: "RO", updatedAt: 1, permissionMode: "readonly", modelId: undefined, sessionFile: "s.jsonl", welcomeMode: "coding" });
    upsertCalls.length = 0;
    await commands.promptExisting("t-ro", { text: "hi" });
    assert.equal(upsertCalls.length, 0, "未显式覆盖权限时必须保持任务 readonly，不得写回 default");
    assert.equal((prompts.at(-1) as { permissionMode?: string }).permissionMode, "readonly", "agent 必须收到任务自身的 readonly 权限");

    // P0：用户在手机上显式切到 auto → 写回任务并生效
    await commands.promptExisting("t-ro", { text: "hi", permissionMode: "auto" });
    assert.equal(upsertCalls.length, 1, "显式覆盖权限必须写回任务");
    assert.equal(upsertCalls[0].permissionMode, "auto");

    // P1：纯附件消息（text 空串）到达 agent，附件真实落盘
    await commands.promptExisting("t-ro", { text: "", attachments: [{ name: "photo.jpg", data: Buffer.from("jpeg-bytes").toString("base64") }] });
    const lastPrompt = prompts.at(-1) as { text: string; attachments?: Array<{ name: string; path: string }> };
    assert.equal(lastPrompt.text, "");
    assert.equal(lastPrompt.attachments?.length, 1);
    assert.equal(existsSync(lastPrompt.attachments![0].path), true, "附件必须真实落盘到任务上传目录");

    // P2：附件超 4MB 原始字节 → RemoteValidationError，且历史附件不被连带删除
    await assert.rejects(
      () => commands.promptExisting("t-ro", { text: "hi", attachments: [{ name: "big.bin", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] }),
      (error: unknown) => error instanceof RemoteValidationError,
      "超限附件必须是校验错误而非 500",
    );
    assert.equal(existsSync(lastPrompt.attachments![0].path), true, "回滚只清本次失败写入，不得误删历史附件");

    // 模型白名单：available=false（Provider 未认证）的模型不允许远程指定
    await assert.rejects(
      () => commands.promptExisting("t-ro", { text: "hi", modelId: "vendor/unauthed" }),
      (error: unknown) => error instanceof RemoteValidationError,
      "未认证模型必须被可执行白名单拒绝",
    );
    await commands.promptExisting("t-ro", { text: "hi", modelId: "vendor/ok" });

    // P1：纯附件新任务标题兜底取附件名；cleanupRemoteUploads 删除任务附件目录
    const created = await commands.createAndPrompt({ text: "", attachments: [{ name: "cam.jpg", data: Buffer.from("x").toString("base64") }] });
    assert.equal(created.task.title, "附件：cam.jpg", "纯附件新任务标题应取附件名");
    assert.equal(existsSync(join(uploadsRoot, created.task.id)), true);
    await cleanupRemoteUploads(created.task.id, uploadsRoot);
    assert.equal(existsSync(join(uploadsRoot, created.task.id)), false, "cleanupRemoteUploads 必须删除任务附件目录");

    // P1/P2：HTTP 已 201 返回后 agent 异步失败（detached catch 路径）→ 无 session 的任务行与附件目录一并清理
    failNextPrompt = true;
    const asyncFailed = await commands.createAndPrompt({ text: "hi", attachments: [{ name: "cam2.jpg", data: Buffer.from("x").toString("base64") }] });
    assert.equal(existsSync(join(uploadsRoot, asyncFailed.task.id)), true, "201 返回时附件应已落盘");
    await new Promise((resolve) => setTimeout(resolve, 20)); // 等 detached catch + cleanup 完成
    assert.equal(savedTasks.has(asyncFailed.task.id), false, "agent 异步失败后无 session 的任务必须被删除");
    assert.equal(existsSync(join(uploadsRoot, asyncFailed.task.id)), false, "agent 异步失败后附件目录必须被清理（不得留孤儿目录）");

    // P1：附件写盘失败时任务的模型/权限不得半提交（先附件后 upsert 的事务顺序）
    savedTasks.set("t-ro", { id: "t-ro", title: "RO", updatedAt: 1, permissionMode: "readonly", modelId: undefined, sessionFile: "s.jsonl", welcomeMode: "coding" });
    const upsertsBefore = upsertCalls.length;
    await assert.rejects(
      () => commands.promptExisting("t-ro", { text: "hi", permissionMode: "auto", attachments: [{ name: "big2.bin", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] }),
      (error: unknown) => error instanceof RemoteValidationError,
      "超限附件仍必须是校验错误",
    );
    assert.equal((savedTasks.get("t-ro") as { permissionMode?: string }).permissionMode, "readonly", "附件写盘失败时权限覆盖不得写回任务（无半提交）");
    assert.equal(upsertCalls.length, upsertsBefore, "附件写盘失败时不得触发任务 upsert");

    // P2：新任务创建失败（模型校验抛错）→ 任务行回滚，remote-uploads 不留新任务目录
    const savedBefore = new Set(savedTasks.keys());
    const failedCreate = await commands.createAndPrompt({ text: "hi", modelId: "vendor/unauthed" }).then(() => undefined, (error: unknown) => error);
    assert.ok(failedCreate instanceof RemoteValidationError);
    assert.deepEqual([...savedTasks.keys()].filter((id) => !savedBefore.has(id)), [], "失败的新任务必须回滚任务行");
    assert.deepEqual(readdirSync(uploadsRoot).filter((entry) => entry !== "t-ro"), [], "失败的新任务不得残留附件目录");
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
          assert.equal(body.welcomeMode, "working", "Android 新任务默认必须是日常办公");
          assert.equal(body.modePresetId, "general-office", "Android 新任务默认必须是通用办公 Tag");
          return Promise.resolve(jsonResponse({ task: { id: "created-1" }, userMessageId: "u2", assistantMessageId: "a2", queued: true }, 201));
        }
        return networkFail(); // bootstrap / notifications / history / runtime 全部失败
      };
      useRemoteStore.setState({ selectedModelId: "m1", toolAccessMode: "auto", selectedProjectId: "p1", activeTaskId: null });
      await useRemoteStore.getState().create("new task"); // 不得 reject
      assert.equal(useRemoteStore.getState().activeTaskId, "created-1", "创建成功后必须进入新任务（同步失败不回滚 activeTaskId）");
      assert.equal(useRemoteStore.getState().live["created-1"]?.u2?.text, "new task");
      assert.equal(useRemoteStore.getState().selectedProjectId, null, "创建成功后 selectedProjectId 必须复位（一次性选择）");
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
