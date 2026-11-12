import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ConversationId, type EntryId, type EntryRecord, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ContextManagementSummaryDto } from "../../../../shared/context-management";
import { entryText, type DurableContextManager, type ToolReader } from "./DurableContextManager";

/** Fixed namespace shared with foreground tool policies; never admit arbitrary acp_* tools. */
const CONTEXT_TOOL_NAMES = new Set(["acp_status", "acp_search", "acp_retrieve", "acp_compress"]);
export function isDurableContextToolName(name: string): boolean { return CONTEXT_TOOL_NAMES.has(name); }

const StatusParams = Type.Object({}, { additionalProperties: false });
const SearchParams = Type.Object({
  query: Type.String({ description: "Keywords to look for. Summaries are searched first; originals are matched literally." }),
  scope: Type.Optional(Type.Union([Type.Literal("summaries"), Type.Literal("originals"), Type.Literal("all")], {
    description: "summaries: folded section summaries; originals: exact committed transcript entries; all (default): both.",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  beforeEntryId: Type.Optional(Type.Integer({ minimum: 1, description: "Continue an original-history search using nextBeforeEntryId from the previous page." })),
}, { additionalProperties: false });
const RetrieveParams = Type.Object({
  ref: Type.Optional(Type.String({ description: "Message ref seen in a compressed summary or status, such as m00042." })),
  blockId: Type.Optional(Type.String({ description: "Summary block id (b3) to read its original messages." })),
  entryId: Type.Optional(Type.Integer({ description: "Committed Durable entry id to read verbatim." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Legacy character offset. Prefer the returned cursor for bounded reads." })),
  cursor: Type.Optional(Type.String({ description: "Continuation cursor returned by acp_retrieve for the same target." })),
  limit: Type.Optional(Type.Integer({ minimum: 200, maximum: 12000, description: "Characters to return (default 8000)." })),
}, { additionalProperties: false });
const CompressParams = Type.Object({
  startRef: Type.String({ description: "First message ref of the range." }),
  endRef: Type.String({ description: "Last message ref of the range." }),
  summary: Type.String({ description: "Summary that replaces every message in the range. Preserve paths, versions, errors, decisions and exact quotes." }),
  topic: Type.Optional(Type.String({ description: "Short topic label for the block." })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Durable view revision observed in acp_status. A stale revision is rejected; omitted binds the view at tool execution." })),
  expectedConfigDigest: Type.Optional(Type.String({ description: "Current configDigest from acp_status; rejects a changed model/window/policy." })),
}, { additionalProperties: false });

export interface DurableContextToolsOptions {
  /** 延迟解析：工具在 Harness.open 前创建；每个 conversation（主会话/子代理/会诊）有自己的协调器。 */
  manager: (conversationId: ConversationId, context: Context) => Promise<DurableContextManager | undefined>;
}

/**
 * 模型可见的上下文管理工具。检索的“摘要”和“原文”分开标注；原文按引用分页读回，不会一次撑爆窗口。
 * 这些工具会随 native 工具集进入 Code Mode 的可用工具列表。
 */
export function createDurableContextTools(options: DurableContextToolsOptions) {
  /** 调用方 conversation 必须有自己的协调器；Code Mode 私有会话没有，会被拒绝。 */
  const managerFor = (api: { conversationId: ConversationId }, context: Context): Promise<DurableContextManager | undefined> =>
    options.manager(api.conversationId, context);
  const guard = <T>(context: Context, fn: () => Promise<T>): Promise<T> => fn();

  const status = defineTool({
    name: "acp_status",
    parameters: StatusParams,
    replay: "safe",
    description: "Show the active context-management engine, current window pressure, folded summary blocks (with refs and original entry ids) and the last operation result. Read-only.",
    execute: async (_params, api, context) => {
      const manager = await managerFor(api, context); if (!manager) return { output: [{ type: "text" as const, text: "该会话没有独立的上下文管理状态。" }] };
      return guard(context, async () => {
        const { state, status: snapshot } = manager.readStatusSnapshot();
        const lines = [
          `engine: ${snapshot.engine}`,
          `enabled: ${snapshot.enabled}`,
          `phase: ${snapshot.phase}${snapshot.reason ? ` (${snapshot.reason})` : ""}`,
          `revision: ${snapshot.revision ?? 0}`,
          `configDigest: ${snapshot.configDigest ?? "unknown"}`,
          `operationId: ${snapshot.operationId ?? "none"}`,
          `contextWindow: ${snapshot.contextWindow}`,
          `triggerTokens: ${snapshot.triggerTokens}`,
          `estimatedInputTokens: ${snapshot.estimatedInputTokens ?? "unknown"}`,
          `lastOperation: ${snapshot.beforeTokens !== undefined ? `${snapshot.beforeTokens} -> ${snapshot.afterTokens ?? "unknown"} tokens` : "none"}`,
          `activeBlocks: ${snapshot.blocks ?? 0}`,
          ...(snapshot.summaries?.length ? ["", "Recent summaries:", ...snapshot.summaries.map(formatSummary)] : []),
          "",
          `highestRef: ${highestAllocatedRef(state)}`,
          snapshot.lastError ? `lastError: ${snapshot.lastError}` : "",
        ].filter(line => line !== undefined && line !== "");
        return { output: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  });

  const search = defineTool({
    name: "acp_search",
    parameters: SearchParams,
    replay: "safe",
    description: "Search compacted history. scope=summaries searches folded section summaries; scope=originals searches the exact committed transcript (bounded page scan); scope=all (default) searches both and labels each hit. Use the returned refs/entryIds with acp_retrieve to read exact original text.",
    execute: async (params, api, context) => {
      const manager = await managerFor(api, context); if (!manager) return { output: [{ type: "text" as const, text: "该会话没有独立的原文检索状态。" }] };
      return guard(context, async () => {
        const scope = params.scope ?? "all";
        const limit = params.limit ?? 8;
        const lines: string[] = [];
        if (scope !== "originals") {
          const summaries = await manager.searchSummaries(params.query, limit, context);
          if (summaries.length) {
            lines.push("## Summary hits (compressed sections, not verbatim)");
            for (const hit of summaries) {
              lines.push(`- ${hit.blockId}${hit.topic ? ` [${hit.topic}]` : ""} · refs ${hit.refs || "?"} · entries ${hit.entryIds.join(",") || "?"}\n  ${excerpt(hit.summary, 400)}`);
            }
          }
        }
        if (scope !== "summaries") {
          const page = await searchOriginalEntries(api, params.query, limit, context, params.beforeEntryId);
          const originals = page.hits;
          if (originals.length) {
            lines.push("## Original hits (verbatim committed transcript)");
            for (const hit of originals) {
              hit.refs = manager.refsForEntry(hit.entryId);
              lines.push(`- entry ${hit.entryId} · ${hit.kind}${hit.refs.length ? ` · refs ${hit.refs.join(",")}` : ""}\n  ${excerpt(hit.text, 400)}`);
            }
          }
          if (page.nextBeforeEntryId !== undefined) lines.push(`[Search incomplete: scanned ${page.scanned} entries. Continue acp_search with the same query and beforeEntryId=${page.nextBeforeEntryId}.]`);
        }
        if (!lines.length) lines.push(`No matches for ${JSON.stringify(params.query)}. Try acp_status to see folded ranges, or narrower keywords.`);
        return { output: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  });

  const retrieve = defineTool({
    name: "acp_retrieve",
    parameters: RetrieveParams,
    replay: "safe",
    description: "Read exact original messages by ref, summary block id, or Durable entry id. Results are paged (offset/limit, default 8000 chars) and labeled as original transcript. A summary can never substitute for this text.",
    execute: async (params, api, context) => {
      const manager = await managerFor(api, context); if (!manager) return { output: [{ type: "text" as const, text: "该会话没有独立的原文检索状态。" }] };
      return guard(context, async () => {
        if (params.ref === undefined && params.blockId === undefined && params.entryId === undefined) {
          return { output: [{ type: "text" as const, text: "请至少提供 ref、blockId 或 entryId 之一。" }], isError: true };
        }
        const result = await manager.retrieveOriginal(params, createEntryReader(api), context);
        if (!result.text && !result.entryIds.length) {
          return { output: [{ type: "text" as const, text: `没有找到 ${describeTarget(params)} 对应的原文。引用可能来自更早的摘要代次或已不存在的分支；先用 acp_search scope=originals 搜索。` }], isError: true };
        }
        const page = result.page;
        const header = `[source: original Durable entries ${result.entryIds.join(", ")}${page ? ` · chars ${page.offset}–${page.offset + result.text.length} of ${page.total ?? "unknown"}` : ""}]`;
        const footer = page?.nextCursor
          ? `\n\n[truncated; call acp_retrieve again for the same target with cursor=${JSON.stringify(page.nextCursor)} to read the next page]`
          : "";
        return { output: [{ type: "text" as const, text: `${header}\n\n${result.text}${footer}` }] };
      });
    },
  });

  const compress = defineTool({
    name: "acp_compress",
    parameters: CompressParams,
    replay: "unsafe",
    description: "Fold an old, contiguous range of messages into one summary. Only call this for work that is finished and no longer needed verbatim; the original text stays retrievable through acp_retrieve. Use acp_status for currently viable refs.",
    execute: async (params, api, context) => {
      const manager = await managerFor(api, context); if (!manager) return { output: [{ type: "text" as const, text: "该会话没有独立的上下文管理状态。" }] };
      return guard(context, async () => {
        const result = await manager.applyModelCompression(params, context);
        return { output: [{ type: "text" as const, text: result.message }], ...(result.ok ? {} : { isError: true }) };
      });
    },
  });

  return [status, search, retrieve, compress];
}

function describeTarget(input: { ref?: string; blockId?: string; entryId?: number }): string {
  if (input.ref) return `ref ${input.ref}`;
  if (input.blockId) return `block ${input.blockId}`;
  return `entry ${input.entryId}`;
}

function formatSummary(summary: ContextManagementSummaryDto): string {
  return `- ${summary.blockId}${summary.topic ? ` [${summary.topic}]` : ""} · refs ${summary.refs || "?"} · entries ${summary.entryIds.join(",") || "?"} · ~${summary.tokens} tokens`;
}

function highestAllocatedRef(state: { messageRefs?: { byRef?: Record<string, string> } } | undefined): string {
  const refs = Object.keys(state?.messageRefs?.byRef ?? {});
  if (!refs.length) return "m00000";
  let max = 0;
  for (const ref of refs) {
    const value = Number(ref.slice(1));
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  return `m${String(max).padStart(5, "0")}`;
}

function excerpt(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

type ToolApi = ToolExecutionApi;

/** ToolExecutionApi 只暴露 commit：用一次只读扫描定位指定 entry，保持与 Conversation.entries 相同的可见性。 */
function createEntryReader(api: ToolApi): ToolReader {
  return {
    entry: async (id: number, context: Context): Promise<EntryRecord | undefined> => {
      const page = await api.commit(
        tx => tx.scanEntries({ conversationId: api.conversationId, minEntryId: id as EntryId, maxEntryId: id as EntryId }, 1),
        context,
      );
      return page.items[0];
    },
  };
}

export async function searchOriginalEntries(
  api: ToolApi,
  query: string,
  limit: number,
  context: Context,
  beforeEntryId?: number,
): Promise<{ hits: Array<{ entryId: number; kind: string; text: string; refs: string[] }>; scanned: number; nextBeforeEntryId?: number }> {
  const needle = query.trim().toLowerCase();
  const hits: Array<{ entryId: number; kind: string; text: string; refs: string[] }> = [];
  if (!needle) return { hits, scanned: 0 };
  let before = beforeEntryId;
  let scanned = 0;
  while (scanned < 400 && hits.length < limit) {
    const page = await api.commit(tx => tx.scanEntries({ conversationId: api.conversationId, order: "descending",
      ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }) }, Math.min(100, 400 - scanned)), context);
    for (let index = 0; index < page.items.length; index++) {
      const entry = page.items[index]!;
      scanned++;
      before = entry.id;
      const text = entryText(entry);
      const at = text.toLowerCase().indexOf(needle);
      if (at >= 0) hits.push({ entryId: entry.id, kind: entry.kind, text: text.slice(Math.max(0, at - 120), at + 600), refs: [] });
      if (hits.length >= limit) return { hits, scanned,
        ...(index + 1 < page.items.length || page.next ? { nextBeforeEntryId: before } : {}) };
    }
    if (!page.next || !page.items.length) return { hits, scanned };
  }
  return { hits, scanned, nextBeforeEntryId: before };
}
