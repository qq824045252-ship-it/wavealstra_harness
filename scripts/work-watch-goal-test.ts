import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {WorkService,DESKTOP_USER_GRANTS} from '../src/main/agent/work/WorkService';
import {WorkWatchSupervision} from '../src/main/agent/work/WorkWatchSupervision';
import {watchGoalEvidence,watchGoalMet} from '../src/main/agent/work/WorkWatchGoal';
import {LOCAL_USER_ID,DEFAULT_BOT_ID} from '../src/shared/bot-work';
import type {WorkResultDecision} from '../src/main/agent/work/BotWorkResultTurn';
const root=mkdtempSync(join(tmpdir(),'watch-goal-')),db=new AppDatabase(join(root,'test.db'));
const bots=new BotRegistry(db.connection);bots.ensureDefaultBot(LOCAL_USER_ID);
const works=new WorkService(db.connection,{bots});
const condition='文件为 READY 时结束',request='持续检查发布进度，文件为 READY 时结束，不需我确认。';
const originalRequest={userRequest:{messages:[{text:request}]}};
function create(name:string){const result=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},{operationId:name,title:name,mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:name,authorization:DESKTOP_USER_GRANTS,watchRule:{cronExpression:'* * * * *',timezone:'UTC',stopConditionText:condition}});assert(result.ok);return result.work;}
function receipt(work:ReturnType<typeof create>,id:string,options:{status?:'completed'|'failed'|'running'|'stopped';event?:string;text?:string;consumed?:boolean;partial?:boolean;noRead?:boolean;conflict?:boolean}={}){
 const status=options.status??'completed',text=options.text??'READY';
 works.repo.insertBinding({bindingId:id,workId:work.workId,operationId:id,botId:DEFAULT_BOT_ID,taskId:id,durableStoreKey:'store',conversationId:'native',intentRevision:work.intentRevision,ownerEpoch:work.ownerEpoch,inputSnapshotId:work.inputSnapshotId,expertSnapshot:bots.activeSnapshot(DEFAULT_BOT_ID)!,delegatedScope:[],workspaceBinding:root,status,admittedAt:Date.now(),settledAt:status==='running'?undefined:Date.now(),settlementNote:text,inboxEventId:options.event});
 works.repo.insertDeliverable({deliverableId:`result:${id}`,workId:work.workId,executionId:id,producerBotId:DEFAULT_BOT_ID,intentRevision:work.intentRevision,ownerEpoch:work.ownerEpoch,inputSnapshotId:work.inputSnapshotId,status:'proposed',summary:'model report: '+text,artifactRefs:[],evidenceRefs:[],uncoveredScope:[],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:Date.now()});
 if(status!=='running')db.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)').run(id,id,id,JSON.stringify({status,summary:text,hasWriteConflicts:options.conflict??false,artifactRefs:[],readEvidence:options.noRead?[]:[{toolCallId:'read-1',toolName:'read',kind:'file-content',target:'/fixture/status.txt',at:Date.now(),partial:options.partial??false,outputHash:createHash('sha256').update(text).digest('hex'),outputText:text}]}),Date.now(),options.consumed===false?null:Date.now());
 return works.repo.getBinding(id)!;
}
const inputs=new Map<string,object>();
const nativeInput=works.repo.executionInput.bind(works.repo);
works.repo.executionInput=b=>JSON.stringify(inputs.get(b.bindingId)??originalRequest);
const decision=(id:string):WorkResultDecision=>({decision:'deliver',outcome:'completed',reply:'已读到 READY，发布准备就绪，正在结束持续委托。',missing:[],stopAssessment:{status:'met',conditionExcerpt:condition,requestExcerpt:condition,evidence:[{resultId:`${id}:read-1`,quote:'READY'}]}});
let checks=0;
const check=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS '+name);};
const work=create('pure'),binding=receipt(work,'pure');
const evidence=watchGoalEvidence(db.connection,works,binding);
check('host receipt raw text is available',()=>{assert.equal(evidence.length,1);assert.equal(evidence[0].text,'READY');assert(watchGoalMet(work,binding,decision('pure'),originalRequest,evidence));});
for(const [name,mutate] of [
 ['paused',(w:any)=>({...w,lifecycle:'paused'})],['closed',(w:any)=>({...w,lifecycle:'closed'})],['expired',(w:any)=>({...w,watchRule:{...w.watchRule,endsAt:Date.now()-1}})],['no stop condition',(w:any)=>({...w,watchRule:{...w.watchRule,stopConditionText:undefined}})],['new intent',(w:any)=>({...w,intentRevision:2})],['new owner',(w:any)=>({...w,ownerEpoch:2})],['new input',(w:any)=>({...w,inputSnapshotId:'new'})]
] as const)check(name+' does not finish',()=>assert(!watchGoalMet(mutate(work),binding,decision('pure'),originalRequest,evidence)));
check('exact JSON-escaped source quote matches raw newline, not invented text',()=>{
 const raw=[{...evidence[0],text:'READY\n'}];
 const proof=(quote:string)=>({...decision('pure'),stopAssessment:{...decision('pure').stopAssessment!,evidence:[{resultId:'pure:read-1',quote}]}});
 assert(watchGoalMet(work,binding,proof('READY\\n'),originalRequest,raw));
 assert(!watchGoalMet(work,binding,proof('DONE\\n'),originalRequest,raw));
});
check('fake quote or old result cannot finish',()=>{for(const proof of [{resultId:'pure:read-1',quote:'ALL DONE'},{resultId:'old:read-1',quote:'READY'}])assert(!watchGoalMet(work,binding,{...decision('pure'),stopAssessment:{...decision('pure').stopAssessment!,evidence:[proof]}},originalRequest,evidence));});
check('invented user instruction or altered condition cannot finish',()=>{for(const change of [{requestExcerpt:'立即关闭任何任务'},{conditionExcerpt:'发生任何变化即结束'}])assert(!watchGoalMet(work,binding,{...decision('pure'),stopAssessment:{...decision('pure').stopAssessment!,...change}},originalRequest,evidence));});
check('failed/unknown/not_met observation cannot finish',()=>{assert(!watchGoalMet(work,{...binding,status:'failed'},decision('pure'),originalRequest,evidence));assert(!watchGoalMet(work,binding,{...decision('pure'),outcome:'unknown'},originalRequest,evidence));assert(!watchGoalMet(work,binding,{...decision('pure'),stopAssessment:{...decision('pure').stopAssessment!,status:'not_met'}},originalRequest,evidence));});
for(const options of [{consumed:false},{noRead:true},{partial:true},{conflict:true},{status:'failed' as const}])check('unusable receipt '+JSON.stringify(options),()=>{const b=receipt(work,'invalid-'+checks,options);assert.deepEqual(watchGoalEvidence(db.connection,works,b),[]);});
const member=receipt(work,'member',{event:'round-1'}),owner=receipt(work,'owner',{event:'round-1'});
const teamGet=works.teams.get.bind(works.teams);
let expectedMembers=[member.botId],currentRound=1;
works.teams.get=(id:string)=>id===work.workId?({...work,members:expectedMembers.map(botId=>({botId})),watchRound:currentRound,executions:[{role:'member',botId:member.botId,bindingId:member.bindingId}]} as any):teamGet(id);
inputs.set(owner.bindingId,{...originalRequest,teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-1'},previousResults:[{botId:member.botId,bindingId:member.bindingId}]}});
check('same-round team member raw receipt',()=>assert.equal(watchGoalEvidence(db.connection,works,owner)[0].resultId,'member:read-1'));
check('member observation cannot conclude a team goal',()=>{assert.deepEqual(watchGoalEvidence(db.connection,works,member),[]);});
check('next round can start while previous complete round is reviewed',()=>{
 const next=receipt(work,'member-next',{event:'round-2',status:'running'});currentRound=2;
 assert.equal(watchGoalEvidence(db.connection,works,owner)[0].resultId,'member:read-1');
 currentRound=1;works.repo.updateBinding({...next,status:'stopped',settledAt:Date.now()});
});
check('owner context cannot substitute another round event',()=>{
 inputs.set(owner.bindingId,{...originalRequest,teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-other'},previousResults:[{botId:member.botId,bindingId:member.bindingId}]}});
 assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);
 inputs.set(owner.bindingId,{...originalRequest,teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-1'},previousResults:[{botId:member.botId,bindingId:member.bindingId}]}});
});
check('recovered member ignores historical attempt but requires current receipt',()=>{
 const team={...originalRequest,teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-1'},previousResults:[{botId:member.botId,bindingId:'historical-failed-attempt'},{botId:member.botId,bindingId:member.bindingId}]}};
 inputs.set(owner.bindingId,team);assert.equal(watchGoalEvidence(db.connection,works,owner)[0].resultId,'member:read-1');
 team.teamAssignment.previousResults.pop();assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);
 inputs.set(owner.bindingId,{...originalRequest,teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-1'},previousResults:[{botId:member.botId,bindingId:member.bindingId}]}});
});
check('latest same-round failed binding blocks older success; invalidated attempt is excluded',()=>{
 const later=receipt(work,'member-later-failed',{event:'round-1',status:'failed'});
 works.repo.updateBinding({...later,admittedAt:member.admittedAt+1000});
 assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);
 works.repo.updateBinding({...later,admittedAt:member.admittedAt+1000,invalidatedAt:Date.now()});
 assert.equal(watchGoalEvidence(db.connection,works,owner)[0].resultId,'member:read-1');
});
check('omitted required member cannot finish',()=>{expectedMembers=[member.botId,'missing-reader'];assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);expectedMembers=[member.botId];});
check('latest failed receipt cannot fall back to older successful raw text',()=>{db.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)').run('member-latest-failure',member.bindingId,'failure',JSON.stringify({status:'failed',summary:'source unavailable',hasWriteConflicts:false,artifactRefs:[]}),Date.now()+1000,Date.now()+1000);assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);db.connection.prepare('DELETE FROM work_native_inbox WHERE fact_id=?').run('member-latest-failure');});
check('cross-round or missing team member does not finish',()=>{works.repo.updateBinding({...member,inboxEventId:'round-old'});assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);works.repo.updateBinding(member);inputs.set(owner.bindingId,{teamAssignment:{role:'owner_summary',watchRound:{sequence:1,inbox_event_id:'round-1'},previousResults:[{bindingId:'missing'}]}});assert.deepEqual(watchGoalEvidence(db.connection,works,owner),[]);});
// Full supervisor uses actual persistent Work and native receipts, with a bounded
// deterministic model fixture. Live model verification is a separate suite.
const integrated=create('integrated'),done=receipt(integrated,'integrated-result'),inFlight=receipt(integrated,'inflight',{status:'running'});
const endsAt=Date.now()+60000;works.repo.updateWork({...integrated,watchRule:{...integrated.watchRule!,endsAt,notificationMode:"changes_only",notifyInitial:false}});
const structured=JSON.stringify({protocol:"watch-observation-v1",status:"observed",facts:[{source:"/fixture/status.txt",key:"file_content",value:"READY"}],summary:"READY 已就绪"});
db.connection.prepare("UPDATE work_deliverables SET summary=? WHERE execution_id=?").run(structured,done.bindingId);
db.connection.prepare("UPDATE work_native_inbox SET payload_json=json_set(payload_json,'$.summary',?) WHERE binding_id=?").run(structured,done.bindingId);
let calls=0;const deliveries:any[]=[];
const options={db:db.connection,works,isAuthority:()=>true,wake:()=>{},deliver:(message:any)=>{deliveries.push(message);return true;},review:async(input:any)=>{calls++;return input.context.verifiedObservations.length?decision(input.context.verifiedObservations[0].resultId.split(':')[0]):{decision:'deliver' as const,outcome:'partial' as const,missing:[],reply:'本轮未取得可核实的新证据'};}};
// Keep earlier pure fixtures out of this supervision pass.
works.repo.updateWork({...work,lifecycle:'closed',closureConclusion:'cancelled'});
let supervisor=new WorkWatchSupervision(options);
supervisor.wake();await delay(80);
check('changes_only baseline cannot suppress met result; schedule stops and inflight waits',()=>{assert.equal(works.getWork(integrated.workId)!.lifecycle,'closing');assert.equal(works.getWork(integrated.workId)!.closureConclusion,undefined);assert.equal(deliveries.filter(d=>d.bindingId===done.bindingId).length,1);assert(works.repo.listSubscriptions(integrated.workId).every(s=>s.stoppedAt));});
check('accepted goal keeps priority when expiry tick occurs during quiet settlement',()=>{
 works.expireWatchTime(integrated.workId,endsAt+1,true);
 const pending=works.getWork(integrated.workId)!;assert.equal(pending.lifecycle,'closing');assert.equal(pending.watchRule?.termination,undefined);assert.equal(pending.closureConclusion,undefined);
});
const count=calls;supervisor.close();supervisor=new WorkWatchSupervision(options);supervisor.wake();await delay(30);
check('normal supervisor rebuild does not re-review delivered met result',()=>{assert.equal(calls,count);assert.equal(deliveries.filter(d=>d.bindingId===done.bindingId).length,1);});
works.repo.updateBinding({...inFlight,status:'stopped',settledAt:Date.now(),settlementNote:'正常停止后续检查'});
supervisor.wake();await delay(80);supervisor.wake();await delay(30);
check('quiet completion succeeds without user interaction',()=>{assert.equal(deliveries.filter(d=>d.bindingId===inFlight.bindingId).length,0,'normal stopped later check is kept in details, not a contradictory new failure report');const final=works.getWork(integrated.workId)!;assert.equal(final.lifecycle,'closed');assert.equal(final.closureConclusion,'succeeded');assert.equal((db.connection.prepare('SELECT COUNT(*) n FROM conversation_interactions').get() as any).n,0);});
const finalCalls=calls,finalDeliveries=deliveries.length;supervisor.close();supervisor=new WorkWatchSupervision(options);supervisor.wake();await delay(30);
check('repeated wake and normal reopen do not duplicate closure',()=>{assert.equal(calls,finalCalls);assert.equal(deliveries.length,finalDeliveries);});
supervisor.close();works.repo.executionInput=nativeInput;works.teams.get=teamGet;db.close();console.log(`PASS watch goal: ${checks} checks; no crash injection, live model tested separately`);
