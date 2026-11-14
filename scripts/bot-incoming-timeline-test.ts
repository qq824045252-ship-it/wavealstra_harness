import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BotCollaborationRepository} from '../src/main/agent/work/BotCollaborationRepository';
import {mergeBotTimeline,groupBotTimeline} from '../src/renderer/src/lib/botMergedTimeline';
const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE bots(bot_id TEXT,user_id TEXT);INSERT INTO bots VALUES ('a','u'),('b','u'),('other','u'),('foreign','v');");
const repo=new BotCollaborationRepository(db as any);
(repo as any).required=(_u:string,id:string)=>({collaborationId:id,sourceBotId:'a',sourceDisplayName:'A'});
db.exec("CREATE TABLE bot_messages(message_id TEXT,request_id TEXT,bot_id TEXT,conversation_id TEXT,role TEXT,text TEXT,status TEXT);CREATE TABLE bot_work_feedback(message_id TEXT,metadata_json TEXT);CREATE TABLE bot_conversations(conversation_id TEXT,user_id TEXT);CREATE TABLE bot_peer_deliveries(user_id TEXT,journal_message_id TEXT,accepted_message_id TEXT,origin_json TEXT);");
const relation=(id:string,user='u',target='b')=>db.prepare('INSERT INTO bot_collaborations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,user,'a','conv',target,id,id,'{}',null,1,1,'returned','{}',0);
relation('ocean');relation('forest');relation('foreign','v');relation('other','u','other');
let seq=0; function add(id:string,relation:string,time:number,kind='reply') {let v={messageId:id,collaborationId:relation,ordinal:++seq,senderBotId:'b',senderDisplayName:'Bot',kind,text:'original '+id,createdAt:time,operationId:id};db.prepare('INSERT INTO bot_collaboration_messages VALUES (?,?,?,?,?,?)').run(id,relation,id,seq,id,JSON.stringify(v));}
add('ocean-1','ocean',10,'request');add('ocean-2','ocean',20);add('forest-1','forest',30);add('ocean-3','ocean',40);add('forest-2','forest',40);add('foreign-msg','foreign',50);add('other-msg','other',50);
const latest=repo.incomingMessages('u',{botId:'b',limit:2});assert.deepEqual(latest.items.map(x=>x.message.messageId),['ocean-3','forest-2']);
let all=[...latest.items],cursor=latest.nextCursor;while(cursor){const page=repo.incomingMessages('u',{botId:'b',limit:2,before:cursor});all=[...page.items,...all];cursor=page.nextCursor;}
assert.deepEqual(all.map(x=>x.message.messageId),['ocean-1','ocean-2','forest-1','ocean-3','forest-2']);assert.equal(new Set(all.map(x=>x.message.messageId)).size,5);
for(let i=0;i<7;i++)add('new-'+i,'forest',50+i);let edge=latest.items.at(-1)!.cursor,received:string[]=[];for(let i=0;i<4;i++){const page=repo.incomingMessages('u',{botId:'b',after:edge,limit:2});received.push(...page.items.map(x=>x.message.messageId));edge=page.items.at(-1)?.cursor??edge;}assert.equal(received.length,7);
assert.throws(()=>repo.incomingMessages('u',{botId:'other',before:latest.items[0].cursor}));assert.throws(()=>repo.incomingMessages('v',{botId:'b'}));
const personal=[{key:'p',createdAt:25,ordinal:2,value:'personal'}];const incoming=all.map(x=>({collaborationId:x.message.messageId,createdAt:x.message.createdAt}));const merged=mergeBotTimeline(personal,incoming);assert.deepEqual(merged.map(x=>x.key),['collaboration:ocean-1','collaboration:ocean-2','message:p','collaboration:forest-1','collaboration:forest-2','collaboration:ocean-3']);assert.deepEqual(mergeBotTimeline(personal,[...incoming].reverse()),merged);assert.equal(all[0].message.text,'original ocean-1');
console.log('PASS incoming all-message paging, interleaving, equal-time ties, catch-up, isolation, cursor scope, original preservation');

add('aaa-late-same-time','ocean',56);add('aaa-backdated','ocean',1);const late=repo.incomingMessages('u',{botId:'b',after:edge,limit:10});assert.deepEqual(late.items.map(x=>x.message.messageId),['aaa-late-same-time','aaa-backdated']);console.log('PASS persisted insert watermark catches same-time smaller ID and clock rollback/backfill');

const progress=mergeBotTimeline([{key:'p1',createdAt:10,ordinal:1,value:'p1',foldKey:'conv'},{key:'p2',createdAt:30,ordinal:2,value:'p2',foldKey:'conv'},{key:'p3',createdAt:31,ordinal:3,value:'p3',foldKey:'conv'}],[{collaborationId:'c',createdAt:20}]);assert.deepEqual(groupBotTimeline(progress).map(g=>g.map(r=>r.key)),[['message:p1'],['collaboration:c'],['message:p2','message:p3']]);console.log('PASS progress folds do not cross peer message boundaries');

db.prepare("DELETE FROM bots WHERE bot_id='a'").run();assert.equal(repo.incomingMessages('u',{botId:'b'}).items.length,0);assert.equal(repo.incomingMessages('u',{botId:'b',before:latest.items[0].cursor}).items.length,0);assert.equal(repo.incomingMessages('u',{botId:'b',after:edge}).items.length,0);assert.equal(db.prepare('SELECT count(*) n FROM bot_collaboration_messages').get()!.n,16);console.log('PASS deleted participant hidden without deleting messages');

// Exact durable Work projection identity, not text or mutable report metadata.
const {createHash}=await import('node:crypto');
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
db.exec("INSERT INTO bots VALUES ('a','u'); ");
db.exec("INSERT INTO bot_conversations VALUES ('own','u'),('foreign','v');");
const feedback={workId:'w',eventId:'event',kind:'result',category:'result'};
const version='a'.repeat(64),otherVersion='b'.repeat(64),operation='work-feedback:event';
const wm={messageId:'work-result',collaborationId:'ocean',ordinal:++seq,senderBotId:'b',senderDisplayName:'B',kind:'result',text:'unchanged text',createdAt:70,operationId:operation,workFeedback:feedback};
db.prepare('INSERT INTO bot_collaboration_messages VALUES (?,?,?,?,?,?)').run(wm.messageId,'ocean',digest([operation,'result',version]),seq,'hash',JSON.stringify(wm));
for(const [id,ver,conv] of [['exact',version,'own'],['different-version',otherVersion,'own'],['other-user',version,'foreign']]){db.prepare('INSERT INTO bot_messages(message_id,request_id,bot_id,conversation_id,role) VALUES (?,?,?,?,?)').run(id,'work-feedback:'+('c'.repeat(64))+':'+ver,'b',conv,'assistant');db.prepare('INSERT INTO bot_work_feedback VALUES (?,?)').run(id,JSON.stringify(feedback));}
assert.deepEqual(repo.incomingMessages('u',{botId:'b',limit:1}).items[0].foregroundMessageIds,['exact']);
console.log('PASS duplicate Work projection uses exact version and authenticated conversation scope');

const {unrepresentedIncomingMessages}=await import('../src/renderer/src/lib/botMergedTimeline');
const rowsForDedup=[{message:{collaborationId:'c',operationId:'e:reply'},foregroundMessageIds:[]},{message:{collaborationId:'c',operationId:'work'},foregroundMessageIds:['exact']},{message:{collaborationId:'other',operationId:'e:reply'},foregroundMessageIds:[]}];
assert.equal(unrepresentedIncomingMessages(rowsForDedup,new Set(),[]).length,3);
assert.deepEqual(unrepresentedIncomingMessages(rowsForDedup,new Set(['exact']),[{collaborationId:'c',exchangeId:'e'}]),[rowsForDedup[2]]);
console.log('PASS visible-only reply and Work identity dedup, unrelated collaboration retained');

// Reuse the persisted foreground return for each exact journal message, never truncate raw text into a summary.
function summary(id:string,journal:string,user='u',reply=journal){
 db.prepare('INSERT INTO bot_messages(message_id,bot_id,role,text,status) VALUES (?,?,?,?,?)').run(id,'a','assistant','concise '+id,'running');
 db.prepare('INSERT INTO bot_peer_deliveries VALUES (?,?,?,?)').run(user,journal,id,JSON.stringify({kind:'return',collaborationId:'ocean',replyMessageId:reply}));
}
summary('summary-one','ocean-2');summary('wrong-identity','ocean-2','u','another-message');summary('foreign-summary','ocean-2','v');
let refreshed=repo.incomingMessages('u',{botId:'b',refreshIds:['ocean-2','foreign-msg']});
assert.equal(refreshed.items.length,1);assert.equal(refreshed.items[0].summary?.text,'concise summary-one');assert.equal(refreshed.items[0].summary?.status,'running');
db.prepare("UPDATE bot_messages SET status='completed',text='Finished concise result' WHERE message_id='summary-one'").run();
refreshed=repo.incomingMessages('u',{botId:'b',refreshIds:['ocean-2']});assert.equal(refreshed.items[0].summary?.status,'completed');assert.equal(refreshed.items[0].summary?.text,'Finished concise result');assert.equal(refreshed.items[0].message.text,'original ocean-2');
assert.throws(()=>repo.incomingMessages('u',{botId:'b',refreshIds:['ocean-2'],after:edge}));
console.log('PASS exact per-message foreground summary, user scope, in-place completion refresh and original retained');
