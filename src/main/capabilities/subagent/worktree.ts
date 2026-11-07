import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";

export type SubagentIsolation = "auto" | "shared" | "worktree";

export interface PrepareSubagentWorkspaceOptions {
  cwd: string;
  isolation?: SubagentIsolation;
  parallel: boolean;
  writable: boolean;
  baseDir: string;
  signal?: AbortSignal;
  /** Stable durable call identity; retries inspect the same provisioning receipt. */
  operationId?: string;
  /** Rechecked at the actual side-effect boundary, including recovered receipts. */
  authorizeGitIsolation?: () => boolean;
}

export type PreparedSubagentWorkspace =
  | { kind: "shared"; cwd: string }
  | {
      kind: "worktree";
      cwd: string;
      root: string;
      repository: string;
      baseCommit: string;
      branch: string;
      receiptPath: string;
    };

type WorktreeWorkspace = Extract<PreparedSubagentWorkspace, { kind: "worktree" }>;

export async function repositoryAllowsGitIsolation(cwd: string, authorize?: () => boolean): Promise<boolean> {
  if (authorize?.() === false) return false;
  let directory = path.resolve(cwd);
  for (;;) {
    try {
      const instructions = await readFile(path.join(directory, "AGENTS.md"), "utf8");
      if (/use\s+[`'"]?main[`'"]?\s+as\s+the\s+only\s+active\s+local\s+branch|do not create additional branches or worktrees|禁止.{0,12}(?:新分支|worktree|工作树)/i.test(instructions)) return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

export async function assertGitIsolationAllowed(cwd: string, authorize?: () => boolean): Promise<void> {
  if (!await repositoryAllowsGitIsolation(cwd, authorize)) throw new Error("当前 Work 或仓库禁止创建分支/worktree；请明确采用有效并发 1 的 shared 计划");
}
type WorkspaceReceipt = WorktreeWorkspace & { sourceCwd: string } & (
  | { state: "intent" | "ready" }
  | { state: "failed" | "cancelled"; error: string }
);

export class SubagentWorkspaceProvisionError extends Error {
  readonly root: string;
  readonly receiptPath: string;

  constructor(workspace: WorktreeWorkspace, cause: unknown, receiptError?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const persistence = receiptError === undefined ? "" : ` Receipt update failed: ${String(receiptError)}.`;
    super(`Subagent worktree provisioning failed: ${detail}. Retained path: ${workspace.root}. Receipt: ${workspace.receiptPath}.${persistence}`, { cause });
    this.name = "SubagentWorkspaceProvisionError";
    this.root = workspace.root;
    this.receiptPath = workspace.receiptPath;
  }
}

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }));
      else resolve(stdout.trimEnd());
    });
    // Wait for execFile's exit callback before recording cancellation.
    const abort = (): void => { child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function writeReceipt(receipt: WorkspaceReceipt): Promise<void> {
  const temporary = `${receipt.receiptPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, receipt.receiptPath);
}

export async function prepareSubagentWorkspace(options: PrepareSubagentWorkspaceOptions): Promise<PreparedSubagentWorkspace> {
  const { signal } = options;
  signal?.throwIfAborted();
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
  signal?.throwIfAborted();
  const isolated = options.isolation === "worktree"
    || ((options.isolation ?? "auto") === "auto" && options.parallel && options.writable);
  if (!isolated) return { kind: "shared", cwd };
  await assertGitIsolationAllowed(cwd, options.authorizeGitIsolation);

  let repository: string;
  try {
    repository = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"], signal));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Subagent worktree isolation requires a Git working tree: ${cwd}`, { cause: error });
  }
  const baseCommit = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  const relativeCwd = path.relative(repository, cwd);
  if (path.isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) {
    throw new Error(`Subagent cwd is outside its Git repository: ${cwd}`);
  }
  if (!options.operationId && await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal)) {
    throw new Error(`Subagent worktree isolation requires a clean repository, including untracked files: ${repository}. Commit or stash changes, or explicitly select shared isolation.`);
  }
  signal?.throwIfAborted();
  await mkdir(path.resolve(options.baseDir), { recursive: true });
  const baseDir = await realpath(options.baseDir);
  const allocation = options.operationId
    ? path.join(baseDir, `durable-${createHash("sha256").update(options.operationId).digest("hex")}`)
    : await mkdtemp(path.join(baseDir, "subagent-"));
  if (options.operationId) {
    await mkdir(allocation, { recursive: true });
    const receiptPath = path.join(allocation, "receipt.json");
    let receiptText: string | undefined;
    try { receiptText = await readFile(receiptPath, "utf8"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (receiptText !== undefined) {
      const saved: unknown = JSON.parse(receiptText);
      if (!saved || typeof saved !== "object" || !("sourceCwd" in saved) || saved.sourceCwd !== cwd
        || !("root" in saved) || saved.root !== path.join(allocation, "worktree")
        || !("cwd" in saved) || saved.cwd !== path.join(allocation, "worktree", relativeCwd)
        || !("repository" in saved) || saved.repository !== repository
        || !("baseCommit" in saved) || typeof saved.baseCommit !== "string"
        || !("branch" in saved) || typeof saved.branch !== "string"
        || !("state" in saved)) throw new Error(`Invalid subagent workspace receipt: ${receiptPath}`);
      if (saved.state !== "ready") {
        // An interrupted git operation is a side effect with an uncertain outcome. Never repeat it.
        throw new Error(`Subagent workspace provisioning needs reconciliation: ${receiptPath} (${String(saved.state)})`);
      }
      if (await realpath(saved.root) !== saved.root || await realpath(saved.cwd) !== saved.cwd) {
        throw new Error(`Subagent workspace path changed: ${receiptPath}`);
      }
      if (path.resolve(await git(saved.cwd, ["rev-parse", "--show-toplevel"], signal)) !== saved.root) {
        throw new Error(`Subagent workspace no longer belongs to its receipt: ${receiptPath}`);
      }
      return { kind: "worktree", cwd: saved.cwd, root: saved.root, repository, baseCommit: saved.baseCommit, branch: saved.branch, receiptPath };
    }
  }
  if (await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal)) {
    throw new Error(`Subagent worktree isolation requires a clean repository, including untracked files: ${repository}. Commit or stash changes, or explicitly select shared isolation.`);
  }
  const root = path.join(allocation, "worktree");
  const workspace: WorktreeWorkspace = {
    kind: "worktree",
    cwd: path.join(root, relativeCwd),
    root,
    repository,
    baseCommit,
    branch: `subagent/${randomUUID()}`,
    receiptPath: path.join(allocation, "receipt.json"),
  };
  const receipt = { ...workspace, sourceCwd: cwd };
  try {
    await writeReceipt({ ...receipt, state: "intent" });
    signal?.throwIfAborted();
    if (await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal)) {
      throw new Error(`Repository became dirty before worktree creation: ${repository}`);
    }
    await assertGitIsolationAllowed(cwd, options.authorizeGitIsolation);
    await git(repository, ["worktree", "add", "-b", workspace.branch, "--", root, baseCommit], signal);
    workspace.root = await realpath(root);
    workspace.cwd = await realpath(workspace.cwd);
    signal?.throwIfAborted();
    await writeReceipt({ ...workspace, sourceCwd: cwd, state: "ready" });
    signal?.throwIfAborted();
    return workspace;
  } catch (error) {
    let receiptError: unknown;
    try {
      await writeReceipt({
        ...workspace,
        sourceCwd: cwd,
        state: signal?.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (failure) {
      receiptError = failure;
    }
    throw new SubagentWorkspaceProvisionError(workspace, error, receiptError);
  }
}
