import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import type { GadgetChangedEvent } from "../src/shared/gadget-ipc";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "gadget-save-copies-"));
  const db = new AppDatabase(":memory:");
  const storage = new GadgetStorage(join(root, "storage"));
  const repository = new GadgetRepository(db.connection);
  const registry = new GadgetRegistry();
  const runtime = new GadgetRuntime(storage, registry);
  const events: GadgetChangedEvent[] = [];
  const service = new GadgetService({ repository, storage, registry, runtime,
    workspaceExists: id => ["ws", "other", "archived"].includes(id),
    workspaceEffectiveArchived: id => id === "archived",
    taskExists: id => ["a", "b", "c"].includes(id),
    taskWorkspaceId: id => id === "c" ? "other" : "ws",
    workspaceAncestors: () => [],
    resolveTaskDirectory: id => join(root, id), onChanged: e => events.push(e),
  });
  try {
    for (const id of ["a", "b", "c"]) mkdirSync(join(root, id));
    const original = service.create({ name: "Independent", scope: { type: "task", taskId: "a" },
      description: "keep description", defaultConfig: { nested: { value: 1 } }, metadata: { value: "keep" },
      entry: "pages/index.html", files: [
        { path: "pages/index.html", content: '<h1>original</h1><script>const apiKey="keep-exact-source"</script>' },
        { path: "assets/blob.bin", encoding: "base64", content: Buffer.from([0, 255, 10]).toString("base64") },
      ] });
    const originalSnapshot = service.readSource(original.id);
    writeFileSync(join(storage.paths(original.id).dataPath, "private.json"), "private");
    // Workspace destinations deliberately have no disk path dependency.
    const ws = service.copyScope(original.id, { type: "workspace", workspaceId: "ws" });
    const global = service.copyScope(ws.id, { type: "global" });
    assert.equal(new Set([original.id, ws.id, global.id]).size, 3);
    assert.equal(new Set([original.sourcePath, ws.sourcePath, global.sourcePath]).size, 3);
    for (const copy of [ws, global]) {
      assert.deepEqual(service.readSource(copy.id), originalSnapshot);
      assert.equal(copy.createdByTaskId, "a");
      assert.equal(copy.description, original.description);
      assert.deepEqual(copy.metadata, original.metadata);
      assert.equal(existsSync(join(storage.paths(copy.id).dataPath, "private.json")), false);
      assert.equal(service.get(copy.id)?.runtime.status, "stopped");
      assert(events.some(e => e.type === "created" && e.gadgetId === copy.id));
    }
    const taskB = service.copyScope(global.id, { type: "task", taskId: "b" });
    assert.equal(taskB.createdByTaskId, "a", "copy retains origin provenance, not ownership");
    assert.equal(service.getForTask(taskB.id, "b").id, taskB.id);
    assert.throws(() => service.getForTask(taskB.id, "a"), /其它任务/);
    service.update({ gadgetId: taskB.id, defaultConfig: { nested: { value: 2 } } });
    assert.deepEqual(service.readSource(original.id).manifest.defaultConfig, { nested: { value: 1 } });
    assert.deepEqual(service.readSource(global.id).manifest.defaultConfig, { nested: { value: 1 } });
    assert.deepEqual(service.readSource(taskB.id).manifest.defaultConfig, { nested: { value: 2 } });
    assert.deepEqual(service.get(original.id)?.scope, { type: "task", taskId: "a" });
    assert(service.list({ scope: { type: "task", taskId: "b" }, includeInherited: true }).some(x => x.id === ws.id));
    assert.throws(() => service.getForTask(original.id, "b"), /其它任务/);
    assert.throws(() => service.getForTask(ws.id, "c"), /可见作用域/);
    assert.throws(() => service.copyScope(original.id, { type: "task", taskId: "b" }), /其它任务/);
    assert.throws(() => service.copyScope(ws.id, { type: "task", taskId: "c" }), /可见作用域/);
    assert.throws(() => service.copyScope(original.id, { type: "workspace", workspaceId: "archived" }), /归档/);
    assert.throws(() => service.copyScope(original.id, { type: "workspace", workspaceId: "missing" }), /不存在/);
    assert.throws(() => service.copyScope("missing", { type: "global" }), /不存在/);
    // Editing any one copy must not modify the other two.
    service.updateSource({ gadgetId: ws.id, expectedRevision: originalSnapshot.revision, files: [{ path: "pages/index.html", content: "workspace edited" }] });
    assert.deepEqual(service.readSource(original.id), originalSnapshot);
    assert.deepEqual(service.readSource(global.id), originalSnapshot);
    const exported = service.saveToTaskDirectory({ gadgetId: ws.id, taskId: "b" });
    assert.equal(readFileSync(exported.entryPath, "utf8"), "workspace edited");
    assert.throws(() => service.saveToTaskDirectory({ gadgetId: ws.id, taskId: "c" }), /可见作用域/);
    assert.equal(existsSync(join(root, "c", "gadgets")), false);
    // Failed insert cleans up only the new directory and emits no successful event; retry succeeds.
    const before = readdirSync(join(root, "storage")).sort();
    const eventCount = events.length;
    const create = repository.create.bind(repository);
    repository.create = () => { throw new Error("injected insert failure"); };
    assert.throws(() => service.copyScope(original.id, { type: "global" }), /injected insert failure/);
    repository.create = create;
    assert.deepEqual(readdirSync(join(root, "storage")).sort(), before);
    assert.equal(events.length, eventCount);
    const writeSourceFile = storage.writeSourceFile.bind(storage);
    storage.writeSourceFile = () => { throw new Error("injected storage failure"); };
    assert.throws(() => service.copyScope(original.id, { type: "global" }), /injected storage failure/);
    storage.writeSourceFile = writeSourceFile;
    assert.deepEqual(readdirSync(join(root, "storage")).sort(), before);
    assert.equal(events.length, eventCount);
    assert.deepEqual(service.readSource(original.id), originalSnapshot);
    const retry = service.copyScope(original.id, { type: "global" });
    const repeated = await Promise.all(Array.from({ length: 4 }, () => Promise.resolve().then(() => service.copyScope(original.id, { type: "global" }))));
    assert.equal(new Set(repeated.map(x => x.id)).size, 4);
    // Missing source fails before creating a partial copy and is retryable after restoration.
    const entry = join(original.sourcePath, "pages/index.html");
    const entryBytes = readFileSync(entry);
    rmSync(entry);
    const beforeBadSource = readdirSync(join(root, "storage")).sort();
    assert.throws(() => service.copyScope(original.id, { type: "global" }), /入口/);
    assert.deepEqual(readdirSync(join(root, "storage")).sort(), beforeBadSource);
    const binaryPath = join(original.sourcePath, "assets/blob.bin");
    const binaryBytes = readFileSync(binaryPath);
    rmSync(binaryPath);
    assert.throws(() => service.copyScope(original.id, { type: "global" }), /空源码/);
    assert.deepEqual(readdirSync(join(root, "storage")).sort(), beforeBadSource);
    writeFileSync(binaryPath, binaryBytes);
    writeFileSync(entry, entryBytes);
    await service.delete(global.id);
    assert.deepEqual(service.readSource(original.id), originalSnapshot);
    assert.equal(service.readSource(ws.id).files.find(f => f.path === "pages/index.html")?.content, "workspace edited");
    await service.deleteByTask("a");
    assert(service.get(taskB.id), "deleting origin task scope must not delete target task copy");
    assert.equal(readFileSync(exported.entryPath, "utf8"), "workspace edited");
    assert(service.get(ws.id));
    assert.deepEqual(service.readSource(retry.id), originalSnapshot);
    await service.delete(ws.id);
    assert.deepEqual(service.readSource(retry.id), originalSnapshot);
    assert.equal(readFileSync(exported.entryPath, "utf8"), "workspace edited");
    // The explicitly named move still moves the same ID.
    const moved = service.moveScope(retry.id, { type: "workspace", workspaceId: "other" });
    assert.equal(moved.id, retry.id);
    assert.deepEqual(moved.scope, { type: "workspace", workspaceId: "other" });
    console.log("PASS gadget-save-copies: independent IDs/files, scope visibility, edits, deletes, failures/retries, concurrent copies and export");
  } finally {
    await service.disposeAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
