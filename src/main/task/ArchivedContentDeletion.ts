import { existsSync, realpathSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { TaskDto } from "../../shared/agent-ipc";
import type { ArchivedContentDeletionRequest, ArchivedContentDeletionResult } from "../../shared/archive-deletion";
import type { AppDatabase } from "../db/AppDatabase";
import { isPathInsideOrEqual, normalizePathForComparison } from "./TaskExecutionWorkspace";
import type { TaskExecutionWorkspaceLifecycle } from "./TaskExecutionWorkspaceLifecycle";

interface ArchivedContentDeletionOptions {
  db: AppDatabase;
  lifecycle: TaskExecutionWorkspaceLifecycle;
  /** Reversible preparation only. Irreversible cleanup belongs in afterDeleteSpace. */
  beforeDeleteSpace?: (spaceId: string) => void | Promise<void>;
  afterDeleteSpace?: (spaceId: string) => void | Promise<void>;
  afterDeleteTask?: (task: TaskDto, sessionFiles: string[]) => void | Promise<void>;
}

/** Archive management's explicit hard delete, serialized to avoid duplicate purge races. */
export class ArchivedContentDeletion {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ArchivedContentDeletionOptions) {}

  purge(request: ArchivedContentDeletionRequest): Promise<ArchivedContentDeletionResult> {
    const input = validateRequest(request);
    const operation = this.queue.then(() => this.execute(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async execute(request: ArchivedContentDeletionRequest): Promise<ArchivedContentDeletionResult> {
    const { db, lifecycle } = this.options;
    const result: ArchivedContentDeletionResult = { deletedTaskIds: [], deletedSpaceIds: [], failures: [] };
    const fail = (kind: "task" | "space", id: string, error: unknown) => {
      result.failures.push({ kind, id, error: error instanceof Error ? error.message : String(error) });
    };
    const selectedRoots = new Set<string>();
    const selectedSpaces = new Set<string>();
    const selectedSubtrees = new Map<string, Set<string>>();
    const spaces = db.listSpaces();
    const children = new Map<string, string[]>();
    for (const space of spaces) {
      if (space.parentId) children.set(space.parentId, [...(children.get(space.parentId) ?? []), space.id]);
    }
    for (const id of request.spaceIds) {
      if (!db.getSpace(id)) { fail("space", id, "空间不存在，请刷新归档列表"); continue; }
      if (!db.isSpaceEffectiveArchived(id)) { fail("space", id, "空间已恢复，拒绝彻底删除未归档空间"); continue; }
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
    const spacesWithMaterials = new Set([...selectedSpaces].filter((id) => db.hasWorkspaceOwnedMaterials(id)));
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
      if (!db.getTask(id)) { fail("task", id, "任务不存在，请刷新归档列表"); continue; }
      if (!db.isTaskEffectiveArchived(id)) { fail("task", id, "任务已恢复，拒绝彻底删除未归档任务"); continue; }
      directTasks.add(id);
    }
    // listTasks deliberately includes trashed rows: a deleted space must leave no restorable tasks behind.
    const tasks = db.listTasks().filter((task) => directTasks.has(task.id) || Boolean(task.spaceId && selectedSpaces.has(task.spaceId)));
    const isInSelectedArchivedTree = (spaceId: string | null | undefined): boolean => {
      const visited = new Set<string>();
      let current = spaceId;
      while (current && !visited.has(current)) {
        visited.add(current);
        if (selectedRoots.has(current) && db.isSpaceEffectiveArchived(current)) return true;
        current = db.getSpace(current)?.parentId ?? undefined;
      }
      return false;
    };
    for (const task of tasks) {
      const wasTrashed = db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed";
      // A surviving branch owns its source; once its final child is also purged the source can be cleaned.
      const branchSources = db.connection.prepare("SELECT source_session_file FROM conversation_branches WHERE child_task_id=?").all(task.id) as Array<{ source_session_file: string }>;
      const sessionFiles = [...new Set([task.sessionFile, ...branchSources.map((branch) => branch.source_session_file)].filter(Boolean) as string[])];
      const assertAllowed = () => {
        const current = db.getTask(task.id);
        if (!current) throw new Error("任务已不存在");
        // trash itself sets archived=true. An inherited-only selection must still have an archived ancestor.
        const directStillArchived = directTasks.has(task.id) && (
          (task.archived === true && current.archived === true) ||
          Boolean(current.spaceId && db.isSpaceEffectiveArchived(current.spaceId))
        );
        if (!directStillArchived && !isInSelectedArchivedTree(current.spaceId)) {
          throw new Error("任务或所属空间已恢复，已停止彻底删除");
        }
      };
      try {
        assertAllowed();
        // Re-run shutdown even for existing trash entries; a stale runtime may still own that task.
        await lifecycle.trash(task.id, { strict: true, assertAllowed });
        await lifecycle.purge(task.id, { force: true, strict: true, assertAllowed });
        if (db.getTask(task.id) || db.getTaskExecutionWorkspaceState(task.id)) throw new Error("任务永久删除后校验失败");
      } catch (error) {
        fail("task", task.id, !db.getTask(task.id) ? `任务已删除，附属内容清理失败：${error instanceof Error ? error.message : String(error)}` : error);
        // Failed explicit purge must remain available for retry after an app restart.
        // Previously trashed tasks keep their original lifecycle; never override a concurrent restore.
        if (!wasTrashed && db.getTask(task.id) && db.getTaskExecutionWorkspaceState(task.id)?.state === "trashed") {
          try {
            lifecycle.restore(task.id);
            if (task.cwd) db.bindTaskExecutionWorkspaceCwd(task.id, task.cwd);
            if (task.archived) lifecycle.archive(task.id);
          } catch (recoveryError) {
            fail("task", task.id, `恢复归档以便重试失败：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
          }
        }
      }
      // Post-DB cleanup failures must not resurrect a task in the renderer.
      if (!db.getTask(task.id) && !db.getTaskExecutionWorkspaceState(task.id)) {
        result.deletedTaskIds.push(task.id);
        try { await this.options.afterDeleteTask?.(task, sessionFiles); }
        catch (error) { fail("task", task.id, `任务已删除，附属内容清理失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const byId = new Map(spaces.map((space) => [space.id, space]));
    const depth = (id: string): number => {
      let count = 0;
      const seen = new Set<string>();
      for (let current: string | null | undefined = id; current && !seen.has(current); current = byId.get(current)?.parentId) {
        seen.add(current); count += 1;
      }
      return count;
    };
    for (const id of [...selectedSpaces].sort((a, b) => depth(b) - depth(a))) {
      const assertEmptyArchived = () => {
        if (!db.getSpace(id) || !isInSelectedArchivedTree(id)) throw new Error("空间已恢复或移动，已停止彻底删除");
        if (db.hasSpaceDeleteBlockers(id) || db.listTasks().some((task) => task.spaceId === id)) {
          throw new Error("空间仍有未删除的任务、子空间或自有资料，请处理失败项后重试");
        }
      };
      try {
        assertEmptyArchived();
        await this.options.beforeDeleteSpace?.(id);
        assertEmptyArchived();
        db.deleteSpace(id);
        if (db.getSpace(id)) throw new Error("空间永久删除后校验失败");
        await this.options.afterDeleteSpace?.(id);
      } catch (error) { fail("space", id, error); }
      if (!db.getSpace(id)) result.deletedSpaceIds.push(id);
    }
    return result;
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
export function removeManagedTaskSession(db: AppDatabase, task: TaskDto, sessionsRoot: string): void {
  if (!task.sessionFile || extname(task.sessionFile).toLowerCase() !== ".jsonl") return;
  const file = resolve(task.sessionFile);
  const root = resolve(sessionsRoot);
  if (!isPathInsideOrEqual(root, file) || file === root || !existsSync(file)) return;
  if (!existsSync(root) || !isPathInsideOrEqual(realpathSync.native(root), realpathSync.native(file))) return;
  const samePath = (candidate?: string) => Boolean(candidate && normalizePathForComparison(candidate) === normalizePathForComparison(file));
  if (db.listTasks().some((other) => samePath(other.sessionFile))) return;
  const branches = db.connection.prepare("SELECT source_session_file FROM conversation_branches").all() as Array<{ source_session_file: string }>;
  if (branches.some((branch) => samePath(branch.source_session_file))) return;
  rmSync(file, { force: true });
}

/** Artifact metadata deletion commits first; locked managed files are a post-delete warning. */
export function artifactPurgeCleanupWarning(result?: { removed: number; orphaned: number }): string | undefined {
  return result?.orphaned
    ? `有 ${result.orphaned} 个产物文件未能清理（可能正在被占用），下次启动时将重试清理`
    : undefined;
}
