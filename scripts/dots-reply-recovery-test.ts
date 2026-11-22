import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { DOTS_NO_CHANGE, DOTS_TASK_ID } from "../src/shared/dots";
import { DotsReplyOutbox } from "../src/main/dots/DotsReplyOutbox";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy } from "../src/shared/answer-routing";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";
import { resolveDotsPreferences } from "../src/shared/dots-settings";

const faultHost = process.argv[2];
const root = faultHost ? process.argv[3]! : mkdtempSync(join(tmpdir(), "dots-reply-recovery-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { createArtifactDomain } = await import("../src/main/artifact/ArtifactDomainSetup");
const { CronService } = await import("../src/main/cron/CronService");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 35));
const evidence: unknown[] = [];
let workerCalls = 0;
const workerInputs: unknown[] = [];
let replayAdmissions = 0;
const answer = "盘点结果是 37 件，其中 2 件需要补货。";

async function open(fault?: "before" | "after" | "waitForStop" | "unchanged" | "foregroundError" | "cancelInFlight" | "policyProgress" | "activityOnly") {
  const db = new AppDatabase(join(root, "app.db"));
  const artifacts = createArtifactDomain(db.connection);
  db.openDots();
  const space = db.getSpace("sp-stock") ?? db.createSpace({id:"sp-stock",name:"库存",path:root});
  let enteredTimer = false;
  let reportedProgress = false;
  let releaseTimer!: () => void;
  const timerGate = new Promise<void>(resolve => { releaseTimer = resolve; });
  if (fault === "activityOnly") writeFileSync(join(root, "signal.txt"), "fixture signal 42");
  const fixture = await createAgentDurableFixture(root, db, async input => {
    const tools = getCurrentTools(input.messages);
    const latest = input.messages.at(-1);
    if (fault === "activityOnly" && !tools.some(t => t.name === "dots_action") && tools.some(t => t.name === "read")) {
      if (latest?.role === "toolResult" && latest.toolCallId === "activity-read") {
        enteredTimer = true;
        await timerGate;
        return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "42" }) }];
      }
      return [{ type: "toolCall", id: "activity-read", name: "read", arguments: { path: "signal.txt" } }];
    }
    if (latest?.role === "toolResult") {
      if (fault === "foregroundError" && latest.toolCallId === "delegate-foregroundError")
        return { content: [], errorMessage: "fixture foreground provider unavailable after delegation" };
      return [{type:"text", text:"接到了，我去盘点。"}];
    }
    if (latest?.role === "user" && tools.some(t => t.name === "dots_action") && JSON.stringify(latest.content).includes("停止盘点")) {
      const task = stoppedTarget && db.getTask(stoppedTarget);
      assert.ok(task);
      return [{type:"toolCall", id:"stop-inventory",name:"dots_action",arguments:{action:"stop",targetTaskId:task.id}}];
    }
    if (latest?.role === "user" && tools.some(t => t.name === "automation_exec") && JSON.stringify(latest.content).includes("约在稍后"))
      return [{type:"toolCall",id:"set-reminder",name:"automation_exec",arguments:{action:"create",name:"到点盘点",prompt:"请委派盘点库存。",
        schedule_type:"at",schedule_expr:new Date(Date.now()+2500).toISOString(),max_runs:1}}];
    if (tools.some(t => t.name === "dots_action")) {
      if (fault === "cancelInFlight" && latest?.role === "user" && JSON.stringify(latest.content).includes("待取消的定时运行")) {
        enteredTimer = true;
        await timerGate;
      }
      return [{type:"toolCall", id:"delegate-" + fault,
        name:"dots_action", arguments:{action:"delegate", spaceId:space.id, name:"库存盘点", text:"盘点库存，直接回复数字。"}}];
    }
    if (tools.some(t => t.name === "write")) {
      workerCalls++;
      workerInputs.push(input.messages.slice(-2).map(message => ({role:message.role, content:message.content})));
      if (fault === "policyProgress" && !reportedProgress) {
        reportedProgress = true;
        return [{type:"text",text:JSON.stringify({dotsState:"progress",result:"盘点已做完，数字待交付。",remainingQuote:"直接回复数字。"})}];
      }
      return [{type:"text", text:fault==="unchanged" ? DOTS_NO_CHANGE : JSON.stringify({dotsState:"complete",result:answer})}];
    }
    return [{type:"text", text:'{"candidates":[]}'}];
  }, { deferRecovery: true });
  const agent = fixture.agent;
  const timerNotices: string[] = [], fileNotices: string[] = [];
  const progressNotices = new Map<string,string>();
  const cron = new CronService(db, agent, undefined, undefined, undefined, notice => timerNotices.push(notice.jobId));
  const terminal = new TerminalHost({resolveCwd:()=>root});
  agent.setLocalWorkflowServices({cron,terminal:new TaskTerminalService(terminal)});
  agent.setArtifactDomain(artifacts.service, artifacts.coordinator);
  const journal = new DotsDelegations(db.connection, (id, op) => agent.dotsSubmission(id, op), () => {});
  const actions = new DotsActions(db, agent, {
    link:(...args) => journal.link(...args), rememberOrigin:(...args) => journal.rememberOrigin(...args),
    observeTool:event => journal.observeTool(event),
    list:() => journal.list(), changed:() => journal.refresh(), failed:(...args) => journal.failed(...args),
    preferences:() => resolveDotsPreferences(agent.getAppSettings().dotsSettings),
    fileNotice:notice => fileNotices.push(notice.id),
    progressNotice:notice => progressNotices.set(notice.operationId,notice.text),
  });
  agent.setDotsActions(actions);
  let faultReached = false;
  let stoppedTarget: string | undefined;
  async function interrupt(source: string) {
    const history = (await agent.loadTaskHistory(DOTS_TASK_ID)).messages;
    assert(history.some(m => m.role === "assistant" && m.text === "接到了，我去盘点。"));
    const delivered = history.filter(m => m.dotsDelivery?.sourceMessageId === source);
    assert.equal(delivered.length, fault === "before" ? 0 : 1);
    assert.equal(journal.list([source])[0]?.status, "completed");
    writeFileSync(join(root, fault+"-cut.json"), JSON.stringify({pid:process.pid, workerCalls, workerInputs, committedReplies:delivered.length}));
    // End the actual writer process with both SQLite stores still open.
    process.exit(73);
  }
  journal.connect((job, request) => actions.followup(job, request), async (reply, valid) => {
    if (fault === "before") {
      if ((await agent.findSubmission(DOTS_TASK_ID, reply.sourceMessageId))?.receipt?.status !== "done") return "pending";
      await interrupt(reply.sourceMessageId);
    }
    if (fault === "waitForStop") { faultReached = true; stoppedTarget=reply.taskId; return "pending"; }
    const result = await agent.appendDotsReply(reply, valid);
    if (fault === "after" && result === "appended") await interrupt(reply.sourceMessageId);
    return result;
  }, taskId => actions.allowsResult(taskId), kind => actions.allowsReply(kind));
  const off = agent.onPatch(patch => {
    if (patch.type === "durable_delta" && !patch.delta.state.busy) journal.refresh(patch.taskId);
  });
  await agent.resumePersistedTasks();
  await journal.recover(async req => { replayAdmissions++; return agent.prompt(req); }, () => true);
  return {fixture, db, agent, journal, cron, actions, timerNotices, fileNotices, progressNotices, reached:() => faultReached, enteredTimer:()=>enteredTimer, releaseTimer, async close() {
    releaseTimer();
    cron.stop(); terminal.dispose(); off(); journal.close(); await journal.drain(); await actions.closeFileWatches(); await fixture.close(); db.close();
  }};
}

if (faultHost) {
  assert(faultHost === "before" || faultHost === "after");
  const source = "inventory-" + faultHost;
  const host = await open(faultHost);
  try {
    await host.fixture.prompt({taskId: DOTS_TASK_ID, userMessageId:source, assistantMessageId:source+"-ack", text:"盘点库存，直接回复数字。"});
    const deadline = Date.now()+25000;
    while (Date.now()<deadline) { host.journal.refresh(); await host.journal.drain(); await sleep(); }
    assert.fail("did not reach handoff boundary: "+JSON.stringify(host.journal.list()));
  } finally { await host.close(); }
}
for (const fault of ["before","after"] as const) {
  const source = "inventory-" + fault;
  const previousCalls = workerCalls;
  const child = spawnSync(process.execPath, [process.argv[1]!, fault, root], {encoding:"utf8", timeout:75000, windowsHide:true});
  assert.equal(child.status, 73, child.error?.message ?? child.stderr + child.stdout);
  const cut = JSON.parse(readFileSync(join(root,fault+"-cut.json"),"utf8"));
  assert.equal(cut.workerCalls,1,JSON.stringify(cut.workerInputs));
  assert.notEqual(cut.pid,process.pid);
  const host = await open();
  try {
    const job = host.journal.list([source])[0]!;
    for(let i=0;i<4;i++) { host.journal.refresh(job.taskId); host.journal.refresh(DOTS_TASK_ID); await host.journal.drain(); }
    const messages = (await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
    const [sourceEntry] = messages.filter(m=>m.inputRequestId===source);
    const results = messages.filter(m=>m.dotsDelivery?.sourceMessageId===source);
    assert.ok(sourceEntry);
    assert.equal(results.length,1);
    assert.equal(results[0]!.role,"assistant"); assert.equal(results[0]!.text,answer);
    assert.equal(results[0]!.dotsDelivery!.origin?.entryId, Number(sourceEntry.entryId));
    assert.equal(results[0]!.dotsDelivery!.artifacts.length,0);
    assert.equal(messages.filter(m => m.role==="user" && m.inputRequestId===source).length,1);
    assert(!(await host.agent.loadTaskHistory(job.taskId)).messages.some(m=>m.dotsDelivery));
    assert.equal(workerCalls, previousCalls); assert.equal(replayAdmissions,0);
    evidence.push({fault,source,writerPid:cut.pid,recoveryPid:process.pid,committedBeforeExit:cut.committedReplies,
      workerCalls:cut.workerCalls,additionalWorkerCalls:workerCalls-previousCalls,replayAdmissions,
      messages:messages.slice(messages.indexOf(sourceEntry)).map(m=>({id:m.id,entryId:m.entryId,role:m.role,text:m.text,origin:m.dotsDelivery?.origin}))});
  } finally { await host.close(); }
}
const timedHost = await open();
try {
  const source = "scheduled-inventory";
  timedHost.cron.start();
  const before = workerCalls;
  await timedHost.fixture.prompt({taskId:DOTS_TASK_ID,userMessageId:source,assistantMessageId:"timer-ack",text:"约在稍后，请在周转库委派盘点库存。"});
  const deadline = Date.now()+30000;
  let records = (await timedHost.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
  while (!records.some(m=>m.dotsDelivery?.sourceMessageId===source) && Date.now()<deadline) {
    await sleep();
    records = (await timedHost.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
  }
  const replies = records.filter(m=>m.dotsDelivery?.sourceMessageId===source);
  assert.equal(replies.length,1);
  const timer = timedHost.cron.listForTask(DOTS_TASK_ID).find(job=>job.name==="到点盘点")!;
  assert.equal(timedHost.db.listCronJobRuns(timer.id,3).length,1);
  assert.equal(workerCalls,before+1);
  assert.equal(replies[0]!.text,answer);
  assert.equal(replies[0]!.dotsDelivery?.origin?.entryId,Number(records.find(m=>m.inputRequestId===source)?.entryId));
  evidence.push({cause:"timer",source,reply:replies[0]!.id,text:replies[0]!.text,workerCalls:workerCalls-before});
  console.log("PASS real timer delegated a worker and delivered its answer to the original scheduling message");
} finally { await timedHost.close(); }
for (const scenario of ["waitForStop","unchanged"] as const) {
  const host = await open(scenario);
  try {
    const source = "inventory-" + scenario;
    const before = workerCalls;
    await host.fixture.prompt({taskId:DOTS_TASK_ID,userMessageId:source,assistantMessageId:source+"-ack",text:"检查库存，有变化再回复。"});
    const deadline = Date.now()+25000;
    while (Date.now()<deadline && (scenario==="waitForStop" ? !host.reached() : host.journal.list([source])[0]?.status!=="completed")) {
      host.journal.refresh(); await host.journal.drain(); await sleep();
    }
    const job = host.journal.list([source])[0]!;
    assert.equal(job.status,"completed");
    if (scenario==="waitForStop") {
      assert.ok(host.reached());
      await host.fixture.prompt({taskId:DOTS_TASK_ID,userMessageId:"stop-commission",assistantMessageId:"stop-ack",text:"停止盘点。"});
      const state = host.db.connection.prepare("SELECT state FROM dots_target_controls WHERE task_id=?").pluck().get(job.taskId);
      assert.equal(state,"stopped");
    }
    host.journal.refresh(job.taskId); await host.journal.drain();
    const pending = host.db.connection.prepare("SELECT count(*) FROM dots_reply_events WHERE operation_id=? AND settled=0").pluck().get(job.id);
    assert.equal(pending,0);
    const resultMessages=(await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages.filter(m=>m.dotsDelivery?.sourceMessageId===source);
    assert.equal(resultMessages.length,0); assert.equal(workerCalls,before+1);
    evidence.push({cause:scenario,source,additionalMessages:resultMessages.length,workerCalls:workerCalls-before});
  } finally { await host.close(); }
}
console.log("PASS an explicit stop before send, and an unchanged check, publish no extra message or execution");
const failureSource = "inventory-foreground-error";
const failingHost = await open("foregroundError");
try {
  const before = workerCalls;
  const accepted = await failingHost.agent.prompt({taskId:DOTS_TASK_ID,userMessageId:failureSource,
    assistantMessageId:"error-ack",modelId:"fixture/model",text:"盘点库存，直接回复数字。"});
  assert.ok(accepted.receipt);
  const settled = await failingHost.agent.waitForSubmission(accepted.receipt);
  assert.equal(settled.receipt?.status, "unanswered");
  let resultMessages: Awaited<ReturnType<typeof failingHost.agent.loadTaskHistory>>["messages"] = [];
  for (let i=0; i<200 && !resultMessages.length; i++) {
    const job = failingHost.journal.list([failureSource])[0];
    if (job) {
      assert.equal((await failingHost.agent.loadTaskHistory(job.taskId)).messages.some(m => m.dotsDelivery), false);
      failingHost.journal.refresh(job.taskId);
    }
    await failingHost.journal.drain();
    const {messages} = await failingHost.agent.loadTaskHistory(DOTS_TASK_ID);
    resultMessages = messages.filter(m => m.dotsDelivery?.sourceMessageId === failureSource);
    if (resultMessages.length) {
      assert.equal(resultMessages[0]!.dotsDelivery?.origin?.entryId, Number(messages.find(m => m.inputRequestId === failureSource)?.entryId));
      assert.equal(resultMessages[0]!.text, answer);
    } else await sleep();
  }
  assert.equal(resultMessages.length, 1);
  assert.equal(workerCalls, before+1);
} finally { await failingHost.close(); }
const reopened = await open();
try {
  const {messages} = await reopened.agent.loadTaskHistory(DOTS_TASK_ID);
  assert.equal(messages.filter(m => m.dotsDelivery?.sourceMessageId === failureSource).length, 1);
  assert.equal(replayAdmissions, 0);
} finally { await reopened.close(); }
console.log("PASS a failed foreground acknowledgement still delivers the worker result once to the original input after reopening");
const cancelHost = await open("cancelInFlight");
let cancelledRunId = "";
let cancelledTimerId = "";
let legacyTimerId = "";
let restartPauseTimerId = "";
const beforeCancellation = workerCalls;
try {
  const tasksBeforeTimer = cancelHost.db.listTasks().map(task => task.id).sort();
  const timer = (name: string) => cancelHost.cron.createForTask(DOTS_TASK_ID, root, {
    name,prompt:name,scheduleType:"every",scheduleExpr:"5h",timezone:"UTC",target:"current-task",missedRuns:"coalesce",
  });
  const history = await cancelHost.agent.loadTaskHistory(DOTS_TASK_ID);
  const original = history.messages.find(message => message.inputRequestId === failureSource);
  assert.ok(original?.entryId);
  const cancelledTimer = cancelHost.cron.createForTask(DOTS_TASK_ID,root,{
    name:"待取消的定时运行",prompt:"待取消的定时运行",scheduleType:"every",scheduleExpr:"5h",timezone:"UTC",
    target:"current-task",missedRuns:"coalesce",maxRuns:1,
  }, undefined, {source:failureSource,origin:{conversationId:Number(history.durable?.conversationId),entryId:Number(original.entryId)},
    owner:{spaceId:"sp-stock"}});
  cancelledTimerId = cancelledTimer.id;
  cancelHost.cron.start();
  await cancelHost.cron.runNow(cancelledTimer.id);
  for (let i=0; i<200 && !cancelHost.enteredTimer(); i++) await sleep();
  assert(cancelHost.enteredTimer());
  cancelledRunId = cancelHost.db.listCronJobRuns(cancelledTimer.id,1)[0]!.id;
  await cancelHost.actions.execute(DOTS_TASK_ID,"user-stops-inventory-schedules",{action:"stop_all",spaceId:"sp-stock"});
  assert(cancelHost.db.getCronJob(cancelledTimer.id)?.cancelledAt);
  cancelHost.cron.stop();
  const source = `cron-${cancelledRunId}-input`;
  const native = await cancelHost.agent.findSubmission(DOTS_TASK_ID,source);
  assert.ok(native?.receipt);
  cancelHost.releaseTimer();
  await cancelHost.agent.waitForSubmission(native.receipt);
  assert.deepEqual(cancelHost.journal.list([source]),[]);
  assert.deepEqual(cancelHost.db.listTasks().map(task => task.id).sort(), tasksBeforeTimer);
  assert.equal(workerCalls,beforeCancellation);

  // The prior app stored only the timers it disabled in this pause receipt.
  legacyTimerId = timer("旧版主动暂停计划").id;
  restartPauseTimerId = cancelHost.cron.createForTask(DOTS_TASK_ID,root,{
    name:"重启后仍手动暂停",prompt:"重启后仍手动暂停",scheduleType:"every",scheduleExpr:"5h",timezone:"UTC",
    target:"current-task",restartPolicy:"pause",
  }).id;
  cancelHost.db.setCronEnabled(legacyTimerId,false);
  cancelHost.db.setCronEnabled(restartPauseTimerId,false);
  cancelHost.db.connection.prepare("INSERT INTO dots_proactive_pauses VALUES('',?)").run(JSON.stringify([legacyTimerId,restartPauseTimerId]));
} finally { await cancelHost.close(); }
const restoredTimerHost = await open();
try {
  restoredTimerHost.cron.start();
  for (let i=0; i<200 && restoredTimerHost.db.listCronJobRuns(cancelledTimerId,1)[0]?.status === "running"; i++) await sleep();
  const cancelledRun = restoredTimerHost.db.listCronJobRuns(cancelledTimerId,1)[0]!;
  assert.equal(cancelledRun.id,cancelledRunId);
  assert.equal(cancelledRun.status,"error");
  assert.equal(restoredTimerHost.db.listCronJobRuns(cancelledTimerId,10).length,1);
  assert.equal(workerCalls,beforeCancellation);
  assert.equal(restoredTimerHost.db.getCronJob(legacyTimerId)?.enabled,false);
  await restoredTimerHost.actions.execute(DOTS_TASK_ID,"user-restores-legacy-schedules",{action:"resume_proactive"});
  assert.equal(restoredTimerHost.db.getCronJob(legacyTimerId)?.enabled,true);
  assert.equal(restoredTimerHost.db.getCronJob(restartPauseTimerId)?.enabled,false);
} finally { await restoredTimerHost.close(); }
console.log("PASS cancellation during native timer generation blocks delegation and restart replay; legacy proactive pause resumes its original timer");
const policies = await open();
try {
  const scope = "sp-stock";
  const deniedDir = join(root, "dots-private-scope");
  mkdirSync(deniedDir, {recursive:true});
  writeFileSync(join(deniedDir,"private.txt"),"hidden workspace evidence");
  const denied = policies.db.createSpace({id:"dots-private-scope",name:"不可见空间",path:deniedDir});
  policies.db.upsertTask({id:"dots-private-task",title:"不可见事项",spaceId:denied.id,updatedAt:Date.now()});
  const setMode = (followupMode: "paused" | "notify" | "continue", spaceIds: string[] | null = [scope]) =>
    policies.agent.updateAppSettings({dotsSettings:{...resolveDotsPreferences(policies.agent.getAppSettings().dotsSettings),followupMode,spaceIds}});
  await setMode("paused");
  const board = await policies.actions.execute(DOTS_TASK_ID,undefined,{action:"board"});
  assert(!JSON.stringify(board).includes("不可见事项"));
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,undefined,{action:"task",targetTaskId:"dots-private-task"}),/未授权/);
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,undefined,{action:"read_file",spaceId:scope,path:"dots-private-scope/private.txt"}),/未授权/);
  const sameBinding = {action:"bind" as const,spaceId:scope,path:root};
  const originalBinding = await policies.actions.execute(DOTS_TASK_ID,"keep-authorized-binding",sameBinding);
  assert.deepEqual(await policies.actions.execute(DOTS_TASK_ID,"keep-authorized-binding",sameBinding),originalBinding);
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,"bind-hidden-directory",{...sameBinding,path:deniedDir}),/未授权/);
  assert.equal(policies.db.getSpace(scope)?.path,root);
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,"reuse-hidden-directory",
    {action:"create_space",spaceId:scope,name:"dots-private-scope"}),/未授权/);
  assert.equal(policies.db.findChildSpaceByName(scope,"dots-private-scope"),undefined);
  const library = policies.agent.dotsLibrary();
  const deniedShelf = library.ensureOwnedSpace({type:"workspace",workspaceId:denied.id});
  const hiddenNote = library.createItem({spaceId:deniedShelf.id,kind:"markdown",title:"不可见资料",content:"越权资料内容"});
  library.attachToTask({taskId:DOTS_TASK_ID,itemId:hiddenNote.id});
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,undefined,{action:"read_material",itemId:hiddenNote.id}),/当前范围/);
  await assert.rejects(policies.actions.execute(DOTS_TASK_ID,"cancel-hidden-known-task",{action:"stop",targetTaskId:"dots-private-task"}),/没有可控制/);
  await setMode("paused", []);
  const noSpaces = await policies.actions.execute(DOTS_TASK_ID,undefined,{action:"board"});
  assert.deepEqual(noSpaces,{tasks:[],next:undefined});
  await setMode("paused");
  const direct = "explicit-delegation-while-automation-paused";
  const settled = await policies.fixture.prompt({taskId:DOTS_TASK_ID,userMessageId:direct,assistantMessageId:direct+"-assistant",text:"请直接替我盘点库存。"});
  assert.ok(settled.receipt);
  let history = await policies.agent.loadTaskHistory(DOTS_TASK_ID);
  for (let i=0; i<200 && !history.messages.some(m=>m.dotsDelivery?.sourceMessageId===direct); i++) {
    await sleep();
    history = await policies.agent.loadTaskHistory(DOTS_TASK_ID);
  }
  const source = history.messages.find(m=>m.inputRequestId===direct);
  assert.ok(source);
  assert(history.messages.some(m=>m.dotsDelivery?.sourceMessageId===direct && m.text===answer));
  const watchedTask = "dots-settings-file-policy";
  policies.db.upsertTask({id:watchedTask,title:"设置范围文件事件",spaceId:scope,updatedAt:Date.now()});
  const watchFile = join(root,"dots-settings-file.txt");
  writeFileSync(watchFile,"before");
  policies.actions.startFileWatches();
  const watch = await policies.actions.execute(DOTS_TASK_ID,direct,{action:"watch_file",targetTaskId:watchedTask,path:"dots-settings-file.txt",text:"输出文件记录"});
  assert("id" in watch);
  const timer = policies.cron.createForTask(DOTS_TASK_ID,root,{
    name:"暂停期间到期",prompt:"自动盘点库存",scheduleType:"at",scheduleExpr:new Date(Date.now()+500).toISOString(),timezone:"UTC",
    target:"current-task",missedRuns:"coalesce",maxRuns:1,
  }, undefined, {source:direct,origin:{conversationId:Number(history.durable?.conversationId),entryId:Number(source.entryId)},owner:{spaceId:scope}});
  const before = workerCalls;
  policies.cron.start();
  writeFileSync(watchFile,"after");
  await new Promise(resolve=>setTimeout(resolve,650));
  assert.deepEqual(policies.timerNotices,[]);
  assert.deepEqual(policies.fileNotices,[]);
  assert.equal(workerCalls,before);
  await setMode("notify");
  for (let i=0; i<200 && (!policies.timerNotices.length || !policies.fileNotices.length); i++) await sleep();
  assert.deepEqual(policies.timerNotices,[timer.id]);
  assert.deepEqual(policies.fileNotices,[watch.id]);
  assert.equal(workerCalls,before);
  assert.equal(policies.db.listCronJobRuns(timer.id,10).length,0);
  await setMode("continue");
  for (let i=0; i<200 && (workerCalls<before+2 || policies.db.listCronJobRuns(timer.id,1)[0]?.status!=="success"); i++) await sleep();
  assert.equal(workerCalls,before+2);
  assert.equal(policies.db.listCronJobRuns(timer.id,10).length,1);
  assert.equal(policies.db.listCronJobRuns(timer.id,1)[0]?.status,"success");
  const cancelledWatch = await policies.actions.execute(DOTS_TASK_ID,"new-watch-policy",{action:"watch_file",targetTaskId:watchedTask,path:"dots-settings-file.txt",text:"再看文件"});
  assert("id" in cancelledWatch && typeof cancelledWatch.id === "string");
  await setMode("paused",[]);
  const cancel = await policies.actions.execute(DOTS_TASK_ID,"revoke-watch-policy",{action:"cancel_watch",watchId:cancelledWatch.id,targetTaskId:watchedTask});
  assert.deepEqual(cancel,{state:"cancelled"});
  await setMode("continue",null);
} finally { await policies.close(); }
console.log("PASS live Dots mode and workspace settings: paused delivery, notify-only due events, resumed once, scoped reads and control");
const progressPolicy = await open("policyProgress");
try {
  const source = "paused-worker-progress";
  await progressPolicy.agent.updateAppSettings({dotsSettings:{...resolveDotsPreferences(progressPolicy.agent.getAppSettings().dotsSettings),followupMode:"paused"}});
  const before = workerCalls;
  await progressPolicy.fixture.prompt({taskId:DOTS_TASK_ID,userMessageId:source,assistantMessageId:source+"-assistant",text:"继续盘点并回复数字。"});
  for (let i=0; i<200 && progressPolicy.journal.list([source])[0]?.status!=="completed"; i++) await sleep();
  await progressPolicy.journal.drain();
  assert.equal(progressPolicy.journal.list([source]).length,1);
  assert.equal(workerCalls,before+1);
  assert.equal(progressPolicy.progressNotices.size,0);
  await progressPolicy.agent.updateAppSettings({dotsSettings:{...resolveDotsPreferences(progressPolicy.agent.getAppSettings().dotsSettings),followupMode:"notify"}});
  await progressPolicy.journal.drain();
  assert.equal(progressPolicy.journal.list([source]).length,1);
  assert.equal(workerCalls,before+1);
  assert.deepEqual([...progressPolicy.progressNotices.values()],["盘点已做完，数字待交付。"]);
  await progressPolicy.agent.updateAppSettings({dotsSettings:{...resolveDotsPreferences(progressPolicy.agent.getAppSettings().dotsSettings),followupMode:"continue"}});
  let rows = (await progressPolicy.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
  for (let i=0; i<200 && !rows.some(m=>m.dotsDelivery?.sourceMessageId===source && m.text===answer); i++) {
    await sleep();
    rows = (await progressPolicy.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
  }
  assert.equal(rows.filter(m=>m.dotsDelivery?.sourceMessageId===source && m.text===answer).length,1);
  assert.equal(progressPolicy.journal.list([source]).length,2);
  assert.equal(workerCalls,before+2);
} finally { await progressPolicy.close(); }
console.log("PASS changing settings resumes the one deferred ordinary-task continuation without redoing its first milestone");
const activityHost = await open("activityOnly");
try {
  const { agent, db, journal, fixture } = activityHost;
  assert.deepEqual(defaultDotsSchedulingPolicy().trackingPolicy, { milestones: true, heartbeatMs: null, silenceMs: 120_000 });
  const fallback = agent.answerRouting.list().find(rule => rule.id === defaultAnswerRuleId)!;
  agent.answerRouting.save({ ...fallback, policy: { ...fallback.policy!,
    trackingPolicy: { milestones: true, heartbeatMs: 5_000, silenceMs: 5_000 } } }, fallback);
  const source = "plain-native-activity";
  await fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: source, assistantMessageId: "activity-ack", text: "核对本地信号记录。" });
  for (let i=0; i<140 && !activityHost.enteredTimer(); i++) await sleep();
  assert(activityHost.enteredTimer());
  const before = fixture.requests.length;
  const initial = journal.list([source])[0];
  assert.equal(initial.activity?.phase, "finish");
  assert.equal(initial.activity?.tool, "read");
  assert.equal(initial.activity?.lastProgressAt, undefined);
  for (let i=0; i<240 && !journal.list([source])[0]?.activity?.lastReportAt; i++) await sleep();
  const state = journal.list([source])[0].activity!;
  assert(state.lastReportAt && state.lastReportAt > state.lastActivityAt);
  assert.equal(state.lastActivityAt, initial.activity?.lastActivityAt);
  assert.equal(state.lastProgressAt, undefined);
  assert.equal(fixture.requests.length, before);
  const history = () => agent.loadTaskHistory(DOTS_TASK_ID).then(result => result.messages);
  const progress = (await history()).find(m => m.dotsDelivery?.sourceMessageId === source && m.dotsDelivery.kind === "progress");
  assert.match(progress?.text ?? "", /工具 read 返回.*没有新的可核实进展/);
  activityHost.releaseTimer();
  for (let i=0; i<200 && journal.list([source])[0]?.status !== "completed"; i++) await sleep();
  await journal.drain();
  assert.equal((await history()).filter(m=>m.dotsDelivery?.sourceMessageId===source && m.dotsDelivery.kind==="conclusion" && m.text==="42").length,1);
  console.log("PASS read-only native activity without progress JSON returns to origin with unchanged activity/progress clocks and no extra requests");

  const outbox = new DotsReplyOutbox(db.connection);
  const target = "stale-heartbeat-fixture";
  db.upsertTask({ id: target, title: "仅用于心跳边界", updatedAt: Date.now() });
  let sends = 0;
  let permitAppend = false;
  outbox.connect(async () => { throw Error("heartbeat must bypass model/followup"); }, async (_reply, valid) => {
    if (!valid()) return "discarded";
    if (!permitAppend) return "pending";
    sends++;
    return "appended";
  });
  const pendingSample = async (id: string, window: number) => {
    journal.link(target, id, source);
    db.connection.prepare("UPDATE dots_delegations SET status='running' WHERE operation_id=?").run(id);
    db.connection.prepare("INSERT INTO dots_tool_observations(operation_id,at,tool,phase) VALUES(?,1,'read','finish')").run(id);
    const row = journal.list([source]).find(r=>r.id===id)!;
    permitAppend = false;
    assert(outbox.observeActivity(row, window, "旧活动样本"));
    assert(await outbox.flush(target, () => true));
    permitAppend = true;
  };
  await pendingSample("sample-pause", 1);
  db.connection.prepare("INSERT OR IGNORE INTO dots_proactive_pauses VALUES('', '[]')").run();
  await outbox.flush(target, () => true);
  db.connection.prepare("DELETE FROM dots_proactive_pauses WHERE scope=''").run();
  await outbox.flush(target, () => true);
  await pendingSample("sample-revised", 2);
  journal.link(target, "sample-revision-new", source, true);
  await outbox.flush(target, () => true);
  await pendingSample("sample-terminal", 3);
  db.connection.prepare("UPDATE dots_delegations SET status='completed' WHERE operation_id='sample-terminal'").run();
  await outbox.flush(target, () => true);
  await pendingSample("sample-new-fact", 4);
  db.connection.prepare("UPDATE dots_tool_observations SET at=2 WHERE operation_id='sample-new-fact'").run();
  await outbox.flush(target, () => true);
  assert.equal(sends, 0);
  assert.equal(outbox.hasPending(target), false);
  console.log("PASS queued heartbeats expire on pause, supersession, terminal status and newer native activity");
} finally { await activityHost.close(); }
mkdirSync("out/tests",{recursive:true});
writeFileSync("out/tests/dots-reply-recovery.json", JSON.stringify(evidence,null,2)+"\n");
console.log("PASS both crash boundaries and repeated events: original conversation received one new assistant reply, ordinary task ran once");
