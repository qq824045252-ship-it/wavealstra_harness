import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import { getLibraryDir } from "../paths";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";
import { LibraryRepository } from "./LibraryRepository";
import { assertArtifactSaveOwner, ensureOwnedLibrarySpace, ownedLibraryQueryScope, type LibraryOwnerReference } from "./library-ownership";
import {
  isLibrarySpacePermittedForProject,
  itemVisibleInTaskScope,
  queryScopeForTask,
  resolveLibraryTaskScope,
  type LibraryTaskScope,
  type LibraryTaskScopeOptions,
} from "./library-task-scope";
export type { LibraryTaskScope, LibraryTaskScopeOptions } from "./library-task-scope";
import { assertManagedPathSafe, assertManagedWritePathSafe, atomicCopyFileSync, atomicWriteFileSync } from "./library-file-io";
import {
  ContentExtractorRegistry,
  defaultBudget,
  type ExtractionResult,
} from "./ContentExtractorRegistry";
import { chunkText } from "./library-chunker";
import {
  SemanticModelManager,
  SEMANTIC_DIMENSION,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_VERSION,
} from "../retrieval/SemanticModelManager";
import { getSemanticRuntime } from "../retrieval/SemanticRuntime";
import {
  LIBRARY_CONTENT_MAX_CHARS,
  LIBRARY_NAME_MAX_CHARS,
  LIBRARY_PERSONAL_SPACE_ID,
  LIBRARY_TITLE_MAX_CHARS,
  type LibraryArtifactDto,
  type LibraryAttachRequest,
  type LibraryCollectionDto,
  type LibraryContentDto,
  type LibraryCreateCollectionRequest,
  type LibraryCreateItemRequest,
  type LibraryCreateSpaceRequest,
  type LibraryCreateUrlRequest,
  type LibraryDetachRequest,
  type LibraryFavoriteRequest,
  type LibraryImportFileRequest,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibraryListRowDto,
  type LibraryMoveCollectionRequest,
  type LibraryOwnerScope,
  type LibraryRenameCollectionRequest,
  type LibraryRetrievalHitDto,
  type LibrarySaveArtifactRequest,
  type LibrarySnapshotDto,
  type LibrarySpaceDto,
  type LibraryTaskReferenceDto,
  type LibraryTaskReferencesDto,
  type LibraryUpdateItemRequest,
  type LibraryWriteContentRequest,
} from "../../shared/library-ipc";

export class LibraryMaterializationPartialStateError extends Error {
  constructor(
    public readonly entityKind: "space" | "item",
    public readonly entityId: string,
    public readonly retainedPath: string | undefined,
    public readonly originalMessage: string,
  ) {
    super(
      `资料库${entityKind === "space" ? "空间" : "条目"}写入失败且回滚不完整：${originalMessage}` +
      `；残留 id=${entityId}${retainedPath ? `；残留路径=${retainedPath}` : ""}`,
    );
    this.name = "LibraryMaterializationPartialStateError";
  }
}
export class LibraryUpdatePartialStateError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly retainedPath: string | undefined,
    public readonly originalMessage: string,
    public readonly rollbackMessage: string,
  ) {
    super(
      `资料库条目更新失败且回滚不完整：${originalMessage}；item=${itemId}` +
      `${retainedPath ? `；path=${retainedPath}` : ""}；rollback=${rollbackMessage}`,
    );
    this.name = "LibraryUpdatePartialStateError";
  }
}
/** 单次导入/保存到受管库的最大字节数（显式拒绝超大文件，避免整份复制拖垮） */
export const LIBRARY_MAX_IMPORT_BYTES = 256 * 1024 * 1024;

const WELCOME_TITLE = "一分钟玩转资料库";

const WELCOME_MD = `# 一分钟玩转资料库

资料库不是网盘：它让 **Markdown、CSV、HTML** 三种载体互相引用、彼此联动。

| 形态 | 职责 | 典型用途 |
| --- | --- | --- |
| **MD** | 决定内容 | 方案、周报、说明 |
| **CSV** | 存储数据 | 清单、流水、看板数据 |
| **HTML** | 负责表达 | 工作台、演示页、轻应用 |

## 按归属管理

- **项目资料**：在项目内管理，供该项目的任务使用
- **工作空间资料**：在对应工作空间管理；子工作空间可读取继承资料
- **个人资料**：独立任务的默认保存位置；需要在项目或工作空间使用时显式引用
- 任务产物可保存为长期资料；保存会保留原件及来源记录

## 怎么引用

- 同空间文件用相对路径：\`fetch('./待买清单.csv')\`
- 任意条目用协议：\`mybuddy-library://local/<条目ID>/\`
- Agent 从提示词里的资料库目录按需检索；完整内容用 library_read / 文件工具读取

办公文件（Word / Excel / PPT / PDF）和图片也可以上传到同一棵树；它们是受管副本，
资料库内不提供内联编辑，读取走文件/预览工具。
`;

const TEXT_SEARCH_MAX_BYTES = 256 * 1024;

function mimeForKind(kind: LibraryItemKind): string {
  switch (kind) {
    case "markdown":
      return "text/markdown";
    case "html":
      return "text/html";
    case "csv":
      return "text/csv";
    case "office":
      return "application/octet-stream";
    case "pdf":
      return "application/pdf";
    case "image":
      return "image/*";
    case "url":
      return "text/uri-list";
    default:
      return "application/octet-stream";
  }
}

/** 按文件名给出精确 mime（Office/PDF 抽取器按 mime 匹配；导入/产物保存路径使用） */
function preciseMimeFromFilename(name: string): string {
  const ext = extname(name).toLowerCase();
  switch (ext) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".pdf":
      return "application/pdf";
    default:
      return "";
  }
}

function kindFromFilename(name: string): LibraryItemKind {
  const ext = extname(name).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".txt":
      return "markdown";
    case ".html":
    case ".htm":
      return "html";
    case ".csv":
      return "csv";
    case ".docx":
    case ".doc":
    case ".xlsx":
    case ".xls":
    case ".pptx":
    case ".ppt":
      return "office";
    case ".pdf":
      return "pdf";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".avif":
    case ".bmp":
    case ".ico":
    case ".svg":
      return "image";
    default:
      return "file";
  }
}

function extForKind(kind: LibraryItemKind): string {
  switch (kind) {
    case "markdown":
      return ".md";
    case "html":
      return ".html";
    case "csv":
      return ".csv";
    default:
      return "";
  }
}

function defaultTitle(kind: LibraryCreateItemRequest["kind"]): string {
  switch (kind) {
    case "markdown":
      return "未命名文档";
    case "html":
      return "未命名页面";
    case "csv":
      return "未命名表格";
  }
}

function seedContent(kind: LibraryCreateItemRequest["kind"], title: string): string {
  if (kind === "markdown") return `# ${title}\n\n`;
  if (kind === "csv") return "项目,状态,备注\n";
  if (kind === "html") {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", system-ui, sans-serif; }
    body { margin: 32px auto; max-width: 880px; color: #1a1a19; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    .hint { color: #6b7280; font-size: 13px; line-height: 1.6; }
    code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 18px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; font-size: 13px; }
    th { background: #f8fafc; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="hint">
    这是资料库页面。用相对路径引用同空间的 CSV，例如 <code>fetch('./数据.csv')</code>；
    或按 ID 引用 <code>mybuddy-library://local/条目ID/</code>。改一处，页面刷新后生效。
  </p>
  <div id="data"></div>
</body>
</html>
`;
  }
  return "";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeName(name: string): string {
  const trimmed = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  return trimmed || "未命名";
}

/** 服务层统一长度上限（渲染器/工具/IPC 任何入口不可绕过；超限抛错而非静默截断） */

function limitText(value: string, max: number, field: string): string {
  if (value.length > max) {
    throw new Error(`${field}不能超过 ${max} 字符`);
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 文件字节 hash（文本/二进制统一；用于 artifact 内容一致性判定） */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".md":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export class LibraryService {
  private readonly repo: LibraryRepository;
  readonly root: string;
  private readonly extractors: ContentExtractorRegistry = new ContentExtractorRegistry();
  /** 抽取缓存（itemId → 内容；按 size+mtime 失效；容量上限 64 条，防会话内重复解析） */
  private readonly extractCache = new Map<string, { key: string; result: ExtractionResult }>();
  /** 进行中的异步抽取（写入后 fire-and-forget；测试/关闭前可 flush） */
  private readonly pendingIndexes = new Set<Promise<void>>();
  /** per-item in-flight 去重：同一条目并发 search/read 只解析一次 */
  private readonly inflightExtract = new Map<string, Promise<ExtractionResult>>();
  /** 仅保存需要文件级 targeted fallback 的文本条目；健康 FTS 搜索不做额外 DB 反查。 */
  private readonly textFtsFallbackIds = new Set<string>();

  constructor(
    private readonly db: AppDatabase,
    opts?: { libraryRoot?: string },
  ) {
    this.repo = new LibraryRepository(db.connection);
    this.root = opts?.libraryRoot ?? getLibraryDir();
    mkdirSync(this.root, { recursive: true });
    this.refreshTextFtsFallbackState();
  }

  private refreshTextFtsFallbackState(): void {
    this.textFtsFallbackIds.clear();
    if (!this.repo.ftsAvailable()) return;
    for (const id of this.repo.listTextFtsMissingCandidates()) this.textFtsFallbackIds.add(id);
    if (Number(this.repo.getIndexState("text-fts-coverage-version") ?? 0) < 2) {
      for (const id of this.repo.listTextFtsCoverageUpgradeCandidates()) this.textFtsFallbackIds.add(id);
    }
  }
  ensureReady(): LibrarySpaceDto {
    const existing = this.repo.getSpace(LIBRARY_PERSONAL_SPACE_ID);
    if (existing) return existing;
    const now = Date.now();
    const personal: LibrarySpaceDto = {
      id: LIBRARY_PERSONAL_SPACE_ID,
      name: "我的文档",
      kind: "personal",
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertSpace(personal);
    // 引导文只在 personal 空间首次创建时播种；用户删除后不得在 snapshot() 中自动复活。
    this.seedWelcomeIfEmpty(personal);
    return personal;
  }

  ensureOwnedSpace(owner: LibraryOwnerScope): LibrarySpaceDto {
    return this.withOwnerName(ensureOwnedLibrarySpace(this.db, this.repo, owner, (req) => this.createSpace(req), () => this.ensureReady()));
  }

  resolveTaskScope(taskId?: string | null, projectFallback?: string | null, options?: LibraryTaskScopeOptions): LibraryTaskScope {
    return resolveLibraryTaskScope(this.db, this.repo, taskId, projectFallback, options);
  }

  isSpaceVisibleInScope(space: LibrarySpaceDto, scope: LibraryTaskScope): boolean {
    return isLibrarySpacePermittedForProject(space, scope.projectId) && scope.visibleSpaceIds.has(space.id);
  }

  isItemVisibleInScope(item: LibraryItemDto, scope: LibraryTaskScope): boolean {
    const space = this.repo.getSpace(item.spaceId);
    return Boolean(space && this.isSpaceVisibleInScope(space, scope) && itemVisibleInTaskScope(item, scope));
  }

  isSpaceWritableInScope(space: LibrarySpaceDto, scope: LibraryTaskScope): boolean {
    if (!scope.writableSpaceIds.has(space.id) || !this.isSpaceVisibleInScope(space, scope)) return false;
    if (scope.projectId && this.isProjectArchived(scope.projectId)) return false;
    if (space.projectId) return space.projectId === scope.projectId && !this.isProjectArchived(space.projectId);
    if (space.workspaceId) return space.workspaceId === scope.workspaceId && Boolean(this.db.getSpace(space.workspaceId)) && !this.db.isSpaceEffectiveArchived(space.workspaceId);
    return space.kind === "personal" && !scope.projectId && !scope.workspaceId;
  }

  isItemWritableInScope(item: LibraryItemDto, scope: LibraryTaskScope): boolean {
    const space = this.repo.getSpace(item.spaceId);
    return Boolean(space && this.isSpaceWritableInScope(space, scope));
  }

  listItemsInScope(scope: LibraryTaskScope): LibraryItemDto[] {
    return this.repo.listItemsInScope(queryScopeForTask(scope));
  }

  listItemsForTask(taskId?: string | null, projectFallback?: string | null): LibraryItemDto[] {
    return this.listItemsInScope(this.resolveTaskScope(taskId, projectFallback));
  }

  searchInScope(query: string, scope: LibraryTaskScope): LibraryListRowDto[] {
    return this.search(query, queryScopeForTask(scope));
  }

  searchForTask(query: string, taskId?: string | null, projectFallback?: string | null): LibraryListRowDto[] {
    return this.searchInScope(query, this.resolveTaskScope(taskId, projectFallback));
  }

  searchOwnedScope(query: string, owner: LibraryOwnerScope, reference?: LibraryOwnerReference): LibraryListRowDto[] {
    const scope = ownedLibraryQueryScope(this.db, this.repo, owner, reference);
    if (!scope.spaceIds.size && !scope.collectionIds?.size && !scope.itemIds?.size) return [];
    return this.search(query, scope);
  }

  retrieveInScope(query: string, scope: LibraryTaskScope, opts?: { limit?: number }): LibraryRetrievalHitDto[] {
    return this.retrieve(query, { ...queryScopeForTask(scope), limit: opts?.limit });
  }

  defaultSpaceForTask(taskId?: string | null, projectFallback?: string | null): LibrarySpaceDto {
    const scope = this.resolveTaskScope(taskId, projectFallback);
    if (!scope.defaultOwner) throw new Error("无法确定有效任务的资料归属");
    const space = this.ensureOwnedSpace(scope.defaultOwner);
    if (!this.isSpaceWritableInScope(space, this.resolveTaskScope(taskId, projectFallback))) {
      throw new Error("当前任务的资料归属已归档或不可写");
    }
    return space;
  }

  snapshot(): LibrarySnapshotDto {
    this.ensureReady();
    const spaces = this.repo.listSpaces().map((space) => this.withOwnerName(space));
    const collections = this.repo.listCollections();
    const items = this.repo.listItems();
    const ownerName = this.ownerName();
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    const recent = this.repo.listRecent().map((item) => this.toRow(item, spaceName.get(item.spaceId) ?? "我的文档"));
    return {
      spaces,
      collections,
      items,
      recent,
      artifacts: this.listLocalArtifacts(ownerName),
      storage: { usedBytes: this.repo.totalBytes() },
      ownerName,
    };
  }

  listItems(spaceId: string, collectionId?: string | null): LibraryItemDto[] {
    this.ensureReady();
    return this.repo.listItems(spaceId, collectionId);
  }

  /** 全量条目（Agent 工具用；可选按空间过滤） */
  listAllItems(spaceId?: string): LibraryItemDto[] {
    this.ensureReady();
    return this.repo.listItems(spaceId);
  }

  getItem(id: string): LibraryItemDto | null {
    return this.repo.getItem(id);
  }

  /** 空间查询（Agent 工具授权与测试共用） */
  getSpace(id: string): LibrarySpaceDto | null {
    return this.repo.getSpace(id);
  }

  /** 集合查询（Agent 工具作用域校验用） */
  getCollection(id: string): LibraryCollectionDto | null {
    return this.repo.getCollection(id);
  }

  /** 资料库文件夹列表（Workspace binding UI / scope resolver 共用）。 */
  listCollections(spaceId?: string): LibraryCollectionDto[] {
    return this.repo.listCollections(spaceId);
  }

  /** 文件夹作用域包含自身 + 全部后代；跨空间移动被 LibraryService 禁止，因此 id 集合稳定归属同一 space。 */
  listCollectionSubtreeIds(collectionId: string): string[] {
    const root = this.repo.getCollection(collectionId);
    if (!root) return [];
    return [root.id, ...this.repo.listCollectionsRecursive(root.spaceId, root.id).map((c) => c.id)];
  }

  /** 项目是否归档（写工具门禁：归档项目只读） */
  isProjectArchived(projectId: string): boolean {
    try {
      const row = this.db.connection
        .prepare(`SELECT archived FROM projects WHERE id = ?`)
        .get(projectId) as { archived: number } | undefined;
      return Boolean(row?.archived);
    } catch {
      return false;
    }
  }

  /** Artifact 来源作用域（Agent save_artifact 校验：本任务或同项目任务的产物才可晋升） */
  getArtifactScope(artifactId: string): { taskId: string | null; projectId: string | null } | null {
    try {
      const row = this.db.connection
        .prepare(
          `SELECT a.task_id, t.project_id
           FROM artifacts a
           LEFT JOIN tasks t ON t.id = a.task_id
           WHERE a.id = ?`,
        )
        .get(artifactId) as { task_id: string | null; project_id: string | null } | undefined;
      return row ? { taskId: row.task_id, projectId: row.project_id } : null;
    } catch {
      return null;
    }
  }

  listSpaces(): LibrarySpaceDto[] {
    return this.repo.listSpaces();
  }

  /* ---------------- Spaces ---------------- */

  createSpace(req: LibraryCreateSpaceRequest): LibrarySpaceDto {
    this.ensureReady();
    if (req.projectId && req.workspaceId) throw new Error("资料空间只能归属于一个项目或工作空间");
    if (req.projectId && !this.projectExists(req.projectId)) {
      throw new Error("项目不存在");
    }
    if (req.projectId && this.isProjectArchived(req.projectId)) {
      throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
    if (req.workspaceId && !this.db.getSpace(req.workspaceId)) throw new Error("工作空间不存在");
    if (req.workspaceId && this.db.isSpaceEffectiveArchived(req.workspaceId)) throw new Error("已归档工作空间的资料只可读取");
    const name = limitText(safeName(req.name), LIBRARY_NAME_MAX_CHARS, "空间名称");
    const now = Date.now();
    const space: LibrarySpaceDto = {
      id: randomUUID(),
      name,
      kind: "team",
      projectId: req.projectId,
      workspaceId: req.workspaceId,
      createdAt: now,
      updatedAt: now,
    };
    const spacePath = this.spaceDir(space.id);
    let rowInserted = false;
    try {
      this.repo.insertSpace(space);
      rowInserted = true;
      mkdirSync(spacePath, { recursive: true });
      return this.withOwnerName(space);
    } catch (error) {
      let retained = false;
      if (rowInserted) {
        try { this.repo.deleteSpace(space.id); rowInserted = false; }
        catch { retained = true; }
      }
      if (!rowInserted) {
        try { rmSync(spacePath, { recursive: true, force: true }); }
        catch { retained = true; }
      }
      if (retained) {
        throw new LibraryMaterializationPartialStateError(
          "space",
          space.id,
          existsSync(spacePath) ? spacePath : undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  listProjectSpaces(projectId: string): LibrarySpaceDto[] {
    this.ensureReady();
    return this.repo.listProjectSpaces(projectId).map((space) => this.withOwnerName(space));
  }

  listWorkspaceSpaces(workspaceId: string): LibrarySpaceDto[] {
    return this.repo.listWorkspaceSpaces(workspaceId).map((space) => this.withOwnerName(space));
  }

  renameSpace(id: string, name: string): LibrarySpaceDto {
    const space = this.repo.getSpace(id);
    if (!space) throw new Error("空间不存在");
    if (space.kind === "personal") throw new Error("个人文档空间不能改名");
    this.assertSpaceWritable(space);
    const next = safeName(name);
    const now = Date.now();
    this.repo.updateSpace(id, next, now);
    return { ...space, name: next, updatedAt: now };
  }

  /**
   * 删除空间：递归删除其全部集合/条目/受管文件后删空间行。
   * 项目资料随项目删除（deleteProjectLibrary）走同一路径，语义一致。
   */
  deleteSpace(id: string): void {
    const space = this.repo.getSpace(id);
    if (!space) throw new Error("空间不存在");
    if (space.kind === "personal") throw new Error("个人文档空间不能删除");
    this.assertSpaceWritable(space);
    this.deleteSpaceUnchecked(space);
  }

  private deleteSpaceUnchecked(space: LibrarySpaceDto): void {
    const items = this.repo.listItems(space.id);
    const collections = this.repo.listCollections(space.id);
    // Durable DB state is the commit point. Files are removed only after the entire hierarchy
    // has been deleted successfully, so a DB failure can never leave live rows pointing at missing files.
    this.db.connection.transaction(() => {
      for (const item of items) this.repo.deleteItem(item.id);
      for (const collection of [...collections].reverse()) {
        this.db.deleteLibraryCollectionLinks(collection.id);
        this.repo.deleteCollection(collection.id);
      }
      this.db.deleteLibrarySpaceLinks(space.id);
      this.repo.deleteSpace(space.id);
    })();
    for (const item of items) this.removeFileAfterDurableDelete(item);
    try { rmSync(this.spaceDir(space.id), { recursive: true, force: true }); }
    catch (error) { console.warn(`[Library] 空间 ${space.id} 已删除，但目录清理失败（orphan）`, error); }
  }
  /** 项目删除语义：级联删除该项目全部资料空间（集合/条目/版本/引用/受管文件）。personal 不受影响。 */
  deleteProjectLibrary(projectId: string): void {
    for (const space of this.repo.listProjectSpaces(projectId)) {
      this.deleteSpaceUnchecked(space);
    }
  }

  /* ---------------- Collections ---------------- */

  createCollection(req: LibraryCreateCollectionRequest): LibraryCollectionDto {
    this.ensureReady();
    this.requireWritableSpace(req.spaceId);
    const parentId = req.parentId ?? null;
    if (parentId) this.requireCollectionInSpace(req.spaceId, parentId);
    const now = Date.now();
    const collection: LibraryCollectionDto = {
      id: randomUUID(),
      spaceId: req.spaceId,
      parentId,
      name: limitText(safeName(req.name?.trim() || "未命名文件夹"), LIBRARY_NAME_MAX_CHARS, "集合名称"),
      owner: this.ownerName(),
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertCollection(collection);
    return collection;
  }

  renameCollection(req: LibraryRenameCollectionRequest): LibraryCollectionDto {
    const collection = this.repo.getCollection(req.id);
    if (!collection) throw new Error("集合不存在");
    this.requireWritableSpace(collection.spaceId);
    const next = { ...collection, name: limitText(safeName(req.name), LIBRARY_NAME_MAX_CHARS, "集合名称"), updatedAt: Date.now() };
    this.repo.updateCollection(next);
    return next;
  }

  /** 移动集合：必须同空间；禁止移入自身/后代（环校验）；禁止跨 scope/project */
  moveCollection(req: LibraryMoveCollectionRequest): LibraryCollectionDto {
    const collection = this.repo.getCollection(req.id);
    if (!collection) throw new Error("集合不存在");
    this.requireWritableSpace(collection.spaceId);
    const targetParentId = req.parentId ?? null;
    if (targetParentId) {
      if (targetParentId === collection.id) throw new Error("不能把集合移入自身");
      const parent = this.repo.getCollection(targetParentId);
      if (!parent || parent.spaceId !== collection.spaceId) {
        throw new Error("目标集合不存在或不属于同一空间（禁止跨项目/跨作用域移动）");
      }
      // 环校验：目标位于本集合子树内（目标祖先链含本集合）→ 拒绝
      if (this.repo.collectionAncestors(targetParentId).includes(collection.id)) {
        throw new Error("不能把集合移入自己的子集合");
      }
    }
    const next = { ...collection, parentId: targetParentId, updatedAt: Date.now() };
    this.repo.updateCollection(next);
    return next;
  }

  /** 删除集合：递归删除子集合 + 全部条目（受管文件） */
  deleteCollection(id: string): void {
    const collection = this.repo.getCollection(id);
    if (!collection) throw new Error("集合不存在");
    this.requireWritableSpace(collection.spaceId);
    this.deleteCollectionRecursive(collection);
  }

  /* ---------------- Items ---------------- */

  createItem(req: LibraryCreateItemRequest): LibraryItemDto {
    this.ensureReady();
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const title = limitText(safeName(req.title?.trim() || defaultTitle(req.kind)), LIBRARY_TITLE_MAX_CHARS, "标题");
    const now = Date.now();
    const id = randomUUID();
    const ext = extForKind(req.kind);
    const filename = `${title}${ext}`;
    const item: LibraryItemDto = {
      id,
      spaceId: req.spaceId,
      collectionId: req.collectionId ?? null,
      kind: req.kind,
      title,
      filename,
      mimeType: mimeForKind(req.kind),
      sizeBytes: 0,
      owner: this.ownerName(),
      favorite: false,
      sourceType: "created",
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    const body = seedContent(req.kind, title);
    item.sizeBytes = Buffer.byteLength(body);
    item.contentHash = sha256(body);
    return this.commitNewManagedItem(item, () => this.writeManagedFile(item, body));
  }

  createUrl(req: LibraryCreateUrlRequest): LibraryItemDto {
    this.ensureReady();
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const raw = req.url.trim();
    if (!raw) throw new Error("URL 不能为空");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("URL 格式无效");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("仅支持 http(s) 链接");
    }
    const title = limitText(safeName(req.title?.trim() || url.hostname + url.pathname.replace(/\/+$/, "")), LIBRARY_TITLE_MAX_CHARS, "标题");
    const now = Date.now();
    const item: LibraryItemDto = {
      id: randomUUID(),
      spaceId: req.spaceId,
      collectionId: req.collectionId ?? null,
      kind: "url",
      title,
      filename: `${title}.url`,
      mimeType: mimeForKind("url"),
      sizeBytes: 0,
      owner: this.ownerName(),
      favorite: false,
      url: url.href,
      sourceType: "url",
      extractStatus: "pending",
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    this.repo.insertItem(item);
    return item;
  }

  updateItem(req: LibraryUpdateItemRequest): LibraryItemDto {
    const item = this.repo.getItem(req.id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    const next = { ...item, updatedAt: Date.now() };
    if (req.title !== undefined) {
      next.title = limitText(safeName(req.title), LIBRARY_TITLE_MAX_CHARS, "标题");
      next.filename = item.kind === "url" ? `${next.title}.url` : `${next.title}${extname(item.filename) || extForKind(item.kind)}`;
    }
    if (req.collectionId !== undefined) {
      const target = req.collectionId ?? null;
      if (target) this.requireCollectionInSpace(item.spaceId, target);
      next.collectionId = target;
    }
    const unchanged = next.title === item.title && next.filename === item.filename && next.collectionId === item.collectionId;
    if (unchanged) return item;
    try {
      this.repo.updateItem(next);
      this.refreshFts(next);
      return next;
    } catch (error) {
      const rollbackErrors: string[] = [];
      try { this.repo.updateItem(item); }
      catch (rollbackError) { rollbackErrors.push(`metadata=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      try { this.refreshFts(item); }
      catch (rollbackError) { rollbackErrors.push(`fts=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      if (rollbackErrors.length) {
        throw new LibraryUpdatePartialStateError(
          item.id,
          item.kind === "url" ? undefined : this.absolutePath(item),
          error instanceof Error ? error.message : String(error),
          rollbackErrors.join("; "),
        );
      }
      throw error;
    }
  }
  favorite(req: LibraryFavoriteRequest): LibraryItemDto {
    const item = this.repo.getItem(req.id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    const next = { ...item, favorite: Boolean(req.favorite), updatedAt: Date.now() };
    this.repo.updateItem(next);
    return next;
  }

  /** 条目版本历史（最小可用；后续 UI/Agent 可展示与回溯） */
  listVersions(itemId: string): import("../../shared/library-ipc").LibraryVersionDto[] {
    return this.repo.listVersions(itemId);
  }

  deleteItem(id: string): void {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    this.extractCache.delete(id);
    this.textFtsFallbackIds.delete(id);
    // Durable metadata is the commit point. Never delete the managed file first: a DB failure
    // must not leave a live Library row pointing at a missing file.
    this.db.connection.transaction(() => {
      try { (this.db as any).deleteChunkEmbeddings?.(item.id); } catch {}
      try { this.db.connection.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?)`).run(item.id); } catch {}
      this.repo.deleteItem(item.id); // repository also removes FTS/chunks before deleting the row
    })();
    try { this.removeFile(item); }
    catch (error) {
      // DB row is already gone; an orphan file is safer than a dangling durable row and can be reconciled later.
      console.warn(`[Library] 条目 ${item.id} 已删除，但受管文件清理失败（orphan）`, error);
    }
  }

  /** 文本类正文；非文本返回受管路径 + requiresFileAccess，禁止 utf8 直读二进制 */
  readContent(id: string): LibraryContentDto {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    if (item.kind === "url") {
      return { item, content: "", previewUrl: item.url };
    }
    const abs = this.absolutePath(item);
    if (!this.repo.isTextReadable(item.kind)) {
      return {
        item,
        content: "",
        previewUrl: item.kind === "html" ? this.previewUrl(item.id) : undefined,
        managedPath: abs,
        requiresFileAccess: true,
      };
    }
    this.assertManagedFile(abs);
    const content = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    return {
      item,
      content,
      previewUrl: item.kind === "html" ? this.previewUrl(item.id) : undefined,
    };
  }

  /**
   * 写入正文（仅文本类）：版本快照（旧内容 hash）→ 原子写（temp+fsync+rename）→ DB 更新。
   * 崩溃顺序：任一步中断都不会静默不一致（文件为真相源，版本行只增不覆盖）。
   */
  writeContent(req: LibraryWriteContentRequest): LibraryItemDto {
    return this.updateTextContent({ id: req.id, content: req.content ?? "" });
  }

  /** Text update commit boundary: version + file + metadata + FTS either converge together or compensate. */
  updateTextContent(req: { id: string; content: string; title?: string }): LibraryItemDto {
    const item = this.repo.getItem(req.id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    if (!this.repo.isTextReadable(item.kind)) {
      throw new Error("该类型是受管文件（非文本），资料库内编辑会破坏文件；请用文件/预览工具处理");
    }
    const text = req.content ?? "";
    if (text.length > LIBRARY_CONTENT_MAX_CHARS) {
      throw new Error(`正文不能超过 ${LIBRARY_CONTENT_MAX_CHARS} 字符`);
    }
    const title = req.title === undefined ? item.title : limitText(safeName(req.title), LIBRARY_TITLE_MAX_CHARS, "标题");
    const abs = this.absolutePath(item);
    let existing: string | null = null;
    if (existsSync(abs)) {
      this.assertManagedFile(abs);
      existing = readFileSync(abs, "utf8");
    }
    const contentChanged = existing !== text;
    const titleChanged = title !== item.title;
    if (!contentChanged && !titleChanged) return item;

    const versionId = contentChanged && existing !== null ? randomUUID() : undefined;
    const next: LibraryItemDto = {
      ...item,
      title,
      filename: titleChanged ? `${title}${extname(item.filename) || extForKind(item.kind)}` : item.filename,
      sizeBytes: Buffer.byteLength(text),
      contentHash: sha256(text),
      updatedAt: Date.now(),
    };
    let fileChanged = false;
    let metadataChanged = false;
    try {
      if (versionId && existing !== null) {
        this.repo.insertVersion({
          id: versionId,
          itemId: item.id,
          version: this.repo.nextVersion(item.id),
          contentHash: sha256(existing),
          path: abs,
          createdBy: this.ownerName(),
          sourceTaskId: item.sourceTaskId,
          createdAt: Date.now(),
        });
      }
      if (contentChanged) {
        this.assertManagedWritePath(abs);
        atomicWriteFileSync(abs, text);
        fileChanged = true;
      }
      this.repo.updateItem(next);
      metadataChanged = true;
      this.refreshFts(next);
      return next;
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (fileChanged) {
        try {
          if (existing === null) rmSync(abs, { force: true });
          else atomicWriteFileSync(abs, existing);
        } catch (rollbackError) {
          rollbackErrors.push(`file=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (metadataChanged) {
        try { this.repo.updateItem(item); }
        catch (rollbackError) { rollbackErrors.push(`metadata=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      if (versionId) {
        try { this.repo.deleteVersion(versionId); }
        catch (rollbackError) { rollbackErrors.push(`version=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      try { this.refreshFts(item); }
      catch (rollbackError) { rollbackErrors.push(`fts=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      if (rollbackErrors.length) {
        throw new LibraryUpdatePartialStateError(
          item.id,
          existsSync(abs) ? abs : undefined,
          error instanceof Error ? error.message : String(error),
          rollbackErrors.join("; "),
        );
      }
      throw error;
    }
  }
  importFile(req: LibraryImportFileRequest): LibraryItemDto {
    this.ensureReady();
    const source = req.sourcePath?.trim();
    if (!source || !existsSync(source)) throw new Error("源文件不存在");
    const st = statSync(source);
    if (!st.isFile()) throw new Error("只能导入文件");
    if (st.size > LIBRARY_MAX_IMPORT_BYTES) {
      throw new Error(`文件过大（${st.size} 字节），超过资料库单文件上限 ${LIBRARY_MAX_IMPORT_BYTES} 字节`);
    }
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const name = basename(source);
    const kind = kindFromFilename(name);
    const now = Date.now();
    const item: LibraryItemDto = {
      id: randomUUID(),
      spaceId: req.spaceId,
      collectionId: req.collectionId ?? null,
      kind,
      title: name.replace(/\.[^.]+$/, "") || name,
      filename: name,
      mimeType: preciseMimeFromFilename(name) || mimeForKind(kind),
      sizeBytes: st.size,
      owner: this.ownerName(),
      favorite: false,
      sourceType: "uploaded",
      originalPath: source,
      contentHash: undefined,
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    mkdirSync(this.spaceDir(item.spaceId), { recursive: true });
    return this.commitNewManagedItem(item, () => {
      const target = this.absolutePath(item);
      this.assertManagedWritePath(target);
      copyFileSync(source, target);
    });
  }

  /**
   * Artifact → 资料库：只 COPY 不删原件；provenance 完整记录。
   *
   * 幂等/一致语义（冻结）：同 sourceArtifactId 保存到同 space 时复用已有条目——
   * 若请求目标 collection 不同则移动该条目到目标 collection；
   * 若源 artifact 内容（文件 hash）已变化，则更新受管副本、记录 LibraryVersion（旧 hash）并刷新检索索引，
   * 绝不静默返回旧副本。
   */
  saveArtifact(req: LibrarySaveArtifactRequest): LibraryItemDto {
    if (req.owner !== undefined) assertArtifactSaveOwner(this.db, this.repo, req.owner, req.spaceId, req.artifactId);
    this.ensureReady();
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const existing = this.repo.findBySourceArtifact(req.spaceId, req.artifactId);
    if (existing) {
      return this.refreshSavedArtifact(existing, req.collectionId ?? null);
    }
    const artifact = this.artifactRow(req.artifactId);
    if (!artifact) throw new Error("产物不存在");
    const sourcePath = this.resolveArtifactFilePath(artifact);
    if (!sourcePath || !existsSync(sourcePath)) throw new Error("产物文件不存在或已被移动");
    const st = statSync(sourcePath);
    if (!st.isFile()) throw new Error("该产物是文件夹，暂不支持整目录保存到资料库");
    if (st.size > LIBRARY_MAX_IMPORT_BYTES) {
      throw new Error(`产物过大（${st.size} 字节），超过资料库单文件上限 ${LIBRARY_MAX_IMPORT_BYTES} 字节`);
    }
    const name = basename(sourcePath);
    const kind = kindFromFilename(name);
    const now = Date.now();
    const item: LibraryItemDto = {
      id: randomUUID(),
      spaceId: req.spaceId,
      collectionId: req.collectionId ?? null,
      kind,
      title: artifact.title?.trim() || name.replace(/\.[^.]+$/, "") || name,
      filename: name,
      mimeType: preciseMimeFromFilename(name) || artifact.mime_type || mimeForKind(kind),
      sizeBytes: st.size,
      owner: this.ownerName(),
      favorite: false,
      sourceType: "artifact",
      sourceTaskId: artifact.task_id,
      sourceArtifactId: artifact.id,
      originalPath: sourcePath,
      contentHash: sha256File(sourcePath),
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    mkdirSync(this.spaceDir(item.spaceId), { recursive: true });
    return this.commitNewManagedItem(item, () => {
      const target = this.absolutePath(item);
      this.assertManagedWritePath(target);
      copyFileSync(sourcePath, target);
    });
  }

  /** 复用已有 artifact 条目：内容变化 → 更新副本+版本；collection 变化 → 移动；全不变 → 原样返回（no-op） */
  private refreshSavedArtifact(existing: LibraryItemDto, collectionId: string | null): LibraryItemDto {
    const collectionMoved = collectionId !== null && existing.collectionId !== collectionId;
    const sourcePath = existing.originalPath;
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new Error("源产物文件不存在或已被移动，无法刷新副本（可先删除旧条目再保存）");
    }
    const sourceHash = sha256File(sourcePath);
    const abs = this.absolutePath(existing);
    let managedHash = existing.contentHash ?? null;
    if (!managedHash) {
      try {
        this.assertManagedFile(abs);
        if (existsSync(abs)) managedHash = sha256File(abs);
      } catch {
        managedHash = null;
      }
    }
    const contentChanged = managedHash !== sourceHash;
    if (!collectionMoved && !contentChanged) return existing;

    const next = { ...existing, updatedAt: Date.now() };
    if (collectionMoved) next.collectionId = collectionId;
    const versionId = contentChanged ? randomUUID() : undefined;
    const backup = contentChanged && existsSync(abs) ? `${abs}.rollback-${randomUUID()}` : undefined;
    let fileChanged = false;
    let metadataChanged = false;
    try {
      if (contentChanged) {
        this.assertManagedWritePath(abs);
        if (backup) copyFileSync(abs, backup);
        if (versionId) {
          this.repo.insertVersion({
            id: versionId,
            itemId: existing.id,
            version: this.repo.nextVersion(existing.id),
            contentHash: managedHash ?? sourceHash,
            path: abs,
            createdBy: this.ownerName(),
            sourceTaskId: existing.sourceTaskId,
            createdAt: Date.now(),
          });
        }
        atomicCopyFileSync(sourcePath, abs);
        fileChanged = true;
        const st = statSync(sourcePath);
        next.sizeBytes = st.size;
        next.contentHash = sourceHash;
      }
      this.repo.updateItem(next);
      metadataChanged = true;
      this.refreshFts(next);
      if (backup) rmSync(backup, { force: true });
      return next;
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (fileChanged) {
        try {
          if (backup && existsSync(backup)) atomicCopyFileSync(backup, abs);
          else rmSync(abs, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`file=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (metadataChanged) {
        try { this.repo.updateItem(existing); }
        catch (rollbackError) { rollbackErrors.push(`metadata=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      if (versionId) {
        try { this.repo.deleteVersion(versionId); }
        catch (rollbackError) { rollbackErrors.push(`version=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      try { this.refreshFts(existing); }
      catch (rollbackError) { rollbackErrors.push(`fts=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      if (backup) {
        try { rmSync(backup, { force: true }); }
        catch (rollbackError) { rollbackErrors.push(`backup=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      if (rollbackErrors.length) {
        throw new LibraryUpdatePartialStateError(
          existing.id,
          existsSync(abs) ? abs : undefined,
          error instanceof Error ? error.message : String(error),
          rollbackErrors.join("; "),
        );
      }
      throw error;
    }
  }
  markVisited(id: string): LibraryItemDto {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    const next = { ...item, lastVisitedAt: Date.now() };
    this.repo.updateItem(next);
    return next;
  }

  /** 搜索：标题/文件名 + FTS 正文 + 短查询内容兜底（受控副本、256KB 上限、路径安全校验）。
   *  opts 缺省 = 用户级全量（UI）；显式传 { projectId } = 按任务可见范围过滤（Agent 工具）。 */
  search(
    query: string,
    opts?: {
      projectId?: string | null;
      spaceIds?: ReadonlySet<string>;
      collectionIds?: ReadonlySet<string>;
      itemIds?: ReadonlySet<string>;
    },
  ): LibraryListRowDto[] {
    this.ensureReady();
    const q = query.trim();
    if (!q) return [];
    const spaces = this.repo.listSpaces();
    const explicitScope = opts?.spaceIds !== undefined || opts?.collectionIds !== undefined || opts?.itemIds !== undefined;
    const scopeProjectId = opts === undefined ? undefined : (opts.projectId ?? null);
    const visible = explicitScope
      ? new Set(opts?.spaceIds ?? [])
      : scopeProjectId === undefined
        ? new Set(spaces.map((s) => s.id))
        : new Set(
            spaces.filter((s) => this.isSpaceVisibleToTask(s, scopeProjectId)).map((s) => s.id),
          );
    const visibleCollections = new Set(opts?.collectionIds ?? []);
    const visibleItems = new Set(opts?.itemIds ?? []);
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    const queryScope = { spaceIds: visible, collectionIds: visibleCollections, itemIds: visibleItems };
    const hits = this.retrieve(q, { ...queryScope, limit: 80 });
    const rows: LibraryListRowDto[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const item = this.repo.getItem(hit.itemId);
      if (!item) continue;
      seen.add(item.id);
      rows.push(this.toRow(item, spaceName.get(item.spaceId) ?? "资料库"));
    }
    // 短查询（<3，FTS trigram 不处理）/ FTS 不可用时扫描可见文本；健康 FTS 的 >=3 查询不做全库 I/O。
    // 缺失派生 FTS 行，或 v2 200–256 KiB 覆盖尚未迁完时，只扫描这些候选，保留中断恢复语义。
    const ftsAvailable = this.repo.ftsAvailable();
    const fullTextFallback = q.length < 3 || !ftsAvailable;
    const targetedFallbackIds = this.textFtsFallbackIds;
    if (fullTextFallback || targetedFallbackIds.size > 0) {
      const needle = q.toLowerCase();
      for (const item of this.repo.listItemsInScope(queryScope)) {
        if (seen.has(item.id)) continue;
        if (!this.repo.isTextSearchable(item.kind)) continue;
        if (!fullTextFallback && !targetedFallbackIds.has(item.id)) continue;
        const abs = this.absolutePath(item);
        if (!existsSync(abs)) continue;
        try {
          this.assertManagedFile(abs);
          const st = statSync(abs);
          if (!st.isFile() || st.size > TEXT_SEARCH_MAX_BYTES) continue;
          const text = readFileSync(abs, "utf8");
          if (text.toLowerCase().includes(needle)) {
            seen.add(item.id);
            rows.push(this.toRow(item, spaceName.get(item.spaceId) ?? "资料库"));
          }
        } catch {
          /* 单个文件读取失败不影响其余 */
        }
        if (rows.length >= 80) break;
      }
    }
    return rows.slice(0, 80);
  }

  /**
   * Hybrid-ready retrieval（FTS trigram + 显式排名 + metadata 过滤）：
   * opts 缺省 = 用户级全量；显式 { projectId } = 任务可见范围（personal + 当前项目）。
   */
  retrieve(
    query: string,
    opts?: {
      projectId?: string | null;
      spaceIds?: ReadonlySet<string>;
      collectionIds?: ReadonlySet<string>;
      itemIds?: ReadonlySet<string>;
      limit?: number;
    },
  ): LibraryRetrievalHitDto[] {
    this.ensureReady();
    const spaces = this.repo.listSpaces();
    const spaceIds =
      opts?.spaceIds ??
      (opts?.collectionIds !== undefined || opts?.itemIds !== undefined
        ? new Set<string>()
        : opts?.projectId === undefined
        ? new Set(spaces.map((s) => s.id))
        : new Set(
            spaces.filter((s) => this.isSpaceVisibleToTask(s, opts.projectId ?? null)).map((s) => s.id),
          ));
    return this.repo.retrieve(query, {
      spaceIds,
      collectionIds: opts?.collectionIds,
      itemIds: opts?.itemIds,
      limit: opts?.limit ?? 10,
    });
  }

  /** FTS 索引维护：文本类条目同步标题/文件名/正文；Office/PDF 标记 pending 并异步抽取索引；
   *  图片/URL/未知 → 清理 FTS + unsupported（绝不把未抽取的二进制当正文）。
   *  R2：每次 FTS 维护后同步维护 library_chunks + library_chunks_fts（chunk 仅定位辅助）。
   */
  private refreshFts(item: LibraryItemDto): void {
    this.extractCache.delete(item.id);
    if (this.repo.isTextSearchable(item.kind)) {
      const abs = this.absolutePath(item);
      let body = "";
      try {
        if (existsSync(abs)) {
          this.assertManagedFile(abs);
          const st = statSync(abs);
          if (st.isFile() && st.size <= TEXT_SEARCH_MAX_BYTES) {
            body = readFileSync(abs, "utf8").slice(0, TEXT_SEARCH_MAX_BYTES);
          }
        }
      } catch {
        body = "";
      }
      this.repo.upsertFts(item.id, item.title, item.filename, body);
      this.textFtsFallbackIds.delete(item.id);
      // R2：同步 chunk 化（文本类直接基于 body）
      this.refreshChunksForItem(item.id, body);
      return;
    }
    if (this.isExtractableKind(item.kind)) {
      // 先清旧 FTS + chunks（绝不返回陈旧索引），置 pending，异步抽取后重建
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
      this.repo.updateExtractStatus(item.id, "pending");
      const pending = this.indexExtractedText(item.id).catch((err) => {
        console.warn(`[Library] 文档抽取索引失败 ${item.id}：`, err);
      });
      this.pendingIndexes.add(pending);
      void pending.finally(() => this.pendingIndexes.delete(pending));
      return;
    }
    this.repo.deleteFts(item.id);
    this.repo.deleteChunks(item.id);
    this.repo.updateExtractStatus(item.id, "unsupported");
  }

  /** R2+R3：基于文本 body 刷新 chunks，同步失效 stale embeddings */
  private refreshChunksForItem(itemId: string, text: string | null): void {
    let oldChunkIds = new Set<string>();
    let oldHashes = new Map<string, string>();
    try {
      const prev = this.repo.listChunks(itemId);
      for (const c of prev) { oldChunkIds.add(c.id); oldHashes.set(c.id, c.hash); }
    } catch (err) {
      // Non-fatal: without the previous chunk snapshot we can only do a full stale sweep.
      console.warn(`[Library] 读取旧 chunk 快照失败 ${itemId}（退化为全量 stale 清扫）：`, err);
    }
    try {
      if (!text || text.trim().length === 0) {
        try { this.deleteStaleEmbeddingsForItem(itemId); } catch (err) {
          console.warn(`[Library] embedding 失效失败（空正文）${itemId}：`, err);
        }
        this.repo.deleteChunks(itemId);
        return;
      }
      const chunks = chunkText(itemId, text);
      const newIds = new Set(chunks.map((c) => c.id));
      try { this.deleteStaleEmbeddingsForItem(itemId); } catch (err) {
        console.warn(`[Library] embedding 失效失败 ${itemId}：`, err);
      }
      // Removed chunks are handled by the stale sweep above (their embeddings no longer join to library_chunks).
      try {
        const removedIds = [...oldChunkIds].filter((id) => !newIds.has(id));
        if (removedIds.length > 0) this.deleteEmbeddingsForChunkIds(removedIds);
      } catch (err) {
        console.warn(`[Library] 移除 chunk 的 embedding 清理失败 ${itemId}：`, err);
      }
      this.repo.upsertChunks(itemId, chunks as any);
    } catch (err) {
      console.warn(`[Library] chunk 写入失败 ${itemId}：`, err);
    }
  }

  /** Unified lifecycle API — explicit, no scattered copies */
  private deleteEmbeddingsForItem(itemId: string): void {
    try { (this.db as any).deleteChunkEmbeddings?.(itemId); } catch (err) {
      console.warn(`[Library] deleteChunkEmbeddings 失败 ${itemId}：`, err);
    }
    try {
      const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
      conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?)`).run(itemId);
    } catch (err) {
      console.warn(`[Library] 删除条目 embedding 失败 ${itemId}：`, err);
    }
  }
  private deleteEmbeddingsForChunkIds(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
    const ph = chunkIds.map(() => "?").join(",");
    conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (${ph})`).run(...chunkIds);
  }
  /**
   * Delete every embedding for `itemId` whose `chunk_hash` no longer matches its chunk's current hash.
   *
   * NOTE: this is a DB-level sweep, not a per-chunk diff. It intentionally takes no chunk-id inputs —
   * an earlier signature accepted (newIds, oldIds, oldHashes) but ignored all three, which made the
   * caller look like it was doing a precise incremental invalidation when it was not. Keep it honest:
   * call it BEFORE upsertChunks to drop embeddings for still-joined chunks whose text changed.
   */
  private deleteStaleEmbeddingsForItem(itemId: string): void {
    const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
    conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?) AND chunk_hash != (SELECT hash FROM library_chunks WHERE library_chunks.id = library_chunk_embeddings.chunk_id)`).run(itemId);
  }

  /** 文本 body 读取（复用 refreshFts/refreshChunksForItem 的读取路径）：文本类→文件；office/pdf→抽取正文 */
  private async resolveBackfillText(item: LibraryItemDto): Promise<string | null> {
    if (this.repo.isTextSearchable(item.kind)) {
      const abs = this.absolutePath(item);
      try {
        if (existsSync(abs)) {
          this.assertManagedFile(abs);
          const st = statSync(abs);
          if (st.isFile() && st.size <= TEXT_SEARCH_MAX_BYTES) {
            return readFileSync(abs, "utf8").slice(0, TEXT_SEARCH_MAX_BYTES);
          }
        }
      } catch {}
      return null;
    }
    if (this.isExtractableKind(item.kind)) {
      const abs = this.absolutePath(item);
      if (!abs || !this.isManagedFileSafe(abs)) return null;
      try {
        const result = await this.getExtractedText(item);
        return result.status === "extracted" && result.text ? result.text : null;
      } catch {
        return null;
      }
    }
    return null;
  }


  /**
   * FTS text recovery：每次启动修复缺失派生行；旧版 v2 还会一次性补齐 200–256 KiB 正文覆盖。
   * 只处理实际候选，分批让出事件循环；v2 成功后 checkpoint，后续只检查缺失行。
   */
  async recoverTextFtsCoverageV2(opts?: { batchSize?: number; signal?: AbortSignal }): Promise<{ processed: number; failed: number }> {
    if (!this.repo.ftsAvailable()) return { processed: 0, failed: 0 };
    const stateKey = "text-fts-coverage-version";
    const needsCoverageUpgrade = Number(this.repo.getIndexState(stateKey) ?? 0) < 2;
    this.refreshTextFtsFallbackState();
    const ids = [...this.textFtsFallbackIds];
    const batchSize = Math.max(1, Math.min(100, Math.floor(opts?.batchSize ?? 20)));
    let processed = 0;
    let failed = 0;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      if (opts?.signal?.aborted) return { processed, failed };
      for (const id of ids.slice(offset, offset + batchSize)) {
        try {
          const item = this.repo.getItem(id);
          if (item) this.refreshFts(item);
          processed += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[Library] FTS text recovery failed ${id}:`, error);
        }
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    }
    if (!opts?.signal?.aborted && failed === 0 && needsCoverageUpgrade) this.repo.setIndexState(stateKey, "2");
    if (!opts?.signal?.aborted) this.refreshTextFtsFallbackState();
    return { processed, failed };
  }
  /**
   * R2 P2：旧数据 chunk backfill（幂等、可中断恢复、失败隔离、不阻塞启动）。
   * - 幂等：候选 = 无 chunk 的 item（listChunkBackfillCandidates）；已有 chunk 的跳过
   * - 可中断恢复：状态推导（无 pending 表），中断后下次启动剩余候选仍被查询到
   * - 失败隔离：逐 item try/catch，单项失败记录并跳过，继续下一项
   * - 不阻塞启动：调用方 fire-and-forget；内部按 batch 分批 + 每批让出事件循环
   * - 不污染 library_fts：只写 library_chunks / library_chunks_fts
   * - 不自动注入 Prompt：仅维护索引，Search 仍只返回 lightweight hit
   */
  async backfillMissingChunks(opts?: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, totalHint: number) => void }): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    const signal = opts?.signal;
    let processed = 0, succeeded = 0, failed = 0, skipped = 0;
    // 快照一次全量候选规模（仅用于进度提示，不作为循环边界——循环以“无 chunk 的剩余”为真源，避免中途新增被遗漏）
    let totalHint = 0;
    try {
      totalHint = this.repo.listChunkBackfillCandidates(100000).length;
    } catch { totalHint = 0; }
    while (!signal?.aborted) {
      let batch: string[] = [];
      try {
        batch = this.repo.listChunkBackfillCandidates(batchSize);
      } catch (err) {
        console.warn("[Library] chunk backfill 查询失败：", err);
        break;
      }
      if (batch.length === 0) break;
      for (const itemId of batch) {
        if (signal?.aborted) break;
        processed++;
        try {
          if (this.repo.hasChunks(itemId)) { skipped++; continue; }
          const item = this.repo.getItem(itemId);
          if (!item) { skipped++; continue; }
          // URL/file/image 等无可索引正文的类型不产生 chunk
          if (!this.repo.isTextSearchable(item.kind) && !this.isExtractableKind(item.kind)) { skipped++; continue; }
          const text = await this.resolveBackfillText(item);
          if (!text || text.trim().length === 0) { this.repo.deleteChunks(itemId); skipped++; continue; }
          // 幂等双检：并发写入刚好补上的情况
          if (this.repo.hasChunks(itemId)) { skipped++; continue; }
          const chunks = chunkText(itemId, text);
          this.repo.upsertChunks(itemId, chunks as any);
          succeeded++;
        } catch (err) {
          failed++;
          console.warn(`[Library] chunk backfill 单项失败 ${itemId}，已跳过：`, err);
        }
      }
      opts?.onProgress?.(processed, totalHint);
      // 每批让出事件循环，避免老用户几千份文档卡主线程
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    return { processed, succeeded, failed, skipped };
  }

  // R3 Semantic Index：绑 chunk_hash，异步分批可恢复，单失败隔离，与 R2 backfillMissingChunks 分离
  private semanticBackfillRunning = false;

  get semanticIndexStats(): { running: boolean; pending?: number; failed?: number; processed?: number } {
    try {
      const dbAny = (this.db as any);
      const conn = dbAny.connection ?? dbAny.db ?? dbAny;
      const ch = conn.prepare(`SELECT COUNT(*) AS n FROM library_chunks`).get() as any;
      const em = conn.prepare(`SELECT COUNT(*) AS n FROM library_chunk_embeddings WHERE model_id=? AND model_version=?`).get("BAAI/bge-m3","int8-v1") as any;
      const total = Number(ch?.n ?? 0);
      const done = Number(em?.n ?? 0);
      const jr = conn.prepare(`SELECT processed, failed FROM semantic_index_jobs WHERE job_id=?`).get("BAAI/bge-m3:int8-v1") as any;
      return { running: this.semanticBackfillRunning, pending: Math.max(0, total - done), failed: Number(jr?.failed ?? 0), processed: Number(jr?.processed ?? done) };
    } catch { return { running: this.semanticBackfillRunning }; }
  }

  /** R3.4：幂等确保语义索引就绪（建表由 AppDatabase 迁移保证，这里仅校验） */
  ensureSemanticIndex(): void {
    // tables ensured by AppDatabase migration v16; no-op, kept as API surface
  }

  /**
   * R3.4：异步 backfillEmbeddings — 分批、hash 去重、失败隔离、abortable、checkpoint 到 semantic_index_jobs。
   * 与 R2 backfillMissingChunks 分离（R2 负责 chunks，本方法负责 embeddings）。
   * lifecycle 绑 chunk_hash：hash 相同复用，同 chunk 不同 hash 则重建；stale/orphan 由 hash 错配自然淘汰。
   */
  async backfillEmbeddings(opts?: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, totalHint: number) => void }): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    if (this.semanticBackfillRunning) return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    this.semanticBackfillRunning = true;
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    const signal = opts?.signal;
    let processed = 0, succeeded = 0, failed = 0, skipped = 0;
    const MODEL_ID = SEMANTIC_MODEL_ID;
    const MODEL_VER = SEMANTIC_MODEL_VERSION;
    const DIM = SEMANTIC_DIMENSION;
    const jobId = `${MODEL_ID}:${MODEL_VER}`;
    const dbAny = (this.db as any);
    const conn = dbAny.connection ?? dbAny.db ?? dbAny;
    const ensureJob = () => {
      try {
        conn.prepare(`INSERT OR IGNORE INTO semantic_index_jobs (job_id, model_id, model_version, status, processed, failed, updated_at) VALUES (?, ?, ?, 'pending', 0, 0, ?)`).run(jobId, MODEL_ID, MODEL_VER, Date.now());
      } catch {}
    };
    const updateJob = (status: string, lastId: string | null, err?: string) => {
      try {
        conn.prepare(`UPDATE semantic_index_jobs SET status=?, last_chunk_id=?, processed=?, failed=?, error=?, updated_at=? WHERE job_id=?`).run(status, lastId, processed, failed, err ?? null, Date.now(), jobId);
      } catch {}
    };
    ensureJob();
    try {
      // Gate: no model -> pending, never hash
      const mgrGate = new SemanticModelManager();
      const chkGate = mgrGate.getStatus();
      if (chkGate.status !== "ready") {
        updateJob("pending", null, "model " + chkGate.status + (chkGate.error ? ": " + chkGate.error : ""));
        return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
      }
      const rtGate = getSemanticRuntime(mgrGate);
      try { await rtGate.ensureSession(); } catch (e) {
        updateJob("pending", null, String(e instanceof Error ? e.message : e));
        return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
      }
      // Reuse single runtime/session for entire backfill (no per-chunk import/new)
      updateJob("running", null);
      let totalHint = 0;
      try {
        const r = conn.prepare(`SELECT COUNT(*) AS n FROM library_chunks`).get() as any;
        totalHint = Number(r?.n ?? 0);
      } catch { totalHint = 0; }
      // resume from checkpoint
      let lastId: string | null = null;
      try {
        const j = conn.prepare(`SELECT last_chunk_id FROM semantic_index_jobs WHERE job_id=?`).get(jobId) as any;
        lastId = j?.last_chunk_id ?? null;
      } catch { lastId = null; }
      while (!signal?.aborted) {
        let batch: Array<{ id: string; content: string; hash: string; chunk_index: number; char_offset: number; item_id: string }> = [];
        try {
          if (lastId) {
            batch = conn.prepare(`SELECT id, content, hash, chunk_index, char_offset, item_id FROM library_chunks WHERE id > ? ORDER BY id LIMIT ?`).all(lastId, batchSize) as any;
          } else {
            batch = conn.prepare(`SELECT id, content, hash, chunk_index, char_offset, item_id FROM library_chunks ORDER BY id LIMIT ?`).all(batchSize) as any;
          }
        } catch (e) { console.warn("[Library] embedding backfill 查询失败：", e); break; }
        if (batch.length === 0) break;
        for (const ch of batch) {
          if (signal?.aborted) break;
          processed++;
          lastId = ch.id;
          try {
            // hash 去重：同 chunk 同 hash 已有 embedding 则跳过
            let exists: any = null;
            try {
              exists = conn.prepare(`SELECT chunk_hash FROM library_chunk_embeddings WHERE chunk_id=? AND model_id=? AND model_version=?`).get(ch.id, MODEL_ID, MODEL_VER) as any;
            } catch {}
            if (exists && exists.chunk_hash === ch.hash) { skipped++; continue; }
            // stale：hash 变化则先删旧
            if (exists && exists.chunk_hash !== ch.hash) {
              try { conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id=? AND model_id=? AND model_version=?`).run(ch.id, MODEL_ID, MODEL_VER); } catch {}
            }
            // embed via singleton runtime — no per-chunk Provider, no hash fallback
            let vec: Float32Array;
            try {
              vec = await rtGate.embed(ch.content);
            } catch (err) {
              failed++;
              console.warn("[Library] embedding single failed", ch.id, err);
              continue;
            }
            if (vec.length !== DIM) { failed++; continue; }
            const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
            try {
              conn.prepare(`INSERT OR REPLACE INTO library_chunk_embeddings (chunk_id, model_id, model_version, chunk_hash, dimension, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ch.id, MODEL_ID, MODEL_VER, ch.hash, DIM, blob, Date.now());
              // also carry chunk_index/char_offset for fast provider join: store denormalized via library_chunks join, but also ensure row exists
              succeeded++;
            } catch (e) {
              failed++;
              console.warn(`[Library] embedding 写入失败 ${ch.id}`, e);
            }
          } catch (err) {
            failed++;
            console.warn(`[Library] embedding 单项失败 ${ch.id} 已隔离：`, err);
          }
        }
        updateJob("running", lastId);
        opts?.onProgress?.(processed, totalHint);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      updateJob(signal?.aborted ? "pending" : "done", lastId);
    } finally {
      this.semanticBackfillRunning = false;
    }
    return { processed, succeeded, failed, skipped };
  }

  
/** 可抽取的 Office/PDF 类型（文本类直接内联；image/file 不抽取） */
  private isExtractableKind(kind: LibraryItemKind): boolean {
    return kind === "office" || kind === "pdf";
  }

  /**
   * 异步抽取并建立 FTS 索引（写入后 fire-and-forget 调用；读取路径亦可显式调用）。
   * 与 getExtractedText 共享 per-item in-flight 去重与缓存（并发 search/read 只解析一次）；
   * 受管路径守卫前置：越界/symlink → unsupported + 清 FTS。
   */
  async indexExtractedText(itemId: string): Promise<void> {
    const item = this.repo.getItem(itemId);
    if (!item) return;
    if (!this.isExtractableKind(item.kind)) return;
    const abs = this.absolutePath(item);
    if (!abs || !this.isManagedFileSafe(abs)) {
      this.repo.updateExtractStatus(item.id, "unsupported");
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
      return;
    }
    const result = await this.getExtractedText(item);
    this.repo.updateExtractStatus(item.id, result.status);
    if (result.status === "extracted" && result.text) {
      this.repo.upsertFts(item.id, item.title, item.filename, result.text);
      this.refreshChunksForItem(item.id, result.text);
    } else {
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
    }
  }

  /**
   * 获取文档抽取正文（带缓存：size+mtime+contentHash 变化即失效重抽；per-item 并发去重）。
   * extracted → 返回正文（≤200KB，truncated 标记）；unsupported/error → text=null。
   */
  async getExtractedText(item: LibraryItemDto): Promise<ExtractionResult> {
    const abs = this.absolutePath(item);
    if (!abs || !this.isManagedFileSafe(abs)) {
      return { status: "unsupported", text: null, truncated: false, error: "受管文件不可安全读取" };
    }
    const key = this.extractCacheKey(abs, item);
    const cached = this.extractCache.get(item.id);
    if (cached && cached.key === key) return cached.result;
    const inflight = this.inflightExtract.get(item.id);
    if (inflight) return inflight;
    const promise = this.extractors.extract(item.kind, item.mimeType, abs, defaultBudget());
    this.inflightExtract.set(item.id, promise);
    try {
      const result = await promise;
      this.cacheExtraction(item.id, abs, item, result);
      return result;
    } finally {
      this.inflightExtract.delete(item.id);
    }
  }

  private cacheExtraction(itemId: string, abs: string, item: LibraryItemDto, result: ExtractionResult): void {
    this.extractCache.set(itemId, { key: this.extractCacheKey(abs, item), result });
    if (this.extractCache.size > 64) {
      const oldest = this.extractCache.keys().next().value;
      if (oldest !== undefined) this.extractCache.delete(oldest);
    }
  }

  /** 等待全部进行中的异步抽取完成（测试确定性 / 关库前收敛） */
  async flushPendingIndexes(): Promise<void> {
    await Promise.allSettled([...this.pendingIndexes]);
  }

  /**
   * 启动恢复：把中断/重启遗留的 office/pdf 条目重新入队抽取（status NULL/pending/error，
   * 或已 extracted 但 FTS 行缺失）。返回入队数量；调用方 fire-and-forget。
   * 与 chunk backfill 的恢复边界：本方法负责 library_fts/extract_status，backfillMissingChunks
   * 负责 library_chunks/library_chunks_fts；office/pdf 的“完整自愈”由两者先后触发共同覆盖。
   */
  async recoverPendingExtractions(): Promise<number> {
    const candidates = this.repo.listExtractionRecoveryCandidates();
    for (const row of candidates) {
      const item = this.repo.getItem(row.id);
      if (!item) continue;
      const pending = this.indexExtractedText(item.id).catch((err) => {
        console.warn(`[Library] 恢复抽取失败 ${item.id}：`, err);
      });
      this.pendingIndexes.add(pending);
      void pending.finally(() => this.pendingIndexes.delete(pending));
    }
    return candidates.length;
  }

  private extractCacheKey(abs: string, item: LibraryItemDto): string {
    try {
      const st = statSync(abs);
      return `${st.size}:${st.mtimeMs}:${item.contentHash ?? ""}`;
    } catch {
      return "missing";
    }
  }

  previewUrl(itemId: string): string {
    return `mybuddy-library://local/${encodeURIComponent(itemId)}/`;
  }

  absolutePath(item: LibraryItemDto): string {
    if (item.kind === "url") return "";
    return join(this.spaceDir(item.spaceId), `${item.id}${extname(item.filename)}`);
  }

  resolvePreview(itemId: string, subPath: string): { path: string; mime: string } | null {
    const item = this.repo.getItem(itemId);
    if (!item || item.kind === "url") return null;
    if (!subPath) {
      const path = this.absolutePath(item);
      this.assertManagedFile(path);
      return { path, mime: item.mimeType || guessMime(item.filename) };
    }
    const cleaned = subPath.replace(/^\/+/, "").split(/[\\/]/).filter((p) => p && p !== "." && p !== "..");
    if (cleaned.length !== 1) return null;
    const filename = cleaned[0]!;
    const sibling = this.repo.findByFilename(item.spaceId, filename);
    if (!sibling) return null;
    const path = this.absolutePath(sibling);
    this.assertManagedFile(path);
    return { path, mime: sibling.mimeType || guessMime(sibling.filename) };
  }

  /**
   * 资料库目录摘要（仅标题/类型/位置/id，不含全文）——按任务可见范围限域：
   * personal 恒可见；绑定项目仅加本项目空间；未绑定/缺省仅 personal。
   */
  formatCatalog(limit = 36, opts?: { taskId?: string | null; projectId?: string | null; workspaceId?: string | null; toolsAvailable?: boolean }): string {
    const taskScope = opts && ("taskId" in opts || "workspaceId" in opts)
      ? this.resolveTaskScope(opts.taskId, opts.projectId, { workspaceFallback: opts.workspaceId }) : null;
    const toolsAvailable = opts?.toolsAvailable ?? true;
    const retrievalHint = toolsAvailable
      ? "需要内容时用 library_search / library_read 按需读取；二进制/办公/图片条目返回受管路径，需要文件工具或预览读取，资料库不提供内联全文。"
      : "本会话不提供资料库工具；如需内容请告知用户或由主任务（在项目上下文中的任务）读取。";
    if (!this.repo.getSpace(LIBRARY_PERSONAL_SPACE_ID)) {
      return [
        "## 资料库",
        "当前范围还没有资料。用户可在对应项目或工作空间的资料页新建 Markdown / CSV / HTML，或保存任务产物。",
        "三种载体分工：MD 决定内容，CSV 存储数据，HTML 负责表达；同空间可用相对路径互相引用。",
      ].join("\n");
    }
    const spaces = this.repo.listSpaces();
    const visible = spaces.filter((s) => taskScope ? this.isSpaceVisibleInScope(s, taskScope) : this.isSpaceVisibleToTask(s, opts?.projectId ?? null));
    const visibleIds = new Set(visible.map((s) => s.id));
    const items = (taskScope ? this.listItemsInScope(taskScope) : this.repo.listItems().filter((i) => visibleIds.has(i.spaceId)))
      .filter((i) => i.kind !== "url");
    if (items.length === 0) {
      return [
        "## 资料库",
        "当前范围还没有可见资料。用户可在对应项目或工作空间的资料页添加，或显式引用已有资料。",
        "三种载体分工：MD 决定内容，CSV 存储数据，HTML 负责表达；同空间可用相对路径互相引用。",
      ].join("\n");
    }
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    const lines = [
      "## 资料库",
      taskScope
        ? "以下为本任务可使用的资料：归属项目、当前/祖先工作空间，以及显式引用。继承或引用只提供读取权。"
        : "资料库是独立于任务产物的知识空间。MD 决定内容，CSV 存储数据，HTML 负责表达。",
      retrievalHint,
      "",
    ];
    for (const item of items.slice(0, limit)) {
      const loc = spaceName.get(item.spaceId) ?? item.spaceId;
      lines.push(`- [${item.kind}] ${item.title} · ${loc} · id=${item.id}`);
    }
    if (items.length > limit) lines.push(`- …其余 ${items.length - limit} 条未列出，可在当前范围继续搜索`);
    return lines.join("\n");
  }

  showInFolder(id: string): string {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    if (item.kind === "url") throw new Error("URL 条目没有本地文件");
    return this.absolutePath(item);
  }

  /* ---------------- TaskLibraryReference ---------------- */

  attachToTask(req: LibraryAttachRequest): LibraryTaskReferenceDto {
    const item = this.repo.getItem(req.itemId);
    if (!item) throw new Error("条目不存在");
    const task = this.db.getTask(req.taskId);
    if (!task) throw new Error("任务不存在");
    const space = this.repo.getSpace(item.spaceId);
    if (!space || !isLibrarySpacePermittedForProject(space, task.projectId ?? null)) {
      throw new Error("资料不属于当前项目，不能跨项目附加");
    }
    if (space.workspaceId && !this.db.getSpace(space.workspaceId)) throw new Error("资料归属工作空间不存在");
    this.assertTaskProjectWritable(req.taskId);
    const ref: LibraryTaskReferenceDto = {
      taskId: req.taskId,
      itemId: item.id,
      projectId: space?.projectId,
      addedAt: Date.now(),
      addedBy: this.ownerName(),
    };
    this.repo.insertReference(ref);
    return ref;
  }

  detachFromTask(req: LibraryDetachRequest): void {
    this.assertTaskProjectWritable(req.taskId);
    this.repo.deleteReference(req.taskId, req.itemId);
  }

  listTaskReferences(taskId: string): LibraryTaskReferencesDto {
    const task = this.db.getTask(taskId);
    if (!task) return { taskId, items: [] };
    const refs = this.repo.listReferencesByTask(taskId);
    const spaces = new Map(this.repo.listSpaces().map((s) => [s.id, s]));
    const items: LibraryListRowDto[] = [];
    for (const ref of refs) {
      const item = this.repo.getItem(ref.itemId);
      const space = item ? spaces.get(item.spaceId) : undefined;
      if (!item || !space || !isLibrarySpacePermittedForProject(space, task.projectId ?? null)) continue;
      if (space.workspaceId && !this.db.getSpace(space.workspaceId)) continue;
      items.push(this.toRow(item, space.name));
    }
    return { taskId, items };
  }

  /** 结构化任务引用上下文（Agent 装配用）：显式附加项，绝不注入整个资料库 */
  formatTaskAttachments(taskId: string): string | null {
    const refs = this.listTaskReferences(taskId);
    const scope = this.resolveTaskScope(taskId);
    const visible = refs.items.filter((row) => {
      const item = this.repo.getItem(row.id);
      return item && this.isItemVisibleInScope(item, scope);
    });
    if (visible.length === 0) return null;
    const lines = visible.map((row) => {
      const item = this.repo.getItem(row.id);
      const path = item ? this.absolutePath(item) : "";
      return `- [${row.kind}] ${row.title} · id=${row.id}${path ? ` · path=${path}` : ""}`;
    });
    return [
      "## 已附加到本任务的资料（显式引用）",
      ...lines,
      "这些资料由用户/任务显式附加。需要内容时用 library_read 读取文本类；二进制/办公类返回受管路径，需要文件工具或预览读取；不要假设可访问任务目录之外的任意路径。",
    ].join("\n");
  }

  /* ---------------- 任务/项目可见性（Agent 工具与目录限域共用） ---------------- */

  /** personal 恒可见；team 仅当 projectId 匹配（null/undefined 表示任务未绑定项目 → 只可见 personal） */
  isSpaceVisibleToTask(space: LibrarySpaceDto, taskProjectId: string | null | undefined): boolean {
    if (space.kind === "personal") return true;
    return Boolean(taskProjectId) && space.projectId === taskProjectId;
  }

  isItemVisibleToTask(item: LibraryItemDto, taskProjectId: string | null | undefined): boolean {
    const space = this.repo.getSpace(item.spaceId);
    return space ? this.isSpaceVisibleToTask(space, taskProjectId) : false;
  }

  /* ---------------- 内部 ---------------- */

  private deleteCollectionRecursive(collection: LibraryCollectionDto): void {
    const descendants = this.repo.listCollectionsRecursive(collection.spaceId, collection.id);
    const collections = [collection, ...descendants];
    const items = this.repo.listItemsInCollectionTree(collection.spaceId, collection.id);
    this.db.connection.transaction(() => {
      for (const item of items) this.repo.deleteItem(item.id);
      for (const current of [...collections].reverse()) {
        this.db.deleteLibraryCollectionLinks(current.id);
        this.repo.deleteCollection(current.id);
      }
    })();
    for (const item of items) this.removeFileAfterDurableDelete(item);
  }
  private seedWelcomeIfEmpty(space: LibrarySpaceDto): void {
    const existing = this.repo.listItems(space.id);
    if (existing.length > 0) return;
    const now = Date.now();
    const item: LibraryItemDto = {
      id: randomUUID(),
      spaceId: space.id,
      collectionId: null,
      kind: "markdown",
      title: WELCOME_TITLE,
      filename: `${WELCOME_TITLE}.md`,
      mimeType: mimeForKind("markdown"),
      sizeBytes: Buffer.byteLength(WELCOME_MD),
      owner: this.ownerName(),
      favorite: false,
      sourceType: "created",
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    this.writeManagedFile(item, WELCOME_MD);
    this.repo.insertItem(item);
  }

  private listLocalArtifacts(ownerName: string): LibraryArtifactDto[] {
    try {
      const tables = this.db.connection
        .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'`)
        .get() as { found: number } | undefined;
      if (!tables) return [];
      const rows = this.db.connection
        .prepare(
          `SELECT a.id, a.task_id, a.space_id, a.kind, a.title, a.updated_at, t.title AS task_title, s.name AS space_name
           FROM artifacts a
           LEFT JOIN tasks t ON t.id = a.task_id
           LEFT JOIN spaces s ON s.id = a.space_id
           ORDER BY a.updated_at DESC
           LIMIT 200`,
        )
        .all() as Array<{
        id: string;
        task_id: string;
        space_id: string | null;
        kind: string;
        title: string | null;
        updated_at: number;
        task_title: string | null;
        space_name: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        spaceId: row.space_id ?? undefined,
        kind: row.kind,
        title: row.title?.trim() || "未命名产物",
        owner: ownerName,
        location: row.space_name ? `${row.space_name} · ${row.task_title ?? "任务"}` : (row.task_title ?? "本地产物"),
        updatedAt: row.updated_at,
      }));
    } catch {
      return [];
    }
  }

  private artifactRow(artifactId: string): {
    id: string;
    task_id: string;
    kind: string;
    title: string | null;
    mime_type: string | null;
    source_type: string;
    entry_file: string | null;
    root_dir: string | null;
    storage_path: string | null;
  } | null {
    try {
      const row = this.db.connection
        .prepare(
          `SELECT id, task_id, kind, title, mime_type, source_type, entry_file, root_dir, storage_path
           FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as
        | {
            id: string;
            task_id: string;
            kind: string;
            title: string | null;
            mime_type: string | null;
            source_type: string;
            entry_file: string | null;
            root_dir: string | null;
            storage_path: string | null;
          }
        | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  private resolveArtifactFilePath(row: NonNullable<ReturnType<LibraryService["artifactRow"]>>): string | null {
    if (row.source_type === "managed-content") {
      if (!row.storage_path || !row.root_dir) return null;
      return join(row.root_dir, row.storage_path);
    }
    if (row.entry_file) {
      return isAbsolute(row.entry_file) ? row.entry_file : row.root_dir ? join(row.root_dir, row.entry_file) : row.entry_file;
    }
    return null;
  }

  private toRow(item: LibraryItemDto, location: string): LibraryListRowDto {
    return {
      id: item.id,
      source: "library",
      kind: item.kind,
      title: item.title,
      owner: item.owner,
      location,
      spaceId: item.spaceId,
      collectionId: item.collectionId,
      lastVisitedAt: item.lastVisitedAt,
      updatedAt: item.updatedAt,
      filename: item.filename,
      favorite: item.favorite,
    };
  }

  private withOwnerName(space: LibrarySpaceDto): LibrarySpaceDto {
    if (space.workspaceId) {
      const workspace = this.db.getSpace(space.workspaceId);
      return workspace ? { ...space, workspaceName: workspace.name ?? undefined } : space;
    }
    if (!space.projectId) return space;
    const row = this.db.connection
      .prepare(`SELECT name FROM projects WHERE id = ?`)
      .get(space.projectId) as { name: string } | undefined;
    return row ? { ...space, projectName: row.name } : space;
  }

  private projectExists(projectId: string): boolean {
    try {
      const row = this.db.connection
        .prepare(`SELECT 1 AS found FROM projects WHERE id = ?`)
        .get(projectId) as { found: number } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private requireWritableSpace(spaceId: string): LibrarySpaceDto {
    const space = this.repo.getSpace(spaceId);
    if (!space) throw new Error("空间不存在");
    this.assertSpaceWritable(space);
    return space;
  }

  private assertSpaceWritable(space: LibrarySpaceDto): void {
    if (space.projectId && this.isProjectArchived(space.projectId)) {
      throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
    if (space.workspaceId && (!this.db.getSpace(space.workspaceId) || this.db.isSpaceEffectiveArchived(space.workspaceId))) {
      throw new Error("已归档或已删除工作空间的资料只可读取");
    }
  }

  private assertTaskProjectWritable(taskId: string): void {
    const row = this.db.connection
      .prepare(`SELECT p.archived FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`)
      .get(taskId) as { archived: number | null } | undefined;
    if (row?.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
  }

  private requireCollectionInSpace(spaceId: string, collectionId: string): void {
    const collection = this.repo.getCollection(collectionId);
    if (!collection || collection.spaceId !== spaceId) {
      throw new Error("目标集合不存在或不属于同一空间（禁止跨项目/跨作用域移动）");
    }
  }

  /** 受管文件读取/预览前置校验：词法边界 + 逐组件 symlink/junction 拒绝 */
  /** 受管路径安全校验（供检索/抽取层复用；false = 越界/symlink，不得读取） */
  isManagedFileSafe(abs: string): boolean {
    if (!abs) return false;
    try {
      assertManagedPathSafe(this.root, abs);
      return true;
    } catch {
      return false;
    }
  }

  private assertManagedFile(abs: string): void {
    if (!abs) throw new Error("条目没有受管文件");
    assertManagedPathSafe(this.root, abs);
  }

  /** 受管文件写入前置校验：目标位于 root 内、父链无 symlink/junction（最终组件不存在合法） */
  private assertManagedWritePath(abs: string): void {
    if (!abs) throw new Error("条目没有受管文件");
    assertManagedWritePathSafe(this.root, abs);
  }

  private ownerName(): string {
    try {
      return this.db.getSoul().name?.trim() || "我";
    } catch {
      return "我";
    }
  }

  private spaceDir(spaceId: string): string {
    return join(this.root, spaceId);
  }

  /** New managed item is one logical commit across filesystem + SQLite + FTS. */
  private commitNewManagedItem(item: LibraryItemDto, materialize: () => void): LibraryItemDto {
    const target = this.absolutePath(item);
    let rowInserted = false;
    try {
      materialize();
      this.repo.insertItem(item);
      rowInserted = true;
      this.refreshFts(item);
      return item;
    } catch (error) {
      let retained = false;
      if (rowInserted) {
        try { this.repo.deleteItem(item.id); rowInserted = false; }
        catch { retained = true; }
      }
      if (!rowInserted) {
        try { this.removeFile(item); }
        catch { retained = true; }
      }
      if (retained) {
        throw new LibraryMaterializationPartialStateError(
          "item",
          item.id,
          existsSync(target) ? target : undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }
  private removeFileAfterDurableDelete(item: LibraryItemDto): void {
    try { this.removeFile(item); }
    catch (error) { console.warn(`[Library] 条目 ${item.id} 已从 DB 删除，但受管文件清理失败（orphan）`, error); }
  }
  private writeManagedFile(item: LibraryItemDto, content: string): void {
    const abs = this.absolutePath(item);
    this.assertManagedWritePath(abs);
    atomicWriteFileSync(abs, content);
  }

  private removeFile(item: LibraryItemDto): void {
    const abs = this.absolutePath(item);
    if (abs) {
      try {
        this.assertManagedFile(abs);
      } catch {
        return; // 越界/异常路径不删除（宁可残留也不误删）
      }
      if (existsSync(abs)) rmSync(abs, { force: true });
    }
  }
}


