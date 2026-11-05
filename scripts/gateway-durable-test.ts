import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { gatewayBotTaskId } from "../src/shared/gateway-task";
import { GATEWAY_ROOT_SPACE_ID, GATEWAY_ROOT_SPACE_NAME, gatewayChannelSpaceId } from "../src/main/gateway/gateway-task-space";

const root=mkdtempSync(join(tmpdir(),"mybuddy-gateway-durable-"));
process.env.HOME=root;process.env.USERPROFILE=root;process.env.PI_CODING_AGENT_DIR=join(root,".mybuddy");
const agentDir=join(root,".mybuddy"),mcpDir=join(agentDir,"plugins/mcp");mkdirSync(mcpDir,{recursive:true});
writeFileSync(join(mcpDir,"mcp.json"),JSON.stringify({mcpServers:{}}));
const db=new AppDatabase(join(agentDir,"app.db"));
db.upsertTask({id:"gw-telegram-default-chat",title:"Legacy",welcomeMode:"working",modePresetId:"summary",sessionFile:"old-session.jsonl",updatedAt:7});
const legacy=db.getTask("gw-telegram-default-chat");
const model:any={provider:"fixture",id:"native",name:"fixture",api:"openai-completions",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const held=new Map<string,()=>void>();let effects=0,requests=0;
const hold=defineTool({name:"fixture_hold",description:"isolated unsafe side effect",parameters:Type.Object({key:Type.String()}),replay:"unsafe",
  execute:async(args,_api,context)=>{effects++;await new Promise<void>((resolve,reject)=>{held.set(args.key,resolve);context.abortSignal?.addEventListener("abort",()=>reject(Error("interrupted")),{once:true});});return {output:[{type:"text",text:"done"}]};}});
const models:any={getAuth:async()=>undefined,refresh:async()=>{},getAvailable:async()=>[model],getModel:()=>model,streamSimple:(_model:any,context:any)=>{
  requests++;const stream=createAssistantMessageEventStream();
  queueMicrotask(()=>{
    const names=getCurrentTools(context.messages).map(tool=>tool.name);assert(names.includes("write"));assert(!names.includes("codemode"));
    const index=context.messages.findLastIndex((m:any)=>m.role==="user"),input=context.messages[index];
    const text=typeof input.content==="string"?input.content:input.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("");
    const toolDone=context.messages.slice(index+1).some((m:any)=>m.role==="toolResult");
    const content:any=text.startsWith("HOLD")&&!toolDone?[{type:"toolCall",id:"hold-"+requests,name:"fixture_hold",arguments:{key:text}}]
      :!toolDone&&!text.startsWith("FAIL")?[{type:"toolCall",id:"write-"+requests,name:"write",arguments:{path:"proof.txt",content:text}}]:[{type:"text",text:"ANSWER:"+text}];
    const stopReason=text.startsWith("FAIL")?"error":content[0].type==="toolCall"?"toolUse":"stop";
    const message:any={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage,stopReason,
      ...(stopReason==="error"?{errorMessage:"400: GATEWAY_FIXTURE_REJECTION"}:{})};
    stream.push(stopReason==="error"?{type:"error",reason:"error",error:message}:{type:"done",reason:stopReason,message});stream.end();
  });return stream;
}};
models.completeSimple=(m:any,c:any,o:any)=>models.streamSimple(m,c,o).result();
const createService=()=>new DurableBotService({db,models,agentDir,mcpDir,defaultModel:()=>"fixture/native",toolMode:()=>"codemode",
  instructions:()=>"fixture",tools:async()=>({ tools:[hold], contextHooks:[] }),emit:()=>{},resolveCwd:id=>{const cwd=join(root,createHash("sha256").update(id).digest("hex"));mkdirSync(cwd,{recursive:true});return cwd;}});
let durable=createService();
const gateway=new GatewayService(db,{runGatewayTurn:(request:any)=>durable.runGatewayTurn(request)} as any);
(gateway as any).settingsStore={read:()=>({permissionMode:"readonly",defaultModelId:"fixture/native"})};
const inbound=(gateway as any).createInboundHandler();
const until=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw Error("fixture timeout");await new Promise(r=>setTimeout(r,10));}};
const request=(text:string,userMessageId=text)=>({taskId:"gw-bot-receipts",text,userMessageId,assistantMessageId:"ignored-"+userMessageId});
try{
  const channelNames: Record<string, string> = { feishu: "飞书", wecom: "企微", wechat: "微信", telegram: "Telegram", slack: "Slack" };
  for(const channel of ["feishu","wecom","wechat","telegram","slack"]){
    const replies:string[]=[];const source=channel==="slack"?"gw-slack-fixture":`gw-${channel}-default-chat`;
    const input={channelId:channel+"-default",chatId:"chat",messageId:"message-1",text:channel,
      ...(channel==="slack"?{taskId:source,userMessageId:"slack-user-fixture",assistantMessageId:"slack-assistant-fixture"}:{}),
      reply:async(text:string)=>{replies.push(text);}};
    await inbound(input);assert.deepEqual(replies,["ANSWER:"+channel]);
    const task=db.getTask(gatewayBotTaskId(source))!;assert.equal(task.welcomeMode,"bot");assert.equal(task.modePresetId,"native");assert.equal(task.sessionFile,undefined);
    assert.equal(task.spaceId, gatewayChannelSpaceId(channel+"-default")); assert.equal(task.title, channel);
    const folder=db.getSpace(task.spaceId!)!; assert.equal(folder.name, channelNames[channel]); assert.equal(folder.parentId, GATEWAY_ROOT_SPACE_ID); assert.equal(folder.path, undefined);
    const gatewayRoot=db.getSpace(GATEWAY_ROOT_SPACE_ID)!; assert.equal(gatewayRoot.name, GATEWAY_ROOT_SPACE_NAME); assert.equal(gatewayRoot.parentId, null); assert.equal(gatewayRoot.path, undefined);
    const history=await durable.history(task.id);assert.equal(history.durable?.toolMode,"native");assert.equal(readFileSync(join(history.cwd!,"proof.txt"),"utf8"),channel);
    db.upsertTask({...task,modePresetId:"codemode"});assert.equal(db.getTask(task.id)?.modePresetId,"native");
    if(channel!=="slack"){await inbound(input);assert.equal(replies.length,1);}
  }
  const feishuId=gatewayBotTaskId("gw-feishu-default-chat"); const created=db.getTask(feishuId)!;
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"message-2",text:"第二条不应当覆盖标题和文件夹",reply:async()=>{}});
  const followed=db.getTask(feishuId)!; assert.equal(followed.title, created.title); assert.equal(followed.spaceId, created.spaceId);
  const keptId=gatewayBotTaskId("gw-custom-default-kept");
  db.upsertTask({id:keptId,title:"已有会话",welcomeMode:"bot",modePresetId:"native",updatedAt:1});
  await inbound({channelId:"custom-default",chatId:"kept",messageId:"kept-1",text:"后来的消息",reply:async()=>{}});
  assert.equal(db.getTask(keptId)?.title,"已有会话");
  assert.equal(db.getTask(keptId)?.spaceId, gatewayChannelSpaceId("custom-default"));
  const customFolder=db.getSpace(gatewayChannelSpaceId("custom-default"))!;
  assert.equal(customFolder.name, "custom-default"); assert.equal(customFolder.parentId, GATEWAY_ROOT_SPACE_ID); assert.equal(customFolder.path, undefined);
  await inbound({channelId:"custom-default",chatId:"kept",messageId:"kept-2",text:"第二条仍不改标题和文件夹",reply:async()=>{}});
  assert.equal(db.getTask(keptId)?.title,"已有会话"); assert.equal(db.getTask(keptId)?.spaceId, gatewayChannelSpaceId("custom-default"));
  db.createSpace({id:"user-folder",name:"用户自己的"});
  const parkedId=gatewayBotTaskId("gw-custom-default-parked");
  db.upsertTask({id:parkedId,title:"已归类",spaceId:"user-folder",welcomeMode:"bot",modePresetId:"native",updatedAt:1});
  await inbound({channelId:"custom-default",chatId:"parked",messageId:"parked-1",text:"不要搬走",reply:async()=>{}});
  assert.equal(db.getTask(parkedId)?.title,"已归类"); assert.equal(db.getTask(parkedId)?.spaceId,"user-folder");
  assert.deepEqual(db.getTask(legacy!.id),legacy);console.log("PASS all five channels use native Durable tools; unfiled chats join channel folders; filed chats and legacy tasks stay put");

  const revived:string[]=[];
  gateway.setTrashedWorkspaceRestorer((taskId)=>{
    revived.push(taskId);
    db.upsertTaskExecutionWorkspaceState({taskId,directoryName:"restored",state:"active",createdAt:1,updatedAt:Date.now()});
  });
  db.upsertTaskExecutionWorkspaceState({taskId:feishuId,directoryName:"trashed-fixture",state:"trashed",createdAt:1,updatedAt:1,trashPath:"unused"});
  const reviveReplies:string[]=[];
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"message-revive",text:"revive-me",reply:async(text:string)=>{reviveReplies.push(text);}});
  assert.deepEqual(revived,[feishuId]);
  assert.deepEqual(reviveReplies,["ANSWER:revive-me"]);
  console.log("PASS a trashed gateway chat is restored before the next turn");

  (gateway as any).channelPolicies.set("telegram-default",{allowUsers:["owner"]});
  const beforeDenied=requests;await inbound({channelId:"telegram-default",chatId:"denied",messageId:"denied",text:"denied",sender:{id:"stranger"},reply:async()=>assert.fail("unauthorized reply")});
  assert.equal(requests,beforeDenied);(gateway as any).channelPolicies.clear();

  const first=durable.runGatewayTurn(request("HOLD_FIRST"));await until(()=>held.has("HOLD_FIRST"));
  const duplicate=durable.runGatewayTurn(request("HOLD_FIRST"));
  const second=durable.runGatewayTurn(request("SECOND"));
  await until(async()=>Boolean((await durable.history("gw-bot-receipts")).durable?.queued));
  const effectCount=effects;held.get("HOLD_FIRST")!();
  assert.equal(await first,"ANSWER:HOLD_FIRST");assert.equal(await duplicate,"ANSWER:HOLD_FIRST");assert.equal(await second,"ANSWER:SECOND");assert.equal(effects,effectCount);
  console.log("PASS queued and duplicate inputs await their own native receipt, without mixed replies or repeated effects");

  const cancelled=durable.runGatewayTurn(request("HOLD_CANCEL")).then(()=>assert.fail("cancel should fail"),error=>assert.match(error.message,/取消/));
  await until(()=>held.has("HOLD_CANCEL"));await durable.abort("gw-bot-receipts");await cancelled;
  await assert.rejects(durable.runGatewayTurn(request("FAIL")),/GATEWAY_FIXTURE_REJECTION/);
  console.log("PASS cancellation and model failure are terminal native outcomes");

  let attempts=0;const retryInput={channelId:"feishu-default",chatId:"retry",messageId:"stable",text:"REPLY_RETRY",reply:async(text:string)=>{assert.equal(text,"ANSWER:REPLY_RETRY");if(++attempts===1)throw Error("network failure");}};
  await assert.rejects(inbound(retryInput),/network failure/);const beforeRetry=requests;await inbound(retryInput);assert.equal(requests,beforeRetry);
  console.log("PASS reply delivery retry reads the existing answer without rerunning tools");

  const suspended=durable.runGatewayTurn(request("HOLD_RESTART")).catch(error=>error);
  await until(()=>held.has("HOLD_RESTART"));const effectsBeforeRestart=effects;await durable.close();assert((await suspended) instanceof Error);
  durable=createService();assert.equal(await durable.runGatewayTurn(request("HOLD_RESTART")),"ANSWER:HOLD_RESTART");assert.equal(effects,effectsBeforeRestart);
  const afterRestart=requests;assert.equal(await durable.runGatewayTurn(request("SECOND")),"ANSWER:SECOND");assert.equal(requests,afterRestart);
  assert.deepEqual(db.getTask(legacy!.id),legacy);
  console.log("PASS checkpoint/reopen reacquires native receipts, with no unsafe replay, no duplicate old input and no legacy migration");
}finally{await gateway.stop();await durable.close();db.close();}
console.log("GATEWAY_DURABLE_TESTS_PASSED",root);
