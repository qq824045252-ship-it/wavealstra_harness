import { getMarkdown } from "stream-markdown-parser";
import { parseReplyBlock, REPLY_CHART_FENCE, REPLY_TABLE_FENCE } from "@shared/chat-reply-content";
import { replyCitationExcerpt, resolveReplyCitation } from "@shared/chat-reply-sources";

const markdown = getMarkdown("mybuddy-readable-reply");
const cell = (value: string | number | null) => String(value ?? "—")
  .replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")
  .replace(/([`*_~[\]<>])/g, "\\$1");

function markdownTable(headers: string[], rows: (string | number | null)[][]): string {
  const row = (values: (string | number | null)[]) => `| ${values.map(cell).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
}

type Sources = Parameters<typeof resolveReplyCitation>[2];

/** Clipboard representation of rich replies. Ordinary Markdown and code examples stay intact. */
export function readableChatReply(text: string, sources: Sources): string {
  if (!text.includes("mybuddy-") && !text.includes("](")) return text;
  const offsets = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index + match[0].length);
  const citations = (source: string) => source.replace(
    /(`+)[\s\S]*?\1|\[([^\]\r\n]+)\]\(<?(https?:\/\/[^\s>)]+)>?[ \t]+"([^"\r\n]+)"\)/g,
    (match, code: string | undefined, label: string, url: string, title: string) => {
      if (code) return match;
      const excerpt = replyCitationExcerpt(label, title);
      if (!excerpt) return match;
      const citation = resolveReplyCitation(url, excerpt.quote, sources);
      if (!citation) return excerpt.marked ? "" : match;
      return `[${cell(citation.title)}](<${citation.url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
    },
  );
  const parts: string[] = [];
  let cursor = 0;
  for (const token of markdown.parse(text, {})) {
    if (!token.map || (token.type !== "fence" && token.type !== "code_block" && token.type !== "html_block")) continue;
    const start = offsets[token.map[0]] ?? text.length;
    const end = offsets[token.map[1]] ?? text.length;
    if (start < cursor) continue;
    parts.push(citations(text.slice(cursor, start)));
    cursor = end;
    const lang = token.info.trim().split(/\s+/, 1)[0];
    if (token.type !== "fence" || token.level !== 0 || (lang !== REPLY_TABLE_FENCE && lang !== REPLY_CHART_FENCE)) {
      parts.push(text.slice(start, end));
      continue;
    }
    const reply = parseReplyBlock(lang, token.content);
    if (!reply) continue;
    const { data } = reply;
    const table = reply.kind === "table"
      ? markdownTable(reply.data.columns.map(column => column.type === "number" && column.unit
        ? `${column.label} (${column.unit})` : column.label), reply.data.rows)
      : markdownTable(["数据点", `数值 (${reply.data.unit})`], reply.data.points.map(point => [point.label, point.value]));
    parts.push(`**${cell(data.title)}**\n\n${table}\n\n`);
  }
  parts.push(citations(text.slice(cursor)));
  return parts.join("").trim();
}
