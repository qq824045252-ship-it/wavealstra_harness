import assert from "node:assert/strict";
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
import { RuntimeRequirementOrchestrator } from "../src/main/professional-tools/RuntimeRequirementOrchestrator";
import type { ManagedToolProviderId, ProfessionalToolStatusDto } from "../src/shared/professional-tools";

// Exercise readiness with the real Penpot preset after its move to office.
const officePreset = MODE_SEEDS.working.policy.presets!.find(preset => preset.id === "web-prototype")!;
const profileStore = {
  getProfile(mode: "working" | "coding" | "bot") {
    return { ...MODE_SEEDS[mode], id: mode, version: "fixture", blocks: [], totalChars: 0, userDir: "", policyPath: "", hasUserOverride: false };
  },
};

function status(providerId: ManagedToolProviderId, ready: boolean): ProfessionalToolStatusDto {
  return {
    providerId,
    state: ready ? "ready" : "stopped",
    installed: true,
    ready,
    detail: ready ? `${providerId} ready` : `${providerId} stopped`,
  };
}

async function main(): Promise<void> {
  const calls = { starts: 0, stops: 0, prepares: 0, status: 0 };
  let penpotReady = false;
  const runtime = {
    async status(providerId: ManagedToolProviderId) {
      calls.status += 1;
      return status(providerId, providerId === "penpot" ? penpotReady : false);
    },
    async start(providerId: ManagedToolProviderId) {
      calls.starts += 1;
      if (providerId === "penpot") penpotReady = true;
      return status(providerId, providerId === "penpot");
    },
    async stop(providerId: ManagedToolProviderId) {
      calls.stops += 1;
      if (providerId === "penpot") penpotReady = false;
      return status(providerId, false);
    },
    async prepareForProvider(providerId: ManagedToolProviderId) {
      calls.prepares += 1;
      return { ok: true as const, providerId, status: status(providerId, providerId === "penpot") };
    },
    async open(providerId: ManagedToolProviderId) {
      return { ok: true as const, providerId, status: status(providerId, true) };
    },
  };

  const orchestrator = new RuntimeRequirementOrchestrator(profileStore);
  orchestrator.setRuntime(runtime);

  const states = orchestrator.listStates();
  const penpot = states.find((item) => item.providerId === "penpot");
  assert(penpot, "declared runtime should be projected into state list");
  assert(penpot.requiredBy?.includes("web-prototype"), "requiredBy should point to declaring preset");
  assert.equal(penpot.launch, "backend", "idle state should expose requirement default launch policy");

  orchestrator.onModePresetSelected("bot", "web-prototype");
  await orchestrator.ensurePresetReady(MODE_SEEDS.bot.policy.presets?.find(item => item.id === "web-prototype"));
  assert.equal(calls.starts, 0, "Bot Tags never prewarm or wait for MyBuddy managed runtimes");
  orchestrator.onModePresetSelected("working", "web-prototype");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.starts, 1, "preset selection should prewarm declared backend runtime");

  await orchestrator.ensurePresetReady(officePreset);
  assert.equal(penpotReady, true, "send-time preset gate should leave runtime ready");

  const warnings = orchestrator.previewManagedProviderWarnings(
    officePreset,
    "web-prototype",
    [],
  );
  assert.equal(warnings.length, 1, "preview should warn when provider is not allowed by effective MCP policy");

  await assert.rejects(
    orchestrator.prepareManagedProviders(
      officePreset,
      "web-prototype",
      [],
    ),
    /没有放行|not allow/i,
    "prepare gate must reject provider outside effective MCP policy",
  );

  await orchestrator.prepareManagedProviders(
    officePreset,
    "web-prototype",
    ["penpot"],
  );
  assert.equal(calls.prepares, 1, "allowed managed provider should be prepared exactly once");

  await orchestrator.stop("penpot");
  assert.equal(calls.stops, 1, "manual stop should be delegated to prewarm service/runtime");
  orchestrator.start("penpot");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.starts, 2, "manual start should use the same declarative prewarm path");

  const noRuntime = new RuntimeRequirementOrchestrator(profileStore);
  const missingWarnings = noRuntime.previewManagedProviderWarnings(
    officePreset,
    "web-prototype",
    ["penpot"],
  );
  assert.equal(missingWarnings.length, 1, "preview should warn when professional runtime is not attached");
  assert.throws(() => noRuntime.start("penpot"), /Runtime 服务未就绪/, "manual runtime actions require attached runtime");

  await orchestrator.ensureProviderReady("not-managed");
  assert.equal(calls.starts, 2, "unmanaged provider should be ignored by runtime readiness bridge");

  console.log("runtime requirement orchestrator: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
