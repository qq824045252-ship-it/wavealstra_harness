import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConversationBranchService, type ConversationBranchAgentPort } from "../src/main/agent/ConversationBranchService";
import { createArtifactDomain } from "../src/main/artifact/ArtifactDomainSetup";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { TaskWorkspaceBrancher } from "../src/main/task/TaskWorkspaceBrancher";

export async function verifyConversationBranchLineage(db: AppDatabase, background: RuntimeAuditReader, root: string): Promise<void> {
  const reader = db.runtimeAuditReader;
  assert(reader && db.coreIdentity);
  assert.equal(db.fixtureConnection, undefined);
  const workspacePath = join(root, "branch-lineage-workspace");
  mkdirSync(workspacePath);
  const unexpectedAgentCall = (): never => { throw new Error("Lineage reads must be independent of the agent"); };
  const agent: ConversationBranchAgentPort = {
    isTaskBusy: unexpectedAgentCall,
    resolveTaskExecutionWorkspaceCwd: unexpectedAgentCall,
    getAppSettings: unexpectedAgentCall,
    setTaskConnectorIds: unexpectedAgentCall,
    previewConversationBranch: unexpectedAgentCall,
    materializeConversationBranch: unexpectedAgentCall,
    commitConversationBranch: unexpectedAgentCall,
  };
  const brancher = new TaskWorkspaceBrancher(new TaskExecutionWorkspace(join(root, "branch-lineage-private")));
  const artifactService = createArtifactDomain(undefined, undefined, reader, join(root, "branch-lineage-artifacts")).service;
  const service = new ConversationBranchService({ db, agent, brancher, artifactService });
  const prefix = "core-lineage-";
  const parentId = `${prefix}parent`;
  const workspaceId = `${prefix}workspace`;
  const workspaceChild = `${prefix}workspace-child`;
  const independentChild = `${prefix}independent-child`;
  const trashedChild = `${prefix}trashed-child`;
  const grandchild = `${prefix}grandchild`;
  const create = (id: string, parentTaskId: string, at: number, spaceId?: string) => db.createConversationBranchTaskAsync({
    childTaskId: id, parentTaskId, rootTaskId: parentId, parentTitleSnapshot: "Original parent title",
    sourceSessionFile: `durable:${parentTaskId}:source`, sourceLeafEntryId: "source-entry", sourceUserMessageIndex: 2,
    requestId: `create-${id}`, position: "after_reply", workspaceStrategy: spaceId ? "shared_space" : "conversation_only",
    createdAt: at, task: { id, title: id, spaceId, updatedAt: at },
  });
  await db.writeWorkspaceUpsert({ id: workspaceId, name: "Branch lineage workspace", path: workspacePath });
  await db.writeTaskRecord({ id: parentId, title: "Current parent title", updatedAt: 1 });
  await create(workspaceChild, parentId, 40, workspaceId);
  await create(independentChild, parentId, 20);
  await create(trashedChild, parentId, 30);
  await create(grandchild, workspaceChild, 50, workspaceId);
  await db.writeTaskRecord({ id: workspaceChild, title: "Renamed child", updatedAt: 55 }, { preserveTitle: false, preserveWorkspace: true });
  await db.archiveTaskAsync(workspaceChild, true);
  assert.equal((await db.readTask(workspaceChild))?.spaceId, workspaceId);
  assert.deepEqual(await reader.batch2Write({ kind: "upsertTaskExecutionWorkspaceState", taskId: trashedChild,
    directoryName: trashedChild, state: "trashed", createdAt: 30, updatedAt: 60, trashedAt: 60 }), { ok: true });

  const [children, info] = await Promise.all([service.listChildren(parentId), service.getInfo(workspaceChild)]);
  assert.deepEqual(children.map(row => [row.childTaskId, row.createdAt]), [[independentChild, 20], [workspaceChild, 40]]);
  assert.deepEqual(info, {
    childTaskId: workspaceChild, parentTaskId: parentId, rootTaskId: parentId,
    parentTitle: "Original parent title", childTitle: "Renamed child", sourceUserMessageIndex: 2,
    sourcePosition: "after_reply", workspaceStrategy: "shared_space", createdAt: 40, parentExists: true,
  });
  assert.deepEqual((await service.listChildren(workspaceChild)).map(row => row.childTaskId), [grandchild]);
  assert.equal(await service.getInfo(trashedChild), undefined);
  assert.deepEqual(await service.listChildren(`${prefix}missing`), []);

  assert.deepEqual(await reader.batch2Write({ kind: "deleteTask", id: parentId }), { ok: true });
  assert.deepEqual(await service.getInfo(workspaceChild), { ...info, parentExists: false });
  assert.deepEqual((await service.listChildren(parentId)).map(row => row.parentExists), [false, false]);
  assert.deepEqual(await background.applicationDatabaseIdentity(), db.coreIdentity);
  assert.equal(await background.readConversationBranchData("children", parentId), undefined);
  console.log("PASS Core conversation lineage preserves visible direct children and deleted-parent history, and rejects non-UI reads");
}
