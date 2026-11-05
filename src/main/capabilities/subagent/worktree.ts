import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rename, stat } from "node:fs/promises";
import * as path from "node:path";

export type SubagentIsolation = "auto" | "shared" | "worktree";

export interface PrepareSubagentWorkspaceOptions {
  cwd: string;
  isolation?: SubagentIsolation;
  parallel: boolean;
  writable: boolean;
  baseDir: string;
  signal?: AbortSignal;
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

  let repository: string;
  try {
    repository = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"], signal));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Subagent worktree isolation requires a Git working tree: ${cwd}`, { cause: error });
  }
  if (await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal)) {
    throw new Error(`Subagent worktree isolation requires a clean repository, including untracked files: ${repository}. Commit or stash changes, or explicitly select shared isolation.`);
  }
  const baseCommit = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  const relativeCwd = path.relative(repository, cwd);
  if (path.isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) {
    throw new Error(`Subagent cwd is outside its Git repository: ${cwd}`);
  }
  signal?.throwIfAborted();
  await mkdir(path.resolve(options.baseDir), { recursive: true });
  const baseDir = await realpath(options.baseDir);
  const allocation = await mkdtemp(path.join(baseDir, "subagent-"));
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
