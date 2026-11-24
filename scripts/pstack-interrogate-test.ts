import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { platformShellLanguageIds } from "../src/main/platform/shell-tools";
import { prepareSubagentWorkspace } from "../src/main/capabilities/subagent/worktree";
import { normalizePstackSettings } from "../src/shared/pstack";
import { prepareInterrogateDispatch, preparePstackDispatch, pstackSubagentOptions } from "../src/main/agent/PstackDispatch";
import { assertInterrogateWorkspace, collectInterrogateEvidence, interrogateFindings,
  INTERROGATE_ADVERSARY_ROLE, observedInterrogateProbes, type InterrogateChild } from "../src/main/agent/pstack/PstackInterrogateEvidence";
import { allInterrogateJudgments, interrogateFinding, interrogateJudgment, interrogateRerunCommand, rerunInterrogateFinding,
  type InterrogateRerun } from "../src/main/agent/pstack/PstackInterrogateRerun";
import { baselineWorkspace, measureWorkspace } from "../src/main/agent/pstack/PstackWorkspace";
import type { Api, WorkflowRun } from "../src/main/agent/pstack/PstackState";

const settings = normalizePstackSettings();
settings.roles["interrogate-reviewers"] = { ...settings.roles["interrogate-reviewers"], count: 1, model: "default", isolation: "shared" };
const isolated = prepareInterrogateDispatch(settings, ["Probe the sum behavior."], "/project");
assert.equal(isolated.agent, INTERROGATE_ADVERSARY_ROLE);
assert.equal(isolated.isolation, "worktree", "Interrogate cannot silently downgrade a shared preference to shared review.");
assert.equal(preparePstackDispatch(settings, "interrogate-reviewers", ["Thermos source review"], "/project").isolation, "shared");
const roles = pstackSubagentOptions("fixture", settings).builtinRoles;
assert.equal(roles.find(role => role.name === "pstack-interrogate-reviewers")?.readOnly, true, "Thermos keeps read-only authority.");
assert.equal(roles.find(role => role.name === INTERROGATE_ADVERSARY_ROLE)?.executionReview, true);

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), "mybuddy-interrogate-"));
const sourceCwd = join(root, "source"), taskId = "interrogate-fixture";
const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions",
  baseUrl: "http://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const shell = platformShellLanguageIds().includes("powershell") ? "powershell" : "bash";
const command = shell === "powershell" ? "node repro.cjs; exit $LASTEXITCODE" : "node repro.cjs";
const claim = { toolCallId: "actual-probe", shell, command };
const verdict = { coverage: "Executed an assertion for positive integer addition; negative values remain untested.",
  probes: [claim], findings: [{ ...claim, title: "Addition subtracts its second argument", expected: "add(2, 3) returns 5",
    actual: "ADD_REGRESSION", exitCode: 1 }] };
const calls: { id: string; name: string; arguments: Record<string, string> }[] = [{ id: claim.toolCallId, name: shell, arguments: { command } }];
const models = { getModel: () => model, getAuth: async () => undefined, streamSimple() {
  const stream = createAssistantMessageEventStream(), call = calls.shift();
  const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
    timestamp: Date.now(), stopReason: call ? "toolUse" : "stop",
    content: call ? [{ type: "toolCall", ...call }]
      : [{ type: "text", text: JSON.stringify(verdict) }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
  return stream;
} } as unknown as DurableBotOptions["models"];
let runtime: DurableBotRuntime | undefined, db: AppDatabase | undefined;
try {
  await mkdir(sourceCwd);
  const git = (...args: string[]) => exec("git", ["-C", sourceCwd, ...args], { windowsHide: true });
  await git("init", "-q", "-b", "main");
  await writeFile(join(sourceCwd, "target.cjs"), "exports.add = (a, b) => a - b;\n");
  await writeFile(join(sourceCwd, ".gitignore"), "cache/\n");
  await git("add", ".");
  await git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture");
  const workspace = await prepareSubagentWorkspace({ cwd: sourceCwd, isolation: "worktree", parallel: false, writable: true,
    baseDir: join(root, "worktrees"), operationId: "reviewer-fixture" });
  assert.equal(workspace.kind, "worktree");
  const reproduction = "if (!require('node:fs').existsSync('cache/transient-resolved')) require('node:assert/strict').equal(require('./target.cjs').add(2, 3), 5, 'ADD_REGRESSION');\n";
  await writeFile(join(workspace.cwd, "repro.cjs"), reproduction);
  db = new AppDatabase(join(root, "app.db"));
  db.upsertTask({ id: taskId, title: "Interrogate native evidence", updatedAt: Date.now() });
  const policy = createDurableToolPolicy({ taskId, taskRoot: workspace.cwd, getPermissionMode: () => "auto",
    attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
    interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
    getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: workspace.cwd }) });
  runtime = await DurableBotRuntime.open({ taskId, directory: join(root, "store"), cwd: workspace.cwd, models,
    model: { provider: model.provider, modelId: model.id }, toolMode: "native", instructions: () => "Execute the one reproduction and report its native call.",
    tools: [], toolHooks: policy.hooks, onSnapshot: () => {} });
  assert.equal((await (await runtime.submit("Review addition", "native-review")).wait(ctx)).status, "done");
  const entries = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime!.conversation.id, order: "ascending" }, 200), ctx);
  const child: InterrogateChild = { subagentId: "actual-reviewer", nativeConversationId: Number(runtime.conversation.id), workspace,
    messages: entries.items.flatMap(entry => entry.model ?? []).filter(message => message.role !== "user") as InterrogateChild["messages"] };
  const probes = observedInterrogateProbes(child, taskId);
  assert.equal(probes.length, 1, JSON.stringify(child.messages));
  assert.equal(probes[0].exitCode, 1);
  assert.match(probes[0].output, /ADD_REGRESSION/);
  assert.match(probes[0].executionId, /./);
  const receipt = await collectInterrogateEvidence([child], sourceCwd, taskId);
  const [finding] = interrogateFindings(receipt);
  assert.equal(finding.probe.command, command);
  assert.equal(finding.expected, verdict.findings[0].expected);
  assert.equal(finding.probe.toolTaskId, probes[0].toolTaskId);
  assert.equal((await collectInterrogateEvidence([child], sourceCwd, taskId)).reviewers[0].findings[0].id, finding.id);
  assert.equal(await assertInterrogateWorkspace(finding.workspace), finding.workspace.fingerprint);
  assert.equal(await readFile(join(sourceCwd, "target.cjs"), "utf8"), "exports.add = (a, b) => a - b;\n");

  const altered = () => structuredClone(child);
  const resultOf = (record: InterrogateChild) => record.messages.find(message => message.role === "toolResult" && message.toolCallId === claim.toolCallId)!;
  const answerOf = (record: InterrogateChild, value: unknown) => {
    record.messages.at(-1)!.content = [{ type: "text", text: JSON.stringify(value) }]; return record;
  };
  const fake = altered(); delete resultOf(fake).details;
  assert.equal(observedInterrogateProbes(fake, taskId).length, 0, "A fabricated tool output without a native receipt is not execution.");
  await assert.rejects(collectInterrogateEvidence([fake], sourceCwd, taskId), /no matching settled native execution/);
  const wrongConversation = altered(); wrongConversation.nativeConversationId++;
  assert.equal(observedInterrogateProbes(wrongConversation, taskId).length, 0);
  assert.equal(observedInterrogateProbes(child, "another-task").length, 0);
  const interrupted = altered();
  (resultOf(interrupted).details as { executionReceipt: { settlement: string } }).executionReceipt.settlement = "unknown";
  assert.equal(observedInterrogateProbes(interrupted, taskId).length, 0);
  const contradicted = altered(); resultOf(contradicted).isError = false;
  assert.equal(observedInterrogateProbes(contradicted, taskId).length, 0);
  const unexecuted = answerOf(altered(), { ...verdict, probes: [{ ...claim, command: "node different.cjs" }] });
  await assert.rejects(collectInterrogateEvidence([unexecuted], sourceCwd, taskId), /no matching settled native execution/);
  const fictional = answerOf(altered(), { ...verdict, findings: [{ ...verdict.findings[0], actual: "Invented output absent from the command" }] });
  await assert.rejects(collectInterrogateEvidence([fictional], sourceCwd, taskId), /does not match a real failing probe/);
  const noProbe = answerOf(altered(), { coverage: "Everything looks fine", probes: [], findings: [] });
  await assert.rejects(collectInterrogateEvidence([noProbe], sourceCwd, taskId), /actual native probes/);
  const noFindings = answerOf(altered(), { ...verdict, findings: [] });
  assert.deepEqual(interrogateFindings(await collectInterrogateEvidence([noFindings], sourceCwd, taskId)), [], "Executed coverage can honestly return no confirmed defects.");
  const shared = altered(); shared.workspace = { kind: "shared", cwd: sourceCwd };
  await assert.rejects(collectInterrogateEvidence([shared], sourceCwd, taskId), /real isolated worktree/);

  // A separate root conversation starts in the source directory. Its native
  // shell must execute the original child command in the authenticated cwd.
  await runtime.close(); runtime = undefined;
  const base = await baselineWorkspace(sourceCwd), delta = await measureWorkspace(base, settings.thermos.fileLines);
  const run = { task: taskId, run: 42, playbook: "skill:interrogate", stage: 3, config: JSON.stringify(settings),
    delegates: [{ role: "interrogate-reviewers", stage: 2, stageId: "panel", toolTaskId: 41,
      children: [child.subagentId], models: ["fixture/fixture"], answers: [JSON.stringify(verdict)], interrogate: receipt }],
    interrogateReruns: [] } as unknown as WorkflowRun;
  assert.throws(() => interrogateFinding(run, "judge", "invented-finding"), /actual interrogate panel receipt/);
  await assert.rejects(interrogateJudgment(run, "judge", delta.fingerprint), /Rerun every candidate/);
  assert.match(interrogateRerunCommand(finding), /repro\.cjs/);
  const quoted = structuredClone(finding); quoted.workspace.cwd = "/tmp/a'b;touch should-not-run";
  assert.match(interrogateRerunCommand(quoted), shell === "bash" ? /a'\\''b/ : /a''b/);
  const reruns: InterrogateRerun[] = [];
  let readOnlyWork = false, videoInspections = 0;
  const readonlyAdmissions: Array<{ operationId: string; actionKind: string }> = [];
  const videoInspection = defineTool({ name: "pstack_video_inspect", description: "Fixture for the real video tool's Work admission boundary", replay: "safe",
    parameters: Type.Object({ artifact: Type.String() }), async execute() {
      videoInspections++;
      return { output: [{ type: "text", text: "Video inspection implementation ran." }] };
    } });
  const rerunTool = defineTool({ name: "fixture_interrogate_rerun", description: "Run the actual host finding verification", replay: "safe",
    parameters: Type.Object({ mode: Type.String() }), async execute({ mode }, api, context) {
      const observed = Object.create(api) as Api;
      Object.defineProperty(observed, "executeTool", { value: async (...args: Parameters<Api["executeTool"]>) => {
        const result = await api.executeTool(...args);
        if (mode === "missing-receipt") return { ...result, details: {} };
        if (mode === "contradicted") {
          const details = structuredClone(result.details) as { executionReceipt: { status: string } };
          details.executionReceipt.status = "passed";
          return { ...result, details };
        }
        return result;
      } });
      const rerun = await rerunInterrogateFinding({ options: { taskId, cwd: sourceCwd, active: () => true, settings: () => settings },
        run, stageId: mode === "direct-stage" ? "verify" : "synthesize", finding: finding.id, base, delta, api: observed, ctx: context });
      reruns.push(rerun);
      return { output: [{ type: "text", text: JSON.stringify(rerun) }] };
    } });
  const parentPolicy = createDurableToolPolicy({ taskId, taskRoot: sourceCwd, getPermissionMode: () => "auto",
    attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
    interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
    admitWorkAction: input => {
      if (!readOnlyWork) return;
      readonlyAdmissions.push(input);
      return input.actionKind === "workspace:write" ? "The fixture Work authorizes reads only." : undefined;
    },
    getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: sourceCwd }) });
  runtime = await DurableBotRuntime.open({ taskId, directory: join(root, "parent-store"), cwd: sourceCwd, models,
    model: { provider: model.provider, modelId: model.id }, toolMode: "native", instructions: () => "Independently verify the recorded finding.",
    tools: [rerunTool, videoInspection], toolHooks: parentPolicy.hooks, onSnapshot: () => {} });
  const rerun = async (mode: string) => {
    const before = reruns.length;
    calls.push({ name: rerunTool.name, id: "rerun-" + before, arguments: { mode } });
    assert.equal((await (await runtime!.submit("Rerun the finding", "parent-" + before)).wait(ctx)).status, "done");
    assert.equal(reruns.length, before + 1);
    return reruns.at(-1)!;
  };
  const confirmed = await rerun("native");
  assert.equal(confirmed.verdict, "reproduced", JSON.stringify(confirmed));
  assert.equal(confirmed.receipt.outcome, "command_failed");
  assert.equal(confirmed.receipt.command, command);
  assert.match(confirmed.receipt.checkIdentity.executionId ?? "", /./);
  run.interrogateReruns = [confirmed];
  assert.equal((await interrogateJudgment(run, "judge", delta.fingerprint)).confirmed[0].id, finding.id);
  run.delegates.push({ ...run.delegates[0], stageId: "verify" });
  await assert.rejects(allInterrogateJudgments(run, delta.fingerprint), /Rerun every candidate/);
  const direct = await rerun("direct-stage");
  assert.equal(direct.stageId, "verify");
  assert.equal(direct.verdict, "reproduced");
  run.interrogateReruns.push(direct);
  assert.deepEqual((await allInterrogateJudgments(run, delta.fingerprint)).map(item => item.stageId), ["panel", "verify"]);
  const nested: WorkflowRun = { ...run, playbook: "feature", invoked: [{ stage: "check", skill: "interrogate" }],
    delegates: [{ ...run.delegates[0], stageId: "check::interrogate::panel" }],
    interrogateReruns: [{ ...confirmed, stageId: "check::interrogate::panel" }] };
  assert.equal((await interrogateJudgment(nested, "check::interrogate::judge", delta.fingerprint)).confirmed.length, 1);
  const old: WorkflowRun = { ...nested, delegates: [{ ...nested.delegates[0], interrogate: undefined }] };
  await assert.rejects(allInterrogateJudgments(old, delta.fingerprint), /real native execution receipts/);
  await assert.rejects(interrogateJudgment(run, "judge", "changed-source-fingerprint"), /current source/);
  assert.equal((await rerun("missing-receipt")).verdict, "inconclusive", "A host result without its native execution receipt cannot confirm a defect.");
  assert.equal((await rerun("contradicted")).verdict, "inconclusive", "Contradictory native status cannot override the process failure.");
  await mkdir(join(workspace.cwd, "cache"));
  await writeFile(join(workspace.cwd, "cache", "transient-resolved"), "The transient condition is no longer present.");
  const noLongerFailing = await rerun("native");
  assert.equal(noLongerFailing.verdict, "not-reproduced");
  run.interrogateReruns = [confirmed, noLongerFailing];
  const judged = await interrogateJudgment(run, "judge", delta.fingerprint);
  assert.equal(judged.confirmed.length, 0);
  assert.equal(judged.excluded[0].verdict, "not-reproduced");
  await rm(join(workspace.cwd, "cache", "transient-resolved"));

  readOnlyWork = true;
  const sourceBeforeReadOnly = await readFile(join(sourceCwd, "target.cjs"), "utf8");
  calls.push({ name: "pstack_video_inspect", id: "readonly-video", arguments: { artifact: "unused-manifest.json" } },
    { name: "write", id: "readonly-source-write", arguments: { path: "target.cjs", content: "unauthorized source change" } },
    { name: "read", id: "readonly-source-read", arguments: { path: "target.cjs" } });
  assert.equal((await (await runtime.submit("Read-only Work permission fixture", "readonly-work")).wait(ctx)).status, "done");
  assert.equal(videoInspections, 0, "The video implementation must not run before Work grants workspace write authority.");
  for (const [callId, expected] of [["readonly-video", "workspace:write"], ["readonly-source-write", "workspace:write"], ["readonly-source-read", "workspace:read"]])
    assert.equal(readonlyAdmissions.find(item => item.operationId.endsWith(":" + callId))?.actionKind, expected);
  const readonlyEntries = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime!.conversation.id, order: "ascending" }, 200), ctx);
  const readonlyResults = readonlyEntries.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult" &&
    ["readonly-video", "readonly-source-write", "readonly-source-read"].includes(message.toolCallId));
  assert.deepEqual(readonlyResults.map(message => message.role === "toolResult" && [message.toolCallId, message.isError]),
    [["readonly-video", true], ["readonly-source-write", true], ["readonly-source-read", false]]);
  assert.equal(await readFile(join(sourceCwd, "target.cjs"), "utf8"), sourceBeforeReadOnly, "Existing native source permissions remain enforced.");
  readOnlyWork = false;
  console.log("PASS read-only Work classifies video inspection as workspace:write, blocks it before execution, rejects native source writes and retains native reads.");

  await writeFile(join(workspace.cwd, "target.cjs"), "exports.add = (a, b) => a + b;\n");
  await assert.rejects(assertInterrogateWorkspace(finding.workspace), /must not modify/);
  await writeFile(join(workspace.cwd, "target.cjs"), "exports.add = (a, b) => a - b;\n");
  await writeFile(join(workspace.cwd, "repro.cjs"), "throw Error('fake failure');\n");
  await assert.rejects(assertInterrogateWorkspace(finding.workspace), /reproduction files changed/);
  await writeFile(join(workspace.cwd, "repro.cjs"), reproduction);
  await writeFile(join(workspace.cwd, "cache", "transient.log"), "a test-generated ignored cache file");
  assert.equal(await assertInterrogateWorkspace(finding.workspace), finding.workspace.fingerprint, "Ignored generated caches do not invalidate a retained reproduction.");
  await writeFile(join(sourceCwd, "target.cjs"), "exports.add = () => 0;\n");
  await assert.rejects(assertInterrogateWorkspace(finding.workspace), /source must remain at the clean dispatched commit/);
  console.log("PASS Interrogate validates real child and host native probes, rejects forged or stale evidence, excludes a non-reproduced failure, and preserves source/worktree identity.");
} finally {
  await runtime?.close(); db?.close(); await rm(root, { recursive: true, force: true });
}
