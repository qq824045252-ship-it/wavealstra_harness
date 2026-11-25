import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSubagentModelAllowed, filterSubagentModels, parseSubagentExecutionPolicy, resolveSubagentTimeout } from "../src/shared/subagent-execution-policy";
import { assignDiverseModels, resolveSubagentSelection } from "../src/main/capabilities/subagent/selection";
import { observeSubagentSettings, replaceSubagentSettings } from "../src/main/agent/SubagentSettingsPersistence";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

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

async function testSubagentSettingsFiles(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-subagent-settings-"));
  const settingsPath = join(root, "subagent.json");
  let reader: RuntimeAuditReader | undefined;
  try {
    const nativeFlag = process.argv.indexOf("--native");
    if (nativeFlag >= 0) {
      const executable = locateRuntimeAudit(process.argv[nativeFlag + 1] ?? process.cwd());
      assert(executable && existsSync(executable), "Rust worker executable is required");
      const dbPath = join(root, "app.db");
      new DatabaseSync(dbPath).close();
      reader = new RuntimeAuditReader(executable, dbPath);
    }

    const empty = await observeSubagentSettings(root, reader);
    assert.equal(empty.kind, reader ? "native" : "host");
    assert.equal(empty.text, null);
    await replaceSubagentSettings(empty, '{"roles":{"review":["fixture/a"]},"operatorNote":"保留","maxConcurrency":4}');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      roles: { review: ["fixture/a"] }, operatorNote: "保留", maxConcurrency: 4,
    });

    const foreignEdit = await observeSubagentSettings(root, reader);
    writeFileSync(settingsPath, '{"roles":{"review":["fixture/b"]},"operatorNote":"保留","maxConcurrency":3}', "utf8");
    await assert.rejects(replaceSubagentSettings(foreignEdit, '{"maxConcurrency":2}'), /changed elsewhere/);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      roles: { review: ["fixture/b"] }, operatorNote: "保留", maxConcurrency: 3,
    });

    const [first, second] = await Promise.all([
      observeSubagentSettings(root, reader),
      observeSubagentSettings(root, reader),
    ]);
    const original = JSON.parse(first.text!);
    const writes = await Promise.allSettled([
      replaceSubagentSettings(first, JSON.stringify({ ...original, maxConcurrency: 2 })),
      replaceSubagentSettings(second, JSON.stringify({ ...original, maxConcurrency: 7 })),
    ]);
    const winners = writes.flatMap((write, index) => write.status === "fulfilled" ? [index] : []);
    assert.equal(winners.length, 1, "simultaneous saves may commit only once per observed revision");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      roles: { review: ["fixture/b"] }, operatorNote: "保留", maxConcurrency: [2, 7][winners[0]],
    });
    const files = readdirSync(root);
    assert.equal(files.includes("subagent.json"), true);
    assert.equal(files.some(name => name.endsWith(".tmp")), false);
    console.log(`PASS subagent settings persistence (${reader ? "Rust" : "Node"}): first save, external changes and concurrent revisions`);
  } finally {
    await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

testSubagentSettingsFiles().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
