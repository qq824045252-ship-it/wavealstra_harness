import type { Api, ApiKeyAuth, Model, ModelThinkingLevel, Provider, ProviderStreams, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ModelsModelConfig } from "../ModelsConfigStore";

export const MAGPIE_PROVIDER_ID = "magpie";

/**
 * models.json `providers.magpie` as Magpie writes it (magpie/internal/agent/mybuddy.go,
 * myBuddyProviderJSON): the gateway address, its key, and the request identity
 * (`headers["User-Agent"] = "MyBuddy"`) that tells MyBuddy's calls from Pi's.
 */
export interface MagpieGatewayConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export type MagpieModelApi = "anthropic-messages" | "openai-completions" | "openai-responses";
export type MagpieModel = Model<MagpieModelApi>;
type PiProviderSdk = Pick<typeof import("@earendil-works/pi-ai"), "createProvider">;

/** Magpie accepts Responses strict:false. If omitted, Codex normalizes optional
 * parameters into required dummy values. Apply at ModelRuntime dispatch: Pi's
 * composer bypasses a provider's stream implementation before its first catalog
 * refresh, when the native provider has no models for that API yet. */
export function magpieResponsesModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  if (model.provider !== MAGPIE_PROVIDER_ID || model.api !== "openai-responses") return model;
  const compat = (model as Model<"openai-responses">).compat;
  if (compat?.supportsStrictMode !== undefined) return model;
  return { ...model, compat: { ...compat, supportsStrictMode: true } } as Model<TApi>;
}

const CATALOG_TIMEOUT_MS = 15_000;
const thinkingLevels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Gateway `GET /v1/models` row (magpie/internal/gateway/gateway.go modelObject). */
interface GatewayModelEntry {
  id?: unknown;
  display_name?: unknown;
  reasoning?: unknown;
  supported_reasoning_levels?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  modalities?: unknown;
  native_endpoints?: unknown;
}

/**
 * Magpie's gateway key is written into models.json by Magpie itself, so there is
 * no login to offer here: without that config Pi composes this provider bare and
 * MyBuddy's provider list skips it (no phantom "Magpie" entry), and with it Pi's
 * own models.json API-key path resolves the key before this fallback runs.
 */
const magpieGatewayKeyAuth: ApiKeyAuth = {
  name: "Magpie 网关密钥",
  resolve: async ({ credential, signal }) => {
    signal.throwIfAborted();
    if (!credential?.key) return undefined;
    return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
  },
};

/**
 * Magpie's gateway as a Pi provider, so `GET /v1/models` is an upstream catalog
 * MyBuddy's "刷新模型" can pull through Pi's own refreshModels instead of only
 * re-reading models.json.
 *
 * Magpie stays the owner of models.json: Pi composes this provider underneath
 * `providers.magpie`, so every entry Magpie wrote still wins over a fetched one
 * and a refresh only adds models Magpie has not written yet. The gateway speaks
 * OpenAI Chat, Responses and Anthropic Messages; fetched rows are kept on the
 * API whose baseUrl is the provider-level one, because Pi overrides a fetched
 * model's baseUrl with `providers.magpie.baseUrl` (provider-composer.js
 * applyModelsJson) — Magpie's own block keeps each model's native API.
 */
export function magpieProvider(
  sdk: PiProviderSdk,
  api: Record<MagpieModelApi, ProviderStreams>,
  resolveConfig: () => MagpieGatewayConfig | undefined,
): Provider<MagpieModelApi> {
  // A pass-through base: Pi dispatches to these exactly when it would have
  // reached the same api module through getApiProvider(). Deferred fetch stays
  // out, as it is today for a models.json-only provider.
  const passThrough = (native: ProviderStreams): ProviderStreams => ({
    stream: (model, context, options) => native.stream(model, context, options),
    streamSimple: (model, context, options) => native.streamSimple(model, context, options),
  });
  return sdk.createProvider<MagpieModelApi>({
    id: MAGPIE_PROVIDER_ID,
    name: "Magpie",
    auth: { apiKey: magpieGatewayKeyAuth },
    models: [],
    api: {
      "anthropic-messages": passThrough(api["anthropic-messages"]),
      "openai-completions": passThrough(api["openai-completions"]),
      "openai-responses": passThrough(api["openai-responses"]),
    },
    fetchModels: async (context) => {
      const config = resolveConfig();
      const baseUrl = normalizeBaseUrl(config?.baseUrl ?? "");
      if (!baseUrl) throw new Error("models.json 缺少 providers.magpie.baseUrl，无法读取 Magpie 网关模型目录");
      const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
      const headers = new Headers(config?.headers ?? {});
      headers.set("accept", "application/json");
      if (key && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
      const response = await fetch(`${baseUrl}/models`, {
        headers,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`Magpie 网关模型目录请求失败：HTTP ${response.status}`);
      const body: unknown = await response.json();
      const data = body && typeof body === "object" && "data" in body ? (body as { data?: unknown }).data : undefined;
      if (!Array.isArray(data)) throw new Error("Magpie 网关返回的模型目录格式无效");
      const models = data.map((entry) => modelFromGatewayEntry(entry, baseUrl));
      if (!models.length) throw new Error("Magpie 网关模型目录为空");
      if (new Set(models.map((model) => model.id)).size !== models.length) {
        throw new Error("Magpie 网关模型目录包含重复 ID");
      }
      // Recorded only for a complete, successful fetch: an empty or failed
      // response must never be able to prune models.json.
      catalogRevision += 1;
      catalogSnapshot = { revision: catalogRevision, baseUrl, models };
      return models;
    },
  });
}

/** The last complete catalog a successful gateway fetch returned in this process. */
export interface MagpieCatalogSnapshot {
  revision: number;
  baseUrl: string;
  models: MagpieModel[];
}

let catalogRevision = 0;
let catalogSnapshot: MagpieCatalogSnapshot | undefined;

/** Monotonic revision of the last successful gateway catalog; 0 before any. */
export function magpieCatalogRevision(): number {
  return catalogRevision;
}

/** What the last successful gateway fetch returned; undefined before any. */
export function magpieCatalogSnapshot(): MagpieCatalogSnapshot | undefined {
  return catalogSnapshot;
}

/** models.json definition for a gateway-only model: the fields Magpie's own
 * writer fills (magpie/internal/agent/agents.go piModelJSON), nothing invented. */
export function magpieModelDefinition(model: MagpieModel): ModelsModelConfig {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Align the Magpie block's model list with what the gateway serves now: an id
 * still served keeps the definition Magpie wrote (its cost, promptCache and
 * per-model native API are richer than a catalog row), an id the gateway no
 * longer serves is dropped, a new id is added. Returns undefined when the id
 * set is unchanged, so a repeated refresh never rewrites the file.
 */
export function reconcileMagpieModels(
  existing: readonly ModelsModelConfig[] | undefined,
  catalog: readonly MagpieModel[],
): ModelsModelConfig[] | undefined {
  const current = existing ?? [];
  const currentIds = new Set(current.map((model) => model.id));
  const servedIds = new Set(catalog.map((model) => model.id));
  if (currentIds.size === servedIds.size && [...servedIds].every((id) => currentIds.has(id))) return undefined;
  const written = new Map(current.map((model) => [model.id, model]));
  return catalog.map((model) => written.get(model.id) ?? magpieModelDefinition(model));
}

/** enabledModels / model-thinking patterns that name one of these dropped ids,
 * with an optional ":level" suffix. Wildcards are never matched: they resolve
 * to whatever the catalog holds. */
export function magpieScopeReferencesToDrop(
  patterns: readonly string[],
  droppedModelIds: readonly string[],
): string[] {
  const refs = new Set(droppedModelIds.map((id) => `${MAGPIE_PROVIDER_ID}/${id}`));
  return patterns.filter((pattern) => refs.has(pattern.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u, "")));
}

/** One gateway row as a Pi model: fields Magpie's own block does not carry yet. */
export function modelFromGatewayEntry(value: unknown, baseUrl: string): MagpieModel {
  if (!value || typeof value !== "object") throw new Error("Magpie 网关返回了无效模型条目");
  const entry = value as GatewayModelEntry;
  if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("Magpie 网关模型缺少 ID");
  const id = entry.id;
  const efforts = gatewayEfforts(entry.supported_reasoning_levels);
  const contextWindow = firstPositiveNumber(entry.context_window, entry.context_length, entry.max_input_tokens) ?? 128_000;
  const output = firstPositiveNumber(entry.max_output_tokens);
  const images = gatewayInputModalities(entry.modalities).includes("image");
  return {
    id,
    name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : id,
    provider: MAGPIE_PROVIDER_ID,
    baseUrl,
    // Only the Responses API shares the provider-level "/v1" baseUrl; a model
    // whose native endpoint is Anthropic's Messages API (baseUrl without /v1)
    // is left on Chat, which the gateway translates.
    api: hasEndpoint(entry.native_endpoints, "/responses") ? "openai-responses" : "openai-completions",
    reasoning: entry.reasoning === true || efforts.length > 0,
    // Magpie's block (magpie/internal/agent/agents.go piThinkingLevels) maps
    // every Pi level, null where the model does not offer it.
    thinkingLevelMap: thinkingLevelMapFromEfforts(efforts),
    input: images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // Pi requires a numeric ceiling; the gateway publishes none for every model,
    // so an unpublished output limit follows the known context boundary and is
    // replaced by Magpie's own maxTokens once Magpie writes the block.
    maxTokens: output ?? contextWindow,
  };
}

function thinkingLevelMapFromEfforts(efforts: readonly string[]): ThinkingLevelMap | undefined {
  if (!efforts.length) return undefined;
  const levels: ThinkingLevelMap = {};
  for (const level of thinkingLevels) {
    const offered = level === "off" ? "none" : level;
    levels[level] = efforts.includes(offered) ? offered : null;
  }
  return levels;
}

function gatewayEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const effort = (item as { effort?: unknown }).effort;
    return typeof effort === "string" && effort ? [effort] : [];
  });
}

function gatewayInputModalities(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const input = (value as { input?: unknown }).input;
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
}

function gatewayEndpoints(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Gateway endpoints are paths ("/v1/responses"); match them by suffix. */
function hasEndpoint(value: unknown, suffix: string): boolean {
  return gatewayEndpoints(value).some((endpoint) => endpoint.replace(/\/+$/u, "").endsWith(suffix));
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, "");
}
