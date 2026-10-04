import { getMarkdown } from "stream-markdown-parser";

export type CanvasDocumentSegment =
  | { kind: "text"; text: string }
  | { kind: "canvas"; code: string };

// Only reads tokens/source maps; HTML rendering still belongs to DetailCard.
const markdown = getMarkdown("mybuddy-canvas-boundaries");
const PREVIEW_LANGUAGES = new Set(["", "html", "htm", "svg", "xml", "canvas", "javascript", "js"]);
const CONTAINERS = new Set(["blockquote_open", "bullet_list_open", "ordered_list_open"]);

/**
 * Extract complete previews without changing Markdown boundaries. All fences,
 * including unknown languages, longer fences and unfinished streams, are owned
 * by the Markdown parser. Never search for HTML inside those protected ranges.
 */
export function splitCanvasDocuments(
  text: string,
  canPreview: (language: string | undefined, code: string) => boolean,
): CanvasDocumentSegment[] {
  if (!/<(?:!DOCTYPE\s+html|html|svg|canvas|style)\b/i.test(text)) return [{ kind: "text", text }];

  const lineOffsets = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) lineOffsets.push(match.index + match[0].length);
  const parts: CanvasDocumentSegment[] = [];
  const appendText = (source: string): void => {
    if (!source) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += source;
    else parts.push({ kind: "text", text: source });
  };
  const appendProse = (source: string): void => {
    // Raw documents must start on their own line, never inside an inline-code example.
    const raw = /^ {0,3}((?:<!DOCTYPE\s+html\b[\s\S]*?<\/html\s*>)|(?:<html\b[\s\S]*?<\/html\s*>)|(?:<svg\b[\s\S]*?<\/svg\s*>)|(?:<canvas\b[\s\S]*?<\/canvas\s*>(?:\s*<script\b[\s\S]*?<\/script\s*>)*))/gim;
    let cursor = 0;
    for (const match of source.matchAll(raw)) {
      const code = match[1]!.trim();
      if (!canPreview(undefined, code)) continue;
      appendText(source.slice(cursor, match.index));
      parts.push({ kind: "canvas", code });
      cursor = match.index + match[0].length;
    }
    appendText(source.slice(cursor));
  };

  let cursor = 0;
  for (const token of markdown.parse(text, {})) {
    if (!token.map || token.level !== 0) continue;
    if (token.type !== "fence" && token.type !== "code_block" && !CONTAINERS.has(token.type)) continue;
    const start = lineOffsets[token.map[0]] ?? text.length;
    const end = lineOffsets[token.map[1]] ?? text.length;
    if (start < cursor) continue;
    appendProse(text.slice(cursor, start));

    const language = token.info.trim().split(/\s+/)[0]!.toLowerCase();
    const code = token.content.trim();
    const completeDocument = !/^\s*(?:<!DOCTYPE\s+html\b|<html\b)/i.test(code) || /<\/html\s*>/i.test(code);
    if (token.type === "fence" && token.meta?.closed === true &&
        PREVIEW_LANGUAGES.has(language) && completeDocument && canPreview(undefined, code)) {
      parts.push({ kind: "canvas", code });
      const closingNewline = /(?:\r\n|\r|\n)$/.exec(text.slice(start, end));
      if (closingNewline) appendText(closingNewline[0]);
    } else {
      appendText(text.slice(start, end));
    }
    cursor = end;
  }
  appendProse(text.slice(cursor));
  return parts.length ? parts : [{ kind: "text", text }];
}
