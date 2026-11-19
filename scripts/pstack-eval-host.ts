import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { normalizeContext, resolveTranscriptTools, type AssistantMessage, type Context as ModelContext, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, Harness, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { pstackSubagentOptions } from "../src/main/agent/PstackDispatch";
import { createDurableSubagentTools, resolveDurableExecutionCwd } from "../src/main/agent/durable/DurableSubagents";
import { createPstackWorkflow } from "../src/main/agent/pstack/PstackWorkflow";
import { WorkflowState } from "../src/main/agent/pstack/PstackState";
import { publicSubmissions } from "../src/main/agent/pstack/PstackContest";
import { checkEvalExport } from "../src/main/agent/pstack/PstackEvalExport";
import { normalizePstackSettings } from "../src/shared/pstack";

export async function verifyEvalHost(dir: string) {
  const taskId = "project", project = join(dir, "private-rubric-and-other-authors"), profile = join(dir,"profile");
  await mkdir(project); await mkdir(profile);
  for (const direction of ["north","south"]) {
    await mkdir(join(project,direction)); await writeFile(join(project,direction,"guide.md"),direction+" instructions");
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  const criteria = ["Explain aliases","Treat missing names","Handle duplicate names"], prompt = "Please provide a rule for the roster.";
  const settings = normalizePstackSettings(); settings.playbooks.eval.parameters.rubricCount = 3;
  const cases = ["parent","gpt-reader","deepseek-north","deepseek-south"].map(id => ({id, name:id, provider:"fixture", api:"openai-completions",
    baseUrl:"http://fixture.invalid", reasoning:false, input:["text"], contextWindow:64000, maxTokens:4000,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} satisfies Model<"openai-completions">));
  const pools = cases.slice(1).map(model=>"fixture/"+model.id);
  await writeFile(join(profile,"subagent.json"),JSON.stringify({roles:{diverse:pools},maxConcurrency:2}));
  await writeFile(join(profile,"settings.json"),"{}");
  const seen = new Map<string,ModelContext[]>(), queue: {name:string;arguments:JsonObject}[] = [];
  let serial = 0;
  const models = {getAvailable:async()=>cases, getModel:(provider:string,id:string)=>cases.find(m=>m.provider===provider && m.id===id), getAuth:async()=>undefined,
    streamSimple(model:typeof cases[number], context:ModelContext) {
      const contexts = seen.get(model.id) ?? []; contexts.push(context); seen.set(model.id,contexts);
      const stream = createAssistantMessageEventStream();
      const lastUser = context.messages.map(m=>m.role).lastIndexOf("user");
      const results = context.messages.slice(lastUser+1).filter(m=>m.role==="toolResult");
      const call: Pick<ToolCall,"name"|"arguments"> | undefined = model.id === "parent" ? queue.shift() : model.id === "gpt-reader" ? undefined : !results.length
        ? {name:"project_document",arguments:{name:"."}} : results.length===1
        ? {name:"project_document",arguments:{name:"guide.md"}} : results.length===2
        ? {name:"project_document",arguments:{name:"result.txt",content:model.id+" finished"}} : undefined;
      const text = model.id==="gpt-reader" ? JSON.stringify({recommended:"Document 2",scores:["Document 1","Document 2"].map(label=>({label,reason:"Concrete evidence",ratings:[3,4,5]}))})
        : "Here is the complete result.";
      const answer: AssistantMessage = {role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        content:call ? [{type:"toolCall",id:"call-"+(++serial),...call}] : [{type:"text",text}],stopReason:call?"toolUse":"stop",
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:"done",reason:call?"toolUse":"stop",message:answer});stream.end();});
      return stream;
    }
  } as unknown as ModelRuntime;
  let harness: Harness | undefined;
  try {
    const registry = createRegistry(), options = {taskId,cwd:project,active:()=>true,settings:()=>settings};
    registry.install(defineExtension({name:"project",tools:[...createPstackWorkflow(options).tools,...createDurableSubagentTools({
      taskId,cwd:project,models,permissionMode:()=>"auto",workspaceNotes:()=>"PRIVATE WORKSPACE NOTES",...pstackSubagentOptions(taskId,settings),
    })]}));
    const storage = await openNodeJsonlStorage(join(dir,"native-child-ledger"),ctx);
    harness = await Harness.open(storage,{models,registry,env:async(target,context)=>new NodeExecutionEnv({cwd:await resolveDurableExecutionCwd(target,context,project)})},ctx);
    const root = await harness.root(ctx,{agent:{cwd:project,model:{provider:"fixture",modelId:"parent"}}});
    const flow = (action:string,args:JsonObject={}) => ({name:"pstack_workflow",arguments:{action,...args}});
    const delegate = (role:string) => ({name:"pstack_delegate",arguments:{role,tasks:["PRIVATE PARENT INSTRUCTIONS"]}});
    queue.push(flow("start",{playbook:"eval"}),flow("advance",{stage:"rubric",note:"Freeze guidance",criteria}),
      flow("advance",{stage:"isolate",note:"Select per-author documents",materials:[["north/guide.md"],["south/guide.md"]]}),
      flow("advance",{stage:"prompt",note:"One assignment",prompt}),delegate("arena-runners"),delegate("arena-runners"));
    const request = async(content:string) => { await (await root.submit({type:"input",content},ctx)).wait(ctx); await root.waitForIdle(ctx); };
    await request("Dispatch authors and persist rubric.json and the anonymized outputs.");
    const entries = await root.entries({},120,undefined,ctx);
    const errors = entries.items.flatMap(e=>e.model?.flatMap(m=>m.role==="toolResult"&&m.isError?[JSON.stringify(m.content)]:[]) ?? []);
    const frozen = (await harness.snapshot(WorkflowState,root.id,ctx))!.run!;
    assert.deepEqual(frozen.contests!.eval.criteria,criteria);
    const authors = frozen.delegates[0];
    assert.ok(authors,errors.join("\n"));
    assert.deepEqual(authors.participants?.map(p=>p.filesRead),[["guide.md"],["guide.md"]]);
    assert.deepEqual(authors.participants?.map(p=>p.filesWritten),[["result.txt"],["result.txt"]]);
    assert.equal(new Set(authors.participants?.map(p=>p.promptSha256)).size,1);
    for (const id of ["deepseek-north","deepseek-south"]) {
      const requests = seen.get(id)!;
      assert.equal(requests.length,4);
      const first = JSON.stringify(requests[0]);
      assert.doesNotMatch(first,/private-rubric-and-other-authors|PRIVATE WORKSPACE NOTES|PRIVATE PARENT INSTRUCTIONS|Stage methods|Duplicate names/i);
      const {requestTools} = resolveTranscriptTools(normalizeContext(requests[0]).messages,"none");
      assert.deepEqual(requestTools.map(tool=>tool.name),["project_document"]);
      assert.ok(first.includes(prompt));
      assert.ok(requests[1].messages.some(m=>m.role==="toolResult" && !m.isError && JSON.stringify(m.content).includes("guide.md")));
      assert.ok(JSON.stringify(requests[2]).includes(id.endsWith("north")?"north instructions":"south instructions"));
      assert.ok(!JSON.stringify(requests[2]).includes(id.endsWith("north")?"south instructions":"north instructions"));
    }
    queue.push(flow("advance",{stage:"candidates",note:"Saw both outputs"}),delegate("arena-cross-judge"));
    await request("Dispatch judge");
    const final = (await harness.snapshot(WorkflowState,root.id,ctx))!.run!;
    assert.equal(final.delegates.length,2);
    assert.deepEqual(final.delegates[1].models,["fixture/gpt-reader"]);
    const judge = JSON.stringify(seen.get("gpt-reader")![0]);
    assert.doesNotMatch(judge,/deepseek-north|deepseek-south|PRIVATE PARENT INSTRUCTIONS/);
    assert.ok(judge.includes("result.txt") && judge.includes("Explain aliases"));
    await mkdir(join(project,"existing")); await writeFile(join(project,"existing","Document-2.md"),"Keep my draft");
    queue.push(flow("export-eval",{artifactDirectory:"existing"}),flow("advance",{stage:"judge",note:"Reviewed both documents"}),
      flow("advance",{stage:"audit",note:"Inspected child reads and exact submissions"}));
    await request("Deliver the files");
    const exported=(await harness.snapshot(WorkflowState,root.id,ctx))!.run!.evalExport;
    assert.ok(exported);
    assert.equal(exported.directory,".");
    assert.equal(await readFile(join(project,"existing","Document-2.md"),"utf8"),"Keep my draft");
    assert.deepEqual(JSON.parse(await readFile(join(project,"rubric.json"),"utf8")),{criteria,scale:{min:1,max:5}});
    for (const [i,work] of publicSubmissions(authors).entries())
      assert.equal(await readFile(join(project,"Document-"+(i+1)+".md"),"utf8"),work.text);
    await checkEvalExport(project,exported);
    await writeFile(join(project,"Document-1.md"),"Post-review modification");
    await assert.rejects(checkEvalExport(project,exported),/changed/);
    console.log("PASS native parent → configured authors → isolated read/write tools → anonymous one-pass juror, including actual model request bodies");
  } finally {
    await harness?.close(ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;
  }
}
