import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Api, Model, StreamOptions, TextContent } from "@earendil-works/pi-ai";
import { deepseekRecord } from "../../../shared/deepseek";

export interface DeepSeekFileReference {
  version: 1;
  path: string;
  name: string;
  sha256: string;
  bytes: number;
  purpose: "user_data" | "text_recognition" | "rich_layout_recognition";
}
export type DeepSeekFileContent = TextContent & { mybuddyDeepSeekFile: DeepSeekFileReference };

const parsedDocuments = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx"]);
const userData = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".xlsx", ".xls", ".epub", ".mobi",
  ".txt", ".md", ".csv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".log", ".ts", ".tsx", ".js", ".jsx",
  ".py", ".html", ".css", ".sql", ".sh", ".toml", ".ini"]);

/** Called only by BotAttachmentInput after reading a host-snapshotted attachment.
 * Model text, tool results and paths mentioned in a prompt never create a marker. */
export function deepseekFileAttachment(path: string, name: string, bytes: Uint8Array, mode: "text" | "rich"): DeepSeekFileContent | undefined {
  const extension = extname(name).toLowerCase();
  const purpose = parsedDocuments.has(extension) ? mode === "rich" ? "rich_layout_recognition" : "text_recognition"
    : userData.has(extension) ? "user_data" : undefined;
  if (!purpose) return;
  return {
    type: "text",
    text: `附件 ${JSON.stringify(name)} 的原文通过 DeepSeek Files 提供。若本次请求未包含 file_id，文件尚未解析，不可只根据路径推断内容。`,
    mybuddyDeepSeekFile: { version: 1, path, name, bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"), purpose },
  };
}

export function deepseekFileReference(block: unknown): DeepSeekFileReference | undefined {
  const value = deepseekRecord(deepseekRecord(block)?.mybuddyDeepSeekFile);
  if (value?.version !== 1 || typeof value.path !== "string" || typeof value.name !== "string"
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.bytes !== "number" || value.bytes <= 0 || value.bytes > 25 * 1024 * 1024
    || !["user_data", "text_recognition", "rich_layout_recognition"].includes(String(value.purpose))) return;
  return value as unknown as DeepSeekFileReference;
}

export function deepseekRequestHeaders(model: Model<Api>, options?: StreamOptions): Headers {
  const headers = new Headers();
  let suppressAuthorization = false;
  for (const values of [model.headers, options?.headers]) for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined) continue;
    if (value === null) headers.delete(name); else headers.set(name, value);
    if (name.toLowerCase() === "authorization") suppressAuthorization = value === null;
  }
  if (!headers.has("authorization") && !suppressAuthorization && options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
  return headers;
}

/** A credential fingerprint scopes opaque provider state without persisting keys.
 * Rotating to another key deliberately causes a fresh upload / page read. */
export function deepseekCredentialTag(model: Model<Api>, options?: StreamOptions): string {
  return createHash("sha256").update(deepseekRequestHeaders(model, options).get("authorization") ?? "").digest("hex");
}

export function deepseekSafeError(message: string, model: Model<Api>, options: StreamOptions): string {
  let safe = message;
  const headers = deepseekRequestHeaders(model, options);
  const secrets = [options.apiKey, headers.get("authorization"), headers.get("x-api-key")];
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").slice(0, 2000);
}

async function uploadResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  if (!response.body) throw new Error("DeepSeek Files 返回了空响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 64 * 1024) { await reader.cancel(); throw new Error("DeepSeek Files 返回的文件信息过大"); }
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return deepseekRecord(JSON.parse(new TextDecoder().decode(bytes))); }
    catch { throw new Error("DeepSeek Files 返回了无效 JSON"); }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

type UploadedFile = { id: string; expiresAt: number };
const FILE_LIFETIME_SECONDS = 24 * 60 * 60;

/** One provider instance owns its cache. Restart keeps the immutable attachment
 * in Durable and uploads again; it never relies on an expired server-side file. */
export class DeepSeekFileUploads {
  private readonly completed = new Map<string, UploadedFile>();

  async upload(reference: DeepSeekFileReference, model: Model<Api>, options: StreamOptions): Promise<string> {
    options.signal?.throwIfAborted();
    const key = [new URL(model.baseUrl).origin, deepseekCredentialTag(model, options), reference.path, reference.sha256, reference.purpose].join("\n");
    const now = Date.now();
    for (const [cacheKey, value] of this.completed) if (value.expiresAt <= now + 60_000) this.completed.delete(cacheKey);
    const prior = this.completed.get(key);
    if (prior) return prior.id;
    const fileStat = await stat(reference.path);
    if (!fileStat.isFile() || fileStat.size !== reference.bytes) throw new Error(`DeepSeek 附件「${reference.name}」持久副本已变化，请重新添加附件。`);
    const bytes = await readFile(reference.path);
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error(`DeepSeek 附件「${reference.name}」内容已变化，请重新添加附件。`);
    options.signal?.throwIfAborted();
    const headers = deepseekRequestHeaders(model, options);
    if (!headers.get("authorization")) throw new Error("DeepSeek Files 缺少模型 API Key");
    headers.delete("content-type");
    const body = new FormData();
    // DeepSeek parses multipart fields sequentially: purpose must precede file.
    body.append("purpose", reference.purpose);
    body.append("expires_after[anchor]", "created_at");
    body.append("expires_after[seconds]", String(FILE_LIFETIME_SECONDS));
    body.append("file", new Blob([new Uint8Array(bytes)]), reference.name);
    // Parsing can take another 120s after upload; cover both phases. Plain text,
    // spreadsheets, ebooks and images have a ten-minute upload limit.
    const timeout = AbortSignal.timeout(reference.purpose === "user_data" ? 600_000 : 240_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${new URL(model.baseUrl).origin}/files`, {
        method: "POST", headers, body, signal, redirect: "error",
      });
    } catch {
      throw new Error("DeepSeek 文件上传 / 解析被中断，服务器可能仍在处理。未自动重传，请检查文件上传结果后再重试。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`DeepSeek 文件上传 / 解析失败（HTTP ${response.status}）：${reference.name}`);
    }
    let result: Record<string, unknown> | undefined;
    try { result = await uploadResponse(response, signal); }
    catch (error) {
      if (signal.aborted) throw new Error("DeepSeek 文件上传 / 解析被中断，服务器可能仍在处理。未自动重传，请检查文件上传结果后再重试。");
      throw new Error(deepseekSafeError(error instanceof Error ? error.message : "DeepSeek Files 响应读取失败", model, options));
    }
    if (result && "error" in result) throw new Error("DeepSeek Files 返回了上传 / 解析错误，未使用文件 ID");
    if (typeof result?.id !== "string" || !/^[\w-]{1,256}$/.test(result.id)) throw new Error("DeepSeek Files 返回了无效 file_id");
    options.signal?.throwIfAborted();
    const expiresAt = typeof result.expires_at === "number" ? Math.min(result.expires_at * 1000, now + FILE_LIFETIME_SECONDS * 1000) : now + FILE_LIFETIME_SECONDS * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("DeepSeek Files 返回的文件已过期");
    this.completed.set(key, { id: result.id, expiresAt });
    return result.id;
  }
}
