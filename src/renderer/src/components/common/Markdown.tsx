import { Children, isValidElement, memo, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { IconCheck, IconCopy } from "./icons";
import SvgFencePreview, { isSvgFenceLanguage, normalizeStandaloneSvgBlocks } from "./SvgFencePreview";
import DetailCard, {
  canvasKindFromCode,
  isRenderableCanvasCode,
} from "@/components/chat/DetailCard";
import {
  classifyImageSrc,
  slugifyHeading,
  uniqueSlug,
} from "@/lib/markdownDoc";
import { MdFileLink } from "./MdFileLink";
import { LocalFileChip } from "./FileBadge";
import { looksLikeLocalFilePath } from "@/lib/localFilePath";

export type MarkdownVariant = "chat" | "document";

function textFromReactNode(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) {
    return textFromReactNode(node.props.children);
  }
  return "";
}

function extractCodeFromPre(
  children: React.ReactNode,
): { language?: string; code: string } | null {
  const arr = Children.toArray(children);
  for (const child of arr) {
    if (!isValidElement<{ className?: string; children?: React.ReactNode }>(child)) continue;
    const className = child.props.className ?? "";
    const langMatch = /language-([a-z0-9_+.\/-]+)/i.exec(className);
    const language = langMatch?.[1];
    const code = textFromReactNode(child.props.children);
    return { language, code: code.replace(/\n$/, "") };
  }
  // pre 直接包文本的兜底
  if (typeof children === "string") return { code: children };
  return null;
}

function isMarkdownFenceLanguage(language: string | undefined): boolean {
  const lang = (language ?? "").toLowerCase().trim();
  return lang === "markdown" || lang === "md" || lang === "gfm";
}

/**
 * ```markdown / ```md 围栏：预览渲染为文档，而不是源码灰框。
 * 用户写「帮我写 md 文档」时模型常包一层 fence，原逻辑会整段当代码，表格/标题都不渲染。
 */
function MarkdownFencePreview({ code }: { code: string }): React.JSX.Element {
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
          <button
            type="button"
            className={`md-fence-btn ${mode === "preview" ? "active" : ""}`}
            onClick={() => setMode("preview")}
          >
            预览
          </button>
          <button
            type="button"
            className={`md-fence-btn ${mode === "source" ? "active" : ""}`}
            onClick={() => setMode("source")}
          >
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
          {/* 内层 Markdown 不再走 Pre 的 markdown 围栏分支时用 document 样式 */}
          <MarkdownInner source={code} variant="document" />
        </div>
      ) : (
        <pre className="md-fence-source">{code}</pre>
      )}
    </div>
  );
}

/** 无 Pre 劫持的内层渲染，避免 markdown 围栏无限递归（预览里再写 ```md 只显示源码灰框） */
function MarkdownInner({
  source,
  variant,
}: {
  source: string;
  variant: MarkdownVariant;
}): React.JSX.Element {
  const normalizedSource = useMemo(() => normalizeStandaloneSvgBlocks(source), [source]);
  const remarkPlugins = useMemo(
    () => (/(^|[^\\])\$|\\\(|\\\[/.test(normalizedSource) ? [remarkGfm, remarkMath] : [remarkGfm]),
    [normalizedSource],
  );
  const rehypePlugins = useMemo(() => {
    const plugins = [];
    if (/(^|[^\\])\$|\\\(|\\\[/.test(normalizedSource)) plugins.push(rehypeKatex);
    if (/```|~~~/.test(normalizedSource)) plugins.push(rehypeHighlight);
    return plugins;
  }, [normalizedSource]);

  return (
    <div className={`md ${variant === "document" ? "md-doc" : "md-chat"}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          // 预览内的代码块只走普通 pre，不再二次提升为「Markdown 文档」卡
          pre: (preProps) => <PlainPre {...preProps} />,
          a: ({ href, children: linkChildren }) => (
            <MdFileLink href={href}>{linkChildren}</MdFileLink>
          ),
          code: ({ children, className }) => {
            const text = Children.toArray(children).map((c) => (typeof c === "string" ? c : "")).join("");
            if (!className && looksLikeLocalFilePath(text)) {
              return <LocalFileChip path={text.trim()} />;
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {normalizedSource}
      </ReactMarkdown>
    </div>
  );
}

function PlainPre(props: React.HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const extracted = extractCodeFromPre(props.children);

  if (extracted && isSvgFenceLanguage(extracted.language)) {
    return <SvgFencePreview code={extracted.code} />;
  }

  const copy = (): void => {
    const text = ref.current?.innerText ?? extracted?.code ?? "";
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-pre">
      <button className="md-pre-copy" title="复制代码" onClick={copy} type="button">
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

function Pre({
  messageId,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { messageId?: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const extracted = extractCodeFromPre(props.children);

  if (extracted && isMarkdownFenceLanguage(extracted.language)) {
    return <MarkdownFencePreview code={extracted.code} />;
  }

  if (extracted && isSvgFenceLanguage(extracted.language)) {
    return <SvgFencePreview code={extracted.code} />;
  }

  if (extracted && isRenderableCanvasCode(extracted.language, extracted.code)) {
    return (
      <DetailCard
        title="展示详情"
        content={extracted.code}
        contentKind={canvasKindFromCode(extracted.language, extracted.code)}
        messageId={messageId}
      />
    );
  }

  const copy = (): void => {
    const text = ref.current?.innerText ?? extracted?.code ?? "";
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-pre">
      <button className="md-pre-copy" title="复制代码" onClick={copy} type="button">
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

type HeadingProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLHeadingElement>,
  HTMLHeadingElement
>;
type HeadingKey = `h${1 | 2 | 3 | 4 | 5 | 6}`;
type HeadingTagName = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** 标题锚点组件：GFM 风格 slug id + 悬停 # 链接（章节内去重） */
function buildHeadingComponents(): Record<HeadingKey, React.ComponentType<HeadingProps>> {
  const headingSlugs = new Map<string, number>();
  const comps = {} as Record<HeadingKey, React.ComponentType<HeadingProps>>;
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    const key = `h${level}` as HeadingKey;
    const Tag = key as HeadingTagName;
    comps[key] = ({ children: headingChildren, ...rest }: HeadingProps) => {
      const text = Children.toArray(headingChildren)
        .map((child) => (typeof child === "string" ? child : ""))
        .join("");
      const slug = uniqueSlug(slugifyHeading(text), headingSlugs);
      return (
        <Tag {...rest} id={slug} className="md-heading-anchor">
          <a href={`#${slug}`} className="md-anchor-link" aria-hidden="true">
            #
          </a>
          {headingChildren}
        </Tag>
      );
    };
  }
  return comps;
}

interface Props {
  children: string;
  variant?: MarkdownVariant;
  messageId?: string;
  /** Wave 5A：标题生成锚点 id + 可点击 # 链接（默认 false，聊天区不受影响） */
  anchors?: boolean;
  /** Wave 5A：图片策略（data/blob/http 渲染，相对路径占位） */
  imagePolicy?: boolean;
}

function Markdown({
  children,
  variant = "chat",
  messageId,
  anchors = false,
  imagePolicy = false,
}: Props): React.JSX.Element {
  const normalizedChildren = useMemo(() => normalizeStandaloneSvgBlocks(children), [children]);
  const remarkPlugins = useMemo(
    () => (/(^|[^\\])\$|\\\(|\\\[/.test(normalizedChildren) ? [remarkGfm, remarkMath] : [remarkGfm]),
    [normalizedChildren],
  );
  const rehypePlugins = useMemo(() => {
    const plugins = [];
    if (/(^|[^\\])\$|\\\(|\\\[/.test(normalizedChildren)) plugins.push(rehypeKatex);
    if (/```|~~~/.test(normalizedChildren)) plugins.push(rehypeHighlight);
    return plugins;
  }, [normalizedChildren]);

  const anchorComponents = useMemo(
    () => (anchors ? buildHeadingComponents() : {}),
    [anchors],
  );

  return (
    <div className={`md ${variant === "document" ? "md-doc" : "md-chat"}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        // Wave 5A：文档视图放行 data:/blob: 自包含图片（默认 urlTransform 会剥离），
        // 其余协议仍走默认清洗（javascript: 等保持被剥离）
        urlTransform={
          imagePolicy
            ? (url: string) => {
                if (/^(data|blob):/i.test(url)) return url;
                return defaultUrlTransform(url);
              }
            : undefined
        }
        components={{
          pre: (preProps) => <Pre {...preProps} messageId={messageId} />,
          a: ({ href, children: linkChildren }) => (
            <MdFileLink href={href}>{linkChildren}</MdFileLink>
          ),
          code: ({ children, className }) => {
            const text = Children.toArray(children).map((c) => (typeof c === "string" ? c : "")).join("");
            if (!className && looksLikeLocalFilePath(text)) {
              return <LocalFileChip path={text.trim()} />;
            }
            return <code className={className}>{children}</code>;
          },
          ...anchorComponents,
          ...(imagePolicy
            ? {
                img: ({
                  src,
                  alt,
                  ...rest
                }: React.ImgHTMLAttributes<HTMLImageElement>) => {
                  if (!src) return null;
                  if (classifyImageSrc(src) === "render") {
                    return (
                      <img
                        src={src}
                        alt={alt ?? ""}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="md-img"
                        {...rest}
                      />
                    );
                  }
                  return (
                    <span
                      className="md-img-placeholder"
                      title={`相对路径图片（${src}）`}
                    >
                      🖼 {alt || src.split(/[\\/]/).pop() || "图片"}（本地图片不可用）
                    </span>
                  );
                },
              }
            : {}),
        }}
      >
        {normalizedChildren}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
