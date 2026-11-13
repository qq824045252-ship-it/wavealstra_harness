import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "work-no-quota-"));
const path = join(root, "isolated.db");
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: id,
  authorization: DESKTOP_USER_GRANTS, workspacePath: root }));
const dispatch = (work: WorkDto, id: string) => unwrap(works.dispatchExecution(user, { operationId: id, workId: work.workId,
  botId: DEFAULT_BOT_ID, taskId: id, durableStoreKey: id, conversationId: "1", workspaceBinding: root }));
const columns = (table: string) => (db.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>).map(row => row.name);
try {
  assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_budget_%'").all(), []);
  assert(!columns("works").includes("budget_json"));
  assert(!columns("works").includes("budget_policy_json"));
  assert(!columns("work_execution_bindings").includes("reservation_id"));
  assert.equal("budget" in works, false);
  const original = create("original");
  assert.equal("budget" in original, false);
  assert.equal("budget" in works.getProjection(original.workId)!.phase4!, false);
  for (const kind of ["set-budget-policy", "reconcile-budget-reservation"]) {
    const response = works.phase4Control(user, { kind, operationId: kind, workId: original.workId, maxTokens: 1 });
    assert.equal(response.ok, false); if (!response.ok) assert.equal(response.code, "invalid_request");
  }
  for (let n = 0; n < 3; n++) {
    const work = dispatch(works.getWork(original.workId)!, `dispatch:${n}`);
    const binding = works.repo.getBinding(work.activeExecutionIds.at(-1)!)!;
    assert.equal("reservationId" in binding, false);
    unwrap(works.reconcileExecution({ kind: "system", reason: "terminal-without-usage" }, { bindingId: binding.bindingId, outcome: "completed" }));
    assert.equal(works.repo.listOpenBlockers(original.workId).length, 0);
  }
  const version = db.connection.pragma("user_version", { simple: true });
  const causalWork = create("legacy-causal");
  const causalInput = { workId: causalWork.workId, source: "fixture", sourceEventId: "legacy-quota-source",
    actionKind: "read", operationId: "legacy-quota-admission", trustedRoot: true, targetState: { revision: "quota-retired" } };
  const oldCausal = works.causal.admit(causalInput);
  // Seed only this isolated fixture as a current-version old-format admission.
  db.connection.pragma("ignore_check_constraints = ON");
  db.connection.prepare("UPDATE work_causal_chains SET decision='blocked-budget',reason_code='budget-exhausted' WHERE chain_id=?").run(oldCausal.chainId);
  db.connection.pragma("ignore_check_constraints = OFF");
  db.connection.prepare("INSERT INTO work_blockers(blocker_id,work_id,kind,reason,reason_code,waiting_for_user_input,status,created_at) VALUES ('causal:budget-exhausted',?,'operational','legacy causal quota','budget-exhausted',0,'open',1)").run(causalWork.workId);
  // Model an already-installed current-version database without opening user data.
  db.connection.exec(`ALTER TABLE works ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(budget_json));
    ALTER TABLE works ADD COLUMN budget_policy_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE work_execution_bindings ADD COLUMN reservation_id TEXT;
    CREATE TABLE work_budget_reservations(reservation_id TEXT PRIMARY KEY, work_id TEXT, state TEXT, tokens INTEGER);
    CREATE TABLE work_budget_windows(window_id TEXT PRIMARY KEY, work_id TEXT, limit_tokens INTEGER);
    CREATE TABLE work_budget_requests(request_id TEXT PRIMARY KEY, work_id TEXT, metering TEXT);
    CREATE TABLE work_budget_request_sequences(task_id TEXT PRIMARY KEY, sequence INTEGER);`);
  db.connection.prepare("UPDATE works SET budget_json=?, authorization_json=json_set(authorization_json,'$.budgetLimitTokens',0) WHERE work_id=?")
    .run(JSON.stringify({ maxTokens: 0, usedTokens: 100, windowExpiresAt: 1 }), original.workId);
  db.connection.prepare("INSERT INTO work_budget_reservations VALUES ('historical',?,'unknown',100)").run(original.workId);
  db.connection.prepare("INSERT INTO work_blockers(blocker_id,work_id,kind,reason,reason_code,waiting_for_user_input,status,created_at) VALUES (?,?,'operational','legacy quota','budget-exhausted',0,'open',1)")
    .run(`budget:exhausted:${original.workId}`, original.workId);
  db.connection.prepare("UPDATE work_operation_receipts SET result_snapshot_json=json_set(result_snapshot_json,'$.budget',json('{\"maxTokens\":0}'),'$.budgetPolicy',json('{\"maxTokens\":0}'),'$.authorization.budgetLimitTokens',0) WHERE operation_id='original'").run();
  const legacyReceipt = db.connection.prepare("SELECT result_snapshot_json FROM work_operation_receipts WHERE operation_id='original'").get();
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  assert.equal(db.connection.pragma("user_version", { simple: true }), version, "retirement keeps the current version");
  assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_budget_%'").all(), [], "legacy budget tables are permanently retired");
  assert(!columns("works").includes("budget_json"));
  assert(!columns("work_execution_bindings").includes("reservation_id"));
  assert.equal(works.getWork(original.workId)!.title, "original");
  assert.equal("budgetLimitTokens" in works.getWork(original.workId)!.authorization, false);
  assert.equal(works.repo.listOpenBlockers(original.workId).length, 0, "old quota blockers are inert without rewriting them");
  assert.equal(works.repo.getBlocker(`budget:exhausted:${original.workId}`), undefined, "retired budget blocker is removed");
  const replay = create("original");
  assert.equal(replay.workId, original.workId);
  assert.equal("budget" in replay, false); assert.equal("budgetPolicy" in replay, false);
  assert.equal("budgetLimitTokens" in replay.authorization, false);
  assert.deepEqual(db.connection.prepare("SELECT result_snapshot_json FROM work_operation_receipts WHERE operation_id='original'").get(), legacyReceipt,
    "receipt projection strips quota fields without rewriting the stored receipt");
  assert.equal(works.repo.listOpenBlockers(causalWork.workId).length, 0, "legacy causal quota blocker is inert");
  const retriedCausal = works.causal.admit(causalInput);
  assert.equal(retriedCausal.allowed, true, "a historical quota refusal is re-evaluated without a quota");
  assert.notEqual(retriedCausal.chainId, oldCausal.chainId);
  assert.equal(works.causal.admit(causalInput).chainId, retriedCausal.chainId, "post-removal retry stays idempotent");
  assert.equal(db.connection.prepare("SELECT decision FROM work_causal_chains WHERE chain_id=?").get(oldCausal.chainId), undefined, "retired budget refusal row is removed");
  assert.equal(works.causal.admit({ ...causalInput, operationId: "different-operation" }).allowed, false, "same-state causal loop protection still applies");
  create("new-after-upgrade");
  dispatch(works.getWork(original.workId)!, "dispatch-after-upgrade");
  // A matching-looking historical blocker must retain unknown evidence without blocking Work.
  const protectedWork = create("protected");
  db.connection.prepare("INSERT INTO work_blockers(blocker_id,work_id,kind,reason,reason_code,unknown_external_effect_ref,waiting_for_user_input,status,created_at) VALUES (?,?,'operational','effect','budget-exhausted','unverified-effect',0,'open',1)")
    .run(`budget:exhausted:${protectedWork.workId}`, protectedWork.workId);
  assert.equal(works.repo.listOpenBlockers(protectedWork.workId).length, 0);
  assert.equal(works.repo.getBlocker(`budget:exhausted:${protectedWork.workId}`)?.unknownExternalEffectRef, "unverified-effect");
  assert.equal(works.repo.getBlocker(`budget:exhausted:${protectedWork.workId}`)?.details?.effectDisposition, "continue_without_replay");
  assert.equal(unwrap(works.closeWork(user, { operationId: "stop-protected", workId: protectedWork.workId, conclusion: "ended_unsuccessfully", closureSummary: "Unverified external effect remains diagnostic evidence" })).lifecycle, "closed");
  bots.registerBot({ userId: LOCAL_USER_ID, botId: "quota-team-member", displayName: "member", authorization: DESKTOP_USER_GRANTS });
  const formalTemplate = works.teams.handle(user, { kind: "save_template", request: { operationId: "fixture-formal-team", name: "Formal fixture team",
    plan: { ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: "Summarize", members: [{ botId: "quota-team-member", responsibility: "Inspect", delegatedScope: ["workspace:read"] }] } } });
  assert(formalTemplate.ok && formalTemplate.template);
  const teamResult = works.teams.handle({ ...user, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } }, { kind: "create", request: { templateId: formalTemplate.template.templateId,
    operationId: "quota-team", title: "legacy team quota", goalDescription: "Read input", workspacePath: root, criteria: ["Report findings"],
    ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: "Review findings", members: [{ botId: "quota-team-member", responsibility: "Read input", delegatedScope: ["workspace:read"] }],
  } });
  assert(teamResult.ok && teamResult.work && teamResult.team);
  const teamWorkId = teamResult.work.workId, teamTaskId = teamResult.team.executions[0].taskId;
  const legacyError = "团队共享预算已耗尽，未启动下一成员";
  db.connection.prepare("UPDATE work_team_executions SET error=? WHERE work_id=? AND task_id=?").run(legacyError, teamWorkId, teamTaskId);
  works.repo.insertBlocker({ blockerId: `team-dispatch:${teamTaskId}`, workId: teamWorkId, kind: "operational", reason: `团队执行尚未启动，需核对后继续：${legacyError}`,
    waitingForUserInput: true, status: "open", createdAt: 1 });
  assert.equal(works.teams.get(teamWorkId)!.executions[0].error, undefined, "never-started legacy team quota failure is inert");
  assert.equal(works.repo.listOpenBlockers(teamWorkId).length, 0);
  assert.deepEqual(db.connection.prepare("SELECT error FROM work_team_executions WHERE work_id=? AND task_id=?").get(teamWorkId, teamTaskId), { error: legacyError });
  assert.equal(works.repo.getBlocker(`team-dispatch:${teamTaskId}`)!.status, "open", "team quota audit blocker is not cleared");
  assert.equal(works.repo.canIgnoreRetiredTeamQuotaFailure(teamWorkId, teamTaskId, "other preparation error"), false);
  works.repo.insertBlocker({ blockerId: "team-real-effect", workId: teamWorkId, kind: "external_effect", reason: "unverified actual effect",
    unknownExternalEffectRef: "actual", waitingForUserInput: false, status: "open", createdAt: 2 });
  assert.equal(works.repo.canIgnoreRetiredTeamQuotaFailure(teamWorkId, teamTaskId, legacyError), true);
  assert.equal(works.teams.get(teamWorkId)!.executions[0].error, undefined, "unknown historical effects do not revive retired quota failures");
  assert.equal(works.repo.getBlocker("team-real-effect")?.unknownExternalEffectRef, "actual");
  assert.equal(works.repo.getBlocker("team-real-effect")?.details?.effectDisposition, "continue_without_replay");
  assert.equal(works.repo.canIgnoreRetiredTeamQuotaFailure(original.workId, "dispatch-after-upgrade", legacyError), false, "existing binding prevents quota-only reinterpretation");
  assert.equal(works.causal.list(causalWork.workId).some(row => row.chain_id === oldCausal.chainId), false, "retired quota refusals are not current monitor items");
  const noAuthority = new WorkService(db.connection, { bots, isAuthority: () => false });
  assert.equal(noAuthority.createWork(user, { operationId: "no-authority", title: "no" }).ok, false);
  console.log("PASS no Work quota contracts or runtime blocking; obsolete budget fields in the current schema are removed while current business history, authority and external-effect evidence are preserved");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
