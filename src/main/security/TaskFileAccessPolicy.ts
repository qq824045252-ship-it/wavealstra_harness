/**
 * TaskFileAccessPolicy — 统一任务文件访问策略（P2 / Batch 10）
 *
 * 默认：
 *  - taskRoot 内：读/写/建允许；删/改名需调用方再走权限+备份
 *  - 显式只读 grant：只读，禁止写回
 *  - 其他外部路径：拒绝（或交由审批层，本模块返回 denied）
 *
 * grant 不因单文件授权父目录；grant 路径本身必须精确匹配或位于 grant 路径内（若 grant 是目录）。
 */
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertPathInsideTask,
  canonicalizeExternalGrantPath,
  isPathInsideOrEqual,
  isPathInsideWriteGrant,
  normalizePathForComparison,
  TaskPathBoundaryError,
} from "../task/TaskExecutionWorkspace";

export type FileAccessOperation =
  | "read"
  | "create"
  | "write"
  | "edit"
  | "delete"
  | "rename"
  | "execute";

export type FileAccessScope = "task-root" | "read-grant" | "write-grant" | "external" | "isolated-source";

export interface FileAccessDecision {
  allowed: boolean;
  taskId: string;
  operation: FileAccessOperation;
  requestedPath: string;
  resolvedPath?: string;
  scope?: FileAccessScope;
  reason: string;
}

export interface ReadGrant {
  /** 绝对路径：文件或目录 */
  path: string;
  /** 来源说明（附件/Space 参考等） */
  source?: string;
  createdAt?: number;
}

/**
 * 任务级目录写 grant（外部写授权，scope=task-dir）。
 * 只允许「目录」粒度；持久化在 task_write_grants 表，匹配走词法 + realpath 双层。
 */
export interface WriteGrant {
  /** canonical 目录绝对路径（已 realpath 固化） */
  path: string;
  /** 来源说明（用户授权等） */
  source?: string;
  createdAt?: number;
}

export interface TaskFileAccessPolicyOptions {
  taskId: string;
  taskRoot: string;
  readGrants?: ReadGrant[];
  writeGrants?: WriteGrant[];
  /** Source workspaces of independent conversation forks; auto is not a grant to mutate the source copy. */
  isolatedSourceRoots?: string[];
}

const WRITE_OPS: ReadonlySet<FileAccessOperation> = new Set([
  "create",
  "write",
  "edit",
  "delete",
  "rename",
]);

export class TaskFileAccessPolicy {
  readonly taskId: string;
  readonly taskRoot: string;
  private readonly grants: ReadGrant[];
  private readonly writeGrants: WriteGrant[];
  private readonly isolatedSourceRoots: string[];

  constructor(options: TaskFileAccessPolicyOptions) {
    if (!options.taskId?.trim()) throw new Error("TaskFileAccessPolicy: taskId 不能为空");
    if (!options.taskRoot?.trim()) throw new Error("TaskFileAccessPolicy: taskRoot 不能为空");
    this.taskId = options.taskId;
    this.taskRoot = resolve(options.taskRoot);
    this.grants = [...(options.readGrants ?? [])];
    this.writeGrants = [...(options.writeGrants ?? [])];
    this.isolatedSourceRoots = [...new Set((options.isolatedSourceRoots ?? []).map((p) => resolve(p)))];
  }

  listReadGrants(): readonly ReadGrant[] {
    return this.grants;
  }

  listWriteGrants(): readonly WriteGrant[] {
    return this.writeGrants;
  }

  /** 运行时追加任务级目录写 grant（持久化由调用方负责；幂等） */
  addWriteGrant(grant: WriteGrant): void {
    const path = resolve(grant.path);
    if (
      this.writeGrants.some((g) =>
        normalizePathForComparison(g.path) === normalizePathForComparison(path),
      )
    ) {
      return;
    }
    this.writeGrants.push({ ...grant, path, createdAt: grant.createdAt ?? Date.now() });
  }

  /**
   * 运行时移除任务级目录写 grant（撤销后当前会话立即失效；持久化由调用方负责）。
   * 命中判定与 addWriteGrant 一致（normalize 后比较）。返回是否移除成功。
   */
  removeWriteGrant(path: string): boolean {
    const target = normalizePathForComparison(resolve(path));
    const idx = this.writeGrants.findIndex(
      (g) => normalizePathForComparison(g.path) === target,
    );
    if (idx < 0) return false;
    this.writeGrants.splice(idx, 1);
    return true;
  }

  /** 是否命中任务级目录写 grant（target 位于 grant 目录内，词法 + realpath） */
  hasWriteGrantFor(target: string): boolean {
    const resolved = this.resolvePath(target);
    return this.writeGrants.some((g) => isPathInsideWriteGrant(g.path, resolved));
  }

  /**
   * 添加 task-scoped 只读 grant。
   * 不因单文件自动授权父目录；路径 resolve 后原样记录。
   */
  addReadGrant(grant: ReadGrant): void {
    const path = resolve(grant.path);
    if (this.grants.some((g) => normalizePathForComparison(g.path) === normalizePathForComparison(path))) {
      return;
    }
    this.grants.push({ ...grant, path, createdAt: grant.createdAt ?? Date.now() });
  }

  /** 解析相对路径（相对 taskRoot）或绝对路径 */
  resolvePath(requestedPath: string): string {
    const raw = requestedPath.trim();
    if (!raw) throw new Error("路径不能为空");
    return isAbsolute(raw) ? resolve(raw) : resolve(this.taskRoot, raw);
  }

  decide(operation: FileAccessOperation, requestedPath: string): FileAccessDecision {
    const base = {
      taskId: this.taskId,
      operation,
      requestedPath,
    };

    let resolved: string;
    try {
      resolved = this.resolvePath(requestedPath);
    } catch (err) {
      return {
        ...base,
        allowed: false,
        scope: "external",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // taskRoot 内（词法 + realpath）
    try {
      assertPathInsideTask(this.taskRoot, resolved);
      if (operation === "execute") {
        // 执行由 Shell isolation backend 最终裁决；此处标记为 task-root 待定允许
        return {
          ...base,
          allowed: true,
          resolvedPath: resolved,
          scope: "task-root",
          reason: "路径位于 taskRoot；execute 仍受 Shell isolation 约束",
        };
      }
      return {
        ...base,
        allowed: true,
        resolvedPath: resolved,
        scope: "task-root",
        reason: "路径位于 taskRoot 内",
      };
    } catch (err) {
      if (!(err instanceof TaskPathBoundaryError)) {
        return {
          ...base,
          allowed: false,
          resolvedPath: resolved,
          scope: "external",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 只读 grant
    const grantHit = this.findGrant(resolved);
    if (grantHit) {
      if (WRITE_OPS.has(operation) || operation === "execute") {
        return {
          ...base,
          allowed: false,
          resolvedPath: resolved,
          scope: "read-grant",
          reason: `路径命中只读 grant（${grantHit.source ?? grantHit.path}），禁止 ${operation}`,
        };
      }
      return {
        ...base,
        allowed: true,
        resolvedPath: resolved,
        scope: "read-grant",
        reason: `路径命中只读 grant${grantHit.source ? `：${grantHit.source}` : ""}`,
      };
    }

    // 任务级目录写 grant（外部写授权）：目录粒度，词法 + realpath 双层匹配
    const writeGrantHit = this.writeGrants.find((g) => isPathInsideWriteGrant(g.path, resolved));
    if (writeGrantHit) {
      if (operation === "execute") {
        return {
          ...base,
          allowed: false,
          resolvedPath: resolved,
          scope: "write-grant",
          reason: `路径命中任务写 grant（${writeGrantHit.path}），execute 不受目录 grant 放行`,
        };
      }
      return {
        ...base,
        allowed: true,
        resolvedPath: resolved,
        scope: "write-grant",
        reason: `路径位于任务写 grant 目录内：${writeGrantHit.path}`,
      };
    }

    // The current task root and explicit child-task grants above take precedence.
    // Historical absolute paths do not imply permission to operate on the parent
    // copy, even in auto mode. Do not silently rewrite a tool's path/evidence.
    const canonical = canonicalizeExternalGrantPath(resolved);
    const sourceRoot = this.isolatedSourceRoots.find((root) =>
      isPathInsideOrEqual(root, resolved) || isPathInsideOrEqual(canonicalizeExternalGrantPath(root), canonical));
    if (sourceRoot) {
      const rel = isPathInsideOrEqual(sourceRoot, resolved)
        ? relative(sourceRoot, resolved)
        : relative(canonicalizeExternalGrantPath(sourceRoot), canonical);
      return { ...base, allowed: false, resolvedPath: resolved, scope: "isolated-source",
        reason: `这是独立对话分支，历史路径 ${resolved} 属于来源任务，不是当前副本。请在当前工作目录 ${this.taskRoot} 下重试；对应位置为 ${resolve(this.taskRoot, rel)}。不要复用旧绝对路径或用其他工具绕过。若用户确实要操作来源任务，应切回来源任务或显式授权该目录。` };
    }
    return {
      ...base,
      allowed: false,
      resolvedPath: resolved,
      scope: "external",
      reason: `路径不在 taskRoot 且无只读/写 grant：${resolved}（taskRoot=${this.taskRoot}）`,
    };
  }

  /** 便捷：不允许则抛错 */
  assertAllowed(operation: FileAccessOperation, requestedPath: string): string {
    const d = this.decide(operation, requestedPath);
    if (!d.allowed || !d.resolvedPath) {
      throw new TaskPathBoundaryError(d.reason);
    }
    return d.resolvedPath;
  }

  private findGrant(resolved: string): ReadGrant | undefined {
    for (const g of this.grants) {
      const grantPath = resolve(g.path);
      if (normalizePathForComparison(grantPath) === normalizePathForComparison(resolved)) {
        return g;
      }
      // grant 为目录时允许其子路径只读
      if (isPathInsideOrEqual(grantPath, resolved)) {
        return g;
      }
    }
    return undefined;
  }
}
