import assert from "node:assert/strict";
import { normalizeContext, createProvider, envApiKeyAuth, type Model, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { commandCodeProvider } from "../src/main/agent/providers/command-code";

const provider = commandCodeProvider({ createProvider, envApiKeyAuth }, {
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
  "openai-completions": openAICompletionsApi(),
});
const model = provider.getModels!().find(m => m.id === "deepseek/deepseek-v4.1-flash")!;
assert(model);
const context = normalizeContext({ messages: [{ role: "user", content: "Reply OK", timestamp: 1 }] });

async function capture(target: Model<any>, simple: boolean, extra: StreamOptions = {}, transcript: TranscriptContext = context) {
  let body: any;
  const options = {
    apiKey: "fixture-key", maxRetries: 0,
    reasoning: "max" as const, reasoningEffort: "max" as const,
    ...extra,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      body = await new Request(input, init).json();
      // Fail exactly as the upstream decoder does, after native serialization.
      if (target.id === model.id && "summary" in (body.reasoning ?? {})) {
        return new Response(JSON.stringify({ error: { message: 'json: unknown field "summary"' } }), { status: 400 });
      }
      if (target.id === model.id && body.input?.some((item: any) => item.content?.some?.((part: any) => part.text === ""))) {
        return new Response(JSON.stringify({ error: { message: 'missing `input.content.text` parameter' } }), { status: 400 });
      }
      return new Response('data: ' + JSON.stringify({ type: "response.completed", response: {
        id: "resp_fixture", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  };
  const stream = simple ? provider.streamSimple(target, transcript, options) : provider.stream(target, transcript, options);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  return body;
}

for (const simple of [false, true]) {
  const body = await capture(model, simple);
  assert.deepEqual(body.reasoning, { effort: "max" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
}
let callbackCalls = 0;
const replacement = { stream: true, reasoning: { effort: "high", summary: "detailed" }, metadata: { summary: "keep" } };
const replaced = await capture(model, false, { onPayload: () => { callbackCalls++; return replacement; } });
assert.equal(callbackCalls, 1);
assert.deepEqual(replaced, { stream: true, reasoning: { effort: "high" }, metadata: { summary: "keep" } });
assert.equal(replacement.reasoning.summary, "detailed", "must not mutate caller-owned payload");
const mutated = await capture(model, true, { onPayload: payload => {
  (payload as any).reasoning = { effort: "low", summary: "auto" };
} });
assert.deepEqual(mutated.reasoning, { effort: "low" });
const other = await capture({ ...model, id: "gpt-5.6-sol" }, true);
assert.equal(other.reasoning.summary, "auto", "unaffected models retain native summaries");
const capped = await capture(model, true, { maxTokens: 512 });
assert.equal(capped.max_output_tokens, 512);
const unknownLimit = { ...model, commandCode: { ...(model as any).commandCode, defaultedFields: ["maxTokens"], catalogMaxTokens: model.maxTokens } };
const uncapped = await capture(unknownLimit, true);
assert(!("max_output_tokens" in uncapped), "preserve existing unpublished output-limit policy");

// Gemini tool-use turns can persist an empty trailing text block. Replaying the
// original history through Pi must retain the tool pair without sending empties.
const history: TranscriptContext = normalizeContext({ messages: [
  ...context.messages,
  { role: "assistant", api: "google-vertex", provider: "google-vertex", model: "gemini-3.1-pro-preview",
    content: [{ type: "toolCall", id: "call_fixture", name: "read", arguments: { path: "fixture.txt" } }, { type: "text", text: "" }],
    stopReason: "toolUse", timestamp: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
  { role: "toolResult", toolCallId: "call_fixture", toolName: "read", content: [{ type: "text", text: "fixture content" }], isError: false, timestamp: 3 },
  { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "Continue" }], timestamp: 4 },
] });
const originalHistory = JSON.stringify(history);
const continued = await capture(model, true, {}, history);
assert(continued.input.some((item: any) => item.type === "function_call"));
assert(continued.input.some((item: any) => item.type === "function_call_output" && item.output === "fixture content"));
assert(continued.input.some((item: any) => item.role === "user" && item.content.some((part: any) => part.text === "Continue")));
assert(!continued.input.some((item: any) => Array.isArray(item.content) && item.content.length === 0));
assert.equal(JSON.stringify(history), originalHistory, "request normalization must never change persisted history");

if (process.env.MYBUDDY_COMMAND_CODE_LIVE === "1") {
 const fs = await import("node:fs"), path = await import("node:path"), os = await import("node:os");
 const apiKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".mybuddy/auth.json"), "utf8")).commandcode.key;
 let wire: unknown;
 const stream = provider.streamSimple(model, history, {apiKey, reasoning: "max", maxRetries: 0, signal: AbortSignal.timeout(45000), fetch: async (input, init) => {
   const request = new Request(input, init); const body = await request.clone().json() as any;
   wire = { reasoning: body.reasoning, types: body.input.map((item: any) => item.type ?? item.role), emptyTextParts: body.input.flatMap((item: any) => item.content ?? []).filter((part: any) => part.text === "").length };
   return fetch(request);
 }});
 const result = await stream.result();
 console.log(JSON.stringify({wire, stopReason:result.stopReason, error:result.errorMessage, text:result.content.filter(x=>x.type==="text").map(x=>x.text).join("").slice(0,120)}));
 assert.equal(result.stopReason, "stop", result.errorMessage);
 const next = await provider.streamSimple(model, normalizeContext({ messages: [...history.messages, result,
   { role: "user", content: "Reply exactly OK again.", timestamp: Date.now() },
 ] }), { apiKey, reasoning: "max", maxRetries: 0, signal: AbortSignal.timeout(45000) }).result();
 assert.equal(next.stopReason, "stop", next.errorMessage);
 console.log("PASS live second turn with native reasoning history");
}
console.log("PASS Command Code request and cross-provider history regressions");
