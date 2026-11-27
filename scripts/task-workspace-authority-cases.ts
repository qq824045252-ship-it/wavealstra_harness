import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { DurableWorkspaceMoves } from "../src/main/agent/durable/DurableWorkspaceMoves";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { resolveTaskWorkspaceCwdAsync } from "../src/main/task/TaskWorkspaceResolver";
import { WorkspacePathError } from "../src/main/workspace/WorkspacePathError";

export async function verifyTaskWorkspaceAuthority(application: AppDatabase, peer: RuntimeAuditReader, root: string): Promise<void> {
  const ui = application.runtimeAuditReader!;
  assert.notEqual(ui, peer);
  const parent = "workspace-authority-parent";
  const child = "workspace-authority-child";
  const boundTask = "workspace-authority-bound";
  const firstDirectory = join(root, "workspace-authority-first");
  const nextDirectory = join(root, "workspace-authority-next");
  const privateWorkspace = new TaskExecutionWorkspace(join(root, "workspace-authority-private"));
  mkdirSync(firstDirectory);
  mkdirSync(nextDirectory);
  await application.writeWorkspaceUpsert({ id: parent, name: "Authority parent", path: firstDirectory });
  await application.writeWorkspaceUpsert({ id: child, name: "Inherits parent directory", parentId: parent });
  await application.writeTaskRecord({ id: boundTask, title: "Inherited workspace", spaceId: child, updatedAt: Date.now() });

  const before = await ui.readTaskWorkspaceAuthority(boundTask);
  assert(before);
  assert.deepEqual(before.spaceChain.map(row => row.id), [child, parent]);
  assert.equal((await peer.upsertWorkspace({ id: parent, name: "Authority parent", path: nextDirectory, at: Date.now() }))?.status, "saved");
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindWorkspaceCwd", taskId: boundTask,
    expectedVersion: before.version, cwd: firstDirectory, at: Date.now() }))?.status, "rejected");
  assert.equal((await peer.readTaskWorkspaceAuthority(boundTask))?.cwd, null);
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, boundTask), nextDirectory);
  const confirmed = await peer.readTaskWorkspaceAuthority(boundTask);
  assert.equal(confirmed?.cwd, nextDirectory);
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, boundTask), nextDirectory);
  assert.equal((await peer.readTaskWorkspaceAuthority(boundTask))?.version, confirmed?.version);

  const pinnedTask = "workspace-authority-executing";
  await application.writeTaskRecord({ id: pinnedTask, title: "Original native namespace", spaceId: child,
    cwd: firstDirectory, updatedAt: Date.now() });
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindBot", taskId: pinnedTask,
    directory: join(root, "workspace-authority-store"), cwd: firstDirectory }))?.status, "applied");
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, pinnedTask), firstDirectory);
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, pinnedTask, { candidateOnly: true }), nextDirectory);
  const pinnedMove = new DurableWorkspaceMoves(application);
  const movement = { taskId: pinnedTask, fromCwd: firstDirectory, toCwd: nextDirectory };
  await pinnedMove.write({ kind: "stage", ...movement });
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, pinnedTask), firstDirectory);
  assert.equal(await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, pinnedTask, { candidateOnly: true }), nextDirectory);
  assert.equal((await peer.readTaskWorkspaceAuthority(pinnedTask))?.cwd, firstDirectory);
  await pinnedMove.write({ kind: "cancel", ...movement });

  const sameDirectoryTask = "workspace-authority-recovery";
  await application.writeTaskRecord({ id: sameDirectoryTask, title: "Recover pinned namespace", spaceId: child,
    cwd: nextDirectory, updatedAt: Date.now() });
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindBot", taskId: sameDirectoryTask,
    directory: join(root, "workspace-authority-recovery-store"), cwd: nextDirectory }))?.status, "applied");

  const resolveDuringActivity = async (taskId: string) => {
    const readAuthority = ui.readTaskWorkspaceAuthority;
    let projected = false;
    ui.readTaskWorkspaceAuthority = async function (id) {
      const snapshot = await readAuthority.call(this, id);
      if (!projected && id === taskId) {
        projected = true;
        const projection = await peer.writeDurableTaskProjection({ kind: "snapshot", taskId: id,
          status: "running", activityAt: Date.now() + 1_000, workspaces: [] });
        assert.equal(projection?.status, "applied");
      }
      return snapshot;
    };
    try {
      return await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, taskId, { candidateOnly: true });
    } finally {
      ui.readTaskWorkspaceAuthority = readAuthority;
      assert(projected);
    }
  };
  assert.equal(await resolveDuringActivity(sameDirectoryTask), nextDirectory);
  await assert.rejects(resolveDuringActivity(pinnedTask), /任务或工作空间已变化/);
  console.log("PASS recovery reselects its existing pinned directory after unrelated activity, without admitting a stale move");

  assert.equal((await peer.setSidebarArchive({ kind: "space", id: parent, archived: true, at: Date.now() }))?.status, "saved");
  await assert.rejects(resolveTaskWorkspaceCwdAsync(application, privateWorkspace, boundTask), /归档/);
  assert.equal((await peer.setSidebarArchive({ kind: "space", id: parent, archived: false, at: Date.now() + 1 }))?.status, "saved");
  assert(confirmed);
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindWorkspaceCwd", taskId: boundTask,
    expectedVersion: confirmed.version, cwd: nextDirectory, at: Date.now() }))?.status, "rejected");

  const beforeRestore = await ui.readTaskWorkspaceAuthority(boundTask);
  assert(beforeRestore);
  const workspaceState = { kind: "upsertTaskExecutionWorkspaceState", taskId: boundTask,
    directoryName: privateWorkspace.getTaskDirectoryName(boundTask), createdAt: Date.now() };
  assert.deepEqual(await peer.batch2Write({ ...workspaceState, state: "trashed", updatedAt: Date.now() }), { ok: true });
  await assert.rejects(resolveTaskWorkspaceCwdAsync(application, privateWorkspace, boundTask), /回收站/);
  assert.deepEqual(await peer.batch2Write({ ...workspaceState, state: "active", updatedAt: Date.now() + 1 }), { ok: true });
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindWorkspaceCwd", taskId: boundTask,
    expectedVersion: beforeRestore.version, cwd: nextDirectory, at: Date.now() }))?.status, "rejected");

  const missingTask = "workspace-authority-missing-folder";
  const missingDirectory = join(root, "workspace-authority-never-created");
  assert.equal((await peer.upsertWorkspace({ id: parent, name: "Authority parent", path: missingDirectory, at: Date.now() + 2 }))?.status, "saved");
  await application.writeTaskRecord({ id: missingTask, title: "Missing bound directory", spaceId: child, updatedAt: Date.now() });
  await assert.rejects(resolveTaskWorkspaceCwdAsync(application, privateWorkspace, missingTask), (error: unknown) =>
    error instanceof WorkspacePathError && error.causeCode === "workspace-path-missing" && error.path === missingDirectory);
  assert.equal(existsSync(missingDirectory), false);
  assert.equal(existsSync(privateWorkspace.resolveTaskExecutionWorkspaceDir(missingTask)), false);

  const privateTask = "workspace-authority-private-task";
  const unrelatedDirectory = join(root, "workspace-authority-renderer-cwd");
  mkdirSync(unrelatedDirectory);
  await application.writeTaskRecord({ id: privateTask, title: "App private workspace", cwd: unrelatedDirectory, updatedAt: Date.now() });
  const privateDirectory = await resolveTaskWorkspaceCwdAsync(application, privateWorkspace, privateTask);
  assert.equal(privateDirectory, privateWorkspace.resolveTaskExecutionWorkspaceDir(privateTask));
  assert.equal(privateWorkspace.readManifest(privateTask).taskId, privateTask);
  const deleted = await ui.readTaskWorkspaceAuthority(privateTask);
  assert(deleted);
  assert.deepEqual(await peer.batch2Write({ kind: "deleteTask", id: privateTask }), { ok: true });
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindWorkspaceCwd", taskId: privateTask,
    expectedVersion: deleted.version, cwd: privateDirectory, at: Date.now() }))?.status, "rejected");
  assert.equal(await peer.readTaskWorkspaceAuthority(privateTask), null);
  console.log("PASS Core workspace authority fences ancestor changes, restore and deletion, preserves pinned and private roots, and rejects missing bound folders");
}
