/**
 * TaskWorkspaceBrancher — 对话分支的独立工作区快照（实施规划 §8.3/§10.2）。
 *
 * 语义：复制源 Task 的**当前**文件快照到 child canonical 工作区；绝不宣称
 * 恢复到历史消息时的磁盘状态（§8.1），不做任何 Git 操作（§8.5）。
 *
 * 安全约束（§8.3）：
 * - 复制前预检文件数/总大小/不可读项/reparse point，超阈值由服务层要求确认；
 * - 排除源 `.mybuddy-task.json` 与 MyBuddy 内部临时文件；child 自己写 manifest；
 * - 不跟随逃逸 root 的 symlink / Junction（reparse point 一律跳过并计数）；
 * - target 已存在且 manifest taskId 不匹配时停止（复用 TaskExecutionWorkspace 校验）。
 *
 * commit 前清理锚点（§10.2 评审裁决）：一次性复制产物放在
 * `<childDir>.pending-<sha256(requestId)前12位>` 临时目录，成功后原子 rename 为
 * canonical child 目录；清理时凭 exact path + requestId 派生名验证"确属本次创建"，
 * 只能删本 requestId 对应目录，绝不触碰 source root / 共享 Space.path。
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  TaskManifestMismatchError,
  atomicWriteJson,
  isPathInsideOrEqual,
  normalizePathForComparison,
} from "./TaskExecutionWorkspace";

export interface WorkspaceSnapshotPreflight {
  fileCount: number;
  totalBytes: number;
  unreadableCount: number;
  skippedReparsePointCount: number;
  /** 任一限制超出 → 需要用户确认（复制 / 仅分支对话 / 取消） */
  overLimit: boolean;
}

export const SNAPSHOT_LIMITS = {
  /** 文件数上限（§8.3） */
  maxFiles: 100_000,
  /** 逻辑大小上限（§8.3，2 GiB） */
  maxBytes: 2 * 1024 * 1024 * 1024,
} as const;

export interface SnapshotCopyResult {
  /** commit 后 child 的 canonical cwd */
  childCwd: string;
  fileCount: number;
  totalBytes: number;
}

export class ConversationBranchWorkspaceError extends Error {}

/** 内部临时目录名段（requestId 锚定，§10.2） */
function pendingDirName(requestId: string): string {
  const hash = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 12);
  return `.branch-pending-${hash}`;
}

interface WalkStats {
  fileCount: number;
  totalBytes: number;
  unreadableCount: number;
  reparsePointCount: number;
}

/** 单趟 walk：统计（不复制）；reparse point 一律记录，不可读项吞掉并计数 */
function walkStats(root: string): WalkStats {
  const out: WalkStats = { fileCount: 0, totalBytes: 0, unreadableCount: 0, reparsePointCount: 0 };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      out.unreadableCount++;
      continue;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        out.unreadableCount++;
        continue;
      }
      if (st.isSymbolicLink()) {
        out.reparsePointCount++;
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) {
        out.reparsePointCount++;
        continue;
      }
      out.fileCount++;
      out.totalBytes += st.size;
    }
  }
  return out;
}

/**
 * 复制源快照到 pending 临时目录（requestId 锚定，§10.2）。
 * 成功返回 { pendingDir, stats }；调用方随后调 commitPending 原子落位，
 * 或调 cleanupPending(requestId) 精确清理。
 */
export class TaskWorkspaceBrancher {
  private readonly workspace: TaskExecutionWorkspace;

  constructor(workspace?: TaskExecutionWorkspace) {
    this.workspace = workspace ?? new TaskExecutionWorkspace();
  }

  /** §8.3 预检：只读统计，无副作用 */
  preflight(sourceRoot: string): WorkspaceSnapshotPreflight {
    if (!sourceRoot || !existsSync(sourceRoot)) {
      return {
        fileCount: 0,
        totalBytes: 0,
        unreadableCount: 0,
        skippedReparsePointCount: 0,
        overLimit: false,
      };
    }
    const stats = walkStats(sourceRoot);
    return {
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      unreadableCount: stats.unreadableCount,
      skippedReparsePointCount: stats.reparsePointCount,
      overLimit:
        stats.fileCount > SNAPSHOT_LIMITS.maxFiles ||
        stats.totalBytes > SNAPSHOT_LIMITS.maxBytes,
    };
  }

  /** §8.4 conversation_only：新的空 canonical task workspace（含 manifest） */
  prepareEmptyWorkspace(childTaskId: string): string {
    return this.workspace.ensureTaskExecutionWorkspace(childTaskId);
  }

  /**
   * §10.2 清理锚点：exact path 由 requestId 派生名决定；只删本次创建的
   * pending 目录（与 child 是否已 commit 无关）。source 与共享目录绝不被触碰。
   */
  pendingDirFor(childTaskId: string, requestId: string): string {
    const base = this.workspace.resolveTaskExecutionWorkspaceDir(childTaskId);
    return `${base}.${pendingDirName(requestId)}`;
  }

  /**
   * 复制当前快照到 pending 目录（不落位）。
   * 失败时已复制内容由调用方 cleanupPending 清理；本函数不删除 source。
   */
  copySnapshotToPending(
    sourceRoot: string,
    childTaskId: string,
    requestId: string,
  ): { pendingDir: string; fileCount: number; totalBytes: number } {
    if (!sourceRoot || !existsSync(sourceRoot)) {
      throw new ConversationBranchWorkspaceError("源工作目录不存在或不可读");
    }
    const sourceReal = resolve(sourceRoot);
    const pendingDir = this.pendingDirFor(childTaskId, requestId);
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    const canonicalDir = this.workspace.resolveTaskExecutionWorkspaceDir(childTaskId);
    if (
      !isPathInsideOrEqual(workspacesRoot, pendingDir) ||
      !isPathInsideOrEqual(workspacesRoot, canonicalDir)
    ) {
      throw new ConversationBranchWorkspaceError("目标工作区路径越界，已拒绝");
    }
    // target 已存在且不是本 pending 目录 → 由 manifest 归属校验兜底（§10.2）
    if (pendingDir !== canonicalDir && existsSync(canonicalDir)) {
      try {
        this.workspace.readManifest(childTaskId);
      } catch (err) {
        if (err instanceof TaskManifestMismatchError) {
          throw new ConversationBranchWorkspaceError(
            `目标任务目录已存在且不属于本任务：${canonicalDir}`,
          );
        }
        throw new ConversationBranchWorkspaceError(
          `目标任务目录已存在且无有效清单：${canonicalDir}`,
        );
      }
    }
    if (existsSync(pendingDir)) {
      rmSync(pendingDir, { recursive: true, force: true });
    }
    mkdirSync(pendingDir, { recursive: true });

    let fileCount = 0;
    let totalBytes = 0;
    const stack: string[] = [sourceRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        // 不复制内部清单与 MyBuddy 内部临时文件（§8.3）
        if (name === MANIFEST_FILENAME || name.startsWith(".branch-pending-")) continue;
        const abs = join(dir, name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink() || !st.isFile() && !st.isDirectory()) continue; // 不跟随
        if (st.isDirectory()) {
          stack.push(abs);
          continue;
        }
        const rel = relative(sourceRoot, abs);
        const target = join(pendingDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        try {
          copyFileStream(abs, target);
        } catch {
          // 复制中途失败：调用方负责 cleanup；不删除 source
          throw new ConversationBranchWorkspaceError(`快照复制失败：${abs}`);
        }
        fileCount++;
        totalBytes += st.size;
      }
    }
    return { pendingDir, fileCount, totalBytes };
  }

  /**
   * commit：validated pending → canonical child dir。
   * 先写 child manifest（原子写），再 rename pending 为 canonical（§10.2 锚点）。
   */
  commitPending(
    childTaskId: string,
    requestId: string,
    pendingDir: string,
  ): string {
    const canonicalDir = this.workspace.resolveTaskExecutionWorkspaceDir(childTaskId);
    if (normalizePathForComparison(pendingDir) === normalizePathForComparison(canonicalDir)) {
      this.workspace.ensureTaskExecutionWorkspace(childTaskId);
      return canonicalDir;
    }
    const expectedPending = this.pendingDirFor(childTaskId, requestId);
    if (normalizePathForComparison(pendingDir) !== normalizePathForComparison(expectedPending)) {
      throw new ConversationBranchWorkspaceError(
        "快照落位失败：pending 目录与 requestId 锚点不一致",
      );
    }
    if (existsSync(canonicalDir)) {
      throw new ConversationBranchWorkspaceError(
        `快照落位失败：目标任务目录已存在：${canonicalDir}`,
      );
    }
    // 先落 manifest（exact path + manifest 校验锚点，§10.2）
    const manifest = {
      version: 1 as const,
      taskId: childTaskId,
      createdAt: Date.now(),
    };
    atomicWriteJson(join(pendingDir, MANIFEST_FILENAME), manifest);
    try {
      renameSync(expectedPending, canonicalDir);
    } catch (err) {
      throw new ConversationBranchWorkspaceError(
        `快照落位失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return canonicalDir;
  }

  /**
   * §10.2：commit 前失败清理——只删除本次 requestId 对应的 pending 目录。
   * exact path 由 requestId 派生名验证；不删 source/共享目录/其它任务目录。
   */
  cleanupPending(childTaskId: string, requestId: string): void {
    try {
      const pendingDir = this.pendingDirFor(childTaskId, requestId);
      if (existsSync(pendingDir)) {
        rmSync(pendingDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(
        `[TaskWorkspaceBrancher] orphan 诊断：清理失败 ${childTaskId} ${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 流式文件复制（支持大文件，避免整读进内存） */
function copyFileStream(src: string, dest: string): void {
  const fdIn = openSync(src, "r");
  const fdOut = openSync(dest, "w");
  const buf = Buffer.allocUnsafe(1024 * 256);
  try {
    let bytesRead = 0;
    let position = 0;
    do {
      bytesRead = readSyncChunk(fdIn, buf, position);
      if (bytesRead > 0) {
        writeSyncChunk(fdOut, buf.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);
    // 目标文件补一个 size 一致性检查（可选：不读内容）
    const srcStat = statSync(src);
    const destStat = statSync(dest);
    if (srcStat.size !== destStat.size) {
      throw new ConversationBranchWorkspaceError(`快照复制大小不一致：${src}`);
    }
  } finally {
    closeSync(fdIn);
    closeSync(fdOut);
  }
}

function readSyncChunk(fd: number, buf: Buffer, position: number): number {
  return readSync(fd, buf, 0, buf.length, position);
}
function writeSyncChunk(fd: number, buf: Buffer): void {
  writeSync(fd, buf, 0, buf.length);
}