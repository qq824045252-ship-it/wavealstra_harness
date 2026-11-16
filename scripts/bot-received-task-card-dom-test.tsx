import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { BotReceivedTask } from "../src/renderer/src/lib/botReceivedTasks";
import type { BotMessageDto } from "../src/shared/bot-conversation";

const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
window.HTMLElement.prototype.focus = function () {};
const { createRoot } = await import("react-dom/client");
const { BotReceivedTaskCard } = await import("../src/renderer/src/components/pages/BotReceivedTaskCard");
const c: BotReceivedTask["collaboration"] = { collaborationId: "collab", userId: "user", sourceBotId: "source", sourceDisplayName: "委托者",
  sourceConversationId: "source-chat", sourceRequestId: "request", sourceUserMessageId: "user-msg", sourceAssistantMessageId: "assistant-msg",
  targetBotId: "recipient", targetDisplayName: "执行者", workId: "bound", createdAt: 1, updatedAt: 2, messageCount: 2,
  status: "returned", originAvailable: true, times: { sentAt: 1, deliveredAt: 1, acceptedAt: 1, startedAt: 1, endedAt: 2, returningAt: 2, returnedAt: 2 } };
const m: BotMessageDto = { messageId: "embedded", conversationId: "chat", botId: "recipient", requestId: "request", ordinal: 1,
  role: "assistant", text: "真实执行正文", status: "completed", workIds: [], createdAt: 2, updatedAt: 2 };
let board: BotReceivedTask = { key: "stable", collaboration: c, messages: [m], createdAt: 1, rows: [
  { collaboration: c, cursor: "1", message: { messageId: "request", collaborationId: "collab", ordinal: 1, senderBotId: "source", senderDisplayName: "委托者",
    kind: "request", text: "完整公开要求", createdAt: 1, operationId: "op1" } },
  { collaboration: c, cursor: "2", foregroundMessageIds: ["embedded"], message: { messageId: "reply", collaborationId: "collab", ordinal: 2,
    senderBotId: "recipient", senderDisplayName: "执行者", kind: "reply", text: "不应重复的原文", createdAt: 2, operationId: "op2" },
    summary: { text: "独立反馈不能丢", status: "completed", senderBotId: "source", senderDisplayName: "委托者", generated: true } },
  { collaboration: c, cursor: "3", message: { messageId: "report", collaborationId: "collab", ordinal: 3,
    senderBotId: "recipient", senderDisplayName: "执行者", kind: "result", text: "交付报告", createdAt: 3, operationId: "op3",
    workFeedback: { workId: "bound", eventId: "event", kind: "result", category: "result", report: {
      title: "交付报告", summary: "核验完成，报告已输出。", artifactRefs: ["/fixture/report.html"],
      files: [{ ref: "/fixture/report.html", name: "report.html", openPath: "/fixture/report.html" }],
      reviewStatus: "accepted", current: true, notices: [],
    } },
  } },
] };
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
let opened = "";
const render = () => root.render(<BotReceivedTaskCard board={board} renderMessage={message => <p>{message.text}</p>}
  onOpen={id => { opened = id; }} onRetrySummary={() => {}} />);
try {
  await act(async () => render());
  assert.equal(container.querySelectorAll('[role="tab"]').length, 4);
  assert.equal(container.querySelectorAll('[role="tabpanel"]').length, 4);
  const select = (stage: string) => act(async () => container.querySelector<HTMLButtonElement>(`[role="tab"][data-stage-id="${stage}"]`)!.click());
  assert.ok(container.querySelector('button[aria-label="预览 report.html"]'), "delivery retains the original file actions");
  await select("request");
  assert.ok(container.textContent?.includes("完整公开要求"));
  await select("execution");
  assert.ok(container.querySelector('[role="tabpanel"][data-stage-id="execution"]')?.textContent?.includes("真实执行正文"));
  await select("feedback");
  assert.ok(container.textContent?.includes("独立反馈不能丢"));
  assert.ok(container.textContent?.includes("记录摘要"));
  assert.ok(!container.textContent?.includes("不应重复的原文"));
  assert.ok(!container.querySelector('.bot-task-reply-status')?.textContent?.includes("任务已完成"));
  board = { ...board, collaboration: { ...c, workId: "bound", updatedAt: 3 } };
  await act(async () => render());
  assert.equal(container.querySelector('[data-stage-id="feedback"]')?.getAttribute("aria-selected"), "true");
  assert.equal(container.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute("aria-labelledby"), container.querySelector('[data-stage-id="feedback"]')?.id);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开协作记录"]')!.click());
  assert.equal(opened, "collab");
  console.log("recipient card DOM: 12 checks passed");
} finally { await act(async () => root.unmount()); }
