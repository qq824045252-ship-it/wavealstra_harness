/**
 * ProjectEventPromoter — 事件显式提升（Event Triage / Promotion Loop）。
 *
 * 语义：external event 只是输入/审计层；要进入项目真源（Memory / Plan-Todo / Library），
 * 必须由人（UI）或 Agent（显式工具）触发 promotion。本模块是唯一提升入口：
 * - 目标项目 = 事件所属项目（只接受 eventId，不接受 projectId —— A/B 越权按构造不可能）；
 * - 写真源一律走既有 service（createMemory / createTodo / LibraryService createItem+writeContent），
 *   禁止 SQL 绕过；content/title 全部由调用方显式给出，绝不猜测；
 * - 幂等：每 (project, event, targetKind) 至多一个目标；重复 promote 返回既有目标（reused），
 *   DB UNIQUE 兜底；目标已被删除 → 不新建、返回 targetMissing 降级；
 * - 归档项目拒绝写入（ARCHIVED_PROJECT_WRITE_GUIDANCE）；事件仍可读；
 * - provenance：project_event_promotions 链接表（事件 → 目标，双向可查；无 event FK，
 *   事件滚动淘汰不影响链接与目标）+ memory evidence kind=event（目标侧可溯源码事件）；
 * - readonly 权限模式由 Agent 工具层拦截（与既有项目写工具一致）。
 */
import { randomUUID } from "node:crypto";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE, type ProjectEventDto, type ProjectEventPromoteRequest, type ProjectEventPromoteResultDto, type ProjectEventPromotionDto, type ProjectEventPromotionTargetKind } from "../../shared/project-domain";
import type { LibraryService } from "../library/LibraryService";
import type { ProjectService } from "./ProjectService";

export class ProjectEventPromotionPartialStateError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly eventId: string,
    public readonly targetKind: ProjectEventPromotionTargetKind,
    public readonly targetId: string,
    public readonly originalMessage: string,
    public readonly rollbackMessage: string,
  ) {
    super(
      `项目事件提升失败且目标回滚不完整：${originalMessage}；` +
      `残留 ${targetKind}=${targetId}；rollback=${rollbackMessage}`,
    );
    this.name = "ProjectEventPromotionPartialStateError";
  }
}

interface CreatedPromotionTarget {
  targetId: string;
  targetTitle?: string;
  rollback(): void;
}
export interface ProjectEventPromoterOptions {
  now?: () => number;
}

export class ProjectEventPromoter {
  private readonly now: () => number;

  constructor(
    private readonly projects: ProjectService,
    private readonly library: LibraryService,
    opts: ProjectEventPromoterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 统一提升入口（IPC/Agent 工具共用）。校验顺序：
   * 事件存在 → 项目存在 → 归档门禁 → 幂等复用 → 字段齐全 → 既有 service 落真源 → 记录审计链接。
   * agent 参数仅由 Agent 工具层注入（taskId 溯源），IPC/UI 不传；promotedBy=agent 且带 taskId 时写入真源来源。
   */
  promote(
    eventId: string,
    request: Omit<ProjectEventPromoteRequest, "eventId">,
    agent?: { taskId?: string },
  ): ProjectEventPromoteResultDto {
    if (!request || !["memory", "todo", "library"].includes(request.targetKind as string)) {
      throw new Error(`不支持的提升目标：${String((request as { targetKind?: unknown } | undefined)?.targetKind)}`);
    }
    const event = this.projects.getProjectEvent(eventId);
    if (!event) throw new Error(`事件不存在：${eventId}`);
    const project = this.projects.get(event.projectId);
    if (!project) throw new Error(`项目不存在：${event.projectId}`);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);

    // 幂等：同 (event, targetKind) 已提升 → 复用（目标已删则降级返回，不新建垃圾）
    const existing = this.projects.findProjectEventPromotion(event.projectId, eventId, request.targetKind);
    if (existing) {
      return {
        promotion: existing,
        targetKind: existing.targetKind,
        targetId: existing.targetId,
        targetTitle: existing.targetTitle,
        reused: true,
        targetMissing: this.resolveTarget(event.projectId, existing.targetKind, existing.targetId) === undefined,
      };
    }

    // 提升主体归一：仅接受显式 agent（工具层注入）；其余一律按 user（UI/IPC，不可伪造）
    const promotedBy = request.promotedBy === "agent" ? ("agent" as const) : ("user" as const);
    const created = this.createTarget(event, request, promotedBy, agent?.taskId);
    const intendedPromotion: ProjectEventPromotionDto = {
      id: `pepr_${randomUUID()}`,
      projectId: event.projectId,
      eventId: event.id,
      eventTitle: event.title,
      targetKind: request.targetKind,
      targetId: created.targetId,
      targetTitle: created.targetTitle,
      promotedBy,
      createdAt: this.now(),
    };

    let promotion: ProjectEventPromotionDto;
    try {
      promotion = this.projects.insertProjectEventPromotion(intendedPromotion);
    } catch (error) {
      this.rollbackCreatedTargetOrThrow(event, request.targetKind, created, error);
      throw error;
    }

    // Repository returns the durable existing row on UNIQUE conflict. If another writer won,
    // the target created by this attempt is not referenced and must be compensated immediately.
    if (promotion.id !== intendedPromotion.id || promotion.targetId !== created.targetId) {
      this.rollbackCreatedTargetOrThrow(
        event,
        request.targetKind,
        created,
        new Error(`提升链接已由另一执行写入：${promotion.id}`),
      );
      return {
        promotion,
        targetKind: promotion.targetKind,
        targetId: promotion.targetId,
        targetTitle: promotion.targetTitle,
        reused: true,
        targetMissing: this.resolveTarget(event.projectId, promotion.targetKind, promotion.targetId) === undefined,
      };
    }
    return {
      promotion,
      targetKind: request.targetKind,
      targetId: created.targetId,
      targetTitle: created.targetTitle,
      reused: false,
    };
  }

  private createTarget(
    event: ProjectEventDto,
    request: Omit<ProjectEventPromoteRequest, "eventId">,
    promotedBy: "user" | "agent",
    sourceTaskId?: string,
  ): CreatedPromotionTarget {
    switch (request.targetKind) {
      case "memory":
        return this.promoteToMemory(event, request, promotedBy, sourceTaskId);
      case "todo":
        return this.promoteToTodo(event, request);
      case "library":
        return this.promoteToLibrary(event, request);
      default:
        throw new Error(`不支持的提升目标：${String(request.targetKind)}`);
    }
  }

  private rollbackCreatedTargetOrThrow(
    event: ProjectEventDto,
    targetKind: ProjectEventPromotionTargetKind,
    created: CreatedPromotionTarget,
    originalError: unknown,
  ): void {
    try {
      created.rollback();
    } catch (rollbackError) {
      throw new ProjectEventPromotionPartialStateError(
        event.projectId,
        event.id,
        targetKind,
        created.targetId,
        originalError instanceof Error ? originalError.message : String(originalError),
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      );
    }
  }

  private promoteToMemory(
    event: ProjectEventDto,
    request: Omit<ProjectEventPromoteRequest, "eventId">,
    promotedBy: "user" | "agent",
    sourceTaskId?: string,
  ): CreatedPromotionTarget {
    if (!request.memoryKind) throw new Error("提升为记忆必须显式指定 memoryKind（fact/decision/constraint/risk/open_question）");
    if (!request.memoryTitle?.trim()) throw new Error("提升为记忆必须显式指定标题");
    const created = this.projects.createMemory(
      {
        projectId: event.projectId,
        kind: request.memoryKind,
        title: request.memoryTitle.trim(),
        content: request.memoryContent?.trim() || undefined,
        tags: request.memoryTags,
        importance: request.memoryImportance,
        evidenceEventId: event.id,
      },
      {
        sourceType: promotedBy === "agent" ? "agent" : "manual",
        sourceTaskId: promotedBy === "agent" ? sourceTaskId : undefined,
      },
    );
    return {
      targetId: created.id,
      targetTitle: created.title,
      rollback: () => this.projects.deleteMemory({ projectId: event.projectId, id: created.id }),
    };
  }

  private promoteToTodo(
    event: ProjectEventDto,
    request: Omit<ProjectEventPromoteRequest, "eventId">,
  ): CreatedPromotionTarget {
    if (!request.todoTitle?.trim()) throw new Error("提升为计划项必须显式指定标题");
    const created = this.projects.createTodo({
      projectId: event.projectId,
      title: request.todoTitle.trim(),
      description: request.todoDescription?.trim() || undefined,
      dueAt: request.todoDueAt,
      priority: request.todoPriority,
    });
    return {
      targetId: created.id,
      targetTitle: created.title,
      rollback: () => this.projects.deleteTodo(created.id),
    };
  }

  private promoteToLibrary(
    event: ProjectEventDto,
    request: Omit<ProjectEventPromoteRequest, "eventId">,
  ): CreatedPromotionTarget {
    if (typeof event.payload?.libraryItemId === "string") {
      throw new Error("该事件已关联资料库条目（文件导入），无需重复保存为资料；可提升为记忆或计划。");
    }
    if (!request.libraryTitle?.trim()) throw new Error("提升为资料必须显式指定标题");
    if (!request.libraryContent?.trim()) throw new Error("提升为资料必须显式指定正文");

    const resolved = this.resolveProjectLibrarySpace(event.projectId);
    let createdId: string | undefined;
    let createdTitle: string | undefined;
    try {
      const created = this.library.createItem({
        spaceId: resolved.space.id,
        collectionId: null,
        kind: "markdown",
        title: request.libraryTitle.trim(),
      });
      createdId = created.id;
      createdTitle = created.title;
      this.library.writeContent({ id: created.id, content: request.libraryContent.trim() });
    } catch (error) {
      try {
        if (createdId && this.library.getItem(createdId)) this.library.deleteItem(createdId);
        if (resolved.created) this.deleteProjectLibrarySpaceIfEmpty(resolved.space.id);
      } catch (rollbackError) {
        throw new ProjectEventPromotionPartialStateError(
          event.projectId,
          event.id,
          "library",
          createdId ?? resolved.space.id,
          error instanceof Error ? error.message : String(error),
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      throw error;
    }

    const targetId = createdId!;
    return {
      targetId,
      targetTitle: createdTitle,
      rollback: () => {
        if (this.library.getItem(targetId)) this.library.deleteItem(targetId);
        if (resolved.created) this.deleteProjectLibrarySpaceIfEmpty(resolved.space.id);
      },
    };
  }

  /** 项目资料空间：已有则取第一个；无则创建并标记 ownership，供本次失败时安全补偿。 */
  private resolveProjectLibrarySpace(projectId: string): ProjectLibrarySpaceResolution {
    const spaces = this.library.listProjectSpaces(projectId);
    if (spaces.length > 0) return { space: spaces[0]!, created: false };
    const project = this.projects.get(projectId);
    const name = `${project?.name ?? "项目"}·项目资料`;
    return { space: this.library.createSpace({ name, projectId }), created: true };
  }

  private deleteProjectLibrarySpaceIfEmpty(spaceId: string): void {
    if (this.library.listItems(spaceId).length > 0) return;
    if (this.library.listCollections(spaceId).length > 0) return;
    if (this.library.getSpace(spaceId)) this.library.deleteSpace(spaceId);
  }
  /** 目标存在性（幂等复用时的降级判断） */
  private resolveTarget(
    projectId: string,
    targetKind: ProjectEventPromotionTargetKind,
    targetId: string,
  ): unknown {
    switch (targetKind) {
      case "memory":
        return this.projects.getMemory(projectId, targetId);
      case "todo":
        return this.projects.getTodo(targetId);
      case "library":
        return this.library.getItem(targetId);
    }
  }
}

interface ProjectLibrarySpaceResolution {
  space: { id: string };
  created: boolean;
}
