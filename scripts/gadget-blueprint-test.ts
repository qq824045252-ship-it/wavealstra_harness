import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BlueprintRepository } from "../src/main/blueprint/BlueprintRepository";
import { BlueprintResolver } from "../src/main/blueprint/BlueprintResolver";
import { BlueprintInstantiationPlanner } from "../src/main/blueprint/BlueprintInstantiationPlanner";
import { BlueprintService } from "../src/main/blueprint/BlueprintService";
import { migrateBlueprintDefinition } from "../src/main/blueprint/BlueprintDefinitionMigrator";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { BLUEPRINT_DEFINITION_SCHEMA_VERSION, normalizeBlueprintDefinition, type CompositeBlueprintDefinition } from "../src/shared/blueprint-types";
import { GadgetIpc } from "../src/shared/gadget-ipc";
import { BlueprintIpc } from "../src/shared/blueprint-ipc";
import type { GadgetChangedEvent } from "../src/shared/gadget-ipc";
import { isMyBuddyNativeExtensionToolName } from "../src/shared/native-tools";
import { EXTENSION_MODES, EXTENSION_MODE_LABEL } from "../src/renderer/src/components/artifact/extensionModes";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-gadget-blueprint-"));
  const db = new AppDatabase(":memory:");
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

    const repository = new GadgetRepository(db.connection);
    const storage = new GadgetStorage(join(root, "gadgets"));
    const registry = new GadgetRegistry();
    const runtime = new GadgetRuntime(storage, registry);
    const events: GadgetChangedEvent[] = [];
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
      workspaceAncestors: (id) => db.getSpaceAncestors(id).map((space) => space.id),
      artifacts: {
        read: async (id) => {
          const row = artifactRows.get(id);
          return row ? { taskId: row.taskId, title: "Artifact", kind: "html", content: row.content } : null;
        },
        write: async ({ taskId, content }) => { const id = `art-${artifactRows.size}`; artifactRows.set(id, { taskId, content }); return { artifactId: id }; },
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

    const global = service.create({ name: "Global", scope: { type: "global" } });
    const workspace = service.create({ name: "Workspace", scope: { type: "workspace", workspaceId: ws.id } });
    const task = service.create({ name: "Task", scope: { type: "task", taskId: "task-gadget-test" } });
    const archivedParent = db.createSpace({ name: "Archived Parent", path: join(root, "archived") });
    const archivedChild = db.createSpace({ name: "Archived Child", parentId: archivedParent.id, path: join(root, "archived", "child") });
    db.archiveSpace(archivedParent.id, true);
    assert.throws(() => service.create({ name: "Ghost", scope: { type: "workspace", workspaceId: archivedChild.id } }), /已归档/);
    assert.throws(() => service.moveScope(global.id, { type: "workspace", workspaceId: archivedChild.id }), /已归档/);
    assert.equal(service.list({ scope: { type: "global" } }).length, 1);
    assert.equal(service.list({ scope: { type: "workspace", workspaceId: ws.id } }).length, 1);
    assert.equal(service.list({ scope: { type: "task", taskId: "task-gadget-test" } }).length, 1);
    assert.deepEqual(
      new Set(service.list({ scope: { type: "task", taskId: "task-gadget-test" }, includeInherited: true }).map((item) => item.id)),
      new Set([task.id, workspace.id, global.id]),
      "a task must discover its own, workspace and personal Gadgets",
    );
    const updatedGlobal = service.update({ gadgetId: global.id, name: "Global Updated", description: "updated", defaultConfig: { radix: 16 } });
    assert.equal(updatedGlobal.name, "Global Updated");
    assert.equal(storage.readManifest(global.id).name, "Global Updated");
    assert.deepEqual(storage.readManifest(global.id).defaultConfig, { radix: 16 });
    const globalInWorkspace = service.moveScope(global.id, { type: "workspace", workspaceId: ws.id });
    assert.equal(globalInWorkspace.id, global.id);
    assert.equal(service.moveScope(global.id, { type: "global" }).id, global.id);
    const workspaceInChild = service.moveScope(workspace.id, { type: "workspace", workspaceId: child.id });
    assert.equal(workspaceInChild.id, workspace.id);
    assert.deepEqual(service.moveScope(workspace.id, { type: "workspace", workspaceId: ws.id }).scope, { type: "workspace", workspaceId: ws.id });
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
    assert.equal(service.list({ scope: { type: "workspace", workspaceId: child.id }, includeInherited: true }).some((row) => row.id === workspace.id && row.inherited), true);

    const [running, sameRunning] = await Promise.all([service.start(global.id), service.start(global.id)]);
    assert.equal(running.status, "running");
    assert.equal(sameRunning.pid, running.pid, "concurrent start must reuse one runtime process");
    assert.equal(sameRunning.port, running.port, "concurrent start must reuse one port");
    assert.equal((await service.health(global.id)).status, "running");
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
    assert.ok((await service.exportArtifact({ gadgetId: converted.id, taskId: "task-gadget-test" })).artifactId);
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
    assert.equal((await deniedTools[0].execute("tc-readonly", { name: "Denied", html: "<html/>" } as never)).isError, true);
    const approvalTools: typeof registeredTools = [];
    createGadgetAgentExtension({
      taskId: "task-gadget-test",
      resolveWorkspaceId: () => db.getTask("task-gadget-test")?.spaceId ?? null,
      service,
      getPermissionMode: () => "default",
      requestApproval: async () => false,
    })({ registerTool: (tool: never) => approvalTools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    assert.equal((await approvalTools[0].execute("tc-rejected", { name: "Rejected", html: "<html/>" } as never)).isError, true);
    assert.equal(service.list().length, gadgetCountBeforeDenied, "readonly/rejected Agent calls must not create Gadget");
    const beforeDenied = service.readSource(workspaceAgentGadgetId);
    for (const tools of [deniedTools, approvalTools]) {
      const result = await tools.find((item) => item.name === "gadget_update")!.execute("deny-update", { gadgetId: workspaceAgentGadgetId, expectedRevision: beforeDenied.revision, files: [{ path: "index.html", content: "denied" }] } as never);
      assert.equal(result.isError, true);
      assert.equal(service.readSource(workspaceAgentGadgetId).revision, beforeDenied.revision);
      assert.equal((await tools.find((item) => item.name === "gadget_read")!.execute("allow-read", { gadgetId: workspaceAgentGadgetId } as never)).isError, undefined);
    }
    const unrelated = db.createSpace({ name: "Unrelated", path: join(root, "unrelated") });
    db.upsertTask({ ...db.getTask("task-gadget-test")!, spaceId: unrelated.id, updatedAt: Date.now() });
    assert.equal((await tool("gadget_read").execute("moved-away", { gadgetId: workspaceAgentGadgetId } as never)).isError, true, "access must follow a task's live workspace");
    assert.equal(service.list({ scope: { type: "task", taskId: "task-gadget-test" }, includeInherited: true }).some((item) => item.id === workspaceAgentGadgetId), false);
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

    const blueprintRepository = new BlueprintRepository(db.connection);
    const resolver = new BlueprintResolver();
    const planner = new BlueprintInstantiationPlanner();
    const blueprintService = new BlueprintService({
      repository: blueprintRepository,
      resolver,
      planner,
      db,
      gadgetService: service,
      libraryBindings: new WorkspaceLibraryBindingService(db),
      librarySpaceExists: () => false,
      workspaceInstancesRoot: join(root, "instances"),
    });
    const definition: CompositeBlueprintDefinition = {
      schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION,
      kind: "composite",
      capabilities: { skills: ["missing-skill"] },
      workspace: {
        key: "root",
        name: "Instrument",
        defaultContext: "Use calibrated inputs.",
        libraryBindings: [{ librarySpaceId: "missing-library", optional: true }],
        files: [{ path: "README.md", content: "seed" }],
        tasks: [{ key: "task:validate", title: "Validate" }],
        gadgets: [{
          key: "gadget:calc",
          name: "Calculator",
          manifest: { schemaVersion: 1, name: "Calculator", type: "web", entry: "index.html" },
          sourceFiles: [{ path: "index.html", content: "<html>calc</html>" }],
        }],
        children: [{ key: "child", name: "Validation" }],
      },
    };
    const blueprint = blueprintService.create({ name: "Instrument", definition });
    const renamedBlueprint = blueprintService.update({ blueprintId: blueprint.id, name: "Instrument Updated", description: "CRUD" });
    assert.equal(renamedBlueprint.name, "Instrument Updated");
    assert.equal(blueprintRepository.get(blueprint.id)?.description, "CRUD");
    const resolved = blueprintService.resolve(blueprint.id, { skills: [] });
    assert.deepEqual(resolved.missing.skills, ["missing-skill"]);
    assert.equal(resolved.warnings.length, 1);
    const plan = blueprintService.plan(blueprint.id, { skills: [] });
    assert.equal(plan.workspaces.length, 2);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.gadgets.length, 1);
    const instantiated = await blueprintService.instantiate({ blueprintId: blueprint.id, rootName: "Instrument Instance", registries: { skills: [] } });
    assert.equal(Object.keys(instantiated.workspaceIdsByKey).length, 2);
    assert.equal(Object.keys(instantiated.taskIdsByKey).length, 1);
    assert.equal(Object.keys(instantiated.gadgetIdsByKey).length, 1);
    assert.equal(instantiated.warnings.some((warning) => warning.includes("missing-library")), true);
    const instanceRoot = db.getSpace(instantiated.workspaceIdsByKey.root)!;
    assert.equal(readFileSync(join(instanceRoot.path!, "README.md"), "utf8"), "seed");

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
    writeFileSync(join(storage.paths(workspace.id).sourcePath, ".env.local"), "ACCESS_TOKEN=must-not-leak");
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
    const preview = blueprintService.previewCaptureDefinition(ws.id, {
      name: "Preview Only",
      includeChildren: true,
      includeTasks: true,
      includeGadgets: true,
      selectedFiles: ["template.md"],
    });
    assert.equal(blueprintService.list().some((item) => item.name === "Preview Only"), false, "preview must not persist");
    assert.equal(JSON.stringify(preview).includes("Reusable method"), false, "context capture must be opt-in");
    const confirmedPreview = blueprintService.captureDefinition(ws.id, { name: "Confirmed Preview" }, preview);
    assert.deepEqual(confirmedPreview.definition, preview, "save must commit the exact definition the user previewed");
    const captured = blueprintService.captureDefinition(ws.id, {
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
    assert.throws(() => blueprintService.captureDefinition(ws.id, { name: "Unsafe", selectedFiles: [".env"] }), /不在白名单/);
    if (linkedTemplateCreated) {
      assert.throws(
        () => blueprintService.previewCaptureDefinition(ws.id, { name: "Symlink", selectedFiles: ["template-link.md"] }),
        /符号链接/,
      );
    }
    assert.throws(() => blueprintService.create({
      name: "Credential Leak",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: { key: "unsafe", name: "Unsafe", files: [{ path: "config.json", content: '{"apiKey":"secret-value"}' }] },
      },
    }), /credential\/token/);
    assert.throws(() => blueprintService.create({
      name: "Build Snapshot",
      definition: {
        schemaVersion: 1,
        kind: "workspace",
        workspace: { key: "unsafe-build", name: "Unsafe", files: [{ path: "node_modules/pkg.js", content: "snapshot" }] },
      },
    }), /Blueprint 白名单/);

    const gadgetBlueprint = blueprintService.captureGadget(converted.id, { name: "Artifact Gadget Blueprint" });
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

    const rollbackBlueprint = blueprintService.create({
      name: "Rollback",
      definition: {
        schemaVersion: 1,
        kind: "composite",
        workspace: {
          key: "rollback-root",
          name: "Rollback Root",
          defaultContext: "Rollback must remove this L1 record.",
          files: [{ path: "created/nested.txt", content: "must be removed" }],
          tasks: [{ key: "rollback-task", title: "Must Roll Back" }],
          gadgets: [{
            key: "rollback-gadget",
            name: "Fails Later",
            manifest: { schemaVersion: 1, name: "Fails Later", type: "web", entry: "index.html" },
            sourceFiles: [{ path: "index.html", content: "<html>rollback</html>" }],
          }],
        },
      },
    });
    const taskCountBeforeRollback = db.listTasks().length;
    const spaceCountBeforeRollback = db.listSpaces({ includeArchived: true }).length;
    const memoryCountBeforeRollback = (db.connection.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count;
    const instanceCountBeforeRollback = readdirSync(join(root, "instances")).length;
    const originalCreateFromBlueprint = service.createFromBlueprint.bind(service);
    service.createFromBlueprint = (() => { throw new Error("forced Gadget materialization failure"); }) as typeof service.createFromBlueprint;
    await assert.rejects(() => blueprintService.instantiate({ blueprintId: rollbackBlueprint.id }), /forced Gadget materialization failure/);
    service.createFromBlueprint = originalCreateFromBlueprint;
    assert.equal(db.listTasks().length, taskCountBeforeRollback, "failed instantiate must roll back created tasks");
    assert.equal(db.listSpaces({ includeArchived: true }).length, spaceCountBeforeRollback, "failed instantiate must roll back workspace tree");
    assert.equal((db.connection.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count, memoryCountBeforeRollback, "failed instantiate must not leave orphan L1 Memory");
    assert.equal(readdirSync(join(root, "instances")).length, instanceCountBeforeRollback, "failed instantiate must remove its generated workspace root");

    const collisionBlueprint = blueprintService.create({
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
    assert.equal(db.listSpaces({ includeArchived: true }).length, spaceCountBeforeRollback, "sanitized path collision must roll back the whole instance");

    const requiredLibraryBlueprint = blueprintService.create({
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
    assert.equal(db.listSpaces({ includeArchived: true }).length, spaceCountBeforeRollback, "required binding failure must not leave a partial Workspace");

    blueprintService.delete(blueprint.id);
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
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
