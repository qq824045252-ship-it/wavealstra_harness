import type { ModelMetadataDto, ModelReasoningPreferenceDto } from "@shared/model-metadata";
import type { ModelsModelConfigDto, ModelsModelOverrideDto } from "@shared/agent-ipc";

/** 模型设置页共享类型与常量 */

/** models.json 中一条可编辑的自定义模型（扁平视图） */
export interface SavedModelEntry {
  providerId: string;
  baseUrl: string;
  api: string;
  modelId: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  imageInput: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  /** Pi runtime/manual provenance + provider-resolved facts. */
  metadata?: ModelMetadataDto;
  /** Runtime transport levels; model facts live in metadata.reasoningOptions. */
  allowOff: boolean;
  thinkingKeys: string[];
  /** Shared per-model native reasoning preference; persisted in settings.json, not models.json. */
  reasoningPreference?: ModelReasoningPreferenceDto;
  /** Editable file declaration, separate from resolved runtime values. */
  definition?: ModelsModelConfigDto;
  override?: ModelsModelOverrideDto;
  inputLimits?: import("@earendil-works/pi-ai").ModelInputLimits;
}

export interface LoginProviderInfo {
  id: string;
  name: string;
  authTypes: Array<"api_key" | "oauth">;
  loggedIn: boolean;
  credentialType?: "api_key" | "oauth";
  authSource?: string;
  authLabel?: string;
  baseUrl?: string;
  userAgent?: string;
  models?: ModelListItem[];
  catalogSource?: "pi";
}

export interface ModelListItem {
  id: string;
  name: string;
  vendor: string;
  supportsToolCall?: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  kind?: "chat" | "image-generation";
  enabled?: boolean;
  available?: boolean;
  contextWindow?: number;
  api?: string;
  thinkingLevels?: string[];
  metadata?: ModelMetadataDto;
  inputLimits?: import("@earendil-works/pi-ai").ModelInputLimits;
}

export function modelSourceLabel(metadata?: ModelMetadataDto): string {
  if (metadata?.configuration?.kind === "definition") return "models.json";
  const catalog = metadata?.catalogName ?? "Pi 模型目录";
  return metadata?.configuration ? `${catalog} + models.json 覆盖` : catalog;
}

export function modelLimitLabel(metadata: ModelMetadataDto | undefined, field: "contextWindow" | "maxTokens", value?: number): string {
  if (field === "maxTokens" && metadata?.outputLimitPolicy === "server") return "输出上限未公布（服务端默认）";
  const label = field === "contextWindow" ? "上下文" : "输出";
  return `${formatTokens(value)} ${label}${modelUsesDefault(metadata, field) ? "（Pi 默认）" : ""}`;
}

export function modelUsesDefault(metadata: ModelMetadataDto | undefined, field: "contextWindow" | "maxTokens" | "reasoning" | "input"): boolean {
  return Boolean(metadata?.defaultedFields?.includes(field) || metadata?.configuration?.defaultedFields.includes(field));
}

export const CTX_PRESETS = [32_000, 64_000, 128_000, 256_000, 1_000_000] as const;
export const API_OPTIONS = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock" },
] as const;

export function emptyDraft(): SavedModelEntry {
  return {
    providerId: "custom",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    modelId: "",
    name: "",
    contextWindow: 0,
    reasoning: false,
    imageInput: false,
    allowOff: false,
    thinkingKeys: [],
  };
}

/** 将上下文 token 数格式化为 32K / 128K / 1M */
export function formatTokens(n: number | undefined): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(n / (n % 1000 !== 0 && n % 1024 === 0 ? 1024 : 1000))}K`;
}
