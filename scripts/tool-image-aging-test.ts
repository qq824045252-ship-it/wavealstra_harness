import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stream as responsesStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { EphemeralContextProjection } from "../src/main/agent/EphemeralContextProjection";

// Actual product hooks, Pi loop and Responses serializer. Synthetic images only;
// no desktop actions, network, credentials or real user history.
const root = mkdtempSync(join(tmpdir(), "mybuddy-image-prefix-"));
const model: Model<any> = {
  id: "image-prefix-fixture", provider: "fixture", api: "openai-responses", name: "Fixture",
  baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text", "image"],
  contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==";
const countImages = (messages: Context["messages"]) => messages.reduce((n, m) => n +
  (Array.isArray(m.content) ? m.content.filter(p => (p as { type: string }).type === "image").length : 0), 0);

async function main() {
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  for (const value of Object.values(config)) {
    if (value && typeof value === "object" && "enabled" in value) value.enabled = false;
  }
  config.execution = { terminalEnabled: false, codeExecutionEnabled: false };
  const capabilityRuntime = new BuiltinCapabilityRuntime({
    store: { read: () => structuredClone(config), write: next => structuredClone(next) },
    credentials: { has: () => false, get: () => null, set: () => undefined, clear: () => undefined },
  });
  const manager = SessionManager.inMemory(root);
  manager.appendCustomMessageEntry("mybuddy_completion_gate", "retired directive", false);
  manager.appendCustomMessageEntry("mybuddy_request_user_input_recovery", "retired continuation", false, { answer: "keep this answer" });
  const projection = new EphemeralContextProjection({
    enabled: () => false, scope: () => ({ taskId: "image-prefix-fixture" }),
    supplementalEvidence: () => [{ id: "project", revision: "1", kind: "project", text: "STABLE_EVIDENCE", validate() {} }],
    registerRequestGuard: () => {}, log: () => {},
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 256 },
    retry: { enabled: false, maxRetries: 0 },
  });
  const requests: Context[] = [];
  let previous: { input: unknown[]; base: unknown } | undefined;
  let failure: unknown, requestInTurn = 0, summaryCalls = 0, screenshots = 0, transportCalls = 0;
  const response = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const runtime = {
    hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }), getModel: () => model,
    streamSimple: (_model: Model<any>, context: Context) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          let message: AssistantMessage;
          if (!getCurrentTools(context.messages).length) {
            summaryCalls++;
            message = response([{ type: "text", text: "Earlier screenshots reviewed. Continue the task." }], "stop");
          } else {
            requests.push(structuredClone(context));
            let payload: any;
            await responsesStream(model, normalizeContext(context), {
              apiKey: "offline-fixture", sessionId: manager.getSessionId(),
              onPayload: value => { payload = value; throw new Error("OFFLINE_CAPTURE"); },
              fetch: async () => { transportCalls++; throw new Error("NETWORK_FORBIDDEN"); },
            }).result();
            assert(payload, "must reach the real Responses serializer");
            const { input, ...base } = payload;
            if (previous) {
              assert.deepEqual(input.slice(0, previous.input.length), previous.input,
                "new screenshots must extend the preceding wire request, never replace old images");
              assert.deepEqual(base, previous.base, "system/tools/cache key/request options remain stable within a turn");
            }
            previous = { input, base };
            assert(!JSON.stringify(context.messages).includes("retired directive"));
            assert.equal(JSON.stringify(context.messages).split("STABLE_EVIDENCE").length - 1, 1);
            requestInTurn++;
            assert(requestInTurn <= 7, "fixture loop must finish");
            message = requestInTurn <= 6
              ? response([{ type: "toolCall", id: `screen-${screenshots}`, name: "fixture_screenshot", arguments: {} }], "toolUse")
              : response([{ type: "text", text: "Screenshots verified." }], "stop");
          }
          output.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        } catch (error) {
          failure = error;
          output.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "FIXTURE_FAILED" }], "stop") });
        }
        output.end();
      })();
      return output;
    },
  } as unknown as ModelRuntime;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      createConversationRuntimeExtension({ resolveContext: () => undefined, interaction: {} as never, goal: {} as never }),
      createBuiltinCapabilityExtension({ taskId: "image-prefix-fixture", taskRoot: root, runtime: capabilityRuntime,
        browser: { available: false } as never, artifactService: () => null,
        getProducerMessageId: () => undefined, getIsolationLevel: () => "guarded" }),
      projection.extension,
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, noTools: "builtin",
    customTools: [{ name: "fixture_screenshot", label: "Screenshot fixture", description: "Synthetic screenshot only",
      parameters: Type.Object({}), execute: async () => {
        screenshots++;
        return { content: [{ type: "text", text: `Screenshot ${screenshots}. ` + "Fixture evidence. ".repeat(80) },
          { type: "image", data: png, mimeType: "image/png" }], details: {} };
      } }],
  });
  projection.attach(session);
  await session.bindExtensions({ mode: "rpc" });
  try {
    for (let turn = 1; turn <= 2; turn++) {
      requestInTurn = 0; previous = undefined;
      await session.prompt(`Review six screenshots, turn ${turn}.`, { images: [{ type: "image", data: png, mimeType: "image/png" }] });
      if (failure) throw failure;
      assert.equal(requestInTurn, 7);
      assert.equal(countImages(requests.at(-1)!.messages), turn * 7, "all images, including user attachments, survive ordinary continuations");
    }
    const beforeCompact = countImages(requests.at(-1)!.messages);
    await session.compact();
    assert(summaryCalls > 0, "native compaction still summarizes screenshot history");
    assert.equal(manager.getBranch().filter(e => e.type === "compaction").length, 1);
    requestInTurn = 0; previous = undefined;
    const offset = requests.length;
    await session.prompt("Continue after the explicit compaction boundary.");
    if (failure) throw failure;
    assert(countImages(requests[offset].messages) < beforeCompact, "native compaction retires earlier images");
    assert.equal(countImages(requests.at(-1)!.messages), countImages(requests[offset].messages) + 6);
    assert.equal(manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length, 18,
      "compaction preserves canonical tool history");
    assert.equal(transportCalls, 0);
    console.log(`PASS image prefix: ${requests.length} real Pi continuations, 18 screenshots, user images, legacy projection, capsule, native compaction; no network`);
  } finally { session.dispose(); }
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
