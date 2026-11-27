import { dotsRecordApplicability } from "./DotsRevisionSource";
import { isSensitive } from "./MemoryCandidateExtraction";
import { MemoryInstructionDocument } from "./MemoryIntent";
import { DOTS_TASK_ID } from "../../shared/dots";
import { defaultDotsMemoryLimits, dotsMemoryLimitFields, type DotsMemoryLimits } from "../../shared/dots-limits";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryRecordDto,
  type MemoryScopeType,
  type MemoryStatus,
} from "../../shared/memory-kernel";
import type { MemoryService } from "./MemoryService";

const dotsApplicabilitySchema = Type.Optional(Type.Object({
  kind: Type.Union([Type.Literal("general"), Type.Literal("project"), Type.Literal("workspace"), Type.Literal("unresolved")]),
  evidence: Type.String({ minLength: 1, maxLength: 1200, description: "同一条用户原话中支持适用范围的逐字引文" }),
  name: Type.Optional(Type.String({ maxLength: 160, description: "用户原话明确指出的项目或工作空间名称" })),
  id: Type.Optional(Type.String({ maxLength: 160, description: "已查明的项目、工作空间或其中的任务 ID" })),
}, { additionalProperties: false, description: "声明此条陈述的适用范围。无法确认的项目或空间引用使用 unresolved，更新默认规则使用 general。" }));

export interface MemoryExtensionBridge {
  taskId: string;
  service: MemoryService;
  getPermissionMode?: () => PermissionMode;
  readOnly?: boolean;
  canRead?: (tool: "memory_search" | "memory_get" | "memory_history") => boolean;
  canWrite?: () => boolean;
  dotsMemoryLimits?: () => DotsMemoryLimits;
  sourceInput?: () => { text: string; createdAt: number; messageId: string } | undefined;
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
function short(memory: MemoryRecordDto): string {
  const scope = memory.scopes.map((s) => `${s.scopeType}${s.scopeId ? `:${s.scopeId}` : ""}`).join(",");
  const body = memory.content ? ` — ${memory.content.slice(0, 240)}` : "";
  const applicability = dotsRecordApplicability(memory);
  const condition = applicability?.kind === "unresolved" ? "[适用范围待确认，仅供查证]"
    : applicability ? `[${applicability.kind === "project" ? "项目" : "工作空间"} ${applicability.name}]` : "";
  return `[${memory.kind}/${memory.status}][${scope}]${condition} ${memory.title}${body} (importance=${memory.importance}, confidence=${memory.confidence.toFixed(2)}, id=${memory.id})`;
}

function dotsToolSource(service: MemoryService, id: string, revision: number, includeQuote: boolean) {
  const source = service.getDotsRevisionSource(id, revision);
  if (!source || isSensitive(source.quote)) return includeQuote ? { status: "该版本无可核对的原话" } : undefined;
  return {
    author: "用户", messageId: source.messageId, capturedAt: source.capturedAt, stance: source.stance,
    applicability: source.applicability,
    ...(includeQuote ? { verbatimExcerpt: source.quote } : {}),
  };
}

export function createMemoryExtension(bridge: MemoryExtensionBridge): ExtensionFactory {
  const dotsLimits = () => bridge.taskId === DOTS_TASK_ID ? bridge.dotsMemoryLimits?.() ?? defaultDotsMemoryLimits : undefined;
  const readable = (tool: "memory_search" | "memory_get" | "memory_history"): void => {
    if (bridge.canRead?.(tool) === false) throw new Error("当前会话不能读取长期记忆");
  };
  const writable = (): void => {
    if (bridge.readOnly) throw new Error("当前会话为只读，不能修改长期记忆");
    if (bridge.canWrite?.() === false) throw new Error("当前会话不能修改长期记忆");
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
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: bridge.taskId === DOTS_TASK_ID ? dotsMemoryLimitFields.searchMaxResults.max : 30 })),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { query?: string; kind?: MemoryKind; status?: MemoryStatus; limit?: number }) => {
        try {
          readable("memory_search");
          const limits = dotsLimits();
          const hits = await bridge.service.searchHybrid({
            ...context(),
            query: params.query,
            kinds: params.kind ? [params.kind] : undefined,
            statuses: params.status ? [params.status] : ["active"],
            includeInherited: true,
            limit: limits ? Math.min(params.limit ?? limits.searchDefaultResults, limits.searchMaxResults) : params.limit ?? 10,
          });
          readable("memory_search");
          if (limits) {
            const matches = hits.flatMap(({ memory }) => {
              const current = bridge.service.getForRecall(memory.id, context());
              const revision = bridge.service.history(memory.id)[0]?.revision;
              if (!current || !revision || current.status !== memory.status || current.contentHash !== memory.contentHash) return [];
              return [{ id: current.id, revision, title: current.title, status: current.status,
                source: dotsToolSource(bridge.service, current.id, revision, false),
                excerpt: current.content.slice(0, limits.searchPreviewChars), hasMore: current.content.length > limits.searchPreviewChars }];
            });
            return textResult(JSON.stringify({ matches }), { count: matches.length, hits: matches.map(({ id, revision }) => ({ id, revision })) });
          }
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
          readable("memory_get");
          const native = bridge.service.usesCoreRecall;
          const saved = native ? await bridge.service.readCurrentCoreMemory(params.id, context()) : undefined;
          if (native && !saved) throw new Error("记忆不存在或不属于当前任务可见作用域");
          readable("memory_get");
          const memory = saved?.memory ?? requireVisible(params.id);
          const revision = saved?.revision ?? bridge.service.history(memory.id)[0]?.revision ?? 0;
          const dotsSource = !native && bridge.taskId === DOTS_TASK_ID ? dotsToolSource(bridge.service, memory.id, revision, true) : undefined;
          return textResult([
            short(memory),
            `revision=${revision}`,
            ...(bridge.taskId === DOTS_TASK_ID ? [`[L1 ${memory.id}@${revision}]`] : []),
            `完整内容：${memory.content || "（无）"}`,
            `source=${memory.sourceType}${memory.sourceTaskId ? ` task=${memory.sourceTaskId}` : ""} explicit=${memory.explicit}`,
            dotsSource ? `本修订出处=${JSON.stringify(dotsSource)}` : `evidence=${memory.evidence.map((e) => `${e.evidenceKind}:${e.refTitle ?? e.refId}`).join(" | ") || "（无）"}`,
            `relations=${memory.relations.map((r) => `${r.fromMemoryId === memory.id ? "→" : "←"}${r.relation}:${r.fromMemoryId === memory.id ? r.toMemoryId : r.fromMemoryId}`).join(" | ") || "（无）"}`,
          ].join("\n"), dotsSource ? { memory: { ...memory, evidence: [] }, revision, source: dotsSource }
            : native ? { memory: { ...memory, metadata: {} }, revision } : { memory });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_create",
      label: "长期记忆 · 沉淀",
      description: "沉淀长期有价值的认知。默认 scope 由宿主绑定：后台委托使用持久 Work，团队使用 Team，个人 Bot 使用 Bot；普通任务选择 Project > Workspace > Task。Work 可记录跨轮需要的进展、决策与未决项，不保存冗长工具日志。Global 只应保存跨项目稳定身份、偏好、约束或通用 procedure。"
        + (bridge.taskId === DOTS_TASK_ID ? " Dots 专属记忆由宿主写入 task:mybuddy-dots；项目或工作空间仅填 applicability，请省略 scopeType。用户明确要求全局时才传 scopeType=global、applicability.kind=general。content 与 sourceQuote 用规则原文，applicability.evidence 引用范围原话。两段可以来自相邻句。同一原话重复创建会返回同一记忆。" : ""),
      promptSnippet: "memory_create(kind,title,content?,importance?,confidence?,scopeType?) — 沉淀长期认知",
      parameters: Type.Object({
        kind: kindSchema,
        title: Type.String({ minLength: 1, maxLength: 240 }),
        content: Type.Optional(Type.String({ maxLength: 6000 })),
        ...(bridge.taskId === DOTS_TASK_ID ? {
          sourceQuote: Type.Optional(Type.String({ description: "本轮用户发言中支持这一项规则的逐字引文；范围声明可单独放在 applicability.evidence", maxLength: 1200 })),
          applicability: dotsApplicabilitySchema,
        } : {}),
        importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        scopeType: Type.Optional(scopeSchema),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { kind: MemoryKind; title: string; content?: string; sourceQuote?: unknown; applicability?: unknown; importance?: number; confidence?: number; scopeType?: MemoryScopeType }) => {
        try {
          writable();
          const inferred = bridge.service.inferAgentScope(bridge.taskId);
          let scope = inferred;
          if (params.scopeType === "global") {
            if (!["identity", "preference", "constraint", "procedure"].includes(params.kind)) throw new Error("Agent 不应把项目事实/决策直接提升为 Global；请使用当前项目/工作空间 scope");
            scope = { scopeType: "global" };
          } else if (bridge.taskId === DOTS_TASK_ID && (params.scopeType === "workspace" || params.scopeType === "project")) {
            // Older tool calls may repeat the applicability as a storage scope.
            // Keep Dots' private binding and let the evidence validator verify the applicability.
            if (!params.applicability || typeof params.applicability !== "object" ||
                !("kind" in params.applicability) || params.applicability.kind !== params.scopeType)
              throw new Error("Dots 专属记忆请省略 scopeType，用 applicability 提供项目或工作空间及其范围原话");
          } else if (params.scopeType === "project" && inferred.scopeType === "work") {
            const project = bridge.service.resolveScopeChain({ taskId: bridge.taskId }).find(item => item.scopeType === "project");
            if (!project || !bridge.service.canPromoteFromTask(bridge.taskId, "project", project.scopeId)) throw new Error("当前 Work 没有绑定项目");
            scope = { scopeType: "project", scopeId: project.scopeId };
          } else if (params.scopeType && params.scopeType !== inferred.scopeType) {
            // Explicit promotion is a separate auditable operation; create cannot silently jump scope.
            throw new Error(`当前默认写入 scope=${inferred.scopeType}；跨 scope 请先创建，再用 memory_promote 显式提升`);
          }
          const source = bridge.sourceInput?.();
          const memory = bridge.service.createFromTask({
            kind: params.kind,
            title: params.title,
            content: params.content,
            importance: params.importance,
            confidence: params.confidence ?? 0.82,
            sourceType: "agent",
            sourceTaskId: bridge.taskId,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            evidence: source ? [{ evidenceKind: "message", refId: source.messageId, excerpt: source.text.slice(0, 1200) }]
              : [{ evidenceKind: "task", refId: bridge.taskId }],
          }, source, typeof params.sourceQuote === "string" ? params.sourceQuote : undefined, params.applicability);
          const scopeUnresolved = dotsRecordApplicability(memory)?.kind === "unresolved";
          const label = scopeUnresolved ? "已保存待确认原话" : "已保存记忆";
          const exactText = bridge.taskId === DOTS_TASK_ID && params.content?.trim() !== memory.content
            ? `\n实际保存的是用户原话，回复请按此确认。\n${memory.content}` : "";
          return textResult(`${label} ${short(memory)}${exactText}`, { memory, outcome: scopeUnresolved ? "scope_unresolved" : "saved" });
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
        ...(bridge.taskId === DOTS_TASK_ID ? {
          sourceQuote: Type.Optional(Type.String({ description: "本轮用户发言中支持本次修改的逐字引文", maxLength: 1200 })),
          applicability: dotsApplicabilitySchema,
        } : {}),
        status: Type.Optional(statusSchema),
        importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      }, { additionalProperties: false }),
      execute: async (_id: string, params: { id: string; title?: string; content?: string; sourceQuote?: unknown; applicability?: unknown; status?: MemoryStatus; importance?: number; confidence?: number }) => {
        try {
          writable(); requireVisible(params.id);
          const revision = bridge.taskId === DOTS_TASK_ID ? bridge.service.history(params.id)[0]?.revision : undefined;
          const { sourceQuote, applicability, ...update } = params;
          const memory = bridge.service.updateFromTask(bridge.taskId, { ...update, changedBy: "agent", changeReason: `agent task ${bridge.taskId}` }, bridge.sourceInput?.(), typeof sourceQuote === "string" ? sourceQuote : undefined, applicability);
          if (memory.id !== params.id) {
            const scope = bridge.taskId === DOTS_TASK_ID ? dotsRecordApplicability(memory) : undefined;
            return textResult(
              `已单独保存${scope?.kind === "unresolved" ? "待明确适用范围的原话" : scope ? "有适用条件的例外" : "来源说明"}（${memory.id}）。原记忆（${params.id}）仍然有效。\n${short(memory)}`,
              { memory, originalId: params.id, newId: memory.id, outcome: scope?.kind === "unresolved" ? "scope_unresolved" : scope ? "scope_exception_created" : "source_note_created" });
          }
          if (revision !== undefined && bridge.service.history(params.id)[0]?.revision === revision) {
            return textResult(`记忆现有版本未发生变化。\n${short(memory)}`, { memory, outcome: "unchanged" });
          }
          return textResult(`已更新：${short(memory)}`, { memory });
        } catch (error) { return errorResult(error); }
      },
    });

    pi.registerTool({
      name: "memory_promote",
      label: "长期记忆 · 提升作用域",
      description: "把同一条 Memory 绑定到更高作用域，不复制正文。Workspace 记忆可提升到直接父 Workspace；当前 Project/Workspace/Task 记忆可在明确需要跨项目复用时提升 Global（仅 identity/preference/constraint/procedure）。Dots 的待确认原话及项目或工作空间例外无法提升。",
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
          const condition = bridge.taskId === DOTS_TASK_ID ? dotsRecordApplicability(memory) : undefined;
          if (condition?.kind === "unresolved") throw new Error("无法提升：这条记忆的适用范围尚未确认");
          if (condition) throw new Error(`无法提升：这条记忆仅适用于${condition.kind === "project" ? "项目" : "工作空间"}「${condition.name}」`);
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

    if (bridge.sourceInput) pi.registerTool({
      name: "memory_forget", label: "长期记忆 · 遗忘",
      description: "用户明确要求遗忘时，搜索确认所指记忆 ID 后移除该记忆在当前可见作用域的绑定。多范围记录必须指定要移除的 scopeType。重复保存应复用创建回执。",
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }), scopeType: Type.Optional(scopeSchema) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        try {
          writable();
          const source = bridge.sourceInput?.();
          const clauses = source && MemoryInstructionDocument.parse(source.text).removalIntents().filter(intent => intent.kind === "forget");
          if (!source || !clauses?.length) throw new Error("未移除记忆：本轮用户没有明确要求遗忘");
          const memory = requireVisible(params.id);
          const chain = bridge.service.resolveScopeChain(context());
          const scopes = memory.scopes.filter(scope => (!params.scopeType || params.scopeType === scope.scopeType)
            && chain.some(item => item.scopeType === scope.scopeType && item.scopeId === scope.scopeId));
          if (scopes.length !== 1) throw new Error("请选择唯一的可见记忆作用域");
          bridge.service.assertMemoryWritable(memory.id);
          const result = bridge.service.detachScope(memory.id, scopes[0].scopeType, scopes[0].scopeId,
            { ...source, requestClauses: clauses.map(intent => intent.clause) });
          return textResult("已从所选范围移除记忆", { id: memory.id, ...result });
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
          readable("memory_history");
          requireVisible(params.id);
          const history = bridge.service.history(params.id);
          const previewChars = dotsLimits()?.historyPreviewChars ?? 300;
          return textResult(history.length ? history.map((r) => `r${r.revision} ${new Date(r.createdAt).toISOString()} [${r.status}] ${r.title} — ${r.content.slice(0, previewChars)} (${r.changedBy}${r.changeReason ? `, ${r.changeReason}` : ""})`).join("\n") : "暂无 revision。", { history });
        } catch (error) { return errorResult(error); }
      },
    });
  };
}
