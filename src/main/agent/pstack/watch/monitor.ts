import { setTimeout as delay } from "node:timers/promises";
import type { PstackSettings } from "../../../../shared/pstack";
import { discoverStack, GhGitHubReader, WatcherQueryError } from "./github";
import { queryBackoffSeconds, runQueued, runSimple, statusQueryVerdict, verdictFactory, type WatchClock } from "./policy";
import { renderJson, renderPretty } from "./render";
import { failedBuilds, type BuildFinding } from "./builds";
import { chooseForge, originCommand, OriginReader, type ForgeScope, type OriginCommand } from "./origin";
import { monitorOrigin } from "./originMonitor";
import type { PrSnapshot } from "./types";
import { nonEmpty, parsePrNumber, type GitHubReader, type NonEmpty, type PollingOptions, type PrContext, type ProgressVerdict, type WatchMode, type WatcherVerdict } from "./types";

export type WatchBook = "babysit" | "shipping";
export interface WatchTarget { owner: string; repo: string; pr: number; queue?: number[] }
export interface WatchScope { repository: string; prs: number[] }
export interface WatchAdapter {
  signal?: AbortSignal;
  active: () => boolean;
  reader?: GitHubReader;
  origin?: OriginCommand;
  cwd?: string;
  chosen?: ForgeScope;
  pin?: (scope: ForgeScope) => Promise<ForgeScope>;
  clock?: WatchClock;
  freeze?: (scope: WatchScope) => Promise<WatchScope>;
}

/** GitHub input stays data even when values come from an untrusted model response. */
export function watchSeed(target: WatchTarget, originNamespace = false): PrContext {
  const ownerPattern = originNamespace ? /^[a-z\d][\w.-]*$/i : /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i;
  if (!ownerPattern.test(target.owner) ||
      !/^[a-z\d_][\w.-]*$/i.test(target.repo) || target.repo === "." || target.repo === "..") {
    throw new Error("Specify a valid repository owner and repository name.");
  }
  return { owner: target.owner, repo: target.repo, number: parsePrNumber(target.pr) };
}

class FrontierObserved {
  verdict: ProgressVerdict;
  constructor(verdict: ProgressVerdict) { this.verdict = verdict; }
}

function nativeClock(signal: AbortSignal): WatchClock {
  return { now: () => performance.now() / 1000, observedAt: () => new Date().toISOString(),
    sleep: async seconds => { await delay(Math.min(seconds * 1000, 2_147_483_647), undefined, { signal }); } };
}

export async function monitorPullRequests(settings: PstackSettings, book: WatchBook, target: WatchTarget, adapter: WatchAdapter) {
  const p = settings.playbooks[book].parameters;
  const mode = p.watchMode as WatchMode;
  const seed = watchSeed(target, p.forge !== "github");
  const explicit = target.queue?.map(n => parsePrNumber(n));
  if (explicit && (mode !== "queued-stack" || !explicit.includes(seed.number) || new Set(explicit).size !== explicit.length)) {
    throw new Error("A frozen queue must be a unique, bottom-to-top queued-stack list containing the target PR.");
  }
  const options: PollingOptions = {
    interval: Number(p.intervalSeconds), sweepInterval: Number(p.sweepIntervalSeconds),
    timeout: Number(p.timeoutSeconds), maxQueryErrors: Number(p.maxQueryErrors), allowDraft: p.allowDraft === true,
  };
  const controller = new AbortController();
  const signal = adapter.signal ? AbortSignal.any([adapter.signal, controller.signal]) : controller.signal;
  const clock = adapter.clock ?? nativeClock(signal);
  const reader = adapter.reader ?? new GhGitHubReader(signal);
  const started = clock.now();
  const deadline = options.timeout ? started + options.timeout : Infinity;
  const deadlineError = new Error("watch deadline reached");
  function check() {
    signal.throwIfAborted();
    if (!adapter.active()) throw new Error("Pstack watch is no longer active.");
    if (clock.now() >= deadline) throw deadlineError;
  }
  // Interrupt an in-flight CLI request as well as waits when the task is deactivated.
  const timer = setInterval(() => {
    if (!adapter.active()) controller.abort(new Error("Pstack watch was disabled."));
    else if (clock.now() >= deadline) controller.abort(deadlineError);
  }, 250);
  timer.unref();
  const observed: ProgressVerdict[] = [];
  const builds = new Map<number, BuildFinding[]>();
  const scopedClock: WatchClock = { now: clock.now, observedAt: clock.observedAt, sleep: async seconds => {
    check(); await clock.sleep(Math.min(seconds, Math.max(0, deadline - clock.now()))); check();
  }};
  const stamp = verdictFactory(clock, mode);
  let discoveryAttempts = 0;
  const discover = async (): Promise<NonEmpty<PrContext>> => {
    for (let attempt = 1; ; attempt++) {
      check();
      discoveryAttempts = attempt;
      try { return await discoverStack(reader, seed); } catch (error) {
        if (!(error instanceof WatcherQueryError) || !error.failure.retryable || attempt >= options.maxQueryErrors) throw error;
        const retryInSeconds = queryBackoffSeconds(options.interval, attempt);
        if (observed.length === 8) observed.shift();
        observed.push(stamp({ kind: "RETRY", terminal: false, failure: error.failure, consecutiveFailures: attempt, retryInSeconds }));
        await scopedClock.sleep(retryInSeconds);
      }
    }
  };
  let contexts: NonEmpty<PrContext> = [seed];
  let verdict: WatcherVerdict;
  const statusOnly = p.statusOnly === true || (book === "babysit" && (p.mode === "check" || p.mode === "threads-only"));
  try {
    check();
    const origin = adapter.origin ?? originCommand(signal);
    const initial = seed.owner + "/" + seed.repo;
    const selected = adapter.chosen ?? await chooseForge(adapter.reader && !adapter.origin && p.forge === "auto" ? "github" : p.forge,
      initial, origin, adapter.cwd, signal);
    const binding = adapter.pin ? await adapter.pin(selected) : selected;
    if (binding.forge === "origin")
      return await monitorOrigin(new OriginReader(origin, binding.repository), seed.number, explicit, mode, book, options,
        statusOnly, p.pretty === true, scopedClock, check, () => signal.reason === deadlineError || clock.now() >= deadline, adapter.freeze);
    watchSeed(target);
    contexts = nonEmpty((explicit ?? []).map(number => ({ ...seed, number }))) ??
      (mode === "single" ? [seed] : await discover());
    if (adapter.freeze && mode === "queued-stack") {
      const frozen = await adapter.freeze({ repository: seed.owner + "/" + seed.repo, prs: contexts.map(p => p.number) });
      contexts = nonEmpty(frozen.prs.map(pr => ({ ...seed, number: parsePrNumber(pr) }))) ?? [seed];
    }
    const emit = (event: ProgressVerdict) => {
      check();
      if (observed.length === 8) observed.shift();
      observed.push(event);
      if (book === "babysit" && event.kind === "WAITING" && event.reason.kind === "merge-queue") throw new FrontierObserved(event);
    };
    const dependencies = { reader, clock: scopedClock, emit,
      observe: (snapshot: PrSnapshot) => { if (book === "babysit") builds.set(snapshot.context.number, failedBuilds(snapshot)); } };
    verdict = mode === "queued-stack" && !statusOnly
      ? await runQueued({ dependencies, contexts, options })
      : await runSimple({ dependencies, contexts, options, mode, statusOnly });
    check();
  } catch (error) {
    if (error instanceof FrontierObserved) verdict = error.verdict;
    else if (error === deadlineError || signal.reason === deadlineError) {
      verdict = stamp({ kind: "TIMEOUT", terminal: true, exitCode: 5, reason: { kind: "watch-deadline" } });
    } else if (error instanceof WatcherQueryError) verdict = statusQueryVerdict(stamp, Math.max(1, discoveryAttempts), error.failure);
    else throw error;
  } finally { clearInterval(timer); controller.abort(); }
  const ready = verdict.kind === "READY" && (book === "babysit" ||
    (verdict.scope.kind === "single" ? verdict.scope.pr.kind === "merged-pr" : verdict.scope.prs.every(pr => pr.kind === "merged-pr")));
  const allowed = ready || verdict.kind === "COMPLETE" || (verdict.kind === "STATUS" && statusOnly) ||
    (book === "babysit" && verdict.kind === "WAITING" && verdict.reason.kind === "merge-queue");
  const format = p.pretty ? renderPretty : renderJson;
  return { forge: "github" as const, repository: seed.owner + "/" + seed.repo, prs: contexts.map(c => c.number as number), allowed, verdict,
    mergedSnapshot: verdict.kind === "STATUS" && verdict.terminal && verdict.rows.every(row => row.kind === "merged"),
    output: format(verdict), findings: [...builds.values()].flat(), progress: observed.map(v => ({ kind: v.kind, observedAt: v.observedAt })) };
}
