import type { LibraryCollectionDto, LibraryItemDto } from "./library-ipc";

export function hiddenLibraryCollectionIds(collections: readonly LibraryCollectionDto[]): Set<string> {
  const hidden = new Set<string>();
  const children = new Map<string, string[]>();
  for (const folder of collections) {
    if (folder.name.startsWith(".")) hidden.add(folder.id);
    if (!folder.parentId) continue;
    const siblings = children.get(folder.parentId);
    if (siblings) siblings.push(folder.id);
    else children.set(folder.parentId, [folder.id]);
  }
  for (const id of hidden) {
    for (const child of children.get(id) ?? []) hidden.add(child);
  }
  return hidden;
}

export function isVisibleLibraryFile(item: Pick<LibraryItemDto, "filename" | "collectionId">, hidden: ReadonlySet<string>): boolean {
  return !item.filename.startsWith(".") && (!item.collectionId || !hidden.has(item.collectionId));
}
