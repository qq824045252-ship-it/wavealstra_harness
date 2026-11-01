import type { RecognitionServiceConfig } from "../../shared/builtin-capabilities";

/** Used by both recognition adapters; deliberately no retries for billable requests. */
export async function recognitionRequest(config: RecognitionServiceConfig, secret: string | null, body: BodyInit, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error("cancelled: recognition cancelled");
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.search || !["http:", "https:"].includes(url.protocol)) throw new Error("configuration: endpoint must be an HTTP URL without credentials/query");
  if (config.dataPolicy === "local-only" && config.location !== "local") throw new Error("policy: local-only refuses network/cloud upload");
  const timeout = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST", body, redirect: "error",
      headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`${response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate-limit" : response.status === 413 ? "limit" : "http"}: status ${response.status}`);
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw new Error("cancelled: recognition cancelled");
    if (timeout.aborted) throw new Error("timeout: recognition timed out");
    // Do not echo response bodies, URLs or request headers (may contain secrets).
    if (error instanceof Error && /^(authentication|rate-limit|limit|http):/.test(error.message)) throw error;
    throw new Error("transport: recognition request failed");
  }
}
