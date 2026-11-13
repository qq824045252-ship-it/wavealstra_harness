export interface MessageHtmlDocument { index: number; source: string }
export const MAX_MESSAGE_HTML_CHARS = 8 * 1024 * 1024;
/** Complete top-level HTML fences only. Never inspect code examples nested inside
 * another fence. Original bytes/line endings are retained; this does not execute HTML.
 * Raw HTML is accepted only when the entire message is a document, not prose guessed
 * to end at a possible </html> string inside JavaScript. */
export function extractMessageHtml(source: string): MessageHtmlDocument[] {
  if (source.length > MAX_MESSAGE_HTML_CHARS) return [];
  const complete = (value: string): boolean => /^(?:\uFEFF)?\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html(?:\s|>)/i.test(value)
    && /<\/html\s*>\s*$/i.test(value);
  if (complete(source)) return [{ index: 0, source }];
  const result: MessageHtmlDocument[] = [];
  let fence: { char: string; length: number; contentStart: number; eligible: boolean } | undefined;
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor;
    const next = source.indexOf('\n', cursor);
    cursor = next === -1 ? source.length : next + 1;
    const line = source.slice(start, cursor).replace(/[\r\n]+$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (fence) {
      if (marker[1][0] !== fence.char || marker[1].length < fence.length || marker[2].trim()) continue;
      const content = source.slice(fence.contentStart, start);
      if (fence.eligible && complete(content)) {
        result.push({ index: result.length, source: content });
        if (result.length === 32) return result;
      }
      fence = undefined;
    } else {
      // Backticks in a backtick fence info string make it ordinary Markdown text.
      if (marker[1][0] === '`' && marker[2].includes('`')) continue;
      const language = marker[2].trim().split(/\s+/)[0].toLowerCase();
      fence = { char: marker[1][0], length: marker[1].length, contentStart: cursor,
        eligible: ['', 'html', 'htm', 'text/html'].includes(language) };
    }
  }
  return result;
}
