/** SQL 候选范围：整空间、文件夹子树（调用方已展开）与显式单条引用的并集。 */
export interface LibraryQueryScope {
  spaceIds: ReadonlySet<string>;
  collectionIds?: ReadonlySet<string>;
  itemIds?: ReadonlySet<string>;
}

export function libraryScopeWhere(scope: LibraryQueryScope, prefix = ""): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (column: string, ids: ReadonlySet<string> | undefined) => {
    if (!ids?.size) return;
    const values = [...ids];
    clauses.push(`${prefix}${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  add("space_id", scope.spaceIds);
  add("collection_id", scope.collectionIds);
  add("id", scope.itemIds);
  return { sql: clauses.length ? `(${clauses.join(" OR ")})` : "0", params };
}
