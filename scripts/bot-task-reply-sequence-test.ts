import assert from "node:assert/strict";
import type { BotHistoryDto, BotMessageDto, BotMessageEvent, WorkFeedbackDto } from "../src/shared/bot-conversation";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { botTaskTimeline } from "../src/renderer/src/lib/botWorkspacePresentation";
import { botTaskReplyFeedbackCurrent, botTaskReplyPresentation } from "../src/renderer/src/lib/botTaskReplyPresentation";
import { mergeBotHistoryPage, mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";

type Scope = { name: string; botId: string; conversationId: string; teamId?: string };
type Step = { name: string; run: () => void };
const scopes: Scope[] = [
  { name: "personal", botId: "bot-a", conversationId: "chat-a" },
  { name: "other-chat", botId: "bot-a", conversationId: "chat-b" },
  { name: "other-bot", botId: "bot-b", conversationId: "chat-a" },
  { name: "team-a", botId: "bot-a", teamId: "team-a", conversationId: "chat-a" },
  { name: "team-b", botId: "bot-a", teamId: "team-b", conversationId: "chat-a" },
];
const seedOption = process.env.BOT_TASK_REPLY_SEQUENCE_SEED;
const seeds = seedOption === undefined ? [1, 7, 31, 97, 271, 997, 4093, 8191, 65521, 0x51a9c027, 0x9e3779b9, 0xffffffff] : [Number(seedOption)];
assert(seeds.every(seed => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff), "BOT_TASK_REPLY_SEQUENCE_SEED must be a uint32 (decimal or 0x hex)");
let traces = 0;
let observations = 0;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]];
  return items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]));
}
function replay(name: string, seed: number, steps: Step[], inspect: () => void, finish?: () => void): void {
  const trace: string[] = [];
  try {
    inspect(); observations++;
    for (const step of steps) { trace.push(step.name); step.run(); inspect(); observations++; }
    if (finish) { trace.push("final invariants"); finish(); }
    traces++;
  } catch (error) {
    throw new Error(`${name}; seed=${seed}; replay: BOT_TASK_REPLY_SEQUENCE_SEED=${seed}\nsteps=${JSON.stringify(trace)}`, { cause: error });
  }
}
function binding(workId: string, status: WorkProjectionDto["executions"][number]["status"], revision = 2, name = "current"): WorkProjectionDto["executions"][number] {
  return { bindingId: `${workId}-${name}`, workId, operationId: `${workId}-${name}`, botId: "bot-a", taskId: `${workId}-${name}`,
    durableStoreKey: "sequence-store", conversationId: "execution-chat", intentRevision: revision, ownerEpoch: 1,
    inputSnapshotId: `input-${revision}`, expertSnapshot: { expertId: "expert", revision: "1", version: 1, systemPromptHash: "hash",
      allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 1 },
    delegatedScope: [], workspaceBinding: "/sequence-fixture", status, admittedAt: 1 };
}
function work(workId: string, overrides: Partial<WorkProjectionDto> = {}): WorkProjectionDto {
  return freeze<WorkProjectionDto>({ workId, title: "同名任务", mode: "once", lifecycle: "active", ownerBotId: "bot-a", ownerEpoch: 1,
    intentRevision: 2, inputSnapshotId: "input-2", inputSnapshotBound: true, sourceVersion: 2, stateVersion: 2,
    goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [], blockers: [],
    executions: [binding(workId, "running")], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [], updatedAt: 2,
    ...overrides });
}
function feedback(workId: string, revision = 2, overrides: Partial<WorkFeedbackDto> = {}): WorkFeedbackDto {
  return { workId, eventId: `${workId}-progress`, kind: "binding", category: "progress", intentRevision: revision,
    inputSnapshotId: `input-${revision}`, executionId: `${workId}-${revision === 1 ? "old" : "current"}`, ...overrides };
}
function result(workId: string, revision = 2): WorkFeedbackDto {
  return feedback(workId, revision, { eventId: `${workId}-result`, kind: "result", category: "result",
    report: { title: "同名任务", summary: "已完成", artifactRefs: [`/sequence-fixture/${workId}-v${revision}.txt`],
      reviewStatus: "accepted", current: true, notices: [], completion: { outcome: "completed", nextStep: "deliver" } } });
}
function message(scope: Scope, name: string, ordinal: number, overrides: Partial<BotMessageDto> = {}): BotMessageDto {
  return freeze({ botId: scope.botId, teamId: scope.teamId, conversationId: scope.conversationId,
    messageId: `${scope.name}:${name}`, requestId: `${scope.name}:${name}`, ordinal, messageRevision: 1, role: "assistant",
    text: "同名任务，已完成", status: "completed", workIds: [], createdAt: ordinal, updatedAt: ordinal, ...overrides });
}
function history(scope: Scope, messages: BotMessageDto[] = [], revision = 1): BotHistoryDto {
  return { botId: scope.botId, teamId: scope.teamId, conversationId: scope.conversationId, messages, revision, archived: false };
}
function scopeOf(value: { botId: string; teamId?: string; conversationId: string }): string {
  return JSON.stringify([value.botId, value.teamId ?? null, value.conversationId]);
}
function inspectHistory(current: BotHistoryDto, works: ReadonlyMap<string, WorkProjectionDto>): void {
  assert.equal(new Set(current.messages.map(item => item.messageId)).size, current.messages.length, "overlapping reconnect pages must not duplicate durable message identities");
  const before = JSON.stringify(current);
  const rows = botTaskTimeline(freeze(current.messages));
  const groups = rows.flatMap(row => row.tasks.map(task => ({ row, task })));
  assert.equal(new Set(groups.map(({ task }) => task.workId)).size, groups.length, "one task has one panel in its conversation");
  for (const item of current.messages.filter(item => !item.workFeedback)) {
    const attached = groups.filter(({ task }) => task.messages.includes(item));
    if (item.role === "assistant" && item.workIds.length === 1) {
      assert.equal(attached.length, 1, "a same-task foreground reply stays inside its original task container");
      assert.equal(attached[0].task.workId, item.workIds[0]);
      assert(rows.every(row => row.message !== item || row === attached[0].row), "a linked continuation cannot create a second outer reply");
    } else {
      assert.equal(rows.filter(row => row.message === item).length, 1, "questions, unlinked replies and ambiguous multi-task prose remain readable once");
      assert.equal(attached.length, 0, "ambiguous multi-task prose cannot be copied into individual task panels");
    }
  }
  for (const { row, task } of groups) {
    const expected = current.messages.filter(item => item.role === "assistant"
      && (item.workFeedback?.workId === task.workId || !item.workFeedback && item.workIds.length === 1 && item.workIds[0] === task.workId));
    assert.deepEqual(task.messages, expected, "ordinary continuations and every immutable feedback version remain attached exactly once");
    assert.equal(scopeOf(row.message), scopeOf(current));
    for (const item of task.messages) assert.equal(scopeOf(item), scopeOf(current), "feedback must not cross a conversation, Bot or team");
    const anchor = current.messages.find(item => item.role === "assistant" && !item.workFeedback && item.workIds.includes(task.workId));
    if (anchor) assert.equal(row.message, anchor, "older history restores the original reply as the anchor");
    const snapshot = works.get(task.workId);
    assert(snapshot);
    const presentation = botTaskReplyPresentation(task.workId, snapshot, task.messages);
    assert.equal(presentation.currentStageId, "execution");
    assert.equal(presentation.stages[3].state, "pending", "a late old result or one watch round cannot close the current task");
    assert.notEqual(presentation.statusLabel, "已完成");
    for (const item of task.messages.filter(item => item.workFeedback?.intentRevision === 1)) {
      assert.equal(botTaskReplyFeedbackCurrent(item.workFeedback!, snapshot), false, "old input versions stay historical");
    }
  }
  assert.equal(JSON.stringify(current), before, "rendering cannot rewrite persisted messages");
}

for (const seed of seeds) {
  const histories = new Map<string, BotHistoryDto>();
  const works = new Map([
    ["task-a", work("task-a")],
    ["task-b", work("task-b", { mode: "watch", executions: [binding("task-b", "completed")] })],
  ]);
  const steps: Step[] = [];
  for (const scope of scopes) {
    histories.set(scope.name, history(scope));
    const requestId = `${scope.name}:request`;
    const originals = [message(scope, "question", 1, { role: "user", requestId, workIds: ["task-a", "task-b"] }),
      message(scope, "original", 2, { requestId, workIds: ["task-a", "task-b"] }),
      message(scope, "followup-question", 3, { role: "user" }), message(scope, "followup-reply", 4, { workIds: ["task-a"] })];
    const a = message(scope, "a-progress", 5, { workFeedback: feedback("task-a") });
    const b = message(scope, "b-round", 6, { workFeedback: result("task-b") });
    const late = message(scope, "late-old-result", 7, { workFeedback: result("task-a", 1) });
    const next = message(scope, "next-event-version", 8, { workFeedback: feedback("task-a") });
    for (const [name, messages, revision, older] of [
      ["recent-page", [a, b], 2, false], ["old-result-arrives", [late], 3, false],
      ["overlapping-reconnect", [a, b, late], 3, false], ["new-version-same-event", [next], 4, false],
      ["older-original-reply", originals, 1, true], ["duplicate-original-page", originals, 1, true],
    ] as const) {
      steps.push({ name: `${scope.name}:${name}`, run: () => {
        histories.set(scope.name, mergeBotHistoryPage(histories.get(scope.name)!, freeze(history(scope, [...messages], revision)), older));
      } });
    }
  }
  replay("scoped pagination and reconnect", seed, shuffle(steps, seed), () => {
    for (const current of histories.values()) inspectHistory(current, works);
    const rows = botTaskTimeline([...histories.values()].flatMap(item => item.messages));
    const groups = rows.flatMap(row => row.tasks.map(task => ({ row, task })));
    assert.equal(new Set(groups.map(({ task }) => task.key)).size, groups.length, "identical Work IDs in other scopes remain separate");
    for (const { row, task } of groups) for (const item of task.messages) assert.equal(scopeOf(item), scopeOf(row.message));
  }, () => {
    for (const current of histories.values()) {
      assert.equal(current.messages.length, 8);
      assert.equal(botTaskTimeline(current.messages).flatMap(row => row.tasks).length, 2);
      const restored = JSON.parse(JSON.stringify(current)) as BotHistoryDto;
      assert.equal(JSON.stringify(botTaskTimeline(restored.messages)), JSON.stringify(botTaskTimeline(current.messages)),
        "serialized history retains the same task grouping and feedback contents");
    }
  });
}

const scope = scopes[0];
const outcomes: { name: string; snapshot: WorkProjectionDto; stage: string; state: string; label: string }[] = [
  { name: "revised-running", snapshot: work("task-a"), stage: "execution", state: "current", label: "正在执行" },
  { name: "retry-running", snapshot: work("task-a", { executions: [binding("task-a", "failed", 2, "failed-attempt"), binding("task-a", "running")] }), stage: "execution", state: "current", label: "正在执行" },
  { name: "failed", snapshot: work("task-a", { executions: [binding("task-a", "failed")] }), stage: "execution", state: "attention", label: "执行遇到问题" },
  { name: "paused", snapshot: work("task-a", { lifecycle: "paused" }), stage: "execution", state: "paused", label: "已暂停" },
  { name: "cancelled", snapshot: work("task-a", { lifecycle: "closed", closureConclusion: "cancelled", executions: [binding("task-a", "stopped")] }), stage: "result", state: "ended", label: "已取消" },
  { name: "unsuccessful", snapshot: work("task-a", { lifecycle: "closed", closureConclusion: "ended_unsuccessfully", executions: [binding("task-a", "failed")] }), stage: "result", state: "ended", label: "已结束 · 未完成" },
  { name: "watch-round", snapshot: work("task-a", { mode: "watch", executions: [binding("task-a", "completed")] }), stage: "execution", state: "current", label: "持续跟踪中" },
  { name: "watch-expired", snapshot: work("task-a", { mode: "watch", lifecycle: "closed", closureConclusion: "succeeded", executions: [binding("task-a", "completed")],
    watchPlan: { termination: { reason: "schedule_expired", scheduledEndsAt: 1, requestedAt: 1, settledAt: 2 } } }), stage: "result", state: "ended", label: "到期结束" },
  { name: "accepted-success", snapshot: work("task-a", { lifecycle: "closed", closureConclusion: "succeeded", executions: [binding("task-a", "completed")] }), stage: "result", state: "completed", label: "已完成" },
];
const original = message(scope, "original", 1, { workIds: ["task-a"] });
const staleResult = message(scope, "old-success", 2, { workFeedback: result("task-a", 1) });
const currentResult = message(scope, "current-result", 3, { workFeedback: result("task-a") });
const staleFailure = message(scope, "old-failure", 4, { status: "failed", error: "old delivery failed", workFeedback: feedback("task-a", 1) });
const pages = [history(scope, [staleResult], 2), history(scope, [currentResult], 3), history(scope, [staleResult], 2), history(scope, [staleFailure], 4)];
for (const outcome of outcomes) for (const [order, schedule] of permutations(pages).entries()) {
  let current = history(scope, [original]);
  replay(`authoritative outcome ${outcome.name}, permutation=${order}`, seeds[0], schedule.map((page, index) => ({
    name: `${index}:${page.messages[0].messageId}`, run: () => { current = mergeBotHistoryPage(current, freeze(page)); },
  })), () => {
    const task = botTaskTimeline(freeze(current.messages))[0].tasks[0];
    const presentation = botTaskReplyPresentation(task.workId, outcome.snapshot, task.messages);
    assert.equal(presentation.currentStageId, outcome.stage);
    assert.equal(presentation.statusLabel, outcome.label);
    assert.equal(presentation.stages.find(item => item.id === outcome.stage)!.state, outcome.state);
    if (outcome.name !== "accepted-success") assert.notEqual(presentation.stages[3].state, "completed");
    assert.equal(new Set(task.messages.map(item => item.messageId)).size, task.messages.length);
  }, () => {
    const task = botTaskTimeline(current.messages)[0].tasks[0];
    assert.equal(task.messages.length, 4, "reconnect retains the original answer and deduplicates exact messages without dropping older result versions");
    assert(task.messages.includes(original));
    assert(task.messages.includes(staleResult));
    assert(task.messages.includes(currentResult));
  });
}

for (const seed of seeds) {
  const anchor = message(scope, "both-original", 1, { workIds: ["task-a", "task-b"] });
  const a = message(scope, "stream-a", 2, { status: "running", workFeedback: feedback("task-a") });
  const b = message(scope, "stream-b", 3, { status: "running", workFeedback: feedback("task-b") });
  const doneA = freeze({ ...a, messageRevision: 2, status: "completed" as const, workFeedback: result("task-a"), text: "A result" });
  const doneB = freeze({ ...b, messageRevision: 3, status: "completed" as const, workFeedback: result("task-b"), text: "B result" });
  let current = history(scope, [anchor, a, b]);
  const event = (name: string, frame: BotMessageDto, revision: number, extra: Partial<BotMessageEvent> = {}): Step => ({ name, run: () => {
    const incoming = freeze({ botId: scope.botId, conversationId: scope.conversationId, revision, message: frame, ...extra });
    current = mergeBotMessageEvent(current, incoming)!;
  } });
  const steps = [event("B completes first at a higher conversation revision", doneB, 20),
    event("independent A completion arrives later", doneA, 10), event("duplicate B completion", doneB, 20),
    event("stale A frame with a newer conversation clock", a, 30),
    event("wrong conversation frame", { ...doneA, conversationId: "old-chat" }, 40, { conversationId: "old-chat" }),
    event("wrong request frame", { ...doneA, messageRevision: 5, requestId: "unrelated-request" }, 50),
    { name: "reconnect returns an old overlapping page", run: () => { current = mergeBotHistoryPage(current, history(scope, [anchor, a, b], 1)); } },
  ];
  replay("independent streaming revisions", seed, shuffle(steps, seed), () => {
    assert.equal(current.messages.length, 3);
    const tasks = botTaskTimeline(freeze(current.messages))[0].tasks;
    assert.deepEqual(tasks.map(task => task.workId), ["task-a", "task-b"]);
    assert.equal(tasks[0].messages.length, 1); assert.equal(tasks[1].messages.length, 1);
    for (const item of current.messages) {
      assert.equal(item.conversationId, scope.conversationId);
      if (item.messageId === a.messageId && item.status === "completed") assert.equal(item.text, "A result");
      if (item.messageId === b.messageId && item.status === "completed") assert.equal(item.text, "B result");
    }
  }, () => { assert.deepEqual(current.messages, [anchor, doneA, doneB], "both independent completions survive replay"); });
}

// Ordinary foreground replies are the path that used to escape task panels.
// Exercise actual history/event merging with every persisted message status;
// the message's prose must never act as a Work completion decision.
const statuses: BotMessageDto["status"][] = ["queued", "running", "completed", "cancelled", "unknown", "failed"];
for (const status of statuses) for (const seed of seeds) {
  const anchorA = message(scope, "ordinary-original-a", 1, { workIds: ["task-a"], text: "A original" });
  const anchorB = message(scope, "ordinary-original-b", 2, { workIds: ["task-b"], text: "B original" });
  const a = message(scope, "ordinary-followup-a", 3, { workIds: ["task-a", "task-a"], status, text: "A partial",
    segments: [{ id: "a-receipt", kind: "receipt", text: "A accepted", createdAt: 3, updatedAt: 3 },
      { id: "a-answer", kind: "answer", text: "A partial", createdAt: 3, updatedAt: 3 }] });
  const b = message(scope, "ordinary-followup-b", 4, { workIds: ["task-b"], status: "running", text: "B partial" });
  const unrelated = message(scope, "unrelated-answer", 5, { text: "Independent quick answer" });
  const question = message(scope, "ordinary-followup-question", 6, { role: "user", workIds: ["task-a"], text: "Continue A" });
  const ambiguous = message(scope, "both-task-summary", 7, { workIds: ["task-a", "task-b"], text: "A and B summary" });
  const revisedA = freeze<BotMessageDto>({ ...a, messageRevision: 3, text: "A continuation: 已完成", updatedAt: 10,
    error: status === "failed" ? "delivery failed" : undefined,
    segments: [{ id: "a-receipt", kind: "receipt", text: "A accepted", createdAt: 3, updatedAt: 3 },
      { id: "a-commentary", kind: "commentary", text: "A tool round", createdAt: 4, updatedAt: 5 },
      { id: "a-answer", kind: "answer", text: "A continuation: 已完成", createdAt: 6, updatedAt: 10 }],
    attachments: [{ name: "a-result.txt", path: "/sequence-fixture/a-result.txt" }], toolTaskId: "a-tool-task",
    activity: { tool: "work_query_status", status: "success" } });
  const revisedB = freeze<BotMessageDto>({ ...b, messageRevision: 2, status: "completed", text: "B continuation", updatedAt: 9 });
  let current = history(scope, [anchorA, anchorB, a, b, unrelated, question, ambiguous]);
  const snapshots = new Map([["task-a", work("task-a")], ["task-b", work("task-b")]]);
  const event = (name: string, frame: BotMessageDto, revision: number, extra: Partial<BotMessageEvent> = {}): Step => ({ name, run: () => {
    current = mergeBotMessageEvent(current, freeze({ botId: scope.botId, conversationId: scope.conversationId,
      revision, message: frame, ...extra }))!;
  } });
  const steps: Step[] = [event("B finishes at higher global revision", revisedB, 20),
    event("A continuation changes all public segments", revisedA, 10),
    event("duplicate A frame", revisedA, 10),
    event("stale A cannot replace content or task ownership", { ...a, workIds: ["task-b"] }, 40),
    event("wrong request cannot retarget A", { ...revisedA, requestId: "wrong-request", messageRevision: 4, workIds: ["task-b"] }, 50),
    event("other conversation cannot retarget A", { ...revisedA, messageRevision: 4, conversationId: "other-chat" }, 60, { conversationId: "other-chat" }),
    event("other Bot cannot retarget A", { ...revisedA, messageRevision: 4, botId: "bot-b" }, 70, { botId: "bot-b" }),
    { name: "old page overlaps the live continuation", run: () => { current = mergeBotHistoryPage(current, history(scope, [a, b], 1)); } },
    { name: "restore persisted history", run: () => { current = freeze(JSON.parse(JSON.stringify(current)) as BotHistoryDto); } },
  ];
  replay(`ordinary continuations status=${status}`, seed, shuffle(steps, seed), () => {
    const before = JSON.stringify(current);
    const rows = botTaskTimeline(freeze(current.messages));
    assert.deepEqual(rows.map(row => row.message.messageId), [anchorA, anchorB, unrelated, question, ambiguous].map(item => item.messageId),
      "progress, tool-round text and final foreground answers cannot add outer replies to their tasks");
    const tasks = rows.flatMap(row => row.tasks);
    assert.equal(tasks.length, 2);
    for (const [workId, anchorId, continuationId] of [["task-a", anchorA.messageId, a.messageId], ["task-b", anchorB.messageId, b.messageId]]) {
      const task = tasks.find(item => item.workId === workId)!;
      assert.deepEqual(task.messages.map(item => item.messageId), [anchorId, continuationId]);
      const presentation = botTaskReplyPresentation(workId, snapshots.get(workId), task.messages);
      assert.equal(presentation.statusLabel, "正在执行", "untyped 已完成 text and foreground transport state cannot close a Work");
      assert.equal(presentation.currentStageId, "execution");
      assert.equal(presentation.stages[3].state, "pending");
      assert.deepEqual(presentation.stages.flatMap(stage => stage.messages).map(item => item.messageId).sort(), [anchorId, continuationId].sort(),
        "moving a reply into a task cannot drop its public content from all tabs");
      const currentMessage = current.messages.find(item => item.messageId === continuationId)!;
      assert.equal(task.messages[1], currentMessage, "task grouping preserves the full immutable current message, including status, segments, tools and files");
    }
    assert.equal(JSON.stringify(current), before, "presentation must not rewrite persistent history");
  }, () => {
    assert.equal(JSON.stringify(current.messages.find(item => item.messageId === a.messageId)), JSON.stringify(revisedA),
      "all persisted A fields survive reload and stale frames");
    assert.equal(JSON.stringify(current.messages.find(item => item.messageId === b.messageId)), JSON.stringify(revisedB),
      "all persisted B fields survive reload and stale frames");
  });
}

for (const seed of seeds) {
  const anchorA = message(scope, "collaboration-original-a", 1, { workIds: ["task-a"] });
  const anchorB = message(scope, "collaboration-original-b", 2, { workIds: ["task-b"] });
  const returned = message(scope, "collaboration-return-a", 3, { workIds: ["task-b", "task-a"], text: "A reviewed answer",
    collaborationResult: result("task-a") });
  const historic = message(scope, "collaboration-old-a", 4, { workIds: ["task-b"], text: "A old result",
    collaborationResult: result("task-a", 1) });
  const exactFeedback = message(scope, "typed-feedback-b", 5, { workIds: ["task-a"], text: "B report",
    workFeedback: result("task-b"), collaborationResult: result("task-a") });
  const ordinary = message(scope, "collaboration-followup-a", 6, { workIds: ["task-a"], text: "A follow-up text" });
  let current = history(scope);
  const steps: Step[] = [
    { name: "result page arrives before anchors", run: () => { current = mergeBotHistoryPage(current, history(scope, [returned, historic, exactFeedback, ordinary], 3)); } },
    { name: "older task anchors arrive", run: () => { current = mergeBotHistoryPage(current, history(scope, [anchorA, anchorB], 1), true); } },
    { name: "duplicate result reconnect", run: () => { current = mergeBotHistoryPage(current, history(scope, [returned, historic, exactFeedback], 3)); } },
    { name: "serialized history restores exact identities", run: () => { current = freeze(JSON.parse(JSON.stringify(current)) as BotHistoryDto); } },
  ];
  replay("collaboration results retain exact Work and stage identity", seed, shuffle(steps, seed), () => {
    const rows = botTaskTimeline(freeze(current.messages));
    const tasks = rows.flatMap(row => row.tasks);
    const ownA = new Set([anchorA.messageId, returned.messageId, historic.messageId, ordinary.messageId]);
    const ownB = new Set([anchorB.messageId, exactFeedback.messageId]);
    assert.equal(tasks.length, new Set(tasks.map(task => task.workId)).size);
    for (const task of tasks) {
      const expected = current.messages.filter(item => (task.workId === "task-a" ? ownA : ownB).has(item.messageId));
      assert.deepEqual(task.messages, expected, "typed collaboration results override unrelated workIds, and workFeedback overrides any accompanying collaborationResult");
      const snapshot = work(task.workId);
      const presentation = botTaskReplyPresentation(task.workId, snapshot, task.messages);
      assert.equal(presentation.statusLabel, "正在执行", "current execution remains authoritative over returned result prose");
      const resultIds = task.workId === "task-a" ? [returned.messageId, historic.messageId] : [exactFeedback.messageId];
      assert.deepEqual(presentation.stages.find(stage => stage.id === "result")!.messages.map(item => item.messageId),
        expected.filter(item => resultIds.includes(item.messageId)).map(item => item.messageId),
        "typed returned review and historical result evidence belongs to the result tab");
      assert.deepEqual(presentation.stages.flatMap(stage => stage.messages).map(item => item.messageId).sort(), expected.map(item => item.messageId).sort());
    }
    for (const item of current.messages) {
      assert.equal(tasks.filter(task => task.messages.includes(item)).length, 1, "every source answer appears in exactly one task");
    }
  }, () => {
    const rows = botTaskTimeline(current.messages);
    assert.deepEqual(rows.map(row => row.message.messageId), [anchorA.messageId, anchorB.messageId]);
    assert.equal(current.messages.length, 6);
    assert.equal(rows[0].tasks[0].messages.length, 4);
    assert.equal(rows[1].tasks[0].messages.length, 2);
    const restored = JSON.parse(JSON.stringify(current)) as BotHistoryDto;
    assert.equal(JSON.stringify(botTaskTimeline(restored.messages)), JSON.stringify(botTaskTimeline(current.messages)));
  });
}
console.log(`PASS bot task reply sequences: ${traces} replay traces, ${observations} intermediate observations; seeds=${seeds.join(",")}. Pure production merge/projection checks; no desktop or live-model claim.`);
