// Shared by the host bundle and the native CLI child. Provider adapters remain
// responsible for serialization; this counts the body they actually hand to fetch.
const HTTP_APIS = new Set([
  "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses",
  "anthropic-messages", "mistral-conversations", "pi-messages",
]);

/** @param {{ sent: (input: any, init?: any) => any, received: (attempt: any, status: number | null) => void }} [observer] */
export function createRequestTransport(model, options, validate, observer) {
  const limit = model.inputLimits?.maxRequestBytes;
  if (!HTTP_APIS.has(model.api)) {
    if (limit !== undefined) throw new Error(`模型 ${model.provider}/${model.id} 声明了请求大小限制，但 ${model.api} 尚不支持可校验的 HTTP 传输`);
    return {};
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Pi maxRequestBytes 必须为正整数");
  const fetch = options?.fetch ?? globalThis.fetch;
  const send = async (input, init) => {
    let attempt;
    try { attempt = observer?.sent(input, init); } catch { /* diagnostics cannot affect transport */ }
    try {
      const response = await fetch(input, init);
      try { observer?.received(attempt, response.status); } catch { /* diagnostics only */ }
      return response;
    } catch (error) {
      try { observer?.received(attempt, null); } catch { /* diagnostics only */ }
      throw error;
    }
  };
  return {
    ...(limit !== undefined && model.api === "openai-codex-responses" ? { transport: "sse" } : {}),
    fetch: async (input, init) => {
      await validate();
      if (limit === undefined) return send(input, init);
      const request = new Request(input, init);
      const reader = request.clone().body?.getReader();
      let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > limit) throw new Error(`模型请求体超过 ${limit} 字节限制`);
          }
        } catch (error) {
          // A tee's cancellation may wait for its other branch; never await it.
          void reader.cancel().catch(() => {});
          void request.body?.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      await validate();
      return send(request);
    },
  };
}
