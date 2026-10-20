import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { ExecutionAttemptRepository, EXECUTION_ATTEMPT_SCHEMA } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { verifyObservedProcessExit } from "../src/main/agent/ExecutionVerifierRegistry";
import {
  codeExecutionEvidenceIdentity,
  executeVerifiedCode,
  executeVerifiedProcess,
  recordCodeRuntimePreparationFailure,
  resolveCodeRuntimePreparationFailure,
} from "../src/main/agent/VerifiedCodeExecution";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
db.exec(EXECUTION_ATTEMPT_SCHEMA);
const attempts = new ExecutionAttemptRepository(db);
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task", executionId: "exec", assistantMessageId: "msg" };
let live: typeof ctx | undefined = ctx;
const bridge = { resolveContext: () => live, attempts, failures };
const secretCode = "console.log('VERY_SECRET_CODE_123')";
const identity = codeExecutionEvidenceIdentity({ language: "javascript", code: secretCode });

try {
  assert.equal(identity, codeExecutionEvidenceIdentity({ language: "javascript", code: secretCode }));
  assert.notEqual(identity, codeExecutionEvidenceIdentity({ language: "javascript", code: `${secretCode};console.log(2)` }));
  assert(!identity.includes("VERY_SECRET_CODE_123"), "evidence identity itself contains hashes, not raw source");

  const success = await executeVerifiedCode({ bridge, toolCallId: "code-ok", evidenceIdentity: identity,
    execute: async () => ({ result: { content: [{ type: "text", text: "ok" }], details: { runtime: "fixture" } }, exitCode: 0 }) });
  assert.equal((success.details as any).runtime, "fixture");
  assert.equal((success.details as any).executionVerification.status, "passed");
  assert.equal((success.details as any).executionVerification.verifierId, "process-exit-code");
  let records = attempts.list(ctx);
  const passed = records.find((item) => item.toolCallId === "code-ok")!;
  assert.equal(passed.toolName, "execute_code");
  assert.equal(passed.status, "passed");
  assert.equal(passed.observedExitCode, 0);
  assert.equal(passed.verification?.status, "passed");
  assert(passed.target.startsWith("code:execute_code:"));
  assert(!JSON.stringify(records).includes("VERY_SECRET_CODE_123"), "raw source must never be persisted in execution evidence");

  const nonzero = await executeVerifiedCode({ bridge, toolCallId: "code-nonzero", evidenceIdentity: identity,
    execute: async () => ({ result: { content: [{ type: "text", text: "stderr body" }], isError: true, details: { exitCode: 7 } }, exitCode: 7 }) });
  assert.equal((nonzero as any).isError, true, "structured code result remains structured instead of becoming a thrown shell error");
  assert.equal((nonzero as any).details.executionVerification.status, "failed");
  records = attempts.list(ctx);
  const failed = records.find((item) => item.toolCallId === "code-nonzero")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.observedExitCode, 7, "audit keeps the observed exit code");
  assert.equal(failed.causeCode, "code-execution-exit-nonzero");
  assert.equal(failed.verification?.status, "failed");
  // 已观测的非零退出是普通工具失败：stderr 已随工具结果返回，模型当场就能修；它不产生
  // 「副作用未知」的任务恢复卡（旧行为会生成，且只有逐字节相同的源码再次成功才消解）。
  assert.equal(failures.list("task").find((item) => item.causeCode === "code-execution-exit-nonzero"), undefined,
    "observed nonzero execute_code exit must not persist a task recovery card");

  const repair = await executeVerifiedCode({ bridge, toolCallId: "code-repair", evidenceIdentity: identity,
    execute: async () => ({ result: { content: [{ type: "text", text: "repaired" }] }, exitCode: 0 }) });
  assert.equal((repair as any).details.executionVerification.status, "passed");
  assert.equal(failures.list("task").filter((item) => item.causeCode === "code-execution-exit-nonzero").length, 0,
    "a later successful run cannot leave a stale nonzero-exit card behind");

  // 默认策略保持不变：其它产品自有进程工具（如 CAD）仍把已观测失败升级为恢复卡。
  await executeVerifiedProcess({ bridge, toolCallId: "process-default", toolName: "fixture_tool", targetNamespace: "fixture",
    evidenceIdentity: "fixture-process", causePrefix: "fixture-process", executionLabel: "fixture_tool",
    execute: async () => ({ result: { content: [{ type: "text", text: "boom" }], isError: true }, exitCode: 3 }) });
  assert(failures.list("task").some((item) => item.causeCode === "fixture-process-exit-nonzero"),
    "tools that do not opt into tool-result policy keep their recovery card");

  const timeoutIdentity = codeExecutionEvidenceIdentity({ language: "python", code: "while True: pass" });
  const timeout = await executeVerifiedCode({ bridge, toolCallId: "code-timeout", evidenceIdentity: timeoutIdentity,
    execute: async () => ({ result: { content: [{ type: "text", text: "[timed out]" }], isError: true, details: { timedOut: true } }, exitCode: null, timedOut: true }) });
  assert.equal((timeout as any).isError, true);
  assert.equal((timeout as any).details.executionVerification.status, "inconclusive");
  const timeoutAttempt = attempts.list(ctx).find((item) => item.toolCallId === "code-timeout")!;
  assert.equal(timeoutAttempt.causeCode, "code-execution-timeout");
  assert(failures.list("task").some((item) => item.causeCode === "code-execution-timeout" && !item.resolvedAt));

  const cancelCount = failures.list("task").length;
  const cancelled = await executeVerifiedCode({ bridge, toolCallId: "code-cancel", evidenceIdentity: "cancel-fixture",
    execute: async () => ({ result: { content: [{ type: "text", text: "cancelled" }], isError: true, details: { cancelled: true } }, exitCode: null, cancelled: true }) });
  assert.equal((cancelled as any).details.executionVerification.status, "inconclusive");
  const cancelAttempt = attempts.list(ctx).find((item) => item.toolCallId === "code-cancel")!;
  assert.equal(cancelAttempt.causeCode, "cancelled");
  assert.equal(failures.list("task").length, cancelCount, "cancelled code execution must not create persistent task recovery");

  live = ctx;
  await assert.rejects(executeVerifiedCode({ bridge, toolCallId: "code-stale", evidenceIdentity: "stale-fixture",
    execute: async () => { live = { ...ctx, executionId: "next" }; return { result: { content: [] }, exitCode: 0 }; } }), /stale-execution/);
  live = ctx;
  const staleAttempt = attempts.list(ctx).find((item) => item.toolCallId === "code-stale")!;
  assert.equal(staleAttempt.causeCode, "stale-execution");
  assert(!failures.list("task").some((item) => item.causeCode === "stale-execution"));

  recordCodeRuntimePreparationFailure(bridge, "managed Python unavailable");
  const runtimeFailure = failures.list("task").find((item) => item.causeCode === "code-python-runtime-not-ready")!;
  assert.equal(runtimeFailure.phase, "prepare");
  assert.equal(runtimeFailure.sideEffects, "none");
  resolveCodeRuntimePreparationFailure(bridge);
  assert(failures.list("task").find((item) => item.id === runtimeFailure.id)?.resolvedAt);

  let tampered = attempts.begin({ ...ctx, toolCallId: "process-tamper", toolName: "execute_code", target: "code:execute_code:tamper",
    verifierId: "process-exit-code", verifierVersion: 1, expectedExitCode: 0, observedExitCode: 1 });
  const bad = await verifyObservedProcessExit({ ...ctx, attemptId: tampered.id, target: tampered.target, exitCode: 1 }, () => {});
  assert.equal(bad.status, "failed");
  assert.throws(() => attempts.update({ ...tampered, verification: bad, status: "passed", phase: "finished", finishedAt: Date.now() }), /no matching passed verifier evidence/,
    "process-exit verifier cannot be forged into a passed attempt");
  attempts.update({ ...tampered, verification: bad, status: "failed", phase: "finished", causeCode: "exit-code-mismatch", finishedAt: Date.now() });

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  assert(builtin.includes("executeVerifiedCode({"));
  assert(builtin.includes("recordCodeRuntimePreparationFailure(bridge.shellVerification"));
  assert(builtin.includes("resolveCodeRuntimePreparationFailure(bridge.shellVerification)"));

  // 升级迁移：历史遗留的未决非零退出卡必须在仓库构造时隐藏，其它恢复类故障不能被误伤。
  const legacyDb = new Database(":memory:");
  legacyDb.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('legacy');
    CREATE TABLE execution_failures (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, cause_code TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);`);
  const legacyRecord = (id: string, causeCode: string) => JSON.stringify({
    id, taskId: "legacy", causeCode, phase: "execute", recovery: "recoverable", sideEffects: "unknown",
    message: "legacy card", nextAction: "inspect", createdAt: Date.now(),
  });
  legacyDb.prepare("INSERT INTO execution_failures(id,task_id,cause_code,record_json,created_at) VALUES (?,?,?,?,?)")
    .run("legacy-nonzero", "legacy", "code-execution-exit-nonzero", legacyRecord("legacy-nonzero", "code-execution-exit-nonzero"), Date.now());
  legacyDb.prepare("INSERT INTO execution_failures(id,task_id,cause_code,record_json,created_at) VALUES (?,?,?,?,?)")
    .run("legacy-timeout", "legacy", "code-execution-timeout", legacyRecord("legacy-timeout", "code-execution-timeout"), Date.now());
  const legacyRepo = new ExecutionFailureRepository(legacyDb);
  const visibleLegacy = legacyRepo.list("legacy").map((item) => item.causeCode);
  try {
    assert(!visibleLegacy.includes("code-execution-exit-nonzero"), "legacy observed-nonzero cards are hidden on upgrade");
    assert(visibleLegacy.includes("code-execution-timeout"), "genuinely unresolved timeout recovery stays visible");
  } finally { legacyDb.close(); }

  console.log("verified code execution: PASS (stable hashed identity, process verifier, structured nonzero/timeout/cancel, observed-nonzero stays a tool result, stale guard, Python prepare recovery, anti-forgery, main-tool wiring)");
} finally { db.close(); }