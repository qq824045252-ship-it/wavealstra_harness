/** P0-D：非阻塞 defer、ignore≠reject、去重与可复用规则（真实 SQLite + WorkService）。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "work-approval-defer-"));
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult): WorkDto => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
let count = 0;
const check = async (name: string, run: () => Promise<void>) => { await run(); count += 1; console.log(`PASS ${count}: ${name}`); };

async function fixture(label: string) {
  const db = new AppDatabase(join(root, `${label}.db`));
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: label, authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(db.connection, { bots, resourceHostId: `host-${label}` });
  const work = unwrap(works.createWork(user, { operationId: `create-${label}`, title: label,
    inputSnapshotId: `input-${label}`, workspacePath: root, authorization: DESKTOP_USER_GRANTS }));
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
    const authorization = await f.request("tool:1:1:write", "write", { path: "a.txt", content: "x" });
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
    const deferred = await f.request("tool:1:3:write", "write", { path: "b.txt", content: "y" });
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
    assert.equal(f.works.approvals.permits(f.binding.bindingId, "tool:1:3:write", "workspace:write"), true);
    // 同项目、同 effect/operation 的后续动作命中保存的规则，不再出卡。
    const next = await f.request("tool:1:4:write", "write", { path: "c.txt", content: "z" });
    assert.equal(next.kind, "allow", "a saved project rule authorizes the next compatible action");
    assert.equal(next.kind === "allow" ? next.source : "", "policy");
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

await rm(root, { recursive: true, force: true });
console.log(`work approval defer: ${count} checks passed`);
