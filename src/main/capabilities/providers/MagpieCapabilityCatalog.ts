import type { MagpieGatewayConfig } from "../../agent/providers/magpie";

/**
 * Protocol checked against yetone/magpie at this revision, not guessed from
 * model names or from a chat model's image/audio input modalities.
 *
 * gateway.go:927-932, 1005-1025, 1075-1078, 1410-1501:
 *   GET /v1 gives the gateway's API list; /v1/models?kind=image,video lists
 *   media models. There is no audio kind: unknown kinds are rejected.
 * transcribe.go:18-43 and speech.go:14-41:
 *   Audio routes require an explicit provider/model; they have no typed
 *   model catalogue. Advertising a route does not verify an upstream model.
 * https://github.com/yetone/magpie/tree/f8987ce6173abacf503fb97f9bb36f63225c1824
 */
export const MAGPIE_CAPABILITY_PROTOCOL_REVISION = "f8987ce6173abacf503fb97f9bb36f63225c1824";

export interface MagpieCapabilityModel {
  /** Opaque gateway ID; pass it to Magpie unchanged when invoking a model. */
  id: string;
  label: string;
  kind: "image" | "video";
  inputModalities: string[];
  outputModalities: string[];
}

export interface MagpieAudioCapability {
  /** Relative to the configured API root (normally ending in /v1). */
  endpoint: "/audio/transcriptions" | "/audio/speech";
  modelDiscovery: "manual";
  /** A gateway route is advertised; this is not a check of an upstream model. */
  available: boolean | undefined;
}

export interface MagpieCapabilityCatalog {
  models: MagpieCapabilityModel[];
  audio: {
    asr: MagpieAudioCapability;
    tts: MagpieAudioCapability;
  };
  version?: string;
}

export interface MagpieCapabilityCatalogOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function apiRoot(value: string | undefined): string {
  if (!value?.trim()) throw new Error("尚未配置 Magpie 网关地址");
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Magpie 网关地址无效"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Magpie 网关地址须为不含凭据、查询参数或片段的 HTTP(S) API 地址");
  }
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

function requestHeaders(config: MagpieGatewayConfig): Headers {
  try {
    const headers = new Headers(config.headers);
    headers.set("accept", "application/json");
    // Match the existing Magpie chat provider: an explicitly configured
    // Authorization header takes precedence over the gateway's API key.
    if (config.apiKey?.trim() && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${config.apiKey.trim()}`);
    }
    return headers;
  } catch {
    // Headers/URL/fetch errors can contain the original credential. Never
    // include them, an upstream response body, or a cause in a renderer error.
    throw new Error("Magpie 网关请求头配置无效");
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("Magpie 能力目录读取已取消或超时");
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal, redirect: "error" });
  } catch {
    throw new Error(signal.aborted ? "Magpie 能力目录读取已取消或超时" : "无法连接 Magpie 网关");
  }
  if (!response.ok) throw new Error(`Magpie 网关目录请求失败（HTTP ${response.status}）`);
  try { return await response.json(); }
  catch { throw new Error(signal.aborted ? "Magpie 能力目录读取已取消或超时" : "Magpie 网关返回了无效的 JSON 目录"); }
}

function modalities(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && MODALITIES.has(item)))]
    : [];
}

function mediaModels(value: unknown): MagpieCapabilityModel[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new Error("Magpie 网关返回的能力目录格式无效");
  const models: MagpieCapabilityModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const row = record(item);
    if (!row) throw new Error("Magpie 网关返回了无效的模型条目");
    // Some older gateways ignore the kind query. Their chat/vision models
    // must never turn into image generators or audio models here.
    if (row.kind !== "image" && row.kind !== "video") continue;
    const id = nonempty(row.id);
    if (!id) throw new Error("Magpie 媒体模型缺少 ID");
    const key = `${row.kind}:${id}`;
    if (seen.has(key)) throw new Error("Magpie 能力目录包含重复的媒体模型 ID");
    seen.add(key);
    const media = record(row.modalities);
    models.push({
      id,
      label: nonempty(row.magpie_label) ?? nonempty(row.display_name) ?? id,
      kind: row.kind,
      inputModalities: modalities(media?.input),
      outputModalities: modalities(media?.output),
    });
  }
  return models;
}

/**
 * Read-only service discovery using the already configured Magpie identity.
 * No user files, prompts, paid probes or provider secrets are returned.
 * The caller owns caching and preserves existing bindings on a failed refresh.
 */
export async function discoverMagpieCapabilities(
  config: MagpieGatewayConfig,
  options: MagpieCapabilityCatalogOptions = {},
): Promise<MagpieCapabilityCatalog> {
  const baseUrl = apiRoot(config.baseUrl);
  const headers = requestHeaders(config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Magpie 目录读取超时设置无效");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Info is optional: proxies/older gateways may not expose it, while a
  // successful typed media catalogue still supports a real image binding.
  const [catalogResult, infoResult] = await Promise.allSettled([
    requestJson(fetchImpl, `${baseUrl}/models?kind=image,video`, headers, signal),
    requestJson(fetchImpl, baseUrl, headers, signal),
  ]);
  if (options.signal?.aborted) throw new Error("Magpie 能力目录读取已取消或超时");
  if (catalogResult.status === "rejected") throw catalogResult.reason;
  const models = mediaModels(catalogResult.value);
  const rawInfo = infoResult.status === "fulfilled" ? record(infoResult.value) : undefined;
  const info = rawInfo?.name === "magpie" ? rawInfo : undefined;
  const apis = Array.isArray(info?.apis) && info.apis.every((path) => typeof path === "string")
    ? info.apis as string[]
    : undefined;
  const version = nonempty(info?.version);
  return {
    models,
    audio: {
      asr: { endpoint: "/audio/transcriptions", modelDiscovery: "manual", available: apis?.includes("/v1/audio/transcriptions") },
      tts: { endpoint: "/audio/speech", modelDiscovery: "manual", available: apis?.includes("/v1/audio/speech") },
    },
    ...(version ? { version } : {}),
  };
}
