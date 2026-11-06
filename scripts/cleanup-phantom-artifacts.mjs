/**
 * 清理「全目录快照 diff」误登记的幽灵产物（2026-11-06 事故）。
 *
 * 背景：会话 baseline 曾用 unfiltered:true 拍摄、回合末 after 用过滤版，导致整个工作目录
 * 的既有文件被判为「本轮新增」，同一条助手消息一次挂上几千个 artifact。代码侧已修复
 * （snapshotWorkspace 统一口径 + diffWorkspaceSnapshot 保险丝），本脚本只处理历史脏数据。
 *
 * 幽灵批次判据（可解释、可复核，保守到宁可少删）：
 *   source_type = 'workspace-file'（磁盘实文件，非托管内容）
 *   且 created_by_tool_call_id 为空（不是 write/edit 工具即时登记）
 *   且同一 (task_id, created_by_message_id) 下数量 >= --min（默认 200）
 * 一次「全目录误扫描」会挂上几千条；合法的 bash/python 批量交付通常是几十条以内，
 * 因此默认只清理超大批次，较小批次仅列出供人工判断，不自动删除。
 *
 * 用法：
 *   node scripts/cleanup-phantom-artifacts.mjs                 # 只读诊断（默认）
 *   node scripts/cleanup-phantom-artifacts.mjs --apply         # 备份后删除（需先完全退出 MyBuddy）
 *   node scripts/cleanup-phantom-artifacts.mjs --min 20        # 调整批次阈值（会扩大删除范围，慎用）
 *   node scripts/cleanup-phantom-artifacts.mjs --db <path>     # 指定其他 db
 *
 * 默认绝不写库。--apply 会先用 VACUUM INTO 生成一致性备份，再在单事务内删除并 bump
 * task revision；artifact_message_refs / artifact_file_dependencies 由外键级联清理。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const minArgIndex = args.indexOf("--min");
const parsedMin = Number(args[minArgIndex + 1]);
const PHANTOM_BATCH_MIN = minArgIndex >= 0 && Number.isInteger(parsedMin) && parsedMin >= 2
  ? parsedMin
  : 200;
const dbArgIndex = args.indexOf("--db");
const dbPath = dbArgIndex >= 0 && args[dbArgIndex + 1]
  ? args[dbArgIndex + 1]
  : join(homedir(), ".mybuddy", "app.db");

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
const phantomClause = `
  source_type = 'workspace-file'
  AND (created_by_tool_call_id IS NULL OR created_by_tool_call_id = '')
  AND created_by_message_id IS NOT NULL AND created_by_message_id <> ''
`;

const total = db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n;
const batches = db.prepare(`
  SELECT task_id, created_by_message_id AS message_id, COUNT(*) AS n,
         MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM artifacts
  WHERE ${phantomClause}
  GROUP BY task_id, created_by_message_id
  HAVING COUNT(*) >= ?
  ORDER BY n DESC
`).all(PHANTOM_BATCH_MIN);
const phantomCount = batches.reduce((sum, b) => sum + b.n, 0);

console.log(`数据库：${dbPath}`);
console.log(`大小：${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MiB`);
console.log(`artifacts 总数：${total}`);
console.log(`幽灵批次（>= ${PHANTOM_BATCH_MIN} 条/消息）：${batches.length} 批，共 ${phantomCount} 条（${((phantomCount / Math.max(total, 1)) * 100).toFixed(1)}%）`);
console.log("");

const taskTitle = db.prepare("SELECT title FROM tasks WHERE id = ?");
for (const batch of batches.slice(0, 20)) {
  const title = taskTitle.get(batch.task_id)?.title ?? "(任务已删除)";
  const sample = db.prepare(`
    SELECT entry_file FROM artifacts
    WHERE task_id = ? AND created_by_message_id = ? AND ${phantomClause} LIMIT 2
  `).all(batch.task_id, batch.message_id).map((r) => r.entry_file ?? "(无 entry_file)");
  console.log(`  ${String(batch.n).padStart(5)} 条 | ${title} | msg=${batch.message_id}`);
  console.log(`         样例：${sample.join(" ; ")}`);
}
if (batches.length > 20) console.log(`  ... 另有 ${batches.length - 20} 个批次`);

const smallBatches = db.prepare(`
  SELECT COUNT(*) AS batches, COALESCE(SUM(n), 0) AS entries FROM (
    SELECT COUNT(*) AS n FROM artifacts
    WHERE ${phantomClause}
    GROUP BY task_id, created_by_message_id
    HAVING COUNT(*) >= 20 AND COUNT(*) < ?
  )
`).get(PHANTOM_BATCH_MIN);
console.log("");
console.log(`另有 ${smallBatches.batches} 个 20~${PHANTOM_BATCH_MIN - 1} 条的小批次（共 ${smallBatches.entries} 条）：`);
console.log("  可能是合法的批量交付，默认不清理；如需一并处理请先复核路径再用 --min 20。");

if (!apply) {
  console.log("");
  console.log("DRY RUN：未修改任何数据。确认无误后，先完全退出 MyBuddy，再执行：");
  console.log("  node scripts/cleanup-phantom-artifacts.mjs --apply");
  db.close();
  process.exit(0);
}

const walPath = `${dbPath}-wal`;
if (existsSync(walPath) && statSync(walPath).size > 0) {
  console.error(`\n检测到未归档的 WAL（${walPath}）；请先完全退出 MyBuddy 后重试，避免备份/删除与运行中的实例竞争。`);
  db.close();
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${dbPath}.phantom-backup-${stamp}`;
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`\n已备份：${backupPath}`);

db.pragma("foreign_keys = ON");
const deleteBatch = db.prepare(`
  DELETE FROM artifacts
  WHERE task_id = ? AND created_by_message_id = ? AND ${phantomClause}
`);
const bumpRevision = db.prepare(`
  INSERT INTO artifact_task_revisions(task_id, revision)
  VALUES (?, COALESCE((SELECT revision FROM artifact_task_revisions WHERE task_id = ?), 0) + 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1
`);
const run = db.transaction(() => {
  let removed = 0;
  for (const batch of batches) {
    removed += deleteBatch.run(batch.task_id, batch.message_id).changes;
    bumpRevision.run(batch.task_id, batch.task_id);
  }
  return removed;
});
const removed = run();
console.log(`已删除 ${removed} 条幽灵产物，涉及 ${batches.length} 个批次；重启 MyBuddy 后重新 hydrate 即可。`);
db.close();
