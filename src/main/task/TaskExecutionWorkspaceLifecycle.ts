import { DOTS_TASK_ID } from "../../shared/dots";
/**
 * TaskExecutionWorkspaceLifecycle — 任务执行工作区生命周期（P1.5 / Batch 9）
 *
 * 对应《P0-task-project-isolation-fix.md》§16：
 *  - archive：只改状态，不移动目录
 *  - trash：校验 direct-child + manifest → 同卷 move 到回收区（~/.mybuddy/task-workspaces-trash）→ DB 标记
 *  - restore：目标冲突（不同 manifest）停止，不覆盖
 *  - purge：明确动作或超期后才永久清理；两阶段失败可 repair
 *  - orphan：只报告，提供 adopt / move-to-trash，不自动删除
 *
 * 禁止对用户目录做无校验的 rm -rf。
 */
import {
  existsSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isGatewayConversation } from "../../shared/gateway-task";
import { coreGatewayLifecyclePaths, currentTaskWorkspace, gatewayTaskWorkspace, validateGatewayTaskCwdAsync } from "./TaskWorkspaceResolver";
import { GATEWAY_TASK_FOLDER, isPlainDirectory, sameWorkspacePath, validatePlainTaskManifest } from "./QQTaskWorkspace";
import { TRASH_RETENTION_MS, type TrashedTaskDto } from "../../shared/archive-deletion";
import type { AppDatabase, TaskExecutionWorkspaceStateRow } from "../db/AppDatabase";
import type { TaskArchivePurgeScope } from "../platform/runtime-audit";
import { getTaskExecutionWorkspacesTrashDir } from "../paths";
import {
  getTaskDirectoryName,
  isPathInsideOrEqual,
  MANIFEST_FILENAME,
  normalizePathForComparison,
  TaskManifestError,
  TaskManifestMismatchError,
  TaskPathBoundaryError,
  TaskExecutionWorkspaceError,
  TaskExecutionWorkspace,
  type TaskExecutionWorkspaceManifest,
} from "./TaskExecutionWorkspace";

/** 回收保留期：7 天（TRASH_RETENTION_DAYS），超期由 purgeExpired 永久清理 */
export const DEFAULT_PURGE_AFTER_MS = TRASH_RETENTION_MS;

export class TaskLifecycleError extends TaskExecutionWorkspaceError {}
export class TaskLifecycleConflictError extends TaskLifecycleError {}
export class TaskLifecycleRepairRequiredError extends TaskLifecycleError {}

function archiveTrashError(taskId: string, archived: boolean): TaskLifecycleError {
  return new TaskLifecycleError(archived
    ? `任务已在回收区，请先恢复再归档：${taskId}`
    : `任务在回收区，请用 restore 而非 unarchive：${taskId}`);
}

export interface OrphanDirectoryReport {
  directoryName: string;
  path: string;
  manifestTaskId?: string;
  reason: "no_task_row" | "manifest_missing" | "manifest_mismatch" | "unreadable";
  details: string;
}

export interface TrashResult {
  taskId: string;
  state: "trashed";
  trashPath?: string;
  /** 目录本就不存在时为 true（仅 metadata 标记） */
  directoryMissing: boolean;
}

export interface RestoreResult {
  taskId: string;
  state: "active";
  workspaceDir: string;
}

export interface RuntimeTaskTrashRestore {
  taskId: string;
  directoryName: string;
  gateway?: { channel: string; version: string; destination: string; moveFrom?: string };
  expectedUpdatedAt: number;
  expectedTrashedAt?: number;
  expectedTrashPath?: string;
  cwd?: string;
  at: number;
}

export type RuntimeTaskTrashRestoreReply =
  | { status: "saved" | "needsHost" }
  | { status: "rejected"; message: string };

interface LocalRestoreFiles {
  directoryName: string;
  workspaceDir: string;
  cwd?: string;
  movedFrom?: string;
  redundantCopy?: string;
}

export interface PurgeResult {
  taskId: string;
  removedTrashDir: boolean;
  removedTaskRow: boolean;
}

interface TaskPurgeOptions {
  force?: boolean;
  strict?: boolean;
  assertAllowed?: () => void;
  archiveScope?: TaskArchivePurgeScope;
}

export interface TaskExecutionWorkspaceLifecycleOptions {
  db: AppDatabase;
  workspace?: TaskExecutionWorkspace;
  trashRoot?: string;
  /** 默认 30 天 */
  purgeAfterMs?: number;
  /**
   * 删除前停止 session / detach MCP（可选注入，测试可不传）。
   * 失败只 log，不阻断 trash（目录隔离优先完成）。
   */
  beforeTrash?: (taskId: string, options?: { strict?: boolean }) => void | Promise<void>;
  /** Exact 渠道restore only; joined to the lifecycle SQLite transaction. */
  prepareGatewayWorkspaceRestore?: (taskId: string, legacy: string, destination: string) => void;
  /**
   * 永久清理时删除 Artifact Domain 数据（可选）。
   * 未注入则 purge 只清目录 + task 行 + execution workspace state。
   */
  onPurgeArtifacts?: (taskId: string) => void | Promise<void>;
  /**
   * 永久清理时清理任务级外部配置（如 settings.json taskConnectorIds；可选）。
   * trash/restore 阶段任务行仍在，不得清理 —— 只有 purge（真永久删除）才触发。
   * 失败只 log，不阻断 purge。
   */
  onPurge?: (taskId: string) => void | Promise<void>;
}

export class TaskExecutionWorkspaceLifecycle {
  private readonly pendingRestoreOrPurge = new Set<string>();
  private readonly db: AppDatabase;
  private readonly workspace: TaskExecutionWorkspace;
  private readonly trashRoot: string;
  private readonly purgeAfterMs: number;
  private readonly beforeTrash?: TaskExecutionWorkspaceLifecycleOptions["beforeTrash"];
  private readonly prepareGatewayWorkspaceRestore?: TaskExecutionWorkspaceLifecycleOptions["prepareGatewayWorkspaceRestore"];
  private readonly onPurgeArtifacts?: TaskExecutionWorkspaceLifecycleOptions["onPurgeArtifacts"];
  private readonly onPurge?: TaskExecutionWorkspaceLifecycleOptions["onPurge"];

  constructor(options: TaskExecutionWorkspaceLifecycleOptions) {
    this.db = options.db;
    this.workspace = options.workspace ?? new TaskExecutionWorkspace();
    this.trashRoot = options.trashRoot
      ? resolve(options.trashRoot)
      : getTaskExecutionWorkspacesTrashDir();
    this.purgeAfterMs = options.purgeAfterMs ?? DEFAULT_PURGE_AFTER_MS;
    this.beforeTrash = options.beforeTrash;
    this.prepareGatewayWorkspaceRestore = options.prepareGatewayWorkspaceRestore;
    this.onPurgeArtifacts = options.onPurgeArtifacts;
    this.onPurge = options.onPurge;
    mkdirSync(this.trashRoot, { recursive: true });
  }

  getTrashRoot(): string {
    return this.trashRoot;
  }

  getTaskExecutionWorkspacesRoot(): string {
    return this.workspace.getTaskExecutionWorkspacesRoot();
  }

  /**
   * 回收站可见列表（只读，不做任何 move/purge）。
   * 与 AppDatabase.listNonTrashedTasks 互补：回收区任务不出现在任务/归档列表里，
   * 因此必须在这里可见，否则用户既恢复不了也清不掉（"删除黑洞"）。
   */
  async listTrashedTasks(): Promise<TrashedTaskDto[]> {
    const tasks = await this.db.runtimeAuditReader?.listTrashedTasks(this.trashRoot);
    if (tasks) return tasks;
    if (this.db.coreIdentity) throw new TaskLifecycleError("Core 未确认回收站列表读取");
    return this.db.listTrashedTaskRows().map(({ trashPath, ...task }) => ({
      ...task,
      directoryMissing: this.resolveTrashPath(trashPath) === undefined,
    }));
  }

  /**
   * 对齐既有回收条目的保留期（策略从 30 天改为 7 天后，存量不能继续按旧期限拖着）。
   * 只缩短、不延长：purgeAfter 取 min(现值, trashedAt + purgeAfterMs)，因此幂等且不会延长任何条目。
   * 返回被改写的条目数。
   */
  alignTrashRetention(): Promise<number> {
    return this.db.writeTrashRetention(this.purgeAfterMs);
  }

  /* ---------------------------------------------------------------- */
  /* 归档（不移动）                                                      */
  /* ---------------------------------------------------------------- */

  /** 归档：只改 tasks.archived + task_execution_workspace_state，目录不动 */
  archive(taskId: string): TaskExecutionWorkspaceStateRow {
    return this.setArchiveOnHost(taskId, true);
  }

  /** 从归档恢复为 active（目录本就在原位） */
  unarchive(taskId: string): TaskExecutionWorkspaceStateRow {
    return this.setArchiveOnHost(taskId, false);
  }

  async writeArchive(taskId: string, archived: boolean): Promise<void> {
    this.assertTaskId(taskId);
    if (taskId === DOTS_TASK_ID && archived) throw new Error("Dots 对话不能作为普通任务归档");
    const worker = this.db.runtimeAuditReader;
    const rustRequired = this.db.readonly || worker?.supervised === true;
    if (worker) {
      const result = await worker.setSidebarArchive({
        kind: "task", id: taskId, archived, directoryName: getTaskDirectoryName(taskId), at: Date.now(),
      });
      if (result?.status === "saved") return;
      if (result?.status === "trashed") throw archiveTrashError(taskId, archived);
      if (result?.status === "rejected") throw new TaskLifecycleError(result.message);
      if (result?.status !== "needsHost") throw new TaskLifecycleError("未收到归档确认，请刷新后查看状态");
      if (rustRequired) throw new TaskLifecycleError("归档状态写入仅允许通过 Rust 核心完成");
    } else if (rustRequired) {
      throw new TaskLifecycleError("归档状态写入：Rust 核心未就绪");
    }
    this.setArchiveOnHost(taskId, archived);
  }

  private setArchiveOnHost(taskId: string, archived: boolean): TaskExecutionWorkspaceStateRow {
    this.assertTaskId(taskId);
    return this.db.connection.transaction(() => {
      const existing = this.db.getTaskExecutionWorkspaceState(taskId);
      if (existing?.state === "trashed") throw archiveTrashError(taskId, archived);
      const now = Date.now();
      const row: TaskExecutionWorkspaceStateRow = {
        taskId,
        directoryName: getTaskDirectoryName(taskId),
        state: archived ? "archived" : "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: Math.max(existing?.updatedAt ?? now, now),
      };
      this.db.archiveTask(taskId, archived);
      this.db.upsertTaskExecutionWorkspaceState(row);
      return row;
    }).immediate();
  }

  /* ---------------------------------------------------------------- */
  /* 安全删除 → 回收区                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * 安全删除：
   * 1. beforeTrash（停 session）
   * 2. 目录若存在：必须是 task-workspaces 直接子目录 + manifest 匹配
   * 3. 同卷 rename 到 trash
   * 4. DB 标记 trashed + archive 隐藏；保留 task/artifact 行至 purge
   *
   * move 成功但 DB 失败 → 尝试移回；仍失败 → RepairRequiredError
   */
  async trash(taskId: string, options?: { strict?: boolean; assertAllowed?: () => void }): Promise<TrashResult> {
    if (taskId === DOTS_TASK_ID) throw new Error("Dots 对话不能移入任务回收站");
    this.assertTaskId(taskId);
    this.assertNoPendingRestoreOrPurge(taskId);
    await this.assertWorkspaceNotShared(taskId);
    if (this.beforeTrash) {
      const strict = options?.strict || isGatewayConversation(taskId);
      try {
        await this.beforeTrash(taskId, strict ? { ...options, strict: true } : options);
      } catch (err) {
        if (strict) throw err;
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] beforeTrash 失败（继续回收）：taskId=${taskId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Explicit archive purge rechecks authorization after asynchronous session shutdown.
    options?.assertAllowed?.();
    this.assertNoPendingRestoreOrPurge(taskId);
    await this.assertWorkspaceNotShared(taskId);
    options?.assertAllowed?.();
    this.assertNoPendingRestoreOrPurge(taskId);

    const directoryName = getTaskDirectoryName(taskId);
    const workspaceDir = await this.activeWorkspaceDirAsync(taskId);
    const existing = await this.readState(taskId);

    if (existing?.state === "trashed" && this.resolveTrashPath(existing.trashPath) !== undefined) {
      // 幂等：已在回收区（含回收区整体改名后经 resolveTrashPath 定位的旧副本）
      await this.db.archiveTaskAsync(taskId, true);
      return { taskId, state: "trashed", trashPath: this.resolveTrashPath(existing.trashPath), directoryMissing: false };
    }

    let trashPath: string | undefined;
    let directoryMissing = false;

    const gatewayTrash = this.db.coreIdentity && isGatewayConversation(taskId)
      ? join(this.trashRoot, directoryName + "--gateway") : undefined;
    if (gatewayTrash && existsSync(gatewayTrash)) {
      if (existsSync(workspaceDir)) throw new TaskLifecycleConflictError("渠道回收目标已存在，不覆盖任何副本");
      this.checkGatewayRename("trash", directoryName, workspaceDir, gatewayTrash, existing?.updatedAt);
      validatePlainTaskManifest(gatewayTrash);
      this.assertManifestMatches(gatewayTrash, taskId);
      await this.commitTrashedMetadata(taskId, directoryName, gatewayTrash);
      this.clearGatewayRename("trash", directoryName);
      return { taskId, state: "trashed", trashPath: gatewayTrash, directoryMissing: false };
    }
    if (!existsSync(workspaceDir)) {
      directoryMissing = true;
    } else {
      if (isGatewayConversation(taskId)) await validateGatewayTaskCwdAsync(this.db, this.workspace, taskId, workspaceDir);
      else {
        this.assertDirectChildOfWorkspaces(workspaceDir, directoryName);
        this.assertNotSymlinkEscape(workspaceDir);
      }
      this.assertManifestMatches(workspaceDir, taskId);

      mkdirSync(this.trashRoot, { recursive: true });
      trashPath = join(this.trashRoot, `${directoryName}--${Date.now()}`);
      if (existsSync(trashPath)) {
        trashPath = join(this.trashRoot, `${directoryName}--${Date.now()}-${process.pid}`);
      }

      if (gatewayTrash) {
        trashPath = gatewayTrash;
        this.recordGatewayRename(taskId, "trash", directoryName, workspaceDir, trashPath, existing?.updatedAt);
      }
      try {
        renameSync(workspaceDir, trashPath);
      } catch (err) {
        throw new TaskLifecycleError(
          `无法将任务目录移入回收区（是否跨卷？）：${workspaceDir} → ${trashPath}（${err instanceof Error ? err.message : String(err)}）`,
        );
      }

      // move 已成功：DB 必须跟上；失败则尝试移回
      try {
        await this.commitTrashedMetadata(taskId, directoryName, trashPath);
      } catch (dbErr) {
        if (dbErr instanceof TaskLifecycleRepairRequiredError) throw dbErr;
        try {
          if (!existsSync(workspaceDir) && existsSync(trashPath)) {
            renameSync(trashPath, workspaceDir);
          }
          throw new TaskLifecycleError(
            `回收区 move 成功但 DB 写入失败，已尝试移回：${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          );
        } catch (revertErr) {
          if (revertErr instanceof TaskLifecycleError) throw revertErr;
          throw new TaskLifecycleRepairRequiredError(
            `回收区 move 成功且 DB 失败，移回也失败，需人工修复：taskId=${taskId} trashPath=${trashPath} workspaceDir=${workspaceDir} dbErr=${dbErr instanceof Error ? dbErr.message : String(dbErr)} revertErr=${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
          );
        }
      }

      if (gatewayTrash) this.clearGatewayRename("trash", directoryName);
      return { taskId, state: "trashed", trashPath, directoryMissing: false };
    }

    // 无目录：仅 metadata
    await this.commitTrashedMetadata(taskId, directoryName, undefined);
    return { taskId, state: "trashed", trashPath: undefined, directoryMissing };
  }

  /** A host-bound continuation may still use this task's isolated directory.
   * Check again after async shutdown, before moving bytes; never swallow this
   * conflict as a best-effort session-stop error. Dependents must be trashed first. */
  private async readState(taskId: string): Promise<TaskExecutionWorkspaceStateRow | undefined> {
    if (!this.db.coreIdentity) return this.db.getTaskExecutionWorkspaceState(taskId);
    const state = await this.db.runtimeAuditReader?.readWorkspaceState(taskId);
    if (state === undefined) throw new TaskLifecycleError("Core 未确认工作区状态");
    if (!state) return undefined;
    return { ...state, trashedAt: state.trashedAt ?? undefined, trashPath: state.trashPath ?? undefined,
      purgeAfter: state.purgeAfter ?? undefined };
  }

  private async assertWorkspaceNotShared(taskId: string): Promise<void> {
    if (this.db.coreIdentity) {
      const paths = await this.db.runtimeAuditReader?.readActiveBindingPaths(taskId);
      if (!paths) throw new TaskLifecycleError("Core 未确认工作区引用");
      const path = normalizePathForComparison(await this.activeWorkspaceDirAsync(taskId));
      if (paths.some(cwd => normalizePathForComparison(cwd) === path)) {
        throw new TaskLifecycleConflictError("原执行目录仍被其他补跑任务使用，请先回收引用此目录的任务");
      }
      return;
    }
    if (!this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='durable_bot_bindings'").get()) return;
    const path = normalizePathForComparison(this.activeWorkspaceDir(taskId));
    const bindings = this.db.connection.prepare("SELECT task_id,cwd FROM durable_bot_bindings WHERE task_id!=?").all(taskId) as Array<{ task_id: string; cwd: string }>;
    if (bindings.some(binding => normalizePathForComparison(binding.cwd) === path && this.db.getTask(binding.task_id)
      && this.db.getTaskExecutionWorkspaceState(binding.task_id)?.state !== "trashed")) {
      throw new TaskLifecycleConflictError("原执行目录仍被其他补跑任务使用，请先回收引用此目录的任务");
    }
  }

  /**
   * 兼容旧数据：任务在旧版回收目录（~/.mybuddy/projects-trash）被回收后，回收区整体改名迁移，
   * DB 中的 trash_path 仍指向旧绝对路径。此处先按原路径判断，失效则按 basename 在当前回收区定位；
   * 两者都不存在视为无副本（沿用旧行为）。仅用于 restore/purge/幂等判断，不写回 DB。
   */
  private resolveTrashPath(storedTrashPath?: string): string | undefined {
    if (!storedTrashPath) return undefined;
    if (existsSync(storedTrashPath)) return storedTrashPath;
    const name = basename(storedTrashPath);
    const candidate = join(this.trashRoot, name);
    return existsSync(candidate) ? candidate : undefined;
  }
  private async commitTrashedMetadata(taskId: string, directoryName: string, trashPath?: string): Promise<void> {
    const now = Date.now();
    const existing = await this.readState(taskId);
    if (this.db.readonly || this.db.runtimeAuditReader?.supervised) {
      const reader = this.db.runtimeAuditReader;
      if (!reader) throw new TaskLifecycleError("回收区元数据写入：Rust 核心未就绪");
      const res = await reader.batch2Write<{ ok: boolean }>({
        kind: "commitTaskWorkspaceTrashed",
        taskId,
        directoryName,
        createdAt: existing?.createdAt ?? null,
        trashedAt: now,
        purgeAfter: now + this.purgeAfterMs,
        trashPath: trashPath ?? null,
      }).catch(error => {
        if (error?.code !== "RUNTIME_OPERATION_UNKNOWN") throw error;
        return undefined;
      });
      if (!res?.ok) {
        const current = await this.readState(taskId).catch(error => {
          throw new TaskLifecycleRepairRequiredError("回收区元数据写入及回读未获确认，目录已保留", { cause: error });
        });
        if (current?.state !== "trashed" || current.trashPath !== trashPath || current.trashedAt !== now) {
          throw new TaskLifecycleRepairRequiredError("回收区元数据写入未获确认，目录已保留；请刷新后核对");
        }
      }
      return;
    }
    this.db.transaction(() => {
      // 保留 task 行与 Artifact；侧栏用 archived 隐藏。cwd 保留作审计，下次 restore/ensure 会重绑。
      this.db.archiveTask(taskId, true);
      this.db.upsertTaskExecutionWorkspaceState({
        taskId,
        directoryName,
        state: "trashed",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        trashedAt: now,
        purgeAfter: now + this.purgeAfterMs,
        trashPath,
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 从回收区恢复                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 恢复：trash → task-workspaces canonical。
   * 若目标已存在且 manifest 为其他 taskId → 停止，不覆盖。
   */
  restore(taskId: string): RestoreResult {
    this.assertNoPendingRestoreOrPurge(taskId);
    const state = this.restoreState(taskId);
    if (isGatewayConversation(taskId)) return this.restoreGatewayWorkspace(taskId, state);
    const files = this.prepareLocalRestore(state);
    this.commitRestoreOnHost(state, files, Date.now());
    return this.finishLocalRestore(taskId, files);
  }

  /** The settings action uses the resident worker for ordinary task metadata. */
  async restoreFromTrash(taskId: string): Promise<RestoreResult> {
    const worker = this.db.runtimeAuditReader;
    const rustRequired = Boolean(this.db.readonly || worker?.supervised);
    if (isGatewayConversation(taskId)) {
      if (rustRequired) {
        return this.withPendingRestoreOrPurge(taskId, async () =>
          this.restoreGatewayWorkspaceAsync(taskId, this.requireRestoreState(taskId, await this.readState(taskId))));
      }
      return this.restore(taskId);
    }
    if (!worker || this.db.inTransaction) {
      if (rustRequired) throw new TaskLifecycleError("任务恢复写入：Rust 核心未就绪");
      return this.restore(taskId);
    }

    return this.withPendingRestoreOrPurge(taskId, async () => {
      const state = this.requireRestoreState(taskId, await this.readState(taskId));
      const files = this.prepareLocalRestore(state);
      const at = Date.now();
      const reply = await worker.restoreTrashedTask({
        taskId,
        directoryName: files.directoryName,
        expectedUpdatedAt: state.updatedAt,
        expectedTrashedAt: state.trashedAt,
        expectedTrashPath: state.trashPath,
        cwd: files.cwd,
        at,
      });
      if (reply?.status === "needsHost") {
        if (rustRequired) this.rollbackLocalRestore(state, files, new TaskLifecycleError("任务恢复写入仅允许通过 Rust 核心完成"), await this.readState(taskId));
        this.commitRestoreOnHost(state, files, at);
      } else if (reply?.status === "rejected") this.rollbackLocalRestore(state, files, new TaskLifecycleError(reply.message), await this.readState(taskId));
      else if (!reply) {
        // A lost reply may follow a successful commit. Keep the files recoverable in either case.
        const current = await this.readState(taskId);
        if (current?.state !== "active" || current.updatedAt !== at || current.directoryName !== files.directoryName) {
          throw new TaskLifecycleRepairRequiredError("恢复写入未获确认，目录已保留；请刷新回收站后重试");
        }
      }
      return this.finishLocalRestore(taskId, files);
    });
  }

  private restoreState(taskId: string): TaskExecutionWorkspaceStateRow {
    return this.requireRestoreState(taskId, this.db.getTaskExecutionWorkspaceState(taskId));
  }

  private requireRestoreState(taskId: string, state?: TaskExecutionWorkspaceStateRow): TaskExecutionWorkspaceStateRow {
    this.assertTaskId(taskId);
    if (taskId === DOTS_TASK_ID) throw new TaskLifecycleError("Dots 对话不能作为普通任务恢复");
    if (!state || state.state !== "trashed") {
      throw new TaskLifecycleError(`任务不在回收区，无法 restore：${taskId} state=${state?.state ?? "none"}`);
    }
    return state;
  }

  private prepareLocalRestore({ taskId, trashPath: storedTrashPath }: TaskExecutionWorkspaceStateRow): LocalRestoreFiles {
    const directoryName = getTaskDirectoryName(taskId);
    const workspaceDir = this.workspace.resolveTaskExecutionWorkspaceDir(taskId);
    this.assertDirectChildOfWorkspaces(workspaceDir, directoryName);
    const destinationExists = isPlainDirectory(workspaceDir);
    const destination = tryReadManifest(join(workspaceDir, MANIFEST_FILENAME));
    if (destination.ok && destination.manifest.taskId !== taskId) {
      throw new TaskLifecycleConflictError(
        `恢复冲突：目标目录已被其他任务占用 manifest=${destination.manifest.taskId}，期望=${taskId}，path=${workspaceDir}`,
      );
    }

    const trashPath = this.resolveTrashPath(storedTrashPath);
    const files = { directoryName, workspaceDir };
    if (!trashPath) return { ...files, cwd: destinationExists ? workspaceDir : undefined };
    this.assertTrashPathSafe(trashPath);
    if (!isPlainDirectory(trashPath)) throw new TaskLifecycleError(`回收区目录已变化：${trashPath}`);
    this.assertManifestMatches(trashPath, taskId);
    if (destination.ok) return { ...files, cwd: workspaceDir, redundantCopy: trashPath };
    if (destinationExists) {
      if (readdirSync(workspaceDir).length > 0) {
        throw new TaskLifecycleConflictError(`恢复冲突：目标目录已存在且无合法本任务 manifest：${workspaceDir}`);
      }
      rmdirSync(workspaceDir); // Preserve files that arrive after the emptiness check.
    } else {
      mkdirSync(dirname(workspaceDir), { recursive: true });
    }
    try {
      renameSync(trashPath, workspaceDir);
    } catch (error) {
      throw new TaskLifecycleError(`无法从回收区移回：${trashPath} → ${workspaceDir}`, { cause: error });
    }
    return { ...files, cwd: workspaceDir, movedFrom: trashPath };
  }

  private commitRestoreOnHost(state: TaskExecutionWorkspaceStateRow, files: LocalRestoreFiles, at: number): void {
    const { taskId } = state;
    try {
      this.db.connection.transaction(() => {
        if (!this.isSameTrashEntry(state)) {
          throw new TaskLifecycleError(`恢复中止：回收站条目已变化：${taskId}`);
        }
        this.db.archiveTask(taskId, false);
        if (files.cwd) this.db.bindTaskExecutionWorkspaceCwd(taskId, files.cwd);
        this.db.upsertTaskExecutionWorkspaceState({
          taskId, directoryName: files.directoryName, state: "active", createdAt: state.createdAt, updatedAt: at,
        });
      }).immediate();
    } catch (error) {
      this.rollbackLocalRestore(state, files, error);
    }
  }

  private isSameTrashEntry({ taskId, updatedAt, trashedAt, trashPath }: TaskExecutionWorkspaceStateRow): boolean {
    const current = this.db.getTaskExecutionWorkspaceState(taskId);
    return current?.state === "trashed" && current.updatedAt === updatedAt &&
      current.trashedAt === trashedAt && current.trashPath === trashPath;
  }

  private rollbackLocalRestore(state: TaskExecutionWorkspaceStateRow, files: LocalRestoreFiles, error: unknown, current?: TaskExecutionWorkspaceStateRow): never {
    if (files.movedFrom) {
      try {
        const same = this.db.coreIdentity ? current?.state === "trashed" && current.updatedAt === state.updatedAt &&
          current.trashedAt === state.trashedAt && current.trashPath === state.trashPath : this.isSameTrashEntry(state);
        if (!same) throw new TaskLifecycleConflictError("任务回收站状态已变化");
        this.assertTrashPathSafe(files.movedFrom);
        if (isPlainDirectory(files.movedFrom) || !isPlainDirectory(files.workspaceDir)) {
          throw new TaskLifecycleConflictError("回收恢复路径已变化");
        }
        this.assertManifestMatches(files.workspaceDir, state.taskId);
        renameSync(files.workspaceDir, files.movedFrom);
      } catch (rollback) {
        throw new TaskLifecycleRepairRequiredError("任务恢复失败且无法原路移回；未删除仍存的目录", { cause: rollback });
      }
    }
    throw error;
  }

  private finishLocalRestore(taskId: string, files: LocalRestoreFiles): RestoreResult {
    if (files.redundantCopy) {
      try {
        this.assertTrashPathSafe(files.redundantCopy);
        if (isPlainDirectory(files.redundantCopy)) {
          this.assertManifestMatches(files.redundantCopy, taskId);
          rmSync(files.redundantCopy, { recursive: true, force: true });
        }
      } catch {
        // A redundant copy remains recoverable if post-commit cleanup cannot validate it.
      }
    }
    return { taskId, state: "active", workspaceDir: files.workspaceDir };
  }

  private async activeWorkspaceDirAsync(taskId: string): Promise<string> {
    if (this.db.coreIdentity && isGatewayConversation(taskId)) {
      return (await coreGatewayLifecyclePaths(this.db, this.workspace, taskId)).legacy;
    }
    return this.activeWorkspaceDir(taskId);
  }

  private activeWorkspaceDir(taskId: string): string {
    return currentTaskWorkspace(this.db, this.workspace, taskId).resolveTaskExecutionWorkspaceDir(taskId);
  }

  /** Local restore and authenticated inbound restore use the same transaction. Preserve every byte on collision. */
  private restoreGatewayWorkspace(taskId: string, state: TaskExecutionWorkspaceStateRow): RestoreResult {
    const prepare = this.prepareGatewayWorkspaceRestore;
    if (!prepare) throw new TaskLifecycleError("渠道安全恢复服务尚未就绪");
    const directoryName = getTaskDirectoryName(taskId);
    const legacy = this.activeWorkspaceDir(taskId);
    const destination = gatewayTaskWorkspace(this.db, taskId).resolveTaskExecutionWorkspaceDir(taskId);
    const source = this.resolveTrashPath(state.trashPath);
    if (!source) throw new TaskLifecycleError("渠道任务的原回收目录不存在，不创建空目录");
    this.assertTrashPathSafe(source);
    if (!isPlainDirectory(this.trashRoot) || !isPlainDirectory(source)
      || state.directoryName !== directoryName || !basename(source).startsWith(directoryName + "--")) {
      throw new TaskPathBoundaryError("渠道原回收目录不是可信的任务目录");
    }
    validatePlainTaskManifest(source);
    this.assertManifestMatches(source, taskId);
    if (isPlainDirectory(legacy) || isPlainDirectory(destination)) {
      throw new TaskLifecycleConflictError("渠道原位或目标已存在，不覆盖任何副本");
    }

    let renamed = false;
    try {
      this.db.transaction(() => {
        prepare(taskId, legacy, destination); // Durable intent or first binding; rolls back with lifecycle metadata.
        renameSync(source, destination);
        renamed = true;
        this.db.archiveTask(taskId, false);
        this.db.upsertTaskExecutionWorkspaceState({
          taskId, directoryName, state: "active", createdAt: state.createdAt, updatedAt: Date.now(),
        });
      });
    } catch (error) {
      if (renamed) {
        try {
          if (isPlainDirectory(source) || !isPlainDirectory(destination)) throw new Error("渠道恢复路径发生变化");
          renameSync(destination, source);
        } catch (rollback) {
          throw new TaskLifecycleRepairRequiredError("渠道恢复失败且无法原路移回；未删除仍存的目录", { cause: rollback });
        }
      }
      throw error;
    }
    return { taskId, state: "active", workspaceDir: destination };
  }

  async recoverGatewayRenames(): Promise<void> {
    if (!this.db.coreIdentity || !isPlainDirectory(this.trashRoot)) return;
    for (const file of readdirSync(this.trashRoot, {withFileTypes:true})) {
      const match = /^\.(.+)\.(trash|restore)\.json$/.exec(file.name);
      if (!file.isFile() || !match) continue;
      try {
        const entry = JSON.parse(readFileSync(join(this.trashRoot, file.name), "utf8"));
        const id = entry.taskId;
        if (typeof id !== "string" || !isGatewayConversation(id) || match[1] !== getTaskDirectoryName(id)) continue;
        const state = await this.readState(id);
        const op = match[2] === "trash" ? "trash" : "restore";
        if (op === "trash" ? state?.state === "trashed" : state?.state !== "trashed") {
          this.clearGatewayRename(op, match[1]);
          continue;
        }
        const gateway = await coreGatewayLifecyclePaths(this.db, this.workspace, id);
        const source = op === "trash" ? gateway.legacy : state?.trashPath;
        const dest = op === "trash" ? join(this.trashRoot, match[1] + "--gateway") : gateway.destination;
        if (!source || existsSync(source)) continue;
        this.checkGatewayRename(op, match[1], source, dest, state?.updatedAt);
        if (op === "trash") await this.trash(id);
        else await this.restoreFromTrash(id);
      } catch (error) {
        console.warn("[Gateway] 保留无法确认的目录改名回执", file.name, error);
      }
    }
  }

  private gatewayJournal(operation: "trash" | "restore", name: string): string {
    return join(this.trashRoot, "." + name + "." + operation + ".json");
  }

  private recordGatewayRename(taskId: string, operation: "trash" | "restore", name: string, source: string, destination: string, version?: number): void {
    if (!isPlainDirectory(this.trashRoot)) throw new TaskPathBoundaryError("渠道回收根目录不是可信目录");
    const dir = lstatSync(source, { bigint: true });
    const path = this.gatewayJournal(operation, name);
    const pending = path + "." + randomUUID();
    try {
      writeFileSync(pending, JSON.stringify({taskId, source, destination, version, dev:String(dir.dev), ino:String(dir.ino)}), {flag:"wx",mode:0o600});
      renameSync(pending, path);
    } finally { rmSync(pending, {force:true}); }
  }

  private checkGatewayRename(operation: "trash" | "restore", name: string, source: string, destination: string, version?: number): void {
    const journal = this.gatewayJournal(operation, name);
    if (isPlainDirectory(this.trashRoot) && isPlainDirectory(destination) && existsSync(journal) && lstatSync(journal).isFile()) {
      const entry = JSON.parse(readFileSync(journal,"utf8"));
      const current = lstatSync(destination,{bigint:true});
      if (current.ino !== 0n && entry.source === source && entry.destination === destination && entry.version === version
        && entry.dev === String(current.dev) && entry.ino === String(current.ino)) return;
    }
    throw new TaskLifecycleRepairRequiredError("渠道目录改名缺少对应回执，保留原有副本");
  }

  private clearGatewayRename(operation: "trash" | "restore", name: string): void {
    rmSync(this.gatewayJournal(operation, name), {force:true});
  }

  private async restoreGatewayWorkspaceAsync(taskId: string, state: TaskExecutionWorkspaceStateRow): Promise<RestoreResult> {
    const prepare = this.prepareGatewayWorkspaceRestore;
    const reader = this.db.runtimeAuditReader;
    if (!prepare) throw new TaskLifecycleError("渠道安全恢复服务尚未就绪");
    if (!reader) throw new TaskLifecycleError("渠道恢复写入：Rust 核心未就绪");
    const directoryName = getTaskDirectoryName(taskId);
    const gateway = await coreGatewayLifecyclePaths(this.db, this.workspace, taskId);
    const { legacy, destination } = gateway;
    const stored = state.trashPath;
    if (!stored) throw new TaskLifecycleError("渠道任务的原回收目录不存在，不创建空目录");
    const source = this.resolveTrashPath(stored) ?? join(this.trashRoot, basename(stored));
    this.assertTrashPathSafe(source);
    if (!isPlainDirectory(this.trashRoot) || state.directoryName !== directoryName || !basename(source).startsWith(directoryName + "--")) {
      throw new TaskPathBoundaryError("渠道原回收目录不是可信的任务目录");
    }
    const moved = !existsSync(source);
    if (moved) this.checkGatewayRename("restore", directoryName, source, destination, state.updatedAt);
    const actual = moved ? destination : source;
    if (!isPlainDirectory(actual)) throw new TaskPathBoundaryError("渠道目录无法核验");
    validatePlainTaskManifest(actual);
    this.assertManifestMatches(actual, taskId);
    if ((!sameWorkspacePath(legacy, destination) && existsSync(legacy)) || (!moved && existsSync(destination))) {
      throw new TaskLifecycleConflictError("渠道原位或目标已存在，不覆盖任何副本");
    }
    prepare(taskId, legacy, destination);
    if (!moved) {
      this.recordGatewayRename(taskId, "restore", directoryName, source, destination, state.updatedAt);
      renameSync(source, destination);
    }
    const at = Date.now();
    const reply = await reader.restoreTrashedTask({ taskId, directoryName, gateway, at,
      expectedUpdatedAt: state.updatedAt, expectedTrashPath: state.trashPath, expectedTrashedAt: state.trashedAt });
    if (!reply) {
      const current = await this.readState(taskId);
      if (current?.state !== "active" || current.updatedAt !== at) {
        throw new TaskLifecycleRepairRequiredError("渠道恢复未获确认，目录已保留");
      }
    } else if (reply.status !== "saved") {
      if (isPlainDirectory(source) || !isPlainDirectory(destination)) throw new TaskLifecycleRepairRequiredError("渠道恢复路径发生变化");
      try { renameSync(destination, source); }
      catch (cause) { throw new TaskLifecycleRepairRequiredError("渠道恢复未提交，无法移回原目录", { cause }); }
      throw new TaskLifecycleError(reply.status === "rejected" ? reply.message : "渠道恢复需要 Rust 核心");
    }
    this.clearGatewayRename("restore", directoryName);
    return { taskId, state: "active", workspaceDir: destination };
  }

  /* ---------------------------------------------------------------- */
  /* 永久清理                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * 永久清理回收区任务。默认仅当 purge_after 已过或 force=true。
   * 顺序：校验 trash 路径安全 → 删 trash 目录 → onPurgeArtifacts → 删 task 行 + state。
   */
  purge(taskId: string, options?: TaskPurgeOptions): Promise<PurgeResult> {
    return this.withPendingRestoreOrPurge(taskId, () => this.purgeFully(taskId, options));
  }

  private async purgeFully(taskId: string, options?: TaskPurgeOptions): Promise<PurgeResult> {
    this.assertTaskId(taskId);
    if (taskId === DOTS_TASK_ID) throw new TaskLifecycleError("Dots 对话不能作为普通任务删除");
    options?.assertAllowed?.();
    const state = this.db.getTaskExecutionWorkspaceState(taskId);
    if (!state || state.state !== "trashed") {
      throw new TaskLifecycleError(`仅可 purge 回收区任务：${taskId} state=${state?.state ?? "none"}`);
    }
    const now = Date.now();
    if (!options?.force && state.purgeAfter != null && state.purgeAfter > now) {
      throw new TaskLifecycleError(
        `未到 purge 期限（purge_after=${state.purgeAfter}，now=${now}）；传入 force=true 可强制`,
      );
    }

    // A torn 渠道restore may have moved bytes already. Never delete the task row over that copy.
    if (isGatewayConversation(taskId) && (isPlainDirectory(this.activeWorkspaceDir(taskId)) ||
      isPlainDirectory(gatewayTaskWorkspace(this.db, taskId).resolveTaskExecutionWorkspaceDir(taskId)))) {
      throw new TaskLifecycleConflictError("渠道任务仍有原位数据，拒绝永久清理");
    }
    let removedTrashDir = false;
    // 回收区整体改名迁移后，DB 中旧 trash_path 绝对路径可能失效：按 basename 在当前回收区定位
    const trashPath = this.resolveTrashPath(state.trashPath);
    if (trashPath) {
      this.assertTrashPathSafe(trashPath);
      if (isGatewayConversation(taskId)) {
        if (!isPlainDirectory(this.trashRoot) || !isPlainDirectory(trashPath))
          throw new TaskPathBoundaryError("渠道回收目录不是可信目录");
        validatePlainTaskManifest(trashPath);
        this.assertManifestMatches(trashPath, taskId);
      }
      if (existsSync(trashPath)) {
        // 校验 manifest 仍属本 task（防路径被替换）
        const man = tryReadManifest(join(trashPath, MANIFEST_FILENAME));
        if (man.ok && man.manifest.taskId !== taskId) {
          throw new TaskLifecycleConflictError(
            `purge 中止：trash 目录 manifest 不匹配 ${man.manifest.taskId} ≠ ${taskId}`,
          );
        }
        rmSync(trashPath, { recursive: true, force: true });
        removedTrashDir = true;
      }
    }

    // 确保 task-workspaces 下无残留（若仍在 active 位置且 state 是 trashed，异常态：不自动 rm 用户内容）
    // 仅当工作区目录 manifest 匹配且 state=trashed 才视为应已搬走；残留不自动删。

    if (this.onPurgeArtifacts) {
      try {
        await this.onPurgeArtifacts(taskId);
      } catch (err) {
        if (options?.strict) throw err;
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] onPurgeArtifacts 失败：taskId=${taskId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Recheck the same trash entry at commit, since artifact cleanup awaits I/O.
    await this.db.purgeTrashedTask(state, options);

    // 永久删除后清理任务级外部配置（settings.json taskConnectorIds 等；失败只告警，不阻断）
    if (this.onPurge) {
      try {
        await this.onPurge(taskId);
      } catch (err) {
        if (options?.strict) throw err;
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] onPurge 失败：taskId=${taskId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { taskId, removedTrashDir, removedTaskRow: true };
  }

  /** 清理所有已过 purge_after 的回收任务 */
  async purgeExpired(): Promise<Array<PurgeResult & { projectId: string | null }>> {
    const due = await this.db.readDueTrashedTasks(Date.now());
    const results: Array<PurgeResult & { projectId: string | null }> = [];
    for (const { taskId, projectId } of due) {
      try {
        results.push({ ...await this.purge(taskId), projectId });
      } catch (err) {
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] purgeExpired 跳过 ${taskId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return results;
  }

  /* ---------------------------------------------------------------- */
  /* 孤儿目录扫描（只报告）                                               */
  /* ---------------------------------------------------------------- */

  /**
   * 扫描 task-workspaces root 下无对应合法 task 的目录。
   * 不自动删除；可 adopt（绑定 task）或 moveOrphanToTrash。
   */
  scanOrphans(): OrphanDirectoryReport[] {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    if (!existsSync(workspacesRoot)) return [];

    const reports: OrphanDirectoryReport[] = [];
    const entries = readdirSync(workspacesRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const directoryName = ent.name;
      if (directoryName.toLowerCase() === GATEWAY_TASK_FOLDER) continue;
      const path = join(workspacesRoot, directoryName);
      const man = tryReadManifest(join(path, MANIFEST_FILENAME));

      if (!man.ok) {
        if (man.error === "missing") {
          reports.push({
            directoryName,
            path,
            reason: "manifest_missing",
            details: `缺少 ${MANIFEST_FILENAME}`,
          });
        } else {
          reports.push({
            directoryName,
            path,
            reason: "unreadable",
            details: man.error,
          });
        }
        continue;
      }

      const taskId = man.manifest.taskId;
      const expectedName = getTaskDirectoryName(taskId);
      if (expectedName !== directoryName) {
        reports.push({
          directoryName,
          path,
          manifestTaskId: taskId,
          reason: "manifest_mismatch",
          details: `目录名 ${directoryName} 与 taskId 映射 ${expectedName} 不一致`,
        });
        continue;
      }

      const task = this.db.getTask(taskId);
      if (!task) {
        reports.push({
          directoryName,
          path,
          manifestTaskId: taskId,
          reason: "no_task_row",
          details: `manifest taskId=${taskId} 在 tasks 表无对应行`,
        });
        continue;
      }

      // 有 task 且目录名匹配 → 非孤儿（即使 cwd 未绑定）
    }
    return reports;
  }

  /**
   * 将孤儿目录移入回收区（不自动 purge）。
   * 要求：仍是 task-workspaces 直接子目录；若有 manifest 则记录 taskId。
   */
  moveOrphanToTrash(directoryName: string): { trashPath: string; manifestTaskId?: string } {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    const path = join(workspacesRoot, directoryName);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new TaskLifecycleError(`孤儿目录不存在：${path}`);
    }
    this.assertDirectChildOfWorkspaces(path, directoryName);

    const man = tryReadManifest(join(path, MANIFEST_FILENAME));
    const manifestTaskId = man.ok ? man.manifest.taskId : undefined;

    mkdirSync(this.trashRoot, { recursive: true });
    const trashPath = join(this.trashRoot, `${directoryName}--orphan--${Date.now()}`);
    renameSync(path, trashPath);

    // 若能关联 taskId 且无 state，可记 orphaned/trashed
    if (manifestTaskId && this.db.getTask(manifestTaskId)) {
      const now = Date.now();
      const existing = this.db.getTaskExecutionWorkspaceState(manifestTaskId);
      this.db.upsertTaskExecutionWorkspaceState({
        taskId: manifestTaskId,
        directoryName: getTaskDirectoryName(manifestTaskId),
        state: "trashed",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        trashedAt: now,
        purgeAfter: now + this.purgeAfterMs,
        trashPath,
      });
      this.db.archiveTask(manifestTaskId, true);
    }

    return { trashPath, manifestTaskId };
  }

  /**
   * 认领孤儿：manifest taskId 存在或调用方指定 taskId，ensure 目录在正确位置。
   * 若目录名已是 canonical 且 manifest 匹配，仅 bind cwd + state=active。
   */
  async adoptOrphan(directoryName: string, taskId?: string): Promise<{ taskId: string; workspaceDir: string }> {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    const path = join(workspacesRoot, directoryName);
    if (!existsSync(path)) throw new TaskLifecycleError(`目录不存在：${path}`);
    this.assertDirectChildOfWorkspaces(path, directoryName);

    const man = tryReadManifest(join(path, MANIFEST_FILENAME));
    const resolvedTaskId = taskId ?? (man.ok ? man.manifest.taskId : undefined);
    if (!resolvedTaskId) {
      throw new TaskLifecycleError(`无法认领：无 manifest taskId 且未指定 taskId`);
    }
    if (man.ok && man.manifest.taskId !== resolvedTaskId) {
      throw new TaskLifecycleConflictError(
        `认领冲突：manifest=${man.manifest.taskId} ≠ 请求 taskId=${resolvedTaskId}`,
      );
    }

    if (isGatewayConversation(resolvedTaskId)) {
      throw new TaskLifecycleConflictError("渠道托管任务不能通过普通孤儿目录认领");
    }
    const expected = getTaskDirectoryName(resolvedTaskId);
    if (directoryName !== expected) {
      throw new TaskLifecycleConflictError(
        `认领冲突：目录名 ${directoryName} 不是 taskId 的 canonical 名 ${expected}（请先手动对齐，避免静默改名）`,
      );
    }

    // 补 manifest（若缺）
    if (!man.ok) {
      this.workspace.ensureTaskExecutionWorkspace(resolvedTaskId);
    }

    const workspaceDir = this.workspace.resolveTaskExecutionWorkspaceDir(resolvedTaskId);
    const now = Date.now();
    if (this.db.readonly || this.db.runtimeAuditReader?.supervised) {
      const reader = this.db.runtimeAuditReader;
      if (!reader) throw new TaskLifecycleError("认领孤儿工作区：Rust 核心未就绪");
      const result = await reader.batch2Write<{ ok: boolean }>({
        kind: "commitTaskWorkspaceAdopt",
        taskId: resolvedTaskId,
        workspaceDir,
        directoryName: expected,
        now,
      });
      if (!result?.ok) throw new TaskLifecycleError("Core 未确认孤儿目录认领");
      return { taskId: resolvedTaskId, workspaceDir };
    }
    this.db.transaction(() => {
      if (!this.db.getTask(resolvedTaskId)) {
        this.db.bindTaskExecutionWorkspaceCwd(resolvedTaskId, workspaceDir);
      } else {
        this.db.bindTaskExecutionWorkspaceCwd(resolvedTaskId, workspaceDir);
        this.db.archiveTask(resolvedTaskId, false);
      }
      this.db.upsertTaskExecutionWorkspaceState({
        taskId: resolvedTaskId,
        directoryName: expected,
        state: "active",
        createdAt: now,
        updatedAt: now,
      });
    });

    return { taskId: resolvedTaskId, workspaceDir };
  }

  getState(taskId: string): TaskExecutionWorkspaceStateRow | undefined {
    return this.db.getTaskExecutionWorkspaceState(taskId);
  }

  /* ---------------------------------------------------------------- */
  /* 内部校验                                                            */
  /* ---------------------------------------------------------------- */

  private assertTaskId(taskId: string): void {
    if (!taskId?.trim()) throw new TaskLifecycleError("taskId 不能为空");
  }

  private assertNoPendingRestoreOrPurge(taskId: string): void {
    if (this.pendingRestoreOrPurge.has(taskId)) {
      throw new TaskLifecycleConflictError("任务回收站操作尚未结束，请稍后重试");
    }
  }

  private async withPendingRestoreOrPurge<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    this.assertNoPendingRestoreOrPurge(taskId);
    this.pendingRestoreOrPurge.add(taskId);
    try {
      return await run();
    } finally {
      this.pendingRestoreOrPurge.delete(taskId);
    }
  }

  /** 必须是 task-workspaces root 的直接子目录，且目录名等于期望名 */
  private assertDirectChildOfWorkspaces(dir: string, expectedName: string): void {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    const resolved = resolve(dir);
    if (sameWorkspacePath(resolved, join(workspacesRoot, GATEWAY_TASK_FOLDER)))
      throw new TaskPathBoundaryError("网关目录是托管容器，不能按普通任务目录移动或认领");
    const parent = dirname(resolved);
    if (normalizePathForComparison(parent) !== normalizePathForComparison(workspacesRoot)) {
      throw new TaskPathBoundaryError(
        `任务目录不是 task-workspaces 的直接子目录：${resolved}（parent=${parent}, workspaces=${workspacesRoot}）`,
      );
    }
    if (basename(resolved) !== expectedName) {
      throw new TaskPathBoundaryError(
        `任务目录名与期望不一致：${basename(resolved)} ≠ ${expectedName}`,
      );
    }
    if (!isPathInsideOrEqual(workspacesRoot, resolved)) {
      throw new TaskPathBoundaryError(`任务目录越出 task-workspaces root：${resolved}`);
    }
  }

  private assertManifestMatches(dir: string, taskId: string): void {
    const manifestPath = join(dir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      throw new TaskManifestError(`缺少清单，拒绝操作：${manifestPath}`);
    }
    const man = tryReadManifest(manifestPath);
    if (!man.ok) {
      throw new TaskManifestError(`清单不可读：${manifestPath}（${man.error}）`);
    }
    if (man.manifest.taskId !== taskId) {
      throw new TaskManifestMismatchError(
        `清单 taskId 不匹配：manifest=${man.manifest.taskId}，期望=${taskId}`,
      );
    }
  }

  private assertNotSymlinkEscape(dir: string): void {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    try {
      const rootReal = realpathSync.native(workspacesRoot);
      const dirReal = realpathSync.native(dir);
      if (!isPathInsideOrEqual(rootReal, dirReal)) {
        throw new TaskPathBoundaryError(`任务目录 realpath 逃逸：${dir} → ${dirReal}`);
      }
    } catch (err) {
      if (err instanceof TaskPathBoundaryError) throw err;
      // realpath 失败时不阻断
    }
  }

  /** trash 路径必须在 trashRoot 内且为直接子目录 */
  private assertTrashPathSafe(trashPath: string): void {
    const resolved = resolve(trashPath);
    const parent = dirname(resolved);
    if (normalizePathForComparison(parent) !== normalizePathForComparison(this.trashRoot)) {
      throw new TaskPathBoundaryError(
        `trash_path 不是回收区直接子目录：${resolved}（trashRoot=${this.trashRoot}）`,
      );
    }
    if (!isPathInsideOrEqual(this.trashRoot, resolved)) {
      throw new TaskPathBoundaryError(`trash_path 越出回收区：${resolved}`);
    }
  }
}

function tryReadManifest(
  manifestPath: string,
): { ok: true; manifest: TaskExecutionWorkspaceManifest } | { ok: false; error: string } {
  if (!existsSync(manifestPath)) return { ok: false, error: "missing" };
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TaskExecutionWorkspaceManifest>;
    if (parsed?.version !== 1 || typeof parsed.taskId !== "string" || typeof parsed.createdAt !== "number") {
      return { ok: false, error: `unsupported format version=${String(parsed?.version)}` };
    }
    return { ok: true, manifest: { version: 1, taskId: parsed.taskId, createdAt: parsed.createdAt } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
