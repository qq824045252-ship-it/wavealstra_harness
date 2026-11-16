import assert from "node:assert/strict";
import type { BotMessageDto, WorkFeedbackDto } from "../src/shared/bot-conversation";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { botTaskReplyAssociations, botTaskReplyFeedbackCurrent, botTaskReplyPresentation } from "../src/renderer/src/lib/botTaskReplyPresentation";
import { botTaskTimeline } from "../src/renderer/src/lib/botWorkspacePresentation";

const makeWork = (overrides: Partial<WorkProjectionDto> = {}): WorkProjectionDto => ({
  workId: "task-a", title: "接入 API", mode: "once", lifecycle: "active", ownerBotId: "bot-a", ownerEpoch: 1,
  intentRevision: 1, sourceVersion: 1, stateVersion: 1, inputSnapshotId: "input-1", inputSnapshotBound: true,
  goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [], blockers: [], executions: [],
  notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [], updatedAt: 1, ...overrides,
});
const summary = (group: NonNullable<WorkProjectionDto["listSummary"]>["status"]["group"], label: string) => ({
  status: { group, label }, excerpt: "", deliverableCount: 0, canArchive: false, executionTaskIds: [], running: group === "running",
});
const binding = (status: WorkProjectionDto["executions"][number]["status"], bindingId = "binding-1"): WorkProjectionDto["executions"][number] => ({
  bindingId, workId: "task-a", operationId: bindingId, botId: "bot-a", taskId: bindingId,
  durableStoreKey: "store", conversationId: "execution-chat", intentRevision: 1, ownerEpoch: 1, inputSnapshotId: "input-1",
  expertSnapshot: { expertId: "expert", revision: "1", version: 1, systemPromptHash: "hash",
    allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 1 },
  delegatedScope: [], workspaceBinding: "/workspace", status, admittedAt: 1,
});
const report = (overrides: Partial<NonNullable<WorkFeedbackDto["report"]>> = {}): NonNullable<WorkFeedbackDto["report"]> => ({
  title: "接入 API", summary: "已经返回的结果", artifactRefs: [], reviewStatus: "proposed", current: true, notices: [], ...overrides,
});
const message = (messageId: string, feedback: Partial<WorkFeedbackDto> = {}, overrides: Partial<BotMessageDto> = {}): BotMessageDto => ({
  messageId, conversationId: "chat-a", botId: "bot-a", requestId: messageId, ordinal: 1, role: "assistant",
  text: messageId, status: "completed", workIds: ["task-a"], createdAt: 1, updatedAt: 1,
  workFeedback: { workId: "task-a", eventId: messageId, kind: "binding", category: "progress",
    intentRevision: 1, inputSnapshotId: "input-1", ...feedback }, ...overrides,
});
let cases = 0;
function check(run: () => void) { run(); cases++; }

check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ listSummary: summary("running", "正在执行") }));
  assert.equal(model.statusLabel, "正在执行");
  assert.equal(model.currentStageId, "execution", "omitted arrays in a list shell do not imply an unstarted task");
  assert.deepEqual(model.stages.map(stage => stage.label), ["任务", "执行", "核对", "结果"]);
  assert.equal(model.stages.find(stage => stage.id === "execution")?.state, "current");
  assert.equal(model.stages.find(stage => stage.id === "result")?.state, "pending");
});
check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ listSummary: summary("results", "正在核对结果") }));
  assert.equal(model.currentStageId, "review");
  assert.equal(model.stages[1].state, "completed");
  assert.equal(model.stages[3].state, "pending", "returned execution results are not goal completion");
});
check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ lifecycle: "closed", closureConclusion: "succeeded",
    closureSummary: "验收通过", listSummary: summary("succeeded", "已完成") }));
  assert.equal(model.currentStageId, "result");
  assert.equal(model.statusLabel, "已完成");
  assert(model.stages.every(stage => stage.state === "completed"));
  assert.equal(model.stages[3].description, "验收通过");
});
check(() => {
  const oldResult = message("old-complete", { kind: "result", report: report({ completion: { nextStep: "deliver", outcome: "completed" } }) });
  for (const conclusion of ["cancelled", "ended_unsuccessfully", undefined] as const) {
    const model = botTaskReplyPresentation("task-a", makeWork({ lifecycle: "closed", closureConclusion: conclusion }), [oldResult]);
    assert.equal(model.currentStageId, "result");
    assert.equal(model.stages[3].state, "ended");
    assert.notEqual(model.statusLabel, "已完成", "an old positive report cannot upgrade a failed, cancelled or unknown closure");
    assert.equal(model.stages[3].messages[0], oldResult);
  }
});
check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ lifecycle: "closed", closureConclusion: "cancelled" }));
  assert.equal(model.stages[1].state, "pending", "cancelling before execution does not complete skipped stages");
  assert.equal(model.stages[2].state, "pending");
});
check(() => {
  const first = message("milestone-first", { eventId: "milestone", report: report({ milestone: true }) });
  const second = message("milestone-second", { eventId: "milestone", report: report({ milestone: true }) });
  const workerResult = message("worker-result", { kind: "result", category: "result", report: report() });
  const model = botTaskReplyPresentation("task-a", undefined, [first, second, workerResult]);
  assert.deepEqual(model.stages[1].messages, [first, second], "all immutable milestone versions remain readable");
  assert.deepEqual(model.stages[2].messages, [workerResult], "a worker report belongs to review");
  assert.equal(model.currentStageId, "review");
  assert.equal(model.stages[3].state, "pending");
});
check(() => {
  const own = message("own");
  const other = message("other", { workId: "task-b" });
  const user = message("user", {}, { role: "user" });
  const running = message("streaming", {}, { status: "running", text: "stream in progress" });
  const failed = message("failed", {}, { status: "failed", error: "delivery interrupted" });
  const model = botTaskReplyPresentation("task-a", undefined, [own, other, user, running, failed]);
  assert.deepEqual(model.stages.flatMap(stage => stage.messages), [own, running, failed]);
  assert.equal(model.stages[1].messages[1], running, "streamed message identity is retained");
});
check(() => {
  const partial = message("partial", { kind: "result", category: "result",
    report: report({ completion: { outcome: "partial", nextStep: "deliver" } }) });
  const model = botTaskReplyPresentation("task-a", undefined, [partial]);
  assert.equal(model.currentStageId, "result");
  assert.equal(model.statusLabel, "部分完成");
  assert.equal(model.stages[3].state, "current");
  assert.equal(model.stages[2].state, "completed", "the review can finish with a partial outcome");
});
check(() => {
  const closed = message("closure", { kind: "closure", category: "result" });
  const model = botTaskReplyPresentation("task-a", undefined, [closed]);
  assert.equal(model.currentStageId, "result");
  assert.equal(model.statusLabel, "已结束");
  assert.equal(model.stages[3].state, "ended", "closure prose alone cannot prove success");
});
check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ workId: "task-b", title: "Another task", lifecycle: "closed", closureConclusion: "succeeded" }));
  assert.equal(model.title, "任务进度");
  assert.equal(model.currentStageId, "execution");
  assert.notEqual(model.statusLabel, "已完成");
});
check(() => {
  const previous = message("previous", { kind: "result", category: "result", report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) });
  for (const work of [makeWork({ intentRevision: 2 }), makeWork({ inputSnapshotId: "input-2" })]) {
    const model = botTaskReplyPresentation("task-a", work, [previous]);
    assert.equal(botTaskReplyFeedbackCurrent(previous.workFeedback!, work), false);
    assert.equal(model.currentStageId, "execution");
    assert.equal(model.stages[3].state, "pending");
    assert.equal(model.stages[3].messages[0], previous, "replanning does not erase old results or count them as current success");
  }
});
check(() => {
  const previous = message("superseded", { kind: "result", report: report({ current: false,
    completion: { outcome: "completed", nextStep: "deliver" } }) });
  const model = botTaskReplyPresentation("task-a", undefined, [previous]);
  assert.equal(model.currentStageId, "execution");
  assert.equal(model.stages[3].messages[0], previous);
});
check(() => {
  const oldResult = message("old-complete", { kind: "result", report: report({ completion: { nextStep: "deliver", outcome: "completed" } }) });
  for (const work of [makeWork({ executions: [binding("running")] }), makeWork({ listSummary: summary("running", "正在执行") })]) {
    const model = botTaskReplyPresentation("task-a", work, [oldResult]);
    assert.equal(model.currentStageId, "execution");
    assert.equal(model.statusLabel, "正在执行");
    assert.equal(model.stages[2].state, "pending", "new execution must not inherit a previous round's completed review marker");
  }
});
check(() => {
  const question = message("answered-question", { kind: "result", report: report({ completion: { nextStep: "ask", outcome: "unknown" } }) });
  const model = botTaskReplyPresentation("task-a", makeWork({ executions: [binding("running")] }), [question]);
  assert.equal(model.statusLabel, "正在执行");
  assert.equal(model.stages[1].state, "current", "resolved questions remain readable without falsely blocking a resumed task");
});
check(() => {
  const old = { ...binding("invalidated", "old"), invalidatedAt: 2 };
  const model = botTaskReplyPresentation("task-a", makeWork({ executions: [old, binding("completed")],
    runtimeObservations: [{ bindingId: "old", state: "running", reason: "stale worker" }] }));
  assert.equal(model.currentStageId, "review");
  assert.equal(model.stages[1].state, "completed");
  assert.equal(model.stages[3].state, "pending");
});
check(() => {
  const oldContinue = message("continue", { kind: "result", report: report({ completion: { nextStep: "continue", outcome: "partial" } }) });
  const model = botTaskReplyPresentation("task-a", makeWork({ executions: [binding("completed")] }), [oldContinue]);
  assert.equal(model.currentStageId, "review", "a finished continuation awaits new review, rather than inheriting old continue text");
});
check(() => {
  const done = message("watch-result", { kind: "result", report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) });
  const watching = botTaskReplyPresentation("task-a", makeWork({ mode: "watch", executions: [binding("completed")] }), [done]);
  assert.equal(watching.currentStageId, "execution");
  assert.equal(watching.statusLabel, "持续跟踪中");
  assert.equal(watching.stages[3].state, "pending", "one watch round does not finish an ongoing task");
  const expired = botTaskReplyPresentation("task-a", makeWork({ mode: "watch", lifecycle: "closed", closureConclusion: "succeeded",
    watchPlan: { termination: { reason: "schedule_expired", scheduledEndsAt: 1, requestedAt: 1, settledAt: 2 } } }));
  assert.equal(expired.statusLabel, "到期结束");
  assert.equal(expired.stages[3].state, "ended");
});
check(() => {
  const paused = botTaskReplyPresentation("task-a", makeWork({ lifecycle: "paused", executions: [binding("running")] }));
  assert.equal(paused.statusLabel, "已暂停");
  assert.equal(paused.stages[1].state, "paused");
  const failed = botTaskReplyPresentation("task-a", makeWork({ executions: [binding("failed")] }));
  assert.equal(failed.stages[1].state, "attention");
  assert.notEqual(failed.statusLabel, "已完成");
});
check(() => {
  const model = botTaskReplyPresentation("task-a", makeWork({ executions: [binding("failed", "previous-attempt"), binding("running")] }));
  assert.equal(model.statusLabel, "正在执行");
  assert.equal(model.stages[1].state, "current", "an earlier failed attempt cannot paint a running retry as blocked");
});
check(() => {
  const result = message("unfinished-delivery", { kind: "result", report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) }, { status: "running" });
  const model = botTaskReplyPresentation("task-a", undefined, [result]);
  assert.equal(model.currentStageId, "result", "an unfinished report is visible in its own phase");
  assert.equal(model.statusLabel, "正在更新进展");
  assert.equal(model.stages[3].state, "current", "streaming result metadata is not completion evidence");
  assert.equal(model.stages[2].state, "pending");
  assert.equal(model.stages[3].messages[0], result);
});
check(() => {
  for (const nextStep of ["deliver", "ask"] as const) {
    const previous = message("previous-attempt-result", { kind: "result", executionId: "attempt-1",
      report: report({ completion: { outcome: "completed", nextStep } }) });
    const next = message("new-attempt-progress", { executionId: "attempt-2" });
    const model = botTaskReplyPresentation("task-a", undefined, [previous, next]);
    assert.equal(model.currentStageId, "execution", "feedback-only history respects later execution attempts sharing the same input");
    assert.equal(model.statusLabel, "执行进展已更新");
    assert.equal(model.stages[1].state, "current");
    assert.equal(model.stages[2].state, "pending");
    assert.equal(model.stages.flatMap(stage => stage.messages).includes(previous), true, "previous conclusions remain readable");
  }
});
check(() => {
  const previous = message("previous", { kind: "result", executionId: "attempt-1",
    report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) });
  const receipt = message("late-receipt", { executionId: "attempt-1" });
  const same = botTaskReplyPresentation("task-a", undefined, [previous, receipt]);
  assert.equal(same.currentStageId, "result", "a late receipt for the exact same execution does not erase its reviewed outcome");
  assert.equal(same.statusLabel, "结果已核对");
  for (const change of [{ executionId: undefined }, { executionId: "attempt-1", intentRevision: 2 }, { executionId: "attempt-1", inputSnapshotId: "input-2" }]) {
    const model = botTaskReplyPresentation("task-a", undefined, [previous, message("later", change)]);
    assert.equal(model.currentStageId, "execution", "missing or changed provenance cannot borrow the older review");
    assert.equal(model.stages[2].state, "pending");
  }
});
check(() => {
  const previous = message("delivered", { kind: "result", executionId: "attempt-1",
    report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) });
  for (const [status, label, state] of [["queued", "等待进展回报", "current"], ["running", "正在更新进展", "current"],
    ["failed", "进展回报失败", "attention"], ["unknown", "进展回报待核对", "attention"], ["cancelled", "进展回报已停止", "attention"]] as const) {
    const pending = message(`pending-${status}`, { executionId: "attempt-2" }, { status });
    const model = botTaskReplyPresentation("task-a", undefined, [previous, pending]);
    assert.equal(model.currentStageId, "execution");
    assert.equal(model.statusLabel, label, "a pending feedback message describes delivery, not the task's outcome");
    assert.equal(model.stages[1].state, state);
    assert.equal(model.stages[2].state, "pending");
    assert.equal(model.stages[3].messages[0], previous);
  }
});
check(() => {
  const closed = message("old-closure", { kind: "closure", category: "result" });
  const next = message("new-pending", { executionId: "next-attempt" }, { status: "running" });
  const model = botTaskReplyPresentation("task-a", undefined, [closed, next]);
  assert.equal(model.currentStageId, "execution");
  assert.equal(model.statusLabel, "正在更新进展");
  assert.equal(model.stages[1].state, "current");
});
check(() => {
  const question = message("input-needed", { kind: "blocker", category: "decision" });
  const model = botTaskReplyPresentation("task-a", undefined, [question]);
  assert.equal(model.statusLabel, "等待补充信息", "host-authored open-input decisions remain visible without a Work summary");
  assert.equal(model.stages[1].state, "attention");
});
check(() => {
  const previous = message("invalidated-result", { kind: "result", executionId: "binding-1",
    report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) });
  for (const invalidated of [{ ...binding("completed"), invalidatedAt: 2 }, binding("invalidated")]) {
    const work = makeWork({ executions: [invalidated], publishedReport: { messageId: previous.messageId, createdAt: 1,
      executionId: "binding-1", intentRevision: 1, inputSnapshotId: "input-1", report: previous.workFeedback!.report! } });
    const model = botTaskReplyPresentation("task-a", work, [previous]);
    assert.equal(botTaskReplyFeedbackCurrent(previous.workFeedback!, work), false);
    assert.equal(model.currentStageId, "execution", "same-input invalidation withdraws completion until replacement execution is admitted");
    assert.notEqual(model.statusLabel, "结果已核对");
    assert.equal(model.stages[2].state, "pending");
    assert.equal(model.stages[3].messages[0], previous, "invalidated results are retained as history");
  }
  const shell = makeWork({ listSummary: summary("waiting", "等待执行") });
  assert.equal(botTaskReplyFeedbackCurrent(previous.workFeedback!, shell), true, "omitted summary arrays cannot prove invalidation");
});
check(() => {
  const work = makeWork({ listSummary: summary("attention", "等待补充信息") });
  const input = [message("a"), message("b", { report: report({ milestone: true }) })];
  const before = JSON.stringify({ work, input });
  const model = botTaskReplyPresentation("task-a", work, input);
  assert.equal(model.stages[1].state, "attention");
  assert.equal(JSON.stringify({ work, input }), before, "presentation must not rewrite durable messages or Work facts");
});

check(() => {
  const original = message("original", {}, { workFeedback: undefined, text: "开始执行。", ordinal: 1 });
  const followup = message("ordinary-followup", {}, { workFeedback: undefined, text: "全部完成并验收通过。", ordinal: 3,
    segments: [{ id: "pre-tool", kind: "commentary", text: "先核对来源。", createdAt: 2, updatedAt: 2 },
      { id: "final", kind: "answer", text: "全部完成并验收通过。", createdAt: 3, updatedAt: 3 }] });
  const rows = botTaskTimeline([original, message("progress", {}, { ordinal: 2 }), followup]);
  assert.equal(rows.length, 1, "ordinary follow-up replies do not create a second outer reply");
  assert.equal(rows[0].messageInTask, true);
  assert.equal(rows[0].tasks[0].messages[0], original, "the original body also belongs inside its task");
  const group = rows[0].tasks[0];
  const model = botTaskReplyPresentation(group.workId, undefined, group.messages, group.messageWorkIds);
  assert.deepEqual(model.stages[1].messages, group.messages);
  assert.equal(model.stages[1].messages[2].segments, followup.segments);
  assert.equal(model.currentStageId, "execution");
  assert.equal(model.stages[3].state, "pending", "ordinary completion prose cannot supply a reviewed outcome");
});
check(() => {
  const source = message("source-reply", {}, { workFeedback: undefined, workIds: [], requestId: "source-request", ordinal: 1 });
  const returned = message("source-return", {}, { workFeedback: undefined, workIds: ["unrelated-navigation"], ordinal: 3,
    text: "源 Bot 对用户的完整回复，不应替换为工作报告。", collaborationResult: { workId: "task-a", eventId: "returned-result",
      kind: "result", category: "result", report: report({ completion: { outcome: "completed", nextStep: "deliver" } }) },
    peerOrigin: { kind: "return", collaborationId: "collaboration", exchangeId: "return", replyMessageId: "peer-result",
      senderBotId: "worker", senderDisplayName: "工作 Bot", sourceBotId: "bot-a", sourceConversationId: "chat-a",
      sourceRequestId: "source-request", sourceUserMessageId: "source-user", sourceAssistantMessageId: source.messageId } });
  const before = JSON.stringify([source, returned]);
  const rows = botTaskTimeline([source, returned]);
  assert.equal(rows.length, 1, "typed returns find their original reply before its Work links arrive");
  assert.equal(rows[0].message, source);
  assert.equal(rows[0].messageInTask, true);
  assert.deepEqual(rows[0].tasks[0].messages, [source, returned]);
  const model = botTaskReplyPresentation("task-a", undefined, rows[0].tasks[0].messages, rows[0].tasks[0].messageWorkIds);
  assert.deepEqual(model.stages[1].messages, [source]);
  assert.deepEqual(model.stages[3].messages, [returned]);
  assert.equal(model.currentStageId, "result");
  assert.equal(JSON.stringify([source, returned]), before, "source association does not rewrite host DTOs");
  const wrongScope = { ...returned, peerOrigin: { ...returned.peerOrigin!, sourceConversationId: "another-chat" } };
  assert.equal(botTaskTimeline([source, wrongScope]).length, 2, "return provenance cannot cross conversations");
});
check(() => {
  const source = message("shared-source", {}, { workFeedback: undefined, workIds: [], requestId: "shared-request", ordinal: 1 });
  const returned = (workId: string, ordinal: number): BotMessageDto => message(`return-${workId}`, {}, {
    workFeedback: undefined, workIds: [], ordinal, collaborationResult: { workId, eventId: workId, kind: "result", category: "result" },
    peerOrigin: { kind: "return", collaborationId: workId, exchangeId: workId, replyMessageId: workId,
      senderBotId: "worker", senderDisplayName: "工作 Bot", sourceBotId: "bot-a", sourceConversationId: "chat-a",
      sourceRequestId: source.requestId, sourceUserMessageId: "source-user", sourceAssistantMessageId: source.messageId },
  });
  const a = returned("task-a", 2), b = returned("task-b", 3);
  const rows = botTaskTimeline([source, a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageInTask, false, "a source commissioning several tasks retains its shared prose once");
  assert.deepEqual(rows[0].tasks.map(task => task.messages), [[a], [b]]);
});
check(() => {
  const question = message("linked-user", {}, { role: "user", workFeedback: undefined, workIds: ["task-a"], ordinal: 1 });
  const answer = message("referenced-answer", {}, { workFeedback: undefined, workIds: [], referenceMessageId: question.messageId, ordinal: 2 });
  const followup = message("referenced-chain", {}, { workFeedback: undefined, workIds: [], referenceMessageId: answer.messageId, ordinal: 3,
    status: "running", text: "继续在原任务内回答。" });
  const rows = botTaskTimeline([question, answer, followup]);
  assert.deepEqual(rows.map(row => row.message), [question, answer]);
  const task = rows[1].tasks[0];
  assert.deepEqual(task.messages, [answer, followup]);
  const model = botTaskReplyPresentation(task.workId, undefined, task.messages, task.messageWorkIds);
  assert.deepEqual(model.stages[1].messages, [answer, followup], "an outer referenced user question need not be copied into task content");
  assert.equal(model.currentStageId, "execution");
  assert.equal(model.stages[3].state, "pending");
  const direct = { ...followup, workIds: ["task-b"] };
  assert.equal(botTaskReplyAssociations([question, answer, direct]).owned.get(direct), "task-b", "direct host Work identity precedes references");
});
check(() => {
  const original = message("reference-target", {}, { workFeedback: undefined, workIds: ["task-a", "task-b"] });
  const followup = message("ambiguous-reference", {}, { workFeedback: undefined, workIds: [], referenceMessageId: original.messageId });
  assert.equal(botTaskReplyAssociations([original, followup]).owned.has(followup), false, "references to shared multi-task prose cannot pick a task");
  for (const overrides of [{ botId: "other-bot" }, { conversationId: "other-conversation" }, { teamId: "other-team" }]) {
    const foreign = { ...original, ...overrides, workIds: ["task-a"] };
    assert.equal(botTaskReplyAssociations([foreign, followup]).owned.has(followup), false, "references must match Bot, team and conversation");
  }
  assert.equal(botTaskReplyAssociations([followup]).owned.has(followup), false, "off-window reference identity is not invented");
});
check(() => {
  const a = message("cycle-a", {}, { workFeedback: undefined, workIds: [], referenceMessageId: "cycle-b" });
  const b = message("cycle-b", {}, { workFeedback: undefined, workIds: [], referenceMessageId: "cycle-a" });
  const self = message("self-reference", {}, { workFeedback: undefined, workIds: [], referenceMessageId: "self-reference" });
  const rows = botTaskTimeline([a, b, self]);
  assert.equal(rows.length, 3);
  assert(rows.every(row => !row.tasks.length), "cycles remain visible ordinary messages without fabricated ownership");
});
check(() => {
  const original = message("long-reference-0", {}, { workFeedback: undefined });
  const chain = Array.from({ length: 4000 }, (_, index) => message(`long-reference-${index + 1}`, {}, {
    workFeedback: undefined, workIds: [], referenceMessageId: `long-reference-${index}`, ordinal: index + 2,
  }));
  const rows = botTaskTimeline([original, ...chain]);
  assert.equal(rows.length, 1, "deep explicit reply chains remain a single task without recursive stack overflow");
  assert.equal(rows[0].tasks[0].messages.length, chain.length + 1);
  const reversedOwnership = botTaskReplyAssociations([...chain].reverse().concat(original));
  assert.equal(reversedOwnership.owned.get(chain.at(-1)!), "task-a", "ownership resolution is independent of event arrival order");
});

console.log(`bot task reply presentation: ${cases} behavioral cases passed`);
