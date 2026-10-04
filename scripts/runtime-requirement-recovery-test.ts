import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { ensurePresetRuntimeReadyWithRecovery, runtimeRequirementRecoveryTarget } from "../src/main/agent/RuntimeRequirementRecovery";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
const preset: any = { id: "design", label: "Design", requiredRuntimes: [{ providerId: "penpot" }, { providerId: "drawio-ai" }] };
try {
  assert.equal(runtimeRequirementRecoveryTarget(preset), "runtime-requirements:drawio-ai,penpot");
  assert.equal(runtimeRequirementRecoveryTarget({ ...preset, requiredRuntimes: [] }), null);
  await assert.rejects(ensurePresetRuntimeReadyWithRecovery({ failures, taskId: "task", assistantMessageId: "a1", preset,
    ensureReady: async () => { throw new Error("required runtime unavailable"); } }), /unavailable/);
  const failure = failures.list("task").find((item) => item.causeCode === "runtime-requirement-not-ready");
  assert(failure);
  assert.equal(failure.phase, "prepare");
  assert.equal(failure.recovery, "recoverable");
  assert.equal(failure.sideEffects, "none");
  assert.equal(failure.target, "runtime-requirements:drawio-ai,penpot");
  assert.equal(failure.executionId, undefined, "preflight happens before execution identity exists");
  await ensurePresetRuntimeReadyWithRecovery({ failures, taskId: "task", assistantMessageId: "a2", preset, ensureReady: async () => {} });
  assert(failures.list("task").find((item) => item.id === failure.id)?.resolvedAt, "readiness success resolves prior prepare failure");
  await ensurePresetRuntimeReadyWithRecovery({ failures, taskId: "task", preset: { ...preset, requiredRuntimes: [] }, ensureReady: async () => {} });
  console.log("runtime requirement recovery: PASS (stable requirement identity, prepare/none failure, successful readiness resolution)");
} finally { db.close(); }