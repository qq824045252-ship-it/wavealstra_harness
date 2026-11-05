import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createDurableSubagentTools, DurableSubagentIdentity, durableSubagentIpcBackend, resolveDurableExecutionCwd } from "../src/main/agent/durable/DurableSubagents";
import { findDurableUserEntry, forkDurableConversation, resolveActiveDurableConversation } from "../src/main/agent/durable/DurableConversationBranch";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-child-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace"), directory = join(root, "state");
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "agents"), { recursive: true });
await mkdir(cwd);
let writes = 0;
let allowFinal = false;
let waiting: (() => void) | undefined;
let serverError: unknown;
const reachedWaiting = new Promise<void>(resolve => { waiting = resolve; });
const seenChildTools: string[][] = [];
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = JSON.parse(text);
    assert(body && typeof body === "object" && "model" in body && typeof body.model === "string");
    const tools = "tools" in body && Array.isArray(body.tools) ? body.tools.map(tool => String(tool.name)) : [];
    const returned = text.includes("function_call_output");
    if (body.model === "child") {
      seenChildTools.push(tools);
      assert(!tools.includes("subagent"), "child must not inherit recursive delegation");
      if (returned && !allowFinal) { waiting?.(); return; }
    }
    const output = body.model === "parent" && !returned
      ? [{ type: "function_call", id: "fc_parent", call_id: "parent_call", name: "subagent", arguments: JSON.stringify({ agent: "worker", task: "Write proof once", model: "fixture/child", isolation: "shared", displayName: "皮卡丘" }) }]
      : body.model === "child" && !returned && tools.includes("proof")
        ? [{ type: "function_call", id: "fc_proof", call_id: "proof_call", name: "proof", arguments: "{}" }]
        : [{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: `${body.model} done`, annotations: [] }] }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of output) for (const type of ["response.output_item.added", "response.output_item.done"]) {
      response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
    }
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Date.now()}`, model: body.model, status: "completed", output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
  } catch (error) { serverError = error; response.writeHead(500).end("{}"); }
});
let harness: Harness | undefined;
try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  const models = ["parent", "child"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-only", models } } }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "parent", enabledModels: ["fixture/parent", "fixture/child"] }));
  await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: fixture child\ntools: proof\n---\nWrite proof then answer.\n");
  const native = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let permission: "auto" | "readonly" = "auto";
  const proof = defineTool({ name: "proof", description: "Write proof", parameters: Type.Object({}), replay: "unsafe", execute: async (_args, api) => {
    assert.equal((await api.agent(ctx)).cwd, cwd);
    writes++;
    await writeFile(join(cwd, "proof.txt"), String(writes));
    return { output: [{ type: "text", text: "proof written" }] };
  } });
  const open = async (store: string) => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixture", tools: [proof, ...createDurableSubagentTools({ taskId: "test-task", cwd, models: native, permissionMode: () => permission })] }));
    const storage = await openNodeJsonlStorage(store, ctx, { fsync: true });
    return Harness.open(storage, { models: native, registry, env: async (target, context) => new NodeExecutionEnv({ cwd: await resolveDurableExecutionCwd(target, context, cwd) }) }, ctx);
  };
  harness = await open(directory);
  let conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
  const submitted = await conversation.submit({ type: "input", content: "Delegate", requestId: "stable-root-input" }, ctx);
  const firstWait = submitted.wait(ctx).catch(() => undefined);
  await Promise.race([reachedWaiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child never reached post-write wait")), 15_000).unref())]);
  assert.equal(writes, 1);
  const active = durableSubagentIpcBackend.active();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.displayName, "皮卡丘");
  const childId = (await harness.commit(tx => tx.scanConversations({}, 20), ctx)).items.find(item => item.owner)?.id;
  assert(childId);
  assert.equal((await harness.snapshot(DurableSubagentIdentity, childId, ctx))?.value?.item.selection.model, "fixture/child");
  await harness.close(ctx); await firstWait;
  assert.equal(durableSubagentIpcBackend.active().length, 0);
  allowFinal = true;
  harness = await open(directory);
  conversation = await harness.root(ctx);
  const resumed = await conversation.submit({ type: "input", content: "Delegate", requestId: "stable-root-input" }, ctx);
  assert.equal(resumed.id, submitted.id);
  assert.equal((await resumed.wait(ctx)).status, "done");
  assert.equal(writes, 1, "completed side effect must not replay after restart");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "1");
  const children = (await harness.commit(tx => tx.scanConversations({}, 20), ctx)).items.filter(item => item.owner);
  assert.equal(children.length, 1, "restart must reattach the original child");
  const entries = await conversation.entries({}, 100, undefined, ctx);
  const result = entries.items.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "subagent");
  assert(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
  assert(JSON.stringify(result.details).includes("皮卡丘"));
  const selected = await findDurableUserEntry(conversation, { userMessageIndex: 0 }, ctx);
  assert.equal(selected.previous, undefined);
  const branch = await forkDurableConversation(harness, conversation, selected.entry.id, ctx);
  assert.equal((await branch.entries({}, 100, undefined, ctx)).items.filter(entry => entry.kind === "pi.assistant").length, 0);
  assert.equal((await resolveActiveDurableConversation(harness, conversation, ctx)).id, branch.id);
  await assert.rejects(forkDurableConversation(harness, conversation, undefined, ctx), /分支已变化/);
  const emptyBranch = await forkDurableConversation(harness, branch, undefined, ctx);
  assert.equal((await emptyBranch.entries({}, 100, undefined, ctx)).items.length, 0);
  await harness.close(ctx);
  harness = await open(directory);
  assert.equal((await resolveActiveDurableConversation(harness, await harness.root(ctx), ctx)).id, emptyBranch.id);
  await harness.close(ctx);
  permission = "readonly";
  harness = await open(join(root, "readonly-state"));
  conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
  assert.equal((await (await conversation.submit({ type: "input", content: "Readonly delegate", requestId: "readonly" }, ctx)).wait(ctx)).status, "done");
  assert.deepEqual(seenChildTools.at(-1), [], "an empty permission intersection must stay empty");
  assert.equal(writes, 1);
  assert.equal(serverError, undefined);
  console.log("PASS durable child identity, model, display name, bound cwd, persisted receipt, restart, completed effect reuse, recursion and readonly restrictions");
} finally {
  await harness?.close(ctx);
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
}
