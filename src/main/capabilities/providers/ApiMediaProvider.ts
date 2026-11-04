import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { GeneratedMediaOutput, ImageGenerateInput, MediaCapabilityProvider, ToolExecutionContext, VideoGenerateInput } from "../BuiltinCapabilityRuntime";
import {
  VideoJobPendingError, assertVideoJobId, newVideoJobId, videoConnectionSnapshot,
  type VideoGenerationJob, type VideoGenerationJobStore,
} from "../VideoGenerationJobs";
import {
  ApiProviderError, apiJson, apiMedia, assertNotAborted, assertOpenAiShape, decodeImageBase64,
  downloadApiImage, imageMime, readTaskFile, record, requiredText, resolveApiConnection, resolveModel,
  type ApiProviderOptions, type ResolvedApiConnection,
} from "./ApiServiceConnection";

export interface ApiMediaProviderOptions extends ApiProviderOptions {
  /** Without a durable store the factory intentionally exposes image generation only. */
  jobStore?: VideoGenerationJobStore;
  polling?: { intervalMs?: number; maxWaitMs?: number; maxAttempts?: number };
}

function unsupported(input: object, keys: string[]): void {
  for (const key of keys) if ((input as Record<string, unknown>)[key] !== undefined) {
    throw new ApiProviderError("unsupported", `${key} is not supported by this API adapter`);
  }
}

function dimensions(width: unknown, height: unknown): string {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 64 || (height as number) < 64 || (width as number) > 8192 || (height as number) > 8192) {
    throw new ApiProviderError("input", "dimensions must be whole pixels between 64 and 8192");
  }
  return `${width}x${height}`;
}

function ratio(value: string): number {
  const match = requiredText(value, "aspect ratio", 40).match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new ApiProviderError("input", "aspect ratio must use positive width:height values");
  const result = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(result)) throw new ApiProviderError("input", "invalid aspect ratio");
  return result;
}

function imageSize(input: ImageGenerateInput): string | undefined {
  const wantedRatio = input.aspectRatio === undefined ? undefined : ratio(input.aspectRatio);
  if (input.width !== undefined || input.height !== undefined) {
    const size = dimensions(input.width, input.height);
    if (wantedRatio !== undefined && Math.abs(input.width! / input.height! - wantedRatio) > 0.000001) throw new ApiProviderError("input", "dimensions conflict with the aspect ratio");
    return size;
  }
  if (wantedRatio === undefined) return undefined;
  // Exact mappings only; never turn a requested ratio into a merely nearby one.
  const sizes = [[1024, 1024], [1536, 1024], [1024, 1536], [1536, 864], [864, 1536], [1536, 1152], [1152, 1536]];
  const size = sizes.find(([width, height]) => Math.abs(width / height - wantedRatio) < 0.000001);
  if (!size) throw new ApiProviderError("unsupported", "specify exact width and height for this aspect ratio");
  return `${size[0]}x${size[1]}`;
}

function videoSize(input: VideoGenerateInput): string | undefined {
  const wantedRatio = input.aspectRatio === undefined ? undefined : ratio(input.aspectRatio);
  if (input.resolution !== undefined) {
    const resolution = requiredText(input.resolution, "video resolution", 40);
    const explicit = resolution.match(/^(\d+)x(\d+)$/);
    if (explicit) {
      const width = Number(explicit[1]), height = Number(explicit[2]);
      const size = dimensions(width, height);
      if (wantedRatio !== undefined && Math.abs(width / height - wantedRatio) > 0.000001) throw new ApiProviderError("input", "resolution conflicts with the aspect ratio");
      return size;
    }
    const preset = resolution.match(/^(720|1080)p$/);
    if (!preset) throw new ApiProviderError("unsupported", "video resolution must be WIDTHxHEIGHT, 720p or 1080p");
    const shortSide = Number(preset[1]);
    const r = wantedRatio ?? 16 / 9;
    const width = r >= 1 ? shortSide * r : shortSide;
    const height = r >= 1 ? shortSide : shortSide / r;
    return dimensions(width, height);
  }
  if (wantedRatio === undefined) return undefined;
  return dimensions(wantedRatio >= 1 ? 720 * wantedRatio : 720, wantedRatio >= 1 ? 720 : 720 / wantedRatio);
}

async function referenceImage(path: string, context: ToolExecutionContext): Promise<{ bytes: Buffer; mimeType: string }> {
  const bytes = await readTaskFile(path, context, 20 * 1024 * 1024, [".png", ".jpg", ".jpeg", ".webp"]);
  const mimeType = imageMime(bytes);
  if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new ApiProviderError("format", "reference image must contain PNG, JPEG or WebP bytes");
  return { bytes, mimeType };
}

async function generateImage(options: ApiMediaProviderOptions, id: string, input: ImageGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  unsupported(input, ["negativePrompt", "seed"]);
  const prompt = requiredText(input.prompt, "image prompt", 10_000);
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new ApiProviderError("input", "image count must be between 1 and 4");
  const size = imageSize(input);
  if (input.inputImagePaths !== undefined && (!Array.isArray(input.inputImagePaths) || input.inputImagePaths.length > 8)) throw new ApiProviderError("input", "image editing accepts up to eight reference images");
  const connection = await resolveApiConnection(options);
  assertOpenAiShape(connection);
  const model = resolveModel(connection, input.model);
  const paths = input.inputImagePaths ?? [];
  let body: BodyInit;
  if (paths.length) {
    const form = new FormData();
    form.set("model", model); form.set("prompt", prompt); form.set("n", String(count));
    if (size) form.set("size", size);
    for (const [index, path] of paths.entries()) {
      const reference = await referenceImage(path, context);
      form.append(paths.length > 1 ? "image[]" : "image", new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }), `reference-${index + 1}${extname(path).toLowerCase()}`);
    }
    body = form;
  } else body = JSON.stringify({ model, prompt, n: count, ...(size ? { size } : {}) });
  const response = await apiJson(connection, paths.length ? "/images/edits" : "/images/generations", { body, signal: context.signal, maxBytes: 96 * 1024 * 1024 }, options);
  if (!Array.isArray(response.data) || !response.data.length || response.data.length > count) throw new ApiProviderError("response", "service returned an invalid image result count");
  const items: GeneratedMediaOutput["items"] = [];
  for (const [index, entry] of response.data.entries()) {
    const data = record(entry);
    if ((typeof data.b64_json === "string") === (typeof data.url === "string")) throw new ApiProviderError("response", "image must contain exactly one data source");
    const result = typeof data.b64_json === "string"
      ? decodeImageBase64(data.b64_json, data.mime_type)
      : await downloadApiImage(data.url as string, connection, { signal: context.signal }, options);
    if (data.mime_type !== undefined && data.mime_type !== result.mimeType) throw new ApiProviderError("response", "generated image format does not match its declared type");
    items.push({ bytes: result.bytes, mimeType: result.mimeType, fileName: `image-${index + 1}` });
  }
  return { provider: id, model, items, metadata: { requestedCount: count, returnedCount: items.length, ...(items.length < count ? { partial: true } : {}) } };
}

function remoteVideo(value: Record<string, unknown>, expectedId?: string): { remoteId: string; state: "queued" | "in_progress" | "completed" | "failed" } {
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(value.id) || (expectedId && value.id !== expectedId)) throw new ApiProviderError("response", "invalid remote video ID");
  if (!["queued", "in_progress", "completed", "failed"].includes(String(value.status))) throw new ApiProviderError("response", "unknown remote video state");
  return { remoteId: value.id, state: value.status as "queued" | "in_progress" | "completed" | "failed" };
}

function sameConnection(job: VideoGenerationJob, connection: ResolvedApiConnection): void {
  if (job.connection.id !== connection.id || job.connection.baseUrl !== connection.baseUrl || job.connection.protocol !== connection.protocol) {
    throw new ApiProviderError("configuration", "resume requires the original service ID, URL and protocol; no replacement service was called");
  }
}

function ownedJob(store: VideoGenerationJobStore, id: string, taskId: string): VideoGenerationJob {
  assertVideoJobId(id);
  const job = store.get(id);
  if (!job || job.taskId !== taskId) throw new ApiProviderError("policy", "video job does not belong to this task");
  return job;
}

function updateJob(store: VideoGenerationJobStore, job: VideoGenerationJob, patch: Partial<VideoGenerationJob>): VideoGenerationJob {
  const current = store.get(job.id) ?? job;
  const next = { ...current, ...patch, updatedAt: Math.max(Date.now(), current.createdAt) };
  if (["completed", "failed"].includes(current.state)) next.state = current.state;
  store.put(next);
  return next;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new ApiProviderError("cancelled", "video wait cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function polling(options: ApiMediaProviderOptions): { intervalMs: number; maxWaitMs: number; maxAttempts: number } {
  const values = { intervalMs: options.polling?.intervalMs ?? 2_000, maxWaitMs: options.polling?.maxWaitMs ?? 120_000, maxAttempts: options.polling?.maxAttempts ?? 60 };
  if (!Number.isSafeInteger(values.intervalMs) || values.intervalMs < 1 || values.intervalMs > 60_000
    || !Number.isSafeInteger(values.maxWaitMs) || values.maxWaitMs < 1 || values.maxWaitMs > 30 * 60_000
    || !Number.isSafeInteger(values.maxAttempts) || values.maxAttempts < 1 || values.maxAttempts > 1_000) throw new ApiProviderError("configuration", "invalid video polling budget");
  return values;
}

async function continueVideo(options: ApiMediaProviderOptions, id: string, job: VideoGenerationJob, connection: ResolvedApiConnection, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  const store = options.jobStore!;
  if (job.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
  if (!job.remoteId || ["submitting", "submission-unknown"].includes(job.state)) throw new VideoJobPendingError(job.id, "submission-unknown");
  const limits = polling(options);
  const deadline = Date.now() + limits.maxWaitMs;
  job = updateJob(store, job, { waitState: "waiting", lastToolCallId: context.toolCallId, lastError: undefined });
  let attempts = 0;
  try {
    while (job.state !== "completed") {
      assertNotAborted(context.signal);
      if (attempts >= limits.maxAttempts || Date.now() >= deadline) throw new ApiProviderError("pending", "video is still being generated");
      await wait(Math.min(limits.intervalMs, deadline - Date.now()), context.signal);
      if (Date.now() >= deadline) throw new ApiProviderError("pending", "video is still being generated");
      const response = await apiJson(connection, `/videos/${job.remoteId}`, { method: "GET", signal: context.signal, timeoutMs: deadline - Date.now(), maxBytes: 1024 * 1024 }, options);
      attempts += 1;
      const remote = remoteVideo(response, job.remoteId);
      job = updateJob(store, job, { state: remote.state });
      if (job.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
    }
    assertNotAborted(context.signal);
    if (Date.now() >= deadline) throw new ApiProviderError("pending", "video is ready; download can be resumed");
    const media = await apiMedia(connection, `/videos/${job.remoteId}/content`, "video", {
      method: "GET", signal: context.signal, timeoutMs: deadline - Date.now(), maxBytes: 256 * 1024 * 1024,
    }, options);
    job = updateJob(store, job, { waitState: "finished", lastError: undefined });
    return {
      provider: job.connection.id, model: job.connection.model, requestId: job.remoteId,
      items: [{ bytes: media.bytes, mimeType: media.mimeType, fileName: "video" }],
      metadata: { jobId: job.id, remoteJobId: job.remoteId, serviceId: job.connection.id, submissionToolCallId: job.toolCallId },
    };
  } catch (error) {
    const reason = error instanceof ApiProviderError ? error.code : "transport";
    job = updateJob(store, job, { waitState: job.state === "failed" ? "finished" : "paused", lastError: reason });
    if (job.state === "failed") throw new ApiProviderError("video-failed", `remote video generation failed; jobId=${job.id}`);
    throw new VideoJobPendingError(job.id, reason, job.remoteId);
  }
}

async function generateVideo(options: ApiMediaProviderOptions, id: string, input: VideoGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
  assertNotAborted(context.signal);
  const store = options.jobStore!;
  let job: VideoGenerationJob;
  let connection: ResolvedApiConnection;
  if (input.jobId !== undefined) {
    // A resume uses the saved parameters, never current defaults or a replacement prompt.
    unsupported(input, ["prompt", "model", "negativePrompt", "aspectRatio", "durationSeconds", "resolution", "seed", "inputImagePath", "generateAudio"]);
    job = ownedJob(store, input.jobId, context.taskId);
    connection = await resolveApiConnection(options, job.connection.id);
    sameConnection(job, connection);
  } else {
    unsupported(input, ["negativePrompt", "seed", "generateAudio"]);
    const prompt = requiredText(input.prompt, "video prompt", 10_000);
    const size = videoSize(input);
    if (input.durationSeconds !== undefined && (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 120)) throw new ApiProviderError("input", "video duration must be a whole number from 1 to 120 seconds");
    connection = await resolveApiConnection(options);
    assertOpenAiShape(connection);
    const model = resolveModel(connection, input.model);
    const reference = input.inputImagePath === undefined ? undefined : await referenceImage(input.inputImagePath, context);
    const requestDigest = createHash("sha256").update(JSON.stringify({ model, prompt, size, seconds: input.durationSeconds,
      reference: reference ? createHash("sha256").update(reference.bytes).digest("hex") : undefined })).digest("hex");
    const previous = store.findByInvocation(context.taskId, context.toolCallId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw new ApiProviderError("conflict", "this tool invocation already submitted a different video request");
      sameConnection(previous, connection);
      job = previous;
    } else {
      const body = new FormData();
      body.set("model", model); body.set("prompt", prompt);
      if (size !== undefined) body.set("size", size);
      if (input.durationSeconds !== undefined) body.set("seconds", String(input.durationSeconds));
      if (reference) body.set("input_reference", new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }), `reference${extname(input.inputImagePath!).toLowerCase()}`);
      assertNotAborted(context.signal);
      const now = Date.now();
      job = { id: newVideoJobId(), taskId: context.taskId, toolCallId: context.toolCallId, lastToolCallId: context.toolCallId,
        producerMessageId: context.producerMessageId, connection: videoConnectionSnapshot(connection, model), requestDigest,
        state: "submitting", waitState: "waiting", createdAt: now, updatedAt: now };
      // Write intent before a billable POST. An interrupted submission is never automatically replayed.
      store.put(job);
      let remote: ReturnType<typeof remoteVideo>;
      try {
        remote = remoteVideo(await apiJson(connection, "/videos", {
          body, signal: context.signal, maxBytes: 1024 * 1024, preserveCompletedResponse: true,
        }, options));
      } catch (error) {
        const knownRejected = error instanceof ApiProviderError && error.status !== undefined && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status);
        job = updateJob(store, job, { state: knownRejected ? "failed" : "submission-unknown", waitState: knownRejected ? "finished" : "paused", lastError: error instanceof ApiProviderError ? error.code : "transport" });
        if (knownRejected) throw new ApiProviderError(error.code, `video request was rejected; jobId=${job.id}`, error.status);
        throw new VideoJobPendingError(job.id, "submission-unknown");
      }
      try { job = updateJob(store, job, { ...remote, waitState: remote.state === "failed" ? "finished" : "waiting" }); }
      catch { throw new VideoJobPendingError(job.id, "storage", remote.remoteId); }
    }
  }
  return continueVideo(options, id, job, connection, context);
}

export function createApiMediaProvider(options: ApiMediaProviderOptions): MediaCapabilityProvider {
  const id = options.id ?? "api-media";
  if (options.jobStore) polling(options);
  return {
    id, label: options.label ?? "媒体 API",
    async test() {
      const connection = await resolveApiConnection(options);
      assertOpenAiShape(connection);
      resolveModel(connection);
      return "配置完整；未发送图片或视频生成请求，实际服务与模型尚未试用。";
    },
    generateImage: (input, context) => generateImage(options, id, input, context),
    ...(options.jobStore ? { generateVideo: (input: VideoGenerateInput, context: ToolExecutionContext) => generateVideo(options, id, input, context) } : {}),
  };
}
