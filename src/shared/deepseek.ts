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
}

export function deepseekRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only the official Flash chat endpoint advertises these application features.
 * A DeepSeek-like model name on a gateway is not an API capability declaration. */
export function supportsDeepSeekNative(model: unknown): boolean {
  const value = deepseekRecord(model);
  if (value?.provider !== "deepseek" || value.id !== "deepseek-flash" || value.api !== "openai-completions") return false;
  try {
    const url = new URL(String(value.baseUrl));
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && ["", "/", "/v1", "/v1/"].includes(url.pathname);
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
  const citations = new Map<string, { url: string; title: string }>();
  for (const annotation of annotations) {
    const value = deepseekRecord(annotation);
    if (value?.type !== "url_citation") continue;
    const citation = citationLink(value.url_citation);
    if (citation) citations.set(citation.url, citation);
  }
  if (!citations.size) return "";
  return "\n\n参考来源：\n" + [...citations.values()].map(({ url, title }) =>
    `- [${title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`).join("\n");
}

export interface DeepSeekHostedToolRow {
  id: string;
  tool: string;
  summary: string;
  status: "running" | "success" | "error";
  output?: string;
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
  return [...calls.values()].flatMap(call => {
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
    return [{ id: `deepseek-hosted:${String(call.id)}`, tool: call.type,
      summary: `${call.type === "deepseek_web_search" ? "DeepSeek 联网搜索" : "DeepSeek 网页读取"}${detail ? `：${detail}` : ""}`,
      status: call.status === "failed" || incomplete ? "error" as const : call.status === "completed" ? "success" as const : "running" as const,
      ...(output ? { output } : {}),
    }];
  });
}
