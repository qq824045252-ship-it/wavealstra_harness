import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { caseInsensitivePathFs, pathKey } from "../platform/paths";
import { MANIFEST_FILENAME, MANIFEST_TMP_SUFFIX } from "../task/TaskExecutionWorkspace";

const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const TEMP_PREFIX = ".mybuddy-review-";

export interface ReviewTarget {
  root: string;
  rootEntity: string;
  path: string;
  key: string;
  relativePath: string;
}

export interface ReviewState {
  present: boolean;
  stamp: string;
  bytes: Buffer | null;
  mode: number | null;
  reason?: string;
}

const entity = (stats: BigIntStats) => `${stats.dev}:${stats.ino}`;
const version = (stats: BigIntStats) =>
  `${entity(stats)}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

export function codeReviewTarget(workspaceRoot: string, input: string): ReviewTarget {
  const requestedRoot = resolve(workspaceRoot);
  const root = realpathSync.native(requestedRoot);
  const rel = relative(requestedRoot, resolve(input));
  const parts = rel.split(sep);
  if (!rel || isAbsolute(rel) || parts[0] === ".." || parts.some(part => {
    const key = pathKey(part);
    return key === ".git" || key.includes(":") || key === pathKey(MANIFEST_FILENAME) ||
      key.endsWith(pathKey(MANIFEST_TMP_SUFFIX)) || key.startsWith(TEMP_PREFIX) ||
      (caseInsensitivePathFs() && /[. ]$/.test(key));
  })) {
    throw new Error("文件不在可审查的任务工作区内");
  }
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.ino === 0n) throw new Error("无法确认任务工作区身份");
  const path = resolve(root, rel);
  return { root, rootEntity: entity(rootStat), path, key: pathKey(path), relativePath: parts.join("/") };
}

/** Check every component and verify that the opened file is still the observed directory entry. */
export function readReviewState(target: ReviewTarget): ReviewState {
  const rootStat = lstatSync(target.root, { bigint: true });
  if (!rootStat.isDirectory() || entity(rootStat) !== target.rootEntity ||
    pathKey(realpathSync.native(target.root)) !== pathKey(target.root)) {
    throw new Error("任务工作区目录已更换");
  }
  const parts = relative(target.root, target.path).split(sep);
  let current = target.root;
  let parent = rootStat;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry: BigIntStats;
    try { entry = lstatSync(current, { bigint: true }); }
    catch (error) {
      if (!isMissing(error)) throw error;
      return { present: false, stamp: `missing:${entity(parent)}:${parts.slice(index).join("/")}`, bytes: null, mode: null };
    }
    if (entry.isSymbolicLink() || entry.ino === 0n) throw new Error("路径包含链接或无法确认文件身份");
    if (index < parts.length - 1) {
      if (!entry.isDirectory()) throw new Error("文件的父路径已变化");
      parent = entry;
      continue;
    }
    if (!entry.isFile() || entry.nlink !== 1n) throw new Error("路径已变成目录、特殊文件或硬链接");
    const stamp = `${entity(parent)}:${version(entry)}`;
    if (entry.size > MAX_REVIEW_BYTES) {
      return { present: true, stamp, bytes: null, mode: null, reason: "文件超过 2 MiB，无法保留完整的还原依据" };
    }
    const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (version(fstatSync(fd, { bigint: true })) !== version(entry)) throw new Error("文件正在被其他程序修改");
      const bytes = Buffer.alloc(Number(entry.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      if (count !== bytes.length - 1 || version(fstatSync(fd, { bigint: true })) !== version(entry) ||
        version(lstatSync(current, { bigint: true })) !== version(entry)) {
        throw new Error("文件正在被其他程序修改");
      }
      return { present: true, stamp, bytes: bytes.subarray(0, count), mode: Number(entry.mode & 0o777n) };
    } finally { closeSync(fd); }
  }
  throw new Error("缺少审查文件路径");
}

export function sameReviewContent(left: ReviewState, right: ReviewState): boolean {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  if (left.bytes && right.bytes) return left.mode === right.mode && left.bytes.equals(right.bytes);
  return left.stamp === right.stamp;
}

export function sameReviewState(left: ReviewState, right: ReviewState): boolean {
  return left.stamp === right.stamp && sameReviewContent(left, right);
}

/** Recheck immediately before touching the working copy. A deleted file is recreated exclusively. */
export function restoreReviewState(target: ReviewTarget, before: ReviewState, expected: ReviewState): void {
  const verify = () => {
    if (!sameReviewState(readReviewState(target), expected)) throw new Error("文件已被手工修改或被其他任务修改");
  };
  if (!before.present) {
    verify();
    unlinkSync(target.path);
    return;
  }
  if (!before.bytes || before.mode === null) throw new Error("缺少文件修改前的完整内容");
  const temporary = join(dirname(target.path), `${TEMP_PREFIX}${randomUUID()}`);
  const fd = openSync(temporary, "wx", before.mode);
  try {
    try {
      writeFileSync(fd, before.bytes);
      fchmodSync(fd, before.mode);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    verify();
    if (expected.present) renameSync(temporary, target.path);
    else linkSync(temporary, target.path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (!isMissing(error)) console.warn(`[CodeReview] Temporary file cleanup failed: ${basename(temporary)}`, error);
    }
  }
}

export function reviewText(state: ReviewState): string | null {
  if (!state.bytes || state.bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(state.bytes); }
  catch { return null; }
}
