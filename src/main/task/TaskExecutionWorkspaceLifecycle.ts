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
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TRASH_RETENTION_MS, type TrashedTaskDto } from "../../shared/archive-deletion";
import type { AppDatabase, TaskExecutionWorkspaceStateRow } from "../db/AppDatabase";
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

export interface PurgeResult {
  taskId: string;
  removedTrashDir: boolean;
  removedTaskRow: boolean;
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
  private readonly db: AppDatabase;
  private readonly workspace: TaskExecutionWorkspace;
  private readonly trashRoot: string;
  private readonly purgeAfterMs: number;
  private readonly beforeTrash?: TaskExecutionWorkspaceLifecycleOptions["beforeTrash"];
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
  listTrashedTasks(): TrashedTaskDto[] {
    return this.db
      .listTaskExecutionWorkspaceStates({ state: "trashed" })
      .flatMap((state): TrashedTaskDto[] => {
        const task = this.db.getTask(state.taskId);
        if (!task) return [];
        return [{
          id: task.id,
          title: task.title,
          spaceId: task.spaceId ?? undefined,
          projectId: task.projectId ?? undefined,
          trashedAt: state.trashedAt,
          purgeAfter: state.purgeAfter,
          directoryMissing: this.resolveTrashPath(state.trashPath) === undefined,
        }];
      })
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  }

  /**
   * 对齐既有回收条目的保留期（策略从 30 天改为 7 天后，存量不能继续按旧期限拖着）。
   * 只缩短、不延长：purgeAfter 取 min(现值, trashedAt + purgeAfterMs)，因此幂等且不会延长任何条目。
   * 返回被改写的条目数。
   */
  alignTrashRetention(): number {
    let changed = 0;
    for (const state of this.db.listTaskExecutionWorkspaceStates({ state: "trashed" })) {
      const trashedAt = state.trashedAt ?? state.updatedAt;
      if (!Number.isFinite(trashedAt)) continue;
      const deadline = (trashedAt as number) + this.purgeAfterMs;
      if (state.purgeAfter === undefined || state.purgeAfter > deadline) {
        this.db.upsertTaskExecutionWorkspaceState({ ...state, purgeAfter: deadline });
        changed += 1;
      }
    }
    return changed;
  }

  /* ---------------------------------------------------------------- */
  /* 归档（不移动）                                                      */
  /* ---------------------------------------------------------------- */

  /** 归档：只改 tasks.archived + task_execution_workspace_state，目录不动 */
  archive(taskId: string): TaskExecutionWorkspaceStateRow {
    this.assertTaskId(taskId);
    const now = Date.now();
    const directoryName = getTaskDirectoryName(taskId);
    const existing = this.db.getTaskExecutionWorkspaceState(taskId);
    if (existing?.state === "trashed") {
      throw new TaskLifecycleError(`任务已在回收区，请先恢复再归档：${taskId}`);
    }
    this.db.archiveTask(taskId, true);
    const row: TaskExecutionWorkspaceStateRow = {
      taskId,
      directoryName,
      state: "archived",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      trashedAt: undefined,
      purgeAfter: undefined,
      trashPath: undefined,
    };
    this.db.upsertTaskExecutionWorkspaceState(row);
    return row;
  }

  /** 从归档恢复为 active（目录本就在原位） */
  unarchive(taskId: string): TaskExecutionWorkspaceStateRow {
    this.assertTaskId(taskId);
    const existing = this.db.getTaskExecutionWorkspaceState(taskId);
    if (existing?.state === "trashed") {
      throw new TaskLifecycleError(`任务在回收区，请用 restore 而非 unarchive：${taskId}`);
    }
    const now = Date.now();
    this.db.archiveTask(taskId, false);
    const row: TaskExecutionWorkspaceStateRow = {
      taskId,
      directoryName: getTaskDirectoryName(taskId),
      state: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.upsertTaskExecutionWorkspaceState(row);
    return row;
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
    this.assertTaskId(taskId);
    if (this.beforeTrash) {
      try {
        await this.beforeTrash(taskId, options);
      } catch (err) {
        if (options?.strict) throw err;
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] beforeTrash 失败（继续回收）：taskId=${taskId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Explicit archive purge rechecks authorization after asynchronous session shutdown.
    options?.assertAllowed?.();

    const directoryName = getTaskDirectoryName(taskId);
    const workspaceDir = this.workspace.resolveTaskExecutionWorkspaceDir(taskId);
    const existing = this.db.getTaskExecutionWorkspaceState(taskId);

    if (existing?.state === "trashed" && this.resolveTrashPath(existing.trashPath) !== undefined) {
      // 幂等：已在回收区（含回收区整体改名后经 resolveTrashPath 定位的旧副本）
      this.db.archiveTask(taskId, true);
      return { taskId, state: "trashed", trashPath: this.resolveTrashPath(existing.trashPath), directoryMissing: false };
    }

    let trashPath: string | undefined;
    let directoryMissing = false;

    if (!existsSync(workspaceDir)) {
      directoryMissing = true;
    } else {
      this.assertDirectChildOfWorkspaces(workspaceDir, directoryName);
      this.assertManifestMatches(workspaceDir, taskId);
      this.assertNotSymlinkEscape(workspaceDir);

      mkdirSync(this.trashRoot, { recursive: true });
      trashPath = join(this.trashRoot, `${directoryName}--${Date.now()}`);
      if (existsSync(trashPath)) {
        trashPath = join(this.trashRoot, `${directoryName}--${Date.now()}-${process.pid}`);
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
        this.commitTrashedMetadata(taskId, directoryName, trashPath);
      } catch (dbErr) {
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

      return { taskId, state: "trashed", trashPath, directoryMissing: false };
    }

    // 无目录：仅 metadata
    this.commitTrashedMetadata(taskId, directoryName, undefined);
    return { taskId, state: "trashed", trashPath: undefined, directoryMissing };
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
  private commitTrashedMetadata(taskId: string, directoryName: string, trashPath?: string): void {
    const now = Date.now();
    const existing = this.db.getTaskExecutionWorkspaceState(taskId);
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
    this.assertTaskId(taskId);
    const state = this.db.getTaskExecutionWorkspaceState(taskId);
    if (!state || state.state !== "trashed") {
      throw new TaskLifecycleError(`任务不在回收区，无法 restore：${taskId} state=${state?.state ?? "none"}`);
    }

    const directoryName = getTaskDirectoryName(taskId);
    const workspaceDir = this.workspace.resolveTaskExecutionWorkspaceDir(taskId);
    // 回收区整体改名迁移后，DB 中旧 trash_path 绝对路径可能失效：按 basename 在当前回收区定位
    const trashPath = this.resolveTrashPath(state.trashPath);

    if (trashPath && existsSync(trashPath)) {
      if (existsSync(workspaceDir)) {
        const man = tryReadManifest(join(workspaceDir, MANIFEST_FILENAME));
        if (man.ok && man.manifest.taskId !== taskId) {
          throw new TaskLifecycleConflictError(
            `恢复冲突：目标目录已被其他任务占用 manifest=${man.manifest.taskId}，期望=${taskId}，path=${workspaceDir}`,
          );
        }
        if (man.ok && man.manifest.taskId === taskId) {
          // 目标已是本任务（半恢复）：丢弃 trash 副本
          try {
            rmSync(trashPath, { recursive: true, force: true });
          } catch {
            /* 非致命 */
          }
        } else {
          // 无合法本任务 manifest：仅允许空目录
          const entries = readdirSync(workspaceDir);
          if (entries.length > 0) {
            throw new TaskLifecycleConflictError(
              `恢复冲突：目标目录已存在且无合法本任务 manifest：${workspaceDir}`,
            );
          }
          try {
            rmSync(workspaceDir, { recursive: true, force: true });
          } catch (err) {
            throw new TaskLifecycleError(
              `无法清理空目标目录：${workspaceDir}（${err instanceof Error ? err.message : String(err)}）`,
            );
          }
          renameSync(trashPath, workspaceDir);
        }
      } else {
        mkdirSync(dirname(workspaceDir), { recursive: true });
        try {
          renameSync(trashPath, workspaceDir);
        } catch (err) {
          throw new TaskLifecycleError(
            `无法从回收区移回：${trashPath} → ${workspaceDir}（${err instanceof Error ? err.message : String(err)}）`,
          );
        }
      }
      this.assertManifestMatches(workspaceDir, taskId);
    } else if (existsSync(workspaceDir)) {
      const man = tryReadManifest(join(workspaceDir, MANIFEST_FILENAME));
      if (man.ok && man.manifest.taskId !== taskId) {
        throw new TaskLifecycleConflictError(
          `恢复冲突：无 trash 副本且目标被其他任务占用：${workspaceDir}`,
        );
      }
    }

    const now = Date.now();
    this.db.transaction(() => {
      this.db.archiveTask(taskId, false);
      if (existsSync(workspaceDir)) {
        this.db.bindTaskExecutionWorkspaceCwd(taskId, workspaceDir);
      }
      this.db.upsertTaskExecutionWorkspaceState({
        taskId,
        directoryName,
        state: "active",
        createdAt: state.createdAt,
        updatedAt: now,
        trashedAt: undefined,
        purgeAfter: undefined,
        trashPath: undefined,
      });
    });

    return { taskId, state: "active", workspaceDir };
  }

  /* ---------------------------------------------------------------- */
  /* 永久清理                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * 永久清理回收区任务。默认仅当 purge_after 已过或 force=true。
   * 顺序：校验 trash 路径安全 → 删 trash 目录 → onPurgeArtifacts → 删 task 行 + state。
   */
  async purge(taskId: string, options?: { force?: boolean; strict?: boolean; assertAllowed?: () => void }): Promise<PurgeResult> {
    this.assertTaskId(taskId);
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

    let removedTrashDir = false;
    // 回收区整体改名迁移后，DB 中旧 trash_path 绝对路径可能失效：按 basename 在当前回收区定位
    const trashPath = this.resolveTrashPath(state.trashPath);
    if (trashPath) {
      this.assertTrashPathSafe(trashPath);
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

    // A restore/archive toggle may arrive while artifact cleanup is awaiting I/O.
    options?.assertAllowed?.();
    if (this.db.getTaskExecutionWorkspaceState(taskId)?.state !== "trashed") {
      throw new TaskLifecycleError(`purge 中止：任务已离开回收区：${taskId}`);
    }

    this.db.transaction(() => {
      this.db.deleteTask(taskId);
      this.db.deleteTaskExecutionWorkspaceState(taskId);
    });

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
  async purgeExpired(): Promise<PurgeResult[]> {
    const now = Date.now();
    const due = this.db
      .listTaskExecutionWorkspaceStates({ state: "trashed" })
      .filter((s) => s.purgeAfter != null && s.purgeAfter <= now);
    const results: PurgeResult[] = [];
    for (const s of due) {
      try {
        results.push(await this.purge(s.taskId));
      } catch (err) {
        console.warn(
          `[TaskExecutionWorkspaceLifecycle] purgeExpired 跳过 ${s.taskId}:`,
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
  adoptOrphan(directoryName: string, taskId?: string): { taskId: string; workspaceDir: string } {
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

  /** 必须是 task-workspaces root 的直接子目录，且目录名等于期望名 */
  private assertDirectChildOfWorkspaces(dir: string, expectedName: string): void {
    const workspacesRoot = this.workspace.getTaskExecutionWorkspacesRoot();
    const resolved = resolve(dir);
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
