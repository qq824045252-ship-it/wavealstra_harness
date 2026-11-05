import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { GeneratedMediaItem, GeneratedMediaOutput, ImageGenerateInput, MediaCapabilityProvider, ToolExecutionContext, VideoGenerateInput } from "../BuiltinCapabilityRuntime";
import {
  VideoJobPendingError, assertVideoJobId, newVideoJobId, videoConnectionSnapshot,
  type VideoGenerationJob, type VideoGenerationJobStore,
} from "../VideoGenerationJobs";
import {
  ApiProviderError, apiJson, assertNotAborted, decodeImageBase64, downloadApiImage, imageMime, mediaMime,
  readTaskFile, record, requiredText, resolveApiConnection, resolveModel,
  type ApiBinaryResult, type ResolvedApiConnection,
} from "./ApiServiceConnection";
import type { NativeMediaProviderOptions } from "./NativeMediaProvider";

/**
 * Black Forest Labs (FLUX) official asynchronous task API.
 *
 * Facts verified against https://api.bfl.ai/openapi.json:
 * - `x-key` header authentication (the connection headers already carry it).
 * - `POST {baseUrl}/{model}` returns `{id, polling_url}`; `GET polling_url` returns
 *   `{id, status, result, progress}`, and `GET {baseUrl}/get_result?id=<id>` is the
 *   stable resumption route.
 * - `status` is one of Task not found / Pending / Reasoning / Generating /
 *   Request Moderated / Content Moderated / No Card Generated / Ready / Error.
 * - `result` is declared as `anyOf: {}` (untyped), so extraction stays defensive.
 */

const FLUX3_IMAGE_RATIOS = [
  "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21",
] as const;
const VIDEO_RATIOS = ["21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16", "9:21"] as const;
const VIDEO_RESOLUTIONS = ["hd", "fhd", "qhd", "uhd"] as const;
/** Separate allowlists: `result` is untyped upstream, so only these keys are ever read. */
const IMAGE_RESULT_KEYS = ["sample", "samples", "url", "image", "image_url", "images", "output", "outputs", "result", "data"] as const;
const VIDEO_RESULT_KEYS = ["video", "video_url", "videos", "sample", "samples", "url", "output", "outputs", "result", "media"] as const;

type ImageFamily = "flux3" | "flux2" | "pro11" | "ultra" | "kontext";
interface ImageRoute { family: ImageFamily; maxReferences: number; seed: boolean }

/** Route -> request-shape family, from the per-route schemas in the official OpenAPI document. */
const IMAGE_MODELS: Record<string, ImageRoute> = {
  "flux-3-image": { family: "flux3", maxReferences: 10, seed: false },
  "flux-3-image-klein": { family: "flux3", maxReferences: 10, seed: true },
  "flux-2-pro": { family: "flux2", maxReferences: 8, seed: true },
  "flux-2-max": { family: "flux2", maxReferences: 8, seed: true },
  "flux-2-flex": { family: "flux2", maxReferences: 8, seed: true },
  "flux-2-klein-9b": { family: "flux2", maxReferences: 4, seed: true },
  "flux-2-klein-4b": { family: "flux2", maxReferences: 4, seed: true },
  "flux-pro-1.1": { family: "pro11", maxReferences: 1, seed: true },
  "flux-dev": { family: "pro11", maxReferences: 1, seed: true },
  "flux-pro-1.1-ultra": { family: "ultra", maxReferences: 1, seed: true },
  "flux-kontext-pro": { family: "kontext", maxReferences: 4, seed: true },
  "flux-kontext-max": { family: "kontext", maxReferences: 4, seed: true },
};
const VIDEO_MODEL = "flux-3-video";

interface PollLimits { intervalMs: number; maxWaitMs: number; maxAttempts: number }
type TaskOutcome = "error" | "moderated" | "empty" | "missing";

function unsupportedKeys(input: object, keys: readonly string[]): void {
  for (const key of keys) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      throw new ApiProviderError("unsupported", `${key} is not supported by the Black Forest Labs adapter`);
    }
  }
}

function invalid(message: string): never { throw new ApiProviderError("input", message); }

function ratioParts(value: unknown, name: string): number {
  const text = requiredText(value, name, 40);
  const match = text.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  const width = match ? Number(match[1]) : NaN;
  const height = match ? Number(match[2]) : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    invalid(`${name} must use positive width:height values`);
  }
  return width / height;
}

function normalizedRatio(value: unknown, allowed: readonly string[], name: string): string {
  const text = requiredText(value, name, 40);
  const match = text.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) invalid(`${name} must use width:height values`);
  const canonical = `${match[1]}:${match[2]}`;
  if (!allowed.includes(canonical)) {
    throw new ApiProviderError("unsupported", `${name} ${canonical} is not supported here; use one of ${allowed.join(", ")}`);
  }
  return canonical;
}

function explicitSize(input: ImageGenerateInput): { width: number; height: number } | undefined {
  if (input.width === undefined && input.height === undefined) return undefined;
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || (input.width as number) < 64 || (input.height as number) < 64
    || (input.width as number) > 8192 || (input.height as number) > 8192) {
    invalid("width and height must be whole pixels between 64 and 8192, and are required together");
  }
  return { width: input.width as number, height: input.height as number };
}

function seedValue(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) invalid("seed must be an unsigned 32-bit integer");
  return seed;
}

async function referenceDataUrls(paths: string[], context: ToolExecutionContext, limit: number): Promise<string[]> {
  if (paths.length > limit) throw new ApiProviderError("input", `this model accepts at most ${limit} reference image(s)`);
  const references: string[] = [];
  for (const path of paths) {
    const bytes = await readTaskFile(path, context, 20 * 1024 * 1024, [".png", ".jpg", ".jpeg", ".webp"]);
    const mimeType = imageMime(bytes);
    if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new ApiProviderError("format", "reference image must contain PNG, JPEG or WebP bytes");
    }
    references.push(`data:${mimeType};base64,${bytes.toString("base64")}`);
  }
  return references;
}

function imageBody(route: ImageRoute, prompt: string, references: string[], input: ImageGenerateInput): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt };
  if (input.negativePrompt !== undefined) throw new ApiProviderError("unsupported", "negativePrompt is not supported by the FLUX API");
  if (input.seed !== undefined) {
    if (!route.seed) throw new ApiProviderError("unsupported", "seed is not supported by this FLUX model");
    body.seed = seedValue(input.seed);
  }
  const size = explicitSize(input);
  if (size && input.aspectRatio !== undefined) {
    if (Math.abs(size.width / size.height - ratioParts(input.aspectRatio, "aspect ratio")) > 0.01) {
      invalid("width and height conflict with the aspect ratio");
    }
  }
  switch (route.family) {
    case "flux3": {
      if (references.length) body.images = references;
      if (input.aspectRatio !== undefined) body.aspect_ratio = normalizedRatio(input.aspectRatio, FLUX3_IMAGE_RATIOS, "aspect ratio");
      if (size) {
        // flux-3-image: exact size is [256, 6256] on each edge.
        if (size.width > 6256 || size.height > 6256) invalid("width and height must not exceed 6256 pixels for this model");
        body.width = size.width; body.height = size.height;
      }
      break;
    }
    case "flux2": {
      // The FLUX.2 bodies have no aspect_ratio or images[] field; references are input_image_N.
      if (input.aspectRatio !== undefined) invalid("FLUX.2 models accept width and height, not an aspect ratio");
      references.forEach((reference, index) => { body[index === 0 ? "input_image" : `input_image_${index + 1}`] = reference; });
      if (size) { body.width = size.width; body.height = size.height; }
      break;
    }
    case "pro11": {
      if (input.aspectRatio !== undefined) invalid("this FLUX model accepts width and height, not an aspect ratio");
      if (size) {
        if (size.width % 32 !== 0 || size.height % 32 !== 0) invalid("width and height must be multiples of 32 for this model");
        if (size.width < 256 || size.height < 256 || size.width > 1440 || size.height > 1440) {
          invalid("width and height must be between 256 and 1440 pixels for this model");
        }
        body.width = size.width; body.height = size.height;
      }
      if (references[0]) body.image_prompt = references[0];
      break;
    }
    case "ultra": {
      if (size) invalid("flux-pro-1.1-ultra derives the size from the aspect ratio; remove width and height");
      if (input.aspectRatio !== undefined) {
        const ratio = ratioParts(input.aspectRatio, "aspect ratio");
        if (ratio > 21 / 9 || ratio < 9 / 21) invalid("aspect ratio must be between 21:9 and 9:21");
        body.aspect_ratio = requiredText(input.aspectRatio, "aspect ratio", 40);
      }
      if (references[0]) body.image_prompt = references[0];
      break;
    }
    case "kontext": {
      if (size) invalid("kontext models derive the size from the input image; remove width and height");
      if (references.length === 0) invalid("kontext models require at least one reference image (inputImagePaths)");
      if (input.aspectRatio !== undefined) body.aspect_ratio = requiredText(input.aspectRatio, "aspect ratio", 40);
      references.forEach((reference, index) => { body[index === 0 ? "input_image" : `input_image_${index + 1}`] = reference; });
      break;
    }
  }
  return body;
}

function pollLimits(options: NativeMediaProviderOptions, kind: "image" | "video"): PollLimits {
  const defaults = kind === "video"
    ? { intervalMs: 3_000, maxWaitMs: 8 * 60_000, maxAttempts: 200 }
    : { intervalMs: 1_500, maxWaitMs: 3 * 60_000, maxAttempts: 120 };
  const values = {
    intervalMs: options.polling?.intervalMs ?? defaults.intervalMs,
    maxWaitMs: options.polling?.maxWaitMs ?? defaults.maxWaitMs,
    maxAttempts: options.polling?.maxAttempts ?? defaults.maxAttempts,
  };
  if (!Number.isSafeInteger(values.intervalMs) || values.intervalMs < 1 || values.intervalMs > 60_000
    || !Number.isSafeInteger(values.maxWaitMs) || values.maxWaitMs < 1 || values.maxWaitMs > 30 * 60_000
    || !Number.isSafeInteger(values.maxAttempts) || values.maxAttempts < 1 || values.maxAttempts > 1_000) {
    throw new ApiProviderError("configuration", "invalid task polling budget");
  }
  return values;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new ApiProviderError("cancelled", "task wait cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

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
      if (size > maxBytes) { await reader.cancel(); throw new ApiProviderError("limit", "service response exceeds the size limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new ApiProviderError("response", "service returned an empty response");
  return Buffer.concat(chunks, size);
}

function httpCode(status: number): string {
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "rate-limit" : status === 413 ? "limit" : "http";
}

/** GET a JSON document from the polling URL or the `get_result` route, which a path-only client cannot express. */
async function getJson(connection: ResolvedApiConnection, url: string, options: NativeMediaProviderOptions,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
  assertNotAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const budget = Math.max(1, Math.min(timeoutMs, connection.timeoutMs));
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  const abort = (): void => { controller.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = new Headers(connection.headers);
    headers.delete("content-type");
    const response = await (options.fetch ?? fetch)(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiProviderError(httpCode(response.status), `service returned HTTP ${response.status}`, response.status);
    }
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new ApiProviderError("response", "service returned invalid JSON"); }
    if (timedOut) throw new ApiProviderError("timeout", "service request timed out");
    assertNotAborted(signal);
    return record(value);
  } catch (error) {
    assertNotAborted(signal);
    if (timedOut) throw new ApiProviderError("timeout", "service request timed out");
    if (error instanceof ApiProviderError) throw error;
    // Never echo provider bodies, signed URLs, headers, fetch errors, or abort reasons.
    throw new ApiProviderError("transport", "service request failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Only the documented BFL origin is polled so the `x-key` header never leaves the API host. */
function pollingUrl(connection: ResolvedApiConnection, raw: unknown, task: string): string {
  if (typeof raw === "string" && raw.length) {
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new ApiProviderError("response", "service returned an invalid polling URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== new URL(connection.baseUrl).origin
      || url.username || url.password || url.hash) {
      throw new ApiProviderError("response", "service returned an unsafe polling URL");
    }
    return url.toString();
  }
  return getResultUrl(connection, task);
}

function getResultUrl(connection: ResolvedApiConnection, task: string): string {
  return `${connection.baseUrl}/get_result?id=${encodeURIComponent(task)}`;
}

function taskId(value: unknown): string {
  const id = requiredText(value, "task id", 200);
  if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(id)) throw new ApiProviderError("response", "service returned an invalid task ID");
  return id;
}

interface Classified { state: "queued" | "in_progress" | "completed" | "failed"; outcome?: TaskOutcome }

function classifyStatus(value: unknown): Classified {
  switch (value) {
    case "Pending": return { state: "queued" };
    case "Reasoning": case "Generating": return { state: "in_progress" };
    case "Ready": return { state: "completed" };
    case "Error": return { state: "failed", outcome: "error" };
    case "Request Moderated": case "Content Moderated": return { state: "failed", outcome: "moderated" };
    case "No Card Generated": return { state: "failed", outcome: "empty" };
    case "Task not found": return { state: "failed", outcome: "missing" };
    default: throw new ApiProviderError("response", "service returned an unknown task status");
  }
}

async function awaitTask(args: {
  connection: ResolvedApiConnection; taskId: string; pollingUrl: string; limits: PollLimits;
  options: NativeMediaProviderOptions; signal?: AbortSignal; context: string;
  onProgress?: (state: "queued" | "in_progress", progress: number | undefined) => void;
  onTerminal?: (outcome: TaskOutcome) => ApiProviderError;
}): Promise<{ result: unknown; progress?: number }> {
  const { connection, limits, options, signal } = args;
  const deadline = Date.now() + limits.maxWaitMs;
  let attempts = 0;
  for (;;) {
    assertNotAborted(signal);
    if (attempts >= limits.maxAttempts || Date.now() >= deadline) {
      throw new ApiProviderError("pending", `${args.context} ${args.taskId} is still running; the remote task was not cancelled`);
    }
    const value = await getJson(connection, args.pollingUrl, options, signal, Math.max(1, deadline - Date.now()));
    attempts += 1;
    const classified = classifyStatus(value.status);
    if (classified.state === "failed") {
      const outcome = classified.outcome ?? "error";
      throw args.onTerminal?.(outcome)
        ?? new ApiProviderError(outcome === "moderated" ? "policy" : "response", `the service ended ${args.context} ${args.taskId} as ${String(value.status)}`);
    }
    if (classified.state === "completed") {
      const progress = value.progress;
      return { result: value.result, ...(typeof progress === "number" ? { progress } : {}) };
    }
    args.onProgress?.(classified.state, typeof value.progress === "number" ? value.progress : undefined);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ApiProviderError("pending", `${args.context} ${args.taskId} is still running; the remote task was not cancelled`);
    }
    await wait(Math.max(1, Math.min(limits.intervalMs, remaining)), signal);
  }
}

/** `result` is untyped upstream (`anyOf: {}`); read only known keys, bounded in depth and count. */
function mediaUrls(value: unknown, keys: readonly string[], depth = 0): string[] {
  if (depth > 2) return [];
  if (typeof value === "string") return value.length > 0 && value.length <= 16_000 ? [value] : [];
  if (Array.isArray(value)) return value.slice(0, 10).flatMap(entry => mediaUrls(entry, keys, depth + 1));
  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    const urls: string[] = [];
    for (const key of keys) {
      if (recordValue[key] !== undefined) urls.push(...mediaUrls(recordValue[key], keys, depth + 1));
    }
    return urls;
  }
  return [];
}

function imageUrls(result: unknown): string[] {
  const urls = mediaUrls(result, IMAGE_RESULT_KEYS).filter(url => /^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^[A-Za-z0-9+/]+={0,2}$/.test(url));
  if (!urls.length) throw new ApiProviderError("response", "service returned no image for a ready task");
  return urls;
}

async function imageBytes(raw: string, connection: ResolvedApiConnection, options: NativeMediaProviderOptions, context: ToolExecutionContext): Promise<ApiBinaryResult> {
  const dataUrl = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (dataUrl) return decodeImageBase64(dataUrl[2], dataUrl[1]);
  if (/^https?:\/\//i.test(raw)) {
    return downloadApiImage(raw, connection, { signal: context.signal, timeoutMs: connection.timeoutMs }, options);
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return decodeImageBase64(raw);
  throw new ApiProviderError("response", "service returned an invalid image reference");
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blockedV6.addSubnet(address, prefix, "ipv6");

/**
 * Video artifacts are delivered on a signed CDN URL, so the connection credentials are
 * only attached when the URL stays on the API origin. Hostname resolution is left to
 * fetch; literal private addresses are rejected here.
 */
async function downloadVideo(connection: ResolvedApiConnection, rawUrl: string, options: NativeMediaProviderOptions,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<ApiBinaryResult> {
  assertNotAborted(signal);
  const base = new URL(connection.baseUrl);
  let url: URL;
  try { url = new URL(requiredText(rawUrl, "media URL", 16_000), `${connection.baseUrl}/`); }
  catch { throw new ApiProviderError("response", "service returned an invalid video URL"); }
  const sameOrigin = url.origin === base.origin;
  if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol) || (!sameOrigin && url.protocol !== "https:")) {
    throw new ApiProviderError("policy", "video download URL is not allowed");
  }
  if (!sameOrigin) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (/^(localhost|.*\.localhost)$/.test(hostname) || hostname.endsWith(".local")) throw new ApiProviderError("policy", "video download URL must be public");
    const family = isIP(hostname);
    if (family === 6 && blockedV6.check(hostname, "ipv6")) throw new ApiProviderError("policy", "video download URL must be public");
    if (family === 4 && blockedV4.check(hostname, "ipv4")) throw new ApiProviderError("policy", "video download URL must be public");
  }
  const controller = new AbortController();
  let timedOut = false;
  const budget = Math.max(1, Math.min(timeoutMs, connection.timeoutMs));
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  const abort = (): void => { controller.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = new Headers(sameOrigin ? connection.headers : undefined);
    headers.delete("content-type");
    const response = await (options.fetch ?? fetch)(url.toString(), { method: "GET", headers, redirect: "error", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiProviderError(httpCode(response.status), `service returned HTTP ${response.status}`, response.status);
    }
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type && type !== "application/octet-stream" && !type.startsWith("video/")) {
      await response.body?.cancel();
      throw new ApiProviderError("response", "service did not return video bytes");
    }
    const bytes = await readBounded(response, MAX_VIDEO_BYTES);
    const mimeType = mediaMime(bytes, "video");
    if (!mimeType) throw new ApiProviderError("response", "service returned invalid video bytes");
    if (type && type !== "application/octet-stream" && type !== mimeType) {
      throw new ApiProviderError("response", "video bytes do not match their declared type");
    }
    if (timedOut) throw new ApiProviderError("timeout", "video download timed out");
    return { bytes, mimeType };
  } catch (error) {
    assertNotAborted(signal);
    if (timedOut) throw new ApiProviderError("timeout", "video download timed out");
    if (error instanceof ApiProviderError) throw error;
    throw new ApiProviderError("transport", "video download failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function generateImage(options: NativeMediaProviderOptions, id: string, input: ImageGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  const connection = await resolveApiConnection(options);
  if (connection.protocol !== "black-forest-labs") throw new ApiProviderError("configuration", "this adapter only serves Black Forest Labs connections");
  const model = resolveModel(connection, input.model);
  const route = IMAGE_MODELS[model];
  if (!route) throw new ApiProviderError("unsupported", `FLUX route ${model} is not implemented; use one of ${Object.keys(IMAGE_MODELS).join(", ")}`);
  const prompt = requiredText(input.prompt, "image prompt", 10_000);
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) invalid("image count must be between 1 and 4");
  const paths = input.inputImagePaths ?? [];
  if (!Array.isArray(paths)) invalid("inputImagePaths must be a list");
  const references = await referenceDataUrls(paths, context, route.maxReferences);
  const body = imageBody(route, prompt, references, input);
  // The FLUX API has no `n`; each requested image is its own task, submitted one at a time.
  const limits = pollLimits(options, "image");
  const items: GeneratedMediaItem[] = [];
  const requestIds: string[] = [];
  const progress: Array<number | undefined> = [];
  for (let index = 0; index < count; index += 1) {
    assertNotAborted(context.signal);
    const submitted = record(await apiJson(connection, `/${model}`, { body: JSON.stringify(body), signal: context.signal, maxBytes: MAX_JSON_BYTES }, options));
    const remoteId = taskId(submitted.id);
    requestIds.push(remoteId);
    const ready = await awaitTask({
      connection, taskId: remoteId, pollingUrl: pollingUrl(connection, submitted.polling_url, remoteId),
      limits, options, signal: context.signal, context: "image task",
    });
    progress.push(ready.progress);
    const [first] = imageUrls(ready.result);
    const downloaded = await imageBytes(first!, connection, options, context);
    items.push({ bytes: downloaded.bytes, mimeType: downloaded.mimeType, fileName: `image-${index + 1}` });
  }
  return {
    provider: id, model, requestId: requestIds[0],
    items,
    metadata: {
      requestedCount: count, returnedCount: items.length, taskIds: requestIds,
      ...(progress.some(value => value !== undefined) ? { progress } : {}),
      ...(items.length < count ? { partial: true } : {}),
    },
  };
}

function sameConnection(job: VideoGenerationJob, connection: ResolvedApiConnection): void {
  if (job.connection.id !== connection.id || job.connection.baseUrl !== connection.baseUrl || job.connection.protocol !== connection.protocol) {
    throw new ApiProviderError("configuration", "resume requires the original service ID, URL and protocol; no replacement service was called");
  }
}

function updateJob(store: VideoGenerationJobStore, job: VideoGenerationJob, patch: Partial<VideoGenerationJob>): VideoGenerationJob {
  const current = store.get(job.id) ?? job;
  const next = { ...current, ...patch, updatedAt: Math.max(Date.now(), current.createdAt) };
  if (["completed", "failed"].includes(current.state)) next.state = current.state;
  store.put(next);
  return next;
}

async function continueVideo(options: NativeMediaProviderOptions, job: VideoGenerationJob, connection: ResolvedApiConnection, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  const store = options.jobStore!;
  if (job.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
  if (!job.remoteId || ["submitting", "submission-unknown"].includes(job.state)) throw new VideoJobPendingError(job.id, "submission-unknown");
  const remoteId = job.remoteId;
  const limits = pollLimits(options, "video");
  // Resume always re-polls the saved remote ID; a POST submission is never repeated.
  const pollUrl = getResultUrl(connection, remoteId);
  job = updateJob(store, job, { waitState: "waiting", lastToolCallId: context.toolCallId, lastError: undefined });
  let finished: VideoGenerationJob = job;
  try {
    const ready = await awaitTask({
      connection, taskId: remoteId, pollingUrl: pollUrl, limits, options, signal: context.signal, context: "video task",
      onProgress: (state) => { finished = updateJob(store, finished, { state }); },
      onTerminal: (outcome) => {
        finished = updateJob(store, finished, { state: "failed", waitState: "finished", lastError: outcome });
        return new ApiProviderError("video-failed", `remote video generation failed (${outcome}); jobId=${finished.id}`);
      },
    });
    assertNotAborted(context.signal);
    const [raw] = mediaUrls(ready.result, VIDEO_RESULT_KEYS);
    if (!raw || !/^https?:\/\//i.test(raw)) throw new ApiProviderError("response", "service returned no video for a ready task");
    const downloaded = await downloadVideo(connection, raw, options, context.signal, connection.timeoutMs);
    finished = updateJob(store, finished, { state: "completed", waitState: "finished", lastError: undefined });
    return {
      provider: finished.connection.id, model: finished.connection.model, requestId: remoteId,
      items: [{ bytes: downloaded.bytes, mimeType: downloaded.mimeType, fileName: "video" }],
      metadata: {
        jobId: finished.id, remoteJobId: remoteId, serviceId: finished.connection.id,
        submissionToolCallId: finished.toolCallId,
        ...(ready.progress !== undefined ? { progress: ready.progress } : {}),
      },
    };
  } catch (error) {
    const reason = error instanceof ApiProviderError ? error.code : "transport";
    if (finished.state !== "failed") finished = updateJob(store, finished, { waitState: "paused", lastError: reason });
    if (finished.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${finished.id}`);
    throw new VideoJobPendingError(finished.id, reason, finished.remoteId);
  }
}

interface VideoRequest { body: Record<string, unknown>; digest: string }

async function videoRequest(input: VideoGenerateInput, model: string, context: ToolExecutionContext): Promise<VideoRequest> {
  unsupportedKeys(input, ["negativePrompt", "seed"]);
  const prompt = requiredText(input.prompt, "video prompt", 10_000);
  const body: Record<string, unknown> = { prompt, mode: "t2v" };
  if (input.aspectRatio !== undefined) body.aspect_ratio = normalizedRatio(input.aspectRatio, VIDEO_RATIOS, "video aspect ratio");
  if (input.durationSeconds !== undefined) {
    if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 5 || input.durationSeconds > 20) {
      invalid("video duration must be a whole number from 5 to 20 seconds");
    }
    body.duration = input.durationSeconds;
  }
  if (input.resolution !== undefined) {
    const resolution = requiredText(input.resolution, "video resolution", 20);
    if (!VIDEO_RESOLUTIONS.includes(resolution as (typeof VIDEO_RESOLUTIONS)[number])) {
      throw new ApiProviderError("unsupported", "video resolution must be hd, fhd, qhd or uhd");
    }
    body.resolution = resolution;
  }
  if (input.generateAudio !== undefined) {
    if (typeof input.generateAudio !== "boolean") invalid("generateAudio must be a boolean");
    body.generate_audio = input.generateAudio;
  }
  let keyframe: string | undefined;
  if (input.inputImagePath !== undefined) {
    const [reference] = await referenceDataUrls([input.inputImagePath], context, 1);
    keyframe = reference!;
    body.mode = "i2v";
    body.keyframes = keyframe;
  }
  const digest = createHash("sha256").update(JSON.stringify({
    model, body: { ...body, keyframes: undefined },
    keyframes: keyframe === undefined ? undefined : createHash("sha256").update(keyframe).digest("hex"),
  })).digest("hex");
  return { body, digest };
}

async function generateVideo(options: NativeMediaProviderOptions, id: string, input: VideoGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  const store = options.jobStore!;
  let job: VideoGenerationJob;
  let connection: ResolvedApiConnection;
  if (input.jobId !== undefined) {
    // A resume replays the saved request; current defaults or a replacement prompt are ignored.
    unsupportedKeys(input, ["prompt", "model", "negativePrompt", "aspectRatio", "durationSeconds", "resolution", "seed", "inputImagePath", "generateAudio"]);
    assertVideoJobId(input.jobId);
    const saved = store.get(input.jobId);
    if (!saved || saved.taskId !== context.taskId) throw new ApiProviderError("policy", "video job does not belong to this task");
    job = saved;
    connection = await resolveApiConnection(options, job.connection.id);
    sameConnection(job, connection);
    return continueVideo(options, job, connection, context);
  }
  const connectionSelected = await resolveApiConnection(options);
  if (connectionSelected.protocol !== "black-forest-labs") throw new ApiProviderError("configuration", "this adapter only serves Black Forest Labs connections");
  const model = resolveModel(connectionSelected, input.model);
  if (model !== VIDEO_MODEL) {
    throw new ApiProviderError("unsupported", `${model} is not a text/image-to-video route; the FLUX video adapter submits ${VIDEO_MODEL}`);
  }
  const request = await videoRequest(input, model, context);
  const previous = store.findByInvocation(context.taskId, context.toolCallId);
  if (previous) {
    if (previous.requestDigest !== request.digest) throw new ApiProviderError("conflict", "this tool invocation already submitted a different video request");
    sameConnection(previous, connectionSelected);
    return continueVideo(options, previous, connectionSelected, context);
  }
  const now = Date.now();
  // Write intent before a billable POST. An interrupted submission is never replayed automatically.
  job = {
    id: newVideoJobId(), taskId: context.taskId, toolCallId: context.toolCallId, lastToolCallId: context.toolCallId,
    producerMessageId: context.producerMessageId, connection: videoConnectionSnapshot(connectionSelected, model), requestDigest: request.digest,
    state: "submitting", waitState: "waiting", createdAt: now, updatedAt: now,
  };
  store.put(job);
  try {
    const submitted = record(await apiJson(connectionSelected, `/${model}`, {
      body: JSON.stringify(request.body), signal: context.signal, maxBytes: MAX_JSON_BYTES, preserveCompletedResponse: true,
    }, options));
    job = updateJob(store, job, { remoteId: taskId(submitted.id), state: "queued", waitState: "waiting", lastError: undefined });
  } catch (error) {
    const knownRejected = error instanceof ApiProviderError && error.status !== undefined && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status);
    job = updateJob(store, job, { state: knownRejected ? "failed" : "submission-unknown", waitState: knownRejected ? "finished" : "paused", lastError: error instanceof ApiProviderError ? error.code : "transport" });
    if (knownRejected) throw new ApiProviderError((error as ApiProviderError).code, `video request was rejected; jobId=${job.id}`, (error as ApiProviderError).status);
    throw new VideoJobPendingError(job.id, "submission-unknown");
  }
  return continueVideo(options, job, connectionSelected, context);
}

export function createBlackForestLabsProvider(options: NativeMediaProviderOptions): MediaCapabilityProvider {
  if (options.jobStore) pollLimits(options, "video");
  return {
    id: options.id, label: options.label,
    async test() {
      const connection = await resolveApiConnection(options);
      if (connection.protocol !== "black-forest-labs") throw new ApiProviderError("configuration", "this adapter only serves Black Forest Labs connections");
      resolveModel(connection);
      const families = `${Object.keys(IMAGE_MODELS).length} 个图片路由 + ${VIDEO_MODEL}`;
      return `已配置 FLUX 连接（${connection.label}，${families}）；未发送生成请求，实际额度、模型权限与审核结果以服务端为准。`;
    },
    generateImage: (input, context) => generateImage(options, options.id, input, context),
    ...(options.jobStore ? { generateVideo: (input: VideoGenerateInput, context: ToolExecutionContext) => generateVideo(options, options.id, input, context) } : {}),
  };
}
