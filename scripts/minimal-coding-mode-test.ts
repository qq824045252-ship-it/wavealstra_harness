import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = join(tmpdir(), `mybuddy-minimal-mode-${Date.now()}`);
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
mkdirSync(sandbox, { recursive: true });

const { MODE_SEEDS } = await import("../src/main/agent/mode-defaults");
const {
  MODE_SEED_PRESET_IDS,
  defaultModePresetId,
  resolveEffectiveModePolicy,
  resolveModePreset,
  sanitizeModePresets,
} = await import("../src/shared/mode-profile");
const { ModeProfileStore } = await import("../src/main/agent/ModeProfileStore");
const { assemblePrompt } = await import("../src/main/agent/PromptAssembly");
const { getModesDir } = await import("../src/main/paths");

const results: Array<{ name: string; passed: boolean; error?: string }> = [];
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}

try {
  const codingSeed = MODE_SEEDS.coding;
  const presets = codingSeed.policy.presets ?? [];
  const minimal = presets[0];

  test("minimal is the first coding seed tag", () => {
    assert.equal(MODE_SEED_PRESET_IDS.coding[0], "minimal");
    assert.equal(minimal?.id, "minimal");
    assert.equal(minimal?.label, "最小模式");
  });

  test("minimal adds no prompt or extra policy", () => {
    assert(minimal);
    assert.equal(minimal.promptAddon, undefined);
    assert.equal(minimal.skillPolicy, undefined);
    assert.equal(minimal.mcpPolicy, undefined);
    assert.equal(minimal.providerMcpIds, undefined);
    assert.equal(minimal.requiredRuntimes, undefined);
    assert.equal(minimal.suggestedModelId, undefined);
    assert.equal(minimal.suggestedPermissionMode, undefined);
    assert.equal(minimal.recommendedExpertIds, undefined);
  });

  test("minimal leaves the base coding policy unchanged", () => {
    assert(minimal);
    const effective = resolveEffectiveModePolicy(codingSeed.policy, minimal);
    assert.equal(effective.promptAddon, null);
    assert.deepEqual(effective.skillPolicy, codingSeed.policy.skillPolicy);
    assert.deepEqual(effective.mcpPolicy, codingSeed.policy.mcpPolicy);
    assert.equal(effective.suggestedModelId, codingSeed.policy.suggestedModelId ?? null);
    assert.equal(effective.suggestedPermissionMode, codingSeed.policy.suggestedPermissionMode ?? null);
    assert.deepEqual(effective.recommendedExpertIds, codingSeed.policy.recommendedExpertIds);
  });

  test("minimal remains first even when a user custom tag was stored before seeds", () => {
    const custom = { id: "custom-first", label: "用户第一项" };
    const ordered = sanitizeModePresets("coding", [custom, ...presets]);
    assert.equal(ordered[0]?.id, "minimal");
    assert.equal(ordered[1]?.id, "custom-first");
  });

  test("coding default is minimal", () => {
    assert.equal(defaultModePresetId("coding"), "minimal");
  });

  const store = new ModeProfileStore();
  store.ensureMaterialized("coding");
  const policyPath = join(getModesDir(), "coding", "policy.json");
  const disk = JSON.parse(readFileSync(policyPath, "utf8"));
  disk.presets = (disk.presets ?? []).filter((p: { id?: string }) => p.id !== "minimal");
  disk.presets.push({ id: "custom-fixture", label: "用户自定义", promptAddon: "CUSTOM_ONLY" });
  writeFileSync(policyPath, JSON.stringify(disk, null, 2));

  const migrated = store.getProfile("coding");
  test("existing policy files receive minimal first without losing custom tags", () => {
    assert.equal(migrated.policy.presets?.[0]?.id, "minimal");
    assert(migrated.policy.presets?.some((p) => p.id === "custom-fixture"));
  });

  test("minimal produces no modePreset prompt segment", () => {
    const resolved = resolveModePreset(migrated.policy, "minimal");
    assert(resolved);
    const trace = assemblePrompt({
      welcomeMode: "coding",
      profile: migrated,
      soul: { name: "Fixture", alias: "User", persona: "" },
      permissionMode: "default",
      platform: process.platform,
      memoryEnabled: false,
      modePreset: { id: resolved.id, label: resolved.label, content: resolved.promptAddon ?? "" },
    } as any);
    assert(!trace.segments.some((segment) => segment.id === "modePreset"));
    assert(!trace.appendParts.some((text) => text.includes("场景预设：最小模式")));
  });

  test("non-minimal coding tags still inject their preset prompt", () => {
    const bugfix = resolveModePreset(migrated.policy, "bugfix-test");
    assert(bugfix?.promptAddon);
    const trace = assemblePrompt({
      welcomeMode: "coding",
      profile: migrated,
      soul: { name: "Fixture", alias: "User", persona: "" },
      permissionMode: "default",
      platform: process.platform,
      memoryEnabled: false,
      modePreset: { id: bugfix.id, label: bugfix.label, content: bugfix.promptAddon },
    } as any);
    assert(trace.segments.some((segment) => segment.id === "modePreset"));
    assert(trace.appendParts.some((text) => text.includes("场景预设：修 Bug")));
  });
} finally {
  mkdirSync("artifacts/pi-minimal-mode", { recursive: true });
  writeFileSync("artifacts/pi-minimal-mode/contract-results.json", JSON.stringify({
    at: new Date().toISOString(),
    passed: results.every((item) => item.passed),
    results,
  }, null, 2));
  rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = results.every((item) => item.passed) ? 0 : 1;
