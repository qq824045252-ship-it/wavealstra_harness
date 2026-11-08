/**
 * ChatMarkdown — Chat assistant prose 的统一 Markdown renderer（streaming ↔ settled 同一组件）。
 *
 * 基于 markstream-react（NodeRenderer）：输入模型 = 不断增长的完整 markdown 字符串 +
 * final 标志（与 MyBuddy 现有 text_delta 拼接协议一致，不改 AgentService/IPC）。
 * - streaming（final=false）：增量解析渲染，未闭合构造（表格/代码块/数学）延迟完成；
 * - settled（final=true）：同一组件树稳定为最终形态——不再发生
 *   「streaming 纯文本 div → react-markdown 全量重建」的 renderer 切换。
 *
 * 自定义节点（安全与能力保持）：
 * - link：复用 MdFileLink（产物链接/外链系统浏览器/锚点，行为与旧 renderer 一致）；
 * - image：按当前任务的产物路径加载，保留正文图文位置；HTTPS/data 图片直接显示；
 * - code_block：highlight.js（common 语言集）高亮 + 复制按钮 + 语言标签；
 *   ```md/```markdown 围栏 → Markdown 预览卡（含递归深度防护）；流式（loading）时
 *   不高亮（避免每 delta 全量 hljs）；
 * - mermaid / d2 / infographic：无对应运行时依赖 → 安全降级为源码 pre（不引入
 *   mermaid/d2 大依赖，不阻塞核心目标）。
 *
 * 安全边界：htmlPolicy="safe"（白名单标签渲染，其余转义；不执行 raw HTML / script）。
 */
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import MarkdownRender, { setCustomComponents } from "markstream-react";
import type { NodeComponentProps } from "markstream-react";
import "markstream-react/index.css";
import hljs from "highlight.js/lib/common";
import { useAppStore } from "@/store/appStore";
import { MdFileLink } from "@/components/common/MdFileLink";
import { LocalFileChip } from "@/components/common/FileBadge";
import { IconCheck, IconCopy } from "@/components/common/icons";
import SvgFencePreview, { isSvgFenceLanguage, normalizeStandaloneSvgBlocks } from "@/components/common/SvgFencePreview";
import { looksLikeLocalFilePath } from "@/lib/localFilePath";
import { ChatImage } from "./ChatImage";

// ---------- markstream 节点形状（与 stream-markdown-parser 输出对齐） ----------

interface MarkstreamLinkNode {
  type: "link";
  href: string;
  title: string | null;
  text: string;
}

interface MarkstreamCodeBlockNode {
  type: "code_block";
  language: string;
  code: string;
  loading?: boolean;
}

interface MarkstreamInlineCodeNode {
  type: "inline_code";
  code: string;
}


// ---------- 自定义节点 ----------

const TaskFileScopeContext = createContext(true);

function ChatLinkNode({ node }: NodeComponentProps<MarkstreamLinkNode>): React.JSX.Element {
  const resolveTaskFiles = useContext(TaskFileScopeContext);
  if (!resolveTaskFiles) {
    // Bot history has no ordinary Task scope. Never resolve a basename against
    // whichever unrelated Task happens to remain selected behind Bot mode.
    if (/^https?:\/\//i.test(node.href)) return <a href={node.href} className="md-link" onClick={event => {
      event.preventDefault(); window.api?.browser?.openExternal?.(node.href);
    }}>{node.text}</a>;
    if (node.href.startsWith("#")) return <a href={node.href} className="md-link md-anchor">{node.text}</a>;
    return <span title={`文件引用：${node.href}（请从关联事项查看）`}>{node.text}</span>;
  }
  return <MdFileLink href={node.href}>{node.text}</MdFileLink>;
}

function ChatInlineCodeNode({ node }: NodeComponentProps<MarkstreamInlineCodeNode>): React.JSX.Element {
  const code = node.code ?? "";
  const resolveTaskFiles = useContext(TaskFileScopeContext);
  if (resolveTaskFiles && looksLikeLocalFilePath(code)) return <LocalFileChip path={code.trim()} />;
  return <code className="inline-code">{code}</code>;
}

const MD_FENCE_LANGS = new Set(["markdown", "md", "gfm"]);

/** ```md 围栏 → Markdown 文档预览卡（预览/源码切换 + 复制）；深度防护防递归。 */
function ChatMdFenceCard({ code, depth }: { code: string; depth: number }): React.JSX.Element {
  const resolveTaskFiles = useContext(TaskFileScopeContext);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-fence-card">
      <div className="md-fence-toolbar">
        <span className="md-fence-label">Markdown 文档</span>
        <div className="md-fence-actions">
          <button type="button" className={`md-fence-btn ${mode === "preview" ? "active" : ""}`} onClick={() => setMode("preview")}>
            预览
          </button>
          <button type="button" className={`md-fence-btn ${mode === "source" ? "active" : ""}`} onClick={() => setMode("source")}>
            源码
          </button>
          <button type="button" className="md-fence-btn" title="复制 Markdown 源码" onClick={copy}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {mode === "preview" ? (
        <div className="md-fence-preview">
          {depth >= 1 ? (
            <pre className="md-fence-source">{code}</pre>
          ) : (
            <ChatMarkdown
              text={code}
              streaming={false}
              variant="document"
              fenceDepth={depth + 1} resolveTaskFiles={resolveTaskFiles}
            />
          )}
        </div>
      ) : (
        <pre className="md-fence-source">{code}</pre>
      )}
    </div>
  );
}

function ChatCodeBlockNode({ node }: NodeComponentProps<MarkstreamCodeBlockNode>): React.JSX.Element {
  const fenceDepth = useContext(FenceDepthContext);
  const isStreaming = node.loading === true;
  const lang = (node.language ?? "").toLowerCase().trim();
  const isMdFence = MD_FENCE_LANGS.has(lang);
  const isSvgFence = isSvgFenceLanguage(lang);

  // hooks 必须无条件先跑完。流式 ```` → ````md 时同一实例会换分支；
  // 提前 return 再 useState 会触发 "Rendered more/fewer hooks" → 整树卸掉灰屏。
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // 流式时不高亮（避免每 delta 全量 hljs）；settled 后一次性高亮（rAF 合并）
  useEffect(() => {
    if (isMdFence || isSvgFence || isStreaming) {
      setHighlighted(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      try {
        const known = lang && hljs.getLanguage(lang);
        const out = known ? hljs.highlight(node.code, { language: lang }).value : hljs.highlightAuto(node.code).value;
        setHighlighted(out);
      } catch {
        setHighlighted(null);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [node.code, lang, isStreaming, isMdFence, isSvgFence]);

  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(node.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isMdFence) {
    return <ChatMdFenceCard code={node.code} depth={fenceDepth} />;
  }
  if (isSvgFence) {
    return <SvgFencePreview code={node.code} />;
  }

  return (
    <div className="md-pre">
      {lang && <span className="md-pre-lang">{lang}</span>}
      <button className="md-pre-copy" title="复制代码" onClick={copy} type="button">
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <pre className={highlighted ? "hljs" : undefined}>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{node.code}</code>
        )}
      </pre>
    </div>
  );
}

/** 无 mermaid/d2/infographic 运行时 → 源码 pre 降级（不引入大依赖、不执行图表代码）。 */
function ChatDiagramFallbackNode({
  node,
  label,
}: NodeComponentProps<Record<string, unknown>> & { label: string }): React.JSX.Element {
  const code = typeof node.code === "string" ? node.code : "";
  return (
    <div className="md-pre">
      <span className="md-pre-lang">{label}</span>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------- 主组件 ----------

/**
 * ```md 围栏预览卡递归深度（模块级 context，避免 streamingComponents 闭包组件每次渲染新建引用）。
 */
const FenceDepthContext = createContext(0);

/**
 * markstream 0.0.55 的内建 code_block 只从 customId 对应的组件表取覆盖项，
 * streamingComponents 仅处理 parser-backed 自定义标签。用独立 customId 注册，
 * 避免影响右侧文档预览等其他 Markdown renderer。
 */
export const CHAT_MARKSTREAM_CUSTOM_ID = "mybuddy-chat";
const CHAT_CUSTOM_COMPONENTS = {
  link: ChatLinkNode,
  image: ({ node }: NodeComponentProps<{ type: "image"; src: string; alt?: string; title?: string | null; loading?: boolean }>) => (
    <ChatImage source={node.src} alt={node.alt} title={node.title ?? undefined} loading={node.loading} />
  ),
  inline_code: ChatInlineCodeNode,
  code_block: ChatCodeBlockNode,
  mermaid: (props: NodeComponentProps<Record<string, unknown>>) => <ChatDiagramFallbackNode {...props} label="mermaid" />,
  d2: (props: NodeComponentProps<Record<string, unknown>>) => <ChatDiagramFallbackNode {...props} label="d2" />,
  infographic: (props: NodeComponentProps<Record<string, unknown>>) => (
    <ChatDiagramFallbackNode {...props} label="infographic" />
  ),
} as const;
setCustomComponents(CHAT_MARKSTREAM_CUSTOM_ID, CHAT_CUSTOM_COMPONENTS);

/**
 * 行内数学兼容：markstream parser 认 `\\(...\\)`（字面双反斜杠）但不认
 * 模型惯用的 `$...$`（remark-math 语义）。把围栏外的成对 `$...$`（同行、内容
 * 无 `$`、非 `$$`）转为 `\\(...\\)`——与现有 remark-math 启发式一致；
 * 代码围栏内不处理（原样保留）。未闭合 `$` 保持原文（流式中先按文本显示）。
 */
export function convertDollarMath(source: string): string {
  if (!source.includes("$")) return source;
  const parts: string[] = [];
  let cursor = 0;
  let proseStart = 0;
  let fenceStart = -1;
  let fence: { char: "`" | "~"; length: number } | null = null;

  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? source.length : newline + 1;
    const line = source.slice(cursor, newline === -1 ? source.length : newline).replace(/\r$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (!fence && marker) {
      parts.push(convertInlineDollarOutsideCode(source.slice(proseStart, cursor)));
      fence = {
        char: marker[1]![0] as "`" | "~",
        length: marker[1]!.length,
      };
      fenceStart = cursor;
    } else if (fence && marker) {
      const run = marker[1]!;
      const closesFence =
        run[0] === fence.char && run.length >= fence.length && marker[2]!.trim().length === 0;
      if (closesFence) {
        parts.push(source.slice(fenceStart, lineEnd));
        fence = null;
        fenceStart = -1;
        proseStart = lineEnd;
      }
    }

    cursor = lineEnd;
  }

  if (fence && fenceStart >= 0) parts.push(source.slice(fenceStart));
  else parts.push(convertInlineDollarOutsideCode(source.slice(proseStart)));
  return parts.join("");
}

/** 只转换普通 Markdown 文本；成对或流式未闭合的反引号 code span 原样保留。 */
function convertInlineDollarOutsideCode(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("`", cursor);
    if (open === -1) {
      parts.push(convertInlineDollar(text.slice(cursor)));
      break;
    }
    parts.push(convertInlineDollar(text.slice(cursor, open)));
    let openEnd = open + 1;
    while (text[openEnd] === "`") openEnd += 1;
    const runLength = openEnd - open;
    let search = openEnd;
    let closeEnd = -1;
    while (search < text.length) {
      const candidate = text.indexOf("`", search);
      if (candidate === -1) break;
      let candidateEnd = candidate + 1;
      while (text[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - candidate === runLength) {
        closeEnd = candidateEnd;
        break;
      }
      search = candidateEnd;
    }
    if (closeEnd === -1) {
      parts.push(text.slice(open));
      break;
    }
    parts.push(text.slice(open, closeEnd));
    cursor = closeEnd;
  }
  return parts.join("");
}

function convertInlineDollar(text: string): string {
  // 启发式（与 remark-math 对齐但保护价格/普通文本）：
  // - 内容含 TeX 特征（\ ^ _ { } 等）→ 数学；
  // - 或短内容（≤4 字符纯字母数字，如 $x$）→ 数学；
  // - 其余（如 "$5 和 $6"）保持原文，避免破坏价格。
  return text.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (full, pre: string, inner: string) => {
    const tex = /[\\^_{}]/.test(inner);
    const short = inner.length <= 4 && /^[A-Za-z0-9]+$/.test(inner);
    if (!tex && !short) return full;
    return `${pre}\\(${inner}\\)`;
  });
}

/**
 * Some providers/messages arrive with TeX delimiters over-escaped as two literal backslashes
 * (`\\(...\\)` / `\\[...\\]`). stream-markdown-parser parses the standard one-backslash form
 * (`\(...\)` / `\[...\]`); the over-escaped form is treated as plain Markdown text, leaving
 * commands such as `\text`, `\mu`, `\approx`, `\circ` visible to the user.
 *
 * Collapse only complete over-escaped delimiter pairs and only outside fenced/inline code.
 * Standard delimiters and incomplete streaming pairs are left untouched.
 */
export function normalizeTexMathDelimiters(source: string): string {
  if (!source.includes("\\\\(") && !source.includes("\\\\[")) return source;

  const transform = (text: string): string => text
    .replace(/(?<!\\)\\\\\(([\s\S]*?)(?<!\\)\\\\\)/g, (_full, inner: string) => `\\(${inner}\\)`)
    .replace(/(?<!\\)\\\\\[([\s\S]*?)(?<!\\)\\\\\]/g, (_full, inner: string) => `\\[${inner}\\]`);

  const transformOutsideInlineCode = (text: string): string => {
    const parts: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf("`", cursor);
      if (open === -1) {
        parts.push(transform(text.slice(cursor)));
        break;
      }
      parts.push(transform(text.slice(cursor, open)));
      let openEnd = open + 1;
      while (text[openEnd] === "`") openEnd += 1;
      const runLength = openEnd - open;
      let search = openEnd;
      let closeEnd = -1;
      while (search < text.length) {
        const candidate = text.indexOf("`", search);
        if (candidate === -1) break;
        let candidateEnd = candidate + 1;
        while (text[candidateEnd] === "`") candidateEnd += 1;
        if (candidateEnd - candidate === runLength) {
          closeEnd = candidateEnd;
          break;
        }
        search = candidateEnd;
      }
      if (closeEnd === -1) {
        parts.push(text.slice(open));
        break;
      }
      parts.push(text.slice(open, closeEnd));
      cursor = closeEnd;
    }
    return parts.join("");
  };

  const parts: string[] = [];
  let cursor = 0;
  let proseStart = 0;
  let fenceStart = -1;
  let fence: { char: "`" | "~"; length: number } | null = null;
  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? source.length : newline + 1;
    const line = source.slice(cursor, newline === -1 ? source.length : newline).replace(/\r$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      parts.push(transformOutsideInlineCode(source.slice(proseStart, cursor)));
      fence = { char: marker[1]![0] as "`" | "~", length: marker[1]!.length };
      fenceStart = cursor;
    } else if (fence && marker) {
      const run = marker[1]!;
      const closesFence = run[0] === fence.char && run.length >= fence.length && marker[2]!.trim().length === 0;
      if (closesFence) {
        parts.push(source.slice(fenceStart, lineEnd));
        fence = null;
        fenceStart = -1;
        proseStart = lineEnd;
      }
    }
    cursor = lineEnd;
  }
  if (fence && fenceStart >= 0) parts.push(source.slice(fenceStart));
  else parts.push(transformOutsideInlineCode(source.slice(proseStart)));
  return parts.join("");
}

export interface ChatMarkdownProps {
  text: string;
  streaming: boolean;
  variant?: "chat" | "document";
  /** ```md 围栏预览卡递归深度防护（内部预览渲染使用） */
  fenceDepth?: number;
  /** False for Bot conversations, which must not borrow the selected ordinary Task. */
  resolveTaskFiles?: boolean;
}

function ChatMarkdown({
  text,
  streaming,
  variant = "chat",
  fenceDepth = 0,
  resolveTaskFiles = true,
}: ChatMarkdownProps): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const content = useMemo(
    () => normalizeStandaloneSvgBlocks(convertDollarMath(normalizeTexMathDelimiters(text))),
    [text],
  );
  // markstream includes `final` in the render-context identity. Flipping final=false -> true at
  // assistant_end therefore invalidates every rendered Markdown node at once, which is visible as
  // a one-frame flash on long replies. A renderer that has participated in a live stream keeps
  // streaming parse mode for the rest of that mounted lifetime. Settled/history mounts still start
  // with final=true, so reopening or remounting a completed message gets normal final parsing.
  const everStreamedRef = useRef(streaming);
  if (streaming) everStreamedRef.current = true;
  const markstreamFinal = !streaming && !everStreamedRef.current;

  return (
    <div className={`md ${variant === "document" ? "md-doc" : "md-chat"}`}>
      <TaskFileScopeContext.Provider value={resolveTaskFiles}><FenceDepthContext.Provider value={fenceDepth}>
        <MarkdownRender
          content={content}
          final={markstreamFinal}
          htmlPolicy="safe"
          renderCodeBlocksAsPre
          // Disable markstream's internal batch renderer for chat. When the parsed top-level node
          // count grows, its batching logic resets visibleCount to the initial batch, temporarily
          // replacing later nodes with placeholders; on long streaming replies that looks like a
          // large block flashing. The outer message list already owns virtualization.
          batchRendering={false}
          typewriter={false}
          fade={false}
          deferNodesUntilVisible={false}
          maxLiveNodes={0}
          viewportPriority={false}
          // Chat already receives incremental provider updates. Markstream smoothStreaming adds a
          // second RAF scheduler on top of those updates; on long replies it repeatedly reconciles the
          // same growing document and causes visible repaint/flicker. Keep one streaming clock only.
          smoothStreaming={false}
          isDark={theme === "dark"}
          customId={CHAT_MARKSTREAM_CUSTOM_ID}
        />
      </FenceDepthContext.Provider></TaskFileScopeContext.Provider>
    </div>
  );
}

export default memo(ChatMarkdown);

