import type { WebSearchReport, WebSearchSource } from "./web-search";

/** MyBuddy-owned configuration and persisted provider data. Neither namespace is
 * a DeepSeek request parameter; the native adapter translates it at the boundary. */
export interface DeepSeekNativeOptions {
  webSearch?: boolean;
  readUrl?: boolean;
  files?: "text" | "rich";
}

export interface DeepSeekAssistantMetadata {
  version: 1;
  baseUrl: string;
  model: string;
  credentialTag: string;
  serverToolCalls?: unknown[];
  annotations?: unknown[];
  serverToolEvents?: unknown[];
  reasoningContent?: string;
  title?: string;
  serverToolUsage?: Record<string, unknown>;
  /** Complete provider output, including opaque signatures and ordinary calls.
   * These stay in the transcript; the renderer receives only derived rows. */
  responsesOutput?: unknown[];
  anthropicContent?: unknown[];
  fileUploads?: DeepSeekFileProgress[];
}

export interface DeepSeekFileProgress {
  id: string;
  name: string;
  purpose: "user_data" | "text_recognition" | "rich_layout_recognition";
  status: "preparing" | "uploading" | "ready" | "error";
  reused?: boolean;
  expiresAt?: number;
  message?: string;
}

export function deepseekRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only official Flash endpoints advertise these application features.
 * A DeepSeek-like model name on a gateway is not an API capability declaration. */
export function supportsDeepSeekNative(model: unknown): boolean {
  const value = deepseekRecord(model);
  if (value?.provider !== "deepseek" || value.id !== "deepseek-flash"
    || !["openai-completions", "openai-responses", "anthropic-messages"].includes(String(value.api))) return false;
  try {
    const url = new URL(String(value.baseUrl));
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && (value.api === "anthropic-messages" ? ["/anthropic", "/anthropic/"] : ["", "/", "/v1", "/v1/"]).includes(url.pathname);
  } catch { return false; }
}

export function deepseekNativeOptions(model: unknown): DeepSeekNativeOptions {
  if (!supportsDeepSeekNative(model)) return {};
  const compat = deepseekRecord(deepseekRecord(model)?.compat);
  const value = deepseekRecord(compat?.mybuddyDeepSeek);
  return {
    ...(value?.webSearch === true ? { webSearch: true } : {}),
    ...(value?.readUrl === true ? { readUrl: true } : {}),
    ...(value?.files === "text" || value?.files === "rich" ? { files: value.files } : {}),
  };
}

export function deepseekAssistantMetadata(message: unknown): DeepSeekAssistantMetadata | undefined {
  const value = deepseekRecord(deepseekRecord(message)?.mybuddyDeepSeek);
  return value?.version === 1 && typeof value.baseUrl === "string" && typeof value.model === "string"
    && typeof value.credentialTag === "string" ? value as unknown as DeepSeekAssistantMetadata : undefined;
}

function citationLink(value: unknown): { url: string; title: string } | undefined {
  const citation = deepseekRecord(value);
  if (typeof citation?.url !== "string") return;
  try {
    const url = new URL(citation.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return { url: url.href, title: typeof citation.title === "string" && citation.title.trim() ? citation.title : url.hostname };
  } catch { return; }
}

/** Presentation only. Keep citation offsets and the original answer unchanged in
 * the model transcript, and never expose encrypted page signatures to the UI. */
export function deepseekCitationMarkdown(message: unknown): string {
  const annotations = deepseekAssistantMetadata(message)?.annotations;
  if (!Array.isArray(annotations)) return "";
  const citations = new Map<string, { url: string; title: string; excerpts: string[] }>();
  const blocks = deepseekRecord(message)?.content;
  const answer = Array.isArray(blocks) ? blocks.flatMap(block => {
    const value = deepseekRecord(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("") : "";
  const points = [...answer];
  for (const annotation of annotations) {
    const value = deepseekRecord(annotation);
    if (value?.type !== "url_citation") continue;
    const raw = deepseekRecord(value.url_citation);
    const citation = citationLink(raw);
    if (!citation) continue;
    const start = raw?.start_index; const end = raw?.end_index;
    const excerpt = typeof raw?.cited_text === "string" ? raw.cited_text
      : Number.isInteger(start) && Number.isInteger(end) && Number(start) >= 0 && Number(end) > Number(start) && Number(end) <= points.length
        ? points.slice(Number(start), Number(end)).join("") : "";
    const existing = citations.get(citation.url) ?? { ...citation, excerpts: [] };
    if (excerpt && !existing.excerpts.includes(excerpt)) existing.excerpts.push(excerpt);
    citations.set(citation.url, existing);
  }
  if (!citations.size) return "";
  const plain = (text: string) => text.replace(/[\\`*_{}[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return "\n\n参考来源：\n" + [...citations.values()].map(({ url, title, excerpts }) =>
    `- [${plain(title)}](<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)${excerpts.length ? ` — 对应回答：${excerpts.map(text => `“${plain([...text].slice(0, 160).join(""))}${[...text].length > 160 ? "…" : ""}”`).join("；")}` : ""}`).join("\n");
}

export interface DeepSeekHostedToolRow {
  id: string;
  tool: string;
  summary: string;
  status: "running" | "success" | "error";
  output?: string;
  webSearch?: WebSearchReport;
}

/** Hosted operations are display rows, never Pi toolCall blocks. */
export function deepseekHostedToolRows(message: unknown, streaming = false): DeepSeekHostedToolRow[] {
  const metadata = deepseekAssistantMetadata(message);
  if (!metadata) return [];
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of Array.isArray(metadata.serverToolEvents) ? metadata.serverToolEvents : []) {
    const call = deepseekRecord(deepseekRecord(event)?.call);
    if (typeof call?.id === "string") calls.set(call.id, { ...calls.get(call.id), ...call });
  }
  for (const step of Array.isArray(metadata.serverToolCalls) ? metadata.serverToolCalls : []) {
    const values = deepseekRecord(step)?.calls;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const call = deepseekRecord(value);
      if (typeof call?.id === "string") calls.set(call.id, call);
    }
  }
  for (const value of metadata.responsesOutput ?? []) {
    const item = deepseekRecord(value);
    if (item?.type !== "web_search_call" || typeof item.id !== "string") continue;
    calls.set(item.id, { ...item, type: item.kind === "read_link" ? "deepseek_read_url" : "deepseek_web_search",
      sources: deepseekRecord(item.action)?.sources });
  }
  for (const value of metadata.anthropicContent ?? []) {
    const item = deepseekRecord(value);
    if (item?.type === "server_tool_use" && typeof item.id === "string") {
      calls.set(item.id, { ...item, type: item.name, action: { ...deepseekRecord(item.input), type: deepseekRecord(item.input)?.action } });
    }
    if (!["web_search_tool_result", "web_fetch_tool_result"].includes(String(item?.type)) || typeof item?.tool_use_id !== "string") continue;
    const call = calls.get(item.tool_use_id);
    if (!call) continue;
    const results = Array.isArray(item.content) ? item.content : [item.content];
    const error = results.map(deepseekRecord).find(result => String(result?.type).endsWith("_error"));
    const page = deepseekRecord(item.content);
    calls.set(item.tool_use_id, { ...call, status: error ? "failed" : "completed",
      ...(item.type === "web_search_tool_result" ? { sources: results } : { page: { url: page?.url, title: deepseekRecord(page?.content)?.title, published_at: page?.published_at } }),
      ...(error ? { error: { code: error.error_code } } : {}) });
  }
  const rows = [...calls.values()].flatMap(call => {
    if (call.type !== "deepseek_web_search" && call.type !== "deepseek_read_url") return [];
    const action = deepseekRecord(call.action);
    const queries = Array.isArray(action?.queries) ? action.queries.filter(item => typeof item === "string").join("、") : "";
    const detail = queries || (typeof action?.url === "string" ? action.url : "");
    const sources = Array.isArray(call.sources) ? call.sources : call.page ? [call.page] : [];
    const error = deepseekRecord(call.error);
    const incomplete = call.status !== "completed" && call.status !== "failed" && !streaming;
    const output = sources.flatMap(source => {
      const link = citationLink(source);
      return link ? [`${link.title}\n${link.url}`] : [];
    }).join("\n\n") || (incomplete ? "已停止等待，此服务端调用的结果尚未确认；远端可能仍在处理。" : typeof error?.code === "string" ? error.code : "");
    const status = call.status === "failed" || incomplete ? "error" as const : call.status === "completed" ? "success" as const : "running" as const;
    const displaySources: WebSearchSource[] = sources.flatMap(source => {
      const value = deepseekRecord(source); const link = citationLink(source);
      return link ? [{ ...link, snippet: typeof value?.snippet === "string" ? value.snippet : "",
        ...(typeof value?.site_name === "string" ? { siteName: value.site_name } : {}),
        ...(typeof value?.published_at === "string" ? { publishedAt: value.published_at } : {}),
        evidence: "snippet" as const }] : [];
    });
    const id = `deepseek-hosted:${String(call.id)}`;
    const webSearch: WebSearchReport = { version: 1, id, status: status === "running" ? "running" : status === "error" ? "error" : "complete",
      queries: queries ? (action!.queries as unknown[]).filter((query): query is string => typeof query === "string") : detail ? [detail] : [], sources: displaySources,
      runs: [{ query: detail, provider: "deepseek", status: status === "success" ? displaySources.length ? "success" : "empty" : status,
        durationMs: 0, results: displaySources, answer: "", ...(status === "error" ? { error: output } : {}) }],
      notice: "由 DeepSeek 服务端执行；来源信息用于核对，网页原文由模型上下文保留。" };
    return [{ id, tool: call.type,
      summary: `${call.type === "deepseek_web_search" ? "DeepSeek 联网搜索" : "DeepSeek 网页读取"}${detail ? `：${detail}` : ""}`,
      status, webSearch,
      ...(output ? { output } : {}),
    }];
  });
  const files: DeepSeekHostedToolRow[] = (metadata.fileUploads ?? []).map(file => ({ id: `deepseek-file:${file.id}`, tool: "deepseek_file_upload",
    summary: `DeepSeek 附件：${file.name}`, status: file.status === "ready" ? "success" : file.status === "error" || !streaming ? "error" : "running",
    output: file.message ?? (file.status === "preparing" ? "正在核验持久附件与已有上传记录。"
      : file.status === "uploading" ? file.purpose === "user_data" ? "正在上传附件，等待文件就绪。" : "正在上传并解析文档，解析完成后继续回答。"
      : file.status === "ready" ? `${file.reused ? "已复用未过期的服务器文件，未重复上传。" : "文件已就绪，可供本次模型请求引用。"}${file.expiresAt ? `\n服务器副本有效期至 ${new Date(file.expiresAt).toISOString()}` : ""}`
      : "附件处理结果尚未确认，服务器可能仍在处理。") }));
  return [...files, ...rows];
}
