import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { retireWorkBudget } from "../src/main/db/work-budget-retirement";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "work-budget-retirement-"));
const dbPath = join(root, "business.db");
const workspace = join(root, "workspace");
import { mkdirSync } from "node:fs";
mkdirSync(workspace, { recursive: true });

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
const tables = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
const queryCount = (db: Database.Database, sql: string): number =>
  Number((db.prepare(sql).get() as { count: number }).count);
const count = (db: Database.Database, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
const inputSnapshot = (db: Database.Database, workId: string): string =>
  (db.prepare("SELECT input_snapshot_id FROM works WHERE work_id=?").get(workId) as { input_snapshot_id: string }).input_snapshot_id;
const sqlFor = (db: Database.Database, name: string): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string } | undefined)?.sql ?? "";

const businessTables = ["works", "bots", "tasks", "work_participants", "work_team_executions", "work_deliverables", "work_blockers", "work_causal_chains"];
const snapshotCounts = (db: Database.Database) => Object.fromEntries(businessTables.map(table => [table, count(db, table)]));

try {
  // 1. New profile: no budget schema is ever created.
  let app = new AppDatabase(dbPath);
  assert.equal(app.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
  for (const table of ["work_budget_reservations", "work_budget_windows", "work_budget_requests", "work_budget_request_sequences"]) {
    assert.equal(tables(app.connection).includes(table), false, `new profile must not create ${table}`);
  }
  assert.equal(columns(app.connection, "works").includes("budget_json"), false);
  assert.equal(columns(app.connection, "works").includes("budget_policy_json"), false);
  assert.equal(columns(app.connection, "work_execution_bindings").includes("reservation_id"), false);
  assert.equal(columns(app.connection, "work_blockers").includes("window_id"), false);
  assert.equal(sqlFor(app.connection, "work_causal_chains").includes("blocked-budget"), false);

  // 2. Real business data: a Work, a team identity/dependency, a task and a deliverable.
  const bots = new BotRegistry(app.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "owner", authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ userId: LOCAL_USER_ID, botId: "member-a", displayName: "member", authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(app.connection, { bots });
  const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } };
  const formalTemplate = works.teams.handle(user, { kind: "save_template", request: { operationId: "fixture-formal-team", name: "Formal fixture team",
    plan: { ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: "Summarize", members: [{ botId: "member-a", responsibility: "Inspect", delegatedScope: ["workspace:read"] }] } } });
  assert(formalTemplate.ok && formalTemplate.template);
  const team = works.teams.handle(user, { kind: "create", request: { templateId: formalTemplate.template.templateId,
    operationId: "retirement-team", title: "Retirement fixture", goalDescription: "Keep business facts",
    workspacePath: workspace, ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: "Summarize",
    members: [{ botId: "member-a", responsibility: "Inspect", delegatedScope: ["workspace:read"] }],
    criteria: ["Keep real data"], executionPolicy: "sequential", maxConcurrency: 1 } });
  assert(team.ok && team.work && team.team, JSON.stringify(team));
  const workId = team.work!.workId;
  const standalone = works.createWork(user, { operationId: "retirement-standalone", title: "Standalone Work",
    authorization: DESKTOP_USER_GRANTS, workspacePath: workspace, inputSnapshotId: "retirement-input" });
  assert(standalone.ok, JSON.stringify(standalone));
  const standaloneId = standalone.work!.workId;
  app.upsertTask({ id: "retirement-task", title: "Retirement task", updatedAt: 1, cwd: workspace });
  works.repo.insertBlocker({ blockerId: "real:external", workId, kind: "external_effect",
    reason: "真实外部效果未知，必须保留", unknownExternalEffectRef: "real-effect", waitingForUserInput: false,
    status: "open", createdAt: 1 });
  works.repo.insertBlocker({ blockerId: "continuation:real", workId, kind: "operational",
    reason: "真实执行缺口仍待补跑", waitingForUserInput: true, status: "open", createdAt: 2 });
  const queuedTask = (app.connection.prepare("SELECT task_id FROM work_team_executions WHERE work_id=? ORDER BY ordinal LIMIT 1").get(workId) as { task_id: string }).task_id;
  app.connection.prepare("UPDATE work_team_executions SET error=? WHERE task_id=?").run("团队共享预算已耗尽，未启动下一成员", queuedTask);
  app.connection.prepare(`INSERT INTO work_dispatch_requests
    (operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,attempts,error,created_at)
    VALUES ('retired-budget-dispatch',?,?,?,?,?, 'blocked',2,'budget_exhausted: 预算不足',1)`)
    .run(standaloneId, "retirement-dispatch-task", DEFAULT_BOT_ID, standalone.work!.intentRevision, standalone.work!.inputSnapshotId);
  app.connection.prepare(`INSERT INTO work_causal_chains
    (chain_id,root_event_id,origin_work_id,target_work_id,source,source_event_id,input_snapshot_id,
     depth,hops,dispatch_count,admission_key,decision,reason_code,created_at)
    VALUES ('real-chain','real-root',?,?, 'hook','real-event',?,0,0,1,'real-admission','admitted',NULL,3)`).run(workId, workId, inputSnapshot(app.connection, workId));
  const before = snapshotCounts(app.connection);
  assert(before.works > 0 && before.work_team_executions > 0 && before.work_blockers >= 2 && before.work_causal_chains >= 1, JSON.stringify(before));
  app.close();

  // 3. Obsolete budget-only fields in an otherwise current-schema database.
  let raw = new Database(dbPath);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    ALTER TABLE works ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{"windowId":"win-old","maxTokens":100}';
    ALTER TABLE works ADD COLUMN budget_policy_json TEXT NOT NULL DEFAULT '{"maxTokens":100}';
    ALTER TABLE work_execution_bindings ADD COLUMN reservation_id TEXT;
    ALTER TABLE work_blockers ADD COLUMN window_id TEXT;

    CREATE TABLE work_budget_reservations (reservation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL);
    CREATE TABLE work_budget_windows (window_id TEXT PRIMARY KEY, work_id TEXT NOT NULL);
    CREATE TABLE work_budget_requests (request_id TEXT PRIMARY KEY, work_id TEXT NOT NULL);
    CREATE TABLE work_budget_request_sequences (task_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0);
  `);
  raw.prepare("INSERT INTO work_budget_reservations VALUES ('obsolete-reservation',?)").run(workId);
  raw.prepare("INSERT INTO work_budget_windows VALUES ('obsolete-window',?)").run(workId);
  raw.prepare("INSERT INTO work_budget_requests VALUES ('obsolete-request',?)").run(workId);
  raw.prepare("INSERT INTO work_budget_request_sequences(task_id,sequence) VALUES ('retirement-task',3)").run();
  raw.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,reason_code,details_json,window_id,status,waiting_for_user_input,created_at)
    VALUES ('budget:exhausted:old',?,'旧预算耗尽','operational','budget-exhausted','{}','win-old','open',1,5)`).run(workId);
  raw.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,details_json,window_id,status,waiting_for_user_input,created_at)
    VALUES ('usage:old',?,'旧用量未结算','operational','{}','win-old','open',0,6)`).run(workId);
  // Seed obsolete refusal data without reviving a previous database version or schema.
  raw.pragma("ignore_check_constraints = ON");
  raw.prepare(`INSERT INTO work_causal_chains
    (chain_id,root_event_id,origin_work_id,target_work_id,source,source_event_id,input_snapshot_id,
     depth,hops,dispatch_count,admission_key,decision,reason_code,created_at)
    VALUES ('old-budget-chain','old-budget-root',?,?, 'hook','old-budget-event',?,0,0,1,'old-budget-admission','blocked-budget','budget-exhausted',4)`).run(workId, workId, inputSnapshot(raw, workId));
  raw.pragma("ignore_check_constraints = OFF");
  assert.equal(Number(raw.pragma("user_version", { simple: true })), CURRENT_DATABASE_SCHEMA_VERSION);
  raw.close();

  // 4. Current-schema startup cleans only obsolete budget facts and retains business data.
  app = new AppDatabase(dbPath);
  const after = snapshotCounts(app.connection);
  assert.deepEqual(after, before, "budget retirement must preserve business row counts");
  assert.deepEqual(app.connection.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  assert.deepEqual(app.connection.pragma("foreign_key_check"), []);
  assert.equal(app.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "cleanup never changes the current schema version");
  for (const table of ["work_budget_reservations", "work_budget_windows", "work_budget_requests", "work_budget_request_sequences"]) {
    assert.equal(tables(app.connection).includes(table), false, `${table} must be dropped`);
  }
  assert.equal(columns(app.connection, "works").includes("budget_json"), false);
  assert.equal(columns(app.connection, "works").includes("budget_policy_json"), false);
  assert.equal(columns(app.connection, "work_execution_bindings").includes("reservation_id"), false);
  assert.equal(columns(app.connection, "work_blockers").includes("window_id"), false);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_blockers WHERE blocker_id IN ('budget:exhausted:old','usage:old')"), 0);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_causal_chains WHERE decision='blocked-budget'"), 0);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_causal_chains WHERE chain_id='real-chain' AND decision='admitted'"), 1);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_blockers WHERE blocker_id='real:external' AND kind='external_effect'"), 1);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_blockers WHERE blocker_id='continuation:real'"), 1);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_team_executions WHERE error IS NOT NULL"), 0);
  assert.equal(queryCount(app.connection, "SELECT COUNT(*) AS count FROM work_dispatch_requests WHERE operation_id='retired-budget-dispatch' AND state='pending' AND error IS NULL"), 1);
  assert.equal(sqlFor(app.connection, "work_causal_chains").includes("blocked-budget"), false);
  const sqlDump = app.connection.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(row => (row as { sql: string }).sql).join("\n");
  assert.equal(/work_budget_|budget_json|budget_policy_json|reservation_id|window_id|blocked-budget/.test(sqlDump), false, "no budget schema text may remain");

  // 5. A real Work can dispatch again after current-schema budget-only cleanup.
  const reopenedWorks = new WorkService(app.connection, { bots: new BotRegistry(app.connection) });
  const dispatch = reopenedWorks.dispatchExecution(user, { operationId: "post-retirement-dispatch", workId: standaloneId, botId: DEFAULT_BOT_ID,
    taskId: "retirement-task", durableStoreKey: "retirement-store", conversationId: "retirement-conversation", workspaceBinding: workspace });
  assert(dispatch.ok, JSON.stringify(dispatch));
  app.close();

  // 6. An interrupted retirement transaction rolls back atomically; a retry completes it.
  raw = new Database(dbPath);
  raw.exec(`
    ALTER TABLE works ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE work_blockers ADD COLUMN window_id TEXT;
    CREATE TABLE work_budget_requests (request_id TEXT PRIMARY KEY, work_id TEXT NOT NULL);
  `);
  raw.exec("BEGIN");
  retireWorkBudget(raw);
  raw.exec("ROLLBACK");
  assert(columns(raw, "works").includes("budget_json"), "rollback must leave the original structure intact");
  assert(tables(raw).includes("work_budget_requests"), "rollback must leave partial budget tables intact");
  raw.exec("BEGIN");
  const report = retireWorkBudget(raw);
  raw.exec("COMMIT");
  raw.close();
  assert.deepEqual(report.droppedTables, ["work_budget_requests"]);
  assert.deepEqual(report.droppedColumns, ["works.budget_json", "work_blockers.window_id"]);
  app = new AppDatabase(dbPath);
  assert.deepEqual(snapshotCounts(app.connection).works, before.works, "retry/duplicate startup keeps the Work");
  assert.equal(tables(app.connection).includes("work_budget_requests"), false);
  app.close();
  app = new AppDatabase(dbPath);
  assert.deepEqual(snapshotCounts(app.connection), before, "repeated startup is idempotent");
  app.close();

  console.log("PASS work budget retirement: current profiles have no budget schema; obsolete current-schema fields are cleaned transactionally and idempotently; business rows, relations, integrity and dispatch are preserved");
} finally {
  rmSync(root, { recursive: true, force: true });
}
