import assert from "node:assert/strict";
import type { ModelReasoningPreferenceDto } from "../src/shared/model-metadata";
import type { SubagentModelOptionLike } from "../src/shared/subagent-model-config";
import { resolveSubagentSelection, type SubagentSelectionInput } from "../src/main/capabilities/subagent/selection";

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
console.log("subagent-selection tests passed");
