/** Offline regression for the Pi 0.99 typed-model catalog; no provider completion calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerMyBuddyProviders } from "../src/main/agent/providers";
import catalog from "../src/main/agent/providers/command-code.models.json";

const root = mkdtempSync(join(tmpdir(), "model-catalog-update-test-"));
const nativeFetch = globalThis.fetch;
const checks: string[] = [];
const check = (label: string, fn: () => void) => { fn(); checks.push(label); console.log("PASS " + label); };
async function create(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: join(root, "models.json"), authPath: join(root, "auth.json"), allowModelNetwork: false, refreshOnCreate: false });
  registerMyBuddyProviders(runtime);
  await runtime.getAvailable();
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
try {
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { commandcode: { apiKey: "offline-test-never-sent" } } }));
  const settings = SettingsManager.create(root, root);
  settings.setEnabledModels(["commandcode/deepseek/deepseek-v4.1-flash", "openai-codex/gpt-6-sol"]);
  await settings.flush();
  const settingsBefore = readFileSync(join(root, "settings.json"), "utf8");
  const runtime = await create();
  check("fresh offline runtime publishes the bundled Command Code catalog through getAllModels", () => {
    assert.equal(runtime.getModels("commandcode").length, catalog.models.length);
    assert(runtime.getModel("commandcode", "gpt-6.1-sol"), "Pi 0.99 ignores a getModels-only fallback; getAllModels must expose it too");
  });
  check("native Codex catalog includes GPT-6.1 Sol", () => assert(runtime.getModel("openai-codex", "gpt-6.1-sol")));
  check("bundled snapshot has unique exact IDs and supported conversation endpoints", () => {
    assert.equal(new Set(catalog.models.map(m => m.id)).size, catalog.models.length);
    assert(catalog.models.every(m => m.context_length > 0 && m.supported_endpoints.length > 0));
  });
  const oldCodex = runtime.getModels("openai-codex").filter(m => m.id !== "gpt-6.1-sol");
  writeFileSync(join(root, "models-store.json"), JSON.stringify({ "openai-codex": { models: oldCodex, checkedAt: Date.now(), lastModified: 0 } }));
  const restored = await create();
  check("old Codex cache cannot hide a newer bundled model", () => assert(restored.getModel("openai-codex", "gpt-6.1-sol")));
  let requested = 0;
  const liveRows = catalog.models.filter(m => ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"].includes(m.id));
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, "https://api.commandcode.ai/provider/v1/models");
    assert(!(new Headers(init?.headers).has("authorization")), "Public catalog does not require exposing credentials");
    requested++;
    return new Response(JSON.stringify({ data: liveRows }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const fresh = await restored.refresh({ providers: ["commandcode"], force: true, allowNetwork: true });
  check("explicit native refresh publishes the new list and removes stale snapshot-only entries", () => {
    assert.equal(fresh.errors.size, 0); assert.equal(requested, 1);
    assert.deepEqual(restored.getModels("commandcode").map(m => m.id).sort(), liveRows.map(m => m.id).sort());
  });
  const cached = await create();
  check("restart restores the successful live catalog, not the older bundled fallback", () => {
    assert.deepEqual(cached.getModels("commandcode").map(m => m.id).sort(), liveRows.map(m => m.id).sort());
  });
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  const failed = await cached.refresh({ providers: ["commandcode"], force: true, allowNetwork: true });
  check("failed catalog refresh preserves the last good models and reports an error", () => {
    assert.equal(failed.errors.size, 1);
    assert.deepEqual(cached.getModels("commandcode").map(m => m.id).sort(), liveRows.map(m => m.id).sort());
  });
  check("model discovery never changes enabled scope or settings", () => assert.equal(readFileSync(join(root, "settings.json"), "utf8"), settingsBefore));
  console.log(JSON.stringify({ suite: "model-catalog-update", passed: checks.length, providerCalls: 0 }));
} finally {
  globalThis.fetch = nativeFetch;
  rmSync(root, { recursive: true, force: true });
}
