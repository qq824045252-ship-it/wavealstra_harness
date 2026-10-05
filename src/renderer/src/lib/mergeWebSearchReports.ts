import type { ToolCall } from "../types";
import type { WebSearchReport, WebSearchSource } from "@shared/web-search";

/** Combine display data only; persisted calls retain every round and provider result. */
export function mergeWebSearchReports(calls: ToolCall[]): WebSearchReport {
  const reports = calls.flatMap(call => call.webSearch ? [call.webSearch] : []);
  if (!reports.length) throw new Error("A search group must contain a report");
  const runs = calls.flatMap(call => (call.webSearch?.runs ?? []).map(run =>
    call.status !== "running" && (run.status === "running" || run.status === "queued")
      ? { ...run, status: "cancelled" as const, error: run.error ?? "搜索已中断，保留已收到结果" }
      : run,
  ));
  const sources = new Map<string, WebSearchSource>();
  for (const report of reports) for (const source of report.sources) {
    const key = source.canonicalUrl ?? source.url;
    const previous = sources.get(key);
    if (!previous) { sources.set(key, source); continue; }
    const preferred = previous.evidence === "page" && source.evidence !== "page" ? previous : source;
    const origins = [...new Map([...(previous.origins ?? []), ...(source.origins ?? [])]
      .map(origin => [JSON.stringify(origin), origin])).values()];
    sources.set(key, { ...preferred, origins, fetchError: preferred.evidence === "page" ? undefined : preferred.fetchError });
  }
  const evidence = [...new Map(reports.flatMap(report => report.evidence ?? []).map(item => [
    JSON.stringify({ ...item, citations: item.citations.map(({ url, quote, kind, stance }) => ({ url, quote, kind, stance })) }), item,
  ])).values()];
  const live = calls.some(call => call.status === "running" && call.webSearch?.status === "running");
  const interrupted = calls.some(call => call.status !== "running" && call.webSearch?.status === "running");
  const status: WebSearchReport["status"] = live ? "running"
    : reports.every(report => report.status === "complete") ? "complete"
    : reports.every(report => report.status === "cancelled") || (interrupted && runs.every(run => run.status === "cancelled")) ? "cancelled"
    : sources.size === 0 && reports.every(report => report.status === "error") ? "error" : "partial";
  return {
    version: 1, id: reports[0].id, status,
    queries: [...new Set(reports.flatMap(report => report.queries))], runs,
    sources: [...sources.values()], evidence,
    notice: [...new Set(reports.flatMap(report => report.notice ? [report.notice] : []))].join("\n") || undefined,
  };
}
