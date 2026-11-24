import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalPathKey } from "../../platform/paths";

const exec = promisify(execFile);
type SubmittedWorkspace = { kind?: string; cwd: string; baseCommit?: string };
export type PstackInterrogateWorkspace = {
  kind: "worktree"; cwd: string; root: string; sourceCwd: string; repository: string;
  commonDir: string; gitDir: string; baseCommit: string; fingerprint: string;
};
type WorkspaceIdentity = Omit<PstackInterrogateWorkspace, "fingerprint">;
const samePath = (a: string, b: string) => canonicalPathKey(a) === canonicalPathKey(b);

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return (await exec("git", ["--no-optional-locks", "-C", cwd, ...args], {
    windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal,
  })).stdout;
}
const gitPath = async (cwd: string, arg: string, signal?: AbortSignal) =>
  realpath((await git(cwd, ["rev-parse", "--path-format=absolute", arg], signal)).trim());

/** Authenticate the actual Git worktree, not a path copied into a worker answer. */
async function identity(submitted: SubmittedWorkspace, sourceCwd: string, signal?: AbortSignal): Promise<WorkspaceIdentity> {
  if (submitted.kind !== "worktree" || !submitted.baseCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(submitted.baseCommit))
    throw Error("Interrogate requires a real isolated worktree with its observed base commit; shared review is not execution proof.");
  const cwd = await realpath(submitted.cwd), source = await realpath(sourceCwd);
  const [root, repository, commonDir, sourceCommon, gitDir] = await Promise.all([
    gitPath(cwd, "--show-toplevel", signal), gitPath(source, "--show-toplevel", signal),
    gitPath(cwd, "--git-common-dir", signal), gitPath(source, "--git-common-dir", signal), gitPath(cwd, "--git-dir", signal),
  ]);
  if (samePath(root, repository) || !samePath(commonDir, sourceCommon) ||
    relative(root, cwd) !== relative(repository, source))
    throw Error("Interrogate workspace is not an independent worktree of the assigned repository and working directory.");
  const [head, sourceHead, registered, sourceChanges] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
    git(source, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
    git(source, ["worktree", "list", "--porcelain", "-z"], signal),
    git(source, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], signal),
  ]);
  const listed = registered.split("\0\0").some(block => {
    const rows = block.split("\0"), path = rows.find(row => row.startsWith("worktree "))?.slice(9);
    return path && samePath(resolve(path), root) && rows.includes("HEAD " + submitted.baseCommit);
  });
  if (!listed || head.trim() !== submitted.baseCommit || sourceHead.trim() !== submitted.baseCommit || sourceChanges.trim())
    throw Error("Interrogate review target changed or its worktree is unregistered; the source must remain at the clean dispatched commit.");
  return { kind: "worktree", cwd, root, sourceCwd: source, repository, commonDir, gitDir, baseCommit: submitted.baseCommit };
}

/** Existing source is immutable. New reproduction files are retained and hashed
 * so a later host rerun cannot silently execute a different reproduction. */
async function fingerprint(workspace: WorkspaceIdentity, signal?: AbortSignal): Promise<string> {
  const { root, baseCommit } = workspace;
  const [diff, untracked] = await Promise.all([
    git(root, ["diff", "--no-ext-diff", "--no-renames", "--ignore-submodules=none", "--name-status", "-z", baseCommit, "--"], signal),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
  ]);
  const fields = diff.split("\0").filter(Boolean), added = new Set(untracked.split("\0").filter(Boolean));
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] !== "A" || !fields[i + 1])
      throw Error("Interrogate reviewers may add reproduction files but must not modify, delete or commit the reviewed source: " + (fields[i + 1] ?? fields[i]));
    added.add(fields[i + 1]);
  }
  const hash = createHash("sha256").update(baseCommit);
  let total = 0;
  for (const name of [...added].sort()) {
    signal?.throwIfAborted();
    const target = resolve(root, name), rel = relative(root, target);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) || !samePath(await realpath(target), target))
      throw Error("Interrogate reproduction file escapes or redirects its worktree: " + name);
    const file = await lstat(target);
    if (!file.isFile() || file.nlink !== 1 || file.size > 8 * 1024 * 1024 || (total += file.size) > 32 * 1024 * 1024)
      throw Error("Interrogate requires regular reproduction files of at most 8 MiB each and 32 MiB in total: " + name);
    hash.update("\0" + name + "\0").update(await readFile(target));
  }
  return hash.digest("hex");
}

export async function captureInterrogateWorkspace(submitted: SubmittedWorkspace | undefined, sourceCwd: string,
  signal?: AbortSignal): Promise<PstackInterrogateWorkspace> {
  if (!submitted) throw Error("Interrogate reviewer did not return its host workspace identity.");
  const workspace = await identity(submitted, sourceCwd, signal);
  return { ...workspace, fingerprint: await fingerprint(workspace, signal) };
}

/** Run before and after the host's exact command rerun. A changed source,
 * checkout, worktree registration or reproduction invalidates that finding. */
export async function assertInterrogateWorkspace(workspace: PstackInterrogateWorkspace, signal?: AbortSignal): Promise<string> {
  const current = await identity(workspace, workspace.sourceCwd, signal);
  for (const key of ["cwd", "root", "sourceCwd", "repository", "commonDir", "gitDir"] as const)
    if (!samePath(current[key], workspace[key])) throw Error("Interrogate workspace identity changed: " + key);
  const version = await fingerprint(current, signal);
  if (version !== workspace.fingerprint) throw Error("Interrogate reproduction files changed after the child evidence was recorded.");
  return version;
}
