import type { LibraryCreateItemRequest, LibraryOwnerScope, LibraryContentDto, LibraryListRowDto, LibrarySnapshotDto } from "@shared/library-ipc";
import {
  isLibrarySpaceOwnedBy, libraryCollectionSubtree, requireLibraryDestination, requireLibraryFolder,
  requireLibraryItem, resolveScopedLibraryLink, scopedLibrarySearchRows, scopedLibrarySnapshot,
  type LibraryLocation, type LibraryReferenceScope,
} from "./scopedLibrary";

export type ScopedLibraryApi = NonNullable<Window["api"]>["library"];

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** UI operations revalidate fresh metadata before reads and writes; backend remains authoritative. */
export class ScopedLibraryOperations {
  readonly readOnly: boolean;
  constructor(
    private readonly getApi: () => ScopedLibraryApi,
    readonly scope: LibraryOwnerScope,
    readonly reference?: LibraryReferenceScope,
    readOnly = false,
    private readonly artifactTaskIds: () => ReadonlySet<string> | Promise<ReadonlySet<string>> = () => new Set(),
  ) { this.readOnly = readOnly || Boolean(reference); }

  async snapshot() { return scopedLibrarySnapshot(await this.getApi().snapshot(), this.scope, this.reference); }

  private writable(): void {
    if (this.readOnly) throw new Error("这里只能阅读资料，请到资料所属位置修改");
  }

  private async item(id: string, write = false) {
    if (write) this.writable();
    return requireLibraryItem(await this.snapshot(), id);
  }

  async destination(location: LibraryLocation): Promise<{ spaceId: string; collectionId: string | null }> {
    this.writable();
    if (!location.spaceId) {
      if (location.collectionId) throw new Error("请选择有效的资料位置");
      const space = value(await this.getApi().ensureOwnedSpace(this.scope));
      if (!isLibrarySpaceOwnedBy(space, this.scope)) throw new Error("创建的资料位置不属于当前范围");
      location = { spaceId: space.id, collectionId: null };
    }
    requireLibraryDestination(await this.snapshot(), location);
    return { spaceId: location.spaceId, collectionId: location.collectionId };
  }

  async read(id: string): Promise<LibraryContentDto> {
    await this.item(id);
    const payload = value(await this.getApi().readContent(id));
    const current = await this.item(id);
    if (payload.item.id !== current.id || payload.item.spaceId !== current.spaceId
      || payload.item.collectionId !== current.collectionId) throw new Error("资料位置已改变，请重新打开");
    if (!this.readOnly) void this.getApi().markVisited(id).catch(() => {});
    return payload;
  }

  async search(query: string): Promise<{ snapshot: LibrarySnapshotDto; rows: LibraryListRowDto[] }> {
    const hits = await this.getApi().search({ query, owner: this.scope, reference: this.reference });
    // A search may finish after documents were deleted, moved, or created.
    // Return one fresh projection for both the result rows and their navigation.
    const snapshot = await this.snapshot();
    return { snapshot, rows: scopedLibrarySearchRows(snapshot, query, hits) };
  }

  async resolveLink(sourceItemId: string, href: string): Promise<string> {
    return resolveScopedLibraryLink(await this.snapshot(), sourceItemId, href);
  }

  async createItem(location: LibraryLocation, kind: LibraryCreateItemRequest["kind"], title: string) {
    const target = await this.destination(location);
    return value(await this.getApi().createItem({ ...target, kind, title }));
  }

  async createFolder(location: LibraryLocation, name: string) {
    const target = await this.destination(location);
    return value(await this.getApi().createCollection({ spaceId: target.spaceId, parentId: target.collectionId, name }));
  }

  async createUrl(location: LibraryLocation, url: string, title?: string) {
    const target = await this.destination(location);
    return value(await this.getApi().createUrl({ ...target, url, title: title?.trim() || undefined }));
  }

  async importFiles(location: LibraryLocation, paths?: readonly string[]) {
    const target = await this.destination(location);
    if (!paths) return value(await this.getApi().pickAndImport(target));
    const items = [];
    for (const sourcePath of paths) {
      // A folder may be removed while a multi-file import is running.
      await this.destination(target);
      items.push(value(await this.getApi().importFile({ ...target, sourcePath })));
    }
    return items;
  }

  async renameItem(id: string, title: string) {
    await this.item(id, true);
    return value(await this.getApi().updateItem({ id, title }));
  }

  async writeContent(id: string, content: string) {
    await this.item(id, true);
    return value(await this.getApi().writeContent({ id, content }));
  }

  async deleteItem(id: string): Promise<void> {
    await this.item(id, true);
    value(await this.getApi().deleteItem(id));
  }

  async renameFolder(id: string, name: string) {
    this.writable();
    requireLibraryFolder(await this.snapshot(), id);
    return value(await this.getApi().renameCollection({ id, name }));
  }

  async deleteFolder(id: string): Promise<void> {
    this.writable();
    requireLibraryFolder(await this.snapshot(), id);
    value(await this.getApi().deleteCollection(id));
  }

  async move(row: Pick<LibraryListRowDto, "id" | "kind">, collectionId: string | null): Promise<void> {
    this.writable();
    const snapshot = await this.snapshot();
    const source = row.kind === "folder" ? requireLibraryFolder(snapshot, row.id) : requireLibraryItem(snapshot, row.id);
    requireLibraryDestination(snapshot, { spaceId: source.spaceId, collectionId });
    if (row.kind === "folder") {
      if (collectionId && libraryCollectionSubtree(snapshot.collections, row.id).has(collectionId)) {
        throw new Error("不能把文件夹移入自身或自己的子文件夹");
      }
      value(await this.getApi().moveCollection({ id: row.id, parentId: collectionId }));
    } else value(await this.getApi().updateItem({ id: row.id, collectionId }));
  }

  async favorite(id: string, favorite: boolean) {
    await this.item(id, true);
    return value(await this.getApi().favorite({ id, favorite }));
  }

  async artifacts() {
    const [snapshot, allowed] = await Promise.all([this.getApi().snapshot(), this.artifactTaskIds()]);
    return snapshot.artifacts.filter((artifact) => allowed.has(artifact.taskId));
  }

  async saveArtifact(location: LibraryLocation, artifactId: string) {
    this.writable();
    if (!(await this.artifacts()).some((artifact) => artifact.id === artifactId)) {
      throw new Error("任务成果已不属于当前项目或工作区");
    }
    const target = await this.destination(location);
    return value(await this.getApi().saveArtifact({ ...target, artifactId, owner: this.scope }));
  }

  async showInFolder(id: string): Promise<void> {
    await this.item(id);
    const result = await this.getApi().showInFolder(id);
    if (!result.ok) throw new Error(result.error);
  }

  async attach(id: string, taskId: string, attached: boolean): Promise<void> {
    await this.item(id, true);
    const result = attached ? await this.getApi().detachFromTask({ itemId: id, taskId })
      : await this.getApi().attachToTask({ itemId: id, taskId });
    if (!result.ok) throw new Error(result.error);
  }
}
