import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto, type WorkSubscriptionDto } from "../src/shared/bot-work";

const root=await mkdtemp(join(tmpdir(),"phase3-pause-")),path=join(root,"business.db");
let db=new AppDatabase(path);let bots=new BotRegistry(db.connection);
bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:"fixture",authorization:DESKTOP_USER_GRANTS});
let works=new WorkService(db.connection,{bots});
const user:WorkActor={kind:"user",userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
const unwrap=(result:WorkControlResult)=>{if(!result.ok)throw Error(`${result.code}: ${result.message}`);return result.work;};
const guard=(work:WorkDto)=>({expectedStateVersion:work.stateVersion,expectedIntentRevision:work.intentRevision,expectedOwnerEpoch:work.ownerEpoch});
const create=(id:string)=>unwrap(works.createWork(user,{operationId:id,title:id,inputSnapshotId:`input:${id}`,authorization:DESKTOP_USER_GRANTS,workspacePath:root}));
const subscribe=(work:WorkDto,policy:WorkSubscriptionDto["catchUpPolicy"],depth=8)=>{
  const result=works.addSubscription(user,work.workId,{source:"hook",catchUpPolicy:policy,maxQueueDepth:depth,maxMergeWaitMs:1});assert(result.ok);return result.subscription!;
};
const event=(work:WorkDto,subscription:WorkSubscriptionDto,id:string,version=id)=>works.ingestSourceEvent({workId:work.workId,subscriptionId:subscription.subscriptionId,source:"hook",sourceEventId:id,eventType:"changed",sourceVersion:version,payload:{version}});
try {
  const work=create("inflight");unwrap(works.dispatchExecution(user,{operationId:"root",workId:work.workId,botId:DEFAULT_BOT_ID,taskId:"root",durableStoreKey:"native:root",conversationId:"1",workspaceBinding:root}));
  const binding=works.repo.bindingForTask("root")!;
  const admitted=works.admitNewAction({kind:"worker",botId:DEFAULT_BOT_ID,bindingId:binding.bindingId},{operationId:"before-pause",admissionId:"unused",workId:work.workId,bindingId:binding.bindingId,actionKind:"workspace:write"});assert(admitted.ok);
  unwrap(works.pauseWork(user,{operationId:"pause",workId:work.workId,versionGuard:guard(works.getWork(work.workId)!)}));
  assert.equal(works.admitNewAction({kind:"worker",botId:DEFAULT_BOT_ID,bindingId:binding.bindingId},{operationId:"after-pause",admissionId:"unused-2",workId:work.workId,bindingId:binding.bindingId,actionKind:"workspace:write"}).ok,false);
  assert(works.getProjection(work.workId)?.nextSteps.some(step=>/结算/.test(step)),"paused projection retains in-flight obligations");
  await writeFile(join(root,"effect.txt"),"actual admitted effect");assert(works.settleAdmission(admitted.admission.admissionId,"consumed").ok);
  assert.deepEqual(works.nativeResults.receive(binding,{taskId:binding.taskId,operationId:binding.operationId,submissionId:1,status:"done"},{status:"completed",summary:"late settlement",hasWriteConflicts:false,artifactRefs:[join(root,"effect.txt")],usageTokens:4}),[]);
  assert.equal(works.getWork(work.workId)?.lifecycle,"paused");assert.equal("budget" in works.getWork(work.workId)!, false);assert.equal(works.repo.listDeliverables(work.workId).length,1);

  const each=create("each"),eachSub=subscribe(each,"each",2);
  unwrap(works.pauseWork(user,{operationId:"each-pause",workId:each.workId,versionGuard:guard(works.getWork(each.workId)!)}));
  assert.equal(event(each,eachSub,"each-1").outcomes[0].outcome,"pending");event(each,eachSub,"each-1");event(each,eachSub,"each-2");
  assert.equal(works.repo.listInbox(each.workId).length,2);assert.deepEqual(works.listDueInbox(each.workId),[]);
  assert.equal(event(each,eachSub,"each-overflow").outcomes[0].outcome,"blocked");assert.equal(works.repo.listInbox(each.workId,["pending","blocked"]).length,2);
  const blocked=works.repo.listOpenBlockers(each.workId).find(item=>item.kind==="backpressure");assert(blocked);
  db.close();db=new AppDatabase(path);bots=new BotRegistry(db.connection);works=new WorkService(db.connection,{bots});
  unwrap(works.resumeWork(user,{operationId:"each-resume",workId:each.workId,versionGuard:guard(works.getWork(each.workId)!)}));
  const due=works.listDueInbox(each.workId);assert.equal(due.length,2);
  let calls=0;
  const apply=(current:WorkDto)=>{calls++;works.repo.updateWork({...current,progressSummary:`processed-${calls}`,stateVersion:current.stateVersion+1,updatedAt:Date.now()});};
  assert((await works.pausedBacklog.consume(due[0].eventId,async current=>current.payload,(current)=>apply(current))).ok);
  assert((await works.pausedBacklog.consume(due[0].eventId,async()=>{throw Error("processed event must not reread");},()=>{throw Error("duplicate apply");})).ok);
  assert.equal(calls,1);
  await assert.rejects(works.pausedBacklog.consume(due[1].eventId,async current=>current.payload,(current)=>{apply(current);throw Error("injected consume crash");}));
  assert.equal(works.repo.getInbox(due[1].eventId)?.status,"pending");assert.equal(works.getWork(each.workId)?.progressSummary,"processed-1");
  assert((await works.pausedBacklog.consume(due[1].eventId,async current=>current.payload,(current)=>apply(current))).ok);

  const latest=create("latest"),latestSub=subscribe(latest,"latest");
  unwrap(works.pauseWork(user,{operationId:"latest-pause",workId:latest.workId,versionGuard:guard(works.getWork(latest.workId)!)}));
  event(latest,latestSub,"latest-new","v3");event(latest,latestSub,"latest-old","v1");event(latest,latestSub,"latest-old","v1");
  assert.equal(works.repo.listInbox(latest.workId).length,2);
  unwrap(works.resumeWork(user,{operationId:"latest-resume",workId:latest.workId,versionGuard:guard(works.getWork(latest.workId)!)}));
  const latestDue=works.listDueInbox(latest.workId,Date.now()+100);assert.equal(latestDue.length,1);
  assert.equal(latestDue[0].payload.authoritativeReadbackRequired,true);
  assert.equal(works.completeInboxEvent(latestDue[0].eventId,()=>{throw Error("cannot trust arrival payload");}).ok,false);
  await writeFile(join(root,"authoritative.txt"),"v4-current");
  assert((await works.pausedBacklog.consume(latestDue[0].eventId,async()=>readFile(join(root,"authoritative.txt"),"utf8"),(current,inbox,version)=>{
    const result=works.applyObservedSources(current.workId,`observed:${inbox.eventId}`,current,{inputSnapshotId:`authoritative:${version}`,sources:[{sourceType:"file",sourceRef:join(root,"authoritative.txt"),inputSnapshotId:`authoritative:${version}`,observedAt:Date.now()}]});
    if(!result.ok)throw Error(result.message);
  })).ok);
  assert.equal(works.getWork(latest.workId)?.inputSnapshotId,"authoritative:v4-current");
  // Phase 4 contract: the provider source watermark never stores an input snapshot hash.
  assert.equal(works.repo.getSubscription(latestSub.subscriptionId)?.lastProcessedSourceVersion,undefined);
  assert.equal(works.ingress.cursor(latestSub.subscriptionId,"hook","default")?.highestConsumedVersion,"v3");
  assert.equal(works.getWork(latest.workId)?.inputSnapshotId,"authoritative:v4-current");

  const skip=create("skip"),skipSub=subscribe(skip,"skip");unwrap(works.pauseWork(user,{operationId:"skip-pause",workId:skip.workId,versionGuard:guard(works.getWork(skip.workId)!)}));
  event(skip,skipSub,"skip-old");unwrap(works.resumeWork(user,{operationId:"skip-resume",workId:skip.workId,versionGuard:guard(works.getWork(skip.workId)!)}));
  assert.equal(works.repo.listInbox(skip.workId,["skipped"]).length,1);event(skip,skipSub,"skip-future");assert.equal(works.listDueInbox(skip.workId).length,1);
  assert.equal(works.repo.listBindings(work.workId).length,1,"ordinary resume never creates another full root");
  console.log("Phase 3 pause: pre-admitted effects settle; late action blocked; persistent bounded each/latest/skip backlog, duplicate/order handling and rollback/reopen passed");
} finally {db.close();await rm(root,{recursive:true,force:true});}
