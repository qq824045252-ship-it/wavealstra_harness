import { existsSync, realpathSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { TaskDto } from "../../shared/agent-ipc";
import type { ArchivedContentDeletionRequest, ArchivedContentDeletionResult } from "../../shared/archive-deletion";
import type { AppDatabase } from "../db/AppDatabase";
import { isPathInsideOrEqual, normalizePathForComparison } from "./TaskExecutionWorkspace";
import type { TaskExecutionWorkspaceLifecycle } from "./TaskExecutionWorkspaceLifecycle";

export type ArchiveTaskCandidate = Pick<TaskDto, "id" | "spaceId" | "projectId" | "archived" | "cwd" | "sessionFile">;

interface ArchivedContentDeletionOptions {
  db: AppDatabase;
  lifecycle: TaskExecutionWorkspaceLifecycle;
  /** Reversible preparation only. Irreversible cleanup belongs in afterDeleteSpace. */
  beforeDeleteSpace?: (spaceId: string) => void | Promise<void>;
  afterDeleteSpace?: (spaceId: string) => void | Promise<void>;
  afterDeleteTask?: (task: ArchiveTaskCandidate, sessionFiles: string[]) => void | Promise<void>;
}

interface ArchivePurgeOutcome {
  result: ArchivedContentDeletionResult;
  projectIds: string[];
}

/** Archive management's explicit hard delete, serialized to avoid duplicate purge races. */
export class ArchivedContentDeletion {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ArchivedContentDeletionOptions) {}

  purge(request: ArchivedContentDeletionRequest): Promise<ArchivedContentDeletionResult> {
    return this.purgeWithProjects(request).then(({ result }) => result);
  }

  purgeWithProjects(request: ArchivedContentDeletionRequest): Promise<ArchivePurgeOutcome> {
    const input = validateRequest(request);
    const operation = this.queue.then(() => this.execute(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async execute(request: ArchivedContentDeletionRequest): Promise<ArchivePurgeOutcome> {
    const { db, lifecycle } = this.options;
    const result: ArchivedContentDeletionResult = { deletedTaskIds: [], deletedSpaceIds: [], failures: [] };
    const projectIds = new Set<string>();
    const fail = (kind: "task" | "space", id: string, error: unknown) => {
      result.failures.push({ kind, id, error: error instanceof Error ? error.message : String(error) });
    };
    const selectedRoots = new Set<string>();
    const selectedSpaces = new Set<string>();
    const selectedSubtrees = new Map<string, Set<string>>();
    const spaces = await db.readSpaces();
    const spacesById = new Map(spaces.map(space => [space.id, space]));
    const children = new Map<string, string[]>();
    for (const space of spaces) {
      if (space.parentId) children.set(space.parentId, [...(children.get(space.parentId) ?? []), space.id]);
    }
    for (const id of request.spaceIds) {
      const space = spacesById.get(id);
      if (!space) { fail("space", id, "空间不存在，请刷新归档列表"); continue; }
      if (!space.effectiveArchived) { fail("space", id, "空间已恢复，拒绝彻底删除未归档空间"); continue; }
      selectedRoots.add(id);
      const pending = [id];
      const visited = new Set<string>();
      while (pending.length) {
        const child = pending.pop()!;
        if (visited.has(child)) continue;
        visited.add(child);
        selectedSpaces.add(child);
        pending.push(...(children.get(child) ?? []));
      }
      selectedSubtrees.set(id, visited);
    }
    // A tree with owned documents is protected as a whole. Decide this before trashing
    // any task or deleting any Gadget, so a rejected workspace purge cannot lose its children.
    const protectedSpaces = new Set<string>();
    const materialFailures = new Set<string>();
    const spacesWithMaterials = new Set<string>();
    for (const id of selectedSpaces) {
      const hasMaterials = db.coreIdentity
        ? (await db.readSpaceDeleteStatus(id)).hasOwnedMaterials
        : db.hasWorkspaceOwnedMaterials(id);
      if (hasMaterials) spacesWithMaterials.add(id);
    }
    for (const [id, subtree] of selectedSubtrees) {
      if (![...subtree].some((spaceId) => spacesWithMaterials.has(spaceId))) continue;
      fail("space", id, "工作空间或其子空间仍有自有资料，请先迁移或清空资料后再彻底删除");
      materialFailures.add(id);
      for (const spaceId of subtree) protectedSpaces.add(spaceId);
    }
    for (const id of selectedRoots) {
      if (!protectedSpaces.has(id)) continue;
      selectedRoots.delete(id);
      if (!materialFailures.has(id)) fail("space", id, "所属工作空间树仍有自有资料，本次保留整棵工作空间树");
    }
    for (const id of protectedSpaces) selectedSpaces.delete(id);
    const directTasks = new Set<string>();
    for (const id of request.taskIds) {
      const task = await db.readTask(id, { includeExpertBinding: false });
      if (!task) { fail("task", id, "任务不存在，请刷新归档列表"); continue; }
      const workspaceArchived = task.spaceId && spacesById.get(task.spaceId)?.effectiveArchived;
      if (!task.archived && !workspaceArchived) { fail("task", id, "任务已恢复，拒绝彻底删除未归档任务"); continue; }
      directTasks.add(id);
    }
    // Include trashed rows so a deleted space leaves no restorable tasks behind.
    const tasks = await db.readArchivedTaskCandidates([...directTasks], [...selectedSpaces]);
    const archiveRootIds = [...selectedRoots];
    const isInSelectedArchivedTree = (spaceId: string | null | undefined, liveSpacesById = spacesById) => {
      const visited = new Set<string>();
      for (let current = spaceId ?? undefined; current && !visited.has(current); current = liveSpacesById.get(current)?.parentId ?? undefined) {
        visited.add(current);
        if (selectedRoots.has(current) && liveSpacesById.get(current)?.effectiveArchived) return true;
      }
      return false;
    };
    const branchSessionFiles = await db.readConversationBranchSessionFiles();
    for (const task of tasks) {
      const wasTrashed = (await db.readTaskExecutionWorkspaceState(task.id))?.state === "trashed";
      // A surviving branch owns its source; once its final child is also purged the source can be cleaned.
      const branchSources = branchSessionFiles.filter((branch) => branch.childTaskId === task.id);
      const sessionFiles = [...new Set([task.sessionFile, ...branchSources.map((branch) => branch.sourceSessionFile)].filter(Boolean) as string[])];
      const checkAllowed = async () => {
        const current = await db.readTask(task.id, { includeExpertBinding: false });
        if (!current) throw new Error("任务已不存在");
        const directStillArchived = directTasks.has(task.id) && (
          (task.archived === true && current.archived === true) ||
          Boolean(current.spaceId && await db.isSpaceEffectiveArchivedAsync(current.spaceId))
        );
        if (!directStillArchived && !isInSelectedArchivedTree(current.spaceId)) {
          throw new Error("任务或所属空间已恢复，已停止彻底删除");
        }
      };
      const assertAllowed = () => {
        const current = db.getTask(task.id);
        if (!current) throw new Error("任务已不存在");
        // trash itself sets archived=true. An inherited-only selection must still have an archived ancestor.
        const directStillArchived = directTasks.has(task.id) && (
          (task.archived === true && current.archived === true) ||
          Boolean(current.spaceId && db.isSpaceEffectiveArchived(current.spaceId))
        );
        if (!directStillArchived && !db.isInArchivedWorkspaceSelection(current.spaceId, selectedRoots)) {
          throw new Error("任务或所属空间已恢复，已停止彻底删除");
        }
      };
      try {
        if (db.coreIdentity) await checkAllowed();
        else assertAllowed();
        // Re-run shutdown even for existing trash entries; a stale runtime may still own that task.
        await lifecycle.trash(task.id, { strict: true, assertAllowed: db.coreIdentity ? undefined : assertAllowed });
        await lifecycle.purge(task.id, {
          force: true, strict: true, assertAllowed: db.coreIdentity ? undefined : assertAllowed,
          archiveScope: {
            direct: directTasks.has(task.id) ? (task.archived === true ? "explicit" : "inherited") : "none",
            selectedRoots: archiveRootIds,
          },
        });
        if (await db.readTask(task.id, { includeExpertBinding: false }) || await db.readTaskExecutionWorkspaceState(task.id)) throw new Error("任务永久删除后校验失败");
      } catch (error) {
        const currentTask = await db.readTask(task.id, { includeExpertBinding: false });
        fail("task", task.id, !currentTask ? `任务已删除，附属内容清理失败：${error instanceof Error ? error.message : String(error)}` : error);
        // Failed explicit purge must remain available for retry after an app restart.
        // Previously trashed tasks keep their original lifecycle; never override a concurrent restore.
        if (!wasTrashed && currentTask && (await db.readTaskExecutionWorkspaceState(task.id))?.state === "trashed") {
          try {
            await lifecycle.restoreFromTrash(task.id);
            if (task.cwd) await db.bindTaskExecutionWorkspaceCwdAsync(task.id, task.cwd);
            if (task.archived) await lifecycle.writeArchive(task.id, true);
          } catch (recoveryError) {
            fail("task", task.id, `恢复归档以便重试失败：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
          }
        }
      }
      // Post-DB cleanup failures must not resurrect a task in the renderer.
      if (!(await db.readTask(task.id, { includeExpertBinding: false })) && !(await db.readTaskExecutionWorkspaceState(task.id))) {
        result.deletedTaskIds.push(task.id);
        if (task.projectId) projectIds.add(task.projectId);
        try { await this.options.afterDeleteTask?.(task, sessionFiles); }
        catch (error) { fail("task", task.id, `任务已删除，附属内容清理失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const depth = (id: string): number => {
      let count = 0;
      const seen = new Set<string>();
      for (let current: string | null | undefined = id; current && !seen.has(current); current = spacesById.get(current)?.parentId) {
        seen.add(current); count += 1;
      }
      return count;
    };
    for (const id of [...selectedSpaces].sort((a, b) => depth(b) - depth(a))) {
      const assertEmptyArchived = async () => {
        const currentSpaces = new Map((await db.readSpaces()).map((s) => [s.id, s]));
        const delStatus = await db.readSpaceDeleteStatus(id);
        if (!delStatus.exists || !isInSelectedArchivedTree(id, currentSpaces)) throw new Error("空间已恢复或移动，已停止彻底删除");
        if (delStatus.hasBlockersTasks || delStatus.hasTasks) {
          throw new Error("空间仍有未删除的任务、子空间或自有资料，请处理失败项后重试");
        }
      };
      try {
        await assertEmptyArchived();
        await this.options.beforeDeleteSpace?.(id);
        await assertEmptyArchived();
        await db.writeWorkspaceDelete(id, selectedRoots);
        if (await db.readSpace(id)) throw new Error("空间永久删除后校验失败");
        await this.options.afterDeleteSpace?.(id);
      } catch (error) { fail("space", id, error); }
      if (!(await db.readSpace(id))) result.deletedSpaceIds.push(id);
    }
    return { result, projectIds: [...projectIds] };
  }
}

function validateRequest(request: ArchivedContentDeletionRequest): ArchivedContentDeletionRequest {
  if (!request || typeof request !== "object" || !Array.isArray(request.spaceIds) || !Array.isArray(request.taskIds)) {
    throw new Error("归档删除请求必须包含 spaceIds 和 taskIds 数组");
  }
  const ids = (values: unknown[]): string[] => {
    if (values.some((id) => typeof id !== "string" || !id.trim())) throw new Error("归档删除 ID 必须是非空字符串");
    return [...new Set(values as string[])];
  };
  return { spaceIds: ids(request.spaceIds), taskIds: ids(request.taskIds) };
}

/** Remove only Pi-owned JSONL history; linked user files and shared branch sources remain intact. */
export async function removeManagedTaskSession(db: AppDatabase, task: Pick<TaskDto, "id" | "sessionFile">, sessionsRoot: string): Promise<void> {
  if (!task.sessionFile || extname(task.sessionFile).toLowerCase() !== ".jsonl") return;
  const file = resolve(task.sessionFile);
  const root = resolve(sessionsRoot);
  if (!isPathInsideOrEqual(root, file) || file === root || !existsSync(file)) return;
  if (!existsSync(root) || !isPathInsideOrEqual(realpathSync.native(root), realpathSync.native(file))) return;
  const samePath = (candidate?: string) => Boolean(candidate && normalizePathForComparison(candidate) === normalizePathForComparison(file));
  if (db.coreIdentity) {
    const tasks = await db.readNonTrashedTasks({ includeExpertBindings: false });
    if (tasks.some((other) => samePath(other.sessionFile))) return;
    const branches = await db.readConversationBranchSessionFiles();
    if (branches.some((branch) => samePath(branch.sourceSessionFile))) return;
  } else {
    if (db.listTasks().some((other) => samePath(other.sessionFile))) return;
    const branches = db.connection.prepare("SELECT source_session_file FROM conversation_branches").all() as Array<{ source_session_file: string }>;
    if (branches.some((branch) => samePath(branch.source_session_file))) return;
  }
  rmSync(file, { force: true });
}

/** Artifact metadata deletion commits first; locked managed files are a post-delete warning. */
export function artifactPurgeCleanupWarning(result?: { removed: number; orphaned: number }): string | undefined {
  return result?.orphaned
    ? `有 ${result.orphaned} 个产物文件未能清理（可能正在被占用），下次启动时将重试清理`
    : undefined;
}
