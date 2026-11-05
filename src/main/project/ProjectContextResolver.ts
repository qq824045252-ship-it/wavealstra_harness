import type {
  ProjectDetailsDto,
  ProjectPlanSummaryDto,
  ProjectResourceHealthDto,
  ProjectResourceInspectionDto,
  ProjectSharedContextSummary,
  ProjectTodoDto,
  ProjectTodoStatus,
  ResolvedProjectContext,
  ResolvedProjectResource,
} from "../../shared/project-domain";
import {
  formatProjectTodoLine,
  PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS,
  PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS,
} from "../../shared/project-domain";
import type { AppDatabase } from "../db/AppDatabase";
import type { ProjectRepository } from "./ProjectRepository";
import type { MemoryService } from "../memory/MemoryService";
import { readFileSync, statSync } from "node:fs";

/** active slice 排序：先 doing，再高优先，再临近截止，最后更新时间（供上下文摘要用） */
const PLAN_STATUS_RANK: Record<ProjectTodoStatus, number> = { doing: 0, paused: 1, todo: 2, done: 3 };
const PLAN_PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function rankForPlanActiveSlice(todo: ProjectTodoDto): number {
  return PLAN_STATUS_RANK[todo.status] * 10 + (todo.priority ? PLAN_PRIORITY_RANK[todo.priority] ?? 3 : 3);
}

interface ResolvedResources {
  resources: ResolvedProjectResource[];
  warnings: string[];
  inspection: ProjectResourceInspectionDto;
}

/** Single main-process entry for resolving a Task's long-lived Project context. */
export class ProjectContextResolver {
  constructor(
    private readonly db: AppDatabase,
    private readonly projects: ProjectRepository,
    _memoryService: MemoryService,
  ) {}

  resolveTask(taskId: string): ResolvedProjectContext | null {
    const projectId = this.db.getTask(taskId)?.projectId;
    return projectId ? this.resolveProject(projectId) : null;
  }

  /** Recheck revocation without rereading resource file contents during a frozen turn. */
  assertEvidenceAvailable(projectId: string, resourceIds: readonly string[] = [], pinIds: readonly string[] = []): void {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("本轮引用的项目已移除");
    if (resourceIds.some((id) => !project.resources.some((resource) => resource.id === id && resource.enabled))) {
      throw new Error("本轮引用的项目资源已移除或停用");
    }
    if (pinIds.length) {
      const pins = new Set(this.projects.listPins(projectId).map((pin) => pin.itemId));
      if (pinIds.some((id) => !pins.has(id))) throw new Error("本轮引用的项目固定资料已移除");
    }
  }

  resolveProject(projectId: string): ResolvedProjectContext | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    // Archived Projects remain a dynamic context source for Tasks that were
    // already bound. Archive only hides the Project and blocks new bindings.
    const { policies, resources: _storedResources, ...summary } = project;
    const resolved = this.resolveResources(project);
    return {
      project: summary,
      instructions: project.instructions?.trim() || null,
      policies,
      resources: resolved.resources,
      resourceWarnings: resolved.warnings,
      planSummary: this.buildPlanSummary(project.id),
      sharedContext: this.buildSharedContext(project.id),
      version: `${project.id}:${project.updatedAt}`,
      source: "project",
      sourceId: project.id,
    };
  }

  /** Shared Context 摘要：goal/currentStage（显式字段）+ pinned library refs（只引用不复制） */
  private buildSharedContext(projectId: string): ProjectSharedContextSummary | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    return {
      projectId,
      goal: project.goal?.trim() || null,
      currentStage: project.currentStage?.trim() || null,
      instructions: project.instructions?.trim() || null,
      pinned: this.projects.listPins(projectId),
    };
  }

  inspectProjectResources(projectId: string): ProjectResourceInspectionDto | null {
    const project = this.projects.get(projectId);
    return project ? this.resolveResources(project).inspection : null;
  }

  /**
   * 项目共享计划轻量摘要：每次 resolve 时从 DB 现读（保证同项目后续 Task/会话拿到最新），
   * 只输出状态计数 + 预算内 active slice（doing/高优先/临近截止，不含 done），
   * 绝不把全量计划塞入上下文。
   */
  private buildPlanSummary(projectId: string): ProjectPlanSummaryDto {
    const todos = this.projects.listTodos(projectId);
    const byStatus: Record<ProjectTodoStatus, number> = { todo: 0, doing: 0, paused: 0, done: 0 };
    for (const todo of todos) byStatus[todo.status] += 1;
    const active: ProjectTodoDto[] = [];
    let includedChars = 0;
    const candidates = todos
      .filter((todo) => todo.status !== "done")
      .sort(
        (left, right) =>
          rankForPlanActiveSlice(left) - rankForPlanActiveSlice(right) ||
          (left.dueAt ?? Number.POSITIVE_INFINITY) - (right.dueAt ?? Number.POSITIVE_INFINITY) ||
          right.updatedAt - left.updatedAt,
      );
    for (const todo of candidates) {
      if (active.length >= PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS) break;
      const line = formatProjectTodoLine(todo);
      // 单条超预算（超长 title/负责人等）：跳过该项，继续寻找能放入预算的后续项，
      // 绝不让一条超长项 break 掉整个 slice（doing/高优先项因此全部消失）。
      if (includedChars + line.length > PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS) continue;
      includedChars += line.length;
      active.push(todo);
    }
    return {
      projectId,
      total: todos.length,
      byStatus,
      active,
      budget: {
        maxItems: PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS,
        maxChars: PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS,
        includedChars,
      },
    };
  }

  /**
   * Resolve explicitly configured Project resources; reject non-text files.
   */
  private resolveResources(project: ProjectDetailsDto): ResolvedResources {
    const resources: ResolvedProjectResource[] = [];
    const warnings: string[] = [];
    const items: ProjectResourceHealthDto[] = [];
    let includedChars = 0;
    for (const resource of project.resources) {
      if (resource.kind === "folder") {
        items.push({ resourceId: resource.id, status: "ready", included: false, chars: 0 });
        continue;
      }
      if (!resource.enabled) {
        items.push({ resourceId: resource.id, status: "disabled", included: false, chars: 0, reason: "资源已停用" });
        continue;
      }
      try {
        let content: string;
        let bytes: number | undefined;
        if (resource.kind === "text") content = resource.value;
        else if (resource.kind === "url") content = `参考 URL：${resource.value}`;
        else {
          let stat;
          try { stat = statSync(resource.value); } catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            const status = code === "ENOENT" ? "missing" : "unreadable";
            const reason = code === "ENOENT" ? "文件不存在" : "文件不可读取";
            items.push({ resourceId: resource.id, status, included: false, chars: 0, reason });
            warnings.push(`项目资源「${resource.title}」未加载：${reason}`);
            continue;
          }
          if (!stat.isFile()) {
            items.push({ resourceId: resource.id, status: "unreadable", included: false, chars: 0, reason: "路径不是文件" });
            warnings.push(`项目资源「${resource.title}」未加载：路径不是文件`);
            continue;
          }
          bytes = stat.size;
          const buffer = readFileSync(resource.value);
          if (buffer.subarray(0, 8192).includes(0)) {
            const reason = "检测到二进制文件";
            items.push({ resourceId: resource.id, status: "binary", included: false, chars: 0, bytes, reason });
            warnings.push(`项目资源「${resource.title}」未加载：${reason}`);
            continue;
          }
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          } catch {
            const reason = "文件不是有效 UTF-8 文本";
            items.push({ resourceId: resource.id, status: "binary", included: false, chars: 0, bytes, reason });
            warnings.push(`项目资源「${resource.title}」未加载：${reason}`);
            continue;
          }
        }
        includedChars += content.length;
        resources.push({
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          content,
          source: "project-resource" as const,
          sourceId: resource.id,
        });
        items.push({ resourceId: resource.id, status: "ready", included: true, chars: content.length, bytes });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        items.push({ resourceId: resource.id, status: "unreadable", included: false, chars: 0, reason });
        warnings.push(`项目资源「${resource.title}」未加载：${reason}`);
      }
    }
    return {
      resources,
      warnings,
      inspection: {
        projectId: project.id,
        budgetChars: project.resourceBudgetChars,
        includedChars,
        checkedAt: Date.now(),
        items,
      },
    };
  }
}
