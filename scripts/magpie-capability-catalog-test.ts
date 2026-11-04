import assert from "node:assert/strict";
import { discoverMagpieCapabilities } from "../src/main/capabilities/providers/MagpieCapabilityCatalog";

const secret = "fixture-magpie-private-key";
const requests: Array<{ url: string; method?: string; headers: Headers; redirect?: RequestRedirect; signal?: AbortSignal | null }> = [];
const modelRows = [
  {
    id: "codex/gpt-image-2", kind: "image", display_name: "GPT Image 2", magpie_label: "GPT Image 2 · Codex",
    modalities: { input: ["text", "image"], output: ["image"] }, apiKey: secret,
  },
  {
    id: "vendor/video-a", kind: "video", display_name: "Video A",
    modalities: { input: ["text", "image"], output: ["video"] },
  },
  // Even if a gateway ignores the kind filter, a vision/chat model is not
  // evidence of an image-generation, ASR or TTS endpoint for that model.
  { id: "vendor/vision", modalities: { input: ["text", "image"], output: ["text"] } },
  { id: "vendor/audio-chat", kind: "chat", modalities: { input: ["audio"], output: ["audio"] } },
  { id: "vendor/gpt-image-name-only" },
  { id: "vendor/whisper-1" },
  { id: "vendor/tts-1", kind: "audio" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(models: unknown = { data: modelRows }, info: unknown = {
  name: "magpie", version: "fixture-version", apis: ["/v1/images/generations", "/v1/videos", "/v1/audio/transcriptions", "/v1/audio/speech"],
  credentials: { apiKey: secret },
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method, headers: new Headers(init?.headers), redirect: init?.redirect, signal: init?.signal });
    return json(url.includes("/models?") ? models : info);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const config = { baseUrl: "http://127.0.0.1:3425/v1/", apiKey: secret, headers: { "User-Agent": "MyBuddy", "X-Client": "fixture" } };
  const snapshot = await discoverMagpieCapabilities(config, { fetchImpl: fakeFetch() });
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    "http://127.0.0.1:3425/v1", "http://127.0.0.1:3425/v1/models?kind=image,video",
  ]);
  for (const request of requests) {
    assert.equal(request.method, "GET", "discovery must not generate or upload media");
    assert.equal(request.redirect, "error", "a gateway redirect must not forward the identity");
    assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(request.headers.get("user-agent"), "MyBuddy");
    assert.equal(request.headers.get("x-client"), "fixture");
    assert.equal(request.headers.get("accept"), "application/json");
    assert(request.signal, "every discovery request has a deadline");
  }
  assert.deepEqual(snapshot.models, [
    { id: "codex/gpt-image-2", label: "GPT Image 2 · Codex", kind: "image", inputModalities: ["text", "image"], outputModalities: ["image"] },
    { id: "vendor/video-a", label: "Video A", kind: "video", inputModalities: ["text", "image"], outputModalities: ["video"] },
  ]);
  assert.deepEqual(snapshot.audio, {
    asr: { endpoint: "/audio/transcriptions", modelDiscovery: "manual", available: true },
    tts: { endpoint: "/audio/speech", modelDiscovery: "manual", available: true },
  });
  assert.equal(snapshot.version, "fixture-version");
  assert(!JSON.stringify(snapshot).includes(secret), "secrets and arbitrary gateway properties never become DTO data");
  assert.deepEqual(config.headers, { "User-Agent": "MyBuddy", "X-Client": "fixture" }, "reading a catalogue must not mutate the existing connection");

  requests.length = 0;
  await discoverMagpieCapabilities({ baseUrl: "https://gateway.example/proxy/v1", apiKey: secret, headers: { Authorization: "Bearer explicit-fixture" } }, { fetchImpl: fakeFetch() });
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer explicit-fixture", "explicit auth headers match the existing chat provider's precedence");
  assert(requests.some((request) => request.url === "https://gateway.example/proxy/v1/models?kind=image,video"), "a configured reverse-proxy prefix is preserved");
  requests.length = 0;
  await discoverMagpieCapabilities({ baseUrl: "http://127.0.0.1:3425" }, { fetchImpl: fakeFetch() });
  assert(requests.some((request) => request.url === "http://127.0.0.1:3425/v1/models?kind=image,video"));
  assert.equal(requests[0]?.headers.get("authorization"), null, "keyless local gateways remain keyless");

  const empty = await discoverMagpieCapabilities(config, { fetchImpl: fakeFetch({ data: [] }, { name: "magpie", apis: ["/v1/audio/transcriptions"] }) });
  assert.deepEqual(empty.models, [], "an empty media catalogue is valid; do not invent default image/video models");
  assert.equal(empty.audio.asr.available, true);
  assert.equal(empty.audio.tts.available, false);
  assert.equal(empty.audio.tts.modelDiscovery, "manual");

  for (const info of [{ name: "magpie" }, { name: "different-service", apis: ["/v1/audio/speech"] }, { name: "magpie", apis: "audio" }]) {
    const unknown = await discoverMagpieCapabilities(config, { fetchImpl: fakeFetch({ data: [] }, info) });
    assert.equal(unknown.audio.asr.available, undefined);
    assert.equal(unknown.audio.tts.available, undefined, "unavailable introspection is unknown, not a made-up audio capability");
  }
  const withoutInfo = await discoverMagpieCapabilities(config, {
    fetchImpl: (async (input) => String(input).includes("/models?") ? json({ data: modelRows }) : json({ apiKey: secret }, 404)) as typeof fetch,
  });
  assert.equal(withoutInfo.models.length, 2, "optional info failure must not discard the typed media catalogue");
  assert.equal(withoutInfo.audio.asr.available, undefined);
  assert.equal(withoutInfo.audio.tts.available, undefined);

  const noCalls = (async () => { throw new Error("invalid configuration must not send a request"); }) as typeof fetch;
  for (const baseUrl of [undefined, "invalid", "file:///tmp/secret", `https://user:${secret}@gateway.example/v1`, `https://gateway.example/v1?key=${secret}`, "https://gateway.example/v1#fragment"]) {
    await assert.rejects(discoverMagpieCapabilities({ baseUrl }, { fetchImpl: noCalls }), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  }
  await assert.rejects(discoverMagpieCapabilities({ ...config, headers: { Authorization: `Bearer ${secret}\ninvalid` } }, { fetchImpl: noCalls }), /请求头配置无效/);

  for (const malformed of [{}, { data: "not-an-array" }, { data: [null] }, { data: [{ kind: "image" }] }, { data: [modelRows[0], modelRows[0]] }]) {
    await assert.rejects(discoverMagpieCapabilities(config, { fetchImpl: fakeFetch(malformed) }));
  }
  await assert.rejects(discoverMagpieCapabilities(config, { fetchImpl: (async () => json({ error: secret }, 401)) as typeof fetch }), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert(!error.message.includes(secret));
    return true;
  });
  for (const fetchImpl of [
    (async () => { throw new Error(`network failure: Authorization Bearer ${secret}`); }) as typeof fetch,
    (async () => new Response(`invalid JSON containing ${secret}`, { status: 200 })) as typeof fetch,
  ]) {
    await assert.rejects(discoverMagpieCapabilities(config, { fetchImpl }), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  }

  const abort = new AbortController();
  abort.abort(new Error(secret));
  await assert.rejects(discoverMagpieCapabilities(config, { fetchImpl: noCalls, signal: abort.signal }), /已取消或超时/);
  const duringInfo = new AbortController();
  await assert.rejects(discoverMagpieCapabilities(config, {
    signal: duringInfo.signal,
    fetchImpl: (async (input) => {
      if (String(input).includes("/models?")) return json({ data: modelRows });
      // Cancellation still matters after the required catalogue has arrived.
      duringInfo.abort(new Error(secret));
      return json({ name: "magpie", apis: [] });
    }) as typeof fetch,
  }), /已取消或超时/);
  await assert.rejects(discoverMagpieCapabilities(config, { fetchImpl: noCalls, timeoutMs: 0 }), /超时设置无效/);

  console.log("Magpie capability catalog: passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
