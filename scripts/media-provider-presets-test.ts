import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import {
  API_PROTOCOL_CAPABILITIES, MEDIA_PROVIDER_PRESETS, MEDIA_CAPABILITY_IDS,
  OPENROUTER_API_ROOT, connectionCapabilities, type ApiCapabilityConnection,
} from "../src/shared/media-capabilities";

const ids = MEDIA_PROVIDER_PRESETS.map(p => p.id);
assert.equal(new Set(ids).size, ids.length, "each preset has a stable identity");
assert.deepEqual(MEDIA_PROVIDER_PRESETS.find(p => p.id === "openrouter")?.capabilities, MEDIA_CAPABILITY_IDS);
assert(!MEDIA_PROVIDER_PRESETS.find(p => p.id === "openai")?.capabilities.includes("video-generation"),
  "the discontinued direct OpenAI video endpoint must not be advertised");

// Native task-API presets: FLUX (Black Forest Labs) and 百炼 (DashScope) cover image + video only.
const bfl = MEDIA_PROVIDER_PRESETS.find(p => p.id === "black-forest-labs");
assert(bfl, "the FLUX preset exists");
assert.equal(bfl!.protocol, "black-forest-labs");
assert.equal(bfl!.baseUrl, "https://api.bfl.ai/v1");
assert.deepEqual(bfl!.capabilities, ["image-generation", "video-generation"]);
assert(bfl!.models?.["image-generation"]?.some(model => model.id === "flux-3-image"), "FLUX image models are selectable");
assert(bfl!.models?.["video-generation"]?.some(model => model.id === "flux-3-video"), "FLUX video models are selectable");
assert.deepEqual(API_PROTOCOL_CAPABILITIES["black-forest-labs"], ["image-generation", "video-generation"]);

const dashscope = MEDIA_PROVIDER_PRESETS.find(p => p.id === "dashscope");
assert(dashscope, "the DashScope preset exists");
assert.equal(dashscope!.protocol, "dashscope");
assert.equal(dashscope!.baseUrl, "https://dashscope.aliyuncs.com/api/v1");
assert.deepEqual(dashscope!.capabilities, ["image-generation", "video-generation"]);
assert(dashscope!.models?.["video-generation"]?.length, "DashScope exposes at least one video model");
assert.deepEqual(API_PROTOCOL_CAPABILITIES.dashscope, ["image-generation", "video-generation"]);
assert(!API_PROTOCOL_CAPABILITIES.dashscope.includes("speech-to-text"), "native task APIs never claim audio");
assert.deepEqual(
  connectionCapabilities({ name: "FLUX", presetId: "black-forest-labs", protocol: "black-forest-labs", baseUrl: "https://api.bfl.ai/v1", auth: "api-key", timeoutMs: 60000 }),
  ["image-generation", "video-generation"],
  "a saved FLUX connection advertises exactly its two capabilities",
);

const temp = mkdtempSync(join(tmpdir(), "mybuddy-providers-"));
try {
  const store = new BuiltinCapabilityStore(join(temp, "capabilities.json"));
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.imageGeneration.enabled = false; // A disabled capability is never auto-enabled.
  const openrouter: ApiCapabilityConnection = {
    name: "OpenRouter", presetId: "openrouter", protocol: "openrouter",
    baseUrl: OPENROUTER_API_ROOT, auth: "api-key", credentialRef: "media.shared-key", timeoutMs: 180000,
  };
  config.connections = {
    "api-primary": openrouter,
    "api-secondary": {
      name: "Mistral OCR", presetId: "mistral-ocr", protocol: "mistral-ocr",
      baseUrl: "https://api.mistral.ai/v1", auth: "api-key", credentialRef: "media.ocr-key", timeoutMs: 120000,
    },
  };
  config.mediaBindings = Object.fromEntries(MEDIA_CAPABILITY_IDS.map(capability => [
    capability, { connectionId: "api-primary", model: "provider/" + capability, selection: "manual",
      ...(capability === "ocr" ? { dataPolicy: "local-only" } : {}),
    },
  ]));
  assert.deepEqual(connectionCapabilities(openrouter), MEDIA_CAPABILITY_IDS);
  assert.deepEqual(connectionCapabilities(config.connections["api-secondary"]), ["ocr"]);
  assert.deepEqual(connectionCapabilities({ ...openrouter, presetId: "mistral-ocr" }), [],
    "a preset whose declared protocol does not match must advertise no capability");
  assert.deepEqual(connectionCapabilities({ ...openrouter, presetId: undefined }), API_PROTOCOL_CAPABILITIES.openrouter,
    "manually created compatible connections retain existing generic paths");

  const saved = store.write(config);
  const afterRestart = new BuiltinCapabilityStore(store.path).read();
  assert.deepEqual(afterRestart, saved);
  assert.equal(afterRestart.connections!["api-primary"].presetId, "openrouter");
  assert.equal(afterRestart.connections!["api-primary"].credentialRef, "media.shared-key");
  assert.equal(afterRestart.imageGeneration.enabled, false);
  assert.equal(afterRestart.mediaBindings?.ocr?.dataPolicy, "local-only");
  assert(MEDIA_CAPABILITY_IDS.every(capability => afterRestart.mediaBindings?.[capability]?.connectionId === "api-primary"),
    "a single provider remains referenced by all five capabilities");
  console.log("PASS provider presets: shared references, schema-v1 persistence, capability guards and privacy");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
