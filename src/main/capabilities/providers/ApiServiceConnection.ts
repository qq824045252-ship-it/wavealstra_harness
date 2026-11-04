import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolExecutionContext } from "../BuiltinCapabilityRuntime";

/** A main-process-only snapshot. Headers must never be copied into config, jobs or tool results. */
export interface ResolvedApiConnection {
  id: string;
  label: string;
  /** API root, including a version path when the service requires one (for example /v1). */
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  protocol: "openai-compatible" | "magpie" | "mistral-ocr";
  model?: string;
}

/** A historical ID is supplied when resuming a video; never substitute another selected service. */
export type ApiConnectionResolver = (connectionId?: string) => ResolvedApiConnection | Promise<ResolvedApiConnection>;
export interface ApiProviderOptions {
  id?: string;
  label?: string;
  getConnection: ApiConnectionResolver;
  fetch?: typeof fetch;
  /** DNS injection for isolated tests; production uses the system resolver. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export class ApiProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(`${code}: ${message}`);
    this.name = "ApiProviderError";
  }
}

export function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /\0/.test(value)) {
    throw new ApiProviderError("input", `${name} is missing or invalid`);
  }
  return value.trim();
}

export function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maxLength);
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApiProviderError("cancelled", "request cancelled");
}

export function normalizeApiBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApiProviderError("configuration", "service URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ApiProviderError("configuration", "service URL must use HTTP(S) without credentials, query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function resolveApiConnection(options: ApiProviderOptions, connectionId?: string): Promise<ResolvedApiConnection> {
  let raw: ResolvedApiConnection;
  try { raw = await options.getConnection(connectionId); }
  catch { throw new ApiProviderError("configuration", "selected service connection is unavailable"); }
  if (!raw || !["openai-compatible", "magpie", "mistral-ocr"].includes(raw.protocol)) {
    throw new ApiProviderError("configuration", "unsupported service protocol");
  }
  const id = requiredText(raw.id, "service ID", 200);
  if (connectionId !== undefined && id !== connectionId) {
    throw new ApiProviderError("configuration", "the original video service is unavailable");
  }
  if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 30 * 60_000) {
    throw new ApiProviderError("configuration", "service timeout must be between 1 ms and 30 minutes");
  }
  let headers: Record<string, string>;
  try { headers = Object.fromEntries(new Headers(raw.headers).entries()); }
  catch { throw new ApiProviderError("configuration", "service headers are invalid"); }
  for (const forbidden of ["host", "content-length", "transfer-encoding", "connection"]) delete headers[forbidden];
  return {
    id, label: requiredText(raw.label, "service label", 200),
    baseUrl: normalizeApiBaseUrl(requiredText(raw.baseUrl, "service URL", 4_000)),
    headers, timeoutMs: raw.timeoutMs, protocol: raw.protocol,
    model: optionalText(raw.model, "model", 300),
  };
}

export function assertOpenAiShape(connection: ResolvedApiConnection): void {
  if (connection.protocol === "mistral-ocr") throw new ApiProviderError("unsupported", "this connection only supports OCR");
}

export function resolveModel(connection: ResolvedApiConnection, override?: string): string {
  return requiredText(override ?? connection.model, "model", 300);
}

export function apiEndpoint(connection: ResolvedApiConnection, path: string): string {
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(path)) throw new ApiProviderError("configuration", "invalid API route");
  return `${connection.baseUrl}${path}`;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiProviderError("response", "expected a JSON object");
  return value as Record<string, unknown>;
}

/** Paths are resolved against the task root, including symlinks, before reading or uploading. */
export async function readTaskFile(path: string, context: ToolExecutionContext, limit: number, extensions: readonly string[]): Promise<Buffer> {
  assertNotAborted(context.signal);
  requiredText(path, "input file", 4_000);
  if (!extensions.includes(extname(path).toLowerCase())) throw new ApiProviderError("format", "unsupported input file type");
  try {
    const root = await realpath(context.taskRoot);
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ApiProviderError("policy", "input file must be inside the current task");
    }
    const info = await stat(actual);
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new ApiProviderError("limit", "input file is empty or exceeds the upload limit");
    const bytes = await readFile(actual, { signal: context.signal });
    if (!bytes.length || bytes.length > limit) throw new ApiProviderError("limit", "input file is empty or exceeds the upload limit");
    assertNotAborted(context.signal);
    return bytes;
  } catch (error) {
    assertNotAborted(context.signal);
    if (error instanceof ApiProviderError) throw error;
    throw new ApiProviderError("input", "input file could not be read");
  }
}

export function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 16 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 13 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return "image/gif";
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(b.toString("ascii", 8, 12))) return "image/avif";
  return undefined;
}

export function audioMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.length >= 44 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (b.length >= 4 && (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 255 && (b[1] & 0xe0) === 0xe0))) return "audio/mpeg";
  if (b.length >= 28 && b.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp") return "audio/mp4";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x1a45dfa3) return "audio/webm";
  return undefined;
}

export function mediaMime(bytes: Uint8Array, kind: "image" | "audio" | "video"): string | undefined {
  if (kind === "image") return imageMime(bytes);
  if (kind === "audio") return audioMime(bytes);
  const b = Buffer.from(bytes);
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp" && !imageMime(b)) return "video/mp4";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  return undefined;
}

export function decodeImageBase64(value: unknown, declaredMime?: unknown): { bytes: Buffer; mimeType: string } {
  if (typeof value !== "string" || !value.length || value.length > 90 * 1024 * 1024 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ApiProviderError("response", "invalid image encoding");
  }
  const bytes = Buffer.from(value, "base64");
  const mimeType = imageMime(bytes);
  if (!mimeType || bytes.length > 64 * 1024 * 1024) throw new ApiProviderError("response", "invalid or oversized generated image");
  if (declaredMime !== undefined && declaredMime !== mimeType) throw new ApiProviderError("response", "generated image format does not match its declared type");
  return { bytes, mimeType };
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: BodyInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Video create must retain a received remote ID even if cancellation arrives at the same instant. */
  preserveCompletedResponse?: boolean;
}
export interface ApiBinaryResult { bytes: Buffer; mimeType: string; requestId?: string }

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ApiProviderError("limit", "service response exceeds the size limit");
  }
  if (!response.body) throw new ApiProviderError("response", "service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiProviderError("limit", "service response exceeds the size limit");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new ApiProviderError("response", "service returned an empty response");
  return Buffer.concat(chunks, size);
}

async function request<T>(connection: ResolvedApiConnection, url: string, options: RequestOptions,
  transport: ApiProviderOptions, authenticated: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
  assertNotAborted(options.signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(options.timeoutMs ?? connection.timeoutMs, connection.timeoutMs)));
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = new Headers(authenticated ? connection.headers : undefined);
    headers.delete("content-type");
    if (typeof options.body === "string") headers.set("content-type", "application/json");
    const response = await (transport.fetch ?? fetch)(url, {
      method: options.method ?? "POST", headers, body: options.body,
      redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate-limit" : response.status === 413 ? "limit" : "http";
      throw new ApiProviderError(code, `service returned HTTP ${response.status}`, response.status);
    }
    const result = await consume(response);
    if (!options.preserveCompletedResponse) {
      assertNotAborted(options.signal);
      if (timedOut) throw new ApiProviderError("timeout", "service request timed out");
    }
    return result;
  } catch (error) {
    assertNotAborted(options.signal);
    if (timedOut) throw new ApiProviderError("timeout", "service request timed out");
    if (error instanceof ApiProviderError) throw error;
    // Never echo provider bodies, signed URLs, headers, fetch errors, or abort reasons.
    throw new ApiProviderError("transport", "service request failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function apiJson(connection: ResolvedApiConnection, path: string, options: RequestOptions, transport: ApiProviderOptions): Promise<Record<string, unknown>> {
  return request(connection, apiEndpoint(connection, path), options, transport, true, async response => {
    const bytes = await readBounded(response, options.maxBytes ?? 8 * 1024 * 1024);
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new ApiProviderError("response", "service returned invalid JSON"); }
    return record(value);
  });
}

function responseRequestId(response: Response): string | undefined {
  const id = response.headers.get("x-request-id");
  return id && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id) ? id : undefined;
}

async function consumeMedia(response: Response, kind: "image" | "audio" | "video", maxBytes: number): Promise<ApiBinaryResult> {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream" && !type.startsWith(`${kind}/`)) {
    await response.body?.cancel();
    throw new ApiProviderError("response", `service did not return ${kind} bytes`);
  }
  const bytes = await readBounded(response, maxBytes);
  const mimeType = mediaMime(bytes, kind);
  if (!mimeType) throw new ApiProviderError("response", `service returned invalid ${kind} bytes`);
  if (type && type !== "application/octet-stream" && type !== mimeType && !(mimeType === "audio/wav" && type === "audio/x-wav") && !(mimeType === "audio/mpeg" && type === "audio/mp3")) {
    throw new ApiProviderError("response", "media bytes do not match their declared type");
  }
  return { bytes, mimeType, requestId: responseRequestId(response) };
}

export async function apiMedia(connection: ResolvedApiConnection, path: string, kind: "image" | "audio" | "video", options: RequestOptions, transport: ApiProviderOptions): Promise<ApiBinaryResult> {
  return request(connection, apiEndpoint(connection, path), options, transport, true, response => consumeMedia(response, kind, options.maxBytes ?? 64 * 1024 * 1024));
}

// Keep families separate: BlockList also compares IPv4 as mapped IPv6 addresses.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blockedV6.addSubnet(address, prefix, "ipv6");

/** Download external signed URLs without service credentials; never follow authenticated redirects. */
export async function downloadApiImage(rawUrl: string, connection: ResolvedApiConnection, options: RequestOptions, transport: ApiProviderOptions): Promise<ApiBinaryResult> {
  assertNotAborted(options.signal);
  const started = Date.now();
  const budget = Math.min(options.timeoutMs ?? connection.timeoutMs, connection.timeoutMs);
  let url: URL;
  try { url = new URL(requiredText(rawUrl, "media URL", 16_000), `${connection.baseUrl}/`); }
  catch { throw new ApiProviderError("response", "service returned an invalid media URL"); }
  const base = new URL(connection.baseUrl);
  const sameOrigin = url.origin === base.origin;
  if (url.username || url.password || url.hash || (sameOrigin ? !["http:", "https:"].includes(url.protocol) : url.protocol !== "https:")) {
    throw new ApiProviderError("policy", "media download URL is not allowed");
  }
  if (!sameOrigin) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (/^(localhost|.*\.localhost)$/.test(hostname) || hostname.endsWith(".local")) throw new ApiProviderError("policy", "external media URL must be public");
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        const finish = (error?: Error, value?: Array<{ address: string; family: number }>): void => {
          clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
          if (error) reject(error); else resolve(value!);
        };
        const abort = (): void => finish(new ApiProviderError("cancelled", "media download cancelled"));
        const timer = setTimeout(() => finish(new ApiProviderError("timeout", "media host resolution timed out")), budget);
        options.signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => (transport.lookup ?? (host => lookup(host, { all: true, verbatim: true })))(hostname))
          .then(value => finish(undefined, value), () => finish(new ApiProviderError("transport", "media host could not be resolved")));
      });
    } catch (error) {
      if (error instanceof ApiProviderError) throw error;
      throw new ApiProviderError("transport", "media host could not be resolved");
    }
    if (!addresses.length || addresses.some(({ address }) => !isIP(address) || (isIP(address) === 6 ? blockedV6.check(address, "ipv6") : blockedV4.check(address, "ipv4")))) {
      throw new ApiProviderError("policy", "external media URL must be public");
    }
  }
  const remaining = budget - (Date.now() - started);
  if (remaining <= 0) throw new ApiProviderError("timeout", "media download timed out");
  const apiPath = base.pathname.replace(/\/+$/, "");
  const withinApi = sameOrigin && (url.pathname === apiPath || url.pathname.startsWith(`${apiPath}/`));
  return request(connection, url.toString(), { ...options, method: "GET", timeoutMs: remaining }, transport, withinApi,
    response => consumeMedia(response, "image", 64 * 1024 * 1024));
}
