import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryScopeType,
  type MemoryStatus,
} from "../../shared/memory-kernel";
import type { MemoryService } from "./MemoryService";

export interface MemoryExtensionBridge {
  taskId: string;
  service: MemoryService;
  getPermissionMode?: () => PermissionMode;
  readOnly?: boolean;
  resolveProjectId?: () => string | null;
  resolveWorkspaceId?: () => string | null;
}

const kindSchema = Type.Union(MEMORY_KINDS.map((x) => Type.Literal(x)));
const statusSchema = Type.Union(MEMORY_STATUSES.map((x) => Type.Literal(x)));
const scopeSchema = Type.Union([Type.Literal("global"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("task"), Type.Literal("bot"), Type.Literal("team"), Type.Literal("conversation"), Type.Literal("work")]);

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details: details ?? { text } };
}
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `[memory] ${message}` }], isError: true as const, details: { error: message } };
}
function short(memory: { id: string; kind: string; status: string; title: string; content: string; importance: number; confidence: number; scopes: Array<{ scopeType: string; scopeId?: string }> }): string {
  const scope = memory.scopes.map((s) => `${s.scopeType}${s.scopeId ? `:${s.scopeId}` : ""}`).join(",");
  const body = memory.content ? ` — ${memory.content.slice(0, 240)}` : "";
  return `[${memory.kind}/${memory.status}][${scope}] ${memory.title}${body} (importance=${memory.importance}, confidence=${memory.confidence.toFixed(2)}, id=${memory.id})`;
}

export function createMemoryExtension(bridge: MemoryExtensionBridge): ExtensionFactory {
  const writable = (): void => {
    if (bridge.readOnly) throw new Error("当前会话为只读，不能修改长期记忆");
  };
  const context = () => ({
    taskId: bridge.taskId === "transient" ? undefined : bridge.taskId,
    projectId: bridge.resolveProjectId?.() ?? undefined,
    workspaceId: bridge.resolveWorkspaceId?.() ?? undefined,
    includeInherited: true,
  });
  const requireVisible = (id: string) => {
    if (!bridge.service.canAccess(id, context())) throw new Error("记忆不存在或不属于当前任务可见作用域");
    const memory = bridge.service.getForRecall(id, context());
    if (!memory) throw new Error("记忆不存在");
    return memory;
  };

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "memory_search",
      label: "长期记忆 · 搜索",
      description: "在当前任务可见的统一 Memory Kernel 中搜索长期记忆。作用域自动限制为 Task、当前 Project、当前 Workspace 及其祖先、Global；不会跨兄弟 Workspace/其他 Project 泄漏。",
      promptSnippet: "memory_search(query?, kind?, status?, limit?) — 搜索当前可见长期记忆",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 240 })),
        kind: Type.Optional(kindSchema),
        status: Type.Optional(statusSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { query?: string; kind?: MemoryKind; status?: MemoryStatus; limit?: number }) => {
        try {
          const hits = await bridge.service.searchHybrid({
            ...context(),
            query: params.query,
            kinds: params.kind ? [params.kind] : undefined,
            statuses: params.status ? [params.status] : ["active"],
            includeInherited: true,
            limit: params.limit ?? 10,
          });
          return textResult(
            hits.length ? hits.map((h) => `${short(h.memory)}\n  recall: ${h.reasons.join(", ")} score=${h.score.toFixed(1)}`).join("\n") : "没有匹配的长期记忆。",
            { count: hits.length, hits: hits.map((h) => ({ id: h.memory.id, score: h.score, reasons: h.reasons })) },
          );
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_get",
      label: "长期记忆 · 读取",
      description: "读取一条当前任务可见的长期记忆完整状态，包括 scope、evidence、relations、来源与生命周期。",
      promptSnippet: "memory_get(id) — 读取单条长期记忆",
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: { id: string }) => {
        try {
          const memory = requireVisible(params.id);
          return textResult([
            short(memory),
            `完整内容：${memory.content || "（无）"}`,
            `source=${memory.sourceType}${memory.sourceTaskId ? ` task=${memory.sourceTaskId}` : ""} explicit=${memory.explicit}`,
            `evidence=${memory.evidence.map((e) => `${e.evidenceKind}:${e.refTitle ?? e.refId}`).join(" | ") || "（无）"}`,
            `relations=${memory.relations.map((r) => `${r.fromMemoryId === memory.id ? "→" : "←"}${r.relation}:${r.fromMemoryId === memory.id ? r.toMemoryId : r.fromMemoryId}`).join(" | ") || "（无）"}`,
          ].join("\n"), { memory });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_create",
      label: "长期记忆 · 沉淀",
      description: "沉淀长期有价值的认知。默认 scope 由宿主绑定：后台委托使用持久 Work，团队使用 Team，个人 Bot 使用 Bot；普通任务选择 Project > Workspace > Task。Work 可记录跨轮需要的进展、决策与未决项，不保存冗长工具日志。Global 只应保存跨项目稳定身份、偏好、约束或通用 procedure。",
      promptSnippet: "memory_create(kind,title,content?,importance?,confidence?,scopeType?) — 沉淀长期认知",
      parameters: Type.Object({
        kind: kindSchema,
        title: Type.String({ minLength: 1, maxLength: 240 }),
        content: Type.Optional(Type.String({ maxLength: 6000 })),
        importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        scopeType: Type.Optional(scopeSchema),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { kind: MemoryKind; title: string; content?: string; importance?: number; confidence?: number; scopeType?: MemoryScopeType }) => {
        try {
          writable();
          const inferred = bridge.service.inferAgentScope(bridge.taskId);
          let scope = inferred;
          if (params.scopeType === "global") {
            if (!["identity", "preference", "constraint", "procedure"].includes(params.kind)) throw new Error("Agent 不应把项目事实/决策直接提升为 Global；请使用当前项目/工作空间 scope");
            scope = { scopeType: "global" };
          } else if (params.scopeType === "project" && inferred.scopeType === "work") {
            const project = bridge.service.resolveScopeChain({ taskId: bridge.taskId }).find(item => item.scopeType === "project");
            if (!project || !bridge.service.canPromoteFromTask(bridge.taskId, "project", project.scopeId)) throw new Error("当前 Work 没有绑定项目");
            scope = { scopeType: "project", scopeId: project.scopeId };
          } else if (params.scopeType && params.scopeType !== inferred.scopeType) {
            // Explicit promotion is a separate auditable operation; create cannot silently jump scope.
            throw new Error(`当前默认写入 scope=${inferred.scopeType}；跨 scope 请先创建，再用 memory_promote 显式提升`);
          }
          const memory = bridge.service.create({
            kind: params.kind,
            title: params.title,
            content: params.content,
            importance: params.importance,
            confidence: params.confidence ?? 0.82,
            sourceType: "agent",
            sourceTaskId: bridge.taskId,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            evidence: [{ evidenceKind: "task", refId: bridge.taskId }],
          });
          return textResult(`已沉淀：${short(memory)}`, { memory });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_update",
      label: "长期记忆 · 更新",
      description: "更新当前身份可写的一条长期记忆。Work 执行者可修改本 Work 与绑定项目的记忆；Bot/团队仅修改自己的范围。其他主体的私人记忆不可修改。更新会自动生成 revision；信息被新事实取代时不要直接覆盖，请使用 supersedeId 创建替代关系。",
      promptSnippet: "memory_update(id,title?,content?,status?,importance?,confidence?,supersedeId?) — revision-safe 更新",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 120 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        content: Type.Optional(Type.String({ maxLength: 6000 })),
        status: Type.Optional(statusSchema),
        importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { id: string; title?: string; content?: string; status?: MemoryStatus; importance?: number; confidence?: number }) => {
        try {
          writable(); requireVisible(params.id);
          const memory = bridge.service.updateFromTask(bridge.taskId, { ...params, changedBy: "agent", changeReason: `agent task ${bridge.taskId}` });
          return textResult(`已更新：${short(memory)}`, { memory });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_promote",
      label: "长期记忆 · 提升作用域",
      description: "把同一条 Memory 绑定到更高作用域，不复制正文。Workspace 记忆可提升到直接父 Workspace；当前 Project/Workspace/Task 记忆可在明确需要跨项目复用时提升 Global（仅 identity/preference/constraint/procedure）。",
      promptSnippet: "memory_promote(id,targetScopeType,targetScopeId?) — 作用域提升（不复制 Memory）",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 120 }),
        targetScopeType: scopeSchema,
        targetScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { id: string; targetScopeType: MemoryScopeType; targetScopeId?: string }) => {
        try {
          writable();
          const memory = requireVisible(params.id);
          if (bridge.taskId !== "transient" && !bridge.service.canPromoteFromTask(bridge.taskId, params.targetScopeType, params.targetScopeId)) {
            throw new Error("目标作用域不属于当前任务的 Project / Workspace 祖先 / 当前 Task，拒绝越界提升");
          }
          if (params.targetScopeType === "global" && !["identity", "preference", "constraint", "procedure"].includes(memory.kind)) {
            throw new Error("项目事实/决策/风险不能直接提升为 Global");
          }
          const promoted = bridge.service.promoteFromTask(bridge.taskId, params.id, params.targetScopeType, params.targetScopeId);
          return textResult(`已提升作用域（同一 Memory，无正文复制）：${short(promoted)}`, { memory: promoted });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_history",
      label: "长期记忆 · 历史",
      description: "读取一条当前任务可见记忆的 revision 历史，用于追溯参数/决策何时变化。",
      promptSnippet: "memory_history(id) — 查看 revision timeline",
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id: string, params: { id: string }) => {
        try {
          requireVisible(params.id);
          const history = bridge.service.history(params.id);
          return textResult(history.length ? history.map((r) => `r${r.revision} ${new Date(r.createdAt).toISOString()} [${r.status}] ${r.title} — ${r.content.slice(0, 300)} (${r.changedBy}${r.changeReason ? `, ${r.changeReason}` : ""})`).join("\n") : "暂无 revision。", { history });
        } catch (error) { return errorResult(error); }
      },
    });
  };
}
