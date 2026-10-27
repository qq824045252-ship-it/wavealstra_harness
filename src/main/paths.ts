import { homedir } from "node:os";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getPluginDirectory, getPluginStorage } from "./plugins/PluginStorage";
import { resolvedPathKey } from "./platform/paths";

export function getPluginsDir(): string { return getPluginStorage().root; }
export function getMcpConfigPath(): string { return getPluginStorage().mcpConfig; }
export function getMcpDir(): string { return getPluginDirectory("mcp"); }
export function getExpertMarketDir(): string { return getPluginDirectory("expert-market"); }
export function getConnectorMarketDir(): string { return getPluginDirectory("connector-market"); }

/** 本产品 agentDir：~/.mybuddy（对齐 plan，非默认 ~/.pi/agent） */
export function getMyBuddyDir(): string {
  const dir = join(homedir(), ".mybuddy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* 任务执行工作区（Task Execution Workspace）路径                        */
/*                                                                     */
/* 语义：每个 Task 的执行工作区/隔离目录与生命周期，与 UI「项目/Project」   */
/* 正交；产品层 Project 不拥有、不解析也不参与本目录生命周期。              */
/*                                                                     */
/* 目录命名沿革：                                                       */
/*  旧：~/.mybuddy/projects、~/.mybuddy/projects-trash（"project" 语义   */
/*      误用；仅保留为一次性迁移源 / legacy 兼容，新代码不再使用）         */
/*  新：~/.mybuddy/task-workspaces、~/.mybuddy/task-workspaces-trash     */
/*                                                                     */
/* migrateLegacyTaskWorkspacesDirs()：一次性幂等迁移（同卷 rename），     */
/* 返回结构化结果（生效根 + 旧根 + 是否已映射），供调用方决定是否对 DB 中   */
/* 遗留的旧绝对路径做一次性重绑（见 AppDatabase.rebindLegacyTaskWorkspacePaths）。 */
/*                                                                     */
/* 语义矩阵（每侧目录独立决策）：                                       */
/*  - 新目录不存在且旧目录存在 → 整体改名（原子），migrated=true          */
/*  - 改名失败（目录被占用等）→ legacy 回退：继续使用旧目录，migrated=false */
/*  - 新旧目录同时存在 → 使用新目录，旧目录保留不动（绝不删除用户数据），    */
/*    migrated=false（旧内容未映射，不得重绑）                            */
/*  - 仅新目录存在（旧目录已消失）→ 视为此前已迁移，migrated=true          */
/* ------------------------------------------------------------------ */

const LEGACY_WORKSPACES_DIR_NAME = "projects";
const LEGACY_WORKSPACES_TRASH_DIR_NAME = "projects-trash";
const WORKSPACES_DIR_NAME = "task-workspaces";
const WORKSPACES_TRASH_DIR_NAME = "task-workspaces-trash";

export interface TaskExecutionWorkspacesDirs {
  workspacesDir: string;
  trashDir: string;
}

/** 单目录迁移决策（幂等）：返回实际生效目录 + 旧内容是否已映射到新目录。 */
function migrateOneDir(
  legacyDir: string,
  newDir: string,
  label: string,
): { dir: string; migrated: boolean } {
  if (existsSync(newDir)) {
    if (existsSync(legacyDir)) {
      console.warn(
        `[paths] 检测到旧目录 ${legacyDir} 与新目录 ${newDir} 并存：保留旧目录不动，` +
          `新代码仅使用 ${newDir}（确认无旧数据后可手动删除旧目录）`,
      );
      return { dir: newDir, migrated: false };
    }
    // 旧目录已消失：要么此前已 rename 迁移（内容随旧名消失），要么从未创建；
    // 两种情况都视为"旧名内容已映射到新名"（从未创建时对旧根路径的重绑为空操作）。
    return { dir: newDir, migrated: true };
  }
  if (existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, newDir);
      console.log(`[paths] ${label}目录已迁移：${legacyDir} → ${newDir}`);
      return { dir: newDir, migrated: true };
    } catch (err) {
      console.warn(
        `[paths] ${label}目录迁移失败（${legacyDir} → ${newDir}），` +
          `继续使用旧目录（legacy 兼容模式，仅用于旧数据）：`,
        err instanceof Error ? err.message : String(err),
      );
      return { dir: legacyDir, migrated: false };
    }
  }
  // 全新安装：旧目录从未存在，无内容可映射。
  return { dir: newDir, migrated: false };
}

export interface TaskExecutionWorkspacesMigrationResult {
  /** 生效的工作区根（可能为 legacy 路径，见 workspacesMigrated） */
  workspacesDir: string;
  /** 生效的回收区根 */
  trashDir: string;
  /** 旧工作区根（绝对路径，可能已不存在） */
  legacyWorkspacesDir: string;
  /** 旧回收区根（绝对路径，可能已不存在） */
  legacyTrashDir: string;
  /** 旧工作区内容是否已由本次/既定迁移安全映射到新根（rename 成功或旧根已消失） */
  workspacesMigrated: boolean;
  /** 旧回收区内容是否已映射到新回收区 */
  trashMigrated: boolean;
}

/**
 * 任务执行工作区目录一次性迁移（幂等；可重复启动/多次调用）。
 * 返回结构化结果（生效根 / 旧根 / 是否已映射），不做任何删除。
 * 默认参数（真实 ~/.mybuddy）的决策结果会填充进程级缓存，保证后续
 * getTaskExecutionWorkspacesDir/TrashDir 与本次决策一致；测试注入的
 * 临时 myBuddyDir 不污染缓存。
 */
export function migrateLegacyTaskWorkspacesDirs(
  myBuddyDir = getMyBuddyDir(),
): TaskExecutionWorkspacesMigrationResult {
  const legacyWorkspacesDir = join(myBuddyDir, LEGACY_WORKSPACES_DIR_NAME);
  const workspacesDirName = WORKSPACES_DIR_NAME;
  const legacyTrashDir = join(myBuddyDir, LEGACY_WORKSPACES_TRASH_DIR_NAME);
  const trashDirName = WORKSPACES_TRASH_DIR_NAME;
  const workspaces = migrateOneDir(legacyWorkspacesDir, join(myBuddyDir, workspacesDirName), "任务执行工作区");
  const trash = migrateOneDir(legacyTrashDir, join(myBuddyDir, trashDirName), "任务回收区");
  const result: TaskExecutionWorkspacesMigrationResult = {
    workspacesDir: workspaces.dir,
    trashDir: trash.dir,
    legacyWorkspacesDir,
    legacyTrashDir,
    workspacesMigrated: workspaces.migrated,
    trashMigrated: trash.migrated,
  };
  if (resolve(myBuddyDir) === resolve(getMyBuddyDir())) {
    migratedDirs = { workspacesDir: workspaces.dir, trashDir: trash.dir };
  }
  return result;
}

let migratedDirs: TaskExecutionWorkspacesDirs | null = null;

/** 进程内只做一次迁移决策，保证工作区/回收区使用同一组生效目录 */
function ensureMigratedDirs(): TaskExecutionWorkspacesDirs {
  if (!migratedDirs) migratedDirs = migrateLegacyTaskWorkspacesDirs();
  return migratedDirs;
}

/** 任务执行工作区根目录（每个任务一个独立子目录，P0 目录隔离） */
export function getTaskExecutionWorkspacesDir(): string {
  const dir = ensureMigratedDirs().workspacesDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 任务执行工作区回收区（P1.5 安全删除）。
 * 删除任务时 move 到此目录，不递归 rm；可恢复直至 purge。
 */
export function getTaskExecutionWorkspacesTrashDir(): string {
  const dir = ensureMigratedDirs().trashDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把"明确位于 legacyRoot 之下"（含等于根本身）的绝对路径映射到 newRoot 下等价路径；
 * 不匹配返回 null。用途：目录整体 rename 迁移后，一次性重绑 DB 中遗留的旧绝对路径
 * （tasks.cwd / task_execution_workspace_state.trash_path）。
 *
 * 安全性：
 *  - 词法边界用 normalize（resolve + win32 小写）比较，大小写不敏感平台不误判；
 *  - 只接受 "legacyRoot + 分隔符" 前缀，绝不命中中间同名片段（如 D:\...\projects2\x）；
 *  - 剩余部分保留原始大小写/分隔符，交给 join 归一化。
 */
export function mapLegacyRootPath(legacyRoot: string, newRoot: string, absPath: string): string | null {
  const normalizeForCompare = (p: string): string => resolvedPathKey(p);
  const base = normalizeForCompare(legacyRoot);
  const candidate = normalizeForCompare(absPath);
  if (candidate === base) return newRoot;
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (!candidate.startsWith(baseWithSep)) return null;
  const rest = absPath.slice(legacyRoot.length);
  return join(newRoot, ...rest.split(/[\\/]+/).filter(Boolean));
}

export function getDbPath(): string {
  return join(getMyBuddyDir(), "app.db");
}

export function getModelsPath(): string {
  return join(getMyBuddyDir(), "models.json");
}

export function getAuthPath(): string {
  return join(getMyBuddyDir(), "auth.json");
}

export function getGatewayDir(): string {
  const dir = join(getMyBuddyDir(), "gateway");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSoulPath(): string {
  return join(getMyBuddyDir(), "SOUL.md");
}

export function getSkillsDir(): string {
  return getPluginDirectory("skills");
}

/**
 * 受管工具根：~/.mybuddy/tools/。
 * 只放用户/产品提供的配置与 compose 文件（如 penpot/docker-compose.yml），
 * 不内置任何第三方软件；可执行程序一律走系统安装或显式环境变量。
 */
export function getToolsDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(myBuddyDir, "tools");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** MyBuddy-managed CLI helpers exposed only to MyBuddy-launched terminal processes. */
export function getMyBuddyBinDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(myBuddyDir, "bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 已安装专家目录：~/.mybuddy/plugins/experts/<slug>/（expert.json + prompt.md + avatar） */
export function getExpertsDir(): string {
  return getPluginDirectory("experts");
}

/** 专家导出（zip 分享包）输出目录 */
export function getExpertExportsDir(): string {
  const dir = join(getMyBuddyDir(), "exports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 已安装连接器注册目录：~/.mybuddy/plugins/connectors/<id>/meta.json */
export function getConnectorsDir(): string {
  return getPluginDirectory("connectors");
}

/** 场景模式用户覆盖：~/.mybuddy/modes/<working|coding|design>/ */
export function getModesDir(): string {
  const dir = join(getMyBuddyDir(), "modes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 用户导入字体：~/.mybuddy/fonts/ */
export function getFontsDir(): string {
  const dir = join(getMyBuddyDir(), "fonts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Subagent 角色定义：~/.mybuddy/plugins/agents/*.md */
export function getAgentsDir(): string {
  return getPluginDirectory("agents");
}

/** 工作流提示词模板：~/.mybuddy/plugins/prompts/*.md */
export function getPromptsDir(): string {
  return getPluginDirectory("prompts");
}

/** 粘贴/无路径附件落盘：~/.mybuddy/uploads/（截图等剪贴板 blob） */
export function getUploadsDir(): string {
  const dir = join(getMyBuddyDir(), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 资料库文件根：~/.mybuddy/library/<spaceId>/<itemId><ext> */
export function getLibraryDir(): string {
  const dir = join(getMyBuddyDir(), "library");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Gadget durable storage：~/.mybuddy/gadgets/<gadgetId>/{gadget.json,code,data}. */
export function getGadgetsDir(): string {
  const dir = join(getMyBuddyDir(), "gadgets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 未指定外部目录时，Blueprint 实例化的 Workspace 文件根。 */
export function getBlueprintWorkspaceInstancesDir(): string {
  const dir = join(getMyBuddyDir(), "workspace-instances");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* Python 受管运行时（runtimes/python）                                 */
/*                                                                     */
/* 与任务执行工作区彻底分离：解释器、依赖、锁定结果都在本目录树下，      */
/* 任务工作区只负责输入读取与用户要求的输出。                           */
/*                                                                     */
/* toolchain/ 存内部安装工具 uv，刻意不放进 bin/——bin/ 会经              */
/* TerminalHost.getPathEntries 注入用户终端 PATH（见 index.ts:2623、     */
/* TerminalHost.ts:352），而 uv 是内部工具，不应被随手调用去改动         */
/* 已就绪环境。                                                         */
/* ------------------------------------------------------------------ */

/** 受管运行时根：~/.mybuddy/runtimes/python/ */
export function getPythonRuntimeDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(myBuddyDir, "runtimes", "python");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 内部安装工具（uv）：runtimes/python/toolchain/uv/<version>/ */
export function getPythonToolchainDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "toolchain");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 受管解释器：runtimes/python/interpreters/（uv 的 python 安装目录） */
export function getPythonInterpretersDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "interpreters");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 已就绪环境：runtimes/python/environments/<specId>/（原子改名后才出现在此） */
export function getPythonEnvironmentsDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "environments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 依赖清单与锁定结果：runtimes/python/manifests/<specId>.json */
export function getPythonManifestsDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "manifests");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 下载缓存：runtimes/python/cache/ */
export function getPythonCacheDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 安装中的临时环境：runtimes/python/staging/（失败只留可清理残留，绝不标成就绪） */
export function getPythonStagingDir(myBuddyDir = getMyBuddyDir()): string {
  const dir = join(getPythonRuntimeDir(myBuddyDir), "staging");
  mkdirSync(dir, { recursive: true });
  return dir;
}
