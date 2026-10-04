/**
 * Subagent native reasoning preference regression.
 *
 * Capability truth is metadata.reasoningOptions. Pi CLI levels are transport
 * only and must never invent model capabilities.
 */
import {
  extractSubagentIdFromToolResult,
  modelOptionLabel,
  resolveSubagentReasoningAfterModelSwitch,
  targetSubagentModel,
  validateSubagentReasoningPreference,
  type SubagentModelOptionLike,
} from "../src/shared/subagent-model-config";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const effortModel: SubagentModelOptionLike = {
  id: "openai/gpt-reasoning",
  name: "GPT Reasoning",
  vendor: "openai",
  supportsReasoning: true,
  metadata: {
    source: "provider",
    reasoningOptions: [
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
    ],
  },
};

const budgetModel: SubagentModelOptionLike = {
  id: "vendor/budget-model",
  name: "Budget Model",
  vendor: "vendor",
  supportsReasoning: true,
  metadata: {
    source: "provider",
    reasoningOptions: [
      { type: "toggle" },
      { type: "budget_tokens", min: 1024, max: 32768 },
    ],
  },
};

const toggleOnlyModel: SubagentModelOptionLike = {
  id: "vendor/toggle-model",
  name: "Toggle Model",
  vendor: "vendor",
  supportsReasoning: true,
  metadata: {
    source: "provider",
    reasoningOptions: [{ type: "toggle" }],
  },
};

const customEffortModel: SubagentModelOptionLike = {
  id: "vendor/custom-effort",
  name: "Custom Effort",
  vendor: "vendor",
  supportsReasoning: true,
  metadata: {
    source: "provider",
    reasoningOptions: [{ type: "effort", values: ["none", "balanced"] }],
  },
};

const MODELS = [effortModel, budgetModel, toggleOnlyModel, customEffortModel];
const GLOBAL_DEFAULT = effortModel.id;

console.log("== model target / label ==");
assert(modelOptionLabel(effortModel) === "openai · GPT Reasoning", "provider + model name");
assert(targetSubagentModel(MODELS, budgetModel.id, GLOBAL_DEFAULT)?.id === budgetModel.id, "explicit target model");
assert(targetSubagentModel(MODELS, undefined, GLOBAL_DEFAULT)?.id === GLOBAL_DEFAULT, "empty target follows global model");

console.log("== effort / none ==");
{
  const high = validateSubagentReasoningPreference({
    defaultModel: effortModel.id,
    preference: { effort: "high" },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(high.preference?.effort === "high", "native effort preserved");
  assert(high.cliThinking === "high", "supported effort maps losslessly to Pi CLI");
  assert(high.problems.length === 0, "lossless effort has no warning");

  const none = validateSubagentReasoningPreference({
    defaultModel: effortModel.id,
    preference: { effort: "none" },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(none.preference?.effort === "none", "provider none preserved as product preference");
  assert(none.cliThinking === "off", "none translates to internal CLI off");
}

console.log("== budget_tokens ==");
{
  const budget = validateSubagentReasoningPreference({
    defaultModel: budgetModel.id,
    preference: { enabled: true, budgetTokens: 8192 },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(budget.preference?.enabled === true, "budget model toggle preserved");
  assert(budget.preference?.budgetTokens === 8192, "budget token value preserved");
  assert(budget.cliThinking === undefined, "budget does not fabricate a CLI effort");
  assert(budget.problems.some((item) => item.includes("budget_tokens")), "budget transport limitation is explicit");

  const clamped = validateSubagentReasoningPreference({
    defaultModel: budgetModel.id,
    preference: { enabled: true, budgetTokens: 999999 },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(clamped.preference?.budgetTokens === 32768, "budget clamps to provider max");
  assert(clamped.cliThinking === undefined, "clamped budget still does not map to low/medium/high");
}

console.log("== toggle-only ==");
{
  const enabled = validateSubagentReasoningPreference({
    defaultModel: toggleOnlyModel.id,
    preference: { enabled: true },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(enabled.preference?.enabled === true, "toggle-only enabled preference preserved");
  assert(enabled.cliThinking === undefined, "toggle-only enabled does not invent CLI effort");
  assert(enabled.problems.some((item) => item.includes("toggle-only")), "toggle-only CLI limitation is explicit");

  const disabled = validateSubagentReasoningPreference({
    defaultModel: toggleOnlyModel.id,
    preference: { enabled: false },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(disabled.preference?.enabled === false, "toggle-only disabled preference preserved");
  assert(disabled.cliThinking === "off", "toggle false maps losslessly to CLI off");
}

console.log("== model switching ==");
{
  const compatible = resolveSubagentReasoningAfterModelSwitch({
    previous: { effort: "high" },
    newModelId: effortModel.id,
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(compatible.preference?.effort === "high" && !compatible.changed, "compatible effort survives model switch");

  const effortToBudget = resolveSubagentReasoningAfterModelSwitch({
    previous: { effort: "high" },
    newModelId: budgetModel.id,
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(effortToBudget.preference === undefined && effortToBudget.changed, "unsupported effort returns to model default");
  assert(Boolean(effortToBudget.problem?.includes("模型默认")), "switch fallback is model default, not first transport level");

  const budgetToEffort = resolveSubagentReasoningAfterModelSwitch({
    previous: { enabled: true, budgetTokens: 4096 },
    newModelId: effortModel.id,
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(budgetToEffort.preference === undefined && budgetToEffort.changed, "budget override is not reinterpreted as effort");
}

console.log("== non-CLI effort ==");
{
  const custom = validateSubagentReasoningPreference({
    defaultModel: customEffortModel.id,
    preference: { effort: "balanced" },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(custom.preference?.effort === "balanced", "provider custom effort remains native preference");
  assert(custom.cliThinking === undefined, "unknown Pi CLI effort is not rewritten");
  assert(custom.problems.some((item) => item.includes("无法由当前 Pi CLI")), "non-lossless effort reports transport limitation");
}

console.log("== unavailable model ==");
{
  const unavailable = validateSubagentReasoningPreference({
    defaultModel: "missing/model",
    preference: { effort: "high" },
    models: MODELS,
    globalDefaultModelId: GLOBAL_DEFAULT,
  });
  assert(unavailable.preference?.effort === "high", "temporarily unavailable model keeps user preference");
  assert(unavailable.cliThinking === undefined, "unavailable model does not guess transport");
  assert(unavailable.problems.some((item) => item.includes("暂不可用")), "unavailable target emits visible diagnostic");
}

console.log("== subagent id extraction ==");
assert(
  extractSubagentIdFromToolResult(
    "subagent",
    "Agent failed\n\n> subagent: worker-abc123（在「子代理」面板查看/引导）",
    undefined,
  ) === "worker-abc123",
  "single failure result extracts id",
);
assert(
  extractSubagentIdFromToolResult("subagent", "### completed (id: par-42)", undefined) === "par-42",
  "parallel/chain summary extracts id",
);
assert(extractSubagentIdFromToolResult("bash", "subagent: xyz", undefined) === null, "non-subagent tool ignored");

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
