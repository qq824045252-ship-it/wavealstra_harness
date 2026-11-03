import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { stream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { CacheRequestTracer } from '../src/main/agent/CacheRequestTrace';
import { installModelInvocationAdmission } from '../src/main/agent/ModelInvocationAdmission';
import { createRequestTransport } from '../src/main/agent/request-transport.mjs';

const records: any[] = [];
process.env.MYBUDDY_CACHE_TRACE = '1';
const tracer = new CacheRequestTracer(record => records.push(record));
const model: Model<any> = { id: 'trace-fixture', provider: 'fixture', api: 'openai-responses', name: 'Fixture',
  baseUrl: 'https://not-a-network.invalid/v1', reasoning: true, input: ['text', 'image'], contextWindow: 500000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const secret = 'NEVER_PERSIST_source_credentials_private_037';
const payload = { model: model.id, prompt_cache_key: secret,
  tools: [{ type: 'function', name: 'read', description: secret }], [secret]: { token: secret },
  input: [ { role: 'developer', content: secret }, { role: 'user', content: [{ type: 'input_text', text: secret }] },
    { type: 'reasoning', encrypted_content: secret, summary: [] },
    { type: 'function_call_output', call_id: secret, output: [{ type: 'input_image', image_url: secret }] } ] };
function observe(body: any, session = 'main', options: any = {}) {
  const trace = tracer.start(model, session, { operation: 'stream', userId: options.user ?? 'u1', ledgerId: 'l1' });
  trace.payload(body);
  const attempt = trace.sent('https://example.invalid/private?key='+secret,
    { body: JSON.stringify(body), headers: { authorization: 'Bearer '+secret, session_id: secret } });
  trace.received(attempt, 200);
  trace.result({ responseId: secret, stopReason: 'stop', usage: { input: 120000, cacheRead: 24704, cacheWrite: 0, output: 10 } });
  return records.filter(r=>r.event==='request'&&r.stage==='http').at(-1);
}
observe(payload);
const appended = structuredClone(payload);appended.input.push({ role: 'user', content: 'next' } as any);
let r = observe(appended, 'main', { user: 'u2' });
assert.equal(r.previous.prefix, true);assert.deepEqual(r.previous.changedFields, []);
assert.equal(r.adapterMatch, true);
const changed = structuredClone(appended);changed.input[1]!.content = [{type:'input_text',text:'rewritten'}] as any;
r = observe(changed);assert.equal(r.previous.prefix, false);assert.equal(r.previous.firstDifference.index, 1);
assert.deepEqual(r.previous.firstDifference.changedItemFields, ['content']);
r = observe({...changed, tools:[]});assert.equal(r.previous.prefix,true);assert.deepEqual(r.previous.changedFields,['tools']);
r = observe(payload,'separate');assert.equal(r.previous,null);
const partial = tracer.start(model,'main',{operation:'stream'});partial.sent(new Request('https://example.invalid',{method:'POST',body:'stream'}));
r = observe(payload);assert.equal(r.previous,null,'a gap cannot be called unchanged');
const compact = structuredClone(payload);compact.input = [payload.input[1]!];r=observe(compact);
assert.equal(r.previous.prefix,false);
const retryTrace=tracer.start(model,'main',{operation:'stream'});
retryTrace.payload(payload);
for(const status of [503,200]){const attempt=retryTrace.sent('https://example.invalid',{body:JSON.stringify(payload)});retryTrace.received(attempt,status);}
retryTrace.result({stopReason:'stop',usage:{input:75000,cacheRead:25000,cacheWrite:0,output:1}});
const changedRetryId=records.at(-1).request;
assert(!JSON.stringify(records).includes(secret),'no source, URL, header, cache key, response ID, or unknown field-name plaintext');
const otherRecords:any[]=[];const other=new CacheRequestTracer(record=>otherRecords.push(record));
other.start(model,'main').payload(payload);
assert.notEqual(tracer.epoch,other.epoch);assert.notEqual(records[0].bodyHash,otherRecords[0].bodyHash,'per-process HMAC domains must differ');
assert.equal(otherRecords[0].previous,null);
console.log('PASS first changed item/field, tool changes, user boundaries, isolation, gaps and keyed redaction');

let sendCount=0, validations=0;
const response=new Response('original',{status:200});
const transport=createRequestTransport(model,{fetch:async()=>{sendCount++;return response}},async()=>{validations++},
  {sent:()=>{throw Error('observer failed')},received:()=>{throw Error('observer failed')}});
assert.equal(await transport.fetch!('https://example.invalid',{body:'{}'}),response);
assert.equal(sendCount,1);assert.equal(validations,1);
const denied=createRequestTransport(model,{fetch:async()=>{throw Error('unexpected send')}},async()=>{throw Error('revoked')});
await assert.rejects(()=>denied.fetch!('https://example.invalid'),/revoked/);
const limited=createRequestTransport({...model,inputLimits:{maxRequestBytes:3}},{fetch:async()=>{throw Error('unexpected send')}},async()=>{});
await assert.rejects(()=>limited.fetch!('https://example.invalid',{method:'POST',body:'1234'}),/超过/);
console.log('PASS observer failures do not change response identity or bypass revocation/byte guards');

// Native SDK serialization and production admission, with a fake fetch that never opens a socket.
const settings=SettingsManager.inMemory({});
const runtime:any={getModel:()=>model,stream:(m:any,c:any,o:any)=>stream(m,c,o),streamSimple:(m:any,c:any,o:any)=>stream(m,c,o)};
installModelInvocationAdmission(runtime,()=>settings);
const nativeSession='trace-native-integration';
const context=normalizeContext({systemPrompt:'Stable instructions',messages:[{role:'user',content:[{type:'text',text:'Inspect data'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],timestamp:1}],tools:[]});
let fetchCalls=0, payloadCalls=0;
const bodies:string[]=[];
const fakeFetch=async(_url:any,init:any)=>{
  fetchCalls++;bodies.push(init.body);
  if(fetchCalls===1)return new Response(JSON.stringify({error:{message:'fixture retry'}}),{status:503,headers:{'content-type':'application/json','retry-after-ms':'1'}});
  return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_trace_fixture',status:'completed',output:[],usage:{input_tokens:150000,output_tokens:2,input_tokens_details:{cached_tokens:24704}}}})+'\n\n',
    {status:200,headers:{'content-type':'text/event-stream'}});
};
const message=await runtime.streamSimple(model,context,{apiKey:secret,sessionId:nativeSession,maxRetries:1,fetch:fakeFetch,
  onPayload:(p:any)=>{payloadCalls++;return {...p,instructions:secret}}}).result();
assert.equal(message.stopReason,'stop',message.errorMessage);assert.equal(message.usage.cacheRead,24704);
assert.equal(fetchCalls,2);assert.equal(payloadCalls,1);assert.equal(bodies[0],bodies[1]);
assert.equal(JSON.parse(bodies[0]!).instructions,secret,'caller replacement must reach actual fetch unchanged');
const dir=join(homedir(),'.mybuddy/logs');
const logged=readdirSync(dir).filter(f=>/^cache-requests-/.test(f)).flatMap(f=>readFileSync(join(dir,f),'utf8').split('\n'))
 .filter(l=>l.includes('[cache-trace] ')).map(l=>JSON.parse(l.split('[cache-trace] ')[1]!));
const sessionHash=createHash('sha256').update(nativeSession).digest('hex');const native=logged.filter(r=>r.sessionHash===sessionHash);
assert.equal(native.filter(r=>r.stage==='provider').length,1);
assert.deepEqual(native.filter(r=>r.event==='http-result').map(r=>r.status),[503,200]);
assert(native.filter(r=>r.stage==='http').every(r=>r.adapterMatch===true));
assert.equal(native.find(r=>r.event==='result').attempts,2);
assert.equal(native.find(r=>r.event==='result').responseHash,createHash('sha256').update('resp_trace_fixture').digest('hex'));
assert(!JSON.stringify(native).includes(secret));
console.log('PASS native Responses serializer, caller transform, real HTTP-body boundary, retries and response correlation');

// ~0.8 MB of deterministic history, plus image/encrypted reasoning; no model call or network.
const long={...payload,input:[...payload.input,...Array.from({length:1000},(_,i)=>({role:'user',content:`row ${i} `+'data '.repeat(150)}))]};
const started=performance.now();observe(long,'long');long.input.push({role:'user',content:'continue'});
r=observe(long,'long');assert.equal(r.previous.prefix,true);assert.equal(r.inputCount,1005);
console.log(`PASS long history stays append-only in the observer (${Math.round(performance.now()-started)} ms for two captures at both boundaries)`);
const brokenObserverRuntime:any={getModel:()=>model,stream:(m:any,c:any,o:any)=>stream(m,c,o),streamSimple:(m:any,c:any,o:any)=>stream(m,c,o)};
installModelInvocationAdmission(brokenObserverRuntime,()=>settings,()=>{throw Error('observer factory unavailable')});
assert.equal((await brokenObserverRuntime.streamSimple(model,context,{apiKey:'offline',fetch:fakeFetch,maxRetries:0}).result()).stopReason,'stop');
const { summarizeCacheTraces } = await import(pathToFileURL(resolve('scripts/cache-trace-audit.mjs')).href);
const summary=summarizeCacheTraces([...records,...native].reverse());
assert.equal(summary.requests.find((x:any)=>x.request===changedRetryId).classification,'client-request-changed','retry must not hide the original prefix break');
assert(summary.requests.some((x:any)=>x.classification==='stable-prefix-low-cache'));
assert(summary.requests.some((x:any)=>x.classification==='client-request-changed'&&x.firstDifference?.index===1));
assert.deepEqual(summary.requests.find((x:any)=>x.sessionHash===sessionHash).httpStatuses,[503,200]);
console.log('PASS report distinguishes stable-prefix misses, changed requests, retries and coverage gaps');
// A large new tool result can lower the ratio while all earlier input was cached.
const growthRecords:any[]=[];const growthTracer=new CacheRequestTracer(record=>growthRecords.push(record));
const growthBody:any={model:model.id,input:[{role:'user',content:'first request'}]};
for(const [input,read] of [[10000,0],[90000,10000],[30000,70000]]){
  const t=growthTracer.start(model,'growth',{operation:'stream'});
  t.payload(growthBody);const a=t.sent('https://example.invalid',{body:JSON.stringify(growthBody)});
  t.received(a,200);t.result({stopReason:'stop',usage:{input:input!,cacheRead:read!,cacheWrite:0,output:1}});
  growthBody.input.push({role:'user',content:'new file data'});
}
const growthReport=summarizeCacheTraces(growthRecords);
assert.equal(growthReport.requests[1].classification,'stable-prefix-new-input');
assert.equal(growthReport.requests[1].historyUncachedTokens,0);
assert.equal(growthReport.requests[2].classification,'stable-prefix-partial-cache');
assert.equal(growthReport.requests[2].historyUncachedTokens,30000);
console.log('PASS fresh tail growth is distinct from partial cache reuse, even with a stable prefix');
console.log('PASS cache request tracing; all provider responses simulated; no network');
