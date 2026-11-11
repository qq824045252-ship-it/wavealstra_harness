import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { WorkService } from '../src/main/agent/work/WorkService';
import { WorkListQuery } from '../src/main/agent/work/WorkListQuery';
import { LOCAL_USER_ID, DEFAULT_BOT_ID } from '../src/shared/bot-work';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const out=join(process.cwd(),'out/diagnostics/performance-step5'); mkdirSync(out,{recursive:true});
const results:any[]=[];
function timing(fn:()=>unknown, n=15){fn(); const a:number[]=[]; for(let i=0;i<n;i++){let t=performance.now();fn();a.push(performance.now()-t)} a.sort((a,b)=>a-b);return {medianMs:a[Math.floor(n/2)],p95Ms:a[Math.floor(n*.95)]};}
for(const n of [1000,10000,50000]){
 const path=join(process.env.HOME!,`db-growth-${n}.sqlite`), app=new AppDatabase(path), db=app.connection;
 const bots=new BotRegistry(db); bots.ensureDefaultBot(LOCAL_USER_ID); new WorkService(db,{bots});
 const repo=new BotConversationRepository(db); const query=new WorkListQuery(db);
 const conv=db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?)');
 conv.run('old-target',DEFAULT_BOT_ID,LOCAL_USER_ID,1,1,1);conv.run('new-other',DEFAULT_BOT_ID,LOCAL_USER_ID,2,2,null); conv.run('bot-inbox-fixture',DEFAULT_BOT_ID,LOCAL_USER_ID,3,3,3);
 const insert=db.prepare("INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,? ,?,'completed',?,?)");
 db.transaction(()=>{for(let i=0;i<n;i++)insert.run(`msg-${i}`,i<100?'old-target':i>=n-10?'bot-inbox-fixture':'new-other',DEFAULT_BOT_ID,`req-${i}`,i>=n-10?'assistant':'user','Synthetic bot history message. '.repeat(16),i+1,i+1)})();
 db.prepare("INSERT INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES ('fixture-work','old-target','bot-delivery',1)").run();
 db.transaction(()=>{for(let i=n-10;i<n;i++)db.prepare("INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)").run(`msg-${i}`,JSON.stringify({workId:'fixture-work'}))})();
 const historyOldConversation=timing(()=>repo.history(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,conversationId:'old-target'}));
 const historyRecentConversation=timing(()=>repo.history(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,conversationId:'new-other'}));
 db.pragma('wal_checkpoint(TRUNCATE)');const messageBytes=statSync(path).size;
 const work=db.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at) VALUES (?,?,?,?,'[]','fixture','snapshot:unbound','user',?,?)`);
 db.transaction(()=>{for(let i=0;i<n;i++)work.run(`work-${i}`,LOCAL_USER_ID,DEFAULT_BOT_ID,`Synthetic work ${i}`,i+1,i+1)})();
 const req={scope:{kind:'all'},view:'all'};
 const warm=timing(()=>query.query(LOCAL_USER_ID,req));
 const cold=timing(()=>db.transaction(()=>query.query(LOCAL_USER_ID,req))(),7);
 const search=timing(()=>db.transaction(()=>query.query(LOCAL_USER_ID,{...req,query:'Synthetic'}))(),5);
 db.pragma('wal_checkpoint(TRUNCATE)');
 const row={n,messageBytes,withWorksBytes:statSync(path).size,historyOldConversation,historyRecentConversation,
   summaryCached:warm,summaryUncached:cold,summarySearch:search};
 results.push(row);console.log(JSON.stringify(row));app.close();
}
writeFileSync(join(out,'db-growth-perf-results.json'),JSON.stringify({gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 sourceWorkingChanges:execFileSync('git',['diff','--name-only','--','src/main/agent/work/BotConversationRepository.ts','src/main/agent/work/WorkListQuery.ts','src/main/db'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),
 node:process.version,synthetic:true,results},null,2));
