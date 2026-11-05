/**
 * 同名空间清理脚本（V13 Workspace Tree 兼容版）
 *
 * 用法（在项目根目录）：
 *   node_modules/.bin/esbuild scripts/dedupe-spaces.ts --bundle --platform=node \
 *     --format=cjs --outfile=out/scripts/dedupe-spaces.cjs --external:better-sqlite3
 *   node out/scripts/dedupe-spaces.cjs                 # dry-run，只看不改
 *   node out/scripts/dedupe-spaces.cjs --apply         # 执行合并 + 确保 V13 唯一索引
 *
 * V13 语义：同名是否冲突取决于 parent_id：
 *   - 根层（parent_id IS NULL）：name 唯一（NOCASE）
 *   - 子层（parent_id IS NOT NULL）：(parent_id, name) 唯一（NOCASE）
 * 不同父下的同名空间（如 仪表项目/MMA 和 客户项目/MMA）是合法的，绝不合并。
 *
 * 行为：
 *   1. 分别找出根层同名组 和 同父同名子组
 *   2. 每组保留一条：优先保留带 path 的（真实目录）；都无 path 则保留 updated_at 最新的；同分则 created_at 最早
 *   3. 被删空间的子空间（parent_id = loser）→ 移至 winner（保留层级语义；若子名与 winner 现有子重名则整组回滚并保留 loser，绝不产生孤儿）
 *   4. tasks.space_id / memories.space_id 迁至 winner（仅当子空间全部可移动时）
 *   5. 删除冗余空间行（仅当无冲突时）
 *   6. 确保 V13 两条 partial unique 索引存在，移除旧全局 idx_spaces_name
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const pathArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const dbPath = pathArg ?? join(homedir(), ".mybuddy", "app.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 预检查：spaces 表是否存在、是否有 V13 列（parent_id）
const spacesExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spaces'").get() !== undefined;
if (!spacesExists) {
  console.log("✔ spaces 表不存在（全新库），无需清理。");
  process.exit(0);
}
const spaceCols = db.pragma("table_info(spaces)") as Array<{ name: string }>;
const hasParentCol = spaceCols.some((c) => c.name === "parent_id");
if (!hasParentCol) {
  console.log("⚠ 检测到旧库（无 parent_id 列），请先启动一次 MyBuddy 完成 v13 迁移后再运行本脚本。");
  console.log("  当前将按旧全局 name 去重（兼容模式），仅处理根层逻辑。");
}

type SpaceRow = {
  id: string;
  name: string;
  path: string | null;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
};

function pickWinner(rows: SpaceRow[]): SpaceRow {
  const withPath = rows.filter((r) => r.path !== null);
  if (withPath.length > 0) {
    // 有 path 的优先，取 updated_at 最新
    return [...withPath].sort((a, b) => b.updated_at - a.updated_at)[0]!;
  }
  return [...rows].sort((a, b) => b.updated_at - a.updated_at || a.created_at - b.created_at)[0]!;
}

function logGroup(prefix: string, winner: SpaceRow, losers: SpaceRow[], total: number): void {
  const winnerLabel = `${winner.id}${winner.path ? ` (${winner.path})` : " (无路径)"} parent=${winner.parent_id ?? "ROOT"}`;
  console.log(`■ ${prefix}「${winner.name}」共 ${total} 条：保留 ${winnerLabel}`);
  for (const loser of losers) {
    const taskCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE space_id = ?").get(loser.id) as { c: number }).c;
    let childCount = 0;
    if (hasParentCol) {
      try {
        childCount = (db.prepare("SELECT COUNT(*) AS c FROM spaces WHERE parent_id = ?").get(loser.id) as { c: number }).c;
      } catch {}
    }
    const label = `${loser.id}${loser.path ? ` (${loser.path})` : ""} parent=${loser.parent_id ?? "ROOT"}`;
    console.log(`   → 合并 ${label} [children=${childCount}, tasks=${taskCount}]`);
  }
}

// 1) 根层重复（V13）或旧全局去重（兼容）
let rootGroups: Array<{ name: string; c: number }> = [];
let childGroups: Array<{ parent_id: string; name: string; c: number }> = [];
if (hasParentCol) {
  rootGroups = db
    .prepare(
      `SELECT name COLLATE NOCASE AS name, COUNT(*) AS c
       FROM spaces WHERE parent_id IS NULL GROUP BY name COLLATE NOCASE HAVING c > 1`,
    )
    .all() as Array<{ name: string; c: number }>;
  childGroups = db
    .prepare(
      `SELECT parent_id, name COLLATE NOCASE AS name, COUNT(*) AS c
       FROM spaces WHERE parent_id IS NOT NULL GROUP BY parent_id, name COLLATE NOCASE HAVING c > 1`,
    )
    .all() as Array<{ parent_id: string; name: string; c: number }>;
} else {
  // 旧库兼容：全局 name 去重（仅用于 v12 前历史库，且绝不在 V13 上误用）
  const globalGroups = db
    .prepare(`SELECT name COLLATE NOCASE AS name, COUNT(*) AS c FROM spaces GROUP BY name COLLATE NOCASE HAVING c > 1`)
    .all() as Array<{ name: string; c: number }>;
  rootGroups = globalGroups;
  childGroups = [];
}

if (rootGroups.length === 0 && childGroups.length === 0) {
  console.log("✔ 没有发现同层同名空间（V13 语义），无需清理。");
  // 仍需确保索引状态正确
} else {
  console.log(`发现 ${rootGroups.length} 组根层同名 + ${childGroups.length} 组同父同名：\n`);
}

let mergedGroups = 0;
let mergedSpaces = 0;
let skippedConflicts = 0;

const run = db.transaction(() => {
  // 处理根层（V13）或旧全局（兼容）
  for (const group of rootGroups) {
    const rows = hasParentCol
      ? (db
          .prepare(
            `SELECT id, name, path, parent_id, created_at, updated_at FROM spaces
             WHERE parent_id IS NULL AND name = ? COLLATE NOCASE ORDER BY created_at ASC`,
          )
          .all(group.name) as SpaceRow[])
      : (db
          .prepare(`SELECT id, name, path, created_at, updated_at FROM spaces WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC`)
          .all(group.name) as SpaceRow[]).map((r: any) => ({ ...r, parent_id: null }));
    const winner = pickWinner(rows);
    const losers = rows.filter((r) => r.id !== winner.id);
    logGroup("[ROOT] ", winner, losers, rows.length);
    mergedGroups += 1;
    mergedSpaces += losers.length;
    if (!apply) continue;
    for (const loser of losers) {
      // P1-1 修复：若 loser 的任一子空间与 winner 现有子同名（触发 uq_spaces_child_name），则回滚该 loser 已移动的子并保留 loser，绝不删 loser 产生孤儿。
      let loserSkippedDueToConflict = false;
      if (hasParentCol) {
        let movedChildren: string[] = [];
        let children: Array<{ id: string; name: string }> = [];
        try {
          children = db.prepare("SELECT id, name FROM spaces WHERE parent_id = ?").all(loser.id) as Array<{ id: string; name: string }>;
        } catch {}
        // P1-1 显式同名检查：即使唯一索引尚未创建（坏库场景），也通过内存 NOCASE 去重防止孤儿；
        // 若索引已存在，仍以异常为兜底，确保双重防护。
        const winnerChildNames = new Set(
          (db.prepare("SELECT name FROM spaces WHERE parent_id = ?").all(winner.id) as Array<{ name: string }>).map((r) => r.name.toLowerCase()),
        );
        let hasConflict = false;
        let conflictChild: { id: string; name: string } | null = null;
        for (const child of children) {
          const lower = child.name.toLowerCase();
          if (winnerChildNames.has(lower)) {
            hasConflict = true;
            conflictChild = child;
            console.warn(`   ! 子空间 ${child.id} (${child.name}) 与 winner 已有子同名（NOCASE），保留 loser 以避免孤儿`);
            break;
          }
          try {
            db.prepare("UPDATE spaces SET parent_id = ? WHERE id = ?").run(winner.id, child.id);
            movedChildren.push(child.id);
            winnerChildNames.add(lower);
          } catch (e) {
            hasConflict = true;
            conflictChild = child;
            console.warn(`   ! 子空间 ${child.id} (${child.name}) 移至 winner 失败（同名冲突，保留 loser 以避免孤儿）：${String(e).slice(0, 160)}`);
            break;
          }
        }
        if (hasConflict) {
          for (const movedId of movedChildren) {
            try {
              db.prepare("UPDATE spaces SET parent_id = ? WHERE id = ?").run(loser.id, movedId);
            } catch (e2) {
              console.warn(`   ! 回滚子空间 ${movedId} 失败：${String(e2).slice(0, 120)}`);
            }
          }
          console.warn(`   ! loser ${loser.id} 存在与 winner 子空间同名冲突（冲突子：${conflictChild?.name ?? "?"}），已跳过该 loser 的合并（保留以避免孤儿，请手动重命名冲突子空间后重试）`);
          loserSkippedDueToConflict = true;
          mergedSpaces -= 1;
          skippedConflicts += 1;
        }
      }
      if (loserSkippedDueToConflict) continue;
      db.prepare("UPDATE tasks SET space_id = ? WHERE space_id = ?").run(winner.id, loser.id);
      db.prepare("UPDATE memories SET space_id = ? WHERE space_id = ?").run(winner.id, loser.id);
      db.prepare("DELETE FROM spaces WHERE id = ?").run(loser.id);
    }
  }

  // 处理同父子层
  for (const group of childGroups) {
    const rows = db
      .prepare(
        `SELECT id, name, path, parent_id, created_at, updated_at FROM spaces
         WHERE parent_id = ? AND name = ? COLLATE NOCASE ORDER BY created_at ASC`,
      )
      .all(group.parent_id, group.name) as SpaceRow[];
    const winner = pickWinner(rows);
    const losers = rows.filter((r) => r.id !== winner.id);
    logGroup(`[CHILD parent=${group.parent_id}] `, winner, losers, rows.length);
    mergedGroups += 1;
    mergedSpaces += losers.length;
    if (!apply) continue;
    for (const loser of losers) {
      // P1-1 同上：同父子层同样需防同名冲突孤儿
      let loserSkippedDueToConflict = false;
      {
        let movedChildren: string[] = [];
        const children = db.prepare("SELECT id, name FROM spaces WHERE parent_id = ?").all(loser.id) as Array<{ id: string; name: string }>;
        const winnerChildNames = new Set(
          (db.prepare("SELECT name FROM spaces WHERE parent_id = ?").all(winner.id) as Array<{ name: string }>).map((r) => r.name.toLowerCase()),
        );
        let hasConflict = false;
        let conflictChild: { id: string; name: string } | null = null;
        for (const child of children) {
          const lower = child.name.toLowerCase();
          if (winnerChildNames.has(lower)) {
            hasConflict = true;
            conflictChild = child;
            console.warn(`   ! 子空间 ${child.id} (${child.name}) 与 winner 已有子同名（NOCASE），保留 loser`);
            break;
          }
          try {
            db.prepare("UPDATE spaces SET parent_id = ? WHERE id = ?").run(winner.id, child.id);
            movedChildren.push(child.id);
            winnerChildNames.add(lower);
          } catch (e) {
            hasConflict = true;
            conflictChild = child;
            console.warn(`   ! 子空间 ${child.id} (${child.name}) 移至 winner 失败（同名冲突，保留 loser）：${String(e).slice(0, 160)}`);
            break;
          }
        }
        if (hasConflict) {
          for (const movedId of movedChildren) {
            try { db.prepare("UPDATE spaces SET parent_id = ? WHERE id = ?").run(loser.id, movedId); } catch {}
          }
          console.warn(`   ! loser ${loser.id} 同名冲突（冲突子：${conflictChild?.name ?? "?"}），已跳过合并（保留以避免孤儿）`);
          loserSkippedDueToConflict = true;
          mergedSpaces -= 1;
          skippedConflicts += 1;
        }
      }
      if (loserSkippedDueToConflict) continue;
      db.prepare("UPDATE tasks SET space_id = ? WHERE space_id = ?").run(winner.id, loser.id);
      db.prepare("UPDATE memories SET space_id = ? WHERE space_id = ?").run(winner.id, loser.id);
      db.prepare("DELETE FROM spaces WHERE id = ?").run(loser.id);
    }
  }

  if (apply) {
    // 移除旧全局索引（若存在），确保 V13 两条 partial 索引
    try {
      db.exec("DROP INDEX IF EXISTS idx_spaces_name");
    } catch {}
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_root_name ON spaces(name COLLATE NOCASE) WHERE parent_id IS NULL");
    } catch (e) {
      console.error("[dedupe] 创建 uq_spaces_root_name 失败（仍有根层同名）：", String(e).slice(0, 200));
    }
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_child_name ON spaces(parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL");
    } catch (e) {
      console.error("[dedupe] 创建 uq_spaces_child_name 失败（仍有同父同名）：", String(e).slice(0, 200));
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id)");
    } catch {}
  }
});

run();

if (apply) {
  console.log(`\n✔ 已处理 ${mergedGroups} 组、合并 ${mergedSpaces} 个冗余空间（V13 语义）。`);
  if (skippedConflicts > 0) {
    console.log(`  ! 已防孤儿保留 ${skippedConflicts} 个冲突 loser（子空间同名 NOCASE），需人工重命名后重试索引收敛；uq_root/uq_child 未收敛属预期安全行为，非数据处理失败`);
  }
  if (mergedSpaces === 0 && skippedConflicts === 0) console.log("  （无实际合并，仅确保索引）");
  if (mergedSpaces === 0 && skippedConflicts > 0) console.log("  （本次无可用合并，均为冲突保留；索引未收敛属预期，已防孤儿、需人工重命名后重试索引收敛）");
} else {
  console.log(`\n（dry-run：发现 ${mergedGroups} 组、${mergedSpaces} 个冗余，未做修改；加 --apply 执行）`);
  if (rootGroups.length > 0 || childGroups.length > 0) {
    console.log("  提示：实际 --apply 时若存在子空间同名冲突，将已防孤儿保留 loser，需人工重命名后重试索引收敛");
  }
}

// 校验（V13 语义；旧库兼容）
let remainRoot = 0;
let remainChild = 0;
if (hasParentCol) {
  remainRoot = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT name COLLATE NOCASE AS n FROM spaces WHERE parent_id IS NULL GROUP BY n HAVING COUNT(*) > 1)`)
      .get() as { c: number }
  ).c;
  remainChild = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT parent_id, name COLLATE NOCASE AS n FROM spaces WHERE parent_id IS NOT NULL GROUP BY parent_id, n HAVING COUNT(*) > 1)`)
      .get() as { c: number }
  ).c;
} else {
  remainRoot = (
    db.prepare(`SELECT COUNT(*) AS c FROM (SELECT name COLLATE NOCASE AS n FROM spaces GROUP BY n HAVING COUNT(*) > 1)`).get() as { c: number }
  ).c;
  remainChild = 0;
}
const total = (db.prepare("SELECT COUNT(*) AS c FROM spaces").get() as { c: number }).c;
const hasRootIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_spaces_root_name'").get() !== undefined;
const hasChildIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_spaces_child_name'").get() !== undefined;
const hasParentIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_spaces_parent'").get() !== undefined;
const hasOldIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_spaces_name'").get() !== undefined;
console.log(`校验：空间总数=${total}，根层同名组=${remainRoot}，同父同名组=${remainChild}`);
console.log(`索引：uq_root=${hasRootIdx} uq_child=${hasChildIdx} idx_parent=${hasParentIdx} old_global=${hasOldIdx}（应为 false）`);
if (remainRoot > 0 || remainChild > 0) {
  if (skippedConflicts > 0) {
    console.log(`  → 残留同名组属预期：已防孤儿保留 ${skippedConflicts} 个 loser，需人工重命名冲突子空间后重试 --apply 以收敛索引（非数据处理失败）`);
  }
}
if (!hasRootIdx || !hasChildIdx) {
  if (skippedConflicts > 0) {
    console.log(`  → 索引未收敛（uq_root=${hasRootIdx} uq_child=${hasChildIdx}）属预期安全行为：已防孤儿、需人工重命名后重试索引收敛，非数据处理失败`);
  } else if (remainRoot > 0 || remainChild > 0) {
    console.log(`  → 索引未收敛（uq_root=${hasRootIdx} uq_child=${hasChildIdx}）：仍有同名组，执行 --apply 后可收敛（非数据处理失败）`);
  }
}
db.close();
