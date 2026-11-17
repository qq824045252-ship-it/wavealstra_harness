import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";
import { BlueprintRepository } from "../src/main/blueprint/BlueprintRepository";
import { BlueprintResolver } from "../src/main/blueprint/BlueprintResolver";
import { BlueprintInstantiationPlanner } from "../src/main/blueprint/BlueprintInstantiationPlanner";
import { BlueprintService } from "../src/main/blueprint/BlueprintService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";

const root = mkdtempSync(join(tmpdir(), "gadget-domain-"));
const db = new AppDatabase(":memory:");
const storage = new GadgetStorage(join(root, "gadgets"));
const registry = new GadgetRegistry();
const runtime = new GadgetRuntime(storage, registry);
const deadline = setTimeout(() => { console.error("gadget domain test exceeded 60s"); process.exit(1); }, 60_000);
type Tool = { name: string; parameters: { type?: string }; execute: (id: string, input: never) => Promise<{ isError?: boolean; details?: unknown; content: Array<{ text: string }> }> };
const backend = { entry: "server/index.mjs", commands: ["node"], environment: ["LANG"], timeoutMs: 1000 };
const source = (version: string) => `export default async function(ctx) { return { actions: {
  set: async input => { await ctx.storage.set('value',input); return input; },
  read: async () => ({ value: await ctx.storage.get('value'), theme: await ctx.config.get('theme'), version: ${JSON.stringify(version)} }),
  configure: async input => { await ctx.config.set('theme',input); return input; }
} }; }`;

async function main(): Promise<void> {
  const wsPath = join(root, "workspace"); mkdirSync(wsPath);
  const ws = db.createSpace({ name: "Domain", path: wsPath });
  for (const id of ["task-a", "task-b"]) db.upsertTask({ id, title: id, spaceId: ws.id, updatedAt: Date.now() });
  let writes = 0;
  const service = new GadgetService({ repository: new GadgetRepository(db.connection), storage, registry, runtime,
    workspaceExists: id => Boolean(db.getSpace(id)), workspaceEffectiveArchived: () => false,
    taskExists: id => Boolean(db.getTask(id)), taskWorkspaceId: id => db.getTask(id)?.spaceId ?? null,
    workspaceAncestors: id => db.getSpaceAncestors(id).map(space => space.id), resolveTaskDirectory: () => wsPath,
    artifacts: { read: async () => null, write: async () => { writes++; return { artifactId: "unexpected" }; } },
  });
  const blueprint = new BlueprintService({ repository: new BlueprintRepository(db.connection), resolver: new BlueprintResolver(),
    planner: new BlueprintInstantiationPlanner(), db, gadgetService: service, libraryBindings: new WorkspaceLibraryBindingService(db),
    librarySpaceExists: () => false, workspaceInstancesRoot: join(root, "instances") });
  function toolsFor(taskId: string): Tool[] {
    const tools: Tool[] = [];
    createGadgetAgentExtension({ taskId, resolveWorkspaceId: () => ws.id, service, getPermissionMode: () => "auto", requestApproval: async () => true })(
      { registerTool: (tool: never) => tools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    return tools;
  }
  const tools = toolsFor("task-a");
  for (const tool of tools) assert.equal(tool.parameters.type, "object", tool.name);
  const invoke = async (name: string, params: object) => {
    const tool = tools.find(item => item.name === name); assert(tool, name);
    return tool.execute(name, params as never);
  };
  const created = await invoke("gadget_create", { name: "Backend", entry: "index.html", defaultConfig: { theme: "light" }, backend,
    files: [{ path: "index.html", content: "<html><body>backend</body></html>" }, { path: backend.entry, content: source("one") }] });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const id = (created.details as { gadgetId: string }).gadgetId;
  assert.deepEqual(service.readSource(id).manifest.backend, backend);
  for (const operation of ["status", "logs"]) {
    assert.equal((await invoke("gadget_runtime", { gadgetId: id, operation })).isError, undefined);
    assert.equal(registry.runtime(id).status, "stopped");
  }
  const call = async (gadgetId: string, action: string, input?: unknown) => {
    const result = await invoke("gadget_call", { gadgetId, action, input });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return (result.details as { value: unknown }).value;
  };
  assert.equal(await call(id, "set", "original"), "original");
  assert.equal(await call(id, "configure", "dark"), "dark");
  assert.deepEqual(await call(id, "read"), { value: "original", theme: "dark", version: "one" });
  const outsider = toolsFor("task-b").find(item => item.name === "gadget_call")!;
  assert.equal((await outsider.execute("denied", { gadgetId: id, action: "read" } as never)).isError, true);
  const otherRuntime = toolsFor("task-b").find(item => item.name === "gadget_runtime")!;
  assert.equal((await otherRuntime.execute("denied", { gadgetId: id, operation: "stop" } as never)).isError, true);
  assert.equal(registry.runtime(id).status, "running");
  const read = await invoke("gadget_read", { gadgetId: id });
  const revision = (read.details as { revision: string }).revision;
  const changedBackend = { ...backend, timeoutMs: 1200 };
  const update = await invoke("gadget_update", { gadgetId: id, expectedRevision: revision, backend: changedBackend,
    files: [{ path: backend.entry, content: source("two") }] });
  assert.equal(update.isError, undefined, JSON.stringify(update));
  assert.deepEqual(service.readSource(id).manifest.backend, changedBackend);
  assert.deepEqual(await call(id, "read"), { value: "original", theme: "dark", version: "two" });
  const copy = service.copyScope(id, { type: "workspace", workspaceId: ws.id });
  const captured = blueprint.captureGadget(id);
  const instance = await blueprint.instantiate({ blueprintId: captured.id, gadgetScope: { type: "workspace", workspaceId: ws.id } });
  const blueprintId = Object.values(instance.gadgetIdsByKey)[0];
  for (const clone of [copy.id, blueprintId]) {
    assert.deepEqual(service.readSource(clone).manifest.backend, changedBackend);
    assert.deepEqual(await call(clone, "read"), { value: null, theme: "light", version: "two" });
    assert.equal(await call(clone, "set", clone), clone);
  }
  const beforeDefaults = registry.runtime(id).pid;
  service.update({ gadgetId: id, defaultConfig: { theme: "updated-default" } });
  assert.equal((await service.health(id)).status, "running");
  assert.notEqual(registry.runtime(id).pid, beforeDefaults);
  assert.deepEqual(await call(id, "read"), { value: "original", theme: "dark", version: "two" }, "saved overrides survive a default configuration change");
  await runtime.request(service.getForTask(id, "task-a"), "config", { operation: "delete", key: "theme" });
  assert.deepEqual(await call(id, "read"), { value: "original", theme: "updated-default", version: "two" });
  await call(id, "configure", "dark");
  assert.deepEqual(await call(id, "read"), { value: "original", theme: "dark", version: "two" });
  const exportResult = service.saveToTaskDirectory({ gadgetId: id, taskId: "task-a" });
  assert.deepEqual(JSON.parse(readFileSync(join(exportResult.directory, "gadget.json"), "utf8")).backend, changedBackend);
  assert.equal(existsSync(join(exportResult.directory, "data")), false);
  await assert.rejects(service.exportArtifact({ gadgetId: id, taskId: "task-a" }), /后台/);
  assert.equal(writes, 0);
  const staticGadget = service.create({ name: "Upgrade existing HTML", scope: { type: "task", taskId: "task-a" },
    files: [{ path: "index.html", content: "<h1>existing UI retained</h1>" }], defaultConfig: { theme: "before" } });
  await runtime.request(staticGadget, "storage", { operation: "set", key: "value", value: "before-backend" });
  service.update({ gadgetId: staticGadget.id, defaultConfig: { theme: "after" } });
  assert.equal((await service.health(staticGadget.id)).status, "running");
  assert.equal(await runtime.request(staticGadget, "config", { operation: "get", key: "theme" }), "after");
  const staticSnapshot = service.readSource(staticGadget.id);
  service.updateSource({ gadgetId: staticGadget.id, expectedRevision: staticSnapshot.revision, backend,
    files: [{ path: backend.entry, content: source("added") }] });
  assert.deepEqual(await call(staticGadget.id, "read"), { value: "before-backend", theme: "after", version: "added" });
  const added = service.readSource(staticGadget.id);
  service.updateSource({ gadgetId: staticGadget.id, expectedRevision: added.revision, backend: null,
    files: [{ path: "index.html", content: "<h1>existing UI retained</h1>" }] });
  await service.health(staticGadget.id);
  assert.deepEqual(await runtime.request(staticGadget, "runtime"), { gadgetId: staticGadget.id, name: staticGadget.name, backend: false, actions: [] });
  assert.equal(await runtime.request(staticGadget, "storage", { operation: "get", key: "value" }), "before-backend");
  assert.equal((await invoke("gadget_runtime", { gadgetId: id, operation: "stop" })).isError, undefined);
  for (const operation of ["status", "logs"]) {
    await invoke("gadget_runtime", { gadgetId: id, operation }); assert.equal(registry.runtime(id).status, "stopped");
  }
  await service.delete(id);
  assert.deepEqual(await call(copy.id, "read"), { value: copy.id, theme: "light", version: "two" });
  assert.deepEqual(await call(blueprintId, "read"), { value: blueprintId, theme: "light", version: "two" });
  console.log("gadget-backend-domain-test: ok");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await runtime.disposeAll(); } finally { db.close(); rmSync(root, { recursive: true, force: true }); clearTimeout(deadline); }
});
