import { execFile } from "node:child_process";
import { lstat, opendir, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolvedPathKey } from "../../platform/paths";

const exec = promisify(execFile);
async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    windowsHide: true, signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  })).stdout;
}

async function optionalGit(cwd: string, args: string[], signal?: AbortSignal) {
  try { return (await git(cwd, args, signal)).trim(); }
  catch { signal?.throwIfAborted(); return null; }
}

async function treeBytes(root: string, signal?: AbortSignal) {
  let bytes = 0, files = 0;
  const pending = [root];
  while (pending.length) {
    const dir = await opendir(pending.pop()!);
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      if (++files > 100_000) return null;
      const path = join(dir.path, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) bytes += (await lstat(path)).size;
    }
  }
  return bytes;
}

const pullRequests = z.array(z.object({ headRefName: z.string(), number: z.number(), state: z.string() }));
export async function gitHubCheckout(cwd: string, signal?: AbortSignal) {
  const url = (await git(cwd, ["remote", "get-url", "origin"], signal)).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?$/i.exec(url);
  if (!match) throw new Error("The checkout has no GitHub origin.");
  return match[1]!.replace(/\.git$/i, "");
}
export type WorktreeTask = { id: string; cwd: string; updatedAt: number; pinned: boolean; active: boolean };
type WorktreeObservation = { path: string; head?: string; branch: string | null; current: boolean; primary: boolean;
  bytes?: number | null; tracked: number; untracked: number; ignored: number; lastCommitAt: number | null; lastTaskActivity: number | null;
  protectedTasks: { id: string; pinned: boolean; active: boolean }[];
  remoteHead: string | null; reachableFromBase: boolean | null; prs: z.infer<typeof pullRequests>; reason: string };

export async function auditPstackWorktrees(cwd: string, options: {
  baseRef?: string; root?: string; queryGithub?: boolean; sizes?: boolean; signal?: AbortSignal; tasks?: WorktreeTask[];
} = {}) {
  const { signal } = options;
  const measureSize = options.sizes ?? true;
  let ref = options.baseRef ?? await optionalGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], signal);
  if (!ref) {
    const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/heads/main", "refs/heads/master"], signal)).trim().split(/\r?\n/);
    ref = refs.includes("refs/remotes/origin/main") ? "origin/main" : refs.includes("refs/heads/main") ? "main"
      : refs.includes("refs/heads/master") ? "master" : "origin/main";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) throw new Error("Invalid comparison ref");
  const revision = await optionalGit(cwd, ["rev-parse", "--verify", ref + "^{commit}"], signal);
  const currentRoot = resolvedPathKey((await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim());
  const records = (await git(cwd, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0\0").filter(Boolean);
  let prs: z.infer<typeof pullRequests> = [], githubError: string | undefined;
  if (options.queryGithub) {
    try {
      const repository = await gitHubCheckout(cwd, signal);
      const result = await exec("gh", ["pr", "list", "-R", repository, "--state", "all", "--limit", "1000", "--json", "headRefName,number,state"], {
        cwd: dirname(process.execPath), windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 15_000, maxBuffer: 1024 * 1024, signal,
      });
      prs = pullRequests.parse(JSON.parse(result.stdout));
    } catch { signal?.throwIfAborted(); githubError = "GitHub PR 状态不可用，请检查 gh 和当前仓库的读取权限。"; }
  }
  const worktrees: WorktreeObservation[] = [];
  for (const [index, record] of records.entries()) {
    signal?.throwIfAborted();
    const fields = record.split("\0");
    const path = fields[0]!.slice("worktree ".length), head = fields.find(f => f.startsWith("HEAD "))?.slice(5);
    if (options.root) {
      const child = relative(resolve(cwd, options.root), path);
      if (child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) continue;
    }
    const branch = fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18) ?? null;
    const dirty = await optionalGit(path, ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "--ignored=matching", "-z"], signal);
    const entries = dirty?.split("\0").filter(Boolean) ?? [];
    const untracked = entries.filter(entry => entry.startsWith("??")).length;
    const ignored = entries.filter(entry => entry.startsWith("!!")).length;
    const tracked = entries.length - untracked - ignored;
    const commitTime = await optionalGit(path, ["log", "-1", "--format=%ct"], signal);
    const ancestor = head && revision ? await optionalGit(cwd, ["merge-base", head, revision], signal) : null;
    const remoteHead = branch && await optionalGit(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], signal);
    const matchingPrs = prs.filter(pr => pr.headRefName === branch);
    const directory = resolvedPathKey(path);
    const tasks = options.tasks?.filter(task => {
      const fromTree = relative(directory, resolvedPathKey(task.cwd));
      return fromTree === "" || (fromTree !== ".." && !fromTree.startsWith(".." + sep) && !isAbsolute(fromTree));
    }) ?? [];
    const activity = tasks.reduce<number | null>((last, task) => Math.max(last ?? 0, task.updatedAt), null);
    const protectedTasks = tasks.filter(task => task.pinned || task.active).map(({ id, pinned, active }) => ({ id, pinned, active }));
    const current = resolvedPathKey(path) === currentRoot;
    const reason = index === 0 || current ? "current-or-primary"
      : fields.some(f => f.startsWith("locked")) ? "locked"
      : protectedTasks.length ? "pinned-or-active-task"
      : dirty === null ? "unavailable"
      : tracked || untracked ? "uncommitted" : ignored ? "ignored-files"
      : matchingPrs.some(pr => pr.state === "OPEN") ? "open-pr"
      : activity && Date.now() - activity < 4 * 86400_000 ? "recent-task"
      : ancestor === head && head ? "merged-locally" : "needs-review";
    const bytes = measureSize ? await treeBytes(path, signal).catch(() => { signal?.throwIfAborted(); return null; }) : undefined;
    worktrees.push({ path, head, branch, current, primary: index === 0, bytes, tracked, untracked, ignored,
      lastCommitAt: commitTime ? Number(commitTime) * 1000 : null, lastTaskActivity: activity, protectedTasks, remoteHead,
      reachableFromBase: ancestor === null ? null : ancestor === head, prs: matchingPrs, reason });
  }
  if (measureSize) worktrees.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const volume = await statfs(cwd);
  return { ref, revision, volume: { bytes: volume.blocks * volume.bsize, available: volume.bavail * volume.bsize },
    github: githubError ?? (options.queryGithub ? "queried" : "not requested"), worktrees };
}
