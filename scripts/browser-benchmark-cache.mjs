/** Only normalize reported cache counters; never infer a cold cache from absence. */
export function browserBenchmarkCache(usage) {
  // Preserve the existing Chat Completions priority. Responses-compatible usage
  // may expose input_tokens_details, while gateways may retain the flat counter.
  const raw = usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cache_read_input_tokens;
  const cacheReadTokens = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  return {
    cacheReadTokens,
    cacheState: cacheReadTokens === null ? "unknown"
      : cacheReadTokens === 0 ? "zero-cache-read-reported" : "cache-read-reported",
  };
}
