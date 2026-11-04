import type { Database } from "better-sqlite3";
import { libraryScopeWhere, type LibraryQueryScope } from "./library-query-scope";
import type {
  LibraryCollectionDto,
  LibraryItemDto,
  LibraryItemKind,
  LibraryRetrievalHitDto,
  LibrarySourceType,
  LibrarySpaceDto,
  LibrarySpaceKind,
  LibraryTaskReferenceDto,
  LibraryVersionDto,
} from "../../shared/library-ipc";

interface SpaceRow {
  id: string;
  name: string;
  kind: string;
  project_id: string | null;
  workspace_id: string | null;
  created_at: number;
  updated_at: number;
}

interface CollectionRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  name: string;
  owner: string;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  space_id: string;
  collection_id: string | null;
  kind: string;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  owner: string;
  favorite: number;
  url: string | null;
  source_type: string;
  source_task_id: string | null;
  source_artifact_id: string | null;
  original_path: string | null;
  content_hash: string | null;
  extract_status: string | null;
  created_at: number;
  updated_at: number;
  last_visited_at: number | null;
}

interface VersionRow {
  id: string;
  item_id: string;
  version: number;
  content_hash: string;
  path: string;
  created_by: string;
  source_task_id: string | null;
  created_at: number;
}

interface ReferenceRow {
  task_id: string;
  item_id: string;
  project_id: string | null;
  added_at: number;
  added_by: string;
}

const ITEM_COLUMNS = `id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
  favorite, url, source_type, source_task_id, source_artifact_id, original_path,
  content_hash, extract_status, created_at, updated_at, last_visited_at`;

const LIBRARY_FTS_BODY_MAX_CHARS = 256 * 1024;

function toSpace(row: SpaceRow): LibrarySpaceDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as LibrarySpaceKind,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCollection(row: CollectionRow): LibraryCollectionDto {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    name: row.name,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: ItemRow): LibraryItemDto {
  return {
    id: row.id,
    spaceId: row.space_id,
    collectionId: row.collection_id,
    kind: row.kind as LibraryItemKind,
    title: row.title,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    owner: row.owner,
    favorite: Boolean(row.favorite),
    url: row.url ?? undefined,
    sourceType: (row.source_type as LibrarySourceType) ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    originalPath: row.original_path ?? undefined,
    contentHash: row.content_hash ?? undefined,
    extractStatus: row.extract_status ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVisitedAt: row.last_visited_at,
  };
}

export class LibraryRepository {
  constructor(private readonly db: Database) {
    // Additive search-index metadata. No database schema-version bump: this table only
    // checkpoints derived-index format upgrades and can be rebuilt independently.
    this.db.exec(`CREATE TABLE IF NOT EXISTS library_index_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  getIndexState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM library_index_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setIndexState(key: string, value: string): void {
    this.db.prepare(`INSERT INTO library_index_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, Date.now());
  }

  /** Text items that lost their derived FTS row after an interrupted/partial maintenance operation. */
  listTextFtsMissingCandidates(): string[] {
    if (!this.ftsAvailable()) return [];
    return (this.db.prepare(`SELECT id FROM library_items
      WHERE kind IN ('markdown','html','csv') AND id NOT IN (SELECT item_id FROM library_fts)
      ORDER BY created_at, rowid`).all() as Array<{ id: string }>).map((row) => row.id);
  }

  /** Only legacy text items in the old 200 KiB → new 256 KiB coverage band need FTS v2 refresh. */
  listTextFtsCoverageUpgradeCandidates(): string[] {
    return (this.db.prepare(`SELECT id FROM library_items
      WHERE kind IN ('markdown','html','csv') AND size_bytes > ? AND size_bytes <= ?
      ORDER BY created_at, rowid`).all(200 * 1024, 256 * 1024) as Array<{ id: string }>).map((row) => row.id);
  }

  /* ---------------- Spaces ---------------- */

  listSpaces(): LibrarySpaceDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, kind, project_id, workspace_id, created_at, updated_at FROM library_spaces
           ORDER BY CASE kind WHEN 'personal' THEN 0 ELSE 1 END, created_at, rowid`,
        )
        .all() as SpaceRow[]
    ).map(toSpace);
  }

  listProjectSpaces(projectId: string): LibrarySpaceDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, kind, project_id, workspace_id, created_at, updated_at FROM library_spaces
           WHERE project_id = ? ORDER BY created_at, rowid`,
        )
        .all(projectId) as SpaceRow[]
    ).map(toSpace);
  }

  listWorkspaceSpaces(workspaceId: string): LibrarySpaceDto[] {
    return (this.db.prepare(
      `SELECT id, name, kind, project_id, workspace_id, created_at, updated_at FROM library_spaces
       WHERE workspace_id = ? ORDER BY created_at, rowid`,
    ).all(workspaceId) as SpaceRow[]).map(toSpace);
  }

  getSpace(id: string): LibrarySpaceDto | null {
    const row = this.db
      .prepare(`SELECT id, name, kind, project_id, workspace_id, created_at, updated_at FROM library_spaces WHERE id = ?`)
      .get(id) as SpaceRow | undefined;
    return row ? toSpace(row) : null;
  }

  insertSpace(space: LibrarySpaceDto): void {
    if (space.projectId && space.workspaceId) throw new Error("资料空间只能归属于一个项目或工作空间");
    this.db
      .prepare(
        `INSERT INTO library_spaces (id, name, kind, project_id, workspace_id, created_at, updated_at)
         VALUES (@id, @name, @kind, @projectId, @workspaceId, @createdAt, @updatedAt)`,
      )
      .run({
        id: space.id,
        name: space.name,
        kind: space.kind,
        projectId: space.projectId ?? null,
        workspaceId: space.workspaceId ?? null,
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
      });
  }

  updateSpace(id: string, name: string, updatedAt: number): void {
    this.db.prepare(`UPDATE library_spaces SET name = ?, updated_at = ? WHERE id = ?`).run(name, updatedAt, id);
  }

  deleteSpace(id: string): void {
    this.db.prepare(`DELETE FROM library_spaces WHERE id = ?`).run(id);
  }

  /* ---------------- Collections ---------------- */

  listCollections(spaceId?: string, parentId?: string | null): LibraryCollectionDto[] {
    const order = `ORDER BY name COLLATE NOCASE, rowid`;
    if (spaceId) {
      if (parentId === undefined) {
        return (
          this.db
            .prepare(`SELECT * FROM library_collections WHERE space_id = ? ${order}`)
            .all(spaceId) as CollectionRow[]
        ).map(toCollection);
      }
      if (parentId === null) {
        return (
          this.db
            .prepare(`SELECT * FROM library_collections WHERE space_id = ? AND parent_id IS NULL ${order}`)
            .all(spaceId) as CollectionRow[]
        ).map(toCollection);
      }
      return (
        this.db
          .prepare(`SELECT * FROM library_collections WHERE space_id = ? AND parent_id = ? ${order}`)
          .all(spaceId, parentId) as CollectionRow[]
      ).map(toCollection);
    }
    return (
      this.db
        .prepare(`SELECT * FROM library_collections ${order}`)
        .all() as CollectionRow[]
    ).map(toCollection);
  }

  listCollectionsRecursive(spaceId: string, parentId: string): LibraryCollectionDto[] {
    const out: LibraryCollectionDto[] = [];
    const walk = (pid: string): void => {
      const kids = this.listCollections(spaceId, pid);
      for (const kid of kids) {
        out.push(kid);
        walk(kid.id);
      }
    };
    walk(parentId);
    return out;
  }

  getCollection(id: string): LibraryCollectionDto | null {
    const row = this.db
      .prepare(`SELECT * FROM library_collections WHERE id = ?`)
      .get(id) as CollectionRow | undefined;
    return row ? toCollection(row) : null;
  }

  insertCollection(collection: LibraryCollectionDto): void {
    this.db
      .prepare(
        `INSERT INTO library_collections (id, space_id, parent_id, name, owner, created_at, updated_at)
         VALUES (@id, @spaceId, @parentId, @name, @owner, @createdAt, @updatedAt)`,
      )
      .run(collection);
  }

  updateCollection(collection: LibraryCollectionDto): void {
    this.db
      .prepare(
        `UPDATE library_collections SET parent_id = @parentId, name = @name, owner = @owner,
           updated_at = @updatedAt WHERE id = @id`,
      )
      .run(collection);
  }

  deleteCollection(id: string): void {
    this.db.prepare(`DELETE FROM library_collections WHERE id = ?`).run(id);
  }

  /** 集合路径上的全部祖先 id（含自身）；用于移动时的环校验 */
  collectionAncestors(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      out.push(cursor);
      const row = this.db
        .prepare(`SELECT parent_id FROM library_collections WHERE id = ?`)
        .get(cursor) as { parent_id: string | null } | undefined;
      cursor = row?.parent_id ?? null;
    }
    return out;
  }

  /* ---------------- Items ---------------- */

  listItems(spaceId?: string, collectionId?: string | null): LibraryItemDto[] {
    const order = `ORDER BY title COLLATE NOCASE, rowid`;
    if (spaceId) {
      if (collectionId === undefined) {
        return (
          this.db
            .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? ${order}`)
            .all(spaceId) as ItemRow[]
        ).map(toItem);
      }
      if (collectionId === null) {
        return (
          this.db
            .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND collection_id IS NULL ${order}`)
            .all(spaceId) as ItemRow[]
        ).map(toItem);
      }
      return (
        this.db
          .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND collection_id = ? ${order}`)
          .all(spaceId, collectionId) as ItemRow[]
      ).map(toItem);
    }
    return (
      this.db
        .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items ${order}`)
        .all() as ItemRow[]
    ).map(toItem);
  }

  listItemsInScope(scope: LibraryQueryScope): LibraryItemDto[] {
    const where = libraryScopeWhere(scope);
    return (this.db.prepare(
      `SELECT ${ITEM_COLUMNS} FROM library_items WHERE ${where.sql} ORDER BY title COLLATE NOCASE, rowid`,
    ).all(...where.params) as ItemRow[]).map(toItem);
  }

  /** 集合内全部条目（含子集合，递归；删除集合用） */
  listItemsInCollectionTree(spaceId: string, collectionId: string): LibraryItemDto[] {
    const out: LibraryItemDto[] = [];
    const walk = (cid: string): void => {
      out.push(...this.listItems(spaceId, cid));
      for (const kid of this.listCollections(spaceId, cid)) walk(kid.id);
    };
    walk(collectionId);
    return out;
  }

  getItem(id: string): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE id = ?`)
      .get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  findByFilename(spaceId: string, filename: string): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND filename = ? COLLATE NOCASE LIMIT 1`)
      .get(spaceId, filename) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  findBySourceArtifact(spaceId: string, artifactId: string): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND source_artifact_id = ? LIMIT 1`)
      .get(spaceId, artifactId) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  insertItem(item: LibraryItemDto): void {
    this.db
      .prepare(
        `INSERT INTO library_items (
           id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
           favorite, url, source_type, source_task_id, source_artifact_id, original_path,
           content_hash, extract_status, created_at, updated_at, last_visited_at
         ) VALUES (
           @id, @spaceId, @collectionId, @kind, @title, @filename, @mimeType, @sizeBytes, @owner,
           @favorite, @url, @sourceType, @sourceTaskId, @sourceArtifactId, @originalPath,
           @contentHash, @extractStatus, @createdAt, @updatedAt, @lastVisitedAt
         )`,
      )
      .run(this.toParams(item));
  }

  updateItem(item: LibraryItemDto): void {
    this.db
      .prepare(
        `UPDATE library_items SET
           collection_id = @collectionId, title = @title, filename = @filename, mime_type = @mimeType,
           size_bytes = @sizeBytes, owner = @owner, favorite = @favorite, url = @url,
           source_type = @sourceType, source_task_id = @sourceTaskId,
           source_artifact_id = @sourceArtifactId, original_path = @originalPath,
           content_hash = @contentHash, extract_status = @extractStatus,
           updated_at = @updatedAt, last_visited_at = @lastVisitedAt
         WHERE id = @id`,
      )
      .run(this.toParams(item));
  }

  deleteItem(id: string): void {
    // FTS + chunk 检索行随条目删除一并清理（service 层删除与级联删除共用此收口点，显式防 orphan）
    this.deleteFts(id);
    this.deleteChunks(id);
    this.db.prepare(`DELETE FROM library_items WHERE id = ?`).run(id);
  }

  /** 抽取恢复候选：office/pdf 且 status 为 NULL/pending/error，或已 extracted 但 FTS 行缺失（重启/中断后自愈） */
  listExtractionRecoveryCandidates(): Array<{ id: string }> {
    const out = new Map<string, { id: string }>();
    const statusRows = this.db
      .prepare(
        `SELECT id FROM library_items
         WHERE kind IN ('office', 'pdf')
           AND (extract_status IS NULL OR extract_status IN ('pending', 'error'))`,
      )
      .all() as Array<{ id: string }>;
    for (const row of statusRows) out.set(row.id, row);
    if (this.ftsAvailable()) {
      const ftsRows = this.db
        .prepare(
          `SELECT id FROM library_items
           WHERE kind IN ('office', 'pdf') AND extract_status = 'extracted'
             AND id NOT IN (SELECT item_id FROM library_fts)`,
        )
        .all() as Array<{ id: string }>;
      for (const row of ftsRows) out.set(row.id, row);
    }
    return [...out.values()];
  }

  updateExtractStatus(id: string, status: string): void {
    this.db
      .prepare(`UPDATE library_items SET extract_status = ? WHERE id = ?`)
      .run(status, id);
  }

  /** R2 backfill：所有 item id（按 created_at 排序，稳定分页） */
  listAllItemIds(): string[] {
    return (this.db.prepare(`SELECT id FROM library_items ORDER BY created_at, rowid`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }

  /** R2 backfill：无 chunks 的 item id 集合（无 library_chunks 表时返回空） */
  hasChunks(itemId: string): boolean {
    if (!this.tableExists("library_chunks")) return false;
    const row = this.db.prepare(`SELECT 1 AS v FROM library_chunks WHERE item_id = ? LIMIT 1`).get(itemId) as
      | { v: number }
      | undefined;
    return row !== undefined;
  }

  /** Chunk backfill 候选：有可索引正文但 library_chunks 为空的 item。幂等推导，无需 pending 表。 */
  listChunkBackfillCandidates(limit = 500): string[] {
    if (!this.tableExists("library_chunks")) return [];
    // 无 chunk 的 item 即待回填（幂等：已有 chunk 的跳过；可中断恢复：每次按此查询剩余）
    return (
      this.db
        .prepare(
          `SELECT id FROM library_items
           WHERE id NOT IN (SELECT item_id FROM library_chunks)
           ORDER BY created_at, rowid
           LIMIT ?`,
        )
        .all(limit) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  listRecent(limit = 40): LibraryItemDto[] {
    return (
      this.db
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM library_items
           WHERE kind != 'url' AND last_visited_at IS NOT NULL
           ORDER BY last_visited_at DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(limit) as ItemRow[]
    ).map(toItem);
  }

  /** 标题/文件名搜索（内容搜索在 service 层，按文本类型读受控文件） */
  search(query: string, limit = 80): LibraryItemDto[] {
    const q = `%${query.trim()}%`;
    return (
      this.db
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM library_items
           WHERE title LIKE ? OR filename LIKE ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(q, q, limit) as ItemRow[]
    ).map(toItem);
  }

  /** 可全文搜索的文本类型（受控 managed 文件，直接读库内副本） */
  isTextSearchable(kind: LibraryItemKind): boolean {
    return kind === "markdown" || kind === "html" || kind === "csv";
  }

  /* ---------------- FTS5 检索索引（library_fts，trigram 分词） ---------------- */

  ftsAvailable(): boolean {
    return this.tableExists("library_fts");
  }

  upsertFts(itemId: string, title: string, filename: string, body: string): void {
    if (!this.ftsAvailable()) return;
    // FTS5 无 UNIQUE 约束：必须先 DELETE 再 INSERT（INSERT OR REPLACE 只增不改，会累积旧内容行）
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(itemId);
      this.db
        .prepare(`INSERT INTO library_fts (item_id, title, filename, body) VALUES (?, ?, ?, ?)`)
        .run(itemId, title, filename, body.slice(0, LIBRARY_FTS_BODY_MAX_CHARS));
    })();
  }

  deleteFts(itemId: string): void {
    if (!this.ftsAvailable()) return;
    this.db.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(itemId);
  }

  /**
   * Hybrid-ready retrieval：exact 标题命中（rank 0）+ 标题 prefix（rank 1）+ FTS trigram 相关性
   * （rank 2，bm25 + snippet）。spaceIds 为可见白名单（服务端按 task scope 传入，绝不跨项目）。
   * 只返回真实命中（无 recency 兜底桶）；非文本条目（无 body）只做 metadata/title 检索，绝不伪造已理解。
   */
  retrieve(
    query: string,
    opts: LibraryQueryScope & { limit: number },
  ): LibraryRetrievalHitDto[] {
    const q = query.trim();
    if (!q) return [];
    const where = libraryScopeWhere(opts, "li.");
    if (where.sql === "0") return [];
    const rows = this.db
      .prepare(
        `SELECT id, space_id, kind, title, filename, favorite, source_type, source_task_id, updated_at
         FROM library_items li
         WHERE ${where.sql}
           AND kind != 'url'`,
      )
      .all(...where.params) as Array<{
      id: string;
      space_id: string;
      kind: string;
      title: string;
      filename: string;
      favorite: number;
      source_type: string;
      source_task_id: string | null;
      updated_at: number;
    }>;
    const needle = q.toLowerCase();
    const exact = rows.filter((r) => r.title.toLowerCase() === needle);
    const prefix = rows.filter(
      (r) => !exact.includes(r) && r.title.toLowerCase().startsWith(needle),
    );
    const ftsHits = new Map<string, { score: number; snippet: string }>();
    if (this.ftsAvailable() && q.length >= 3) {
      try {
        const ftsQuery = `\"${q.replaceAll('"', "\"\"")}\"`;
        const ftsRows = this.db
          .prepare(
            `SELECT item_id, bm25(library_fts) AS score,
                    snippet(library_fts, 3, '[', ']', '…', 14) AS snip
             FROM library_fts JOIN library_items li ON li.id = library_fts.item_id
             WHERE library_fts MATCH ? AND ${where.sql} ORDER BY score LIMIT ?`,
          )
          .all(ftsQuery, ...where.params, opts.limit) as Array<{ item_id: string; score: number; snip: string | null }>;
        for (const f of ftsRows) ftsHits.set(f.item_id, { score: f.score, snippet: f.snip ?? "" });
      } catch {
        /* FTS 语法/分词失败 → 忽略该路，保留 exact/prefix 结果 */
      }
    }
    const hits: LibraryRetrievalHitDto[] = [];
    const push = (r: (typeof rows)[number], rank: number, snippet: string): void => {
      hits.push({
        itemId: r.id,
        title: r.title,
        kind: r.kind as LibraryItemKind,
        spaceId: r.space_id,
        snippet,
        rank,
        favorite: Boolean(r.favorite),
        sourceType: (r.source_type as LibrarySourceType) ?? undefined,
        sourceTaskId: r.source_task_id ?? undefined,
        updatedAt: r.updated_at,
      });
    };
    for (const r of exact) push(r, 0, "");
    for (const r of prefix) push(r, 1, "");
    const metadataHitIds = new Set([...exact, ...prefix].map((r) => r.id));
    const ftsRanked = rows
      .filter((r) => !metadataHitIds.has(r.id) && ftsHits.has(r.id))
      .sort((a, b) => ftsHits.get(a.id)!.score - ftsHits.get(b.id)!.score)
      .map((r) => ({ r, snip: ftsHits.get(r.id)!.snippet }));
    for (const { r, snip } of ftsRanked) push(r, 2, snip);
    // 注意：不提供 recency 兜底桶——搜索语义 = 只返回真实命中（exact/prefix/FTS），
    // 无匹配返回空，绝不把无关条目当结果。
    return hits.slice(0, opts.limit);
  }

  /* ---------------- Chunk-level Locator (R2 §30) ---------------- */

  /** 批量写入 item 的 chunks（先删旧 chunk+FTS，再插入新）；item 删除时由 deleteItem 显式调用清理 */
  upsertChunks(
    itemId: string,
    chunks: Array<{ id: string; chunkIndex: number; content: string; charOffset: number; hash: string; updatedAt: number }>,
  ): void {
    if (!this.tableExists("library_chunks")) return;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_chunks WHERE item_id = ?`).run(itemId);
      try {
        this.db.prepare(`DELETE FROM library_chunks_fts WHERE item_id = ?`).run(itemId);
      } catch {
        /* FTS 表可能不存在 */
      }
      if (chunks.length === 0) return;
      const insertChunk = this.db.prepare(
        `INSERT INTO library_chunks (id, item_id, chunk_index, content, char_offset, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.tableExists("library_chunks_fts")
        ? this.db.prepare(`INSERT INTO library_chunks_fts (item_id, chunk_id, content) VALUES (?, ?, ?)`)
        : null;
      for (const c of chunks) {
        insertChunk.run(c.id, itemId, c.chunkIndex, c.content, c.charOffset, c.hash, c.updatedAt);
        if (insertFts) {
          try {
            insertFts.run(itemId, c.id, c.content);
          } catch {
            /* 单条 FTS 写入失败不阻断其他 */
          }
        }
      }
    })();
  }

  deleteChunks(itemId: string): void {
    if (!this.tableExists("library_chunks")) return;
    this.db.prepare(`DELETE FROM library_chunks WHERE item_id = ?`).run(itemId);
    if (this.tableExists("library_chunks_fts")) {
      try {
        this.db.prepare(`DELETE FROM library_chunks_fts WHERE item_id = ?`).run(itemId);
      } catch {
        /* ignore */
      }
    }
  }

  listChunks(itemId: string): Array<{ id: string; itemId: string; chunkIndex: number; content: string; charOffset: number; hash: string; updatedAt: number }> {
    if (!this.tableExists("library_chunks")) return [];
    const rows = this.db
      .prepare(`SELECT id, item_id, chunk_index, content, char_offset, hash, updated_at FROM library_chunks WHERE item_id = ? ORDER BY chunk_index`)
      .all(itemId) as Array<{ id: string; item_id: string; chunk_index: number; content: string; char_offset: number; hash: string; updated_at: number }>;
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      charOffset: r.char_offset,
      hash: r.hash,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Chunk FTS 检索：在 allowed spaceIds 范围内，按 FTS5 trigram 匹配 chunk content。
   * 返回 chunkId → { score, snippet } 映射（用于聚合到 Item 级 hit + location）。
   * 空 query / FTS 不可用 / q.length<3 时返回空（与 library_fts 一致风格）。
   */
  searchChunks(
    query: string,
    opts: LibraryQueryScope & { limit: number },
  ): Array<{ chunkId: string; itemId: string; score: number; snippet: string; charOffset: number; chunkIndex: number }> {
    const q = query.trim();
    if (!q || q.length < 3) return [];
    if (!this.tableExists("library_chunks_fts") || !this.tableExists("library_chunks")) return [];
    const where = libraryScopeWhere(opts, "li.");
    if (where.sql === "0") return [];
    try {
      const ftsQuery = `"${q.replaceAll('"', '""')}"`;
      const rows = this.db
        .prepare(
          `SELECT c.id AS chunkId, c.item_id AS itemId, c.chunk_index AS chunkIndex, c.char_offset AS charOffset,
                  bm25(library_chunks_fts) AS score,
                  snippet(library_chunks_fts, 2, '[', ']', '…', 14) AS snip
           FROM library_chunks_fts
           JOIN library_chunks c ON c.id = library_chunks_fts.chunk_id
           JOIN library_items li ON li.id = c.item_id
           WHERE library_chunks_fts MATCH ?
             AND ${where.sql}
           ORDER BY score LIMIT ?`,
        )
        .all(ftsQuery, ...where.params, opts.limit) as Array<{
        chunkId: string;
        itemId: string;
        chunkIndex: number;
        charOffset: number;
        score: number;
        snip: string | null;
      }>;
      return rows.map((r) => ({
        chunkId: r.chunkId,
        itemId: r.itemId,
        score: r.score,
        snippet: r.snip ?? "",
        charOffset: r.charOffset,
        chunkIndex: r.chunkIndex,
      }));
    } catch {
      return [];
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { found: number } | undefined;
    return row !== undefined;
  }

  /** 可内联读取的文本类型（非文本条目禁止 utf8 直读） */
  isTextReadable(kind: LibraryItemKind): boolean {
    return kind === "markdown" || kind === "html" || kind === "csv";
  }

  totalBytes(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM library_items`).get() as { n: number };
    return Number(row.n) || 0;
  }

  /* ---------------- LibraryVersion ---------------- */

  insertVersion(version: LibraryVersionDto): void {
    this.db
      .prepare(
        `INSERT INTO library_versions (id, item_id, version, content_hash, path, created_by, source_task_id, created_at)
         VALUES (@id, @itemId, @version, @contentHash, @path, @createdBy, @sourceTaskId, @createdAt)`,
      )
      .run(version);
  }

  deleteVersion(id: string): void {
    this.db.prepare(`DELETE FROM library_versions WHERE id = ?`).run(id);
  }
  listVersions(itemId: string, limit = 20): LibraryVersionDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, item_id, version, content_hash, path, created_by, source_task_id, created_at
           FROM library_versions WHERE item_id = ? ORDER BY version DESC LIMIT ?`,
        )
        .all(itemId, limit) as VersionRow[]
    ).map((row) => ({
      id: row.id,
      itemId: row.item_id,
      version: row.version,
      contentHash: row.content_hash,
      path: row.path,
      createdBy: row.created_by,
      sourceTaskId: row.source_task_id ?? undefined,
      createdAt: row.created_at,
    }));
  }

  nextVersion(itemId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM library_versions WHERE item_id = ?`)
      .get(itemId) as { n: number };
    return Number(row.n) || 1;
  }

  /* ---------------- TaskLibraryReference ---------------- */

  insertReference(ref: LibraryTaskReferenceDto): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_library_references (task_id, item_id, project_id, added_at, added_by)
         VALUES (@taskId, @itemId, @projectId, @addedAt, @addedBy)`,
      )
      .run({ ...ref, projectId: ref.projectId ?? null });
  }

  deleteReference(taskId: string, itemId: string): void {
    this.db
      .prepare(`DELETE FROM task_library_references WHERE task_id = ? AND item_id = ?`)
      .run(taskId, itemId);
  }

  deleteReferencesByTask(taskId: string): void {
    this.db.prepare(`DELETE FROM task_library_references WHERE task_id = ?`).run(taskId);
  }

  listReferencesByTask(taskId: string): LibraryTaskReferenceDto[] {
    return (
      this.db
        .prepare(
          `SELECT task_id, item_id, project_id, added_at, added_by
           FROM task_library_references WHERE task_id = ? ORDER BY added_at DESC`,
        )
        .all(taskId) as ReferenceRow[]
    ).map((row) => ({
      taskId: row.task_id,
      itemId: row.item_id,
      projectId: row.project_id ?? undefined,
      addedAt: row.added_at,
      addedBy: row.added_by,
    }));
  }

  listReferencesByItem(itemId: string): LibraryTaskReferenceDto[] {
    return (
      this.db
        .prepare(
          `SELECT task_id, item_id, project_id, added_at, added_by
           FROM task_library_references WHERE item_id = ? ORDER BY added_at DESC`,
        )
        .all(itemId) as ReferenceRow[]
    ).map((row) => ({
      taskId: row.task_id,
      itemId: row.item_id,
      projectId: row.project_id ?? undefined,
      addedAt: row.added_at,
      addedBy: row.added_by,
    }));
  }

  private toParams(item: LibraryItemDto): Record<string, unknown> {
    return {
      id: item.id,
      spaceId: item.spaceId,
      collectionId: item.collectionId,
      kind: item.kind,
      title: item.title,
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      owner: item.owner,
      favorite: item.favorite ? 1 : 0,
      url: item.url ?? null,
      sourceType: item.sourceType ?? "created",
      sourceTaskId: item.sourceTaskId ?? null,
      sourceArtifactId: item.sourceArtifactId ?? null,
      originalPath: item.originalPath ?? null,
      contentHash: item.contentHash ?? null,
      extractStatus: item.extractStatus ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastVisitedAt: item.lastVisitedAt ?? null,
    };
  }
}
