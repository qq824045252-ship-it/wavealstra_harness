import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRequestDiagnostic } from "../src/shared/task-diagnostics";

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
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
mkdirSync(join(root, ".mybuddy", "agents"), { recursive: true });
writeFileSync(join(root, ".mybuddy", "agents", "worker.md"), "---\nname: worker\ndescription: fixture child\ntools: read, write\n---\nReturn the observed scope.\n");
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const markerPath = join(root, "continuation-marker.txt");
writeFileSync(markerPath, "marker used only to prove a continuation ran a tool call\n");

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const { SavedArtifactActions } = await import("../src/main/artifact/SavedArtifactActions");
const { ConversationGoalActivity } = await import("../src/main/agent/ConversationGoalActivity");
const savedFiles = new SavedArtifactActions({
  storageRoot: join(root, ".mybuddy"), exportRoot: join(root, "exports"),
  chooseDestination: async () => undefined, openPath: async () => "",
});

const db = new AppDatabase(join(root, "app.db"));
for (const id of ["goal-cap", "goal-budget", "goal-stall", "goal-pause", "goal-abort", "goal-lineage", "goal-skill"]) {
  db.upsertTask({ id, title: id, updatedAt: 1, welcomeMode: "coding" });
}

/** "tools" proves observable action; "talk" is a text-only run for the stall detector. */
let responseMode: "tools" | "talk" | "ask" = "tools";
let toolCallId = 0;
let authoredSkillPath: string | undefined;

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
  if (getCurrentSystemPrompt(input.messages).includes("No-Skill Gate")) {
    return [{ type: "text", text: JSON.stringify({ decision: "create", reason: "Repeatable fixture check", warnings: [],
      draft: { name: "Goal Evidence Fixture", description: "Check the Goal evidence fixture.",
        instructions: "Workflow\n1. Inspect the fixture.\n2. Report the observed status.\nOutput Contract\nReturn the check result.",
        triggerExamples: ["verify the fixture"], nonTriggerExamples: ["explain the app"] } }) }];
  }
  const lastMessage = input.messages.at(-1);
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === "write" && lastMessage.toolCallId === "lineage-write")
    return [{ type: "toolCall", id: "lineage-register", name: "register_artifact", arguments: { path: "goal-output.txt" } }];
  if (lastMessage?.role === "toolResult") return [{ type: "text", text: "工具结果已读，继续推进。" }];
  if (lastUserText(input) === "lineage-child") return [{ type: "toolCall", id: "lineage-subagent", name: "subagent",
    arguments: { agent: "worker", task: "lineage-owned-child", model: "inherit-parent", isolation: "shared" } }];
  if (lastUserText(input) === "lineage-ask") return [{ type: "toolCall", id: "lineage-ask-user", name: "request_user_input",
    arguments: { title: "lineage confirm", kind: "confirm" } }];
  if (lastUserText(input) === "lineage-file") return [{ type: "toolCall", id: "lineage-write", name: "write",
    arguments: { path: "goal-output.txt", content: "Goal A deliverable\n" } }];
  if (lastUserText(input) === "lineage-file-second") return [{ type: "toolCall", id: "lineage-write-second", name: "write",
    arguments: { path: "goal-output.txt", content: "Goal A second version\n" } }];
  if (lastUserText(input) === "lineage-file-restored") return [{ type: "toolCall", id: "lineage-write-restored", name: "write",
    arguments: { path: "goal-output.txt", content: "Goal A deliverable\n" } }];
  if (lastUserText(input) === "lineage-powershell") return [{ type: "toolCall", id: "lineage-powershell-write", name: "powershell",
    arguments: { command: "Add-Content -LiteralPath '发送记录.txt' -Value 'AUTHORIZED-V2'" } }];
  if (lastUserText(input) === "lineage-compound") return [{ type: "toolCall", id: "lineage-powershell-compound", name: "powershell",
    arguments: { command: "Add-Content -LiteralPath '未归属.txt' -Value 'neighbour'; Set-Content -LiteralPath '另一文件.txt' -Value 'also neighbour'" } }];
  if (lastUserText(input).includes("lineage-owned-child")) return [{ type: "toolCall", id: "lineage-child-write", name: "write",
    arguments: { path: "goal-child.txt", content: "Goal child deliverable\n" } }];
  if (lastUserText(input) === "goal-author-skill") return [{ type: "toolCall", id: "goal-author", name: "skill_authoring_create",
    arguments: { intent: "Create a reusable method to check the Goal evidence fixture." } }];
  if (lastUserText(input) === "goal-reuse-skill" && authoredSkillPath) return [{ type: "toolCall", id: "goal-reuse", name: "read",
    arguments: { path: authoredSkillPath } }];

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
  const autoHistory = await agent.loadTaskHistory("goal-cap");
  const lastAutoInput = autoHistory.messages.findLastIndex(message => message.goalContinuation);
  const autoReply = autoHistory.messages.slice(lastAutoInput + 1).findLast(message => message.finalAssistantReply);
  assert(lastAutoInput >= 0 && autoReply?.entryId && autoHistory.durable?.historyId);
  for (const source of [autoHistory.messages[lastAutoInput], autoReply]) {
    const result = await agent.createConversationGoal({ taskId: "goal-cap", title: "", sourceMessage: {
      messageId: source.id, entryId: source.entryId, historyId: autoHistory.durable.historyId,
    } });
    assert(!result.ok && result.code === "invalid_request", "自动续跑输入和回复不能成为新目标来源");
  }
  assert.equal(capped.lastCheck?.trigger, "settled");
  assert.equal(capped.lastCheck?.reason, "attempts");
  assert.equal(typeof capped.lastStoppedAt, "number");
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
  await waitFor("手动点火后的结算检查", () => continuationOf(budgetGoal.goal.id).lastCheck?.trigger === "settled");
  const afterManualWake = continuationOf(budgetGoal.goal.id);
  assert.equal(afterManualWake.lastWake?.trigger, "continued");
  assert.equal(afterManualWake.lastCheck?.trigger, "settled");
  assert.equal(afterManualWake.deferReason, "budget");

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
  const lastCheckBeforeRestart = continuationOf(capGoalId).lastCheck;
  assert(lastCheckBeforeRestart, "重启前必须有可回读的续跑检查");
  db.connection.prepare("UPDATE conversation_goal_continuations SET state='igniting' WHERE work_id=?").run(capGoalId);
  await agent.resumePersistedTasks();
  await waitFor("重启把在途点火改为可见 debt", () => continuationOf(capGoalId).state === "deferred");
  assert.equal(continuationOf(capGoalId).deferReason, "restart");
  const { GoalContinuationStore } = await import("../src/main/agent/work/GoalContinuationStore");
  const reopenedLedger = new GoalContinuationStore(db.connection);
  assert.deepEqual(reopenedLedger.lastCheck(reopenedLedger.get(capGoalId)!), lastCheckBeforeRestart,
    "检查读取来自持久账本，重启停止原因应独立保留");
  const reopenedBudget = reopenedLedger.get(budgetGoal.goal.id)!;
  assert.equal(reopenedLedger.lastWake(reopenedBudget)?.trigger, "continued");
  assert.equal(reopenedLedger.lastCheck(reopenedBudget)?.trigger, "settled");

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

  // Two Goals in one real Durable chat. Start an input while A owns the run,
  // end A while its tool awaits the user, and settle it after B exists.
  await agent.updateAppSettings({ conversationGoalContinuationEnabled: false });
  responseMode = "talk";
  const lineageTask = "goal-lineage";
  const send = (text: string, id: string) => fixture.prompt({
    taskId: lineageTask, text, userMessageId: `lineage-user-${id}`, assistantMessageId: `lineage-assistant-${id}`,
  });
  const originalText = "Preserve the exact original text.\n\n  Keep the second line.";
  await send(originalText, "source-a");
  await send("Second source message", "source-b");
  const sourceHistory = await agent.loadTaskHistory(lineageTask);
  const userRows = sourceHistory.messages.filter(message => message.role === "user");
  const [sourceA, sourceB] = userRows;
  assert(sourceA && sourceB);
  const sourceRef = (item: typeof sourceA) => ({ messageId: item.id, entryId: item.entryId, historyId: sourceHistory.durable?.historyId });
  assert.equal((await agent.createConversationGoal({ taskId: "goal-cap", title: "forged", sourceMessage: sourceRef(sourceA) })).ok, false);
  const goalA = await agent.createConversationGoal({ taskId: lineageTask, title: "Goal A", sourceMessage: sourceRef(sourceA) });
  assert(goalA.ok);
  assert.equal(goalA.goal.source?.text, originalText);
  assert.equal(goalA.goal.source?.conversationId, sourceHistory.durable?.conversationId);
  assert.equal((await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.activity?.runs.length, 0);

  await send("lineage-child", "child");
  await waitFor("Goal A contains the real child generation", async () => Boolean(
    (await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.activity?.runs.some(run => run.child?.role === "worker" && run.parent),
  ));
  const observedA = (await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.activity;
  const aChild = observedA?.runs.find(run => run.child);
  assert(aChild?.parent);
  assert.equal(aChild.returned?.status, "completed");
  assert(observedA);
  assert.equal(observedA.costBySource.main.knownCostUsd, null, "no configured price leaves main cost unknown");
  assert.equal(observedA.costBySource.child.knownCostUsd, null, "no configured price leaves child cost unknown");
  assert(observedA.costBySource.main.missingGenerationObservations > 0 && observedA.costBySource.child.missingGenerationObservations > 0,
    "the in-process provider fixture has no native HTTP request diagnostics");
  const main = observedA.runs.find(run => !run.child)!;
  const diagnostic = (id: string, run: typeof main, amount: number | null): ModelRequestDiagnostic => ({
    id, taskId: run.taskId, executionScope: run.taskId, conversationId: run.conversationId, generationTaskId: run.generationTaskId,
    executionId: id, sourceKind: run.child ? "subagent" : "main", provider: "controlled", model: "fixture",
    startedAt: 1, firstResponseAt: 2, finishedAt: 3, modelMs: 2, status: "completed", outcome: "stop", error: null,
    usage: { input: 100, output: 14, cacheRead: 20, cacheWrite: null }, usageSource: "chat-completions",
    knownCostUsd: amount, costComplete: amount != null, costSource: amount != null ? "pi-native" : null,
    attempts: [], cacheContext: { previousRequestId: null, prefixStable: false, changedFields: [], coverage: "fixture" },
  });
  const priced = new ConversationGoalActivity(db.connection).read(goalA.goal.id, () => [
    diagnostic("main-currency", main, 0.125),
    diagnostic("child-currency", aChild, 0.25),
    diagnostic("child-missing", aChild, null),
    { ...diagnostic("other-conversation", main, 99), conversationId: "unrelated" },
  ], () => []);
  assert.equal(priced.knownCostUsd, 0.375);
  assert.equal(priced.costBySource.main.knownCostUsd, 0.125);
  assert.equal(priced.costBySource.child.knownCostUsd, 0.25);
  assert.equal(priced.costBySource.child.requestsWithCost, 1);
  assert.equal(priced.costBySource.child.observedRequests, 2);
  await send("lineage-file", "file");
  const goalArtifact = (await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.activity?.nativeEvidence
    ?.find(row => row.kind === "delivery" && row.path?.endsWith("goal-output.txt"));
  assert(goalArtifact?.kind === "delivery", requests.at(-1)?.input.messages.slice(-4).map(messageText).join("\n"));
  assert.equal(goalArtifact.digest, createHash("sha256").update("Goal A deliverable\n").digest("hex"));
  const readVersion = (artifactId: string) => agent.readGoalArtifactText(lineageTask, goalA.goal.id, artifactId, request => savedFiles.readText(request));
  const confirmVersion = (artifactId: string) => agent.verifyGoalArtifact(lineageTask, goalA.goal.id, artifactId, request => savedFiles.verifiedSnapshot(request));
  const files = async () => (await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.savedArtifacts ?? [];
  const firstVersion = (await files()).find(item => item.path.endsWith("goal-output.txt"));
  assert(firstVersion);
  assert.equal(firstVersion.version, 1);
  assert.equal(firstVersion.verification, undefined, "registered SHA is not user verification");
  assert.equal(await readVersion(firstVersion.id), "Goal A deliverable\n");
  const firstVerification = await confirmVersion(firstVersion.id);
  assert.equal(firstVerification?.verification?.kind, "user");
  await send("lineage-file-second", "file-second");
  await agent.releaseDurableTask(lineageTask);
  const reopened = await files();
  const versions = reopened.filter(item => item.path.endsWith("goal-output.txt"));
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map(item => item.version), [2, 1]);
  assert.equal(await readVersion(versions[0]!.id), "Goal A second version\n");
  assert.equal(await readVersion(firstVersion.id), "Goal A deliverable\n");
  assert.equal(versions[0]!.verification, undefined, "new file bytes do not inherit the previous version's verification");
  assert.deepEqual(versions[1]!.verification, firstVerification?.verification);
  const childFile = reopened.find(item => item.path.endsWith("goal-child.txt"));
  assert(childFile, "child file must be available from Goal A after release");
  assert.equal(await readVersion(childFile.id), "Goal child deliverable\n");
  await send("lineage-file-restored", "file-restored");
  const restored = (await files()).filter(item => item.path.endsWith("goal-output.txt"));
  assert.equal(restored.length, 2);
  assert.equal(restored[0]?.id, firstVersion.id, "A → B → A makes A latest without inventing a new immutable identity");
  assert.deepEqual(restored.map(item => item.version), [1, 2], "latest is independent of the first-registration number");
  assert.deepEqual(restored[0]?.verification, firstVerification?.verification);
  assert.equal(restored[1]?.verification, undefined);
  if (process.platform === "win32") {
    await send("lineage-powershell", "powershell");
    const receipt = (await files()).find(item => item.path.endsWith("发送记录.txt"));
    assert(receipt, "a successful native literal Add-Content records its actual saved output");
    assert.equal((await readVersion(receipt.id))?.trim(), "AUTHORIZED-V2");
    await send("lineage-compound", "powershell-compound");
    assert.equal(readFileSync(join(dirname(receipt.path), "未归属.txt"), "utf8").trim(), "neighbour");
    assert(!(await files()).some(item => item.path.endsWith("未归属.txt")), "compound commands do not establish individual file ownership");
  }

  const pending = await agent.prompt({ taskId: lineageTask, text: "lineage-ask", userMessageId: "lineage-user-late",
    assistantMessageId: "lineage-assistant-late", modelId: "fixture/model" });
  assert(pending.receipt);
  await waitFor("Goal A waits for confirmation", () => agent.getConversationRuntimeSnapshot(lineageTask).interactions.some(item => item.status === "pending"));
  const wait = agent.getConversationRuntimeSnapshot(lineageTask).interactions.find(item => item.status === "pending");
  assert(wait);
  assert(agent.cancelConversationGoal(goalA.goal.id, lineageTask).ok);
  const goalB = await agent.createConversationGoal({ taskId: lineageTask, title: "Goal B", sourceMessage: sourceRef(sourceB) });
  assert(goalB.ok);
  await agent.abort(lineageTask);
  assert.equal((await agent.submissionStatus(pending.receipt)).receipt?.status, "unanswered");
  await waitForIdle(lineageTask);
  let a = (await agent.getConversationGoalEvidence(lineageTask, goalA.goal.id))?.activity;
  let b = (await agent.getConversationGoalEvidence(lineageTask, goalB.goal.id))?.activity;
  assert(a && b);
  assert(a.runs.length >= 3, "A retains its own late settlement");
  assert.equal(b.runs.length, 0, "B inherits no generation from A or earlier conversation turns");
  assert.deepEqual(b.nativeEvidence, [], "B does not inherit A's registered file");
  assert.equal(await agent.verifyGoalArtifact(lineageTask, goalB.goal.id, firstVersion.id, request => savedFiles.verifiedSnapshot(request)), undefined);
  assert.equal(await agent.readGoalArtifactText("goal-cap", goalA.goal.id, firstVersion.id, request => savedFiles.readText(request)), undefined);
  assert.equal(b.knownCostUsd, null, "an empty goal has unknown cost");
  await send("Work on B", "b");
  b = (await agent.getConversationGoalEvidence(lineageTask, goalB.goal.id))?.activity;
  assert(b?.runs.length);
  for (const run of b.runs) assert(!a.runs.some(old => old.generationTaskId === run.generationTaskId && old.conversationId === run.conversationId));
  assert.equal(await agent.getConversationGoalEvidence("goal-cap", goalB.goal.id), undefined);
  assert.deepEqual(agent.getConversationRuntimeSnapshot(lineageTask).goals?.map(item => item.id), [goalB.goal.id, goalA.goal.id]);
  console.log("PASS Goal lineage isolates primary, child and late terminal generations across two Goals in one Durable chat");

  const skillGoal = await agent.createConversationGoal({ taskId: "goal-skill", title: "Create a reusable check" });
  assert(skillGoal.ok);
  await fixture.prompt({ taskId: "goal-skill", text: "goal-author-skill", userMessageId: "goal-skill-user", assistantMessageId: "goal-skill-answer" });
  authoredSkillPath = agent.listSkills().find(skill => skill.id === "goal-evidence-fixture")?.filePath;
  assert(authoredSkillPath, "the native authoring tool created and installed an actual package");
  const skillEvidence = async () => (await agent.getConversationGoalEvidence("goal-skill", skillGoal.goal.id))?.activity?.skills
    .find(skill => skill.skillId === "goal-evidence-fixture");
  const initialSkillEvidence = await skillEvidence();
  assert(initialSkillEvidence?.creationToolCallId, "the creation receipt is linked to the Goal generation");
  assert.equal(initialSkillEvidence.installedVersion, "1.0.0");
  assert.equal(initialSkillEvidence.scopeType, "global");
  assert.equal(initialSkillEvidence.laterInvokedAt, undefined);
  const skillActivity = (await agent.getConversationGoalEvidence("goal-skill", skillGoal.goal.id))?.activity;
  assert(skillActivity?.costBySource.auxiliary.missingGenerationObservations, "real skill authoring has a linked auxiliary scope even when fixtures emit no HTTP diagnostics");
  const authoringScope = db.connection.prepare("SELECT execution_scope FROM conversation_goal_auxiliary_scopes WHERE task_id=?")
    .get("goal-skill") as { execution_scope: string };
  assert.match(authoringScope.execution_scope, /^authoring:authoring:/);
  const skillRun = skillActivity.runs[0]!;
  const auxiliary = (scope: string, amount: number): ModelRequestDiagnostic => ({
    ...diagnostic(scope, skillRun, amount), sourceKind: "auxiliary", executionScope: scope, costSource: "provider-reported",
  });
  const pricedSkill = new ConversationGoalActivity(db.connection).read(skillGoal.goal.id, () => [], () => [], () => [
    auxiliary(authoringScope.execution_scope, 0.025), auxiliary("authoring:unlinked", 99),
  ]);
  assert.equal(pricedSkill.knownCostUsd, 0.025);
  assert.equal(pricedSkill.costBySource.auxiliary.providerReportedRequests, 1);
  assert.equal(pricedSkill.unattributedAuxiliaryRequests, 1, "unowned task auxiliary costs stay outside the Goal");
  assert(agent.updateConversationGoal({ goalId: skillGoal.goal.id, status: "achieved" }).ok, "complete the Goal before later reuse");
  await fixture.prompt({ taskId: "goal-skill", text: "goal-reuse-skill", userMessageId: "goal-reuse-user", assistantMessageId: "goal-reuse-answer" });
  assert.equal(typeof (await skillEvidence())?.laterInvokedAt, "number", "a later real skill read is attached to the matching installed content");
  console.log("PASS completed Goal skill shows native creation, scope, installed revision and the later real read");

  console.log("PASS Goal continuation ignites, caps, budgets, detects stalls, honors pause/resume, user input and restart");
} finally {
  await fixture.close();
  db.close?.();
}

function assertGreater(actual: number, minimum: number, message: string): void {
  assert(actual > minimum, `${message}（实际 ${actual}，期望 > ${minimum}）`);
}
