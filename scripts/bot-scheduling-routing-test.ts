// Issue #27 §5/§6 foreground scheduling contract:
//  (b) one read-only "我的安排" projection merges reminders + once Works +
//      watch/event Works without inventing a second scheduler;
//  (c) unique title named in the actual user message resolves the target while
//      explicit IDs / replied message / selected card keep priority and
//      ambiguity still refuses;
//  (d) requestedOutcome=ongoing may act now and then wait (nextWakeAt), but still
//      rejects goals with no future action and one_time + infinite cron.
import assert from 'node:assert/strict';
import {resolveWorkTarget} from '../src/main/agent/work/BotWorkTargetSelection';
import {isReadOnlyScheduledFollowUp} from '../src/main/agent/work/WorkScheduledFollowUp';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import type {ToolExecutionApi,ToolRegistration} from '@earendil-works/pi-durable';
import {Type} from 'typebox';
import {Value} from 'typebox/value';
import {z} from 'zod';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {CronService,type CronAgent} from '../src/main/cron/CronService';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {BotConversationRepository} from '../src/main/agent/work/BotConversationRepository';
import {botForegroundTools,BOT_FOREGROUND_TOOLS} from '../src/main/agent/work/BotForegroundTools';
import {WorkService,DESKTOP_USER_GRANTS} from '../src/main/agent/work/WorkService';
import {DEFAULT_BOT_ID,LOCAL_USER_ID,type ExpectedVersionGuard,type WorkActor,
 type WorkControlResult,type WorkDto} from '../src/shared/bot-work';

const root=mkdtempSync(join(tmpdir(),'scheduling-routing-'));
const db=new AppDatabase(join(root,'routing.db'));
const bots=new BotRegistry(db.connection);
bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:'routing fixture',authorization:DESKTOP_USER_GRANTS});
const works=new WorkService(db.connection,{bots});
const messages=new BotConversationRepository(db.connection);
const cron=new CronService(db,{prompt:async()=>{throw Error('schedule_overview must never run a model');},
 waitForSubmission:async()=>{throw Error('no submissions');},loadTaskHistory:async()=>({messages:[]}),isTaskBusy:()=>false,
 getAppSettings:()=>({}),resolveAvailableModelId:async()=>undefined,listSkills:()=>[],listConnectors:()=>[]} satisfies CronAgent);
const scheduled:string[]=[];
const first=messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:'routing-first',text:'我的安排'});
const tools:ToolRegistration[]=botForegroundTools({db:db.connection,userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,
 conversationId:first.conversationId,bots,messages,works,isAuthority:()=>true,schedule:(work)=>scheduled.push(work.workId),
 wake:()=>{},memorySearch:()=>[],reminders:()=>cron});
const schemas=new Map(tools.map(tool=>[tool.name,Type.Unsafe(JSON.parse(JSON.stringify(tool.parameters)))]));
// The wire schema requires the frozen source selection for create/amend; these
// fixtures add no extra sources and rely on the current request message.
const withSources=(name:string,args:unknown)=>name==='work_create'||name==='work_amend'
 ? {sourceMessageIds:[],...(args as Record<string,unknown>)} : args;
const accepts=(name:string,args:unknown)=>Value.Check(schemas.get(name)!,withSources(name,args));
let nextTask=0,serial=0;
const invoke=async(name:string,args:unknown,requestId=first.requestId):Promise<any>=>{
 const api={callId:`call-${++nextTask}`,taskId:`tool-${nextTask}`,memo:async()=>requestId} as unknown as ToolExecutionApi;
 const result=await tools.find(tool=>tool.name===name)!.execute(withSources(name,args) as never,api,BACKGROUND_CONTEXT);
 const output=result.output?.find(block=>block.type==='text');assert(output?.type==='text');return JSON.parse(output.text);
};
const validInvoke=async(name:string,args:unknown,requestId=first.requestId)=>{
 assert(accepts(name,args),`${name} must accept ${JSON.stringify(args).slice(0,160)}`);
 return invoke(name,args,requestId);
};
const user:WorkActor={kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
const unwrap=(value:unknown)=>{const result=value as WorkControlResult;assert(result.ok,JSON.stringify(result));return result.work;};
const guardOf=(work:WorkDto):ExpectedVersionGuard=>({expectedStateVersion:work.stateVersion,
 expectedIntentRevision:work.intentRevision,expectedOwnerEpoch:work.ownerEpoch});
const requestFor=(text:string,selectedWorkId?:string,referenceMessageId?:string)=>messages.accept(LOCAL_USER_ID,{
 botId:DEFAULT_BOT_ID,conversationId:first.conversationId,requestId:`routing-request-${++serial}`,text,selectedWorkId,referenceMessageId});
const queryGuard=async(workId:string,requestId:string)=>{
 const result=z.array(z.object({workId:z.string(),versionGuard:z.object({expectedStateVersion:z.number(),
  expectedIntentRevision:z.number(),expectedOwnerEpoch:z.number()})})).parse(await validInvoke('work_query_status',{workId},requestId));
 assert.equal(result.length,1);assert.equal(result[0].workId,workId);return result[0].versionGuard;
};
const reviewState=(workId:string)=>works.getWork(workId)!.lifecycle;
const restore=(workId:string)=>unwrap(works.resumeWork(user,{operationId:`restore-${++serial}`,workId,
 versionGuard:guardOf(works.getWork(workId)!)}));
const assertRejectedTarget=async(requestId:string,workId:string)=>{
 const before=works.getWork(workId);
 await assert.rejects(()=>validInvoke('work_pause',{workId,versionGuard:guardOf(works.getWork(workId)!)},requestId),/请明确/);
 assert.deepEqual(works.getWork(workId),before,'ambiguous/non-selected target must not change');
};
const tableCounts=()=>{
 const names=(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map(row=>row.name);
 return Object.fromEntries(names.map(name=>[name,(db.connection.prepare(`SELECT count(*) n FROM "${name}"`).get() as {n:number}).n]));
};
const now=Date.now();
try {
 // ---------------------------------------------------------------- (b) 我的安排
 assert.equal(BOT_FOREGROUND_TOOLS.has('schedule_overview'),true);
 assert.deepEqual(new Set(tools.map(tool=>tool.name)),BOT_FOREGROUND_TOOLS);
 assert.equal(accepts('schedule_overview',{}),true);
 assert.equal(accepts('schedule_overview',{query:'x'}),false,'the overview is a fixed read-only query');
 cron.upsert({id:'reminder-plan',name:'看 PR 结果提醒',prompt:'该看今天的 PR 结果了',scheduleType:'cron',
  scheduleExpr:'0 20 * * *',timezone:'Asia/Shanghai',enabled:true,createdAt:now,updatedAt:now,restartPolicy:'resume',
  reminder:{state:'scheduled',kind:'bot-reminder',userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,conversationId:first.conversationId}});
 const onceCreated=works.createWork(user,{operationId:'routing-once-work',title:'明早查资料并回报结果',mode:'once',
  inputSnapshotId:'input-routing-once',authorization:DESKTOP_USER_GRANTS,conversationId:first.conversationId,
  sourceMessageId:first.userMessageId,deadlineAt:now+86_400_000});
 assert(onceCreated.ok,JSON.stringify(onceCreated));const onceWork=onceCreated.work;
 const watchCreated=works.createWork(user,{operationId:'routing-watch-work',title:'持续观察仓库变化',mode:'watch',
  inputSnapshotId:'input-routing-watch',authorization:DESKTOP_USER_GRANTS,conversationId:first.conversationId,
  sourceMessageId:first.userMessageId,watchRule:{cronExpression:'0 9 * * *',timezone:'Asia/Shanghai',
   notificationMode:'changes_only',scheduleBasis:'user_specified'}});
 assert(watchCreated.ok,JSON.stringify(watchCreated));const watchWork=watchCreated.work;
 const eventConfigured=works.phase4Control(user,{kind:'configure-subscription',operationId:'routing-hook-subscription',
  workId:watchWork.workId,source:'hook',targetKey:'pr:42',catchUpPolicy:'latest',versionGuard:guardOf(works.getWork(watchWork.workId)!)});
 assert(eventConfigured.ok,JSON.stringify(eventConfigured));
 const hookSubscription=works.repo.listSubscriptions(watchWork.workId).find(item=>item.source==='hook')!;
 works.ingress.setCursor(hookSubscription.subscriptionId,'hook','pr:42',{highestAcceptedVersion:'41',highestConsumedVersion:'40'});
 // Read-only is proved by unchanged row counts and an unchanged write counter.
 const overviewRequest=requestFor('明天有哪些安排');
 const before=tableCounts();
 const changesBefore=(db.connection.prepare('SELECT total_changes() n').get() as {n:number}).n;
 const overview=await validInvoke('schedule_overview',{},overviewRequest.requestId);
 const changesAfter=(db.connection.prepare('SELECT total_changes() n').get() as {n:number}).n;
 assert.deepEqual(tableCounts(),before,'schedule_overview must not write any table');
 assert.equal(changesAfter,changesBefore,'schedule_overview performs zero writes');
 assert.equal(scheduled.length,0,'schedule_overview never dispatches or schedules work');
 assert.equal(overview.readOnly,true);assert.equal(overview.hostMustBeRunning,true);
 assert.match(overview.hostBoundary,/宿主/);
 const reminderItem=overview.items.find((item:any)=>item.kind==='reminder'&&item.reminderId==='reminder-plan');
 assert(reminderItem,'reminder projection is included');
 assert.equal('workId' in reminderItem,false,'a reminder is never presented as a Work');
 assert.equal(reminderItem.timing.kind,'cron');assert.equal(reminderItem.timing.expression,'0 20 * * *');
 assert.equal(reminderItem.timing.nextAt,cron.list().find(job=>job.id==='reminder-plan')!.nextRunAt);
 assert.equal(reminderItem.enabled,true);assert.equal(reminderItem.resultReturnsTo.conversationId,first.conversationId);
 assert.match(reminderItem.whatWillHappen,/不调用模型/);assert.match(reminderItem.deliveryBoundary,/恢复后合并补发/);
 const onceItem=overview.items.find((item:any)=>item.kind==='work'&&item.workId===onceWork.workId);
 assert(onceItem,'once Work projection is included');
 assert.equal(onceItem.workMode,'once');assert.equal('reminderId' in onceItem,false,'a Work is never presented as a reminder');
 assert.equal(onceItem.timing.kind,'deadline');assert.equal(onceItem.timing.nextAt,now+86_400_000);
 assert.equal(onceItem.resultReturnsTo.currentConversation,true);assert.equal(onceItem.hostMustBeRunning,true);
 assert.match(onceItem.whatWillHappen,/真实执行/);
 const watchItem=overview.items.find((item:any)=>item.kind==='work'&&item.workId===watchWork.workId);
 assert(watchItem,'watch Work projection is included');
 assert.equal(watchItem.workMode,'watch');assert.equal(watchItem.notificationMode,'changes_only');
 assert.equal(watchItem.timing.kind,'cron');assert.equal(watchItem.timing.expression,'0 9 * * *');
 assert.equal(watchItem.timing.timezone,'Asia/Shanghai');
 const cronSubscription=works.repo.listSubscriptions(watchWork.workId).find(item=>item.source==='cron')!;
 assert.equal(watchItem.timing.nextAt,cronSubscription.nextWakeAt);
 const eventItem=watchItem.eventSubscriptions.find((item:any)=>item.source==='hook');
 assert(eventItem,'event subscription projection is included');
 assert.equal(eventItem.targetKey,'pr:42');assert.equal(eventItem.registeredSource,true);assert.equal(eventItem.canQueryHistory,false);
 const hookCursor=eventItem.cursors.find((item:any)=>item.targetKey==='pr:42');
 assert.equal(hookCursor.highestConsumedVersion,'40');assert.match(eventItem.trigger,/pr:42/);
 assert.match(watchItem.whatWillHappen,/仅在本轮来源证据变化时通知/);
 assert.equal(overview.counts.reminders,1);assert.equal(overview.counts.watchWorks,1);
 assert.equal(overview.counts.onceWorks,1);assert.equal(overview.counts.eventSubscriptions,1);
 assert.equal(overview.truncated,false);
 console.log('PASS schedule_overview: reminder + once Work + watch/event Work merged with exact times/conditions and status, zero writes');

 // ------------------------------------------- (c) interrupt/redirect target resolution
 // Live pause regression: a full title sharing 验收持续 with another Work is
 // still one target. Retention instructions must not change that identity.
 const pauseFacts={explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],
  openWorks:[{workId:'work-screen',title:'验收持续首屏优化'},{workId:'work-summary',title:'验收持续简报'},
   ...['验收混合历史检索','验收定时读取','验收PR合并benchmark','验收分析A','验收历史读取修复B']
    .map((title,index)=>({workId:`work-live-other-${index}`,title}))],
  requestedWorkId:'work-screen'};
 const livePause='暂停验收持续首屏优化，保留全部测试测量和成果，不要取消或修改别的任务。';
 assert.deepEqual(resolveWorkTarget({...pauseFacts,userText:livePause}),{ok:true,workId:'work-screen',basis:'unique_title'});
 assert.equal(resolveWorkTarget({...pauseFacts,userText:livePause,requestedWorkId:'work-summary'}).ok,false,'model workId cannot pick the sibling');
 assert.equal(resolveWorkTarget({...pauseFacts,userText:'暂停验收持续'}).ok,false,'shared fragment remains ambiguous');
 for (const userText of ['暂停验收持续首屏优化和验收持续简报','暂停验收持续首屏优化，也暂停持续简报'])
  assert.equal(resolveWorkTarget({...pauseFacts,userText}).ok,false,'a separate full or partial target remains ambiguous');
 assert.equal(resolveWorkTarget({...pauseFacts,userText:'暂停验收持续首屏优化，不要动验收持续简报'}).ok,true,'complete exclusion must not exclude its sibling via shared words');
 assert.equal(resolveWorkTarget({...pauseFacts,userText:'暂停验收持续首屏优化，不要动持续首屏'}).ok,false,'explicit substantive exclusion still wins');
 assert.equal(resolveWorkTarget({...pauseFacts,userText:livePause,openWorksComplete:false}).ok,false,'incomplete catalog cannot establish uniqueness');
 assert.equal(resolveWorkTarget({...pauseFacts,userText:livePause,openWorks:[...pauseFacts.openWorks,{workId:'work-duplicate',title:'验收持续首屏优化'}]}).ok,false,'duplicate full titles remain ambiguous');
 const alpha=unwrap(works.createWork(user,{operationId:'routing-title-alpha',title:'历史读取修复'}));
 const beta=unwrap(works.createWork(user,{operationId:'routing-title-beta',title:'长期记忆迁移'}));
 const longWork=unwrap(works.createWork(user,{operationId:'routing-title-long',title:'持续优化首屏打开速度的完整性能回归检查'}));
 const shortWork=unwrap(works.createWork(user,{operationId:'routing-title-short',title:'周报'}));
 const duplicateA=unwrap(works.createWork(user,{operationId:'routing-title-duplicate-a',title:'重名事项复核'}));
 const duplicateB=unwrap(works.createWork(user,{operationId:'routing-title-duplicate-b',title:'重名事项复核'}));
 // Unique title literally named in the actual user message resolves without a card.
 const wrongAction=requestFor('这轮只修历史读取修复，不要动别的');
 const wrongActionGuard=await queryGuard(alpha.workId,wrongAction.requestId);
 await assert.rejects(()=>invoke('work_pause',{workId:alpha.workId,versionGuard:wrongActionGuard},wrongAction.requestId),/请明确/);
 assert.equal(reviewState(alpha.workId),'active','a repair request must not authorize pause');
 const named=requestFor('暂停历史读取修复，不要动别的');
 const namedGuard=await queryGuard(alpha.workId,named.requestId);
 assert.equal(unwrap(await invoke('work_pause',{workId:alpha.workId,versionGuard:namedGuard},named.requestId)).lifecycle,'paused');
 assert.equal(reviewState(beta.workId),'active','an unrelated Work is untouched');
 const resumeByTitle=requestFor('恢复历史读取修复');
 assert.equal(unwrap(await invoke('work_resume',{workId:alpha.workId,
  versionGuard:await queryGuard(alpha.workId,resumeByTitle.requestId)},resumeByTitle.requestId)).lifecycle,'active');
 // A real persisted task fragment, not the complete generated title, redirects exactly one Work.
 const fragment=requestFor('这轮只修历史读取');
 const betaBefore=works.getWork(beta.workId);
 const amendedHistory=unwrap(await invoke('work_amend',{workId:alpha.workId,goalDescription:'本轮只修历史读取',
  versionGuard:await queryGuard(alpha.workId,fragment.requestId)},fragment.requestId));
 assert.equal(amendedHistory.goalDescription,'本轮只修历史读取');
 assert.deepEqual(works.getWork(beta.workId),betaBefore,'memory task is untouched by history-only redirect');
 await assertRejectedTarget(fragment.requestId,beta.workId);
 // Explicit negative clauses exclude targets; they are never control authorization.
 for (const exclusion of ['不动长期记忆','别动长期记忆','不要改长期记忆']) {
  const narrowed=requestFor(`这轮只修历史读取，${exclusion}`);
  const beforeMemory=works.getWork(beta.workId);
  assert.equal(unwrap(await invoke('work_amend',{workId:alpha.workId,goalDescription:'只修历史读取，不改长期记忆',
   versionGuard:await queryGuard(alpha.workId,narrowed.requestId)},narrowed.requestId)).goalDescription,'只修历史读取，不改长期记忆');
  assert.deepEqual(works.getWork(beta.workId),beforeMemory);
  await assertRejectedTarget(narrowed.requestId,beta.workId);
 }
 for (const denied of [requestFor('不要改历史读取'),requestFor('不要改历史读取',alpha.workId),
   requestFor(`不要动 ${alpha.workId}`),requestFor('历史读取修复这轮先不动',undefined,named.assistantMessageId)]) {
  messages.linkWork(messages.receipt(LOCAL_USER_ID,DEFAULT_BOT_ID,denied.requestId)!,alpha.workId);
  await assertRejectedTarget(denied.requestId,alpha.workId);
 }
 const soleTargetFacts={explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[alpha.workId],selectedWorkId:alpha.workId,
  openWorks:[{workId:alpha.workId,title:'历史读取修复'}],soleOpenWorkId:alpha.workId,requestedWorkId:alpha.workId};
 assert.equal(resolveWorkTarget({...soleTargetFacts,userText:'不要改历史读取'}).ok,false,'negative-only sole/card/link target is not authorization');
 assert.equal(resolveWorkTarget({...soleTargetFacts,userText:'请暂停数据库备份，不是历史读取',selectedWorkId:undefined,linkedWorkIds:[],soleOpenWorkId:undefined,
  requestedWorkId:'work-backup',openWorks:[{workId:alpha.workId,title:'历史读取修复'},{workId:'work-backup',title:'数据库备份检查'}]}).ok,true);
 const severalPositive=requestFor('修历史读取和长期记忆，不动重名事项');
 await assertRejectedTarget(severalPositive.requestId,alpha.workId);
 await assertRejectedTarget(severalPositive.requestId,beta.workId);
 // Real user correction: change only B while A/C continue unchanged.
 const preservedA=unwrap(works.createWork(user,{operationId:'preserved-analysis-a',title:'验收分析A'}));
 const preservedC=unwrap(works.createWork(user,{operationId:'preserved-continuous-c',title:'验收持续简报'}));
 const retainedBefore=[works.getWork(preservedA.workId),works.getWork(preservedC.workId)];
 const realCorrection='这轮只修历史读取：最终 execution.txt 必须为 B-AMENDED，替换原来的 B-ORIGINAL。验收分析A和验收持续简报都继续，不要取消或改变它们。';
 for (const instruction of [realCorrection,'这轮只修历史读取，验收分析A和验收持续简报保持不变',
   '这轮只修历史读取，验收分析A和验收持续简报照常运行']) {
  const request=requestFor(instruction);
  assert.equal(unwrap(await invoke('work_amend',{workId:alpha.workId,goalDescription:'最终 execution.txt 必须为 B-AMENDED',
   versionGuard:await queryGuard(alpha.workId,request.requestId)},request.requestId)).goalDescription,'最终 execution.txt 必须为 B-AMENDED');
  await assertRejectedTarget(request.requestId,preservedA.workId);
  await assertRejectedTarget(request.requestId,preservedC.workId);
 }
 assert.deepEqual([works.getWork(preservedA.workId),works.getWork(preservedC.workId)],retainedBefore,'preserved A/C are not cancelled, resumed, or amended');
 const bothControls=requestFor('修历史读取，继续验收分析A');
 await assertRejectedTarget(bothControls.requestId,alpha.workId);
 await assertRejectedTarget(bothControls.requestId,preservedA.workId);
 const exclusiveWithResume=requestFor('只修历史读取，恢复验收分析A继续执行');
 await assertRejectedTarget(exclusiveWithResume.requestId,alpha.workId);
 await assertRejectedTarget(exclusiveWithResume.requestId,preservedA.workId);
 unwrap(works.pauseWork(user,{operationId:'pause-preserved-a',workId:preservedA.workId,versionGuard:guardOf(works.getWork(preservedA.workId)!)}));
 const actualResume=requestFor('继续验收分析A');
 assert.equal(unwrap(await invoke('work_resume',{workId:preservedA.workId,
  versionGuard:await queryGuard(preservedA.workId,actualResume.requestId)},actualResume.requestId)).lifecycle,'active','continue may genuinely resume a paused task');
 // A request link is replay evidence, never permission to override a resolved target.
 for (const linkedRequest of [requestFor(`暂停 ${alpha.workId}`),requestFor('暂停历史读取修复'),
   requestFor('这轮只修历史读取'),requestFor('暂停当前选中任务',alpha.workId),
   requestFor('暂停刚才那项',undefined,named.assistantMessageId)]) {
  messages.linkWork(messages.receipt(LOCAL_USER_ID,DEFAULT_BOT_ID,linkedRequest.requestId)!,beta.workId);
  await assertRejectedTarget(linkedRequest.requestId,beta.workId);
 }
 const fragmentAmbiguous=requestFor('历史读取和长期记忆这轮都处理');
 await assertRejectedTarget(fragmentAmbiguous.requestId,alpha.workId);
 await assertRejectedTarget(fragmentAmbiguous.requestId,beta.workId);
 await assertRejectedTarget(requestFor('这轮继续修复任务').requestId,alpha.workId);
 const similar=unwrap(works.createWork(user,{operationId:'routing-history-second',title:'历史读取性能回归'}));
 await assertRejectedTarget(requestFor('这轮只修历史读取').requestId,alpha.workId);
 await assertRejectedTarget(requestFor('这轮只修历史读取').requestId,similar.workId);
 unwrap(works.cancelWork(user,{operationId:'close-routing-history-second',workId:similar.workId,versionGuard:guardOf(works.getWork(similar.workId)!)}));
 // Explicit workId in the message keeps priority over a named title.
 const explicit=requestFor(`请暂停 ${beta.workId}，历史读取修复这轮先不动`);
 await assertRejectedTarget(explicit.requestId,alpha.workId);
 assert.equal(unwrap(await invoke('work_pause',{workId:beta.workId,
  versionGuard:await queryGuard(beta.workId,explicit.requestId)},explicit.requestId)).lifecycle,'paused');
 assert.equal(reviewState(alpha.workId),'active');
 restore(beta.workId);
 // The UI-selected card keeps priority over a title named in the message.
 const card=requestFor('暂停长期记忆迁移',alpha.workId);
 await assertRejectedTarget(card.requestId,beta.workId);
 assert.equal(unwrap(await invoke('work_pause',{workId:alpha.workId,
  versionGuard:await queryGuard(alpha.workId,card.requestId)},card.requestId)).lifecycle,'paused');
 restore(alpha.workId);
 // Two open Works both named in the message: ambiguous, refuse with the old style.
 const ambiguous=requestFor('同时处理历史读取修复与长期记忆迁移');
 await assertRejectedTarget(ambiguous.requestId,alpha.workId);
 await assertRejectedTarget(ambiguous.requestId,beta.workId);
 // Two open Works sharing the same named title are also ambiguous.
 const duplicate=requestFor('暂停重名事项复核');
 await assertRejectedTarget(duplicate.requestId,duplicateA.workId);
 await assertRejectedTarget(duplicate.requestId,duplicateB.workId);
 // Too-short titles are not deterministic anchors; the unrelated long title is
 // never inferred from a short control message.
 await assertRejectedTarget(requestFor('暂停周报').requestId,shortWork.workId);
 await assertRejectedTarget(requestFor('暂停').requestId,longWork.workId);
 // A Work created earlier in the same request remains controllable (replay contract).
 const createdRequest=requestFor('创建一个新任务然后暂停它');
 const createdInRequest=unwrap(await validInvoke('work_create',{requestedOutcome:'one_time',mode:'once',
  title:'Created routing item'},createdRequest.requestId));
 assert.equal(unwrap(await invoke('work_pause',{workId:createdInRequest.workId,
  versionGuard:await queryGuard(createdInRequest.workId,createdRequest.requestId)},createdRequest.requestId)).lifecycle,'paused');
 // Cancel also reuses the same resolver: the unique named title is the target.
 const cancelByTitle=requestFor('取消持续优化首屏打开速度的完整性能回归检查');
 const cancelled=unwrap(await invoke('work_cancel',{workId:longWork.workId,
  versionGuard:await queryGuard(longWork.workId,cancelByTitle.requestId)},cancelByTitle.requestId));
 assert.equal(cancelled.closureConclusion,'cancelled');
 assert.equal(reviewState(alpha.workId),'active');assert.equal(reviewState(beta.workId),'active');
 console.log('PASS target resolution: unique title resolves, explicit ID/card keep priority, ambiguous/named-duplicate/short/unrelated refuse, request links and cancel reuse the same policy');

 // One natural request controls several exact targets without replaying a
 // successful item when another item conflicts or the model retries the batch.
 const batchA=unwrap(works.createWork(user,{operationId:'batch-a',title:'报价文档准备'}));
 const batchB=unwrap(works.createWork(user,{operationId:'batch-b',title:'客户资料整理'}));
 const batchC=unwrap(works.createWork(user,{operationId:'batch-c',title:'库存变化观察'}));
 const batch=requestFor(`把 ${batchA.workId} 和 ${batchB.workId} 都暂停，${batchC.workId} 照常。`);
 const batchGuardA=await queryGuard(batchA.workId,batch.requestId);
 const batchGuardB=await queryGuard(batchB.workId,batch.requestId);
 unwrap(await invoke('work_pause',{workId:batchA.workId,versionGuard:batchGuardA},batch.requestId));
 unwrap(works.amendWork(user,{operationId:'batch-b-concurrent',workId:batchB.workId,title:'客户资料整理新版',versionGuard:batchGuardB}));
 const conflict=await invoke('work_pause',{workId:batchB.workId,versionGuard:batchGuardB},batch.requestId);
 assert.equal(conflict.ok,false);assert.equal(reviewState(batchA.workId),'paused');
 const aVersion=works.getWork(batchA.workId)!.stateVersion;
 const replay=await invoke('work_pause',{workId:batchA.workId,versionGuard:await queryGuard(batchA.workId,batch.requestId)},batch.requestId);
 assert.equal(replay.replayed,true);assert.equal(works.getWork(batchA.workId)!.stateVersion,aVersion);
 unwrap(await invoke('work_pause',{workId:batchB.workId,versionGuard:await queryGuard(batchB.workId,batch.requestId)},batch.requestId));
 await assertRejectedTarget(batch.requestId,batchC.workId);
 assert.equal(reviewState(batchC.workId),'active');
 const mixed=requestFor(`暂停 ${batchC.workId}，恢复 ${batchA.workId}，不要动 ${batchB.workId}`);
 await assert.rejects(()=>invoke('work_resume',{workId:batchC.workId,versionGuard:guardOf(works.getWork(batchC.workId)!)},mixed.requestId),/请明确/);
 unwrap(await invoke('work_pause',{workId:batchC.workId,versionGuard:await queryGuard(batchC.workId,mixed.requestId)},mixed.requestId));
 unwrap(await invoke('work_resume',{workId:batchA.workId,versionGuard:await queryGuard(batchA.workId,mixed.requestId)},mixed.requestId));
 assert.equal(reviewState(batchB.workId),'paused');
 const namedBatch=requestFor('恢复客户资料整理新版和库存变化观察');
 for(const work of [batchB,batchC])unwrap(await invoke('work_resume',{workId:work.workId,versionGuard:await queryGuard(work.workId,namedBatch.requestId)},namedBatch.requestId));
 const conditional=requestFor(`先暂停 ${batchA.workId}，等 ${batchB.workId} 完成再恢复 ${batchA.workId}`);
 unwrap(await invoke('work_pause',{workId:batchA.workId,versionGuard:await queryGuard(batchA.workId,conditional.requestId)},conditional.requestId));
 const conditionalGuard=await queryGuard(batchA.workId,conditional.requestId);
 await assert.rejects(()=>invoke('work_resume',{workId:batchA.workId,versionGuard:conditionalGuard},conditional.requestId),/请明确/);
 for(const text of [`如果发布成功，再恢复 ${batchA.workId}`,`等发布完成之后再恢复 ${batchA.workId}`]) {
  const request=requestFor(text);
  await assert.rejects(()=>invoke('work_resume',{workId:batchA.workId,versionGuard:guardOf(works.getWork(batchA.workId)!)},request.requestId),/请明确/);
 }
 const singlePause=requestFor(`暂停 ${batchB.workId}`);
 await assert.rejects(()=>invoke('work_cancel',{workId:batchB.workId,versionGuard:guardOf(works.getWork(batchB.workId)!)},singlePause.requestId),/请明确/);
 const separatedCondition=requestFor(`先暂停 ${batchC.workId}，如果发布成功，再恢复 ${batchA.workId}`);
 unwrap(await invoke('work_pause',{workId:batchC.workId,versionGuard:await queryGuard(batchC.workId,separatedCondition.requestId)},separatedCondition.requestId));
 await assert.rejects(()=>invoke('work_resume',{workId:batchA.workId,versionGuard:guardOf(works.getWork(batchA.workId)!)},separatedCondition.requestId),/请明确/);
 console.log('PASS explicit multi-item control: mixed actions, exclusions, partial conflict, per-item replay, full titles and deferred action refused');

 // ----------------------------------------------------- (d) ongoing can act then wait
 const future=Date.now()+3_600_000;
 const ongoingThenWait=requestFor('持续优化首屏速度，先把现在能做的做完，之后复查');
 const ongoingArgs={requestedOutcome:'ongoing',mode:'watch',title:'持续优化首屏速度',startImmediately:true,
  watchRule:{nextWakeAt:future,scheduleBasis:'user_specified',timezone:'UTC'}};
 const ongoing=unwrap(await validInvoke('work_create',ongoingArgs,ongoingThenWait.requestId));
 assert.equal(ongoing.watchRule?.requestedOutcome,'ongoing');
 assert.equal(ongoing.mode,'watch');assert.equal(ongoing.watchRule?.cronExpression,undefined);
 const ongoingSubscription=works.repo.listSubscriptions(ongoing.workId).find(item=>item.source==='cron')!;
 assert.equal(ongoingSubscription.nextWakeAt,future,'the future follow-up is persisted');
 assert.equal((db.connection.prepare("SELECT count(*) n FROM work_events_inbox WHERE work_id=? AND process_reason='user-requested-first-check'")
  .get(ongoing.workId) as {n:number}).n,1,'ongoing startImmediately executes now, then waits');
 const onceFutureRequest=requestFor('一小时后读取文件并交付一次结果，不循环');
 const onceFuture=unwrap(await validInvoke('work_create',{requestedOutcome:'one_time',mode:'watch',title:'一次未来执行',watchRule:{nextWakeAt:future,scheduleBasis:'user_specified',timezone:'UTC'}},onceFutureRequest.requestId));
 assert.equal(onceFuture.watchRule?.executionMode,'continuous');
 assert.equal(onceFuture.watchRule?.requestedOutcome,'one_time','one-time intent survives frontend routing and normalized persistence');
 const waitOnly=requestFor('持续跟进，先不动，之后复查');
 const waiting=unwrap(await validInvoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'先等待再跟进',
  watchRule:{nextWakeAt:future+1000,scheduleBasis:'user_specified',timezone:'UTC'}},waitOnly.requestId));
 assert.equal((db.connection.prepare("SELECT count(*) n FROM work_events_inbox WHERE work_id=? AND process_reason='user-requested-first-check'")
  .get(waiting.workId) as {n:number}).n,0,'without startImmediately the first action is the future check');
 const immediateRequest=requestFor('持续优化，先推进当前步骤，不要编造等待时间');
 const immediate=unwrap(await validInvoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'立即持续推进',startImmediately:true},immediateRequest.requestId));
 assert.equal(immediate.watchRule?.executionMode,'continuous');
 assert.equal(works.repo.listSubscriptions(immediate.workId)[0].nextWakeAt,undefined);
 const immediateEvent=works.repo.listInbox(immediate.workId,['pending'])[0];
 assert(immediateEvent);assert.equal(isReadOnlyScheduledFollowUp(immediateEvent,immediate),false,'immediate continuous action is not reduced to a read-only poll');
 const sources=await validInvoke('work_watch_sources',{}) as {sources:Array<{source:string}>};
 assert(!sources.sources.some(s=>s.source==='hook'));assert(!sources.sources.some(s=>s.source==='file'));
 await assert.rejects(()=>invoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'unwired hook',watchRule:{eventSource:'hook',scheduleBasis:'user_specified'}},immediateRequest.requestId),/尚未接入/);
 await assert.rejects(()=>invoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'unsupported',watchRule:{eventSource:'file',scheduleBasis:'user_specified'}},immediateRequest.requestId),/不可用/);
 // Explicit simulated receiver for the following hook-only test. Production has none.
 works.ingress.setReceiverAvailable('hook',true);
 const eventRequest=requestFor('下一次hook事件发生时检查');
 const eventWork=unwrap(await validInvoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'下一次事件',watchRule:{eventSource:'hook',eventTarget:'fixture',triggerMode:'next_event',scheduleBasis:'user_specified'}},eventRequest.requestId));
 const sub=works.repo.listSubscriptions(eventWork.workId)[0];
 assert.equal(sub.source,'hook');assert.equal(sub.sourceTarget,'fixture');assert.equal(sub.nextWakeAt,undefined);
 assert.equal(works.repo.listInbox(eventWork.workId,['pending']).length,0);
 const oldEvent=works.ingress.accept({source:'hook',sourceEventId:'old-event',eventType:'hook',occurredAt:sub.createdAt-1,payload:{target:'fixture'}},{subscriptionId:sub.subscriptionId,trust:'host'});
 assert.equal(oldEvent.outcomes[0].reasonCode,'before-next-event-baseline');
 const currentRequest=requestFor('检查现在的状态，然后等待hook变化');
 const currentWork=unwrap(await validInvoke('work_create',{requestedOutcome:'ongoing',mode:'watch',title:'当前状态',watchRule:{eventSource:'hook',eventTarget:'fixture',triggerMode:'current_condition',scheduleBasis:'user_specified'}},currentRequest.requestId));
 assert.equal(works.repo.listInbox(currentWork.workId,['pending']).length,1,'current condition checks immediately without inventing a cron');
 console.log('PASS immediate ongoing with no clock, truthful event catalog, unsupported source fallback, next-event baseline and current-condition check');
 const worksBefore=works.listWorks(LOCAL_USER_ID,{includeClosed:true}).length;
 const rejects:Array<[unknown,RegExp]>=[
  [{requestedOutcome:'ongoing',mode:'watch',title:'没有未来动作'},/持续目标需要可执行/],
  [{requestedOutcome:'ongoing',mode:'once',title:'持续目标不能降到一次'},/持续目标需要真实/],
  [{requestedOutcome:'one_time',mode:'watch',title:'一次性不能无限周期',
    watchRule:{cronExpression:'0 9 * * *',scheduleBasis:'user_specified'}},/一次性目标不能创建无限周期/]];
 for(const [args,expected] of rejects){
  const request=requestFor(`拒绝夹具：${(args as {title:string}).title}`);
  assert.equal(accepts('work_create',args),true,'wire shape stays valid; the host rejects by policy');
  await assert.rejects(()=>invoke('work_create',args,request.requestId),expected);
 }
 assert.equal(works.listWorks(LOCAL_USER_ID,{includeClosed:true}).length,worksBefore,'rejected goals create no Work');
 console.log('PASS ongoing semantics: nextWakeAt(+startImmediately) accepted as execute-then-wait, no-future-action and one_time+cron still rejected');
} finally {cron.stop();db.close();rmSync(root,{recursive:true,force:true});}
