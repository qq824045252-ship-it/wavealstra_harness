import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { BotWorkResultTurn, type WorkResultTurnInput } from "../src/main/agent/work/BotWorkResultTurn";
import { workResultArtifactSelection } from "../src/main/agent/work/WorkResultArtifactSelection";

const refs = ["/snap/ce-bEUAMi/甲/报告.md", "/snap/ce-BEUAMi/乙/报告.md", "/snap/café/报告.md"];
const input: WorkResultTurnInput = {eventId:"completion:work-a:binding-a:review",botId:"owner",personalPreferences:"",
  context:{workId:"work-a",availableFiles:refs.map(ref=>({ref,name:"报告.md"})),
    artifactEvidence:[{ref:refs[0],state:"text",text:"TODO: missing user material",trust:"untrusted_artifact_content"},
      {ref:refs[1],state:"unavailable",reason:"binary content not inspected"}],
    results:[{summary:"Candidate claims complete",artifactRefs:refs}],reviewAt:10,
    temporalContext:{reviewAt:"2026-11-11T10:00:00Z",observedAt:"2026-11-10T10:00:00Z"}}};
const frozen = JSON.stringify(input);
const selection = workResultArtifactSelection(input);
const ids = selection.context.availableFiles.map(file=>file.selectionId);
assert.equal(new Set(ids).size,refs.length,"same basename and case-distinct paths have different IDs");
assert(ids.every(id=>/^file-[a-f0-9]{16}-[1-9]\d*$/.test(id)));
assert.deepEqual(selection.resolve([ids[2],ids[0],ids[2],refs[1]]),[refs[2],refs[0],refs[1]],"exact immutable refs, order and dedup");
assert.deepEqual(selection.resolve(["file-unknown-1",ids[0].toUpperCase(),refs[0].replace("ce-bEUAMi","ce-beuami"),
  "报告.md",refs[2].normalize("NFD")," "+ids[0],refs[0]+" ","/snap/foreign/报告.md"]),[],"never normalize case, Unicode, whitespace or guess basenames");
assert.deepEqual(selection.resolve([]),[]); assert.equal(selection.resolve(undefined),undefined);
assert.equal(JSON.stringify(input),frozen,"do not mutate current host evidence or registry");
assert.deepEqual(selection.context.artifactEvidence,input.context.artifactEvidence,"full actual body and unavailable evidence retained");
assert.deepEqual(selection.resolve([refs[0]]),[refs[0]],"old exact full ref replies remain compatible");
const empty=workResultArtifactSelection({...input,context:{...input.context,availableFiles:[]}});
assert.deepEqual(empty.resolve([...ids,...refs]),[],"evidence refs do not create selectable files");
const absent=workResultArtifactSelection({...input,context:{artifactEvidence:input.context.artifactEvidence}});
assert.deepEqual(absent.resolve(refs),[],"unavailable or omitted registry is not inferred from evidence");
const malformed=workResultArtifactSelection({...input,context:{availableFiles:[null,{ref:refs[0]}, {ref:refs[0],name:"报告.md",selectionId:"forged"}, {ref:refs[0],name:"duplicate"}]}});
assert.equal(malformed.context.availableFiles.length,1); assert.deepEqual(malformed.resolve(["forged"]),[]);
const retry={...input,context:{...input.context,reviewAt:20,temporalContext:{...(input.context.temporalContext as object),reviewAt:"2026-11-11T10:01:00Z"}}};
assert.equal(workResultArtifactSelection(retry).key,selection.key,"retry clocks do not cause another generation");
for (const changed of [
  {...input,eventId:"completion:other:review"}, {...input,botId:"other-owner"}, {...input,personalPreferences:"concise"},
  {...input,context:{...input.context,workId:"other-work"}},
  {...input,context:{...input.context,availableFiles:[...input.context.availableFiles as object[]].reverse()}},
  {...input,context:{...input.context,artifactEvidence:[{ref:refs[0],state:"changed"}]}},
  {...input,context:{...input.context,results:[{summary:"New actual result"}]}},
  {...input,context:{...input.context,temporalContext:{...(input.context.temporalContext as object),observedAt:"2026-11-11T10:00:00Z"}}},
]) {
  const next=workResultArtifactSelection(changed);
  assert.notEqual(next.key,selection.key); assert.deepEqual(next.resolve(ids),[],"old IDs cannot alias into another event, owner, Work or evidence context");
}
console.log("PASS artifact selectors: exact refs, duplicate basenames, case/Unicode, unknown IDs, no guessing, preserved evidence, retry clock/context identity");

// Exercise the real durable review submission/cache and production decoder. The
// fake stream is local and cannot call a provider or any business tool.
const root=mkdtempSync(join(tmpdir(),"result-artifact-selection-"));
let calls=0;
let lastRequest: TranscriptContext | undefined;
let lastContext: any;
let respond=(current:any):unknown=>({decision:"deliver",outcome:"partial",reply:"Still missing required material.",missing:[],
  artifactRefs:[current.availableFiles[2].selectionId,current.availableFiles[0].selectionId]});
const catalog=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,
  modelsStorePath:join(root,"catalog.json"),allowModelNetwork:false,refreshOnCreate:false});
catalog.registerProvider("fixture",{api:"openai-completions",apiKey:"fixture-only",baseUrl:"http://127.0.0.1:1",
  models:[{id:"fixture",name:"fixture",reasoning:false,input:["text"],contextWindow:131072,maxTokens:2048,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple:(model,request)=>{
    calls++; lastRequest=request;
    const message=request.messages.filter(message=>message.role==="user").at(-1)!;
    const text=typeof message.content==="string" ? message.content : message.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
    lastContext=JSON.parse(text);
    const stream=createAssistantMessageEventStream();
    queueMicrotask(()=>{
      const reply:AssistantMessage={role:"assistant",content:[{type:"text",text:JSON.stringify(respond(lastContext))}],stopReason:"stop",
        api:model.api,model:model.id,provider:model.provider,timestamp:Date.now(),
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:"done",reason:"stop",message:reply}); stream.end();
    });
    return stream;
  }});
const open=()=>new BotWorkResultTurn({models:catalog,directory:join(root,"reviews"),defaultModel:()=>"fixture/fixture",botModel:()=>"fixture/fixture",isAuthority:()=>true});
let turn=open();
try {
  const first=await turn.review(input);
  assert.deepEqual(first.artifactRefs,[refs[2],refs[0]],"production output never exposes selector aliases");
  assert.equal(first.outcome,"partial"); assert.equal(first.reply,"Still missing required material.");
  assert.equal(calls,1); assert.deepEqual(lastContext.artifactEvidence,input.context.artifactEvidence);
  assert.deepEqual(lastContext.results,input.context.results);
  assert(getCurrentSystemPrompt(lastRequest!.messages).includes("selectionId"));
  assert.equal(getCurrentTools(lastRequest!.messages).length,0,"review has no business tools");
  const originalIds=lastContext.availableFiles.map((file:any)=>file.selectionId);
  await turn.close(); turn=open();
  assert.deepEqual(await turn.review(retry),first,"reopened same-event retry returns cached verdict with the same true refs");
  assert.equal(calls,1,"retry clock changes do not trigger another model call");
  const changed={...input,context:{...input.context,availableFiles:[{ref:"/snap/new/报告.md",name:"报告.md"}]}};
  respond=()=>({decision:"deliver",outcome:"unknown",reply:"Needs current evidence.",missing:[],artifactRefs:[originalIds[0],refs[0]]});
  assert.deepEqual((await turn.review(changed)).artifactRefs,[],"same-event changed registry neither reuses prior decision nor resolves old IDs/paths");
  assert.equal(calls,2);
  const unavailable={...changed,context:{...changed.context,artifactEvidence:[{ref:"/snap/new/报告.md",state:"unavailable",reason:"file missing"}]}};
  respond=current=>({decision:"deliver",outcome:"unknown",reply:"The file cannot be verified.",missing:[],artifactRefs:[current.availableFiles[0].selectionId]});
  const unavailableResult=await turn.review(unavailable);
  assert.equal(calls,3); assert.equal(unavailableResult.outcome,"unknown");
  assert.deepEqual(lastContext.artifactEvidence,unavailable.context.artifactEvidence,"unavailability reaches the model unchanged, not promoted to completion");
  respond=current=>({decision:"deliver",outcome:"completed",reply:"Done.",missing:[],artifactRefs:[current.availableFiles[0].ref]});
  assert.deepEqual((await turn.review({...input,eventId:"exact-old-ref"})).artifactRefs,[refs[0]]);
  respond=()=>({decision:"deliver",outcome:"partial",reply:"No primary selection.",missing:[]});
  const omitted=await turn.review({...input,eventId:"omitted"}); assert(!("artifactRefs" in omitted));
  respond=current=>({decision:"deliver",outcome:"partial",reply:"Continuous current result.",missing:[],artifactRefs:[current.availableFiles[1].selectionId]});
  assert.deepEqual((await turn.review({...input,eventId:"continuous",context:{...input.context,watchSupervision:true,executionMode:"continuous"}})).artifactRefs,[refs[1]]);
  respond=()=>({outcome:"partial",reply:"Observe current result.",artifactRefs:["unexpected-selection"]});
  const watch=await turn.review({...input,eventId:"observe",context:{...input.context,watchSupervision:true}});
  assert(!("artifactRefs" in watch),"observe parser does not gain the unrelated selection field");
  assert(!lastContext.availableFiles[0].selectionId,"observe submission not rewritten");
  assert.equal(watch.decision,"deliver"); assert.deepEqual(watch.missing,[]);
  const beforeWatchRetry=calls;
  await turn.review({...input,eventId:"observe",context:{...input.context,watchSupervision:true,reviewAt:100}});
  assert.equal(calls,beforeWatchRetry,"observe cache remains event-only");
  respond=()=>({decision:"deliver",outcome:"partial",reply:"Continuous without file registry.",missing:[]});
  const withoutRegistry={eventId:"continuous-no-registry",botId:input.botId,context:{watchSupervision:true,executionMode:"continuous",artifactEvidence:input.context.artifactEvidence,reviewAt:10}};
  assert(!("artifactRefs" in await turn.review(withoutRegistry)));
  assert(!("availableFiles" in lastContext),"production continuous registry omission is not synthesized from evidence");
  const beforeContinuousRetry=calls;
  await turn.review({...withoutRegistry,context:{...withoutRegistry.context,reviewAt:20}});
  assert.equal(calls,beforeContinuousRetry,"continuous without explicit registry keeps its existing cache");
  console.log("PASS production BotWorkResultTurn: local fake stream, real durable cache/reopen, immutable refs, changed evidence, old refs, omitted selection, once/continuous/observe isolation");
} finally { await turn.close(); rmSync(root,{recursive:true,force:true}); }
