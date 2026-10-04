/**
 * 资料库受管文件 I/O 硬化：原子写（temp + fsync + rename，Windows 兼容）、
 * 路径边界与 symlink/reparse 逃逸校验。
 *
 * - 所有受管文件位于 <libraryRoot>/<spaceId>/<itemId><ext>，路径段全部由主进程生成；
 * - 读取/预览前必须 assertManagedPathSafe：词法边界 + 逐组件 lstat 拒绝 symlink/junction；
 * - 写入采用 temp + fsync + atomic rename，避免半写；调用方负责 DB 记录顺序。
 */
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export function isPathInsideManagedRoot(root: string, abs: string): boolean {
  const rootResolved = resolve(root);
  const absResolved = resolve(abs);
  if (absResolved === rootResolved) return true;
  return absResolved.startsWith(rootResolved + sep);
}

/** 逐组件 lstat：任一中间路径是 symlink/junction（reparse）即拒绝 */
export function assertNoSymlinkEscape(root: string, abs: string): void {
  if (!isPathInsideManagedRoot(root, abs)) {
    throw new Error("受管文件路径越界");
  }
  const rel = relative(resolve(root), resolve(abs));
  const parts = rel.split(sep).filter((p) => p && p !== "." && p !== "..");
  let cursor = resolve(root);
  for (const part of parts) {
    cursor = resolve(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      throw new Error(`受管文件路径不可访问：${cursor}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`受管路径包含符号链接/junction，已拒绝：${cursor}`);
    }
  }
}

/**
 * 写路径安全校验（与读取侧同边界）：
 * - 词法上必须位于 managed root 内；
 * - 父链（不含最终组件）逐级 lstat，任一 symlink/junction 拒绝；
 * - 最终组件若已存在且为 symlink/junction 也拒绝（copyFileSync 会跟随写出库）。
 * 最终组件不存在（首次创建）是合法的。
 */
export function assertManagedWritePathSafe(root: string, abs: string): void {
  if (!isPathInsideManagedRoot(root, abs)) {
    throw new Error("受管文件路径越界");
  }
  const rel = relative(resolve(root), resolve(abs));
  const parts = rel.split(sep).filter((p) => p && p !== "." && p !== "..");
  const dirParts = parts.slice(0, -1);
  let cursor = resolve(root);
  for (const part of dirParts) {
    cursor = resolve(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      return; // 父组件尚不存在：后续由 mkdirSync 在 root 内新建，不可能已是 symlink
    }
    if (st.isSymbolicLink()) {
      throw new Error(`受管路径包含符号链接/junction，已拒绝：${cursor}`);
    }
  }
  const final = resolve(abs);
  let st;
  try {
    st = lstatSync(final);
  } catch {
    return; // 最终组件不存在（首次创建）合法
  }
  if (st.isSymbolicLink()) {
    throw new Error(`受管路径包含符号链接/junction，已拒绝：${final}`);
  }
}

export function assertManagedPathSafe(root: string, abs: string): void {
  assertNoSymlinkEscape(root, abs);
}

/** 原子写：temp（同目录，保证同卷 rename）→ fsync → rename 覆盖。失败清理 temp。 */
export function atomicWriteFileSync(target: string, content: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (cause) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw cause;
  }
}

/** 原子复制：先复制到同目录 temp，再 rename 覆盖；用于二进制受管文件刷新。 */
export function atomicCopyFileSync(source: string, target: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.copy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    copyFileSync(source, tmp);
    renameSync(tmp, target);
  } catch (cause) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw cause;
  }
}