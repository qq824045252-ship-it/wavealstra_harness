import type {
  LibraryCollectionDto, LibraryItemDto, LibraryListRowDto, LibraryOwnerScope,
  LibrarySnapshotDto, LibrarySpaceDto,
} from "@shared/library-ipc";

export interface LibraryReferenceScope {
  spaceId: string;
  /** null/omitted references the whole space; otherwise only this collection subtree. */
  collectionId?: string | null;
  /** A project pin may reference exactly one document without exposing sibling documents. */
  itemId?: string;
}

export interface LibraryUnsavedGuard {
  dirty: boolean;
  save: () => Promise<void>;
  discard: () => void;
}

export interface LibraryLocation {
  spaceId: string | null;
  collectionId: string | null;
}

export function libraryOwnerKey(scope: LibraryOwnerScope): string {
  return scope.type === "personal" ? "personal"
    : scope.type === "project" ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`;
}

export function libraryOwnerOf(space: LibrarySpaceDto): LibraryOwnerScope {
  if (space.projectId) return { type: "project", projectId: space.projectId };
  if (space.workspaceId) return { type: "workspace", workspaceId: space.workspaceId };
  return { type: "personal" };
}

export function isLibrarySpaceOwnedBy(space: LibrarySpaceDto, scope: LibraryOwnerScope): boolean {
  if (scope.type === "project") return space.projectId === scope.projectId && !space.workspaceId;
  if (scope.type === "workspace") return space.workspaceId === scope.workspaceId && !space.projectId;
  // Keep old unassigned team spaces accessible without moving, copying, or re-identifying them.
  return !space.projectId && !space.workspaceId;
}

export function isLibraryTaskOwnedBy(task: { projectId?: string | null; spaceId?: string | null }, scope: LibraryOwnerScope): boolean {
  if (scope.type === "project") return task.projectId === scope.projectId;
  if (scope.type === "workspace") return task.spaceId === scope.workspaceId;
  return !task.projectId && !task.spaceId;
}

export function libraryCollectionSubtree(collections: readonly LibraryCollectionDto[], id: string): Set<string> {
  const root = collections.find((collection) => collection.id === id);
  if (!root) return new Set();
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections) {
      if (collection.spaceId === root.spaceId && collection.parentId
        && result.has(collection.parentId) && !result.has(collection.id)) {
        result.add(collection.id);
        changed = true;
      }
    }
  }
  return result;
}

/** The only projection used by local managers. Unknown references fail closed, including metadata. */
export function scopedLibrarySnapshot(
  snapshot: LibrarySnapshotDto, scope: LibraryOwnerScope, reference?: LibraryReferenceScope,
): LibrarySnapshotDto {
  let spaces = snapshot.spaces.filter((space) => isLibrarySpaceOwnedBy(space, scope)
    && (!reference || space.id === reference.spaceId));
  let spaceIds = new Set(spaces.map((space) => space.id));
  let collections = snapshot.collections.filter((collection) => spaceIds.has(collection.spaceId));
  if (reference?.collectionId) {
    const subtree = libraryCollectionSubtree(collections, reference.collectionId);
    collections = collections.filter((collection) => subtree.has(collection.id));
    if (!subtree.size) { spaces = []; spaceIds = new Set(); }
  }
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const items = snapshot.items.filter((item) => spaceIds.has(item.spaceId)
    && (!reference?.itemId || item.id === reference.itemId)
    && (!reference?.collectionId || (item.collectionId && collectionIds.has(item.collectionId))));
  if (reference?.itemId) {
    collections = [];
    if (!items.length) spaces = [];
  }
  const itemIds = new Set(items.map((item) => item.id));
  return {
    ...snapshot, spaces, collections, items,
    recent: snapshot.recent.filter((row) => row.source === "library" && itemIds.has(row.id)),
    artifacts: [],
    storage: { usedBytes: items.reduce((bytes, item) => bytes + item.sizeBytes, 0) },
  };
}

export function libraryFolderPath(snapshot: LibrarySnapshotDto, collectionId: string | null): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = snapshot.collections.find((collection) => collection.id === collectionId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = snapshot.collections.find((collection) => collection.id === current?.parentId);
  }
  return parts.join(" / ");
}

export function libraryItemRow(snapshot: LibrarySnapshotDto, item: LibraryItemDto): LibraryListRowDto {
  return {
    ...item, source: "library", location: [snapshot.spaces.find((space) => space.id === item.spaceId)?.name,
      libraryFolderPath(snapshot, item.collectionId)].filter(Boolean).join(" / "),
  };
}

export function libraryFolderRow(snapshot: LibrarySnapshotDto, collection: LibraryCollectionDto): LibraryListRowDto {
  return {
    id: collection.id, source: "library", kind: "folder", title: collection.name,
    owner: collection.owner, spaceId: collection.spaceId, parentId: collection.parentId,
    updatedAt: collection.updatedAt,
    location: [snapshot.spaces.find((space) => space.id === collection.spaceId)?.name,
      libraryFolderPath(snapshot, collection.parentId)].filter(Boolean).join(" / "),
  };
}

/** Rebuild result metadata from scoped truth, never from the global search response. */
export function scopedLibrarySearchRows(
  snapshot: LibrarySnapshotDto, query: string, hits: readonly LibraryListRowDto[] = [],
): LibraryListRowDto[] {
  const needle = query.trim().toLocaleLowerCase();
  const hitIds = new Set(hits.filter((row) => row.source === "library").map((row) => row.id));
  return [
    ...snapshot.collections.filter((collection) => collection.name.toLocaleLowerCase().includes(needle))
      .map((collection) => libraryFolderRow(snapshot, collection)),
    ...snapshot.items.filter((item) => hitIds.has(item.id)
      || `${item.title}\n${item.filename}`.toLocaleLowerCase().includes(needle))
      .map((item) => libraryItemRow(snapshot, item)),
  ];
}

export function requireLibraryItem(snapshot: LibrarySnapshotDto, id: string): LibraryItemDto {
  const item = snapshot.items.find((entry) => entry.id === id);
  if (!item) throw new Error("资料不存在，或已不属于当前资料范围");
  return item;
}

export function requireLibraryFolder(snapshot: LibrarySnapshotDto, id: string): LibraryCollectionDto {
  const folder = snapshot.collections.find((entry) => entry.id === id);
  if (!folder) throw new Error("文件夹不存在，或已不属于当前资料范围");
  return folder;
}

export function requireLibraryDestination(snapshot: LibrarySnapshotDto, location: LibraryLocation): asserts location is { spaceId: string; collectionId: string | null } {
  if (!location.spaceId || !snapshot.spaces.some((space) => space.id === location.spaceId)) {
    throw new Error("资料位置不属于当前项目或工作区");
  }
  if (location.collectionId && requireLibraryFolder(snapshot, location.collectionId).spaceId !== location.spaceId) {
    throw new Error("不能跨资料位置移动文件或文件夹");
  }
}

export function libraryMoveTargets(snapshot: LibrarySnapshotDto, row: LibraryListRowDto): LibraryCollectionDto[] {
  const excluded = row.kind === "folder" ? libraryCollectionSubtree(snapshot.collections, row.id) : new Set<string>();
  return snapshot.collections.filter((collection) => collection.spaceId === row.spaceId && !excluded.has(collection.id));
}

export function defaultLibraryLocation(snapshot: LibrarySnapshotDto, reference?: LibraryReferenceScope): LibraryLocation {
  const space = reference ? snapshot.spaces.find((entry) => entry.id === reference.spaceId) : snapshot.spaces[0];
  return { spaceId: space?.id ?? null, collectionId: space ? reference?.collectionId ?? null : null };
}

export function resolveScopedLibraryLink(snapshot: LibrarySnapshotDto, sourceItemId: string, href: string): string {
  const source = requireLibraryItem(snapshot, sourceItemId);
  let base = source;
  let path = href.split(/[?#]/, 1)[0] ?? "";
  if (/^mybuddy-library:/i.test(path)) {
    const url = new URL(path);
    if (url.hostname !== "local") throw new Error("资料链接无效");
    const [id, ...parts] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    base = requireLibraryItem(snapshot, id ?? "");
    if (!parts.length) return base.id;
    path = parts.join("/");
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("请在资料所属位置打开此链接");
  }
  const parts = decodeURIComponent(path).split(/[\\/]/).filter((part) => part && part !== "." && part !== "..");
  if (parts.length !== 1) throw new Error("链接目标不在当前资料范围，请到所属位置查看");
  const matches = snapshot.items.filter((item) => item.spaceId === base.spaceId && item.filename === parts[0]);
  const sameFolder = matches.filter((item) => (item.collectionId ?? null) === (base.collectionId ?? null));
  const candidates = sameFolder.length ? sameFolder : matches;
  if (candidates.length !== 1) throw new Error(candidates.length ? "同名资料不止一份，请从文件夹中选择" : "链接目标不在当前资料范围，请到所属位置查看");
  return candidates[0].id;
}
