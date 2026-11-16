// Focused production-function + real SQLite contract. No Electron/LLM claim.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as helper from '../src/main/agent/work/BotDelegatedTaskProjection.ts';
import * as present from '../src/renderer/src/lib/botTaskReplyPresentation.ts';
import { botTaskTimeline } from '../src/renderer/src/lib/botWorkspacePresentation.ts';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function open() {
  const raw = new DatabaseSync(':memory:');
  const db = { prepare: sql => raw.prepare(sql), transaction: fn => () => {
    raw.exec('SAVEPOINT delegated_test');
    try { const value = fn(); raw.exec('RELEASE delegated_test'); return value; }
    catch (error) { raw.exec('ROLLBACK TO delegated_test; RELEASE delegated_test'); throw error; }
  }};
  raw.exec(`CREATE TABLE bot_conversations(conversation_id TEXT PRIMARY KEY,bot_id TEXT,user_id TEXT,team_id TEXT,revision INTEGER DEFAULT 0,updated_at INTEGER);
    CREATE TABLE works(work_id TEXT PRIMARY KEY,user_id TEXT,lifecycle TEXT);
    CREATE TABLE bot_messages(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT UNIQUE,conversation_id TEXT,bot_id TEXT,request_id TEXT,role TEXT,text TEXT,status TEXT,work_ids_json TEXT DEFAULT '[]',created_at INTEGER,updated_at INTEGER);
    CREATE INDEX conversation_request ON bot_messages(conversation_id,request_id);
    CREATE TABLE bot_send_receipts(user_id TEXT,bot_id TEXT,request_id TEXT,conversation_id TEXT,user_message_id TEXT,assistant_message_id TEXT);
    CREATE TABLE bot_collaborations(collaboration_id TEXT PRIMARY KEY,user_id TEXT,source_bot_id TEXT,source_conversation_id TEXT,target_bot_id TEXT,work_id TEXT,value_json TEXT);
    CREATE TABLE bot_collaboration_requests(collaboration_id TEXT,conversation_id TEXT,request_id TEXT,user_message_id TEXT,assistant_message_id TEXT);
    CREATE TABLE bot_peer_inputs(user_message_id TEXT,assistant_message_id TEXT,origin_json TEXT);
    CREATE TABLE bot_peer_deliveries(operation_id TEXT,user_id TEXT,target_bot_id TEXT,request_id TEXT,accepted_message_id TEXT,origin_json TEXT);
    CREATE TABLE bot_work_feedback(message_id TEXT PRIMARY KEY,metadata_json TEXT);`);
  for (const [id, bot, user] of [['source', 'a', 'u'], ['receiver', 'b', 'u'], ['other', 'a', 'u'], ['foreign', 'a', 'foreign']])
    db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id) VALUES(?,?,?)').run(id, bot, user);
  db.prepare("INSERT INTO works VALUES('w','u','closed')").run();
  function turn(id, conversation, bot, user='u') {
    for (const [suffix, role] of [['u','user'],['a','assistant']])
      db.prepare("INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES(?,?,?,?,?,'body','completed',1,1)").run(id+suffix, conversation, bot, id, role);
    db.prepare('INSERT INTO bot_send_receipts VALUES(?,?,?,?,?,?)').run(user, bot, id, conversation, id+'u', id+'a');
  }
  turn('original', 'source', 'a');
  const origin = { sourceBotId:'a', sourceConversationId:'source', sourceRequestId:'original', sourceUserMessageId:'originalu', sourceAssistantMessageId:'originala', collaborationId:'c' };
  db.prepare('INSERT INTO bot_collaborations VALUES(?,?,?,?,?,?,?)').run('c','u','a','source','b','w', JSON.stringify(origin));
  db.prepare('INSERT INTO bot_collaboration_requests VALUES(?,?,?,?,?)').run('c','source','original','originalu','originala');
  function peer(id, kind) {
    const bot = kind === 'request' ? 'b' : 'a', conversation = kind === 'request' ? 'receiver' : 'source';
    turn(id, conversation, bot);
    const value = JSON.stringify({...origin, kind, exchangeId:id, senderBotId: kind === 'request' ? 'a':'b', replyMessageId:id+'journal'});
    db.prepare('INSERT INTO bot_peer_inputs VALUES(?,?,?)').run(id+'u',id+'a',value);
    db.prepare('INSERT INTO bot_peer_deliveries VALUES(?,?,?,?,?,?)').run(id,'u',bot,id,id+'a',value);
  }
  peer('accepted', 'request');
  for(let n=0;n<4;n++) peer('return'+n, 'return');
  function feedback(id, extra={}) {
    const value = { workId:'w',eventId:id,kind:'binding',category:'progress',executionId:'execution',intentRevision:1,inputSnapshotId:'snapshot',...extra };
    db.prepare("INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES(?,'receiver','b',?,'assistant','PRIVATE_TOOL_LOG','completed',2,2)").run(id, 'raw-'+id);
    db.prepare('INSERT INTO bot_work_feedback VALUES(?,?)').run(id, JSON.stringify(value)); return value;
  }
  const parse = value => { assert(['binding','result','blocker','closure'].includes(value.kind)); assert.equal(typeof value.workId,'string'); return value; };
  const reconcile = () => helper.reconcileDelegatedFeedback(db,'u','source',parse);
  const sourceFeedback = () => db.prepare("SELECT m.*,f.metadata_json FROM bot_messages m JOIN bot_work_feedback f ON m.message_id=f.message_id WHERE m.conversation_id='source' ORDER BY m.ordinal").all();
  return {raw,db,turn,peer,feedback,parse,reconcile,sourceFeedback};
}
const f=open();
const ids=message=>helper.delegatedReplyWorkIds(f.db,'u',message);
check('source original reply, executor acceptance and four return turns share the same Work',()=>{
  for(const id of ['originala','accepteda', ...Array.from({length:4},(_,n)=>`return${n}a`)]) assert.deepEqual(ids(id),['w']);
});
check('user inputs and unrelated/foreign conversation cannot become task control targets',()=>{
  f.turn('unrelated','other','a'); f.turn('foreign','foreign','a','foreign');
  for(const id of ['originalu','acceptedu','return0u','unrelateda','foreigna']) assert.deepEqual(ids(id),[]);
  assert.deepEqual(helper.delegatedReplyWorkIds(f.db,'foreign','originala'),[]);
  assert.equal(f.db.prepare("SELECT work_ids_json FROM bot_messages WHERE message_id='originalu'").get().work_ids_json,'[]');
});
check('source responsibility queries linked to a collaboration do not become task replies',()=>{
  f.turn('responsibilities','source','a');
  f.db.prepare('INSERT INTO bot_collaboration_requests VALUES(?,?,?,?,?)').run('c','source','responsibilities','responsibilitiesu','responsibilitiesa');
  assert.deepEqual(ids('responsibilitiesa'),[]);
});
check('a forged return source/receipt cannot borrow another task',()=>{
  const prior=f.db.prepare("SELECT origin_json FROM bot_peer_inputs WHERE assistant_message_id='return0a'").get().origin_json;
  f.db.prepare("UPDATE bot_peer_inputs SET origin_json=? WHERE assistant_message_id='return0a'").run(prior.replace('originala','unrelateda'));
  assert.deepEqual(ids('return0a'),[]);
  f.db.prepare("UPDATE bot_peer_inputs SET origin_json=? WHERE assistant_message_id='return0a'").run(prior);
});
const report={title:'Python 学习计划',summary:'已完成学习计划。',artifactRefs:['/saved/plan.html'],files:[{ref:'/saved/plan.html',name:'plan.html',openPath:'/saved/plan.html',previewManifestPath:'/saved/plan.web.json'}],reviewStatus:'accepted',current:true,notices:[]};
const binding=f.feedback('binding'); const result=f.feedback('result',{kind:'result',category:'result',report});
check('two persisted execution feedbacks become two public source records without raw logs',()=>{
  assert.equal(f.reconcile(),2);const rows=f.sourceFeedback();assert.equal(rows.length,2);
  assert(rows.every(row=>!row.text.includes('PRIVATE_TOOL_LOG')));
  assert.deepEqual(JSON.parse(rows[1].metadata_json),result);
  assert.equal(f.db.prepare("SELECT text FROM bot_messages WHERE message_id='result'").get().text,'PRIVATE_TOOL_LOG');
});
check('reload, delivery retry and file metadata refresh preserve exact message identity',()=>{
  const before=f.sourceFeedback().map(row=>row.message_id);
  for(let i=0;i<5;i++) assert.equal(f.reconcile(),0);
  const upgraded={...result,report:{...report,files:[{...report.files[0],name:'年度计划.html'}]}};
  f.db.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id='result'").run(JSON.stringify(upgraded));
  assert.equal(f.reconcile(),1); assert.deepEqual(f.sourceFeedback().map(row=>row.message_id),before);
  f.db.prepare("UPDATE bot_work_feedback SET metadata_json=? WHERE message_id='result'").run(JSON.stringify(result));f.reconcile();
});
check('missing pre-fix projection is repaired on read, not by replaying business',()=>{
  const row=f.sourceFeedback()[0], receipts=f.db.prepare('SELECT COUNT(*) n FROM bot_send_receipts').get().n;
  f.db.prepare('DELETE FROM bot_work_feedback WHERE message_id=?').run(row.message_id);f.db.prepare('DELETE FROM bot_messages WHERE message_id=?').run(row.message_id);
  assert.equal(f.reconcile(),1); assert(f.sourceFeedback().some(item=>item.message_id===row.message_id));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM bot_send_receipts').get().n,receipts);
  assert.equal(f.db.prepare("SELECT lifecycle FROM works WHERE work_id='w'").get().lifecycle,'closed');
});
check('source deletion or another active conversation never redirects delivery',()=>{
  assert.equal(helper.reconcileDelegatedFeedback(f.db,'u','other',f.parse),0);
  assert.equal(helper.reconcileDelegatedFeedback(f.db,'foreign','source',f.parse),0);
  f.db.prepare("DELETE FROM bot_conversations WHERE conversation_id='source'").run(); assert.equal(f.reconcile(),0);
  f.db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id) VALUES('source','a','u')").run();
});
check('failure after message insertion rolls back the public record and revision',()=>{
  f.feedback('rollback');const before=f.sourceFeedback().length, rev=f.db.prepare("SELECT revision FROM bot_conversations WHERE conversation_id='source'").get().revision;
  f.raw.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON bot_work_feedback WHEN NEW.message_id LIKE 'work-feedback-%' BEGIN SELECT RAISE(ABORT,'injected projection failure'); END;");
  assert.throws(f.reconcile,/injected projection failure/); assert.equal(f.sourceFeedback().length,before);
  assert.equal(f.db.prepare("SELECT revision FROM bot_conversations WHERE conversation_id='source'").get().revision,rev);
  f.raw.exec('DROP TRIGGER fail_projection');assert.equal(f.reconcile(),1);
});
check('recovery batch is bounded to 100 and converges without duplicates',()=>{
  for(let i=0;i<103;i++) f.feedback('batch'+i);
  assert.equal(f.reconcile(),100);assert.equal(f.reconcile(),3);assert.equal(f.reconcile(),0);
});
const message=(id, extra={})=>({messageId:id,conversationId:'source',botId:'a',requestId:id,ordinal:1,role:'assistant',text:'answer',status:'completed',workIds:['w'],createdAt:1,updatedAt:1,...extra});
const fallback=message('public',{requestId:'delegated-feedback:result',workFeedback:result});
const returned=message('returned',{collaborationResult:result,peerOrigin:{kind:'return',sourceBotId:'a',sourceConversationId:'source',sourceAssistantMessageId:'original',sourceRequestId:'original'}});
check('source reply folds exactly one matching public fallback, preserving the full answer and files',()=>{
  const kept=present.botTaskReplyVisibleMessages([fallback,returned]);assert.deepEqual(kept,[returned]);assert.equal(kept[0].collaborationResult.report.files[0].openPath,'/saved/plan.html');
});
check('pending, failed, empty, receipt-only or wrong-scope return cannot hide the fallback',()=>{
  for(const change of [{status:'running'},{status:'failed',error:'failed'},{text:''},{text:'',segments:[{kind:'receipt',text:'received'}]},{conversationId:'other'},{botId:'b'}])
    assert.equal(present.botTaskReplyVisibleMessages([fallback,{...returned,...change}]).length,2);
});
check('different event versions, files and execution identities remain visible',()=>{
  for(const change of [{eventId:'other'},{executionId:'old'},{report:{...report,summary:'old'}},{report:{...report,files:[]}}])
    assert.equal(present.botTaskReplyVisibleMessages([fallback,{...returned,collaborationResult:{...result,...change}}]).length,2);
});
check('worker reports and ordinary feedback are not erased by source-only folding',()=>{
  assert.equal(present.botTaskReplyVisibleMessages([{...fallback,requestId:'ordinary-worker-feedback'},returned]).length,2);
});
const work={workId:'w',lifecycle:'closed',closureConclusion:'succeeded',intentRevision:1,inputSnapshotId:'snapshot',executions:[{bindingId:'execution',status:'completed',intentRevision:1,inputSnapshotId:'snapshot'}]};
check('exact accepted closed result and files enter Results, not an empty final stage',()=>{assert.equal(present.botTaskReplyMessageStage(result,work),'result');});
check('partial, rejected, stale, unbound, cancelled and needs-input remain non-final',()=>{
  for(const change of [{report:{...report,milestone:true}},{report:{...report,reviewStatus:'proposed'}},{intentRevision:2},{executionId:undefined},{report:{...report,completion:{outcome:'partial',nextStep:'ask'}}}])
    assert.notEqual(present.botTaskReplyMessageStage({...result,...change},work),'result');
  assert.equal(present.botTaskReplyMessageStage(result,{...work,closureConclusion:'cancelled'}),'review');
});
check('four source returns and two progress records use the original task container',()=>{
  const original=message('original');const updates=Array.from({length:4},(_,i)=>message('r'+i,{ordinal:i+2,workIds:ids(`return${i}a`)}));
  const rows=botTaskTimeline([original,...updates,{...fallback,ordinal:6},message('binding',{workFeedback:binding,ordinal:7})]);
  assert.equal(rows.length,1);assert.equal(rows[0].message.messageId,'original');assert.equal(rows[0].tasks[0].messages.length,7);
});
check('executor has its own original task frame, and parallel tasks do not cross',()=>{
  const accept=message('accept',{botId:'b',conversationId:'receiver',workIds:ids('accepteda')});
  const raw=message('raw',{botId:'b',conversationId:'receiver',ordinal:2,workFeedback:result});
  const unrelated=message('other-work',{workIds:['other-work'],ordinal:2});
  const rows=botTaskTimeline([message('original'),unrelated,accept,raw,returned]);
  assert.equal(rows.length,3);assert.equal(rows.find(row=>row.message===accept).tasks[0].messages.length,2);
  assert.equal(rows.find(row=>row.message===unrelated).tasks[0].messages.length,1);
});
f.raw.close();console.log(`PASS ${passed} delegated task projection contracts (SQLite + production functions; not Electron)`);
