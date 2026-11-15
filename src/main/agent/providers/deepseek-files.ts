import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Api, Model, StreamOptions, TextContent } from "@earendil-works/pi-ai";
import { deepseekRecord, type DeepSeekFileProgress } from "../../../shared/deepseek";

export interface DeepSeekFileReference {
  version: 1;
  path: string;
  name: string;
  sha256: string;
  bytes: number;
  purpose: "user_data" | "text_recognition" | "rich_layout_recognition";
}
export type DeepSeekFileContent = TextContent & { mybuddyDeepSeekFile: DeepSeekFileReference };

const parsedDocuments = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".bmp", ".tif", ".tiff"]);
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
  const authHeader = model.api === "anthropic-messages" ? "x-api-key" : "authorization";
  let suppressAuthorization = false;
  for (const values of [model.headers, options?.headers]) for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined) continue;
    if (value === null) headers.delete(name); else headers.set(name, value);
    if (name.toLowerCase() === authHeader) suppressAuthorization = value === null;
  }
  if (!headers.has(authHeader) && !suppressAuthorization && options?.apiKey) headers.set(authHeader, authHeader === "authorization" ? `Bearer ${options.apiKey}` : options.apiKey);
  return headers;
}

/** A credential fingerprint scopes opaque provider state without persisting keys.
 * Rotating to another key deliberately causes a fresh upload / page read. */
export function deepseekCredentialTag(model: Model<Api>, options?: StreamOptions): string {
  const headers = deepseekRequestHeaders(model, options);
  const auth = model.api === "anthropic-messages" ? headers.get("x-api-key") ?? headers.get("authorization") : headers.get("authorization");
  return createHash("sha256").update(auth?.replace(/^Bearer\s+/i, "") ?? "").digest("hex");
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
type Progress = (value: DeepSeekFileProgress) => void;
type PendingUpload = { promise: Promise<UploadedFile>; controller: AbortController; listeners: Set<Progress>; users: number; latest?: DeepSeekFileProgress };
const pendingUploads = new Map<string, PendingUpload>();
const receiptWrites = new Map<string, Promise<void>>();

async function readReceipts(path: string): Promise<Record<string, UploadedFile>> {
  let bytes: Buffer;
  try {
    if ((await stat(path)).size > 64 * 1024) throw new Error("上传记录过大");
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("无法读取 DeepSeek 附件上传记录，未重复上传。请检查附件目录后重试。");
  }
  try {
    const value = deepseekRecord(JSON.parse(bytes.toString("utf8")));
    const entries = deepseekRecord(value?.files);
    if (value?.version !== 1 || !entries) throw new Error("无效记录");
    const result: Record<string, UploadedFile> = {};
    for (const [key, item] of Object.entries(entries)) {
      const file = deepseekRecord(item);
      if (/^[a-f0-9]{64}$/.test(key) && typeof file?.id === "string" && /^[\w-]{1,256}$/.test(file.id)
        && typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt) && file.expiresAt > Date.now() + 60_000) {
        result[key] = { id: file.id, expiresAt: file.expiresAt };
      }
    }
    return result;
  } catch { throw new Error("DeepSeek 附件上传记录损坏，未重复上传。请重新添加附件后重试。"); }
}

async function writeReceipt(path: string, key: string, file: UploadedFile): Promise<void> {
  const previous = receiptWrites.get(path) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const files = await readReceipts(path);
    files[key] = file;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, files }), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  });
  receiptWrites.set(path, write);
  try { await write; } finally { if (receiptWrites.get(path) === write) receiptWrites.delete(path); }
}

/** Upload receipts live beside the immutable host attachment. They contain only
 * opaque IDs, expiry and hashed identity; no API key or source text. */
export class DeepSeekFileUploads {
  private readonly completed = new Map<string, UploadedFile>();

  async upload(reference: DeepSeekFileReference, model: Model<Api>, options: StreamOptions, onProgress?: Progress): Promise<string> {
    options.signal?.throwIfAborted();
    const key = createHash("sha256").update([new URL(model.baseUrl).origin, deepseekCredentialTag(model, options), reference.sha256, reference.purpose].join("\n")).digest("hex");
    const pendingKey = `${reference.path}\n${key}`;
    let pending = pendingUploads.get(pendingKey);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const active: PendingUpload = { controller, listeners: new Set(), users: 0, promise: Promise.resolve({ id: "", expiresAt: 0 }) };
      const report: Progress = value => { active.latest = value; for (const listener of active.listeners) listener(value); };
      active.promise = this.performUpload(reference, key, model, { ...options, signal: controller.signal }, report)
        .finally(() => { if (pendingUploads.get(pendingKey) === active) pendingUploads.delete(pendingKey); });
      pendingUploads.set(pendingKey, active);
      pending = active;
    }
    const active = pending;
    return await new Promise<string>((resolve, reject) => {
      active.users++;
      if (onProgress) { active.listeners.add(onProgress); if (active.latest) onProgress(active.latest); }
      let settled = false;
      const cleanup = () => { settled = true; active.users--; options.signal?.removeEventListener("abort", abort); if (onProgress) active.listeners.delete(onProgress); };
      const abort = () => { if (settled) return; cleanup(); if (active.users === 0) active.controller.abort(options.signal?.reason); reject(options.signal?.reason ?? new Error("附件上传已停止")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      active.promise.then(file => { if (!settled) { cleanup(); resolve(file.id); } }, error => { if (!settled) { cleanup(); reject(error); } });
    });
  }

  private async performUpload(reference: DeepSeekFileReference, key: string, model: Model<Api>, options: StreamOptions, onProgress: Progress): Promise<UploadedFile> {
    const progress = { id: createHash("sha256").update(`${reference.path}\n${key}`).digest("hex").slice(0, 24), name: reference.name, purpose: reference.purpose };
    onProgress({ ...progress, status: "preparing" });
    try {
      const receiptPath = `${reference.path}.deepseek-files.json`;
      const now = Date.now();
      for (const [cacheKey, value] of this.completed) if (value.expiresAt <= now + 60_000) this.completed.delete(cacheKey);
      const fileStat = await stat(reference.path);
      if (!fileStat.isFile() || fileStat.size !== reference.bytes) throw new Error(`DeepSeek 附件「${reference.name}」持久副本已变化，请重新添加附件。`);
      const bytes = await readFile(reference.path);
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error(`DeepSeek 附件「${reference.name}」内容已变化，请重新添加附件。`);
      options.signal?.throwIfAborted();
      const prior = this.completed.get(`${reference.path}\n${key}`) ?? (await readReceipts(receiptPath))[key];
      options.signal?.throwIfAborted();
      if (prior) { onProgress({ ...progress, status: "ready", reused: true, expiresAt: prior.expiresAt }); return prior; }
      const headers = deepseekRequestHeaders(model, options);
      if (model.api === "anthropic-messages" && headers.has("x-api-key")) {
        headers.set("authorization", `Bearer ${headers.get("x-api-key")}`);
        headers.delete("x-api-key");
      }
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
      onProgress({ ...progress, status: "uploading" });
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
      const uploaded = { id: result.id, expiresAt };
      this.completed.set(`${reference.path}\n${key}`, uploaded);
      let message: string | undefined;
      try { await writeReceipt(receiptPath, key, uploaded); }
      catch { message = "文件已就绪，但复用记录未能保存。当前请求可继续，应用重启后可能需要重新上传。"; }
      onProgress({ ...progress, status: "ready", reused: false, expiresAt, ...(message ? { message } : {}) });
      return uploaded;
    } catch (error) {
      onProgress({ ...progress, status: "error", message: options.signal?.aborted
        ? "附件上传 / 解析已停止等待，服务器可能仍在处理；未自动重传。"
        : deepseekSafeError(error instanceof Error ? error.message : String(error), model, options) });
      throw error;
    }
  }
}
