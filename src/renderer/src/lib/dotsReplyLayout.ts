const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

export function allowsDotsProseLayout(request: string): boolean {
  return !/原样|逐字|一字不|照抄|格式|纯文本|不要分[段行点]|换行|(?:单|一)(?:段|行)|\b(?:json|csv|ya?ml|markdown|verbatim|exact(?:ly)?|single (?:line|paragraph)|plain text)\b/iu.test(request);
}

export function layoutDotsProse(text: string): string {
  if (text.length < 180 || /^(?: {4}|\t| {0,3}(?:`{3,}|~{3,}|<))/mu.test(text)) return text;
  return text.split(/(\r?\n[ \t]*\r?\n)/u).map((paragraph, index) => {
    if (index % 2) return paragraph;
    if (!paragraph.startsWith("> ")) return layoutParagraph(paragraph);
    return "> " + layoutParagraph(paragraph.slice(2)).replaceAll("\n\n", "\n>\n> ");
  }).join("");
}

function layoutParagraph(text: string): string {
  // Only reflow a dense plain paragraph. Markdown and literal payloads keep their syntax.
  if (text.length < 180 || /[\r\n`\[\]{}<>|$\\]|[*_~]{2}|(?:^|\s)[*_~]\S|(?:https?|file|mybuddy):/iu.test(text)) return text;
  if (/^(?: {4}|\t| {0,3}(?:#{1,6}|[-*+]|\d+[.)])\s)/u.test(text)) return text;
  const sentences = [...sentenceSegmenter.segment(text)];
  if (sentences.length < 3) return text;

  const paragraphs: string[] = [];
  let start = 0;
  for (const { index, segment } of sentences.slice(1)) {
    const firstBreak = index === sentences[1].index;
    if (index - start < (firstBreak ? 24 : 96) || text.length - index < 32 || !/^\p{L}/u.test(segment)) continue;
    paragraphs.push(text.slice(start, index));
    start = index;
  }
  return paragraphs.length ? [...paragraphs, text.slice(start)].join("\n\n") : text;
}
