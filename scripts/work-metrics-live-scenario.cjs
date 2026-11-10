const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,rawUsageAudit,agentDir,out})=>{
 await send('请创建一次性后台委托，标题“执行统计验收”，后台先实际调用工具 pwd 获取当前目录，拿到结果后下一轮再用 ls -la 查看该目录，然后写一份周末居家整理计划，包含厨房、卧室、书桌三个区域，每个区域两步并附目录观察。不要并行这两个工具，必须分轮。直接交付文字，不创建文件，不需要我验收，不要持续追踪。');
 await foregroundDone();
 await until(async()=> (await evaluate('window.api.botWork.listWorks(true)')).length===1,'one real Work');
 const workId=(await evaluate('window.api.botWork.listWorks(true)'))[0].workId;
 await until(async()=> (await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`)).lifecycle==='closed','real native Work completed');
 const work=await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`);
 assert.equal(work.closureConclusion,'succeeded');
 assert.equal(work.executions.length,1,'one measured native execution');
 const execution=work.executions[0];assert(execution.metrics?.reportedCalls>0,'actual execution metrics projected');
 const storage=new (require('better-sqlite3'))(path.join(agentDir,'app.db'),{readonly:true});
 const ledger=storage.prepare('SELECT value_json FROM work_execution_usage WHERE binding_id=?').all(execution.bindingId).map(row=>JSON.parse(row.value_json));
 const persisted=JSON.parse(storage.prepare('SELECT value_json FROM work_execution_metrics WHERE binding_id=?').get(execution.bindingId).value_json);storage.close();
 assert.deepEqual(execution.metrics,persisted,'DB → Work DTO');
 const raw=rawUsageAudit.filter(row=>{
   const request=requests[row.requestIndex];
   return request.messages.some(message=>{if(message.role!=='user')return false;
     const text=typeof message.content==='string'?message.content:message.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n');
     try{return JSON.parse(text).workId===workId;}catch{return false;}
   });
 });
 assert(raw.length>0,'raw provider requests identified by host Work envelope');
 assert.equal(ledger.length,raw.length,'raw calls → recorded calls');
 const normalized=raw.map(row=>{const u=row.usage.at(-1);assert(u,'upstream usage exists');const cache=u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens??u.cached_tokens??null,write=u.prompt_tokens_details?.cache_write_tokens??null;
   return {inputTokens:cache!=null&&write!=null?Math.max(0,u.prompt_tokens-cache-write):null,totalInputTokens:u.prompt_tokens,outputTokens:u.completion_tokens,cacheReadTokens:cache,cacheWriteTokens:write};});
 for(const key of ['inputTokens','totalInputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']) {
   const expected=normalized.every(row=>row[key]!=null)?normalized.reduce((n,row)=>n+row[key],0):null;
   assert.equal(ledger.every(row=>row[key]!=null)?ledger.reduce((n,row)=>n+row[key],0):null,expected,'raw → ledger '+key);
   assert.equal(execution.metrics[key],expected,'ledger → Work '+key);
 }
 await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim().startsWith('已完成')).click()`);
 await until(()=>evaluate(`!!document.querySelector('[data-work-id="${workId}"]')`),'completed card');
 await evaluate(`document.querySelector('[data-work-id="${workId}"]').click()`);
 await until(()=>evaluate(`!!document.querySelector('[aria-label="执行统计"]')`),'Work statistics in actual detail');
 const ui=await evaluate(`(()=>{const e=document.querySelector('[aria-label="执行统计"]');return {text:e.innerText,metrics:[...e.querySelectorAll('[data-metric]')].map(row=>({key:row.dataset.metric,title:row.title,text:row.textContent}))};})()`);
 for(const [key,field] of [['input','totalInputTokens'],['output','outputTokens'],['cacheRead','cacheReadTokens'],['cacheWrite','cacheWriteTokens']])
   if(execution.metrics[field]==null)assert(ui.metrics.find(row=>row.key===key).text.includes('—'),'missing raw field unknown '+key);
   else assert(ui.metrics.find(row=>row.key===key).title.includes(execution.metrics[field].toLocaleString('en-US')+' tokens'),'exact UI tooltip '+key);
 assert(execution.metrics.cacheReadTokens>0,'real Work native calls include cache hit');
 assert(ledger.length>1,'multi-call native Work');
 assert(ui.metrics.find(row=>row.key==='hit').text.includes(Math.round(execution.metrics.cacheReadTokens/execution.metrics.totalInputTokens*100)+'%'),'raw read/total cache rate shown');
 assert(ui.metrics.some(row=>row.key==='finished'),'completion time shown');
 for(const width of [1040,390]) {
   await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await evaluate(`document.querySelector('[aria-label="执行统计"]').scrollIntoView({block:'start'})`);
   await new Promise(resolve=>setTimeout(resolve,150));
   assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow '+width);
   const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'work-metrics-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 report.workMetrics={status:'passed',execution,ledger,raw,ui};
 report.workMetrics.timingAudit=require('./work-metrics-reconcile.cjs').reconcile(report.workMetrics,path.dirname(agentDir));
 report.history=await history();
 report.checks.push('real Work → actual provider raw usage → normalized ledger → persisted binding DTO → visible subagent-style metric grid; exact tooltips and completion time; desktop/mobile');
};
