import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCadExtension } from "../src/main/cad/cad-extension";
import type { CadRuntimeService } from "../src/main/cad/CadRuntimeService";
import type { FreeCadInterop, FreeCadRunResult } from "../src/main/cad/FreeCadInterop";
import { ExecutionAttemptRepository, EXECUTION_ATTEMPT_SCHEMA } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: never, signal?: AbortSignal) => Promise<any>;
}
function fakeApi(): { api: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    api: { registerTool: (tool: never) => tools.push(tool as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI,
  };
}
function fakeRuntime(): CadRuntimeService {
  return {
    installed: true,
    releaseTask: async () => undefined,
    shutdownAll: async () => undefined,
    techdraw: async () => ({ files: {}, format: "svg", exitCode: 0, engine: "fixture" }),
    fcstdReadback: async () => ({ summary: {}, files: {}, exitCode: 0, engine: "fixture" }),
  } as unknown as CadRuntimeService;
}

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task-1');");
db.exec(EXECUTION_ATTEMPT_SCHEMA);
const attempts = new ExecutionAttemptRepository(db);
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task-1", executionId: "exec", assistantMessageId: "msg" };
let live: typeof ctx | undefined = ctx;
const verification = { resolveContext: () => live, attempts, failures };
const secretScript = "print('CAD_SECRET_SOURCE_9f77')";
const args = ["alpha", "beta"];

function makeBridge(options: {
  result?: FreeCadRunResult;
  runError?: Error;
  available?: boolean;
  approve?: boolean;
} = {}) {
  let runCount = 0;
  let approvalCount = 0;
  const freeCad = options.available === false ? null : {
    available: true,
    freeCadCmdPath: () => "C:/FreeCAD/bin/freecadcmd.exe",
    runScript: async () => {
      runCount += 1;
      if (options.runError) throw options.runError;
      return options.result ?? { exitCode: 0, stdout: "done", stderr: "", scriptPath: "C:/task-root/cad/_freecad_scripts/fc.py" };
    },
  } as unknown as FreeCadInterop;
  return {
    bridge: {
      taskId: "task-1",
      taskRoot: "C:/task-root",
      runtime: fakeRuntime(),
      artifacts: null,
      freeCad,
      getPermissionMode: () => options.approve === false ? "ask" as const : "auto" as const,
      getProducerMessageId: () => "msg",
      requestApproval: async () => { approvalCount += 1; return options.approve !== false; },
      verification,
    },
    counts: () => ({ runCount, approvalCount }),
  };
}

async function runTool(bridge: ReturnType<typeof makeBridge>["bridge"], id: string, signal?: AbortSignal) {
  const { api, tools } = fakeApi();
  createCadExtension(bridge)(api);
  const tool = tools.find((item) => item.name === "cad_freecad_run")!;
  return tool.execute(id, { script: secretScript, args, timeout_ms: 1000 } as never, signal);
}

try {
  const okFixture = makeBridge();
  const ok = await runTool(okFixture.bridge, "cad-ok");
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /✅ FreeCAD 脚本完成/);
  assert.equal(ok.details.exitCode, 0);
  assert.equal(ok.details.executionVerification.status, "passed");
  assert.equal(ok.details.executionVerification.verifierId, "process-exit-code");
  let rows = attempts.list(ctx);
  const passed = rows.find((item) => item.toolCallId === "cad-ok")!;
  assert.equal(passed.toolName, "cad_freecad_run");
  assert.equal(passed.status, "passed");
  assert.equal(passed.observedExitCode, 0);
  assert.match(passed.target, /^cad:freecad-run:[a-f0-9]{64}$/);
  assert(!JSON.stringify(rows).includes("CAD_SECRET_SOURCE_9f77"), "raw FreeCAD source must not be persisted in process evidence");

  const failingFixture = makeBridge({ result: {
    exitCode: 9, stdout: "before failure", stderr: "fixture boom", scriptPath: "C:/task-root/cad/_freecad_scripts/fc-fail.py",
  } });
  const failedResult = await runTool(failingFixture.bridge, "cad-nonzero");
  assert.equal(failedResult.isError, true, "nonzero FreeCAD exit must be a tool error, never a green success result");
  assert.match(failedResult.content[0].text, /script_exit_nonzero/);
  assert.equal(failedResult.details.exitCode, 9);
  assert.equal(failedResult.details.stderr, "fixture boom");
  assert.equal(failedResult.details.executionVerification.status, "failed");
  rows = attempts.list(ctx);
  const failedAttempt = rows.find((item) => item.toolCallId === "cad-nonzero")!;
  assert.equal(failedAttempt.causeCode, "cad-freecad-run-exit-nonzero");
  assert.equal(failedAttempt.verification?.status, "failed");
  assert.equal(failedAttempt.target, passed.target, "same script+args uses stable identity independent of generated timestamp script path");
  const processFailure = failures.list("task-1").find((item) => item.causeCode === "cad-freecad-run-exit-nonzero")!;
  assert.equal(processFailure.sideEffects, "unknown");
  assert.equal(processFailure.target, failedAttempt.target);

  const repaired = await runTool(makeBridge().bridge, "cad-repaired");
  assert.equal(repaired.isError, undefined);
  assert(failures.list("task-1").find((item) => item.id === processFailure.id)?.resolvedAt,
    "later exit=0 for the exact same script+args resolves the prior process failure");

  const timeoutFixture = makeBridge({ runError: new Error("FreeCAD 脚本超时（1000ms）: fc_fixture.py") });
  const timeout = await runTool(timeoutFixture.bridge, "cad-timeout");
  assert.equal(timeout.isError, true);
  const timeoutAttempt = attempts.list(ctx).find((item) => item.toolCallId === "cad-timeout")!;
  assert.equal(timeoutAttempt.causeCode, "cad-freecad-run-timeout");
  assert(failures.list("task-1").some((item) => item.causeCode === "cad-freecad-run-timeout" && !item.resolvedAt));

  const beforeCancelFailures = failures.list("task-1").length;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runTool(makeBridge().bridge, "cad-cancel", controller.signal);
  assert.equal(cancelled.isError, true);
  const cancelAttempt = attempts.list(ctx).find((item) => item.toolCallId === "cad-cancel")!;
  assert.equal(cancelAttempt.causeCode, "cancelled");
  assert.equal(failures.list("task-1").length, beforeCancelFailures, "cancelled CAD execution must not create persistent Recovery");

  const unavailableFixture = makeBridge({ available: false });
  const unavailable = await runTool(unavailableFixture.bridge, "cad-unavailable");
  assert.equal(unavailable.isError, true);
  const runtimeFailure = failures.list("task-1").find((item) => item.causeCode === "cad-freecad-runtime-not-ready")!;
  assert.equal(runtimeFailure.phase, "prepare");
  assert.equal(runtimeFailure.sideEffects, "none");
  assert.equal(attempts.list(ctx).some((item) => item.toolCallId === "cad-unavailable"), false,
    "runtime preflight failure occurs before process attempt begins");
  await runTool(makeBridge().bridge, "cad-runtime-restored");
  assert(failures.list("task-1").find((item) => item.id === runtimeFailure.id)?.resolvedAt,
    "observed FreeCAD availability resolves prior runtime-not-ready recovery");

  const rejectFixture = makeBridge({ approve: false });
  const { api: rejectApi, tools: rejectTools } = fakeApi();
  createCadExtension(rejectFixture.bridge)(rejectApi);
  const rejectTool = rejectTools.find((item) => item.name === "cad_freecad_run")!;
  const beforeRejectAttempts = attempts.list(ctx).length;
  const beforeRejectFailures = failures.list("task-1").length;
  const rejected = await rejectTool.execute("cad-rejected", { script: secretScript, args } as never);
  assert.equal(rejected.isError, true);
  assert.equal(rejectFixture.counts().approvalCount, 1);
  assert.equal(rejectFixture.counts().runCount, 0);
  assert.equal(attempts.list(ctx).length, beforeRejectAttempts, "user rejection creates no execution attempt");
  assert.equal(failures.list("task-1").length, beforeRejectFailures, "user rejection creates no persistent Recovery");

  live = ctx;
  const staleFixture = makeBridge();
  const { api: staleApi, tools: staleTools } = fakeApi();
  createCadExtension({
    ...staleFixture.bridge,
    freeCad: {
      ...(staleFixture.bridge.freeCad as any),
      runScript: async () => {
        live = { ...ctx, executionId: "next" };
        return { exitCode: 0, stdout: "done", stderr: "", scriptPath: "x.py" };
      },
    } as FreeCadInterop,
  })(staleApi);
  const staleTool = staleTools.find((item) => item.name === "cad_freecad_run")!;
  const staleResult = await staleTool.execute("cad-stale", { script: secretScript, args } as never);
  live = ctx;
  assert.equal(staleResult.isError, true);
  const staleAttempt = attempts.list(ctx).find((item) => item.toolCallId === "cad-stale")!;
  assert.equal(staleAttempt.causeCode, "stale-execution");
  assert(!failures.list("task-1").some((item) => item.causeCode === "stale-execution"));

  const agent = await readFile("src/main/agent/AgentService.ts", "utf8");
  const cad = await readFile("src/main/cad/cad-extension.ts", "utf8");
  assert(agent.includes("attempts: this.executionAttempts") && agent.includes("failures: this.executionFailures"));
  assert(cad.includes('toolName: "cad_freecad_run"'));
  assert(cad.includes('targetNamespace: "cad:freecad-run"'));
  assert(cad.includes('causePrefix: "cad-freecad-run"'));

  console.log("cad FreeCAD recovery: PASS (runtime preflight, approval boundary, stable hashed script identity, nonzero/timeout/cancel/stale semantics, recovery reconciliation, main-session wiring)");
} finally { db.close(); }