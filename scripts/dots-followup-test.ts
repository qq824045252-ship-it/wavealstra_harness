import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DOTS_TASK_ID } from "../src/shared/dots";
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
const db = new AppDatabase(join(root, "app.db"));
const domain = createArtifactDomain(db.connection);
db.openDots();
const folder = join(root, "customer");
mkdirSync(folder);
writeFileSync(join(folder, "到货记录.txt"), "批次累计 18 件");
writeFileSync(join(folder, "第二批.txt"), "周一批次累计 18 件");
const space = db.upsertSpace({ id: "customer", name: "客户资料", path: folder });
let nextCall: Record<string, unknown> | undefined;
let phase: "first" | "question" | "done" | "event" | "empty" | "goal" | "goal-complete" | "goal-user" | "refused" = "first";
let workerTurns = 0;
const goal = "核对到货数，确认批次后汇总，不要发送邮件";
const baseline = "已核对到货数为 18 件。";
const question = "这一批到货应归入哪个批次？";
const writtenResult = "采购说明正文：使用无塑纸封套，标签注明内部资料。";
const conclusion = "东区批次已核对，合计到货 18 件。";
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
          arguments: { title: question, kind: "short_text" },
        },
      ];
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
        phase = "done";
        return [{ type: "text", text: conclusion }];
      }
      if (lastTool.toolName === "conversation_goal_propose_complete" && lastTool.isError) {
        if (lastTool.toolCallId === "goal-self-claim") {
          assert(JSON.stringify(lastTool.content).includes("可交付内容"));
        } else {
          assert(JSON.stringify(lastTool.content).includes("未在本次交办"));
          if (lastTool.toolCallId !== "goal-echo")
            return [{ type: "toolCall", id: "goal-read", name: "read", arguments: { path: "第二批.txt" } }];
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
      return [{
        type: "toolCall", id: lastTool.toolName === "read" ? "goal-close" : "goal-no-evidence",
        name: "conversation_goal_propose_complete", arguments: {
          ...details.versionGuard, summary: "内部核对：第二批原始文件支持结论。", deliveryText: conclusion,
          observations: [{ criterionId, toolCallId: "goal-read", quote: "周一批次累计 18 件" }],
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
          ...details.versionGuard, summary: "实际撰写并逐项核对采购说明。", deliveryText: writtenResult,
          observations: [{ criterionId: details.goal.criteria[0].id, quote: writtenResult }],
        } }];
      }
      assert.equal(lastTool.toolName, "conversation_goal_propose_complete");
      assert(!lastTool.isError, JSON.stringify(lastTool.content));
      assert.equal((lastTool.details as any).confirmed, true);
      return [{ type: "text", text: "已完成审核，内部留档。\n\n" + writtenResult }];
    }
    if (phase === "event") return [{ type: "text", text: "已读取交付触发信号，批次已登记。" }];
    if (phase === "empty") return [{ type: "text", text: "" }];
    return [{ type: "text", text: conclusion }];
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
  });
let actions = makeActions();
agent.setDotsActions(actions);
let heldSource: string | undefined;
let resumeRelay: (() => void) | undefined;
journal.connect(
  async (job, req) => {
    if (job.sourceMessageId === heldSource && job.status === "completed")
      await new Promise<void>((resolve) => {
        resumeRelay = resolve;
      });
    return actions.followup(job, req);
  },
  (reply, current) => agent.appendDotsReply(reply, current),
);
agent.onPatch((patch) => {
  const state =
    patch.type === "durable_snapshot" ? patch.snapshot : patch.type === "durable_delta" ? patch.delta.state : undefined;
  if (
    "taskId" in patch &&
    (patch.type === "conversation_interaction_snapshot" ||
      state?.status === "waiting_input" ||
      (state && !state.busy && !state.queued))
  )
    journal.refresh(patch.taskId);
});
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
async function messageContains(text: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const history = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    if (history.messages.some((m) => m.role === "assistant" && m.text.includes(text))) return history.messages;
    await delay(80);
  }
  throw Error(
    "原 Dots 对话缺少可见回复 " +
      text +
      "; deliveries=" +
      JSON.stringify(journal.list().map((j) => [j.status, j.text])),
  );
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
  await send("东区", {
    action: "answer",
    targetTaskId: rows[1].taskId,
    operationId: rows[1].id,
    interactionId: rows[1].interactionId,
  });
  await messageContains(conclusion);
  for (let i = 0; i < 3; i++) journal.refresh(rows[0].taskId);
  await journal.drain();
  assert.equal(journal.list(["source-1"]).length, 2);
  const final = await messageContains(conclusion);
  const delivered = final.find((m) => m.dotsDelivery?.kind === "conclusion")?.dotsDelivery?.artifacts;
  assert.deepEqual(delivered, files, "最终结论与阶段问题都指向同一版本，不重复附加");
  assert.equal(final.filter((m) => m.role === "assistant" && m.text.includes(conclusion)).length, 1);
  console.log("PASS 原对话收到一次文字结论", conclusion);
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
  phase = "goal";
  dropGoalLink = true;
  await send("在已有目标上继续核对", {
    action: "delegate",
    targetTaskId: goalTask,
    goalId: g.goal.id,
    text: "在已有目标上继续核对。候选是周一批次累计 18 件，请读取原始文件独立核对。",
  });
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
    const source = { actor: "main" as const, taskId: goalTask, conversationId: String(conversationId),
      entry: currentInput.answer, trigger: currentInput.answer, input: currentInput.entry, at: done.updatedAt };
    const outcome = sourceWorkOutcome(db.connection, source, goalRow.id);
    assert(outcome && "closure" in outcome && outcome.closure?.closure_conclusion === "succeeded");
    assert(outcome.evidence?.some(item => (item as {evidence_id:string}).evidence_id === verifiedEvidence[0].evidenceId));
    const old = sourceWorkOutcome(db.connection, {
      ...source, entry: previousInput.answer, trigger: previousInput.answer, input: previousInput.entry,
    }, goalRows[0].id);
    assert(old && "closure" in old && !old.closure && old.evidence?.length === 0);
    assert.equal(sourceWorkOutcome(db.connection, { ...source, taskId: rejectTask }, goalRow.id), null);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  assert.deepEqual(await actions.followup(done), { kind: "deliver", text: conclusion });
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
  assert.deepEqual(linkedConclusion?.dotsDelivery?.artifacts, [], "另一项 Goal 的纯文字结论不得混入第一项的文件");
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
  const reviewTask = "ordinary-explicit-goal";
  db.upsertTask({ id: reviewTask, title: "采购说明", spaceId: space.id, updatedAt: Date.now() });
  const review = agent.createConversationGoal({taskId: reviewTask, title:"采购说明",
    criteria:[{text:"交付采购说明纯文字正文，包含包装及标签要求"}]});
  assert(review.ok);
  phase = "goal-user";
  const acceptance = "结项由我亲自验收";
  await send("请在原任务为 Goal 写完采购说明，只回说明正文这一段，" + acceptance + "。只告诉 Dots：私事识别短语-761", {
    action: "delegate", targetTaskId: reviewTask, goalId: review.goal.id,
    text: "为 Goal 写完采购说明", deliveryInstruction: "只回说明正文这一段", goalUserAcceptanceQuote: acceptance,
  });
  await messageContains("确认完成 Work「采购说明」");
  const confirmation = journal.list(["source-11"]).find(row => row.interactionId);
  assert(confirmation?.interactionId);
  const reviews = agent.getConversationRuntimeSnapshot(reviewTask).interactions.filter(i => i.kind === "confirm");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, "pending");
  const works = agent.getConversationGoals().workService;
  assert.equal(works.getWork(review.goal.id)?.lifecycle, "active");
  await send("确认", { action: "answer", targetTaskId: reviewTask, operationId: confirmation.id, interactionId: confirmation.interactionId });
  const reviewedDeadline = Date.now() + 20000;
  while (Date.now() < reviewedDeadline) {
    const transcript = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    if (transcript.messages.some(m=>m.dotsDelivery?.sourceMessageId === "source-11" && m.dotsDelivery.kind === "conclusion"
      && m.text === writtenResult)) break;
    await delay(80);
  }
  const reviewedHistory = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
  assert(reviewedHistory.messages.some(m=>m.dotsDelivery?.sourceMessageId === "source-11" && m.dotsDelivery.kind === "conclusion"
    && m.text === writtenResult));
  assert.equal(works.getWork(review.goal.id)?.closureConclusion, "succeeded");
  assert(works.repo.listEvidence(review.goal.id).some(e => e.kind === "inspection" && e.detail === writtenResult));
  console.log("PASS 明确约定由用户验收只问一次，纯文字成果即可结项并回原对话");
} catch (error) {
  console.error("Dots followup verification failed", error);
  for (const j of journal.list())
    for (const i of agent.getConversationRuntimeSnapshot(j.taskId).interactions)
      if (i.status === "pending") agent.respondConversationInteraction(i.id, "测试结束");
  throw error;
} finally {
  heldSource = undefined;
  resumeRelay?.();
  await actions.closeFileWatches();
  journal.close();
  await journal.drain();
  await fixture.close();
  db.close();
}
