import type { LibraryService } from "../library/LibraryService";

/** The caller validates the task or workspace. The library then rechecks item visibility on every read. */
export function readDotsLibrary(library: LibraryService, scope: ReturnType<LibraryService["resolveTaskScope"]>,
  input: { query?: string; itemId?: string; version?: number }, allowed = (_itemId: string, _spaceId?: string) => true) {
  if (!input.itemId) {
    const rows = input.query?.trim() ? library.searchInScope(input.query, scope) : library.listItemsInScope(scope);
    return { items: rows.filter(row => allowed(row.id,row.spaceId)).slice(0, 30).map(({ id, title, kind }) => ({ id, title, kind })) };
  }
  const item = library.getItem(input.itemId);
  if (!item || !allowed(item.id,item.spaceId) || !library.isItemVisibleInScope(item, scope)) throw new Error("当前范围没有这份资料");
  const ref = { id: item.id, title: item.title, kind: item.kind };
  if (input.version !== undefined) {
    if (!["markdown", "html", "csv"].includes(item.kind)) throw new Error("该附件不支持读取历史文本");
    const text = library.readVersion(item.id, input.version);
    return { ...ref, version: input.version, text: text.slice(0, 4000), truncated: text.length > 4000 };
  }
  const body = library.readContent(item.id, 4000);
  return { ...ref, contentHash: item.contentHash, text: body.content, truncated: !!body.contentTruncated,
    url: item.url, file: body.requiresFileAccess || undefined,
    versions: library.listVersions(item.id).map(({ version, contentHash }) => ({ version, contentHash })) };
}
