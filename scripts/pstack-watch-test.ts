import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePstackSettings } from "../src/shared/pstack";
import { orderStack, WatcherQueryError } from "../src/main/agent/pstack/watch/github";
import { monitorPullRequests } from "../src/main/agent/pstack/watch/monitor";
import { assessFreshBuilds, type BuildHistory } from "../src/main/agent/pstack/watch/builds";
import { parsePrNumber, type Check, type GitHubReader, type PullRequestFacts } from "../src/main/agent/pstack/watch/types";
import { checkOriginWatcher } from "./pstack-origin-watch-fixture";

const target = { owner: "fixture", repo: "project", pr: 2 };
const seed = { owner: "fixture", repo: "project", number: parsePrNumber(2) };
const clock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => now, observedAt: () => new Date(now * 1000).toISOString(),
    sleep: async (seconds: number) => { sleeps.push(seconds); now += seconds; } };
};
function reader(_clock: ReturnType<typeof clock>, facts: (pr: number) => Partial<PullRequestFacts> = () => ({}),
  ci: () => "passed" | "pending" = () => "passed"): GitHubReader {
  return {
    async pullRequest(context) { return { context, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
      headRefOid: "fixture", headRefName: "feat", baseRefName: "main", state: "OPEN", mergedAt: null, isDraft: false, ...facts(context.number) }; },
    async checksFastPath() {
      const kind = ci();
      return { kind: "checks", checks: [{ kind, name: "unit", description: "", link: "", workflow: "",
        reportedState: kind === "passed" ? "SUCCESS" : "PENDING" } as Check] };
    },
    async reviewThreads() { return []; }, async checkRollupPage() { return { checks: [], endCursor: null }; },
    async commitRollups() { return [{ oid: "fixture", state: "SUCCESS" }]; },
    async openPullRequests() { return [
      { number: parsePrNumber(2), baseRefName: "feature1", headRefName: "feature2" },
      { number: parsePrNumber(1), baseRefName: "main", headRefName: "feature1" },
    ]; },
  };
}
const config = (book: string, parameters: Record<string, string | number | boolean>) => normalizePstackSettings({ playbooks: { [book]: { parameters } } });
async function suite() {
  const timer = clock();
  const adapter = { clock: timer, active: () => true, reader: reader(timer, () => ({}), () => timer.now() < 14 ? "pending" : "passed") };
  const normal = await monitorPullRequests(config("babysit", { intervalSeconds: 7 }), "babysit", target, adapter);
  assert.equal(normal.allowed, true);
  assert.equal(normal.verdict.kind, "READY");
  assert.deepEqual(timer.sleeps, [7, 7]);
  assert.equal(JSON.parse(normal.output).kind, "READY");

  const draft = { ...adapter, reader: reader(timer, () => ({ isDraft: true, mergeStateStatus: "DRAFT" })) };
  assert.equal((await monitorPullRequests(config("babysit", {}), "babysit", target, draft)).allowed, false);
  const draftAllowed = await monitorPullRequests(config("babysit", { allowDraft: true, pretty: true }), "babysit", target, draft);
  assert.equal(draftAllowed.allowed, true); assert.ok(draftAllowed.output.startsWith("READY"));
  assert.equal((await monitorPullRequests(config("shipping", {}), "shipping", target, adapter)).allowed, false, "open and ready is not proof of merge");
  const protectedBranch = { ...adapter, reader: reader(timer, () => ({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" })) };
  assert.equal((await monitorPullRequests(config("babysit", {}), "babysit", target, protectedBranch)).allowed, false);
  const status = await monitorPullRequests(config("babysit", { statusOnly: true }), "babysit", target, protectedBranch);
  assert.equal(status.verdict.kind, "STATUS");
  let runId = "771";
  const failedBuild = reader(timer);
  failedBuild.checksFastPath = async () => ({ kind: "checks", checks: [{ kind: "failed", reportedState: "FAILURE", workflow: "CI",
    name: "unit", link: "https://github.com/fixture/project/actions/runs/" + runId + "/job/23", description: "" }] });
  const observe = () => monitorPullRequests(config("babysit", { statusOnly: true }), "babysit", target, { ...adapter, reader: failedBuild });
  const first = (await observe()).findings;
  assert.equal(first[0]?.run, "771");
  const history: BuildHistory[] = [];
  const classification = { ...first[0]!, classification: "infrastructure" as const, evidence: "Runner log recorded an unavailable executor." };
  assert.equal(assessFreshBuilds(history, first, 1)[0]?.disposition, "classify-before-fresh-build");
  assert.equal(assessFreshBuilds(history, first, 0, classification)[0]?.disposition, "budget-exhausted");
  assert.equal(assessFreshBuilds(history, first, 1, classification)[0]?.disposition, "fresh-build-reserved");
  assert.equal(assessFreshBuilds(history, (await observe()).findings, 1, classification)[0]?.disposition, "already-reserved-await-distinct-build");
  runId = "812";
  const repeated = (await observe()).findings;
  assert.throws(() => assessFreshBuilds(history, repeated, 2, classification), /currently observed/);
  assert.equal(assessFreshBuilds(history, repeated, 2)[0]?.disposition, "reclassify-read-child-logs");
  const unrelatedFailure = { ...repeated[0]!, check: "windows", run: "939" };
  const secondClassification = { ...classification, ...unrelatedFailure };
  assert.equal(assessFreshBuilds(history, [unrelatedFailure], 1, secondClassification)[0]?.disposition, "budget-exhausted");
  assert.equal(assessFreshBuilds(history, [unrelatedFailure], 2, secondClassification)[0]?.disposition, "fresh-build-reserved");

  const stack = await monitorPullRequests(config("babysit", { watchMode: "stack" }), "babysit", target, adapter);
  assert.deepEqual(stack.prs, [1, 2]); assert.equal(stack.verdict.kind, "READY");
  const queue = await monitorPullRequests(config("babysit", { watchMode: "queued-stack" }), "babysit", target, adapter);
  assert.equal(queue.verdict.kind, "WAITING"); assert.equal(queue.allowed, true);
  assert.throws(() => orderStack(seed, [{ number: seed.number, headRefName: "a", baseRefName: "b" },
    { number: parsePrNumber(1), headRefName: "b", baseRefName: "a" }]), /Cyclic/);

  const shippingClock = clock();
  const visits: [number, number][] = [];
  const shippingReader = reader(shippingClock, pr => {
    visits.push([pr, shippingClock.now()]);
    return shippingClock.now() >= (pr === 1 ? 12 : 18) ? { state: "MERGED", mergedAt: "today" } : {};
  });
  const shipping = await monitorPullRequests(config("shipping", { watchMode: "queued-stack", intervalSeconds: 3, sweepIntervalSeconds: 9 }), "shipping",
    { ...target, queue: [1, 2] }, { ...adapter, reader: shippingReader, clock: shippingClock });
  assert.equal(shipping.verdict.kind, "COMPLETE");
  assert.deepEqual([...new Set(visits.filter(([pr, sec]) => pr === 2 && sec < 12).map(([, sec]) => sec))], [0, 9], "whole queue sweeps and frontier-only polls must differ");

  const slow = clock();
  const timeout = await monitorPullRequests(config("babysit", { timeoutSeconds: 3, intervalSeconds: 60 }), "babysit", target,
    { ...adapter, clock: slow, reader: reader(slow, () => ({}), () => "pending") });
  assert.equal(timeout.verdict.kind, "TIMEOUT"); assert.deepEqual(slow.sleeps, [3]);
  let attempts = 0;
  const broken = { ...reader(slow), async pullRequest() { attempts++; throw new WatcherQueryError({ kind: "command-exit", code: 1, retryable: true, detail: "temporary fixture failure" }); } };
  const failed = await monitorPullRequests(config("babysit", { maxQueryErrors: 2, intervalSeconds: 1 }), "babysit", target, { ...adapter, clock: slow, reader: broken });
  assert.equal(failed.verdict.kind, "BLOCKER"); assert.equal(attempts, 2);
  assert.ok(failed.progress.some(v => v.kind === "RETRY"));
  await checkOriginWatcher();
  assert.match((await monitorPullRequests(config("babysit", { forge: "origin" }), "babysit", target,
    { ...adapter, origin: async () => { throw new Error("Origin CLI is unavailable"); } })).output, /Origin CLI is unavailable/);
  await assert.rejects(monitorPullRequests(config("babysit", {}), "babysit", { ...target, repo: "--help" }, adapter), /repository name/);
  await assert.rejects(monitorPullRequests(config("babysit", {}), "babysit", target, { ...adapter, active: () => false }), /no longer active/);
  for (const stopBy of ["disable", "abort"]) {
    const cancellation = new AbortController();
    let enabled = true, polls = 0;
    const sleeping = reader(timer, () => ({}), () => {
      polls++;
      setTimeout(() => { if (stopBy === "disable") enabled = false; else cancellation.abort(); }, 15);
      return "pending";
    });
    const pending = monitorPullRequests(config("babysit", { intervalSeconds: 60 }), "babysit", target, {
      reader: sleeping, signal: cancellation.signal, active: () => enabled,
    });
    await assert.rejects(pending);
    assert.equal(polls, 1, "A cancelled or disabled run must not query again");
  }

  // Exercise the real child-process adapter from a clean, credential-free CLI environment.
  // GitHub CLI rejects auth locally before the first HTTP request; missing gh is also a typed gap.
  const dir = await mkdtemp(path.join(os.tmpdir(), "mybuddy-pstack-gh-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, GH_HOST: "github.com" };
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
    const output = execFileSync(process.execPath, [...process.execArgv, process.argv[1], "--isolated-gh"], { env, encoding: "utf8", timeout: 15_000 });
    assert.match(output, /isolated GitHub CLI reported a capability gap/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  console.log("PASS native pstack PR watcher, read-only CLI capability gap, config, retry, stack order, queue frontier, timeout and status");
}
if (process.argv.includes("--isolated-gh")) {
  const result = await monitorPullRequests(config("babysit", { maxQueryErrors: 1, timeoutSeconds: 4 }), "babysit", target,
    // Exercise the real CLI without conflating host scheduling with watch policy.
    // The parent process watchdog still bounds the complete probe.
    { active: () => true, clock: clock() });
  assert.equal(result.verdict.kind, "BLOCKER"); assert.equal(result.allowed, false);
  console.log("isolated GitHub CLI reported a capability gap");
} else await suite();
