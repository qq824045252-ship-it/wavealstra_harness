import type { LibrarySpaceDto } from "../../shared/library-ipc";
import { computeEffectiveArchived } from "../../shared/workspace-tree";
import type {
  WorkspaceLibraryBindingInheritedItem,
  WorkspaceLibraryBindingItem,
  WorkspaceLibraryBindingListView,
} from "../../shared/workspace-library-binding";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryService } from "../library/LibraryService";
import type { WorkspaceLibraryBindingService } from "./WorkspaceLibraryBindingService";

export interface RuntimeWorkspaceBindingSnapshot {
  workspaces: Array<{ id: string; name: string; parentId?: string | null; archived?: boolean }>;
  spaces: Array<Pick<LibrarySpaceDto, "id" | "name" | "kind" | "projectId" | "projectName" | "workspaceId"> & { projectArchived: boolean }>;
  collections: Array<{ id: string; spaceId: string; parentId?: string | null; name: string }>;
  references: Array<{ workspaceId: string; librarySpaceId: string; collectionId: string | null }>;
  ownedItemCount: number;
}

export async function readWorkspaceLibraryBindingView(
  db: AppDatabase,
  library: LibraryService,
  bindings: WorkspaceLibraryBindingService,
  workspaceId: string,
): Promise<WorkspaceLibraryBindingListView> {
  const id = workspaceId?.trim();
  if (!id) throw new Error("工作空间不存在");
  const snapshot = await db.runtimeAuditReader?.workspaceBindingSnapshot(id);
  if (snapshot === null) throw new Error("工作空间不存在");
  return snapshot ? renderWorkspaceLibraryBindingView(id, snapshot) : workspaceLibraryBindingView(db, library, bindings, id);
}

/** The UI describes ownership separately from references; neither creates a second copy. */
export function workspaceLibraryBindingView(
  db: AppDatabase,
  library: LibraryService,
  bindings: WorkspaceLibraryBindingService,
  workspaceId: string,
): WorkspaceLibraryBindingListView {
  const ws = workspaceId?.trim();
  return db.connection.transaction(() => {
    const workspaces = db.listSpaces();
    if (!ws || !workspaces.some(space => space.id === ws)) throw new Error("工作空间不存在");
    const references = [ws, ...db.getSpaceAncestors(ws).map(space => space.id)].flatMap(workspaceId => {
      const targets = bindings.listTargetsByWorkspace(workspaceId);
      return [
        ...targets.librarySpaceIds.map(librarySpaceId => ({ workspaceId, librarySpaceId, collectionId: null })),
        ...targets.collections.map(target => ({ workspaceId, ...target })),
      ];
    });
    const ownedItemCount = (db.connection.prepare(`SELECT count(*) AS count FROM library_items i
      JOIN library_spaces s ON s.id=i.space_id WHERE s.workspace_id=? AND i.trashed_at IS NULL`).get(ws) as { count: number }).count;
    return renderWorkspaceLibraryBindingView(ws, {
      workspaces, references, ownedItemCount, collections: library.listCollections(),
      spaces: library.listSpaces().map(space => ({ ...space, projectArchived: Boolean(space.projectId && library.isProjectArchived(space.projectId)) })),
    });
  })();
}

function renderWorkspaceLibraryBindingView(ws: string, snapshot: RuntimeWorkspaceBindingSnapshot): WorkspaceLibraryBindingListView {
  const { workspaces, spaces, collections, references, ownedItemCount } = snapshot;
  const workspaceById = new Map(workspaces.map((space) => [space.id, space]));
  const current = workspaceById.get(ws);
  if (!current) throw new Error("工作空间不存在");
  const archived = computeEffectiveArchived(workspaces.map(space => ({ ...space, parentId: space.parentId ?? null, archived: Boolean(space.archived) })));

  const byId = new Map(spaces.map((space) => [space.id, space]));
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const spacePath = (space: RuntimeWorkspaceBindingSnapshot["spaces"][number]): string => {
    if (space.projectId) return `项目资料 / ${space.projectName ?? space.name}`;
    if (space.workspaceId) return `工作空间 / ${workspaceById.get(space.workspaceId)?.name ?? space.name} / 资料`;
    return space.kind === "personal" ? "历史资料（兼容旧版本）" : `历史资料 / ${space.name}`;
  };
  const spaceItem = (id: string): WorkspaceLibraryBindingItem | null => {
    const space = byId.get(id);
    if (!space) return null;
    return {
      targetType: "space", librarySpaceId: id, name: space.name, path: spacePath(space),
      kind: space.kind, projectId: space.projectId, workspaceId: space.workspaceId,
    };
  };
  const collectionItem = (spaceId: string, id: string): WorkspaceLibraryBindingItem | null => {
    const root = collectionById.get(id);
    const base = spaceItem(spaceId);
    if (!base || !root || root.spaceId !== spaceId) return null;
    const parts: string[] = [];
    const seen = new Set<string>();
    let cursor: typeof root | undefined = root;
    while (cursor && cursor.spaceId === spaceId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parts.unshift(cursor.name);
      cursor = cursor.parentId ? collectionById.get(cursor.parentId) : undefined;
    }
    return { ...base, targetType: "collection", collectionId: id, name: root.name, path: `${base.path} / ${parts.join(" / ")}` };
  };
  const present = (item: WorkspaceLibraryBindingItem | null): item is WorkspaceLibraryBindingItem => item !== null;
  const keyOf = (item: WorkspaceLibraryBindingItem): string => item.collectionId ? `collection:${item.collectionId}` : `space:${item.librarySpaceId}`;
  const referencesByWorkspace = new Map<string, WorkspaceLibraryBindingItem[]>();
  for (const reference of references) {
    const item = reference.collectionId ? collectionItem(reference.librarySpaceId, reference.collectionId) : spaceItem(reference.librarySpaceId);
    if (!item) continue;
    const items = referencesByWorkspace.get(reference.workspaceId) ?? [];
    items.push(item);
    referencesByWorkspace.set(reference.workspaceId, items);
  }

  const owned = spaces.filter((space) => space.workspaceId === ws).map((space) => spaceItem(space.id)).filter(present);
  const ownedIds = new Set(owned.map((item) => item.librarySpaceId));
  const direct = (referencesByWorkspace.get(ws) ?? []).filter((item) => !ownedIds.has(item.librarySpaceId));
  const coveredKeys = new Set([...owned, ...direct].map(keyOf));
  const inherited: WorkspaceLibraryBindingInheritedItem[] = [];
  const visited = new Set<string>();
  for (let id = current.parentId; id && !visited.has(id);) {
    visited.add(id);
    const ancestor = workspaceById.get(id);
    if (!ancestor) break;
    id = ancestor.parentId;
    if (archived.get(ancestor.id)) continue;
    const ownSources = spaces.filter((space) => space.workspaceId === ancestor.id).map((space) => spaceItem(space.id)).filter(present);
    for (const item of [...ownSources, ...(referencesByWorkspace.get(ancestor.id) ?? [])]) {
      const key = keyOf(item);
      if (coveredKeys.has(key) || ownedIds.has(item.librarySpaceId)) continue;
      coveredKeys.add(key);
      inherited.push({ ...item, sourceWorkspaceId: ancestor.id, sourceWorkspaceName: ancestor.name });
    }
  }

  const coveredWholeSpaces = new Set<string>();
  const coveredCollections = new Set<string>();
  const children = new Map<string, typeof collections>();
  for (const collection of collections) {
    if (!collection.parentId) continue;
    const siblings = children.get(collection.parentId) ?? [];
    siblings.push(collection);
    children.set(collection.parentId, siblings);
  }
  for (const item of [...owned, ...direct, ...inherited]) {
    if (item.targetType === "space") coveredWholeSpaces.add(item.librarySpaceId);
    else if (item.collectionId) {
      const pending = [item.collectionId];
      while (pending.length) {
        const id = pending.pop()!;
        if (coveredCollections.has(id)) continue;
        coveredCollections.add(id);
        for (const child of children.get(id) ?? []) if (child.spaceId === item.librarySpaceId) pending.push(child.id);
      }
    }
  }
  const referenceableIds = new Set(spaces.filter(space => !space.projectArchived &&
    (!space.workspaceId || (workspaceById.has(space.workspaceId) && !archived.get(space.workspaceId)))).map(space => space.id));
  const addable = [
    ...spaces.filter((space) => referenceableIds.has(space.id) && !coveredWholeSpaces.has(space.id)).map((space) => spaceItem(space.id)),
    ...collections.filter((collection) => referenceableIds.has(collection.spaceId) && !coveredWholeSpaces.has(collection.spaceId) && !coveredCollections.has(collection.id))
      .map((collection) => collectionItem(collection.spaceId, collection.id)),
  ].filter(present).filter((item) => !coveredKeys.has(keyOf(item)));

  return {
    workspaceId: ws,
    workspaceName: current.name,
    owned,
    ownedItemCount,
    direct,
    inherited,
    addable,
    destinations: owned.map((item) => ({ id: item.librarySpaceId, name: item.name })),
  };
}
