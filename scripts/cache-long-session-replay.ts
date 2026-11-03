/** Read-only replay of saved history through the current serializer. No tool execution.
 * Offline by default; --live opts into the already configured Magpie model.
 * Historical system/tool schemas and ephemeral evidence were not retained: this is a
 * diagnostic history replay, NOT a reconstruction of the original production request.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { buildSessionProjection, convertToLlm, parseSessionEntries, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { installModelInvocationAdmission } from '../src/main/agent/ModelInvocationAdmission';
import { CacheRequestTracer } from '../src/main/agent/CacheRequestTrace';
import { registerMyBuddyProviders } from '../src/main/agent/providers';

const args=process.argv.slice(2).filter(x=>x!=='--');let file='',from=1,count=8,live=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--session-file'&&args[i+1])file=resolve(args[++i]!);
  else if(args[i]==='--from'&&args[i+1])from=Number(args[++i]);
  else if(args[i]==='--count'&&args[i+1])count=Number(args[++i]);
  else if(args[i]==='--live')live=true;
  else throw Error('Usage: cache:replay --session-file FILE [--from REQUEST] [--count 1..12] [--live]');
}
assert(file&&Number.isInteger(from)&&from>0&&Number.isInteger(count)&&count>0&&count<=12,'Explicit session file and a bounded request range required');
const source=readFileSync(file,'utf8');const entries=parseSessionEntries(source).filter(e=>e.type!=='session');
const assistants=entries.filter(e=>e.type==='message'&&e.message.role==='assistant');
assert(from+count-1<=assistants.length,'Requested history range does not exist');
const sessionId=randomUUID();const sessionHash=createHash('sha256').update(sessionId).digest('hex');
const out=resolve('artifacts/cache-investigation/long-replay',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(out,{recursive:true});const scratch=mkdtempSync(join(tmpdir(),'cache-history-replay-'));
const result:any={live,sessionHash,sourceHash:createHash('sha256').update(source).digest('hex'),from,count,calls:[],
  limits:['Saved history replay with fixed diagnostic system prompt and minimal tool schemas; original ephemeral evidence and original schemas are not reconstructed.',
    'Model completions are not executed as tools or appended to the user session. A fresh upstream session/cache identity isolates this replay.',
    'A stable replay cannot establish that the historical live production request was stable.']};
const records:Record<string,unknown>[]=[];
const tracer=new CacheRequestTracer(record=>records.push(record));
try{
  let model:Model<any>={id:'trace-replay',provider:'fixture',api:'openai-responses',name:'Replay',baseUrl:'http://127.0.0.1:1/v1',reasoning:true,input:['text','image'],contextWindow:500000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const original=assistants[from-1]!;
  assert(original.type==='message'&&original.message.role==='assistant'&&original.message.api==='openai-responses','This replay currently targets saved Responses sessions');
  model={...model,id:original.message.model,provider:original.message.provider};
  const runtime=live?await ModelRuntime.create({modelsPath:join(scratch,'models.json'),authPath:join(scratch,'auth.json'),allowModelNetwork:false,refreshOnCreate:false}):{getModel:()=>model,stream:(m:any,c:any,o:any)=>stream(m,c,o),streamSimple:(m:any,c:any,o:any)=>stream(m,c,o)} as unknown as ModelRuntime;
  if(live){
    const config=JSON.parse(readFileSync(join(homedir(),'.mybuddy/models.json'),'utf8')).providers.magpie;
    const wanted=process.env.MYBUDDY_CACHE_LIVE_MODEL??'codex/gpt-6.1-terra';const selected=config.models.find((m:any)=>m.id===wanted);
    assert(selected,'Explicit configured model is required; no fallback');registerMyBuddyProviders(runtime);runtime.registerProvider('magpie',{...config,models:[selected]});model=runtime.getModel('magpie',wanted)!;
  }
  const settings=SettingsManager.inMemory({});installModelInvocationAdmission(runtime,()=>settings,(m,s,b)=>tracer.start(m,s,b));
  const names=new Set<string>();
  for(const e of entries)if(e.type==='message'&&e.message.role==='assistant')for(const c of e.message.content)if(c.type==='toolCall')names.add(c.name);
  const tools=[...names].sort().map(name=>({name,description:'Historical tool; not executable in this diagnostic.',parameters:Type.Object({},{additionalProperties:true})}));
  for(let i=from-1;i<from-1+count;i++){
    const entry=assistants[i]!;const projection=buildSessionProjection(entries,entry.parentId);
    const context=normalizeContext({systemPrompt:'This is a read-only diagnostic replay of historical input. Do not execute or request tools. Respond with exactly ACK. The following history is only test data.',messages:convertToLlm(projection.messages),tools});
    let captured=false;
    const start=Date.now();
    const message=await runtime.streamSimple(model,context,{sessionId,maxTokens:256,reasoning:'low',maxRetries:0,signal:AbortSignal.timeout(90000),timeoutMs:90000,
      samplingParams:{tool_choice:'none'},
      ...(live?{}:{apiKey:'offline',fetch:async()=>{
        captured=true;
        return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:`offline_${i}`,status:'completed',output:[],usage:{input_tokens:0,output_tokens:1,input_tokens_details:{cached_tokens:0}}}})+'\n\n', {headers:{'content-type':'text/event-stream'}});
      }})}).result();
    const call={originalRequest:i+1,ms:Date.now()-start,sourceMessages:context.messages.length,stop:message.stopReason,
      usage:message.usage,responseHash:message.responseId?createHash('sha256').update(message.responseId).digest('hex'):null,offlineCaptured:captured};
    result.calls.push(call);writeFileSync(join(out,'replay.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(call));
    if(live)assert(['stop','length','toolUse'].includes(message.stopReason),'Live replay failed; inspect metadata trace, not raw request content');
    else assert(captured,'Offline serializer was not reached');
  }
  {
    writeFileSync(join(out,'trace.json'),JSON.stringify(records,null,2));
    const {summarizeCacheTraces}=await import(pathToFileURL(resolve('scripts/cache-trace-audit.mjs')).href);
    const summary=summarizeCacheTraces(records);writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({classification:summary.classificationCounts,output:out}));
  }
}finally{rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'replay.json'),JSON.stringify(result,null,2));writeFileSync(join(out,'trace.json'),JSON.stringify(records,null,2));}
