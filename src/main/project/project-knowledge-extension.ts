/**
 * ProjectKnowledgeExtension — 项目知识检索工具（RAG 基础面，task 作用域）。
 *
 * 作用域：taskId 由主进程解析，与 Library 工具共用项目、工作空间及显式引用范围，
 * 拒绝跨项目；readonly 权限允许读（本组工具只读）。瞬时会话（团队/BTW）不注册。
 * 检索是按需工具，绝不把整个资料库灌进 prompt；explicit/pinned 命中只做分层标注。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LibraryItemKind } from "../../shared/library-ipc";
import {
  KNOWLEDGE_SNIPPET_MAX_CHARS,
  KNOWLEDGE_READ_MAX_CHARS,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  type ProjectKnowledgeRetrieval,
} from "./ProjectKnowledgeRetrieval";

export interface ProjectKnowledgeExtensionBridge {
  retrieval: ProjectKnowledgeRetrieval;
  taskId: string;
}

class KnowledgeToolError extends Error {}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof KnowledgeToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_knowledge] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

const TIER_LABEL: Record<string, string> = {
  "task-explicit": "（已附加到本任务，见上方引用）",
  pinned: "（已固定到项目上下文，见上方引用）",
  plain: "",
};

export function createProjectKnowledgeExtension(bridge: ProjectKnowledgeExtensionBridge): ExtensionFactory {
  const retrieval = bridge.retrieval;

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_knowledge_search",
      label: "项目知识 · 检索",
      description:
        "在与 library_list / library_read 相同的当前任务范围检索资料（当前项目、工作空间及显式引用；无归属独立任务使用个人资料；绝不含其他项目）。" +
        `返回结构化命中：标题/类型/片段（≤${KNOWLEDGE_SNIPPET_MAX_CHARS} 字符）/分层标注（已附加到本任务 / 已固定到项目上下文）/读取方式。` +
        "文本类（markdown/html/csv）可用 project_knowledge_read 读取正文；PDF/Office/图片只给元数据与受管路径，需要文件/预览工具。检索是按需的，不会把整个资料库注入上下文。",
      promptSnippet: `project_knowledge_search(query, limit?, kind?) — 检索当前任务可见的项目知识（FTS + 元数据 + 分层标注）`,
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KNOWLEDGE_SEARCH_MAX_LIMIT })),
          kind: Type.Optional(
            Type.Union(
              (["markdown", "html", "csv", "office", "pdf", "image", "file"] as LibraryItemKind[]).map((k) =>
                Type.Literal(k),
              ) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]],
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _toolCallId: string,
        params: { query: string; limit?: number; kind?: LibraryItemKind },
      ) => {
        try {
          const result = retrieval.search(bridge.taskId, params.query, {
            limit: params.limit,
            kind: params.kind,
          });
          const scopeLine = {
            project: "（范围：当前项目、工作空间及显式引用）",
            workspace: "（范围：当前工作空间、继承资料及显式引用）",
            personal: "（范围：个人资料，独立任务）",
            none: "（范围：无，当前任务或归属不可用）",
          }[result.scope];
          if (result.hits.length === 0) {
            return textResult(`项目知识检索「${params.query}」无命中${scopeLine}。`);
          }
          const lines = [
            `项目知识检索「${params.query}」${scopeLine}（${result.hits.length} 条命中）：`,
            ...result.hits.map((hit) => {
              const readHint = hit.readable
                ? "文本，可 project_knowledge_read"
                : "非文本，需文件/预览工具（只读元数据）";
              const snippet = hit.snippet ? `｜片段：${hit.snippet}` : "";
              return (
                `- [${hit.kind}] ${hit.title} · id=${hit.itemId} · ${readHint}${TIER_LABEL[hit.tier] ?? ""}${snippet}` +
                (hit.sourceTaskId ? `（来源任务 ${hit.sourceTaskId}）` : "")
              );
            }),
          ];
          return textResult(lines.join("\n"), { ...result, snippetMax: KNOWLEDGE_SNIPPET_MAX_CHARS });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_knowledge_read",
      label: "项目知识 · 读取",
      description:
        "读取当前任务可见范围内资料条目的内容。文本类（markdown/html/csv）返回正文（截断上限 " +
        `${KNOWLEDGE_READ_MAX_CHARS} 字符）；PDF/Office/图片/未知文件返回结构化元数据（类型/大小/受管路径/来源）——` +
        "这些是非文本资产，需要文件/预览工具读取，资料库不提供内联全文；URL 返回链接。跨项目条目不可访问。",
      promptSnippet: `project_knowledge_read(id) — 读取可见资料条目（文本类内联，二进制类返回受管路径元数据）`,
      parameters: Type.Object(
        { id: Type.String({ minLength: 1, maxLength: 100 }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { id: string }) => {
        try {
          const result = await retrieval.read(bridge.taskId, params.id);
          if (result.requiresFileAccess) {
            const lines = [
              `[${result.item.kind}] ${result.item.title}（id=${result.item.id}）`,
              `类型：${result.item.kind}｜MIME：${result.item.mimeType || "未知"}｜大小：${result.item.sizeBytes} 字节`,
              `受管路径：${result.managedPath ?? "（无）"}`,
              result.item.sourceType
                ? `来源：${result.item.sourceType}${result.item.sourceTaskId ? `（任务 ${result.item.sourceTaskId}）` : ""}${result.item.sourceArtifactId ? ` 产物 ${result.item.sourceArtifactId}` : ""}`
                : "",
              "该条目是非文本资产：资料库不提供内联全文。需要内容时请用文件工具读取受管路径，或让用户用预览/Office 打开。",
            ];
            return textResult(lines.filter(Boolean).join("\n"), { item: result.item, managedPath: result.managedPath, materialKind: "metadata" });
          }
          if (result.url) {
            return textResult(`[url] ${result.item.title}\n链接：${result.url}`, { item: result.item, materialKind: "metadata" });
          }
          const prefix = `[${result.item.kind}] ${result.item.title}（id=${result.item.id}）${TIER_LABEL[result.tier] ?? ""}\n\n`;
          return textResult(`${prefix}${result.content}`, { item: result.item, truncated: result.truncated, materialKind: "content" });
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}
