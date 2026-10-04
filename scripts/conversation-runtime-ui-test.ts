import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPatchToMessage } from "../src/renderer/src/store/appStore";
import { ConversationInteractionCard } from "../src/renderer/src/components/chat/ConversationRuntimeCards";
import MessageBlockView from "../src/renderer/src/components/chat/MessageBlockView";
import { getTaskDisplayStatus } from "../src/renderer/src/utils/taskFilters";
import type { ChatMessage, Task } from "../src/renderer/src/types";

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
assert.equal(getTaskDisplayStatus(task), "pending");

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

console.log("conversation runtime ui tests: ok");
