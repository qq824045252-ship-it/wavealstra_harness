import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { recoverInterruptedExecutions } from "../src/main/agent/ExecutionRestartRecovery";
import { normalizePathForComparison } from "../src/main/task/TaskExecutionWorkspace";

const root = await mkdtemp(join(tmpdir(), "mybuddy-restart-recovery-"));
const dbPath = join(root, "app.db");
const appDb = new AppDatabase(dbPath);
try {
  appDb.upsertTask({ id: "task", title: "Restart recovery", updatedAt: Date.now() });
  const attempts = new ExecutionAttemptRepository(appDb.connection);
  const failures = new ExecutionFailureRepository(appDb.connection);
  const old = { taskId: "task", executionId: "before-restart", assistantMessageId: "assistant-old" };
  const target = normalizePathForComparison(join(root, "result.txt"));
  // Preserve and settle legacy records without projecting the removed Pi recovery behavior.
  const legacy = { ...old, id: "legacy-native-write", toolCallId: "write-interrupted", toolName: "write", target,
    canonicalTarget: target, expectedHash: "a".repeat(64), expectedBytes: 7, verifierId: "file-content-sha256",
    verifierVersion: 1, status: "running", phase: "executing", startedAt: Date.now() };
  appDb.connection.prepare(`INSERT INTO execution_attempts
    (id,task_id,execution_id,assistant_message_id,tool_call_id,target,status,record_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(legacy.id, legacy.taskId, legacy.executionId, legacy.assistantMessageId,
      legacy.toolCallId, legacy.target, legacy.status, JSON.stringify(legacy), legacy.startedAt);
  attempts.begin({ ...old, toolCallId: "mcp-interrupted", toolName: "mcp__freecad_save_document",
    providerId: "freecad", shortToolName: "save_document", target: "mcp:freecad/save_document:mcp-interrupted",
    verifierId: "mcp-business-verifier", verifierVersion: 0 });

  const recovered = recoverInterruptedExecutions(attempts, failures);
  assert.equal(recovered.length, 2);
  assert(recovered.every((item) => item.status === "inconclusive" && item.causeCode === "application-restarted"));
  const open = failures.list("task").filter((item) => !item.resolvedAt && item.causeCode === "application-restarted");
  assert.equal(open.length, 1);
  assert(!open.some((item) => item.target === target), "legacy Pi write does not create a host recovery notice");
  assert.equal(attempts.list(old).find((item) => item.id === legacy.id)?.status, "inconclusive", "legacy record remains preserved and settled");
  assert(open.some((item) => item.target === "mcp:freecad/save_document"), "MCP restart recovery uses stable provider/tool identity, not old toolCallId");
  assert.equal(recoverInterruptedExecutions(attempts, failures).length, 0, "restart recovery is idempotent");
  assert.equal(failures.list("task").filter((item) => item.causeCode === "application-restarted").length, 1, "second startup creates no duplicates");


  assert(failures.list("task").every((item) => !item.resolvedAt), "restart facts remain until the corresponding retained product adapter explicitly resolves them");

  console.log("execution restart recovery: PASS (running attempts -> recoverable failures, stable MCP identity, idempotent startup)");
} finally {
  appDb.close();
  await rm(root, { recursive: true, force: true });
}