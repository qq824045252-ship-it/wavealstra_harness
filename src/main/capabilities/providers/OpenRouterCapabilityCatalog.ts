import { OPENROUTER_API_ROOT, type CapabilityModelOption, type MediaCapabilityId } from "../../../shared/media-capabilities";

/** Read-only discovery. We never turn an audio-input chat model into an STT model. */
export interface OpenRouterCapabilityCatalog {
  models: Partial<Record<MediaCapabilityId, CapabilityModelOption[]>>;
  partial: boolean;
}
export interface OpenRouterCatalogOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
type ModelRow = Record<string, unknown>;
const MAX_CATALOG_BYTES = 6 * 1024 * 1024;
const ROUTES = [
  ["image-generation", "/images/models"],
  ["video-generation", "/videos/models"],
  ["text-to-speech", "/models?output_modalities=speech"],
  ["speech-to-text", "/models?output_modalities=transcription"],
  ["ocr", "/models?input_modalities=image&output_modalities=text"],
] as const;

function object(value: unknown): ModelRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ModelRow : null;
}
function listedModels(value: unknown, capability: MediaCapabilityId): CapabilityModelOption[] {
  const data = object(value)?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter 模型目录格式无效");
  const seen = new Set<string>();
  const result: CapabilityModelOption[] = [];
  for (const raw of data) {
    const row = object(raw);
    if (!row) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || id.length > 300 || seen.has(id)) continue;
    const architecture = object(row?.architecture);
    const input = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
    const output = Array.isArray(architecture?.output_modalities) ? architecture.output_modalities : [];
    // If a gateway includes explicit modalities, they must not contradict
    // the dedicated directory's capability. Otherwise trust that endpoint's
    // server-side filter rather than guessing from a model's name.
    if (capability === "image-generation" && output.length && !output.includes("image")) continue;
    if (capability === "ocr" && ((input.length && !input.includes("image")) || (output.length && !output.includes("text")))) continue;
    if (capability === "text-to-speech" && output.length && !output.includes("speech") && !output.includes("audio")) continue;
    const label = typeof row.name === "string" && row.name.trim() ? row.name.trim()
      : typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : id;
    const voices = Array.isArray(row?.supported_voices)
      ? [...new Set(row.supported_voices.filter((voice): voice is string => typeof voice === "string" && voice.length > 0 && voice.length < 150))].slice(0, 200)
      : [];
    result.push({ id, label, ...(capability === "text-to-speech" && voices.length ? { voices } : {}) });
    seen.add(id);
    if (result.length === 350) break;
  }
  return result;
}
async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_CATALOG_BYTES) throw new Error("OpenRouter 模型目录过大");
  if (!response.body) throw new Error("OpenRouter 返回空目录");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let lengthRead = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      lengthRead += chunk.value.byteLength;
      if (lengthRead > MAX_CATALOG_BYTES) { await reader.cancel(); throw new Error("OpenRouter 模型目录过大"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, lengthRead).toString("utf8")); }
  catch { throw new Error("OpenRouter 模型目录不是合法 JSON"); }
}

/**
 * The official OpenRouter API uses separate media catalogues. Audio
 * transcription has its own output modality: transcription, distinct
 * from generic audio-input chat models. Never guess capability from names.
 */
export async function discoverOpenRouterCapabilities(
  key: string,
  options: OpenRouterCatalogOptions = {},
): Promise<OpenRouterCapabilityCatalog> {
  if (!key?.trim() || key.length > 4096) throw new Error("请先配置有效的 OpenRouter API Key");
  // The key travels in an Authorization header: Headers rejects non-ASCII text
  // with a ByteString error, which would otherwise surface as "目录暂不可用".
  if (/[^\x21-\x7e]/.test(key)) throw new Error("OpenRouter API Key 含中文、空格或换行等无法放进请求头的字符；请重新复制服务商提供的 Key 后保存。");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("OpenRouter 目录超时设置无效");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const headers = new Headers({ authorization: `Bearer ${key.trim()}`, accept: "application/json" });
  const fetcher = options.fetchImpl ?? fetch;
  const settled = await Promise.allSettled(ROUTES.map(async ([capability, route]) => {
    if (signal.aborted) throw new Error("OpenRouter 目录读取已取消");
    let response: Response;
    try { response = await fetcher(`${OPENROUTER_API_ROOT}${route}`, { method: "GET", headers, signal, redirect: "error" }); }
    catch { throw new Error("OpenRouter 服务无法连接"); }
    if (!response.ok) throw new Error(`OpenRouter 模型目录 HTTP ${response.status}`);
    return { capability, models: listedModels(await boundedJson(response), capability) };
  }));
  if (signal.aborted) throw new Error("OpenRouter 目录读取已取消或超时");
  const models: OpenRouterCapabilityCatalog["models"] = {};
  let success = 0;
  for (const item of settled) {
    if (item.status === "fulfilled") { models[item.value.capability] = item.value.models; success++; }
  }
  if (!success) {
    // Keep the HTTP status when every route failed; the settings panel uses it
    // to tell a rejected key apart from a network problem.
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    const status = failure ? /HTTP (\d{3})/.exec(failure.reason instanceof Error ? failure.reason.message : "")?.[1] : undefined;
    throw new Error(status ? `OpenRouter 模型目录暂不可用（HTTP ${status}）；仍可手动输入已知模型 ID` : "OpenRouter 模型目录暂不可用；仍可手动输入已知模型 ID");
  }
  return { models, partial: success !== ROUTES.length };
}

/** One actionable sentence per failure class for the settings panel. */
export function describeOpenRouterCatalogError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // Check the character problem before the generic "API Key" branch: a key that
  // exists but cannot be put in a header needs a different fix than a missing one.
  if (/请求头|ByteString|无法放进/.test(message)) return "OpenRouter API Key 含中文、空格或换行等无法放进请求头的字符；请重新复制服务商提供的 Key 后保存。";
  if (/API Key/.test(message)) return "请先填写有效的 OpenRouter API Key，然后刷新模型目录。";
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return `OpenRouter 拒绝了此 API Key（HTTP ${status}）；原服务选择已保留，请更换 Key 后刷新目录。`;
  if (status) return `OpenRouter 模型目录暂不可用（HTTP ${status}）；原服务选择已保留，可手动填写模型 ID。`;
  if (/无法连接|超时|取消/.test(message)) return "OpenRouter 模型目录读取超时或无法连接；原服务选择已保留，可手动填写模型 ID。";
  return "OpenRouter 模型目录暂不可用；原服务选择已保留，可手动填写模型 ID。";
}
