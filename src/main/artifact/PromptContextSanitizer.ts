/**
 * PromptContextSanitizer — V3.5 Wave 4E（§82 UNTRUSTED 清洗）
 *
 * 清洗 HTML/SVG/Markdown 内容，防止把不可信页面内容全量送进 Prompt：
 * 1. truncate：分类型上限（selection 4KB / HTML 32KB / Markdown 32KB / SVG 32KB）
 * 2. stripScripts：删除 <script> 整个 body → <script>[omitted]</script>
 *    （保留“这里存在脚本”的结构事实）
 * 3. stripDataUris：大 data URI → data:<mime>;base64,[omitted]
 * 4. compactSvgPaths：长 <path d="..."> → d="[complex path omitted]"，
 *    保留 id/class/fill/stroke/transform（结构价值高于路径数据）
 * 5. stripInlineHandlers：on* 属性体 → [omitted]（保留“元素有 handler”的事实）
 *
 * 纯函数模块：无 IO、无状态。
 */
import { PromptContextLimits } from "../../shared/prompt-context";

/** SVG path 长度阈值 */
const SVG_PATH_LIMIT = 512;

/** 通用文本截断（按 UTF-16 长度近似；中文按字符） */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

/** selection 文本截断（§82：≤ 4KB） */
export function truncateSelectionText(text: string): string {
  return truncate(text, PromptContextLimits.selectionText);
}

/** 剥离 <script> body（保留标签结构与 [omitted] 标记） */
export function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (match) => {
    const open = match.slice(0, match.indexOf(">") + 1);
    return `${open}[omitted]</script>`;
  });
}

/**
 * data URI → data:<mime>;base64,[omitted]（保留 mime 类型信息）
 * 一律省略：base64 内容对文本扫描不可见（可能含恶意 payload），§82 不送模型。
 */
export function stripDataUris(input: string): string {
  return input.replace(
    /data:([a-zA-Z0-9._+-]+\/[a-zA-Z0-9._+-]+);base64,[A-Za-z0-9+/=_-]+/g,
    (_match, mime: string) => `data:${mime};base64,[omitted]`,
  );
}

/** 压缩 SVG path：长 d 属性 → [complex path omitted]；保留 id/class/fill/stroke/transform */
export function compactSvgPaths(svg: string): string {
  return svg.replace(
    /<([a-zA-Z][\w-]*)\b([^>]*\s)d=("[^"]*"|'[^']*')([^>]*)>/g,
    (match, tag: string, prefix: string, d: string, suffix: string) => {
      const value = d.slice(1, -1);
      if (value.length <= SVG_PATH_LIMIT) return match;
      return `<${tag}${prefix}d="[complex path omitted]"${suffix}>`;
    },
  );
}

/**
 * 剥离 inline event handler 属性体 → on*="[omitted]"
 * （保留“元素有 handler”的事实；不整属性删除）
 */
export function stripInlineHandlers(html: string): string {
  return html.replace(/\s(on[a-z]+)=("[^"]*"|'[^']*')/gi, (_m, name: string) => ` ${name}="[omitted]"`);
}

/** 清洗入口：按内容类型应用全部规则 */
export function sanitizeArtifactContent(content: string, kind: string): string {
  let out = content;
  if (kind === "html") {
    out = stripScripts(out);
    out = stripInlineHandlers(out);
    out = stripDataUris(out);
  } else if (kind === "svg") {
    out = compactSvgPaths(out);
    out = stripScripts(out);
    out = stripInlineHandlers(out);
    out = stripDataUris(out);
  } else if (kind === "markdown") {
    out = stripDataUris(out);
  }
  return out;
}

/** excerpt 截断（按类型预算） */
export function truncateExcerpt(excerpt: string, kind: string): string {
  const limit =
    kind === "html"
      ? PromptContextLimits.htmlExcerpt
      : kind === "svg"
        ? PromptContextLimits.svgExcerpt
        : PromptContextLimits.markdownExcerpt;
  return truncate(excerpt, limit);
}
