import { WorkCompletionCoordinator } from "../src/main/agent/work/WorkCompletionCoordinator";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import type { WorkResultDecision } from "../src/main/agent/work/BotWorkResultTurn";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkDto, type WorkControlResult } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import type { WorkSubitemResult } from "../src/shared/bot-work-phase3";

const root = mkdtempSync(join(tmpdir(), "continuation-scheduling-"));
const artifactPath = join(root, "third-round-progress.txt");
writeFileSync(artifactPath, "verified artifact bytes from the third execution\n");
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "assistant", authorization: DESKTOP_USER_GRANTS });
let authority = true;
const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const receipts = new Map<string, AgentSubmissionReceipt>();
const states = new Map<string, "running" | "completed">();
const errors: unknown[] = [];
const submitted: Array<{ bindingId: string; text: string }> = [];
const settlements: Array<{ bindingId: string; defined: boolean; summary: string; conclusion: string }> = [];

/** A completed subitem is durable progress; a reworded report is not. */
const completedItem = (itemId: string, task: string): WorkSubitemResult => ({ itemId, task, required: true,
  dependencies: [], criterionIds: [], nativeStatus: "completed", outcome: "completed", artifactRefs: [],
  writeConflicts: [], summary: `${task}已完成` });
/** A completed subitem or verified artifact bytes are durable progress; a reworded
 * report is not. The third round of "third-continuation" advances by bytes only. */
const progressFor = (title: string, bindingId: string, index: number) => {
  if (title === "third-continuation") return index <= 2 ? [completedItem(`progress:${bindingId}`, `已完成第 ${index} 部分`)] : [];
  if (title === "progress-cap") return [completedItem(`progress:${bindingId}`, `已完成第 ${index} 部分`)];
  // The first two executions of the no-progress Work really produce something;
  // its third report only changes wording, so it must not buy another execution.
  if (title === "repeated-no-progress" && index <= 2) return [completedItem(`progress:${bindingId}`, `已完成第 ${index} 部分`)];
  return [];
};
const port: WorkExecutionPort = {
  prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
  find: async binding => receipts.get(binding.bindingId),
  submit: async (binding, text) => {
    submitted.push({ bindingId: binding.bindingId, text });
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
    receipts.set(binding.bindingId, receipt); return receipt;
  },
  inspect: async binding => {
    // A superseded revision keeps a lost receipt and never reports terminal
    // output again; the host must not replay it to settle the current revision.
    if (binding.invalidatedAt) return { status: "running" };
    if (states.get(binding.workId) === "running") return { status: "running" };
    const title = works.getWork(binding.workId)?.title ?? "";
    const index = works.repo.listBindings(binding.workId).length;
    // Only the third round of this Work advances through verified artifact bytes.
    const artifactRefs = title === "third-continuation" && index === 3 ? [artifactPath] : [];
    return { status: "completed", summary: `第 ${index} 次执行已返回结果`, artifactRefs, hasWriteConflicts: false,
      subitems: progressFor(title, binding.bindingId, index) };
  },
  stop: async () => {},
};
const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => authority, (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => authority, () => "fixture");
const feedback = new WorkConversationFeedback({ db: db.connection, works, userId: LOCAL_USER_ID, isAuthority: () => authority });
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work!; };
const reviewed: string[] = [];
const coordinator = new WorkCompletionCoordinator({ db: db.connection, works, isAuthority: () => authority,
  review: async (input): Promise<WorkResultDecision> => {
    const title = String(input.context.title);
    const bindingId = input.eventId.split(":")[1];
    const index = works.repo.listBindings(works.repo.getBinding(bindingId)!.workId).length;
    reviewed.push(`${title}:${index}`);
    const settlement = works.automaticCompletion.outcome(bindingId);
    settlements.push({ bindingId, defined: !!settlement, summary: settlement?.summary ?? "", conclusion: settlement?.conclusion ?? "" });
    if (["third-continuation", "progress-cap"].includes(title)) return index <= (title === "third-continuation" ? 3 : 5)
      ? { decision: "continue", outcome: "partial", reply: `已完成第 ${index} 部分，接下来我会继续补齐剩余内容。`, missing: [{ task: "补齐剩余内容", requestExcerpt: title }] }
      : { decision: "deliver", outcome: "completed", reply: `第 ${index} 部分已补齐，全部内容已交付。`, missing: [] };
    if (title === "repeated-no-progress") return { decision: "continue", outcome: "partial",
      reply: "接下来我会继续补齐剩余内容。已有部分成果可直接使用。", missing: [{ task: "补齐剩余内容", requestExcerpt: title }] };
    if (title === "unrelated-unknown-gap") return index < 3
      ? { decision: "continue", outcome: "partial", reply: "只读核对已完成一部分，接下来我会继续核对剩余来源。", missing: [{ task: "只读核对剩余来源", requestExcerpt: title }] }
      : { decision: "deliver", outcome: "completed", reply: "只读核对已完成，剩余来源均已核对并交付。", missing: [] };
    if (title === "same-binding-independent-read") return index < 2
      ? { decision: "continue", outcome: "partial", reply: "继续核对独立来源", missing: [{ task: "只读核对独立来源", requestExcerpt: title, readOnly: true }] }
      : { decision: "deliver", outcome: "partial", reply: "独立来源已核对，原写入效果仍未知。", missing: [] };
    if (title === "same-binding-unknown") return { decision: "continue", outcome: "partial",
      reply: "接下来我会继续补齐剩余内容。已确认的部分已交付。", missing: [{ task: "补齐剩余内容", requestExcerpt: title }] };
    if (title === "stale-revision-settles") return { decision: "deliver", outcome: "partial",
      reply: "当前修订的结果已交付；旧执行的未知效果仍需核对。", missing: [] };
    return { decision: "deliver", outcome: "completed", reply: `已整理：${title}。`, missing: [] };
  },
  deliver: input => feedback.deliverCompletion(input), wake: () => {} });

async function flush() {
  await queue.flush(); await adapter.flush(); coordinator.wake();
  await new Promise(resolve => setImmediate(resolve));
}
async function settle(times = 10) { for (let round = 0; round < times; round++) await flush(); }
function create(name: string) {
  const result = works.createWork(user, { operationId: name, title: name, inputSnapshotId: `input-${name}`,
    mode: "once", authorization: DESKTOP_USER_GRANTS });
  assert(result.ok, JSON.stringify(result));
  works.transaction(() => queue.enqueue(result.work, name));
  states.set(result.work.workId, "running");
  return result.work.workId;
}
const continuedTurns = (workId: string) => (db.connection.prepare(`SELECT count(*) count FROM work_completion_turns turn
  JOIN work_execution_bindings binding ON binding.binding_id=turn.binding_id WHERE binding.work_id=? AND turn.state='continued'`)
  .get(workId) as { count: number }).count;
const progressRows = (workId: string) => (db.connection.prepare("SELECT count(*) count FROM work_continuation_progress WHERE work_id=?")
  .get(workId) as { count: number }).count;
const artifactRows = (workId: string) => (db.connection.prepare("SELECT count(*) count FROM work_artifact_dependencies WHERE work_id=?")
  .get(workId) as { count: number }).count;
function reports(workId: string) {
  const origin = feedback.messages.resolveWorkDelivery(LOCAL_USER_ID, workId);
  assert(origin, "the origin conversation exists for every fixture Work");
  return feedback.messages.history(LOCAL_USER_ID, { botId: origin.bot_id, conversationId: origin.conversation_id })
    .messages.filter(message => message.workIds.includes(workId) && message.workFeedback?.report?.completion);
}
const lastReport = (workId: string) => reports(workId).at(-1)!.workFeedback!.report!;
/** The model's continuation promise is never delivered once the host refuses to continue. */
function assertNoContinuationPromise(workId: string) {
  const report = lastReport(workId);
  for (const promise of ["接下来", "继续补齐", "继续核对", "稍后"]) {
    assert(!report.summary.includes(promise), `delivered body must not keep the model's promise: ${promise}`);
    assert(!reports(workId).at(-1)!.text.includes(promise), `delivered message must not keep the model's promise: ${promise}`);
  }
  assert(report.notices.some(notice => notice.includes("没有重复执行已完成动作")), "the host override keeps its own notice");
  assert.deepEqual(report.completion, { outcome: "partial", nextStep: "deliver" }, "outcome and next step match the delivered body");
  return report;
}
try {
  // Acceptance 1: the third continuation still runs because every round made
  // real durable progress (a completed current-version subitem each time).
  const third = create("third-continuation"); await flush();
  states.set(third, "completed"); await settle(12);
  const thirdBindings = works.repo.listBindings(third);
  assert.equal(thirdBindings.length, 4, "the third continuation with real progress is admitted and executed");
  assert.equal(continuedTurns(third), 3, "three continuations were admitted, not the old fixed two");
  assert.equal(progressRows(third), 3, "each admitted continuation persisted its durable progress basis");
  // The round that bought the third continuation completed no subitem; only
  // verified artifact bytes could have distinguished it from the previous round.
  assert.equal(works.partialResults.list(third).filter(item => item.bindingId === thirdBindings[2].bindingId
    && item.itemId.startsWith("progress:")).length, 0, "the third continuation advanced on artifact bytes, not a new subitem");
  assert.equal(artifactRows(third), 1, "the artifact byte change is the durable progress that admitted it");
  assert(reviewed.includes("third-continuation:3"), "the third continuation decision actually reached the result lane");
  assert.equal(works.getWork(third)?.closureConclusion, "succeeded", "the final reviewed delivery closes the Work");
  assert.equal(lastReport(third).completion?.nextStep, "deliver");

  // Acceptance 2: the same prior count without new durable progress delivers a
  // partial result, and the model's "I will continue" body is rewritten away.
  const noProgress = create("repeated-no-progress"); await flush();
  states.set(noProgress, "completed"); await settle(12);
  assert.equal(works.repo.listBindings(noProgress).length, 3, "no third continuation without new durable progress");
  assert.equal(continuedTurns(noProgress), 2, "only the two progress-making continuations were admitted");
  assert.equal(progressRows(noProgress), 2);
  const rewritten = assertNoContinuationPromise(noProgress);
  assert(!rewritten.summary.includes("可直接使用"), "host never preserves unsupported model claims after override");
  assert.equal(works.getWork(noProgress)?.closureConclusion, "ended_unsuccessfully", "refused continuation ends honestly as partial");

  // Genuine progress can continue beyond four rounds; only lack of progress stops the lane.
  const capped = create("progress-cap"); await flush();
  states.set(capped, "completed"); await settle(16);
  assert.equal(works.repo.listBindings(capped).length, 6, "five genuine progress continuations all run");
  assert.equal(continuedTurns(capped), 5);
  assert.equal(lastReport(capped).completion?.outcome, "completed");

  // Acceptance 3a: an unknown write of another (invalidated) lineage does not
  // block an independent read-only gap of the current revision.
  const unrelated = create("unrelated-unknown-gap"); await flush();
  const oldBinding = works.repo.listBindings(unrelated)[0]!;
  works.admitTaskAction(oldBinding.taskId, { operationId: "old-unknown-write", actionKind: "workspace:write" });
  works.settleTaskAction(oldBinding.taskId, "old-unknown-write", "unknown");
  const amended = unwrap(works.amendWork(user, { operationId: "unrelated-r2", workId: unrelated,
    constraints: ["只核对当前修订的来源"], versionGuard: guard(works.getWork(unrelated)!) }));
  works.transaction(() => queue.enqueue(amended, "unrelated-r2-dispatch"));
  states.set(unrelated, "completed"); await settle(12);
  assert.equal(works.repo.listBindings(unrelated).length, 3, "the independent read gap was scheduled despite the unrelated unknown write");
  assert.equal(works.repo.listAdmissions(unrelated).length, 1, "the uncertain write is neither replayed nor rewritten");
  assert.equal(works.repo.listAdmissions(unrelated)[0].state, "unknown");
  const readGapBinding = works.repo.listBindings(unrelated).at(-1)!;
  const readGapInput = submitted.find(item => item.bindingId === readGapBinding.bindingId)!;
  assert(readGapInput.text.includes("未核实的未知外部效果不得重放"), "the continuation input states that unverified effects are not replayed");
  assert(readGapInput.text.includes("只读核对剩余来源"), "only the independent gap is delegated");
  const { revisionHandoff, ...currentReadTask } = JSON.parse(readGapInput.text);
  assert(!JSON.stringify(currentReadTask).includes("old-unknown-write"), "the unrelated unknown action is never delegated as a new task");
  assert(revisionHandoff.unresolvedOperations.some((item: {operationId:string}) => item.operationId === "old-unknown-write"),
    "the exact unknown operation identity remains historical evidence, not a newly delegated action");

  // Acceptance 3b: an unknown effect of the result lineage still blocks its own
  // continuation, and the refused promise never reaches the user.
  const blocked = create("same-binding-unknown"); await flush();
  const blockedBinding = works.repo.listBindings(blocked)[0]!;
  works.admitTaskAction(blockedBinding.taskId, { operationId: "same-unknown-write", actionKind: "workspace:write" });
  works.settleTaskAction(blockedBinding.taskId, "same-unknown-write", "unknown");
  states.set(blocked, "completed"); await settle(8);
  assert.equal(works.repo.listBindings(blocked).length, 1, "an unknown effect in the same lineage is not retried");
  const blockedReport = assertNoContinuationPromise(blocked);
  assert(!blockedReport.summary.includes("已确认的部分已交付"), "host replacement does not rely on model claims");

  const independent = create("same-binding-independent-read"); await flush();
  const independentSource = works.repo.listBindings(independent)[0]!;
  works.admitTaskAction(independentSource.taskId, { operationId: "independent-unknown-write", actionKind: "workspace:write" });
  works.settleTaskAction(independentSource.taskId, "independent-unknown-write", "unknown");
  states.set(independent, "completed"); await settle(10);
  assert.equal(works.repo.listBindings(independent).length, 2, "independent read runs even within same unknown lineage");
  const readPlan = works.partialResults.plans(independent)[0]!;
  assert(works.partialResults.isReadOnlyPlan(readPlan), "host enforces read-only plan, not merely a prompt");
  const readBinding = works.repo.listBindings(independent).at(-1)!;
  const deniedWrite = works.admitTaskAction(readBinding.taskId, { operationId: "must-not-write", actionKind: "workspace:write" });
  assert.equal(typeof deniedWrite, "string", "read-only continuation cannot replay a write");
  assert.deepEqual(readBinding.delegatedScope, ["workspace:read"]);
  assert.equal(works.repo.listAdmissions(independent).find(item => item.operationId === "independent-unknown-write")?.state, "unknown");

  // Acceptance 4: r2 settles its own available results while the invalidated,
  // lost r1 is still running, and r1's unknown effect stays in the settlement.
  const stale = create("stale-revision-settles"); await flush();
  const lost = works.repo.listBindings(stale)[0]!;
  works.admitTaskAction(lost.taskId, { operationId: "lost-unknown-write", actionKind: "workspace:write" });
  works.settleTaskAction(lost.taskId, "lost-unknown-write", "unknown");
  const staleAmended = unwrap(works.amendWork(user, { operationId: "stale-r2", workId: stale,
    goalDescription: "只按当前修订交付真实结果", versionGuard: guard(works.getWork(stale)!) }));
  works.transaction(() => queue.enqueue(staleAmended, "stale-r2-dispatch"));
  states.set(stale, "completed"); await settle(10);
  const settled = works.repo.listBindings(stale).find(item => !item.invalidatedAt)!;
  assert.equal(settled.status, "completed", "the current revision's execution returned real results");
  assert.equal(works.repo.getBinding(lost.bindingId)?.status, "running", "the lost old execution is neither replayed nor guessed stopped");
  const settlement = settlements.filter(item => item.bindingId === settled.bindingId).at(-1)!;
  assert(settlement.defined, "the current revision settles although the invalidated old binding is still running");
  assert.equal(settlement.conclusion, "ended_unsuccessfully", "the unresolved old effect keeps the settlement honest");
  assert(settlement.summary.includes("旧修订执行有工具效果尚未核实"), "the old unknown effect is listed, not hidden");
  assert.equal(works.repo.listAdmissions(stale).length, 1, "the old effect is reported, never replayed");
  assert.equal(works.getWork(stale)?.lifecycle, "closed", "the settled current revision is delivered and archived");
  assert.equal(works.getWork(stale)?.closureConclusion, "ended_unsuccessfully");
  assert.deepEqual(errors, []);
  console.log("PASS continuation reliability: progress-gated continuations, host-downgrade body rewrite, lineage-scoped unknown effects, invalidated old execution settlement");
} finally { coordinator.close(); await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }