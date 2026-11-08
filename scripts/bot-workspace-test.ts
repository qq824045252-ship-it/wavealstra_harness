import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import { botMessageStatus, botWorkTimeline, needsWorkDecision, shouldSendBotComposer, workMatchesView, workStatusLabel } from "../src/renderer/src/lib/botWorkspacePresentation";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkResultCardDto } from "../src/shared/bot-work-phase5";
import Sidebar, { AccountNavigation } from "../src/renderer/src/components/Sidebar";
import ChatMarkdown from "../src/renderer/src/components/chat/ChatMarkdown";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
import { BotWorkDetails } from "../src/renderer/src/components/pages/BotWorkDetails";
import { WorkCardsPanel } from "../src/renderer/src/components/pages/BotWorkCardsPanel";
import { WorkReviewPanel } from "../src/renderer/src/components/pages/BotWorkReviewPanel";
import { useAppStore } from "../src/renderer/src/store/appStore";

const menu = renderToStaticMarkup(createElement(AccountNavigation, { go: () => {}, openProjects: () => {} }));
assert.ok(menu.indexOf("助手") < menu.indexOf("项目"));
assert.ok(menu.indexOf("项目") < menu.indexOf("Bot 模式"));
assert.ok(menu.indexOf("Bot 模式") < menu.indexOf("自动化"));
assert.ok(menu.indexOf("自动化") < menu.indexOf("插件"));

// React's server snapshot uses Zustand's initial state, so set the page on that
// snapshot while rendering the real sidebar and restore it immediately afterward.
const initial = useAppStore.getInitialState();
const originalPage = initial.page;
initial.page = "chat";
const chatSidebar = renderToStaticMarkup(createElement(Sidebar));
initial.page = "bot";
const botSidebar = renderToStaticMarkup(createElement(Sidebar));
initial.page = originalPage;
assert.match(chatSidebar, /独立任务/);
assert.doesNotMatch(botSidebar, /独立任务|新建任务/);
assert.match(botSidebar, /还没有 Bot/);
const botPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(botPage, /返回普通模式/);
assert.match(botPage, /创建一个 Bot，给它名称和职责/);
const navigation = botPage.match(/<nav class="bot-view-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
assert.ok(navigation);
assert.equal((navigation.match(/<button /g) ?? []).length, 4, "navigation has exactly four stable entry points");
for (const title of ["对话", "进行中", "待你决定", "已结束"]) assert.match(navigation, new RegExp(`<span>${title}</span>`));
assert.match(navigation, /aria-current="page"/);
assert.match(botPage, /还没有 Bot/);
assert.doesNotMatch(botPage, /<progress|class="bot-work-details"|aria-label="事项详情"/, "empty state cannot fabricate Work details or progress");
assert.match(botPage, /<button[^>]*disabled[^>]*aria-label="发送消息"/);

const draft = { title: "普通任务草稿" };
useAppStore.setState({ page: "chat", draft, activeTaskId: "task-a", botDraft: "" });
useAppStore.getState().setPage("bot");
assert.equal(useAppStore.getState().page, "bot");
assert.equal(useAppStore.getState().draft, draft);
assert.equal(useAppStore.getState().activeTaskId, "task-a");
useAppStore.getState().setBotDraft("Bot 草稿");
const tasks = useAppStore.getState().tasks;
useAppStore.getState().submitBotDraft();
assert.equal(useAppStore.getState().tasks, tasks);
assert.equal(useAppStore.getState().activeTaskId, "task-a");
assert.equal(useAppStore.getState().page, "bot");
assert.equal(useAppStore.getState().botSubmissionNotice, false, "without a Bot host receipt the UI must retain the draft and not claim acceptance");
assert.equal(useAppStore.getState().botDraft, "Bot 草稿");
useAppStore.getState().setPage("chat");
assert.equal(useAppStore.getState().draft, draft);
assert.equal(useAppStore.getState().activeTaskId, "task-a");
assert.equal(useAppStore.getState().botDraft, "Bot 草稿");
useAppStore.getState().setPage("automation");
assert.equal(useAppStore.getState().draft, null);
assert.equal(useAppStore.getState().botDraft, "Bot 草稿");

const duty: BotDto = {
  botId: "bot-duty",
  userId: "user-local-primary",
  displayName: "值班",
  responsibilitySummary: "夜间值班",
  expertProfile: {
    expertId: "expert-duty", revision: "v1", version: 1, systemPromptHash: "hash",
    allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 1,
    desiredVersion: 1, activeVersion: 1,
  },
  memoryScope: { personalMemoryNamespace: "bot-duty", sharePersonalMemoryWithTeam: false, allowUnconfirmedSpeculationInMemory: false },
  authorization: { allowedScopes: ["workspace:read"], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false },
  foregroundAllowedTools: [],
  notificationPolicyJson: "{}",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
};
function work(overrides: Partial<WorkProjectionDto> & Pick<WorkProjectionDto, "workId" | "title">): WorkProjectionDto {
  return {
    mode: "once",
    lifecycle: "active",
    ownerBotId: duty.botId,
    ownerEpoch: 1,
    intentRevision: 2,
    sourceVersion: 1,
    stateVersion: 4,
    inputSnapshotId: "input-1",
    inputSnapshotBound: true,
    goalSources: [],
    criteria: [{
      id: "c1", text: "日志齐全", status: "pending", requiredIntentRevision: 2,
      requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy", evidenceRefs: [],
    }],
    acceptedDeliverableIds: [],
    deliverables: [],
    blockers: [],
    executions: [],
    notifications: [],
    subscriptionIds: [],
    uncoveredScope: [],
    nextSteps: ["等待实测反馈：日志齐全"],
    updatedAt: 4,
    ...overrides,
  };
}
// Pure presentation behavior: lifecycle truth wins over stale decision text.
const blocker: WorkProjectionDto["blockers"][number] = { blockerId: "b1", workId: "decision", reason: "请确认范围",
  kind: "operational", waitingForUserInput: true, status: "open", createdAt: 1 };
const plain = work({ workId: "plain", title: "普通事项", nextSteps: [] });
assert.equal(needsWorkDecision(plain), false);
assert.equal(needsWorkDecision({ ...plain, blockers: [blocker] }), true);
assert.equal(needsWorkDecision({ ...plain, blockers: [{ ...blocker, status: "cleared" }] }), false);
assert.equal(needsWorkDecision({ ...plain, blockers: [{ ...blocker, waitingForUserInput: false }] }), false);
for (const step of ["需要你的决定：选择范围", "等待实测反馈：日志齐全"]) {
  const decision = { ...plain, nextSteps: [step] };
  assert.equal(needsWorkDecision(decision), true);
  assert.equal(workMatchesView(decision, "decisions"), true);
  assert.equal(workStatusLabel(decision), "待你决定");
  assert.equal(needsWorkDecision({ ...decision, lifecycle: "closed" }), false);
}
for (const lifecycle of ["active", "paused", "closing", "closed"] as const) {
  const candidate = { ...plain, lifecycle };
  assert.equal(workMatchesView(candidate, "active"), lifecycle !== "closed");
  assert.equal(workMatchesView(candidate, "conversation"), lifecycle !== "closed");
  assert.equal(workMatchesView(candidate, "closed"), lifecycle === "closed");
}
assert.equal(workStatusLabel(plain), "进行中");
assert.equal(workStatusLabel({ ...plain, lifecycle: "paused" }), "已暂停");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closing" }), "正在结算");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "succeeded" }), "已完成");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "cancelled" }), "已取消");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "ended_unsuccessfully" }), "已结束 · 未完成");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: undefined }), "已结束",
  "missing closure evidence cannot imply failure or success");
const message = { role: "assistant", status: "completed" } as BotMessageDto;
assert.equal(botMessageStatus(message), "已回复");
assert.equal(botMessageStatus({ ...message, role: "user" }), "已发送");
for (const [status, label] of Object.entries({ queued: "等待回复", running: "正在回复", cancelled: "已停止", unknown: "结果待核对", failed: "回复失败" })) {
  assert.equal(botMessageStatus({ ...message, status: status as BotMessageDto["status"] }), label);
}
const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
assert.equal(shouldSendBotComposer(enter), true);
for (const change of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "Escape" }, { key: "a" }]) {
  assert.equal(shouldSendBotComposer({ ...enter, ...change }), false, "newline, IME confirmation and ordinary keys never submit");
}

// Closing a successfully accepted result keeps its original card kind. The rendered
// completion badge must use the authoritative closure and the card's current currency.
const acceptedCard: WorkResultCardDto = {
  cardKey: "card-accepted", semanticCardKey: "semantic-accepted", workId: "work-result", userId: duty.userId,
  kind: "accepted_result", intentRevision: 2, inputSnapshotId: "input-1", originOwnerEpoch: 1,
  canonicalOutcomeHash: "accepted-outcome", title: "成果已验收", summary: "验收记录完整",
  deliverableIds: ["deliverable-accepted"], evidenceIds: ["evidence-accepted"], sourceRefs: [], artifactRefs: [],
  unverifiedScope: [], createdAt: 4, currency: "current", readVersion: 0, notificationIds: [],
};
const completedWork = work({ workId: acceptedCard.workId, title: "已验收成果", lifecycle: "closed", closureConclusion: "succeeded" });
function renderCards(workChanges: Partial<WorkProjectionDto> = {}, cardChanges: Partial<WorkResultCardDto> = {}): string {
  return renderToStaticMarkup(createElement(WorkCardsPanel, {
    work: { ...completedWork, ...workChanges, cards: [{ ...acceptedCard, ...cardChanges }] }, includeClosed: true,
  }));
}
assert.match(renderCards(), /已完成并关闭/, "a successful close renders on the reused acceptance card");
assert.match(renderCards({}, { unverifiedScope: ["已在采纳后核验的条件"] }), /生成此卡时尚未验证：.*当前验收状态请查看上方进度/, "immutable acceptance-card gaps are historical, not a contradictory current criterion status");
assert.match(renderCards({}, { kind: "closure_succeeded" }), /已完成并关闭/);
const incompleteWorkStates: Array<Partial<WorkProjectionDto>> = [
  { lifecycle: "active" }, { lifecycle: "closing" }, { closureConclusion: "cancelled" },
  { closureConclusion: "ended_unsuccessfully" }, { closureConclusion: undefined },
];
for (const state of incompleteWorkStates) {
  assert.doesNotMatch(renderCards(state), /已完成并关闭/,
    `an accepted card cannot imply successful closure for ${JSON.stringify(state)}`);
}
const noncurrentResultStates: Array<Partial<WorkResultCardDto>> = [
  { currency: "historical" }, { currency: "superseded" }, { kind: "blocked_escalation" },
  { kind: "closure_cancelled" }, { kind: "closure_failed" },
];
for (const state of noncurrentResultStates) {
  assert.doesNotMatch(renderCards({}, state), /已完成并关闭/,
    `a successful Work cannot relabel a different card fact: ${JSON.stringify(state)}`);
}

assert.match(renderCards({}, { kind: "owner_summary", previousCardKey: "summary-previous" }), /主负责人汇总/);
assert.match(renderCards({}, { kind: "owner_summary", previousCardKey: "summary-previous" }), /href="#work-card-summary-previous"/);
assert.match(renderCards({}, { kind: "owner_summary" }), /id="work-card-card-accepted"/);
const proposedOutput: WorkProjectionDto["deliverables"][number] = {
  deliverableId: "ui-proposed", workId: completedWork.workId, producerBotId: duty.botId,
  executionId: "ui-execution", intentRevision: 2, ownerEpoch: 1, inputSnapshotId: "input-1",
  status: "proposed", summary: "Current proposal", artifactRefs: [], evidenceRefs: [], uncoveredScope: [],
  uncoveredCriterionIds: [], isSpeculation: false, hasWriteConflicts: false, createdAt: 5,
};
const proposalDecision = { ...plain, deliverables: [proposedOutput] };
assert.equal(needsWorkDecision(proposalDecision), true, "a current proposal needs review even without a next-step hint");
assert.equal(workMatchesView(proposalDecision, "decisions"), true);
for (const change of [
  { intentRevision: proposedOutput.intentRevision - 1 }, { inputSnapshotId: "different-input" },
  { ownerEpoch: proposedOutput.ownerEpoch + 1 }, { status: "accepted" as const }, { status: "rejected" as const },
]) {
  const candidate = { ...proposalDecision, deliverables: [{ ...proposedOutput, ...change }] };
  assert.equal(needsWorkDecision(candidate), false, `noncurrent or settled proposal cannot need review: ${JSON.stringify(change)}`);
  assert.equal(workMatchesView(candidate, "decisions"), false);
}
assert.equal(needsWorkDecision({ ...proposalDecision, lifecycle: "closed" }), false,
  "a closed matter cannot need proposal review");

const renderReview = (changes: Partial<WorkProjectionDto> = {}) => renderToStaticMarkup(createElement(WorkReviewPanel, {
  work: { ...completedWork, lifecycle: "active", deliverables: [proposedOutput], ...changes }, includeClosed: true,
}));
const reviewPanel = renderReview();
assert.match(reviewPanel, /采纳成果/);
assert.match(reviewPanel, /拒绝成果/);
assert.match(reviewPanel, /<button[^>]*disabled[^>]*>记录实测通过<\/button>/, "feedback needs actual user input");
assert.match(reviewPanel, /<button[^>]*disabled[^>]*>确认结束事项<\/button>/, "closure needs evidence and confirmation");
for (const flags of [{ hasWriteConflicts: true }, { isSpeculation: true }]) {
  assert.match(renderReview({ deliverables: [{ ...proposedOutput, ...flags }] }), /<button[^>]*disabled[^>]*>采纳成果<\/button>/);
}
assert.doesNotMatch(renderReview({ deliverables: [{ ...proposedOutput, intentRevision: 1 }] }), /<button[^>]*>采纳成果<\/button>/, "stale proposals have no accept action");
assert.equal(renderReview({ lifecycle: "closed" }), "", "closed Work has no additional review controls");

const renderDetails = (changes: Partial<WorkProjectionDto>) => renderToStaticMarkup(createElement(BotWorkDetails, {
  work: { ...completedWork, ...changes }, ownerName: duty.displayName, includeClosed: true,
}));
for (const closureConclusion of ["succeeded", "cancelled", "ended_unsuccessfully"] as const) {
  const closedDetails = renderDetails({ closureConclusion, deliverables: [proposedOutput] });
  assert.doesNotMatch(closedDetails, /class="bot-work-decision-hint"|<h3>需要你决定<\/h3>|<button[^>]*>采纳成果<\/button>/,
    "closed matters must not solicit review decisions that cannot be acted on");
  assert.match(closedDetails, /未采纳（已结束）/);
  assert.match(closedDetails, /成果记录与验收/);
}
const emptyExecution: NonNullable<WorkProjectionDto["phase3"]> = { subitems: [], continuations: [], gaps: [], resourceWaits: [],
  resourceRecoveries: [], settlingActions: 0, pausedEventCount: 0, handoffs: [], collaborationMessages: [] };
assert.doesNotMatch(renderDetails({ lifecycle: "active", phase3: emptyExecution }), /aria-label="事项执行情况"/,
  "empty execution diagnostics should not occupy the everyday overview");
assert.match(renderDetails({ lifecycle: "active", phase3: { ...emptyExecution, resourceWaits: ["正在等待共享资源"] } }),
  /aria-label="事项执行情况"/, "real resource waits remain visible");

assert.match(renderDetails({ lifecycle: "active", phase3: { ...emptyExecution, settlingActions: 1 } }),
  /仍有 1 项在途操作等待结算/, "unsettled effects are not empty diagnostics and remain visible");

const actionableDetails = renderDetails({ lifecycle: "active", deliverables: [proposedOutput], cards: [acceptedCard] });
assert.ok(actionableDetails.indexOf('aria-label="成果评审与结束"') < actionableDetails.indexOf('aria-label="结果卡片与证据"'),
  "review decisions must precede result ledgers and diagnostics");
const emptyCards = renderToStaticMarkup(createElement(WorkCardsPanel, { work: { ...completedWork, cards: [], notifications: [] }, includeClosed: true }));
assert.doesNotMatch(emptyCards, /<h3>结果卡片<\/h3>|<h3>外部通知<\/h3>|还没有结果卡片|还没有外部通知记录/,
  "empty ledgers must not distract from the actual review action");
assert.match(emptyCards, /高级诊断与证据/, "diagnostics remain available even with no cards");
const unknownNotification = renderToStaticMarkup(createElement(WorkCardsPanel, { work: { ...completedWork, cards: [], notifications: [{
  notificationId: "unknown-delivery", workId: completedWork.workId, kind: "result", title: "待核对通知", body: "通知内容",
  semanticKey: "unknown-delivery", stateVersion: completedWork.stateVersion, intentRevision: completedWork.intentRevision,
  delivery: "unknown", attemptCount: 1, createdAt: 1,
}] }, includeClosed: true }));
assert.match(unknownNotification, /外部结果未确认/);
assert.match(unknownNotification, /确认风险后重发/);
assert.ok(unknownNotification.indexOf("确认风险后重发") < unknownNotification.indexOf("高级诊断与证据"),
  "uncertain delivery risk and confirmation remain outside the diagnostic fold");

const night = work({ workId: "work-night", title: "夜间巡检", intentRevision: 2 });
const handoff = work({
  workId: "work-handoff",
  title: "交接记录",
  intentRevision: 5,
  criteria: [{
    id: "c2", text: "交接说明已读", status: "pending", requiredIntentRevision: 5,
    requiresRealEnvironmentCheck: false, evidenceRefs: [],
  }],
  nextSteps: ["待验收：交接说明已读"],
});
const snapshot = useAppStore.getInitialState();
const savedSnapshot = {
  page: snapshot.page,
  botIdentities: snapshot.botIdentities,
  botWorks: snapshot.botWorks,
  activeBotId: snapshot.activeBotId,
  selectedWorkId: snapshot.selectedWorkId,
  botHostStatus: snapshot.botHostStatus,
  botSubmissionNotice: snapshot.botSubmissionNotice,
  botWorkCursor: snapshot.botWorkCursor,
  botHistories: snapshot.botHistories,
  activeTaskId: snapshot.activeTaskId,
};
Object.assign(snapshot, {
  page: "bot",
  botIdentities: [duty],
  botWorks: [night, handoff],
  activeBotId: duty.botId,
  selectedWorkId: night.workId,
  botHostStatus: { online: true, isAuthority: true, authorityId: "local" },
  botSubmissionNotice: false,
});
snapshot.botHistories = {};
const emptyConversation = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(emptyConversation, /有什么想一起推进的？/);
for (const title of ["梳理今天的重点", "持续跟进一件事", "一起推进一个目标"]) {
  assert.match(emptyConversation, new RegExp(`<button type="button"[^>]*><span>${title}</span>`),
    "welcome examples only draft a message, never submit the composer");
}
const exampleGrid = emptyConversation.match(/<div class="bot-example-grid">([\s\S]*?)<\/div>/)?.[1];
assert.ok(exampleGrid);
assert.equal((exampleGrid.match(/<button /g) ?? []).length, 3);
snapshot.botHistories = savedSnapshot.botHistories;

// Real shared Markdown renderer and real Bot page: a local-file reference must
// stay inert in Bot history, even when an ordinary Task remains selected.
const localFileMarkdown = "[产物](report.pdf) 和 `C:/private/report.pdf`，另见 [官网](https://example.com)";
snapshot.activeTaskId = "unrelated-ordinary-task";
const ordinaryMarkdown = renderToStaticMarkup(createElement(ChatMarkdown, { text: "[产物](report.pdf)", streaming: false }));
assert.match(ordinaryMarkdown, /md-file-link/, "ordinary Task rendering still supports file actions");
snapshot.botHistories = { [duty.botId]: { conversationId: "scope-test", botId: duty.botId, revision: 1, archived: false, messages: [{
  messageId: "scope-message", conversationId: "scope-test", botId: duty.botId, requestId: "scope-request", ordinal: 1,
  role: "assistant", text: localFileMarkdown, status: "completed", workIds: [], createdAt: 1, updatedAt: 1,
}] } };
const scopedBotPage = renderToStaticMarkup(createElement(BotWorkspacePage));
const scopedMessage = scopedBotPage.match(/<article[^>]*data-message-id="scope-message"[^>]*>([\s\S]*?)<\/article>/)?.[1];
assert.ok(scopedMessage, "the fixture renders through the actual Bot message component");
// Bot lazily loads Markdown, so static SSR can legitimately show its inert
// Suspense fallback. Exercise the loaded shared renderer separately as well.
const scopedMarkdown = renderToStaticMarkup(createElement(ChatMarkdown, { text: localFileMarkdown, streaming: false, resolveTaskFiles: false }));
assert.match(scopedMarkdown, /请从关联事项查看/);
assert.match(scopedMarkdown, /<code class="inline-code">C:\/private\/report.pdf<\/code>/);
assert.match(scopedMarkdown, /href="https:\/\/example.com"/);
assert.doesNotMatch(scopedMessage + scopedMarkdown, /md-file-link|local-file-chip|href="report.pdf"/,
  "Bot file references cannot borrow ordinary Task file actions");
snapshot.botHistories = savedSnapshot.botHistories;
snapshot.activeTaskId = savedSnapshot.activeTaskId;

const populatedSidebar = renderToStaticMarkup(createElement(Sidebar));
const populatedPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(populatedSidebar, /值班/);
assert.doesNotMatch(populatedSidebar, /夜间巡检|交接记录/, "sidebar selects the Bot, not a second duplicate Work list");
assert.match(populatedSidebar, /在线/);
assert.doesNotMatch(populatedSidebar, /独立任务|新建任务/);
assert.match(populatedPage, /夜间巡检/);
assert.match(populatedPage, /日志齐全/);
assert.match(populatedPage, /值班 · 一次性事项/);
assert.match(populatedPage, /<dialog[^>]*aria-label="事项详情"/);
assert.match(populatedPage, /<details class="bot-advanced"><summary>高级设置与诊断<\/summary>/, "advanced settings start collapsed");
const detailsStart = populatedPage.indexOf('class="bot-work-details"');
const overview = populatedPage.slice(detailsStart);
const orderedHeadings = ["目标", "进度", "下一步", "成果与证据", "需要你决定"];
for (let index = 1; index < orderedHeadings.length; index++) {
  assert.ok(overview.indexOf(`<h3>${orderedHeadings[index - 1]}</h3>`) < overview.indexOf(`<h3>${orderedHeadings[index]}</h3>`), "details prioritize actionable information");
}
assert.ok(overview.indexOf("高级设置与诊断") < overview.indexOf("要求 r2"), "technical versions live in advanced settings");
assert.match(populatedPage, /要求 r2/);
assert.doesNotMatch(populatedPage, /要求 r5/);
night.phase4 = {
  subscriptions: [{ subscriptionId: "sub-1", workId: night.workId, source: "hook", targetKey: "repo-a",
    status: "online", catchUpPolicy: "latest", timezone: "Asia/Shanghai", scheduleRevision: 2, configRevision: 3,
    nextWakeAt: 1_000, lastCheckedAt: 900, versionMode: "monotonic",
    queue: { ready: 1, frozen: 1, blocked: 2, bytes: 120, maxEvents: 8, maxBytes: 4096, mergeDeadlineAt: 1_100,
      readySince: 800, waitReason: "有限溢出区等待回填" },
    cursors: [{ source: "hook", targetKey: "repo-a", highestAcceptedVersion: "10", highestConsumedVersion: "9", highestFrozenVersion: "10" }] }],
  offlineGaps: [{ gapId: "gap-1", subscriptionId: "sub-1", workId: night.workId, offlineGapFrom: 100, offlineGapTo: 200,
    detectedBy: "heartbeat-stale", confidence: "inferred", policy: "latest", policyRevision: 2, queryable: false,
    recoveredCount: 0, mergedCount: 1, skippedCount: undefined, unknownCount: undefined, state: "unqueryable",
    gapReason: "来源没有历史回查能力" }],
  budget: { windowId: "bw-1", policyRevision: 3, scope: "window", periodStartAt: 100, periodEndAt: 200,
    timezone: "Asia/Shanghai", limitTokens: 500, committedTokens: 120, reservedTokens: 30, unknownTokens: 20,
    unknownUsageCount: 2, availableTokens: 330, autoRollover: true, carryPolicy: "none", status: "open",
    pendingRollover: "仍有未核对用量，等待结算后续期",
    unknownReservations: [{ reservationId: "unknown-provider-1", windowId: "bw-1", tokens: 20,
      requestKind: "generation", createdAt: 150 }] },
  causal: [{ chainId: "chain-1", rootEventId: "root-1", originWorkId: night.workId, targetWorkId: night.workId,
    depth: 2, hops: 2, dispatchCount: 3, decision: "blocked-loop", reasonCode: "causal-loop-guard", createdAt: 110 }],
  deadlineAt: 300, deadlineRevision: 4, host: { authorityId: "local", sessionId: "session-1", online: true,
    lastScanAt: 190, lastScanCursor: "cursor-1", activeSince: 50 },
};
const phase4Page = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(phase4Page, /关注与运行/);
assert.match(phase4Page, /repo-a/);
assert.match(phase4Page, /合并为最新一次/);
assert.match(phase4Page, /固定合并截止/);
assert.match(phase4Page, /不可回查/);
assert.match(phase4Page, /已结算 120/);
assert.match(phase4Page, /在途预留 30/);
assert.match(phase4Page, /未知 20/);
assert.match(phase4Page, /仍有未核对用量，等待结算后续期/);
assert.match(phase4Page, /unknown-provider-1/);
assert.match(phase4Page, /原窗口 bw-1/);
assert.match(phase4Page, /aria-label="已核实 tokens"[^>]*value=""/, "unknown usage is never prefilled as zero");
assert.match(phase4Page, /<button[^>]*disabled[^>]*>保存预算核对结果<\/button>/, "reconciliation requires explicit amount, reason, evidence and confirmation");
assert.match(phase4Page, /causal-loop-guard/);
assert.match(phase4Page, /承诺期限/);
assert.ok(phase4Page.indexOf("unknown-provider-1") < phase4Page.indexOf("高级设置与诊断"), "unknown usage confirmation remains visible outside advanced settings");
snapshot.botWorkCursor = { epoch: "closed-budget-fixture", sequence: 1, scope: "all" };
night.lifecycle = "closed";
const closedBudgetPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(closedBudgetPage, /已结束/);
assert.match(closedBudgetPage, /核对未知用量/);
assert.match(closedBudgetPage, /unknown-provider-1/, "completed Work retains access to outstanding accounting in the all scope");
night.lifecycle = "active";
snapshot.botWorkCursor = savedSnapshot.botWorkCursor;
delete night.phase4;
night.phase3 = { subitems: [], continuations: [], gaps: [], resourceWaits: [], settlingActions: 1,
  pausedEventCount: 0, handoffs: [], collaborationMessages: [], resourceRecoveries: [{
    token: 1, resourceKinds: ["desktop"], attempts: 4, exhaustedAt: 100, pendingProbe: false, reason: "原操作效果待核对",
  }] };
const exhaustedPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(exhaustedPage, /自动核对已停止/);
assert.ok(exhaustedPage.indexOf("重新核对隔离资源") < exhaustedPage.indexOf("高级设置与诊断"), "isolation recovery must not be hidden in advanced settings");
assert.match(exhaustedPage, /我已确认环境安全，可以重新核对/);
assert.match(exhaustedPage, /<button[^>]*disabled[^>]*>重新核对隔离资源<\/button>/, "rendered retry is disabled before explicit confirmation");
night.phase3.resourceRecoveries[0]!.pendingProbe = true;
const pendingRecoveryPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(pendingRecoveryPage, /恢复核对仍有在途步骤，资源继续隔离/);
assert.doesNotMatch(pendingRecoveryPage, /自动核对已停止|重新核对隔离资源<\/button>/, "an exhausted budget cannot make an outstanding probe look stopped");
delete night.phase3;
snapshot.selectedWorkId = handoff.workId;
const handoffPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(handoffPage, /要求 r5/);
assert.match(handoffPage, /交接说明已读/);
assert.doesNotMatch(handoffPage, /要求 r2/);
snapshot.botSubmissionNotice = true;
const noticePage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(noticePage, /消息已发送/);
Object.assign(snapshot, savedSnapshot);

useAppStore.setState({
  botIdentities: [duty],
  botWorks: [night, handoff],
  activeBotId: duty.botId,
  selectedWorkId: night.workId,
  activeTaskId: "task-a",
});
useAppStore.getState().applyWorkProjection({ ...night, stateVersion: 1, lifecycle: "paused", title: "旧标题" });
assert.equal(useAppStore.getState().botWorks.find((item) => item.workId === night.workId)?.title, "夜间巡检");
assert.equal(useAppStore.getState().botWorks.find((item) => item.workId === night.workId)?.lifecycle, "active");
const tasksAfterProjection = useAppStore.getState().tasks;
useAppStore.getState().submitBotDraft();
assert.equal(useAppStore.getState().tasks, tasksAfterProjection);
assert.equal(useAppStore.getState().activeTaskId, "task-a");
console.log("bot workspace tests: ok");

// Structured Work feedback folds only routine progress or superseded versions.
const feedbackMessage = (messageId: string, workId: string, eventId: string,
  category: "progress" | "decision" | "result"): BotMessageDto => ({
  messageId, workIds: [workId], conversationId: "chat", botId: "bot", requestId: messageId,
  ordinal: 1, role: "assistant", text: "Identical text must not drive grouping", status: "completed",
  createdAt: 1, updatedAt: 1, workFeedback: { workId, eventId, kind: category === "result" ? "result" : "blocker", category },
});
const timeline = [feedbackMessage("p1", "work-a", "binding:one", "progress"),
  feedbackMessage("p2", "work-a", "blocker:resolved", "progress"),
  feedbackMessage("r1", "work-a", "result:member-one", "result"),
  feedbackMessage("r2", "work-a", "result:member-two", "result"),
  feedbackMessage("open", "work-a", "blocker:one", "decision"),
  feedbackMessage("clear", "work-a", "blocker:one", "progress"),
  feedbackMessage("reopen", "work-a", "blocker:one", "decision"),
  feedbackMessage("unknown", "work-a", "binding:unknown-effect", "decision"),
  feedbackMessage("other", "work-b", "result:member-one", "result")];
const timelineBefore = JSON.stringify(timeline);
const timelineRows = botWorkTimeline(timeline);
assert.equal(timelineRows[0].kind, "progress");
assert.equal(timelineRows[0].kind === "progress" && timelineRows[0].messages.length, 2);
assert.deepEqual(timelineRows.filter(row => row.kind === "message").map(row => row.message.messageId), ["r1", "r2", "reopen", "unknown", "other"]);
assert.equal(JSON.stringify(timeline), timelineBefore, "folding must never change persisted records");
assert.deepEqual(timelineRows.flatMap(row => row.kind === "message" ? [row.message] : row.messages), timeline, "every original message remains available in original order");
const untyped = { ...timeline[0], workFeedback: undefined };
assert.equal(botWorkTimeline([untyped])[0].kind, "message", "legacy/unclassified text is never silently hidden");
const userFeedback = { ...timeline[0], role: "user" as const };
assert.equal(botWorkTimeline([userFeedback])[0].kind, "message", "a user message cannot be folded as system progress");
const separateChat = { ...timeline[0], conversationId: "another-chat", workFeedback: { ...timeline[0].workFeedback!, category: "decision" as const } };
assert.equal(botWorkTimeline([separateChat, timeline[1]])[0].kind, "message");
