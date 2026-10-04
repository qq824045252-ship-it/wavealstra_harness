import { activateResolvedSessionTools } from "../src/main/agent/PromptAssembly";
import { getCurrentTools } from "@earendil-works/pi-ai";
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { isPiCodeModeEnabled } from '../src/shared/pi-code-mode';
import { emptyMcpFilterResult } from '../src/main/mcp/McpModeFilter';
import type { WelcomeMode } from '../src/shared/mode-profile';
const root=await mkdtemp(join(tmpdir(),'pi-codemode-auto-'));
const oldHome={USERPROFILE:process.env.USERPROFILE,HOME:process.env.HOME};
process.env.USERPROFILE=root;process.env.HOME=root;
const { McpRuntimeService }=await import('../src/main/mcp/McpRuntimeService');
const results:any[]=[];
const model:any={id:'scene-fixture',provider:'fixture',api:'openai-completions',name:'Scene fixture',baseUrl:'http://invalid.invalid',reasoning:false,input:['text'],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function test(name:string,fn:()=>Promise<any>){try{results.push({name,passed:true,...await fn()});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:error instanceof Error ? error.stack : String(error)});console.error('FAIL '+name+': '+error)}}
async function scenario(mode:WelcomeMode,withMcp:boolean,historyFile?:string,execute=true,disabledMcp=false){
  const work=join(root,randomUUID());await mkdir(work,{recursive:true});const nonce=randomUUID();await writeFile(join(work,'seed.json'),JSON.stringify({nonce,values:[7,13,29]}));
  const config:any={mcpServers:withMcp||disabledMcp?{fixture:{command:process.execPath,args:[resolve('scripts/pi-codemode-auto-fixture.mjs'),work],exposure:'codemode',enabled:!disabledMcp}}:{}};
  const service=new McpRuntimeService({agentDir:work,configService:{loadRuntimeConfig:()=>config,getAppGlobalConfigPath:()=>join(work,'mcp.json')} as any});
  const id=randomUUID(),bus=service.createEventBus(id);
  const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const contexts:any[]=[],events:string[]=[];let calls=0;
  const runtime:any={hasConfiguredAuth:()=>true,getAuth:async()=>({auth:{apiKey:'fixture-only'}}),getModel:()=>model,streamSimple:(_m:any,context:any)=>{
    calls++;contexts.push(structuredClone(context));if(calls>4)throw Error('Unexpected extra request');
    let content:any=[{type:'text',text:'SCENE_FINISHED'}];
    if(calls===1&&mode==='coding')content=[{type:'toolCall',id:'code-1',name:'codemode',arguments:{code:withMcp?'const r = await tools.mcp__fixture__read_seed({}); text(r);':'text({value: 7 * 9, modelAccess: typeof models});'}}];
    if(withMcp&&mode!=='coding'&&calls===1)content=[{type:'toolCall',id:'search-1',name:'tool_search',arguments:{query:'read_seed'}}];
    if(withMcp&&mode!=='coding'&&calls===2)content=[{type:'toolCall',id:'read-1',name:'mcp__fixture__read_seed',arguments:{}}];
    const stopReason:any=content[0].type==='toolCall'?'toolUse':'stop';const message:any={role:'assistant',content,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:stopReason,message});stream.end();return stream;
  }};
  const loader=new DefaultResourceLoader({cwd:work,agentDir:work,settingsManager:settings,eventBus:bus,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:service.getInlineExtensions({welcomeMode:mode,sessionLabel:id,mcpFilter:emptyMcpFilterResult(config)})});await loader.reload();
  const manager=historyFile?SessionManager.open(historyFile,undefined,work):SessionManager.create(work,work);
  const result=await createAgentSession({cwd:work,agentDir:work,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:loader});const session=result.session;
  try{
    await session.bindExtensions({mode:'rpc'});
    activateResolvedSessionTools(session,{},mode);
    await settings.reload(); // Production ModelInvocationAdmission reloads settings before provider dispatch.
    service.attachSession(id,result.extensionsResult,withMcp?['fixture']:[],{session,welcomeMode:mode});
    if(withMcp){const c=await service.connect('fixture',id);assert(c.ok,c.error);}
    const active=session.getActiveToolNames();assert.equal(active.includes('codemode'),isPiCodeModeEnabled(mode),'effective native activation');assert(active.includes('tool_search'),'native discovery stays enabled');
    assert.equal(service.getStatus(id)?.codeMode?.active,mode==='coding','snapshot activation '+JSON.stringify(service.getStatus(id)?.codeMode));assert.equal(service.getStatus(id)?.codeMode?.welcomeMode,mode);
    session.subscribe(e=>events.push(e.type));
    if(execute){
      await session.prompt('Run one disposable scene capability check.');assert(session.isIdle);assert.equal(events.filter(x=>x==='agent_settled').length,1);
      const errors=session.messages.filter((m:any)=>m.role==='toolResult'&&m.isError);assert.equal(errors.length,0,JSON.stringify(errors));
      const schemaNames=getCurrentTools(contexts[0]?.messages??[]).map(t=>t.name);assert.equal(schemaNames.includes('codemode'),mode==='coding','model declarations '+JSON.stringify({schemaNames,contextKeys:Object.keys(contexts[0]??{}),active}));
      if(withMcp){const audit=(await readFile(join(work,'mcp-audit.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(audit.filter(r=>r.tool==='read_seed').length,1);assert(JSON.stringify(session.messages).includes(nonce));}
      else if(mode==='coding')assert(JSON.stringify(session.messages).includes('63'),'codemode arithmetic result '+JSON.stringify(session.messages));
    }
    return {mode,withMcp,active,requests:calls,sessionFile:session.sessionFile,workingDirectory:work};
  }finally{service.detachSession(id);session.dispose();}
}
try{
  for(const mode of ['working','coding','design'] as const){await test(mode+' without any MCP server',()=>scenario(mode,false));await test(mode+' with real stdio MCP and native tool discovery',()=>scenario(mode,true));}
  await test('coding stays active with a configured but disabled MCP server after settings reload',()=>scenario('coding',false,undefined,true,true));
  await test('reopen coding history as office without stale Code Mode',async()=>{const a=await scenario('coding',false);const b=await scenario('working',false,a.sessionFile);assert(!b.active.includes('codemode'));return {from:'coding',to:'working'};});
  await test('reopen office history as coding activates Code Mode',async()=>{const a=await scenario('working',false);const b=await scenario('coding',false,a.sessionFile);assert(b.active.includes('codemode'));return {from:'working',to:'coding'};});
}finally{
  for(const [key,value]of Object.entries(oldHome)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await mkdir('artifacts/pi-codemode-auto',{recursive:true});await writeFile('artifacts/pi-codemode-auto/native-results.json',JSON.stringify({at:new Date().toISOString(),passed:results.every(t=>t.passed),results},null,2));
  await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:250});
}
process.exitCode=results.every(t=>t.passed)?0:1;
