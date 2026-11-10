const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.reconcile=({execution,ledger,raw},home)=>{
 const nativeSpeed={};
 const root=path.join(home,'.mybuddy','durable');
 const scan=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);if(item.isDirectory()){scan(file);continue;}
  if(!/^doc-.*\.jsonl$/.test(item.name))continue;
  for(const line of fs.readFileSync(file,'utf8').trim().split('\n')){
   const content=JSON.parse(line).payload?.content;if(!content)continue;
   if(content.kind==='base'&&content.value?.speed)Object.assign(nativeSpeed,content.value.speed);
   for(const op of content.ops||[])if(op[0]==='s'&&op[1]?.[0]==='speed'&&op[1].length===2)nativeSpeed[op[1][1]]=op[2];
  }
 }};scan(root);
 const samples=ledger.filter(call=>call.conversationId===execution.conversationId).map(call=>({output:call.outputTokens,...nativeSpeed[`${call.generationTaskId}:${call.responseTimestamp}`]}));
 assert(samples.length>0&&samples.every(row=>row.output===0||row.tps>0),'native generation timing exists');
 const total=samples.reduce((n,row)=>n+row.output,0),seconds=samples.reduce((n,row)=>n+(row.output?row.output/row.tps:0),0);
 assert(Math.abs(execution.metrics.generation.tps-total/seconds)<0.00001,'native observation → stored weighted speed');
 const usage=raw.at(-1).usage.at(-1);
 assert.equal(execution.metrics.contextTokens,usage.prompt_tokens+usage.completion_tokens,'last native call context, not cumulative usage');
 return {status:'passed',nativeTimings:samples,contextTokens:execution.metrics.contextTokens,note:'Host-observed generation speed, not provider-internal decode speed; context is an estimated latest-root snapshot.'};
};
if(require.main===module){const report=require(path.resolve(process.argv[2]));console.log(JSON.stringify(exports.reconcile(report.workMetrics,report.home),null,2));}
