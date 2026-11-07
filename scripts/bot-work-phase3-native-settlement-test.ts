import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import {createHash} from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService,DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import {WorkResourceGate,fileResource} from "../src/main/agent/work/WorkResourceGate";
import {WorkResourceRecovery} from "../src/main/agent/work/WorkResourceRecovery";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { DEFAULT_BOT_ID,LOCAL_USER_ID,type WorkActor,type WorkControlResult,type WorkDto } from "../src/shared/bot-work";

const childMode=process.argv[2]==="--crash-child" || process.argv[2]==="--recover-child";
const root=childMode?process.argv[3]!:await mkdtemp(join(tmpdir(),"phase3-native-partial-")),agentDir=join(root,"agent"),cwd=join(root,"workspace"),database=join(root,"business.db");
const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
await mkdir(join(agentDir,"agents"),{recursive:true});await mkdir(cwd,{recursive:true});
await writeFile(join(agentDir,"agents","worker.md"),"---\nname: worker\ndescription: deterministic actual effect worker\ntools: proof\n---\nPerform the assigned proof once.\n");
await writeFile(join(agentDir,"settings.json"),JSON.stringify({defaultProvider:"fixture",defaultModel:"root",enabledModels:["fixture/root","fixture/child"]}));
const models=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,modelsStorePath:join(root,"models.json"),refreshOnCreate:false});
const content=(input:TranscriptContext["messages"][number]["content"])=>typeof input==="string"?input:input.flatMap(block=>block.type==="text"?[block.text]:[]).join("\n");
let sequence=0;
models.registerProvider("fixture",{api:"openai-completions",apiKey:"local-fixture",baseUrl:"http://127.0.0.1:1",models:["root","child"].map(id=>({id,name:id,reasoning:false,input:["text"],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})),
  streamSimple:(model,request)=>{
    const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
      const last=request.messages.at(-1),user=[...request.messages].reverse().find(message=>message.role==="user"),input=user?content(user.content):"";
      let blocks:AssistantMessage["content"];
      if(last?.role==="toolResult") blocks=[{type:"text",text:model.id==="child"?"actual item complete":"root result, individual scope still requires review"}];
      else if(model.id==="child") {
        const item=["retain-one","gap-two","gap-three"].find(marker=>input.includes(marker));assert(item);
        blocks=[{type:"toolCall",id:`effect-${++sequence}`,name:"proof",arguments:{item}}];
      } else if(input.includes("source-work")) {
        blocks=[{type:"toolCall",id:`source-effect-${++sequence}`,name:"proof",arguments:{item:input.includes("latest-source-work")?"source-latest":"source-event"}}];
      } else if(input.includes("artifact-check:") && input.includes("只完成以下已受理")) {
        blocks=[{type:"toolCall",id:`artifact-read-${++sequence}`,name:"read",arguments:{path:join(cwd,"retain-one.txt")}}];
      } else {
        const continuation=input.includes("只完成以下已受理");
        const tasks=continuation?[{agent:"worker",task:"gap-two",model:"fixture/child",isolation:"shared"},{agent:"worker",task:"gap-three",model:"fixture/child",isolation:"shared"}]
          :[{agent:"worker",task:"retain-one",model:"fixture/child",isolation:"shared"},{agent:"missing-worker",task:"gap-two",model:"fixture/child",isolation:"shared"},{agent:"worker",task:"gap-three",model:"fixture/child",isolation:"shared"}];
        blocks=[{type:"toolCall",id:`dispatch-${++sequence}`,name:"subagent",arguments:{chain:tasks}}];
      }
      const stopReason=blocks.some(block=>block.type==="toolCall")?"toolUse":"stop";
      const tokens=model.id==="child"?7:5;
      const message:AssistantMessage={role:"assistant",content:blocks,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:tokens-2,output:2,cacheRead:0,cacheWrite:0,totalTokens:tokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:"done",reason:stopReason,message});stream.end();
    });return stream;
  }});
const grants={...DESKTOP_USER_GRANTS,allowedScopes:["workspace:read","workspace:write","delegate"],allowRedelegation:true};
let db=new AppDatabase(database),bots=new BotRegistry(db.connection);bots.registerBot({userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:"fixture",authorization:grants});
let works=new WorkService(db.connection,{bots});
const actor:WorkActor={kind:"user",userId:LOCAL_USER_ID,grants};
const unwrap=(result:WorkControlResult)=>{if(!result.ok)throw Error(`${result.code}: ${result.message}`);return result.work;};
const guard=(work:WorkDto)=>({expectedStateVersion:work.stateVersion,expectedIntentRevision:work.intentRevision,expectedOwnerEpoch:work.ownerEpoch});
const errors:unknown[]=[];
const setup=()=>{
  const native=new DurableBotService({db,models,agentDir:join(root,"native"),mcpDir:join(root,"mcp"),resolveCwd:()=>cwd,instructions:()=>"perform only the assigned necessary scope",defaultModel:()=>"fixture/root",toolMode:()=>"native",toolAllowed:()=>true,mcpSelection:()=>[],
    beforeSubmit:request=>{const blocked=works.checkTaskInput(request.taskId,request.userMessageId);if(blocked)throw Error(blocked);},
    tools:async task=>{
      const policy=createDurableToolPolicy({taskId:task.id,taskRoot:cwd,getPermissionMode:()=>"auto",interactions:new ConversationInteractionService(new ConversationInteractionRepository(db.connection),()=>{}),attempts:new ExecutionAttemptRepository(db.connection),failures:new ExecutionFailureRepository(db.connection),admitWorkAction:input=>works.admitTaskAction(task.id,input),settleWorkAction:(operationId,outcome)=>works.settleTaskAction(task.id,operationId,outcome)});
      return {contextHooks:[],toolHooks:policy.hooks,tools:[defineTool({name:"proof",description:"append actual isolated fixture effect",parameters:Type.Object({item:Type.String()}),replay:"unsafe",execute:async({item})=>{
        assert(["retain-one","gap-two","gap-three","source-event","source-latest"].includes(item));const file=join(cwd,`${item}.txt`);appendFileSync(file,`${item}\n`);return {output:[{type:"text",text:`actual ${item} effect`}],details:{artifactRefs:[file]}};
      }}),...createDurableSubagentTools({taskId:task.id,cwd,models,permissionMode:()=>"auto"})]};
    },emit:()=>{}});
  const adapter=new WorkExecutionAdapter(works,native.workExecutionPort(),LOCAL_USER_ID,()=>true,(_binding,error)=>errors.push(error));
  const queue=new WorkDispatchQueue(db,works,adapter,()=>true,()=>"fixture/root");return {native,adapter,queue};
};
let runtime=setup();
const wait=async(predicate:()=>boolean)=>{const end=Date.now()+20000;while(!predicate()){if(Date.now()>end)throw Error(`native partial timeout ${errors.map(String).join(";")}`);await runtime.queue.flush();await delay(15);}};

async function crashChild(point:string,arm:boolean) {
  db.connection.exec("DROP TRIGGER IF EXISTS phase3_crash_partial; DROP TRIGGER IF EXISTS phase3_crash_dispatch; DROP TRIGGER IF EXISTS phase3_crash_native;");
  const halt=()=>{process.stdout.write(`CHECKPOINT:${point}\n`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
  db.connection.function("phase3_checkpoint",()=>{halt();return 0;});
  let work=works.listWorks(LOCAL_USER_ID,{includeClosed:true})[0];
  if(!work) {
    work=unwrap(works.createWork(actor,{operationId:"crash-create",title:"crash-work retain-one plus gap-two and gap-three",inputSnapshotId:"crash-input",workspacePath:cwd,authorization:grants,budget:{maxTokens:2000}}));
    works.transaction(()=>runtime.queue.enqueue(work,"crash-original"));
  }
  if(arm && point==="partial-consume") db.connection.exec(`CREATE TRIGGER phase3_crash_partial BEFORE INSERT ON work_subitem_results WHEN json_extract(NEW.result_json,'$.outcome')='not_started' BEGIN SELECT phase3_checkpoint(); END;`);
  if(works.getWork(work.workId)!.budget.usedTokens<24) {await runtime.queue.flush();await wait(()=>works.getWork(work.workId)!.budget.usedTokens>=24);}
  const original=works.repo.listBindings(work.workId)[0];
  if(!works.partialResults.plans(work.workId).length) unwrap(works.continueWork(actor,{operationId:"crash-continue",workId:work.workId,sourceBindingId:original.bindingId,gapItemIds:works.partialResults.gaps(work.workId).map(item=>item.itemId),reason:"recovered gap plan",versionGuard:guard(works.getWork(work.workId)!)}));
  if(arm && point==="continuation-intent") halt();
  if(arm && point==="continuation-request") db.connection.exec(`CREATE TRIGGER phase3_crash_dispatch BEFORE INSERT ON work_execution_bindings WHEN NEW.operation_id LIKE 'dispatch:continuation:%' BEGIN SELECT phase3_checkpoint(); END;`);
  if(arm && point==="native-before-inbox") db.connection.exec(`CREATE TRIGGER phase3_crash_native BEFORE INSERT ON work_native_inbox WHEN json_extract(NEW.payload_json,'$.status')!='running' AND EXISTS (SELECT 1 FROM work_execution_bindings binding JOIN work_dispatch_requests request ON request.task_id=binding.task_id WHERE binding.binding_id=NEW.binding_id AND request.continuation_plan_id IS NOT NULL) BEGIN SELECT phase3_checkpoint(); END;`);
  await runtime.queue.flush();await wait(()=>works.getWork(work.workId)!.budget.usedTokens===62);
  for(let n=0;n<3;n++)await runtime.queue.flush();
  assert.deepEqual(errors,[]);assert.equal(works.repo.listBindings(work.workId).length,2);assert.equal(works.partialResults.plans(work.workId).length,1);assert.equal(works.partialResults.gaps(work.workId).length,0);
  for(const item of ["retain-one","gap-two","gap-three"]) assert.equal(await readFile(join(cwd,`${item}.txt`),"utf8"),`${item}\n`);
  await writeFile(join(root,"recovery-result.json"),JSON.stringify({point,effects:[1,1,1],bindings:works.repo.listBindings(work.workId).map(binding=>({taskId:binding.taskId,store:binding.durableStoreKey,conversationId:binding.conversationId,operationId:binding.operationId})),budget:works.getWork(work.workId)!.budget,planCount:works.partialResults.plans(work.workId).length}));
  console.log(`PASS SIGKILL recovery ${point}: effects1/1/1, bindings2, plans1, usage62`);
}
async function crashMatrix() {
  const reports:unknown[]=[];
  for(const point of ["partial-consume","continuation-intent","continuation-request","native-before-inbox"]) {
    const directory=join(root,`kill-${point}`);await mkdir(directory);
    const run=(mode:string)=>spawn(process.execPath,[fileURLToPath(import.meta.url),mode,directory,point],{stdio:["ignore","pipe","pipe"],windowsHide:true,env:process.env});
    const child=run("--crash-child");let output="",diagnostics="";
    child.stdout.on("data",chunk=>{output+=String(chunk);});child.stderr.on("data",chunk=>{diagnostics+=String(chunk);});
    const ended=new Promise<number|null>(resolve=>child.once("exit",resolve));
    const deadline=Date.now()+30000;
    while(!output.includes(`CHECKPOINT:${point}`)) {if(child.exitCode!==null)throw Error(`child exited ${child.exitCode}: ${output}\n${diagnostics}`);if(Date.now()>deadline){child.kill("SIGKILL");throw Error(`checkpoint timeout ${point}: ${output}\n${diagnostics}`);}await delay(20);}
    assert(child.kill("SIGKILL"));await ended;
    const recover=run("--recover-child");let recovery="",recoveryErrors="";
    recover.stdout.on("data",chunk=>{recovery+=String(chunk);});recover.stderr.on("data",chunk=>{recoveryErrors+=String(chunk);});
    const recovered=await new Promise<number|null>((resolve,reject)=>{const timeout=setTimeout(()=>{recover.kill("SIGKILL");reject(Error(`recovery timeout ${point}`));},30000);recover.once("exit",code=>{clearTimeout(timeout);resolve(code);});});
    assert.equal(recovered,0,`${point}: ${recovery}\n${recoveryErrors}`);assert(recovery.includes(`PASS SIGKILL recovery ${point}`));
    const result=JSON.parse(await readFile(join(directory,"recovery-result.json"),"utf8"));assert.deepEqual(result.effects,[1,1,1]);assert.equal(result.planCount,1);assert.equal(result.budget.usedTokens,62);
    reports.push(result);
    console.log(recovery.trim());
  }
  const evidenceDirectory=join(process.cwd(),"out","diagnostics","bot-work-phase3");await mkdir(evidenceDirectory,{recursive:true});
  await writeFile(join(evidenceDirectory,"native-recovery-results.json"),JSON.stringify(reports,null,2)+"\n");
}
try {
  if(childMode) await crashChild(process.argv[4]!,process.argv[2]==="--crash-child");
  else {
  const initial=unwrap(works.createWork(actor,{operationId:"native-partial",title:"retain-one plus gap-two and gap-three",inputSnapshotId:"native-input-1",workspacePath:cwd,authorization:grants,budget:{maxTokens:2000}}));
  works.transaction(()=>runtime.queue.enqueue(initial,"original-dispatch"));await runtime.queue.flush();
  await wait(()=>works.getWork(initial.workId)?.budget.usedTokens===24);
  const original=works.repo.listBindings(initial.workId)[0],items=works.partialResults.list(initial.workId);
  assert.deepEqual(items.map(item=>item.outcome),["completed","rejected","not_started"]);
  assert(items[0].childConversationId);assert.equal(items[1].childId,undefined);assert.equal(items[2].childId,undefined);
  assert.equal(items[0].artifactRefs[0],join(cwd,"retain-one.txt"));assert.equal(works.partialResults.gaps(initial.workId).length,2);
  assert.equal(await readFile(join(cwd,"retain-one.txt"),"utf8"),"retain-one\n");
  const kept=works.repo.listDeliverables(initial.workId).find(result=>result.deliverableId.startsWith("partial:"));assert(kept);assert.equal(kept.status,"proposed");
  const windowId=works.getWork(initial.workId)!.budget.windowId;
  unwrap(works.continueWork(actor,{operationId:"native-gap-plan",workId:initial.workId,sourceBindingId:original.bindingId,gapItemIds:works.partialResults.gaps(initial.workId).map(item=>item.itemId),reason:"only rejected and unstarted items",versionGuard:guard(works.getWork(initial.workId)!)}));
  // Close/reopen after the durable gap intent but before native dispatch.
  await runtime.queue.close();await runtime.adapter.close();await runtime.native.close();db.close();
  db=new AppDatabase(database);bots=new BotRegistry(db.connection);works=new WorkService(db.connection,{bots});runtime=setup();
  await runtime.queue.flush();await wait(()=>works.getWork(initial.workId)?.budget.usedTokens===62);
  for(let repeat=0;repeat<3;repeat++)await runtime.queue.flush();
  assert.deepEqual(errors,[]);assert.equal(works.repo.listBindings(initial.workId).length,2);assert.equal(works.partialResults.plans(initial.workId).length,1);
  assert.equal(works.partialResults.gaps(initial.workId).length,0);assert.equal(works.getWork(initial.workId)?.budget.windowId,windowId);
  for(const marker of ["retain-one","gap-two","gap-three"])assert.equal(await readFile(join(cwd,`${marker}.txt`),"utf8"),`${marker}\n`,`${marker} external effect happens once`);
  assert.equal(works.getWork(initial.workId)?.lifecycle,"active","native completed is not Work acceptance");
  console.log("PASS real Pi owned children -> native results -> Inbox transaction -> retained partial + rejected/unstarted gaps -> reopen approved gap plan -> one new root; effects 1/1/1, total usage 24+38=62, same budget window");
  const owner={taskId:original.taskId,durableStoreKey:original.durableStoreKey,conversationId:original.conversationId,workspaceBinding:original.workspaceBinding,bindingId:original.bindingId,workId:original.workId};
  const quiet=await runtime.native.resourceQuiescence(owner);assert(quiet.executionStopped);assert(quiet.ownedChildrenStopped);
  const oldGate=new WorkResourceGate(db.connection,{hostId:"native-old-host"});
  const lost=oldGate.acquire({actionId:"native-read-quiet-proof",owner,resources:[fileResource(join(cwd,"retain-one.txt"),"read")]});assert(lost.ok);
  const reopenedDb=new AppDatabase(database),reopenedGate=new WorkResourceGate(reopenedDb.connection,{hostId:"native-recovery-host"});
  try {
    const recovery=new WorkResourceRecovery(reopenedDb.connection,reopenedGate,{inspectExecution:lease=>runtime.native.resourceQuiescence(lease.owner),
      drainInput:async(_lease,execution)=>({queueDrained:execution.executionStopped&&execution.ownedChildrenStopped,inputReleased:true,receipt:`non-input graph drained: ${execution.receipt}`}),
      verifyEffect:async()=>{throw Error("read-only action must not manufacture a mutation receipt");}});
    await recovery.recover();assert.equal(reopenedGate.leaseState(lost.lease),"released");assert(oldGate.validate(lost.lease));
    assert.equal(await readFile(join(cwd,"retain-one.txt"),"utf8"),"retain-one\n");
    await mkdir(join(process.cwd(),"out","diagnostics","bot-work-phase3"),{recursive:true});
    await writeFile(join(process.cwd(),"out","diagnostics","bot-work-phase3","native-resource-recovery.json"),JSON.stringify({owner,token:lost.lease.token,quiet:JSON.parse(quiet.receipt),state:reopenedGate.leaseState(lost.lease)},null,2)+"\n");
    console.log("PASS actual native owned-task graph -> reopened resource gate -> coordinator quarantine recovery; read-only old lease released with graph receipt, old token fenced, effects unchanged");
  } finally {reopenedDb.close();}

  // Actual queue driver consumes the original Inbox and native root; callers do not manually consume.
  const file=join(cwd,"source.txt");await writeFile(file,"source-v1");
  const sourceSnapshot=`sha256:${createHash("sha256").update("source-v1").digest("hex")}`;
  const source=unwrap(works.createWork(actor,{operationId:"source-work",title:"source-work",workspacePath:cwd,inputSnapshotId:sourceSnapshot,
    goalSources:[{sourceType:"file",sourceRef:file,inputSnapshotId:sourceSnapshot,observedAt:Date.now()}],authorization:grants}));
  const subscribed=works.addSubscription(actor,source.workId,{source:"hook",catchUpPolicy:"each",maxQueueDepth:1,maxMergeWaitMs:1});assert(subscribed.ok);assert(subscribed.subscription);
  unwrap(works.pauseWork(actor,{operationId:"pause-source",workId:source.workId,versionGuard:guard(works.getWork(source.workId)!)}));
  for(const id of ["source-event-1","source-event-2"])works.ingestSourceEvent({source:"hook",sourceEventId:id,eventType:"changed",workId:source.workId,subscriptionId:subscribed.subscription.subscriptionId,sourceVersion:id,payload:{businessEvent:id}});
  works.ingestSourceEvent({source:"hook",sourceEventId:"source-event-2",eventType:"changed",workId:source.workId,subscriptionId:subscribed.subscription.subscriptionId,payload:{businessEvent:"source-event-2"}});
  assert.equal(works.repo.listInbox(source.workId).length,1,"backpressure bounds materialized pending queue");
  await writeFile(file,"source-v2");unwrap(works.resumeWork(actor,{operationId:"resume-source",workId:source.workId,versionGuard:guard(works.getWork(source.workId)!)}));
  await runtime.queue.flush();await wait(()=>works.getWork(source.workId)!.budget.usedTokens===20);
  assert.equal(await readFile(join(cwd,"source-event.txt"),"utf8"),"source-event\nsource-event\n");
  assert.equal(works.repo.listBindings(source.workId).length,2,"two real each-event obligations have two immutable input namespaces");
  assert.equal(works.repo.listInbox(source.workId,["processed"]).length,2,"overflow source fact was backfilled and consumed");
  for(let n=0;n<3;n++)await runtime.queue.flush();assert.equal(works.getWork(source.workId)!.budget.usedTokens,20);
  assert(works.repo.listBindings(source.workId)[0].inputSnapshotId!==works.repo.listBindings(source.workId)[1].inputSnapshotId);
  const latest=unwrap(works.createWork(actor,{operationId:"latest-source-work",title:"latest-source-work",workspacePath:cwd,inputSnapshotId:sourceSnapshot,
    goalSources:[{sourceType:"file",sourceRef:file,inputSnapshotId:sourceSnapshot,observedAt:Date.now()}],authorization:grants}));
  const latestSubscription=works.addSubscription(actor,latest.workId,{source:"hook",catchUpPolicy:"latest",maxQueueDepth:8,maxMergeWaitMs:1});assert(latestSubscription.ok);assert(latestSubscription.subscription);
  unwrap(works.pauseWork(actor,{operationId:"latest-source-pause",workId:latest.workId,versionGuard:guard(works.getWork(latest.workId)!)}));
  for(const [id,version] of [["latest-current","v3"],["latest-delayed","v1"]])works.ingestSourceEvent({source:"hook",sourceEventId:id,eventType:"changed",workId:latest.workId,subscriptionId:latestSubscription.subscription.subscriptionId,sourceVersion:version,payload:{version}});
  await writeFile(file,"source-v4");unwrap(works.resumeWork(actor,{operationId:"latest-source-resume",workId:latest.workId,versionGuard:guard(works.getWork(latest.workId)!)}));
  await runtime.queue.flush();await wait(()=>works.getWork(latest.workId)!.budget.usedTokens===10);
  assert.equal(await readFile(join(cwd,"source-latest.txt"),"utf8"),"source-latest\n");assert.equal(works.repo.listBindings(latest.workId).length,1);
  assert.equal(works.getWork(latest.workId)!.inputSnapshotId,`sha256:${createHash("sha256").update("source-v4").digest("hex")}`);
  const unknown=unwrap(works.createWork(actor,{operationId:"unconfigured-source",title:"unconfigured source",inputSnapshotId:"initial",authorization:grants}));
  const unknownSubscription=works.addSubscription(actor,unknown.workId,{source:"hook",catchUpPolicy:"each"});assert(unknownSubscription.ok);assert(unknownSubscription.subscription);
  works.ingestSourceEvent({source:"hook",sourceEventId:"unknown-provider",eventType:"changed",workId:unknown.workId,subscriptionId:unknownSubscription.subscription.subscriptionId});
  await runtime.queue.flush();assert.equal(works.repo.listInbox(unknown.workId,["blocked"]).length,1);assert(works.repo.listOpenBlockers(unknown.workId).some(blocker=>blocker.blockerId.startsWith("source-readback:")));assert.equal(works.repo.listBindings(unknown.workId).length,0);
  console.log("PASS production host loop: original Inbox + actual file source -> source Outbox -> real Pi root; each effects2/roots2 after bounded overflow, latest effect1/root1 despite delayed v1, unknown provider explicitly blocked");

  // External damage creates a read-only revalidation plan instead of repeating the original write.
  await writeFile(join(cwd,"retain-one.txt"),"externally changed version\n");
  const inspection=works.artifacts.capture(initial.workId);assert.equal(works.transaction(()=>works.artifacts.validate(inspection)),false);
  const artifactGap=works.partialResults.gaps(initial.workId).find(item=>item.origin==="artifact_revalidation");assert(artifactGap);
  unwrap(works.continueWork(actor,{operationId:"revalidate-current-artifact",workId:initial.workId,sourceBindingId:artifactGap.bindingId,gapItemIds:[artifactGap.itemId],reason:"read current artifact only",versionGuard:guard(works.getWork(initial.workId)!)}));
  await runtime.queue.flush();await wait(()=>works.getWork(initial.workId)!.budget.usedTokens===72);
  const readBinding=works.repo.listBindings(initial.workId).at(-1)!;assert.deepEqual(readBinding.delegatedScope,["workspace:read"]);
  assert.equal(await readFile(join(cwd,"retain-one.txt"),"utf8"),"externally changed version\n");
  assert.equal(works.partialResults.gaps(initial.workId).filter(item=>item.origin==="artifact_revalidation").length,0);
  const revalidated=works.artifacts.capture(initial.workId);assert.equal(works.transaction(()=>works.artifacts.validate(revalidated)),true);
  console.log("PASS artifact recovery: explicit read-only native root reads current artifact; prior effect not repeated, new fingerprint baseline, current acceptance still separate");
  await runtime.queue.close();await runtime.adapter.close();await runtime.native.close();
  await crashMatrix();
  }
} finally {await runtime.queue.close();await runtime.adapter.close();await runtime.native.close();db.close();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;if(!childMode)await rm(root,{recursive:true,force:true});}
