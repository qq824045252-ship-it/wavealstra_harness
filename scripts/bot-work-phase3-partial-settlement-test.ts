import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkSourceObserver } from "../src/main/agent/work/WorkSourceObserver";
import { readNativeSubitems } from "../src/main/agent/durable/DurableWorkExecutionProjection";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import type { WorkSubitemResult } from "../src/shared/bot-work-phase3";

const root=await mkdtemp(join(tmpdir(),"phase3-partial-")), database=join(root,"business.db");
let db=new AppDatabase(database); let bots=new BotRegistry(db.connection);
bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:"fixture",authorization:DESKTOP_USER_GRANTS});
let works=new WorkService(db.connection,{bots});
const user: WorkActor={kind:"user",userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
const unwrap=(result:WorkControlResult)=>{if(!result.ok) throw Error(`${result.code}: ${result.message}`);return result.work;};
const guard=(work:WorkDto)=>({expectedStateVersion:work.stateVersion,expectedIntentRevision:work.intentRevision,expectedOwnerEpoch:work.ownerEpoch});
const item=(itemId:string,outcome:WorkSubitemResult["outcome"],artifactRefs:string[]=[]):WorkSubitemResult=>({itemId,task:`task-${itemId}`,required:true,dependencies:[],criterionIds:[],nativeStatus:outcome==="blocked"?"completed":outcome,outcome,artifactRefs,writeConflicts:outcome==="blocked"?["same.txt"]:[],summary:`result-${itemId}`});
const make=(id:string,criteria:Parameters<WorkService["createWork"]>[1]["criteria"]=[])=>unwrap(works.createWork(user,{operationId:id,title:id,inputSnapshotId:`input-${id}`,criteria,authorization:DESKTOP_USER_GRANTS,workspacePath:root}));
const bind=(work:WorkDto,id:string)=>{unwrap(works.dispatchExecution(user,{operationId:id,workId:work.workId,botId:DEFAULT_BOT_ID,taskId:id,durableStoreKey:`store:${id}`,conversationId:"1",workspaceBinding:root}));return works.repo.bindingForTask(id)!;};
const receipt=(binding:ReturnType<typeof bind>):AgentSubmissionReceipt=>({taskId:binding.taskId,operationId:binding.operationId,submissionId:1,status:"done"});
try {
  await writeFile(join(root,"done.txt"),"retained-effect");
  const work=make("partial",[{id:"auto",text:"all necessary scope"}]),binding=bind(work,"original");
  const subitems=[item("one","completed",[join(root,"done.txt")]),item("two","blocked")];
  assert.deepEqual(works.nativeResults.receive(binding,receipt(binding),{status:"completed",summary:"mixed native outcome",hasWriteConflicts:true,artifactRefs:[],usageTokens:7,subitems}),[]);
  assert.equal(works.partialResults.list(work.workId).length,2);
  assert.equal(works.partialResults.gaps(work.workId)[0].itemId,"two");
  const partial=works.repo.listDeliverables(work.workId).find(result=>result.deliverableId.startsWith("partial:"))!;
  assert.equal(partial.status,"proposed"); assert.deepEqual(partial.artifactRefs,[join(root,"done.txt")]);
  assert.equal("budget" in works.getWork(work.workId)!, false);
  const gapClose=works.closeWork(user,{operationId:"cannot-close",workId:work.workId,conclusion:"succeeded",versionGuard:guard(works.getWork(work.workId)!)});
  assert.equal(gapClose.ok,false);if(!gapClose.ok){const gap=works.partialResults.gaps(work.workId)[0];assert.ok(gapClose.message.includes(gap.task));assert.ok(gapClose.message.includes(gap.outcome));}
  const beforeResume=works.repo.listBindings(work.workId).length;
  let state=unwrap(works.pauseWork(user,{operationId:"pause",workId:work.workId,versionGuard:guard(works.getWork(work.workId)!)}));
  state=unwrap(works.resumeWork(user,{operationId:"resume",workId:work.workId,versionGuard:guard(state)}));
  const params={operationId:"continue",workId:work.workId,sourceBindingId:binding.bindingId,gapItemIds:["two"],reason:"complete only blocked necessary scope",versionGuard:guard(state)};
  unwrap(works.continueWork(user,params)); unwrap(works.continueWork(user,params));
  const competingDb=new AppDatabase(database);const competingWorks=new WorkService(competingDb.connection,{bots:new BotRegistry(competingDb.connection)});
  assert.equal(competingWorks.continueWork(user,{...params,operationId:"competing-plan"}).ok,false,"independent stale CAS cannot create another gap plan");competingDb.close();
  const bad=works.continueWork(user,{...params,operationId:"repeat-completed",gapItemIds:["one"],versionGuard:guard(works.getWork(work.workId)!)});
  assert.equal(bad.ok,false);
  assert.equal(works.partialResults.plans(work.workId).length,1);
  db.close(); db=new AppDatabase(database); bots=new BotRegistry(db.connection); works=new WorkService(db.connection,{bots});
  assert.equal(works.partialResults.plans(work.workId).length,1);
  const submitted:string[]=[], submittedTexts:string[]=[], receipts=new Map<string,AgentSubmissionReceipt>();
  const native:WorkExecutionPort={prepare:async taskId=>({taskId,durableStoreKey:`store:${taskId}`,conversationId:"1",workspaceBinding:root}),find:async next=>receipts.get(next.bindingId),
    submit:async(next,input)=>{submitted.push(next.bindingId);submittedTexts.push(input);await writeFile(join(root,"gap.txt"),"new-gap-effect");const value={taskId:next.taskId,operationId:next.operationId,submissionId:1,status:"done" as const};receipts.set(next.bindingId,value);return value;},
    inspect:async()=>({status:"completed",summary:"gap only",hasWriteConflicts:false,artifactRefs:[join(root,"gap.txt")],usageTokens:3,subitems:[item("two","completed",[join(root,"gap.txt")])]}),stop:async()=>{}};
  const errors:unknown[]=[]; const adapter=new WorkExecutionAdapter(works,native,LOCAL_USER_ID,()=>true,(_id,error)=>errors.push(error));
  const queue=new WorkDispatchQueue(db,works,adapter,()=>true,()=>undefined);
  await queue.flush();await queue.flush();await queue.close();await adapter.close();
  assert.deepEqual(errors,[]);assert.equal(submitted.length,1);assert.equal(works.repo.listBindings(work.workId).length,beforeResume+1);
  assert(submittedTexts[0].includes("task-two"));assert(!submittedTexts[0].includes("task-one"));
  assert.equal(await readFile(join(root,"done.txt"),"utf8"),"retained-effect");assert.equal(await readFile(join(root,"gap.txt"),"utf8"),"new-gap-effect");
  assert.equal("budget" in works.getWork(work.workId)!, false);assert.equal(works.partialResults.gaps(work.workId).length,0);

  // Chain items absent from native results remain explicit unstarted necessary gaps.
  const parsed=readNativeSubitems("chain",JSON.stringify({plan:[{itemId:"a",task:"a"},{itemId:"b",task:"b",dependencies:["a"]},{itemId:"c",task:"c",dependencies:["b"]}],results:[{subagentId:"a",status:"completed",exitCode:0},{subagentId:"b",status:"error",exitCode:1,rejected:true,errorMessage:"not authorized"}]}));
  assert.deepEqual(parsed.map(row=>row.outcome),["completed","rejected","not_started"]);assert.equal(parsed[1].childId,undefined);assert.deepEqual(parsed[2].dependencies,["chain:b"]);

  // Same input, different actual artifact must invalidate old real-environment evidence.
  const real=make("real",[{id:"actual",text:"real fixture environment",requiresRealEnvironmentCheck:true,requiredEnvironment:"fixture-target"}]);
  const realBinding=bind(real,"real-root"); await writeFile(join(root,"code.txt"),"A");
  assert.deepEqual(works.nativeResults.receive(realBinding,receipt(realBinding),{status:"completed",summary:"code",hasWriteConflicts:false,artifactRefs:[join(root,"code.txt")],usageTokens:2}),[]);
  let current=works.getWork(real.workId)!;const artifactSnapshotId=works.artifacts.snapshotId(works.artifacts.capture(real.workId));
  assert.equal(works.closeWork(user,{operationId:"missing-real",workId:real.workId,conclusion:"succeeded",versionGuard:guard(current)}).ok,false);
  current=unwrap(works.recordUserFeedback(user,{operationId:"wrong-input",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-A",inputSnapshotId:"old",artifactSnapshotId,failed:false,versionGuard:guard(works.getWork(real.workId)!)}));
  assert.equal(current.criteria[0].status,"pending");
  current=unwrap(works.recordUserFeedback(user,{operationId:"current-fail",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-A",inputSnapshotId:real.inputSnapshotId,artifactSnapshotId,failed:true,versionGuard:guard(current)}));
  assert.equal(current.criteria[0].status,"failed");
  current=unwrap(works.recordUserFeedback(user,{operationId:"current-pass",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-A",inputSnapshotId:real.inputSnapshotId,artifactSnapshotId,failed:false,versionGuard:guard(current)}));
  assert.equal(current.criteria[0].status,"satisfied");
  const before=await stat(join(root,"code.txt"));await writeFile(join(root,"code.txt"),"B");await utimes(join(root,"code.txt"),before.atime,before.mtime);
  const stale=works.recordUserFeedback(user,{operationId:"stale-artifact",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-A",inputSnapshotId:real.inputSnapshotId,artifactSnapshotId,failed:false,versionGuard:guard(current)});
  assert.equal(stale.ok,false);assert.equal(works.getWork(real.workId)?.criteria[0].status,"pending");assert.equal(works.getWork(real.workId)?.inputSnapshotId,real.inputSnapshotId);
  assert.equal(works.repo.listDeliverables(real.workId)[0].status,"superseded");
  const invalidatedVersion=works.getWork(real.workId)!.stateVersion;
  const repeatedInspection=works.artifacts.capture(real.workId);
  assert.equal(works.transaction(()=>works.artifacts.validate(repeatedInspection)),false,"invalidation cannot disappear after one failed review");
  assert.equal(works.getWork(real.workId)!.stateVersion,invalidatedVersion,"repeated validation does not reset criteria again");
  const replacement=bind(works.getWork(real.workId)!,"real-replacement");
  assert.deepEqual(works.nativeResults.receive(replacement,receipt(replacement),{status:"completed",summary:"replacement current artifact",hasWriteConflicts:false,artifactRefs:[join(root,"code.txt")],usageTokens:2}),[]);
  current=works.getWork(real.workId)!;
  const staleAfterReplacement=works.recordUserFeedback(user,{operationId:"old-feedback-after-replacement",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-A",inputSnapshotId:real.inputSnapshotId,artifactSnapshotId,failed:false,versionGuard:guard(current)});
  assert.equal(staleAfterReplacement.ok,false,"same input does not make old artifact feedback current");
  const nextArtifact=works.artifacts.currentSnapshotId(real.workId);assert.notEqual(nextArtifact,artifactSnapshotId);
  current=unwrap(works.recordUserFeedback(user,{operationId:"replacement-current-feedback",workId:real.workId,criterionIds:["actual"],environment:"fixture-target",sourceRef:"test-version-B",inputSnapshotId:real.inputSnapshotId,artifactSnapshotId:nextArtifact,failed:false,versionGuard:guard(works.getWork(real.workId)!)}));
  assert.equal(current.criteria[0].status,"satisfied");

  // A new owner explicitly adopts an unsubmitted continuation instead of losing or cloning it.
  const grants={...DESKTOP_USER_GRANTS,allowRedelegation:true};const handoffUser:WorkActor={kind:"user",userId:LOCAL_USER_ID,grants};
  bots.registerBot({userId:LOCAL_USER_ID,botId:"new-owner",displayName:"new owner",authorization:grants});
  const handoff=unwrap(works.createWork(handoffUser,{operationId:"handoff-gap",title:"handoff pending gap",inputSnapshotId:"handoff-input",workspacePath:root,authorization:grants}));
  const handoffBinding=bind(handoff,"handoff-original");
  assert.deepEqual(works.nativeResults.receive(handoffBinding,receipt(handoffBinding),{status:"completed",summary:"needs one gap",hasWriteConflicts:true,artifactRefs:[],usageTokens:1,subitems:[item("handoff-item","blocked")]}),[]);
  unwrap(works.continueWork(handoffUser,{operationId:"old-owner-plan",workId:handoff.workId,sourceBindingId:handoffBinding.bindingId,gapItemIds:["handoff-item"],reason:"approved before handoff",versionGuard:guard(works.getWork(handoff.workId)!)}));
  const originalPlan=works.partialResults.plans(handoff.workId)[0];
  db.upsertTask({id:"pending-old-owner-task",title:"old pending",updatedAt:Date.now(),cwd:root});
  db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id)
    VALUES (?,?,?,?,?,?,'pending',?,?)`).run(originalPlan.planId,handoff.workId,"pending-old-owner-task",DEFAULT_BOT_ID,handoff.intentRevision,handoff.inputSnapshotId,Date.now(),originalPlan.planId);
  let handed=unwrap(works.handoffOwner(handoffUser,{operationId:"handoff-owner",workId:handoff.workId,targetBotId:"new-owner",versionGuard:guard(works.getWork(handoff.workId)!)}));
  assert.equal(works.partialResults.plans(handoff.workId)[0].ownerEpoch,1);
  handed=unwrap(works.continueWork(handoffUser,{operationId:"new-owner-adopt-plan",workId:handoff.workId,sourceBindingId:handoffBinding.bindingId,gapItemIds:["handoff-item"],reason:"new owner checked original gap",versionGuard:guard(handed)}));
  const adopted=works.partialResults.plans(handoff.workId);assert.equal(adopted.length,1);assert.equal(adopted[0].planId,originalPlan.planId);assert.equal(adopted[0].ownerBotId,"new-owner");assert.equal(adopted[0].ownerEpoch,handed.ownerEpoch);
  assert.deepEqual(db.connection.prepare("SELECT task_id,bot_id,state FROM work_dispatch_requests WHERE continuation_plan_id=?").get(originalPlan.planId),{task_id:"pending-old-owner-task",bot_id:"new-owner",state:"pending"});

  // Observing one input preserves all unrelated source facts.
  const source=make("sources"); const observer=new WorkSourceObserver(works);
  await writeFile(join(root,"input-a.txt"),"A");await writeFile(join(root,"input-b.txt"),"B");
  unwrap(await observer.files(user,source.workId,"sources-first",[join(root,"input-a.txt"),join(root,"input-b.txt")]));
  await writeFile(join(root,"input-a.txt"),"C"); const refreshed=unwrap(await observer.file(user,source.workId,"sources-update",join(root,"input-a.txt")));
  assert.equal(refreshed.goalSources.length,2);assert(refreshed.goalSources.some(row=>row.sourceRef===join(root,"input-b.txt")));
  console.log("Phase 3 partial settlement: retained success, structured gaps, one persistent gap-only continuation, unchanged effects, and current artifact/environment checks passed");
} finally { db.close();await rm(root,{recursive:true,force:true}); }
