import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { Type } from "typebox";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";

// Exercise the installed SDK and its real agent loop. Provider responses are local fixtures;
// no credentials, network requests, user sessions, or real tools are used.
const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-compaction-"));
const model: Model<any> = {
  id: "compaction-fixture", provider: "fixture", api: "openai-completions",
  name: "Compaction fixture", baseUrl: "http://invalid.invalid", reasoning: false,
  input: ["text"], contextWindow: 272_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function runCase(options: {
  name: string;
  inputTokens: number;
  toolText?: string;
  enabled?: boolean;
  lowerRatioDuringTool?: boolean;
  cancelCompaction?: boolean;
  failSummary?: boolean;
  abortDuringCompaction?: boolean;
  queueDuringCompaction?: boolean;
  expectCompaction: boolean;
}) {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.enabled ?? true, reserveTokens: 190_400, keepRecentTokens: 300 },
    retry: { enabled: false, maxRetries: 0 },
  });
  if (options.lowerRatioDuringTool) settings.applyOverrides({ compaction: { reserveTokens: 54_400 } });
  const manager = SessionManager.inMemory(sandbox);
  const oldTime = Date.now() - 60_000;
  manager.appendMessage({ role: "user", content: "OLD_HISTORY ".repeat(2000), timestamp: oldTime });
  const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], input: number, timestamp = Date.now()): AssistantMessage => ({
    role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp,
    usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendMessage(message([{ type: "text", text: "Old answer. ".repeat(200) }], "stop", 100, oldTime + 1));
  const requests: Context[] = [];
  const events: string[] = [];
  let toolCalls = 0;
  let summaryCalls = 0;
  const runtime = {
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }),
    getModel: () => model,
    streamSimple: (_model: Model<any>, context: Context, streamOptions?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      if (streamOptions?.signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: message([], "aborted", 0) });
        stream.end();
        return stream;
      }
      let response: AssistantMessage;
      if (!getCurrentTools(context.messages).length) {
        summaryCalls++;
        events.push("summary_request");
        response = message([{ type: "text", text: "Compressed history." }], options.failSummary ? "error" : "stop", 50);
        if (options.failSummary) response.errorMessage = "fixture summary failure";
      } else {
        requests.push({ ...context, messages: structuredClone(context.messages) });
        events.push(`request_${requests.length}`);
        response = requests.length === 1
          ? message([
            { type: "toolCall", id: "call_a", name: "fixture_tool", arguments: {} },
            { type: "toolCall", id: "call_b", name: "fixture_tool", arguments: {} },
          ], "toolUse", options.inputTokens)
          : message([{ type: "text", text: "Finished after both tools." }], "stop", 100);
      }
      if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
      else {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: response.stopReason === "toolUse" ? "toolUse" : "stop", message: response });
      }
      stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
  const loader = new DefaultResourceLoader({
    cwd: sandbox, agentDir: sandbox, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.on("session_before_compact", () => {
        assert.equal(toolCalls, 2, "compaction must wait for the entire tool batch");
        const results = manager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult");
        assert.equal(results.length, 2, "all tool results must be persisted before compaction");
        if (options.cancelCompaction) return { cancel: true };
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: sandbox, agentDir: sandbox, model, modelRuntime: runtime,
    settingsManager: settings, sessionManager: manager, resourceLoader: loader,
    noTools: "builtin", customTools: [{
      name: "fixture_tool", label: "Fixture", description: "Local fixture", parameters: Type.Object({}),
      execute: async () => {
        toolCalls++;
        events.push(`tool_${toolCalls}`);
        if (options.lowerRatioDuringTool) settings.applyOverrides({ compaction: { reserveTokens: 190_400 } });
        return { content: [{ type: "text", text: options.toolText ?? "tool completed" }], details: {} };
      },
    }],
  });
  await session.bindExtensions({ mode: "rpc" });
  session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "agent_end") events.push(event.type);
    if (event.type === "compaction_start" && options.abortDuringCompaction) queueMicrotask(() => { void session.abort(); });
    if (event.type === "compaction_start" && options.queueDuringCompaction) {
      void session.prompt("QUEUED_FOLLOW_UP", { streamingBehavior: "followUp" });
    }
  });
  try {
    await session.prompt("Use both tools, then finish.");
    assert(!session.state.errorMessage, session.state.errorMessage);
    assert.equal(requests.length, options.abortDuringCompaction ? 1 : options.queueDuringCompaction ? 3 : 2, `${options.name}: only continue if not aborted`);
    assert.equal(toolCalls, 2, "neither tool may be lost or replayed");
    const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, options.expectCompaction ? 1 : 0, options.name);
    if (options.expectCompaction) {
      assert(events.indexOf("compaction_end") < events.indexOf("request_2"), "compress before the next model request");
      assert(summaryCalls > 0, "use the SDK summary generator");
      const nextContext = JSON.stringify(requests[1].messages);
      assert(nextContext.includes("Compressed history."), "the next request must receive the summary");
      assert(!nextContext.includes("OLD_HISTORY"), "the next request must not retain discarded history");
      const calls = requests[1].messages.flatMap((m) => m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : []);
      const results = requests[1].messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
      assert.deepEqual(results.sort(), calls.sort(), "compaction must preserve tool-call/result pairing");
    } else if (!options.abortDuringCompaction) {
      assert(JSON.stringify(requests[1].messages).includes("OLD_HISTORY"), "disabled/cancelled/failed compaction must retain history");
    }
    if (options.abortDuringCompaction) {
      assert(JSON.stringify(session.messages).includes("OLD_HISTORY"), "aborting compaction must retain history");
      assert.equal(events.filter((event) => event === "compaction_start").length, 1, "abort must not start a second compaction after the run");
    }
    if (options.queueDuringCompaction) {
      assert(JSON.stringify(requests[2].messages).includes("QUEUED_FOLLOW_UP"), "queued user input must survive compaction");
    }
    assert.equal(events.filter((event) => event === "agent_end").length, 1, "one continuous agent run");
    console.log(`PASS ${options.name}`);
  } finally {
    session.dispose();
  }
}

try {
  await runCase({ name: "30% threshold compacts a 53.8% tool loop", inputTokens: 146_300, expectCompaction: true });
  await runCase({ name: "fresh tool output crosses threshold", inputTokens: 81_000, toolText: "T".repeat(4_000), expectCompaction: true });
  await runCase({ name: "threshold lowered during running tools", inputTokens: 146_300, lowerRatioDuringTool: true, expectCompaction: true });
  await runCase({ name: "below threshold preserves history", inputTokens: 1000, expectCompaction: false });
  await runCase({ name: "explicit SDK disable is respected", inputTokens: 146_300, enabled: false, expectCompaction: false });
  await runCase({ name: "extension cancellation continues safely", inputTokens: 146_300, cancelCompaction: true, expectCompaction: false });
  await runCase({ name: "summary failure preserves history and continues", inputTokens: 146_300, failSummary: true, expectCompaction: false });
  await runCase({ name: "user stop during compaction does not resume the task", inputTokens: 146_300, abortDuringCompaction: true, expectCompaction: false });
  await runCase({ name: "follow-up queued during compaction is delivered", inputTokens: 146_300, queueDuringCompaction: true, expectCompaction: true });
} finally {
  const relativePath = relative(tmpdir(), sandbox);
  assert(relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
  rmSync(sandbox, { recursive: true, force: true });
}
