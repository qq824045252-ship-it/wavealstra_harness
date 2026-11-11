/** Path resolution plus legacy grant metadata. Grants no longer restrict application execution. */
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

    // Keep canonical task/path metadata, but retired grants do not authorize execution.
    return { ...base, allowed: true, resolvedPath: resolved,
      scope: isPathInsideOrEqual(this.taskRoot, resolved) ? "task-root" : "external",
      reason: "应用文件授权已移除；由实际文件系统执行并返回结果" };

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
