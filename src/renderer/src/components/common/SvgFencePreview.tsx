import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

const MAX_SVG_SOURCE_BYTES = 512 * 1024;

export function isSvgFenceLanguage(language: string | undefined, code?: string): boolean {
  const lang = (language ?? "").toLowerCase().trim();
  if (lang === "svg" || lang === "image/svg+xml") return true;
  // Models often label SVG as XML/HTML or omit the fence language. Only
  // promote a document whose root is SVG; ordinary markup/code stays source.
  // Safety and completeness remain the preview component's responsibility.
  if (!["", "xml", "html"].includes(lang) || code === undefined) return false;
  const body = code.replace(/^\uFEFF/, "").trimStart()
    .replace(/^<\?xml\s+[\s\S]*?\?>\s*/i, "");
  return /^<svg[\s>]/i.test(body);
}

/**
 * Convert standalone raw <svg>...</svg> blocks into normal SVG fences before
 * Markdown parsing. This deliberately avoids rehype-raw: all other HTML keeps
 * the renderer's existing safe behavior, while SVG still goes through the same
 * isolated image preview path as an explicit SVG fence.
 */
export function normalizeStandaloneSvgBlocks(source: string): string {
  if (!/<svg[\s>]/i.test(source)) return source;
  const lines = source.split("\n");
  const output: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      output.push(line);
      if (marker) {
        const run = marker[1]!;
        if (run[0] === fence.char && run.length >= fence.length && marker[2]!.trim() === "") {
          fence = null;
        }
      }
      continue;
    }
    if (marker) {
      output.push(line);
      fence = { char: marker[1]![0] as "`" | "~", length: marker[1]!.length };
      continue;
    }
    const xmlDeclaration = /^\s*<\?xml\s+[\s\S]*?\?>\s*$/i.test(line);
    const svgStartsHere = /^\s*<svg[\s>]/i.test(line);
    const svgStartsAfterDeclaration = xmlDeclaration && /^\s*<svg[\s>]/i.test(lines[index + 1] ?? "");
    if (!svgStartsHere && !svgStartsAfterDeclaration) {
      output.push(line);
      continue;
    }

    const block: string[] = svgStartsAfterDeclaration ? [line, lines[index + 1] ?? ""] : [line];
    let end = svgStartsAfterDeclaration ? index + 1 : index;
    while (!/<\/svg\s*>/i.test(block[block.length - 1] ?? "") && end + 1 < lines.length) {
      end += 1;
      block.push(lines[end] ?? "");
    }
    if (!/<\/svg\s*>/i.test(block[block.length - 1] ?? "")) {
      output.push(...block);
      index = end;
      continue;
    }

    const raw = block.join("\n");
    const maxTicks = Math.max(0, ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length));
    const delimiter = "`".repeat(Math.max(3, maxTicks + 1));
    output.push(`${delimiter}svg`, raw, delimiter);
    index = end;
  }

  return output.join("\n");
}

function validateSvgSource(source: string): string | null {
  const value = source.trim();
  if (!value) return "SVG 内容为空";
  if (new TextEncoder().encode(value).byteLength > MAX_SVG_SOURCE_BYTES) {
    return "SVG 过大，已停止内联预览";
  }
  const documentBody = value
    .replace(/^\uFEFF/, "")
    .trimStart()
    .replace(/^<\?xml\s+[\s\S]*?\?>\s*/i, "");
  if (!/^<svg[\s>]/i.test(documentBody) || !/<\/svg\s*>$/i.test(documentBody)) {
    return "不是完整的 SVG 文档";
  }
  if (/<(?:script|iframe|object|embed|foreignObject|style)\b/i.test(value)) {
    return "SVG 含有不安全的可执行或嵌入内容";
  }
  if (/\son[a-z][\w:-]*\s*=/i.test(value)) {
    return "SVG 含有事件处理器，已阻止预览";
  }
  if (/\b(?:href|xlink:href)\s*=\s*["']\s*(?!#)/i.test(value)) {
    return "SVG 含有外部资源引用，已阻止预览";
  }
  if (/url\(\s*["']?\s*(?!#)/i.test(value)) {
    return "SVG 含有外部 URL，已阻止预览";
  }
  return null;
}

/**
 * SVG preview deliberately renders through a blob-backed <img> instead of
 * injecting SVG markup into the DOM. Chromium treats SVG loaded as an image as
 * a static image document: scripts/event handlers cannot execute in the page
 * DOM, while vector shapes/text/gradients/filters remain crisp.
 */
export default function SvgFencePreview({ code }: { code: string }): React.JSX.Element {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const validationError = useMemo(() => validateSvgSource(code), [code]);

  /**
   * 流式输出时 `code` 每个 token 都会变。旧实现是「立刻销毁旧 blob → 立刻换新 src」，
   * 而 <img> 在新 SVG 解码完成前没有内在尺寸（width:100%;height:auto ⇒ 高度 0），
   * 于是整块图形在 0 高与真实高度之间反复抽搐，把下面的内容推上推下 —— 长对话里表现为
   * 聊天记录自己乱跳。现在：① 停止输入 ~220ms 才重建；② 新图先离屏解码，成功后才换 src，
   * 保证可见高度在整段流式输出期间保持不变。
   */
  useEffect(() => {
    if (validationError) {
      const previous = urlRef.current;
      urlRef.current = null;
      setObjectUrl(null);
      if (previous) URL.revokeObjectURL(previous);
      return undefined;
    }
    let cancelled = false;
    let pending: string | null = null;
    const timer = setTimeout(() => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "image/svg+xml;charset=utf-8" }),
      );
      pending = url;
      const probe = new Image();
      const settle = (ok: boolean) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        if (!ok) { URL.revokeObjectURL(url); return; } // 解码失败：保留上一张，别把高度清空
        const previous = urlRef.current;
        urlRef.current = url;
        setObjectUrl(url);
        if (previous) URL.revokeObjectURL(previous);
      };
      probe.onload = () => settle(true);
      probe.onerror = () => settle(false);
      probe.src = url;
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // 只回收「还没被采用」的那张，正在显示的不能动
      if (pending && urlRef.current !== pending) URL.revokeObjectURL(pending);
    };
  }, [code, validationError]);

  useEffect(() => () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  }, []);

  const copy = (): void => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-svg-card">
      <div className="md-fence-toolbar">
        <span className="md-fence-label">SVG 图形</span>
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
          <button type="button" className="md-fence-btn" title="复制 SVG 源码" onClick={copy}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {mode === "source" ? (
        <pre className="md-fence-source">{code}</pre>
      ) : validationError ? (
        <div className="md-svg-error" role="status">
          {validationError}
        </div>
      ) : (
        <div className="md-svg-preview">
          {objectUrl ? (
            <img src={objectUrl} alt="SVG 预览" className="md-svg-image" draggable={false} />
          ) : (
            <span className="md-svg-loading">SVG 渲染中…</span>
          )}
        </div>
      )}
    </div>
  );
}
