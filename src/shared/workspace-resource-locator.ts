/**
 * Workspace-scoped Resource Locator — Shared Types (R1 frozen, R2 extends)
 *
 * 1) Workspace 是搜索 scope 权威（scopeSpaceIds = Current + ancestors，metadata 供未来 file/artifact）：
 *    默认不含 sibling/child；explicitDirectChild 仅临时扩 scopeSpaceIds。
 * 2) Library provider 与 library_list/search/read 和上下文共用任务范围：
 *    当前项目 + 当前/祖先工作空间自有资料 + 显式绑定/任务附件/项目固定引用。
 *    精确到文件夹子树或单条引用；其他项目始终不可见。独立任务默认个人资料。
 * 3) Search != Context Injection：Locator 仅返回轻量 hit，不自动注入 prompt
 * 4) Source of Truth 是真实资源：命中后用 library_read 等读取
 * 5) R1 仅 FTS5 trigram + metadata，无 embedding/vector/chunks/watcher
 * 6) R2 在 R1 之上增加 Chunk-level Locator（§28-30）：
 *    - library_chunks + library_chunks_fts（FTS5 trigram）仅作定位辅助，hit 仍指向真实 Item
 *    - hit 保持 lightweight，仅增加 location/chunkIndex/charOffset（不含全文）
 *    - chunk ≠ Source of Truth；不 Top-K chunk 自动塞 Prompt；Search 不注入 Context
 */

export type WorkspaceResourceProvider = "library";
export type WorkspaceResourceType = "library";
export type WorkspaceResourceMatchedBy = "title" | "filename" | "fts" | "body" | "fallback" | "chunk" | "semantic";

export interface WorkspaceResourceSearchRequest {
  /** Workspace 查询文本（trim 后空视为无结果） */
  query: string;
  /** 调试/测试用显式 current 空间；生产 Agent 必须传 taskId，此字段视为 untrusted，projectId 亦忽略 */
  currentSpaceId?: string | null;
  /** 任务 id：权威解析 currentSpaceId 与 projectId 的唯一可信来源 */
  taskId?: string | null;
  /** 调试用 projectId；生产路径 taskId 存在时一律忽略（防伪造 team 可见性），无 taskId 时强制 null */
  projectId?: string | null;
  /** Top-K，默认 10，最大 50 */
  limit?: number;
  /** 临时扩展：显式 direct child，仅当它是 current 的 direct child 且未 effectiveArchived 时加入 scope */
  explicitDirectChildSpaceId?: string | null;
  /** R3.6 Agent mode：auto(lexical-first+controlled fallback) | lexical | semantic；默认 auto */
  mode?: "auto" | "lexical" | "semantic";
}

export interface WorkspaceResourceHit {
  resourceType: WorkspaceResourceType;
  /** Library item id */
  id: string;
  spaceId: string;
  title: string;
  /** 文件名或 url 标题 */
  filename: string;
  /** 受控预览：FTS snippet 或 title/filename 匹配时为空，绝不含全量 body */
  preview: string;
  matchedBy: WorkspaceResourceMatchedBy;
  /** 检索分数：rank(0 exact,1 prefix,2 fts bm25) 或 bm25 数值 */
  score: number;
  /** 新鲜度：updatedAt */
  freshness: number;
  provider: WorkspaceResourceProvider;
  kind: string;
  /** R2：Chunk 定位（仅当 matchedBy==='chunk' 时填充；轻量，不含全文） */
  chunkIndex?: number;
  charOffset?: number;
  /** R2：便于 Agent 定向读取时的提示（不改变 hit 仍指向 Item 的契约） */
  location?: string;
}

export interface WorkspaceResourceSearchResult {
  hits: WorkspaceResourceHit[];
  /** 实际用于搜索的 allowed scope（current+ancestors [+explicit child]，已过滤 effectiveArchived/cycle） */
  scopeSpaceIds: string[];
  /** 整体耗时 ms */
  durationMs: number;
  /** 各 provider 耗时（R1 仅 library） */
  providerDurations: Record<WorkspaceResourceProvider, number> & { semantic?: number };
  /** 供调试：query 原文与规范化后 */
  query: string;
  normalizedQuery: string;
  /** R3 semantic telemetry (side-channel) */
  semanticTelemetry?: WorkspaceResourceSearchTelemetry;
}

export interface WorkspaceResourceSearchTelemetry {
  durationMs: number;
  resultCount: number;
  provider: WorkspaceResourceProvider;
  providerDurations: Record<WorkspaceResourceProvider, number>;
  scopeSize: number;
  // R3 semantic telemetry (not logged with query/body/vector)
  semanticTriggered?: boolean;
  semanticTriggerReason?: string | null;
  semanticAvailable?: boolean;
  semanticModelVersion?: string | null;
  semanticCandidateCount?: number;
  semanticAcceptedCount?: number;
  semanticDurationMs?: number;
}
