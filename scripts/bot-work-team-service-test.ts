import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkCompletionCoordinator } from "../src/main/agent/work/WorkCompletionCoordinator";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { workDeliveryResults } from "../src/main/agent/work/WorkDeliveryArtifacts";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { LOCAL_USER_ID, type WorkActor, type WorkDto } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { collectOwnerSummaryFacts } from "../src/main/agent/work/WorkOwnerSummaryFacts";
import type { WorkTeamControlResult, WorkTeamPlan } from "../src/shared/bot-work-team";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "team-service-")), workspace = join(root, "workspace");
mkdirSync(workspace); writeFileSync(join(workspace, "input.txt"), "verified input");
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
let authority = true;
const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
const receipts = new Map<string, AgentSubmissionReceipt>();
const submissions: Array<{ taskId: string; botId: string; input: { teamAssignment: { role: string; botId: string; displayName: string; previousResults: Array<{ status: string; botId: string; displayName: string; responsibility: string; summary: string; bindingId?: string }> } } }> = [];
const failPrepare = new Set<string>();
const failSummary = new Set<string>();
const unknownGeneration = new Set<string>();
const runningTasks = new Set<string>();
const heldPrepares = new Map<string, Promise<void>>();
const errors: unknown[] = [];
const port: WorkExecutionPort = {
  prepare: async taskId => {
    await heldPrepares.get(taskId);
    if (failPrepare.has(taskId)) throw Error("fixture preparation unavailable before submission");
    return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: workspace };
  },
  find: async binding => receipts.get(binding.bindingId),
  submit: async (binding, text) => {
    assert.equal(works.checkTaskInput(binding.taskId, binding.operationId), undefined);
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
    submissions.push({ taskId: binding.taskId, botId: binding.botId, input: JSON.parse(text) });
    receipts.set(binding.bindingId, receipt); return receipt;
  },
  inspect: async binding => runningTasks.has(binding.taskId) ? ({ status: "running" }) : ({ status: failSummary.has(binding.taskId) ? "failed" : "completed", summary: `actual fixture result from ${binding.botId}`,
    failureReason: failSummary.has(binding.taskId) ? "fixture provider ended after partial findings" : undefined,
    hasWriteConflicts: false, artifactRefs: [], usageTokens: unknownGeneration.has(binding.taskId) ? undefined : 2 }),
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
    criteria: ["有来源的团队成果并明确缺口"] };
  return { name, plan, request };
}
async function flush(count = 5) { for (let i = 0; i < count; i++) {
  await queue.drain();
  for (const id of works.automaticCompletion.pending()) if (works.transaction(() => works.automaticCompletion.outcome(id)))
    works.automaticCompletion.recordDelivery(id,"fixture report delivered");
  works.automaticCompletion.drain();
} }
const bindings = (workId: string) => works.repo.listBindings(workId);
const countWorks = () => works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length;
async function verifyResultReplanning(): Promise<void> {
  const loopDb = new AppDatabase(join(root, "result-replan.db")), loopBots = new BotRegistry(loopDb.connection);
  try {
  for (const botId of ["loop-owner", "loop-a", "loop-b"]) loopBots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
  const loopWorks = new WorkService(loopDb.connection, { bots: loopBots, isAuthority: () => true });
  const feedback = new WorkConversationFeedback({ db: loopDb.connection, works: loopWorks, userId: LOCAL_USER_ID, isAuthority: () => true });
  const source = feedback.messages.accept(LOCAL_USER_ID, { botId: "loop-owner", requestId: "loop-request", text: "核对两个来源并交付结果" });
  const created = loopWorks.transaction(() => {
    const result = ok(loopWorks.teams.createFromForeground({ kind: "bot", userId: LOCAL_USER_ID, botId: "loop-owner", host: "foreground", grants }, {
    operationId: "loop-team", title: "核对两个来源", goalDescription: "核对两个来源并交付结果", criteria: ["两个来源均有核对结果"],
    workspacePath: workspace, conversationId: source.conversationId, sourceMessageId: source.userMessageId,
    taskAssignment: { ownerResponsibility: "汇总两份核对结果", members: [
            { botId: "loop-a", responsibility: "核对来源 A" }, { botId: "loop-b", responsibility: "核对来源 B" }] } }));
    feedback.messages.linkWorkUserInput(feedback.messages.receipt(LOCAL_USER_ID, "loop-owner", "loop-request")!, result.work!);
    return result;
  });
  const workId = created.work!.workId;
  const loopReceipts = new Map<string, AgentSubmissionReceipt>(), submitted: string[] = [], reviews: number[] = [];
  const loopAdapter = new WorkExecutionAdapter(loopWorks, {
    prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: workspace }),
    find: async binding => loopReceipts.get(binding.bindingId),
    submit: async binding => {
      submitted.push(binding.taskId);
      const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
      loopReceipts.set(binding.bindingId, receipt); return receipt;
    },
    inspect: async binding => {
      const assignment = z.object({ teamAssignment: z.object({ responsibility: z.string(), planRevision: z.number() }) })
        .parse(JSON.parse(loopWorks.repo.executionInput(binding))).teamAssignment;
      return { status: "completed", artifactRefs: [], hasWriteConflicts: false,
        summary: binding.botId === "loop-b" && assignment.planRevision === 1 ? "原读取方法未能核对来源 B，仍缺来源 B 的结果。"
          : `${assignment.responsibility}已核对，保留真实来源结果。` };
    },
    stop: async () => {},
  }, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
  const loopQueue = new WorkDispatchQueue(loopDb, loopWorks, loopAdapter, () => true, () => "fixture");
  const coordinator = new WorkCompletionCoordinator({ db: loopDb.connection, works: loopWorks, isAuthority: () => true,
    review: async input => {
      const context = z.object({ teamReplanning: z.object({ planRevision: z.number() }), resultVerification: z.array(z.object({
        deliverableId: z.string(), producerBotId: z.string(), summary: z.string() })) }).parse(input.context);
      reviews.push(context.teamReplanning.planRevision);
      if (context.teamReplanning.planRevision === 1) {
        const failure = context.resultVerification.find(item => item.producerBotId === "loop-b")!;
        return { decision: "continue", outcome: "partial", reply: "来源 A 已核对，改用另一种方法完成来源 B。",
          missing: [{ task: "只补来源 B 核对", requestExcerpt: "核对两个来源并交付结果" }],
          teamReplan: { executionPolicy: "parallel", taskAssignment: { ownerResponsibility: "汇总保留的 A 与补齐的 B", members: [
            { botId: "loop-b", responsibility: "换用可用来源，只补来源 B 核对" }] },
            evidence: [{ deliverableId: failure.deliverableId, quote: failure.summary }] } };
      }
      return { decision: "deliver", outcome: "completed", reply: "两个来源均已核对，结果完整交付。", missing: [] };
    },
    deliver: input => feedback.deliverCompletion(input), wake: () => {} });
  try {
    for (let round = 0; round < 40 && loopWorks.getWork(workId)!.lifecycle !== "closed"; round++) {
      await loopQueue.drain(); coordinator.wake(); await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(reviews, [1, 2], "result coordinator revises the original plan, then reviews the actual replacement result");
    assert.equal(loopWorks.getWork(workId)!.closureConclusion, "succeeded");
    assert.equal(loopWorks.getWork(workId)!.intentRevision, created.work!.intentRevision);
    assert.equal(loopWorks.teams.get(workId)!.planRevision, 2);
    assert.equal(loopWorks.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, 1);
    const allBindings = loopWorks.repo.listBindings(workId);
    assert.equal(allBindings.filter(binding => binding.botId === "loop-a").length, 1, "completed A is reused across the entire result loop");
    assert.equal(allBindings.filter(binding => binding.botId === "loop-b").length, 2, "only unfinished B gets a new strategy execution");
    assert.equal(new Set(submitted).size, submitted.length, "each execution is submitted once");
    const reports = loopDb.connection.prepare("SELECT metadata_json FROM bot_work_feedback WHERE json_extract(metadata_json,'$.workId')=? AND json_extract(metadata_json,'$.report.completion') IS NOT NULL")
      .all(workId).map(value => JSON.parse(z.object({ metadata_json: z.string() }).parse(value).metadata_json));
    assert(reports.some(report => report.report.completion.nextStep === "continue"), "the original conversation receives the admitted strategy change");
    assert(reports.some(report => report.report.completion.outcome === "completed"), "the original conversation receives final delivery before closure");
    const finalOwner = allBindings.filter(binding => binding.botId === "loop-owner").at(-1)!;
    assert(workDeliveryResults(loopWorks, finalOwner).some(result => result.producerBotId === "loop-a"), "final delivery retains the omitted completed member's result");
  } finally { coordinator.close(); feedback.close(); await loopQueue.close(); await loopAdapter.close(); }
  } finally { loopDb.close(); }
}
try {
  // User-only validated atomic admission; templates confer no authorization.
  const initial = setup();
  const emptyScopePlan = { ...initial.plan, members: initial.plan.members.map(member => ({ ...member, delegatedScope: [] })) };
  const noGrantTemplate = ok(works.teams.handle(user, { kind: "save_template", request: { operationId: "no-grant-template", name: "No retired grants", plan: emptyScopePlan } })).template!;
  assert(noGrantTemplate.members.every(member => member.delegatedScope.length === 0), "new Bots can create teams without retired grants");
  ok(works.teams.handle(user, { kind: "delete_template", templateId: noGrantTemplate.templateId }));
  reject(works.teams.handle({ kind: "bot", userId: LOCAL_USER_ID, botId: initial.plan.ownerBotId, host: "foreground", grants }, { kind: "create", request: initial.request }), "unauthorized_actor");
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
  const ownedRequest = { ...initial.request, operationId: "owned-team-work", templateId: template.templateId };
  // Legacy empty/expired grants do not constrain a current user's active members.
  for (const memberId of [initial.plan.ownerBotId, ...initial.plan.members.map(member => member.botId)])
    db.connection.prepare("UPDATE bots SET authorization_json=? WHERE bot_id=?").run(JSON.stringify({
      allowedScopes: [], targetWhitelist: ["/obsolete"], expiresAt: 1, allowRedelegation: false,
    }), memberId);
  const owned = ok(works.teams.handle({ ...user, grants: { allowedScopes: [], targetWhitelist: ["/obsolete"],
    expiresAt: 1, allowRedelegation: false, allowGitBranchOrWorktree: false } }, { kind: "create", request: ownedRequest }));
  assert.equal(owned.team?.teamId, template.templateId);
  assert.equal(owned.team?.teamName, "Audit");
  assert.equal(ok(works.teams.handle(user, { kind: "create", request: ownedRequest })).work?.workId, owned.work?.workId);
  reject(works.teams.handle(user, { kind: "create", request: { ...ownedRequest, operationId: "unknown-owning-team", templateId: "missing" } }), "not_found");
  reject(works.teams.handle(user, { kind: "create", request: { ...ownedRequest, operationId: "wrong-team-owner", ownerBotId: `${initial.name}-new-owner` } }), "invalid_team");
  const updateTeam = { kind: "update_template" as const, templateId: template.templateId, name: "Audit revised", plan: { ...initial.plan, ownerResponsibility: "Updated coordination" }, expected: { name: "Audit", plan: initial.plan } };
  assert.equal(ok(works.teams.handle(user, updateTeam)).template?.templateId, template.templateId);
  assert.equal(ok(works.teams.handle(user, updateTeam)).replayed, true);
  reject(works.teams.handle(user, { ...updateTeam, name: "Stale update" }), "team_changed");
  reject(works.teams.handle({ kind: "user", userId: "foreign-user", grants }, updateTeam), "not_found");
  assert.equal(works.teams.get(owned.work!.workId)?.teamName, "Audit", "settings changes do not rewrite existing execution ownership snapshot");
  ok(works.teams.handle(user, { kind: "delete_template", templateId: template.templateId }));
  assert.equal(works.teams.get(owned.work!.workId)?.teamName, "Audit", "historical team ownership survives template deletion");
  reject(works.teams.handle(user, { kind: "save_template", request: { operationId: "template-one", name: "Audit", plan: initial.plan } }), "not_found");

  assert.ok(ok(works.teams.handle(user, { kind: "list_templates", includeDeleted: true })).templates?.find(item => item.templateId === template.templateId)?.deletedAt);
  const restored = ok(works.teams.handle(user, { kind: "restore_template", templateId: template.templateId })).template!;
  assert.equal(restored.templateId, template.templateId); assert.equal(restored.deletedAt, undefined);
  const target = ok(works.teams.handle(user, { kind: "save_template", request: { operationId: "move-target", name: "Moved team", plan: initial.plan } })).template!;
  const oldExecutions = works.teams.get(owned.work!.workId)!.executions.map(item => item.taskId);
  const moved = ok(works.teams.handle(user, { kind: "set_work_team", workId: owned.work!.workId, templateId: target.templateId }));
  assert.equal(moved.team?.teamId, target.templateId); assert.deepEqual(moved.team?.executions.map(item => item.taskId), oldExecutions);
  reject(works.teams.handle({ kind: "user", userId: "foreign-user", grants }, { kind: "set_work_team", workId: owned.work!.workId, templateId: target.templateId }), "not_found");
  reject(works.teams.handle(user, { kind: "remove_work", workId: owned.work!.workId }), "work_not_ended");
  assert.equal(works.closeWork(user, { operationId: "end-management-fixture", workId: owned.work!.workId, conclusion: "cancelled", versionGuard: guard(works.getWork(owned.work!.workId)!) }).ok, true);
  assert.equal(works.getWork(owned.work!.workId)?.lifecycle, "closed");
  assert.ok(ok(works.teams.handle(user, { kind: "remove_work", workId: owned.work!.workId })).team?.removedAt);
  assert.ok(works.getWork(owned.work!.workId), "recoverable removal never destroys Work");
  assert.equal(ok(works.teams.handle(user, { kind: "restore_work", workId: owned.work!.workId })).team?.removedAt, undefined);
  assert.deepEqual(works.teams.get(owned.work!.workId)!.executions.map(item => item.taskId), oldExecutions);
  ok(works.teams.handle(user, { kind: "delete_template", templateId: target.templateId }));
  ok(works.teams.handle(user, { kind: "delete_template", templateId: template.templateId }));

  // Explicit deletion stops only its own Work and persists until native settlement.
  const removalSetup = setup(), removal = ok(works.teams.handle(user, { kind: "create", request: removalSetup.request }));
  const removalId = removal.work!.workId;
  const untouchedSetup = setup(), untouched = ok(works.teams.handle(user, { kind: "create", request: untouchedSetup.request }));
  reject(works.teams.handle({ ...user, userId: "foreign" }, { kind: "stop_and_remove_work", workId: removalId }), "not_found");
  const removed = ok(works.teams.handle(user, { kind: "stop_and_remove_work", workId: removalId }));
  assert.equal(removed.work?.lifecycle, "closed"); assert.ok(removed.team?.removedAt);
  assert.equal(works.getWork(untouched.work!.workId)?.lifecycle, "active");
  assert.equal(ok(works.teams.handle(user, { kind: "stop_and_remove_work", workId: removalId })).team?.removedAt, removed.team?.removedAt);
  assert.equal(ok(works.teams.handle(user, { kind: "restore_work", workId: removalId })).team?.removalRequestedAt, undefined);
  assert.equal(works.getWork(removalId)?.lifecycle, "closed", "restore never reruns cancelled work");

  const stoppingSetup = setup(), stopping = ok(works.teams.handle(user, { kind: "create", request: stoppingSetup.request }));
  for (const item of stopping.team!.executions) runningTasks.add(item.taskId);
  await queue.drain();
  const liveBindings = bindings(stopping.work!.workId);
  assert.ok(liveBindings.some(item => item.status === "running"));
  const pendingRemoval = ok(works.teams.handle(user, { kind: "stop_and_remove_work", workId: stopping.work!.workId }));
  assert.ok(pendingRemoval.team?.removalRequestedAt); assert.equal(pendingRemoval.team?.removedAt, undefined);
  assert.equal(pendingRemoval.work?.lifecycle, "closing", "running work stays visible until stop settles");
  for (const binding of liveBindings) {
    runningTasks.delete(binding.taskId);
    assert(works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "failed", note: "Fixture confirmed native termination" }).ok);
  }
  works.settlePendingClosure(stopping.work!.workId);
  const reopened = new WorkService(db.connection, { bots, isAuthority: () => authority });
  reopened.teams.finishRequestedRemoval(stopping.work!.workId);
  assert.ok(reopened.teams.get(stopping.work!.workId)?.removedAt, "persisted request completes after restart and stop receipt");

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
  // A pending creation from before quota removal can resolve its original
  // operation without replaying a differently hashed creation request.
  const beforeLookup = { works: countWorks(), tasks: db.listTasks().length, bindings: bindings(workId).length,
    work: works.getWork(workId), team: works.teams.get(workId), submissions: submissions.length };
  const lookup = { kind: "get_by_operation" as const, operationId: initial.request.operationId };
  const found = ok(works.teams.handle(user, lookup));
  assert.equal(found.operationId, initial.request.operationId); assert.equal(found.replayed, true);
  assert.deepEqual(found.work, beforeLookup.work); assert.deepEqual(found.team, beforeLookup.team);
  reject(works.teams.handle({ kind: "user", userId: "foreign-user", grants }, lookup), "not_found");
  reject(works.teams.handle(user, { ...lookup, operationId: "missing-team-operation" }), "not_found");
  const priorHash = (db.connection.prepare("SELECT request_hash FROM work_teams WHERE work_id=?").get(workId) as { request_hash: string }).request_hash;
  db.connection.prepare("UPDATE work_teams SET request_hash=? WHERE work_id=?").run("historical-request-with-retired-budget-field", workId);
  try {
    reject(works.teams.handle(user, { kind: "create", request: initial.request }), "idempotency_conflict");
    const historical = ok(works.teams.handle(user, lookup));
    assert.equal(historical.operationId, initial.request.operationId); assert.equal(historical.replayed, true);
    assert.deepEqual(historical.work, beforeLookup.work); assert.deepEqual(historical.team, beforeLookup.team);
    assert.equal((db.connection.prepare("SELECT request_hash FROM work_teams WHERE work_id=?").get(workId) as { request_hash: string }).request_hash,
      "historical-request-with-retired-budget-field", "lookup never rewrites the original creation receipt");
  } finally { db.connection.prepare("UPDATE work_teams SET request_hash=? WHERE work_id=?").run(priorHash, workId); }
  assert.deepEqual({ works: countWorks(), tasks: db.listTasks().length, bindings: bindings(workId).length,
    work: works.getWork(workId), team: works.teams.get(workId), submissions: submissions.length }, beforeLookup,
    "lookup neither creates work/tasks nor changes the existing operation");
  queue.enqueue(works.getWork(workId)!, "must-not-schedule-owner");
  assert.equal((db.connection.prepare("SELECT count(*) n FROM work_dispatch_requests WHERE work_id=?").get(workId) as { n: number }).n, 0);
  await queue.drain(); assert.equal(bindings(workId).length, 1);
  await flush(); assert.equal(bindings(workId).length, 3);
  assert.equal(works.teams.get(workId)!.state, "ended_unsuccessfully");
  assert.equal(works.getWork(workId)!.lifecycle, "closed");
  assert(works.repo.listDeliverables(workId).every(result => result.status === "proposed"));
  const ownerInput = submissions.find(item => item.taskId === created.team!.executions[2]!.taskId)!.input.teamAssignment;
  assert.equal(ownerInput.role, "owner_summary"); assert.equal(ownerInput.previousResults.length, 2);
  assert(ownerInput.previousResults.every(item => item.status === "proposed"));
  assert.equal(ownerInput.displayName, "owner");
  assert.deepEqual(ownerInput.previousResults.map(item => [item.displayName, item.responsibility]),
    [["a", "独立检查 a"], ["b", "独立检查 b"]], "host names and assigned responsibilities reach the owner together");
  for (const result of ownerInput.previousResults) {
    assert.equal(result.summary, `actual fixture result from ${result.botId}`, "raw member evidence remains unchanged");
    assert(result.bindingId, "technical provenance remains available for inspection");
  }
  const display = (works.teams as unknown as { memberDisplayName(work: WorkDto, botId: string): string }).memberDisplayName.bind(works.teams);
  bots.registerBot({ botId: "foreign-readable-name", userId: "different-user", displayName: "PRIVATE NAME", authorization: grants });
  assert.equal(display(works.getWork(workId)!, "foreign-readable-name"), "成员名称不可用", "never reveal another user's registry name");
  assert.equal(display(works.getWork(workId)!, "missing-bot"), "成员名称不可用", "missing identities are not guessed");

  const sent = submissions.length; await flush(); assert.equal(submissions.length, sent);
  assert.equal(works.collaboration.history(workId).filter(message => message.kind === "result").length, 3);

  // Retired shared-resource gate: team identity, bindings and directory ownership stay,
  // but there is no per-resource authorization hook left to call.
  assert.equal(works.repo.listBindings(workId).length, 3);

  // Preparation failure can retry only with the current versions and no binding.
  const retrySetup = setup(), retry = ok(works.teams.handle(user, { kind: "create", request: retrySetup.request }));
  const retryTask = retry.team!.executions[0]!.taskId;
  failPrepare.add(retryTask); await queue.drain();
  assert.equal(works.teams.get(retry.work!.workId)!.state, "blocked"); assert.equal(bindings(retry.work!.workId).length, 0);
  reject(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(retry.work!), confirmNotStarted: true }), "version_conflict");
  failPrepare.delete(retryTask);
  ok(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(works.getWork(retry.work!.workId)!), confirmNotStarted: true }));
  await flush(); assert.equal(bindings(retry.work!.workId)[0]!.taskId, retryTask);
  reject(works.teams.handle(user, { kind: "retry", workId: retry.work!.workId, versionGuard: guard(works.getWork(retry.work!.workId)!), confirmNotStarted: true }), "invalid_lifecycle_transition");

  // Revoked owner/reporting rights block only that team; independent teams still proceed.
  const pausedSetup = setup(), paused = ok(works.teams.handle(user, { kind: "create", request: pausedSetup.request }));
  await queue.drain();
  db.connection.prepare("UPDATE bots SET status='paused' WHERE bot_id=?").run(pausedSetup.plan.ownerBotId);
  const independentSetup = setup(), independent = ok(works.teams.handle(user, { kind: "create", request: independentSetup.request }));
  await flush();
  assert.equal(works.teams.get(paused.work!.workId)!.state, "blocked");
  assert.equal(works.teams.get(independent.work!.workId)!.state, "ended_unsuccessfully");
  db.connection.prepare("UPDATE bots SET status='active' WHERE bot_id=?").run(pausedSetup.plan.ownerBotId);
  await flush(); assert.equal(works.teams.get(paused.work!.workId)!.state, "ended_unsuccessfully");

  // Changed requirements never silently repeat prior effects; explicit replan retains history.
  const replanSetup = setup();
  const replanWork = ok(works.teams.handle(user, { kind: "create", request: replanSetup.request }));
  const replanWorkId = replanWork.work!.workId;
  await flush(1); // Change requirements before owner delivery, not after automatic closure.
  const originalTasks = bindings(replanWorkId).map(item => item.taskId);
  const amended = works.amendWork(user, { operationId: "new-requirements", workId: replanWorkId, goalDescription: "Check updated input separately" });
  assert(amended.ok); assert.equal(works.teams.get(replanWorkId)!.state, "superseded");
  await flush(); assert.deepEqual(bindings(replanWorkId).map(item => item.taskId), originalTasks);
  const revisedPlan = { ...replanSetup.plan, members: [replanSetup.plan.members[1]!] };
  const replanned = ok(works.teams.handle(user, { kind: "replan", workId: replanWorkId, versionGuard: guard(works.getWork(replanWorkId)!), plan: revisedPlan }));
  assert.equal(replanned.team!.executions.length, 2);
  assert.deepEqual(works.getWork(replanWorkId)!.participants.map(item => item.botId), [replanSetup.plan.members[1]!.botId]);
  assert.match(works.repo.executionInput(bindings(replanWorkId)[0]!), /teamAssignment/, "old immutable team input remains available");
  await flush(); assert.equal(bindings(replanWorkId).length, originalTasks.length + 2);
  reject(works.teams.handle(user, { kind: "replan", workId: replanWorkId, versionGuard: guard(works.getWork(replanWorkId)!), plan: revisedPlan }), "invalid_request");

  // Strategy revisions keep the same user goal and completed work. Only the
  // replacement of a live assignment waits; a new independent member advances.
  const strategySetup = setup();
  const strategy = ok(works.teams.handle(user, { kind: "create", request: { ...strategySetup.request, executionPolicy: "parallel" } }));
  const strategyId = strategy.work!.workId, completedTask = strategy.team!.executions[0]!.taskId;
  const replacedTask = strategy.team!.executions[1]!.taskId;
  runningTasks.add(replacedTask);
  await queue.drain(); await queue.drain();
  assert.equal(works.repo.bindingForTask(completedTask)?.status, "completed");
  assert.equal(works.repo.bindingForTask(replacedTask)?.status, "running");
  const originalIntent = works.getWork(strategyId)!.intentRevision;
  const strategyPlan: WorkTeamPlan = { ...strategySetup.plan, executionPolicy: "parallel", maxConcurrency: 2,
    members: [strategySetup.plan.members[0]!, { ...strategySetup.plan.members[1]!, responsibility: "只补 B 缺失的实际验证" },
      { botId: `${strategySetup.name}-new-owner`, responsibility: "独立检查新增来源", delegatedScope: ["workspace:read"] }] };
  const strategyRequest = { kind: "replan" as const, operationId: "strategy-revision", workId: strategyId,
    versionGuard: guard(works.getWork(strategyId)!), plan: strategyPlan };
  const strategyResult = ok(works.teams.handle(user, strategyRequest));
  assert.equal(strategyResult.work!.intentRevision, originalIntent);
  assert.equal(strategyResult.team!.planRevision, 2);
  assert.equal(strategyResult.team!.executions[0]!.taskId, completedTask);
  const replacementTask = strategyResult.team!.executions[1]!.taskId, independentTask = strategyResult.team!.executions[2]!.taskId;
  assert.notEqual(replacementTask, replacedTask);
  assert(works.repo.bindingForTask(replacedTask)?.invalidatedAt);
  assert.equal(ok(works.teams.handle(user, strategyRequest)).replayed, true, "lost replan receipts reuse the same revision and tasks");
  reject(works.teams.handle(user, { ...strategyRequest, plan: { ...strategyPlan, ownerResponsibility: "another plan" } }), "idempotency_conflict");
  reject(works.teams.handle(user, { ...strategyRequest, operationId: "stale-strategy" }), "version_conflict");
  await queue.drain(); await queue.drain();
  assert(works.repo.bindingForTask(independentTask), "independent C starts while old B is still running");
  assert.equal(works.repo.bindingForTask(replacementTask), undefined, "new B cannot race its unconfirmed predecessor");
  assert.equal(submissions.filter(item => item.taskId === completedTask).length, 1, "completed A is never rerun");
  const oldB = works.repo.bindingForTask(replacedTask)!;
  works.repo.insertAdmission({ admissionId: "replan-unknown-effect", workId: strategyId, bindingId: oldB.bindingId,
    operationId: "original-effect-identity", actionKind: "write", state: "unknown", intentRevision: oldB.intentRevision,
    ownerEpoch: oldB.ownerEpoch, admittedAt: Date.now() });
  runningTasks.delete(replacedTask); await queue.drain(); await queue.drain();
  assert(works.repo.bindingForTask(replacementTask), "settled old execution releases only its replacement");
  assert.equal(works.repo.listAdmissions(strategyId).find(item => item.operationId === "original-effect-identity")?.state, "unknown");
  const replacementInput = JSON.parse(works.repo.executionInput(works.repo.bindingForTask(replacementTask)!));
  assert.equal(replacementInput.teamAssignment.planRevision, 2);
  assert(replacementInput.teamAssignment.uncertainOperations.some((item: { operationId: string }) => item.operationId === "original-effect-identity"));
  assert.equal(works.teams.get(strategyId)!.executions[1]!.taskId, replacementTask, "late old receipt never replaces the current assignment");
  assert.equal(new WorkService(db.connection, { bots, isAuthority: () => authority }).teams.get(strategyId)!.planRevision, 2, "plan revision survives service restart");
  const remaining = ok(works.teams.handle(user, { kind: "replan", operationId: "omit-completed-member", workId: strategyId,
    versionGuard: guard(works.getWork(strategyId)!), plan: { ...strategyPlan, members: strategyPlan.members.slice(1) } }));
  await queue.drain(); await queue.drain();
  const remainingOwner = works.repo.bindingForTask(remaining.team!.executions.at(-1)!.taskId)!;
  const remainingInput = JSON.parse(works.repo.executionInput(remainingOwner));
  assert(remainingInput.teamAssignment.previousResults.some((result: { bindingId: string }) => result.bindingId === works.repo.bindingForTask(completedTask)!.bindingId),
    "omitting already completed A from the remaining plan preserves A's deliverable in the new owner's input");
  await flush();

  // A native prepare that completes after a replan cannot submit or attach its
  // failure to the replacement that now occupies the old ordinal.
  const lateSetup = setup(), late = ok(works.teams.handle(user, { kind: "create", request: lateSetup.request }));
  const retiredPrepareTask = late.team!.executions[0]!.taskId;
  let releasePrepare!: () => void;
  heldPrepares.set(retiredPrepareTask, new Promise<void>(resolve => { releasePrepare = resolve; }));
  await queue.flush();
  const latePlan = { ...lateSetup.plan, members: [{ ...lateSetup.plan.members[0]!, responsibility: "改用新方法核对缺项" }] };
  const lateReplan = ok(works.teams.handle(user, { kind: "replan", operationId: "late-prepare-replan", workId: late.work!.workId,
    versionGuard: guard(works.getWork(late.work!.workId)!), plan: latePlan }));
  releasePrepare(); heldPrepares.delete(retiredPrepareTask);
  await queue.drain(); await flush();
  assert.equal(works.repo.bindingForTask(retiredPrepareTask), undefined);
  assert(!submissions.some(item => item.taskId === retiredPrepareTask));
  assert(works.repo.bindingForTask(lateReplan.team!.executions[0]!.taskId));
  assert.equal(works.teams.get(late.work!.workId)!.executions[0]!.error, undefined);

  // Real foreground ownership can resume a changed goal without impersonating
  // a user; result-owned replanning needs no additional user message.
  const foregroundSetup = setup(), foreground = ok(works.teams.handle(user, { kind: "create", request: foregroundSetup.request }));
  const foregroundId = foreground.work!.workId;
  assert(works.amendWork(user, { operationId: "foreground-goal-change", workId: foregroundId, goalDescription: "只检查剩余的新要求" }).ok);
  const messages = new BotConversationRepository(db.connection);
  const foregroundActor: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: foregroundSetup.plan.ownerBotId, host: "foreground", grants };
  const source = messages.accept(LOCAL_USER_ID, { botId: foregroundSetup.plan.ownerBotId, requestId: "foreground-replan-message", text: "按新要求继续" });
  const foregroundInput = { workId: foregroundId, operationId: "foreground-replan", conversationId: source.conversationId,
    sourceMessageId: source.userMessageId, versionGuard: guard(works.getWork(foregroundId)!), taskAssignment: {
      ownerResponsibility: "核对新目标与剩余成果", members: [{ botId: foregroundSetup.plan.members[1]!.botId, responsibility: "完成剩余的新要求" }] } };
  reject(works.teams.replanFromForeground(foregroundActor, { ...foregroundInput, sourceMessageId: "forged" }), "unauthorized_actor");
  reject(works.teams.replanFromForeground(user, foregroundInput), "unauthorized_actor");
  reject(works.teams.replanFromForeground({ ...foregroundActor, botId: foregroundSetup.plan.members[0]!.botId }, foregroundInput), "unauthorized_actor");
  const foregroundReplan = ok(works.teams.replanFromForeground(foregroundActor, foregroundInput));
  assert.equal(foregroundReplan.team!.planRevision, 2);
  for (let round = 0; round < 4; round++) await queue.drain();
  const ownerResult = works.repo.bindingForTask(foregroundReplan.team!.executions.at(-1)!.taskId)!;
  assert.equal(ownerResult.status, "completed");
  const resultInput = { operationId: "owner-result-replan", executionPolicy: "sequential" as const, maxConcurrency: 1,
    versionGuard: guard(works.getWork(foregroundId)!), taskAssignment: {
    ownerResponsibility: "复核剩余验证是否完成", members: [{ botId: foregroundSetup.plan.members[1]!.botId, responsibility: "只补结果核对发现的缺项" }] } };
  const ownerReplan = ok(works.teams.replanFromResult(ownerResult, resultInput));
  assert.equal(ownerReplan.work!.intentRevision, foregroundReplan.work!.intentRevision);
  assert.equal(ownerReplan.team!.planRevision, 3);
  assert.equal(ok(works.teams.replanFromForeground(foregroundActor, foregroundInput)).replayed, true,
    "replaying a foreground request after another strategy revision does not recompute its omitted policy defaults");
  reject(works.teams.replanFromForeground(foregroundActor, { ...foregroundInput, maxConcurrency: 4 }), "idempotency_conflict");
  assert.equal(ok(works.teams.replanFromResult(ownerResult, resultInput)).replayed, true, "a committed result replan is idempotent after its owner task is archived");
  reject(works.teams.replanFromResult(ownerResult, { ...resultInput, operationId: "stale-owner-result" }), "unauthorized_actor");
  await flush();
  await verifyResultReplanning();

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
  assert.equal(works.teams.get(handed.work!.workId)!.state, "ended_unsuccessfully");

  // Pause/cancel before submission does not start a member, and summary failure is not running forever.
  const suspendedSetup = setup(), suspended = ok(works.teams.handle(user, { kind: "create", request: suspendedSetup.request }));
  assert(works.pauseWork(user, { operationId: "pause-team", workId: suspended.work!.workId }).ok);
  await flush(); assert.equal(bindings(suspended.work!.workId).length, 0);
  assert.equal(works.teams.get(suspended.work!.workId)!.state, "paused");
  assert(works.cancelWork(user, { operationId: "cancel-team", workId: suspended.work!.workId }).ok);
  await flush(); assert.equal(bindings(suspended.work!.workId).length, 0);
  assert.equal(works.teams.get(suspended.work!.workId)!.state, "cancelled");
  const failedSetup = setup(), failed = ok(works.teams.handle(user, { kind: "create", request: failedSetup.request }));
  failSummary.add(failed.team!.executions[2]!.taskId); await flush(10);
  assert.equal(works.teams.get(failed.work!.workId)!.state, "ended_unsuccessfully", "failed report is delivered then ended after no progress");
  assert.equal(bindings(failed.work!.workId).length, 4, "one bounded continuation keeps the original owner task identity");
  assert.match(works.teams.get(failed.work!.workId)!.executions[2]!.error!, /没有新进展|恢复已停止/);

  // In-flight/unknown results hold the next member instead of spawning a replacement.
  const uncertainSetup = setup(), uncertain = ok(works.teams.handle(user, { kind: "create", request: uncertainSetup.request }));
  await queue.drain(); const uncertainBinding = bindings(uncertain.work!.workId)[0]!;
  works.transaction(() => works.repo.updateBinding({ ...uncertainBinding, status: "unknown" }));
  await works.teams.dispatchPending(db, adapter, () => "fixture");
  assert.equal(bindings(uncertain.work!.workId).length, 1, "unknown native liveness holds the dependent member");
  assert.equal(bindings(uncertain.work!.workId)[0].status, "unknown");
  assert(works.reconcileExecution(user, { bindingId: uncertainBinding.bindingId, outcome: "failed", note: "Confirmed native termination" }).ok);
  await works.teams.dispatchPending(db, adapter, () => "fixture");
  assert.equal(bindings(uncertain.work!.workId).length, 2, "confirmed terminal member can reuse its report and release the next member");
  assert.equal(bindings(uncertain.work!.workId)[0].status, "failed", "report reuse never rewrites native failure as success");
  assert.equal(bindings(uncertain.work!.workId)[1].taskId, uncertain.team!.executions[1]!.taskId, "the next member keeps its own identity");
  assert.equal(works.teams.get(uncertain.work!.workId)!.executions[0]!.status, "recovered");
  assert.equal(works.teams.get(uncertain.work!.workId)!.executions[0]!.recoveryOutcome, "reused_existing_result");

  // Missing provider metering no longer creates a Work quota hold, while explicit
  // lifecycle controls still apply.
  const meteringSetup = setup(), metering = ok(works.teams.handle(user, { kind: "create", request: meteringSetup.request }));
  const meteringWorkId = metering.work!.workId, firstTask = metering.team!.executions[0]!.taskId;
  unknownGeneration.add(firstTask); runningTasks.add(firstTask);
  await queue.drain();
  const firstBinding = bindings(meteringWorkId)[0]!;
  assert.equal(firstBinding.status, "running");
  assert.equal("budget" in works.getWork(meteringWorkId)!, false);
  const planTasks = () => metering.team!.executions.filter(row => db.getTask(row.taskId)).length;
  assert(works.pauseWork(user, { operationId: `metering-pause:${meteringWorkId}`, workId: meteringWorkId }).ok);
  assert.equal(works.teams.get(meteringWorkId)!.state, "paused");
  await flush(); assert.equal(planTasks(), 1, "removed quotas never override an explicit pause");
  assert(works.resumeWork(user, { operationId: `metering-resume:${meteringWorkId}`, workId: meteringWorkId }).ok);
  await flush(); assert.equal(planTasks(), 1, "resume waits for the still-running member");
  runningTasks.delete(firstTask);
  await flush(6);
  assert.equal(bindings(meteringWorkId).length, 3);
  assert.equal(works.teams.get(meteringWorkId)!.state, "ended_unsuccessfully");
  assert(works.repo.listDeliverables(meteringWorkId).some(item => item.executionId === firstBinding.bindingId), "settled partial result remains visible");
  assert(works.collaboration.history(meteringWorkId).some(item => item.kind === "result"), "member result reporting is retained");
  assert.equal(submissions.filter(item => item.taskId === firstTask).length, 1, "missing usage never causes the request to be replayed");

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
  assert.equal(works.teams.get(parallelId)!.state, "ended_unsuccessfully");
  for (const member of parallel.team!.executions) assert.equal(submissions.filter(item => item.taskId === member.taskId).length, 1);
  assert(works.handoffOwner(user, { operationId: `parallel-handoff:${parallelId}`, workId: parallelId,
    targetBotId: `${parallelSetup.name}-new-owner` }).ok === false);
  assert(!collectOwnerSummaryFacts(works, works.getWork(parallelId)!, Date.now()).payload.waitingForBotIds.includes(`${parallelSetup.name}-new-owner`),
    "closed team rejects handoff and must not invent an unstarted summary");
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
  runningTasks.delete(stoppedFirst.taskId);
  await flush(2);
  const stoppedRecovery = bindings(stoppedId).filter(binding => binding.taskId === stoppedFirst.taskId);
  assert.equal(stoppedRecovery.length, 2, "the failed member continues under its original task identity");
  assert.equal(stoppedRecovery[1]!.botId, stoppedFirst.botId, "recovery keeps the original member identity");
  await flush(4);
  const stoppedInput = submissions.find(item => item.taskId === stoppedSecond.taskId)!.input.teamAssignment.previousResults;
  assert.equal(stoppedInput.length, 1, "the dependent member receives the recovered result");
  assert.equal((stoppedInput[0] as { executionStatus?: string }).executionStatus, "completed");
  assert(JSON.stringify(stoppedInput).includes("actual fixture result"));
  const debtSetup = setup();
  const debt = ok(works.teams.handle(user, { kind: "create", request: { ...debtSetup.request,
    executionPolicy: "parallel", maxConcurrency: 2 } }));
  const debtId = debt.work!.workId;
  for (const row of debt.team!.executions.slice(0, 2)) runningTasks.add(row.taskId);
  await flush(3);
  const debtBindings = bindings(debtId); assert.equal(debtBindings.length, 2);
  unknownGeneration.add(debtBindings[0]!.taskId);
  assert.equal(bindings(debtId).length, 2, "the owner still waits for actual in-flight members");
  for (const row of debt.team!.executions.slice(0, 2)) runningTasks.delete(row.taskId);
  await flush(3);
  assert.equal(bindings(debtId).length, 3, "missing usage does not impose a removed quota gate on the owner");
  assert(bindings(debtId).every(binding => binding.status === "completed"));
  assert.equal(works.teams.get(debtId)!.state, "ended_unsuccessfully");
  assert.equal("budget" in works.getWork(debtId)!, false);
  for (const row of debt.team!.executions) assert.equal(submissions.filter(item => item.taskId === row.taskId).length, 1);
  console.log("Parallel team: bounded overlapping members, dependency snapshots, owner barrier and pause/resume passed");

  // Authority loss is checked before writes; no baseline widening or model-claimed acceptance.
  const deniedSetup = setup(); authority = false;
  reject(works.teams.handle(user, { kind: "create", request: deniedSetup.request }), "team_error"); authority = true;
  assert.deepEqual(errors, []);
  console.log("Team service: atomic admission, bounded authorization, templates, frozen native dispatch, resource isolation, retry, revocation isolation, explicit replan and unknown-effect fencing passed");
} finally { await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
