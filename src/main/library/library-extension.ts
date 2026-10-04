/**
 * LibraryExtension — 资料库的 Agent 结构化工具（最小领域面，任务/项目限域）。
 *
 * 隔离规则（冻结）：personal 恒可见；任务绑定 projectId 时仅 personal + 本项目空间；
 * 未绑定任务仅 personal。所有工具（list/search/read/attach/detach）在进入点做授权检查，
 * 不只过滤列表——通过 itemId/spaceId 直接访问同样拒绝。
 *
 * 二进制门禁：pdf/office/image/file 等非文本条目禁止 utf8 直读，返回结构化 metadata
 * （kind/mime/size/managedPath/source/provenance）+ 明确“需要文件/预览工具读取”。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LIBRARY_CONTENT_MAX_CHARS, LIBRARY_PERSONAL_SPACE_ID, LIBRARY_TITLE_MAX_CHARS, type LibraryItemDto, type LibrarySpaceDto } from "../../shared/library-ipc";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";
import type { LibraryService } from "./LibraryService";

export interface LibraryExtensionBridge {
  service: LibraryService;
  /** 当前任务 id（attach/detach 用；空 = 仅读工具可用） */
  taskId?: string;
  /** 当前任务绑定的 projectId（动态解析；null = 未绑定） */
  resolveProjectId?: () => string | null;
  /** 当前权限模式（readonly 禁止 attach/detach 等写操作；缺省视为非 readonly） */
  getPermissionMode?: () => import("../../shared/agent-ipc").PermissionMode;
}

class LibraryToolError extends Error {}

const listParamsSchema = Type.Object(
  {
    spaceId: Type.Optional(Type.String({ maxLength: 100 })),
    query: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

const readParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

const attachParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
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
    error instanceof LibraryToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[library] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

function spaceLabel(space: LibrarySpaceDto | null | undefined): string {
  if (!space) return "未知空间";
  if (space.kind === "personal") return "我的文档";
  return space.projectName ? `项目资料：${space.projectName}` : space.name;
}

function describeItem(item: LibraryItemDto, service: LibraryService): string {
  const space = service.getSpace(item.spaceId);
  const loc = spaceLabel(space);
  const fav = item.favorite ? "★" : "";
  const src = item.sourceType ? `（来源：${item.sourceType}${item.sourceTaskId ? ` 任务 ${item.sourceTaskId}` : ""}）` : "";
  const url = item.url ? ` url=${item.url}` : "";
  const path = item.kind === "url" ? "" : ` path=${service.absolutePath(item)}`;
  return `- [${item.kind}]${fav} ${item.title} · ${loc} · id=${item.id} · space=${item.spaceId}${item.collectionId ? ` · collection=${item.collectionId}` : ""}${url}${path}${src}`;
}

export function createLibraryExtension(bridge: LibraryExtensionBridge): ExtensionFactory {
  const service = bridge.service;

  /** 任务可见项目（动态解析） */
  const taskProjectId = (): string | null => {
    try {
      return bridge.resolveProjectId?.() ?? null;
    } catch {
      return null;
    }
  };

  /** 空间可见性授权（list 按空间过滤与直接访问共用） */
  const assertSpaceVisible = (spaceId: string): LibrarySpaceDto => {
    const space = service.getSpace(spaceId);
    if (!space) throw new LibraryToolError("空间不存在");
    if (!service.isSpaceVisibleToTask(space, taskProjectId())) {
      throw new LibraryToolError("该空间不在当前任务可见范围（仅个人资料与当前项目资料可见）");
    }
    return space;
  };

  /** 条目可见性授权（read/attach/detach 进入点；防止 itemId 直读越界） */
  const assertItemVisible = (id: string): LibraryItemDto => {
    const item = service.getItem(id);
    if (!item) throw new LibraryToolError(`资料条目不存在：${id}`);
    if (!service.isItemVisibleToTask(item, taskProjectId())) {
      throw new LibraryToolError("该条目不在当前任务可见范围（跨项目资料不可访问）");
    }
    return item;
  };

  const requireReadable = (id: string): LibraryItemDto => {
    // 只读授权；folder 已由 collection 分层承担（items 中不存在）
    return assertItemVisible(id);
  };

  /** 写门禁：readonly 权限模式拒绝 attach/detach（与 project_memory_* / project_context_* 一致） */
  const guardWritable = (): void => {
    if (bridge.getPermissionMode?.() === "readonly") {
      throw new LibraryToolError("当前为只读权限模式，不能修改任务资料引用（只可读取）。");
    }
  };

  /** 写门禁（空间级）：readonly 拒绝；目标空间所属项目归档拒绝；作用域必须对任务可见 */
  const guardWritableForSpace = (spaceId: string): LibrarySpaceDto => {
    const space = assertSpaceVisible(spaceId);
    if (bridge.getPermissionMode?.() === "readonly") {
      throw new LibraryToolError("当前为只读权限模式，不能修改资料库（只可读取）。");
    }
    if (space.projectId && service.isProjectArchived(space.projectId)) {
      throw new LibraryToolError(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
    return space;
  };

  /** 写门禁（条目级）：readonly/归档拒绝；条目必须对任务可见 */
  const guardWritableForItem = (item: LibraryItemDto): void => {
    assertItemVisible(item.id);
    guardWritableForSpace(item.spaceId);
  };

  const defaultSpaceId = (): string => {
    return LIBRARY_PERSONAL_SPACE_ID;
  };

  /** 文本类创建/更新返回摘要（稳定 id/space/collection/provenance；不泄露绝对路径） */
  const itemSummary = (item: LibraryItemDto): string => {
    return [
      `- [${item.kind}] ${item.title} · id=${item.id} · space=${item.spaceId}`,
      item.collectionId ? `  collection=${item.collectionId}` : "",
      `  来源：${item.sourceType ?? "created"}${item.sourceTaskId ? `（任务 ${item.sourceTaskId}）` : ""}`,
      `  下一步：library_update_text / library_move / library_attach_to_task / library_read`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "library_list",
      label: "资料库 · 列出条目",
      description:
        "列出当前任务可见范围的资料库条目（个人「我的文档」+ 当前项目资料；跨项目资料不可见）。可传 spaceId 限定空间、query 过滤标题、limit 截断。返回数据库实时状态（类型/标题/位置/id/路径/来源）。资料库是长期知识资产，不同于任务工作区文件。",
      promptSnippet: "library_list(spaceId?, query?, limit?) — 列出当前任务可见的资料库条目",
      parameters: listParamsSchema,
      execute: async (_toolCallId: string, params: { spaceId?: string; query?: string; limit?: number }) => {
        try {
          const visibleSpaces = service
            .listSpaces()
            .filter((s) => service.isSpaceVisibleToTask(s, taskProjectId()));
          const visibleIds = new Set(visibleSpaces.map((s) => s.id));
          let items: LibraryItemDto[];
          if (params.spaceId) {
            assertSpaceVisible(params.spaceId);
            items = service.listAllItems(params.spaceId);
          } else {
            items = service.listAllItems().filter((i) => visibleIds.has(i.spaceId));
          }
          const q = params.query?.trim().toLowerCase();
          const filtered = q
            ? items.filter(
                (item) =>
                  item.title.toLowerCase().includes(q) ||
                  item.filename.toLowerCase().includes(q),
              )
            : items;
          const page = filtered.slice(0, params.limit ?? 30);
          const lines = [
            `资料库（当前任务可见 ${page.length} 项）：`,
            ...page.map((item) => describeItem(item, service)),
            page.length === 0 ? "（没有匹配条目）" : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), { count: page.length });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_search",
      label: "资料库 · 搜索",
      description:
        "在当前任务可见范围（个人 + 当前项目资料）搜索资料库：标题/文件名 + Markdown/HTML/CSV 内容全文。跨项目资料不会出现在结果中。需要正文时再用 library_read 读取。",
      promptSnippet: "library_search(query, limit?) — 在当前任务可见范围搜索资料库",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
        try {
          const rows = service.search(params.query, { projectId: taskProjectId() }).slice(0, params.limit ?? 20);
          const lines = [
            `资料库搜索「${params.query}」（${rows.length} 条，当前任务可见范围）：`,
            ...rows.map((row) => {
              const item = service.getItem(row.id);
              return item ? describeItem(item, service) : `- ${row.title} · id=${row.id}`;
            }),
            rows.length === 0 ? "（无匹配）" : "",
          ];
          return textResult(lines.filter(Boolean).join("\n"), { count: rows.length });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_read",
      label: "资料库 · 读取条目",
      description:
        "读取当前任务可见范围内资料条目的内容。Markdown/HTML/CSV 返回正文（截断上限）；URL 返回链接；PDF/Office/图片/未知文件返回结构化 metadata（类型/大小/受管路径/来源/provenance）——这些是非文本资产，需要文件/预览工具读取，资料库不提供内联全文。跨项目条目不可访问。",
      promptSnippet: "library_read(id) — 读取资料条目（文本类返回正文，二进制类返回受管路径元数据）",
      parameters: readParamsSchema,
      execute: async (_toolCallId: string, params: { id: string }) => {
        try {
          const item = requireReadable(params.id);
          if (item.kind === "url") {
            return textResult(`[url] ${item.title}\n链接：${item.url}`, { item });
          }
          const content = service.readContent(item.id);
          if (content.requiresFileAccess) {
            const space = service.getSpace(item.spaceId);
            const lines = [
              `[${item.kind}] ${item.title}（id=${item.id}）`,
              `类型：${item.kind}｜MIME：${item.mimeType || "未知"}｜大小：${item.sizeBytes} 字节`,
              `受管路径：${content.managedPath ?? "（无）"}`,
              item.sourceType
                ? `来源：${item.sourceType}${item.sourceTaskId ? `（任务 ${item.sourceTaskId}）` : ""}${item.sourceArtifactId ? ` 产物 ${item.sourceArtifactId}` : ""}`
                : "",
              item.originalPath ? `原始路径：${item.originalPath}` : "",
              `位置：${spaceLabel(space)}`,
              "该条目是非文本资产：资料库不提供内联全文。需要内容时请用文件工具读取受管路径，或让用户用预览/Office 打开。",
            ];
            return textResult(lines.filter(Boolean).join("\n"), { item, managedPath: content.managedPath });
          }
          const preview =
            content.content.length > 4000
              ? `${content.content.slice(0, 4000)}\n…（内容过长，已截断前 4000 字符）`
              : content.content;
          return textResult(`[${item.kind}] ${item.title}（id=${item.id}）\n\n${preview}`, { item, content });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_attach_to_task",
      label: "资料库 · 附加到任务",
      description:
        "把当前任务可见范围内的资料条目显式附加到本任务（TaskLibraryReference）。附加后该条目会以结构化引用出现在本任务上下文中；不复制文件、不把整个资料库塞进上下文。跨项目条目不可附加。",
      promptSnippet: "library_attach_to_task(id, taskId?) — 附加资料到当前/指定任务",
      parameters: attachParamsSchema,
      execute: async (_toolCallId: string, params: { id: string; taskId?: string }) => {
        try {
          const taskId = params.taskId?.trim() || bridge.taskId;
          if (!taskId) throw new LibraryToolError("无法确定当前任务（瞬时会话不提供附加能力）");
          guardWritable();
          assertItemVisible(params.id);
          const ref = service.attachToTask({ itemId: params.id, taskId });
          return textResult(`已把资料（id=${params.id}）附加到任务 ${taskId}。`, { ref });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_detach_from_task",
      label: "资料库 · 从任务移除",
      description: "把之前附加到当前任务的资料引用移除（不影响资料库条目本身）。",
      promptSnippet: "library_detach_from_task(id, taskId?) — 移除任务资料引用",
      parameters: attachParamsSchema,
      execute: async (_toolCallId: string, params: { id: string; taskId?: string }) => {
        try {
          const taskId = params.taskId?.trim() || bridge.taskId;
          if (!taskId) throw new LibraryToolError("无法确定当前任务（瞬时会话不提供附加能力）");
          guardWritable();
          assertItemVisible(params.id);
          service.detachFromTask({ itemId: params.id, taskId });
          return textResult(`已从任务 ${taskId} 移除资料引用（id=${params.id}）。`);
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    /* ---------------- 写回/晋升工具面（task-scoped；个人 + 当前项目；绝不跨项目） ---------------- */

    pi.registerTool({
      name: "library_create_text",
      label: "资料库 · 新建文本资料",
      description:
        "在当前任务可见范围（personal + 当前项目；未绑定任务仅 personal）新建文本类资料（markdown/html/csv）。" +
        "spaceId 缺省为个人文档；collectionId 必须属于同一空间。创建后可带 content 正文（≤100000 字符）。" +
        "readonly 权限或归档项目下不可用；跨项目 space/collection 拒绝。",
      promptSnippet: "library_create_text(kind, title, content?, spaceId?, collectionId?) — 新建文本资料（md/html/csv）",
      parameters: Type.Object(
        {
          kind: Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("csv")]),
          title: Type.String({ minLength: 1, maxLength: LIBRARY_TITLE_MAX_CHARS }),
          content: Type.Optional(Type.String({ maxLength: LIBRARY_CONTENT_MAX_CHARS })),
          spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          collectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _toolCallId: string,
        params: { kind: "markdown" | "html" | "csv"; title: string; content?: string; spaceId?: string; collectionId?: string },
      ) => {
        try {
          const spaceId = params.spaceId?.trim() || defaultSpaceId();
          guardWritableForSpace(spaceId);
          if (params.collectionId) {
            const collection = service.getCollection(params.collectionId);
            if (!collection || collection.spaceId !== spaceId) {
              throw new LibraryToolError("目标集合不存在或不属于同一空间（跨项目/跨作用域拒绝）");
            }
          }
          const created = service.createItem({
            spaceId,
            collectionId: params.collectionId ?? null,
            kind: params.kind,
            title: params.title,
          });
          if (params.content !== undefined && params.content !== "") {
            try {
              service.writeContent({ id: created.id, content: params.content });
            } catch (err) {
              // 正文写入失败：清理半成品条目，返回明确错误（不留下种子空文档）
              try {
                service.deleteItem(created.id);
              } catch {
                /* ignore */
              }
              throw err;
            }
          }
          const finalItem = service.getItem(created.id)!;
          return textResult(
            `已新建资料：\n${itemSummary(finalItem)}`,
            { item: finalItem },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_update_text",
      label: "资料库 · 更新文本资料",
      description:
        "更新当前任务可见范围内文本类资料（markdown/html/csv）的正文与标题。正文更新记录 LibraryVersion（旧内容 hash）、" +
        "原子写盘并刷新检索索引；二进制/Office/PDF 拒绝字符串写入。title 缺省保持不变；content 缺省保持不变。" +
        "readonly 权限或归档项目下不可用；跨项目条目拒绝。",
      promptSnippet: "library_update_text(id, content?, title?) — 更新文本资料（版本快照 + FTS 刷新）",
      parameters: Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 100 }),
          content: Type.Optional(Type.String({ maxLength: LIBRARY_CONTENT_MAX_CHARS })),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { id: string; content?: string; title?: string }) => {
        try {
          const item = service.getItem(params.id);
          if (!item) throw new LibraryToolError(`资料条目不存在：${params.id}`);
          guardWritableForItem(item);
          if (item.kind !== "markdown" && item.kind !== "html" && item.kind !== "csv") {
            throw new LibraryToolError("该条目是受管文件（非文本），不能用字符串写入（用文件工具处理）");
          }
          let updated = item;
          if (params.content !== undefined) {
            updated = service.updateTextContent({ id: item.id, content: params.content, title: params.title?.trim() });
          } else if (params.title !== undefined && params.title.trim() !== item.title) {
            updated = service.updateItem({ id: item.id, title: params.title.trim() });
          }
          return textResult(`已更新资料：\n${itemSummary(updated)}`, { item: updated });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_save_artifact",
      label: "资料库 · 保存任务产物",
      description:
        "把当前任务（或同项目任务）的产物 COPY 到资料库受管存储并晋升为长期资料（provenance 记录来源任务/产物；" +
        "同产物同空间幂等：内容变化时更新副本并记版本）。只复制不移动/删除原始产物。" +
        "spaceId 缺省为个人文档；readonly/归档拒绝；其他项目任务的产物拒绝。",
      promptSnippet: "library_save_artifact(artifactId, spaceId?, collectionId?) — 产物晋升为长期资料（COPY + provenance）",
      parameters: Type.Object(
        {
          artifactId: Type.String({ minLength: 1, maxLength: 100 }),
          spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          collectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _toolCallId: string,
        params: { artifactId: string; spaceId?: string; collectionId?: string },
      ) => {
        try {
          const spaceId = params.spaceId?.trim() || defaultSpaceId();
          guardWritableForSpace(spaceId);
          if (params.collectionId) {
            const collection = service.getCollection(params.collectionId);
            if (!collection || collection.spaceId !== spaceId) {
              throw new LibraryToolError("目标集合不存在或不属于同一空间（跨项目/跨作用域拒绝）");
            }
          }
          const scope = service.getArtifactScope(params.artifactId);
          if (!scope) throw new LibraryToolError("产物不存在");
          const taskProjectId = bridge.resolveProjectId?.() ?? null;
          const ownTask = Boolean(bridge.taskId && scope.taskId === bridge.taskId);
          const sameProject = Boolean(taskProjectId && scope.projectId === taskProjectId);
          if (!ownTask && !sameProject) {
            throw new LibraryToolError("产物不属于当前任务或当前项目，拒绝晋升（跨项目隔离）");
          }
          const saved = service.saveArtifact({ artifactId: params.artifactId, spaceId, collectionId: params.collectionId ?? null });
          return textResult(
            `已保存产物到资料库：\n${itemSummary(saved)}`,
            { item: saved },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_create_collection",
      label: "资料库 · 新建集合",
      description:
        "在当前任务可见空间（personal + 当前项目）新建集合（文件夹）。parentId 必须属于同一空间；" +
        "readonly/归档拒绝；跨项目空间拒绝。",
      promptSnippet: "library_create_collection(name, spaceId?, parentId?) — 新建资料集合（项目内组织）",
      parameters: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 100 }),
          spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          parentId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { name: string; spaceId?: string; parentId?: string }) => {
        try {
          const spaceId = params.spaceId?.trim() || defaultSpaceId();
          guardWritableForSpace(spaceId);
          if (params.parentId) {
            const parent = service.getCollection(params.parentId);
            if (!parent || parent.spaceId !== spaceId) {
              throw new LibraryToolError("父集合不存在或不属于同一空间（跨项目/跨作用域拒绝）");
            }
          }
          const collection = service.createCollection({ spaceId, parentId: params.parentId ?? null, name: params.name });
          return textResult(
            `已新建集合：${collection.name} · id=${collection.id} · space=${collection.spaceId}${collection.parentId ? ` · parent=${collection.parentId}` : ""}`,
            { collection },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "library_move",
      label: "资料库 · 移动条目/集合",
      description:
        "在同一空间内移动条目（type=item，collectionId 为目标集合，传 null 移到空间根）或集合（type=collection，" +
        "collectionId 为目标父集合，传 null 移到空间根）。跨空间/跨项目移动拒绝；移入自身/后代（环）拒绝。" +
        "移动不改变项目作用域；readonly/归档拒绝。",
      promptSnippet: "library_move(type, id, collectionId?) — 同空间移动条目或集合",
      parameters: Type.Object(
        {
          type: Type.Union([Type.Literal("item"), Type.Literal("collection")]),
          id: Type.String({ minLength: 1, maxLength: 100 }),
          collectionId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _toolCallId: string,
        params: { type: "item" | "collection"; id: string; collectionId?: string | null },
      ) => {
        try {
          const target = params.collectionId ?? null;
          if (params.type === "item") {
            const item = service.getItem(params.id);
            if (!item) throw new LibraryToolError(`条目不存在：${params.id}`);
            guardWritableForItem(item);
            if (target) {
              const collection = service.getCollection(target);
              if (!collection || collection.spaceId !== item.spaceId) {
                throw new LibraryToolError("目标集合不存在或不属于同一空间（跨项目/跨作用域拒绝）");
              }
            }
            const moved = service.updateItem({ id: item.id, collectionId: target });
            return textResult(
              `已移动条目：${item.title} · id=${moved.id} · collection=${moved.collectionId ?? "（根）"} · space=${moved.spaceId}`,
              { item: moved },
            );
          }
          const collection = service.getCollection(params.id);
          if (!collection) throw new LibraryToolError(`集合不存在：${params.id}`);
          guardWritableForSpace(collection.spaceId);
          if (target) {
            const parent = service.getCollection(target);
            if (!parent || parent.spaceId !== collection.spaceId) {
              throw new LibraryToolError("目标父集合不存在或不属于同一空间（跨项目/跨作用域拒绝）");
            }
          }
          const moved = service.moveCollection({ id: collection.id, parentId: target });
          return textResult(
            `已移动集合：${moved.name} · id=${moved.id} · parent=${moved.parentId ?? "（根）"} · space=${moved.spaceId}`,
            { collection: moved },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}


