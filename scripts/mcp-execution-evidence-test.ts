import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ExecutionAttemptRepository, EXECUTION_ATTEMPT_SCHEMA } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { SessionEventCoordinator } from "../src/main/agent/SessionEventCoordinator";
import { classifyMcpToolCall } from "../src/main/security/McpSideEffectPolicy";
import { createMcpSideEffectExtension } from "../src/main/agent/mcp-side-effect-extension";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
db.exec(EXECUTION_ATTEMPT_SCHEMA);
const attempts = new ExecutionAttemptRepository(db);
const failures = new ExecutionFailureRepository(db);
const noop = () => {};
let subscriber: (event: any) => void = noop;
const session: any = { subscribe(callback: any) { subscriber = callback; return noop; }, model: { id: "fixture" } };
const entry: any = {
  taskId: "task", session, assistantMessageId: "assistant", executionId: "execution", startedAt: Date.now(),
  mcpProviderIds: ["freecad", "my-server"], pendingAssistantTurns: [], pendingApprovals: new Map(), pendingExternalWrites: new Map(),
};
const coordinator = new SessionEventCoordinator({
  registry: { get: () => entry }, userTurnCounters: new Map(), executionAttempts: attempts, executionFailures: failures,
  runtimeSnapshots: { appendMaterials: noop }, pendingActions: { remove: noop },
  skillsService: { resolveLearnedSkillRead: () => undefined }, emitPatch: noop, emitContextUsage: noop,
  maybeEmitArtifact: async () => {},
} as any);
coordinator.attach("task", process.cwd(), session);

try {
  const readonly = classifyMcpToolCall("mcp__freecad_get_document", {}, ["freecad"]);
  assert(readonly && !readonly.sideEffect, "readonly MCP must stay outside side-effect evidence");
  const exact = classifyMcpToolCall("mcp__my_server_update_file", { path: "secret.txt" }, ["my-server"]);
  assert.equal(exact?.identity.providerId, "my-server");
  assert.equal(exact?.identity.shortToolName, "update_file");
  assert.equal(exact?.sideEffect, true);

  let toolCallHook: ((event: any) => Promise<any>) | undefined;
  let runtimeReady = false;
  createMcpSideEffectExtension({ taskId: "task", taskRoot: process.cwd(), providerIds: ["penpot"],
    getPermissionMode: () => "auto", requestApproval: async () => true,
    resolveExecutionContext: () => ({ taskId: "task", executionId: entry.executionId, assistantMessageId: entry.assistantMessageId }),
    executionFailures: failures, ensureRuntimeReady: async () => { if (!runtimeReady) throw new Error("runtime offline"); }
  })({ on(type: string, callback: any) { if (type === "tool_call") toolCallHook = callback; } } as any);
  assert(toolCallHook);
  const runtimeBlocked = await toolCallHook({ toolCallId: "runtime-fail", toolName: "mcp__penpot_update_file", input: {} });
  assert.equal(runtimeBlocked?.block, true);
  const runtimeFailure = failures.list("task").find((item) => item.causeCode === "mcp-runtime-not-ready");
  assert(runtimeFailure);
  assert.equal(runtimeFailure.phase, "prepare");
  assert.equal(runtimeFailure.sideEffects, "none");
  runtimeReady = true;
  const runtimeAllowed = await toolCallHook({ toolCallId: "runtime-ok", toolName: "mcp__penpot_update_file", input: {} });
  assert.equal(runtimeAllowed, undefined);
  assert(failures.list("task").find((item) => item.id === runtimeFailure.id)?.resolvedAt, "runtime readiness success resolves prior prepare failure");

  // Blocked calls never emit tool_execution_start, therefore no attempt is created.
  assert.equal(attempts.list(entry).length, 0);

  subscriber({ type: "tool_execution_start", toolCallId: "read", toolName: "mcp__freecad_get_document", args: {} });
  subscriber({ type: "tool_execution_end", toolCallId: "read", toolName: "mcp__freecad_get_document", result: { content: [] }, isError: false });
  assert.equal(attempts.list(entry).length, 0, "readonly MCP must not create mutation evidence");

  subscriber({ type: "tool_execution_start", toolCallId: "save", toolName: "mcp__freecad_save_document", args: { path: "do-not-persist.FCStd" } });
  subscriber({ type: "tool_execution_end", toolCallId: "save", toolName: "mcp__freecad_save_document", result: { content: [{ type: "text", text: "saved" }] }, isError: false });
  let records = attempts.list(entry);
  assert.equal(records.length, 1);
  const saved = records[0];
  assert.equal(saved.providerId, "freecad");
  assert.equal(saved.shortToolName, "save_document");
  assert.equal(saved.transportStatus, "succeeded");
  assert.equal(saved.status, "inconclusive");
  assert.equal(saved.causeCode, "business-verifier-unavailable");
  assert.equal("requiredForCompletion" in saved, false);
  assert.equal(saved.verifierId, "mcp-business-verifier");
  assert.equal(saved.verifierVersion, 0);
  assert(!JSON.stringify(saved).includes("do-not-persist.FCStd"), "MCP args must not be persisted in attempt evidence");
  assert.equal("gateReasons" in attempts, false, "audit repository must not expose a completion verdict");

  subscriber({ type: "tool_execution_start", toolCallId: "failed", toolName: "mcp__freecad_save_document", args: {} });
  subscriber({ type: "tool_execution_end", toolCallId: "failed", toolName: "mcp__freecad_save_document", result: { isError: true }, isError: true });
  records = attempts.list(entry);
  const failed = records.find((item) => item.toolCallId === "failed")!;
  assert.equal(failed.transportStatus, "failed");
  assert.equal(failed.status, "inconclusive", "failed transport cannot prove whether side effects happened");
  assert.equal(failed.causeCode, "mcp-transport-error");
  assert.equal(failed.recovery, "recoverable");
  const mcpFailure = failures.list("task").find((item) => item.causeCode === "mcp-transport-error");
  assert(mcpFailure);
  assert.equal(mcpFailure.sideEffects, "unknown");
  assert.equal(mcpFailure.target, "mcp:freecad/save_document");
  subscriber({ type: "tool_execution_start", toolCallId: "retry-ok", toolName: "mcp__freecad_save_document", args: {} });
  subscriber({ type: "tool_execution_end", toolCallId: "retry-ok", toolName: "mcp__freecad_save_document", result: {}, isError: false });
  assert(failures.list("task").find((item) => item.id === mcpFailure.id)?.resolvedAt, "successful transport resolves prior transport failure for the same MCP tool");

  subscriber({ type: "tool_execution_start", toolCallId: "late", toolName: "mcp__my_server_update_file", args: { path: "x" } });
  entry.executionId = "next"; entry.assistantMessageId = "next-assistant";
  subscriber({ type: "tool_execution_end", toolCallId: "late", toolName: "mcp__my_server_update_file", result: {}, isError: false });
  const old = attempts.list({ taskId: "task", executionId: "execution", assistantMessageId: "assistant" });
  assert(old.some((item) => item.toolCallId === "late" && item.transportStatus === "succeeded"), "late transport settles only its captured execution attempt");
  assert.equal(attempts.list({ taskId: "task", executionId: "next", assistantMessageId: "next-assistant" }).length, 0);

  console.log("MCP execution evidence: PASS (single classifier, readonly exclusion, transport outcome, unverified business result, exact provider identity, late settlement)");
} finally {
  db.close();
}