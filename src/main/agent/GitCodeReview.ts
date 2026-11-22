import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type {
  CodeReviewDetail, CodeReviewFile, CodeReviewGitCommit, CodeReviewGitComparison, CodeReviewGitFile,
  CodeReviewGitList, CodeReviewGitRefs,
} from "../../shared/code-review";
import { MANIFEST_FILENAME } from "../task/TaskExecutionWorkspace";
import { codeReviewTarget, readReviewState, reviewText } from "./CodeReviewFiles";
import { snapshotGitDiff } from "./CodeReviewSnapshotDiff";
import { getCanbanReviewRuntime } from "../../../vendor/canban-review/runtime";

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_PATCH = 2 * 1024 * 1024;
const MAX_TEXT = 512 * 1024;
const MAX_FILES = 1000;
const COMMIT_FORMAT = "--format=%H%x00%h%x00%P%x00%cr%x00%an%x00%s";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
Object.assign(gitEnv, { LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });

function invokeGit(cwd: string, args: string[], options: { optional?: boolean; maxBuffer?: number } = {}) {
  return new Promise<Buffer | null>((accept, reject) => {
    const child = execFile("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false",
      "-c", "core.quotePath=false", ...args], {
      cwd, env: gitEnv, encoding: "buffer", timeout: 12_000, maxBuffer: options.maxBuffer ?? MAX_OUTPUT, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) accept(stdout);
      else if (options.optional && (error.code === 1 || error.code === 128 || error.code === "ENOENT")) accept(null);
      else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new GitReviewOutputLimit());
      else reject(new Error(stderr.toString("utf8").trim() || error.message));
    });
    child.stdin?.end();
  });
}

class GitReviewOutputLimit extends Error {
  constructor() { super("Git 输出超过审查大小限制"); }
}

function gitString(bytes: Buffer | null): string { return bytes?.toString("utf8") ?? ""; }

function filePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 16 * 1024 && !isAbsolute(path) &&
    !path.includes("\0") && !path.includes("\ufffd") && (sep !== "\\" || !/[\\:]/.test(path)) &&
    path.split("/").every(part => part.length > 0 && ![".", "..", ".git", MANIFEST_FILENAME].includes(part.toLowerCase()));
}

function diffArgs(section: CodeReviewGitFile["section"], base?: string, compare?: string) {
  const mode = section === "staged" ? "STAGED" : section === "unstaged" ? "UNSTAGED" : compare ? "REVISION" : "WORKDIR";
  const args = getCanbanReviewRuntime().gitCompareCommand(mode, base, compare);
  if (!args) throw new Error("Git 比较参数无效");
  return args.slice(1, -1);
}

function parsePatchMetadata(output: string) {
  const rows: { path: string; oldPath?: string; kind: CodeReviewFile["kind"]; additions: number; deletions: number;
    statsAvailable: boolean; version: string }[] = [];
  const fields = output.split("\0");
  let i = 0;
  while (fields[i]?.startsWith(":")) {
    const version = fields[i++];
    const status = version.split(" ").at(-1)?.[0];
    const first = fields[i++];
    const renamed = status === "R" || status === "C";
    const path = renamed ? fields[i++] : first;
    const kind = status === "A" || status === "C" ? "added" : status === "D" ? "deleted" : renamed ? "renamed" : "modified";
    rows.push({ path, oldPath: renamed ? first : undefined, kind, additions: 0, deletions: 0, statsAvailable: false, version });
  }
  const byPath = new Map(rows.map(row => [row.path, row]));
  for (; i < fields.length; i++) {
    const entry = fields[i];
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = entry.slice(0, firstTab);
    const deletions = entry.slice(firstTab + 1, secondTab);
    const path = entry.slice(secondTab + 1) || fields[i += 2];
    const row = byPath.get(path);
    if (row && additions !== "-" && deletions !== "-") {
      row.additions = Number(additions);
      row.deletions = Number(deletions);
      row.statsAvailable = true;
    }
  }
  return Array.from(byPath.values()).filter(row => filePath(row.path) && (!row.oldPath || filePath(row.oldPath)));
}

function codeReviewId(file: Pick<CodeReviewGitFile, "section" | "oldRevision" | "newRevision" | "path" | "oldPath" | "untracked" | "version">) {
  return `git:${createHash("sha256").update(JSON.stringify([
    file.section, file.oldRevision, file.newRevision, file.path, file.oldPath, Boolean(file.untracked), file.version,
  ])).digest("hex")}`;
}

function validateComparison(value: CodeReviewGitComparison): void {
  if (value?.mode === "uncommitted") return;
  if (value?.mode !== "compare" || ![value.base, value.compare].every(ref =>
    typeof ref === "string" && ref.trim().length > 0 && ref.length <= 512 && !ref.trim().startsWith("-") && !/[\x00-\x1f\x7f]/.test(ref)) ||
    (value.threeDot !== undefined && typeof value.threeDot !== "boolean")) throw new Error("Git 比较参数无效");
}

/** Electron host port of Canban compare.rs::Ops::git_compare and git_refs_in (390c057). */
export class GitCodeReview {
  private constructor(private readonly cwd: string) {}

  static async open(cwd: string): Promise<GitCodeReview | null> {
    const inside = await invokeGit(cwd, ["rev-parse", "--is-inside-work-tree"], { optional: true });
    return gitString(inside).trim() === "true" ? new GitCodeReview(cwd) : null;
  }

  private async git(args: string[], options?: Parameters<typeof invokeGit>[2]) {
    return gitString(await invokeGit(this.cwd, args, options));
  }

  private async revision(name: string): Promise<string | undefined> {
    const revision = (await this.git(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`], { optional: true })).trim();
    return SHA.test(revision) ? revision : undefined;
  }

  private async baseRevision(name: string): Promise<{ sha?: string; emptyTree: boolean }> {
    const sha = await this.revision(name);
    const stem = /^(.*)(?:\^1|\^|~1)$/.exec(name)?.[1];
    if (sha || !stem) return { sha, emptyTree: false };
    const root = await this.revision(stem);
    if (!root) return { emptyTree: false };
    const info = await this.git(["cat-file", "-p", root]);
    if (info.split("\n\n", 1)[0].split("\n").some(line => line.startsWith("parent "))) return { emptyTree: false };
    const empty = (await this.git(["hash-object", "-t", "tree", "--stdin"])).trim();
    return { sha: empty, emptyTree: true };
  }

  async refs(): Promise<CodeReviewGitRefs> {
    const [branch, head, remoteHead, refOutput] = await Promise.all([
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { optional: true }), this.revision("HEAD"),
      this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { optional: true }),
      this.git(["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"]),
    ]);
    const refs = refOutput.split(/\r?\n/).filter(ref => ref && !ref.endsWith("/HEAD"));
    const defaultBase = remoteHead.trim() || ["main", "master", "trunk", "develop"].find(candidate => refs.includes(candidate)) || "HEAD";
    return { branch: branch.trim() || null, head: head ?? null, defaultBase, refs: [...new Set(["HEAD", ...refs])] };
  }

  private async prefix(): Promise<string> {
    return (await this.git(["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
  }

  private readWorkingText(path: string): string | null {
    try {
      const state = readReviewState(codeReviewTarget(this.cwd, resolve(this.cwd, path)));
      return state.bytes && state.bytes.length <= MAX_TEXT ? reviewText(state) : null;
    } catch { return null; }
  }

  private async version(path: string, gitVersion: string, workingTree: boolean): Promise<string> {
    if (!workingTree) return gitVersion;
    try {
      const stat = await lstat(resolve(this.cwd, path), { bigint: true });
      return `${gitVersion}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { return `${gitVersion}:unavailable`; }
  }

  private async readBlob(sha: string, mode: string): Promise<string | null> {
    if (!SHA.test(sha) || !mode.startsWith("100")) return null;
    const size = await this.git(["cat-file", "-s", sha], { optional: true });
    if (!size || Number(size) > MAX_TEXT) return null;
    const bytes = await invokeGit(this.cwd, ["cat-file", "blob", sha], { optional: true, maxBuffer: MAX_TEXT });
    return reviewText({ present: Boolean(bytes), bytes, mode: null, stamp: "" });
  }

  private async trackedFiles(comparison: CodeReviewGitComparison, section: CodeReviewGitFile["section"],
    oldRevision?: string, newRevision?: string): Promise<CodeReviewGitFile[]> {
    const args = diffArgs(section, oldRevision, newRevision);
    const raw = await this.git(["diff", "--no-color", "--relative", "--no-abbrev", "--raw", "--numstat", "-z", ...args, "--"]);
    return Promise.all(parsePatchMetadata(raw).slice(0, MAX_FILES + 1).map(async row => {
      const version = await this.version(row.path, row.version, section !== "staged" && !newRevision);
      const file = { ...row, name: basename(row.path), section, comparison, oldRevision, newRevision, version };
      return { ...file, id: codeReviewId(file), status: "pending", canReject: false };
    }));
  }

  private async untrackedFiles(comparison: CodeReviewGitComparison, section: CodeReviewGitFile["section"], oldRevision?: string) {
    const [raw, prefix] = await Promise.all([
      this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]), this.prefix(),
    ]);
    const status = getCanbanReviewRuntime().gitStatus(raw);
    const paths = status.filter(file => file.untracked && file.path.startsWith(prefix))
      .map(file => file.path.slice(prefix.length)).filter(filePath);
    return Promise.all(paths.slice(0, MAX_FILES + 1).map(async (path): Promise<CodeReviewGitFile> => {
      const version = await this.version(path, "untracked", true);
      const file = { path, name: basename(path), section, comparison, oldRevision, untracked: true, version };
      return { ...file, id: codeReviewId(file), kind: "added", additions: 0, deletions: 0,
        statsAvailable: false, status: "pending", canReject: false };
    }));
  }

  private async commits(base: string, compare: string, single = false): Promise<CodeReviewGitCommit[]> {
    if (base === compare) return [];
    const raw = await this.git(["log", "-n", single ? "1" : "50", COMMIT_FORMAT, single ? compare : `${base}..${compare}`, "--", "."]);
    return raw.split(/\r?\n/).filter(Boolean).map(row => {
      const [sha, shortSha, parents, relativeTime, author, subject] = row.split("\0");
      return { sha, shortSha, parents: parents.split(" ").filter(Boolean), relativeTime, author, subject };
    });
  }

  async list(comparison: CodeReviewGitComparison = { mode: "uncommitted" }): Promise<CodeReviewGitList> {
    validateComparison(comparison);
    if (comparison.mode === "uncommitted") {
      // Use the same two views as Canban to preserve staged edits reverted on disk.
      const baseSha = await this.revision("HEAD");
      const [staged, unstaged, untracked] = await Promise.all([
        this.trackedFiles(comparison, "staged", baseSha),
        this.trackedFiles(comparison, "unstaged"), this.untrackedFiles(comparison, "unstaged"),
      ]);
      const files = [...staged, ...unstaged, ...untracked];
      return { comparison, baseSha, files: files.slice(0, MAX_FILES), commits: [], truncated: files.length > MAX_FILES };
    }

    const workingTree = comparison.compare.trim() === "WORKDIR";
    const [{ sha: baseSha, emptyTree }, compareSha] = await Promise.all([
      this.baseRevision(comparison.base.trim()), this.revision(workingTree ? "HEAD" : comparison.compare.trim()),
    ]);
    if (!baseSha) throw new Error(`找不到 Git 基线 ${comparison.base}`);
    if (!compareSha && !workingTree) throw new Error(`找不到 Git 比较引用 ${comparison.compare}`);
    const mergeBase = !emptyTree && comparison.threeDot !== false && compareSha && baseSha !== compareSha
      ? (await this.git(["merge-base", baseSha, compareSha], { optional: true })).trim() : "";
    const effectiveBase = SHA.test(mergeBase) ? mergeBase : baseSha;
    const [tracked, untracked, commits] = await Promise.all([
      this.trackedFiles(comparison, "compare", effectiveBase, workingTree ? undefined : compareSha),
      workingTree ? this.untrackedFiles(comparison, "compare", effectiveBase) : [],
      compareSha ? this.commits(effectiveBase, compareSha, emptyTree) : [],
    ]);
    const files = [...tracked, ...untracked];
    return { comparison, baseSha: effectiveBase, compareSha, files: files.slice(0, MAX_FILES), commits, truncated: files.length > MAX_FILES };
  }

  async detail(file: CodeReviewGitFile): Promise<CodeReviewDetail | null> {
    if (!file || !filePath(file.path) || file.oldPath !== undefined && !filePath(file.oldPath) ||
      typeof file.version !== "string" || file.version.length > 512 ||
      !["staged", "unstaged", "compare"].includes(file.section) ||
      file.oldRevision !== undefined && !SHA.test(file.oldRevision) || file.newRevision !== undefined && !SHA.test(file.newRevision) ||
      file.section === "compare" && !file.oldRevision || file.id !== codeReviewId(file)) return null;
    validateComparison(file.comparison);
    const section = file.section;
    const path = file.path;
    const oldPath = file.oldPath ?? path;
    const paths = path === oldPath ? [path] : [oldPath, path];
    const workingTree = section !== "staged" && !file.newRevision;
    const workingText = workingTree ? this.readWorkingText(path) : null;
    const args = diffArgs(section, file.oldRevision, file.newRevision);
    const preview = await (file.untracked
      ? workingText === null ? Promise.resolve(null) : snapshotGitDiff("", workingText, "patch")
      : this.git(["diff", "--no-color", "--relative", "--no-abbrev", "--raw", "-z", "--patch",
        "--src-prefix=a/", "--dst-prefix=b/", ...args, "--", ...paths], { maxBuffer: MAX_PATCH }))
      .then(text => ({ text: text ?? undefined, reason: text === null ? "文件内容不支持文本差异预览" : undefined }), error => {
        if (!(error instanceof GitReviewOutputLimit)) throw error;
        return { text: undefined, reason: error.message };
      });
    let raw = preview.text;
    let before: string | null = null;
    let after = workingText;
    if (file.untracked) {
      if (await this.version(path, "untracked", true) !== file.version) return null;
    } else if (raw !== undefined) {
      const split = raw.indexOf("\0\0");
      const found = split < 0 ? undefined : parsePatchMetadata(raw.slice(0, split + 1))
        .find(row => row.path === path && row.oldPath === file.oldPath);
      if (!found || await this.version(path, found.version, workingTree) !== file.version) return null;
      const [oldMode, newMode, oldBlob, newBlob] = found.version.slice(1).split(" ");
      [before, after] = await Promise.all([
        this.readBlob(oldBlob, oldMode), workingTree ? workingText : this.readBlob(newBlob, newMode),
      ]);
      raw = raw.slice(split + 2);
    }
    const sections = raw ? getCanbanReviewRuntime().gitPatchFiles(raw) : [];
    const selected = sections.find(item => item.filename === path) ?? (sections.length === 1 ? sections[0] : undefined);
    const stats = file.untracked && workingText !== null && selected
      ? { additions: selected.additions, deletions: selected.deletions, statsAvailable: true } : {};
    return { ...file, ...stats, canReject: false, before, after, patch: selected?.patch ?? raw, reason: preview.reason };
  }
}
