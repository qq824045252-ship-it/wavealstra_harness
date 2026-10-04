import type { AnyModel, Api, Model, ModelThinkingLevel, Provider, ProviderStreams, StreamOptions, ThinkingLevelMap } from "@earendil-works/pi-ai";
import catalog from "./command-code.models.json";

export const COMMAND_CODE_PROVIDER_ID = "commandcode";
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
type CommandCodeApi = "anthropic-messages" | "openai-completions" | "openai-responses";
type DefaultedField = "contextWindow" | "maxTokens" | "reasoning" | "input";
type PiProviderSdk = Pick<typeof import("@earendil-works/pi-ai"), "createProvider" | "envApiKeyAuth">;
export type CommandCodeModel = Model<CommandCodeApi> & {
  commandCode: {
    schemaVersion: 2;
    defaultedFields: DefaultedField[];
    supportedEndpoints: string[];
    reasoningControl: "effort" | "toggle" | "budget" | "provider-default" | "unknown";
    parameterSources: { maxTokens?: string; reasoning?: string };
    /** Internal context ceiling when the output limit is unpublished; never sent as a model limit. */
    catalogMaxTokens: number;
  };
};

interface CatalogFacts {
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  reasoningEfforts?: string[];
  reasoningControl?: CommandCodeModel["commandCode"]["reasoningControl"];
  parameterSources?: CommandCodeModel["commandCode"]["parameterSources"];
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Model<"anthropic-messages">["compat"];
  cost?: Model<CommandCodeApi>["cost"];
}
const factsById = new Map<string, CatalogFacts>(catalog.models.map((model) => [model.id, model as CatalogFacts]));
const catalogGeneratedAt = Date.parse(catalog.fetchedAt);
const thinkingLevels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelFromOfficialEntry(value: unknown): CommandCodeModel | undefined {
  if (!value || typeof value !== "object") throw new Error("Command Code 返回了无效模型条目");
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("Command Code 模型缺少 ID");
  if (!Array.isArray(entry.supported_endpoints)) throw new Error(`Command Code 模型 ${entry.id} 缺少调用端点`);
  const endpoints = entry.supported_endpoints.filter((item): item is string => typeof item === "string");
  const api: CommandCodeApi | undefined = endpoints.includes("/messages") ? "anthropic-messages"
    : endpoints.includes("/responses") ? "openai-responses"
      : endpoints.includes("/chat/completions") ? "openai-completions" : undefined;
  // Decision-only endpoints are not conversational models.
  if (!api) return undefined;
  const facts = factsById.get(entry.id);
  const contextWindow = entry.context_length;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`Command Code 模型 ${entry.id} 缺少有效上下文长度`);
  }
  const defaultedFields: DefaultedField[] = [];
  if (!facts?.maxTokens) defaultedFields.push("maxTokens");
  if (typeof facts?.reasoning !== "boolean") defaultedFields.push("reasoning");
  if (!facts?.input) defaultedFields.push("input");
  const efforts: string[] = facts?.reasoningEfforts ?? [];
  const thinkingLevelMap = facts?.thinkingLevelMap ?? Object.fromEntries(thinkingLevels.map((level) => [
    level, efforts.includes(level) ? level : level === "off" && efforts.includes("none") ? "none" : null,
  ]));
  return {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
    provider: COMMAND_CODE_PROVIDER_ID,
    baseUrl: COMMAND_CODE_BASE_URL,
    api,
    contextWindow,
    // Pi requires a numeric ceiling for context accounting. When unpublished,
    // use only the known context boundary and omit the wire output cap below.
    maxTokens: facts?.maxTokens ?? contextWindow,
    reasoning: facts?.reasoning ?? false,
    input: facts?.input?.includes("image") ? ["text", "image"] : ["text"],
    thinkingLevelMap,
    ...(api === "anthropic-messages" ? { compat: facts?.compat } : {}),
    cost: facts?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    commandCode: {
      schemaVersion: 2, defaultedFields, supportedEndpoints: endpoints,
      reasoningControl: facts?.reasoningControl ?? "unknown",
      parameterSources: facts?.parameterSources ?? {},
      catalogMaxTokens: facts?.maxTokens ?? contextWindow,
    },
  };
}

const baseline = catalog.models.map(modelFromOfficialEntry).filter((model): model is CommandCodeModel => Boolean(model));

function normalizeDeepSeekResponsesRequest(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const request = { ...payload } as Record<string, unknown>;
  if (request.reasoning && typeof request.reasoning === "object") {
    const reasoning = { ...request.reasoning } as Record<string, unknown>;
    delete reasoning.summary;
    request.reasoning = reasoning;
  }
  if (Array.isArray(request.input)) {
    request.input = request.input.flatMap((item) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.content)) return [item];
      // Pi preserves empty text blocks from other providers (e.g. Gemini tool
      // turns); this route rejects them as missing input.content.text. Remove
      // only empty text parts, retaining tool items, images and nonempty text.
      const content = item.content.filter((part: unknown) => !(part && typeof part === "object"
        && "type" in part && (part.type === "input_text" || part.type === "output_text")
        && "text" in part && part.text === ""));
      return content.length ? [{ ...item, content }] : [];
    });
  }
  return request;
}

function withRequestPolicy<T extends StreamOptions>(model: Model<Api>, options: T): T {
  const facts = commandCodeModelFacts(model);
  const useServerLimit = facts?.defaultedFields.includes("maxTokens")
    && model.maxTokens === facts.catalogMaxTokens && options.maxTokens === undefined;
  // Verified against this Command Code route: Pi's automatic reasoning.summary
  // produces HTTP 400, while the same request with effort alone completes.
  // Keep the exception local to the verified model/transport, not all Responses
  // models (OpenAI models use summary to return their reasoning).
  const normalizeDeepSeek = model.api === "openai-responses"
    && model.id === "deepseek/deepseek-v4.1-flash";
  if (!useServerLimit && !normalizeDeepSeek) return options;
  if (useServerLimit && model.api === "anthropic-messages") {
    // Anthropic requires max_tokens. Refuse an unknown model until an explicit
    // limit is configured instead of manufacturing a provider capability.
    throw new Error(`请为 ${model.id} 配置最大输出 token 数；该接口要求 max_tokens`);
  }
  return {
    ...options,
    onPayload: async (payload, currentModel) => {
      const body = { ...(payload as Record<string, unknown>) };
      if (useServerLimit) {
        delete body.max_output_tokens;
        delete body.max_completion_tokens;
        delete body.max_tokens;
      }
      const finalBody = await options.onPayload?.(body, currentModel) ?? body;
      // Callers may mutate or replace the payload. Apply the route constraint
      // last, without modifying caller-owned objects or transcript summaries.
      return normalizeDeepSeek ? normalizeDeepSeekResponsesRequest(finalBody) : finalBody;
    },
  };
}

/** Native Pi provider factory, shared with the CLI worker's own Pi module. */
export function commandCodeProvider(
  sdk: PiProviderSdk,
  api: Record<CommandCodeApi, ProviderStreams>,
): Provider<CommandCodeApi> {
  // Anthropic appends /v1/messages itself. The configured provider URL is the
  // OpenAI-compatible /provider/v1 root, including models.json URL overrides.
  const anthropicModel = (model: Model<"anthropic-messages">): Model<"anthropic-messages"> => ({
    ...model, baseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
  });
  const streams = Object.fromEntries(Object.entries(api).map(([name, native]) => [name, {
    stream: (model, context, options = {}) => {
      const target = name === "anthropic-messages" ? anthropicModel(model as Model<"anthropic-messages">) : model;
      const defaults = commandCodeModelFacts(model)?.reasoningControl === "toggle" ? { reasoningEffort: "high" } : {};
      return native.stream(target, context, withRequestPolicy(model, { ...defaults, ...options }));
    },
    streamSimple: (model, context, options = {}) => {
      const target = name === "anthropic-messages" ? anthropicModel(model as Model<"anthropic-messages">) : model;
      const reasoning = options.reasoning ?? (commandCodeModelFacts(model)?.reasoningControl === "toggle" ? "high" : undefined);
      return native.streamSimple(target, context, withRequestPolicy(model, { ...options, reasoning }));
    },
  } satisfies ProviderStreams])) as Record<CommandCodeApi, ProviderStreams>;
  const provider = sdk.createProvider<CommandCodeApi>({
    id: COMMAND_CODE_PROVIDER_ID,
    name: "Command Code",
    baseUrl: COMMAND_CODE_BASE_URL,
    auth: { apiKey: sdk.envApiKeyAuth("Command Code API key", ["CMD_API_KEY", "COMMAND_CODE_API_KEY"]) },
    models: [],
    api: streams,
    fetchModels: async ({ signal }) => {
      const response = await fetch(`${COMMAND_CODE_BASE_URL}/models`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`Command Code 模型目录请求失败：HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
        throw new Error("Command Code 模型目录格式无效");
      }
      const models = body.data.map(modelFromOfficialEntry).filter((model): model is CommandCodeModel => Boolean(model));
      if (!models.length || new Set(models.map((model) => model.id)).size !== models.length) {
        throw new Error("Command Code 模型目录为空或包含重复 ID");
      }
      return models;
    },
  });
  // Pi 0.99 consumes getAllModels() for typed catalogs. Both entrypoints must
  // expose the same snapshot or the offline/first-run catalog silently vanishes.
  const currentModels = (): CommandCodeModel[] => {
    const models = provider.getModels();
    return models.length ? models as CommandCodeModel[] : baseline;
  };
  return {
    ...provider,
    refreshModels: (context) => {
      // Older MyBuddy catalogs used a different schema and could contain guessed
      // limits/protocols. As with Pi's builtin catalogs, a newer snapshot wins.
      const stored = context.stored && (context.stored.checkedAt ?? 0) >= catalogGeneratedAt
        && context.stored.models.every((model) => commandCodeModelFacts(model)?.schemaVersion === 2)
        ? context.stored : undefined;
      return provider.refreshModels!({ ...context, stored });
    },
    // A successful live list replaces the snapshot, including removed models.
    // Pi owns cache publication, cancellation, and retaining the last good list.
    getModels: currentModels,
    getAllModels: currentModels,
  };
}

function isChatModel(model: AnyModel): model is Model<Api> {
  return model.type !== "image" && model.type !== "classifier";
}

export function commandCodeModelFacts(model: AnyModel): CommandCodeModel["commandCode"] | undefined {
  return isChatModel(model) && model.provider === COMMAND_CODE_PROVIDER_ID
    ? (model as CommandCodeModel).commandCode
    : undefined;
}
