import assert from "node:assert/strict";
import { assertSubagentModelAllowed, filterSubagentModels, parseSubagentExecutionPolicy, resolveSubagentTimeout } from "../src/shared/subagent-execution-policy";
import { assignDiverseModels, resolveSubagentSelection } from "../src/main/capabilities/subagent/selection";

const models = [{ id: "fixture/a" }, { id: "fixture/b" }];
assert.deepEqual(filterSubagentModels(models, {}), models);
assert.deepEqual(filterSubagentModels(models, { allowedModels: [] }), []);
const scoped = filterSubagentModels(models, { allowedModels: ["fixture/a"] });
assert.deepEqual(scoped, [{ id: "fixture/a" }]);
assert.throws(() => assertSubagentModelAllowed({ allowedModels: [] }, "fixture/a"), /blocked/);
for (const model of ["fixture/b", "inherit-parent", "auto", "strong"]) {
  assert.throws(() => resolveSubagentSelection({
    invocation: { model }, parentModelId: "fixture/b", availableModels: scoped,
    defaults: { globalDefaultModel: "fixture/b" }, roles: { strong: ["fixture/b"] },
  }), /unavailable|no available/);
}
assert.equal(resolveSubagentSelection({
  defaults: { roleModel: "fixture/b", defaultModel: "fixture/a" }, availableModels: scoped,
}).model, "fixture/a");
assert.throws(() => assignDiverseModels({ candidates: ["fixture/a", "fixture/b"], availableModels: scoped, taskCount: 2, mode: "parallel" }), /distinct/);
assert.deepEqual(resolveSubagentTimeout({}, 120000), { timeoutMs: 600000, timeoutSource: "settings" });
assert.deepEqual(resolveSubagentTimeout({ timeoutMs: 900000, timeoutPolicy: "fixed" }, 300000), { timeoutMs: 900000, timeoutSource: "settings" });
assert.deepEqual(resolveSubagentTimeout({ timeoutMs: 900000, timeoutPolicy: "allow-override" }, 300000), { timeoutMs: 300000, timeoutSource: "invocation" });
assert.deepEqual(resolveSubagentTimeout({ timeoutMs: 900000, timeoutPolicy: "allow-override" }), { timeoutMs: 900000, timeoutSource: "settings" });
for (const timeout of [0, 999, 3600001, 1.5, NaN, Infinity]) assert.throws(() => resolveSubagentTimeout({}, timeout));
for (const invalid of [null, [], { timeoutMs: 0 }, { timeoutMs: 3600001 }, { timeoutPolicy: "ignore" }, { allowedModels: "fixture/a" }, { allowedModels: ["fixture/a", "fixture/a"] }, { allowedModels: ["bare"] }, { roles: { fast: ["bare"] } }, { roles: { auto: [] } }, { roles: { "bad name": [] } }, { roles: { ["__proto__"]: [] } }]) {
  assert.throws(() => parseSubagentExecutionPolicy(invalid), /Invalid subagent/);
}
const settings = { defaultModel: "fixture/a", timeoutMs: 1000, allowedModels: [], roles: { fast: ["fixture/b", "fixture/a"], strong: [] } };
assert.deepEqual(parseSubagentExecutionPolicy(settings), {
  timeoutMs: 1000, allowedModels: [], roles: settings.roles, timeoutPolicy: undefined,
});
console.log("PASS subagent execution settings: strict parsing, empty allowlist, all model sources, diverse, fixed and per-call time limits");
