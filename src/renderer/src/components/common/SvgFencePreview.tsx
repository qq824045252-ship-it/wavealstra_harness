import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

const MAX_SVG_SOURCE_BYTES = 512 * 1024;

export function isSvgFenceLanguage(language: string | undefined): boolean {
  const lang = (language ?? "").toLowerCase().trim();
  return lang === "svg" || lang === "image/svg+xml";
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
  const validationError = useMemo(() => validateSvgSource(code), [code]);

  useEffect(() => {
    if (validationError) {
      setObjectUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(
      new Blob([code], { type: "image/svg+xml;charset=utf-8" }),
    );
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [code, validationError]);

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
