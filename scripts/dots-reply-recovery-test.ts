import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { DOTS_NO_CHANGE, DOTS_TASK_ID } from "../src/shared/dots";
import { DotsReplyOutbox } from "../src/main/dots/DotsReplyOutbox";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy } from "../src/shared/answer-routing";
import { DotsDelegations } from "../src/main/dots/DotsDelegations";
import { DotsActivity } from "../src/main/dots/DotsActivity";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
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
const legacySource = "legacy-inventory-delivered";
const rerunSource = "legacy-inventory-rerun";
const rerunAnswer = "复核完成，库存为 37 件。";
const externalSource = "external-effect-recovery";
const effectToolCall = "post-unconfirmed-effect";
const unconfirmed = "外部操作未收到回执，是否生效需要核查。";
const recoveryFaults = ["readThen503", "writeThen503", "effectThen503", "effectProgress", "localFiles", "localPreexisting"] as const;
type RecoveryFault = typeof recoveryFaults[number];
const recoveryProof = "recovery-proof.txt";
const recoveryDraft = "recovery-internal-notes.txt";
const recoveryInstructions: Record<RecoveryFault, string> = {
  readThen503: "读取 recovery-input.txt 的盘点数量，只回复数字。",
  writeThen503: "请创建 recovery-proof.txt，只交付这个文件。",
  effectThen503: "运行盘点登记命令并确认结果。",
  effectProgress: "运行盘点登记命令并确认结果。",
  localFiles: "制作本地盘点成果。交付 localFiles-kept.txt 和 localFiles-missing.txt。",
  localPreexisting: "制作本地盘点成果。交付 localPreexisting-kept.txt 和 localPreexisting-missing.txt。",
};
type WorkspaceCase = "bound" | "private" | "inherited" | "rebound";
const dependencyAssignment = "先准备上游数据。\n再用上游结果完成集成。";

async function open(fault?: "before" | "after" | "waitForStop" | "unchanged" | "foregroundError" | "cancelInFlight" | "policyProgress" | "activityOnly" | "externalEffect" | "missingInitialDirectory" | "pendingInitialDirectory" | "rerunLegacy" | "stopAfterCommit" | "dependency" | "dependencyDeadline" | RecoveryFault, effectPort?: number,
  workspace: WorkspaceCase = "bound") {
  const db = new AppDatabase(join(root, "app.db"));
  const artifacts = createArtifactDomain(db.connection);
  db.openDots();
  const stock = db.getSpace("sp-stock") ?? db.createSpace({id:"sp-stock",name:"库存",path:root});
  const space = workspace === "bound" ? stock : db.getSpace("sp-stock-" + workspace) ?? db.createSpace({
    id:"sp-stock-" + workspace, name:"库存 " + workspace, parentId:workspace === "inherited" ? stock.id : undefined,
  });
  let enteredTimer = false;
  let reportedProgress = false;
  let dependencyDispatches = 0;
  let blockedRecoveryWrite = false;
  let releaseTimer!: () => void;
  const timerGate = new Promise<void>(resolve => { releaseTimer = resolve; });
  if (fault === "activityOnly") writeFileSync(join(root, "signal.txt"), "fixture signal 42");
  if (fault === "readThen503") writeFileSync(join(root, "recovery-input.txt"), "42");
  if (fault === "localPreexisting") writeFileSync(join(root, fault + "-missing.txt"), "之前留下的其他文件");
  const fixture = await createAgentDurableFixture(root, db, async (input, signal) => {
    const tools = getCurrentTools(input.messages);
    const latest = input.messages.at(-1);
    if (fault === "localFiles" || fault === "localPreexisting") {
      const names = tools.map(tool => tool.name);
      if (!names.length) return [{ type: "text", text: '{"candidates":[]}' }];
      const kept = fault + "-kept.txt", missing = fault + "-missing.txt";
      const userText = input.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
      const previous = latest?.role === "toolResult" ? latest : undefined;
      const write = (id: string, path: string, content: string) => ({ type: "toolCall" as const, id, name: "write", arguments: { path, content } });
      const register = (id: string, path: string) => ({ type: "toolCall" as const, id, name: "register_artifact", arguments: { path } });
      const complete = [{ type: "text" as const, text: JSON.stringify({ dotsState: "complete", result: "盘点成果已生成。" }) }];
      if (names.includes("dots_action")) {
        if (previous) return [{ type: "text", text: "收到。" }];
        return [{ type: "toolCall", id: "delegate-" + fault, name: "dots_action", arguments: {
          action: "delegate", spaceId: space.id, name: "补齐盘点文件", assignmentQuote: recoveryInstructions[fault], text: recoveryInstructions[fault],
        } }];
      }
      if (userText.includes("只创建并登记下列缺少的交付文件")) {
        assert(names.includes("write"));
        assert(!names.some(name => ["edit", "powershell", "bash", "codemode", "register_artifact"].includes(name)));
        if (previous?.toolCallId === "recovery-overwrite-kept") {
          assert.equal(previous.isError, true);
          return [register("recovery-spoof-missing", missing)];
        }
        if (previous?.toolCallId === "recovery-spoof-missing") {
          assert.equal(previous.isError, true);
          return [write("recovery-create-missing", missing, "本次补齐的盘点成果")];
        }
        if (previous?.toolCallId === "recovery-create-missing") {
          assert.equal(previous.isError, fault === "localPreexisting", JSON.stringify(previous.content));
          return fault === "localFiles" ? complete : [{ type: "text", text: JSON.stringify({
            dotsState: "blocked", result: "指定文件已经被其他人占用，无法创建本轮成果。", question: "要用哪个文件名？",
          }) }];
        }
        return [write("recovery-overwrite-kept", kept, "不得替换已有盘点成果")];
      }
      if (previous?.toolCallId === "initial-kept-write") return [register("initial-kept-register", kept)];
      if (previous?.toolCallId === "initial-kept-register") return complete;
      return [write("initial-kept-write", kept, "第一份已核实的盘点成果")];
    }
    if (fault === "readThen503" || fault === "writeThen503" || fault === "effectThen503" || fault === "effectProgress") {
      const names = tools.map(tool => tool.name);
      if (!names.length) return [{ type: "text", text: '{"candidates":[]}' }];
      const userText = input.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
      const previous = latest?.role === "toolResult" ? latest : undefined;
      if (names.includes("dots_action")) {
        if (previous) return [{ type: "text", text: "收到。" }];
        return [{ type: "toolCall", id: "delegate-" + fault, name: "dots_action", arguments: {
          action: "delegate", spaceId: space.id, name: "盘点恢复", assignmentQuote: recoveryInstructions[fault],
          text: recoveryInstructions[fault],
          ...(fault === "writeThen503" ? { deliveryInstruction: "只交付这个文件。" } : {}),
        } }];
      }
      if (userText.includes("当前回合只允许撰写报告")) {
        assert.equal(fault, "writeThen503");
        assert.deepEqual(names, ["dots_task_end"], "only terminal reporting is offered to the recovery provider");
        if (previous?.toolCallId === "forbidden-recovery-write") {
          assert.equal(previous.isError, true);
          blockedRecoveryWrite = true;
          return [{ type: "toolCall", id: "forbidden-recovery-wait", name: "dots_task_end", arguments: {
            action: "wait", dependencyOperationId: "forbidden-report-dependency", progress: "尝试安排额外工作。",
          } }];
        }
        if (previous?.toolCallId === "forbidden-recovery-wait") {
          assert.equal(previous.isError, true);
          assert.match(JSON.stringify(previous.content), /只根据已有结果补报/);
          return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "已保存并登记原文件。", delivery: { text: "" } }) }];
        }
        return [{ type: "toolCall", id: "forbidden-recovery-write", name: "write", arguments: {
          path: recoveryProof, content: "这条被拒绝的工具调用不得改写原成果。",
        } }];
      }
      if (userText.includes("从短暂故障处继续")) {
        assert.equal(fault, "readThen503");
        assert(names.includes("read"), "the resumed read-only task can still complete business steps");
        assert(input.messages.some(message => message.role === "toolResult" && message.toolCallId === "recovery-read" &&
          JSON.stringify(message.content).includes("42")), "the read result remains available to the original task");
        return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "原始盘点数量为 42。", delivery: { text: "42" } }) }];
      }
      if (previous) {
        assert.equal(previous.isError, false, JSON.stringify(previous.content));
        if (previous.toolCallId === "recovery-scratch") return [{ type: "toolCall", id: "recovery-write", name: "write",
          arguments: { path: recoveryProof, content: "原盘点成果 42。" } }];
        if (previous.toolCallId === "recovery-write") return [{ type: "toolCall", id: "recovery-register", name: "register_artifact",
          arguments: { path: recoveryProof } }];
        if (fault === "effectProgress") return [{ type: "text", text: JSON.stringify({
          dotsState: "progress", result: "登记命令已经返回。", remainingQuote: "确认结果",
        }) }];
        return { content: [], errorMessage: "503: temporarily unavailable" };
      }
      if (fault === "readThen503") return [{ type: "toolCall", id: "recovery-read", name: "read", arguments: { path: "recovery-input.txt" } }];
      if (fault === "writeThen503") return [{ type: "toolCall", id: "recovery-scratch", name: "write",
        arguments: { path: recoveryDraft, content: "内部记录只保留在原工作区。" } }];
      const code = 'require("node:fs").appendFileSync("' + fault + '.txt", "accepted\\n")';
      const windows = process.platform === "win32";
      const quote = (value: string) => "'" + value.replaceAll("'", windows ? "''" : "'\"'\"'") + "'";
      return [{ type: "toolCall", id: "recovery-unverified-effect", name: windows ? "powershell" : "bash",
        arguments: { command: (windows ? "& " : "") + quote(process.execPath) + " -e " + quote(code) } }];
    }
    if (fault === "dependency" || fault === "dependencyDeadline") {
      const userText = input.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
      if (tools.some(tool => tool.name === "dots_action")) {
        const upstreamCall = "dependency-upstream-" + fault;
        if (dependencyDispatches === 0) {
          dependencyDispatches++;
          return [{ type: "toolCall", id: upstreamCall, name: "dots_action", arguments: {
            action: "delegate", spaceId: space.id, name: "上游依赖", assignmentQuote: "先准备上游数据。", text: "上游任务等待门限",
          } }];
        }
        const admission = input.messages.find(message => message.role === "toolResult" && message.toolCallId === upstreamCall);
        if (dependencyDispatches === 1 && admission?.role === "toolResult") {
          dependencyDispatches++;
          const result = JSON.parse(admission.content.map(block => block.type === "text" ? block.text : "").join(""));
          assert.equal(result.operationId, result.receipt.operationId);
          return [{ type: "toolCall", id: "dependency-downstream-" + fault, name: "dots_action", arguments: {
            action: "delegate", spaceId: space.id, name: "依赖集成", assignmentQuote: "再用上游结果完成集成。",
            text: "集成测试等待操作 " + result.operationId,
          } }];
        }
      } else if (tools.some(tool => tool.name === "read") && userText?.includes("上游任务等待门限")) {
        enteredTimer = true;
        await Promise.race([timerGate, new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }))]);
        return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "上游结果 47" }) }];
      } else if (tools.some(tool => tool.name === "read") && userText?.includes("集成测试等待操作")) {
        workerCalls++;
        const operationId = /集成测试等待操作 (dots-input-[a-f0-9]+)/.exec(userText)?.[1];
        assert(operationId);
        assert(tools.some(tool => tool.name === "dots_task_end"));
        if (fault === "dependencyDeadline") {
          const waiting = journal.list([fault]).find(job => job.title === "依赖集成");
          assert(waiting);
          const { deadlineAt } = actions.validateWorkerDependency(waiting.taskId, waiting.id, operationId);
          db.connection.prepare("UPDATE dots_delegations SET created_at=created_at+? WHERE operation_id=?")
            .run(Date.now() + 3500 - deadlineAt, waiting.id);
        }
        return [{ type: "toolCall", id: "park-dependency", name: "dots_task_end", arguments: {
          action: "wait", dependencyOperationId: operationId, progress: "已完成独立的集成准备。",
        } }];
      }
    }
    if (fault === "activityOnly" && !tools.some(t => t.name === "dots_action") && tools.some(t => t.name === "read")) {
      if (latest?.role === "toolResult" && latest.toolCallId === "activity-read") {
        enteredTimer = true;
        await timerGate;
        return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: "42" }) }];
      }
      return [{ type: "toolCall", id: "activity-read", name: "read", arguments: { path: "signal.txt" } }];
    }
    if (fault === "externalEffect" && !tools.some(t => t.name === "dots_action") && tools.some(t => t.name === "write")) {
      if (latest?.role === "toolResult" && latest.toolCallId === effectToolCall) {
        assert.equal(latest.isError, true, "the interrupted tool did not receive a successful result");
        return [{type:"text", text:JSON.stringify({dotsState:"complete",result:unconfirmed})}];
      }
      assert(effectPort);
      const [job] = journal.list([externalSource]);
      assert(job);
      const native = await agent.findSubmission(job.taskId, job.id);
      assert(native?.receipt);
      writeFileSync(join(root,"external-effect-cut.json"), JSON.stringify({
        taskId:job.taskId, operationId:job.id, submissionId:native.receipt.submissionId,
      }));
      const code = 'fetch("http://127.0.0.1:' + effectPort +
        '/fixture-effect", {method:"POST",body:"fixture"}).catch(() => {process.exitCode=1})';
      const windows = process.platform === "win32";
      const quote = (value: string) => "'" + value.replaceAll("'", windows ? "''" : "'\"'\"'") + "'";
      const command = (windows ? "& " : "") + quote(process.execPath) + " -e " + quote(code);
      return [{type:"toolCall",id:effectToolCall,name:windows ? "powershell" : "bash",arguments:{command}}];
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
      if (fault === "rerunLegacy") {
        const [original] = journal.list([legacySource]);
        assert(original);
        return [{ type: "toolCall", id: "rerun-inventory", name: "dots_action", arguments: {
          action: "delegate", targetTaskId: original.taskId, spaceId: space.id,
          assignmentQuote: "重跑原盘点任务", previousAssignmentQuote: "盘点库存", text: "重跑原盘点任务",
        } }];
      }
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
      if (fault === "rerunLegacy") {
        await timerGate;
        return [{ type: "text", text: JSON.stringify({ dotsState: "complete", result: rerunAnswer }) }];
      }
      if (fault === "policyProgress" && !reportedProgress) {
        reportedProgress = true;
        return [{type:"text",text:JSON.stringify({dotsState:"progress",result:"盘点已做完，数字待交付。",remainingQuote:"回复数字"})}];
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
    link:(...args) => {
      journal.link(...args);
      if (fault === "pendingInitialDirectory") {
        db.connection.prepare("UPDATE dots_delegations SET cwd=NULL WHERE operation_id=?").run(args[1]);
        db.connection.prepare("UPDATE tasks SET cwd=NULL WHERE id=?").run(args[0]);
      }
    },
    rememberOrigin:(...args) => journal.rememberOrigin(...args),
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
  journal.connect((job, request) => {
    if (fault === "missingInitialDirectory" && job.status === "completed" && job.sourceMessageId === "old-" + workspace + "-inventory") {
      db.connection.prepare("UPDATE dots_delegations SET cwd=NULL WHERE operation_id=?").run(job.id);
      if (workspace === "rebound") db.connection.prepare("UPDATE spaces SET path=? WHERE id=?").run(root, space.id);
    }
    return actions.followup(job, request);
  }, async (reply, valid) => {
    if (fault === "before") {
      if ((await agent.findSubmission(DOTS_TASK_ID, reply.sourceMessageId))?.receipt?.status !== "done") return { status: "pending" };
      await interrupt(reply.sourceMessageId);
    }
    if (fault === "waitForStop") { faultReached = true; stoppedTarget=reply.taskId; return { status: "pending" }; }
    const result = await agent.appendDotsReply(reply, valid);
    if (fault === "after" && result.status === "appended") await interrupt(reply.sourceMessageId);
    return result;
  }, taskId => actions.allowsResult(taskId), kind => actions.allowsReply(kind));
  if (fault === "stopAfterCommit") {
    const [committed] = journal.list(["inventory-after"]);
    assert(committed);
    await actions.execute(DOTS_TASK_ID, "stop-after-committed-delivery", { action: "stop", targetTaskId: committed.taskId });
  }
  const off = agent.onPatch(patch => {
    if (patch.type === "durable_delta" && !patch.delta.state.busy) journal.refresh(patch.taskId);
  });
  await agent.resumePersistedTasks();
  await journal.recover(async req => { replayAdmissions++; return agent.prompt(req); }, () => true,
    undefined, undefined, (id, cwd) => agent.matchesDotsInitialPrivateWorkspace(id, cwd));
  return {fixture, db, agent, journal, cron, actions, timerNotices, fileNotices, progressNotices, reached:() => faultReached,
    blockedRecoveryWrite: () => blockedRecoveryWrite, enteredTimer:()=>enteredTimer, releaseTimer, async close() {
    releaseTimer();
    cron.stop(); terminal.dispose(); off(); journal.close(); await journal.drain(); await actions.closeFileWatches(); await fixture.close(); db.close();
  }};
}

if (faultHost) {
  assert(faultHost === "before" || faultHost === "after" || faultHost === "externalEffect");
  const source = faultHost === "externalEffect" ? externalSource : "inventory-" + faultHost;
  const host = await open(faultHost, Number(process.argv[4]));
  try {
    await host.fixture.prompt({taskId: DOTS_TASK_ID, userMessageId:source, assistantMessageId:source+"-ack", text:"盘点库存，直接回复数字。"});
    const deadline = Date.now()+25000;
    while (Date.now()<deadline) { host.journal.refresh(); await host.journal.drain(); await sleep(); }
    assert.fail("did not reach handoff boundary: "+JSON.stringify(host.journal.list()));
  } finally { await host.close(); }
}
for (const fault of recoveryFaults) {
  const host = await open(fault);
  try {
    await host.fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: fault, assistantMessageId: fault + "-ack", text: recoveryInstructions[fault] });
    const delivered = async () => (await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages.filter(message =>
      message.dotsDelivery?.sourceMessageId === fault && message.dotsDelivery.kind !== "progress");
    for (let i = 0; i < 340 && !(await delivered()).length; i++) {
      host.journal.refresh();
      await host.journal.drain();
      await sleep();
    }
    const replies = await delivered();
    const jobs = host.journal.list([fault]);
    assert.equal(replies.length, 1, JSON.stringify({ jobs, replies }));
    assert.equal(new Set(jobs.map(job => job.taskId)).size, 1);
    if (fault === "effectThen503" || fault === "effectProgress") {
      assert.equal(jobs.length, 1);
      assert.equal(readFileSync(join(root, fault + ".txt"), "utf8"), "accepted\n");
      assert.match(replies[0]!.text, /请先核对原操作是否已生效/);
    } else if (fault === "localFiles" || fault === "localPreexisting") {
      assert.equal(jobs.length, 2, JSON.stringify({ jobs, replies }));
      const kept = fault + "-kept.txt", missing = fault + "-missing.txt";
      assert.equal(readFileSync(join(root, kept), "utf8"), "第一份已核实的盘点成果");
      if (fault === "localFiles") {
        assert.equal(replies[0]!.dotsDelivery!.kind, "conclusion");
        assert.deepEqual(replies[0]!.dotsDelivery!.artifacts.map(artifact => artifact.name).sort(), [kept, missing]);
        assert.equal(readFileSync(join(root, missing), "utf8"), "本次补齐的盘点成果");
      } else {
        assert.equal(replies[0]!.dotsDelivery!.kind, "question");
        assert.deepEqual(replies[0]!.dotsDelivery!.artifacts.map(artifact => artifact.name), [kept]);
        assert.equal(readFileSync(join(root, missing), "utf8"), "之前留下的其他文件");
      }
    } else {
      assert.equal(jobs.length, 2, JSON.stringify({ jobs, replies }));
      assert.equal(replies[0]!.dotsDelivery!.kind, "conclusion");
      if (fault === "readThen503") assert.equal(replies[0]!.text, "42");
      else {
        assert(host.blockedRecoveryWrite());
        assert.equal(readFileSync(join(root, recoveryProof), "utf8"), "原盘点成果 42。");
        assert.equal(readFileSync(join(root, recoveryDraft), "utf8"), "内部记录只保留在原工作区。");
        assert.deepEqual(replies[0]!.dotsDelivery!.artifacts.map(artifact => artifact.name), [recoveryProof]);
      }
    }
    console.log("PASS original Dots task recovery: " + fault);
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
  const host = await open(fault === "after" ? "stopAfterCommit" : undefined);
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
    const activity = new DotsActivity(host.db.connection, () => true).list().find(item => item.taskId === job.taskId);
    assert.equal(activity?.state, "delivered");
    assert.equal(activity.deliveryKey, results[0]!.dotsDelivery!.deliveryKey);
    assert.equal(activity.updatedAt, results[0]!.createdAt);
    assert.equal(messages.filter(m => m.role==="user" && m.inputRequestId===source).length,1);
    assert(!(await host.agent.loadTaskHistory(job.taskId)).messages.some(m=>m.dotsDelivery));
    assert.equal(workerCalls, previousCalls); assert.equal(replayAdmissions,0);
    evidence.push({fault,source,writerPid:cut.pid,recoveryPid:process.pid,committedBeforeExit:cut.committedReplies,
      workerCalls:cut.workerCalls,additionalWorkerCalls:workerCalls-previousCalls,replayAdmissions,
      messages:messages.slice(messages.indexOf(sourceEntry)).map(m=>({id:m.id,entryId:m.entryId,role:m.role,text:m.text,origin:m.dotsDelivery?.origin}))});
  } finally { await host.close(); }
}
// Run the external endpoint outside the writer process so it can prove what survived the crash.
{
  let posts = 0;
  let crashWriter: (() => void) | undefined;
  const endpoint = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/fixture-effect");
    request.resume();
    request.once("end", () => {
      posts++;
      if (posts === 1) crashWriter?.();
      // Acceptance happened at the external endpoint. Keep the receipt outstanding until the writer dies.
    });
    response.on("error", () => {});
  });
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const address = endpoint.address();
  assert(address && typeof address === "object");
  const writer = spawn(process.execPath, [process.argv[1]!, "externalEffect", root, String(address.port)], {
    windowsHide:true, stdio:["ignore","pipe","pipe"],
  });
  crashWriter = () => { writer.kill("SIGKILL"); };
  let childLog = "";
  writer.stdout.on("data", chunk => { childLog += String(chunk); });
  writer.stderr.on("data", chunk => { childLog += String(chunk); });
  const timer = setTimeout(() => writer.kill("SIGKILL"), 30_000);
  try {
    const [code, signal] = await once(writer, "close");
    clearTimeout(timer);
    assert.equal(posts,1,childLog);
    assert.equal(code,null,childLog);
    assert.equal(signal,"SIGKILL",childLog);
    endpoint.closeAllConnections();
    const cut = JSON.parse(readFileSync(join(root,"external-effect-cut.json"),"utf8")) as {
      taskId: string; operationId: string; submissionId: number;
    };
    const host = await open("externalEffect",address.port);
    try {
      const delivered = async () => (await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages
        .filter(message => message.dotsDelivery?.sourceMessageId === externalSource);
      for (let i=0; i<250 && !(await delivered()).length; i++) {
        host.journal.refresh(cut.taskId);
        await host.journal.drain();
        await sleep();
      }
      host.journal.refresh(cut.taskId);
      host.journal.refresh(DOTS_TASK_ID);
      await host.journal.drain();
      const [job, duplicate] = host.journal.list([externalSource]);
      assert.equal(job?.taskId,cut.taskId);
      assert.equal(job?.id,cut.operationId);
      assert.equal(duplicate,undefined);
      const native = await host.agent.findSubmission(cut.taskId,cut.operationId);
      assert.equal(native?.receipt?.submissionId,cut.submissionId);
      const failures = new ExecutionFailureRepository(host.db.connection).list(cut.taskId)
        .filter(failure => !failure.resolvedAt && failure.sideEffects === "unknown");
      assert.equal(failures.length,1);
      assert.equal(failures[0]?.recovery,"requires-user-action");
      const replies = await delivered();
      assert.equal(replies.length,1);
      assert.equal(replies[0]?.text,unconfirmed);
      assert.equal(replies[0]?.dotsDelivery?.operationId,cut.operationId);
      assert.equal(posts,1,"the reopened Dots worker must not repeat the external request");
      evidence.push({fault:"externalEffect",...cut,posts,signal,reply:replies[0]?.id,sideEffects:failures[0]?.sideEffects});
      console.log("PASS Dots worker crash after HTTP acceptance preserves task, submission and unknown effect, delivers once");
    } finally { await host.close(); }
  } finally {
    clearTimeout(timer);
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
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
  const receipt = replies[0]!.dotsDelivery!;
  await timedHost.journal.drain();
  timedHost.db.connection.prepare("UPDATE dots_reply_events SET snapshot='' WHERE event_key=?").run(receipt.deliveryKey);
  await timedHost.journal.recover(request => timedHost.agent.prompt(request, { durableAdmissionOnly: true }), () => true);
  const activity = new DotsActivity(timedHost.db.connection, () => true).list().find(item => item.taskId === receipt.taskId);
  assert.equal(activity?.state, "delivered");
  assert.equal(activity.deliveryKey, receipt.deliveryKey);
  assert.equal(activity.updatedAt, replies[0]!.createdAt);
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
  outbox.connect(async () => { throw Error("heartbeat must bypass model/followup"); }, async (reply, valid) => {
    if (!valid()) return { status: "discarded" };
    if (!permitAppend) return { status: "pending" };
    sends++;
    return { status: "appended", reply, deliveredAt: Date.now() };
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

async function inventoryDelivery(host: Awaited<ReturnType<typeof open>>, source: string) {
  return (await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages
    .filter(message => message.dotsDelivery?.sourceMessageId === source && message.dotsDelivery.kind === "conclusion")
    .map(message => message.text);
}

async function delegateInventory(host: Awaited<ReturnType<typeof open>>, source: string) {
  await host.fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: source, assistantMessageId: source + "-ack",
    text: "盘点库存，直接回复数字。" });
  const [job] = host.journal.list([source]);
  assert(job);
  const submission = await host.agent.findSubmission(job.taskId, job.id);
  assert(submission?.receipt);
  assert.equal((await host.agent.waitForSubmission(submission.receipt)).receipt?.status, "done");
  host.journal.refresh(job.taskId);
  await host.journal.drain();
  return job;
}

{
  const originalHost = await open();
  let original: Awaited<ReturnType<typeof delegateInventory>>;
  let originalDate: number;
  try {
    original = await delegateInventory(originalHost, legacySource);
    const history = (await originalHost.agent.loadTaskHistory(DOTS_TASK_ID)).messages;
    const delivery = history.find(message => message.dotsDelivery?.sourceMessageId === legacySource);
    assert(delivery?.dotsDelivery);
    originalDate = delivery.createdAt;
    originalHost.db.connection.prepare("UPDATE dots_reply_events SET snapshot='' WHERE event_key=?").run(delivery.dotsDelivery.deliveryKey);
    const activity = new DotsActivity(originalHost.db.connection, () => true);
    assert.equal(activity.list().find(item => item.taskId === original.taskId)?.state, "undelivered");
  } finally { await originalHost.close(); }

  const before = workerCalls;
  const host = await open("rerunLegacy");
  try {
    const activity = new DotsActivity(host.db.connection, () => true);
    const restored = activity.list().find(item => item.taskId === original.taskId);
    assert.equal(restored?.state, "delivered");
    assert.equal(restored.updatedAt, originalDate);
    assert.deepEqual(await inventoryDelivery(host, legacySource), [answer]);
    assert.equal(workerCalls, before);

    await host.fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: rerunSource, assistantMessageId: rerunSource + "-ack", text: "重跑一遍吧" });
    const [rerun] = host.journal.list([rerunSource]);
    assert.equal(rerun?.taskId, original.taskId);
    assert.notEqual(rerun.id, original.id);
    assert.equal(activity.list().find(item => item.taskId === original.taskId)?.state, "running");
    const replay = await host.actions.execute(DOTS_TASK_ID, rerunSource,
      { action: "resume", targetTaskId: original.taskId, operationId: original.id, text: "换个说法重新核对盘点" }, "重跑一遍吧");
    assert("receipt" in replay && replay.receipt?.operationId === rerun.id);
    await assert.rejects(host.actions.execute(DOTS_TASK_ID, rerunSource,
      { action: "delegate", spaceId: "sp-stock", assignmentQuote: "重跑一遍吧", text: "另外建一个盘点" }, "重跑一遍吧"), /本轮已经选定原任务/);
    const otherTaskId = "another-inventory-task";
    host.db.upsertTask({ id: otherTaskId, title: "另一批库存", spaceId: "sp-stock", updatedAt: Date.now() });
    await assert.rejects(host.actions.execute(DOTS_TASK_ID, rerunSource,
      { action: "resume", targetTaskId: otherTaskId, text: "改到另一批盘点" }, "重跑一遍吧"), /本轮已经选定原任务/);
    const receipt = (await host.agent.findSubmission(rerun.taskId, rerun.id))?.receipt;
    assert(receipt);
    host.releaseTimer();
    await host.agent.waitForSubmission(receipt);
    host.journal.refresh(rerun.taskId);
    await host.journal.drain();
    assert.deepEqual(await inventoryDelivery(host, rerunSource), [rerunAnswer]);
    assert.deepEqual(await inventoryDelivery(host, legacySource), [answer]);
    const updated = activity.list().find(item => item.taskId === original.taskId);
    assert.equal(updated?.state, "delivered");
    assert.equal(updated.id, rerun.id);
    assert.equal(workerCalls, before + 1);

    const staleSource = "stale-inventory-retry";
    await assert.rejects(host.actions.execute(DOTS_TASK_ID, staleSource,
      { action: "resume", targetTaskId: original.taskId, operationId: original.id, text: "重跑旧版" }, "重跑旧版"), /原任务的交办已变化/);
    await assert.rejects(host.actions.execute(DOTS_TASK_ID, staleSource,
      { action: "delegate", spaceId: "sp-stock", text: "重跑旧版" }, "重跑旧版"), /本轮已经选定原任务/);
    const freshSource = "fresh-inventory-rerun";
    await host.fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: freshSource, assistantMessageId: freshSource + "-ack", text: "再复核一次" });
    const [fresh] = host.journal.list([freshSource]);
    assert.equal(fresh?.taskId, original.taskId);
    assert.notEqual(fresh.id, rerun.id);
    const freshReceipt = (await host.agent.findSubmission(fresh.taskId, fresh.id))?.receipt;
    assert(freshReceipt);
    await host.agent.waitForSubmission(freshReceipt);
    host.journal.refresh(fresh.taskId);
    await host.journal.drain();
    assert.deepEqual(await inventoryDelivery(host, freshSource), [rerunAnswer]);
    assert.equal(workerCalls, before + 2);

    const movedSpace = host.db.createSpace({ id: "sp-moved-inventory", name: "另一处库存", path: root });
    host.db.upsertTask({ ...host.db.getTask(original.taskId)!, spaceId: movedSpace.id });
    await assert.rejects(host.actions.execute(DOTS_TASK_ID, "moved-inventory-retry",
      { action: "resume", targetTaskId: original.taskId, operationId: fresh.id, text: "再次核对" }, "再次核对"), /原交办的工作空间已变化/);
    assert.equal(workerCalls, before + 2);
    console.log("PASS Dots restores a committed legacy delivery and registers and delivers a rerun on the same task");
  } finally { await host.close(); }
}

for (const workspace of ["private", "inherited"] as const) {
  const host = await open(undefined, undefined, workspace);
  try {
    const source = "new-inventory-" + workspace;
    const job = await delegateInventory(host, source);
    assert.deepEqual(await inventoryDelivery(host, source), ["盘点结果是 37 件，其中 2 件需要补货。"]);
    const activity = new DotsActivity(host.db.connection, () => true);
    assert.equal(activity.list().find(item => item.taskId === job.taskId)?.state, "delivered");
  } finally { await host.close(); }
}

const pendingHost = await open("pendingInitialDirectory", undefined, "private");
try {
  const source = "interrupted-before-private-workspace";
  await delegateInventory(pendingHost, source);
  assert.deepEqual(await inventoryDelivery(pendingHost, source), ["盘点结果是 37 件，其中 2 件需要补货。"]);
} finally { await pendingHost.close(); }

const missingSource = "old-private-inventory";
const reboundSource = "old-rebound-inventory";
for (const [workspace, source] of [["rebound", reboundSource], ["private", missingSource]] as const) {
  const host = await open("missingInitialDirectory", undefined, workspace);
  try {
    const job = await delegateInventory(host, source);
    assert.deepEqual(await inventoryDelivery(host, source), []);
    const activity = new DotsActivity(host.db.connection, () => true);
    assert.equal(activity.list().find(item => item.taskId === job.taskId)?.state, "undelivered");
  } finally { await host.close(); }
}

const beforeWorkspaceRecovery = { workerCalls, replayAdmissions };
for (let round=0; round<2; round++) {
  const host = await open();
  try {
    await host.journal.drain();
    assert.deepEqual(await inventoryDelivery(host, missingSource), ["盘点结果是 37 件，其中 2 件需要补货。"]);
    assert.deepEqual(await inventoryDelivery(host, reboundSource), []);
    assert.deepEqual({ workerCalls, replayAdmissions }, beforeWorkspaceRecovery);
    const activity = new DotsActivity(host.db.connection, () => true);
    const [recovered] = host.journal.list([missingSource]);
    assert.equal(activity.list().find(item => item.taskId === recovered.taskId)?.state, "delivered");
  } finally { await host.close(); }
}
console.log("PASS private and inherited workspaces deliver to Dots. A previously omitted private result returns once without re-execution, while a rebound space stays outside recovery.");

for (const scenario of ["dependency", "dependencyDeadline"] as const) {
  const host = await open(scenario);
  try {
    const source = scenario;
    const previousCalls = workerCalls;
    await host.fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: source, assistantMessageId: source + "-ack", text: dependencyAssignment });
    let [upstream, downstream] = host.journal.list([source]);
    const deadline = Date.now() + 15000;
    while (!downstream?.dependencyWait && Date.now() < deadline) {
      await sleep();
      [upstream, downstream] = host.journal.list([source]);
    }
    assert(upstream && downstream?.dependencyWait && host.enteredTimer());
    assert.equal(downstream.dependencyWait.operationId, upstream.id);
    assert.equal(new DotsActivity(host.db.connection, () => true).list().find(item => item.taskId === downstream.taskId)?.state, "dependency");
    const status = await host.actions.execute(DOTS_TASK_ID, undefined, { action: "task", targetTaskId: downstream.taskId });
    assert(status && "status" in status);
    assert.equal(status.status, "waiting_dependency");
    assert.equal(workerCalls, previousCalls + 1, "the downstream run settles after its native park tool");
    if (scenario === "dependency")
      await host.actions.execute(DOTS_TASK_ID, "stop-pinned-upstream", { action: "stop", targetTaskId: upstream.taskId });
    let question: string | undefined;
    while (!question && Date.now() < deadline) {
      question = (await host.agent.loadTaskHistory(DOTS_TASK_ID)).messages.find(message =>
        message.dotsDelivery?.taskId === downstream.taskId && message.dotsDelivery.kind === "question")?.text;
      if (!question) await sleep();
    }
    assert.match(question ?? "", scenario === "dependency" ? /依赖「上游依赖」已停止/ : /等待「上游依赖」已到期/);
    if (scenario === "dependencyDeadline") {
      host.releaseTimer();
      const native = await host.agent.findSubmission(upstream.taskId, upstream.id);
      assert(native?.receipt);
      const result = await host.agent.waitForSubmission(native.receipt);
      assert.equal(result.receipt?.status, "done", "the prerequisite really finishes after the dependency deadline");
    }
    for (let round = 0; round < 3; round++) { host.journal.refresh(); await host.journal.drain(); }
    assert.equal(workerCalls, previousCalls + 1, "an unavailable prerequisite never starts a replacement model turn");
    assert.equal(host.journal.list([source]).length, 2);
    console.log("PASS dependency wait has its own state and reports its blocker to the original Dots input", scenario);
  } finally { await host.close(); }
}

const newPage = await open();
try {
  const original = await newPage.agent.loadTaskHistory(DOTS_TASK_ID);
  const source = original.messages.find(message => message.inputRequestId === "dependencyDeadline");
  assert.ok(original.durable && source?.entryId);
  await newPage.agent.newDotsConversation();
  const fresh = await newPage.agent.loadTaskHistory(DOTS_TASK_ID);
  assert.ok(fresh.durable);
  assert.notEqual(fresh.durable.conversationId, original.durable.conversationId);
  assert.deepEqual(fresh.messages, []);

  const delivery = await newPage.agent.appendDotsReply({
    deliveryKey: "archived-page-followup",
    operationId: "archived-page-followup",
    taskId: "archived-page-worker",
    sourceMessageId: "dependencyDeadline",
    origin: { conversationId: Number(original.durable.conversationId), entryId: Number(source.entryId) },
    title: "原页面交付",
    text: "结果回到启动事项的页面",
    kind: "conclusion",
    artifacts: [],
  });
  assert.equal(delivery.status, "appended");
  assert.deepEqual((await newPage.agent.loadTaskHistory(DOTS_TASK_ID)).messages, []);
} finally { await newPage.close(); }
console.log("PASS a new Dots conversation is empty and an existing assignment can still deliver to its original page");

mkdirSync("out/tests",{recursive:true});
writeFileSync("out/tests/dots-reply-recovery.json", JSON.stringify(evidence,null,2)+"\n");
console.log("PASS both crash boundaries and repeated events: original conversation received one new assistant reply, ordinary task ran once");
