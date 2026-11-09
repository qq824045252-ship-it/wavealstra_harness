import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import { activeBotReply, botMessageStatus, botWorkTimeline, shouldSendBotComposer, workMatchesView, workStatusLabel, workExecutionComplete, workCardExcerpt, workStatus, workSearchText, workMatchesSearch } from "../src/renderer/src/lib/botWorkspacePresentation";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkResultCardDto } from "../src/shared/bot-work-phase5";
import Sidebar, { AccountNavigation } from "../src/renderer/src/components/Sidebar";
import ChatMarkdown from "../src/renderer/src/components/chat/ChatMarkdown";
import BotWorkspacePage, { BotMessage } from "../src/renderer/src/components/pages/BotWorkspacePage";
import { BotWorkBrowser } from "../src/renderer/src/components/pages/BotWorkBrowser";
import { BotWorkDetails } from "../src/renderer/src/components/pages/BotWorkDetails";
import { WorkFiles, workFiles, generatedWorkFiles } from "../src/renderer/src/components/pages/BotWorkResult";
import { WorkCardsPanel } from "../src/renderer/src/components/pages/BotWorkCardsPanel";
import { WorkReviewPanel } from "../src/renderer/src/components/pages/BotWorkReviewPanel";
import { useAppStore } from "../src/renderer/src/store/appStore";

const menu = renderToStaticMarkup(createElement(AccountNavigation, { go: () => {}, openProjects: () => {} }));
const activityMessage: BotMessageDto = { messageId: "activity-message", conversationId: "activity-chat", botId: "activity-bot",
  requestId: "activity-request", ordinal: 1, role: "assistant", text: "", status: "running", workIds: [], createdAt: 1, updatedAt: 1,
  activity: { tool: "web_search", status: "running" } };
const renderActivity = (message: BotMessageDto) => renderToStaticMarkup(createElement(BotMessage, { message,
  botName: "Bot", works: [], onOpenWork: () => {}, onCancel: () => {} }));
for (const text of ["", "正在核对资料。"] ) {
  const html = renderActivity({ ...activityMessage, text });
  assert.match(html, /role="status"[^>]*>正在搜索实时信息/);
  assert.equal((html.match(/正在搜索实时信息/g) ?? []).length, 1, "tool activity uses one status line with or without streamed text");
  assert.match(html, /停止回复/, "waiting on a search keeps cancellation available");
}
assert.equal(botMessageStatus({ ...activityMessage, activity: { tool: "fetch_content", status: "running" } }), "正在读取来源");
assert.equal(botMessageStatus({ ...activityMessage, activity: { tool: "web_search", status: "error" } }), "搜索未成功，正在整理回复");
assert.equal(botMessageStatus({ ...activityMessage, activity: { tool: "web_search", status: "success" } }), "搜索已返回，正在整理回复");
for (const status of ["completed", "cancelled", "failed", "unknown"] as const) {
  assert.doesNotMatch(renderActivity({ ...activityMessage, status }), /正在搜索实时信息/, "terminal or unknown messages must not advertise ongoing tools");
}
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
assert.match(botPage, /新对话/);
assert.match(botPage, /aria-labelledby="bot-new-conversation-title"/);
assert.match(botPage, /归档并开始新对话/);
assert.match(botPage, /class="input-textarea"/, "Bot uses the same controlled composer as ordinary chat");
assert.match(botPage, /class="bot-composer input-area"/, "Bot shares the task chat outer width, gutter and bottom placement");
assert.match(botPage, /class="bot-composer-box input-box"/);
assert.match(botPage, /class="bot-composer-toolbar input-toolbar"/);
assert.match(botPage, /class="bot-send-button send-btn"/, "Bot uses the same icon send button dimensions");
assert.doesNotMatch(botPage, /class="bot-composer-note"/, "no extra footer shifts the Bot input above ordinary chat");
assert.match(botPage, /bot-header-more/, "secondary actions leave room for the Bot identity");
assert.match(botPage, /创建一个 Bot，给它名称和职责/);
const navigation = botPage.match(/<nav class="bot-view-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
assert.ok(navigation);
assert.equal((navigation.match(/<button /g) ?? []).length, 3, "navigation has exactly three stable entry points");
for (const title of ["对话", "未结束", "已结束"]) assert.match(navigation, new RegExp(`<span>${title}</span>`));
assert.match(navigation, /aria-current="page"/);
assert.doesNotMatch(navigation + botSidebar, /待你决定/, "retired decision navigation is not exposed anywhere");
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
// Tasks awaiting real information stay in the active task list, not a separate decision column.
const blocker: WorkProjectionDto["blockers"][number] = { blockerId: "b1", workId: "question", reason: "请确认范围",
  kind: "operational", waitingForUserInput: true, status: "open", createdAt: 1 };
const plain = work({ workId: "plain", title: "普通事项", nextSteps: [] });
for (const candidate of [plain, { ...plain, blockers: [blocker] }, { ...plain, nextSteps: ["等待实测反馈：日志齐全"] }]) {
  assert.equal(workMatchesView(candidate, "active"), true);
  assert.equal(workStatusLabel(candidate), candidate.blockers.length ? "等待补充信息" : "尚未执行");
}
for (const lifecycle of ["active", "paused", "closing", "closed"] as const) {
  const candidate = { ...plain, lifecycle };
  assert.equal(workMatchesView(candidate, "active"), lifecycle !== "closed");
  assert.equal(workMatchesView(candidate, "conversation"), lifecycle !== "closed");
  assert.equal(workMatchesView(candidate, "closed"), lifecycle === "closed");
}
assert.equal(workStatusLabel(plain), "尚未执行");
assert.equal(workStatusLabel({ ...plain, lifecycle: "paused" }), "已暂停");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closing" }), "正在结算");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "succeeded" }), "已完成");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "cancelled" }), "已取消");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: "ended_unsuccessfully" }), "已结束 · 未完成");
assert.equal(workStatusLabel({ ...plain, lifecycle: "closed", closureConclusion: undefined }), "已结束",
  "missing closure evidence cannot imply failure or success");
const completeBinding = { bindingId: "done", workId: plain.workId, intentRevision: plain.intentRevision,
  inputSnapshotId: plain.inputSnapshotId, ownerEpoch: plain.ownerEpoch, status: "completed", settledAt: 4 } as WorkProjectionDto["executions"][number];
const executed = { ...plain, executions: [completeBinding] };
assert.equal(workExecutionComplete(executed), true);
assert.equal(workStatusLabel(executed), "执行已完成 · 待核验");
assert.equal(workMatchesView(executed, "closed"), false, "execution success never fabricates Work acceptance or closure");
assert.equal(workStatusLabel({ ...executed, mode: "watch" }), "持续关注中");
assert.equal(workStatusLabel({ ...executed, blockers: [blocker] }), "等待补充信息");
for (const status of ["pending", "submitted", "running", "unknown", "failed", "stopped", "invalidated"] as const) {
  assert.equal(workExecutionComplete({ ...plain, executions: [{ ...completeBinding, status }] }), false);
}
assert.equal(workExecutionComplete({ ...executed, intentRevision: 99 }), false, "old requirements cannot imply completion");
assert.equal(workExecutionComplete({ ...executed, inputSnapshotId: "new-input" }), false);
assert.equal(workExecutionComplete({ ...executed, executions: [{ ...completeBinding, invalidatedAt: 5 }] }), false);
assert.equal(workStatusLabel({ ...executed, criteria: [{ ...plain.criteria[0], status: "satisfied" }] }), "执行已完成 · 待结算");
// List filters use the same authoritative state as their badge, never infer success from text.
assert.equal(workStatus(executed).group, "results");
assert.equal(workStatus({ ...executed, blockers: [blocker] }).group, "attention");
assert.equal(workStatus({ ...plain, lifecycle: "paused" }).group, "paused");
assert.equal(workStatus({ ...executed, intentRevision: 99 }).group, "waiting");
assert.equal(workStatus({ ...plain, lifecycle: "closed", closureConclusion: "succeeded" }).group, "succeeded");
assert.equal(workStatus({ ...plain, lifecycle: "closed" }).group, "ended");
assert.equal(workStatus({ ...executed, executions: [{ ...completeBinding, status: "unknown" }] }).group, "attention");
const indexed = workSearchText({ ...plain, title: "器件价格核对", nextSteps: ["联系供应商 ACME"], criteria: [{ ...plain.criteria[0], text: "比较贴片电容" }],
  deliverables: [{ summary: "完整报告含 47uF", artifactRefs: ["报价结果.xlsx"] } as WorkProjectionDto["deliverables"][number]] });
assert.ok(workMatchesSearch(indexed, "ACME   电容"));
assert.ok(workMatchesSearch(indexed, "４７ｕｆ 报价结果"), "width-normalized terms find report text and files, not only titles");
assert.ok(!workMatchesSearch(indexed, "ACME missing"));
assert.ok(workMatchesSearch(workSearchText({ ...plain, generatedArtifacts: [{ path: "/tmp/generated-only.csv", snapshotPath: "/tmp/snapshot-only.csv" } as NonNullable<WorkProjectionDto["generatedArtifacts"]>[number]] }), "generated-only.csv snapshot-only.csv"), "generated-only files remain findable without a deliverable summary");
const largeList = Array.from({ length: 1000 }, (_, i) => work({ workId: `list-${i}`, title: `列表事项 ${i}`, updatedAt: i }));
const listHtml = renderToStaticMarkup(createElement(BotWorkBrowser, { works: largeList, view: "active", loading: false, onOpenWork: () => {}, onConversation: () => {} }));
assert.equal((listHtml.match(/class="bot-work-card"/g) ?? []).length, 24, "large list mounts only one page, without dropping searchable Work");
assert.match(listHtml, /共 1000 件 · 当前 1–24 件/);
assert.match(listHtml, /第 1 \/ 42 页/);
assert.match(listHtml, /按事项状态筛选/);
assert.match(listHtml, /最久未更新优先/);

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
assert.equal(workMatchesView({ ...plain, deliverables: [proposedOutput] }, "active"), true,
  "pending result review remains reachable from active tasks");

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
const emptyExecution: NonNullable<WorkProjectionDto["phase3"]> = { subitems: [], continuations: [], gaps: [],
  settlingActions: 0, pausedEventCount: 0, handoffs: [], collaborationMessages: [] };
assert.doesNotMatch(renderDetails({ lifecycle: "active", phase3: emptyExecution }), /aria-label="事项执行情况"/,
  "empty execution diagnostics should not occupy the everyday overview");
assert.match(renderDetails({ lifecycle: "active", phase3: { ...emptyExecution, settlingActions: 1 } }),
  /仍有 1 项在途操作等待结算/, "unsettled effects are not empty diagnostics and remain visible");

const proposalCriterion = { id: "suggested", text: "模型建议核算总数", origin: "assistant_proposal" as const,
  status: "pending" as const, requiredIntentRevision: completedWork.intentRevision, requiresRealEnvironmentCheck: false, evidenceRefs: [] };
const proposalDetails = renderDetails({ lifecycle: "active", criteria: [proposalCriterion] });
assert.match(proposalDetails, /助理建议检查/); assert.match(proposalDetails, /不是额外的用户验收门槛/);
assert.doesNotMatch(proposalDetails, /aria-label="已通过的验收项"/, "model suggestions do not inflate mandatory user acceptance progress");
assert.match(renderReview({ criteria: [proposalCriterion] }), /建议检查：模型建议核算总数/);
assert.match(renderReview({ criteria: [proposalCriterion] }), /若你主动记录通过、未通过或待核验/);

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
const orderedHeadings = ["目标", "进度", "下一步", "成果与证据", "成果记录与验收"];
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
assert.doesNotMatch(phase4Page, /共享预算|预算上限|保存预算|核对未知用量|全团队 token/,
  "Work budgeting is removed, including its editor and reconciliation controls");
assert.match(phase4Page, /causal-loop-guard/);
assert.match(phase4Page, /承诺期限/);
snapshot.botWorkCursor = { epoch: "closed-work-fixture", sequence: 1, scope: "all" };
night.lifecycle = "closed";
const closedPhase4Page = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(closedPhase4Page, /已结束/);
assert.match(closedPhase4Page, /不可回查/, "completed tasks retain their actual offline history");
assert.doesNotMatch(closedPhase4Page, /预算|额度|核对未知用量/);
night.lifecycle = "active";
snapshot.botWorkCursor = savedSnapshot.botWorkCursor;
delete night.phase4;
night.phase3 = { subitems: [], continuations: [], gaps: [], settlingActions: 1,
  pausedEventCount: 0, handoffs: [], collaborationMessages: [] };
const settlingPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(settlingPage, /仍有 1 项在途操作等待结算/, "real in-flight admissions stay visible without any approval surface");
assert.doesNotMatch(settlingPage, /共享资源|后台操作审批|授权规则|重新核对隔离资源/, "retired isolation and approval surfaces never render");
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

const runningReply = { messageId: "running", role: "assistant", status: "running" } as BotMessageDto;
const queuedReply = { messageId: "queued", role: "assistant", status: "queued" } as BotMessageDto;
assert.equal(activeBotReply([runningReply, queuedReply]), runningReply, "stop targets current generation before later queued reply");
assert.equal(activeBotReply([queuedReply]), queuedReply);
assert.equal(activeBotReply([{ ...runningReply, status: "completed" }]), undefined);

// Interleaved progress from six Works becomes one fold, without crossing a reply or losing order.
const sixProgress = Array.from({ length: 6 }, (_, i) => feedbackMessage(`six-${i}`, `work-${i}`, `binding:${i}`, "progress"));
const groupedSix = botWorkTimeline(sixProgress);
assert.equal(groupedSix.length, 1);
assert.equal(groupedSix[0].kind === "progress" && groupedSix[0].workIds.length, 6);
assert.deepEqual(groupedSix.flatMap(row => row.kind === "progress" ? row.messages : [row.message]), sixProgress);
const generated = [
  { bindingId: "done", path: "/work/report.csv", snapshotPath: "/snap/hash-report", digest: "sha-one", sizeBytes: 20, registeredAt: 1, sourceEntryId: 1 },
  { bindingId: "done", path: "/work/create.py", snapshotPath: "/snap/hash-script", digest: "sha-two", sizeBytes: 40, registeredAt: 1, sourceEntryId: 2 },
];
const fileWork = { ...executed, generatedArtifacts: generated };
assert.deepEqual(workFiles(["/snap/hash-report"], fileWork, "done").map(file => file.name), ["report.csv"]);
assert.equal(workFiles(["/snap/hash-report"], fileWork, "another-execution")[0].artifact, undefined, "same basename never crosses execution boundaries");
const attachmentHtml = renderToStaticMarkup(createElement(WorkFiles, { files: workFiles(["/snap/hash-script", "/snap/hash-report"], fileWork, "done") }));
assert(attachmentHtml.indexOf("report.csv") < attachmentHtml.indexOf("create.py"), "readable reports precede scripts");
assert.match(attachmentHtml, /<details class="bot-result-other-files"><summary>其他文件与脚本/);
assert.match(attachmentHtml, /<summary>路径与版本<\/summary><p>\/snap\/hash-report/);
assert.match(attachmentHtml, /打开保存版本/);
assert.equal(generatedWorkFiles({ ...fileWork, generatedArtifacts: [...generated, { ...generated[0], digest: "new-version", snapshotPath: "/snap/new-version" }] }).length, 3, "same-name historical versions stay available");
const structuredResult: BotMessageDto = { ...feedbackMessage("result-card", "plain", "result:done", "result"),
  text: "完整原始消息 /snap/hash-report", workFeedback: { workId: "plain", eventId: "result:done", kind: "result", category: "result", executionId: "done",
    report: { title: "CSV 汇总", summary: "合计 42 元。", artifactRefs: ["/snap/hash-report"], files: [{ ref: "/snap/hash-report", name: "report.csv" }], reviewStatus: "proposed", current: true, notices: ["尚未覆盖：现场验收"] } } };
const reportHtml = renderToStaticMarkup(createElement(BotMessage, { message: structuredResult, botName: "Bot", works: [fileWork], onOpenWork() {}, onCancel() {} }));
assert.match(reportHtml, /成果：CSV 汇总/);
assert.match(reportHtml, /合计 42 元/);
assert.match(reportHtml, /成果已生成 · 待核验/);
assert.match(reportHtml, /尚未覆盖：现场验收/);
assert.match(reportHtml, /<details class="bot-original-report"><summary>原始消息与完整记录/);
assert(reportHtml.indexOf("合计 42 元") < reportHtml.indexOf("完整原始消息"));
assert.match(renderToStaticMarkup(createElement(BotMessage, { message: structuredResult, botName: "Bot", works: [], onOpenWork() {}, onCancel() {} })), /report.csv/, "persisted filename survives missing/closed Work projections");

assert.doesNotMatch(renderToStaticMarkup(createElement(WorkFiles, { files: [{ ref: "/unregistered/private.txt", name: "private.txt" }] })), /打开文件|打开保存版本/, "unregistered model file references remain text, not privileged file-open actions");


// List excerpts are deterministic presentation, not generated/rewritten results.
const longReport = "# QA6-D 排期报告\n\n总工期 **9 天**，关键路径 **A → C → D → E**，5 条依赖全部校验通过。\n\n"
  + "| 任务 | 工期 |\n| --- | --- |\n| A | 2 |\n\n"
  + "## 证据\n\n未做浏览器视觉渲染。" + "完整证据。".repeat(70);
const excerpt = workCardExcerpt(longReport, "QA6-D 排期报告");
assert.ok(excerpt.startsWith("总工期 9 天，关键路径 A → C → D → E，5 条依赖全部校验通过。"));
assert.match(excerpt, /未做浏览器视觉渲染/);
assert.doesNotMatch(excerpt, /\*\*|##|\||QA6-D/);
assert.equal(Array.from(excerpt).length, 120);
assert.ok(excerpt.endsWith("…"));
assert.match(longReport, /\*\*9 天\*\*/, "original report is unchanged");
assert.equal(workCardExcerpt("[官方结论](https://example.com/report) **25 件** &amp; `total_count`；仍未验收。"),
  "官方结论 25 件 & total_count；仍未验收。");
assert.equal(workCardExcerpt("产物 `/home/test/.mybuddy/durable/" + "a".repeat(64) + "/artifacts/" + "b".repeat(64) + ".json`，CSV 在 `C:\\Users\\Tester\\reports\\sales.csv`。"),
  "产物 成果文件，CSV 在 sales.csv。");
assert.equal(workCardExcerpt("请检查 /home/test/reports/sales.csv；不要重跑。"), "请检查 sales.csv；不要重跑。");
assert.equal(workCardExcerpt("数量 25/25；9 < 10；日期 2026/11/09；https://example.com/report。"),
  "数量 25/25；9 < 10；日期 2026/11/09；https://example.com/report。");
assert.equal(workCardExcerpt("# 总计 **25 件**"), "总计 25 件");
assert.equal(workCardExcerpt("```python\nprint('/home/test/private')\n```\n\n|A|B|\n|-|-|\n|1|2|"), "打开查看完整内容与附件。");
assert.equal(workCardExcerpt("![图](https://example.com/p.png)\n\n<b>尚未核验</b>，不能确认通过。"), "尚未核验，不能确认通过。");
assert.ok(!/[\uD800-\uDBFF]$/.test(workCardExcerpt("🙂".repeat(130)).slice(0, -1)), "truncation does not split surrogate pairs");

assert.equal(workCardExcerpt("## 未通过\n\n25 条测试通过。"), "未通过 25 条测试通过。");
assert.equal(workCardExcerpt("## 未验证\n\n产物已保存。"), "未验证 产物已保存。");
assert.equal(workCardExcerpt("路径 `C:\\Users\\Tester\\My Reports\\sales.csv`，仍未验收。"), "路径 sales.csv，仍未验收。");
