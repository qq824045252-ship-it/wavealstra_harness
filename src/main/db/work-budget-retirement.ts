import type Database from "better-sqlite3";

/**
 * Work 额度/预算模块退役（#24）。
 *
 * 只清理预算独占的 schema、字段和由预算写入的 blocker/因果拒绝记录：
 * - `work_budget_reservations` / `work_budget_windows` / `work_budget_requests` /
 *   `work_budget_request_sequences` 及其索引、触发器；
 * - `works.budget_json` / `works.budget_policy_json`；
 * - `work_execution_bindings.reservation_id`；
 * - `work_blockers.window_id` 与只由预算产生的 blocker；
 * - `work_causal_chains` 中只由预算产生的拒绝记录。
 *
 * Work、Bot、会话、消息、团队身份/依赖、成果、文件、验收证据、真实失败与
 * 外部效果记录一律保留。不重建、不清空业务数据库，也不提升 user_version。
 *
 * 幂等：旧库、部分迁移库和全新库都可以重复执行；DDL/DML 由调用方的
 * AppDatabase 迁移事务包住，任一语句失败时整次退役回滚，重启后可再次执行。
 */

const RETIRED_TABLES = [
  "work_budget_reservations",
  "work_budget_windows",
  "work_budget_requests",
  "work_budget_request_sequences",
] as const;

/** 预算独占字段：混合业务表只删除这些列，保留其余业务数据。 */
const RETIRED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["works", "budget_json"],
  ["works", "budget_policy_json"],
  ["work_execution_bindings", "reservation_id"],
  ["work_blockers", "window_id"],
];

/** 只由预算模块写入的 blocker / 拒绝记录。真实失败和未知外部效果不在其中。 */
const RETIRED_BLOCKER_REASON_CODES = [
  "budget-exhausted",
  "budget-rollover-pending",
  "budget-reconciliation-conflict",
] as const;
const RETIRED_BLOCKER_ID_PREFIXES = ["budget:", "usage:"] as const;

export interface WorkBudgetRetirementReport {
  droppedTables: string[];
  droppedColumns: string[];
  deletedBlockers: number;
  deletedCausalAdmissions: number;
  clearedTeamBudgetErrors: number;
  resetDispatchBudgetRequests: number;
}

const BUDGET_ERROR_SQL = "(lower(error) LIKE '%budget%' OR lower(error) LIKE '%quota%' OR error LIKE '%预算%' OR error LIKE '%额度%' OR error LIKE '%供应商用量%')";

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function columns(db: Database.Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
}

/**
 * 旧 `work_causal_chains.decision` CHECK 仍允许 `blocked-budget`。预算拒绝行删除后，
 * 把混合因果表重建为不含预算决策的当前 schema；其余因果记录逐行保留。
 */
function rebuildCausalLedgerWithoutBudgetDecision(db: Database.Database): void {
  if (!tableExists(db, "work_causal_chains")) return;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_causal_chains'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql?.includes("blocked-budget")) return;
  db.exec(`
    ALTER TABLE work_causal_chains RENAME TO work_causal_chains_budget_retired;
    CREATE TABLE work_causal_chains (
      chain_id TEXT PRIMARY KEY,
      root_event_id TEXT NOT NULL,
      parent_chain_id TEXT,
      parent_causal_event_id TEXT,
      origin_work_id TEXT NOT NULL,
      origin_bot_id TEXT,
      target_work_id TEXT NOT NULL,
      target_subscription_id TEXT,
      source TEXT NOT NULL,
      source_event_id TEXT,
      input_snapshot_id TEXT,
      target_state_hash TEXT,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      hops INTEGER NOT NULL CHECK (hops >= 0),
      dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
      admission_key TEXT NOT NULL UNIQUE,
      decision TEXT NOT NULL CHECK (decision IN ('admitted','blocked-loop','blocked-depth','blocked-hops','unknown-attribution')),
      reason_code TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO work_causal_chains SELECT * FROM work_causal_chains_budget_retired;
    DROP TABLE work_causal_chains_budget_retired;
    CREATE INDEX idx_work_causal_chains_state
      ON work_causal_chains(target_work_id, target_state_hash, created_at);
    CREATE INDEX idx_work_causal_chains_root
      ON work_causal_chains(root_event_id);
  `);
}

/** 调用方必须提供事务（AppDatabase.migrate 已提供）。 */
export function retireWorkBudget(db: Database.Database): WorkBudgetRetirementReport {
  const report: WorkBudgetRetirementReport = {
    droppedTables: [], droppedColumns: [], deletedBlockers: 0, deletedCausalAdmissions: 0,
    clearedTeamBudgetErrors: 0, resetDispatchBudgetRequests: 0,
  };

  // 先按来源删除预算 blocker：`window_id` 列随后可能被删除，不能再用来判定。
  // `usage:` 是预算结算遗留的用量核对 blocker；真实外部效果 blocker 使用
  // external_effect kind，不会被这里匹配。
  const reasonPlaceholders = RETIRED_BLOCKER_REASON_CODES.map(() => "?").join(",");
  const blockerWhere = `(reason_code IN (${reasonPlaceholders}) OR ${RETIRED_BLOCKER_ID_PREFIXES
    .map(() => "blocker_id LIKE ?").join(" OR ")}) AND kind != 'external_effect' AND unknown_external_effect_ref IS NULL`;
  const blockerParams: string[] = [
    ...RETIRED_BLOCKER_REASON_CODES,
    ...RETIRED_BLOCKER_ID_PREFIXES.map(prefix => `${prefix}%`),
  ];
  if (tableExists(db, "work_blockers")) {
    const result = db.prepare(`DELETE FROM work_blockers WHERE ${blockerWhere}`).run(...blockerParams);
    report.deletedBlockers = Number(result.changes);
  }

  // 预算拒绝只存在于因果账本中；它不是业务证据，也不是真实失败结果。
  if (tableExists(db, "work_causal_chains")) {
    const result = db.prepare("DELETE FROM work_causal_chains WHERE decision='blocked-budget'").run();
    report.deletedCausalAdmissions = Number(result.changes);
    rebuildCausalLedgerWithoutBudgetDecision(db);
  }

  // Preparation failures written by the retired team budget gate are not real
  // business failures. Clear only rows that never produced an execution binding.
  if (tableExists(db, "work_team_executions") && tableExists(db, "work_execution_bindings")) {
    const result = db.prepare(`UPDATE work_team_executions SET error=NULL
      WHERE error IS NOT NULL AND ${BUDGET_ERROR_SQL}
        AND NOT EXISTS (SELECT 1 FROM work_execution_bindings binding WHERE binding.task_id=work_team_executions.task_id)`)
      .run();
    report.clearedTeamBudgetErrors = Number(result.changes);
  }

  // A budget refusal could leave a standalone dispatch request blocked even though
  // no native binding ever existed. Re-open only those requests; real failures stay.
  if (tableExists(db, "work_dispatch_requests") && tableExists(db, "work_execution_bindings")) {
    const result = db.prepare(`UPDATE work_dispatch_requests SET state='pending',attempts=0,error=NULL
      WHERE state='blocked' AND error IS NOT NULL AND ${BUDGET_ERROR_SQL}
        AND NOT EXISTS (SELECT 1 FROM work_execution_bindings binding WHERE binding.operation_id='dispatch:' || work_dispatch_requests.operation_id)`)
      .run();
    report.resetDispatchBudgetRequests = Number(result.changes);
  }

  // DROP TABLE 会一并删除该表上的索引和触发器。
  for (const table of RETIRED_TABLES) {
    if (!tableExists(db, table)) continue;
    db.exec(`DROP TABLE ${table}`);
    report.droppedTables.push(table);
  }

  // SQLite 3.35+ 支持 DROP COLUMN；better-sqlite3 内置版本满足要求。
  // 每列单独检查，部分迁移库重跑时只继续剩余列。
  for (const [table, column] of RETIRED_COLUMNS) {
    if (!columns(db, table).has(column)) continue;
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    report.droppedColumns.push(`${table}.${column}`);
  }

  return report;
}
