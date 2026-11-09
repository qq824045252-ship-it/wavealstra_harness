import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { PythonProjectBindingStore } from "../src/main/runtime/PythonProjectBindingStore";
import { pythonProjectDirKey } from "../src/main/runtime/python-environment-spec";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function tableExists(db: AppDatabase, name: string): boolean {
  return db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

/** 同一目录下某个数据库文件的 `.discarded-<UTC 时间戳>` 备份（含 -wal/-shm 边车）。 */
function discardedBackups(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.discarded-`;
  return readdirSync(dirname(dbPath))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(dbPath), name))
    .sort();
}
function columnExists(db: AppDatabase, table: string, name: string): boolean {
  return (db.connection.pragma(`table_info(${table})`) as Array<{ name: string }>).some((row) => row.name === name);
}
function assertCurrentSchema(db: AppDatabase, label: string): void {
  assert(db.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, `${label}: current user_version`);
  for (const table of [
    "tasks", "projects", "usage_events", "workspace_library_links", "python_project_bindings",
    "library_chunks", "work_graph_edges", "gadgets", "blueprints", "memory_records",
    "memory_skill_candidates", "memory_skill_effectiveness", "memory_skill_revision_candidates",
    "agent_loadout_observations",
    "conversation_branches",
    "conversation_interactions",
    "bots", "bot_channel_bindings", "bot_expert_versions", "works", "work_intent_snapshots",
    "work_conversations", "work_participants", "work_execution_bindings", "work_action_admissions",
    "work_deliverables", "work_evidence", "work_blockers", "work_operation_receipts",
    "work_telemetry_state", "work_source_events", "work_events_inbox", "work_events_outbox",
    "work_subscriptions", "work_notifications", "work_host_lease",
  ]) assert(tableExists(db, table), `${label}: ${table} exists`);
  assert(!tableExists(db, "work_budget_reservations"), `${label}: retired work_budget_reservations is not created`);
  assert(!columnExists(db, "works", "budget_json"), `${label}: retired works.budget_json is not created`);
  assert(!tableExists(db, "conversation_goals"), `${label}: retired conversation_goals is not created`);
  assert(!tableExists(db, "project_memory"), `${label}: legacy project_memory is absent`);
  assert(!tableExists(db, "project_memory_evidence"), `${label}: legacy project memory evidence is absent`);
  for (const table of ["conversation_todo_lists", "conversation_todo_items", "conversation_execution_plans"])
    assert(!tableExists(db, table), `${label}: retired chat table ${table} is not created`);
  assert(columnExists(db, "tasks", "is_favorited"), `${label}: tasks.is_favorited is in current DDL`);
  assert(columnExists(db, "tasks", "space_sort_order"), `${label}: tasks.space_sort_order is in current DDL`);
  assert(columnExists(db, "task_runtime_context_snapshots", "storage_bytes"), `${label}: runtime snapshot storage_bytes is in current DDL`);
  assert(columnExists(db, "usage_events", "user_turn"), `${label}: usage_events.user_turn is in current DDL`);
}

console.log("== AppDatabase current-only schema contract ==");
const root = mkdtempSync(join(tmpdir(), "db-current-only-"));
try {
  const freshPath = join(root, "fresh.db");
  const fresh = new AppDatabase(freshPath);
  assertCurrentSchema(fresh, "fresh");
  fresh.upsertTask({ id: "keep-current", title: "keep current", status: "completed", updatedAt: 1 });
  fresh.connection.exec(`
    CREATE TABLE conversation_todo_lists (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO conversation_todo_lists VALUES ('legacy-todo', 'Historical chat Todo');
    CREATE TABLE conversation_execution_plans (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO conversation_execution_plans VALUES ('legacy-plan', 'Historical chat Plan');
  `);
  fresh.close();

  const reopened = new AppDatabase(freshPath);
  assert(reopened.getTask("keep-current")?.title === "keep current", "same current schema preserves data on reopen");
  assert((reopened.connection.prepare("SELECT title FROM conversation_todo_lists WHERE id='legacy-todo'").get() as { title: string }).title === "Historical chat Todo", "removed chat Todo does not destroy existing historical data");
  assert((reopened.connection.prepare("SELECT title FROM conversation_execution_plans WHERE id='legacy-plan'").get() as { title: string }).title === "Historical chat Plan", "removed chat Plan does not destroy existing historical data");
  reopened.close();

  const legacyPath = join(root, "legacy.db");
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE sentinel (value TEXT NOT NULL);
    INSERT INTO sentinel VALUES ('must-disappear');
    PRAGMA user_version = 24;
  `);
  legacy.close();
  const reset = new AppDatabase(legacyPath);
  assertCurrentSchema(reset, "legacy reset");
  assert(!tableExists(reset, "sentinel"), "incompatible schema is rebuilt (not migrated) after backup");
  assert(reset.listTasks().length === 0, "incompatible database data is cleared from the rebuilt database");
  reset.close();

  // 旧库不再被删除：三个文件改名为同目录 `.discarded-<UTC 时间戳>` 备份，备份内容仍可读。
  const legacyBackups = discardedBackups(legacyPath);
  assert(legacyBackups.length === 1, "incompatible database is backed up instead of deleted");
  assert(!existsSync(`${legacyPath}.pre-migration-v24-to-v${CURRENT_DATABASE_SCHEMA_VERSION}`), "no compatibility backup contract remains");
  const legacyBackupStamp = basename(legacyBackups[0]).slice(`${basename(legacyPath)}.discarded-`.length);
  assert(/^\d{8}T\d{9}Z$/.test(legacyBackupStamp), `backup name carries a UTC timestamp: ${legacyBackupStamp}`);
  const legacyBackup = new Database(legacyBackups[0], { readonly: true, fileMustExist: true });
  assert(legacyBackup.pragma("user_version", { simple: true }) === 24, "backup keeps the discarded user_version");
  assert((legacyBackup.prepare("SELECT value FROM sentinel").get() as { value: string }).value === "must-disappear", "backup preserves the discarded rows");
  legacyBackup.close();
  const rebuilt = new AppDatabase(legacyPath);
  assertCurrentSchema(rebuilt, "legacy rebuild reopen");
  assert(rebuilt.listTasks().length === 0, "rebuilt empty database is usable after backup");
  rebuilt.close();

  const corruptPath = join(root, "corrupt.db");
  writeFileSync(corruptPath, "not-a-sqlite-database");
  const recovered = new AppDatabase(corruptPath);
  assertCurrentSchema(recovered, "corrupt reset");
  recovered.close();
  const corruptBackups = discardedBackups(corruptPath);
  assert(corruptBackups.length === 1, "corrupt database is backed up instead of deleted");
  assert(readFileSync(corruptBackups[0], "utf8") === "not-a-sqlite-database", "backup preserves the corrupt file bytes");

  // 对话分支关系在 v27 库补表后立即可用（§5.2/§13.2）
  const branchDbPath = join(root, "branch.db");
  const branchDb = new AppDatabase(branchDbPath);
  branchDb.upsertTask({ id: "parent-x", title: "父", status: "completed", updatedAt: 1 });
  const br1 = "req-br-1";
  branchDb.createConversationBranchTask({
    childTaskId: "child-y",
    parentTaskId: "parent-x",
    rootTaskId: "parent-x",
    parentTitleSnapshot: "父",
    sourceSessionFile: "/tmp/none.jsonl",
    sourceLeafEntryId: "leaf-1",
    sourceUserMessageIndex: 0,
    requestId: br1,
    position: "after_reply",
    workspaceStrategy: "current_snapshot",
    createdAt: 2,
    task: {
      id: "child-y",
      title: "父（分支）",
      status: "completed",
      updatedAt: 2,
      sessionFile: "/tmp/none.jsonl",
      cwd: "/tmp/none",
      spaceSortOrder: 0,
      isFavorited: false,
    },
  });
  assert(branchDb.findConversationBranchByRequestId(br1)?.childTaskId === "child-y", "requestId 幂等查询命中 child");
  // requestId 唯一约束
  let dupThrew = false;
  try {
    branchDb.connection.prepare(
      `INSERT INTO conversation_branches (
         child_task_id, parent_task_id, root_task_id, parent_title_snapshot,
         source_session_file, source_leaf_entry_id, source_user_message_index,
         request_id, source_position, workspace_strategy, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("child-dup", "parent-x", "parent-x", "父", "/tmp/none.jsonl", "leaf-2", 0, br1, "after_user", "conversation_only", 3);
  } catch {
    dupThrew = true;
  }
  assert(dupThrew, "request_id 唯一约束生效（not null + unique，§5.4）");
  // parent 删除后 child 血缘保留（parent_task_id 无 FK）
  branchDb.createConversationBranchTask({
    childTaskId: "child-z",
    parentTaskId: "parent-x",
    rootTaskId: "parent-x",
    parentTitleSnapshot: "父",
    sourceSessionFile: "/tmp/none.jsonl",
    sourceLeafEntryId: "leaf-3",
    sourceUserMessageIndex: 0,
    requestId: "req-br-2",
    position: "after_user",
    workspaceStrategy: "conversation_only",
    createdAt: 3,
    task: {
      id: "child-z",
      title: "父（分支 2）",
      status: "pending",
      updatedAt: 3,
      sessionFile: "/tmp/none.jsonl",
      cwd: "/tmp/none2",
      spaceSortOrder: 0,
      isFavorited: false,
    },
  });
  branchDb.deleteTask("parent-x");
  const orphan = branchDb.getConversationBranchInfo("child-z");
  assert(orphan !== undefined && orphan.parentExists === false, "parent 删除后 child 血缘保留且 parentExists=false");
  assert(orphan?.parentTitle === "父", "parent 删除后标题快照保留");
  branchDb.close();
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

// python_project_bindings 真实 SQL 往返。
// Python 运行时门禁用内存替身跑逻辑，建表语句与 upsert 语法只能在这里对真库验证：
// 替身永远不会告诉你 ON CONFLICT 写错了。
{
  const pyRoot = mkdtempSync(join(tmpdir(), "db-python-binding-"));
  const projectDir = join(pyRoot, "我的 项目");
  const binding = {
    projectDir,
    dirKey: pythonProjectDirKey(projectDir, "win32"),
    pythonPath: join(projectDir, ".venv", "Scripts", "python.exe"),
    pythonVersion: "3.11.9",
    manifestPath: join(projectDir, "pyproject.toml"),
    boundAt: 1,
  };
  try {
    const db = new AppDatabase(join(pyRoot, "python.db"));
    const store = new PythonProjectBindingStore(db.connection, "win32");
    assert(store.resolveForDir(projectDir) === null, "空库解析为未绑定");
    store.save(binding);
    store.save({ ...binding, pythonVersion: "3.12.1", boundAt: 2 });
    assert(store.list().length === 1, "同目录改绑是覆盖而非追加");
    assert(store.list()[0].pythonVersion === "3.12.1", "upsert 更新了版本列");
    assert(store.list()[0].boundAt === 2, "upsert 更新了绑定时间");
    assert(store.resolveForDir(join(projectDir, "src"))?.pythonVersion === "3.12.1", "子目录继承走真库");
    db.close();

    // 重开库后绑定仍在：用户选择过项目环境就不该被反复询问
    const reopened = new AppDatabase(join(pyRoot, "python.db"));
    const again = new PythonProjectBindingStore(reopened.connection, "win32");
    assert(again.list().length === 1, "绑定跨重启持久化");
    assert(again.remove(projectDir) === true, "解绑命中真库主键");
    assert(again.remove(projectDir) === false, "重复解绑幂等");
    assert(again.list().length === 0, "解绑后为空");
    reopened.close();
  } finally {
    rmSync(pyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
