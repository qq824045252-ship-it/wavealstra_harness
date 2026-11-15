import assert from "node:assert/strict";
import { normalizeContext, type Model, type Provider, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { deepseekAssistantMetadata, deepseekCitationMarkdown, deepseekHostedToolRows } from "../src/shared/deepseek";

const answer = "🧭原文证据支持回答。";
const source = { url: "https://example.com/native-protocol", title: "原文来源", snippet: "display-only source snippet" };
const search = { type: "web_search_call", id: "srv-search", status: "completed", kind: "search", action: { type: "search", queries: ["fixture"], sources: [source] } };
const read = { type: "web_search_call", id: "srv-read", status: "completed", kind: "read_link", action: { type: "open_page", url: source.url },
  page: source, signature: "provider-page-signature+/=原样" };
const responseReasoning = { type: "reasoning", id: "rs_fixture", summary: [], content: [{ type: "reasoning_text", text: "Check the source." }] };
const responseText = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer,
  annotations: [{ type: "url_citation", ...source, start_index: 0, end_index: 5 }] }] };
const responseFunction = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture", arguments: "{}", status: "completed" };
const serverUse = { type: "server_tool_use", id: "srv-anthropic", name: "deepseek_read_url", input: { action: "read_link", url: source.url }, caller: { type: "direct" }, kind: "read_link" };
const serverResult = { type: "web_fetch_tool_result", tool_use_id: "srv-anthropic", content: { type: "web_fetch_result", url: source.url,
  content: { type: "document", source: { type: "text", media_type: "text/plain", data: "" }, title: source.title } }, kind: "read_link", signature: "anthropic-page-signature+/=原样" };
const anthropicThinking = { type: "thinking", thinking: "Check the source.", signature: "thinking-signature" };
const anthropicText = { type: "text", text: answer, citations: [{ type: "web_search_result_location", url: source.url, title: source.title, encrypted_index: "", cited_text: answer }] };
const anthropicFunction = { type: "tool_use", id: "call_anthropic", name: "fixture", input: {} };

function responseFixture(functionCall: boolean): { response: Response; output: unknown[] } {
  const output = [responseReasoning, search, read, functionCall ? responseFunction : responseText];
  let sequence = 0;
  const events: any[] = [{ type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, status: "in_progress",
      ...(item.type === "message" ? { content: [] } : item.type === "reasoning" ? { content: [], summary: [] } : {}) } });
    if (item.type === "reasoning") events.push({ type: "response.reasoning_text.delta", output_index, delta: "Check the source." });
    if (item.type === "message") events.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: answer });
    if (item.type === "web_search_call") events.push({ type: "response.web_search_call.searching", output_index, item_id: item.id });
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output,
    usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20, server_tool_use: { tool_search: 1, tool_fetch: 1 } } } });
  return { output, response: new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }) };
}

function anthropicFixture(functionCall: boolean): { response: Response; output: unknown[] } {
  const output = [anthropicThinking, serverUse, serverResult, functionCall ? anthropicFunction : anthropicText];
  const events: any[] = [{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "deepseek-flash", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } }];
  for (const [index, item] of output.entries()) {
    events.push({ type: "content_block_start", index, content_block: item.type === "text" ? { type: "text", text: "" }
      : item.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : item });
    if (item.type === "thinking") {
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: anthropicThinking.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: anthropicThinking.signature } });
    }
    if (item.type === "text") {
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: answer } });
      events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation: anthropicText.citations[0] } });
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push({ type: "message_delta", delta: { stop_reason: functionCall ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 12, server_tool_use: { tool_search: 0, tool_fetch: 1 } } }, { type: "message_stop" });
  return { output, response: new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) };
}

export async function verifyDeepSeekProtocols(native: Provider<any>, baseModel: Model<any>, context: TranscriptContext, files: TranscriptContext): Promise<void> {
  for (const api of ["openai-responses", "anthropic-messages"] as const) {
    const target = { ...baseModel, api, baseUrl: api === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com" };
    let body: any;
    let headers: Headers;
    let uploads = 0;
    const makeFixture = api === "openai-responses" ? responseFixture : anthropicFixture;
    const options: StreamOptions = { apiKey: "protocol-fixture-key", maxRetries: 0, maxTokens: 128, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/files") { uploads++; return Response.json({ id: "file-protocol", expires_at: Math.floor(Date.now() / 1000) + 86400 }); }
      body = await request.json(); headers = request.headers;
      assert(!JSON.stringify(body).includes("mybuddy-deepseek-"), "identity markers never reach any native transport");
      return makeFixture(false).response;
    } };
    const events: any[] = [];
    const stream = native.streamSimple(target, context, options);
    for await (const event of stream) events.push({ type: event.type, rows: "partial" in event ? deepseekHostedToolRows(event.partial, true) : [] });
    const first = await stream.result();
    assert.equal(first.stopReason, "stop", first.errorMessage);
    assert.equal(first.content.filter(item => item.type === "toolCall").length, 0);
    assert.equal(first.content.filter(item => item.type === "text").map(item => item.text).join(""), answer, "heartbeat blocks never enter the final transcript");
    assert(events.some(event => event.rows.some((row: any) => row.status === "running")));
    const metadata = deepseekAssistantMetadata(first)!;
    assert.deepEqual(api === "openai-responses" ? metadata.responsesOutput : metadata.anthropicContent, makeFixture(false).output);
    assert.equal(metadata.serverToolUsage?.tool_fetch, 1);
    assert.match(deepseekCitationMarkdown(first), /对应回答：.*🧭/u, "citation offsets count code points and preserve emoji");
    const rows = deepseekHostedToolRows(first);
    assert(rows.every(row => row.status === "success" && row.webSearch?.sources.length));
    assert(!JSON.stringify(rows).includes("page-signature"));
    assert(body.tools.some((tool: any) => tool.type === "deepseek_read_url" && (api !== "anthropic-messages" || tool.name === "deepseek_read_url")));

    const history = normalizeContext({ messages: [...context.messages, JSON.parse(JSON.stringify(first)), { role: "user", content: "Continue", timestamp: 20 }] });
    const before = JSON.stringify(history);
    assert.equal((await native.streamSimple(target, history, options).result()).stopReason, "stop");
    if (api === "openai-responses") {
      const start = body.input.findIndex((item: any) => item.type === "reasoning");
      assert.deepEqual(body.input.slice(start, start + makeFixture(false).output.length), makeFixture(false).output);
    } else assert.deepEqual(body.messages.find((item: any) => item.role === "assistant").content, makeFixture(false).output);
    assert.equal(JSON.stringify(history), before, "native replay is immutable");
    await native.streamSimple(target, history, { ...options, apiKey: "different-account" }).result();
    assert(!JSON.stringify(body).includes("page-signature"), "opaque page context is credential-scoped");

    const local = await native.streamSimple(target, context, { ...options, fetch: async () => makeFixture(true).response }).result();
    assert.equal(local.stopReason, "toolUse", local.errorMessage);
    const call = local.content.find(item => item.type === "toolCall")!;
    assert.equal(call.name, "fixture");
    const followup = normalizeContext({ messages: [...context.messages, local, { role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "local fixture result" }], isError: false, timestamp: 21 }, { role: "user", content: "Now answer", timestamp: 22 }] });
    await native.streamSimple(target, followup, options).result();
    if (api === "openai-responses") {
      assert.deepEqual(body.input.find((item: any) => item.type === "function_call"), responseFunction);
      assert.equal(body.input.find((item: any) => item.type === "function_call_output").call_id, responseFunction.call_id);
    } else {
      assert.deepEqual(body.messages.find((item: any) => item.role === "assistant").content, makeFixture(true).output);
      assert(body.messages.some((item: any) => item.content?.some?.((part: any) => part.type === "tool_result" && part.tool_use_id === anthropicFunction.id)));
    }

    const fileResponse = await native.streamSimple(target, files, options).result();
    assert.equal(fileResponse.stopReason, "stop", fileResponse.errorMessage);
    const fileBlocks = (body.input ?? body.messages).filter((item: any) => item.role === "user").flatMap((item: any) => item.content);
    assert(fileBlocks.some((part: any) => api === "openai-responses" ? part.type === "input_file" && part.file_id : part.type === "document" && part.source.file_id));
    if (api === "anthropic-messages") {
      assert.match(headers!.get("anthropic-beta") ?? "", /files-api-2025-04-14/);
      assert.equal(uploads, 0, "the same official file receipt is reused across protocols with the same key");
    } else assert.equal(uploads, 1);
    assert(deepseekHostedToolRows(fileResponse).some(row => row.tool === "deepseek_file_upload" && row.status === "success"));
    console.log(`PASS native ${api}: raw replay, local functions, live hosted rows, citations and Files`);
  }
}
