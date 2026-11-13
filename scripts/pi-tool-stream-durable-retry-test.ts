import assert from 'node:assert/strict';
import {mkdtemp,readFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {Harness,createRegistry,defineExtension,defineTool} from '@earendil-works/pi-durable';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {stream} from '@earendil-works/pi-ai/api/openai-completions';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {Type} from 'typebox';
import {DurableSqliteDatabase} from '../src/main/agent/durable/DurableSqliteDatabase';
const root=await mkdtemp(join(tmpdir(),'stream-retry-durable-'));
const model:any={id:'fixture',name:'Fixture',provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',reasoning:false,input:['text'],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const error='Ambiguous streamed tool call index; provider must send a stable call id';
assert(isRetryableAssistantError({stopReason:'error',errorMessage:error} as any));
for(const e of ['Ambiguous tool arguments','Conflicting streamed tool call name for the same identity','permission denied',error+' user text']) assert(!isRetryableAssistantError({stopReason:'error',errorMessage:e} as any),e);
assert(!isRetryableAssistantError({stopReason:'aborted',errorMessage:error} as any));
const call=(index:number,id:string|undefined,args:string)=>({index,id,type:'function',function:{name:id?'effect':undefined,arguments:args}});
const bad=[[call(0,'bad-a','{"value":')],[call(0,'bad-b','{"value":')],[call(0,undefined,'"MUST_NOT_EXECUTE"}')]];
const good=(value:string)=>[[call(0,value,JSON.stringify({value}))]];
function response(calls:any[][]|null){const chunks=calls?calls.map(tool_calls=>({choices:[{index:0,delta:{tool_calls},finish_reason:null}]})):[{choices:[{index:0,delta:{content:'done'},finish_reason:null}]}];chunks.push({choices:[{index:0,delta:{},finish_reason:calls?'tool_calls':'stop'}]} as any);return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
let passed=1;
async function run(name:string){let requests=0,effects=0;let firstDone!:()=>void;const first=new Promise<void>(r=>firstDone=r);const path=join(root,name+'.sqlite'),out=join(root,name+'.txt');const registry=createRegistry();const extension=defineExtension({name:'fixture',tools:[defineTool({name:'effect',description:'record a controlled fixture side effect',parameters:Type.Object({value:Type.String()}),replay:'safe',execute:async(args)=>{effects++;await appendFile(out,args.value+'\n');return {output:[{type:'text',text:'recorded'}]};}})]});registry.install(extension);
 const models:any={getAuth:async()=>undefined,getModel:()=>model,streamSimple:(_m:any,input:any,options:any)=>{requests++;const n=requests;const calls=name==='success'?(n===1?good('before'):n===2?bad:n===3?good('after'):null):bad;const s=stream(model,input,{...options,apiKey:'fixture',fetch:async()=>response(calls)});void s.result().then(()=>firstDone());return s;}};
 const open=async()=>Harness.open(await SqliteStorage.open(await DurableSqliteDatabase.open(path)),{registry,models,settings:{retry:{enabled:true,maxRetries:2,baseDelayMs:name==='cancel'?1000:1,maxAgentDelayMs:1000},compaction:{enabled:false}}},ctx);
 let h=await open();try{let c=await h.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'fixture',modelId:'fixture'},extensions:[extension]}},ctx);const id=c.id;const s=await c.submit({type:'input',content:'public fixture',requestId:name},ctx);if(name==='cancel'){await first;await new Promise(r=>setTimeout(r,20));await c.abort(ctx);}const result=await s.wait(ctx);await c.waitForIdle(ctx);
 if(name==='success'){assert.equal(result.status,'done');assert.equal(requests,4);assert.equal(effects,2);assert.equal(await readFile(out,'utf8'),'before\nafter\n');const entries=await c.entries({order:'ascending'},100,undefined,ctx);assert(entries.items.some((e:any)=>e.model?.some((m:any)=>m.errorMessage===error)),'failed attempt retained');await h.close(ctx);h=await open();c=(await h.conversation(id,ctx))!;const duplicate=await c.submit({type:'input',content:'public fixture',requestId:name},ctx);assert.equal(duplicate.id,s.id);assert.equal((await duplicate.wait(ctx)).status,'done');assert.equal(requests,4);assert.equal(effects,2);}
 else {assert.equal(result.status,'unanswered');assert.equal(requests,name==='cancel'?1:3);assert.equal(effects,0);}
 console.log('PASS '+name+' '+JSON.stringify({requests,effects,status:result.status}));passed++;}finally{await h.close(ctx);}}
for(const name of ['success','exhausted','cancel'])await run(name);
console.log(JSON.stringify({passed,root}));
