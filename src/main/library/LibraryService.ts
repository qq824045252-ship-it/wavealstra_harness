import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { AppDatabase } from "../db/AppDatabase";
import { getLibraryDir } from "../paths";
import { resolvedPathKey } from "../platform/paths";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";
import { getMaterialRetrievalSettings, readMaterialRetrievalScope, hybridLibrarySpaceIds, resolveMaterialRetrievalScope } from "./MaterialRetrievalSettings";
import type { LibraryQueryScope } from "./library-query-scope";
import { hiddenLibraryCollectionIds, isVisibleLibraryFile } from "../../shared/library-visibility";
import { SemanticRouter } from "../retrieval/SemanticRouter";
import { WorkspaceSemanticProvider, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION, SEMANTIC_THRESHOLD, type SemanticCandidate } from "../retrieval/WorkspaceSemanticProvider";
import { fuseHits } from "../workspace/WorkspaceResourceLocator.semantic";
import type { WorkspaceResourceHit } from "../../shared/workspace-resource-locator";
import { LibraryRepository, toCollection, toItem, toSpace, toVersion, type LibraryArtifactRow, type LibraryCatalogRows } from "./LibraryRepository";
import { runLibraryDeepSearch, type LibraryEvidenceJudge, type LibraryEvidencePassage } from "./LibraryDeepSearch";
import { LIBRARY_NOTES_BACKUP_LIMIT, libraryNotesBackup, type LibraryNotesBackup } from "./library-note-backup";
import { rewriteImportedFolderLinks, scanLibraryImportFolder } from "./library-folder-import";
import { copyWithRewrittenNoteLinks } from "./library-note-links";
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
import { assertManagedPathSafe, assertManagedWritePathSafe, atomicCopyFileSync, atomicWriteFileSync, readUtf8Prefix, sha256File } from "./library-file-io";
import { matchesImageMime } from "./note-image-format";
import { ContentExtractorRegistry, type ExtractionResult } from "./ContentExtractorRegistry";
import { LibraryIndexMaintenance, type LibraryTextStage } from "./LibraryIndexMaintenance";
import { LibraryTextSaves, NATIVE_LIBRARY_SAVE_MAX_BYTES } from "./LibraryTextSaves";
import { LIBRARY_CHUNK_DEFAULTS } from "./library-chunker";
import { LARGE_LIBRARY_TEXT_BYTES, libraryTextContains, readLibraryTextParts } from "./library-text-parts";
import { getSemanticRuntime, SemanticUnavailableError } from "../retrieval/SemanticRuntime";
import type { RuntimeLibraryImportBatch, RuntimeLibraryDeleteReply, RuntimeLibraryDeleteTarget, RuntimeLibraryNoteChange, RuntimeLibraryRestoreReceipt } from "../platform/runtime-audit";
import type { ProjectLibraryPromotion } from "../project/ProjectMutation";
import {
  LIBRARY_CONTENT_MAX_CHARS,
  LIBRARY_INLINE_FILE_MAX_BYTES,
  LIBRARY_NAME_MAX_CHARS,
  LIBRARY_PERSONAL_SPACE_ID,
  LIBRARY_TITLE_MAX_CHARS,
  type LibraryArtifactDto,
  type LibraryAttachRequest,
  type LibraryCollectionDto,
  type LibraryClipSource,
  type LibraryContentDto,
  type LibraryCreateCollectionRequest,
  type LibraryCreateItemRequest,
  type LibraryCreateSpaceRequest,
  type LibraryCreateUrlRequest,
  type LibraryDetachRequest,
  type LibraryFavoriteRequest,
  type LibraryFolderImportResult,
  type LibraryFolderImportTarget,
  type LibraryImportFileRequest,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibraryListRowDto,
  type LibraryMoveCollectionRequest,
  type LibraryOwnerScope,
  type LibraryRenameCollectionRequest,
  type LibraryRetrievalHitDto,
  type LibrarySaveArtifactRequest,
  type LibrarySearchRequest,
  type LibrarySnapshotDto,
  type LibrarySnapshotRequest,
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
- **独立任务**：临时使用任务附件和任务成果，不创建或使用默认个人资料库；长期内容归项目或工作空间
- 任务产物可保存为长期资料；保存会保留原件及来源记录

## 怎么引用

- 同空间文件用相对路径：\`fetch('./待买清单.csv')\`
- 任意条目用协议：\`mybuddy-library://local/<条目ID>/\`
- Agent 从提示词里的资料库目录按需检索；完整内容用 library_read / 文件工具读取

办公文件（Word / Excel / PPT / PDF）和图片也可以上传到同一棵树；它们是受管副本，
资料库内不提供内联编辑，读取走文件/预览工具。
`;


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
    case ".drawio":
      return "application/xml";
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
    case ".drawio":
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

// A lost IPC reply is resolved by the operation's persistent Core receipt.
function missingOperationReply(error: unknown): undefined {
  if (error && typeof error === "object" && "code" in error && error.code === "RUNTIME_OPERATION_UNKNOWN") return;
  throw error;
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
  private readonly indexMaintenance: LibraryIndexMaintenance;
  private readonly textSaves: LibraryTextSaves;
  private readonly pendingFileMutations = new Set<Promise<unknown>>();

  constructor(
    private readonly db: AppDatabase,
    opts?: { libraryRoot?: string },
  ) {
    this.repo = new LibraryRepository(db.fixtureConnection, db.runtimeAuditReader);
    this.root = opts?.libraryRoot ?? getLibraryDir();
    mkdirSync(this.root, { recursive: true });
    this.textSaves = new LibraryTextSaves(this.db, this.root);
    this.indexMaintenance = new LibraryIndexMaintenance(this.db, this.repo, {
      absolutePath: (item) => this.absolutePath(item),
      assertManagedFile: (path) => this.assertManagedFile(path),
      isManagedFileSafe: (path) => this.isManagedFileSafe(path),
    });
  }

  private get requiresRustWrites(): boolean {
    return this.repo.requiresRustWrites;
  }

  async flushWrites(): Promise<void> {
    await Promise.all([this.flushPendingTextWrites(), this.flushPendingFileMutations(), this.repo.flush()]);
  }

  /** 仅兼容既有个人资料/旧版本数据的显式恢复入口；普通启动和查询不再创建个人资料。 */
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
    return Boolean(!item.trashedAt && space && this.isSpaceVisibleInScope(space, scope) && itemVisibleInTaskScope(item, scope));
  }

  isSpaceWritableInScope(space: LibrarySpaceDto, scope: LibraryTaskScope): boolean {
    if (!scope.writableSpaceIds.has(space.id) || !this.isSpaceVisibleInScope(space, scope)) return false;
    if (scope.projectId && this.isProjectArchived(scope.projectId)) return false;
    if (space.projectId) return space.projectId === scope.projectId && !this.isProjectArchived(space.projectId);
    if (space.workspaceId) return space.workspaceId === scope.workspaceId && Boolean(this.db.getSpace(space.workspaceId)) && !this.db.isSpaceEffectiveArchived(space.workspaceId);
    // 老版本个人空间只允许显式引用读取，不允许临时任务写回。
    return false;
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

  searchOwnedScope(query: string, owner: LibraryOwnerScope, reference?: LibraryOwnerReference, filter?: LibrarySearchRequest["filter"]): LibraryListRowDto[] {
    return this.search(query, this.ownedSearchScope(owner, reference, filter));
  }

  private ownedSearchScope(owner: LibraryOwnerScope, reference?: LibraryOwnerReference, filter?: LibrarySearchRequest["filter"]): LibraryQueryScope {
    const scope = ownedLibraryQueryScope(this.db, this.repo, owner, reference);
    if (!filter) return scope;
    const hiddenFolders = filter.hideDotfiles === true ? hiddenLibraryCollectionIds(this.repo.listCollections()) : undefined;
    if (!hiddenFolders && filter.spaceId && !filter.collectionIds && !filter.tag && !filter.favorite && scope.spaceIds.has(filter.spaceId)) {
      return { spaceIds: new Set([filter.spaceId]) };
    }
    const collections = filter.collectionIds && new Set(filter.collectionIds);
    const itemIds = new Set(this.repo.listItemsInScope(scope).filter((item) =>
      (!filter.spaceId || item.spaceId === filter.spaceId) && (!collections || collections.has(item.collectionId))
      && (!filter.tag || item.tags?.includes(filter.tag)) && (!filter.favorite || item.favorite)
      && (!hiddenFolders || isVisibleLibraryFile(item, hiddenFolders))).map((item) => item.id));
    return { spaceIds: new Set(), itemIds };
  }

  deepSearchOwnedScope(request: import("../../shared/library-ipc").LibraryScopedDeepSearchRequest,
    resolveJudge: () => Promise<LibraryEvidenceJudge>) {
    if (request?.owner?.type !== "project" && request?.owner?.type !== "workspace") {
      throw new Error("深搜需要明确的项目或工作空间归属");
    }
    if (this.db.coreIdentity) {
      return this.deepSearchCore(request.query, request.limit,
        async()=>({spaceIds:new Set(),itemIds:new Set((await this.readWorkbenchSearchScope(request)).items.keys())}),resolveJudge);
    }
    return this.deepSearch(request.query, request.limit,
      () => this.ownedSearchScope(request.owner, request.reference, request.filter), resolveJudge);
  }

  private deepSearchCore(query:string, limit:number|undefined, scope:()=>Promise<LibraryQueryScope>,
    resolveJudge:()=>Promise<LibraryEvidenceJudge>, signal?:AbortSignal) {
      return runLibraryDeepSearch({query,limit,resolveJudge,signal,scope,
        index:{
          candidates:async(scope,terms,seen,limit)=>{
            const rows=await this.db.runtimeAuditReader?.libraryMetadata<LibraryEvidencePassage[]>({kind:"deepCandidates",
              ids:[...scope.itemIds??[]],terms,seen:[...seen],limit});
            if (!rows) throw new Error("Core 未确认深搜候选");
            return rows;
          },
          frequencies:async(scope,terms)=>{
            const rows=await this.db.runtimeAuditReader?.libraryMetadata<{term:string;hits:number}[]>({kind:"deepFrequencies",
              ids:[...scope.itemIds??[]],terms});
            if (!rows) throw new Error("Core 未确认深搜词频");
            return new Map(rows.map(row=>[row.term,row.hits]));
          },
          current:async(scope,passage)=>{
            if (!scope.itemIds?.has(passage.itemId)) return false;
            const row=await this.corePassage(passage.itemId,passage.startOffset,passage.chunkHash);
            return row?.chunkId===passage.chunkId && row.spaceId===passage.spaceId && row.title===passage.title && row.text===passage.text;
          }
        }
      });
  }

  deepSearchInTaskScope(query: string, limit: number | undefined, resolveScope: () => LibraryTaskScope,
    resolveJudge: () => Promise<LibraryEvidenceJudge>, signal?: AbortSignal,
    coreScope?:()=>{taskId?:string; projectId?:string}) {
    if (this.db.coreIdentity) {
      if (!coreScope) throw new Error("Core 未确认深搜任务身份");
      return this.deepSearchCore(query,limit,async()=>{
        const result=await this.db.runtimeAuditReader?.libraryMetadata<{items:{id:string}[]}|null>({kind:"taskScope",...coreScope()});
        if (result === undefined) throw new Error("Core 未确认深搜任务范围");
        return {spaceIds:new Set(), itemIds:new Set(result?.items.map(item=>item.id) ?? [])};
      },resolveJudge,signal);
    }
    return this.deepSearch(query, limit, () => queryScopeForTask(resolveScope()), resolveJudge, signal);
  }

  private async corePassage(itemId:string,offset:number,hash:string) {
    const result = await this.db.runtimeAuditReader?.libraryMetadata<LibraryEvidencePassage|null>({
      kind:"deepPassage",ids:[itemId],itemId,offset,hash});
    if (result === undefined) throw new Error("Core 未确认证据片段");
    return result;
  }

  async readScopedEvidence(request: import("../../shared/library-ipc").LibraryScopedEvidenceRequest) {
    if (!this.db.coreIdentity) return this.readOwnedEvidence(request);
    if (request.owner?.type !== "project" && request.owner?.type !== "workspace") throw new Error("证据回读需要明确的项目或工作空间归属");
    const query = {...request,query:""};
    const {itemId,source} = request;
    const rejected = () => new Error("证据片段已更新或超出当前资料范围，请重新深搜");
    if (!(await this.readWorkbenchSearchScope(query)).items.has(itemId)) throw rejected();
    const passage = await this.corePassage(itemId,source.startOffset,source.chunkHash);
    if (!passage || passage.text.length+source.startOffset !== source.endOffset ||
        !(await this.readWorkbenchSearchScope(query)).items.has(itemId)) throw rejected();
    return {text:passage.text};
  }

  readOwnedEvidence(request: import("../../shared/library-ipc").LibraryScopedEvidenceRequest): { text: string } {
    if (request?.owner?.type !== "project" && request?.owner?.type !== "workspace") {
      throw new Error("证据回读需要明确的项目或工作空间归属");
    }
    const { source, owner, reference, filter, itemId } = request;
    const scope = this.ownedSearchScope(owner, reference, filter);
    const text = this.repo.readDeepSearchPassage(scope, itemId, source.startOffset, source.chunkHash);
    if (text === undefined || source.startOffset + text.length !== source.endOffset) {
      throw new Error("证据片段已更新或超出当前资料范围，请重新深搜");
    }
    return { text };
  }

  private deepSearch(query: string, limit: number | undefined, scope: () => LibraryQueryScope,
    resolveJudge: () => Promise<LibraryEvidenceJudge>, signal?: AbortSignal) {
    return runLibraryDeepSearch({
      query, limit, scope, resolveJudge, signal,
      index: {
        candidates: (current, terms, seen, count) => this.repo.deepSearchCandidates(current, terms, seen, count),
        current: (current, passage) => this.repo.isDeepSearchPassageCurrent(current, passage),
        frequencies: (current, terms) => this.repo.deepSearchTermFrequencies(current, terms),
      },
    });
  }

  materialRetrievalUsesHybrid(owner?: LibraryOwnerScope | null): boolean {
    if (owner?.type === "project") return resolveMaterialRetrievalScope(this.db, { kind: "project", id: owner.projectId }).effective === "hybrid";
    if (owner?.type === "workspace") return resolveMaterialRetrievalScope(this.db, { kind: "space", id: owner.workspaceId }).effective === "hybrid";
    return getMaterialRetrievalSettings(this.db).mode === "hybrid";
  }

  async semanticCandidates(
    query: string,
    resolveScope: () => LibraryQueryScope,
    limit: number,
    provider: WorkspaceSemanticProvider,
    isEnabled: () => boolean,
  ): Promise<SemanticCandidate[]> {
    const scope = resolveScope();
    if (!isEnabled()) return [];
    const hybrid = new Set(hybridLibrarySpaceIds(this.db));
    const allowedLibrarySpaceIds = [...scope.spaceIds].filter((id) => hybrid.has(id));
    const allowedLibraryCollectionIds = [...scope.collectionIds ?? []].filter((id) => {
      const folder = this.repo.getCollection(id);
      return Boolean(folder && hybrid.has(folder.spaceId));
    });
    const allowedLibraryItemIds = [...scope.itemIds ?? []].filter((id) => {
      const item = this.repo.getItem(id);
      return Boolean(item && hybrid.has(item.spaceId));
    });
    if (!allowedLibrarySpaceIds.length && !allowedLibraryCollectionIds.length && !allowedLibraryItemIds.length) return [];
    const candidates = await provider.search({ query, limit, allowedLibrarySpaceIds, allowedLibraryCollectionIds, allowedLibraryItemIds });
    if (!isEnabled()) return [];
    const currentScope = resolveScope();
    const currentHybrid = new Set(hybridLibrarySpaceIds(this.db));
    return candidates.filter(({ itemId }) => {
      const item = this.repo.getItem(itemId);
      return item && currentHybrid.has(item.spaceId) && this.itemInQueryScope(item, currentScope);
    });
  }

  private itemInQueryScope(item: LibraryItemDto, scope: LibraryQueryScope): boolean {
    return item.trashedAt == null && (scope.spaceIds.has(item.spaceId) || scope.itemIds?.has(item.id) === true
      || (item.collectionId !== null && scope.collectionIds?.has(item.collectionId) === true));
  }

  private readonly searchRouter = new SemanticRouter();
  private queryProvider?: WorkspaceSemanticProvider;

  private async readWorkbenchSearchScope({owner, reference, filter}: LibrarySearchRequest) {
    const snapshot = await this.readSnapshot({owner});
    const folders = snapshot.collections;
    const descendants = reference?.collectionId != null ? new Set<string>([reference.collectionId]) : undefined;
    if (descendants) {
      const children = new Map<string,string[]>();
      for (const folder of folders) {
        if (folder.parentId && folder.spaceId === reference?.spaceId) {
          const ids = children.get(folder.parentId) ?? [];
          ids.push(folder.id);
          children.set(folder.parentId, ids);
        }
      }
      if (!folders.some(folder => folder.id === reference?.collectionId && folder.spaceId === reference.spaceId)) descendants.clear();
      for (const id of descendants) for (const child of children.get(id) ?? []) descendants.add(child);
    }
    const hidden = filter?.hideDotfiles ? hiddenLibraryCollectionIds(folders) : undefined;
    const items = snapshot.items.filter(item => !item.trashedAt && item.kind !== "url"
      && (!reference || (item.spaceId === reference.spaceId && (reference.itemId === undefined || reference.itemId === item.id)))
      && (!descendants || (item.collectionId && descendants.has(item.collectionId)))
      && (!filter?.spaceId || item.spaceId === filter.spaceId)
      && (!filter?.collectionIds || filter.collectionIds.includes(item.collectionId))
      && (!filter?.tag || item.tags?.includes(filter.tag)) && (!filter?.favorite || item.favorite)
      && (!hidden || isVisibleLibraryFile(item,hidden)));
    return {items:new Map(items.map(item => [item.id,item])), spaces:new Map(snapshot.spaces.map(space=>[space.id,space]))};
  }

  private async hybridSearchIds(scope: Awaited<ReturnType<LibraryService["readWorkbenchSearchScope"]>>, owner?: LibraryOwnerScope) {
    const policy = (projectId?: string | null, workspaceId?: string | null) => readMaterialRetrievalScope(this.db,
      projectId ? {kind:"project",id:projectId} : workspaceId ? {kind:"space",id:workspaceId} : undefined);
    if ((await policy(owner?.type === "project" ? owner.projectId : null,
      owner?.type === "workspace" ? owner.workspaceId : null)).effective !== "hybrid") return [];
    const spaces = new Set<string>();
    for (const id of new Set([...scope.items.values()].map(item => item.spaceId))) {
      const space = scope.spaces.get(id);
      if (space && (await policy(space.projectId,space.workspaceId)).effective === "hybrid") spaces.add(id);
    }
    return [...scope.items.values()].filter(item => spaces.has(item.spaceId)).map(item => item.id);
  }

  private async searchWorkbenchCore(request: LibrarySearchRequest): Promise<LibraryListRowDto[]> {
    const query = request.query.trim();
    if (!query) return [];
    const reader = this.db.runtimeAuditReader!;
    const scope = await this.readWorkbenchSearchScope(request);
    if (!scope.items.size) return [];
    const prefix = query.length > LIBRARY_CHUNK_DEFAULTS.overlap ? query.slice(0,LIBRARY_CHUNK_DEFAULTS.overlap-1).replace(/[\ud800-\udbff]$/u,"") : "";
    const matches = await reader.libraryMetadata<Array<{id:string; rank:number}>>({kind:"searchKeyword",
      query,prefix,ids:[...scope.items.keys()]});
    if (!matches) throw new Error("Core 未确认资料检索");
    const lexical: WorkspaceResourceHit[] = [];
    for (const match of matches) {
      const item = scope.items.get(match.id);
      if (!item) continue;
      if (match.rank === 3) {
        if (!this.repo.isTextSearchable(item.kind)) continue;
        const path = this.absolutePath(item);
        if (!existsSync(path)) continue;
        this.assertManagedFile(path);
        if (!libraryTextContains(readLibraryTextParts(path),query.toLowerCase())) continue;
      }
      lexical.push(this.resourceHit(item,query,2));
      if (lexical.length === 80) break;
    }
    let candidates: SemanticCandidate[] = [];
    if (this.searchRouter.shouldFallback({query,lexicalHits:lexical}).shouldFallback) {
      const ids = await this.hybridSearchIds(scope,request.owner);
      if (ids.length) {
        const provider = this.queryProvider ??= new WorkspaceSemanticProvider(this.db);
        let vector: Float32Array | undefined;
        try { vector = await provider.embed(query); }
        catch (error) { if (!(error instanceof SemanticUnavailableError)) throw error; }
        if (vector) {
          const ranked = await reader.semantic({target:"library",limit:50,dimension:SEMANTIC_DIMENSION,
            modelId:SEMANTIC_MODEL_ID,modelVersion:SEMANTIC_MODEL_VERSION,query:vector,threshold:SEMANTIC_THRESHOLD,
            scope:{sql:"li.id IN (SELECT unnest(?::JSON::VARCHAR[]))",args:[JSON.stringify(ids)]}});
          if (!ranked) throw new Error("Core 未确认资料语义排序");
          if (ranked.length) {
            const chunks = await reader.libraryMetadata<Array<{chunk_id:string;item_id:string;chunk_index:number;char_offset:number;content:string}>>({
              kind:"searchChunks",ids,hits:ranked.map(hit=>[hit.id,hit.hash]),model:SEMANTIC_MODEL_ID,version:SEMANTIC_MODEL_VERSION,dimension:SEMANTIC_DIMENSION});
            if (!chunks) throw new Error("Core 未确认资料语义片段");
            const scores = new Map(ranked.map(hit=>[hit.id,hit.score]));
            candidates = chunks.map(chunk=>({itemId:chunk.item_id,chunkId:chunk.chunk_id,chunkIndex:chunk.chunk_index,
              charOffset:chunk.char_offset,preview:chunk.content.replace(/\s+/g," ").trim(),score:scores.get(chunk.chunk_id)!}));
          }
        }
      }
    }
    const final = await this.readWorkbenchSearchScope(request);
    if (candidates.length) {
      const current = new Set(await this.hybridSearchIds(final,request.owner));
      candidates = candidates.filter(hit=>current.has(hit.itemId));
    }
    const hits = candidates.length ? fuseHits(lexical,candidates,id=>final.items.get(id),80) : lexical;
    return hits.flatMap(({id})=>{
      const item=final.items.get(id);
      return item ? [this.toRow(item,final.spaces.get(item.spaceId)?.name ?? "资料库")] : [];
    });
  }

  async searchAsync(request: LibrarySearchRequest): Promise<LibraryListRowDto[]> {
    if (this.db.coreIdentity) return this.searchWorkbenchCore(request);
    const { query, owner, reference, filter } = request;
    const scope = () => owner ? this.ownedSearchScope(owner, reference, filter)
      : { spaceIds: new Set(this.repo.listSpaces().map((space) => space.id)) };
    const rows = this.search(query, scope());
    const lexical = rows.flatMap((row) => {
      const item = this.repo.getItem(row.id);
      return item ? [this.resourceHit(item, query, 2)] : [];
    });
    const candidates = await this.normalSemanticSearch(query, lexical, scope, 80, () => this.materialRetrievalUsesHybrid(owner));
    const currentScope = scope();
    if (!candidates.length) return rows.filter((row) => {
      const item = this.repo.getItem(row.id);
      return item && this.itemInQueryScope(item, currentScope);
    });
    const names = new Map(this.repo.listSpaces().map((space) => [space.id, space.name]));
    return fuseHits(lexical, candidates, (id) => this.repo.getItem(id) ?? undefined, 80).flatMap(({ id }) => {
      const item = this.repo.getItem(id);
      return item && this.itemInQueryScope(item, currentScope) ? [this.toRow(item, names.get(item.spaceId) ?? "资料库")] : [];
    });
  }

  async retrieveForTaskAsync(query: string, taskId: string, limit: number, kind?: LibraryItemKind): Promise<LibraryRetrievalHitDto[]> {
    const scope = () => queryScopeForTask(this.resolveTaskScope(taskId));
    const lexical = this.retrieve(query, { ...scope(), limit }).filter((hit) => !kind || hit.kind === kind);
    const resolve = () => {
      const current = scope();
      return kind ? { spaceIds: new Set<string>(), itemIds: new Set(this.repo.listItemsInScope(current)
        .filter((item) => item.kind === kind).map((item) => item.id)) } : current;
    };
    const byId = new Map(lexical.map((hit) => [hit.itemId, hit]));
    const resources = lexical.flatMap((hit) => {
      const item = this.repo.getItem(hit.itemId);
      return item ? [this.resourceHit(item, query, hit.rank, hit.snippet)] : [];
    });
    const candidates = await this.normalSemanticSearch(query, resources, resolve, limit,
      () => this.materialRetrievalUsesHybrid(this.resolveTaskScope(taskId).defaultOwner));
    const current = resolve();
    const hits = candidates.length ? fuseHits(resources, candidates, (id) => this.repo.getItem(id) ?? undefined, limit) : resources;
    return hits.flatMap((hit) => {
      const item = this.repo.getItem(hit.id);
      if (!item || !this.itemInQueryScope(item, current)) return [];
      const existing = byId.get(item.id);
      if (hit.matchedBy !== "semantic" && existing) return [existing];
      return [{
        itemId: item.id, title: item.title, kind: item.kind, spaceId: item.spaceId,
        rank: 4, snippet: hit.preview, favorite: item.favorite, sourceType: item.sourceType,
        sourceTaskId: item.sourceTaskId, updatedAt: item.updatedAt,
      }];
    });
  }

  private resourceHit(item: LibraryItemDto, query: string, rank: number, preview = ""): WorkspaceResourceHit {
    const needle = query.trim().toLowerCase();
    const matchedBy = item.title.toLowerCase().includes(needle) ? "title" : item.filename.toLowerCase().includes(needle) ? "filename"
      : rank <= 2 ? "fts" : "fallback";
    return {
      resourceType: "library", id: item.id, spaceId: item.spaceId, title: item.title, filename: item.filename,
      preview, matchedBy, score: rank, freshness: item.updatedAt, provider: "library", kind: item.kind,
    };
  }

  private async normalSemanticSearch(
    query: string, lexical: WorkspaceResourceHit[], resolveScope: () => LibraryQueryScope, limit: number, enabled: () => boolean,
  ): Promise<SemanticCandidate[]> {
    if (!query.trim() || !enabled() || !this.searchRouter.shouldFallback({ query, lexicalHits: lexical }).shouldFallback) return [];
    try {
      return await this.semanticCandidates(query, resolveScope, limit, this.queryProvider ??= new WorkspaceSemanticProvider(this.db), enabled);
    } catch {
      // The lexical route remains available while a semantic model is absent or unavailable.
      return [];
    }
  }

  retrieveInScope(query: string, scope: LibraryTaskScope, opts?: { limit?: number }): LibraryRetrievalHitDto[] {
    return this.retrieve(query, { ...queryScopeForTask(scope), limit: opts?.limit });
  }

  defaultSpaceForTask(taskId?: string | null, projectFallback?: string | null): LibrarySpaceDto {
    const scope = this.resolveTaskScope(taskId, projectFallback);
    if (!scope.defaultOwner) {
      const task = scope.taskId ? this.db.getTask(scope.taskId) : undefined;
      if (task && !task.projectId && !task.spaceId) throw new Error("独立任务没有长期资料库，请将长期资料归入项目或工作空间");
      throw new Error("无法确定有效任务的资料归属");
    }
    const space = this.ensureOwnedSpace(scope.defaultOwner);
    if (!this.isSpaceWritableInScope(space, this.resolveTaskScope(taskId, projectFallback))) {
      throw new Error("当前任务的资料归属已归档或不可写");
    }
    return space;
  }

  snapshot(): LibrarySnapshotDto {
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

  async readSnapshot(request: LibrarySnapshotRequest = {}): Promise<LibrarySnapshotDto> {
    const { owner, spaceId, itemId } = request;
    const catalog = await this.db.runtimeAuditReader?.libraryMetadata<LibraryCatalogRows>({
      kind: "catalog", owner, spaceIds: spaceId === undefined ? undefined : [spaceId], itemId,
    });
    if (catalog) {
      const { ownerName } = catalog;
      const spaces = catalog.spaces.map(toSpace);
      const items = catalog.items.map(toItem);
      const names = new Map(spaces.map(space => [space.id, space.name]));
      const entries = new Map(items.map(item => [item.id, item]));
      const recent = catalog.recentIds.flatMap(id => {
        const item = entries.get(id);
        return item ? [this.toRow(item, names.get(item.spaceId) ?? "我的文档")] : [];
      });
      return {
        spaces, collections: catalog.collections.map(toCollection), items, recent, ownerName,
        artifacts: catalog.artifacts.map(row => this.toLibraryArtifact(row, ownerName)),
        storage: { usedBytes: catalog.usedBytes },
      };
    }
    if (this.db.coreIdentity) throw new Error("资料库目录读取未获 Rust Core 确认");
    let spaceIds = owner ? ownedLibraryQueryScope(this.db, this.repo, owner).spaceIds : undefined;
    if (spaceId !== undefined) spaceIds = new Set(!spaceIds || spaceIds.has(spaceId) ? [spaceId] : []);
    const ownerName = this.ownerName();
    if (itemId !== undefined) {
      const item = this.repo.getItem(itemId);
      const space = item && (!spaceIds || spaceIds.has(item.spaceId)) ? this.repo.getSpace(item.spaceId) : null;
      const items = item && space ? [item] : [];
      return {
        spaces: space ? [this.withOwnerName(space)] : [], collections: [], items, recent: [], artifacts: [], ownerName,
        storage: { usedBytes: items[0]?.sizeBytes ?? 0 },
      };
    }
    if (!spaceIds) return this.snapshot();
    const spaces = this.repo.listSpaces().filter(space => spaceIds.has(space.id)).map(space => this.withOwnerName(space));
    const items = this.repo.listItemsInScope({ spaceIds });
    const names = new Map(spaces.map(space => [space.id, space.name]));
    return {
      spaces, items, artifacts: [], ownerName,
      collections: this.repo.listCollections().filter(folder => names.has(folder.spaceId)),
      recent: this.repo.listRecent().filter(item => names.has(item.spaceId))
        .map(item => this.toRow(item, names.get(item.spaceId) ?? "我的文档")),
      storage: { usedBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) },
    };
  }

  listItems(spaceId: string, collectionId?: string | null): LibraryItemDto[] {
    return this.repo.listItems(spaceId, collectionId);
  }

  async readItems(spaceId: string, collectionId?: string | null): Promise<LibraryItemDto[]> {
    if (!this.db.coreIdentity) return this.listItems(spaceId, collectionId);
    const { items } = await this.readSnapshot({ spaceId });
    return collectionId === undefined ? items : items.filter(item => item.collectionId === collectionId);
  }

  /** 全量条目（Agent 工具用；可选按空间过滤） */
  listAllItems(spaceId?: string): LibraryItemDto[] {
    return this.repo.listItems(spaceId);
  }

  async readItemAsync(id: string): Promise<LibraryItemDto | null> {
    return this.db.coreIdentity ? (await this.readSnapshot({itemId:id})).items[0] ?? null : this.getItem(id);
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

  private async catalogEdit<Row>(edit: Record<string, unknown>): Promise<Row> {
    const row = await this.db.runtimeAuditReader?.batch3Write<Row>({kind:"libraryCatalogEdit",edit,at:Date.now()});
    if (!row) throw new Error("Core 未确认资料目录变更");
    return row;
  }

  async createSpaceAsync(req: LibraryCreateSpaceRequest): Promise<LibrarySpaceDto> {
    if (!this.db.coreIdentity) return this.createSpace(req);
    if (req.projectId && req.workspaceId) throw new Error("资料空间只能归属于一个项目或工作空间");
    const owner: LibraryOwnerScope = req.projectId ? {type:"project",projectId:req.projectId}
      : req.workspaceId ? {type:"workspace",workspaceId:req.workspaceId} : {type:"personal"};
    return toSpace(await this.catalogEdit({kind:"space", id:randomUUID(),owner,ensure:false,root:this.root,
      name:limitText(safeName(req.name),LIBRARY_NAME_MAX_CHARS,"空间名称")}));
  }

  async ensureOwnedSpaceAsync(owner: LibraryOwnerScope): Promise<LibrarySpaceDto> {
    if (!this.db.coreIdentity) return this.ensureOwnedSpace(owner);
    return toSpace(await this.catalogEdit({kind:"space",id:randomUUID(),owner,ensure:true,root:this.root,
      welcome:owner.type === "personal" ? {title:WELCOME_TITLE,content:WELCOME_MD} : undefined}));
  }

  async renameSpaceAsync(id:string, name:string): Promise<LibrarySpaceDto> {
    if (!this.db.coreIdentity) return this.renameSpace(id,name);
    return toSpace(await this.catalogEdit({kind:"renameSpace",id,name:safeName(name)}));
  }

  async createCollectionAsync(req: LibraryCreateCollectionRequest): Promise<LibraryCollectionDto> {
    if (!this.db.coreIdentity) return this.createCollection(req);
    return toCollection(await this.catalogEdit({kind:"folder",id:randomUUID(),spaceId:req.spaceId,parentId:req.parentId,
      name:limitText(safeName(req.name?.trim() || "未命名文件夹"),LIBRARY_NAME_MAX_CHARS,"集合名称")}));
  }

  async renameCollectionAsync(req: LibraryRenameCollectionRequest): Promise<LibraryCollectionDto> {
    if (!this.db.coreIdentity) return this.renameCollection(req);
    return toCollection(await this.catalogEdit({kind:"renameFolder",id:req.id,
      name:limitText(safeName(req.name),LIBRARY_NAME_MAX_CHARS,"集合名称")}));
  }

  async moveCollectionAsync(req: LibraryMoveCollectionRequest): Promise<LibraryCollectionDto> {
    if (!this.db.coreIdentity) return this.moveCollection(req);
    return toCollection(await this.catalogEdit({kind:"moveFolder",id:req.id,parentId:req.parentId}));
  }

  async updateItemAsync(req: LibraryUpdateItemRequest): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.updateItem(req);
    return toItem(await this.catalogEdit({kind:"item",id:req.id,title:req.title === undefined ? undefined : safeName(req.title),
      changeCollection:req.collectionId !== undefined,collectionId:req.collectionId}));
  }

  createSpace(req: LibraryCreateSpaceRequest): LibrarySpaceDto {
    const { projectId } = req;
    if (projectId && req.workspaceId) throw new Error("资料空间只能归属于一个项目或工作空间");
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
      if (projectId || req.workspaceId) {
        const commitSpace = () => {
          if (projectId && !this.projectExists(projectId)) throw new Error("项目不存在");
          if (projectId && this.isProjectArchived(projectId)) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
          if (req.workspaceId && !this.db.getSpace(req.workspaceId)) throw new Error("工作空间不存在");
          if (req.workspaceId && this.db.isSpaceEffectiveArchived(req.workspaceId)) throw new Error("已归档工作空间的资料只可读取");
          this.repo.insertSpace(space);
          mkdirSync(spacePath, { recursive: true });
        };
        if (this.requiresRustWrites) commitSpace();
        else this.db.connection.transaction(commitSpace).immediate();
        rowInserted = true;
      } else {
        this.repo.insertSpace(space);
        rowInserted = true;
        mkdirSync(spacePath, { recursive: true });
      }
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
    this.deleteSpaceUnchecked(this.requireDeletableSpace(id));
  }

  private requireDeletableSpace(id: string): LibrarySpaceDto {
    const space = this.requireWritableSpace(id);
    if (space.kind === "personal") throw new Error("个人文档空间不能删除");
    return space;
  }

  async deleteSpaceAsync(id: string): Promise<void> {
    if (!this.db.coreIdentity) this.requireDeletableSpace(id);
    await this.flushPendingTextWrites();
    await this.deleteNative({ kind: "space", id }, () => !this.repo.getSpace(id), () => this.deleteSpace(id));
  }

  private deleteSpaceUnchecked(space: LibrarySpaceDto): void {
    const items = this.requiresRustWrites
      ? this.deleteSpaceMetadata(space.id)
      : this.db.connection.transaction(() => this.deleteSpaceMetadata(space.id))();
    this.removeSpaceFiles(space.id, items);
  }

  private deleteSpaceMetadata(spaceId: string): LibraryItemDto[] {
    const items = this.repo.listItems(spaceId, undefined, true);
    const collections = this.repo.listCollections(spaceId);
    for (const item of items) this.repo.deleteItem(item.id);
    for (const collection of [...collections].reverse()) {
      this.db.deleteLibraryCollectionLinks(collection.id);
      this.repo.deleteCollection(collection.id);
    }
    this.db.deleteLibrarySpaceLinks(spaceId);
    this.repo.deleteSpace(spaceId);
    return items;
  }

  private removeSpaceFiles(spaceId: string, items: LibraryItemDto[]): void {
    for (const item of items) this.removeFileAfterDurableDelete(item);
    try { rmSync(this.spaceDir(spaceId), { recursive: true, force: true }); }
    catch (error) { console.warn(`[Library] 空间 ${spaceId} 已删除，但目录清理失败（orphan）`, error); }
  }

  /** 项目删除语义：级联删除该项目全部资料空间（集合/条目/版本/引用/受管文件）。personal 不受影响。 */
  deleteProjectLibrary(projectId: string): void {
    this.withHostProjectDeletion(projectId, () => undefined);
  }

  withHostProjectDeletion<T>(projectId: string, deleteProjectData: () => T): T {
    const runDelete = () => {
      const spaces = this.repo.listProjectSpaces(projectId).map(space => ({
        id: space.id, items: this.deleteSpaceMetadata(space.id),
      }));
      return { spaces, result: deleteProjectData() };
    };
    const { spaces, result } = this.requiresRustWrites
      ? runDelete()
      : this.db.connection.transaction(runDelete).immediate();
    for (const space of spaces) this.removeSpaceFiles(space.id, space.items);
    return result;
  }

  async withProjectLibraryDeletion<T extends { itemIds: string[] }>(
    remove: (root: string) => Promise<T>,
  ): Promise<T> {
    await this.flushPendingTextWrites();
    await this.flushPendingFileMutations();
    return this.trackFileMutation(remove(this.textSaves.root).then(async result => {
      for (const id of result.itemIds) this.indexMaintenance.forgetItem(id);
      await this.recoverFileDeletes().catch(error => console.warn("[Library] 项目资料文件清理将重试", error));
      return result;
    }));
  }

  /* ---------------- Collections ---------------- */

  async createWorkspaceFolder(workspaceId: string, librarySpaceId: string, name: string): Promise<void> {
    if (!name?.trim()) throw new Error("文件夹名称不能为空");
    const result = await this.db.runtimeAuditReader?.writeWorkspaceBinding({
      kind: "createFolder", workspaceId, librarySpaceId, collectionId: randomUUID(),
      name: limitText(safeName(name), LIBRARY_NAME_MAX_CHARS, "集合名称"), at: Date.now(),
    });
    if (result?.status === "rejected") throw new Error(result.message);
    if (result?.status !== "saved") throw new Error("Core 未确认文件夹及其关联已保存");
  }

  createCollection(req: LibraryCreateCollectionRequest): LibraryCollectionDto {
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

  async deleteCollectionAsync(id: string): Promise<void> {
    if (!this.db.coreIdentity) {
      const collection = this.repo.getCollection(id);
      if (!collection) throw new Error("集合不存在");
      this.requireWritableSpace(collection.spaceId);
    }
    await this.flushPendingTextWrites();
    await this.deleteNative({ kind: "collection", id }, () => !this.repo.getCollection(id), () => this.deleteCollection(id));
  }

  /* ---------------- Items ---------------- */

  private itemTitle(spaceId: string, input: string): string {
    const title = safeName(input);
    return this.repo.getSpace(spaceId)?.projectId ? title : limitText(title, LIBRARY_TITLE_MAX_CHARS, "标题");
  }

  async promoteProjectEventDocument(request: ProjectLibraryPromotion): Promise<"changed" | "existingPromotion" | undefined> {
    const useHost = () => {
      if (this.requiresRustWrites) throw new Error("项目资料保存需要 Rust 核心");
      if (request.actorTaskId && !this.db.connection.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?")
        .get(request.actorTaskId, request.projectId)) {
        throw new Error("任务的项目归属已变化，请重新读取");
      }
      return undefined;
    };
    const runtime = this.db.runtimeAuditReader;
    if (!runtime || this.db.inTransaction || !await runtime.supportsProjectWrites("eventLibraryPromotion")) return useHost();
    const operationId = randomUUID();
    const itemId = randomUUID();
    return this.trackFileMutation(runtime.promoteProjectEventToLibrary({
      ...request, title: safeName(request.title), spaceName: safeName(request.spaceName),
      operationId, itemId, promotionId: `pepr_${randomUUID()}`, spaceId: randomUUID(),
      root: this.textSaves.root, owner: this.ownerName(), savedAt: Date.now(), ...LIBRARY_CHUNK_DEFAULTS,
    }).catch(missingOperationReply).then(async result => {
      if (result?.status === "needsHost") return useHost();
      if (result?.status === "rejected") throw new Error(result.message);
      if (result?.status === "existingPromotion") return result.status;
      if (!result) {
        const committed = await runtime.projectMetadata<boolean>({ kind: "writeReceipt", operationId });
        await this.recoverLibraryRestores();
        if (!committed) throw new Error("项目资料保存中断，请重试");
      }
      this.indexMaintenance.noteTextIndexed(itemId);
      return "changed";
    }));
  }

  async createItemAsync(req: LibraryCreateItemRequest, options?: {source?: LibraryClipSource; tags: string[]; owner: LibraryOwnerScope; merge?: Extract<RuntimeLibraryNoteChange,{kind:"create"}>["document"]["merge"]}): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.createItem(req, options?.source, options?.tags);
    const id = randomUUID();
    const title = safeName(req.title?.trim() || defaultTitle(req.kind));
    const content = req.content ?? seedContent(req.kind,title);
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error("创建资料需要 Rust 核心");
    return this.trackFileMutation((async () => {
      const reply = await reader.writeLibraryNote<LibraryCatalogRows["items"][number]>({
        kind:"create", document:{ id, clipSource: options?.source, tags: options?.tags, owner: options?.owner, operationId: randomUUID(), title, content, documentKind: req.kind,
          spaceId: req.spaceId, collectionId: req.collectionId, root: this.root, merge: options?.merge, ...LIBRARY_CHUNK_DEFAULTS },
      }).catch(missingOperationReply);
      const item = reply?.status === "updated" && reply.item ? toItem(reply.item)
        : !reply ? (await this.readSnapshot({itemId:id})).items[0] : undefined;
      if (!item) throw new Error("Core 未确认资料新建，请刷新资料库查看");
      this.indexMaintenance.noteTextIndexed(id);
      return item;
    })());
  }

  createItem(req: LibraryCreateItemRequest, clipSource?: LibraryClipSource, tags?: string[]): LibraryItemDto {
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const title = this.itemTitle(req.spaceId, req.title?.trim() || defaultTitle(req.kind));
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
      clipSource,
      tags,
      sourceType: "created",
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    const body = req.content ?? seedContent(req.kind, title);
    this.assertContentLength(req.spaceId, body);
    item.sizeBytes = Buffer.byteLength(body);
    item.contentHash = sha256(body);
    return this.commitNewManagedItem(item, () => this.writeManagedFile(item, body));
  }

  private parseLibraryUrl(value: string): URL {
    const raw = value.trim();
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
    return url;
  }

  async createUrlAsync(req: LibraryCreateUrlRequest): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.createUrl(req);
    const url = this.parseLibraryUrl(req.url);
    const title = safeName(req.title?.trim() || url.hostname + url.pathname.replace(/\/+$/, ""));
    const id = randomUUID();
    const reply = await this.db.runtimeAuditReader!.writeLibraryNote<LibraryCatalogRows["items"][number]>({
      kind: "create", document: { id, operationId: randomUUID(), spaceId: req.spaceId, collectionId: req.collectionId,
        documentKind: "url", title, content: url.href, root: this.root, ...LIBRARY_CHUNK_DEFAULTS },
    }).catch(missingOperationReply);
    if (reply?.status === "updated" && reply.item) return toItem(reply.item);
    if (!reply) {
      const committed = await this.readItemAsync(id);
      if (committed) return committed;
    }
    throw new Error("Core 未确认链接保存，请刷新资料库查看");
  }

  createUrl(req: LibraryCreateUrlRequest): LibraryItemDto {
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    const url = this.parseLibraryUrl(req.url);
    const title = this.itemTitle(req.spaceId, req.title?.trim() || url.hostname + url.pathname.replace(/\/+$/, ""));
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
      next.title = this.itemTitle(item.spaceId, req.title);
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
      this.repo.updateItem(next, item);
      this.refreshFts(next);
      return next;
    } catch (error) {
      const rollbackErrors: string[] = [];
      try { this.repo.updateItem(item, next); }
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
  async setFavorite(req: LibraryFavoriteRequest): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.favorite(req);
    return this.changeItemAccess({kind:"libraryFavoriteItem", id:req.id, favorite:Boolean(req.favorite), at:Date.now()});
  }

  async visitItem(id: string): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.markVisited(id);
    return this.changeItemAccess({kind:"libraryVisitItem", id, at:Date.now()});
  }

  private async changeItemAccess(request: Record<string, unknown>): Promise<LibraryItemDto> {
    const reply = await this.db.runtimeAuditReader?.batch3Write<{item:Parameters<typeof toItem>[0]}>(request);
    if (!reply?.item) throw new Error("Core 未确认资料条目变更");
    return toItem(reply.item);
  }

  favorite(req: LibraryFavoriteRequest): LibraryItemDto {
    const item = this.repo.getItem(req.id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    const next = { ...item, favorite: Boolean(req.favorite), updatedAt: Date.now() };
    this.repo.updateItem(next, item);
    return next;
  }

  listVersions(itemId: string): import("../../shared/library-ipc").LibraryVersionDto[] {
    return this.repo.listVersions(itemId);
  }

  async readVersions(itemId: string): Promise<import("../../shared/library-ipc").LibraryVersionDto[]> {
    const rows = await this.db.runtimeAuditReader?.libraryMetadata<Array<Parameters<typeof toVersion>[0]> | null>({
      kind: "versions", itemId,
    });
    if (rows === undefined && this.db.coreIdentity) throw new Error("Core 未确认版本列表");
    if (rows === null || (rows === undefined && !this.getItem(itemId))) throw new Error("笔记已不可用");
    return rows?.map(toVersion) ?? this.listVersions(itemId);
  }

  readVersion(itemId: string, version: number): string {
    if (!this.repo.getItem(itemId)) throw new Error("笔记不存在或已移入回收站");
    const bytes = this.versionBytes(itemId, version, LIBRARY_INLINE_FILE_MAX_BYTES);
    if (!bytes) throw new Error("此旧版本只保留了记录，正文副本已不可用");
    return bytes.toString("utf8");
  }

  async readVersionBody(itemId: string, version: number): Promise<string> {
    const result = Number.isSafeInteger(version) ? await this.db.runtimeAuditReader?.libraryMetadata<
      { status: "ok"; content: string } | { status: "missingItem" | "missingVersion" | "unavailable" | "needsHost" }
    >({ kind: "versionBody", itemId, version }) : undefined;
    switch (result?.status) {
      case "ok": return result.content;
      case "missingItem": throw new Error("笔记不存在或已移入回收站");
      case "missingVersion": throw new Error("此版本不存在");
      case "unavailable": throw new Error("此旧版本只保留了记录，正文副本已不可用");
      case "needsHost": {
        if (!this.db.coreIdentity) return this.readVersion(itemId, version);
        const entry = (await this.readVersions(itemId)).find(row => row.version === version);
        if (!entry || !this.isManagedFileSafe(entry.path) || !existsSync(entry.path)) throw new Error("此旧版本的正文副本已不可用");
        if (statSync(entry.path).size > LIBRARY_INLINE_FILE_MAX_BYTES) throw new Error("此历史版本过大，无法内联打开");
        const bytes = await readFile(entry.path);
        if (createHash("sha256").update(bytes).digest("hex") !== entry.contentHash) throw new Error("此旧版本的正文副本已不可用");
        return bytes.toString("utf8");
      }
      default:
        if (this.db.coreIdentity) throw new Error("Core 未确认历史版本正文");
        return this.readVersion(itemId, version);
    }
  }

  private versionBytes(itemId: string, version: number, maxFileBytes?: number): Buffer | null {
    const entry = this.repo.versionContent(itemId, version);
    if (!entry) throw new Error("此版本不存在");
    let bytes: Buffer | null = entry.snapshot;
    if (!bytes && this.isManagedFileSafe(entry.path) && existsSync(entry.path)) {
      if (maxFileBytes !== undefined && statSync(entry.path).size > maxFileBytes) throw new Error("此历史版本过大，无法内联打开");
      bytes = readFileSync(entry.path);
    }
    return bytes && createHash("sha256").update(bytes).digest("hex") === entry.content_hash ? bytes : null;
  }

  createNoteBackup(owner: LibraryOwnerScope): LibraryNotesBackup {
    const { spaceIds } = ownedLibraryQueryScope(this.db, this.repo, owner);
    const folders = [...spaceIds].flatMap((id) => this.repo.listCollections(id));
    const items = [...spaceIds].flatMap((id) => this.repo.listItems(id, undefined, true)).map((item) => {
      const path = this.absolutePath(item);
      if (path) this.assertManagedFile(path);
      return { item, body: path ? readFileSync(path).toString("base64") : null,
        history: this.repo.listVersions(item.id).map((version) => ({
          id: version.id, version: version.version, contentHash: version.contentHash, createdBy: version.createdBy,
          createdAt: version.createdAt, body: this.versionBytes(item.id, version.version)?.toString("base64") ?? null,
        })) };
    });
    return { format: "mybuddy-notes", version: 1, folders, items };
  }

  async exportNoteBackup(owner: LibraryOwnerScope, destination: string): Promise<void> {
    await this.flushPendingTextWrites();
    await this.flushPendingFileMutations();
    const target = resolve(destination);
    const temporary = await mkdtemp(join(dirname(target), ".mybuddy-notes-"));
    const staging = join(temporary, "backup.mynotes");
    try {
      const reader = this.db.runtimeAuditReader;
      const status = reader && !this.db.inTransaction
        ? await reader.exportLibraryBackup(this.textSaves.root, owner, staging)
        : "needsHost";
      if (status === "needsHost") {
        if (this.requiresRustWrites) throw new Error("受监督模式下资料备份必须通过 Rust 核心完成");
        const archive = JSON.stringify(libraryNotesBackup.parse(this.createNoteBackup(owner)));
        if (Buffer.byteLength(archive) > LIBRARY_NOTES_BACKUP_LIMIT) throw new Error("资料超过单份本地备份的大小上限");
        await writeFile(staging, await promisify(gzip)(archive), { flag: "wx" });
      } else if (status === "tooLarge") {
        throw new Error("资料超过单份本地备份的大小上限");
      } else if (status === "sourceUnavailable") {
        throw new Error("受管资料无法读取或在备份期间已修改，请检查后重试");
      } else if (status === "invalidMetadata") {
        throw new Error("资料文件名或类型不符合备份格式，请检查后重试");
      } else if (status !== "saved") {
        throw new Error("笔记备份失败，请重试");
      }
      await rename(staging, target);
    } finally {
      try {
        await rm(staging, { force: true });
        await rmdir(temporary);
      } catch (error) {
        console.warn("[Library] 笔记备份临时文件清理失败", error);
      }
    }
  }

  async importNoteBackup(owner: LibraryOwnerScope, source: string): Promise<{ restored: number; skipped: number }> {
    await this.flushPendingTextWrites();
    await this.flushPendingFileMutations();
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction) {
      if (this.requiresRustWrites) throw new Error("受监督模式下资料恢复必须通过 Rust 核心完成");
      return this.importNoteBackupOnHost(owner, source);
    }
    const operationId = randomUUID();
    const root = this.textSaves.root;
    return this.trackFileMutation(reader.restoreLibraryBackup({
      source: resolve(source), root, owner, operationId, ...LIBRARY_CHUNK_DEFAULTS,
    }, () => this.db.coreIdentity ? "" : this.ensureOwnedSpace(owner).id).catch(missingOperationReply).then(async (result) => {
      if (result?.status === "needsHost") {
        if (this.requiresRustWrites) throw new Error("受监督模式下资料恢复无法回退到宿主 SQLite");
        return this.importNoteBackupOnHost(owner, source);
      }
      if (result?.status === "rejected") throw new Error(result.message);
      let receipt = result?.receipt;
      if (!receipt) {
        receipt = await reader.libraryMetadata<RuntimeLibraryRestoreReceipt>({ kind: "restoreReceipt", root, operationId });
        await this.recoverLibraryRestores();
        if (!receipt) throw new Error("备份恢复中断，请重试");
      }
      if (receipt.indexedText) this.indexMaintenance.scheduleSemanticIndex();
      if (receipt.pendingExtraction) {
        void this.indexMaintenance.recoverPendingExtractions().catch(error => console.warn("[Library] 备份恢复后的附件索引失败", error));
      }
      return { restored: receipt.restored, skipped: receipt.skipped };
    }));
  }

  private async importNoteBackupOnHost(owner: LibraryOwnerScope, source: string): Promise<{ restored: number; skipped: number }> {
    if ((await stat(source)).size > LIBRARY_NOTES_BACKUP_LIMIT) throw new Error("备份文件过大");
    const json = await promisify(gunzip)(await readFile(source), { maxOutputLength: LIBRARY_NOTES_BACKUP_LIMIT });
    const parsed = libraryNotesBackup.safeParse(JSON.parse(json.toString("utf8")));
    if (!parsed.success) throw new Error("这不是有效的 MyBuddy 笔记备份");
    return this.restoreNoteBackup(owner, parsed.data);
  }

  restoreNoteBackup(owner: LibraryOwnerScope, backup: LibraryNotesBackup): { restored: number; skipped: number } {
    const defaultSpace = this.ensureOwnedSpace(owner).id;
    const spaceIds = ownedLibraryQueryScope(this.db, this.repo, owner).spaceIds;
    const written: LibraryItemDto[] = [];
    let restored = 0, skipped = 0;
    try {
      const runRestore = () => {
        const targetSpace = (id: string) => spaceIds.has(id) ? id : defaultSpace;
        const pending = new Map(backup.folders.map((folder) => [folder.id, folder]));
        if (pending.size !== backup.folders.length || new Set(backup.items.map((entry) => entry.item.id)).size !== backup.items.length) {
          throw new Error("备份中存在重复的资料 ID");
        }
        while (pending.size) {
          let progressed = false;
          for (const folder of pending.values()) {
            if (folder.parentId && pending.has(folder.parentId)) continue;
            const spaceId = targetSpace(folder.spaceId);
            this.requireOwnedNoteDestination(owner, spaceId, folder.parentId);
            const existing = this.repo.getCollection(folder.id);
            if (existing && existing.spaceId !== spaceId) throw new Error("备份文件夹 ID 与其他范围的资料冲突");
            if (!existing) this.repo.insertCollection({ ...folder, spaceId });
            pending.delete(folder.id); progressed = true;
          }
          if (!progressed) throw new Error("备份中的文件夹层级无效");
        }
        for (const { item, body, history } of backup.items) {
          const existing = this.repo.getItem(item.id, true);
          if (existing) {
            if (!spaceIds.has(existing.spaceId)) throw new Error("备份笔记 ID 与其他范围的资料冲突");
            skipped++; continue;
          }
          const spaceId = targetSpace(item.spaceId);
          this.requireOwnedNoteDestination(owner, spaceId, item.collectionId);
          const bytes = body === null ? null : Buffer.from(body, "base64");
          if (item.kind === "url" ? bytes !== null || !item.url : bytes === null) throw new Error("备份缺少资料内容");
          const next: LibraryItemDto = { ...item, spaceId, sizeBytes: bytes?.length ?? 0,
            contentHash: bytes ? createHash("sha256").update(bytes).digest("hex") : undefined };
          if (bytes) {
            if (existsSync(this.absolutePath(next))) throw new Error("本地存在同名受管文件，无法安全恢复");
            this.writeManagedFile(next, bytes);
            written.push(next);
          }
          this.repo.insertItem(next);
          for (const { body, ...version } of history) {
            const snapshot = body === null ? undefined : Buffer.from(body, "base64");
            if (snapshot && createHash("sha256").update(snapshot).digest("hex") !== version.contentHash) throw new Error("备份版本校验失败");
            this.repo.insertVersion({ ...version, itemId: item.id, path: this.absolutePath(next) }, snapshot);
          }
          if (!next.trashedAt) this.refreshFts(next);
          restored++;
        }
      };
      if (this.requiresRustWrites) runRestore();
      else this.db.connection.transaction(runRestore).immediate();
      return { restored, skipped };
    } catch (error) {
      for (const item of written) this.removeFileAfterDurableDelete(item);
      throw error;
    }
  }

  listTrashedNotes(owner: LibraryOwnerScope): LibraryItemDto[] {
    const { spaceIds } = ownedLibraryQueryScope(this.db, this.repo, owner);
    return [...spaceIds].flatMap((spaceId) => this.repo.listItems(spaceId, undefined, true).filter((item) => item.trashedAt));
  }

  async readTrashedNotes(owner: LibraryOwnerScope): Promise<LibraryItemDto[]> {
    const reader = this.db.runtimeAuditReader;
    if (!reader) return this.listTrashedNotes(owner);
    const rows = await reader.libraryMetadata<LibraryCatalogRows["items"]>({ kind: "trash", owner });
    if (rows) return rows.map(toItem);
    if (this.db.coreIdentity) throw new Error("Core 未确认回收区资料");
    return this.listTrashedNotes(owner);
  }

  async readOwnedNoteItems(owner: LibraryOwnerScope, ids: string[], includeTrash = false): Promise<LibraryItemDto[]> {
    if (!this.db.coreIdentity) return this.requireOwnedNoteItems(owner, ids, includeTrash);
    const unique = [...new Set(ids)];
    const rows = await this.db.runtimeAuditReader?.libraryMetadata<LibraryCatalogRows["items"]>({
      kind:"ownedItems", owner, ids:unique, includeTrash,
    });
    if (!rows) throw new Error("Core 未确认资料归属");
    const items = new Map(rows.map(row => [row.id,toItem(row)]));
    return unique.map(id => {
      const item = items.get(id);
      if (!item) throw new Error("资料已不属于当前查看范围");
      return item;
    });
  }

  requireOwnedNoteItems(owner: LibraryOwnerScope, ids: string[], includeTrash = false): LibraryItemDto[] {
    const scope = ownedLibraryQueryScope(this.db, this.repo, owner);
    return [...new Set(ids)].map((id) => {
      const item = this.repo.getItem(id, includeTrash);
      if (!item || !scope.spaceIds.has(item.spaceId)) throw new Error("资料已不属于当前查看范围");
      this.requireWritableSpace(item.spaceId);
      return item;
    });
  }

  async checkFolderImportDestination(owner: LibraryOwnerScope, spaceId: string, collectionId: string | null): Promise<void> {
    if (!this.db.coreIdentity) return this.requireOwnedNoteDestination(owner, spaceId, collectionId);
    const snapshot = await this.readSnapshot({owner, spaceId});
    if (!snapshot.spaces.some(space => space.id === spaceId)
      || (collectionId && !snapshot.collections.some(folder => folder.id === collectionId && folder.spaceId === spaceId))) {
      throw new Error("目标不属于当前查看范围");
    }
  }

  requireOwnedNoteDestination(owner: LibraryOwnerScope, spaceId: string, collectionId: string | null): void {
    if (!ownedLibraryQueryScope(this.db, this.repo, owner).spaceIds.has(spaceId)) throw new Error("目标不属于当前查看范围");
    this.requireWritableSpace(spaceId);
    if (collectionId) this.requireCollectionInSpace(spaceId, collectionId);
  }

  resolveOfficeItem(id: string, owner: LibraryOwnerScope, reference?: LibraryOwnerReference, write = false): LibraryItemDto {
    const item = this.repo.getItem(id);
    if (!item || item.kind !== "office" ||
      !this.itemInQueryScope(item, ownedLibraryQueryScope(this.db, this.repo, owner, reference))) {
      throw new Error("办公文档已不属于当前资料范围");
    }
    if (write) {
      if (reference) throw new Error("引用资料只可读取");
      this.requireOwnedNoteDestination(owner, item.spaceId, item.collectionId);
    }
    this.assertManagedFile(this.absolutePath(item));
    return item;
  }

  async noteImageUrlAsync(itemId: string, href: string, version?: number): Promise<string> {
    if (!this.db.coreIdentity) return this.noteImageUrl(itemId, href, version);
    const source = await this.readContentAsync(itemId);
    const body = version === undefined ? source.content : await this.readVersionBody(itemId, version);
    if (!href || !body.includes(href)) throw new Error("图片未关联到此笔记");
    const match = /^mybuddy-library:\/\/local\/([A-Za-z0-9_-]+)\/?$/.exec(href);
    const name = match ? "" : decodeURIComponent(href);
    const target = match ? await this.readItemAsync(match[1]) :
      name && !/[\\/:?#]/.test(name) ? (await this.readSnapshot({spaceId:source.item.spaceId})).items.find(
        candidate => candidate.filename.toLowerCase() === name.toLowerCase()) : undefined;
    if (!target || target.kind !== "image" || target.spaceId !== source.item.spaceId) throw new Error("图片不在当前笔记的资料位置");
    return this.previewUrl(target.id);
  }

  noteImageUrl(itemId: string, href: string, version?: number): string {
    const source = this.readContent(itemId);
    const body = version === undefined ? source.content : this.readVersion(itemId, version);
    if (!body.includes(href)) throw new Error("图片未关联到此笔记");
    const match = /^mybuddy-library:\/\/local\/([A-Za-z0-9_-]+)\/?$/.exec(href);
    const filename = match ? undefined : decodeURIComponent(href);
    const target = match ? this.repo.getItem(match[1]) : filename && !/[\\/:?#]/.test(filename)
      ? this.repo.findByFilename(source.item.spaceId, filename) : null;
    if (!target || target.spaceId !== source.item.spaceId || target.kind !== "image") throw new Error("图片不在当前笔记的资料位置");
    return this.previewUrl(target.id);
  }

  private setNoteMetadata(owner: LibraryOwnerScope, id: string, patch: { tags?: string[]; pinned?: boolean }): LibraryItemDto {
    const [item] = this.requireOwnedNoteItems(owner, [id]);
    const tags = this.normalizeNoteTags(patch.tags) ?? item.tags;
    const next = { ...item, tags, pinned: patch.pinned ?? item.pinned, updatedAt: Date.now() };
    this.repo.updateItem(next, item);
    return next;
  }

  async writeNoteMetadata(owner: LibraryOwnerScope, id: string, patch: { tags?: string[]; pinned?: boolean }): Promise<LibraryItemDto> {
    const [item] = await this.readOwnedNoteItems(owner, [id]);
    const tags = this.normalizeNoteTags(patch.tags);
    if (tags?.some(tag => /[\uD800-\uDFFF]/u.test(tag))) throw new Error("标签包含无效的 Unicode 字符");
    const result = await this.writeNativeNote({ kind: "metadata", owner, item: { id, spaceId: item.spaceId }, tags, pinned: patch.pinned });
    if (result?.item) return toItem(result.item);
    if (this.requiresRustWrites || result) throw new Error("Core 未确认笔记属性保存");
    return this.setNoteMetadata(owner, id, patch);
  }

  private normalizeNoteTags(tags?: string[]): string[] | undefined {
    if (tags === undefined) return undefined;
    const normalized = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
    if (normalized.length > 100 || normalized.some(tag => tag.length > 80)) throw new Error("每篇笔记最多 100 个标签，每个标签最多 80 字");
    return normalized;
  }

  private async writeNativeNote(change: RuntimeLibraryNoteChange) {
    const result = await this.db.runtimeAuditReader?.writeLibraryNote<Parameters<typeof toItem>[0]>(change);
    if (result?.status === "scopeChanged") throw new Error("资料位置或归档状态已变化，请刷新后重试");
    if (result?.status === "folderChanged") throw new Error("只能移动到同一资料位置的文件夹");
    if (result?.status === "sourceUnavailable") throw new Error("资料正文文件不可读取，请检查文件后重新恢复");
    return result?.status === "updated" ? result : undefined;
  }

  private setNoteTrashedOnHost(owner: LibraryOwnerScope, ids: string[], trash: boolean): void {
    const items = this.requireOwnedNoteItems(owner, ids, true);
    this.db.connection.transaction(() => {
      for (const item of items) {
        if (Boolean(item.trashedAt) === trash) continue;
        const next = { ...item, trashedAt: trash ? Date.now() : undefined, updatedAt: Date.now() };
        this.repo.updateItem(next, item);
        if (!trash && this.repo.isTextSearchable(item.kind)) this.refreshFts(next);
      }
    })();
  }

  async trashNotes(owner: LibraryOwnerScope, ids: string[]): Promise<void> {
    const items = (await this.readOwnedNoteItems(owner, ids, true)).map(({ id, spaceId }) => ({ id, spaceId }));
    if (items.length && !await this.writeNativeNote({ kind: "trash", owner, items })) {
      if (this.requiresRustWrites) throw new Error("笔记移入回收站未收到 Rust 核心确认");
      this.setNoteTrashedOnHost(owner, ids, true);
    }
  }

  async restoreNotes(owner: LibraryOwnerScope, ids: string[]): Promise<void> {
    const items = (await this.readOwnedNoteItems(owner, ids, true)).map(({ id, spaceId }) => ({ id, spaceId }));
    if (!items.length) return;
    const result = await this.writeNativeNote({
      kind: "restore", owner, items, root: this.textSaves.root, ...LIBRARY_CHUNK_DEFAULTS,
    });
    if (!result) {
      if (this.requiresRustWrites) throw new Error("笔记恢复未收到 Rust 核心确认");
      this.setNoteTrashedOnHost(owner, ids, false);
      return;
    }
    for (const id of result.indexed ?? []) this.indexMaintenance.noteTextIndexed(id);
  }

  async moveNotes(owner: LibraryOwnerScope, ids: string[], collectionId: string | null): Promise<void> {
    const checked = await this.readOwnedNoteItems(owner, ids);
    if (!checked.length || await this.writeNativeNote({
      kind: "move", owner, items: checked.map(({ id, spaceId }) => ({ id, spaceId })), collectionId,
    })) return;
    if (this.requiresRustWrites) throw new Error("笔记移动未收到 Rust 核心确认");
    const items = this.requireNoteMove(owner, ids, collectionId);
    this.db.connection.transaction(() => {
      for (const item of items) this.repo.updateItem({ ...item, collectionId, updatedAt: Date.now() }, item);
    })();
  }

  private requireNoteMove(owner: LibraryOwnerScope, ids: string[], collectionId: string | null): LibraryItemDto[] {
    const items = this.requireOwnedNoteItems(owner, ids);
    const folder = collectionId ? this.repo.getCollection(collectionId) : null;
    if (collectionId && (!folder || items.some((item) => item.spaceId !== folder.spaceId))) throw new Error("只能移动到同一资料位置的文件夹");
    return items;
  }

  async mergeNotesAsync(owner: LibraryOwnerScope, ids: string[]): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.mergeNotes(owner, ids);
    const items = await this.readOwnedNoteItems(owner, ids);
    const [first] = items;
    if (items.length < 2 || items.some(item => item.spaceId !== first.spaceId || item.kind !== "markdown")) {
      throw new Error("请选择同一资料位置的至少两篇 Markdown 笔记");
    }
    const bodies: string[] = [];
    const sources: Array<{id:string; updatedAt:number; bodyHash:string}> = [];
    for (const item of items) {
      const reply = await this.db.runtimeAuditReader?.libraryMetadata<{status: string; content?: string}>({
        kind: "textBody", itemId: item.id, root: this.root,
      });
      if (reply?.status !== "ok" || typeof reply.content !== "string") throw new Error("资料过大、已变化或无法读取，请重新检查");
      bodies.push(reply.content);
      sources.push({ id: item.id, updatedAt: item.updatedAt, bodyHash: sha256(reply.content) });
    }
    const tags = [...new Set(items.flatMap(item => item.tags ?? []))];
    return this.createItemAsync({ spaceId:first.spaceId, collectionId:first.collectionId, kind:"markdown",
      title:`${first.title.slice(0, LIBRARY_TITLE_MAX_CHARS - 7)}（合并）`, content:bodies.join("\n\n---\n\n") },
      { owner, merge: {sources}, tags });
  }

  mergeNotes(owner: LibraryOwnerScope, ids: string[]): LibraryItemDto {
    const items = this.requireOwnedNoteItems(owner, ids);
    if (items.length < 2 || items.some((item) => item.kind !== "markdown" || item.spaceId !== items[0].spaceId)) {
      throw new Error("请选择同一资料位置的至少两篇 Markdown 笔记");
    }
    const [first] = items;
    const content = items.map((item) => {
      const body = this.readContent(item.id);
      if (body.contentTooLarge) throw new Error("大型资料请通过「打开位置」在外部编辑器中合并");
      return body.content;
    }).join("\n\n---\n\n");
    return this.createItem({ spaceId: first.spaceId, collectionId: first.collectionId, kind: "markdown",
      title: `${first.title.slice(0, LIBRARY_TITLE_MAX_CHARS - 7)}（合并）`, content }, undefined,
      [...new Set(items.flatMap((item) => item.tags ?? []))]);
  }

  async addNoteImageAsync(owner: LibraryOwnerScope, spaceId: string, collectionId: string | null, name: string,
    mime: string, bytes: Uint8Array, sourceNoteId?: string): Promise<LibraryItemDto> {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024)
      throw new Error("图片为空或超过 20 MiB");
    const content = Buffer.from(bytes);
    if (!matchesImageMime(content, mime)) throw new Error("图片内容与文件格式不符");
    if (!this.db.coreIdentity) return this.addNoteImage(owner, spaceId, collectionId, name, mime, bytes);
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error("插入图片需要 Rust 核心");
    const title = safeName(basename(name, extname(name))).slice(0, 125) || "图片";
    const extension = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
    const id = randomUUID(), operationId = randomUUID();
    const stage = join(tmpdir(), "mybuddy-import-" + operationId);
    return this.trackFileMutation((async () => {
      mkdirSync(stage, {mode:0o700});
      try {
        await writeFile(join(stage,id), content, {mode:0o600,flag:"wx"});
        const batch: RuntimeLibraryImportBatch = {owner, spaceId, sourceNoteId, operationId, root:this.root,
          files:[{id, collectionId, filename:title+"."+extension, title, kind:"image", mimeType:mime,
            contentHash:createHash("sha256").update(content).digest("hex")}], ...LIBRARY_CHUNK_DEFAULTS};
        const reply = await reader.writeLibraryNote<LibraryCatalogRows["items"][number]>({kind:"import",batch}).catch(missingOperationReply);
        const item = reply?.status === "updated" && reply.item ? toItem(reply.item)
          : !reply ? (await this.readSnapshot({owner,itemId:id})).items[0] : undefined;
        if (!item) throw new Error("Core 未确认笔记图片保存");
        return item;
      } finally { await rm(stage,{recursive:true,force:true}); }
    })());
  }

  addNoteImage(owner: LibraryOwnerScope, spaceId: string, collectionId: string | null, name: string, mime: string, bytes: Uint8Array): LibraryItemDto {
    this.requireOwnedNoteDestination(owner, spaceId, collectionId);
    const extension = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"],
      ["image/gif", ".gif"], ["image/avif", ".avif"], ["image/bmp", ".bmp"]]).get(mime);
    if (!extension || !(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("无法保存此图片，请使用 20 MiB 以内的 PNG、JPEG、GIF、WebP、AVIF 或 BMP");
    }
    const imageName = safeName(basename(name, extname(name))).slice(0, 125) || "图片";
    const now = Date.now();
    const item: LibraryItemDto = { id: randomUUID(), spaceId, collectionId, kind: "image", title: imageName,
      filename: imageName + extension, mimeType: mime, sizeBytes: bytes.byteLength, owner: this.ownerName(),
      favorite: false, sourceType: "uploaded", createdAt: now, updatedAt: now, lastVisitedAt: null,
      contentHash: createHash("sha256").update(bytes).digest("hex") };
    return this.commitNewManagedItem(item, () => this.writeManagedFile(item, Buffer.from(bytes)));
  }

  deleteItem(id: string): void {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    this.indexMaintenance.forgetItem(id);
    // Durable metadata is the commit point. Never delete the managed file first: a DB failure
    // must not leave a live Library row pointing at a missing file.
    if (this.requiresRustWrites) {
      this.repo.deleteItem(item.id);
    } else {
      this.db.connection.transaction(() => {
        try { (this.db as any).deleteChunkEmbeddings?.(item.id); } catch {}
        try { this.db.connection.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?)`).run(item.id); } catch {}
        this.repo.deleteItem(item.id); // repository also removes FTS/chunks before deleting the row
      })();
    }
    try { this.removeFile(item); }
    catch (error) {
      // DB row is already gone; an orphan file is safer than a dangling durable row and can be reconciled later.
      console.warn(`[Library] 条目 ${item.id} 已删除，但受管文件清理失败（orphan）`, error);
    }
  }

  async deleteItemAsync(id: string): Promise<void> {
    if (!this.db.coreIdentity) {
      const item = this.repo.getItem(id);
      if (!item) throw new Error("条目不存在");
      this.requireWritableSpace(item.spaceId);
    }
    await this.textSaves.waitFor(id);
    await this.deleteNative({ kind: "item", id }, () => !this.repo.getItem(id, true), () => this.deleteItem(id));
  }

  private async deleteNative(target: RuntimeLibraryDeleteTarget, committed: () => boolean, fallback: () => void): Promise<void> {
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction) {
      if (this.requiresRustWrites) throw new Error("资料删除在只读/受监督模式下仅允许通过 Rust 核心完成");
      return fallback();
    }
    const job = (async () => {
      let result: RuntimeLibraryDeleteReply | undefined;
      try {
        result = await reader.deleteLibrary(this.textSaves.root, target);
      } catch (error) {
        const failed = () => Object.assign(new Error("资料删除失败，请刷新后重试", { cause: error }),
          { code: "RUNTIME_OPERATION_FAILED", operation: "deleteLibrary",
            requestId: error && typeof error === "object" && "requestId" in error ? error.requestId : undefined });
        if (error && typeof error === "object" && "code" in error && error.code === "RUNTIME_OPERATION_FAILED")
          throw failed();
        if (!error || typeof error !== "object" || !("code" in error)
            || error.code !== "RUNTIME_OPERATION_UNKNOWN" || !("requestId" in error)
            || typeof error.requestId !== "string") throw error;
        // A caller deadline does not prove a running deletion failed. Ask the durable
        // operation receipt first; never replay a destructive write on an unknown reply.
        const receipt = await reader.queryOperation(error.requestId).catch(() => undefined);
        const reply = receipt?.result;
        if (receipt?.state === "failed") throw failed();
        if (receipt?.state === "committed" && reply && typeof reply === "object" && "status" in reply
            && reply.status === "deleted" && "itemIds" in reply && Array.isArray(reply.itemIds)
            && reply.itemIds.every(id => typeof id === "string")) {
          result = { status: "deleted", itemIds: reply.itemIds };
        } else if (receipt?.state === "committed" && reply && typeof reply === "object" && "status" in reply
            && (reply.status === "scopeChanged" || reply.status === "needsHost")) {
          result = { status: reply.status };
        } else if (!this.db.coreIdentity && committed()) {
          if (target.kind === "item") this.indexMaintenance.forgetItem(target.id);
          await this.recoverFileDeletes();
          return;
        } else if (receipt?.state === "cancelled" || receipt?.state === "expired") {
          throw Object.assign(new Error("资料删除已取消或过期，未提交；请刷新后重试", { cause: error }),
            { code: "RUNTIME_OPERATION_CANCELLED", requestId: error.requestId, operation: "deleteLibrary" });
        } else {
          throw Object.assign(new Error(`资料删除结果尚未确认（操作 ${error.requestId}）。后台可能仍在处理，请刷新确认后再操作。`, { cause: error }),
            { code: "RUNTIME_OPERATION_UNKNOWN", requestId: error.requestId, operation: "deleteLibrary" });
        }
      }
      if (result?.status === "needsHost") {
        if (this.requiresRustWrites) throw new Error("资料删除无法回退到宿主 SQLite");
        return fallback();
      }
      if (result?.status === "scopeChanged") throw new Error("资料位置或归档状态已变化，请刷新后重试");
      if (result?.status === "deleted") {
        for (const id of result.itemIds) this.indexMaintenance.forgetItem(id);
      } else if (!this.db.coreIdentity && committed()) {
        if (target.kind === "item") this.indexMaintenance.forgetItem(target.id);
        await this.recoverFileDeletes();
      } else {
        throw new Error("资料删除失败，请刷新后重试");
      }
    })();
    await this.trackFileMutation(job);
  }

  private async trackFileMutation<T>(job: Promise<T>): Promise<T> {
    this.pendingFileMutations.add(job);
    try { return await job; }
    finally { this.pendingFileMutations.delete(job); }
  }

  async recoverFileDeletes(): Promise<void> {
    const reader = this.db.runtimeAuditReader;
    const root = this.textSaves.root;
    if (!reader || (!reader.supervised && !this.db.fixtureConnection
      ?.prepare("SELECT 1 FROM library_file_cleanup WHERE root=? LIMIT 1").get(root))) return;
    await this.trackFileMutation(reader.drainLibraryCleanup(root));
  }

  async recoverLibraryRestores(): Promise<void> {
    const root = this.textSaves.root;
    const reader = this.db.runtimeAuditReader;
    if (!reader) {
      if (this.requiresRustWrites) throw new Error("资料恢复需要 Rust 核心");
      return;
    }
    if (this.db.fixtureConnection && !this.db.fixtureConnection.prepare("SELECT 1 FROM library_restore_files WHERE root=? LIMIT 1").get(root)) return;
    const recovered = await this.trackFileMutation(reader.recoverLibraryRestores(root));
    if (recovered === undefined) throw new Error("Core 未确认资料恢复清理");
    if (recovered > 0) throw new Error(`仍有 ${recovered} 项资料恢复清理待重试`);
  }

  async flushPendingFileMutations(): Promise<void> {
    while (this.pendingFileMutations.size) await Promise.allSettled(this.pendingFileMutations);
  }

  /** 文本类正文；非文本返回受管路径 + requiresFileAccess，禁止 utf8 直读二进制 */
  readContent(id: string, maxChars?: number): LibraryContentDto {
    return this.contentFromItem(this.repo.getItem(id), maxChars);
  }

  private contentFromItem(item: LibraryItemDto | null, maxChars?: number): LibraryContentDto {
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
    if (!existsSync(abs)) throw new Error("资料正文文件已遗失");
    if (maxChars !== undefined) {
      return { item, ...readUtf8Prefix(abs, maxChars) };
    }
    if (statSync(abs).size > LIBRARY_INLINE_FILE_MAX_BYTES) {
      return { item, content: "", contentTooLarge: true, managedPath: abs, requiresFileAccess: true };
    }
    const content = readFileSync(abs, "utf8");
    return {
      item: item.contentHash ? item : { ...item, contentHash: sha256(content) },
      content,
      previewUrl: item.kind === "html" ? this.previewUrl(item.id) : undefined,
    };
  }

  /**
   * 写入正文（仅文本类）：版本快照（旧内容 hash）→ 原子写（temp+fsync+rename）→ DB 更新。
   * 崩溃顺序：任一步中断都不会静默不一致（文件为真相源，版本行只增不覆盖）。
   */
  writeContent(req: LibraryWriteContentRequest): LibraryItemDto {
    return this.updateTextContent(req);
  }

  async readContentAsync(id: string, maxChars?: number): Promise<LibraryContentDto> {
    let pending = this.textSaves.waitFor(id);
    while (pending) {
      await pending;
      pending = this.textSaves.waitFor(id);
    }
    if (maxChars === undefined || (Number.isSafeInteger(maxChars) && maxChars >= 0)) {
      const result = await this.db.runtimeAuditReader?.libraryMetadata<
        | { status: "ok"; item: Parameters<typeof toItem>[0]; content: string; contentTruncated?: boolean }
        | { status: "missingItem" | "needsHost" }
      >({ kind: "textBody", itemId: id, root: this.textSaves.root, maxChars });
      if (result?.status === "missingItem") throw new Error("条目不存在");
      if (result?.status === "ok") {
        const item = toItem(result.item);
        return maxChars === undefined
          ? { item, content: result.content, previewUrl: item.kind === "html" ? this.previewUrl(id) : undefined }
          : { item, content: result.content, contentTruncated: result.contentTruncated };
      }
    }
    return this.db.coreIdentity ? this.contentFromItem(await this.readItemAsync(id),maxChars) : this.readContent(id, maxChars);
  }

  async writeContentAsync(req: LibraryWriteContentRequest, expectedSpaceId?: string): Promise<LibraryItemDto> {
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction) {
      if (this.requiresRustWrites) throw new Error("受监督模式下保存笔记仅允许通过 Rust 核心完成");
      return this.updateTextContent(req);
    }
    return this.textSaves.enqueue(req.id, async () => {
      const snapshot = this.db.coreIdentity ? await this.readSnapshot({ itemId: req.id }) : undefined;
      const item = snapshot ? snapshot.items[0] : this.requireTextUpdate(req.id);
      if (!item) throw new Error("条目不存在");
      if (expectedSpaceId && item.spaceId !== expectedSpaceId) throw new Error("资料归属发生变化");
      if (!this.repo.isTextReadable(item.kind)) throw new Error("该类型不支持文本编辑");
      const content = req.content ?? "";
      const project = snapshot ? snapshot.spaces.find(space => space.id === item.spaceId)?.projectId : this.repo.getSpace(item.spaceId)?.projectId;
      if (!project && content.length > LIBRARY_CONTENT_MAX_CHARS) throw new Error(`正文不能超过 ${LIBRARY_CONTENT_MAX_CHARS} 字符`);
      const title = req.title === undefined ? undefined : project ? safeName(req.title) : limitText(safeName(req.title), LIBRARY_TITLE_MAX_CHARS, "标题");
      const nextFilename = title === undefined || title === item.title ? undefined : `${title}${extname(item.filename) || extForKind(item.kind)}`;
      const operationId = randomUUID();
      const path = resolve(this.absolutePath(item));
      this.assertManagedWritePath(path);
      const createdBy = snapshot?.ownerName ?? this.ownerName();
      if (Buffer.byteLength(content) > NATIVE_LIBRARY_SAVE_MAX_BYTES
        || [content, title, req.expectedTitle, createdBy].some(value => value && /[\uD800-\uDFFF]/u.test(value))
        || !existsSync(dirname(path))) {
        if (this.requiresRustWrites) throw new Error("笔记大小超过限制或包含不支持的字符，受监督模式下无法保存");
        return this.updateTextContentOnHost(req);
      }
      const status = await reader.saveLibraryText({
        id: item.id, spaceId: item.spaceId, filename: item.filename,
        path, root: this.textSaves.root, operationId, title, nextFilename,
        expectedTitle: req.expectedTitle, expectedContentHash: req.expectedContentHash,
        content, createdBy, updatedAt: Date.now(), ...LIBRARY_CHUNK_DEFAULTS,
      }).catch(missingOperationReply);
      if (status === "needsHost") {
        if (this.requiresRustWrites) throw new Error("保存笔记无法回退到宿主 SQLite");
        return this.updateTextContentOnHost(req);
      }
      if (status === "saved" || status === "unchanged" || (this.db.coreIdentity ? await reader.libraryMetadata<boolean>({kind: "textReceipt", id: item.id, operationId}) : this.textSaves.wasCommitted(item.id, operationId))) {
        if (status !== "unchanged") this.indexMaintenance.noteTextIndexed(item.id);
        const updated = this.db.coreIdentity ? (await this.readSnapshot({itemId: item.id})).items[0] : this.repo.getItem(item.id, true);
        if (updated) return updated;
        throw new Error("笔记保存后已被删除");
      }
      try {
        if (this.db.coreIdentity) await this.recoverLibraryRestores();
        else this.textSaves.recoverItem(item.id);
      }
      catch (error) {
        throw new LibraryUpdatePartialStateError(item.id, path, "笔记保存中断",
          error instanceof Error ? error.message : String(error));
      }
      if (status === "conflict") throw new Error("此笔记已在别处更新。草稿已保留，请核对最新正文后再保存。");
      throw new Error("笔记未能保存，草稿已保留，请重试");
    });
  }

  private requireTextUpdate(id: string): LibraryItemDto {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    this.requireWritableSpace(item.spaceId);
    if (!this.repo.isTextReadable(item.kind)) {
      throw new Error("该类型是受管文件（非文本），资料库内编辑会破坏文件；请用文件/预览工具处理");
    }
    return item;
  }

  /** Text update commit boundary: version + file + metadata + FTS either converge together or compensate. */
  updateTextContent(req: LibraryWriteContentRequest): LibraryItemDto {
    if (this.textSaves.waitFor(req.id)) throw new Error("此笔记正在保存，请稍后重试");
    return this.updateTextContentOnHost(req);
  }

  private updateTextContentOnHost(req: LibraryWriteContentRequest): LibraryItemDto {
    this.textSaves.recoverItem(req.id);
    const item = this.requireTextUpdate(req.id);
    const text = req.content ?? "";
    this.assertContentLength(item.spaceId, text);
    const title = req.title === undefined ? item.title : this.itemTitle(item.spaceId, req.title);
    const abs = this.absolutePath(item);
    let existing: string | null = null;
    if (existsSync(abs)) {
      this.assertManagedFile(abs);
      existing = readFileSync(abs, "utf8");
    }
    if ((req.expectedTitle !== undefined && req.expectedTitle !== item.title)
      || (req.expectedContentHash !== undefined && req.expectedContentHash !== sha256(existing ?? ""))) {
      throw new Error("此笔记已在别处更新。草稿已保留，请核对最新正文后再保存。");
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
        }, Buffer.from(existing, "utf8"));
      }
      if (contentChanged) {
        this.assertManagedWritePath(abs);
        atomicWriteFileSync(abs, text);
        fileChanged = true;
      }
      this.repo.updateItem(next, item);
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
        try { this.repo.updateItem(item, next); }
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

  private assertContentLength(spaceId: string, text: string): void {
    if (!this.repo.getSpace(spaceId)?.projectId && text.length > LIBRARY_CONTENT_MAX_CHARS) {
      throw new Error(`正文不能超过 ${LIBRARY_CONTENT_MAX_CHARS} 字符`);
    }
  }

  async importFolder(req: LibraryFolderImportTarget & { sourcePath: string }): Promise<LibraryFolderImportResult> {
    if (!req.spaceId && req.collectionId) throw new Error("请选择有效的资料位置");
    if (req.spaceId && !this.db.coreIdentity) this.requireOwnedNoteDestination(req.owner, req.spaceId, req.collectionId);
    const plan = await scanLibraryImportFolder(req.sourcePath, this.root);
    const operationId = randomUUID();
    const spaceId = req.spaceId ?? (this.db.coreIdentity ? operationId : this.ensureOwnedSpace(req.owner).id);
    const files = plan.files.map((file) => ({
      ...file, item: this.describeImportedFile(file.path, file.size, { spaceId, collectionId: null }, this.db.coreIdentity ? "" : undefined),
    }));
    const urls = new Map(files.map(({ path, item }) => [resolvedPathKey(path), this.previewUrl(item.id)]));
    const staging = this.db.coreIdentity ? join(tmpdir(), "mybuddy-import-" + operationId) : await mkdtemp(join(this.root, ".folder-import-"));
    if (this.db.coreIdentity) mkdirSync(staging,{mode:0o700});
    const published: LibraryItemDto[] = [];
    try {
      for (const { path, item } of files) {
        if (!(await lstat(plan.root)).isDirectory()) throw new Error("所选文件夹在导入期间已变化");
        assertManagedPathSafe(plan.root, path);
        const staged = join(staging, item.id);
        if (item.kind === "markdown") {
          if (rewriteImportedFolderLinks(path, staged, urls)) item.contentHash = sha256File(staged);
        } else {
          await copyFile(path, staged);
        }
        const { size } = await stat(staged);
        item.sizeBytes = size;
      }

      if (this.db.coreIdentity) {
        const reader = this.db.runtimeAuditReader;
        if (!reader) throw new Error("文件夹导入需要 Core");
        const ids = new Map(plan.folders.map(f => [f.path,randomUUID()]));
        const batch: RuntimeLibraryImportBatch = {root:this.root, spaceId, operationId, owner:req.owner, defaultSpace:!req.spaceId,
          folders:plan.folders.map(f => ({id:ids.get(f.path)!, parentId:f.parent ? ids.get(f.parent)! : req.collectionId,
            name:limitText(safeName(basename(f.path)),LIBRARY_NAME_MAX_CHARS,"集合名称")})),
          files:files.map(({item,folder,path})=>({id:item.id,kind:item.kind,title:item.title,filename:item.filename,mimeType:item.mimeType,
            originalPath:path,collectionId:ids.get(folder)!,contentHash:sha256File(join(staging,item.id))})), ...LIBRARY_CHUNK_DEFAULTS};
        const receipt = await this.trackFileMutation(reader.writeLibraryNote({kind:"import",batch})).catch(missingOperationReply);
        if (receipt && receipt.status !== "updated") throw new Error("文件夹导入未提交");
        const snapshot = await this.readSnapshot({owner:req.owner});
        const folder = snapshot.collections.find(f=>f.id===ids.get(plan.root));
        if (!folder) throw new Error("Core 未确认资料文件夹导入，请刷新后重试");
        for (const {item} of files) {
          if (this.repo.isTextSearchable(item.kind)) this.indexMaintenance.noteTextIndexed(item.id);
          else await this.indexMaintenance.indexExtractedText(item.id);
        }
        return {folder, fileCount:files.length, skippedEntries:plan.skippedEntries};
      }

      const commitFolder = () => {
        this.requireOwnedNoteDestination(req.owner, spaceId, req.collectionId);
        const collections = new Map<string, LibraryCollectionDto>();
        for (const folder of plan.folders) {
          const parentId = folder.parent ? collections.get(folder.parent)!.id : req.collectionId;
          collections.set(folder.path, this.createCollection({ spaceId, parentId, name: basename(folder.path) }));
        }
        for (const { item, folder } of files) {
          item.collectionId = collections.get(folder)!.id;
          const target = this.absolutePath(item);
          this.assertManagedWritePath(target);
          mkdirSync(dirname(target), { recursive: true });
          renameSync(join(staging, item.id), target);
          published.push(item);
          this.repo.insertItem(item);
          this.refreshFts(item);
        }
        return { folder: collections.get(plan.root)!, fileCount: files.length, skippedEntries: plan.skippedEntries };
      };
      return this.requiresRustWrites ? commitFolder() : this.db.connection.transaction(commitFolder)();
    } catch (error) {
      for (const item of published) this.removeFileAfterDurableDelete(item);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn("[Library] 无法清理文件夹导入临时目录", error);
      });
    }
  }

  importFile(req: LibraryImportFileRequest): LibraryItemDto {
    return this.importPreparedFile(req, this.prepareImportedFile(req));
  }

  get importsThroughCore(): boolean { return !!this.db.coreIdentity; }

  async importProjectDocument(projectId: string, sourcePath: string) {
    const spaceId = "project-" + createHash("sha256").update(projectId).digest("hex");
    return this.trackFileMutation(this.importThroughCore({spaceId,sourcePath}, projectId));
  }

  private async importThroughCore(req: LibraryImportFileRequest, projectId?: string) {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error("资料导入需要 Rust 核心");
    const operationId = randomUUID();
    const staging = join(tmpdir(), "mybuddy-import-" + operationId);
    mkdirSync(staging, {mode:0o700});
    try {
      const batch: RuntimeLibraryImportBatch = { operationId, spaceId:req.spaceId, root:this.root, files:[], ...LIBRARY_CHUNK_DEFAULTS };
      const assets = new Map<string,string>();
      const stage = (source: string, main: boolean): string => {
        const id = randomUUID();
        const filename = basename(source), kind = kindFromFilename(filename);
        const mimeType = preciseMimeFromFilename(filename) || mimeForKind(kind);
        const staged = join(staging,id);
        const file = {id, filename, kind, mimeType, title:filename.replace(/\.[^.]+$/, "") || filename,
          collectionId:req.collectionId, originalPath:source, contentHash:""};
        batch.files.push(file);
        if (main && kind === "markdown") {
          copyWithRewrittenNoteLinks(source, staged, href => {
            const path = this.importedAssetPath(source,href);
            if (!path) return;
            let asset = assets.get(path);
            if (!asset) {asset = stage(path,false); assets.set(path,asset);}
            return this.previewUrl(asset);
          });
        } else copyFileSync(source,staged);
        file.contentHash = sha256File(staged);
        return id;
      };
      const source = resolve(req.sourcePath.trim());
      const before = statSync(source);
      if (!before.isFile()) throw new Error("只能导入文件");
      const originalHash = projectId ? sha256File(source) : undefined;
      const main = stage(source,true);
      if (projectId && originalHash) {
        const file = batch.files[0];
        const extracted = this.repo.isTextReadable(file.kind as LibraryItemKind)
          ? readUtf8Prefix(join(staging,main),4000)
          : undefined;
        const document = extracted ? undefined : await new ContentExtractorRegistry().extract(file.kind as LibraryItemKind,file.mimeType,join(staging,main));
        const text = extracted?.content ?? document?.text;
        batch.project = { id:projectId, eventId:"pevt_" + randomUUID(), reference:originalHash, body:text?.slice(0,4000),
          extractStatus:extracted ? "extracted" : document!.status, truncated:!!(extracted?.contentTruncated || document?.truncated || (text && text.length > 4000)), originalSize:before.size };
      }
      const after = statSync(source);
      if (after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev ||
          after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) throw new Error("文件在导入期间已变化，请重试");
      const reply = await reader.writeLibraryNote<LibraryCatalogRows["items"][number]>({kind:"import",batch}).catch(missingOperationReply);
      if (reply && reply.status !== "updated") throw new Error("资料导入未提交");
      const item = reply?.item ? toItem(reply.item) : reply ? null : (await this.readSnapshot({itemId:main})).items[0];
      if (!item && !(reply?.eventId && reply.reused)) throw new Error("Core 未确认资料导入，请刷新后重试");
      if (item && !reply?.reused) {
        for (const f of batch.files) {
          if (this.repo.isTextSearchable(f.kind as LibraryItemKind)) this.indexMaintenance.noteTextIndexed(f.id);
          else await this.indexMaintenance.indexExtractedText(f.id);
        }
      }
      return {item, eventId:reply?.eventId ?? batch.project?.eventId, reused:!!reply?.reused};
    } finally { await rm(staging,{recursive:true,force:true}); }
  }

  private importedAssetPath(source: string, href: string): string | undefined {
    let local: string;
    try { local = decodeURIComponent(href); } catch { return; }
    if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(local) || local.split(/[\\/]/).includes("..")) return;
    const root = dirname(resolve(source)), path = resolve(root,local);
    if (!existsSync(path) || !statSync(path).isFile()) return;
    try { assertManagedPathSafe(root,path); } catch { return; }
    if (["image","office","pdf"].includes(kindFromFilename(path)) || /\.(txt|zip|mp[34]|wav)$/i.test(path)) return path;
  }

  async importFileAsync(req: LibraryImportFileRequest): Promise<LibraryItemDto> {
    if (this.db.coreIdentity) {
      const result = await this.trackFileMutation(this.importThroughCore(req));
      if (!result.item) throw new Error("资料导入缺少条目");
      return result.item;
    }
    if (!this.db.runtimeAuditReader) return this.importFile(req);
    const item = this.prepareImportedFile(req);
    if (item.sizeBytes <= LARGE_LIBRARY_TEXT_BYTES || !this.repo.isTextSearchable(item.kind)) {
      return this.importPreparedFile(req, item);
    }
    const linked = new Map<string, LibraryItemDto>();
    const path = this.absolutePath(item);
    try {
      const publish = (stage?: LibraryTextStage, changed = false) => {
        this.requireWritableSpace(req.spaceId);
        if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
        item.sizeBytes = statSync(path).size;
        if (stage) item.contentHash = stage.contentHash;
        else if (changed) item.contentHash = sha256File(path);
        return this.commitNewManagedItem(item, () => {}, stage);
      };
      mkdirSync(this.spaceDir(item.spaceId), { recursive: true });
      this.assertManagedWritePath(path);
      const copied = await this.indexMaintenance.withLargeTextStage(req.sourcePath.trim(),
        stage => stage ? publish(stage) : undefined,
        { copyTo: path, refuseMarkdownLinks: item.kind === "markdown" });
      if (copied) return copied;
      this.removeFile(item);
      const changed = this.copyImportedFile(req, item, linked);
      return await this.indexMaintenance.withLargeTextStage(path, stage => publish(stage, changed));
    } catch (error) {
      try { if (!this.repo.getItem(item.id)) this.removeFile(item); }
      catch (cleanupError) { console.warn("[Library] 导入文件清理失败", cleanupError); }
      this.cleanupImportedAssets(linked);
      throw error;
    }
  }

  private prepareImportedFile(req: LibraryImportFileRequest): LibraryItemDto {
    const source = req.sourcePath?.trim();
    if (!source || !existsSync(source)) throw new Error("源文件不存在");
    const st = statSync(source);
    if (!st.isFile()) throw new Error("只能导入文件");
    this.requireWritableSpace(req.spaceId);
    if (req.collectionId) this.requireCollectionInSpace(req.spaceId, req.collectionId);
    return this.describeImportedFile(source, st.size, req);
  }

  private importPreparedFile(req: LibraryImportFileRequest, item: LibraryItemDto): LibraryItemDto {
    const linked = new Map<string, LibraryItemDto>();
    try {
      return this.commitNewManagedItem(item, () => {
        if (this.copyImportedFile(req, item, linked)) item.contentHash = sha256File(this.absolutePath(item));
      });
    } catch (error) {
      this.cleanupImportedAssets(linked);
      throw error;
    }
  }

  private copyImportedFile(req: LibraryImportFileRequest, item: LibraryItemDto, linked: Map<string, LibraryItemDto>): boolean {
    const source = req.sourcePath.trim();
    const target = this.absolutePath(item);
    mkdirSync(this.spaceDir(item.spaceId), { recursive: true });
    this.assertManagedWritePath(target);
    if (item.kind !== "markdown") {
      copyFileSync(source, target);
      item.sizeBytes = statSync(target).size;
      return false;
    }
    const changed = copyWithRewrittenNoteLinks(source, target, (href) => {
      const path = this.importedAssetPath(source,href);
      if (!path) return;
      if (!linked.has(path)) linked.set(path, this.importFile({ ...req, sourcePath: path }));
      return this.previewUrl(linked.get(path)!.id);
    });
    item.sizeBytes = statSync(target).size;
    return changed;
  }

  private cleanupImportedAssets(linked: ReadonlyMap<string, LibraryItemDto>): void {
    for (const asset of linked.values()) {
      try { this.deleteItem(asset.id); } catch (error) { console.warn("[Library] 导入附件清理失败", error); }
    }
  }

  private describeImportedFile(source: string, sizeBytes: number, target: Pick<LibraryImportFileRequest, "spaceId" | "collectionId">, owner = this.ownerName()): LibraryItemDto {
    const name = basename(source);
    const kind = kindFromFilename(name);
    const now = Date.now();
    return {
      id: randomUUID(),
      spaceId: target.spaceId,
      collectionId: target.collectionId ?? null,
      kind,
      title: name.replace(/\.[^.]+$/, "") || name,
      filename: name,
      mimeType: preciseMimeFromFilename(name) || mimeForKind(kind),
      sizeBytes,
      owner,
      favorite: false,
      sourceType: "uploaded",
      originalPath: source,
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
  }

  /**
   * Artifact → 资料库：只 COPY 不删原件；provenance 完整记录。
   *
   * 幂等/一致语义（冻结）：同 sourceArtifactId 保存到同 space 时复用已有条目——
   * 若请求目标 collection 不同则移动该条目到目标 collection；
   * 若源 artifact 内容（文件 hash）已变化，则更新受管副本、记录 LibraryVersion（旧 hash）并刷新检索索引，
   * 绝不静默返回旧副本。
   */
  async saveTaskArtifact(req: Omit<LibrarySaveArtifactRequest,"owner"|"spaceId"> & {spaceId?:string},
    taskId?:string, projectFallback?:string|null): Promise<LibraryItemDto> {
    const actor = taskId ? {taskId} : {projectId:projectFallback ?? undefined};
    const scope = await this.db.runtimeAuditReader?.libraryMetadata<{projectId?:string;workspaceId?:string}>({
      kind:"taskScope", ...actor, itemIds:[],
    });
    if (!scope?.projectId && !scope?.workspaceId) throw new Error("当前任务没有长期资料归属");
    const spaceId = req.spaceId?.trim() || (await this.ensureOwnedSpaceAsync(scope.projectId ?
      {type:"project",projectId:scope.projectId} : {type:"workspace",workspaceId:scope.workspaceId!})).id;
    return this.saveArtifactAsync({...req,spaceId},actor);
  }

  async saveArtifactAsync(req: LibrarySaveArtifactRequest, actor?: {taskId?:string;projectId?:string|null}): Promise<LibraryItemDto> {
    if (!this.db.coreIdentity) return this.saveArtifact(req);
    const reader = this.db.runtimeAuditReader!;
    const src = await reader.artifactById(req.artifactId);
    if (!src) throw new Error("产物不存在或读取未确认");
    const filename = basename(src.source.type === "managed-content" ? src.source.storagePath : src.source.entryFile);
    const kind = kindFromFilename(filename);
    const operationId = randomUUID();
    const save = { artifactId:req.artifactId, spaceId:req.spaceId, collectionId:req.collectionId, owner:req.owner, actor, version:src.version, filename, kind, mime:preciseMimeFromFilename(filename) || src.mimeType || mimeForKind(kind),
      operationId, root:this.root, ...LIBRARY_CHUNK_DEFAULTS };
    return this.trackFileMutation((async () => {
      const reply = await reader.writeLibraryNote<LibraryCatalogRows["items"][number]>({kind:"saveArtifact",save}).catch(missingOperationReply);
      const confirmed = reply ?? await reader.libraryMetadata<typeof reply>({kind:"restoreReceipt",root:this.root,operationId});
      if (confirmed?.status !== "updated" || !confirmed.item) throw new Error("Core 未确认成果保存，请刷新资料库核对");
      const item = toItem(confirmed.item);
      this.indexMaintenance.noteTextIndexed(item.id);
      return item;
    })());
  }

  saveArtifact(req: LibrarySaveArtifactRequest): LibraryItemDto {
    if (req.owner !== undefined) assertArtifactSaveOwner(this.db, this.repo, req.owner, req.spaceId, req.artifactId);
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
      createdAt: now,
      updatedAt: now,
      lastVisitedAt: now,
    };
    mkdirSync(this.spaceDir(item.spaceId), { recursive: true });
    return this.commitNewManagedItem(item, () => {
      const target = this.absolutePath(item);
      this.assertManagedWritePath(target);
      copyFileSync(sourcePath, target);
      item.sizeBytes = statSync(target).size;
      item.contentHash = sha256File(target);
    });
  }

  /** 复用已有 artifact 条目：内容变化 → 更新副本+版本；collection 变化 → 移动；全不变 → 原样返回（no-op） */
  private refreshSavedArtifact(existing: LibraryItemDto, collectionId: string | null): LibraryItemDto {
    if (this.textSaves.waitFor(existing.id)) throw new Error("此资料正在保存，请稍后重试");
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
    const hasBackup = contentChanged && existsSync(abs);
    const textBackup = hasBackup && this.repo.isTextReadable(existing.kind);
    // Keep large history bodies in managed files so a refresh never materializes one in SQLite.
    const fileBackedVersion = textBackup && statSync(abs).size > 1024 * 1024;
    const backup = !hasBackup ? undefined : fileBackedVersion
      ? join(abs + ".versions", versionId!)
      : `${abs}.rollback-${randomUUID()}`;
    let fileChanged = false;
    let metadataChanged = false;
    try {
      if (contentChanged) {
        this.assertManagedWritePath(abs);
        if (backup) {
          this.assertManagedWritePath(backup);
          mkdirSync(dirname(backup), { recursive: true });
          copyFileSync(abs, backup);
        }
        if (versionId) {
          this.repo.insertVersion({
            id: versionId,
            itemId: existing.id,
            version: this.repo.nextVersion(existing.id),
            contentHash: managedHash ?? sourceHash,
            path: fileBackedVersion ? backup! : abs,
            createdBy: this.ownerName(),
            sourceTaskId: existing.sourceTaskId,
            createdAt: Date.now(),
          }, backup && textBackup && !fileBackedVersion ? readFileSync(backup) : undefined);
        }
        atomicCopyFileSync(sourcePath, abs);
        fileChanged = true;
        if (sha256File(abs) !== sourceHash) throw new Error("源产物在保存期间已变化，请重试");
        next.sizeBytes = statSync(abs).size;
        next.contentHash = sourceHash;
      }
      this.repo.updateItem(next, existing);
      metadataChanged = true;
      this.refreshFts(next);
      if (backup && !fileBackedVersion) rmSync(backup, { force: true });
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
        try { this.repo.updateItem(existing, next); }
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
    this.repo.updateItem(next, item);
    return next;
  }

  /** 搜索：标题/文件名和完整正文。
   *  opts 缺省 = 用户级全量（UI）；显式 { projectId } 也必须通过统一作用域解析。 */
  search(
    query: string,
    opts?: {
      projectId?: string | null;
      spaceIds?: ReadonlySet<string>;
      collectionIds?: ReadonlySet<string>;
      itemIds?: ReadonlySet<string>;
    },
  ): LibraryListRowDto[] {
    const q = query.trim();
    if (!q) return [];
    const spaces = this.repo.listSpaces();
    const explicitScope = opts?.spaceIds !== undefined || opts?.collectionIds !== undefined || opts?.itemIds !== undefined;
    const queryScope = explicitScope
      ? { spaceIds: new Set(opts?.spaceIds ?? []), collectionIds: opts?.collectionIds, itemIds: opts?.itemIds }
      : opts === undefined
        ? { spaceIds: new Set(spaces.map((space) => space.id)) }
        : queryScopeForTask(this.resolveTaskScope(undefined, opts.projectId));
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    const hits = this.retrieve(q, { ...queryScope, limit: 80 });
    const rows: LibraryListRowDto[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const item = this.repo.getItem(hit.itemId);
      if (!item) continue;
      seen.add(item.id);
      rows.push(this.toRow(item, spaceName.get(item.spaceId) ?? "资料库"));
    }
    // FTS 缺失或历史索引正在补齐时，回读受管正文以维持搜索结果。
    const ftsAvailable = this.repo.ftsAvailable();
    const fullTextFallback = !ftsAvailable;
    const targetedFallbackIds = this.indexMaintenance.pendingTextFtsIds;
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
          if (!st.isFile()) continue;
          if (libraryTextContains(readLibraryTextParts(abs), needle)) {
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
   * opts 缺省 = 显式管理操作的全量检索；传入 projectId 后使用项目统一作用域；无归属不回落到个人空间。
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
    const spaces = this.repo.listSpaces();
    const explicitScope = opts?.spaceIds !== undefined || opts?.collectionIds !== undefined || opts?.itemIds !== undefined;
    const scope = explicitScope
      ? { spaceIds: new Set(opts?.spaceIds ?? []), collectionIds: opts?.collectionIds, itemIds: opts?.itemIds }
      : opts?.projectId === undefined
        ? { spaceIds: new Set(spaces.map((space) => space.id)) }
        : queryScopeForTask(this.resolveTaskScope(undefined, opts.projectId));
    const limit = opts?.limit ?? 10;
    const hits = this.repo.retrieve(query, { ...scope, limit });
    // Exact phrases longer than a chunk's overlap can straddle its boundaries.
    const needle = query.trim().toLowerCase();
    if (needle.length <= LIBRARY_CHUNK_DEFAULTS.overlap || hits.length >= limit) return hits;
    const matched = new Set(hits.map(hit => hit.itemId));
    const prefix = needle.slice(0, LIBRARY_CHUNK_DEFAULTS.overlap - 1).replace(/[\ud800-\udbff]$/u, "");
    for (const id of this.repo.findLargeTextKeywordCandidates(prefix, scope)) {
      if (matched.has(id)) continue;
      const item = this.repo.getItem(id);
      if (!item) continue;
      const path = this.absolutePath(item);
      try {
        this.assertManagedFile(path);
        if (!libraryTextContains(readLibraryTextParts(path), needle)) continue;
      } catch {
        continue;
      }
      hits.push({
        itemId: item.id, title: item.title, kind: item.kind, spaceId: item.spaceId,
        snippet: "", rank: 2, favorite: item.favorite, sourceType: item.sourceType,
        sourceTaskId: item.sourceTaskId, updatedAt: item.updatedAt,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** FTS 索引维护：文本类条目同步标题/文件名/正文；Office/PDF 标记 pending 并异步抽取索引；
   *  图片/URL/未知 → 清理 FTS + unsupported（绝不把未抽取的二进制当正文）。
   *  R2：每次 FTS 维护后同步维护 library_chunks + library_chunks_fts（chunk 仅定位辅助）。
   */
  private refreshFts(item: LibraryItemDto, stage?: LibraryTextStage): void { this.indexMaintenance.refreshFts(item, stage); }

  recoverTextFtsCoverageV2(opts?: Parameters<LibraryIndexMaintenance["recoverTextFtsCoverageV2"]>[0]) {
    return this.indexMaintenance.recoverTextFtsCoverageV2(opts);
  }

  backfillMissingChunks(opts?: Parameters<LibraryIndexMaintenance["backfillMissingChunks"]>[0]) {
    return this.indexMaintenance.backfillMissingChunks(opts);
  }

  startSemanticIndexing(): void { this.indexMaintenance.startSemanticIndexing(); }
  scheduleSemanticIndex(): void { this.indexMaintenance.scheduleSemanticIndex(); }
  stopSemanticIndexing(): Promise<void> { return this.indexMaintenance.stopSemanticIndexing(); }
  get semanticIndexStats() { return this.indexMaintenance.semanticIndexStats; }
  readSemanticIndexStats() { return this.indexMaintenance.readSemanticIndexStats(); }

  backfillEmbeddings(opts?: Parameters<LibraryIndexMaintenance["backfillEmbeddings"]>[0]) {
    return this.indexMaintenance.backfillEmbeddings(opts);
  }

  indexExtractedText(itemId: string): Promise<void> { return this.indexMaintenance.indexExtractedText(itemId); }
  getExtractedText(item: LibraryItemDto, textMaxChars?: number): Promise<ExtractionResult> {
    return this.indexMaintenance.getExtractedText(item, textMaxChars);
  }
  flushPendingIndexes(): Promise<void> { return this.indexMaintenance.flushPendingIndexes(); }
  flushPendingTextWrites(): Promise<void> { return this.textSaves.flush(); }
  recoverPendingExtractions(): Promise<number> { return this.indexMaintenance.recoverPendingExtractions(); }

  previewUrl(itemId: string): string {
    return `mybuddy-library://local/${encodeURIComponent(itemId)}/`;
  }

  absolutePath(item: LibraryItemDto): string {
    if (item.kind === "url") return "";
    return join(this.spaceDir(item.spaceId), `${item.id}${extname(item.filename)}`);
  }

  async readPreview(itemId: string, subPath: string, allowedKinds?: readonly LibraryItemKind[]): Promise<{path:string; mime:string} | null> {
    const item = await this.readItemAsync(itemId);
    if (!item || item.kind === "url" || (allowedKinds && !allowedKinds.includes(item.kind))) return null;
    if (!subPath) {
      const path = this.absolutePath(item);
      this.assertManagedFile(path);
      return {path, mime:item.mimeType || guessMime(item.filename)};
    }
    if (!this.db.coreIdentity) return this.resolvePreview(itemId,subPath);
    const cleaned = subPath.replace(/^\/+/, "").split(/[\\/]/).filter(p => p && p !== "." && p !== "..");
    if (cleaned.length !== 1) return null;
    const {items} = await this.readSnapshot({spaceId:item.spaceId});
    const file = items.find(candidate => candidate.filename.toLowerCase() === cleaned[0].toLowerCase());
    if (!file) return null;
    const path = this.absolutePath(file);
    this.assertManagedFile(path);
    return {path, mime:file.mimeType || guessMime(file.filename)};
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
   * 资料库目录摘要（仅标题/类型/位置/id，不含全文）——包括无任务预览在内，
   * 一律按统一任务作用域限域；独立任务不自动获得持久资料，旧资料仅按显式引用可见。
   */
  formatCatalog(limit = 36, opts?: { taskId?: string | null; projectId?: string | null; workspaceId?: string | null; toolsAvailable?: boolean }): string {
    const taskScope = this.resolveTaskScope(opts?.taskId, opts?.projectId, { workspaceFallback: opts?.workspaceId });
    const spaces = this.repo.listSpaces();
    return formatLibraryCatalog(this.listItemsInScope(taskScope), spaces, Boolean(taskScope.defaultOwner), limit, opts?.toolsAvailable ?? true);
  }

  async readItemLocation(id: string): Promise<string> {
    if (!this.db.coreIdentity) return this.showInFolder(id);
    const item = await this.readItemAsync(id);
    if (!item) throw new Error("条目不存在");
    if (item.kind === "url") throw new Error("URL 条目没有本地文件");
    return this.absolutePath(item);
  }

  showInFolder(id: string): string {
    const item = this.repo.getItem(id);
    if (!item) throw new Error("条目不存在");
    if (item.kind === "url") throw new Error("URL 条目没有本地文件");
    return this.absolutePath(item);
  }

  /* ---------------- TaskLibraryReference ---------------- */

  async attachToTaskAsync(req: LibraryAttachRequest, agent = false): Promise<LibraryTaskReferenceDto> {
    if (!this.db.coreIdentity) return this.attachToTask(req);
    const reply = await this.db.runtimeAuditReader?.batch3Write<{ok:boolean; error?:string; reference?:LibraryTaskReferenceDto}>({
      kind:"libraryTaskReference",action:agent ? "attachVisibleToTask" : "attachToTask", ...req,
    });
    if (!reply?.ok || !reply.reference) throw new Error(reply?.error ?? "Core 未确认资料附加");
    return reply.reference;
  }

  async detachFromTaskAsync(req: LibraryDetachRequest, agent = false): Promise<void> {
    if (!this.db.coreIdentity) return this.detachFromTask(req);
    const reply = await this.db.runtimeAuditReader?.batch3Write<{ok:boolean; error?:string}>({
      kind:"libraryTaskReference",action:agent ? "detachVisibleFromTask" : "detachFromTask", ...req,
    });
    if (!reply?.ok) throw new Error(reply?.error ?? "Core 未确认资料引用已移除");
  }

  async readTaskItem(taskId: string, id: string) {
    if (!this.db.coreIdentity) {
      const item = this.getItem(id);
      return item && this.isItemVisibleInScope(item, this.resolveTaskScope(taskId))
        ? { item, workspaceId: this.getSpace(item.spaceId)?.workspaceId } : undefined;
    }
    const scope = await this.db.runtimeAuditReader?.libraryMetadata<Pick<LibraryCatalogRows, "spaces" | "items"> | null>({
      kind: "taskScope", taskId, itemIds: [id],
    });
    if (scope === undefined) throw new Error("Core 未确认当前任务的资料权限");
    const row = scope?.items.find(item => item.id === id);
    const space = row && scope?.spaces.find(space => space.id === row.space_id);
    return row && space ? { item: toItem(row), workspaceId: space.workspace_id } : undefined;
  }

  async readTaskReferences(taskId:string): Promise<LibraryTaskReferencesDto> {
    if (!this.db.coreIdentity) return this.listTaskReferences(taskId);
    const scope = await this.db.runtimeAuditReader?.libraryMetadata<{
      spaces: LibraryCatalogRows["spaces"]; items: LibraryCatalogRows["items"]; attachedItemIds:string[];
    } | null>({kind:"taskScope",taskId});
    if (scope === undefined) throw new Error("Core 未确认任务资料引用");
    if (!scope) return {taskId,items:[]};
    const items = new Map(scope.items.map(row=>[row.id,toItem(row)]));
    const names = new Map(scope.spaces.map(row=>[row.id,row.name]));
    return {taskId, items:scope.attachedItemIds.flatMap(id => {
      const item = items.get(id);
      const location = item && names.get(item.spaceId);
      return item && location !== undefined ? [this.toRow(item,location)] : [];
    })};
  }

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

  /* ---------------- 内部 ---------------- */

  private deleteCollectionRecursive(collection: LibraryCollectionDto): void {
    const descendants = this.repo.listCollectionsRecursive(collection.spaceId, collection.id);
    const collections = [collection, ...descendants];
    const items = this.repo.listItemsInCollectionTree(collection.spaceId, collection.id);
    const runDelete = () => {
      for (const item of items) this.repo.deleteItem(item.id);
      for (const current of [...collections].reverse()) {
        this.db.deleteLibraryCollectionLinks(current.id);
        this.repo.deleteCollection(current.id);
      }
    };
    if (this.requiresRustWrites) runDelete();
    else this.db.connection.transaction(runDelete)();
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
        .all() as LibraryArtifactRow[];
      return rows.map(row => this.toLibraryArtifact(row, ownerName));
    } catch {
      return [];
    }
  }

  private toLibraryArtifact(row: LibraryArtifactRow, ownerName: string): LibraryArtifactDto {
    return {
      id: row.id,
      taskId: row.task_id,
      spaceId: row.space_id ?? undefined,
      kind: row.kind,
      title: row.title?.trim() || "未命名产物",
      owner: ownerName,
      location: row.space_name ? `${row.space_name} · ${row.task_title ?? "任务"}` : (row.task_title ?? "本地产物"),
      updatedAt: row.updated_at,
    };
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
  private commitNewManagedItem(item: LibraryItemDto, materialize: () => void, stage?: LibraryTextStage): LibraryItemDto {
    const target = this.absolutePath(item);
    let rowInserted = false;
    try {
      materialize();
      this.repo.insertItem(item);
      rowInserted = true;
      this.refreshFts(item, stage);
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
  private writeManagedFile(item: LibraryItemDto, content: string | Uint8Array): void {
    const abs = this.absolutePath(item);
    this.assertManagedWritePath(abs);
    atomicWriteFileSync(abs, content);
  }

  private removeFile(item: LibraryItemDto): void {
    const abs = this.absolutePath(item);
    if (abs) {
      if (this.isManagedFileSafe(abs) && existsSync(abs)) rmSync(abs, { force: true });
      const versions = abs + ".versions";
      if (this.isManagedFileSafe(versions) && existsSync(versions)) {
        rmSync(versions, { recursive: true, force: true });
      }
    }
  }
}

export function formatLibraryCatalog(
  sourceItems: readonly LibraryItemDto[],
  spaces: readonly LibrarySpaceDto[],
  hasOwner: boolean,
  limit: number,
  toolsAvailable: boolean,
): string {
  const items = sourceItems.filter((item) => item.kind !== "url");
  if (!items.length) {
    return [
      "## 资料库",
      hasOwner
        ? "当前范围还没有可见资料。用户可在对应项目或工作空间的资料页添加，或显式引用已有资料。"
        : "独立任务没有长期资料库；临时文件和产物放在任务内，需要长期保存的资料请归入项目或工作空间。",
      "三种载体分工：MD 决定内容，CSV 存储数据，HTML 负责表达；同空间可用相对路径互相引用。",
    ].join("\n");
  }
  const spaceName = new Map(spaces.map((space) => [space.id, space.name]));
  const lines = [
    "## 资料库",
    "以下为本任务可使用的资料：归属项目、当前/祖先工作空间，以及显式引用。继承或引用只提供读取权。",
    toolsAvailable
      ? "需要内容时用 library_search / library_read 按需读取；二进制/办公/图片条目返回受管路径，需要文件工具或预览读取，资料库不提供内联全文。"
      : "本会话不提供资料库工具；如需内容请告知用户或由主任务（在项目上下文中的任务）读取。",
    "",
  ];
  for (const item of items.slice(0, limit)) {
    const loc = spaceName.get(item.spaceId) ?? item.spaceId;
    lines.push(`- [${item.kind}] ${item.title} · ${loc} · id=${item.id}`);
  }
  if (items.length > limit) lines.push(`- …其余 ${items.length - limit} 条未列出，可在当前范围继续搜索`);
  return lines.join("\n");
}


