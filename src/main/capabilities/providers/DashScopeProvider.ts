import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { GeneratedMediaOutput, ImageGenerateInput, MediaCapabilityProvider, ToolExecutionContext, VideoGenerateInput } from "../BuiltinCapabilityRuntime";
import {
  VideoJobPendingError, assertVideoJobId, newVideoJobId, videoConnectionSnapshot,
  type VideoGenerationJob, type VideoGenerationJobStore,
} from "../VideoGenerationJobs";
import {
  ApiProviderError, apiJson, assertNotAborted, downloadApiImage, imageMime, mediaMime,
  readTaskFile, record, requiredText, resolveApiConnection, resolveModel,
  type ApiBinaryResult, type ResolvedApiConnection,
} from "./ApiServiceConnection";
import type { NativeMediaProviderOptions } from "./NativeMediaProvider";

/**
 * 阿里云百炼（DashScope）原生异步任务适配器：千问 / 万相。
 *
 * 事实已按 help.aliyun.com/model-studio 官方文档核实（公开域名仍可用）：
 * - 认证：`Authorization: Bearer <API Key>`，由上层连接注入，这里不再拼装。
 * - 公共域名 `https://dashscope.aliyuncs.com/api/v1` 仍受支持；官方建议迁移到
 *   `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`，但该工作空间域名
 *   不是必需项，因此本适配器只依赖连接的 baseUrl。
 * - 异步创建必须带 `X-DashScope-Async: enable`，缺省会报
 *   "current user api does not support synchronous calls"。
 * - 图片有三套真实请求形状：
 *   1) wan2.5 及以下：POST /services/aigc/text2image/image-synthesis，
 *      body {model,input:{prompt,negative_prompt?},parameters:{size,n,prompt_extend,watermark,seed}}
 *   2) wan2.6：异步 POST /services/aigc/image-generation/generation（input.messages）
 *   3) qwen-image-2.0 系列：同步 POST /services/aigc/multimodal-generation/generation
 *      （input.messages，content 里可放 1-3 张 {image:"data:...;base64,..."} 参考图）
 * - 视频：POST /services/aigc/video-generation/video-synthesis（该接口只服务 wan2.7），
 *   parameters: resolution 720P|1080P、ratio 16:9|9:16|1:1|4:3|3:4、duration 2..15、
 *   prompt_extend、watermark、seed；wan2.7 不再接受 size 与 shot_type。
 * - 查询：GET /tasks/{task_id}，output.task_status ∈
 *   PENDING | RUNNING | SUCCEEDED | FAILED | CANCELED | UNKNOWN。
 *   task_id 与结果链接都只有 24 小时有效期。
 * - 结果：图片 output.results[*].url；视频 output.video_url（MP4/H.264）；
 *   qwen-image 同步接口返回 output.choices[0].message.content[*].image。
 */

const TEXT2IMAGE_ROUTE = "/services/aigc/text2image/image-synthesis";
const IMAGE_GENERATION_ROUTE = "/services/aigc/image-generation/generation";
const MULTIMODAL_ROUTE = "/services/aigc/multimodal-generation/generation";
const VIDEO_ROUTE = "/services/aigc/video-generation/video-synthesis";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_REFERENCE_LIMIT = 3;
const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;

/** 文档给出的推荐分辨率，按模型代际区分；只映射精确比例，绝不就近取整。 */
const QWEN_IMAGE_SIZES: Record<string, string> = {
  "1:1": "2048*2048", "4:3": "2368*1728", "3:4": "1728*2368", "16:9": "2688*1536", "9:16": "1536*2688",
};
/** wan2.5 与 wan2.6 的推荐分辨率相同，只是路由不同。 */
const WAN_MODERN_IMAGE_SIZES: Record<string, string> = {
  "1:1": "1280*1280", "4:3": "1472*1104", "3:4": "1104*1472", "16:9": "1696*960", "9:16": "960*1696",
};
const WAN_LEGACY_IMAGE_SIZES: Record<string, string> = {
  "1:1": "1024*1024", "4:3": "1152*864", "3:4": "864*1152", "16:9": "1280*720", "9:16": "720*1280",
};

type ImageRouteFamily = "qwen" | "wan26" | "wan25" | "wan-legacy";

function imageFamily(model: string): ImageRouteFamily {
  if (/^qwen-image/i.test(model)) return "qwen";
  if (/^wan2\.6/i.test(model)) return "wan26";
  if (/^wan2\.5/i.test(model)) return "wan25";
  return "wan-legacy";
}

function imageSizes(family: ImageRouteFamily): Record<string, string> {
  if (family === "qwen") return QWEN_IMAGE_SIZES;
  if (family === "wan26" || family === "wan25") return WAN_MODERN_IMAGE_SIZES;
  return WAN_LEGACY_IMAGE_SIZES;
}

function unsupportedKeys(input: object, keys: readonly string[]): void {
  for (const key of keys) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      throw new ApiProviderError("unsupported", `${key} is not supported by the 阿里云百炼 adapter`);
    }
  }
}

interface PollLimits { intervalMs: number; maxWaitMs: number; maxAttempts: number }

function pollLimits(options: NativeMediaProviderOptions, kind: "image" | "video"): PollLimits {
  // 官方建议图片约 10s、视频约 15s 一次；这里取更短间隔只为不空等，预算仍按任务类型区分。
  const defaults = kind === "video"
    ? { intervalMs: 5_000, maxWaitMs: 8 * 60_000, maxAttempts: 200 }
    : { intervalMs: 2_000, maxWaitMs: 3 * 60_000, maxAttempts: 120 };
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

function httpCode(status: number): string {
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "rate-limit" : status === 413 ? "limit" : "http";
}

/** 只对异步提交注入 `X-DashScope-Async: enable`；同步接口（qwen-image）不能带。 */
function asyncHeaders(connection: ResolvedApiConnection): Record<string, string> {
  const headers = new Headers(connection.headers);
  headers.set("X-DashScope-Async", "enable");
  return Object.fromEntries(headers.entries());
}

/** 服务端业务错误码是诊断信息，不是凭据；只接受有界的安全字符集。 */
function serviceCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

function serviceFailure(response: Record<string, unknown>): ApiProviderError {
  const code = serviceCode(response.code);
  return new ApiProviderError("response", code ? `service rejected the request (${code})` : "service returned an unexpected response");
}

function taskOutput(response: Record<string, unknown>): Record<string, unknown> {
  if (response.output === undefined) throw serviceFailure(response);
  return record(response.output);
}

function remoteTaskId(value: unknown): string {
  const id = requiredText(value, "task id", 200);
  if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(id)) throw new ApiProviderError("response", "service returned an invalid task ID");
  return id;
}

function taskRoute(taskId: string): string {
  return `/tasks/${remoteTaskId(taskId)}`;
}

type TaskState = "queued" | "in_progress" | "completed" | "failed" | "expired";

function taskState(value: unknown): TaskState {
  switch (String(value)) {
    case "PENDING": return "queued";
    case "RUNNING": return "in_progress";
    case "SUCCEEDED": return "completed";
    case "FAILED": case "CANCELED": return "failed";
    case "UNKNOWN": return "expired";
    default: throw new ApiProviderError("response", "service returned an unknown task status");
  }
}

function taskFailure(state: Exclude<TaskState, "queued" | "in_progress" | "completed">, output: Record<string, unknown>, kind: "image" | "video"): ApiProviderError {
  const code = serviceCode(output.code);
  const detail = state === "expired" ? "the task ID is unknown or has expired (24h retention)" : "the service reported the task as failed";
  const message = `${detail}${code ? ` (${code})` : ""}`;
  return kind === "video" ? new ApiProviderError("video-failed", message) : new ApiProviderError("response", message);
}

/**
 * 轮询一个已经提交的远端任务。超时/次数预算耗尽抛 `pending`（远端未取消）；
 * 任务终态失败抛 `response`（图片）或 `video-failed`（视频）。
 */
async function awaitTask(args: {
  connection: ResolvedApiConnection; taskId: string; limits: PollLimits; options: NativeMediaProviderOptions;
  signal?: AbortSignal; kind: "image" | "video"; onProgress?: (state: "queued" | "in_progress") => void;
}): Promise<{ output: Record<string, unknown>; polls: number }> {
  const { connection, taskId, limits, options, signal, kind } = args;
  const deadline = Date.now() + limits.maxWaitMs;
  for (let attempt = 1; ; attempt += 1) {
    assertNotAborted(signal);
    if (attempt > limits.maxAttempts || Date.now() >= deadline) {
      throw new ApiProviderError("pending", `task ${taskId} is still running; stopped waiting locally, the remote task was not cancelled`);
    }
    const remaining = deadline - Date.now();
    const response = await apiJson(connection, taskRoute(taskId), {
      method: "GET", signal, timeoutMs: Math.max(1, remaining), maxBytes: MAX_JSON_BYTES,
    }, options);
    const output = taskOutput(response);
    const state = taskState(output.task_status);
    if (state === "completed") return { output, polls: attempt };
    if (state === "failed" || state === "expired") throw taskFailure(state, output, kind);
    args.onProgress?.(state);
    const waitMs = Math.min(limits.intervalMs, deadline - Date.now());
    if (waitMs <= 0) {
      throw new ApiProviderError("pending", `task ${taskId} is still running; stopped waiting locally, the remote task was not cancelled`);
    }
    await wait(waitMs, signal);
  }
}

/* ------------------------------------------------------------------ 图片 */

function ratioParts(value: unknown, name: string): { text: string; ratio: number } {
  const text = requiredText(value, name, 40);
  const match = text.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  const width = match ? Number(match[1]) : NaN;
  const height = match ? Number(match[2]) : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ApiProviderError("input", `${name} must use positive width:height values`);
  }
  return { text: `${match![1]}:${match![2]}`, ratio: width / height };
}

/** 百炼图片分辨率使用 `宽*高`（星号），与 OpenAI 的 `宽x高` 不同。 */
function imageSize(family: ImageRouteFamily, input: ImageGenerateInput): string | undefined {
  const aspect = input.aspectRatio === undefined ? undefined : ratioParts(input.aspectRatio, "aspect ratio");
  const wanted = aspect?.ratio;
  if (input.width !== undefined || input.height !== undefined) {
    const { width, height } = input;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 256 || (height as number) < 256
      || (width as number) > 4096 || (height as number) > 4096) {
      throw new ApiProviderError("input", "dimensions must be whole pixels between 256 and 4096");
    }
    if (wanted !== undefined && Math.abs((width as number) / (height as number) - wanted) > 0.000001) {
      throw new ApiProviderError("input", "dimensions conflict with the aspect ratio");
    }
    return `${width}*${height}`;
  }
  if (!aspect) return undefined;
  const sizes = imageSizes(family);
  const size = Object.entries(sizes).find(([key]) => {
    const [left, right] = key.split(":").map(Number);
    return Math.abs(left / right - aspect.ratio) < 0.000001;
  });
  if (!size) throw new ApiProviderError("unsupported", "this adapter maps 1:1, 16:9, 9:16, 4:3 and 3:4 only; pass explicit width and height for other ratios");
  return size[1];
}

async function referenceDataUrl(path: string, context: ToolExecutionContext): Promise<string> {
  const bytes = await readTaskFile(path, context, MAX_REFERENCE_IMAGE_BYTES, [".png", ".jpg", ".jpeg", ".webp"]);
  const mimeType = imageMime(bytes);
  if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new ApiProviderError("format", "reference image must contain PNG, JPEG or WebP bytes");
  }
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

interface ImagePlan { route: string; body: Record<string, unknown>; synchronous: boolean }

function imagePlan(family: ImageRouteFamily, model: string, input: ImageGenerateInput, prompt: string, size: string | undefined, references: string[]): ImagePlan {
  const count = input.count ?? 1;
  const limit = family === "qwen" ? 6 : 4;
  if (!Number.isSafeInteger(count) || count < 1 || count > limit) throw new ApiProviderError("input", `image count must be between 1 and ${limit}`);
  const negative = input.negativePrompt === undefined ? undefined : requiredText(input.negativePrompt, "negative prompt", 2_000);
  const seed = input.seed;
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647)) {
    throw new ApiProviderError("input", "seed must be a whole number between 0 and 2147483647");
  }
  const parameters: Record<string, unknown> = {
    n: count,
    ...(size ? { size } : {}),
    ...(negative ? { negative_prompt: negative } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
  if (family === "qwen") {
    // 千问图像支持 1-3 张参考图，content 里先图后文；文本必须只有一段。
    const content: Array<Record<string, string>> = [
      ...references.map(image => ({ image })),
      { text: prompt },
    ];
    return {
      route: MULTIMODAL_ROUTE,
      body: { model, input: { messages: [{ role: "user", content }] }, parameters },
      synchronous: true,
    };
  }
  if (family === "wan26") {
    // wan2.6 使用新版协议：input.messages，异步走 image-generation/generation。
    return {
      route: IMAGE_GENERATION_ROUTE,
      body: { model, input: { messages: [{ role: "user", content: [{ text: prompt }] }] }, parameters },
      synchronous: false,
    };
  }
  // wan2.5 及以下：旧版异步协议，input.prompt + input.negative_prompt。
  return {
    route: TEXT2IMAGE_ROUTE,
    body: {
      model,
      input: { prompt, ...(negative ? { negative_prompt: negative } : {}) },
      parameters: { n: count, ...(size ? { size } : {}), ...(seed !== undefined ? { seed } : {}) },
    },
    synchronous: false,
  };
}

/** 图片结果：异步任务 output.results[*].url；qwen 同步 output.choices[].message.content[].image。 */
function imageUrls(output: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (Array.isArray(output.results)) {
    for (const entry of output.results) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const url = (entry as Record<string, unknown>).url;
      if (typeof url === "string" && url.length) urls.push(url);
    }
  }
  if (Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const image = (part as Record<string, unknown>).image;
        if (typeof image === "string" && image.length) urls.push(image);
      }
    }
  }
  return urls;
}

async function generateImage(options: NativeMediaProviderOptions, id: string, input: ImageGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  const connection = await resolveApiConnection(options);
  if (connection.protocol !== "dashscope") throw new ApiProviderError("configuration", "this adapter only serves 阿里云百炼 connections");
  const model = resolveModel(connection, input.model);
  const family = imageFamily(model);
  const prompt = requiredText(input.prompt, "image prompt", 10_000);
  const paths = input.inputImagePaths ?? [];
  if (!Array.isArray(paths)) throw new ApiProviderError("input", "inputImagePaths must be a list");
  if (paths.length && family !== "qwen") {
    throw new ApiProviderError("unsupported", "reference images are only supported by qwen-image models; 万相需要改用独立的图像编辑模型");
  }
  if (paths.length > IMAGE_REFERENCE_LIMIT) {
    throw new ApiProviderError("input", `qwen-image accepts up to ${IMAGE_REFERENCE_LIMIT} reference images`);
  }
  const references: string[] = [];
  for (const path of paths) references.push(await referenceDataUrl(path, context));
  const size = imageSize(family, input);
  const plan = imagePlan(family, model, input, prompt, size, references);
  const count = input.count ?? 1;

  let taskId: string | undefined;
  let output: Record<string, unknown>;
  if (plan.synchronous) {
    output = taskOutput(await apiJson(connection, plan.route, {
      body: JSON.stringify(plan.body), signal: context.signal, maxBytes: MAX_JSON_BYTES,
    }, options));
  } else {
    const created = taskOutput(await apiJson({ ...connection, headers: asyncHeaders(connection) }, plan.route, {
      body: JSON.stringify(plan.body), signal: context.signal, maxBytes: MAX_JSON_BYTES, preserveCompletedResponse: true,
    }, options));
    taskId = remoteTaskId(created.task_id);
    const limits = pollLimits(options, "image");
    const ready = await awaitTask({ connection, taskId, limits, options, signal: context.signal, kind: "image" });
    output = ready.output;
  }

  const urls = imageUrls(output);
  if (!urls.length) throw new ApiProviderError("response", "service returned no image for a finished task");
  const items: GeneratedMediaOutput["items"] = [];
  for (const [index, url] of urls.slice(0, count).entries()) {
    const downloaded = await downloadApiImage(url, connection, { signal: context.signal, timeoutMs: connection.timeoutMs }, options);
    items.push({ bytes: downloaded.bytes, mimeType: downloaded.mimeType, fileName: `image-${index + 1}` });
  }
  return {
    provider: id, model,
    ...(taskId ? { requestId: taskId } : {}),
    items,
    metadata: {
      requestedCount: count, returnedCount: items.length,
      ...(taskId ? { taskId } : {}),
      ...(paths.length ? { referenceCount: paths.length } : {}),
      ...(items.length < count ? { partial: true } : {}),
    },
  };
}

/* ------------------------------------------------------------------ 视频 */

function videoResolution(value: unknown): (typeof VIDEO_RESOLUTIONS)[number] {
  const text = requiredText(value, "video resolution", 20).toUpperCase();
  if (!(VIDEO_RESOLUTIONS as readonly string[]).includes(text)) {
    throw new ApiProviderError("unsupported", "video resolution must be 720p or 1080p; wan2.7 uses a resolution tier plus aspect ratio instead of a pixel size");
  }
  return text as (typeof VIDEO_RESOLUTIONS)[number];
}

function videoRatio(value: unknown): (typeof VIDEO_RATIOS)[number] {
  const { text } = ratioParts(value, "video aspect ratio");
  if (!(VIDEO_RATIOS as readonly string[]).includes(text)) {
    throw new ApiProviderError("unsupported", "video aspect ratio must be 16:9, 9:16, 1:1, 4:3 or 3:4");
  }
  return text as (typeof VIDEO_RATIOS)[number];
}

function sameConnection(job: VideoGenerationJob, connection: ResolvedApiConnection): void {
  if (job.connection.id !== connection.id || job.connection.baseUrl !== connection.baseUrl || job.connection.protocol !== connection.protocol) {
    throw new ApiProviderError("configuration", "resume requires the original service ID, URL and protocol; no replacement service was called");
  }
}

function updateJob(store: VideoGenerationJobStore, job: VideoGenerationJob, patch: Partial<VideoGenerationJob>): VideoGenerationJob {
  const current = store.get(job.id) ?? job;
  const next = { ...current, ...patch, updatedAt: Math.max(Date.now(), current.updatedAt) };
  if (["completed", "failed"].includes(current.state)) next.state = current.state;
  store.put(next);
  return next;
}

function videoUrl(output: Record<string, unknown>): string {
  const candidates: unknown[] = [output.video_url];
  if (Array.isArray(output.results)) {
    for (const entry of output.results) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        candidates.push((entry as Record<string, unknown>).video_url, (entry as Record<string, unknown>).url);
      }
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  }
  throw new ApiProviderError("response", "service returned no video for a successful task");
}

/** 视频成品在签名 CDN 上：只接受公共 https 地址，凭据绝不出现在下载请求里。 */
// 与 ApiServiceConnection 一致：BlockList 会把 IPv4 当作映射的 IPv6 比较，因此分开建表。
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blockedV6.addSubnet(address, prefix, "ipv6");

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
    if (/^(localhost|.*\.localhost)$/.test(hostname) || hostname.endsWith(".local")) {
      throw new ApiProviderError("policy", "video download URL must be public");
    }
    // 字面量内网地址直接拒绝；域名解析交给 fetch（与既有媒体下载保持同一取舍）。
    const family = isIP(hostname);
    if ((family === 4 && blockedV4.check(hostname, "ipv4")) || (family === 6 && blockedV6.check(hostname, "ipv6"))) {
      throw new ApiProviderError("policy", "video download URL must be public");
    }
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
    const declared = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (declared && declared !== "application/octet-stream" && !declared.startsWith("video/")) {
      await response.body?.cancel();
      throw new ApiProviderError("response", "service did not return video bytes");
    }
    const bytes = await readBounded(response, MAX_VIDEO_BYTES);
    const mimeType = mediaMime(bytes, "video");
    if (!mimeType) throw new ApiProviderError("response", "service returned invalid video bytes");
    if (declared && declared !== "application/octet-stream" && declared !== mimeType) {
      throw new ApiProviderError("response", "video bytes do not match their declared type");
    }
    if (timedOut) throw new ApiProviderError("timeout", "video download timed out");
    return { bytes, mimeType };
  } catch (error) {
    assertNotAborted(signal);
    if (timedOut) throw new ApiProviderError("timeout", "video download timed out");
    if (error instanceof ApiProviderError) throw error;
    // 不回显签名 URL、响应体、响应头或 fetch 错误。
    throw new ApiProviderError("transport", "video download failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

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

async function continueVideo(options: NativeMediaProviderOptions, job: VideoGenerationJob, connection: ResolvedApiConnection,
  context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  const store = options.jobStore!;
  if (job.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
  if (!job.remoteId || job.state === "submitting" || job.state === "submission-unknown") {
    throw new VideoJobPendingError(job.id, "submission-unknown");
  }
  const limits = pollLimits(options, "video");
  const remoteId = job.remoteId;
  // 恢复只重放已保存的 task_id；计费提交绝不重放。
  job = updateJob(store, job, { waitState: "waiting", lastToolCallId: context.toolCallId, lastError: undefined });
  try {
    const ready = await awaitTask({
      connection, taskId: remoteId, limits, options, signal: context.signal, kind: "video",
      onProgress: (state) => { job = updateJob(store, job, { state }); },
    });
    assertNotAborted(context.signal);
    const raw = videoUrl(ready.output);
    const downloaded = await downloadVideo(connection, raw, options, context.signal, connection.timeoutMs);
    job = updateJob(store, job, { state: "completed", waitState: "finished", lastError: undefined });
    return {
      provider: job.connection.id, model: job.connection.model, requestId: job.remoteId,
      items: [{ bytes: downloaded.bytes, mimeType: downloaded.mimeType, fileName: "video" }],
      metadata: {
        jobId: job.id, remoteJobId: job.remoteId, serviceId: job.connection.id,
        submissionToolCallId: job.toolCallId, polls: ready.polls,
      },
    };
  } catch (error) {
    const reason = error instanceof ApiProviderError ? error.code : "transport";
    if (error instanceof ApiProviderError && error.code === "video-failed") {
      job = updateJob(store, job, { state: "failed", waitState: "finished", lastError: "video-failed" });
      // 保留服务端的安全错误码（如 DataInspectionFailed），并补上本地 jobId 便于排查。
      const detail = error.message.replace(/^video-failed:\s*/, "");
      throw new ApiProviderError("video-failed", `${detail}; jobId=${job.id}`);
    }
    job = updateJob(store, job, { waitState: "paused", lastError: reason });
    throw new VideoJobPendingError(job.id, reason, job.remoteId);
  }
}

interface VideoPlan { body: Record<string, unknown>; digest: string }

async function videoPlan(input: VideoGenerateInput, model: string): Promise<VideoPlan> {
  if (!/^wan2\.[7-9]-t2v/.test(model)) {
    throw new ApiProviderError("unsupported", `this endpoint only serves wan2.7 text-to-video models; use wan2.7-t2v instead of ${model}`);
  }
  unsupportedKeys(input, ["inputImagePath", "generateAudio"]);
  const prompt = requiredText(input.prompt, "video prompt", 10_000);
  const negative = input.negativePrompt === undefined ? undefined : requiredText(input.negativePrompt, "negative prompt", 500);
  const parameters: Record<string, unknown> = {};
  if (input.resolution !== undefined) parameters.resolution = videoResolution(input.resolution);
  if (input.aspectRatio !== undefined) parameters.ratio = videoRatio(input.aspectRatio);
  if (input.durationSeconds !== undefined) {
    if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 2 || input.durationSeconds > 15) {
      throw new ApiProviderError("input", "video duration must be a whole number from 2 to 15 seconds");
    }
    parameters.duration = input.durationSeconds;
  }
  if (input.seed !== undefined) {
    if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647) {
      throw new ApiProviderError("input", "seed must be a whole number between 0 and 2147483647");
    }
    parameters.seed = input.seed;
  }
  const body = { model, input: { prompt, ...(negative ? { negative_prompt: negative } : {}) }, parameters };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { body, digest };
}

async function generateVideo(options: NativeMediaProviderOptions, id: string, input: VideoGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  const store = options.jobStore!;
  let job: VideoGenerationJob;
  let connection: ResolvedApiConnection;
  if (input.jobId !== undefined) {
    // 恢复只传 jobId：不读取当前默认值，也不替换提示词。
    unsupportedKeys(input, ["prompt", "model", "negativePrompt", "aspectRatio", "durationSeconds", "resolution", "seed", "inputImagePath", "generateAudio"]);
    assertVideoJobId(input.jobId);
    const saved = store.get(input.jobId);
    if (!saved || saved.taskId !== context.taskId) throw new ApiProviderError("policy", "video job does not belong to this task");
    connection = await resolveApiConnection(options, saved.connection.id);
    if (connection.protocol !== "dashscope") throw new ApiProviderError("configuration", "resume requires the original 阿里云百炼 connection");
    sameConnection(saved, connection);
    return continueVideo(options, saved, connection, context);
  }
  const selected = await resolveApiConnection(options);
  if (selected.protocol !== "dashscope") throw new ApiProviderError("configuration", "this adapter only serves 阿里云百炼 connections");
  const model = resolveModel(selected, input.model);
  const plan = await videoPlan(input, model);
  const previous = store.findByInvocation(context.taskId, context.toolCallId);
  if (previous) {
    if (previous.requestDigest !== plan.digest) throw new ApiProviderError("conflict", "this tool invocation already submitted a different video request");
    sameConnection(previous, selected);
    return continueVideo(options, previous, selected, context);
  }
  const now = Date.now();
  job = {
    id: newVideoJobId(), taskId: context.taskId, toolCallId: context.toolCallId, lastToolCallId: context.toolCallId,
    producerMessageId: context.producerMessageId, connection: videoConnectionSnapshot(selected, model), requestDigest: plan.digest,
    state: "submitting", waitState: "waiting", createdAt: now, updatedAt: now,
  };
  // 先写意图再发计费 POST；被中断的提交永不自动重放。
  store.put(job);
  try {
    const created = taskOutput(await apiJson({ ...selected, headers: asyncHeaders(selected) }, VIDEO_ROUTE, {
      body: JSON.stringify(plan.body), signal: context.signal, maxBytes: MAX_JSON_BYTES, preserveCompletedResponse: true,
    }, options));
    const taskId = remoteTaskId(created.task_id);
    const state = taskState(created.task_status ?? "PENDING");
    if (state === "failed" || state === "expired") {
      job = updateJob(store, job, { remoteId: taskId, state: "failed", waitState: "finished", lastError: "video-failed" });
      throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
    }
    job = updateJob(store, job, { remoteId: taskId, state: state === "completed" ? "in_progress" : state, waitState: "waiting", lastError: undefined });
  } catch (error) {
    if (error instanceof ApiProviderError && error.code === "video-failed") throw error;
    const knownRejected = error instanceof ApiProviderError && error.status !== undefined
      && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status);
    job = updateJob(store, job, {
      state: knownRejected ? "failed" : "submission-unknown",
      waitState: knownRejected ? "finished" : "paused",
      lastError: error instanceof ApiProviderError ? error.code : "transport",
    });
    if (knownRejected) throw new ApiProviderError((error as ApiProviderError).code, `video request was rejected; jobId=${job.id}`, (error as ApiProviderError).status);
    throw new VideoJobPendingError(job.id, "submission-unknown");
  }
  return continueVideo(options, job, selected, context);
}

export function createDashScopeProvider(options: NativeMediaProviderOptions): MediaCapabilityProvider {
  if (options.jobStore) pollLimits(options, "video");
  return {
    id: options.id, label: options.label,
    async test() {
      const connection = await resolveApiConnection(options);
      if (connection.protocol !== "dashscope") throw new ApiProviderError("configuration", "this adapter only serves 阿里云百炼 connections");
      const model = resolveModel(connection);
      return `已配置阿里云百炼连接（${connection.label}，模型 ${model}）；未发送生成请求，实际额度、模型权限与内容审核结果以服务端为准。`;
    },
    generateImage: (input, context) => generateImage(options, options.id, input, context),
    ...(options.jobStore ? { generateVideo: (input: VideoGenerateInput, context: ToolExecutionContext) => generateVideo(options, options.id, input, context) } : {}),
  };
}
