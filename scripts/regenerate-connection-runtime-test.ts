// Real installed SDK, local provider failures only; no user sessions or credentials.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentUiPatch } from "../src/shared/agent-ipc";
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {mapPiEventToPatches} from '../src/shared/pi-event-mapper';
import {loadTaskHistoryFromSession} from '../src/main/agent/session-history';
const sandbox=mkdtempSync(join(tmpdir(),'mybuddy-regenerate-connection-'));
const model: Model<"openai-completions">={id:'fixture',provider:'fixture',api:'openai-completions',name:'fixture',baseUrl:'http://invalid.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
const manager=SessionManager.create(sandbox,sandbox);
let calls=0;
let fail=true;
const runtime=await ModelRuntime.create({authPath:join(sandbox,"auth.json"),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
runtime.hasConfiguredAuth=()=>true;
runtime.getAuth=async()=>({auth:{apiKey:"fixture"}});
runtime.getModel=()=>model;
runtime.streamSimple=()=>{
  calls++;
  const stream=createAssistantMessageEventStream();
  const response: AssistantMessage={role:'assistant',content:fail?[]:[{type:'text',text:'Recovered'}],api:model.api,provider:model.provider,model:model.id,stopReason:fail?'error':'stop',errorMessage:fail?'Connection failed':undefined,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  stream.push(fail?{type:'error',reason:'error',error:response}:{type:'done',reason:'stop',message:response});
  stream.end();return stream;
};
const loader=new DefaultResourceLoader({cwd:sandbox,agentDir:sandbox,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true});
await loader.reload();
const {session}=await createAgentSession({cwd:sandbox,agentDir:sandbox,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:loader,noTools:'builtin'});
await session.bindExtensions({mode:'rpc'});
const endings: Extract<AgentUiPatch, { type: "assistant_end" }>[]=[];
const mapperContext={taskId:'fixture',messageId:'reply',startedAt:Date.now()};
session.subscribe(event=>{for(const patch of mapPiEventToPatches(event,mapperContext)){if(patch.type==='assistant_end')endings.push(patch);}});
try {
  await session.prompt('hello');
  for(let attempt=0;attempt<3;attempt++){
    const target=session.getUserMessagesForForking()[0];
    const nav=await session.navigateTree(target.entryId);
    await session.prompt(nav.editorText||target.text);
    assert.equal(session.isStreaming,false);
  }
  assert.equal(calls,4,'initial connection plus three real SDK retries');
  assert.equal(endings.length,4);
  assert(endings.every(patch=>patch.error==='Connection failed'),'empty provider errors must reach the UI');
  const sessionFile=session.sessionFile; assert(sessionFile);
  const history=loadTaskHistoryFromSession(sessionFile);
  assert(history.messages.some(message=>message.role==='assistant'&&message.text.includes('Connection failed')),'history reload must preserve an empty failed assistant reply');
  fail=false;
  const target=session.getUserMessagesForForking()[0];
  const nav=await session.navigateTree(target.entryId);
  await session.prompt(nav.editorText||target.text);
  assert.equal(calls,5,'recovery retries same conversation without an extra user prompt');
  assert(endings.at(-1));
  assert.equal(endings.at(-1)?.error,undefined);
  console.log('regenerate connection runtime: ok (4 failures, 1 recovery, history preserved)');
} finally {session.dispose();}
