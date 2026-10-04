/**
 * ProjectDocumentImporter — 文件级文档导入适配器（外部文件 → 项目 document 事件）。
 *
 * 架构（Library-first，冻结）：文件先成为项目资料库真源条目（LibraryService.importFile：
 * 受管副本 + 内容抽取 + FTS，全部既有能力与安全边界），事件只引用 + 机械截取摘要，
 * 绝不重复存 bytes、绝不自动总结/OCR/后台写真源/自动 promotion。
 * - 幂等：ref = sha256(文件字节)；同 (project, source=document, ref) 已存在 → 复用
 *   （不重复建条目/事件；条目被删后同文件重导不重建——事件幂等优先，指针悬空诚实降级）；
 * - provenance：event.payload.libraryItemId / sizeBytes / extractStatus / extractTruncated；
 * - 生命周期：事件随 1000/项目滚动淘汰；资料条目是真源，不受事件淘汰影响；
 * - 门禁：归档项目拒绝（写真源写门禁）；A/B 由 projectId 作用域保证（无跨项目参数）；
 *   readonly 由 Agent 工具层拦截；文件大小/路径/symlink 边界全部复用 importFile 与抽取器既有守卫。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE, type ProjectEventDto } from "../../shared/project-domain";
import type { LibraryItemDto } from "../../shared/library-ipc";
import { LIBRARY_MAX_IMPORT_BYTES, type LibraryService } from "../library/LibraryService";
import {
  PROJECT_EVENT_BODY_MAX_CHARS,
  PROJECT_EVENT_TITLE_MAX_CHARS,
  type ProjectEventIngestor,
} from "./ProjectEventIngestor";
import type { ProjectService } from "./ProjectService";

export class ProjectDocumentImportPartialStateError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly itemId: string | undefined,
    public readonly spaceId: string,
    public readonly originalMessage: string,
    public readonly rollbackMessage: string,
  ) {
    super(
      `项目文件导入失败且回滚不完整：${originalMessage}；` +
      `残留 item=${itemId ?? "none"}；space=${spaceId}；rollback=${rollbackMessage}`,
    );
    this.name = "ProjectDocumentImportPartialStateError";
  }
}

interface ProjectLibrarySpaceResolution {
  space: { id: string };
  created: boolean;
}
export interface ProjectDocumentImportResult {
  event: ProjectEventDto;
  /** 资料库真源条目（幂等复用时可能为 null=条目已被删除，指针悬空） */
  item: LibraryItemDto | null;
  /** 幂等复用：同文件此前已导入 */
  reused: boolean;
}

export class ProjectDocumentImporter {
  constructor(
    private readonly projects: ProjectService,
    private readonly library: LibraryService,
    private readonly ingestor: ProjectEventIngestor,
  ) {}

  async importFile(projectId: string, sourcePath: string): Promise<ProjectDocumentImportResult> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);

    const path = sourcePath?.trim() ?? "";
    if (!path) throw new Error("文件路径不能为空");
    if (!existsSync(path)) throw new Error("源文件不存在");
    const st = statSync(path);
    if (!st.isFile()) throw new Error("只能导入文件");
    if (st.size > LIBRARY_MAX_IMPORT_BYTES) {
      throw new Error(`文件过大（${st.size} 字节），超过单文件上限 ${LIBRARY_MAX_IMPORT_BYTES} 字节`);
    }

    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const existing = this.projects.findProjectEventByRef(projectId, "document", hash);
    if (existing) {
      const itemId = typeof existing.payload?.libraryItemId === "string" ? existing.payload.libraryItemId : undefined;
      return { event: existing, item: itemId ? this.library.getItem(itemId) : null, reused: true };
    }

    const resolved = this.resolveProjectLibrarySpace(project);
    let item: LibraryItemDto | undefined;
    try {
      item = this.library.importFile({ spaceId: resolved.space.id, sourcePath: path });
    } catch (error) {
      this.rollbackImportOrThrow(projectId, resolved, undefined, error);
      throw error;
    }

    let excerpt: string | undefined;
    let extractStatus: string | undefined;
    let extractTruncated = false;
    try {
      const extracted = await this.library.getExtractedText(item);
      extractStatus = extracted.status;
      if (extracted.text) {
        excerpt = extracted.text.slice(0, PROJECT_EVENT_BODY_MAX_CHARS);
        extractTruncated = extracted.text.length > PROJECT_EVENT_BODY_MAX_CHARS;
      }
    } catch (err) {
      extractStatus = "error";
      console.warn(`[ProjectDocumentImporter] 内容抽取失败 ${item.id}：`, err);
    }

    let event: ProjectEventDto;
    try {
      event = this.ingestor.ingest(projectId, {
        source: "document",
        kind: "note",
        title: basename(path).slice(0, PROJECT_EVENT_TITLE_MAX_CHARS),
        body: excerpt,
        ref: hash,
        payload: {
          libraryItemId: item.id,
          sizeBytes: st.size,
          extractStatus: extractStatus ?? "pending",
          extractTruncated,
        },
      });
    } catch (error) {
      this.rollbackImportOrThrow(projectId, resolved, item, error);
      throw error;
    }

    // Another async importer may have created the durable event while this one was extracting.
    // In that case ingest() returns the winner event. Keep only the item referenced by that event.
    const durableItemId = typeof event.payload?.libraryItemId === "string" ? event.payload.libraryItemId : undefined;
    if (durableItemId !== item.id) {
      this.rollbackImportOrThrow(
        projectId,
        resolved,
        item,
        new Error(`同文件导入已由另一执行完成：event=${event.id}`),
      );
      return {
        event,
        item: durableItemId ? this.library.getItem(durableItemId) : null,
        reused: true,
      };
    }
    return { event, item, reused: false };
  }

  private rollbackImportOrThrow(
    projectId: string,
    resolved: ProjectLibrarySpaceResolution,
    item: LibraryItemDto | undefined,
    originalError: unknown,
  ): void {
    try {
      if (item && this.library.getItem(item.id)) this.library.deleteItem(item.id);
      if (resolved.created) this.deleteProjectLibrarySpaceIfEmpty(resolved.space.id);
    } catch (rollbackError) {
      throw new ProjectDocumentImportPartialStateError(
        projectId,
        item?.id,
        resolved.space.id,
        originalError instanceof Error ? originalError.message : String(originalError),
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      );
    }
  }
  /** 项目资料空间：已有则复用；本次惰性创建则标记 ownership，失败时只删除本次空空间。 */
  private resolveProjectLibrarySpace(project: { id: string; name?: string }): ProjectLibrarySpaceResolution {
    const spaces = this.library.listProjectSpaces(project.id);
    if (spaces.length > 0) return { space: spaces[0]!, created: false };
    return {
      space: this.library.createSpace({ name: `${project.name ?? "项目"}·项目资料`, projectId: project.id }),
      created: true,
    };
  }

  private deleteProjectLibrarySpaceIfEmpty(spaceId: string): void {
    if (this.library.listItems(spaceId).length > 0) return;
    if (this.library.listCollections(spaceId).length > 0) return;
    if (this.library.getSpace(spaceId)) this.library.deleteSpace(spaceId);
  }
}
