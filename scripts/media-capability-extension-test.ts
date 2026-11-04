import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import { BUILTIN_CODEX_IMAGE_MODEL, DEFAULT_BUILTIN_CAPABILITIES_CONFIG, type BuiltinCapabilitiesConfigDto } from "../src/shared/builtin-capabilities";
import type { MediaCapabilityId } from "../src/shared/media-capabilities";
import { BuiltinCapabilityRuntime, type ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import { VideoGenerationJobs, type VideoGenerationJob } from "../src/main/capabilities/VideoGenerationJobs";

interface ToolResult { isError?: boolean; details?: unknown; content?: Array<{ type: string; text?: string }> }
interface Tool {
  name: string;
  execute(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}
interface RequestCapture { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }
interface ArtifactFixture {
  register(input: { taskId: string; workspaceFile: { entryFile: string; rootDir: string }; kind: ArtifactDescriptor["kind"]; mimeType: string }): Promise<ArtifactDescriptor>;
  remove(id: string): void;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const MP4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703431", "hex");
const ORIGINAL_KEY = "extension-fixture-original-key";
const OTHER_KEY = "extension-fixture-other-key";

function clone<T>(value: T): T { return structuredClone(value); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function content(result: ToolResult): string { return result.content?.map(item => item.text ?? "").join("\n") ?? ""; }
function detail(result: ToolResult): Record<string, unknown> { assert(result.details && typeof result.details === "object"); return result.details as Record<string, unknown>; }
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, key)) return object[key];
  for (const child of Object.values(object)) { const found = field(child, key); if (found !== undefined) return found; }
  return undefined;
}

/** Real tool registration, runtime routing, API adapter and materializer; only external systems are fakes. */
class Fixture {
  readonly taskId = `task-${randomUUID()}`;
  readonly root: string;
  readonly taskRoot: string;
  config: BuiltinCapabilitiesConfigDto = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  readonly requests: RequestCapture[] = [];
  readonly jobs: VideoGenerationJobs;
  readonly runtime: BuiltinCapabilityRuntime;
  readonly manager: MediaCapabilityServices;
  artifact: ArtifactFixture | null = null;
  customVideoCalls = 0;
  readonly keys = new Map([["original-key-ref", ORIGINAL_KEY], ["other-key-ref", OTHER_KEY]]);
  respond: (request: RequestCapture) => Response | Promise<Response> = () => { throw new Error("unexpected fixture HTTP request"); };

  constructor(parent: string) {
    this.root = mkdtempSync(join(parent, "fixture-"));
    this.taskRoot = join(this.root, "task"); mkdirSync(this.taskRoot);
    this.jobs = new VideoGenerationJobs(join(this.root, "jobs.json"));
    this.config.web.enabled = false;
    this.config.vision.enabled = false;
    this.config.browser.enabled = false;
    this.config.diagnostics = { enabled: false };
    this.config.execution = { terminalEnabled: false, codeExecutionEnabled: false };
    this.config.subagent.enabled = false;
    this.config.multiModelConsult.enabled = false;
    this.config.speechToText.enabled = false;
    this.config.ocr = { enabled: false };
    this.config.imageGeneration.enabled = true;
    this.config.videoGeneration = { enabled: true, model: "old-video-model" };
    this.config.textToSpeech = { enabled: true, model: "old-speech-model", voice: "fixture-voice" };
    this.config.connections = {
      "api-original": { name: "Original", baseUrl: "https://original.fixture.invalid/v1", protocol: "openai-compatible", auth: "api-key", credentialRef: "original-key-ref", timeoutMs: 5_000 },
      "api-other": { name: "Other", baseUrl: "https://other.fixture.invalid/v1", protocol: "openai-compatible", auth: "api-key", credentialRef: "other-key-ref", timeoutMs: 5_000 },
    };
    this.config.mediaBindings = {
      "image-generation": { connectionId: "api-original", selection: "manual" },
      "video-generation": { connectionId: "api-original", selection: "manual" },
      "text-to-speech": { connectionId: "api-original", selection: "manual" },
    };
    this.runtime = new BuiltinCapabilityRuntime({
      store: { read: () => clone(this.config), write: next => { this.config = clone(next); return clone(next); } },
      credentials: { has: id => this.keys.has(id), get: id => this.keys.get(id) ?? null, set: (id, value) => { this.keys.set(id, value); }, clear: id => { this.keys.delete(id); } },
    });
    this.runtime.registerProvider("media", {
      id: "custom-video", label: "Legacy custom video",
      generateVideo: async () => { this.customVideoCalls += 1; return { provider: "custom-video", model: "custom-model", items: [{ bytes: MP4, mimeType: "video/mp4" }] }; },
    });
    this.manager = new MediaCapabilityServices({
      runtime: this.runtime, videoJobs: this.jobs, getMagpieConfig: () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const request = { url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
        this.requests.push(request);
        return this.respond(request);
      }) as typeof fetch,
    });
    this.runtime.attachMediaServices(this.manager);
  }

  bind(id: MediaCapabilityId, connectionId: string, model?: string): void {
    this.config.mediaBindings ??= {};
    this.config.mediaBindings[id] = { connectionId, model, selection: "manual" };
  }

  context(toolCallId: string, signal?: AbortSignal): ToolExecutionContext {
    return { taskId: this.taskId, taskRoot: this.taskRoot, toolCallId, producerMessageId: "fixture-message", signal };
  }

  tools(taskId = this.taskId): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    const api = {
      registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: () => undefined,
      registerShortcut: () => undefined, on: () => undefined, appendEntry: () => undefined,
      sendMessage: () => undefined, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as unknown as ExtensionAPI;
    createBuiltinCapabilityExtension({
      taskId, taskRoot: this.taskRoot, runtime: this.runtime, nativeExecution: true,
      browser: { available: false } as never, artifactService: () => this.artifact as never,
      getProducerMessageId: () => "fixture-message", getIsolationLevel: () => "guarded",
    })(api);
    return tools;
  }

  seedVideo(state: "queued" | "completed" = "completed"): VideoGenerationJob {
    const now = Date.now();
    const job: VideoGenerationJob = {
      id: `video-${randomUUID()}`, remoteId: `remote_${randomUUID().replace(/-/g, "")}`,
      taskId: this.taskId, toolCallId: `submit-${randomUUID()}`, lastToolCallId: "interrupted-wait", producerMessageId: "original-message",
      connection: { id: "api-original", label: "Original", baseUrl: "https://original.fixture.invalid/v1", protocol: "openai-compatible", model: "original-video-model", timeoutMs: 5_000 },
      requestDigest: "a".repeat(64), state, waitState: "paused", createdAt: now, updatedAt: now,
    };
    this.jobs.put(job);
    return job;
  }

  serveVideo(job: VideoGenerationJob): void {
    this.respond = request => {
      assert.equal(request.method, "GET", "resuming a job must not POST another generation");
      assert.equal(new URL(request.url).origin, "https://original.fixture.invalid");
      assert.equal(request.headers.get("authorization"), `Bearer ${ORIGINAL_KEY}`);
      if (request.url.endsWith(`/videos/${job.remoteId}/content`)) return new Response(new Uint8Array(MP4), { headers: { "content-type": "video/mp4" } });
      assert(request.url.endsWith(`/videos/${job.remoteId}`));
      return json({ id: job.remoteId, status: "completed" });
    };
  }
}

function requiredTool(tools: Map<string, Tool>, name: string): Tool {
  const tool = tools.get(name); assert(tool, `${name} must remain registered for this fixture`); return tool;
}
function assertOriginalDownloads(fixture: Fixture, result: ToolResult, job: VideoGenerationJob): void {
  assert.notEqual(result.isError, true, content(result));
  assert(fixture.requests.length > 0);
  assert(fixture.requests.every(request => request.method === "GET" && request.url.startsWith("https://original.fixture.invalid/v1/videos/")));
  assert.equal(detail(result).provider, "api-original");
  assert.equal(detail(result).model, "original-video-model");
  assert.equal(field(result.details, "jobId"), job.id);
  const paths = detail(result).items as string[];
  assert.equal(paths.length, 1); assert(existsSync(paths[0]));
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-media-extension-"));
const originalFetch = globalThis.fetch;
let unintendedNetwork = 0;
globalThis.fetch = (async () => { unintendedNetwork += 1; throw new Error("external network is disabled in the extension fixture"); }) as typeof fetch;
let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); passed += 1; console.log(`PASS ${name}`); }

try {
  await check("new image/video/TTS bindings without models cannot inherit legacy defaults", async () => {
    const f = new Fixture(root), tools = f.tools();
    assert.equal(f.config.imageGeneration.model, BUILTIN_CODEX_IMAGE_MODEL, "the old default remains present to expose accidental fallback");
    f.respond = request => request.url.endsWith("/images/generations") ? json({ data: [{ b64_json: PNG.toString("base64") }] }) : json({ id: "wrong_job", status: "completed" });
    for (const [name, input] of [
      ["image_generate", { prompt: "fixture image" }], ["video_generate", { prompt: "fixture video" }], ["text_to_speech", { text: "fixture speech" }],
    ] as const) {
      const result = await requiredTool(tools, name).execute(`missing-${name}`, input);
      assert.equal(result.isError, true, `${name} must require the selected service's model`);
      assert.match(content(result), /model|模型/);
    }
    assert.equal(f.requests.length, 0); assert.equal(f.jobs.list().length, 0);
  });

  await check("an explicit image model is honored while a missing model never uses the prior service", async () => {
    const f = new Fixture(root), tool = requiredTool(f.tools(), "image_generate");
    f.respond = () => json({ data: [{ b64_json: PNG.toString("base64") }] });
    const result = await tool.execute("explicit-image-model", { prompt: "fixture image", model: "intentional-image-model" });
    assert.notEqual(result.isError, true, content(result));
    assert.equal(JSON.parse(String(f.requests[0].body)).model, "intentional-image-model");
    f.requests.length = 0;
    f.bind("image-generation", "api-other");
    const missing = await tool.execute("changed-image-service", { prompt: "fixture image" });
    assert.equal(missing.isError, true); assert.equal(f.requests.length, 0);
  });

  await check("an existing tool uses the latest explicit service/model selection", async () => {
    const f = new Fixture(root); f.bind("image-generation", "api-original", "original-image-model");
    const tool = requiredTool(f.tools(), "image_generate");
    f.bind("image-generation", "api-other", "changed-image-model");
    f.respond = () => json({ data: [{ b64_json: PNG.toString("base64") }] });
    const result = await tool.execute("fresh-selection", { prompt: "fixture" });
    assert.notEqual(result.isError, true, content(result));
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "https://other.fixture.invalid/v1/images/generations");
    assert.equal(JSON.parse(String(f.requests[0].body)).model, "changed-image-model");
    assert.equal(f.requests[0].headers.get("authorization"), `Bearer ${OTHER_KEY}`);
  });

  await check("legacy image selection still receives its original model when no binding exists", async () => {
    const f = new Fixture(root); let receivedModel: string | undefined;
    delete f.config.mediaBindings!["image-generation"];
    f.config.imageGeneration.provider = "legacy-image"; f.config.imageGeneration.model = "legacy-image-model";
    f.runtime.registerProvider("media", { id: "legacy-image", label: "Legacy image", generateImage: async input => {
      receivedModel = input.model; return { provider: "legacy-image", model: input.model, items: [{ bytes: PNG, mimeType: "image/png" }] };
    } });
    const result = await requiredTool(f.tools(), "image_generate").execute("legacy-image", { prompt: "fixture" });
    assert.notEqual(result.isError, true, content(result)); assert.equal(receivedModel, "legacy-image-model"); assert.equal(f.requests.length, 0);
  });

  await check("video recovery ignores the current custom provider and keeps original ownership", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    f.bind("video-generation", "registered:custom-video", "custom-default");
    f.config.videoGeneration.provider = "custom-video";
    const result = await requiredTool(f.tools(), "video_generate").execute("resume-custom-selected", { job_id: job.id });
    assertOriginalDownloads(f, result, job); assert.equal(f.customVideoCalls, 0);
    assert.equal(f.jobs.get(job.id)?.toolCallId, job.toolCallId);
    assert.equal(f.jobs.get(job.id)?.lastToolCallId, "resume-custom-selected");
    f.requests.length = 0;
    const direct = await f.runtime.videoProvider()!.generateVideo!({ jobId: job.id }, f.context("direct-wrapper-resume"));
    assert.equal(direct.provider, "api-original"); assert.equal(f.customVideoCalls, 0);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "GET");
  });

  await check("a saved video job remains recoverable with no current generation binding", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    f.bind("video-generation", ""); f.config.videoGeneration.provider = undefined;
    assert.equal(f.runtime.videoProvider(), null);
    const tool = requiredTool(f.tools(), "video_generate");
    const result = await tool.execute("resume-without-selection", { job_id: job.id });
    assertOriginalDownloads(f, result, job);
    const before = f.requests.length;
    const newGeneration = await tool.execute("new-without-selection", { prompt: "new job" });
    assert.equal(newGeneration.isError, true); assert.equal(f.requests.length, before);
    assert(!f.tools("another-task").has("video_generate"), "another task's jobs do not expose a recovery-only tool");
  });

  await check("queued job recovery uses only original GET routes and does not mark the new service ready", async () => {
    const f = new Fixture(root), job = f.seedVideo("queued"); f.serveVideo(job);
    f.bind("video-generation", "api-other", "new-video-model");
    assert.equal(f.manager.status("video-generation").state, "unchecked");
    const result = await requiredTool(f.tools(), "video_generate").execute("resume-queued", { job_id: job.id });
    assertOriginalDownloads(f, result, job);
    assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), [`/v1/videos/${job.remoteId}`, `/v1/videos/${job.remoteId}/content`]);
    assert.equal(f.manager.status("video-generation").state, "unchecked", "retrieving an old job is not proof the newly selected service works");
  });

  await check("video recovery rejects another task, disabled capability and a removed original connection", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    f.bind("video-generation", "api-other", "new-video-model");
    const ownTool = requiredTool(f.tools(), "video_generate"), otherTool = requiredTool(f.tools("another-task"), "video_generate");
    const wrongTask = await otherTool.execute("other-task", { job_id: job.id });
    assert.equal(wrongTask.isError, true); assert.match(content(wrongTask), /task|任务|policy/);
    f.config.videoGeneration.enabled = false;
    const disabled = await ownTool.execute("disabled-resume", { job_id: job.id });
    assert.equal(disabled.isError, true); assert(!f.tools().has("video_generate"));
    f.config.videoGeneration.enabled = true; delete f.config.connections!["api-original"];
    const disconnected = await ownTool.execute("removed-original", { job_id: job.id });
    assert.equal(disconnected.isError, true);
    assert.equal(f.requests.length, 0); assert.equal(f.customVideoCalls, 0);
  });

  await check("job_id cannot silently ignore new-generation parameters including false and empty values", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    const tool = requiredTool(f.tools(), "video_generate");
    for (const extra of [{ prompt: "" }, { model: "replacement" }, { duration_seconds: 4 }, { seed: 0 }, { generate_audio: false }, { input_image_path: "missing.png" }]) {
      const result = await tool.execute(`invalid-resume-${Object.keys(extra)[0]}`, { job_id: job.id, ...extra });
      assert.equal(result.isError, true, `${Object.keys(extra)[0]} must not be ignored by recovery`);
    }
    assert.equal(f.requests.length, 0); assert.equal(f.jobs.get(job.id)?.lastToolCallId, "interrupted-wait");
  });

  await check("materializer rollback failure retains structured artifact evidence and the video job", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    const controller = new AbortController();
    let retainedPath = "", removedId = "";
    f.artifact = {
      register: async input => {
        retainedPath = input.workspaceFile.entryFile;
        const artifact: ArtifactDescriptor = { id: "retained-video-artifact", taskId: input.taskId, kind: input.kind, version: 1,
          source: { type: "workspace-file", entryFile: retainedPath, rootDir: input.workspaceFile.rootDir },
          mimeType: input.mimeType, capabilities: {}, createdAt: Date.now(), updatedAt: Date.now() };
        controller.abort(new Error("fixture cancellation after artifact registration"));
        return artifact;
      },
      remove: id => { removedId = id; throw new Error("fixture database rollback failure"); },
    };
    const result = await requiredTool(f.tools(), "video_generate").execute("partial-artifact", { job_id: job.id }, controller.signal);
    assert.equal(result.isError, true); assert.equal(removedId, "retained-video-artifact");
    assert(retainedPath && existsSync(retainedPath), "a retained artifact still owns its file");
    assert.deepEqual(field(result.details, "retainedArtifactIds"), ["retained-video-artifact"]);
    assert.deepEqual(field(result.details, "retainedPaths"), [retainedPath]);
    assert.equal(field(result.details, "jobId"), job.id);
    assert.equal(field(result.details, "remoteCancelled"), false);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "GET");
  });

  await check("ordinary artifact save failure returns a recoverable job without another video POST", async () => {
    const f = new Fixture(root), job = f.seedVideo(); f.serveVideo(job);
    f.artifact = { register: async () => { throw new Error("fixture artifact registration failed"); }, remove: () => undefined };
    const tool = requiredTool(f.tools(), "video_generate");
    const failed = await tool.execute("artifact-save-failure", { job_id: job.id });
    assert.equal(failed.isError, true); assert.equal(field(failed.details, "jobId"), job.id);
    assert.equal(field(failed.details, "remoteCancelled"), false);
    assert.deepEqual(readdirSync(join(f.taskRoot, "generated", "video")), [], "failed registration rolls back the workspace file");
    f.artifact = null; f.requests.length = 0;
    const result = await tool.execute("artifact-save-recovery", { job_id: job.id });
    assertOriginalDownloads(f, result, job);
    assert.deepEqual(f.requests.map(request => `${request.method} ${new URL(request.url).pathname}`), [`GET /v1/videos/${job.remoteId}/content`]);
  });

  assert.equal(unintendedNetwork, 0);
  console.log(`Media capability extension: ${passed} behavior checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
