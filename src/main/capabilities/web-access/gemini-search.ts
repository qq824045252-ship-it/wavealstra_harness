import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_SEARCH_POLICY, normalizeSearchPolicy, type SearchProviderRun, type WebSearchPolicy } from "../../../shared/web-search";
import { mergeSearchSources, runSearchBatch, probeSearchAvailability } from "./search-aggregation";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { getApiKey, getVersionedApiBase, fetchGeminiApi, isGatewayConfigured, isGeminiApiAvailable, redactGeminiApiResponse } from "./gemini-api.ts";
import { getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isCodexSearchAvailable, isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import { isParallelAvailable, searchWithParallel } from "./parallel.ts";
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts";
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts";
import { isSearchinfinityAvailable, searchWithSearchinfinity } from "./searchinfinity.ts";
import { isQueritAvailable, searchWithQuerit } from "./querit.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isSerperAvailable, searchWithSerper } from "./serper.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts";
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts";
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export const RESOLVED_SEARCH_PROVIDERS = ["openai", "codex", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "searxng", "perplexity", "gemini", "exa", "serpdive", "serper", "kagi", "ollama", "anysearch", "xai", "brightdata", "serpbase"] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = typeof RESOLVED_SEARCH_PROVIDERS[number];
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type SearchProviderErrorKind =
	| "transient"
	| "quota"
	| "network"
	| "credential"
	| "config"
	| "auth"
	| "invalid-request"
	| "invalid-response"
	| "aborted"
	| "unknown";

export interface SearchRoutingConfig {
	providers: ResolvedSearchProvider[];
	fallbackOn: Array<Extract<SearchProviderErrorKind, "transient" | "quota" | "network">>;
}

export class SearchProviderError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchProviderErrorKind;
	readonly status?: number;
	readonly causeError: unknown;

	constructor(
		provider: ResolvedSearchProvider,
		kind: SearchProviderErrorKind,
		message: string,
		status: number | undefined,
		cause: unknown,
	) {
		super(`${provider} search failed (${kind}): ${message}`);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
		this.causeError = cause;
	}
}

export interface ProviderSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
	provider: ResolvedSearchProvider;
	error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider | "all";
	providerResponses?: ProviderSearchResponse[];
	providerErrors?: ProviderSearchFailure[];
	providerRuns?: SearchProviderRun[];
}

const CONFIG_PATH = getWebSearchConfigPath();
const DEFAULT_SEARCH_MODEL = "gemini-3.6-flash";
// Explicit-only providers (AnySearch, xAI, Bright Data, SerpBase) are deliberately absent:
// `all` must never fan out to a paid/surprising provider without the user asking for it.
const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = ["searxng", "openai", "exa", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "serper", "serpdive", "kagi", "ollama", "perplexity", "gemini"];
const VALID_ROUTING_KINDS = ["transient", "quota", "network"] as const;

type SearchConfig = {
	searchProvider: SearchProviderSelection;
	searchProviderConfigured: boolean;
	searchRouting?: SearchRoutingConfig;
	searchModel?: string;
	searchPolicy?: WebSearchPolicy;
};

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
	// Policy changes apply to the next invocation, including existing sessions.
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchProviderConfigured: false };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const searchModel = normalizeSearchModel(raw.searchModel);
	const searchProviderConfigured = Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
	cachedSearchConfig = {
		searchProvider: normalizeSearchProviderSelection(raw.searchProvider ?? raw.provider, `provider in ${CONFIG_PATH}`),
		searchProviderConfigured,
		...(Object.hasOwn(raw, "searchRouting") ? { searchRouting: normalizeSearchRouting(raw.searchRouting) } : {}),
		...(searchModel ? { searchModel } : {}),
		...(raw.searchPolicy ? { searchPolicy: normalizeSearchPolicy(raw.searchPolicy) } : {}),
	};
	return cachedSearchConfig;
}

function normalizeSearchRouting(value: unknown): SearchRoutingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	const providers = normalizeResolvedProviderList(raw.providers, `searchRouting.providers in ${CONFIG_PATH}`);
	if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
	}
	const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
	for (const kind of raw.fallbackOn) {
		if (typeof kind !== "string" || !VALID_ROUTING_KINDS.includes(kind as typeof VALID_ROUTING_KINDS[number])) {
			throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, or network`);
		}
		if (!fallbackOn.includes(kind as SearchRoutingConfig["fallbackOn"][number])) {
			fallbackOn.push(kind as SearchRoutingConfig["fallbackOn"][number]);
		}
	}
	return { providers, fallbackOn };
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
	const config = getSearchConfig();
	if (config.searchPolicy) return config.searchPolicy.mode === "fallback" || config.searchPolicy.mode === "single"
		? { providers: config.searchPolicy.providers as ResolvedSearchProvider[], fallbackOn: ["transient", "quota", "network"] } : undefined;
	return config.searchProviderConfigured ? undefined : config.searchRouting;
}

export function getSearchPolicy(): WebSearchPolicy { return getSearchConfig().searchPolicy ?? { ...DEFAULT_SEARCH_POLICY }; }

export function configuredProviderSelection(): SearchProviderSelection | undefined {
	const policy = getSearchConfig().searchPolicy;
	if (!policy) return undefined;
	if (policy.mode === "parallel") return policy.providers as ResolvedSearchProvider[];
	if (policy.mode === "single") return policy.providers[0] as ResolvedSearchProvider;
	return "auto";
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeResolvedProviderList(value: unknown, label: string): ResolvedSearchProvider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of value) {
		const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!RESOLVED_SEARCH_PROVIDERS.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized as ResolvedSearchProvider);
	}
	return providers;
}

export function normalizeSearchProviderSelection(value: unknown, label = "provider"): SearchProviderSelection {
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return SEARCH_PROVIDERS.includes(normalized as SearchProvider) ? normalized as SearchProvider : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProviderSelection;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
	onProviderUpdate?: (runs: SearchProviderRun[]) => void;
	budget?: { remaining: number; deadline: number };
	/** Reserve request slots for remaining queries instead of rejecting the whole tool call. */
	queriesRemaining?: number;
	queryAllowance?: { remaining: number };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
	if (options.recencyFilter) return false;
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && Math.floor(options.numResults) !== 5) {
		return false;
	}
	return true;
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
		const diagnostic = getGeminiWebAvailabilityDiagnostic();
		if (diagnostic) errors.push(`Gemini Web: ${diagnostic}`);
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

function providerErrorStatus(message: string): number | undefined {
	const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
	if (!match) return undefined;
	return Number(match[1]);
}

function classifyProviderError(provider: ResolvedSearchProvider, err: unknown): SearchProviderError {
	if (err instanceof SearchProviderError) return err;
	const message = errorMessage(err);
	const lower = message.toLowerCase();
	const status = providerErrorStatus(message);
	let kind: SearchProviderErrorKind = "unknown";
	if (err instanceof CredentialResolutionError || /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
		kind = "credential";
	} else if (isAbortError(err)) {
		kind = "aborted";
	} else if (status === 401 || status === 403) {
		kind = "auth";
	} else if (status === 400 || status === 422) {
		kind = "invalid-request";
	} else if (status === 402 || status === 429) {
		kind = "quota";
	} else if (status !== undefined && (status === 408 || status === 425 || status >= 500)) {
		kind = "transient";
	} else if (/rate limit|quota|too many requests/.test(lower)) {
		kind = "quota";
	} else if (/unauthorized|forbidden|permission denied/.test(lower)) {
		kind = "auth";
	} else if (/bad request|invalid request/.test(lower)) {
		kind = "invalid-request";
	} else if (/invalid json|no parseable response|returned invalid response|returned empty response/.test(lower)) {
		kind = "invalid-response";
	} else if (/temporar|service unavailable|server error/.test(lower)) {
		kind = "transient";
	} else if (err instanceof TypeError || /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)) {
		kind = "network";
	} else if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)) {
		kind = "config";
	}
	return new SearchProviderError(provider, kind, message, status, err);
}

async function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
	if (provider === "openai") {
		const result = await searchWithOpenAI(query, options, options.extensionContext);
		return { ...result, provider };
	}
	if (provider === "codex") {
		// Codex OAuth hosted web search：仅 OAuth，不回落 openai API key
		const result = await searchWithOpenAI(query, options, options.extensionContext, true);
		return { ...result, provider };
	}
	if (provider === "brave") return { ...(await searchWithBrave(query, options)), provider };
	if (provider === "parallel") return { ...(await searchWithParallel(query, options)), provider };
	if (provider === "tinyfish") return { ...(await searchWithTinyFish(query, options)), provider };
	if (provider === "search1api") return { ...(await searchWithSearch1API(query, options)), provider };
	if (provider === "searchinfinity") return { ...(await searchWithSearchinfinity(query, options)), provider };
	if (provider === "querit") return { ...(await searchWithQuerit(query, options)), provider };
	if (provider === "tavily") return { ...(await searchWithTavily(query, options)), provider };
	if (provider === "serper") return { ...(await searchWithSerper(query, options)), provider };
	if (provider === "serpdive") return { ...(await searchWithSerpdive(query, options)), provider };
	if (provider === "kagi") return { ...(await searchWithKagi(query, options)), provider };
	if (provider === "ollama") return { ...(await searchWithOllama(query, options)), provider };
	if (provider === "anysearch") return { ...(await searchWithAnySearch(query, options)), provider };
	if (provider === "xai") return { ...(await searchWithXai(query, options, options.extensionContext)), provider };
	if (provider === "brightdata") return { ...(await searchWithBrightData(query, options)), provider };
	if (provider === "serpbase") return { ...(await searchWithSerpBase(query, options)), provider };
	if (provider === "perplexity") return { ...(await searchWithPerplexity(query, options)), provider };
	if (provider === "searxng") return { ...(await searchWithSearXNG(query, options)), provider };
	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Sign into gemini.google.com in a supported Chromium-based browser",
		);
	}
	const result = await searchWithExa(query, options);
	if (result) return { ...result, provider };
	throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(provider: ResolvedSearchProvider, options: FullSearchOptions): Promise<boolean> {
	if (provider === "openai") return isOpenAISearchAvailable(options.extensionContext);
	if (provider === "codex") return isCodexSearchAvailable(options.extensionContext);
	if (provider === "brave") return isBraveAvailable();
	if (provider === "parallel") return isParallelAvailable();
	if (provider === "tinyfish") return isTinyFishAvailable();
	if (provider === "search1api") return isSearch1APIAvailable();
	if (provider === "searchinfinity") return isSearchinfinityAvailable();
	if (provider === "querit") return isQueritAvailable();
	if (provider === "tavily") return isTavilyAvailable();
	if (provider === "serper") return isSerperAvailable();
	if (provider === "serpdive") return isSerpdiveAvailable();
	if (provider === "kagi") return isKagiAvailable();
	if (provider === "ollama") return isOllamaAvailable();
	if (provider === "anysearch") return isAnySearchAvailable();
	if (provider === "xai") return isXaiSearchAvailable(options.extensionContext);
	if (provider === "brightdata") return isBrightDataAvailable();
	if (provider === "serpbase") return isSerpBaseAvailable();
	if (provider === "perplexity") return isPerplexityAvailable();
	if (provider === "searxng") return isSearXNGAvailable();
	if (provider === "gemini") return isGeminiApiAvailable() || !!(await isGeminiWebAvailable());
	return isExaAvailable();
}

function providerLabel(provider: ResolvedSearchProvider): string {
	if (provider === "openai") return "OpenAI";
	if (provider === "tinyfish") return "TinyFish";
	if (provider === "search1api") return "Search1API";
	if (provider === "searchinfinity") return "Searchinfinity";
	if (provider === "querit") return "Querit";
	if (provider === "serpdive") return "SERPdive";
	if (provider === "serper") return "Serper";
	if (provider === "searxng") return "SearXNG";
	if (provider === "kagi") return "Kagi";
	if (provider === "ollama") return "Ollama";
	if (provider === "xai") return "xAI";
	if (provider === "brightdata") return "Bright Data";
	if (provider === "serpbase") return "SerpBase";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

async function searchWithAllProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
	if (provider !== "gemini") return searchWithResolvedProvider(provider, query, options);
	const result = await searchWithGeminiApi(query, options);
	if (result) return { ...result, provider };
	throw new Error("Gemini API search returned no results.");
}

async function searchWithProviders(
	query: string,
	options: FullSearchOptions,
	selectedProviders?: ResolvedSearchProvider[],
): Promise<AttributedSearchResponse> {
	const providers = selectedProviders ?? (await probeSearchAvailability(ALL_SEARCH_PROVIDERS, async provider => provider === "gemini" ? isGeminiApiAvailable() : isResolvedProviderAvailable(provider as ResolvedSearchProvider, options), Math.min(2000, (options.budget?.deadline ?? Date.now() + getSearchPolicy().totalTimeoutMs) - Date.now()), options.signal)).filter(entry => entry.available).map(entry => entry.provider as ResolvedSearchProvider);
	if (providers.length === 0) {
		throw new Error("No configured search provider available for provider \"all\". AnySearch, xAI, Bright Data, and SerpBase are excluded.");
	}

	return runMeasuredSearch(query, providers, options, async (provider, signal) => selectedProviders
		? searchWithResolvedProvider(provider as ResolvedSearchProvider, query, { ...options, signal })
		: searchWithAllProvider(provider as ResolvedSearchProvider, query, { ...options, signal }));
}

async function runMeasuredSearch(
	query: string, providers: string[], options: FullSearchOptions,
	run: (provider: string, signal: AbortSignal) => Promise<AttributedSearchResponse>,
): Promise<AttributedSearchResponse> {
	const policy = getSearchPolicy();
	if (providers.length > 6) throw new Error("Select at most 6 search providers explicitly.");
	const requestedProviders = providers;
	const skipped: SearchProviderRun[] = [];
	const eligible: string[] = [];
	const availability = await probeSearchAvailability(providers, p => isResolvedProviderAvailable(p as ResolvedSearchProvider, options), Math.min(2000, (options.budget?.deadline ?? Date.now() + policy.totalTimeoutMs) - Date.now()), options.signal);
	for (const item of availability) {
		if (item.available) eligible.push(item.provider);
		else skipped.push({ query, provider: item.provider, status: "error", durationMs: 0, results: [], answer: "", error: `未发起请求：${item.error ?? "供应商未配置、凭据不可用或搜索模型未启用"}。` });
	}
	const remaining = options.budget?.remaining ?? policy.maxRequests;
	const slots = Math.max(0, Math.min(remaining, options.queryAllowance?.remaining ?? remaining));
	providers = eligible.slice(0, slots);
	for (const provider of eligible.slice(slots)) skipped.push({ query, provider, status: "error", durationMs: 0, results: [], answer: "", error: "未发起请求：为其他查询保留额度，本查询的供应商覆盖已缩减。" });
	if (options.queryAllowance) options.queryAllowance.remaining -= providers.length;
	if (options.budget) options.budget.remaining -= providers.length;
	const availableMs = options.budget ? options.budget.deadline - Date.now() : policy.totalTimeoutMs;
	if (availableMs <= 0) throw new Error("Search overall deadline exceeded");
	const batch = await runSearchBatch(query, providers, {
		signal: options.signal, providerTimeoutMs: policy.providerTimeoutMs, totalTimeoutMs: availableMs,
		onUpdate: runs => options.onProviderUpdate?.([...runs, ...skipped]),
		run: async (provider, signal) => {
			const response = await run(provider, signal);
			return response;
		},
	});
	batch.runs.push(...skipped);
	batch.runs.sort((a, b) => requestedProviders.indexOf(a.provider) - requestedProviders.indexOf(b.provider));
	for (const item of batch.runs) {
		const reply = batch.replies.get(item.provider) as AttributedSearchResponse | undefined;
		if (reply?.provider && reply.provider !== "all") item.provider = reply.provider;
	}
	const successful = batch.runs.filter(r => r.status === "success" || r.status === "empty");
	const errors = batch.runs.filter(r => r.error).map(r => ({ provider: r.provider as ResolvedSearchProvider, error: r.error! }));
	const results = mergeSearchSources(batch.runs);
	return {
		provider: providers.length === 1 ? ((batch.replies.get(providers[0]) as AttributedSearchResponse | undefined)?.provider ?? providers[0] as ResolvedSearchProvider) : "all",
		answer: batch.runs.map(r => `## ${r.provider} (${r.status})\n\n${r.error ?? r.answer}`).join("\n\n"),
		results, providerRuns: batch.runs,
		providerResponses: successful.map(r => ({ provider: r.provider as ResolvedSearchProvider, answer: r.answer, results: r.results })),
		providerErrors: errors,
		inlineContent: [...batch.replies.values()].flatMap(r => r.inlineContent ?? []),
	};
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	// Compute once for the whole query, including all fallback/automatic candidates.
	if (options.queriesRemaining && !options.queryAllowance) options = { ...options, queryAllowance: { remaining: Math.ceil((options.budget?.remaining ?? getSearchPolicy().maxRequests) / options.queriesRemaining) } };
	const config = getSearchConfig();
	const policy = config.searchPolicy;
	const explicit = options.provider !== undefined && options.provider !== "auto";
	const selection = explicit ? options.provider! : configuredProviderSelection() ?? config.searchProvider;
	if (Array.isArray(selection)) return searchWithProviders(query, options, normalizeResolvedProviderList(selection, "provider"));
	if (selection === "all") return searchWithProviders(query, options);
	if (selection !== "auto") return runMeasuredSearch(query, [selection], options, (p, signal) => searchWithResolvedProvider(p as ResolvedSearchProvider, query, { ...options, signal }));
	const routing = !explicit && policy?.mode === "fallback"
		? { providers: policy.providers as ResolvedSearchProvider[], fallbackOn: ["transient", "quota", "network"] as SearchRoutingConfig["fallbackOn"] }
		: !policy && !config.searchProviderConfigured ? config.searchRouting : undefined;
	if (routing) {
		const runs: SearchProviderRun[] = [];
		const budget = options.budget ?? { remaining: getSearchPolicy().maxRequests, deadline: Date.now() + getSearchPolicy().totalTimeoutMs };
		for (const candidate of routing.providers) {
			if (options.queryAllowance && options.queryAllowance.remaining < 1) break;
			const result = await runMeasuredSearch(query, [candidate], { ...options, budget, onProviderUpdate: current => options.onProviderUpdate?.([...runs, ...current]) }, (p, signal) => searchWithResolvedProvider(p as ResolvedSearchProvider, query, { ...options, signal }));
			runs.push(...(result.providerRuns ?? []));
			if (result.providerRuns?.some(r => r.status === "success" || r.status === "empty")) return { ...result, providerRuns: runs };
			options.signal?.throwIfAborted();
			const last = runs[runs.length - 1];
			const kind = last.status === "timeout" ? "transient" : classifyProviderError(candidate, new Error(last.error)).kind;
			if (!routing.fallbackOn.includes(kind as SearchRoutingConfig["fallbackOn"][number])) break;
		}
		return { provider: "all", answer: "Search failed; see individual provider errors.", results: [], providerRuns: runs };
	}
	// Preserve legacy automatic selection, but bound its whole attempt and attribute the actual responder.
	return searchAutomatically(query, options);
}

async function searchAutomatically(query: string, options: FullSearchOptions): Promise<AttributedSearchResponse> {
	const policy = getSearchPolicy();
	const budget = options.budget ?? { remaining: policy.maxRequests, deadline: Date.now() + policy.totalTimeoutMs };
	const runs: SearchProviderRun[] = [];
	for (const candidate of ALL_SEARCH_PROVIDERS) {
		options.signal?.throwIfAborted();
		if (candidate === "openai" && !shouldTryOpenAIInAuto(options)) continue;
		if (budget.remaining < 1 || (options.queryAllowance && options.queryAllowance.remaining < 1) || Date.now() >= budget.deadline) break;
		try {
			if (!(await probeSearchAvailability([candidate], p => isResolvedProviderAvailable(p as ResolvedSearchProvider, options), Math.min(2000, budget.deadline - Date.now()), options.signal))[0].available) continue;
		} catch { continue; }
		const result = await runMeasuredSearch(query, [candidate], { ...options, budget, onProviderUpdate: current => options.onProviderUpdate?.([...runs, ...current]) }, (p, signal) => searchWithResolvedProvider(p as ResolvedSearchProvider, query, { ...options, signal }));
		runs.push(...(result.providerRuns ?? []));
		if (result.providerRuns?.some(r => r.status === "success" || r.status === "empty")) return { ...result, providerRuns: runs };
	}
	return { provider: "all", answer: "No search provider completed within the configured request/time budget. Check provider configuration and individual errors.", results: [], providerRuns: runs };
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const requestSignal = AbortSignal.any([
		AbortSignal.timeout(60000),
		...(options.signal ? [options.signal] : []),
	]);
	const apiKey = await getApiKey(requestSignal);
	if (!apiKey && !isGatewayConfigured()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetchGeminiApi(`${getVersionedApiBase()}/models/${model}:generateContent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		}, apiKey);

		if (!res.ok) {
			const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
