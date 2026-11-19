import type { PollingOptions, WatchMode } from "./types";
import { queryBackoffSeconds, type WatchClock } from "./policy";
import type { WatchScope } from "./monitor";
import type { OriginReader, OriginRow } from "./origin";

type Outcome = "ORIGIN_STATUS" | "ORIGIN_MERGEABLE" | "ORIGIN_MERGED" | "ORIGIN_BLOCKED" | "ORIGIN_TIMEOUT";
export async function monitorOrigin(reader: OriginReader, pr: number, explicit: number[] | undefined, mode: WatchMode, book: "babysit" | "shipping",
  options: PollingOptions, statusOnly: boolean, pretty: boolean, clock: WatchClock, check: () => void, deadlineReached: () => boolean,
  freeze?: (scope: WatchScope) => Promise<WatchScope>) {
  let prs: number[] = [], attempts = 0, nextSweep = 0;
  const rows = new Map<number, OriginRow>(), progress: { kind: string; observedAt: string }[] = [];
  const result = (kind: Outcome, detail?: string) => {
    const verdict = { kind, observedAt: clock.observedAt(), rows: prs.flatMap(n => rows.get(n) ?? []), ...(detail && { detail }) };
    const output = pretty ? [kind + " " + reader.repository, ...verdict.rows.map(r => "#" + r.pr + " " + r.status + " " + r.head +
      (r.unresolvedThreads === null ? "" : " | unresolved threads " + r.unresolvedThreads) + (r.blockers.length ? " | " + r.blockers.join(", ") : "")), detail].filter(Boolean).join("\n")
      : JSON.stringify(verdict);
    return { forge: "origin" as const, repository: reader.repository, prs, allowed: ["ORIGIN_STATUS", "ORIGIN_MERGED", "ORIGIN_MERGEABLE"].includes(kind),
      verdict, output, findings: [], progress, mergedSnapshot: kind === "ORIGIN_STATUS" && prs.length > 0 && prs.every(n => rows.get(n)?.status === "merged") };
  };
  try {
    for (;;) {
      check();
      try {
        if (!prs.length) {
          const discovered = explicit ?? (mode === "single" ? [pr] : await reader.stack(pr));
          prs = freeze && mode === "queued-stack" ? (await freeze({ repository: reader.repository, prs: discovered })).prs : discovered;
        }
        const frontier = prs.find(n => rows.get(n)?.status !== "merged") ?? prs[0];
        const sweep = rows.size !== prs.length || mode !== "queued-stack" || clock.now() >= nextSweep;
        for (const n of sweep ? prs : [frontier]) { check(); rows.set(n, await reader.snapshot(n, options.allowDraft)); }
        check();
        attempts = 0;
        if (sweep) nextSweep = clock.now() + options.sweepInterval;
        if (statusOnly) return result("ORIGIN_STATUS");
        if (prs.every(n => rows.get(n)?.status === "merged")) return result("ORIGIN_MERGED");
        const outstanding = prs.map(n => rows.get(n)!).filter(r => r.status !== "merged");
        const relevant = mode === "queued-stack" ? outstanding.slice(0, 1) : outstanding;
        if (relevant.some(r => ["closed", "draft", "blocked"].includes(r.status))) return result("ORIGIN_BLOCKED");
        if (book === "babysit" && relevant.every(r => r.status === "mergeable")) return result("ORIGIN_MERGEABLE");
        if (progress.length === 8) progress.shift();
        progress.push({ kind: "ORIGIN_WAITING", observedAt: clock.observedAt() });
      } catch (error) {
        check();
        const message = error instanceof Error ? error.message : String(error);
        if (++attempts >= options.maxQueryErrors || /CLI is unavailable|access is unavailable|inconsistent stack|branched, incomplete|pagination token/.test(message))
          return result("ORIGIN_BLOCKED", message);
        if (progress.length === 8) progress.shift();
        progress.push({ kind: "ORIGIN_RETRY", observedAt: clock.observedAt() });
      }
      await clock.sleep(attempts ? queryBackoffSeconds(options.interval, attempts) : options.interval);
    }
  } catch (error) {
    if (deadlineReached()) return result("ORIGIN_TIMEOUT", "watch deadline reached");
    throw error;
  }
}
