import type { PrSnapshot } from "./types";
import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";

export type BuildFinding = { repository: string; pr: number; head: string; workflow: string; check: string; run: string; job?: string };
export type BuildClassification = "flake" | "infrastructure" | "stale-base" | "code";
export type BuildClaim = BuildFinding & { classification: BuildClassification; evidence: string };
export type BuildHistory = { finding: BuildFinding; observed: string[]; claims: string[] };

/** Verify a proposed fresh build against the live failing run and one exact failed-job log line.
 * Keep raw CI logs out of the conversation and durable state. */
export async function verifyBuildEvidence(finding: BuildFinding, evidence: string, signal?: AbortSignal) {
  if (!/^\d+$/.test(finding.run) || !/^[\w.-]+\/[\w.-]+$/.test(finding.repository)) throw new Error("Invalid GitHub build identity.");
  const opts = { cwd: dirname(process.execPath), windowsHide: true, timeout: 30_000, signal,
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" } };
  const repo = ["--repo", finding.repository];
  const read = await promisify(execFile)("gh", ["run", "view", finding.run, ...repo, "--json", "headSha,jobs"], { ...opts, maxBuffer: 4 * 1024 * 1024 });
  const run = z.object({ headSha: z.string(), jobs: z.array(z.object({ databaseId: z.number().int().positive(), name: z.string(), conclusion: z.string() })) }).parse(JSON.parse(read.stdout));
  const jobs = run.jobs.filter(job => (finding.job ? String(job.databaseId) === finding.job : job.name === finding.check)
    && /^(failure|timed_out|cancelled|action_required|startup_failure)$/i.test(job.conclusion));
  if (run.headSha !== finding.head || jobs.length !== 1) throw new Error("GitHub did not confirm this failed job on the observed PR head.");
  const jobId = String(jobs[0]!.databaseId);
  const clean = (line: string) => line.replace(/^(?:[^\t]*\t){2}\d{4}-\d\d-\d\dT\S+\s*/, "").trim();
  if (!clean(evidence)) throw new Error("Quote one nonempty failed-job log line as evidence.");
  const child = spawn("gh", ["run", "view", ...repo, "--job", jobId, "--log-failed"], { ...opts, stdio: ["ignore", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let matched = false;
  lines.on("line", line => { if (clean(line) === clean(evidence)) matched = true; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => lines.close());
  if (code !== 0 || !matched) throw new Error("Quote one exact line from the failing GitHub job log before reserving a fresh build.");
  return { run: finding.run, job: jobId, head: run.headSha };
}

export function failedBuilds(snapshot: PrSnapshot): BuildFinding[] {
  if (snapshot.kind !== "open" || snapshot.ci.kind !== "ci-failing" || !snapshot.facts.headRefOid) return [];
  const { owner, repo, number } = snapshot.context, repository = (owner + "/" + repo).toLowerCase();
  return snapshot.ci.failed.flatMap(check => {
    let url: URL;
    try { url = new URL(check.link); } catch { return []; }
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\/?$/i.exec(url.pathname);
    if (url.protocol !== "https:" || url.host !== "github.com" || match?.[1]?.toLowerCase() !== repository) return [];
    return [{ repository, pr: number as number, head: snapshot.facts.headRefOid!, workflow: check.workflow, check: check.name, run: match[2]!,
      ...(match[3] && { job: match[3] }) }];
  });
}

const key = (f: BuildFinding) => JSON.stringify([f.repository, f.pr, f.head, f.workflow, f.check]);

/** A claim reserves one candidate for a fresh build. Polling and job reruns cannot consume another.
 * Only a distinct GitHub Actions run is evidence that a fresh build really happened. */
export function assessFreshBuilds(history: BuildHistory[], findings: BuildFinding[], budget: number, claim?: BuildClaim) {
  if (claim && !findings.some(f => key(f) === key(claim) && f.run === claim.run))
    throw new Error("The requested CI classification does not match a currently observed failing check, PR head and build.");
  return findings.map(finding => {
    let item = history.find(h => key(h.finding) === key(finding));
    if (!item) { item = { finding, observed: [], claims: [] }; history.push(item); }
    if (!item.observed.includes(finding.run)) item.observed.push(finding.run);
    const repeated = item.observed.length > 1;
    const current = claim && key(claim) === key(finding) && claim.run === finding.run ? claim : undefined;
    const related = history.filter(entry => entry.finding.repository === finding.repository && entry.finding.pr === finding.pr && entry.finding.head === finding.head);
    const reserved = new Set(related.flatMap(entry => entry.claims));
    const observedRetries = new Set(related.flatMap(entry => entry.observed.slice(1)));
    const used = Math.max(reserved.size, observedRetries.size);
    let disposition: string;
    if (repeated) disposition = "reclassify-read-child-logs";
    else if (current?.classification === "stale-base") disposition = "check-base-ancestry";
    else if (current?.classification === "code") disposition = "inspect-diff";
    else if (reserved.has(finding.run)) disposition = "already-reserved-await-distinct-build";
    else if (used >= budget) disposition = "budget-exhausted";
    else if (!current) disposition = "classify-before-fresh-build";
    else {
      item.claims.push(finding.run);
      reserved.add(finding.run);
      disposition = "fresh-build-reserved";
    }
    return { ...finding, disposition, budget, remaining: Math.max(0, budget - Math.max(used, reserved.size)),
      observedRuns: item.observed.slice(), ...(current && { classification: current.classification, evidence: current.evidence }) };
  });
}
