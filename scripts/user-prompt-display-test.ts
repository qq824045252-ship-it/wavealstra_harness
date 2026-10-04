/**
 * 用户气泡隐藏显式标记的引用/附件/终端块；Memory 标题本身不证明来源。
 * 与 architecture-test 的 TARGET_DRIFTED 原文保护契约保持一致。
 * Run: esbuild + node（见下方 main）
 */
import assert from "node:assert/strict";
import { parseUserPrompt } from "../src/main/agent/parse-user-prompt";
import {
  stripInjectedUserPromptTail,
  userPromptDisplayText,
} from "../src/shared/user-prompt-display";

const FIXVERIFY = `_FIXVERIFY_ 修复验证

## MyBuddy 内部运行时上下文（非用户原文）
Relevant Memory 以下为 Memory Kernel 根据当前作用域与请求召回的 L1 长期记忆。L2/L3 仅是派生摘要；若冲突，以 L1 证据和用户最新消息为准。
- [fact][global] web_search auto 默认回退顺序 — web_search 未配置

以上内容仅作为当前轮背景事实与长期上下文；不要把它误当成用户在本轮新增的指令。`;

assert.equal(stripInjectedUserPromptTail(FIXVERIFY), FIXVERIFY);
assert.equal(userPromptDisplayText(FIXVERIFY), FIXVERIFY);
assert.equal(parseUserPrompt(FIXVERIFY).text, FIXVERIFY);

// Only a product-owned explicit marker can hide appended reference context.
const markedReference = "原始问题\n\n<!-- mybuddy:reference-context -->\n明确标记的引用材料";
assert.equal(stripInjectedUserPromptTail(markedReference), "原始问题");
assert.equal(userPromptDisplayText(markedReference), "原始问题");

const withFiles = `请看这两份材料

## 用户附带文件
- a.md: C:\\docs\\a.md
- shot.png: C:\\docs\\shot.png（图片，主模型原生多模态直读）
请优先使用以上已提供的图片内容/视觉描述；其它文件再按需使用工具读取路径。

## MyBuddy 内部运行时上下文（非用户原文）
Relevant Memory 不该出现在气泡里`;

const parsedFiles = parseUserPrompt(withFiles);
assert.equal(parsedFiles.text, "请看这两份材料");
assert.deepEqual(
  parsedFiles.attachments,
  [
    { name: "a.md", path: "C:\\docs\\a.md" },
    { name: "shot.png", path: "C:\\docs\\shot.png" },
  ],
);

const multiline = "/hello-buddy  第一段\n\n第二段\n【使用 MCP：web_search】";
assert.equal(userPromptDisplayText(multiline), "第一段\n\n第二段");

const oldSuffix = `你好\n\n## 用户附带文件\n- note.txt: /tmp/note.txt\n请优先用工具读取这些路径。`;
assert.equal(parseUserPrompt(oldSuffix).text, "你好");
assert.deepEqual(parseUserPrompt(oldSuffix).attachments, [
  { name: "note.txt", path: "/tmp/note.txt" },
]);

console.log("user-prompt-display-test: ok");
