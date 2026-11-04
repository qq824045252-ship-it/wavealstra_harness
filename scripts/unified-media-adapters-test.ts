import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, VideoGenerateInput } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { VideoGenerationJobs, VideoJobPendingError } from "../src/main/capabilities/VideoGenerationJobs";
import { createApiMediaProvider } from "../src/main/capabilities/providers/ApiMediaProvider";
import { createApiOcrAdapter } from "../src/main/capabilities/providers/ApiOcrProvider";
import { createApiSpeechProvider } from "../src/main/capabilities/providers/ApiSpeechProvider";
import { normalizeApiBaseUrl, type ApiProviderOptions, type ResolvedApiConnection } from "../src/main/capabilities/providers/ApiServiceConnection";

interface RequestCapture { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer }
type Responder = (request: RequestCapture, response: ServerResponse) => void | Promise<void>;

async function fakeServer() {
  const requests: RequestCapture[] = [];
  let responder: Responder = (_request, response) => { response.writeHead(404); response.end(); };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const captured = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(captured);
      await responder(captured, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`, requests,
    respond(fn: Responder) { responder = fn; requests.length = 0; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
function binary(response: ServerResponse, bytes: Buffer, type: string): void {
  response.writeHead(200, { "content-type": type, "x-request-id": "fixture-request" }); response.end(bytes);
}
async function form(request: RequestCapture): Promise<FormData> {
  return new Request("http://fixture.invalid", { method: "POST", headers: { "content-type": String(request.headers["content-type"]) }, body: new Uint8Array(request.body) }).formData();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
async function pending(operation: Promise<unknown>): Promise<VideoJobPendingError> {
  try { await operation; }
  catch (error) { assert(error instanceof VideoJobPendingError); return error; }
  throw new Error("Expected a resumable video job");
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-api-adapters-"));
const taskRoot = join(root, "task");
await mkdir(taskRoot);
const server = await fakeServer();
const other = await fakeServer();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==", "base64");
const wav = Buffer.alloc(46);
wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
const video = Buffer.alloc(32);
video.writeUInt32BE(24); video.write("ftypisom", 4); video.write("isom", 16); video.write("mp42", 20); video.writeUInt32BE(8, 24); video.write("mdat", 28);
const imagePath = join(taskRoot, "private-reference-name.png"), webpPath = join(taskRoot, "reference.webp"), audioPath = join(taskRoot, "private-recording-name.wav");
await Promise.all([writeFile(imagePath, png), writeFile(webpPath, webp), writeFile(audioPath, wav), writeFile(join(root, "outside.png"), png)]);
const secret = "fixture-private-bearer-secret";
const connection: ResolvedApiConnection = { id: "service-original", label: "Fixture", baseUrl: `${server.origin}/v1`, headers: { Authorization: `Bearer ${secret}` }, timeoutMs: 2_000, protocol: "openai-compatible", model: "fixture-model" };
const options = (overrides: Partial<ApiProviderOptions> = {}): ApiProviderOptions => ({ getConnection: () => ({ ...connection }), ...overrides });
const context = (toolCallId: string, signal?: AbortSignal, taskId = "task-1"): ToolExecutionContext => ({ taskId, taskRoot, toolCallId, producerMessageId: "message-1", signal });
let count = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); count += 1; console.log(`PASS ${name}`); }

try {
  await check("image generation honors model/count/exact ratio and actual MIME", async () => {
    server.respond((_request, response) => json(response, { data: [{ b64_json: webp.toString("base64"), mime_type: "image/webp" }] }));
    const result = await createApiMediaProvider(options()).generateImage!({ prompt: "Draw a test square", aspectRatio: "16:9", model: "chosen-image-model" }, context("image"));
    const request = server.requests[0];
    assert.equal(request.path, "/v1/images/generations");
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(JSON.parse(request.body.toString()), { model: "chosen-image-model", prompt: "Draw a test square", n: 1, size: "1536x864" });
    assert.equal(result.items[0].mimeType, "image/webp");
    assert.deepEqual(Buffer.from(result.items[0].bytes!), webp);
    assert.equal(result.model, "chosen-image-model");
    assert(!JSON.stringify(result).includes(secret));
  });

  await check("image editing uses multipart reference bytes without local filenames", async () => {
    server.respond((_request, response) => json(response, { data: [{ b64_json: png.toString("base64") }] }));
    await createApiMediaProvider(options()).generateImage!({ prompt: "Combine these", inputImagePaths: [imagePath, webpPath], width: 1024, height: 1024 }, context("edit"));
    const request = server.requests[0], data = await form(request);
    assert.equal(request.path, "/v1/images/edits");
    assert.equal(data.get("model"), "fixture-model");
    assert.equal(data.get("size"), "1024x1024");
    assert.equal(data.getAll("image[]").length, 2);
    assert.deepEqual(Buffer.from(await (data.getAll("image[]")[0] as File).arrayBuffer()), png);
    assert(!request.body.toString().includes(taskRoot));
    assert(!request.body.toString().includes("private-reference-name"));
  });

  await check("unsupported image options and escaped task paths upload nothing", async () => {
    server.respond((_request, response) => json(response, { data: [{ b64_json: png.toString("base64") }] }));
    const provider = createApiMediaProvider(options());
    for (const input of [
      { prompt: "test", seed: 1 }, { prompt: "test", negativePrompt: "no red" }, { prompt: "test", width: 512 },
      { prompt: "test", width: 1024, height: 1024, aspectRatio: "16:9" }, { prompt: "test", count: 0 },
      { prompt: "test", inputImagePaths: [join(root, "outside.png")] }, { prompt: "test", aspectRatio: "7:3" },
    ]) await assert.rejects(provider.generateImage!(input, context("invalid-image")), /unsupported|input|policy/);
    assert.equal(server.requests.length, 0);
  });

  await check("same-origin media download authenticates only to the API and rejects redirects", async () => {
    server.respond((request, response) => request.path.endsWith("generations")
      ? json(response, { data: [{ url: `${server.origin}/v1/files/image/content` }] }) : binary(response, png, "image/png"));
    const result = await createApiMediaProvider(options()).generateImage!({ prompt: "test" }, context("download"));
    assert.deepEqual(Buffer.from(result.items[0].bytes!), png);
    assert.equal(server.requests[1].headers.authorization, `Bearer ${secret}`);
    other.respond((_request, response) => binary(response, png, "image/png"));
    server.respond((request, response) => {
      if (request.path.endsWith("generations")) json(response, { data: [{ url: `${server.origin}/v1/files/image/content` }] });
      else { response.writeHead(302, { location: `${other.origin}/stolen` }); response.end(); }
    });
    await assert.rejects(createApiMediaProvider(options()).generateImage!({ prompt: "test" }, context("redirect")), /transport/);
    assert.equal(other.requests.length, 0, "redirect must never receive credentials");
  });

  await check("external HTTPS media downloads omit all credentials and signed URLs from results", async () => {
    const signedUrl = "https://cdn.fixture.invalid/image.png?token=fixture-download-token";
    server.respond((_request, response) => json(response, { data: [{ url: signedUrl }] }));
    let externalCalls = 0;
    const provider = createApiMediaProvider(options({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async (url, init) => {
        if (String(url).startsWith("https://cdn.fixture.invalid/")) {
          externalCalls += 1;
          assert.equal(new Headers(init?.headers).get("authorization"), null);
          assert.equal(new Headers(init?.headers).get("x-private-header"), null);
          assert.equal(init?.redirect, "error");
          return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
        }
        return fetch(url, init);
      },
      getConnection: () => ({ ...connection, headers: { ...connection.headers, "x-private-header": secret } }),
    }));
    const result = await provider.generateImage!({ prompt: "test" }, context("public-download"));
    assert.equal(externalCalls, 1);
    assert(!JSON.stringify(result).includes("fixture-download-token"));
    assert(!JSON.stringify(result).includes(secret));
  });

  await check("external private/HTTP download URLs and invalid base URLs are rejected", async () => {
    for (const url of [`${other.origin}/image.png`, "https://127.0.0.1/secret", "https://localhost/secret", "https://name:secret@public.example/image.png"]) {
      server.respond((_request, response) => json(response, { data: [{ url }] }));
      await assert.rejects(createApiMediaProvider(options()).generateImage!({ prompt: "test" }, context("blocked-download")), /policy/);
    }
    assert.equal(other.requests.length, 0);
    for (const url of ["file:///tmp/test", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret"]) assert.throws(() => normalizeApiBaseUrl(url), /configuration/);
  });

  await check("ASR sends multipart/json basic transcript with explicit model and no invented segments", async () => {
    server.respond((_request, response) => json(response, { text: "测试 transcription", languages: [{ code: "zh" }] }));
    const result = await createApiSpeechProvider(options()).speechToText!({ audioPath, model: "chosen-asr-model", language: "zh", prompt: "洪彬" }, context("asr"));
    const request = server.requests[0], data = await form(request);
    assert.equal(request.path, "/v1/audio/transcriptions");
    assert.equal(data.get("model"), "chosen-asr-model");
    assert.equal(data.get("response_format"), "json");
    assert.equal(data.get("language"), "zh");
    assert.equal(data.get("prompt"), "洪彬");
    assert.deepEqual(Buffer.from(await (data.get("file") as File).arrayBuffer()), wav);
    assert(!request.body.toString().includes("private-recording-name"));
    assert.equal(result.text, "测试 transcription");
    assert.equal(result.language, "zh");
    assert.equal(result.segments, undefined);
  });

  await check("ASR validates actual bytes, malformed responses, and never retries failures", async () => {
    const malformed = join(taskRoot, "malformed.wav"); await writeFile(malformed, png);
    server.respond((_request, response) => json(response, { text: "ok" }));
    const provider = createApiSpeechProvider(options());
    await assert.rejects(provider.speechToText!({ audioPath: malformed }, context("bad-audio")), /format/);
    assert.equal(server.requests.length, 0);
    server.respond((_request, response) => json(response, { text: "x", segments: [{ start: 2, end: 1, text: "bad" }] }));
    await assert.rejects(provider.speechToText!({ audioPath }, context("bad-segments")), /segments/);
    assert.equal(server.requests.length, 1);
    server.respond((_request, response) => json(response, { error: `request rejected ${secret} https://user:password@example.com` }, 401));
    const error = await provider.speechToText!({ audioPath }, context("auth")).then(() => undefined, error => error as Error);
    assert.match(error!.message, /authentication/); assert(!error!.message.includes(secret)); assert(!error!.message.includes("password"));
    assert.equal(server.requests.length, 1, "billable request is not retried");
  });

  await check("ASR, OCR and video references cannot upload files outside the current task", async () => {
    const outsideAudio = join(root, "outside.wav"); await writeFile(outsideAudio, wav);
    server.respond((_request, response) => json(response, {}));
    const store = new VideoGenerationJobs(join(root, "video-outside.json"));
    await assert.rejects(createApiSpeechProvider(options()).speechToText!({ audioPath: outsideAudio }, context("asr-outside")), /policy/);
    await assert.rejects(createApiOcrAdapter(options()).recognize(join(root, "outside.png"), context("ocr-outside")), /policy/);
    await assert.rejects(createApiMediaProvider({ ...options(), jobStore: store }).generateVideo!({ prompt: "test", inputImagePath: join(root, "outside.png") }, context("video-outside")), /policy/);
    assert.equal(store.list().length, 0);
    assert.equal(server.requests.length, 0);
  });

  await check("request timeouts and cancellation stop waiting with redacted errors", async () => {
    server.respond(() => {});
    const short = createApiSpeechProvider(options({ getConnection: () => ({ ...connection, timeoutMs: 30 }) }));
    await assert.rejects(short.speechToText!({ audioPath }, context("timeout")), /timeout/);
    const entered = deferred(); server.respond(() => entered.resolve());
    const controller = new AbortController();
    const request = createApiSpeechProvider(options()).speechToText!({ audioPath }, context("cancel", controller.signal));
    await entered.promise; controller.abort(secret);
    await assert.rejects(request, error => error instanceof Error && /cancelled/.test(error.message) && !error.message.includes(secret));
    const before = server.requests.length;
    await assert.rejects(short.speechToText!({ audioPath }, context("pre-cancel", controller.signal)), /cancelled/);
    assert.equal(server.requests.length, before);
  });

  await check("TTS maps model/voice/rate/output format and returns actual audio", async () => {
    server.respond((_request, response) => binary(response, wav, "audio/wav"));
    const result = await createApiSpeechProvider(options()).textToSpeech!({ text: "Hello", model: "chosen-tts-model", voice: "fixture-voice", rate: "+25%", format: "wav" }, context("tts"));
    assert.equal(server.requests[0].path, "/v1/audio/speech");
    assert.deepEqual(JSON.parse(server.requests[0].body.toString()), { model: "chosen-tts-model", input: "Hello", voice: "fixture-voice", speed: 1.25, response_format: "wav" });
    assert.deepEqual(Buffer.from(result.items[0].bytes!), wav);
    assert.equal(result.items[0].mimeType, "audio/wav");
    assert.equal(result.requestId, "fixture-request");
  });

  await check("TTS refuses missing voice, invalid rates, SSE/JSON and wrong audio format", async () => {
    server.respond((_request, response) => binary(response, wav, "audio/wav"));
    const provider = createApiSpeechProvider(options());
    await assert.rejects(provider.textToSpeech!({ text: "Hello" }, context("tts-no-voice")), /voice/);
    for (const rate of ["fast", "0.1", "10x", "-100%", "NaN"]) await assert.rejects(provider.textToSpeech!({ text: "Hello", voice: "alloy", rate }, context("tts-rate")), /rate/);
    assert.equal(server.requests.length, 0);
    await assert.rejects(provider.textToSpeech!({ text: "Hello", voice: "alloy", format: "mp3" }, context("tts-wrong-format")), /requested format/);
    for (const type of ["application/json", "text/event-stream"]) {
      server.respond((_request, response) => { response.writeHead(200, { "content-type": type }); response.end(`data: ${secret}`); });
      await assert.rejects(provider.textToSpeech!({ text: "Hello", voice: "alloy" }, context("tts-non-audio")), /did not return audio bytes/);
    }
  });

  await check("vision OCR sends image data and returns text without fabricated pixel boxes", async () => {
    server.respond((_request, response) => json(response, { choices: [{ finish_reason: "stop", message: { content: "invoice 12.50", boxes: [{ x: 1 }] } }] }));
    const result = await createApiOcrAdapter(options()).recognize(imagePath, context("ocr"));
    const request = server.requests[0], body = JSON.parse(request.body.toString());
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(body.model, "fixture-model"); assert.equal(body.stream, false);
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
    assert.deepEqual(result, { text: "invoice 12.50" });
    server.respond((_request, response) => json(response, { choices: [{ finish_reason: "length", message: { content: "truncated" } }] }));
    await assert.rejects(createApiOcrAdapter(options()).recognize(imagePath, context("truncated-ocr")), /incomplete/);
  });

  await check("Mistral OCR uses the OCR endpoint, preserves page text, and does not mislabel image-region boxes", async () => {
    server.respond((_request, response) => json(response, { pages: [{ markdown: "# One", images: [{ top_left_x: 1 }] }, { markdown: "Two" }] }));
    const result = await createApiOcrAdapter(options({ getConnection: () => ({ ...connection, protocol: "mistral-ocr", model: "ocr-model" }) })).recognize(imagePath, context("mistral"));
    assert.equal(server.requests[0].path, "/v1/ocr");
    const body = JSON.parse(server.requests[0].body.toString());
    assert.equal(body.model, "ocr-model"); assert.equal(body.document.type, "image_url");
    assert.equal(body.include_image_base64, false);
    assert.deepEqual(result, { text: "# One\n\nTwo" });
  });

  await check("all API families require their configured model and reject incompatible protocols without a request", async () => {
    server.respond((_request, response) => json(response, {}));
    const absent = options({ getConnection: () => ({ ...connection, model: undefined }) });
    await assert.rejects(createApiMediaProvider(absent).generateImage!({ prompt: "test" }, context("missing-image-model")), /model/);
    await assert.rejects(createApiSpeechProvider(absent).speechToText!({ audioPath }, context("missing-asr-model")), /model/);
    await assert.rejects(createApiSpeechProvider(absent).textToSpeech!({ text: "test", voice: "alloy" }, context("missing-tts-model")), /model/);
    await assert.rejects(createApiOcrAdapter(absent).recognize(imagePath, context("missing-ocr-model")), /model/);
    const wrong = options({ getConnection: () => ({ ...connection, protocol: "mistral-ocr" }) });
    await assert.rejects(createApiMediaProvider(wrong).generateImage!({ prompt: "test" }, context("wrong-protocol")), /OCR/);
    assert.equal(server.requests.length, 0);
    assert.equal(createApiMediaProvider(options()).generateVideo, undefined, "video is not exposed without durable storage");
  });

  await check("video create/poll/content persists ownership and reference metadata before polling", async () => {
    const store = new VideoGenerationJobs(join(root, "video-normal.json"));
    let polls = 0;
    server.respond((request, response) => {
      if (request.method === "POST") json(response, { id: "remote_video_1", status: "queued" });
      else if (request.path.endsWith("/content")) binary(response, video, "video/mp4");
      else { polls += 1; json(response, { id: "remote_video_1", status: polls === 1 ? "in_progress" : "completed" }); }
    });
    const provider = createApiMediaProvider({ ...options(), jobStore: store, polling: { intervalMs: 1, maxWaitMs: 2_000 } });
    const result = await provider.generateVideo!({ prompt: "private video prompt", model: "video-model", durationSeconds: 4, resolution: "720p", aspectRatio: "16:9", inputImagePath: imagePath }, context("video-normal"));
    const create = server.requests[0], data = await form(create);
    assert.equal(create.path, "/v1/videos"); assert.equal(data.get("seconds"), "4"); assert.equal(data.get("size"), "1280x720");
    assert.equal(data.get("model"), "video-model"); assert.deepEqual(Buffer.from(await (data.get("input_reference") as File).arrayBuffer()), png);
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1);
    assert.deepEqual(Buffer.from(result.items[0].bytes!), video);
    const [job] = new VideoGenerationJobs(store.path).list("task-1");
    assert.equal(result.provider, connection.id); assert.equal(result.metadata?.jobId, job.id);
    assert.equal(job.state, "completed"); assert.equal(job.waitState, "finished"); assert.equal(job.toolCallId, "video-normal");
    assert.equal(job.producerMessageId, "message-1"); assert.equal(job.connection.model, "video-model");
    const disk = await readFile(store.path, "utf8");
    assert(!disk.includes(secret)); assert(!disk.includes("Authorization")); assert(!disk.includes("private video prompt")); assert(!disk.includes(png.toString("base64")));
  });

  await check("bounded video polling returns a durable job; restart and auth rotation resume without another POST", async () => {
    const path = join(root, "video-resume.json"), store = new VideoGenerationJobs(path);
    server.respond((_request, response) => json(response, { id: "remote_resume", status: "queued" }));
    const provider = createApiMediaProvider({ ...options(), jobStore: store, polling: { intervalMs: 1, maxAttempts: 1, maxWaitMs: 500 } });
    const error = await pending(provider.generateVideo!({ prompt: "one paid submission", model: "original-model" }, context("video-pending")));
    assert.equal(error.reason, "pending"); assert.equal(store.get(error.jobId)?.waitState, "paused");
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1);
    const requestedIds: Array<string | undefined> = [];
    const requestsBefore = server.requests.length;
    server.respond((request, response) => request.path.endsWith("/content") ? binary(response, video, "video/mp4") : json(response, { id: "remote_resume", status: "completed" }));
    const resumed = createApiMediaProvider({
      ...options({ id: "later-selected-provider", getConnection: id => { requestedIds.push(id); return { ...connection, model: "later-default-model", headers: { Authorization: "Bearer rotated-fixture-key" } }; } }),
      jobStore: new VideoGenerationJobs(path), polling: { intervalMs: 1, maxWaitMs: 1_000 },
    });
    const result = await resumed.generateVideo!({ jobId: error.jobId }, context("video-resumed"));
    assert(requestsBefore > 0); assert.deepEqual(requestedIds, [connection.id]);
    assert.equal(server.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(server.requests[0].headers.authorization, "Bearer rotated-fixture-key");
    assert.equal(result.model, "original-model"); assert.equal(result.provider, connection.id);
    assert.equal(store.get(error.jobId)?.toolCallId, "video-pending"); assert.equal(store.get(error.jobId)?.lastToolCallId, "video-resumed");
  });

  await check("video resume rejects another task, altered connection, and replacement parameters before HTTP", async () => {
    const store = new VideoGenerationJobs(join(root, "video-resume.json"));
    const job = store.list()[0]; server.respond((_request, response) => json(response, {}));
    const base = { ...options(), jobStore: store };
    await assert.rejects(createApiMediaProvider(base).generateVideo!({ jobId: job.id }, context("cross-task", undefined, "task-2")), /does not belong/);
    for (const changed of [{ id: "different" }, { baseUrl: `${other.origin}/v1` }, { protocol: "magpie" as const }]) {
      await assert.rejects(createApiMediaProvider({ ...base, getConnection: () => ({ ...connection, ...changed }) }).generateVideo!({ jobId: job.id }, context("wrong-service")), /original|resume/);
    }
    await assert.rejects(createApiMediaProvider(base).generateVideo!({ jobId: job.id, prompt: "replace" }, context("replacement")), /unsupported/);
    assert.equal(server.requests.length, 0); assert.equal(other.requests.length, 0);
  });

  await check("completed video with a failed download resumes only content retrieval", async () => {
    const store = new VideoGenerationJobs(join(root, "video-content.json"));
    server.respond((request, response) => request.method === "POST" ? json(response, { id: "remote_content", status: "completed" }) : json(response, { error: secret }, 503));
    const provider = createApiMediaProvider({ ...options(), jobStore: store });
    const error = await pending(provider.generateVideo!({ prompt: "ready" }, context("video-content")));
    assert.equal(error.reason, "http"); assert.equal(store.get(error.jobId)?.state, "completed"); assert(!error.message.includes(secret));
    server.respond((_request, response) => binary(response, video, "video/mp4"));
    await createApiMediaProvider({ ...options(), jobStore: new VideoGenerationJobs(store.path) }).generateVideo!({ jobId: error.jobId }, context("content-retry"));
    assert.deepEqual(server.requests.map(request => `${request.method} ${request.path}`), ["GET /v1/videos/remote_content/content"]);
  });

  await check("cancelling a wait preserves the remote video and never sends a remote cancellation", async () => {
    const store = new VideoGenerationJobs(join(root, "video-cancel.json")), entered = deferred();
    server.respond((request, response) => {
      if (request.method === "POST") json(response, { id: "remote_cancel", status: "queued" });
      else { entered.resolve(); }
    });
    const controller = new AbortController();
    const provider = createApiMediaProvider({ ...options(), jobStore: store, polling: { intervalMs: 1 } });
    const operation = provider.generateVideo!({ prompt: "do not duplicate" }, context("video-cancel", controller.signal));
    await entered.promise; controller.abort(secret);
    const error = await pending(operation);
    assert.equal(error.reason, "cancelled"); assert.equal(store.get(error.jobId)?.state, "queued"); assert.equal(store.get(error.jobId)?.waitState, "paused");
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1);
    assert(server.requests.every(request => (request.method === "POST" && request.path === "/v1/videos") || (request.method === "GET" && request.path === "/v1/videos/remote_cancel")));
    assert(!error.message.includes(secret));
    server.respond((request, response) => request.path.endsWith("/content") ? binary(response, video, "video/mp4") : json(response, { id: "remote_cancel", status: "completed" }));
    await provider.generateVideo!({ jobId: error.jobId }, context("cancel-resume"));
    assert.equal(server.requests.filter(request => request.method === "POST").length, 0);
  });

  await check("video poll timeout is resumable and does not resubmit", async () => {
    const store = new VideoGenerationJobs(join(root, "video-timeout.json"));
    server.respond((request, response) => { if (request.method === "POST") json(response, { id: "remote_timeout", status: "queued" }); });
    const provider = createApiMediaProvider({ ...options({ getConnection: () => ({ ...connection, timeoutMs: 35 }) }), jobStore: store, polling: { intervalMs: 1, maxWaitMs: 500 } });
    const error = await pending(provider.generateVideo!({ prompt: "test" }, context("video-timeout")));
    assert.equal(error.reason, "timeout"); assert.equal(store.get(error.jobId)?.remoteId, "remote_timeout");
    server.respond((request, response) => request.path.endsWith("/content") ? binary(response, video, "video/mp4") : json(response, { id: "remote_timeout", status: "completed" }));
    await provider.generateVideo!({ jobId: error.jobId }, context("timeout-resume"));
    assert.equal(server.requests.filter(request => request.method === "POST").length, 0);
  });

  await check("ambiguous video submission persists intent and is never replayed after restart", async () => {
    const store = new VideoGenerationJobs(join(root, "video-unknown.json"));
    server.respond((_request, response) => { response.destroy(); });
    const provider = createApiMediaProvider({ ...options(), jobStore: store });
    const input = { prompt: "one request only" };
    const error = await pending(provider.generateVideo!(input, context("video-unknown")));
    assert.equal(error.reason, "submission-unknown"); assert.equal(store.get(error.jobId)?.remoteId, undefined);
    assert.equal(store.get(error.jobId)?.state, "submission-unknown");
    const before = server.requests.length;
    const restarted = createApiMediaProvider({ ...options(), jobStore: new VideoGenerationJobs(store.path) });
    await assert.rejects(restarted.generateVideo!({ jobId: error.jobId }, context("unknown-resume")), /submission-unknown/);
    await assert.rejects(restarted.generateVideo!(input, context("video-unknown")), /submission-unknown/);
    await assert.rejects(restarted.generateVideo!({ prompt: "changed" }, context("video-unknown")), /conflict/);
    assert.equal(server.requests.length, before);
  });

  await check("video validation and a corrupt ledger cannot trigger a paid submission", async () => {
    const store = new VideoGenerationJobs(join(root, "video-validation.json"));
    const provider = createApiMediaProvider({ ...options(), jobStore: store });
    server.respond((_request, response) => json(response, { id: "should_not_exist", status: "queued" }));
    for (const input of [{}, { prompt: "x", negativePrompt: "y" }, { prompt: "x", seed: 2 }, { prompt: "x", generateAudio: false }, { prompt: "x", durationSeconds: 1.5 }, { prompt: "x", resolution: "huge" }] as VideoGenerateInput[]) {
      await assert.rejects(provider.generateVideo!(input, context("video-invalid")), /input|unsupported/);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(provider.generateVideo!({ prompt: "x" }, context("video-pre-abort", controller.signal)), /cancelled/);
    assert.equal(store.list().length, 0);
    await writeFile(store.path, "{");
    await assert.rejects(provider.generateVideo!({ prompt: "x" }, context("video-corrupt")), /ledger/);
    assert.equal(await readFile(store.path, "utf8"), "{");
    assert.equal(server.requests.length, 0);
  });

  await check("rejected video jobs and terminal failures do not restart automatically", async () => {
    const store = new VideoGenerationJobs(join(root, "video-failed.json"));
    const provider = createApiMediaProvider({ ...options(), jobStore: store, polling: { intervalMs: 1 } });
    server.respond((_request, response) => json(response, { error: secret }, 403));
    await assert.rejects(provider.generateVideo!({ prompt: "x" }, context("video-rejected")), /authentication/);
    const job = store.list()[0]; assert.equal(job.state, "failed");
    const before = server.requests.length;
    await assert.rejects(provider.generateVideo!({ prompt: "x" }, context("video-rejected")), /submission-unknown|video-failed/);
    assert.equal(server.requests.length, before);
    server.respond((request, response) => json(response, { id: "remote_failed", status: request.method === "POST" ? "queued" : "failed", error: { message: secret } }));
    await assert.rejects(provider.generateVideo!({ prompt: "y" }, context("video-remote-failed")), error => error instanceof Error && /video-failed/.test(error.message) && !error.message.includes(secret));
    assert(!server.requests.some(request => request.path.endsWith("/content")));
  });

  console.log(`Unified media adapters: ${count} behavior checks passed.`);
} finally {
  await Promise.all([server.close(), other.close()]);
  await rm(root, { recursive: true, force: true });
}
