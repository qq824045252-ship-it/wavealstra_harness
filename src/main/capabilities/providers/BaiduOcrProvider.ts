import { createHash } from "node:crypto";
import type { ImageRecognitionAdapter, OcrResult } from "../HttpOcrProvider";
import { ApiProviderError, assertNotAborted, imageMime, readTaskFile } from "./ApiServiceConnection";
import { BAIDU_OCR_API_ROOT, BAIDU_OCR_DEFAULT_MODE, BAIDU_OCR_MODES, type BaiduOcrMode } from "../../../shared/media-capabilities";

/** Baidu's native OCR OAuth + form-encoded API; never reuse Bearer/OpenAI transport. */
export interface BaiduOcrSettings {
  apiKey: string;
  secretKey: string;
  mode?: BaiduOcrMode;
  timeoutMs: number;
}
export interface BaiduOcrOptions {
  getSettings: () => BaiduOcrSettings;
  fetch?: typeof fetch;
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function requireSettings(settings: BaiduOcrSettings): Required<BaiduOcrSettings> {
  if (!settings?.apiKey?.trim() || !settings.secretKey?.trim() || /[\x00-\x1f\x7f]/.test(settings.apiKey + settings.secretKey)) {
    throw new ApiProviderError("authentication", "百度 OCR 需要 API Key 与 Secret Key");
  }
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 600_000) {
    throw new ApiProviderError("configuration", "百度 OCR 超时时间无效");
  }
  const mode = settings.mode ?? BAIDU_OCR_DEFAULT_MODE;
  if (!BAIDU_OCR_MODES.some(item => item.id === mode)) throw new ApiProviderError("configuration", "百度 OCR 识别模式无效");
  return { ...settings, mode };
}

function safeSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) throw new ApiProviderError("limit", "百度 OCR 响应过大");
  const reader = response.body?.getReader();
  if (!reader) throw new ApiProviderError("response", "百度 OCR 返回空结果");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ApiProviderError("limit", "百度 OCR 响应过大"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiProviderError("response", "百度 OCR 响应格式无效"); }
}

async function request(
  url: string, body: URLSearchParams, signal: AbortSignal, fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new ApiProviderError("cancelled", "百度 OCR 请求已取消或超时");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST", body: body.toString(), signal, redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    });
  } catch {
    throw new ApiProviderError(signal.aborted ? "cancelled" : "transport", signal.aborted ? "百度 OCR 请求已取消或超时" : "百度 OCR 服务无法连接");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiProviderError(response.status === 401 || response.status === 403 ? "authentication" : "http",
      "百度 OCR 服务请求失败，HTTP " + response.status, response.status);
  }
  const data = await responseJson(response);
  if (signal.aborted) throw new ApiProviderError("cancelled", "百度 OCR 请求已取消或超时");
  return data;
}

function codeError(code: number): ApiProviderError {
  const kind = [100, 110, 111].includes(code) ? "authentication"
    : code === 6 ? "permission"
    : [4, 17, 18, 19].includes(code) ? "quota"
    : [216100, 216101, 216102, 216103, 216200, 216201, 216202].includes(code) ? "input"
    : "response";
  const hint = kind === "quota" ? "额度或 QPS 不足"
    : kind === "permission" ? "未开通当前识别模式"
    : kind === "authentication" ? "鉴权失败"
    : kind === "input" ? "图片或参数无效" : "服务返回错误";
  // Do not echo upstream error_msg, token, request URL or credential data.
  return new ApiProviderError(kind, "百度 OCR " + hint + "（错误码 " + code + "）");
}

function parseOcr(data: Record<string, unknown>): OcrResult {
  if (typeof data.error_code === "number" && data.error_code !== 0) throw codeError(data.error_code);
  if (!Array.isArray(data.words_result)) throw new ApiProviderError("response", "百度 OCR 缺少文字识别结果");
  const words: string[] = [];
  const boxes: NonNullable<OcrResult["boxes"]> = [];
  for (const row of data.words_result) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiProviderError("response", "百度 OCR 文字条目无效");
    const item = row as Record<string, unknown>;
    if (typeof item.words !== "string") throw new ApiProviderError("response", "百度 OCR 识别文字无效");
    words.push(item.words);
    if (item.location !== undefined) {
      if (!item.location || typeof item.location !== "object" || Array.isArray(item.location)) throw new ApiProviderError("response", "百度 OCR 文字坐标无效");
      const loc = item.location as Record<string, unknown>;
      const { left, top, width, height } = loc;
      if (![left, top, width, height].every(x => typeof x === "number" && Number.isFinite(x))
        || (width as number) <= 0 || (height as number) <= 0) throw new ApiProviderError("response", "百度 OCR 文字坐标无效");
      const probability = item.probability;
      const confidence = probability && typeof probability === "object" && !Array.isArray(probability)
        ? (probability as Record<string, unknown>).average : undefined;
      boxes.push({ text: item.words, x: left as number, y: top as number, width: width as number, height: height as number,
        ...(typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? { confidence } : {}) });
    }
  }
  return { text: words.join("\n"), ...(boxes.length ? { boxes } : {}) };
}

/** Token is kept in memory only, scoped to an instance and credential digest. */
export function createBaiduOcrAdapter(options: BaiduOcrOptions): ImageRecognitionAdapter {
  let token: { identity: string; value: string; expiresAt: number } | undefined;
  let pending: { identity: string; promise: Promise<string> } | undefined;
  const fetchImpl = options.fetch ?? fetch;
  const refreshToken = async (settings: Required<BaiduOcrSettings>, identity: string, signal: AbortSignal): Promise<string> => {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: settings.apiKey, client_secret: settings.secretKey });
    const data = await request(BAIDU_OCR_API_ROOT + "/oauth/2.0/token", form, signal, fetchImpl);
    const value = data.access_token;
    const expires = data.expires_in;
    if (typeof value !== "string" || !value || typeof expires !== "number" || !Number.isFinite(expires) || expires < 60) {
      throw new ApiProviderError("authentication", "百度 OCR 无法取得有效 Access Token");
    }
    if (!signal.aborted) token = { identity, value, expiresAt: Date.now() + expires * 1000 };
    return value;
  };
  const acquireToken = async (settings: Required<BaiduOcrSettings>, identity: string, signal: AbortSignal): Promise<string> => {
    if (token?.identity === identity && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return token.value;
    if (pending?.identity !== identity) {
      const promise = refreshToken(settings, identity, signal);
      pending = { identity, promise };
      void promise.finally(() => { if (pending?.promise === promise) pending = undefined; }).catch(() => undefined);
    }
    return pending.promise;
  };

  return {
    async recognize(imagePath, context) {
      assertNotAborted(context.signal);
      const settings = requireSettings(options.getSettings());
      const identity = createHash("sha256").update(settings.apiKey).update("\0").update(settings.secretKey).digest("hex");
      const bytes = await readTaskFile(imagePath, context, 3 * 1024 * 1024, [".png", ".jpg", ".jpeg"]);
      if (!["image/png", "image/jpeg"].includes(imageMime(bytes) ?? "")) throw new ApiProviderError("format", "百度 OCR 当前支持 PNG/JPEG 文件");
      const form = new URLSearchParams({ image: bytes.toString("base64") });
      if (Buffer.byteLength(form.toString(), "utf8") > MAX_REQUEST_BYTES) throw new ApiProviderError("limit", "百度 OCR 图片超过编码大小限制（4 MiB）");
      const signal = safeSignal(context.signal, settings.timeoutMs);
      for (let attempt = 0; attempt < 2; attempt++) {
        const accessToken = await acquireToken(settings, identity, signal);
        const url = new URL(BAIDU_OCR_API_ROOT + "/rest/2.0/ocr/v1/" + settings.mode);
        url.searchParams.set("access_token", accessToken);
        const result = await request(url.toString(), form, signal, fetchImpl);
        if ([110, 111].includes(Number(result.error_code)) && attempt === 0) {
          if (token?.identity === identity) token = undefined;
          if (pending?.identity === identity) pending = undefined;
          continue; // Explicit token rejection means the paid OCR call was not executed.
        }
        return parseOcr(result);
      }
      throw new ApiProviderError("authentication", "百度 OCR Token 失效，请重新连接");
    },
  };
}
