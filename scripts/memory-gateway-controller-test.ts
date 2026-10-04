import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(join(tmpdir(), "mybuddy-memory-controller-"));
process.env.USERPROFILE = root;
process.env.HOME = root;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let db: any = null;
let controller: any = null;
let overridden: any = null;
try {
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { AppSettingsStore } = await import("../src/main/AppSettingsStore");
  const { MemoryService } = await import("../src/main/memory/MemoryService");
  const { MemoryGatewayController } = await import("../src/main/memory/MemoryGatewayController");
  const { MemoryGatewayAccessControl } = await import("../src/main/memory/MemoryGatewayAccessControl");

  db = new AppDatabase(join(root, "app.db"));
  const now = Date.now();
  db.connection.prepare("INSERT INTO projects (id,name,created_at,updated_at,archived,resource_budget_chars) VALUES (?,?,?,?,0,128000)").run("p1", "P1", now, now);
  db.upsertSpace({ id: "ws1", name: "WS1", archived: false, updatedAt: now });
  db.upsertTask({ id: "t1", title: "T1", projectId: "p1", spaceId: "ws1", status: "in_progress", updatedAt: now });
  const memory = new MemoryService(db, { semantic: false });
  memory.create({ kind: "fact", title: "P1 fact", content: "controller test", scopeType: "project", scopeId: "p1", sourceType: "manual" });

  const settings = new AppSettingsStore();
  assert.equal(settings.read().memoryGatewayEnabled, false, "external access is opt-in by default");
  assert.equal(settings.read().memoryGatewayWriteEnabled, false);
  assert.equal(settings.read().memoryGatewayPort, 3351);

  controller = new MemoryGatewayController(db, memory, {} as NodeJS.ProcessEnv);
  let status = await controller.start();
  assert.equal(status.running, false);

  const port = await freePort();
  status = await controller.configure({ enabled: true, port, writeEnabled: false });
  assert.equal(status.running, true);
  assert.equal(status.port, port);
  assert.equal(status.writeEnabled, false);

  const issued = controller.createGrant({ name: "Controller client", mode: "read", scopeType: "project", scopeId: "p1" });
  assert.equal(controller.status().grantCount, 1);
  const search = await fetch(`${status.httpBaseUrl}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId: "t1" }),
  });
  assert.equal(search.status, 200);

  // Global memoryEnabled is dynamic and stronger than the Gateway switch.
  settings.write({ memoryEnabled: false });
  const disabledRead = await fetch(`${status.httpBaseUrl}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId: "t1" }),
  });
  assert.equal(disabledRead.status, 403);
  const disabledClient = new Client({ name: "disabled-memory-test", version: "1.0.0" });
  const disabledTransport = new StreamableHTTPClientTransport(new URL(status.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
  });
  await disabledClient.connect(disabledTransport);
  assert.equal(disabledClient.getServerCapabilities()?.tools, undefined, "MCP does not advertise tools capability while Memory is disabled");
  await disabledClient.close();
  settings.write({ memoryEnabled: true });

  // Master write toggle is dynamic and requires no listener restart.
  const writeGrant = controller.createGrant({ name: "Writer", mode: "read-write", scopeType: "project", scopeId: "p1" });
  const beforeUrl = controller.status().mcpUrl;
  status = await controller.configure({ writeEnabled: true });
  assert.equal(status.mcpUrl, beforeUrl);
  const writeClient = new Client({ name: "controller-write-test", version: "1.0.0" });
  const writeTransport = new StreamableHTTPClientTransport(new URL(status.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${writeGrant.token}` } },
  });
  await writeClient.connect(writeTransport);
  assert((await writeClient.listTools()).tools.some((tool) => tool.name === "memory_create"));
  await writeClient.close();

  // Failed port switch rolls settings back and keeps the old listener alive.
  const occupiedPort = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(occupiedPort, "127.0.0.1", () => resolve());
  });
  let switchFailed = false;
  try { await controller.configure({ port: occupiedPort }); } catch { switchFailed = true; }
  assert.equal(switchFailed, true);
  assert.equal(controller.status().port, port, "failed port switch preserves the old listener");
  assert.equal(settings.read().memoryGatewayPort, port, "failed port switch rolls persisted settings back");
  const oldStillHealthy = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(oldStillHealthy.status, 200);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));

  const concurrentPortA = await freePort();
  const concurrentPortB = await freePort();
  const firstConfigure = controller.configure({ port: concurrentPortA });
  const secondConfigure = controller.configure({ port: concurrentPortB });
  await Promise.all([firstConfigure, secondConfigure]);
  assert.equal(controller.status().port, concurrentPortB, "serialized lifecycle makes the last configure invocation authoritative");
  assert.equal(settings.read().memoryGatewayPort, concurrentPortB);
  const concurrentHealth = await fetch(`http://127.0.0.1:${concurrentPortB}/healthz`);
  assert.equal(concurrentHealth.status, 200);

  status = await controller.configure({ enabled: false });
  assert.equal(status.running, false);
  // Environment variables remain explicit operator overrides and are visible in status.
  const envPort = await freePort();
  overridden = new MemoryGatewayController(db, memory, {
    MYBUDDY_MEMORY_GATEWAY_ENABLED: "1",
    MYBUDDY_MEMORY_GATEWAY_WRITE: "1",
    MYBUDDY_MEMORY_GATEWAY_PORT: String(envPort),
  } as NodeJS.ProcessEnv);
  const overriddenStatus = await overridden.start();
  assert.equal(overriddenStatus.running, true);
  assert.equal(overriddenStatus.port, envPort);
  assert.equal(overriddenStatus.writeEnabled, true);
  assert.deepEqual(overriddenStatus.environmentOverrides, { enabled: true, writeEnabled: true, port: true });
  await overridden.stop();
  settings.write({ memoryGatewayEnabled: false, memoryGatewayWriteEnabled: false, memoryGatewayPort: 3351 });
  overridden = new MemoryGatewayController(db, memory, {
    MYBUDDY_MEMORY_GATEWAY_ENABLED: "maybe",
    MYBUDDY_MEMORY_GATEWAY_WRITE: "flase",
    MYBUDDY_MEMORY_GATEWAY_PORT: "not-a-port",
  } as NodeJS.ProcessEnv);
  const invalidOverrideStatus = await overridden.start();
  assert.equal(invalidOverrideStatus.running, false, "invalid enabled env value is ignored instead of truthy-enabling Gateway");
  assert.equal(invalidOverrideStatus.writeEnabled, false, "invalid write env value can never truthy-enable external writes");
  assert.deepEqual(invalidOverrideStatus.environmentOverrides, { enabled: false, writeEnabled: false, port: false }, "invalid environment values do not lock product controls");

  await overridden.stop();
  settings.write({ memoryGatewayEnabled: false, memoryGatewayWriteEnabled: false });
  const corruptAccessPath = join(root, "corrupt-memory-access.json");
  writeFileSync(corruptAccessPath, "{not-json", "utf-8");
  const corruptAccess = new MemoryGatewayAccessControl(corruptAccessPath);
  overridden = new MemoryGatewayController(db, memory, {} as NodeJS.ProcessEnv, corruptAccess);
  const corruptIdleStatus = overridden.status();
  assert.equal(corruptIdleStatus.running, false);
  assert.match(corruptIdleStatus.grantStoreError ?? "", /授权文件损坏/, "corrupt grant state is visible while disabled");
  let corruptStartFailed = false;
  try { await overridden.configure({ enabled: true, port: await freePort() }); } catch { corruptStartFailed = true; }
  assert.equal(corruptStartFailed, true, "corrupt grant store fails closed before listener startup");
  assert.equal(overridden.status().running, false, "corrupt grant store never leaves a hidden owner listener alive");

  console.log("memory-gateway-controller-test: PASS");
} finally {
  await controller?.stop?.().catch(() => undefined);
  await overridden?.stop?.().catch(() => undefined);
  try { db?.close?.(); } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 80));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
}
