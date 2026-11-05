import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse, type ParseResult } from "@babel/parser";
import type { FunctionDeclaration, Node, File } from "@babel/types";
import { transformSync } from "esbuild";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { createMcpSideEffectExtension } from "../src/main/agent/mcp-side-effect-extension";
import { buildWebSearchReport, formatWebSearchReport } from "../src/main/capabilities/web-access/search-report";

// Actual installed Pi lifecycle/tool hooks, scripted provider and real disposable file writes.
const root = await mkdtemp(join(tmpdir(), "mybuddy-host-native-"));
const results: Array<{name:string;passed:boolean;error?:string;requests?:number;toolCalls?:number}> = [];
const delay = (ms:number) => new Promise<void>(r => setTimeout(r,ms));
async function test(name:string, fn:()=>Promise<any>) {
  try { const detail=await fn(); results.push({name,passed:true,...detail}); console.log("PASS "+name); }
  catch(error) { results.push({name,passed:false,error:String(error)}); console.error("FAIL "+name+": "+error); }
}
const model:any={id:"host-native",provider:"fixture",api:"openai-completions",name:"Local scripted provider",baseUrl:"http://invalid.invalid",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function nativeScenario(permission:"auto"|"readonly"|"default"="auto", approved=true, abort=false) {
  let requests=0,toolCalls=0,started=false;
  const events:string[]=[];
  const ctx={taskId:"fixture",executionId:"exec",assistantMessageId:"reply"};
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const runtime:any={hasConfiguredAuth:()=>true,getAuth:async()=>({auth:{apiKey:"fixture-only"}}),getModel:()=>model,
    streamSimple:(_m:any,context:any,options:any)=>{
      // Native Pi may enter the aborted provider boundary; no network dispatch is allowed.
      if (options?.signal?.aborted) {
        const stream=createAssistantMessageEventStream();
        const error:any={role:"assistant",content:[],stopReason:"aborted",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
        stream.push({type:"error",reason:"aborted",error});stream.end();return stream;
      }
      requests++; if(requests>3)throw Error("unexpected extra native request");
      const stream=createAssistantMessageEventStream();
      const prior=context.messages.at(-1),blocked=prior?.role==="toolResult"&&prior.isError;
      const content:any=requests===1?[{type:"toolCall",id:"mutation",name:"fixture_update_record",arguments:{id:"local"}}]:[{type:"text",text:blocked?"BLOCKED":"DONE"}];
      const stopReason:any=requests===1?"toolUse":"stop";
      const message:any={role:"assistant",content,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:"done",reason:stopReason,message});stream.end();return stream;
    }};
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[
    createConversationRuntimeExtension({resolveContext:()=>ctx} as any),
    createMcpSideEffectExtension({taskId:ctx.taskId,taskRoot:root,providerIds:["fixture"],getPermissionMode:()=>permission,requestApproval:async()=>approved}),
  ]});await loader.reload();
  const {session}=await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager:SessionManager.inMemory(root),resourceLoader:loader,noTools:"builtin",customTools:[{
    name:"fixture_update_record",label:"Disposable mutation",description:"Write a local test marker",parameters:Type.Object({id:Type.String()}),
    execute:async(_id,_params,signal)=>{started=true;toolCalls++;
      if(abort)await new Promise<void>((_resolve,reject)=>{if(signal?.aborted)return reject(Error("cancelled"));signal?.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});});
      await writeFile(join(root,"mutation-count.txt"),String(toolCalls));
      return {content:[{type:"text" as const,text:"LOCAL_WRITE_DONE"}],details:{}};
    },
  }]});await session.bindExtensions({mode:"rpc"});session.subscribe(e=>events.push(e.type));
  try {
    const running=session.prompt("Perform the disposable mutation once and report the outcome.");
    if(abort){const until=Date.now()+8000;while(!started){if(Date.now()>until)throw Error("native tool did not start");await delay(5);}await session.abort();}
    await running;assert(session.isIdle);const count=requests;await delay(40);assert.equal(requests,count,"settled session was woken by host");
    assert.equal(events.filter(x=>x==="agent_settled").length,1,"settled events: "+JSON.stringify(events));
    const allowed=permission==="auto"||(permission==="default"&&approved);
    assert.equal(toolCalls,allowed?1:0);assert.equal(requests,abort?1:2,"provider request count after abort="+abort+" events="+JSON.stringify(events));
    if(allowed&&!abort)assert.equal(await readFile(join(root,"mutation-count.txt"),"utf8"),"1");
    assert(!session.messages.some((m:any)=>m.role==="custom"&&/completion_gate/.test(m.customType??"")));
    return {requests,toolCalls};
  }finally{session.dispose();}
}
await test("native MCP tool loop settles once with full access",()=>nativeScenario());
await test("native MCP child respects a refused permission request",()=>nativeScenario("default",false));
await test("native MCP child can execute after explicit permission approval",()=>nativeScenario("default",true));
await test("native MCP child respects readonly mode",()=>nativeScenario("readonly"));
await test("native cancellation is not turned into another task",()=>nativeScenario("auto",true,true));

// Execute the exact production builder body with controlled fetches. No extra production test hooks.
const file="src/main/capabilities/web-access/index.ts",source=await readFile(file,"utf8");
const ast=parse(source,{sourceType:"module",plugins:["typescript"]});
function findBuilder(node: Node | ParseResult<File>): FunctionDeclaration | undefined {
  if(node.type==="FunctionDeclaration"&&node.id?.name==="buildSearchReturn")return node;
  for(const value of Object.values(node)){
    const children=Array.isArray(value)?value:[value];
    for(const child of children)if(child&&typeof child==="object"&&typeof child.type==="string"){
      const found=findBuilder(child as Node);if(found)return found;
    }
  }
}
const declaration=findBuilder(ast);
assert(declaration?.start!=null&&declaration.end!=null,"Production search builder is missing");
const builder=source.slice(declaration.start,declaration.end);
const js=transformSync(builder,{loader:"ts",target:"es2022"}).code;
function builderFixture(fetch:(urls:string[],signal?:AbortSignal)=>Promise<any[]>) {
  let stores=0,requests=0,id=0;
  const build=runInNewContext(js+"\nbuildSearchReturn;",{Set,Date,fetchAllContent:async(urls:string[],signal?:AbortSignal)=>{requests++;return fetch(urls,signal);},
    hasFullInlineCoverage:(urls:string[],content:any[])=>urls.every(url=>(content??[]).some(c=>c.url===url)),
    stripThumbnails:(c:any[])=>c,generateId:()=>String(++id),storeResult:()=>{stores++;},storeAndPublishSearch:()=>"search-fixture",
    buildWebSearchReport,formatWebSearchReport,getSearchPolicy:()=>({verifySources:false}),toolNames:{getSearchContent:"get_search_content"},
    pi:{appendEntry(){},sendMessage(){throw Error("background model wakeup forbidden");}},
  });return {build,requests:()=>requests,stores:()=>stores};
}
const options={queryList:["fixture"],results:[{query:"fixture",provider:"fixture",answer:"",results:[{title:"Fixture page",url:"https://fixture.invalid/page",snippet:"Disposable search evidence"}]}],urls:["https://fixture.invalid/page"],includeContent:true};
await test("search tool waits for requested content and never wakes a second model turn",async()=>{
  let release:(v:any[])=>void=()=>{};const h=builderFixture(async()=>new Promise(r=>{release=r;}));let finished=false;
  const p=h.build(options).then((x:any)=>{finished=true;return x;});await delay(10);assert(!finished);assert.equal(h.stores(),0);
  release([{url:options.urls[0],content:"fresh random fixture"}]);const result=await p;assert.equal(h.requests(),1);assert.equal(h.stores(),1);assert(result.details.fetchId);assert(!("fetchUrls" in result.details));
});
await test("cancelled content fetch cannot append late results or request continuation",async()=>{
  const controller=new AbortController();let release:(v:any[])=>void=()=>{};const h=builderFixture(async()=>new Promise(r=>{release=r;}));
  const p=h.build({...options,signal:controller.signal});const rejection=assert.rejects(p);controller.abort();release([{url:options.urls[0],content:"late"}]);await rejection;assert.equal(h.stores(),0);
});
await test("already cancelled search does not even start a content fetch",async()=>{
  const controller=new AbortController();controller.abort();const h=builderFixture(async()=>[]);await assert.rejects(h.build({...options,signal:controller.signal}));assert.equal(h.requests(),0);assert.equal(h.stores(),0);
});
await test("page-fetch failure is one honest result, not an automatic retry",async()=>{
  const h=builderFixture(async urls=>urls.map(url=>({url,error:"fixture network failure"})));const result=await h.build(options);assert.equal(h.requests(),1);assert.equal(result.details.contentErrors.length,1);assert.match(result.content[0].text,/0\/1/);
});
await test("already fetched pages are not downloaded again",async()=>{
  const h=builderFixture(async()=>{throw Error("unexpected duplicate fetch");});await h.build({...options,inlineContent:[{url:options.urls[0],content:"existing"}]});assert.equal(h.requests(),0);
});
await mkdir("artifacts/pi-host-exit",{recursive:true});await writeFile("artifacts/pi-host-exit/native-integration-results.json",JSON.stringify({at:new Date().toISOString(),passed:results.every(r=>r.passed),results},null,2));
await rm(root,{recursive:true,force:true});process.exitCode=results.every(r=>r.passed)?0:1;
