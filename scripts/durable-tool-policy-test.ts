import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync as writeFileSyncForFixture } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, ModelRuntime, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration, type JsonObject } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { PermissionMode } from "../src/shared/agent-ipc";
import { nativeExecutionOperationId, readNativeExecutionReceipt, type NativeExecutionReceipt } from "../src/shared/native-execution-receipt";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { computerAutomationService, WindowsAutomationError, type ComputerExecOutput } from "../src/main/capabilities/ComputerAutomationService";
import { uiAutomationService, UiAutomationError } from "../src/main/capabilities/UiAutomationService";
import { readDesktopOperationOutcome } from "../src/main/agent/DesktopOperationOutcome";
import { withDurableExecution, durableExecutionContext } from "../src/main/agent/durable/DurableExecutionContext";
import { currentDurableExecutionContext } from "../src/main/agent/durable/DurableExecutionContext";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { retireWorkIsolation } from "../src/main/db/work-isolation-retirement";
import { createDurableToolPolicy, type DurableToolPolicyOptions } from "../src/main/agent/durable/DurableToolPolicy";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { recoverInterruptedExecutions } from "../src/main/agent/ExecutionRestartRecovery";
import { prepareFileEffect, verifyFileEffect, type ExternalEffectRecovery } from "../src/main/agent/durable/DurableEffectRecovery";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-policy-"));
const db = new AppDatabase(join(root, "app.db"));
const attempts = new ExecutionAttemptRepository(db.connection);
const failures = new ExecutionFailureRepository(db.connection);
const policyBots = new BotRegistry(db.connection);
policyBots.ensureDefaultBot(LOCAL_USER_ID);
const policyWorks = new WorkService(db.connection, { bots: policyBots });
const goals = new ConversationGoalService(policyWorks, () => {}, { userId: LOCAL_USER_ID });
let interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
const call = (name: string, args: JsonObject, id = `fixture-${name}`): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];
const text = (value: string): TextContent[] => [{ type: "text", text: value }];
const shellName = process.platform === "win32" ? "powershell" : "bash";
const quoteShell = (value: string) => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\"'\"'") + "'";
const nodeCommand = (code: string) => `${process.platform === "win32" ? "& " : ""}${quoteShell(process.execPath)} -e ${quoteShell(code)}${process.platform === "win32" ? "; exit $LASTEXITCODE" : ""}`;

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Fixture did not reach the expected native execution state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(taskId: string, respond: (request: TranscriptContext) => AssistantMessage["content"],
  mode: "native" | "codemode" = "native", extraTools: ToolRegistration[] = [], isolatedSourceRoots: string[] = [], effectRecovery?: ExternalEffectRecovery, withSubagents = false,
  cwd = join(root, taskId)) {
  await mkdir(cwd);
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now() });
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = respond(request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api,
          provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const state: { permission: PermissionMode; allowed: boolean; deniedTools: Set<string>; legacyApproval?: boolean;
    beforeTool?: (name: string) => Promise<void>;
    afterTool?: (name: string, signal?: AbortSignal) => Promise<void>;
    admit?: (input: { operationId: string; actionKind: string }) => string | undefined;
    settle?: (operationId: string, outcome: "consumed" | "released" | "unknown", receipt: NativeExecutionReceipt) => void } = { permission: "auto", allowed: true, deniedTools: new Set<string>() };
  const open = async () => {
    const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => state.permission,
      interactions, attempts, failures, getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: cwd, isolatedSourceRoots }),
      effectRecovery,
      admitWorkAction: input => state.admit?.(input), settleWorkAction: receipt => state.settle?.(nativeExecutionOperationId(receipt), receipt.settlement, receipt),
      toolAllowed: name => !state.deniedTools.has(name) && (state.allowed || !["write", "mcp__filesystem__write_file"].includes(name)),
    });
    const domain = await durableDomainTools([createConversationRuntimeExtension({ interaction: interactions, goal: goals,
      resolveContext: currentDurableExecutionContext,
      requestInteraction: (context, request, signal, toolCallId) => interactions.requestDurable(context, request, { key: toolCallId, signal }),
    })], { taskId, cwd, models });
    return DurableBotRuntime.open({ taskId, cwd, directory: join(cwd, "state"), models,
      model: { provider: "fixture", modelId: "model" }, toolMode: mode, tools: [...domain.tools, ...extraTools, ...(withSubagents ? createDurableSubagentTools({ taskId, cwd, models, permissionMode: () => state.permission }) : [])],
      contextHooks: domain.contextHooks, toolHooks: { ...policy.hooks, beforeTool: async (call, api, context) => {
        if (state.legacyApproval && call.name === "write") {
          const execution = await durableExecutionContext(taskId, api, context);
          await interactions.requestDurable(execution, { kind: "confirm", title: "允许执行 write？" }, { key: `approval:${call.id}`, signal: context.abortSignal });
          return;
        }
        const decision = await policy.hooks.beforeTool?.(call, api, context);
        await state.beforeTool?.(call.name);
        return decision;
      }, afterTool: async (call, result, api, context) => {
        const projected = await policy.hooks.afterTool?.(call, result, api, context);
        await state.afterTool?.(call.name, context.abortSignal);
        return projected;
      } }, instructions: () => "fixture", onSnapshot: () => {},
    });
  };
  return { taskId, cwd, state, open };
}

function attemptCount(taskId: string): number {
  const row = db.connection.prepare("SELECT count(*) AS n FROM execution_attempts WHERE task_id=?").get(taskId);
  assert(row && typeof row === "object" && "n" in row && typeof row.n === "number");
  return row.n;
}

async function checkDesktopOutcomes() {
  const scenarios = [
    { name: "ui-unknown", tool: "ui_exec", status: "inconclusive", sideEffects: "unknown", causeCode: "ui-execution-failed" },
    { name: "computer-delivery", tool: "computer_exec", status: "inconclusive", sideEffects: "unknown", causeCode: "computer-request-timeout" },
    { name: "computer-mismatch", tool: "computer_exec", status: "failed", sideEffects: "known", causeCode: "computer-semantic-verification-failed" },
    { name: "computer-no-readback", tool: "computer_exec", status: "inconclusive", sideEffects: "known", causeCode: "computer-semantic-verification-unavailable" },
    { name: "computer-partial", tool: "computer_exec", status: "inconclusive", sideEffects: "known", causeCode: "computer-batch-incomplete" },
    { name: "computer-confirmed", tool: "computer_exec", status: "passed" },
  ] as const;
  const config = {
    browser: { enabled: true }, execution: { terminalEnabled: false, codeExecutionEnabled: false },
    web: { enabled: false }, vision: { enabled: false }, imageGeneration: { enabled: false },
    videoGeneration: { enabled: false }, speechToText: { enabled: false }, textToSpeech: { enabled: false },
    diagnostics: { enabled: false }, subagent: { enabled: false }, multiModelConsult: { enabled: false },
  };
  const availability = Object.getOwnPropertyDescriptor(computerAutomationService, "available");
  Object.defineProperty(computerAutomationService, "available", { value: true, configurable: true });
  mock.method(uiAutomationService, "anyAvailable", () => true);
  try {
    for (const mode of ["native", "codemode", "subagent"] as const) for (const sample of scenarios) {
      if (mode === "subagent" && sample.name !== "computer-delivery") continue;
      const taskId = `desktop-${mode}-${sample.name}`;
      const click = { action: "click_client", x: 1, y: 1 };
      const args: JsonObject = sample.tool === "ui_exec" ? { action: "click", selector: "#fixture" }
        : sample.name === "computer-partial" ? { actions: [click, { ...click, x: 2 }] }
        : { ...click, expected_outcomes: [{ kind: "control_present", control_name: "Done" }] };
      const ui = mock.method(uiAutomationService, "execute", async () => {
        throw new UiAutomationError("EXECUTION_FAILED", "Fixture lost input acknowledgment",
          { outcome: { dispatch: "dispatched", effect: "unknown" } });
      });
      const computer = mock.method(computerAutomationService, "execute", async (): Promise<ComputerExecOutput> => {
        if (sample.name === "computer-delivery") throw new WindowsAutomationError("REQUEST_TIMEOUT", "Fixture lost input acknowledgment", { executed: "unknown" });
        if (sample.name === "computer-partial") return { action: "batch", executed: true, batch: { completed: false, settleMs: 120, steps: [
          { index: 0, action: "click_client", ok: true }, { index: 1, action: "click_client", ok: false, detail: "Fixture stopped before the second step" },
        ] } };
        const status = sample.name === "computer-mismatch" ? "failed" : sample.name === "computer-no-readback" ? "not_evaluable" : "passed";
        return { action: "click_client", executed: true, semanticOutcome: { status, checks: [
          { kind: "control_present", status, evidence: "Fixture control observation" },
        ] } };
      });
      const recovery = { resolveContext: () => ({ taskId, executionId: `durable:${taskId}:fixture`, assistantMessageId: "fixture" }), failures };
      const domain = await durableDomainTools([createBuiltinCapabilityExtension({
        taskId, taskRoot: root, runtime: { config: () => config } as never,
        browser: { available: false } as never, artifactService: () => undefined as never,
        markArtifactEmitted: () => {}, getProducerMessageId: () => "fixture", getIsolationLevel: () => "guarded",
        uiRecovery: recovery, computerRecovery: recovery,
      })]);
      let toolResult: Extract<TranscriptContext["messages"][number], { role: "toolResult" }> | undefined;
      const scenario = await fixture(taskId, request => {
        const last = request.messages.at(-1);
        if (mode === "subagent" && request.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"))) {
          return last?.role === "toolResult" ? text("The child reported an uncertain operation") : call("subagent", {
            agent: "desktop-worker", task: "Check the fixture operation", model: "fixture/model",
            agentScope: "project", confirmProjectAgents: false, isolation: "shared",
          });
        }
        if (last?.role === "toolResult") { toolResult = last; return text("finished"); }
        if (mode !== "codemode") return call(sample.tool, args);
        return call("codemode", { code: `console.log(await tools.${sample.tool}(${JSON.stringify(args)}));` });
      }, mode === "codemode" ? mode : "native", domain.tools, [], undefined, mode === "subagent");
      if (mode === "subagent") {
        const agents = join(scenario.cwd, CONFIG_DIR_NAME, "agents");
        await mkdir(agents, { recursive: true });
        await writeFile(join(agents, "desktop-worker.md"), "---\nname: desktop-worker\ndescription: Desktop outcome fixture\ntools: computer_exec\n---\nCheck and report the fixture operation.\n");
      }
      const settlements: string[] = [];
      const actor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS } as const;
      const created = policyWorks.createWork(actor, { operationId: taskId + "-work", title: taskId, ownerBotId: DEFAULT_BOT_ID,
        workspacePath: scenario.cwd, inputSnapshotId: "receipt-input" });
      assert(created.ok);
      const work = created.work;
      const dispatched = policyWorks.dispatchExecution(actor, { operationId: taskId + "-dispatch", workId: work.workId, taskId,
        botId: DEFAULT_BOT_ID, durableStoreKey: taskId, conversationId: taskId, workspaceBinding: scenario.cwd,
        versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
      assert(dispatched.ok);
      scenario.state.admit = input => policyWorks.admitTaskAction(taskId, input);
      scenario.state.settle = (_id, status, receipt) => { settlements.push(status); policyWorks.settleTaskNativeAction(taskId, receipt); };
      const runtime = await scenario.open();
      try {
        const expected = sample.status === "passed" ? undefined
          : { status: sample.status, sideEffects: sample.sideEffects, causeCode: sample.causeCode };
        assert.equal((await (await runtime.submit("check fixture operation", "test")).wait(ctx)).status, "done");
        assert.equal(ui.mock.callCount() + computer.mock.callCount(), 1, taskId);
        assert.equal(Boolean(toolResult?.isError), Boolean(expected), taskId);
        const rows = db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id = ? AND json_extract(record_json, '$.toolName') = ?")
          .all(taskId, sample.tool) as Array<{ record_json: string }>;
        assert.equal(rows.length, 1, taskId);
        const attempt = JSON.parse(rows[0].record_json);
        assert.equal(attempt.toolName, sample.tool, taskId);
        assert.equal(attempt.status, sample.status, taskId);
        assert.equal(attempt.transportStatus, "succeeded", taskId);
        assert.deepEqual(attempt.verification.observed.desktopOutcome, expected, taskId);
        const receipt = readNativeExecutionReceipt({ executionReceipt: attempt.nativeReceipt });
        assert(receipt, taskId);
        assert.equal(receipt.attemptId, attempt.id, taskId);
        assert.equal(receipt.status, attempt.verification.status, taskId);
        assert.equal(receipt.checkedAt, attempt.verification.checkedAt, taskId);
        assert.equal(receipt.verifierVersion, attempt.verification.verifierVersion, taskId);
        const operationId = nativeExecutionOperationId(receipt);
        const admission = policyWorks.repo.listAdmissions(work.workId).find(item => item.operationId === operationId);
        assert.equal(admission?.state, receipt.settlement, taskId);
        assert.deepEqual(settlements, mode === "subagent" ? ["unknown", "consumed"] : [expected?.sideEffects === "unknown" ? "unknown" : "consumed"], taskId);
        assert.deepEqual(failures.list(taskId).map(({ causeCode, sideEffects }) => ({ causeCode, sideEffects })),
          expected ? [{ causeCode: expected.causeCode, sideEffects: expected.sideEffects }] : [], taskId);
        if (mode !== "subagent") {
          const history = await runtime.loadHistoryBlock(Number.MAX_SAFE_INTEGER);
          const projected = history.messages.flatMap(message => message.tools ?? []).find(tool => tool.tool === sample.tool);
          assert.equal(projected?.status, expected ? "error" : "success", taskId);
        }
        if (mode !== "codemode") assert.deepEqual(readDesktopOperationOutcome(toolResult?.details), expected, taskId);
        if (mode === "native") assert.deepEqual(readNativeExecutionReceipt(toolResult?.details), receipt, taskId);
        if (mode === "codemode") {
          const nested = (toolResult?.details as { calls?: { name: string }[] }).calls?.find(item => item.name === sample.tool);
          assert.deepEqual(readNativeExecutionReceipt(nested), receipt, taskId);
        }
      } finally {
        await runtime.close();
        ui.mock.restore();
        computer.mock.restore();
      }
    }
  } finally {
    mock.restoreAll();
    if (availability) Object.defineProperty(computerAutomationService, "available", availability);
    else Reflect.deleteProperty(computerAutomationService, "available");
  }
  console.log("PASS native, Code Mode, and child ToolTasks preserve desktop outcomes in tool results, attempts, recovery and Work");
}

async function checkPinnedReceiptRecovery() {
  const taskId = "native-receipt-interrupted-publication";
  let executions = 0;
  const settlements: Array<{ operationId: string; status: string }> = [];
  let modelReceipt: ReturnType<typeof readNativeExecutionReceipt>;
  const scenario = await fixture(taskId, request => {
    const last = request.messages.at(-1);
    if (last?.role !== "toolResult") return call("terminal_exec", { action: "execute" });
    modelReceipt = readNativeExecutionReceipt(last.details);
    return text("done");
  }, "native", [defineTool({
    name: "terminal_exec", description: "Fixture publication", replay: "unsafe", parameters: Type.Object({ action: Type.String() }),
    execute: async () => ({ output: text(`published once: ${++executions}`), details: { fixture: true } }),
  })]);
  scenario.state.settle = (operationId, status) => {
    settlements.push({ operationId, status });
  };
  let waitingToPublish = false;
  scenario.state.afterTool = async (name, signal) => {
    if (name !== "terminal_exec" || waitingToPublish) return;
    waitingToPublish = true;
    await new Promise<never>((_resolve, reject) => {
      assert(signal);
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  let runtime = await scenario.open();
  try {
    const submitted = await runtime.submit("publish", taskId);
    await waitUntil(() => waitingToPublish);
    await runtime.close();
    recoverInterruptedExecutions(attempts, failures);
    runtime = await scenario.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx);
    assert(resumed);
    assert.equal((await resumed.wait(ctx)).status, "done");
    assert.equal(executions, 1);
    assert.equal(settlements.length, 2);
    assert.deepEqual(settlements[0], settlements[1]);
    assert.equal(settlements[0].status, "consumed");
    const row = db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id=?").get(taskId) as { record_json: string };
    const receipt = JSON.parse(row.record_json).nativeReceipt;
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.transport, "returned");
    assert.deepEqual(modelReceipt, receipt);
    await runtime.close();
    recoverInterruptedExecutions(attempts, failures);
    runtime = await scenario.open();
    const history = await runtime.loadHistoryBlock(Number.MAX_SAFE_INTEGER);
    const assistant = history.messages.find(message => message.id === receipt.assistantMessageId);
    const projected = assistant?.tools?.find(tool => tool.id === receipt.callId);
    assert.equal(projected?.status, "success");
    assert.deepEqual(readNativeExecutionReceipt(JSON.parse(projected?.detail ?? "{}")), receipt);
    assert.equal(executions, 1);
  } finally { await runtime.close(); }
  console.log("PASS native execution keeps the exact receipt across interrupted result publication and reopened history");
}

async function checkReusedProviderCallId() {
  const taskId = "native-receipt-reused-call-id";
  let calls = 0;
  const scenario = await fixture(taskId, request => {
    return request.messages.at(-1)?.role === "toolResult" ? text("done") : call("terminal_exec", { action: "execute" }, "provider-reused-id");
  }, "native", [defineTool({
    name: "terminal_exec", description: "Fixture provider response", replay: "unsafe", parameters: Type.Object({ action: Type.String() }),
    execute: async () => ++calls === 1 ? { isError: true, output: text("first failed") } : { output: text("second passed") },
  })]);
  let runtime = await scenario.open();
  try {
    assert.equal((await (await runtime.submit("first", "first")).wait(ctx)).status, "done");
    assert.equal((await (await runtime.submit("second", "second")).wait(ctx)).status, "done");
    await runtime.close();
    runtime = await scenario.open();
    const history = await runtime.loadHistoryBlock(Number.MAX_SAFE_INTEGER);
    const rows = history.messages.flatMap(message => (message.tools ?? []).map(tool => ({ message, tool })));
    assert.deepEqual(rows.map(({ tool }) => [tool.id, tool.status, tool.output]),
      [["provider-reused-id", "error", "first failed"], ["provider-reused-id", "success", "second passed"]]);
    const receipts = rows.map(({ message, tool }) => {
      const receipt = readNativeExecutionReceipt(JSON.parse(tool.detail ?? "{}"));
      assert.equal(receipt?.assistantMessageId, message.id);
      return receipt;
    });
    assert.notEqual(receipts[0]?.attemptId, receipts[1]?.attemptId);
  } finally { await runtime.close(); }
  console.log("PASS reopened history keeps two native tool receipts separate when a provider reuses the same call ID");
}

try {
  await checkDesktopOutcomes();
  await checkPinnedReceiptRecovery();
  await checkReusedProviderCallId();
  if (process.platform === "win32") {
    // Git Bash mounts the OS temp directory as /tmp. Use the checkout's drive alias.
    const workspace = await mkdtemp(join(process.cwd(), "out", "tests", "bash-path-verification-"));
    let bashPath = "";
    const toolResults: Array<{ tool: string; isError: boolean; text: string }> = [];
    const scenario = await fixture("bash-path-file-verification", request => {
      const last = request.messages.at(-1);
      if (last?.role !== "toolResult") return call("bash", { command: "pwd" });
      const output = last.content.map(block => block.type === "text" ? block.text : "").join("\n");
      if (last.toolName === "bash") {
        bashPath = `${output.trim()}/result.txt`;
        return call("write", { path: bashPath, content: "first\n" });
      }
      toolResults.push({ tool: last.toolName, isError: last.isError === true, text: output });
      return last.toolName === "write"
        ? call("edit", { path: bashPath, edits: [{ oldText: "first", newText: "second" }] })
        : text("finished");
    }, "native", [], [], undefined, false, join(workspace, "task"));
    const runtime = await scenario.open();
    try {
      assert.equal((await (await runtime.submit("write and edit the file", "bash-path")).wait(ctx)).status, "done");
      assert.match(bashPath, /^\/[a-z]\//);
      assert.deepEqual(toolResults.map(result => result.tool), ["write", "edit"], JSON.stringify(toolResults));
      assert.equal(await readFile(join(scenario.cwd, "result.txt"), "utf8"), "second\n");
      const evidence = db.connection.prepare(`
        SELECT json_extract(record_json, '$.toolName') AS tool,
               json_extract(record_json, '$.verification.verifierId') AS verifierId,
               json_extract(record_json, '$.verification.canonicalTarget') AS target, status
        FROM execution_attempts WHERE task_id = ? AND json_extract(record_json, '$.toolName') IN ('write', 'edit') ORDER BY rowid
      `).all(scenario.taskId);
      const target = await realpath(join(scenario.cwd, "result.txt"));
      assert.deepEqual(evidence, [
        { tool: "write", verifierId: "durable-file-content", status: "passed", target },
        { tool: "edit", verifierId: "durable-file-content", status: "passed", target },
      ]);
      assert.deepEqual(toolResults.map(result => result.isError), [false, false], JSON.stringify(toolResults));
      assert.equal(failures.list(scenario.taskId).length, 0);
    } finally {
      await runtime.close();
      await rm(workspace, { recursive: true, force: true });
    }
    console.log(`PASS Windows Git Bash ${bashPath.slice(0, 3)} path writes and edits pass native file-content verification`);

    const aliasCases = [
      { name: "relative", path: () => "result.txt", file: "result.txt" },
      { name: "mention", path: () => "@result.txt", file: "result.txt" },
      { name: "space", path: () => "quarter\u00a0report.txt", file: "quarter report.txt" },
      { name: "file-url", path: (cwd: string) => pathToFileURL(join(cwd, "result.txt")).href, file: "result.txt" },
      { name: "home", path: () => "~/result.txt", file: "result.txt" },
    ];
    const home = process.env.USERPROFILE;
    for (const sample of aliasCases) {
      const requestedCwd = join(root, `file-path-${sample.name}\u00a0workspace`);
      const raw = sample.path(requestedCwd);
      const flags: boolean[] = [];
      const scenario = await fixture(`file-path-${sample.name}`, request => {
        const last = request.messages.at(-1);
        if (last?.role !== "toolResult") return call("write", { path: raw, content: "first\n" });
        flags.push(last.isError === true);
        return last.toolName === "write" ? call("edit", { path: raw, edits: [{ oldText: "first", newText: "second" }] }) : text("done");
      }, "native", [], [], undefined, false, requestedCwd);
      process.env.USERPROFILE = scenario.cwd;
      const runtime = await scenario.open();
      try {
        assert.equal((await (await runtime.submit("write and edit the file", sample.name)).wait(ctx)).status, "done");
        const target = await realpath(join(scenario.cwd, sample.file));
        assert.equal(await readFile(target, "utf8"), "second\n");
        assert.deepEqual(flags, [false, false], sample.name);
        const evidence = db.connection.prepare(`
          SELECT json_extract(record_json, '$.toolName') AS tool,
                 json_extract(record_json, '$.verification.verifierId') AS verifierId,
                 json_extract(record_json, '$.verification.canonicalTarget') AS target, status
          FROM execution_attempts WHERE task_id = ? ORDER BY rowid
        `).all(scenario.taskId);
        assert.deepEqual(evidence, [
          { tool: "write", verifierId: "durable-file-content", status: "passed", target },
          { tool: "edit", verifierId: "durable-file-content", status: "passed", target },
        ], sample.name);
        assert.equal(failures.list(scenario.taskId).length, 0, sample.name);
      } finally {
        if (home === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = home;
        await runtime.close();
      }
    }
    console.log("PASS native path forms write, edit and verify the same file, including Unicode in the workspace path");
  }

  for (const [mode, publishTool] of [
    ["native", "gmail_send"],
    ["native", "mcp__fixture__publish"],
    ["codemode", "mcp__fixture__publish"],
  ] as const) {
    const published: string[] = [];
    let reachedPublish = false;
    let resumePublish!: () => void;
    const releasePublish = new Promise<void>(resolve => { resumePublish = resolve; });
    const verdicts: string[] = [];
    let requestedLatest = false;
    const send = (version: string) => mode === "native" ? call(publishTool, { version }, `publish-${version}`)
      : call("codemode", { code: `console.log(await tools.${publishTool}({version:${JSON.stringify(version)}}));` }, `publish-${version}`);
    const scenario = await fixture(`fresh-input-${mode}-${publishTool}`, request => {
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        requestedLatest = JSON.stringify(last.content).includes("publish revised");
        return send(requestedLatest ? "revised" : "original");
      }
      if (last?.role === "toolResult") {
        verdicts.push(JSON.stringify(last.content));
        if (!requestedLatest && verdicts.length === 1) return send("original-retry");
        if (!requestedLatest && verdicts.length === 2) {
          return mode === "native" ? call("read", { path: "readable.txt" }, "read-during-deferral")
            : call("codemode", { code: 'console.log(await tools.read({path:"readable.txt"}));' }, "read-during-deferral");
        }
      }
      return text("finished this turn");
    }, mode, [defineTool({
      name: publishTool, description: "Publish the requested release", parameters: Type.Object({ version: Type.String() }), replay: "unsafe",
      execute: async ({ version }, api, context) => {
        published.push(version);
        const cwd = (await api.agent(context)).cwd!;
        await writeFile(join(cwd, "published.txt"), version);
        return { output: text("published") };
      },
    })]);
    scenario.state.beforeTool = async name => {
      if (name === publishTool) { reachedPublish = true; await releasePublish; }
    };
    await writeFile(join(scenario.cwd, "readable.txt"), "read proceeded while revised input was queued");
    const runtime = await scenario.open();
    try {
      const original = await runtime.submit("publish original", "original");
      await waitUntil(() => reachedPublish);
      assert.deepEqual(published, []);
      const revised = await runtime.submit("publish revised", "revised");
      assert.equal((await revised.status(ctx)).status, "queued");
      resumePublish();
      assert.equal((await original.wait(ctx)).status, "done");
      assert.equal((await revised.wait(ctx)).status, "done");
      assert(requestedLatest, "a real provider request must carry the revised input");
      assert.deepEqual(published, ["revised"], "only the action generated from the revised user input may execute");
      assert.equal(await readFile(join(scenario.cwd, "published.txt"), "utf8"), "revised");
      assert(verdicts[0]?.includes("较新的用户输入等待处理"), JSON.stringify(verdicts));
      assert(verdicts[1]?.includes("较新的用户输入等待处理"), JSON.stringify(verdicts));
      assert(verdicts[2]?.includes("read proceeded while revised input was queued"), JSON.stringify(verdicts));
      assert(verdicts[3]?.includes("published"), JSON.stringify(verdicts));
    } finally {
      resumePublish();
      await runtime.close();
    }
  }
  console.log("PASS fresh input defers ordinary Gmail send and native/Code Mode MCP publication on controlled transports; reads and revised actions proceed");

  const nativeShellReached = Promise.withResolvers<void>();
  const releaseNativeShell = Promise.withResolvers<void>();
  const nativeShellResults: string[] = [];
  const nativePublication = await fixture("fresh-real-shell-publication", request => {
    const last = request.messages.at(-1);
    if (last?.role === "toolResult") nativeShellResults.push(JSON.stringify(last.content));
    if (last?.role !== "user") return text("finished");
    const revision = JSON.stringify(last.content).includes("revised") ? "revised" : "original";
    const command = nodeCommand(`require("node:fs").appendFileSync("publication-audit.txt",${JSON.stringify(revision + "\n")})`);
    return call(shellName, { command }, `shell-${revision}`);
  });
  nativePublication.state.beforeTool = async name => {
    if (name === shellName) { nativeShellReached.resolve(); await releaseNativeShell.promise; }
  };
  const publicationRuntime = await nativePublication.open();
  try {
    const current = await publicationRuntime.submit("publish original with shell", "shell-original");
    await nativeShellReached.promise;
    const revised = await publicationRuntime.submit("publish revised with shell", "shell-revised");
    assert.equal((await revised.status(ctx)).status, "queued");
    releaseNativeShell.resolve();
    assert.equal((await current.wait(ctx)).status, "done");
    assert.equal((await revised.wait(ctx)).status, "done");
    assert.match(nativeShellResults[0] ?? "", /较新的用户输入等待处理/);
    assert.equal(await readFile(join(nativePublication.cwd, "publication-audit.txt"), "utf8"), "revised\n");
  } finally { releaseNativeShell.resolve(); await publicationRuntime.close(); }
  console.log("PASS actual native shell process writes only the revised publication");

  for (const scenario of ["confirmed", "queued", "mixed", "edited"] as const) {
    const closingTask = `goal-close-${scenario}`;
    let closureGuard: { workId: string; expectedStateVersion: number; expectedIntentRevision: number; expectedOwnerEpoch: number };
    let revisedRequests = 0;
    let obsoleteRequests = 0;
    const closing = await fixture(closingTask, request => {
      const last = request.messages.at(-1);
      const user = request.messages.findLast(message => message.role === "user");
      if (JSON.stringify(user?.content ?? "").includes("new requirement")) {
        revisedRequests++;
        return text("新要求已收到，Goal 保持开启。");
      }
      if (last?.role === "toolResult") {
        obsoleteRequests++;
        return text("结项结果已读。");
      }
      const proposal = call("conversation_goal_propose_complete", { ...closureGuard, summary: "相关测试已通过。" }, "confirm-close");
      return scenario === "mixed" ? [...proposal, ...call("read", { path: "proof.txt" }, "parallel-read")] : proposal;
    });
    await writeFile(join(closing.cwd, "proof.txt"), "实测记录");
    const created = goals.create({ taskId: closingTask, title: "Isolated closure", criteria: [{ text: "相关测试通过" }] });
    assert(created.ok);
    const work = goals.workService.getWork(created.goal.id)!;
    closureGuard = { workId: work.workId, expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
    const closingRuntime = await closing.open();
    try {
      const original = await closingRuntime.submit("propose closing", "close-original");
      await waitUntil(() => interactions.listByTask(closingTask).some(row => row.status === "pending" && row.kind === "confirm"));
      const confirm = interactions.listByTask(closingTask).find(row => row.status === "pending" && row.kind === "confirm")!;
      assert.match(confirm.description ?? "", /全部验收条件/);
      const revised = scenario === "queued" || scenario === "mixed"
        ? await closingRuntime.submit("new requirement: keep Work open and recheck the result", "close-revised") : undefined;
      if (revised) assert.equal((await revised.status(ctx)).status, "queued");
      if (scenario === "edited") assert(goals.update({ goalId: work.workId,
        criterionUpdates: [{ id: work.criteria[0].id, text: "需要重新测试" }] }).ok);
      assert.equal(interactions.respond(confirm.id, true).ok, true);
      assert.equal((await original.wait(ctx)).status, "done");
      if (revised) {
        assert.equal((await revised.wait(ctx)).status, "done");
        assert.equal(revisedRequests, 1);
        assert.equal(obsoleteRequests, 0, "the provider must see the revised input before it can retry the old proposal");
      }
      const final = goals.workService.getWork(work.workId)!;
      assert.equal(final.lifecycle, scenario === "confirmed" ? "closed" : "active");
      assert.equal(final.criteria[0].status, scenario === "confirmed" ? "satisfied" : "pending");
      const attestations = goals.workService.repo.listEvidence(work.workId).filter(item => item.kind === "user_attestation");
      assert.deepEqual(attestations.map(item => [item.provenance, item.criterionIds]),
        scenario === "confirmed" ? [["user", [final.criteria[0].id]]] : []);
    } finally { await closingRuntime.close(); }
  }
  console.log("PASS Goal confirmation closes and attests atomically; edited criteria and queued input prevent stale completion");
  const written = { path: "new/nested/proof.txt", content: "proof" };
  const writeIntent = await prepareFileEffect({ type: "toolCall", id: "write-proof", name: "write", arguments: written }, root);
  assert(writeIntent?.kind === "file");
  assert.equal((await verifyFileEffect(writeIntent)).status, "inconclusive");
  await createWriteTool(root).execute("write-proof", written);
  assert.equal((await verifyFileEffect(writeIntent)).status, "passed");
  assert.equal((await verifyFileEffect(writeIntent, AbortSignal.abort())).status, "inconclusive");
  await writeFile(join(root, written.path), "other");
  assert.equal((await verifyFileEffect(writeIntent)).status, "inconclusive", "a transport success cannot prove changed bytes");
  const edited = { path: "mixed.txt", edits: [{ oldText: "second\rthird", newText: "updated\nthird" }] };
  await writeFile(join(root, edited.path), "\uFEFFfirst\nsecond\rthird\r\nlast");
  const editIntent = await prepareFileEffect({ type: "toolCall", id: "edit-proof", name: "edit", arguments: edited }, root);
  assert(editIntent?.kind === "file");
  await createEditTool(root).execute("edit-proof", edited);
  assert.equal((await verifyFileEffect(editIntent)).status, "passed", "verification agrees with the installed native edit on BOM and mixed newlines");
  assert.equal((await verifyFileEffect({ ...writeIntent, path: root, canonicalPath: root })).status, "inconclusive", "directories cannot become an unbounded verification stream");
  console.log("PASS file recovery compares native output, rejects changed bytes and supports cancellation");

  const editReceipts = new Map<string, boolean>();
  const parallelEdits = await fixture("parallel-disjoint-edits", request => {
    const receipts = request.messages.filter(message => message.role === "toolResult");
    if (!receipts.length) return [
      ...call("edit", { path: "lines.txt", edits: [{ oldText: "alpha", newText: "alpha changed" }] }, "edit-alpha"),
      ...call("edit", { path: "lines.txt", edits: [{ oldText: "bravo", newText: "bravo changed" }] }, "edit-bravo"),
    ];
    for (const receipt of receipts) editReceipts.set(receipt.toolCallId, receipt.isError === true);
    return text("done");
  });
  await writeFile(join(parallelEdits.cwd, "lines.txt"), "alpha\nbravo\n");
  const bothAdmitted = Promise.withResolvers<void>();
  let editAdmissions = 0;
  parallelEdits.state.beforeTool = async name => {
    if (name === "edit") {
      if (++editAdmissions === 2) bothAdmitted.resolve();
      await bothAdmitted.promise;
    }
  };
  const editRuntime = await parallelEdits.open();
  try { assert.equal((await (await editRuntime.submit("edit independent lines", "parallel-edits")).wait(ctx)).status, "done"); }
  finally { await editRuntime.close(); }
  assert.equal(await readFile(join(parallelEdits.cwd, "lines.txt"), "utf8"), "alpha changed\nbravo changed\n");
  assert.deepEqual([...editReceipts].sort(), [["edit-alpha", false], ["edit-bravo", false]]);
  const editProofs = db.connection.prepare(`SELECT status,
    json_extract(record_json, '$.verification.verifierId') AS verifier,
    json_extract(record_json, '$.verification.observed.bytes') AS bytes
    FROM execution_attempts WHERE task_id=? ORDER BY bytes`).all(parallelEdits.taskId);
  assert.deepEqual(editProofs, [
    { status: "passed", verifier: "durable-file-content", bytes: Buffer.byteLength("alpha changed\nbravo\n") },
    { status: "passed", verifier: "durable-file-content", bytes: Buffer.byteLength("alpha changed\nbravo changed\n") },
  ]);
  assert.equal(failures.list(parallelEdits.taskId).length, 0);
  console.log("PASS same-round edits verify their own file versions inside the shared mutation lease");

  // 旧 profile：退役专用表与旧 blocker 仍在时，真实读写与重启都不再被挡住，也不重放历史动作。
  const ungated = await fixture("legacy-quarantine", request => {
    const last = request.messages.at(-1);
    if (last?.role !== "toolResult") return call("write", { path: "resource.txt", content: "new write" }, "write-after-old-quarantine");
    assert(!last.isError, "old shared leases cannot reject unrelated native tools");
    return last.toolCallId === "write-after-old-quarantine" ? call("read", { path: "resource.txt" }, "read-after-write") : text("verified");
  });
  db.connection.exec(`CREATE TABLE IF NOT EXISTS work_resource_leases (token INTEGER PRIMARY KEY, lease_json TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_action_approvals (approval_id TEXT PRIMARY KEY, work_id TEXT, binding_id TEXT, operation_id TEXT, fingerprint TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS work_deferred_actions (approval_id TEXT PRIMARY KEY);`);
  db.connection.prepare("INSERT INTO work_resource_leases(token,lease_json,state) VALUES (1,?, 'quarantined')")
    .run(JSON.stringify({ owner: { taskId: "old-task" }, resources: [{ kind: "host", key: "unclassified-tool" }] }));
  db.connection.prepare("INSERT INTO work_action_approvals(approval_id,work_id,binding_id,operation_id,fingerprint,data_json) VALUES ('work-approval:old','w','b','old','f','{\"status\":\"pending\"}')").run();
  db.connection.prepare("INSERT INTO work_deferred_actions(approval_id) VALUES ('work-approval:old')").run();
  retireWorkIsolation(db.connection);
  for (const pass of [1, 2]) {
    const native = await ungated.open();
    try {
      assert.equal((await (await native.submit("write and verify", `ungated-${pass}`)).wait(ctx)).status, "done");
      assert.equal(await readFile(join(ungated.cwd, "resource.txt"), "utf8"), "new write");
      assert.equal(interactions.listByTask(ungated.taskId).filter(item => item.status === "pending").length, 0);
    } finally { await native.close(); }
  }
  console.log("PASS legacy host quarantine cannot block native read/write, including reopen, without deleting historical rows");

  let receiptReads = 0;
  let mutations = 0;
  const receiptRecovery: ExternalEffectRecovery = {
    prepare: async (_name, args, operationId) => ({ arguments: { ...args, operationId }, intent: {
      kind: "receipt", server: "filesystem", serverIdentity: "fixture", tool: "write_file", operationId,
      contract: { version: 1, idempotencyArgument: "operationId", receiptTool: "get_receipt", receiptArgument: "operationId",
        operationIdField: "operationId", statusField: "status", completedValues: ["completed"], failedValues: [] },
    } }),
    verify: async () => { receiptReads++; throw new Error("unauthorized receipt must not run"); },
  };
  const noReceipt = await fixture("receipt-not-authorized", request => request.messages.at(-1)?.role === "toolResult"
    ? text("wait for verification") : call("mcp_call_tool", { server: "filesystem", tool: "write_file", arguments: { path: "result.txt", content: "proof" } }), "native", [defineTool({
      name: "mcp_call_tool", description: "Receipt fixture", parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }), replay: "unsafe",
      execute: async args => { mutations++; assert.equal(typeof args.arguments.operationId, "string"); return { output: text("accepted") }; },
    })], [], receiptRecovery);
  noReceipt.state.deniedTools.add("mcp__filesystem__get_receipt");
  const receiptRuntime = await noReceipt.open();
  try {
    await (await receiptRuntime.submit("write", "receipt-unavailable-input")).wait(ctx);
    assert.equal(mutations, 1); assert.equal(receiptReads, 0);
    assert(failures.list(noReceipt.taskId).some(item => item.causeCode === "effect-unverified" && !item.resolvedAt), "an unavailable verifier must not turn a transport success into verified completion");
  } finally { await receiptRuntime.close(); }

  for (const blocked of [true, false]) {
    const taskId = blocked ? "receipt-admission-blocked" : "receipt-terminal-failure";
    const settled: string[] = [];
    let executed = 0, checked = 0;
    let modelResult: { error: boolean; output: string } | undefined;
    const scenario = await fixture(taskId, request => {
      const last = request.messages.at(-1);
      if (last?.role !== "toolResult") return call("mcp_call_tool", {
        server: "filesystem", tool: "write_file", arguments: { path: "result.txt", content: "proof" },
      });
      modelResult = { error: last.isError === true, output: last.content.map(block => block.type === "text" ? block.text : "").join("\n") };
      return text("done");
    }, "native", [defineTool({
      name: "mcp_call_tool", description: "Terminal receipt fixture", replay: "unsafe",
      parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
      execute: async () => { executed++; return { output: text("request accepted") }; },
    })], [], {
      prepare: receiptRecovery.prepare,
      verify: async intent => {
        checked++;
        return { status: "failed", verifierId: "durable-business-receipt", canonicalTarget: intent.operationId,
          expected: { operationId: intent.operationId }, observed: { operationId: intent.operationId, status: "rejected" }, checkedAt: Date.now() };
      },
    });
    if (blocked) scenario.state.admit = () => "work admission denied";
    scenario.state.settle = (_id, outcome) => settled.push(outcome);
    const native = await scenario.open();
    try { assert.equal((await (await native.submit("write", taskId)).wait(ctx)).status, "done"); }
    finally { await native.close(); }
    assert.deepEqual([executed, checked], blocked ? [0, 0] : [1, 1]);
    assert.deepEqual(settled, [blocked ? "released" : "consumed"]);
    assert.equal(modelResult?.error, true);
    assert.match(modelResult?.output ?? "", blocked ? /work admission denied/ : /业务回执确认本次操作失败/);
    assert(!failures.list(taskId).some(item => item.causeCode === "effect-unverified"));
    const attempt = db.connection.prepare("SELECT status, record_json FROM execution_attempts WHERE task_id=?").get(taskId) as
      { status: string; record_json: string } | undefined;
    assert.equal(attempt?.status, "failed");
    const { verification } = JSON.parse(attempt!.record_json);
    assert.equal(verification.verifierId, blocked ? "durable-tool-result" : "durable-business-receipt");
    if (!blocked) assert.equal(verification.observed.status, "rejected");
  }
  console.log("PASS terminal business receipt failures stay confirmed; blocked operations never query receipts");

  const waiting = await fixture("waiting", request => {
    const last = request.messages.at(-1);
    if (last?.role === "toolResult" && last.toolName === "request_user_input") return call("write", { path: "answer.txt", content: "answered" });
    if (last?.role === "toolResult") return text("continued after saved answer");
    return call("request_user_input", { title: "Which measurement?", kind: "confirm" });
  });
  let runtime = await waiting.open();
  try {
    const submitted = await runtime.submit("ask", "stable-input");
    await waitUntil(() => interactions.listByTask(waiting.taskId).some(item => item.status === "pending"));
    const question = interactions.listByTask(waiting.taskId)[0]!;
    await runtime.close();
    assert.equal(interactions.listByTask(waiting.taskId)[0]?.status, "pending", "closing the host detaches observation and preserves the question");
    interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
    runtime = await waiting.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx);
    assert(resumed);
    const completed = resumed.wait(ctx);
    assert.equal(interactions.respond(question.id, true).ok, true);
    assert.equal((await completed).status, "done");
    assert.equal(await readFile(join(waiting.cwd, "answer.txt"), "utf8"), "answered");
    assert.equal(interactions.listByTask(waiting.taskId).length, 1, "native replay reuses the original question");
    const records = db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id=?").all(waiting.taskId);
    assert.equal(records.length, 1, "one native write has one execution record");
    const duplicate = await runtime.submit("ask", "stable-input");
    assert.equal(duplicate.id, submitted.id);
    assert.equal((await duplicate.wait(ctx)).status, "done");
    assert.equal(attemptCount(waiting.taskId), 1);
  } finally { await runtime.close(); }
  console.log("PASS native question survives close/reopen, resumes the original input and records one completed write");

  const legacyApproval = await fixture("old-pending-approval", request => request.messages.at(-1)?.role === "toolResult"
    ? text("done") : call("write", { path: "recovered.txt", content: "recovered" }, "legacy-write"));
  legacyApproval.state.legacyApproval = true;
  let upgrading = await legacyApproval.open();
  const oldSubmission = await upgrading.submit("write", "old-approval-input");
  await waitUntil(() => interactions.listByTask(legacyApproval.taskId).some(item => item.status === "pending"));
  const oldQuestion = interactions.listByTask(legacyApproval.taskId)[0]!;
  await upgrading.close();
  legacyApproval.state.legacyApproval = false;
  upgrading = await legacyApproval.open();
  try {
    const recovered = await upgrading.harness.submission(oldSubmission.id, ctx); assert(recovered);
    assert.equal((await recovered.wait(ctx)).status, "done");
    assert.equal(await readFile(join(legacyApproval.cwd, "recovered.txt"), "utf8"), "recovered");
    assert.equal(interactions.listByTask(legacyApproval.taskId).find(item => item.id === oldQuestion.id)?.status, "cancelled");
    const followup = interactions.requestDurable(oldQuestion, { kind: "confirm", title: "允许执行 write？" }, { key: "user-clarification" });
    const actualQuestion = interactions.listByTask(legacyApproval.taskId).find(item => item.status === "pending")!;
    assert(actualQuestion && actualQuestion.id !== oldQuestion.id);
    assert.equal(interactions.cancelDurable(oldQuestion, "approval:legacy-write").ok, false);
    assert.equal(interactions.listByTask(legacyApproval.taskId).find(item => item.id === actualQuestion.id)?.status, "pending", "same text is not an approval identity");
    assert.equal(interactions.respond(actualQuestion.id, true).ok, true);
    assert.equal(await followup, true);
  } finally { await upgrading.close(); }
  console.log("PASS persisted old approval resumes after upgrade; same-title clarification survives and can be answered");

  const permission = await fixture("approval", request => request.messages.at(-1)?.role === "toolResult"
    ? text("done") : call("write", { path: "approved.txt", content: "approved" }));
  permission.state.permission = "default";
  runtime = await permission.open();
  try {
    const submitted = await runtime.submit("write", "approval-input");
    assert.equal((await submitted.wait(ctx)).status, "done");
    assert.equal(await readFile(join(permission.cwd, "approved.txt"), "utf8"), "approved");
    assert.equal(interactions.listByTask(permission.taskId).length, 0);
  } finally { await runtime.close(); }
  console.log("PASS legacy default executes directly without creating an approval");

  for (const mode of ["native", "codemode"] as const) for (const restriction of ["readonly", "loadout"] as const) {
    const denied = await fixture(`${mode}-${restriction}`, request => request.messages.at(-1)?.role === "toolResult"
      ? text("blocked") : mode === "native" ? call("write", { path: "denied.txt", content: "forbidden" })
        : call("codemode", { code: 'await tools.write({path:"denied.txt",content:"forbidden"});' }), mode);
    denied.state.permission = restriction === "readonly" ? "readonly" : "auto";
    denied.state.allowed = restriction !== "loadout";
    runtime = await denied.open();
    try {
      const submitted = await runtime.submit("write", `denied-${mode}-${restriction}`);
      assert.equal((await submitted.wait(ctx)).status, "done");
      if (restriction === "loadout") await assert.rejects(access(join(denied.cwd, "denied.txt")));
      else assert.equal(await readFile(join(denied.cwd, "denied.txt"), "utf8"), "forbidden");
      assert.equal(interactions.listByTask(denied.taskId).length, 0);
      assert.equal(attemptCount(denied.taskId), restriction === "loadout" ? 0 : 1);
    } finally { await runtime.close(); }
  }
  console.log("PASS native and Code Mode ignore legacy readonly while unavailable tools stay unavailable");

  const protectedRoot = join(root, "source-repository");
  await mkdir(protectedRoot);
  for (const restriction of ["auto", "default", "readonly", "loadout"] as const) {
    let calls = 0;
    const wrapped = await fixture(`wrapped-${restriction}`, request => request.messages.at(-1)?.role === "toolResult"
      ? text("blocked") : call("mcp_call_tool", { server: "filesystem", tool: "write_file", arguments: { path: join(protectedRoot, "source.txt"), content: "forbidden" } }), "native", [defineTool({
        name: "mcp_call_tool", description: "MCP transport fixture", replay: "unsafe",
        parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
        execute: async () => { calls++; return { output: text("wrote") }; },
      })], [protectedRoot]);
    wrapped.state.permission = restriction === "loadout" ? "auto" : restriction;
    wrapped.state.allowed = restriction !== "loadout";
    runtime = await wrapped.open();
    try {
      assert.equal((await (await runtime.submit("write", `wrapper-${restriction}`)).wait(ctx)).status, "done");
      assert.equal(calls, restriction === "loadout" ? 0 : 1, "MCP retains availability without legacy permissions or path grants");
      assert.equal(interactions.listByTask(wrapped.taskId).length, 0, "isolated source denial cannot be overridden by approval");
      assert.equal(attemptCount(wrapped.taskId), restriction === "loadout" ? 0 : 1);
    } finally { await runtime.close(); }
  }
  console.log("PASS MCP wrapper keeps actual tool identity and availability, not retired mode/path grants");

  let malformedCalls = 0;
  const malformed = await fixture("malformed-wrapper", request => request.messages.at(-1)?.role === "toolResult"
    ? text("correct invalid arguments") : call("mcp_call_tool", { server: "filesystem" }), "native", [defineTool({
      name: "mcp_call_tool", description: "MCP transport fixture", replay: "unsafe",
      parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
      execute: async () => { malformedCalls++; return { output: text("unreachable") }; },
    })]);
  runtime = await malformed.open();
  try {
    assert.equal((await (await runtime.submit("invalid call", "malformed-input")).wait(ctx)).status, "done");
    assert.equal(malformedCalls, 0, "invalid MCP arguments finish as a normal tool error without execution or recovery loop");
  } finally { await runtime.close(); }
  console.log("PASS malformed MCP wrapper returns a tool validation error without restarting execution");

  // Real BrowserAutomationService validation, durable checkpoint and settlement.
  // The transport fixture never supplies trusted proof through result details.
  for (const scenario of ["invalid-url", "missing-selector", "started-failure", "read-failure", "forged-proof"] as const) {
    let surfaceCalls = 0;
    const browser = new BrowserAutomationService(() => {
      surfaceCalls++;
      const wc = { id: 1, isDestroyed: () => false, getURL: () => "https://example.test", getTitle: () => "test", executeJavaScript: async () => { throw Error("read renderer failure"); } };
      const page = { inspectionWebContents: wc, captureVersion: 0, url: "https://example.test", withAutomationSurface: async (operation: () => Promise<unknown>) => operation(),
        navigateForAutomation: async () => { throw new Error("connection lost after navigation began"); },
      };
      const tab = { id: "fixture-tab", taskId, url: page.url };
      return { attached: true, activeTabId: tab.id, listTabs: () => [tab], getTabHost: () => page, ensureTab: () => tab, getTaskTab: () => tab, setTaskTab: () => true } as any;
    });
    const taskId = `receipt-${scenario}`;
    const args: JsonObject = scenario === "invalid-url" ? { action: "navigate", url: "file:///tmp/test.html" }
      : scenario === "missing-selector" ? { action: "press", key: "PageDown" }
      : scenario === "read-failure" ? { action: "read", tabId: "fixture-tab" } : { action: "navigate", url: "https://example.test" };
    const settled: string[] = [];
    const f = await fixture(taskId, request => request.messages.at(-1)?.role === "toolResult"
      ? text("continue independent work") : call("browser_exec", args), "native", [defineTool({
        name: "browser_exec", description: "Real browser service validation", replay: "unsafe",
        parameters: Type.Object({ action: Type.String(), url: Type.Optional(Type.String()), key: Type.Optional(Type.String()), tabId: Type.Optional(Type.String()) }),
        execute: async (input, api, context) => {
          if (scenario === "forged-proof") return { isError: true, output: text("failed"),
            details: { phase: "validation", toolName: "browser_exec", callId: api.callId, taskId: api.taskId, conversationId: api.conversationId } };
          const execution = await durableExecutionContext(taskId, api, context);
          return withDurableExecution({ execution, native: api, context, cwd: root, runId: taskId }, async () => {
            try { await browser.execute(input as any); return { output: text("unexpected") }; }
            catch (error) { return { isError: true, output: text(String(error)) }; }
          });
        },
      })]);
    f.state.settle = (_id, outcome) => settled.push(outcome);
    const r = await f.open();
    try { assert.equal((await (await r.submit("execute", taskId)).wait(ctx)).status, "done"); }
    finally { await r.close(); }
    assert.deepEqual(settled, [scenario === "invalid-url" || scenario === "missing-selector" ? "released" : "consumed"]);
    if (scenario === "invalid-url" || scenario === "missing-selector") assert.equal(surfaceCalls, 0, "validation cannot touch browser");
  }
  console.log("PASS host validation proof releases only the exact unstarted call; completed failures are consumed, output cannot forge not-started proof");

  // Real artifact tool + durable hooks: only the initial missing-source path
  // is a completed failure; storage failures retain an unknown outcome.
  for (const storageFailure of [false, true]) {
    const taskId = storageFailure ? "artifact-store-failure" : "artifact-path-recovery";
    const f = await fixture(taskId, request => {
      const results = request.messages.filter(message => message.role === "toolResult");
      if (!results.length) return call("register_artifact", { path: storageFailure ? "result.json" : "inputs/result.json" }, "artifact-first");
      if (!storageFailure && results.length === 1) return call("register_artifact", { path: join(root, taskId, "result.json") }, "artifact-corrected");
      return text("Report actual registration outcomes without regenerating the source.");
    });
    await writeFile(join(f.cwd, "result.json"), '{"value":58}');
    const outcomes: string[] = [];
    f.state.settle = (_id, outcome) => outcomes.push(outcome);
    const r = await f.open();
    try {
      if (storageFailure) await writeFile(join(f.cwd, "state", "artifacts"), "not a directory");
      assert.equal((await (await r.submit("register existing result", taskId)).wait(ctx)).status, "done");
      assert.deepEqual(outcomes, storageFailure ? ["unknown"] : ["consumed", "consumed"]);
      const records = (db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id=? ORDER BY rowid").all(taskId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json));
      assert.equal(records[0].status, storageFailure ? "inconclusive" : "failed");
      assert.equal(records[0].verification.observed.isError, true);
      if (!storageFailure) assert.equal(records[1].status, "passed");
      assert.equal(await readFile(join(f.cwd, "result.json"), "utf8"), '{"value":58}');
    } finally { await r.close(); }
  }
  console.log("PASS artifact missing-source failure is not success or unknown; storage failure remains unknown");

  // A nonzero process exit is not proof that no effect occurred. In particular,
  // a failed subprocess can follow an already-completed write.
  const partialShell = await fixture("partial-shell", request => request.messages.at(-1)?.role === "toolResult"
    ? text("retain the completed file; inspect the failure")
    : call("terminal_exec", { action: "execute" }), "native", [defineTool({
      name: "terminal_exec", description: "Real partial process failure", replay: "unsafe",
      parameters: Type.Object({ action: Type.String() }),
      execute: async () => new Promise(resolve => {
        execFile(process.execPath, ["-e", "require('node:fs').writeFileSync('partial.txt','proof'); process.exitCode=2"],
          { cwd: join(root, "partial-shell") }, error => resolve({ isError: Boolean(error), output: text(String(error)),
            structuredOutput: { exitCode: error?.code ?? 0 } }));
      }),
    })]);
  const partialOutcomes: string[] = [];
  partialShell.state.settle = (_id, outcome) => partialOutcomes.push(outcome);
  const partialRuntime = await partialShell.open();
  try { assert.equal((await (await partialRuntime.submit("partial shell", "partial-shell")).wait(ctx)).status, "done"); }
  finally { await partialRuntime.close(); }
  assert.equal(await readFile(join(partialShell.cwd, "partial.txt"), "utf8"), "proof");
  assert.deepEqual(partialOutcomes, ["consumed"], "A completed failure consumes the action without denying its partial effects");
  assert.equal(failures.list(partialShell.taskId).filter(item => !item.resolvedAt).length, 0);
  console.log("PASS real process partial write plus failure is consumed without falsely declaring not_started");

  // Exercise the installed native shell, not a mocked afterTool callback. Six
  // independent durable stores run concurrently, including nested Code Mode calls.
  await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const mode = index % 2 ? "codemode" : "native";
    const taskId = `native-shell-failure-${index}`;
    const failedCommand = nodeCommand("require('node:fs').appendFileSync('partial.txt','once\\n'); console.error('intentional failure'); process.exitCode=2");
    const outcomes: string[] = [];
    const f = await fixture(taskId, request => {
      const results = request.messages.filter(message => message.role === "toolResult");
      if (!results.length) return mode === "native" ? call(shellName, { command: failedCommand }, "partial-process")
        : call("codemode", { code: `const result = await tools.${shellName}(${JSON.stringify({ command: failedCommand })}); console.log(result);` }, "partial-code");
      if (results.length === 1) return mode === "native" ? call("write", { path: "continued.txt", content: "independent work continued" }, "independent-write")
        : call("codemode", { code: 'await tools.write({path:"continued.txt",content:"independent work continued"});' }, "independent-code");
      return text("The command failed after a partial write; independent work completed.");
    }, mode);
    f.state.settle = (_id, outcome) => outcomes.push(outcome);
    let r = await f.open();
    try {
      const submitted = await r.submit("run a failing shell and continue", taskId);
      assert.equal((await submitted.wait(ctx)).status, "done");
      assert.equal(await readFile(join(f.cwd, "partial.txt"), "utf8"), "once\n");
      assert.equal(await readFile(join(f.cwd, "continued.txt"), "utf8"), "independent work continued");
      assert.deepEqual(outcomes, ["consumed", "consumed"], `${mode} completed failure must not create an unknown settlement`);
      const records = (db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id=? ORDER BY rowid").all(taskId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json));
      const shellAttempt = records.find(record => record.toolName === shellName);
      assert(shellAttempt, "native shell execution must be tracked");
      assert.equal(shellAttempt.status, "failed", "nonzero structured exit is a failure, even if the native adapter does not preserve isError");
      assert.equal(shellAttempt.phase, "finished");
      assert.equal(shellAttempt.verification?.observed?.exitCode, 2, "keep the actual structured process exit as evidence");
      assert.equal(failures.list(taskId).filter(item => !item.resolvedAt).length, 0);
      await r.close();
      recoverInterruptedExecutions(attempts, failures);
      r = await f.open();
      const duplicate = await r.submit("run a failing shell and continue", taskId);
      assert.equal(duplicate.id, submitted.id);
      assert.equal((await duplicate.wait(ctx)).status, "done");
      assert.equal(await readFile(join(f.cwd, "partial.txt"), "utf8"), "once\n", "completed unsafe shell is never replayed on reopen");
      assert.equal(attemptCount(taskId), records.length);
      assert.equal(failures.list(taskId).filter(item => !item.resolvedAt).length, 0);
    } finally { await r.close(); }
  }));
  console.log("PASS six parallel native/Code Mode shells preserve partial effects and nonzero exit evidence, continue independent tools, and never replay on reopen");

  const childOutcomes: string[] = [];
  const childFixture = await fixture("child-shell-failure", request => {
    const parent = request.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
    const results = request.messages.filter(message => message.role === "toolResult");
    if (parent) return results.length ? text("child completed independent work") : call("subagent", {
      agent: "shell-worker", task: "Run a partial failing command then write continued.txt", model: "fixture/model",
      agentScope: "project", confirmProjectAgents: false, isolation: "shared",
    });
    if (!results.length) return call(shellName, { command: nodeCommand("require('node:fs').appendFileSync('child-partial.txt','once'); process.exitCode=2") }, "child-partial");
    if (results.length === 1) return call("write", { path: "child-continued.txt", content: "continued" }, "child-continued");
    return text("The shell failed with partial effects; the next tool succeeded.");
  }, "native", [], [], undefined, true);
  await mkdir(join(childFixture.cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
  await writeFile(join(childFixture.cwd, CONFIG_DIR_NAME, "agents", "shell-worker.md"), `---\nname: shell-worker\ndescription: Native shell failure fixture\ntools: ${shellName},write\n---\nRun the shell then continue independent work.\n`);
  childFixture.state.settle = (_id, outcome) => childOutcomes.push(outcome);
  let childRuntime = await childFixture.open();
  try {
    const submission = await childRuntime.submit("delegate the command", "child-failure-input");
    assert.equal((await submission.wait(ctx)).status, "done");
    assert.equal(await readFile(join(childFixture.cwd, "child-partial.txt"), "utf8"), "once");
    assert.equal(await readFile(join(childFixture.cwd, "child-continued.txt"), "utf8"), "continued");
    assert.deepEqual(childOutcomes, ["consumed", "consumed", "consumed"], "child failures and delegation settle without a whole-task blocker");
    await childRuntime.close();
    recoverInterruptedExecutions(attempts, failures);
    childRuntime = await childFixture.open();
    assert.equal((await (await childRuntime.submit("delegate the command", "child-failure-input")).wait(ctx)).status, "done");
    assert.equal(await readFile(join(childFixture.cwd, "child-partial.txt"), "utf8"), "once", "child unsafe shell is not replayed");
    assert.equal(failures.list(childFixture.taskId).filter(item => !item.resolvedAt).length, 0);
  } finally { await childRuntime.close(); }
  console.log("PASS native subagent shell failure continues independent child tools and never replays after reopen");

  const timeoutOutcomes: string[] = [];
  const timedOut = await fixture("native-shell-timeout", request => {
    const results = request.messages.filter(message => message.role === "toolResult");
    if (!results.length) return call(shellName, { command: nodeCommand("require('node:fs').appendFileSync('timeout-partial.txt','once'); setInterval(()=>{},1000)"), timeout: 1 }, "timed-process");
    if (results.length === 1) return call("write", { path: "timeout-continued.txt", content: "continued" }, "timeout-independent");
    return text("The timed-out command may have partial effects; independent work continued.");
  });
  timedOut.state.settle = (_id, outcome) => timeoutOutcomes.push(outcome);
  let timedRuntime = await timedOut.open();
  try {
    const submitted = await timedRuntime.submit("run bounded command then continue", "timeout-input");
    assert.equal((await submitted.wait(ctx)).status, "done");
    assert.equal(await readFile(join(timedOut.cwd, "timeout-partial.txt"), "utf8"), "once");
    assert.equal(await readFile(join(timedOut.cwd, "timeout-continued.txt"), "utf8"), "continued");
    assert.deepEqual(timeoutOutcomes, ["unknown", "consumed"], "a true timeout retains uncertainty without stopping unrelated tools");
    const timedAttempt = db.connection.prepare("SELECT status FROM execution_attempts WHERE task_id=? AND status='inconclusive'").get(timedOut.taskId);
    assert(timedAttempt, "the timed-out process retains durable uncertainty evidence");
    await timedRuntime.close();
    recoverInterruptedExecutions(attempts, failures);
    timedRuntime = await timedOut.open();
    assert.equal((await (await timedRuntime.submit("run bounded command then continue", "timeout-input")).wait(ctx)).status, "done");
    assert.equal(await readFile(join(timedOut.cwd, "timeout-partial.txt"), "utf8"), "once", "timed-out unsafe command cannot replay after reopen");
  } finally { await timedRuntime.close(); }
  console.log("PASS real shell timeout preserves unknown partial effects, permits independent tools and does not replay");

  let effects = 0;
  const effectFile = join(root, "unconfirmed-effect.txt");
  const interrupted = await fixture("interrupted", request => request.messages.at(-1)?.role === "toolResult"
    ? text("inspect the unconfirmed effect") : call("terminal_exec", { action: "execute" }), "native", [defineTool({
      name: "terminal_exec", description: "Fixture external side effect", parameters: Type.Object({ action: Type.String() }), replay: "unsafe",
      execute: async (_args, _api, context) => {
        await writeFile(effectFile, String(++effects));
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("fixture host closed after side effect"));
          assert(context.abortSignal);
          context.abortSignal.addEventListener("abort", abort, { once: true });
          if (context.abortSignal.aborted) abort();
        });
        return { output: text("unreachable") };
      },
    })]);
  runtime = await interrupted.open();
  try {
    const submitted = await runtime.submit("execute", "interrupted-input");
    await waitUntil(() => effects === 1);
    await runtime.close();
    recoverInterruptedExecutions(attempts, failures);
    runtime = await interrupted.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx); assert(resumed);
    assert.equal((await resumed.wait(ctx)).status, "done");
    assert.equal(effects, 1, "an unconfirmed side effect must never replay");
    assert.equal(await readFile(effectFile, "utf8"), "1");
    assert.equal(attemptCount(interrupted.taskId), 1);
    const unresolved = failures.list(interrupted.taskId).filter(item => !item.resolvedAt);
    assert.equal(unresolved.length, 1, "restart projection and native recovery share one failure identity");
    assert.equal(unresolved[0]?.sideEffects, "unknown");
    assert.equal(unresolved[0]?.recovery, "requires-user-action");
  } finally { await runtime.close(); }
  console.log("PASS unsafe side effect retains one unknown-outcome record and never replays after reopen");

  const stopped = await fixture("stopped", request => request.messages.at(-1)?.role === "toolResult"
    ? text("stopped") : call("request_user_input", { title: "Stop this question", kind: "confirm" }));
  runtime = await stopped.open();
  try {
    await runtime.submit("ask", "stop-input");
    await waitUntil(() => interactions.listByTask(stopped.taskId).some(item => item.status === "pending"));
    await runtime.abort();
    assert.equal(interactions.listByTask(stopped.taskId)[0]?.status, "cancelled", "explicit Stop settles the question");
  } finally { await runtime.close(); }
  console.log("PASS explicit Stop cancels persistent interaction");
} finally { db.close(); }
