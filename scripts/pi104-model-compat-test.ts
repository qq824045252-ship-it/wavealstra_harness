import { normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { migrateAzureProviderDocument, migratePiAzureProvider } from "../src/main/agent/PiAzureProviderMigration";
import { mergeModelConfig, projectModelConfig } from "../src/main/agent/ModelsConfigStore";
import { installModelInvocationAdmission } from "../src/main/agent/ModelInvocationAdmission";
import { DEFAULT_MODEL_PER_PROVIDER, pickDefaultModelAfterLogin } from "../src/shared/provider-login";
import { canonicalSubagentModelReference, resolveSubagentModelThinking } from "../src/main/capabilities/subagent/config";
const root = mkdtempSync(join(tmpdir(), "mybuddy-pi104-model-"));
const legacy = "azure-openai-responses";
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); results.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error("FAIL " + name + ": " + error); }
}
function fixtureDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks(id TEXT, cwd TEXT, model_id TEXT, updated_at INTEGER); CREATE TABLE cron_jobs(id TEXT, model_id TEXT); CREATE TABLE usage_events(provider TEXT, model TEXT)");
  return db;
}
try {
  await test("Azure provider rename preserves the Azure API ID, unknown fields and unrelated references", () => {
    const original = { providers: { [legacy]: { api: legacy, headers: { "x-fixture": "preserved" }, models: [{ id: "custom/deployment" }] }, other: { api: "openai-completions" } }, unknown: true };
    const migrated: any = migrateAzureProviderDocument("models", original);
    assert.equal(migrated.providers.azure.api, legacy);
    assert.equal(migrated.providers[legacy], undefined);
    assert.deepEqual(migrated.providers.other, original.providers.other);
    assert.deepEqual(migrated.providers.azure.headers, original.providers[legacy].headers);
    assert.equal(migrated.unknown, true);
    assert(Object.hasOwn(original.providers, legacy), "Input remains unmodified");
    assert.throws(() => migrateAzureProviderDocument("auth", { [legacy]: { key: "first" }, azure: { key: "second" } }), /同时包含不同/);
    assert.throws(() => migrateAzureProviderDocument("settings", { modelThinkingLevels: { [legacy + "/gpt-5.4"]: "high", "azure/gpt-5.4": "low" } }), /同时包含不同/);
    assert.deepEqual(migrateAzureProviderDocument("settings", { pausedProviderModels: { [legacy]: [legacy + "/gpt-5.4"], azure: ["azure/gpt-5.4"] } }), { pausedProviderModels: { azure: ["azure/gpt-5.4"] } });
  });
  await test("startup migration uses native auth storage, backs up exact originals and resumes task/cron selections idempotently", async () => {
    const dir = join(root, "migration"), cwd = join(root, "workspace");
    mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(join(dir, "modes", "coding"), { recursive: true });
    mkdirSync(join(dir, "agents"));
    const roleContents = `---\nname: azure-role\nmodel: ${legacy}/gpt-5.4\n---\nRetain this role exactly.\n`;
    writeFileSync(join(dir, "agents", "azure-role.md"), roleContents);
    const originals: Record<string, unknown> = {
      [join(dir, "auth.json")]: { [legacy]: { type: "api_key", key: "fixture-not-a-live-key" }, other: { type: "api_key", key: "other-fixture" } },
      [join(dir, "models.json")]: { providers: { [legacy]: { api: legacy, modelOverrides: { "gpt-5.4": { samplingParamsByThinkingLevel: { off: { temperature: 0.7 } } } } } } },
      [join(dir, "settings.json")]: { defaultProvider: legacy, defaultModel: "gpt-5.4", defaultModelId: legacy + "/gpt-5.4", enabledModels: [legacy + "/*", "other/*"], modelThinkingLevels: { [legacy + "/gpt-5.4"]: "high" }, pausedProviderModels: { [legacy]: [legacy + "/gpt-5.4"] }, untouched: "text " + legacy },
      [join(dir, "subagent.json")]: { defaultModel: legacy + "/gpt-5.4", timeoutMs: 120000 },
      [join(dir, "modes", "coding", "policy.json")]: { presets: [{ suggestedModelId: legacy + "/gpt-5.4", promptAddon: legacy }] },
      [join(cwd, ".pi", "settings.json")]: { defaultProvider: legacy, enabledModels: [legacy + "/gpt-5.4"] },
    };
    for (const [path, content] of Object.entries(originals)) writeFileSync(path, JSON.stringify(content));
    const db = fixtureDb();
    try {
      db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?)").run("legacy-task", cwd, legacy + "/gpt-5.4", 100);
      db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?)").run("other-task", cwd, "other/azure-openai-responses/model", 200);
      db.prepare("INSERT INTO cron_jobs VALUES (?, ?)").run("cron", legacy + "/gpt-5.4");
      db.prepare("INSERT INTO usage_events VALUES (?, ?)").run(legacy, "gpt-5.4");
      assert.deepEqual(migratePiAzureProvider(dir, db), { files: 6, selections: 2 });
      assert.deepEqual(migratePiAzureProvider(dir, db), { files: 0, selections: 0 });
      for (const [path, content] of Object.entries(originals)) assert.equal(readFileSync(path + ".pre-pi104-azure.bak", "utf8"), JSON.stringify(content));
      assert.deepEqual(db.prepare("SELECT model_id, updated_at FROM tasks WHERE id = ?").get("legacy-task"), { model_id: "azure/gpt-5.4", updated_at: 100 });
      assert.equal((db.prepare("SELECT provider FROM usage_events").get() as any).provider, legacy);
      assert.equal((db.prepare("SELECT model_id FROM tasks WHERE id = ?").get("other-task") as any).model_id, "other/azure-openai-responses/model");
      const settings = SettingsManager.create(cwd, dir);
      assert.equal(settings.getDefaultProvider(), "azure"); assert.deepEqual(settings.getEnabledModels(), ["azure/gpt-5.4"]);
      assert.equal(settings.getModelThinkingLevel("azure", "gpt-5.4"), "high");
      const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
      await runtime.refresh({ allowNetwork: false });
      assert(runtime.hasConfiguredAuth("azure")); assert(!runtime.hasConfiguredAuth(legacy));
      assert(runtime.getModel("azure", "gpt-5.4")); assert(runtime.getModel("azure", "deepseek-v4-pro"), "Azure Foundry Chat Completions is exposed by native Pi");
      const roleSelection = resolveSubagentModelThinking({ roleModel: legacy + "/gpt-5.4", transportThinkingModelId: legacy + "/gpt-5.4", transportThinking: "high" });
      const scope = await resolveModelScopeWithDiagnostics(["azure/gpt-5.4"], runtime);
      assert(scope.scopedModels.some(({ model }) => `${model.provider}/${model.id}` === roleSelection.model), "Legacy role remains in the native Azure-only model scope");
      assert.equal(roleSelection.thinking, "high");
      assert.equal(readFileSync(join(dir, "agents", "azure-role.md"), "utf8"), roleContents);
      assert.equal(JSON.parse(readFileSync(join(dir, "modes", "coding", "policy.json"), "utf8")).presets[0].promptAddon, legacy);
    } finally { db.close(); }
  });
  await test("conflicting Azure configs fail before any file, credential or selection is changed", () => {
    const dir = join(root, "conflict"); mkdirSync(dir);
    const auth = JSON.stringify({ [legacy]: { type: "api_key", key: "legacy-fixture" } });
    writeFileSync(join(dir, "auth.json"), auth);
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [legacy]: { baseUrl: "https://first.invalid" }, azure: { baseUrl: "https://second.invalid" } } }));
    const db = fixtureDb();
    try { assert.throws(() => migratePiAzureProvider(dir, db), /同时包含不同/); assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), auth); }
    finally { db.close(); }
  });
  await test("legacy Azure role/default/global selections and thinking bindings canonicalize at the subagent boundary", () => {
    const oldModel = legacy + "/deployments/team-a", model = "azure/deployments/team-a";
    for (const [selection, source] of [[{ roleModel: oldModel, defaultModel: "other/default" }, "role"], [{ defaultModel: oldModel, globalDefaultModel: "other/global" }, "default"], [{ globalDefaultModel: oldModel }, "global"], [{ roleModel: "deployments-team-a", globalDefaultProvider: legacy }, "role"]] as const) {
      const expected = "globalDefaultProvider" in selection ? "azure/deployments-team-a" : model;
      const resolved = resolveSubagentModelThinking({ ...selection, transportThinkingModelId: expected, transportThinking: "high" });
      assert.equal(resolved.model, expected); assert.equal(resolved.modelSource, source); assert.equal(resolved.thinking, "high");
    }
    for (const roleModel of [oldModel, model]) for (const transportThinkingModelId of [oldModel, model]) {
      const resolved = resolveSubagentModelThinking({ roleModel, transportThinkingModelId, transportThinking: "high" });
      assert.equal(resolved.model, model); assert.equal(resolved.thinking, "high"); assert.equal(resolved.thinkingSource, "transport");
      assert.equal(canonicalSubagentModelReference(transportThinkingModelId), resolved.model, "Post-scope invocation check retains the binding");
    }
    assert.equal(resolveSubagentModelThinking({ roleModel: oldModel, transportThinkingModelId: "azure/deployments/team-b", transportThinking: "high" }).thinking, null);
    assert.equal(canonicalSubagentModelReference("other/azure-openai-responses/model"), "other/azure-openai-responses/model");
  });
  await test("native model editor projection and save retain per-level sampling without exposing headers", () => {
    const before = { id: "sample", headers: { authorization: "fixture-secret" }, samplingParams: { top_p: 0.95 }, samplingParamsByThinkingLevel: { off: { temperature: 0.7 }, high: { top_k: 20 } }, futureNativeField: { value: true } };
    const exposed = projectModelConfig(before);
    assert.deepEqual(exposed.samplingParamsByThinkingLevel, before.samplingParamsByThinkingLevel); assert.equal((exposed as any).headers, undefined);
    assert.deepEqual(mergeModelConfig(before, exposed), before);
  });
  await test("Pi native completions applies model, effective thinking level and request sampling in order", async () => {
    const dir = join(root, "sampling"); mkdirSync(dir);
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "https://never-sent.invalid/v1", apiKey: "fixture-only", models: [{ id: "sample", reasoning: true, contextWindow: 128000, maxTokens: 2048, thinkingLevelMap: { off: "none", high: "high" }, samplingParams: { temperature: 1, top_p: 0.95 }, samplingParamsByThinkingLevel: { off: { temperature: 0.7, top_p: 0.8 }, high: { top_k: 20 } } }] } } }));
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("fixture", "sample")!; assert(model, runtime.getError() ?? "Missing fixture model");
    assert.deepEqual(model.samplingParamsByThinkingLevel?.off, { temperature: 0.7, top_p: 0.8 });
    const api = openAICompletionsApi();
    for (const [reasoning, expected] of [["off", { temperature: 0.7, top_p: 0.8 }], ["high", { temperature: 1, top_p: 0.95, top_k: 20 }]] as const) {
      let sent = 0, body: any;
      const stream = api.streamSimple(model as any, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }), {
        apiKey: "fixture-not-a-live-key", reasoning: reasoning === "off" ? undefined : reasoning, samplingParams: { top_k: 42 }, maxRetries: 0,
        fetch: async (_input, init) => {
          sent++; body = JSON.parse(String(init?.body));
          return new Response('data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"sample","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
        },
      });
      const result = await stream.result(); assert.equal(result.stopReason, "stop", result.errorMessage); assert.equal(sent, 1);
      assert.equal(body.temperature, expected.temperature); assert.equal(body.top_p, expected.top_p); assert.equal(body.top_k, 42);
    }
  });
  await test("live sampling changes invalidate an admitted request before dispatch", async () => {
    const dir = join(root, "admission"); mkdirSync(dir);
    const settings = SettingsManager.create(dir, dir);
    const model: any = { id: "sample", provider: "fixture", api: "openai-completions", samplingParamsByThinkingLevel: { off: { temperature: 0.7 } } };
    let sent = 0;
    const runtime: any = { getModel: () => ({ ...model, samplingParamsByThinkingLevel: { off: { temperature: 0.1 } } }),
      stream: () => { sent++; return createAssistantMessageEventStream(); }, streamSimple: () => { sent++; return createAssistantMessageEventStream(); } };
    installModelInvocationAdmission(runtime, () => settings);
    const result = await runtime.streamSimple(model, { messages: [] }).result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /配置已变化/); assert.equal(sent, 0);
  });
  await test("login defaults match the installed Pi provider defaults", () => {
    const source = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js", "utf8");
    const literal = source.match(/export const defaultModelPerProvider = (\{[\s\S]*?\n\});/)?.[1]; assert(literal);
    const native = Function('"use strict"; return (' + literal + ');')();
    assert.deepEqual(DEFAULT_MODEL_PER_PROVIDER, native);
    assert.equal(pickDefaultModelAfterLogin("azure", [{ id: "azure/deepseek-v4-pro", vendor: "azure" }, { id: "azure/gpt-5.4", vendor: "azure" }]), "azure/gpt-5.4");
  });
} finally {
  mkdirSync("artifacts/pi104-upgrade", { recursive: true });
  writeFileSync("artifacts/pi104-upgrade/model-compat-results.json", JSON.stringify({ at: new Date().toISOString(), paidProviderCalls: 0, results }, null, 2));
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = results.every(result => result.passed) ? 0 : 1;
