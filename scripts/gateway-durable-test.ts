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
let failAssembly = false;
const createService=()=>new DurableBotService({db,models,agentDir,mcpDir,defaultModel:()=>"fixture/native",toolMode:task=>task.welcomeMode === "bot" ? "codemode" : "native",
  instructions:()=>"fixture",tools:async()=>{ if (failAssembly) throw new Error("FIXTURE_POLICY_UNAVAILABLE"); return { tools:[hold], contextHooks:[] }; },emit:()=>{},resolveCwd:id=>{const cwd=join(root,createHash("sha256").update(id).digest("hex"));mkdirSync(cwd,{recursive:true});return cwd;}});
let durable=createService();
const gateway=new GatewayService(db,{runGatewayTurn:(request:any)=>durable.runGatewayTurn(request)} as any);
(gateway as any).settingsStore={read:()=>({permissionMode:"readonly",defaultModelId:"fixture/native"})};
const fixtureConnection = "a".repeat(64);
const scopedTask = (channelId:string, chatId:string) => gatewayInboundIdentity(channelId,fixtureConnection,chatId).taskId;
// These synthetic inputs bypass provider transport but still supply a verified account.
for (const channel of ["feishu","wecom","wechat","telegram"]) {
  (gateway as any).adapters.get(channel+"-default").workConnectionKey=()=>fixtureConnection;
}
(gateway as any).adapters.set("custom-default", {workConnectionKey:()=>fixtureConnection,disconnect:async()=>{},isConnected:()=>true});
const inbound=(gateway as any).createInboundHandler();
const until=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw Error("fixture timeout");await new Promise(r=>setTimeout(r,10));}};
const request=(text:string,userMessageId=text)=>({taskId:"gw-bot-receipts",text,userMessageId,assistantMessageId:"ignored-"+userMessageId});
try{
  const channelNames: Record<string, string> = { feishu: "飞书", wecom: "企微", wechat: "微信", telegram: "Telegram", slack: "Slack" };
  for(const channel of ["feishu","wecom","wechat","telegram","slack"]){
    const replies:string[]=[];const source=channel==="slack"?"gw-slack-fixture":scopedTask(channel+"-default","chat");
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
  const originalAccountTask = scopedTask("feishu-default","chat");
  const originalAccountHistory = await durable.history(originalAccountTask);
  (gateway as any).adapters.get("feishu-default").workConnectionKey=()=>"b".repeat(64);
  const otherAccountReplies:string[]=[];
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"message-1",text:"OTHER_ACCOUNT",reply:async(text:string)=>{otherAccountReplies.push(text);}});
  assert.deepEqual(otherAccountReplies,["ANSWER:OTHER_ACCOUNT"],"account switch cannot reuse the previous account receipt");
  const otherAccountTask=gatewayInboundIdentity("feishu-default","b".repeat(64),"chat").taskId;
  const otherAccountHistory=await durable.history(otherAccountTask);
  assert.notEqual(otherAccountHistory.cwd,originalAccountHistory.cwd,"account switch gets a separate native workspace");
  assert.equal(readFileSync(join(originalAccountHistory.cwd!,"proof.txt"),"utf8"),"feishu");
  assert.equal(readFileSync(join(otherAccountHistory.cwd!,"proof.txt"),"utf8"),"OTHER_ACCOUNT");
  (gateway as any).adapters.get("feishu-default").workConnectionKey=()=>fixtureConnection;
  console.log("PASS same provider message ID on another account executes in its own native session and workspace");
  const feishuId=scopedTask("feishu-default","chat"); const created=db.getTask(feishuId)!;
  await inbound({channelId:"feishu-default",chatId:"chat",messageId:"message-2",text:"第二条不应当覆盖标题和文件夹",reply:async()=>{}});
  const followed=db.getTask(feishuId)!; assert.equal(followed.title, created.title); assert.equal(followed.spaceId, created.spaceId);
  const keptId=scopedTask("custom-default","kept");
  db.upsertTask({id:keptId,title:"已有会话",welcomeMode:"bot",modePresetId:"native",updatedAt:1});
  await inbound({channelId:"custom-default",chatId:"kept",messageId:"kept-1",text:"后来的消息",reply:async()=>{}});
  assert.equal(db.getTask(keptId)?.title,"已有会话");
  assert.equal(db.getTask(keptId)?.spaceId, gatewayChannelSpaceId("custom-default"));
  const customFolder=db.getSpace(gatewayChannelSpaceId("custom-default"))!;
  assert.equal(customFolder.name, "custom-default"); assert.equal(customFolder.parentId, GATEWAY_ROOT_SPACE_ID); assert.equal(customFolder.path, undefined);
  await inbound({channelId:"custom-default",chatId:"kept",messageId:"kept-2",text:"第二条仍不改标题和文件夹",reply:async()=>{}});
  assert.equal(db.getTask(keptId)?.title,"已有会话"); assert.equal(db.getTask(keptId)?.spaceId, gatewayChannelSpaceId("custom-default"));
  db.createSpace({id:"user-folder",name:"用户自己的"});
  const parkedId=scopedTask("custom-default","parked");
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
  durable=createService(); failAssembly=true;
  const requestsBeforeUnavailablePolicy=requests;
  await assert.rejects(durable.runGatewayTurn(request("HOLD_RESTART")),/FIXTURE_POLICY_UNAVAILABLE/);
  assert.equal(requests,requestsBeforeUnavailablePolicy,"recovery cannot execute with missing permission hooks");
  failAssembly=false;
  assert.equal(await durable.runGatewayTurn(request("HOLD_RESTART")),"ANSWER:HOLD_RESTART");assert.equal(effects,effectsBeforeRestart);
  const afterRestart=requests;assert.equal(await durable.runGatewayTurn(request("SECOND")),"ANSWER:SECOND");assert.equal(requests,afterRestart);
  assert.deepEqual(db.getTask(legacy!.id),legacy);
  console.log("PASS checkpoint/reopen reacquires native receipts, with no unsafe replay, no duplicate old input and no legacy migration");
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
}finally{await gateway.stop();await durable.close();db.close();}
console.log("GATEWAY_DURABLE_TESTS_PASSED",root);
