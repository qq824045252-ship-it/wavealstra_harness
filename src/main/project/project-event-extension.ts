/**
 * ProjectEventExtension — 项目事件的 Agent 结构化工具（Triage / Promotion）。
 *
 * 隔离规则（与 memory/plan 工具一致，冻结）：
 * - 作用域 = 当前任务绑定的项目（未绑定 → 受控错误；不接受 projectId 参数，杜绝越权）；
 * - 事件读取（list/read）为只读；提升（promote_*）为显式写，走 ProjectEventPromoter →
 *   既有 service；归档项目 → 拒绝写；
 * - 输出稳定 ID（event/target id），不泄露绝对路径；
 * - 提升内容全部由 Agent 显式给出（kind/title/content），service 只校验落真源。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ARCHIVED_PROJECT_WRITE_GUIDANCE,
  PROJECT_MEMORY_KINDS,
  PROJECT_EVENT_LIST_MAX_LIMIT,
  type ProjectEventPromoteRequest,
  type ProjectMemoryKind,
} from "../../shared/project-domain";
import { PROJECT_EVENT_BODY_MAX_CHARS, PROJECT_EVENT_KINDS, PROJECT_EVENT_REF_MAX_CHARS, PROJECT_EVENT_SOURCES, PROJECT_EVENT_TITLE_MAX_CHARS } from "./ProjectEventIngestor";
import type { ProjectEventIngestor } from "./ProjectEventIngestor";
import type { ProjectDocumentImporter } from "./ProjectDocumentImporter";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { ProjectEventPromoter } from "./ProjectEventPromoter";
import type { ProjectService } from "./ProjectService";

export interface ProjectEventExtensionBridge {
  service: ProjectService;
  promoter: ProjectEventPromoter;
  /** 文档/纪要文本输入（source=document 审计层） */
  ingestor?: ProjectEventIngestor;
  /** 文件级文档导入（Library-first：先入项目资料库真源，事件引用+截取摘要） */
  importer?: ProjectDocumentImporter;
  /** 当前任务 id（promote 来源注入） */
  taskId?: string;
  /** 当前任务绑定的 projectId（动态解析；null = 未绑定） */
  resolveProjectId?: () => string | null;
  /** 旧调用方兼容字段，不再限制执行 */
  getPermissionMode?: () => PermissionMode;
}

class ProjectEventToolError extends Error {}

const listParamsSchema = Type.Object(
  {
    source: Type.Optional(Type.Union(PROJECT_EVENT_SOURCES.map((s) => Type.Literal(s)) as never)),
    kind: Type.Optional(Type.Union(PROJECT_EVENT_KINDS.map((k) => Type.Literal(k)) as never)),
    /** triage 有效状态：open=待判断（未 dismiss 且未提升）；handled=已 dismiss 或已提升 */
    triage: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("handled")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PROJECT_EVENT_LIST_MAX_LIMIT })),
  },
  { additionalProperties: false },
);

const readParamsSchema = Type.Object(
  { eventId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const promoteMemoryParamsSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1, maxLength: 100 }),
    kind: Type.Union(PROJECT_MEMORY_KINDS.map((k) => Type.Literal(k)) as never),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    content: Type.Optional(Type.String({ maxLength: 4000 })),
    importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  },
  { additionalProperties: false },
);

const promoteTodoParamsSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    dueAt: Type.Optional(Type.Integer({ minimum: 1 })),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  },
  { additionalProperties: false },
);

const promoteLibraryParamsSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    content: Type.String({ minLength: 1, maxLength: 100000 }),
  },
  { additionalProperties: false },
);

const ingestDocumentParamsSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: PROJECT_EVENT_TITLE_MAX_CHARS }),
    body: Type.String({ minLength: 1, maxLength: PROJECT_EVENT_BODY_MAX_CHARS }),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_EVENT_REF_MAX_CHARS })),
  },
  { additionalProperties: false },
);

const importFileParamsSchema = Type.Object(
  { filePath: Type.String({ minLength: 1, maxLength: 1024 }) },
  { additionalProperties: false },
);

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof ProjectEventToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_event] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

function formatEventLine(event: {
  id: string;
  source: string;
  kind: string;
  title: string;
  body?: string;
  createdAt: number;
  triageStatus?: "open" | "dismissed";
  promotions?: Array<{ targetKind: string; targetId: string; targetTitle?: string }>;
}): string {
  const promotions = (event.promotions ?? [])
    .map((p) => `${p.targetKind}:${p.targetTitle ?? p.targetId}`)
    .join(", ");
  const handled = event.triageStatus === "dismissed" || (event.promotions?.length ?? 0) > 0;
  const marker = handled ? (event.triageStatus === "dismissed" ? " · [已忽略]" : " · [已处理]" ) : "";
  return `- [${event.source}/${event.kind}]${marker} ${event.title} · ${new Date(event.createdAt).toISOString()} · id=${event.id}${event.body ? `\n  ${event.body.slice(0, 200)}` : ""}${promotions ? `\n  已提升：${promotions}` : ""}`;
}

export function createProjectEventExtension(bridge: ProjectEventExtensionBridge): ExtensionFactory {
  const requireProject = (): string => {
    const projectId = bridge.resolveProjectId?.() ?? null;
    if (!projectId) {
      throw new ProjectEventToolError(
        "当前任务未绑定任何项目，无法访问项目事件。请在项目页把任务关联到项目，或在项目内新建任务。",
      );
    }
    return projectId;
  };

  const requireScopedEvent = (projectId: string, eventId: string): { eventId: string; projectId: string } => {
    const event = bridge.service.getProjectEvent(eventId);
    if (!event) throw new ProjectEventToolError(`事件不存在：${eventId}`);
    if (event.projectId !== projectId) {
      throw new ProjectEventToolError("该事件不属于当前任务所在项目，无法访问。");
    }
    return { eventId, projectId };
  };

  /** 写操作门禁：归档项目拒绝写入（与既有项目写工具一致），读操作不受影响 */
  const guardWritable = (projectId: string): void => {
    const project = bridge.service.get(projectId);
    if (project?.archived) {
      throw new ProjectEventToolError(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
  };

  const projectLabel = (projectId: string): string =>
    bridge.service.get(projectId)?.name ?? projectId;

  const promote = (
    eventId: string,
    projectId: string,
    request: Omit<ProjectEventPromoteRequest, "eventId" | "promotedBy">,
  ): ProjectEventPromoteRequest => {
    requireScopedEvent(projectId, eventId);
    guardWritable(projectId);
    return { eventId, promotedBy: "agent", ...request };
  };

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_event_import_file",
      label: "项目事件 · 导入文件为资料+事件",
      description:
        "把一份本地文件（md/txt/docx/pptx/xlsx/pdf 等）导入当前项目：文件先成为项目资料库真源条目" +
        "（受管副本+内容抽取+FTS，复用既有资料库能力），随后记录一条 source=document 的项目输入事件" +
        "（引用资料条目 + 机械截取正文摘要，绝不自动总结/OCR）。同文件重复导入幂等（返回既有事件）。" +
        "归档项目下不可用（会写入项目真源）；文件大小/安全边界由资料库既有守卫执行。",
      promptSnippet: "project_event_import_file(filePath) — 文件入项目资料库并记录输入事件",
      parameters: importFileParamsSchema,
      execute: async (_toolCallId: string, params: { filePath: string }) => {
        try {
          const projectId = requireProject();
          if (!bridge.importer) {
            throw new ProjectEventToolError("文件导入入口未就绪（importer 未注入）。");
          }
          const result = await bridge.importer.importFile(projectId, params.filePath);
          return textResult(
            result.reused
              ? `幂等复用：该文件此前已导入（event=${result.event.id}${result.item ? `，资料=${result.item.id}` : "，资料条目已被删除"}）`
              : `已导入项目资料（id=${result.item?.id}）并记录事件（id=${result.event.id}）：${result.event.title}`,
            { projectId, ...result },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_event_ingest_document",
      label: "项目事件 · 导入纪要/文档",
      description:
        "把一份会议纪要/文档文本记录为当前项目的输入事件（source=document，审计/输入层，不写真源、不触发任何派生）。" +
        "正文必须由你显式给出（可先提炼再传入，服务绝不自动总结/截断；超限拒绝）。同内容重复导入幂等（返回既有事件）。" +
        "归档项目允许记录（与外部输入审计语义一致）。",
      promptSnippet: "project_event_ingest_document(title, body, ref?) — 记录一份纪要/文档为项目输入事件",
      parameters: ingestDocumentParamsSchema,
      execute: async (
        _toolCallId: string,
        params: { title: string; body: string; ref?: string },
      ) => {
        try {
          const projectId = requireProject();
          if (!bridge.ingestor) {
            throw new ProjectEventToolError("文档事件入口未就绪（ingestor 未注入）。");
          }
          const event = bridge.ingestor.ingestDocument(projectId, {
            title: params.title,
            body: params.body,
            ref: params.ref,
          });
          return textResult(
            `已记录为项目事件（id=${event.id}，项目「${projectLabel(projectId)}」）：${event.title}`,
            { projectId, event },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_event_list",
      label: "项目事件 · 读取列表",
      description:
        "读取当前任务所在项目的外部输入事件列表（数据库实时；含已提升目标）。事件是外部输入（IM/定时任务/文档等）的审计层，不是项目状态真源。可传 source（gateway/cron/manual/document/mcp）、kind（message/note/run/reminder/update）、limit 过滤。作用域自动取当前任务绑定的项目，不接受 projectId 参数。",
      promptSnippet: "project_event_list(source?, kind?, limit?) — 读取当前项目外部输入事件",
      parameters: listParamsSchema,
      execute: async (_toolCallId: string, params: { source?: string; kind?: string; triage?: "open" | "handled"; limit?: number }) => {
        try {
          const projectId = requireProject();
          let events = bridge.service.listProjectEvents(projectId, params.limit ?? 50);
          if (params.source) events = events.filter((event) => event.source === params.source);
          if (params.kind) events = events.filter((event) => event.kind === params.kind);
          if (params.triage === "open") {
            events = events.filter(
              (event) => event.triageStatus !== "dismissed" && (event.promotions?.length ?? 0) === 0,
            );
          } else if (params.triage === "handled") {
            events = events.filter(
              (event) => event.triageStatus === "dismissed" || (event.promotions?.length ?? 0) > 0,
            );
          }
          const lines = [
            `项目「${projectLabel(projectId)}」外部输入事件（列出 ${events.length} 条）：`,
            ...events.map(formatEventLine),
            events.length === 0 ? "（无事件；外部消息可用 `@项目 <名>：内容` 投递到项目）" : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), {
            projectId,
            count: events.length,
            events,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_event_read",
      label: "项目事件 · 读取单项",
      description:
        "按 eventId 读取当前任务所在项目中的单个外部输入事件完整内容（含来源/正文/载荷/已提升目标）。不属于当前项目的 id 返回受控错误。",
      promptSnippet: "project_event_read(eventId) — 读取单条项目事件的完整内容",
      parameters: readParamsSchema,
      execute: async (_toolCallId: string, params: { eventId: string }) => {
        try {
          const projectId = requireProject();
          requireScopedEvent(projectId, params.eventId);
          const event = bridge.service.getProjectEvent(params.eventId)!;
          const ref = event.ref ?? "（无）";
          const handled = event.triageStatus === "dismissed" || (event.promotions?.length ?? 0) > 0;
          const lines = [
            formatEventLine(event),
            `完整正文：${event.body || "（无）"}`,
            `来源：${event.source}｜类型：${event.kind}｜ref=${ref}｜triage=${event.triageStatus ?? "open"}（${handled ? "已处理" : "待判断"}）｜创建 ${new Date(event.createdAt).toISOString()}`,
            `载荷：${JSON.stringify(event.payload ?? {})}`,
          ];
          return textResult(lines.join("\n"), { projectId, event });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    // triage 状态（工作流元数据，绝不参与派生）：dismiss/reopen 幂等；归档项目允许
    const triage = async (
      eventId: string,
      status: "dismissed" | "open",
      verb: string,
    ): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const projectId = requireProject();
        requireScopedEvent(projectId, eventId);
        const updated =
          status === "dismissed"
            ? bridge.service.dismissProjectEvent(projectId, eventId)
            : bridge.service.reopenProjectEvent(projectId, eventId);
        return textResult(
          `已${verb}（event=${updated.id}，triage=${updated.triageStatus}）：${updated.title}`,
          { projectId, event: updated },
        );
      } catch (error) {
        return errorResult(error);
      }
    };

    pi.registerTool({
      name: "project_event_dismiss",
      label: "项目事件 · 标记已处理（忽略）",
      description:
        "把当前项目的一条外部输入事件标记为已处理/无需动作（triage 工作流元数据，不写真源、不影响项目健康度）。" +
        "适合：已读且无需提升的事件（高量 gateway/cron 消息收敛）。重复调用幂等。" +
        "归档项目允许（审计层工作流元数据）。",
      promptSnippet: "project_event_dismiss(eventId) — 标记事件已处理",
      parameters: readParamsSchema,
      execute: async (_toolCallId: string, params: { eventId: string }) =>
        triage(params.eventId, "dismissed", "标记为已处理"),
    });

    pi.registerTool({
      name: "project_event_reopen",
      label: "项目事件 · 恢复待判断",
      description:
        "把当前项目一条已忽略（dismissed）的事件恢复为待判断（triage=open）。幂等；" +
        "归档项目允许。",
      promptSnippet: "project_event_reopen(eventId) — 恢复事件待判断",
      parameters: readParamsSchema,
      execute: async (_toolCallId: string, params: { eventId: string }) =>
        triage(params.eventId, "open", "恢复为待判断"),
    });

    pi.registerTool({
      name: "project_event_promote_to_memory",
      label: "项目事件 · 提升为共享记忆",
      description:
        "把当前项目的一条外部输入事件显式提升为项目共享长期记忆（fact/decision/constraint/risk/open_question）。" +
        "kind 与 title 必须由你明确给出（不允许让系统猜测）；content 可选。提升后事件与记忆建立溯源链接，" +
        "记忆走既有派生（risk/待确认影响项目健康度）。归档项目下不可用；同一事件同一类型只能提升一次（重复调用幂等返回既有目标）。",
      promptSnippet: "project_event_promote_to_memory(eventId, kind, title, content?, importance?) — 事件提升为项目记忆",
      parameters: promoteMemoryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: { eventId: string; kind: ProjectMemoryKind; title: string; content?: string; importance?: number },
      ) => {
        try {
          const projectId = requireProject();
          const request = promote(params.eventId, projectId, {
            targetKind: "memory",
            memoryKind: params.kind,
            memoryTitle: params.title,
            memoryContent: params.content,
            memoryImportance: params.importance,
          });
          const result = bridge.promoter.promote(params.eventId, request, { taskId: bridge.taskId });
          return textResult(
            result.reused
              ? `幂等复用：该事件已提升为记忆（id=${result.targetId}${result.targetMissing ? "，但目标已被删除" : ""}）`
              : `已提升为项目记忆（id=${result.targetId}，项目「${projectLabel(projectId)}」）：${result.targetTitle ?? ""}`,
            { projectId, ...result },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_event_promote_to_todo",
      label: "项目事件 · 提升为计划项",
      description:
        "把当前项目的一条外部输入事件显式提升为项目计划待办（Plan/Todo）。标题必须由你明确给出；" +
        "可附描述、截止时间（epoch ms）与优先级。提升走既有计划 service（逾期/临期进入派生健康度）。" +
        "归档项目下不可用；同一事件同一类型只能提升一次（重复调用幂等返回既有目标）。",
      promptSnippet: "project_event_promote_to_todo(eventId, title, description?, dueAt?, priority?) — 事件提升为计划项",
      parameters: promoteTodoParamsSchema,
      execute: async (
        _toolCallId: string,
        params: { eventId: string; title: string; description?: string; dueAt?: number; priority?: "low" | "medium" | "high" },
      ) => {
        try {
          const projectId = requireProject();
          const request = promote(params.eventId, projectId, {
            targetKind: "todo",
            todoTitle: params.title,
            todoDescription: params.description,
            todoDueAt: params.dueAt,
            todoPriority: params.priority,
          });
          const result = bridge.promoter.promote(params.eventId, request, { taskId: bridge.taskId });
          return textResult(
            result.reused
              ? `幂等复用：该事件已提升为计划项（id=${result.targetId}${result.targetMissing ? "，但目标已被删除" : ""}）`
              : `已提升为计划项（id=${result.targetId}，项目「${projectLabel(projectId)}」）：${result.targetTitle ?? ""}`,
            { projectId, ...result },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_event_promote_to_library",
      label: "项目事件 · 提升为项目资料",
      description:
        "把当前项目的一条外部输入事件显式保存为项目资料库 markdown 条目（正文必须由你明确给出；" +
        "需要总结/提炼时请你在调用前完成）。条目落在项目资料空间（无则自动创建）。" +
        "归档项目下不可用；同一事件同一类型只能提升一次（重复调用幂等返回既有目标）。",
      promptSnippet: "project_event_promote_to_library(eventId, title, content) — 事件保存为项目资料",
      parameters: promoteLibraryParamsSchema,
      execute: async (_toolCallId: string, params: { eventId: string; title: string; content: string }) => {
        try {
          const projectId = requireProject();
          const request = promote(params.eventId, projectId, {
            targetKind: "library",
            libraryTitle: params.title,
            libraryContent: params.content,
          });
          const result = bridge.promoter.promote(params.eventId, request, { taskId: bridge.taskId });
          return textResult(
            result.reused
              ? `幂等复用：该事件已提升为项目资料（id=${result.targetId}${result.targetMissing ? "，但目标已被删除" : ""}）`
              : `已提升为项目资料（id=${result.targetId}，项目「${projectLabel(projectId)}」）：${result.targetTitle ?? ""}`,
            { projectId, ...result },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}
