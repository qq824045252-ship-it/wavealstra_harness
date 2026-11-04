import type { LibraryItemDto, LibraryOwnerScope, LibrarySpaceDto } from "../../shared/library-ipc";
import type { AppDatabase } from "../db/AppDatabase";
import { WorkspaceLibraryBindingService } from "../workspace/WorkspaceLibraryBindingService";
import type { LibraryRepository } from "./LibraryRepository";
import type { LibraryQueryScope } from "./library-query-scope";

export interface LibraryTaskScopeOptions {
  /** 无任务的工作空间预览/调试入口；不能覆盖真实任务归属。 */
  workspaceFallback?: string | null;
  /** 临时读取当前工作空间的直属子节点；不递归，不授予写入权。 */
  additionalWorkspaceIds?: readonly string[];
}

export interface LibraryTaskScope {
  taskId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  workspaceIds: ReadonlySet<string>;
  /** 允许查看名称/位置的容器，包括只共享了单条资料或文件夹的容器；不能用于全文检索。 */
  visibleSpaceIds: ReadonlySet<string>;
  /** 以下三个白名单的并集才是资料读取范围。 */
  readableSpaceIds: ReadonlySet<string>;
  readableCollectionIds: ReadonlySet<string>;
  readableItemIds: ReadonlySet<string>;
  writableSpaceIds: ReadonlySet<string>;
  defaultOwner: LibraryOwnerScope | null;
}

export function queryScopeForTask(scope: LibraryTaskScope): LibraryQueryScope {
  return {
    spaceIds: scope.readableSpaceIds,
    collectionIds: scope.readableCollectionIds,
    itemIds: scope.readableItemIds,
  };
}

/** 引用可以共享个人/工作空间资料，但永远不能跨项目授权。 */
export function isLibrarySpacePermittedForProject(space: LibrarySpaceDto, projectId: string | null): boolean {
  if (space.projectId && space.workspaceId) return false;
  if (space.kind === "personal" && (space.projectId || space.workspaceId)) return false;
  return !space.projectId || space.projectId === projectId;
}

export function itemVisibleInTaskScope(item: LibraryItemDto, scope: LibraryTaskScope): boolean {
  return scope.visibleSpaceIds.has(item.spaceId) && (
    scope.readableSpaceIds.has(item.spaceId)
    || Boolean(item.collectionId && scope.readableCollectionIds.has(item.collectionId))
    || scope.readableItemIds.has(item.id)
  );
}

/** 单一任务资料作用域：归属 + 工作空间继承/绑定 + 精确引用；不修改任何资料或关联。 */
export function resolveLibraryTaskScope(
  db: AppDatabase,
  repo: LibraryRepository,
  taskId?: string | null,
  projectFallback?: string | null,
  options: LibraryTaskScopeOptions = {},
): LibraryTaskScope {
  const resolvedTaskId = taskId?.trim() || null;
  const task = resolvedTaskId ? db.getTask(resolvedTaskId) : undefined;
  const projectId = resolvedTaskId ? task?.projectId ?? null : projectFallback?.trim() || null;
  const workspaceId = resolvedTaskId ? task?.spaceId ?? null : options.workspaceFallback?.trim() || null;
  const workspaceIds = new Set<string>();
  const visibleSpaceIds = new Set<string>();
  const readableSpaceIds = new Set<string>();
  const readableCollectionIds = new Set<string>();
  const readableItemIds = new Set<string>();
  const writableSpaceIds = new Set<string>();
  const scope: LibraryTaskScope = {
    taskId: resolvedTaskId, projectId, workspaceId, workspaceIds, visibleSpaceIds,
    readableSpaceIds, readableCollectionIds, readableItemIds, writableSpaceIds, defaultOwner: null,
  };

  // 失效的任务或归属不能降级为个人资料，也不能借 fallback 升权。
  if (resolvedTaskId && !task) return scope;
  const project = projectId
    ? db.connection.prepare("SELECT archived FROM projects WHERE id = ?").get(projectId) as { archived: number } | undefined
    : undefined;
  const workspace = workspaceId ? db.getSpace(workspaceId) : undefined;
  if ((projectId && !project) || (workspaceId && !workspace)) return scope;
  // 独立任务为临时任务，不默认拥有或读取任何持久资料位置。
  scope.defaultOwner = projectId ? { type: "project", projectId }
    : workspaceId ? { type: "workspace", workspaceId } : null;

  if (workspace && !db.isSpaceEffectiveArchived(workspace.id)) {
    workspaceIds.add(workspace.id);
    for (const ancestor of db.getSpaceAncestors(workspace.id)) {
      if (!db.isSpaceEffectiveArchived(ancestor.id)) workspaceIds.add(ancestor.id);
    }
    for (const id of options.additionalWorkspaceIds ?? []) {
      const child = db.getSpace(id);
      if (child?.parentId === workspace.id && !db.isSpaceEffectiveArchived(child.id)) workspaceIds.add(child.id);
    }
  }

  const spaces = repo.listSpaces();
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const allowed = (space: LibrarySpaceDto | undefined): space is LibrarySpaceDto => Boolean(
    space && isLibrarySpacePermittedForProject(space, projectId) && (!space.workspaceId || db.getSpace(space.workspaceId)),
  );
  const addSpace = (space: LibrarySpaceDto) => {
    readableSpaceIds.add(space.id);
    visibleSpaceIds.add(space.id);
  };
  for (const space of spaces) {
    if (!allowed(space)) continue;
    if (space.projectId && space.projectId === projectId) {
      addSpace(space);
      if (!project?.archived) writableSpaceIds.add(space.id);
    } else if (space.workspaceId && workspaceIds.has(space.workspaceId)) {
      addSpace(space);
      if (space.workspaceId === workspaceId && !project?.archived) writableSpaceIds.add(space.id);
    }
  }

  const bindings = new WorkspaceLibraryBindingService(db).resolveTargets(workspaceIds);
  // 归档工作空间不自动继承；已经显式共享的历史资料仍可回看，但这些来源从不授予写入权。
  for (const id of bindings.librarySpaceIds) {
    const space = byId.get(id);
    if (allowed(space)) addSpace(space);
  }
  for (const target of bindings.collections) {
    const space = byId.get(target.librarySpaceId);
    const root = repo.getCollection(target.collectionId);
    if (!allowed(space) || !root || root.spaceId !== space.id || readableSpaceIds.has(space.id)) continue;
    visibleSpaceIds.add(space.id);
    // 独立 visited-set 保证损坏的集合树也不会递归失控。
    const queue = [root.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (readableCollectionIds.has(id)) continue;
      readableCollectionIds.add(id);
      for (const child of repo.listCollections(space.id, id)) queue.push(child.id);
    }
  }

  const addItem = (itemId: string) => {
    const item = repo.getItem(itemId);
    const space = item ? byId.get(item.spaceId) : undefined;
    if (!item || !allowed(space)) return;
    readableItemIds.add(item.id);
    visibleSpaceIds.add(space.id);
  };
  if (resolvedTaskId) for (const ref of repo.listReferencesByTask(resolvedTaskId)) addItem(ref.itemId);
  if (projectId) {
    const pins = db.connection.prepare("SELECT item_id FROM project_context_pins WHERE project_id = ?")
      .all(projectId) as Array<{ item_id: string }>;
    for (const pin of pins) addItem(pin.item_id);
  }
  return scope;
}
