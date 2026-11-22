import { execFile } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execGit = promisify(execFile);

/** Git compares private copies of the captured text, independent of the live worktree. */
export async function snapshotGitDiff(
  before: string, after: string, format: "patch" | "numstat",
): Promise<string | null> {
  if (before === after) return "";
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "mybuddy-review-diff-"));
  } catch {
    return null;
  }
  const oldFile = join(directory, "before"), newFile = join(directory, "after");
  try {
    await writeFile(oldFile, before, { mode: 0o600, flag: "wx" });
    await writeFile(newFile, after, { mode: 0o600, flag: "wx" });
    const output = await execGit("git", [
      "--no-pager", "-c", "core.autocrlf=false", "diff", "--no-index", "--text",
      "--no-ext-diff", "--no-textconv", "--no-color", "--diff-algorithm=myers",
      "--output-indicator-old=-", "--output-indicator-new=+", "--output-indicator-context= ",
      format === "patch" ? "--unified=3" : "--numstat",
      "--", "before", "after",
    ], { cwd: directory, encoding: "utf8", timeout: 2500, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return output.stdout;
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    // A difference is Git's successful exit code 1 for --no-index.
    return result.code === 1 ? result.stdout ?? null : null;
  } finally {
    await Promise.allSettled([unlink(oldFile), unlink(newFile)]);
    await rmdir(directory).catch((error: unknown) => console.warn("[CodeReview] Temporary diff cleanup failed", error));
  }
}
