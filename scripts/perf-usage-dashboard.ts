/** Isolated on-disk real-schema benchmark. No user profile or product mutations. */
import { AppDatabase } from '../src/main/db/AppDatabase';
import { UsageStatsService } from '../src/main/usage/UsageStatsService';
import { rangeStartMs } from '../src/shared/usage-stats';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, statSync } from 'node:fs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root=process.env.HOME!, n=Number(process.argv[2]||10000), output=process.argv[3], samples=Number(process.env.SAMPLES||5);
const now=Date.parse('2026-11-11T12:00:00Z'); Date.now=()=>now;
const app=new AppDatabase(join(root,'usage.db')), db=app.connection, service=new UsageStatsService(db);
const insert=db.prepare(`INSERT INTO usage_events(entry_id,task_id,session_file,source_kind,source_detail,provider,model,ts,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_total,stop_reason,ttft_ms,decode_ms,generation_tps,model_wall_ms,turn_index,user_turn,reasoning_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const coverage=db.prepare('INSERT INTO usage_event_coverage VALUES(?,?,?,?,?,?)');
db.transaction(()=>{for(let i=0;i<n;i++){
  const age=i%20===0?0:i%20===1?400+(i%50):1+(i%370), zero=i%7===0, id=`event-${i}`, tokens=zero?0:100;
  insert.run(id,`task-${Math.floor(i/20)}`,`durable:synthetic-session-${Math.floor(i/20)}`,['main','btw','subagent','compaction','toolresult','auxiliary'][i%6],'pi-durable',`provider-${i%3}`,`model-${i%8}`,now-age*86400000-(i%1000),tokens,tokens,tokens,tokens,tokens*4,zero?0:0.003,i%17===0?'error':'stop',i%9===0?null:300,1000,i%9===0?null:100,1300,i%20,Math.floor(i%20/2),i%5===0?null:10);
  if(i%4!==0){const known=zero&&i%2===0?0:1;coverage.run(id,known,known,known,known,known);}
}})();
db.pragma('wal_checkpoint(TRUNCATE)');
const summarize=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return {p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],min:a[0],max:a.at(-1)};};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function measure<T>(fn:()=>T){
  await new Promise(r=>setTimeout(r,5));
  const before=process.memoryUsage(),cpu=process.cpuUsage(),start=performance.now();
  let timerLag=0;const timer=new Promise<void>(r=>setTimeout(()=>{timerLag=performance.now()-start;r();},0));
  const value=fn(),wallMs=performance.now()-start, used=process.cpuUsage(cpu),after=process.memoryUsage();
  await timer;
  return {value,wallMs,processCpuMs:(used.user+used.system)/1000,timerLagMs:timerLag,heapDeltaMiB:(after.heapUsed-before.heapUsed)/1048576,heapAfterMiB:after.heapUsed/1048576,rssAfterMiB:after.rss/1048576};
}
const results:any[]=[];
async function runCase(rangeDays:number,label:string){
  const first=await measure(()=>service.dashboard(rangeDays)), reference=digest(first.value);
  const warm:typeof first[]=[];for(let i=0;i<samples;i++){const x=await measure(()=>service.dashboard(rangeDays));assert.equal(digest(x.value),reference);warm.push(x);}
  const diagnostics:any[]=[];const originalQuery=service.queryRows.bind(service), originalSkill=(service as any).skillUsageForRows.bind(service), originalPrepare=db.prepare.bind(db);
  let trace:any;
  const originalExists=fs.existsSync,originalRead=fs.readFileSync;
  fs.existsSync=((...args:any[])=>{const t=performance.now();try{return (originalExists as any)(...args);}finally{trace.existsMs+=performance.now()-t;trace.existsCalls++;}}) as any;
  fs.readFileSync=((...args:any[])=>{const t=performance.now();try{return (originalRead as any)(...args);}finally{trace.readMs+=performance.now()-t;trace.readCalls++;}}) as any;
  (db as any).prepare=(sql:string)=>{const stmt=originalPrepare(sql);if(!/SELECT[\s\S]*FROM usage_events/i.test(sql))return stmt;const all=stmt.all.bind(stmt);stmt.all=(...args:any[])=>{const t=performance.now(),rows=all(...args);trace.sql.push({ms:performance.now()-t,rows:rows.length});return rows;};return stmt;};
  service.queryRows=(opts)=>{const t=performance.now(),rows=originalQuery(opts);trace.queries.push({since:opts.since,rows:rows.length,ms:performance.now()-t});return rows;};
  (service as any).skillUsageForRows=(rows:any[])=>{const t=performance.now(),result=originalSkill(rows);trace.skillMs=performance.now()-t;return result;};
  for(let i=0;i<Number(process.env.DIAGNOSTICS??3);i++){trace={queries:[],sql:[],skillMs:0,existsMs:0,existsCalls:0,readMs:0,readCalls:0};const x=await measure(()=>service.dashboard(rangeDays));assert.equal(digest(x.value),reference);diagnostics.push({...trace,wallMs:x.wallMs,jsOutsideQueryAndSkillsMs:x.wallMs-trace.skillMs-trace.queries.reduce((s:number,q:any)=>s+q.ms,0)});}
  fs.existsSync=originalExists;fs.readFileSync=originalRead;
  service.queryRows=originalQuery;(service as any).skillUsageForRows=originalSkill;(db as any).prepare=originalPrepare;
  const fields=['wallMs','processCpuMs','timerLagMs','heapDeltaMiB','heapAfterMiB','rssAfterMiB'];
  const result={n,label,rangeDays,digest:reference,dto:first.value,summary:{days:first.value.days.length,calls:first.value.calls,skills:first.value.skills,models:first.value.models.length,totalTokens:first.value.totalTokens},first:Object.fromEntries(fields.map(f=>[f,(first as any)[f]])),warm:Object.fromEntries(fields.map(f=>[f,summarize(warm.map((x:any)=>x[f]))])),warmSamples:warm.map(x=>Object.fromEntries(fields.map(f=>[f,(x as any)[f]]))),diagnostics};results.push(result);console.log(JSON.stringify(result));
}
(async()=>{try{
  for(const days of (process.env.RANGES||'1,30,371').split(',').map(Number))await runCase(days,'virtual-durable');
  // Independent old JSONL case: 32 sessions, approximately 17 MiB total. Entire legacy file is scanned, not only recent entries.
  if(process.env.SKILL_CASE!=='0'){
    const line=JSON.stringify({type:'message',timestamp:'2020-01-01T00:00:00Z',message:{role:'user',content:'/research\n'+ 'synthetic old content '.repeat(40)}})+'\n';
    const update=db.prepare('UPDATE usage_events SET session_file=? WHERE entry_id=?');
    for(let i=0;i<32;i++){const file=join(root,`old-${i}.jsonl`);writeFileSync(file,line.repeat(600));update.run(file,`event-${i*20}`);}
    await runCase(1,'legacy-jsonl-32-files');
  }
  writeFileSync(output,JSON.stringify({n,samples,now,node:process.version,environment:{platform:process.platform,arch:process.arch,node:process.version,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,tzEnv:process.env.TZ??null,sqliteVersion:(db.prepare('SELECT sqlite_version() AS version').get() as {version:string}).version,cpuModel:cpus()[0]?.model??null},dbBytes:statSync(join(root,'usage.db')).size,notes:['Disk SQLite, warm OS cache, not cold-disk claim. First invocation is separate.','p95 with 5 samples is only an empirical maximum, not a stable population percentile.','CPU is whole-process user+system CPU, not pure main-thread CPU.','Timer lag is zero-delay timer queued before synchronous dashboard; includes scheduling overhead.','Heap/RSS are before/after snapshots, not transient peak. maxRSS is cumulative process high-water.','Diagnostic calls wrap queryRows/SQLite all/skill method; SQL includes hydration; query minus SQL includes mapping/preparation. Residual includes instrumentation, GC, and candidate activityRows SQLite iteration (not independently timed), so it is not pure JS.','No GC forced. Instrumented calls follow plain calls so overhead comparison is confounded by JIT/GC.','fs diagnostics add two performance.now calls per exists/read; residual skillMs minus existsMs/readMs includes parser, deduplication, loop and timer overhead, not pure parser CPU.'],maxRssMiB:process.resourceUsage().maxRSS/1024,results},null,2));
}finally{app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
