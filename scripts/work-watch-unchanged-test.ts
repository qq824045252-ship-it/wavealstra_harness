// Issue #27 §6 no-change fast path: a host-proven unchanged changes_only round
// must make ZERO result-review calls and record only host provenance as silence.
// Changed/unverified evidence, new preference versions, paused/expired rounds,
// pending follow-ups and open user questions must still take the existing review.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {WorkService,DESKTOP_USER_GRANTS} from '../src/main/agent/work/WorkService';
import {BotConversationRepository} from '../src/main/agent/work/BotConversationRepository';
import {WorkConversationFeedback} from '../src/main/agent/work/WorkConversationFeedback';
import {WorkWatchSupervision} from '../src/main/agent/work/WorkWatchSupervision';
import {LOCAL_USER_ID,DEFAULT_BOT_ID,type WorkDto} from '../src/shared/bot-work';

const root=mkdtempSync(join(tmpdir(),'watch-unchanged-'));
const db=new AppDatabase(join(root,'unchanged.db'));
const bots=new BotRegistry(db.connection);bots.ensureDefaultBot(LOCAL_USER_ID);
const works=new WorkService(db.connection,{bots});
const messages=new BotConversationRepository(db.connection);
const source=messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:'source',text:'持续观察文件内容，只在变化时通知'});
const created=works.createWork({kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS},
 {operationId:'unchanged-watch',title:'unchanged watch',mode:'watch',ownerBotId:DEFAULT_BOT_ID,inputSnapshotId:'unchanged-input',
  authorization:DESKTOP_USER_GRANTS,conversationId:source.conversationId,sourceMessageId:source.userMessageId,
  watchRule:{cronExpression:'* * * * *',timezone:'UTC',notificationMode:'changes_only',notifyInitial:false}});
assert(created.ok,JSON.stringify(created));const work=created.work;
const feedback=new WorkConversationFeedback({db:db.connection,userId:LOCAL_USER_ID,works,isAuthority:()=>true,superviseWatch:true});
let preferences="";
const reviewContexts:any[]=[];
const deliveries:any[]=[];
const supervisor=new WorkWatchSupervision({db:db.connection,works,isAuthority:()=>true,preferences:()=>preferences,wake:()=>{},
 deliver:(input:any)=>{deliveries.push(input);return feedback.deliverCompletion(input);},
 review:async(input:any)=>{reviewContexts.push(input.context);
  return {decision:'deliver' as const,outcome:'completed' as const,reply:'已核对：'+input.context.observationSummary,missing:[]};}});
function receipt(id:string,summary=id,target:WorkDto=work){
 works.repo.insertBinding({bindingId:id,workId:target.workId,operationId:id,botId:DEFAULT_BOT_ID,taskId:id,durableStoreKey:'store',
  conversationId:'native',intentRevision:target.intentRevision,ownerEpoch:target.ownerEpoch,inputSnapshotId:target.inputSnapshotId,
  expertSnapshot:bots.activeSnapshot(DEFAULT_BOT_ID)!,delegatedScope:['workspace:read'],workspaceBinding:root,status:'completed',
  admittedAt:Date.now(),settledAt:Date.now(),settlementNote:id});
 works.repo.insertDeliverable({deliverableId:`result:${id}`,workId:target.workId,executionId:id,producerBotId:DEFAULT_BOT_ID,
  intentRevision:target.intentRevision,ownerEpoch:target.ownerEpoch,inputSnapshotId:target.inputSnapshotId,status:'proposed',
  summary,artifactRefs:[],evidenceRefs:[],uncoveredScope:[],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:Date.now()});
 db.connection.prepare('INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at) VALUES (?,?,?,?,?,?)')
  .run(id,id,id,'{}',Date.now(),Date.now());
}
const observation=(value:string)=>JSON.stringify({protocol:'watch-observation-v1',status:'observed',
 facts:[{source:'/fixture/unchanged',key:'file_content',value}],summary:`本轮读取：${value}`});
function observed(id:string,value:string){
 const summary=observation(value);
 receipt(id,summary);
 db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?').run(JSON.stringify({status:'completed',summary,
  hasWriteConflicts:false,artifactRefs:[],readEvidence:[{toolCallId:id,toolName:'read',kind:'file-content',target:'/fixture/unchanged',
   partial:false,at:Date.now(),outputHash:createHash('sha256').update(value).digest('hex'),outputText:value}]}),id);
}
const flush=async()=>{supervisor.wake();supervisor.wake();await delay(70);};
const row=(id:string)=>db.connection.prepare(`SELECT state,decision_json,error,attempts,reviewed_at,
  json_extract(context_json,'$.reason') reason,json_extract(context_json,'$.hostProvenUnchanged') hostProven
  FROM work_watch_reviews WHERE binding_id=?`).get(id) as {state:string;decision_json:string|null;error:string|null;
   attempts:number;reviewed_at:number|null;reason:string|null;hostProven:number|null}|undefined;
const guard=()=>{const current=works.getWork(work.workId)!;return {expectedStateVersion:current.stateVersion,
  expectedIntentRevision:current.intentRevision,expectedOwnerEpoch:current.ownerEpoch};};
const feedbackRows=(bindingId:string)=>(db.connection.prepare(`SELECT count(*) n FROM bot_work_feedback
  WHERE json_extract(metadata_json,'$.executionId')=? AND json_extract(metadata_json,'$.kind')='result'`).get(bindingId) as {n:number}).n;
try {
 // 1) First observed round has no baseline: the existing review path runs once.
 observed('round-baseline','A');await flush();
 assert.equal(reviewContexts.length,1);assert.equal(reviewContexts[0].comparisonState,'no_baseline');
 assert.equal(row('round-baseline')!.state,'silent','initial changes_only baseline stays quiet');
 // 2) Same evidence again: host proves unchanged -> zero review calls, no delivery.
 observed('round-unchanged','A');await flush();
 assert.equal(reviewContexts.length,1,'proven-unchanged round makes zero review calls');
 const fast=row('round-unchanged')!;
 assert.equal(fast.state,'silent');assert.equal(fast.decision_json,null);assert.equal(fast.error,null);assert.equal(fast.attempts,0);
 assert.equal(fast.reason,'host_proven_unchanged');assert.equal(fast.hostProven,1);assert(fast.reviewed_at!>0);
 assert.equal(deliveries.filter(item=>item.bindingId==='round-unchanged').length,0);
 assert.equal(feedbackRows('round-unchanged'),0,'fast path never writes a user-visible result');
 // 3) A second consecutive unchanged round reuses the same proven silence.
 observed('round-unchanged-again','A');await flush();
 assert.equal(reviewContexts.length,1,'restarted unchanged rounds also skip review');
 assert.equal(row('round-unchanged-again')!.state,'silent');
 // 4) Changed evidence still goes through the existing review and delivers.
 observed('round-changed','B');await flush();
 assert.equal(reviewContexts.length,2);assert.equal(reviewContexts.at(-1).comparisonState,'changed');
 assert.equal(row('round-changed')!.state,'delivered');
 assert.equal(feedbackRows('round-changed')>0,true);
 // 5) Unverified evidence (no comparable native read receipt) is not silence.
 const unverifiedSummary=observation('B');
 receipt('round-unverified',unverifiedSummary);
 db.connection.prepare('UPDATE work_native_inbox SET payload_json=? WHERE binding_id=?')
  .run(JSON.stringify({status:'completed',summary:unverifiedSummary,hasWriteConflicts:false,artifactRefs:[]}),'round-unverified');
 await flush();
 assert.equal(reviewContexts.length,3,'unverified evidence still asks the review turn');
 assert.equal(reviewContexts.at(-1).comparisonState,'unverified');
 assert.equal(row('round-unverified')!.state,'delivered');
 // 6) A changed personal-preference version invalidates the cached silence.
 preferences="pref-v1";observed('round-pref-a','C');await flush();
 assert.equal(reviewContexts.length,4,'changed evidence reviews first');
 observed('round-pref-a-same','C');await flush();
 assert.equal(reviewContexts.length,4,'unchanged round under the reviewed preference version skips review');
 preferences="pref-v2";observed('round-pref-b','C');await flush();
 assert.equal(reviewContexts.length,5,'a new preference version is understood again, not reused');
 // 7) Paused lifecycle / expired schedule / pending follow-up / open question all
 //    force the existing review path even when the host comparison is unchanged.
 const paused=works.pauseWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},
  {operationId:'pause-unchanged',workId:work.workId,versionGuard:guard()});
 assert(paused.ok,JSON.stringify(paused));
 observed('round-paused','C');await flush();
 assert.equal(reviewContexts.length,6,'paused work is not silently settled');
 assert.equal(works.resumeWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},
  {operationId:'resume-unchanged',workId:work.workId,versionGuard:guard()}).ok,true);
 works.repo.insertBlocker({blockerId:'blocker-unchanged',workId:work.workId,reason:'需要用户确认观察范围',
  kind:'operational',waitingForUserInput:true,status:'open',createdAt:Date.now()});
 observed('round-question','C');await flush();
 assert.equal(reviewContexts.length,7,'an open user-input question still needs the review turn');
 works.repo.clearBlocker('blocker-unchanged',work.workId,Date.now());
 works.repo.updateWork({...works.getWork(work.workId)!,watchRule:{...works.getWork(work.workId)!.watchRule!,endsAt:Date.now()-1},
  updatedAt:Date.now()});
 observed('round-expired','C');await flush();
 assert.equal(reviewContexts.length,8,'an expired schedule is not treated as silent-unchanged');
 works.repo.updateWork({...works.getWork(work.workId)!,watchRule:{...works.getWork(work.workId)!.watchRule!,endsAt:undefined},
  updatedAt:Date.now()});
 db.connection.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,
  input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
  VALUES ('plan-unchanged',?,?,?,?,?,?,?,?,?,'pending',?)`).run(work.workId,'round-changed','plan-op',work.intentRevision,
  work.inputSnapshotId,work.ownerEpoch,DEFAULT_BOT_ID,JSON.stringify(['watch-followup:fixture']),'fixture follow-up',Date.now());
 observed('round-followup-pending','C');await flush();
 assert.equal(reviewContexts.length,9,'a pending read-only follow-up keeps the round in the review lane');
 db.connection.prepare("UPDATE work_continuation_plans SET state='settled' WHERE plan_id='plan-unchanged'").run();
 observed('round-followup-settled','C');await flush();
 assert.equal(reviewContexts.length,9,'after the follow-up settles the proven-unchanged shortcut applies again');
 assert.equal(row('round-followup-settled')!.reason,'host_proven_unchanged');
 // The fast path never delivers, and the work stays active/standing.
 for (const id of ['round-unchanged','round-unchanged-again','round-followup-settled'])
  assert.equal(deliveries.filter(item=>item.bindingId===id).length,0,`${id} fast path must not deliver`);
 assert.equal(works.getWork(work.workId)!.lifecycle,'active','silence does not close the standing commission');
 console.log('PASS unchanged fast path: unchanged/silent -> 0 review calls + silent host-proven row + no delivery; changed/unverified/preference/paused/expired/question/follow-up -> existing review path');
} finally {supervisor.close();feedback.close();db.close();rmSync(root,{recursive:true,force:true});}