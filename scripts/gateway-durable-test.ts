import { createGatewayBotFixture } from "./gateway-bot-fixture";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { RemoteTaskCommandService } from "../src/main/remote/RemoteTaskCommandService";
import { gatewayInboundIdentity } from "../src/main/gateway/gateway-inbound-identity";
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
    const names=getCurrentTools(context.messages).map(tool=>tool.name);assert(names.includes("write")||names.includes("fixture_write"), "tools="+names.join(","));assert(!names.includes("codemode"));
    const index=context.messages.findLastIndex((m:any)=>m.role==="user"),input=context.messages[index];
    const rawText=typeof input.content==="string"?input.content:input.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("");
    const text=rawText.split("宿主提供的本次请求时间上下文")[0];
    const toolDone=context.messages.slice(index+1).some((m:any)=>m.role==="toolResult");
    const content:any=text.startsWith("HOLD")&&!toolDone?[{type:"toolCall",id:"hold-"+requests,name:"fixture_hold",arguments:{key:text}}]
      :!toolDone&&!text.startsWith("FAIL")?[{type:"toolCall",id:"write-"+requests,name:names.includes("write")?"write":"fixture_write",arguments:{path:"proof.txt",content:text}}]:[{type:"text",text:"ANSWER:"+text}];
    const stopReason=text.startsWith("FAIL")?"error":content[0].type==="toolCall"?"toolUse":"stop";
    const message:any={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage,stopReason,
      ...(stopReason==="error"?{errorMessage:"400: GATEWAY_FIXTURE_REJECTION"}:{})};
    stream.push(stopReason==="error"?{type:"error",reason:"error",error:message}:{type:"done",reason:stopReason,message});stream.end();
  });return stream;
}};
models.completeSimple=(m:any,c:any,o:any)=>models.streamSimple(m,c,o).result();
let failAssembly = false;
const createService=()=>new DurableBotService({db,models,agentDir,mcpDir,defaultModel:()=>"fixture/native",toolMode:task=>task.welcomeMode === "general" ? "codemode" : "native",
  instructions:()=>"fixture",tools:async()=>{ if (failAssembly) throw new Error("FIXTURE_POLICY_UNAVAILABLE"); return { tools:[hold], contextHooks:[] }; },emit:()=>{},resolveCwd:id=>{const cwd=join(root,createHash("sha256").update(id).digest("hex"));mkdirSync(cwd,{recursive:true});return cwd;}});
let durable=createService();
const write=defineTool({name:"fixture_write",description:"isolated native fixture filesystem effect",parameters:Type.Object({path:Type.String(),content:Type.String()}),replay:"unsafe",execute:async args=>{writeFileSync(join(root,"proof.txt"),args.content);return {output:[{type:"text",text:"written"}]};}});
const createForeground=()=>createGatewayBotFixture({db,models,root,tools:async()=>{if(failAssembly)throw new Error("FIXTURE_POLICY_UNAVAILABLE");return [hold,write];}});
let foreground=createForeground();
const gateway=new GatewayService(db,{runGatewayTurn:async(request:any)=>{try{return await foreground.runGatewayTurn(request);}catch(error){console.error(error);throw error;}}} as any);
(gateway as any).settingsStore={read:()=>({permissionMode:"readonly",defaultModelId:"fixture/native"})};
const fixtureConnection = "a".repeat(64);
const scopedTask = (channelId:string, chatId:string) => gatewayInboundIdentity(channelId,fixtureConnection,chatId).taskId;
// These synthetic inputs bypass provider transport but still supply a verified account and saved policy.
for (const channel of ["feishu","wecom","wechat","telegram"]) {
  (gateway as any).adapters.get(channel+"-default").workConnectionKey=()=>fixtureConnection;
  (gateway as any).channelPolicies.set(channel+"-default", {allowUsers:[]});
}
(gateway as any).adapters.set("custom-default", {workConnectionKey:()=>fixtureConnection,disconnect:async()=>{},isConnected:()=>true});
const inbound=(gateway as any).createInboundHandler();
const until=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw Error("fixture timeout");await new Promise(r=>setTimeout(r,10));}};
const request=(text:string,userMessageId=text)=>({taskId:"gw-bot-receipts",text,userMessageId,assistantMessageId:"ignored-"+userMessageId,
  gatewayOrigin:{channelId:"telegram-default",connectionKey:fixtureConnection,chatId:"receipts",senderId:"owner",messageId:userMessageId,audience:"private" as const}});
try{
  // Native tools execute through the same trusted Bot receipt front door for each transport.
  for(const channel of ["feishu","wecom","wechat","telegram","slack"]){
    (gateway as any).adapters.get(channel+"-default").workConnectionKey=()=>fixtureConnection;
    (gateway as any).channelPolicies.set(channel+"-default",{allowUsers:["owner"]});
    const replies:string[]=[];
    const input={channelId:channel+"-default",chatId:"chat",messageId:"message-1",text:channel,audience:"private",sender:{id:"owner"},
      ...(channel==="slack"?{taskId:"slack-chat",userMessageId:"slack-user-1",assistantMessageId:"slack-assistant-1"}:{}),
      reply:async(text:string)=>{replies.push(text);}};
    await inbound(input);assert.deepEqual(replies,["ANSWER:"+channel]);
    assert.equal(readFileSync(join(root,"proof.txt"),"utf8"),channel);
    const receipt=db.connection.prepare("SELECT * FROM bot_gateway_conversations WHERE channel_id=?").get(channel+"-default");
    assert(receipt,"actual authenticated Bot origin persisted");
    assert.equal(db.getTask(scopedTask(channel+"-default","chat")),undefined,"gateway never manufactures an active legacy Task");
    await inbound(input);assert.equal(replies.length,channel==="slack"?2:1);
  }
  const attachment=join(root,"gateway-source.txt");writeFileSync(attachment,"source content");
  for(const channel of ["telegram","slack"]){
    const replies:string[]=[];
    await inbound({channelId:channel+"-default",chatId:"media",messageId:"media-1",text:"MEDIA_INPUT",audience:"private",sender:{id:"owner"},
      attachments:[{name:"gateway-source.txt",path:attachment}],...(channel==="slack"?{taskId:"slack-media",userMessageId:"slack-media-1",assistantMessageId:"slack-media-assistant-1"}:{}),reply:async(text:string)=>{replies.push(text);}});
    assert.equal(replies.length,1);assert.ok(replies[0].includes("gateway-source.txt"));assert.ok(replies[0].includes("source content"));assert.ok(readFileSync(join(root,"proof.txt"),"utf8").includes("source content"));
  }
  const beforeSwitch=db.connection.prepare("SELECT COUNT(*) count FROM bot_gateway_conversations").get() as {count:number};
  (gateway as any).adapters.get("feishu-default").workConnectionKey=()=>"b".repeat(64);
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"message-1",text:"OTHER_ACCOUNT",audience:"private",sender:{id:"owner"},reply:async(text:string)=>assert.equal(text,"ANSWER:OTHER_ACCOUNT")});
  assert.equal((db.connection.prepare("SELECT COUNT(*) count FROM bot_gateway_conversations").get() as {count:number}).count,beforeSwitch.count+1);
  (gateway as any).adapters.get("feishu-default").workConnectionKey=()=>fixtureConnection;
  assert.deepEqual(db.getTask(legacy!.id),legacy);
  // A historical trashed Task stays historical; accepting a new Bot receipt never restores it.
  const oldId=scopedTask("feishu-default","chat");db.upsertTask({id:oldId,title:"preserve history",spaceId:undefined,updatedAt:1});
  db.upsertTaskExecutionWorkspaceState({taskId:oldId,directoryName:"trashed",state:"trashed",createdAt:1,updatedAt:1,trashPath:"unused"});
  const revived:string[]=[];gateway.setTrashedWorkspaceRestorer(id=>{revived.push(id);});
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"next",text:"NEXT",audience:"private",sender:{id:"owner"},reply:async()=>{}});
  assert.deepEqual(revived,[]);assert.equal(db.getTask(oldId)?.title,"preserve history");
  const beforeDenied=requests;await inbound({channelId:"telegram-default",chatId:"denied",messageId:"denied",text:"denied",sender:{id:"stranger"},reply:async()=>assert.fail("unauthorized reply")});assert.equal(requests,beforeDenied);
  const first=foreground.runGatewayTurn(request("HOLD_FIRST"));await until(()=>held.has("HOLD_FIRST"));
  const duplicate=foreground.runGatewayTurn(request("HOLD_FIRST"));const second=foreground.runGatewayTurn(request("SECOND"));
  const effectCount=effects;held.get("HOLD_FIRST")!();
  assert.equal(await first,"ANSWER:HOLD_FIRST");assert.equal(await duplicate,"ANSWER:HOLD_FIRST");assert.equal(await second,"ANSWER:SECOND");assert.equal(effects,effectCount);
  const cancelled=foreground.runGatewayTurn(request("HOLD_CANCEL")).then(()=>assert.fail("cancel must fail"),error=>assert.match(error.message,/取消|cancel/));
  await until(()=>held.has("HOLD_CANCEL"));await foreground.botConversations.cancel(foreground.botId,"gateway:HOLD_CANCEL");await cancelled;
  await assert.rejects(foreground.runGatewayTurn(request("FAIL")),/GATEWAY_FIXTURE_REJECTION/);
  let attempts=0;const retryInput={channelId:"feishu-default",chatId:"retry",messageId:"stable",text:"REPLY_RETRY",audience:"private",sender:{id:"owner"},reply:async(text:string)=>{assert.equal(text,"ANSWER:REPLY_RETRY");if(++attempts===1)throw Error("network failure");}};
  await assert.rejects(inbound(retryInput),/network failure/);const beforeRetry=requests;await inbound(retryInput);assert.equal(requests,beforeRetry);
  const suspended=foreground.runGatewayTurn(request("HOLD_RESTART")).catch(error=>error);
  await until(()=>held.has("HOLD_RESTART"));const effectsBeforeRestart=effects;await foreground.close();assert((await suspended) instanceof Error);
  failAssembly=true;foreground=createForeground();const requestsBeforePolicy=requests;
  await assert.rejects(foreground.runGatewayTurn(request("HOLD_RESTART")),/FIXTURE_POLICY_UNAVAILABLE|核对|unknown|失败/);
  assert.equal(requests,requestsBeforePolicy);await foreground.close();failAssembly=false;foreground=createForeground();
  await foreground.runGatewayTurn(request("HOLD_RESTART")).catch(error=>assert.match(error.message,/核对|unknown|失败/));assert.equal(effects,effectsBeforeRestart);
  const afterRestart=requests;assert.equal(await foreground.runGatewayTurn(request("SECOND")),"ANSWER:SECOND");assert.equal(requests,afterRestart);
  assert.deepEqual(db.getTask(legacy!.id),legacy);
  console.log("PASS trusted Bot origins, attachments, FIFO, dedup, cancellation, failure, immutable history and unsafe recovery");
  db.upsertTask({ id: "desktop-receipt", title: "Desktop", welcomeMode: "working", permissionMode: "auto", updatedAt: 1 });
  const accepted = await durable.prompt({ taskId: "desktop-receipt", text: "DESKTOP", userMessageId: "desktop-operation", assistantMessageId: "desktop-assistant" });
  assert(accepted.receipt);
  assert.equal((await durable.submissionStatus(accepted.receipt, true)).receipt?.status, "done");
  const afterDesktop = requests;
  const retried = await durable.prompt({ taskId: "desktop-receipt", text: "CHANGED RETRY", userMessageId: "desktop-operation", assistantMessageId: "retry-assistant", modelId: "missing/model" });
  assert.equal(retried.receipt?.submissionId, accepted.receipt.submissionId);
  assert.equal(requests, afterDesktop);
  const beforeFork = await durable.history("desktop-receipt");
  const user = beforeFork.messages.find(message => message.role === "user")!;
  const regeneration = { taskId: "desktop-receipt", requestId: "regen-operation", userMessageIndex: 0, assistantMessageId: "regenerated", sourceAssistantMessageId: "desktop-assistant", sourceUserMessageId: user.id, sourceUserEntryId: user.entryId };
  assert.equal((await durable.regenerate(regeneration)).ok, true);
  await until(async () => !(await durable.history("desktop-receipt")).durable?.busy);
  const afterRegenerate = requests;
  assert.equal((await durable.regenerate(regeneration)).ok, true);
  assert.equal(requests, afterRegenerate);
  assert.equal((await durable.history("desktop-receipt")).messages.filter(message => message.role === "user").length, 1);
  await durable.deleteUserMessage({ taskId: "desktop-receipt", userMessageIndex: 0 });
  assert.equal((await durable.history("desktop-receipt")).messages.length, 0);
  assert.equal((await durable.submissionStatus(accepted.receipt, true)).receipt?.status, "done", "a receipt remains queryable after the visible branch changes");
  await durable.release("desktop-receipt");
  assert.equal((await durable.history("desktop-receipt")).messages.length, 0);
  const old = SessionManager.create(root);
  old.appendMessage({ role: "user", content: "EXISTING", timestamp: 1 });
  old.appendMessage({ role: "assistant", content: [{ type: "text", text: "Existing answer" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2 });
  const oldFile = old.getSessionFile()!;
  const oldBytes = readFileSync(oldFile, "utf8");
  db.upsertTask({ id: "desktop-import", title: "Existing", welcomeMode: "coding", sessionFile: oldFile, updatedAt: 1 });
  assert.equal(durable.owns("desktop-import"), true);
  assert.deepEqual((await durable.history("desktop-import")).messages.map(message => message.text), ["EXISTING", "Existing answer"]);
  assert.equal(readFileSync(oldFile, "utf8"), oldBytes);
  await durable.release("desktop-import");
  db.upsertTask({ ...db.getTask("desktop-import")!, sessionFile: join(root, "unavailable-old-session.jsonl") });
  assert.deepEqual((await durable.history("desktop-import")).messages.map(message => message.text), ["EXISTING", "Existing answer"], "native recovery never reopens the legacy import source");
  console.log("PASS desktop receipts, retry identity, native regeneration/deletion and non-destructive history import");

  const uploads = join(root, "remote-uploads");
  const remoteAgent = {
    prompt: (input: Parameters<typeof durable.prompt>[0]) => durable.prompt(input),
    findSubmission: (taskId: string, operationId: string) => durable.findSubmission(taskId, operationId),
    listModels: async () => (await models.getAvailable()).map((entry: typeof model) => ({ id: `${entry.provider}/${entry.id}`, enabled: true, available: true })),
    isTaskBusy: (taskId: string) => durable.busy(taskId), listPendingActions: () => [],
  };
  const remote = new RemoteTaskCommandService(db, remoteAgent as never,
    { read: () => ({ permissionMode: "default" }), getTaskConnectorIds: () => [] } as never, { get: () => undefined }, uploads);
  const remoteInput = { operationId: "remote-stable-operation", text: "REMOTE_RECEIPT", modelId: "fixture/native", permissionMode: "auto" as const,
    attachments: [{ name: "source.txt", data: Buffer.from("uploaded once").toString("base64") }] };
  const firstRemote = await remote.createAndPrompt(remoteInput);
  await durable.submissionStatus(firstRemote.receipt, true);
  db.upsertTask({ ...db.getTask(firstRemote.task.id)!, permissionMode: "readonly" });
  const attached = join(uploads, firstRemote.task.id, readdirSync(join(uploads, firstRemote.task.id))[0]!);
  unlinkSync(attached);
  const beforeRemoteRetry = requests;
  await durable.release(firstRemote.task.id);
  const available = models.getAvailable, getModel = models.getModel;
  models.getAvailable = async () => []; models.getModel = () => undefined;
  remote.invalidateModelCache();
  try {
    const retriedRemote = await remote.createAndPrompt(remoteInput);
    assert.equal(retriedRemote.receipt.submissionId, firstRemote.receipt.submissionId);
    assert.equal(retriedRemote.receipt.status, "done");
    assert.equal(retriedRemote.queued, false);
    assert.equal(db.getTask(firstRemote.task.id)?.permissionMode, "readonly", "accepted remote retry cannot restore stale auto permission");
    assert.equal(existsSync(attached), false, "accepted remote retry cannot recreate or rewrite old attachments");
    assert.equal(requests, beforeRemoteRetry, "receipt lookup after reopen cannot invoke a removed model");
  } finally { models.getAvailable = available; models.getModel = getModel; }
  assert.equal((await durable.findSubmission("desktop-receipt", "desktop-operation"))?.receipt?.submissionId, accepted.receipt.submissionId,
    "operation lookup must retain receipts from the old visible branch");
  const afterDeletedBranch = requests;
  const retriedDeleted = await durable.prompt({ taskId: "desktop-receipt", text: "OLD_INPUT_RETRY", userMessageId: "desktop-operation",
    assistantMessageId: "ignored-deleted-retry", permissionMode: "auto", modelId: "missing/model" });
  assert.equal(retriedDeleted.receipt?.submissionId, accepted.receipt.submissionId);
  assert.equal(requests, afterDeletedBranch, "retrying an old branch input never invokes the model again");
  assert.equal((await durable.history("desktop-receipt")).messages.length, 0, "retrying a receipt cannot restore deleted visible history");
  console.log("PASS remote lost-response retry reads native receipt before permissions, models or attachments change");
}finally{await gateway.stop();await foreground.close();await durable.close();db.close();}
console.log("GATEWAY_DURABLE_TESTS_PASSED",root);
