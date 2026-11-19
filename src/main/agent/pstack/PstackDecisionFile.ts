import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pstackDecisionLogPath } from "../../../shared/pstack/paths";
import { assertPathInsideTask } from "../../task/TaskExecutionWorkspace";
import { pathKey } from "../../platform/paths";

export const header = "ts\tphase\tdecision\twhy\tevidence\tresult";
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const flags = constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

/** Verify existing ancestors before following them. Only the authorized write leaf may create parents. */
export async function trailTarget(cwd: string, name: string, createParents = false) {
  return guardedWorkspaceTarget(cwd, pstackDecisionLogPath(name), createParents, "Decision log");
}

export async function guardedWorkspaceTarget(cwd: string, canonicalName: string, createParents = false, label = "Workspace artifact") {
  const root = await realpath(cwd);
  const path = assertPathInsideTask(root, resolve(root, canonicalName));
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!createParents) break;
      try { await mkdir(current); }
      catch (other) { if (!(other instanceof Error && "code" in other && other.code === "EEXIST")) throw other; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || pathKey(await realpath(current)) !== pathKey(current)) throw new Error(label + " parent is redirected.");
  }
  let info;
  try { info = await lstat(path); } catch (error) { if (!missing(error)) throw error; }
  if (info && (!info.isFile() || info.nlink !== 1 || pathKey(await realpath(path)) !== pathKey(path))) {
    throw new Error(label + " must be a regular, unlinked workspace file.");
  }
  return { path, info };
}

type ScanOptions = { prefixBytes?: number; visit?: (line: number, row: string) => void; signal?: AbortSignal };

/** Hash the previous file without accumulating unrelated conversations' rows in memory. */
async function scan(handle: FileHandle | null, path: string, { prefixBytes, visit, signal }: ScanOptions) {
  const hash = createHash("sha256"), prefix = createHash("sha256");
  let size = 0, count = 0, pending = "", newline = "\n", last = "";
  const result = () => ({ hash, size, count, newline, last, needsTerminator: !!pending, prefixHash: prefix.digest("hex") });
  if (!handle) return result();
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.ino === 0) throw new Error("Invalid decision log descriptor.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const line = (raw: string) => {
    count++;
    if (count === 1 && raw.endsWith("\r")) newline = "\r\n";
    last = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fields = last.split("\t");
    if (count === 1 ? last !== header : fields.length !== 6 || last.includes("\r") ||
      !/^\d{4}-\d\d-\d\dT/.test(fields[0]) || !Number.isFinite(Date.parse(fields[0]))) {
      throw new Error("Invalid decision log header or TSV at line " + count + ". Its history was preserved.");
    }
    visit?.(count, last);
  };
  const buffer = Buffer.alloc(64 * 1024);
  while (size < before.size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - size), size);
    if (!bytesRead) throw new Error("Decision log was truncated during review.");
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    if (prefixBytes !== undefined && size < prefixBytes) prefix.update(bytes.subarray(0, prefixBytes - size));
    size += bytesRead;
    if (visit) {
      const lines = decoder.decode(bytes, { stream: true }).split("\n");
      if (lines.length > 1) {
        line(pending + lines[0]);
        for (let i = 1; i < lines.length - 1; i++) line(lines[i]);
        pending = lines.at(-1)!;
      } else pending += lines[0];
      if (pending.length > 16 * 1024 * 1024) throw new Error("A single decision TSV row exceeds 16 MiB of text.");
    }
  }
  if (visit) {
    pending += decoder.decode();
    if (pending) line(pending);
  }
  const after = await lstat(path);
  if (!after.isFile() || after.nlink !== 1 || pathKey(await realpath(path)) !== pathKey(path) ||
    after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs) throw new Error("Decision log changed while reading; retry.");
  return result();
}

export async function scanTrail(cwd: string, name: string, options: ScanOptions) {
  const target = await trailTarget(cwd, name);
  if (!target.info) return scan(null, target.path, options);
  const file = await open(target.path, flags | constants.O_RDONLY);
  try { return await scan(file, target.path, options); } finally { await file.close(); }
}

export type TrailIntent = {
  task: string; run: number; path: string; decisionKey: string; beforeHash: string; beforeBytes: number; append: string;
  expectedSha256: string; expectedBytes: number; rows: string[]; line: number; existed: boolean;
};

/** A single O_APPEND write preserves other writers' bytes. O_EXCL protects the creation race. */
export async function appendTrailBytes(cwd: string, intent: TrailIntent, check: () => void, signal?: AbortSignal) {
  check();
  const { path, info } = await trailTarget(cwd, intent.path, true);
  const file = await open(path, flags | constants.O_APPEND | constants.O_RDWR |
    (!info && !intent.existed ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const current = await scan(file, path, { prefixBytes: intent.expectedBytes, signal });
    if (current.size >= intent.expectedBytes && current.prefixHash === intent.expectedSha256) return;
    const delta = current.size - intent.beforeBytes;
    let payload = Buffer.from(intent.append);
    if (delta > 0 && delta < payload.length) {
      const previous = await scan(file, path, { prefixBytes: intent.beforeBytes, signal });
      const tail = Buffer.alloc(delta);
      const { bytesRead } = await file.read(tail, 0, delta, intent.beforeBytes);
      if (previous.prefixHash !== intent.beforeHash || bytesRead !== delta || !tail.equals(payload.subarray(0, delta)))
        throw new Error("Decision file contains different bytes after the prepared prefix.");
      payload = payload.subarray(delta);
    } else if (delta !== 0 || current.hash.digest("hex") !== intent.beforeHash) {
      throw new Error("Decision log changed before append. Re-read and retry.");
    }
    check();
    const named = await lstat(path), opened = await file.stat();
    if (named.ino !== opened.ino || named.dev !== opened.dev || named.nlink !== 1 || named.size !== current.size ||
      pathKey(await realpath(path)) !== pathKey(path)) throw new Error("Decision log moved before append.");
    check();
    if ((await file.write(payload)).bytesWritten !== payload.length) throw new Error("Filesystem only accepted part of the decision row.");
    await file.sync();
  } finally { await file.close(); }
}
