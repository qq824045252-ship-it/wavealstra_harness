import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlueprintRepository } from "../src/main/blueprint/BlueprintRepository";
import { writeBlueprintInstance, type RuntimeBlueprintInstance } from "../src/main/blueprint/BlueprintInstanceWrite";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader, RuntimeAuditUnknownOperationError } from "../src/main/platform/runtime-audit";
import { BLUEPRINT_DEFINITION_SCHEMA_VERSION } from "../src/shared/blueprint-types";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-workbench-")));
const database = join(root, "app.duckdb");
const gadgetRoot = join(root, "gadgets");
const taskDirectory = join(root, "task-files");
const instanceDirectory = join(root, "instances");
mkdirSync(taskDirectory);
mkdirSync(instanceDirectory);
const open = (coreRole?: "background-service") => new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole });
let ui = open();
const host = open("background-service");
const localLookup = (): never => { throw new Error("Production workbench queried a host scope snapshot"); };
function service(core: RuntimeAuditReader) {
  const repository = new GadgetRepository({ core });
  const registry = new GadgetRegistry();
  const storage = new GadgetStorage(gadgetRoot, core);
  const runtime = new GadgetRuntime(storage, registry, () => undefined, core);
  return new GadgetService({ repository, storage, registry, runtime, workspaceExists: localLookup,
    workspaceEffectiveArchived: localLookup, taskExists: localLookup, taskWorkspaceId: localLookup,
    workspaceAncestors: localLookup, resolveTaskDirectory: () => taskDirectory });
}
let desktop = service(ui);
const worker = service(host);
const now = Date.now();
try {
  for (const [id, parentId] of [["scope", null], ["child", "scope"], ["elsewhere", null]] as const) {
    assert.equal((await ui.upsertWorkspace({ id, name: id, parentId, at: now }))?.status, "saved");
  }
  for (const [id, spaceId] of [["task", "child"], ["outside", "elsewhere"]] as const) {
    assert.equal((await ui.upsertTaskRecord({ id, title: id, spaceId, at: now, preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
  }
  await desktop.recoverStorage();
  const gadget = await desktop.createAsync({ name: "Review", scope: { type: "workspace", workspaceId: "scope" },
    files: [{ path: "index.html", content: "<html><body>Original</body></html>" }] });
  const visible = (await worker.readList({ scope: { type: "task", taskId: "task" }, includeInherited: true }))[0];
  assert.deepEqual([visible.id, visible.inheritedFromWorkspaceId], [gadget.id, "scope"]);
  await assert.rejects(worker.readForTask(gadget.id, "outside"), /作用域/);
  assert.deepEqual(await worker.readList({ scope: { type: "task", taskId: "outside" }, includeInherited: true }), []);
  const original = await worker.readSourceAsync(gadget.id);
  const saved = await worker.updateSourceAsync({ gadgetId: gadget.id, expectedRevision: original.revision,
    files: [{ path: "index.html", content: "<html><body>Saved by host</body></html>" }] }, "task");
  assert.notEqual(saved.revision, original.revision);
  assert.match((await desktop.readSourceAsync(gadget.id)).files[0].content, /Saved by host/);

  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { reached = resolve; });
  const readManifest = host.readGadgetManifest.bind(host);
  host.readGadgetManifest = async (path, id) => {
    reached();
    await held;
    return readManifest(path, id);
  };
  const settings = worker.updateAsync({ gadgetId: gadget.id, description: "Edited by host", defaultConfig: { compact: true } });
  try {
    await reading;
    await desktop.updateAsync({ gadgetId: gadget.id, name: "Renamed by desktop" });
  } finally {
    release();
    await settings;
    host.readGadgetManifest = readManifest;
  }
  const metadata = await desktop.read(gadget.id);
  const source = await desktop.readSourceAsync(gadget.id);
  assert.deepEqual([metadata?.name, metadata?.description, source.manifest.name, source.manifest.defaultConfig],
    ["Renamed by desktop", "Edited by host", "Renamed by desktop", { compact: true }]);
  console.log("PASS a concurrent manifest-and-description edit preserves the rename from the other client");

  const copy = await worker.saveToTaskDirectoryAsync({ gadgetId: gadget.id, taskId: "task" });
  assert.match(readFileSync(copy.entryPath, "utf8"), /Saved by host/);
  const staleSource = await host.readGadgetSource(gadgetRoot, gadget.id);
  assert(staleSource?.status === "read" && staleSource.token);
  await desktop.moveScopeAsync(gadget.id, { type: "task", taskId: "outside" });
  const denied = await host.saveGadgetSource({ root: gadgetRoot, id: gadget.id, taskId: "task",
    operationId: randomUUID(), updatedAt: now, token: staleSource.token,
    files: [{ path: "index.html", base64: Buffer.from("revoked edit").toString("base64") }] });
  assert.deepEqual(denied, { status: "scopeChanged" });
  const deniedExport = await host.exportGadgetFiles({ root: gadgetRoot, id: gadget.id, taskId: "task", token: staleSource.token,
    taskDirectory, basename: "revoked", manifest: staleSource.manifest, readme: "", entry: "index.html" });
  assert.deepEqual(deniedExport, { status: "scopeChanged" });
  assert.equal(existsSync(join(taskDirectory, "gadgets", "revoked")), false);
  assert.match((await desktop.readSourceAsync(gadget.id)).files[0].content, /Saved by host/);
  await assert.rejects(worker.copyScopeAsync(gadget.id, { type: "task", taskId: "task" }), /作用域/);
  const allowedCopy = await worker.copyScopeAsync(gadget.id, { type: "task", taskId: "outside" });
  assert.notEqual(allowedCopy.sourcePath, gadget.sourcePath);
  assert.match((await worker.readSourceAsync(allowedCopy.id)).files[0].content, /Saved by host/);
  await desktop.delete(allowedCopy.id);
  assert.equal(existsSync(join(gadgetRoot, allowedCopy.id)), false);
  console.log("PASS Rust rejects stale edits and exports after the other client moves the Gadget");

  const blueprintRepository = new BlueprintRepository({ core: ui });
  const blueprint = await blueprintRepository.create({ name: "Review template", definition: {
    schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, kind: "workspace", workspace: { key: "root", name: "Review instance" },
  } });
  const otherBlueprints = new BlueprintRepository({ core: host });
  const [renamed] = await Promise.all([
    blueprintRepository.update({ blueprintId: blueprint.id, name: "Renamed template" }),
    otherBlueprints.update({ blueprintId: blueprint.id, description: "Host description" }),
  ]);
  assert.equal(renamed.name, "Renamed template");
  assert.equal((await otherBlueprints.read(blueprint.id))?.description, "Host description");
  const instancePath = join(instanceDirectory, `bp-${randomUUID()}`);
  const instance: RuntimeBlueprintInstance = {
    blueprintId: blueprint.id, createdAt: now, workspaces: [{ id: "instance", name: "Workspace instance", path: instancePath, parentId: null }],
    tasks: [], libraryBindings: [], contexts: [], gadgets: [], storage: { workspaceInstancesRoot: instanceDirectory, gadgets: [],
      seeds: [{ workspaceId: "instance", path: "welcome.md", base64: Buffer.from("Blueprint is ready").toString("base64") }] },
  };
  const writeInstance = ui.instantiateBlueprint.bind(ui);
  let receiptOperation: string | undefined;
  let attempts = 0;
  ui.instantiateBlueprint = async (operationId, data) => {
    const result = await writeInstance(operationId, data);
    if (++attempts !== 1) return result;
    assert.equal(result !== "needsHost" && result?.kind, "committed");
    receiptOperation = operationId;
    throw new RuntimeAuditUnknownOperationError("lost-instance-reply", "instantiateBlueprint");
  };
  try {
    assert.deepEqual(await writeBlueprintInstance({ runtimeAuditReader: ui, get readonly() { return localLookup(); },
      get connection() { return localLookup(); } }, instance), { kind: "committed", skippedLibraries: [] });
    assert.equal(attempts, 1, "the durable receipt answers the lost reply without replaying the mutation");
  } finally {
    ui.instantiateBlueprint = writeInstance;
  }
  assert(receiptOperation);
  assert.deepEqual(await host.instantiateBlueprint(receiptOperation, instance), { kind: "committed", skippedLibraries: [] });
  assert.equal(readFileSync(join(instancePath, "welcome.md"), "utf8"), "Blueprint is ready");

  const rejected = { kind: "deleteGadget", id: "missing-gadget" } as const;
  const receiptId = randomUUID();
  assert.equal(await ui.writeWorkbench(receiptId, rejected), "missing");
  await Promise.all([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  ui = open();
  desktop = service(ui);
  assert.equal(await ui.writeWorkbench(receiptId, rejected), "missing");
  assert.deepEqual(await ui.workbenchData({ kind: "workbenchReceipt", operationId: receiptId }), [{ status: "missing" }]);
  assert.deepEqual(await ui.instantiateBlueprint(receiptOperation, instance), { kind: "committed", skippedLibraries: [] });
  await desktop.delete(gadget.id);
  assert.equal(await desktop.read(gadget.id), null);
  assert.equal(existsSync(join(gadgetRoot, gadget.id)), false);
  console.log("PASS explicit outcomes and Blueprint instances replay after restart; Gadget deletion removes its unregistered files");
} finally {
  await Promise.all([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true });
}
