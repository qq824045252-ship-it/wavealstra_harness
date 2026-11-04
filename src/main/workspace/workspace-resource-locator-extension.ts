/**
 * WorkspaceResourceLocatorExtension — R1 minimal + R3.6 mode auto/lexical/semantic
 * 冻结契约：
 * - 与 Library 工具共用任务范围：当前项目、当前/祖先 Workspace 资料及显式引用
 * - explicitDirectChild 仅 direct child + !effectiveArchived 时临时加入
 * - Search != Injection：仅返回轻量 hit，不改 PromptAssembly
 * - Source of Truth：真实 Library，索引非事实源
 * - R3.6：search_workspace_resources 增加 mode 参数，复用 locator.search/searchAsync，默认 auto
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkspaceResourceLocator } from "./WorkspaceResourceLocator";

export interface WorkspaceResourceLocatorBridge {
  locator: WorkspaceResourceLocator;
  taskId?: string;
  resolveProjectId?: () => string | null;
}

export function createWorkspaceResourceLocatorExtension(
  bridge: WorkspaceResourceLocatorBridge,
): ExtensionFactory {
  const locator = bridge.locator;

  const paramsSchema = Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 200 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      explicitDirectChildSpaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("lexical"), Type.Literal("semantic")])),
    },
    { additionalProperties: false },
  );

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "search_workspace_resources",
      label: "工作空间 · 搜索资源",
      description:
        "在与 library_list / library_read 相同的任务范围搜索资料：当前项目、当前及祖先工作空间的自有资料、显式绑定和任务/项目引用。默认不搜未引用的兄弟/子空间；可传 explicitDirectChildSpaceId 临时扩展直属且未归档的子空间。只返回轻量定位（id/space/title/filename/preview/matchedBy/score/freshness，semantic 仅定位 score=relevance），不含全文；命中后需用 library_read 读取原件，临时子空间命中须传相同 explicitDirectChildSpaceId。中文/中英混合走 FTS5 trigram。mode=auto(默认 lexical-first+controlled semantic fallback) | lexical | semantic。\n\nSemantic similarity only indicates retrieval relevance. It is not evidence that the resource is correct. Read the underlying source before relying on it. 语义相似度只是“可能相关”，不是事实置信度。",
      promptSnippet:
        "search_workspace_resources(query, mode?, limit?, explicitDirectChildSpaceId?) — 统一任务范围内检索资料（项目 + 工作空间 + 显式引用，mode 默认 auto）",
      parameters: paramsSchema,
      execute: async (
        _toolCallId: string,
        params: { query: string; limit?: number; explicitDirectChildSpaceId?: string; mode?: "auto" | "lexical" | "semantic" },
      ) => {
        const started = Date.now();
        try {
          const taskId = bridge.taskId;
          const mode = params.mode ?? "auto";
          const req: any = {
            query: params.query,
            taskId: taskId ?? null,
            limit: params.limit,
            explicitDirectChildSpaceId: params.explicitDirectChildSpaceId ?? null,
            mode,
          };
          const result =
            mode === "auto" || mode === "semantic"
              ? await (locator as any).searchAsync(req)
              : locator.search(req);
          const semanticTelemetry = (result as any).semanticTelemetry ?? null;
          const telemetry = {
            durationMs: Date.now() - started,
            resultCount: result.hits.length,
            provider: "library" as const,
            providerDurations: result.providerDurations,
            scopeSize: result.scopeSpaceIds.length,
            scopeSpaceIds: result.scopeSpaceIds,
            // R3 telemetry (no query/body/vector logged)
            semanticTriggered: semanticTelemetry?.semanticTriggered ?? (mode !== "lexical"),
            semanticTriggerReason: semanticTelemetry?.semanticTriggerReason ?? null,
            semanticAvailable: semanticTelemetry?.semanticAvailable ?? null,
            semanticModelVersion: semanticTelemetry?.semanticModelVersion ?? null,
            semanticCandidateCount: semanticTelemetry?.semanticCandidateCount ?? 0,
            semanticAcceptedCount: semanticTelemetry?.semanticAcceptedCount ?? 0,
            semanticDurationMs: semanticTelemetry?.semanticDurationMs ?? 0,
          };
          const lines = [
            `Workspace 搜索「${params.query}」完成（${telemetry.durationMs}ms，mode=${mode}，scope ${telemetry.scopeSize} 空间，${telemetry.resultCount} 条）：`,
            ...result.hits.map(
              (h: any) =>
                `- [${h.provider}/${h.matchedBy}] ${h.title} · id=${h.id} · space=${h.spaceId} · score=${h.score} · preview=${h.preview || "(title/filename 命中)"}${h.location ? " · " + h.location : ""}`,
            ),
            result.hits.length === 0 ? "（无匹配）" : "",
            params.explicitDirectChildSpaceId
              ? `提示：命中仅为定位；读取临时子空间命中时请调用 library_read(id, explicitDirectChildSpaceId=${JSON.stringify(params.explicitDirectChildSpaceId)})，不会持久扩大任务范围。`
              : "提示：命中仅为定位，需用 library_read(id) 读取真实正文；Source of Truth 为 Library 原件。",
          ];
          return {
            content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
            details: { hits: result.hits, telemetry, scopeSpaceIds: result.scopeSpaceIds, mode },
          } as any;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `[search_workspace_resources] ${msg}` }],
            isError: true as const,
            details: { error: msg },
          } as any;
        }
      },
    });
  };
}
