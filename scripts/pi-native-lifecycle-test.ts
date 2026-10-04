import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { mapPiEventToPatches, type MapperContext } from "../src/shared/pi-event-mapper";

// Scripted provider, REAL installed Pi AgentSession/loop/queues/retry/abort. No API credentials.
const root = await mkdtemp(join(tmpdir(), "pi-native-lifecycle-"));
const results: any[] = [];
const model: Model<any> = { id: "native-lifecycle", provider: "fixture", api: "openai-completions", name: "Native lifecycle fixture",
  baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const text = (m: any) => typeof m.content === "string" ? m.content : (m.content || []).map((p: any) => p.text || "").join("");
const plain = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const call = (id: string): AssistantMessage["content"] => [{ type: "toolCall", id, name: "fixture_hold", arguments: {} }];
async function until(fn: () => boolean) { const end = Date.now() + 12000; while (!fn()) { if (Date.now() > end) throw Error("Fixture condition timeout"); await wait(5); } }

async function test(name: string, scenario: (h: any) => Promise<void>, options: { failFirst?: boolean; content?: string; blockedPlan?: boolean } = {}) {
  const events: any[] = [], patches: any[] = [], contexts: Context[] = [];
  let requestCount = 0, toolStarted = false, releaseTool: (() => void) | undefined;
  const ctx: MapperContext = { taskId: name, messageId: "reply", startedAt: Date.now() };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: !!options.failFirst, maxRetries: 1, baseDelayMs: 10 } });
  const runtime = {
    hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }), getModel: () => model,
    streamSimple: (_m: any, context: Context) => {
      const stream = createAssistantMessageEventStream(); requestCount++; contexts.push(structuredClone(context));
      const error = options.failFirst && requestCount === 1;
      const content = error ? [] : options.content !== undefined ? plain(options.content) : requestCount === 1 ? call("hold") : plain("NATIVE_FINISHED");
      const reason = error ? "error" : content.some(p => p.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content, stopReason: reason, api: model.api, provider: model.provider, model: model.id,
        ...(error ? { errorMessage: "503 Service Unavailable" } : {}), timestamp: Date.now(),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      if (error) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: reason as "stop" | "toolUse", message });
      stream.end(); return stream;
    },
  } as unknown as ModelRuntime;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [createConversationRuntimeExtension({
      resolveContext: () => ({ taskId: name, executionId: "exec", assistantMessageId: "reply" }),
      plan: { getByExecution: () => options.blockedPlan ? { status: "blocked", approvalMode: "auto" } : undefined, invalidateVerification() {}, checkpoint() {} },
    } as any)],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: "builtin", customTools: [{
      name: "fixture_hold", label: "Fixture hold", description: "Local deterministic test only", parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        toolStarted = true;
        await new Promise<void>((resolve, reject) => {
          releaseTool = resolve;
          if (signal?.aborted) return reject(Error("fixture aborted"));
          signal?.addEventListener("abort", () => reject(Error("fixture aborted")), { once: true });
        });
        return { content: [{ type: "text" as const, text: "TOOL_DONE" }], details: {} };
      },
    }] });
  await session.bindExtensions({ mode: "rpc" });
  const unsubscribe = session.subscribe(event => { events.push(event); patches.push(...mapPiEventToPatches(event, ctx)); });
  const h = { session, events, patches, contexts, ctx, untilTool: () => until(() => toolStarted), release: () => releaseTool?.(), requests: () => requestCount };
  try {
    await scenario(h);
    assert(session.isIdle, "native session did not settle");
    assert(!session.messages.some((m: any) => m.role === "custom" && /completion_gate|request_user_input_recovery/.test(m.customType)), "host injected a control message");
    results.push({ name, passed: true, requests: requestCount, nativeEnds: events.filter(e => e.type === "agent_end").length,
      nativeSettled: events.filter(e => e.type === "agent_settled").length, uiEnds: patches.filter(e => e.type === "assistant_end").length });
    console.log("PASS native lifecycle " + name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), events: events.map(e => e.type), requests: requestCount });
    console.error("FAIL native lifecycle " + name + ": " + error);
  } finally { await session.abort(); unsubscribe(); session.dispose(); }
}

try {
  await test("plain-finish-with-incomplete-product-plan", async h => {
    await h.session.prompt("Finish naturally");
    assert.equal(h.requests(), 1); assert.equal(h.patches.filter((p: any) => p.type === "assistant_end").length, 1);
  }, { content: "Partial result; the optional plan is not complete.", blockedPlan: true });

  await test("printed-input-markup-does-not-restart-or-hang", async h => {
    await h.session.prompt("Return the fixture literal");
    assert.equal(h.requests(), 1); assert(h.session.isIdle);
  }, { content: '<request_user_input>{"title":"Fixture","kind":"confirm"}</request_user_input>' });

  await test("tool-wait-is-not-terminal", async h => {
    const run = h.session.prompt("Call the fixture then finish"); await h.untilTool();
    assert.equal(h.patches.filter((p: any) => p.type === "assistant_end").length, 0);
    assert(h.patches.some((p: any) => p.type === "tool_start"));
    h.release(); await run;
    assert.equal(h.requests(), 2); assert.equal(h.patches.filter((p: any) => p.type === "assistant_end").length, 1);
    assert.equal(h.events.at(-1).type, "agent_settled");
  });

  await test("native-retry-no-premature-ui-end", async h => {
    await h.session.prompt("Retry through Pi");
    assert.equal(h.requests(), 2); assert(h.events.some((e: any) => e.type === "auto_retry_start"));
    const ends = h.patches.filter((p: any) => p.type === "assistant_end"); assert.equal(ends.length, 1); assert(!ends[0].error);
  }, { failFirst: true, content: "RECOVERED" });

  await test("two-steers-and-follow-up-all-reach-native-loop", async h => {
    const run = h.session.prompt("initial"); await h.untilTool();
    await h.session.prompt("follow-up", { streamingBehavior: "followUp" });
    await h.session.prompt("steer-one", { streamingBehavior: "steer" });
    await h.session.prompt("steer-two", { streamingBehavior: "steer" });
    h.release(); await run;
    const users = h.session.messages.filter((m: any) => m.role === "user").map(text);
    assert.deepEqual(users, ["initial", "steer-one", "steer-two", "follow-up"]);
    assert.equal(h.events.filter((e: any) => e.type === "agent_settled").length, 1);
    assert.equal(h.patches.filter((e: any) => e.type === "assistant_end").length, 1);
  });

  await test("native-abort-during-tool-wait", async h => {
    const run = h.session.prompt("Wait for cancellation"); await h.untilTool();
    await h.session.abort(); await run;
    const requests = h.requests(); await wait(30); assert.equal(h.requests(), requests);
    assert.equal(h.patches.filter((e: any) => e.type === "assistant_end").length, 1);
    assert.equal(h.events.filter((e: any) => e.type === "agent_settled").length, 1);
  });
} finally {
  await mkdir("artifacts/pi-native-control", { recursive: true });
  await writeFile("artifacts/pi-native-control/native-lifecycle-results.json", JSON.stringify({ at: new Date().toISOString(), results, passed: results.every(r => r.passed) }, null, 2));
  await rm(root, { recursive: true, force: true });
}
process.exitCode = results.length === 6 && results.every(r => r.passed) ? 0 : 1;
