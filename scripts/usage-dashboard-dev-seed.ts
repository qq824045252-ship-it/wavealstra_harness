import { UsageStatsService } from '../src/main/usage/UsageStatsService';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
const home=resolve(process.env.HOME!);assert.equal(home,resolve(process.env.USAGE_DASHBOARD_TEST_HOME!));assert(basename(home).startsWith('udg-'));
const dir=join(home,'.mybuddy');mkdirSync(dir,{recursive:true});
const app=new AppDatabase(join(dir,'app.db'));
try{
 const db=app.connection;new UsageStatsService(db);assert.equal((db.prepare('SELECT count(*) AS n FROM usage_events').get() as {n:number}).n,0);
 const now=Date.now(),today=new Date();today.setHours(0,0,0,0);
 const legacy=join(home,'legacy-skills.jsonl');
 writeFileSync(legacy,Array.from({length:8},(_,i)=>JSON.stringify({type:'message',timestamp:'2020-01-01T00:00:00Z',message:{role:'user',content:'/skill-'+i+'\nsynthetic historic request'}})).join('\n'));
 const insert=db.prepare('INSERT INTO usage_events(entry_id,task_id,session_file,source_kind,source_detail,provider,model,ts,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_total,stop_reason,ttft_ms,decode_ms,generation_tps,model_wall_ms,turn_index,user_turn,reasoning_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 const coverage=db.prepare('INSERT INTO usage_event_coverage VALUES(?,?,?,?,?,?)');
 db.transaction(()=>{for(let i=0;i<10000;i++){
  const age=i===3?0:i%20===0?0:i%20===1?450:i%20===2?-2:1+(i%370), ts=age===0?today.getTime()+1000+i:now-age*86400000;
  const zero=i%8<2,tokens=zero?0:100+i%100,id='udg-'+i;
  insert.run(id,'udg-task-'+Math.floor(i/20),i===0?legacy:'durable:udg-'+Math.floor(i/20),i===3?'main':['main','btw','subagent','compaction','toolresult','auxiliary'][i%6],'pi-durable','fixture','model-'+i%8,ts,tokens,tokens,tokens,tokens,tokens*4,zero?0:0.003,'stop',300,1000,100,1300,i%20,Math.floor(i%20/2),null);
  if(i===3){coverage.run(id,0,1,1,1,1);}else if(i%4!==3){const known=i%8===0?0:1;coverage.run(id,known,known,known,known,known);}
 }})();
 db.pragma('wal_checkpoint(TRUNCATE)');
 writeFileSync(join(home,'fixture.json'),JSON.stringify({now,rows:10000,legacy,oldRows:true,futureRows:true,zeroKnownAndUnknown:true},null,2));
}finally{app.close();}
