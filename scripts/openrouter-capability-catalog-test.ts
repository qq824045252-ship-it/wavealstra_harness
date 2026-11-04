import assert from "node:assert/strict";
import { discoverOpenRouterCapabilities } from "../src/main/capabilities/providers/OpenRouterCapabilityCatalog";
import { OPENROUTER_API_ROOT } from "../src/shared/media-capabilities";

const key = "fixture-private-openrouter-token";
const calls: Array<{ path: string; headers: Headers; method?: string; redirect?: RequestRedirect; signal?: AbortSignal | null }> = [];
const catalog: Record<string, unknown> = {
  "/images/models": { data: [
    null, false, "invalid", [], {}, { id: null },
    { id: "images/one", name: "Image One", architecture: { output_modalities: ["image"] }, secret: key },
    { id: "not-an-image", architecture: { output_modalities: ["text"] } },
  ] },
  "/videos/models": { data: [{ id: "videos/one", name: "Video One" }] },
  "/models?output_modalities=speech": { data: [
    { id: "tts/one", name: "TTS One", supported_voices: ["nova", "alloy", "nova"], architecture: { output_modalities: ["speech"] } },
    { id: "wrong-audio", architecture: { output_modalities: ["text"] } },
  ] },
  "/models?output_modalities=transcription": { data: [{ id: "stt/one", name: "STT One", architecture: { output_modalities: ["transcription"] } }] },
  "/models?input_modalities=image&output_modalities=text": { data: [
    { id: "ocr/one", name: "Vision OCR", architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
    { id: "audio-only", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
  ] },
};
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = (async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace("/api/v1", "") + url.search;
  calls.push({ path, headers: new Headers(init?.headers), method: init?.method, redirect: init?.redirect, signal: init?.signal });
  return response(catalog[path] ?? { data: [] });
}) as typeof fetch;

const all = await discoverOpenRouterCapabilities(key, { fetchImpl: fakeFetch });
assert.equal(all.partial, false);
assert.equal(calls.length, 5, "five independent catalogues, not one chat-model list");
assert.deepEqual(new Set(calls.map(c => c.path)), new Set(Object.keys(catalog)));
for (const c of calls) {
  assert.equal(c.headers.get("authorization"), "Bearer " + key);
  assert.equal(c.method, "GET");
  assert.equal(c.redirect, "error");
  assert(c.signal, "deadline and cancellation are mandatory");
}
assert.deepEqual(all.models["image-generation"], [{ id: "images/one", label: "Image One" }]);
assert.deepEqual(all.models["video-generation"], [{ id: "videos/one", label: "Video One" }]);
assert.deepEqual(all.models["speech-to-text"], [{ id: "stt/one", label: "STT One" }]);
assert.deepEqual(all.models["text-to-speech"], [{ id: "tts/one", label: "TTS One", voices: ["nova", "alloy"] }]);
assert.deepEqual(all.models.ocr, [{ id: "ocr/one", label: "Vision OCR" }]);
assert(!JSON.stringify(all).includes(key), "provider metadata must not expose credentials");
assert.equal(OPENROUTER_API_ROOT, "https://openrouter.ai/api/v1");

const partial = await discoverOpenRouterCapabilities(key, {
  fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    return path.includes("/images/models") ? response(catalog["/images/models"]) : response({ error: key }, 503);
  }) as typeof fetch,
});
assert.equal(partial.partial, true);
assert.deepEqual(partial.models["image-generation"], [{ id: "images/one", label: "Image One" }]);
assert.equal(partial.models["text-to-speech"], undefined, "failed discovery is unknown, not a fabricated empty list");
assert(!JSON.stringify(partial).includes(key));

await assert.rejects(
  discoverOpenRouterCapabilities(key, { fetchImpl: (async () => response({ error: key }, 403)) as typeof fetch }),
  error => error instanceof Error && !error.message.includes(key),
);
await assert.rejects(discoverOpenRouterCapabilities(""), /API Key/);
await assert.rejects(discoverOpenRouterCapabilities(key + "\ninvalid", { fetchImpl: fakeFetch }), /API Key/);
await assert.rejects(discoverOpenRouterCapabilities(key, { timeoutMs: 0, fetchImpl: fakeFetch }), /超时/);
const aborted = new AbortController();
aborted.abort(new Error(key));
await assert.rejects(discoverOpenRouterCapabilities(key, { signal: aborted.signal, fetchImpl: fakeFetch }),
  error => error instanceof Error && !error.message.includes(key));
console.log("PASS OpenRouter discovery: five model families, permissions, partial failure and redaction");
