import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(join(tmpdir(), "mybuddy-memory-gateway-"));
process.env.USERPROFILE = root;
process.env.HOME = root;

function project(db: any, id: string, name: string): void {
  const now = Date.now();
  db.connection.prepare(
    "INSERT INTO projects (id,name,created_at,updated_at,archived,resource_budget_chars) VALUES (?,?,?,?,0,128000)",
  ).run(id, name, now, now);
}

function ids(hits: Array<{ memory: { id: string } }>): Set<string> {
  return new Set(hits.map((hit) => hit.memory.id));
}

async function expectGatewayError(run: () => unknown | Promise<unknown>, code: string): Promise<void> {
  let seen = "";
  try { await run(); } catch (error) { seen = (error as { code?: string }).code ?? ""; }
  assert.equal(seen, code);
}

try {
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { MemoryService } = await import("../src/main/memory/MemoryService");
  const { MemoryGatewayService } = await import("../src/main/memory/MemoryGatewayService");
  const { MemoryGatewayServer, loadOrCreateMemoryGatewayToken } = await import("../src/main/memory/MemoryGatewayServer");
  const { MemoryGatewayAccessControl } = await import("../src/main/memory/MemoryGatewayAccessControl");

  const db = new AppDatabase(join(root, "app.db"));
  db.upsertSpace({ id: "ws-root", name: "Root", archived: false });
  db.upsertSpace({ id: "ws-child", name: "Child", parentId: "ws-root", archived: false });
  db.upsertSpace({ id: "ws-sibling", name: "Sibling", parentId: "ws-root", archived: false });
  project(db, "project-a", "Project A");
  project(db, "project-b", "Project B");
  db.upsertTask({ id: "task-a", title: "Task A", spaceId: "ws-child", projectId: "project-a", status: "in_progress", updatedAt: Date.now() });
  db.upsertTask({ id: "task-b", title: "Task B", spaceId: "ws-sibling", projectId: "project-b", status: "in_progress", updatedAt: Date.now() });

  const memory = new MemoryService(db, { semantic: false });
  const global = memory.create({ kind: "preference", title: "Global preference", content: "Prefer deterministic tests", scopeType: "global", explicit: true, sourceType: "manual" });
  const projectA = memory.create({ kind: "fact", title: "Project A fact", content: "A-only", scopeType: "project", scopeId: "project-a", sourceType: "manual" });
  const projectB = memory.create({ kind: "fact", title: "Project B fact", content: "B-only", scopeType: "project", scopeId: "project-b", sourceType: "manual" });
  const parentWs = memory.create({ kind: "constraint", title: "Parent constraint", content: "Inherited by child", scopeType: "workspace", scopeId: "ws-root", sourceType: "manual" });
  const childWs = memory.create({ kind: "decision", title: "Child decision", content: "Child-only", scopeType: "workspace", scopeId: "ws-child", sourceType: "manual" });
  const siblingWs = memory.create({ kind: "risk", title: "Sibling risk", content: "Sibling-only", scopeType: "workspace", scopeId: "ws-sibling", sourceType: "manual" });

  const readOnly = new MemoryGatewayService(db, memory, { writeEnabled: false });

  let featureEnabled = true;
  const settingGated = new MemoryGatewayService(db, memory, { writeEnabled: true, isMemoryEnabled: () => featureEnabled });
  assert((await settingGated.search({ taskId: "task-a", limit: 10 })).length > 0);
  featureEnabled = false;
  await expectGatewayError(() => settingGated.search({ taskId: "task-a" }), "memory_disabled");
  await expectGatewayError(() => Promise.resolve(settingGated.stats()), "memory_disabled");
  await expectGatewayError(() => Promise.resolve(settingGated.create({ taskId: "task-a", kind: "procedure", title: "disabled" })), "memory_disabled");
  assert(memory.get(projectA.id), "disabling Memory blocks loading but preserves existing records");
  featureEnabled = true;

  const globalHits = await readOnly.search({ limit: 100 });
  assert.deepEqual([...ids(globalHits)], [global.id], "global-only gateway context exposes only Global memory");

  const taskAHits = await readOnly.search({ taskId: "task-a", limit: 100 });
  const visibleA = ids(taskAHits);
  assert(visibleA.has(global.id));
  assert(visibleA.has(projectA.id));
  assert(visibleA.has(parentWs.id), "child Workspace inherits parent Workspace memory");
  assert(visibleA.has(childWs.id));
  assert(!visibleA.has(projectB.id), "other Project never leaks into task context");
  assert(!visibleA.has(siblingWs.id), "sibling Workspace never leaks into task context");

  await expectGatewayError(
    () => readOnly.search({ taskId: "task-a", projectId: "project-b" }),
    "invalid_context",
  );
  await expectGatewayError(() => Promise.resolve(readOnly.get({ taskId: "task-a", id: projectB.id })), "not_found");
  await expectGatewayError(
    () => Promise.resolve(readOnly.create({ taskId: "task-a", kind: "fact", title: "blocked" })),
    "write_disabled",
  );

  const writable = new MemoryGatewayService(db, memory, { writeEnabled: true });
  const created = writable.create({
    taskId: "task-a",
    kind: "procedure",
    title: "Gateway procedure",
    content: "Use the portable gateway safely",
    sourceRef: "external-system:test",
  });
  assert(created.scopes.some((scope) => scope.scopeType === "project" && scope.scopeId === "project-a"), "task writes default Project > Workspace > Task");
  assert.equal(created.sourceType, "tool");
  assert.equal(created.sourceId, "memory-gateway:owner");
  assert.equal(created.sourceTaskId, "task-a");
  assert(created.evidence.some((item) => item.evidenceKind === "external" && item.refId === "external-system:test"));

  await expectGatewayError(
    () => Promise.resolve(writable.create({ projectId: "project-a", kind: "fact", title: "missing scope" })),
    "invalid_request",
  );
  await expectGatewayError(
    () => Promise.resolve(writable.create({ taskId: "task-a", kind: "fact", title: "bad global", scopeType: "global" })),
    "forbidden_scope",
  );
  await expectGatewayError(
    () => Promise.resolve(writable.create({ taskId: "task-a", kind: "preference", title: "must promote", scopeType: "global" })),
    "forbidden_scope",
  );
  const globalCreated = writable.create({ kind: "preference", title: "Portable preference", scopeType: "global" });
  assert(globalCreated.scopes.some((scope) => scope.scopeType === "global"));

  await expectGatewayError(
    () => Promise.resolve(writable.update({ taskId: "task-a", id: projectB.id, title: "cross-project" })),
    "not_found",
  );
  const updated = writable.update({ taskId: "task-a", id: created.id, content: "Updated through gateway", changeReason: "test" });
  assert.equal(updated.content, "Updated through gateway");
  assert(memory.history(created.id).some((revision) => revision.changedBy === "tool"), "gateway update uses revision-safe MemoryService path");

  const promoted = writable.promote({ taskId: "task-a", id: created.id, targetScopeType: "global" });
  assert(promoted.scopes.some((scope) => scope.scopeType === "global" && scope.binding === "promoted"));
  await expectGatewayError(
    () => Promise.resolve(writable.promote({ taskId: "task-a", id: projectA.id, targetScopeType: "global" })),
    "forbidden_scope",
  );
  await expectGatewayError(
    () => Promise.resolve(writable.promote({ projectId: "project-a", id: created.id, targetScopeType: "global" })),
    "forbidden_scope",
  );

  const disposable = writable.create({ taskId: "task-a", kind: "progress", title: "Disposable" });
  writable.forget({ taskId: "task-a", id: disposable.id });
  assert.equal(memory.get(disposable.id), undefined);
  await expectGatewayError(() => Promise.resolve(writable.forget({ taskId: "task-a", id: projectB.id })), "not_found");

  const recallBefore = memory.get(projectA.id)?.recallCount ?? -1;
  const projected = readOnly.resolveMemoryContext({ taskId: "task-a", query: "Project A", budgetChars: 1800 });
  assert(projected.items.some((item) => item.id === projectA.id));
  assert.equal(memory.get(projectA.id)?.recallCount, recallBefore, "external read-only context projection does not mutate recall counters");

  const tokenFile = join(root, "stable-gateway.token");
  const generatedToken = loadOrCreateMemoryGatewayToken(tokenFile);
  assert(generatedToken.length >= 32);
  assert.equal(loadOrCreateMemoryGatewayToken(tokenFile), generatedToken, "gateway Bearer token is stable across restarts");
  const brokenTokenFile = join(root, "broken-gateway.token");
  writeFileSync(brokenTokenFile, "broken\n", "utf-8");
  const recoveredToken = loadOrCreateMemoryGatewayToken(brokenTokenFile);
  assert(recoveredToken.length >= 32 && recoveredToken !== "broken", "invalid token file is replaced with a strong token");
  assert(!readdirSync(root).some((name) => name.startsWith("broken-gateway.token.tmp-")), "token recovery leaves no temporary secret file");
  const token = "memory-gateway-test-token-0123456789abcdef";
  const server = new MemoryGatewayServer(readOnly, { port: 0, token, tokenPath: join(root, "gateway.token") });
  const status = await server.start();
  assert.equal(status.running, true);
  assert(status.port && status.port > 0);
  const base = `http://127.0.0.1:${status.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { writeEnabled: boolean }).writeEnabled, false);

  const conflictingServer = new MemoryGatewayServer(readOnly, { port: status.port, token: "memory-gateway-conflict-test-0123456789abcdef", tokenPath: join(root, "conflict.token") });
  let conflictFailed = false;
  try { await conflictingServer.start(); } catch { conflictFailed = true; }
  assert.equal(conflictFailed, true, "port collision fails the second Gateway start deterministically");
  assert.equal(conflictingServer.status().running, false);
  const stillHealthy = await fetch(`${base}/healthz`);
  assert.equal(stillHealthy.status, 200, "failed second start does not disturb the original listener");

  const unauthorized = await fetch(`${base}/v1/memory/stats`);
  assert.equal(unauthorized.status, 401);

  const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const evilOrigin = await fetch(`${base}/v1/memory/stats`, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } });
  assert.equal(evilOrigin.status, 403, "non-loopback browser Origin is rejected even with token");

  const httpSearch = await fetch(`${base}/v1/memory/search`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ taskId: "task-a", limit: 100 }),
  });
  assert.equal(httpSearch.status, 200);
  const httpSearchBody = await httpSearch.json() as { ok: boolean; data: Array<{ memory: { id: string } }> };
  assert.equal(httpSearchBody.ok, true);
  assert(!ids(httpSearchBody.data).has(projectB.id));

  const httpWrite = await fetch(`${base}/v1/memory/create`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ taskId: "task-a", kind: "fact", title: "blocked HTTP write" }),
  });
  assert.equal(httpWrite.status, 403, "HTTP writes honor the same read-only gateway gate");

  const client = new Client({ name: "memory-gateway-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["memory_search", "memory_get", "memory_history", "memory_context", "memory_stats"]) assert(toolNames.has(name), `MCP exposes ${name}`);
  for (const name of ["memory_create", "memory_update", "memory_promote", "memory_forget"]) assert(!toolNames.has(name), `read-only MCP does not expose ${name}`);

  const mcpSearch = CallToolResultSchema.parse(await client.callTool({ name: "memory_search", arguments: { taskId: "task-a", limit: 100 } }));
  assert.equal(mcpSearch.isError, undefined);
  const content = mcpSearch.content[0];
  assert(content && content.type === "text");
  const mcpHits = JSON.parse(content.type === "text" ? content.text : "[]") as Array<{ memory: { id: string } }>;
  assert(ids(mcpHits).has(projectA.id));
  assert(!ids(mcpHits).has(projectB.id), "real MCP protocol preserves server-side scope isolation");

  await client.close();
  await server.stop();
  assert.equal(server.status().running, false, "server stop releases lifecycle state before DB shutdown");

  const writeToken = "memory-gateway-write-test-token-0123456789abcdef";
  const writeServer = new MemoryGatewayServer(writable, { port: 0, token: writeToken, tokenPath: join(root, "gateway-write.token") });
  const writeStatus = await writeServer.start();
  const writeClient = new Client({ name: "memory-gateway-write-test", version: "1.0.0" });
  const writeTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${writeStatus.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${writeToken}` } },
  });
  await writeClient.connect(writeTransport);
  const writeTools = await writeClient.listTools();
  const writeToolNames = new Set(writeTools.tools.map((tool) => tool.name));
  for (const name of ["memory_create", "memory_update", "memory_promote", "memory_forget"]) assert(writeToolNames.has(name), `write-enabled MCP exposes ${name}`);
  const mcpCreate = CallToolResultSchema.parse(await writeClient.callTool({
    name: "memory_create",
    arguments: { taskId: "task-a", kind: "procedure", title: "Created through real MCP", content: "portable write" },
  }));
  assert.equal(mcpCreate.isError, undefined);
  const createContent = mcpCreate.content[0];
  assert(createContent && createContent.type === "text");
  const mcpCreated = JSON.parse(createContent.type === "text" ? createContent.text : "{}") as { id?: string; sourceType?: string; sourceId?: string; scopes?: Array<{ scopeType: string; scopeId?: string }> };
  assert(mcpCreated.id && memory.get(mcpCreated.id), "real MCP write reaches the single MemoryService/L1 truth");
  assert.equal(mcpCreated.sourceType, "tool");
  assert.equal(mcpCreated.sourceId, "memory-gateway:owner");
  assert(mcpCreated.scopes?.some((scope) => scope.scopeType === "project" && scope.scopeId === "project-a"));
  await writeClient.close();
  await writeServer.stop();

  // Delegated External Agent access: independent hashed tokens, scope isolation, immediate rotate/revoke.
  const accessPath = join(root, "memory-access.json");
  const access = new MemoryGatewayAccessControl(accessPath);
  const projectRead = access.create({ name: "ChatGPT Project A", mode: "read", scopeType: "project", scopeId: "project-a" });
  assert(!readFileSync(accessPath, "utf-8").includes(projectRead.token), "delegated token plaintext is never persisted");
  await new Promise((resolve) => setTimeout(resolve, 4));
  memory.update({ id: projectA.id, content: "A-only after delegated access", changedBy: "manual", changeReason: "post-grant edit" });
  const promotedFromGlobal = memory.create({
    kind: "procedure",
    title: "Promoted procedure",
    content: "private-before-promotion-v1",
    scopeType: "global",
    sourceType: "manual",
    sourceId: "private-origin",
    sourceTaskId: "task-b",
    metadata: { privateOrigin: "must-not-leak" },
    evidence: [{ evidenceKind: "task", refId: "task-b", excerpt: "private evidence before promotion" }],
  });
  memory.update({ id: promotedFromGlobal.id, content: "private-before-promotion-v2", changedBy: "manual", changeReason: "pre-promotion private edit" });
  memory.repository.addRelation({ id: "rel-private-origin", fromMemoryId: promotedFromGlobal.id, relation: "SUPPORTS", toMemoryId: global.id, createdAt: Date.now() });
  memory.promote(promotedFromGlobal.id, "project", "project-a");
  await new Promise((resolve) => setTimeout(resolve, 4));
  memory.update({ id: promotedFromGlobal.id, content: "shared-after-promotion", changedBy: "manual", changeReason: "post-promotion shared edit" });
  assert(access.list().some((grant) => grant.name === "ChatGPT Project A"));

  // Even an `all` delegated grant has a temporal boundary; it is not owner access.
  const allRead = access.create({ name: "All scopes reader", mode: "read", scopeType: "all" });
  await new Promise((resolve) => setTimeout(resolve, 4));
  memory.update({ id: global.id, content: "global after all-grant access", changedBy: "manual", changeReason: "post-all-grant edit" });
  const allHistory = writable.withAccess(access.authenticate(allRead.token)!).history({ id: global.id });
  assert(allHistory.some((revision) => revision.content === "global after all-grant access"));
  assert(!allHistory.some((revision) => revision.content === "Prefer deterministic tests"), "all delegated grant cannot read revisions from before access");

  const resetGrant = access.create({ name: "Reset boundary", mode: "read", scopeType: "project", scopeId: "project-a" });
  await new Promise((resolve) => setTimeout(resolve, 4));
  const rescoped = access.update({ id: resetGrant.grant.id, scopeType: "project", scopeId: "project-b" });
  assert(rescoped.accessSince > resetGrant.grant.accessSince, "scope change resets delegated history boundary");

  const delegatedOwnerToken = "memory-gateway-delegated-owner-0123456789abcdef";
  const delegatedServer = new MemoryGatewayServer(writable, {
    port: 0,
    token: delegatedOwnerToken,
    tokenPath: join(root, "delegated-owner.token"),
    accessControl: access,
  });
  const delegatedStatus = await delegatedServer.start();
  const delegatedBase = `http://127.0.0.1:${delegatedStatus.port}`;

  const projectClient = new Client({ name: "project-grant-test", version: "1.0.0" });
  const projectTransport = new StreamableHTTPClientTransport(new URL(`${delegatedBase}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${projectRead.token}` } },
  });
  await projectClient.connect(projectTransport);
  const projectTools = new Set((await projectClient.listTools()).tools.map((tool) => tool.name));
  assert(projectTools.has("memory_search"));
  assert(!projectTools.has("memory_stats"), "delegated grants never receive owner-level stats");
  assert(!projectTools.has("memory_create"), "read grant cannot write even when master write is enabled");
  const projectAllowed = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_search", arguments: { taskId: "task-a", limit: 100 } }));
  assert.equal(projectAllowed.isError, undefined);
  const projectAllowedText = projectAllowed.content[0];
  assert(projectAllowedText?.type === "text");
  const projectScopedHits = JSON.parse(projectAllowedText.type === "text" ? projectAllowedText.text : "[]") as Array<{ memory: { id: string } }>;
  const projectScopedIds = ids(projectScopedHits);
  assert(projectScopedIds.has(projectA.id), "Project grant sees its Project L1");
  assert(!projectScopedIds.has(global.id), "Project grant does not inherit Global L1");
  assert(!projectScopedIds.has(childWs.id), "Project grant does not inherit Workspace L1");
  assert(!projectScopedIds.has(parentWs.id), "Project grant does not inherit parent Workspace L1");
  assert(projectScopedIds.has(promotedFromGlobal.id), "explicitly promoted L1 is visible through its Project scope");
  const promotedGet = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_get", arguments: { taskId: "task-a", id: promotedFromGlobal.id } }));
  assert.equal(promotedGet.isError, undefined);
  const promotedGetText = promotedGet.content[0];
  assert(promotedGetText?.type === "text");
  const promotedExternal = JSON.parse(promotedGetText.type === "text" ? promotedGetText.text : "{}") as { content?: string; sourceId?: string; sourceTaskId?: string; metadata?: Record<string, unknown>; scopes?: Array<{ scopeType: string; scopeId?: string }>; evidence?: unknown[]; relations?: unknown[] };
  assert.equal(promotedExternal.content, "shared-after-promotion");
  assert.deepEqual(promotedExternal.scopes, [promotedExternal.scopes?.find((scope) => scope.scopeType === "project" && scope.scopeId === "project-a")].filter(Boolean), "delegated get exposes only the authorized durable scope");
  assert.equal(promotedExternal.sourceId, undefined);
  assert.equal(promotedExternal.sourceTaskId, undefined);
  assert.deepEqual(promotedExternal.metadata, {});
  assert.deepEqual(promotedExternal.evidence, []);
  assert.deepEqual(promotedExternal.relations, []);
  const promotedHistory = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_history", arguments: { taskId: "task-a", id: promotedFromGlobal.id } }));
  assert.equal(promotedHistory.isError, undefined);
  const promotedHistoryText = promotedHistory.content[0];
  assert(promotedHistoryText?.type === "text");
  const visibleHistory = JSON.parse(promotedHistoryText.type === "text" ? promotedHistoryText.text : "[]") as Array<{ content: string; changeReason?: string }>;
  assert(visibleHistory.some((revision) => revision.content === "shared-after-promotion"), "post-promotion revisions remain visible");
  assert(!visibleHistory.some((revision) => revision.content.startsWith("private-before-promotion")), "pre-promotion revision bodies are not exposed to the new delegated scope");
  const ownedHistory = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_history", arguments: { taskId: "task-a", id: projectA.id } }));
  assert.equal(ownedHistory.isError, undefined);
  const ownedHistoryText = ownedHistory.content[0];
  assert(ownedHistoryText?.type === "text");
  const visibleOwnedHistory = JSON.parse(ownedHistoryText.type === "text" ? ownedHistoryText.text : "[]") as Array<{ content: string }>;
  assert(visibleOwnedHistory.some((revision) => revision.content === "A-only after delegated access"));
  assert(!visibleOwnedHistory.some((revision) => revision.content === "A-only"), "owned-scope history also starts at grant access time");
  const delegatedContext = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_context", arguments: { taskId: "task-a", limit: 100 } }));
  assert.equal(delegatedContext.isError, undefined);
  const delegatedContextText = delegatedContext.content[0];
  assert(delegatedContextText?.type === "text");
  const delegatedContextBody = JSON.parse(delegatedContextText.type === "text" ? delegatedContextText.text : "{}") as { scenarioIds?: string[]; profileIds?: string[]; items?: Array<{ id: string }> };
  assert.deepEqual(delegatedContextBody.scenarioIds, [], "scoped delegated context does not expose L2 Scenario projections");
  assert.deepEqual(delegatedContextBody.profileIds, [], "scoped delegated context does not expose L3 Core Profile projections");
  assert(delegatedContextBody.items?.some((item) => item.id === projectA.id));
  assert(!delegatedContextBody.items?.some((item) => item.id === global.id));
  const projectDenied = CallToolResultSchema.parse(await projectClient.callTool({ name: "memory_search", arguments: { taskId: "task-b", limit: 100 } }));
  assert.equal(projectDenied.isError, true, "Project A token cannot query Project B task context");
  assert((projectDenied.content[0]?.type === "text" ? projectDenied.content[0].text : "").includes("access_denied"));
  const delegatedStats = await fetch(`${delegatedBase}/v1/memory/stats`, { headers: { authorization: `Bearer ${projectRead.token}` } });
  assert.equal(delegatedStats.status, 403, "delegated token cannot read owner-level statistics through HTTP either");
  await projectClient.close();

  const projectWrite = access.create({ name: "ERP Project A", mode: "read-write", scopeType: "project", scopeId: "project-a" });
  const projectWriteClient = new Client({ name: "project-write-grant-test", version: "1.0.0" });
  const projectWriteTransport = new StreamableHTTPClientTransport(new URL(`${delegatedBase}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${projectWrite.token}` } },
  });
  await projectWriteClient.connect(projectWriteTransport);
  const projectWriteTools = new Set((await projectWriteClient.listTools()).tools.map((tool) => tool.name));
  assert(projectWriteTools.has("memory_create"), "read-write grant plus master write exposes write tools");
  const projectGrantCreate = CallToolResultSchema.parse(await projectWriteClient.callTool({ name: "memory_create", arguments: { taskId: "task-a", kind: "procedure", title: "ERP project procedure" } }));
  assert.equal(projectGrantCreate.isError, undefined);
  const projectGrantBody = JSON.parse(projectGrantCreate.content[0]?.type === "text" ? projectGrantCreate.content[0].text : "{}") as { id?: string; sourceId?: string; sourceTaskId?: string; metadata?: Record<string, unknown>; scopes?: Array<{ scopeType: string; scopeId?: string }>; evidence?: unknown[]; relations?: unknown[] };
  assert(projectGrantBody.scopes?.some((scope) => scope.scopeType === "project" && scope.scopeId === "project-a"));
  assert.equal(projectGrantBody.sourceId, undefined, "delegated response redacts provenance sourceId");
  assert.equal(projectGrantBody.sourceTaskId, undefined, "delegated response redacts provenance sourceTaskId");
  assert.deepEqual(projectGrantBody.metadata, {}, "delegated response redacts arbitrary provenance metadata");
  assert.deepEqual(projectGrantBody.evidence, [], "delegated response does not implicitly share evidence graph");
  assert.deepEqual(projectGrantBody.relations, [], "delegated response does not leak relation ids");
  const rawGrantMemory = projectGrantBody.id ? memory.get(projectGrantBody.id) : undefined;
  assert.equal(rawGrantMemory?.sourceId, `memory-gateway:${projectWrite.grant.id}`, "internal L1 attribution records the external grant identity");
  assert.equal(rawGrantMemory?.metadata.externalAccessId, projectWrite.grant.id);
  assert(rawGrantMemory?.evidence.some((item) => item.evidenceKind === "external"), "internal L1 keeps external evidence even though delegated response is redacted");
  const attributedUpdate = CallToolResultSchema.parse(await projectWriteClient.callTool({
    name: "memory_update",
    arguments: {
      taskId: "task-a",
      id: projectGrantBody.id,
      content: "ERP updated procedure",
      metadata: { externalAccessId: "spoof", externalAccessName: "spoof", externalLastAccessId: "spoof" },
      changeReason: "sync",
    },
  }));
  assert.equal(attributedUpdate.isError, undefined);
  const internalAfterUpdate = projectGrantBody.id ? memory.get(projectGrantBody.id) : undefined;
  assert.equal(internalAfterUpdate?.metadata.externalAccessId, projectWrite.grant.id, "external update cannot spoof immutable creator grant metadata");
  assert.equal(internalAfterUpdate?.metadata.externalLastAccessId, projectWrite.grant.id, "last external writer is recorded server-side");
  const attributedRevision = projectGrantBody.id ? memory.history(projectGrantBody.id)[0] : undefined;
  assert.match(attributedRevision?.changeReason ?? "", new RegExp(`memory-gateway:${projectWrite.grant.id}`), "revision identifies the exact delegated writer");
  const inheritedGlobalUpdate = CallToolResultSchema.parse(await projectWriteClient.callTool({ name: "memory_update", arguments: { taskId: "task-a", id: global.id, content: "must not mutate global" } }));
  assert.equal(inheritedGlobalUpdate.isError, true, "Project grant cannot mutate a Global L1 outside its delegated durable scope");
  const crossProjectWrite = CallToolResultSchema.parse(await projectWriteClient.callTool({ name: "memory_create", arguments: { taskId: "task-b", kind: "procedure", title: "cross project" } }));
  assert.equal(crossProjectWrite.isError, true);
  await projectWriteClient.close();

  const workspaceWrite = access.create({ name: "LabHub Child Workspace", mode: "read-write", scopeType: "workspace", scopeId: "ws-child" });
  const projectFacade = writable.withAccess(access.authenticate(projectWrite.token)!);
  await expectGatewayError(
    () => Promise.resolve(projectFacade.promote({ taskId: "task-a", id: global.id, targetScopeType: "project", targetScopeId: "project-a" })),
    "not_found",
  );
  const workspaceFacade = writable.withAccess(access.authenticate(workspaceWrite.token)!);
  await expectGatewayError(
    () => workspaceFacade.search({ projectId: "project-a", workspaceId: "ws-child" }),
    "access_denied",
  );
  const workspaceClient = new Client({ name: "workspace-grant-test", version: "1.0.0" });
  const workspaceTransport = new StreamableHTTPClientTransport(new URL(`${delegatedBase}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${workspaceWrite.token}` } },
  });
  await workspaceClient.connect(workspaceTransport);
  const wsSearch = CallToolResultSchema.parse(await workspaceClient.callTool({ name: "memory_search", arguments: { taskId: "task-a", limit: 100 } }));
  assert.equal(wsSearch.isError, undefined);
  const wsSearchText = wsSearch.content[0];
  assert(wsSearchText?.type === "text");
  const wsScopedHits = JSON.parse(wsSearchText.type === "text" ? wsSearchText.text : "[]") as Array<{ memory: { id: string } }>;
  const wsScopedIds = ids(wsScopedHits);
  assert(wsScopedIds.has(childWs.id), "Workspace grant sees L1 in its granted workspace");
  assert(!wsScopedIds.has(parentWs.id), "child Workspace grant does not inherit parent Workspace L1 outside grant subtree");
  assert(!wsScopedIds.has(projectA.id), "Workspace grant does not inherit Project L1");
  assert(!wsScopedIds.has(global.id), "Workspace grant does not inherit Global L1");
  const wsCreate = CallToolResultSchema.parse(await workspaceClient.callTool({ name: "memory_create", arguments: { taskId: "task-a", kind: "procedure", title: "Workspace procedure" } }));
  assert.equal(wsCreate.isError, undefined);
  const wsBody = JSON.parse(wsCreate.content[0]?.type === "text" ? wsCreate.content[0].text : "{}") as { scopes?: Array<{ scopeType: string; scopeId?: string }> };
  assert(wsBody.scopes?.some((scope) => scope.scopeType === "workspace" && scope.scopeId === "ws-child"), "Workspace grant writes to its workspace rather than Task project default");
  const parentMutation = CallToolResultSchema.parse(await workspaceClient.callTool({ name: "memory_update", arguments: { taskId: "task-a", id: parentWs.id, content: "must not mutate parent" } }));
  assert.equal(parentMutation.isError, true, "child Workspace grant cannot mutate inherited parent Workspace memory");
  const childMutation = CallToolResultSchema.parse(await workspaceClient.callTool({ name: "memory_update", arguments: { taskId: "task-a", id: childWs.id, content: "child grant update" } }));
  assert.equal(childMutation.isError, undefined, "child Workspace grant can mutate its own L1 scope");
  const siblingContext = CallToolResultSchema.parse(await workspaceClient.callTool({ name: "memory_search", arguments: { taskId: "task-b" } }));
  assert.equal(siblingContext.isError, true, "child Workspace grant cannot move sideways to sibling Workspace");
  await workspaceClient.close();

  // Rotate is immediate: old token fails, new token succeeds; disable/revoke is immediate too.
  const rotated = access.rotate(projectRead.grant.id);
  const oldTokenResponse = await fetch(`${delegatedBase}/v1/memory/search`, {
    method: "POST", headers: { authorization: `Bearer ${projectRead.token}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-a" }),
  });
  assert.equal(oldTokenResponse.status, 401);
  const newTokenResponse = await fetch(`${delegatedBase}/v1/memory/search`, {
    method: "POST", headers: { authorization: `Bearer ${rotated.token}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-a" }),
  });
  assert.equal(newTokenResponse.status, 200);
  access.update({ id: projectRead.grant.id, enabled: false });
  const disabledTokenResponse = await fetch(`${delegatedBase}/v1/memory/search`, {
    method: "POST", headers: { authorization: `Bearer ${rotated.token}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-a" }),
  });
  assert.equal(disabledTokenResponse.status, 401);
  access.delete(projectRead.grant.id);
  assert(!access.list().some((grant) => grant.id === projectRead.grant.id));
  assert(!readdirSync(root).some((name) => name === "memory-access.json.tmp"), "grant store atomic writes leave no temp file");

  const ownerStats = await fetch(`${delegatedBase}/v1/memory/stats`, { headers: { authorization: `Bearer ${delegatedOwnerToken}` } });
  assert.equal(ownerStats.status, 200, "owner bootstrap token retains owner-only diagnostics");
  await delegatedServer.stop();

  db.close();
  console.log("memory-gateway-test: PASS");
} finally {
  await new Promise((resolve) => setTimeout(resolve, 80));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* preserve original failure */ }
}
