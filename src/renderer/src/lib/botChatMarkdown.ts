// Bound work before Markdown parsing, HTML normalization or syntax highlighting.
// This is a view projection; the original message and native record stay intact.
const MAX_MARKDOWN_CHARS = 16_000;
const MAX_CODE_CHARS = 4_000;
const MAX_CODE_LINES = 80;
const DOCUMENT_START = /^\s*(?:>\s*)*<(?:!doctype\s+html\b|html(?:\s|>))/i;

export function botChatMarkdown(source: string): { text: string; sourceOmitted: boolean; truncated: boolean } {
  const input = source.slice(0, MAX_MARKDOWN_CHARS);
  const output: string[] = [];
  let sourceOmitted = false;
  let cursor = 0;
  let fence: { marker: string; lines: string[]; chars: number; document: boolean } | undefined;
  let rawDocument = false;
  const finishFence = (): void => {
    if (!fence) return;
    if (fence.document || fence.chars > MAX_CODE_CHARS || fence.lines.length > MAX_CODE_LINES) sourceOmitted = true;
    else output.push(...fence.lines);
    fence = undefined;
  };
  while (cursor < input.length) {
    const newline = input.indexOf("\n", cursor);
    const end = newline === -1 ? input.length : newline + 1;
    const line = input.slice(cursor, end);
    cursor = end;
    // Also protect raw/indented documents and documents inside quoted examples.
    if (!fence && (rawDocument || DOCUMENT_START.test(line))) {
      sourceOmitted = true;
      const closing = /<\/html\s*>/i.exec(line);
      rawDocument = !closing;
      if (closing) output.push(line.slice(closing.index + closing[0].length));
      continue;
    }
    const marker = /^ {0,3}(?:>\s*)*(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence) {
      fence.lines.push(line);
      fence.chars += line.length;
      fence.document ||= DOCUMENT_START.test(line);
      if (marker && marker[1]![0] === fence.marker[0] && marker[1]!.length >= fence.marker.length && !marker[2]!.trim()) finishFence();
    } else if (marker) {
      fence = { marker: marker[1]!, lines: [line], chars: line.length, document: false };
    } else {
      output.push(line);
    }
  }
  finishFence(); // Unclosed streaming fences have the same limits as completed ones.
  return { text: output.join(""), sourceOmitted, truncated: source.length > input.length };
}
