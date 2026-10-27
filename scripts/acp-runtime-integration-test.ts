import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";
import type { ExternalAgentConfigOptionDto, ExternalAgentConfigSelections, ExternalAgentUiEvent } from "../src/shared/external-agent";

const root = mkdtempSync(join(tmpdir(), "mybuddy-acp-runtime-test-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
const db = new AppDatabase(join(root, "app.db"));
db.upsertTask({ id: "task-1", title: "ACP Runtime Test", updatedAt: Date.now() });
const fixture = join(process.cwd(), "scripts", "fixtures", "mock-acp-agent.mjs");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  const events: ExternalAgentUiEvent[] = [];
  const runtime = new ExternalAgentRuntime(db, () => cwd, async () => []);
  runtime.setSend((event) => events.push(event));

  // --- catalog manifest: DeepSeek Harness 通过 `dsh --profile acp` 原生接入 ----
  // 这里真实探测本机 PATH：CI 上没有 dsh 时 availability=missing，但条目与命令契约必须稳定。
  const catalog = runtime.listAgents();
  const dshAgent = catalog.find((item) => item.id === "dsh");
  assert.ok(dshAgent, "ACP 目录必须列出 DeepSeek Harness");
  assert.equal(dshAgent.name, "DeepSeek Harness");
  assert.equal(dshAgent.commandLabel, "dsh --profile acp", "ACP 会话由 dsh 的 acp profile 提供（不是独立 bin）");
  assert.equal(dshAgent.protocol, "acp");
  assert.ok(
    dshAgent.availability === "ready" || dshAgent.availability === "missing",
    "dsh 走原生命令探测，不挂 MyBuddy 适配器包",
  );
  if (dshAgent.availability === "missing") {
    assert.match(dshAgent.detail ?? "", /@deepseek-ai\/dsh/, "缺少 CLI 时 detail 给出安装命令");
  }
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length, "ACP 目录 id 唯一");

  // Keep this test independent from whatever ACP CLIs happen to be installed locally.
  (runtime as any).listAgents = () => [{
    id: "devin",
    name: "Devin",
    protocol: "acp",
    available: true,
    availability: "ready",
    commandLabel: "mock-acp",
    detail: "mock",
  }];
  let currentBehavior = "default";
  (runtime as any).launch = (_manifest: unknown, runCwd: string) => {
    const child = spawn(process.execPath, [fixture], {
      cwd: runCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, MOCK_ACP_BEHAVIOR: currentBehavior },
    });
    if (currentBehavior === "hang") {
      const kill = child.kill.bind(child);
      child.kill = (signal) => { setTimeout(() => kill(signal), 250).unref(); return true; };
    }
    return child;
  };

  const first = runtime.prompt({
    taskId: "task-1",
    agentId: "devin",
    text: "first prompt",
    userMessageId: "u-1",
    assistantMessageId: "a-1",
  });

  const permission1 = await waitFor(
    () => events.find((event) => event.runId === first.runId && event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
    "first permission request",
  );
  assert.equal(permission1.patch.type, "tool_start");
  if (permission1.patch.type !== "tool_start") throw new Error("unexpected patch type");
  assert.equal(permission1.patch.toolCallId, "permission-tool");
  const allow = runtime.resolvePermission({ runId: first.runId, toolCallId: "permission-tool", optionId: "allow" });
  assert.equal(allow.ok, true);

  const firstRun = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === first.runId && run.status === "completed"),
    "first ACP completion",
  );
  assert.equal(firstRun.sessionId, "mock-session-1");
  assert.equal(firstRun.capabilities.resumeSupported, true);
  assert.equal(firstRun.continuationMode, "new");
  const firstMessage = runtime.history("task-1").messages.find((message) => message.id === "a-1")!;
  assert.match(firstMessage.text, /mock-chunk/);
  assert.match(firstMessage.text, /diag-ok/, "Devin diagnostics shim answers the extension request end-to-end");
  assert.match(firstMessage.text, /permission-selected-allow/);

  events.length = 0;
  const second = runtime.prompt({
    taskId: "task-1",
    agentId: "devin",
    text: "second prompt",
    userMessageId: "u-2",
    assistantMessageId: "a-2",
    continueFromRunId: first.runId,
  });

  await waitFor(
    () => events.find((event) => event.runId === second.runId && event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
    "resume permission request",
  );
  const reject = runtime.resolvePermission({ runId: second.runId, toolCallId: "permission-tool", optionId: "reject" });
  assert.equal(reject.ok, true);

  const secondRun = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === second.runId && run.status === "completed"),
    "resumed ACP completion",
  );
  assert.equal(secondRun.sessionId, "mock-session-1");
  assert.equal(secondRun.continuationMode, "resume");
  const secondMessage = runtime.history("task-1").messages.find((message) => message.id === "a-2")!;
  assert.match(secondMessage.text, /permission-selected-reject/);

  // --- tool_call / tool_call_update stream -----------------------------------
  events.length = 0;
  currentBehavior = "toolcall";
  const toolRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "tool run",
    userMessageId: "u-3", assistantMessageId: "a-3",
  });
  await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === toolRun.runId && run.status === "completed"),
    "tool_call run completion",
  );
  assert.ok(events.some((event) => event.patch.type === "tool_start" && event.patch.toolCallId === "tc-1"), "tool_start emitted");
  assert.ok(events.some((event) => event.patch.type === "tool_update" && event.patch.toolCallId === "tc-1" && event.patch.status === "success"), "tool_update success emitted");
  const toolMessage = runtime.history("task-1").messages.find((message) => message.id === "a-3")!;
  assert.equal(toolMessage.tools?.[0]?.status, "success");

  // --- session/load continuation (no resume capability) ----------------------
  currentBehavior = "load";
  const loadRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "load run",
    userMessageId: "u-4", assistantMessageId: "a-4",
    continueFromRunId: first.runId,
  });
  const loadDone = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === loadRun.runId && run.status === "completed"),
    "load continuation completion",
  );
  assert.equal(loadDone.continuationMode, "load");
  assert.equal(loadDone.sessionId, "mock-session-1");

  // --- fallback_new when agent supports neither resume nor load ---------------
  currentBehavior = "neither";
  const fallbackRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "fallback run",
    userMessageId: "u-5", assistantMessageId: "a-5",
    continueFromRunId: first.runId,
  });
  const fallbackDone = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === fallbackRun.runId && run.status === "completed"),
    "fallback continuation completion",
  );
  assert.equal(fallbackDone.continuationMode, "fallback_new");
  assert.equal(fallbackDone.sessionId, "mock-session-1");

  // --- authenticate retry: session/new rejects once, then succeeds ------------
  events.length = 0;
  currentBehavior = "auth";
  const authRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "auth run",
    userMessageId: "u-6", assistantMessageId: "a-6",
  });
  await waitFor(
    () => events.find((event) => event.runId === authRun.runId && event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
    "auth permission request",
  );
  runtime.resolvePermission({ runId: authRun.runId, toolCallId: "permission-tool", optionId: "allow" });
  const authDone = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === authRun.runId && run.status === "completed"),
    "auth retry completion",
  );
  assert.equal(authDone.status, "completed");
  const authMessage = runtime.history("task-1").messages.find((message) => message.id === "a-6")!;
  assert.match(authMessage.text, /authed-via-mock/, "authenticate request ran before the session retry");

  // --- cancel a hung prompt ---------------------------------------------------
  currentBehavior = "hang";
  const hangRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "hang run",
    userMessageId: "u-7", assistantMessageId: "a-7",
  });
  await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === hangRun.runId && run.status === "working"),
    "hung run reaching working",
  );
  const cancelResult = await runtime.cancel(hangRun.runId);
  assert.equal(cancelResult.ok, true);
  assert.equal(runtime.active("task-1").some((run) => run.runId === hangRun.runId), false, "cancelled run is hidden immediately");
  assert.equal(runtime.hasLiveTaskRun("task-1"), true, "permanent delete remains blocked until cancelled process closes");
  const hangDone = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === hangRun.runId && run.status === "cancelled"),
    "cancelled run settling",
  );
  assert.equal(hangDone.capabilities.cancelSupported, false);
  await waitFor(() => !runtime.hasLiveTaskRun("task-1") ? true : undefined, "cancelled process ownership released after close");

  // --- process crash becomes a failed run with recovery state -----------------
  currentBehavior = "crash";
  const crashRun = runtime.prompt({
    taskId: "task-1", agentId: "devin", text: "crash run",
    userMessageId: "u-8", assistantMessageId: "a-8",
  });
  const crashDone = await waitFor(
    () => runtime.history("task-1").runs.find((run) => run.runId === crashRun.runId && run.status === "failed"),
    "crashed run settling",
  );
  assert.match(crashDone.error ?? "", /mock-crash-signal/, "stderr tail lands in the run error");
  assert.equal(crashDone.recovery.state, "resume-available", "failed run with session + resume capability offers recovery");

  // --- ACP management: testAgent connectivity check --------------------------
  currentBehavior = "default";
  const testResult = await runtime.testAgent("devin");
  assert.equal(testResult.ok, true);
  assert.equal(testResult.sessionId, "mock-session-1");
  assert.equal(testResult.resumeSupported, true);
  assert.deepEqual(testResult.steps.map((step) => step.id), ["launch", "initialize", "session"]);
  assert.ok(testResult.steps.every((step) => step.ok));

  currentBehavior = "auth";
  const authTest = await runtime.testAgent("devin");
  assert.equal(authTest.ok, true);
  assert.deepEqual(authTest.authMethods, ["Mock OAuth"]);
  assert.equal(authTest.sessionId, "mock-session-1");

  // --- ACP management: disabled agent is rejected + failed launch surfaces ---
  const disabledRuntime = new ExternalAgentRuntime(db, () => cwd, async () => [], () => ["devin"]);
  try {
    assert.throws(
      () => disabledRuntime.prompt({
        taskId: "task-1",
        agentId: "devin",
        text: "blocked prompt",
        userMessageId: "u-9",
        assistantMessageId: "a-9",
      }),
      /停用/,
    );
    let probeCount = 0;
    const originalProbe = (disabledRuntime as any).probeAgents.bind(disabledRuntime);
    (disabledRuntime as any).probeAgents = () => { probeCount += 1; return originalProbe(); };
    const managed = disabledRuntime.listAgents();
    const originalNow = Date.now;
    const detectedAt = Date.now();
    try {
      Date.now = () => detectedAt + 60_000;
      disabledRuntime.listAgents();
      assert.equal(probeCount, 1, "normal catalog reads must not expire and re-probe CLIs");
      disabledRuntime.listAgents(true);
      assert.equal(probeCount, 2, "explicit re-detection must re-probe CLIs");
    } finally {
      Date.now = originalNow;
    }
    assert.equal(managed.find((item) => item.id === "devin")?.enabled, false);
    assert.ok(managed.filter((item) => item.id !== "devin").every((item) => item.enabled === true));

    (disabledRuntime as any).launch = () => { throw new Error("no-cli-signal"); };
    const launchFail = await disabledRuntime.testAgent("devin");
    assert.equal(launchFail.ok, false);
    assert.equal(launchFail.steps[0]?.id, "launch");
    assert.equal(launchFail.steps[0]?.ok, false);
    assert.match(launchFail.error ?? "", /no-cli-signal/);
  } finally {
    disabledRuntime.dispose();
  }

  // --- session config options: capture, persist, apply before prompt ---------
  currentBehavior = "default";
  const storedOptions: Record<string, ExternalAgentConfigOptionDto[]> = {};
  const storedSelections: Record<string, ExternalAgentConfigSelections> = {
    devin: { model: "mock/model-b", fast: true },
  };
  const configRuntime = new ExternalAgentRuntime(db, () => cwd, async () => [], () => [], {
    readSelections: (id) => storedSelections[id] ?? {},
    readOptions: (id) => storedOptions[id] ?? [],
    writeOptions: (id, options) => { storedOptions[id] = options; },
  });
  try {
    // Stub the probe (not listAgents) so the real merge of config fields is exercised.
    (configRuntime as any).probeAgents = () => [{
      id: "devin", name: "Devin", protocol: "acp", available: true,
      availability: "ready", commandLabel: "mock-acp", detail: "mock", enabled: true,
    }];
    (configRuntime as any).launch = (_manifest: unknown, runCwd: string) => spawn(process.execPath, [fixture], {
      cwd: runCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, MOCK_ACP_BEHAVIOR: currentBehavior },
    });

    // testAgent captures configOptions, applies saved selections, persists snapshot.
    const cfgTest = await configRuntime.testAgent("devin");
    assert.equal(cfgTest.ok, true);
    const modelOption = cfgTest.configOptions?.find((item) => item.id === "model");
    assert.equal(modelOption?.currentValue, "mock/model-b", "saved model selection applied inside the test session");
    assert.equal(modelOption?.options?.length, 2);
    const tierOption = cfgTest.configOptions?.find((item) => item.id === "tier");
    assert.equal(tierOption?.options?.length, 2, "select group flattened into the flat value list");
    assert.equal(tierOption?.options?.[0]?.group, "Group One");
    const fastOption = cfgTest.configOptions?.find((item) => item.id === "fast");
    assert.equal(fastOption?.currentValue, true, "boolean selection applied");
    assert.equal(storedOptions["devin"]?.length, 3, "options snapshot persisted to the store");

    // listAgents merges stored options + selections onto the descriptor.
    const merged = configRuntime.listAgents().find((item) => item.id === "devin");
    assert.equal(merged?.configOptions?.length, 3);
    assert.equal(merged?.configSelections?.["model"], "mock/model-b");
    assert.equal(merged?.configSelections?.["fast"], true);

    // prompt path applies the selection via session/set_config_option before session/prompt.
    // "toolcall" behavior skips the permission request so the run completes unattended.
    currentBehavior = "toolcall";
    const cfgRun = configRuntime.prompt({
      taskId: "task-1", agentId: "devin", text: "config run",
      userMessageId: "u-10", assistantMessageId: "a-10",
    });
    await waitFor(
      () => configRuntime.history("task-1").runs.find((run) => run.runId === cfgRun.runId && run.status === "completed"),
      "config run completion",
    );
    const cfgMessage = configRuntime.history("task-1").messages.find((message) => message.id === "a-10")!;
    assert.match(cfgMessage.text, /model=mock\/model-b/, "set_config_option reached the agent before prompt");
    assert.match(cfgMessage.text, /fast=true/, "boolean session option applied before prompt");
  } finally {
    configRuntime.dispose();
  }

  runtime.dispose();
  console.log("ACP runtime integration: PASS (initialize/new/prompt, permission, resume, load, fallback_new, auth retry, cancel, crash, testAgent, disabled, session config options)");
} finally {
  db.close();
  // Windows 上被中止的 ACP 子进程可能还持有 workspace 里的句柄，立刻 rmSync 会 EBUSY
  // （CI 上就这么红过）。rmSync 的 maxRetries 只对 EBUSY/EPERM 生效，是官方给的退避口。
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
