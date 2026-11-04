/** Connections are reusable across capabilities. Secrets never enter this contract. */
export type MediaCapabilityId = "speech-to-text" | "ocr" | "text-to-speech" | "image-generation" | "video-generation";

export const MEDIA_CAPABILITY_IDS: MediaCapabilityId[] = ["speech-to-text", "ocr", "text-to-speech", "image-generation", "video-generation"];
export const CODEX_CONNECTION_ID = "builtin-codex";
export const MAGPIE_CONNECTION_ID = "builtin-magpie";
export const LOCAL_WHISPER_CONNECTION_ID = "builtin-whisper";

/** These presets name implemented protocols, not a promise about every server. */
export type ApiCapabilityProtocol = "openai-compatible" | "mistral-ocr";
export const API_PROTOCOL_CAPABILITIES: Record<ApiCapabilityProtocol, MediaCapabilityId[]> = {
  "openai-compatible": ["speech-to-text", "ocr", "text-to-speech", "image-generation", "video-generation"],
  "mistral-ocr": ["ocr"],
};
export interface ApiCapabilityConnection {
  name: string;
  protocol: ApiCapabilityProtocol;
  /** API root, normally ending in /v1. Never contains a key or query string. */
  baseUrl: string;
  auth: "api-key" | "none";
  credentialRef?: string;
  timeoutMs: number;
}

export interface MediaCapabilityBinding {
  connectionId: string;
  model?: string;
  /** Auto resolves once and stays pinned, including after logout or failures. */
  selection?: "auto" | "manual";
  /** Recognition output enters the current conversation. Preserve restrictive legacy intent. */
  dataPolicy?: "allow-cloud" | "local-only";
}

export interface CapabilityModelOption { id: string; label: string }
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
}

export interface CapabilityCredentialChange {
  connectionId: string;
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
