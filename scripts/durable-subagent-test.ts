import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { assertWorktreeIsolationPreflight, createDurableSubagentTools, DurableSubagentIdentity, durableSubagentIpcBackend, resolveDurableExecutionCwd } from "../src/main/agent/durable/DurableSubagents";
import { findDurableUserEntry, forkDurableConversation, resolveActiveDurableConversation } from "../src/main/agent/durable/DurableConversationBranch";
import { guardSubagentWriteCall } from "../src/main/capabilities/subagent/write-conflict";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-child-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace"), directory = join(root, "state");
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "agents"), { recursive: true });
await mkdir(cwd);
let writes = 0;
/** D-2: file writes the fixture `write` tool actually performed (a blocked write never lands here). */
let writtenFiles: Array<{ path: string; content: string }> = [];
let allowFinal = false;
let waiting: (() => void) | undefined;
let serverError: unknown;
const reachedWaiting = new Promise<void>(resolve => { waiting = resolve; });
const seenChildTools: string[][] = [];

/** D-1 observations: child requests, in-flight peaks and per-task start/end (reset per scenario). */
type PoolProbe = { requests: number; inFlight: number; maxInFlight: number; start: Map<number, number>; end: Map<number, number> };
let pool: PoolProbe = { requests: 0, inFlight: 0, maxInFlight: 0, start: new Map(), end: new Map() };
/**
 * D-1: how many child requests the fixture still rejects with the provider membership-quota 400, and
 * how many it rejected. The budget models a quota that is full while the dispatch starts and frees up
 * by the time the deferred serial retry runs.
 */
let tierLimitBudget = 0;
let tierLimitRejections = 0;
const resetPool = () => {
  pool = { requests: 0, inFlight: 0, maxInFlight: 0, start: new Map(), end: new Map() };
  tierLimitBudget = 0; tierLimitRejections = 0;
  writtenFiles = [];
};
const tierLimitBody = { code: "tier_limit_exceeded",
  message: "Open Design: [code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10 resets 2026-11-06T01:00:00Z",
  param: null, type: "invalid_request_error" };

const sse = (response: ServerResponse, items: unknown[]) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const item of items) for (const type of ["response.output_item.added", "response.output_item.done"]) {
    response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Date.now()}`, status: "completed", output: items, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
};

/**
 * What the parent asks for, keyed by a scenario marker carried in the user prompt.
 * Undefined keeps the original single-task delegation used by the recovery flow below.
 */
const parentDispatch = (prompt: string): Record<string, unknown> | undefined => {
  const marker = (name: string) => prompt.includes(`SCENARIO=${name}`);
  const model = "fixture/child", isolation = "shared";
  if (marker("parallel-status")) return { tasks: [
    { agent: "worker", task: "SCENARIO=parallel-status task one", model, isolation },
    { agent: "worker", task: "SCENARIO=parallel-status CHILD_FAIL", model, isolation },
  ] };
  if (marker("truncate")) return { tasks: Array.from({ length: 9 }, (_, index) => ({
    agent: "worker", task: index === 0 ? "SCENARIO=truncate CHILD_BIG" : `SCENARIO=truncate ok ${index}`, model, isolation })) };
  // No isolation → auto + parallel + writable, which must be preflighted once before dispatch.
  if (marker("preflight")) return { tasks: [
    { agent: "worker", task: "SCENARIO=preflight one", model },
    { agent: "worker", task: "SCENARIO=preflight two", model },
  ] };
  if (marker("pool")) return { tasks: Array.from({ length: 6 }, (_, index) => ({
    agent: "worker", task: `SCENARIO=pool POOL_TASK=${index}${index === 0 ? " POOL_SLOW" : ""}`, model, isolation })) };
  // D-1: twelve tasks, two of which the fixture rejects with the provider membership-quota 400.
  if (marker("retry")) return { tasks: Array.from({ length: 12 }, (_, index) => ({
    agent: "worker", task: `SCENARIO=retry RETRY_TASK=${index}`, model, isolation })) };
  // D-1: a plain request error must stay failed and must never be retried.
  if (marker("plain-400")) return { tasks: [
    { agent: "worker", task: "SCENARIO=plain-400 PLAIN_FAIL", model, isolation },
    { agent: "worker", task: "SCENARIO=plain-400 ok", model, isolation },
  ] };
  if (marker("timeout")) return { agent: "worker", task: "SCENARIO=timeout task", model, isolation, timeout_ms: 30000 };
  // D-2: two parallel shards write the same file; exactly one write may land.
  if (marker("write-conflict")) return { tasks: [
    { agent: "writer", task: "SCENARIO=write-conflict WRITE_ONE", model, isolation },
    { agent: "writer", task: "SCENARIO=write-conflict WRITE_TWO", model, isolation },
  ] };
  // D-2: chain steps writing the same file is legal — no guard outside a concurrent parallel dispatch.
  if (marker("chain-write")) return { chain: [
    { agent: "writer", task: "SCENARIO=chain-write WRITE_ONE", model, isolation },
    { agent: "writer", task: "SCENARIO=chain-write WRITE_TWO", model, isolation },
  ] };
  if (marker("chain")) return { chain: [
    { agent: "worker", task: "SCENARIO=chain step one", model, isolation },
    { agent: "worker", task: "SCENARIO=chain step two after {previous}", model, isolation },
  ] };
  return undefined;
};

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body = JSON.parse(text) as { model?: unknown };
    assert(body && typeof body === "object" && typeof body.model === "string");
    const model = String(body.model);
    const bodyTools = (body as { tools?: unknown }).tools;
    const tools = Array.isArray(bodyTools) ? bodyTools.map(tool => String((tool as { name?: unknown }).name)) : [];
    const returned = text.includes("function_call_output");
    if (model === "parent") {
      // D-1: the retry scenario starts against a full membership quota: the first two concurrent
      // children are rejected, and the deferred serial retry afterwards finds a free slot.
      if (!returned && text.includes("SCENARIO=retry")) tierLimitBudget = 2;
      sse(response, [returned
        ? { type: "message", id: "msg_parent_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "parent done", annotations: [] }] }
        : { type: "function_call", id: "fc_parent", call_id: "parent_call", name: "subagent",
            arguments: JSON.stringify(parentDispatch(text) ?? { agent: "worker", task: "Write proof once", model: "fixture/child", isolation: "shared", displayName: "皮卡丘" }) }]);
      return;
    }
    seenChildTools.push(tools);
    assert(!tools.includes("subagent"), "child must not inherit recursive delegation");
    if (returned && !allowFinal) { waiting?.(); return; }
    const taskIndex = /POOL_TASK=(\d+)/.exec(text)?.[1];
    const index = taskIndex === undefined ? undefined : Number(taskIndex);
    pool.requests += 1;
    if (index !== undefined) {
      if (!pool.start.has(index)) pool.start.set(index, Date.now());
      pool.inFlight += 1;
      pool.maxInFlight = Math.max(pool.maxInFlight, pool.inFlight);
    }
    try {
      if (tierLimitBudget > 0) {
        // D-1: exactly the provider rejection that the retry path must recognise and defer.
        tierLimitBudget -= 1;
        tierLimitRejections += 1;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify(tierLimitBody));
        return;
      }
      if (text.includes("PLAIN_FAIL")) {
        // A real request error: it must stay failed and must never be classified as a quota rejection.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "invalid_request_error",
          message: "invalid request: unsupported parameter value", param: "temperature", type: "invalid_request_error" }));
        return;
      }
      if (text.includes("CHILD_FAIL")) {
        // Same shape as the provider 400 in the defect report: non-retryable, surfaces as failed.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify(tierLimitBody));
        return;
      }
      if (text.includes("POOL_SLOW")) await new Promise(done => setTimeout(done, 800));
      sse(response, [model === "child" && !returned && tools.includes("proof")
        ? { type: "function_call", id: "fc_proof", call_id: "proof_call", name: "proof", arguments: "{}" }
        // D-2: the writer shards all target the same relative path, so only the guard separates them.
        : model === "child" && !returned && tools.includes("write")
          ? { type: "function_call", id: "fc_write", call_id: "write_call", name: "write",
              arguments: JSON.stringify({ path: "shared.txt",
                content: text.includes("WRITE_ONE") ? "one" : "two" }) }
          : { type: "message", id: "msg_done", role: "assistant", status: "completed",
            // Many short lines keep the 50KB per-task cap (and its hint) inside the host's
            // 50KB tool-result projection, so the truncation notice stays observable.
            content: [{ type: "output_text", text: text.includes("CHILD_BIG") ? `${"B".repeat(99)}\n`.repeat(600) : `${model} done`, annotations: [] }] }]);
    } finally {
      if (index !== undefined) { pool.inFlight -= 1; pool.end.set(index, Date.now()); }
    }
  } catch (error) { serverError = error; if (!response.headersSent) response.writeHead(500); response.end("{}"); }
});
let harness: Harness | undefined;
try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  const models = ["parent", "child"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-only", models } } }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "parent", enabledModels: ["fixture/parent", "fixture/child"] }));
  // D-1: two concurrent children make the rolling-pool/barrier difference observable.
  // D-4: a fixed policy must keep governing the timeout while the ignored override is reported.
  await writeFile(join(agentDir, "subagent.json"), JSON.stringify({ maxConcurrency: 2, timeoutPolicy: "fixed", timeoutMs: 3_600_000 }));
  await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: fixture child\ntools: proof\n---\nWrite proof then answer.\n");
  await writeFile(join(agentDir, "agents", "writer.md"), "---\nname: writer\ndescription: fixture writer\ntools: write\n---\nWrite the file then answer.\n");
  const native = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let permission: "auto" | "readonly" = "auto";
  const proof = defineTool({ name: "proof", description: "Write proof", parameters: Type.Object({}), replay: "unsafe", execute: async (_args, api) => {
    assert.equal((await api.agent(ctx)).cwd, cwd);
    writes++;
    await writeFile(join(cwd, "proof.txt"), String(writes));
    return { output: [{ type: "text", text: "proof written" }] };
  } });
  /**
   * D-2 fixture: a real `write` tool (same name and {path, content} shape as pi's) so the guard sees
   * the exact call the product guards. Executed writes are recorded; a blocked call never runs.
   */
  const write = defineTool({ name: "write", description: "Write a file", replay: "unsafe",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (args, api) => {
      assert.equal((await api.agent(ctx)).cwd, cwd);
      const target = resolve(cwd, args.path);
      writtenFiles.push({ path: target, content: args.content });
      await writeFile(target, args.content);
      return { output: [{ type: "text", text: `wrote ${args.path}` }] };
    } });
  const open = async (store: string) => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixture",
      tools: [proof, write, ...createDurableSubagentTools({ taskId: "test-task", cwd, models: native, permissionMode: () => permission })],
      // D-2: the same beforeTool entry point AgentService installs for production (a one-line
      // `guardSubagentWriteCall(call, api.conversationId, task.id)`); the guard itself is registered by
      // DurableSubagents.runChild for parallel dispatches with concurrency > 1, keyed by taskId here too
      // because every task has its own durable store and conversation ids collide across tasks.
      hooks: [hook(ToolTask, { beforeTool: (call, api) => guardSubagentWriteCall(call, api.conversationId, "test-task") })] }));
    const storage = await openNodeJsonlStorage(store, ctx, { fsync: true });
    return Harness.open(storage, { models: native, registry, env: async (target, context) => new NodeExecutionEnv({ cwd: await resolveDurableExecutionCwd(target, context, cwd) }) }, ctx);
  };
  type ScenarioSubmission = { subagentId: string; base?: number; retry?: number };
  /**
   * Isolated scenario run: one root task, one `subagent` tool result, plus the child count.
   * With `inspectSubmissions`, the durable ledger is read per child for the first attempt's
   * requestId and for `subagent:<id>:retry:1`; that proves a retry submitted under a new id.
   */
  const runScenario = async (name: string, prompt: string, options: { inspectSubmissions?: boolean } = {}) => {
    resetPool();
    let scenarioHarness: Harness | undefined;
    try {
      scenarioHarness = await open(join(root, `state-${name}`));
      const scenarioConversation = await scenarioHarness.root(ctx, { agent: { cwd, model: { provider: "fixture", modelId: "parent" } } });
      const submission = await scenarioConversation.submit({ type: "input", content: prompt, requestId: `scenario-${name}` }, ctx);
      assert.equal((await submission.wait(ctx)).status, "done");
      const scenarioEntries = await scenarioConversation.entries({}, 200, undefined, ctx);
      const toolResult = scenarioEntries.items.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert(toolResult?.role === "toolResult", `subagent toolResult missing for ${name}`);
      const output = typeof toolResult.content === "string" ? toolResult.content
        : toolResult.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      const owned = (await scenarioHarness.commit(tx => tx.scanConversations({}, 250), ctx)).items.filter(item => item.owner);
      // D-2: a blocked write lands as an error tool result inside the child's own transcript.
      const blockedWrites: string[] = [];
      for (const child of owned) {
        const childEntries = await scenarioHarness.commit(tx => tx.scanEntries({ conversationId: child.id, order: "ascending" }, 250, undefined), ctx);
        for (const entry of childEntries.items) for (const message of entry.model ?? []) {
          if (message.role !== "toolResult" || message.toolName !== "write" || !message.isError) continue;
          blockedWrites.push(typeof message.content === "string" ? message.content
            : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n"));
        }
      }
      const submissions: ScenarioSubmission[] = [];
      if (options.inspectSubmissions) for (const child of owned) {
        const identity = (await scenarioHarness.snapshot(DurableSubagentIdentity, child.id, ctx))?.value;
        if (!identity) continue;
        const base = await scenarioHarness.commit(tx => tx.submissionByRequest(child.id, `subagent:${identity.item.id}`), ctx);
        const retry = await scenarioHarness.commit(tx => tx.submissionByRequest(child.id, `subagent:${identity.item.id}:retry:1`), ctx);
        submissions.push({ subagentId: identity.item.id, ...(base ? { base: base.id } : {}), ...(retry ? { retry: retry.id } : {}) });
      }
      return { output, details: toolResult.details, isError: Boolean(toolResult.isError), children: owned.length, submissions, blockedWrites };
    } finally {
      await scenarioHarness?.close(ctx);
    }
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
  await harness.close(ctx);
  harness = undefined;
  permission = "auto";

  // ---- D-3: parallel text projection (header + per-item status + id + truncation) ------------
  const parallelRun = await runScenario("parallel-status", "SCENARIO=parallel-status");
  assert.equal(parallelRun.children, 2);
  assert.equal(parallelRun.isError, true, "one failed item keeps isError=true");
  assert.match(parallelRun.output, /^Parallel: 1\/2 succeeded\n\n/, parallelRun.output.slice(0, 200));
  assert.match(parallelRun.output, /### \[worker\] completed \(id: [a-zA-Z0-9_-]+\)/, "success marker with id");
  assert.match(parallelRun.output, /### \[worker\] failed \(error\) \(id: [a-zA-Z0-9_-]+\)/, "failure marker with stopReason and id");
  assert.match(parallelRun.output, /\n\n---\n\n/, "items stay separated by ---");
  assert.match(parallelRun.output, /> subagent-name: \S+/, "display name stays on the text bridge");
  const parallelId = /\(id: ([a-zA-Z0-9_-]+)\)/.exec(parallelRun.output)?.[1];
  assert(parallelId, "the durable id must remain text-extractable");
  const parallelResults = (parallelRun.details as { results?: Array<{ status?: string; exitCode?: number; subagentId?: string }> }).results ?? [];
  assert.equal(parallelResults.length, 2);
  assert.equal(parallelResults.filter(item => item.status === "failed" && item.exitCode === 1).length, 1);
  assert(parallelResults.some(item => item.subagentId === parallelId), "text id must match a details result");

  const truncatedRun = await runScenario("truncate", "SCENARIO=truncate");
  assert.match(truncatedRun.output, /\[Output truncated: \d+ bytes omitted\. Full output preserved in tool details\.\]/);

  // ---- D-1: rolling pool refills before the slow child finishes ------------------------------
  const poolRun = await runScenario("pool", "SCENARIO=pool");
  assert.equal(poolRun.children, 6);
  assert.equal(pool.requests, 12, "six children with two provider requests each; no retries");
  assert.ok(pool.maxInFlight <= 2, `in-flight ${pool.maxInFlight} must respect maxConcurrency=2`);
  const slowEnd = pool.end.get(0) ?? 0;
  assert.ok(slowEnd > 0, "the slow child must finish");
  const refilled = [...pool.start.entries()].filter(([index, at]) => index !== 0 && at < slowEnd).length;
  assert.ok(refilled >= 3, `a finished child must free its slot before the slow child ends (refilled ${refilled}/5)`);

  // ---- D-1: provider quota rejections are retried once, serially, after the pool drains --------
  // Twelve tasks at maxConcurrency=2: the fixture rejects the first two concurrent children with the
  // provider membership-quota 400, then admits the deferred retry.
  const retryRun = await runScenario("retry", "SCENARIO=retry", { inspectSubmissions: true });
  assert.equal(retryRun.children, 12);
  assert.equal(tierLimitRejections, 2, "the fixture must reject the first two concurrent children");
  assert.match(retryRun.output, /^Parallel: 12\/12 succeeded\n\n/, retryRun.output.slice(0, 200));
  assert.equal(retryRun.isError, false, "a recovered dispatch must not stay in error");
  assert.doesNotMatch(retryRun.output, /failed \(error\)/, "both rejected children must be recovered");
  // Ten children x2 requests + two rejected children x(1 rejected + 2 from the retry).
  assert.equal(pool.requests, 26, "each quota rejection must be retried exactly once");
  const retried = retryRun.submissions.filter(item => item.retry);
  assert.equal(retried.length, 2, "exactly the rejected children get one deferred retry each");
  for (const item of retried) {
    assert(item.base, `the first attempt must be on the ledger for ${item.subagentId}`);
    assert.notEqual(item.retry, item.base, "a retry must use a new requestId or Durable dedupes it into the failure");
  }

  // ---- D-1: a plain 400 is not a quota rejection: it stays failed and is never retried ----------
  const plainRun = await runScenario("plain-400", "SCENARIO=plain-400", { inspectSubmissions: true });
  assert.equal(plainRun.children, 2);
  assert.match(plainRun.output, /^Parallel: 1\/2 succeeded\n\n/, plainRun.output.slice(0, 200));
  assert.equal(plainRun.isError, true);
  // One rejected request + two for the successful child; a retry would add two more.
  assert.equal(pool.requests, 3, "a non-quota 400 must not be retried");
  assert.equal(plainRun.submissions.filter(item => item.retry).length, 0, "no retry submission may exist for a plain 400");

  // ---- D-4: an ignored timeout_ms is visible; D-5: shared workspaces are visible -------------
  const timeoutRun = await runScenario("timeout", "SCENARIO=timeout");
  assert.match(timeoutRun.output, /timeout_ms=30000 ignored: fixed policy \(3600s settings\)/);
  assert.match(timeoutRun.output, /Run time limit: 3600s \(settings\)/, "the timeout itself must stay governed by the fixed policy");
  const timeoutResults = (timeoutRun.details as { results?: Array<{ diagnostics?: string[] }> }).results ?? [];
  assert(timeoutResults[0]?.diagnostics?.some(line => line.includes("timeout_ms=30000 ignored")), "the diagnostic must also reach details");
  assert.ok(timeoutRun.output.includes(`Workspace: shared (${cwd})`), "shared workspace must be explicit in the result");

  // ---- D-5: auto + parallel + writable fails once before dispatch ----------------------------
  const preflightRun = await runScenario("preflight", "SCENARIO=preflight");
  assert.equal(preflightRun.isError, true);
  assert.equal(preflightRun.children, 0, "preflight must fail before any child conversation exists");
  assert.match(preflightRun.output, /requires a Git working tree/);
  assert.match(preflightRun.output, /isolation:"shared"/);

  // ---- D-5: a dirty repository is rejected for new work, but a ready durable receipt means
  // prepareSubagentWorkspace reuses that worktree and skips the clean check (replay/recovery) ----
  await mkdir(join(root, "preflight-repo"), { recursive: true });
  const repoDir = await realpath(join(root, "preflight-repo"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  await writeFile(join(repoDir, "tracked.txt"), "tracked\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  await writeFile(join(repoDir, "dirty.txt"), "uncommitted\n");
  const receiptBase = join(root, "preflight-worktrees");
  await mkdir(receiptBase, { recursive: true });
  const receiptRoot = await realpath(receiptBase);
  const replayOperation = "durable-replay-operation";
  await assert.rejects(assertWorktreeIsolationPreflight(repoDir, replayOperation, { baseDir: receiptRoot }),
    /requires a clean repository/, "new work in a dirty repository must fail before dispatch");
  const allocation = join(receiptRoot, `durable-${createHash("sha256").update(replayOperation).digest("hex")}`);
  const worktreeRoot = join(allocation, "worktree");
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(allocation, "receipt.json"), JSON.stringify({ state: "ready", sourceCwd: repoDir, repository: repoDir,
    root: worktreeRoot, cwd: worktreeRoot, baseCommit: "0".repeat(40), branch: "subagent/fixture", receiptPath: join(allocation, "receipt.json") }));
  await assertWorktreeIsolationPreflight(repoDir, replayOperation, { baseDir: receiptRoot });
  await assert.rejects(assertWorktreeIsolationPreflight(repoDir, "another-operation", { baseDir: receiptRoot }),
    /requires a clean repository/, "the receipt only covers its own operation");

  // ---- chain keeps its Step N: projection -----------------------------------------------
  const chainRun = await runScenario("chain", "SCENARIO=chain");
  assert.match(chainRun.output, /Step 1: \[worker\] completed \(id: /);
  assert.match(chainRun.output, /Step 2: \[worker\] completed \(id: /);
  assert.doesNotMatch(chainRun.output, /^Parallel:/);

  // ---- D-2: a parallel same-file write is blocked instead of silently overwriting -----------------
  const conflictRun = await runScenario("write-conflict", "SCENARIO=write-conflict");
  assert.equal(conflictRun.children, 2);
  // Both shards still answer (the blocked child sees the tool error and finishes), but the header now
  // says a write was blocked instead of implying every shard's content landed.
  assert.match(conflictRun.output,
    /^Parallel: 2\/2 succeeded \(1 write conflict blocked: parallel subagents must write different files\)\n\n/,
    conflictRun.output.slice(0, 260));
  assert.equal(conflictRun.blockedWrites.length, 1, "exactly one of the two same-file writes must be blocked");
  assert.match(conflictRun.blockedWrites[0]!, /并行子代理写冲突/);
  assert.match(conflictRun.blockedWrites[0]!, /shared\.txt/);
  assert.match(conflictRun.blockedWrites[0]!, /并行子代理必须写不同文件/);
  const conflictResults = (conflictRun.details as { results?: Array<{ diagnostics?: string[] }> }).results ?? [];
  assert.equal(conflictResults.filter(item => item.diagnostics?.some(line => line.includes("write conflict blocked"))).length, 1,
    "the blocked write must reach the caller as a per-child diagnostic");
  assert.equal(writtenFiles.length, 1, "only the winning shard's write may reach the file system");
  assert.match(await readFile(join(cwd, "shared.txt"), "utf8"), /^(one|two)$/,
    "the surviving content must be exactly one shard's payload, never a mix");

  // ---- D-2: chain steps may rewrite a prior step's file — the guard is parallel-only --------------
  const chainWrite = await runScenario("chain-write", "SCENARIO=chain-write");
  assert.equal(chainWrite.children, 2);
  assert.equal(chainWrite.blockedWrites.length, 0, "chain is sequential; rewriting a prior step's file is legal");
  assert.equal(writtenFiles.length, 2, "both chain steps must write");
  assert.equal(await readFile(join(cwd, "shared.txt"), "utf8"), "two", "the later chain step wins");
  assert.doesNotMatch(chainWrite.output, /write conflict/);

  assert.equal(serverError, undefined);
  console.log("PASS durable child identity, model, display name, bound cwd, persisted receipt, restart, completed effect reuse, recursion and readonly restrictions");
  console.log("PASS durable parallel text projection (header/status/id/truncation), rolling pool, timeout diagnostic, shared workspace visibility, dispatch preflight and chain steps");
  console.log("PASS D-1 provider quota rejections retried once serially under a fresh requestId; plain 400s keep their failure");
  console.log("PASS D-2 parallel same-file writes blocked with a visible conflict (chain writes stay allowed); no silent overwrite");
} finally {
  await harness?.close(ctx);
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
}
