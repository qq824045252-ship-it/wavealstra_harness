import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import { PSTACK_THERMOS_ID } from "../src/shared/mode-profile";
import { normalizePstackSettings, THERMOS_CRITERIA } from "../src/shared/pstack";
import { checkProviderRecovery, providerFixtureResponse } from "./pstack-provider-recovery-fixture";
import { assertTagCase, seedTagCase, tagCases, tagFixtureReply, tagPresetId } from "./coding-tag-fixture";

// Persisted sessions require both domain services and window-backed tools before opening.
const bootstrap = parse(readFileSync("src/main/index.ts", "utf8"), { sourceType: "module", plugins: ["typescript"] });
const startupBodies: import("@babel/types").Node[] = [];
traverseFast(bootstrap, node => {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.computed
    || node.callee.property.type !== "Identifier" || node.callee.property.name !== "then") return;
  const ready = node.callee.object;
  if (ready.type !== "CallExpression" || ready.callee.type !== "MemberExpression" || ready.callee.computed
    || ready.callee.object.type !== "Identifier" || ready.callee.object.name !== "app"
    || ready.callee.property.type !== "Identifier" || ready.callee.property.name !== "whenReady") return;
  const callback = node.arguments[0];
  if (callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression") startupBodies.push(callback.body);
});
assert.equal(startupBodies.length, 1, "one app-ready composition owns service startup");
const startupCalls = new Map<string, number[]>();
traverseFast(startupBodies[0]!, node => {
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "createWindow") {
    assert(typeof node.start === "number");
    startupCalls.set("createWindow", [...(startupCalls.get("createWindow") ?? []), node.start]);
  }
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && node.callee.object.type === "Identifier" && node.callee.property.type === "Identifier") {
    const key = `${node.callee.object.name}.${node.callee.property.name}`;
    assert.equal(typeof node.start, "number");
    startupCalls.set(key, [...(startupCalls.get(key) ?? []), node.start!]);
  }
});
function startupPosition(call: string): number {
  const positions = startupCalls.get(call) ?? [];
  assert.equal(positions.length, 1, `bootstrap must call ${call} exactly once`);
  return positions[0]!;
}
const initialization = startupPosition("agentService.init");
const recoveryStart = startupPosition("agentService.resumePersistedTasks");
const windowCreation = startupCalls.get("createWindow")?.[0];
assert(typeof windowCreation === "number", "bootstrap must create the window-backed tool hosts");
assert(initialization < windowCreation && windowCreation < recoveryStart,
  "initialize AgentService, attach the browser/UI hosts, then resume persisted tasks");
for (const retired of ["workNotificationHost.start", "agentService.setWorkNotificationWake", "agentService.setBotContinuationDelivery"]) {
  assert.equal(startupCalls.has(retired), false, `${retired} must not boot standalone Bot background services`);
}
for (const dependency of ["setSelectionContextResolver", "setArtifactDomain", "setGadgetDomain", "setLocalWorkflowServices"]) {
  assert(startupPosition(`agentService.${dependency}`) < initialization,
    `install ${dependency} before agentService.init()`);
}
for (const producer of ["cronService.start", "gatewayService.restoreChannels", "memoryGatewayController.start", "remoteAccessController.start"]) {
  // Memory Gateway may also be started later by an IPC handler; the last call is bootstrap.
  const position = startupCalls.get(producer)?.at(-1);
  assert(typeof position === "number" && position > recoveryStart, `${producer} must wait for persisted task recovery`);
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-local-workflow-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const config = join(root, ".mybuddy");
process.env.PI_CODING_AGENT_DIR = config;
mkdirSync(config, { recursive: true });
const requests: string[] = [];
const workflowCalls: [string, Record<string, unknown>][] = [
  ["read", { path: "check.cjs" }],
  ["pstack_workflow", { action: "start", playbook: "runtime-forensics" }],
  ["write", { path: "tested.txt", content: "verified\n" }],
  ...["capture", "reduce", "experiment", "source", "report"].map(stage =>
    ["pstack_workflow", { action: "advance", stage, note: "Inspected the isolated fixture and its check." }] as [string, Record<string, unknown>]),
  ["pstack_workflow", { action: "complete" }],
  ["pstack_workflow", { action: "verify", shell: process.platform === "win32" ? "powershell" : "bash", command: "node --test check.cjs" }],
  ["pstack_workflow", { action: "review" }],
  ["pstack_delegate", { purpose: "thermos", role: "interrogate-reviewers", tasks: ["Read tested.txt. RUN_THE_SHELL_YOURSELF to verify the project."] }],
  ["pstack_workflow", { action: "complete" }],
  ["pstack_delegate", { purpose: "thermos", role: "interrogate-reviewers", tasks: ["Recover the incomplete review."] }],
  ["pstack_workflow", { action: "complete" }],
];
let parentRounds = 0;
const orchestrationCalls: [string, Record<string, unknown>][] = [
  ["pstack_workflow", { action: "start", playbook: "orchestrate" }],
  ["pstack_orchestrate", { action: "unit", id: "parser", track: "core", brief: "Read tested.txt" }],
  ["pstack_orchestrate", { action: "unit", id: "client", brief: "Inspect a caller", dependencies: ["parser"] }],
  ["pstack_orchestrate", { action: "dispatch", id: "client", role: "how-explorer" }],
  ["pstack_orchestrate", { action: "dispatch", id: "parser", role: "how-explorer" }],
  ["pstack_workflow", { action: "verify", shell: process.platform === "win32" ? "powershell" : "bash", command: "node --test check.cjs" }],
  ["pstack_orchestrate", { action: "verify", id: "parser" }],
  ["pstack_orchestrate", { action: "drain" }],
  ["pstack_orchestrate", { action: "frontier", order: ["parser", "client"] }],
  ["pstack_orchestrate", { action: "status" }],
  ["pstack_workflow", { action: "block", note: "Waiting for the caller specification" }],
];
let orchRound = 0;
const reviewRounds = new Map<string, number>();
const acceptedDraft = "The first line of tested.txt contains verified.";
const draftReview = (answerDraft: string): [string, Record<string, unknown>] =>
  ["pstack_delegate",{purpose:"thermos",role:"interrogate-reviewers",tasks:["Check my explanation."],answerDraft}];
const draftStage = (role: string): [string, Record<string, unknown>] =>
  ["pstack_delegate",{purpose:"stage",role,tasks:["PSTACK_DRAFT_STAGE Read tested.txt and report the exact first line."]}];
const draftAdvance = (stage: string): [string, Record<string, unknown>] =>
  ["pstack_workflow",{action:"advance",stage,note:"Inspected tested.txt."}];
const draftCalls: [string, Record<string, unknown>][] = [
  ["pstack_workflow",{action:"start",playbook:"investigation"}],["read",{path:"tested.txt"}],
  ["write",{path:"forbidden.txt",content:"An explanation must preserve its source."}],
  draftStage("how-explorer"), draftAdvance("trace"), draftAdvance("scope"),
  draftStage("how-explainer"), draftAdvance("explain"), draftAdvance("edit"),
  draftReview("The first line contains red."), draftReview("The first line contains red."), ["pstack_workflow",{action:"complete"}],
  draftReview(acceptedDraft), ["pstack_workflow",{action:"complete"}],
];
let draftRound=0, draftReads=0, draftStageReads=0;
const interrogateShell = process.platform === "win32" ? "powershell" : "bash";
const interrogateCommand = "node --test check.cjs";
const interrogateCalls: [string, Record<string, unknown>][] = [
  ["pstack_workflow", {action:"status"}],
  ["pstack_workflow", {action:"skill",skill:"interrogate"}],
  ["pstack_workflow", {action:"start",skill:"interrogate"}],
  ["write", {path:"forbidden.txt",content:"Interrogate must preserve the reviewed source."}],
  ...["scope","intent"].map(stage => ["pstack_workflow", {action:"advance",stage,note:"Review the committed source with one isolated native probe."}] as [string,Record<string,unknown>]),
  ["pstack_delegate", {purpose:"stage",role:"interrogate-reviewers",tasks:["PSTACK_INTERROGATE_NO_THERMOS Execute node --test check.cjs in your isolated worktree. Report the actual probe and any demonstrated findings."]}],
  ...["panel","synthesize","judge"].map(stage => ["pstack_workflow", {action:"advance",stage,note:"The isolated native check passed; no confirmed defect was found in the tested behavior."}] as [string,Record<string,unknown>]),
  ["pstack_workflow", {action:"complete"}],
];
let interrogateRound=0;
const routerDisabledCalls: [string,Record<string,unknown>][] = [
  ["pstack_workflow",{action:"status"}],
  ["pstack_workflow",{action:"start",playbook:"auto"}],
  ["pstack_workflow",{action:"start",skill:"principle-prove-it-works"}],
  ["read",{path:"tested.txt"}],
  ["pstack_workflow",{action:"advance",stage:"apply",note:"Read the requested file with an explicitly selected method."}],
  ["pstack_workflow",{action:"complete"}],
];
let routerDisabledRound=0;
let quotaRound=0, billedCalls=0;
const quotaCalls: [string,Record<string,unknown>][] = [
  ["pstack_workflow",{action:"start",skill:"principle-prove-it-works"}],
  ["read",{path:"tested.txt"}],
  ["pstack_delegate",{purpose:"thermos",role:"interrogate-reviewers",tasks:["Inspect tested.txt."]}],
  ["pstack_workflow",{action:"resume"}],
  ["pstack_delegate",{purpose:"thermos",role:"interrogate-reviewers",tasks:["Try again."]}],
  ["pstack_workflow",{action:"status"}],
];
let recoveredRound=0;
const recoveredQuotaCalls: [string,Record<string,unknown>][] = [
  ["pstack_workflow",{action:"resume"}],
  ["pstack_delegate",{purpose:"thermos",role:"interrogate-reviewers",tasks:["Inspect tested.txt after the provider recovered."]}],
  ["pstack_workflow",{action:"advance",stage:"apply",note:"The same two configured reviewers inspected the file."}],
  ["pstack_workflow",{action:"complete"}],
];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  requests.push(raw);
  const body = JSON.parse(raw);
  let call: [string, Record<string, unknown>] | undefined;
  let callId = `call_${requests.length}`;
  let answer = "CRON_ACTUAL_OK";
  const fixture = providerFixtureResponse(raw, body.model);
  const tagCase = /CODING_TAG_CASE_([a-z-]+)/.exec(raw)?.[1];
  if (tagCase) {
    const reply = tagFixtureReply(tagCase, body);
    call = reply.call; answer = reply.answer;
  } else if (fixture) {
    if (fixture.quota) {
      response.writeHead(402,{"content-type":"application/json"});
      response.end(JSON.stringify({error:{code:"insufficient_balance",message:'Worker account exhausted: {"reset_at":"2026-12-01T00:00:00Z"}'}}));
      return;
    }
    call=fixture.call; answer=fixture.answer ?? "";
  } else if (raw.includes("PSTACK_QUOTA_CASE")) {
    const recovered=raw.includes("PSTACK_REVIEWER_RESTORED");
    if (body.model==="cron") call=recovered ? recoveredQuotaCalls[recoveredRound++] : quotaCalls[quotaRound++];
    else if (body.model==="reviewer-b" && !recovered) {
      billedCalls++;
      response.writeHead(402,{"content-type":"application/json"});
      response.end(JSON.stringify({error:{code:"insufficient_balance",message:'Model plan exhausted: {"reset_at":"2026-12-01T00:00:00Z"}'}}));
      return;
    } else if (!body.input.some((item:{type:string})=>item.type==="function_call_output")) call=["read",{path:"tested.txt"}];
    else answer=JSON.stringify({verdict:"pass",findings:[],checks:Object.fromEntries(THERMOS_CRITERIA.map(c=>[c.id,"Read line 1."]))});
  } else if (raw.includes("PSTACK_INTERROGATE_NO_THERMOS")) {
    if (body.model === "cron") {
      call=interrogateCalls[interrogateRound++];
      answer="Interrogate completed with actual isolated execution and no confirmed defects.";
    }
    else if (!body.input.some((item:{type:string}) => item.type === "function_call_output")) {
      call=[interrogateShell,{command:interrogateCommand}];
      callId="interrogate-native-probe";
    } else {
      const probe=body.input.findLast((item:{type:string;name?:string})=>item.type==="function_call" && item.name===interrogateShell);
      assert(probe,"The Interrogate verdict must identify its actual native call");
      answer=JSON.stringify({
        coverage:"Executed the committed check for tested.txt. Other behavior was not assessed.",
        probes:[{toolCallId:`${probe.call_id}|${probe.id}`,shell:interrogateShell,command:interrogateCommand}], findings:[],
      });
    }
  } else if (raw.includes("PSTACK_DISABLED_ROUTER")) {
    call=routerDisabledCalls[routerDisabledRound++];
    answer="Completed the explicitly chosen method while automatic task routing is disabled.";
  } else if (raw.includes("PSTACK_DRAFT_STAGE") && body.model !== "cron") {
    if (!body.input.some((item:{type:string}) => item.type === "function_call_output")) {
      call=["read",{path:"tested.txt"}]; draftStageReads++;
    }
    answer="Read tested.txt: its first line is verified.";
  } else if (raw.includes("PSTACK_DRAFT_CASE") && body.model !== "cron") {
    if (!body.input.some((item:{type:string}) => item.type === "function_call_output")) {
      call=["read",{path:"tested.txt"}]; draftReads++;
    }
    const good = raw.includes(acceptedDraft);
    answer=JSON.stringify({verdict:good?"pass":"revise",findings:good?[]:["The source does not contain red."],
      checks:Object.fromEntries(THERMOS_CRITERIA.map(c=>[c.id,"Read the actual first line of tested.txt."]))});
  } else if (raw.includes("PSTACK_DRAFT_CASE")) {
    call=draftCalls[draftRound++];
    answer="Substituted, unreviewed text.";
  } else if (body.model !== "cron") {
    const round = (reviewRounds.get(body.model) ?? 0) + 1;
    reviewRounds.set(body.model, round);
    if (round === 1 || (body.model === "reviewer-b" && round === 3)) call = ["read", { path: "tested.txt" }];
    answer = "## 结论\n\n已核对工作区与指定条件。\n\n" + JSON.stringify({ verdict: "pass", findings: [],
      checks: Object.fromEntries(THERMOS_CRITERIA.map(c => [c.id, "Inspected tested.txt line 1 and the single expected value."])) });
    if (body.model === "reviewer-b" && round === 2) answer = "I have read tested.txt and all criteria pass.";
  } else if (raw.includes("PSTACK_ORCH_RUN")) {
    call = orchestrationCalls[orchRound++];
    answer = "Waiting for the caller specification.";
  } else if (raw.includes("PSTACK_REQUIRED_GITHUB")) {
    const index = body.input.findLastIndex((item: { role?: string }) => item.role === "user" && JSON.stringify(item).includes("PSTACK_REQUIRED_GITHUB"));
    if (!body.input.slice(index + 1).some((item: { type?: string }) => item.type === "function_call_output"))
      call = ["pstack_workflow", { action: "start", playbook: "investigation" }];
  } else if (raw.includes("PSTACK_NATIVE_RUN") && !raw.includes("ORDINARY_AFTER_PSTACK")) {
    // Yield once after opting into the workflow, before producing any verification evidence.
    const round = parentRounds++;
    if (round !== 2) call = workflowCalls[round < 2 ? round : round - 1];
    answer = round === 2 ? "已经完成。" : "PSTACK_VERIFIED";
  }
  const item = call
    ? { type: "function_call", id: `fc_${requests.length}`, call_id: callId, name: call[0], arguments: JSON.stringify(call[1]) }
    : { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, model: body.model, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const modelIds = ["cron", "excluded", "reviewer-a", "reviewer-b", "observer", "gpt-author", "claude-observer"];
writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", models: modelIds.map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "cron", enabledModels: modelIds.map(id => "fixture/" + id), permissionMode: "auto", memoryEnabled: false, conversationGoalContinuationEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));
writeFileSync(join(config, "subagent.json"), JSON.stringify({ roles: { diverse: ["fixture/excluded", "fixture/reviewer-a", "fixture/reviewer-b"] } }));
writeFileSync(join(config, "auth.json"), "{}");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AgentService } = await import("../src/main/agent/AgentService");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { CronService } = await import("../src/main/cron/CronService");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const { registerLocalWorkflowTools } = await import("../src/main/capabilities/local-workflow-extension");
type ExtensionAPI = import("@earendil-works/pi-coding-agent").ExtensionAPI;
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const db = new AppDatabase(join(root, "app.db"));
const workspaces = new TaskExecutionWorkspace(join(root, "workspaces"));
const taskRoot = workspaces.ensureTaskExecutionWorkspace("scheduled");
const runtime = await ModelRuntime.create({ authPath: join(config, "auth.json"), modelsPath: join(config, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
const agent = new AgentService(db, workspaces, { models: runtime });
const host = new TerminalHost({ resolveCwd: () => root });
const terminal = new TaskTerminalService(host);
const cron = new CronService(db, agent);
agent.setLocalWorkflowServices({ cron, terminal });
await agent.init();
await agent.resumePersistedTasks();
let permission: "auto" | "readonly" = "auto";
const tools = new Map<string, Tool>();
const api: Pick<ExtensionAPI, "registerTool"> = { registerTool: tool => { tools.set(tool.name, tool); } };
registerLocalWorkflowTools(api, { taskId: "scheduled", taskRoot, services: { cron, terminal, getPermissionMode: () => permission }, terminalEnabled: true });
const invoke = async (action: Record<string, unknown>) => tools.get("automation_exec")!.execute("fixture", action, new AbortController().signal, undefined, {} as never);
try {
  assert.deepEqual([...tools.keys()], ["automation_exec", "terminal_exec"]);
  db.upsertTask({ id: "scheduled", title: "Preserved task", cwd: taskRoot, modelId: "fixture/cron", permissionMode: "auto", welcomeMode: "working", updatedAt: 1 });
  const create = { action: "create", name: "Actual AgentService", prompt: "CRON_INTEGRATION_REQUEST", schedule_type: "at", schedule_expr: new Date(Date.now() + 800).toISOString(), target: "current-task", max_runs: 1 };
  permission = "readonly";
  const created = await invoke(create);
  assert.notEqual(created.isError, true, JSON.stringify(created));
  const deadline = Date.now() + 25000;
  let run = db.listCronRuns()[0];
  while (!run || run.status === "running") {
    assert.ok(Date.now() < deadline, "real scheduled AgentService did not finish");
    await delay(50);
    run = db.listCronRuns()[0];
  }
  assert.equal(run.status, "success", JSON.stringify(run));
  assert.equal(run.taskId, "scheduled");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes("CRON_INTEGRATION_REQUEST"));
  assert.ok(requests[0].includes("automation_exec"), "real session must advertise scheduler tool");
  assert.ok(requests[0].includes("terminal_exec"), "real session must advertise terminal tool");
  const history = await agent.loadTaskHistory("scheduled");
  assert.ok(history.messages.some(message => message.role === "assistant" && message.text.includes("CRON_ACTUAL_OK")));
  assert.equal(db.getTask("scheduled")?.cwd, taskRoot);
  assert.equal(db.getTask("scheduled")?.permissionMode, "auto");
  assert.equal(db.getCronJob(run.jobId)?.enabled, false);
  assert.equal((await invoke({ action: "runs" })).isError, undefined);
  console.log("PASS registered workflow tools + real timer + AgentService + Pi session + local HTTP model + persisted task output; no production credentials");

  const coding = agent.getModeProfile("coding");
  assert(!coding.policy.presets?.some(tag => tag.id === PSTACK_THERMOS_ID));
  assert(!requests[0].includes("pstack_workflow"));
  const modePrompt = (mode: "coding" | "working" | "general", tag?: string) =>
    agent.assembleModePreview({ welcomeMode: mode, modePresetId: tag }).appendParts.join("\n");
  assert(!modePrompt("coding", "bugfix-test").includes("pstack_workflow"));
  const legacy = { id: "pstack-thermos", label: "个人流程", promptAddon: "personal recipe" };
  const flow = normalizePstackSettings(undefined);
  flow.thermos.reviewerRole = "interrogate-reviewers";
  flow.roles["interrogate-reviewers"] = { ...flow.roles["interrogate-reviewers"], model: "diverse", count: 2, isolation: "shared" };
  flow.skills["setup-pstack"].parameters.excludeModels = "fixture/excluded";
  flow.roles["how-explorer"].model = "fixture/observer";
  agent.saveModePolicy("coding", { ...coding.policy, presets: [...coding.policy.presets ?? [], legacy], pstackThermosEnabled: true, pstackThermos: flow });
  assert(!agent.getModeProfile("coding").policy.presets?.some(tag => tag.id === PSTACK_THERMOS_ID));
  assert.equal(agent.getModeProfile("coding").policy.presets?.find(tag => tag.id === legacy.id)?.promptAddon, legacy.promptAddon);
  for (const tag of [undefined, ...agent.getModeProfile("coding").policy.presets!.map(p => p.id), PSTACK_THERMOS_ID]) {
    const prompt=modePrompt("coding", tag);
    assert.match(prompt, /按用户目标和任务复杂度自行决定是否使用可选工作流/);
    assert(prompt.includes("pstack_workflow status") && prompt.includes("路由指引本身不启动流程"),
      "Coding mode exposes optional poteto routing without starting a workflow: " + tag);
    assert(prompt.includes("普通交流及只需阅读代码的解释继续直接回答"), "Ordinary conversation retains its direct path: " + tag);
  }
  assert(modePrompt("coding", legacy.id).includes(legacy.promptAddon));
  assert(!modePrompt("working", PSTACK_THERMOS_ID).includes("pstack_workflow"));
  assert(!modePrompt("general", "native").includes("pstack_workflow"));
  const selected = { welcomeMode: "coding" as const, modePresetId: "minimal" };
  assert(!agent.assembleModePreview(selected).skillFilter.visible.includes(PSTACK_THERMOS_ID));
  const request = { ...selected, taskId: "pstack", modelId: "fixture/cron", text: "PSTACK_NATIVE_RUN 修复本地测试样例，严格看下质量，先不要合并",
    userMessageId: "pstack-input", assistantMessageId: "pstack-output" };
  db.upsertTask({ id: request.taskId, title: "Workflow", ...selected, modelId: request.modelId, updatedAt: 1 });
  const workflowRoot = workspaces.ensureTaskExecutionWorkspace(request.taskId);
  writeFileSync(join(workflowRoot, "check.cjs"), "const assert = require('node:assert/strict'); assert.equal(require('fs').readFileSync('tested.txt','utf8'), 'verified\\n'); console.log('HOST_RECEIPT_CHECK_PASSED');");
  const firstCodingRequest = requests.length;
  await agent.prompt(request, { durableAdmissionOnly: false });
  assert(requests[firstCodingRequest].includes("Optional pstack workflow") && requests[firstCodingRequest].includes("按本轮话语和对话上下文判断用户的意图"));
  assert(!requests[firstCodingRequest].includes("当前为「修 Bug」场景"), "A selected playbook does not depend on retired tag instructions");
  assert.equal(parentRounds, workflowCalls.length + 2, "premature answer must trigger a continuation, then complete once");
  assert.deepEqual([...reviewRounds].sort(), [["reviewer-a", 2], ["reviewer-b", 4]], "only the reviewer without a machine-readable verdict must reread and correct its own receipt");
  for (const raw of requests.filter(raw => JSON.parse(raw).model !== "cron")) {
    assert.deepEqual(JSON.parse(raw).tools.map((t: { name: string }) => t.name).sort(), ["find", "grep", "ls", "read"]);
    assert(raw.includes("HOST_RECEIPT_CHECK_PASSED") && raw.includes("node --test check.cjs") && raw.includes("exitCode"), "Reviewers need the actual matched shell output.");
    assert(!raw.includes("RUN_THE_SHELL_YOURSELF"), "The parent cannot assign shell execution to a read-only reviewer.");
  }
  assert.equal(readFileSync(join(workflowRoot, "tested.txt"), "utf8"), "verified\n");
  const toolOutputs = requests.flatMap(raw => JSON.parse(raw).input ?? []).filter(item => item.type === "function_call_output").map(item => JSON.stringify(item.output));
  assert(toolOutputs.some(s => s.includes("Independent Thermos review required")));
  assert(toolOutputs.some(s => s.includes("user requested review")) && !toolOutputs.some(s => s.includes("pre-merge review")));
  const observedTools = [...new Set(toolOutputs)].map(s => s.slice(0, 300));
  assert(toolOutputs.some(s => s.includes("fixture/reviewer") && s.includes("fingerprint")), `Missing the final review and check. Actual tool results: ${observedTools.join("\n")}`);
  const orchRoot = workspaces.ensureTaskExecutionWorkspace("pstack-orch");
  writeFileSync(join(orchRoot, "tested.txt"), "verified\n");
  writeFileSync(join(orchRoot, "check.cjs"), readFileSync(join(workflowRoot, "check.cjs")));
  db.upsertTask({ id: "pstack-orch", title: "Orchestration", welcomeMode: "coding", modelId: request.modelId, updatedAt: 1 });
  const git = (...args: string[]) => execFileSync("git", ["-C", orchRoot, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q", "-b", "goal-board");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "orchestration baseline");
  const boardSha = git("rev-parse", "HEAD");
  const verifyUnit = orchestrationCalls.find(([tool, args]) => tool === "pstack_orchestrate" && args.action === "verify");
  assert(verifyUnit);
  Object.assign(verifyUnit[1], { sha: boardSha, branch: "goal-board" });
  const goal = await agent.createConversationGoal({ taskId: "pstack-orch", title: "Verify the parser work unit", criteria: [{ text: "A native project check verified the parser." }] });
  assert(goal.ok, JSON.stringify(goal));
  const startOrch = requests.length;
  await agent.prompt({ ...request, modePresetId: null, taskId: "pstack-orch", text: "PSTACK_ORCH_RUN 编排两个任务", userMessageId: "orch-input", assistantMessageId: "orch-output" }, { durableAdmissionOnly: false });
  const orchResults: string[] = requests.slice(startOrch).flatMap(raw => JSON.parse(raw).input ?? [])
    .filter(item => item.type === "function_call_output").map(item => item.output);
  assert(orchResults.some(s => s.includes("Unit prerequisites are unverified")), "dependent unit must not start early");
  const board = orchResults.map(s => { try { return JSON.parse(s); } catch { return null; } }).find(value => value?.order?.length && value.units);
  assert.deepEqual(board?.units.map((u: { id: string; status: string }) => [u.id, u.status]), [["parser", "verified"], ["client", "pending"]], orchResults.map(s => String(s).slice(0, 180)).join("\n"));
  assert.deepEqual(board.order, ["parser", "client"]); assert.deepEqual(board.inbox, []);
  assert.equal(reviewRounds.get("observer"), 2);
  const beforeClose = (await agent.getConversationGoalEvidence("pstack-orch", goal.goal.id))?.activity?.nativeEvidence;
  assert(beforeClose, "Goal's exact generation owns native orchestration evidence");
  const units = beforeClose.filter(row => row.kind === "unit");
  assert.deepEqual(units.map(row => [row.unitId, row.state]), [["parser", "running"], ["parser", "returned"], ["parser", "verified"]]);
  const verified = units.at(-1);
  assert.equal(verified?.branch, "goal-board");
  assert.equal(verified?.sha, boardSha);
  assert.equal(verified?.command, "node --test check.cjs");
  assert.equal(verified?.fingerprint, beforeClose.find(row => row.kind === "check")?.fingerprint);
  assert.equal(agent.cancelConversationGoal(goal.goal.id, "pstack-orch").ok, true);
  const replacement = await agent.createConversationGoal({ taskId: "pstack-orch", title: "An unrelated future goal" });
  assert(replacement.ok);
  await agent.releaseDurableTask("pstack-orch");
  assert.deepEqual((await agent.getConversationGoalEvidence("pstack-orch", goal.goal.id))?.activity?.nativeEvidence, beforeClose);
  assert.deepEqual((await agent.getConversationGoalEvidence("pstack-orch", replacement.goal.id))?.activity?.nativeEvidence, []);
  console.log("PASS native orchestration dependency, real nested child, unit verification, inbox drain and ordered frontier");
  const draftFlow=structuredClone(flow);
  for(const method of ["how","why","unslop"]) draftFlow.skills[method].enabled=false;
  draftFlow.roles["how-explainer"].model="fixture/observer";
  agent.saveModePolicy("coding",{...agent.getModeProfile("coding").policy,pstackThermos:draftFlow});
  const draftRoot=workspaces.ensureTaskExecutionWorkspace("draft");
  writeFileSync(join(draftRoot,"tested.txt"),"verified\n");
  db.upsertTask({id:"draft",title:"Reviewed answer",...selected,modelId:request.modelId,updatedAt:1});
  const beforeDraft=requests.length;
  await agent.prompt({...request,taskId:"draft",text:"PSTACK_DRAFT_CASE Use investigation to explain tested.txt without changing files. 请独立审查结论。",userMessageId:"draft-in",assistantMessageId:"draft-out"},{durableAdmissionOnly:false});
  assert.equal(draftReads,4,"Each of two different drafts must get two independent file reads. Repeating a rejected draft must reuse its verdict.");
  assert.equal(draftStageReads,2,"The direct investigation stages require their own actual read-only worker receipts.");
  const draftDb=new DatabaseSync(join(config,"durable",createHash("sha256").update("draft").digest("hex"),"durable.sqlite"),{readOnly:true});
  try {
    const rows=draftDb.prepare("SELECT record FROM entries WHERE conversation_id=(SELECT MIN(id) FROM conversations) ORDER BY id DESC").all();
    const final=rows.flatMap(r=>JSON.parse(String(r.record)).model??[]).find(m=>m.role==="assistant"&&m.stopReason==="stop");
    const userText=final?.content.filter((p:{type:string})=>p.type==="text").map((p:{text:string})=>p.text).join("");
    assert(userText?.startsWith(acceptedDraft) && !userText.includes("Substituted"),userText);
  } finally {draftDb.close();}
  assert.equal(readFileSync(join(draftRoot,"tested.txt"),"utf8"),"verified\n");
  assert.equal(existsSync(join(draftRoot,"forbidden.txt")),false,"The explicit investigation route preserves source under the minimal tag");
  assert(requests.slice(beforeDraft).some(raw => raw.includes("This method is read-only")),"The selected investigation method enforces its own write boundary");
  console.log("PASS read-only investigation revised and delivered its exact approved answer after independent rejection");
  const quotaRoot=workspaces.ensureTaskExecutionWorkspace("quota");
  writeFileSync(join(quotaRoot,"tested.txt"),"verified\n");
  db.upsertTask({id:"quota",title:"Reviewer provider quota",welcomeMode:"coding",modePresetId:legacy.id,modelId:request.modelId,updatedAt:1});
  const beforeQuota=requests.length;
  await agent.prompt({...request,modePresetId:legacy.id,taskId:"quota",text:"PSTACK_QUOTA_CASE Review tested.txt. 请独立审查。",userMessageId:"quota-in",assistantMessageId:"quota-out"},{durableAdmissionOnly:false});
  assert(requests[beforeQuota].includes(legacy.promptAddon) && requests[beforeQuota].includes("Optional pstack workflow"));
  const dependency=requests.slice(beforeQuota).flatMap(raw=>JSON.parse(raw).input ?? []).filter(i=>i.type==="function_call_output")
    .map(i=>{try{return JSON.parse(i.output);}catch{return null;}}).find(i=>i?.reviewDependency);
  assert.equal(dependency?.phase,"blocked");
  assert.equal(dependency.reviewDependency.failures.length,1);
  assert.equal(dependency.reviewDependency.failures[0].model,"fixture/reviewer-b");
  assert.equal(dependency.reviewDependency.failures[0].resetAt,"2026-12-01T00:00:00Z",dependency.reviewDependency.failures[0].error);
  assert(dependency.reviewDependency.failures[0].child && dependency.reviewDependency.toolTaskId);
  const observedQuotaOutputs=requests.slice(beforeQuota).filter(raw=>JSON.parse(raw).model==="cron").flatMap(raw=>JSON.parse(raw).input ?? [])
    .filter(item=>item.type==="function_call_output").map(item=>String(item.output));
  assert(observedQuotaOutputs.some(text=>text.includes("待服务恢复后可在新消息中继续")),observedQuotaOutputs.map(s=>s.slice(0,180)).join("\n"));
  assert.equal(billedCalls,1,"Same user turn must not re-dispatch a panel with a known HTTP 402");
  const initialObservations = requests.length;
  await agent.prompt({...request,modePresetId:"minimal",taskId:"quota",text:"PSTACK_QUOTA_CASE PSTACK_REVIEWER_RESTORED. The provider is available. Resume the same review of tested.txt.",
    userMessageId:"quota-new-in",assistantMessageId:"quota-new-out"},{durableAdmissionOnly:false});
  const resumed = requests.slice(initialObservations).filter(raw=>JSON.parse(raw).model==="cron").flatMap(raw=>JSON.parse(raw).input ?? [])
    .filter(item=>item.type==="function_call_output").map(item=>{try{return JSON.parse(item.output);}catch{return null;}})
    .find(item=>item?.phase==="complete");
  assert.equal(resumed?.review?.passed,true);
  assert.equal(resumed.reviewDependency,undefined);
  assert.deepEqual(resumed.review.receipt.models.slice().sort(),["fixture/reviewer-a","fixture/reviewer-b"]);
  assert.equal(billedCalls,1);
  console.log("PASS independent reviewer HTTP 402, actual failing model and reset time persist; no repeated dispatch");
  const roleFlow=structuredClone(flow);
  for (const role of ["how-explorer","how-explainer","judgment"]) roleFlow.roles[role]={...roleFlow.roles[role],model:"fixture/observer",count:1};
  roleFlow.roles.judgment.model="fixture/claude-observer";
  roleFlow.playbooks.orchestrate.parameters.retryLimit=0;
  agent.saveModePolicy("coding",{...agent.getModeProfile("coding").policy,pstackThermos:roleFlow});
  await checkProviderRecovery(async (taskId,text,initial)=>{
    const modelId=taskId==="UNIT_PROVIDER_DECISIONS" ? "fixture/gpt-author" : request.modelId;
    if (initial) {
      const cwd=workspaces.ensureTaskExecutionWorkspace(taskId);
      writeFileSync(join(cwd,"tested.txt"),"verified\n");
      db.upsertTask({id:taskId,title:taskId,cwd,...selected,modelId,updatedAt:1});
    }
    const begin=requests.length;
    await agent.prompt({...request,taskId,text,modelId,userMessageId:taskId+"-in-"+initial,assistantMessageId:taskId+"-out-"+initial},{durableAdmissionOnly:false});
    return requests.slice(begin).filter(raw=>JSON.parse(raw).model===modelId.split("/").at(-1)).flatMap(raw=>JSON.parse(raw).input ?? [])
      .filter(item=>item.type==="function_call_output").flatMap(item=>{try{return [JSON.parse(item.output)];}catch{return [];}});
  },async()=>{await agent.releaseDurableTask("UNIT_PROVIDER_BOARD");});
  console.log("PASS stage and decision provider failures, atomic owner failure receipt, durable reopen and same-unit retry with zero internal retry budget");
  const tagFlow = normalizePstackSettings(undefined);
  for (const role of Object.values(tagFlow.roles)) Object.assign(role,{ model:"fixture/observer", count:1, isolation:"shared" });
  const presetFile = process.env.MYBUDDY_CODING_TAGS_FIXTURE;
  const tagPresets = presetFile ? JSON.parse(readFileSync(presetFile, "utf8")) : coding.policy.presets ?? [];
  const customRoute = { id:"custom-route", label:"Custom route fixture", pstackRoute:"feature", promptAddon:"Use the saved custom coding guidance." };
  const noThermosFlow=structuredClone(tagFlow);
  noThermosFlow.skills["thermo-nuclear-code-quality-review"].enabled=false;
  agent.saveModePolicy("coding",{...agent.getModeProfile("coding").policy,presets:[...tagPresets,legacy,customRoute],pstackThermos:noThermosFlow});
  const explicitReviewTask="interrogate-without-thermos", explicitReviewRoot=workspaces.ensureTaskExecutionWorkspace(explicitReviewTask);
  writeFileSync(join(explicitReviewRoot,"tested.txt"),"verified\n");
  writeFileSync(join(explicitReviewRoot,"check.cjs"),readFileSync(join(workflowRoot,"check.cjs")));
  const interrogateGit=(...args:string[])=>execFileSync("git",["-C",explicitReviewRoot,...args],{encoding:"utf8",windowsHide:true}).trim();
  interrogateGit("init","-q","-b","main"); interrogateGit("add",".");
  interrogateGit("-c","user.name=fixture","-c","user.email=fixture@invalid","commit","-qm","independent interrogate baseline");
  db.upsertTask({id:explicitReviewTask,title:"Interrogate with Thermos independently disabled",cwd:explicitReviewRoot,
    ...selected,modelId:request.modelId,updatedAt:1});
  const explicitReviewStart=requests.length;
  await agent.prompt({...request,taskId:explicitReviewTask,text:"PSTACK_INTERROGATE_NO_THERMOS Use interrogate to check tested.txt with actual isolated probes; report findings without changing reviewed source.",
    userMessageId:"interrogate-no-thermos-in",assistantMessageId:"interrogate-no-thermos-out"},{durableAdmissionOnly:false});
  const explicitReviewBodies=requests.slice(explicitReviewStart).map(raw=>JSON.parse(raw));
  const explicitReviewOutputs=explicitReviewBodies.filter(body=>body.model==="cron").flatMap(body=>body.input ?? [])
    .filter(item=>item.type==="function_call_output").map(item=>{try{return JSON.parse(item.output);}catch{return String(item.output);}});
  const idle=explicitReviewOutputs.find(output=>output?.phase==="idle");
  assert(idle.skills.includes("interrogate") && !idle.skills.includes("thermo-nuclear-code-quality-review"));
  const interrogated=explicitReviewOutputs.find(output=>output?.phase==="complete");
  assert.equal(interrogated?.playbook,"skill:interrogate",JSON.stringify(explicitReviewOutputs.at(-1)));
  assert.equal(interrogated.review,null);
  assert.match(interrogated.thermosOutcome,/已关闭/);
  const panel=interrogated.delegates.find((receipt:{stageId:string})=>receipt.stageId==="panel");
  assert.equal(panel.interrogate.reviewers.length,1);
  const reviewer=panel.interrogate.reviewers[0];
  assert.equal(reviewer.workspace.kind,"worktree");
  assert.equal(reviewer.probes.length,1);
  assert.equal(reviewer.probes[0].command,interrogateCommand);
  assert.equal(reviewer.probes[0].exitCode,0);
  assert.match(reviewer.probes[0].executionId,/./);
  assert.deepEqual(reviewer.findings,[]);
  assert(explicitReviewBodies.some(body=>body.model==="observer" && body.tools.some((tool:{name:string})=>tool.name===interrogateShell)),
    "Interrogate retains native execution tools after Thermos is disabled");
  assert.equal(existsSync(join(explicitReviewRoot,"forbidden.txt")),false);
  assert.equal(readFileSync(join(explicitReviewRoot,"tested.txt"),"utf8"),"verified\n");
  assert.equal(interrogateGit("status","--porcelain"),"");
  await agent.releaseDurableTask(explicitReviewTask);
  console.log("PASS Thermos disabled independently while explicit Interrogate completes from a real isolated native probe");
  agent.saveModePolicy("coding",{...agent.getModeProfile("coding").policy,presets:[...tagPresets,legacy,customRoute],pstackThermos:tagFlow});
  assert(!agent.getModeProfile("coding").policy.presets?.some(preset=>
    ["bugfix-test","refactor","add-tests","feature-dev","code-review","plan-design","readonly-explain"].includes(preset.id)));
  assert.equal(agent.getModeProfile("coding").policy.presets?.find(preset=>preset.id===customRoute.id)?.promptAddon,customRoute.promptAddon);
  for (const [id, preferred] of tagCases) {
    const taskId = "tag-" + id, cwd = workspaces.ensureTaskExecutionWorkspace(taskId);
    const modePresetId=tagPresetId(id);
    seedTagCase(id,cwd);
    if (id === "web-html" && process.env.MYBUDDY_TAG_HTML_GUIDE)
      writeFileSync(join(cwd,"dialog-guide.md"),readFileSync(process.env.MYBUDDY_TAG_HTML_GUIDE));
    db.upsertTask({ id:taskId, title:id, cwd, ...selected, modePresetId, modelId:request.modelId, updatedAt:1 });
    const begin = requests.length;
    const text = "CODING_TAG_CASE_" + id + (id === "thermos-review" ? " Use Thermos to report defects in value.cjs without fixing them." : " Apply and verify the requested fixture change.");
    await agent.prompt({...request,modePresetId,taskId,text,userMessageId:taskId+"-in",assistantMessageId:taskId+"-out"},{durableAdmissionOnly:false});
    const savedRoute=agent.getModeProfile("coding").policy.presets?.find(preset=>preset.id===modePresetId)?.pstackRoute;
    assertTagCase(id,savedRoute ?? preferred,cwd,requests.slice(begin));
    if (id === "web-html" && process.env.MYBUDDY_TAG_HTML_OUTPUT)
      writeFileSync(process.env.MYBUDDY_TAG_HTML_OUTPUT,readFileSync(join(cwd,"index.html")));
    await agent.releaseDurableTask(taskId);
  }
  agent.saveModePolicy("coding", { ...agent.getModeProfile("coding").policy, pstackThermosEnabled: false });
  assert(!agent.assembleModePreview(selected).skillFilter.visible.includes(PSTACK_THERMOS_ID));
  assert.equal(agent.getModeProfile("coding").policy.presets?.find(tag => tag.id === legacy.id)?.promptAddon, legacy.promptAddon);
  const count = requests.length;
  assert(!modePrompt("coding", selected.modePresetId).includes("pstack_workflow"));
  await agent.prompt({ ...request, text: "ORDINARY_AFTER_PSTACK",
    userMessageId: "ordinary-after", assistantMessageId: "ordinary-answer" }, { durableAdmissionOnly: false });
  assert.equal(requests.length, count + 1, "a normal turn after disabling must settle without workflow gates");
  assert(!JSON.parse(requests.at(-1)!).tools.some((t: {name: string}) => t.name.startsWith("pstack_")));
  flow.skills["poteto-mode"].parameters.githubBinding = "required";
  agent.saveModePolicy("coding", { ...agent.getModeProfile("coding").policy, pstackThermosEnabled: true, pstackThermos: flow });
  const ordinaryWithMissingGithub = requests.length;
  await agent.prompt({ ...request, text: "ORDINARY_AFTER_PSTACK Hello.", userMessageId: "github-setting-greeting",
    assistantMessageId: "github-setting-greeting-answer" }, { durableAdmissionOnly: false });
  assert.equal(requests.length, ordinaryWithMissingGithub + 1, "GitHub is only required if the model calls pstack");
  assert(JSON.parse(requests.at(-1)!).tools.some((t: {name: string}) => t.name === "pstack_workflow"));
  for (const modePresetId of [null, selected.modePresetId, legacy.id]) {
    const taskId = "github-required-" + modePresetId;
    db.upsertTask({ id: taskId, title: "Optional workflow", welcomeMode: "coding", modePresetId, modelId: request.modelId, updatedAt: 1 });
    const start = requests.length;
    await agent.prompt({ ...request, taskId, modePresetId, text: "PSTACK_REQUIRED_GITHUB Start an investigation.",
      userMessageId: taskId + "-input", assistantMessageId: taskId + "-output" }, { durableAdmissionOnly: false });
    assert.equal(requests.length, start + 2);
    assert(JSON.parse(requests.at(-1)!).input.some((item: {type: string; output?: unknown}) =>
      item.type === "function_call_output" && String(item.output).includes("要求 GitHub MCP")));
  }
  const routerDisabledFlow=structuredClone(flow);
  routerDisabledFlow.skills["poteto-mode"].enabled=false;
  routerDisabledFlow.skills["poteto-mode"].parameters.preferredPlaybook="feature";
  agent.saveModePolicy("coding",{...agent.getModeProfile("coding").policy,pstackThermos:routerDisabledFlow});
  assert(!modePrompt("coding","minimal").includes("已启用 poteto 任务路由"),"A disabled router is not advertised in the system instructions");
  const routerDisabledTask="disabled-poteto", routerDisabledRoot=workspaces.ensureTaskExecutionWorkspace(routerDisabledTask);
  writeFileSync(join(routerDisabledRoot,"tested.txt"),"verified\n");
  db.upsertTask({id:routerDisabledTask,title:"Explicit method with poteto disabled",cwd:routerDisabledRoot,...selected,modelId:request.modelId,updatedAt:1});
  const routerDisabledStart=requests.length;
  await agent.prompt({...request,taskId:routerDisabledTask,text:"PSTACK_DISABLED_ROUTER Read tested.txt with the explicitly chosen principle-prove-it-works method.",
    userMessageId:"disabled-router-in",assistantMessageId:"disabled-router-out"},{durableAdmissionOnly:false});
  const disabledRouterBodies=requests.slice(routerDisabledStart).map(raw=>JSON.parse(raw));
  const disabledRouterOutputs=disabledRouterBodies.flatMap(body=>body.input ?? []).filter(item=>item.type==="function_call_output")
    .map(item=>{try{return JSON.parse(item.output);}catch{return String(item.output);}});
  const disabledIdle=disabledRouterOutputs.find(output=>output?.phase==="idle");
  assert.equal(disabledIdle.router,null);
  assert.notEqual(disabledIdle.preferredPlaybook,"feature","A disabled router does not impose its saved default playbook");
  assert(disabledRouterOutputs.some(output=>typeof output==="string" && /poteto-mode/i.test(output) && /disabled|关闭/i.test(output)),
    "An automatic route request explains that poteto is disabled");
  assert(disabledRouterOutputs.some(output=>output?.phase==="complete" && output.playbook==="skill:principle-prove-it-works"),
    "Other enabled methods remain directly usable; disabled poteto does not impose its saved required GitHub binding");
  await agent.releaseDurableTask(routerDisabledTask);
  console.log("PASS optional workflows, native review, same-task disable, GitHub checked after opt-in, and independent poteto routing disable");
} finally {
  cron.stop();
  await agent.abort("scheduled");
  await agent.closeDurableBots();
  agent.dispose();
  host.dispose();
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
