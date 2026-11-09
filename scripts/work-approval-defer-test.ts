/** P0-D：非阻塞 defer、ignore≠reject、去重与可复用规则（真实 SQLite + WorkService）。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkDecisionLedger } from "../src/main/agent/work/WorkDecisionLedger";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "work-approval-defer-"));
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult): WorkDto => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
let count = 0;
const check = async (name: string, run: () => Promise<void>) => { await run(); count += 1; console.log(`PASS ${count}: ${name}`); };

async function fixture(label: string, projectId?: string) {
  const db = new AppDatabase(join(root, `${label}.db`));
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: label, authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(db.connection, { bots, resourceHostId: `host-${label}` });
  const work = unwrap(works.createWork(user, { operationId: `create-${label}`, title: label,
    inputSnapshotId: `input-${label}`, projectId, workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
  const taskId = `task-${label}`;
  db.upsertTask({ id: taskId, title: label, cwd: root, updatedAt: Date.now() });
  unwrap(works.dispatchExecution(user, { operationId: `dispatch-${label}`, workId: work.workId, botId: DEFAULT_BOT_ID, taskId,
    durableStoreKey: `store:${label}`, conversationId: "1", workspaceBinding: root,
    delegatedScope: ["workspace:read", "workspace:write"] }));
  const binding = works.repo.bindingForTask(taskId)!;
  works.repo.updateBinding({ ...binding, status: "running", submittedAt: Date.now() });
  const request = (operationId: string, toolName: string, args: unknown) => works.approvals.request({
    taskId, operationId, toolName, arguments: args, actionKind: "workspace:write",
    summary: `${toolName} ${JSON.stringify(args).slice(0, 60)}`, permissionMode: "default", needsApproval: true, deferrable: true,
  });
  return { db, works, work, taskId, binding, request };
}

await check("defer returns immediately, records a not_started gap and does not block independent actions", async () => {
  const f = await fixture("defer");
  try {
    const started = Date.now();
    // 工作区外的写入无法证明目标在授权范围内，因此仍需主人决定。
    const authorization = await f.request("tool:1:1:write", "write", { path: "../outside.txt", content: "x" });
    const elapsed = Date.now() - started;
    assert.equal(authorization.kind, "defer", `expected defer, got ${authorization.kind}`);
    assert(elapsed < 1_500, `defer must not occupy the execution stack (took ${elapsed}ms)`);
    if (authorization.kind !== "defer") throw new Error("unreachable");
    const approval = f.works.approvals.list(f.work.workId).find(item => item.approvalId === authorization.approvalId)!;
    assert.equal(approval.status, "pending");
    assert.equal(approval.descriptor?.effect, "local_write", "the card carries the action descriptor");
    assert.equal(approval.descriptor?.hardGate, false);
    const gap = f.works.partialResults.list(f.work.workId).find(item => item.itemId === approval.approvalId)!;
    assert.equal(gap.nativeStatus, "host_approval_not_started");
    assert.equal(gap.outcome, "not_started");
    // 独立动作继续：只读命令不需要审批，不会被待批动作挡住。
    const read = await f.works.approvals.request({ taskId: f.taskId, operationId: "tool:1:2:read", toolName: "read",
      arguments: { path: "a.txt" }, actionKind: "workspace:read", summary: "read a.txt",
      permissionMode: "default", needsApproval: false, deferrable: true });
    assert.equal(read.kind, "allow");
  } finally { f.db.close(); }
});

await check("later approval only resumes the original action and records a reusable rule when asked", async () => {
  const f = await fixture("approve");
  try {
    const deferred = await f.request("tool:1:3:push", "bash", { command: "git push origin feature/x" });
    assert.equal(deferred.kind, "defer");
    if (deferred.kind !== "defer") throw new Error("unreachable");
    const current = f.works.getWork(f.work.workId)!;
    const decided = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId, workId: f.work.workId,
      bindingId: f.binding.bindingId, expectedVersion: 1, expectedStateVersion: current.stateVersion,
      expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch,
      decision: "allow", grantScopeOnce: true, saveRule: "workspace" });
    assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
    const approval = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    assert.equal(approval.status, "approved");
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:1:3:push", "workspace:write"), true);
    // 同工作区、同 effect/operation 的后续动作命中保存的规则，不再出卡。
    const next = await f.request("tool:1:4:push", "bash", { command: "git push origin feature/x" });
    assert.equal(next.kind, "allow", "a saved workspace rule authorizes the next compatible action");
    assert.equal(next.kind === "allow" ? next.source : "", "policy");
    assert.equal((await f.request("other-ref", "bash", { command: "git push origin feature/y" })).kind, "defer");
    assert.equal((await f.request("other-remote", "bash", { command: "git push upstream feature/x" })).kind, "defer");
    assert.deepEqual(f.works.approvals.listAutonomyRules(LOCAL_USER_ID)[0]?.scope.provider, ["git"]);
  } finally { f.db.close(); }
});

await check("ignore is neither approval nor rejection, never re-asks and keeps the work alive", async () => {
  const f = await fixture("ignore");
  try {
    const deferred = await f.request("tool:1:5:delete", "bash", { command: "rm -f junk.txt" });
    if (deferred.kind !== "defer") throw new Error(`expected defer, got ${deferred.kind}`);
    const current = f.works.getWork(f.work.workId)!;
    const ignored = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId, workId: f.work.workId,
      bindingId: f.binding.bindingId, expectedVersion: 1, expectedStateVersion: current.stateVersion,
      expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch, decision: "ignore" });
    assert.equal(ignored.ok, true, ignored.ok ? "" : ignored.message);
    const approval = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    assert.equal(approval.status, "ignored", "ignore is a distinct terminal state");
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:1:5:delete", "workspace:write"), false, "ignore never authorizes");
    const blocker = f.works.repo.getBlocker(deferred.approvalId)!;
    assert.equal(blocker.waitingForUserInput, false, "an ignored action does not nag for input");
    assert.equal(f.works.getWork(f.work.workId)?.lifecycle, "active", "ignore never cancels the work");
    // 同一动作再次请求：直接返回暂缓，不生成第二张卡。
    const again = await f.request("tool:1:6:delete", "bash", { command: "rm -f junk.txt" });
    assert.equal(again.kind, "defer");
    assert.equal(f.works.approvals.list(f.work.workId).length, 1, "no duplicate card for the same unchanged action");
  } finally { f.db.close(); }
});

await check("hard gate cards never offer a reusable rule and deny keeps the gap", async () => {
  const f = await fixture("hard");
  try {
    const deferred = await f.request("tool:1:7:push", "bash", { command: "git push origin main" });
    assert.equal(deferred.kind, "defer");
    if (deferred.kind !== "defer") throw new Error("unreachable");
    const approval = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    assert.equal(approval.descriptor?.hardGate, true, "protected push is a hard gate");
    const current = f.works.getWork(f.work.workId)!;
    const denied = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId, workId: f.work.workId,
      bindingId: f.binding.bindingId, expectedVersion: 1, expectedStateVersion: current.stateVersion,
      expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch, decision: "deny" });
    assert.equal(denied.ok, true, "a deny is still recorded");
    // hard gate 永远不能保存成长期规则（即使这次是允许）。
    const ruleOnHardGate = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId,
      workId: f.work.workId, bindingId: f.binding.bindingId, expectedVersion: 2,
      expectedStateVersion: f.works.getWork(f.work.workId)!.stateVersion,
      expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch,
      decision: "allow", grantScopeOnce: true, saveRule: "workspace" });
    assert.equal(ruleOnHardGate.ok, false, "hard gates can never become reusable rules");
    const stored = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    assert.equal(stored.status, "denied");
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:1:7:push", "workspace:write"), false);
  } finally { f.db.close(); }
});

await check("auto mode never auto-approves hard gates or unclassified effects", async () => {
  const f = await fixture("auto-gate");
  try {
    const request = (operationId: string, toolName: string, args: unknown) => f.works.approvals.request({
      taskId: f.taskId, operationId, toolName, arguments: args, actionKind: "workspace:write",
      summary: `${toolName} ${JSON.stringify(args).slice(0, 40)}`, permissionMode: "auto", needsApproval: true, deferrable: true });
    assert.equal((await request("tool:5:1:push", "bash", { command: "git push --force origin main" })).kind, "defer",
      "auto never approves a hard gate");
    assert.equal((await request("tool:5:2:cmd", "bash", { command: "frobnicate --now" })).kind, "defer",
      "auto never approves an unclassified shell command");
    assert.equal((await request("auto-outside", "write", { path: "/tmp/auto-outside.txt", content: "x" })).kind, "defer",
      "auto never overrides an unproven target");
    assert.equal((await request("auto-mixed", "bash", { command: "mkdir docs && opaque-command" })).kind, "defer",
      "auto never overrides unknown composite effects");
    assert.equal((await request("tool:5:3:write", "write", { path: "auto.txt", content: "x" })).kind, "allow",
      "auto still runs a proven in-workspace write");
  } finally { f.db.close(); }
});

await check("authorized workspace: routine work runs continuously without new cards", async () => {
  const f = await fixture("routine");
  try {
    const mkdir = await f.request("tool:2:1:mkdir", "bash", { command: "mkdir -p docs" });
    assert.equal(mkdir.kind, "allow", "a proven in-workspace mkdir needs no card");
    assert.equal(mkdir.kind === "allow" ? mkdir.source : "", "scope");
    assert.equal((await f.request("tool:2:2:write", "write", { path: "docs/a.md", content: "a" })).kind, "allow");
    assert.equal((await f.request("tool:2:3:write", "write", { path: "docs/b.md", content: "b" })).kind, "allow");
    const read = await f.works.approvals.request({ taskId: f.taskId, operationId: "tool:2:4:read", toolName: "read",
      arguments: { path: "docs/a.md" }, actionKind: "workspace:read", summary: "read docs/a.md",
      permissionMode: "default", needsApproval: false, deferrable: true });
    assert.equal(read.kind, "allow");
    assert.equal(f.works.approvals.list(f.work.workId).filter(item => item.status === "pending").length, 0,
      "routine workspace work never strands a pending card");
    assert.equal(f.works.approvals.list(f.work.workId).every(item => item.decision?.citedRuleIds.length === 0
      && item.decision?.source === "scope"), true, "every routine grant is recorded as a scope decision, not a rule");
    const outside = await f.request("tool:2:5:write", "write", { path: "/tmp/outside.txt", content: "x" });
    assert.equal(outside.kind, "defer", "a write outside the authorized workspace still asks the owner");
  } finally { f.db.close(); }
});

await check("saveRule is atomic: an invalid scope writes no approval, rule or version bump", async () => {
  const f = await fixture("atomic");
  try {
    const deferred = await f.request("tool:3:1:push", "bash", { command: "git push origin feature/z" });
    assert.equal(deferred.kind, "defer");
    if (deferred.kind !== "defer") throw new Error("unreachable");
    const before = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    const work = f.works.getWork(f.work.workId)!;
    const rejected = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId, workId: f.work.workId,
      bindingId: f.binding.bindingId, expectedVersion: before.version, expectedStateVersion: work.stateVersion,
      expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch,
      decision: "allow", grantScopeOnce: true, saveRule: "repo" });
    assert.equal(rejected.ok, false, "a repo rule without a trusted repo identity is refused");
    assert.equal(rejected.ok ? "" : rejected.code, "invalid_request");
    const after = f.works.approvals.list(f.work.workId).find(item => item.approvalId === deferred.approvalId)!;
    assert.equal(after.status, "pending", "the refused decision never settles the approval");
    assert.equal(after.version, before.version, "a refused decision never bumps the approval version");
    assert.equal(f.works.approvals.listAutonomyRules(LOCAL_USER_ID).length, 0, "a refused decision writes no rule");
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:3:1:push", "workspace:write"), false);
  } finally { f.db.close(); }
});

await check("revoking a rule retires not-yet-executed approvals and never re-authorizes through a precedent", async () => {
  const f = await fixture("revoke");
  try {
    const deferred = await f.request("tool:4:1:push", "bash", { command: "git push origin feature/r" });
    assert.equal(deferred.kind, "defer");
    if (deferred.kind !== "defer") throw new Error("unreachable");
    const work = f.works.getWork(f.work.workId)!;
    const decided = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: deferred.approvalId, workId: f.work.workId,
      bindingId: f.binding.bindingId, expectedVersion: 1, expectedStateVersion: work.stateVersion,
      expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch,
      decision: "allow", grantScopeOnce: true, saveRule: "workspace" });
    assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
    const rules = f.works.approvals.listAutonomyRules(LOCAL_USER_ID);
    assert.equal(rules.length, 1);
    const next = await f.request("tool:4:2:push", "bash", { command: "git push origin feature/r" });
    assert.equal(next.kind, "allow"); assert.equal(next.kind === "allow" ? next.source : "", "policy");
    assert.equal(f.works.approvals.list(f.work.workId).find(item => item.operationId === "tool:4:2:push")?.status, "approved");
    assert.equal(f.works.approvals.revokeAutonomyRule(LOCAL_USER_ID, rules[0]!.ruleId), true);
    assert.equal(f.works.approvals.list(f.work.workId).find(item => item.operationId === "tool:4:2:push")?.status,
      "invalidated", "revoking the rule immediately retires the approval it produced before anything ran");
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:4:2:push", "workspace:write"), false);
    const again = await f.request("tool:4:3:push", "bash", { command: "git push origin feature/t" });
    assert.equal(again.kind, "defer", "a revoked rule never re-authorizes through a recorded precedent");
  } finally { f.db.close(); }
});

await check("missing descriptor targets cannot create broad rules and failed save is atomic", async () => {
  const f = await fixture("targetless");
  try {
    const deferred = await f.request("unknown", "bash", { command: "mkdir docs && opaque-command" });
    assert.equal(deferred.kind, "defer");
    if (deferred.kind !== "defer") throw new Error("expected defer");
    const before = f.works.approvals.list(f.work.workId)[0]!;
    const work = f.works.getWork(f.work.workId)!;
    const result = f.works.approvals.decide(LOCAL_USER_ID, { approvalId: before.approvalId,
      workId: work.workId, bindingId: f.binding.bindingId, expectedVersion: before.version, ...guard(work),
      decision: "allow", saveRule: "workspace" });
    assert.equal(result.ok, false);
    assert.deepEqual(f.works.approvals.list(f.work.workId)[0], before);
    assert.equal(f.works.getWork(work.workId)!.stateVersion, work.stateVersion);
    assert.equal(f.works.approvals.listAutonomyRules(LOCAL_USER_ID).length, 0);
  } finally { f.db.close(); }
});

await check("project rules are evaluated with the Work project identity", async () => {
  const f = await fixture("project", "test-project");
  try {
    const ledger = new WorkDecisionLedger(f.db.connection);
    ledger.addRule({ userId: LOCAL_USER_ID, decision: "allow", reason: "project authorization", createdBy: "user",
      scope: { projectId: "test-project", effect: ["repo_write"], operation: ["git_push"], provider: ["git"], target: ["origin feature/p"] } });
    assert.equal((await f.request("project-push", "bash", { command: "git push origin feature/p" })).kind, "allow");
  } finally { f.db.close(); }
});

await check("approved actions revalidate indirect precedent provenance after revocation", async () => {
  const f = await fixture("indirect");
  try {
    const ledger = new WorkDecisionLedger(f.db.connection);
    const rule = ledger.addRule({ userId: LOCAL_USER_ID, decision: "allow", reason: "specific target", createdBy: "user",
      scope: { effect: ["repo_write"], operation: ["git_push"], provider: ["git"], target: ["origin feature/i"] } });
    assert.equal((await f.request("indirect-push", "bash", { command: "git push origin feature/i" })).kind, "allow");
    const approval = f.works.approvals.list(f.work.workId)[0]!;
    const source = ledger.listDecisions(LOCAL_USER_ID)[0]!;
    const intermediate = ledger.record({ ...source, decisionId: "indirect-source", citedRuleIds: [], citedDecisionIds: [source.decisionId] });
    const indirect = { ...approval, decision: { ...approval.decision!, citedRuleIds: [], citedDecisionIds: [intermediate.decisionId] } };
    f.db.connection.prepare("UPDATE work_action_approvals SET data_json=? WHERE approval_id=?")
      .run(JSON.stringify(indirect), approval.approvalId);
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "indirect-push", "workspace:write"), true);
    assert.equal(f.works.approvals.revokeAutonomyRule(LOCAL_USER_ID, rule.ruleId), true);
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "indirect-push", "workspace:write"), false);
    assert.equal(f.works.approvals.list(f.work.workId)[0]!.status, "invalidated");
  } finally { f.db.close(); }
});

await rm(root, { recursive: true, force: true });console.log(`work approval defer: ${count} checks passed`);
