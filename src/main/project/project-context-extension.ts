/**
 * ProjectContextExtension — Project Shared Context 的 Agent 工具（最小领域面）。
 *
 * 语义（冻结）：Shared Context = 项目长期显式配置（goal/currentStage）+ 高优先级资料引用
 * （pinned library refs，只引用不复制）；Memory = 提炼认知；Library = evidence 真源。
 * 作用域一律由当前 task 的统一资料范围解析，拒绝跨项目直接 id 访问；
 * readonly 权限模式/归档项目禁止写入（与 project_memory_* 同门禁）。
 *
 * 工具：project_context_get / project_context_update / project_context_pin /
 * project_context_unpin。instructions 不在 Agent 写面（由用户项目设置维护）。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import {
  PROJECT_CONTEXT_GOAL_MAX_CHARS,
  PROJECT_CONTEXT_STAGE_MAX_CHARS,
  type ProjectSharedContextSummary,
} from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";
import type { LibraryService } from "../library/LibraryService";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";

export interface ProjectContextExtensionBridge {
  projectService: ProjectService;
  libraryService: LibraryService;
  taskId: string;
  /** 当前权限模式（readonly 禁止写入；缺省视为非 readonly） */
  getPermissionMode?: () => PermissionMode;
}

class ContextToolError extends Error {}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof ContextToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_context] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

function clip(text: string | null | undefined, max: number): string {
  const t = text?.trim() ?? "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function renderContext(summary: ProjectSharedContextSummary): string {
  const lines = [
    "## 项目上下文（当前任务所属项目）",
    summary.goal ? `- 项目目标：${clip(summary.goal, PROJECT_CONTEXT_GOAL_MAX_CHARS)}` : "- 项目目标：（未设置）",
    summary.currentStage
      ? `- 当前阶段：${clip(summary.currentStage, PROJECT_CONTEXT_STAGE_MAX_CHARS)}`
      : "- 当前阶段：（未设置）",
  ];
  if (summary.instructions) {
    lines.push(`- 项目长期指令（用户维护，仅摘要）：${clip(summary.instructions, 300)}`);
  }
  if (summary.pinned.length > 0) {
    lines.push("固定资料（pinned，只引用不复制；需要内容时用 library_read 读取文本类，二进制/办公类走受管路径）：");
    for (const pin of summary.pinned) {
      lines.push(`- [${pin.itemKind ?? "item"}] ${clip(pin.itemTitle ?? pin.itemId, 100)} · id=${pin.itemId}`);
    }
  } else {
    lines.push("固定资料：（无）");
  }
  lines.push("本工具只读；修改请用 project_context_update；固定/解除资料用 project_context_pin / project_context_unpin。");
  return lines.join("\n");
}

export function createProjectContextExtension(bridge: ProjectContextExtensionBridge): ExtensionFactory {
  const service = bridge.projectService;
  const library = bridge.libraryService;

  const requireProject = (): string => {
    const projectId = library.resolveTaskScope(bridge.taskId).projectId;
    if (!projectId) {
      throw new ContextToolError(
        "当前任务未绑定任何项目，无法访问项目上下文。请在项目页把任务关联到项目。",
      );
    }
    return projectId;
  };

  const visibleSummary = (summary: ProjectSharedContextSummary): ProjectSharedContextSummary => {
    const scope = library.resolveTaskScope(bridge.taskId);
    return {
      ...summary,
      pinned: summary.pinned.filter((pin) => {
        const item = library.getItem(pin.itemId);
        return item !== null && library.isItemVisibleInScope(item, scope);
      }),
    };
  };

  /** 写操作门禁：readonly 权限 / 归档项目 一律拒绝（与 project_memory_* 一致） */
  const guardWritable = (projectId: string): void => {
    if (bridge.getPermissionMode?.() === "readonly") {
      throw new ContextToolError("当前为只读权限模式，不能修改项目上下文（只可读取）。");
    }
    const project = service.get(projectId);
    if (project?.archived) {
      throw new ContextToolError(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
  };

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_context_get",
      label: "项目上下文 · 读取",
      description:
        "读取当前任务所属项目的长期显式上下文（目标/当前阶段/长期指令摘要 + 固定资料引用列表）。作用域自动取任务绑定的项目；未绑定任务报错。固定资料只给标题/id/类型（引用元数据，不注入全文），需要内容时用 library_read 或文件工具读取。",
      promptSnippet: "project_context_get() — 读取当前项目的长期显式上下文（目标/阶段/固定资料引用）",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        try {
          const projectId = requireProject();
          const summary = visibleSummary(service.getSharedContext(projectId));
          return textResult(renderContext(summary), { projectId, summary });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_context_update",
      label: "项目上下文 · 更新目标/阶段",
      description:
        `局部更新当前项目上下文的「项目目标」（≤${PROJECT_CONTEXT_GOAL_MAX_CHARS} 字符）与「当前阶段」（≤${PROJECT_CONTEXT_STAGE_MAX_CHARS} 字符）。传 null 清空对应字段；不传的字段保持不变。长期指令（instructions）由用户项目设置维护，不在本工具写面。readonly 权限或归档项目下不可用。`,
      promptSnippet: "project_context_update(goal?, currentStage?) — 更新项目目标/当前阶段（显式长期配置）",
      parameters: Type.Object(
        {
          goal: Type.Optional(Type.Union([Type.String({ maxLength: PROJECT_CONTEXT_GOAL_MAX_CHARS }), Type.Null()])),
          currentStage: Type.Optional(Type.Union([Type.String({ maxLength: PROJECT_CONTEXT_STAGE_MAX_CHARS }), Type.Null()])),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { goal?: string | null; currentStage?: string | null }) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const patch: { goal?: string | null; currentStage?: string | null } = {};
          if (params.goal !== undefined) patch.goal = params.goal;
          if (params.currentStage !== undefined) patch.currentStage = params.currentStage;
          const summary = visibleSummary(service.updateSharedContext(projectId, patch));
          return textResult(`已更新项目上下文（id=${projectId}）。\n${renderContext(summary)}`, { projectId, summary });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_context_pin",
      label: "项目上下文 · 固定资料",
      description:
        `把当前项目可见的资料条目固定到项目上下文（pinned ref，只引用不复制文件/全文）。只接受当前任务已可见的条目；个人或其他工作空间的资料须先由用户显式引用，不能用此工具自行扩大资料范围。跨项目条目拒绝。readonly 权限或归档项目下不可用。`,
      promptSnippet: "project_context_pin(itemId) — 固定资料到项目上下文（引用元数据）",
      parameters: Type.Object(
        { itemId: Type.String({ minLength: 1, maxLength: 100 }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { itemId: string }) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const item = library.getItem(params.itemId);
          if (!item || !library.isItemVisibleInScope(item, library.resolveTaskScope(bridge.taskId))) {
            throw new ContextToolError("资料不存在或当前任务不可见；未引用的个人/工作空间资料和跨项目资料不能固定。");
          }
          const pin = service.pinProjectItem({ projectId, itemId: params.itemId });
          return textResult(
            `已固定资料（id=${params.itemId}）到项目 ${projectId} 的上下文。`,
            { projectId, pin },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_context_unpin",
      label: "项目上下文 · 解除固定",
      description: "解除之前固定到当前项目上下文的资料引用（不影响资料库条目本身）。",
      promptSnippet: "project_context_unpin(itemId) — 解除项目固定资料引用",
      parameters: Type.Object(
        { itemId: Type.String({ minLength: 1, maxLength: 100 }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { itemId: string }) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          service.unpinProjectItem({ projectId, itemId: params.itemId });
          return textResult(`已解除固定（id=${params.itemId}）。`);
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}

