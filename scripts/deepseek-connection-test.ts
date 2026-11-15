import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { createDeepSeekConnectionResolver } from "../src/main/capabilities/providers/DeepSeekConnection";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { connectionCapabilities, connectionRequiresModel, DEEPSEEK_API_ROOT, MEDIA_PROVIDER_PRESETS } from "../src/shared/media-capabilities";

const root = mkdtempSync(join(tmpdir(), "mybuddy-deepseek-connection-"));
const key = "fixture-deepseek-private-key";
try {
  const store = new BuiltinCapabilityStore(join(root, "capabilities.json"));
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.connections = {
    "api-deepseek": { name: "DeepSeek", presetId: "deepseek", protocol: "deepseek", baseUrl: DEEPSEEK_API_ROOT, auth: "api-key", credentialRef: "media.deepseek", timeoutMs: 180_000 },
    "api-flux": { name: "FLUX", presetId: "black-forest-labs", protocol: "black-forest-labs", baseUrl: "https://api.bfl.ai/v1", auth: "api-key", credentialRef: "media.flux", timeoutMs: 60_000 },
    "api-dashscope": { name: "DashScope", presetId: "dashscope", protocol: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1", auth: "api-key", credentialRef: "media.dashscope", timeoutMs: 60_000 },
  };
  config.mediaBindings = {
    ocr: { connectionId: "api-deepseek", selection: "manual", ocrPurpose: "rich_layout_recognition", dataPolicy: "allow-cloud" },
    "speech-to-text": { connectionId: "api-deepseek", selection: "manual" },
    "text-to-speech": { connectionId: "api-deepseek", selection: "manual" },
  };
  const saved = store.write(config);
  let current = new BuiltinCapabilityStore(store.path).read();
  assert.deepEqual(current, saved, "native protocols and model-free bindings survive a real store reopen");
  assert.equal(Object.keys(current.connections!).length, 3, "normalization keeps every registered native protocol");
  assert.equal(current.mediaBindings!.ocr!.ocrPurpose, "rich_layout_recognition");
  assert.equal(current.mediaBindings!.ocr!.model, undefined);
  assert(!readFileSync(store.path, "utf8").includes(key), "persistence contains credential references only");
  assert.equal(connectionRequiresModel(current.connections!["api-deepseek"]), false);
  assert.deepEqual(connectionCapabilities(current.connections!["api-deepseek"]), ["speech-to-text", "ocr", "text-to-speech"]);
  assert.deepEqual(connectionCapabilities({ ...current.connections!["api-deepseek"], presetId: undefined }), []);
  assert.equal(MEDIA_PROVIDER_PRESETS.find(preset => preset.id === "deepseek")?.baseUrl, DEEPSEEK_API_ROOT);
  console.log("PASS model-free DeepSeek configuration, OCR purpose and existing native presets survive restart");

  const keys = new Map([["media.deepseek", key]]);
  const resolver = createDeepSeekConnectionResolver({ getConfig: () => current, getCredential: ref => keys.get(ref) ?? null, hasCredential: ref => keys.has(ref) });
  assert(resolver.isConfigured());
  assert.deepEqual(await resolver.resolve(), { id: "api-deepseek", baseUrl: DEEPSEEK_API_ROOT, apiKey: key, timeoutMs: 180_000 });
  await assert.rejects(resolver.resolve("api-missing"), /已移除或不可用/);
  assert.equal(resolver.isConfigured("api-flux"), false);
  console.log("PASS shared key resolver selects the sole official connection and never substitutes an explicit missing service");

  current.connections!["api-second"] = { ...current.connections!["api-deepseek"], name: "Second" };
  assert.equal(resolver.isConfigured(), false);
  await assert.rejects(resolver.resolve(), /添加并选择/);
  assert.equal((await resolver.resolve("api-second")).id, "api-second");
  delete current.connections!["api-second"];
  keys.clear();
  assert.equal(resolver.isConfigured(), false);
  await assert.rejects(resolver.resolve(), /API Key 缺失/);
  keys.set("media.deepseek", key + "\ninvalid");
  await assert.rejects(resolver.resolve(), error => error instanceof Error && /API Key 缺失或含/.test(error.message) && !error.message.includes(key));
  keys.set("media.deepseek", key);
  console.log("PASS multiple connections require selection; removed and malformed credentials fail without secret disclosure");

  const valid = structuredClone(current.connections!["api-deepseek"]);
  for (const invalid of [{ baseUrl: "https://unrelated.example" }, { presetId: undefined }, { auth: "none" as const }, { timeoutMs: 0 }, { timeoutMs: 600_001 }]) {
    current.connections!["api-deepseek"] = { ...valid, ...invalid };
    assert.equal(resolver.isConfigured(), false);
    await assert.rejects(resolver.resolve());
  }
  current.connections!["api-deepseek"] = valid;
  assert.equal((await resolver.resolve()).apiKey, key);
  current = new BuiltinCapabilityStore(store.path).read();
  delete current.connections!["api-deepseek"];
  assert.equal(resolver.isConfigured("api-deepseek"), false, "resolver observes live removal instead of retaining stale credentials");
  console.log("PASS official endpoint/auth/timeout boundaries and live configuration reload");
} finally {
  rmSync(root, { recursive: true, force: true });
}
