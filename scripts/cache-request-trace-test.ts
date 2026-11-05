import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { stream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { CacheRequestTracer } from '../src/main/agent/CacheRequestTrace';
import { identifyModelInvocation, installModelInvocationAdmission } from '../src/main/agent/ModelInvocationAdmission';
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
  trace.providerEvent({type:'response.completed',response:{status:'completed',usage:{input_tokens:144704,output_tokens:10,input_tokens_details:{cached_tokens:24704}}}});
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
retryTrace.providerEvent({type:'response.completed',response:{status:'completed',usage:{input_tokens:100000,output_tokens:1,input_tokens_details:{cached_tokens:25000}}}});
retryTrace.result({stopReason:'stop',usage:{input:75000,cacheRead:25000,cacheWrite:0,output:1}});
const changedRetryId=records.at(-1).request;
assert(!JSON.stringify(records).includes(secret),'no source, URL, header, cache key, response ID, or unknown field-name plaintext');
const otherRecords:any[]=[];const other=new CacheRequestTracer(record=>otherRecords.push(record));
const otherTrace = other.start(model,'main'); otherTrace.payload(payload);
otherTrace.sent('https://example.invalid', {body: JSON.stringify(payload)});
const otherHttp = otherRecords.find(record => record.event === 'request' && record.stage === 'http');
const firstHttp = records.find(record => record.event === 'request' && record.stage === 'http');
assert.notEqual(tracer.epoch,other.epoch);assert.notEqual(firstHttp.bodyHash,otherHttp.bodyHash,'per-process HMAC domains must differ');
assert.equal(otherHttp.previous,null);
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
const native: any[] = [];
const nativeTracer = new CacheRequestTracer(record => native.push(record));
installModelInvocationAdmission(runtime,()=>settings,(...args)=>nativeTracer.start(...args));
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
  onPayload:(p:any)=>{payloadCalls++;identifyModelInvocation({taskId:'fixture-task',conversationId:'fixture-conversation',generationTaskId:7,sourceKind:'subagent'});return {...p,instructions:secret}}}).result();
assert.equal(message.stopReason,'stop',message.errorMessage);assert.equal(message.usage.cacheRead,24704);
assert.equal(fetchCalls,2);assert.equal(payloadCalls,1);assert.equal(bodies[0],bodies[1]);
assert.equal(JSON.parse(bodies[0]!).instructions,secret,'caller replacement must reach actual fetch unchanged');
const sessionHash=createHash('sha256').update(nativeSession).digest('hex');
assert.equal(native.filter(r=>r.stage==='provider').length,1);
assert.deepEqual(native.filter(r=>r.event==='http-result').map(r=>r.status),[503,200]);
assert(native.filter(r=>r.stage==='http').every(r=>r.adapterMatch===true));
assert.equal(native.find(r=>r.event==='result').attempts,2);
const identity = native.find(r=>r.event==='execution');
assert.equal(identity?.taskId,'fixture-task');assert.equal(identity?.conversationId,'fixture-conversation');assert.equal(identity?.generationTaskId,7);
assert.equal(identity?.request,native.find(r=>r.event==='result').request,'product execution and transport diagnostics share one request record');
assert.equal(native.find(r=>r.event==='result').responseHash,createHash('sha256').update('resp_trace_fixture').digest('hex'));
assert(!JSON.stringify(native).includes(secret));
const rawNative = native.find(r=>r.event==='provider-usage');
assert(rawNative, 'native terminal raw usage must be observed before Pi normalization');
assert.equal(rawNative.terminal, 'response.completed');
assert.equal(rawNative.usagePresent, true);
assert.equal(rawNative.cachedTokensPresent, true);
assert.deepEqual(rawNative.usage, { inputTokens: 150000, outputTokens: 2, totalTokens: null, cachedTokens: 24704 });
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
assert.equal(summary.requests.find((x:any)=>x.sessionHash===sessionHash).retryChanged,false);
console.log('PASS report distinguishes stable-prefix misses, changed requests, retries and coverage gaps');
// A large new tool result can lower the ratio while all earlier input was cached.
const growthRecords:any[]=[];const growthTracer=new CacheRequestTracer(record=>growthRecords.push(record));
const growthBody:any={model:model.id,input:[{role:'user',content:'first request'}]};
for(const [input,read] of [[10000,0],[90000,10000],[30000,70000]]){
  const t=growthTracer.start(model,'growth',{operation:'stream'});
  t.payload(growthBody);const a=t.sent('https://example.invalid',{body:JSON.stringify(growthBody)});
  t.received(a,200);
  t.providerEvent({type:'response.completed',response:{status:'completed',usage:{input_tokens:input!+read!,output_tokens:1,input_tokens_details:{cached_tokens:read}}}});
  t.result({stopReason:'stop',usage:{input:input!,cacheRead:read!,cacheWrite:0,output:1}});
  growthBody.input.push({role:'user',content:'new file data'});
}
const growthReport=summarizeCacheTraces(growthRecords);
assert.equal(growthReport.requests[1].classification,'stable-prefix-new-input');
assert.equal(growthReport.requests[1].historyUncachedTokens,0);
assert.equal(growthReport.requests[2].classification,'stable-prefix-partial-cache');
assert.equal(growthReport.requests[2].historyUncachedTokens,30000);
console.log('PASS fresh tail growth is distinct from partial cache reuse, even with a stable prefix');
// The actual Responses parser normalizes both absent cached_tokens and explicit zero to cacheRead=0.
const terminalCases = [
  { name:'missing-usage', terminal:'response.completed', status:'completed', usage:undefined, state:'missing' },
  { name:'missing-cache', terminal:'response.completed', status:'completed', usage:{input_tokens:10000,output_tokens:2}, state:'missing' },
  { name:'zero', terminal:'response.completed', status:'completed', usage:{input_tokens:10000,output_tokens:2,input_tokens_details:{cached_tokens:0}}, state:'explicit-zero' },
  { name:'positive', terminal:'response.completed', status:'completed', usage:{input_tokens:10000,output_tokens:2,input_tokens_details:{cached_tokens:256}}, state:'positive' },
  { name:'incomplete', terminal:'response.incomplete', status:'incomplete', usage:{input_tokens:10000,output_tokens:2,input_tokens_details:{cached_tokens:0}}, state:'explicit-zero' },
  { name:'failed', terminal:'response.failed', status:'failed', usage:{input_tokens:10000,output_tokens:2,input_tokens_details:{cached_tokens:0}}, state:'explicit-zero' },
  { name:'invalid-cache', terminal:'response.completed', status:'completed', usage:{input_tokens:10000,output_tokens:2,input_tokens_details:{cached_tokens:-1}}, state:'invalid' },
] as const;
for (const fixture of terminalCases) {
  const begin=native.length;
  const terminal={type:fixture.terminal,privatePayload:secret,response:{id:secret,status:fixture.status,output:[],usage:fixture.usage,
    error:fixture.status==='failed'?{code:'fixture-error',message:secret}:undefined,
    incomplete_details:fixture.status==='incomplete'?{reason:'max_output_tokens'}:undefined}};
  let sends=0,hookCalls=0,hookFinished=false;
  const result=await runtime.stream(model,context,{apiKey:secret,sessionId:'terminal-fixtures',maxRetries:0,
    fetch:async()=>{sends++;return new Response('data: '+JSON.stringify(terminal)+'\n\n',{headers:{'content-type':'text/event-stream'}})},
    onProviderStreamEvent:async(data:unknown,eventModel:unknown)=>{
      hookCalls++;assert.deepEqual(data,JSON.parse(JSON.stringify(terminal)));assert.equal(eventModel,model);
      await Promise.resolve();hookFinished=true;
    }}).result();
  assert.equal(sends,1);assert.equal(hookCalls,1);assert(hookFinished);
  const evidence=native.slice(begin);
  const raw=evidence.find(row=>row.event==='provider-usage');
  assert.equal(raw.terminal,fixture.terminal);assert.equal(raw.usagePresent,fixture.usage!==undefined);
  assert.equal(raw.cachedTokensPresent,fixture.state!=='missing');
  const report=summarizeCacheTraces(evidence).requests[0];
  assert.equal(report.cacheReadState,fixture.state);
  assert.deepEqual(report.usage,{input:result.usage.input,output:result.usage.output,cacheRead:result.usage.cacheRead,cacheWrite:result.usage.cacheWrite});
  if(fixture.state==='missing'){
    assert.equal(result.usage.cacheRead,0);assert.equal(raw.usage.cachedTokens,null);
    assert.equal(report.classification,'raw-cache-usage-missing');assert.equal(report.historyUncachedTokens,null);
  } else if(fixture.name==='failed'){
    assert.equal(result.stopReason,'error');assert.equal(report.classification,'request-failed');assert.equal(report.historyUncachedTokens,null);
  } else if(fixture.name==='incomplete') assert.equal(result.stopReason,'length');
  else if(fixture.state==='invalid') assert.equal(report.classification,'raw-cache-usage-invalid');
  else assert.equal(report.rawUsage.usage.cachedTokens,result.usage.cacheRead);
  assert(!JSON.stringify(evidence).includes(secret));assert(!JSON.stringify(report).includes(secret));
}
const zeroReport=summarizeCacheTraces(native).requests.find((row:any)=>row.cacheReadState==='explicit-zero'&&row.outcome==='stop');
assert.equal(zeroReport.classification,'stable-prefix-low-cache');assert.equal(zeroReport.rawHitRate,0);
const legacy=summarizeCacheTraces(native.filter(row=>row.event!=='provider-usage'));
assert(legacy.requests.every((row:any)=>row.classification==='request-failed'||row.classification==='raw-cache-usage-missing'));
const failureStart=native.length;
let failureSends=0;
const httpFailure=await runtime.stream(model,context,{apiKey:secret,maxRetries:0,
  fetch:async()=>{failureSends++;return new Response(JSON.stringify({error:{message:secret}}),{status:503,headers:{'content-type':'application/json'}})}}).result();
assert.equal(failureSends,1);assert.equal(httpFailure.stopReason,'error');
const failureReport=summarizeCacheTraces(native.slice(failureStart)).requests[0];
assert.equal(failureReport.classification,'request-failed');assert.equal(failureReport.cacheReadState,'missing');
assert.equal(failureReport.rawUsage,null);assert.equal(failureReport.usage.cacheRead,0);
const mismatched=native.map(row=>row.request===zeroReport.request&&row.event==='result'?{...row,usage:{...row.usage,cacheRead:999}}:row);
const mismatchReport=summarizeCacheTraces(mismatched).requests.find((row:any)=>row.request===zeroReport.request);
assert.equal(mismatchReport.usage.cacheRead,999);assert.equal(mismatchReport.rawUsage.usage.cachedTokens,0);
assert.equal(mismatchReport.normalizedCacheReadMatches,false);assert.equal(mismatchReport.rawHitRate,0);
console.log('PASS raw missing/zero/positive/invalid and failed/incomplete terminal metering remain distinct');

const terminalBody='data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:10,output_tokens:1,input_tokens_details:{cached_tokens:0}}}})+'\n\n';
const terminalFetch=async()=>new Response(terminalBody,{headers:{'content-type':'text/event-stream'}});
let releaseHook!:()=>void,enteredHook!:()=>void;
const hookGate=new Promise<void>(done=>{releaseHook=done});
const hookEntered=new Promise<void>(done=>{enteredHook=done});
let resolvedBeforeHook=false;
const gated=runtime.stream(model,context,{apiKey:secret,fetch:terminalFetch,maxRetries:0,
  onProviderStreamEvent:async()=>{enteredHook();await hookGate}}).result().then((value:any)=>{resolvedBeforeHook=true;return value});
await hookEntered;assert.equal(resolvedBeforeHook,false);releaseHook();assert.equal((await gated).stopReason,'stop');
const rejected=await runtime.stream(model,context,{apiKey:secret,fetch:terminalFetch,maxRetries:0,
  onProviderStreamEvent:async()=>{throw Error('caller hook rejected')}}).result();
assert.equal(rejected.stopReason,'error');assert.match(rejected.errorMessage,/caller hook rejected/);
const brokenEventRuntime:any={getModel:()=>model,stream:(m:any,c:any,o:any)=>stream(m,c,o),streamSimple:(m:any,c:any,o:any)=>stream(m,c,o)};
installModelInvocationAdmission(brokenEventRuntime,()=>settings,(...args)=>({...nativeTracer.start(...args),providerEvent:()=>{throw Error('observer failed')}}));
let survivingHook=0;
const unaffected=await brokenEventRuntime.stream(model,context,{apiKey:secret,fetch:terminalFetch,maxRetries:0,
  onProviderStreamEvent:()=>{survivingHook++}}).result();
assert.equal(unaffected.stopReason,'stop');assert.equal(survivingHook,1);
const failingSink=new CacheRequestTracer(()=>{throw Error('sink failed')});
assert.doesNotThrow(()=>failingSink.start(model).providerEvent(JSON.parse(terminalBody.slice(6))));
console.log('PASS caller hooks retain await/error behavior and survive observer failures');

const headerRecords:any[]=[];const headerTracer=new CacheRequestTracer(row=>headerRecords.push(row));
function observeHeaders(headers?:HeadersInit){
  headerTracer.start(model).sent('https://example.invalid',{body:JSON.stringify(payload),headers});
  return headerRecords.at(-1);
}
const h1=observeHeaders({'Authorization':secret,'X-Custom-Identity':secret});
const h2=observeHeaders({'x-custom-identity':secret,'authorization':secret});
const h3=observeHeaders({'authorization':secret,'x-custom-identity':'different'});
assert.equal(h1.headersHash,h2.headersHash);assert.notEqual(h1.headersHash,h3.headersHash);
assert.equal(h1.affinityHash,h3.affinityHash,'unknown SDK headers are not automatically routing identities');
assert.equal(h1.headersScope,'sdk-fetch-arguments');assert.equal(h1.headersCount,2);
assert.notEqual(h1.affinityHash,observeHeaders({'Authorization':'other','X-Custom-Identity':secret}).affinityHash);
assert.equal(observeHeaders().headersHash,null);assert.equal(observeHeaders().headersCount,null);
assert.equal(observeHeaders({}).headersCount,0);assert.equal(typeof observeHeaders({}).headersHash,'string');
const requestHeaders=new Request('https://example.invalid',{headers:{'X-Custom-Identity':secret}});
headerTracer.start(model).sent(requestHeaders,{body:JSON.stringify(payload)});
assert.equal(headerRecords.at(-1).headersCount,1);
assert(!JSON.stringify(headerRecords).includes(secret));assert(!JSON.stringify(headerRecords).includes('x-custom-identity'));
const changingRetry=headerTracer.start(model,'header-retry');
for(const count of [0,1]){
  const attempt=changingRetry.sent('https://example.invalid',{body:JSON.stringify(payload),headers:{authorization:secret,'x-stainless-retry-count':String(count)}});
  changingRetry.received(attempt,count===0?503:200);
}
changingRetry.providerEvent(JSON.parse(terminalBody.slice(6)));
changingRetry.result({stopReason:'stop',usage:{input:10,output:1,cacheRead:0,cacheWrite:0}});
const retryHeaderReport=summarizeCacheTraces(headerRecords).requests[0];
assert.equal(retryHeaderReport.retryHeadersChanged,true);assert.equal(retryHeaderReport.retryChanged,false);
const unseen:any[]=[];const unseenTrace=new CacheRequestTracer(row=>unseen.push(row)).start(model);
unseenTrace.payload(payload);unseenTrace.providerEvent(JSON.parse(terminalBody.slice(6)));
unseenTrace.result({stopReason:'stop',usage:{input:10,output:1,cacheRead:0,cacheWrite:0}});
const unseenReport=summarizeCacheTraces(unseen).requests[0];
assert.equal(unseenReport.classification,'missing-http-observation');assert.equal(unseenReport.headersScope,null);assert.equal(unseenReport.routeChanged,null);
console.log('PASS SDK header HMAC is canonical and redacted; unseen headers and wire remain unknown');
console.log('PASS cache request tracing; all provider responses simulated; no network');
