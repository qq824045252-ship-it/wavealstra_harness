import assert from "node:assert/strict";
import { DotsActivity } from "../src/main/dots/DotsActivity";
import { dotsCompletionRequirements, dotsProgressInScope } from "../src/main/dots/DotsCompletion";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { resolveDotsPreferences } from "../src/shared/dots-settings";
import { readNativeExecutionReceipt } from "../src/shared/native-execution-receipt";
const root = mkdtempSync(join(tmpdir(), "dots-followup-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { DotsDelegations } = await import("../src/main/dots/DotsDelegations");
const { createArtifactDomain } = await import("../src/main/artifact/ArtifactDomainSetup");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const { sourceWorkOutcome } = await import("../src/main/agent/hooks/ImprovementSourceContext");
const { openDurablePassiveStorage } = await import("../src/main/agent/durable/DurableStorage");
const { dotsGoalConclusion } = await import("../src/main/dots/DotsGoalConclusion");
const db = new AppDatabase(join(root, "app.db"));
const domain = createArtifactDomain(db.connection);
db.openDots();
const folder = join(root, "customer");
mkdirSync(folder);
const goalFile = "验收后的工作成果.txt";
const acceptedFileBody = "固定的交付版本";
const newFileBody = "验收后改写的版本";
writeFileSync(join(folder, "到货记录.txt"), "批次累计 18 件");
writeFileSync(join(folder, "第二批.txt"), "周一批次累计 18 件");
const space = db.upsertSpace({ id: "customer", name: "客户资料", path: folder });
let nextCall: Record<string, unknown> | undefined;
let phase: "first" | "question" | "finish-delivery" | "report-first" | "report-last" | "missing" | "done" | "event" | "empty" | "partial" | "files" | "running" | "goal" | "goal-complete" | "goal-user" | "refused" = "first";
let runningGate: (() => void) | undefined;
let workerTurns = 0;
const goal = "核对到货数，确认批次后汇总，不要发送邮件";
const baseline = "已核对到货数为 18 件。";
const question = "这一批到货应归入哪个批次？";
const writtenResult = "采购说明正文：使用无塑纸封套，标签注明内部资料。";
const approvedUrl = "https://example.invalid/approved";
const approvedExcerpt = "The approved packaging uses paper sleeves.";
const approvedDelivery = writtenResult + ` [来源](${approvedUrl} "${approvedExcerpt}")`;
const draftUrl = "https://example.invalid/draft";
const draftExcerpt = "This reference belongs to the draft.";
const draftDelivery = `另拟塑料封套。 [来源](${draftUrl} "${draftExcerpt}")`;
const sourceExcerpts = `[Approved packaging](${approvedUrl})\n> ${approvedExcerpt}\n\n[Draft packaging](${draftUrl})\n> ${draftExcerpt}`;
let reviewFinalStatus: "completed" | "failed" = "failed";
const conclusion = "东区批次已核对，合计到货 18 件。";
const executionNotes = "复核底稿：逐行比对到货记录及采购登记，把确认的批次写入内部记录。";
const reportFormat = "用 Markdown 给我完整报告，包含依据和复核过程。";
const fullReport = "## 汇总\n\n到货 18 件。\n\n## 依据\n\n原始到货登记 18 件。\n\n## 复核过程\n\n汇总数与登记一致。\n";
const partial = "验收清单列出仓储、装配两项。财务栏仍空着。";
const runningMilestone = "周一批次原始记录显示 18 件。";
const planResult = "本轮只列出修复方案，具体代码后续再补。";
const repairedResult = "导入和导出同时恢复，文件名中的中文也能保留。";
const forgedResult = "本地提交和项目验收均已完成。";
const manualIntro = "已按你的要求更新。";
const manualResult = "排版已经更新。\n\n1. 保留原有入口。";
const manualEnvelope = JSON.stringify({ dotsState: "complete", result: manualResult });
const fencedManualEnvelope = "```json\n" + manualEnvelope + "\n```";
const leakedReply = `${manualIntro}\n\n${fencedManualEnvelope}`;
const completedWorkerReply = (result: string) => [{ type: "text" as const, text: JSON.stringify({ dotsState: "complete", result }) }];
const deliveryReply = (text: string, notes: string) => [{ type: "text" as const,
  text: JSON.stringify({ dotsState: "complete", result: notes, delivery: { text } }) }];
const fixture = await createAgentDurableFixture(root, db, async (input) => {
  const tools = getCurrentTools(input.messages);
  if (!tools.length) return [{ type: "text", text: JSON.stringify({ candidates: [] }) }];
  if (tools.some((t) => t.name === "dots_action")) {
    if (nextCall) {
      const args = nextCall as Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];
      nextCall = undefined;
      return [{ type: "toolCall", id: "dots-" + input.messages.length, name: "dots_action", arguments: args }];
    }
    return [{ type: "text", text: "已接下这件事。" }];
  }
  if (tools.some((t) => t.name === "read")) {
    workerTurns++;
    const latestUser = JSON.stringify(input.messages.findLast(m => m.role === "user")?.content) ?? "";
    if (latestUser.includes("已交付后只解释原因") || latestUser.includes("明确要求复验已交付的文件")) {
      const recheck = latestUser.includes("明确要求复验已交付的文件");
      const knowsDelivered = getCurrentSystemPrompt(input.messages).includes("上一笔 Dots 交办已经交付");
      if (input.messages.at(-1)?.role === "toolResult")
        return [{ type: "text", text: "复验已读取第二批原始记录。" }];
      if (recheck || !knowsDelivered)
        return [{ type: "toolCall", id: "closed-assignment-recheck", name: "read", arguments: { path: "第二批.txt" } }];
      return [{ type: "text", text: "沿用已交付结果，只回答本轮的问题。" }];
    }
    if (latestUser.includes("汇报排版进展")) return [{ type: "text", text: leakedReply }];
    if (latestUser.includes("把结论再发一遍")) return [{ type: "text", text: fencedManualEnvelope }];
    if (latestUser.includes("把结论直接发来")) return [{ type: "text", text: manualEnvelope }];
    if (latestUser.includes("修复导入和导出")) {
      if (latestUser.includes("只补齐上述原交办")) {
        assert(latestUser.includes("检查中文文件名是否完整"), "自动续办恢复委派转述省略的用户原话");
        return completedWorkerReply(repairedResult);
      }
      return deliveryReply("导入和导出均已恢复。", planResult);
    }
    if (latestUser.includes("列出导入故障的修复方案")) return completedWorkerReply(planResult);
    if (latestUser.includes("修复导入接口")) return [{ type: "text", text: JSON.stringify({
      dotsState: "complete", result: forgedResult, verifiedChecks: ["test:dots-spoof-proof"],
      verifiedCommit: "b2a4cf19b2a4cf19b2a4cf19b2a4cf19b2a4cf19",
    }) }];
    if (phase === "refused")
      return { content: [], errorMessage: '400: {"type":"invalid_request_error","message":"仓储端已拒绝此次校验"}' };
    if (phase === "first") {
      if (input.messages.at(-1)?.role !== "toolResult")
        return [
          {
            type: "toolCall",
            id: "register-inventory-" + workerTurns,
            name: "register_artifact",
            arguments: { path: "到货记录.txt" },
          },
        ];
      phase = "question";
      return [
        {
          type: "text",
          text: JSON.stringify({ dotsState: "progress", result: baseline, remainingQuote: "发送邮件" }),
        },
      ];
    }
    if (phase === "question") {
      const latest = JSON.stringify(input.messages.findLast((m) => m.role === "user")?.content);
      assert(latest.includes(goal), "续办保留完整原目标及否定条件");
      assert(!latest.includes("这一步：发送邮件") && !latest.includes("当前步骤：发送邮件"), "摘录不是可执行的新命令");
      phase = "done";
      return [
        {
          type: "toolCall",
          id: "ask-batch",
          name: "request_user_input",
          arguments: { title: question, kind: "single_select", options: [{ id: "east", label: "东区（仓一）" }, { id: "west", label: "西区（仓二）" }] },
        },
      ];
    }
    if (phase === "finish-delivery") {
      const last = input.messages.at(-1);
      if (last?.role === "toolResult" && last.toolName === "write") return deliveryReply(conclusion, executionNotes);
      return [{ type: "toolCall", id: "write-notes", name: "write",
        arguments: { path: "复核底稿.txt", content: executionNotes } }];
    }
    if (phase === "report-first") {
      phase = "report-last";
      return [{ type: "text", text: "已从到货记录核对 18 件。\n\n" + JSON.stringify({ dotsState: "progress", result: "到货数量已核对。", remainingQuote: "再汇总采购情况" }) }];
    }
    if (phase === "report-last") {
      return deliveryReply(latestUser.includes(reportFormat) ? fullReport : conclusion, executionNotes);
    }
    if (phase === "missing") {
      const last = input.messages.at(-1);
      const secondCheck = latestUser.includes("复核明细.csv");
      const filename = secondCheck ? "复核明细.csv" : "入库明细.csv";
      if (last?.role === "toolResult" && last.toolName === "read") {
        if (last.isError && secondCheck) return [{ type: "text", text: "已核查绑定目录。\n\n```json\n" + JSON.stringify({
          dotsState: "blocked", result: executionNotes, delivery: { text: "请把复核明细.csv 上传到原空间。" },
        }) + "\n```" }];
        return last.isError ? deliveryReply("请把入库明细.csv 上传到原空间。", "已核对 A 表。B 表尚未核对，缺入库明细.csv。")
          : deliveryReply("42", "已从补齐的明细读取 42。下次如需增加统计范围，请上传新的数据文件。");
      }
      return [{ type: "toolCall", id: "read-inbound", name: "read", arguments: { path: filename } }];
    }
    if (phase === "goal") {
      const lastUser = input.messages.findLast((m) => m.role === "user");
      const context = JSON.stringify(lastUser?.content ?? "");
      if (context.includes("宿主自动续跑"))
        return [
          {
            type: "toolCall",
            id: "goal-await",
            name: "request_user_input",
            arguments: { title: "原目标下一批应采用哪个日期？", kind: "short_text" },
          },
        ];
      return [{ type: "text", text: "原目标第一阶段已确认 18 件，第二阶段仍待推进。" }];
    }
    if (phase === "goal-complete") {
      const lastTool = input.messages.findLast(message => message.role === "toolResult");
      const lookup = input.messages.findLast(message => message.role === "toolResult" && message.toolName === "conversation_goal_get");
      if (!lastTool || lastTool.toolName === "request_user_input") {
        return [{ type: "toolCall", id: "goal-get", name: "conversation_goal_get", arguments: {} }];
      }
      if (lastTool.toolName === "conversation_goal_propose_complete" && !lastTool.isError) {
        assert.equal((lastTool.details as any).goal.status, "achieved");
        assert.equal(lastTool.toolCallId, "goal-close", "a superseded receipt cannot close the Goal");
        writeFileSync(join(folder, goalFile), newFileBody);
        phase = "done";
        return [{ type: "text", text: "内部记录已经保存。" }];
      }
      if (lastTool.toolName === "conversation_goal_propose_complete" && lastTool.isError) {
        if (lastTool.toolCallId === "goal-stale-read") {
          assert(JSON.stringify(lastTool.content).includes("更新的读取结果"));
          return [{ type: "toolCall", id: "goal-replace-source", name: "write", arguments: { path: "第二批.txt", content: "周一批次累计 19 件" } }];
        }
        if (lastTool.toolCallId === "goal-stale-after-write") {
          assert(JSON.stringify(lastTool.content).includes("版本变化"));
          writeFileSync(join(folder, "第二批.txt"), "周一批次累计 18 件");
          return [{ type: "toolCall", id: "goal-repeat-read", name: "read", arguments: { path: "第二批.txt" } }];
        }
        if (lastTool.toolCallId === "goal-self-claim") {
          assert(JSON.stringify(lastTool.content).includes("可交付内容"));
        } else {
          assert(JSON.stringify(lastTool.content).includes("未在本次交办"));
          if (lastTool.toolCallId !== "goal-echo") {
            writeFileSync(join(folder, "第二批.txt"), "周一批次累计 17 件");
            return [{ type: "toolCall", id: "goal-read", name: "read", arguments: { path: "第二批.txt" } }];
          }
        }
      }
      assert(lookup?.role === "toolResult");
      const details = lookup.details as any;
      assert.equal(details.completion, "dots_evidence");
      const criterionId = details.goal.criteria[0].id;
      if (lastTool.toolName === "conversation_goal_get") return [
        { type: "text", text: "我做好了" },
        { type: "toolCall", id: "goal-self-claim", name: "conversation_goal_propose_complete", arguments: {
          ...details.versionGuard, summary: "我做好了", deliveryText: "我做好了", observations: [{criterionId, quote:"我做好了"}],
        } },
      ];
      if (lastTool.toolCallId === "goal-self-claim") return [
        { type: "text", text: "在已有目标上继续核对" },
        { type: "toolCall", id: "goal-echo", name: "conversation_goal_propose_complete", arguments: {
          ...details.versionGuard, summary: "在已有目标上继续核对", deliveryText: "在已有目标上继续核对", observations: [{criterionId, quote:"在已有目标上继续核对"}],
        } },
      ];
      if (lastTool.toolCallId === "goal-read") {
        assert(JSON.stringify(lastTool.content).includes("周一批次累计 17 件"));
        writeFileSync(join(folder, "第二批.txt"), "周一批次累计 18 件");
        return [{ type: "toolCall", id: "goal-latest-read", name: "read", arguments: { path: pathToFileURL(join(folder, "第二批.txt")).href } }];
      }
      const currentObservation = { criterionId, toolCallId: "goal-latest-read", quote: "周一批次累计 18 件" };
      const oldObservation = { criterionId, toolCallId: "goal-read", quote: "周一批次累计 17 件" };
      if (lastTool.toolCallId === "goal-latest-read" || lastTool.toolCallId === "goal-repeat-read")
        assert(JSON.stringify(lastTool.content).includes("周一批次累计 18 件"));
      if (lastTool.toolCallId === "goal-repeat-read") return [{ type: "toolCall", id: "goal-write-file",
        name: "write", arguments: { path: goalFile, content: acceptedFileBody } }];
      if (lastTool.toolCallId === "goal-write-file") {
        assert(!lastTool.isError);
        assert.deepEqual(readNativeExecutionReceipt(lastTool.details)?.fileChange?.checkedRange, {
          sha256: createHash("sha256").update(acceptedFileBody).digest("hex"), bytes: Buffer.byteLength(acceptedFileBody),
        });
        return [{ type: "toolCall", id: "goal-register-file", name: "register_artifact", arguments: { path: goalFile } }];
      }
      if (lastTool.toolCallId === "goal-register-file") assert(!lastTool.isError);
      if (lastTool.toolCallId === "goal-replace-source") assert(!lastTool.isError);
      return [{
        type: "toolCall", id: lastTool.toolCallId === "goal-latest-read" ? "goal-stale-read" :
          lastTool.toolCallId === "goal-register-file" ? "goal-close" :
            lastTool.toolCallId === "goal-replace-source" ? "goal-stale-after-write" : "goal-no-evidence",
        name: "conversation_goal_propose_complete", arguments: {
          ...details.versionGuard, summary: "内部核对：第二批原始文件支持结论。", deliveryText: conclusion,
          observations: lastTool.toolCallId === "goal-register-file" ? [{ ...currentObservation, toolCallId: "goal-repeat-read" }] :
            lastTool.toolCallId === "goal-latest-read" ? [currentObservation, oldObservation] :
              lastTool.toolCallId === "goal-replace-source" ? [currentObservation] : [oldObservation],
        },
      }];
    }
    if (phase === "goal-user") {
      const lastTool = input.messages.findLast(message => message.role === "toolResult");
      if (!lastTool) {
        const targetInput = JSON.stringify(input.messages);
        assert(targetInput.includes("只回说明正文这一段"), "执行收到用户自己约定的交付格式");
        assert(!targetInput.includes("私事识别短语-761"), "只对 Dots 讲的内容不得复制进工作任务");
        return [
        { type: "text", text: writtenResult },
        { type: "toolCall", id: "text-goal-get", name: "conversation_goal_get", arguments: {} },
        ];
      }
      if (lastTool.toolName === "conversation_goal_get") {
        const details = lastTool.details as any;
        assert.equal(details.completion, "user_confirmation");
        return [{ type: "toolCall", id: "text-goal-complete", name: "conversation_goal_propose_complete", arguments: {
          ...details.versionGuard, summary: "实际撰写并逐项核对采购说明。", deliveryText: approvedDelivery,
          observations: [{ criterionId: details.goal.criteria[0].id, quote: writtenResult }],
        } }];
      }
      assert.equal(lastTool.toolName, "conversation_goal_propose_complete");
      assert(!lastTool.isError, JSON.stringify(lastTool.content));
      assert.equal((lastTool.details as any).confirmed, true);
      phase = "refused";
      if (reviewFinalStatus === "completed") return deliveryReply(draftDelivery, "内部起草记录。");
      return { content: [], errorMessage: "400: post-close composition failed" };
    }
    if (phase === "event") return completedWorkerReply("已读取交付触发信号，批次已登记。");
    if (phase === "empty") return [{ type: "text", text: "" }];
    if (phase === "partial") return [{ type: "text", text: partial }];
    if (phase === "files") {
      const last = input.messages.at(-1);
      if (last?.role === "toolResult") {
        if (last.toolCallId === "write-only-file") return [{ type: "toolCall", id: "write-file-notes", name: "write", arguments: { path: "工作底稿.txt", content: executionNotes } }];
        if (last.toolCallId === "write-file-notes") return [{ type: "toolCall", id: "register-file-notes", name: "register_artifact", arguments: { path: "工作底稿.txt" } }];
        if (last.toolCallId === "register-file-notes") return deliveryReply("第二批核对完毕，合计 18 件。", executionNotes);
      }
      return [{ type: "toolCall", id: "write-only-file", name: "write",
        arguments: { path: "第二批.txt", content: "周一批次累计 18 件" } }];
    }
    if (phase === "running") {
      const last = input.messages.at(-1);
      if (last?.role !== "toolResult") return [
        { type: "text", text: partial },
        { type: "toolCall", id: "initial-checkpoint-read", name: "read", arguments: { path: "第二批.txt" } },
      ];
      await new Promise<void>(resolve => { runningGate = resolve; });
      if (last.toolCallId === "initial-checkpoint-read") return [
        { type: "text", text: JSON.stringify({ dotsState: "progress", result: runningMilestone, remainingQuote: "核对另一批的原始记录" }) },
        { type: "toolCall", id: "remaining-checkpoint-read", name: "read", arguments: { path: "到货记录.txt" } },
      ];
      return completedWorkerReply("两份记录均已核对，各为 18 件。");
    }
    return completedWorkerReply(conclusion);
  }
  return [{ type: "text", text: "OK" }];
});
const { agent } = fixture;
agent.setArtifactDomain(domain.service, domain.coordinator);
const journal = new DotsDelegations(
  db.connection,
  (...args) => agent.dotsSubmission(...args),
  () => {},
);
let dropGoalLink = false;
const makeActions = () =>
  new DotsActions(db, agent, {
    link: (...args) => {
      if (dropGoalLink && args[1].startsWith("goal-continuation:")) return;
      journal.link(...args);
    },
    list: () => journal.list(),
    rememberOrigin: (s, o) => journal.rememberOrigin(s, o),
    failed: (...args) => journal.failed(...args),
    changed: () => journal.refresh(),
    preferences: () => resolveDotsPreferences(agent.getAppSettings().dotsSettings),
  });
let actions = makeActions();
agent.setDotsActions(actions);
let heldSource: string | undefined;
let resumeRelay: (() => void) | undefined;
let pendingConclusionSource: string | undefined;
let lostGoalAck: string | undefined;
let recoveredGoalAck = false;
journal.connect(
  async (job, req) => {
    if (job.sourceMessageId === heldSource && job.status === "completed")
      await new Promise<void>((resolve) => {
        resumeRelay = resolve;
      });
    return actions.followup(job, req);
  },
  async (reply, current) => {
    if (reply.kind === "conclusion" && reply.sourceMessageId === pendingConclusionSource) {
      pendingConclusionSource = undefined;
      return { status: "pending" };
    }
    const result = await agent.appendDotsReply(reply, current);
    if (reply.completion && reply.sourceMessageId === "source-6") {
      if (result.status === "appended" && !lostGoalAck) {
        lostGoalAck = reply.deliveryKey;
        throw new Error("fixture: original conversation committed before outbox acknowledgement");
      }
      if (result.status === "existing" && reply.deliveryKey === lostGoalAck) recoveredGoalAck = true;
    }
    return result;
  },
);
agent.onPatch(patch => journal.onPatch(patch));
actions.startFileWatches();
let turn = 0;
async function send(text: string, args: Record<string, unknown>) {
  const id = ++turn;
  nextCall = args;
  console.log("Sending Dots user input", id);
  const result = await agent.prompt(
    {
      taskId: DOTS_TASK_ID,
      text,
      userMessageId: "source-" + id,
      assistantMessageId: "reply-" + id,
      modelId: "fixture/model",
    },
    { durableAdmissionOnly: true },
  );
  assert(result.receipt);
  await agent.waitForSubmission(result.receipt);
  console.log("Dots user input settled", id);
}
async function messageContains(text: string, sourceMessageId?: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const history = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    if (history.messages.some((m) => m.role === "assistant" && m.text.includes(text)
      && (!sourceMessageId || m.dotsDelivery?.sourceMessageId === sourceMessageId))) return history.messages;
    await delay(80);
  }
  throw Error(
    "原 Dots 对话缺少可见回复 " +
      text +
      "; deliveries=" +
      JSON.stringify(journal.list().map((j) => [j.status, j.text])),
  );
}
async function releaseRunningWorker() {
  const deadline = Date.now() + 20000;
  while (!runningGate && Date.now() < deadline) await delay(80);
  assert(runningGate, "工具返回后原生输入仍处于同一运行");
  const release = runningGate;
  runningGate = undefined;
  release();
}
try {
  await send(goal, { action: "delegate", spaceId: space.id, name: "核对到货", text: goal });
  const blocked = await messageContains(question);
  console.log("Observed Dots question", JSON.stringify(blocked.map((m) => [m.role, m.text.slice(-140)])), workerTurns);
  assert.equal(turn, 1);
  assert.equal(workerTurns, 3);
  assert(blocked.some((m) => m.role === "assistant" && m.text.includes(baseline) && m.text.includes(question)));
  const files = blocked.find((m) => m.dotsDelivery?.kind === "question")?.dotsDelivery?.artifacts ?? [];
  assert.equal(files.length, 1, "问题带上一阶段同一交办产生的文件");
  assert.equal(files[0].name, "到货记录.txt");
  assert.equal(readFileSync(files[0].saved!.snapshotPath, "utf8"), "批次累计 18 件");
  const rows = journal.list(["source-1"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].taskId, rows[1].taskId);
  assert.equal(rows[1].status, "blocked");
  console.log(
    "PASS 一次交办后普通任务自行续办，并主动回原对话提问",
    JSON.stringify({ source: "source-1", receipts: rows.map((r) => r.id), question }),
  );
  phase = "finish-delivery";
  await send("刚才「到货批次筛选」那项选东区。继续处理。", {
    action: "steer",
    targetTaskId: rows[1].taskId,
    text: "选东区",
  });
  await messageContains(conclusion);
  for (let i = 0; i < 3; i++) journal.refresh(rows[0].taskId);
  await journal.drain();
  assert.equal(journal.list(["source-1"]).length, 2);
  assert.deepEqual(journal.list(["source-2"]), [], "选择回答了原生问题，没有排队第二笔输入");
  const final = await messageContains(conclusion);
  const delivered = final.find((m) => m.dotsDelivery?.kind === "conclusion");
  assert.equal(delivered?.text, conclusion);
  assert.equal(delivered?.dotsDelivery?.sourceMessageId, "source-1");
  assert.deepEqual(delivered?.dotsDelivery?.artifacts, files, "只交付登记过的成品，不附原任务的底稿");
  assert.equal(final.filter((m) => m.role === "assistant" && m.text.includes(conclusion)).length, 1);
  assert(!final.some(m => m.role === "assistant" && m.text.includes(executionNotes)));
  assert.equal(readFileSync(join(folder, "复核底稿.txt"), "utf8"), executionNotes);
  await agent.releaseDurableTask(rows[0].taskId);
  assert.equal((await agent.loadTaskHistory(rows[0].taskId)).messages.findLast(m => m.finalAssistantReply)?.text,
    `${conclusion}\n\n${executionNotes}`);
  console.log("PASS 原对话收到一次结论及成品，原任务重开后仍能查看底稿和执行记录");
  phase = "event";
  await send("清单到达后登记", {
    action: "watch_file",
    targetTaskId: rows[0].taskId,
    path: "list.txt",
    text: "收到清单后登记批次",
  });
  writeFileSync(join(folder, "list.txt"), "东区");
  await messageContains("已读取交付触发信号");
  assert.equal(journal.list(["source-3"]).length, 1);
  console.log("PASS 文件真实到达后回订阅来源对话");
  phase = "empty";
  await send("请汇总验收情况", { action: "delegate", spaceId: space.id, name: "检查空结果", text: "请汇总验收情况" });
  await messageContains("已尝试补救一次");
  assert.equal(journal.list(["source-4"]).length, 2, "空回复只补救一次");
  console.log("PASS 空回复一次有限补救，仍空时原对话提问");
  const rejectId = "dots-input-known-rejected";
  const rejectTask = rows[0].taskId;
  await send("请向这个运行发送新指令", { action: "task", targetTaskId: rejectTask });
  const bad = {
    taskId: rejectTask,
    spaceId: space.id,
    requireActiveRun: true,
    streamingBehavior: "steer" as const,
    userMessageId: rejectId,
    assistantMessageId: "reject-reply",
    text: "继续正在执行的事项",
  };
  journal.link(rejectTask, rejectId, "source-5", false, bad);
  const rejected = await agent.prompt(bad, { durableAdmissionOnly: true });
  assert(!rejected.receipt && rejected.error);
  journal.failed(rejectTask, rejectId, rejected.error.message);
  await messageContains("原任务没有接收本次执行");
  assert.equal(await agent.findSubmission(rejectTask, rejectId), undefined);
  console.log("PASS 原生入队明确拒绝时带原因提问，没有重做");
  const goalTask = "ordinary-long-goal";
  db.upsertTask({ id: goalTask, title: "原目标", spaceId: space.id, updatedAt: Date.now() });
  const g = agent.createConversationGoal({
    taskId: goalTask,
    title: "核对存量",
    description: "核对两个批次",
    criteria: [{ text: "第二批已核对" }],
  });
  assert(g.ok);
  const settings = resolveDotsPreferences(agent.getAppSettings().dotsSettings);
  await agent.updateAppSettings({dotsSettings:{...settings,followupMode:"paused"}});
  phase = "goal";
  dropGoalLink = true;
  await send("在已有目标上继续核对", {
    action: "delegate",
    targetTaskId: goalTask,
    goalId: g.goal.id,
    text: "在已有目标上继续核对。候选是周一批次累计 18 件，请读取原始文件独立核对。",
  });
  for (let i=0; i<200 && agent.getGoalContinuation(g.goal.id)?.lastCheck?.reason !== "dots_policy"; i++) await delay(30);
  assert.equal(agent.getGoalContinuation(g.goal.id)?.lastCheck?.reason,"dots_policy");
  assert.equal(agent.getGoalContinuation(g.goal.id)?.attempts,0);
  assert(!agent.getConversationRuntimeSnapshot(goalTask).interactions.some(i=>i.status==="pending"));
  await agent.updateAppSettings({dotsSettings:{...settings,followupMode:"continue"}});
  const deadline = Date.now() + 30000;
  while (
    !agent.getConversationRuntimeSnapshot(goalTask).interactions.some((i) => i.status === "pending") &&
    Date.now() < deadline
  )
    await delay(80);
  assert(agent.getConversationRuntimeSnapshot(goalTask).interactions.some((i) => i.status === "pending"));
  assert.equal(journal.list(["source-6"]).length, 1, "模拟原生续跑提交后、关联写入前中断");
  await actions.closeFileWatches();
  dropGoalLink = false;
  actions = makeActions();
  agent.setDotsActions(actions);
  actions.startFileWatches();
  await messageContains("原目标下一批应采用哪个日期？");
  const goalRows = journal.list(["source-6"]);
  assert(goalRows.some((r) => r.id.startsWith("goal-continuation:") && r.interactionId && r.goalId === g.goal.id));
  console.log("PASS 现有 Goal 原生续跑关联原交办并问一个问题");
  const goalRow = goalRows.find((r) => r.interactionId)!;
  phase = "goal-complete";
  await send("周一", {
    action: "answer",
    targetTaskId: goalTask,
    operationId: goalRow.id,
    interactionId: goalRow.interactionId,
  });
  const doneDeadline = Date.now() + 30000;
  while (
    journal.list(["source-6"]).find((r) => r.id === goalRow.id)?.status !== "completed" &&
    Date.now() < doneDeadline
  )
    await delay(80);
  const done = journal.list(["source-6"]).find((r) => r.id === goalRow.id)!;
  assert.equal(done.status, "completed");
  const goalWork = agent.getConversationGoals().workService.getWork(g.goal.id)!;
  assert.equal(goalWork.closureConclusion, "succeeded");
  assert.equal(goalWork.closureSummary, "内部核对：第二批原始文件支持结论。");
  const accepted = dotsGoalConclusion(db.connection, goalTask, goalRow.id)?.completion;
  assert(accepted);
  assert.equal(accepted.text, conclusion);
  assert.equal(accepted.intentRevision, goalWork.intentRevision);
  assert.equal(accepted.stateVersion, goalWork.stateVersion);
  assert.equal(accepted.native.callId, "goal-close");
  assert.equal(accepted.registrations.length, 1);
  assert.equal(accepted.registrations[0].digest, createHash("sha256").update(acceptedFileBody).digest("hex"));
  const verifiedEvidence = agent.getConversationGoals().workService.repo.listEvidence(g.goal.id);
  assert(verifiedEvidence.some(e => e.provenance === "system" && e.kind === "tool_receipt" && e.detail === "周一批次累计 18 件"));
  assert(!verifiedEvidence.some(e => e.kind === "user_attestation"));
  assert(!agent.getConversationRuntimeSnapshot(goalTask).interactions.some(i => i.kind === "confirm"));
  const [conversationId] = JSON.parse(await agent.dotsInputVersion(goalTask)) as [ConversationId, number];
  const location = db.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").get(goalTask) as { directory: string };
  const storage = await openDurablePassiveStorage(location.directory, BACKGROUND_CONTEXT);
  assert(storage);
  try {
    const currentInput = await storage.submissionByRequest(conversationId, goalRow.id, BACKGROUND_CONTEXT);
    const previousInput = await storage.submissionByRequest(conversationId, goalRows[0].id, BACKGROUND_CONTEXT);
    assert(currentInput?.type === "input" && currentInput.entry && currentInput.answer);
    assert(previousInput?.type === "input" && previousInput.entry && previousInput.answer);
    assert.equal(accepted.native.conversationId, conversationId);
    assert.equal(accepted.native.submissionId, currentInput.id);
    assert.equal(accepted.native.entryId, currentInput.entry);
    const observation = accepted.observations[0];
    const nativeEntry = Number(observation.sourceRef.split(":").at(-1));
    const evidenceEntry = (await storage.entry(nativeEntry as typeof currentInput.entry, BACKGROUND_CONTEXT))?.entry;
    const tool = evidenceEntry?.model?.find(message => message.role === "toolResult");
    assert(tool?.role === "toolResult");
    assert.deepEqual(observation.executionReceipt, readNativeExecutionReceipt(tool.details));
    assert.equal(observation.executionReceipt?.callId, "goal-repeat-read");
    assert.equal(observation.executionReceipt?.fileRead?.target, join(folder, "第二批.txt"));
    const text = tool.content.find(block => block.type === "text");
    assert(text?.type === "text");
    assert.equal(observation.readVersion?.outputHash, createHash("sha256").update("text\0").update(text.text).update("\0").digest("hex"));
    assert.equal(observation.readVersion?.outputHash, observation.executionReceipt?.fileRead?.outputHash);
    const source = { actor: "main" as const, taskId: goalTask, conversationId: String(conversationId),
      entry: currentInput.answer, trigger: currentInput.answer, input: currentInput.entry, at: done.updatedAt };
    const outcome = sourceWorkOutcome(db.connection, source, goalRow.id);
    assert(outcome && "closure" in outcome && outcome.closure?.closure_conclusion === "succeeded");
    assert(outcome.evidence?.some(item => (item as {evidence_id:string}).evidence_id === verifiedEvidence[0].evidenceId));
    assert.deepEqual("completion" in outcome ? outcome.completion : undefined, accepted);
    const wrongInput = sourceWorkOutcome(db.connection, { ...source, input: previousInput.entry }, goalRow.id);
    assert(wrongInput && "closure" in wrongInput && !wrongInput.closure);
    const old = sourceWorkOutcome(db.connection, {
      ...source, entry: previousInput.answer, trigger: previousInput.answer, input: previousInput.entry,
    }, goalRows[0].id);
    assert(old && "closure" in old && !old.closure && old.evidence?.length === 0);
    assert.equal(sourceWorkOutcome(db.connection, { ...source, taskId: rejectTask }, goalRow.id), null);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  const decision = await actions.followup(done);
  assert.equal(decision.kind, "deliver");
  assert.equal(decision.text, conclusion);
  assert.deepEqual(decision.completion, accepted);
  const goalReplyDeadline = Date.now() + 20000;
  let linkedConclusion;
  while (Date.now() < goalReplyDeadline) {
    const transcript = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    linkedConclusion = transcript.messages.find(
      (m) =>
        m.role === "assistant" && m.dotsDelivery?.operationId === goalRow.id && m.dotsDelivery.kind === "conclusion",
    );
    if (linkedConclusion) break;
    await delay(80);
  }
  assert.equal(linkedConclusion?.dotsDelivery?.sourceMessageId, "source-6", "最终 Goal 结论实际回到最初交办的那一轮");
  assert.equal(linkedConclusion?.text, conclusion);
  assert.deepEqual(linkedConclusion?.dotsDelivery?.citations ?? [], []);
  assert.deepEqual(linkedConclusion?.dotsDelivery?.completion, { id: accepted.id, workId: accepted.workId,
    intentRevision: accepted.intentRevision, stateVersion: accepted.stateVersion });
  assert.deepEqual(linkedConclusion?.dotsDelivery?.artifacts, accepted.artifacts);
  assert.deepEqual(accepted.artifacts.map(file => file.name), [goalFile]);
  assert.equal(readFileSync(accepted.artifacts[0].saved!.snapshotPath, "utf8"), acceptedFileBody);
  assert.equal(readFileSync(join(folder, goalFile), "utf8"), newFileBody);
  for (let attempt = 0; !recoveredGoalAck && attempt < 100; attempt++) await delay(50);
  assert(recoveredGoalAck, "同一交付重放读取原生回执");
  const afterReplay = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
  assert.equal(afterReplay.messages.filter(message => message.dotsDelivery?.deliveryKey === lostGoalAck).length, 1);
  const goalActivity = () => new DotsActivity(db.connection, () => true).list().find(item => item.taskId === goalTask);
  const assertGoalActivity = () => {
    const item = goalActivity();
    assert.equal(item?.state, "delivered");
    assert.equal(item.deliveryKey, linkedConclusion?.dotsDelivery?.deliveryKey);
    assert.equal(item.updatedAt, linkedConclusion?.createdAt);
    assert.equal(item.fileCount, 1);
  };
  assertGoalActivity();
  db.connection.prepare(`UPDATE dots_reply_events SET snapshot=json_remove(snapshot,'$.deliveryKey')
    WHERE operation_id=? AND json_valid(snapshot) AND json_extract(snapshot,'$.delivered')='conclusion'`).run(done.id);
  await journal.recover(request => agent.prompt(request, { durableAdmissionOnly: true }), () => true);
  assertGoalActivity();
  const rollback = new Error("roll back revision fixture");
  assert.throws(db.connection.transaction(() => {
    db.connection.prepare("UPDATE works SET state_version=state_version+1 WHERE work_id=?").run(accepted.workId);
    assert.deepEqual(dotsGoalConclusion(db.connection, goalTask, goalRow.id)?.completion, accepted);
    db.connection.prepare("UPDATE works SET intent_revision=intent_revision+1 WHERE work_id=?").run(accepted.workId);
    assert.equal(dotsGoalConclusion(db.connection, goalTask, goalRow.id), undefined);
    throw rollback;
  }), error => error === rollback);
  await journal.drain();
  const completedSearch = await actions.execute(DOTS_TASK_ID, undefined, {
    action: "deliveries", targetTaskId: goalTask, query: "东区批次已核对",
  });
  assert(completedSearch && "results" in completedSearch && completedSearch.results?.some(hit =>
    "operationId" in hit && hit.operationId === goalRow.id && hit.status === "completed" && hit.text === conclusion));
  console.log("PASS Goal 中断后关联补回，最终回复依据已达成的 Goal");
  phase = "first";
  heldSource = "source-8";
  await send(goal, { action: "delegate", spaceId: space.id, name: "停止测试", text: goal });
  const controlDeadline = Date.now() + 20000;
  while (!resumeRelay && Date.now() < controlDeadline) await delay(60);
  assert(resumeRelay, "冻结已完成原任务、尚未执行下一步的时刻");
  await send("停止此空间的全部事项", { action: "stop_all", spaceId: space.id });
  heldSource = undefined;
  resumeRelay();
  await journal.drain();
  const halted = journal.list(["source-8"]);
  assert.equal(halted.length, 1);
  const controls = db.connection
    .prepare("SELECT state FROM dots_target_controls WHERE task_id=?")
    .get(halted[0].taskId) as { state: string };
  assert.equal(controls.state, "stopped");
  const afterStop = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
  assert(!afterStop.messages.some((m) => m.dotsDelivery?.sourceMessageId === "source-8"));
  console.log("PASS 批停覆盖已结束但续办事件尚未消费的普通任务");
  phase = "refused";
  await send("校验新仓储批次", { action: "delegate", spaceId: space.id, name: "校验拒绝测试", text: "校验新仓储批次" });
  const rejectedHistory = await messageContains("仓储端已拒绝此次校验");
  const failedReply = rejectedHistory.find((m) => m.dotsDelivery?.sourceMessageId === "source-10");
  assert.equal(failedReply?.dotsDelivery?.kind, "question");
  assert(!failedReply?.text.includes("invalid_request_error"));
  assert(!failedReply?.text.includes("尝试补救"));
  assert.equal(journal.list(["source-10"]).length, 1);
  console.log("PASS 不可恢复 HTTP 400 直接返回可读原因和单项问题，不重复请求");
  async function reviewGoal(finalStatus: "completed" | "failed") {
    const reviewTask = "ordinary-explicit-goal-" + finalStatus;
    const source = `source-${turn + 1}`;
    db.upsertTask({ id: reviewTask, title: "采购说明", spaceId: space.id, updatedAt: Date.now() });
    const review = agent.createConversationGoal({taskId: reviewTask, title:"采购说明",
      criteria:[{text:"交付采购说明纯文字正文，包含包装及标签要求"}]});
    assert(review.ok);
    phase = "goal-user";
    reviewFinalStatus = finalStatus;
    const acceptance = "结项由我亲自验收";
    await send("请在原任务为 Goal 写完采购说明，只回说明正文这一段，" + acceptance +
      "。只告诉 Dots：私事识别短语-761\n\n" + sourceExcerpts, {
      action: "delegate", targetTaskId: reviewTask, goalId: review.goal.id,
      text: "为 Goal 写完采购说明\n\n" + sourceExcerpts, deliveryInstruction: "只回说明正文这一段", goalUserAcceptanceQuote: acceptance,
    });
    await messageContains("确认完成 Work「采购说明」", source);
    const confirmation = journal.list([source]).find(row => row.interactionId);
    assert(confirmation?.interactionId);
    const reviews = agent.getConversationRuntimeSnapshot(reviewTask).interactions.filter(i => i.kind === "confirm");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].status, "pending");
    const works = agent.getConversationGoals().workService;
    assert.equal(works.getWork(review.goal.id)?.lifecycle, "active");
    if (finalStatus === "completed") pendingConclusionSource = source;
    await send("确认", { action: "answer", targetTaskId: reviewTask, operationId: confirmation.id, interactionId: confirmation.interactionId });
    const reviewedDeadline = Date.now() + 20000;
    let returned;
    while (!returned && Date.now() < reviewedDeadline) {
      const transcript = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
      returned = transcript.messages.find(m => m.dotsDelivery?.sourceMessageId === source && m.dotsDelivery.kind === "conclusion");
      if (!returned) await delay(80);
    }
    assert.equal(returned?.text, approvedDelivery);
    assert.deepEqual(returned?.dotsDelivery?.citations, [
      { url: approvedUrl, excerpt: approvedExcerpt, title: "Approved packaging", kind: "provided" },
    ]);
    assert.equal(pendingConclusionSource, undefined);
    assert.equal(works.getWork(review.goal.id)?.closureConclusion, "succeeded");
    assert(works.repo.listEvidence(review.goal.id).some(e => e.kind === "inspection" && e.detail === writtenResult));
    await journal.drain();
    assert.equal(journal.list([source]).find(row => row.id === confirmation.id)?.status, finalStatus);
    const reviewDeliveries = await actions.execute(DOTS_TASK_ID, undefined, { action: "deliveries", targetTaskId: reviewTask });
    assert(reviewDeliveries && "results" in reviewDeliveries && reviewDeliveries.results?.some(hit =>
      "operationId" in hit && hit.operationId === confirmation.id && hit.status === "completed" && hit.text === approvedDelivery));
    if (finalStatus === "completed") {
      const workerHistory = await agent.loadTaskHistory(reviewTask, undefined, "current");
      assert(workerHistory.messages.some(message => message.role === "assistant" && message.text.startsWith(draftDelivery)));
    }
  }
  await reviewGoal("failed");
  console.log("PASS 明确约定由用户验收只问一次，纯文字成果即可结项并回原对话");
  phase = "partial";
  await send("请完成所有验收栏", { action: "delegate", spaceId: space.id, name: "验收审核", text: "请完成所有验收栏" });
  const attention = await messageContains("原任务没有报告可确认的交付结果或进展。已尝试补救一次。", "source-13");
  const unclassified = attention.filter(m => m.dotsDelivery?.sourceMessageId === "source-13");
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0].dotsDelivery?.kind, "question");
  assert(!unclassified[0].text.includes(partial));
  assert.equal(journal.list(["source-13"]).length, 2);
  console.log("PASS 未声明结果的自然语言停顿未当成结论，安全补报一次后回到原交办提问");
  phase = "files";
  const onlyFile = "完成后只给「第二批.txt」。";
  await send(onlyFile, { action: "delegate", spaceId: space.id, name: "第二批文件", text: onlyFile, deliveryInstruction: onlyFile });
  const fileDeadline = Date.now() + 20000;
  let fileReply;
  while (Date.now() < fileDeadline) {
    const transcript = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    fileReply = transcript.messages.find(m => m.dotsDelivery?.sourceMessageId === "source-14");
    if (fileReply) break;
    await delay(80);
  }
  assert.equal(fileReply?.dotsDelivery?.kind, "conclusion");
  assert.equal(fileReply?.text, "");
  assert.deepEqual(fileReply?.dotsDelivery?.artifacts.map(file => file.name), ["第二批.txt"]);
  assert.equal(readFileSync(fileReply!.dotsDelivery!.artifacts[0].saved!.snapshotPath, "utf8"), "周一批次累计 18 件");
  assert.equal(readFileSync(join(folder, "工作底稿.txt"), "utf8"), executionNotes);
  console.log("PASS 仅交付文件的原对话消息只有对应版本附件");
  phase = "running";
  const runningRequest = "核对周一批次的原始记录，再核对另一批的原始记录";
  await send(runningRequest, { action: "delegate", spaceId: space.id, name: "两批核对", text: runningRequest });
  const [runningJob] = journal.list(["source-15"]);
  journal.refresh(runningJob.taskId);
  await journal.drain();
  const intermediate = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
  assert(!intermediate.messages.some(m => m.dotsDelivery?.sourceMessageId === "source-15"));
  await releaseRunningWorker();
  const liveMessages = await messageContains(runningMilestone, "source-15");
  const liveReply = liveMessages.find(m => m.dotsDelivery?.sourceMessageId === "source-15");
  assert.equal(liveReply?.dotsDelivery?.kind, "progress");
  assert.equal(journal.list(["source-15"])[0].status, "running");
  assert.equal(journal.list(["source-15"]).length, 1);
  await releaseRunningWorker();
  const completeMessages = await messageContains("两份记录均已核对，各为 18 件。", "source-15");
  assert(completeMessages.some(m => m.dotsDelivery?.sourceMessageId === "source-15" && m.dotsDelivery.kind === "conclusion"));
  assert.equal(journal.list(["source-15"]).length, 1);
  const workerHistory = await agent.loadTaskHistory(runningJob.taskId, undefined, "current");
  assert(workerHistory.messages.some(m => m.dotsWorkerProgress && m.text === runningMilestone));
  assert(workerHistory.messages.some(m => m.finalAssistantReply && m.text === "两份记录均已核对，各为 18 件。"));
  assert(!workerHistory.messages.some(m => m.text.includes('"dotsState"')));
  const nativeOutcome = await agent.dotsSubmission(runningJob.taskId, runningJob.id);
  assert.equal(nativeOutcome?.text, JSON.stringify({ dotsState: "complete", result: "两份记录均已核对，各为 18 件。" }));
  console.log("PASS 原生工具调用期间只回传声明的实质进展，在同一轮结束后单独交付结论");
  await journal.drain();
  for (const [id, text, expected] of [
    ["local-closed-assignment-question", "已交付后只解释原因", "沿用已交付结果，只回答本轮的问题。"],
    ["remote-user-closed-assignment-question", "已交付后只解释原因", "沿用已交付结果，只回答本轮的问题。"],
    ["local-closed-assignment-recheck", "明确要求复验已交付的文件", "复验已读取第二批原始记录。"],
  ]) {
    const submission = await agent.prompt({ taskId: runningJob.taskId, spaceId: space.id,
      userMessageId: id, assistantMessageId: `${id}-answer`, text }, { durableAdmissionOnly: true });
    assert(submission.receipt);
    await agent.waitForSubmission(submission.receipt);
    assert.equal((await agent.loadTaskHistory(runningJob.taskId, undefined, "current")).messages.at(-1)?.text, expected);
  }
  console.log("PASS 已交付的交办在普通续聊中只作为历史，明确要求复验仍实际执行");
  phase = "done";
  const literal = await agent.prompt({ taskId: runningJob.taskId, spaceId: space.id,
    userMessageId: "ordinary-json-example", assistantMessageId: "ordinary-json-answer",
    text: "请给出 JSON 对象示例原文。" }, { durableAdmissionOnly: true });
  assert(literal.receipt);
  await agent.waitForSubmission(literal.receipt);
  const manualWorkerHistory = await agent.loadTaskHistory(runningJob.taskId, undefined, "current");
  assert.equal(manualWorkerHistory.messages.at(-1)?.text, JSON.stringify({ dotsState: "complete", result: conclusion }));
  console.log("PASS 同一普通任务中的直接用户请求仍原样显示结构相同的 JSON");
  const continued = await agent.prompt({ taskId: runningJob.taskId, spaceId: space.id,
    userMessageId: "ordinary-layout-report", assistantMessageId: "ordinary-layout-answer",
    text: "请汇报排版进展。" }, { durableAdmissionOnly: true });
  assert(continued.receipt);
  await agent.waitForSubmission(continued.receipt);
  const expectedReply = `${manualIntro}\n\n${manualResult}`;
  assert.equal((await agent.loadTaskHistory(runningJob.taskId, undefined, "current")).messages.at(-1)?.text, expectedReply);
  await agent.releaseDurableTask(runningJob.taskId);
  assert.equal((await agent.loadTaskHistory(runningJob.taskId)).messages.at(-1)?.text, expectedReply);
  console.log("PASS 曾经委派的任务由用户直接续聊时，还原附在正文尾部的内部回执，关闭后仍可读");
  const requestedJson = await agent.prompt({ taskId: runningJob.taskId, spaceId: space.id,
    userMessageId: "ordinary-layout-json", assistantMessageId: "ordinary-layout-json-answer",
    text: "请汇报排版进展，并给出 JSON 示例原文。" }, { durableAdmissionOnly: true });
  assert(requestedJson.receipt);
  await agent.waitForSubmission(requestedJson.receipt);
  assert.equal((await agent.loadTaskHistory(runningJob.taskId, undefined, "current")).messages.at(-1)?.text, leakedReply);
  console.log("PASS 明确要求 JSON 的直接续聊保留正文和代码块");
  for (const [key, text, expected] of [
    ["fenced", "你把结论再发一遍", manualResult],
    ["bare", "请把结论直接发来", manualResult],
    ["example", "请把结论再发一遍，用 JSON 代码块。", fencedManualEnvelope],
  ]) {
    const submitted = await agent.prompt({ taskId: runningJob.taskId, spaceId: space.id,
      userMessageId: `ordinary-resend-${key}`, assistantMessageId: `ordinary-resend-answer-${key}`, text }, { durableAdmissionOnly: true });
    assert(submitted.receipt);
    await agent.waitForSubmission(submitted.receipt);
    assert.equal((await agent.loadTaskHistory(runningJob.taskId, undefined, "current")).messages.at(-1)?.text, expected, `续聊回复 ${key}`);
    await agent.releaseDurableTask(runningJob.taskId);
    assert.equal((await agent.loadTaskHistory(runningJob.taskId)).messages.at(-1)?.text, expected, `重开回复 ${key}`);
  }
  console.log("PASS 整条回复是内部回执时，只显示正文，明确索要的 JSON 代码块原样保留");
  // The lifecycle callback runs after the Goal settle check is queued, before its timer executes.
  for (const action of ["stop", "pause"] as const) {
    const target = `goal-${action}-after-settle`;
    db.upsertTask({ id: target, title: target, spaceId: space.id, updatedAt: Date.now() });
    const created = agent.createConversationGoal({ taskId: target, title: target, criteria: [{ text: "核对剩余批次" }] });
    assert(created.ok);
    phase = "goal";
    let control: ReturnType<typeof actions.execute> | undefined;
    agent.setTaskLifecycleListener(event => {
      if (event.kind === "completed" && event.taskId === target && !control)
        control = actions.execute(DOTS_TASK_ID, `control-${action}`, { action, targetTaskId: target });
    });
    try {
      await send("核对目标的剩余批次", { action: "delegate", targetTaskId: target, goalId: created.goal.id, text: "核对剩余批次" });
      for (let i = 0; i < 200 && !control; i++) await delay(20);
      assert(control);
      const result = await control;
      assert(typeof result === "object" && result !== null && "control" in result && "dotsState" in result);
      assert.equal(result.control, "idle");
      assert.equal(result.dotsState, action === "stop" ? "stopped" : "paused");
      for (let i = 0; i < 200 && agent.getGoalContinuation(created.goal.id)?.lastCheck?.reason !== "dots_policy"; i++) await delay(20);
      assert.equal(agent.getGoalContinuation(created.goal.id)?.lastCheck?.reason, "dots_policy");
      const history = await agent.loadTaskHistory(target);
      assert.equal(history.durable?.busy, false);
      assert.equal(history.messages.filter(message => message.goalContinuation).length, 0);
    } finally { agent.setTaskLifecycleListener(null); }
  }
  console.log("PASS Dots stop and pause block a Goal check queued by a completed native turn");
  phase = "report-first";
  const reportSource = `source-${turn + 1}`;
  await send(`先核对数量，再汇总采购情况。${reportFormat}`, { action: "delegate", spaceId: space.id, name: "采购报告",
    text: "先核对数量，再汇总采购情况。", steps: ["先核对数量", "再汇总采购情况"], deliveryInstruction: reportFormat });
  const reportMessages = await messageContains("## 复核过程", reportSource);
  const reportDelivery = reportMessages.find(m => m.dotsDelivery?.sourceMessageId === reportSource && m.dotsDelivery.kind === "conclusion");
  assert.equal(reportDelivery?.text, fullReport);
  assert.equal(journal.list([reportSource]).length, 2, "完整报告来自同一任务内自动续办后的交付");
  console.log("PASS 自动续办保留明确交付要求，原对话逐字收到完整 Markdown 报告");
  phase = "missing";
  const missingSource = `source-${turn + 1}`;
  await send("只有读到入库明细.csv 才给一个合计整数。", { action: "delegate", spaceId: space.id,
    name: "入库明细", text: "读取入库明细.csv 并给出合计整数" });
  const waiting = await messageContains("请把入库明细.csv 上传", missingSource);
  const [missing] = journal.list([missingSource]);
  assert.equal(missing.status, "blocked");
  const interim = waiting.find(m => m.dotsDelivery?.sourceMessageId === missingSource);
  assert.equal(interim?.dotsDelivery?.kind, "question");
  assert.equal(interim?.text, "请把入库明细.csv 上传到原空间。");
  assert.equal(waiting.filter(m => m.dotsDelivery?.sourceMessageId === missingSource && m.dotsDelivery.kind === "conclusion").length, 0);
  const waitingTask = await actions.execute(DOTS_TASK_ID, undefined, { action: "task", targetTaskId: missing.taskId });
  assert(waitingTask && "progress" in waitingTask);
  assert.equal(waitingTask.status, "waiting_input");
  assert.equal(waitingTask.progress?.wait?.kind, "input");
  writeFileSync(join(folder, "入库明细.csv"), "数量\n42\n");
  await send("「客户资料」的 入库明细.csv 已补到原空间。接着核对，只回复合计数字。",
    { action: "read_file", spaceId: space.id, path: "入库明细.csv", allowHandoff: true });
  const recovered = await messageContains("42", missingSource);
  const recoveredDelivery = recovered.find(m => m.dotsDelivery?.sourceMessageId === missingSource && m.dotsDelivery.kind === "conclusion");
  assert.equal(recoveredDelivery?.text, "42");
  assert.equal(recoveredDelivery?.dotsDelivery?.taskId, missing.taskId);
  assert.equal(recovered.filter(m => m.dotsDelivery?.sourceMessageId === missingSource && m.dotsDelivery.kind === "conclusion").length, 1);
  console.log("PASS 缺资料的假完成停在等待，用户补齐后原任务继续交付到原对话");
  const blockedReceiptSource = `source-${turn + 1}`;
  await send("只有读到复核明细.csv 才给合计。", { action: "delegate", spaceId: space.id, text: "按复核明细.csv 核对数量" });
  const blockedReceipt = (await messageContains("请把复核明细.csv 上传到原空间。", blockedReceiptSource))
    .find(m => m.dotsDelivery?.sourceMessageId === blockedReceiptSource);
  assert.equal(blockedReceipt?.text, "请把复核明细.csv 上传到原空间。");
  assert.equal(blockedReceipt?.dotsDelivery?.kind, "question");
  assert.equal(journal.list([blockedReceiptSource]).at(-1)?.status, "blocked");
  console.log("PASS 识别说明后带独立交付正文的等待回执，执行记录留在原任务");
  await reviewGoal("completed");
  console.log("PASS Goal 原对话只收到已验收正文对应的引用，回传重试后引用仍一致");
  phase = "files";
  const absentFile = "完成后只给「最终核算.txt」。";
  const absentSource = `source-${turn + 1}`;
  await send(absentFile, { action: "delegate", spaceId: space.id, text: absentFile, deliveryInstruction: absentFile });
  const absent = (await messageContains("缺少唯一可打开的交付文件「最终核算.txt」", absentSource))
    .filter(m => m.dotsDelivery?.sourceMessageId === absentSource);
  assert.deepEqual(absent.map(m => m.dotsDelivery?.kind), ["question"]);
  assert.deepEqual(absent[0].dotsDelivery?.artifacts, []);
  console.log("PASS 用户点名的成果没有保存版本时，原对话不会收到其他文件冒充交付");

  const repairAssignment = "修复导入和导出，并检查中文文件名是否完整。";
  const repairSource = `source-${turn + 1}`;
  await send(repairAssignment, { action: "delegate", spaceId: space.id, text: "修复导入和导出" });
  const repairMessages = (await messageContains(repairedResult, repairSource))
    .filter(m => m.dotsDelivery?.sourceMessageId === repairSource);
  assert.equal(journal.list([repairSource]).length, 2);
  assert.deepEqual(repairMessages.filter(m => m.dotsDelivery?.kind === "conclusion").map(m => m.text), [repairedResult]);

  const planAssignment = "请列出导入故障的修复方案。";
  const planSource = `source-${turn + 1}`;
  await send(planAssignment, { action: "delegate", spaceId: space.id, text: planAssignment });
  const planMessages = await messageContains(planResult, planSource);
  assert(planMessages.some(m => m.dotsDelivery?.sourceMessageId === planSource && m.dotsDelivery.kind === "conclusion"));
  assert.equal(journal.list([planSource]).length, 1);
  console.log("PASS 普通修复任务不能拿草案充当交付，明确只要方案的任务可以直接交付");

  const spoofFolder = join(root, "git-project");
  mkdirSync(spoofFolder);
  execFileSync("git", ["init", "-q"], { cwd: spoofFolder });
  const spoofSpace = db.upsertSpace({ id: "git-project", name: "验收项目", path: spoofFolder });
  const spoofAssignment = "修复导入接口，用 project_verify 运行 test:dots-spoof-proof，并做一次本地提交。";
  const spoofSource = `source-${turn + 1}`;
  await send(spoofAssignment, { action: "delegate", spaceId: spoofSpace.id, text: "修复导入接口" });
  const spoofMessages = (await messageContains("缺少已核实的本地提交", spoofSource))
    .filter(m => m.dotsDelivery?.sourceMessageId === spoofSource);
  assert.equal(journal.list([spoofSource]).length, 2);
  assert(spoofMessages.some(m => m.text.includes("当前版本缺少通过的验收回执：test:dots-spoof-proof")));
  assert(!spoofMessages.some(m => m.dotsDelivery?.kind === "conclusion" || m.text.includes(forgedResult)));
  await journal.drain();
  const spoofTaskId = journal.list([spoofSource])[0].taskId;
  const spoofDelivery = await actions.execute(DOTS_TASK_ID, undefined, { action: "deliveries", targetTaskId: spoofTaskId });
  assert(spoofDelivery && "results" in spoofDelivery && spoofDelivery.results?.length);
  assert(!spoofDelivery.results.some(item => item.text.includes(forgedResult)));
  const spoofActivity = new DotsActivity(db.connection, () => true).list().find(item => item.taskId === spoofTaskId);
  assert.equal(spoofActivity?.state, "undelivered");
  assert(spoofActivity?.summary.includes("缺少已核实的本地提交"));
  console.log("PASS 普通交办只接受宿主原生回执，续办一轮后仍缺回执时如实回报");

  assert(dotsProgressInScope(["优化系统性能"], "排查性能瓶颈"));
  assert(!dotsProgressInScope(["优化系统性能"], "检查性能并发布到外部", "优化系统性能"));
  assert.deepEqual(dotsCompletionRequirements(
    "在「交付验收」空间，根据 units.txt 产出并交付「alpha.txt」和「beta.txt」。不要交付草稿.txt。"
  ).files, ["alpha.txt", "beta.txt"]);
  assert.deepEqual(dotsCompletionRequirements("", "只给 alpha.txt 和 beta.txt。").files, ["alpha.txt", "beta.txt"]);
} catch (error) {
  console.error("Dots followup verification failed", error);
  for (const j of journal.list())
    for (const i of agent.getConversationRuntimeSnapshot(j.taskId).interactions)
      if (i.status === "pending") agent.respondConversationInteraction(i.id, "测试结束");
  throw error;
} finally {
  runningGate?.();
  heldSource = undefined;
  resumeRelay?.();
  await actions.closeFileWatches();
  journal.close();
  await journal.drain();
  await fixture.close();
  db.close();
}
