import { WorkCompletionCoordinator } from "../src/main/agent/work/WorkCompletionCoordinator";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "automatic-completion-"));
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "assistant", authorization: DESKTOP_USER_GRANTS });
let authority = true;
const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const receipts = new Map<string, AgentSubmissionReceipt>();
const states = new Map<string, "running" | "completed">();
const errors: unknown[] = [];
const port: WorkExecutionPort = {
  prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
  find: async binding => receipts.get(binding.bindingId),
  submit: async binding => {
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
    receipts.set(binding.bindingId, receipt); return receipt;
  },
  inspect: async binding => states.get(binding.workId) === "running" ? { status: "running" }
    : { status: "completed", summary: works.getWork(binding.workId)?.title === "empty-result" ? "" : "已交付请求的文字方案", artifactRefs: [], hasWriteConflicts: false },
  stop: async () => {},
};
const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => authority, (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => authority, () => "fixture");
const feedback = new WorkConversationFeedback({ db: db.connection, works, userId: LOCAL_USER_ID, isAuthority: () => authority });
const reviewed: string[] = [];
let deliveryAvailable = true;
let failReview = false;
let reviewPartial = false;
let reviewContinue = false;
let lateResultWork: string | undefined;
const coordinator = new WorkCompletionCoordinator({ db: db.connection, works, isAuthority: () => authority,
  review: async input => { reviewed.push(input.eventId); if (failReview) throw Error("model unavailable");
    if (lateResultWork) { db.connection.prepare("UPDATE work_deliverables SET summary=summary || ' 后到证据' WHERE work_id=?").run(lateResultWork); lateResultWork=undefined; }
    if (reviewContinue) { reviewContinue=false; return {decision:"continue",outcome:"partial",reply:"已完成第一部分，补充剩余内容",missing:[{task:"补充剩余内容",requestExcerpt:String(input.context.title)}]}; }
    return { decision: "deliver", outcome: reviewPartial || ["explicit", "uncertain"].includes(String(input.context.title)) ? "partial" : "completed", reply: `已整理：${input.context.title}。结果依据原始执行记录。`, missing: [] }; },
  deliver: input => { assert.notEqual(works.getWork(works.repo.getBinding(input.bindingId)!.workId)?.lifecycle, "closed", "delivery precedes closure");
    return deliveryAvailable && feedback.deliverCompletion(input); }, wake: () => {} });
async function flush() { await queue.flush(); coordinator.wake(); await new Promise(resolve => setImmediate(resolve)); }

function create(name: string, watch = false, criteria?: string[]) {
  const result = works.createWork(user, { operationId: name, title: name, inputSnapshotId: name,
    mode: watch ? "watch" : "once", criteria: criteria?.map(text => ({ text })), authorization: DESKTOP_USER_GRANTS });
  assert(result.ok, JSON.stringify(result));
  works.transaction(() => queue.enqueue(result.work, name));
  states.set(result.work.workId, "running");
  return result.work.workId;
}
try {
  const healthy = create("healthy"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "active", "running remains active");
  states.set(healthy, "completed"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "closed");
  assert.equal(works.getWork(healthy)?.closureConclusion, "succeeded");
  assert.equal(works.repo.listDeliverables(healthy)[0]?.status, "proposed", "automatic end is not forged acceptance");
  const version = works.getWork(healthy)?.stateVersion;
  await flush(); assert.equal(works.getWork(healthy)?.stateVersion, version, "replay does not reclose");

  const watch = create("watch", true); await flush(); states.set(watch, "completed"); await flush();
  assert.equal(works.getWork(watch)?.lifecycle, "active", "one watch tick is not end of the watch");

  const explicit = create("explicit", false, ["必须实地验证目标设备"]);
  await flush(); states.set(explicit, "completed"); await flush();
  assert.equal(works.getWork(explicit)?.lifecycle, "closed", "missing evidence does not demand manual closure");
  assert.equal(works.getWork(explicit)?.closureConclusion, "ended_unsuccessfully", "unverified explicit requirement is not fabricated success");
  assert(reviewed.some(event => event.includes(works.repo.listBindings(explicit)[0].bindingId)), "explicit criteria are assessed by the goal review");
  assert.equal(works.getWork(explicit)?.criteria[0].status, "pending");

  const historical = create("historical"); await flush();
  const oldBinding = works.repo.listBindings(historical)[0];
  works.repo.updateBinding({ ...oldBinding, status: "completed", settledAt: Date.now() });
  states.set(historical, "completed"); await flush();
  assert.equal(works.getWork(historical)?.lifecycle, "active", "reading old terminal history does not batch alter it");

  const uncertain = create("uncertain"); await flush();
  const binding = works.repo.listBindings(uncertain)[0];
  works.admitTaskAction(binding.taskId, { operationId: "unknown-effect", actionKind: "workspace:write" });
  works.settleTaskAction(binding.taskId, "unknown-effect", "unknown");
  states.set(uncertain, "completed"); await flush();
  assert.equal(works.getWork(uncertain)?.lifecycle, "closed");
  assert.equal(works.getWork(uncertain)?.closureConclusion, "ended_unsuccessfully");
  assert.equal(works.repo.listAdmissions(uncertain)[0].state, "unknown", "goal review never rewrites tool receipts");

  const audit = create("audit-report", false, ["测试项目的bug，罗列出来，不需要修改代码"]);
  await flush();
  const auditBinding = works.repo.listBindings(audit)[0];
  works.admitTaskAction(auditBinding.taskId, {operationId:"audit-old-tool-error",actionKind:"workspace:write"});
  works.settleTaskAction(auditBinding.taskId,"audit-old-tool-error","unknown");
  states.set(audit,"completed"); await flush();
  assert.equal(works.getWork(audit)?.closureConclusion,"succeeded","reviewed user goal is not vetoed by untouched attestation or unrelated historic tool uncertainty");
  assert.equal(works.getWork(audit)?.criteria[0].status,"pending","goal delivery does not forge manual attestation");
  assert.equal(works.repo.listAdmissions(audit)[0].state,"unknown","no fabricated effect receipt");
  assert.equal(works.repo.listBindings(audit).length,1,"no replay of the uncertain action");

  const empty = create("empty-result"); await flush(); states.set(empty, "completed"); await flush();
  assert.equal(works.getWork(empty)?.closureConclusion, "ended_unsuccessfully", "completed without real output must not appear successful");
  assert.match(works.getWork(empty)?.closureSummary ?? "", /没有返回可用/);

  const waiting = create("waiting-input"); await flush();
  works.repo.insertBlocker({ blockerId: "needs-user-info", workId: waiting, kind: "operational", reason: "收件人是谁", waitingForUserInput: true, status: "open", createdAt: Date.now() });
  states.set(waiting, "completed"); await flush();
  assert.equal(works.getWork(waiting)?.lifecycle, "active", "a real clarification is not completed work");
  const waitingOrigin=feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,waiting)!;
  assert(feedback.messages.history(LOCAL_USER_ID,{botId:waitingOrigin.bot_id,conversationId:waitingOrigin.conversation_id}).messages.some(item => item.workIds.includes(waiting) && item.text.includes("收件人是谁") && item.text.includes("已交付请求的文字方案")),"terminal partial result and real question remain visible");
  authority = false; works.automaticCompletion.drain(); authority = true;
  const withheld = create("no-delivery"); await flush(); deliveryAvailable = false;
  states.set(withheld, "completed"); await flush();
  assert.equal(works.getWork(withheld)?.lifecycle, "active", "a failed delivery cannot silently archive");
  deliveryAvailable = true; db.connection.prepare("UPDATE work_completion_turns SET retry_at=0 WHERE binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?)").run(withheld);
  await flush(); assert.equal(works.getWork(withheld)?.lifecycle, "closed");

  const six = Array.from({length:6}, (_,index) => create(`parallel-${index}`)); await flush();
  six.forEach(id => states.set(id,"completed"));
  for (let i=0;i<6;i++) await flush();
  assert(six.every(id => works.getWork(id)?.lifecycle === "closed"));
  for (const id of six) {
    const bindingId=works.repo.listBindings(id)[0].bindingId;
    assert.equal(reviewed.filter(event => event === `completion:${bindingId}:review:1`).length,1,"one result review per exact execution");
    const origin=feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,id)!;
    const history=feedback.messages.history(LOCAL_USER_ID,{botId:origin.bot_id,conversationId:origin.conversation_id});
    assert(history.messages.some(message => message.workIds.includes(id) && message.workFeedback?.category === "result" && message.text.includes(works.getWork(id)!.title)));
  }
  const late = create("late-result"); await flush(); lateResultWork=late; states.set(late,"completed"); await flush();
  assert.equal(works.getWork(late)?.lifecycle,"active","old result decision cannot close changed evidence");
  await flush(); assert.equal(works.getWork(late)?.lifecycle,"closed","changed result is reviewed in a new generation");
  const partial = create("review-partial"); await flush(); reviewPartial=true; states.set(partial,"completed"); await flush(); reviewPartial=false;
  assert.equal(works.getWork(partial)?.closureConclusion,"ended_unsuccessfully","model's partial finding cannot be relabeled success");
  const continuation = create("continue-required"); await flush(); reviewContinue=true; states.set(continuation,"completed"); await flush();
  assert.equal(works.getWork(continuation)?.lifecycle,"active","missing request schedules continuation, not closure");
  await flush(); await flush();
  assert.equal(works.getWork(continuation)?.closureConclusion,"succeeded","reviewed continuation resolves only its semantic gap");
  assert.equal(works.repo.listBindings(continuation).length,2,"one exact missing-part execution, not original task replay");
  const failed = create("review-fails"); await flush(); failReview = true; states.set(failed,"completed"); await flush();
  assert.equal(works.getWork(failed)?.lifecycle,"active");
  db.connection.prepare("UPDATE work_completion_turns SET retry_at=0 WHERE binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?)").run(failed);
  await flush(); failReview=false;
  assert.equal(works.getWork(failed)?.lifecycle,"closed","report failure delivers original result instead of hanging");
  assert.equal(works.repo.listBindings(failed).length,1,"summary retry never reruns the business task");
  assert.deepEqual(errors, []);
  console.log("PASS automatic completion: delivery, in-flight, replay, watch, honest missing evidence, legacy history, unknown effects, real clarification");
} finally { coordinator.close(); await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
