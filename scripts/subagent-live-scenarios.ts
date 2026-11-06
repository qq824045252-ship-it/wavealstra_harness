/**
 * Real-model file tasks through the production durable subagent implementation.
 * PowerShell:
 * $env:MYBUDDY_SUBAGENT_LIVE='1'
 * $env:MYBUDDY_SUBAGENT_LIVE_MODELS=Join-Path $env:USERPROFILE '.mybuddy/models.json'
 * pnpm -s test:subagent:live
 * Optional: MYBUDDY_SUBAGENT_LIVE_SCENARIOS and MYBUDDY_SUBAGENT_LIVE_MODEL.
 * All writes, auth storage and model-catalog storage stay in the test directory.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { z } from "zod";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createDurableSubagentTools, DurableSubagentIdentity, durableSubagentIpcBackend, resolveDurableExecutionCwd } from "../src/main/agent/durable/DurableSubagents";
import { guardSubagentWriteCall } from "../src/main/capabilities/subagent/write-conflict";
import { registerMyBuddyProviders } from "../src/main/agent/providers";

// Opt-in network acceptance. Only this runner's child processes are terminated.
const scenarios = ["single", "chain-crash", "parallel-crash", "steer", "cancel"] as const;
const Scenario = z.enum(scenarios);
type Scenario = z.infer<typeof Scenario>;
const RequestRow = z.object({ pid: z.number(), session: z.string(), hashes: z.array(z.string()), system: z.string(), tools: z.string() });
const Effect = z.object({ path: z.string(), conversationId: z.number(), pid: z.number() });
const Generation = z.object({ pid: z.number(), session: z.string(), resumed: z.boolean(), stopReason: z.string(),
  usage: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }) });
const Activity = z.object({ pid: z.number(), ids: z.array(z.string()) });
const Event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint"), label: z.string(), ids: z.array(z.string()), receipt: z.number() }),
  z.object({ kind: z.literal("done"), report: z.unknown() }),
  z.object({ kind: z.literal("error"), error: z.string() }),
]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const append = (path: string, row: unknown) => appendFileSync(path, JSON.stringify(row) + "\n");
const modelId = process.env.MYBUDDY_SUBAGENT_LIVE_MODEL ?? "codex/gpt-6.1-terra";
const model = `magpie/${modelId}`;
const taskId = "isolated-subagent-live";

function scoped(cwd: string, path: string): string {
  const target = resolve(cwd, path), inside = relative(cwd, target);
  assert(inside && !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`), "file outside test workspace");
  return target;
}

function task(index: number, scenario: Scenario): string {
  return `Process input-${index}.csv using the read tool. Sum quantity*unit_price and quantity across all rows. ` +
    `Write result-${index}.json using write, with exactly {"rows":4,"quantity":<sum>,"revenue":<sum>}. ` +
    `Then read result-${index}.json back to verify it. Then call checkpoint with label="result-${index}". ` +
    `After checkpoint returns, answer with one short sentence. ${scenario === "chain-crash" && index > 0 ? "Prior step evidence: {previous}" : ""}`;
}

function invocation(scenario: Scenario) {
  const item = (index: number) => ({ agent: "worker", task: task(index, scenario), model, thinking: "low", isolation: "shared" });
  if (scenario === "parallel-crash") return { tasks: [0, 1, 2, 3].map(item) };
  if (scenario === "chain-crash") return { chain: [0, 1, 2].map(item) };
  return item(0);
}

async function worker(root: string, scenario: Scenario, resumed: boolean) {
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelsPath = process.env.MYBUDDY_SUBAGENT_LIVE_MODELS ?? join(homedir(), ".mybuddy", "models.json");
  assert(existsSync(modelsPath), "models.json missing; set MYBUDDY_SUBAGENT_LIVE_MODELS to its absolute path when test-guard isolates HOME");
  const models = await ModelRuntime.create({ modelsPath, modelsStorePath: join(agentDir, "models-store.json"),
    authPath: join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  registerMyBuddyProviders(models);
  await models.refresh({ allowNetwork: false });
  assert(models.getModel("magpie", modelId), `configured model missing: ${model}; ${models.getError() ?? "no config error"}`);
  const original = models.streamSimple.bind(models);
  models.streamSimple = (selected, context, options) => {
    append(join(root, "requests.jsonl"), { pid: process.pid, session: options?.sessionId ?? "missing",
      hashes: context.messages.map(digest), system: digest(context.systemPrompt), tools: digest(context.tools) });
    const stream = original(selected, context, options);
    void stream.result().then(message => append(join(root, "generations.jsonl"), { pid: process.pid,
      session: options?.sessionId ?? "missing", resumed, stopReason: message.stopReason, usage: message.usage }));
    return stream;
  };
  const read = defineTool({ name: "read", description: "Read a UTF-8 file in the assigned workspace.", replay: "safe",
    parameters: Type.Object({ path: Type.String() }), execute: async args => ({ output: [{ type: "text", text: await readFile(scoped(cwd, args.path), "utf8") }] }) });
  const write = defineTool({ name: "write", description: "Write a UTF-8 file in the assigned workspace.", replay: "unsafe",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (args, api) => {
      const target = scoped(cwd, args.path);
      await writeFile(target, args.content);
      append(join(root, "effects.jsonl"), { path: args.path, conversationId: api.conversationId, pid: process.pid });
      return { output: [{ type: "text", text: `Written ${args.path}` }] };
    } });
  let harness: Harness;
  let receipt = 0;
  const checkpoint = defineTool({ name: "checkpoint", description: "Wait for the test supervisor after verifying the written result. Call once per task.", replay: "safe",
    parameters: Type.Object({ label: Type.String() }), execute: async (args, _api, context) => {
      const blocked = !resumed && (scenario === "parallel-crash" || scenario === "steer" || scenario === "cancel"
        || scenario === "chain-crash" && args.label === "result-1");
      if (blocked) {
        const children = (await harness.commit(tx => tx.scanConversations({}, 100), ctx)).items.filter(row => row.owner);
        const ids: string[] = [];
        for (const child of children) {
          const identity = (await harness.snapshot(DurableSubagentIdentity, child.id, ctx))?.value;
          if (identity) ids.push(identity.item.id);
        }
        process.send?.({ kind: "checkpoint", label: args.label, ids, receipt });
        if (scenario === "steer" || scenario === "cancel") {
          const active = durableSubagentIpcBackend.active(taskId);
          assert.equal(active.length, 1);
          assert.equal(durableSubagentIpcBackend.active("other-task").length, 0);
          if (scenario === "steer") {
            const delivered = await durableSubagentIpcBackend.steer(active[0].subagentId, "In your final answer include the exact phrase STEER_CONFIRMED_86753. Do not rewrite any file.");
            assert.equal(delivered.ok, true);
          } else {
            // Invoke cancellation outside the currently executing tool to avoid awaiting its own abort.
            setImmediate(() => { void durableSubagentIpcBackend.cancel(active[0].subagentId).catch(error => console.error(error)); });
            await delay(120_000, undefined, { signal: context.abortSignal });
          }
        } else {
          await delay(600_000, undefined, { signal: context.abortSignal });
        }
      }
      return { output: [{ type: "text", text: `Verified ${args.label}; supervisor released checkpoint.` }] };
    } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "live-acceptance", tools: [read, write, checkpoint,
    ...createDurableSubagentTools({ taskId, cwd, models, permissionMode: () => "auto",
      onChange: () => append(join(root, "activity.jsonl"), { pid: process.pid, ids: durableSubagentIpcBackend.active(taskId).map(row => row.subagentId) }) })],
    hooks: [hook(ToolTask, { beforeTool: (call, api) => guardSubagentWriteCall(call, api.conversationId, taskId) })] }));
  const storage = await openNodeJsonlStorage(join(root, "state"), ctx, { fsync: true });
  harness = await Harness.open(storage, { models, registry, env: async (target, context) => new NodeExecutionEnv({ cwd: await resolveDurableExecutionCwd(target, context, cwd) }) }, ctx);
  try {
    const conversation = await harness.root(ctx, { agent: { cwd, model: { provider: "magpie", modelId }, thinkingLevel: "low",
      instructions: "Follow the specified subagent invocation exactly once. Do not run the child work yourself. After receiving the tool result give one brief summary; do not delegate again." } });
    const submission = await conversation.submit({ type: "input", content: `Call subagent exactly once with this JSON: ${JSON.stringify(invocation(scenario))}`, requestId: `live-${scenario}` }, ctx);
    receipt = submission.id;
    const status = await submission.wait(ctx);
    assert.equal(status.status, "done", `root did not finish: ${JSON.stringify(status)}`);
    const conversations = (await harness.commit(tx => tx.scanConversations({}, 100), ctx)).items;
    const rows: Array<{ conversationId: number; child: boolean; subagentId?: string; task?: string; assistants: AssistantMessage[]; results: ToolResultMessage[] }> = [];
    for (const child of conversations) {
      const identity = (await harness.snapshot(DurableSubagentIdentity, child.id, ctx))?.value;
      const entries = await harness.commit(tx => tx.scanEntries({ conversationId: child.id, order: "ascending" }, 500), ctx);
      const messages = entries.items.flatMap(entry => entry.model ?? []);
      rows.push({ conversationId: child.id, child: Boolean(child.owner), subagentId: identity?.item.id,
        task: identity?.item.task, assistants: messages.filter(message => message.role === "assistant"),
        results: messages.filter(message => message.role === "toolResult") });
    }
    const report = { scenario, resumed, receipt, rows, activeAfter: durableSubagentIpcBackend.active(taskId) };
    writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2));
    process.send?.({ kind: "done", report });
  } finally { await harness.close(ctx); }
}

async function runProcess(root: string, scenario: Scenario, resumed: boolean): Promise<{ crashed: boolean; ids: string[]; receipt: number }> {
  const child = fork(fileURLToPath(import.meta.url), ["--worker", root, scenario, ...(resumed ? ["--resumed"] : [])], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const chunks: string[] = [];
  child.stdout?.on("data", data => { chunks.push(String(data)); });
  child.stderr?.on("data", data => { chunks.push(String(data)); });
  return await new Promise((resolveRun, reject) => {
    const reached = new Set<string>();
    let ids: string[] = [], receipt = 0, crashed = false, done = false, failure: string | undefined;
    const timeout = setTimeout(() => { failure = "live scenario exceeded 5 minutes"; child.kill("SIGKILL"); }, 300_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("message", raw => {
      const event = Event.safeParse(raw);
      if (!event.success) { failure = "invalid worker message"; child.kill("SIGKILL"); return; }
      if (event.data.kind === "done") { done = true; return; }
      if (event.data.kind === "error") { failure = event.data.error; return; }
      reached.add(event.data.label);
      ids = event.data.ids;
      receipt = event.data.receipt;
      console.log(`${scenario}: checkpoint ${event.data.label}, ${ids.length} durable children, pid=${child.pid}`);
      const required = scenario === "parallel-crash" ? 2 : scenario === "chain-crash" ? 1 : Infinity;
      if (!resumed && reached.size >= required) { crashed = true; child.kill("SIGKILL"); }
    });
    child.on("exit", code => {
      clearTimeout(timeout);
      if (failure || !crashed && (code !== 0 || !done)) reject(new Error(failure ?? `worker exited ${code}: ${chunks.join("").slice(-5000)}`));
      else resolveRun({ crashed, ids, receipt });
    });
  });
}

async function main() {
  assert.equal(process.env.MYBUDDY_SUBAGENT_LIVE, "1", "Set MYBUDDY_SUBAGENT_LIVE=1; this test makes real model requests. Missing opt-in is not a passing test.");
  const base = resolve("out/diagnostics/subagent-live", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(base, { recursive: true });
  const selected = process.env.MYBUDDY_SUBAGENT_LIVE_SCENARIOS?.split(",").map(value => Scenario.parse(value)) ?? [...scenarios];
  assert(selected.length > 0);
  const summaries: unknown[] = [];
  for (const scenario of selected) {
    const root = join(base, scenario), cwd = join(root, "workspace"), agentDir = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "magpie", defaultModel: modelId, enabledModels: [model] }));
    writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ maxConcurrency: 2, timeoutPolicy: "fixed", timeoutMs: 240_000 }));
    writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Summarize a CSV and write a verified JSON report.\ntools: read, write, checkpoint\n---\nUse tools to perform the assigned file task. Call tools in separate rounds, in order: read input, write result, read result, checkpoint, final answer. Never call write twice.\n");
    const count = scenario === "parallel-crash" ? 4 : scenario === "chain-crash" ? 3 : 1;
    for (let i = 0; i < count; i++) writeFileSync(join(cwd, `input-${i}.csv`), `item,quantity,unit_price\nA,${i + 1},10\nB,2,20\nC,3,5\nD,4,7\n`);
    console.log(`START ${scenario} (${model}) in ${root}`);
    const first = await runProcess(root, scenario, false);
    if (scenario.endsWith("-crash")) {
      assert(first.crashed, "crash checkpoint was not reached");
      await runProcess(root, scenario, true);
    }
    if (scenario !== "steer" && scenario !== "cancel") {
      const before = readFileSync(join(root, "requests.jsonl"), "utf8");
      await runProcess(root, scenario, true);
      assert.equal(readFileSync(join(root, "requests.jsonl"), "utf8"), before, "completed receipt replay must not call the provider again");
    }
    const effects = readFileSync(join(root, "effects.jsonl"), "utf8").trim().split("\n").map(line => Effect.parse(JSON.parse(line)));
    assert.equal(effects.length, count, "a completed write replayed or a task failed to write");
    for (let i = 0; i < count; i++) {
      assert.equal(effects.filter(row => row.path === `result-${i}.json`).length, 1, "each result must be written exactly once");
      assert.deepEqual(JSON.parse(readFileSync(join(cwd, `result-${i}.json`), "utf8")), { rows: 4, quantity: i + 10, revenue: i * 10 + 93 });
    }
    const raw = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    const report = z.object({ receipt: z.number(), activeAfter: z.array(z.unknown()), rows: z.array(z.object({
      conversationId: z.number(), child: z.boolean(), subagentId: z.string().optional(),
      assistants: z.array(z.object({ stopReason: z.string(), content: z.unknown(), usage: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }) })),
      results: z.array(z.object({ toolName: z.string(), isError: z.boolean().optional(), content: z.unknown(), details: z.unknown().optional() })),
    })) }).parse(raw);
    const children = report.rows.filter(row => row.child);
    assert.equal(children.length, count, "recovery created extra child conversations");
    if (first.crashed) {
      assert.equal(report.receipt, first.receipt, "same requestId must reuse the root receipt");
      for (const id of first.ids) assert(children.some(row => row.subagentId === id), `child identity lost: ${id}`);
    }
    if (scenario === "steer") assert(children.some(row => JSON.stringify(row.assistants).includes("STEER_CONFIRMED_86753")), "steering did not reach the child's answer");
    const parent = report.rows.find(row => !row.child);
    const delegated = parent?.results.filter(row => row.toolName === "subagent") ?? [];
    assert.equal(delegated.length, 1, "parent must delegate exactly once");
    const outcomes = z.object({ results: z.array(z.object({ status: z.string() })) }).parse(delegated[0].details).results.map(row => row.status);
    if (scenario === "cancel") {
      assert.equal(delegated[0].isError, true, "cancel must not look like success");
      assert.deepEqual(outcomes, ["cancelled"], "child must expose the cancellation status");
    }
    else assert(!delegated[0].isError, `subagent failed: ${JSON.stringify(delegated[0].content).slice(0, 1500)}`);
    assert.equal(report.activeAfter.length, 0, "finished children leaked into active index");
    const requests = readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => RequestRow.parse(JSON.parse(line)));
    const previous = new Map<string, z.infer<typeof RequestRow>>();
    let prefixBreaks = 0, comparisons = 0, restartComparisons = 0;
    for (const request of requests) {
      const before = previous.get(request.session);
      assert.notEqual(request.session, "missing", "provider session identity missing");
      if (before) {
        comparisons++;
        if (before.pid !== request.pid) restartComparisons++;
        if (before.system !== request.system || before.tools !== request.tools || before.hashes.some((hash, i) => request.hashes[i] !== hash)) prefixBreaks++;
      }
      previous.set(request.session, request);
    }
    const generations = children.flatMap(row => row.assistants);
    const cacheRead = generations.reduce((sum, row) => sum + row.usage.cacheRead, 0);
    const input = generations.reduce((sum, row) => sum + row.usage.input, 0);
    const events = readFileSync(join(root, "generations.jsonl"), "utf8").trim().split("\n").map(line => Generation.parse(JSON.parse(line)));
    const activity = readFileSync(join(root, "activity.jsonl"), "utf8").trim().split("\n").map(line => Activity.parse(JSON.parse(line)));
    const maxActive = Math.max(...activity.map(row => row.ids.length));
    assert.equal(maxActive, scenario === "parallel-crash" ? 2 : 1, "actual admission must obey the serial/parallel policy");
    const preRestartSessions = new Set(events.filter(row => !row.resumed).map(row => row.session));
    const continued = events.filter(row => row.resumed && preRestartSessions.has(row.session));
    const summary = { scenario, status: "passed", children: children.length, writes: effects.length, crashed: first.crashed, maxActive, outcomes,
      comparisons, restartComparisons, prefixBreaks, generations: generations.length, cacheRead, input,
      continuedCacheRead: continued.reduce((sum, row) => sum + row.usage.cacheRead, 0),
      continuedCalls: continued.length,
      cacheHit: cacheRead + input ? cacheRead / (cacheRead + input) : null,
      perChild: children.map(row => ({ id: row.subagentId, calls: row.assistants.length,
        cacheRead: row.assistants.reduce((sum, turn) => sum + turn.usage.cacheRead, 0), stopReason: row.assistants.at(-1)?.stopReason })) };
    if (scenario.endsWith("-crash")) assert(restartComparisons > 0, "no provider continuation observed across process restart");
    if (scenario !== "steer" && scenario !== "cancel") assert.equal(prefixBreaks, 0, "history prefix changed unexpectedly");
    summaries.push(summary);
    writeFileSync(join(base, "summary.json"), JSON.stringify({ model, bundleSha256: digest(readFileSync(fileURLToPath(import.meta.url), "utf8")), scope: "Real Magpie + production DurableSubagents + isolated JSONL store; context-prefix hashes, not a capture of serialized HTTP requests; no desktop UI or packaged runtime acceptance.", summaries }, null, 2));
    console.log(`PASS ${scenario}: ${JSON.stringify(summary)}`);
  }
  console.log(`REPORT ${join(base, "summary.json")}`);
}

if (process.argv[2] === "--worker") {
  worker(resolve(process.argv[3]), Scenario.parse(process.argv[4]), process.argv.includes("--resumed"))
    .catch(error => { process.send?.({ kind: "error", error: error instanceof Error ? error.stack : String(error) }); process.exitCode = 1; });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
