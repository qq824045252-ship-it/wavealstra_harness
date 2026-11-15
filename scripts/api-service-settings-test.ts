import assert from "node:assert/strict";
import { MEDIA_PROVIDER_PRESETS, connectionCapabilities, connectionRequiresModel } from "../src/shared/media-capabilities";
import {
  API_SERVICE_PROTOCOL_SETTINGS, API_WEB_SERVICE_BINDINGS, apiConnectionUsedForWeb, apiServiceCapabilityLabels,
  apiServiceMediaControls, createApiServiceConnection, selectedWebServiceConnection, webServiceConnections,
  webSettingsDependOnConnections,
} from "../src/shared/api-service-settings";
import { deepseekNativeOptions } from "../src/shared/deepseek";
import { modelNativeCapabilitySchema, nativeCapabilityPatch, nativeCapabilityValue } from "../src/shared/model-native-settings";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS API service settings: ${name}`); }
const deepseek = createApiServiceConnection("deepseek");
const openrouter = createApiServiceConnection("openrouter");
const binding = API_WEB_SERVICE_BINDINGS.find(item => item.provider === "deepseek")!;
const one = { "api-one": deepseek, "api-router": openrouter };
const two = { ...one, "api-two": { ...deepseek, name: "Second account" } };
const single = { mode: "single", providers: [binding.provider] };
const automatic = { mode: "auto", providers: [] };
const other = { mode: "single", providers: ["tavily"] };

test("all presets share the same creation path without credentials", () => {
  assert.equal(new Set(MEDIA_PROVIDER_PRESETS.map(item => item.id)).size, MEDIA_PROVIDER_PRESETS.length);
  for (const preset of MEDIA_PROVIDER_PRESETS) {
    const connection = createApiServiceConnection(preset.id);
    assert.equal(connection.protocol, preset.protocol);
    assert.equal(connection.baseUrl, preset.baseUrl);
    assert.equal(connection.presetId, preset.id);
    assert.deepEqual(connectionCapabilities(connection), preset.capabilities);
    assert.equal(connection.auth, API_SERVICE_PROTOCOL_SETTINGS[preset.protocol].auth);
    assert(!Object.hasOwn(connection, "credentialRef"));
    assert(!Object.hasOwn(connection, "apiKey"));
  }
});
test("custom services retain generic and recognition defaults", () => {
  assert.equal(createApiServiceConnection(undefined, undefined, 3).name, "API 服务 3");
  assert.equal(createApiServiceConnection(undefined).protocol, "openai-compatible");
  assert.equal(createApiServiceConnection(undefined, "ocr").protocol, "mistral-ocr");
  assert.equal(createApiServiceConnection(undefined).baseUrl, "");
});
test("unknown presets and unsupported capabilities do not create misleading services", () => {
  assert.throws(() => createApiServiceConnection("not-registered"));
  assert.throws(() => createApiServiceConnection("deepseek", "image-generation"));
  assert.throws(() => createApiServiceConnection("baidu-ocr", "text-to-speech"));
});
test("model-free services stay model-free; routed model selection is retained", () => {
  assert.equal(connectionRequiresModel(deepseek), false);
  assert.equal(connectionRequiresModel(openrouter), true);
  assert.equal(deepseek.timeoutMs, 180_000);
  assert.equal(createApiServiceConnection("baidu-ocr").auth, "baidu-ak-sk");
});
test("media options describe actual adapters rather than exposing every control", () => {
  const options = apiServiceMediaControls(deepseek);
  assert.equal(options.ocrPurpose?.options.length, 2);
  assert.deepEqual(options.speech?.voices.map(item => item.id), ["stella", "tide"]);
  assert.deepEqual(options.speech?.transports.map(item => item.id), ["websocket", "http"]);
  assert.equal(options.speech?.defaultTransport, "websocket");
  assert.equal(apiServiceMediaControls(openrouter).speech, undefined);
  assert.deepEqual(apiServiceMediaControls(), {});
});
test("a multi-model provider does not gain unimplemented web tool endpoints", () => {
  assert(apiServiceCapabilityLabels(deepseek).includes("联网搜索"));
  assert(apiServiceCapabilityLabels(deepseek).includes("网页读取"));
  assert(!apiServiceCapabilityLabels(openrouter).includes("联网搜索"));
  assert(!apiServiceCapabilityLabels(deepseek).includes("图片生成"));
  assert.deepEqual(webServiceConnections(binding, one).map(([id]) => id), ["api-one"]);
  assert.equal(webServiceConnections(binding, { bad: { ...deepseek, presetId: undefined } }).length, 0);
});
test("automatic selection requires exactly one matching connection", () => {
  assert.equal(selectedWebServiceConnection(binding, {}, one)?.[0], "api-one");
  assert.equal(selectedWebServiceConnection(binding, {}, two), undefined);
  assert.equal(selectedWebServiceConnection(binding, {}, {}), undefined);
});
test("explicit second-account selection survives reordering and serialization", () => {
  const value = JSON.parse(JSON.stringify({ deepseekConnectionId: "api-two" }));
  assert.equal(selectedWebServiceConnection(binding, value, two)?.[0], "api-two");
  assert.equal(selectedWebServiceConnection(binding, value, { "api-two": two["api-two"], ...one })?.[0], "api-two");
});
test("missing or wrong-protocol explicit references never silently fall back", () => {
  assert.equal(selectedWebServiceConnection(binding, { deepseekConnectionId: "api-removed" }, one), undefined);
  assert.equal(selectedWebServiceConnection(binding, { deepseekConnectionId: "api-router" }, one), undefined);
});
test("web references are accounted for without creating a new configuration store", () => {
  assert(apiConnectionUsedForWeb("api-one", { deepseekConnectionId: "api-one" }, other, one));
  assert(apiConnectionUsedForWeb("api-one", {}, single, one));
  assert(apiConnectionUsedForWeb("api-one", { fetchProvider: "deepseek" }, other, one));
  assert(!apiConnectionUsedForWeb("api-router", {}, single, one));
  assert(!apiConnectionUsedForWeb("api-one", {}, automatic, one), "an unpinned automatic candidate can be removed");
});
test("dependent saves wait for connections, including automatic search", () => {
  assert(webSettingsDependOnConnections({}, single, {}));
  assert(webSettingsDependOnConnections({ fetchProvider: "deepseek" }, other, {}));
  assert(webSettingsDependOnConnections({ deepseekConnectionId: "api-one" }, other, one));
  assert(webSettingsDependOnConnections({}, automatic, one));
  assert(!webSettingsDependOnConnections({}, other, one));
  assert(!webSettingsDependOnConnections({}, automatic, { "api-router": openrouter }));
});
test("selection and option projections never mutate saved objects", () => {
  const before = JSON.stringify(two);
  webServiceConnections(binding, two);
  selectedWebServiceConnection(binding, {}, two);
  apiServiceCapabilityLabels(two["api-one"]);
  assert.equal(JSON.stringify(two), before);
});
const initial = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com",
  compat: { supportsStore: false, anotherAdapter: { retained: true }, mybuddyDeepSeek: { unrelated: "keep" } } };
test("native controls are adapter-declared; unrelated providers have no false controls", () => {
  const schema = modelNativeCapabilitySchema(initial)!;
  assert.deepEqual(schema.fields.map(field => field.id), ["webSearch", "readUrl", "files"]);
  assert.equal(modelNativeCapabilitySchema({ ...initial, provider: "openrouter" }), undefined);
  assert.equal(modelNativeCapabilitySchema({ provider: "unknown" }), undefined);
  assert.equal(nativeCapabilityValue(initial, schema, schema.fields[0]), false);
});
test("native edits preserve all unrelated compat and native fields", () => {
  let model = { ...initial, ...nativeCapabilityPatch(initial, "webSearch", true) };
  model = { ...model, ...nativeCapabilityPatch(model, "readUrl", true) };
  model = { ...model, ...nativeCapabilityPatch(model, "files", "rich") };
  assert.deepEqual(model.compat, { ...initial.compat, mybuddyDeepSeek: { unrelated: "keep", webSearch: true, readUrl: true, files: "rich" } });
  assert.deepEqual(deepseekNativeOptions(JSON.parse(JSON.stringify(model))), { webSearch: true, readUrl: true, files: "rich" });
  assert.deepEqual(initial.compat.mybuddyDeepSeek, { unrelated: "keep" });
});
test("turning settings off preserves explicit false and removes optional file mode", () => {
  let model = { ...initial, ...nativeCapabilityPatch(initial, "files", "text") };
  model = { ...model, ...nativeCapabilityPatch(model, "webSearch", false) };
  model = { ...model, ...nativeCapabilityPatch(model, "files", "") };
  const stored = JSON.parse(JSON.stringify(model));
  assert.deepEqual(stored.compat.mybuddyDeepSeek, { unrelated: "keep", webSearch: false });
  assert.deepEqual(deepseekNativeOptions(stored), {});
});
test("all official protocols retain endpoint/model gates", () => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    const model = { ...initial, api, baseUrl: api === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : initial.baseUrl };
    assert(modelNativeCapabilitySchema(model)!.supported(model));
    assert.equal(deepseekNativeOptions({ ...model, ...nativeCapabilityPatch(model, "readUrl", true) }).readUrl, true);
  }
  for (const model of [{ ...initial, baseUrl: "https://gateway.example/v1" }, { ...initial, id: "deepseek-v4-pro" },
    { ...initial, api: "anthropic-messages" }, { ...initial, provider: "openrouter" }]) {
    const before = JSON.stringify(model);
    assert.throws(() => nativeCapabilityPatch(model, "webSearch", true));
    assert.equal(JSON.stringify(model), before);
  }
});
test("invalid native field names and values are rejected", () => {
  assert.throws(() => nativeCapabilityPatch(initial, "__proto__", true));
  assert.throws(() => nativeCapabilityPatch(initial, "webSearch", "true"));
  assert.throws(() => nativeCapabilityPatch(initial, "files", "unsupported"));
  assert.throws(() => nativeCapabilityPatch(initial, "files", true));
});
console.log(`PASS unified API service settings: ${passed} groups`);
