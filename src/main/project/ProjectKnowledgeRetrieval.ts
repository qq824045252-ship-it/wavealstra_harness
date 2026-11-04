/**
 * ProjectKnowledgeRetrieval — 项目知识统一检索层（RAG foundation，hybrid-ready）。
 *
 * 职责：把「Library FTS/metadata 检索 + Project pins + Task 显式附件 + 内容抽取状态」收敛成
 * 一个带 task 作用域的检索入口。所有方法以 taskId 为输入，project scope 由主进程从任务解析：
 * - 与 Library 工具共用当前项目、工作空间及显式引用范围；
 * - 无项目/工作空间的独立任务使用个人资料；未知任务无可见资料；
 * - 绝不含其他项目。
 *
 * 分层语义：task-explicit（本任务显式附加）> pinned（项目固定引用）> plain（普通检索）。
 * explicit/pinned 已在 prompt 中以引用段注入，检索结果只做标注（不重复注入全文）。
 *
 * 预算：limit ≤20、snippet ≤300 字符、read ≤4000 字符/次；二进制只给 requiresFileAccess + 受管路径。
 * 升级边界：命中 DTO 预留 sourceType/provenance；未来接 embedding 只需在检索器内增加一路
 * 向量召回并合并排序，调用方与工具契约不变（hybrid-ready，不引入外部向量依赖）。
 */
import type { AppDatabase } from "../db/AppDatabase";
import { ContentExtractorRegistry } from "../library/ContentExtractorRegistry";
import type { LibraryItemDto, LibraryItemKind } from "../../shared/library-ipc";
import type {
  KnowledgeHitTier,
  ProjectKnowledgeHitDto,
  ProjectKnowledgeSearchResultDto,
} from "../../shared/project-domain";
import type { LibraryService } from "../library/LibraryService";
import type { ProjectService } from "./ProjectService";

export const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 300;
export const KNOWLEDGE_READ_MAX_CHARS = 4000;

export interface ProjectKnowledgeReadResult {
  item: LibraryItemDto;
  tier: KnowledgeHitTier;
  /** 文本类/抽取类正文（≤4000 字符，超限带截断说明）；不可读 = "" */
  content: string;
  requiresFileAccess: boolean;
  /** 二进制/抽取失败：受管绝对路径（供文件工具读取；成功内联时不给出） */
  managedPath?: string;
  url?: string;
  truncated: boolean;
  /** 抽取失败原因（requiresFileAccess 时可见） */
  extractionError?: string;
}

export class ProjectKnowledgeRetrieval {
  constructor(
    _db: AppDatabase,
    private readonly library: LibraryService,
    private readonly projects: ProjectService,
  ) {}

  /** tier：任务显式附加 > 项目固定引用 > plain（同一 item 只算最高层） */
  private tierOf(taskId: string, projectId: string | null, itemId: string): KnowledgeHitTier {
    try {
      if (this.library.listTaskReferences(taskId).items.some((r) => r.id === itemId)) {
        return "task-explicit";
      }
    } catch {
      /* 忽略 */
    }
    if (projectId) {
      try {
        if (this.projects.listProjectPins(projectId).some((p) => p.itemId === itemId)) {
          return "pinned";
        }
      } catch {
        /* 忽略 */
      }
    }
    return "plain";
  }

  /**
   * 统一检索：输入 taskId（scope 由主进程解析），输出结构化命中。
   * 复用 Library FTS trigram + exact/prefix 排名；不新造检索库。
   */
  search(
    taskId: string,
    query: string,
    opts?: { limit?: number; kind?: LibraryItemKind },
  ): ProjectKnowledgeSearchResultDto {
    const scope = this.library.resolveTaskScope(taskId);
    const { projectId } = scope;
    const requestedLimit = Math.max(1, Math.min(Math.round(opts?.limit ?? 10), KNOWLEDGE_SEARCH_MAX_LIMIT));
    const raw = this.library.retrieveInScope(query, scope, { limit: requestedLimit * 2 });
    const hits: ProjectKnowledgeHitDto[] = [];
    for (const hit of raw) {
      if (opts?.kind && hit.kind !== opts.kind) continue;
      if (hits.length >= requestedLimit) break;
      const item = this.library.getItem(hit.itemId);
      if (!item || !this.library.isItemVisibleInScope(item, scope)) continue;
      hits.push({
        itemId: hit.itemId,
        title: hit.title,
        kind: hit.kind,
        spaceId: hit.spaceId,
        snippet: (hit.snippet ?? "").slice(0, KNOWLEDGE_SNIPPET_MAX_CHARS),
        rank: hit.rank,
        tier: this.tierOf(taskId, projectId, hit.itemId),
        readable: Boolean(
          item &&
            (this.isTextKind(item.kind) ||
              (this.isExtractableKind(item.kind) &&
                item.extractStatus !== "unsupported" &&
                item.extractStatus !== "error")),
        ),
        favorite: hit.favorite,
        sourceType: hit.sourceType,
        sourceTaskId: hit.sourceTaskId,
        sourceArtifactId: item?.sourceArtifactId,
        updatedAt: hit.updatedAt,
      });
    }
    return {
      taskId,
      projectId,
      scope: !scope.defaultOwner ? "none" : projectId ? "project" : scope.workspaceId ? "workspace" : "personal",
      hits,
      budget: { requestedLimit, effectiveLimit: KNOWLEDGE_SEARCH_MAX_LIMIT },
    };
  }

  /** 作用域读取：文本类/Office/PDF 内联（≤4000 字符）；抽取失败或不可抽取 → requiresFileAccess + 受管路径；URL → 链接 */
  async read(taskId: string, itemId: string): Promise<ProjectKnowledgeReadResult> {
    const scope = this.library.resolveTaskScope(taskId);
    const { projectId } = scope;
    const item = this.library.getItem(itemId);
    if (!item) throw new Error(`资料条目不存在：${itemId}`);
    if (!this.library.isItemVisibleInScope(item, scope)) {
      throw new Error("该条目不在当前任务可见范围（跨项目或未引用的其他资料不可访问）");
    }
    const tier = this.tierOf(taskId, projectId, itemId);
    if (item.kind === "url") {
      return { item, tier, content: "", requiresFileAccess: false, url: item.url, truncated: false };
    }
    if (!this.isExtractableKind(item.kind)) {
      return {
        item,
        tier,
        content: "",
        requiresFileAccess: true,
        managedPath: this.library.absolutePath(item),
        truncated: false,
      };
    }
    // 文本类直接内联；Office/PDF 经抽取器（受管路径守卫在 LibraryService.getExtractedText 内），
    // 抽取失败/不可抽取 → 降级 requiresFileAccess 元数据（模型不得误以为已读正文）。
    let raw = "";
    let extractionNote = "";
    if (this.isTextKind(item.kind)) {
      try {
        raw = this.library.readContent(itemId).content;
      } catch {
        return {
          item,
          tier,
          content: "",
          requiresFileAccess: true,
          managedPath: this.library.absolutePath(item),
          truncated: false,
        };
      }
    } else {
      const extracted = await this.library.getExtractedText(item);
      // Extraction can outlive a binding, attachment, task move, or deletion. Recheck
      // before returning either extracted content or the fallback managed-file path.
      const current = this.library.getItem(itemId);
      if (!current || !this.library.isItemVisibleInScope(current, this.library.resolveTaskScope(taskId))) {
        throw new Error("资料已删除或已离开当前任务可见范围，请重新检索");
      }
      if (extracted.status !== "extracted" || !extracted.text) {
        return {
          item,
          tier,
          content: "",
          requiresFileAccess: true,
          managedPath: this.library.absolutePath(item),
          truncated: false,
          extractionError: extracted.error,
        };
      }
      raw = extracted.text;
      extractionNote = extracted.truncated
        ? `（${item.kind} 抽取文本，超出 200KB 预算已截断；非原始排版）`
        : `（${item.kind} 抽取文本，非原始排版）`;
    }
    const truncated = raw.length > KNOWLEDGE_READ_MAX_CHARS;
    return {
      item,
      tier,
      content:
        (truncated
          ? `${raw.slice(0, KNOWLEDGE_READ_MAX_CHARS)}\n…（内容过长，已截断前 ${KNOWLEDGE_READ_MAX_CHARS} 字符）`
          : raw) + (extractionNote ? `\n${extractionNote}` : ""),
      requiresFileAccess: false,
      truncated,
    };
  }

  /** 抽取状态（registry；text 类稳定抽取，office/pdf 视解析结果，image/file unsupported）。
   *  读取前必须经过受管路径守卫（symlink/junction 拒绝），不安全路径按 unsupported 处理。 */
  async getExtractionStatus(
    item: LibraryItemDto,
  ): Promise<{ status: "extracted" | "unsupported" | "error"; truncated: boolean; error?: string }> {
    const abs = this.library.absolutePath(item);
    if (!abs || !this.library.isManagedFileSafe(abs)) return { status: "unsupported", truncated: false };
    if (this.isTextKind(item.kind)) return { status: "extracted", truncated: false };
    if (!this.isExtractableKind(item.kind)) return { status: "unsupported", truncated: false };
    const result = await this.library.getExtractedText(item);
    return { status: result.status, truncated: result.truncated, error: result.error };
  }

  private isTextKind(kind: LibraryItemKind): boolean {
    return kind === "markdown" || kind === "html" || kind === "csv";
  }

  /** 可内联读取的类型：文本类 + Office/PDF（抽取成功返回正文，失败降级元数据） */
  private isExtractableKind(kind: LibraryItemKind): boolean {
    return this.isTextKind(kind) || kind === "office" || kind === "pdf";
  }
}
