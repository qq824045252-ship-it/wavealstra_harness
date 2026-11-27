import {observeDotsWireEvidence, type DotsMemoryToolReceipt} from "./dots-memory-wire-evidence";
import {MemoryService} from "../src/main/memory/MemoryService";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { DOTS_TASK_ID } from "../src/shared/dots";

export function configuredAnswerModel() {
  const configured = process.env.DOTS_MEMORY_MODEL_PROFILE;
  if (!configured) throw new Error("Set DOTS_MEMORY_MODEL_PROFILE to an existing authorized MyBuddy model profile");
  const source = resolve(configured);
  const settings = JSON.parse(readFileSync(join(source,"settings.json"),"utf8"));
  const modelId = process.env.DOTS_MEMORY_ANSWER_MODEL ?? settings.defaultProvider+"/"+settings.defaultModel;
  assert(settings.enabledModels?.includes(modelId), "Answer model must already be enabled in the supplied profile");
  const separator = modelId.indexOf("/");
  const provider = modelId.slice(0,separator), model = modelId.slice(separator+1);
  const catalog = JSON.parse(readFileSync(join(source,"models.json"),"utf8"));
  const selected = catalog.providers?.[provider];
  assert(selected?.baseUrl, "Configured provider is missing an endpoint");
  assert(selected.models?.some((entry:{id:string})=>entry.id===model), `Selected model ${modelId} is absent from the current provider catalog; refusing automatic substitution`);
  const origin = new URL(selected.baseUrl).origin;
  return {source,modelId,provider,model,selected,origin};
}

function safeDetail(detail:unknown): string {
  return String(detail??"unavailable").replace(/(?:Bearer|Basic)\s+[^\s"',]+/gi,"[redacted]")
    .replace(/(api[_-]?key|access[_-]?token|authorization|password)(["':=\s]+)[^\s,"'}]+/gi,"$1=[redacted]")
    .replace(/(?:sk-|eyJ)[A-Za-z0-9_.-]{12,}/g,"[redacted]").slice(0,600);
}

export async function realDotsAnswer(db: AppDatabase, question: string, questionDate: string, expectedConfig:string) {
  const {source,modelId,provider,model,selected,origin}=configuredAnswerModel();
  const {createHash}=await import("node:crypto");
  if(createHash("sha256").update(JSON.stringify(selected)).digest("hex")!==expectedConfig) throw new Error("Provider catalog changed during this batch; refusing to switch models");
  const isolated = mkdtempSync(join(tmpdir(),"dots-independent-answer-"));
  const dir = join(isolated,".mybuddy");
  const previous = { HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE };
  const realFetch = globalThis.fetch;
  const witnessed = new Set<string>();
  const excerpts = new Map<string, Set<string>>();
  let requests = 0;
  let attemptedModel: string | undefined;
  let routeFailure: string | undefined;
  let httpStatus: number | undefined;
  const memory=new MemoryService(db,{semantic:false});
  const toolReceipts=new Map<string,DotsMemoryToolReceipt>();
  let agent: import("../src/main/agent/AgentService").AgentService | undefined;
  try {
    process.env.HOME=isolated; process.env.USERPROFILE=isolated;
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"models.json"), JSON.stringify({ providers:{[provider]:selected} }));
    if (existsSync(join(source,"auth.json"))) {
      const auth = JSON.parse(readFileSync(join(source,"auth.json"),"utf8"));
      writeFileSync(join(dir,"auth.json"),JSON.stringify(auth[provider] ? {[provider]:auth[provider]} : {}),{mode:0o600});
    }
    writeFileSync(join(dir,"settings.json"),JSON.stringify({defaultProvider:provider,defaultModel:model,enabledModels:[modelId],
      memoryEnabled:true,automaticSemanticRecall:false,cacheWarming:"off",retry:{enabled:false,maxRetries:0}}));
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const watched = /\/(completions|responses|messages)(?:\/|$)/.test(url.pathname);
      if (watched) {

        const body = typeof init?.body==="string" ? init.body : input instanceof Request ? await input.clone().text() : "";
        // Only store provenance from supplied history, never authentication, answer priors or raw provider bodies.
        const payload = JSON.parse(body);
        attemptedModel=String(payload.model);
        if(url.origin!==origin || (attemptedModel!==model && attemptedModel!==modelId)){
          routeFailure="Model dispatch changed from "+modelId+" to "+attemptedModel;
          throw new Error(routeFailure);
        }
        requests++;
        const evidence=observeDotsWireEvidence(payload.messages ?? payload.input ?? [], id=>{
          const atom=memory.getForRecall(id,{taskId:DOTS_TASK_ID,statuses:["active"]});
          const revision=atom && memory.history(id)[0]?.revision;
          return atom?.status==="active" && revision
            ? { revision, title:atom.title, content:atom.content, source:memory.getDotsRevisionSource(id,revision) } : undefined;
        });
        for(const witness of evidence.witnesses)witnessed.add(witness);
        for (const { reference, text } of evidence.excerpts) {
          const shown = excerpts.get(reference) ?? new Set<string>();
          shown.add(text);
          excerpts.set(reference, shown);
        }
        for(const call of evidence.calls) toolReceipts.set(call.callId,call);
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const response = await realFetch(input,watched ? {...init, signal:AbortSignal.any([AbortSignal.timeout(180_000),...(signal?[signal]:[])])} : init);
      if(watched) httpStatus=response.status;
      return response;
    };
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { AgentService } = await import("../src/main/agent/AgentService");
    const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
    const runtime = await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-cache.json"),allowModelNetwork:false,refreshOnCreate:false});
    await runtime.refresh({allowNetwork:false});
    agent = new AgentService(db,new TaskExecutionWorkspace(join(isolated,"tasks")),{models:runtime});
    const { DotsDelegations } = await import("../src/main/dots/DotsDelegations");
    const { DotsActions } = await import("../src/main/dots/DotsActions");
    const { fixtureTaskBoard } = await import("./fixtures/legacy-task-board-store");
    new (await import("../src/main/artifact/ArtifactRepository")).ArtifactRepository(db.connection);
    const active = agent;
    const journal = new DotsDelegations(db.connection,(...args)=>active.dotsSubmission(...args),()=>{});
    active.setDotsActions(new DotsActions(db,active,{link:(...args)=>journal.link(...args),list:()=>journal.list(),failed:(...args)=>journal.failed(...args)}, fixtureTaskBoard(db.connection)));
    await agent.init(); await agent.resumePersistedTasks();
    assert(questionDate?.trim(),"Missing annotated question time");
    const prompt = "Question time from the original conversation: "+questionDate+"\n"+question+"\nAnswer in English using only the original conversation evidence supplied by Dots. Return one JSON object with answer (short factual answer, or null when evidence is insufficient), abstain (boolean), and citations (array of the exact L1 memory ID@revision supporting your answer, including counterevidence if applicable). Do not use outside knowledge.";
    const result = await agent.prompt({taskId:DOTS_TASK_ID,modelId,userMessageId:"independent-question",assistantMessageId:"independent-answer",text:prompt,displayText:question});
    assert(result.receipt, "No native submission receipt");
    const settled = await agent.waitForSubmission(result.receipt);
    const history = await agent.loadTaskHistory(DOTS_TASK_ID);
    const answer = history.messages.filter(m=>m.role==="assistant").at(-1);
    if(settled.receipt?.status!=="done" || !answer?.text || httpStatus!==200 || !requests)
      throw new Error(`Dots unsuccessful: receipt=${settled.receipt?.status}, native=${settled.error?.code??"none"} ${safeDetail(settled.error?.message)}, cancelled=${settled.cancelled??false}, model=${modelId}, attempted=${safeDetail(attemptedModel)}, sent=${requests}, HTTP=${httpStatus??"unobserved"}, route=${safeDetail(routeFailure)}`);
    return {modelId,attemptedModel,toolReceipts:[...toolReceipts.values()], text:answer.text, witnessed:[...witnessed], excerpts, requests, httpStatus};
  } finally {
    try { await agent?.closeDurableBots(); agent?.dispose(); } finally {
      globalThis.fetch=realFetch;
      for(const [key,value] of Object.entries(previous)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
      rmSync(isolated,{recursive:true,force:true,maxRetries:3,retryDelay:50});
    }
  }
}
