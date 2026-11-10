import type { SearchProviderRun, WebSearchSource } from "../../../shared/web-search";
import type { ExtractedContent } from "./extract";

/** Strip only known tracking fields. Keep semantic query parameters and fragments. */
export function canonicalSearchUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return value; }
}
export function mergeSearchSources(runs: SearchProviderRun[], limit = 60): WebSearchSource[] {
  const merged = new Map<string, { source: WebSearchSource; score: number }>();
  for (const run of runs) for (const [i, item] of run.results.entries()) {
    if (!/^https?:\/\//i.test(item.url)) continue;
    const key = canonicalSearchUrl(item.url);
    const origin = { query: run.query, provider: run.provider, rank: i + 1, url: item.url };
    const existing = merged.get(key);
    if (existing) {
      if (!existing.source.origins!.some(o => o.provider === origin.provider && o.query === origin.query)) {
        existing.source.origins!.push(origin);
        existing.score += 1 / (60 + i + 1);
      }
      if (!existing.source.snippet && item.snippet) existing.source.snippet = item.snippet;
    } else merged.set(key, { source: { ...item, canonicalUrl: key, origins: [origin], evidence: item.evidence ?? "snippet" }, score: 1 / (60 + i + 1) });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.source);
}
export interface SearchReply { answer: string; results: WebSearchSource[]; inlineContent?: ExtractedContent[] }
export interface SearchBatchOptions {
  signal?: AbortSignal; providerTimeoutMs: number; totalTimeoutMs: number;
  onUpdate?: (runs: SearchProviderRun[]) => void;
  run: (provider: string, signal: AbortSignal) => Promise<SearchReply>;
}
/** Real deadlines also bound providers which fail to observe AbortSignal. Late completions never publish. */
export async function runSearchBatch(query: string, providers: string[], options: SearchBatchOptions): Promise<{ runs: SearchProviderRun[]; replies: Map<string, SearchReply> }> {
  options.signal?.throwIfAborted();
  const runs: SearchProviderRun[] = providers.map(provider => ({ query, provider, status: "running", durationMs: 0, results: [], answer: "" }));
  const replies = new Map<string, SearchReply>();
  const publish = () => { try { options.onUpdate?.(structuredClone(runs)); } catch { /* observer cannot cancel searches */ } };
  publish();
  await Promise.all(runs.map(async item => {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(options.signal?.reason); reject(new Error("Search cancelled")); };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) { onAbort(); return; }
        timer = setTimeout(() => { controller.abort(); reject(new Error("Search deadline exceeded")); }, Math.min(options.providerTimeoutMs, options.totalTimeoutMs));
      });
      const reply = await Promise.race([deadline, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return options.run(item.provider, controller.signal); })]);
      item.results = reply.results.filter(r => /^https?:\/\//i.test(r.url)).slice(0, 20).map(r => ({ ...r, title: r.title.slice(0, 600), snippet: r.snippet.slice(0, 3000) }));
      item.answer = reply.answer.slice(0, 12000);
      if (reply.answer.length > 12000) item.answerTruncated = true;
      item.status = item.results.length ? "success" : "empty";
      replies.set(item.provider, { ...reply, answer: item.answer, results: item.results });
    } catch (error) {
      item.status = options.signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "error";
      // Provider messages may contain credential-bearing URLs. Never serialize headers/configuration.
      item.error = (error instanceof Error ? error.message : String(error)).replace(/(?:Bearer\s+|(?:api[_-]?key|token|key)=)[^\s&"']+/gi, "[redacted]").slice(0, 500);
    } finally {
      clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      item.durationMs = Date.now() - started;
      publish();
    }
  }));
  return { runs, replies };
}

/** Availability is local discovery, not a provider request. Bound hung credential/model discovery too. */
export async function probeSearchAvailability(providers: string[], check: (provider: string) => Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<Array<{ provider: string; available: boolean; error?: string }>> {
  return Promise.all(providers.map(async provider => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => reject(new Error("availability-timeout")), Math.max(1, timeoutMs));
      });
      return { provider, available: await Promise.race([deadline, Promise.resolve().then(() => check(provider))]) };
    } catch (error) {
      signal?.throwIfAborted();
      return { provider, available: false, error: error instanceof Error && error.message === "availability-timeout" ? "可用性检查超时" : "可用性检查失败" };
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }));
}
