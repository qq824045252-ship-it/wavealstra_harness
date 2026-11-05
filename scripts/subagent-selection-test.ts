import assert from "node:assert/strict";
import type { ModelReasoningPreferenceDto } from "../src/shared/model-metadata";
import type { SubagentModelOptionLike } from "../src/shared/subagent-model-config";
import { assignDiverseModels, resolveSubagentSelection, type SubagentSelectionInput } from "../src/main/capabilities/subagent/selection";

const availableModels: SubagentModelOptionLike[] = [
  { id: "native/effort", metadata: { source: "pi", reasoningOptions: [{ type: "effort", values: ["none", "low", "high", "xhigh", "ultra"] }] } },
  { id: "native/toggle", metadata: { source: "pi", reasoningOptions: [{ type: "toggle" }] } },
  { id: "native/mixed", metadata: { source: "pi", reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["none", "high"] }, { type: "budget_tokens", min: 100, max: 1000 }] } },
  { id: "native/plain", metadata: { source: "pi", reasoningOptions: [] } },
  { id: "native/off", metadata: { source: "pi", reasoningOptions: [{ type: "effort", values: ["off", "high"] }] } },
  { id: "native/unknown" },
  { id: "azure/model", metadata: { source: "pi", reasoningOptions: [{ type: "effort", values: ["high"] }] } },
];
const defaults = { roleModel: "native/effort", defaultModel: "native/toggle", globalDefaultModel: "native/plain" };
const select = (overrides: Partial<SubagentSelectionInput> = {}) => resolveSubagentSelection({ availableModels, defaults, ...overrides });

assert.deepEqual(select(), { model: "native/effort", modelSource: "role", thinking: null, thinkingSource: null, diagnostics: [] });
assert.deepEqual(select({ invocation: { model: "native/plain" } }), { model: "native/plain", modelSource: "invocation", thinking: null, thinkingSource: null, diagnostics: [] });
for (const model of ["inherit-parent", "auto"]) {
  assert.equal(select({ invocation: { model }, parentModelId: "native/plain" }).modelSource, "parent");
  assert.equal(select({ invocation: { model }, parentModelId: "native/plain" }).model, "native/plain");
  assert.throws(() => select({ invocation: { model } }), /explicit parent model/);
  assert.throws(() => select({ invocation: { model }, parentModelId: "native/unavailable" }), /unavailable/);
}
for (const model of ["plain", "", " /plain", "native/", "native/id with spaces"]) {
  assert.throws(() => select({ invocation: { model } }), /provider\/id/);
}
assert.throws(() => select({ invocation: { model: "other/effort" } }), /unavailable/);
assert.equal(select({ invocation: { model: "azure-openai-responses/model" } }).model, "azure/model");
const fallback = select({ defaults: { ...defaults, roleModel: "native/missing" } });
assert.equal(fallback.model, "native/toggle");
assert.equal(fallback.modelSource, "default");
assert.match(fallback.diagnostics.join(" "), /native\/missing.*falling back/);
assert.equal(select({ defaults: { ...defaults, roleModel: "native/missing", defaultModel: "native/gone" } }).modelSource, "global");
assert.equal(select({ defaults: { ...defaults, roleModel: "effort", globalDefaultProvider: "native" } }).model, "native/effort");
assert.equal(select({ defaults: { ...defaults, roleModel: "effort" } }).modelSource, "default");
assert.throws(() => select({ availableModels: [] }), /No usable subagent default/);
assert.throws(() => select({ defaults: {} }), /No usable subagent default/);

for (const effort of ["low", "high", "xhigh", "none"]) {
  const result = select({ invocation: { reasoning: { effort } } });
  assert.equal(result.thinking, effort === "none" ? "off" : effort);
  assert.equal(result.thinkingSource, "invocation");
}
assert.equal(select({ invocation: { model: "native/toggle", reasoning: { enabled: false } } }).thinking, "off");
assert.equal(select({ invocation: { model: "native/mixed", reasoning: { enabled: true, effort: "high" } } }).thinking, "high");
const invalid: Array<{ model: string; reasoning: ModelReasoningPreferenceDto }> = [
  { model: "native/effort", reasoning: {} },
  { model: "native/effort", reasoning: { effort: "ultra" } },
  { model: "native/effort", reasoning: { effort: "medium" } },
  { model: "native/effort", reasoning: { effort: "high", enabled: true } },
  { model: "native/unknown", reasoning: { effort: "high" } },
  { model: "native/plain", reasoning: { enabled: false } },
  { model: "native/toggle", reasoning: { enabled: true } },
  { model: "native/mixed", reasoning: { enabled: false, effort: "high" } },
  { model: "native/mixed", reasoning: { enabled: true, effort: "none" } },
  { model: "native/mixed", reasoning: { budgetTokens: 500 } },
  { model: "native/mixed", reasoning: { budgetTokens: 500, effort: "high" } },
  { model: "native/mixed", reasoning: { budgetTokens: 10 } },
  { model: "native/mixed", reasoning: { budgetTokens: 500.5 } },
  { model: "native/mixed", reasoning: { budgetTokens: Number.NaN } },
];
for (const invocation of invalid) assert.throws(() => select({ invocation }), /cannot be honored losslessly/);

assert.equal(select({ invocation: { model: "native/off", reasoning: { effort: "off" } } }).thinking, "off");
assert.equal(select({ defaults: { roleModel: "native/off", transportThinking: "off", transportThinkingModelId: "native/off" } }).thinking, "off");
const transportDefaults = { ...defaults, transportThinking: "high", transportThinkingModelId: "native/effort" };
assert.equal(select({ defaults: transportDefaults }).thinking, "high");
assert.equal(select({ defaults: transportDefaults }).thinkingSource, "transport");
const switched = select({ defaults: transportDefaults, invocation: { model: "native/plain" } });
assert.equal(switched.thinking, null);
assert.ok(switched.diagnostics.length > 0);
assert.equal(select({ defaults: transportDefaults, invocation: { reasoning: { effort: "low" } } }).thinking, "low");
const badTransport = select({ defaults: { ...transportDefaults, transportThinking: "medium" } });
assert.equal(badTransport.thinking, null);
assert.equal(badTransport.thinkingSource, null);
assert.ok(badTransport.diagnostics.length > 0);
const input: SubagentSelectionInput = { availableModels, defaults: { ...defaults, roleModel: "native/missing" } };
const before = JSON.stringify(input);
resolveSubagentSelection(input);
assert.equal(JSON.stringify(input), before);

// ---- subagent.json roles：产品侧解析角色名 → 候选清单（不依赖外部脚本）----
const roles = {
  fast: ["native/effort", "native/plain"],
  strong: ["native/missing", "native/toggle"],
  unavailable: ["native/gone", "other/model"],
  diverse: ["native/effort", "native/toggle", "native/plain"],
};
const roleSelect = (overrides: Partial<SubagentSelectionInput> = {}) =>
  resolveSubagentSelection({ availableModels, defaults, roles, ...overrides });

const fastRole = roleSelect({ invocation: { model: "fast" } });
assert.equal(fastRole.model, "native/effort");
assert.equal(fastRole.modelSource, "role-map");
assert.equal(fastRole.modelRole, "fast");
assert.deepEqual(fastRole.roleCandidates, ["native/effort", "native/plain"]);
// 第一个候选不可用时按优先级顺延，而不是报错
const strongRole = roleSelect({ invocation: { model: "strong" } });
assert.equal(strongRole.model, "native/toggle");
assert.equal(strongRole.modelSource, "role-map");
// 候选全部不可用：明确报错，不回退到全局默认模型
assert.throws(() => roleSelect({ invocation: { model: "unavailable" } }), /no available model.*native\/gone/s);
// 未配置的角色名仍按显式 provider/id 校验
assert.throws(() => roleSelect({ invocation: { model: "fast" }, roles: {} }), /provider\/id/);
assert.throws(() => select({ invocation: { model: "fast" } }), /provider\/id/);
// 角色名可与推理偏好一起使用，校验仍走现有 metadata
assert.equal(roleSelect({ invocation: { model: "fast", reasoning: { effort: "low" } } }).thinking, "low");
// diverse 是扇出保留角色名：单任务直接报错，不退化为同模型
assert.throws(() => roleSelect({ invocation: { model: "diverse" } }), /requires a parallel or chain fan-out/);

const diverseModels = assignDiverseModels({ candidates: roles.diverse, availableModels, taskCount: 3, mode: "parallel" });
assert.deepEqual(diverseModels, ["native/effort", "native/toggle", "native/plain"]);
assert.equal(new Set(diverseModels).size, 3);
// 去重 + 跳过不可用候选后仍能凑够数量
assert.deepEqual(
  assignDiverseModels({ candidates: ["native/effort", "native/effort", "native/gone", "native/off"], availableModels, taskCount: 2, mode: "chain" }),
  ["native/effort", "native/off"],
);
// 数量不足：报错并说明差距，绝不静默重复同一模型
assert.throws(
  () => assignDiverseModels({ candidates: ["native/effort", "native/gone"], availableModels, taskCount: 2, mode: "parallel" }),
  /needs 2 distinct available models.*got 1/s,
);
assert.throws(
  () => assignDiverseModels({ candidates: [], availableModels, taskCount: 2, mode: "parallel" }),
  /roles\.diverse/,
);
assert.throws(() => assignDiverseModels({
  candidates: ["one/routed/shared-model", "two/shared-model"],
  availableModels: [{ id: "one/routed/shared-model" }, { id: "two/shared-model" }],
  taskCount: 2, mode: "parallel",
}), /got 1/);
assert.throws(() => assignDiverseModels({ candidates: roles.diverse, availableModels, taskCount: 1, mode: "parallel" }), /at least two/);
console.log("subagent-selection tests passed");
