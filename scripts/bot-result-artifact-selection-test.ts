import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { z } from "zod";
import { BACKGROUND_CONTEXT as storageContext } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import { openDurablePassiveStorage } from "../src/main/agent/durable/DurableStorage";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { BotWorkResultTurn } from "../src/main/agent/work/BotWorkResultTurn";
import { resultDecisionSchema, type WorkResultTurnInput } from "../src/main/agent/work/WorkResultDecision";
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
let respond:(current:any,request:TranscriptContext)=>unknown=(current:any):unknown=>({decision:"deliver",outcome:"partial",reply:"Still missing required material.",missing:[],
  artifactRefs:[current.availableFiles[2].selectionId,current.availableFiles[0].selectionId]});
const catalog=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,
  modelsStorePath:join(root,"catalog.json"),allowModelNetwork:false,refreshOnCreate:false});
catalog.registerProvider("fixture",{api:"openai-completions",apiKey:"fixture-only",baseUrl:"http://127.0.0.1:1",
  models:[{id:"fixture",name:"fixture",reasoning:false,input:["text"],contextWindow:131072,maxTokens:2048,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple:(model,request)=>{
    calls++; lastRequest=request;
    lastContext=request.messages.filter(message=>message.role==="user").flatMap(message=>{
      const text=typeof message.content==="string" ? message.content : message.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
      try { return [JSON.parse(text)]; } catch { return []; } // Skip supplemental context and format feedback.
    }).at(-1);
    assert(lastContext && typeof lastContext==="object","original structured review input remains in transcript");
    const stream=createAssistantMessageEventStream();
    queueMicrotask(()=>{
      const value=respond(lastContext,request);
      const reply:AssistantMessage={role:"assistant",content:[{type:"text",text:typeof value==="string" ? value : JSON.stringify(value)}],stopReason:"stop",
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
  const valid={decision:"deliver",outcome:"partial",reply:"User-specific material is still missing.",missing:[]};
  const gap={task:"Fill missing material",requestExcerpt:"Complete my report"};
  assert(resultDecisionSchema.safeParse(valid).success);
  for(const decision of ["deliver","ask"]) assert(!resultDecisionSchema.safeParse({...valid,decision,missing:[gap]}).success,
    "non-continue missing entries must fail validation, never be silently cleared");
  assert(resultDecisionSchema.safeParse({...valid,decision:"continue",missing:[gap]}).success);
  assert(!resultDecisionSchema.safeParse({...valid,decision:"wait"}).success,"waiting needs an exact original user excerpt");
  assert(!resultDecisionSchema.safeParse({...valid,decision:"wait",outcome:"completed",userInput:{requestExcerpt:"I will provide it later"}}).success);
  assert(resultDecisionSchema.safeParse({...valid,decision:"wait",userInput:{requestExcerpt:"I will provide it later"}}).success);
  respond=(current,request)=>{
    assert(getCurrentSystemPrompt(request.messages).includes("它会关闭一次事项"),"result reviewer sees actual delivery-versus-closure semantics");
    return {...valid,decision:"wait",userInput:{requestExcerpt:"I will provide it later"},artifactRefs:[current.availableFiles[0].selectionId]};
  };
  const waiting=await turn.review({...input,eventId:"promised-user-input-wait",context:{...input.context,
    originalRequest:{userRequest:{messages:[{text:"Prepare a draft first. I will provide it later; keep the same item open."}]}}}});
  assert.equal(waiting.decision,"wait");assert.equal(waiting.outcome,"partial");
  assert.deepEqual(waiting.artifactRefs,[refs[0]],"a real durable wait review preserves the selected immutable partial artifact");
  const hostDeliveryContext={provenance:"host_persisted_delivery_route",responsibility:"host",scope:"reply_to_original_request_only",
    routes:[{channel:"qq",connection:"last_observed_connected",summaryDelivery:{capability:"supported",state:"sent"},fileDelivery:{capability:"unsupported",state:"unsupported"}}]};
  respond=(current,request)=>{
    assert.equal(getCurrentTools(request.messages).length,0,"closure review cannot rerun a business tool or send a channel message");
    assert(getCurrentSystemPrompt(request.messages).includes("不能免除用户要求另发给其他渠道"));
    assert.deepEqual(current.hostDeliveryContext,hostDeliveryContext);
    const otherRecipient=JSON.stringify(current.originalRequest ?? {}).includes("另外发给Discord收件人");
    return {decision:"deliver",outcome:otherRecipient?"partial":"completed",reply:otherRecipient?"另发给 Discord 收件人的业务动作没有执行回执。":"文件已生成核验，QQ文字已发送，但QQ文件不支持且未发送。",
      artifactRefs:[current.availableFiles[0].selectionId],missing:[],...(current.closedWorkReview?{correction:{kind:"host_delivery_responsibility"}}:{})};
  };
  for(const otherRecipient of [false,true]){
    const reviewed=await turn.review({...input,eventId:`host-original-return-${otherRecipient}`,context:{...input.context,hostDeliveryContext,
      originalRequest:{userRequest:{messages:[{text:`生成文件并核验，完成后把结果发回最初QQ。${otherRecipient?"另外发给Discord收件人。":""}`}]}}}});
    assert.equal(reviewed.outcome,otherRecipient?"partial":"completed");
  }
  const reassessed=await turn.review({...input,eventId:"closed-host-delivery-responsibility",context:{...input.context,hostDeliveryContext,
    closedWorkReview:{kind:"host_delivery_responsibility",originalConclusion:"ended_unsuccessfully",originalDecision:{...valid,reply:"文件正确，但执行器没有QQ直发工具。"}}}});
  assert.equal(reassessed.correction?.kind,"host_delivery_responsibility");assert.equal(reassessed.outcome,"completed");
  assert.deepEqual(reassessed.artifactRefs,[refs[0]]);
  const userText=(request:TranscriptContext)=>{
    const message=request.messages.filter(message=>message.role==="user").at(-1)!;
    return typeof message.content==="string" ? message.content : message.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
  };
  const raw="First invalid review raw marker: required personal material is absent.";
  let attempt=0;
  respond=(current,request)=>{
    if(++attempt===1) return raw; // Real SyntaxError, not a JSON string or invented verdict.
    assert.equal(getCurrentTools(request.messages).length,0,"format correction has no business tools");
    assert(request.messages.some(message=>message.role==="assistant" && message.content.some(block=>block.type==="text" && block.text===raw)),
      "the original invalid response is retained in the repair transcript");
    assert.deepEqual(current.artifactEvidence,input.context.artifactEvidence,"same evidence, no new business work");
    const feedback=userText(request);
    assert(feedback.includes("校验问题") && feedback.includes("partial/unknown") && feedback.includes("同一完成程度和语义"));
    return {...valid,artifactRefs:[current.availableFiles[0].selectionId]};
  };
  const malformedInput={...input,eventId:"format-repair-syntax"};
  const beforeRepair=calls;
  const repaired=await turn.review(malformedInput);
  assert.equal(calls,beforeRepair+2); assert.equal(repaired.outcome,"partial"); assert.deepEqual(repaired.artifactRefs,[refs[0]]);
  // Inspect authoritative durable evidence, independently of JSONL/SQLite representation.
  const evidence: unknown[] = [];
  for (const name of readdirSync(join(root,"reviews"), {withFileTypes:true})) {
    if (!name.isDirectory()) continue;
    const storage = await openDurablePassiveStorage(join(root,"reviews",name.name),storageContext);
    assert(storage,"review storage must exist");
    try {
      let conversations: Cursor | undefined;
      do {
        const page = await storage.scanConversations({},100,conversations,storageContext);
        for (const conversation of page.items) {
          let cursor: Cursor | undefined;
          do {
            const entries = await storage.scanEntries({conversationId:conversation.id},100,cursor,storageContext);
            evidence.push(...entries.items); cursor=entries.next;
          } while (cursor);
        }
        conversations=page.next;
      } while (conversations);
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanSubmissions({},100,cursor,storageContext);
        evidence.push(...page.items); cursor=page.next;
      } while (cursor);
    } finally { await storage.close(storageContext); }
  }
  const logs=JSON.stringify(evidence);
  assert(logs.includes(raw),"first failed raw reply remains in durable evidence");
  assert(logs.includes("format-repair-syntax:validation:1"),"repair uses one fixed durable request ID");
  await turn.close(); turn=open();
  assert.deepEqual(await turn.review({...malformedInput,context:{...malformedInput.context,reviewAt:99}}),repaired);
  assert.equal(calls,beforeRepair+2,"reopened repair and its initial answer are reused without another generation");

  attempt=0;
  respond=(_current,request)=>{
    if(++attempt===1) return {...valid,missing:[gap]};
    const feedback=userText(request);
    assert(feedback.includes('"decision":"deliver"') && feedback.includes('"outcome":"partial"'));
    assert(feedback.includes("missing"));
    return valid;
  };
  const beforeContract=calls;
  assert.deepEqual(await turn.review({...input,eventId:"format-repair-contract"}),valid);
  assert.equal(calls,beforeContract+2,"cross-field contract violation receives exactly one repair");

  for(const changed of [{outcome:"completed"},{decision:"continue",missing:[gap]}]) {
    attempt=0;
    respond=()=>++attempt===1 ? {...valid,missing:[gap]} : {...valid,...changed};
    const before=calls;
    await assert.rejects(turn.review({...input,eventId:`format-preserve-${Object.keys(changed)[0]}`}),/格式修正不得改变首答已解析/);
    assert.equal(calls,before+2,"a repair cannot upgrade partial or admit new continuation actions");
  }
  attempt=0;
  respond=()=>++attempt===1 ? {decision:"deliver",outcome:"unknown",missing:[]} : {...valid,outcome:"completed"};
  await assert.rejects(turn.review({...input,eventId:"format-preserve-unknown"}),/格式修正不得改变首答已解析的 outcome=unknown/);

  for(const invalid of ["Second invalid raw answer",{...valid,missing:[gap]}]) {
    respond=()=>invalid;
    const failedInput={...input,eventId:typeof invalid==="string" ? "format-repair-exhausted-json" : "format-repair-exhausted-fields"};
    const before=calls;
    const expected=typeof invalid==="string" ? SyntaxError : z.ZodError;
    await assert.rejects(turn.review(failedInput),expected);
    assert.equal(calls,before+2,"second invalid answer fails without a third model generation");
    await turn.close(); turn=open();
    await assert.rejects(turn.review(failedInput),expected);
    assert.equal(calls,before+2,"reopening an exhausted format repair does not reset its budget");
  }

  // Inject only the receive boundary error. The production validation catch must
  // not mistake transport errors (even SyntaxError) or timeouts for bad model JSON.
  const originalReply=DurableBotRuntime.prototype.reply, originalSubmit=DurableBotRuntime.prototype.submit;
  const submitted:string[]=[];
  try {
    DurableBotRuntime.prototype.submit=async function(...args) {submitted.push(args[1]);return originalSubmit.apply(this,args);};
    for(const [index,failure] of [new Error("fixture network unavailable"),new Error("结果整理超时，原执行结果已保留"),new SyntaxError("fixture transport JSON failure")].entries()) {
      DurableBotRuntime.prototype.reply=async function() {throw failure;};
      respond=()=>valid;
      const start=submitted.length;
      await assert.rejects(turn.review({...input,eventId:`receive-failure-${index}`}),error=>error===failure);
      assert.deepEqual(submitted.slice(start),[`receive-failure-${index}`],"receive failures never submit format correction");
    }
  } finally { DurableBotRuntime.prototype.reply=originalReply; DurableBotRuntime.prototype.submit=originalSubmit; }
  console.log("PASS durable format repair: strict cross-field contract, raw evidence, exact two-call budget, cached restart, partial/unknown/decision preservation, receive-error isolation");
} finally { await turn.close(); rmSync(root,{recursive:true,force:true}); }
