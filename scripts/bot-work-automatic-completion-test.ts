import { completionReviewInput } from "../src/main/agent/work/WorkCompletionReviewTarget";
import { completionMilestoneEvidence } from "../src/main/agent/work/WorkCompletionMilestoneEvidence";
import type { WorkExecutionBindingDto } from "../src/shared/bot-work";
import { WorkCompletionCoordinator } from "../src/main/agent/work/WorkCompletionCoordinator";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { prepareClosureReview } from "../src/main/agent/work/WorkClosureReview";
import { capabilityOfGuarantee } from "../src/shared/bot-work-phase5";

const root = mkdtempSync(join(tmpdir(), "automatic-completion-"));
const evidenceSnapshot = join(root,"registered-final.md");
const evidenceText = "# Final report\nReal current contents, not a filename claim.";
writeFileSync(evidenceSnapshot,evidenceText);
const evidenceDigest = createHash("sha256").update(evidenceText).digest("hex");
const waitingRequest = "先交付草稿，最终文件的内容我稍后补充；保留同一事项，不轮询，不算整体完成。";
const waitingFiles = [join(root, "draft.txt"), join(root, "draft-r2.txt"), join(root, "final.txt")];
const waitingBytes = ["DRAFT_ALPHA", "DRAFT_BETA", "FINAL_BETA"];
waitingFiles.forEach((path,index)=>writeFileSync(path,waitingBytes[index]));
let evidenceReviews = 0;
let milestoneReviews = 0;
let scopeReviews = 0;
let scopeBinding: WorkExecutionBindingDto;
const mixedOriginal="先回答23+19；独立后台委托检索：诊断、修复并验证，禁止修改records.json。另独立设置2分钟提醒。";
const mixedGoal="诊断、修复并验证检索";
let milestoneBinding: WorkExecutionBindingDto;
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
    if (title === "delivery-responsibility") return {status:"completed",summary:"final.txt 已真实生成并核验；执行器没有 QQ 直发工具。",
      artifactRefs:[waitingFiles[2]],hasWriteConflicts:false,generatedArtifacts:[{path:waitingFiles[2],snapshotPath:waitingFiles[2],
        digest:createHash("sha256").update(waitingBytes[2]).digest("hex"),sizeBytes:Buffer.byteLength(waitingBytes[2]),registeredAt:Date.now(),sourceEntryId:1}]};
    if (title === "waiting-draft") {
      const snapshot = waitingFiles[binding.intentRevision - 1];
      const text = waitingBytes[binding.intentRevision - 1];
      return { status: "completed", summary: binding.intentRevision < 3 ? "草稿已登记，最终内容等待用户补充。" : "最终文件已按新内容完成。",
        artifactRefs: [snapshot], hasWriteConflicts: false,
        generatedArtifacts: [{ path: snapshot, snapshotPath: snapshot, digest: createHash("sha256").update(text).digest("hex"),
          sizeBytes: Buffer.byteLength(text), registeredAt: Date.now(), sourceEntryId: binding.intentRevision }] };
    }
    if (title === "evidence-race") return {status:"completed",summary:"文件已完成",artifactRefs:[evidenceSnapshot],hasWriteConflicts:false,
      generatedArtifacts:[{path:join(root,"final.md"),snapshotPath:evidenceSnapshot,digest:evidenceDigest,sizeBytes:Buffer.byteLength(evidenceText),registeredAt:1,sourceEntryId:1}]};
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
    if (input.context.title === "mixed-scope-review") {
      scopeReviews++;
      const target=input.context.reviewTarget as ReturnType<typeof completionReviewInput>["reviewTarget"];
      assert.equal(target.kind,"single_work_delegation");assert.equal(target.bindingId,scopeBinding.bindingId);
      assert.equal(target.workId,scopeBinding.workId);assert.equal(target.ownerEpoch,scopeBinding.ownerEpoch);
      assert.equal(target.intentRevision,scopeBinding.intentRevision);assert.equal(target.inputSnapshotId,scopeBinding.inputSnapshotId);
      assert.equal(target.delegationPlan?.provenance,"assistant_generated");
      assert.equal(target.delegationPlan?.description,scopeReviews===1 ? mixedGoal : mixedGoal+"；交付实际证据");
      const original=input.context.originalRequest as {userRequest:{messages:Array<{text:string}>};instructions?:unknown};
      assert.equal(original.userRequest.messages[0].text,mixedOriginal,"all independent branches and omitted user restrictions remain available");
      assert.equal(original.instructions,undefined,"executor instructions remain excluded");
      assert(!JSON.stringify(target).includes("2分钟提醒"),"the delegated target is not widened to unrelated request branches");
      if(scopeReviews===1) db.connection.prepare("UPDATE work_intent_snapshots SET goal_description=? WHERE work_id=? AND intent_revision=? AND input_snapshot_id=?")
        .run(mixedGoal+"；交付实际证据",scopeBinding.workId,scopeBinding.intentRevision,scopeBinding.inputSnapshotId);
    }
    if (input.context.title === "milestone-race") {
      milestoneReviews++;
      const evidence = input.context.milestoneDeliveryEvidence as ReturnType<typeof completionMilestoneEvidence>;
      assert.equal(evidence.deliveries.length,milestoneReviews === 1 ? 1 : 2);
      assert.equal(evidence.deliveries[0].millisecondsBeforeSettlement,155000);
      if (milestoneReviews === 1) publishMilestone(milestoneBinding,"both",1794436504279);
    }
    if (input.context.title === "evidence-race") {
      evidenceReviews++;
      const evidence = input.context.artifactEvidence as Array<{state:string;text?:string}>;
      assert.equal(evidence.length,1);
      if (evidenceReviews === 1) {
        assert.equal(evidence[0].text,evidenceText,"review gets actual registered bytes");
        writeFileSync(evidenceSnapshot,"TODO missing all core sections");
        return {decision:"deliver",outcome:"completed",reply:"stale completed claim",missing:[]};
      }
      assert.equal(evidence[0].state,"changed","late mutation is detected before decision application");
      assert.equal(evidence[0].text,undefined,"unregistered replacement bytes are never adopted");
      return {decision:"deliver",outcome:"partial",reply:"登记后的成品发生变化，完整性尚未核实。",missing:[]};
    }
    if (failReview) throw Error("model unavailable");
    if (lateQuestionWork) { works.repo.insertBlocker({blockerId:"late-question",workId:lateQuestionWork,kind:"operational",reason:"必须提供收件人",waitingForUserInput:true,status:"open",createdAt:Date.now()}); lateQuestionWork=undefined; }
    if ((input.context.pendingQuestions as Array<{blockerId:string}>|undefined)?.some(item=>item.blockerId === "late-question")) return {decision:"ask",outcome:"partial",reply:"必须提供收件人",missing:[]};
    if (input.context.title === "waiting-input") return {decision:"ask",outcome:"partial",reply:"已交付请求的文字方案；收件人是谁？",missing:[]};
    if (input.context.title === "delivery-responsibility") {
      const delivery=input.context.hostDeliveryContext as {responsibility:string;routes:Array<{channel:string;fileDelivery:{capability:string}}>};
      assert.equal(delivery.responsibility,"host");assert.equal(delivery.routes[0].channel,"qq");assert.equal(delivery.routes[0].fileDelivery.capability,"supported");
      return {decision:"deliver",outcome:"partial",reply:"文件已生成并核验，唯一缺口是执行环境没有 QQ 直发工具。",artifactRefs:[waitingFiles[2]],missing:[]};
    }
    if (input.context.title === "waiting-draft" && (input.context.originalRequest as {intentRevision:number}).intentRevision < 3)
      return {decision:"wait",outcome:"partial",reply:"草稿已交付，等待你稍后补充最终内容。",missing:[],
        userInput:{requestExcerpt:"最终文件的内容我稍后补充"},artifactRefs:[waitingFiles[(input.context.originalRequest as {intentRevision:number}).intentRevision - 1]]};
    if (lateResultWork) { db.connection.prepare("UPDATE work_deliverables SET summary=summary || ' 后到证据' WHERE work_id=?").run(lateResultWork); lateResultWork=undefined; }
    if (reviewContinue && ["continue-required","team-review-followup"].includes(String(input.context.title))) { reviewContinue=false; return {decision:"continue",outcome:"partial",reply:"已完成第一部分，补充剩余内容",missing:[{task:"补充剩余内容",requestExcerpt:String(input.context.title), ...(input.context.title === "team-review-followup" ? {teamTarget:(() => { const target = (input.context.teamContinuationTargets as any[])[0]; return {sourceBindingId:target.sourceBindingId,botId:target.botId,responsibility:target.responsibility,intentRevision:target.intentRevision,inputSnapshotId:target.inputSnapshotId,evidence:{deliverableId:target.results[0].deliverableId,quote:target.results[0].summary}}; })()} : {})}]}; }
    return { decision: "deliver", outcome: reviewPartial || ["explicit", "uncertain"].includes(String(input.context.title)) ? "partial" : "completed", reply: `已整理：${input.context.title}。结果依据原始执行记录。`, missing: [] }; },
  deliver: input => { assert.notEqual(works.getWork(works.repo.getBinding(input.bindingId)!.workId)?.lifecycle, "closed", "delivery precedes closure");
    return deliveryAvailable && feedback.deliverCompletion(input); }, wake: () => {} });
async function flush() { await queue.drain(); coordinator.wake(); await new Promise(resolve => setImmediate(resolve)); }

function create(name: string, watch = false, criteria?: string[]) {
  const result = works.createWork(user, { operationId: name, title: name, inputSnapshotId: name,
    mode: watch ? "watch" : "once", criteria: criteria?.map(text => ({ text })), authorization: DESKTOP_USER_GRANTS });
  assert(result.ok, JSON.stringify(result));
  works.transaction(() => queue.enqueue(result.work, name));
  states.set(result.work.workId, "running");
  return result.work.workId;
}
function publishMilestone(binding: WorkExecutionBindingDto, version: string, createdAt: number, override = {}) {
  const eventId = `milestone:${binding.bindingId}`;
  const metadata = {workId:binding.workId,eventId,kind:"binding" as const,category:"progress" as const,
    executionId:binding.bindingId,intentRevision:binding.intentRevision,inputSnapshotId:binding.inputSnapshotId,
    report:{title:"milestone",summary:version,artifactRefs:["/immutable/A-v1.md"],files:[{ref:"/immutable/A-v1.md",name:"A.md",openPath:"/immutable/A-v1.md"}],
      milestone:true as const,reviewStatus:"proposed" as const,current:true,notices:[]},...override};
  assert(feedback.messages.appendWorkDelivery(LOCAL_USER_ID,binding.workId,eventId,version,version,metadata).delivered);
  db.connection.prepare("UPDATE bot_messages SET created_at=? WHERE ordinal=(SELECT MAX(ordinal) FROM bot_messages)").run(createdAt);
}
try {
  const mixedReceipt=feedback.messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:"mixed-scope",text:mixedOriginal});
  const mixedCreated=works.createWork({kind:"bot",botId:DEFAULT_BOT_ID,userId:LOCAL_USER_ID,host:"foreground",grants:DESKTOP_USER_GRANTS},
    {operationId:"mixed-scope-review",title:"mixed-scope-review",goalDescription:mixedGoal,
      sourceMessageId:mixedReceipt.userMessageId,inputSnapshotId:`input:${mixedReceipt.userMessageId}`,authorization:DESKTOP_USER_GRANTS});
  assert(mixedCreated.ok,JSON.stringify(mixedCreated));
  const mixedWork=mixedCreated.work.workId;
  works.transaction(()=>queue.enqueue(mixedCreated.work,"mixed-scope-review"));states.set(mixedWork,"running");await flush();
  scopeBinding=works.repo.listBindings(mixedWork)[0]!;
  const scopeSource=JSON.parse(works.repo.executionInput(scopeBinding));
  for(const mismatch of [{workId:"wrong"},{intentRevision:999},{inputSnapshotId:"wrong"}])
    assert.throws(()=>completionReviewInput(scopeBinding,{...scopeSource,...mismatch}),/does not match/);
  states.set(mixedWork,"completed");await flush();
  assert.equal(scopeReviews,1);assert.notEqual(works.getWork(mixedWork)?.lifecycle,"closed","in-flight target changes reject stale conclusions");
  const scopeContext=JSON.parse((db.connection.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id=?").get(scopeBinding.bindingId) as {context_json:string}).context_json);
  delete scopeContext.reviewTarget;
  db.connection.prepare("UPDATE work_completion_turns SET context_json=?,decision_json=? WHERE binding_id=?")
    .run(JSON.stringify(scopeContext),JSON.stringify({decision:"deliver",outcome:"partial",reply:"unrelated reminder unverified",missing:[]}),scopeBinding.bindingId);
  await flush();assert.equal(scopeReviews,2,"legacy cached verdict must be reviewed with the exact scope");
  assert.equal(works.getWork(mixedWork)?.closureConclusion,"succeeded","host applies the scoped test reviewer verdict; no external branch is executed");
  const milestoneWork=create("milestone-race"); await flush();
  milestoneBinding=works.repo.listBindings(milestoneWork)[0]!;
  db.connection.prepare("UPDATE work_execution_bindings SET admitted_at=? WHERE binding_id=?").run(1794436380000,milestoneBinding.bindingId);
  publishMilestone(milestoneBinding,"A",1794436385715);
  const readMilestones=()=>completionMilestoneEvidence(db.connection,milestoneBinding);
  assert.equal(readMilestones().deliveries.length,1);
  assert.equal(readMilestones().deliveries[0].settledAt,null);
  const frozenFiles=readMilestones().deliveries[0].files;
  const firstId=readMilestones().deliveries[0].messageId;
  for (const [column,value] of [["role","user"],["status","running"],["request_id","native-claim"]]) {
    const old=(db.connection.prepare(`SELECT ${column} value FROM bot_messages WHERE message_id=?`).get(firstId) as {value:string}).value;
    db.connection.prepare(`UPDATE bot_messages SET ${column}=? WHERE message_id=?`).run(value,firstId);
    assert.equal(readMilestones().deliveries.length,0,"user/native/incomplete messages are not host delivery receipts");
    db.connection.prepare(`UPDATE bot_messages SET ${column}=? WHERE message_id=?`).run(old,firstId);
  }
  db.connection.prepare("UPDATE work_conversations SET channel_type='fixture-other' WHERE work_id=? AND channel_type='bot-delivery'").run(milestoneWork);
  assert.equal(readMilestones().deliveries.length,0,"only the persisted originating delivery route is read");
  db.connection.prepare("UPDATE work_conversations SET channel_type='bot-delivery' WHERE work_id=? AND channel_type='fixture-other'").run(milestoneWork);

  publishMilestone(milestoneBinding,"wrong-revision",1794436385815,{intentRevision:999});
  publishMilestone(milestoneBinding,"wrong-input",1794436385816,{inputSnapshotId:"wrong"});
  publishMilestone(milestoneBinding,"wrong-binding",1794436385817,{executionId:"wrong"});
  publishMilestone(milestoneBinding,"wrong-work",1794436385818,{workId:"wrong"});
  assert.equal(readMilestones().deliveries.length,1,"other identity metadata never enters review");
  assert.equal(completionMilestoneEvidence(db.connection,{...milestoneBinding,ownerEpoch:999}).deliveries.length,0);
  db.connection.prepare("UPDATE works SET owner_epoch=owner_epoch+1 WHERE work_id=?").run(milestoneWork);
  assert.equal(readMilestones().deliveries.length,0,"old ownership is not current evidence");
  db.connection.prepare("UPDATE works SET owner_epoch=owner_epoch-1 WHERE work_id=?").run(milestoneWork);
  states.set(milestoneWork,"completed"); await queue.drain(); await adapter.flush(); await queue.drain();
  db.connection.prepare("UPDATE work_execution_bindings SET settled_at=? WHERE binding_id=?").run(1794436540715,milestoneBinding.bindingId);
  coordinator.wake(); await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(milestoneReviews,1);
  assert.notEqual(works.getWork(milestoneWork)?.lifecycle,"closed","new persisted delivery invalidates an in-flight decision");
  const staleContext=JSON.parse((db.connection.prepare("SELECT context_json FROM work_completion_turns WHERE binding_id=?").get(milestoneBinding.bindingId) as {context_json:string}).context_json);
  delete staleContext.milestoneDeliveryEvidence;
  db.connection.prepare("UPDATE work_completion_turns SET context_json=?,decision_json=? WHERE binding_id=?")
    .run(JSON.stringify(staleContext),JSON.stringify({decision:"deliver",outcome:"partial",reply:"stale cached summary denies early delivery",missing:[]}),milestoneBinding.bindingId);
  await flush(); assert.equal(milestoneReviews,2);
  assert.deepEqual(readMilestones().deliveries[0].files,frozenFiles,"later reports never substitute earlier attachment metadata");
  assert.equal(works.getWork(milestoneWork)?.closureConclusion,"succeeded");
  const largeFiles=Array.from({length:25},(_,i)=>({ref:`/immutable/${i}-${"x".repeat(2500)}`,name:`file-${i}`,openPath:`/immutable/${i}-${"x".repeat(2500)}`}));
  const metadataRow=db.connection.prepare("SELECT metadata_json FROM bot_work_feedback WHERE message_id=?").get(firstId) as {metadata_json:string};
  const oversized=JSON.parse(metadataRow.metadata_json);oversized.report.files=largeFiles;oversized.report.summary="x".repeat(3000);
  db.connection.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id=?").run(JSON.stringify(oversized),firstId);
  const bounded=readMilestones().deliveries[0];
  assert(bounded.omittedFileCount>0);assert.equal(bounded.summary.length,2000);assert.equal(bounded.summaryTruncated,true);
  assert(JSON.stringify(bounded.files).length<48000,"total historical file metadata is bounded");
  db.connection.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id=?").run(metadataRow.metadata_json,firstId);
  for(let i=0;i<22;i++) publishMilestone(milestoneBinding,`bounded-${i}`,1794436540800+i);
  assert.equal(readMilestones().deliveries.length,20); assert.equal(readMilestones().omittedDeliveryCount,4);
  const originalMetadata=JSON.parse(metadataRow.metadata_json);
  db.connection.transaction(() => {
    for(let i=0;i<1000;i++) {
      const eventId=`unrelated:${i}`;
      feedback.messages.appendWorkDelivery(LOCAL_USER_ID,milestoneWork,eventId,"1","unrelated history",{...originalMetadata,eventId});
    }
  })();
  let plan: Array<{detail:string}> = [];
  const tracedDb={prepare:(sql:string)=>({all:(...params: unknown[])=>{
    plan=db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{detail:string}>;
    return db.connection.prepare(sql).all(...params);
  }})} as unknown as typeof db.connection;
  assert.deepEqual(completionMilestoneEvidence(tracedDb,milestoneBinding),readMilestones(),"unrelated feedback does not change evidence");
  const planText=plan.map(row=>row.detail).join("\n");
  assert(/SEARCH m USING INDEX .*\(conversation_id=\? AND request_id>\? AND request_id<\?\)/.test(planText),planText);
  assert(/SEARCH f USING INDEX .*\(message_id=\?\)/.test(planText),planText);
  assert(!/SCAN [mf]\b/.test(planText),"never scan all message or feedback history: "+planText);
  console.log("PASS milestone indexed lookup:",planText);

  // Reproduce the live race: the native terminal receipt becomes visible before
  // the dispatch loop has atomically chosen recovery vs final readback.
  const recoveryRace = create("recovery-review-race"); await flush();
  const failedBinding = works.repo.listBindings(recoveryRace)[0]!;
  states.set(recoveryRace, "failed");
  await adapter.flush();
  coordinator.wake(); await new Promise(resolve => setImmediate(resolve));
  assert(!reviewed.some(event => event.startsWith(`completion:${failedBinding.bindingId}:`)), "failed receipt must not race recovery with a premature model review");
  assert.equal(works.getWork(recoveryRace)?.lifecycle, "active", "failure receipt cannot close before recovery dispatch");
  await queue.drain();
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
  const evidenceRace = create("evidence-race"); await flush(); states.set(evidenceRace,"completed"); await flush();
  assert.notEqual(works.getWork(evidenceRace)?.lifecycle,"closed","snapshot mutation rejects stale completed verdict");
  await flush(); assert.equal(evidenceReviews,2);
  assert.equal(works.getWork(evidenceRace)?.closureConclusion,"ended_unsuccessfully");
  const evidenceOrigin = feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,evidenceRace)!;
  assert(!JSON.stringify(feedback.messages.history(LOCAL_USER_ID,{botId:evidenceOrigin.bot_id,conversationId:evidenceOrigin.conversation_id})).includes("stale completed claim"));

  const healthy = create("healthy"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "active", "running remains active");
  states.set(healthy, "completed"); await flush();
  assert.equal(works.getWork(healthy)?.lifecycle, "closed");
  assert.equal(works.getWork(healthy)?.closureConclusion, "succeeded");
  assert.equal(works.repo.listDeliverables(healthy)[0]?.status, "proposed", "automatic end is not forged acceptance");
  const version = works.getWork(healthy)?.stateVersion;
  await flush(); assert.equal(works.getWork(healthy)?.stateVersion, version, "replay does not reclose");

  const legacy = create("legacy-unreviewed"); await flush(); states.set(legacy,"completed");
  await queue.drain();
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
  const waitingSource = feedback.messages.accept(LOCAL_USER_ID, {botId:DEFAULT_BOT_ID,requestId:"waiting-draft-source",text:waitingRequest});
  const waitingCreated = works.createWork(user, {operationId:"waiting-draft",title:"waiting-draft",goalDescription:waitingRequest,
    sourceMessageId:waitingSource.userMessageId,inputSnapshotId:`input:${waitingSource.userMessageId}`,authorization:DESKTOP_USER_GRANTS});
  assert(waitingCreated.ok,JSON.stringify(waitingCreated));
  const waitingId = waitingCreated.work.workId;
  works.transaction(() => queue.enqueue(waitingCreated.work,"waiting-draft"));
  states.set(waitingId,"completed"); await flush();
  assert.equal(works.getWork(waitingId)?.lifecycle,"active","one-time goal waiting for promised user input remains amendable");
  assert.equal(works.getWork(waitingId)?.closureConclusion,undefined);
  const waitingBlockers=works.repo.listOpenBlockers(waitingId);
  assert.equal(waitingBlockers.length,1);assert.equal(waitingBlockers[0].reasonCode,"user-input");
  assert(waitingBlockers[0].waitingForUserInput && waitingBlockers[0].details?.userInput);
  const waitingOrigin2=feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,waitingId)!;
  assert(feedback.messages.history(LOCAL_USER_ID,{botId:waitingOrigin2.bot_id,conversationId:waitingOrigin2.conversation_id}).messages
    .some(message=>message.workFeedback?.report?.completion?.nextStep === "ask" && message.workFeedback.report.files?.some(file=>file.ref===waitingFiles[0])));
  for(let i=0;i<3;i++) await flush();
  assert.equal(works.repo.listBindings(waitingId).length,1,"waiting consumes the review without polling or replaying business work");
  const latestWaiting=works.getWork(waitingId)!;
  const amendedWaiting=works.amendWork(user,{operationId:"waiting-draft-input",workId:waitingId,goalDescription:"先更新草稿为 DRAFT_BETA，最终内容仍稍后补充。",
    versionGuard:{expectedStateVersion:latestWaiting.stateVersion,expectedIntentRevision:latestWaiting.intentRevision,expectedOwnerEpoch:latestWaiting.ownerEpoch}});
  assert(amendedWaiting.ok,JSON.stringify(amendedWaiting));assert.equal(amendedWaiting.work?.intentRevision,2);
  assert.equal(amendedWaiting.work?.sourceMessageId,waitingSource.userMessageId);
  works.transaction(()=>queue.enqueue(works.getWork(waitingId)!,"waiting-draft-input"));await flush();
  assert.equal(works.getWork(waitingId)?.lifecycle,"active");
  assert.equal(works.repo.listOpenBlockers(waitingId).length,1,"new wait replaces only the exact reviewed prior result-lane question");
  const secondBinding=works.repo.listBindings(waitingId).at(-1)!;
  assert.equal(works.repo.listOpenBlockers(waitingId)[0].sourceRef,`user-input:completion:${secondBinding.bindingId}:question`);
  const partialCards=works.cards.list(works.getWork(waitingId)!).filter(card=>card.kind==="blocked_escalation");
  assert(partialCards.some(card=>card.artifactRefs.length===1 && card.artifactRefs[0]===waitingFiles[0]));
  assert(partialCards.some(card=>card.artifactRefs.length===1 && card.artifactRefs[0]===waitingFiles[1]),"revision 2 has its own exact new partial artifact card");
  assert.equal(works.repo.listNotifications(waitingId).filter(notification=>notification.kind==="blocked").length,2,"two distinct partial results use existing semantic notification dedupe");
  for(let i=0;i<3;i++) await flush();
  assert.equal(works.repo.listBindings(waitingId).length,2);
  const secondWaiting=works.getWork(waitingId)!;
  const finalWaiting=works.amendWork(user,{operationId:"waiting-final-input",workId:waitingId,goalDescription:"最终文件内容为 FINAL_BETA，完成后交付。",
    versionGuard:{expectedStateVersion:secondWaiting.stateVersion,expectedIntentRevision:secondWaiting.intentRevision,expectedOwnerEpoch:secondWaiting.ownerEpoch}});
  assert(finalWaiting.ok,JSON.stringify(finalWaiting));assert.equal(finalWaiting.work?.intentRevision,3);
  works.transaction(()=>queue.enqueue(works.getWork(waitingId)!,"waiting-final-input"));await flush();
  assert.equal(works.getWork(waitingId)?.closureConclusion,"succeeded","same Work closes successfully only after current-revision completion");
  assert.equal(works.repo.listBindings(waitingId).length,3);assert.equal(works.repo.listOpenBlockers(waitingId).length,0);
  console.log("PASS two precise partial artifact notifications + one current user-input blocker on the same Work without polling, then revision 3 completes");
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
  const continuationBindings=works.repo.listBindings(continuation);
  assert.equal(works.partialResults.deliverySource(continuationBindings[1])?.bindingId,continuationBindings[0].bindingId,"delivery ancestry comes from the persisted continuation dispatch");
  for (const mismatch of [{workId:"foreign"},{intentRevision:999},{inputSnapshotId:"foreign"},{ownerEpoch:999},{botId:"foreign"},{taskId:"foreign"}])
    assert.equal(works.partialResults.deliverySource({...continuationBindings[1],...mismatch}),undefined,"continuation ancestry cannot cross identity, input or ownership boundaries");
  bots.registerBot({botId:"team-review-member",userId:LOCAL_USER_ID,displayName:"成员",authorization:DESKTOP_USER_GRANTS});
  // Formal team Work now needs a saved team template; the fixture saves the same plan first.
  const savedTeam=works.teams.handle({...user,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}}, {kind:"save_template",request:{
    operationId:"team-review-template",name:"自动完成复核团队",plan:{ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:"汇总真实成果",
      members:[{botId:"team-review-member",responsibility:"分析资料",delegatedScope:["workspace:read"]}]}}});
  assert(savedTeam.ok && savedTeam.template,JSON.stringify(savedTeam));
  const teamResult=works.teams.handle({...user,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}}, {kind:"create",request:{
    operationId:"team-review-followup",templateId:savedTeam.template!.templateId,title:"team-review-followup",goalDescription:"补充剩余内容",workspacePath:root,
    ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:"汇总真实成果",members:[{botId:"team-review-member",responsibility:"分析资料",delegatedScope:["workspace:read"]}],criteria:["补充剩余内容"]}});
  assert(teamResult.ok,JSON.stringify(teamResult));
  const teamId=teamResult.work!.workId;
  for(let i=0;i<5;i++) await queue.drain();
  const originalTeamBindings=works.repo.listBindings(teamId);
  assert.equal(originalTeamBindings.length,2);
  db.connection.prepare("DELETE FROM work_automatic_completion WHERE work_id=?").run(teamId);
  works.transaction(()=>works.automaticCompletion.recoverUnreviewed());
  reviewContinue=true;
  coordinator.wake(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(works.getWork(teamId)?.lifecycle,"active","team review schedules missing part without user acceptance");
  for(let i=0;i<5;i++) await flush();
  assert.equal(works.getWork(teamId)?.closureConclusion,"succeeded","team owner continuation returns to automatic review and closes");
  assert.equal(works.repo.listBindings(teamId).length,4,"one original member supplements, then the read-only owner summarizes again");

  for (const variant of ["empty", "reusable"]) {
    const teamFailure = works.teams.handle({...user,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}}, {kind:"create",request:{
      operationId:`team-owner-failure-${variant}`,templateId:savedTeam.template!.templateId,title:`team-owner-failure-${variant}`,goalDescription:"交付团队成果并说明实际缺项",workspacePath:root,
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
  const failedOrigin=feedback.messages.resolveWorkDelivery(LOCAL_USER_ID,failed)!;
  const fallbackMessages=feedback.messages.history(LOCAL_USER_ID,{botId:failedOrigin.bot_id,conversationId:failedOrigin.conversation_id}).messages.filter(item=>item.workIds.includes(failed)&&item.workFeedback?.report);
  const fallbackReport=fallbackMessages.at(-1)!.workFeedback!.report!;
  assert(fallbackMessages[0].workFeedback!.report!.notices.some(text=>text.includes("正在重试整理")),"first failure still explains pending retry without dumping raw output");
  assert.equal(fallbackReport.completion?.outcome,"unknown","review failure must not pretend the goal was verified");
  assert.match(fallbackReport.summary,/目标是否达成尚未核实/);
  assert(!fallbackReport.summary.includes("已交付请求的文字方案"),"failure does not dump the worker report into the foreground");
  assert(fallbackMessages.at(-1)!.text.includes("已交付请求的文字方案"),"raw worker result stays in the exact delivery record");
  assert(fallbackReport.sourceNotices?.includes("model unavailable"),"technical diagnostic stays available as secondary evidence");
  const qqOrigin={channelId:"qq-default",connectionKey:"c".repeat(64),chatId:"c2c:closure-owner",senderId:"closure-owner",
    messageId:"closure-natural-request",audience:"private" as const};
  const deliverySource=db.connection.transaction(()=>{
    const conversationId=feedback.messages.origins.gatewayConversation(LOCAL_USER_ID,DEFAULT_BOT_ID,qqOrigin);
    const receipt=feedback.messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,conversationId,requestId:"closure-natural-request",
      text:"生成 final.txt，逐字 FINAL_BETA，读取核验并登记，完成后把结果发回最初的 QQ 会话。"});
    feedback.messages.origins.recordGateway(LOCAL_USER_ID,receipt,{...qqOrigin,workTarget:{version:1,channelType:"qq",channelId:qqOrigin.channelId,
      connectionKey:qqOrigin.connectionKey,chatId:qqOrigin.chatId,senderId:qqOrigin.senderId,
      address:{recipient:qqOrigin.senderId,group:false,messageId:qqOrigin.messageId,expiresAt:Date.now()+600000}}});
    return receipt;
  })();
  const oldFailure=works.createWork(user,{operationId:"delivery-responsibility",title:"delivery-responsibility",
    sourceMessageId:deliverySource.userMessageId,inputSnapshotId:`input:${deliverySource.userMessageId}`,authorization:DESKTOP_USER_GRANTS});
  assert(oldFailure.ok);
  works.transaction(()=>queue.enqueue(oldFailure.work,"delivery-responsibility"));states.set(oldFailure.work.workId,"completed");await flush();
  const oldWork=works.getWork(oldFailure.work.workId)!;
  assert.equal(oldWork.closureConclusion,"ended_unsuccessfully","fixture retains the original real failure mechanism, rather than editing its history");
  const bindingCount=works.repo.listBindings(oldWork.workId).length;
  works.notifications.deliver({channel:"desktop",...capabilityOfGuarantee("best-effort-unqueryable"),
    send:()=>({ok:false,retryable:false,responseLost:false,error:"fixture outbound rejected"})},oldWork.workId);
  const oldNotifications=JSON.stringify(works.repo.listNotifications(oldWork.workId));
  const oldAttempts=JSON.stringify(works.repo.listNotifications(oldWork.workId).flatMap(item=>works.notifications.attempts(item.notificationId)));
  const guardWork=works.getWork(oldWork.workId)!;
  const request={requestId:"correct-host-return",workId:oldWork.workId,expectedCloseOperationId:oldWork.closeOperationId!,versionGuard:{
    expectedStateVersion:guardWork.stateVersion,expectedIntentRevision:guardWork.intentRevision,expectedOwnerEpoch:guardWork.ownerEpoch}};
  const evidence=prepareClosureReview(db.connection,works,request);
  works.repo.insertAdmission({admissionId:"late-unknown-closure-effect",workId:oldWork.workId,bindingId:evidence.binding.bindingId,
    operationId:"late-unknown-closure-effect",actionKind:"write",state:"unknown",intentRevision:oldWork.intentRevision,ownerEpoch:oldWork.ownerEpoch,admittedAt:Date.now()});
  assert.throws(()=>prepareClosureReview(db.connection,works,request),/未知效果/);
  works.repo.updateAdmissionState("late-unknown-closure-effect","released",Date.now());
  const correctedDecision={decision:"deliver",outcome:"completed",reply:"文件的真实创建和核验已经完成；原会话回传由宿主负责，QQ 文件尚无投递回执。",
    artifactRefs:[waitingFiles[2]],missing:[],correction:{kind:"host_delivery_responsibility"}} as const;
  const proposal={...correctedDecision,artifactRefs:[...correctedDecision.artifactRefs],missing:[]};
  const selectedResult=works.repo.listDeliverables(oldWork.workId).find(item=>item.artifactRefs.includes(waitingFiles[2]))!;
  assert.deepEqual(evidence.context.results.find(item=>item.deliverableId===selectedResult.deliverableId)?.uncoveredCriterionIds,[]);
  assert.equal(evidence.context.results.find(item=>item.deliverableId===selectedResult.deliverableId)?.executionId,selectedResult.executionId);
  const gapResult={...selectedResult,deliverableId:"legacy-explicit-business-gap",uncoveredCriterionIds:["required-business-output"]};
  works.repo.insertDeliverable(gapResult);
  assert.throws(()=>prepareClosureReview(db.connection,works,request),/明确业务缺项|未覆盖验收项/);
  assert.throws(()=>works.correctAutomaticClosure(user,request,{evidence,decision:proposal}),/明确业务缺项|未覆盖验收项/,
    "a completed correction marker cannot wash a current selected deliverable's explicit business gap");
  assert.equal(works.getWork(oldWork.workId)?.closureConclusion,"ended_unsuccessfully");
  db.connection.prepare("DELETE FROM work_deliverables WHERE deliverable_id=?").run(gapResult.deliverableId);
  const priorTurn=db.connection.prepare("SELECT decision_json FROM work_completion_turns WHERE binding_id=?").get(evidence.binding.bindingId) as {decision_json:string};
  db.connection.prepare("UPDATE work_completion_turns SET decision_json=? WHERE binding_id=?")
    .run(JSON.stringify({...JSON.parse(priorTurn.decision_json),missing:[{task:"真正尚未完成的业务动作",requestExcerpt:"生成 final.txt"}]}),evidence.binding.bindingId);
  assert.throws(()=>prepareClosureReview(db.connection,works,request),/非 continue 时 missing/,
    "legacy deliver decisions with missing business actions are already rejected by the real decision schema");
  db.connection.prepare("UPDATE work_completion_turns SET decision_json=? WHERE binding_id=?").run(priorTurn.decision_json,evidence.binding.bindingId);
  assert(!works.correctAutomaticClosure({kind:"bot",botId:DEFAULT_BOT_ID,userId:LOCAL_USER_ID,host:"background",grants:DESKTOP_USER_GRANTS},request,{evidence,decision:proposal}).ok);
  const stale=works.correctAutomaticClosure(user,{...request,versionGuard:{...request.versionGuard,expectedStateVersion:request.versionGuard.expectedStateVersion-1}},{evidence,decision:proposal});
  assert(!stale.ok&&stale.code==="version_conflict");
  assert.throws(()=>works.correctAutomaticClosure(user,request,{evidence,decision:{...proposal,outcome:"partial"}}),/没有证明/);
  assert.throws(()=>works.correctAutomaticClosure(user,request,{evidence,decision:{...proposal,correction:undefined}}),/没有证明/);
  writeFileSync(waitingFiles[2],"CHANGED");
  assert.throws(()=>works.correctAutomaticClosure(user,request,{evidence,decision:proposal}),/已变化|不能核验/);
  writeFileSync(waitingFiles[2],waitingBytes[2]);
  const correction=works.correctAutomaticClosure(user,request,{evidence,decision:proposal});assert(correction.ok,JSON.stringify(correction));
  const newWork=works.getWork(oldWork.workId)!;
  assert.equal(newWork.closureConclusion,"succeeded");assert.equal(newWork.lifecycle,"closed");
  assert.equal(newWork.closeOperationId,oldWork.closeOperationId);assert.equal(newWork.closedAt,oldWork.closedAt);
  assert.match(newWork.closureSummary!,/复核更正/);assert.match(newWork.closureSummary!,/文件未请求/);
  assert.equal(works.repo.listBindings(oldWork.workId).length,bindingCount);assert.deepEqual(newWork.acceptedDeliverableIds,[]);
  const history=db.connection.prepare("SELECT original_conclusion,original_summary,original_close_operation_id FROM work_closure_review_corrections WHERE work_id=?").get(oldWork.workId) as {original_conclusion:string;original_summary:string;original_close_operation_id:string};
  assert.equal(history.original_conclusion,"ended_unsuccessfully");assert.equal(history.original_summary,oldWork.closureSummary);assert.equal(history.original_close_operation_id,oldWork.closeOperationId);
  assert.equal(JSON.stringify(works.repo.listNotifications(oldWork.workId).filter(item=>JSON.parse(oldNotifications).some((old:{notificationId:string})=>old.notificationId===item.notificationId))),oldNotifications);
  assert.equal(JSON.stringify(works.repo.listNotifications(oldWork.workId).flatMap(item=>works.notifications.attempts(item.notificationId))),oldAttempts);
  assert(works.cards.list(newWork).some(card=>card.kind==="closure_failed"&&card.currency==="superseded"));
  assert(works.cards.list(newWork).some(card=>card.kind==="closure_succeeded"&&card.currency==="current"&&card.artifactRefs[0]===waitingFiles[2]));
  assert(works.correctAutomaticClosure(user,request).ok,"same authenticated request replays the original correction receipt");
  assert.equal((db.connection.prepare("SELECT count(*) n FROM work_closure_review_corrections WHERE work_id=?").get(oldWork.workId) as {n:number}).n,1);
  assert.throws(()=>prepareClosureReview(db.connection,works,{...request,workId:healthy}),/仅可复核/);
  const manual=works.createWork(user,{operationId:"manual-final-decision",title:"User explicitly ended",inputSnapshotId:"manual-final"});assert(manual.ok);
  const manualEnd=works.closeWork(user,{operationId:"manual-final-close",workId:manual.work.workId,conclusion:"ended_unsuccessfully",closureSummary:"用户明确不再继续。",
    versionGuard:{expectedStateVersion:manual.work.stateVersion,expectedIntentRevision:1,expectedOwnerEpoch:1}});assert(manualEnd.ok);
  assert.throws(()=>prepareClosureReview(db.connection,works,{...request,workId:manual.work.workId,expectedCloseOperationId:"manual-final-close"}),/用户结案或取消/);
  console.log("PASS natural QQ return responsibility context and guarded read-only closure correction: original verdict/events/attempts preserved, current card corrected, no rerun/new Work/accepted fiction");
  assert.deepEqual(errors, []);
  console.log("PASS automatic completion: delivery, in-flight, replay, watch, honest missing evidence, legacy history, unknown effects, real clarification");
} finally { coordinator.close(); await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
