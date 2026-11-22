import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { DOTS_NO_CHANGE, DOTS_TASK_ID } from "../src/shared/dots";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";

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
let replayAdmissions = 0;
const answer = "盘点结果是 37 件，其中 2 件需要补货。";

async function open(fault?: "before" | "after" | "waitForStop" | "unchanged") {
  const db = new AppDatabase(join(root, "app.db"));
  const artifacts = createArtifactDomain(db.connection);
  db.openDots();
  const space = db.getSpace("sp-stock") ?? db.createSpace({id:"sp-stock",name:"库存",path:root});
  const fixture = await createAgentDurableFixture(root, db, input => {
    const tools = getCurrentTools(input.messages);
    const latest = input.messages.at(-1);
    if (latest?.role === "toolResult") return [{type:"text", text:"接到了，我去盘点。"}];
    if (latest?.role === "user" && tools.some(t => t.name === "dots_action") && JSON.stringify(latest.content).includes("停止盘点")) {
      const task = stoppedTarget && db.getTask(stoppedTarget);
      assert.ok(task);
      return [{type:"toolCall", id:"stop-inventory",name:"dots_action",arguments:{action:"stop",targetTaskId:task.id}}];
    }
    if (latest?.role === "user" && tools.some(t => t.name === "automation_exec") && JSON.stringify(latest.content).includes("约在稍后"))
      return [{type:"toolCall",id:"set-reminder",name:"automation_exec",arguments:{action:"create",name:"到点盘点",prompt:"请委派盘点库存。",
        schedule_type:"at",schedule_expr:new Date(Date.now()+2500).toISOString(),max_runs:1}}];
    if (tools.some(t => t.name === "dots_action")) return [{type:"toolCall", id:"delegate-" + fault,
      name:"dots_action", arguments:{action:"delegate", spaceId:space.id, name:"库存盘点", text:"盘点库存，直接回复数字。"}}];
    if (tools.some(t => t.name === "write")) { workerCalls++; return [{type:"text", text:fault==="unchanged" ? DOTS_NO_CHANGE : answer}]; }
    return [{type:"text", text:'{"candidates":[]}'}];
  }, { deferRecovery: true });
  const agent = fixture.agent;
  const cron = new CronService(db, agent);
  const terminal = new TerminalHost({resolveCwd:()=>root});
  agent.setLocalWorkflowServices({cron,terminal:new TaskTerminalService(terminal)});
  agent.setArtifactDomain(artifacts.service, artifacts.coordinator);
  const journal = new DotsDelegations(db.connection, (id, op) => agent.dotsSubmission(id, op), () => {});
  const actions = new DotsActions(db, agent, {
    link:(...args) => journal.link(...args), rememberOrigin:(...args) => journal.rememberOrigin(...args),
    list:() => journal.list(), changed:() => journal.refresh(), failed:(...args) => journal.failed(...args),
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
    writeFileSync(join(root, fault+"-cut.json"), JSON.stringify({pid:process.pid, workerCalls, committedReplies:delivered.length}));
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
  });
  const off = agent.onPatch(patch => {
    if (patch.type === "durable_delta" && !patch.delta.state.busy) journal.refresh(patch.taskId);
  });
  await agent.resumePersistedTasks();
  await journal.recover(async req => { replayAdmissions++; return agent.prompt(req); }, () => true);
  return {fixture, db, agent, journal, cron, reached:() => faultReached, async close() {
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
  assert.equal(cut.workerCalls,1);
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
mkdirSync("out/tests",{recursive:true});
writeFileSync("out/tests/dots-reply-recovery.json", JSON.stringify(evidence,null,2)+"\n");
console.log("PASS both crash boundaries and repeated events: original conversation received one new assistant reply, ordinary task ran once");
