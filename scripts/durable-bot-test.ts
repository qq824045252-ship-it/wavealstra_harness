import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { clearResults, getResult } from "../src/main/capabilities/web-access/storage";
import { botConfiguration, emptyModePolicy, artifactVisibleForDisplay } from "../src/shared/mode-profile";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-test-"));
console.log("Isolated test directory:", root);
const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ref = { provider: model.provider, modelId: model.id };
function models(reply: (context: any, options: any) => any): any {
  const api: any = { getModel: () => model, streamSimple: (_model: any, context: any, options: any) => {
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => reply(context, options)).then(content => {
      const stopReason = content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop";
      const message: any = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message }); stream.end();
    }).catch(error => {
      stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", errorMessage: String(error), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end();
    });
    return stream;
  } };
  api.completeSimple = (model: any, context: any, options: any) => api.streamSimple(model, context, options).result();
  return api;
}
const text = (value: string) => [{ type: "text", text: value }];
const call = (name: string, args: object) => [{ type: "toolCall", id: "fixture-call", name, arguments: args }];
const forbidden = { ...emptyModePolicy(), artifactPolicy: { mode: "hard" as const, allow: ["pdf"], deny: ["py"] }, presets: [{id: "old", label: "kept", promptAddon: "user prompt", mcpPolicy: { mode: "hard" as const, allow: [], deny: ["*"] } }] };
const policy = botConfiguration(forbidden);
assert.equal(policy.presets?.[0].promptAddon, "user prompt");
assert.equal(policy.presets?.[0].mcpPolicy, undefined);
assert(artifactVisibleForDisplay("cad/_freecad_scripts/fc_123.py", policy.artifactPolicy));
assert(artifactVisibleForDisplay("pages/a.html", policy.artifactPolicy, ["deck.pptd"]));

for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode); await mkdir(cwd);
  let calls = 0;
  const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode, instructions: () => "fixture", onSnapshot: () => {},
    models: models((context) => {
      const names = getCurrentTools(context.messages).map(t => t.name);
      assert(names.includes(mode === "native" ? "write" : "codemode"), JSON.stringify(names));
      if (++calls === 1) return mode === "native" ? call("write", { path: "proof.py", content: "native durable" })
        : call("codemode", { code: 'await tools.write({path:"proof.py",content:"native durable"}); const r=await tools.read({path:"proof.py"}); text(r); store("n",7);' });
      assert(context.messages.some((m: any) => m.role === "toolResult" && !m.isError), JSON.stringify(context.messages));
      return text("complete");
    }) });
  try {
    const submission = await runtime.submit("run", `request-${mode}`);
    assert.equal((await submission.wait(ctx)).status, "done");
    assert.equal(await readFile(join(cwd, "proof.py"), "utf8"), "native durable");
    await runtime.refresh();
    assert.equal(runtime.snapshot.messages.at(-1)?.text, "complete");
    assert.equal(runtime.snapshot.busy, false);
    const duplicate = await runtime.submit("run", `request-${mode}`);
    assert.equal(duplicate.id, submission.id);
  } finally { await runtime.close(); }
  const reopened = await DurableBotRuntime.open({directory: join(cwd,"state"), cwd, model:ref, toolMode:mode, instructions:()=>"fixture", onSnapshot:()=>{}, models:models(()=> { throw new Error("history must not infer"); })});
  assert.equal(reopened.snapshot.messages.at(-1)?.text,"complete");
  await reopened.close();
  console.log("PASS",mode,"real native tools, no artifact blacklist, deduplication and reopen");
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Durable test timed out"); await new Promise(r => setTimeout(r, 10)); }
}
for (const mode of ["native", "codemode"] as const) {
  const cwd = join(root, mode + "-recovery"); await mkdir(cwd);
  let calls = 0, started = 0;
  const hold = defineTool({ name: "hold", description: "hold for cancellation", parameters: Type.Object({}), replay: "unsafe",
    execute: async (_args, _api, context) => { started++;
      await new Promise<void>((_resolve,reject) => { if(context.abortSignal.aborted) reject(Error("aborted")); else context.abortSignal.addEventListener("abort",()=>reject(Error("aborted")),{once:true}); });
      return {content:text("unreachable")};
    } });
  const options = { directory:join(cwd,"state"), cwd, model:ref, toolMode:mode, instructions:()=>"fixture", tools:[hold],onSnapshot:()=>{},
    models:models(()=> ++calls === 1 ? mode === "native" ? call("hold",{}) : call("codemode",{code:"await tools.hold({});"}) : text("recovered")) };
  let runtime = await DurableBotRuntime.open(options);
  const first = await runtime.submit("hold", "hold-request");
  await until(()=>started === 1);
  const queued = await runtime.submit("after restart", "queued-request", "followUp");
  assert.equal((await queued.status(ctx)).status,"queued");
  assert.equal(runtime.snapshot.pendingInputs[0]?.text,"after restart");
  await runtime.close();
  runtime = await DurableBotRuntime.open({...options,toolMode:mode === "native" ? "codemode" : "native"});
  assert.equal(runtime.snapshot.toolMode, mode, "persisted agent must win over default on restart");
  runtime.resume();
  assert.equal((await (await runtime.harness.submission(first.id,ctx))!.wait(ctx)).status,"done");
  assert.equal((await (await runtime.harness.submission(queued.id,ctx))!.wait(ctx)).status,"done");
  assert.equal(started,1,"unsafe tool must not execute twice after restart");
  await runtime.refresh(); assert.equal(runtime.snapshot.busy,false);
  assert(runtime.snapshot.messages.some(m=>m.tools?.some(t=>t.status==="error")),"interrupted tool must be visible");
  await runtime.configure(ref,"native");
  assert.equal((await runtime.submit("new turn", "switch-tag")).id > first.id,true);
  await runtime.close();
  console.log("PASS",mode,"restart during side effect, durable queue, no unsafe replay, persisted tag");
}
{
  const cwd=join(root,"abort"); await mkdir(cwd);
  let started=false;
  const runtime=await DurableBotRuntime.open({directory:join(cwd,"state"),cwd,model:ref,toolMode:"native",instructions:()=>"fixture",onSnapshot:()=>{},
    models:models(()=>call("hold",{})),tools:[defineTool({name:"hold",description:"hold",parameters:Type.Object({}),replay:"unsafe",execute:async(_a,_api,c)=>{
      started=true; await new Promise((_r,reject)=>c.abortSignal.addEventListener("abort",()=>reject(Error("aborted")),{once:true})); return {};
    }})]});
  const first=await runtime.submit("hold","first"); await until(()=>started);
  const second=await runtime.submit("queued","second"); await runtime.abort();
  assert.equal((await first.wait(ctx)).status,"unanswered"); assert.equal((await second.wait(ctx)).status,"unanswered");
  assert.equal(runtime.snapshot.busy,false); assert.equal(runtime.snapshot.queued,0);
  await runtime.close(); console.log("PASS native abort stops tool and withdraws queued input");
}
{
  const cwd = join(root,"compaction"); await mkdir(cwd);
  let summaries = 0;
  const api = models((context) => {
    if (JSON.stringify(context.messages[0]).includes("summar")) { summaries++; return text("persisted checkpoint summary"); }
    return text("completed turn");
  });
  const options = {directory:join(cwd,"state"),cwd,model:ref,toolMode:"native" as const,instructions:()=>"fixture",models:api,onSnapshot:()=>{}};
  let runtime = await DurableBotRuntime.open(options);
  for(let i=0;i<3;i++) await (await runtime.submit(`turn ${i} ` + "context ".repeat(12000), `compact-${i}`)).wait(ctx);
  const before = (await runtime.refresh()).messages;
  await runtime.compact();
  assert(summaries > 0, "native summarizer must actually run");
  assert.deepEqual(runtime.snapshot.messages,before,"compaction must not truncate full UI history");
  await runtime.close(); runtime = await DurableBotRuntime.open(options);
  assert.deepEqual(runtime.snapshot.messages,before,"reopen restores messages preceding compaction");
  await runtime.close(); console.log("PASS native compaction keeps complete UI snapshot across restart");
}
{
  const cwd=join(root,"stream-retry"); await mkdir(cwd);
  let attempts=0, sawRetry=false, sawStreaming=false;
  const api=models(()=>text("stream complete"));
  const real=api.streamSimple;
  api.streamSimple=(model:any,context:any,options:any)=>{
    const stream=createAssistantMessageEventStream();
    if(++attempts===1) {
      void real(model,context,options).result().then((base:any)=>{
        stream.push({type:"error",reason:"error",error:{...base,stopReason:"error",errorMessage:"429 rate limit"}});stream.end();
      });
      return stream;
    }
    void real(model,context,options).result().then(async(base:any)=>{
      const partial={...base,content:[{type:"text",text:"stream"}]};
      stream.push({type:"start",partial:structuredClone(partial)});
      stream.push({type:"text_delta",contentIndex:0,delta:"stream",partial:structuredClone(partial)});
      await new Promise(r=>setTimeout(r,120));
      stream.push({type:"done",reason:"stop",message:base}); stream.end();
    });
    return stream;
  };
  const runtime=await DurableBotRuntime.open({directory:join(cwd,"state"),cwd,model:ref,toolMode:"native",instructions:()=>"fixture",models:api,
    onSnapshot:s=>{sawRetry ||= !!s.retry;sawStreaming ||= s.messages.some(m=>m.streaming&&m.text==="stream");}});
  await (await runtime.submit("retry and stream","retry-stream")).wait(ctx);await runtime.refresh();
  assert.equal(attempts,2);assert(sawRetry,"native retry status projected");assert(sawStreaming,"native streaming partial projected");
  assert.equal(runtime.snapshot.messages.at(-1)?.text,"stream complete");await runtime.close();
  console.log("PASS native retry and streaming snapshot");
}
{
  const agentDir = join(root, "purge-profile"); await mkdir(agentDir);
  const db = new AppDatabase(join(agentDir, "app.db"));
  const taskId = "purge-bot", siblingId = "keep-bot";
  const directory = (id: string) => join(agentDir, "durable", createHash("sha256").update(id).digest("hex"));
  for (const id of [taskId, siblingId]) {
    db.upsertTask({ id, title: id, welcomeMode: "bot", updatedAt: Date.now() });
    await mkdir(directory(id), { recursive: true });
    await writeFile(join(directory(id), "history.jsonl"), id);
  }
  const service = new DurableBotService({ db, agentDir, mcpDir: join(agentDir, "mcp"), models: {} as any,
    resolveCwd: () => root, instructions: () => "", toolMode: () => "native", defaultModel: () => undefined, emit: () => {} });
  try {
    await assert.rejects(service.purge(taskId), /permanently deleted/);
    db.archiveTask(taskId, true);
    await assert.rejects(service.purge(taskId), /permanently deleted/, "archived history must remain recoverable");
    db.deleteTask(taskId);
    await service.purge(taskId);
    await assert.rejects(access(directory(taskId)));
    assert.equal(await readFile(join(directory(siblingId), "history.jsonl"), "utf8"), siblingId);
    await service.purge(taskId); // Idempotent lifecycle cleanup.
  } finally { await service.close(); db.close(); }
  console.log("PASS permanent purge removes only its Durable history; active/archive and sibling data preserved");
}
{
  const cwd = join(root, "extension-metadata"); await mkdir(cwd);
  let stage = "save";
  const api = models(context => context.messages.at(-1)?.role === "toolResult" ? text("metadata complete")
    : call("codemode", { code: stage === "save" ? "await tools.remember_fixture({});" : "text(await tools.recall_fixture({}));" }));
  const tools = await durableDomainTools([pi => {
    pi.registerTool({ name: "remember_fixture", label: "remember", description: "fixture", parameters: Type.Object({}), execute: async () => {
      pi.appendEntry("web-search-results", { id: "native-search-fixture", type: "search", timestamp: Date.now(), queries: [{ query: "q", answer: "persisted source", results: [], error: null }] });
      return { content: text("saved") as any, details: {} };
    } });
    pi.registerTool({ name: "recall_fixture", label: "recall", description: "fixture", parameters: Type.Object({}), execute: async () => {
      assert.equal(getResult("native-search-fixture")?.queries?.[0]?.answer, "persisted source");
      return { content: text("restored source") as any, details: {} };
    } });
  }], { cwd, models: api });
  const options = { directory: join(cwd, "state"), cwd, model: ref, toolMode: "codemode" as const, instructions: () => "fixture", models: api, tools, onSnapshot: () => {} };
  let runtime = await DurableBotRuntime.open(options);
  await (await runtime.submit("save", "save-metadata")).wait(ctx);
  await runtime.close(); clearResults(); stage = "recall";
  runtime = await DurableBotRuntime.open(options);
  try {
    await (await runtime.submit("recall", "recall-metadata")).wait(ctx); await runtime.refresh();
    assert(runtime.snapshot.messages.some(m => m.tools?.some(t => t.tool === "recall_fixture" && t.status === "success" && t.output === "restored source")), "metadata must survive in a new Code Mode child after restart");
  } finally { await runtime.close(); clearResults(); }
  console.log("PASS extension metadata survives restart and new Code Mode child ownership");
}
console.log("Durable Bot tests passed");
