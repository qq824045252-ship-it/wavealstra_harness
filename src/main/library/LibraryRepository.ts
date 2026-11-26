import type { Database } from "better-sqlite3";
import { LARGE_LIBRARY_TEXT_BYTES } from "./library-text-parts";
import type { LibraryChunk } from "./library-chunker";
import { libraryScopeWhere, type LibraryQueryScope } from "./library-query-scope";
import type { LibraryEvidencePassage } from "./LibraryDeepSearch";
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
  project_name?: string | null;
  workspace_name?: string | null;
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
  trashed_at: number | null;
  note_metadata: string | null;
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
  content_hash, extract_status, created_at, updated_at, last_visited_at, trashed_at, note_metadata`;

export function toSpace(row: SpaceRow): LibrarySpaceDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as LibrarySpaceKind,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    ...(row.workspace_id && row.workspace_name != null ? { workspaceName: row.workspace_name } : {}),
    ...(!row.workspace_id && row.project_name != null ? { projectName: row.project_name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCollection(row: CollectionRow): LibraryCollectionDto {
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

export function toItem(row: ItemRow): LibraryItemDto {
  const metadata = row.note_metadata ? JSON.parse(row.note_metadata) as Pick<LibraryItemDto, "pinned" | "tags" | "clipSource"> : {};
  return {
    ...metadata,
    ...(row.trashed_at != null ? { trashedAt: row.trashed_at } : {}),
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

export function toVersion(row: VersionRow): LibraryVersionDto {
  return {
    id: row.id,
    itemId: row.item_id,
    version: row.version,
    contentHash: row.content_hash,
    path: row.path,
    createdBy: row.created_by,
    sourceTaskId: row.source_task_id ?? undefined,
    createdAt: row.created_at,
  };
}

export interface LibraryCatalogRows {
  spaces: SpaceRow[];
  collections: CollectionRow[];
  items: ItemRow[];
  recentIds: string[];
  usedBytes: number;
}

export class LibraryRepository {
  private writeTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly db: Database,
    private readonly runtimeAuditReader?: import("../platform/runtime-audit").RuntimeAuditReader,
  ) {
    // Additive search-index metadata. No database schema-version bump: this table only
    // checkpoints derived-index format upgrades and can be rebuilt independently.
    if (!this.db.readonly) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS library_index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    }
  }

  get requiresRustWrites(): boolean {
    return Boolean(this.db.readonly || this.runtimeAuditReader?.supervised);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  enqueueBatch3(context: string, request: Record<string, unknown>): void {
    const reader = this.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    const op = this.writeTail.then(async () => {
      const res = await reader.batch3Write(request);
      if (res === undefined) throw new Error(`${context}：Rust 核心未响应`);
    });
    this.writeTail = op.then(() => undefined, () => undefined);
  }

  getIndexState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM library_index_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setIndexState(key: string, value: string): void {
    const updatedAt = Date.now();
    if (this.requiresRustWrites) {
      this.enqueueBatch3("保存资料索引状态", { kind: "librarySetIndexState", key, value, updatedAt });
      return;
    }
    this.db.prepare(`INSERT INTO library_index_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, updatedAt);
  }

  /** Text items that lost their derived FTS row after an interrupted/partial maintenance operation. */
  listTextFtsMissingCandidates(): string[] {
    if (!this.ftsAvailable()) return [];
    return (this.db.prepare(`SELECT id FROM library_items
      WHERE kind IN ('markdown','html','csv') AND trashed_at IS NULL AND id NOT IN (SELECT item_id FROM library_fts)
      ORDER BY created_at, rowid`).all() as Array<{ id: string }>).map((row) => row.id);
  }

  /** Older binaries indexed up to 200 or 256 KiB. */
  listTextFtsCoverageUpgradeCandidates(): string[] {
    return (this.db.prepare(`SELECT id FROM library_items
      WHERE kind IN ('markdown','html','csv') AND trashed_at IS NULL AND size_bytes > ?
      ORDER BY created_at, rowid`).all(200 * 1024) as Array<{ id: string }>).map((row) => row.id);
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("创建资料空间", {
        kind: "libraryInsertSpace",
        id: space.id,
        name: space.name,
        spaceKind: space.kind,
        projectId: space.projectId ?? null,
        workspaceId: space.workspaceId ?? null,
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
      });
      return;
    }
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("重命名资料空间", { kind: "libraryUpdateSpace", id, name, updatedAt });
      return;
    }
    this.db.prepare(`UPDATE library_spaces SET name = ?, updated_at = ? WHERE id = ?`).run(name, updatedAt, id);
  }

  deleteSpace(id: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("删除资料空间", { kind: "libraryDeleteSpace", id });
      return;
    }
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("创建资料文件夹", {
        kind: "libraryInsertCollection",
        id: collection.id,
        spaceId: collection.spaceId,
        parentId: collection.parentId ?? null,
        name: collection.name,
        owner: collection.owner ?? "",
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO library_collections (id, space_id, parent_id, name, owner, created_at, updated_at)
         VALUES (@id, @spaceId, @parentId, @name, @owner, @createdAt, @updatedAt)`,
      )
      .run(collection);
  }

  updateCollection(collection: LibraryCollectionDto): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新资料文件夹", {
        kind: "libraryUpdateCollection",
        id: collection.id,
        parentId: collection.parentId ?? null,
        name: collection.name,
        owner: collection.owner ?? "",
        updatedAt: collection.updatedAt,
      });
      return;
    }
    this.db
      .prepare(
        `UPDATE library_collections SET parent_id = @parentId, name = @name, owner = @owner,
           updated_at = @updatedAt WHERE id = @id`,
      )
      .run(collection);
  }

  deleteCollection(id: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("删除资料文件夹", { kind: "libraryDeleteCollection", id });
      return;
    }
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

  listItems(spaceId?: string, collectionId?: string | null, includeTrash = false): LibraryItemDto[] {
    const order = `ORDER BY title COLLATE NOCASE, rowid`;
    const active = includeTrash ? "1" : "trashed_at IS NULL";
    if (spaceId) {
      if (collectionId === undefined) {
        return (
          this.db
            .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE ${active} AND space_id = ? ${order}`)
            .all(spaceId) as ItemRow[]
        ).map(toItem);
      }
      if (collectionId === null) {
        return (
          this.db
            .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE ${active} AND space_id = ? AND collection_id IS NULL ${order}`)
            .all(spaceId) as ItemRow[]
        ).map(toItem);
      }
      return (
        this.db
          .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE ${active} AND space_id = ? AND collection_id = ? ${order}`)
          .all(spaceId, collectionId) as ItemRow[]
      ).map(toItem);
    }
    return (
      this.db
        .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE ${active} ${order}`)
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
      out.push(...this.listItems(spaceId, cid, true));
      for (const kid of this.listCollections(spaceId, cid)) walk(kid.id);
    };
    walk(collectionId);
    return out;
  }

  getItem(id: string, includeTrash = false): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE id = ?${includeTrash ? "" : " AND trashed_at IS NULL"}`)
      .get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  findByFilename(spaceId: string, filename: string): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND trashed_at IS NULL AND filename = ? COLLATE NOCASE LIMIT 1`)
      .get(spaceId, filename) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  findBySourceArtifact(spaceId: string, artifactId: string): LibraryItemDto | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM library_items WHERE space_id = ? AND trashed_at IS NULL AND source_artifact_id = ? LIMIT 1`)
      .get(spaceId, artifactId) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  insertItem(item: LibraryItemDto): void {
    const p = this.toParams(item);
    if (this.requiresRustWrites) {
      this.enqueueBatch3("创建资料条目", {
        kind: "libraryInsertItem",
        id: p.id,
        spaceId: p.spaceId,
        collectionId: p.collectionId,
        itemKind: p.kind,
        title: p.title,
        filename: p.filename,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
        owner: p.owner,
        favorite: p.favorite,
        url: p.url,
        sourceType: p.sourceType,
        sourceTaskId: p.sourceTaskId,
        sourceArtifactId: p.sourceArtifactId,
        originalPath: p.originalPath,
        contentHash: p.contentHash,
        extractStatus: p.extractStatus,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        lastVisitedAt: p.lastVisitedAt,
        trashedAt: p.trashedAt,
        noteMetadata: p.noteMetadata,
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO library_items (
           id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
           favorite, url, source_type, source_task_id, source_artifact_id, original_path,
           content_hash, extract_status, created_at, updated_at, last_visited_at, trashed_at, note_metadata
         ) VALUES (
           @id, @spaceId, @collectionId, @kind, @title, @filename, @mimeType, @sizeBytes, @owner,
           @favorite, @url, @sourceType, @sourceTaskId, @sourceArtifactId, @originalPath,
           @contentHash, @extractStatus, @createdAt, @updatedAt, @lastVisitedAt, @trashedAt, @noteMetadata
         )`,
      )
      .run(p);
  }

  updateItem(item: LibraryItemDto, previous: LibraryItemDto): void {
    const before = this.toParams(previous);
    const cur = this.toParams(item);
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新资料条目", {
        kind: "libraryUpdateItem",
        id: cur.id,
        collectionId: cur.collectionId,
        title: cur.title,
        filename: cur.filename,
        mimeType: cur.mimeType,
        sizeBytes: cur.sizeBytes,
        owner: cur.owner,
        favorite: cur.favorite,
        url: cur.url,
        sourceType: cur.sourceType,
        sourceTaskId: cur.sourceTaskId,
        sourceArtifactId: cur.sourceArtifactId,
        originalPath: cur.originalPath,
        contentHash: cur.contentHash,
        extractStatus: cur.extractStatus,
        updatedAt: cur.updatedAt,
        lastVisitedAt: cur.lastVisitedAt,
        trashedAt: cur.trashedAt,
        noteMetadata: cur.noteMetadata,
        prevCollection: before.collectionId,
        prevTitle: before.title,
        prevFilename: before.filename,
        prevSize: before.sizeBytes,
        prevHash: before.contentHash,
        prevTrash: before.trashedAt,
        prevMetadata: before.noteMetadata,
        prevUpdatedAt: before.updatedAt,
      });
      return;
    }
    // Keep note changes committed by the Rust worker while this operation was preparing its update.
    this.db
      .prepare(
        `UPDATE library_items SET
           collection_id = CASE WHEN @collectionId IS @previousCollection THEN collection_id ELSE @collectionId END,
           title = CASE WHEN @title = @previousTitle THEN title ELSE @title END,
           filename = CASE WHEN @filename = @previousFilename THEN filename ELSE @filename END, mime_type = @mimeType,
           size_bytes = CASE WHEN @sizeBytes = @previousSize THEN size_bytes ELSE @sizeBytes END,
           owner = @owner, favorite = @favorite, url = @url,
           source_type = @sourceType, source_task_id = @sourceTaskId,
           source_artifact_id = @sourceArtifactId, original_path = @originalPath,
           content_hash = CASE WHEN @contentHash IS @previousHash THEN content_hash ELSE @contentHash END,
           extract_status = @extractStatus,
           updated_at = CASE WHEN updated_at = @previousUpdatedAt THEN @updatedAt ELSE max(updated_at, @updatedAt) END,
           last_visited_at = @lastVisitedAt,
           trashed_at = CASE WHEN @trashedAt IS @previousTrash THEN trashed_at ELSE @trashedAt END,
           note_metadata = CASE WHEN @noteMetadata = @previousMetadata THEN note_metadata ELSE @noteMetadata END
         WHERE id = @id`,
      )
      .run({
        ...cur,
        previousCollection: before.collectionId,
        previousTitle: before.title,
        previousFilename: before.filename,
        previousSize: before.sizeBytes,
        previousHash: before.contentHash,
        previousTrash: before.trashedAt,
        previousMetadata: before.noteMetadata,
        previousUpdatedAt: before.updatedAt,
      });
  }

  deleteItem(id: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("删除资料条目", { kind: "libraryDeleteItem", id });
      return;
    }
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

  prepareLargeOfficeExtractionUpgrade(previousOutputChars: number): void {
    const versionKey = "large-office-extraction-version";
    if (this.requiresRustWrites) {
      if (this.getIndexState(versionKey) === "1") return;
      this.enqueueBatch3("升级大文档抽取状态", {
        kind: "librarySetExtractStatus",
        id: null,
        status: "pending",
        onlyIfMissing: true,
      });
      this.setIndexState(versionKey, "1");
      return;
    }
    this.db.transaction(() => {
      if (this.getIndexState(versionKey) === "1") return;
      this.db.prepare(`UPDATE library_items SET extract_status = 'pending'
        WHERE trashed_at IS NULL AND kind IN ('office', 'pdf') AND extract_status = 'unsupported'
          AND size_bytes > CASE WHEN lower(filename) LIKE '%.xlsx' THEN 20971520 ELSE 41943040 END`).run();
      if (this.ftsAvailable()) {
        // SQLite counts Unicode scalars; the former JS cap counted UTF-16 code units.
        this.db.prepare(`UPDATE library_items SET extract_status = 'pending'
          WHERE trashed_at IS NULL AND kind IN ('office', 'pdf') AND extract_status = 'extracted'
            AND id IN (SELECT item_id FROM library_fts WHERE length(body) >= ?)`)
          .run(Math.floor(previousOutputChars / 2));
      }
      this.setIndexState(versionKey, "1");
    })();
  }

  updateExtractStatus(id: string, status: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新资料抽取状态", {
        kind: "librarySetExtractStatus", id, status, onlyIfMissing: false,
      });
      return;
    }
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
  listChunkBackfillCandidates(limit = 500, afterRowId = 0): Array<{ id: string; rowId: number }> {
    if (!this.tableExists("library_chunks")) return [];
    return this.db.prepare(
      `SELECT id, rowid AS rowId FROM library_items
       WHERE rowid > ? AND trashed_at IS NULL AND id NOT IN (SELECT item_id FROM library_chunks)
       ORDER BY rowid LIMIT ?`,
    ).all(afterRowId, limit) as Array<{ id: string; rowId: number }>;
  }

  listRecent(limit = 40): LibraryItemDto[] {
    return (
      this.db
        .prepare(
          `SELECT ${ITEM_COLUMNS} FROM library_items
           WHERE trashed_at IS NULL AND kind != 'url' AND last_visited_at IS NOT NULL
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
           WHERE trashed_at IS NULL AND (title LIKE ? OR filename LIKE ?)
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新资料全文索引", {
        kind: "libraryUpsertFts", itemId, title, filename, body, clearOnly: false,
      });
      return;
    }
    // FTS5 无 UNIQUE 约束：必须先 DELETE 再 INSERT（INSERT OR REPLACE 只增不改，会累积旧内容行）
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(itemId);
      this.db
        .prepare(`INSERT INTO library_fts (item_id, title, filename, body) VALUES (?, ?, ?, ?)`)
        .run(itemId, title, filename, body);
    })();
  }

  deleteFts(itemId: string): void {
    if (!this.ftsAvailable()) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("清理资料全文索引", {
        kind: "libraryUpsertFts", itemId, title: null, filename: null, body: null, clearOnly: true,
      });
      return;
    }
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
        `SELECT id, space_id, kind, title, filename, favorite, source_type, source_task_id, updated_at, size_bytes
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
      size_bytes: number;
    }>;
    const needle = q.toLowerCase();
    const shortQuery = /^.{1,2}$/su.test(q);
    const exact = rows.filter((r) => r.title.toLowerCase() === needle);
    const prefix = rows.filter(
      (r) => !exact.includes(r) && r.title.toLowerCase().startsWith(needle),
    );
    const ftsHits = new Map<string, { score: number; snippet: string }>();
    if (this.ftsAvailable() && shortQuery) {
      const shortMatches = this.db.prepare(
        `SELECT item_id, substr(body, MAX(1, instr(lower(body), ?) - 20), 100) AS snip
         FROM library_fts JOIN library_items li ON li.id = library_fts.item_id
         WHERE ${where.sql} AND instr(lower(body), ?) > 0 ORDER BY li.updated_at DESC LIMIT ?`,
      ).all(needle, ...where.params, needle, opts.limit) as Array<{ item_id: string; snip: string }>;
      for (const row of shortMatches) ftsHits.set(row.item_id, { score: 0, snippet: row.snip });
    } else if (this.ftsAvailable()) {
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
    const largeTextRows = rows.filter(row =>
      row.size_bytes > LARGE_LIBRARY_TEXT_BYTES && this.isTextSearchable(row.kind as LibraryItemKind));
    if (largeTextRows.length > 0 && this.tableExists("library_chunks_fts")) {
      if (shortQuery) {
        const find = this.db.prepare(`
          SELECT substr(content, MAX(1, instr(lower(content), ?) - 20), 100) AS snip
          FROM library_chunks WHERE item_id = ? AND instr(lower(content), ?) > 0 LIMIT 1
        `);
        let matched = 0;
        for (const row of largeTextRows) {
          if (ftsHits.has(row.id)) continue;
          const hit = find.get(needle, row.id, needle) as { snip: string } | undefined;
          if (!hit) continue;
          ftsHits.set(row.id, { score: 0, snippet: hit.snip });
          if (++matched >= opts.limit) break;
        }
      } else {
        const phrase = `"${q.replaceAll('"', '""')}"`;
        const matches = this.db.prepare(`
          SELECT li.id AS item_id, bm25(library_chunks_fts) AS score,
                 snippet(library_chunks_fts, 2, '[', ']', '…', 14) AS snip
          FROM library_chunks_fts JOIN library_items li ON li.id = library_chunks_fts.item_id
          WHERE library_chunks_fts MATCH ? AND ${where.sql}
            AND li.size_bytes > ? AND li.kind IN ('markdown','html','csv')
          ${largeTextRows.length === 1 ? "LIMIT 1" : "ORDER BY score"}
        `).iterate(phrase, ...where.params, LARGE_LIBRARY_TEXT_BYTES) as Iterable<{ item_id: string; score: number; snip: string }>;
        const seen = new Set<string>();
        for (const match of matches) {
          if (seen.has(match.item_id)) continue;
          seen.add(match.item_id);
          if (!ftsHits.has(match.item_id)) ftsHits.set(match.item_id, { score: match.score, snippet: match.snip });
          if (seen.size >= Math.min(opts.limit, largeTextRows.length)) break;
        }
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
      .filter((r) => !metadataHitIds.has(r.id) && (ftsHits.has(r.id)
        || r.title.toLowerCase().includes(needle) || r.filename.toLowerCase().includes(needle)))
      .sort((a, b) => (ftsHits.get(a.id)?.score ?? 0) - (ftsHits.get(b.id)?.score ?? 0))
      .map((r) => ({ r, snip: ftsHits.get(r.id)?.snippet ?? "" }));
    for (const { r, snip } of ftsRanked) push(r, 2, snip);
    // 注意：不提供 recency 兜底桶——搜索语义 = 只返回真实命中（exact/prefix/FTS），
    // 无匹配返回空，绝不把无关条目当结果。
    return hits.slice(0, opts.limit);
  }

  /* ---------------- Chunk-level Locator (R2 §30) ---------------- */

  findLargeTextKeywordCandidates(query: string, scope: LibraryQueryScope): string[] {
    const where = libraryScopeWhere(scope, "li.");
    if (where.sql === "0" || !this.tableExists("library_chunks_fts")) return [];
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return (this.db.prepare(`
      SELECT DISTINCT li.id FROM library_chunks_fts
      JOIN library_items li ON li.id = library_chunks_fts.item_id
      WHERE library_chunks_fts MATCH ? AND ${where.sql}
        AND li.size_bytes > ? AND li.kind IN ('markdown','html','csv')
    `).pluck().all(phrase, ...where.params, LARGE_LIBRARY_TEXT_BYTES) as string[]);
  }

  replaceLargeTextIndex(item: LibraryItemDto, chunks: Iterable<LibraryChunk>): void {
    if (this.requiresRustWrites) {
      this.upsertFts(item.id, item.title, item.filename, "");
      this.replaceChunks(item.id, chunks, true);
      return;
    }
    this.db.transaction(() => {
      this.upsertFts(item.id, item.title, item.filename, "");
      this.replaceChunks(item.id, chunks, true);
    })();
  }

  replaceExtractedIndex(item: LibraryItemDto, text: string | null, status: string, chunks: Iterable<LibraryChunk>): void {
    if (this.requiresRustWrites) {
      this.updateExtractStatus(item.id, status);
      if (text === null) this.deleteFts(item.id);
      else this.upsertFts(item.id, item.title, item.filename, text);
      this.replaceChunks(item.id, chunks, true);
      return;
    }
    this.db.transaction(() => {
      this.updateExtractStatus(item.id, status);
      if (text === null) this.deleteFts(item.id);
      else this.upsertFts(item.id, item.title, item.filename, text);
      this.replaceChunks(item.id, chunks, true);
    })();
  }

  replaceLargeTextIndexFromStage(item: LibraryItemDto, file: string, chunkCount: number, updatedAt: number): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("合并大文本切片索引", {
        kind: "libraryMergeChunkStage",
        file,
        itemId: item.id,
        title: item.title,
        filename: item.filename,
        chunkCount,
        updatedAt,
        ftsAvailable: this.ftsAvailable(),
      });
      return;
    }
    this.db.prepare("ATTACH DATABASE ? AS library_index_stage").run(file);
    try {
      this.db.transaction(() => {
        this.upsertFts(item.id, item.title, item.filename, "");
        if (!this.tableExists("library_chunks")) return;
        this.db.prepare(
          "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at) "
          + "SELECT ? || chunk_index, ?, chunk_index, content, char_offset, hash, ? "
          + "FROM library_index_stage.chunks WHERE 1 ORDER BY chunk_index "
          + "ON CONFLICT(id) DO UPDATE SET chunk_index=excluded.chunk_index,content=excluded.content,"
          + "char_offset=excluded.char_offset,hash=excluded.hash,updated_at=excluded.updated_at",
        ).run(item.id + "#", item.id, updatedAt);
        if (this.tableExists("library_chunks_fts")) {
          this.db.prepare("DELETE FROM library_chunks_fts WHERE item_id=?").run(item.id);
          this.db.prepare(
            "INSERT INTO library_chunks_fts(item_id,chunk_id,content) "
            + "SELECT ?,? || chunk_index,content FROM library_index_stage.chunks ORDER BY chunk_index",
          ).run(item.id, item.id + "#");
        }
        this.pruneLargeChunks(item.id, chunkCount);
      })();
    } finally {
      this.db.exec("DETACH DATABASE library_index_stage");
    }
  }

  /** 批量写入 item 的 chunks（先删旧 chunk+FTS，再插入新）；item 删除时由 deleteItem 显式调用清理 */
  upsertChunks(
    itemId: string,
    chunks: Iterable<Omit<LibraryChunk, "itemId">>,
  ): void {
    this.replaceChunks(itemId, chunks, false);
  }

  private replaceChunks(
    itemId: string,
    chunks: Iterable<Omit<LibraryChunk, "itemId">>,
    reuseEmbeddings: boolean,
  ): void {
    if (!this.tableExists("library_chunks")) return;
    if (this.requiresRustWrites) {
      const list = Array.from(chunks, (c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        content: c.content,
        charOffset: c.charOffset,
        hash: c.hash,
        updatedAt: c.updatedAt,
      }));
      this.enqueueBatch3("更新资料切片索引", {
        kind: "libraryReplaceChunks",
        itemId,
        reuseEmbeddings,
        ftsAvailable: this.tableExists("library_chunks_fts"),
        chunks: list,
      });
      return;
    }
    this.db.transaction(() => {
      if (!reuseEmbeddings) this.db.prepare(`DELETE FROM library_chunks WHERE item_id = ?`).run(itemId);
      const hasFts = this.tableExists("library_chunks_fts");
      if (hasFts) {
        this.db.prepare(`DELETE FROM library_chunks_fts WHERE item_id = ?`).run(itemId);
      }
      const insertChunk = this.db.prepare(
        `INSERT INTO library_chunks (id, item_id, chunk_index, content, char_offset, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, content = excluded.content,
           char_offset = excluded.char_offset, hash = excluded.hash, updated_at = excluded.updated_at`,
      );
      const insertFts = hasFts
        ? this.db.prepare(`INSERT INTO library_chunks_fts (item_id, chunk_id, content) VALUES (?, ?, ?)`)
        : null;
      let count = 0;
      for (const c of chunks) {
        insertChunk.run(c.id, itemId, c.chunkIndex, c.content, c.charOffset, c.hash, c.updatedAt);
        insertFts?.run(itemId, c.id, c.content);
        count++;
      }
      if (reuseEmbeddings) this.pruneLargeChunks(itemId, count);
    })();
  }

  private pruneLargeChunks(itemId: string, count: number): void {
    this.db.prepare(`
      DELETE FROM library_chunk_embeddings
      WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM library_chunks c WHERE c.id = library_chunk_embeddings.chunk_id
            AND c.chunk_index < ? AND c.hash = library_chunk_embeddings.chunk_hash
        )
    `).run(itemId, count);
    this.db.prepare("DELETE FROM library_chunks WHERE item_id = ? AND chunk_index >= ?").run(itemId, count);
  }

  deleteChunks(itemId: string): void {
    if (!this.tableExists("library_chunks")) return;
    if (this.requiresRustWrites) {
      this.enqueueBatch3("清理资料切片索引", {
        kind: "libraryClearChunks",
        itemId,
        ftsAvailable: this.tableExists("library_chunks_fts"),
      });
      return;
    }
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

  deepSearchCandidates(
    scope: LibraryQueryScope,
    terms: string[],
    seen: ReadonlySet<string>,
    limit: number,
  ): LibraryEvidencePassage[] {
    const where = libraryScopeWhere(scope, "li.");
    if (where.sql === "0" || !terms.length) return [];
    if (!this.tableExists("library_chunks_fts")) throw new Error("资料全文索引不可用");
    const excluded = seen.size ? ` AND c.id NOT IN (${[...seen].map(() => "?").join(",")})` : "";
    const columns = `c.id AS chunkId, c.item_id AS itemId, li.space_id AS spaceId, li.title,
      c.content AS text, c.char_offset AS startOffset, c.hash AS chunkHash`;
    const longTerms = terms.filter((term) => [...term].length >= 3);
    const fts = longTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const rows = fts ? this.db.prepare(`SELECT ${columns}
      FROM library_chunks_fts
      JOIN library_chunks c ON c.id = library_chunks_fts.chunk_id
      JOIN library_items li ON li.id = c.item_id
      WHERE library_chunks_fts MATCH ? AND ${where.sql}${excluded}
      ORDER BY bm25(library_chunks_fts), c.id LIMIT ?`).all(fts, ...where.params, ...seen, limit) as LibraryEvidencePassage[] : [];
    if (rows.length) return rows;
    if (fts && this.ftsAvailable()) {
      const titleMatches = this.db.prepare(`SELECT ${columns}
        FROM library_fts JOIN library_items li ON li.id = library_fts.item_id
        JOIN library_chunks c ON c.id = (
          SELECT first.id FROM library_chunks first WHERE first.item_id = li.id ORDER BY first.chunk_index LIMIT 1
        )
        WHERE library_fts MATCH ? AND ${where.sql}${excluded}
        ORDER BY bm25(library_fts), c.id LIMIT ?`)
        .all(`{title filename} : (${fts})`, ...where.params, ...seen, limit) as LibraryEvidencePassage[];
      if (titleMatches.length) return titleMatches;
    }

    // Trigram cannot match two-character Chinese names and identifiers.
    const shortTerms = terms.filter((term) => [...term].length < 3);
    if (!shortTerms.length) return [];
    return this.db.prepare(`SELECT ${columns}
      FROM library_chunks c JOIN library_items li ON li.id = c.item_id
      WHERE ${where.sql}${excluded}
        AND (${shortTerms.map(() => "instr(lower(c.content), ?) > 0").join(" OR ")})
      ORDER BY c.id LIMIT ?`).all(...where.params, ...seen, ...shortTerms, limit) as LibraryEvidencePassage[];
  }

  isDeepSearchPassageCurrent(scope: LibraryQueryScope, passage: LibraryEvidencePassage): boolean {
    const where = libraryScopeWhere(scope, "li.");
    if (where.sql === "0") return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM library_chunks c JOIN library_items li ON li.id = c.item_id
      WHERE c.id = ? AND c.hash = ? AND c.char_offset = ? AND li.title = ? AND li.space_id = ? AND ${where.sql}`)
      .get(passage.chunkId, passage.chunkHash, passage.startOffset, passage.title, passage.spaceId, ...where.params));
  }

  deepSearchTermFrequencies(scope: LibraryQueryScope, terms: string[]): Map<string, number> {
    const where = libraryScopeWhere(scope, "li.");
    if (where.sql === "0" || !terms.length) return new Map();
    // FTS postings only. Treat frequent terms as equally common once the scoped sample fills.
    const count = this.db.prepare(`SELECT COUNT(*) AS hits FROM (
      SELECT 1 FROM library_chunks_fts
      JOIN library_items li ON li.id = library_chunks_fts.item_id
      WHERE library_chunks_fts MATCH ? AND ${where.sql} LIMIT 64
    )`);
    return new Map(terms.map((term) => {
      const { hits } = count.get(`"${term.replaceAll('"', '""')}"`, ...where.params) as { hits: number };
      return [term, hits];
    }));
  }

  readDeepSearchPassage(scope: LibraryQueryScope, itemId: string, offset: number, hash: string): string | undefined {
    const where = libraryScopeWhere(scope, "li.");
    if (where.sql === "0") return undefined;
    const row = this.db.prepare(`SELECT c.content AS text FROM library_chunks c JOIN library_items li ON li.id = c.item_id
      WHERE c.item_id = ? AND c.char_offset = ? AND c.hash = ? AND ${where.sql}`)
      .get(itemId, offset, hash, ...where.params) as { text: string } | undefined;
    return row?.text;
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

  insertVersion(version: LibraryVersionDto, snapshot?: Buffer): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("保存资料历史版本", {
        kind: "libraryInsertVersion",
        id: version.id,
        itemId: version.itemId,
        version: version.version,
        contentHash: version.contentHash,
        path: version.path,
        createdBy: version.createdBy ?? "",
        sourceTaskId: version.sourceTaskId ?? null,
        createdAt: version.createdAt,
        snapshotBase64: snapshot ? snapshot.toString("base64") : null,
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO library_versions (id, item_id, version, content_hash, path, created_by, source_task_id, created_at, snapshot)
         VALUES (@id, @itemId, @version, @contentHash, @path, @createdBy, @sourceTaskId, @createdAt, @snapshot)`,
      )
      .run({ ...version, sourceTaskId: version.sourceTaskId ?? null, snapshot: snapshot ?? null });
  }

  versionContent(itemId: string, version: number): { path: string; content_hash: string; snapshot: Buffer | null } | undefined {
    return this.db.prepare("SELECT path, content_hash, snapshot FROM library_versions WHERE item_id = ? AND version = ?")
      .get(itemId, version) as ReturnType<LibraryRepository["versionContent"]>;
  }

  deleteVersion(id: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("删除资料历史版本", { kind: "libraryDeleteVersion", id });
      return;
    }
    this.db.prepare(`DELETE FROM library_versions WHERE id = ?`).run(id);
  }
  listVersions(itemId: string, limit = -1): LibraryVersionDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, item_id, version, content_hash, path, created_by, source_task_id, created_at
           FROM library_versions WHERE item_id = ? ORDER BY version DESC LIMIT ?`,
        )
        .all(itemId, limit) as VersionRow[]
    ).map(toVersion);
  }

  nextVersion(itemId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM library_versions WHERE item_id = ?`)
      .get(itemId) as { n: number };
    return Number(row.n) || 1;
  }

  /* ---------------- TaskLibraryReference ---------------- */

  insertReference(ref: LibraryTaskReferenceDto): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("关联任务资料", {
        kind: "libraryTaskReference",
        action: "add",
        taskId: ref.taskId,
        itemId: ref.itemId,
        projectId: ref.projectId ?? null,
        addedAt: ref.addedAt,
        addedBy: ref.addedBy ?? "",
      });
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_library_references (task_id, item_id, project_id, added_at, added_by)
         VALUES (@taskId, @itemId, @projectId, @addedAt, @addedBy)`,
      )
      .run({ ...ref, projectId: ref.projectId ?? null });
  }

  deleteReference(taskId: string, itemId: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("解除任务资料关联", {
        kind: "libraryTaskReference",
        action: "remove",
        taskId,
        itemId,
        projectId: null,
        addedAt: null,
        addedBy: null,
      });
      return;
    }
    this.db
      .prepare(`DELETE FROM task_library_references WHERE task_id = ? AND item_id = ?`)
      .run(taskId, itemId);
  }

  deleteReferencesByTask(taskId: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("清空任务资料关联", {
        kind: "libraryTaskReference",
        action: "clearTask",
        taskId,
        itemId: null,
        projectId: null,
        addedAt: null,
        addedBy: null,
      });
      return;
    }
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
      trashedAt: item.trashedAt ?? null,
      noteMetadata: JSON.stringify({ pinned: item.pinned, tags: item.tags, clipSource: item.clipSource }),
    };
  }
}
