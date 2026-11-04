/** Connections are reusable across capabilities. Secrets never enter this contract. */
export type MediaCapabilityId = "speech-to-text" | "ocr" | "text-to-speech" | "image-generation" | "video-generation";

export const MEDIA_CAPABILITY_IDS: MediaCapabilityId[] = ["speech-to-text", "ocr", "text-to-speech", "image-generation", "video-generation"];
export const CODEX_CONNECTION_ID = "builtin-codex";
export const MAGPIE_CONNECTION_ID = "builtin-magpie";
export const LOCAL_WHISPER_CONNECTION_ID = "builtin-whisper";

/** These presets name implemented protocols, not a promise about every server. */
export type ApiCapabilityProtocol = "openai-compatible" | "openrouter" | "mistral-ocr" | "baidu-ocr";
export const BAIDU_OCR_API_ROOT = "https://aip.baidubce.com";
export const BAIDU_OCR_MODES = [
  { id: "general_basic", label: "通用文字识别" },
  { id: "general", label: "通用文字识别（含位置）" },
  { id: "accurate_basic", label: "高精度文字识别" },
  { id: "accurate", label: "高精度文字识别（含位置）" },
] as const;
export type BaiduOcrMode = (typeof BAIDU_OCR_MODES)[number]["id"];
export const BAIDU_OCR_DEFAULT_MODE: BaiduOcrMode = "general_basic";
export const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1";
export const API_PROTOCOL_CAPABILITIES: Record<ApiCapabilityProtocol, MediaCapabilityId[]> = {
  "openai-compatible": ["speech-to-text", "ocr", "text-to-speech", "image-generation", "video-generation"],
  openrouter: [...MEDIA_CAPABILITY_IDS],
  "mistral-ocr": ["ocr"],
  "baidu-ocr": ["ocr"],
};
export interface ApiCapabilityConnection {
  name: string;
  protocol: ApiCapabilityProtocol;
  /** Official preset, separate from the reusable connection ID. */
  presetId?: string;
  /** API root, normally ending in /v1. Never contains a key or query string. */
  baseUrl: string;
  auth: "api-key" | "none" | "baidu-ak-sk";
  credentialRef?: string;
  /** Two independent keyring handles. No keys or access tokens are serialized. */
  credentialRefs?: { apiKey?: string; secretKey?: string };
  timeoutMs: number;
}

/** A preset is an implemented endpoint mapping, not a hardcoded list of models. */
export interface MediaProviderPreset {
  id: string;
  label: string;
  protocol: ApiCapabilityProtocol;
  baseUrl: string;
  capabilities: MediaCapabilityId[];
  hint: string;
}

/** Built-in API choices. Custom compatible gateways remain available separately. */
export const MEDIA_PROVIDER_PRESETS: MediaProviderPreset[] = [
  { id: "openrouter", label: "OpenRouter（五项共用）", protocol: "openrouter", baseUrl: OPENROUTER_API_ROOT, capabilities: [...MEDIA_CAPABILITY_IDS], hint: "一把 API Key 连接五项能力；模型由实时能力目录或模型 ID 决定。" },
  { id: "openai", label: "OpenAI API", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", capabilities: ["speech-to-text", "ocr", "text-to-speech", "image-generation"], hint: "使用原生转写、语音、图片 API 与视觉模型 OCR；不使用已经停用的旧视频接口。" },
  { id: "groq", label: "Groq", protocol: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", capabilities: ["speech-to-text", "ocr", "text-to-speech"], hint: "语音合成使用 WAV，Orpheus 模型每次最多约 200 字；OCR 需要支持图片输入的视觉模型。" },
  { id: "gemini-vision", label: "Google Gemini（视觉 OCR）", protocol: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", capabilities: ["ocr"], hint: "仅在此预设中使用 OpenAI 兼容的视觉聊天接口；其他 Gemini 能力需专门适配。" },
  { id: "mistral-ocr", label: "Mistral OCR", protocol: "mistral-ocr", baseUrl: "https://api.mistral.ai/v1", capabilities: ["ocr"], hint: "专用文档 OCR API；与通用视觉聊天接口不同。" },
  { id: "baidu-ocr", label: "百度智能云 OCR", protocol: "baidu-ocr", baseUrl: BAIDU_OCR_API_ROOT, capabilities: ["ocr"], hint: "使用百度 OCR 专用接口；填写 API Key 与 Secret Key，选择通用或高精度识别模式。" },
];

export function connectionCapabilities(connection: ApiCapabilityConnection): MediaCapabilityId[] {
  // The Baidu native protocol only has the verified official preset;
  // generic OpenAI-compatible endpoints cannot claim to implement it.
  if (connection.protocol === "baidu-ocr" && connection.presetId !== "baidu-ocr") return [];
  const preset = MEDIA_PROVIDER_PRESETS.find((item) => item.id === connection.presetId);
  if (preset) return preset.protocol === connection.protocol ? preset.capabilities : [];
  return API_PROTOCOL_CAPABILITIES[connection.protocol] ?? [];
}

export interface MediaCapabilityBinding {
  connectionId: string;
  model?: string;
  /** Auto resolves once and stays pinned, including after logout or failures. */
  selection?: "auto" | "manual";
  /** Recognition output enters the current conversation. Preserve restrictive legacy intent. */
  dataPolicy?: "allow-cloud" | "local-only";
}

export interface CapabilityModelOption { id: string; label: string; voices?: string[] }
export interface CapabilityConnectionOption {
  id: string;
  label: string;
  source: "login" | "api" | "local" | "legacy";
  capabilities: MediaCapabilityId[];
  models: Partial<Record<MediaCapabilityId, CapabilityModelOption[]>>;
  /** A protocol can be implemented without having a vendor model catalogue. */
  allowCustomModel: boolean;
  configured: boolean;
  authState: "signed-in" | "needs-login" | "configured" | "missing-key" | "none";
  location?: "loopback" | "remote";
  detail?: string;
  /** Per-slot status only; the actual secret never leaves the main process. */
  credentialSlotsConfigured?: { apiKey: boolean; secretKey: boolean };
}

export interface CapabilityCredentialChange {
  connectionId: string;
  /** Omitted for historical one-key services. */
  slot?: "apiKey" | "secretKey";
  /** Empty/undefined keeps the existing key. Clearing is a separate explicit action. */
  secret?: string;
  clear?: boolean;
}

export interface CapabilityVideoJobDto {
  id: string;
  remoteId?: string;
  taskId: string;
  connectionId: string;
  model?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  detail?: string;
}
