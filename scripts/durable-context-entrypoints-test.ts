/** Production Gateway admission + auxiliary opener; real Durable/SQLite/tools, deterministic provider only.
 * This is not transport authentication, Work/team scheduling, Remote reconnect or real-model acceptance. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools, type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotService, type DurableBotServiceOptions } from "../src/main/agent/durable/DurableBotService";
import { openDurableAuxiliary } from "../src/main/agent/durable/DurableAuxiliaryRuntime";
import type { DurableBotOptions, DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { gatewayInboundIdentity } from "../src/main/gateway/gateway-inbound-identity";

const root=mkdtempSync(join(tmpdir(),"i26-entrypoints-"));
const previous={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR};
process.env.HOME=root;process.env.USERPROFILE=root;process.env.PI_CODING_AGENT_DIR=join(root,".mybuddy");
const agentDir=join(root,".mybuddy"),mcpDir=join(agentDir,"plugins/mcp");
mkdirSync(mcpDir,{recursive:true});writeFileSync(join(mcpDir,"mcp.json"),JSON.stringify({mcpServers:{}}));
const model={id:"entrypoint",name:"fixture",provider:"fixture",api:"openai-completions",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const text=(m:Message):string=>typeof m.content==="string"?m.content:JSON.stringify(m.content);
const requests:Array<readonly Message[]>=[];let summaries=0;
const assistant=(content:AssistantMessage["content"],stopReason:"stop"|"toolUse",input=1):AssistantMessage=>({role:"assistant",content,stopReason,api:"openai-completions",provider:"fixture",model:model.id,timestamp:Date.now(),usage:{input,output:20,cacheRead:0,cacheWrite:0,totalTokens:input+20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const fixture={getAuth:async()=>undefined,refresh:async()=>{},getAvailable:async()=>[model],getModel:()=>model,
 completeSimple:async()=>{summaries++;return assistant([{type:"text",text:"Previous synthetic diagnostic exchanges were summarized. Exact originals remain available through context tools."}],"stop");},
 streamSimple:(_model:unknown,context:{messages:readonly Message[]})=>{
  const messages=structuredClone(context.messages);requests.push(messages);const stream=createAssistantMessageEventStream();
  queueMicrotask(()=>{try{
   const i=messages.findLastIndex(m=>m.role==="user"),input=text(messages[i]!);const query=/RETRIEVE_(GATEWAY|AUXILIARY)/.exec(input)?.[1];
   const results=messages.slice(i+1).filter(m=>m.role==="toolResult");let content:AssistantMessage["content"]=[{type:"text",text:"DONE"}];let reason:"stop"|"toolUse"="stop";
   if(query){
    assert(getCurrentTools(messages).some(t=>t.name==="acp_retrieve"));
    if(!results.length){content=[{type:"toolCall",id:`search-${requests.length}`,name:"acp_search",arguments:{query:`EXACT_${query}_ORIGINAL`,scope:"originals"}}];reason="toolUse";}
    else if(results.length===1){const entry=/entry (\d+) · (?:pi|mybuddy)\.user/.exec(text(results[0]!));assert(entry,"original search must return actual entry: "+text(results[0]!));content=[{type:"toolCall",id:`retrieve-${requests.length}`,name:"acp_retrieve",arguments:{entryId:Number(entry[1]),limit:1000}}];reason="toolUse";}
    else {assert(text(results.at(-1)!).includes(`EXACT_${query}_ORIGINAL`));assert(text(results.at(-1)!).includes(`verbatim-${query}-NB7`));content=[{type:"text",text:`VERIFIED_${query}`}];}
   }
   const message=assistant(content,reason,messages.reduce((n,m)=>n+estimateMessageTokens(m),0));stream.push({type:"done",reason,message});stream.end();
  }catch(error){const failure=assistant([],"stop");failure.stopReason="error";failure.errorMessage=String(error);stream.push({type:"error",reason:"error",error:failure});stream.end();}});return stream;
 }};
const models=fixture as unknown as DurableBotOptions["models"];
const db=new AppDatabase(join(agentDir,"app.db"));
const durable=new DurableBotService({db,models:fixture as unknown as DurableBotServiceOptions["models"],agentDir,mcpDir,defaultModel:()=>"fixture/entrypoint",toolMode:()=>"native",instructions:()=>"Only obey the latest synthetic test request.",tools:async()=>({tools:[],contextHooks:[]}) as never,
 productCompaction:()=>({ratio:0.8,absoluteTokens:20000}),emit:()=>{},resolveCwd:id=>{const p=join(root,createHash("sha256").update(id).digest("hex"));mkdirSync(p,{recursive:true});return p;}});
const gateway=new GatewayService(db,{runGatewayTurn:(request:Parameters<DurableBotService["runGatewayTurn"]>[0])=>durable.runGatewayTurn(request)} as never);
(gateway as any).settingsStore={read:()=>({permissionMode:"readonly",defaultModelId:"fixture/entrypoint"})};
const account="c".repeat(64),channel="telegram-default",chat="context-matrix";
(gateway as any).adapters.get(channel).workConnectionKey=()=>account;
(gateway as any).channelPolicies.set(channel,{allowUsers:[]});
const inbound=(gateway as any).createInboundHandler();
const taskId=gatewayInboundIdentity(channel,account,chat).taskId;
const filler="Synthetic archived observations with no additional instructions. ".repeat(550);
const seed=(kind:string,n:number)=>`Synthetic block ${n}.\n${n===0?`EXACT_${kind}_ORIGINAL verbatim-${kind}-NB7.\n`:""}${filler}`;
const deadline=async<T>(p:Promise<T>):Promise<T>=>{let timer:NodeJS.Timeout;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("entrypoint deadline")),30000);})]);}finally{clearTimeout(timer!);}};
let auxiliary:DurableBotRuntime|undefined;
try{
 const replies:string[]=[];const sendGateway=async(value:string,id:string)=>deadline(inbound({channelId:channel,chatId:chat,messageId:id,text:value,reply:async(t:string)=>{replies.push(t);}}));
 for(let n=0;n<8;n++)await sendGateway(seed("GATEWAY",n),`gateway-${n}`);
 assert.equal(replies.length,8);assert(summaries>0,"Gateway must call real summary fixture");
 assert(requests.some(ms=>JSON.stringify(ms).includes("[Compressed")&&!JSON.stringify(ms).includes("EXACT_GATEWAY_ORIGINAL")),"Gateway outgoing requests must use committed projection without old original");
 const gatewayStatus=await durable.contextManagementStatus(taskId);assert(gatewayStatus?.sessionId);assert.equal(gatewayStatus.triggerTokens,20000);
 await sendGateway("RETRIEVE_GATEWAY","gateway-retrieve");assert.equal(replies.at(-1),"VERIFIED_GATEWAY");
 const gatewaySummaryCount=summaries;await durable.release(taskId);await sendGateway("Continue after cold reopen.","gateway-reopen");assert.equal(summaries,gatewaySummaryCount,"reopen must not duplicate maintenance");
 console.log("PASS production Gateway inbound → Durable service: automatic projection, original tools, persisted reopen");
 const start=requests.length,summaryStart=summaries;
 const openAux=()=>openDurableAuxiliary({agentDir,id:"context-aux",models,initialize:async()=>({id:"context-aux",kind:"btw",parentTaskId:taskId,cwd:root,instructions:"Only synthetic context validation.",model:{provider:"fixture",modelId:model.id}}),runtime:async()=>({onSnapshot:()=>{}})});
 auxiliary=(await openAux()).runtime;
 const sendAux=async(t:string,id:string)=>{const s=await auxiliary!.submit(t,id);assert.equal((await deadline(s.wait(ctx))).status,"done");};
 for(let n=0;n<10;n++)await sendAux(seed("AUXILIARY",n),`aux-${n}`);
 assert(summaries>summaryStart,"actual auxiliary opener default policy must automatically compress");
 assert(requests.slice(start).some(ms=>JSON.stringify(ms).includes("[Compressed")&&!JSON.stringify(ms).includes("EXACT_AUXILIARY_ORIGINAL")));
 const auxStatus=auxiliary.contextManagementStatus();assert(auxStatus?.sessionId);assert.notEqual(auxStatus.sessionId,gatewayStatus.sessionId,"parentTaskId does not share compression identity");assert.equal(auxStatus.triggerTokens,102400,"auxiliary default uses actual 128K model window");
 assert(requests.slice(start).every(ms=>!JSON.stringify(ms).includes("EXACT_GATEWAY_ORIGINAL")),"auxiliary must not see parent transcript");
 await sendAux("RETRIEVE_AUXILIARY","aux-retrieve");
 assert(requests.at(-1)!.some(m=>m.role==="toolResult"&&text(m).includes("verbatim-AUXILIARY-NB7")));
 await auxiliary.close();auxiliary=undefined;
 auxiliary=(await openAux()).runtime;assert.equal(auxiliary.contextManagementStatus()?.sessionId,auxStatus.sessionId);
 await sendAux("Continue after auxiliary reopen.","aux-reopen");
 console.log("PASS production auxiliary opener: default automatic policy, independent scope, original retrieval, reopen");
}finally{await auxiliary?.close();await gateway.stop();await durable.close();db.close();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(root,{recursive:true,force:true});}
console.log("DURABLE_CONTEXT_ENTRYPOINTS_PASSED (Gateway + auxiliary; Work/team/Remote not claimed)");
