import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { getAgentBashShellPath } from "../src/main/agent-shell-settings";
import { readNativeExecutionReceipt, type NativeExecutionReceipt } from "../src/shared/native-execution-receipt";
import type { PstackCheckIdentity } from "../src/shared/conversation-goal-activity";

const root = await mkdtemp(join(tmpdir(), "verification-comparison-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
await mkdir(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");

type Scenario = { name: string; commands: string[]; errors: boolean[]; consultToolDescription?: boolean; continueAfterError?: boolean; stopOnBlockedGuidance?: boolean };
type ComparisonResult = { engine: string; scenario: string; status: string; calls: number; observedResults: number; toolErrors: number };
const failedCheck = "(printf '%s\\n' 'FAIL header/1440: title truncated'; exit 23)";
const filteredChecks = [10, 20, 40].map(n => `${failedCheck} 2>&1 | tail -n ${n}`);
const usefulChecks: Scenario = { name: "useful-multiple-steps", commands: Array.from({ length: 6 }, (_, n) => `printf '%s\\n' 'PASS condition ${n + 1}'`), errors: Array(6).fill(false) };
const quotePath = (file: string) => "'" + file.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
const checkDesktop = `${quotePath(process.execPath)} ${quotePath(resolve("scripts/desktop-verification-case-fixture.cjs"))}`;
const desktopAcceptance: Scenario = {
  name: "desktop-assertion-and-rechecks", continueAfterError: true,
  commands: [
    `printf 'broken\\n' > fixture-layout.txt; set -o pipefail; ${checkDesktop} title 2>&1 | tail -n 10`,
    `set -o pipefail; ${checkDesktop} title 2>&1 | tail -n 20`,
    `printf 'new logs\\n' > diagnostic-output.txt; set -o pipefail; ${checkDesktop} title 2>&1 | tail -n 40`,
    `${checkDesktop} other`,
    `${checkDesktop} title --fresh`,
    `${checkDesktop} title --fresh --layout-stable`,
    `${checkDesktop} title`,
    `printf 'fixed\\n' > fixture-layout.txt; ${checkDesktop} title`,
    `${checkDesktop} cleanup`,
    `${checkDesktop} cleanup`,
  ],
  errors: [true, true, true, false, true, false, true, false, true, true],
};
const reportGuidance: Scenario = {
  name: "desktop-blocked-report-guidance", commands: desktopAcceptance.commands.slice(0, 3), errors: [true, true, true],
  continueAfterError: true, stopOnBlockedGuidance: true,
};
const scenarios: Scenario[] = [
  { name: "success", commands: ["printf '%s\\n' 'PASS header/1440'"], errors: [false] },
  { name: "direct-failure", commands: [failedCheck], errors: [true] },
  { name: "filtered-failure", commands: filteredChecks, errors: [false, false, false] },
  { name: "filtered-failure-with-pipefail", commands: [`set -o pipefail; ${failedCheck} 2>&1 | tail -n 40`], errors: [true] },
  { name: "filtered-failure-with-status-print", commands: [`set -o pipefail; ${failedCheck} 2>&1 | tail -n 40; echo "status=$?"`], errors: [false] },
  { name: "filtered-failure-with-preserved-status-print", commands: [`set -o pipefail; ${failedCheck} 2>&1 | tail -n 40; status=$?; echo "status=$status"; exit "$status"`], errors: [true] },
  { name: "filtered-failure-with-tool-guidance", commands: filteredChecks, errors: [false, false, false], consultToolDescription: true },
  { name: "timeout", commands: ["sleep 10"], errors: [true] },
  usefulChecks,
  desktopAcceptance,
  reportGuidance,
];

function createCheck(scenario: Scenario) {
  const observed: Array<{ error: boolean; text: string; receipt?: NativeExecutionReceipt }> = [];
  let calls = 0;
  function respond(input: TranscriptContext): AssistantMessage["content"] {
    const bash = getCurrentTools(input.messages).find(tool => tool.name === "bash");
    if (!bash) return [{ type: "text", text: '{"candidates":[]}' }];
    const last = input.messages.findLast(message => message.role === "toolResult");
    if (last?.role === "toolResult") {
      const text = last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      observed.push({ error: last.isError, text, receipt: readNativeExecutionReceipt(last.details) });
      if (scenario.stopOnBlockedGuidance && bash.description.includes("blocked_same_failure") && text.includes('"outcome":"blocked_same_failure"'))
        return [{ type: "text", text: "This verification is blocked. Use the existing failure report." }];
    }
    const command = scenario.commands[calls];
    if (!command || !scenario.continueAfterError && last?.role === "toolResult" && last.isError)
      return [{ type: "text", text: "Verification fixture finished." }];
    calls++;
    const usePipefail = scenario.consultToolDescription && bash.description.includes("set -o pipefail");
    return [{ type: "toolCall", name: "bash", id: `verification-${calls}`, arguments: {
      command: usePipefail ? `set -o pipefail; ${command}` : command, timeout: scenario.name === "timeout" ? 1 : 10,
    } }];
  }
  return { observed, respond, get calls() { return calls; } };
}

async function createModels(cwd: string, respond: ReturnType<typeof createCheck>["respond"]) {
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
    modelsStorePath: join(cwd, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "isolated-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, input) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = respond(input);
        const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, provider: model.provider, model: model.id, api: model.api,
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  await models.refresh({ allowNetwork: false });
  return models;
}

type Respond = ReturnType<typeof createCheck>["respond"];
async function runPi(cwd: string, respond: Respond): Promise<string> {
  const modelRuntime = await createModels(cwd, respond);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel("fixture", "model"),
    tools: ["bash"], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  try {
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("Run the verification fixture.");
    assert(session.isIdle);
    const answer = session.messages.at(-1);
    assert(answer?.role === "assistant" && answer.stopReason === "stop");
    return "done";
  } finally { session.dispose(); }
}

async function runDurable(cwd: string, respond: Respond, maxTurns?: number): Promise<string> {
  const models = await createModels(cwd, respond);
  const registry = createRegistry();
  registry.install(CodingTools);
  const shellPath = getAgentBashShellPath(cwd, process.env.PI_CODING_AGENT_DIR!);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd, shellPath }) }, ctx);
  try {
    const conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "model" }, maxTurns } });
    const receipt = await conversation.submit({ type: "input", content: "Run the verification fixture.", requestId: "verification" }, ctx);
    const settled = await receipt.wait(ctx);
    return settled.status === "done" ? "done" : settled.reason;
  } finally { await harness.close(ctx); }
}

const db = new AppDatabase(join(root, "app.db"));
let currentCheck: Respond;
const fixture = await createAgentDurableFixture(root, db, input => currentCheck(input));
await fixture.agent.updateAppSettings({ memoryEnabled: false });
async function runMyBuddy(cwd: string, respond: Respond): Promise<string> {
  currentCheck = respond;
  const space = db.upsertSpace({ id: `space-${basename(cwd)}`, name: basename(cwd), path: cwd });
  const taskId = `verify-${basename(cwd)}`;
  db.upsertTask({ id: taskId, title: "Verification fixture", spaceId: space.id, cwd, permissionMode: "auto", welcomeMode: "working", updatedAt: Date.now() });
  const settled = await fixture.prompt({ taskId, text: "Run the verification fixture.", userMessageId: "verification", assistantMessageId: "verification-reply" });
  return settled.receipt!.status;
}

async function verifyHostedCheckReceipt() {
  const taskId = "pstack-hosted-desktop-check";
  const cwd = join(root, taskId), reports = join(root, "hosted-desktop-report");
  await mkdir(cwd); await mkdir(reports);
  await writeFile(join(reports, "fixture-layout.txt"), "fixed\n");
  await writeFile(join(cwd, "desktop-check.cjs"), `process.chdir(${JSON.stringify(reports)}); process.argv[2] = 'title'; require(${JSON.stringify(resolve("scripts/desktop-verification-case-fixture.cjs"))});\n`);
  const agent = fixture.agent;
  await agent.updateAppSettings({ conversationGoalContinuationEnabled: false });
  agent.saveModePolicy("coding", { ...agent.getModeProfile("coding").policy, pstackThermosEnabled: true });
  const space = db.upsertSpace({ id: taskId, name: "Hosted desktop check", path: cwd });
  db.upsertTask({ id: taskId, title: "Compare one checked version", spaceId: space.id, cwd, welcomeMode: "coding", updatedAt: Date.now() });
  const goal = agent.getConversationGoals().create({ taskId, title: "Verify the title case", criteria: [{ text: "Check title width" }] });
  assert(goal.ok);

  const actions: Record<string, string>[] = [{ action: "start", skill: "principle-prove-it-works" },
    { action: "verify", shell: "bash", command: "node desktop-check.cjs" },
    { action: "block", note: "Await next input after collecting the check evidence." }];
  let action = 0;
  let resultText: string | undefined;
  currentCheck = input => {
    const previous = input.messages.findLast(message => message.role === "toolResult");
    if (previous?.role === "toolResult" && previous.toolCallId === "hosted-check-2") {
      const body = previous.content.find(part => part.type === "text");
      if (body?.type === "text") resultText = body.text;
    }
    const next = actions[action++];
    return next ? [{ type: "toolCall", name: "pstack_workflow", id: `hosted-check-${action}`, arguments: next }]
      : [{ type: "text", text: "Stored the desktop check." }];
  };
  await fixture.prompt({ taskId, text: "Verify the desktop title using the check script.", welcomeMode: "coding",
    userMessageId: "hosted-check", assistantMessageId: "hosted-check-reply" });
  assert(resultText, "the normal MyBuddy tool path must return the check receipt");
  const result = JSON.parse(resultText) as { outcome: string; checkIdentity: PstackCheckIdentity };
  assert.equal(result.outcome, "passed", resultText);
  const { checkIdentity } = result;
  const report = checkIdentity.desktopReport;
  assert(report && checkIdentity.attemptId, "the canonical check must bind the host attempt and finalized desktop report");
  assert.deepEqual(report.caseIds, ["title"]);
  assert.equal(report.reportSha256, createHash("sha256").update(await readFile(report.reportPath)).digest("hex"));
  const row = db.connection.prepare("SELECT record_json FROM execution_attempts WHERE id=?").get(checkIdentity.attemptId) as { record_json: string } | undefined;
  assert(row);
  const tool = JSON.parse(row.record_json).nativeReceipt as NativeExecutionReceipt;
  assert.equal(tool.executionId, checkIdentity.executionId);
  assert.equal(tool.toolTaskId, checkIdentity.toolTaskId);
  assert.equal(tool.status, "passed");
  const panel = await agent.getConversationGoalEvidence(taskId, goal.goal.id);
  const check = panel?.activity?.nativeEvidence?.find(item => item.kind === "check");
  assert(check?.kind === "check");
  assert.equal(check.outcome, result.outcome);
  assert.deepEqual(check.checkIdentity, checkIdentity);
}

try {
  const matrix: ComparisonResult[] = [];
  const desktopResults: Record<string, unknown[]> = {};
  let failedShellReceipt: NativeExecutionReceipt | undefined;
  for (const [engine, run] of [["pi", runPi], ["pi-durable", runDurable], ["mybuddy", runMyBuddy]] as const) {
    for (const scenario of scenarios) {
      const cwd = join(root, `${engine}-${scenario.name}`);
      await mkdir(cwd);
      const check = createCheck(scenario);
      const status = await run(cwd, check.respond);
      assert.equal(status, "done", `${engine}/${scenario.name}`);
      let expectedErrors = scenario.errors;
      if (engine === "mybuddy" && scenario.consultToolDescription) expectedErrors = [true];
      if (engine === "mybuddy" && scenario.stopOnBlockedGuidance) expectedErrors = [true, true];
      assert.deepEqual(check.observed.map(result => result.error), expectedErrors, `${engine}/${scenario.name} ${JSON.stringify(check.observed)}`);
      if (engine === "mybuddy" && scenario.name === "direct-failure") failedShellReceipt = check.observed[0]?.receipt;
      if (scenario.name.includes("failure")) assert(check.observed.every(result => result.text.includes("FAIL header/1440: title truncated")));
      if (scenario === desktopAcceptance || scenario === reportGuidance) {
        const results = check.observed.map(({ text }) => {
          const line = text.split("\n").find(line => line.startsWith("VERIFICATION_RESULT "));
          assert(line, `${engine}: missing verification evidence in ${text}`);
          return JSON.parse(line.slice("VERIFICATION_RESULT ".length));
        });
        const expected = [
          ["assertion_failed", 1, "failed", "passed"],
          ["blocked_same_failure", 1, "failed", "passed"],
          ["blocked_same_failure", 1, "failed", "passed"],
          ["passed", 2, "passed", "passed"],
          ["assertion_failed", 3, "failed", "passed"],
          ["passed", 4, "passed", "passed"],
          ["assertion_failed", 5, "failed", "passed"],
          ["passed", 6, "passed", "passed"],
          ["infrastructure_failed", 7, "passed", "failed"],
          ["infrastructure_failed", 8, "passed", "failed"],
        ];
        assert.deepEqual(results.map(result => [result.outcome, result.launches, result.verificationStatus, result.cleanupStatus]),
          expected.slice(0, expectedErrors.length), `${engine}/${scenario.name}`);
        for (const result of results.slice(1, 3)) {
          assert.equal(result.reportPath, results[0].reportPath);
          assert.equal(result.reportSha256, results[0].reportSha256);
          assert.equal(result.inputFingerprint, results[0].inputFingerprint);
          assert.deepEqual(result.assertionFailure, { caseId: "title", assertion: "title-width", expected: "fixed", observed: "broken" });
        }
        for (const result of results) {
          assert.equal(result.reportSha256, createHash("sha256").update(await readFile(result.reportPath)).digest("hex"));
          assert.match(result.inputFingerprint, /^[a-f0-9]{64}$/);
          assert.deepEqual(result.caseIds, [result.caseId]);
        }
        desktopResults[`${engine}/${scenario.name}`] = results;
      }
      matrix.push({ engine, scenario: scenario.name, status, calls: check.calls, observedResults: check.observed.length,
        toolErrors: check.observed.filter(result => result.error).length });
    }
  }
  const capped = createCheck(usefulChecks);
  assert.equal(await runDurable(root, capped.respond, 2), "turn_limit");
  assert.equal(capped.calls, 2);
  assert.deepEqual(capped.observed.map(result => result.text.trim()), ["PASS condition 1"], "the second successful tool batch hits the cap before the model sees it");
  matrix.push({ engine: "pi-durable", scenario: "useful-multiple-steps-with-maxTurns-2", status: "turn_limit", calls: capped.calls,
    observedResults: capped.observed.length, toolErrors: 0 });
  assert(failedShellReceipt?.attemptId, "a real failed shell command carries the host receipt and its attempt identity");
  assert.equal(failedShellReceipt.status, "failed");
  assert.equal(failedShellReceipt.exitCode, 23);
  assert.equal(failedShellReceipt.transport, "returned");
  const exactAttempt = db.connection.prepare("SELECT status,record_json FROM execution_attempts WHERE id=?")
    .get(failedShellReceipt.attemptId) as { status: string; record_json: string } | undefined;
  assert(exactAttempt);
  assert.equal(exactAttempt.status, failedShellReceipt.status);
  assert.deepEqual(JSON.parse(exactAttempt.record_json).nativeReceipt, failedShellReceipt);
  const history = await fixture.agent.loadTaskHistory(failedShellReceipt.taskId, undefined, "stored");
  const historicalTool = history.messages.flatMap(message => message.tools ?? []).find(tool => tool.id === failedShellReceipt!.callId);
  assert.equal(historicalTool?.status, "error");
  assert.deepEqual(readNativeExecutionReceipt(JSON.parse(historicalTool!.detail!)), failedShellReceipt);
  await verifyHostedCheckReceipt();
  console.table(matrix);
  console.log("PASS the same real shell tests distinguish masked assertions, preserved failures, useful progress, timeout, and a native cap truncating useful work");
  console.log("PASS MyBuddy publishes the same real shell attempt and desktop report version in the Pstack check and Goal evidence");
  await writeFile("out/tests/verification-workflow-comparison.json", JSON.stringify(matrix, null, 2) + "\n");
  await writeFile("out/tests/desktop-verification-comparison.json", JSON.stringify(desktopResults, null, 2) + "\n");
} finally {
  await fixture.close();
  db.close();
}
