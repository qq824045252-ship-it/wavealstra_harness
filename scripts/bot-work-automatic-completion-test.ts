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
const states = new Map<string, "running" | "completed" | "failed">();
const errors: unknown[] = [];
const port: WorkExecutionPort = {
  prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
  find: async binding => receipts.get(binding.bindingId),
  submit: async binding => {
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
    if (works.getWork(binding.workId)?.title === "team-owner-failure-reusable" && binding.botId === DEFAULT_BOT_ID) {
      const result = works.submitDeliverable({kind:"worker",botId:binding.botId,bindingId:binding.bindingId}, {
        operationId:`retained:${binding.bindingId}`,workId:binding.workId,bindingId:binding.bindingId,
        summary:"已保存可复用成果，后续生成失败不撤销此成果",uncoveredScope:[],artifactRefs:[],evidence:[{kind:"tool_receipt",sourceRef:"fixture:retained-result"}]});
      assert(result.ok,JSON.stringify(result));
    }
    receipts.set(binding.bindingId, receipt); return receipt;
  },
  inspect: async binding => {
    if (states.get(binding.workId) === "running") return { status: "running" };
    const title = works.getWork(binding.workId)?.title;
    const failedOwner = title?.startsWith("team-owner-failure-") && binding.botId === DEFAULT_BOT_ID;
    return { status: failedOwner || states.get(binding.workId) === "failed" ? "failed" : "completed",
      summary: title === "empty-result" || title === "team-owner-failure-empty" && failedOwner ? "" : "已交付请求的文字方案",
      artifactRefs: [], hasWriteConflicts: false };
  },
  stop: async () => {},
};
const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => authority, (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => authority, () => "fixture");
const feedback = new WorkConversationFeedback({ db: db.connection, works, userId: LOCAL_USER_ID, isAuthority: () => authority });
const reviewed: string[] = [];
const historicalReceiptAt = Date.UTC(2026,10,9,9);
let deliveryAvailable = true;
let currentPreferences = "",changePreferencesDuringReview: string | undefined;
const reviewedPreferences: string[] = [];
let failReview = false;
let reviewPartial = false;
let reviewContinue = false;
let lateResultWork: string | undefined;
let lateQuestionWork: string | undefined;
let pauseReviewWork: string | undefined;
const coordinator = new WorkCompletionCoordinator({ db: db.connection, works, isAuthority: () => authority, preferences: () => currentPreferences,
  review: async input => { assert(!("teamAssignment" in (input.context.originalRequest as object)),"review input must not contain executor report-format instructions"); const temporal = input.context.temporalContext as {reviewAt:string;observedAt:string|null;historicalRecovery:boolean;freshExecution:boolean};
    assert(Number.isFinite(Date.parse(temporal.reviewAt))); assert(temporal.observedAt && Number.isFinite(Date.parse(temporal.observedAt)));
    assert.equal(temporal.freshExecution,false,"review never claims a fresh business execution");
    if (["healthy","legacy-unreviewed"].includes(String(input.context.title))) assert.equal(temporal.historicalRecovery,input.context.title === "legacy-unreviewed","recovered enrollment is distinguished from live receipt");
    if (input.context.title === "legacy-unreviewed") assert.equal(temporal.observedAt,new Date(historicalReceiptAt).toISOString(),"historical receipt time is not replaced with review time");
    reviewed.push(input.eventId); reviewedPreferences.push(input.personalPreferences ?? "");
    if(changePreferencesDuringReview!==undefined){currentPreferences=changePreferencesDuringReview;changePreferencesDuringReview=undefined;}
    if (pauseReviewWork) {
      assert(works.pauseWork(user,{operationId:"pause-during-review",workId:pauseReviewWork}).ok);
      pauseReviewWork=undefined;
    }
    if (failReview) throw Error("model unavailable");
    if (lateQuestionWork) { works.repo.insertBlocker({blockerId:"late-question",workId:lateQuestionWork,kind:"operational",reason:"必须提供收件人",waitingForUserInput:true,status:"open",createdAt:Date.now()}); lateQuestionWork=undefined; }
    if ((input.context.pendingQuestions as Array<{blockerId:string}>|undefined)?.some(item=>item.blockerId === "late-question")) return {decision:"ask",outcome:"partial",reply:"必须提供收件人",missing:[]};
    if (input.context.title === "waiting-input") return {decision:"ask",outcome:"partial",reply:"已交付请求的文字方案；收件人是谁？",missing:[]};
    if (lateResultWork) { db.connection.prepare("UPDATE work_deliverables SET summary=summary || ' 后到证据' WHERE work_id=?").run(lateResultWork); lateResultWork=undefined; }
    if (reviewContinue && ["continue-required","team-review-followup"].includes(String(input.context.title))) { reviewContinue=false; return {decision:"continue",outcome:"partial",reply:"已完成第一部分，补充剩余内容",missing:[{task:"补充剩余内容",requestExcerpt:String(input.context.title)}]}; }
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
  // Reproduce the live race: the native terminal receipt becomes visible before
  // the dispatch loop has atomically chosen recovery vs final readback.
  const recoveryRace = create("recovery-review-race"); await flush();
  const failedBinding = works.repo.listBindings(recoveryRace)[0]!;
  states.set(recoveryRace, "failed");
  await adapter.flush();
  coordinator.wake(); await new Promise(resolve => setImmediate(resolve));
  assert(!reviewed.some(event => event.startsWith(`completion:${failedBinding.bindingId}:`)), "failed receipt must not race recovery with a premature model review");
  assert.equal(works.getWork(recoveryRace)?.lifecycle, "active", "failure receipt cannot close before recovery dispatch");
  await queue.flush();
  states.set(recoveryRace, "completed");
  for (let i=0;i<4;i++) await flush();
  assert.equal(works.getWork(recoveryRace)?.closureConclusion, "succeeded", "recovered real output still receives the final goal review");
  assert(!reviewed.some(event => event.startsWith(`completion:${failedBinding.bindingId}:`)), "superseded failure is never reviewed");
  // A prior host may already have launched an obsolete review. Repair its state
  // without another model call, and never turn it into a delivered result.
  db.connection.prepare("INSERT INTO work_completion_turns(binding_id,context_json,state,attempts) VALUES (?,?,'running',1)")
    .run(failedBinding.bindingId, "{}");
  coordinator.wake();
  assert.equal((db.connection.prepare("SELECT state FROM work_completion_turns WHERE binding_id=?").get(failedBinding.bindingId) as {state:string}).state, "superseded");

  const pausedReview=create("paused-review"); await flush();
  pauseReviewWork=pausedReview; states.set(pausedReview,"completed"); await flush();
  const pausedBinding=works.repo.listBindings(pausedReview)[0]!;
  assert.equal(works.getWork(pausedReview)?.lifecycle,"paused");
  db.connection.prepare("UPDATE work_completion_turns SET state='running' WHERE binding_id=?").run(pausedBinding.bindingId);
  coordinator.wake();
  const pausedRow=()=>db.connection.prepare("SELECT state,retry_at,error FROM work_completion_turns WHERE binding_id=?").get(pausedBinding.bindingId) as {state:string;retry_at:number;error:string|null};
  assert.equal(pausedRow().state,"queued","an orphan running review is queued while paused, not marked superseded");
  const retryAt=Date.now()+60000;
  db.connection.prepare("UPDATE work_completion_turns SET retry_at=?,error='existing retry reason' WHERE binding_id=?").run(retryAt,pausedBinding.bindingId);
  coordinator.wake();
  assert.deepEqual(pausedRow(),{state:"queued",retry_at:retryAt,error:"existing retry reason"},"paused queued review retains its retry schedule and evidence");
  assert(works.resumeWork(user,{operationId:"resume-after-review",workId:pausedReview}).ok);
  db.connection.prepare("UPDATE work_completion_turns SET retry_at=0 WHERE binding_id=?").run(pausedBinding.bindingId);
  await flush();
  assert.equal(works.getWork(pausedReview)?.closureConclusion,"succeeded","paused review can resume normally");

  currentPreferences="old-completion-marker";
  const memoryRace=create("memory-race");await flush();states.set(memoryRace,"completed");changePreferencesDuringReview="";await flush();
  assert.notEqual(works.getWork(memoryRace)?.lifecycle,"closed","preference deletion during review prevents stale closure delivery");
  await flush();assert.equal(works.getWork(memoryRace)?.lifecycle,"closed");assert.equal(reviewedPreferences.at(-1),"");
  assert(!JSON.stringify(db.connection.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?)").all(memoryRace)).includes("completion-marker"),"no preference text copy in durable completion context");
  const healthy = create("healthy"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "active", "running remains active");
  states.set(healthy, "completed"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "closed");
  assert.equal(works.getWork(healthy)?.closureConclusion, "succeeded");
  assert.equal(works.repo.listDeliverables(healthy)[0]?.status, "proposed", "automatic end is not forged acceptance");
  const version = works.getWork(healthy)?.stateVersion;
  await flush(); assert.equal(works.getWork(healthy)?.stateVersion, version, "replay does not reclose");

  const legacy = create("legacy-unreviewed"); await flush(); states.set(legacy,"completed");
  await queue.flush();
  const legacyBinding = works.repo.listBindings(legacy)[0];
  db.connection.prepare("UPDATE work_native_inbox SET received_at=? WHERE binding_id=?").run(historicalReceiptAt,legacyBinding.bindingId);
  db.connection.prepare("DELETE FROM work_automatic_completion WHERE binding_id=?").run(legacyBinding.bindingId);
  works.repo.insertBlocker({blockerId:"legacy-acceptance",workId:legacy,kind:"operational",reason:"请老板采纳成果",waitingForUserInput:true,status:"open",createdAt:Date.now()});
  works.transaction(() => works.automaticCompletion.recoverUnreviewed());
  await flush();
  assert.equal(works.getWork(legacy)?.closureConclusion,"succeeded","old open result is reviewed without acceptance clicks");
  assert.equal(works.repo.listOpenBlockers(legacy).length,0,"obsolete acceptance question is not a real user information requirement");
  const legacyVersion=works.getWork(legacy)!.stateVersion;
  works.transaction(() => works.automaticCompletion.recoverUnreviewed()); await flush();
  assert.equal(works.getWork(legacy)!.stateVersion,legacyVersion,"closed history never reopens or reexecutes");

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
    assert.equal(reviewed.filter(event => event.startsWith(`completion:${bindingId}:review:1:`)).length,1,"one result review per exact execution");
    const origin=feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,id)!;
    const history=feedback.messages.history(LOCAL_USER_ID,{botId:origin.bot_id,conversationId:origin.conversation_id});
    assert(history.messages.some(message => message.workIds.includes(id) && message.workFeedback?.category === "result" && message.text.includes(works.getWork(id)!.title)));
  }
  const late = create("late-result"); await flush(); lateResultWork=late; states.set(late,"completed"); await flush();
  assert.equal(works.getWork(late)?.lifecycle,"active","old result decision cannot close changed evidence");
  await flush(); assert.equal(works.getWork(late)?.lifecycle,"closed","changed result is reviewed in a new generation");
  const questionRace=create("late-user-question"); await flush(); lateQuestionWork=questionRace; states.set(questionRace,"completed"); await flush();
  assert.equal(works.getWork(questionRace)?.lifecycle,"active","a stale review cannot clear a new user-information question");
  assert.equal(works.repo.listOpenBlockers(questionRace).length,1);
  await flush();
  assert.equal(works.getWork(questionRace)?.lifecycle,"active","fresh model review retains genuine question");

  const partial = create("review-partial"); await flush(); reviewPartial=true; states.set(partial,"completed"); await flush(); reviewPartial=false;
  assert.equal(works.getWork(partial)?.closureConclusion,"ended_unsuccessfully","model's partial finding cannot be relabeled success");
  const continuation = create("continue-required"); await flush(); reviewContinue=true; states.set(continuation,"completed"); await flush();
  assert.equal(works.getWork(continuation)?.lifecycle,"active","missing request schedules continuation, not closure");
  await flush(); await flush();
  assert.equal(works.getWork(continuation)?.closureConclusion,"succeeded","reviewed continuation resolves only its semantic gap");
  assert.equal(works.repo.listBindings(continuation).length,2,"one exact missing-part execution, not original task replay");
  bots.registerBot({botId:"team-review-member",userId:LOCAL_USER_ID,displayName:"成员",authorization:DESKTOP_USER_GRANTS});
  const teamResult=works.teams.handle({...user,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}}, {kind:"create",request:{
    operationId:"team-review-followup",title:"team-review-followup",goalDescription:"补充剩余内容",workspacePath:root,
    ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:"汇总真实成果",members:[{botId:"team-review-member",responsibility:"分析资料",delegatedScope:["workspace:read"]}],criteria:["补充剩余内容"]}});
  assert(teamResult.ok,JSON.stringify(teamResult));
  const teamId=teamResult.work!.workId;
  for(let i=0;i<5;i++) await queue.flush();
  const originalTeamBindings=works.repo.listBindings(teamId);
  assert.equal(originalTeamBindings.length,2);
  db.connection.prepare("DELETE FROM work_automatic_completion WHERE work_id=?").run(teamId);
  works.transaction(()=>works.automaticCompletion.recoverUnreviewed());
  reviewContinue=true;
  coordinator.wake(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(works.getWork(teamId)?.lifecycle,"active","team review schedules missing part without user acceptance");
  for(let i=0;i<5;i++) await flush();
  assert.equal(works.getWork(teamId)?.closureConclusion,"succeeded","team owner continuation returns to automatic review and closes");
  assert.equal(works.repo.listBindings(teamId).length,3,"only one missing-part execution; members are not rerun");

  for (const variant of ["empty", "reusable"]) {
    const teamFailure = works.teams.handle({...user,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}}, {kind:"create",request:{
      operationId:`team-owner-failure-${variant}`,title:`team-owner-failure-${variant}`,goalDescription:"交付团队成果并说明实际缺项",workspacePath:root,
      ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:"汇总真实成果",members:[{botId:"team-review-member",responsibility:"分析资料",delegatedScope:["workspace:read"]}],criteria:["有真实成果与明确缺项"]}});
    assert(teamFailure.ok,JSON.stringify(teamFailure));
    const id = teamFailure.work!.workId;
    for (let i=0;i<10;i++) {
      await flush();
      const owner = works.teams.get(id)!.executions.find(item => item.role === "owner_summary")!;
      if (owner.status === "recovering") {
        assert.equal(works.getWork(id)?.lifecycle,"active","pending team recovery cannot be closed");
        assert(!reviewed.some(event => works.repo.listBindings(id).filter(b=>b.botId===DEFAULT_BOT_ID).some(b=>event.startsWith(`completion:${b.bindingId}:`))),"team recovery must settle before review");
      }
    }
    const ownerBindings = works.repo.listBindings(id).filter(item => item.botId === DEFAULT_BOT_ID);
    assert.equal(ownerBindings.length,variant === "empty" ? 2 : 1);
    const finalOwner = ownerBindings.at(-1)!;
    assert(!db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE task_id=?").get(finalOwner.taskId));
    assert(!db.connection.prepare("SELECT 1 FROM work_automatic_recovery WHERE source_binding_id=?").get(finalOwner.bindingId));
    assert(reviewed.some(event => event.startsWith(`completion:${finalOwner.bindingId}:`)),"settled team failure still gets a final review");
    assert.equal(works.getWork(id)?.closureConclusion,"ended_unsuccessfully","team failure closes honestly without waiting for the unrelated queue recovery lane");
  }

  const failed = create("review-fails"); await flush(); failReview = true; states.set(failed,"completed"); await flush();
  assert.equal(works.getWork(failed)?.lifecycle,"active");
  db.connection.prepare("UPDATE work_completion_turns SET retry_at=0 WHERE binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?)").run(failed);
  await flush(); failReview=false;
  assert.equal(works.getWork(failed)?.lifecycle,"closed","report failure delivers original result instead of hanging");
  assert.equal(works.repo.listBindings(failed).length,1,"summary retry never reruns the business task");
  assert.deepEqual(errors, []);
  console.log("PASS automatic completion: delivery, in-flight, replay, watch, honest missing evidence, legacy history, unknown effects, real clarification");
} finally { coordinator.close(); await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
