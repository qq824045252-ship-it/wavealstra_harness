import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlackForestLabsProvider } from "../src/main/capabilities/providers/BlackForestLabsProvider";
import type { NativeMediaProviderOptions } from "../src/main/capabilities/providers/NativeMediaProvider";
import { ApiProviderError, type ResolvedApiConnection } from "../src/main/capabilities/providers/ApiServiceConnection";
import { VideoGenerationJobs, VideoJobPendingError, type VideoGenerationJob, type VideoGenerationJobStore } from "../src/main/capabilities/VideoGenerationJobs";
import type { ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";

/**
 * Offline contract test for the Black Forest Labs (FLUX) adapter.
 *
 * Every request goes to the fake fetch below, which asserts it is only ever handed
 * https://api.bfl.ai URLs, so this suite proves the adapter never reaches the network.
 */

const KEY = "test-flux-key-9f3a2c-not-a-real-credential";
const API = "https://api.bfl.ai/v1";
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
// ISO-BMFF header: length + "ftyp" + "mp42" — mediaMime() classifies this as video/mp4.
const mp4Bytes = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp", "ascii"), Buffer.from("mp42", "ascii"),
  Buffer.from([0, 0, 0, 0]), Buffer.from("mp42", "ascii"), Buffer.from("isom", "ascii"),
]);

interface Seen { method: string; url: URL; headers: Headers; body: unknown }
interface Call { method: string; url: URL; headers: Headers; body: unknown; posts: number; gets: number }
type Handler = (call: Call) => Response | Promise<Response>;

const seen: Seen[] = [];
let posts = 0;
let gets = 0;
let handler: Handler = () => { throw new Error("no handler installed"); };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function binary(bytes: Buffer, type: string): Response {
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type } });
}
function neverCalled(name: string): never { throw new Error(`unexpected request to ${name}; the adapter must not call it`); }

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const method = String(init?.method ?? "GET").toUpperCase();
  // The API origin is the only host that may receive `x-key`; artifacts are public signed URLs.
  const apiOrigin = url.origin === "https://api.bfl.ai";
  const artifactOrigin = url.origin === "https://delivery.bfl.ai" && method === "GET";
  assert(apiOrigin || artifactOrigin, `unexpected host ${url.origin}; this suite never reaches the real network`);
  if (artifactOrigin) assert.equal(headers.get("x-key"), null, "the API credential never follows a signed CDN URL");
  assert.equal(init?.redirect, "error", "authenticated requests must not follow redirects");
  assert(init?.signal, "every request is bounded and cancellable");
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const call = { method, url, headers, body, posts: method === "POST" ? posts + 1 : posts, gets: method === "GET" ? gets + 1 : gets };
  if (method === "POST") posts += 1; else if (method === "GET") gets += 1; else neverCalled(method);
  seen.push({ method, url, headers, body });
  return handler(call);
}) as typeof fetch;

class MemoryJobStore implements VideoGenerationJobStore {
  jobs: VideoGenerationJob[] = [];
  writes: VideoGenerationJob[] = [];
  get(id: string): VideoGenerationJob | undefined { return this.jobs.find(job => job.id === id); }
  list(taskId?: string): VideoGenerationJob[] { return this.jobs.filter(job => taskId === undefined || job.taskId === taskId); }
  findByInvocation(taskId: string, toolCallId: string): VideoGenerationJob | undefined {
    return this.jobs.find(job => job.taskId === taskId && job.toolCallId === toolCallId);
  }
  put(job: VideoGenerationJob): void {
    this.writes.push(job);
    const index = this.jobs.findIndex(item => item.id === job.id);
    if (index < 0) this.jobs.push(job); else this.jobs[index] = job;
  }
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-bfl-"));
const taskRoot = join(root, "task");
await mkdir(taskRoot);
const referencePath = join(taskRoot, "reference.png");
await writeFile(referencePath, pngBytes);
const outsidePath = join(root, "outside.png");
await writeFile(outsidePath, pngBytes);

const context = (toolCallId: string): ToolExecutionContext => ({ taskId: "task-bfl", taskRoot, toolCallId });
const connection: ResolvedApiConnection = {
  id: "flux-connection", label: "FLUX 官方", baseUrl: API, headers: { "x-key": KEY },
  timeoutMs: 5_000, protocol: "black-forest-labs", model: "flux-3-image",
};
/** The saved connection carries one default model, exactly like the settings binding does. */
function useModel(model: string): void { connection.model = model; }

const polling: { intervalMs: number; maxWaitMs: number; maxAttempts: number } = { intervalMs: 1, maxWaitMs: 2_000, maxAttempts: 20 };
const store = new MemoryJobStore();
const options: NativeMediaProviderOptions = {
  id: "flux-connection", label: "FLUX 官方",
  getConnection: async (target?: string) => {
    if (target !== undefined && target !== connection.id) throw new Error("unknown connection");
    return connection;
  },
  jobStore: store, fetch: fakeFetch, polling,
};
const provider = createBlackForestLabsProvider(options);
const imageOnlyProvider = createBlackForestLabsProvider({ ...options, jobStore: undefined });

function assertNoSecret(value: unknown): void {
  assert(!JSON.stringify(value).includes(KEY), "credentials must never appear in results or errors");
}
function assertKeyHeader(headers: Headers, expected = true): void {
  assert.equal(headers.get("x-key"), expected ? KEY : null, "the adapter relies on the connection's x-key header");
  assert.equal(headers.get("authorization"), null, "the adapter must not build its own Authorization header");
}

try {
  // ---------------------------------------------------------------- ① 图片：提交 → Pending → Ready → 下载
  let imageTask = 0;
  handler = (call) => {
    if (call.method === "POST") {
      imageTask += 1;
      return json({ id: `task-img-${imageTask}`, polling_url: `${API}/get_result?id=task-img-${imageTask}` });
    }
    if (call.url.pathname === "/v1/get_result") {
      const id = call.url.searchParams.get("id");
      return call.gets % 2 === 1
        ? json({ id, status: "Pending", progress: 0.1 })
        : json({ id, status: "Ready", progress: 1, result: { sample: `${API}/results/${id}.png` } });
    }
    if (call.url.pathname.startsWith("/v1/results/")) return binary(pngBytes, "image/png");
    return neverCalled(call.url.pathname);
  };

  const imageResult = await provider.generateImage!({ prompt: "a lighthouse at dusk", aspectRatio: "16:9" }, context("call-image-1"));
  const imagePost = seen[0];
  assert.equal(imagePost.method, "POST");
  assert.equal(imagePost.url.toString(), `${API}/flux-3-image`, "images are submitted to {baseUrl}/{model}");
  assertKeyHeader(imagePost.headers);
  assert.equal(imagePost.headers.get("content-type"), "application/json");
  assert.deepEqual(imagePost.body, { prompt: "a lighthouse at dusk", aspect_ratio: "16:9" });
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].url.toString(), `${API}/get_result?id=task-img-1`, "the returned polling_url is followed verbatim");
  assertKeyHeader(seen[1].headers, true);
  assert.equal(seen[2].url.toString(), `${API}/get_result?id=task-img-1`, "Pending is polled again");
  assert.equal(seen[3].url.toString(), `${API}/results/task-img-1.png`, "the Ready result URL is downloaded");
  assertKeyHeader(seen[3].headers, true);
  assert.equal(imageResult.provider, "flux-connection");
  assert.equal(imageResult.model, "flux-3-image");
  assert.equal(imageResult.requestId, "task-img-1");
  assert.equal(imageResult.items.length, 1);
  assert.equal(imageResult.items[0]!.mimeType, "image/png");
  assert.deepEqual(Buffer.from(imageResult.items[0]!.bytes!), pngBytes);
  assert.deepEqual(imageResult.metadata?.taskIds, ["task-img-1"]);
  assertNoSecret(imageResult);

  // count>1: the FLUX API has no `n`, so each image is its own submitted task.
  const beforeCount = posts;
  const twoImages = await provider.generateImage!({ prompt: "two postcards", count: 2 }, context("call-image-2"));
  assert.equal(posts - beforeCount, 2, "one billable task per requested image");
  assert.equal(twoImages.items.length, 2);
  assertNoSecret(twoImages);

  // Reference images (task-local PNG -> data URL) and the FLUX.2 request shape.
  const beforeFlux2 = seen.length;
  const flux2 = await provider.generateImage!(
    { prompt: "restyle", model: "flux-2-pro", width: 1024, height: 1024, inputImagePaths: [referencePath] },
    context("call-image-3"),
  );
  const flux2Post = seen[beforeFlux2]!;
  assert.equal(flux2Post.url.toString(), `${API}/flux-2-pro`);
  assert.deepEqual(flux2Post.body, {
    prompt: "restyle", width: 1024, height: 1024,
    input_image: `data:image/png;base64,${pngBytes.toString("base64")}`,
  });
  assert.equal(flux2.model, "flux-2-pro");

  // The task boundary is still enforced for reference images.
  const beforeOutside = seen.length;
  await assert.rejects(provider.generateImage!({ prompt: "x", inputImagePaths: [outsidePath] }, context("call-image-4")),
    err => err instanceof ApiProviderError && err.code === "policy");
  assert.equal(seen.length, beforeOutside, "out-of-task images are never uploaded");

  // Unsupported input is refused before any billable request.
  const beforeUnsupported = seen.length;
  await assert.rejects(provider.generateImage!({ prompt: "x", negativePrompt: "ugly" }, context("call-image-5")),
    err => err instanceof ApiProviderError && err.code === "unsupported");
  await assert.rejects(provider.generateImage!({ prompt: "x", model: "flux-2-pro", aspectRatio: "16:9" }, context("call-image-6")),
    err => err instanceof ApiProviderError && err.code === "input");
  await assert.rejects(provider.generateImage!({ prompt: "x", model: "flux-unknown-route" }, context("call-image-7")),
    err => err instanceof ApiProviderError && err.code === "unsupported");
  assert.equal(seen.length, beforeUnsupported, "invalid input never reaches the service");

  // An unsafe polling_url must be refused instead of leaking x-key to another host.
  handler = () => json({ id: "task-evil", polling_url: "https://evil.example/poll?id=task-evil" });
  await assert.rejects(provider.generateImage!({ prompt: "x" }, context("call-image-8")),
    err => err instanceof ApiProviderError && err.code === "response");
  assert.equal(seen.length, beforeUnsupported + 1, "only the submission left the API origin");
  assert(seen.every(entry => entry.url.origin === "https://api.bfl.ai"));

  // ---------------------------------------------------------------- ② 视频：提交 → job 落库 → 轮询 → 完成下载
  useModel("flux-3-video");
  store.jobs = []; store.writes = [];
  handler = (call) => {
    if (call.method === "POST") {
      assert.equal(call.url.toString(), `${API}/flux-3-video`);
      return json({ id: "task-vid-1", polling_url: `${API}/get_result?id=task-vid-1` });
    }
    if (call.url.pathname === "/v1/get_result") {
      const id = call.url.searchParams.get("id");
      const step = call.gets % 4;
      if (step === 1) return json({ id, status: "Pending" });
      if (step === 2) return json({ id, status: "Generating", progress: 0.4 });
      return json({ id, status: "Ready", progress: 1, result: { video: "https://delivery.bfl.ai/clip.mp4?sig=abc" } });
    }
    if (call.url.hostname === "delivery.bfl.ai") return binary(mp4Bytes, "video/mp4");
    return neverCalled(call.url.pathname);
  };

  posts = 0; gets = 0;
  const videoResult = await provider.generateVideo!(
    { prompt: "a paper boat drifting", aspectRatio: "16:9", durationSeconds: 8, resolution: "hd", generateAudio: false },
    context("call-video-1"),
  );
  const videoPost = seen.find(entry => entry.method === "POST" && entry.url.pathname === "/v1/flux-3-video")!;
  assertKeyHeader(videoPost.headers);
  assert.deepEqual(videoPost.body, {
    prompt: "a paper boat drifting", mode: "t2v", aspect_ratio: "16:9", duration: 8, resolution: "hd", generate_audio: false,
  });
  assert.equal(store.writes[0]!.state, "submitting", "intent is written before the billable POST");
  assert.equal(store.writes[0]!.remoteId, undefined);
  assert(store.writes.some(job => job.state === "queued" && job.remoteId === "task-vid-1"), "the remote ID is persisted");
  const storedVideo = store.jobs[0]!;
  assert.equal(storedVideo.state, "completed");
  assert.equal(storedVideo.waitState, "finished");
  assert.equal(storedVideo.remoteId, "task-vid-1");
  assert.equal(storedVideo.connection.protocol, "black-forest-labs");
  assert.equal(storedVideo.connection.model, "flux-3-video");
  assert.equal(videoResult.provider, "flux-connection");
  assert.equal(videoResult.model, "flux-3-video");
  assert.equal(videoResult.requestId, "task-vid-1");
  assert.equal(videoResult.items[0]!.mimeType, "video/mp4");
  assert.deepEqual(Buffer.from(videoResult.items[0]!.bytes!), mp4Bytes);
  assert.equal(videoResult.metadata?.jobId, storedVideo.id);
  assert.equal(videoResult.metadata?.remoteJobId, "task-vid-1");
  // The durable ledger accepts the native-protocol snapshot this adapter writes.
  const ledger = new VideoGenerationJobs(join(root, "video-jobs.json"));
  ledger.put(storedVideo);
  assert.equal(ledger.get(storedVideo.id)?.connection.protocol, "black-forest-labs");
  assert.equal(ledger.list("task-bfl").length, 1);
  // The signed CDN URL is fetched without the API credential.
  const artifact = seen.find(entry => entry.url.hostname === "delivery.bfl.ai")!;
  assertKeyHeader(artifact.headers, false);
  assertNoSecret(videoResult);
  assertNoSecret(store.jobs);

  // i2v: a task-local first frame becomes a keyframe data URL.
  store.jobs = []; store.writes = [];
  const beforeI2v = seen.length;
  await provider.generateVideo!({ prompt: "animate this", inputImagePath: referencePath }, context("call-video-2"));
  const i2vPost = seen.slice(beforeI2v).find(entry => entry.method === "POST")!;
  assert.equal((i2vPost.body as Record<string, unknown>).mode, "i2v");
  assert.equal((i2vPost.body as Record<string, unknown>).keyframes, `data:image/png;base64,${pngBytes.toString("base64")}`);

  // ---------------------------------------------------------------- ③ 远端 Error / 审核拒绝 → job failed
  for (const [status, expectedReason] of [["Error", "error"], ["Content Moderated", "moderated"], ["Request Moderated", "moderated"]] as const) {
    store.jobs = []; store.writes = [];
    handler = (call) => call.method === "POST"
      ? json({ id: "task-v2", polling_url: `${API}/get_result?id=task-v2` })
      : json({ id: "task-v2", status });
    posts = 0; gets = 0;
    const beforeFail = seen.length;
    await assert.rejects(provider.generateVideo!({ prompt: `fails as ${status}` }, context(`call-fail-${status}`)),
      err => err instanceof ApiProviderError && err.code === "video-failed" && !err.message.includes(KEY));
    const failed = store.jobs[0]!;
    assert.equal(failed.state, "failed", `${status} is terminal`);
    assert.equal(failed.waitState, "finished");
    assert.equal(failed.lastError, expectedReason);
    assert(!seen.slice(beforeFail).some(entry => entry.method === "GET" && entry.url.hostname !== "api.bfl.ai"),
      "a failed task never downloads an artifact");
    assertNoSecret(failed);
    // A terminal job is never re-submitted.
    posts = 0;
    await assert.rejects(provider.generateVideo!({ jobId: failed.id }, context(`call-fail-${status}`)),
      err => err instanceof ApiProviderError && err.code === "video-failed");
    assert.equal(posts, 0, "a failed job is never submitted again");
  }

  // Image moderation is surfaced as a policy refusal.
  useModel("flux-3-image");
  handler = (call) => call.method === "POST"
    ? json({ id: "task-mod", polling_url: `${API}/get_result?id=task-mod` })
    : json({ id: "task-mod", status: "Content Moderated" });
  await assert.rejects(provider.generateImage!({ prompt: "blocked" }, context("call-image-9")),
    err => err instanceof ApiProviderError && err.code === "policy" && !err.message.includes(KEY));

  // ---------------------------------------------------------------- ④ HTTP 401 → authentication
  useModel("flux-3-image");
  store.jobs = []; store.writes = [];
  handler = () => json({ detail: `invalid key ${KEY}` }, 401);
  posts = 0;
  await assert.rejects(provider.generateImage!({ prompt: "unauthorized" }, context("call-image-10")),
    err => err instanceof ApiProviderError && err.code === "authentication" && !err.message.includes(KEY));
  useModel("flux-3-video");
  await assert.rejects(provider.generateVideo!({ prompt: "unauthorized" }, context("call-video-3")),
    err => err instanceof ApiProviderError && err.code === "authentication" && !err.message.includes(KEY));
  assert.equal(store.jobs[0]!.state, "failed", "a rejected submission is terminal, never submission-unknown");
  assert.equal(store.jobs[0]!.lastError, "authentication");

  // ---------------------------------------------------------------- ⑤ 等待预算耗尽 → pending，且不重提
  store.jobs = []; store.writes = [];
  handler = (call) => call.method === "POST"
    ? json({ id: "task-slow", polling_url: `${API}/get_result?id=task-slow` })
    : json({ id: "task-slow", status: "Generating", progress: 0.2 });
  posts = 0;
  polling.maxWaitMs = 1; polling.maxAttempts = 1;
  await assert.rejects(provider.generateVideo!({ prompt: "slow clip" }, context("call-video-4")), (error: unknown) => {
    assert(error instanceof VideoJobPendingError, "a local budget timeout is a resumable pending job");
    assert.equal(error.remoteId, "task-slow");
    assert.match(error.message, /Remote generation was not cancelled/);
    assert(!error.message.includes(KEY));
    return true;
  });
  assert.equal(posts, 1, "a wait-budget timeout never re-submits");
  const pendingJob = store.jobs[0]!;
  assert.equal(pendingJob.state, "in_progress");
  assert.equal(pendingJob.waitState, "paused");
  assert.equal(pendingJob.lastError, "pending");

  // ---------------------------------------------------------------- ⑥ 传入 jobId → 只轮询
  polling.maxWaitMs = 2_000; polling.maxAttempts = 20;
  handler = (call) => {
    if (call.method !== "GET") neverCalled("POST during resume");
    if (call.url.pathname === "/v1/get_result") {
      const id = call.url.searchParams.get("id");
      return json({ id, status: "Ready", result: { video: `${API}/results/${id}.mp4` } });
    }
    if (call.url.pathname.startsWith("/v1/results/")) return binary(mp4Bytes, "video/mp4");
    return neverCalled(call.url.pathname);
  };
  posts = 0; gets = 0;
  const resumed = await provider.generateVideo!({ jobId: pendingJob.id }, context("call-video-5"));
  assert.equal(posts, 0, "resume never submits a new paid request");
  assert(seen.slice(-2).every(entry => entry.method === "GET"));
  assert.equal(seen.at(-2)!.url.toString(), `${API}/get_result?id=task-slow`, "resume polls the saved remote ID");
  assert.equal(resumed.requestId, "task-slow");
  assert.equal(resumed.items[0]!.mimeType, "video/mp4");
  assert.equal(store.jobs[0]!.state, "completed");
  assertNoSecret(resumed);

  // ---------------------------------------------------------------- ⑦ test() 只做配置检查
  const beforeTest = seen.length;
  const message = await provider.test!();
  assert.equal(seen.length, beforeTest, "test() must not send a generation request");
  assert.match(message, /未发送生成请求/);
  assert(!message.includes(KEY));

  // Without a durable store the factory exposes images only.
  assert.equal(imageOnlyProvider.generateVideo, undefined);
  assert.equal(typeof imageOnlyProvider.generateImage, "function");

  // The adapter refuses connections it does not own.
  const otherProvider = createBlackForestLabsProvider({
    ...options,
    getConnection: async () => ({ ...connection, protocol: "openai-compatible" }),
  });
  await assert.rejects(otherProvider.test!(), err => err instanceof ApiProviderError && err.code === "configuration");

  assert(seen.every(entry => entry.url.origin === "https://api.bfl.ai"
    || (entry.url.origin === "https://delivery.bfl.ai" && entry.method === "GET")), "no request escaped the documented BFL hosts");
  console.log("PASS Black Forest Labs provider: x-key auth, async image/video tasks, job ledger, resume-only polling, error mapping and secret hygiene");
} finally {
  await rm(root, { recursive: true, force: true });
}
