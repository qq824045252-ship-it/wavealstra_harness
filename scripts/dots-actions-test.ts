import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathFromMarkdownHref } from "../src/renderer/src/lib/localFilePath";
import { join } from "node:path";
import { getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import type { DotsActionInput } from "../src/main/dots/DotsActions";
import { resolveDotsMemoryLimits } from "../src/shared/dots-limits";
import { observeDotsWireEvidence } from "./dots-memory-wire-evidence";

const root = mkdtempSync(join(realpathSync.native(tmpdir()), "dots-actions-"));
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
const { dotsFollowUpInput, dotsForwardingDenied, hasDotsResumeInstruction } = await import("../src/main/dots/DotsFollowUpInput");
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
let shellProbe: { id: string; command: string; timeout?: number } | undefined;
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
    if (shellProbe) {
      const { id, ...args } = shellProbe;
      shellProbe = undefined;
      return [{ type: "toolCall", id, name: "bash", arguments: args }];
    }
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
    if (JSON.stringify(last?.content).includes("collect-finished-before-pause"))
      return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "47" }) }];
  }
  return [{ type: "text", text: "已收到。" }];
}, { modelVariants: ["dots-front", "pinned-worker"] });
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
  const value = await turn(input, undefined, repeat, input.action === "resume" ? "请继续原任务" : undefined);
  assert(!value.error, value.text);
  return JSON.parse(value.text);
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert(check(), label);
}
try {
  const directive = { id: "follow-original", entryId: 100, text: "还是没看到效果啊，你追问下" };
  const screenshot = { id: "supplement", entryId: 101, text: "乱七八糟的", attachments: [{ name: "proof.png", path: join(root, "proof.png") }] };
  const expected = { source: directive, assignmentQuote: "你追问下", attachments: screenshot.attachments, captions: [screenshot.text] };
  assert.deepEqual(dotsFollowUpInput([directive, screenshot]), expected);
  assert.deepEqual(dotsFollowUpInput([screenshot, directive]), expected);
  assert.deepEqual(dotsFollowUpInput([directive, { ...screenshot, text: "截图里状态栏都挤在回复下面了" }]).attachments, screenshot.attachments);
  assert.throws(() => dotsFollowUpInput([directive, { ...screenshot, text: "只讨论，不要委派" }]), /没有授权/);
  assert.throws(() => dotsFollowUpInput([directive, { ...screenshot, text: "先停一下，我再看看" }]), /没有授权/);
  assert.throws(() => dotsFollowUpInput([directive, { ...screenshot, text: "请把另一个项目部署了" }]), /无法确认/);
  assert.throws(() => dotsFollowUpInput([directive, { ...screenshot, text: "截图里有个问题，顺便部署测试环境" }]), /无法确认/);
  assert.throws(() => dotsFollowUpInput([{ ...directive, text: "追问这个词怎么用" }]), /明确的追问原话/);
  assert.throws(() => dotsFollowUpInput([{ ...directive, text: "我上次说过「追问一下」" }]), /明确的追问原话/);
  const finishDirective = { ...directive, text: "把刚才的任务继续做完" };
  assert.equal(dotsFollowUpInput([finishDirective]).assignmentQuote, finishDirective.text);
  for (const instruction of ["把刚才的任务继续做完", "接着把原任务办完", "麻烦把刚才的任务接着完成"]) {
    assert(hasDotsResumeInstruction(instruction), instruction);
    assert(!hasDotsResumeInstruction("先看看进度。" + instruction, "先看看进度。"), instruction);
  }
  assert(!hasDotsResumeInstruction("把刚才的任务继续做完需要多久"));
  assert(!hasDotsResumeInstruction("不要把刚才的任务继续做完"));
  assert(!dotsForwardingDenied("请委派一个普通任务。不要重跑已通过的同版本检查。只在当前对话回传结果。"));
  assert(!dotsForwardingDenied("请委派一个普通任务，不要重试已经通过的回归测试，仅在本对话交付报告"));
  assert(hasDotsResumeInstruction("把刚才的任务继续做完。不要重跑已通过的同版本检查。"));
  for (const constraint of ["不要重跑原任务", "不要把原任务恢复", "不要重新执行原任务", "不要重跑已通过的测试，也不要委派",
    "不要重跑已通过的测试也别重跑原任务", "只在当前对话处理", "只在当前对话回传结果并处理",
    "只在当前对话交付文件。先停一下。"]) {
    assert(dotsForwardingDenied(constraint), constraint);
  }
  assert.throws(() => dotsFollowUpInput([{ ...directive, text: "继续看刚才的任务做到哪了" }]), /明确的追问原话/);
  assert.throws(() => dotsFollowUpInput([{ ...directive, text: "你追问下。也请跟进另一个任务。" },
    { ...screenshot, text: "你再追问下" }]), /明确的追问原话/);
  const space = await success({ action: "bind", name: "客户 A", path: folder }, 2);
  assert.equal(space.path, folder);
  assert.match(space.link, /mybuddy:\/\/space\//);
  assert.equal(db.listSpaces().filter(s => s.name === "客户 A").length, 1);
  const renamed = await success({ action: "rename", name: "华南", spaceId: space.id });
  assert.equal(renamed.id, space.id);
  assert.equal(renamed.path, folder);
  const originalRename = "dots-user-" + serial;
  await actions.execute(DOTS_TASK_ID, "new-name", { action: "rename", name: "East", spaceId: space.id });
  await actions.execute(DOTS_TASK_ID, originalRename, { action: "rename", name: "华南", spaceId: space.id });
  assert.equal(db.getSpace(space.id)?.name, "East", "replaying the earlier edit preserves the newer name");
  await actions.execute(DOTS_TASK_ID, "restore-name", { action: "rename", name: "华南", spaceId: space.id });
  const secondFolder = join(folder, "secondary");
  mkdirSync(secondFolder);
  await actions.execute(DOTS_TASK_ID, "bind-old", { action: "bind", path: folder, spaceId: space.id });
  await actions.execute(DOTS_TASK_ID, "bind-new", { action: "bind", path: secondFolder, spaceId: space.id });
  await actions.execute(DOTS_TASK_ID, "bind-old", { action: "bind", path: folder, spaceId: space.id });
  assert.equal(db.getSpace(space.id)?.path, secondFolder);
  await actions.execute(DOTS_TASK_ID, "restore-folder", { action: "bind", path: folder, spaceId: space.id });
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
  const rephrased = await actions.execute(DOTS_TASK_ID, "dots-user-" + serial,
    {action:"delegate", spaceId:space.id, name:"报价资料核对", text:"换种说法，再核对一遍客户资料"}, "用户交代 " + serial);
  assert("id" in rephrased && rephrased.id === job.id);
  assert.equal(journal.list().length, 1, "a reworded delegation from the same input reuses the original acceptance");
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
  const agreement = "先整理目录，再计算用量，按升序交付";
  const plannedWork = await turn({ action: "delegate", targetTaskId: task.id, text: "按约定准备统计", steps:["先整理目录","再计算用量"], deliveryInstruction:"按升序交付" }, undefined, 1, agreement);
  assert(!plannedWork.error, plannedWork.text);
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
  const resumedInput = JSON.stringify(fixture.requests.filter(req => req.tools.includes("read")).at(-1)?.input.messages.at(-1));
  assert.match(resumedInput, /先整理目录/);
  assert.match(resumedInput, /再计算用量/);
  assert.match(resumedInput, /按升序交付/);
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
  const scopeAPath = join(root, "timer-scope-a");
  const scopeBPath = join(root, "timer-scope-b");
  mkdirSync(scopeAPath);
  mkdirSync(scopeBPath);
  const scopeA = db.createSpace({id:"timer-scope-a",name:"甲区定时",path:scopeAPath});
  const scopeB = db.createSpace({id:"timer-scope-b",name:"乙区定时",path:scopeBPath});
  const timerTask = "task-owned-timer";
  db.upsertTask({id:timerTask,title:"甲区事项",spaceId:scopeA.id,updatedAt:Date.now()});
  const scheduleFor = async (name: string, owner: Record<string, string>): Promise<string> => {
    const result = await turn({...scheduled,name,...owner}, "automation_exec");
    assert(!result.error, result.text);
    return JSON.parse(result.text).id;
  };
  const owned = await scheduleFor("甲区事项", {owner_task_id:timerTask});
  const keptPaused = await scheduleFor("甲区手动暂停", {owner_task_id:timerTask});
  const otherScopeTimer = await scheduleFor("乙区持续运行", {owner_space_id:scopeB.id});
  await success({action:"pause",targetTaskId:timerTask});
  assert.equal(db.getCronJob(owned)?.enabled,false);
  assert.equal(db.getCronJob(otherScopeTimer)?.enabled,true);
  const manualPause = await turn({action:"pause",id:keptPaused},"automation_exec");
  assert(!manualPause.error,manualPause.text);
  await success({action:"pause_proactive",spaceId:scopeA.id});
  const resumedTimerTask = await success({action:"resume",targetTaskId:timerTask});
  await agent.waitForSubmission(resumedTimerTask.receipt);
  assert.equal(db.getCronJob(owned)?.enabled,false,"space pause survives task resume");
  await success({action:"resume_proactive",spaceId:scopeA.id});
  assert.equal(db.getCronJob(owned)?.enabled,true);
  assert.equal(db.getCronJob(keptPaused)?.enabled,false,"manual pause survives task and space resume");
  const manualResume = await turn({action:"resume",id:keptPaused},"automation_exec");
  assert(!manualResume.error,manualResume.text);
  assert.equal(db.getCronJob(keptPaused)?.enabled,true);
  await success({action:"pause_all",spaceId:scopeA.id});
  assert.equal(db.getCronJob(owned)?.enabled,false);
  const batchResumedTimerTask = await success({action:"resume",targetTaskId:timerTask});
  await agent.waitForSubmission(batchResumedTimerTask.receipt);
  assert.equal(db.getCronJob(owned)?.enabled,true,"an idle task's schedule paused by the space batch follows the task resume");
  await success({action:"stop_all",spaceId:scopeA.id},2);
  assert(db.getCronJob(owned)?.cancelledAt);
  assert(db.getCronJob(keptPaused)?.cancelledAt);
  assert.equal(db.getCronJob(otherScopeTimer)?.enabled,true);
  console.log("PASS task and space schedule controls preserve manual pauses and never cancel another space");
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
  const { dotsCalendarContext } = await import("../src/main/dots/DotsCalendar");
  assert.match(dotsCalendarContext("请核算上周的数量",new Date(2026,10,22,23,55).getTime())!, /2026-11-09 至 2026-11-15/);
  assert.match(dotsCalendarContext("sum last week",new Date(2027,0,4,0,1).getTime())!, /2026-12-28 至 2027-01-03/);
  const sourceText = "本周对账并整理下周预约";
  const sourceId = "separate-calendar-assignments";
  const receivedAt = new Date(2026,11,31,23,50).getTime();
  for (const assignmentQuote of ["本周对账","整理下周预约"]) {
    const result = await actions.execute(DOTS_TASK_ID, sourceId, {action:"delegate",spaceId:child.id,assignmentQuote,text:assignmentQuote},sourceText,undefined,receivedAt);
    assert("receipt" in result && result.receipt);
    await agent.waitForSubmission(result.receipt);
    const seen = JSON.stringify(fixture.requests.filter(req=>req.tools.includes("read")).at(-1)?.input.messages);
    assert.match(seen,assignmentQuote==="本周对账" ? /2026-12-28 至 2027-01-03/ : /2027-01-04 至 2027-01-10/);
  }
  assert.equal(new Set(journal.list([sourceId]).map(row=>row.taskId)).size,2);
  const splitSource = "mixed-assignment-anchors";
  const splitInput = "整理船期和统计空箱";
  const first = await actions.execute(DOTS_TASK_ID,splitSource,{action:"delegate",spaceId:child.id,text:"整理本季的航运时刻"},splitInput);
  assert("receipt" in first && first.receipt);
  await agent.waitForSubmission(first.receipt);
  const nextAssignment = {action:"delegate" as const,spaceId:child.id,assignmentQuote:"统计空箱",text:"列出闲置货柜数量"};
  await assert.rejects(actions.execute(DOTS_TASK_ID,splitSource,nextAssignment,splitInput), /previousAssignmentQuote/);
  const second = await actions.execute(DOTS_TASK_ID,splitSource,{...nextAssignment,previousAssignmentQuote:"整理船期"},splitInput);
  assert("receipt" in second && second.receipt);
  await agent.waitForSubmission(second.receipt);
  const replay = await actions.execute(DOTS_TASK_ID,splitSource,{...nextAssignment,text:"再换一种说法统计闲置箱"},splitInput);
  assert("receipt" in replay && replay.receipt);
  assert.notEqual(first.receipt.taskId, second.receipt.taskId);
  assert.equal(replay.receipt.submissionId, second.receipt.submissionId);
  const replayFirst = await actions.execute(DOTS_TASK_ID,splitSource,{...nextAssignment,assignmentQuote:"整理船期",text:"整理航次时间"},splitInput);
  assert("receipt" in replayFirst && replayFirst.receipt?.taskId === first.receipt.taskId);
  assert.equal(journal.list([splitSource]).length,2);
  const coveredA = "盘点空箱，只给「甲.txt」";
  const coveredB = "整理船期，交付「乙.txt」";
  const incompleteSplit = [coveredA, coveredB, "附上「丙.txt」", "用 project_verify 运行 test:split-summary"].join("。");
  const incompleteSplitSource = "split-with-unassigned-deliverables";
  const original = await actions.execute(DOTS_TASK_ID, incompleteSplitSource, {
    action: "delegate", spaceId: child.id, text: coveredA, deliveryInstruction: "只给「甲.txt」",
  }, incompleteSplit);
  assert("receipt" in original && original.receipt);
  const { taskId: partitionTask, operationId: partitionOperation } = original.receipt;
  assert.deepEqual(actions.completionRequirements(partitionTask, partitionOperation).files, ["甲.txt", "乙.txt", "丙.txt"]);
  assert.equal(actions.requestedFilename(partitionTask, partitionOperation), undefined);
  await assert.rejects(actions.execute(DOTS_TASK_ID, incompleteSplitSource, {
    action: "delegate", spaceId: child.id, text: coveredB, assignmentQuote: coveredB,
  }, incompleteSplit), /遗漏了原交办要求：丙\.txt、test:split-summary/);
  assert.equal(journal.list([incompleteSplitSource]).length, 1);
  assert.deepEqual(actions.completionRequirements(partitionTask, partitionOperation).files, ["甲.txt", "乙.txt", "丙.txt"]);
  const finished = await actions.execute(DOTS_TASK_ID,"before-pause",{action:"delegate",spaceId:child.id,text:"collect-finished-before-pause"});
  assert("receipt" in finished && finished.receipt);
  await agent.waitForSubmission(finished.receipt);
  await actions.execute(DOTS_TASK_ID,"hold-finished",{action:"pause",targetTaskId:finished.receipt.taskId});
  const beforeResume = fixture.requests.length;
  for (let replay = 0; replay < 2; replay++) {
    const result = await actions.execute(DOTS_TASK_ID,"release-finished",{action:"resume",targetTaskId:finished.receipt.taskId});
    assert("receipt" in result && result.receipt);
    assert.equal(result.receipt.operationId, finished.receipt.operationId);
  }
  assert.equal(fixture.requests.length, beforeResume, "resuming a finished native turn keeps its result without a second worker call");

  journal.refresh(finished.receipt.taskId);
  await until(() => journal.list(["before-pause"]).some(item => item.status === "completed"), "original task completes");
  const followCommand = { action: "follow_up", targetTaskId: finished.receipt.taskId, operationId: finished.receipt.operationId } as const;
  const deniedFollow = await turn(followCommand, "dots_action", 1, "你追问下。先停一下，不要委派。");
  assert.match(deniedFollow.text, /没有授权/);
  assert.equal(journal.list(["dots-user-" + serial]).length, 0);
  const followed = await turn({ ...followCommand, text: "untrusted-worker-instruction-31" }, "dots_action", 2, directive.text);
  assert(!followed.error, followed.text);
  const followedSource = "dots-user-" + serial;
  const followReceipt = JSON.parse(followed.text).receipt;
  assert.equal(followReceipt.taskId, finished.receipt.taskId);
  assert.notEqual(followReceipt.operationId, finished.receipt.operationId);
  assert.equal((await agent.waitForSubmission(followReceipt)).receipt?.status, "done");
  assert.equal(journal.list([followedSource]).length, 1);
  const followWorkerPrompt = fixture.requests.filter(request => request.tools.includes("read"))
    .map(request => JSON.stringify(request.input.messages.at(-1)) ?? "").find(text => text.includes(directive.text));
  assert(followWorkerPrompt, "worker receives the real follow-up request");
  assert.doesNotMatch(followWorkerPrompt, /untrusted-worker-instruction-31/);
  console.log("PASS Dots original-task follow-up preserves input attribution, replays once, and honors a later stop");

  await agent.releaseDurableTask(second.receipt.taskId);
  db.deleteTask(second.receipt.taskId);
  await assert.rejects(actions.execute(DOTS_TASK_ID,splitSource,nextAssignment,splitInput), /原任务已删除/);
  assert.equal(db.getTask(second.receipt.taskId), undefined);
  await agent.updateAppSettings({dotsSettings: {modelId:"fixture/dots-front"}});
  const pinnedTask = "ordinary-independent-model";
  db.upsertTask({ id:pinnedTask, title:"独立已有任务", spaceId:child.id, modelId:"fixture/pinned-worker", welcomeMode:"general", updatedAt:Date.now() });
  const modelStart = fixture.requests.length;
  const modelDelegation = await success({ action:"delegate", spaceId:child.id, text:"检查独立模型路由",
    requiredCapabilities: [{ kind:"tool", id:"read" }] });
  await agent.waitForSubmission(modelDelegation.receipt);
  const existingModelDelegation = await success({ action:"delegate", targetTaskId:pinnedTask, text:"沿用该任务已有模型和通用场景",
    requiredCapabilities: [{ kind:"mode", id:"general" }, { kind:"tool", id:"read" }] });
  await agent.waitForSubmission(existingModelDelegation.receipt);
  const modeled = fixture.requests.slice(modelStart);
  assert.deepEqual([...new Set(modeled.filter(req => req.tools.includes("dots_action")).map(req => req.modelId))], ["fixture/dots-front"]);
  assert.deepEqual([...new Set(modeled.filter(req => req.tools.includes("read")).map(req => req.modelId))].sort(),
    ["fixture/model","fixture/pinned-worker"]);
  assert.equal(agent.getAppSettings().defaultModelId,"fixture/model");
  assert.equal(db.getTask(pinnedTask)?.modelId,"fixture/pinned-worker");
  assert.equal(db.getTask(pinnedTask)?.welcomeMode,"general");
  assert.equal(db.getTask(DOTS_TASK_ID)?.modelId ?? null,null);

  const capabilityStart = fixture.requests.length;
  const beforeCapability = db.listNonTrashedTasks().map(task => task.id).sort();
  for (const [kind, id, error] of [
    ["mode", "coding", /所需场景「coding」/],
    ["connector", "fixture-absent", /所需连接器「fixture-absent」/],
    ["mcp", "unapproved-server", /所需MCP「unapproved-server」/],
  ] as const) {
    const unavailable = await turn({ action: "delegate", spaceId: child.id, text: "请执行需要该配置的工作",
      requiredCapabilities: [{ kind, id }] }, "dots_action", 1, "请执行需要 " + id + " 的工作");
    assert(unavailable.error, unavailable.text);
    assert.match(unavailable.text, error);
    assert.equal(journal.list(["dots-user-" + serial]).length, 0);
  }
  assert.deepEqual(db.listNonTrashedTasks().map(task => task.id).sort(), beforeCapability);
  const toolProbeTask = "ordinary-unregistered-tool-check";
  db.upsertTask({ id: toolProbeTask, title: "检测未登记工具", spaceId: child.id, modelId: "fixture/pinned-worker", updatedAt: Date.now() });
  const missingRegistration = await turn({ action: "delegate", targetTaskId: toolProbeTask, text: "使用指定工具",
    requiredCapabilities: [{ kind: "tool", id: "fixture_unregistered_tool" }] }, "dots_action", 1, "使用 fixture_unregistered_tool");
  assert(missingRegistration.error, missingRegistration.text);
  assert.match(missingRegistration.text, /所需工具「fixture_unregistered_tool」/);
  assert(!fixture.requests.slice(capabilityStart).some(req => req.tools.includes("read")), "impossible requirements never reach the worker model");

  const mcpAudit = join(root, "required-mcp.jsonl");
  const idleAudit = join(root, "unrequested-mcp.jsonl");
  const mcpFixture = join(process.cwd(), "scripts", "durable-mcp-lazy-fixture.mjs");
  writeFileSync(join(root, ".mybuddy", "plugins", "mcp", "mcp.json"), JSON.stringify({ mcpServers: {
    "required-fixture": { command: process.execPath, args: [mcpFixture, mcpAudit], toolExposure: { hidden_tool: "hidden" } },
    "idle-fixture": { command: process.execPath, args: [mcpFixture, idleAudit] },
  } }));
  const generalPolicy = agent.getModeProfile("general").policy;
  agent.saveModePolicy("general", { ...generalPolicy, mcpPolicy: { mode: "hard", allow: ["required-fixture", "idle-fixture"], deny: [] } });
  const beforeProbe = fixture.requests.length;
  const candidateRequirements = [{ kind: "mode", id: "general" }, { kind: "mcp", id: "required-fixture", tool: "read_cwd" }] as const;
  const candidate = await success({ action: "task", targetTaskId: pinnedTask, spaceId: child.id,
    requiredCapabilities: [...candidateRequirements] });
  assert.equal(candidate.id, pinnedTask);
  assert.deepEqual(candidate.capabilityEligibility, { status: "policy_approved", requirements: candidateRequirements });
  assert.equal(candidate.messages, undefined, "candidate lookup does not read the worker transcript");
  const missingCapability = { kind: "mode", id: "coding" } as const;
  const unsuitable = await success({ action: "task", targetTaskId: pinnedTask, requiredCapabilities: [missingCapability] });
  assert.equal(unsuitable.capabilityEligibility.status, "blocked");
  assert.deepEqual(unsuitable.capabilityEligibility.requirement, missingCapability);
  assert.match(unsuitable.capabilityEligibility.reason, /所需场景「coding」/);
  const outOfScope = await turn({ action: "task", targetTaskId: pinnedTask, spaceId: "another-space",
    requiredCapabilities: [...candidateRequirements] });
  assert(outOfScope.error, outOfScope.text);
  assert.match(outOfScope.text, /属于另一个空间/);
  assert(!existsSync(mcpAudit), "candidate lookup leaves even its named server unconnected");
  assert(!fixture.requests.slice(beforeProbe).some(req => req.tools.includes("read")));
  const mcpResult = await success({ action: "delegate", targetTaskId: pinnedTask, text: "使用已批准的 MCP 工具",
    requiredCapabilities: [{ kind: "mcp", id: "required-fixture" }, { kind: "mcp", id: "required-fixture", tool: "read_cwd" }] });
  await agent.waitForSubmission(mcpResult.receipt);
  const beforeHiddenMcp = fixture.requests.length;
  const hiddenMcp = await turn({ action: "delegate", targetTaskId: pinnedTask, text: "调用隐藏的 MCP 工具",
    requiredCapabilities: [{ kind: "mcp", id: "required-fixture", tool: "hidden_tool" }] }, "dots_action", 1, "请调用 hidden_tool");
  assert(hiddenMcp.error, hiddenMcp.text);
  assert.match(hiddenMcp.text, /required-fixture \/ hidden_tool/);
  assert(!fixture.requests.slice(beforeHiddenMcp).some(req => req.tools.includes("read")));
  assert.deepEqual(readFileSync(mcpAudit, "utf8").trim().split("\n").map(line => JSON.parse(line).event), ["start"],
    "preflight opens the named server to read its catalog without calling any business tools");
  assert(!existsSync(idleAudit), "preflight leaves an unrequested approved server idle");
  console.log("PASS Dots required capabilities check approved mode, actual registered tools and scoped MCP discovery before worker submission");

  // Keep Dots available while the user's configured main model is outside the enabled scope.
  await agent.updateAppSettings({defaultModelId:"fixture/unavailable",enabledModels:["fixture/model","fixture/dots-front","fixture/pinned-worker"]});
  const before = fixture.requests.length;
  const tasksBefore = db.listNonTrashedTasks().map(task => task.id).sort();
  const denied = await turn({action:"delegate",spaceId:child.id,name:"入库核算",text:"请核算数量"},undefined,1,"请核算这批入库数量");
  assert(denied.error && denied.text.includes("fixture/unavailable"),denied.text);
  assert(!fixture.requests.slice(before).some(req=>req.tools.includes("read")),"a disabled main model must not send any worker request");
  // 可预期的前置失败在建任务之前挡住：不建空壳任务、不落委派；重试同样由同一原因拒绝，而不是留下 pending。
  assert.deepEqual(db.listNonTrashedTasks().map(task => task.id).sort(),tasksBefore);
  assert.equal(journal.list(["dots-user-"+serial]).length,0);
  await assert.rejects(actions.execute(DOTS_TASK_ID,"dots-user-"+serial,{action:"delegate",spaceId:child.id,name:"再次核算",text:"再试一遍"}),
    /fixture\/unavailable/);
  assert.deepEqual(db.listNonTrashedTasks().map(task => task.id).sort(),tasksBefore);
  await agent.updateAppSettings({defaultModelId:"fixture/model",dotsSettings:{modelId:"fixture/unavailable"}});
  const beforeInvalid = fixture.requests.length;
  await assert.rejects(agent.prompt({taskId:DOTS_TASK_ID,userMessageId:"invalid-dots-model",
    assistantMessageId:"invalid-dots-reply",text:"检查模型",modelId:"fixture/model"}), /Dots 模型 fixture\/unavailable 不可用/);
  assert.equal(fixture.requests.length,beforeInvalid);
  await agent.updateAppSettings({dotsSettings:{modelId:null}});
  const beforeFollow = fixture.requests.length;
  await success({action:"spaces"});
  assert.deepEqual([...new Set(fixture.requests.slice(beforeFollow).filter(req=>req.tools.includes("dots_action")).map(req=>req.modelId))],["fixture/model"]);
  assert.equal(agent.getAppSettings().dotsSettings?.modelId,null);
  const readingSample = agent.createKernelMemory({ kind: "fact", title: "锆蓝货柜习惯",
    content: "同批锆蓝纸箱需要贴上日期标签。", scopeType: "task", scopeId: DOTS_TASK_ID, sourceType: "manual" });
  await agent.updateAppSettings({ dotsSettings: { memoryLimits: resolveDotsMemoryLimits({ searchPreviewChars: 4 }) } });
  await agent.updateAppSettings({ dotsSettings: { modelId: null } });
  assert.equal(agent.getAppSettings().dotsSettings?.memoryLimits?.searchPreviewChars, 4);
  const limited = await turn({ query: "锆蓝货柜习惯" }, "memory_search");
  assert(!limited.error, limited.text);
  assert.equal(JSON.parse(limited.text).matches.find((match: { id: string }) => match.id === readingSample.id)?.excerpt, "同批锆蓝");

  shellProbe = { id: "interrupt-shell", command: "echo running > stop-probe.txt; while true; do sleep 1; done", timeout: 20 };
  const interrupted = await success({ action: "delegate", spaceId: space.id, text: "运行一条可取消的诊断命令" });
  await until(() => existsSync(join(folder, "stop-probe.txt")), "native Bash started before cancelling");
  assert.equal(await agent.abort(interrupted.id), "idle");
  const interruptedResult = await agent.waitForSubmission(interrupted.receipt);
  assert.equal(interruptedResult.cancelled, true);
  const recorded = agent.getTaskFailuresForDiagnosis(interrupted.id).find(failure => failure.causeCode === "durable-tool-interrupted");
  assert(recorded, "the platform records the interrupted native tool");
  const { ExecutionFailureRepository } = await import("../src/main/agent/ExecutionFailureRepository");
  assert(new ExecutionFailureRepository(db.connection).dismiss(interrupted.id, recorded.id));
  const diagnostic = await success({ action: "task", targetTaskId: interrupted.id });
  assert.equal(diagnostic.running, false);
  assert.equal(diagnostic.executionDiagnostics.tools[0].name, "bash");
  assert.match(diagnostic.executionDiagnostics.tools[0].diagnostics.join(" "), /Tool bash was aborted/);
  assert.equal(diagnostic.executionDiagnostics.failures[0].id, recorded.id);
  assert.equal(diagnostic.executionDiagnostics.failures[0].sideEffects, "unknown");
  assert.equal(typeof diagnostic.executionDiagnostics.failures[0].dismissedAt, "number");
  for (const action of ["resume", "delegate"] as const) {
    const deniedResume = await turn({ action, targetTaskId: interrupted.id, text: "重跑原任务查日志" }, "dots_action", 1, "实际任务已经完成，但是不知道为什么死锁了。");
    assert(deniedResume.error, deniedResume.text);
    assert.match(deniedResume.text, /请使用 task 读取原任务的执行诊断/);
  }
  for (const text of ["请继续查看为什么停不下来。", "继续看刚才的任务做到哪了", "把刚才的任务继续做完吗？", "别继续原任务", "把刚才的两个任务继续做完"]) {
    const inspectAgain = await turn({ action: "resume", targetTaskId: interrupted.id }, "dots_action", 1, text);
    assert(inspectAgain.error, inspectAgain.text);
  }
  assert.deepEqual((await success({ action: "task", targetTaskId: interrupted.id })).deliveries.map((row: { operationId: string }) => row.operationId),
    [interrupted.receipt.operationId]);
  const naturalResume = await turn({ action: "resume", targetTaskId: interrupted.id }, "dots_action", 1, "把刚才的任务继续做完");
  assert(!naturalResume.error, naturalResume.text);
  const authorized = JSON.parse(naturalResume.text);
  assert.equal(authorized.id, interrupted.id);
  assert.notEqual(authorized.receipt.operationId, interrupted.receipt.operationId);
  assert.equal((await agent.waitForSubmission(authorized.receipt)).receipt?.status, "done");
  console.log("PASS 查任务读到已隐藏的真实 Bash 中断记录，诊断不会恢复原任务，明确继续才产生第二条回执");

  const scheduleTimeout = globalThis.setTimeout;
  try {
    // Shorten the silence window while using the actual Bash process and its native cleanup.
    globalThis.setTimeout = ((callback, ms, ...args) =>
      scheduleTimeout(callback, ms === 120_000 ? 350 : ms, ...args)) as typeof setTimeout;
    shellProbe = { id: "unattended-shell", command: "while true; do sleep 1; done" };
    const timed = await success({ action: "delegate", spaceId: space.id, text: "等待隔离的命令超时" });
    assert.equal((await agent.waitForSubmission(timed.receipt)).receipt?.status, "done");
    assert.match(outputs.get("unattended-shell")?.text ?? "", /Bash produced no stdout or stderr for 120 seconds/);
    assert.equal(agent.getTaskFailuresForDiagnosis(timed.id)[0]?.sideEffects, "unknown");
  } finally {
    globalThis.setTimeout = scheduleTimeout;
  }
  console.log("PASS Dots 后台 Bash 无输出时失败，外部操作结果仍标记为待核对");
  console.log("PASS Dots 专属模型与主模型、已有任务模型隔离，失效明确报错，取消选择恢复跟随主模型");
  console.log("PASS disabled main model reported with zero worker requests, paraphrase replay and separate dated assignments");
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
