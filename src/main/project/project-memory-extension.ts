/**
 * ProjectMemoryExtension — 项目共享长期认知（Project Memory）的 Agent 结构化读写工具。
 *
 * 定位：Project Memory 是统一 Memory Kernel 中的项目级长期共享状态（人/Agent 共同维护的结构化
 * 条目：事实/决策/约束/风险/待确认）。绑定同一项目的所有 Agent Task 通过本组工具读取/沉淀
 * 同一份认知，任务间不共享聊天历史，以 Memory + Plan 接力。工具自动从当前任务解析 projectId
 * （作用域=本项目），不接受 Agent 指定任意 projectId；未绑定项目的任务返回受控错误。
 *
 * 设计约束（与 Project Plan 工具一致）：
 * - 只提供 list/get/create/update，不暴露 delete（废弃用 status=superseded/resolved 表达）；
 * - 全部为结构化单项操作（复用 ProjectService 校验与事务），绝无整表覆盖；
 * - readonly 权限模式/归档项目禁止写入（与人类 UI 一致）；
 * - 来源自动注入：Agent 写入自动带 sourceType=agent + 当前 taskId，不接受 Agent 伪造；
 * - 与聊天摘要/Plan/Resources 分工由 prompt 段明确，本工具只做结构化条目操作。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import {
  formatProjectMemoryLine,
  PROJECT_MEMORY_CONTENT_MAX_CHARS,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_MAX_TAGS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_TAG_MAX_CHARS,
  PROJECT_MEMORY_TITLE_MAX_CHARS,
  type ProjectMemoryCreateRequest,
  type ProjectMemoryItemDto,
  type ProjectMemoryKind,
  type ProjectMemoryStatus,
  type ProjectMemoryUpdateRequest,
} from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";

export interface ProjectMemoryExtensionBridge {
  taskId: string;
  /** 工具调用时解析当前任务绑定的 projectId（动态；null = 未绑定项目） */
  resolveProjectId: () => string | null;
  service: ProjectService;
  /** 当前权限模式（readonly 禁止写入；缺省视为非 readonly） */
  getPermissionMode?: () => PermissionMode;
}

class ProjectMemoryToolError extends Error {}

const KIND_LABEL: Record<ProjectMemoryKind, string> = {
  fact: "事实",
  decision: "决策",
  constraint: "约束",
  risk: "风险",
  open_question: "待确认",
  progress: "进度",
};
const STATUS_LABEL: Record<ProjectMemoryStatus, string> = {
  active: "有效",
  superseded: "已取代",
  resolved: "已解决",
};

const memoryKindSchema = Type.Union(
  PROJECT_MEMORY_KINDS.map((kind) => Type.Literal(kind)) as [
    ReturnType<typeof Type.Literal>,
    ...ReturnType<typeof Type.Literal>[],
  ],
);
const memoryStatusSchema = Type.Union(
  PROJECT_MEMORY_STATUSES.map((status) => Type.Literal(status)) as [
    ReturnType<typeof Type.Literal>,
    ...ReturnType<typeof Type.Literal>[],
  ],
);
const nullableTextSchema = Type.Union([Type.String(), Type.Null()]);

const listParamsSchema = Type.Object(
  {
    kind: Type.Optional(memoryKindSchema),
    status: Type.Optional(memoryStatusSchema),
    query: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

const getParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const createParamsSchema = Type.Object(
  {
    kind: memoryKindSchema,
    title: Type.String({ minLength: 1, maxLength: PROJECT_MEMORY_TITLE_MAX_CHARS }),
    content: Type.Optional(Type.String({ maxLength: PROJECT_MEMORY_CONTENT_MAX_CHARS })),
    status: Type.Optional(memoryStatusSchema),
    tags: Type.Optional(
      Type.Array(Type.String({ maxLength: PROJECT_MEMORY_TAG_MAX_CHARS }), {
        maxItems: PROJECT_MEMORY_MAX_TAGS,
      }),
    ),
    importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    /** 证据：library 条目 id（须属于 personal 或当前项目；跨项目由 service 拒绝） */
    evidenceItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 })),
    /** 证据：任务产物 id（仅记录引用；删除后 evidence missing，memory 保留） */
    evidenceArtifactIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 })),
  },
  { additionalProperties: false },
);

const updateParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    kind: Type.Optional(memoryKindSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_MEMORY_TITLE_MAX_CHARS })),
    content: Type.Optional(nullableTextSchema),
    status: Type.Optional(memoryStatusSchema),
    tags: Type.Optional(
      Type.Array(Type.String({ maxLength: PROJECT_MEMORY_TAG_MAX_CHARS }), {
        maxItems: PROJECT_MEMORY_MAX_TAGS,
      }),
    ),
  },
  { additionalProperties: false },
);

interface PlanListParams {
  kind?: ProjectMemoryKind;
  status?: ProjectMemoryStatus;
  query?: string;
  limit?: number;
}
interface PlanGetParams {
  id: string;
}
interface PlanCreateParams {
  kind: ProjectMemoryKind;
  title: string;
  content?: string;
  status?: ProjectMemoryStatus;
  tags?: string[];
  importance?: number;
  evidenceItemIds?: string[];
  evidenceArtifactIds?: string[];
}
interface PlanUpdateParams {
  id: string;
  kind?: ProjectMemoryKind;
  title?: string;
  content?: string | null;
  status?: ProjectMemoryStatus;
  tags?: string[];
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof ProjectMemoryToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_memory] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

export function createProjectMemoryExtension(bridge: ProjectMemoryExtensionBridge): ExtensionFactory {
  const requireProject = (): string => {
    const projectId = bridge.resolveProjectId();
    if (!projectId) {
      throw new ProjectMemoryToolError(
        "当前任务未绑定任何项目，无法访问项目共享记忆。请在项目页把任务关联到项目，或在项目内新建任务。",
      );
    }
    return projectId;
  };

  /** 写操作门禁：readonly 权限 / 归档项目 一律拒绝（与人类 UI 一致），读操作不受影响 */
  const guardWritable = (projectId: string): void => {
    if (bridge.getPermissionMode?.() === "readonly") {
      throw new ProjectMemoryToolError("当前为只读权限模式，不能修改项目共享记忆（只可读取）。");
    }
    const project = bridge.service.get(projectId);
    if (project?.archived) {
      throw new ProjectMemoryToolError(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
  };

  /** 作用域校验：条目必须属于当前任务所在项目（防跨项目猜 id 读写） */
  const requireScopedMemory = (projectId: string, id: string): ProjectMemoryItemDto => {
    const item = bridge.service.getMemory(projectId, id);
    if (!item) throw new ProjectMemoryToolError(`记忆条目不存在：${id}`);
    if (item.projectId !== projectId) {
      throw new ProjectMemoryToolError("该记忆条目不属于当前任务所在项目，无法访问。");
    }
    return item;
  };

  const projectLabel = (projectId: string): string =>
    bridge.service.get(projectId)?.name ?? projectId;

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_memory_list",
      label: "项目共享记忆 · 读取列表",
      description:
        "读取当前任务所在项目的共享长期记忆完整列表（数据库实时状态）。作用域自动取当前任务绑定的项目，不接受 projectId 参数。返回按更新时间倒序的条目（类型/状态/标题/内容/标签/来源任务/id）。可传 kind（fact/decision/constraint/risk/open_question）、status（active/superseded/resolved）过滤、query 搜标题与内容、limit 截断。项目共享记忆是所有绑定本项目的任务共用的长期认知（事实/决策/约束/风险/待确认），不同于项目计划或当前任务执行计划。",
      promptSnippet: "project_memory_list(kind?, status?, query?, limit?) — 读取当前项目共享长期记忆（数据库实时）",
      parameters: listParamsSchema,
      execute: async (_toolCallId: string, params: PlanListParams) => {
        try {
          const projectId = requireProject();
          const items = bridge.service.listMemory(projectId);
          let filtered = items;
          if (params.kind) filtered = filtered.filter((item) => item.kind === params.kind);
          if (params.status) filtered = filtered.filter((item) => item.status === params.status);
          const query = params.query?.trim().toLowerCase();
          if (query) {
            filtered = filtered.filter(
              (item) =>
                item.title.toLowerCase().includes(query) ||
                item.content.toLowerCase().includes(query),
            );
          }
          const page = filtered.slice(0, params.limit ?? 100);
          const lines = [
            `项目共享记忆（列出 ${page.length}/${filtered.length} 项，作用域：当前任务所属项目「${projectLabel(projectId)}」）：`,
            ...page.map((item) => formatProjectMemoryLine(item, 200)),
            page.length < filtered.length
              ? `（还有 ${filtered.length - page.length} 项未列出；可用 kind/status/query 缩小范围或增大 limit）`
              : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), {
            projectId,
            count: page.length,
            total: filtered.length,
            items: page,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_memory_get",
      label: "项目共享记忆 · 读取单项",
      description:
        "按 id 读取当前任务所在项目共享记忆中的单个条目最新状态（数据库实时，含完整内容与来源）。作用域自动取当前任务绑定的项目；不属于当前项目的 id 返回受控错误。",
      promptSnippet: "project_memory_get(id) — 读取单条项目记忆的完整内容",
      parameters: getParamsSchema,
      execute: async (_toolCallId: string, params: PlanGetParams) => {
        try {
          const projectId = requireProject();
          const item = requireScopedMemory(projectId, params.id);
          const lines = [
            formatProjectMemoryLine(item, 1000),
            `完整内容：${item.content || "（无）"}`,
            `类型：${KIND_LABEL[item.kind]}（${item.kind}）｜状态：${STATUS_LABEL[item.status]}（${item.status}）`,
            `来源：${item.sourceType}${item.sourceTaskId ? `（任务 ${item.sourceTaskId}）` : ""}｜创建 ${new Date(item.createdAt).toISOString()}｜更新 ${new Date(item.updatedAt).toISOString()}`,
          ];
          return textResult(lines.join("\n"), { projectId, item });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_memory_create",
      label: "项目共享记忆 · 沉淀新条目",
      description:
        "在当前任务所属项目的共享长期记忆中新增一个结构化条目（事实/决策/约束/风险/待确认；所有绑定本项目的任务可见）。作用域自动取当前任务绑定的项目。来源自动记录为当前 Agent 任务，不接受伪造。readonly 权限模式或归档项目下不可用。只写长期有价值的信息：不要把每轮聊天总结、瞬时进度、执行步骤、原始文件全文塞进 Memory。",
      promptSnippet: "project_memory_create(kind, title, content?, status?, tags?) — 沉淀项目长期事实/决策/约束/风险/待确认",
      parameters: createParamsSchema,
      execute: async (_toolCallId: string, params: PlanCreateParams) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const request: ProjectMemoryCreateRequest = {
            projectId,
            kind: params.kind,
            title: params.title,
          };
          if (params.content !== undefined) request.content = params.content;
          if (params.status !== undefined) request.status = params.status;
          if (params.tags !== undefined) request.tags = params.tags;
          if (params.importance !== undefined) request.importance = params.importance;
          if (params.evidenceItemIds !== undefined) request.evidenceItemIds = params.evidenceItemIds;
          if (params.evidenceArtifactIds !== undefined) request.evidenceArtifactIds = params.evidenceArtifactIds;
          const created = bridge.service.createMemory(request, {
            sourceType: "agent",
            sourceTaskId: bridge.taskId,
          });
          const evidenceNote =
            created.evidence.length > 0
              ? `\n证据：${created.evidence.map((e) => `${e.evidenceKind}:${e.refId}`).join(", ")}`
              : "";
          return textResult(
            `已沉淀记忆条目（id=${created.id}，项目「${projectLabel(projectId)}」）：\n${formatProjectMemoryLine(created, 200)}${evidenceNote}`,
            { projectId, item: created },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_memory_search",
      label: "项目共享记忆 · 搜索",
      description:
        "在项目共享记忆中搜索（标题/正文，active 条目；按重要度优先）。返回条目 id 与摘要，需要完整内容用 project_memory_get。作用域自动取当前任务绑定的项目。",
      promptSnippet: "project_memory_search(query, limit?) — 搜索项目记忆（重要度优先）",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
        try {
          const projectId = requireProject();
          const items = bridge.service.searchMemory(projectId, params.query, params.limit ?? 10);
          const lines = [
            `项目记忆搜索「${params.query}」（${items.length} 条）：`,
            ...items.map((item) => formatProjectMemoryLine(item, 200)),
            items.length === 0 ? "（无匹配）" : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), { projectId, count: items.length });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_memory_update",
      label: "项目共享记忆 · 单项更新",
      description:
        "结构化单项更新当前任务所属项目共享记忆中的一个条目（类型/标题/内容/状态/标签）。作用域自动取当前任务绑定的项目；不属于当前项目的 id 返回受控错误。只 patch 传入的字段，其余字段保持不变；传 null 可清除 content。状态变更语义：信息已过时/被取代 → superseded；问题已解决 → resolved；不要硬删（本会话无删除权限）。readonly 权限模式或归档项目下不可用。",
      promptSnippet: "project_memory_update(id, status?, kind?, title?, content?, tags?) — 单项 patch 项目记忆（保留可追溯变化）",
      parameters: updateParamsSchema,
      execute: async (_toolCallId: string, params: PlanUpdateParams) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const existing = requireScopedMemory(projectId, params.id);
          const request: ProjectMemoryUpdateRequest = { projectId, id: params.id };
          if (params.kind !== undefined) request.kind = params.kind;
          if (params.title !== undefined) request.title = params.title;
          if (params.content !== undefined) request.content = params.content;
          if (params.status !== undefined) request.status = params.status;
          if (params.tags !== undefined) request.tags = params.tags;
          const updated = bridge.service.updateMemory(request);
          return textResult(
            `已更新记忆条目（${existing.title}${existing.title !== updated.title ? ` → ${updated.title}` : ""}）：\n${formatProjectMemoryLine(updated, 200)}`,
            { projectId, item: updated },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}


