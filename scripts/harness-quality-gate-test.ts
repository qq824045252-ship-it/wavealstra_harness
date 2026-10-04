import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolveAgentLoadout, resolveEffectiveLoadoutSelection } from "../src/main/agent/AgentLoadoutResolver";
import { applyPromptContextBudget, derivePromptContextCharBudget } from "../src/main/agent/PromptContextBudget";
import { PromptRetryRegistry, PromptRunRegistry } from "../src/main/agent/PromptRunRegistry";
import { evaluateComputerOutcome } from "../src/main/capabilities/ComputerUseOutcome";
import type { AssemblySegmentDto } from "../src/shared/mode-profile";
import type { WindowInfo } from "../src/main/capabilities/windows/windowsAutomationProtocol";

function segment(id: string, source: AssemblySegmentDto["source"], chars: number): AssemblySegmentDto {
  const content = `${id}\n${"x".repeat(Math.max(0, chars - id.length - 1))}`;
  return { id, title: id, source, chars: content.length, content };
}

async function nativeControlBoundary(): Promise<void> {
  assert(!existsSync("src/main/agent/ExecutionRouter.ts"));
  assert(!existsSync("src/main/agent/ExecutionIntentAnalyzer.ts"));
  for (const file of ["verified-write-extension.ts", "verified-edit-extension.ts", "task-bash-isolation-extension.ts", "task-workspace-guard-extension.ts", "PiShellOutput.ts", "file-backup-extension.ts", "VerifiedShellExecution.ts", "FileContentVerifier.ts"])
    assert(!existsSync("src/main/agent/" + file), "retired core wrapper must be removed: " + file);
  const s = readFileSync("src/main/agent/conversation-runtime-extension.ts", "utf8");
  for (const file of ["ConversationTodoService.ts", "ConversationTodoRepository.ts", "ConversationPlanService.ts", "ConversationPlanRepository.ts", "PlanSideEffectPolicy.ts"])
    assert(!existsSync("src/main/agent/" + file), "retired chat service must be removed: " + file);
  assert(!/agent_end|agent_before_settle|sendMessage|routeExecution/.test(s));
  assert(!/conversation_(?:todo|plan|finding)_|session_before_compact/.test(s));
}

async function contextBudgetGate(): Promise<void> {
  assert.equal(derivePromptContextCharBudget(32_000), 12_000);
  assert.equal(derivePromptContextCharBudget(128_000), 40_960);
  assert.equal(derivePromptContextCharBudget(1_000_000), 48_000);

  const input = [
    segment("projectResources", "project", 8_000),
    segment("library", "db", 7_000),
    segment("skillCatalog", "skill", 3_000),
    segment("mode", "seed", 2_000),
    segment("libraryAttachments", "db", 2_000),
    segment("permission", "runtime", 500),
    segment("workspace", "runtime", 700),
  ];
  const result = applyPromptContextBudget(input, 12_000);
  assert.ok(result.rawChars > result.limitChars);
  assert.ok(result.usedChars <= result.limitChars);
  assert.equal(result.segments.length, input.length, "budgeting must not silently drop policy/context segments");
  assert.ok(result.truncatedSegmentIds.includes("projectResources"));
  assert.ok(result.truncatedSegmentIds.includes("library"));
  assert.ok(!result.truncatedSegmentIds.includes("workspace"), "workspace safety boundary should survive ordinary overflow");
  assert.ok(!result.truncatedSegmentIds.includes("permission"), "permission policy should survive ordinary overflow");
  assert.match(result.segments.find((item) => item.id === "projectResources")!.content, /Context budget: truncated/);
}

function fixtureWindow(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    handle: "0x123",
    processId: 42,
    processName: "fixture.exe",
    title: "Fixture Editor",
    className: "FixtureClass",
    visible: true,
    enabled: true,
    minimized: false,
    foreground: true,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    clientRect: { x: 0, y: 0, width: 780, height: 560 },
    dpi: 96,
    scale: 1,
    ...overrides,
  };
}

async function semanticOutcomeGate(): Promise<void> {
  const target = fixtureWindow();
  const passed = await evaluateComputerOutcome([
    { kind: "target_foreground", windowTitleContains: "Fixture" },
    { kind: "control_present", automationId: "save-button" },
  ], {
    outputWindow: target,
    observation: { targetAfter: target, newWindows: [] },
    findControl: async () => ({
      runtimeId: "1.2.3",
      automationId: "save-button",
      name: "Save",
      controlType: "Button",
      enabled: true,
      offscreen: false,
      keyboardFocusable: true,
      hasKeyboardFocus: false,
      patterns: ["Invoke"],
    }),
  });
  assert.equal(passed.status, "passed");

  const failed = await evaluateComputerOutcome([
    { kind: "new_window", windowTitleContains: "Success" },
  ], { observation: { targetAfter: target, newWindows: [] }, outputWindow: target });
  assert.equal(failed.status, "failed", "an action is not successful merely because post-observation exists");

  const verifierFailure = await evaluateComputerOutcome([
    { kind: "control_absent", automationId: "dialog" },
  ], {
    outputWindow: target,
    findControl: async () => { throw new Error("fixture verifier unavailable"); },
  });
  assert.equal(verifierFailure.status, "not_evaluable", "verification faults must not request an automatic side-effect retry");
}

async function effectiveLoadoutGate(): Promise<void> {
  const loadout = resolveEffectiveLoadoutSelection(resolveAgentLoadout({
    taskId: "harness-loadout",
    query: "review github pull request",
    mode: "coding",
    candidates: [
      { kind: "connector", id: "github", label: "GitHub", allowed: true, actual: true, description: "pull request review" },
      { kind: "connector", id: "jira", label: "Jira", allowed: true, actual: true, description: "issue tracking" },
      { kind: "mcp", id: "forbidden", label: "Forbidden", allowed: false, actual: false, tagRecommended: true },
    ],
  }), { requiredMcpIds: ["forbidden"] });
  assert.equal(loadout.basis, "effective_selection");
  assert(loadout.effectiveSelection?.connectorIds.includes("github"));
  assert(!loadout.effectiveSelection?.connectorIds.includes("jira"));
  assert(!loadout.effectiveSelection?.mcpIds.includes("forbidden"), "blocked MCP can never be auto-enabled by Loadout");
}

async function promptRunGate(): Promise<void> {
  const registry = new PromptRunRegistry();
  const first = registry.begin("task", false);
  const second = registry.begin("task", true);
  assert.equal(registry.isBusy("task"), true);
  assert.equal(second.predecessors.length, 1);
  registry.cancel("task", first.run);
  assert.equal(first.run.cancelled, false);
  assert.equal(second.run.cancelled, true);
  first.run.markReady();
  first.run.finish();
  registry.release("task", first.run);
  second.run.markReady();
  second.run.finish();
  registry.release("task", second.run);
  assert.equal(registry.isBusy("task"), false);

  const retries = new PromptRetryRegistry<{ nested: { value: number } }>(2);
  const original = { nested: { value: 1 } };
  retries.remember("a", original);
  original.nested.value = 9;
  assert.equal(retries.get("a")?.nested.value, 1, "retry registry must snapshot the original request");
  retries.remember("b", { nested: { value: 2 } });
  retries.remember("c", { nested: { value: 3 } });
  assert.equal(retries.get("a"), undefined, "retry registry must stay bounded");
}

async function main(): Promise<void> {
  await nativeControlBoundary();
  await contextBudgetGate();
  await semanticOutcomeGate();
  await effectiveLoadoutGate();
  await promptRunGate();
  console.log("harness quality gate: PASS (native control boundary, context budget, semantic outcome, effective loadout, prompt run registry)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
