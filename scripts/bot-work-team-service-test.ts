import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { LOCAL_USER_ID, type WorkActor, type WorkDto } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { collectOwnerSummaryFacts } from "../src/main/agent/work/WorkOwnerSummaryFacts";
import type { WorkTeamControlResult, WorkTeamPlan } from "../src/shared/bot-work-team";

const root = mkdtempSync(join(tmpdir(), "team-service-")), workspace = join(root, "workspace");
mkdirSync(workspace); writeFileSync(join(workspace, "input.txt"), "verified input");
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
let authority = true;
const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
const receipts = new Map<string, AgentSubmissionReceipt>();
const submissions: Array<{ taskId: string; botId: string; input: { teamAssignment: { role: string; botId: string; previousResults: Array<{ status: string }> } } }> = [];
const failPrepare = new Set<string>();
const failSummary = new Set<string>();
const unknownGeneration = new Set<string>();
const runningTasks = new Set<string>();
const errors: unknown[] = [];
const port: WorkExecutionPort = {
  prepare: async taskId => {
    if (failPrepare.has(taskId)) throw Error("fixture preparation unavailable before submission");
    return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: workspace };
  },
  find: async binding => receipts.get(binding.bindingId),
  submit: async (binding, text) => {
    assert.equal(works.checkTaskInput(binding.taskId, binding.operationId), undefined);
    if (unknownGeneration.has(binding.taskId)) {
      const admission = works.budget.admitProviderRequest({ taskId: binding.taskId, conversationId: binding.conversationId,
        generationTaskId: 1, sourceKind: "main", requestKind: "generation", estimatedTokens: 100 });
      assert(admission.allowed && admission.reservationId);
      assert(works.budget.settleProviderUsage({ taskId: binding.taskId, conversationId: binding.conversationId,
        generationTaskId: 1, reported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).ok);
    }
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
    submissions.push({ taskId: binding.taskId, botId: binding.botId, input: JSON.parse(text) });
    receipts.set(binding.bindingId, receipt); return receipt;
  },
  inspect: async binding => runningTasks.has(binding.taskId) ? ({ status: "running" }) : ({ status: failSummary.has(binding.taskId) ? "failed" : "completed", summary: `actual fixture result from ${binding.botId}`,
    hasWriteConflicts: false, artifactRefs: [], usageTokens: 2 }),
  stop: async () => {},
};
const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => authority, (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => authority, () => "fixture");
const ok = (result: WorkTeamControlResult) => { assert(result.ok, JSON.stringify(result)); return result; };
const reject = (result: WorkTeamControlResult, code: string) => { assert(!result.ok); assert.equal(result.code, code, result.message); };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
let serial = 0;
function setup() {
  const name = `team-${++serial}`;
  for (const suffix of ["owner", "a", "b", "new-owner"]) bots.registerBot({ botId: `${name}-${suffix}`, userId: LOCAL_USER_ID,
    displayName: suffix, authorization: grants });
  const plan: WorkTeamPlan = { ownerBotId: `${name}-owner`, ownerResponsibility: "只读核对并统一汇总",
    members: ["a", "b"].map(suffix => ({ botId: `${name}-${suffix}`, responsibility: `独立检查 ${suffix}`, delegatedScope: ["workspace:read"] })) };
  const request = { operationId: name, ...plan, title: name, goalDescription: "逐项检查输入", workspacePath: workspace,
    criteria: ["有来源的团队成果并明确缺口"], budgetTokens: 16384 };
  return { name, plan, request };
}
async function flush(count = 5) { for (let i = 0; i < count; i++) await queue.flush(); }
const bindings = (workId: string) => works.repo.listBindings(workId);
const countWorks = () => works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length;
try {
  // User-only validated atomic admission; templates confer no authorization.
  const initial = setup();
  reject(works.teams.handle({ kind: "bot", userId: LOCAL_USER_ID, botId: initial.plan.ownerBotId, host: "foreground", grants }, { kind: "create", request: initial.request }), "unauthorized_actor");
  reject(works.teams.handle({ ...user, grants: DESKTOP_USER_GRANTS }, { kind: "create", request: initial.request }), "unauthorized_actor");
  reject(works.teams.handle(user, { kind: "create", request: { ...initial.request, members: [initial.plan.members[0], initial.plan.members[0]] } }), "invalid_request");
  reject(works.teams.handle(user, { kind: "create", request: { ...initial.request, workspacePath: "relative" } }), "invalid_workspace");
  reject(works.teams.handle(user, { kind: "create", request: { ...initial.request, actor: { kind: "user" } } }), "invalid_request");
  const foreign = bots.registerBot({ botId: "foreign", userId: "foreign-user", displayName: "foreign" });
  reject(works.teams.handle(user, { kind: "create", request: { ...initial.request, members: [{ ...initial.plan.members[0], botId: foreign.botId }] } }), "unauthorized_actor");
  assert.equal(countWorks(), 0);
  const template = ok(works.teams.handle(user, { kind: "save_template", request: { operationId: "template-one", name: "Audit", plan: initial.plan } })).template!;
  assert.equal(ok(works.teams.handle(user, { kind: "save_template", request: { operationId: "template-one", name: "Audit", plan: initial.plan } })).replayed, true);
  reject(works.teams.handle(user, { kind: "save_template", request: { operationId: "template-two", name: "Audit", plan: initial.plan } }), "name_conflict");
  assert.deepEqual(ok(works.teams.handle({ kind: "user", userId: "foreign-user", grants }, { kind: "list_templates" })).templates, []);
  ok(works.teams.handle(user, { kind: "delete_template", templateId: template.templateId }));
  reject(works.teams.handle(user, { kind: "save_template", request: { operationId: "template-one", name: "Audit", plan: initial.plan } }), "not_found");

  // Frozen member inputs, sequential real adapter dispatch and a genuine owner stage.
  const created = ok(works.teams.handle(user, { kind: "create", request: initial.request }));
  const workId = created.work!.workId;
  assert.equal(created.team!.executions.length, 3);
  const replay = ok(works.teams.handle(user, { kind: "create", request: initial.request }));
  assert.equal(replay.replayed, true);
  assert.equal(created.operationId, initial.request.operationId);
  assert.equal(replay.operationId, initial.request.operationId);
  reject(works.teams.handle(user, { kind: "create", request: { ...initial.request, title: "changed" } }), "idempotency_conflict");
  reject(works.teams.handle({ kind: "user", userId: "foreign-user", grants }, { kind: "get", workId }), "not_found");
  queue.enqueue(works.getWork(workId)!, "must-not-schedule-owner");
  assert.equal((db.connection.prepare("SELECT count(*) n FROM work_dispatch_requests WHERE work_id=?").get(workId) as { n: number }).n, 0);
  await queue.flush(); assert.equal(bindings(workId).length, 1);
  await flush(); assert.equal(bindings(workId).length, 3);
  assert.equal(works.teams.get(workId)!.state, "awaiting_review");
  assert.equal(works.getWork(workId)!.lifecycle, "active");
  assert(works.repo.listDeliverables(workId).every(result => result.status === "proposed"));
  const ownerInput = submissions.find(item => item.taskId === created.team!.executions[2]!.taskId)!.input.teamAssignment;
  assert.equal(ownerInput.role, "owner_summary"); assert.equal(ownerInput.previousResults.length, 2);
  assert(ownerInput.previousResults.every(item => item.status === "proposed"));
  const sent = submissions.length; await flush(); assert.equal(submissions.length, sent);
  assert.equal(works.collaboration.history(workId).filter(message => message.kind === "result").length, 3);

  // Retired shared-resource gate: team identity, bindings and directory ownership stay,
  // but there is no per-resource authorization hook left to call.
  assert.equal(works.repo.listBindings(workId).length, 3);

  // Preparation failure can retry only with the current versions and no binding.
  const retrySetup = setup(), retry = ok(works.teams.handle(user, { kind: "create", request: retrySetup.request }));
  const retryTask = retry.team!.executions[0]!.taskId;
  failPrepare.add(retryTask); await queue.flush();
  assert.equal(works.teams.get(retry.work!.workId)!.state, "blocked"); assert.equal(bindings(retry.work!.workId).length, 0);
  reject(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(retry.work!), confirmNotStarted: true }), "version_conflict");
  failPrepare.delete(retryTask);
  ok(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(works.getWork(retry.work!.workId)!), confirmNotStarted: true }));
  await flush(); assert.equal(bindings(retry.work!.workId)[0]!.taskId, retryTask);
  reject(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(works.getWork(retry.work!.workId)!), confirmNotStarted: true }), "invalid_request");

  // Revoked owner/reporting rights block only that team; independent teams still proceed.
  const pausedSetup = setup(), paused = ok(works.teams.handle(user, { kind: "create", request: pausedSetup.request }));
  await queue.flush();
  db.connection.prepare("UPDATE bots SET status='paused' WHERE bot_id=?").run(pausedSetup.plan.ownerBotId);
  const independentSetup = setup(), independent = ok(works.teams.handle(user, { kind: "create", request: independentSetup.request }));
  await flush();
  assert.equal(works.teams.get(paused.work!.workId)!.state, "blocked");
  assert.equal(works.teams.get(independent.work!.workId)!.state, "awaiting_review");
  db.connection.prepare("UPDATE bots SET status='active' WHERE bot_id=?").run(pausedSetup.plan.ownerBotId);
  await flush(); assert.equal(works.teams.get(paused.work!.workId)!.state, "awaiting_review");

  // Changed requirements never silently repeat prior effects; explicit replan retains history.
  const originalTasks = bindings(workId).map(item => item.taskId);
  const amended = works.amendWork(user, { operationId: "new-requirements", workId, goalDescription: "Check updated input separately" });
  assert(amended.ok); assert.equal(works.teams.get(workId)!.state, "superseded");
  await flush(); assert.deepEqual(bindings(workId).map(item => item.taskId), originalTasks);
  const revisedPlan = { ...initial.plan, members: [initial.plan.members[1]!] };
  const replanned = ok(works.teams.handle(user, { kind: "replan", workId, versionGuard: guard(works.getWork(workId)!), plan: revisedPlan }));
  assert.equal(replanned.team!.executions.length, 2);
  assert.deepEqual(works.getWork(workId)!.participants.map(item => item.botId), [initial.plan.members[1]!.botId]);
  assert.match(works.repo.executionInput(bindings(workId)[0]!), /teamAssignment/, "old immutable team input remains available");
  await flush(); assert.equal(bindings(workId).length, 5);
  reject(works.teams.handle(user, { kind: "replan", workId, versionGuard: guard(works.getWork(workId)!), plan: revisedPlan }), "invalid_request");

  // A prepared but unsubmitted owner input is safely re-frozen after explicit handoff.
  const handedSetup = setup(), handed = ok(works.teams.handle(user, { kind: "create", request: handedSetup.request }));
  const summaryTask = handed.team!.executions[2]!.taskId;
  failPrepare.add(summaryTask); await flush();
  assert.equal(works.teams.get(handed.work!.workId)!.state, "blocked");
  assert.equal(bindings(handed.work!.workId).length, 2);
  const newOwner = `${handedSetup.name}-new-owner`;
  const handoff = works.handoffOwner(user, { operationId: "handoff-before-summary", workId: handed.work!.workId, targetBotId: newOwner });
  assert(handoff.ok, JSON.stringify(handoff));
  db.connection.prepare("UPDATE bots SET status='disabled' WHERE bot_id=?").run(handedSetup.plan.ownerBotId);
  failPrepare.delete(summaryTask);
  ok(works.teams.handle(user, { kind: "retry", workId: handed.work!.workId, versionGuard: guard(works.getWork(handed.work!.workId)!), confirmNotStarted: true }));
  await flush();
  const reassigned = submissions.find(item => item.taskId === summaryTask)!;
  assert.equal(reassigned.botId, newOwner); assert.equal(reassigned.input.teamAssignment.botId, newOwner);
  assert.equal(works.teams.get(handed.work!.workId)!.state, "awaiting_review");

  // Pause/cancel before submission does not start a member, and summary failure is not running forever.
  const suspendedSetup = setup(), suspended = ok(works.teams.handle(user, { kind: "create", request: suspendedSetup.request }));
  assert(works.pauseWork(user, { operationId: "pause-team", workId: suspended.work!.workId }).ok);
  await flush(); assert.equal(bindings(suspended.work!.workId).length, 0);
  assert.equal(works.teams.get(suspended.work!.workId)!.state, "paused");
  assert(works.cancelWork(user, { operationId: "cancel-team", workId: suspended.work!.workId }).ok);
  await flush(); assert.equal(bindings(suspended.work!.workId).length, 0);
  assert.equal(works.teams.get(suspended.work!.workId)!.state, "cancelled");
  const failedSetup = setup(), failed = ok(works.teams.handle(user, { kind: "create", request: failedSetup.request }));
  failSummary.add(failed.team!.executions[2]!.taskId); await flush();
  assert.equal(works.teams.get(failed.work!.workId)!.state, "blocked");
  assert.equal(bindings(failed.work!.workId).length, 3);

  // In-flight/unknown results hold the next member instead of spawning a replacement.
  const uncertainSetup = setup(), uncertain = ok(works.teams.handle(user, { kind: "create", request: uncertainSetup.request }));
  await queue.flush(); const uncertainBinding = bindings(uncertain.work!.workId)[0]!;
  works.transaction(() => works.repo.updateBinding({ ...uncertainBinding, status: "unknown" }));
  await works.teams.dispatchPending(db, adapter, () => "fixture");
  assert.equal(bindings(uncertain.work!.workId).length, 1);
  assert.equal(works.teams.get(uncertain.work!.workId)!.state, "blocked");
  works.transaction(() => works.repo.updateBinding(uncertainBinding)); await flush();

  // A failed provider request can release the dispatch envelope while its generation
  // usage stays unknown. That debt fences all later stages and explicit replanning.
  for (const replanBeforeReconciliation of [false, true]) {
    const meteringSetup = setup(), metering = ok(works.teams.handle(user, { kind: "create", request: meteringSetup.request }));
    const meteringWorkId = metering.work!.workId, firstTask = metering.team!.executions[0]!.taskId;
    unknownGeneration.add(firstTask); failSummary.add(firstTask);
    await queue.flush();
    const firstBinding = bindings(meteringWorkId)[0]!;
    assert.equal(firstBinding.status, "failed");
    assert.equal(works.repo.getReservation(firstBinding.reservationId!)!.state, "released");
    const generation = works.repo.listReservations(meteringWorkId).find(item => item.requestKind === "generation")!;
    assert.equal(generation.bindingId, firstBinding.bindingId); assert.equal(generation.state, "unknown");
    const taskCount = db.listTasks().length, submissionCount = submissions.length;
    await flush();
    assert.equal(bindings(meteringWorkId).length, 1);
    assert.equal(db.listTasks().length, taskCount, "unknown generation must not prepare later member/owner tasks");
    assert.equal(submissions.length, submissionCount);
    assert.equal(works.teams.get(meteringWorkId)!.state, "blocked");
    assert(works.repo.listDeliverables(meteringWorkId).some(item => item.executionId === firstBinding.bindingId), "settled result remains visible");
    assert(works.collaboration.history(meteringWorkId).some(item => item.kind === "blocked"), "result reporting is not suppressed by unknown usage");
    assert.equal(works.budget.release(meteringWorkId, generation.reservationId).ok, false, "unknown usage cannot be blindly released");
    assert(works.pauseWork(user, { operationId: `metering-pause:${meteringWorkId}`, workId: meteringWorkId }).ok);
    assert.equal(works.teams.get(meteringWorkId)!.state, "paused", "unknown metering must not mask an explicit pause");
    assert.equal(works.repo.getReservation(generation.reservationId)!.state, "unknown", "pause does not settle unknown usage");
    await flush(); assert.equal(db.listTasks().length, taskCount);
    assert(works.resumeWork(user, { operationId: `metering-resume:${meteringWorkId}`, workId: meteringWorkId }).ok);
    assert.equal(works.teams.get(meteringWorkId)!.state, "blocked", "resume does not forgive metering debt");
    await flush(); assert.equal(db.listTasks().length, taskCount); assert.equal(submissions.length, submissionCount);
    if (replanBeforeReconciliation) {
      assert(works.amendWork(user, { operationId: `metering-amend:${meteringWorkId}`, workId: meteringWorkId,
        goalDescription: "Only inspect the new requirements after reconciling prior provider usage" }).ok);
      reject(works.teams.handle(user, { kind: "replan", workId: meteringWorkId,
        versionGuard: guard(works.getWork(meteringWorkId)!), plan: meteringSetup.plan }), "unsettled_effects");
      assert.equal(works.teams.get(meteringWorkId)!.state, "blocked");
    }
    // Use the existing authenticated reconciliation contract, with explicit fixture
    // evidence of zero usage, rather than mutating the ledger or inventing a receipt.
    const reconciled = works.phase4Control(user, { kind: "reconcile-budget-reservation", operationId: `metering-reconcile:${meteringWorkId}`,
      workId: meteringWorkId, reservationId: generation.reservationId, windowId: generation.windowId,
      resolution: "released", reportedTokens: 0, reason: "Isolated provider fixture verified this rejected request consumed no tokens",
      evidenceRef: `fixture-confirmed-no-usage:${firstTask}`, versionGuard: guard(works.getWork(meteringWorkId)!) });
    assert(reconciled.ok, JSON.stringify(reconciled));
    if (replanBeforeReconciliation) ok(works.teams.handle(user, { kind: "replan", workId: meteringWorkId,
      versionGuard: guard(works.getWork(meteringWorkId)!), plan: meteringSetup.plan }));
    await flush();
    assert.equal(bindings(meteringWorkId).length, replanBeforeReconciliation ? 4 : 3);
    assert.equal(works.teams.get(meteringWorkId)!.state, "awaiting_review");
    assert.equal(submissions.filter(item => item.taskId === firstTask).length, 1, "reconciliation must not replay the failed request");
  }

  // Parallel plans reserve independent identities while dependencies and the owner
  // wait for settled results; a bounded slot never means bypassing resource gates.
  const parallelSetup = setup();
  const thirdBot = `${parallelSetup.name}-c`;
  bots.registerBot({ botId: thirdBot, userId: LOCAL_USER_ID, displayName: "dependent", authorization: grants });
  const parallelRequest = { ...parallelSetup.request, executionPolicy: "parallel" as const, maxConcurrency: 2,
    members: [...parallelSetup.plan.members, { botId: thirdBot, responsibility: "检查已结算的a结果",
      delegatedScope: ["workspace:read" as const], dependsOnBotIds: [parallelSetup.plan.members[0]!.botId] }] };
  reject(works.teams.handle(user, { kind: "create", request: { ...parallelRequest, members: parallelRequest.members.map((member, index) =>
    index === 0 ? { ...member, dependsOnBotIds: [thirdBot] } : member) } }), "invalid_request");
  reject(works.teams.handle(user, { kind: "create", request: { ...parallelRequest, maxConcurrency: 5 } }), "invalid_request");
  reject(works.teams.handle(user, { kind: "create", request: { ...parallelRequest, maxConcurrency: 0 } }), "invalid_request");
  const parallelTemplate = ok(works.teams.handle(user, { kind: "save_template", request: { operationId: "parallel-template", name: "Parallel audit",
    plan: { ownerBotId: parallelRequest.ownerBotId, ownerResponsibility: parallelRequest.ownerResponsibility,
      members: parallelRequest.members, executionPolicy: "parallel", maxConcurrency: 2 } } })).template!;
  assert.equal(parallelTemplate.executionPolicy, "parallel");
  assert.deepEqual(parallelTemplate.members[2]!.dependsOnBotIds, [parallelRequest.members[0]!.botId]);
  const parallel = ok(works.teams.handle(user, { kind: "create", request: parallelRequest }));
  const parallelId = parallel.work!.workId;
  const [pa, pb, pc, po] = parallel.team!.executions;
  runningTasks.add(pa!.taskId); runningTasks.add(pb!.taskId);
  await flush(3);
  assert.equal(bindings(parallelId).length, 2, "two independent members overlap without starting their dependent or owner");
  assert.match(works.teams.get(parallelId)!.executions[2]!.waitingReason!, /等待成员/);
  assert.equal(submissions.filter(item => item.taskId === pb!.taskId)[0]!.input.teamAssignment.previousResults.length, 0,
    "independent member input does not depend on timing of unrelated results");
  assert(works.pauseWork(user, { operationId: `parallel-pause:${parallelId}`, workId: parallelId }).ok);
  await flush(2); assert.equal(bindings(parallelId).length, 2);
  assert(works.resumeWork(user, { operationId: `parallel-resume:${parallelId}`, workId: parallelId }).ok);
  runningTasks.delete(pa!.taskId);
  await flush(3);
  assert(bindings(parallelId).some(binding => binding.taskId === pc!.taskId), "settled prerequisite enables its dependent");
  assert(!bindings(parallelId).some(binding => binding.taskId === po!.taskId), "owner still waits for independent member");
  assert.equal(submissions.filter(item => item.taskId === pc!.taskId)[0]!.input.teamAssignment.previousResults.length, 1);
  runningTasks.delete(pb!.taskId); await flush(4);
  assert.equal(works.teams.get(parallelId)!.state, "awaiting_review");
  for (const member of parallel.team!.executions) assert.equal(submissions.filter(item => item.taskId === member.taskId).length, 1);
  assert(works.handoffOwner(user, { operationId: `parallel-handoff:${parallelId}`, workId: parallelId,
    targetBotId: `${parallelSetup.name}-new-owner` }).ok);
  assert(!collectOwnerSummaryFacts(works, works.getWork(parallelId)!, Date.now()).payload.waitingForBotIds.includes(`${parallelSetup.name}-new-owner`),
    "handoff after a completed owner summary must not invent an unstarted summary for the new owner");
  const stoppedSetup = setup();
  const stopped = ok(works.teams.handle(user, { kind: "create", request: { ...stoppedSetup.request,
    executionPolicy: "parallel", maxConcurrency: 2, members: stoppedSetup.plan.members.map((member, index) =>
      index === 1 ? { ...member, dependsOnBotIds: [stoppedSetup.plan.members[0]!.botId] } : member) } }));
  const stoppedId = stopped.work!.workId, stoppedFirst = stopped.team!.executions[0]!, stoppedSecond = stopped.team!.executions[1]!;
  runningTasks.add(stoppedFirst.taskId); await flush(2);
  const stoppedBinding = bindings(stoppedId)[0]!;
  assert(works.reconcileExecution({ kind: "system", reason: "fixture-native-stop" }, { bindingId: stoppedBinding.bindingId,
    outcome: "stopped", usageTokens: 0, note: "STOPPED_WITHOUT_ARTIFACT" }).ok);
  assert.equal(works.repo.listDeliverables(stoppedId).length, 0);
  await flush(4);
  const stoppedInput = submissions.find(item => item.taskId === stoppedSecond.taskId)!.input.teamAssignment.previousResults;
  assert.equal(stoppedInput.length, 1, "a predecessor without a deliverable must remain visible");
  assert.equal(stoppedInput[0]!.status, "no_deliverable");
  assert(JSON.stringify(stoppedInput).includes("STOPPED_WITHOUT_ARTIFACT"));
  assert(JSON.stringify(stoppedInput).includes('"executionStatus":"stopped"'));
  const debtSetup = setup();
  const debt = ok(works.teams.handle(user, { kind: "create", request: { ...debtSetup.request,
    executionPolicy: "parallel", maxConcurrency: 2 } }));
  const debtId = debt.work!.workId;
  for (const row of debt.team!.executions.slice(0, 2)) runningTasks.add(row.taskId);
  await flush(3);
  const debtBindings = bindings(debtId); assert.equal(debtBindings.length, 2);
  const charged = debtBindings[0]!;
  const admission = works.budget.admitProviderRequest({ taskId: charged.taskId, conversationId: charged.conversationId,
    generationTaskId: 88, sourceKind: "main", requestKind: "generation", estimatedTokens: 100 });
  assert(admission.allowed && admission.reservationId);
  assert(works.budget.settleProviderUsage({ taskId: charged.taskId, conversationId: charged.conversationId,
    generationTaskId: 88, reported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).ok);
  for (const row of debt.team!.executions.slice(0, 2)) runningTasks.delete(row.taskId);
  await flush(3);
  assert.equal(bindings(debtId).length, 2, "unknown usage fences the owner without replaying or replacing either member");
  assert(bindings(debtId).every(binding => binding.status === "completed"), "in-flight members can settle their original attempts");
  assert.equal(works.teams.get(debtId)!.state, "blocked");
  const reservation = works.repo.getReservation(admission.reservationId)!;
  assert(works.phase4Control(user, { kind: "reconcile-budget-reservation", operationId: `parallel-debt:${debtId}`, workId: debtId,
    reservationId: reservation.reservationId, windowId: reservation.windowId, resolution: "released", reportedTokens: 0,
    reason: "Fixture confirmed rejected provider request had zero usage", evidenceRef: "fixture:parallel-zero-usage",
    versionGuard: guard(works.getWork(debtId)!) }).ok);
  await flush(3);
  assert.equal(works.teams.get(debtId)!.state, "awaiting_review");
  for (const row of debt.team!.executions) assert.equal(submissions.filter(item => item.taskId === row.taskId).length, 1);
  console.log("Parallel team: bounded overlapping members, dependency snapshots, owner barrier and pause/resume passed");

  // Authority loss is checked before writes; no baseline widening or model-claimed acceptance.
  const deniedSetup = setup(); authority = false;
  reject(works.teams.handle(user, { kind: "create", request: deniedSetup.request }), "team_error"); authority = true;
  assert.deepEqual(errors, []);
  console.log("Team service: atomic admission, bounded authorization, templates, frozen native dispatch, resource isolation, retry, revocation isolation, explicit replan and unknown-effect fencing passed");
} finally { await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
