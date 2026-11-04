import type { LibrarySpaceDto } from "../../shared/library-ipc";
import type {
  WorkspaceLibraryBindingInheritedItem,
  WorkspaceLibraryBindingItem,
  WorkspaceLibraryBindingListView,
} from "../../shared/workspace-library-binding";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryService } from "../library/LibraryService";
import type { WorkspaceLibraryBindingService } from "./WorkspaceLibraryBindingService";

/** The UI describes ownership separately from references; neither creates a second copy. */
export function workspaceLibraryBindingView(
  db: AppDatabase,
  library: LibraryService,
  bindings: WorkspaceLibraryBindingService,
  workspaceId: string,
): WorkspaceLibraryBindingListView {
  const ws = workspaceId?.trim();
  const workspaces = db.listSpaces();
  const workspaceById = new Map(workspaces.map((space) => [space.id, space]));
  const current = ws ? workspaceById.get(ws) : undefined;
  if (!current) throw new Error("工作空间不存在");

  const spaces = library.listSpaces();
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const collections = library.listCollections();
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const spacePath = (space: LibrarySpaceDto): string => {
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
  const referencesFor = (id: string): WorkspaceLibraryBindingItem[] => {
    const targets = bindings.listTargetsByWorkspace(id);
    return [
      ...targets.librarySpaceIds.map(spaceItem),
      ...targets.collections.map((target) => collectionItem(target.librarySpaceId, target.collectionId)),
    ].filter(present);
  };

  const owned = spaces.filter((space) => space.workspaceId === ws).map((space) => spaceItem(space.id)).filter(present);
  const ownedIds = new Set(owned.map((item) => item.librarySpaceId));
  const direct = referencesFor(ws).filter((item) => !ownedIds.has(item.librarySpaceId));
  const coveredKeys = new Set([...owned, ...direct].map(keyOf));
  const inherited: WorkspaceLibraryBindingInheritedItem[] = [];
  for (const ancestor of db.getSpaceAncestors(ws)) {
    if (ancestor.archived || ancestor.effectiveArchived) continue;
    const ownSources = spaces.filter((space) => space.workspaceId === ancestor.id).map((space) => spaceItem(space.id)).filter(present);
    for (const item of [...ownSources, ...referencesFor(ancestor.id)]) {
      const key = keyOf(item);
      if (coveredKeys.has(key) || ownedIds.has(item.librarySpaceId)) continue;
      coveredKeys.add(key);
      inherited.push({ ...item, sourceWorkspaceId: ancestor.id, sourceWorkspaceName: ancestor.name });
    }
  }

  const coveredWholeSpaces = new Set<string>();
  const coveredCollections = new Set<string>();
  for (const item of [...owned, ...direct, ...inherited]) {
    if (item.targetType === "space") coveredWholeSpaces.add(item.librarySpaceId);
    else if (item.collectionId) {
      for (const id of library.listCollectionSubtreeIds(item.collectionId)) coveredCollections.add(id);
    }
  }
  const canReference = (space: LibrarySpaceDto): boolean => {
    if (space.projectId && library.isProjectArchived(space.projectId)) return false;
    if (space.workspaceId) {
      const owner = workspaceById.get(space.workspaceId);
      if (!owner || owner.archived || owner.effectiveArchived) return false;
    }
    return true;
  };
  const referenceableIds = new Set(spaces.filter(canReference).map((space) => space.id));
  const addable = [
    ...spaces.filter((space) => referenceableIds.has(space.id) && !coveredWholeSpaces.has(space.id)).map((space) => spaceItem(space.id)),
    ...collections.filter((collection) => referenceableIds.has(collection.spaceId) && !coveredWholeSpaces.has(collection.spaceId) && !coveredCollections.has(collection.id))
      .map((collection) => collectionItem(collection.spaceId, collection.id)),
  ].filter(present).filter((item) => !coveredKeys.has(keyOf(item)));

  return {
    workspaceId: ws,
    workspaceName: current.name,
    owned,
    ownedItemCount: library.listAllItems().filter((item) => ownedIds.has(item.spaceId)).length,
    direct,
    inherited,
    addable,
    destinations: owned.map((item) => ({ id: item.librarySpaceId, name: item.name })),
  };
}
