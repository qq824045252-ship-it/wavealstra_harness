import type Database from "better-sqlite3";

/**
 * Work 共享资源隔离与动作审批退役（2a9df8c 之后）。
 *
 * 只删除这两个机制独占的表和它们自己创建的 blocker；Work、admissions、子项成果、
 * 缺口覆盖、执行回执、Bot/任务/会话/记忆等业务数据一律保留。
 * 幂等：可在旧库、已清理库和全新库上重复执行，不提升 user_version。
 */
const RETIRED_TABLES = [
  // 共享资源隔离：租约、等待、恢复、指纹、不透明观测与效果核对。
  "work_resource_waiters",
  "work_resource_recovery",
  "work_resource_denials",
  "work_resource_fingerprints",
  "work_resource_opaque_observations",
  "work_resource_observation_clock",
  "work_resource_effect_preparations",
  "work_resource_effect_reviews",
  // Drop children before their referenced parent, including FK-enabled callers.
  "work_resource_leases",
  // Work 动作审批、授权规则与决策、延迟动作 outbox。
  "work_deferred_actions",
  "work_action_approval_claims",
  "work_action_approvals",
  "work_autonomy_rules",
  "work_decisions",
] as const;

/** 这些 blocker 只由已退役机制写入；清掉它们避免留下可点但永远失败的入口。 */
const RETIRED_BLOCKER_PREFIXES = ["work-approval:", "resource-dispatch:", "resource-recovery:"] as const;

export interface WorkIsolationRetirementReport {
  droppedTables: string[];
  deletedBlockers: number;
}

/** Called inside AppDatabase's migration transaction; records scope, never payloads. */
export function retireWorkIsolation(db: Database.Database): WorkIsolationRetirementReport {
  const report: WorkIsolationRetirementReport = { droppedTables: [], deletedBlockers: 0 };
  const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
  for (const table of RETIRED_TABLES) {
    if (!exists(table)) continue;
    db.exec(`DROP TABLE ${table}`);
    report.droppedTables.push(table);
  }
  if (exists("work_blockers")) for (const prefix of RETIRED_BLOCKER_PREFIXES) {
    report.deletedBlockers += db.prepare("DELETE FROM work_blockers WHERE blocker_id LIKE ?").run(`${prefix}%`).changes;
  }
  return report;
}
