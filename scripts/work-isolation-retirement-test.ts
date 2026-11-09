/** 退役共享资源隔离与 Work 动作审批：旧 profile 数据不得锁死执行层，业务数据保持不变。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { retireWorkIsolation } from "../src/main/db/work-isolation-retirement";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "work-isolation-retirement-"));
const dbPath = join(root, "app.db");
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS };
let count = 0;
const check = (name: string, run: () => void) => { run(); console.log(`PASS ${++count}: ${name}`); };

/** 旧版本创建的退役专用表（列只需覆盖旧代码真实写入的形状）。 */
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS work_resource_leases (token INTEGER PRIMARY KEY, owner_json TEXT NOT NULL, resources_json TEXT NOT NULL,
    state TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER, released_at INTEGER, host_id TEXT);
  CREATE TABLE IF NOT EXISTS work_resource_waiters (waiter_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, owner_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_recovery (token INTEGER PRIMARY KEY, owner_json TEXT NOT NULL, attempts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_denials (action_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_fingerprints (fingerprint TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_opaque_observations (observation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_observation_clock (host_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_effect_preparations (token INTEGER PRIMARY KEY, prepared_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_resource_effect_reviews (token INTEGER PRIMARY KEY, conclusion TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_action_approvals (approval_id TEXT PRIMARY KEY, work_id TEXT, binding_id TEXT, operation_id TEXT,
    fingerprint TEXT, decision_json TEXT, data_json TEXT);
  CREATE TABLE IF NOT EXISTS work_action_approval_claims (source_gap_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_autonomy_rules (rule_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_decisions (decision_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS work_deferred_actions (approval_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
`;
const RETIRED_TABLES = ["work_resource_leases", "work_resource_waiters", "work_resource_recovery", "work_resource_denials",
  "work_resource_fingerprints", "work_resource_opaque_observations", "work_resource_observation_clock",
  "work_resource_effect_preparations", "work_resource_effect_reviews", "work_action_approvals",
  "work_action_approval_claims", "work_autonomy_rules", "work_decisions", "work_deferred_actions"] as const;
const tables = (db: AppDatabase): Set<string> => new Set((db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as { name: string }[]).map(row => row.name));

let workId = "";
try {
  const first = new AppDatabase(dbPath);
  const bots = new BotRegistry(first.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "Owner", authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(first.connection, { bots });
  const created = works.createWork(user, { operationId: "create:old-profile", title: "旧 profile 事项",
    authorization: DESKTOP_USER_GRANTS, inputSnapshotId: "input:old" });
  assert(created.ok);
  workId = created.work.workId;
  first.upsertTask({ id: "task-kept", title: "保留的任务", updatedAt: Date.now() });
  const dispatched = works.dispatchExecution(user, { operationId: "dispatch:old-profile", workId, botId: DEFAULT_BOT_ID,
    taskId: "task-kept", durableStoreKey: "store:old", conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"] });
  assert(dispatched.ok);
  const binding = works.repo.bindingForTask("task-kept")!;
  const bindingId = binding.bindingId;
  assert.equal(works.admitTaskAction("task-kept", { operationId: "real-admission", actionKind: "workspace:write" }), undefined);

  // 旧机制留下的现场：隔离租约、旧审批、旧 blockers，以及一条不属于本机制的阻碍。
  first.connection.exec(LEGACY_DDL);
  first.connection.prepare("INSERT INTO work_resource_leases(token,owner_json,resources_json,state,acquired_at,host_id) VALUES (?,?,?,?,?,?)")
    .run(7, JSON.stringify({ workId, taskId: "task-kept", bindingId: binding.bindingId }), "[]", "quarantined", 1, "old-host");
  first.connection.prepare("INSERT INTO work_resource_denials(action_id,owner_key,reason,recorded_at) VALUES (?,?,?,?)")
    .run("old-action", "host:old", "historical denial", 1);
  first.connection.prepare("INSERT INTO work_resource_fingerprints(fingerprint,recorded_at) VALUES (?,?)").run("old-host-quarantine", 1);
  first.connection.prepare("INSERT INTO work_resource_observation_clock(host_id,observed_at) VALUES (?,?)").run("old-host", 1);
  first.connection.prepare(`INSERT INTO work_action_approvals(approval_id,work_id,binding_id,operation_id,fingerprint,data_json)
    VALUES ('work-approval:old',?,?,?,?,?)`).run(workId, binding.bindingId, "tool:old", "f", JSON.stringify({ status: "pending" }));
  first.connection.prepare("INSERT INTO work_autonomy_rules(rule_id,user_id) VALUES ('rule:old',?)").run(LOCAL_USER_ID);
  first.connection.prepare("INSERT INTO work_decisions(decision_id,user_id) VALUES ('decision:old',?)").run(LOCAL_USER_ID);
  first.connection.prepare("INSERT INTO work_deferred_actions(approval_id,payload_json) VALUES ('work-approval:old','{}')").run();
  works.repo.insertBlocker({ blockerId: "work-approval:old", workId, kind: "operational",
    reason: "旧审批等待决定", waitingForUserInput: true, status: "open", createdAt: 1 });
  works.repo.insertBlocker({ blockerId: "resource-dispatch:" + binding.bindingId + ":", workId, kind: "operational",
    reason: "旧隔离派发等待", waitingForUserInput: true, status: "open", createdAt: 1 });
  works.repo.insertBlocker({ blockerId: "continuation:" + binding.bindingId, workId, kind: "operational",
    reason: "真实缺口仍需补跑", waitingForUserInput: true, status: "open", createdAt: 1 });
  const deliverablesBefore = works.repo.listDeliverables(workId).length;
  const admissionsBefore = works.repo.listAdmissions(workId).length;
  first.close();

  // 正常启动路径：同一文件库重新打开，迁移必须幂等清掉退役现场。
  const second = new AppDatabase(dbPath);
  check("retired tables and their blockers are removed on a normal reopen", () => {
    const present = tables(second);
    for (const table of RETIRED_TABLES) assert.equal(present.has(table), false, `retired table still exists: ${table}`);
    const blockers = second.connection.prepare("SELECT blocker_id FROM work_blockers WHERE work_id=?").all(workId) as { blocker_id: string }[];
    assert.deepEqual(blockers.map(row => row.blocker_id), ["continuation:" + bindingId],
      "only the genuine continuation blocker survives; retired blockers never come back");
  });
  check("business data, schema version and existing admissions are preserved", () => {
    const works2 = new WorkService(second.connection, { bots: new BotRegistry(second.connection) });
    const work = works2.getWork(workId);
    assert(work, "Work is not deleted");
    assert.equal(work!.lifecycle, "active");
    assert.equal(second.connection.pragma("user_version", { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(second.getTask("task-kept")?.title, "保留的任务");
    assert.equal(works2.repo.listAdmissions(workId).length, admissionsBefore, "real admissions are real execution records");
    assert.equal(works2.repo.listDeliverables(workId).length, deliverablesBefore);
    const projection = works2.getProjection(workId);
    assert(projection, "projection is available");
    assert.equal("approvals" in projection, false, "the projection no longer carries an approval surface");
    assert.equal("resourceRecoveries" in (projection.phase3 ?? {}), false);
    assert.equal("resourceWaits" in (projection.phase3 ?? {}), false);
  });
  check("a retired blocker can no longer deny new actions, and the migration is repeatable", () => {
    const works3 = new WorkService(second.connection, { bots: new BotRegistry(second.connection) });
    assert.equal(works3.admitTaskAction("task-kept", { operationId: "new-action-after-retirement", actionKind: "workspace:write" }), undefined);
    retireWorkIsolation(second.connection);
    retireWorkIsolation(second.connection);
    assert.equal(works3.repo.listAdmissions(workId).some(item => item.operationId === "new-action-after-retirement"), true);
  });
  second.close();

  const fresh = new AppDatabase(join(root, "fresh.db"));
  check("a fresh profile never materializes the retired tables", () => {
    const present = tables(fresh);
    for (const table of RETIRED_TABLES) assert.equal(present.has(table), false);
    assert.equal(fresh.connection.pragma("user_version", { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION);
  });
  fresh.close();
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`work isolation retirement: ${count} checks passed`);
