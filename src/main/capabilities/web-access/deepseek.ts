import { existsSync, readFileSync } from "node:fs";
import { isDeepSeekConnectionConfigured, resolveDeepSeekConnection } from "../providers/DeepSeekConnection";
import { activityMonitor } from "./activity";
import { redactCredential } from "./credential-source";
import type { ExtractedContent } from "./extract";
import type { SearchOptions, SearchResponse } from "./perplexity";
import { loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type Lookup } from "./ssrf-protection";
import { getWebSearchConfigPath } from "./utils";

export interface DeepSeekWebSettings {
  deepseekConnectionId?: string;
  fetchProvider?: "auto" | "deepseek";
}

/** Resolve on every invocation: saving a new binding must also affect existing sessions. */
export function getDeepSeekWebSettings(): DeepSeekWebSettings {
  const path = getWebSearchConfigPath();
  if (!existsSync(path)) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
  } catch { throw new Error("Failed to parse web search configuration"); }
  if (raw.deepseekConnectionId !== undefined && (typeof raw.deepseekConnectionId !== "string" || !/^api-[a-z0-9-]{1,80}$/i.test(raw.deepseekConnectionId))) {
    throw new Error("Invalid DeepSeek service connection configuration");
  }
  if (raw.fetchProvider !== undefined && raw.fetchProvider !== "auto" && raw.fetchProvider !== "deepseek") {
    throw new Error("Invalid web fetch provider configuration");
  }
  return { deepseekConnectionId: raw.deepseekConnectionId as string | undefined, fetchProvider: raw.fetchProvider as DeepSeekWebSettings["fetchProvider"] };
}

export function isDeepSeekAvailable(): boolean {
  return isDeepSeekConnectionConfigured(getDeepSeekWebSettings().deepseekConnectionId);
}

interface DeepSeekWebConnection { baseUrl: string; apiKey: string; timeoutMs: number }
export interface DeepSeekSearchOptions extends SearchOptions {
  includeContent?: boolean;
  connectionId?: string;
}
interface DeepSeekFetchOptions { signal?: AbortSignal; timeoutMs?: number; lookup?: Lookup; connectionId?: string }
interface DeepSeekWebClientOptions {
  resolveConnection: (connectionId?: string) => DeepSeekWebConnection | Promise<DeepSeekWebConnection>;
  fetch?: typeof fetch;
  validateUrl?: (url: URL, options: DeepSeekFetchOptions) => Promise<void>;
  now?: () => number;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DeepSeek returned invalid response: expected an object");
  return value as Record<string, unknown>;
};
function queryText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 128 || value.includes("\0")) {
    throw new Error(`DeepSeek invalid request: ${name} must contain 1 to 128 Unicode characters`);
  }
  return value.trim();
}

/** Translate the existing provider-neutral filters without silently dropping them. */
export function deepSeekSearchQuery(query: string, options: SearchOptions, now = Date.now()): string {
  const parts = [queryText(query, "query")];
  if (options.domainFilter?.length) {
    const include: string[] = [], exclude: string[] = [];
    for (const input of options.domainFilter) {
      const excluded = input.startsWith("-");
      const domain = excluded ? input.slice(1) : input;
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) {
        throw new Error("DeepSeek invalid request: domainFilter must contain hostnames, optionally prefixed with -");
      }
      (excluded ? exclude : include).push(`${excluded ? "-site:" : "site:"}${domain.toLowerCase()}`);
    }
    if (include.length) parts.push([...new Set(include)].join(" OR "));
    if (exclude.length) parts.push(...new Set(exclude));
  }
  if (options.recencyFilter) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[options.recencyFilter];
    if (!days) throw new Error("DeepSeek invalid request: unsupported recency filter");
    parts.push(`after:${new Date(now - days * 86_400_000).toISOString().slice(0, 10)}`);
  }
  return queryText(parts.join(" "), "query including filters");
}

function publicUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || !value || [...value].length > 8192) throw new Error(`DeepSeek invalid request: ${label} is invalid`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`DeepSeek invalid request: ${label} must be an HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || [...url.href].length > 8192) {
    throw new Error(`DeepSeek invalid request: ${label} must be an HTTP(S) URL without credentials`);
  }
  return url;
}

function apiRoot(baseUrl: string): string {
  const url = publicUrl(baseUrl, "service URL");
  if (url.protocol !== "https:" || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("DeepSeek invalid configuration: expected an HTTPS API root");
  }
  return `${url.origin}/v1/tools`;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("DeepSeek returned empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("DeepSeek returned invalid response: body exceeds 16 MiB");
      chunks.push(value);
    }
    signal.throwIfAborted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`DeepSeek API error ${response.status}: returned invalid JSON`); }
  return record(payload);
}

export function createDeepSeekWebClient(dependencies: DeepSeekWebClientOptions) {
  async function request(route: "search" | "fetch", body: Record<string, unknown>, options: DeepSeekFetchOptions): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const connection = await dependencies.resolveConnection(options.connectionId);
    options.signal?.throwIfAborted();
    if (!connection.apiKey?.trim()) throw new Error("DeepSeek API key missing; configure a DeepSeek service in Settings → Tool capabilities");
    if (!Number.isFinite(connection.timeoutMs) || connection.timeoutMs < 1) throw new Error("Invalid DeepSeek timeout configuration");
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? connection.timeoutMs, connection.timeoutMs));
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
    const activityId = activityMonitor.logStart({ type: "api", query: `DeepSeek ${route}: ${route === "search" ? body.query : body.url}` });
    try {
      const response = await (dependencies.fetch ?? fetch)(`${apiRoot(connection.baseUrl)}/${route}`, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await responseJson(response, signal);
      if (!response.ok || payload.error !== undefined) {
        const failure = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : undefined;
        const message = typeof failure?.message === "string" ? failure.message : "request failed";
        throw new Error(`DeepSeek API error ${response.status}: ${message}`);
      }
      signal.throwIfAborted();
      activityMonitor.logComplete(activityId, response.status);
      return payload;
    } catch (error) {
      const message = redactCredential(error instanceof Error ? error.message : String(error), connection.apiKey).slice(0, 500);
      if (signal.aborted) activityMonitor.logComplete(activityId, 0);
      else activityMonitor.logError(activityId, message);
      const failure = new Error(signal.aborted ? options.signal?.aborted ? "DeepSeek request aborted" : "DeepSeek request timed out" : message);
      failure.name = signal.aborted ? options.signal?.aborted ? "AbortError" : "TimeoutError" : "Error";
      throw failure;
    }
  }

  return {
    async search(query: string, options: DeepSeekSearchOptions = {}): Promise<SearchResponse> {
      const count = options.numResults ?? 5;
      if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("DeepSeek invalid request: count must be an integer from 1 to 50");
      const body: Record<string, unknown> = { query: deepSeekSearchQuery(query, options, dependencies.now?.()), count, need_content: options.includeContent === true };
      if (options.originalQuestion !== undefined) body.ori_question = queryText(options.originalQuestion, "original question");
      const payload = await request("search", body, options);
      if (!Array.isArray(payload.results)) throw new Error("DeepSeek returned invalid response: results is missing");
      const results: SearchResponse["results"] = [];
      const inlineContent: ExtractedContent[] = [];
      for (const value of payload.results.slice(0, count)) {
        const item = record(value);
        const url = publicUrl(item.url, "result URL").href;
        if (typeof item.title !== "string" || typeof item.snippet !== "string" || typeof item.summary !== "string" || typeof item.content !== "string") {
          throw new Error("DeepSeek returned invalid response: search result text fields are missing");
        }
        results.push({
          url, title: item.title, snippet: item.snippet, summary: item.summary, evidence: "snippet",
          ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
          ...(typeof item.site_name === "string" ? { siteName: item.site_name } : {}),
          ...(typeof item.site_icon === "string" && /^https?:\/\//i.test(item.site_icon) ? { siteIcon: item.site_icon } : {}),
          ...(typeof item.rerank_score === "number" && Number.isFinite(item.rerank_score) ? { rerankScore: item.rerank_score } : {}),
          ...(typeof item.authority === "number" && Number.isInteger(item.authority) ? { authority: item.authority } : {}),
        });
        // Provider summaries remain summaries. Only the actual content field is page text.
        if (options.includeContent && item.content.trim()) inlineContent.push({ url, title: item.title, content: item.content, error: null, source: "render", provider: "deepseek", mimeType: "text/markdown", status: 200 });
      }
      return { answer: "", results, ...(inlineContent.length ? { inlineContent } : {}) };
    },
    async fetch(urlString: string, options: DeepSeekFetchOptions = {}): Promise<ExtractedContent> {
      const url = publicUrl(urlString, "URL");
      options.signal?.throwIfAborted();
      await (dependencies.validateUrl ?? (async (target, current) => { await validateRemoteUrl(target, { ...loadSsrfConfig(), domainPolicy: loadFetchContentDomainPolicy(), ...(current.lookup ? { lookup: current.lookup } : {}) }); }))(url, options);
      options.signal?.throwIfAborted();
      const payload = await request("fetch", { url: url.href }, options);
      if (typeof payload.title !== "string" || typeof payload.content !== "string" || !payload.content.trim()) {
        throw new Error("DeepSeek returned invalid response: page title/content is missing");
      }
      return { url: url.href, title: payload.title, content: payload.content, error: null, source: "render", provider: "deepseek", mimeType: "text/markdown", status: 200 };
    },
  };
}

const client = createDeepSeekWebClient({ resolveConnection: (connectionId) => resolveDeepSeekConnection(connectionId ?? getDeepSeekWebSettings().deepseekConnectionId) });
export const searchWithDeepSeek = client.search;
export const fetchWithDeepSeek = client.fetch;
