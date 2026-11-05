import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { SubagentRuntime } from "../src/main/capabilities/subagent/runtime";

// Exact error from scout-6a8v6j, 2026-11-05. No credentials or task content.
const databaseError = {
  code: "database_unavailable",
  message: "Open Design: [code=database_unavailable] resolve Billing Scope: status 503: database_unavailable",
  param: null, type: "api_error",
};
const databaseMessage = `503: ${JSON.stringify(databaseError)}`;
const root = mkdtempSync(join(tmpdir(), "subagent-failure-recovery-"));
const reports: Array<{ name: string; status: string; error?: string; requests?: number }> = [];
async function test(name: string, run: () => Promise<number | void> | void) {
  try {
    const requests = await run();
    reports.push({ name, status: "passed", ...(typeof requests === "number" ? { requests } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    reports.push({ name, status: "failed", error: String(error) });
    console.error(`FAIL ${name}: ${String(error)}`);
  }
}
const requestSchema = z.union([
  z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()) }),
  z.object({ model: z.string(), input: z.array(z.object({ type: z.string().optional(), output: z.unknown().optional() }).passthrough()) }),
]);
type Scenario = "recover" | "exhaust" | "quota" | "reorder" | "drift" | "cancel";
type FixtureApi = "openai-completions" | "openai-responses";

async function runWorker(scenario: Scenario, api: FixtureApi): Promise<number> {
  const agentDir = join(root, `${scenario}-${api}`);
  const workspace = join(agentDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "evidence.txt"), "EXISTING_WORK\n");
  let requests = 0;
  let continuations = 0;
  let serverError: unknown;
  let rewriteConfig = (_drift: boolean): void => {};
  const abort = new AbortController();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests++;
      const toolResults = "messages" in body
        ? body.messages.filter(message => message.role === "tool").map(message => message.content)
        : body.input.filter(item => item.type === "function_call_output").map(item => item.output);
      const continuation = toolResults.length > 0;
      if (continuation) {
        continuations++;
        assert(toolResults.some(content => typeof content === "string" && content.includes("EXISTING_WORK")), "retry retains tool result");
        if (scenario === "quota" || scenario === "exhaust" || scenario === "cancel" || (scenario === "recover" && continuations === 1)) {
          response.writeHead(scenario === "quota" ? 429 : 503, { "content-type": "application/json" });
          response.end(JSON.stringify(scenario === "quota"
            ? { error: { code: "insufficient_quota", message: "Billing quota exceeded", type: "insufficient_quota" } }
            : databaseError));
          return;
        }
      } else if (scenario === "reorder" || scenario === "drift") {
        rewriteConfig(scenario === "drift");
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (api === "openai-responses") {
        const output = [
          { type: "message", id: `msg_${requests}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: continuation ? "RECOVERED_OK" : "WORK_STARTED", annotations: [] }] },
          ...continuation ? [] : [{ type: "function_call", id: "read_once", call_id: "read-once", name: "read", arguments: JSON.stringify({ path: "evidence.txt" }) }],
        ];
        for (const [index, item] of output.entries()) {
          for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: index, item })}\n\n`);
        }
        response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `response_${requests}`, model: body.model, status: "completed", output, usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
        return;
      }
      const chunk = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
        id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if (continuation) chunk({ role: "assistant", content: "RECOVERED_OK" }, null);
      else chunk({ role: "assistant", content: "WORK_STARTED", tool_calls: [{ index: 0, id: "read-once", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt" }) } }] }, null);
      chunk({}, continuation ? "stop" : "tool_calls");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      serverError = error;
      response.writeHead(500).end("{}");
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const model = {
    id: "fixture-model", name: "Fixture", input: ["text"], reasoning: false,
    contextWindow: 128000, maxTokens: 2048,
    compat: { supportsStore: false, supportsDeveloperRole: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const config = { providers: { fixture: { api, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only", models: [model] } } };
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(config));
  rewriteConfig = drift => {
    model.compat = { supportsDeveloperRole: false, supportsStore: false };
    if (drift) model.contextWindow += 1000;
    writeFileSync(modelsPath, JSON.stringify(config));
  };
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: model.id, enabledModels: ["fixture/*"],
    compaction: { enabled: false }, cacheWarming: "off",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: scenario === "cancel" ? 10000 : 10, provider: { maxRetries: 0 } },
  }));
  const packagedDir = process.env.MYBUDDY_SUBAGENT_APP_DIR;
  const workerDir = packagedDir
    ? join(resolve(packagedDir), "resources/app.asar.unpacked/out/main/capabilities/subagent")
    : resolve("src/main/capabilities/subagent");
  const cli = packagedDir ? join(workerDir, "runtime/pi-runtime.mjs") : resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const runtime = new SubagentRuntime({
    baseDir: join(agentDir, "subagent"),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MYBUDDY_CACHE_TRACE: "0" },
    resolveInvocation: () => ({ command: process.execPath, args: [join(workerDir, "worker-launcher.mjs"), cli] }),
  });
  try {
    const record = runtime.ensureSubagent({ scope: scenario, role: "worker", roleSource: "user", roleDescription: "recovery fixture", project: workspace, depth: 1 });
    const result = await runtime.runPrompt(record.subagentId, {
      task: "Read evidence.txt once and report completion.", model: `fixture/${model.id}`, timeoutMs: 45000,
      signal: abort.signal, toolArgs: { tools: ["read"], excludeTools: [] },
      onUpdate: snapshot => {
        if (scenario === "cancel" && snapshot.messages.some(message => message.stopReason === "error")) abort.abort();
      },
    });
    assert.equal(serverError, undefined);
    assert.equal(result.messages.filter(message => message.role === "toolResult").length, 1, "tool is never replayed during retry");
    if (scenario === "recover" || scenario === "reorder") {
      assert.equal(result.status, "completed", result.errorMessage);
      assert.match(result.finalText, /RECOVERED_OK/);
      assert.equal(requests, scenario === "recover" ? 3 : 2);
    } else if (scenario === "cancel") {
      assert.equal(result.status, "cancelled", result.errorMessage);
      assert.equal(requests, 2, "cancel interrupts retry backoff");
    } else {
      assert.equal(result.status, "failed");
      assert.equal(requests, scenario === "exhaust" ? 4 : scenario === "quota" ? 2 : 1);
      assert.match(result.errorMessage ?? "", scenario === "drift" ? /contextWindow/ : scenario === "quota" ? /insufficient_quota/ : /database_unavailable/);
      assert.match(result.finalText, /WORK_STARTED/, "failed run retains earlier output");
    }
    assert.equal(runtime.debugWorkerCount(record.subagentId), 0);
    assert.equal(runtime.get(record.subagentId), undefined);
    assert.equal(readFileSync(join(workspace, "evidence.txt"), "utf8"), "EXISTING_WORK\n");
    return requests;
  } finally {
    runtime.shutdownAll();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

try {
  await test("real 503 billing-scope database failure is retryable, account limits are not", () => {
    const failedMessage = (errorMessage: string, stopReason: "error" | "aborted" = "error"): AssistantMessage => ({
      role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture-model",
      stopReason, errorMessage, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    for (const [errorMessage, expected] of [
      [databaseMessage, true],
      [`fixture API error (503): ${JSON.stringify(databaseError)}`, true],
      [`fixture API error (401): ${JSON.stringify(databaseError)}`, false],
      [`503: ${JSON.stringify({ error: databaseError })}`, true],
      ["503: Billing service unavailable", false],
      [databaseMessage.replace("database_unavailable", "insufficient_quota"), false],
      [databaseMessage.replace("resolve Billing Scope", "quota exceeded resolving Billing Scope"), false],
      [databaseMessage.replace("503:", "401:"), false],
      ["429: Billing quota exceeded", false],
      ["429: GoUsageLimitError", false],
      ["503: server unavailable", true],
    ] satisfies Array<[string, boolean]>) {
      assert.equal(isRetryableAssistantError(failedMessage(errorMessage)), expected, errorMessage);
    }
    assert.equal(isRetryableAssistantError(failedMessage(databaseMessage, "aborted")), false);
  });
  for (const api of ["openai-completions", "openai-responses"] satisfies FixtureApi[]) {
    for (const scenario of ["recover", "exhaust", "quota", "reorder", "drift", "cancel"] satisfies Scenario[]) {
      await test(`real worker ${api} ${scenario}`, () => runWorker(scenario, api));
    }
  }
} finally {
  const output = resolve("out/diagnostics/subagent-failure-recovery");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, process.env.MYBUDDY_SUBAGENT_APP_DIR ? "packaged.json" : "source.json"), JSON.stringify({ at: new Date().toISOString(), packagedDir: process.env.MYBUDDY_SUBAGENT_APP_DIR, externalProviderCalls: 0, reports }, null, 2));
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = reports.every(report => report.status === "passed") ? 0 : 1;
