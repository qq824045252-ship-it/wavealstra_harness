import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryRecord, SubmissionRecord, EntryQuery, LiveState, Cursor } from '@earendil-works/pi-durable';
import { DurableWorkProgressReader } from '../src/main/agent/durable/DurableWorkProgressReader';
import { BotConversationService } from '../src/main/agent/work/BotConversationService';
import { botRequestPriority, botRequestQueueRank, botRequestCapacity } from '../src/main/agent/work/BotRequestPriority';
import { workMilestoneVersion } from '../src/main/agent/work/WorkMilestones';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from '../src/shared/bot-work';
import type { WorkMilestoneDto } from '../src/shared/bot-work-phase3';

for (const text of ['这轮只修历史读取', '这次先不动长期记忆', '只修首屏', 'Stop the test', 'Only fix history lookup', '改为先查原始记录'])
  assert.equal(botRequestPriority(text), 2, text);
assert.equal(botRequestPriority('天气怎么样？'), 1);
assert.equal(botRequestPriority('做到哪了'), 1);
assert.equal(botRequestPriority('完整实现这个大型网站并做验证'), 0);
assert.equal(botRequestPriority('怎么这么慢，这也太粗糙'), 0, 'complaint never becomes control classification');
assert.equal(botRequestPriority('其他问题', true), 2);
assert.deepEqual(botRequestCapacity(2), {conversation:4,global:10});
assert.deepEqual(botRequestCapacity(1), {conversation:4,global:9});
assert.equal(botRequestQueueRank(0, 0, 30_001), 3, 'old ordinary requests are not starved by endless controls');
// Invoke the production queue, not just its hint function: a later steering
// request in another conversation must be dispatched ahead of earlier ordinary work.
const now=Date.now(), launched:string[]=[];
const queueMessages=[{messageId:'ordinary',botId:'bot',requestId:'ordinary',createdAt:now-10},
 {messageId:'steer',botId:'bot',requestId:'steer',createdAt:now}];
const service=Object.assign(Object.create(BotConversationService.prototype),{
 closing:false, options:{userId:'user',isAuthority:()=>true,bots:{getBot:()=>({status:'active'})},db:{prepare:()=>({all:(id:string)=>[{message_id:id==='c1'?'ordinary':'steer'}]})}},
 messages:{peers:{origin:()=>undefined},pending:()=>[{bot_id:'bot',conversation_id:'c1'},{bot_id:'bot',conversation_id:'c2'}],
  message:(id:string)=>id==='user-steer'?{text:'这轮只修历史读取'}:id==='user-ordinary'?{text:'执行多步骤项目'}:queueMessages.find(m=>m.messageId===id),
  receipt:(_user:string,_bot:string,id:string)=>({user_message_id:`user-${id}`})},
 drains:new Map(),runningConversations:new Map(),attempted:new Set(),runtimes:new Map(),runtimeModels:new Map(),runtimeInstructions:new Map(),composerRuntimes:new Map(),
 scheduleReceipt:()=>{},runRequest:(_bot:string,_conversation:string,next:{messageId:string})=>{launched.push(next.messageId);return new Promise(()=>{});},
}) as {kick:(botId:string,conversationId:string)=>void};
service.kick('bot','c1');await Promise.resolve();await Promise.resolve();
assert.deepEqual(launched,['steer','ordinary'],'production queue orders controls across conversations before ordinary requests');
// After one of ten controls finishes, an aged ordinary request must be admitted
// at occupancy nine, before another fresh control replenishes the reserved pool.
const saturated=service as unknown as {drains:Map<string,Promise<unknown>>;runningConversations:Map<string,string>;attempted:Set<string>};
saturated.drains.clear();saturated.runningConversations.clear();saturated.attempted.clear();launched.length=0;
for(let n=0;n<9;n++){saturated.drains.set(`busy-${n}`,new Promise(()=>{}));saturated.runningConversations.set(`busy-${n}`,`busy-c-${n}`);}
queueMessages[0]!.createdAt=now-30_001;
service.kick('bot','c1');await Promise.resolve();await Promise.resolve();
assert.deepEqual(launched,['ordinary'],'aging changes admission as well as rank under sustained high priority load');
assert.equal(saturated.drains.size,10,'aging never exceeds global concurrency ceiling');

const milestone = {milestoneId:'m',itemId:'i',task:'read data',summary:'old finding',artifactRefs:[],files:[],bindingId:'b',requiresUserInput:false,createdAt:1} satisfies WorkMilestoneDto;
assert.notEqual(workMilestoneVersion('b',[milestone]), workMilestoneVersion('b',[{...milestone,summary:'corrected finding'}]));

const placed = {type:'input',status:'placed',id:9,requestId:'original',conversationId:1,entry:1} as SubmissionRecord;
const entries: EntryRecord[] = Array.from({length:650},(_,i)=>({id:i+1,conversationId:1,kind:'fixture',model:[]} as unknown as EntryRecord));
entries[0] = {...entries[0]!,kind:'pi.user',model:[{role:'user',content:'run',timestamp:1}]};
const scanned: {min:number;count:number}[]=[];
const tx = {scanEntries:async(q:EntryQuery, limit:number, _cursor?:Cursor)=>{
  const items=entries.filter(e=>e.id >= (q.minEntryId??0) && e.id <= (q.maxEntryId??Infinity)).slice(0,limit);
  scanned.push({min:q.minEntryId??0,count:items.length});return {items,next:undefined};
}};
const item = (n:number)=>({subagentId:`child-${n}`,task:`task ${n}`,status:'completed',exitCode:0,
 messages:[{role:'assistant',content:[{type:'text',text:`verified ${n}`}]}]});
const live = {run:{taskId:2,inputs:[9],turns:1},tools:[{callId:'parallel',name:'subagent',status:'running',details:{results:Array.from({length:45},(_,n)=>item(n))}}]} as unknown as LiveState;
const reader=new DurableWorkProgressReader();
const first=await reader.read(tx,placed,'/workspace','store',live);
assert.equal(first.status,'running');
assert.equal(first.subitems?.length,40,'40 per delivery batch');
assert.equal(first.subitems?.[0]?.itemId,'parallel:child-0','cold poll does not throw away earliest completions');
assert.equal(scanned[0]!.count,200);
const retry=await reader.read(tx,placed,'/workspace','store',live);
assert.strictEqual(retry,first,'unacknowledged receive replays identical observation');
assert.equal(scanned.length,1,'failed ingest does not advance or rescan');
reader.acknowledge(placed,first,'/workspace','store');
const second=await reader.read(tx,placed,'/workspace','store',live);
assert.equal(second.subitems?.length,5);
reader.acknowledge(placed,second,'/workspace','store');
const third=await reader.read(tx,placed,'/workspace','store',live);
assert.equal(third.subitems,undefined,'unchanged api.details evidence is not retransformed into duplicate milestones');
assert.equal(scanned.at(-1)?.min,201,'warm scan starts after acknowledged page');
reader.acknowledge(placed,third,'/workspace','store');
const changed=structuredClone(live); (changed.tools![0]!.details as {results:ReturnType<typeof item>[]}).results[0]!.messages[0]!.content[0]!.text='corrected';
const corrected=await reader.read(tx,placed,'/workspace','store',changed);
assert.equal(corrected.subitems?.length,1);assert.equal(corrected.subitems?.[0]?.summary,'corrected');
reader.acknowledge(placed,corrected,'/workspace','store');
const foreign=structuredClone(live);foreign.run!.inputs=[77 as never];
const otherReader=new DurableWorkProgressReader();
assert.equal((await otherReader.read(tx,placed,'/workspace','store',foreign)).subitems,undefined,'other input live slot cannot contaminate current Work');
const retryReader=new DurableWorkProgressReader();
const retryLive=structuredClone(live);
(retryLive.tools![0]!.details as {results:unknown[]}).results=[{...item(0),status:'failed',exitCode:1,errorMessage:'tier limit; parent retry pending'}];
const interimFailure=await retryReader.read(tx,placed,'/workspace','store',retryLive);
assert.equal(interimFailure.subitems,undefined,'retryable live failure is not frozen as a terminal Work gap');
retryReader.acknowledge(placed,interimFailure,'/workspace','store');
(retryLive.tools![0]!.details as {results:unknown[]}).results=[item(0)];
assert.equal((await retryReader.read(tx,placed,'/workspace','store',retryLive)).subitems?.[0]?.outcome,'completed','same-id child success appears after internal retry');
reader.clear();
assert.equal((await reader.read(tx,placed,'/workspace','store',live)).subitems?.length,40,'restart safely replays stored evidence');
console.log('PASS priority hints/fair ordering, corrected milestone versions, one-page progress, failed receive replay, 45-item no-loss, scoped LiveDoc api.details');

const root=mkdtempSync(join(tmpdir(),'source-association-'));
const db=new AppDatabase(join(root,'source.db'));
try {
 const bots=new BotRegistry(db.connection);bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:'source test',authorization:DESKTOP_USER_GRANTS});
 const works=new WorkService(db.connection,{bots});
 const actor:WorkActor={kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
 const unwrap=(r:WorkControlResult)=>{assert(r.ok,JSON.stringify(r));return r;};
 const source={provider:'github',account:'owner',objectId:'repo/issues/27',action:'fix',version:'v1'};
 const create=(operationId:string,version='v1',title='source task')=>unwrap(works.createWork(actor,{operationId,title,inputSnapshotId:'initial',sourceIdentity:{...source,version,revision:Number(version.slice(1))}}));
 const a=create('observer-a');const b=create('observer-b','v1','completely different summary');
 assert.equal(a.work.workId,b.work.workId);assert.equal(b.replayed,true);assert.equal(works.listWorks(LOCAL_USER_ID).length,1);
 const next=create('observer-a-v2','v2');assert.equal(next.work.workId,a.work.workId);assert.equal(next.replayed,false);
 assert.notEqual(next.work.inputSnapshotId,a.work.inputSnapshotId);assert.equal(next.work.title,a.work.title,'source update never rewrites authorized goal');
 assert.equal(create('observer-b-v2','v2').replayed,true);
 works.transaction(()=>works.repo.updateWork({...works.getWork(a.work.workId)!,lifecycle:'closed',closureConclusion:'succeeded',closedAt:Date.now()}));
 const handled=create('after-handled','v2');assert.equal(handled.work.workId,a.work.workId);assert.equal(handled.replayed,true);
 const regression=create('new-regression','v3');assert.notEqual(regression.work.workId,a.work.workId);
 assert(regression.work.goalSources.some(s=>s.sourceRef===`work:${a.work.workId}`),'new regression retains old Work history');
 assert.equal(create('second-regression-observer','v3').work.workId,regression.work.workId);
 assert.equal(create('old-event-replayed','v1').work.workId,a.work.workId,'an old event cannot revive or overwrite new regression');
 const outOfOrderSource={...source,objectId:'repo/issues/out-of-order'};
 const newest=unwrap(works.createWork(actor,{operationId:'newest-first',title:'newest',sourceIdentity:{...outOfOrderSource,version:'v3',revision:3}}));
 const delayed=unwrap(works.createWork(actor,{operationId:'unseen-older',title:'older',sourceIdentity:{...outOfOrderSource,version:'v2',revision:2}}));
 assert.equal(delayed.replayed,true);assert.equal(delayed.work.inputSnapshotId,newest.work.inputSnapshotId,'first-seen stale token cannot rewind current Work');
 works.transaction(()=>works.repo.updateWork({...works.getWork(newest.work.workId)!,lifecycle:'closed',closureConclusion:'succeeded',closedAt:Date.now()}));
 assert.equal(unwrap(works.createWork(actor,{operationId:'unseen-old-after-close',title:'old',sourceIdentity:{...outOfOrderSource,version:'v1',revision:1}})).work.workId,newest.work.workId,'unseen old version cannot create a regression');
 const unordered=works.createWork(actor,{operationId:'opaque-unseen',title:'opaque',sourceIdentity:{...outOfOrderSource,version:'hash-unknown'}});
 assert.equal(unordered.ok,false);if(!unordered.ok){assert.equal(unordered.code,'source_version_unverified');assert.equal(unordered.latestWorkSnapshot?.workId,newest.work.workId);}
 const conflicting=works.createWork(actor,{operationId:'same-revision-different-token',title:'conflict',sourceIdentity:{...outOfOrderSource,version:'not-v3',revision:3}});
 assert.equal(conflicting.ok,false,'same revision with different content is not trustworthy ordering');
 const other=unwrap(works.createWork(actor,{operationId:'different-action',title:'only observe',sourceIdentity:{...source,action:'observe'}}));
 assert.notEqual(other.work.workId,a.work.workId);
 const invalid=works.createWork(actor,{operationId:'invalid-source',title:'invalid',sourceIdentity:{...source,objectId:''}});assert.equal(invalid.ok,false);
 const reopened=new WorkService(db.connection,{bots});assert.equal(unwrap(reopened.createWork(actor,{operationId:'restart-observer',title:'same source',sourceIdentity:{...source,version:'v3',revision:3}})).work.workId,regression.work.workId);
 console.log('PASS stable source identity: dual observers, versions, handled suppression, linked regression, old-event replay, distinct actions and restart');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
