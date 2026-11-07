import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import Sidebar, { AccountNavigation } from "../src/renderer/src/components/Sidebar";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
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
assert.match(botPage, /受理服务尚未接线/);
assert.match(botPage, /待决事项/);
assert.match(botPage, /还没有 Bot/);
assert.doesNotMatch(botPage, /进行中|进度|负责人|<progress/);

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
const populatedSidebar = renderToStaticMarkup(createElement(Sidebar));
const populatedPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(populatedSidebar, /值班/);
assert.match(populatedSidebar, /夜间巡检/);
assert.match(populatedSidebar, /在线/);
assert.doesNotMatch(populatedSidebar, /独立任务|新建任务/);
assert.match(populatedPage, /夜间巡检/);
assert.match(populatedPage, /日志齐全/);
assert.match(populatedPage, /负责人 值班/);
assert.match(populatedPage, /要求 r2/);
assert.doesNotMatch(populatedPage, /要求 r5/);
night.phase3 = { subitems: [], continuations: [], gaps: [], resourceWaits: [], settlingActions: 1,
  pausedEventCount: 0, handoffs: [], collaborationMessages: [], resourceRecoveries: [{
    token: 1, resourceKinds: ["desktop"], attempts: 4, exhaustedAt: 100, pendingProbe: false, reason: "原操作效果待核对",
  }] };
const exhaustedPage = renderToStaticMarkup(createElement(BotWorkspacePage));
assert.match(exhaustedPage, /自动核对已停止/);
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
assert.match(noticePage, /消息已持久受理/);
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
