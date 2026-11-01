import { DEFAULT_MULTI_MODEL_CONSULT_CONFIG, type MultiModelConsultConfig } from "./multi-model-consult";
/**
 * MyBuddy native capability contract.
 *
 * These are product-owned capabilities, not Hub resources or user-installable
 * Pi extensions.  The renderer only receives configuration/status metadata;
 * credentials stay in the Main process keyring.
 */

export type BuiltinCapabilityId =
  | "web"
  | "ocr"
  | "vision"
  | "image-generation"
  | "video-generation"
  | "speech-to-text"
  | "text-to-speech"
  | "browser"
  | "runtime-diagnostics"
  | "terminal"
  | "code-execution"
  | "subagent"
  | "multi-model-consult";

export type BuiltinCapabilityCategory =
  | "web"
  | "media"
  | "speech"
  | "automation"
  | "execution"
  | "agent";

export type BuiltinCapabilityState =
  | "ready"
  | "unchecked"
  | "disabled"
  | "needs-configuration"
  | "missing-dependency"
  | "offline"
  | "degraded";

export type BuiltinCredentialId = string;

/** Product-owned Codex image adapter. Reuses the existing openai-codex ChatGPT OAuth credential. */
export const BUILTIN_CODEX_IMAGE_PROVIDER_ID = "openai-codex-images";
export const BUILTIN_CODEX_IMAGE_MODEL = "gpt-image-2";

export interface BuiltinWebConfig {
  /** WebAccess is product-owned; provider routing lives in web-search.json. */
  enabled: boolean;
}

export interface BuiltinVisionConfig {
  enabled: boolean;
  /** Selected available multimodal chat model, in provider/model form. */
  model?: string;
}

export interface BuiltinMediaConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
}

/** Endpoint is the complete request URL. No secrets in this DTO. */
export interface RecognitionServiceConfig {
  adapter: "http-asr" | "http-ocr";
  endpoint: string;
  model: string;
  credentialRef?: string;
  location: "local" | "network" | "cloud";
  dataPolicy: "allow-cloud" | "local-only";
  timeoutMs: number;
}

export interface BuiltinSpeechToTextConfig {
  enabled: boolean;
  provider?: string;
  serviceId?: string;
}

export interface BuiltinTextToSpeechConfig {
  enabled: boolean;
  provider?: string;
  voice?: string;
  rate?: string;
}

export interface BuiltinBrowserConfig {
  enabled: boolean;
}

export interface BuiltinExecutionConfig {
  terminalEnabled: boolean;
  codeExecutionEnabled: boolean;
}

export interface BuiltinSubagentConfig {
  enabled: boolean;
}

export interface BuiltinCapabilitiesConfigDto {
  schemaVersion: 1;
  services?: Record<string, RecognitionServiceConfig>;
  ocr?: { enabled: boolean; serviceId?: string };
  web: BuiltinWebConfig;
  vision: BuiltinVisionConfig;
  imageGeneration: BuiltinMediaConfig;
  videoGeneration: BuiltinMediaConfig;
  speechToText: BuiltinSpeechToTextConfig;
  textToSpeech: BuiltinTextToSpeechConfig;
  /** Browser + MyBuddy UI + Windows desktop interaction umbrella. */
  browser: BuiltinBrowserConfig;
  /** Optional for schema-v1 compatibility; legacy configurations inherit browser.enabled. */
  diagnostics?: { enabled: boolean };
  execution: BuiltinExecutionConfig;
  subagent: BuiltinSubagentConfig;
  multiModelConsult: MultiModelConsultConfig;
}

export interface BuiltinCapabilityStatusDto {
  id: BuiltinCapabilityId;
  label: string;
  description: string;
  category: BuiltinCapabilityCategory;
  enabled: boolean;
  state: BuiltinCapabilityState;
  tools: string[];
  provider?: string;
  credentialConfigured?: boolean;
  detail?: string;
}

export interface BuiltinCapabilitiesSnapshotDto {
  config: BuiltinCapabilitiesConfigDto;
  capabilities: BuiltinCapabilityStatusDto[];
  checkedAt: number;
}

export interface SaveBuiltinCredentialRequest {
  id: BuiltinCredentialId;
  /** Empty/undefined with clear=false means leave unchanged. */
  secret?: string;
  clear?: boolean;
}

export interface TestBuiltinCapabilityResultDto {
  ok: boolean;
  state: BuiltinCapabilityState;
  detail: string;
  checkedAt: number;
}

export const DEFAULT_BUILTIN_CAPABILITIES_CONFIG: BuiltinCapabilitiesConfigDto = {
  schemaVersion: 1,
  web: {
    enabled: true,
  },
  vision: { enabled: true },
  imageGeneration: {
    enabled: true,
    provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
    model: BUILTIN_CODEX_IMAGE_MODEL,
  },
  videoGeneration: {
    enabled: true,
  },
  speechToText: { enabled: true, provider: "local-whisper" },
  textToSpeech: {
    enabled: true,
  },
  browser: { enabled: true },
  diagnostics: { enabled: true },
  execution: { terminalEnabled: true, codeExecutionEnabled: true },
  subagent: { enabled: true },
  multiModelConsult: structuredClone(DEFAULT_MULTI_MODEL_CONSULT_CONFIG),
};

export const BUILTIN_CAPABILITY_TOOLS: Record<BuiltinCapabilityId, string[]> = {
  web: ["web_search", "fetch_content", "source_check", "get_search_content"],
  vision: ["describe_image"],
  ocr: ["ocr_file"],
  "image-generation": ["image_generate"],
  "video-generation": ["video_generate"],
  "speech-to-text": ["speech_to_text"],
  "text-to-speech": ["text_to_speech"],
  browser: ["browser_exec", "ui_exec", "computer_exec"],
  "runtime-diagnostics": ["runtime_probe"],
  terminal: ["bash"],
  "code-execution": ["execute_code"],
  subagent: ["subagent", "subagent_list", "subagent_steer"],
  "multi-model-consult": ["multi_model_consult"],
};
