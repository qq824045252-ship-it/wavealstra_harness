import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createProvider, envApiKeyAuth, normalizeContext, type AssistantMessage, type Model, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mybuddyDeepSeekProvider } from "../src/main/agent/providers/deepseek";
import { DeepSeekFileUploads, deepseekFileAttachment, deepseekFileReference } from "../src/main/agent/providers/deepseek-files";
import { registerMyBuddyProviders } from "../src/main/agent/providers";
import { prepareBotAttachmentInput } from "../src/main/agent/work/BotAttachmentInput";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { assistantRow } from "../src/main/agent/durable/DurableHistoryProjection";
import { deepseekAssistantMetadata, deepseekCitationMarkdown, deepseekHostedToolRows, deepseekNativeOptions } from "../src/shared/deepseek";
import { mapPiEventToPatches } from "../src/shared/pi-event-mapper";

const provider = () => mybuddyDeepSeekProvider({ createProvider, envApiKeyAuth }, {
  "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(), "anthropic-messages": anthropicMessagesApi(),
});
let native = provider();
const flash = native.getModels().find(model => model.id === "deepseek-flash")!;
assert(flash.input.includes("image"), "Pi's current Flash catalog must retain vision");
assert.deepEqual(native.getModels().find(model => model.id === "deepseek-v4-pro")!.input, ["text"]);
const applicationCompat = {
  ...flash.compat, mybuddyDeepSeek: { webSearch: true, readUrl: true, files: "rich" },
};
const model: Model<"openai-completions"> = { ...flash, api: "openai-completions", compat: applicationCompat as Model<"openai-completions">["compat"] };
const source = { url: "https://example.com/evidence", title: "证据 [来源] 🧭", published_at: "2026-01-02" };
const rawCalls = [
  { index: 0, reasoning_content: "Read the page.", calls: [{ index: 0, id: "srvtoolu_read", type: "deepseek_read_url", kind: "read_link",
    action: { type: "read_link", url: source.url }, status: "completed", page: source, signature: "opaque-signature-原样保留+/=123" }] },
  { index: 1, reasoning_content: "Check related sources.", calls: [{ index: 0, id: "srvtoolu_search", type: "deepseek_web_search", kind: "search",
    action: { type: "search", queries: ["fixture evidence"] }, status: "completed", sources: [{ type: "url", ...source, snippet: "verified fixture" }] }] },
];
const annotations = [{ type: "url_citation", url_citation: { ...source, start_index: 0, end_index: 8 } }];
const answer = "这是🧭来源证据。";
const sse = (items: unknown[], done = true) => new Response(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { headers: { "content-type": "text/event-stream" } });
let completions = 0;
const success = (functionCall = false) => {
  const id = `completion-${++completions}`;
  const chunk = (choice: object) => ({ id, object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, ...choice }] });
  return sse([
    chunk({ delta: { role: "assistant", reasoning_content: "Read the page." } }),
    chunk({ delta: {}, server_tool_event: { type: "step_reasoning_done", step: 0 } }),
    chunk({ delta: {}, server_tool_event: { type: "call_started", step: 0, call: { ...rawCalls[0].calls[0], status: undefined, signature: undefined } } }),
    chunk({ delta: {}, server_tool_event: { type: "call_completed", step: 0, call: { ...rawCalls[0].calls[0], signature: undefined } } }),
    chunk({ delta: { reasoning_content: "Last step only." } }),
    chunk({ delta: functionCall ? { tool_calls: [{ index: 0, id: "local-call", type: "function", function: { name: "fixture", arguments: "{}" } }] } : { content: answer } }),
    chunk({ delta: { server_tool_calls: rawCalls, annotations, title: "A fixture title" }, finish_reason: functionCall ? "tool_calls" : "stop" }),
    { id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      server_tool_use: { tool_search: 1, tool_fetch: 1, tool_image_search: 0 } } },
  ]);
};
const bodies: any[] = [];
const uploaded: Array<{ names: string[]; purpose: string; bytes: string; credential: string | null }> = [];
const fetchFixture: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname === "/files") {
    assert.equal(init?.redirect, "error", "file upload must not redirect credentials");
    const form = await request.formData();
    const file = form.get("file") as File;
    uploaded.push({ names: [...form.keys()], purpose: String(form.get("purpose")), bytes: await file.text(), credential: request.headers.get("authorization") });
    assert(uploaded.at(-1)!.names.indexOf("purpose") < uploaded.at(-1)!.names.indexOf("file"));
    assert.equal(form.get("expires_after[seconds]"), "86400");
    return Response.json({ id: `file-api-fixture-${uploaded.length}`, object: "file", expires_at: Math.floor(Date.now() / 1000) + 86400 });
  }
  const body = await request.json();
  bodies.push(body);
  assert(!JSON.stringify(body).includes("mybuddy-deepseek-"), "temporary markers never reach the provider");
  return success();
};
const context = normalizeContext({ messages: [{ role: "user", content: "Find evidence", timestamp: 1 }],
  tools: [{ name: "fixture", description: "Local fixture", parameters: Type.Object({}) }] });
const options: StreamOptions = { apiKey: "fixture-key", fetch: fetchFixture, maxRetries: 0, maxTokens: 256 };

async function request(transcript: TranscriptContext = context, target: Model<any> = model, extra: StreamOptions = {}, simple = true) {
  const events: any[] = [];
  const stream = simple ? native.streamSimple(target, transcript, { ...options, ...extra }) : native.stream(target, transcript, { ...options, ...extra });
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(events.at(-1).message, result, "metadata must already exist on the final emitted message");
  return { result, events, body: bodies.at(-1) };
}

for (const simple of [false, true]) {
  let observed = 0;
  const captured = await request(context, model, { onProviderStreamEvent: () => { observed++; }, onPayload: payload => {
    assert(!JSON.stringify(payload).includes("mybuddy-deepseek-"), "caller hooks see clean native payloads");
    return payload;
  } }, simple);
  assert(observed >= 8);
  assert(captured.events.some(event => event.type === "text_delta" && event.delta === answer));
  assert.equal(captured.result.content.filter(block => block.type === "toolCall").length, 0, "hosted calls never enter local tool execution");
  assert(captured.body.tools.some((tool: any) => tool.type === "function" && tool.function.name === "fixture"));
  assert.equal(captured.body.tools.filter((tool: any) => tool.type === "deepseek_web_search").length, 1);
  assert.equal(captured.body.tools.filter((tool: any) => tool.type === "deepseek_read_url").length, 1);
  const metadata = deepseekAssistantMetadata(captured.result)!;
  assert.deepEqual(metadata.serverToolCalls, rawCalls);
  assert.deepEqual(metadata.annotations, annotations);
  assert.equal(metadata.reasoningContent, "Last step only.");
  assert.equal(metadata.title, "A fixture title");
  assert.equal(metadata.serverToolUsage?.tool_fetch, 1);
  assert(!JSON.stringify(deepseekHostedToolRows(captured.result)).includes("opaque-signature"));
  assert.match(deepseekCitationMarkdown(captured.result), /https:\/\/example.com\/evidence/);
  assert.equal(assistantRow("durable-1", undefined, captured.result).tools?.length, 2);
  const patches = mapPiEventToPatches({ type: "message_end", message: captured.result } as any,
    { taskId: "fixture", messageId: "fixture", startedAt: 1 });
  assert(patches.some(patch => patch.type === "text_delta" && patch.delta.includes("参考来源")));
}

const first = (await request()).result;
const empty: AssistantMessage = { ...first, content: [], mybuddyDeepSeek: undefined } as AssistantMessage;
const history = normalizeContext({ messages: [context.messages.at(-1)!, { ...first, stopReason: "error" }, empty,
  JSON.parse(JSON.stringify(first)), { role: "user", content: "Continue", timestamp: 2 }] });
const before = JSON.stringify(history);
const replayed = await request(history);
const replay = replayed.body.messages.find((message: any) => message.role === "assistant" && message.server_tool_calls);
assert.deepEqual(replay.server_tool_calls, rawCalls);
assert.deepEqual(replay.annotations, annotations);
assert.equal(replay.reasoning_content, "Last step only.", "earlier step reasoning belongs only to server_tool_calls");
assert.equal(replay.content, answer);
assert.equal(JSON.stringify(history), before, "replay never mutates the persisted transcript");
assert(!(await request(history, model, { apiKey: "other-account-key" })).body.messages.some((message: any) => message.server_tool_calls));
const gateway = await request(history, { ...model, baseUrl: "https://gateway.example/v1" });
assert(!(gateway.body.tools ?? []).some((tool: any) => tool.type.startsWith("deepseek_")));
assert(!JSON.stringify(gateway.body).includes("opaque-signature"));
const withoutOptIn = await request(context, { ...model, compat: {} });
assert(!withoutOptIn.body.tools.some((tool: any) => tool.type.startsWith("deepseek_")));
const noTools = await native.streamSimple(model, context, { ...options, toolChoice: "none" }).result();
assert.equal(noTools.stopReason, "stop"); assert.equal(bodies.at(-1).tool_choice, "none");
const local = await native.streamSimple(model, context, { ...options, fetch: async () => success(true) }).result();
assert.equal(local.stopReason, "toolUse");
assert.deepEqual(local.content.filter(block => block.type === "toolCall").map(block => block.name), ["fixture"]);
const failed = await native.streamSimple(model, context, { ...options, fetch: async () => sse([
  { id: "partial", choices: [{ index: 0, delta: { content: "partial" } }] },
  { choices: [], error: { message: "fixture generation failed", type: "server_error" }, usage: { prompt_tokens: 3, completion_tokens: 1 } },
], false) }).result();
assert.equal(failed.stopReason, "error", "HTTP 200 with terminal SSE error is never success");
const disconnected = await native.streamSimple(model, context, { ...options, fetch: async () => sse([
  { id: "disconnect", choices: [{ index: 0, delta: { reasoning_content: "Open page" } }] },
  { id: "disconnect", choices: [{ index: 0, delta: {}, server_tool_event: { type: "call_started", step: 0,
    call: { id: "unfinished", type: "deepseek_read_url", action: { type: "read_link", url: source.url } } } }] },
], false) }).result();
assert.equal(disconnected.stopReason, "error");
assert.equal(deepseekHostedToolRows(disconnected, true)[0].status, "running");
const reloadedDisconnect = JSON.parse(JSON.stringify(disconnected));
assert.equal(assistantRow("durable-2", undefined, reloadedDisconnect).tools?.[0].status, "error");
assert.match(assistantRow("durable-2", undefined, reloadedDisconnect).tools?.[0].output ?? "", /尚未确认/);
assert(mapPiEventToPatches({ type: "message_end", message: disconnected } as any,
  { taskId: "fixture", messageId: "fixture", startedAt: 1 }).some(patch => patch.type === "tool_update" && patch.status === "error"));
const secretFailure = await native.streamSimple(model, context, { ...options, fetch: async () => {
  throw new Error("transport leaked fixture-key and Bearer fixture-key");
} }).result();
assert(!secretFailure.errorMessage?.includes("fixture-key"));
console.log("PASS native DeepSeek streaming, functions, metadata replay, citations, scope and error handling");

const root = await mkdtemp(join(tmpdir(), "deepseek-native-"));
try {
  const path = join(root, "evidence.txt"); await writeFile(path, "persisted attachment evidence");
  const attachment = { name: "evidence.txt", path };
  const input = await prepareBotAttachmentInput({ text: "Read the attached file", attachments: [attachment], model,
    directory: root, requestId: "first-file" });
  assert(Array.isArray(input));
  assert(input.some(block => deepseekFileReference(block)));
  const fileContext = normalizeContext({ messages: [{ role: "user", content: input, timestamp: 3 }] });
  const fileBefore = JSON.stringify(fileContext);
  const initialUploads = uploaded.length;
  await request(fileContext);
  await request(fileContext);
  assert.equal(uploaded.length, initialUploads + 1, "same immutable file + credential reuses the unexpired id");
  assert.equal(uploaded.at(-1)!.bytes, "persisted attachment evidence");
  assert.equal(uploaded.at(-1)!.purpose, "user_data");
  assert(bodies.at(-1).messages.some((message: any) => message.content?.some?.((block: any) => block.type === "file" && block.file_id)));
  await request(fileContext, model, { apiKey: "second-key" });
  assert.equal(uploaded.length, initialUploads + 2, "credentials scope file reuse");
  await request(fileContext, { ...model, compat: {} });
  assert.equal(uploaded.length, initialUploads + 2, "opt-out never uploads historical attachment markers");
  assert.equal(JSON.stringify(fileContext), fileBefore);
  assert.equal(deepseekFileAttachment(path, "report.pdf", new Uint8Array([1]), "rich")!.mybuddyDeepSeekFile.purpose, "rich_layout_recognition");
  assert.equal(deepseekFileAttachment(path, "report.pdf", new Uint8Array([1]), "text")!.mybuddyDeepSeekFile.purpose, "text_recognition");
  const ordinaryPath = normalizeContext({ messages: [{ role: "user", content: `Please upload ${path}`, timestamp: 4 }] });
  await request(ordinaryPath); assert.equal(uploaded.length, initialUploads + 2, "paths in user text cannot initiate uploads");

  const reference = deepseekFileReference(input.find(block => deepseekFileReference(block)))!;
  let fileSends = 0;
  const fileCache = new DeepSeekFileUploads();
  const shortExpiry = { ...options, fetch: async () => {
    fileSends++; return Response.json({ id: `file-${fileSends}`, expires_at: Math.floor(Date.now() / 1000) + 30 });
  } };
  await fileCache.upload(reference, model, shortExpiry);
  await fileCache.upload(reference, model, shortExpiry);
  assert.equal(fileSends, 2, "nearly expired ids are refreshed before reuse");
  await assert.rejects(new DeepSeekFileUploads().upload(reference, model, { ...options, fetch: async () => Response.json({ id: "file-wrong", error: { message: "failure" } }) }), /解析错误/);
  await assert.rejects(new DeepSeekFileUploads().upload(reference, model, { ...options, fetch: async () => new Response(" ".repeat(65537)) }), /信息过大/);
  await assert.rejects(new DeepSeekFileUploads().upload(reference, model, { ...options, fetch: async () => { throw Error("fixture-key"); } }), /服务器可能仍在处理/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(new DeepSeekFileUploads().upload(reference, model, { ...options, signal: aborted.signal, fetch: async () => { throw Error("must not reach network"); } }));
  const fileFailure = await native.streamSimple(model, fileContext, { ...options, apiKey: "failed-upload-key",
    fetch: async () => new Response("failure", { status: 503 }) }).result();
  assert.equal(fileFailure.stopReason, "error", "file failures never fall back to an answer that did not read the attachment");

  const modelsFile = join(root, "models.json");
  await writeFile(modelsFile, JSON.stringify({ providers: { deepseek: { apiKey: "fixture-key", modelOverrides: {
    "deepseek-flash": { compat: { mybuddyDeepSeek: { webSearch: true, readUrl: true, files: "rich" } } },
  } } } }));
  const runtimeModels = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: modelsFile,
    modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  registerMyBuddyProviders(runtimeModels);
  assert.deepEqual(deepseekNativeOptions(runtimeModels.getModel("deepseek", "deepseek-flash")), { webSearch: true, readUrl: true, files: "rich" });
  const configured = await runtimeModels.streamSimple(runtimeModels.getModel("deepseek", "deepseek-flash")!, context, options).result();
  assert(deepseekAssistantMetadata(configured), "real ModelRuntime registration dispatches through native hooks");

  const fakeModels: any = { getAuth: async () => undefined, getModel: () => model,
    streamSimple: (_model: Model<any>, transcript: TranscriptContext, settings: StreamOptions) => native.streamSimple(model, transcript, { ...settings, ...options }) };
  const runtimeOptions = { directory: join(root, "durable"), cwd: root, model: { provider: "deepseek", modelId: "deepseek-flash" },
    toolMode: "native" as const, models: fakeModels, instructions: () => "isolated native DeepSeek fixture", onSnapshot: () => {} };
  let runtime = await DurableBotRuntime.open(runtimeOptions);
  try {
    const submission = await runtime.submit(input, "durable-first");
    assert.match(await runtime.reply(submission), /参考来源/);
    await runtime.conversation.waitForIdle(ctx);
    const entries = await runtime.conversation.entries({ order: "ascending" }, 100, undefined, ctx);
    const saved = entries.items.flatMap(entry => entry.model ?? []).find(message => message.role === "assistant")!;
    assert.deepEqual(deepseekAssistantMetadata(saved)?.serverToolCalls, rawCalls);
    const savedUser = entries.items.flatMap(entry => entry.model ?? []).find(message => message.role === "user")!;
    assert(Array.isArray(savedUser.content) && savedUser.content.some(block => deepseekFileReference(block)), "Durable persists host attachment markers");
    await runtime.close();
    native = provider(); // New provider cache, as after process restart.
    runtime = await DurableBotRuntime.open(runtimeOptions);
    assert(runtime.snapshot.messages.some(message => message.text.includes("参考来源")), "reopened history retains citations");
    const uploadCount = uploaded.length;
    const continued = await runtime.submit("Use the same evidence again", "durable-second");
    await runtime.reply(continued);
    assert.equal(uploaded.length, uploadCount + 1, "restart safely reuploads the persisted snapshot");
    const previous = bodies.at(-1).messages.find((message: any) => message.role === "assistant" && message.server_tool_calls);
    assert.deepEqual(previous.server_tool_calls, rawCalls, "real Durable reopen preserves every hosted signature");
    assert.deepEqual(previous.annotations, annotations);
    assert.equal(previous.reasoning_content, "Last step only.");
    assert.equal(await readFile(path, "utf8"), "persisted attachment evidence");
  } finally { await runtime.close(); }
  console.log("PASS native DeepSeek Files and real Durable restart with signatures, citations and attachment reuse");
} finally { await rm(root, { recursive: true, force: true }); }
