import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_CODEX_IMAGE_MODEL,
  BUILTIN_CODEX_IMAGE_PROVIDER_ID,
} from "../../shared/builtin-capabilities";
import type {
  GeneratedMediaOutput,
  ImageGenerateInput,
  MediaCapabilityProvider,
  ToolExecutionContext,
} from "./BuiltinCapabilityRuntime";

const CODEX_AUTH_PROVIDER_ID = "openai-codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REQUEST_TIMEOUT_MS = 300_000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_REFERENCE_IMAGES = 5;

interface CodexImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string }>;
  quality?: string;
  size?: string;
  background?: string;
  error?: { message?: string; code?: string; type?: string } | string;
  detail?: string;
  message?: string;
}

interface CodexImageProviderRuntime {
  hasConfiguredAuth(providerId: string): boolean;
  isUsingOAuth(providerId: string): boolean;
  getAuth(
    providerId: string,
    overrides?: { minOAuthValidityMs?: number },
  ): Promise<{ auth: { apiKey?: string } } | undefined>;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
    const auth = payload[JWT_AUTH_CLAIM];
    if (!auth || typeof auth !== "object") return null;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    case ".svg": return "image/svg+xml";
    default: return "image/png";
  }
}

function parseAspectRatio(value?: string): number | null {
  if (!value?.trim()) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

function resolveImageSize(input: ImageGenerateInput): "auto" | "1024x1024" | "1536x1024" | "1024x1536" {
  const explicitRatio = input.width && input.height && input.width > 0 && input.height > 0
    ? input.width / input.height
    : null;
  const ratio = explicitRatio ?? parseAspectRatio(input.aspectRatio);
  if (ratio == null) return "auto";
  if (ratio >= 1.2) return "1536x1024";
  if (ratio <= 0.83) return "1024x1536";
  return "1024x1024";
}

function promptWithNegativeGuidance(input: ImageGenerateInput): string {
  const prompt = input.prompt.trim();
  const negative = input.negativePrompt?.trim();
  return negative ? `${prompt}\n\nAvoid these elements or qualities: ${negative}` : prompt;
}

function errorMessageFromPayload(status: number, payload: CodexImageResponse | null, fallback: string): string {
  const error = payload?.error;
  const code = typeof error === "object" && error ? error.code : undefined;
  const message = typeof error === "string"
    ? error
    : typeof error === "object" && error?.message
      ? error.message
      : payload?.detail || payload?.message || fallback;
  if (status === 401) {
    return `OpenAI Codex 登录已失效，请在模型供应商中重新登录后再试：${message}`;
  }
  if (status === 429 && code === "usage_limit_reached") {
    return `GPT Image 2 使用额度已达到上限：${message}`;
  }
  if (status === 403 && (code === "usage_not_included" || /usage[_ ]not[_ ]included/i.test(message))) {
    return `当前 ChatGPT/Codex 订阅不包含 GPT Image 2：${message}`;
  }
  return `GPT Image 2 请求失败（HTTP ${status}）：${message}`;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<CodexImageResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("GPT Image 2 请求超时")), REQUEST_TIMEOUT_MS);
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: CodexImageResponse | null = null;
    if (text.trim()) {
      try { payload = JSON.parse(text) as CodexImageResponse; } catch { /* handled below */ }
    }
    if (!response.ok) {
      throw new Error(errorMessageFromPayload(response.status, payload, text || response.statusText));
    }
    if (!payload) throw new Error("GPT Image 2 返回了空响应");
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function referenceImages(paths: string[]): Promise<Array<{ image_url: string }>> {
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`GPT Image 2 编辑最多支持 ${MAX_REFERENCE_IMAGES} 张参考图`);
  }
  return Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    if (bytes.byteLength <= 0) throw new Error(`参考图片为空：${path}`);
    return { image_url: `data:${mimeTypeForPath(path)};base64,${bytes.toString("base64")}` };
  }));
}

async function resolveCodexAuth(runtime: CodexImageProviderRuntime | null): Promise<{ token: string; accountId: string }> {
  if (!runtime || !runtime.hasConfiguredAuth(CODEX_AUTH_PROVIDER_ID) || !runtime.isUsingOAuth(CODEX_AUTH_PROVIDER_ID)) {
    throw new Error("请先在模型供应商中使用 ChatGPT 账号登录 OpenAI Codex");
  }
  const auth = await runtime.getAuth(CODEX_AUTH_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 });
  const token = auth?.auth.apiKey?.trim();
  if (!token) throw new Error("OpenAI Codex OAuth access token 不可用，请重新登录");
  const accountId = extractChatGptAccountId(token);
  if (!accountId) throw new Error("无法从 OpenAI Codex OAuth token 解析 ChatGPT account id，请重新登录");
  return { token, accountId };
}

export function createCodexImageCapabilityProvider(options: {
  getRuntime: () => Pick<ModelRuntime, "hasConfiguredAuth" | "isUsingOAuth" | "getAuth"> | null;
  fetchImpl?: typeof fetch;
}): MediaCapabilityProvider {
  const getRuntime = (): CodexImageProviderRuntime | null => options.getRuntime() as CodexImageProviderRuntime | null;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
    label: "OpenAI Codex · GPT Image 2",
    isAvailable: () => {
      const runtime = getRuntime();
      return Boolean(runtime?.hasConfiguredAuth(CODEX_AUTH_PROVIDER_ID) && runtime.isUsingOAuth(CODEX_AUTH_PROVIDER_ID));
    },
    availabilityDetail: () => "请先在模型供应商中使用 ChatGPT 账号登录 OpenAI Codex；无需额外 API Key。",
    test: async () => {
      const { token, accountId } = await resolveCodexAuth(getRuntime());
      // GET /models is the same read-only Codex auth probe used by Codex clients.
      // It detects revoked/invalidated sessions without consuming image quota.
      await requestJson(fetchImpl, `${CODEX_BASE_URL}/models?client_version=0.1.0`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          Accept: "application/json",
          originator: "mybuddy",
          "User-Agent": "MyBuddy/0.1.0",
        },
      });
      return "OpenAI Codex OAuth 联机检查通过；GPT Image 2 图像生成/编辑 Adapter 可用。";
    },
    generateImage: async (input: ImageGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> => {
      if (input.model && input.model !== BUILTIN_CODEX_IMAGE_MODEL) {
        throw new Error(`Codex 图像 Adapter 仅支持 ${BUILTIN_CODEX_IMAGE_MODEL}`);
      }
      const { token, accountId } = await resolveCodexAuth(getRuntime());
      const count = input.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("图片数量必须为 1–4");
      const refs = input.inputImagePaths?.length ? await referenceImages(input.inputImagePaths) : undefined;
      const endpoint = refs ? "/images/edits" : "/images/generations";
      const body: Record<string, unknown> = {
        prompt: promptWithNegativeGuidance(input),
        model: BUILTIN_CODEX_IMAGE_MODEL,
        n: count,
        quality: "auto",
        size: resolveImageSize(input),
        background: "auto",
      };
      if (refs) body.images = refs;
      const payload = await requestJson(fetchImpl, `${CODEX_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          Accept: "application/json",
          "Content-Type": "application/json",
          originator: "mybuddy",
          "User-Agent": "MyBuddy/0.1.0",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/",
        },
        body: JSON.stringify(body),
      }, context.signal);
      const images = (payload.data ?? []).flatMap((item, index) => {
        const base64 = item.b64_json?.trim();
        if (!base64) return [];
        return [{
          bytes: Buffer.from(base64, "base64"),
          mimeType: "image/png",
          fileName: `gpt-image-2-${index + 1}.png`,
          metadata: { created: payload.created, quality: payload.quality, size: payload.size, background: payload.background },
        }];
      });
      if (images.length === 0) throw new Error("GPT Image 2 响应中没有可用图片数据");
      return {
        provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
        model: BUILTIN_CODEX_IMAGE_MODEL,
        items: images,
        metadata: {
          endpoint,
          created: payload.created,
          quality: payload.quality,
          size: payload.size,
          background: payload.background,
        },
      };
    },
  };
}
