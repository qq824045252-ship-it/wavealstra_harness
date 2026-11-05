import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUILTIN_CAPABILITIES_CONFIG,
  type BuiltinCapabilitiesConfigDto,
} from "../src/shared/builtin-capabilities";
import {
  OPENROUTER_API_ROOT,
  type ApiCapabilityConnection,
  type MediaCapabilityId,
} from "../src/shared/media-capabilities";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import type { OpenRouterCapabilityCatalog } from "../src/main/capabilities/providers/OpenRouterCapabilityCatalog";
import { describeOpenRouterCatalogError, discoverOpenRouterCapabilities } from "../src/main/capabilities/providers/OpenRouterCapabilityCatalog";
import type { VideoGenerationJob, VideoGenerationJobStore } from "../src/main/capabilities/VideoGenerationJobs";

/**
 * Regression: saving an OpenRouter connection must trigger model-catalogue
 * discovery. Without it `snapshot.mediaServices[*].models` stays empty after
 * save and the settings panel falls back to a free-text model field.
 *
 * Everything runs against an injected runtime/credentials/discoverOpenRouter;
 * real network is disabled and asserted to stay unused.
 */

const KEY_A = "fixture-openrouter-key-a";
const KEY_B = "fixture-openrouter-key-b";
const CONNECTION_ID = "api-router";

function clone<T>(value: T): T { return structuredClone(value); }

function openRouterConnection(name = "OpenRouter"): ApiCapabilityConnection {
  return {
    name,
    presetId: "openrouter",
    protocol: "openrouter",
    baseUrl: OPENROUTER_API_ROOT,
    auth: "api-key",
    timeoutMs: 60_000,
  };
}

function catalogFixture(): OpenRouterCapabilityCatalog {
  return {
    models: {
      "image-generation": [{ id: "router/image", label: "Router Image" }],
      ocr: [{ id: "router/vision", label: "Router Vision" }],
      "speech-to-text": [{ id: "router/transcribe", label: "Router Transcribe" }],
      "text-to-speech": [{ id: "router/speech", label: "Router Speech", voices: ["alloy"] }],
      "video-generation": [{ id: "router/video", label: "Router Video" }],
    },
    partial: false,
  };
}

/** A configuration with media capabilities off so discovery is the only moving part. */
function baseConfig(): BuiltinCapabilitiesConfigDto {
  const config = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.imageGeneration.enabled = false;
  config.mediaBindings = {};
  return config;
}

class MemoryJobs implements VideoGenerationJobStore {
  get(): VideoGenerationJob | undefined { return undefined; }
  list(): VideoGenerationJob[] { return []; }
  findByInvocation(): VideoGenerationJob | undefined { return undefined; }
  put(): void { /* discovery tests never create video jobs */ }
}

interface PendingDiscovery { key: string; resolve: (catalog: OpenRouterCapabilityCatalog) => void }

/** Mirrors the production wiring: memory store, memory keyring, injected discovery. */
class Fixture {
  configValue: BuiltinCapabilitiesConfigDto;
  readonly keys = new Map<string, string>();
  readonly discoverCalls: string[] = [];
  readonly pending: PendingDiscovery[] = [];
  autoResolve = true;
  discoverImpl: (key: string) => Promise<OpenRouterCapabilityCatalog> = async () => clone(catalogFixture());
  readonly runtime: BuiltinCapabilityRuntime;
  readonly manager: MediaCapabilityServices;

  constructor(config = baseConfig()) {
    this.configValue = clone(config);
    this.runtime = new BuiltinCapabilityRuntime({
      store: {
        read: () => clone(this.configValue),
        write: (next) => { this.configValue = clone(next); return clone(next); },
      },
      credentials: {
        has: (ref) => this.keys.has(ref),
        get: (ref) => this.keys.get(ref) ?? null,
        set: (ref, value) => { this.keys.set(ref, value); },
        clear: (ref) => { this.keys.delete(ref); },
      },
    });
    this.manager = new MediaCapabilityServices({
      runtime: this.runtime,
      getMagpieConfig: () => undefined,
      videoJobs: new MemoryJobs(),
      // Keep the local OCR probe out of this suite: it would touch the host machine.
      localOcr: { resolveCli: () => undefined },
      discoverOpenRouter: async (key: string) => {
        this.discoverCalls.push(key);
        return this.discoverImpl(key);
      },
    });
    this.runtime.attachMediaServices(this.manager);
  }

  service(id = CONNECTION_ID) { return this.manager.services().find((entry) => entry.id === id); }

  /** Save a brand-new connection with a key, exactly like the settings save IPC. */
  saveNewConnection(secret = KEY_A): void {
    const next = clone(this.configValue);
    next.connections = { ...next.connections, [CONNECTION_ID]: openRouterConnection() };
    this.manager.saveAndRefresh({ config: next, credentials: [{ connectionId: CONNECTION_ID, secret }] });
  }

  /** Resolve every blocked discovery; later ones resolve immediately. */
  releasePending(): void {
    this.autoResolve = true;
    for (const { key, resolve } of this.pending.splice(0)) resolve(clone(catalogFixture()));
  }

  /** Hold every response until releasePending(); later requests resolve immediately. */
  blockDiscoveries(): void {
    this.autoResolve = false;
    this.discoverImpl = (key) => this.autoResolve
      ? Promise.resolve(clone(catalogFixture()))
      : new Promise((resolve) => { this.pending.push({ key, resolve }); });
  }
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const modelsOf = (fixture: Fixture, capability: MediaCapabilityId) => fixture.service()?.models[capability] ?? [];

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("real network disabled in OpenRouter autoload test"); }) as typeof fetch;
  const failures: string[] = [];
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try { await run(); console.log(`PASS ${name}`); passed++; }
    catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
  };
  try {
    await test("a just-saved OpenRouter connection loads its catalogue in the renderer's refresh", async () => {
      const f = new Fixture();
      // The renderer reflects the save snapshot immediately: no models yet.
      f.saveNewConnection();
      const rightAfterSave = f.service();
      assert(rightAfterSave, "the saved connection must be visible in mediaServices");
      assert.equal(rightAfterSave.configured, true, "a saved connection with a stored key is configured");
      assert.deepEqual(rightAfterSave.models, {}, "the synchronous save snapshot cannot contain a fetched catalogue");
      // Minimum renderer contract: save then refreshBuiltinMediaServices().
      await f.manager.refresh();
      for (const capability of ["ocr", "image-generation", "speech-to-text", "text-to-speech", "video-generation"] as const) {
        assert(modelsOf(f, capability).length > 0, `models.${capability} must be populated after the save-triggered refresh`);
      }
      assert.deepEqual(modelsOf(f, "ocr").map((model) => model.id), ["router/vision"]);
      assert.equal(f.discoverCalls.length, 1, "one discovery per connection per pass");
      assert.equal(f.discoverCalls[0], KEY_A, "discovery uses the saved connection's own key");
      assert(f.configValue.connections?.[CONNECTION_ID].credentialRef, "the main process owns the keyring reference");
    });

    await test("save-triggered discovery starts without an explicit refresh call", async () => {
      const f = new Fixture();
      f.blockDiscoveries();
      f.saveNewConnection();
      await tick();
      assert.deepEqual(f.discoverCalls, [KEY_A], "saving settings must start discovery in the background");
      assert.deepEqual(f.service()?.models, {}, "nothing is projected before the response arrives");
      f.releasePending();
      await f.manager.refresh();
      assert.equal(f.service()?.models.ocr?.length, 1);
    });

    await test("a refresh already in flight does not hand a stale pass to the just-saved connection", async () => {
      const f = new Fixture();
      f.blockDiscoveries();
      // App start: an existing connection is discovered by the init() pass.
      const initial = clone(f.configValue);
      initial.connections = { "api-old": openRouterConnection("Old Router") };
      initial.mediaBindings = { ocr: { connectionId: "api-old", model: "router/vision", selection: "manual" } };
      f.manager.save({ config: initial, credentials: [{ connectionId: "api-old", secret: KEY_A }] });
      const startup = f.manager.refresh();
      await tick();
      assert.deepEqual(f.discoverCalls, [KEY_A], "the startup pass is awaiting the old connection's catalogue");

      // The user saves a second connection while that pass is still loading.
      const next = clone(f.configValue);
      next.connections = { ...next.connections, [CONNECTION_ID]: openRouterConnection() };
      f.manager.saveAndRefresh({ config: next, credentials: [{ connectionId: CONNECTION_ID, secret: KEY_B }] });
      // The renderer immediately awaits refreshBuiltinMediaServices().
      const rendererRefresh = f.manager.refresh();
      f.releasePending();
      await startup;
      await rendererRefresh;
      assert(f.discoverCalls.includes(KEY_B), "the follow-up pass discovers the new connection with its own key");
      const saved = f.service();
      assert(saved, "the new connection stays visible");
      assert.equal(saved.models["image-generation"]?.[0]?.id, "router/image",
        "a pass started before the save cannot be handed back as the new connection's catalogue");
      assert.equal(saved.models.ocr?.[0]?.id, "router/vision");
      assert.equal(f.service("api-old")?.models.ocr?.[0]?.id, "router/vision");
    });

    await test("concurrent refreshes discover the same connection exactly once", async () => {
      const f = new Fixture();
      f.blockDiscoveries();
      const next = clone(f.configValue);
      next.connections = { [CONNECTION_ID]: openRouterConnection() };
      // save() without the auto-refresh keeps this test about coalescing only.
      f.manager.save({ config: next, credentials: [{ connectionId: CONNECTION_ID, secret: KEY_A }] });
      const first = f.manager.refresh();
      const second = f.manager.refresh();
      const third = f.manager.refresh();
      await tick();
      assert.deepEqual(f.discoverCalls, [KEY_A], "three concurrent refreshes share one discovery request");
      f.releasePending();
      await Promise.all([first, second, third]);
      assert.equal(f.discoverCalls.length, 1);
      assert.equal(f.service()?.models.ocr?.length, 1);
    });

    await test("a rotated key retires the previous identity's catalogue", async () => {
      const f = new Fixture();
      f.saveNewConnection(KEY_A);
      await f.manager.refresh();
      assert.equal(f.service()?.models.ocr?.length, 1);
      // Rotating the key changes the identity: the old catalogue is not evidence for the new key.
      f.manager.save({ config: clone(f.configValue), credentials: [{ connectionId: CONNECTION_ID, secret: KEY_B }] });
      assert.deepEqual(f.service()?.models, {}, "the old catalogue must not be projected under a new API key");
      await f.manager.refresh();
      assert.equal(f.discoverCalls[f.discoverCalls.length - 1], KEY_B, "the refreshed catalogue belongs to the new key");
      assert.equal(f.service()?.models.ocr?.[0]?.id, "router/vision");
      assert.equal(f.keys.get(f.configValue.connections![CONNECTION_ID].credentialRef!), KEY_B);
    });

    await test("discovery failure keeps the saved connection, binding and key intact", async () => {
      const f = new Fixture();
      f.discoverImpl = async () => { throw new Error("OpenRouter 模型目录暂不可用（HTTP 401）"); };
      const next = clone(f.configValue);
      next.connections = { [CONNECTION_ID]: openRouterConnection() };
      next.ocr = { enabled: true };
      next.mediaBindings = { ocr: { connectionId: CONNECTION_ID, model: "router/vision", selection: "manual" } };
      f.manager.saveAndRefresh({ config: next, credentials: [{ connectionId: CONNECTION_ID, secret: KEY_A }] });
      await f.manager.refresh();
      const connection = f.configValue.connections?.[CONNECTION_ID];
      assert(connection, "a failed catalogue must never roll back the saved connection");
      assert.equal(f.keys.get(connection.credentialRef!), KEY_A, "the saved key survives a failed discovery");
      assert.equal(f.manager.binding("ocr")?.model, "router/vision", "the saved model selection is preserved");
      const service = f.service();
      assert(service, "the connection stays listed");
      assert.equal(service.configured, true);
      assert.deepEqual(service.models, {}, "a failed catalogue is unknown, not an empty list");
      assert.match(service.detail ?? "", /HTTP 401/, "the detail explains why the catalogue is missing");
      assert.match(service.detail ?? "", /原服务选择已保留/);
      assert.equal(f.manager.status("ocr").state, "unchecked", "the preserved selection still counts as configured");
    });

    await test("a loaded catalogue with no models for a capability says so in the detail", async () => {
      const f = new Fixture();
      f.discoverImpl = async () => ({
        models: { "image-generation": [], ocr: [] },
        partial: true,
      });
      f.saveNewConnection();
      await f.manager.refresh();
      const service = f.service();
      assert.deepEqual(service?.models.ocr, [], "an empty list is projected as an empty list");
      assert.match(service?.detail ?? "", /目录已加载/, "the detail must distinguish 'loaded but empty' from 'never loaded'");
      assert.match(service?.detail ?? "", /暂无可用模型/);
      assert.match(service?.detail ?? "", /图片文字识别/);
    });

    await test("a connection without a stored key reports the missing key instead of pretending to load", async () => {
      const f = new Fixture();
      const next = clone(f.configValue);
      next.connections = { [CONNECTION_ID]: openRouterConnection() };
      f.manager.saveAndRefresh({ config: next });
      await f.manager.refresh();
      assert.equal(f.discoverCalls.length, 0, "no request is sent without a key");
      const service = f.service();
      assert.equal(service?.authState, "missing-key");
      assert.match(service?.detail ?? "", /API Key/);
    });

    await test("a stored key that cannot travel in an HTTP header is reported instead of fetched", async () => {
      const f = new Fixture();
      f.saveNewConnection(KEY_A);
      await f.manager.refresh();
      const ref = f.configValue.connections![CONNECTION_ID].credentialRef!;
      // The settings panel stores whatever was pasted; a value like an error
      // message contains Chinese and would make fetch throw a ByteString error.
      f.keys.set(ref, "工具能力保存失败：未保存的草稿已保留。");
      const before = f.discoverCalls.length;
      await f.manager.refresh();
      assert.equal(f.discoverCalls.length, before, "an unusable key must not reach the network");
      const service = f.service();
      assert.match(service?.detail ?? "", /中文|请求头/, "the row explains why the catalogue cannot load");
      assert.deepEqual(service?.models, {}, "no catalogue is projected for an unusable key");
    });

    await test("the discovery function rejects non-ASCII keys before sending any request", async () => {
      let requests = 0;
      const fetchImpl = (async () => { requests += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
      await assert.rejects(
        discoverOpenRouterCapabilities("工具能力保存失败：中文", { fetchImpl }),
        /请求头|中文/,
        "a key with Chinese characters must fail with an actionable reason",
      );
      assert.equal(requests, 0, "the header crash is prevented, not caught after a request");
      assert.match(
        describeOpenRouterCatalogError(new Error("Cannot convert argument to a ByteString because the character at index 7 has a value of 24037 which is greater than 255")),
        /重新复制/,
        "a low-level header error is mapped to an actionable sentence",
      );
    });

    await test("main-side wiring: save starts discovery and refreshBuiltinMediaServices awaits it", () => {
      // out/tests/<name>.mjs -> repository root, independent of the runner's cwd.
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const source = readFileSync(join(repoRoot, "src/main/agent/AgentService.ts"), "utf8");
      const saveBody = /saveBuiltinCapabilitySettings\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
      assert.match(saveBody, /saveAndRefresh\(request\)/, "saveBuiltinCapabilitySettings must start catalogue discovery");
      const refreshBody = /refreshBuiltinMediaServices\(\)[^{]*\{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
      assert.match(refreshBody, /mediaCapabilityServices\.refresh\(\)/, "refreshBuiltinMediaServices must await a catalogue pass");
      assert.match(refreshBody, /getBuiltinCapabilities\(\)/, "refreshBuiltinMediaServices must return the refreshed snapshot");
    });

    assert.equal(networkCalls, 0, "discovery must always use the injected implementation in tests");
    if (failures.length) throw new Error(`${failures.length} OpenRouter autoload checks failed: ${failures.join("; ")}`);
    console.log(`openrouter model autoload: ${passed} checks passed`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
