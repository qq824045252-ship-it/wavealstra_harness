import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { DEEPSEEK_API_ROOT } from "../src/shared/media-capabilities";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import { VideoGenerationJobs } from "../src/main/capabilities/VideoGenerationJobs";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";

interface ToolResult { isError?: boolean; details?: unknown; content?: Array<{ type: string; text?: string }> }
interface Tool { name: string; execute(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> }
const temporary = await mkdtemp(join(tmpdir(), "mybuddy-deepseek-tools-"));
const taskRoot = join(temporary, "task"); await mkdir(taskRoot);
const key = "deepseek-tool-fixture-key-never-output";
const keyring = new Map([["deepseek-fixture-ref", key]]);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const audio = Buffer.alloc(48_044);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24_000, 24); audio.writeUInt32LE(48_000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(48_000, 40);
const text = (result: ToolResult) => result.content?.map(part => part.text ?? "").join("\n") ?? "";

try {
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.connections = { "api-deepseek": { name: "DeepSeek", protocol: "deepseek", presetId: "deepseek", baseUrl: DEEPSEEK_API_ROOT,
    auth: "api-key", credentialRef: "deepseek-fixture-ref", timeoutMs: 180_000 } };
  config.mediaBindings = {
    ocr: { connectionId: "api-deepseek", ocrPurpose: "rich_layout_recognition" },
    "speech-to-text": { connectionId: "api-deepseek" },
    "text-to-speech": { connectionId: "api-deepseek" },
  };
  config.ocr = { enabled: true }; config.speechToText = { enabled: true }; config.textToSpeech = { enabled: true, voice: "stella" };
  config.imageGeneration.enabled = false; config.videoGeneration.enabled = false; config.vision.enabled = false;
  config.web.enabled = false; config.browser.enabled = false; config.subagent.enabled = false;
  config.diagnostics = { enabled: false }; config.execution = { terminalEnabled: false, codeExecutionEnabled: false }; config.multiModelConsult.enabled = false;
  const path = join(temporary, "capabilities.json");
  new BuiltinCapabilityStore(path).write(config);
  // Construct a fresh store to verify persisted readback rather than an in-memory object.
  const store = new BuiltinCapabilityStore(path);
  assert.equal(store.read().connections?.["api-deepseek"].protocol, "deepseek");
  assert.equal(store.read().mediaBindings?.ocr?.ocrPurpose, "rich_layout_recognition");
  assert(!(await readFile(path, "utf8")).includes(key));
  const runtime = new BuiltinCapabilityRuntime({ store, credentials: {
    has: id => keyring.has(id), get: id => keyring.get(id) ?? null,
    set: (id, value) => { keyring.set(id, value); }, clear: id => { keyring.delete(id); },
  } });
  const calls: string[] = [];
  const manager = new MediaCapabilityServices({ runtime, getMagpieConfig: () => undefined, videoJobs: new VideoGenerationJobs(join(temporary, "videos.json")),
    fetch: (async (url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
      const endpoint = new URL(String(url)).pathname; calls.push(endpoint);
      if (endpoint === "/v1/tools/ocr") {
        assert(init?.body instanceof FormData); assert.equal(init.body.get("purpose"), "rich_layout_recognition");
        assert.equal(init.body.has("model"), false);
        return json({ id: "ocr-tools", purpose: "rich_layout_recognition", page_count: 2, pages: [
          { index: 0, text: "First page", finish_reason: "stop" }, { index: 1, text: "Partial second page", finish_reason: "length" },
        ] });
      }
      if (endpoint === "/v1/tools/asr") {
        assert(init?.body instanceof FormData); assert.deepEqual([...init.body.keys()], ["file"]);
        return json({ text: "测试语音", request_id: "asr-tools", duration_ms: 1_000 });
      }
      assert.equal(endpoint, "/v1/tools/tts");
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, undefined); assert.equal(body.voice_id, "stella");
      return new Response(new Uint8Array(audio), { headers: { "content-type": "audio/wav" } });
    }) as typeof fetch,
  });
  runtime.attachMediaServices(manager);
  for (const capability of ["ocr", "speech-to-text", "text-to-speech"] as const) assert.equal(manager.status(capability).state, "unchecked");
  const tools = new Map<string, Tool>();
  const registeredArtifacts: Array<Record<string, unknown>> = [];
  createBuiltinCapabilityExtension({ taskId: "fixture-task", taskRoot, runtime, nativeExecution: true,
    browser: { available: false } as never,
    getProducerMessageId: () => "fixture-message", getIsolationLevel: () => "guarded",
    artifactService: () => ({ register: async (input: Record<string, unknown>) => {
      registeredArtifacts.push(input); return { id: "deepseek-audio-artifact" };
    }, remove: () => {} }) as never,
  })({ registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: () => {}, registerShortcut: () => {}, on: () => {}, appendEntry: () => {}, sendMessage: () => {} } as unknown as ExtensionAPI);
  await writeFile(join(taskRoot, "report.pdf"), "%PDF-1.7\nOCR integration fixture\n%%EOF");
  await writeFile(join(taskRoot, "voice.wav"), audio);
  const ocr = await tools.get("ocr_file")!.execute("ocr-call", { file_path: "report.pdf" });
  assert.notEqual(ocr.isError, true, text(ocr));
  assert.match(text(ocr), /部分完成/); assert.match(text(ocr), /截断/);
  const details = ocr.details as { pages: unknown[]; truncated: boolean; boxes?: unknown };
  assert.equal(details.pages.length, 2); assert.equal(details.truncated, true); assert.equal(details.boxes, undefined);
  const asr = await tools.get("speech_to_text")!.execute("asr-call", { audio_path: "voice.wav" });
  assert.notEqual(asr.isError, true, text(asr)); assert.match(text(asr), /测试语音/);
  const tts = await tools.get("text_to_speech")!.execute("tts-call", { text: "回复朗读" });
  assert.notEqual(tts.isError, true, text(tts));
  const ttsDetails = tts.details as { items: string[]; artifactIds: string[] };
  assert.deepEqual(await readFile(ttsDetails.items[0]), audio); assert.deepEqual(ttsDetails.artifactIds, ["deepseek-audio-artifact"]);
  assert.equal(registeredArtifacts[0].kind, "audio"); assert.equal(registeredArtifacts[0].mimeType, "audio/wav");
  assert.deepEqual(calls, ["/v1/tools/ocr", "/v1/tools/asr", "/v1/tools/tts"]);
  for (const capability of ["ocr", "speech-to-text", "text-to-speech"] as const) assert.equal(manager.status(capability).state, "ready");
  assert(!JSON.stringify([ocr, asr, tts]).includes(key));
  console.log("PASS one model-free connection persists, routes OCR/ASR/TTS tools, preserves partial OCR and materializes audio");
  const conflicting = await tools.get("ocr_file")!.execute("bad-paths", { file_path: "report.pdf", image_path: "other.pdf" });
  assert.equal(conflicting.isError, true); assert.equal(calls.length, 3);
  const disabled = store.read(); disabled.ocr = { enabled: false }; store.write(disabled);
  const afterDisable = await tools.get("ocr_file")!.execute("disabled-call", { file_path: "report.pdf" });
  assert.equal(afterDisable.isError, true); assert.equal(calls.length, 3);
  console.log("PASS already-registered OCR tool observes disabled capability and rejects conflicting files without upload");
} finally { await rm(temporary, { recursive: true, force: true }); }
