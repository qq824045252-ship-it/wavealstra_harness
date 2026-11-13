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
const submissions: Array<{ taskId: string; botId: string; input: { teamAssignment: { role: string; botId: string; displayName: string; previousResults: Array<{ status: string; botId: string; displayName: string; responsibility: string; summary: string; bindingId?: string }> } } }> = [];
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
  const template = ok(works.teams.handle(user, { kind: "save_template", request: { operationId: `saved:${name}`, name, plan } })).template!;
  const request = { templateId: template.templateId, operationId: name, ...plan, title: name, goalDescription: "逐项检查输入", workspacePath: workspace,
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
try {
  const config = setup();
  const result = ok(works.teams.handle(user, {kind:"create",request:{...config.request,mode:"watch",watchRule:{cronExpression:"* * * * *",timezone:"UTC",scheduleBasis:"user_specified",notificationMode:"changes_only"}}}));
  const id=result.work!.workId;
  await flush(); assert.equal(bindings(id).length,0,"future team watch does not dispatch before first tick");
  works.teams.requestImmediateWatch(works.getWork(id)!);
  await flush(14);
  assert.equal(bindings(id).length,3,"one round includes both members and owner");
  const ownerInput = submissions.find(s => s.input.teamAssignment.role === "owner_summary")!.input;
  const ownerInstructions = (ownerInput.teamAssignment as unknown as {instructions:string}).instructions;
  assert(ownerInstructions.includes('watch-observation-v1'), 'changes-only owner receives observation output contract');
  assert(!ownerInstructions.includes('bot-team-report-v1'), 'ordinary team report cannot conflict with watch observation');

  assert.equal(works.getWork(id)!.lifecycle,"active");
  assert.equal(works.teams.watchCycles.pending(id),false);
  const first = bindings(id).map(b=>b.taskId);
  const subscription=works.repo.listSubscriptions(id).find(s=>s.source==="cron")!;
  const eventId="second-team-watch-event";
  const work=works.getWork(id)!;
  works.repo.insertInbox({eventId,dedupeKey:eventId,source:"cron",sourceEventId:eventId,eventType:"work.tick",workId:id,subscriptionId:subscription.subscriptionId,
    intentRevision:work.intentRevision,stateVersion:work.stateVersion,ownerEpoch:work.ownerEpoch,
    payload:{scheduledAt:Date.now(),scheduleRevision:subscription.scheduleRevision??1},status:"pending",mergedCount:1,receivedAt:Date.now()});
  await flush(14);
  assert.equal(bindings(id).length,6,"next event launches a new full team round");
  assert.equal(new Set(bindings(id).map(b=>b.taskId)).size,6);
  assert.equal(works.teams.watchCycles.current(id)!.sequence,2);
  assert.equal(works.teams.watchCycles.enqueue(works.getWork(id)!,eventId),true);
  await flush(8);assert.equal(bindings(id).length,6,"same event never repeats a round");
  for(const taskId of first) { const b=bindings(id).find(b=>b.taskId===taskId)!; assert(JSON.parse(works.repo.executionInput(b)).teamAssignment,"old assignment still resolvable"); }
  assert(submissions.filter(s=>bindings(id).some(b=>b.taskId===s.taskId)).every(s=>s.input.teamAssignment.previousResults.every(r=>!first.includes(bindings(id).find(b=>b.bindingId===r.bindingId)?.taskId??"") || first.includes(s.taskId))),"new round dependencies do not accidentally reuse old results");
  assert(works.pauseWork(user,{workId:id,operationId:"pause-team-watch",versionGuard:guard(works.getWork(id)!)}).ok);
  await flush();assert.equal(bindings(id).length,6,"pause does not dispatch");
  assert.equal(errors.length,0,JSON.stringify(errors));
  const amended = setup();
  const changed = ok(works.teams.handle(user,{kind:"create",request:{...amended.request,mode:"watch",watchRule:{cronExpression:"* * * * *",timezone:"UTC",scheduleBasis:"user_specified"}}})).work!;
  works.teams.requestImmediateWatch(changed);
  await flush(2); // one member has settled, others/owner have not started
  assert(works.teams.watchCycles.pending(changed.workId));
  const beforeScheduleChange=works.getWork(changed.workId)!;
  const mixed=works.amendWork(user,{workId:changed.workId,operationId:"mixed-title-cadence",versionGuard:guard(beforeScheduleChange),title:"title with changed end time",watchRule:{endsAt:Date.now()+60000}});
  assert(!mixed.ok && mixed.code==="invalid_request");
  assert.equal(works.getWork(changed.workId)!.intentRevision,beforeScheduleChange.intentRevision);
  assert.equal(works.getWork(changed.workId)!.inputSnapshotId,beforeScheduleChange.inputSnapshotId);
  const change=works.amendWork(user,{workId:changed.workId,operationId:"change-team-cadence",versionGuard:guard(works.getWork(changed.workId)!),watchRule:{cronExpression:"*/2 * * * *",timezone:"UTC"}});
  assert(change.ok,JSON.stringify(change));
  await flush(2);
  assert.equal(works.teams.watchCycles.pending(changed.workId),false,"obsolete settled cycle cannot hold new schedule hostage");
  const refreshed=works.getWork(changed.workId)!, sub=works.repo.listSubscriptions(changed.workId).find(s=>s.source==="cron"&&!s.stoppedAt)!;
  const nextId="new-schedule-tick";
  works.repo.insertInbox({eventId:nextId,dedupeKey:nextId,source:"cron",sourceEventId:nextId,eventType:"work.tick",workId:changed.workId,subscriptionId:sub.subscriptionId,
    intentRevision:refreshed.intentRevision,stateVersion:refreshed.stateVersion,ownerEpoch:refreshed.ownerEpoch,
    payload:{scheduledAt:Date.now(),scheduleRevision:sub.scheduleRevision??1},status:"pending",mergedCount:1,receivedAt:Date.now()});
  await flush(14);
  assert.equal(works.teams.watchCycles.current(changed.workId)!.sequence,2);
  const regularOwner = submissions.find(s => s.input.teamAssignment.role === "owner_summary" && bindings(changed.workId).some(b => b.taskId === s.taskId));
  assert(regularOwner, 'every-check owner was dispatched');
  assert((regularOwner.input.teamAssignment as unknown as {instructions:string}).instructions.includes('bot-team-report-v1'), 'ordinary team reports retain their presentation contract');

  assert.equal(works.teams.watchCycles.pending(changed.workId),false);
  console.log("PASS team watch: deferred first round, two member+owner cycles, exact event dedupe, historical attribution, pause");
} finally { await queue.close(); db.close(); rmSync(root,{recursive:true,force:true}); }
