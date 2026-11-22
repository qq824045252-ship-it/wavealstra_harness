import { REPLY_CITATION_TITLE, replySourceUrl, type ReplyCitation } from "./chat-reply-content";
import type { WebSearchReport } from "./web-search";

interface ReplySource extends Omit<ReplyCitation, "excerpt"> {
  text: string;
}

export interface ReplyToolEvidence {
  tool: string;
  status: string;
  detail?: string;
  output?: string;
  webSearch?: WebSearchReport;
}

function source(url: unknown, title: unknown, text: unknown, kind: ReplyCitation["kind"]): ReplySource[] {
  const href = replySourceUrl(url);
  if (!href || typeof text !== "string" || !text.trim()) return [];
  return [{ url: href, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 600) : new URL(href).hostname, text, kind }];
}

export function replyToolSources(call: ReplyToolEvidence): ReplySource[] {
  if (call.status !== "success") return [];
  const report = call.webSearch;
  if (report && Array.isArray(report.sources)) {
    const snippets = report.sources.flatMap(row => source(row?.url, row?.title, row?.snippet, "snippet"));
    const passages = Array.isArray(report.evidence) ? report.evidence.flatMap(row =>
      Array.isArray(row?.citations) ? row.citations.flatMap(c => c?.kind === "page" || c?.kind === "snippet"
        ? source(c.url, snippets.find(s => s.url === replySourceUrl(c.url))?.title, c.quote, c.kind) : []) : []) : [];
    return [...passages, ...snippets];
  }
  if (!call.detail || (call.tool !== "fetch_content" && call.tool !== "browser_exec")) return [];
  try {
    const result = JSON.parse(call.detail);
    if (call.tool === "browser_exec") {
      const page = result?.observation?.status === "completed" ? result.observation.result : result;
      return page?.action === "read" && page.scope === "main-document"
        && page.contentState === "ready" && typeof page.documentId === "string"
        ? source(page.url, page.title, page.text, "page") : [];
    }
    // Reused browser pages are matched by the host and have no HTTP status in the receipt.
    const browserPage = result?.source === "browser" && result.mode === "readable" && !result.prompt
      && result.truncated === false && result.hasImage === false
      && typeof result.shownBytes === "number" && result.shownBytes > 0 && result.shownBytes === result.totalBytes;
    return (result?.materialKind === "web-content" || browserPage) && result.successful === 1
      && Array.isArray(result.urls) && result.urls.length === 1
      ? source(result.urls[0], result.title, call.output, "page") : [];
  } catch { return []; }
}

/** Explicitly attributed excerpts in a user message also work in a conversation with no web tools. */
export function providedReplySources(text: string): ReplySource[] {
  return [...text.matchAll(/^ {0,3}\[([^\]\r\n]+)\]\(<?(https?:\/\/[^\s>)]+)>?\)[ \t]*\r?\n((?: {0,3}>[^\n]*(?:\n|$))+)/gm)]
    .flatMap(([, title, url, quote]) => source(url, title, quote.replace(/^ {0,3}> ?/gm, ""), "provided"));
}

const normalizeExcerpt = (text: string) => text.replace(/\s+/g, " ").trim();

export function replyCitationExcerpt(label: string, title?: string | null) {
  if (!title) return;
  if (title.startsWith(REPLY_CITATION_TITLE)) return { quote: title.slice(REPLY_CITATION_TITLE.length), marked: true };
  // Models also place the verbatim excerpt directly in the title of a "source" link.
  if (/^(来源|出处|source)$/i.test(label.trim())) return { quote: title, marked: false };
}

export function resolveReplyCitation(url: string, excerpt: string, sources: readonly ReplySource[]): ReplyCitation | undefined {
  const href = replySourceUrl(url);
  const quote = normalizeExcerpt(excerpt);
  if (!href || quote.length < 8 || quote.length > 240) return;
  const matching = sources.filter(candidate => candidate.url === href && normalizeExcerpt(candidate.text).includes(quote));
  const match = matching.find(candidate => candidate.kind === "page") ?? matching[0];
  if (match) return { url: match.url, title: match.title, excerpt: quote, kind: match.kind };
}

/** Formal handoff keeps just the source excerpts actually attached by the worker. */
export function collectReplyCitations(text: string, sources: readonly ReplySource[]): ReplyCitation[] {
  const citations = new Map<string, ReplyCitation>();
  for (const [, label, url, title] of text.matchAll(/\[([^\]\r\n]+)\]\(<?(https?:\/\/[^\s>)]+)>? "([^"\r\n]+)"\)/g)) {
    const excerpt = replyCitationExcerpt(label, title);
    if (!excerpt) continue;
    const value = resolveReplyCitation(url, excerpt.quote, sources);
    if (value) citations.set(JSON.stringify([value.url, value.excerpt]), value);
    if (citations.size >= 32) break;
  }
  return [...citations.values()];
}
