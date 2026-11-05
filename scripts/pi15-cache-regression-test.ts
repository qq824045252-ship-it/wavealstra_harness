import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { Type } from "typebox";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, normalizeContext, type AssistantMessage, type Model, type Context } from "@earendil-works/pi-ai";
import { stream as responsesStream, type OpenAIResponsesOptions } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { magpieResponsesModel } from "../src/main/agent/providers/magpie.ts";

const wireToolSchema = z.object({ type: z.literal("function"), name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).passthrough();
const wireItemSchema = z.object({ type: z.string().optional(), role: z.string().optional(), content: z.unknown().optional(), tools: z.array(wireToolSchema).optional() }).passthrough();
const wireSchema = z.object({ model: z.string(), input: z.array(wireItemSchema), tools: z.array(wireToolSchema).optional(), prompt_cache_key: z.string().optional(), prompt_cache_retention: z.string().optional(), prompt_cache_options: z.object({ mode: z.string().optional(), ttl: z.string().optional() }).passthrough().optional() }).passthrough();
type Wire = z.infer<typeof wireSchema>;
function isWire(value: unknown): value is Wire { return wireSchema.safeParse(value).success; }
function parseWire(text: string): Wire {
  const value: unknown = JSON.parse(text);
  assert(isWire(value), "Responses request must match the wire schema");
  return value;
}
type Capture = { body: Wire; wireTextHash: string; headers: Record<string, string> };
type CaseResult = { name: string; status: "passed" } | { name: string; status: "failed"; error: string };
const checks: CaseResult[] = [];
const evidence: Array<{ label: string; capture: Capture }> = [];
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const baseModel: Model<"openai-responses"> = { id: "codex/gpt-6.1-terra", provider: "magpie", api: "openai-responses", name: "Offline Terra", baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const toolA = { name: "probe_a", description: "Return value plus one", parameters };
const toolB = { name: "probe_b", description: "Return value plus two", parameters };
const initial: Context = { messages: [ { role: "system", content: "Synthetic verification only", toolsAdded: [toolA], timestamp: 1 }, { role: "user", content: "Run the selected tool", timestamp: 2 } ] };
const added: Context = { messages: [...initial.messages, { role: "system", content: "", toolsAdded: [toolB], timestamp: 3 }, { role: "user", content: "Use the newly added tool", timestamp: 4 }] };
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network is prohibited in this regression"); };

async function capture(label: string, model: Model<"openai-responses">, context: Context, options: OpenAIResponsesOptions = {}): Promise<Capture> {
  const captures: Capture[] = [];
  const result = await responsesStream(model, normalizeContext(context), {
    apiKey: "offline-fixture", sessionId: "pi15-fixed-session", maxRetries: 0, ...options,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).hostname, "offline.invalid");
      const text = await request.text();
      captures.push({ body: parseWire(text), wireTextHash: sha(text), headers: Object.fromEntries([...request.headers].map(([key, value]) => [key, sha(value)])) });
      return new Response("data: " + JSON.stringify({ type: "response.completed", response: { id: "offline-response", status: "completed", output: [], usage: { input_tokens: 128, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } }) + "\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(captures.length, 1, "Exactly one serializer request, no retries");
  assert.equal(result.usage.input, 128);
  assert.equal(result.usage.cacheRead, 0, "Fixture usage must not become a cache hit");
  const row = captures[0]; assert(row);
  evidence.push({ label, capture: row }); return row;
}
function batches(body: Wire): string[][] { return body.input.filter(item => item.type === "additional_tools").map(item => (item.tools ?? []).map(tool => tool.name)); }
function prefix(previous: Capture, next: Capture): void {
  assert.deepEqual(next.body.input.slice(0, previous.body.input.length), previous.body.input, "Previous input items must remain unchanged");
  assert.equal(JSON.stringify(next.body.input.slice(0, previous.body.input.length)), JSON.stringify(previous.body.input), "Input property order must remain stable");
  const { input: previousInput, ...previousBase } = previous.body;
  const { input: nextInput, ...nextBase } = next.body;
  assert.deepEqual(nextBase, previousBase, "Non-input request fields must remain stable");
  assert.deepEqual(next.headers, previous.headers, "Fetch-visible headers must remain stable");
}
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); checks.push({ name, status: "passed" }); console.log("PASS " + name); }
  catch (error) { const detail = error instanceof Error ? error.stack ?? error.message : String(error); checks.push({ name, status: "failed", error: detail }); console.error("FAIL " + name + "\n" + detail); }
}

try {
  await check("product wrapper anchors initial tools and subsequent additions", async () => {
    const model = magpieResponsesModel(baseModel);
    const before = await capture("product-initial", model, initial), after = await capture("product-add", model, added);
    assert.deepEqual(batches(before.body), [["probe_a"]]); assert.deepEqual(batches(after.body), [["probe_a"], ["probe_b"]]);
    assert.equal(before.body.tools, undefined); assert.equal(after.body.tools, undefined);
    assert.equal(after.body.input.find(item => item.type === "additional_tools")?.tools?.[0]?.strict, false);
    prefix(before, after);
  });
  await check("unknown aliases and other providers retain full declarations", async () => {
    for (const variant of [{ ...baseModel, id: "codex/not-in-the-native-catalog" }, { ...baseModel, id: "other/gpt-6.1-terra" }, { ...baseModel, id: "gpt-6.1-terra" }, { ...baseModel, provider: "unrelated" }]) {
      const row = await capture("unknown-" + variant.provider + "-" + variant.id, magpieResponsesModel(variant), added);
      assert.deepEqual(row.body.tools?.map(tool => tool.name), ["probe_a", "probe_b"]); assert.deepEqual(batches(row.body), []);
    }
    const otherApi: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };
    assert.equal(magpieResponsesModel(otherApi), otherApi);
  });
  await check("explicit opt-outs and strict settings remain authoritative", async () => {
    for (const compat of [{ supportsAdditionalTools: false }, { supportsMidConvoSystemMessages: false }]) {
      const row = await capture("opt-out-" + Object.keys(compat)[0], magpieResponsesModel({ ...baseModel, compat }), added);
      assert.deepEqual(row.body.tools?.map(tool => tool.name), ["probe_a", "probe_b"]); assert.deepEqual(batches(row.body), []);
    }
    const row = await capture("strict-opt-out", magpieResponsesModel({ ...baseModel, compat: { supportsStrictMode: false } }), initial);
    assert.deepEqual(batches(row.body), [["probe_a"]]);
    assert.equal(row.body.input.find(item => item.type === "additional_tools")?.tools?.[0]?.strict, undefined);
  });
  await check("removal and redefinition preserve prior input", async () => {
    const model = magpieResponsesModel(baseModel);
    const before = await capture("mutation-before", model, added);
    const removed: Context = { messages: [...added.messages, { role: "system", content: "", toolsRemoved: [{ name: "probe_a" }], timestamp: 5 }, { role: "user", content: "Use B only", timestamp: 6 }] };
    const removal = await capture("mutation-removal", model, removed); prefix(before, removal);
    assert.deepEqual(getCurrentTools(removed.messages).map(tool => tool.name), ["probe_b"]);
    assert(removal.body.input.some(item => item.content === "The following tools are no longer available. Do not call them:\n- probe_a"));
    const redefined: Context = { messages: [...removed.messages,
      { role: "system", content: "", toolsRemoved: [{ name: "probe_b" }], toolsAdded: [{ ...toolB, description: "Return value plus twenty", parameters: Type.Object({ value: Type.Integer() }, { additionalProperties: false }) }], timestamp: 7 },
      { role: "system", content: "Only use integer values now.", timestamp: 8 }, { role: "user", content: "Use the latest B", timestamp: 9 }] };
    const replacement = await capture("mutation-redefinition", model, redefined); prefix(removal, replacement);
    assert.deepEqual(batches(replacement.body), [["probe_a"], ["probe_b"], ["probe_b"]]);
    const latest = replacement.body.input.filter(item => item.type === "additional_tools").at(-1)?.tools?.[0];
    assert.equal(latest?.description, "Return value plus twenty");
    assert.deepEqual(latest?.parameters, { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false });
    assert(replacement.body.input.some(item => typeof item.content === "string" && item.content.endsWith("Still unavailable: probe_a.")));
    assert(replacement.body.input.some(item => item.content === "Only use integer values now."));
  });
  await check("Agent execution respects removal, redefinition, order and permissions", async () => {
    const executions: string[] = [], permissions: string[] = [];
    const captured: Capture[] = [];
    type PlannedReply = { kind: "call"; name: string; value: number } | { kind: "done" };
    const replies: PlannedReply[] = [];
    const makeTool = (name: string, increment: number): AgentTool<typeof parameters> => ({
      name, label: name, description: "Add " + increment, parameters,
      execute: async (_id, args) => { const value = args.value + increment; executions.push(name + "=" + value); return { content: [{ type: "text", text: String(value) }], details: { value } }; },
    });
    const a = makeTool("probe_a", 1), b = makeTool("probe_b", 2);
    const agent = new Agent({
      initialState: { model: baseModel, systemPrompt: "Synthetic execution fixture", tools: [a, b] },
      beforeToolCall: async ({ toolCall }) => { permissions.push(toolCall.name); return toolCall.name === "probe_denied" ? { block: true, reason: "fixture permission denied" } : undefined; },
      streamFn: async (_model, context) => {
        captured.push(await capture("agent-" + captured.length, magpieResponsesModel(baseModel), context));
        const next = replies.shift(); assert(next, "Only planned fixture responses are allowed");
        const message: AssistantMessage = { role: "assistant", api: baseModel.api, provider: baseModel.provider, model: baseModel.id, timestamp: 1,
          content: next.kind === "call" ? [{ type: "toolCall", id: "fixture-" + captured.length, name: next.name, arguments: { value: next.value } }] : [{ type: "text", text: "done" }],
          stopReason: next.kind === "call" ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: next.kind === "call" ? "toolUse" : "stop", message }); stream.end(); return stream;
      },
    });
    async function call(name: string): Promise<void> { replies.push({ kind: "call", name, value: 10 }, { kind: "done" }); await agent.prompt("Call " + name); assert.equal(agent.state.errorMessage, undefined); assert.equal(replies.length, 0); }
    await call("probe_a"); assert.deepEqual(executions, ["probe_a=11"]);
    agent.state.tools = [b, a]; await call("probe_b"); assert.deepEqual(executions, ["probe_a=11", "probe_b=12"]);
    assert.equal(agent.state.messages.filter(message => message.role === "system").length, 1, "Reorder must not create a declaration update");
    agent.state.tools = [b]; await call("probe_a");
    const removalResult = agent.state.messages.filter(message => message.role === "toolResult").at(-1);
    assert.equal(removalResult?.isError, true); assert.deepEqual(removalResult?.content, [{ type: "text", text: "Tool probe_a not found" }]);
    assert.deepEqual(executions, ["probe_a=11", "probe_b=12"]);
    agent.state.tools = [makeTool("probe_b", 20), makeTool("probe_denied", 100)]; await call("probe_b");
    assert.deepEqual(executions, ["probe_a=11", "probe_b=12", "probe_b=30"]);
    await call("probe_denied");
    const deniedResult = agent.state.messages.filter(message => message.role === "toolResult").at(-1);
    assert.equal(deniedResult?.isError, true); assert.deepEqual(deniedResult?.content, [{ type: "text", text: "fixture permission denied" }]);
    assert.deepEqual(executions, ["probe_a=11", "probe_b=12", "probe_b=30"]); assert.deepEqual(permissions, ["probe_a", "probe_b", "probe_b", "probe_denied"]);
    agent.state.messages = [...agent.state.messages, { role: "system", content: "Late system instruction", timestamp: 2 }];
    replies.push({ kind: "done" }); await agent.prompt("Finish");
    assert.deepEqual(captured.at(-1)?.body.input.filter(item => item.content === "Late system instruction"), [{ role: "developer", content: "Late system instruction" }]);
    for (let index = 1; index < captured.length; index++) { const previous = captured[index - 1], next = captured[index]; assert(previous && next); prefix(previous, next); }
  });
  await check("cache retention and affinity follow the actual serializer", async () => {
    const modeCases: Array<{ label: string; compat: NonNullable<Model<"openai-responses">["compat"]>; retention: "short" | "long" | "none"; expectedRetention?: string; expectedOptions?: { mode?: string; ttl?: string } }> = [
      { label: "default-short", compat: {}, retention: "short" }, { label: "default-long", compat: {}, retention: "long", expectedRetention: "24h" },
      { label: "explicit-short", compat: { supportsExplicitPromptCacheMode: true }, retention: "short" },
      { label: "explicit-long", compat: { supportsExplicitPromptCacheMode: true }, retention: "long", expectedOptions: { ttl: "30m" } },
      { label: "explicit-none", compat: { supportsExplicitPromptCacheMode: true }, retention: "none", expectedOptions: { mode: "explicit" } },
      { label: "long-disabled", compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: false }, retention: "long" } ];
    for (const item of modeCases) {
      const row = await capture(item.label, magpieResponsesModel({ ...baseModel, compat: item.compat }), initial, { cacheRetention: item.retention });
      assert.equal(row.body.prompt_cache_retention, item.expectedRetention); assert.deepEqual(row.body.prompt_cache_options, item.expectedOptions);
      assert.equal(row.body.prompt_cache_key, item.retention === "none" ? undefined : "pi15-fixed-session");
      assert.equal(row.headers.session_id, item.retention === "none" ? undefined : sha("pi15-fixed-session")); assert.equal(row.headers["x-client-request-id"], item.retention === "none" ? undefined : sha("pi15-fixed-session"));
    }
    const noSession = await capture("openai-nosession", magpieResponsesModel({ ...baseModel, compat: { sessionAffinityFormat: "openai-nosession" } }), initial);
    assert.equal(noSession.headers.session_id, undefined); assert.equal(noSession.headers["x-client-request-id"], sha("pi15-fixed-session")); assert.equal(noSession.body.prompt_cache_key, "pi15-fixed-session");
    const override = await capture("header-override", magpieResponsesModel(baseModel), initial, { headers: { session_id: "explicit-affinity" } });
    assert.equal(override.headers.session_id, sha("explicit-affinity")); assert.equal(override.body.prompt_cache_key, "pi15-fixed-session");
  });
} finally {
  globalThis.fetch = savedFetch;
  const requestedReport = process.argv.find(value => value.startsWith("--report="))?.slice(9);
  if (requestedReport) {
    const output = resolve(requestedReport), allowed = resolve("out/diagnostics/pi15-cache-fix/verification");
    assert(output.startsWith(allowed + "/") || output.startsWith(allowed + "\\"), "Report must stay inside the verification write scope");
    mkdirSync(dirname(output), { recursive: true });
    const packageInfo = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-ai/package.json"), "utf8")));
    writeFileSync(output, JSON.stringify({ finishedAt: new Date().toISOString(), piVersion: packageInfo.version, networkRequests: 0, scope: "Actual product wrapper, serializer and Agent runtime. Synthetic model outputs and usage. Not a live cache measurement or complete desktop permission test.", checks, evidence }, null, 2), { flag: "wx" });
  }
}
console.log(JSON.stringify({ passed: checks.filter(item => item.status === "passed").length, failed: checks.filter(item => item.status === "failed").length, networkRequests: 0 }));
if (checks.some(item => item.status === "failed")) process.exitCode = 1;
