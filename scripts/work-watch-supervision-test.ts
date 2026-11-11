import {createHash} from 'node:crypto';
import {watchGoalEvidence,watchGoalMet} from '../src/main/agent/work/WorkWatchGoal';
import {previousWatchObservations,WATCH_PREVIOUS_SOURCE_LIMIT,WATCH_PREVIOUS_EVIDENCE_BUDGET} from '../src/main/agent/work/WorkWatchComparison';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {WorkService,DESKTOP_USER_GRANTS} from '../src/main/agent/work/WorkService';
import {BotConversationRepository} from '../src/main/agent/work/BotConversationRepository';
import {WorkConversationFeedback} from '../src/main/agent/work/WorkConversationFeedback';
import {isReadOnlyScheduledFollowUp} from '../src/main/agent/work/WorkScheduledFollowUp';
import {WorkWatchFollowUp} from '../src/main/agent/work/WorkWatchFollowUp';
import {WorkWatchSupervision} from '../src/main/agent/work/WorkWatchSupervision';
import {LOCAL_USER_ID,DEFAULT_BOT_ID} from '../src/shared/bot-work';
const root=mkdtempSync(join(tmpdir(),'watch-supervisor-')),db=new AppDatabase(join(root,'test.db'));
const bots=new BotRegistry(db.connection);bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:"watch fixture",authorization:DESKTOP_USER_GRANTS});
const works=new WorkService(db.connection,{bots}),messages=new BotConversationRepository(db.connection);
const source=messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:'source',text:'每分钟持续观察，不要结束'});
const created=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},{operationId:'create',title:'持续观察',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'input',authorization:DESKTOP_USER_GRANTS,conversationId:source.conversationId,sourceMessageId:source.userMessageId,watchRule:{cronExpression:'* * * * *',timezone:'UTC'}});assert(created.ok);const work=created.work;
const feedback=new WorkConversationFeedback({db:db.connection,userId:LOCAL_USER_ID,works,isAuthority:()=>true,superviseWatch:true});
function receipt(id:string,target=work,summary=id){
 works.repo.insertBinding({bindingId:id,workId:target.workId,operationId:id,botId:DEFAULT_BOT_ID,taskId:id,durableStoreKey:'store',conversationId:'native',intentRevision:target.intentRevision,ownerEpoch:target.ownerEpoch,inputSnapshotId:target.inputSnapshotId,expertSnapshot:bots.activeSnapshot(DEFAULT_BOT_ID)!,delegatedScope:['workspace:read'],workspaceBinding:root,status:'completed',admittedAt:Date.now(),settledAt:Date.now(),settlementNote:id});
 works.repo.insertDeliverable({deliverableId:`result:${id}`,workId:target.workId,executionId:id,producerBotId:DEFAULT_BOT_ID,intentRevision:target.intentRevision,ownerEpoch:target.ownerEpoch,inputSnapshotId:target.inputSnapshotId,status:'proposed',summary,artifactRefs:[],evidenceRefs:[],uncoveredScope:[],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:Date.now()});
 db.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)').run(id,id,id,'{}',Date.now(),Date.now());
}
let calls=0,fail=false,deliveryBlocked=false,preferences="",replaceDuringReview:string|undefined;
let comparisonReviews=0;
let historicalStop=false;
const stopCondition='文件为 READY 时结束';
const reviewPreferences:string[]=[];
const reviewContexts:any[]=[];const reviewIds:string[]=[];
const deliveredBodies:Array<{bindingId:string;text:string}>=[];
const options={db:db.connection,works,isAuthority:()=>true,preferences:(taskId:string)=>{assert(works.repo.bindingForTask(taskId));return preferences;},wake:()=>{},deliver:(input:any)=>{deliveredBodies.push(input);return deliveryBlocked?false:feedback.deliverCompletion(input);},review:async(input:any)=>{calls++;if(input.context.title==='comparison watch')comparisonReviews++;reviewContexts.push(input.context);reviewIds.push(input.eventId);reviewPreferences.push(input.personalPreferences);assert(input.context.watchSupervision);await delay(20);if(replaceDuringReview!==undefined){preferences=replaceDuringReview;replaceDuringReview=undefined;}if(fail)throw Error('temporary provider unavailable');
 if(input.context.title==='rejected-continuation')return {decision:'continue' as const,outcome:'partial' as const,reply:'I promise to keep executing immediately without waiting.',missing:[{task:'invented task',requestExcerpt:'not in the original request'}]};
 if(historicalStop&&input.context.title==='历史停止证据隔离'){
  const old=input.context.previousVerifiedObservations.observations[0];assert(old?.text==='READY');
  return {decision:'deliver' as const,outcome:'completed' as const,reply:'旧轮曾经 READY',missing:[],
   stopAssessment:{status:'met' as const,conditionExcerpt:stopCondition,requestExcerpt:stopCondition,evidence:[{resultId:old.resultId,quote:'READY'}]}};
 }
 return {decision:'deliver' as const,outcome:'completed' as const,reply:'已对照目标核对：'+input.context.observationSummary,missing:[]};}};
let supervisor=new WorkWatchSupervision(options);
async function flush(){supervisor.wake();supervisor.wake();await delay(60);}
receipt('round1');feedback.drain();assert.equal((db.connection.prepare("SELECT count(*) n FROM bot_work_feedback WHERE json_extract(metadata_json,'$.executionId')='round1'").get() as {n:number}).n,0,'raw result waits for independent owner review');
await flush();assert.equal(calls,1);assert.equal(works.getWork(work.workId)!.lifecycle,'active');
assert.equal(reviewContexts[0].comparisonState,'no_baseline');assert.equal(reviewContexts[0].hostProvenUnchanged,false);
assert.deepEqual(reviewContexts[0].previousResults,[],'current result never supplies its own comparison baseline');
await flush();assert.equal(calls,1,'one review per round');
supervisor.close();supervisor=new WorkWatchSupervision(options);await flush();assert.equal(calls,1,'normal restart does not repeat delivered review');
receipt('round2');await flush();assert.equal(calls,2);assert.equal(works.getWork(work.workId)!.lifecycle,'active');
assert.equal(reviewContexts[1].comparisonState,'unverified');assert.equal(reviewContexts[1].hostProvenUnchanged,false);
assert.deepEqual(reviewContexts[1].previousResults.map((r:any)=>r.summary),['round1']);
receipt('error');fail=true;await flush();db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('error');await flush();
const failed=db.connection.prepare('SELECT state,error FROM work_watch_reviews WHERE binding_id=?').get('error') as any;assert.equal(failed.state,'delivered');assert.match(failed.error,/unavailable/);
assert.equal((db.connection.prepare("SELECT count(*) n FROM work_watch_reviews WHERE state='delivered'").get() as any).n,3);
fail=false;deliveryBlocked=true;receipt('delivery-retry');await flush();const countBeforeRetry=calls;
db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('delivery-retry');deliveryBlocked=false;await flush();assert.equal(calls,countBeforeRetry,'delivery retry reuses persisted model verdict');
// Changing artifact bytes after a delivery failure invalidates the cached verdict.
receipt('artifact-retry');const artifactBinding=works.repo.getBinding('artifact-retry')!,snapshotPath=join(root,'artifact-retry.txt');
writeFileSync(snapshotPath,'completed original');
works.transaction(()=>works.generatedArtifacts.record(artifactBinding,[{path:snapshotPath,snapshotPath,digest:createHash('sha256').update('completed original').digest('hex'),sizeBytes:Buffer.byteLength('completed original'),registeredAt:Date.now(),sourceEntryId:1}]));
db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE deliverable_id=?').run(JSON.stringify([snapshotPath]),'result:artifact-retry');
deliveryBlocked=true;await flush();const artifactCalls=calls;
writeFileSync(snapshotPath,'tampered placeholder TODO');deliveryBlocked=false;db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('artifact-retry');await flush();
assert.equal(calls,artifactCalls+1,'tampering between delivery retries requires a fresh verdict');
assert.equal(reviewContexts.at(-1).artifactEvidence[0].state,'changed');assert.notEqual(reviewIds.at(-1),reviewIds.at(-2),'native idempotent reviewer gets a new identity for changed artifact evidence');
// Current preference version invalidates cached decisions, without persisting its text.
preferences="old-private-marker";deliveryBlocked=true;receipt('preference-cache');await flush();
const cachedCalls=calls;
preferences="new-private-marker";deliveryBlocked=false;db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('preference-cache');await flush();
assert.equal(calls,cachedCalls+1,'changed preference reruns review rather than delivering cached old verdict');
assert.equal(reviewPreferences.at(-1),'new-private-marker');
assert(!String((db.connection.prepare('SELECT context_json FROM work_watch_reviews WHERE binding_id=?').get('preference-cache') as any).context_json).includes('private-marker'),'persistent context stores only preference fingerprint');
preferences="deleted-private-marker";replaceDuringReview="";receipt('preference-race');await flush();
assert.notEqual((db.connection.prepare('SELECT state FROM work_watch_reviews WHERE binding_id=?').get('preference-race') as any).state,'delivered','forget during inference discards obsolete reply');
await flush();assert.equal(reviewPreferences.at(-1),'');
assert.equal((db.connection.prepare('SELECT state FROM work_watch_reviews WHERE binding_id=?').get('preference-race') as any).state,'delivered','fresh empty preference review delivers normally');
const input=works.repo.executionInput.bind(works.repo);works.repo.executionInput=()=>{throw Error('missing execution context');};receipt('context-error');await flush();
db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('context-error');await flush();assert.equal((db.connection.prepare('SELECT state FROM work_watch_reviews WHERE binding_id=?').get('context-error') as {state:string}).state,'delivered','context preparation failure has bounded visible fallback');works.repo.executionInput=input;
receipt('team-owner-stopped');
const ownerStopped=works.repo.getBinding('team-owner-stopped')!;
works.repo.updateBinding({...ownerStopped,status:'stopped'});
works.repo.executionInput=b=>b.bindingId==='team-owner-stopped' ? JSON.stringify({teamAssignment:{role:'owner_summary',previousResults:[{summary:'成员已读取的真实部分结果',bindingId:'member-round'}]}}) : input(b);
await flush();
assert.equal(reviewContexts.at(-1).teamPartialResults.results[0].summary,'成员已读取的真实部分结果','expiry/stopped owner review retains already settled member evidence');
works.repo.executionInput=input;
// Continuous actionable work reuses the same continuation queue without read-only downgrading.
const continuousCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'continuous',title:'continuous',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'continuous',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});
assert(continuousCreated.ok);const continuous=continuousCreated.work;
receipt('continuous-step',continuous);works.repo.updateBinding({...works.repo.getBinding('continuous-step')!,delegatedScope:['workspace:read','workspace:write']});
const continuousFollow=new WorkWatchFollowUp(options),continuousBinding=works.repo.getBinding('continuous-step')!;
const continuousDecision={decision:'continue' as const,outcome:'partial' as const,reply:'继续完成剩余步骤',missing:[{task:'修复剩余组件并验证',requestExcerpt:'持续优化组件'}]};
const continueResult=works.transaction(()=>continuousFollow.enqueue(continuous,continuousBinding,continuousDecision,{userRequest:{messages:[{text:'持续优化组件'}]}}));
assert(continueResult.scheduled,JSON.stringify(continueResult));
const continuePlan=works.partialResults.plans(continuous.workId)[0];assert(continuePlan);assert(!works.partialResults.isReadOnlyPlan(continuePlan));
assert.equal(works.repo.listSubscriptions(continuous.workId)[0].nextWakeAt,undefined,'continuation does not fabricate a wait clock');
assert(works.transaction(()=>continuousFollow.enqueue(works.getWork(continuous.workId)!,continuousBinding,continuousDecision,{userRequest:{messages:[{text:'持续优化组件'}]}})).scheduled);
assert.equal(works.partialResults.plans(continuous.workId).length,1,'same action review cannot duplicate continuation');
works.repo.updateBinding({...continuousBinding,invalidatedAt:Date.now()});
const unknownCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'watch-unknown',title:'watch-unknown',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'watch-unknown',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});assert(unknownCreated.ok);
receipt('unknown-continuous',unknownCreated.work);const unknownBinding=works.repo.getBinding('unknown-continuous')!;
works.repo.insertAdmission({admissionId:'watch-unknown-effect',workId:unknownCreated.work.workId,bindingId:unknownBinding.bindingId,operationId:'watch-unknown-effect',actionKind:'write',state:'unknown',intentRevision:unknownBinding.intentRevision,ownerEpoch:unknownBinding.ownerEpoch,admittedAt:Date.now()});
assert(!works.transaction(()=>continuousFollow.enqueue(unknownCreated.work,unknownBinding,continuousDecision,{userRequest:{messages:[{text:'持续优化组件'}]}})).scheduled,'unknown effect cannot acquire writable continuation');
assert(works.transaction(()=>continuousFollow.enqueue(unknownCreated.work,unknownBinding,{...continuousDecision,missing:[{...continuousDecision.missing[0],readOnly:true}]},{userRequest:{messages:[{text:'持续优化组件'}]}})).scheduled,'independent enforced read can proceed');
assert(works.partialResults.isReadOnlyPlan(works.partialResults.plans(unknownCreated.work.workId)[0]));works.repo.updateBinding({...unknownBinding,invalidatedAt:Date.now()});
const rejectedCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'rejected-continuation',title:'rejected-continuation',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'rejected-continuation',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});assert(rejectedCreated.ok);
receipt('rejected-continuation',rejectedCreated.work);await flush();
const rejectedReply=deliveredBodies.findLast(body=>body.bindingId==='rejected-continuation');assert(rejectedReply);assert(!rejectedReply.text.includes('I promise'),'rejected continuation replaces arbitrary model promise');assert.match(rejectedReply.text,/没有安排继续执行/);

// A grounded wait is durable and its clock wake retains the original continuous authority.
const waitCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'continuous-wait',title:'continuous wait',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'continuous-wait',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});
assert(waitCreated.ok);const waitWork=waitCreated.work;receipt('wait-step',waitWork);
const waitBinding=works.repo.getBinding('wait-step')!,wakeAt=Date.now()+60000;
const waitRequest={userRequest:{messages:[{text:'持续处理，等一分钟后继续'}]}};
const waitDecision={decision:'deliver' as const,outcome:'partial' as const,reply:'现在需要等待',missing:[],waitPlan:{basis:'user_specified' as const,requestExcerpt:'等一分钟后继续',reason:'用户指定等待一分钟',nextWakeAt:wakeAt}};
const savedWait=works.transaction(()=>continuousFollow.arrangeWait(waitWork,waitBinding,waitDecision,waitRequest,[]));
assert(savedWait.scheduled,JSON.stringify(savedWait));
assert.equal(works.repo.listSubscriptions(waitWork.workId).find(s=>!s.stoppedAt)?.nextWakeAt,wakeAt);
assert(works.transaction(()=>continuousFollow.arrangeWait(works.getWork(waitWork.workId)!,waitBinding,waitDecision,waitRequest,[])).scheduled,'wait application is replay safe');
assert.equal(works.repo.listSubscriptions(waitWork.workId).filter(s=>!s.stoppedAt).length,1);
works.tick(wakeAt+1);const wakeEvent=works.repo.listInbox(waitWork.workId,['pending']).find(event=>event.eventType==='work.tick');assert(wakeEvent);
const currentWait=works.getWork(waitWork.workId)!;assert(!isReadOnlyScheduledFollowUp(wakeEvent,currentWait));
const resumed=works.dispatchExecution({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'resume-after-wait',workId:waitWork.workId,botId:DEFAULT_BOT_ID,taskId:'resume-after-wait',durableStoreKey:'resume-after-wait',conversationId:'native',workspaceBinding:root,inboxEventId:wakeEvent.eventId,
 versionGuard:{expectedStateVersion:currentWait.stateVersion,expectedIntentRevision:currentWait.intentRevision,expectedOwnerEpoch:currentWait.ownerEpoch}});
assert(resumed.ok,JSON.stringify(resumed));assert.equal(works.admitTaskAction('resume-after-wait',{operationId:'actual-write-after-wait',actionKind:'workspace:write'}),undefined,'timed resume actually admits write action under the original continuous goal');
assert(!isReadOnlyScheduledFollowUp(wakeEvent,currentWait));
assert(isReadOnlyScheduledFollowUp(wakeEvent,{...currentWait,watchRule:{...currentWait.watchRule!,executionMode:'observe'}}),'payload alone cannot upgrade observation authority');
works.repo.updateBinding({...waitBinding,invalidatedAt:Date.now()});
const eventCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'continuous-event-wait',title:'event wait',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'continuous-event',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});
assert(eventCreated.ok);receipt('event-wait-step',eventCreated.work);const eventBinding=works.repo.getBinding('event-wait-step')!;
// This test injects a simulated hook receiver; production hook has no receiver.
works.ingress.setReceiverAvailable('hook',true);
const eventDecision={...waitDecision,waitPlan:{basis:'observed_dependency' as const,requestExcerpt:'持续处理',reason:'等待外部构建下一次事件',eventSource:'hook',eventTarget:'fixture',evidence:{resultId:'build-state',quote:'pending'}}};
assert(!works.transaction(()=>continuousFollow.arrangeWait(eventCreated.work,eventBinding,eventDecision,waitRequest,[])).scheduled,'invented dependency evidence cannot arm a wait');
const eventWait=works.transaction(()=>continuousFollow.arrangeWait(eventCreated.work,eventBinding,eventDecision,waitRequest,[{resultId:'build-state',text:'pending',toolName:'read',source:'build',observedAt:Date.now()}]));
assert(eventWait.scheduled,JSON.stringify(eventWait));const eventSub=works.repo.listSubscriptions(eventCreated.work.workId).find(s=>!s.stoppedAt)!;assert.equal(eventSub.source,'hook');assert.equal(eventSub.nextWakeAt,undefined);
assert.equal(works.ingress.accept({source:'hook',sourceEventId:'old-wait-event',eventType:'build',occurredAt:eventSub.createdAt-1,payload:{target:'fixture'}},{subscriptionId:eventSub.subscriptionId,trust:'host'}).outcomes[0].reasonCode,'before-next-event-baseline');
assert.equal(works.ingress.accept({source:'hook',sourceEventId:'unknown-age-event',eventType:'build',payload:{target:'fixture'}},{subscriptionId:eventSub.subscriptionId,trust:'host',offline:true}).acknowledged,false,'unknown-age replay cannot masquerade as a new event');
works.repo.updateBinding({...eventBinding,invalidatedAt:Date.now()});
console.log('PASS continuous execute→grounded wait→actual writable admission, replay, event baseline, fabricated dependency refusal');
// A followUp is always a read, including continuous deliver + missing=[] with an unknown effect.
const readOnlyCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'followup-only',title:'followup-only',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'followup-only',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});assert(readOnlyCreated.ok);
receipt('followup-only-source',readOnlyCreated.work);const readSource=works.repo.getBinding('followup-only-source')!;
works.repo.insertAdmission({admissionId:'followup-only-unknown',workId:readSource.workId,bindingId:readSource.bindingId,operationId:'followup-only-unknown',actionKind:'write',state:'unknown',intentRevision:readSource.intentRevision,ownerEpoch:readSource.ownerEpoch,admittedAt:Date.now()});
const onlyRead={decision:'deliver' as const,outcome:'partial' as const,reply:'读取独立来源',missing:[],followUp:{task:'只读核对独立来源',requestExcerpt:'持续处理'}};
assert(works.transaction(()=>continuousFollow.enqueue(readOnlyCreated.work,readSource,onlyRead,waitRequest)).scheduled);
const readPlan=works.partialResults.plans(readSource.workId)[0];assert(works.partialResults.isReadOnlyPlan(readPlan));
const readCurrent=works.getWork(readSource.workId)!;
const readDispatch=works.dispatchExecution({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'followup-only-dispatch',workId:readSource.workId,botId:DEFAULT_BOT_ID,taskId:'followup-only-child',durableStoreKey:'followup-only-child',conversationId:'native',workspaceBinding:root,
 versionGuard:{expectedStateVersion:readCurrent.stateVersion,expectedIntentRevision:readCurrent.intentRevision,expectedOwnerEpoch:readCurrent.ownerEpoch}});assert(readDispatch.ok,JSON.stringify(readDispatch));
db.connection.prepare("INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id) VALUES (?,?,?,?,?,?,'dispatched',?,?)")
 .run('followup-only-request',readSource.workId,'followup-only-child',DEFAULT_BOT_ID,readCurrent.intentRevision,readCurrent.inputSnapshotId,Date.now(),readPlan.planId);
assert.equal(works.admitTaskAction('followup-only-child',{operationId:'followup-real-read',actionKind:'workspace:read'}),undefined);
assert.match(works.admitTaskAction('followup-only-child',{operationId:'followup-real-write',actionKind:'workspace:write'}) ?? '',/只读|只读取/,'real tool admission refuses writes on the followUp-only branch');
const beforeUnknownWait=JSON.stringify(works.repo.listSubscriptions(readSource.workId));
const refusedWait=works.transaction(()=>continuousFollow.arrangeWait(works.getWork(readSource.workId)!,readSource,waitDecision,waitRequest,[]));assert(!refusedWait.scheduled);assert.match(refusedWait.notice ?? '',/未核实/);
assert.equal(JSON.stringify(works.repo.listSubscriptions(readSource.workId)),beforeUnknownWait,'rejected wait preserves subscriptions');
// The unknown original also blocks a descendant from arming a new writable timer.
const readChild=works.repo.bindingForTask('followup-only-child')!;works.repo.updateBinding({...readChild,status:'completed',settledAt:Date.now()});
assert(!works.transaction(()=>continuousFollow.arrangeWait(works.getWork(readSource.workId)!,works.repo.getBinding(readChild.bindingId)!,waitDecision,waitRequest,[])).scheduled);
works.repo.updateBinding({...readSource,invalidatedAt:Date.now()});works.repo.updateBinding({...readChild,status:'completed',invalidatedAt:Date.now()});
// An unrelated binding's uncertainty must not block a genuinely independent wait.
const independentCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'independent-wait',title:'independent-wait',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'independent-wait',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous'}});assert(independentCreated.ok);
receipt('independent-wait-source',independentCreated.work);receipt('unrelated-wait-source',independentCreated.work);
const independentBinding=works.repo.getBinding('independent-wait-source')!,unrelatedBinding=works.repo.getBinding('unrelated-wait-source')!;
works.repo.insertAdmission({admissionId:'unrelated-wait-unknown',workId:independentBinding.workId,bindingId:unrelatedBinding.bindingId,operationId:'unrelated-wait-unknown',actionKind:'write',state:'unknown',intentRevision:unrelatedBinding.intentRevision,ownerEpoch:unrelatedBinding.ownerEpoch,admittedAt:Date.now()});
assert(works.transaction(()=>continuousFollow.arrangeWait(independentCreated.work,independentBinding,waitDecision,waitRequest,[])).scheduled,'unrelated unknown is not a Work-wide wait veto');
works.repo.updateBinding({...independentBinding,invalidatedAt:Date.now()});works.repo.updateBinding({...unrelatedBinding,invalidatedAt:Date.now()});
console.log('PASS continuous followUp-only real read admission/write denial; same-lineage unknown wait rejection and independent wait preservation');

// Persistent supplemental reads use the existing queue, never mutate the schedule.
const follow = new WorkWatchFollowUp(options);
const request = {userRequest:{messages:[{text:'持续观察文件内容，缺失时继续补查完整内容'}]}};
const partial = {decision:'deliver' as const,outcome:'partial' as const,reply:'首轮只得到部分内容',missing:[],
 followUp:{task:'读取同一文件剩余内容并核对完整状态',requestExcerpt:'补查完整内容'}};
const scheduleBefore=JSON.stringify(works.repo.listSubscriptions(work.workId));
receipt('incomplete');works.repo.updateBinding({...works.repo.getBinding('incomplete')!,delegatedScope:['workspace:read']});
const originalBinding=works.repo.getBinding('incomplete')!;
const arrange=(b=originalBinding,d=partial)=>works.transaction(()=>follow.enqueue(works.getWork(work.workId)!,b,d,request));
const arranged=arrange();assert(arranged.scheduled,JSON.stringify(arranged));
const plan=works.partialResults.plans(work.workId).find(p=>p.sourceBindingId==='incomplete')!;
assert(works.partialResults.isReadOnlyPlan(plan),'host enforces readonly even if source had write scope');
assert(arrange().scheduled);assert.equal(works.partialResults.plans(work.workId).filter(p=>p.sourceBindingId==='incomplete').length,1,'replay keeps exact one plan');
assert.equal(JSON.stringify(works.repo.listSubscriptions(work.workId)),scheduleBefore,'supplement does not rewrite cron');
function child(id:string,p:typeof plan){receipt(id);works.repo.updateBinding({...works.repo.getBinding(id)!,delegatedScope:['workspace:read']});
 db.connection.prepare("INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id) VALUES (?,?,?,?,?,?,'dispatched',?,?)")
 .run(id,work.workId,id,work.ownerBotId,work.intentRevision,work.inputSnapshotId,Date.now(),p.planId);
 return works.repo.getBinding(id)!;}
const second=child('supplement-one',plan);assert.equal(follow.availability(works.getWork(work.workId)!,second).attempts,1);assert(arrange(second).scheduled);
const secondPlan=works.partialResults.plans(work.workId).find(p=>p.sourceBindingId===second.bindingId)!;
const third=child('supplement-two',secondPlan);assert(!arrange(third).scheduled,'same observation chain cannot spin forever');
works.transaction(()=>follow.settle(second,{decision:'deliver',outcome:'completed',reply:'完整读取成功',missing:[]}));
assert(!works.partialResults.gaps(work.workId).some(g=>g.bindingId==='incomplete'),'verified supplement resolves source gap');
const teamLookup=works.teams.get.bind(works.teams);works.teams.get=()=>({ownerBotId:work.ownerBotId} as any);
const proof='READY';db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify({status:'completed',summary:proof,hasWriteConflicts:false,artifactRefs:[],readEvidence:[{toolCallId:'read',toolName:'read',kind:'file-content',target:'/fixture/source',at:Date.now(),partial:false,outputHash:createHash('sha256').update(proof).digest('hex'),outputText:proof}]}),second.bindingId);
assert.equal(watchGoalEvidence(db.connection,works,second)[0]?.text,proof,'team owner supplemental native evidence remains usable');
assert.equal(watchGoalEvidence(db.connection,works,originalBinding).length,0,'ordinary team execution without owner summary or host supplement is not promoted');
const scheduleCurrent=works.scheduledBindingCurrent.bind(works);works.scheduledBindingCurrent=()=>false;
assert.equal(watchGoalEvidence(db.connection,works,second).length,0,'old schedule supplemental evidence cannot close team');works.scheduledBindingCurrent=scheduleCurrent;
const validWork=works.getWork(work.workId)!;works.repo.updateWork({...validWork,ownerEpoch:validWork.ownerEpoch+1});
assert.equal(watchGoalEvidence(db.connection,works,second).length,0,'old owner supplementary evidence cannot close team');works.repo.updateWork(validWork);works.teams.get=teamLookup;
receipt('next-scheduled-round');const next=works.repo.getBinding('next-scheduled-round')!;
works.repo.updateBinding({...next,delegatedScope:['workspace:read']});assert.equal(follow.availability(works.getWork(work.workId)!,works.repo.getBinding(next.bindingId)!).attempts,0,'future schedule has its own follow-up allowance');
assert(!arrange(originalBinding,{...partial,followUp:{...partial.followUp,requestExcerpt:'invented new goal'}}).scheduled);
assert(!follow.availability({...works.getWork(work.workId)!,lifecycle:'paused'},originalBinding).allowed);
assert(!follow.availability({...works.getWork(work.workId)!,watchRule:{...work.watchRule!,endsAt:Date.now()-1}},originalBinding).allowed);
assert(!follow.availability(works.getWork(work.workId)!,{...originalBinding,status:'stopped'}).allowed);
assert(follow.availability(works.getWork(work.workId)!,{...originalBinding,delegatedScope:[]}).allowed, 'retired delegated scope does not block scheduled observations');
// Isolated, real SQLite/native-receipt tests for bounded historical comparison.
{
 const testDb=new AppDatabase(join(root,'comparison-evidence.db'));
 const registry=new BotRegistry(testDb.connection);registry.ensureDefaultBot(LOCAL_USER_ID);
 const service=new WorkService(testDb.connection,{bots:registry});
 const made=service.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},
  {operationId:'history',title:'history',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'history-input',
   authorization:DESKTOP_USER_GRANTS,watchRule:{cronExpression:'* * * * *',timezone:'UTC',stopConditionText:stopCondition}});
 assert(made.ok);const target=made.work,at=Date.now();
 const seed=(id:string,time:number)=>{
  service.repo.insertBinding({...works.repo.getBinding('round1')!,bindingId:id,operationId:id,taskId:id,workId:target.workId,
   intentRevision:target.intentRevision,inputSnapshotId:target.inputSnapshotId,ownerEpoch:target.ownerEpoch,
   admittedAt:time,settledAt:time+1,workspaceBinding:root});
  service.repo.insertDeliverable({...works.repo.getDeliverable('result:round1')!,deliverableId:`result:${id}`,executionId:id,
   workId:target.workId,intentRevision:target.intentRevision,inputSnapshotId:target.inputSnapshotId,ownerEpoch:target.ownerEpoch,
   summary:id,createdAt:time+1});
  return service.repo.getBinding(id)!;
 };
 const past=seed('history-past',at-100),current=seed('history-current',at);
 seed('history-future',at+100);
 const read=(name:string,text:string,partial=false)=>({toolCallId:name,toolName:'read',kind:'file-content',target:name,at,
  outputHash:createHash('sha256').update(text).digest('hex'),partial,outputText:text});
 const save=(id:string,reads:ReturnType<typeof read>[],status='completed')=>{
  testDb.connection.prepare('DELETE FROM work_native_inbox WHERE binding_id=?').run(id);
  testDb.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)')
   .run(id,id,id,JSON.stringify({status,summary:id,hasWriteConflicts:false,artifactRefs:[],readEvidence:reads}),at,at);
 };
 const actual=()=>watchGoalEvidence(testDb.connection,service,current);
 const previous=()=>previousWatchObservations(testDb.connection,service,current,actual());
 try {
  save(past.bindingId,[read('./source.txt','open: call\nopen: email\n')]);
  save(current.bindingId,[read(join(root,'source.txt'),'open: call\n')]);
  const values=previous();assert.equal(values.status,'complete');assert.equal(values.baselineResultId,'result:history-past');
  assert.equal(values.reportedAt,at-99,'report time is distinct from each native source read time');
  assert.equal(values.observations[0].source,join(root,'source.txt'),'relative/absolute aliases match after binding-local normalization');
  assert.equal(values.observations[0].text,'open: call\nopen: email\n');assert.equal(actual()[0].text,'open: call\n');
  testDb.connection.prepare('UPDATE work_execution_bindings SET workspace_binding=? WHERE binding_id=?').run(join(root,'different-workspace'),past.bindingId);
  assert.equal(previous().reason,'source_mismatch','identical relative names in different workspaces are different sources');
  testDb.connection.prepare('UPDATE work_execution_bindings SET workspace_binding=? WHERE binding_id=?').run(root,past.bindingId);
  save(past.bindingId,[read('different.txt','old')]);assert.equal(previous().reason,'source_mismatch');
  save(past.bindingId,[read('./source.txt','old',true)]);assert.equal(previous().reason,'history_unavailable');
  save(past.bindingId,[read('./source.txt','old'),read(join(root,'source.txt'),'failed',true)]);
  assert.equal(previous().reason,'history_unavailable','latest failed alias cannot fall back to earlier complete read');
  save(past.bindingId,[read('source.txt','old')],'failed');assert.equal(previous().reason,'history_unavailable');
  save(past.bindingId,[read('source.txt','old')]);
  testDb.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)')
   .run('latest-failure',past.bindingId,'latest-failure',JSON.stringify({status:'failed',summary:'failed',hasWriteConflicts:false,artifactRefs:[]}),at+1,at+1);
  assert.equal(previous().reason,'history_unavailable','latest failed receipt never falls back to an earlier success');
  save(past.bindingId,[read('source.txt','old')]);
  save(current.bindingId,[read('source.txt','new'),read('second.txt','new')]);
  assert.equal(previous().status,'unavailable');assert.deepEqual(previous().observations,[],'missing a current source is explicit, not silently complete');
  const large='x'.repeat(WATCH_PREVIOUS_EVIDENCE_BUDGET/2);
  save(past.bindingId,[read('source.txt',large),read('second.txt',large)]);
  assert.equal(previous().status,'budget_exceeded');assert.equal(previous().reason,'text_budget');
  assert.deepEqual(previous().observations,[],'over-budget historical text is omitted, never truncated into apparent full evidence');
  const unicode='汉🙂'.repeat(Math.ceil(WATCH_PREVIOUS_EVIDENCE_BUDGET/Buffer.byteLength('汉🙂','utf8')));
  assert(unicode.length<WATCH_PREVIOUS_EVIDENCE_BUDGET,'Unicode fixture fits a character-count budget');
  save(past.bindingId,[read('source.txt',unicode)]);save(current.bindingId,[read('source.txt','new')]);
  assert.equal(previous().reason,'text_budget','budget uses UTF-8 bytes including Chinese/emoji, not UTF-16 characters');
  save(current.bindingId,Array.from({length:WATCH_PREVIOUS_SOURCE_LIMIT+1},(_,i)=>read(`source-${i}.txt`,'new')));
  assert.equal(previous().reason,'source_limit');assert.deepEqual(previous().observations,[]);
  save(past.bindingId,[read('source.txt','READY')]);save(current.bindingId,[read('source.txt','WAITING')]);
  const raw=actual(),before=JSON.stringify(raw),old=previous().observations[0];assert(old);
  assert.equal(JSON.stringify(raw),before,'historical evidence never mutates or merges into current proof');
  assert(!watchGoalMet(target,current,{decision:'deliver',outcome:'completed',reply:'old READY',missing:[],
   stopAssessment:{status:'met',conditionExcerpt:stopCondition,requestExcerpt:stopCondition,evidence:[{resultId:old.resultId,quote:'READY'}]}},
   {userRequest:{messages:[{text:stopCondition}]}},raw),'previous READY cannot satisfy current WAITING stop condition');
  testDb.connection.prepare('DELETE FROM work_deliverables WHERE execution_id=?').run(past.bindingId);
  assert.equal(previous().reason,'no_history','current and future outputs do not supply historical evidence');
 } finally {testDb.close();}
}
// Production supervision must not confuse notification policy with comparison
// proof. Keep the first silent baseline distinct from a later unchanged round.
const comparisonCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'comparison-watch',title:'comparison watch',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'comparison-input',
 authorization:DESKTOP_USER_GRANTS,conversationId:source.conversationId,sourceMessageId:source.userMessageId,
 watchRule:{cronExpression:'* * * * *',timezone:'UTC',notificationMode:'changes_only',notifyInitial:false}});
assert(comparisonCreated.ok);const comparisonWork=comparisonCreated.work;
function observed(id:string,value:string){
 const summary=JSON.stringify({protocol:'watch-observation-v1',status:'observed',facts:[{source:'/fixture/comparison',key:'file_content',value}],summary:'本轮读取：'+value});
 receipt(id,comparisonWork,summary);
 db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify({status:'completed',summary,hasWriteConflicts:false,artifactRefs:[],
  readEvidence:[{toolCallId:id,toolName:'read',kind:'file-content',target:'/fixture/comparison',partial:false,at:Date.now(),
   outputHash:createHash('sha256').update(value).digest('hex'),outputText:value}]}),id);
}
const reviewState=(id:string)=>(db.connection.prepare('SELECT state FROM work_watch_reviews WHERE binding_id=?').get(id) as {state:string}).state;
// Other works may still have queued rounds; count/read only this work's reviews.
const comparisonContexts=()=>reviewContexts.filter((context:any)=>context.title==='comparison watch');
observed('comparison-first','A');await flush();
assert.equal(comparisonReviews,1);
assert.equal(comparisonContexts().at(-1).comparisonState,'no_baseline');assert.equal(comparisonContexts().at(-1).hostProvenUnchanged,false);
assert.equal(reviewState('comparison-first'),'silent');
// Issue #27 §6: a host-proven unchanged changes_only round must not spend another
// result review. Silence comes from host facts and is persisted as provenance,
// not from "the user received nothing".
observed('comparison-same','A');await flush();
assert.equal(comparisonReviews,1,'proven-unchanged round makes zero extra review calls');
const fastRow=db.connection.prepare(`SELECT state,decision_json,reviewed_at,attempts,
  json_extract(context_json,'$.reason') reason,json_extract(context_json,'$.comparisonState') comparisonState
  FROM work_watch_reviews WHERE binding_id=?`).get('comparison-same') as {state:string;decision_json:string|null;reviewed_at:number|null;attempts:number;reason:string;comparisonState:string};
assert.equal(fastRow.state,'silent');assert.equal(fastRow.decision_json,null);assert.equal(fastRow.attempts,0);
assert.equal(fastRow.reason,'host_proven_unchanged');assert.equal(fastRow.comparisonState,'unchanged');assert(fastRow.reviewed_at!>0);
assert.equal((db.connection.prepare("SELECT count(*) n FROM bot_work_feedback WHERE json_extract(metadata_json,'$.executionId')=? AND json_extract(metadata_json,'$.kind')='result'").get('comparison-same') as {n:number}).n,0,'unchanged fast path never delivers to the user');
// A continuous file-update responsibility may be silent only after a complete reviewed result.
const continuousComparisonCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{operationId:'continuous-comparison',title:'continuous file updates',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'continuous-comparison',authorization:DESKTOP_USER_GRANTS,watchRule:{executionMode:'continuous',cronExpression:'* * * * *',timezone:'UTC',notificationMode:'changes_only',notifyInitial:false}});assert(continuousComparisonCreated.ok);
const continuousComparison=continuousComparisonCreated.work,briefPath=join(root,'continuous-brief.md');writeFileSync(briefPath,'Verified brief from unchanged source');
function continuousObserved(id:string){
 const value='stable input',summary=JSON.stringify({protocol:'watch-observation-v1',status:'observed',facts:[{source:'/fixture/continuous-source',key:'file_content',value}],summary:'已核对来源和简报，无变化'});
 receipt(id,continuousComparison,summary);const b=works.repo.getBinding(id)!;
 works.transaction(()=>works.generatedArtifacts.record(b,[{path:briefPath,snapshotPath:briefPath,digest:createHash('sha256').update('Verified brief from unchanged source').digest('hex'),sizeBytes:Buffer.byteLength('Verified brief from unchanged source'),registeredAt:Date.now(),sourceEntryId:1}]));
 db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE deliverable_id=?').run(JSON.stringify([briefPath]),`result:${id}`);
 db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify({status:'completed',summary,hasWriteConflicts:false,artifactRefs:[briefPath],readEvidence:[{toolCallId:id,toolName:'read',kind:'file-content',target:'/fixture/continuous-source',partial:false,at:Date.now(),outputHash:createHash('sha256').update(value).digest('hex'),outputText:value}]}),id);
}
continuousObserved('continuous-baseline');await flush();
const continuousReviewCount=reviewContexts.filter(context=>context.title==='continuous file updates').length;assert.equal(continuousReviewCount,1);
continuousObserved('continuous-unchanged');await flush();
assert.equal(reviewContexts.filter(context=>context.title==='continuous file updates').length,continuousReviewCount,'complete unchanged continuous round has zero extra reviewer turns');
assert.equal(reviewState('continuous-unchanged'),'silent');assert(!deliveredBodies.some(body=>body.bindingId==='continuous-unchanged'),'complete unchanged continuous round sends no notification');
works.transaction(()=>works.partialResults.record(works.repo.getBinding('continuous-unchanged')!,[{itemId:'still-actionable',task:'补齐简报遗漏的结论',required:true,dependencies:[],criterionIds:[],nativeStatus:'pending',outcome:'not_started',artifactRefs:[],writeConflicts:[],summary:'已有真实缺项，不能用来源无变化跳过'}]));
continuousObserved('continuous-gap');await flush();
assert.equal(reviewContexts.filter(context=>context.title==='continuous file updates').length,continuousReviewCount+1,'unchanged input with an actionable gap must still be reviewed');
assert.notEqual((db.connection.prepare("SELECT json_extract(context_json,'$.reason') reason FROM work_watch_reviews WHERE binding_id=?").get('continuous-gap') as {reason:string|null}).reason,'host_proven_unchanged');
console.log('PASS continuous changes_only: complete reviewed unchanged artifact is silent without reviewer; actionable gap still reviews');
observed('comparison-changed','B');await flush();
assert.equal(comparisonReviews,2,'changed evidence still goes through the existing review path');
assert.equal(comparisonContexts().at(-1).comparisonState,'changed');assert.equal(comparisonContexts().at(-1).hostProvenUnchanged,false);
assert.equal(reviewState('comparison-changed'),'delivered');
const currentComparison=works.getWork(comparisonWork.workId)!;
works.repo.updateWork({...currentComparison,watchRule:{...currentComparison.watchRule!,notificationMode:'every_check'}});
observed('comparison-every-check','B');await flush();
assert.equal(comparisonContexts().at(-1).comparisonState,'unchanged');assert.equal(comparisonContexts().at(-1).hostProvenUnchanged,true);
assert.equal(comparisonContexts().at(-1).comparisonBaseline.deliverableId,'result:comparison-changed');
assert.equal(comparisonContexts().at(-1).previousVerifiedObservations.status,'complete');
assert.equal(comparisonContexts().at(-1).previousVerifiedObservations.observations[0].text,'B');
assert.equal(reviewState('comparison-every-check'),'delivered','equal evidence does not override every-check notification policy');
// A cached verdict must not outlive the exact historical native evidence used
// for its comparison, even when all model-written report summaries stay equal.
deliveryBlocked=true;observed('comparison-history-cache','B');await flush();
const cacheReviews=()=>reviewContexts.filter(c=>c.verifiedObservations.some((r:any)=>r.resultId==='comparison-history-cache:comparison-history-cache'));
const beforeHistoryChange=cacheReviews().length;assert.equal(beforeHistoryChange,1);
const historicalPayload=JSON.parse((db.connection.prepare('SELECT payload_json FROM work_native_inbox WHERE binding_id=?').get('comparison-every-check') as {payload_json:string}).payload_json);
historicalPayload.readEvidence[0].outputText='corrected historical read';
historicalPayload.readEvidence[0].outputHash=createHash('sha256').update('corrected historical read').digest('hex');
db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify(historicalPayload),'comparison-every-check');
deliveryBlocked=false;db.connection.prepare('UPDATE work_watch_reviews SET retry_at=0 WHERE binding_id=?').run('comparison-history-cache');await flush();
assert.equal(cacheReviews().length,beforeHistoryChange+1,'changed native historical evidence invalidates cached review');
assert.equal(cacheReviews().at(-1).previousVerifiedObservations.observations[0].text,'corrected historical read');
// Even an explicitly supplied previous READY read cannot prove a current
// WAITING round's stop condition through the actual supervision/settlement path.
const stopSource=messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:'historical-stop-source',text:`持续观察，${stopCondition}。`});
const stopCreated=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'historical-stop',title:'历史停止证据隔离',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'historical-stop-input',
 authorization:DESKTOP_USER_GRANTS,conversationId:stopSource.conversationId,sourceMessageId:stopSource.userMessageId,
 watchRule:{cronExpression:'* * * * *',timezone:'UTC',stopConditionText:stopCondition}});
assert(stopCreated.ok);const stopWork=stopCreated.work;
const stopReceipt=(id:string,text:string)=>{
 receipt(id,stopWork,text);
 db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify({status:'completed',summary:text,
  hasWriteConflicts:false,artifactRefs:[],readEvidence:[{toolCallId:'read',toolName:'read',kind:'file-content',target:'/fixture/status',
   partial:false,at:Date.now(),outputText:text,outputHash:createHash('sha256').update(text).digest('hex')}]}),id);
};
stopReceipt('historical-stop-before','READY');await flush();
stopReceipt('historical-stop-now','WAITING');historicalStop=true;await flush();historicalStop=false;
const stopContext=[...reviewContexts].reverse().find(c=>c.title==='历史停止证据隔离');
assert.equal(stopContext.previousVerifiedObservations.observations[0].text,'READY');
assert.deepEqual(stopContext.verifiedObservations.map((r:any)=>[r.resultId,r.text]),[['historical-stop-now:read','WAITING']]);
assert.equal(works.getWork(stopWork.workId)!.lifecycle,'active','old READY proof is rejected, not allowed to stop current WAITING');
assert.equal(reviewState('historical-stop-now'),'delivered');
const latest=works.getWork(work.workId)!;works.repo.updateWork({...latest,lifecycle:'closed',closureConclusion:'cancelled',updatedAt:Date.now()});
feedback.drain();assert((db.connection.prepare("SELECT count(*) n FROM bot_work_feedback WHERE json_extract(metadata_json,'$.kind')='closure'").get() as {n:number}).n>0,'watch closure feedback is not suppressed by reviewed round');
supervisor.close();feedback.close();db.close();console.log('PASS: multi-round owner review, nonblocking queue, no duplicate raw results, restart receipts, visible model failure fallback; standing work remains active');
