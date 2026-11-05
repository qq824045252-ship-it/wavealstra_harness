import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createDurableConsultSession, createDurableConsultToolHooks, runDurableMultiModelConsult } from "../src/main/agent/durable/DurableConsultSession";
import { withDurableExecution } from "../src/main/agent/durable/DurableExecutionContext";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import type { MultiModelConsultConfig, MultiModelConsultReport } from "../src/shared/multi-model-consult";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-consult-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace"), directory = join(root, "state");
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir); await mkdir(cwd); await writeFile(join(cwd, "proof.txt"), "read evidence");
let allowFinal = false, forceBudget = false, reads = 0;
let serverError: unknown;
const paused = new Set<string>();
let reached: (() => void) | undefined;
const allPaused = new Promise<void>(resolve => { reached = resolve; });
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = JSON.parse(text);
    assert(body && typeof body === "object" && "model" in body && typeof body.model === "string");
    const returned = text.includes("function_call_output");
    if (body.model !== "parent") {
      const names = "tools" in body && Array.isArray(body.tools) ? body.tools.map(tool => String(tool.name)) : [];
      assert.deepEqual(names, ["read"], "consultation must inherit only its declared read tools");
      if (returned && !allowFinal) { paused.add(body.model); if (paused.size === 2) reached?.(); return; }
    }
    const callNumber = (text.match(/function_call_output/g) ?? []).length + 1;
    const output = body.model === "parent" && !returned
      ? [{ type: "function_call", id: "fc_consult", call_id: "consult_call", name: "consult", arguments: "{}" }]
      : body.model !== "parent" && (!returned || forceBudget)
        ? [{ type: "function_call", id: `fc_read_${callNumber}`, call_id: `read_${callNumber}`, name: "read", arguments: JSON.stringify({ path: "proof.txt" }) }]
        : [{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: `${body.model} answer`, annotations: [] }] }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of output) for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Date.now()}`, model: body.model, status: "completed", output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch (error) { serverError = error; response.writeHead(500).end("{}"); }
});
let harness: Harness | undefined;
try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  const models = ["parent", "analyst", "reviewer"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-only", models } } }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "parent", enabledModels: ["fixture/parent", "fixture/analyst", "fixture/reviewer"] }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  await runtime.getAvailable();
  const settings = SettingsManager.create(cwd, agentDir);
  const policy = new TaskFileAccessPolicy({ taskId: "consult-task", taskRoot: cwd });
  let config: MultiModelConsultConfig = { enabled: true, participants: [{ modelId: "fixture/analyst" }, { modelId: "fixture/reviewer" }], maxParallel: 2, timeoutSeconds: 30, readProjectFiles: true, maxToolCalls: 1 };
  let report: MultiModelConsultReport | undefined;
  const open = async (store: string) => {
    const registry = createRegistry();
    const read = createReadTool();
    const consult = defineTool({ name: "consult", description: "Independent consultation", parameters: Type.Object({}), replay: "safe", execute: async (_args, native, context) => {
      report = await withDurableExecution({ native, context, cwd, runId: "consult-run", execution: { taskId: "consult-task", executionId: `call-${native.taskId}`, assistantMessageId: "parent" } },
        () => runDurableMultiModelConsult({ id: "consult-1", taskId: "consult-task", input: { task: "Read evidence and analyze" }, config, signal: context.abortSignal, onUpdate: update => { report = update; },
          createSession: (participant, signal, onToolLimit, stable) => createDurableConsultSession({ participant, signal, onToolLimit, cwd, agentDir, runtime,
            parentSettings: settings, policy, isEnabled: () => true, readProjectFiles: stable.readProjectFiles, maxToolCalls: stable.maxToolCalls, timeoutMs: stable.timeoutSeconds * 1000 }) }));
      context.abortSignal?.throwIfAborted();
      return { output: [{ type: "text", text: JSON.stringify(report) }], details: copyJson(report, { omitUndefinedProperties: true }) };
    } });
    registry.install(defineExtension({ name: "fixture", tools: [consult, { ...read, execute: async (...args: Parameters<typeof read.execute>) => { reads++; return read.execute(...args); } }],
      hooks: [hook(ToolTask, createDurableConsultToolHooks({ policy, isEnabled: () => true }))] }));
    return Harness.open(await openNodeJsonlStorage(store, ctx, { fsync: true }), { registry, models: runtime, env: () => new NodeExecutionEnv({ cwd }) }, ctx);
  };
  harness = await open(directory);
  let conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
  const submission = await conversation.submit({ type: "input", content: "consult", requestId: "root-consult" }, ctx);
  const wait = submission.wait(ctx).catch(() => undefined);
  await Promise.race([allPaused, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`consult children did not start: ${JSON.stringify(report)} ${String(serverError)}`)), 15_000).unref())]);
  assert.equal(reads, 2);
  await harness.close(ctx); await wait;
  config = { ...config, participants: [] };
  allowFinal = true;
  harness = await open(directory); conversation = await harness.root(ctx);
  assert.equal((await (await conversation.submit({ type: "input", content: "consult", requestId: "root-consult" }, ctx)).wait(ctx)).status, "done");
  assert.equal(report?.expected, 2, "recovery must use the committed participant selection");
  assert.equal(report?.succeeded, 2, JSON.stringify(report));
  assert.equal(reads, 2, "completed reads are reused when the parent reattaches its children");
  assert.equal((await harness.commit(tx => tx.scanConversations({}, 50), ctx)).items.filter(item => item.owner).length, 2);
  await harness.close(ctx);
  config = { ...config, participants: [{ modelId: "fixture/analyst" }, { modelId: "fixture/reviewer" }] };
  forceBudget = true;
  harness = await open(join(root, "budget-state"));
  conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
  await (await conversation.submit({ type: "input", content: "budget", requestId: "budget" }, ctx)).wait(ctx);
  assert.equal(report?.succeeded, 0, JSON.stringify(report));
  assert(report?.workers.every(worker => worker.error?.includes("工具预算")), JSON.stringify(report));
  assert.equal(reads, 4, "each consultation child may execute only its first read");
  assert.equal(serverError, undefined);
  console.log("PASS durable consultation children, participant snapshot, completed read reuse after restart, independent answers and persisted read budgets");
} finally {
  await harness?.close(ctx);
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
}
