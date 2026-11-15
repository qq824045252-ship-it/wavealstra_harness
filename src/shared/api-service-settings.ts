import {
  BAIDU_OCR_DEFAULT_MODE, DEEPSEEK_OCR_PURPOSES, DEEPSEEK_TTS_VOICES,
  MEDIA_PROVIDER_PRESETS, connectionCapabilities,
  type ApiCapabilityConnection, type ApiCapabilityProtocol, type MediaCapabilityId,
} from "./media-capabilities";

/** Settings metadata only. Runtime adapters still own their wire protocols.
 * All providers use the same connection editor and capability selectors. */
export const API_SERVICE_PROTOCOL_SETTINGS: Record<ApiCapabilityProtocol, {
  label: string; presetOnly: boolean; auth: ApiCapabilityConnection["auth"]; timeoutMs: number;
  initialModels?: Partial<Record<MediaCapabilityId, string>>;
}> = {
  "openai-compatible": { label: "OpenAI 兼容 API", presetOnly: false, auth: "api-key", timeoutMs: 60_000 },
  openrouter: { label: "OpenRouter 多模态 API", presetOnly: false, auth: "api-key", timeoutMs: 60_000 },
  "mistral-ocr": { label: "Mistral OCR API", presetOnly: false, auth: "api-key", timeoutMs: 60_000 },
  "baidu-ocr": { label: "百度智能云 OCR API", presetOnly: true, auth: "baidu-ak-sk", timeoutMs: 60_000,
    initialModels: { ocr: BAIDU_OCR_DEFAULT_MODE } },
  "black-forest-labs": { label: "Black Forest Labs（FLUX）原生任务 API", presetOnly: true, auth: "api-key", timeoutMs: 60_000 },
  dashscope: { label: "阿里云百炼（千问 / 万相）原生任务 API", presetOnly: true, auth: "api-key", timeoutMs: 60_000 },
  deepseek: { label: "DeepSeek 原生工具 API", presetOnly: true, auth: "api-key", timeoutMs: 180_000 },
};

export const API_SERVICE_CAPABILITY_LABELS: Record<MediaCapabilityId | "web-search" | "web-fetch", string> = {
  "speech-to-text": "语音转文字", ocr: "文字识别", "text-to-speech": "文字转语音",
  "image-generation": "图片生成", "video-generation": "视频生成", "web-search": "联网搜索", "web-fetch": "网页读取",
};

export interface ApiServiceMediaControls {
  descriptions?: Partial<Record<MediaCapabilityId, string>>;
  hints?: Partial<Record<MediaCapabilityId, string>>;
  ocrPurpose?: {
    ariaLabel: string; defaultValue: string; options: readonly { id: string; label: string }[];
  };
  speech?: {
    defaultVoice: string;
    voices: readonly { id: string; label: string }[];
    transports: readonly { id: "http" | "websocket"; label: string }[];
    defaultTransport: "http" | "websocket";
    hint: string;
  };
}
const MEDIA_CONTROLS: Partial<Record<ApiCapabilityProtocol, ApiServiceMediaControls>> = {
  deepseek: {
    descriptions: { ocr: "识别图片、扫描 PDF、Word 和 PowerPoint，保留页次及完整性。" },
    hints: { "speech-to-text": "支持 PCM WAV 或 Ogg Opus；单次最多 120 秒、8 MiB，自动识别语言。" },
    ocrPurpose: { ariaLabel: "DeepSeek OCR 识别方式", defaultValue: "text_recognition", options: DEEPSEEK_OCR_PURPOSES },
    speech: {
      defaultVoice: "stella", voices: DEEPSEEK_TTS_VOICES, defaultTransport: "websocket",
      transports: [{ id: "websocket", label: "实时播放（WebSocket）" }, { id: "http", label: "生成后播放（HTTP WAV）" }],
      hint: "实时模式可在对话中的语音卡片开始播放、暂停或停止。合成完成后保留 WAV 文件，便于重播和下载。",
    },
  },
};
const NO_MEDIA_CONTROLS: ApiServiceMediaControls = {};
export function apiServiceMediaControls(connection?: Pick<ApiCapabilityConnection, "protocol">): ApiServiceMediaControls {
  return connection ? MEDIA_CONTROLS[connection.protocol] ?? NO_MEDIA_CONTROLS : NO_MEDIA_CONTROLS;
}

export function createApiServiceConnection(presetId: string | undefined, capability?: MediaCapabilityId, ordinal = 1): ApiCapabilityConnection {
  const preset = MEDIA_PROVIDER_PRESETS.find(item => item.id === presetId);
  if (presetId && !preset) throw new Error("未知 API 服务商");
  if (preset && capability && !preset.capabilities.includes(capability)) throw new Error("服务商未接入此能力");
  const protocol = preset?.protocol ?? (capability === "ocr" ? "mistral-ocr" : "openai-compatible");
  const defaults = API_SERVICE_PROTOCOL_SETTINGS[protocol];
  return {
    name: preset?.label ?? `API 服务 ${ordinal}`, protocol, ...(preset ? { presetId: preset.id } : {}),
    baseUrl: preset?.baseUrl ?? "", auth: defaults.auth, timeoutMs: defaults.timeoutMs,
  };
}

/** A projection of the current persisted web configuration, not another store.
 * Keep adapter-owned field names here, out of the generic renderer. */
export interface ApiWebServiceConfig {
  deepseekConnectionId?: string;
  fetchProvider?: "auto" | "deepseek";
}
export interface ApiWebServiceBinding {
  provider: string;
  label: string;
  presetId: string;
  protocol: ApiCapabilityProtocol;
  connectionField: "deepseekConnectionId";
  fetchProvider: "deepseek";
}
export const API_WEB_SERVICE_BINDINGS: readonly ApiWebServiceBinding[] = [
  { provider: "deepseek", label: "DeepSeek", presetId: "deepseek", protocol: "deepseek", connectionField: "deepseekConnectionId", fetchProvider: "deepseek" },
];
type Connections = Readonly<Record<string, ApiCapabilityConnection>> | undefined;
type SearchPolicy = { mode: string; providers: readonly string[] };

export function webServiceConnections(binding: ApiWebServiceBinding, connections: Connections): [string, ApiCapabilityConnection][] {
  return Object.entries(connections ?? {}).filter(([, connection]) => connection.protocol === binding.protocol
    && connection.presetId === binding.presetId && connectionCapabilities(connection).length > 0);
}

/** Never replace a missing explicit selection or choose the first of two accounts. */
export function selectedWebServiceConnection(binding: ApiWebServiceBinding, config: ApiWebServiceConfig | null | undefined,
  connections: Connections): [string, ApiCapabilityConnection] | undefined {
  const choices = webServiceConnections(binding, connections);
  const selected = config?.[binding.connectionField];
  return selected ? choices.find(([id]) => id === selected) : choices.length === 1 ? choices[0] : undefined;
}

export function webServiceBindingActive(binding: ApiWebServiceBinding, config: ApiWebServiceConfig | null | undefined, policy: SearchPolicy): boolean {
  return config?.fetchProvider === binding.fetchProvider || policy.providers.includes(binding.provider);
}

export function apiConnectionUsedForWeb(id: string, config: ApiWebServiceConfig | null | undefined,
  policy: SearchPolicy, connections: Connections): boolean {
  return API_WEB_SERVICE_BINDINGS.some(binding => config?.[binding.connectionField] === id
    || (webServiceBindingActive(binding, config, policy) && selectedWebServiceConnection(binding, config, connections)?.[0] === id));
}

export function webSettingsDependOnConnections(config: ApiWebServiceConfig, policy: SearchPolicy, connections: Connections): boolean {
  return API_WEB_SERVICE_BINDINGS.some(binding => Boolean(config[binding.connectionField])
    || config.fetchProvider === binding.fetchProvider || policy.providers.includes(binding.provider)
    || (policy.mode === "auto" && webServiceConnections(binding, connections).length > 0));
}

export function apiServiceCapabilityLabels(connection: ApiCapabilityConnection): string[] {
  const labels = connectionCapabilities(connection).map(id => API_SERVICE_CAPABILITY_LABELS[id]);
  if (API_WEB_SERVICE_BINDINGS.some(binding => webServiceConnections(binding, { connection }).length > 0)) {
    labels.push(API_SERVICE_CAPABILITY_LABELS["web-search"], API_SERVICE_CAPABILITY_LABELS["web-fetch"]);
  }
  return labels;
}
