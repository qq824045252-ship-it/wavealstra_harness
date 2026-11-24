import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, GenerationTask, type TaskId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { readGoalNativeEvidence } from "../src/main/agent/durable/DurableGoalNativeEvidence";
import { readGoalObservations } from "../src/main/agent/durable/DurableGoalCompletion";
import { withDurableExecution } from "../src/main/agent/durable/DurableExecutionContext";
import { normalizePstackSettings, THERMOS_CRITERIA } from "../src/shared/pstack";
import { pstackSubagentOptions } from "../src/main/agent/PstackDispatch";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { createPstackWorkflow, isPstackCheck } from "../src/main/agent/pstack/PstackWorkflow";
import { isPstackObservation } from "../src/main/agent/pstack/PstackObservationCommand";
import { WorkflowFiles, WorkflowState } from "../src/main/agent/pstack/PstackState";
import { formatPstackBlock, formatStoredPstackReply } from "../src/main/agent/pstack/PstackBlockReport";

const rawBlock = String.raw`目录 C:\new\repo。\n已完成：验证通过。\n解除条件：\n1) 选择仓库。\n2) 再次验证。`;
const formattedBlock = formatPstackBlock(rawBlock);
assert.match(formattedBlock, /^## 工作流暂停\n/);
assert.ok(formattedBlock.includes("### 已完成\n\n验证通过。"));
assert.ok(formattedBlock.includes("1) 选择仓库。\n2) 再次验证。"));
assert.ok(formattedBlock.includes(String.raw`C:\new\repo`));
assert.equal(formatStoredPstackReply("pstack 工作流尚待继续。当前阻碍：" + rawBlock), formattedBlock);
assert.equal(formatStoredPstackReply(rawBlock), rawBlock);
const codeSample = ["```js", String.raw`const s = "。\n已完成：";`, "```"].join("\n");
assert.ok(formatPstackBlock(codeSample).includes(codeSample));
import { testInFlightOwners } from "./pstack-owner-monitor-fixture";
import { baselineWorkspace, branchReviewBase, measureWorkspace, missingFile, readPlanFile, reviewBaseline, reviewCommit, reviewScope, skillFileState } from "../src/main/agent/pstack/PstackWorkspace";
import { reviewIntent } from "../src/main/agent/pstack/PstackReviewIntent";
import { parseThermosVerdict } from "../src/main/agent/pstack/PstackDelegate";
import { observedReviewFiles, reviewTargets, validateInspections } from "../src/main/agent/pstack/PstackReviewEvidence";
import { currentVerificationEvidence, verificationOutcome } from "../src/main/agent/pstack/PstackVerificationEvidence";
import { createDurableProjectVerification, PROJECT_VERIFY_TOOL, readCurrentProjectVerification } from "../src/main/agent/durable/DurableProjectVerification";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), "mybuddy-pstack-"));
const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://fixture.invalid",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
type Call = { name: string; id?: string; arguments: Record<string, string | string[] | boolean | Record<string, string> | Record<string, string>[]> };
const work = (action: string, fields: Record<string, string | boolean | Record<string, string>[]> = {}): Call => ({ name: "pstack_workflow", arguments: { action, ...fields } });
const queue: Call[] = [];
let serial = 0, replies = 0, enabled = true;
const fetchedPaths: string[] = [];
const sourceServer = createServer((request, response) => {
  fetchedPaths.push(request.url ?? "");
  if (request.url === "/missing") { response.writeHead(404); response.end("Missing fixture source"); return; }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Verified fixture source for " + request.url + ": a term describing an observable system behavior.");
});
const models = { getModel: () => model, getAuth: async () => undefined, streamSimple() {
  const stream = createAssistantMessageEventStream(), call = queue.shift();
  const base: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(), content: [],
    stopReason: call ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  base.content = call ? [{ type: "toolCall", id: "fixture-" + (++serial), ...call }] : [{ type: "text", text: "Fixture yielded." }];
  if (!call) replies++;
  queueMicrotask(() => { stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: base }); stream.end(); });
  return stream;
} } as unknown as DurableBotOptions["models"];

async function testPotetoRouting() {
  const cwd = join(root, "routing");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.txt"), "Actual workspace evidence");
  const settings = normalizePstackSettings();
  settings.playbooks.feature.enabled = false;
  settings.skills.reframe.enabled = false;
  const host = createPstackWorkflow({ taskId: "routing", cwd, tag: { id: "minimal" }, settings: () => settings, active: () => true,
    githubAvailable: () => false });
  const runtime = await DurableBotRuntime.open({ directory: join(root, "routing-store"), cwd, models,
    model: { provider: model.provider, modelId: model.id }, toolMode: "native", instructions: () => "Fixture",
    tools: host.tools, foregroundHooks: host, onSnapshot: () => {} });
  let turn = 0;
  async function invoke(calls: Call[]) {
    queue.push(...calls);
    const done = await (await runtime.submit("Inspect routing without changing the objective", "route-" + (++turn))).wait(ctx);
    await runtime.conversation.waitForIdle(ctx);
    assert.equal(queue.length, 0);
    assert.equal(done.status, "done");
    const history = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
      minEntryId: done.entry, order: "ascending" }, 100), ctx);
    return history.items.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "toolResult" && message.toolName === "pstack_workflow"
      ? message.content.flatMap(part => {
        if (part.type !== "text") return [];
        try { return [JSON.parse(part.text)]; } catch { return [{ error: part.text }]; }
      }) : []);
  }
  const snapshot = () => runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx);
  try {
    const navigation = await invoke([work("status"), work("start"), work("start", { playbook: "auto" }), work("start", { skill: "poteto-mode" })]);
    assert.equal(navigation[0].phase, "idle");
    assert.equal(navigation[0].router.id, "poteto-mode");
    for (const result of navigation.slice(1)) {
      assert.equal(result.phase, "routing");
      assert.equal(result.started, false);
      assert.equal(result.router.id, "poteto-mode");
      assert.ok(result.router.instructions.length > 100);
      assert.ok(!result.playbooks.some((book: { id: string }) => book.id === "feature"));
      assert.ok(!result.skills.includes("reframe"));
    }
    assert.equal((await snapshot())?.run ?? null, null, "Routing guidance does not start a run");
    assert.equal((await runtime.harness.snapshot(WorkflowFiles, runtime.conversation.id, ctx))?.base ?? null, null,
      "Routing guidance does not freeze a workspace baseline");
    settings.skills["poteto-mode"].enabled = false;
    settings.skills["poteto-mode"].parameters.preferredPlaybook = "feature";
    settings.skills["poteto-mode"].parameters.githubBinding = "required";
    settings.playbooks.feature.enabled = true;
    const disabled = await invoke([work("status"), work("start"), work("start", { skill: "poteto-mode" })]);
    assert.equal(disabled[0].router, null);
    assert.equal(disabled[0].preferredPlaybook, "auto", "A disabled router cannot supply a saved default route");
    assert.ok(disabled.slice(1).every(result => /Poteto routing is disabled/.test(result.error)), JSON.stringify(disabled));
    assert.equal((await snapshot())?.run ?? null, null);
    const selected = "principle-prove-it-works";
    await invoke([work("start", { skill: selected }), { name: "read", arguments: { path: "source.txt" } },
      work("advance", { stage: "apply", note: "Read the source" }), work("complete")]);
    assert.equal((await snapshot())?.run?.phase, "complete", "Explicit routes do not inherit disabled poteto's GitHub requirement");
    settings.skills["poteto-mode"].enabled = true;
    settings.skills["poteto-mode"].parameters.githubBinding = "on-demand";
    await invoke([work("start", { skill: selected }), work("block", { note: "Fixture keeps this workflow available for navigation" })]);
    const frozen = (await snapshot())!.run!;
    const active = await invoke([work("start", { playbook: "auto" })]);
    assert.equal(active[0].phase, "routing");
    assert.equal(active[0].currentWorkflow.run, frozen.run);
    assert.deepEqual((await snapshot())!.run, frozen, "Requesting poteto guidance leaves an active workflow untouched");
    settings.skills["poteto-mode"].enabled = false;
    const persisted = await invoke([work("status")]);
    assert.equal(persisted[0].router.id, "poteto-mode", "An active workflow retains its frozen router setting");
    console.log("PASS poteto auto navigation, enabled route catalog, disabled defaults, explicit workflow, active-run preservation");
  } finally { await runtime.close(); }
}

async function testFrozenReadOnlyWorkflows() {
  const profile = join(root, "readonly-profile"), previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(profile);
  process.env.PI_CODING_AGENT_DIR = profile;
  const parentCalls: Call[] = [], children: Array<{ model: string; tools: string[]; readSucceeded: boolean }> = [];
  const native = await ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: null,
    modelsStorePath: join(profile, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  native.registerProvider("fixture", { api: model.api, apiKey: "isolated-fixture", baseUrl: model.baseUrl,
    models: ["fixture", "reviewer", "writer"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 1024, cost: model.cost })),
    streamSimple(active, input) {
      const stream = createAssistantMessageEventStream();
      const previous = input.messages.filter(message => message.role === "toolResult");
      let call: Call | undefined;
      if (active.id === "fixture") call = parentCalls.shift();
      else {
        children.push({ model: active.id, tools: getCurrentTools(input.messages).map(tool => tool.name),
          readSucceeded: previous.some(message => message.toolName === "read" && !message.isError &&
            message.content.some(part => part.type === "text" && part.text.includes("unresolved fixture defect"))) });
        if (!previous.length) call = active.id === "writer"
          ? { name: "write", arguments: { path: "writer.txt", content: "authorized child\n" } }
          : { name: "read", arguments: { path: "source.txt" } };
      }
      const answer = active.id === "reviewer" ? JSON.stringify({ verdict: "revise", findings: ["source.txt:1 documents an unresolved fixture defect."],
        checks: Object.fromEntries(THERMOS_CRITERIA.map(item => [item.id, "Read source.txt line 1 and retained the unresolved defect."])) }) : "Fixture settled.";
      const message: AssistantMessage = { role: "assistant", api: active.api, model: active.id, provider: active.provider, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", id: "readonly-" + (++serial), ...call }] : [{ type: "text", text: answer }],
        stopReason: call ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  await native.refresh({ allowNetwork: false });
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture",
    enabledModels: ["fixture/fixture", "fixture/reviewer", "fixture/writer"], retry: { enabled: false }, compaction: { enabled: false } }));
  try {
    for (const [tagId, route] of [["code-review", "skill:thermo-nuclear-code-quality-review"], ["plan-design", "skill:architect"],
      ["readonly-explain", "investigation"], ["minimal", "skill:thermo-nuclear-code-quality-review"]]) {
      const taskId = "readonly-" + tagId, cwd = join(root, taskId);
      await mkdir(cwd); await writeFile(join(cwd, "source.txt"), "unresolved fixture defect\n");
      const git = (...args: string[]) => exec("git", ["-C", cwd, ...args], { windowsHide: true });
      await git("init", "-q", "-b", "main"); await git("add", ".");
      await git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "review baseline");
      const settings = normalizePstackSettings();
      settings.roles["interrogate-reviewers"] = { ...settings.roles["interrogate-reviewers"], model: "fixture/reviewer", count: 1,
        isolation: tagId === "code-review" ? "worktree" : "shared" };
      const db = new AppDatabase(join(root, taskId + ".db"));
      db.upsertTask({ id: taskId, title: "Read-only continuation", updatedAt: Date.now() });
      const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => "auto",
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: cwd }) });
      const open = (selected: string) => {
        const host = createPstackWorkflow({ taskId, cwd, tag: { id: selected }, settings: () => settings, active: () => true });
        return DurableBotRuntime.open({ taskId, directory: join(root, taskId + "-store"), cwd, models: native,
          model: { provider: "fixture", modelId: "fixture" }, toolMode: "native", instructions: () => "Fixture",
          tools: [...host.tools, ...createDurableSubagentTools({ taskId, cwd, models: native, permissionMode: () => "auto",
            ...pstackSubagentOptions(taskId, settings) })], foregroundHooks: host, toolHooks: policy.hooks, onSnapshot: () => {} });
      };
      let runtime = await open(tagId), turn = 0;
      const invoke = async (calls: Call[]) => {
        parentCalls.push(...calls);
        const done = await (await runtime.submit("Inspect source.txt and preserve the reviewed code.", taskId + "-" + (++turn))).wait(ctx);
        await runtime.conversation.waitForIdle(ctx);
        assert.equal(parentCalls.length, 0);
        const history = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
          minEntryId: done.entry, order: "ascending" }, 200), ctx);
        const results = history.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
        assert.equal(done.status, "done", JSON.stringify({ done, errors: results.filter(message => message.isError)
          .map(message => ({ tool: message.toolName, content: message.content })) }));
        return results;
      };
      try {
        await invoke([work("start", { playbook: route }), work("block", { note: "Persist this review for the next user input." })]);
        await runtime.close(); runtime = await open("minimal");
        assert.equal((await runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx))!.run!.tagId, tagId);
        const worker = { agent: "pstack-feature", model: "fixture/writer", isolation: "shared", task: "Write writer.txt." };
        const reader = { agent: "pstack-how-explorer", model: "fixture/reviewer", isolation: "worktree", task: "Read source.txt and report its defect." };
        const attacks: Call[] = [
          { id: "blocked-write", name: "write", arguments: { path: "source.txt", content: "changed" } },
          { id: "blocked-edit", name: "edit", arguments: { path: "source.txt", oldText: "unresolved", newText: "fixed" } },
          { id: "blocked-shell", name: process.platform === "win32" ? "powershell" : "bash",
            arguments: { command: "node -e \"require('node:fs').writeFileSync('shell.txt','changed')\"" } },
          { id: "blocked-writer", name: "subagent", arguments: worker },
          { id: "blocked-batch", name: "subagent", arguments: { tasks: [reader, worker] } },
          { id: "blocked-chain", name: "subagent", arguments: { chain: [reader, worker] } },
          { id: "blocked-execution-review", name: "subagent", arguments: { ...worker, agent: "pstack-interrogate-adversary" } },
        ];
        const beforeChildren = children.length;
        const thermos = route === "skill:thermo-nuclear-code-quality-review";
        const allowed: Call[] = thermos
          ? [{ name: "pstack_delegate", arguments: { purpose: "thermos", role: "interrogate-reviewers", tasks: ["Read source.txt and report the existing defect; preserve the source."] } },
            work("advance", { stage: "apply", note: "The independent reader reported the existing defect." }), work("complete")]
          : [{ name: "subagent", arguments: reader }, work("block", { note: "The read-only inspection is preserved for a later decision." })];
        const results = await invoke([work("resume"), ...attacks, ...allowed]);
        for (const attack of attacks) {
          const result = results.find(message => message.toolCallId === attack.id);
          assert(result?.isError && result.content.some(part => part.type === "text" && part.text.includes("This workflow is read-only")), tagId + ": " + attack.id);
        }
        const reviewed = children.slice(beforeChildren);
        assert.equal(reviewed.length, 2, "Only the permitted reader reaches the real child model: " + tagId);
        assert(reviewed.every(item => item.model === "reviewer" && item.tools.includes("read") &&
          !item.tools.some(tool => ["write", "edit", "bash", "powershell"].includes(tool))));
        assert(reviewed.some(item => item.readSucceeded), "The permitted reviewer actually read the source: " + tagId);
        assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "unresolved fixture defect\n");
        for (const file of ["shell.txt", "writer.txt"]) await assert.rejects(readFile(join(cwd, file)), { code: "ENOENT" });
        const frozen = (await runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx))!.run!;
        assert.equal(frozen.tagId, tagId);
        if (thermos) {
          assert.equal(frozen.phase, "complete"); assert.equal(frozen.review?.passed, false);
          assert.match(frozen.thermosOutcome ?? "", /待修复/);
        }
        await invoke([work("start", { skill: "principle-prove-it-works", replace: true, note: "The user now requests an authorized coding change." }),
          { name: "write", arguments: { path: "new-parent.txt", content: "authorized parent\n" } },
          { name: "subagent", arguments: worker }, work("block", { note: "New coding work is available for the next step." })]);
        assert.equal(await readFile(join(cwd, "new-parent.txt"), "utf8"), "authorized parent\n");
        assert.equal(await readFile(join(cwd, "writer.txt"), "utf8"), "authorized child\n");
        assert.equal((await runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx))!.run!.tagId, "minimal");
      } finally { await runtime.close(); db.close(); }
    }
    console.log("PASS frozen read-only tags and standalone Thermos reject native writes, shells and writer delegation; real isolated readers and newly authorized minimal workflows remain usable");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

async function testProjectVerification() {
  const cwd = join(root, "project-verification");
  await mkdir(cwd);
  const git = (...args: string[]) => exec("git", ["-C", cwd, ...args], { windowsHide: true });
  const commit = () => git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture");
  const taskId = "project-verification";
  const countPath = join(root, `${taskId}-calls`);
  const appendCount = `require('node:fs').appendFileSync(${JSON.stringify(countPath)}, 'once\\n');`;
  const test = "test:project";
  await git("init", "-q", "-b", "main");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", scripts: {
    [test]: "node check.cjs", "test:masked": "node masked.cjs", "test:changes": "node changes.cjs",
  } }));
  await writeFile(join(cwd, "check.cjs"), `${appendCount}\nrequire('node:assert/strict').equal(require('node:fs').readFileSync('input.txt', 'utf8').trim(), 'ok');`);
  await writeFile(join(cwd, "masked.cjs"), `console.log('# tests 1\\n# fail 1');`);
  await writeFile(join(cwd, "changes.cjs"), `require('node:fs').writeFileSync('input.txt', 'changed');`);
  await writeFile(join(cwd, "input.txt"), "ok\n");
  await git("add", "."); await commit();
  const db = new AppDatabase(join(root, `${taskId}-app.db`));
  db.upsertTask({ id: taskId, title: "Project check", updatedAt: Date.now() });
  const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => "auto",
    attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
    interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
    getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: cwd }) });
  const observe = defineTool({ name: "fixture_project_proof", description: "Read current proof", replay: "safe",
    parameters: Type.Object({}), async execute(_args, api, context) {
      const proof = await readCurrentProjectVerification(api, context, cwd, [test], { [test]: ["npm"] });
      return { output: [{ type: "text", text: JSON.stringify(proof) }] };
    } });
  const open = () => DurableBotRuntime.open({ directory: join(root, `${taskId}-store`), cwd, models, model: { provider: model.provider, modelId: model.id },
    toolMode: "native", instructions: () => "Fixture", tools: [createDurableProjectVerification({ taskId, cwd }), observe],
    toolHooks: policy.hooks, onSnapshot: () => {} });
  let runtime = await open();
  let run = 0;
  async function invoke(script?: string, args?: string[]) {
    const name = script ? PROJECT_VERIFY_TOOL : observe.name;
    queue.push({ name, arguments: script ? { script, manager: "npm", ...(args && { args }) } : {} });
    assert.equal((await (await runtime.submit("Check project", `check-${++run}`)).wait(ctx)).status, "done");
    const entries = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 250), ctx);
    const latest = entries.items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult" && m.toolName === name).at(-1);
    assert(latest?.role === "toolResult" && latest.content[0]?.type === "text");
    return JSON.parse(latest.content[0].text);
  }
  try {
    const first = await invoke(test);
    assert.equal(first.outcome, "passed", JSON.stringify(first));
    assert.equal(first.reused, false);
    const again = await invoke(test);
    assert.equal(again.reused, true);
    assert.equal(again.toolTaskId, first.toolTaskId);
    assert.deepEqual((await invoke()).verified, [test]);
    await runtime.close();
    runtime = await open();
    assert.equal((await invoke(test)).reused, true);
    assert.equal((await invoke(test, ["--fixture=extra"])).reused, false);
    assert.equal(await readFile(countPath, "utf8"), "once\nonce\n");
    await writeFile(join(cwd, "input.txt"), "failure\n");
    assert.deepEqual((await invoke()).verified, []);
    assert.equal((await invoke(test)).outcome, "command_failed");
    assert.equal((await invoke(test)).outcome, "command_failed");
    assert.equal((await invoke("test:masked")).outcome, "assertion_failed");
    assert.equal((await invoke("test:changes")).outcome, "workspace_changed");
    await writeFile(join(cwd, "input.txt"), "ok\n");
    assert.equal((await invoke(test)).reused, true);
    await writeFile(join(cwd, "input.txt"), "ok \n");
    assert.equal((await invoke(test)).reused, false);
    await git("add", "."); await commit();
    assert.deepEqual((await invoke()).verified, []);
    assert.equal((await invoke(test)).reused, false);
    const settled = await invoke();
    assert.equal(settled.head, (await git("rev-parse", "HEAD")).stdout.trim());
    assert.equal(settled.clean, true);
    assert.deepEqual(settled.verified, [test]);
    assert.equal(await readFile(countPath, "utf8"), "once\n".repeat(6));
    console.log("PASS project verification reuses only current durable native proof and rejects failing, masked and changing checks");
  } finally { await runtime.close(); db.close(); }
}

try {
  await testPotetoRouting();
  await testFrozenReadOnlyWorkflows();
  await testProjectVerification();
  const repo = join(root, "repo"), cwd = join(root, "plain");
  await mkdir(repo); await mkdir(cwd);
  await writeFile(join(root, "plan.md"), "the configured plan");
  assert.equal((await readPlanFile(root, undefined, "plan.md")).text, "the configured plan");
  await assert.rejects(readPlanFile(root, "another.md", "plan.md"), /saved planPath/);
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { windowsHide: true });
  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "tracked.ts"), "a\nb\n");
  await writeFile(join(repo, "clean.ts"), "one\ntwo\n");
  await git("add", "."); await git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture");
  const liveBatch = join(root, "live-batch"), nativeDir = join(liveBatch, "native"), originalDir = join(liveBatch, "original");
  await mkdir(nativeDir, { recursive: true }); await mkdir(originalDir);
  const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  const liveMeta = { route: "bug-fix", cwd: repo, root, sourceHash: "source", request: "current request", modelId: "fixture/current", start: "2026-01-01T00:00:00Z" };
  const nativeMeta = { ...liveMeta, arm: "native", attemptId: "native-new" };
  const record = { conversation: 1, entry: 1, role: "assistant", stop: "stop", calls: [] };
  const terminal = { end: "2026-01-01T00:00:05Z", records: [record] };
  const originalMeta = { ...liveMeta, arm: "original" };
  const nativeEvidence = { ...nativeMeta, ...terminal, workflow: { phase: "complete" } };
  await writeJson(join(liveBatch, "original-catalog.json"), [{ playbook: liveMeta.route, sha256: liveMeta.sourceHash }]);
  await writeJson(join(nativeDir, "run.json"), nativeMeta);
  await writeJson(join(originalDir, "run.json"), originalMeta);
  await writeJson(join(originalDir, "evidence.json"), { ...originalMeta, ...terminal });
  const liveReport = () => exec(process.execPath, ["scripts/pstack-live-pairs.mjs", liveBatch]);
  for (const stale of [{ request: "old request", modelId: "fixture/old" }, { attemptId: "native-old" }, { end: "2025-12-31T23:59:59Z" }]) {
    await writeJson(join(nativeDir, "evidence.json"), { ...nativeEvidence, ...stale });
    assert.match((await liveReport()).stdout, /no settled same-input pair/);
    const pairs = JSON.parse(await readFile(join(liveBatch, "paired-inputs.json"), "utf8"));
    assert.equal(pairs[0].attempts.find((attempt: { arm: string }) => attempt.arm === "native").status, "evidence-mismatch");
    const observed = await exec(process.execPath, ["scripts/pstack-live-observe.mjs", liveBatch]);
    assert.match(observed.stdout, /native bug-fix evidence-mismatch/);
  }
  await writeFile(join(nativeDir, "evidence.json"), "{\"incomplete\":");
  assert.match((await liveReport()).stdout, /no settled same-input pair/);
  await writeJson(join(liveBatch, "observations.json"), [{ status: "complete", directory: nativeDir }]);
  await exec(process.execPath, ["scripts/pstack-live-artifacts.mjs", liveBatch]);
  const staleArtifacts = JSON.parse(await readFile(join(liveBatch, "artifact-checks.json"), "utf8"));
  assert.equal(staleArtifacts[0].status, "evidence-mismatch");
  await writeJson(join(nativeDir, "evidence.json"), nativeEvidence);
  assert.match((await liveReport()).stdout, /native ↔ original/);
  console.log("PASS Pstack live reports reject evidence for another request, model or attempt and accept a matching pair");
  const divergence = await baselineWorkspace(repo);
  const tree = (await git("rev-parse","HEAD^{tree}")).stdout.trim();
  const fixtureCommit = async (name: string) => (await git("-c","user.name=fixture","-c","user.email=fixture@invalid",
    "commit-tree", tree, "-p", divergence.head, "-m", name)).stdout.trim();
  await git("update-ref","refs/heads/review-base",await fixtureCommit("base moved"));
  const topic = {...divergence,head:await fixtureCommit("topic changed")};
  assert.equal(await branchReviewBase(topic,"review-base"), divergence.head);
  assert.equal(await branchReviewBase(topic,""), divergence.head);
  await assert.rejects(branchReviewBase(topic,"missing-review-ref"));
  await writeFile(join(repo, "tracked.ts"), "prior change\nb\n");
  await writeFile(join(repo, "prior.ts"), "unrelated\n");
  const baseline = await baselineWorkspace(repo);
  assert.deepEqual((await measureWorkspace(baseline, 3)).paths, []);
  const priorReview = reviewScope(baseline, await reviewCommit(baseline, "HEAD"));
  const longRepo = join(root,"long-file");
  await mkdir(longRepo);
  const lines = Array.from({length:1250},(_,i) => "line-" + i);
  await writeFile(join(longRepo,"module.txt"),lines.join("\n"));
  const longBase = await baselineWorkspace(longRepo);
  lines[0] = "updated-first"; lines[1249] = "updated-last";
  await writeFile(join(longRepo,"module.txt"),lines.join("\n"));
  const farEdits = await measureWorkspace(longBase,1000);
  assert.equal(farEdits.changedLines,4, "Two distant replacements should count as two additions and two deletions.");
  assert.equal(farEdits.coverageComplete,true);
  const existing = await measureWorkspace(priorReview, 3);
  assert.deepEqual(existing.paths, ["prior.ts", "tracked.ts"], "existing work selected for review is separate from task-authored changes");
  assert.match((await reviewBaseline(priorReview, existing.paths)).originals["tracked.ts"], /Before:\na\nAfter:\nprior change/);
  await writeFile(join(repo, "tracked.ts"), "new change\nb\n");
  await writeFile(join(repo, "clean.ts"), "one\ntwo\nif (x) use();\n");
  await writeFile(join(repo, "added.ts"), "added\n");
  const delta = await measureWorkspace(baseline, 2);
  assert.deepEqual(delta.paths, ["added.ts", "clean.ts", "tracked.ts"]);
  assert.deepEqual(delta.unknown, []);
  assert.equal(delta.changedLines, 4); assert.equal(delta.largestCrossing, 3); assert.equal(delta.addedBranches, 1);
  assert.match((await reviewBaseline(baseline, delta.paths)).originals["tracked.ts"], /prior change/);
  for (const [request, review, merge] of [
    ["No remote writes, uploads or publication.", false, false],
    ["Code review isn't needed; 代码审查不必做。", false, false],
    ["Do not run a code review or merge the patch; 这次无需审查，也不要合并。", false, false],
    ["Read the `review` action and explain it.\n> Please review the patch", false, false],
    ["修复本地测试样例，严格看下质量，先不要合并", true, false],
    ["Please review target.cjs; do not merge.", true, false],
    ["This is the pre-merge check. Do not merge.", false, true],
    ["合入前先做独立复核，现阶段不要合入。", true, true],
  ] as const) assert.deepEqual(reviewIntent([request]), { review, merge }, request);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "revise", findings: [{ path: "a.ts", issue: "Missing case" }], checks: { types: { path: "a.ts", detail: "Unbounded input" } } }), ["types"]), false);
  const valid = '{"verdict":"pass","findings":[],"checks":{"types":"Inspected target.cjs:1"}}';
  assert.equal(parseThermosVerdict("## 结论\nVerified the target.\n" + valid, ["types"]), true);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "pass", findings: [], notes: ["Optional rename"], checks: { types: "a.ts:1 validates input" } }), ["types"]), true);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "pass", findings: ["Unresolved type leak"], checks: { types: "a.ts:1" } }), ["types"]), false);
  assert.equal(parseThermosVerdict(JSON.stringify({ verdict: "revise", findings: [], notes: ["Investigate"], checks: { types: "a.ts:1" } }), ["types"]), false);
  assert.throws(() => parseThermosVerdict(valid + "\n" + valid, ["types"]), /exactly one/);
  assert.throws(() => parseThermosVerdict(valid + "\nActually, revise this.", ["types"]), /trailing/);
  assert.throws(() => parseThermosVerdict('{"verdict":"pass","findings":[],"checks":{}}', ["types"]), /Missing criteria: types/);
  const signals = join(root, "signals");
  await mkdir(signals);
  await writeFile(join(signals, "photo.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 40]));
  const signalBase = await baselineWorkspace(signals);
  await writeFile(join(signals, "photo.png"), Buffer.alloc(526_000, 0));
  const imageDelta = await measureWorkspace(signalBase, 10);
  assert.deepEqual(imageDelta.paths, ["photo.png"]); assert.deepEqual(imageDelta.unknown, []); assert.equal(imageDelta.changedLines, 0);
  await writeFile(join(signals, "large.txt"), "a".repeat(526_000));
  assert((await measureWorkspace(signalBase, 10)).unknown.some(row => row.startsWith("large.txt")));
  await writeFile(join(signals, "rules.ts"), "function first(a) { if (a) return 1; }\nfunction second(b) { if (b) return 2; }\nfunction third(c) { if (c) return 3; }\n");
  assert.equal((await measureWorkspace(signalBase, 10)).addedBranches, 3);
  const externalRoot = join(root,"installed"), packageId="group-roles", skillDir=join(externalRoot,packageId);
  await mkdir(skillDir,{recursive:true});
  const file=join(skillDir,"SKILL.md"), project=await baselineWorkspace(cwd);
  await writeFile(file,"rule\n".repeat(200));
  const firstSkill=await skillFileState(externalRoot,packageId,true);
  assert.equal((await measureWorkspace(project,200,undefined,[{path:file,before:missingFile,current:firstSkill}])).changedLines,200);
  await writeFile(file,"rule\n".repeat(201));
  const nextSkill=await skillFileState(externalRoot,packageId,true);
  const created=await measureWorkspace(project,200,undefined,[{path:file,before:missingFile,current:nextSkill}]);
  const improved=await measureWorkspace(project,200,undefined,[{path:file,before:firstSkill,current:nextSkill}]);
  assert.deepEqual(created.paths,[file]);assert.equal(created.changedLines,201); assert.equal(improved.changedLines,1);assert.equal(improved.largestCrossing,201);
  assert.deepEqual((await measureWorkspace(project,200)).paths,[]);
  console.log("PASS explicit and negated bilingual intent, structured review findings, exact criteria, SHA-verified binary and scattered branch thresholds");
  for (const fake of ["echo passed", "exit 0", "pnpm test || true", "pnpm test --help", "node --test --test-name-pattern=never; true"])
    assert.equal(isPstackCheck(fake), false, fake);
  assert.equal(isPstackCheck("check-factory sample", "check-factory sample"), true);
  assert.equal(isPstackCheck("node check.cjs"), true);
  assert.equal(isPstackCheck("node scripts/verify-pixels.cjs"), true);
  await writeFile(join(cwd, "compare.cjs"), "console.log('A: 1, B: 2')");
  assert.equal(await isPstackObservation("prototype", "node compare.cjs", cwd), true);
  assert.equal(await isPstackObservation("feature", "node compare.cjs", cwd), false);
  for (const cmd of ["node ../compare.cjs", "node compare.cjs && echo ok", "node compare.cjs --help", "node missing.cjs"])
    assert.equal(await isPstackObservation("trace-forensics", cmd, cwd), false, cmd);
  assert.equal(isPstackCheck("node -e \"console.log('test')\""), false);
  console.log("PASS task-relative Git diff, pre-existing tracked and untracked work, native review baseline, check command admission");

  const incomplete = join(root, "incomplete-workspace");
  await mkdir(incomplete);
  const expectedFile = join(incomplete, "entry");
  await writeFile(expectedFile, "tracked");
  const incompleteBase = await baselineWorkspace(incomplete);
  await rm(expectedFile);
  await mkdir(expectedFile);
  const uncertainBefore = await measureWorkspace(incompleteBase, 1000);
  const uncertainAfter = await measureWorkspace(incompleteBase, 1000);
  assert.equal(uncertainBefore.fingerprint, uncertainAfter.fingerprint);
  assert.equal(uncertainBefore.coverageComplete, false);
  const unverified = verificationOutcome(uncertainBefore, uncertainAfter, 0, false, false, false);
  assert.equal(unverified.outcome, "workspace_unverified");
  assert.match("error" in unverified ? unverified.error : "", /entry: non-regular file/);

  const settings = normalizePstackSettings({});
  const host = createPstackWorkflow({ taskId: "pstack-fixture", cwd, settings: () => settings, active: () => enabled });
  await new Promise<void>(resolve => sourceServer.listen(0, "127.0.0.1", resolve));
  const sourceAddress = sourceServer.address();
  assert(sourceAddress && typeof sourceAddress === "object");
  const sourceBase = "http://127.0.0.1:" + sourceAddress.port;
  const fetchSources = defineTool({ name: "fetch_content", description: "Fetch local source fixtures", replay: "safe",
    parameters: Type.Object({ urls: Type.Array(Type.String()) }), async execute({ urls }) {
      const results = await Promise.all(urls.map(async url => {
        assert(url.startsWith(sourceBase + "/"), "Source fixtures only fetch this local HTTP server");
        const response = await fetch(url);
        const content = await response.text();
        return { url, content, error: response.ok ? "" : "HTTP " + response.status };
      }));
      return { output: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
    },
  });
  const acceptedChecks: Array<Awaited<ReturnType<typeof readGoalObservations>>["observations"][number]["checkIdentity"]> = [];
  const rejectedChecks: string[] = [];
  const observe = defineTool({ name: "fixture_observe_goal_check", description: "Resolve this Goal's quoted check", replay: "safe",
    parameters: Type.Object({ operation: Type.String(), quote: Type.String(), toolCallId: Type.String() }),
    async execute({ operation, quote, toolCallId }, native, context) {
      const proof = await withDurableExecution({
        native, context, cwd, runId: operation, presentationConversationId: native.conversationId,
        execution: { taskId: "pstack-fixture", assistantMessageId: "fixture-accept", executionId: "fixture-accept" },
      }, () => readGoalObservations("git-check", operation, [{ quote, toolCallId }], [], "Verified checkout.")).catch((error: Error) => {
        rejectedChecks.push(error.message);
        throw error;
      });
      acceptedChecks.push(proof.observations[0].checkIdentity);
      return { output: [{ type: "text", text: "Recorded the current check." }] };
    },
  });
  const open = () => DurableBotRuntime.open({ directory: join(root, "store"), cwd, models, model: { provider: model.provider, modelId: model.id },
    toolMode: "native", instructions: () => "Fixture", tools: [...host.tools, observe, fetchSources], foregroundHooks: host, onSnapshot: () => {} });
  let runtime = await open();
  const status = () => runtime.harness.snapshot(WorkflowState, runtime.conversation.id, ctx);
  async function turn(input: string, id: string, calls: Call[]) {
    queue.push(...calls);
    const metadata = id.startsWith("git-") ? { text: input, displayText: input, attachments: [] } : undefined;
    const result = await (await runtime.submit(input, id, "followUp", metadata)).wait(ctx);
    await runtime.conversation.waitForIdle(ctx);
    assert.equal(queue.length, 0, JSON.stringify(result));
    return result;
  }
  const skill = "principle-prove-it-works";
  try {
    const greeting = await turn("你好！", "git-greeting", []);
    assert.equal(greeting.status, "done", JSON.stringify(greeting));
    const greetingHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 100), ctx);
    const greetingAnswers = greetingHistory.items.flatMap(entry => (entry.model ?? []).flatMap(message =>
      message.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []));
    assert.deepEqual(greetingAnswers, ["Fixture yielded."]);
    const explanation = await turn("详细讲讲 compare.cjs 为什么会有两项输出，我只想理解代码。", "git-explain", [
      { name: "read", arguments: { path: "compare.cjs" } },
    ]);
    assert.equal(explanation.status, "done", JSON.stringify(explanation));
    const explanationHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
      minEntryId: explanation.entry, order: "ascending" }, 100), ctx);
    const explanationMessages = explanationHistory.items.flatMap(entry => entry.model ?? []);
    assert(explanationMessages.some(message => message.role === "toolResult" && !message.isError && message.toolName === "read" &&
      message.content.some(part => part.type === "text" && part.text.includes("console.log('A: 1, B: 2')"))));
    assert.equal((await status())?.run ?? null, null, "explaining source does not start an implementation workflow");
    const first = await turn("把空值情况也兼容一下", "run-1", [
      work("start", { skill }),
      work("advance", { stage: "apply", note: "Inspect project behavior" }), work("complete"), work("block", { note: "Awaiting fixture input" }),
      { name: "write", arguments: { path: "after-block", content: "blocked" } },
    ]);
    assert.equal(first.status, "done", JSON.stringify(first));
    const initialHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 100), ctx);
    const initialResults = initialHistory.items.flatMap(e => e.model?.flatMap(m => m.role === "toolResult" ? [JSON.stringify(m.content).slice(0, 320)] : []) ?? []);
    assert.equal((await status())?.run?.phase, "blocked", JSON.stringify(initialResults));
    await assert.rejects(readFile(join(cwd, "after-block")), { code: "ENOENT" });
    const revision = (await status())!.run!.revision;
    await runtime.close(); runtime = await open();
    assert.equal((await status())?.run?.revision, revision, "same run survives production durable reopen");
    const thanks = await runtime.submit("做得挺好的，谢谢", "acknowledge-block");
    assert.equal(await runtime.reply(thanks), "Fixture yielded.", "a new acknowledgement gets its own reply");
    assert.equal((await status())?.run?.phase, "blocked", "acknowledgement does not clear the gate");
    const testFile = "const test=require('node:test'); test('works',()=>{});\n";
    const changingTest = "require('node:test')('passes while workspace changes',()=>require('node:fs').writeFileSync('overlap.txt','updated'));\n";
    const finished = await turn("继续", "run-2", [work("resume"),
      { name: "write", arguments: { path: "check.cjs", content: testFile } },
      work("complete"), work("verify", { shell: "bash", command: "echo passed" }), work("verify", { shell: "bash", command: "node --test" }),
      { name: "write", arguments: { path: "overlap.txt", content: "original" } },
      { name: "write", arguments: { path: "changing-check.cjs", content: changingTest } },
      work("verify", { shell: "bash", command: "node --test changing-check.cjs" }), work("status"), work("complete"),
      work("verify", { shell: "bash", command: "node --test check.cjs" }),
      { name: "write", arguments: { path: "check.cjs", content: testFile + "// changed since test\n" } }, work("complete"),
      work("verify", { shell: "bash", command: "node --test check.cjs" }), work("complete")]);
    assert.equal(finished.status, "done", JSON.stringify(finished));
    await runtime.close(); runtime = await open();
    const completed = (await status())!.run!;
    assert.equal(completed.phase, "complete"); assert.equal(completed.verification?.passed, true);
    assert.match(completed.thermosOutcome ?? "", /Thermos 未触发/);
    const history = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 180), ctx);
    const errors = history.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" && m.isError ? m.content.flatMap(c => c.type === "text" ? [c.text] : []) : []));
    const confirmed = currentVerificationEvidence(completed, completed.verification!.fingerprint, history.items);
    assert.deepEqual(confirmed.map(r => [r.command, r.toolTaskId, r.exitCode]), [["node --test check.cjs", completed.verification!.toolTaskId, 0]]);
    assert(confirmed[0].output.includes("works"));
    const identity = confirmed[0].checkIdentity!;
    assert.deepEqual(identity, completed.verification?.checkIdentity);
    assert.equal(identity.beforeFingerprint, identity.afterFingerprint);
    assert.notEqual(identity.operationTaskId, identity.toolTaskId);
    const generations = await runtime.harness.commit(async tx => {
      const owners = new Map<number, { conversationId: string; generationTaskId: number }>();
      for (const { checkIdentity: check } of completed.checkReceipts!) {
        const child = await tx.task(check.toolTaskId as TaskId);
        assert.equal(child?.owner, check.operationTaskId);
        let task = await tx.task(check.operationTaskId as TaskId);
        while (task && task.kind !== GenerationTask.definition.name)
          task = task.owner === undefined ? undefined : await tx.task(task.owner);
        assert(task, "Pstack operation descends from the generation receiving its evidence");
        owners.set(task.id, { conversationId: String(task.conversationId), generationTaskId: Number(task.id) });
      }
      return [...owners.values()];
    }, ctx);
    const nativeChecks = (await readGoalNativeEvidence(join(root, "store"), generations)).flatMap(row =>
      row.evidence.kind === "check" ? [{ operation: row.toolTaskId, check: row.evidence }] : []);
    assert.deepEqual(nativeChecks.map(({ check }) => check.checkIdentity), completed.checkReceipts!.map(receipt => receipt.checkIdentity));
    assert.deepEqual(nativeChecks.at(-1), { operation: identity.operationTaskId, check: {
      kind: "check", command: "node --test check.cjs", passed: true, exitCode: 0,
      fingerprint: identity.afterFingerprint, outcome: "passed", checkIdentity: identity,
    } });
    const persistedResult = history.items.find(entry => entry.byTaskId === identity.operationTaskId)?.model
      ?.find(message => message.role === "toolResult" && message.toolName === "pstack_workflow");
    assert(persistedResult?.role === "toolResult" && persistedResult.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(persistedResult.content[0].text), completed.checkReceipts!.at(-1));
    assert.deepEqual(currentVerificationEvidence(completed, identity.afterFingerprint, []),
      confirmed.map(({ entry: _entry, ...check }) => check), "review uses the committed receipt even without tool-result text");
    assert.deepEqual(currentVerificationEvidence(completed, "changed-since-check", history.items), []);
    assert(errors.some(e => /No successful workspace observation/.test(e)), JSON.stringify(errors));
    assert.equal(errors.filter(e => /Current workspace needs/.test(e)).length, 2, JSON.stringify(errors));
    assert(errors.some(e => /single test\/check|run one check/i.test(e)), JSON.stringify(errors));
    assert(errors.some(e => e.includes("executed zero tests")), JSON.stringify(errors));
    const stale = errors.find(e => e.includes('"outcome": "workspace_changed"'));
    assert(stale, JSON.stringify(errors));
    const staleReceipt = JSON.parse(stale);
    assert.deepEqual({ passed: staleReceipt.passed, exitCode: staleReceipt.exitCode, unchanged: staleReceipt.unchanged, paths: staleReceipt.changedPaths },
      { passed: false, exitCode: 0, unchanged: false, paths: ["overlap.txt"] });
    const statusReply = history.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" && !m.isError ? m.content.flatMap(c => c.type === "text" ? [c.text] : []) : []))
      .find(e => e.includes('"verification"') && e.includes('"outcome": "workspace_changed"'));
    assert(statusReply?.includes('"exitCode": 0'), JSON.stringify(statusReply));
    assert(errors.some(e => e.includes("exited successfully") && e.includes("overlap.txt") && !e.startsWith("{")));
    console.log("PASS explicit workflow block, absent evidence, durable reopen, real nested shell exit, stale verification, completion");
    const readTurn = await turn("Only inspect check.cjs. Do not change project files.", "run-3", [work("start", { skill }), { name: "read", arguments: { path: "check.cjs" } },
      { name: "pstack_workflow", arguments: { action: "decision", decision: { phase: "apply", decision: "Answer", why: "Read only", evidence: "check.cjs", result: "Inspected" } } },
      work("advance", { stage: "apply", note: "Read the actual test" }), work("complete")]);
    assert.equal(readTurn.status, "done", JSON.stringify(readTurn)); assert.notEqual((await status())!.run!.run, completed.run);
    const actual = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, order: "ascending" }, 250), ctx);
    const observations = observedReviewFiles(actual.items, cwd, cwd);
    assert(observations.some(o => o.tool === "read" && o.path === "check.cjs"));
    const targets = await reviewTargets(cwd, [], ["Inspect check.cjs."], actual.items);
    assert.deepEqual(targets, ["check.cjs"]);
    await validateInspections(cwd, targets, [{ child: 3, observations }]);
    await assert.rejects(validateInspections(cwd, targets, [{ child: 4, observations: [] }]), /without a successful native read/);
    await assert.rejects(validateInspections(cwd, targets, [{ child: 3, observations }, { child: 4, observations: [{ path: ".mybuddy-task.json", tool: "read", entry: 46 }] }]), /Reviewer 4/);
    assert(actual.items.some(e => e.model?.some(m => m.role === "assistant" && m.content.some(p => p.type === "text" && p.text.includes("Thermos 未触发")))));
    assert(actual.items.some(e => e.model?.some(m => m.role === "toolResult" && m.isError && m.content.some(p => p.type === "text" && p.text.includes("cannot append a workspace decision log")))));
    const advance = (stage: string) => work("advance", { stage, note: "Observed outcome: " + stage });
    const verification = work("verify", { shell: "bash", command: "node --test behavior.cjs" });
    const desktopFixtureRoot = join(root, "desktop-check");
    await mkdir(desktopFixtureRoot);
    await writeFile(join(desktopFixtureRoot, "fixture-layout.txt"), "fixed\n");
    const desktopFixture = resolve("scripts/desktop-verification-case-fixture.cjs");
    const desktopCheck = `process.chdir(${JSON.stringify(desktopFixtureRoot)}); process.argv[2]='cleanup'; require(${JSON.stringify(desktopFixture)});`;
    const setup = await turn("通过行为测试修复当前错误。", "tdd-setup", [work("start", { skill: "tdd" }), advance("repro"),
      { name: "write", arguments: { path: "desktop-check.cjs", content: desktopCheck } },
      work("verify", { shell: "bash", command: "node desktop-check.cjs" }), work("block", { note: "Inspect launcher cleanup failure" })]);
    assert.equal(setup.status, "done");
    const setupRun = (await status())!.run!;
    assert.equal(setupRun.verification?.exitCode, 1);
    assert.equal(setupRun.red, undefined, "an assertion pass followed by a cleanup failure is not a TDD red receipt");
    assert.equal(setupRun.verification?.outcome, "infrastructure_failed");
    const desktopReport = setupRun.verification?.checkIdentity?.desktopReport;
    assert(desktopReport, "the nested desktop result retains the finalized report identity");
    assert.deepEqual(desktopReport.caseIds, ["cleanup"]);
    assert.equal(desktopReport.reportSha256, createHash("sha256").update(await readFile(desktopReport.reportPath)).digest("hex"));
    const tddRun = await turn("继续测试。", "tdd", [work("resume"), advance("red"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=0;\n" } },
      { name: "write", arguments: { path: "behavior.cjs", content: "require('node:test')('expected value',()=>require('node:assert/strict').equal(require('./value.cjs'),1));\n" } },
      verification, advance("red"), advance("implement"), advance("green"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=1;\n" } },
      verification,
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=0;\n" } },
      advance("green"),
      { name: "write", arguments: { path: "value.cjs", content: "module.exports=1;\n" } },
      advance("green"), advance("regression"), work("complete")]);
    assert.equal(tddRun.status, "done", JSON.stringify(tddRun));
    const tdd = (await status())!.run!;
    assert.equal(tdd.phase, "complete"); assert.equal(tdd.red?.exitCode, 1);
    assert.equal(tdd.red?.command, tdd.verification?.command);
    assert.notEqual(tdd.verification?.fingerprint, tdd.red?.fingerprint);
    const tddHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, minEntryId: tdd.first, order: "ascending" }, 120), ctx);
    assert(tddHistory.items.some(e => (e.model ?? []).some(message => message.role === "toolResult" && message.isError &&
      message.content.some(part => part.type === "text" && part.text.includes("successful check covers a different workspace version")))),
      "the green step must reject success evidence for the previous file content");
    console.log("PASS actual failing TDD assertion, missing red/green gates, repaired product returns green on same command");
    const before = replies;
    const unfinished = await turn("你好，空值也算进去", "run-4", [work("start", { skill })]);
    assert.notEqual(unfinished.status, "done", "An explicitly started workflow cannot settle before completion");
    assert.equal(replies - before, 3, "two native continuations, independent of message language");
    const pendingRun = (await status())!.run!.run;
    assert.equal((await turn("Before continuing, explain compare.cjs.", "side-question", [
      { name: "read", arguments: { path: "compare.cjs" } },
    ])).status, "done", "a running workflow does not take over an unrelated input");
    assert.equal((await status())?.run?.run, pendingRun);
    const beforeKetchup = await status();
    const ketchupTurn = await turn("Give me a read-only ketchup update without interrupting the current task.", "ketchup-active", [
      work("skill", { skill: "ketchup" }), work("status"),
    ]);
    assert.equal(ketchupTurn.status, "done");
    assert.deepEqual(await status(), beforeKetchup, "ketchup guidance must not replace, bind a new input to, or advance the active workflow");
    const ketchupHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
      minEntryId: ketchupTurn.entry, order: "ascending" }, 30), ctx);
    const ketchupPayload = ketchupHistory.items.flatMap(entry => entry.model ?? []).flatMap(message =>
      message.role === "toolResult" && message.toolName === "pstack_workflow" && !message.isError
        ? message.content.flatMap(part => part.type === "text" ? [JSON.parse(part.text)] : []) : [])
      .find(result => result.currentWorkflow);
    assert.equal(ketchupPayload?.currentWorkflow.run, pendingRun);
    assert.equal(ketchupPayload?.currentWorkflow.phase, "running");
    const nested = await turn("Investigate a new change", "nested-route", [work("start", { playbook: "feature", replace: true, note: "Switch to the new feature." }), work("invoke", { skill: "why" }),
      work("advance", { stage: "trace", note: "Attempt to skip nested stages" }), work("advance", { stage: "trace::why::target", note: "Bound the historical decision" }),
      work("block", { note: "Need the introducing change record" })]);
    assert.equal(nested.status, "done"); assert.equal((await status())!.run!.stage, 1);
    assert.deepEqual((await status())!.run!.invoked, [{ stage: "trace", skill: "why" }]);
    const readOnly = await turn("只调查标签是怎样去重的，在聊天中解释。", "readonly-investigation", [
      work("start", { playbook: "investigation", replace: true, note: "The user selected a new read-only investigation." }),
      { name: "write", arguments: { path: "unsolicited-report.md", content: "report" } },
      work("block", { note: "Awaiting the input sample." }),
    ]);
    assert.equal(readOnly.status, "done");
    await assert.rejects(readFile(join(cwd, "unsolicited-report.md")), { code: "ENOENT" });
    await turn("继续，检查本地文件。", "merge-gate", [work("resume"), { name: "bash", arguments: { command: "git merge fixture" } },
      work("review"), work("block", { note: "Approval needed to proceed with integration." })]);
    const latest = (await status())!.run!.first;
    const mergeHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id, minEntryId: latest, order: "ascending" }, 140), ctx);
    const mergeMessages = mergeHistory.items.flatMap(e => (e.model ?? []).flatMap(m => m.role === "toolResult" ? m.content.flatMap(p => p.type === "text" ? [p.text] : []) : []));
    assert(mergeMessages.some(s => s.includes('"pre-merge review"')), JSON.stringify(mergeMessages).slice(-5000));
    const originalCheck = await readFile(join(cwd, "check.cjs"), "utf8");
    await turn("Test the temporary revision and restore the original check.", "restored-snapshot", [
      work("start", { skill, replace: true, note: "Verify a temporary revision before restoring the baseline." }),
      { name: "write", arguments: { path: "check.cjs", content: originalCheck + "// temporary revision\n" } },
      work("verify", { shell: "bash", command: "node --test check.cjs" }),
      { name: "write", arguments: { path: "check.cjs", content: originalCheck } },
      advance("apply"), work("complete"), work("block", { note: "A check of the restored snapshot is still required." }),
    ]);
    assert.equal((await status())!.run!.verification?.passed, true, "the old revision passed its test");
    assert.equal((await status())!.run!.phase, "blocked", "restoring the baseline invalidates the previous success");
    const checkout = (...args: string[]) => exec("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], { windowsHide: true });
    await checkout("init", "-q", "-b", "main");
    await checkout("add", "check.cjs");
    await checkout("commit", "-qm", "initial test revision");
    const gitCheck = (id: string): Call => ({ ...work("verify", { shell: "bash", command: "node --test check.cjs" }), id });
    const quoteCheckout = (operation: string, sha: string, toolCallId: string): Call =>
      ({ name: observe.name, arguments: { operation, quote: `"checkoutSha": "${sha}"`, toolCallId } });
    const originalSha = (await checkout("rev-parse", "HEAD")).stdout.trim();
    await turn("Verify the exact checkout revision.", "git-check", [
      work("start", { skill, replace: true, note: "Verify the initial checkout." }), advance("apply"), gitCheck("verify-old"),
      quoteCheckout("git-check", originalSha, "verify-old"),
      work("block", { note: "Wait for checkout change." }),
    ]);
    const checkAtOldHead = (await status())!.run!.verification!;
    assert.equal(checkAtOldHead.checkIdentity?.checkoutSha, originalSha);
    assert.deepEqual(acceptedChecks, [checkAtOldHead.checkIdentity], JSON.stringify(rejectedChecks));
    await checkout("commit", "--allow-empty", "-qm", "same file bytes, new checkout revision");
    await turn("Continue on the current checkout.", "git-stale", [
      work("resume"), quoteCheckout("git-stale", originalSha, "verify-old"), work("complete"),
      work("block", { note: "Run a fresh check on the new commit." }),
    ]);
    assert.equal((await status())!.run!.phase, "blocked", "a passing check at a different same-tree commit cannot authorize completion");
    assert.equal(acceptedChecks.length, 1, "a prior passing tool result cannot satisfy current Goal acceptance");
    assert.deepEqual(rejectedChecks, ["引用的 Pstack 校验不适用于当前工作区版本，请重新校验并引用最新结果"]);
    const freshSha = (await checkout("rev-parse", "HEAD")).stdout.trim();
    await turn("Verify the new checkout.", "git-fresh", [
      work("resume"), gitCheck("verify-new"), quoteCheckout("git-fresh", freshSha, "verify-new"), work("complete"),
    ]);
    const newHead = (await status())!.run!;
    assert.equal(newHead.phase, "complete");
    assert.equal(newHead.verification?.fingerprint, checkAtOldHead.fingerprint);
    assert.equal(newHead.verification?.checkIdentity?.checkoutSha, (await checkout("rev-parse", "HEAD")).stdout.trim());
    assert.notEqual(newHead.verification?.checkIdentity?.checkoutSha, checkAtOldHead.checkIdentity?.checkoutSha);
    assert.deepEqual(acceptedChecks, [checkAtOldHead.checkIdentity, newHead.verification?.checkIdentity]);
    assert.deepEqual(currentVerificationEvidence(newHead, newHead.verification!.fingerprint, [], newHead.verification!.checkIdentity!.checkoutSha)
      .map(check => check.checkIdentity?.toolTaskId), [newHead.verification?.toolTaskId]);
    console.log("PASS same-tree checkout change invalidates the previous receipt through native workflow completion and review");
    const promptOutputs: Record<string, Record<string, string>> = {
      "in-your-own-words": { restate: "You want a rewritten import requirement that preserves empty values. The problem is ambiguous treatment of missing input; this step only restates that intent." },
      sharpen: {
        standard: "Specify empty-value semantics at the public import boundary and distinguish absent, null and empty string.",
        material: "Begin with the supplied user requirement, then ask the executing agent to inspect real input samples and the parser entry point.",
        methods: "Use a small input matrix and trace each value through the public parser contract.",
        evidence: "Verify against actual caller outcomes and a failing then passing boundary assertion.",
        rewrite: "Implement the smallest importer change preserving absent, null and empty string semantics; prototype disputed interpretations, recommend from evidence, and prove the chosen behavior through the public entry point.",
      },
    };
    for (const [method, outputs] of Object.entries(promptOutputs)) {
      const textRun = await turn("Only rewrite this requirement: support empty input values. Do not implement the task.", "prompt-" + method, [
        work("start", { skill: method }),
        { name: "write", arguments: { path: "prompt-method-write.txt", content: "An unauthorized implementation" } },
        ...Object.entries(outputs).map(([stage, note]) => work("advance", { stage, note })), work("complete"),
      ]);
      assert.equal(textRun.status, "done", JSON.stringify(textRun));
      const promptRun = (await status())!.run!;
      assert.equal(promptRun.phase, "complete", method);
      assert.equal(promptRun.verification, null, "Supplied-text methods do not need an artificial workspace check");
      assert.deepEqual(promptRun.delegates, []);
      assert.equal(promptRun.thermosOutcome, "", "A prompt rewrite does not add a code review claim");
      await assert.rejects(readFile(join(cwd, "prompt-method-write.txt")), { code: "ENOENT" });
      const promptHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
        minEntryId: promptRun.first, order: "ascending" }, 100), ctx);
      const promptResults = promptHistory.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
      assert(promptResults.some(message => message.toolName === "write" && message.isError));
      assert(promptResults.filter(message => !message.isError).every(message => message.toolName === "pstack_workflow"),
        "The prompt method completed without workspace observations, verification or worker receipts");
    }
    const sources = Array.from({ length: 8 }, (_, index) => ({ term: "Term " + index, url: sourceBase + "/term-" + index }));
    const failedSources = [...sources.slice(0, 7), { term: "Term 7", url: sourceBase + "/missing" }];
    const reframeTurn = await turn("Reframe this request using actual source terminology without implementing it.", "prompt-reframe", [
      work("start", { skill: "reframe" }), advance("ambiguity"),
      work("advance", { stage: "terms", note: "Eight terms with alleged sources", sources }),
      { name: "fetch_content", arguments: { urls: failedSources.map(source => source.url) } },
      work("advance", { stage: "terms", note: "One of these source pages returned 404", sources: failedSources }),
      { name: "fetch_content", arguments: { urls: [sources[7].url] } },
      work("advance", { stage: "terms", note: "Eight source-backed terms describe observable system behavior", sources }),
      advance("neighbors"), advance("gaps"), advance("rewrite"), work("complete"),
    ]);
    const reframed = (await status())!.run!;
    const reframeHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
      minEntryId: reframed.first, order: "ascending" }, 100), ctx);
    const sourceErrors = reframeHistory.items.flatMap(entry => entry.model ?? []).flatMap(message =>
      message.role === "toolResult" && message.isError ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []);
    assert.equal(reframeTurn.status, "done", JSON.stringify({ reframeTurn, stage: reframed.stage, reframe: reframed.reframe, sourceErrors }));
    assert.equal(reframed.phase, "complete");
    assert.deepEqual(reframed.reframe, [{ stageId: "terms", sources }]);
    assert.equal(sourceErrors.filter(error => error.includes("no successful fetch_content receipt")).length, 2,
      "Unopened URLs and failed batch members must both be rejected before the terms phase advances");
    assert.deepEqual([...fetchedPaths].sort(), [...Array.from({ length: 8 }, (_, index) => "/term-" + index), "/missing"].sort());
    const ketchupStandalone = await turn("Summarize the latest completed work with ketchup.", "ketchup-standalone", [
      work("start", { skill: "ketchup" }), advance("gather"), work("status"), advance("gather"),
      advance("changes"), advance("decisions"), work("complete"),
    ]);
    assert.equal(ketchupStandalone.status, "done", JSON.stringify(ketchupStandalone));
    assert.equal((await status())!.run!.phase, "complete");
    const ketchupStandaloneHistory = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime.conversation.id,
      minEntryId: ketchupStandalone.entry, order: "ascending" }, 60), ctx);
    assert(ketchupStandaloneHistory.items.some(entry => entry.model?.some(message => message.role === "toolResult" && message.isError &&
      message.content.some(part => part.type === "text" && part.text.includes("Read the current workflow status or actual workspace evidence")))),
      "ketchup cannot claim current progress before reading status or actual evidence");
    console.log("PASS text-only prompt completion, blocked implementation, fetched reframe sources, read-only ketchup snapshot and current-status gate");
    enabled = false;
    assert.equal((await turn("Question", "run-5", [])).status, "done");
    console.log("PASS actual read receipt, independent next workflow, bounded native onYield and disabled task");
  } finally { await runtime.close(); }
  enabled = true;
  const codeMode = await DurableBotRuntime.open({ directory: join(root, "codemode-explanation"), cwd, models,
    model: { provider: model.provider, modelId: model.id }, toolMode: "codemode", instructions: () => "Fixture",
    tools: host.tools, foregroundHooks: host, onSnapshot: () => {} });
  try {
    queue.push({ name: "codemode", arguments: { code: 'text(await tools.read({path:"compare.cjs"}));' } });
    const input = await codeMode.submit("Explain the existing compare.cjs script.", "codemode-explain");
    assert.equal(await codeMode.reply(input), "Fixture yielded.");
    const history = await codeMode.harness.commit(tx => tx.scanEntries({ conversationId: codeMode.conversation.id, order: "ascending" }, 100), ctx);
    const output = history.items.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "toolResult" && message.toolName === "codemode"
      ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []).join("\n");
    assert.match(output, /A: 1, B: 2/);
    assert.equal((await codeMode.harness.snapshot(WorkflowState, codeMode.conversation.id, ctx))?.run ?? null, null);
  } finally { await codeMode.close(); }
  const originalEnv = { HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE, PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR };
  try {
    const home=join(root,"author-profile"), workspace=join(home,"work");
    await mkdir(workspace,{recursive:true});
    process.env.HOME=process.env.USERPROFILE=home;process.env.PI_CODING_AGENT_DIR=join(home,".mybuddy");
    const {getSkillsDir}=await import("../src/main/paths");
    const installs=getSkillsDir();assert.equal(installs,join(home,".mybuddy","plugins","skills"));
    for(const id of ["owned","unrelated"]) {
      await mkdir(join(installs,id));await writeFile(join(installs,id,"SKILL.md"),"unchanged\n".repeat(200));
    }
    const selected=join(installs,"owned","SKILL.md"),other=join(installs,"unrelated","SKILL.md");
    const cfg=normalizePstackSettings({});cfg.thermos.fileLines=200;
    const app=createPstackWorkflow({taskId:"assess-improve",cwd:workspace,settings:()=>cfg,active:()=>true});
    const assess=defineTool({name:"skill_authoring_assess",description:"Fixture: select the existing skill for improvement",replay:"safe",parameters:Type.Object({}),
      execute:async()=>({output:[{type:"text",text:"Assessed installed skill."}],details:{decision:"improve-existing",targetSkillId:"owned"}})});
    const openAuth=()=>DurableBotRuntime.open({directory:join(home,"store"),cwd:workspace,models,model:{provider:model.provider,modelId:model.id},toolMode:"native",
      instructions:()=>"Fixture",tools:[...app.tools,assess],foregroundHooks:app,onSnapshot:()=>{}});
    let auth=await openAuth();
    try {
      queue.push(work("start",{skill:"principle-prove-it-works"}),{name:"skill_authoring_assess",arguments:{}},work("block",{note:"Wait for the next edit."}));
      await(await auth.submit("Improve the selected installed skill.", "initial")).wait(ctx); await auth.close();
      await writeFile(selected,"unchanged\n".repeat(200)+"one new rule\n");
      await writeFile(other,"unrelated\n".repeat(450));
      auth=await openAuth();
      queue.push(work("resume"),work("review"),work("block",{note:"Ready for independent review."}));
      await(await auth.submit("Continue. An unrelated path is " + other, "continuation")).wait(ctx);
      const entries=await auth.harness.commit(tx=>tx.scanEntries({conversationId:auth.conversation.id,order:"ascending"},160),ctx);
      const results=entries.items.flatMap(e=>e.model?.flatMap(m=>m.role==="toolResult" && m.toolName==="pstack_workflow"?m.content.flatMap(p=>p.type==="text"?[p.text]:[]):[])??[]);
      const evidence=results.map(t=>{try{return JSON.parse(t)}catch{return null}}).find(x=>x?.authoredSkills);
      assert(evidence,JSON.stringify(results).slice(-2000));assert.deepEqual(evidence.paths,[selected]);assert.equal(evidence.changedLines,1);
      assert.equal(evidence.largestCrossing,201);assert.deepEqual(evidence.reasons,["file crossed 200 lines"]);
      console.log("PASS assessed installed skill uses its pre-edit fingerprint after durable reopen; unrelated files stay out of review");
    } finally {await auth.close();}
  } finally { for (const [key,value] of Object.entries(originalEnv)) if(value===undefined) delete process.env[key]; else process.env[key]=value; }
} finally {
  if (sourceServer.listening) await new Promise<void>((resolve, reject) => sourceServer.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
await testInFlightOwners();
