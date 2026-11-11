import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { botInboxId } from '../src/main/agent/work/WorkDeliveryTargets';
import type { BotHistoryRequest, BotHistoryDto } from '../src/shared/bot-conversation';
const correctnessOnly=process.argv.includes('--correctness-only');
// Exact pre-optimization history implementation, retained as a differential oracle.
function baseline(repo: BotConversationRepository, userId: string, request: BotHistoryRequest): BotHistoryDto {
 const conversation=repo.conversation(userId,request.botId,request.inbox?botInboxId(userId,request.botId):request.conversationId,request.teamId);
 repo.assertScope(conversation,request.teamId);
 if(!conversation)return {conversationId:'',botId:request.botId,teamId:request.teamId,revision:0,archived:false,messages:[]};
 const rows=repo.db.prepare(`SELECT m.* FROM bot_messages m JOIN bot_conversations c ON c.conversation_id=m.conversation_id
 WHERE c.user_id=? AND (m.conversation_id=? OR (m.conversation_id LIKE 'bot-inbox-%' AND EXISTS (
 SELECT 1 FROM bot_work_feedback f JOIN work_conversations t ON t.work_id=json_extract(f.metadata_json,'$.workId')
 WHERE f.message_id=m.message_id AND t.channel_type='bot-delivery' AND t.conversation_id=?)))
 AND m.ordinal<? AND m.ordinal>? ${request.messageIds?'AND m.message_id IN (SELECT value FROM json_each(?))':''}
 ORDER BY m.ordinal ${request.after===undefined?'DESC':'ASC'} LIMIT 101`).all(userId,conversation.conversation_id,conversation.conversation_id,request.before??Number.MAX_SAFE_INTEGER,request.after??0,...(request.messageIds?[JSON.stringify(request.messageIds)]:[]));
 const messages=rows.slice(0,100).map(row=>(repo as any).mapMessage(row));
 if(request.after===undefined)messages.reverse();
 return {conversationId:conversation.conversation_id,botId:request.botId,teamId:request.teamId,revision:conversation.revision,archived:conversation.archived_at!==null,messages,before:!request.messageIds&&(request.after!==undefined||rows.length>100)?messages[0]?.ordinal:undefined};
}
const app=new AppDatabase(':memory:'), db=app.connection, bots=new BotRegistry(db);
for(const [botId,userId] of [['personal','user'],['teammate','user'],['foreign','other']])bots.registerBot({botId,userId,displayName:botId});
const schemaBefore=db.pragma('user_version',{simple:true});
const repo=new BotConversationRepository(db);
assert.equal(db.pragma('user_version',{simple:true}),schemaBefore,'additive index must not change schema version');
assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bot_messages_conversation_ordinal'").get());
const inbox=botInboxId('user','personal');
const addConv=db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id,team_id,created_at,updated_at,archived_at) VALUES (?,?,?,?,1,1,1)');
for(const [id,bot,user,team] of [['old','personal','user',null],['new','personal','user',null],['team','teammate','user','team-id'],[inbox,'personal','user',null],['bot-inbox-foreign','foreign','other',null]])addConv.run(id,bot,user,team);
const insert=db.prepare("INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,'assistant',?,'completed',?,?)");
let sequence=0;
function msg(conv:string,bot='personal'){const i=++sequence;insert.run(`msg-${i}`,conv,bot,`request-${i}`,'Synthetic history payload. '.repeat(16),i,i);return `msg-${i}`;}
function feedback(id:string,work='linked'){db.prepare('INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)').run(id,JSON.stringify({workId:work}));}
const link=db.prepare("INSERT INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES (?,?,'bot-delivery',1)");
for(const conv of ['old','team',inbox])link.run('linked',conv);
link.run('unrelated','new');
let same:string,foreign:string;
db.transaction(()=>{
 for(let i=0;i<220;i++)msg('old');
 for(let i=0;i<140;i++)msg('team','teammate');
 for(let i=0;i<130;i++)feedback(msg(inbox));
 same=msg(inbox);feedback(same);
 foreign=msg('bot-inbox-foreign','foreign');feedback(foreign);
 for(let i=0;i<40;i++)feedback(msg(inbox),'unrelated');
})();
let assertions=0;
function parity(request:BotHistoryRequest,user='user'){
 const expected=baseline(repo,user,request), actual=repo.history(user,request);assert.deepEqual(actual,expected);assert.equal(new Set(actual.messages.map(x=>x.messageId)).size,actual.messages.length);assert(!actual.messages.some(x=>x.messageId===foreign));assertions++;return actual;
}
const scopes:BotHistoryRequest[]=[{botId:'personal',conversationId:'old'},{botId:'teammate',conversationId:'team',teamId:'team-id'},{botId:'personal',inbox:true},{botId:'personal',conversationId:inbox}];
for(const scope of scopes){
 for(const before of [undefined,1,160,400,sequence+1])for(const after of [undefined,0,150,380,sequence])parity({...scope,before,after});
 for(const messageIds of [[],['msg-1',same!,foreign!],Array.from({length:300},(_,i)=>`msg-${i+1}`)])for(const after of [undefined,0,350])parity({...scope,messageIds,after});
 const seen=new Set<string>();let before: number|undefined;
 for(let i=0;i<10;i++){const page=parity({...scope,before});for(const m of page.messages){assert(!seen.has(m.messageId));seen.add(m.messageId);}if(!page.before)break;before=page.before;}
}
assert.equal(parity({botId:'personal',conversationId:'old'},'other').messages.length,0);
assert.equal(parity({botId:'foreign',conversationId:'old'}).messages.length,0);
assert.throws(()=>repo.history('user',{botId:'teammate',conversationId:'team'}));
assert.throws(()=>repo.history('user',{botId:'personal',conversationId:'old',teamId:'team-id'}));
// Inbox-local feedback already in the first branch must not be duplicated.
assert.equal(parity({botId:'personal',inbox:true,messageIds:[same!]}).messages.length,1);
function measure(fn:()=>unknown){for(let i=0;i<2;i++)fn();const samples:number[]=[];for(let i=0;i<15;i++){const start=performance.now();fn();samples.push(performance.now()-start)}samples.sort((a,b)=>a-b);return {medianMs:samples[7],p95Ms:samples[14]};}
const results:any[]=[];
function bench(label:string,conversationId='old',extra:Partial<BotHistoryRequest>={}){const req={botId:'personal',conversationId,...extra};parity(req);if(correctnessOnly)return;const old=measure(()=>baseline(repo,'user',req)),optimized=measure(()=>repo.history('user',req));results.push({label,rows:sequence,feedbackRows:db.prepare('SELECT count(*) AS n FROM bot_work_feedback').get(),old,optimized});}
bench('mixed-small');
db.transaction(()=>{while(sequence<(correctnessOnly?800:50000))msg('new')})();bench('50k-messages-sparse-feedback');
db.transaction(()=>{for(let i=0;i<(correctnessOnly?200:10000);i++)feedback(msg(inbox),i%2?'linked':'unrelated')})();bench('60k-messages-10k-feedback');
for(const req of scopes){parity(req);parity({...req,after:400});parity({...req,before:400});parity({...req,messageIds:['msg-1',same!,foreign!]});}
const beforeExtraInboxes=sequence;
// Many same-user inboxes, including another Bot's inbox, remain valid sources.
db.transaction(()=>{for(let i=0;i<100;i++){
 const id=`bot-inbox-many-${i}`;addConv.run(id,'teammate','user',null);
 for(let j=0;j<3;j++)feedback(msg(id,'teammate'),j%2?'unrelated':'linked');
}})();
bench('60k-messages-100-extra-inboxes');
for(const req of scopes){parity(req);parity({...req,after:59000});parity({...req,before:60100});}
const crossBot=parity({botId:'personal',conversationId:'old',after:beforeExtraInboxes});
assert(crossBot.messages.some(m=>m.botId==='teammate'),'linked feedback from other Bots must remain visible');
addConv.run('rare-target','personal','user',null);addConv.run('empty-target','personal','user',null);
link.run('rare-link','rare-target');
db.transaction(()=>{for(let i=0;i<10;i++)feedback(msg(inbox),'rare-link')})();
bench('dense-inbox-only-10-related','rare-target');bench('dense-inbox-zero-related','empty-target');
parity({botId:'personal',conversationId:'rare-target',after:60000});
parity({botId:'personal',conversationId:'rare-target',before:60305});
const beforeDirect=sequence;
// Full direct page must prune irrelevant inbox ranges in both directions.
db.transaction(()=>{for(let i=0;i<120;i++)msg('old')})();
bench('latest-101-direct-old-dense-inboxes');
bench('earliest-101-direct-later-dense-inboxes','old',{after:0});
for(const after of [undefined,0,60000])for(const before of [undefined,200,60350])parity({botId:'personal',conversationId:'old',after,before});
// Verify real public-size explicit IDs across sources and both cursor bounds.
const legalIds=(db.prepare("SELECT message_id FROM bot_messages WHERE conversation_id='old' LIMIT 50").all() as {message_id:string}[])
 .concat(db.prepare("SELECT message_id FROM bot_messages WHERE conversation_id LIKE 'bot-inbox-%' AND bot_id='personal' LIMIT 50").all() as {message_id:string}[]).map(x=>x.message_id);
assert.equal(legalIds.length,100);
for(const after of [undefined,0,20])for(const before of [undefined,sequence,60000])parity({botId:'personal',conversationId:'old',messageIds:legalIds,after,before});
db.prepare("UPDATE bot_conversations SET archived_at=NULL WHERE conversation_id IN ('old','team')").run();
parity({botId:'personal'});parity({botId:'teammate',teamId:'team-id'});
parity({botId:'personal',teamId:'team-id'}); // Current team Bot differs from original message/conversation Bot.
parity({botId:'personal',conversationId:'team',teamId:'team-id'});
// Capture actual linked query bindings and prove the full-page pruning is an
// indexed ordinal range, not a timing-only assertion.
const prepare=db.prepare.bind(db), bounds:any[]=[];
(db as any).prepare=(sql:string)=>{const statement=prepare(sql);if(sql.includes('SELECT m.* FROM bot_messages m WHERE')&&sql.includes('AND EXISTS')){
 const all=statement.all.bind(statement);(statement as any).all=(params:any)=>{bounds.push({sql,params});return all(params);};}return statement;};
try {repo.history('user',{botId:'personal',conversationId:'old'});repo.history('user',{botId:'personal',conversationId:'old',after:0});}
finally {(db as any).prepare=prepare;}
assert(bounds.some(b=>b.params.after>beforeDirect),'DESC must skip older inbox ranges');
assert(bounds.some(b=>b.params.before<=101),'ASC must skip later inbox ranges');
for(const item of bounds){const plan=prepare('EXPLAIN QUERY PLAN '+item.sql).all(item.params) as {detail:string}[];
 assert(plan.some(row=>row.detail.includes('idx_bot_messages_conversation_ordinal')&&row.detail.includes('ordinal>')&&row.detail.includes('ordinal<')),'indexed bounded source range required');}
const schemaAtReopen=db.pragma('user_version',{simple:true});db.exec('DROP INDEX idx_bot_messages_conversation_ordinal');
const indexStart=performance.now();new BotConversationRepository(db);const firstIndexBuildMs=performance.now()-indexStart;
assert.equal(db.pragma('user_version',{simple:true}),schemaAtReopen);
if(!correctnessOnly){
 results.push({label:'first-constructor-index-build',rows:sequence,firstIndexBuildMs});
 db.exec('DROP INDEX idx_bot_messages_conversation_ordinal');
 const diskPath=join(process.env.HOME!,'history-first-index.sqlite');
 db.prepare('VACUUM INTO ?').run(diskPath);
 const diskApp=new AppDatabase(diskPath);
 const start=performance.now();new BotConversationRepository(diskApp.connection);
 const firstDiskIndexBuildMs=performance.now()-start;
 assert.equal(diskApp.connection.pragma('user_version',{simple:true}),schemaAtReopen);diskApp.close();
 results.push({label:'first-constructor-disk-index-build',rows:sequence,firstDiskIndexBuildMs});
 new BotConversationRepository(db);
}
db.exec('DELETE FROM bot_work_feedback');bench('60k-messages-no-feedback');
console.log(JSON.stringify({assertions,results},null,2));
writeFileSync(`out/diagnostics/performance-step5/db-growth-perf-history-${correctnessOnly?'correctness':'api'}.json`,JSON.stringify({assertions,results},null,2));
app.close();
