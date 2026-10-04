import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationInteractionCard } from "../src/renderer/src/components/chat/ConversationRuntimeCards";
import MessageItem from "../src/renderer/src/components/chat/MessageItem";

const interaction = {
  id: "interaction-recovery",
  taskId: "task-a",
  executionId: "exec-a",
  assistantMessageId: "assistant-a",
  kind: "single_select" as const,
  title: "这 6 条被驳回的厂牌主料，走哪条路放行？",
  options: [
    { id: "fix-rule", label: "A. 修正规则并重建", recommended: true },
    { id: "reuse-master", label: "B. 复用现有主料" },
    { id: "handover", label: "C. 先停，交给 ERP 开发" },
  ],
  status: "pending" as const,
  version: 1,
  createdAt: 2,
};

const html = renderToStaticMarkup(createElement(ConversationInteractionCard, { interaction }));
assert.match(html, /需要你的回答/);
assert.match(html, /这 6 条被驳回的厂牌主料/);
assert.match(html, /修正规则并重建/);
assert.match(html, /推荐/);
assert.doesNotMatch(html, /request_user_input/);

const rawDirective = [
  "处理结果如下。",
  "<request_user_input>",
  JSON.stringify({
    title: interaction.title,
    kind: interaction.kind,
    options: interaction.options,
  }),
  "</request_user_input>",
].join("\n");
const messageHtml = renderToStaticMarkup(createElement(MessageItem, {
  message: {
    id: "assistant-a",
    role: "assistant",
    blocks: [],
    finalBlocks: [{ type: "text", text: rawDirective }],
    interactions: [interaction],
    createdAt: 1,
    streaming: false,
  },
}));
assert.match(messageHtml, /处理结果如下/);
assert.match(messageHtml, /需要你的回答/);
assert.doesNotMatch(messageHtml, /&lt;request_user_input&gt;/, "结构化卡片存在时不得渲染伪工具标签");
assert.doesNotMatch(messageHtml, /fix-rule.*reuse-master.*handover.*request_user_input/s);

const partialHtml = renderToStaticMarkup(createElement(MessageItem, {
  message: {
    id: "assistant-streaming",
    role: "assistant",
    blocks: [],
    finalBlocks: [{ type: "text", text: "处理中…\n<request_user_input>\n{\"title\":" }],
    createdAt: 1,
    streaming: true,
  },
}));
assert.match(partialHtml, /处理中/);
assert.doesNotMatch(partialHtml, /request_user_input/, "流式阶段不得泄露协议标签");

console.log("request_user_input interaction UI tests: ok");
