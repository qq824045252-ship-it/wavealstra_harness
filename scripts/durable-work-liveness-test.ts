import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { durableWorkRuntimeState } from "../src/main/agent/durable/DurableWorkRuntimeState";
import { readDurableWorkExecution } from "../src/main/agent/durable/DurableWorkExecutionProjection";
import { WorkRuntimeObservation } from "../src/main/agent/work/WorkRuntimeObservation";

const model: any = { id:"liveness", name:"liveness", provider:"fixture", api:"openai-completions", reasoning:false,
  input:["text"], contextWindow:128000, maxTokens:1024, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
const ref = { provider:model.provider, modelId:model.id };
function models(root: string, hang: boolean, unknown = false): any {
  const api: any = { getAuth:async()=>undefined, getModel:()=>model,
    streamSimple: (_model: any, context: any) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const wrote = context.messages.some((message: any)=>message.role==="toolResult" && message.toolName===(unknown ? "hold_effect" : "bash") && (unknown || !message.isError));
        if (wrote && hang && !unknown) { await writeFile(join(root,"waiting-model"),"persisted file tool result"); return; }
        const content = wrote ? [{type:"text",text:"finished after host recovery"}] : [{type:"toolCall",id:"write-once",name:unknown ? "hold_effect" : "bash",arguments:unknown ? {} : {command:"printf 'one\\n' >> effect.txt"}}];
        const stopReason = wrote ? "stop" : "toolUse";
        const message: any = { role:"assistant",content,stopReason,api:model.api,model:model.id,provider:model.provider,timestamp:Date.now(),
          usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
        stream.push({type:"done",reason:stopReason,message}); stream.end();
      })().catch(error=>{ console.error(error); process.exitCode=1; });
      return stream;
    } };
  api.completeSimple=(m:any,c:any,o:any)=>api.streamSimple(m,c,o).result();
  return api;
}
async function open(root: string, hang: boolean, unknown = false) {
  return DurableBotRuntime.open({ directory:join(root,"state"),cwd:root,model:ref,models:models(root,hang,unknown),toolMode:"native",
    ...(unknown ? {tools:[defineTool({name:"hold_effect",description:"isolated unsafe effect",parameters:Type.Object({}),replay:"unsafe",
      execute:async(_args,_api,context)=>{
        const before=await readFile(join(root,"effect.txt"),"utf8").catch(()=>"");
        await writeFile(join(root,"effect.txt"),before+"one\n");
        await writeFile(join(root,"waiting-model"),"effect happened without committed result");
        await new Promise<void>((_resolve,reject)=>context.abortSignal?.addEventListener("abort",()=>reject(new Error("host closed")),{once:true}));
        return {output:[{type:"text",text:"unreachable"}]};
      }})]} : {}),
    instructions:()=>"isolated process recovery fixture",onSnapshot:()=>{} });
}
async function until(fn:()=>Promise<boolean>, label:string) {
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) { if(await fn())return; await new Promise(resolve=>setTimeout(resolve,30)); }
  throw new Error(`Timed out: ${label}`);
}
if(process.argv[2]?.startsWith("--child")) {
  const root=process.argv[3]!;
  const runtime=await open(root,true,process.argv[2]==="--child-unknown");
  const submission=await runtime.submit("write once then answer","stable-input");
  await writeFile(join(root,"submission"),String(submission.id));
  // Keep the actual host process alive while its model request is deliberately unresolved.
  setInterval(()=>{},1000);
} else for(const unknown of [false,true]) {
  const root=await mkdtemp(join(tmpdir(),"mybuddy-work-liveness-"));
  await mkdir(root,{recursive:true});
  const child=fork(fileURLToPath(import.meta.url),[unknown ? "--child-unknown" : "--child",root],{stdio:["ignore","pipe","pipe","ipc"]});
  let output=""; child.stdout?.on("data",chunk=>output+=chunk); child.stderr?.on("data",chunk=>output+=chunk);
  let runtime: DurableBotRuntime|undefined;
  try {
    await until(async()=>{try{await access(join(root,"waiting-model"));return true;}catch{return false;}},"native file effect persisted before host exit");
    assert.equal(await readFile(join(root,"effect.txt"),"utf8"),"one\n");
    const exited=once(child,"exit"); child.kill("SIGKILL"); await exited;
    runtime=await open(root,false,unknown);
    const id=Number(await readFile(join(root,"submission"),"utf8")) as SubmissionId;
    const submission=await runtime.harness.submission(id,ctx); assert(submission);
    const persisted=await submission.status(ctx);
    assert(["placed","queued"].includes(persisted.status),"pending input survives host exit");
    const before=durableWorkRuntimeState(await runtime.harness.inspect(ctx));
    assert.equal(before.runtimeState,"recovering","reopened native scheduler is paused, not running");
    const observed=await runtime.conversation.commit(tx=>readDurableWorkExecution(tx,persisted,root),ctx);
    assert.equal(observed.status,"running","business status remains nonterminal; never infer success from host exit");
    // Real service startup race: a foreground read opens the second queued store
    // while the one-slot recovery queue is still opening the first store.
    const db=new AppDatabase(join(root,"app.db"));
    const service=new DurableBotService({db,agentDir:root,mcpDir:join(root,"mcp"),models:models(root,false),
      resolveCwd:()=>root,instructions:()=>"fixture",toolMode:()=>"native",defaultModel:()=>undefined,emit:()=>{},resumeConcurrency:1});
    for(const taskId of ["first","target"]) {
      db.upsertTask({id:taskId,title:taskId,updatedAt:Date.now()});
      db.connection.prepare("INSERT INTO durable_bot_bindings VALUES (?, 'pi-durable', ?, ?)").run(taskId,join(root,taskId),root);
    }
    let releaseFirst!:()=>void;
    const firstOpening=new Promise<void>(resolve=>{releaseFirst=resolve;});
    const host:any=service;
    host.openBound=async(taskId:string)=>taskId==="first" ? (await firstOpening,{runtime:{resume:()=>{}}}) : {runtime};
    if (!unknown) {
      const draining=service.resumePersisted();
      await host.open("target"); // equivalent entry used by history(), no model call
      assert.equal(durableWorkRuntimeState(await runtime.harness.inspect(ctx)).runtimeState,"recovering");
      releaseFirst(); await draining;
      assert(service.lastResumeReport?.delivered.includes("target"),"foreground open must not steal queued resume obligation");
    } else {
      // A failed Session can reopen after the startup queue has drained. Polling
      // must hand the existing receipt back to native recovery, not resubmit it.
      const binding:any={taskId:"target",workspaceBinding:root};
      const receipt:any={submissionId:id,operationId:"stable-input"};
      host.workSubmission=async()=>({open:{runtime},record:await submission.status(ctx)});
      host.options.resumeAllowed=()=>false;
      await service.workExecutionPort().inspect(binding,receipt);
      assert.equal((await runtime.harness.inspect(ctx)).scheduling,"paused","authority/lifecycle exclusion never auto resumes");
      host.options.resumeAllowed=()=>true;
      const observation=await service.workExecutionPort().inspect(binding,receipt);
      assert.equal(observation.status,"running");
      assert(observation.status==="running" && observation.runtimeState==="recovering","first read reports prior paused fact honestly");
      assert.equal((await runtime.harness.inspect(ctx)).scheduling,"running","later reopened host hands same receipt back to scheduler");
    }
    db.close();
    const state=await Promise.race([submission.wait(ctx),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("resume timed out")),20000).unref())]);
    assert.equal(state.status,"done");
    assert.equal(await readFile(join(root,"effect.txt"),"utf8"),"one\n","committed write is never duplicated by restart");
    console.log(unknown ? "PASS real child killed after unsafe effect; unknown action not replayed" : "PASS real child host killed mid-model request; persisted input reopened paused; same receipt resumes; committed file effect not replayed",root);
    const binding:any={bindingId:"binding",status:"running"};
    let facts=new WorkRuntimeObservation(()=>[binding]);
    facts.record(binding,{status:"running",runtimeState:"running",runtimeReason:"actual invocation"});
    assert.equal(facts.forWork("work")[0]?.state,"running");
    facts=new WorkRuntimeObservation(()=>[binding]);
    assert.equal(facts.forWork("work")[0]?.state,"recovering","new host must not inherit stale running claim");
    facts.readFailed(binding,new Error("storage unavailable"));
    assert.equal(facts.forWork("work")[0]?.state,"interrupted");
    for(const scheduling of ["paused","closing"] as const) assert.notEqual(durableWorkRuntimeState({scheduling,tasks:[],submissions:[]}).runtimeState,"running");
    assert.equal(durableWorkRuntimeState({scheduling:"running",tasks:[],submissions:[]}).runtimeState,"waiting");
    console.log("PASS process-local state resets, read failures remain nonterminal, no invocation is not running");
  } catch(error) { console.error(output); throw error; }
  finally { if(child.exitCode===null && child.signalCode===null)child.kill("SIGTERM"); await runtime?.close(); }
}
