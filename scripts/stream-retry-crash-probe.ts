import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeFile,readFileSync,appendFileSync} from 'node:fs';
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
const root=process.env.CRASH_ROOT || await mkdtemp(join(tmpdir(),'stream-retry-crash-'));
const model:any={id:'fixture',name:'Fixture',provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',reasoning:false,input:['text'],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const error='Ambiguous streamed tool call index; provider must send a stable call id';
assert(isRetryableAssistantError({stopReason:'error',errorMessage:error} as any));
for(const e of ['Ambiguous tool arguments','Conflicting streamed tool call name for the same identity','permission denied',error+' user text']) assert(!isRetryableAssistantError({stopReason:'error',errorMessage:e} as any),e);
assert(!isRetryableAssistantError({stopReason:'aborted',errorMessage:error} as any));
const call=(index:number,id:string|undefined,args:string)=>({index,id,type:'function',function:{name:id?'effect':undefined,arguments:args}});
const bad=[[call(0,'bad-a','{"value":')],[call(0,'bad-b','{"value":')],[call(0,undefined,'"MUST_NOT_EXECUTE"}')]];
const good=(value:string)=>[[call(0,value,JSON.stringify({value}))]];
function response(calls:any[][]|null){const chunks=calls?calls.map(tool_calls=>({choices:[{index:0,delta:{tool_calls},finish_reason:null}]})):[{choices:[{index:0,delta:{content:'done'},finish_reason:null}]}];chunks.push({choices:[{index:0,delta:{},finish_reason:calls?'tool_calls':'stop'}]} as any);return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}

const requestFile=join(root,'requests.txt'), effectsFile=join(root,'effects.txt'),stateFile=join(root,'state.json');
if(!process.env.CRASH_PHASE){
 const launch=(phase:string)=>fork(fileURLToPath(import.meta.url),[],{execArgv:process.execArgv,env:{...process.env,CRASH_ROOT:root,CRASH_PHASE:phase},stdio:['ignore','inherit','inherit','ipc']});
 const child=launch('before');
 await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>{child.kill();reject(new Error('checkpoint timeout'));},15000);child.once('message',()=>{clearTimeout(t);child.kill('SIGKILL');});child.once('exit',(code,signal)=>{if(signal)resolve();else reject(new Error('premature exit '+code));});});
 const next=launch('after');await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>{next.kill();reject(new Error('resume timeout'));},20000);next.once('exit',code=>{clearTimeout(t);code===0?resolve():reject(new Error('resume exit '+code));});});
 assert.equal(await readFile(effectsFile,'utf8'),'before\nafter\n');assert.equal((await readFile(requestFile,'utf8')).trim().split('\n').length,4);console.log('PASS forced-process-exit-during-retry-backoff: 4 requests, 2 effects, persisted attempt resumed; '+root);
}else{
 const registry=createRegistry();const extension=defineExtension({name:'fixture',tools:[defineTool({name:'effect',description:'fixture effect',parameters:Type.Object({value:Type.String()}),replay:'safe',execute:async(args)=>{appendFileSync(effectsFile,args.value+'\n');return{output:[{type:'text',text:'recorded'}]};}})]});registry.install(extension);
 const models:any={getAuth:async()=>undefined,getModel:()=>model,streamSimple:(_m:any,input:any,options:any)=>{appendFileSync(requestFile,'request\n');const n=readFileSync(requestFile,'utf8').trim().split('\n').length;return stream(model,input,{...options,apiKey:'fixture',fetch:async()=>response(n===1?good('before'):n===2?bad:n===3?good('after'):null)});}};
 const h=await Harness.open(await SqliteStorage.open(await DurableSqliteDatabase.open(join(root,'state.sqlite'))),{registry,models,settings:{retry:{enabled:true,maxRetries:2,baseDelayMs:3000,maxAgentDelayMs:3000},compaction:{enabled:false}}},ctx);
 if(process.env.CRASH_PHASE==='before'){
 const c=await h.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'fixture',modelId:'fixture'},extensions:[extension]}},ctx);await new Promise<void>((res,rej)=>writeFile(stateFile,JSON.stringify({id:c.id}),e=>e?rej(e):res()));await c.submit({type:'input',content:'public crash fixture',requestId:'crash'},ctx);
 while(true){const entries=await c.entries({order:'ascending'},100,undefined,ctx);if(entries.items.some((e:any)=>e.model?.some((m:any)=>m.errorMessage===error))){await new Promise(r=>setTimeout(r,100));process.send?.('checkpoint');break;}await new Promise(r=>setTimeout(r,20));}
 await new Promise(()=>{});
 }else{const{id}=JSON.parse(await readFile(stateFile,'utf8'));const c=(await h.conversation(id,ctx))!;const s=await c.submit({type:'input',content:'public crash fixture',requestId:'crash'},ctx);assert.equal((await s.wait(ctx)).status,'done');await c.waitForIdle(ctx);await h.close(ctx);}
}
