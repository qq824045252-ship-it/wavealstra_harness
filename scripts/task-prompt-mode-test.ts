import assert from "node:assert/strict";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { minimalTask, prepareTestEnv } from "./test-store-harness";
import type { AgentPromptRequest, TaskDto } from "../src/shared/agent-ipc";
import { botMessagePresentation } from "../src/renderer/src/lib/botMessagePresentation";

async function main(): Promise<void> {
  prepareTestEnv();
  const api = window.api;
  assert(api);
  const saved: TaskDto[] = [];
  const requests: AgentPromptRequest[] = [];
  let releaseSave: (() => void) | undefined;
  api.db.upsertTask = async (task) => {
    saved.push(task);
    await new Promise<void>(resolve => { releaseSave = resolve; });
  };
  api.agent.prompt = async (request) => { requests.push(request); return { queued: false }; };
  const seed = (mode: "general" | "coding" | "working", globalMode: "general" | "coding" | "working") => {
    saved.length = 0; requests.length = 0; releaseSave = undefined;
    useAppStore.setState({
      tasks: [{ ...minimalTask("bound-task"), welcomeMode: mode, modePresetId: mode === "general" ? "native" : undefined,
        ...(mode === "general" ? {} : { sessionFile: "existing-pi.jsonl", messages: [{ id: "prior", role: "user", text: "first message", blocks: [] }] }) }],
      activeTaskId: "bound-task", welcomeMode: globalMode, modePresetId: "native", activeModelId: "fixture/model",
      models: [], modelExplicit: false, permissionMode: "auto", permissionExplicit: false, draft: null,
      chatSelections: [], activeConnectorIds: [], pendingRefTask: null,
    });
  };
  for (const [taskMode, globalMode] of [["general", "coding"], ["coding", "general"], ["working", "general"]] as const) {
    seed(taskMode,globalMode);
    const completion = useAppStore.getState().sendMessage("continue bound task");
    assert.equal(saved[0]?.welcomeMode,taskMode,"Persistence must use the task mode, not the global new-task selection");
    assert.equal(requests.length,0,"Agent execution must wait until its task metadata is persisted");
    assert(releaseSave);
    releaseSave();
    await completion;
    assert.equal(requests[0]?.welcomeMode,taskMode);
    assert.equal(useAppStore.getState().tasks[0].welcomeMode,taskMode);
  }
  seed("general","general");
  const completion = useAppStore.getState().sendMessage("first Bot submission");
  useAppStore.getState().setWelcomeMode("coding");
  assert.equal(useAppStore.getState().tasks[0].welcomeMode,"general","A pending Bot submission already locks its execution backend");
  assert(releaseSave); releaseSave(); await completion;
  assert.equal(requests[0].welcomeMode,"general");

  seed("general","general");
  api.db.upsertTask = async () => { throw new Error("SAVE_REJECTED"); };
  await useAppStore.getState().sendMessage("must not execute after failed save");
  assert.equal(requests.length,0);
  assert.match(useAppStore.getState().tasks[0].botInputError ?? "",/SAVE_REJECTED/);
  assert.equal(useAppStore.getState().tasks[0].botPendingSubmissions?.[0].submitting,false);
  assert.equal(useAppStore.getState().tasks[0].botPendingSubmissions?.[0].submissionFailed,true);

  seed("coding","coding");
  api.db.upsertTask = async () => {};
  api.agent.prompt = async request => ({ queued: true, receipt: {
    taskId: request.taskId, operationId: request.userMessageId, submissionId: 3, status: "queued",
  } });
  const done = useAppStore.getState().sendMessage("existing conversation follow-up", [{name:"example.txt",path:"/example.txt"}]);
  const task = () => useAppStore.getState().tasks[0];
  const display = () => botMessagePresentation(task().messages, task().durable?.pendingInputs, task().botPendingSubmissions);
  const optimistic = display().at(-1)!;
  assert.equal(optimistic.submitting,true);
  assert.deepEqual(optimistic.blocks,[{type:"text",text:"existing conversation follow-up"}]);
  assert.equal(optimistic.attachments?.[0]?.name,"example.txt");
  assert.equal(task().messages.length,1,"optimistic rows do not become history");
  await done;
  assert.equal(display().at(-1)?.id,optimistic.id,"IPC success cannot clear a bubble before the projection arrives");
  const snapshot = {backend:"pi-durable",epoch:"test",historyId:"test",revision:1,conversationId:"test",toolMode:"native",
    busy:true,queued:1,compacting:false,messages:[{id:"durable-1",role:"user",text:"first",createdAt:1}],
    pendingInputs:[{id:"3",inputRequestId:optimistic.id,mode:"followUp",text:"existing conversation follow-up"}],
  } as const;
  useAppStore.getState().applyAgentPatch({type:"durable_snapshot",taskId:"bound-task",snapshot:{
    ...snapshot,messages:[...snapshot.messages],pendingInputs:[...snapshot.pendingInputs],
  }});
  assert.equal(task().botPendingSubmissions,undefined);
  assert.equal(display()[1]?.presentationKey,optimistic.presentationKey,"queued acceptance keeps one stable bubble");
  useAppStore.getState().applyAgentPatch({type:"durable_snapshot",taskId:"bound-task",snapshot:{
    ...snapshot,revision:2,queued:0,pendingInputs:[],messages:[...snapshot.messages,
      {id:"durable-3",role:"user",text:"existing conversation follow-up",createdAt:3,inputRequestId:optimistic.id}],
  }});
  assert.equal(display().length,2);
  assert.equal(display()[1]?.presentationKey,optimistic.presentationKey);

  const a = useAppStore.getState().sendMessage("same text");
  const b = useAppStore.getState().sendMessage("same text");
  const [first, second] = task().botPendingSubmissions!;
  assert.notEqual(first.id,second.id);
  useAppStore.getState().applyAgentPatch({type:"durable_snapshot", taskId:"bound-task", snapshot:{
    ...snapshot,revision:3,messages:[...snapshot.messages],
    pendingInputs:[{id:"4",inputRequestId:first.id,mode:"followUp",text:"same text"}],
  }});
  assert.deepEqual(task().botPendingSubmissions?.map(input=>input.id),[second.id]);
  assert.equal(new Set(display().map(message=>message.presentationKey ?? message.id)).size,display().length);
  await Promise.all([a,b]);

  seed("coding", "coding");
  const review = (taskId: string) => Promise.resolve(useAppStore.getState().sendMessage("Review invoice.ts:12",
    undefined, undefined, "followUp", undefined, undefined, undefined, undefined, taskId));
  await assert.rejects(review("other-task"), /任务已经切换/);
  assert.equal(task().botPendingSubmissions, undefined);

  api.agent.prompt = async request => {
    requests.push(request);
    return { queued: false, error: { code: "REVIEW_REFUSED", message: "review was refused" } };
  };
  await assert.rejects(review("bound-task"), /review was refused/);
  assert.equal(task().botPendingSubmissions?.at(-1)?.submissionFailed, true);

  api.agent.prompt = async request => {
    requests.push(request);
    return { queued: true, receipt: {
      taskId: request.taskId, operationId: request.userMessageId, submissionId: 4, status: "queued",
    } };
  };
  await review("bound-task");
  assert.deepEqual(requests.map(request => [request.taskId, request.text, request.streamingBehavior]),
    Array.from({ length: 2 }, () => ["bound-task", "Review invoice.ts:12", "followUp"]));
  console.log("PASS: task mode authority, queued input, failed-save admission and task-scoped review delivery");
}
main().catch(error => { console.error(error); process.exitCode=1; });
