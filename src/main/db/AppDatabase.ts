import Database from "better-sqlite3";
import { ensureBotWorkTables } from "./bot-work-schema";
import { ensureBotWorkPhase2Tables } from "./bot-work-phase2-schema";
import { ensureBotWorkPhase3Tables } from "./bot-work-phase3-schema";
import { ensureBotWorkPhase4Tables } from "./bot-work-phase4-schema";
import { ensureBotWorkPhase5Tables } from "./bot-work-phase5-schema";
import { ensureGatewayDeliveryTables } from "./gateway-delivery-schema";
import { retireWorkIsolation } from "./work-isolation-retirement";
import { retireWorkBudget } from "./work-budget-retirement";
import { retireWorkEffectBlockers } from "./work-effect-retirement";
import { parseCronExecution } from "../../shared/cron-execution";
import { isGatewayBotTaskId } from "../../shared/gateway-task";
import { WorkspacePathError } from "../workspace/WorkspacePathError";
import { EXECUTION_ATTEMPT_SCHEMA } from "../agent/ExecutionAttemptRepository";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { getDbPath, getLibraryDir, mapLegacyRootPath } from "../paths";
import {
  normalizeStoredAuditInstructions,
  runtimeAuditStorageBytes,
} from "../agent/RuntimeAuditStorage";

/**
 * cad_models 表建表 SQL（dormant：kernel 已拆除，停止新写；历史数据与迁移保留）。
 * 单一来源内联于 AppDatabase（原 CadModelRepository 已随拆除删除）。
 */
const CAD_MODELS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cad_models (
    model_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'custom',
    title TEXT,
    model_dir TEXT NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '[]',
    features_json TEXT NOT NULL DEFAULT '[]',
    outputs_json TEXT NOT NULL DEFAULT '{}',
    validation_json TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cad_models_task ON cad_models(task_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cad_models_graph ON cad_models(graph_id);
`;

import type {
  CronJobDto,
  CronRunDto,
  GatewayListMessagesRequest,
  GatewayMessageDto,
  SoulDto,
  SpaceDto,
  TaskDto,
  WelcomeMode,
} from "../../shared/agent-ipc";
import { normalizeWelcomeMode } from "../../shared/mode-profile";
import type {
  ConversationBranchInfoDto,
  ConversationBranchPosition,
  ConversationBranchWorkspaceStrategy,
} from "../../shared/conversation-branch";
import type { TaskWriteGrantRow } from "../../shared/external-write";
import type { ExternalAgentPinDto } from "../../shared/external-agent";
import { computeEffectiveArchived as sharedComputeEffectiveArchived } from "../../shared/workspace-tree";

export const CURRENT_DATABASE_SCHEMA_VERSION = 36;

/**
 * Only versions with a real in-place migration may skip the backup/reset path.
 * v35 introduced the Work budget tables; v36 retires them. Keeping this set
 * explicit prevents unrelated old schemas from being silently upgraded.
 */
export const MIGRATABLE_DATABASE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([35]);

function canMigrateInPlace(version: number): boolean {
  return version === CURRENT_DATABASE_SCHEMA_VERSION || MIGRATABLE_DATABASE_SCHEMA_VERSIONS.has(version);
}

/** tasks.external_agent_pin_json → TaskDto.externalAgentPin；损坏/缺失一律按未固定处理。 */
function parseExternalAgentPin(raw: string | null | undefined): TaskDto["externalAgentPin"] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown; pinnedAt?: unknown } | null;
    if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string") {
      return {
        id: parsed.id as ExternalAgentPinDto["id"],
        name: parsed.name,
        pinnedAt: typeof parsed.pinnedAt === "number" ? parsed.pinnedAt : undefined,
      };
    }
  } catch { /* keep unset */ }
  return undefined;
}

function isExistingDirectory(p: string | null): boolean {
  if (!p) return false;
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** tasks 表行（含迁移补列），供 getTask/listTasks 共用映射 */
interface TaskRow {
  id: string;
  title: string;
  space_id: string | null;
  project_id: string | null;
  status: string | null;
  updated_at: number;
  session_file: string | null;
  cwd: string | null;
  welcome_mode: string | null;
  model_id: string | null;
  permission_mode: string | null;
  archived: number;
  expert_id: string | null;
  mode_preset_id: string | null;
  start_at: number | null;
  due_at: number | null;
  space_sort_order: number;
  is_favorited: number;
  external_agent_pin_json: string | null;
  done_acked_at: number | null;
}

/** conversation_branches 查询行（含 parent_exists 派生列） */
interface BranchRow {
  child_task_id: string;
  parent_task_id: string;
  root_task_id: string;
  parent_title_snapshot: string;
  child_title: string | null;
  source_user_message_index: number;
  source_position: ConversationBranchPosition;
  workspace_strategy: ConversationBranchWorkspaceStrategy;
  created_at: number;
  parent_exists: number;
}

/** spaces 表行（V2 tree 列），供 listSpaces/getSpace/children/ancestors 共用映射 */
interface SpaceRow {
  id: string;
  name: string;
  path: string | null;
  archived: number;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/**
 * effectiveArchived 纯计算（V2 Archive 语义）：effective = 自身 explicit archived ∨ 任一祖先。
 * 单源：直接复用 shared/workspace-tree 的同名实现（main 可安全 import shared，无循环）。
 * 保留本文件 re-export 以兼容既有 `import { computeEffectiveArchived } from "./AppDatabase"` 调用，
 * 并通过交叉测试（workspace-tree-test §18/28）保证 DB 与 selector 单算法源一致。
 * 若未来 shared 引入 main 依赖形成循环，则回退为本文件独立实现并保留交叉测试（P3 预案）。
 */
export const computeEffectiveArchived = sharedComputeEffectiveArchived;

/** P1.5 任务执行工作区生命周期状态 */
export type TaskExecutionWorkspaceLifecycleState =
  | "active"
  | "archived"
  | "trashed"
  | "orphaned"
  | "conflict";

export interface TaskExecutionWorkspaceStateRow {
  taskId: string;
  directoryName: string;
  state: TaskExecutionWorkspaceLifecycleState;
  createdAt: number;
  updatedAt: number;
  trashedAt?: number;
  purgeAfter?: number;
  trashPath?: string;
}

interface TaskExecutionWorkspaceStateSqlRow {
  task_id: string;
  directory_name: string;
  state: string;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  purge_after: number | null;
  trash_path: string | null;
}

function mapTaskExecutionWorkspaceStateRow(row: TaskExecutionWorkspaceStateSqlRow): TaskExecutionWorkspaceStateRow {
  return {
    taskId: row.task_id,
    directoryName: row.directory_name,
    state: row.state as TaskExecutionWorkspaceLifecycleState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at ?? undefined,
    purgeAfter: row.purge_after ?? undefined,
    trashPath: row.trash_path ?? undefined,
  };
}

/** 旧表 task_project_state 行（迁移校验用，与 DDL 列一致） */
interface LegacyTaskExecutionWorkspaceStateRow {
  task_id: string;
  directory_name: string;
  state: string;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  purge_after: number | null;
  trash_path: string | null;
}

/** 逐字段 null 安全比较（迁移逐行校验用；SQLite NULL → null） */
function sameNullable(a: number | string | null | undefined, b: number | string | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function sameLegacyTaskExecutionWorkspaceStateRow(
  a: LegacyTaskExecutionWorkspaceStateRow,
  b: LegacyTaskExecutionWorkspaceStateRow,
): boolean {
  return (
    a.task_id === b.task_id &&
    a.directory_name === b.directory_name &&
    a.state === b.state &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at &&
    sameNullable(a.trashed_at, b.trashed_at) &&
    sameNullable(a.purge_after, b.purge_after) &&
    sameNullable(a.trash_path, b.trash_path)
  );
}
/** 不兼容数据库的备份时间戳：UTC、文件系统安全（Windows 文件名不允许冒号）。 */
function incompatibleDatabaseBackupStamp(now = new Date()): string {
  // 2026-10-26T13:36:05.123Z → 20261026T133605123Z
  return now.toISOString().replace(/[-:.]/g, "");
}

/** 同名备份已存在时追加序号：绝不覆盖既有备份（POSIX rename 会静默覆盖目标文件）。 */
function reserveDatabaseBackupPath(candidate: string): string {
  if (!existsSync(candidate)) return candidate;
  for (let index = 1; index < 1000; index++) {
    const next = `${candidate}-${index}`;
    if (!existsSync(next)) return next;
  }
  throw new Error(`无法为不兼容数据库分配备份路径（同名备份过多）: ${candidate}`);
}

/**
 * user_version 既不是当前版本、也没有显式原地迁移路径（降级/回滚/迁移中断/损坏）时：
 * 把 db / -wal / -shm 改名到同目录 `${dbPath}.discarded-<UTC 时间戳>[-wal|-shm]` 备份，再让构造函数重建空库。
 *
 * 任何情况下都不删除用户数据：rename 失败会回滚已改名的文件并抛错（启动失败好过静默清库）。
 * 备份的 -wal/-shm 与备份主库同前缀，SQLite 打开备份时仍能自动重放未 checkpoint 的 WAL。
 */
function resetIncompatibleDatabaseFile(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const dbExisted = existsSync(dbPath);
  if (!dbExisted && !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`)) return;
  let version = -1;
  if (dbExisted) {
    try {
      const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
      try { version = Number(probe.pragma("user_version", { simple: true })); }
      finally { probe.close(); }
    } catch {
      version = -1;
    }
  }
  if (canMigrateInPlace(version)) return;

  const stamp = incompatibleDatabaseBackupStamp();
  const moved: Array<{ source: string; backup: string }> = [];
  try {
    // 先搬 WAL/SHM，最后搬主库：搬走主库前不让旧库以「可被误开」的形态留在原位。
    for (const suffix of ["-wal", "-shm", ""]) {
      const source = `${dbPath}${suffix}`;
      if (!existsSync(source)) continue;
      const backup = reserveDatabaseBackupPath(`${dbPath}.discarded-${stamp}${suffix}`);
      renameSync(source, backup);
      moved.push({ source, backup });
    }
  } catch (error) {
    for (const { source, backup } of moved.reverse()) {
      try { renameSync(backup, source); }
      catch (rollbackError) {
        console.error(
          `[AppDatabase] 备份回滚失败，文件保留在 ${backup}（未删除）：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw new Error(
      `无法备份不兼容数据库 ${dbPath}（未删除任何数据）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (existsSync(dbPath)) throw new Error(`无法重建不兼容数据库：${dbPath}`);
  const versionLabel = dbExisted ? `v${version}` : "缺失主库文件";
  console.warn(
    `[AppDatabase] incompatible database ${versionLabel} (current v${CURRENT_DATABASE_SCHEMA_VERSION}) reset: backed up ` +
      `${moved.map(({ source, backup }) => `${source} -> ${backup}`).join(", ") || "nothing"}; rebuilding empty database`,
  );
}

export class AppDatabase {
  private readonly db: Database.Database;
  private expertBindingReader?: (taskId: string) => import("../../shared/expert-binding").TaskExpertBindingDto | null;
  /** List projection reads every task's binding in one query instead of one per row. */
  private expertBindingBatchReader?: (taskIds: readonly string[]) => Map<string, import("../../shared/expert-binding").TaskExpertBindingDto | null>;

  setTaskExpertBindingReader(reader: (taskId: string) => import("../../shared/expert-binding").TaskExpertBindingDto | null): void {
    this.expertBindingReader = reader;
  }

  setTaskExpertBindingBatchReader(reader: (taskIds: readonly string[]) => Map<string, import("../../shared/expert-binding").TaskExpertBindingDto | null>): void {
    this.expertBindingBatchReader = reader;
  }

  constructor(dbPath = getDbPath()) {
    resetIncompatibleDatabaseFile(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    // Table rebuild migrations must run with FK checks disabled. Enforcement is
    // enabled for every product connection immediately after migration.
    this.db.pragma("foreign_keys = OFF");
    try {
      this.migrate();
    } catch (cause) {
      this.db.close();
      throw new Error(`数据库初始化失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    this.db.pragma("foreign_keys = ON");
  }

  /** 共享 SQLite 连接（ArtifactRepository 复用同一连接，§6：优先使用现有 SQLite） */
  get connection(): Database.Database {
    return this.db;
  }

  get schemaVersion(): number {
    return Number(this.db.pragma("user_version", { simple: true }));
  }

  /** sqlite_master 中是否存在该表（current schema 幂等 materialization 用） */
  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { found: number } | undefined;
    return row !== undefined;
  }

  private migrate(): void {
    const startVersion = this.schemaVersion;
    if (startVersion !== 0 && !canMigrateInPlace(startVersion)) {
      throw new Error(
        `数据库版本 ${startVersion} 与当前开发 schema ${CURRENT_DATABASE_SCHEMA_VERSION} 不一致；文件库应在打开前被重建`,
      );
    }

    this.db.transaction(() => {
      // v35 -> v36 is the one explicit in-place migration (Work budget retirement).
      // Every other incompatible version is discarded before opening; a fresh
      // database is materialized directly at CURRENT.
      this.ensureCurrentCoreSchema();
      this.ensureProjectTodosTable();
      this.ensureProjectEventsTable();
      this.ensureProjectResourceFolders();
      this.ensureLibraryTables();
      this.ensureProjectKnowledgeTables();
      this.ensureUsageTables();
      this.ensureNotificationTables();
      this.ensureWorkspaceLibraryLinksTables();
      this.ensurePythonProjectBindingTables();
      this.ensureLibraryChunksTables();
      this.ensureSemanticIndexTables();
      this.ensureWorkGraphTables();
      this.ensureGadgetTables();
      this.ensureBlueprintTables();
      this.ensureMemoryKernelTables();
      this.dropLegacyMemoryStorage();
      this.dropLegacyProjectMemoryTables();
      this.ensureAgentLoadoutTables();
      this.ensureConversationBranchTables();
      this.ensureConversationRuntimeTables();
      ensureBotWorkTables(this.db);
      ensureBotWorkPhase2Tables(this.db);
      ensureBotWorkPhase3Tables(this.db);
      ensureBotWorkPhase4Tables(this.db);
      ensureBotWorkPhase5Tables(this.db);
      ensureGatewayDeliveryTables(this.db);
      retireWorkIsolation(this.db);
      const budgetRetirement = retireWorkBudget(this.db);
      if (budgetRetirement.droppedTables.length || budgetRetirement.droppedColumns.length
        || budgetRetirement.deletedBlockers || budgetRetirement.deletedCausalAdmissions
        || budgetRetirement.clearedTeamBudgetErrors || budgetRetirement.resetDispatchBudgetRequests) {
        console.info(`[AppDatabase] work budget retired: ${JSON.stringify(budgetRetirement)}`);
      }
      retireWorkEffectBlockers(this.db);
      if (startVersion === 35) console.info("[AppDatabase] migrated v35 -> v36 (Work budget retirement)");
      this.migrateLegacyWelcomeModeIds();
      this.db.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
    })();
  }

  /** Persisted scene id moved from "bot" to "general"; migrate rows in place. */
  private migrateLegacyWelcomeModeIds(): void {
    this.db.prepare("UPDATE tasks SET welcome_mode = 'general' WHERE welcome_mode = 'bot'").run();
    this.db.prepare("UPDATE cron_jobs SET welcome_mode = 'general' WHERE welcome_mode = 'bot'").run();
    this.db.prepare("UPDATE task_runtime_context_snapshots SET welcome_mode = 'general' WHERE welcome_mode = 'bot'").run();
    this.db.prepare("UPDATE agent_loadout_observations SET context_json = json_set(context_json, '$.mode', 'general') WHERE json_valid(context_json) AND json_extract(context_json, '$.mode') = 'bot'").run();
  }

  private ensureNotificationTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        project_id TEXT,
        workspace_id TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        dismissed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, dismissed_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source_type, source_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
    `);
  }

  private ensureGadgetTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gadgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace', 'task')),
        scope_id TEXT,
        type TEXT NOT NULL DEFAULT 'web' CHECK (type IN ('web')),
        manifest_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_by_task_id TEXT,
        blueprint_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (scope_type = 'global' AND scope_id IS NULL) OR
          (scope_type = 'workspace' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0) OR
          (scope_type = 'task' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_gadgets_scope ON gadgets(scope_type, scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gadgets_created_by_task ON gadgets(created_by_task_id);
      CREATE INDEX IF NOT EXISTS idx_gadgets_blueprint ON gadgets(blueprint_id);
    `);
  }

  /** Blueprint versioned definitions（v19；definition_json 读取后仍须过 shared validator）。 */
  private ensureBlueprintTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blueprints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('workspace', 'gadget', 'composite')),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blueprints_kind_updated ON blueprints(kind, updated_at DESC);
    `);
  }

  /** Agent Loadout recommendation telemetry. Observation only; never mutates runtime policy. */
  private ensureAgentLoadoutTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_loadout_observations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
        recommended_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_json)),
        actual_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actual_json)),
        matched_actual_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(matched_actual_json)),
        not_selected_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(not_selected_json)),
        blocked_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_json)),
        used_skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(used_skill_ids_json)),
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id, assistant_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_loadout_task_created
        ON agent_loadout_observations(task_id, created_at DESC);
    `);
  }

  /**
   * 对话分支关系表（additive，实施规划 §5.1/§5.2）。
   *
   * 不提升 CURRENT_DATABASE_SCHEMA_VERSION：本表是幂等 additive 表，任何版本
   * 打开时都会补齐；旧库（user_version=27）保留全部数据。parent/root 不加 FK，
   * 保证来源 Task 永久删除后后代仍保留可审计的来源 ID 与标题快照。
   * request_id 持久幂等键（NOT NULL + UNIQUE，§5.4 评审裁决）。
   */
  private ensureConversationBranchTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_branches (
        child_task_id            TEXT PRIMARY KEY,
        parent_task_id           TEXT NOT NULL,
        root_task_id             TEXT NOT NULL,
        parent_title_snapshot    TEXT NOT NULL,
        source_session_file      TEXT NOT NULL,
        source_leaf_entry_id     TEXT NOT NULL,
        source_user_message_index INTEGER NOT NULL,
        request_id               TEXT NOT NULL UNIQUE,
        source_position          TEXT NOT NULL
          CHECK (source_position IN ('after_user', 'after_reply')),
        workspace_strategy       TEXT NOT NULL
          CHECK (workspace_strategy IN ('shared_space', 'current_snapshot', 'conversation_only')),
        created_at               INTEGER NOT NULL,
        FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_branches_parent
        ON conversation_branches(parent_task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_branches_root
        ON conversation_branches(root_task_id, created_at);
    `);
  }

  /** Task/Execution scoped interaction store. */
  private ensureConversationRuntimeTables(): void {
    this.db.exec(EXECUTION_ATTEMPT_SCHEMA);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('confirm','single_select','multi_select','short_text','long_text')),
        title TEXT NOT NULL,
        description TEXT,
        options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
        min_selections INTEGER,
        max_selections INTEGER,
        allow_custom INTEGER NOT NULL DEFAULT 0 CHECK (allow_custom IN (0,1)),
        custom_placeholder TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','resolved','cancelled','expired')),
        answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_interactions_task_message
        ON conversation_interactions(task_id, assistant_message_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_interactions_pending_execution
        ON conversation_interactions(execution_id)
        WHERE status = 'pending';
    `);
  }

  /** Retired pre-Kernel memory stores are deleted; Memory Kernel is the only durable truth. */
  private dropLegacyMemoryStorage(): void {
    if (this.tableExists("memories")) this.db.exec("DROP TABLE memories");
    const soulColumns = new Set(
      (this.db.pragma("table_info(soul)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (soulColumns.has("memory_digest")) {
      this.db.exec("ALTER TABLE soul DROP COLUMN memory_digest");
    }
  }

  private ensureMemoryKernelTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_organization_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('identity','preference','fact','decision','constraint','risk','open_question','progress','procedure')),
        title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','resolved','invalid')),
        importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 3),
        confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0,1)),
        source_type TEXT NOT NULL DEFAULT 'agent' CHECK (source_type IN ('user','agent','tool','library','event','manual','import')),
        source_id TEXT, source_task_id TEXT, valid_from INTEGER, valid_until INTEGER,
        content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER, recall_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_records_status_updated ON memory_records(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_records_kind_updated ON memory_records(kind, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_records_hash ON memory_records(content_hash);
      CREATE INDEX IF NOT EXISTS idx_memory_records_source_task ON memory_records(source_task_id);
      CREATE TRIGGER IF NOT EXISTS memory_organization_forget AFTER DELETE ON memory_records BEGIN
        DELETE FROM memory_organization_runs WHERE EXISTS (
          SELECT 1 FROM json_each(state_json, '$.sourceIds') WHERE value = OLD.id
        );
      END;
      CREATE TABLE IF NOT EXISTS memory_scopes (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','task','bot')),
        scope_id TEXT, binding TEXT NOT NULL DEFAULT 'owned' CHECK (binding IN ('owned','promoted')), created_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_scope_binding ON memory_scopes(memory_id, scope_type, COALESCE(scope_id,''), binding);
      CREATE INDEX IF NOT EXISTS idx_memory_scopes_lookup ON memory_scopes(scope_type, scope_id, memory_id);
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('conversation','message','task','artifact','library_item','library_chunk','project_event','agent_run','external')),
        ref_id TEXT NOT NULL, ref_title TEXT, excerpt TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_evidence_ref ON memory_evidence(memory_id, evidence_kind, ref_id);
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_ref ON memory_evidence(evidence_kind, ref_id);
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, importance INTEGER NOT NULL, confidence REAL NOT NULL, valid_from INTEGER, valid_until INTEGER,
        changed_by TEXT NOT NULL, change_reason TEXT, created_at INTEGER NOT NULL, UNIQUE(memory_id, revision),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision DESC);
      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('SUPERSEDES','CONTRADICTS','SUPPORTS','DUPLICATE_OF','DERIVED_FROM')),
        to_memory_id TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK (from_memory_id <> to_memory_id),
        UNIQUE(from_memory_id, relation, to_memory_id),
        FOREIGN KEY (from_memory_id) REFERENCES memory_records(id) ON DELETE CASCADE,
        FOREIGN KEY (to_memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id, relation);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id, relation);
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL, content_hash TEXT NOT NULL,
        dimension INTEGER NOT NULL, embedding BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (memory_id, model_id, model_version),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_hash ON memory_embeddings(content_hash);
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
        confidence REAL NOT NULL, importance INTEGER NOT NULL, explicit INTEGER NOT NULL DEFAULT 0,
        operation_hint TEXT NOT NULL CHECK (operation_hint IN ('create','update','supersede','resolve','forget')), replaces TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rejected','needs_review')), raw_json TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_memory_id TEXT,
        FOREIGN KEY (resolved_memory_id) REFERENCES memory_records(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_task ON memory_candidates(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        user_message_id TEXT,
        assistant_message_id TEXT,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending','processing','completed','failed','skipped')),
        extracted_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_turn_assistant_message ON memory_turns(assistant_message_id) WHERE assistant_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_turns_task_time ON memory_turns(task_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_turns_state ON memory_turns(extraction_state, captured_at);
      CREATE INDEX IF NOT EXISTS idx_memory_turns_task_hash ON memory_turns(task_id, content_hash);

      CREATE TABLE IF NOT EXISTS memory_pipeline_state (
        task_id TEXT PRIMARY KEY,
        captured_turns INTEGER NOT NULL DEFAULT 0,
        turns_since_l1 INTEGER NOT NULL DEFAULT 0,
        last_l1_at INTEGER,
        last_l2_at INTEGER,
        last_l3_at INTEGER,
        l1_run_count INTEGER NOT NULL DEFAULT 0,
        l2_run_count INTEGER NOT NULL DEFAULT 0,
        l3_run_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_scenarios (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project')),
        scope_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scenarios_scope ON memory_scenarios(scope_type, scope_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_core_profiles (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project')),
        scope_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
        source_scenario_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_scenario_ids_json)),
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_core_profiles_scope ON memory_core_profiles(scope_type, scope_id, updated_at DESC);

      -- User-dismissed L2/L3 projections. Ids are content-derived, so a plain
      -- delete/upsert would resurrect them on the next scheduled regeneration;
      -- this ledger makes dismissal durable until explicitly restored.
      CREATE TABLE IF NOT EXISTS memory_projection_dismissals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('scenario','profile')),
        title TEXT NOT NULL DEFAULT '',
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        dismissed_at INTEGER NOT NULL
      );

      -- L2/L3 are manual-approval projections: generation writes pending proposals;
      -- only an explicit approve inserts the live memory_scenarios/memory_core_profiles row.
      CREATE TABLE IF NOT EXISTS memory_projection_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('scenario','profile')),
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_projection_proposals_status ON memory_projection_proposals(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_skill_candidates (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project')),
        scope_id TEXT,
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        source_signature TEXT NOT NULL,
        support_count INTEGER NOT NULL DEFAULT 0 CHECK (support_count >= 0),
        distinct_task_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_task_count >= 0),
        completed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0 AND completed_task_count <= distinct_task_count),
        evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
        confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
        score REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
        installed_skill_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_status ON memory_skill_candidates(status, score DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_scope ON memory_skill_candidates(scope_type, scope_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_skill_effectiveness (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        candidate_id TEXT,
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        exposed_at INTEGER NOT NULL,
        invoked_at INTEGER,
        invocation_kind TEXT CHECK (invocation_kind IS NULL OR invocation_kind IN ('read','command')),
        tool_call_id TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
        outcome_at INTEGER,
        feedback_kind TEXT CHECK (feedback_kind IS NULL OR feedback_kind IN ('helpful','needs_revision','incorrect')),
        feedback_note TEXT,
        feedback_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id,assistant_message_id,skill_id),
        CHECK ((invoked_at IS NULL AND invocation_kind IS NULL) OR (invoked_at IS NOT NULL AND invocation_kind IS NOT NULL)),
        CHECK ((feedback_kind IS NULL AND feedback_at IS NULL) OR (feedback_kind IS NOT NULL AND feedback_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_skill ON memory_skill_effectiveness(skill_id, invoked_at DESC, exposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_task ON memory_skill_effectiveness(task_id, exposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_feedback ON memory_skill_effectiveness(feedback_kind, feedback_at DESC);

      CREATE TABLE IF NOT EXISTS memory_skill_revision_candidates (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        base_candidate_id TEXT,
        base_version TEXT NOT NULL,
        base_content_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
        issue_summary TEXT NOT NULL,
        base_description TEXT NOT NULL,
        base_instructions TEXT NOT NULL,
        proposed_description TEXT NOT NULL,
        proposed_instructions TEXT NOT NULL,
        negative_feedback_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(negative_feedback_ids_json)),
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        feedback_signature TEXT NOT NULL,
        needs_revision_count INTEGER NOT NULL DEFAULT 0 CHECK (needs_revision_count >= 0),
        incorrect_count INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
        failed_invocation_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_invocation_count >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        materialized_candidate_id TEXT,
        materialized_version TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_skill_revision_identity ON memory_skill_revision_candidates(skill_id,COALESCE(base_candidate_id,''),base_content_hash,feedback_signature);
      CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_status ON memory_skill_revision_candidates(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_skill ON memory_skill_revision_candidates(skill_id, base_candidate_id, updated_at DESC);
    `);
    // Crash/exit recovery: a process can disappear after marking an L0 batch processing but before commit.
    // No live extraction exists while AppDatabase is constructing, so these rows are safe to retry.
    this.db.prepare(
      `UPDATE memory_turns
       SET extraction_state='failed',
           attempt_count=MAX(0,attempt_count-1),
           last_error='interrupted before L1 completion'
       WHERE extraction_state='processing'`,
    ).run();
    this.ensureMemoryFts();
  }

  /** Memory lexical index: local FTS5 trigram is CJK/model-name friendly; failure only degrades recall. */
  private ensureMemoryFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          title,
          content,
          tokenize = 'trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memory_records_fts_ai AFTER INSERT ON memory_records BEGIN
          INSERT INTO memory_fts(memory_id,title,content) VALUES (new.id,new.title,new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_records_fts_au AFTER UPDATE OF title,content ON memory_records BEGIN
          DELETE FROM memory_fts WHERE memory_id=old.id;
          INSERT INTO memory_fts(memory_id,title,content) VALUES (new.id,new.title,new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_records_fts_ad AFTER DELETE ON memory_records BEGIN
          DELETE FROM memory_fts WHERE memory_id=old.id;
        END;
      `);
      const records = Number((this.db.prepare("SELECT COUNT(1) n FROM memory_records").get() as { n: number }).n);
      const indexed = Number((this.db.prepare("SELECT COUNT(DISTINCT memory_id) n FROM memory_fts").get() as { n: number }).n);
      if (records != indexed) {
        this.db.exec("DELETE FROM memory_fts");
        this.db.exec("INSERT INTO memory_fts(memory_id,title,content) SELECT id,title,content FROM memory_records");
      }
    } catch (err) {
      console.warn("[AppDatabase] Memory FTS5 不可用，检索降级为 token/BGE-M3：", err);
    }
  }

  /** usage_events / usage_backfill_state（v11；幂等）。 */
  private ensureUsageTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        entry_id TEXT PRIMARY KEY,
        task_id TEXT,
        session_file TEXT,
        source_kind TEXT NOT NULL DEFAULT 'main',
        source_detail TEXT,
        provider TEXT,
        model TEXT,
        response_model TEXT,
        ts INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_total REAL NOT NULL DEFAULT 0,
        cost_input REAL NOT NULL DEFAULT 0,
        cost_output REAL NOT NULL DEFAULT 0,
        cost_cache_read REAL NOT NULL DEFAULT 0,
        cost_cache_write REAL NOT NULL DEFAULT 0,
        stop_reason TEXT,
        error_message TEXT,
        request_started_at INTEGER,
        first_response_at INTEGER,
        completed_at INTEGER,
        ttft_ms INTEGER,
        decode_ms INTEGER,
        generation_tps REAL,
        model_wall_ms INTEGER,
        response_id TEXT,
        turn_index INTEGER,
        user_turn INTEGER,
        backfilled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_file, ts);
      CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
      CREATE TABLE IF NOT EXISTS usage_backfill_state (
        session_file TEXT PRIMARY KEY,
        last_entry_id TEXT,
        file_size INTEGER,
        file_mtime INTEGER,
        user_messages INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    // 幂等补列（JS 层，不在 SQL 串内）：已跑过中间 v11 的库可能缺 size/mtime 列
    const stateCols = this.db.pragma("table_info(usage_backfill_state)") as Array<{ name: string }>;
    const stateNames = new Set(stateCols.map((c) => c.name));
    if (!stateNames.has("file_size")) this.db.exec("ALTER TABLE usage_backfill_state ADD COLUMN file_size INTEGER");
    if (!stateNames.has("file_mtime")) this.db.exec("ALTER TABLE usage_backfill_state ADD COLUMN file_mtime INTEGER");
    // 幂等补列：user_turn（v12；覆盖已建表但未升到 v12 的库）
    const eventCols = this.db.pragma("table_info(usage_events)") as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === "user_turn")) {
      this.db.exec("ALTER TABLE usage_events ADD COLUMN user_turn INTEGER");
    }
    // 幂等补列：user_messages（v12；turns 权威口径 = jsonl user 消息数，含无回复轮次）
    if (!stateNames.has("user_messages")) {
      this.db.exec("ALTER TABLE usage_backfill_state ADD COLUMN user_messages INTEGER");
    }
  }

  private projectResourcesAllowFolder(): boolean {
    const sql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_resources'").get() as
        | { sql: string }
        | undefined
    )?.sql ?? "";
    return /kind\s+IN\s*\([^)]*'folder'/i.test(sql);
  }

  private rebuildProjectResourcesForFolders(): void {
    const columns = this.db.pragma("table_info(project_resources)") as Array<{ name: string }>;
    if (columns.length === 0) return;
    if (this.projectResourcesAllowFolder() && columns.some((column) => column.name === "parent_id")) return;
    const names = new Set(columns.map((column) => column.name));
    const sortOrder = names.has("sort_order") ? "sort_order" : "0";
    const parentId = names.has("parent_id") ? "parent_id" : "NULL";
    this.db.exec("DROP TABLE IF EXISTS project_resources_next");
    this.db.exec(`
      CREATE TABLE project_resources_next (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'file', 'url', 'folder')),
        title TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES project_resources_next(id) ON DELETE CASCADE
      );
      INSERT INTO project_resources_next
        (id, project_id, kind, title, value, enabled, sort_order, parent_id, created_at, updated_at)
      SELECT id, project_id, kind, title, value, enabled, ${sortOrder}, ${parentId}, created_at, updated_at
        FROM project_resources;
      DROP TABLE project_resources;
      ALTER TABLE project_resources_next RENAME TO project_resources;
      CREATE INDEX IF NOT EXISTS idx_project_resources_project
        ON project_resources(project_id, sort_order ASC, created_at ASC);
    `);
  }

  private ensureProjectResourceFolders(): void {
    this.rebuildProjectResourcesForFolders();
  }

  private ensureProjectTodosTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        priority TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        start_at INTEGER,
        due_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_todos_project
        ON project_todos(project_id, updated_at DESC);
    `);
  }

  private ensureProjectEventsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        ref TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        triage_status TEXT NOT NULL DEFAULT 'open'
          CHECK (triage_status IN ('open', 'dismissed')),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_events_project
        ON project_events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_events_ref
        ON project_events(project_id, source, ref);

      CREATE TABLE IF NOT EXISTS project_event_promotions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_title TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('memory', 'todo', 'library')),
        target_id TEXT NOT NULL,
        target_title TEXT,
        promoted_by TEXT NOT NULL CHECK (promoted_by IN ('user', 'agent')),
        note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pep_event
        ON project_event_promotions(project_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_pep_target
        ON project_event_promotions(project_id, target_kind, target_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pep_event_kind
        ON project_event_promotions(project_id, event_id, target_kind);
    `);
  }

  /** 资料库：个人/项目空间 + 条目 + 版本 + 任务引用。current schema 幂等建表。 */
  /**
   * v8 Project Knowledge：
   * - projects + goal/current_stage（Shared Context 显式字段）；
   * - project_context_pins（项目固定 Library 引用，只引用不复制）；
   * - Project Memory 只由统一 Memory Kernel 持久化；
   * - library_fts（FTS5 trigram，CJK 友好）检索索引，文本类条目回填。
   * 全部幂等；失败可重试（备份机制由 migrate 统一处理）。
   */
  private ensureProjectKnowledgeTables(): void {
    const projectColumns = this.db.pragma("table_info(projects)") as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "default_space_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN default_space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL");
    }
    const projectNames = new Set(projectColumns.map((c) => c.name));
    if (!projectNames.has("goal")) this.db.exec("ALTER TABLE projects ADD COLUMN goal TEXT");
    if (!projectNames.has("current_stage")) this.db.exec("ALTER TABLE projects ADD COLUMN current_stage TEXT");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_context_pins (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, item_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_context_pins_project
        ON project_context_pins(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_context_pins_item
        ON project_context_pins(item_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_reviews_project
        ON project_reviews(project_id, reviewed_at DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_action_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN ('locate_task', 'locate_plan', 'update_plan_status', 'needs_confirmation')),
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        executable INTEGER NOT NULL DEFAULT 0,
        target_ref TEXT,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'stale', 'obsolete')),
        fingerprint TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        applied_result TEXT,
        UNIQUE (project_id, fingerprint),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_actions_project
        ON project_action_proposals(project_id, status, updated_at DESC);
    `);

    this.ensureLibraryFts();
    this.repairKnowledgeOrphans();
  }

  /**
   * Project Memory 已收敛到 Memory Kernel。当前数据库只保留最新模型，
   * 因此直接移除曾经的双写真源，不再尝试兼容或导入旧表内容。
   */
  private dropLegacyProjectMemoryTables(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS project_memory_evidence;
      DROP TABLE IF EXISTS project_memory;
    `);
  }

  /**
   * 启动修复（幂等）：
   * - 残留 library_items_next 清理（上次重建中途失败的残留，DROP 前防御）；
   * - 指向不存在条目的 task_library_references 清理（v6 folder-attach 历史孤儿等）；
   * - 悬挂 collection_id 归一为 NULL（条目仍可见，避免 UI 面包屑断裂）；
   * - 孤儿项目资料空间（project 已删除但空间残留）级联清理（文件+行），personal 永不处理。
   */
  private repairKnowledgeOrphans(): void {
    this.db.exec("DROP TABLE IF EXISTS library_items_next");
    this.db.exec(
      `DELETE FROM task_library_references
       WHERE item_id NOT IN (SELECT id FROM library_items)`,
    );
    this.db.exec(
      `UPDATE library_items SET collection_id = NULL
       WHERE collection_id IS NOT NULL
         AND collection_id NOT IN (SELECT id FROM library_collections)`,
    );
    const orphans = this.db
      .prepare(
        `SELECT s.id FROM library_spaces s
         WHERE s.kind = 'team' AND s.project_id IS NOT NULL
           AND s.project_id NOT IN (SELECT id FROM projects)`,
      )
      .all() as Array<{ id: string }>;
    for (const orphan of orphans) {
      try {
        this.db.transaction(() => {
          const ftsTable = this.db
            .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'library_fts'`)
            .get() as { found: number } | undefined;
          if (ftsTable) {
            this.db
              .prepare(`DELETE FROM library_fts WHERE item_id IN (SELECT id FROM library_items WHERE space_id = ?)`)
              .run(orphan.id);
          }
          this.db.prepare(`DELETE FROM library_items WHERE space_id = ?`).run(orphan.id);
          this.db.prepare(`DELETE FROM library_collections WHERE space_id = ?`).run(orphan.id);
          this.db.prepare(`DELETE FROM library_spaces WHERE id = ?`).run(orphan.id);
        })();
        rmSync(join(getLibraryDir(), orphan.id), { recursive: true, force: true });
        console.log(`[AppDatabase] 已清理孤儿项目资料空间：${orphan.id}`);
      } catch (err) {
        console.error(`[AppDatabase] 孤儿空间清理失败（下次启动重试）：${orphan.id}`, err);
      }
    }
  }

  /** FTS5 trigram 检索索引（CJK 子串友好）；创建 + 文本条目回填（幂等，按条 try/catch）+ 历史重复行去重 */
  private ensureLibraryFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
          item_id UNINDEXED,
          title,
          filename,
          body,
          tokenize = 'trigram'
        );
      `);
    } catch (err) {
      console.warn("[AppDatabase] FTS5 不可用，检索降级为 LIKE（library_fts 未创建）：", err);
      return;
    }
    // 历史修复：早期 INSERT OR REPLACE 无 UNIQUE 约束导致同 item 重复行（旧内容残留）→ 保留最小 rowid
    this.db.exec(
      `DELETE FROM library_fts WHERE rowid NOT IN (SELECT MIN(rowid) FROM library_fts GROUP BY item_id)`,
    );
    const rows = this.db
      .prepare(
        `SELECT id, space_id, kind, filename FROM library_items
         WHERE kind IN ('markdown', 'html', 'csv')
           AND id NOT IN (SELECT item_id FROM library_fts)`,
      )
      .all() as Array<{ id: string; space_id: string; kind: string; filename: string }>;
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO library_fts (item_id, title, filename, body) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
      try {
        const abs = join(this.libraryRootFor(row.space_id), `${row.id}${extname(row.filename)}`);
        if (!existsSync(abs)) continue;
        const st = statSync(abs);
        if (!st.isFile() || st.size > 256 * 1024) continue;
        const body = readFileSync(abs, "utf8").slice(0, 200 * 1024);
        insert.run(row.id, "", row.filename, body);
      } catch {
        /* 单条失败跳过，下次启动回填 */
      }
    }
  }

  private libraryRootFor(spaceId: string): string {
    return join(getLibraryDir(), spaceId);
  }

  private ensureLibraryTables(): void {
    this.createLibrarySpacesTable();
    this.ensureLibrarySpaceColumns();
    // 先做 folder→collection 分层迁移（老库 folder 条目必须在 items 重建前被收集）
    this.ensureLibraryCollectionMigration();
    // 再确保 items 为 v7 形状（collection_id；全新库在此创建）
    this.ensureLibraryItemColumns();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_versions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        source_task_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_library_versions_item
        ON library_versions(item_id, version DESC);
      CREATE TABLE IF NOT EXISTS task_library_references (
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        project_id TEXT,
        added_at INTEGER NOT NULL,
        added_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (task_id, item_id),
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_library_refs_task
        ON task_library_references(task_id, added_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_library_refs_item
        ON task_library_references(item_id);
    `);
  }

  /**
   * R1 Scope Completion：Workspace ↔ Library Space binding 表（v14）。
   * 幂等；不依赖 FK（workspace 与 library 是不同 ID 域，绑定关系由服务层显式维护），
   * 删除时由 deleteWorkspaceLibraryLinks / deleteLibrarySpaceLinks 显式清理，避免 orphan。
   * 旧 Library 保持 unbound（不自动绑定 Root）。
   */
  private ensureWorkspaceLibraryLinksTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_library_links (
        workspace_id TEXT NOT NULL,
        library_space_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, library_space_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_library_links_workspace
        ON workspace_library_links(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_library_links_library
        ON workspace_library_links(library_space_id);

      CREATE TABLE IF NOT EXISTS workspace_library_collection_links (
        workspace_id TEXT NOT NULL,
        library_space_id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, collection_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_workspace
        ON workspace_library_collection_links(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_library
        ON workspace_library_collection_links(library_space_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_collection
        ON workspace_library_collection_links(collection_id);
    `);
  }

  /** 删除 workspace 时清理 Space + Collection 两类 binding（无 FK cascade）。 */
  deleteWorkspaceLibraryLinks(workspaceId: string): void {
    this.db.prepare(`DELETE FROM workspace_library_links WHERE workspace_id = ?`).run(workspaceId);
    this.db.prepare(`DELETE FROM workspace_library_collection_links WHERE workspace_id = ?`).run(workspaceId);
  }

  /** 删除 library space 时清理其全部 Space + Collection binding。 */
  deleteLibrarySpaceLinks(librarySpaceId: string): void {
    this.db.prepare(`DELETE FROM workspace_library_links WHERE library_space_id = ?`).run(librarySpaceId);
    this.db.prepare(`DELETE FROM workspace_library_collection_links WHERE library_space_id = ?`).run(librarySpaceId);
  }

  /** 删除资料库文件夹时清理该文件夹的 Workspace binding。 */
  deleteLibraryCollectionLinks(collectionId: string): void {
    this.db.prepare(`DELETE FROM workspace_library_collection_links WHERE collection_id = ?`).run(collectionId);
  }

  /**
   * 项目模式绑定：用户显式选择「这个 Python 项目用它自己的环境」后持久化。
   *
   * 幂等 additive 表，不提升 CURRENT_DATABASE_SCHEMA_VERSION。
   * 无 FK：python_path / manifest_path 指向文件系统而非其它表，
   * 解释器被删除时由服务层标记 available=false 并回退受管环境，不删行——
   * 用户重装 venv 后绑定应当自动恢复，而不是被悄悄丢掉。
   *
   * 主键是归一后的 dir_key（Windows 下小写 + 统一分隔符），
   * 否则同一目录换个写法就会被当成未绑定，导致反复询问。
   */
  private ensurePythonProjectBindingTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS python_project_bindings (
        dir_key TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        python_path TEXT NOT NULL,
        python_version TEXT,
        manifest_path TEXT,
        bound_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_python_project_bindings_bound_at
        ON python_project_bindings(bound_at DESC);
    `);
  }

  /**
   * R2 Chunk-level Locator（§30）：library_chunks + library_chunks_fts（FTS5 trigram）。
   * - library_chunks：按 §30 建表（id=item#chunkIndex, item_id, chunk_index, content, char_offset, hash, updated_at）
   * - library_chunks_fts：FTS5 trigram 索引（item_id UNINDEXED + chunk_id + content），用于定位
   * - 幂等、无 FK（item 删除时由 Repository/Service 显式清理），可重复启动，不破坏旧库
   */
  private ensureLibraryChunksTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_chunks (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        char_offset INTEGER NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_chunks_item
        ON library_chunks(item_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_library_chunks_hash
        ON library_chunks(hash);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
          item_id UNINDEXED,
          chunk_id UNINDEXED,
          content,
          tokenize = 'trigram'
        );
      `);
    } catch (err) {
      console.warn("[AppDatabase] library_chunks_fts FTS5 不可用（chunk 检索降级）：", err);
    }
  }

  /**
   * R3 Semantic Index（§19,§24）：library_chunk_embeddings + semantic_index_jobs。
   * - library_chunk_embeddings: PK(chunk_id,model_id,model_version) + chunk_hash 去重，embedding BLOB(4*dim)
   * - semantic_index_jobs: checkpoint/last_chunk_id/processed/failed 可恢复；无 FK，幂等
   */
  private ensureSemanticIndexTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_chunk_embeddings (
        chunk_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chunk_id, model_id, model_version)
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_hash
        ON library_chunk_embeddings(chunk_hash);
      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
        ON library_chunk_embeddings(model_id, model_version);
      CREATE TABLE IF NOT EXISTS semantic_index_jobs (
        job_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
        last_chunk_id TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Phase 6 Work Graph（ADR-001）：work_graph_edges。
   * - 幂等、无 FK（entity 删除时由 WorkGraphService 显式清理，避免 orphan）
   * - UNIQUE(from_type,from_id,relation,to_type,to_id) 防重复
   * - 索引 from/to/relation 供查询；不建 work_graph_nodes（node=现有 entity 引用）
   */
  private ensureWorkGraphTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_graph_edges (
        id            TEXT PRIMARY KEY,
        from_type     TEXT NOT NULL,
        from_id       TEXT NOT NULL,
        relation      TEXT NOT NULL,
        to_type       TEXT NOT NULL,
        to_id         TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(from_type, from_id, relation, to_type, to_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wge_from ON work_graph_edges(from_type, from_id);
      CREATE INDEX IF NOT EXISTS idx_wge_to   ON work_graph_edges(to_type, to_id);
      CREATE INDEX IF NOT EXISTS idx_wge_rel  ON work_graph_edges(relation);
    `);
  }

  /** R3：删除条目时清理其 semantic embeddings（显式，无 FK，防 orphan） */
  deleteChunkEmbeddings(itemId: string): void {
    try {
      this.db.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?)`).run(itemId);
    } catch { /* 表可能不存在 */ }
  }

  /** 删除条目时同步清理其 chunks + chunks FTS（显式，无 FK cascade，防 orphan） */
  deleteLibraryChunks(itemId: string): void {
    this.db.prepare(`DELETE FROM library_chunks WHERE item_id = ?`).run(itemId);
    try {
      this.db.prepare(`DELETE FROM library_chunks_fts WHERE item_id = ?`).run(itemId);
    } catch {
      /* FTS 表可能不存在（极早旧库首次启动前） */
    }
  }

  /** 全新/缺失时创建 library_spaces；项目和工作空间是互斥归属。 */
  private createLibrarySpacesTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
        project_id TEXT,
        workspace_id TEXT CHECK (workspace_id IS NULL OR (project_id IS NULL AND kind = 'team')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** 同 schema 幂等补列，绝不为资料归属升级重建用户数据库。 */
  private ensureLibrarySpaceColumns(): void {
    const columns = this.db.pragma("table_info(library_spaces)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "project_id")) {
      this.db.exec("ALTER TABLE library_spaces ADD COLUMN project_id TEXT");
    }
    if (!columns.some((column) => column.name === "workspace_id")) {
      this.db.exec("ALTER TABLE library_spaces ADD COLUMN workspace_id TEXT CHECK (workspace_id IS NULL OR (project_id IS NULL AND kind = 'team'))");
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_library_spaces_workspace
      ON library_spaces(workspace_id) WHERE workspace_id IS NOT NULL`);
  }

  /**
   * library_items v7 分层升级：folder 条目 → library_collections；parent_id → collection_id；
   * 缺 provenance/url/收藏列的老表在同一重建中补列。幂等：检测 collection_id 已存在则跳过；
   * 集合 id 复用原 folder item id（同一 id 空间，UI 导航/引用无缝迁移）。
   */
  private ensureLibraryItemColumns(): void {
    const columns = this.db.pragma("table_info(library_items)") as Array<{ name: string }>;
    if (columns.length === 0) {
      // 表不存在：直接按 v7 schema 创建（无 folder；含 collection_id）
      this.createLibraryItemsTable();
      return;
    }
    const names = new Set(columns.map((column) => column.name));
    if (names.has("collection_id")) {
      return; // 已 v7
    }
    const parentId = names.has("parent_id") ? "parent_id" : "NULL";
    const url = names.has("url") ? "url" : "NULL";
    const sourceType = names.has("source_type") ? "source_type" : "'created'";
    const sourceTaskId = names.has("source_task_id") ? "source_task_id" : "NULL";
    const sourceArtifactId = names.has("source_artifact_id") ? "source_artifact_id" : "NULL";
    const originalPath = names.has("original_path") ? "original_path" : "NULL";
    const contentHash = names.has("content_hash") ? "content_hash" : "NULL";
    const favorite = names.has("favorite") ? "favorite" : "0";
    const extractStatus = names.has("extract_status") ? "extract_status" : "NULL";
    this.db.exec("DROP TABLE IF EXISTS library_items_next");
    this.db.exec(`
      CREATE TABLE library_items_next (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        collection_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'csv', 'office', 'pdf', 'image', 'file', 'url')),
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        source_type TEXT NOT NULL DEFAULT 'created',
        source_task_id TEXT,
        source_artifact_id TEXT,
        original_path TEXT,
        content_hash TEXT,
        extract_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_visited_at INTEGER,
        FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (collection_id) REFERENCES library_collections(id) ON DELETE CASCADE
      );
      INSERT INTO library_items_next (
        id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
        favorite, url, source_type, source_task_id, source_artifact_id, original_path,
        content_hash, extract_status, created_at, updated_at, last_visited_at
      )
      SELECT id, space_id, CASE WHEN kind = 'folder' THEN NULL ELSE ${parentId} END, kind, title,
        filename, mime_type, size_bytes, owner, ${favorite}, ${url}, ${sourceType},
        ${sourceTaskId}, ${sourceArtifactId}, ${originalPath}, ${contentHash}, ${extractStatus},
        created_at, updated_at, last_visited_at
      FROM library_items
      WHERE kind != 'folder';
      DROP TABLE library_items;
      ALTER TABLE library_items_next RENAME TO library_items;
      CREATE INDEX IF NOT EXISTS idx_library_items_space
        ON library_items(space_id, collection_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_library_items_visited
        ON library_items(last_visited_at DESC);
    `);
  }

  /** folder 条目 → LibraryCollection 迁移（v7 分层；幂等，重复启动安全） */
  private ensureLibraryCollectionMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_collections (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES library_collections(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_library_collections_space
        ON library_collections(space_id, parent_id, name COLLATE NOCASE);
    `);
    const columns = this.db.pragma("table_info(library_items)") as Array<{ name: string }>;
    if (columns.length === 0 || columns.some((column) => column.name === "collection_id")) {
      return;
    }
    // 老表仍有 folder 条目：集合 id 复用 folder item id，条目 parent_id → collection_id
    this.db.exec(`
      INSERT OR IGNORE INTO library_collections (id, space_id, parent_id, name, owner, created_at, updated_at)
      SELECT id, space_id, parent_id, title, owner, created_at, updated_at
      FROM library_items WHERE kind = 'folder';
    `);
    this.ensureLibraryItemColumns();
  }

  /** 全新 library_items 表（v7：无 folder；含 collection_id） */
  private createLibraryItemsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_items (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        collection_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'csv', 'office', 'pdf', 'image', 'file', 'url')),
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        source_type TEXT NOT NULL DEFAULT 'created',
        source_task_id TEXT,
        source_artifact_id TEXT,
        original_path TEXT,
        content_hash TEXT,
        extract_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_visited_at INTEGER,
        FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (collection_id) REFERENCES library_collections(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_library_items_space
        ON library_items(space_id, collection_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_library_items_visited
        ON library_items(last_visited_at DESC);
    `);
  }

  private ensureCurrentCoreSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_notes (
        workspace_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        space_id TEXT,
        project_id TEXT,
        status TEXT,
        updated_at INTEGER NOT NULL,
        session_file TEXT,
        cwd TEXT,
        welcome_mode TEXT,
        model_id TEXT,
        permission_mode TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        expert_id TEXT,
        mode_preset_id TEXT,
        context_used_tokens INTEGER,
        context_window_tokens INTEGER,
        context_cache_hit_rate REAL,
        start_at INTEGER,
        due_at INTEGER,
        space_sort_order INTEGER NOT NULL DEFAULT 0,
        is_favorited INTEGER NOT NULL DEFAULT 0,
        external_agent_pin_json TEXT,
        done_acked_at INTEGER,
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS task_write_grants (
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, path),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );


      CREATE TABLE IF NOT EXISTS soul (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        alias TEXT NOT NULL,
        persona TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        space_id TEXT,
        cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        execution_json TEXT
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        task_id TEXT,
        FOREIGN KEY (job_id) REFERENCES cron_jobs(id)
      );

      CREATE TABLE IF NOT EXISTS gateway_channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        connected INTEGER NOT NULL DEFAULT 0,
        status_text TEXT
      );

      CREATE TABLE IF NOT EXISTS gateway_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        chat_id TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_gateway_messages_chat
        ON gateway_messages(channel_id, chat_id, created_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        resource_budget_chars INTEGER NOT NULL DEFAULT 128000,
        template_id TEXT
      );

      CREATE TABLE IF NOT EXISTS project_notes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_expert_policy (
        project_id TEXT PRIMARY KEY,
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        recommended_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_skill_policy (
        project_id TEXT PRIMARY KEY,
        prefer_json TEXT NOT NULL DEFAULT '[]',
        demote_json TEXT NOT NULL DEFAULT '[]',
        hide_json TEXT NOT NULL DEFAULT '[]',
        allow_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_connector_policy (
        project_id TEXT PRIMARY KEY,
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        recommended_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_mcp_policy (
        project_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'hard',
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'file', 'url', 'folder')),
        title TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES project_resources(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_resources_project
        ON project_resources(project_id, sort_order ASC, created_at ASC);

      CREATE TABLE IF NOT EXISTS project_posts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_posts_project
        ON project_posts(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        priority TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        start_at INTEGER,
        due_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_todos_project
        ON project_todos(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_runtime_context_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        welcome_mode TEXT NOT NULL,
        tag_id TEXT,
        project_id TEXT,
        project_updated_at INTEGER,
        resolved_instructions_json TEXT NOT NULL,
        resolved_capabilities_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        execution_id TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        assembly_hash TEXT,
        model_id TEXT,
        permission_mode TEXT,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_runtime_snapshots_task
        ON task_runtime_context_snapshots(task_id, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name
        ON projects(name COLLATE NOCASE);
    `);

    const projectColumns = this.db.pragma("table_info(projects)") as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "resource_budget_chars")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN resource_budget_chars INTEGER NOT NULL DEFAULT 128000");
    }
    if (!projectColumns.some((column) => column.name === "template_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN template_id TEXT");
    }
    const resourceColumns = this.db.pragma("table_info(project_resources)") as Array<{ name: string }>;
    if (!resourceColumns.some((column) => column.name === "sort_order")) {
      this.db.exec("ALTER TABLE project_resources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
      const rows = this.db.prepare(
        "SELECT id, project_id FROM project_resources ORDER BY project_id, created_at, id",
      ).all() as Array<{ id: string; project_id: string }>;
      const positions = new Map<string, number>();
      const update = this.db.prepare("UPDATE project_resources SET sort_order = ? WHERE id = ?");
      this.db.transaction(() => {
        for (const row of rows) {
          const position = positions.get(row.project_id) ?? 0;
          update.run(position, row.id);
          positions.set(row.project_id, position + 1);
        }
      })();
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_project_resources_project;
      CREATE INDEX idx_project_resources_project
        ON project_resources(project_id, sort_order ASC, created_at ASC);
    `);
    this.db.exec("DROP INDEX IF EXISTS idx_task_runtime_context_snapshots_task");

    const runtimeSnapshotColumns = this.db.pragma("table_info(task_runtime_context_snapshots)") as Array<{ name: string }>;
    const runtimeSnapshotColumnNames = new Set(runtimeSnapshotColumns.map((column) => column.name));
    const runtimeSnapshotMigrations: Array<[string, string]> = [
      ["material_usage_json", "TEXT"],
      ["working_directory", "TEXT"],
      ["execution_id", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'completed'"],
      ["started_at", "INTEGER"],
      ["completed_at", "INTEGER"],
      ["error", "TEXT"],
      ["assembly_hash", "TEXT"],
      ["model_id", "TEXT"],
      ["permission_mode", "TEXT"],
      ["storage_bytes", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of runtimeSnapshotMigrations) {
      if (!runtimeSnapshotColumnNames.has(name)) {
        this.db.exec(`ALTER TABLE task_runtime_context_snapshots ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE task_runtime_context_snapshots
      SET execution_id = COALESCE(execution_id, id),
          started_at = COALESCE(started_at, created_at),
          assembly_hash = COALESCE(assembly_hash, '')
      WHERE execution_id IS NULL OR started_at IS NULL OR assembly_hash IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runtime_snapshots_execution
        ON task_runtime_context_snapshots(execution_id);
    `);

    // V2 Workspace Tree（schema v13）：spaces 自引用层级 + 显式排序（只加列/索引，零数据破坏）。
    //  - parent_id TEXT NULL：NULL = 根空间（不用空串哨兵），指向直接父空间；
    //  - sort_order（spaces）/ space_sort_order（tasks）：同父下显式排序键（1000 步进；0 = 未显式排序，
    //    展示回退 created_at / updated_at，且不会因 updatedAt 变化自动改写显式排序）；
    //  - 另建 idx_spaces_parent；唯一性改为两条 partial index（根层同名禁止、不同父允许同名），
    //    移除旧全局 idx_spaces_name（否则不同父同名永远冲突，且 SQLite 对 parent_id IS NULL 的
    //    UNIQUE(parent_id,name) 无法表达「根层同名禁止」——NULL 互不相等）。
    const wsSpaceCols = this.db.pragma("table_info(spaces)") as Array<{ name: string }>;
    const wsSpaceNames = new Set(wsSpaceCols.map((column) => column.name));
    if (!wsSpaceNames.has("parent_id")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN parent_id TEXT");
      // 历史空间全部视为根（parent_id = NULL）；不要改写任务归属或路径。
      this.db.exec("UPDATE spaces SET parent_id = NULL WHERE parent_id IS NOT NULL");
    }
    if (!wsSpaceNames.has("sort_order")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
      // 一次性回填（仅当列刚新增）：尽量复刻旧侧栏「最新任务在上」的稳定视图。
      // 按根空间 MAX(task.updated_at) DESC → created_at → id 的确定性顺序分配 1000,2000…。
      this.backfillSpaceSortOrders();
    }
    const wsTaskCols = this.db.pragma("table_info(tasks)") as Array<{ name: string }>;
    const wsTaskNames = new Set(wsTaskCols.map((column) => column.name));
    if (!wsTaskNames.has("space_sort_order")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN space_sort_order INTEGER NOT NULL DEFAULT 0");
      // tasks 不做按 updated_at 的全量回填：显式排序语义 = 拖拽后写；默认 0（未显式排序），
      // 未来侧栏排序规则 = COALESCE(space_sort_order, 0) 之外再按更新时间（见 Phase2/3 ADR-2）。
    }
    try {
      this.db.exec("DROP INDEX IF EXISTS idx_spaces_name");
    } catch (err) {
      console.warn("[AppDatabase] 清理旧全局索引失败：", err);
    }
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_root_name ON spaces(name COLLATE NOCASE) WHERE parent_id IS NULL",
      );
    } catch (err) {
      console.error(
        "[AppDatabase] 创建根层唯一索引失败（库中存在同名根空间？），请运行 scripts/dedupe-spaces.ts 清理后重启：",
        err,
      );
    }
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_child_name ON spaces(parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL",
      );
    } catch (err) {
      console.error(
        "[AppDatabase] 创建子层唯一索引失败（库中存在同父同名空间？），请运行 scripts/dedupe-spaces.ts 清理后重启：",
        err,
      );
    }
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id)");
    } catch (err) {
      console.error("[AppDatabase] 创建 idx_spaces_parent 失败：", err);
    }

    // 空间归档：老库没有 archived 列时补齐（0 = 未归档）。
    // 归档只做标记、不删数据，恢复后数据原样可用。
    const spaceColumns = this.db.pragma("table_info(spaces)") as Array<{ name: string }>;
    const spaceColumnNames = new Set(spaceColumns.map((column) => column.name));
    if (!spaceColumnNames.has("archived")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }

    // 任务归档：同样只做标记；upsertTask 的 ON CONFLICT 不触碰该列，归档状态不丢。
    const taskColumns = this.db.pragma("table_info(tasks)") as Array<{ name: string }>;
    const taskColumnNames = new Set(taskColumns.map((column) => column.name));
    if (!taskColumnNames.has("archived")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumnNames.has("expert_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN expert_id TEXT");
    }
    if (!taskColumnNames.has("mode_preset_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN mode_preset_id TEXT");
    }
    if (!taskColumnNames.has("project_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
    }
    // 上下文用量快照：prompt 结束时写入，重启后 registry 无活跃会话时用于恢复 UI 显示。
    // 纯展示用，允许在会话被外部改动后过期；两列都允许 NULL（从未运行过 = 未知）。
    if (!taskColumnNames.has("context_used_tokens")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context_used_tokens INTEGER");
    }
    if (!taskColumnNames.has("context_window_tokens")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context_window_tokens INTEGER");
    }
    // 上下文缓存命中率快照（0..1；无调用数据为 NULL），与用量快照同步落库。
    if (!taskColumnNames.has("context_cache_hit_rate")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context_cache_hit_rate REAL");
    }
    if (!taskColumnNames.has("start_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN start_at INTEGER");
    }
    if (!taskColumnNames.has("due_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN due_at INTEGER");
    }
    if (!taskColumnNames.has("is_favorited")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN is_favorited INTEGER NOT NULL DEFAULT 0");
    }
    this.ensureProjectForeignKeyOnTasks();
    // ACP pin 列必须在 FK 重建之后补：tasks_project_fk_next 的显式列清单不含此列，
    // 若在其前 ALTER，旧库重建会把它连同数据一起丢掉。
    const taskColumnsAfterRebuild = new Set(
      (this.db.pragma("table_info(tasks)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!taskColumnsAfterRebuild.has("external_agent_pin_json")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN external_agent_pin_json TEXT");
    }
    // 侧栏「已结束」绿点的确认水位：只由 ackTaskDone 推进（点击任务 = 已查看）。
    // 首次加列时把既有任务一律回填为 updated_at（= 视为历史已读）：否则升级后所有历史完成任务
    // 会同时亮绿点，等于把「未读」变成噪声。回填只在此分支发生一次，之后新任务保持 NULL（未读）。
    if (!taskColumnsAfterRebuild.has("done_acked_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN done_acked_at INTEGER");
      this.db.exec("UPDATE tasks SET done_acked_at = updated_at");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)");

    // P1.5：任务执行工作区生命周期状态（归档/回收/孤儿）；与 tasks.archived 并存
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_execution_workspace_state_state
        ON task_execution_workspace_state(state);
    `);

    // ---- 语义纠偏（2026-08）：task_project_state → task_execution_workspace_state ----
    // 兼容旧安装：旧表存在时在单事务内复制（INSERT OR IGNORE），**逐行内容校验**新表完整包含
    // 旧表全部记录后才 DROP 旧表（不做总行数相等判断，新表额外合法记录不影响迁移）：
    //  - 空旧表（降级旧版重建等）→ 无数据可迁移，直接安全清理；
    //  - 同 task_id 但内容不同（无法安全合并）→ 抛错回滚，旧表保留，下次启动重试；
    // 失败自动回滚（旧表保留，下次启动重试）；重复启动幂等；绝不先删旧数据再赌成功。
    if (this.tableExists("task_project_state")) {
      try {
        this.db.transaction(() => {
          const legacyRows = this.db
            .prepare(
              `SELECT task_id, directory_name, state, created_at, updated_at,
                      trashed_at, purge_after, trash_path
               FROM task_project_state`,
            )
            .all() as LegacyTaskExecutionWorkspaceStateRow[];
          if (legacyRows.length === 0) {
            // 空旧表：无数据可迁移（例如降级旧版运行时重建的空表），安全清理
            this.db.exec("DROP TABLE task_project_state");
            console.log("[AppDatabase] task_project_state 为空，直接清理旧表（无需迁移）");
            return;
          }
          this.db
            .prepare(
              `INSERT OR IGNORE INTO task_execution_workspace_state
                 (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
               SELECT task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path
               FROM task_project_state`,
            )
            .run();
          // 逐行校验：新表必须包含旧表全部记录且内容一致（缺失或同 task_id 内容冲突 → 拒绝 drop）
          const getNewRow = this.db.prepare(
            `SELECT task_id, directory_name, state, created_at, updated_at,
                    trashed_at, purge_after, trash_path
             FROM task_execution_workspace_state WHERE task_id = ?`,
          );
          const mismatched = legacyRows.filter((legacy) => {
            const current = getNewRow.get(legacy.task_id) as LegacyTaskExecutionWorkspaceStateRow | undefined;
            if (!current) return true;
            return !sameLegacyTaskExecutionWorkspaceStateRow(legacy, current);
          });
          if (mismatched.length > 0) {
            const ids = mismatched.map((m) => m.task_id).slice(0, 5).join(", ");
            throw new Error(
              `task_project_state 迁移校验不一致：${mismatched.length} 条记录无法安全迁移` +
                `（缺失或同 task_id 内容冲突）：${ids}...`,
            );
          }
          this.db.exec("DROP TABLE task_project_state");
          console.log(
            `[AppDatabase] task_project_state → task_execution_workspace_state 迁移完成（${legacyRows.length} 行）`,
          );
        })();
      } catch (err) {
        console.error(
          "[AppDatabase] task_project_state 迁移失败（保留旧表，下次启动重试）：",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Mechanical CAD：cad_models 轻量索引（幂等迁移；几何真相在任务工作区文件；dormant：停止新写）
    this.db.exec(CAD_MODELS_TABLE_SQL);
    // 老库补列：features_json（model.json graph.nodes 提取的特征摘要）
    const cadColumns = this.db.pragma("table_info(cad_models)") as Array<{ name: string }>;
    const cadColumnNames = new Set(cadColumns.map((column) => column.name));
    if (!cadColumnNames.has("features_json")) {
      this.db.exec("ALTER TABLE cad_models ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]'");
    }

    // 自动化任务扩展字段（权限/模型/专家/技能/连接器/生效区间）
    const cronColumns = this.db.pragma("table_info(cron_jobs)") as Array<{ name: string }>;
    const cronColumnNames = new Set(cronColumns.map((column) => column.name));
    if (!cronColumnNames.has("permission_mode")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN permission_mode TEXT");
    }
    if (!cronColumnNames.has("model_id")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN model_id TEXT");
    }
    if (!cronColumnNames.has("expert_id")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN expert_id TEXT");
    }
    if (!cronColumnNames.has("skill_ids_json")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!cronColumnNames.has("connector_ids_json")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN connector_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!cronColumnNames.has("effective_from")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN effective_from INTEGER");
    }
    if (!cronColumnNames.has("effective_to")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN effective_to INTEGER");
    }
    if (!cronColumnNames.has("welcome_mode")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN welcome_mode TEXT");
    }
    if (!cronColumnNames.has("project_id")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN project_id TEXT");
    }
    if (!cronColumnNames.has("execution_json")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN execution_json TEXT");
    }

    const soul = this.db.prepare("SELECT id FROM soul WHERE id = 1").get();
    if (!soul) {
      this.db
        .prepare(
          `INSERT INTO soul (id, name, alias, persona)
           VALUES (1, @name, @alias, @persona)`,
        )
        .run({
          name: "MyBuddy",
          alias: "老板",
          persona: "你是本地桌面助理，简洁、可靠、会动手。",
        });
    }
  }

  /**
   * SQLite cannot add a foreign key with ALTER TABLE. Rebuild legacy tasks
   * tables once so direct SQL Project deletion has the same SET NULL semantics
   * as ProjectRepository.delete(). Existing dangling ids are normalized to NULL.
   */
  private ensureProjectForeignKeyOnTasks(): void {
    const foreignKeys = this.db.pragma("foreign_key_list(tasks)") as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const ready = foreignKeys.some(
      (key) =>
        key.table === "projects" &&
        key.from === "project_id" &&
        key.to === "id" &&
        key.on_delete.toUpperCase() === "SET NULL",
    );
    if (ready) return;

    // 重建前动态探测可选列（is_favorited 由 v2 编号迁移在 reconcile 之后补；
    // space_sort_order 由 V2 树 ensure 补），源表缺失时以 0 兜底，绝不因缺列中断迁移。
    const info = this.db.pragma("table_info(tasks)") as Array<{ name: string }>;
    const hasFavorite = info.some((c) => c.name === "is_favorited");
    const hasSpaceSort = info.some((c) => c.name === "space_sort_order");
    const favoriteCol = hasFavorite ? "task.is_favorited" : "0";
    const spaceSortCol = hasSpaceSort ? "task.space_sort_order" : "0";
    const extraInsertCols = hasFavorite || hasSpaceSort ? ", space_sort_order, is_favorited" : "";

    this.db.transaction(() => {
      this.db.exec(
        `
        DROP TABLE IF EXISTS tasks_project_fk_next;
        CREATE TABLE tasks_project_fk_next (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          space_id TEXT,
          project_id TEXT,
          status TEXT,
          updated_at INTEGER NOT NULL,
          session_file TEXT,
          cwd TEXT,
          welcome_mode TEXT,
          model_id TEXT,
          permission_mode TEXT,
          archived INTEGER NOT NULL DEFAULT 0,
          expert_id TEXT,
          mode_preset_id TEXT,
          context_used_tokens INTEGER,
          context_window_tokens INTEGER,
          start_at INTEGER,
          due_at INTEGER,
          space_sort_order INTEGER NOT NULL DEFAULT 0,
          is_favorited INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (space_id) REFERENCES spaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        INSERT INTO tasks_project_fk_next (
          id, title, space_id, project_id, status, updated_at, session_file, cwd,
          welcome_mode, model_id, permission_mode, archived, expert_id,
          mode_preset_id, context_used_tokens, context_window_tokens, start_at, due_at${extraInsertCols}
        )
        SELECT
          task.id,
          task.title,
          task.space_id,
          CASE
            WHEN task.project_id IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM projects WHERE projects.id = task.project_id)
              THEN task.project_id
            ELSE NULL
          END,
          task.status,
          task.updated_at,
          task.session_file,
          task.cwd,
          task.welcome_mode,
          task.model_id,
          task.permission_mode,
          task.archived,
          task.expert_id,
          task.mode_preset_id,
          task.context_used_tokens,
          task.context_window_tokens,
          task.start_at,
          task.due_at,
          COALESCE(${spaceSortCol}, 0),
          COALESCE(${favoriteCol}, 0)
        FROM tasks AS task;

        DROP TABLE tasks;
        ALTER TABLE tasks_project_fk_next RENAME TO tasks;
      `,
      );
    })();
  }

  listSpaces(): SpaceDto[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, path, archived, parent_id, sort_order, created_at, updated_at FROM spaces ORDER BY updated_at DESC",
      )
      .all() as SpaceRow[];
    const effective = computeEffectiveArchived(
      rows.map((r) => ({ id: r.id, parentId: r.parent_id, archived: Boolean(r.archived) })),
    );
    return rows.map((r) => this.mapSpaceRow(r, effective.get(r.id) ?? false));
  }

  /** 空间行 → SpaceDto（统一映射；effectiveArchived 可选，仅 list 时计算） */
  private mapSpaceRow(r: SpaceRow, effectiveArchived = false): SpaceDto {
    return {
      id: r.id,
      name: r.name,
      path: r.path ?? undefined,
      archived: Boolean(r.archived),
      parentId: r.parent_id,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      effectiveArchived,
      pathMissing: Boolean(r.path) && !isExistingDirectory(r.path),
    };
  }

  private rawSpaceWhere(
    where: string,
    params: unknown[],
  ): SpaceRow | undefined {
    return this.db.prepare(
      `SELECT id, name, path, archived, parent_id, sort_order, created_at, updated_at FROM spaces WHERE ${where} LIMIT 1`,
    ).get(...params) as SpaceRow | undefined;
  }

  /**
   * 按 id 写入空间（存在则更新）。
   * name 同级撞名（NOCASE）时抛 SQLITE_CONSTRAINT（两条 partial unique 索引兜底），
   * 由 IPC 层捕获返回给调用方。
   * parentId / sortOrder：undefined = 保留旧值（兼容旧调用/仅改名改路径）；null = 显式根。
   * 返回生效后的行，便于调用方拿到最终 id。
   */
  upsertSpace(space: SpaceDto): SpaceDto {
    const now = Date.now();
    const prev = this.db
      .prepare("SELECT parent_id, sort_order FROM spaces WHERE id = ?")
      .get(space.id) as { parent_id: string | null; sort_order: number } | undefined;
    const parentId = space.parentId !== undefined ? (space.parentId ?? null) : (prev?.parent_id ?? null);
    const sortOrder = space.sortOrder !== undefined ? space.sortOrder : (prev?.sort_order ?? this.nextChildSortOrder(parentId));
    if (parentId) this.assertSpaceExists(parentId);
    this.db
      .prepare(
        `INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at)
         VALUES (@id, @name, @path, @parentId, @sortOrder, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           parent_id = excluded.parent_id,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .run({ id: space.id, name: space.name, path: space.path ?? null, parentId, sortOrder, now });
    return { id: space.id, name: space.name, path: space.path, parentId, sortOrder };
  }

  /**
   * 显式创建根/子空间（V2 tree）。不传 id 时由主进程生成（randomUUID）。
   * parentId：null/缺省 = 根空间；非空 = 直接父空间（必须存在）。
   * 命名/父级同层唯一由 partial unique 索引兜底。
   */
  createSpace(input: {
    id?: string;
    name: string;
    path?: string | null;
    parentId?: string | null;
    sortOrder?: number;
  }): SpaceDto {
    const id = input.id?.trim() || `sp-${randomUUID()}`;
    const parentId = input.parentId ?? null;
    const sortOrder = input.sortOrder ?? this.nextChildSortOrder(parentId);
    return this.upsertSpace({
      id,
      name: input.name,
      path: input.path ?? undefined,
      parentId,
      sortOrder,
    });
  }

  /** 重命名空间；新名称与**同父**其它空间撞名（NOCASE）时抛 SQLITE_CONSTRAINT。 */
  renameSpace(id: string, name: string): void {
    this.db
      .prepare("UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, Date.now(), id);
  }

  /** 按 id 取空间；不存在返回 undefined */
  getSpace(id: string): SpaceDto | undefined {
    const row = this.rawSpaceWhere("id = ?", [id]);
    return row ? this.mapSpaceRow(row, this.isSpaceEffectiveArchived(row.id)) : undefined;
  }

  /**
   * 按名称取空间（V2 名称语义）：全局唯一假设已退出核心路径——此方法只匹配**根空间**
   * （parent_id IS NULL），避免树中同名子空间被静默命中。子空间请用 findChildSpaceByName。
   */
  findSpaceByName(name: string): SpaceDto | undefined {
    return this.findRootSpaceByName(name);
  }

  /** 根空间（parent_id IS NULL）按名称精确查找（NOCASE）。 */
  findRootSpaceByName(name: string): SpaceDto | undefined {
    const row = this.rawSpaceWhere("name = ? COLLATE NOCASE AND parent_id IS NULL", [name]);
    return row ? this.mapSpaceRow(row, this.isSpaceEffectiveArchived(row.id)) : undefined;
  }

  /** 指定父空间下的直接子空间按名称精确查找（NOCASE；parentId 必须非空）。 */
  findChildSpaceByName(parentId: string, name: string): SpaceDto | undefined {
    const row = this.rawSpaceWhere("parent_id = ? AND name = ? COLLATE NOCASE", [parentId, name]);
    return row ? this.mapSpaceRow(row, this.isSpaceEffectiveArchived(row.id)) : undefined;
  }

  findSpaceByPath(path: string): SpaceDto | undefined {
    const row = this.rawSpaceWhere("path = ? COLLATE NOCASE", [path]);
    return row ? this.mapSpaceRow(row, this.isSpaceEffectiveArchived(row.id)) : undefined;
  }

  /** 直接子空间列表（parentId null = 根空间），按 sort_order → created_at → id 稳定排序（与 shared compareMixed 的 space tie-break 对齐，不使用 name）。 */
  getSpaceChildren(parentId: string | null): SpaceDto[] {
    const rows =
      parentId == null
        ? (this.db
            .prepare(
              `SELECT id, name, path, archived, parent_id, sort_order, created_at, updated_at FROM spaces
               WHERE parent_id IS NULL ORDER BY sort_order ASC, created_at ASC, id`,
            )
            .all() as SpaceRow[])
        : (this.db
            .prepare(
              `SELECT id, name, path, archived, parent_id, sort_order, created_at, updated_at FROM spaces
               WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC, id`,
            )
            .all(parentId) as SpaceRow[]);
    return rows.map((r) => this.mapSpaceRow(r, this.isSpaceEffectiveArchived(r.id)));
  }

  /** 祖先链（[直接父 → … → 根]，不含自身）；脏数据环用 visited-set 防御，不会死循环。 */
  getSpaceAncestors(spaceId: string): SpaceDto[] {
    const out: SpaceDto[] = [];
    const seen = new Set<string>();
    let cursor = this.getSpace(spaceId)?.parentId ?? null;
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const space = this.getSpace(cursor);
      if (!space) break;
      out.push(space);
      cursor = space.parentId ?? null;
    }
    return out;
  }

  /** 子的直接后代集合（BFS，含 visited 环防御）；用于 cycle 校验与空删除判定。 */
  private collectSpaceDescendants(spaceId: string): Set<string> {
    const out = new Set<string>();
    const seen = new Set<string>([spaceId]);
    const queue = [spaceId];
    const rows = this.db.prepare("SELECT id FROM spaces WHERE parent_id = ?");
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = rows.all(current) as Array<{ id: string }>;
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.add(child.id);
        queue.push(child.id);
      }
    }
    return out;
  }

  private assertSpaceExists(id: string): void {
    const row = this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(id);
    if (!row) throw new Error(`空间不存在：${id}`);
  }

  /**
   * 移动/重挂空间（V2 tree）。同一事务内：
   *  - targetParentId 必须存在（或 null = 根）；
   *  - target != self 且 target 不在 source 的后代子树（cycle 必须拒绝并整体回滚）；
   *  - targetSortOrder 显式排序值（直接使用）；
   *  - targetIndex 插入位置（0 = 首位），缺省追加到末尾，插入后同父兄弟重排 1000,2000… 消除 0 并保证重启稳定；
   *  - 目标排序缺省追加到新父末尾（MAX(sort_order)+1000）。
   */
  moveSpace(input: { spaceId: string; targetParentId: string | null; targetIndex?: number; targetSortOrder?: number }): void {
    const { spaceId, targetParentId } = input;
    this.assertSpaceExists(spaceId);
    if (targetParentId) this.assertSpaceExists(targetParentId);
    const oldRow = this.db.prepare("SELECT parent_id FROM spaces WHERE id = ?").get(spaceId) as
      | { parent_id: string | null }
      | undefined;
    const oldParentId = oldRow?.parent_id ?? null;
    this.transaction(() => {
      if (targetParentId === spaceId) throw new Error("不能把空间移动到其自身之下（cycle）");
      if (targetParentId !== null && this.collectSpaceDescendants(spaceId).has(targetParentId)) {
        throw new Error("不能把空间移动到其子孙空间之下（cycle）");
      }
      // P1-2 DB 双层防御：已归档（effective）不可作为 source/target，IPC 直调不可绕过 UI
      if (this.isSpaceEffectiveArchived(spaceId)) throw new Error("已归档空间不能移动");
      if (targetParentId !== null && this.isSpaceEffectiveArchived(targetParentId)) throw new Error("不能移动到已归档空间");
      if (input.targetSortOrder !== undefined) {
        this.db
          .prepare("UPDATE spaces SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?")
          .run(targetParentId, input.targetSortOrder, Date.now(), spaceId);
        // P1-5 显式 targetSortOrder 若与同父兄弟重复，则统一 renumber 保证唯一且重启稳定
        const dup = this.db
          .prepare(
            targetParentId == null
              ? "SELECT 1 FROM spaces WHERE parent_id IS NULL AND id != ? AND sort_order = ? LIMIT 1"
              : "SELECT 1 FROM spaces WHERE parent_id = ? AND id != ? AND sort_order = ? LIMIT 1",
          )
          .get(
            ...(targetParentId == null
              ? [spaceId, input.targetSortOrder]
              : [targetParentId, spaceId, input.targetSortOrder]),
          );
        if (dup) this.renumberSpaces(targetParentId);
        if (oldParentId !== targetParentId) this.renumberSpaces(oldParentId);
        return;
      }
      if (input.targetIndex !== undefined) {
        const siblings = (targetParentId == null
          ? (this.db
              .prepare(
                "SELECT id FROM spaces WHERE parent_id IS NULL ORDER BY sort_order ASC, created_at ASC, id ASC",
              )
              .all() as Array<{ id: string }>)
          : (this.db
              .prepare(
                "SELECT id FROM spaces WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC",
              )
              .all(targetParentId) as Array<{ id: string }>));
        const filtered = siblings.map((r) => r.id).filter((id) => id !== spaceId);
        const clamped = Math.max(0, Math.min(input.targetIndex, filtered.length));
        const newOrder = [...filtered.slice(0, clamped), spaceId, ...filtered.slice(clamped)];
        const update = this.db.prepare("UPDATE spaces SET sort_order = ?, updated_at = ?, parent_id = ? WHERE id = ?");
        const now = Date.now();
        newOrder.forEach((id, idx) => {
          const sort = (idx + 1) * 1000;
          update.run(sort, now, targetParentId, id);
        });
        if (oldParentId !== targetParentId) this.renumberSpaces(oldParentId);
        return;
      }
      const sortOrder = this.nextChildSortOrder(targetParentId);
      this.db
        .prepare("UPDATE spaces SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?")
        .run(targetParentId, sortOrder, Date.now(), spaceId);
      if (oldParentId !== targetParentId) this.renumberSpaces(oldParentId);
    });
  }

  /**
   * 同父下追加排序键（子空间）：MAX(sort_order)+1000；父为 null = 根层。
   * SQLite 单写事务语义（WAL + 单连接）：同一事务内 MAX+1000 与后续 INSERT/UPDATE 原子串行，
   * 不会并发交错（Electron 主进程单连接串行执行）。若瞬时并发创建导致同值冲突，
   * 后续 renumberSpaces / moveSpace 的显式去重会重排为 1000 步进，重启稳定；无需改 schema。
   */
  private nextChildSortOrder(parentId: string | null): number {
    const row =
      parentId == null
        ? (this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM spaces WHERE parent_id IS NULL").get() as { m: number })
        : (this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM spaces WHERE parent_id = ?").get(parentId) as { m: number });
    return row.m + 1000;
  }

  /** 同空间下追加排序键（任务）：MAX(space_sort_order)+1000；单写事务内原子，冲突时 renumberTasks 兜底（见 nextChildSortOrder 注释）。 */
  private nextTaskSortOrder(spaceId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(space_sort_order), 0) AS m FROM tasks WHERE space_id = ?")
      .get(spaceId) as { m: number };
    return row.m + 1000;
  }

  /** 同父下全量重排：按当前顺序重写为 1000,2000… 消除 0、消除空隙，重启稳定 */
  renumberSpaces(parentId: string | null): void {
    const rows =
      parentId == null
        ? (this.db
            .prepare("SELECT id FROM spaces WHERE parent_id IS NULL ORDER BY sort_order ASC, created_at ASC, id ASC")
            .all() as Array<{ id: string }>)
        : (this.db
            .prepare("SELECT id FROM spaces WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC")
            .all(parentId) as Array<{ id: string }>);
    const update = this.db.prepare("UPDATE spaces SET sort_order = ? WHERE id = ?");
    rows.forEach((r, idx) => update.run((idx + 1) * 1000, r.id));
  }

  /**
   * 同任务同父重排：显式值 1000 步进重写，消除 0/空隙。
   * 冻结语义（ADR-2）：DB 侧 tie-break 用 updated_at ASC（旧在前）与 selector 展示的 updated_at DESC（新在前）有意不同——
   * 前者为持久化分配位置的稳定顺序（老任务先占小 slot），后者为侧栏展示时对隐式任务（space_sort_order=0）的实时排序；
   * 显式任务（>0）以 space_sort_order 为主，ASC 的选择不影响已显式排序的展示，仅为未显式时的分配锚点。
   * 冻结后不改 DB ORDER BY，仅补注释；相关保障见 workspace-tree-test §20/25。
   */
  renumberTasks(spaceId: string): void {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE space_id = ? ORDER BY space_sort_order ASC, updated_at ASC, id ASC")
      .all(spaceId) as Array<{ id: string }>;
    const update = this.db.prepare("UPDATE tasks SET space_sort_order = ? WHERE id = ?");
    rows.forEach((r, idx) => update.run((idx + 1) * 1000, r.id));
  }

  /**
   * 任务跨空间移动/重排序（V2 tree）。targetSpaceId：null = 解绑（归入「任务」分组）。
   * 同一事务内校验空间存在并持久化 space_sort_order（显式排序，不参与 updatedAt 重排）。
   * 支持 targetIndex（同空间内重排）/ targetSortOrder（显式值）；插入后同空间重排 1000,2000…
   */
  moveTaskInWorkspaceTree(input: {
    taskId: string;
    targetSpaceId: string | null;
    targetIndex?: number;
    targetSortOrder?: number;
  }): void {
    const { taskId, targetSpaceId } = input;
    const row = this.db.prepare("SELECT space_id FROM tasks WHERE id = ?").get(taskId) as
      | { space_id: string | null }
      | undefined;
    if (!row) throw new Error(`任务不存在：${taskId}`);
    const oldSpaceId = row.space_id ?? null;
    if (targetSpaceId) this.assertSpaceExists(targetSpaceId);
    this.transaction(() => {
      // P1-2 DB 双层防御：已归档任务/目标空间不可移动，IPC 直调不可绕过 UI
      if (this.isTaskEffectiveArchived(taskId)) throw new Error("已归档任务不能移动");
      if (targetSpaceId !== null && this.isSpaceEffectiveArchived(targetSpaceId)) throw new Error("不能移动到已归档空间");
      if (input.targetSortOrder !== undefined) {
        this.db
          .prepare("UPDATE tasks SET space_id = ?, space_sort_order = ? WHERE id = ?")
          .run(targetSpaceId, input.targetSortOrder, taskId);
        // P1-5 显式 sortOrder 碰撞检测 → renumber 新父
        if (targetSpaceId !== null) {
          const dupTask = this.db
            .prepare("SELECT 1 FROM tasks WHERE space_id = ? AND id != ? AND space_sort_order = ? LIMIT 1")
            .get(targetSpaceId, taskId, input.targetSortOrder);
          if (dupTask) this.renumberTasks(targetSpaceId);
        }
        if (oldSpaceId !== targetSpaceId && oldSpaceId !== null) this.renumberTasks(oldSpaceId);
        return;
      }
      if (input.targetIndex !== undefined) {
        const siblings = this.db
          .prepare(`SELECT id FROM tasks WHERE space_id IS ?
            ORDER BY is_favorited DESC, CASE WHEN space_sort_order > 0 THEN 0 ELSE 1 END,
            space_sort_order ASC, updated_at DESC, id ASC`)
          .all(targetSpaceId) as Array<{ id: string }>;
        const filtered = siblings.map((r) => r.id).filter((id) => id !== taskId);
        const clamped = Math.max(0, Math.min(input.targetIndex, filtered.length));
        const newOrder = [...filtered.slice(0, clamped), taskId, ...filtered.slice(clamped)];
        const update = this.db.prepare("UPDATE tasks SET space_sort_order = ?, space_id = ? WHERE id = ?");
        newOrder.forEach((id, idx) => {
          const sort = (idx + 1) * 1000;
          update.run(sort, targetSpaceId, id);
        });
        if (oldSpaceId !== targetSpaceId && oldSpaceId !== null) this.renumberTasks(oldSpaceId);
        return;
      }
      if (targetSpaceId == null) {
        this.db.prepare("UPDATE tasks SET space_id = NULL, space_sort_order = 0 WHERE id = ?").run(taskId);
        if (oldSpaceId !== null) this.renumberTasks(oldSpaceId);
        return;
      }
      const sortOrder = this.nextTaskSortOrder(targetSpaceId);
      this.db
        .prepare("UPDATE tasks SET space_id = ?, space_sort_order = ? WHERE id = ?")
        .run(targetSpaceId, sortOrder, taskId);
      if (oldSpaceId !== targetSpaceId && oldSpaceId !== null) this.renumberTasks(oldSpaceId);
    });
  }

  /**
   * V2 Path 解析规则（数据层，不含 filesystem 存在性判断——由调用方/AgentService 决定）：
   * 当前空间显式 path → 最近拥有 path 的祖先 → null（调用方随后回退 isolated task-workspace）。
   * 层级与文件系统 containment 解耦：子空间可绑父 path 之外的独立目录。
   */
  findNearestSpacePath(spaceId: string): string | null {
    const seen = new Set<string>();
    let cursor: string | null = spaceId;
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const space = this.getSpace(cursor);
      if (!space) break;
      const raw = space.path?.trim();
      if (raw) return raw;
      cursor = space.parentId ?? null;
    }
    return null;
  }

  /**
   * V2 Path 解析（含目录有效性）：当前空间显式有效 path → 最近祖先有效 path → null（隔离回退）。
   * 只读绑定盘点允许路径尚不存在；执行必须传 requireExisting，失效绑定抛错而不回退。
   * 层级与文件系统 containment 解耦：子空间可绑父 path 之外的独立目录，执行边界仍由
   * TaskExecutionWorkspace / workspace guard 以解析后的 taskRoot 为准，不新增权限继承。
   */
  resolveWorkspaceExecutionPath(spaceId: string | null | undefined, options: { requireExisting?: boolean } = {}): string | null {
    if (!spaceId) return null;
    const seen = new Set<string>();
    let cursor: string | null = spaceId;
    while (cursor) {
      if (seen.has(cursor)) {
        if (options.requireExisting) throw new WorkspacePathError(cursor, undefined, "workspace-binding-cycle");
        break;
      }
      seen.add(cursor);
      const space = this.getSpace(cursor);
      if (!space) {
        if (options.requireExisting) throw new WorkspacePathError(cursor, undefined, "workspace-binding-missing");
        break;
      }
      const raw = space.path?.trim();
      if (!raw) {
        cursor = space.parentId ?? null;
        continue;
      }
      const abs = resolve(raw);
      if (options.requireExisting) {
        if (!isAbsolute(raw)) throw new WorkspacePathError(cursor, raw, "workspace-path-invalid");
        try {
          if (!statSync(abs).isDirectory()) throw new WorkspacePathError(cursor, abs, "workspace-path-invalid");
        } catch (error) {
          if (error instanceof WorkspacePathError) throw error;
          const code = (error as NodeJS.ErrnoException).code;
          throw new WorkspacePathError(cursor, abs, code === "ENOENT" ? "workspace-path-missing" : "workspace-path-invalid");
        }
        return abs;
      }
      if (existsSync(abs)) {
        try {
          if (!statSync(abs).isDirectory()) {
            cursor = space.parentId ?? null;
            continue;
          }
        } catch {
          cursor = space.parentId ?? null;
          continue;
        }
      }
      return abs;
    }
    return null;
  }

  /** V2 Archive：effective = 自身 explicit archived ∨ 任一祖先 archived（不递归写后代）。 */
  isSpaceEffectiveArchived(spaceId: string): boolean {
    const seen = new Set<string>();
    let cursor: string | null = spaceId;
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = this.db
        .prepare("SELECT archived, parent_id FROM spaces WHERE id = ?")
        .get(cursor) as { archived: number; parent_id: string | null } | undefined;
      if (!row) break;
      if (row.archived) return true;
      cursor = row.parent_id;
    }
    return false;
  }

  /** Task effective archived = 自身 archived ∨ 所属 Workspace effectiveArchived */
  isTaskEffectiveArchived(taskId: string): boolean {
    const task = this.db
      .prepare("SELECT archived, space_id FROM tasks WHERE id = ?")
      .get(taskId) as { archived: number; space_id: string | null } | undefined;
    if (!task) return false;
    if (task.archived) return true;
    if (!task.space_id) return false;
    return this.isSpaceEffectiveArchived(task.space_id);
  }

  listTasks(): TaskDto[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, space_id, project_id, status, updated_at, session_file, cwd, welcome_mode,
                model_id, permission_mode, archived, expert_id, mode_preset_id, start_at, due_at,
                space_sort_order, is_favorited, external_agent_pin_json, done_acked_at
         FROM tasks ORDER BY updated_at DESC`,
      )
      .all() as TaskRow[];
    return this.projectTaskRows(rows);
  }

  /** Batch readers keep list projection at one query per relation regardless of task count. */
  private projectTaskRows(rows: readonly TaskRow[]): TaskDto[] {
    const bindings = this.expertBindingBatchReader?.(rows.map((row) => row.id));
    return rows.map((row) => this.mapTaskRow(row, bindings
      ? bindings.get(row.id) ?? null
      : this.expertBindingReader?.(row.id)));
  }

  /**
   * 产品/UI 可见任务：保留正常与显式归档任务，但排除已进入安全回收区（trashed）的任务。
   * trashed 任务行会保留至 purge，仅用于恢复/审计，不应在重启后重新出现在归档管理或任务列表。
   */
  listNonTrashedTasks(): TaskDto[] {
    const trashedIds = new Set(
      this.listTaskExecutionWorkspaceStates({ state: "trashed" }).map((row) => row.taskId),
    );
    if (trashedIds.size === 0) return this.listTasks();
    return this.listTasks().filter((task) => !trashedIds.has(task.id));
  }

  /** 按 id 查询任务；不存在返回 undefined（P0 §6：主进程权威 cwd 读回） */
  getTask(taskId: string): TaskDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, title, space_id, project_id, status, updated_at, session_file, cwd, welcome_mode,
                model_id, permission_mode, archived, expert_id, mode_preset_id, start_at, due_at,
                space_sort_order, is_favorited, external_agent_pin_json, done_acked_at
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;
    return row ? this.mapTaskRow(row, this.expertBindingReader?.(row.id)) : undefined;
  }

  private mapTaskRow(r: TaskRow, binding?: import("../../shared/expert-binding").TaskExpertBindingDto | null): TaskDto {
    return {
      expertBinding: binding ?? undefined,
      id: r.id,
      title: r.title,
      spaceId: r.space_id ?? undefined,
      projectId: r.project_id ?? undefined,
      status: r.status ?? undefined,
      updatedAt: r.updated_at,
      sessionFile: r.session_file ?? undefined,
      cwd: r.cwd ?? undefined,
      welcomeMode: normalizeWelcomeMode(r.welcome_mode) ?? undefined,
      executionBackend: r.welcome_mode === "general" ? "pi-durable" : "pi",
      modelId: r.model_id ?? undefined,
      permissionMode: (r.permission_mode as TaskDto["permissionMode"] | null) ?? undefined,
      archived: Boolean(r.archived),
      expertId: r.expert_id ?? undefined,
      modePresetId: r.mode_preset_id ?? undefined,
      startAt: r.start_at ?? undefined,
      dueAt: r.due_at ?? undefined,
      spaceSortOrder: r.space_sort_order,
      isFavorited: Boolean(r.is_favorited),
      externalAgentPin: parseExternalAgentPin(r.external_agent_pin_json),
      doneAckedAt: r.done_acked_at ?? null,
    };
  }

  /**
   * 语义纠偏收口（2026-08）：FS 目录整体 rename（projects → task-workspaces）成功后，
   * 一次性把 DB 中仍指向旧根的绝对路径重绑到新根，使升级后 UI 直接可用，
   * 无需等待首次 Agent 交互的懒重绑。仅由 index.ts 在迁移结果 migrated=true 时调用。
   *
   * 安全约束：
   *  - 只重写"明确位于 legacy 根之下"的路径（mapLegacyRootPath 词法边界，
   *    不会误改路径中间同名片段；win32 大小写不敏感）；
   *  - 旧路径仍存在（内容未随迁移移动，如新旧并存 / legacy 回退）时跳过该行；
   *  - 不触碰 updated_at（属数据修复而非用户操作，避免侧栏排序抖动）；
   *  - 幂等：重复调用在旧根前缀已无命中时为零操作；
   *  - 保留 Agent 懒重绑（bindTaskExecutionWorkspaceCwd）与 resolveTrashPath 兜底。
   */
  rebindLegacyTaskWorkspacePaths(
    legacyWorkspacesRoot: string,
    newWorkspacesRoot: string,
    legacyTrashRoot: string,
    newTrashRoot: string,
  ): { cwds: number; trashPaths: number } {
    let cwds = 0;
    const tasks = this.db
      .prepare(`SELECT id, cwd FROM tasks`)
      .all() as Array<{ id: string; cwd: string | null }>;
    for (const task of tasks) {
      if (!task.cwd) continue;
      const mapped = mapLegacyRootPath(legacyWorkspacesRoot, newWorkspacesRoot, task.cwd);
      if (mapped === null) continue;
      if (existsSync(task.cwd)) continue; // 旧路径仍存在：内容未随迁移移动，不得重写
      this.db.prepare(`UPDATE tasks SET cwd = ? WHERE id = ?`).run(mapped, task.id);
      cwds++;
    }
    let trashPaths = 0;
    const states = this.db
      .prepare(`SELECT task_id, trash_path FROM task_execution_workspace_state`)
      .all() as Array<{ task_id: string; trash_path: string | null }>;
    for (const state of states) {
      if (!state.trash_path) continue;
      const mapped = mapLegacyRootPath(legacyTrashRoot, newTrashRoot, state.trash_path);
      if (mapped === null) continue;
      if (existsSync(state.trash_path)) continue;
      this.db
        .prepare(`UPDATE task_execution_workspace_state SET trash_path = ? WHERE task_id = ?`)
        .run(mapped, state.task_id);
      trashPaths++;
    }
    return { cwds, trashPaths };
  }

  /**
   * 主进程权威 cwd 持久化（P0 §6.2）：只允许更新 cwd/updated_at，
   * 绝不触碰 title/session_file/space_id/model/permission/archived 等字段。
   * 新任务（Renderer 尚未 upsert）也能建立最小行；ON CONFLICT 只更新 cwd+updated_at。
   */
  bindTaskExecutionWorkspaceCwd(taskId: string, cwd: string): void {
    // 仅在新插入时给占位标题；已有行绝不覆盖 title（自动化任务会先 upsert 真实名称）
    const existing = this.db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as
      | { title: string }
      | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE tasks SET cwd = ?, updated_at = ? WHERE id = ?`)
        .run(cwd, Date.now(), taskId);
      return;
    }
    const title = taskId.startsWith("gw-")
      ? "助理消息"
      : taskId.startsWith("cron-")
        ? "定时任务"
        : "新任务";
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, updated_at, cwd)
         VALUES (@id, @title, @updatedAt, @cwd)`,
      )
      .run({ id: taskId, title, updatedAt: Date.now(), cwd });
  }

  upsertTask(task: TaskDto): void {
    if (isGatewayBotTaskId(task.id)) task = { ...task, welcomeMode: "general", modePresetId: "native" };
    // UI 仍可能带 mock/遗留 spaceId；spaces 表无对应行时先解析占位，避免 FOREIGN KEY 失败
    const hasSpaceId = task.spaceId !== undefined;
    const hasProjectId = task.projectId !== undefined;
    let spaceId = task.spaceId ?? null;
    if (spaceId) {
      const exists = this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(spaceId);
      if (!exists) {
        spaceId = this.resolveTaskSpaceId(spaceId, task.cwd);
      }
    }
    const prev = this.db
      .prepare(
        `SELECT title, space_id, project_id, status, session_file, cwd, welcome_mode, model_id,
                permission_mode, expert_id, mode_preset_id, start_at, due_at,
                space_sort_order, is_favorited, external_agent_pin_json, done_acked_at FROM tasks WHERE id = ?`,
      )
      .get(task.id) as
      | {
          title: string;
          space_id: string | null;
          project_id: string | null;
          status: string | null;
          session_file: string | null;
          cwd: string | null;
          welcome_mode: string | null;
          model_id: string | null;
          permission_mode: string | null;
          expert_id: string | null;
          mode_preset_id: string | null;
          start_at: number | null;
          due_at: number | null;
          space_sort_order: number;
          is_favorited: number;
          external_agent_pin_json: string | null;
          done_acked_at: number | null;
        }
      | undefined;

    const projectId = task.projectId ?? null;
    if (prev?.welcome_mode === "general" && task.welcomeMode && task.welcomeMode !== "general") {
      throw new Error("通用任务的 Durable 后端已固定，请创建新任务以选择其他模式");
    }
    if (prev?.session_file && task.welcomeMode === "general") {
      throw new Error("旧 Pi 会话不能转换为 Durable 会话，请创建通用任务");
    }
    if (hasProjectId && projectId) {
      const project = this.db
        .prepare("SELECT archived FROM projects WHERE id = ?")
        .get(projectId) as { archived: number } | undefined;
      if (!project) throw new Error(`项目不存在：${projectId}`);
      // Archive is a binding gate, not a runtime kill switch: an already-bound
      // Task may keep writing its unchanged id and continues to resolve context.
      if (project.archived && prev?.project_id !== projectId) {
        throw new Error("归档项目不能绑定新任务；请先恢复项目");
      }
    }

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, space_id, project_id, status, updated_at, session_file, cwd, welcome_mode,
                            model_id, permission_mode, expert_id, mode_preset_id, start_at, due_at,
                            space_sort_order, is_favorited, external_agent_pin_json, done_acked_at)
         VALUES (@id, @title, @spaceId, @projectId, @status, @updatedAt, @sessionFile, @cwd, @welcomeMode,
                 @modelId, @permissionMode, @expertId, @modePresetId, @startAt, @dueAt,
                 @spaceSortOrder, @isFavorited, @externalAgentPinJson, @doneAckedAt)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           space_id = excluded.space_id,
           project_id = excluded.project_id,
           status = excluded.status,
           updated_at = excluded.updated_at,
           session_file = excluded.session_file,
           cwd = excluded.cwd,
           welcome_mode = excluded.welcome_mode,
           model_id = excluded.model_id,
           permission_mode = excluded.permission_mode,
           expert_id = excluded.expert_id,
           mode_preset_id = excluded.mode_preset_id,
           start_at = excluded.start_at,
           due_at = excluded.due_at,
           space_sort_order = excluded.space_sort_order,
           is_favorited = excluded.is_favorited,
           external_agent_pin_json = excluded.external_agent_pin_json,
           done_acked_at = excluded.done_acked_at`,
      )
      .run({
        id: task.id,
        title: task.title || prev?.title || "任务",
        // null = 明确解绑；未提供 spaceId 字段时才保留旧绑定。
        spaceId: hasSpaceId ? spaceId : (prev?.space_id ?? null),
        // null = 明确解绑；undefined = 保留旧 Project 绑定。
        projectId: hasProjectId ? projectId : (prev?.project_id ?? null),
        status: task.status ?? prev?.status ?? null,
        updatedAt: task.updatedAt,
        // 未传时保留旧值，避免 UI 重命名/发消息把 session_file 清掉导致重启无法恢复
        sessionFile: task.sessionFile ?? prev?.session_file ?? null,
        cwd: task.cwd ?? prev?.cwd ?? null,
        welcomeMode: task.welcomeMode ?? prev?.welcome_mode ?? null,
        modelId: task.modelId ?? prev?.model_id ?? null,
        permissionMode: task.permissionMode ?? prev?.permission_mode ?? null,
        expertId: task.expertId ?? prev?.expert_id ?? null,
        // null = 明确清除（如非当前场景任务）；未提供字段时保留旧值
        modePresetId: task.modePresetId !== undefined ? task.modePresetId : (prev?.mode_preset_id ?? null),
        startAt: task.startAt !== undefined ? task.startAt : (prev?.start_at ?? null),
        dueAt: task.dueAt !== undefined ? task.dueAt : (prev?.due_at ?? null),
        // V2：显式排序字段，未提供保留旧值（0 = 未显式排序，不参与 updatedAt 重排）。
        spaceSortOrder: task.spaceSortOrder !== undefined ? task.spaceSortOrder : (prev?.space_sort_order ?? 0),
        // 固定/收藏持久化（修复：is_favorited 列早已存在但 upsertTask 从未写入）。
        // 未提供保留旧值；不参与 Workspace Tree 权威排序。
        isFavorited: task.isFavorited !== undefined ? (task.isFavorited ? 1 : 0) : (prev?.is_favorited ?? 0),
        // null = 明确解除固定；未提供字段时保留旧值（发消息/重命名不丢 pin）
        externalAgentPinJson: task.externalAgentPin !== undefined
          ? (task.externalAgentPin ? JSON.stringify(task.externalAgentPin) : null)
          : (prev?.external_agent_pin_json ?? null),
        // 绿点确认水位：null = 明确重置为未确认；未提供字段时保留旧值
        // （普通 upsert 不得把已确认状态退回未确认，否则重启/发消息会让绿点复活）。
        doneAckedAt: task.doneAckedAt !== undefined ? task.doneAckedAt : (prev?.done_acked_at ?? null),
      });
  }

  deleteTask(id: string): void {
    this.db.transaction(() => {
      // L0 完整原文随任务 hard purge 删除，避免任务删除后仍残留完整聊天副本。
      // 但 L1 的 conversation evidence 是长期记忆的审计链：删除 L0 前补一份有界证据摘录，
      // evidence 行保留，使长期 L1 仍可判断来源；ref_id 可以指向已删除的历史 L0 id。
      this.db.prepare(
        `UPDATE memory_evidence
         SET excerpt = COALESCE(NULLIF(excerpt,''), (
           SELECT substr('用户：' || t.user_text || char(10) || '助手：' || t.assistant_text, 1, 1200)
           FROM memory_turns t
           WHERE t.id = memory_evidence.ref_id
         ))
         WHERE evidence_kind='conversation'
           AND ref_id IN (SELECT id FROM memory_turns WHERE task_id=?)`,
      ).run(id);
      this.db.prepare(`DELETE FROM memory_turns WHERE task_id = ?`).run(id);
      this.db.prepare(`DELETE FROM memory_pipeline_state WHERE task_id = ?`).run(id);
      this.db.prepare(`DELETE FROM memory_skill_effectiveness WHERE task_id = ?`).run(id);
      this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      // task_write_grants 带 ON DELETE CASCADE，删除任务时授权随行清理（无需手动）。
      // 资料库任务引用同样随任务删除清理（task_library_references 无 task FK，手动清理）。
      this.db.prepare(`DELETE FROM task_library_references WHERE task_id = ?`).run(id);
      // conversation_branches 的 child_task_id 带 ON DELETE CASCADE，child 删除自动清理；
      // parent/root 行保留（血缘可审计，§5.1）。
    })();
  }

  // ---------- 对话分支（conversation_branches，实施规划 §5） ----------

  /**
   * 原子创建 child Task + 血缘关系 + 复制的资料库引用（§10.1 commit point）。
   * 调用方必须已完成：工作区准备、session 物化验证、标题防重与 requestId 检查。
   */
  createConversationBranchTask(params: {
    childTaskId: string;
    parentTaskId: string;
    rootTaskId: string;
    parentTitleSnapshot: string;
    sourceSessionFile: string;
    sourceLeafEntryId: string;
    sourceUserMessageIndex: number;
    requestId: string;
    position: ConversationBranchPosition;
    workspaceStrategy: ConversationBranchWorkspaceStrategy;
    createdAt: number;
    task: TaskDto;
  }): void {
    const p = params;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, space_id, project_id, status, updated_at, session_file, cwd, welcome_mode,
                              model_id, permission_mode, expert_id, mode_preset_id, start_at, due_at,
                              space_sort_order, is_favorited)
           VALUES (@id, @title, @spaceId, @projectId, @status, @updatedAt, @sessionFile, @cwd, @welcomeMode,
                   @modelId, @permissionMode, @expertId, @modePresetId, @startAt, @dueAt,
                   @spaceSortOrder, @isFavorited)`,
        )
        .run({
          id: p.childTaskId,
          title: p.task.title,
          spaceId: p.task.spaceId ?? null,
          projectId: p.task.projectId ?? null,
          status: p.task.status ?? null,
          updatedAt: p.task.updatedAt,
          sessionFile: p.task.sessionFile ?? null,
          cwd: p.task.cwd ?? null,
          welcomeMode: p.task.welcomeMode ?? null,
          modelId: p.task.modelId ?? null,
          permissionMode: p.task.permissionMode ?? null,
          expertId: p.task.expertId ?? null,
          modePresetId: p.task.modePresetId ?? null,
          startAt: null,
          dueAt: null,
          spaceSortOrder: 0,
          isFavorited: 0,
        });
      this.db
        .prepare(
          `INSERT INTO conversation_branches (
             child_task_id, parent_task_id, root_task_id, parent_title_snapshot,
             source_session_file, source_leaf_entry_id, source_user_message_index,
             request_id, source_position, workspace_strategy, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.childTaskId,
          p.parentTaskId,
          p.rootTaskId,
          p.parentTitleSnapshot,
          p.sourceSessionFile,
          p.sourceLeafEntryId,
          p.sourceUserMessageIndex,
          p.requestId,
          p.position,
          p.workspaceStrategy,
          p.createdAt,
        );
      // 只复制引用关系，不复制 Library 内容（§9.4）
      this.db
        .prepare(
          `INSERT INTO task_library_references (task_id, item_id, project_id, added_at, added_by)
           SELECT @childTaskId, item_id, project_id, added_at, 'conversation-branch'
             FROM task_library_references WHERE task_id = @parentTaskId
             AND item_id IN (SELECT id FROM library_items)`,
        )
        .run({ childTaskId: p.childTaskId, parentTaskId: p.parentTaskId });
    })();
  }

  /** requestId 幂等查询：已存在返回 child 血缘行（§5.4） */
  findConversationBranchByRequestId(
    requestId: string,
  ): ConversationBranchInfoDto | undefined {
    if (!requestId) return undefined;
    const row = this.db
      .prepare(
        `SELECT b.child_task_id, b.parent_task_id, b.root_task_id, b.parent_title_snapshot,
                t.title AS child_title,
                b.source_user_message_index, b.source_position, b.workspace_strategy, b.created_at,
                EXISTS(SELECT 1 FROM tasks p WHERE p.id = b.parent_task_id) AS parent_exists
         FROM conversation_branches b
         LEFT JOIN tasks t ON t.id = b.child_task_id
         WHERE b.request_id = ?`,
      )
      .get(requestId) as BranchRow | undefined;
    return row ? this.mapBranchRow(row) : undefined;
  }

  /** 按 child task 查询血缘信息；父任务被删后 parentExists=false（§5.1） */
  getConversationBranchInfo(
    childTaskId: string,
  ): ConversationBranchInfoDto | undefined {
    const row = this.db
      .prepare(
        `SELECT b.child_task_id, b.parent_task_id, b.root_task_id, b.parent_title_snapshot,
                t.title AS child_title,
                b.source_user_message_index, b.source_position, b.workspace_strategy, b.created_at,
                EXISTS(SELECT 1 FROM tasks p WHERE p.id = b.parent_task_id) AS parent_exists
         FROM conversation_branches b
         LEFT JOIN tasks t ON t.id = b.child_task_id
         WHERE b.child_task_id = ?`,
      )
      .get(childTaskId) as BranchRow | undefined;
    return row ? this.mapBranchRow(row) : undefined;
  }

  /**
   * 直接子分支列表（按创建时间升序；parent 删除后仍返回历史血缘）。
   * 已进入安全回收区（task_execution_workspace_state.state='trashed'）的 child
   * 不返回——用户已删除的任务不应再出现在「查看分支」列表（侧栏同样隐藏）。
   */
  listConversationBranchChildren(
    parentTaskId: string,
  ): ConversationBranchInfoDto[] {
    const rows = this.db
      .prepare(
        `SELECT b.child_task_id, b.parent_task_id, b.root_task_id, b.parent_title_snapshot,
                t.title AS child_title,
                b.source_user_message_index, b.source_position, b.workspace_strategy, b.created_at,
                EXISTS(SELECT 1 FROM tasks p WHERE p.id = b.parent_task_id) AS parent_exists
         FROM conversation_branches b
         LEFT JOIN tasks t ON t.id = b.child_task_id
         WHERE b.parent_task_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_workspace_state s
             WHERE s.task_id = b.child_task_id AND s.state = 'trashed'
           )
         ORDER BY b.created_at ASC`,
      )
      .all(parentTaskId) as BranchRow[];
    return rows.map((row) => this.mapBranchRow(row));
  }

  private mapBranchRow(row: BranchRow): ConversationBranchInfoDto {
    return {
      childTaskId: row.child_task_id,
      parentTaskId: row.parent_task_id,
      rootTaskId: row.root_task_id,
      parentTitle: row.parent_title_snapshot,
      childTitle: row.child_title ?? undefined,
      sourceUserMessageIndex: row.source_user_message_index,
      sourcePosition: row.source_position,
      workspaceStrategy: row.workspace_strategy,
      createdAt: row.created_at,
      parentExists: Boolean(row.parent_exists),
    };
  }

  // ---------- 任务级外部写授权（task_write_grants） ----------

  listTaskWriteGrants(taskId: string): TaskWriteGrantRow[] {
    return this.db
      .prepare(`SELECT task_id, path, created_at FROM task_write_grants WHERE task_id = ? ORDER BY created_at DESC`)
      .all(taskId) as TaskWriteGrantRow[];
  }

  /** 幂等写入任务级目录写 grant（调用方负责 canonicalize 路径） */
  addTaskWriteGrant(taskId: string, path: string): void {
    this.db
      .prepare(
        `INSERT INTO task_write_grants (task_id, path, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id, path) DO NOTHING`,
      )
      .run(taskId, path, Date.now());
  }

  deleteTaskWriteGrant(taskId: string, path: string): boolean {
    return this.db.prepare(`DELETE FROM task_write_grants WHERE task_id = ? AND path = ?`).run(taskId, path).changes > 0;
  }

  /** 会话绑定/解除专家（不触碰其他字段） */
  setTaskExpertId(id: string, expertId: string | null): void {
    this.db
      .prepare("UPDATE tasks SET expert_id = ?, updated_at = ? WHERE id = ?")
      .run(expertId, Date.now(), id);
  }

  /**
   * 归档 / 恢复任务。归档只做标记（侧栏隐藏），数据与会话文件保留，
   * 可在设置「归档管理」页恢复；彻底删除请用 deleteTask（P1.5 起为安全回收）。
   */
  archiveTask(id: string, archived: boolean): void {
    this.db
      .prepare("UPDATE tasks SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, Date.now(), id);
  }

  /**
   * 侧栏「已结束」绿点的确认水位：用户查看过该任务的结果 → 关闭绿点。
   * 只写 done_acked_at，**不触碰 updated_at**（读事件不是任务活动，不得让侧栏顺序/时间戳抖动）。
   * ackedAt 由渲染层给出（同一 now，便于乐观更新与持久化同戳）；缺省取当前时间。
   */
  ackTaskDone(id: string, ackedAt?: number): void {
    this.db
      .prepare("UPDATE tasks SET done_acked_at = ? WHERE id = ?")
      .run(ackedAt ?? Date.now(), id);
  }

  // ---------- P1.5 task_execution_workspace_state ----------

  getTaskExecutionWorkspaceState(taskId: string): TaskExecutionWorkspaceStateRow | undefined {
    const row = this.db
      .prepare(
        `SELECT task_id, directory_name, state, created_at, updated_at,
                trashed_at, purge_after, trash_path
         FROM task_execution_workspace_state WHERE task_id = ?`,
      )
      .get(taskId) as TaskExecutionWorkspaceStateSqlRow | undefined;
    return row ? mapTaskExecutionWorkspaceStateRow(row) : undefined;
  }

  listTaskExecutionWorkspaceStates(filter?: { state?: TaskExecutionWorkspaceLifecycleState }): TaskExecutionWorkspaceStateRow[] {
    if (filter?.state) {
      const rows = this.db
        .prepare(
          `SELECT task_id, directory_name, state, created_at, updated_at,
                  trashed_at, purge_after, trash_path
           FROM task_execution_workspace_state WHERE state = ? ORDER BY updated_at DESC`,
        )
        .all(filter.state) as TaskExecutionWorkspaceStateSqlRow[];
      return rows.map(mapTaskExecutionWorkspaceStateRow);
    }
    const rows = this.db
      .prepare(
        `SELECT task_id, directory_name, state, created_at, updated_at,
                trashed_at, purge_after, trash_path
         FROM task_execution_workspace_state ORDER BY updated_at DESC`,
      )
      .all() as TaskExecutionWorkspaceStateSqlRow[];
    return rows.map(mapTaskExecutionWorkspaceStateRow);
  }

  /**
   * upsert 任务执行工作区状态。不得清空无关字段以外的调用方未提供列时：
   * 传入的 partial 会合并已有行（新建则用默认）。
   */
  upsertTaskExecutionWorkspaceState(row: TaskExecutionWorkspaceStateRow): void {
    this.db
      .prepare(
        `INSERT INTO task_execution_workspace_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (@taskId, @directoryName, @state, @createdAt, @updatedAt, @trashedAt, @purgeAfter, @trashPath)
         ON CONFLICT(task_id) DO UPDATE SET
           directory_name = excluded.directory_name,
           state = excluded.state,
           updated_at = excluded.updated_at,
           trashed_at = excluded.trashed_at,
           purge_after = excluded.purge_after,
           trash_path = excluded.trash_path`,
      )
      .run({
        taskId: row.taskId,
        directoryName: row.directoryName,
        state: row.state,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        trashedAt: row.trashedAt ?? null,
        purgeAfter: row.purgeAfter ?? null,
        trashPath: row.trashPath ?? null,
      });
  }

  deleteTaskExecutionWorkspaceState(taskId: string): void {
    this.db.prepare("DELETE FROM task_execution_workspace_state WHERE task_id = ?").run(taskId);
  }

  /** 显式事务（生命周期 move + DB 双阶段） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** 写入任务上下文用量快照（prompt 结束时的真实值；重启后用于恢复 UI 显示） */
  setTaskContextUsage(
    taskId: string,
    usedTokens: number | null,
    contextWindow: number,
    cacheHitRate: number | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE tasks SET context_used_tokens = ?, context_window_tokens = ?, context_cache_hit_rate = ? WHERE id = ?",
      )
      .run(usedTokens ?? null, contextWindow, cacheHitRate, taskId);
  }

  /** 读取任务上下文用量快照；从未运行过或任务不存在返回 null */
  getTaskContextUsage(taskId: string): {
    usedTokens: number | null;
    contextWindow: number;
    cacheHitRate: number | null;
  } | null {
    const row = this.db
      .prepare(
        "SELECT context_used_tokens, context_window_tokens, context_cache_hit_rate FROM tasks WHERE id = ?",
      )
      .get(taskId) as
      | {
          context_used_tokens: number | null;
          context_window_tokens: number | null;
          context_cache_hit_rate: number | null;
        }
      | undefined;
    if (!row || row.context_used_tokens == null) return null;
    return {
      usedTokens: row.context_used_tokens,
      contextWindow: row.context_window_tokens || 128_000,
      cacheHitRate: row.context_cache_hit_rate,
    };
  }

  /**
   * 任务引用的 space_id 不存在时，解析一个可用的空间 id：
   * 优先按 cwd 路径 / 名称复用已有空间（避免静默造出同名空间）；
   * 确实无匹配时才占位创建，且名称自动去重（同名不同路径时加后缀）。
   */
  private resolveTaskSpaceId(requestedId: string, cwd?: string): string {
    const cwdNorm = cwd ? cwd.replace(/[\\/]+$/, "") : undefined;
    if (cwdNorm) {
      // 1) 已有空间路径与该任务 cwd 相同 → 直接复用
      const byPath = this.findSpaceByPath(cwdNorm);
      if (byPath) return byPath.id;
      const base = basename(cwdNorm) || requestedId;
      // 2) 已有同名空间（无 path，或 path 就是该目录）→ 复用；同名但路径不同 → 不复用，避免绑错空间
      const byName = this.findSpaceByName(base);
      if (byName && (!byName.path || byName.path.replace(/[\\/]+$/, "") === cwdNorm)) {
        return byName.id;
      }
      // 3) 占位创建，名称自动去重
      const name = this.uniqueSpaceName(base);
      this.upsertSpace({ id: requestedId, name, path: cwdNorm });
      return requestedId;
    }
    // 无 cwd：直接占位（名称与 id 相同，若恰好撞名则复用现有空间）
    const byName = this.findSpaceByName(requestedId);
    if (byName) return byName.id;
    this.upsertSpace({ id: requestedId, name: requestedId, path: undefined });
    return requestedId;
  }

  /** 生成与现有**根空间**不撞名（NOCASE）的名称："name" → "name (2)" → ... */
  private uniqueSpaceName(base: string): string {
    if (!this.findRootSpaceByName(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base} (${n})`;
      if (!this.findRootSpaceByName(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * 归档 / 恢复空间（V2 archive 语义）。
   * 只写空间自身 explicit archived；**不递归物理写后代空间或任务**的 archived。
   * effectiveArchived（自身 ∨ 任一祖先）由 computeEffectiveArchived / isSpaceEffectiveArchived
   * 在读取时计算（Phase2/3 的 Sidebar/Search 应用之）；父恢复后，其下曾显式归档的子空间保持归档。
   * 彻底删除请用 deleteSpace。
   */
  archiveSpace(id: string, archived: boolean): void {
    this.db
      .prepare("UPDATE spaces SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, Date.now(), id);
  }

  /** V2 archive：explicitArchived = space.archived（读取别名，语义单一来源）。 */
  explicitArchivedOf(id: string): boolean {
    return this.getSpace(id)?.archived === true;
  }

  /**
   * 普通空间删除的阻塞条件：直接子空间、仍可恢复/可见的任务或自有资料。
   * 已 trashed 的任务属于安全回收区残留，不应让一个视觉上已清空的空间永久无法删除。
   */
  hasSpaceDeleteBlockers(id: string): boolean {
    const hasChildren = this.db.prepare("SELECT 1 FROM spaces WHERE parent_id = ? LIMIT 1").get(id);
    const hasTasks = this.db
      .prepare(
        `SELECT 1
         FROM tasks t
         WHERE t.space_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_workspace_state s
             WHERE s.task_id = t.id AND s.state = 'trashed'
           )
         LIMIT 1`,
      )
      .get(id);
    return Boolean(hasChildren || hasTasks || this.hasWorkspaceOwnedMaterials(id));
  }

  hasWorkspaceOwnedMaterials(workspaceId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM library_spaces l
      JOIN library_items i ON i.space_id = l.id WHERE l.workspace_id = ? LIMIT 1`).get(workspaceId));
  }

  /** 工作空间绑定只引用资料；自有资料必须先清空/迁移，不能随导航节点丢失。 */
  private assertWorkspaceOwnedLibrariesEmpty(workspaceIds: Iterable<string>): void {
    const find = this.db.prepare(`SELECT w.name FROM library_spaces l
      JOIN library_items i ON i.space_id = l.id
      LEFT JOIN spaces w ON w.id = l.workspace_id
      WHERE l.workspace_id = ? LIMIT 1`);
    for (const id of workspaceIds) {
      const row = find.get(id) as { name: string | null } | undefined;
      if (row) throw new Error(`工作空间「${row.name ?? id}」仍有自有资料，请先迁移或清空资料后再删除`);
    }
  }

  /** 仅在已验证没有内容条目的同一删除事务中使用；同时清理其他工作空间的空库引用。 */
  private deleteEmptyWorkspaceOwnedLibraries(workspaceId: string): void {
    const rows = this.db.prepare("SELECT id FROM library_spaces WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ id: string }>;
    for (const { id } of rows) {
      this.deleteLibrarySpaceLinks(id);
      this.db.prepare("DELETE FROM library_spaces WHERE id = ?").run(id);
    }
  }

  /**
   * 删除空间（V2 安全语义：仅允许删除空叶子空间）。
   * 有直接子空间或非 trashed 直接任务 → 抛错（禁止隐式 cascade）；仅剩 trashed 任务时先解绑后删除。
   * 显式整树删除请用 deleteSpaceTree（危险操作，绝不暴露给普通 Sidebar）。
   */
  deleteSpace(id: string, opts?: { allowNonEmpty?: boolean }): void {
    if (opts?.allowNonEmpty) {
      console.warn("[AppDatabase] deleteSpace({allowNonEmpty:true}) 已废弃，请使用 deleteSpaceTree");
      return this.deleteSpaceTree(id);
    }
    if (this.hasSpaceDeleteBlockers(id)) {
      const space = this.db.prepare("SELECT name FROM spaces WHERE id = ?").get(id) as { name: string } | undefined;
      throw new Error(
        `空间「${space?.name ?? id}」尚有子空间、任务或自有资料，拒绝删除（请先迁移或清空资料）`,
      );
    }
    this.transaction(() => {
      this.assertWorkspaceOwnedLibrariesEmpty([id]);
      // deleteTask 是 30 天安全回收：task 行仍保留且原 space_id 也保留。
      // 若空间只剩这些 trashed 行，删除空间前先解绑，否则 FK 会拒绝 DELETE spaces。
      // 后续若从回收区恢复，该任务应成为独立任务，因为原空间已经不存在。
      this.db
        .prepare(
          `UPDATE tasks SET space_id = NULL, space_sort_order = 0
           WHERE space_id = ? AND id IN (SELECT task_id FROM task_execution_workspace_state WHERE state = 'trashed')`,
        )
        .run(id);
      this.deleteWorkspaceLibraryLinks(id);
      this.deleteEmptyWorkspaceOwnedLibraries(id);
      this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    });
  }

  /**
   * 显式整树删除（危险操作）：递归解绑子树内全部空间的任务归属、清理记忆、删除空间行（不删任务行）。
   * 仅由明确调用方（测试/管理脚本）使用，绝不暴露给普通 Sidebar IPC。
   */
  deleteSpaceTree(id: string): void {
    // Capture workspace ids for graph cleanup (transaction deletes rows before we can query)
    const subtree = this.collectSpaceDescendants(id);
    subtree.add(id);
    const wsIds = [...subtree];
    this.transaction(() => {
      this.assertWorkspaceOwnedLibrariesEmpty(subtree);
      const unbindTask = this.db.prepare("UPDATE tasks SET space_id = NULL, space_sort_order = 0 WHERE space_id = ?");
      const deleteSpaceStmt = this.db.prepare("DELETE FROM spaces WHERE id = ?");
      for (const sid of subtree) {
        unbindTask.run(sid);
        this.deleteWorkspaceLibraryLinks(sid);
        this.deleteEmptyWorkspaceOwnedLibraries(sid);
        deleteSpaceStmt.run(sid);
      }
    });
    // Post-transaction: cleanup work_graph_edges for deleted workspaces (best-effort)
    try {
      const delWs = this.db.prepare(`DELETE FROM work_graph_edges WHERE (from_type='workspace' AND from_id=?) OR (to_type='workspace' AND to_id=?)`);
      for (const sid of wsIds) delWs.run(sid, sid);
    } catch {}
  }

  /**
   * 一次性回填 spaces.sort_order（仅当列刚新增时）：复刻旧侧栏「最新任务在上」的稳定视图。
   * 按根空间 MAX(task.updated_at) DESC（空 → created_at）→ id 的确定性顺序分配 1000,2000…。
   * 纯迁移动作：此后显式排序不再因 updatedAt 变化被改写。
   */
  private backfillSpaceSortOrders(): void {
    const rows = this.db
      .prepare(
        `SELECT s.id,
                COALESCE(MAX(t.updated_at), s.created_at) AS ord
         FROM spaces s
         LEFT JOIN tasks t ON t.space_id = s.id
         GROUP BY s.id
         ORDER BY ord DESC, s.id`,
      )
      .all() as Array<{ id: string }>;
    const update = this.db.prepare("UPDATE spaces SET sort_order = ? WHERE id = ?");
    rows.forEach((row, index) => update.run((index + 1) * 1000, row.id));
  }

  getSoul(): SoulDto {
    const row = this.db
      .prepare("SELECT name, alias, persona FROM soul WHERE id = 1")
      .get() as {
      name: string;
      alias: string;
      persona: string;
    };
    return {
      name: row.name,
      alias: row.alias,
      persona: row.persona,
    };
  }

  updateSoul(partial: Partial<SoulDto>): SoulDto {
    const cur = this.getSoul();
    const next = { ...cur, ...partial };
    this.db
      .prepare("UPDATE soul SET name=@name, alias=@alias, persona=@persona WHERE id=1")
      .run(next);
    return next;
  }

  listCronJobs(): CronJobDto[] {
    const rows = this.db
      .prepare(`
        SELECT c.*,
               (SELECT COUNT(id) FROM cron_runs WHERE job_id = c.id AND status != 'skipped') AS run_count
        FROM cron_jobs c
        ORDER BY c.updated_at DESC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToCronJob(r));
  }

  upsertCronJob(job: CronJobDto): void {
    const executionJson = JSON.stringify({
      sourceTaskId: job.sourceTaskId,
      target: job.target,
      maxRuns: job.maxRuns,
      restartPolicy: job.restartPolicy,
    });
    this.db
      .prepare(
        `INSERT INTO cron_jobs (
           id, name, prompt, schedule_type, schedule_expr, timezone,
           space_id, cwd, enabled, created_at, updated_at, last_run_at,
           permission_mode, welcome_mode, model_id, expert_id, skill_ids_json, connector_ids_json,
           effective_from, effective_to, project_id, execution_json
         ) VALUES (
           @id, @name, @prompt, @scheduleType, @scheduleExpr, @timezone,
           @spaceId, @cwd, @enabled, @createdAt, @updatedAt, @lastRunAt,
           @permissionMode, @welcomeMode, @modelId, @expertId, @skillIdsJson, @connectorIdsJson,
           @effectiveFrom, @effectiveTo, @projectId, @executionJson
         )
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, prompt=excluded.prompt,
           schedule_type=excluded.schedule_type, schedule_expr=excluded.schedule_expr,
           timezone=excluded.timezone, space_id=excluded.space_id, cwd=excluded.cwd,
           enabled=excluded.enabled, updated_at=excluded.updated_at, last_run_at=excluded.last_run_at,
           permission_mode=excluded.permission_mode, welcome_mode=excluded.welcome_mode,
           model_id=excluded.model_id,
           expert_id=excluded.expert_id, skill_ids_json=excluded.skill_ids_json,
           connector_ids_json=excluded.connector_ids_json,
           effective_from=excluded.effective_from, effective_to=excluded.effective_to,
           project_id=excluded.project_id, execution_json=excluded.execution_json`,
      )
      .run({
        id: job.id,
        name: job.name,
        prompt: job.prompt,
        scheduleType: job.scheduleType,
        scheduleExpr: job.scheduleExpr,
        timezone: job.timezone,
        spaceId: job.spaceId ?? null,
        cwd: job.cwd ?? null,
        enabled: job.enabled ? 1 : 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        lastRunAt: job.lastRunAt ?? null,
        permissionMode: job.permissionMode ?? null,
        welcomeMode: job.welcomeMode ?? null,
        modelId: job.modelId ?? null,
        expertId: job.expertId ?? null,
        skillIdsJson: JSON.stringify(job.skillIds ?? []),
        connectorIdsJson: JSON.stringify(job.connectorIds ?? []),
        effectiveFrom: job.effectiveFrom ?? null,
        effectiveTo: job.effectiveTo ?? null,
        projectId: job.projectId ?? null,
        executionJson,
      });
  }

  setCronEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  removeCronJob(id: string): void {
    this.db.prepare(`DELETE FROM cron_runs WHERE job_id = ?`).run(id);
    this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  }

  getCronJob(id: string): CronJobDto | undefined {
    const row = this.db.prepare(`
      SELECT c.*,
             (SELECT COUNT(id) FROM cron_runs WHERE job_id = c.id AND status != 'skipped') AS run_count
      FROM cron_jobs c
      WHERE c.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToCronJob(row) : undefined;
  }

  insertCronRun(run: CronRunDto): void {
    this.db
      .prepare(
        `INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id)
         VALUES (@id, @jobId, @startedAt, @finishedAt, @status, @error, @taskId)`,
      )
      .run({
        id: run.id,
        jobId: run.jobId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        status: run.status,
        error: run.error ?? null,
        taskId: run.taskId ?? null,
      });
  }

  finishCronRun(
    id: string,
    status: "success" | "error" | "skipped",
    error?: string,
    taskId?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE cron_runs SET finished_at = ?, status = ?, error = ?, task_id = COALESCE(?, task_id) WHERE id = ?`,
      )
      .run(Date.now(), status, error ?? null, taskId ?? null, id);
  }

  recoverCronRuns(): void {
    this.db.prepare("UPDATE cron_runs SET status = 'error', finished_at = ?, error = ? WHERE status = 'running'")
      .run(Date.now(), "应用退出中断执行，未自动重放");
  }

  listRunningCronRuns(): CronRunDto[] {
    const rows = this.db.prepare("SELECT id, job_id, task_id, started_at FROM cron_runs WHERE status = 'running'").all() as Array<{ id: string; job_id: string; task_id: string | null; started_at: number }>;
    return rows.map(row => ({ id: row.id, jobId: row.job_id, taskId: row.task_id ?? undefined, startedAt: row.started_at, status: "running" }));
  }

  listCronRuns(limit = 50, jobIds?: string[]): CronRunDto[] {
    const rows = this.db
      .prepare(`SELECT * FROM cron_runs ${jobIds ? `WHERE job_id IN (${jobIds.map(() => "?").join(",")})` : ""} ORDER BY started_at DESC LIMIT ?`)
      .all(...(jobIds ?? []), limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      jobId: String(r.job_id),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at != null ? Number(r.finished_at) : undefined,
      status: r.status as CronRunDto["status"],
      error: (r.error as string | null) ?? undefined,
      taskId: (r.task_id as string | null) ?? undefined,
    }));
  }

  touchCronLastRun(jobId: string): void {
    this.db.prepare(`UPDATE cron_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?`).run(
      Date.now(),
      Date.now(),
      jobId,
    );
  }

  listGatewayChannels(): Array<{
    id: string;
    type: string;
    name: string;
    configJson: string;
    connected: boolean;
    statusText?: string;
  }> {
    const rows = this.db.prepare(`SELECT * FROM gateway_channels`).all() as Array<{
      id: string;
      type: string;
      name: string;
      config_json: string;
      connected: number;
      status_text: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      configJson: r.config_json,
      connected: Boolean(r.connected),
      statusText: r.status_text ?? undefined,
    }));
  }

  upsertGatewayChannel(ch: {
    id: string;
    type: string;
    name: string;
    configJson: string;
    connected: boolean;
    statusText?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO gateway_channels (id, type, name, config_json, connected, status_text)
         VALUES (@id, @type, @name, @configJson, @connected, @statusText)
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, name=excluded.name, config_json=excluded.config_json,
           connected=excluded.connected, status_text=excluded.status_text`,
      )
      .run({
        id: ch.id,
        type: ch.type,
        name: ch.name,
        configJson: ch.configJson,
        connected: ch.connected ? 1 : 0,
        statusText: ch.statusText ?? null,
      });
  }

  insertGatewayMessage(msg: {
    channelId: string;
    chatId: string;
    direction: string;
    senderId?: string;
    senderName?: string;
    text: string;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO gateway_messages (channel_id, chat_id, direction, sender_id, sender_name, text, created_at)
         VALUES (@channelId, @chatId, @direction, @senderId, @senderName, @text, @at)`,
      )
      .run({
        channelId: msg.channelId,
        chatId: msg.chatId,
        direction: msg.direction,
        senderId: msg.senderId ?? null,
        senderName: msg.senderName ?? null,
        text: msg.text,
        at: msg.at,
      });
    // 容量控制：只保留最近 3000 条，防止无限增长
    this.db
      .prepare(
        `DELETE FROM gateway_messages WHERE id NOT IN (
           SELECT id FROM gateway_messages ORDER BY created_at DESC, id DESC LIMIT 3000
         )`,
      )
      .run();
  }

  listGatewayMessages(opts: GatewayListMessagesRequest): GatewayMessageDto[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    let sql = `SELECT id, channel_id, chat_id, direction, sender_id, sender_name, text, created_at
               FROM gateway_messages`;
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.channelId) {
      where.push("channel_id = @channelId");
      params.channelId = opts.channelId;
    }
    if (opts.chatId) {
      where.push("chat_id = @chatId");
      params.chatId = opts.chatId;
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC, id DESC LIMIT @limit`;
    params.limit = limit;
    const rows = this.db.prepare(sql).all(params) as Array<{
      id: number;
      channel_id: string;
      chat_id: string;
      direction: string;
      sender_id: string | null;
      sender_name: string | null;
      text: string;
      created_at: number;
    }>;
    return rows
      .map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        chatId: r.chat_id,
        direction: r.direction as GatewayMessageDto["direction"],
        senderId: r.sender_id ?? undefined,
        senderName: r.sender_name ?? undefined,
        text: r.text,
        at: r.created_at,
      }))
      .reverse();
  }

  close(): void {
    this.db.close();
  }

  private rowToCronJob(r: Record<string, unknown>): CronJobDto {
    const execution = parseCronExecution(r.execution_json ? JSON.parse(String(r.execution_json)) : {});

    return {
      id: String(r.id),
      name: String(r.name),
      prompt: String(r.prompt),
      scheduleType: r.schedule_type as CronJobDto["scheduleType"],
      scheduleExpr: String(r.schedule_expr),
      timezone: String(r.timezone ?? "Asia/Shanghai"),
      spaceId: (r.space_id as string | null) ?? undefined,
      cwd: (r.cwd as string | null) ?? undefined,
      enabled: Boolean(r.enabled),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastRunAt: r.last_run_at != null ? Number(r.last_run_at) : undefined,
      permissionMode: (r.permission_mode as CronJobDto["permissionMode"] | null) ?? undefined,
      welcomeMode: parseCronWelcomeMode(r.welcome_mode),
      modelId: (r.model_id as string | null) ?? undefined,
      expertId: (r.expert_id as string | null) ?? undefined,
      skillIds: parseCronStringArray(r.skill_ids_json),
      connectorIds: parseCronStringArray(r.connector_ids_json),
      effectiveFrom: r.effective_from != null ? Number(r.effective_from) : undefined,
      effectiveTo: r.effective_to != null ? Number(r.effective_to) : undefined,
      projectId: (r.project_id as string | null) ?? undefined,
      ...execution,
      runCount: typeof r.run_count === "number" ? r.run_count : undefined,
    };
  }
}

function parseCronWelcomeMode(raw: unknown): CronJobDto["welcomeMode"] | undefined {
  if (raw === "working" || raw === "coding" || raw === "general") return raw;
  return undefined;
}

function parseCronStringArray(raw: unknown): string[] | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return list.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
}
