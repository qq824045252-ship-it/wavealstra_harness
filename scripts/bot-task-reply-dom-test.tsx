/** Actual React components with controlled host snapshots. No live IPC, model or desktop layout. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { BotMessageDto, BotHistoryDto } from "../src/shared/bot-conversation";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import { queryWorkFixture } from "./work-query-fixture";

const { window: testWindow, document: testDocument } = parseHTML("<!doctype html><html><body></body></html>");
let focused: HTMLElement | null = null;
Object.defineProperty(testDocument, "activeElement", { configurable: true, get: () => focused });
Object.assign(testWindow.HTMLElement.prototype, {
  focus() { focused = this as HTMLElement; },
  show() { this.setAttribute("open", ""); },
  showModal() { this.setAttribute("open", ""); },
  close() { this.removeAttribute("open"); },
});
Object.assign(testWindow, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, {
  window: testWindow, document: testDocument, HTMLElement: testWindow.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
});

const ownerId = "inline-reply-owner";
const conversationId = "inline-reply-conversation";
const authorization: BotDto["authorization"] = {
  allowedScopes: ["workspace:read"], targetWhitelist: [], allowRedelegation: false, allowGitBranchOrWorktree: false,
};
const owner = { botId: ownerId, displayName: "测试助理", status: "active", authorization } as BotDto;
function work(workId: string): WorkProjectionDto {
  return {
    workId, ownerBotId: ownerId, ownerEpoch: 1, intentRevision: 1,
    sourceVersion: 1, title: workId === "task-a" ? "API 接入" : "历史分页",
    criteria: [{ id: `${workId}-criterion`, text: "验证已请求的结果", status: "pending", requiredIntentRevision: 1,
      requiresRealEnvironmentCheck: false, evidenceRefs: [] }],
    inputSnapshotId: `${workId}-input`, inputSnapshotBound: true,
    goalSources: [], mode: "once", lifecycle: "active", acceptedDeliverableIds: [],
    stateVersion: 1, updatedAt: 1,
    deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [],
    listSummary: { status: { label: "正在执行", group: "running" }, excerpt: "正在处理", deliverableCount: 0,
      canArchive: false, executionTaskIds: [], running: true },
  };
}
function message(messageId: string, ordinal: number, role: BotMessageDto["role"], requestId: string,
  workIds: string[], text: string, extra: Partial<BotMessageDto> = {}): BotMessageDto {
  return { messageId, ordinal, role, requestId, workIds, text, botId: ownerId, conversationId,
    status: "completed", createdAt: ordinal, updatedAt: ordinal, ...extra };
}
function progress(workId: string, ordinal: number, text: string): BotMessageDto {
  return message(`${workId}-progress-${ordinal}`, ordinal, "assistant", `${workId}-feedback-${ordinal}`, [workId], text, {
    workFeedback: { workId, eventId: `event-${ordinal}`, kind: "binding", category: "progress",
      intentRevision: 1, inputSnapshotId: `${workId}-input` },
  });
}
const initialMessages = [
  message("ask-a", 1, "user", "request-a", ["task-a"], "完成 API 接入"),
  message("reply-a", 2, "assistant", "request-a", ["task-a"], "已经开始 API 接入。", {
    segments: [{ id: "a-commentary", kind: "commentary", text: "原有执行说明会保留。", createdAt: 2, updatedAt: 2 }],
  }),
  message("ask-b", 3, "user", "request-b", ["task-b"], "同时处理历史分页"),
  message("reply-b", 4, "assistant", "request-b", ["task-b"], "已经开始历史分页。"),
  progress("task-a", 5, "API 第一条进度"),
  progress("task-b", 6, "分页第一条进度"),
];
const history = (messages: BotMessageDto[], revision = 1): BotHistoryDto => ({
  botId: ownerId, conversationId, revision, archived: false, messages,
});
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 5));
let count = 0;
async function check(name: string, run: () => Promise<void>) {
  await run(); count++; console.log(`PASS ${count}: ${name}`);
}

async function main() {
  const { createRoot } = await import("react-dom/client");
  const { default: BotWorkspacePage } = await import("../src/renderer/src/components/pages/BotWorkspacePage");
  const { useAppStore } = await import("../src/renderer/src/store/appStore");
  const original = useAppStore.getState();
  let currentMessages = initialMessages;
  let sends = 0;
  let root: Root | undefined;
  const container = testDocument.body.appendChild(testDocument.createElement("div"));
  Object.defineProperty(testWindow, "api", { configurable: true, value: { botWork: {
    queryWorks: async (request: Parameters<typeof queryWorkFixture>[1]) => queryWorkFixture(useAppStore.getState().botWorks, request),
    getWork: async (id: string) => useAppStore.getState().botWorks.find(item => item.workId === id),
    incomingMessages: async () => ({ items: [] }),
  } } });
  const card = (id: string) => {
    const node = container.querySelector<HTMLElement>(`.bot-task-reply[data-work-id="${id}"]`);
    assert.ok(node, `expected inline reply card for ${id}`); return node;
  };
  const tab = (id: string, stage: string) => {
    const node = card(id).querySelector<HTMLButtonElement>(`[role="tab"][data-stage-id="${stage}"]`);
    assert.ok(node, `expected ${stage} stage tab for ${id}`); return node;
  };
  const selected = (id: string) => card(id).querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-stage-id");
  const click = async (node: HTMLElement) => act(async () => { node.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
  const update = async (messages: BotMessageDto[], works = useAppStore.getState().botWorks) => {
    currentMessages = messages;
    await act(async () => {
      useAppStore.setState({ botHistories: { [ownerId]: history(messages, (useAppStore.getState().botHistories[ownerId]?.revision ?? 0) + 1) }, botWorks: works });
      await delay();
    });
    // Run the frame scheduled by the committed layout effect before asserting
    // the scroll position; an unflushed follow-bottom frame would hide a bug.
    await act(async () => { await delay(); });
  };
  try {
    useAppStore.setState({ activeBotId: ownerId, activeTeam: null, botIdentities: [owner], selectedWorkId: null,
      historicalTeamWork: null, botWorks: [work("task-a"), work("task-b")], botHistories: { [ownerId]: history(initialMessages) },
      botHistoryPages: {}, botPendingSends: {}, botDraft: "还没发送的草稿", botDrafts: { [ownerId]: "还没发送的草稿" },
      refreshBotHistory: async () => {}, refreshBotWork: async () => {}, submitBotDraft: async () => { sends++; } });
    root = createRoot(container);
    await act(async () => { root!.render(<BotWorkspacePage />); await delay(); });
    const composer = container.querySelector<HTMLTextAreaElement>("textarea#bot-draft");
    assert.ok(composer);
    const composerForm = composer.closest("form");
    const originalReply = container.querySelector<HTMLElement>('article.bot-message[data-message-id="reply-a"]');
    assert.ok(originalReply);
    const firstCard = card("task-a");
    const otherCard = card("task-b");
    const originalTranscript = JSON.stringify(initialMessages);

    await check("parallel tasks stay in their original assistant replies with one original composer", async () => {
      assert.equal(firstCard.closest("article.bot-message"), originalReply);
      assert.equal(otherCard.closest("article.bot-message")?.getAttribute("data-message-id"), "reply-b");
      assert.equal(container.querySelectorAll(".bot-task-reply").length, 2);
      assert.equal(container.querySelectorAll("textarea").length, 1);
      assert.equal(composer.closest(".bot-task-reply"), null);
      assert.equal(composerForm?.hidden, false);
      assert.equal(container.querySelectorAll("article.bot-message.assistant").length, 2, "feedback updates do not create extra outer replies");
      assert.match(originalReply.textContent ?? "", /原有执行说明会保留/);
    });

    await check("stage clicks preserve independent task selection, native tab relationships and composer draft", async () => {
      const otherSelection = selected("task-b");
      await click(tab("task-a", "request"));
      assert.equal(selected("task-a"), "request"); assert.equal(selected("task-b"), otherSelection);
      await click(tab("task-b", "review"));
      assert.equal(selected("task-a"), "request"); assert.equal(selected("task-b"), "review");
      for (const reply of [firstCard, otherCard]) for (const item of reply.querySelectorAll('[role="tab"]')) {
        const panel = testDocument.getElementById(item.getAttribute("aria-controls")!);
        assert.ok(panel && reply.contains(panel));
        assert.equal(panel.getAttribute("role"), "tabpanel");
        assert.equal(panel.getAttribute("aria-labelledby"), item.id);
      }
      assert.equal(container.querySelector("textarea#bot-draft"), composer);
      assert.equal(composer.closest("form"), composerForm);
      assert.equal(composer.value, "还没发送的草稿"); assert.equal(useAppStore.getState().botDraft, "还没发送的草稿");
      assert.equal(useAppStore.getState().selectedWorkId, null); assert.equal(sends, 0);
      assert.equal(container.querySelector(".bot-work-conversation-detail"), null);
    });

    await check("background progress preserves reply identity, selected stage, focus and paused thread position", async () => {
      const thread = container.querySelector<HTMLElement>(".bot-thread")!;
      Object.defineProperties(thread, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
      thread.scrollTop = 220;
      const selectedTab = tab("task-a", "request"); selectedTab.focus();
      await click(selectedTab);
      await update([...currentMessages, progress("task-a", 7, "API 第二条进度")]);
      assert.equal(card("task-a"), firstCard); assert.equal(card("task-b"), otherCard);
      assert.equal(container.querySelector('article.bot-message[data-message-id="reply-a"]'), originalReply);
      assert.equal(selected("task-a"), "request"); assert.equal(selected("task-b"), "review");
      assert.equal(testDocument.activeElement, selectedTab);
      assert.equal(thread.scrollTop, 220);
      assert.equal(container.querySelector("textarea#bot-draft"), composer); assert.equal(composer.value, "还没发送的草稿");
    });

    await check("prior progress remains accessible and task results update the same reply without switching the reader", async () => {
      const result = message("task-a-result", 8, "assistant", "task-a-final", ["task-a"], "API 最终结果：全部完成。", {
        workFeedback: { workId: "task-a", eventId: "task-a-closed", kind: "closure", category: "result", intentRevision: 1,
          inputSnapshotId: "task-a-input", report: { title: "API 接入", summary: "API 最终结果：全部完成。", artifactRefs: [],
            reviewStatus: "accepted", current: true, notices: [], completion: { outcome: "completed", nextStep: "deliver" } } },
      });
      const closed = { ...work("task-a"), lifecycle: "closed" as const, closureConclusion: "succeeded" as const,
        closureSummary: "API 最终结果：全部完成。", stateVersion: 2, updatedAt: 8,
        listSummary: { ...work("task-a").listSummary!, status: { label: "已完成", group: "succeeded" as const }, running: false } };
      await update([...currentMessages, result], [closed, work("task-b")]);
      assert.equal(card("task-a"), firstCard); assert.equal(selected("task-a"), "request");
      assert.equal(container.querySelectorAll("article.bot-message.assistant").length, 2);
      await click(tab("task-a", "execution"));
      const execution = card("task-a").querySelector('[role="tabpanel"][data-stage-id="execution"]')!;
      assert.match(execution.textContent ?? "", /API 第一条进度/);
      assert.match(execution.textContent ?? "", /API 第二条进度/);
      assert.doesNotMatch(execution.textContent ?? "", /分页第一条进度/);
      await click(tab("task-a", "result"));
      const resultPanel = card("task-a").querySelector('[role="tabpanel"][data-stage-id="result"]')!;
      assert.match(resultPanel.textContent ?? "", /API 最终结果/);
      assert.equal(JSON.stringify(initialMessages), originalTranscript, "presentation does not rewrite durable source messages");
      assert.equal(composer.value, "还没发送的草稿"); assert.equal(composerForm?.hidden, false);
    });

    await check("keyboard stage navigation remains scoped to its own reply", async () => {
      const request = tab("task-a", "request"); request.focus();
      await click(request);
      const otherSelection = selected("task-b");
      const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "key", { value: "ArrowRight" });
      await act(async () => { request.dispatchEvent(event); });
      assert.equal(selected("task-a"), "execution"); assert.equal(selected("task-b"), otherSelection);
      assert.equal(testDocument.activeElement, tab("task-a", "execution"));
      assert.equal(container.querySelector("textarea#bot-draft"), composer); assert.equal(sends, 0);
    });

    await check("linking a Work during foreground streaming retains the original reply and rendered segment", async () => {
      const streaming = message("reply-c", 10, "assistant", "request-c", [], "正在读取第三个请求。", {
        status: "running", segments: [{ id: "c-answer", kind: "answer", text: "正在读取第三个请求。", createdAt: 10, updatedAt: 10 }],
      });
      await update([...currentMessages, message("ask-c", 9, "user", "request-c", [], "继续处理第三件事"), streaming]);
      const reply = container.querySelector('article.bot-message[data-message-id="reply-c"]');
      const segment = reply?.querySelector('[data-segment-id="c-answer"]');
      assert.ok(reply && segment); assert.equal(reply.querySelector(".bot-task-reply"), null);
      composer.focus();
      await update(currentMessages.map(item => item.requestId === "request-c" ? { ...item, workIds: ["task-c"],
        ...(item.role === "assistant" ? { segments: [{ ...streaming.segments![0], text: "正在读取第三个请求。已经派发执行。", updatedAt: 11 }] } : {}) } : item),
      [...useAppStore.getState().botWorks, work("task-c")]);
      assert.equal(container.querySelector('article.bot-message[data-message-id="reply-c"]'), reply);
      assert.equal(reply.querySelector('[data-segment-id="c-answer"]'), segment);
      assert.match(segment.textContent ?? "", /已经派发执行/);
      assert.equal(card("task-c").closest("article.bot-message"), reply);
      assert.equal(container.querySelector("textarea#bot-draft"), composer); assert.equal(composer.value, "还没发送的草稿");
      assert.equal(testDocument.activeElement, composer); assert.equal(sends, 0);
    });

    await check("loading the original reply from older history preserves the task's selected stage", async () => {
      const allMessages = currentMessages;
      await update(allMessages.filter(item => item.requestId !== "request-a"));
      assert.equal(card("task-a").closest("article.bot-message")?.getAttribute("data-message-id"), "task-a-progress-5");
      await click(tab("task-a", "review"));
      const otherSelection = selected("task-b");
      await update(allMessages);
      assert.equal(card("task-a").closest("article.bot-message")?.getAttribute("data-message-id"), "reply-a");
      assert.equal(selected("task-a"), "review"); assert.equal(selected("task-b"), otherSelection);
      assert.equal(container.querySelectorAll('.bot-task-reply[data-work-id="task-a"]').length, 1);
      assert.equal(container.querySelector("textarea#bot-draft"), composer); assert.equal(composer.value, "还没发送的草稿");
    });

    await check("replanned tasks retain historical reports and files without presenting old completion as current", async () => {
      const prior = currentMessages.find(item => item.messageId === "task-a-result")!;
      const artifactRef = "/controlled-fixture/api-result-v1.md";
      const historical: BotMessageDto = { ...prior, text: "", workFeedback: { ...prior.workFeedback!,
        report: { ...prior.workFeedback!.report!, summary: "第一版 API 结果和附件已保存。", current: true,
          artifactRefs: [artifactRef], files: [{ ref: artifactRef, name: "api-result-v1.md", openPath: artifactRef }] } } };
      const originalRecord = JSON.stringify(historical);
      const revised = { ...work("task-a"), intentRevision: 2, inputSnapshotId: "task-a-input-v2", stateVersion: 3, updatedAt: 12 };
      await update(currentMessages.map(item => item.messageId === historical.messageId ? historical : item),
        useAppStore.getState().botWorks.map(item => item.workId === "task-a" ? revised : item));
      await click(tab("task-a", "result"));
      const record = card("task-a").querySelector('[data-feedback-message-id="task-a-result"]');
      assert.ok(record);
      assert.match(record.querySelector(".bot-task-reply-historical")?.textContent ?? "", /历史阶段记录/);
      assert.equal(record.querySelector(".bot-status-badge")?.textContent, "历史成果");
      assert.notEqual(record.querySelector(".bot-status-badge")?.textContent, "已完成");
      assert.match(record.querySelector(".bot-result-body")?.textContent ?? "", /第一版 API 结果和附件已保存/);
      assert.match(record.querySelector(".bot-result-files")?.textContent ?? "", /api-result-v1\.md/);
      assert.ok(record.querySelector('button[aria-label="预览 api-result-v1.md"]'), "the frozen result file remains inside this reply");
      assert.doesNotMatch(record.textContent ?? "", /没有文本回复/);
      assert.equal(card("task-a").querySelector(".bot-task-reply-status")?.textContent, "正在执行");
      assert.equal(tab("task-a", "result").getAttribute("data-state"), "pending");
      assert.equal(JSON.stringify(historical), originalRecord, "display-only history labels never rewrite the stored report");
      assert.equal(historical.workFeedback!.report!.current, true);
      assert.equal(useAppStore.getState().botHistories[ownerId].messages.find(item => item.messageId === historical.messageId), historical);
      assert.equal(container.querySelector("textarea#bot-draft"), composer); assert.equal(composer.value, "还没发送的草稿");
    });
    console.log(`PASS inline task reply: ${count} React DOM checks; no desktop layout or live-model claim`);
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    useAppStore.setState(original, true); container.remove();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
