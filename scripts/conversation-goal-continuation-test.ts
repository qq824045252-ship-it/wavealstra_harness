import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Host-side Goal continuation (B layer).
 *
 * The provider boundary is deterministic; admission, native storage, settlements,
 * projections, the Work authority and the continuation ledger are all real. Each
 * phase drives the actual settle hook and asserts what the host did next: ignite,
 * cap, budget, stall, pause/resume, explicit continue and restart reconciliation.
 */

const root = mkdtempSync(join(tmpdir(), "mybuddy-conversation-goal-continuation-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const markerPath = join(root, "continuation-marker.txt");
writeFileSync(markerPath, "marker used only to prove a continuation ran a tool call\n");

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");

const db = new AppDatabase(join(root, "app.db"));
for (const id of ["goal-cap", "goal-budget", "goal-stall", "goal-pause", "goal-abort"]) {
  db.upsertTask({ id, title: id, updatedAt: 1, welcomeMode: "coding" });
}

/** "tools" proves observable action; "talk" is a text-only run for the stall detector. */
let responseMode: "tools" | "talk" | "ask" = "tools";
let toolCallId = 0;

const messageText = (message: TranscriptContext["messages"][number]): string => typeof message.content === "string"
  ? message.content
  : message.content.filter(part => part.type === "text").map(part => part.text).join("");

const lastUserText = (input: TranscriptContext): string => {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message.role !== "user") continue;
    return messageText(message);
  }
  return "";
};

const fixture = await createAgentDurableFixture(root, db, input => {
  const lastMessage = input.messages.at(-1);
  if (lastMessage?.role === "toolResult") return [{ type: "text", text: "工具结果已读，继续推进。" }];
  if (responseMode === "talk") return [{ type: "text", text: "我只汇报了计划，没有执行动作。" }];
  if (responseMode === "ask" && lastUserText(input).includes("宿主自动续跑")) {
    return [{ type: "toolCall", id: `goal-ask-${++toolCallId}`, name: "request_user_input",
      arguments: { title: "需要用户确认才能继续", kind: "confirm" } }];
  }
  if (lastUserText(input).includes("宿主自动续跑")) {
    return [{ type: "toolCall", id: `goal-read-${++toolCallId}`, name: "read", arguments: { path: markerPath } }];
  }
  return [{ type: "text", text: "第一轮已收到。" }];
});
const { agent, requests } = fixture;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}
async function waitForIdle(taskId: string): Promise<void> {
  await waitFor(`${taskId} 空闲`, async () => {
    const history = await agent.loadTaskHistory(taskId);
    return !history.durable?.busy && (history.durable?.queued ?? 0) === 0;
  });
}

const continuationOf = (goalId: string) => {
  const continuation = agent.getGoalContinuation(goalId);
  assert(continuation, `Goal ${goalId} 应存在续跑账本`);
  return continuation;
};
const goalOf = (taskId: string) => {
  const goal = agent.getConversationRuntimeSnapshot(taskId).activeGoal;
  assert(goal, `Task ${taskId} 应有活跃 Goal`);
  return goal;
};
const lastPrompt = () => requests.at(-1)?.instructions ?? "";

try {
  // ---------------------------------------------------------------- attempt cap
  await agent.updateAppSettings({ conversationGoalMaxAttempts: 2, conversationGoalTokenBudget: null,
    conversationGoalContinuationEnabled: true });
  const created = agent.createConversationGoal({
    taskId: "goal-cap", title: "验证自动续跑上限",
    criteria: [{ text: "证据 A" }, { text: "证据 B" }],
  });
  assert(created.ok, "创建 Goal 应成功");
  const capGoalId = created.goal.id;
  assert.equal(continuationOf(capGoalId).attempts, 0, "创建时账本应为 0 次");

  await fixture.prompt({ taskId: "goal-cap", text: "开始推进", userMessageId: "cap-user-1", assistantMessageId: "cap-assistant-1" });
  await waitFor("宿主提交第一次续跑输入", () => requests.some(request => lastUserText(request.input).includes("（宿主自动续跑 #1/2）")));
  assert.equal(continuationOf(capGoalId).attempts, 1, "第一次点火只计一次");
  const firstContinuationRequest = requests.find(request => lastUserText(request.input).includes("（宿主自动续跑 #1/2）"));
  assert(firstContinuationRequest, "宿主应真实提交续跑输入");
  assert(firstContinuationRequest.instructions.includes("## 对话 Goal"), "续跑请求仍必须携带 Goal 契约");
  assert(firstContinuationRequest.instructions.includes("不要以「完成 / 已交付 / 需要你确认 / 你先看看」"),
    "续跑请求必须保留提前收尾禁令");
  assert(firstContinuationRequest.input.messages.some(message => message.role === "user"
    && messageText(message).includes("宿主自动续跑")),
    "续跑文本必须是模型可见的宿主输入，而不是普通用户气泡");

  const historyAfterIgnition = await agent.loadTaskHistory("goal-cap");
  const continuationRows = historyAfterIgnition.messages.filter(message => message.goalContinuation);
  assert.equal(continuationRows.length, 1, "历史应有一条宿主续跑标记");
  assert.equal(continuationRows[0]!.goalContinuation!.attempt, 1);
  assert.equal(continuationRows[0]!.goalContinuation!.intentRevision, 1);
  assert.equal(continuationRows[0]!.text, "Goal 自动续跑 #1/2", "历史正文用短标签，不伪装成用户原话");

  await waitFor("第二次点火在上一轮结束后发生", () => continuationOf(capGoalId).attempts >= 2);
  await waitFor("轮次用尽后写入 exhausted", () => continuationOf(capGoalId).state === "exhausted");
  const capped = continuationOf(capGoalId);
  assert.equal(capped.attempts, 2);
  assert.equal(capped.deferReason, "attempts", "轮次用尽的停止原因必须可读");
  const requestCountAfterCap = requests.length;
  await sleep(700);
  assert.equal(requests.length, requestCountAfterCap, "exhausted 后宿主不得继续点火");

  // ---------------------------------------------------------------- explicit continue
  await waitForIdle("goal-cap");
  const resumed = agent.resumeGoalContinuation(capGoalId);
  assert(resumed.ok, `继续应成功：${resumed.ok ? "" : resumed.message}`);
  await waitFor("继续后产生新的模型请求", () => requests.length > requestCountAfterCap);
  assert.equal(continuationOf(capGoalId).attempts >= 1, true, "继续后必须重新点火");
  assertGreater(requests.length, requestCountAfterCap, "继续后应有新的模型请求");
  await waitFor("继续后的轮次再次用尽", () => continuationOf(capGoalId).state === "exhausted" && continuationOf(capGoalId).attempts === 2);

  // ---------------------------------------------------------------- token budget
  await agent.updateAppSettings({ conversationGoalMaxAttempts: 3 });
  responseMode = "tools";
  const budgetGoal = agent.createConversationGoal({
    taskId: "goal-budget", title: "验证 token 预算",
    criteria: [{ text: "预算内完成" }],
  });
  assert(budgetGoal.ok);
  assert(agent.updateConversationGoal({ goalId: budgetGoal.goal.id, tokenBudget: 3 }).ok, "设置预算应成功");
  await fixture.prompt({ taskId: "goal-budget", text: "开始推进", userMessageId: "budget-user-1", assistantMessageId: "budget-assistant-1" });
  await waitFor("预算用尽停止", () => continuationOf(budgetGoal.goal.id).state === "exhausted");
  const budgeted = continuationOf(budgetGoal.goal.id);
  assert.equal(budgeted.deferReason, "budget");
  assert(budgeted.tokensUsed >= 3, `预算命中时 tokensUsed=${budgeted.tokensUsed} 应不小于预算`);
  assert.equal(budgeted.attempts, 1, "预算在第一次续跑后命中，不应再点火第二次");

  await waitForIdle("goal-budget");
  const budgetResumed = agent.resumeGoalContinuation(budgetGoal.goal.id);
  assert(budgetResumed.ok);
  await waitFor("继续重新开一个预算窗口", () => continuationOf(budgetGoal.goal.id).attempts >= 1);
  await waitFor("新预算窗口再次命中", () => continuationOf(budgetGoal.goal.id).state === "exhausted");
  assert.equal(continuationOf(budgetGoal.goal.id).attempts, 1, "新窗口从 1 重新计");

  // ---------------------------------------------------------------- no progress
  responseMode = "talk";
  const stallGoal = agent.createConversationGoal({
    taskId: "goal-stall", title: "验证无进展停止", criteria: [{ text: "真正完成" }],
  });
  assert(stallGoal.ok);
  await fixture.prompt({ taskId: "goal-stall", text: "开始推进", userMessageId: "stall-user-1", assistantMessageId: "stall-assistant-1" });
  await waitFor("第一次续跑", () => continuationOf(stallGoal.goal.id).attempts >= 1);
  await waitFor("连续两轮无进展后停止", () => continuationOf(stallGoal.goal.id).state === "deferred");
  const stalled = continuationOf(stallGoal.goal.id);
  assert.equal(stalled.deferReason, "no_progress");
  assert.equal(stalled.attempts, 2);
  const requestsBeforeStall = requests.length;
  await sleep(700);
  assert.equal(requests.length, requestsBeforeStall, "no_progress 后宿主必须停止");

  // ---------------------------------------------------------------- user input clears the stop
  await fixture.prompt({ taskId: "goal-stall", text: "补充信息，继续", userMessageId: "stall-user-2", assistantMessageId: "stall-assistant-2" });
  await waitFor("用户消息清除 no_progress 后产生新的续跑请求", () => requests.length > requestsBeforeStall + 1);
  assertGreater(requests.length, requestsBeforeStall, "用户消息后必须重新点火");
  await waitFor("轮次上限最终生效", () => continuationOf(stallGoal.goal.id).state === "exhausted");
  assert.equal(continuationOf(stallGoal.goal.id).deferReason, "attempts");

  // ---------------------------------------------------------------- pause / resume
  await agent.updateAppSettings({ conversationGoalMaxAttempts: 3 });
  responseMode = "talk";
  const pauseGoal = agent.createConversationGoal({
    taskId: "goal-pause", title: "验证暂停", criteria: [{ text: "暂停期间不推进" }],
  });
  assert(pauseGoal.ok);
  assert(agent.updateConversationGoal({ goalId: pauseGoal.goal.id, status: "paused" }).ok, "暂停应成功");
  const pauseRequestsBefore = requests.length;
  await fixture.prompt({ taskId: "goal-pause", text: "先做点别的", userMessageId: "pause-user-1", assistantMessageId: "pause-assistant-1" });
  await sleep(900);
  assert.equal(continuationOf(pauseGoal.goal.id).attempts, 0, "暂停的 Goal 不得点火");
  assert.equal(requests.length, pauseRequestsBefore + 1, "暂停时只应有用户自己的那一轮");

  assert(agent.updateConversationGoal({ goalId: pauseGoal.goal.id, status: "active" }).ok, "恢复应成功");
  await waitFor("恢复后自动续跑", () => continuationOf(pauseGoal.goal.id).attempts >= 1);
  await waitFor("恢复后的无进展停止", () => continuationOf(pauseGoal.goal.id).state === "deferred");
  assert.equal(continuationOf(pauseGoal.goal.id).deferReason, "no_progress");

  // ---------------------------------------------------------------- aborted run
  await agent.updateAppSettings({ conversationGoalMaxAttempts: 3 });
  responseMode = "ask";
  const abortGoal = agent.createConversationGoal({
    taskId: "goal-abort", title: "验证中断", criteria: [{ text: "需要用户输入" }],
  });
  assert(abortGoal.ok);
  await fixture.prompt({ taskId: "goal-abort", text: "开始推进", userMessageId: "abort-user-1", assistantMessageId: "abort-assistant-1" });
  await waitFor("续跑进入等待用户输入", () => agent.getConversationRuntimeSnapshot("goal-abort")
    .interactions.some(interaction => interaction.status === "pending"));
  await agent.abort("goal-abort");
  await waitFor("用户中断写入 deferral", () => continuationOf(abortGoal.goal.id).state === "deferred");
  assert.equal(continuationOf(abortGoal.goal.id).deferReason, "user_interrupt");
  const requestsAtAbort = requests.length;
  await sleep(700);
  assert.equal(requests.length, requestsAtAbort, "中断后宿主不得自行续跑");

  // ---------------------------------------------------------------- restart reconciliation
  db.connection.prepare("UPDATE conversation_goal_continuations SET state='igniting' WHERE work_id=?").run(capGoalId);
  await agent.resumePersistedTasks();
  await waitFor("重启把在途点火改为可见 debt", () => continuationOf(capGoalId).state === "deferred");
  assert.equal(continuationOf(capGoalId).deferReason, "restart");

  // The chip DTO and prompt projection must carry the same facts the ledger gates on.
  assert.equal(goalOf("goal-cap").continuation?.state, "deferred");
  assert.equal(goalOf("goal-cap").continuation?.deferReason, "restart");
  const { renderConversationGoalSection } = await import("../src/main/agent/ConversationGoalPrompt");
  const exhaustedGoal = goalOf("goal-stall");
  assert.equal(exhaustedGoal.continuation?.state, "exhausted");
  assert(renderConversationGoalSection(exhaustedGoal)?.includes("宿主自动续跑已停止（自动轮次用尽）"),
    "exhausted 状态必须进入下一轮提示词，告诉模型不会再有自动轮次");
  assert(!renderConversationGoalSection(goalOf("goal-cap"))?.includes("宿主自动续跑已停止"),
    "deferred(restart) 不是预算/轮次用尽，不应声明续跑已停止");

  console.log("PASS Goal continuation ignites, caps, budgets, detects stalls, honors pause/resume, user input and restart");
} finally {
  await fixture.close();
  db.close?.();
}

function assertGreater(actual: number, minimum: number, message: string): void {
  assert(actual > minimum, `${message}（实际 ${actual}，期望 > ${minimum}）`);
}
