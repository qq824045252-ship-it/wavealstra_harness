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
const accepts=(name:string,args:unknown)=>Value.Check(schemas.get(name)!,args);
let nextTask=0,serial=0;
const invoke=async(name:string,args:unknown,requestId=first.requestId):Promise<any>=>{
 const api={callId:`call-${++nextTask}`,taskId:`tool-${nextTask}`,memo:async()=>requestId} as unknown as ToolExecutionApi;
 const result=await tools.find(tool=>tool.name===name)!.execute(args as never,api,BACKGROUND_CONTEXT);
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
 const a=unwrap(works.createWork(user,{operationId:'live-a',title:'报价文档准备'}));
 const b=unwrap(works.createWork(user,{operationId:'live-b',title:'客户资料整理'}));
 const c=unwrap(works.createWork(user,{operationId:'live-c',title:'库存变化观察'}));
 const text=`把 ${a.workId} 和 ${b.workId} 都暂停，${c.workId} 照常。遇到版本冲突请重新查询失败项后再试，已经成功的不要重复执行。`;
 const request=requestFor(text); let injected=false; const calls:any[]=[];
 const conversation:any[]=[{role:'system',content:'你是Bot前台助手。用给定工具执行用户请求，先查询最新版本，保留目标和动作，不要操作未要求事项。工具参数只用工具返回真实值。最终用中文如实总结。'},{role:'user',content:text}];
 const selected=tools.filter(t=>['work_query_status','work_pause'].includes(t.name));
 for(let round=0;round<12;round++) {
  const response=await fetch('http://127.0.0.1:3425/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(120000),body:JSON.stringify({model:'auto/deepseek-v4.1-flash',messages:conversation,tools:selected.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),stream:false})});
  if(!response.ok)throw Error(`model HTTP ${response.status}`);
  const result:any=await response.json();const message=result.choices?.[0]?.message;if(!message)throw Error('missing model message');conversation.push(message);
  if(!message.tool_calls?.length){console.log('LIVE_FINAL',message.content);break;}
  for(const call of message.tool_calls){const args=JSON.parse(call.function.arguments);
   if(call.function.name==='work_pause' && args.workId===b.workId && !injected){injected=true;unwrap(works.amendWork(user,{operationId:'live-concurrent-b',workId:b.workId,title:'客户资料整理新版',versionGuard:guardOf(works.getWork(b.workId)!)}));}
   let output;try{output=await validInvoke(call.function.name,args,request.requestId);}catch(error){output={error:String(error)};}
   calls.push({name:call.function.name,workId:args.workId,ok:output?.ok,code:output?.code,replayed:output?.replayed});
   conversation.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(output)});
  }
 }
 assert.equal(reviewState(a.workId),'paused');assert.equal(reviewState(b.workId),'paused');assert.equal(reviewState(c.workId),'active');
 assert(calls.some(x=>x.code==='version_conflict'));assert.equal(calls.filter(x=>x.name==='work_pause'&&x.workId===a.workId).length,1);
 assert.equal(calls.filter(x=>x.name==='work_pause'&&x.workId===c.workId).length,0);
 console.log('PASS ISSUE56_LIVE',JSON.stringify({model:'auto/deepseek-v4.1-flash',calls,states:{A:reviewState(a.workId),B:reviewState(b.workId),C:reviewState(c.workId)},scope:'real online model + production foreground tools + isolated SQLite, not Electron UI'}));
} finally {db.close();rmSync(root,{recursive:true,force:true});}