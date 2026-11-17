/** Exercise the real Pi parser with synthetic SSE, never credentials or tools. */
import assert from 'node:assert/strict';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { magpieChatRecovery } from '../src/main/agent/providers/MagpieChatRecovery';
const model: Model<'openai-completions'> = {id:'fixture',name:'Fixture',provider:'magpie',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const call=(index:number|undefined,id:string|undefined,name:string|undefined,args:string)=>({index,id,type:'function',function:{name,arguments:args}});
async function parse(calls: ReturnType<typeof call>[][]) {
 const events=calls.map(tool_calls=>({id:'completion-fixture',choices:[{index:0,delta:{tool_calls},finish_reason:null}]}));
 const fetchFixture:typeof fetch=async()=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: '+JSON.stringify({id:'completion-fixture',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 const response=stream(model,normalizeContext({messages:[{role:'user',content:'fixture',timestamp:1}]}),{apiKey:'fixture',fetch:fetchFixture});
 for await(const _event of response) { /* drain */ }
 return response.result();
}
const tools=(result:Awaited<ReturnType<typeof parse>>)=>result.content.filter(block=>block.type==='toolCall');
let passed=0;
async function check(name:string,run:()=>Promise<void>){await run();passed++;console.log('PASS '+name);}
await check('standard parallel calls retain interleaved argument fragments',async()=>{
 const result=await parse([[call(0,'read-1','read','{"path":'),call(1,'bash-1','bash','{"command":')],[call(1,undefined,undefined,'"pwd"}'),call(0,undefined,undefined,'"file","limit":160}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);
 assert.deepEqual(tools(result).map(t=>[t.id,t.name,t.arguments]),[['read-1','read',{path:'file',limit:160}],['bash-1','bash',{command:'pwd'}]]);
});
await check('reused index and distinct IDs cannot join read and bash JSON',async()=>{
 const result=await parse([[call(0,'read-1','read','{"path":"file","limit":160}')],[call(0,'bash-1','bash','{"command":"pwd"}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);
 assert.deepEqual(tools(result).map(t=>[t.id,t.name,t.arguments]),[['read-1','read',{path:'file',limit:160}],['bash-1','bash',{command:'pwd'}]]);
});
await check('reused index permits explicit-ID interleaving, never cross-call fragments',async()=>{
 const result=await parse([[call(0,'read-1','read','{"path":')],[call(0,'bash-1','bash','{"command":')],[call(0,'read-1',undefined,'"file"}')],[call(0,'bash-1',undefined,'"pwd"}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);
 assert.deepEqual(tools(result).map(t=>t.arguments),[{path:'file'},{command:'pwd'}]);
});
await check('same tool called twice at reused index remains two calls',async()=>{
 const result=await parse([[call(0,'a','read','{"path":"one"}')],[call(0,'b','read','{"path":"two"}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);assert.deepEqual(tools(result).map(t=>[t.id,t.arguments]),[['a',{path:'one'}],['b',{path:'two'}]]);
});
await check('ambiguous index-only continuation fails response instead of guessing',async()=>{
 const result=await parse([[call(0,'a','read','{"path":')],[call(0,'b','bash','{"command":')],[call(0,undefined,undefined,'"x"}')]]);
 assert.equal(result.stopReason,'error');assert.match(result.errorMessage??'',/Ambiguous streamed tool call index/);
});
await check('same identity changing tool name fails before mixed execution',async()=>{
 const result=await parse([[call(0,'a','read','{"path":"x"}')],[call(0,'a','bash','{"command":"pwd"}')]]);
 assert.equal(result.stopReason,'error');assert.match(result.errorMessage??'',/Conflicting streamed tool call name/);
});
await check('late ID attaches to existing index exactly once',async()=>{
 const result=await parse([[call(0,undefined,'read','{"path":')],[call(0,'a',undefined,'"x"}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);assert.equal(tools(result).length,1);assert.equal(tools(result)[0].id,'a');assert.deepEqual(tools(result)[0].arguments,{path:'x'});
});
await check('ID-only fragments are supported',async()=>{
 const result=await parse([[call(undefined,'a','read','{"path":')],[call(undefined,'a',undefined,'"x"}')]]);
 assert.equal(result.stopReason,'toolUse',result.errorMessage);assert.deepEqual(tools(result)[0].arguments,{path:'x'});
});
await check('two JSONs already inside a single wire call stay invalid, never repaired',async()=>{
 const result=await parse([[call(0,'a','read','{"path":"x"}{"command":"pwd"}')]]);
 const block=tools(result)[0];assert.ok(block.argumentsError);assert.deepEqual(block.arguments,{});
});
const ambiguous = [[call(0,'a','read','{"path":')],[call(0,'b','bash','{"command":')],[call(0,undefined,undefined,'"x"}')]];
const recovery = magpieChatRecovery(openAICompletionsApi());
const context = normalizeContext({messages:[{role:'user',content:'fixture',timestamp:1}]});
const fullCalls = [call(0,'one','read','{"path":"first"}'),call(0,'two','bash','{"command":"second"}')];
function sse(calls: ReturnType<typeof call>[][]) {
  const chunks = calls.map(tool_calls=>({choices:[{index:0,delta:{tool_calls},finish_reason:null}]}));
  return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')
    +'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}});
}
await check('Magpie retries only the ambiguous stream as a complete response and preserves call boundaries', async()=>{
  const requests: Record<string,unknown>[] = [];
  const wireEvents: unknown[] = [];
  const response = recovery.streamSimple(model, context, {apiKey:'fixture', onProviderStreamEvent: event=>{wireEvents.push(event);}, fetch:async(input,init)=>{
    const request = new Request(input, init);
    const payload = await request.json() as Record<string,unknown>;
    requests.push(payload);
    assert.equal(request.headers.get('authorization'),'Bearer fixture');
    if (requests.length===1) return sse(ambiguous);
    assert.equal(request.headers.get('accept'),'application/json');
    return Response.json({id:'recovered',model:'fixture',usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15},choices:[{
      message:{role:'assistant',reasoning_content:'reasoning',content:'recovered',tool_calls:fullCalls},finish_reason:'tool_calls',
    }]});
  }});
  const events: string[] = [];
  for await (const event of response) events.push(event.type);
  const result = await response.result();
  assert.equal(result.stopReason,'toolUse',result.errorMessage);
  assert.deepEqual(tools(result).map(t=>[t.id,t.arguments]),[['one',{path:'first'}],['two',{command:'second'}]]);
  assert.equal(result.responseId,'recovered');
  assert.equal(result.usage.totalTokens,15);
  assert.equal(events.filter(e=>e==='start').length,1);
  assert.equal(events.filter(e=>e==='done').length,1);
  assert(!events.includes('error'));
  assert.equal(wireEvents.length,4);
  assert.equal(requests.length,2);
  assert.equal(requests[0].stream,true);
  assert.equal(requests[1].stream,false);
  assert.equal(requests[1].stream_options,undefined);
  assert.deepEqual(requests[1].messages,requests[0].messages);
});
await check('valid parallel Magpie stream remains one streaming request',async()=>{
  let requests=0;
  const response = recovery.stream(model,context,{apiKey:'fixture',fetch:async()=>{
    requests++;
    return sse([[call(0,'a','read','{"path":'),call(1,'b','read','{"path":"second"}')],[call(0,undefined,undefined,'"first"}')]]);
  }});
  assert.equal((await response.result()).stopReason,'toolUse');
  assert.equal(requests,1);
});
for (const kind of ['duplicates','still streaming','503'] as const) {
  await check('Magpie recovery stops after one failed alternate request: '+kind, async()=>{
    let requests=0;
    const response = recovery.streamSimple(model,context,{apiKey:'fixture',fetch:async()=>{
      if (++requests===1) return sse(ambiguous);
      if (kind==='503') return new Response('unavailable',{status:503});
      if (kind==='still streaming') return sse(ambiguous);
      return Response.json({choices:[{message:{role:'assistant',tool_calls:[fullCalls[0],fullCalls[0]]},finish_reason:'tool_calls'}]});
    }});
    const result=await response.result();
    assert.equal(result.stopReason,'error');
    assert.match(result.errorMessage??'',/完整响应重试失败/);
    assert.equal(isRetryableAssistantError(result),false);
    assert.equal(requests,2);
    assert.equal(tools(result).length,0);
  });
}
console.log(JSON.stringify({passed,failed:0}));
