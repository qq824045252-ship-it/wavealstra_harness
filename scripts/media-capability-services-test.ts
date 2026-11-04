import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_CODEX_IMAGE_MODEL, BUILTIN_CODEX_IMAGE_PROVIDER_ID, DEFAULT_BUILTIN_CAPABILITIES_CONFIG,
  type BuiltinCapabilitiesConfigDto, type RecognitionServiceConfig,
} from "../src/shared/builtin-capabilities";
import {
  CODEX_CONNECTION_ID, LOCAL_WHISPER_CONNECTION_ID, MAGPIE_CONNECTION_ID, MEDIA_CAPABILITY_IDS,
  type ApiCapabilityConnection, type MediaCapabilityId,
} from "../src/shared/media-capabilities";
import { BuiltinCapabilityRuntime, type ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { capabilityConfigRevision, MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import type { MagpieGatewayConfig } from "../src/main/agent/providers/magpie";
import type { MagpieCapabilityCatalog } from "../src/main/capabilities/providers/MagpieCapabilityCatalog";
import { VideoJobPendingError, type VideoGenerationJob, type VideoGenerationJobStore } from "../src/main/capabilities/VideoGenerationJobs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=", "base64");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(24)]);
const MP4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703431", "hex");
const SECRET_A = "fixture-private-key-a";
const SECRET_B = "fixture-private-key-b";
const NEW_SECRET = "fixture-replacement-key";

function clone<T>(value: T): T { return structuredClone(value); }
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function apiConnection(name: string, credentialRef?: string, protocol: ApiCapabilityConnection["protocol"] = "openai-compatible"): ApiCapabilityConnection {
  return { name, protocol, baseUrl: `https://${name}.example/v1`, auth: credentialRef ? "api-key" : "none", credentialRef, timeoutMs: 5_000 };
}
function recognition(adapter: RecognitionServiceConfig["adapter"], credentialRef?: string, dataPolicy: RecognitionServiceConfig["dataPolicy"] = "allow-cloud"): RecognitionServiceConfig {
  return { adapter, endpoint: "https://legacy.example/recognize", model: "legacy-model", credentialRef, location: "cloud", dataPolicy, timeoutMs: 5_000 };
}
function manualConfig(): BuiltinCapabilitiesConfigDto {
  const config = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.imageGeneration.enabled = false;
  config.mediaBindings = {};
  return config;
}

class MemoryJobs implements VideoGenerationJobStore {
  readonly values = new Map<string, VideoGenerationJob>();
  get(id: string): VideoGenerationJob | undefined { return clone(this.values.get(id)); }
  list(taskId?: string): VideoGenerationJob[] { return clone([...this.values.values()].filter(job => taskId === undefined || job.taskId === taskId)); }
  findByInvocation(taskId: string, toolCallId: string): VideoGenerationJob | undefined {
    return clone([...this.values.values()].find(job => job.taskId === taskId && job.toolCallId === toolCallId));
  }
  put(job: VideoGenerationJob): void { this.values.set(job.id, clone(job)); }
}

interface CapturedRequest { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }

/** The real manager/runtime run against memory-only storage and identity stubs. */
class Fixture {
  configValue: BuiltinCapabilitiesConfigDto;
  readonly keys = new Map<string, string>();
  readonly keyWrites: Array<{ operation: "set" | "clear"; ref: string }> = [];
  readonly writes: BuiltinCapabilitiesConfigDto[] = [];
  storeAttempts = 0;
  beforeStore?: (next: BuiltinCapabilitiesConfigDto, attempt: number) => void;
  beforeKeyWrite?: (operation: "set" | "clear", ref: string, value?: string) => void;
  codexAvailable = false;
  codexCalls = 0;
  localWhisperCalls = 0;
  legacySpeechCalls = 0;
  defaultProvider: string | undefined;
  magpie: MagpieGatewayConfig | undefined;
  readonly discoveryCalls: MagpieGatewayConfig[] = [];
  catalog: MagpieCapabilityCatalog = {
    models: [
      { id: "vendor/z-image", label: "Z Image", kind: "image", inputModalities: ["text", "image"], outputModalities: ["image"] },
      { id: "vendor/a-image", label: "A Image", kind: "image", inputModalities: ["text"], outputModalities: ["image"] },
      { id: "vendor/video", label: "Video", kind: "video", inputModalities: ["text"], outputModalities: ["video"] },
    ],
    audio: {
      asr: { endpoint: "/audio/transcriptions", modelDiscovery: "manual", available: true },
      tts: { endpoint: "/audio/speech", modelDiscovery: "manual", available: true },
    },
  };
  discoverImpl: (config: MagpieGatewayConfig) => Promise<MagpieCapabilityCatalog> = async () => clone(this.catalog);
  readonly requests: CapturedRequest[] = [];
  requestImpl: (request: CapturedRequest) => Promise<Response> = async () => { throw new Error("unexpected fixture HTTP request"); };
  readonly runtime: BuiltinCapabilityRuntime;
  readonly jobs = new MemoryJobs();
  readonly manager: MediaCapabilityServices;

  constructor(config = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG)) {
    this.configValue = clone(config);
    this.runtime = new BuiltinCapabilityRuntime({
      store: {
        read: () => clone(this.configValue),
        write: next => {
          this.beforeStore?.(next, ++this.storeAttempts);
          this.configValue = clone(next);
          this.writes.push(clone(next));
          return clone(next);
        },
      },
      credentials: {
        has: ref => this.keys.has(ref),
        get: ref => this.keys.get(ref) ?? null,
        set: (ref, value) => { this.keyWrites.push({ operation: "set", ref }); this.beforeKeyWrite?.("set", ref, value); this.keys.set(ref, value); },
        clear: ref => { this.keyWrites.push({ operation: "clear", ref }); this.beforeKeyWrite?.("clear", ref); this.keys.delete(ref); },
      },
    });
    this.runtime.registerProvider("media", {
      id: BUILTIN_CODEX_IMAGE_PROVIDER_ID, label: "Fixture Codex", isAvailable: () => this.codexAvailable,
      test: async () => "fixture OAuth checked",
      generateImage: async input => { this.codexCalls++; return { provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID, model: input.model, items: [{ bytes: PNG, mimeType: "image/png" }] }; },
    });
    this.runtime.registerProvider("speech", {
      id: "local-whisper", label: "Fixture local Whisper", test: async () => "fixture local ready",
      speechToText: async () => { this.localWhisperCalls++; return { provider: "local-whisper", text: "local transcript" }; },
    });
    this.runtime.registerProvider("speech", {
      id: "http-asr", label: "Fixture legacy ASR",
      speechToText: async () => { this.legacySpeechCalls++; return { provider: "http-asr", text: "legacy transcript" }; },
    });
    this.manager = new MediaCapabilityServices({
      runtime: this.runtime, videoJobs: this.jobs,
      getMagpieConfig: () => this.magpie,
      getDefaultProvider: () => this.defaultProvider,
      discover: async config => { this.discoveryCalls.push(clone(config)); return this.discoverImpl(config); },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request: CapturedRequest = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
        this.requests.push(request);
        return this.requestImpl(request);
      }) as typeof fetch,
    });
    this.runtime.attachMediaServices(this.manager);
  }

  bind(id: MediaCapabilityId, connectionId: string, model?: string): void {
    this.configValue.mediaBindings ??= {};
    this.configValue.mediaBindings[id] = { connectionId, model, selection: "manual" };
  }
  configuredMagpie(): void { this.magpie = { baseUrl: "http://127.0.0.1:3425/v1", apiKey: SECRET_A, headers: { "User-Agent": "MyBuddy" } }; }
}

function body(request: CapturedRequest): Record<string, unknown> {
  assert.equal(typeof request.body, "string");
  return JSON.parse(request.body as string) as Record<string, unknown>;
}
function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SECRET_A, SECRET_B, NEW_SECRET]) assert(!text.includes(secret), "credentials must never be returned in settings/status DTOs");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-media-services-"));
  const originalFetch = globalThis.fetch;
  let unexpectedNetwork = 0;
  globalThis.fetch = (async () => { unexpectedNetwork++; throw new Error("real network disabled in media services test"); }) as typeof fetch;
  const failures: string[] = [];
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try { await run(); console.log(`PASS ${name}`); passed++; }
    catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
  };
  const context = (call: string): ToolExecutionContext => ({ taskId: "fixture-task", taskRoot: root, toolCallId: call });
  try {
    const imagePath = join(root, "sample.png");
    const audioPath = join(root, "sample.wav");
    writeFileSync(imagePath, PNG);
    const wav = Buffer.alloc(48);
    wav.write("RIFF", 0); wav.writeUInt32LE(40, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(4, 40);
    writeFileSync(audioPath, wav);

    await test("automatic image selection uses the default provider and then stays pinned", async () => {
      for (const defaultProvider of ["magpie", "openai-codex", "another-provider", undefined]) {
        const f = new Fixture(); f.codexAvailable = true; f.configuredMagpie(); f.defaultProvider = defaultProvider;
        await f.manager.refresh();
        const chosen = clone(f.manager.binding("image-generation"));
        assert.equal(chosen?.connectionId, defaultProvider === "magpie" ? MAGPIE_CONNECTION_ID : CODEX_CONNECTION_ID);
        assert(chosen?.model, "auto selection must bind a concrete model");
        const writes = f.writes.length;
        f.defaultProvider = defaultProvider === "magpie" ? "openai-codex" : "magpie";
        f.catalog.models.reverse();
        f.catalog.models.unshift({ id: "vendor/new-first-image", label: "New", kind: "image", inputModalities: [], outputModalities: ["image"] });
        await f.manager.refresh();
        assert.deepEqual(f.manager.binding("image-generation"), chosen, "login and refresh must not silently replace a bound service/model");
        assert.equal(f.writes.length, writes);
        assert.equal(f.requests.length + f.codexCalls, 0, "selection does not test-generate an image");
      }
    });

    await test("automatic image selection requires an actual available media candidate", async () => {
      const magpieOnly = new Fixture(); magpieOnly.configuredMagpie();
      await magpieOnly.manager.refresh();
      assert.equal(magpieOnly.manager.binding("image-generation")?.connectionId, MAGPIE_CONNECTION_ID);
      const codexOnly = new Fixture(); codexOnly.codexAvailable = true; codexOnly.configuredMagpie(); codexOnly.defaultProvider = "magpie"; codexOnly.catalog.models = [];
      await codexOnly.manager.refresh();
      assert.equal(codexOnly.manager.binding("image-generation")?.connectionId, CODEX_CONNECTION_ID);
      const absent = new Fixture(); absent.configuredMagpie(); absent.catalog.models = [];
      await absent.manager.refresh();
      assert.equal(absent.manager.binding("image-generation")?.connectionId, "");
      assert.equal(absent.writes.length, 0);
    });

    await test("explicit off, manual selection and legacy choices survive new logins", async () => {
      const disabled = new Fixture(); disabled.configValue.imageGeneration.enabled = false; disabled.codexAvailable = true; disabled.configuredMagpie(); disabled.defaultProvider = "magpie";
      const before = clone(disabled.configValue);
      await disabled.manager.refresh();
      assert.deepEqual(disabled.configValue, before);
      assert.equal(disabled.manager.status("image-generation").state, "disabled");
      assert.equal(disabled.writes.length, 0);
      const manual = new Fixture(); manual.codexAvailable = true; manual.configuredMagpie(); manual.defaultProvider = "magpie";
      manual.bind("image-generation", CODEX_CONNECTION_ID, BUILTIN_CODEX_IMAGE_MODEL);
      await manual.manager.refresh();
      assert.equal(manual.manager.binding("image-generation")?.connectionId, CODEX_CONNECTION_ID);
      assert.equal(manual.writes.length, 0);
      const legacy = new Fixture(); legacy.configValue.mediaBindings = {}; legacy.codexAvailable = true; legacy.configuredMagpie(); legacy.defaultProvider = "magpie";
      await legacy.manager.refresh();
      assert.equal(legacy.manager.binding("image-generation")?.connectionId, CODEX_CONNECTION_ID);
      assert.deepEqual(legacy.configValue.mediaBindings, {}, "reading old schema-v1 does not rewrite its selection");
    });

    await test("directory failure and logout preserve the saved automatic binding", async () => {
      const f = new Fixture(); f.configuredMagpie(); f.defaultProvider = "magpie"; f.codexAvailable = true;
      await f.manager.refresh();
      const chosen = clone(f.manager.binding("image-generation"));
      f.discoverImpl = async () => { throw new Error("fixture gateway offline"); };
      await f.manager.refresh();
      assert.deepEqual(f.manager.binding("image-generation"), chosen);
      f.magpie = undefined;
      await f.manager.refresh();
      assert.deepEqual(f.manager.binding("image-generation"), chosen);
      assert.equal(f.manager.status("image-generation").state, "needs-configuration", "Codex availability does not silently reroute a disconnected Magpie binding");
    });

    await test("a Magpie catalogue is not reused after the gateway identity changes", async () => {
      for (const change of ["key", "header"] as const) {
        const f = new Fixture(); f.configuredMagpie(); f.defaultProvider = "magpie"; f.configValue.imageGeneration.enabled = false;
        await f.manager.refresh();
        f.magpie = change === "key" ? { ...f.magpie!, apiKey: SECRET_B } : { ...f.magpie!, headers: { Authorization: `Bearer ${SECRET_B}` } };
        f.configValue.imageGeneration.enabled = true;
        f.discoverImpl = async () => { throw new Error("fixture new identity offline"); };
        await f.manager.refresh();
        assert.equal(f.manager.binding("image-generation")?.connectionId, "", "the first identity's catalogue is not authorization evidence for the second identity");
        assert.deepEqual(f.manager.services().find(service => service.id === MAGPIE_CONNECTION_ID)?.models["image-generation"], []);
        assert.equal(f.writes.length, 0);
        assertNoSecrets(f.runtime.snapshot());
      }
    });

    await test("an in-flight catalogue response cannot bind an identity that changed while loading", async () => {
      const f = new Fixture(); f.configuredMagpie(); f.defaultProvider = "magpie";
      let release: ((catalog: MagpieCapabilityCatalog) => void) | undefined;
      f.discoverImpl = () => new Promise(resolve => { release = resolve; });
      const pending = f.manager.refresh();
      assert(release);
      f.magpie = { ...f.magpie!, apiKey: SECRET_B };
      release(clone(f.catalog));
      await pending;
      assert.equal(f.manager.binding("image-generation")?.connectionId, "");
      assert.equal(f.writes.length, 0);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("local-only legacy recognition keeps its policy and uploads nothing", async () => {
      const config = manualConfig();
      config.services = { speech: recognition("http-asr", undefined, "local-only"), image: recognition("http-ocr", undefined, "local-only") };
      config.speechToText = { enabled: true, provider: "http-asr", serviceId: "speech" };
      config.ocr = { enabled: true, serviceId: "image" };
      const f = new Fixture(config);
      const next = clone(config); next.services!.speech.dataPolicy = "allow-cloud"; next.services!.image.dataPolicy = "allow-cloud";
      f.manager.save({ config: next });
      assert.equal(f.configValue.services?.speech.dataPolicy, "local-only");
      assert.equal(f.configValue.services?.image.dataPolicy, "local-only");
      await assert.rejects(f.runtime.speechToTextProvider()!.speechToText!({ audioPath }, context("private-asr")), /local-only/);
      await assert.rejects(f.runtime.ocrAdapter()!.recognize(imagePath, context("private-ocr")), /local-only/);
      assert.equal(f.legacySpeechCalls, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.manager.status("ocr").state, "needs-configuration");
    });

    await test("local-only is enforced for new API recognition bindings too", async () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one") }; config.ocr = { enabled: true };
      config.mediaBindings = {
        "speech-to-text": { connectionId: "api-one", model: "asr", dataPolicy: "local-only" },
        ocr: { connectionId: "api-one", model: "vision", dataPolicy: "local-only" },
      };
      const f = new Fixture(config);
      await assert.rejects(f.runtime.speechToTextProvider()!.speechToText!({ audioPath }, context("private-new-asr")), /local-only/);
      await assert.rejects(f.runtime.ocrAdapter()!.recognize(imagePath, context("private-new-ocr")), /local-only/);
      assert.equal(f.requests.length, 0);
    });

    await test("blank API keys keep the existing identity; replace and clear are explicit", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "existing-ref") };
      const f = new Fixture(config); f.keys.set("existing-ref", SECRET_A);
      f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-one", secret: "  " }] });
      assert.equal(f.keys.get("existing-ref"), SECRET_A);
      assert.equal(f.keyWrites.length, 0);
      const next = clone(f.configValue); next.connections!["api-one"].credentialRef = "renderer-supplied-ref";
      f.manager.save({ config: next, credentials: [{ connectionId: "api-one", secret: ` ${NEW_SECRET} ` }] });
      assert.equal(f.keys.get("existing-ref"), NEW_SECRET);
      assert(!f.keys.has("renderer-supplied-ref"), "the renderer cannot choose the keyring namespace");
      assert.equal(f.configValue.connections?.["api-one"].credentialRef, "existing-ref");
      assertNoSecrets(f.runtime.snapshot());
      f.manager.save({ config: clone(f.configValue), credentials: [{ connectionId: "api-one", clear: true }] });
      assert(!f.keys.has("existing-ref"));
      assert.equal(f.manager.services().find(service => service.id === "api-one")?.authState, "missing-key");
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("a keyring that silently refuses clear cannot report a successful settings save", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      f.runtime.credentials.clear = () => { /* native keyring wrappers may swallow delete errors */ };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-one", clear: true }] }), /未保存/);
      assert.equal(f.keys.get("ref-one"), SECRET_A);
      assert.deepEqual(f.configValue, config);
      assert.equal(f.writes.length, 0);
    });

    await test("a new API key gets one internal reference shared by all selected capabilities", () => {
      const config = manualConfig(); config.connections = { "api-new": { ...apiConnection("new"), auth: "api-key" } };
      config.mediaBindings = { "speech-to-text": { connectionId: "api-new", model: "asr" }, "text-to-speech": { connectionId: "api-new", model: "tts" } };
      const f = new Fixture(config);
      f.manager.save({ config, credentials: [{ connectionId: "api-new", secret: SECRET_A }] });
      const ref = f.configValue.connections?.["api-new"].credentialRef;
      assert(ref && ref !== SECRET_A);
      assert.equal(f.keys.get(ref), SECRET_A);
      assert.equal(f.keys.size, 1);
      f.manager.save({ config: clone(f.configValue), credentials: [{ connectionId: "api-new", secret: "" }] });
      assert.equal(f.configValue.connections?.["api-new"].credentialRef, ref);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("legacy services sharing one credential keep the reference and reject conflicting changes", () => {
      const config = manualConfig();
      config.services = { one: recognition("http-asr", "shared-ref"), two: recognition("http-ocr", "shared-ref") };
      const f = new Fixture(config); f.keys.set("shared-ref", SECRET_A);
      const next = clone(config); next.services!.one.credentialRef = "new-ref-a"; next.services!.two.credentialRef = "new-ref-b";
      f.manager.save({ config: next, credentials: [{ connectionId: "legacy:one", secret: NEW_SECRET }, { connectionId: "legacy:two", secret: NEW_SECRET }] });
      assert.equal(f.keys.size, 1);
      assert.equal(f.keys.get("shared-ref"), NEW_SECRET);
      assert.equal(f.configValue.services?.one.credentialRef, "shared-ref");
      assert.equal(f.configValue.services?.two.credentialRef, "shared-ref");
      const before = clone(f.configValue); const mutations = f.keyWrites.length;
      assert.throws(() => f.manager.save({ config: clone(before), credentials: [{ connectionId: "legacy:one", secret: SECRET_A }, { connectionId: "legacy:two", secret: SECRET_B }] }), /共享密钥/);
      assert.deepEqual(f.configValue, before);
      assert.equal(f.keys.get("shared-ref"), NEW_SECRET);
      assert.equal(f.keyWrites.length, mutations);
    });

    await test("configuration write failure restores replaced keys and removes newly created keys", () => {
      const config = manualConfig(); config.connections = { "api-old": apiConnection("old", "old-ref"), "api-new": { ...apiConnection("new"), auth: "api-key" } };
      const f = new Fixture(config); f.keys.set("old-ref", SECRET_A);
      const beforeKeys = [...f.keys];
      f.beforeStore = () => { throw new Error(`fixture disk refusal ${SECRET_A}`); };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-old", secret: NEW_SECRET }, { connectionId: "api-new", secret: SECRET_B }] }), error => {
        assert(error instanceof Error); assert.match(error.message, /未保存/); assertNoSecrets(error.message); return true;
      });
      assert.deepEqual(f.configValue, config);
      assert.deepEqual([...f.keys], beforeKeys);
      assert.equal(f.writes.length, 0);
    });

    await test("saving an unresolved automatic image binding commits only the complete chosen configuration", async () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A); f.configuredMagpie(); f.defaultProvider = "magpie";
      await f.manager.refresh();
      const next = clone(config); next.imageGeneration.enabled = true;
      next.mediaBindings = { "image-generation": { connectionId: "", selection: "auto" } };
      f.beforeStore = (pending, attempt) => {
        assert.equal(pending.mediaBindings?.["image-generation"]?.connectionId, MAGPIE_CONNECTION_ID, "the persisted state must already contain its automatic selection");
        if (attempt > 1) throw new Error("fixture second write refusal");
      };
      f.manager.save({ config: next, credentials: [{ connectionId: "api-one", secret: NEW_SECRET }] });
      assert.equal(f.manager.binding("image-generation")?.connectionId, MAGPIE_CONNECTION_ID);
      assert.equal(f.keys.get("ref-one"), NEW_SECRET);
      assert.equal(f.writes.length, 1);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("a later keyring failure restores earlier credential writes before config is saved", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one"), "api-two": apiConnection("two", "ref-two") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A); f.keys.set("ref-two", SECRET_B);
      const beforeKeys = [...f.keys];
      f.beforeKeyWrite = (_operation, ref, value) => { if (ref === "ref-two" && value === NEW_SECRET) throw new Error(`fixture keyring refusal ${SECRET_B}`); };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-one", secret: NEW_SECRET }, { connectionId: "api-two", secret: NEW_SECRET }] }), /未保存/);
      assert.deepEqual([...f.keys], beforeKeys);
      assert.deepEqual(f.configValue, config);
      assert.equal(f.writes.length, 0);
    });

    await test("rollback failure is reported instead of claiming the original keys survived", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      f.beforeStore = () => { throw new Error("fixture disk refusal"); };
      f.beforeKeyWrite = (_operation, _ref, value) => { if (value === SECRET_A) throw new Error("fixture rollback refusal"); };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-one", secret: NEW_SECRET }] }), /恢复失败/);
      assert.deepEqual(f.configValue, config);
    });

    await test("a rollback clear that silently leaves a new key behind is reported as a rollback failure", () => {
      const config = manualConfig(); config.connections = { "api-new": { ...apiConnection("new"), auth: "api-key" } };
      const f = new Fixture(config);
      f.beforeStore = () => { throw new Error("fixture disk refusal"); };
      f.runtime.credentials.clear = () => { /* simulate a keyring delete wrapper swallowing its failure */ };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-new", secret: NEW_SECRET }] }), /恢复失败/);
      assert.deepEqual(f.configValue, config);
      assert.equal(f.keys.size, 1, "the fixture really leaves the key behind; the manager must report that state honestly");
    });

    await test("credential read failures cannot be treated as a missing old key", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      f.runtime.credentials.get = () => { throw new Error(`fixture unreadable keyring ${SECRET_A}`); };
      assert.throws(() => f.manager.save({ config: clone(config), credentials: [{ connectionId: "api-one", secret: NEW_SECRET }] }), error => {
        assert(error instanceof Error); assert.match(error.message, /未保存/); assertNoSecrets(error.message); return true;
      });
      assert.equal(f.keys.get("ref-one"), SECRET_A);
      assert.deepEqual(f.configValue, config);
      assert.equal(f.keyWrites.length, 0);
      assert.equal(f.writes.length, 0);
    });

    await test("stale expectedRevision rejects a draft before any key or config mutation", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      const expectedRevision = capabilityConfigRevision(config);
      f.configValue.connections!["api-one"].name = "changed elsewhere";
      const latest = clone(f.configValue);
      assert.throws(() => f.manager.save({ config, expectedRevision, credentials: [{ connectionId: "api-one", secret: NEW_SECRET }] }), /其他位置改变/);
      assert.deepEqual(f.configValue, latest);
      assert.equal(f.keys.get("ref-one"), SECRET_A);
      assert.equal(f.keyWrites.length, 0);
      assert.equal(f.writes.length, 0);
      f.manager.save({ config: latest, expectedRevision: capabilityConfigRevision(latest) });
      assert.equal(f.writes.length, 1);
    });

    await test("invalid connection edits fail before touching credentials", () => {
      const config = manualConfig(); config.connections = { "api-one": apiConnection("one", "ref-one") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      const bad = clone(config); bad.connections!["api-one"].baseUrl += `?api_key=${SECRET_A}`;
      assert.throws(() => f.manager.save({ config: bad, credentials: [{ connectionId: "api-one", secret: NEW_SECRET }] }), error => error instanceof Error && !error.message.includes(SECRET_A));
      assert.deepEqual(f.configValue, config);
      assert.equal(f.keyWrites.length, 0);
      assert.equal(f.writes.length, 0);
    });

    await test("registered legacy custom providers remain selected and usable", async () => {
      const config = manualConfig();
      config.imageGeneration = { enabled: true, provider: "private-fixture", model: "legacy-image" };
      config.videoGeneration = { enabled: true, provider: "private-fixture", model: "legacy-video" };
      config.speechToText = { enabled: true, provider: "private-fixture" };
      config.textToSpeech = { enabled: true, provider: "private-fixture", model: "legacy-tts", voice: "legacy-voice" };
      const f = new Fixture(config); f.codexAvailable = true; f.configuredMagpie(); f.defaultProvider = "magpie";
      const calls = { image: 0, video: 0, asr: 0, tts: 0 };
      f.runtime.registerProvider("media", {
        id: "private-fixture", label: "Fixture custom media", isAvailable: () => true,
        generateImage: async () => { calls.image++; return { provider: "private-fixture", items: [{ bytes: PNG, mimeType: "image/png" }] }; },
        generateVideo: async () => { calls.video++; return { provider: "private-fixture", items: [{ bytes: MP4, mimeType: "video/mp4" }] }; },
      });
      f.runtime.registerProvider("speech", {
        id: "private-fixture", label: "Fixture custom speech",
        speechToText: async () => { calls.asr++; return { provider: "private-fixture", text: "legacy custom transcript" }; },
        textToSpeech: async () => { calls.tts++; return { provider: "private-fixture", items: [{ bytes: MP3, mimeType: "audio/mpeg" }] }; },
      });
      await f.manager.refresh();
      assert.deepEqual(f.configValue, config);
      for (const id of ["image-generation", "video-generation", "speech-to-text", "text-to-speech"] as const) {
        const binding = f.manager.binding(id);
        assert(binding?.connectionId, `${id} must retain a visible service selection for its legacy adapter`);
        const service = f.manager.services().find(option => option.id === binding.connectionId);
        assert(service?.configured, `${id} must remain configured when its old adapter is registered`);
        assert(["ready", "unchecked"].includes(f.manager.status(id).state), `${id} must not demand fields the existing adapter never needed`);
      }
      await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture" }, context("legacy-image"));
      await f.runtime.videoProvider()!.generateVideo!({ prompt: "fixture" }, context("legacy-video"));
      await f.runtime.speechToTextProvider()!.speechToText!({ audioPath }, context("legacy-asr"));
      await f.runtime.textToSpeechProvider()!.textToSpeech!({ text: "fixture" }, context("legacy-tts"));
      assert.deepEqual(calls, { image: 1, video: 1, asr: 1, tts: 1 });
      assert.equal(f.requests.length + f.codexCalls + f.localWhisperCalls, 0);
    });

    await test("unregistered legacy custom providers stay visible without claiming availability", async () => {
      const config = manualConfig();
      config.imageGeneration = { enabled: true, provider: "missing-fixture", model: "legacy-image" };
      config.videoGeneration = { enabled: true, provider: "missing-fixture", model: "legacy-video" };
      config.speechToText = { enabled: true, provider: "missing-fixture" };
      config.textToSpeech = { enabled: true, provider: "missing-fixture", model: "legacy-tts", voice: "legacy-voice" };
      const f = new Fixture(config); f.codexAvailable = true; f.configuredMagpie(); f.defaultProvider = "magpie";
      await f.manager.refresh();
      for (const id of ["image-generation", "video-generation", "speech-to-text", "text-to-speech"] as const) {
        const binding = f.manager.binding(id);
        assert(binding?.connectionId, `${id} must not forget the user's old provider when its adapter is absent`);
        const service = f.manager.services().find(option => option.id === binding.connectionId);
        assert(service, `${id} retains a visible missing-provider option`);
        assert.equal(service.configured, false);
        assert.equal(f.manager.status(id).state, "needs-configuration");
      }
      f.manager.save({ config: clone(f.configValue) });
      assert.deepEqual(f.configValue, config);
      assert.equal(f.codexCalls + f.requests.length, 0);
    });

    await test("five capabilities invoke their selected connections and models", async () => {
      const config = manualConfig(); config.imageGeneration.enabled = true; config.ocr = { enabled: true }; config.textToSpeech.voice = "fixture-voice";
      config.connections = {
        "api-one": apiConnection("one", "ref-one"), "api-two": apiConnection("two", "ref-two"),
        "api-ocr": apiConnection("ocr", undefined, "mistral-ocr"),
      };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A); f.keys.set("ref-two", SECRET_B);
      f.bind("image-generation", "api-one", "chosen-image"); f.bind("video-generation", "api-two", "chosen-video");
      f.bind("speech-to-text", "api-one", "chosen-asr"); f.bind("text-to-speech", "api-two", "chosen-tts"); f.bind("ocr", "api-ocr", "chosen-ocr");
      f.requestImpl = async request => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/images/generations")) return json({ created: 1, data: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }] });
        if (path.endsWith("/audio/transcriptions")) return json({ text: "fixture transcript", language: "en" });
        if (path.endsWith("/audio/speech")) return new Response(new Uint8Array(MP3), { headers: { "content-type": "audio/mpeg" } });
        if (path.endsWith("/ocr")) return json({ pages: [{ markdown: "fixture OCR" }] });
        if (path.endsWith("/content")) return new Response(new Uint8Array(MP4), { headers: { "content-type": "video/mp4" } });
        if (path.includes("/videos")) return json({ id: "fixture_remote_video", object: "video", status: "completed", progress: 100, model: "chosen-video" });
        throw new Error(`unexpected fixture route ${path}`);
      };
      const image = await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture image" }, context("image"));
      const video = await f.runtime.videoProvider()!.generateVideo!({ prompt: "fixture video" }, context("video"));
      const asr = await f.runtime.speechToTextProvider()!.speechToText!({ audioPath }, context("asr"));
      const tts = await f.runtime.textToSpeechProvider()!.textToSpeech!({ text: "fixture speech", voice: "fixture-voice" }, context("tts"));
      const ocr = await f.runtime.ocrAdapter()!.recognize(imagePath, context("ocr"));
      assert.equal(image.provider, "api-one"); assert.equal(video.provider, "api-two"); assert.equal(asr.provider, "api-one"); assert.equal(tts.provider, "api-two"); assert.equal(ocr.text, "fixture OCR");
      const generation = f.requests.find(request => request.url.endsWith("/images/generations"))!;
      const creation = f.requests.find(request => request.url.endsWith("/videos") && request.method === "POST")!;
      const transcription = f.requests.find(request => request.url.endsWith("/audio/transcriptions"))!;
      const speech = f.requests.find(request => request.url.endsWith("/audio/speech"))!;
      const recognitionRequest = f.requests.find(request => request.url.endsWith("/ocr"))!;
      assert.equal(generation.url, "https://one.example/v1/images/generations"); assert.equal(body(generation).model, "chosen-image");
      assert.equal(creation.url, "https://two.example/v1/videos");
      assert.equal(creation.body instanceof FormData ? creation.body.get("model") : body(creation).model, "chosen-video");
      assert.equal(transcription.url, "https://one.example/v1/audio/transcriptions"); assert(transcription.body instanceof FormData); assert.equal(transcription.body.get("model"), "chosen-asr");
      assert.equal(speech.url, "https://two.example/v1/audio/speech"); assert.equal(body(speech).model, "chosen-tts");
      assert.equal(recognitionRequest.url, "https://ocr.example/v1/ocr"); assert.equal(body(recognitionRequest).model, "chosen-ocr");
      for (const request of f.requests) {
        const host = new URL(request.url).hostname;
        assert.equal(request.headers.get("authorization"), host === "one.example" ? `Bearer ${SECRET_A}` : host === "two.example" ? `Bearer ${SECRET_B}` : null);
      }
      for (const id of MEDIA_CAPABILITY_IDS) assert.equal(f.manager.status(id).state, "ready", `${id} records success only for its actual selected connection`);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("Magpie and local/Codex selections reuse the corresponding registered identity", async () => {
      const f = new Fixture(manualConfig()); f.configValue.imageGeneration.enabled = true; f.codexAvailable = true; f.configuredMagpie();
      f.bind("image-generation", MAGPIE_CONNECTION_ID, "upstream/image");
      await f.manager.refresh();
      f.requestImpl = async () => json({ data: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }] });
      await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture" }, context("magpie-image"));
      assert.equal(f.requests[0].url, "http://127.0.0.1:3425/v1/images/generations");
      assert.equal(f.requests[0].headers.get("authorization"), `Bearer ${SECRET_A}`);
      assert.equal(f.requests[0].headers.get("user-agent"), "MyBuddy");
      assert.equal(body(f.requests[0]).model, "upstream/image");
      assert.equal(f.codexCalls, 0);
      f.bind("image-generation", CODEX_CONNECTION_ID, BUILTIN_CODEX_IMAGE_MODEL);
      await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture" }, context("codex-image"));
      assert.equal(f.codexCalls, 1);
      assert.equal(f.requests.length, 1);
      f.bind("speech-to-text", LOCAL_WHISPER_CONNECTION_ID);
      const transcript = await f.runtime.speechToTextProvider()!.speechToText!({ audioPath }, context("local-asr"));
      assert.equal(transcript.provider, "local-whisper"); assert.equal(f.localWhisperCalls, 1);
      assert.equal(f.requests.length, 1);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("disabling capabilities blocks providers retained by an existing session", async () => {
      const config = manualConfig(); config.imageGeneration.enabled = true; config.ocr = { enabled: true }; config.connections = { "api-one": apiConnection("one") };
      const f = new Fixture(config);
      for (const id of MEDIA_CAPABILITY_IDS) f.bind(id, "api-one", `model-${id}`);
      const image = f.runtime.imageProvider()!; const video = f.runtime.videoProvider()!; const asr = f.runtime.speechToTextProvider()!; const tts = f.runtime.textToSpeechProvider()!; const ocr = f.runtime.ocrAdapter()!;
      f.configValue.imageGeneration.enabled = false; f.configValue.videoGeneration.enabled = false; f.configValue.speechToText.enabled = false; f.configValue.textToSpeech.enabled = false; f.configValue.ocr!.enabled = false;
      await assert.rejects(image.generateImage!({ prompt: "fixture" }, context("off-image")), /关闭/);
      await assert.rejects(video.generateVideo!({ prompt: "fixture" }, context("off-video")), /关闭/);
      await assert.rejects(asr.speechToText!({ audioPath }, context("off-asr")), /关闭/);
      await assert.rejects(tts.textToSpeech!({ text: "fixture", voice: "fixture" }, context("off-tts")), /关闭/);
      await assert.rejects(ocr.recognize(imagePath, context("off-ocr")), /关闭/);
      assert.equal(f.requests.length, 0);
    });

    await test("successful Magpie image usage belongs to its current credential identity", async () => {
      const f = new Fixture(manualConfig()); f.configValue.imageGeneration.enabled = true; f.configuredMagpie();
      f.bind("image-generation", MAGPIE_CONNECTION_ID, "upstream/image");
      await f.manager.refresh();
      f.requestImpl = async () => json({ data: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }] });
      await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture image" }, context("identity-image"));
      assert.equal(f.manager.status("image-generation").state, "ready");
      const binding = clone(f.configValue.mediaBindings!["image-generation"]);
      const originalUrl = f.magpie!.baseUrl;

      f.magpie = { ...f.magpie!, apiKey: SECRET_B };
      assert.equal(f.magpie.baseUrl, originalUrl);
      assert.equal(f.manager.status("image-generation").state, "unchecked", "an old successful request does not validate a replacement key at the same gateway");
      assert.deepEqual(f.configValue.mediaBindings!["image-generation"], binding, "replacing authentication does not silently replace the selected model");
      assert.equal(f.requests.length, 1, "reading status must not send an image request");

      await f.runtime.imageProvider()!.generateImage!({ prompt: "fixture image with replacement identity" }, context("replacement-identity-image"));
      assert.equal(f.requests[1].headers.get("authorization"), `Bearer ${SECRET_B}`);
      assert.equal(f.manager.status("image-generation").state, "ready");
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("successful speech synthesis does not validate a new default voice or rate", async () => {
      const config = manualConfig();
      config.connections = { "api-one": apiConnection("one", "ref-one") };
      config.textToSpeech.voice = "voice-a"; config.textToSpeech.rate = "1.0";
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A);
      f.bind("text-to-speech", "api-one", "chosen-tts");
      f.requestImpl = async () => new Response(new Uint8Array(MP3), { headers: { "content-type": "audio/mpeg" } });
      const speak = async (call: string): Promise<void> => {
        await f.runtime.textToSpeechProvider()!.textToSpeech!({ text: "fixture speech", voice: f.configValue.textToSpeech.voice, rate: f.configValue.textToSpeech.rate }, context(call));
      };
      await speak("original-voice");
      assert.equal(f.manager.status("text-to-speech").state, "ready");
      assert.equal(body(f.requests[0]).voice, "voice-a"); assert.equal(body(f.requests[0]).speed, 1);

      f.configValue.textToSpeech.voice = "voice-b";
      assert.equal(f.manager.status("text-to-speech").state, "unchecked", "changing only the default voice requires a successful use of that configuration");
      assert.equal(f.requests.length, 1);
      await speak("replacement-voice");
      assert.equal(f.manager.status("text-to-speech").state, "ready");
      assert.equal(body(f.requests[1]).voice, "voice-b");

      f.configValue.textToSpeech.rate = "1.25";
      assert.equal(f.manager.status("text-to-speech").state, "unchecked", "changing only the default rate must not inherit previous success");
      assert.equal(f.requests.length, 2);
      await speak("replacement-rate");
      assert.equal(f.manager.status("text-to-speech").state, "ready");
      assert.equal(body(f.requests[2]).speed, 1.25);
      assertNoSecrets(f.runtime.snapshot());
    });

    await test("resuming an original video job does not validate the newly selected service", async () => {
      const config = manualConfig();
      config.connections = { "api-one": apiConnection("one", "ref-one"), "api-two": apiConnection("two", "ref-two") };
      const f = new Fixture(config); f.keys.set("ref-one", SECRET_A); f.keys.set("ref-two", SECRET_B);
      f.bind("video-generation", "api-one", "original-video");
      f.requestImpl = async request => {
        if (request.method === "POST" && request.url === "https://one.example/v1/videos") return json({ id: "fixture_original_video", status: "completed" });
        if (request.method === "GET" && request.url.endsWith("/content")) return json({ error: "fixture temporary content failure" }, 503);
        throw new Error("unexpected original video request");
      };
      await assert.rejects(f.runtime.videoProvider()!.generateVideo!({ prompt: "fixture video" }, context("original-video")), VideoJobPendingError);
      const [job] = f.jobs.list(context("unused").taskId);
      assert(job); assert.equal(job.remoteId, "fixture_original_video"); assert.equal(job.waitState, "paused");
      assert.equal(f.runtime.hasVideoJobs(context("unused").taskId), true);
      assert.equal(f.runtime.hasVideoJobs("another-fixture-task"), false);
      assert.equal(f.manager.status("video-generation").state, "unchecked");

      f.bind("video-generation", "api-two", "replacement-video");
      const binding = clone(f.configValue.mediaBindings!["video-generation"]);
      const beforeResume = f.requests.length;
      f.requestImpl = async request => {
        assert.equal(request.method, "GET", "resume never creates a second paid job");
        assert.equal(request.url, "https://one.example/v1/videos/fixture_original_video/content");
        assert.equal(request.headers.get("authorization"), `Bearer ${SECRET_A}`, "resume uses the original service's credentials");
        return new Response(new Uint8Array(MP4), { headers: { "content-type": "video/mp4" } });
      };
      const result = await f.runtime.resumeVideo(job.id, context("resume-original-video"));
      assert.equal(result.provider, "api-one"); assert.equal(result.model, "original-video");
      assert.equal(result.metadata?.jobId, job.id);
      assert.equal(f.requests.length, beforeResume + 1);
      assert.equal(f.requests.filter(request => request.method === "POST").length, 1);
      assert.equal(f.jobs.get(job.id)?.waitState, "finished");
      assert.deepEqual(f.configValue.mediaBindings!["video-generation"], binding);
      assert.equal(f.manager.status("video-generation").state, "unchecked", "success on the original service cannot certify the replacement service/model");
      assertNoSecrets(f.runtime.snapshot()); assertNoSecrets(f.jobs.list());
    });

    assert.equal(unexpectedNetwork, 0, "every network path must use the injected fixture transport");
    if (failures.length) throw new Error(`${failures.length} media service checks failed: ${failures.join("; ")}`);
    console.log(`media capability services: ${passed} checks passed`);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
