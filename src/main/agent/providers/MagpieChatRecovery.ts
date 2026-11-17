import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

const ambiguousIndex = "Ambiguous streamed tool call index; provider must send a stable call id";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Reuse Pi's parser for usage, reasoning, tool arguments and finish semantics.
 * Only a complete response provides an unambiguous order to assign indices. */
function wholeCompletionAsEvent(body: unknown): string {
  const completion = asRecord(body);
  const choice = Array.isArray(completion?.choices) && completion.choices.length === 1
    ? asRecord(completion.choices[0]) : undefined;
  const message = asRecord(choice?.message);
  if (!choice || message?.role !== "assistant" || typeof choice.finish_reason !== "string" || !choice.finish_reason)
    throw new Error("Magpie did not return a complete Chat Completions response");
  const delta = { ...message };
  if (message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls)) throw new Error("Invalid tool calls in complete Magpie response");
    const ids = new Set<string>();
    delta.tool_calls = message.tool_calls.map((value, index) => {
      const call = asRecord(value);
      const fn = asRecord(call?.function);
      const custom = asRecord(call?.custom);
      if (!call || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
        || !(call.type === "function" && typeof fn?.name === "string" && fn.name.trim() && typeof fn.arguments === "string"
          || call.type === "custom" && typeof custom?.name === "string" && custom.name.trim() && typeof custom.input === "string"))
        throw new Error("Invalid tool call identity or payload in complete Magpie response");
      ids.add(call.id);
      return { ...call, index };
    });
  }
  if (choice.finish_reason === "tool_calls" && !(Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))
    throw new Error("Missing tool calls in complete Magpie response");
  const chunk = { ...completion, object: "chat.completion.chunk", choices: [{
    index: 0, delta, finish_reason: choice.finish_reason, usage: choice.usage,
  }] };
  return "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n";
}

function requestWholeChat(send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const payload = asRecord(await request.json());
    if (!payload || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
      throw new Error("Expected a Magpie Chat Completions request for recovery");
    payload.stream = false;
    delete payload.stream_options;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("accept", "application/json");
    const response = await send(new Request(request, { headers, body: JSON.stringify(payload) }));
    if (!response.ok) return response;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Magpie returned another stream for a non-streaming request");
    }
    const event = wholeCompletionAsEvent(await response.json());
    request.signal.throwIfAborted();
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete("content-length");
    resultHeaders.delete("content-encoding");
    resultHeaders.set("content-type", "text/event-stream");
    return new Response(event, { status: response.status, headers: resultHeaders });
  };
}

function recoveryFailure(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "aborted") return { ...message, content: [] };
  return { ...message, content: [], errorMessage: "Magpie 工具调用流编号冲突，完整响应重试失败。请更换模型后从失败处继续。" };
}

/** Recover only this Magpie protocol error, within the current model turn.
 * Neither the partial nor an error result can schedule a tool in Pi Durable. */
export function magpieChatRecovery(native: ProviderStreams): ProviderStreams {
  const wrap = (method: "stream" | "streamSimple"): ProviderStreams["streamSimple"] =>
    (model, context, options) => {
      const first = native[method](model, context, options);
      const output = createAssistantMessageEventStream();
      void (async () => {
        let needsRecovery = false;
        try {
          for await (const event of first) {
            if (event.type === "error" && event.error.stopReason === "error"
              && event.error.errorMessage === ambiguousIndex && !options?.signal?.aborted) {
              needsRecovery = true;
              continue;
            }
            output.push(event);
          }
          if (!needsRecovery) return;
          options?.signal?.throwIfAborted();
          const fallback = native[method](model, context, {
            ...options, maxRetries: 0, fetch: requestWholeChat(options?.fetch ?? globalThis.fetch),
          });
          for await (const event of fallback) {
            // The first request already started the visible response. Do not mix a second
            // set of partial deltas into it; the final message replaces the failed attempt.
            if (event.type === "error") output.push({ ...event, error: recoveryFailure(event.error) });
            else if (event.type === "done") output.push(event);
          }
        } catch (error) {
          const aborted = options?.signal?.aborted ?? false;
          const message = recoveryFailure({
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            stopReason: aborted ? "aborted" : "error",
            errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          });
          output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        } finally {
          output.end();
        }
      })();
      return output;
    };
  return { stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}
