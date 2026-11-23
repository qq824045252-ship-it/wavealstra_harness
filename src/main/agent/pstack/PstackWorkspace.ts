import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { largeDiff } from "./PstackLargeDiff";
import { MANIFEST_FILENAME } from "../../task/TaskExecutionWorkspace";

const exec = promisify(execFile);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const maxFiles = 1200, maxFileBytes = 512 * 1024, maxBytes = 12 * 1024 * 1024;
const generated = new Set([".git", ".hg", ".svn", "node_modules", "dist", "out", "build", ".next", "target", "__pycache__"]);
export type FileState = { digest: string; lines: number; hashes: string; branches: Record<string, number>; source?: string; binary?: boolean };
export type ScopedFile = { path: string; before: FileState; current: FileState };
export type WorkspaceBaseline = { cwd: string; root: string; head: string; files: Record<string, FileState>; unknown: string[] };
export type WorkspaceDelta = { fingerprint: string; paths: string[]; fileDigests: ReadonlyMap<string, string>; changedLines: number; largestCrossing: number; addedBranches: number; unknown: string[]; coverageComplete: boolean };
export const missingFile: FileState = { digest: "", lines: 0, hashes: "", branches: {} };
const empty = missingFile;

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return (await exec("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "buffer", windowsHide: true, timeout: 12_000, maxBuffer: 8 * 1024 * 1024, signal,
  })).stdout;
}

function fromBytes(bytes: Buffer, retain: boolean): FileState {
  if (bytes.includes(0)) return { digest: hash(bytes), lines: 0, hashes: "", branches: {}, binary: true };
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const hashes = Buffer.alloc(lines.length * 8);
  const branches: Record<string, number> = Object.create(null);
  let scope = "<module>";
  lines.forEach((line, index) => {
    createHash("sha256").update(line).digest().copy(hashes, index * 8, 0, 8);
    const fn = /\b(?:function|def|fn|func)\s+([\p{L}_$][\p{L}\p{N}_$]*)|\b(?:const|let)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/u.exec(line);
    if (fn) scope = fn[1] ?? fn[2];
    const conditional = /(?:^|[;{}])\s*(?:else\s+if|if|elif|case|except|catch)\b\s*[(\s!]*(?:not\s+)?(?:this\.)?([\p{L}_$][\p{L}\p{N}_$]*(?:(?:\?\.|\.)[\p{L}_$][\p{L}\p{N}_$]*)*)/u.exec(line);
    if (conditional) {
      const key = "predicate:" + conditional[1];
      branches[key] = (branches[key] ?? 0) + 1;
      branches["scope:" + scope] = (branches["scope:" + scope] ?? 0) + 1;
    }
  });
  return { digest: hash(bytes), lines: lines.length, hashes: hashes.toString("base64"), branches,
    ...(retain && { source: deflateRawSync(bytes).toString("base64") }) };
}

async function fileState(cwd: string, path: string, budget: { bytes: number }, retain: boolean, signal?: AbortSignal): Promise<FileState> {
  const target = resolve(cwd, path), rel = relative(cwd, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("outside workspace");
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) return { digest: hash("link:" + await readlink(target)), lines: -1, hashes: "", branches: {} };
    if (!st.isFile() || await realpath(target) !== target) throw new Error("non-regular file");
    budget.bytes += st.size;
    let state: FileState;
    if (st.size > maxFileBytes || budget.bytes > maxBytes) {
      const digest = createHash("sha256");
      let binary = false;
      for await (const chunk of createReadStream(target, { signal })) {
        digest.update(chunk);
        if (!binary && Buffer.isBuffer(chunk)) binary = chunk.includes(0);
      }
      state = { digest: digest.digest("hex"), lines: binary ? 0 : -1, hashes: "", branches: {}, ...(binary && { binary: true }) };
    } else state = fromBytes(await readFile(target), retain);
    const end = await lstat(target);
    if (st.size !== end.size || st.mtimeMs !== end.mtimeMs || end.ino !== st.ino) throw new Error("file changed during inspection");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
}

async function plainPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  async function visit(dir: string) {
    signal?.throwIfAborted();
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (paths.length > maxFiles) break;
      const path = join(dir, item.name);
      if (item.isDirectory()) { if (!generated.has(item.name)) await visit(path); }
      else paths.push(relative(cwd, path).split(sep).join("/"));
    }
  }
  await visit(cwd);
  return paths;
}

export async function skillFileState(root: string, id: string, retain: boolean, signal?: AbortSignal) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid authored skill ID.");
  const target = join(root,id,"SKILL.md");
  const first=await lstat(target);
  if (!first.isFile() || first.nlink!==1 || await realpath(target)!==target) throw new Error("Expected the registered regular SKILL.md: "+target);
  const file=await fileState(root, join(id, "SKILL.md"), { bytes: 0 }, retain, signal);
  const last=await lstat(target);
  if(last.ino!==first.ino || last.nlink!==1 || !last.isFile() || await realpath(target)!==target) throw new Error("Authored skill changed during inspection.");
  return file;
}

async function gitPaths(base: WorkspaceBaseline, signal?: AbortSignal) {
  const scope = relative(base.root, base.cwd).split(sep).join("/") || ".";
  const [tracked, untracked] = await Promise.all([
    git(base.root, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base.head, "--", scope], signal),
    git(base.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope], signal),
  ]);
  const paths = (bytes: Buffer) => bytes.toString("utf8").split("\0").filter(Boolean)
    .map(name => relative(base.cwd, resolve(base.root, name)).split(sep).join("/"));
  return [...paths(tracked), ...paths(untracked).filter(name => name !== MANIFEST_FILENAME)];
}

async function collect(base: WorkspaceBaseline, retain: boolean, signal?: AbortSignal) {
  const records: Record<string, FileState> = Object.create(null);
  const unknown: string[] = [];
  const budget = { bytes: 0 };
  try {
    const candidates = base.head ? await gitPaths(base, signal) : await plainPaths(base.cwd, signal);
    const paths = [...new Set([...Object.keys(base.files), ...candidates])].sort();
    if (paths.length > maxFiles) unknown.push("file count exceeds inspection limit");
    for (const path of paths.slice(0, maxFiles)) {
      signal?.throwIfAborted();
      try { records[path] = await fileState(base.cwd, path, budget, retain, signal); }
      catch (error) { unknown.push(path + ": " + (error as Error).message); }
    }
  } catch (error) {
    signal?.throwIfAborted();
    unknown.push((error as Error).message);
  }
  return { files: records, unknown };
}

export async function baselineWorkspace(directory: string, signal?: AbortSignal): Promise<WorkspaceBaseline> {
  const cwd = await realpath(directory);
  let root = cwd, head = "";
  try {
    root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"], signal)).toString().trim());
    head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).toString().trim();
  } catch { signal?.throwIfAborted(); }
  const base: WorkspaceBaseline = { cwd, root, head, files: {}, unknown: [] };
  return { ...base, ...await collect(base, true, signal) };
}

export async function reviewCommit(base: WorkspaceBaseline, ref: string, signal?: AbortSignal) {
  if (!base.head) {
    if (ref) throw new Error("An explicit review ref requires a workspace with a Git commit.");
    return "";
  }
  if (!ref) return base.head;
  const commit = (await git(base.root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], signal)).toString().trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("Cannot resolve review baseline commit.");
  return commit;
}
export function reviewScope(base: WorkspaceBaseline, commit?: string): WorkspaceBaseline {
  return commit === undefined ? base : { ...base, head: commit, files: {}, unknown: [] };
}

export async function branchReviewBase(base: WorkspaceBaseline, configured: string, signal?: AbortSignal) {
  if (!base.head) return configured ? reviewCommit(base, configured, signal) : "";
  let tip: string | undefined;
  if (configured) tip = await reviewCommit(base, configured, signal);
  else for (const ref of ["refs/remotes/origin/HEAD","refs/heads/main","refs/heads/master","refs/remotes/origin/main"]) {
    try { await git(base.root, ["show-ref","--verify","--quiet",ref], signal); }
    catch (error) { if ((error as {code?: number}).code === 1) continue; throw error; }
    tip = await reviewCommit(base, ref, signal);
    break;
  }
  if (!tip) return base.head;
  const ancestor = (await git(base.root, ["merge-base", tip, base.head], signal)).toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ancestor)) throw Error("No common ancestor for the configured review branch.");
  return ancestor;
}

// Insertions + deletions after trimming common ends. Refuse costly worst cases
// rather than reporting an upper bound as an exact count.
async function changedLines(a: FileState, b: FileState, signal?: AbortSignal): Promise<number | undefined> {
  if (a.lines < 0 || b.lines < 0) return;
  const left = Buffer.from(a.hashes, "base64"), right = Buffer.from(b.hashes, "base64");
  const equal = (i: number, j: number) => left.readBigUInt64LE(i * 8) === right.readBigUInt64LE(j * 8);
  let first = 0, m = a.lines, n = b.lines;
  while (first < m && first < n && equal(first, first)) first++;
  while (m > first && n > first && equal(m - 1, n - 1)) { m--; n--; }
  m -= first; n -= first;
  if (!m || !n) return m + n;
  if (m * n > 1_000_000)
    return largeDiff(left.subarray(first * 8, (first + m) * 8), right.subarray(first * 8, (first + n) * 8), signal);
  const row = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    let diagonal = 0;
    for (let j = 1; j <= n; j++) {
      const old = row[j];
      row[j] = equal(first + i - 1, first + j - 1) ? diagonal + 1 : Math.max(row[j - 1], old);
      diagonal = old;
    }
  }
  return m + n - 2 * row[n];
}

async function originalFile(base: WorkspaceBaseline, path: string, retain: boolean, signal?: AbortSignal): Promise<FileState> {
  if (Object.hasOwn(base.files, path)) return base.files[path];
  if (!base.head) return empty;
  const name = relative(base.root, resolve(base.cwd, path)).split(sep).join("/");
  const tracked = await git(base.root, ["ls-tree", "-z", base.head, "--", ":(literal)" + name], signal);
  if (!tracked.length) return empty;
  const blob = base.head + ":" + name;
  const size = Number((await git(base.root, ["cat-file", "-s", blob], signal)).toString());
  if (size > maxFileBytes) {
    const stats = await git(base.root, ["diff", "--numstat", "--no-textconv", "--no-ext-diff", "--no-renames", base.head, "--", ":(literal)" + name], signal);
    const binary = stats.subarray(0, 4).toString() === "-\t-\t";
    return { ...empty, digest: "Git object " + tracked.toString().split("\t")[0], lines: binary ? 0 : -1, ...(binary && { binary: true }) };
  }
  return fromBytes(await git(base.root, ["cat-file", "blob", blob], signal), retain);
}

export async function measureWorkspace(base: WorkspaceBaseline, fileThreshold: number, signal?: AbortSignal, scoped: readonly ScopedFile[] = []): Promise<WorkspaceDelta> {
  const current = await collect(base, false, signal);
  const unknown = [...base.unknown, ...current.unknown];
  const changes: Array<[string, string]> = [];
  let total = 0, largestCrossing = 0;
  const predicates = new Map<string, number>();
  const sites = new Set<string>();
  const localPaths = new Set(Object.keys(current.files).map(path => resolve(base.cwd,path)));
  const versions = new Map(scoped.filter(f=>!localPaths.has(f.path)).map(f => [f.path, f]));
  for (const [path, now] of [...Object.entries(current.files), ...[...versions.values()].map(f => [f.path, f.current] as const)]) {
    signal?.throwIfAborted();
    let before = empty;
    try { before = versions.get(path)?.before ?? await originalFile(base, path, false, signal); }
    catch (error) { signal?.throwIfAborted(); unknown.push(path + ": " + (error as Error).message); }
    if (before.digest === now.digest) continue;
    changes.push([path, now.digest]);
    const count = await changedLines(before, now, signal);
    if (count === undefined) unknown.push(path + ": text diff or file inspection limit");
    else total += count;
    if (before.lines >= 0 && before.lines <= fileThreshold && now.lines > fileThreshold) largestCrossing = Math.max(largestCrossing, now.lines);
    for (const [name, count] of Object.entries(now.branches)) {
      const added = Math.max(0, count - (before.branches[name] ?? 0));
      if (name.startsWith("scope:")) { if (added) sites.add(path + "#" + name); }
      else predicates.set(name, (predicates.get(name) ?? 0) + added);
    }
  }
  // Repeated predicates or additions spread across different files/functions
  // are review signals. Semantic equivalence remains a reviewer decision.
  const addedBranches = [...predicates.values()].reduce((max, count) => Math.max(max, count), sites.size);
  return { fingerprint: hash(JSON.stringify([changes, unknown])), paths: changes.map(([name]) => name), fileDigests: new Map(changes),
    changedLines: total, largestCrossing, addedBranches, unknown, coverageComplete: !base.unknown.length && !current.unknown.length };
}

/** Dirty files at task start can differ from HEAD. Give reviewers the original
 * changed span they cannot reconstruct from Git; clean tracked files have HEAD. */
export async function reviewBaseline(base: WorkspaceBaseline, paths: string[], signal?: AbortSignal, scoped: readonly ScopedFile[] = []) {
  let budget = 32_000;
  const originals: Record<string, string> = Object.create(null);
  for (const path of paths) {
    signal?.throwIfAborted();
    const external = scoped.find(f => f.path === path);
    const original = external?.before ?? await originalFile(base, path, true, signal);
    const now = external?.current ?? await fileState(base.cwd, path, { bytes: 0 }, true, signal);
    if (original.binary || now.binary || original.lines < 0 || now.lines < 0) {
      originals[path] = "Binary or oversized; inspect directly. Original " + original.digest + ", current " + now.digest;
      continue;
    }
    const lines = original.source ? inflateRawSync(Buffer.from(original.source, "base64")).toString().split(/\r?\n/) : [];
    const next = now.source ? inflateRawSync(Buffer.from(now.source, "base64")).toString().split(/\r?\n/) : [];
    let first = 0, end = lines.length, nextEnd = next.length;
    while (first < end && first < nextEnd && lines[first] === next[first]) first++;
    while (end > first && nextEnd > first && lines[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    const snippet = "Before:\n" + lines.slice(first, end).join("\n") + "\nAfter:\n" + next.slice(first, nextEnd).join("\n"), available = Math.min(6000, Math.max(0, budget));
    originals[path] = "Original lines " + (first + 1) + ".." + end + ", current lines " + (first + 1) + ".." + nextEnd + "\n" +
      snippet.slice(0, available) + (snippet.length > available ? "\n[Excerpt truncated; inspect file and baseline directly]" : "");
    budget -= Math.min(available, snippet.length);
  }
  return { originalCommit: base.head || null, originals };
}

export async function readPlanFile(cwd: string, artifact?: string, configuredPath?: string) {
  const name = configuredPath || artifact;
  if (!name) throw new Error("Supply the actual plan document in complete({artifact}) or configure planPath.");
  if (configuredPath && artifact && relative(resolve(cwd, configuredPath), resolve(cwd, artifact)) !== "")
    throw new Error("The saved planPath for this workflow is " + configuredPath + ". Verify that document.");
  const path = await realpath(resolve(cwd, name)), rel = relative(cwd, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Plan must be a document in this workspace.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = await file.stat();
    if (!start.isFile() || start.size > 2 * 1024 * 1024) throw new Error("Plan must be a regular text document under 2 MiB.");
    const data = await file.readFile(), end = await file.stat();
    if (data.length !== start.size || end.mtimeMs !== start.mtimeMs || await realpath(resolve(cwd, name)) !== path || (await lstat(path)).ino !== end.ino)
      throw new Error("Plan changed during validation.");
    return { path: rel.split(sep).join("/"), digest: hash(data), text: data.toString("utf8") };
  } finally { await file.close(); }
}
