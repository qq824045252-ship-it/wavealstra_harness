import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export type OriginCommand = (args: string[]) => Promise<unknown>;
export type ForgeScope = { forge: "github" | "origin"; repository: string };
export function originCommand(signal?: AbortSignal): OriginCommand {
  return async args => {
    try {
      const result = await exec("origin", args, { cwd: dirname(process.execPath), windowsHide: true, timeout: 30_000,
        signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
      return JSON.parse(result.stdout);
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") throw new Error("Origin CLI is unavailable. Install Cursor Origin CLI and sign in for this repository.");
      if (/auth|login|sign in|unauthorized|permission denied|forbidden|not authenticated/i.test(failure.stderr ?? ""))
        throw new Error("Origin access is unavailable. Verify origin auth status and repository read permission.");
      throw new Error("Origin read failed: " + (failure.stderr?.trim().split(/\r?\n/, 1)[0]?.slice(0, 280) || failure.message));
    }
  };
}
const component = /^[a-z\d][a-z\d_.-]*$/i;
const repoParts = z.object({ org: z.string().regex(component), name: z.string().regex(component) });
export async function chooseForge(preference: unknown, repository: string, read: OriginCommand, cwd?: string, signal?: AbortSignal): Promise<ForgeScope> {
  if (preference === "origin" || preference === "github") return { forge: preference, repository };
  if (cwd) {
    const remote = await exec("git", ["--no-optional-locks", "-C", cwd, "remote", "get-url", "origin"],
      { cwd: dirname(process.execPath), windowsHide: true, timeout: 5000, signal }).catch(() => undefined);
    signal?.throwIfAborted();
    const own = remote?.stdout.trim().match(/^(?:https:\/\/origin\.cursor\.com\/|git@origin\.cursor\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
    if (own?.[1].toLowerCase() === repository.toLowerCase()) return { forge: "origin", repository };
  }
  try {
    const mirror = z.object({ found: z.boolean(), mirrorStatus: z.string().nullish() }).passthrough()
      .parse(await read(["repo", "from-github", repository, "--json", "found,org,name,mirrorStatus"]));
    if (mirror.found && ["no-mirror", "outbound"].includes(mirror.mirrorStatus ?? "")) {
      const { org, name } = repoParts.parse(mirror);
      return { forge: "origin", repository: org + "/" + name };
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error && /Origin (CLI|access) is unavailable/.test(error.message))) throw error;
  }
  return { forge: "github", repository };
}
const number = z.union([z.number().int(), z.string().regex(/^[1-9]\d*$/)]).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const ref = z.object({ ref: z.string().min(1), sha: z.string().regex(/^[a-f\d]{40}(?:[a-f\d]{24})?$/i) });
const membership = z.object({ number, repository: z.object({ name: z.string(), owner: z.object({ slug: z.string() }) }) });
const pull = z.object({ number, state: z.enum(["open", "closed"]), merged: z.boolean().default(false), draft: z.boolean().default(false),
  head: ref, base: ref, title: z.string().min(1), body: z.string().default(""), webUrl: z.string().url(),
  stack: z.object({ id: z.string().min(1), parentPullRequest: membership.optional() }).optional() });
const blocker = z.object({ kind: z.string().optional(), message: z.string().min(1),
  requiredChecks: z.object({ state: z.string() }).optional() });
const assessment = z.object({ pullRequest: membership, verdict: z.string(), headSha: ref.shape.sha, blockers: z.array(blocker).default([]) });
const thread = z.object({ id: z.string().min(1) });
export type OriginRow = { pr: number; head: string; status: "merged" | "closed" | "draft" | "blocked" | "pending" | "mergeable";
  blockers: string[]; unresolvedThreads: number | null };
export class OriginReader {
  constructor(private readonly command: OriginCommand, readonly repository: string) {
    if (repository.split("/").length !== 2 || !repository.split("/").every(p => component.test(p))) throw new Error("Invalid Origin repository name.");
  }
  private api(path: string) { return this.command(["api", "/repos/" + this.repository + path, "-X", "GET"]); }
  async pull(pr: number) {
    const data = pull.parse(await this.api("/pulls/" + pr));
    const expected = "https://cursor.com/codebase/" + this.repository + "/pull/" + pr;
    if (data.number !== pr || data.webUrl.toLowerCase() !== expected.toLowerCase()) throw new Error("Origin returned a different repository or PR.");
    return data;
  }
  async stack(pr: number) {
    const root = await this.pull(pr);
    if (!root.stack) return [pr];
    const members = new Map<number, number | undefined>(), tokens = new Set<string>();
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ state: "all", stackId: root.stack.id, pageSize: "100" });
      if (token) query.set("pageToken", token);
      const page = z.object({ pullRequests: z.array(pull), nextPageToken: z.string().optional() }).parse(await this.api("/pulls?" + query));
      for (const item of page.pullRequests) {
        const parent = item.stack?.parentPullRequest;
        if (item.stack?.id !== root.stack.id || members.has(item.number) ||
          (parent && (parent.repository.owner.slug + "/" + parent.repository.name).toLowerCase() !== this.repository.toLowerCase())) throw new Error("Origin returned inconsistent stack membership.");
        members.set(item.number, parent?.number);
      }
      token = page.nextPageToken;
      if (token && tokens.has(token)) throw new Error("Origin reused a stack pagination token.");
      if (token) tokens.add(token);
    } while (token);
    const ordered: number[] = [];
    let parent: number | undefined;
    while (members.size) {
      const children = [...members].filter(([, n]) => n === parent);
      if (children.length !== 1) throw new Error("Origin stack is branched, incomplete or cyclic. Specify the bottom-to-top PR queue.");
      parent = children[0][0]; ordered.push(parent); members.delete(parent);
    }
    if (!ordered.includes(pr)) throw new Error("Origin did not return the target PR in its stack.");
    return ordered;
  }
  async snapshot(pr: number, allowDraft: boolean): Promise<OriginRow> {
    const data = await this.pull(pr);
    const row = { pr, head: data.head.sha, blockers: [] as string[], unresolvedThreads: null as number | null };
    if (data.merged || data.state === "closed") return { ...row, status: data.merged ? "merged" : "closed" };
    const [requirements, pending] = await Promise.all([this.api("/pulls/" + pr + "/mergeability"),
      this.command(["pr", "thread", "list", String(pr), "-R", this.repository, "--unresolved", "--json", "id"])]);
    const policy = assessment.parse(requirements), unresolved = z.array(thread).parse(pending);
    if (policy.headSha !== data.head.sha || policy.pullRequest.number !== pr ||
      (policy.pullRequest.repository.owner.slug + "/" + policy.pullRequest.repository.name).toLowerCase() !== this.repository.toLowerCase()) throw new Error("Origin mergeability is for a different PR or head. Read it again.");
    row.unresolvedThreads = unresolved.length;
    row.blockers = policy.blockers.map(b => b.message);
    if (unresolved.length) row.blockers.push(unresolved.length + " unresolved review threads");
    if (data.draft && !allowDraft) return { ...row, status: "draft" };
    if (policy.verdict === "mergeable" && row.blockers.length === 0) return { ...row, status: "mergeable" };
    const waiting = policy.verdict === "blocked" && !unresolved.length && policy.blockers.length > 0 && policy.blockers.every(b =>
      b.kind === "restack_pending" || b.kind === "conflict_check_pending" || (b.kind === "required_checks" && b.requiredChecks?.state === "pending"));
    return { ...row, status: waiting ? "pending" : "blocked" };
  }
}
