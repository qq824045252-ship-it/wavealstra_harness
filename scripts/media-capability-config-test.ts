import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";

const root = mkdtempSync(join(tmpdir(), "mybuddy-media-config-"));
try {
  const store = new BuiltinCapabilityStore(join(root, "capabilities.json"));
  assert.equal(store.read().mediaBindings?.["image-generation"]?.selection, "auto");
  const legacy = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  delete legacy.connections;
  delete legacy.mediaBindings;
  legacy.imageGeneration.enabled = false;
  legacy.imageGeneration.provider = "custom-image";
  legacy.services = {
    private: { adapter: "http-ocr", endpoint: "http://127.0.0.1:8000/ocr", model: "ocr", credentialRef: "shared-key", location: "local", dataPolicy: "local-only", timeoutMs: 50_000 },
  };
  legacy.ocr = { enabled: true, serviceId: "private" };
  writeFileSync(store.path, JSON.stringify(legacy));
  const migrated = store.read();
  assert.equal(migrated.imageGeneration.enabled, false, "new defaults must not re-enable an existing preference");
  assert.equal(migrated.imageGeneration.provider, "custom-image");
  assert.equal(migrated.mediaBindings?.["image-generation"], undefined, "legacy explicit bindings must not become automatic");
  assert.deepEqual(migrated.services, legacy.services, "privacy constraints and credential references survive read");
  assert.deepEqual(migrated.ocr, legacy.ocr);

  migrated.connections = { "api-test": { name: "Shared API", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", auth: "api-key", credentialRef: "media.api-test", timeoutMs: 120_000 } };
  migrated.mediaBindings = {
    "image-generation": { connectionId: "api-test", model: "provider/image", selection: "manual" },
    "text-to-speech": { connectionId: "api-test", model: "provider/speech", selection: "manual" },
    ocr: { connectionId: "legacy:private", dataPolicy: "local-only" },
  };
  migrated.textToSpeech.model = "provider/speech";
  const saved = store.write(migrated);
  assert.deepEqual(store.read(), saved, "all new optional fields round-trip within schema v1");
  assert.equal(saved.connections!["api-test"].credentialRef, "media.api-test");
  assert.equal(saved.mediaBindings?.ocr?.dataPolicy, "local-only");
  assert.equal(saved.imageGeneration.enabled, false);
  assert.equal(saved.textToSpeech.model, "provider/speech");
  const baidu = store.read();
  baidu.connections!["api-baidu"] = {
    name: "百度 OCR", presetId: "baidu-ocr", protocol: "baidu-ocr",
    baseUrl: "https://aip.baidubce.com", auth: "baidu-ak-sk",
    credentialRefs: { apiKey: "media.baidu-key", secretKey: "media.baidu-secret" },
    timeoutMs: 60000,
  };
  baidu.mediaBindings!.ocr = { connectionId: "api-baidu", model: "general", dataPolicy: "local-only" };
  const baiduSaved = store.write(baidu);
  const reopened = new BuiltinCapabilityStore(store.path).read();
  assert.deepEqual(reopened, baiduSaved, "Baidu's two references round-trip without changing schema v1");
  assert.deepEqual(reopened.connections!["api-baidu"].credentialRefs,
    { apiKey: "media.baidu-key", secretKey: "media.baidu-secret" });
  assert.equal(reopened.mediaBindings?.ocr?.model, "general");
  assert.equal(reopened.mediaBindings?.ocr?.dataPolicy, "local-only", "Baidu does not bypass a private OCR binding");
  console.log("PASS media capability config: shared connections, Baidu dual credentials and legacy privacy");
} finally {
  rmSync(root, { recursive: true, force: true });
}
