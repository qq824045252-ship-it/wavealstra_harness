/**
 * TaskExecutionWorkspace — 任务执行工作区唯一可信解析器（P0 任务目录隔离，提交 1）
 *
 * 语义：每个 Task 的执行工作区/隔离目录（~/.mybuddy/task-workspaces/<task>），
 * 与产品层 Project Domain 正交；Project 不拥有或解析本目录。
 * 旧目录名 ~/.mybuddy/projects 已由 paths.migrateLegacyTaskWorkspacesDirs 迁移，
 * 仅作 legacy 兼容，本模块不直接引用。
 *
 * 对应《P0-task-project-isolation-fix.md》§3.1 / §4 / §6.1：
 *  - task-workspaces 根目录解析（可注入测试 root，不硬编码用户主目录）
 *  - taskId -> 稳定唯一目录名（可读前缀 + sha256 前 16 位；Windows 保留名前缀 task-）
 *  - 创建任务目录并维护 .mybuddy-task.json（原子写 temp+rename；taskId 不匹配报错）
 *  - 词法边界（relative 而非 startsWith）与 realpath/Junction 边界校验
 *
 * 本模块不依赖 Renderer / Artifact / Space；不得 fallback 到 process.cwd()。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getTaskExecutionWorkspacesDir } from "../paths";
import { resolvedPathKey } from "../platform/paths";

/** 任务目录内清单文件名（不注册为产物） */
export const MANIFEST_FILENAME = ".mybuddy-task.json";

/** 清单临时文件后缀（原子写） */
export const MANIFEST_TMP_SUFFIX = ".tmp";

export interface TaskExecutionWorkspaceManifest {
  version: 1;
  taskId: string;
  createdAt: number;
}

/** 可读前缀最大长度（不含 "--<hash>" 段） */
const READABLE_MAX = 48;
/** sha256 截取长度（hex 字符数） */
const HASH_LENGTH = 16;
/** Windows 保留设备名（文件名第一个 . 之前匹配即非法，如 CON.txt） */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 目录名非法字符（Windows 保留字符 + 控制字符） */
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/* ------------------------------------------------------------------ */
/* 错误类型                                                             */
/* ------------------------------------------------------------------ */

export class TaskExecutionWorkspaceError extends Error {}
/** 清单缺失/损坏/版本不支持 */
export class TaskManifestError extends TaskExecutionWorkspaceError {}
/** 清单 taskId 与请求不一致（目录被其他任务占用） */
export class TaskManifestMismatchError extends TaskManifestError {}
/** 路径越界（词法或 realpath/Junction 逃逸） */
export class TaskPathBoundaryError extends TaskExecutionWorkspaceError {}

/* ------------------------------------------------------------------ */
/* 路径规范化与词法边界（§4.4）                                          */
/* ------------------------------------------------------------------ */

/** 统一路径比较形式：resolve 后仅 win32 统一小写（盘符/目录大小写不敏感） */
export function normalizePathForComparison(p: string): string {
  return resolvedPathKey(p);
}

/**
 * 词法边界判断：target 位于 root 内或等于 root。
 * 使用 relative() 而非 startsWith()，避免 task-1 / task-10 前缀误判；
 * win32 下先统一小写，覆盖盘符与目录大小写差异。
 */
export function isPathInsideOrEqual(root: string, target: string): boolean {
  const base = normalizePathForComparison(root);
  const candidate = normalizePathForComparison(target);
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** 从 target 向上找到最近的已存在路径（含 target 本身）；全链不存在返回 null */
function findNearestExistingAncestor(target: string): string | null {
  let cur = target;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/* ------------------------------------------------------------------ */
/* 目录命名算法（§4.1 / §4.2）                                          */
/* ------------------------------------------------------------------ */

function isWindowsReservedName(name: string): boolean {
  // Windows 对 `CON.txt` 同样视为保留：按第一个 `.` 之前的部分判断
  return WINDOWS_RESERVED_NAME.test(name.split(".")[0]);
}

/**
 * taskId -> 稳定唯一目录名：`<readable>--<sha256 前 16 位>`。
 * - 可读前缀：非法字符替换为 "-"、折叠连续 "-"、去尾部 . 空格 -、截断 48 字符；
 *   空结果回退 "task"。
 * - Windows 保留名（CON/NUL/COM1...）统一加 `task-` 前缀。
 * - 哈希来自完整 taskId，保证不同 taskId 不碰撞（含 a/b 与 a:b、TaskA 与 taska）。
 */
export function getTaskDirectoryName(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) throw new TaskExecutionWorkspaceError("taskId 不能为空");

  const hash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, HASH_LENGTH);

  let readable =
    normalized
      .replace(INVALID_CHARS, "-")
      .replace(/-+/g, "-")
      .replace(/[. -]+$/g, "")
      .slice(0, READABLE_MAX) || "task";

  if (isWindowsReservedName(readable)) readable = `task-${readable}`;

  return `${readable}--${hash}`;
}

/* ------------------------------------------------------------------ */
/* 原子 JSON 写入（§4.6）                                               */
/* ------------------------------------------------------------------ */

/** 先写同目录临时文件再 rename，避免进程中断留下半个 JSON；失败时清理临时文件 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}${MANIFEST_TMP_SUFFIX}`,
  );
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8" });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 任务执行工作区服务（§3.1）                                            */
/* ------------------------------------------------------------------ */

/**
 * 任务执行工作区服务。workspacesRoot 可注入（测试用临时目录），
 * 默认解析为 getTaskExecutionWorkspacesDir()（迁移后 ~/.mybuddy/task-workspaces）。
 */
export class TaskExecutionWorkspace {
  private readonly workspacesRoot: string;

  constructor(workspacesRoot?: string) {
    this.workspacesRoot = workspacesRoot ? resolve(workspacesRoot) : getTaskExecutionWorkspacesDir();
  }

  getTaskExecutionWorkspacesRoot(): string {
    return this.workspacesRoot;
  }

  getTaskDirectoryName(taskId: string): string {
    return getTaskDirectoryName(taskId);
  }

  /** 纯映射：不创建目录、不写盘 */
  resolveTaskExecutionWorkspaceDir(taskId: string): string {
    return join(this.workspacesRoot, getTaskDirectoryName(taskId));
  }

  /** 创建/校验任务目录与清单（§4.6）；taskId 为空或清单不匹配时抛错，绝不 fallback */
  ensureTaskExecutionWorkspace(taskId: string): string {
    const dir = this.resolveTaskExecutionWorkspaceDir(taskId);
    mkdirSync(dir, { recursive: true });
    this.guardTaskDirRealpath(dir);
    this.writeOrValidateManifest(taskId, dir);
    return dir;
  }

  /**
   * 校验 cwd 与 taskId 的 canonical 目录一致（§7.2 createSession 第二道防线）。
   * 不一致抛 TaskExecutionWorkspaceError；绝不 fallback。
   */
  assertTaskExecutionWorkspaceDir(taskId: string, cwd: string): void {
    const canonical = this.resolveTaskExecutionWorkspaceDir(taskId);
    if (normalizePathForComparison(canonical) !== normalizePathForComparison(cwd)) {
      throw new TaskExecutionWorkspaceError(
        `任务工作目录与 canonical task root 不一致：${cwd} ≠ ${canonical}（taskId=${taskId}）`,
      );
    }
  }

  /** 读取并校验清单（含 taskId 归属），返回清单内容；缺失/损坏抛 TaskManifestError */
  readManifest(taskId: string): TaskExecutionWorkspaceManifest {
    const dir = this.resolveTaskExecutionWorkspaceDir(taskId);
    const manifestPath = join(dir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      throw new TaskManifestError(`任务目录清单不存在：${manifestPath}`);
    }
    const manifest = parseManifest(manifestPath);
    if (manifest.taskId !== taskId) {
      throw new TaskManifestMismatchError(
        `任务目录已被其他任务占用：${manifestPath} 的 manifest taskId=${manifest.taskId}，期望 taskId=${taskId}`,
      );
    }
    return manifest;
  }

  /** 任务目录本身若被替换为指向外部的 Junction/符号链接，直接拒绝（§4.5） */
  private guardTaskDirRealpath(dir: string): void {
    const rootReal = safeRealpath(this.workspacesRoot);
    const dirReal = safeRealpath(dir);
    if (rootReal && dirReal && !isPathInsideOrEqual(rootReal, dirReal)) {
      throw new TaskPathBoundaryError(
        `任务目录本身是符号链接/Junction 逃逸：${dir} 实际解析到 ${dirReal}`,
      );
    }
  }

  private writeOrValidateManifest(taskId: string, dir: string): void {
    const manifestPath = join(dir, MANIFEST_FILENAME);
    if (existsSync(manifestPath)) {
      const manifest = parseManifest(manifestPath);
      if (manifest.taskId !== taskId) {
        throw new TaskManifestMismatchError(
          `任务目录已被其他任务占用：${dir} 的 manifest taskId=${manifest.taskId}，期望 taskId=${taskId}`,
        );
      }
      return;
    }
    const manifest: TaskExecutionWorkspaceManifest = {
      version: 1,
      taskId,
      createdAt: Date.now(),
    };
    atomicWriteJson(manifestPath, manifest);
  }
}

function parseManifest(manifestPath: string): TaskExecutionWorkspaceManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new TaskManifestError(`无法读取任务目录清单：${manifestPath}（${(err as Error).message}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TaskManifestError(`任务目录清单损坏：${manifestPath}（${(err as Error).message}）`);
  }
  const m = parsed as Partial<TaskExecutionWorkspaceManifest>;
  if (m?.version !== 1 || typeof m.taskId !== "string" || typeof m.createdAt !== "number") {
    throw new TaskManifestError(
      `任务目录清单格式不支持：${manifestPath}（version=${String(m?.version)}, taskId=${String(m?.taskId)}）`,
    );
  }
  return { version: 1, taskId: m.taskId, createdAt: m.createdAt };
}

/* ------------------------------------------------------------------ */
/* 任务内路径校验（§4.5 / §8）                                           */
/* ------------------------------------------------------------------ */

/**
 * 校验 target 位于 taskRoot 内（词法 + realpath 双层），通过则返回规范化绝对路径。
 * - 词法层：relative 判断，win32 大小写不敏感（§4.4）。
 * - realpath 层：已存在目标直接 realpath；不存在则向上找最近已存在父目录，
 *   确认其真实路径仍在任务目录内，防 Junction/符号链接逃逸（§4.5）。
 * 越界抛 TaskPathBoundaryError。
 */
export function assertPathInsideTask(taskRoot: string, target: string): string {
  const root = resolve(taskRoot);
  const absTarget = resolve(target);

  if (!isPathInsideOrEqual(root, absTarget)) {
    throw new TaskPathBoundaryError(`路径越界：${absTarget} 不在任务目录 ${root} 内`);
  }

  const rootReal = safeRealpath(root);
  if (rootReal !== null) {
    const ancestor = findNearestExistingAncestor(absTarget);
    if (ancestor !== null) {
      const ancestorReal = safeRealpath(ancestor);
      if (ancestorReal !== null && !isPathInsideOrEqual(rootReal, ancestorReal)) {
        throw new TaskPathBoundaryError(
          `路径越界（符号链接/Junction 逃逸）：${absTarget} 实际解析到 ${ancestorReal}，不在任务目录 ${root} 内`,
        );
      }
    }
  }
  return absTarget;
}

/* ------------------------------------------------------------------ */
/* 外部写 grant 的 canonical 化与匹配（词法 + realpath 双层）           */
/* ------------------------------------------------------------------ */

/**
 * 把外部写授权目录 canonical 化：resolve 后若存在则取 realpath；
 * 不存在则沿最近已存在祖先取 realpath 后拼接剩余段。
 * 用于持久化 grant 前固化真实路径，防 junction/symlink 指向漂移。
 */
export function canonicalizeExternalGrantPath(path: string): string {
  const abs = resolve(path);
  const ancestor = findNearestExistingAncestor(abs);
  if (ancestor === null) return abs;
  const ancestorReal = safeRealpath(ancestor);
  if (ancestorReal === null) return abs;
  if (normalizePathForComparison(ancestorReal) === normalizePathForComparison(abs)) {
    return ancestorReal;
  }
  const suffix = relative(ancestor, abs);
  return suffix ? resolve(ancestorReal, suffix) : ancestorReal;
}

/**
 * 判定 target 是否位于授权目录 grantDir 内（词法 + realpath 双层，与
 * assertPathInsideTask 同一套防逃逸语义，但不抛错，返回布尔）。
 */
export function isPathInsideWriteGrant(grantDir: string, target: string): boolean {
  const grant = resolve(grantDir);
  const absTarget = resolve(target);
  if (!isPathInsideOrEqual(grant, absTarget)) return false;
  const grantReal = safeRealpath(grant);
  if (grantReal !== null) {
    const ancestor = findNearestExistingAncestor(absTarget);
    if (ancestor !== null) {
      const ancestorReal = safeRealpath(ancestor);
      if (ancestorReal !== null && !isPathInsideOrEqual(grantReal, ancestorReal)) {
        return false;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 模块级便捷入口 + 测试注入                                             */
/* ------------------------------------------------------------------ */

let defaultWorkspace: TaskExecutionWorkspace | null = null;

function getDefaultWorkspace(): TaskExecutionWorkspace {
  if (!defaultWorkspace) defaultWorkspace = new TaskExecutionWorkspace();
  return defaultWorkspace;
}

export function getTaskExecutionWorkspacesRoot(): string {
  return getDefaultWorkspace().getTaskExecutionWorkspacesRoot();
}

export function resolveTaskExecutionWorkspaceDir(taskId: string): string {
  return getDefaultWorkspace().resolveTaskExecutionWorkspaceDir(taskId);
}

export function ensureTaskExecutionWorkspace(taskId: string): string {
  return getDefaultWorkspace().ensureTaskExecutionWorkspace(taskId);
}

/** 模块级便捷入口：校验 cwd 与 canonical task root 一致（§7.2） */
export function assertTaskExecutionWorkspaceDir(taskId: string, cwd: string): void {
  getDefaultWorkspace().assertTaskExecutionWorkspaceDir(taskId, cwd);
}

/**
 * 仅测试用：覆盖默认实例的 task-workspaces root。
 * 测试必须传临时目录；禁止用此函数把默认实例指向真实 `~/.mybuddy`。
 */
export function setTaskExecutionWorkspacesRootForTests(workspacesRoot: string): void {
  defaultWorkspace = new TaskExecutionWorkspace(workspacesRoot);
}
