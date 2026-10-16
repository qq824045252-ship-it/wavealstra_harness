/** Magpie gateway catalog regression: MyBuddy's Magpie provider pulls /v1/models
 * through Pi's own refreshModels, while models.json stays the layer Magpie wrote.
 * Offline: the gateway is a stubbed globalThis.fetch, as in the Command Code
 * catalog regression; no socket, no real gateway, no model calls. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerMyBuddyProviders } from "../src/main/agent/providers";
import { MAGPIE_PROVIDER_ID } from "../src/main/agent/providers/magpie";

const GATEWAY_KEY = "fixture-gateway-key";
const USER_AGENT = "MyBuddy";
const liveRows = [
  {
    id: "vendor/new-chat",
    object: "model",
    display_name: "New Chat",
    reasoning: true,
    supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "high" }],
    context_window: 262144,
    max_output_tokens: 32768,
    modalities: { input: ["text", "image"] },
    native_endpoints: ["/v1/chat/completions"],
  },
  {
    id: "vendor/new-responses",
    object: "model",
    display_name: "New Responses",
    reasoning: false,
    context_window: 128000,
    native_endpoints: ["/v1/responses"],
  },
  {
    id: "vendor/new-anthropic",
    object: "model",
    display_name: "New Anthropic",
    reasoning: true,
    supported_reasoning_levels: [{ effort: "low" }],
    context_window: 200000,
    native_endpoints: ["/v1/messages"],
  },
  // Same id as Magpie's own block, with values a refresh must not win.
  { id: "written", display_name: "From the gateway", context_window: 999, native_endpoints: [] },
];

const checks: string[] = [];
const pass = (label: string): void => { checks.push(label); console.log("PASS " + label); };
const requests: Array<{ url?: string; authorization?: string; userAgent?: string }> = [];
let failCatalog = false;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  requests.push({
    url,
    authorization: headers.get("authorization") ?? undefined,
    userAgent: headers.get("user-agent") ?? undefined,
  });
  if (failCatalog) return new Response("unavailable", { status: 503 });
  return new Response(JSON.stringify({ object: "list", data: liveRows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const root = mkdtempSync(join(tmpdir(), "mybuddy-magpie-catalog-"));
async function createRuntime(dir: string, models: Record<string, unknown>): Promise<ModelRuntime> {
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: models }, null, 2));
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(dir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const magpie = models.magpie as { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined;
  registerMyBuddyProviders(runtime, {
    magpieConfig: () => magpie && { baseUrl: magpie.baseUrl, apiKey: magpie.apiKey, headers: magpie.headers },
  });
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

try {
  // The gateway address only has to be a URL the stub answers for.
  const gatewayV1 = "http://127.0.0.1:3425/v1";
  const gatewayRoot = "http://127.0.0.1:3425";
  const models = {
    magpie: {
      name: "magpie",
      baseUrl: gatewayV1,
      api: "openai-completions",
      apiKey: GATEWAY_KEY,
      headers: { "User-Agent": USER_AGENT },
      models: [{
        id: "written",
        name: "Written by Magpie",
        api: "anthropic-messages",
        baseUrl: gatewayRoot,
        reasoning: true,
        thinkingLevelMap: { low: "low", high: "high" },
        contextWindow: 200000,
        maxTokens: 8192,
      }],
    },
  };
  const runtime = await createRuntime(root, models);

  const written = runtime.getModel(MAGPIE_PROVIDER_ID, "written");
  assert.equal(written?.api, "anthropic-messages", "models.json must keep the native API Magpie wrote");
  assert.equal(written?.name, "Written by Magpie");
  assert.equal(written?.contextWindow, 200000);
  assert.equal(written?.baseUrl, gatewayRoot, "an Anthropic model keeps the gateway root baseUrl");
  pass("models.json stays the provider block Magpie wrote");

  const refreshable = runtime.getProviders().filter((provider) => Boolean(provider.refreshModels)).map((provider) => provider.id);
  assert(refreshable.includes(MAGPIE_PROVIDER_ID), "AgentService.reloadModels must see Magpie as refreshable");
  pass("the refresh button's provider filter now includes magpie");

  const refreshed = await runtime.refresh({ providers: [MAGPIE_PROVIDER_ID], force: true, allowNetwork: true });
  assert.equal(refreshed.errors.size, 0, `refresh must not fail: ${[...refreshed.errors.values()].map(String).join("; ")}`);
  assert.equal(requests.length, 1, "exactly one catalog request");
  assert.equal(requests[0]?.url, `${gatewayV1}/models`);
  assert.equal(requests[0]?.authorization, `Bearer ${GATEWAY_KEY}`, "the gateway key from models.json must be sent");
  assert.equal(requests[0]?.userAgent, USER_AGENT, "the request identity must stay MyBuddy");
  pass("a refresh reaches the gateway with the configured key and MyBuddy identity");

  const fetched = runtime.getModel(MAGPIE_PROVIDER_ID, "vendor/new-chat");
  assert(fetched, "a gateway-only model must appear after a refresh");
  assert.equal(fetched?.name, "New Chat");
  assert.equal(fetched?.contextWindow, 262144);
  assert.equal(fetched?.maxTokens, 32768);
  assert.equal(fetched?.reasoning, true);
  assert.deepEqual(fetched?.input, ["text", "image"]);
  assert.deepEqual(fetched?.thinkingLevelMap, {
    off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null,
  });
  assert.equal(fetched?.api, "openai-completions");
  assert.equal(runtime.getModel(MAGPIE_PROVIDER_ID, "vendor/new-responses")?.api, "openai-responses");
  // Pi overrides a fetched model's baseUrl with providers.magpie.baseUrl, so a
  // gateway-only Anthropic model stays on Chat until Magpie writes the block.
  assert.equal(runtime.getModel(MAGPIE_PROVIDER_ID, "vendor/new-anthropic")?.api, "openai-completions");
  pass("gateway rows become Pi models with their real parameters");

  const kept = runtime.getModel(MAGPIE_PROVIDER_ID, "written");
  assert.equal(kept?.api, "anthropic-messages", "a fetched row must not override Magpie's own entry");
  assert.equal(kept?.name, "Written by Magpie");
  assert.equal(kept?.contextWindow, 200000);
  pass("a refresh only adds models Magpie has not written yet");

  const auth = await runtime.getAuth(MAGPIE_PROVIDER_ID);
  assert.equal(auth?.auth.apiKey, GATEWAY_KEY);
  assert.equal(auth?.auth.headers?.["User-Agent"], USER_AGENT, "usage attribution depends on this header");
  pass("the gateway key and MyBuddy User-Agent stay Pi's resolved auth");

  const restarted = await createRuntime(root, models);
  assert(restarted.getModel(MAGPIE_PROVIDER_ID, "vendor/new-chat"), "Pi's store must restore the fetched catalog offline");
  assert.equal(requests.length, 1, "an offline runtime must not call the gateway");
  assert(readFileSync(join(root, "models-store.json"), "utf8").includes("vendor/new-chat"));
  pass("a restart restores the fetched catalog from Pi's own store");

  failCatalog = true;
  const failed = await restarted.refresh({ providers: [MAGPIE_PROVIDER_ID], force: true, allowNetwork: true });
  assert.equal(failed.errors.size, 1, "a 503 must surface as one provider error");
  assert(restarted.getModel(MAGPIE_PROVIDER_ID, "vendor/new-chat"), "a failed refresh keeps the last good catalog");
  failCatalog = false;
  pass("a failed refresh keeps the last good catalog");

  const bareDir = mkdtempSync(join(tmpdir(), "mybuddy-magpie-bare-"));
  try {
    const bare = await createRuntime(bareDir, {});
    const phantom = bare.getProvider(MAGPIE_PROVIDER_ID);
    assert(phantom, "the native provider exists even without a Magpie config");
    assert.equal(phantom?.auth.apiKey?.login, undefined, "without config it offers no login, so the provider list skips it");
    assert.equal(bare.getModels(MAGPIE_PROVIDER_ID).length, 0);
    assert.equal((await bare.getAvailable()).filter((model) => model.provider === MAGPIE_PROVIDER_ID).length, 0);
    pass("no Magpie config leaves no phantom provider or models");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ suite: "magpie-gateway-catalog", passed: checks.length, gatewayCalls: requests.length }));
} catch (error) {
  // test:all runs children with stdio ignored; keep the reason on disk.
  writeFileSync(
    join(process.cwd(), "out/tests/magpie-gateway-catalog-failure.log"),
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    "utf-8",
  );
  throw error;
} finally {
  globalThis.fetch = nativeFetch;
  rmSync(root, { recursive: true, force: true });
}
