import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPatchToMessage } from "../src/renderer/src/store/appStore";
import { ConversationInteractionCard } from "../src/renderer/src/components/chat/ConversationRuntimeCards";
import MessageBlockView from "../src/renderer/src/components/chat/MessageBlockView";
import { deriveTaskStatus, matchesTaskFilter } from "../src/renderer/src/utils/taskFilters";
import type { ChatMessage, Task } from "../src/renderer/src/types";
import type { ConversationGoalCreateRequest, ConversationGoalDto, ConversationGoalUpdateRequest, ConversationGoalVersionWitness, GoalSavedArtifactDto } from "../src/shared/conversation-goal";
import type { ConversationGoalMutationResult } from "../src/shared/conversation-runtime";
import type { GoalActivityDto } from "../src/shared/conversation-goal-activity";

const base: ChatMessage = { id: "assistant-a", role: "assistant", blocks: [], createdAt: 1, streaming: true };
const interaction = {
  id: "interaction-a", taskId: "task-a", executionId: "exec-a", assistantMessageId: "assistant-a",
  kind: "single_select" as const, title: "选择方案", options: [{ id: "a", label: "方案 A", recommended: true }, { id: "b", label: "方案 B" }],
  status: "pending" as const, version: 1, createdAt: 2,
};

const started = applyPatchToMessage(base, { type: "assistant_start", taskId: "task-a", messageId: "assistant-a", executionId: "exec-a" });
assert.equal(started.executionId, "exec-a");
const withInteraction = applyPatchToMessage(started, { type: "conversation_interaction_snapshot", taskId: "task-a", executionId: "exec-a", messageId: "assistant-a", interaction });
assert.equal(withInteraction.interactions?.[0]?.id, "interaction-a");

const task: Task = { id: "task-a", title: "A", updatedAt: 1, messages: [withInteraction] };
assert.equal(deriveTaskStatus(task), "pending");
assert.equal(matchesTaskFilter(task, "pending", "all"), true);
assert.equal(matchesTaskFilter(task, "in_progress", "all"), false);

const interactionHtml = renderToStaticMarkup(createElement(ConversationInteractionCard, { interaction }));
assert.match(interactionHtml, /需要你的回答/);
assert.match(interactionHtml, /方案 A/);
assert.match(interactionHtml, /推荐/);

const legacyPlan = { type: "plan", title: "历史计划内容", items: [{ text: "以前已经完成的步骤", done: true }, { text: "仍可阅读的步骤", done: false }] };
const legacyHtml = renderToStaticMarkup(createElement(MessageBlockView, { block: legacyPlan as any, index: 0 }));
assert.match(legacyHtml, /历史计划内容/);
assert.match(legacyHtml, /以前已经完成的步骤/);
assert.match(legacyHtml, /仍可阅读的步骤/);
assert.doesNotMatch(legacyHtml, /<button|<input|<progress|role="checkbox"|plan-card|批准执行/);
const malformedHtml = renderToStaticMarkup(createElement(MessageBlockView, { block: { type: "plan", title: "旧记录", items: [null, 2, { text: 3 }, { text: "合法历史文本" }] } as any, index: 0 }));
assert.match(malformedHtml, /合法历史文本/);
assert.doesNotMatch(malformedHtml, /<button|<input|<progress/);

async function goalArtifactPreviewKeepsExactVersion(): Promise<void> {
  const { parseHTML } = await import("linkedom/worker");
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.defineProperty(document, "oninput", { value: null, configurable: true });
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { default: ConversationGoalChip } = await import("../src/renderer/src/components/chat/ConversationGoalChip");
  const goal: ConversationGoalDto = { id: "goal", taskId: "task", title: "核对交付物", status: "active",
    criteria: [], version: 1, createdBy: "user", createdAt: 1, updatedAt: 2,
    continuation: { state: "exhausted", deferReason: "attempts", attempts: 2, maxAttempts: 2, tokensUsed: 0 } };
  const historical: ConversationGoalDto = { ...goal, id: "historical", title: "旧目标", status: "achieved",
    closedAt: 1, progressSummary: "历史材料已送审" };
  const cost = { knownCostUsd: null, observedRequests: 0, requestsWithCost: 0,
    providerReportedRequests: 0, estimatedRequests: 0, missingGenerationObservations: 0 };
  const activity: GoalActivityDto = {
    runs: [{ taskId: "task", conversationId: "child-conversation", generationTaskId: 2, intentRevision: 1,
      child: { id: "child", displayName: "资料检查", role: "review", model: "fixture" },
      returned: { status: "completed", toolCallId: "child-return" }, status: "completed", requestCount: 0, retryCount: 0 }],
    skills: [], knownTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    knownCostUsd: null, observedRequests: 0, requestsWithUsage: 0,
    tokenFieldCoverage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    requestsWithCompleteUsage: 0, requestsWithCost: 0, costBySource: { main: cost, child: cost, auxiliary: cost },
    unattributedAuxiliaryRequests: 0, missingGenerationObservations: 0, retryCount: 0,
  };
  const artifacts: GoalSavedArtifactDto[] = [
    { id: "new", path: "/workspace/receipt.txt", digest: "new-digest", version: 2, registeredAt: 2,
      request: { snapshotPath: "/saved/new/receipt.txt", name: "receipt.txt" } },
    { id: "old", path: "/workspace/receipt.txt", digest: "old-digest", version: 1, registeredAt: 2,
      request: { snapshotPath: "/saved/old/receipt.txt", name: "receipt.txt" } },
  ];
  const opened: string[] = [];
  const verified: string[] = [];
  Object.assign(window, { api: { conversationRuntime: {
    snapshot: async () => ({ taskId: "task", activeGoal: goal, goals: [goal, historical], interactions: [] }),
    goalEvidence: async (_taskId: string, goalId: string) => ({
      savedArtifacts: goalId === goal.id ? artifacts.map(artifact => ({ ...artifact })) : [],
      executions: [], artifacts: [], deliverables: [], verification: [],
      activity: goalId === goal.id ? activity : undefined,
    }),
    readGoalArtifactText: async (taskId: string, goalId: string, artifactId: string) => {
      assert.deepEqual([taskId, goalId], ["task", "goal"]);
      opened.push(artifactId);
      return artifactId === "old" ? "旧版本内容" : "新版本内容";
    },
    verifyGoalArtifact: async (taskId: string, goalId: string, artifactId: string) => {
      assert.deepEqual([taskId, goalId], ["task", "goal"]);
      verified.push(artifactId);
      const artifact = artifacts.find(item => item.id === artifactId);
      assert.ok(artifact);
      artifact.verification = { kind: "user", verifiedAt: 3 };
      return { ...artifact };
    },
  } } });
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string, label?: string) => {
    const target = [...document.querySelectorAll(selector)].find(node => label === undefined || node.textContent === label);
    assert.ok(target, `找不到 ${label ?? selector}`);
    await act(async () => target.dispatchEvent(new window.Event("click", { bubbles: true })));
  };
  const rows = () => [...document.querySelectorAll(".goal-artifact li")].map(item => item.textContent ?? "");
  const overviewRows = () => [...document.querySelectorAll(".conversation-goal-list li")].map(item => item.textContent ?? "");
  try {
    await act(async () => root.render(createElement(ConversationGoalChip, { taskId: "task", goal })));
    await click(".conversation-goal-chip");
    assert.equal(document.querySelectorAll(".goal-artifact-section").length, 1);
    assert.match(rows()[0], /版本 2 · 最新.*待核验/);
    assert.match(rows()[1], /版本 1.*待核验/);
    assert.match(overviewRows()[0], /已登记 2 个文件版本.*已核验 0 个.*1 个子代理已返回.*续跑已停止（自动续跑次数用尽）/);
    assert.match(overviewRows()[1], /历史材料已送审/);
    assert.doesNotMatch(overviewRows()[1], /receipt\.txt|子代理已返回|自动续跑次数用尽/);
    assert.match(document.querySelector(".conversation-goal-dialog > p:nth-of-type(2)")?.textContent ?? "", /自动续跑次数用尽/);
    await click('button[aria-label="打开 receipt.txt 版本 1"]');
    assert.equal(document.querySelector(".goal-artifact-preview pre")?.textContent, "旧版本内容");
    await click(".goal-artifact-preview button", "我已核验此版本");
    assert.match(overviewRows()[0], /已核验 1 个；最新 receipt\.txt（待核验）/);
    await click(".goal-artifact-preview button", "返回 Goal");
    assert.equal(document.querySelector(".goal-artifact-preview"), null);
    assert.equal(document.querySelector(".conversation-goal-dialog h2")?.textContent, "核对交付物");
    await click(".goal-evidence button", "刷新证据");
    assert.equal(document.querySelectorAll(".goal-artifact-section").length, 1, "证据刷新不能重复插入成果面板");
    await click('.conversation-goal-dialog button[aria-label="关闭"]');
    await click(".conversation-goal-chip");
    assert.match(rows()[0], /版本 2 · 最新.*待核验/);
    assert.match(rows()[1], /版本 1.*我已核验/);
    await click('button[aria-label="打开 receipt.txt 版本 2"]');
    assert.equal(document.querySelector(".goal-artifact-preview pre")?.textContent, "新版本内容");
    assert.deepEqual(opened, ["old", "new"]);
    assert.deepEqual(verified, ["old"]);
    await click(".goal-artifact-preview button", "返回 Goal");
    artifacts.reverse();
    artifacts[0]!.registeredAt = 4;
    await click(".goal-evidence button", "刷新证据");
    assert.match(rows()[0], /版本 1 · 最新.*我已核验/);
    assert.match(rows()[1], /版本 2.*待核验/);
    await click(".conversation-goal-list li:nth-child(2) button");
    assert.equal(document.querySelector(".conversation-goal-dialog h2")?.textContent, "旧目标");
    assert.doesNotMatch(document.querySelector(".goal-evidence")?.textContent ?? "", /receipt\.txt/);
    assert.equal(document.querySelector(".conversation-goal-dialog > p[role=status]"), null, "完成后不把历史停因显示为当前等待");
    assert.match(document.querySelector(".goal-evidence")?.textContent ?? "", /自动续跑次数用尽/, "续跑区仍可查历史停因");
  } finally {
    await act(async () => root.unmount());
  }
}

async function goalMutationsUseTheDisplayedVersion(): Promise<void> {
  const { parseHTML } = await import("linkedom/worker");
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.defineProperty(document, "oninput", { value: null, configurable: true });
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { default: ConversationGoalChip } = await import("../src/renderer/src/components/chat/ConversationGoalChip");
  const goal: ConversationGoalDto = { id: "goal", taskId: "task", title: "第一版目标", status: "active", version: 1, intentRevision: 1,
    ownerEpoch: 1, createdBy: "user", createdAt: 1, updatedAt: 2, criteria: [{ id: "first", text: "第一项", status: "pending" },
      { id: "second", text: "第二项", status: "met" }], continuation: { state: "idle", attempts: 0, maxAttempts: 3,
      tokensUsed: 0, tokenBudget: 50_000, tokenBudgetOverride: null, revision: 2 } };
  const newer: ConversationGoalDto = { ...goal, version: 2, intentRevision: 2, ownerEpoch: 2, updatedAt: 3, title: "较新目标",
    criteria: [{ id: "new-first", text: "第一项", status: "pending" }, { id: "new-second", text: "第二项", status: "pending" }] };
  const newest: ConversationGoalDto = { ...newer, version: 3, intentRevision: 3, updatedAt: 4, title: "最新目标",
    continuation: { ...goal.continuation!, state: "deferred", deferReason: "no_progress", revision: 4 } };
  const cancelled: ConversationGoalDto = { ...newest, version: 4, title: "最终状态", status: "cancelled", closedAt: 5 };
  const updates: ConversationGoalUpdateRequest[] = [];
  const creates: ConversationGoalCreateRequest[] = [];
  const cancels: Array<[string, string | undefined, ConversationGoalVersionWitness | undefined]> = [];
  const resumes: typeof cancels = [];
  let respondToPause!: (result: ConversationGoalMutationResult) => void;
  const pause = new Promise<ConversationGoalMutationResult>(resolve => { respondToPause = resolve; });
  Object.assign(window, { api: { conversationRuntime: {
    snapshot: async () => ({ taskId: "task", goals: [goal], activeGoal: goal, interactions: [] }),
    goalEvidence: async () => undefined,
    updateGoal: async (request: ConversationGoalUpdateRequest) => {
      updates.push(request);
      if (request.status === "paused") return await pause;
      return { ok: false, code: "conflict", message: "Goal 已改动，请重新编辑" };
    },
    cancelGoal: async (id: string, task: string | undefined, witness: ConversationGoalVersionWitness | undefined) => {
      cancels.push([id, task, witness]);
      return { ok: true, goal: cancelled };
    },
    resumeGoalContinuation: async (id: string, task: string | undefined, witness: ConversationGoalVersionWitness | undefined) => {
      resumes.push([id, task, witness]);
      return { ok: false, code: "conflict", message: "Goal 已改动" };
    },
    createGoal: async (request: ConversationGoalCreateRequest) => {
      creates.push(request);
      return { ok: true, goal: { ...goal, id: "created", title: request.title, createdAt: 8 } };
    },
  } } });
  const root = createRoot(document.getElementById("root")!);
  const render = async (value?: ConversationGoalDto) => act(async () => root.render(createElement(ConversationGoalChip, { taskId: "task", goal: value })));
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
    assert.ok(button, `找不到 ${label}`);
    await act(async () => button.dispatchEvent(new window.Event("click", { bubbles: true })));
  };
  const input = async (selector: string, value: string) => {
    const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    assert.ok(control, selector);
    const prototype = control.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
      if (control.tagName === "INPUT" && !control.getAttribute("type")) control.setAttribute("type", "text");
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new window.Event("input", { bubbles: true }));
      control.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  const submit = async () => act(async () => document.querySelector(".conversation-goal-dialog form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  const heading = () => document.querySelector(".conversation-goal-dialog h2")?.textContent;
  try {
    await render(goal);
    await click("此对话的 Goal");
    await click("编辑 Goal");
    assert.equal(document.querySelector<HTMLInputElement>("form label:last-of-type input")?.value, "", "the effective default is not a saved override");
    await input("form label:nth-of-type(3) textarea", "第二项\n第一项");
    await render(newer);
    assert.equal(document.querySelector<HTMLInputElement>("form input")?.value, goal.title, "a fresh projection keeps the existing draft");
    await submit();
    assert.deepEqual(updates[0], { goalId: "goal", taskId: "task", expectedVersion: 1, expectedIntentRevision: 1, expectedOwnerEpoch: 1,
      criteria: [{ id: "second", text: "第二项" }, { id: "first", text: "第一项" }] });
    assert.match(document.querySelector("form [role=alert]")?.textContent ?? "", /已改动/);
    await click("返回");
    assert.equal(heading(), newer.title, "an older snapshot cannot erase the latest goal projection");
    await click("暂停");
    assert.deepEqual(updates[1], { goalId: "goal", taskId: "task", status: "paused", expectedVersion: 2,
      expectedIntentRevision: 2, expectedOwnerEpoch: 2 });
    await render(newest);
    await act(async () => respondToPause({ ok: true, goal: { ...newer, status: "paused" } }));
    assert.equal(heading(), newest.title, "the delayed mutation callback cannot replace a newer push");
    await render({ ...newest, continuation: { ...newest.continuation!, state: "exhausted", deferReason: "attempts", revision: 5 } });
    await render(newest);
    assert.match(document.querySelector(".conversation-goal-chip")?.textContent ?? "", /用尽/,
      "an older continuation snapshot cannot rewind the same Work version");
    await click("继续");
    assert.deepEqual(resumes, [["goal", "task", { expectedVersion: 3, expectedIntentRevision: 3, expectedOwnerEpoch: 2,
      expectedContinuationRevision: 5 }]]);
    await click("取消 Goal");
    assert.deepEqual(cancels, [["goal", "task", { expectedVersion: 3, expectedIntentRevision: 3, expectedOwnerEpoch: 2 }]]);
    assert.equal(heading(), cancelled.title);
    await click("建立 Goal");
    await input("form input", "新目标带预算");
    await input("form label:last-of-type input", "12500");
    await submit();
    assert.equal(creates.length, 1);
    assert.equal(creates[0]?.tokenBudget, 12_500);
    assert.equal(updates.length, 2, "creation and its budget use one mutation");
  } finally {
    await act(async () => root.unmount());
  }
}

void goalArtifactPreviewKeepsExactVersion().then(goalMutationsUseTheDisplayedVersion).then(() => {
  console.log("conversation runtime ui tests: ok");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
