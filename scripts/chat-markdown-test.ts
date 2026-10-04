/**
 * chat-markdown-test.ts — Chat Markdown 架构回归测试。
 *
 * 1) markstream parser（stream-markdown-parser，纯函数）能力回归：
 *    GFM 表格 / 任务列表 checkbox / 代码块 / 数学公式（KaTeX 语法）→ 节点类型断言。
 * 2) 结构断言（明确结构证明）：MessageBlockView 不再有
 *    「streaming 纯文本 div ↔ settled react-markdown」renderer 切换；
 *    ChatMarkdown 是 text/thinking 的唯一渲染路径。
 * 3) 依赖与安全边界：markstream-react 已声明；htmlPolicy 默认安全（escape/safe）；
 *    不引入 raw HTML 执行（无 rehype-raw 路径）；mermaid/d2 未引入大依赖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getCustomNodeComponents } from "markstream-react";
import { getMarkdown, parseMarkdownToStructure } from "stream-markdown-parser";
import {
  directChatImageSource,
  isSvgArtifact,
  messageImageArtifacts,
  resolveChatImageArtifact,
  svgTextFromArtifactContent,
} from "../src/renderer/src/lib/chatImages";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { ChatMessage } from "../src/renderer/src/types";
import { artifactKindForFile } from "../src/main/workspace/WorkspaceService";
import {
  CHAT_MARKSTREAM_CUSTOM_ID,
  convertDollarMath,
  normalizeTexMathDelimiters,
} from "@/components/chat/ChatMarkdown";
import { normalizeStandaloneSvgBlocks } from "@/components/common/SvgFencePreview";
import { splitCanvasDocuments } from "@/lib/canvasDocuments";
import { isRenderableCanvasCode } from "@/components/chat/DetailCard";

// 本测试的 esbuild 命令沿用 classic JSX；生产构建使用自动 JSX runtime。
// 给服务端真实渲染夹具补齐 classic runtime，不影响应用代码。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function walkNodeTypes(node: { type: string; children?: unknown[]; items?: unknown[] }, out: string[]): void {
  out.push(node.type);
  (node.children ?? []).forEach((child) => walkNodeTypes(child as { type: string }, out));
  (node.items ?? []).forEach((child) => walkNodeTypes(child as { type: string }, out));
}

console.log("== 1) markstream parser 能力回归（GFM/代码/数学） ==");
{
  const md = getMarkdown();
  const source = [
    "# 标题",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- [x] 已完成",
    "- [ ] 待办",
    "",
    "```ts",
    "const x: number = 1;",
    "```",
    "",
    "公式 \\(E = mc^2\\) 与块级：",
    "$$",
    "\\int_0^1 x dx",
    "$$",
  ].join("\n");
  const nodes = parseMarkdownToStructure(source, md);
  const flat: string[] = [];
  const walk = (n: { type: string; children?: unknown[]; items?: unknown[] }): void => {
    flat.push(n.type);
    (n.children ?? []).forEach((c) => walk(c as { type: string }));
    (n.items ?? []).forEach((c) => walk(c as { type: string }));
  };
  nodes.forEach((n) => walk(n as { type: string }));
  assert(flat.includes("heading"), `标题节点（${flat.join(",")}）`);
  assert(flat.includes("table"), "GFM 表格节点");
  assert(flat.includes("checkbox_input") || flat.includes("checkbox"), "任务列表 checkbox 节点（list_item 内）");
  assert(flat.includes("code_block"), "代码块节点");
  assert(flat.includes("math_inline"), `行内数学节点（\\\(...\\\) 语法）（${flat.join(",")}）`);
  assert(flat.includes("math_block"), "块级数学节点");
  // 流式未闭合构造：表格未闭合 → 不崩溃、正常产出节点（markstream 流式语义）
  const partial = "| A | B |\n|---|---|\n| 1 |";
  const partialNodes = parseMarkdownToStructure(partial, md);
  assert(Array.isArray(partialNodes), "未闭合表格不崩（流式安全）");
}

console.log("== 1-preview) HTML/SVG 预览遵守 Markdown 围栏边界 ==");
{
  const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const split = (source: string) => splitCanvasDocuments(source, isRenderableCanvasCode);
  const after = "\n\n### 验证方式\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- **结论**：正常。";
  for (const fence of ["```", "````", "~~~", "~~~~"]) {
    const parts = split(`${fence}svg\n${svg}\n${fence}${after}`);
    const tail = parts.at(-1);
    assert(parts.length === 2 && parts[0]?.kind === "canvas" && tail?.kind === "text" && tail.text === after,
      `${fence} 完整围栏被整体提取，后续正文无残留围栏/语言标签`);
    const types = tail?.kind === "text" ? parseMarkdownToStructure(tail.text, getMarkdown()).map((n) => n.type) : [];
    assert(types.includes("heading") && types.includes("table") && !types.includes("code_block"),
      `${fence} 后续标题和表格由真实解析器正确识别`);
  }
  for (const source of [
    `\`\`\`text\n${svg}\n\`\`\`${after}`,
    `\`\`\`python\nvalue = '${svg}'\n\`\`\`${after}`,
    `\`\`\`\`markdown\n\`\`\`svg\n${svg}\n\`\`\`\n\`\`\`\`${after}`,
    `\`\`\`html\n<html><body>${svg}`,
    `\`\`\`html\n<html><body>${svg}\n\`\`\``,
    `\`\`\`\`svg\n${svg}\n\`\`\``,
    `\`\`\`svg\n${svg}\n\`\`\`html`,
    `    ${svg}${after}`,
    `- 示例\n\n  \`\`\`svg\n  ${svg}\n  \`\`\`${after}`,
    `引用代码 \`${svg}\`。${after}`,
  ]) {
    const parts = split(source);
    assert(parts.length === 1 && parts[0]?.kind === "text" && parts[0].text === source,
      `受保护/未闭合代码保持原样：${source.slice(0, 30)}`);
  }
  const withTicks = `\`\`\`html\n<html><script>const fence = '\`\`\`';</script></html>\n\`\`\`${after}`;
  assert(split(withTicks)[0]?.kind === "canvas" && split(withTicks).at(-1)?.kind === "text",
    "代码字符串中的三个反引号不能提前关闭围栏");
  const plain = "```ts\nconst x = 1;\n```\n\n" + svg + after;
  const parts = split(plain);
  assert(parts.length === 3 && parts[1]?.kind === "canvas" && parts[2]?.kind === "text" && parts[2].text === after,
    "正常代码不拆碎，独立原生 SVG 仍可预览");
  const crlf = `~~~svg\r\n${svg}\r\n~~~\r\n\r\n### 正文`;
  assert(split(crlf).at(-1)?.kind === "text" && (split(crlf).at(-1) as { text: string }).text.includes("### 正文"),
    "Windows CRLF 行号映射不截断后续内容");
}

console.log("== 1a) 过度转义 TeX 定界符兼容 ==");
{
  const standardInline = "在单电源 \\(V^+ = 5\\text{ V}, V^- = 0\\text{ V}\\) 条件下，\\(V_{CM}\\) 有效。";
  assert(normalizeTexMathDelimiters(standardInline) === standardInline, "标准单反斜杠 TeX 定界符保持原样");

  const overEscapedInline = "在单电源 \\\\(V^+ = 5\\text{ V}, V^- = 0\\text{ V}\\\\) 条件下，\\\\(V_{CM}\\\\) 有效。";
  const normalizedInline = normalizeTexMathDelimiters(overEscapedInline);
  assert(
    normalizedInline.includes("\\(V^+ = 5\\text{ V}, V^- = 0\\text{ V}\\)") &&
      normalizedInline.includes("\\(V_{CM}\\)"),
    "双反斜杠 \\\\(...\\\\) 收敛为标准 \\(...\\)",
  );
  const inlineTypes: string[] = [];
  const walkMath = (node: { type: string; children?: unknown[]; items?: unknown[] }): void => {
    inlineTypes.push(node.type);
    (node.children ?? []).forEach((child) => walkMath(child as { type: string }));
    (node.items ?? []).forEach((child) => walkMath(child as { type: string }));
  };
  parseMarkdownToStructure(normalizedInline, getMarkdown()).forEach((node) => walkMath(node as { type: string }));
  assert(inlineTypes.filter((type) => type === "math_inline").length >= 2, "\\text 等命令进入 math_inline 而非裸文本");

  const overEscapedBlock = "\\\\[V_{CM}=V^+-2.5\\text{ V}\\\\]";
  const normalizedBlock = normalizeTexMathDelimiters(overEscapedBlock);
  const blockTypes = parseMarkdownToStructure(normalizedBlock, getMarkdown()).map((node) => (node as { type: string }).type);
  assert(blockTypes.includes("math_block"), "双反斜杠 \\\\[...\\\\] 收敛后进入 math_block");

  const inlineCode = "代码 `\\\\(x\\\\)`，正文 \\\\(y=20\\mu\\text{A}\\\\)";
  const inlineCodeOut = normalizeTexMathDelimiters(inlineCode);
  assert(
    inlineCodeOut.includes("`\\\\(x\\\\)`") && inlineCodeOut.includes("\\(y=20\\mu\\text{A}\\)"),
    "行内代码中的过度转义 TeX 原样保留，正文正常收敛",
  );
  const fenced = "```txt\\n\\\\(x\\\\)\\n```\\n正文 \\\\(y\\\\)".replace(/\\n/g, "\n");
  const fencedOut = normalizeTexMathDelimiters(fenced);
  assert(fencedOut.includes("\\\\(x\\\\)") && fencedOut.includes("\\(y\\)"), "代码围栏内不转换");
  assert(normalizeTexMathDelimiters("流式未闭合 \\\\(x") === "流式未闭合 \\\\(x", "未闭合过度转义定界符保持原文");
}

console.log("== 1b) convertDollarMath 行内 $ 兼容（remark-math 语义对齐） ==");
{
  const out = convertDollarMath("公式 $E=mc^2$ 测试");
  assert(out.includes("\\(E=mc^2\\)"), `$...$ → \\(...\\)（${out}）`);
  const dollarTypes: string[] = [];
  parseMarkdownToStructure(out, getMarkdown()).forEach((node) => walkNodeTypes(node as { type: string; children?: unknown[]; items?: unknown[] }, dollarTypes));
  assert(dollarTypes.includes("math_inline"), "$...$ 兼容转换后仍由 markstream 解析为 math_inline");
  const fencedSource = "```ts\nconst s = \"$100\";\n```\n价格 $5 和 $6";
  const fenced = convertDollarMath(fencedSource);
  assert(fenced === fencedSource, "代码围栏换行及围栏内 $ 原样保留");
  const tildeFence = "~~~ts\nconst formula = '$x$';\n~~~\n正文 $y$";
  const tildeOut = convertDollarMath(tildeFence);
  assert(
    tildeOut.includes("const formula = '$x$';") && tildeOut.includes("\\(y\\)"),
    "波浪线围栏内 $ 保留、围栏外继续转换",
  );
  const inlineCode = convertDollarMath("代码 `$x$`，正文 $y$");
  assert(
    inlineCode.includes("`$x$`") && inlineCode.includes("\\(y\\)"),
    "行内代码中的 $ 原样保留",
  );
  assert(convertDollarMath("流式未闭合 `$x$") === "流式未闭合 `$x$", "未闭合 code span 不抖动");
  const mathShort = convertDollarMath("变量 $x$ 和 $y$");
  assert(mathShort.includes("\\(x\\)") && mathShort.includes("\\(y\\)"), "短内容 $x$ 转换");
  const mathTex = convertDollarMath("$E=mc^2$");
  assert(mathTex.includes("\\(E=mc^2\\)"), "TeX 特征内容转换");
  assert(convertDollarMath("无美元符号") === "无美元符号", "无 $ 原样返回");
  const unclosed = convertDollarMath("未闭合 $x");
  assert(unclosed.includes("$x"), "未闭合 $ 保持原文（流式安全）");
  const block = convertDollarMath("$$\n\\int dx\n$$").includes("$$") && convertDollarMath("$$\n\\int dx\n$$").includes("\\int");
  assert(block, "块级 $$ 不转换");
  const rawSvg = "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>";
  const normalizedSvg = normalizeStandaloneSvgBlocks(rawSvg);
  assert(normalizedSvg.startsWith("```svg\n") && normalizedSvg.endsWith("\n```"), "原生 SVG block 自动归一化为 SVG 围栏");
  const fencedSvg = "```svg\n" + rawSvg + "\n```";
  assert(normalizeStandaloneSvgBlocks(fencedSvg) === fencedSvg, "已有 SVG 围栏不重复包装");
}

console.log("== 2) 结构断言：无 renderer 类型切换（正文区） + thinking 独立纯文本 ==");
{
  const view = readFileSync(join(process.cwd(), "src", "renderer", "src", "components", "chat", "MessageBlockView.tsx"), "utf8");
  // 正文（text）恒走 ChatMarkdown：无 streaming 条件分支、无 react-markdown 直连
  assert(view.includes("<ChatMarkdown text={block.text} streaming={Boolean(streaming)}"), "text 分支恒 ChatMarkdown（无切换）");
  assert(!view.includes("<Markdown messageId"), "MessageBlockView 不直连 react-markdown");
  assert(!view.includes('block.type === "text" && streaming'), "正文无 streaming 条件渲染");
  // thinking 回归修复：独立纯文本 renderer（避免 markstream 深层 DOM 与思考区
  // background-clip:text 渐变不兼容导致正文不可见）；直接文本节点保证完整可见
  assert(view.includes('case "thinking"') && view.includes("streaming-plain-text"), "thinking 走独立纯文本 renderer");
  const chatMarkdown = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "components", "chat", "ChatMarkdown.tsx"),
    "utf8",
  );
  assert(chatMarkdown.includes("markstream-react"), "ChatMarkdown 封装 markstream-react");
  assert(chatMarkdown.includes('htmlPolicy="safe"'), "安全边界：htmlPolicy=safe");
  assert(chatMarkdown.includes("renderCodeBlocksAsPre"), "代码块走 pre（不引入 Monaco）");
  assert(
    chatMarkdown.includes("setCustomComponents(CHAT_MARKSTREAM_CUSTOM_ID, CHAT_CUSTOM_COMPONENTS)") &&
      chatMarkdown.includes("customId={CHAT_MARKSTREAM_CUSTOM_ID}"),
    "聊天代码块通过独立 customId 注册自定义渲染器",
  );
  assert(chatMarkdown.includes("smoothStreaming={false}") && !chatMarkdown.includes("CHAT_SMOOTH_STREAMING_OPTIONS"), "正文只使用 provider 流式时钟，禁用 markstream 二次平滑调度避免长文闪屏");
  assert(
    chatMarkdown.includes("const everStreamedRef = useRef(streaming)") &&
      chatMarkdown.includes("const markstreamFinal = !streaming && !everStreamedRef.current") &&
      chatMarkdown.includes("final={markstreamFinal}") &&
      !chatMarkdown.includes("final={!streaming}"),
    "流式正文完成时保持 markstream final 上下文稳定，避免 assistant_end 全节点重绘闪一下",
  );
  assert(
    chatMarkdown.includes("batchRendering={false}") &&
      !chatMarkdown.includes("renderBatchSize=") &&
      chatMarkdown.includes("deferNodesUntilVisible={false}") &&
      chatMarkdown.includes("maxLiveNodes={0}"),
    "聊天完全禁用 markstream 内部分批/离屏虚拟化，避免新增顶层节点时回退到首批占位造成大块闪屏",
  );
  assert(chatMarkdown.includes("inline_code: ChatInlineCodeNode"), "行内代码保留本地文件芯片能力");
  assert(!chatMarkdown.includes("rehype-raw"), "无 raw HTML 执行");
  assert(
    chatMarkdown.includes("isSvgFenceLanguage") && chatMarkdown.includes("<SvgFencePreview code={node.code} />"),
    "聊天 SVG 围栏接入共享安全预览组件",
  );
  const commonMarkdown = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "components", "common", "Markdown.tsx"),
    "utf8",
  );
  assert(
    commonMarkdown.includes("isSvgFenceLanguage(extracted.language)") &&
      commonMarkdown.includes("<SvgFencePreview code={extracted.code} />"),
    "右侧 Markdown 文档预览支持 SVG 围栏",
  );
  // 流式 ```` → ````md 时同一 ChatCodeBlockNode 实例换分支；hook 必须全部在提前 return 之前。
  {
    const fnStart = chatMarkdown.indexOf("function ChatCodeBlockNode");
    assert(fnStart >= 0, "ChatCodeBlockNode 存在");
    const fnEnd = chatMarkdown.indexOf("function ChatDiagramFallbackNode", fnStart);
    const fnBody = fnEnd > fnStart ? chatMarkdown.slice(fnStart, fnEnd) : "";
    const early = fnBody.search(/if\s*\(\s*(isMdFence|MD_FENCE_LANGS\.has\(lang\))\s*\)/);
    assert(early >= 0, "ChatCodeBlockNode 仍有 md 围栏提前 return");
    const after = fnBody.slice(early);
    assert(
      !/\buse(State|Effect|Memo|Callback|Ref|Context|LayoutEffect)\s*\(/.test(after),
      "ChatCodeBlockNode 提前 return 之后不得再调用 hook（流式 lang 变化会整树崩溃灰屏）",
    );
  }
  // 思考区渐变与 markstream 的隔离（CSS 修复证据）
  const css = readFileSync(join(process.cwd(), "src", "renderer", "src", "styles", "global.css"), "utf8");
  assert(
    css.includes(".assistant-reasoning.streaming .assistant-reasoning-content") &&
      css.includes("-webkit-text-fill-color: currentColor") &&
      !css.includes("background-attachment: local"),
    "思考区 streaming 使用稳定实色文本，不触发滚动背景逐 token 重绘",
  );
  assert(
    css.includes("content-visibility: visible") && css.includes("contain-intrinsic-size: auto"),
    "关闭 markstream 600px 离屏固有高度，避免与消息虚拟列表冲突",
  );
  assert(
    /\.assistant-reasoning-content \.timeline-text,[\s\S]{0,100}\.assistant-reasoning-content \.streaming-plain-text \{[\s\S]{0,220}width: 100%;[\s\S]{0,100}min-width: 0;/.test(
      css,
    ),
    "思考纯文本显式占满时间线宽度，不退回中文 min-content 竖排",
  );
  const codeThemeCss = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "styles", "systemTypography.css"),
    "utf8",
  );
  assert(
    codeThemeCss.includes('html[data-code-theme] .md-chat pre') &&
      codeThemeCss.includes('html[data-code-theme] .md .hljs-keyword'),
    "代码主题覆盖聊天代码框与高亮 token",
  );

  const RegisteredCodeBlock = getCustomNodeComponents(CHAT_MARKSTREAM_CUSTOM_ID).code_block as
    | React.ComponentType<{ node: { type: "code_block"; language: string; code: string } }>
    | undefined;
  const renderedCode = RegisteredCodeBlock
    ? renderToStaticMarkup(
        React.createElement(RegisteredCodeBlock, {
          node: { type: "code_block", language: "ts", code: "const answer = 42;" },
        }),
      )
    : "";
  assert(
    CHAT_MARKSTREAM_CUSTOM_ID === "mybuddy-chat" &&
      renderedCode.includes('class="md-pre"') &&
      renderedCode.includes('title="复制代码"'),
    "真实聊天代码块渲染复制按钮",
  );
  const renderedSvg = RegisteredCodeBlock
    ? renderToStaticMarkup(
        React.createElement(RegisteredCodeBlock, {
          node: {
            type: "code_block",
            language: "svg",
            code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
          },
        }),
      )
    : "";
  assert(
    renderedSvg.includes('class="md-svg-card"') && renderedSvg.includes("SVG 图形"),
    "聊天 SVG 围栏进入安全 SVG 预览卡，而不是源码代码框",
  );
  const RegisteredInlineCode = getCustomNodeComponents(CHAT_MARKSTREAM_CUSTOM_ID).inline_code as
    | React.ComponentType<{ node: { type: "inline_code"; code: string } }>
    | undefined;
  const renderedInlineCode = RegisteredInlineCode
    ? renderToStaticMarkup(
        React.createElement(RegisteredInlineCode, {
          node: { type: "inline_code", code: "v0.1.0" },
        }),
      )
    : "";
  assert(
    renderedInlineCode.includes('class="inline-code"') && renderedInlineCode.includes("v0.1.0"),
    "行内代码读取 markstream node.code 并显示文字",
  );

  const callout = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "components", "chat", "CalloutBlock.tsx"),
    "utf8",
  );
  const detail = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "components", "chat", "DetailCard.tsx"),
    "utf8",
  );
  assert(callout.includes("ChatMarkdown") && !callout.includes("components/common/Markdown"), "Callout 统一 ChatMarkdown");
  assert(
    detail.includes('<ChatMarkdown text={content} streaming={false} variant="document" />') &&
      !detail.includes('from "react-markdown"'),
    "DetailCard Markdown 预览统一 ChatMarkdown",
  );
  assert(
    view.includes('if (block.type === "text")') &&
      !view.includes('if (!streaming && block.type === "text")'),
    "完整 Canvas 在流式阶段即切换详情卡，不等待定稿重建",
  );
}

console.log("== 3) 聊天图片路径、来源归属和真实节点渲染 ==");
{
  const descriptor: ArtifactDescriptor = {
    id: "image-1", taskId: "task-1", kind: "image", version: 1,
    source: { type: "workspace-file", rootDir: "C:/tasks/one", entryFile: "C:/tasks/one/generated/image/测试 (1).png" },
    capabilities: {}, createdAt: 1, updatedAt: 1,
    createdByMessageId: "live-message", createdByToolCallId: "generate-call",
  };
  const other = { ...descriptor, id: "other", taskId: "task-2" };
  const descriptors = [descriptor, other];
  for (const path of ["C:\\tasks\\one\\generated\\image\\测试 (1).png", "file:///C:/tasks/one/generated/image/%E6%B5%8B%E8%AF%95%20(1).png", "generated/image/测试 (1).png", "mybuddy-artifact://local/image-1/"]) {
    assert(resolveChatImageArtifact(path, descriptors, "task-1", "C:/tasks/one")?.id === "image-1", `任务图片引用可解析：${path}`);
  }
  for (const path of ["C:/outside/测试 (1).png", "测试 (1).png", "../one/generated/image/测试 (1).png", "mybuddy-artifact://local/other/", "mybuddy-artifact://local/image-1/other.png"]) {
    assert(!resolveChatImageArtifact(path, descriptors, "task-1", "C:/tasks/one"), `不猜测文件名、不跨任务或任意读盘：${path}`);
  }
  const data = "data:image/png;base64,iVBORw0KGgo=";
  const percentFile = { ...descriptor, id: "percent", source: { type: "workspace-file" as const, rootDir: "C:/tasks/one", entryFile: "C:/tasks/one/图%20一.png" } };
  const spaceFile = { ...percentFile, id: "space", source: { ...percentFile.source, entryFile: "C:/tasks/one/图 一.png" } };
  assert(resolveChatImageArtifact("图%2520一.png", [percentFile, spaceFile], "task-1", "C:/tasks/one")?.id === "percent", "URL只解码一次，磁盘文件名的百分号保留");
  assert(resolveChatImageArtifact("图%20一.png", [percentFile, spaceFile], "task-1", "C:/tasks/one")?.id === "space", "空格文件不与百分号文件混淆");
  assert(!resolveChatImageArtifact("generated/image/测试 (1).png", descriptors, null, "C:/tasks/one"), "无任务上下文的Gateway消息不借用活动任务的图片");
  assert(directChatImageSource(data) === data, "PNG data URL 可显示");
  assert(Boolean(directChatImageSource("data:image/jpeg;base64,/9j/")), "JPEG data URL 可显示");
  assert(Boolean(directChatImageSource("https://example.com/image.png")), "HTTPS 图片可显示");
  for (const src of ["javascript:alert(1)", "file:///C:/secret.png", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", "https://user:password@example.com/img.png"]) {
    assert(!directChatImageSource(src), "拒绝不安全的直接图片源");
  }
  const message: ChatMessage = {
    id: "hist-asst-regenerated", role: "assistant", createdAt: 1,
    blocks: [{ type: "tool", toolCall: { id: "generate-call", tool: "image_generate", summary: "生成", status: "success" } }],
  };
  assert(messageImageArtifacts(message, descriptors, "task-1").map((d) => d.id).join() === "image-1", "历史恢复按稳定 toolCallId 找回生成图，不受 hist 消息 id 影响");
  assert(messageImageArtifacts({ ...message, blocks: [], artifactIds: [descriptor.id] }, descriptors, "task-1").length === 0, "产物孤儿挂接不导致图片串到最后一条回复");
  assert(messageImageArtifacts({ ...message, id: "live-message", blocks: [] }, descriptors, "task-1").length === 1, "生成事件到达时按消息归属显示图片");
  const screenshotMessage: ChatMessage = { ...message, blocks: [{ type: "tool", toolCall: { id: "generate-call", tool: "computer_exec", summary: "截图", status: "success" } }] };
  assert(messageImageArtifacts(screenshotMessage, descriptors, "task-1").length === 0, "内部观察截图不自动刷入最终回答");

  const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const svgDescriptor: ArtifactDescriptor = {
    ...descriptor,
    id: "svg-1",
    kind: "svg",
    title: "趋势图.svg",
    source: { type: "workspace-file", rootDir: "C:/tasks/one", entryFile: "C:/tasks/one/趋势图.svg" },
  };
  const legacySvgDescriptor: ArtifactDescriptor = {
    ...svgDescriptor,
    id: "legacy-svg",
    kind: "image",
    capabilities: { originalKind: "image" },
  };
  assert(artifactKindForFile("C:/tasks/one/趋势图.svg") === "svg", "新 SVG 以 svg kind 登记，不再误归类为位图");
  assert(isSvgArtifact(svgDescriptor) && isSvgArtifact(legacySvgDescriptor), "新旧 SVG descriptor 都进入 SVG 兼容预览");
  assert(resolveChatImageArtifact("C:/tasks/one/趋势图.svg", [svgDescriptor], "task-1", "C:/tasks/one")?.id === "svg-1", "Markdown SVG 路径可按任务精确解析");
  assert(messageImageArtifacts(message, [svgDescriptor], "task-1")[0]?.id === "svg-1", "模型只输出文件链接时 SVG 仍随所属回复内联显示");
  assert(svgTextFromArtifactContent(svgMarkup) === svgMarkup, "原始 SVG Artifact 内容可显示");
  const svgWithXmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + svgMarkup;
  assert(svgTextFromArtifactContent(svgWithXmlDeclaration) === svgMarkup, "带 XML 声明的标准 SVG Artifact 可显示");
  const normalizedXmlSvg = normalizeStandaloneSvgBlocks(svgWithXmlDeclaration);
  const markdownFence = String.fromCharCode(96).repeat(3);
  const lineFeed = String.fromCharCode(10);
  assert(
    normalizedXmlSvg.startsWith(markdownFence + "svg" + lineFeed + "<?xml") && normalizedXmlSvg.endsWith(lineFeed + markdownFence),
    "带 XML 声明的原生 SVG block 自动归一化为 SVG 围栏",
  );
  const encodedSvg = `data:image/svg+xml;base64,${Buffer.from(svgMarkup).toString("base64")}`;
  assert(svgTextFromArtifactContent(encodedSvg) === svgMarkup, "历史 image-kind SVG data URL 可兼容解码");
  assert(directChatImageSource(encodedSvg) === null, "任意消息正文中的 SVG data URL 仍不绕过 Artifact 安全边界");

  const nodes = parseMarkdownToStructure("说明之前\n\n![示意图](<C:/tasks/one/generated/image/测试 (1).png>)\n\n说明之后", getMarkdown());
  const imageNodes: Array<{ type: string; src: string; alt?: string }> = [];
  const collect = (node: any): void => {
    if (node.type === "image") imageNodes.push(node);
    (node.children ?? []).forEach(collect);
  };
  nodes.forEach(collect);
  assert(imageNodes[0]?.src === "C:/tasks/one/generated/image/%E6%B5%8B%E8%AF%95%20(1).png" || resolveChatImageArtifact(imageNodes[0]?.src ?? "", descriptors, "task-1", "C:/tasks/one")?.id === "image-1", "真实 parser 保留本地图片引用给自定义 image renderer");
  const RegisteredImage = getCustomNodeComponents(CHAT_MARKSTREAM_CUSTOM_ID).image as React.ComponentType<{ node: { type: "image"; src: string; alt: string } }> | undefined;
  const markup = RegisteredImage ? renderToStaticMarkup(React.createElement(RegisteredImage, { node: { type: "image", src: data, alt: "示意图" } })) : "";
  assert(markup.includes('<img') && markup.includes(data) && markup.includes('alt="示意图"'), "真实注册的图片节点输出 img，而非产物芯片");
  assert(markup.includes('referrerPolicy="no-referrer"') || markup.includes('referrerpolicy="no-referrer"'), "远程图片不携带 Referer");
}

console.log("== 4) 依赖声明 ==");
{
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const declaredMarkstream =
    pkg.dependencies?.["markstream-react"] ?? pkg.devDependencies?.["markstream-react"];
  assert(typeof declaredMarkstream === "string", "markstream-react 已声明依赖");
  // 大 peer 未误装（体积/风险控制）
  for (const dep of ["mermaid", "stream-monaco", "@antv/infographic", "@terrastruct/d2"]) {
    assert(pkg.dependencies[dep] === undefined, `未引入 ${dep} 大依赖`);
  }
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);





