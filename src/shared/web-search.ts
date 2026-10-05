/** Canonical search policy and persisted tool report. No credentials cross this boundary. */
export const SEARCH_PROVIDER_IDS = ["openai", "codex", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "searxng", "perplexity", "gemini", "exa", "serpdive", "serper", "kagi", "ollama", "anysearch", "xai", "brightdata", "serpbase"] as const;
export type SearchMode = "auto" | "single" | "fallback" | "parallel";
export interface WebSearchPolicy {
  mode: SearchMode;
  providers: string[];
  providerTimeoutMs: number;
  totalTimeoutMs: number;
  maxRequests: number;
  verifySources: boolean;
}
export const DEFAULT_SEARCH_POLICY: WebSearchPolicy = { mode: "auto", providers: [], providerTimeoutMs: 30_000, totalTimeoutMs: 60_000, maxRequests: 12, verifySources: true };
export function normalizeSearchPolicy(value: unknown): WebSearchPolicy {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = raw.mode ?? "auto";
  if (!["auto", "single", "fallback", "parallel"].includes(String(mode))) throw new Error("无效的搜索模式");
  const providers = Array.isArray(raw.providers) ? [...new Set(raw.providers.map(String))] : [];
  if (providers.some(p => !(SEARCH_PROVIDER_IDS as readonly string[]).includes(p))) throw new Error("搜索配置包含未知供应商");
  if (providers.length > 6) throw new Error("一次最多选择 6 家搜索供应商");
  if (mode !== "auto" && providers.length === 0) throw new Error("请至少选择一家搜索供应商");
  if (mode === "single" && providers.length !== 1) throw new Error("单源模式只能选择一家供应商");
  if (mode === "parallel" && providers.length < 2) throw new Error("多源并行请至少选择两家供应商");
  const integer = (key: keyof WebSearchPolicy, min: number, max: number): number => {
    const n = raw[key] ?? DEFAULT_SEARCH_POLICY[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`搜索配置 ${key} 必须在 ${min}～${max} 之间`);
    return n;
  };
  return { mode: mode as SearchMode, providers, providerTimeoutMs: integer("providerTimeoutMs", 1_000, 120_000), totalTimeoutMs: integer("totalTimeoutMs", 1_000, 180_000), maxRequests: integer("maxRequests", Math.max(1, providers.length), 24), verifySources: raw.verifySources !== false };
}
/** Reading old settings does not silently enable additional paid providers. */
export function searchPolicyFromConfig(raw: { searchPolicy?: unknown; searchProvider?: unknown; provider?: unknown; searchRouting?: { providers?: string[] } | null }): WebSearchPolicy {
  if (raw.searchPolicy) return normalizeSearchPolicy(raw.searchPolicy);
  const legacy = raw.searchProvider ?? raw.provider;
  const providers = Array.isArray(legacy) ? legacy : typeof legacy === "string" && (SEARCH_PROVIDER_IDS as readonly string[]).includes(legacy) ? [legacy] : raw.searchRouting?.providers ?? [];
  return { ...DEFAULT_SEARCH_POLICY, mode: Array.isArray(legacy) && providers.length > 1 ? "parallel" : providers.length > 1 ? "fallback" : providers.length ? "single" : "auto", providers };
}
export interface SearchOrigin { provider: string; query: string; rank: number; url: string }
export interface WebSearchSource {
  title: string; url: string; snippet: string;
  canonicalUrl?: string;
  origins?: SearchOrigin[];
  publishedAt?: string;
  fetchedAt?: number;
  contentHash?: string;
  duplicateOf?: string;
  evidence?: "snippet" | "page";
  fetchError?: string;
}
export type SearchRunStatus = "queued" | "running" | "success" | "empty" | "timeout" | "error" | "cancelled";
export interface SearchProviderRun {
  query: string; provider: string; status: SearchRunStatus; durationMs: number;
  results: WebSearchSource[]; answer: string; answerTruncated?: boolean; error?: string;
}
export interface SearchEvidenceCitation { passageId: string; url: string; quote: string; kind: "snippet" | "page"; stance: "support" | "contradict" | "context" }
export interface SearchEvidence {
  claim: string; status: "supported" | "contradicted" | "unclear" | "missing-evidence";
  rationale: string; citations: SearchEvidenceCitation[]; model?: string; error?: string;
}
export interface WebSearchReport {
  version: 1; id: string; status: "running" | "complete" | "partial" | "error" | "cancelled";
  queries: string[]; runs: SearchProviderRun[]; sources: WebSearchSource[];
  evidence?: SearchEvidence[]; notice?: string;
}
export function searchReportFromDetails(details: unknown): WebSearchReport | undefined {
  const r = (details as { webSearch?: WebSearchReport } | undefined)?.webSearch;
  return r?.version === 1 && typeof r.id === "string" && Array.isArray(r.runs) && Array.isArray(r.sources) && Array.isArray(r.queries) ? r : undefined;
}
export function searchReportSummary(r: WebSearchReport): string {
  const completed = r.runs.filter(x => x.status === "success" || x.status === "empty").length;
  const suppliers = new Set(r.runs.filter(x => x.status === "success").map(x => x.provider)).size;
  return `联网搜索 · ${r.status === "running" ? "搜索中 · " : ""}${completed}/${r.runs.length} 次请求完成 · ${suppliers} 家返回来源 · ${r.sources.length} 个网页${r.status === "partial" ? " · 部分结果" : r.status === "error" ? " · 失败" : r.status === "cancelled" ? " · 已取消" : ""}`;
}
