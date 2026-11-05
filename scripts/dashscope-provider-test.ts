import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { VideoGenerationJobs, VideoJobPendingError } from "../src/main/capabilities/VideoGenerationJobs";
import { ApiProviderError, type ResolvedApiConnection } from "../src/main/capabilities/providers/ApiServiceConnection";
import { createDashScopeProvider } from "../src/main/capabilities/providers/DashScopeProvider";
import type { NativeMediaProviderOptions } from "../src/main/capabilities/providers/NativeMediaProvider";

/**
 * 零联网：所有 HTTP 都由 fake fetch 应答。唯一的传输层依赖是 `fetch`，
 * 图片下载走下载助手（同源 URL，不触发 DNS），视频下载走适配器自己的 fetch。
 */

const KEY = "fixture-dashscope-key";
const BASE = "https://dashscope.aliyuncs.com/api/v1";
/** 同源地址，避免离线测试触发 DNS 解析。 */
const IMAGE_URL = `${BASE}/fixtures/image-1.png`;
const IMAGE_URL_2 = `${BASE}/fixtures/image-2.png`;
/** 真实服务返回 OSS 签名地址，这里用跨源 https 验证"下载不带凭据"。 */
const VIDEO_URL = "https://dashscope-result-sh.oss-accelerate.aliyuncs.com/fixture.mp4";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
function mp4Bytes(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  return bytes;
}

interface Call { method: string; url: URL; headers: Headers; body: Record<string, unknown> | undefined }
type Handler = (call: Call) => Response;
const calls: Call[] = [];
const routes = new Map<string, Handler>();
const unexpected: string[] = [];

const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "POST").toUpperCase();
  const headers = new Headers(init?.headers);
  const raw = typeof init?.body === "string" ? init.body : undefined;
  const call: Call = { method, url, headers, body: raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown> };
  calls.push(call);
  assert.equal(init?.redirect, "error", "凭据不能跟随重定向");
  assert(init?.signal, "每个请求都必须可取消/有超时");
  if (init?.body !== undefined) assert.equal(headers.get("content-type"), "application/json", "JSON 请求体必须声明类型");
  const handler = routes.get(`${method} ${url.pathname}`);
  if (!handler) { unexpected.push(`${method} ${url.pathname}`); return new Response("{}", { status: 599 }); }
  return handler(call);
}) as typeof fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function binary(bytes: Buffer, type: string): Response {
  return new Response(new Uint8Array(bytes), { headers: { "content-type": type } });
}
function reset(): void {
  assert.equal(unexpected.length, 0, `未被拦截的请求: ${unexpected.join(", ")}`);
  calls.length = 0;
  routes.clear();
}
function posts(): Call[] { return calls.filter(call => call.method === "POST"); }
function mediaDownloads(): Call[] { return calls.filter(call => [IMAGE_URL, IMAGE_URL_2, VIDEO_URL].includes(call.url.toString())); }

function route(method: "GET" | "POST", path: string, handler: Handler): void {
  routes.set(`${method} ${path}`, handler);
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-dashscope-"));
const taskRoot = join(root, "task");
await mkdir(taskRoot);
await writeFile(join(taskRoot, "reference.png"), PNG);
const ledger = new VideoGenerationJobs(join(root, "video-jobs.json"));
const taskId = "task-dashscope";

let connection: ResolvedApiConnection = {
  id: "dashscope-main", label: "阿里云百炼", baseUrl: BASE,
  headers: { authorization: `Bearer ${KEY}` }, timeoutMs: 30_000,
  protocol: "dashscope", model: "wan2.5-t2i-preview",
};
const baseOptions: NativeMediaProviderOptions = {
  id: "dashscope-main", label: "阿里云百炼",
  getConnection: () => connection,
  jobStore: ledger,
  fetch: fetchImpl,
  polling: { intervalMs: 1, maxWaitMs: 5_000, maxAttempts: 500 },
};
const provider = createDashScopeProvider(baseOptions);
assert(provider.generateImage);
const generateImage = provider.generateImage.bind(provider);
/** 更小的等待预算，用来证明"本地超时只暂停、远端不取消、也不重提"。 */
const shortProvider = createDashScopeProvider({ ...baseOptions, polling: { intervalMs: 1, maxWaitMs: 10, maxAttempts: 500 } });

let callSeq = 0;
function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  callSeq += 1;
  return { taskId, taskRoot, toolCallId: `call-${callSeq}`, ...overrides };
}

const errors: string[] = [];
async function failure(action: () => Promise<unknown>): Promise<ApiProviderError> {
  try { await action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    if (error instanceof ApiProviderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

try {
  /* ---------------------------------------------------------------- ① 图片：异步提交 → RUNNING → SUCCEEDED → 下载 */
  reset();
  let imagePolls = 0;
  route("POST", "/api/v1/services/aigc/text2image/image-synthesis", () => json({ request_id: "req-img-1", output: { task_id: "task-img-1", task_status: "PENDING" } }));
  route("GET", "/api/v1/tasks/task-img-1", () => {
    imagePolls += 1;
    return imagePolls === 1
      ? json({ request_id: "req-img-1", output: { task_id: "task-img-1", task_status: "RUNNING" } })
      : json({ request_id: "req-img-1", output: { task_id: "task-img-1", task_status: "SUCCEEDED", results: [{ orig_prompt: "p", actual_prompt: "p2", url: IMAGE_URL }] } });
  });
  route("GET", "/api/v1/fixtures/image-1.png", () => binary(PNG, "image/png"));
  const imageResult = await generateImage({ prompt: "一只橘猫", aspectRatio: "16:9", count: 1 }, context());
  assert.equal(imageResult.provider, "dashscope-main");
  assert.equal(imageResult.model, "wan2.5-t2i-preview");
  assert.equal(imageResult.requestId, "task-img-1");
  assert.equal(imageResult.items.length, 1);
  assert.equal(imageResult.items[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(imageResult.items[0].bytes!), PNG);
  const imageSubmit = posts()[0];
  assert.equal(imageSubmit.url.toString(), `${BASE}/services/aigc/text2image/image-synthesis`);
  assert.equal(imageSubmit.headers.get("authorization"), `Bearer ${KEY}`, "认证头来自连接，不另行拼装");
  assert.equal(imageSubmit.headers.get("x-dashscope-async"), "enable", "异步创建必须带 X-DashScope-Async");
  assert.deepEqual(imageSubmit.body?.model, "wan2.5-t2i-preview");
  assert.deepEqual(imageSubmit.body?.input, { prompt: "一只橘猫" }, "wan2.5 及以下使用 input.prompt");
  assert.deepEqual(imageSubmit.body?.parameters, { n: 1, size: "1696*960" }, "16:9 精确映射到官方推荐分辨率");
  assert.equal(imagePolls, 2, "RUNNING 之后再查一次才拿到 SUCCEEDED");
  assert.deepEqual(calls.filter(call => call.method === "GET" && call.url.toString() === IMAGE_URL).length, 1, "结果 URL 只下载一次");
  assert(!JSON.stringify(imageResult).includes(KEY), "结果里不含密钥");

  /* ---------------------------------------------------------------- ② 图片：qwen-image 同步接口 + 参考图（data URL） */
  reset();
  route("POST", "/api/v1/services/aigc/multimodal-generation/generation", () => json({
    request_id: "req-qwen-1",
    output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: IMAGE_URL }, { image: IMAGE_URL_2 }] } }] },
  }));
  route("GET", "/api/v1/fixtures/image-1.png", () => binary(PNG, "image/png"));
  route("GET", "/api/v1/fixtures/image-2.png", () => binary(PNG, "image/png"));
  const qwen = await generateImage({
    prompt: "把这张图改成水彩", model: "qwen-image-2.0-pro", aspectRatio: "1:1", count: 2, negativePrompt: "低清", inputImagePaths: ["reference.png"],
  }, context());
  assert.equal(qwen.items.length, 2, "逐张下载多图结果");
  const qwenSubmit = posts()[0];
  assert.equal(qwenSubmit.url.toString(), `${BASE}/services/aigc/multimodal-generation/generation`, "qwen-image 使用同步多模态端点");
  assert.equal(qwenSubmit.headers.get("x-dashscope-async"), null, "同步接口不能带异步头");
  const messages = (qwenSubmit.body?.input as { messages: Array<{ role: string; content: Array<Record<string, string>> }> }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content[0].image, /^data:image\/png;base64,/, "参考图以 data URL 传入");
  assert.equal(messages[0].content[1].text, "把这张图改成水彩");
  assert.deepEqual(qwenSubmit.body?.parameters, { n: 2, size: "2048*2048", negative_prompt: "低清" });
  assert.equal(qwenSubmit.body?.model, "qwen-image-2.0-pro");

  /* ---------------------------------------------------------------- ③ 图片：wan2.6 走新版异步端点 */
  reset();
  let wan26Polls = 0;
  route("POST", "/api/v1/services/aigc/image-generation/generation", () => json({ request_id: "req-wan26", output: { task_id: "task-img-26", task_status: "PENDING" } }));
  route("GET", "/api/v1/tasks/task-img-26", () => {
    wan26Polls += 1;
    return json({ output: wan26Polls === 1
      ? { task_id: "task-img-26", task_status: "PENDING" }
      : { task_id: "task-img-26", task_status: "SUCCEEDED", results: [{ url: IMAGE_URL }] } });
  });
  route("GET", "/api/v1/fixtures/image-1.png", () => binary(PNG, "image/png"));
  await generateImage({ prompt: "花店", model: "wan2.6-t2i" }, context());
  const wan26Submit = posts()[0];
  assert.equal(wan26Submit.url.toString(), `${BASE}/services/aigc/image-generation/generation`);
  assert.equal(wan26Submit.headers.get("x-dashscope-async"), "enable");
  assert.deepEqual(wan26Submit.body?.input, { messages: [{ role: "user", content: [{ text: "花店" }] }] }, "wan2.6 使用 messages 输入");

  /* ---------------------------------------------------------------- ④ 视频：提交 → 落库 → 轮询 → 下载 */
  reset();
  connection = { ...connection, model: "wan2.7-t2v" };
  let videoSubmitted = 0;
  let sawIntent = false;
  let sawQueued = false;
  let videoPolls = 0;
  route("POST", "/api/v1/services/aigc/video-generation/video-synthesis", (call) => {
    videoSubmitted += 1;
    // 计费 POST 之前必须已经落库（state=submitting，且还没有远端 ID）。
    const pending = ledger.list(taskId).filter(job => job.state === "submitting");
    sawIntent = pending.length === 1 && pending[0].remoteId === undefined;
    assert.equal(call.headers.get("x-dashscope-async"), "enable");
    return json({ request_id: "req-vid-1", output: { task_id: "task-vid-1", task_status: "PENDING" } });
  });
  route("GET", "/api/v1/tasks/task-vid-1", () => {
    videoPolls += 1;
    const stored = ledger.list(taskId).find(job => job.remoteId === "task-vid-1");
    sawQueued = sawQueued || (stored?.state === "queued" && stored.waitState === "waiting");
    return json({ output: videoPolls === 1
      ? { task_id: "task-vid-1", task_status: "RUNNING" }
      : { task_id: "task-vid-1", task_status: "SUCCEEDED", video_url: VIDEO_URL } });
  });
  route("GET", "/fixture.mp4", () => binary(mp4Bytes(), "video/mp4"));
  const videoResult = await provider.generateVideo!({ prompt: "小猫奔跑", aspectRatio: "16:9", resolution: "1080p", durationSeconds: 5 }, context());
  assert.equal(videoSubmitted, 1, "只提交一次计费请求");
  assert(sawIntent, "POST 之前必须先把 submitting 意图落库");
  assert(sawQueued, "拿到 task_id 后任务状态落库为 queued");
  assert.equal(videoResult.items.length, 1);
  assert.equal(videoResult.items[0].mimeType, "video/mp4");
  assert.deepEqual(Buffer.from(videoResult.items[0].bytes!), mp4Bytes());
  assert.equal(videoResult.requestId, "task-vid-1");
  const videoJob = ledger.list(taskId).find(job => job.remoteId === "task-vid-1")!;
  assert.equal(videoJob.state, "completed");
  assert.equal(videoJob.waitState, "finished");
  assert.equal(videoJob.connection.protocol, "dashscope");
  const videoSubmit = posts()[0];
  assert.deepEqual(videoSubmit.body?.parameters, { resolution: "1080P", ratio: "16:9", duration: 5 }, "分辨率档位大写入参 + 精确比例 + 整数时长");
  const videoDownload = calls.find(call => call.url.toString() === VIDEO_URL)!;
  assert.equal(videoDownload.headers.get("authorization"), null, "签名 CDN 下载不带凭据");
  assert.equal(videoDownload.headers.get("x-dashscope-async"), null);

  /* ---------------------------------------------------------------- ⑤ 视频：远端 FAILED → job failed */
  reset();
  let failedPolls = 0;
  route("POST", "/api/v1/services/aigc/video-generation/video-synthesis", () => json({ output: { task_id: "task-vid-2", task_status: "PENDING" } }));
  route("GET", "/api/v1/tasks/task-vid-2", () => {
    failedPolls += 1;
    return json({ output: { task_id: "task-vid-2", task_status: "FAILED", code: "DataInspectionFailed" } });
  });
  const failedError = await failure(() => provider.generateVideo!({ prompt: "违规内容" }, context()));
  assert.equal(failedError.code, "video-failed");
  assert.equal(failedError.status, undefined);
  assert.match(failedError.message, /DataInspectionFailed/, "保留服务端安全错误码用于诊断");
  assert.equal(posts().length, 1, "失败的任务不会被重新提交");
  const failedJob = ledger.list(taskId).find(job => job.remoteId === "task-vid-2")!;
  assert.equal(failedJob.state, "failed");
  assert.equal(failedJob.waitState, "finished");
  assert.equal(failedJob.lastError, "video-failed");
  assert(!failedError.message.includes(KEY));

  /* ---------------------------------------------------------------- ⑥ HTTP 401 / 429 映射 */
  reset();
  route("POST", "/api/v1/services/aigc/text2image/image-synthesis", () => new Response("{}", { status: 401 }));
  const authError = await failure(() => generateImage({ prompt: "猫" }, context()));
  assert.equal(authError.code, "authentication");
  assert.equal(authError.status, 401);
  assert(!authError.message.includes(KEY));

  reset();
  route("POST", "/api/v1/services/aigc/video-generation/video-synthesis", () => new Response("{}", { status: 429 }));
  const rateError = await failure(() => provider.generateVideo!({ prompt: "猫" }, context()));
  assert.equal(rateError.code, "rate-limit");
  assert.match(rateError.message, /jobId=video-/, "拒绝信息带上本地 jobId 便于排查");
  assert.equal(ledger.list(taskId).filter(job => job.waitState === "finished" && job.state === "failed").length >= 1, true);
  assert.equal(calls.filter(call => call.method === "GET").length, 0, "被拒绝的提交不会再轮询");

  reset();
  route("POST", "/api/v1/services/aigc/text2image/image-synthesis", () => new Response("{}", { status: 500 }));
  const httpError = await failure(() => generateImage({ prompt: "猫" }, context()));
  assert.equal(httpError.code, "http");

  reset();
  route("POST", "/api/v1/services/aigc/text2image/image-synthesis", () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
  const parseError = await failure(() => generateImage({ prompt: "猫" }, context()));
  assert.equal(parseError.code, "response", "解析失败映射为 response，且不回显响应体");
  assert(!parseError.message.includes("not json"));

  /* ---------------------------------------------------------------- ⑦ 等待预算耗尽 → VideoJobPendingError，且不重提 */
  reset();
  let pendingPolls = 0;
  route("POST", "/api/v1/services/aigc/video-generation/video-synthesis", () => json({ output: { task_id: "task-vid-3", task_status: "PENDING" } }));
  route("GET", "/api/v1/tasks/task-vid-3", () => { pendingPolls += 1; return json({ output: { task_id: "task-vid-3", task_status: "RUNNING" } }); });
  const pendingError = await (async () => {
    try { await shortProvider.generateVideo!({ prompt: "还没跑完", aspectRatio: "9:16" }, context()); }
    catch (error) { if (error instanceof VideoJobPendingError) return error; throw error; }
    throw new Error("expected VideoJobPendingError");
  })();
  assert.equal(pendingError.reason, "pending");
  assert.equal(pendingError.remoteId, "task-vid-3");
  assert.match(pendingError.message, /not cancelled|cancelled|Resume|jobId=/, "提示远端未取消且可用 jobId 恢复");
  assert.equal(posts().length, 1, "本地超时绝不重提计费请求");
  const pausedJob = ledger.get(pendingError.jobId)!;
  assert.equal(pausedJob.waitState, "paused");
  assert.equal(pausedJob.state, "in_progress");
  const postsBeforeResume = posts().length;

  /* ---------------------------------------------------------------- ⑧ 恢复 jobId：只轮询，不 POST */
  reset();
  let resumePolls = 0;
  route("GET", "/api/v1/tasks/task-vid-3", () => {
    resumePolls += 1;
    return json({ output: { task_id: "task-vid-3", task_status: "SUCCEEDED", video_url: VIDEO_URL } });
  });
  route("GET", "/fixture.mp4", () => binary(mp4Bytes(), "video/mp4"));
  const resumed = await provider.generateVideo!({ jobId: pendingError.jobId }, context());
  assert.equal(posts().length, 0, "恢复流程不发出任何 POST");
  assert.equal(postsBeforeResume, 1);
  assert.equal(resumePolls, 1, "恢复只轮询已保存的远任务");
  assert.equal(resumed.items[0].mimeType, "video/mp4");
  assert.equal(ledger.get(pendingError.jobId)!.state, "completed");
  assert.equal(ledger.get(pendingError.jobId)!.remoteId, "task-vid-3");
  const resumeWithPrompt = await failure(() => provider.generateVideo!({ jobId: pendingError.jobId, prompt: "换一个提示词" }, context()));
  assert.equal(resumeWithPrompt.code, "unsupported", "恢复不允许替换参数");
  assert.equal(posts().length, 0);
  const otherTask = await failure(() => provider.generateVideo!({ jobId: pendingError.jobId }, context({ taskId: "task-other" })));
  assert.equal(otherTask.code, "policy", "别人的 job 不能被恢复");

  /* ---------------------------------------------------------------- ⑨ 不支持的字段/模型不发送任何请求 */
  reset();
  const unsupportedVideo = await failure(() => provider.generateVideo!({ prompt: "首帧动画", inputImagePath: "reference.png" }, context()));
  assert.equal(unsupportedVideo.code, "unsupported");
  const unsupportedModel = await failure(() => provider.generateVideo!({ prompt: "猫", model: "wan2.6-t2v" }, context()));
  assert.equal(unsupportedModel.code, "unsupported");
  const unsupportedRatio = await failure(() => generateImage({ prompt: "猫", aspectRatio: "21:9" }, context()));
  assert.equal(unsupportedRatio.code, "unsupported");
  const unsupportedReference = await failure(() => generateImage({ prompt: "猫", model: "wan2.5-t2i-preview", inputImagePaths: ["reference.png"] }, context()));
  assert.equal(unsupportedReference.code, "unsupported", "万相图片不支持参考图");
  const badCount = await failure(() => generateImage({ prompt: "猫", model: "qwen-image-2.0", count: 7 }, context()));
  assert.equal(badCount.code, "input");
  const badDuration = await failure(() => provider.generateVideo!({ prompt: "猫", durationSeconds: 30 }, context()));
  assert.equal(badDuration.code, "input");
  assert.equal(posts().length, 0, "所有入参错误都在离网阶段被拦下");

  /* ---------------------------------------------------------------- ⑩ 配置检查与凭据隔离 */
  reset();
  const testText = await provider.test!();
  assert.match(testText, /阿里云百炼/);
  assert(!testText.includes(KEY), "配置检查文案不含密钥");
  assert.equal(calls.length, 0, "test() 只做配置检查，不发送请求");

  const ledgerText = await readFile(ledger.path, "utf8");
  assert(!ledgerText.includes(KEY), "任务台账不保存任何凭据");
  assert(!ledgerText.includes("fixture-dashscope"), "任务台账不保存任何凭据");
  assert(!JSON.stringify(imageResult).includes(KEY));
  assert(!JSON.stringify(qwen).includes(KEY));
  assert(!JSON.stringify(videoResult).includes(KEY));
  assert.equal(errors.filter(message => message.includes(KEY)).length, 0, "错误文本不含密钥");
  assert.equal(unexpected.length, 0, `没有未被拦截的真实请求: ${unexpected.join(", ")}`);

  console.log("PASS DashScope provider: async image task, qwen sync edits, wan2.6 messages route, durable resumable video jobs, HTTP/credential safety");
} finally {
  await rm(root, { recursive: true, force: true });
}
