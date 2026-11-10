const assert=require('node:assert/strict');
exports.reconcile=function(report){
 const fs=require('node:fs'),path=require('node:path');
 const storage=new (require('better-sqlite3'))(path.join(report.home,'.mybuddy','app.db'),{readonly:true});
 const runs=storage.prepare('SELECT message_id,runtime_key FROM bot_request_runs').all();storage.close();
 const results=[];
 for(const reply of report.metricsAuditHistory.messages.filter(m=>m.role==='assistant')){
  const user=report.metricsAuditHistory.messages.find(m=>m.role==='user'&&m.requestId===reply.requestId);
  const label=/AUDIT_[ABM]/.exec(user.text)?.[0]||'composer';
  const raw=report.rawUsageAudit.filter(row=>row.label===label);
  const db=report.metricsAuditDb.calls.filter(row=>row.message_id===reply.messageId).map(row=>JSON.parse(row.value_json));
  const persisted=JSON.parse(report.metricsAuditDb.metrics.find(row=>row.message_id===reply.messageId).value_json);
  assert.deepEqual(reply.metrics,persisted,'DB → history DTO');
  assert.equal(db.length,raw.length,`${label}: raw calls ↔ recorded generations`);
  const ui=report.metricsAuditUi.find(row=>row.id===reply.messageId);
  if(label==='AUDIT_M'){
   assert(raw.every(row=>row.usageOmitted && row.usage.length),'actual upstream usage exists but was deliberately omitted in transit');
   for(const key of ['inputTokens','outputTokens','cacheReadTokens','contextTokens']) assert.equal(reply.metrics[key],null,`missing ${key} must not be zero`);
   assert(ui.text.includes('输入 —')&&ui.text.includes('输出 —')&&ui.text.includes('上下文 —'),'missing UI is honest');
   results.push({label,missingUsage:'passed'});continue;
  }
  const normalized=raw.map(row=>{const u=row.usage.at(-1);assert(u,'raw provider usage');const cache=u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens??u.cached_tokens??0;const write=u.prompt_tokens_details?.cache_write_tokens??0;
   return {inputTokens:Math.max(0,u.prompt_tokens-cache-write),outputTokens:u.completion_tokens,cacheReadTokens:cache,cacheWriteTokens:write};});
  for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']){
   assert.equal(db.reduce((sum,row)=>sum+row[key],0),normalized.reduce((sum,row)=>sum+row[key],0),`${label}: raw → normalized DB ${key}`);
   assert.equal(reply.metrics[key],normalized.reduce((sum,row)=>sum+row[key],0),`${label}: DB → UI DTO ${key}`);
  }
  const total=raw.reduce((sum,row)=>sum+row.usage.at(-1).prompt_tokens,0), output=raw.reduce((sum,row)=>sum+row.usage.at(-1).completion_tokens,0);
  assert(ui.titles.some(text=>text.startsWith(total.toLocaleString()+' tokens')),'exact input tooltip');
  assert(ui.titles.some(text=>text.startsWith(output.toLocaleString()+' tokens')),'exact output tooltip');
  const rate=normalized.reduce((sum,row)=>sum+row.cacheReadTokens,0)/total;
  assert(ui.text.includes(`缓存 ${(rate*100).toFixed(1)}%`),'weighted cache, not average');
  const run=runs.find(run=>run.message_id===reply.messageId);assert(run,'native request runtime');
  const nativeSpeed={};const folder=path.join(report.home,'.mybuddy','bot-conversations',run.runtime_key);
  for(const file of fs.readdirSync(folder).filter(name=>/^doc-.*\.jsonl$/.test(name))){
   for(const line of fs.readFileSync(path.join(folder,file),'utf8').trim().split('\n')){
    const content=JSON.parse(line).payload?.content;if(!content)continue;
    if(content.kind==='base'&&content.value?.speed)Object.assign(nativeSpeed,content.value.speed);
    for(const op of content.ops||[])if(op[0]==='s'&&op[1]?.[0]==='speed'&&op[1].length===2)nativeSpeed[op[1][1]]=op[2];
   }
  }
  const timingSamples=db.map(call=>({output:call.outputTokens,...nativeSpeed[`${call.generationTaskId}:${call.responseTimestamp}`]}));
  const measured=timingSamples.every(sample=>sample.output===0 || sample.tps>0);
  const seconds=measured?timingSamples.reduce((sum,sample)=>sum+(sample.output?sample.output/sample.tps:0),0):0;
  const expectedSpeed=measured&&seconds>0?output/seconds:null;
  if(expectedSpeed==null)assert.equal(reply.metrics.generation?.tps??null,null,'missing native timing is not guessed');
  else assert(Math.abs(reply.metrics.generation.tps-expectedSpeed)<0.00001,'persisted per-generation native timings → weighted speed');
  const last=raw.at(-1).usage.at(-1);assert.equal(reply.metrics.contextTokens,last.prompt_tokens+last.completion_tokens,'last-call context snapshot, not cumulative usage');
  results.push({label,calls:raw.length,input:total,output,cacheHitRate:rate,contextTokens:reply.metrics.contextTokens,
   nativeTimingSamples:timingSamples,hostObservedTps:reply.metrics.generation?.tps??null,proxyDecodeMs:raw.map(row=>row.endedAt-row.firstDeltaAt)});
 }
 const a=report.rawUsageAudit.find(row=>row.label==='AUDIT_A'),b=report.rawUsageAudit.find(row=>row.label==='AUDIT_B');
 assert(a.requestStartedAt<b.endedAt && b.requestStartedAt<a.endedAt,'actual provider request intervals overlap');
 return {status:'passed',concurrentIntervalsOverlap:true,results,speedNote:'Host snapshot observation and proxy receive clocks differ; no claim of provider-internal decode speed.'};
};
if(require.main===module){const report=require(require('node:path').resolve(process.argv[2]));console.log(JSON.stringify(exports.reconcile(report),null,2));}
