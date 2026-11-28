import type { LibraryService } from "../library/LibraryService";
import { LIBRARY_CHUNK_DEFAULTS } from "../library/library-chunker";
import type { LibraryItemKind } from "../../shared/library-ipc";
import type { RuntimeAuditReader } from "../platform/runtime-audit";

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

type CoreScopeSpaceRow = { id: string; workspace_id: string | null; project_id: string | null };
type CoreScopeItemRow = {
  id: string; space_id: string; title: string; kind: LibraryItemKind;
  source_task_id: string | null; content_hash?: string | null; url?: string | null;
};

export async function readDotsLibraryAsync(
  library: LibraryService,
  reader: RuntimeAuditReader,
  scopeQuery: { taskId?: string; workspaceId?: string },
  input: { query?: string; itemId?: string; version?: number },
  allowed: (owner: { workspaceId: string | null; projectId: string | null; sourceTaskId: string | null }) => Promise<boolean> | boolean = () => true,
) {
  const scope = await reader.libraryMetadata<{ spaces: CoreScopeSpaceRow[]; items: CoreScopeItemRow[] } | null>({
    kind: "taskScope",
    ...scopeQuery,
    ...(input.itemId ? { itemIds: [input.itemId] } : {}),
  });
  if (scope === undefined) throw new Error("Core 未确认当前范围的资料权限");
  const spaces = new Map((scope?.spaces ?? []).map(s => [s.id, s]));
  const items = scope?.items ?? [];
  const isItemAllowed = async (item: CoreScopeItemRow) => {
    const owner = spaces.get(item.space_id);
    return Boolean(owner && await allowed({
      workspaceId: owner.workspace_id,
      projectId: owner.project_id,
      sourceTaskId: item.source_task_id ?? null,
    }));
  };
  if (!input.itemId) {
    const trimmed = input.query?.trim() ?? "";
    let candidates = items;
    if (trimmed && items.length) {
      const prefix = trimmed.length > LIBRARY_CHUNK_DEFAULTS.overlap
        ? trimmed.slice(0, LIBRARY_CHUNK_DEFAULTS.overlap - 1).replace(/[\ud800-\udbff]$/u, "")
        : "";
      const matches = await reader.libraryMetadata<Array<{ id: string; rank: number }>>({
        kind: "searchKeyword",
        query: trimmed,
        prefix,
        ids: items.map(item => item.id),
      });
      if (!matches) throw new Error("Core 未确认资料检索");
      const byId = new Map(items.map(item => [item.id, item]));
      candidates = matches.flatMap(match => {
        const row = byId.get(match.id);
        return row ? [row] : [];
      });
    }
    const visible: Array<{ id: string; title: string; kind: LibraryItemKind }> = [];
    for (const item of candidates) {
      if (await isItemAllowed(item)) {
        visible.push({ id: item.id, title: item.title, kind: item.kind });
        if (visible.length >= 30) break;
      }
    }
    return { items: visible };
  }
  const item = items.find(row => row.id === input.itemId);
  if (!item || !await isItemAllowed(item)) throw new Error("当前范围没有这份资料");
  const ref = { id: item.id, title: item.title, kind: item.kind };
  if (input.version !== undefined) {
    if (!["markdown", "html", "csv"].includes(item.kind)) throw new Error("该附件不支持读取历史文本");
    const text = await library.readVersionBody(item.id, input.version);
    return { ...ref, version: input.version, text: text.slice(0, 4000), truncated: text.length > 4000 };
  }
  const [body, versions] = await Promise.all([
    library.readContentAsync(item.id, 4000),
    library.readVersions(item.id),
  ]);
  return {
    ...ref,
    contentHash: item.content_hash ?? undefined,
    text: body.content,
    truncated: !!body.contentTruncated,
    url: item.url ?? undefined,
    file: body.requiresFileAccess || undefined,
    versions: versions.map(({ version, contentHash }) => ({ version, contentHash })),
  };
}
