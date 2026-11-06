import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";

// init() opens persisted Durable sessions, so bootstrap ordering is an execution contract.
const bootstrap = parse(readFileSync("src/main/index.ts", "utf8"), { sourceType: "module", plugins: ["typescript"] });
const startupCalls = new Map<string, number[]>();
traverseFast(bootstrap, node => {
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
const recoveryStart = startupPosition("agentService.init");
for (const dependency of ["setSelectionContextResolver", "setArtifactDomain", "setGadgetDomain", "setLocalWorkflowServices"]) {
  assert(startupPosition(`agentService.${dependency}`) < recoveryStart,
    `install ${dependency} before agentService.init(): persisted subagents require the complete tool registry`);
}
for (const producer of ["cronService.start", "gatewayService.restoreChannels"]) {
  assert(startupPosition(producer) > recoveryStart, `${producer} must wait for AgentService initialization`);
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-local-workflow-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const config = join(root, ".mybuddy");
process.env.PI_CODING_AGENT_DIR = config;
mkdirSync(config, { recursive: true });
const requests: string[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(Buffer.concat(chunks).toString());
  const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "CRON_ACTUAL_OK", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, model: "cron", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", models: [{ id: "cron", name: "Cron fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "cron", enabledModels: ["fixture/cron"], permissionMode: "auto", memoryEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));
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
  assert.equal((await invoke(create)).isError, true);
  assert.equal(db.listCronJobs().length, 0);
  permission = "auto";
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
} finally {
  cron.stop();
  await agent.abort("scheduled");
  agent.dispose();
  host.dispose();
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
