import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BlueprintRepository } from "../src/main/blueprint/BlueprintRepository";
import { BlueprintResolver } from "../src/main/blueprint/BlueprintResolver";
import { BlueprintInstantiationPlanner } from "../src/main/blueprint/BlueprintInstantiationPlanner";
import { BlueprintService } from "../src/main/blueprint/BlueprintService";
import { migrateBlueprintDefinition } from "../src/main/blueprint/BlueprintDefinitionMigrator";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { BLUEPRINT_DEFINITION_SCHEMA_VERSION, normalizeBlueprintDefinition, type CompositeBlueprintDefinition } from "../src/shared/blueprint-types";
import { GadgetIpc } from "../src/shared/gadget-ipc";
import { BlueprintIpc } from "../src/shared/blueprint-ipc";
import type { GadgetChangedEvent } from "../src/shared/gadget-ipc";
import { isMyBuddyNativeExtensionToolName } from "../src/shared/native-tools";
import { EXTENSION_MODES, EXTENSION_MODE_LABEL } from "../src/renderer/src/components/artifact/extensionModes";

async function main(): Promise<void> {
  const useNative = process.argv.includes("--native");
  const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
  if (useNative) assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable), "Rust worker executable is required in native mode");
  const root = mkdtempSync(join(tmpdir(), "mybuddy-gadget-blueprint-"));
  const db = new AppDatabase(useNative ? join(root, "app.db") : ":memory:", { runtimeAuditExecutable });
  let activeService: GadgetService | undefined;
  try {
    assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    const ws = db.createSpace({ name: "Gadget Test", path: join(root, "workspace") });
    mkdirSync(ws.path!, { recursive: true });
    const child = db.createSpace({ name: "Child", parentId: ws.id, path: join(ws.path!, "Child") });
    mkdirSync(child.path!, { recursive: true });
    db.upsertTask({ id: "task-gadget-test", title: "Task", spaceId: ws.id, updatedAt: Date.now() });
    db.upsertTask({ id: "task-gadget-other", title: "Other Task", spaceId: child.id, updatedAt: Date.now() });

    assert.throws(() => db.connection.prepare(
      `INSERT INTO gadgets (id,name,scope_type,scope_id,type,manifest_path,source_path,metadata_json,created_at,updated_at)
       VALUES ('bad','bad','global','illegal','web','m','s','{}',1,1)`,
    ).run(), /CHECK constraint failed/);

    const repository = new GadgetRepository(db.connection, db.runtimeAuditReader);
    const storage = new GadgetStorage(join(root, "gadgets"), db.runtimeAuditReader);
    const registry = new GadgetRegistry();
    const runtime = new GadgetRuntime(storage, registry, undefined, db.runtimeAuditReader);
    const events: GadgetChangedEvent[] = [];
    const artifactStorage = new ArtifactStorage(join(root, "artifacts"));
    const artifactOutput = new ArtifactService(artifactStorage, new ArtifactRepository(db.connection),
      new ArtifactRegistry(), undefined, db.runtimeAuditReader);
    const artifactRows = new Map<string, { taskId: string; content: string }>([["art-html", { taskId: "task-gadget-test", content: "<html><body>artifact kept</body></html>" }]]);
    const service = new GadgetService({
      repository,
      storage,
      registry,
      runtime,
      onChanged: (event) => events.push(event),
      workspaceExists: (id) => Boolean(db.getSpace(id)),
      workspaceEffectiveArchived: (id) => db.getSpace(id)?.effectiveArchived === true,
      taskExists: (id) => Boolean(db.getTask(id)),
      taskWorkspaceId: (id) => db.getTask(id)?.spaceId ?? null,
      resolveTaskDirectory: (id) => id === "task-gadget-test" ? ws.path! : child.path!,
      workspaceAncestors: (id) => db.getSpaceAncestors(id).map((space) => space.id),
      artifacts: {
        read: async (id) => {
          const row = artifactRows.get(id);
          return row ? { taskId: row.taskId, title: "Artifact", kind: "html", content: row.content } : null;
        },
        write: async ({ taskId, title, content }) => {
          const output = await artifactOutput.register({ taskId, kind: "html", title, content });
          return { artifactId: output.id };
        },
        writeFromGadget: async ({ taskId, title, source }, readOnHost) => {
          const output = await artifactOutput.registerGadgetHtml(taskId, title, { source, readOnHost });
          return { artifactId: output.id };
        },
      },
    });
    activeService = service;

    const storageEntriesBeforeInvalidMetadata = readdirSync(join(root, "gadgets")).length;
    assert.throws(() => service.create({
      name: "Invalid metadata",
      scope: { type: "global" },
      metadata: { bad: Number.POSITIVE_INFINITY },
    }), /有限数字/);
    assert.equal(readdirSync(join(root, "gadgets")).length, storageEntriesBeforeInvalidMetadata, "invalid metadata must fail before storage materialization");

    const createInHost = storage.create.bind(storage);
    const nativeFiles = db.runtimeAuditReader;
    const nativeCreate = nativeFiles?.createGadgetFiles.bind(nativeFiles);
    if (useNative) storage.create = () => { throw new Error("Native creation unexpectedly used the host fallback"); };
    const { global, workspace, task } = await (async () => {
      try {
        if (nativeFiles && nativeCreate) {
          nativeFiles.createGadgetFiles = async (request) => {
            assert.equal((await nativeCreate(request))?.status, "created");
            return nativeCreate(request);
          };
        }
        const global = await service.createAsync({ name: "Global", scope: { type: "global" } });
        if (nativeFiles && nativeCreate) nativeFiles.createGadgetFiles = nativeCreate;
        const workspace = await service.createAsync({ name: "Workspace", scope: { type: "workspace", workspaceId: ws.id } });
        const task = await service.createAsync({ name: "Task", scope: { type: "task", taskId: "task-gadget-test" } });
        const before = readdirSync(join(root, "gadgets"));
        await assert.rejects(service.createAsync({
          name: "Missing HTML", scope: { type: "global" }, files: [{ path: "wrong.html", content: "not the entry" }],
        }), /入口文件不存在/);
        assert.deepEqual(readdirSync(join(root, "gadgets")), before);
        assert.deepEqual(repository.list({ type: "global" }).map(gadget => gadget.name), ["Global"]);
        return { global, workspace, task };
      } finally {
        storage.create = createInHost;
        if (nativeFiles && nativeCreate) nativeFiles.createGadgetFiles = nativeCreate;
      }
    })();
    const gadgetGetOnHost = repository.get.bind(repository);
    if (useNative) repository.get = () => { throw new Error("Native Gadget detail unexpectedly used the host fallback"); };
    try {
      const item = await service.read(global.id);
      assert.equal(item?.name, "Global");
      assert.deepEqual(item?.scope, { type: "global" });
      assert.equal(item?.runtime.status, "stopped");
      assert.equal(await service.read("gdt-absent"), null);
    } finally {
      repository.get = gadgetGetOnHost;
    }
    const orphan = storage.paths("gdt-orphan").root;
    const orphanLink = storage.paths("gdt-orphan-link").root;
    const unknown = join(root, "gadgets", "user-files");
    mkdirSync(join(orphan, "code"), { recursive: true });
    mkdirSync(unknown);
    symlinkSync(unknown, join(orphan, "linked-data"), "junction");
    symlinkSync(unknown, orphanLink, "junction");
    writeFileSync(join(unknown, "keep.txt"), "keep outside data");
    const storageIds = repository.storageIds.bind(repository);
    if (useNative) repository.storageIds = () => { throw new Error("Native recovery unexpectedly used the host fallback"); };
    try {
      await service.recoverStorage();
    } finally {
      repository.storageIds = storageIds;
    }
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(orphanLink), false);
    assert.equal(readFileSync(join(unknown, "keep.txt"), "utf8"), "keep outside data");
    assert.equal(existsSync(storage.paths(global.id).manifestPath), true);

    // Export is a source snapshot in the target task's authoritative directory, not a scope move.
    const exportable = await service.createAsync({ name: "中文 / : \u0000 Gadget", scope: { type: "task", taskId: "task-gadget-test" }, entry: "pages/index.html", files: [
      { path: "pages/index.html", content: "<h1>exported source</h1>" },
      { path: "assets/pixel.bin", content: Buffer.from([0, 255, 13, 10]).toString("base64"), encoding: "base64" },
    ] });
    writeFileSync(join(storage.paths(exportable.id).dataPath, "private-state.json"), "private runtime data");
    const snapshotBefore = service.readSource(exportable.id);
    const readSource = storage.readSource.bind(storage);
    const unsafeSource = join(storage.paths(exportable.id).sourcePath, "outside");
    if (useNative) storage.readSource = () => { throw new Error("Native source read unexpectedly used the host fallback"); };
    try {
      const source = await service.readSourceAsync(exportable.id);
      assert.deepEqual(source.files, [
        { path: "assets/pixel.bin", content: "AP8NCg==", encoding: "base64" },
        { path: "pages/index.html", content: "<h1>exported source</h1>", encoding: "utf8" },
      ]);
      const savedRevision = createHash("sha256")
        .update(JSON.stringify({ manifest: snapshotBefore.manifest, files: snapshotBefore.files })).digest("hex");
      assert.equal(source.revision, savedRevision);
      symlinkSync(unknown, unsafeSource, "junction");
      await assert.rejects(service.readSourceAsync(exportable.id), /源码包含符号链接/);
    } finally {
      storage.readSource = readSource;
      rmSync(unsafeSource, { force: true });
    }
    if (useNative) storage.readSource = () => { throw new Error("Native export unexpectedly used the host fallback"); };
    const exported = await service.saveToTaskDirectoryAsync({ gadgetId: exportable.id, taskId: "task-gadget-test" });
    storage.readSource = readSource;
    const copies = await Promise.all(Array.from({ length: 2 }, () => service.copyScopeAsync(exportable.id, { type: "global" })));
    assert.notEqual(copies[0].sourcePath, copies[1].sourcePath);
    const hostDelete = storage.delete.bind(storage);
    if (useNative) storage.delete = () => { throw new Error("Native cleanup unexpectedly used the host fallback"); };
    try {
      for (const copy of copies) {
        assert.deepEqual(readFileSync(join(copy.sourcePath, "assets/pixel.bin")), Buffer.from([0, 255, 13, 10]));
        const paths = storage.paths(copy.id);
        assert.equal(existsSync(join(paths.dataPath, "private-state.json")), false);
        if (nativeFiles) assert.equal(await nativeFiles.removeUnregisteredGadget(join(root, "gadgets"), copy.id), false);
        symlinkSync(unknown, join(paths.dataPath, "linked-directory"), "junction");
        await service.delete(copy.id);
        assert.equal(existsSync(paths.root), false);
        assert.equal(readFileSync(join(unknown, "keep.txt"), "utf8"), "keep outside data");
      }
    } finally {
      storage.delete = hostDelete;
    }
    assert(exported.directory.startsWith(join(ws.path!, "gadgets") + "/") || exported.directory.startsWith(join(ws.path!, "gadgets") + "\\"));
    assert.equal(exported.fileCount, 2);
    assert.equal(readFileSync(exported.entryPath, "utf8"), "<h1>exported source</h1>");
    assert.deepEqual(readFileSync(join(exported.directory, "code/assets/pixel.bin")), Buffer.from([0, 255, 13, 10]));
    assert.deepEqual(JSON.parse(readFileSync(join(exported.directory, "gadget.json"), "utf8")), snapshotBefore.manifest);
    assert.equal(existsSync(join(exported.directory, "data")), false);
    assert.equal(service.readSource(exportable.id).revision, snapshotBefore.revision);
    assert.deepEqual(service.get(exportable.id)?.scope, exportable.scope);
    writeFileSync(exported.entryPath, "user edited copy");
    const repeated = await service.saveToTaskDirectoryAsync({ gadgetId: exportable.id, taskId: "task-gadget-test" });
    assert.notEqual(repeated.directory, exported.directory);
    assert.equal(readFileSync(exported.entryPath, "utf8"), "user edited copy");
    assert.equal(readFileSync(repeated.entryPath, "utf8"), "<h1>exported source</h1>");
    await assert.rejects(service.saveToTaskDirectoryAsync({ gadgetId: exportable.id, taskId: "task-gadget-other" }), /其它任务/);
    await assert.rejects(service.saveToTaskDirectoryAsync({ gadgetId: exportable.id, taskId: "missing-task" }), /任务不存在/);
    assert.equal(existsSync(join(child.path!, "gadgets")), false, "unauthorized export must not materialize another task's directory");
    const inheritedCopy = await service.saveToTaskDirectoryAsync({ gadgetId: workspace.id, taskId: "task-gadget-other" });
    assert(inheritedCopy.directory.startsWith(join(child.path!, "gadgets")), "visible ancestor Gadget exports to requested task, not its creation workspace");
    const personalCopy = await service.saveToTaskDirectoryAsync({ gadgetId: global.id, taskId: "task-gadget-test" });
    assert(existsSync(personalCopy.entryPath));
    // No following output symlinks, including a link into another task. Keep target bytes intact.
    rmSync(join(child.path!, "gadgets"), { recursive: true });
    symlinkSync(join(ws.path!, "gadgets"), join(child.path!, "gadgets"), "junction");
    const exportsBeforeLink = readdirSync(join(ws.path!, "gadgets"));
    await assert.rejects(service.saveToTaskDirectoryAsync({ gadgetId: global.id, taskId: "task-gadget-other" }), /符号链接/);
    assert.deepEqual(readdirSync(join(ws.path!, "gadgets")), exportsBeforeLink);
    rmSync(join(child.path!, "gadgets"));
    writeFileSync(join(child.path!, "gadgets"), "existing user file");
    await assert.rejects(service.saveToTaskDirectoryAsync({ gadgetId: global.id, taskId: "task-gadget-other" }), /真实文件夹/);
    assert.equal(readFileSync(join(child.path!, "gadgets"), "utf8"), "existing user file");
    rmSync(join(child.path!, "gadgets"));
    symlinkSync(exported.entryPath, join(exportable.sourcePath, "outside.html"));
    await assert.rejects(service.saveToTaskDirectoryAsync({ gadgetId: exportable.id, taskId: "task-gadget-test" }), /符号链接/);
    assert.deepEqual(readdirSync(join(ws.path!, "gadgets")), exportsBeforeLink);
    rmSync(join(exportable.sourcePath, "outside.html"));
    if (process.platform === "win32") {
      const mixedCase = service.create({ name: "CON.txt", scope: { type: "task", taskId: "task-gadget-test" }, entry: "index.html", files: [{ path: "Index.html", content: "mixed-case entry" }] });
      const copy = await service.saveToTaskDirectoryAsync({ gadgetId: mixedCase.id, taskId: "task-gadget-test" });
      assert.equal(readFileSync(copy.entryPath, "utf8"), "mixed-case entry");
      assert.equal(JSON.parse(readFileSync(join(copy.directory, "gadget.json"), "utf8")).entry, "Index.html");
      await service.delete(mixedCase.id);
    }
    await service.delete(exportable.id);

    const archivedParent = db.createSpace({ name: "Archived Parent", path: join(root, "archived") });
    const archivedChild = db.createSpace({ name: "Archived Child", parentId: archivedParent.id, path: join(root, "archived", "child") });
    db.archiveSpace(archivedParent.id, true);
    assert.throws(() => service.create({ name: "Ghost", scope: { type: "workspace", workspaceId: archivedChild.id } }), /已归档/);
    assert.throws(() => service.moveScope(global.id, { type: "workspace", workspaceId: archivedChild.id }), /已归档/);
    assert.equal(service.list({ scope: { type: "global" } }).length, 1);
    assert.equal(service.list({ scope: { type: "workspace", workspaceId: ws.id } }).length, 1);
    assert.equal(service.list({ scope: { type: "task", taskId: "task-gadget-test" } }).length, 1);
    const taskCatalog = await service.readList({ scope: { type: "task", taskId: "task-gadget-test" }, includeInherited: true });
    assert.deepEqual(taskCatalog.map(item => [item.name, item.inherited, item.inheritedFromWorkspaceId]), [
      ["Task", undefined, undefined], ["Workspace", true, ws.id], ["Global", true, undefined],
    ]);
    const native = db.runtimeAuditReader;
    const writeNative = native?.writeWorkbench.bind(native);
    const saveNative = native?.saveGadgetSource.bind(native);
    const writeHostManifest = storage.writeManifest.bind(storage);
    const readHostManifest = storage.readManifest.bind(storage);
    const unrelatedSource = join(global.sourcePath, "unrelated.bin");
    if (native && saveNative) {
      writeFileSync(unrelatedSource, "");
      truncateSync(unrelatedSource, 4 * 1024 * 1024 + 1);
      storage.readManifest = () => { throw new Error("Native manifest read unexpectedly used the host fallback"); };
      storage.writeManifest = () => { throw new Error("Native config unexpectedly used the host fallback"); };
      native.saveGadgetSource = async (...args) => {
        assert.equal((await saveNative(...args))?.status, "manifestSaved");
        return saveNative(...args);
      };
    }
    const updatedGlobal = await (async () => {
      try {
        return await service.updateAsync({ gadgetId: global.id, name: "Global Updated", description: "updated", defaultConfig: { radix: 16 } });
      } finally {
        storage.readManifest = readHostManifest;
        storage.writeManifest = writeHostManifest;
        if (native && saveNative) native.saveGadgetSource = saveNative;
        rmSync(unrelatedSource, { force: true });
      }
    })();
    if (useNative) storage.readSource = () => { throw new Error("Native copy unexpectedly used the host fallback"); };
    const copied = await service.copyScopeAsync(workspace.id, { type: "task", taskId: "task-gadget-test" });
    storage.readSource = readSource;
    assert.notEqual(copied.sourcePath, workspace.sourcePath);
    assert.deepEqual((await service.readSourceAsync(copied.id)).files, (await service.readSourceAsync(workspace.id)).files);
    await service.delete(copied.id);
    if (native && writeNative) {
      const before = await service.readSourceAsync(global.id);
      const manifestBefore = readFileSync(global.manifestPath);
      db.connection.exec("CREATE TRIGGER fixture_reject_workbench_update BEFORE UPDATE ON gadgets "
        + "BEGIN SELECT RAISE(ABORT,'fixture workbench update rejected'); END");
      await assert.rejects(service.updateAsync({ gadgetId: global.id, name: "Rejected name", defaultConfig: { radix: 2 } }),
        /工作台数据写入失败/);
      assert.deepEqual(readFileSync(global.manifestPath), manifestBefore);
      const hostSave = storage.updateSource.bind(storage);
      const nativeSave = native.saveGadgetSource.bind(native);
      storage.updateSource = () => { throw new Error("Native save unexpectedly used the host fallback"); };
      try {
        await assert.rejects(service.updateSourceAsync({
          gadgetId: global.id, expectedRevision: before.revision,
          files: [
            { path: before.manifest.entry, content: "rejected source edit" },
            { path: "new/rejected.txt", content: "rejected new file" },
          ],
          backend: null,
        }), /fixture workbench update rejected/);
        assert.deepEqual(service.readSource(global.id), before, "failed SQLite edits roll back source and manifest");
        assert.equal(existsSync(join(global.sourcePath, "new", "rejected.txt")), false);
        assert.equal(repository.get(global.id)?.name, "Global Updated");
        db.connection.exec("DROP TRIGGER fixture_reject_workbench_update");

        // A caller missing the first acknowledgement can resend the same operation.
        native.saveGadgetSource = async (request) => {
          const initial = await nativeSave(request);
          assert.equal(initial?.status, "saved");
          return nativeSave(request);
        };
        const saved = await service.updateSourceAsync({
          gadgetId: global.id, expectedRevision: before.revision,
          files: [{ path: "assets/native.bin", content: "AP8NCg==", encoding: "base64" }],
        });
        assert.deepEqual(saved.files.find(file => file.path === "assets/native.bin"),
          { path: "assets/native.bin", encoding: "base64", content: "AP8NCg==" });
        assert.deepEqual(readFileSync(join(global.sourcePath, "assets", "native.bin")), Buffer.from([0, 255, 13, 10]));
        assert.equal(service.readSource(global.id).revision, saved.revision);
        native.saveGadgetSource = nativeSave;

        // An edit outside the app after the source was read must win over a stale save.
        native.saveGadgetSource = async (request) => {
          writeFileSync(join(global.sourcePath, before.manifest.entry), "external edit");
          return nativeSave(request);
        };
        await assert.rejects(service.updateSourceAsync({
          gadgetId: global.id, expectedRevision: saved.revision,
          files: [{ path: before.manifest.entry, content: "stale save" }],
        }), /已被修改/);
        assert.equal(readFileSync(join(global.sourcePath, before.manifest.entry), "utf8"), "external edit");
        writeFileSync(join(global.sourcePath, before.manifest.entry), before.files.find(file => file.path === before.manifest.entry)!.content);
      } finally {
        storage.updateSource = hostSave;
        native.saveGadgetSource = nativeSave;
      }

      native.writeWorkbench = async (...args) => {
        db.archiveSpace(child.id, true);
        return writeNative(...args);
      };
      await assert.rejects(service.moveScopeAsync(global.id, { type: "workspace", workspaceId: child.id }), /作用域已变化/);
      native.writeWorkbench = writeNative;
      db.archiveSpace(child.id, false);
      assert.deepEqual(repository.get(global.id)?.scope, { type: "global" });
    }
    assert.equal(updatedGlobal.name, "Global Updated");
    assert.equal(storage.readManifest(global.id).name, "Global Updated");
    assert.deepEqual(storage.readManifest(global.id).defaultConfig, { radix: 16 });
    const globalInWorkspace = await service.moveScopeAsync(global.id, { type: "workspace", workspaceId: ws.id });
    assert.equal(globalInWorkspace.id, global.id);
    assert.equal((await service.moveScopeAsync(global.id, { type: "global" })).id, global.id);
    const workspaceInChild = await service.moveScopeAsync(workspace.id, { type: "workspace", workspaceId: child.id });
    assert.equal(workspaceInChild.id, workspace.id);
    assert.deepEqual((await service.moveScopeAsync(workspace.id, { type: "workspace", workspaceId: ws.id })).scope, { type: "workspace", workspaceId: ws.id });
    writeFileSync(join(storage.paths(task.id).dataPath, "persist.txt"), "kept");
    const sourceBefore = task.sourcePath;
    const createdAtBefore = task.createdAt;
    const moved = service.moveScope(task.id, { type: "workspace", workspaceId: child.id });
    assert.equal(moved.id, task.id);
    assert.equal(moved.sourcePath, sourceBefore);
    assert.equal(readFileSync(join(storage.paths(task.id).dataPath, "persist.txt"), "utf8"), "kept");
    const promoted = service.moveScope(task.id, { type: "global" });
    assert.equal(promoted.id, task.id);
    assert.equal(promoted.sourcePath, sourceBefore);
    assert.equal(promoted.createdAt, createdAtBefore);
    assert.equal(readFileSync(join(storage.paths(task.id).dataPath, "persist.txt"), "utf8"), "kept");
    const childCatalog = await service.readList({ scope: { type: "workspace", workspaceId: child.id }, includeInherited: true });
    assert.deepEqual(childCatalog.map(item => [item.name, item.inheritedFromWorkspaceId]), [["Workspace", ws.id]]);

    const [running, sameRunning] = await Promise.all([service.start(global.id), service.start(global.id)]);
    assert.equal(running.status, "running");
    assert.equal(sameRunning.pid, running.pid, "concurrent start must reuse one runtime process");
    assert.equal(sameRunning.port, running.port, "concurrent start must reuse one port");
    assert.equal((await service.health(global.id)).status, "running");
    const previewUrl = new URL("/index.html?from=browser#preview", running.url).href;
    const previewRevision = service.readSource(global.id).revision;
    if (useNative) storage.readSource = () => { throw new Error("Native preview unexpectedly used the host fallback"); };
    try {
      const preview = await service.resolveBrowserPreview(previewUrl, "task-gadget-test", global.id);
      assert.equal(preview?.url, previewUrl);
      assert.equal(preview?.revision, previewRevision);
      assert.equal(preview?.runtime.pid, running.pid);
    } finally {
      storage.readSource = readSource;
    }
    const forbiddenHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: running.port, path: "/", headers: { host: `attacker.invalid:${running.port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(forbiddenHostStatus, 403, "Gadget localhost runtime must reject DNS-rebinding Host headers");
    assert.equal((await service.restart(global.id)).status, "running");
    await service.dispose(global.id);
    assert.equal((await service.health(global.id)).status, "stopped");
    writeFileSync(global.manifestPath, "{\"schemaVersion\":1,\"name\":\"bad\",\"type\":\"nope\",\"entry\":\"index.html\"}");
    assert.equal((await service.start(global.id)).status, "error");

    const converted = await service.convertFromArtifact({ artifactId: "art-html", scope: { type: "task", taskId: "task-gadget-test" } });
    assert.notEqual(converted.id, "art-html");
    await assert.rejects(
      () => service.convertFromArtifact({ artifactId: "art-html", scope: { type: "task", taskId: "task-gadget-other" } }),
      /所属任务/,
    );
    await assert.rejects(
      () => service.exportArtifact({ gadgetId: converted.id, taskId: "task-gadget-other" }),
      /其它任务/,
    );
    const readEntryOnHost = storage.readEntry.bind(storage);
    if (native) storage.readEntry = () => { throw new Error("Native Gadget export unexpectedly read the HTML on the host"); };
    try {
      const { artifactId } = await service.exportArtifact({ gadgetId: converted.id, taskId: "task-gadget-test", title: "导出的单页成果" });
      assert.deepEqual(
        { title: artifactOutput.get(artifactId)?.title, taskId: artifactOutput.get(artifactId)?.taskId,
          content: (await artifactOutput.readContent(artifactId))?.content },
        { title: "导出的单页成果", taskId: "task-gadget-test", content: "<html><body>artifact kept</body></html>" },
      );
      const imported = await service.exportArtifact({ gadgetId: workspace.id, taskId: "task-gadget-other" });
      assert.equal(artifactOutput.get(imported.artifactId)?.taskId, "task-gadget-other");
      assert.match((await artifactOutput.readContent(imported.artifactId))!.content, /Workspace/);
      if (native) {
        const writeManaged = native.writeManagedArtifact.bind(native);
        native.writeManagedArtifact = async (...args) => {
          repository.moveScope(converted.id, { type: "task", taskId: "task-gadget-other" });
          return writeManaged(...args);
        };
        try {
          await assert.rejects(service.exportArtifact({ gadgetId: converted.id, taskId: "task-gadget-test" }), /作用域已变化/);
          assert.deepEqual(artifactOutput.listByTask("task-gadget-test").map(output => output.id), [artifactId]);
        } finally {
          native.writeManagedArtifact = writeManaged;
          repository.moveScope(converted.id, { type: "task", taskId: "task-gadget-test" });
        }
      }
    } finally {
      storage.readEntry = readEntryOnHost;
    }
    await assert.rejects(
      () => service.convertFromArtifact({ artifactId: "art-html", scope: { type: "workspace", workspaceId: archivedChild.id } }),
      /所属任务/,
    );

    const registeredTools: Array<{ name: string; execute: (id: string, params: never) => Promise<{ isError?: boolean; details?: unknown }> }> = [];
    createGadgetAgentExtension({
      taskId: "task-gadget-test",
      resolveWorkspaceId: () => db.getTask("task-gadget-test")?.spaceId ?? null,
      service,
      getPermissionMode: () => "auto",
      requestApproval: async () => true,
    })({ registerTool: (tool: never) => registeredTools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    const gadgetCreate = registeredTools.find((tool) => tool.name === "gadget_create")!;
    const agentCreated = await gadgetCreate.execute("tc-gadget", { name: "Agent Gadget", html: "<html>agent</html>" } as never);
    assert.equal(agentCreated.isError, undefined);
    const agentGadgetId = (agentCreated.details as { gadgetId: string }).gadgetId;
    assert.deepEqual(service.get(agentGadgetId)?.scope, { type: "task", taskId: "task-gadget-test" });
    const gadgetCountBeforeRedirect = service.list().length;
    const redirectRejected = await gadgetCreate.execute("tc-file-redirect", {
      name: "Broken redirect",
      html: '<html><head><meta http-equiv="refresh" content="0; url=file:///C:/private/board.html"></head></html>',
    } as never);
    assert.equal(redirectRejected.isError, true);
    assert.equal(service.list().length, gadgetCountBeforeRedirect, "Agent must not persist a file redirect as Gadget content");
    const workspaceAgentCreated = await gadgetCreate.execute("tc-workspace-gadget", { name: "Workspace Agent Gadget", html: "<html>workspace</html>", scope: "workspace" } as never);
    assert.equal(workspaceAgentCreated.isError, undefined);
    const workspaceAgentGadgetId = (workspaceAgentCreated.details as { gadgetId: string }).gadgetId;
    assert.deepEqual(service.get(workspaceAgentGadgetId)?.scope, { type: "workspace", workspaceId: ws.id });
    const tool = (name: string) => {
      assert(isMyBuddyNativeExtensionToolName(name), `${name} must be recognized as a native product tool`);
      const found = registeredTools.find((item) => item.name === name);
      assert(found, `Agent must expose ${name}`);
      return found;
    };
    const listed = await tool("gadget_list").execute("list", {} as never);
    assert.equal(listed.isError, undefined);
    assert((listed.details as { gadgets: Array<{ id: string }> }).gadgets.some((item) => item.id === workspaceAgentGadgetId));
    const read = await tool("gadget_read").execute("read", { gadgetId: workspaceAgentGadgetId } as never);
    assert.equal(read.isError, undefined);
    const revision = (read.details as { revision: string }).revision;
    writeFileSync(join(storage.paths(workspaceAgentGadgetId).dataPath, "keep.txt"), "runtime data");
    const open = await tool("gadget_open").execute("open", { gadgetId: workspaceAgentGadgetId } as never);
    assert.equal(open.isError, undefined);
    const opened = open.details as { url: string; pid: number };
    assert.deepEqual(events.at(-1), { type: "open-requested", taskId: "task-gadget-test", gadgetId: workspaceAgentGadgetId });
    assert.match(await (await fetch(opened.url)).text(), /workspace/);
    const changed = await tool("gadget_update").execute("update", {
      gadgetId: workspaceAgentGadgetId, expectedRevision: revision,
      files: [{ path: "index.html", content: "<html><body>edited from task</body></html>" }, { path: "assets/theme.css", content: "body { color: navy; }" }],
    } as never);
    assert.equal(changed.isError, undefined);
    assert.notEqual((changed.details as { revision: string }).revision, revision);
    assert.deepEqual((changed.details as { runtime: { url?: string; pid?: number; status: string } }).runtime,
      service.get(workspaceAgentGadgetId)?.runtime, "update returns verified current preview evidence");
    assert.equal((changed.details as { runtime: { url?: string } }).runtime.url, opened.url);
    assert.match(await (await fetch(opened.url)).text(), /edited from task/);
    assert.equal(service.get(workspaceAgentGadgetId)?.runtime.pid, opened.pid, "edits retain the running URL/process");
    assert.equal(readFileSync(join(storage.paths(workspaceAgentGadgetId).dataPath, "keep.txt"), "utf8"), "runtime data");
    assert.equal(service.get(workspaceAgentGadgetId)?.id, workspaceAgentGadgetId, "edits retain Gadget identity");
    assert.equal((await tool("gadget_update").execute("stale", { gadgetId: workspaceAgentGadgetId, expectedRevision: revision, files: [{ path: "index.html", content: "stale" }] } as never)).isError, true);
    const snapshot = service.readSource(workspaceAgentGadgetId);
    assert.throws(() => service.updateSource({ gadgetId: workspaceAgentGadgetId, expectedRevision: snapshot.revision, files: [{ path: "index.html", content: "partial write" }, { path: "../escape", content: "bad" }] }), /路径/);
    assert.equal(service.readSource(workspaceAgentGadgetId).revision, snapshot.revision, "invalid batch must not partially save");
    for (const unsafe of ["assets/.. /escaped.html", "index.html:alternate", "C:/escaped.html", "assets/CON.txt"]) {
      assert.throws(() => service.updateSource({ gadgetId: workspaceAgentGadgetId, expectedRevision: snapshot.revision, files: [{ path: unsafe, content: "bad" }] }), /路径/);
    }
    assert.throws(() => storage.updateSource({ gadgetId: workspaceAgentGadgetId, expectedRevision: snapshot.revision, files: [{ path: "index.html", content: "rollback" }] }, () => { throw new Error("commit failed"); }), /commit failed/);
    assert.equal(service.readSource(workspaceAgentGadgetId).revision, snapshot.revision, "failed DB commit must restore source");
    const originalSnapshot = service.readSource(workspaceAgentGadgetId);
    service.updateSource({ gadgetId: workspaceAgentGadgetId, expectedRevision: originalSnapshot.revision, files: [{ path: "index.html", content: "<html>second edit</html>" }] });
    assert.equal(service.readSource(workspaceAgentGadgetId).files.find((file) => file.path === "assets/theme.css")?.content, "body { color: navy; }", "unmentioned files survive a patch");
    await service.stop(workspaceAgentGadgetId);
    const privateGadget = service.create({ name: "Other task private", scope: { type: "task", taskId: "task-gadget-other" } });
    for (const name of ["gadget_read", "gadget_open", "gadget_update"]) {
      assert.equal((await tool(name).execute("denied", { gadgetId: privateGadget.id, expectedRevision: service.readSource(privateGadget.id).revision, files: [{ path: "index.html", content: "bad" }] } as never)).isError, true, `${name} must reject another task's Gadget`);
    }
    assert.equal(service.get(privateGadget.id)?.runtime.status, "stopped");
    db.upsertTask({ ...db.getTask("task-gadget-test")!, spaceId: child.id, updatedAt: Date.now() });
    assert(service.list({ scope: { type: "task", taskId: "task-gadget-test" }, includeInherited: true }).some((item) => item.id === workspaceAgentGadgetId && item.inheritedFromWorkspaceId === ws.id), "child workspace tasks inherit ancestor Gadgets");
    const movedTaskAgentCreated = await gadgetCreate.execute("tc-moved-workspace-gadget", { name: "Moved Workspace Agent Gadget", html: "<html>moved</html>", scope: "workspace" } as never);
    assert.equal(movedTaskAgentCreated.isError, undefined);
    assert.deepEqual(
      service.get((movedTaskAgentCreated.details as { gadgetId: string }).gadgetId)?.scope,
      { type: "workspace", workspaceId: child.id },
      "Agent tool must resolve the task's live Workspace instead of a session-start snapshot",
    );
    db.upsertTask({ ...db.getTask("task-gadget-test")!, spaceId: ws.id, updatedAt: Date.now() });
    const gadgetCountBeforeDenied = service.list().length;
    const deniedTools: typeof registeredTools = [];
    createGadgetAgentExtension({
      taskId: "task-gadget-test",
      resolveWorkspaceId: () => db.getTask("task-gadget-test")?.spaceId ?? null,
      service,
      getPermissionMode: () => "readonly",
      requestApproval: async () => true,
    })({ registerTool: (tool: never) => deniedTools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    assert.equal((await deniedTools[0].execute("tc-readonly", { name: "Allowed legacy readonly", html: "<html>legacy</html>" } as never)).isError, undefined);
    const approvalTools: typeof registeredTools = [];
    createGadgetAgentExtension({
      taskId: "task-gadget-test",
      resolveWorkspaceId: () => db.getTask("task-gadget-test")?.spaceId ?? null,
      service,
      getPermissionMode: () => "default",
      requestApproval: async () => { throw new Error("retired approval must not be called"); },
    })({ registerTool: (tool: never) => approvalTools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    assert.equal((await approvalTools[0].execute("tc-rejected", { name: "No approval", html: "<html>direct</html>" } as never)).isError, undefined);
    assert.equal(service.list().length, gadgetCountBeforeDenied + 2, "legacy modes do not gate Gadget creation");
    for (const tools of [deniedTools, approvalTools]) {
      const beforeDenied = service.readSource(workspaceAgentGadgetId);
      const result = await tools.find((item) => item.name === "gadget_update")!.execute("deny-update", { gadgetId: workspaceAgentGadgetId, expectedRevision: beforeDenied.revision, files: [{ path: "index.html", content: "<html>updated without approval</html>" }] } as never);
      assert.equal(result.isError, undefined);
      assert.equal(service.readSource(workspaceAgentGadgetId).files.find(file => file.path === "index.html")?.content, "<html>updated without approval</html>");
      assert.equal((await tools.find((item) => item.name === "gadget_read")!.execute("allow-read", { gadgetId: workspaceAgentGadgetId } as never)).isError, undefined);
    }
    const unrelated = db.createSpace({ name: "Unrelated", path: join(root, "unrelated") });
    const catalogDuringMove = service.readList({ scope: { type: "task", taskId: "task-gadget-test" }, includeInherited: true });
    db.upsertTask({ ...db.getTask("task-gadget-test")!, spaceId: unrelated.id, updatedAt: Date.now() });
    assert.equal((await tool("gadget_read").execute("moved-away", { gadgetId: workspaceAgentGadgetId } as never)).isError, true, "access must follow a task's live workspace");
    const movedCatalog = await catalogDuringMove;
    assert.deepEqual(movedCatalog.filter(item => [global.id, workspaceAgentGadgetId, privateGadget.id].includes(item.id))
      .map(item => [item.name, item.inherited]), [["Global Updated", true]], "a workspace move during a read revokes the previous workspace's listings");
    db.upsertTask({ ...db.getTask("task-gadget-test")!, spaceId: ws.id, updatedAt: Date.now() });

    const legacyBoardPath = join(root, "legacy-board.html");
    writeFileSync(legacyBoardPath, "<!doctype html><html><body>materialized board</body></html>", "utf8");
    const legacyRedirect = service.create({
      name: "Legacy redirect",
      scope: { type: "global" },
      files: [{
        path: "index.html",
        content: `<html><head><meta http-equiv="refresh" content="0; url=${new URL(`file:///${legacyBoardPath.replaceAll("\\", "/")}`).href}"></head><body>redirect</body></html>`,
      }],
    });
    const legacyRunning = await service.start(legacyRedirect.id);
    assert.equal(legacyRunning.status, "running");
    assert.match(storage.readEntry(legacyRedirect.id).content, /materialized board/);
    await service.stop(legacyRedirect.id);

    const blueprintRepository = new BlueprintRepository(db.connection, db.runtimeAuditReader);
    const resolver = new BlueprintResolver();
    const planner = new BlueprintInstantiationPlanner();
    const blueprintBindings = new WorkspaceLibraryBindingService(db);
    db.connection.prepare("INSERT INTO library_spaces(id,name,kind,created_at,updated_at) VALUES(?,?,'personal',1,1)")
      .run("fixture-library", "Calibration reference");
    const blueprintService = new BlueprintService({
      repository: blueprintRepository,
      resolver,
      planner,
      db,
      gadgetService: service,
      libraryBindings: blueprintBindings,
      librarySpaceExists: (id) => Boolean(db.connection.prepare("SELECT 1 FROM library_spaces WHERE id=?").get(id)),
      workspaceInstancesRoot: join(root, "instances"),
    });
    const definition: CompositeBlueprintDefinition = {
      schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION,
      kind: "composite",
      capabilities: { skills: ["missing-skill"] },
      gadgets: [{
        key: "gadget:validation", name: "Validation Tool", scopeType: "task", taskKey: "task:validate",
        manifest: { schemaVersion: 1, name: "Validation Tool", type: "web", entry: "index.html" },
        sourceFiles: [{ path: "index.html", content: "<html>validate</html>" }],
      }],
      workspace: {
        key: "root",
        name: "Instrument",
        defaultContext: "Use calibrated inputs.",
        libraryBindings: [{ librarySpaceId: "fixture-library", optional: false }, { librarySpaceId: "missing-library", optional: true }],
        files: [
          { path: "README.md", content: "seed" },
          { path: "assets/calibration.bin", content: "Af4A", encoding: "base64" },
        ],
        tasks: [{ key: "task:validate", title: "Validate", welcomeMode: "general" }],
        gadgets: [{
          key: "gadget:calc",
          name: "Calculator",
          manifest: { schemaVersion: 1, name: "Calculator", type: "web", entry: "index.html" },
          sourceFiles: [{ path: "index.html", content: "<html>calc</html>" }],
        }],
        children: [{ key: "child", name: "Validation" }],
      },
    };
    const blueprint = await blueprintService.create({ name: "Instrument", definition });
    const renamedBlueprint = await blueprintService.update({ blueprintId: blueprint.id, name: "Instrument Updated", description: "CRUD" });
    assert.equal(renamedBlueprint.name, "Instrument Updated");
    assert.equal(blueprintRepository.get(blueprint.id)?.description, "CRUD");
    await Promise.all([
      blueprintService.update({ blueprintId: blueprint.id, name: "Concurrent name" }),
      blueprintService.update({ blueprintId: blueprint.id, description: null }),
    ]);
    const blueprintGetOnHost = blueprintRepository.get.bind(blueprintRepository);
    if (useNative) blueprintRepository.get = () => { throw new Error("Native Blueprint detail unexpectedly used the host fallback"); };
    try {
      const currentBlueprint = await blueprintService.get(blueprint.id);
      assert.equal(currentBlueprint?.name, "Concurrent name");
      assert.equal(currentBlueprint?.description, undefined);
      assert.deepEqual(currentBlueprint?.definition, renamedBlueprint.definition);
      assert.equal(await blueprintService.get("bp-absent"), null);
      const resolved = await blueprintService.resolve(blueprint.id, { skills: [] });
      assert.deepEqual(resolved.missing.skills, ["missing-skill"]);
      assert.equal(resolved.warnings.length, 1);
      const plan = await blueprintService.plan(blueprint.id, { skills: [] });
      assert.equal(plan.workspaces.length, 2);
      assert.equal(plan.tasks.length, 1);
      assert.equal(plan.gadgets.length, 2);
    } finally {
      blueprintRepository.get = blueprintGetOnHost;
    }
    assert.deepEqual((await blueprintService.readList()).map(({ name, description, definition }) => [
      name, description, definition.kind === "composite" ? definition.workspace?.name : undefined,
    ]), [
      ["Concurrent name", undefined, "Instrument"],
    ]);
    const instantiated = await blueprintService.instantiate({ blueprintId: blueprint.id, rootName: "Instrument Instance", registries: { skills: [] } });
    assert.equal(Object.keys(instantiated.workspaceIdsByKey).length, 2);
    assert.equal(Object.keys(instantiated.taskIdsByKey).length, 1);
    assert.equal(Object.keys(instantiated.gadgetIdsByKey).length, 2);
    assert.equal(instantiated.warnings.some((warning) => warning.includes("missing-library")), true);
    const instanceRoot = db.getSpace(instantiated.workspaceIdsByKey.root)!;
    assert.equal(readFileSync(join(instanceRoot.path!, "README.md"), "utf8"), "seed");
    assert.deepEqual(readFileSync(join(instanceRoot.path!, "assets", "calibration.bin")), Buffer.from([1, 254, 0]));
    const abandoned = join(root, "instances", "bp-f30c8306-a4b7-4f02-a9f2-a63aadb03a67");
    const linked = join(root, "instances", "bp-d4383784-5cf8-45cc-9dd9-872070d2e244");
    mkdirSync(abandoned);
    symlinkSync(unknown, linked, "junction");
    const listSpaces = db.listSpaces.bind(db);
    if (useNative) db.listSpaces = () => { throw new Error("Native Blueprint recovery unexpectedly used the host fallback"); };
    try {
      await blueprintService.recoverStorage();
    } finally {
      db.listSpaces = listSpaces;
    }
    assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(linked), false);
    assert.equal(readFileSync(join(unknown, "keep.txt"), "utf8"), "keep outside data");
    assert.equal(readFileSync(join(instanceRoot.path!, "README.md"), "utf8"), "seed");
    assert.equal(db.getSpace(instantiated.workspaceIdsByKey.child)?.parentId, instanceRoot.id);
    const instanceTask = db.getTask(instantiated.taskIdsByKey["task:validate"]);
    assert.deepEqual([instanceTask?.title, instanceTask?.spaceId, instanceTask?.status, instanceTask?.welcomeMode], ["Validate", instanceRoot.id, "pending", "general"]);
    assert.deepEqual(blueprintBindings.listByWorkspace(instanceRoot.id), ["fixture-library"]);
    assert.deepEqual(db.connection.prepare(`SELECT m.content,m.source_type,s.binding,r.revision,r.change_reason
      FROM memory_scopes s JOIN memory_records m ON m.id=s.memory_id JOIN memory_revisions r ON r.memory_id=m.id
      WHERE s.scope_type='workspace' AND s.scope_id=?`).all(instanceRoot.id), [
      { content: "Use calibrated inputs.", source_type: "import", binding: "owned", revision: 1, change_reason: "created" },
    ]);
    assert.deepEqual(service.get(instantiated.gadgetIdsByKey["gadget:calc"])?.scope, { type: "workspace", workspaceId: instanceRoot.id });
    const taskGadget = service.get(instantiated.gadgetIdsByKey["gadget:validation"]);
    assert.deepEqual(taskGadget?.scope, { type: "task", taskId: instanceTask?.id });
    assert.equal(taskGadget?.createdByTaskId, instanceTask?.id);

    if (native) {
      const originalInstantiate = native.instantiateBlueprint.bind(native);
      const markers: string[] = [];
      try {
        native.instantiateBlueprint = async (...args) => {
          assert.equal(db.findRootSpaceByName("Lost receipt instance"), undefined);
          const instance = args[1];
          assert.equal(existsSync(instance.workspaces[0].path), false);
          assert.equal(existsSync(instance.gadgets[0].manifestPath), false);
          const result = await originalInstantiate(...args);
          assert.deepEqual(result, { kind: "committed", skippedLibraries: ["missing-library"] });
          // Simulate the committed receipt surviving a stop before marker cleanup.
          markers.push(join(instance.workspaces[0].path, ".mybuddy-blueprint-stage"));
          markers.push(join(instance.gadgets[0].manifestPath, "..", ".mybuddy-blueprint-stage"));
          for (const marker of markers) writeFileSync(marker, args[0]);
          return undefined;
        };
        const recovered = await blueprintService.instantiate({ blueprintId: blueprint.id, rootName: "Lost receipt instance" });
        const revived = db.getSpace(recovered.workspaceIdsByKey.root)!;
        assert.equal(readFileSync(join(revived.path!, "README.md"), "utf8"), "seed");
        assert.equal(recovered.warnings.filter(warning => warning.includes("missing-library")).length, 1);
        assert.equal(db.getTask(recovered.taskIdsByKey["task:validate"])?.spaceId, revived.id);
        assert.ok(service.get(recovered.gadgetIdsByKey["gadget:calc"]));
        await blueprintService.recoverStorage();
        await service.recoverStorage();
        assert.deepEqual(markers.map(marker => existsSync(marker)), [false, false]);
        assert.equal(readFileSync(join(revived.path!, "README.md"), "utf8"), "seed");
      } finally {
        native.instantiateBlueprint = originalInstantiate;
      }
    }

    const sameName = await Promise.allSettled([
      blueprintService.instantiate({ blueprintId: blueprint.id, rootName: "Concurrent instance" }),
      blueprintService.instantiate({ blueprintId: blueprint.id, rootName: "Concurrent instance" }),
    ]);
    assert.equal(sameName.filter(outcome => outcome.status === "fulfilled").length, 1);
    assert.equal(db.listSpaces().filter(space => space.name === "Concurrent instance").length, 1);

    assert.throws(
      () => migrateBlueprintDefinition({ ...definition, schemaVersion: 0, type: "composite", kind: undefined }),
      /不支持的 Blueprint schemaVersion/,
      "current-only database policy must not revive historical Blueprint JSON",
    );
    assert.equal(normalizeBlueprintDefinition({ schemaVersion: 1, kind: "workspace", workspace: { key: "one", name: "One" } }).kind, "workspace");
    assert.equal(normalizeBlueprintDefinition({ schemaVersion: 1, kind: "gadget", gadget: definition.workspace!.gadgets![0] }).kind, "gadget");
    assert.equal(normalizeBlueprintDefinition({ schemaVersion: 1, kind: "composite", gadgets: [definition.workspace!.gadgets![0]] }).kind, "composite");
    assert.throws(() => normalizeBlueprintDefinition({ schemaVersion: 1, kind: "workspace", capabilities: { skills: "bad" }, workspace: { key: "bad", name: "Bad" } }), /必须是数组/);
    assert.throws(() => normalizeBlueprintDefinition({ schemaVersion: 1, kind: "workspace", workspace: { key: "bad", name: "Bad", tasks: {} } }), /必须是数组/);
    assert.throws(() => normalizeBlueprintDefinition({
      schemaVersion: 1,
      kind: "gadget",
      gadget: { ...definition.workspace!.gadgets![0], metadata: { invalid: Number.POSITIVE_INFINITY } },
    }), /有限数字/);
    assert.throws(() => normalizeBlueprintDefinition({
      schemaVersion: 1,
      kind: "gadget",
      gadget: {
        key: "base64-secret",
        name: "Unsafe",
        manifest: { schemaVersion: 1, name: "Unsafe", type: "web", entry: "config.json" },
        sourceFiles: [{ path: "config.json", content: Buffer.from('{"apiKey":"secret-value"}', "utf8").toString("base64"), encoding: "base64" }],
      },
    }), /credential\/token/, "base64 text must not bypass Blueprint secret checks");
    assert.throws(() => normalizeBlueprintDefinition({
      schemaVersion: 1,
      kind: "gadget",
      gadget: {
        key: "invalid-base64",
        name: "Invalid",
        manifest: { schemaVersion: 1, name: "Invalid", type: "web", entry: "index.bin" },
        sourceFiles: [{ path: "index.bin", content: "not base64!", encoding: "base64" }],
      },
    }), /规范 base64/);
    assert.throws(() => normalizeBlueprintDefinition({
      schemaVersion: 1,
      kind: "workspace",
      workspace: { key: "plain-secret", name: "Unsafe", files: [{ path: "config.yaml", content: "password: plain-text-secret" }] },
    }), /credential\/token/);
    assert.doesNotThrow(() => normalizeBlueprintDefinition({
      schemaVersion: 1,
      kind: "workspace",
      workspace: { key: "secret-reference", name: "Safe Reference", files: [{ path: "config.js", content: "password=process.env.PASSWORD" }] },
    }));
    let tooDeep: Record<string, unknown> = { key: "depth:17", name: "Depth 17" };
    for (let depth = 16; depth >= 1; depth -= 1) tooDeep = { key: `depth:${depth}`, name: `Depth ${depth}`, children: [tooDeep] };
    assert.throws(() => normalizeBlueprintDefinition({ schemaVersion: 1, kind: "workspace", workspace: tooDeep }), /深度不能超过/);

    writeFileSync(join(ws.path!, "template.md"), "selected");
    const outsideTemplate = join(root, "outside-template.md");
    writeFileSync(outsideTemplate, "outside workspace must not be captured");
    let linkedTemplateCreated = false;
    try {
      symlinkSync(outsideTemplate, join(ws.path!, "template-link.md"), "file");
      linkedTemplateCreated = true;
    } catch { /* Windows without symlink privilege: production guard is still covered by static contract below. */ }
    writeFileSync(join(ws.path!, ".env"), "API_KEY=must-not-leak");
    const excludedSource = join(storage.paths(workspace.id).sourcePath, ".ENV.local");
    writeFileSync(excludedSource, "ACCESS_TOKEN=must-not-leak");
    truncateSync(excludedSource, 4 * 1024 * 1024 + 1);
    writeFileSync(join(storage.paths(workspace.id).sourcePath, "config.js"), "PASSWORD=super-secret-value");
    service.update({
      gadgetId: workspace.id,
      metadata: { reusable: "yes", nested: { origin: "task-gadget-test", localRoot: "C:\\Users\\secret\\source" } },
    });
    mkdirSync(join(ws.path!, "node_modules"), { recursive: true });
    writeFileSync(join(ws.path!, "node_modules", "secret.txt"), "excluded");
    writeFileSync(join(ws.path!, ".mybuddy-task.json"), "runtime");
    const captureMemory = new MemoryService(db, { semantic: false });
    assert.throws(() => captureMemory.create({
      kind: "procedure", title: "Forbidden secret", content: "ACCESS_TOKEN=secret-value",
      scopeType: "workspace", scopeId: ws.id, sourceType: "manual", explicit: true, confidence: 1, importance: 1,
    }), /敏感秘密/, "Memory Kernel must reject secrets before Blueprint capture");
    captureMemory.create({
      kind: "procedure", title: "Reusable method", content: "Use the standard validated workflow",
      scopeType: "workspace", scopeId: ws.id, sourceType: "manual", explicit: true, confidence: 1, importance: 1,
    });
    captureMemory.create({
      kind: "progress", title: "conversation/session runtime result",
      scopeType: "workspace", scopeId: ws.id, sourceType: "agent", explicit: false, confidence: 0.8, importance: 0,
    });
    const bindings = new WorkspaceLibraryBindingService(db);
    bindings.bind(ws.id, "library-methods");
    const oldCapture = storage.captureSource.bind(storage);
    if (native) storage.captureSource = () => { throw new Error("Native Gadget capture unexpectedly used the host fallback"); };
    const preview = await (async () => {
      try {
        return await blueprintService.previewCaptureDefinition(ws.id, {
          name: "Preview Only", includeChildren: true, includeTasks: true, includeGadgets: true, selectedFiles: ["template.md"],
        });
      } finally {
        storage.captureSource = oldCapture;
      }
    })();
    assert.equal(blueprintService.list().some((item) => item.name === "Preview Only"), false, "preview must not persist");
    assert.equal(JSON.stringify(preview).includes("Reusable method"), false, "context capture must be opt-in");
    const readGadgets = service.readList.bind(service);
    service.readList = async (request) => {
      const rows = await readGadgets(request);
      if (rows.some(row => row.id === workspace.id)) await service.moveScopeAsync(workspace.id, { type: "global" });
      return rows;
    };
    try {
      await assert.rejects(blueprintService.previewCaptureDefinition(ws.id, { name: "Moved Gadget" }), /作用域已变化/);
    } finally {
      service.readList = readGadgets;
      await service.moveScopeAsync(workspace.id, { type: "workspace", workspaceId: ws.id });
    }
    const confirmedPreview = await blueprintService.captureDefinition(ws.id, { name: "Confirmed Preview" }, preview);
    assert.deepEqual(confirmedPreview.definition, preview, "save must commit the exact definition the user previewed");
    const captured = await blueprintService.captureDefinition(ws.id, {
      name: "Captured",
      includeChildren: true,
      includeTasks: true,
      includeGadgets: true,
      includeContext: true,
      selectedFiles: ["template.md"],
    });
    const json = JSON.stringify(captured.definition);
    assert.equal(json.includes("selected"), true);
    assert.equal(json.includes("node_modules"), false);
    assert.equal(json.includes(".mybuddy-task.json"), false);
    assert.equal(json.includes("artifact kept"), false);
    assert.equal(json.includes("must-not-leak"), false);
    assert.equal(json.includes(".ENV.local"), false);
    rmSync(excludedSource);
    assert.equal(json.includes("super-secret-value"), false);
    assert.equal(json.includes("[redacted]"), true);
    assert.equal(json.includes('"pid":'), false);
    assert.equal(json.includes('"port":'), false);
    assert.equal(json.includes(ws.id), false, "definition must not retain real workspace IDs");
    assert.equal(json.includes("task-gadget-test"), false, "definition must not retain real task IDs");
    assert.equal(json.includes(workspace.id), false, "definition must not retain real Gadget IDs");
    assert.equal(json.includes("localRoot"), false, "definition metadata must not retain local source paths");
    assert.equal(json.includes('"status":'), false, "definition must not capture task runtime/workflow status");
    assert.equal(json.includes("conversation/session runtime result"), false, "automatic/session context must not be captured");
    assert.equal(json.includes("library-methods"), true, "library binding definition must be captured");
    assert.equal(json.includes("Reusable method"), true, "opted-in manual context must be captured");
    assert.equal(json.includes("standard validated workflow"), true, "captured manual context must preserve non-sensitive content");
    await assert.rejects(blueprintService.captureDefinition(ws.id, { name: "Unsafe", selectedFiles: [".env"] }), /不在白名单/);
    if (linkedTemplateCreated) {
      await assert.rejects(
        () => blueprintService.previewCaptureDefinition(ws.id, { name: "Symlink", selectedFiles: ["template-link.md"] }),
        /符号链接/,
      );
    }
    await assert.rejects(blueprintService.create({
      name: "Credential Leak",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: { key: "unsafe", name: "Unsafe", files: [{ path: "config.json", content: '{"apiKey":"secret-value"}' }] },
      },
    }), /credential\/token/);
    await assert.rejects(blueprintService.create({
      name: "Build Snapshot",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: { key: "unsafe-build", name: "Unsafe", files: [{ path: "node_modules/pkg.js", content: "snapshot" }] },
      },
    }), /Blueprint 白名单/);

    const gadgetBlueprint = await blueprintService.captureGadget(converted.id, { name: "Artifact Gadget Blueprint" });
    const gadgetBlueprintJson = JSON.stringify(gadgetBlueprint.definition);
    assert.equal(gadgetBlueprint.kind, "gadget");
    assert.equal(gadgetBlueprintJson.includes(converted.id), false);
    assert.equal(gadgetBlueprintJson.includes("art-html"), false, "captured Gadget metadata must not retain source Artifact ID");
    assert.equal(gadgetBlueprintJson.includes('"pid":'), false);
    const standaloneGadgetInstance = await blueprintService.instantiate({
      blueprintId: gadgetBlueprint.id,
      gadgetScope: { type: "workspace", workspaceId: ws.id },
    });
    assert.deepEqual(service.get(Object.values(standaloneGadgetInstance.gadgetIdsByKey)[0])?.scope, { type: "workspace", workspaceId: ws.id });
    await service.delete(converted.id);
    assert.equal(artifactRows.has("art-html"), true, "deleting Gadget must not delete source Artifact");

    const rollbackBlueprint = await blueprintService.create({
      name: "Rollback",
      definition: {
        schemaVersion: 1,
        kind: "composite",
        workspace: {
          key: "rollback-root",
          name: "Rollback Root",
          defaultContext: "Rollback must remove this L1 record.",
          libraryBindings: [{ librarySpaceId: "fixture-library", optional: false }],
          files: [{ path: "created/nested.txt", content: "must be removed" }],
          tasks: [{ key: "rollback-task", title: "Must Roll Back" }],
          gadgets: [{
            key: "rollback-first-gadget",
            name: "Prepared Before Failure",
            manifest: { schemaVersion: 1, name: "Prepared Before Failure", type: "web", entry: "index.html" },
            sourceFiles: [{ path: "index.html", content: "<html>prepared</html>" }],
          }, {
            key: "rollback-gadget",
            name: "Fails Later",
            manifest: { schemaVersion: 1, name: "Fails Later", type: "web", entry: "index.html" },
            sourceFiles: [{ path: "index.html", content: "<html>rollback</html>" }],
          }],
        },
      },
    });
    const taskCountBeforeRollback = db.listTasks().length;
    const spaceCountBeforeRollback = db.listSpaces().length;
    const memoryCountBeforeRollback = (db.connection.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count;
    const instanceCountBeforeRollback = readdirSync(join(root, "instances")).length;
    const gadgetIdsBeforeRollback = repository.list().map(gadget => gadget.id).sort();
    const eventCountBeforeRollback = events.length;
    const gadgetDirectoriesBeforeRollback = readdirSync(join(root, "gadgets")).sort();
    const bindingsBeforeRollback = blueprintBindings.listByLibrarySpace("fixture-library");
    db.connection.exec(`CREATE TRIGGER fixture_reject_blueprint_gadget BEFORE INSERT ON gadgets
      WHEN new.name='Fails Later' BEGIN SELECT RAISE(ABORT, 'forced Gadget materialization failure'); END;`);
    try {
      await assert.rejects(() => blueprintService.instantiate({ blueprintId: rollbackBlueprint.id }), /forced Gadget materialization failure|蓝图实例数据库写入失败/);
    } finally {
      db.connection.exec("DROP TRIGGER fixture_reject_blueprint_gadget");
    }
    if (native) {
      db.connection.exec(`CREATE TRIGGER fixture_reject_blueprint_receipt BEFORE INSERT ON blueprint_instance_receipts
        BEGIN SELECT RAISE(ABORT, 'forced failure after writing Blueprint files'); END;`);
      try {
        await assert.rejects(() => blueprintService.instantiate({ blueprintId: rollbackBlueprint.id }), /forced failure after writing Blueprint files/);
      } finally {
        db.connection.exec("DROP TRIGGER fixture_reject_blueprint_receipt");
      }
    }
    assert.equal(db.listTasks().length, taskCountBeforeRollback, "failed instantiate must roll back created tasks");
    assert.equal(db.listSpaces().length, spaceCountBeforeRollback, "failed instantiate must roll back workspace tree");
    assert.equal((db.connection.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count, memoryCountBeforeRollback, "failed instantiate must not leave orphan L1 Memory");
    assert.equal(readdirSync(join(root, "instances")).length, instanceCountBeforeRollback, "failed instantiate must remove its generated workspace root");
    assert.deepEqual(readdirSync(join(root, "gadgets")).sort(), gadgetDirectoriesBeforeRollback);
    assert.deepEqual(repository.list().map(gadget => gadget.id).sort(), gadgetIdsBeforeRollback);
    assert.equal(events.length, eventCountBeforeRollback, "failed instance must not publish Gadget creation events");
    assert.deepEqual(blueprintBindings.listByLibrarySpace("fixture-library"), bindingsBeforeRollback);

    const collisionBlueprint = await blueprintService.create({
      name: "Path Collision",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: {
          key: "collision-root",
          name: "Collision Root",
          children: [
            { key: "collision-a", name: "A/B" },
            { key: "collision-b", name: "A:B" },
          ],
        },
      },
    });
    await assert.rejects(() => blueprintService.instantiate({ blueprintId: collisionBlueprint.id }), /目录冲突/);
    assert.equal(db.listSpaces().length, spaceCountBeforeRollback, "sanitized path collision must roll back the whole instance");

    const requiredLibraryBlueprint = await blueprintService.create({
      name: "Required Library",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: {
          key: "required-library-root",
          name: "Required Library Root",
          libraryBindings: [{ librarySpaceId: "missing-required-library", optional: false }],
        },
      },
    });
    await assert.rejects(() => blueprintService.instantiate({ blueprintId: requiredLibraryBlueprint.id }), /必需资料库/);
    assert.equal(db.listSpaces().length, spaceCountBeforeRollback, "required binding failure must not leave a partial Workspace");

    await blueprintService.delete(blueprint.id);
    assert.ok(db.getSpace(instantiated.workspaceIdsByKey.root), "deleting Blueprint must keep instances");
    assert.ok(service.get(instantiated.gadgetIdsByKey["gadget:calc"]), "deleting Blueprint must keep Gadget instances");
    const lifecycleGlobal = service.create({ name: "Lifecycle Global", scope: { type: "global" } });
    const lifecycleWorkspace = service.create({ name: "Lifecycle Workspace", scope: { type: "workspace", workspaceId: child.id } });
    const lifecycleTask = service.create({ name: "Lifecycle Task", scope: { type: "task", taskId: "task-gadget-test" } });
    await service.deleteByWorkspace(child.id);
    assert.equal(service.get(lifecycleWorkspace.id), null);
    assert.equal(existsSync(storage.paths(lifecycleWorkspace.id).root), false);
    assert.ok(service.get(lifecycleGlobal.id), "workspace cleanup must not delete global Gadget");
    await service.deleteByTask("task-gadget-test");
    assert.equal(service.get(lifecycleTask.id), null);
    assert.equal(existsSync(storage.paths(lifecycleTask.id).root), false);
    assert.ok(service.get(lifecycleGlobal.id), "task cleanup must not delete global Gadget");

    // IPC / preload / renderer boundary contracts: typed channels are wired once and renderer never owns processes.
    assert.equal(new Set(Object.values(GadgetIpc)).size, Object.values(GadgetIpc).length);
    assert.equal(new Set(Object.values(BlueprintIpc)).size, Object.values(BlueprintIpc).length);
    const mainSource = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    const preloadSource = readFileSync(join(process.cwd(), "src/preload/index.ts"), "utf8");
    for (const key of Object.keys(GadgetIpc)) {
      assert.equal(mainSource.includes(`GadgetIpc.${key}`), true, `main must wire GadgetIpc.${key}`);
      assert.equal(preloadSource.includes(`GadgetIpc.${key}`), true, `preload must expose GadgetIpc.${key}`);
    }
    for (const key of Object.keys(BlueprintIpc)) {
      assert.equal(mainSource.includes(`BlueprintIpc.${key}`), true, `main must wire BlueprintIpc.${key}`);
      assert.equal(preloadSource.includes(`BlueprintIpc.${key}`), true, `preload must expose BlueprintIpc.${key}`);
    }
    const gadgetRenderer = readFileSync(join(process.cwd(), "src/renderer/src/components/gadget/GadgetSection.tsx"), "utf8");
    const captureRenderer = readFileSync(join(process.cwd(), "src/renderer/src/components/blueprint/BlueprintCaptureDialog.tsx"), "utf8");
    const workspaceDetail = readFileSync(join(process.cwd(), "src/renderer/src/components/workspace/WorkspaceDetail.tsx"), "utf8");
    const artifactPanel = readFileSync(join(process.cwd(), "src/renderer/src/components/artifact/ArtifactPanel.tsx"), "utf8");
    assert.equal(/child_process|\bspawn\s*\(/.test(gadgetRenderer), false, "renderer must not spawn Gadget runtime");
    assert.equal(captureRenderer.includes("previewCapture") && captureRenderer.includes("selectedFiles"), true, "capture UI must preview definition and expose explicit file selection");
    assert.equal(workspaceDetail.includes('"gadgets"') && workspaceDetail.includes("WorkspaceGadgetsSection"), true, "Workspace Detail must expose Gadgets");
    assert.equal(artifactPanel.includes('panelMode === "gadgets"') && artifactPanel.includes("TaskGadgetsView"), true, "right panel must expose Task Gadgets");
    assert.equal(EXTENSION_MODES.includes("gadgets"), true, "right-panel mode menu must expose the Gadget view");
    assert.equal(EXTENSION_MODE_LABEL.gadgets, "工作台", "Gadget navigation must use the current localized product label");
    await service.disposeAll();
    console.log("gadget-blueprint-test: ok");
  } finally {
    await activeService?.disposeAll();
    await db.runtimeAuditReader?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
