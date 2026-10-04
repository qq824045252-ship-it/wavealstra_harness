import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { hasCredentialSource } from "./credential-source.ts";
import { resolveProviderKeys, searchWithKeyPool } from "./key-pool.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const SERPER_API_URL = "https://google.serper.dev/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	serperApiKey?: unknown;
}

interface SerperOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
}

interface SerperAnswerBox {
	title?: string;
	link?: string;
	snippet?: string;
	answer?: string;
}

interface SerperResponse {
	organic?: SerperOrganicResult[];
	answerBox?: SerperAnswerBox;
	knowledgeGraph?: { title?: string; description?: string };
}

interface SerperSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function legacySerperKey(): string | undefined {
	const value = loadConfig().serperApiKey;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isSerperAvailable(): boolean {
	if (resolveProviderKeys("serper", legacySerperKey(), process.env.SERPER_API_KEY).length > 0) {
		return true;
	}
	return hasCredentialSource({
		provider: "Serper",
		configuredValue: loadConfig().serperApiKey,
		environmentValue: process.env.SERPER_API_KEY,
	});
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

/** Serper 无服务端域过滤，客户端按 domainFilter 过滤（"-domain" 表示排除） */
function filterByDomain(
	results: SearchResponse["results"],
	domainFilter: string[] | undefined,
): SearchResponse["results"] {
	if (!domainFilter?.length) return results;
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		if (raw.trim().startsWith("-")) excludes.push(domain);
		else includes.push(domain);
	}
	if (includes.length === 0 && excludes.length === 0) return results;
	return results.filter((item) => {
		let host: string;
		try {
			host = new URL(item.url).hostname;
		} catch {
			host = item.url.split("/")[0]?.split(":")[0] ?? "";
		}
		if (excludes.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
		if (includes.length > 0 && !includes.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
		return true;
	});
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function mapResults(data: SerperResponse, numResults: number): SearchResponse["results"] {
	const mapped: SearchResponse["results"] = [];
	for (const item of data.organic ?? []) {
		if (!item?.link) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.link,
			snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : "",
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

function mapAnswer(data: SerperResponse): string {
	if (typeof data.answerBox?.answer === "string" && data.answerBox.answer.trim()) {
		return data.answerBox.answer.trim();
	}
	if (typeof data.answerBox?.snippet === "string" && data.answerBox.snippet.trim()) {
		return data.answerBox.snippet.trim();
	}
	if (typeof data.knowledgeGraph?.description === "string" && data.knowledgeGraph.description.trim()) {
		return data.knowledgeGraph.description.trim();
	}
	return "";
}

/** 执行单次 Serper 搜索（使用指定 key） */
async function searchWithKey(
	apiKey: string,
	query: string,
	options: SerperSearchOptions,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const body: Record<string, unknown> = {
		q: query,
		num: numResults,
	};

	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(SERPER_API_URL, {
			method: "POST",
			headers: {
				"X-API-KEY": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = message.includes(apiKey) ? message.replace(apiKey, "••••") : message;
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = (await response.text()).slice(0, 300);
		throw new Error(`Serper API error ${response.status}: ${errorText}`);
	}

	let data: SerperResponse;
	try {
		data = await response.json() as SerperResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Serper API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);
	const result: SearchResponse = {
		answer: mapAnswer(data),
		results: filterByDomain(mapResults(data, numResults), options.domainFilter),
	};
	// Serper 不返回原始正文，无 inlineContent
	return result;
}

/**
 * 多 key 池搜索：复用通用 searchWithKeyPool —— 配额/限流用尽自动切下一个 key，
 * 鉴权失败禁用后继续，全部用尽才抛错（供上层 provider 级回退）。
 */
export async function searchWithSerper(query: string, options: SerperSearchOptions = {}): Promise<SearchResponse> {
	return searchWithKeyPool(
		"serper",
		legacySerperKey(),
		process.env.SERPER_API_KEY,
		(apiKey) => searchWithKey(apiKey, query, options),
		{
			providerLabel: "Serper",
			setupHint:
				`  1. Create ${CONFIG_PATH} with { "serperApiKey": "your-key" } or { "apiKeyPools": { "serper": ["key1", "key2"] } }\n` +
				"  2. Set SERPER_API_KEY environment variable\n" +
				"Get a key at https://serper.dev/",
		},
	);
}
