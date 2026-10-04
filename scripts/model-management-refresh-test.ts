import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  SettingsManager,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const agentSource = readFileSync(join(root, "src/main/agent/AgentService.ts"), "utf-8");
const storeSource = readFileSync(join(root, "src/main/agent/ModelsConfigStore.ts"), "utf-8");
const modelsTabSource = readFileSync(
  join(root, "src/renderer/src/components/settings/ModelsTab.tsx"),
  "utf-8",
);
const modelEditorSource = readFileSync(
  join(root, "src/renderer/src/components/settings/models/ModelEditorModal.tsx"),
  "utf-8",
);
const appSettingsSource = readFileSync(join(root, "src/main/AppSettingsStore.ts"), "utf-8");

assert(
  !agentSource.includes("UpstreamModelCatalog")
    && !agentSource.includes("providerDiscoveredModels")
    && !agentSource.includes("discoverProviderModels")
    && !agentSource.includes("registerUpstreamModelDiscovery"),
  "AgentService must not keep a second model discovery/catalog layer",
);

const reloadStart = agentSource.indexOf("async reloadModels(");
const reloadEnd = agentSource.indexOf("\n  private async reloadModelRuntimeFromDisk", reloadStart);
const reloadSource = agentSource.slice(reloadStart, reloadEnd);
assert(reloadStart >= 0 && reloadEnd > reloadStart, "reloadModels implementation must exist");
assert(
  reloadSource.includes("this.modelRuntime.refresh({")
    && reloadSource.includes("force: true")
    && reloadSource.includes("allowNetwork: true"),
  "refresh models must delegate to Pi ModelRuntime.refresh",
);
assert(
  !reloadSource.includes("fetch(")
,
  "refresh models must not fetch outside Pi runtime",
);

assert(
  agentSource.includes("resolveModelScopeWithDiagnostics(")
    && agentSource.includes("scopedModels:")
    && agentSource.includes("setEnabledModels("),
  "Pi enabledModels/scopedModels must own the model scope",
);
assert(
  modelsTabSource.includes("enabledModels:")
    && !modelsTabSource.includes("disabledModelIds"),
  "model settings UI must write Pi enabledModels, not a MyBuddy blacklist",
);
assert(
  !appSettingsSource.includes("disabledModelIds")
    && !appSettingsSource.includes("partial.enabledModels")
    && !appSettingsSource.includes("merged.enabledModels"),
  "AppSettingsStore must not implement model-scope compatibility or its own enabledModels semantics",
);
assert(
  !storeSource.includes("migrateIfNeeded")
    && !storeSource.includes("Array.isArray(parsed)")
    && storeSource.includes("Pi models.json"),
  "ModelsConfigStore must be a thin Pi models.json file access layer with no legacy migration",
);

const providerSaveStart = modelsTabSource.indexOf("const saveProvider = async");
const providerSaveEnd = modelsTabSource.indexOf("\n  const removeProvider", providerSaveStart);
const providerSaveSource = modelsTabSource.slice(providerSaveStart, providerSaveEnd);
assert(
  providerSaveStart >= 0
    && !providerSaveSource.includes("reloadModels?.("),
  "saving a Provider must not implicitly refresh its model catalog",
);

const resolveStart = agentSource.indexOf("private resolveModel(modelId");
const resolveEnd = agentSource.indexOf("\n  private async resolveEnabledModel", resolveStart);
const resolveSource = agentSource.slice(resolveStart, resolveEnd);
assert(
  resolveSource.includes("this.modelRuntime.getModel"),
  "runtime model resolution must be pure Pi ModelRuntime",
);

const temp = mkdtempSync(join(tmpdir(), "mybuddy-pi-model-native-"));
try {
  const agentDir = join(temp, "agent");
  const cwd = join(temp, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const settings = SettingsManager.create(cwd, agentDir);
  settings.setEnabledModels(["test-provider/model-a", "test-provider/model-b:high"]);
  await settings.flush();
  const reloadedSettings = SettingsManager.create(cwd, agentDir);
  assert.deepEqual(
    reloadedSettings.getEnabledModels(),
    ["test-provider/model-a", "test-provider/model-b:high"],
    "Pi SettingsManager must persist enabledModels",
  );
  reloadedSettings.setEnabledModels([]);
  await reloadedSettings.flush();
  assert.deepEqual(
    SettingsManager.create(cwd, agentDir).getEnabledModels(),
    [],
    "explicit empty enabledModels must remain distinguishable from undefined",
  );

  const modelsPath = join(agentDir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "test-provider": {
          name: "Test Provider",
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "model-a",
              name: "Model A",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
            },
            {
              id: "model-b",
              name: "Model B",
              reasoning: true,
              thinkingLevelMap: { low: "low", high: "high" },
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 2000,
              maxTokens: 200,
            },
            { id: "model-c" },
          ],
        },
      },
    }, null, 2),
    "utf-8",
  );

  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const a = runtime.getModel("test-provider", "model-a");
  const b = runtime.getModel("test-provider", "model-b");
  const c = runtime.getModel("test-provider", "model-c");
  assert.equal(a?.contextWindow, 1000);
  assert.deepEqual(b?.input, ["text", "image"]);
  assert.equal(c?.id, "model-c", "Pi models.json must accept an id-only manual model definition");

  const scope = await resolveModelScopeWithDiagnostics(
    ["test-provider/model-a", "test-provider/model-b:high"],
    runtime,
  );
  assert.equal(scope.diagnostics.length, 0);
  assert.deepEqual(
    scope.scopedModels.map((item) => [item.model.provider, item.model.id, item.thinkingLevel]),
    [
      ["test-provider", "model-a", undefined],
      ["test-provider", "model-b", "high"],
    ],
  );

} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("Pi-native model architecture: PASS");
