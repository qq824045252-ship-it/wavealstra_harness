/**
 * ProjectPlanExtension — 项目共享计划的 Agent 结构化读写工具（pi extension factory）。
 *
 * 定位：Project Plan 是项目级共享 Agent 状态（project_todos 表，人维护的结构化数据）。
 * 绑定同一项目的所有 Agent Task 通过本组工具读取/更新同一份计划，任务间不共享聊天历史，
 * 以计划接力。工具自动从当前任务解析 projectId（作用域=本项目），不接受 Agent 指定
 * 任意 projectId；未绑定项目的任务返回受控错误（明确不可用）。
 *
 * 设计约束（与产品约定一致）：
 * - 只提供 list/get/create/update，不暴露 delete（避免 Agent 误删人工计划项）；
 * - 全部为结构化单项操作，复用 ProjectService 现有 CRUD（内部事务），绝无整表覆盖；
 * - 归档项目禁止写入（与人类 UI 行为一致）；
 * - 不建立 Todo↔Task 绑定：本扩展不读不写任何 taskId/todoId 关联；
 * - 日期入参接受毫秒时间戳或 "YYYY-MM-DD"（当地 0 点），见 parsePlanDateValue；
 * - 计划项属于 Project 的共享数据。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import {
  formatProjectTodoLine,
  parsePlanDateValue,
  PROJECT_TODO_TITLE_MAX_CHARS,
  type ProjectTodoCreateRequest,
  type ProjectTodoDto,
  type ProjectTodoPriority,
  type ProjectTodoStatus,
  type ProjectTodoUpdateRequest,
} from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";

export interface ProjectPlanExtensionBridge {
  taskId: string;
  /** 工具调用时解析当前任务绑定的 projectId（动态：任务改绑/解绑即时生效；null = 未绑定） */
  resolveProjectId: () => string | null;
  service: ProjectService;
  /** 旧调用方兼容字段，不再限制执行 */
  getPermissionMode?: () => PermissionMode;
}

class ProjectPlanToolError extends Error {}

const STATUS_LABEL: Record<ProjectTodoStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  paused: "已暂停",
  done: "已完成",
};

const todoStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doing"),
  Type.Literal("paused"),
  Type.Literal("done"),
]);
const todoPrioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
/** 日期入参：毫秒时间戳或 YYYY-MM-DD（当地 0 点） */
const dateInputSchema = Type.Union([Type.Number(), Type.String()]);
const nullableTextSchema = Type.Union([Type.String(), Type.Null()]);
const nullableDateSchema = Type.Union([Type.Number(), Type.String(), Type.Null()]);

const listParamsSchema = Type.Object(
  {
    status: Type.Optional(todoStatusSchema),
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
    title: Type.String({ minLength: 1, maxLength: PROJECT_TODO_TITLE_MAX_CHARS }),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    status: Type.Optional(todoStatusSchema),
    assignee: Type.Optional(Type.String({ maxLength: 100 })),
    priority: Type.Optional(todoPrioritySchema),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 60 }))),
    startAt: Type.Optional(dateInputSchema),
    dueAt: Type.Optional(dateInputSchema),
  },
  { additionalProperties: false },
);

const updateParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_TODO_TITLE_MAX_CHARS })),
    description: Type.Optional(nullableTextSchema),
    status: Type.Optional(todoStatusSchema),
    assignee: Type.Optional(nullableTextSchema),
    priority: Type.Optional(Type.Union([todoPrioritySchema, Type.Null()])),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 60 }))),
    startAt: Type.Optional(nullableDateSchema),
    dueAt: Type.Optional(nullableDateSchema),
  },
  { additionalProperties: false },
);

interface PlanListParams {
  status?: ProjectTodoStatus;
  query?: string;
  limit?: number;
}
interface PlanGetParams {
  id: string;
}
interface PlanCreateParams {
  title: string;
  description?: string;
  status?: ProjectTodoStatus;
  assignee?: string;
  priority?: ProjectTodoPriority;
  tags?: string[];
  startAt?: number | string;
  dueAt?: number | string;
}
interface PlanUpdateParams {
  id: string;
  title?: string;
  description?: string | null;
  status?: ProjectTodoStatus;
  assignee?: string | null;
  priority?: ProjectTodoPriority | null;
  tags?: string[];
  startAt?: number | string | null;
  dueAt?: number | string | null;
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof ProjectPlanToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_plan] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

export function createProjectPlanExtension(bridge: ProjectPlanExtensionBridge): ExtensionFactory {
  const requireProject = (): string => {
    const projectId = bridge.resolveProjectId();
    if (!projectId) {
      throw new ProjectPlanToolError(
        "当前任务未绑定任何项目，无法访问项目共享计划。请在项目页把任务关联到项目，或在项目内新建任务。",
      );
    }
    return projectId;
  };

  /** 写操作门禁：归档项目拒绝写入（与人类 UI 一致），读操作不受影响 */
  const guardWritable = (projectId: string): void => {
    const project = bridge.service.get(projectId);
    if (project?.archived) {
      throw new ProjectPlanToolError("项目已归档，不能修改其共享计划（只可读取）。");
    }
  };

  /** 作用域校验：计划项必须属于当前任务所在项目（防跨项目猜 id 读写） */
  const requireScopedTodo = (projectId: string, id: string): ProjectTodoDto => {
    const todo = bridge.service.getTodo(id);
    if (!todo) throw new ProjectPlanToolError(`计划项不存在：${id}`);
    if (todo.projectId !== projectId) {
      throw new ProjectPlanToolError("该计划项不属于当前任务所在项目，无法访问。");
    }
    return todo;
  };

  const projectLabel = (projectId: string): string =>
    bridge.service.get(projectId)?.name ?? projectId;

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_plan_list",
      label: "项目共享计划 · 读取列表",
      description:
        "读取当前任务所在项目的共享计划完整列表（数据库实时状态）。作用域自动取当前任务绑定的项目，不接受 projectId 参数。返回按更新时间倒序的计划项（状态/优先级/负责人/开始/截止/标签/id）。可传 status 过滤、query 搜标题、limit 截断。项目共享计划是人维护的项目级状态，所有绑定本项目的任务共用；它不同于当前任务的执行计划。",
      promptSnippet: "project_plan_list(status?, query?, limit?) — 读取当前项目共享计划完整列表（数据库实时）",
      parameters: listParamsSchema,
      execute: async (_toolCallId: string, params: PlanListParams) => {
        try {
          const projectId = requireProject();
          const todos = bridge.service.listTodos(projectId);
          let items = todos;
          if (params.status) items = items.filter((todo) => todo.status === params.status);
          const query = params.query?.trim().toLowerCase();
          if (query) items = items.filter((todo) => todo.title.toLowerCase().includes(query));
          const page = items.slice(0, params.limit ?? 100);
          const lines = [
            `项目共享计划（列出 ${page.length}/${items.length} 项，作用域：当前任务所属项目「${projectLabel(projectId)}」）：`,
            ...page.map((todo) => formatProjectTodoLine(todo)),
            page.length < items.length
              ? `（还有 ${items.length - page.length} 项未列出；可用 status/query 缩小范围或增大 limit）`
              : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), {
            projectId,
            count: page.length,
            total: items.length,
            items: page,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_plan_get",
      label: "项目共享计划 · 读取单项",
      description:
        "按 id 读取当前任务所在项目共享计划中单个计划项的最新状态（数据库实时）。作用域自动取当前任务绑定的项目；不属于当前项目的 id 返回受控错误。",
      promptSnippet: "project_plan_get(id) — 读取单个项目计划项的最新状态",
      parameters: getParamsSchema,
      execute: async (_toolCallId: string, params: PlanGetParams) => {
        try {
          const projectId = requireProject();
          const todo = requireScopedTodo(projectId, params.id);
          const lines = [
            formatProjectTodoLine(todo),
            `描述：${todo.description ?? "（无）"}`,
            `更新时间：${new Date(todo.updatedAt).toISOString()}`,
          ];
          return textResult(lines.join("\n"), { projectId, todo });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_plan_create",
      label: "项目共享计划 · 新增事项",
      description:
        "在当前任务所属项目的共享计划中新增一个结构化计划项（人维护的项目级状态；所有绑定本项目的任务可见）。作用域自动取当前任务绑定的项目。只改本项目计划，不影响其它项目；归档项目下不可用。日期接受毫秒时间戳或 YYYY-MM-DD（当地 0 点）。新增后请通过返回的 id 在后续更新中引用。",
      promptSnippet: "project_plan_create(title, status?, priority?, ...) — 在当前项目共享计划中新增一项（结构化）",
      parameters: createParamsSchema,
      execute: async (_toolCallId: string, params: PlanCreateParams) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const request: ProjectTodoCreateRequest = { projectId, title: params.title };
          if (params.description !== undefined) request.description = params.description;
          if (params.status !== undefined) request.status = params.status;
          if (params.assignee !== undefined) request.assignee = params.assignee;
          if (params.priority !== undefined) request.priority = params.priority;
          if (params.tags !== undefined) request.tags = params.tags;
          if (params.startAt !== undefined) {
            request.startAt = parsePlanDateValue(params.startAt) ?? undefined;
          }
          if (params.dueAt !== undefined) {
            request.dueAt = parsePlanDateValue(params.dueAt) ?? undefined;
          }
          const created = bridge.service.createTodo(request);
          return textResult(
            `已新增计划项（id=${created.id}，项目「${projectLabel(projectId)}」，状态 ${STATUS_LABEL[created.status]}）：\n${formatProjectTodoLine(created)}`,
            { projectId, todo: created },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_plan_update",
      label: "项目共享计划 · 单项更新",
      description:
        "结构化单项更新当前任务所属项目共享计划中的一个计划项（状态/标题/描述/负责人/优先级/标签/起止日期）。作用域自动取当前任务绑定的项目；不属于当前项目的 id 返回受控错误。只 patch 传入的字段，其余字段保持不变；传 null 可清除 description/assignee/priority/startAt/dueAt。归档项目下不可用。请勿整段重写计划或删除计划项（本工具不提供删除操作）。",
      promptSnippet: "project_plan_update(id, status?, title?, ...) — 单项 patch 项目计划项（结构化，不清除其它字段）",
      parameters: updateParamsSchema,
      execute: async (_toolCallId: string, params: PlanUpdateParams) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const existing = requireScopedTodo(projectId, params.id);
          const request: ProjectTodoUpdateRequest = { id: params.id };
          if (params.title !== undefined) request.title = params.title;
          if (params.description !== undefined) request.description = params.description;
          if (params.status !== undefined) request.status = params.status;
          if (params.assignee !== undefined) request.assignee = params.assignee;
          if (params.priority !== undefined) request.priority = params.priority;
          if (params.tags !== undefined) request.tags = params.tags;
          if (params.startAt !== undefined) request.startAt = parsePlanDateValue(params.startAt);
          if (params.dueAt !== undefined) request.dueAt = parsePlanDateValue(params.dueAt);
          const updated = bridge.service.updateTodo(request);
          return textResult(
            `已更新计划项（${existing.title}${existing.title !== updated.title ? ` → ${updated.title}` : ""}）：\n${formatProjectTodoLine(updated)}`,
            { projectId, todo: updated },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}
