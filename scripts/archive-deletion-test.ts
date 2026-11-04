import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { ArchivedContentDeletion, artifactPurgeCleanupWarning, removeManagedTaskSession } from "../src/main/task/ArchivedContentDeletion";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle, type TaskExecutionWorkspaceLifecycleOptions } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

function env(hooks: Partial<TaskExecutionWorkspaceLifecycleOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-archive-deletion-test-"));
  const db = new AppDatabase(join(root, "app.db"));
  const workspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
  const sessionsRoot = join(root, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const memory = new MemoryService(db, { semantic: false });
  const stopped: string[] = [];
  const artifacts: string[] = [];
  const lifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace, trashRoot: join(root, "trash"),
    beforeTrash: (id) => { stopped.push(id); }, onPurgeArtifacts: (id) => { artifacts.push(id); }, ...hooks });
  const deletion = new ArchivedContentDeletion({ db, lifecycle,
    afterDeleteTask: (task, sessionFiles) => {
      memory.detachAllInScope("task", task.id);
      for (const sessionFile of sessionFiles) removeManagedTaskSession(db, { ...task, sessionFile }, sessionsRoot);
    },
    afterDeleteSpace: (id) => { memory.detachAllInScope("workspace", id); },
  });
  const task = (id: string, spaceId?: string, archived = false, sessionFile?: string) => {
    const dir = workspace.ensureTaskExecutionWorkspace(id);
    writeFileSync(join(dir, "owned.txt"), id);
    db.upsertTask({ id, title: id, spaceId, updatedAt: Date.now(), cwd: dir, sessionFile });
    if (archived) lifecycle.archive(id);
    return dir;
  };
  return { root, db, workspace, memory, sessionsRoot, lifecycle, deletion, task, stopped, artifacts,
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function check(name: string, run: () => Promise<void>) {
  await run(); console.log(`PASS ${name}`);
}

async function main() {
  await check("ordinary deletion stays recoverable; explicit archive purge forces permanent deletion", async () => {
    const e = env();
    try {
      const dir = e.task("trashed");
      await e.lifecycle.trash("trashed");
      assert.ok(e.db.getTask("trashed"));
      assert.ok(e.db.getTaskExecutionWorkspaceState("trashed")?.purgeAfter! > Date.now());
      const trashPath = e.db.getTaskExecutionWorkspaceState("trashed")!.trashPath!;
      assert.ok(existsSync(trashPath));
      const result = await e.deletion.purge({ taskIds: ["trashed", "trashed"], spaceIds: [] });
      assert.deepEqual(result, { deletedTaskIds: ["trashed"], deletedSpaceIds: [], failures: [] });
      assert.equal(e.db.getTask("trashed"), undefined);
      assert.equal(e.db.getTaskExecutionWorkspaceState("trashed"), undefined);
      assert.equal(existsSync(dir), false); assert.equal(existsSync(trashPath), false);
      assert.deepEqual(e.artifacts, ["trashed"]);
    } finally { e.close(); }
  });

  await check("nested inherited archive + overlapping selections purge once, preserve active and external workspaces", async () => {
    const e = env();
    try {
      const external = join(e.root, "linked-user-workspace"); mkdirSync(external);
      writeFileSync(join(external, "user.txt"), "user-owned");
      e.db.createSpace({ id: "root", name: "Root", path: external });
      e.db.createSpace({ id: "child", name: "Child", parentId: "root" });
      e.db.createSpace({ id: "grandchild", name: "Grandchild", parentId: "child" });
      e.db.createSpace({ id: "active-space", name: "Active" });
      e.task("root-task", "root"); e.task("child-task", "child"); e.task("grand-task", "grandchild");
      e.task("old-trash", "child"); await e.lifecycle.trash("old-trash");
      const activeDir = e.task("active-task", "active-space");
      const standaloneDir = e.task("standalone", undefined, true);
      e.db.archiveSpace("root", true);
      const privateMemory = e.memory.create({ kind: "fact", title: "Private", content: "task only", scopeType: "task", scopeId: "child-task", sourceType: "user" });
      const workspaceMemory = e.memory.create({ kind: "fact", title: "Workspace", scopeType: "workspace", scopeId: "child", sourceType: "user" });
      const globalMemory = e.memory.create({ kind: "fact", title: "Global", scopeType: "global", sourceType: "user" });
      const pipeline = new MemoryPipelineManager(e.db);
      const turn = pipeline.capture({ taskId: "child-task", userMessageId: "u", assistantMessageId: "a", userText: "raw", assistantText: "history" }).turn;
      const result = await e.deletion.purge({ spaceIds: ["root", "child", "active-space"], taskIds: ["child-task", "standalone", "active-task"] });
      assert.deepEqual(new Set(result.deletedTaskIds), new Set(["root-task", "child-task", "grand-task", "old-trash", "standalone"]));
      assert.deepEqual(result.deletedSpaceIds, ["grandchild", "child", "root"]);
      assert.deepEqual(new Set(result.failures.map((failure) => failure.id)), new Set(["active-space", "active-task"]));
      assert.equal(e.artifacts.filter((id) => id === "child-task").length, 1);
      assert.equal(e.memory.get(privateMemory.id), undefined); assert.equal(e.memory.get(workspaceMemory.id), undefined);
      assert.ok(e.memory.get(globalMemory.id)); assert.equal(pipeline.turns.get(turn.id), undefined);
      assert.ok(e.db.getTask("active-task")); assert.ok(e.db.getSpace("active-space"));
      assert.ok(existsSync(activeDir)); assert.equal(existsSync(standaloneDir), false);
      assert.equal(readFileSync(join(external, "user.txt"), "utf8"), "user-owned");
    } finally { e.close(); }
  });

  await check("partial filesystem failures retain their spaces and do not report a deleted task", async () => {
    const e = env();
    try {
      e.db.createSpace({ id: "root", name: "Root" });
      const bad = e.task("bad", "root"); e.task("good", "root"); e.db.archiveSpace("root", true);
      writeFileSync(join(bad, ".mybuddy-task.json"), JSON.stringify({ version: 1, taskId: "other", createdAt: Date.now() }));
      const result = await e.deletion.purge({ spaceIds: ["root"], taskIds: [] });
      assert.deepEqual(result.deletedTaskIds, ["good"]); assert.deepEqual(result.deletedSpaceIds, []);
      assert.deepEqual(new Set(result.failures.map((failure) => failure.id)), new Set(["bad", "root"]));
      assert.ok(e.db.getTask("bad")); assert.ok(e.db.getSpace("root")); assert.ok(existsSync(bad));
    } finally { e.close(); }
  });

  await check("owned materials protect the complete selected tree before tasks or Gadgets are touched", async () => {
    const e = env();
    const gadgetCleanup: string[] = [];
    try {
      e.db.createSpace({ id: "protected-root", name: "Protected root" });
      e.db.createSpace({ id: "protected-docs", name: "Protected documents", parentId: "protected-root" });
      e.db.createSpace({ id: "protected-empty", name: "Protected sibling", parentId: "protected-root" });
      e.db.createSpace({ id: "clear-root", name: "Clear root" });
      const rootTaskPath = e.task("protected-root-task", "protected-root");
      const nestedTaskPath = e.task("protected-doc-task", "protected-docs");
      const siblingTaskPath = e.task("protected-sibling-task", "protected-empty");
      e.task("clear-task", "clear-root");
      const library = new LibraryService(e.db, { libraryRoot: join(e.root, "library") });
      const owner = library.ensureOwnedSpace({ type: "workspace", workspaceId: "protected-docs" });
      const document = library.createItem({ spaceId: owner.id, kind: "markdown", title: "Keep this material" });
      library.writeContent({ id: document.id, content: "preserved library content" });
      const documentPath = library.absolutePath(document);
      e.db.archiveSpace("protected-root", true);
      e.db.archiveSpace("clear-root", true);
      const deletion = new ArchivedContentDeletion({ db: e.db, lifecycle: e.lifecycle,
        afterDeleteSpace: (id) => { assert.equal(e.db.getSpace(id), undefined); gadgetCleanup.push(id); },
      });
      const result = await deletion.purge({ spaceIds: ["protected-root", "protected-empty", "clear-root"], taskIds: [] });
      assert.deepEqual(result.deletedTaskIds, ["clear-task"]);
      assert.deepEqual(result.deletedSpaceIds, ["clear-root"]);
      assert(result.failures.some((failure) => failure.id === "protected-root" && /自有资料/.test(failure.error)));
      assert.deepEqual(e.stopped, ["clear-task"], "blocked tasks are never stopped or moved to trash");
      assert.deepEqual(e.artifacts, ["clear-task"], "blocked tasks never start artifact cleanup");
      assert.deepEqual(gadgetCleanup, ["clear-root"], "all Gadgets in the protected tree survive, including empty siblings");
      for (const id of ["protected-root", "protected-docs", "protected-empty"]) assert(e.db.getSpace(id));
      for (const id of ["protected-root-task", "protected-doc-task", "protected-sibling-task"]) assert(e.db.getTask(id));
      for (const path of [rootTaskPath, nestedTaskPath, siblingTaskPath]) assert(existsSync(path));
      assert.equal(readFileSync(documentPath, "utf8"), "preserved library content");

      // Explicitly selecting a task is independent authorization, even when its owning tree is protected.
      const explicit = await deletion.purge({ spaceIds: ["protected-root"], taskIds: ["protected-doc-task"] });
      assert.deepEqual(explicit.deletedTaskIds, ["protected-doc-task"]);
      assert.deepEqual(explicit.deletedSpaceIds, []);
      assert(e.db.getTask("protected-root-task") && e.db.getTask("protected-sibling-task"));
      assert.deepEqual(gadgetCleanup, ["clear-root"]);
      assert(existsSync(documentPath));
    } finally { e.close(); }
  });

  await check("materials appearing during asynchronous task cleanup block Gadget cleanup before space deletion", async () => {
    let e: ReturnType<typeof env>;
    let library: LibraryService;
    let ownerId: string;
    let addedDocumentPath = "";
    const gadgetCleanup: string[] = [];
    e = env({ onPurge: async () => {
      await Promise.resolve();
      e.db.archiveSpace("material-race", false);
      const document = library.createItem({ spaceId: ownerId, kind: "markdown", title: "Added during cleanup" });
      addedDocumentPath = library.absolutePath(document);
      e.db.archiveSpace("material-race", true);
    } });
    try {
      e.db.createSpace({ id: "material-race", name: "Material race" });
      e.task("material-race-task", "material-race");
      library = new LibraryService(e.db, { libraryRoot: join(e.root, "library") });
      ownerId = library.ensureOwnedSpace({ type: "workspace", workspaceId: "material-race" }).id;
      e.db.archiveSpace("material-race", true);
      const deletion = new ArchivedContentDeletion({ db: e.db, lifecycle: e.lifecycle,
        afterDeleteSpace: (id) => { assert.equal(e.db.getSpace(id), undefined); gadgetCleanup.push(id); },
      });
      const result = await deletion.purge({ spaceIds: ["material-race"], taskIds: [] });
      assert.deepEqual(result.deletedTaskIds, ["material-race-task"]);
      assert.deepEqual(result.deletedSpaceIds, []);
      assert(result.failures.some((failure) => failure.id === "material-race" && /自有资料/.test(failure.error)));
      assert.deepEqual(gadgetCleanup, [], "fresh blockers are rechecked before the destructive callback");
      assert(e.db.getSpace("material-race") && existsSync(addedDocumentPath));
    } finally { e.close(); }
  });

  await check("strict shutdown failures and restored requests preserve task data", async () => {
    const e = env({ beforeTrash: () => { throw new Error("session stop failed"); } });
    try {
      const dir = e.task("busy", undefined, true);
      const result = await e.deletion.purge({ taskIds: ["busy"], spaceIds: [] });
      assert.deepEqual(result.deletedTaskIds, []); assert.match(result.failures[0].error, /session stop failed/);
      assert.ok(e.db.getTask("busy")); assert.ok(existsSync(dir));
    } finally { e.close(); }
    let restored: ReturnType<typeof env>;
    restored = env({ beforeTrash: () => { restored.lifecycle.unarchive("restored"); } });
    try {
      const dir = restored.task("restored", undefined, true);
      const result = await restored.deletion.purge({ taskIds: ["restored"], spaceIds: [] });
      assert.deepEqual(result.deletedTaskIds, []); assert.match(result.failures[0].error, /恢复/);
      assert.equal(restored.db.getTask("restored")?.archived, false); assert.ok(existsSync(dir));
    } finally { restored.close(); }
  });

  await check("failed artifact purge stays archived and retryable after DB reopen, preserves linked cwd", async () => {
    let rejectArtifacts = true;
    const e = env({ onPurgeArtifacts: (id) => { if ((id === "failed" || id === "inherited") && rejectArtifacts) throw new Error("artifact cleanup failed"); } });
    try {
      const external = join(e.root, "linked-cwd"); mkdirSync(external); writeFileSync(join(external, "keep.txt"), "keep");
      e.task("failed", undefined, true); e.db.bindTaskExecutionWorkspaceCwd("failed", external);
      e.task("sibling", undefined, true);
      e.db.createSpace({ id: "inherited-root", name: "Inherited" });
      e.task("inherited", "inherited-root"); e.db.archiveSpace("inherited-root", true);
      const failed = await e.deletion.purge({ taskIds: ["failed", "sibling"], spaceIds: ["inherited-root"] });
      assert.deepEqual(failed.deletedTaskIds, ["sibling"]); assert.match(failed.failures[0].error, /artifact cleanup failed/);
      assert.equal(e.db.getTaskExecutionWorkspaceState("failed")?.state, "archived");
      assert.equal(e.db.getTask("failed")?.cwd, external);
      assert.equal(e.db.getTask("inherited")?.archived, false, "inherited archive remains inherited after recovery");
      assert.equal(e.db.isTaskEffectiveArchived("inherited"), true);
      assert.ok(e.db.listNonTrashedTasks().some((task) => task.id === "failed"));
      const reopened = new AppDatabase(join(e.root, "app.db"));
      try {
        assert.ok(reopened.listNonTrashedTasks().some((task) => task.id === "failed" && task.archived));
        assert.ok(reopened.listNonTrashedTasks().some((task) => task.id === "inherited"));
        assert.equal(reopened.isTaskEffectiveArchived("inherited"), true);
      }
      finally { reopened.close(); }
      rejectArtifacts = false;
      const retry = await e.deletion.purge({ taskIds: ["failed"], spaceIds: ["inherited-root"] });
      assert.deepEqual(new Set(retry.deletedTaskIds), new Set(["failed", "inherited"]));
      assert.deepEqual(retry.deletedSpaceIds, ["inherited-root"]); assert.deepEqual(retry.failures, []);
      assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "keep");
    } finally { e.close(); }
  });

  await check("space restored during artifact cleanup leaves inherited task visible and active after reopen", async () => {
    let e: ReturnType<typeof env>;
    e = env({ onPurgeArtifacts: async () => { await Promise.resolve(); e.db.archiveSpace("restored-space", false); } });
    try {
      const external = join(e.root, "restored-linked-cwd"); mkdirSync(external); writeFileSync(join(external, "keep.txt"), "keep");
      e.db.createSpace({ id: "restored-space", name: "Restored" }); e.task("inherited-race", "restored-space");
      e.db.bindTaskExecutionWorkspaceCwd("inherited-race", external); e.db.archiveSpace("restored-space", true);
      const result = await e.deletion.purge({ taskIds: [], spaceIds: ["restored-space"] });
      assert.deepEqual(result.deletedTaskIds, []); assert.deepEqual(result.deletedSpaceIds, []);
      assert.ok(result.failures.some((failure) => failure.kind === "task" && /恢复/.test(failure.error)));
      assert.equal(result.failures.some((failure) => /恢复归档以便重试失败/.test(failure.error)), false);
      assert.equal(e.db.getTaskExecutionWorkspaceState("inherited-race")?.state, "active");
      assert.equal(e.db.getTask("inherited-race")?.archived, false); assert.equal(e.db.getTask("inherited-race")?.cwd, external);
      const reopened = new AppDatabase(join(e.root, "app.db"));
      try { assert.ok(reopened.listNonTrashedTasks().some((task) => task.id === "inherited-race" && !task.archived)); }
      finally { reopened.close(); }
      assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "keep");
    } finally { e.close(); }
  });

  await check("strict trash passes flag and rejects active external Agent before moving any data", async () => {
    let active = true;
    const received: Array<boolean | undefined> = [];
    const e = env({ beforeTrash: (_id, options) => {
      received.push(options?.strict);
      if (options?.strict && active) throw new Error("外部 Agent 正在运行，请先停止后再彻底删除");
    } });
    try {
      const dir = e.task("external-busy", undefined, true);
      const result = await e.deletion.purge({ taskIds: ["external-busy"], spaceIds: [] });
      assert.deepEqual(result.deletedTaskIds, []); assert.match(result.failures[0].error, /外部 Agent 正在运行/);
      assert.ok(existsSync(dir)); assert.equal(e.db.getTaskExecutionWorkspaceState("external-busy")?.state, "archived");
      assert.ok(e.db.getTask("external-busy")); assert.deepEqual(received, [true]);
      e.task("ordinary-trash"); await e.lifecycle.trash("ordinary-trash");
      assert.equal(e.db.getTaskExecutionWorkspaceState("ordinary-trash")?.state, "trashed");
      assert.deepEqual(received, [true, undefined]);
      active = false;
      const retry = await e.deletion.purge({ taskIds: ["external-busy"], spaceIds: [] });
      assert.deepEqual(retry.deletedTaskIds, ["external-busy"]); assert.deepEqual(retry.failures, []);
    } finally { e.close(); }
  });

  await check("actual artifact service orphan result becomes cleanup warning after task row deletion", async () => {
    class LockedStorage extends ArtifactStorage { override remove(_path: string): boolean { return false; } }
    const warnings = new Map<string, string>();
    let artifacts: ArtifactService;
    const e = env({
      onPurgeArtifacts: (id) => {
        const warning = artifactPurgeCleanupWarning(artifacts.removeByTask(id));
        warnings.delete(id); if (warning) warnings.set(id, warning);
      },
      onPurge: (id) => { const warning = warnings.get(id); warnings.delete(id); if (warning) throw new Error(warning); },
    });
    try {
      e.task("locked-artifact", undefined, true);
      const storage = new LockedStorage(join(e.root, "artifacts"));
      const repository = new ArtifactRepository(e.db.connection);
      artifacts = new ArtifactService(storage, repository, new ArtifactRegistry());
      const descriptor = await artifacts.register({ taskId: "locked-artifact", kind: "html", content: "<p>locked</p>" });
      assert.equal(descriptor.source.type, "managed-content");
      const result = await e.deletion.purge({ taskIds: ["locked-artifact"], spaceIds: [] });
      assert.deepEqual(result.deletedTaskIds, ["locked-artifact"]);
      assert.equal(result.failures.length, 1); assert.match(result.failures[0].error, /1 个产物文件未能清理/);
      assert.equal(e.db.getTask("locked-artifact"), undefined); assert.equal(repository.get(descriptor.id), null);
      if (descriptor.source.type === "managed-content") assert.ok(storage.exists(descriptor.source.storagePath));
      assert.equal(warnings.size, 0);
      assert.equal(artifactPurgeCleanupWarning({ removed: 1, orphaned: 0 }), undefined);
    } finally { e.close(); }
  });

  await check("post-delete cleanup failures still acknowledge deleted rows; duplicate calls are serialized", async () => {
    const e = env({ onPurge: () => { throw new Error("cleanup failed"); } });
    try {
      e.task("cleanup", undefined, true);
      const [first, second] = await Promise.all([
        e.deletion.purge({ taskIds: ["cleanup"], spaceIds: [] }), e.deletion.purge({ taskIds: ["cleanup"], spaceIds: [] }),
      ]);
      assert.deepEqual(first.deletedTaskIds, ["cleanup"]); assert.match(first.failures[0].error, /cleanup failed/);
      assert.deepEqual(second.deletedTaskIds, []); assert.equal(second.failures.length, 1);
      assert.deepEqual(e.artifacts, ["cleanup"]);
      assert.throws(() => e.deletion.purge({ spaceIds: [], taskIds: [42] } as never), /ID/);
      assert.throws(() => e.deletion.purge({ taskIds: [] } as never), /数组/);
    } finally { e.close(); }
  });

  await check("managed session purge preserves shared task history, branch sources and external JSONL", async () => {
    const e = env();
    try {
      const shared = join(e.sessionsRoot, "shared.jsonl"); writeFileSync(shared, "shared");
      e.task("a", undefined, true, shared); e.task("b", undefined, false, shared);
      await e.deletion.purge({ taskIds: ["a"], spaceIds: [] }); assert.ok(existsSync(shared));
      e.lifecycle.archive("b"); await e.deletion.purge({ taskIds: ["b"], spaceIds: [] }); assert.equal(existsSync(shared), false);
      const source = join(e.sessionsRoot, "branch-source.jsonl"); writeFileSync(source, "branch");
      e.task("parent", undefined, true, source); e.task("branch", undefined, false);
      e.db.connection.prepare(`INSERT INTO conversation_branches (child_task_id,parent_task_id,root_task_id,parent_title_snapshot,source_session_file,source_leaf_entry_id,source_user_message_index,request_id,source_position,workspace_strategy,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run("branch", "parent", "parent", "Parent", source, "entry", 0, "request", "after_reply", "conversation_only", Date.now());
      await e.deletion.purge({ taskIds: ["parent"], spaceIds: [] }); assert.ok(existsSync(source));
      e.lifecycle.archive("branch"); await e.deletion.purge({ taskIds: ["branch"], spaceIds: [] }); assert.equal(existsSync(source), false);
      const external = join(e.root, "user-history.jsonl"); writeFileSync(external, "user");
      e.task("external", undefined, true, external); await e.deletion.purge({ taskIds: ["external"], spaceIds: [] });
      assert.equal(readFileSync(external, "utf8"), "user");
    } finally { e.close(); }
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
