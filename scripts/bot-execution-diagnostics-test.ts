import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {WorkService} from '../src/main/agent/work/WorkService';
import {BotConversationRepository} from '../src/main/agent/work/BotConversationRepository';
import {TaskDiagnosticsRepository} from '../src/main/agent/TaskDiagnosticsRepository';
import {CacheRequestTracer} from '../src/main/agent/CacheRequestTracer';
import {botExecutionDiagnostics} from '../src/main/agent/work/BotExecutionDiagnostics';
import {LOCAL_USER_ID} from '../src/shared/bot-work';
const root=mkdtempSync(join(tmpdir(),'bot-diagnostics-')); const db=new AppDatabase(join(root,'app.db'));
try {
 const bots=new BotRegistry(db.connection),bot=bots.ensureDefaultBot(LOCAL_USER_ID),other=bots.registerBot({botId:'other',userId:LOCAL_USER_ID,displayName:'other'});
 const works=new WorkService(db.connection,{bots}),messages=new BotConversationRepository(db.connection),repo=new TaskDiagnosticsRepository(db.connection);
 const a=messages.accept(LOCAL_USER_ID,{botId:bot.botId,requestId:'a',text:'first'});
 db.connection.prepare('UPDATE bot_conversations SET archived_at=1 WHERE conversation_id=?').run(a.conversationId);
 const b=messages.accept(LOCAL_USER_ID,{botId:bot.botId,requestId:'b',text:'second'});
 const c=messages.accept(LOCAL_USER_ID,{botId:other.botId,requestId:'c',text:'other'});
 const teamA=messages.accept(LOCAL_USER_ID,{botId:bot.botId,teamId:'team-a',requestId:'team-a',text:'team a'});
 const teamB=messages.accept(LOCAL_USER_ID,{botId:bot.botId,teamId:'team-b',requestId:'team-b',text:'team b'});
 const tracer=new CacheRequestTracer(()=>{}), model={provider:'test',id:'test',api:'test',cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 for(const [index,receipt] of [a,b,c,teamA,teamB].entries()) {
   const scope=`bot-foreground:${receipt.assistantMessageId}`;
   const trace=tracer.start(model,'fixture',undefined,event=>repo.observeTrace(event,model));
   trace.identify({executionScope:scope,conversationId:`native-${index}`,generationTaskId:10,sourceKind:'main'});
   if(index!==1) trace.providerEvent({usage:{prompt_tokens:100,completion_tokens:3,prompt_tokens_details:{cached_tokens:60}}});
   trace.result({stopReason:'stop',usage:{input:40,output:3,cacheRead:60,cacheWrite:0}});
   repo.observeTool({executionScope:scope,conversationId:`native-${index}`,toolTaskId:10,callId:'call',name:'read',sourceKind:'main',phase:'start',at:100});
   repo.observeTool({executionScope:scope,conversationId:`native-${index}`,toolTaskId:10,callId:'call',name:'read',sourceKind:'main',phase:'finish',at:130});
 }
 const read=(id:string)=>botExecutionDiagnostics(db.connection,LOCAL_USER_ID,{kind:'foreground',botId:bot.botId,conversationId:id},repo,works,bots);
 const first=read(a.conversationId); assert.equal(first.groups[0].value.requests.length,1); assert.equal(first.groups[0].value.requests[0].usage.cacheRead,60);assert.equal(first.groups[0].value.tools[0].activeMs,30);assert.equal(first.conversations.length,2);
 const second=read(b.conversationId);assert.equal(second.groups[0].value.requests[0].usage.cacheRead,null,'SDK normalized zeros do not invent raw cache');
 assert.throws(()=>read(c.conversationId),/不属于/);
 const team=botExecutionDiagnostics(db.connection,LOCAL_USER_ID,{kind:'foreground',botId:bot.botId,teamId:'team-a'},repo,works,bots);
 assert.equal(team.conversations.length,1);assert.equal(team.conversationId,teamA.conversationId);assert.equal(team.groups[0].value.requests.length,1);
 assert.throws(()=>botExecutionDiagnostics(db.connection,LOCAL_USER_ID,{kind:'foreground',botId:bot.botId,teamId:'team-a',conversationId:teamB.conversationId},repo,works,bots),/不属于/);
 assert.throws(()=>read(teamA.conversationId),/不属于/);
 assert.throws(()=>botExecutionDiagnostics(db.connection,'another-user',{kind:'foreground',botId:bot.botId},repo,works,bots),/不属于/);
 assert.throws(()=>botExecutionDiagnostics(db.connection,LOCAL_USER_ID,{kind:'work',workId:'unknown'},repo,works,bots),/不存在/);
 assert.equal(db.listTasks().length,0,'no fake Task created for foreground');
 console.log('PASS Bot diagnostic raw usage, unknowns, tools, new/old conversation and Bot/user isolation');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
