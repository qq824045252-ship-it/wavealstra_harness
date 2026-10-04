/**
 * 资料库 IPC 契约。
 *
 * 资料库是独立于任务产物的知识空间：
 * - 我的文档 / 团队空间：持久化在 ~/.mybuddy/library + SQLite
 * - 本地产物：只读投影任务 Artifact（不拷贝）
 * - MD / CSV / HTML 三种载体可互相引用（相对路径或 mybuddy-library://）
 */

export const LibraryIpc = {
  snapshot: "library:snapshot",
  listItems: "library:listItems",
  getItem: "library:getItem",
  createSpace: "library:createSpace",
  renameSpace: "library:renameSpace",
  deleteSpace: "library:deleteSpace",
  createCollection: "library:createCollection",
  renameCollection: "library:renameCollection",
  moveCollection: "library:moveCollection",
  deleteCollection: "library:deleteCollection",
  createItem: "library:createItem",
  updateItem: "library:updateItem",
  deleteItem: "library:deleteItem",
  readContent: "library:readContent",
  writeContent: "library:writeContent",
  importFile: "library:importFile",
  pickAndImport: "library:pickAndImport",
  markVisited: "library:markVisited",
  search: "library:search",
  previewUrl: "library:previewUrl",
  showInFolder: "library:showInFolder",
  createUrl: "library:createUrl",
  saveArtifact: "library:saveArtifact",
  favorite: "library:favorite",
  attachToTask: "library:attachToTask",
  detachFromTask: "library:detachFromTask",
  listTaskReferences: "library:listTaskReferences",
} as const;

export const LIBRARY_PERSONAL_SPACE_ID = "personal";

/* ---------------- 数据边界常量（单一事实源：Service/工具/IPC/UI 共用，禁止重复魔数） ---------------- */

/** 条目标题上限（create/update/createUrl 服务层强制，超限抛错） */
export const LIBRARY_TITLE_MAX_CHARS = 200;
/** 空间/集合名称上限 */
export const LIBRARY_NAME_MAX_CHARS = 100;
/** 文本正文上限（writeContent/工具 content 统一；1M 字符 ≈ 2MB UTF-8） */
export const LIBRARY_CONTENT_MAX_CHARS = 1_000_000;

export type LibrarySpaceKind = "personal" | "team";

/** 内容资产类型（不含 folder：组织节点由 LibraryCollection 承担） */
export type LibraryItemKind =
  | "markdown"
  | "html"
  | "csv"
  | "office"
  | "pdf"
  | "image"
  | "file"
  | "url";

/** 资料来源（provenance）：created=本库新建；uploaded=导入本地文件；artifact=由任务产物保存；url=添加的链接 */
export type LibrarySourceType = "created" | "uploaded" | "artifact" | "url";

export interface LibrarySpaceDto {
  id: string;
  name: string;
  kind: LibrarySpaceKind;
  /** 项目资料作用域：team 空间绑定 projectId 后即为「项目资料」（全局与项目页读同一份数据） */
  projectId?: string;
  /** 绑定的项目名（snapshot 计算，仅展示用） */
  projectName?: string;
  createdAt: number;
  updatedAt: number;
}

/** 组织节点：树形集合（项目/个人范围内），与内容资产 LibraryItem 严格分层 */
export interface LibraryCollectionDto {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryItemDto {
  id: string;
  spaceId: string;
  /** 所属集合（null = 空间根） */
  collectionId: string | null;
  kind: LibraryItemKind;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  owner: string;
  favorite: boolean;
  /** url 条目的目标地址 */
  url?: string;
  sourceType?: LibrarySourceType;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  originalPath?: string;
  contentHash?: string;
  extractStatus?: string;
  createdAt: number;
  updatedAt: number;
  lastVisitedAt: number | null;
}

export interface LibraryVersionDto {
  id: string;
  itemId: string;
  version: number;
  contentHash: string;
  path: string;
  createdBy: string;
  sourceTaskId?: string;
  createdAt: number;
}

export interface LibraryTaskReferenceDto {
  itemId: string;
  taskId: string;
  projectId?: string;
  addedAt: number;
  addedBy: string;
}

export interface LibraryArtifactDto {
  id: string;
  taskId: string;
  spaceId?: string;
  kind: string;
  title: string;
  owner: string;
  location: string;
  updatedAt: number;
}

export interface LibraryListRowDto {
  id: string;
  source: "library" | "artifact";
  kind: string;
  title: string;
  owner: string;
  location: string;
  spaceId?: string;
  parentId?: string | null;
  collectionId?: string | null;
  taskId?: string;
  lastVisitedAt?: number | null;
  updatedAt: number;
  filename?: string;
  favorite?: boolean;
}

export interface LibraryStorageDto {
  usedBytes: number;
}

export interface LibrarySnapshotDto {
  spaces: LibrarySpaceDto[];
  collections: LibraryCollectionDto[];
  items: LibraryItemDto[];
  recent: LibraryListRowDto[];
  artifacts: LibraryArtifactDto[];
  storage: LibraryStorageDto;
  ownerName: string;
}

export interface LibraryListItemsRequest {
  spaceId: string;
  collectionId?: string | null;
}

export interface LibraryCreateSpaceRequest {
  name: string;
  /** 绑定项目（项目资料作用域）；缺省 = 无项目（UI 不再提供无项目团队空间创建入口） */
  projectId?: string;
}

export interface LibraryRenameSpaceRequest {
  id: string;
  name: string;
}

export interface LibraryCreateItemRequest {
  spaceId: string;
  collectionId?: string | null;
  kind: Extract<LibraryItemKind, "markdown" | "html" | "csv">;
  title?: string;
}

export interface LibraryCreateCollectionRequest {
  spaceId: string;
  parentId?: string | null;
  name?: string;
}

export interface LibraryRenameCollectionRequest {
  id: string;
  name: string;
}

export interface LibraryMoveCollectionRequest {
  id: string;
  parentId: string | null;
}

export interface LibraryUpdateItemRequest {
  id: string;
  title?: string;
  collectionId?: string | null;
}

export interface LibraryWriteContentRequest {
  id: string;
  content: string;
}

export interface LibraryImportFileRequest {
  spaceId: string;
  collectionId?: string | null;
  sourcePath: string;
}

export interface LibraryCreateUrlRequest {
  spaceId: string;
  collectionId?: string | null;
  url: string;
  title?: string;
}

export interface LibrarySaveArtifactRequest {
  artifactId: string;
  spaceId: string;
  collectionId?: string | null;
}

export interface LibraryFavoriteRequest {
  id: string;
  favorite: boolean;
}

export interface LibraryAttachRequest {
  itemId: string;
  taskId: string;
}

export interface LibraryDetachRequest {
  itemId: string;
  taskId: string;
}

export interface LibraryTaskReferencesDto {
  taskId: string;
  items: LibraryListRowDto[];
}

export interface LibrarySearchRequest {
  query: string;
}

export interface LibraryContentDto {
  item: LibraryItemDto;
  content: string;
  previewUrl?: string;
  /** 受管文件绝对路径（非文本条目返回；需文件/预览工具读取） */
  managedPath?: string;
  /** true = 非文本资产，正文不可内联，须经文件工具读取 */
  requiresFileAccess?: boolean;
}

/** 检索命中（hybrid-ready：metadata 过滤 + FTS 相关性 + 显式排名；snippet 非全文） */
export interface LibraryRetrievalHitDto {
  itemId: string;
  title: string;
  kind: LibraryItemKind;
  spaceId: string;
  /** 文本类命中片段；非文本 = 空（metadata-only，绝不伪造已理解） */
  snippet: string;
  /** 排名键：exact=0 < prefix=1 < fts=2 < recency=3 */
  rank: number;
  favorite: boolean;
  sourceType?: LibrarySourceType;
  sourceTaskId?: string;
  updatedAt: number;
}

export interface LibraryRetrieveRequest {
  query: string;
  /** 检索范围：spaceId 白名单（服务端按 task scope 再次过滤） */
  limit?: number;
}

export const LIBRARY_KIND_LABEL: Record<string, string> = {
  folder: "文件夹",
  markdown: "文档",
  html: "页面",
  csv: "表格",
  office: "办公",
  pdf: "PDF",
  image: "图片",
  file: "文件",
  code: "文档",
  svg: "图片",
  cad: "模型",
  table: "表格",
};
