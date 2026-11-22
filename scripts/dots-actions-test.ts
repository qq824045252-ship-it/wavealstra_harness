import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathFromMarkdownHref } from "../src/renderer/src/lib/localFilePath";
import { join } from "node:path";
import { getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import type { DotsActionInput } from "../src/main/dots/DotsActions";
import { observeDotsWireEvidence } from "./dots-memory-wire-evidence";

const root = mkdtempSync(join(tmpdir(), "dots-actions-"));
process.env.MYBUDDY_DISABLE_GOAL_CONTINUATION = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const folder = join(root, "client");
mkdirSync(folder);
writeFileSync(join(folder, "input.txt"), "客户档案编号 A456");
const { DOTS_TASK_ID } = await import("../src/shared/dots");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { DotsDelegations } = await import("../src/main/dots/DotsDelegations");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const { CronService } = await import("../src/main/cron/CronService");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const db = new AppDatabase(join(root, "app.db"));
new (await import("../src/main/artifact/ArtifactRepository")).ArtifactRepository(db.connection);
db.openDots();
const outputs = new Map<string, { text: string; error?: boolean }>();
let serial = 0;
let planned: { id: string; name: string; arguments: Extract<AssistantMessage["content"][number], {type: "toolCall"}>["arguments"] }[] = [];
let holdTarget = false;
let waiting = false;
let release: (() => void) | undefined;
let readFile = false;
const weeklyReads: string[] = [];
let weeklyLookup = false;
let registerManualReport = false;
let askQuestion: false | "short_text" | "confirm" = false;
let steeringProof = false;
let ordinaryReadResult = "";
let observedDelegatedEvidence = false;
const fixture = await createAgentDurableFixture(root, db, async (input, signal) => {
  const tools = getCurrentTools(input.messages);
  if (!tools.length) return [{ type: "text", text: JSON.stringify({ candidates: [] }) }];
  const last = input.messages.at(-1);
  if (last?.role === "toolResult") {
    const text = last.content.filter(block => block.type === "text").map(block => block.text).join("");
    outputs.set(last.toolCallId, { text, error: last.isError });

  }
  for (const message of input.messages) if (message.role === "toolResult" && message.toolName === "read") {
    ordinaryReadResult = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  }
  if (tools.some(tool => tool.name === "dots_action")) {
    const call = planned.shift();
    if (call) return [{ type: "toolCall", ...call }];
  } else if (tools.some(tool => tool.name === "read")) {
    if (JSON.stringify(input.messages).includes("reference-evidence-7462")) observedDelegatedEvidence = true;
    if (holdTarget) {
      waiting = true;
      await new Promise<void>(resolve => {
        release = resolve;
        if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      waiting = false;
    }
    if (askQuestion) {
      const kind = askQuestion;
      askQuestion = false;
      return [{ type: "toolCall", id: "ask-customer-" + serial, name: "request_user_input",
        arguments: { title: kind === "confirm" ? "是否采用客户的预算？" : "请问报价币种？", kind } }];
    }
    if (weeklyLookup) {
      if (last?.role === "toolResult" && !last.isError) {
        weeklyLookup = false;
        if (registerManualReport) return [{type:"toolCall",id:"save-manual-report",name:"register_artifact",arguments:{path:"manual-report-a08.txt"}}];
        return [{type:"text", text:"周复盘夹具：我声称用户偏爱紫色。"}];
      }
      const offered = last?.role === "user" && /本任务曾在 "weekly\/index.txt" 成功读取同名文件/.test(JSON.stringify(last.content).replaceAll('\"','"'));
      const path = offered || last?.role === "toolResult" ? "weekly/index.txt" : "index.txt";
      weeklyReads.push(path);
      return [{type:"toolCall",id:"weekly-read-" + weeklyReads.length,name:"read",arguments:{path}}];
    }
    if (registerManualReport && last?.role === "toolResult") {
      assert.equal(last.isError,false,JSON.stringify(last.content));
      registerManualReport = false;
      return [{type:"text",text:"用户自建任务最终核算：批次 B882 净额 6821 元。"}];
    }
    if (steeringProof && JSON.stringify(input.messages.findLast(message => message.role === "user")?.content).includes("改为方案")) {
      if (last?.role === "toolResult" && last.toolName === "register_artifact") {
        assert.equal(last.isError, false, JSON.stringify(last.content));
        steeringProof = false;
        return [{type:"text", text:"已根据改向交付 A456 修订方案"}];
      }
      if (last?.role === "toolResult" && last.toolName === "write") {
        assert.equal(last.isError, false, JSON.stringify(last.content));
        return [{type:"toolCall", id:"steer-register", name:"register_artifact", arguments:{path:"修订方案.txt"}}];
      }
      if (last?.role === "toolResult" && last.toolName === "read") {
        return [{type:"toolCall", id:"steer-write", name:"write", arguments:{path:"修订方案.txt", content:"客户 A456：采用修订方案"}}];
      }
      readFile = false;
      return [{type:"toolCall", id:"steer-read", name:"read", arguments:{path:"input.txt"}}];
    }
    if (readFile) {
      readFile = false;
      return [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "input.txt" } }];
    }
  }
  return [{ type: "text", text: "已收到。" }];
});
const agent = fixture.agent;
const cron = new CronService(db, agent);
const terminal = new TerminalHost({ resolveCwd: () => folder });
agent.setLocalWorkflowServices({ cron, terminal: new TaskTerminalService(terminal) });
const journal = new DotsDelegations(db.connection, (...args) => agent.dotsSubmission(...args), () => {});
const makeActions = () => new DotsActions(db, agent, { link: (...args) => journal.link(...args), list: () => journal.list(), changed: () => journal.refresh(),
  failed: (...args) => journal.failed(...args) });
let actions = makeActions();
agent.setDotsActions(actions);
actions.startFileWatches();
async function turn(input: DotsActionInput | Record<string, unknown>, name = "dots_action", repeat = 1, userText?: string) {
  const turnId = ++serial;
  const calls = Array.from({ length: repeat }, (_, index) => ({ id: "call-" + turnId + "-" + index, name, arguments: JSON.parse(JSON.stringify(input)) }));
  planned = [...calls];
  await fixture.prompt({ taskId: DOTS_TASK_ID, text: userText ?? "用户交代 " + turnId, userMessageId: "dots-user-" + turnId, assistantMessageId: "dots-assistant-" + turnId });
  const results = calls.map(call => {
    const result = outputs.get(call.id);
    assert(result, "native tool result missing for " + call.id);
    return result;
  });
  assert(results.every(result => Boolean(result.error) === Boolean(results[0]!.error)), "重复调用应返回同样的成功或错误状态");
  return results[0]!;
}
async function success(input: DotsActionInput, repeat = 1) {
  const value = await turn(input, undefined, repeat);
  assert(!value.error, value.text);
  return JSON.parse(value.text);
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert(check(), label);
}
try {
  const space = await success({ action: "bind", name: "客户 A", path: folder }, 2);
  assert.equal(space.path, folder);
  assert.match(space.link, /mybuddy:\/\/space\//);
  assert.equal(db.listSpaces().filter(s => s.name === "客户 A").length, 1);
  const renamed = await success({ action: "rename", name: "华南", spaceId: space.id });
  assert.equal(renamed.id, space.id);
  assert.equal(renamed.path, folder);
  assert((await success({ action: "spaces" })).some((s: { name: string }) => s.name === "华南"));
  assert((await success({ action: "files", spaceId: space.id })).files.some((f: { path: string }) => f.path === "input.txt"));
  assert.equal((await success({ action: "read_file", spaceId: space.id, path: "input.txt" })).content, "客户档案编号 A456");
  assert((await turn({ action: "read_file", spaceId: space.id, path: "../app.db" })).error);
  assert((await turn({ action: "task", targetTaskId: DOTS_TASK_ID })).error);
  assert.equal(db.listNonTrashedTasks().length, 0);
  await assert.rejects(actions.execute("other", "user", { action: "board" }), /原生会话/);
  readFile = true;
  holdTarget = true;
  const job = await success({ action: "delegate", spaceId: space.id, name: "客户报价", text: "读取客户档案" }, 2);
  assert.match(job.link, /mybuddy:\/\/task\//);
  assert.equal(db.listNonTrashedTasks().length, 1);
  assert.equal(journal.list().length, 1);
  assert.equal(journal.list()[0]?.sourceMessageId, "dots-user-" + serial);
  const task = db.getTask(job.id)!;
  assert.equal(task.cwd, folder);
  assert.equal(task.spaceId, space.id);
  await until(() => waiting, "existing native model run must be active");
  steeringProof = true;
  const steer = await success({ action: "steer", targetTaskId: task.id, text: "改为方案" });
  assert(["queued", "placed"].includes(steer.receipt.status));
  holdTarget = false;
  release?.();
  await agent.waitForSubmission(steer.receipt);
  assert.equal(journal.list().length, 2);
  assert.match(ordinaryReadResult, /A456/);
  assert.equal(readFileSync(join(folder,"修订方案.txt"),"utf8"), "客户 A456：采用修订方案");
  journal.refresh(task.id);
  const revisionSource = "dots-user-" + serial;
  await until(() => journal.list([revisionSource]).some(item => item.taskId === task.id && item.status === "completed"),
    "redirected assignment commits its own native delivery receipt");
  const [priorDraft, revised] = journal.list();
  assert.equal(priorDraft.status, "superseded");
  assert.equal(priorDraft.artifacts.length, 0);
  assert.match(revised.text, /根据改向交付 A456 修订方案/);
  const revisedFile = revised.artifacts.find(file => file.name === "修订方案.txt");
  assert(revisedFile?.saved?.snapshotPath);
  assert.equal(readFileSync(revisedFile.saved.snapshotPath,"utf8"), "客户 A456：采用修订方案");
  console.log("PASS 原任务在运行时收到改向，交付真实修订文件，旧委派不回写文件");
  const board = await success({ action: "board", query: "客户", spaceId: space.id });
  assert.deepEqual(board.tasks.map((r: {id: string}) => r.id), [task.id]);
  const status = await success({ action: "task", targetTaskId: task.id });
  assert.equal(status.progress.id, task.id);
  assert(status.messages.some((m: {text: string}) => m.text.includes("改为方案")));
  assert(!(await success({action: "board"})).tasks.some((r: {id: string}) => r.id === DOTS_TASK_ID));
  assert((await turn({action: "steer", targetTaskId: task.id, text: "迟到的改向"})).error);
  holdTarget = true;
  await success({ action: "delegate", targetTaskId: task.id, text: "继续报价" });
  await until(() => waiting, "target busy before pause");
  const paused = await success({ action: "pause", targetTaskId: task.id }, 2);
  assert(["idle", "stop_requested"].includes(paused.control));
  holdTarget = false;
  release?.();
  await until(() => !agent.isTaskBusy(task.id), "paused original task");
  assert.equal(paused.dotsState, "paused");
  const pausedFollowup = await turn({action: "delegate", targetTaskId: task.id, text: "暂停期间重派"});
  assert(pausedFollowup.error);
  const resumed = await success({ action: "resume", targetTaskId: task.id });
  await agent.waitForSubmission(resumed.receipt);
  askQuestion = "short_text";
  const questionTurn = await success({action: "delegate", targetTaskId: task.id, text: "按客户选择的币种计算"});
  await until(() => agent.getConversationRuntimeSnapshot(task.id).interactions.some(item => item.status === "pending"), "worker asks user through native tool");
  const question = agent.getConversationRuntimeSnapshot(task.id).interactions.find(item => item.status === "pending")!;
  const answerInput = {action: "answer", targetTaskId: task.id, interactionId: question.id, operationId: questionTurn.receipt.operationId};
  const wrongLink = await turn({ ...answerInput, operationId: resumed.receipt.operationId }, "dots_action", 1, "美元");
  assert(wrongLink.error, "older accepted operation cannot answer newer question");
  const answer = await turn(answerInput, "dots_action", 1, "人民币");
  assert(!answer.error, answer.text);
  assert.equal(agent.getConversationRuntimeSnapshot(task.id).interactions.find(item => item.id === question.id)?.answer, "人民币");
  await agent.waitForSubmission(questionTurn.receipt);
  askQuestion = "confirm";
  const confirmation = await success({action:"delegate",targetTaskId:task.id,text:"采用客户的明确选择"});
  await until(() => agent.getConversationRuntimeSnapshot(task.id).interactions.some(item => item.status === "pending"),"confirmation pending");
  const confirmId = agent.getConversationRuntimeSnapshot(task.id).interactions.find(item => item.status === "pending")!.id;
  const respond = {action:"answer",targetTaskId:task.id,interactionId:confirmId,operationId:confirmation.receipt.operationId};
  for (const uncertain of ["可以吗？", "yes, but wait"]) {
    assert((await turn(respond, "dots_action", 1, uncertain)).error);
    assert.equal(agent.getConversationRuntimeSnapshot(task.id).interactions.find(item => item.id === confirmId)?.status,"pending");
  }
  assert(!(await turn(respond, "dots_action", 2, "  确认。  ")).error);
  assert.equal(agent.getConversationRuntimeSnapshot(task.id).interactions.find(item => item.id === confirmId)?.answer,true);
  await agent.waitForSubmission(confirmation.receipt);
  const stopped = await success({action: "stop", targetTaskId: task.id});
  assert.equal(stopped.dotsState, "stopped");
  assert((await turn({action:"delegate", targetTaskId:task.id, text:"停止后重派"})).error);
  const existing = await success({action:"deliveries", targetTaskId:task.id, query:"客户报价"});
  assert(existing.results.some((r: {operationId:string}) => r.operationId === questionTurn.receipt.operationId));
  const taskTools = fixture.requests.find(req => req.tools.includes("read"));
  assert(taskTools && !taskTools.tools.includes("dots_action"));
  const front = fixture.requests.find(req => req.tools.includes("dots_action"))!;
  assert(front.tools.includes("automation_exec"));
  assert(!front.tools.some(tool => ["read","write","edit","bash","execute_code","terminal_exec","subagent"].includes(tool)));
  const scheduled = { action: "create", name: "明天跟进", prompt: "查看刚才报价的实际情况", schedule_type: "every", schedule_expr: "5h" };
  const schedule = await turn(scheduled, "automation_exec", 2);
  assert(!schedule.error, schedule.text);
  assert.equal(cron.listForTask(DOTS_TASK_ID).length, 1);
  assert((await turn({ ...scheduled, target: "new-task" }, "automation_exec")).error);
  const other = cron.createForTask(task.id, folder, { name: "独立计划", prompt: "测试", scheduleType: "every", scheduleExpr: "5h", timezone: "UTC", target: "current-task" });
  assert((await turn({ action: "cancel", id: other.id }, "automation_exec")).error);
  assert(cron.getForTask(task.id, other.id).job.enabled);
  const follow = await turn({ action: "create", name: "到点回到 Dots", prompt: "主动跟进客户报价", schedule_type: "at",
    schedule_expr: new Date(Date.now() + 3500).toISOString(), max_runs: 1 }, "automation_exec");
  assert(!follow.error, follow.text);
  const scheduledId = JSON.parse(follow.text).id;
  await until(() => db.listCronJobRuns(scheduledId, 1)[0]?.status === "success", "real scheduled callback completed in Dots");
  assert.equal(db.listCronJobRuns(scheduledId, 1)[0]?.taskId, DOTS_TASK_ID);
  const timed = await agent.loadTaskHistory(DOTS_TASK_ID);
  assert(timed.messages.some(m => m.role === "user" && m.text.includes("主动跟进客户报价")));
  const cancelled = await turn({action:"cancel", id:JSON.parse(schedule.text).id}, "automation_exec");
  assert(!cancelled.error, cancelled.text);
  assert(cron.getForTask(DOTS_TASK_ID, JSON.parse(schedule.text).id).job.cancelledAt);
  const restartedTask = await success({action:"resume", targetTaskId:task.id});
  await agent.waitForSubmission(restartedTask.receipt);
  const subscribe = (path: string) => success({action:"watch_file", targetTaskId:task.id, path, text:"检查文件 " + path});
  const listWatches = () => db.connection.prepare("SELECT id,state,note FROM dots_file_watches").all() as Array<{id:string;state:string;note:string}>;
  const watching = await subscribe("prices.txt");
  assert.equal(watching.state,"watching");
  const beforeChange = journal.list().length;
  writeFileSync(join(folder,"prices.txt"),"42");
  writeFileSync(join(folder,"prices.txt"),"43");
  await until(() => listWatches().some(w => w.id === watching.id && w.state === "dispatched"), "file creation wakes a native ordinary task");
  assert.equal(journal.list().length, beforeChange + 1);
  const fileReceipt = await agent.findSubmission(task.id, "dots-input-file-" + watching.id);
  assert(fileReceipt?.receipt);
  await agent.waitForSubmission(fileReceipt.receipt);
  const cancelledWatch = await subscribe("cancel.txt");
  const cancelledResult = await success({action:"cancel_watch", targetTaskId:task.id, watchId:cancelledWatch.id});
  assert.equal(cancelledResult.state,"cancelled");
  writeFileSync(join(folder,"cancel.txt"),"no dispatch");
  const superseded = await subscribe("old.txt");
  await fixture.prompt({taskId:task.id, text:"更换本任务要求",userMessageId:"manual-new-intent",assistantMessageId:"manual-new-intent-reply"});
  writeFileSync(join(folder,"old.txt"),"stale");
  await until(() => listWatches().some(w => w.id === superseded.id && w.state === "expired"), "a later ordinary user input supersedes the earlier file rule");
  assert.equal(await agent.findSubmission(task.id,"dots-input-file-" + superseded.id), undefined);
  const offline = await subscribe("offline.txt");
  await actions.closeFileWatches();
  writeFileSync(join(folder,"offline.txt"),"changed during downtime");
  actions = makeActions();
  agent.setDotsActions(actions);
  actions.startFileWatches();
  await until(() => listWatches().some(w => w.id === offline.id && w.state === "dispatched"), "persisted file revision catches up on startup");
  assert.equal(await agent.findSubmission(task.id,"dots-input-file-" + cancelledWatch.id), undefined);
  const list = await success({action:"file_watches",targetTaskId:task.id});
  assert.equal(list.find((w: {id:string}) => w.id === offline.id).state, "dispatched");
  const offlineReceipt = await agent.findSubmission(task.id,"dots-input-file-" + offline.id);
  assert(offlineReceipt?.receipt);
  await agent.waitForSubmission(offlineReceipt.receipt);
  const held = await subscribe("held.txt");
  const proactive = await success({action:"pause_proactive", spaceId:space.id});
  assert.equal(proactive.proactive,"paused");
  writeFileSync(join(folder,"held.txt"),"新资料");
  assert.equal(await agent.findSubmission(task.id,"dots-input-file-" + held.id), undefined);
  await success({action:"resume_proactive",spaceId:space.id});
  await until(() => listWatches().some(w => w.id === held.id && w.state === "dispatched"),"proactive resume catches file change");
  const heldReceipt = await agent.findSubmission(task.id,"dots-input-file-" + held.id);
  assert(heldReceipt?.receipt);
  await agent.waitForSubmission(heldReceipt.receipt);

  const batchWatch = await subscribe("batch.txt");
  const previousVersion = await agent.dotsInputVersion(task.id);
  holdTarget = true;
  const manual = await agent.prompt({taskId:task.id,modelId:"fixture/model",text:"普通用户直接安排",userMessageId:"user-outside-dots",assistantMessageId:"reply-outside-dots"});
  await until(() => waiting, "ordinary unrelated manual turn is running");
  const stale = await agent.prompt({ taskId:task.id,modelId:"fixture/model",text:"迟到的旧要求",
    userMessageId:"stale-job-correction",assistantMessageId:"stale-job-output",streamingBehavior:"steer",
    requireActiveRun:true,dotsSteerInputVersion:previousVersion });
  assert.equal(stale.error?.code,"DOTS_INTENT_CHANGED");
  assert.equal(await agent.findSubmission(task.id,"stale-job-correction"),undefined);
  const scoped = await success({action:"pause_all",spaceId:space.id}, 2);
  const batchRow = scoped.tasks.find((row: {id:string}) => row.id === task.id);
  assert.equal(batchRow.control,"future_work_only");
  assert(agent.isTaskBusy(task.id), "batch pause preserves unrelated active native turn");
  assert.equal(listWatches().find(w => w.id === batchWatch.id)?.state,"paused");
  holdTarget = false;
  release?.();
  assert(manual.receipt);
  await agent.waitForSubmission(manual.receipt);
  writeFileSync(join(folder,"batch.txt"),"变更");
  const batchResume = await success({action:"resume",targetTaskId:task.id});
  await agent.waitForSubmission(batchResume.receipt);
  await until(() => listWatches().some(w => w.id === batchWatch.id && w.state === "dispatched"),"explicit task resume re-arms paused watches");
  const batchReceipt = await agent.findSubmission(task.id,"dots-input-file-" + batchWatch.id);
  assert(batchReceipt?.receipt);
  await agent.waitForSubmission(batchReceipt.receipt);
  const toStop = await subscribe("stop-all.txt");
  const privateTimer = await turn({...scheduled,name:"保持当前目标"}, "automation_exec");
  assert(!privateTimer.error);
  const stoppedAll = await success({action:"stop_all"},2);
  assert(stoppedAll.schedules.some((timer:{id:string;status:string}) => timer.id === JSON.parse(privateTimer.text).id && timer.status === "cancelled"));
  assert.equal(listWatches().find(w => w.id === toStop.id)?.state,"cancelled");
  assert(cron.getForTask(task.id, other.id).job.enabled);
  const clearStop = await success({action:"resume",targetTaskId:task.id});
  await agent.waitForSubmission(clearStop.receipt);

  // Simulate process loss after the native resume was committed but before its product receipt cleared the hold.
  const restoring = await subscribe("resume-recovery.txt");
  await actions.closeFileWatches();
  db.connection.prepare("INSERT OR REPLACE INTO dots_target_controls VALUES(?,?,?)").run(task.id,"paused",clearStop.receipt.operationId);
  db.connection.prepare("UPDATE dots_file_watches SET state='paused' WHERE id=?").run(restoring.id);
  actions = makeActions();
  agent.setDotsActions(actions);
  actions.startFileWatches();
  await until(() => listWatches().some(w => w.id === restoring.id && w.state === "watching"),"committed native resume restored the product hold");
  await success({action:"cancel_watch",targetTaskId:task.id,watchId:restoring.id});

  const shared = agent.createKernelMemory({ title:"共享事实", content:"reference-evidence-7462", kind:"fact", sourceType:"manual", scopeType:"global" });
  const secret = agent.createKernelMemory({ title:"Dots 私人", content:"private Dots fact", kind:"fact", sourceType:"manual", scopeType:"task", scopeId: DOTS_TASK_ID });
  const revision = agent.kernelMemoryHistory(shared.id)[0]!.revision;
  const lookup = (id: string) => id === shared.id ? { revision, content: shared.content } : undefined;
  for (const [name, args] of [["memory_search", { query: "reference-evidence-7462" }], ["memory_get", { id: shared.id }]] as const) {
    const result = await turn(args, name);
    assert(!result.error, result.text);
    const callId = "read-version";
    const call = { role: "assistant", tool_calls: [{ id: callId, function: { name, arguments: JSON.stringify(args) } }] };
    const reply = { role: "tool", tool_call_id: callId, content: result.text };
    assert.deepEqual(observeDotsWireEvidence([call, reply], lookup).witnesses, [shared.id+"@"+revision]);
    assert.deepEqual(observeDotsWireEvidence([reply], lookup).witnesses, []);
    assert.deepEqual(observeDotsWireEvidence([call, reply], () => ({ revision: revision+1, content: shared.content })).witnesses, []);
  }
  assert((await turn({action:"delegate",targetTaskId:task.id,text:"引用测试",memoryRefs:[{id:secret.id,revision:1}]})).error);
  assert((await turn({action:"delegate",targetTaskId:task.id,text:"引用测试",memoryRefs:[{id:shared.id,revision:revision+1}]})).error);
  const withSource = await success({action:"delegate",targetTaskId:task.id,text:"按共享约定处理",memoryRefs:[{id:shared.id,revision}]});
  await agent.waitForSubmission(withSource.receipt);
  assert(observedDelegatedEvidence, "worker provider receives current shared fact");
  const persistent = await agent.loadTaskHistory(task.id);
  assert(!JSON.stringify(persistent).includes("reference-evidence-7462"), "worker transcript owns references only");
    const createdGoal = agent.createConversationGoal({taskId:task.id,title:"长期客户报价",description:"持续维护",criteria:[{text:"完成专属目标"}]});
  assert(createdGoal.ok);
  const goal = createdGoal.goal;
  assert((await turn({action:"delegate",targetTaskId:task.id,goalId:"wrong-goal",text:"阶段任务"})).error);
  const linkedGoal = await success({action:"delegate",targetTaskId:task.id,goalId:goal.id,text:"完成本轮阶段任务"});
  assert.equal(linkedGoal.goalId,goal.id);
  await agent.waitForSubmission(linkedGoal.receipt);
  const storedGoal = db.connection.prepare("SELECT goal_id FROM dots_delegations WHERE operation_id=?").get(linkedGoal.receipt.operationId) as {goal_id:string};
  assert.equal(storedGoal.goal_id,goal.id);
  assert.equal(agent.getConversationGoals().getLive(task.id,goal.id)?.status,"active");
  mkdirSync(join(folder,"weekly"));
  writeFileSync(join(folder,"weekly","index.txt"),"客户资料索引");
  weeklyLookup = true;
  const learning = await success({action:"delegate",spaceId:space.id,name:"索引查找",text:"帮我查找并读取 index.txt"});
  await agent.waitForSubmission(learning.receipt);
  assert.equal(db.connection.prepare("SELECT 1 FROM work_execution_bindings WHERE task_id=?").get(learning.id),undefined);
  assert.deepEqual(weeklyReads,["index.txt","weekly/index.txt"]);
  db.upsertSpace({id:"sp-gw-test",name:"渠道根目录"});
  db.upsertSpace({id:"ordinary-sounding-child",name:"客户子空间",parentId:"sp-gw-test"});
  db.upsertTask({id:"inherited-channel-task",title:"隔离探针甲",spaceId:"ordinary-sounding-child",updatedAt:Date.now()});
  db.upsertTask({id:"externally-pinned",title:"隔离探针乙",spaceId:space.id,externalAgentPin:{id:"devin",name:"external",pinnedAt:1},updatedAt:Date.now()});
  const isolated = await success({action:"board",query:"隔离探针"});
  assert.deepEqual(isolated.tasks,[]);
  assert.equal(isolated.next,undefined);
  assert((await turn({action:"task",targetTaskId:"externally-pinned"})).error);
  const manualId = "user-native-a08";
  db.upsertTask({id:manualId, spaceId:space.id, title:"月度汇总", updatedAt:Date.now()});
  writeFileSync(join(folder,"manual-report-a08.txt"),"独立快照 6821");
  weeklyLookup = true;
  registerManualReport = true;
  await fixture.prompt({taskId:manualId, spaceId:space.id, text:"查找并读取 index.txt，登记月报",userMessageId:"manual-request-a08",assistantMessageId:"manual-answer-a08"});
  assert.equal(db.connection.prepare("SELECT 1 FROM work_execution_bindings WHERE task_id=?").get(manualId),undefined);
  assert.equal(db.connection.prepare("SELECT 1 FROM dots_delegations WHERE task_id=?").get(manualId),undefined);
  for (const query of ["manual-report-a08.txt","批次 B882 净额"]) {
    const result = await success({action:"deliveries",spaceId:space.id,query});
    const original = result.results.find((r:{taskId:string}) => r.taskId === manualId);
    assert(original,JSON.stringify(result)); assert.equal(original.source,"native");
    assert(original.answerEntryId > 0 && original.submissionId > 0);
    assert(original.link.includes("mybuddy://task/" + manualId));
    assert(original.text.includes("6821"));
    const file = original.artifacts[0];
    assert.equal(file.name,"manual-report-a08.txt");
    assert.equal(readFileSync(file.id.slice("saved:".length),"utf8"),"独立快照 6821");
    const href = /\((file:\/\/\/.+)\)$/.exec(file.link)?.[1];
    assert(href);
    assert.equal(readFileSync(pathFromMarkdownHref(href)!,"utf8"),"独立快照 6821");
  }
  assert(!(await success({action:"deliveries",targetTaskId:task.id,query:"批次 B882 净额"})).results.length);
  const reviewed = await agent.nativeImprovement.review();
  assert(reviewed.items.some(item => item.pathHint?.includes("weekly/index.txt") && item.sources.some(source => source.taskId === manualId)));
  console.log("PASS user-created native task: standalone result and registered snapshot search, original task link, isolated scope and native weekly experience");
  const experience = reviewed.items.find(item => item.pathHint?.includes("weekly/index.txt") && item.sources.some(source => source.taskId === learning.id));
  assert(experience, "weekly learning reads the Dots worker's matched native failure and success");
  assert(experience.sources.some(source => source.actor === "main" && source.trigger > source.input && source.entry > source.trigger));
  assert.deepEqual(agent.listKernelMemoryTurns({taskId:learning.id}),[], "worker prose is not a user memory turn");
  const hint = await agent.nativeImprovement.readHints.suggest(learning.id,folder,"index.txt","verify","reuse","test");
  assert(hint?.includes("weekly/index.txt"),"verified task-scoped experience can be reused");
  assert.equal(await agent.nativeImprovement.readHints.suggest(task.id,folder,"index.txt","verify","other","test"),undefined);
  console.log("PASS Dots ordinary worker: weekly native repair evidence, scoped reusable path hint, zero personal-memory turns");
  const child = await success({action:"create_space", spaceId:space.id, name:"新报价"}, 2);
  assert.equal(child.parentId, space.id);
  assert.equal(child.path, join(folder,"新报价"));
  assert.equal(db.listSpaces().filter(row => row.parentId === space.id && row.name === "新报价").length, 1);
  writeFileSync(join(child.path,"input.txt"),"新空间独有资料");
  readFile = true;
  const childJob = await success({action:"delegate",spaceId:child.id,name:"读新报价资料",text:"读取 input.txt"});
  await agent.waitForSubmission(childJob.receipt);
  assert.equal(db.getTask(childJob.id)?.spaceId, child.id);
  assert.match(ordinaryReadResult,/新空间独有资料/);
  assert((await turn({action:"create_space",spaceId:space.id,name:"../越界"})).error);
  console.log("PASS Dots creates a workspace folder once and delegates native work inside it");
  console.log("PASS proactive pause, scoped batch and unrelated active task isolation, preserved subscriptions, global stop of Dots timers only, explicit existing Goal");
  console.log("PASS file follow-up: native filesystem event and native target receipt, one-time dispatch, cancellation, stale user intent, offline catch-up");
  console.log("PASS Dots: native foreground tools, board, bound files, delegation and replay, accepted steer, persistent pause/stop, resume, exact blocked-question answer, prior result search and isolated scheduling");
} finally {
  holdTarget = false;
  release?.();
  await actions.closeFileWatches();
  journal.close();
  await journal.drain();
  cron.stop();
  terminal.dispose();
  await fixture.close();
  db.close();
}
