// Shared by the host bundle and the native CLI child. Provider adapters remain
// responsible for serialization; this counts the body they actually hand to fetch.
const HTTP_APIS = new Set([
  "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses",
  "anthropic-messages", "mistral-conversations", "pi-messages",
]);

export function createRequestTransport(model, options, validate) {
  const limit = model.inputLimits?.maxRequestBytes;
  if (!HTTP_APIS.has(model.api)) {
    if (limit !== undefined) throw new Error(`模型 ${model.provider}/${model.id} 声明了请求大小限制，但 ${model.api} 尚不支持可校验的 HTTP 传输`);
    return {};
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Pi maxRequestBytes 必须为正整数");
  const fetch = options?.fetch ?? globalThis.fetch;
  return {
    ...(limit !== undefined && model.api === "openai-codex-responses" ? { transport: "sse" } : {}),
    fetch: async (input, init) => {
      await validate();
      if (limit === undefined) return fetch(input, init);
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
      return fetch(request);
    },
  };
}
