/** Small dependency-free destination scanner shared by the renderer and host.
 * Preserve raw Windows paths until the host resolves them: Markdown's usual
 * backslash unescaping would turn `servi\\.mybuddy` into `servi.mybuddy`.
 */
interface ImageDestination { start: number; end: number; source: string }
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
function destination(text: string, offset: number, inline: boolean): ImageDestination | undefined {
  let start = offset;
  while (/[ \t\r\n]/.test(text[start] ?? "\0")) start++;
  if (text[start] === "<") {
    const end = text.indexOf(">", start + 1);
    if (end < 0 || /[\r\n]/.test(text.slice(start, end))) return undefined;
    return { start, end: end + 1, source: text.slice(start + 1, end) };
  }
  const windowsPath = /^[a-z]:[\\/]/i.test(text.slice(start));
  let end = start, depth = 0;
  for (; end < text.length; end++) {
    const char = text[end];
    if (/\s/.test(char!)) break;
    if (!windowsPath && char === "\\" && /[()]/.test(text[end + 1] ?? "")) { end++; continue; }
    if (char === "(") depth++;
    if (char === ")") {
      if (!depth) { if (inline) break; else return undefined; }
      depth--;
    }
  }
  if (end === start || depth) return undefined;
  return { start, end, source: text.slice(start, end) };
}
function label(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
function imageDestinations(text: string): ImageDestination[] {
  if (!text.includes("![")) return [];
  const definitions = new Map<string, ImageDestination>();
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*/gm)) {
    const item = destination(text, match.index! + match[0].length, false);
    if (item && !definitions.has(label(match[1]!))) definitions.set(label(match[1]!), item);
  }
  const found = new Map<number, ImageDestination>();
  for (const match of text.matchAll(/!\[((?:\\.|[^\]\\])*)\]/g)) {
    const end = match.index! + match[0].length;
    if (text[end] === "(") {
      const item = destination(text, end + 1, true);
      if (item && /^\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))\s*)?\)/.test(text.slice(item.end))) found.set(item.start, item);
      continue;
    }
    const reference = /^\[([^\]\n]*)\]/.exec(text.slice(end));
    const item = definitions.get(label(reference?.[1] || match[1]!));
    if (item) found.set(item.start, item);
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** Inline, reference-style and HTML image sources, with balanced parentheses. */
export function markdownImageSources(text: string): string[] {
  const sources = imageDestinations(text).map(item => item.source);
  for (const match of text.matchAll(HTML_IMAGE_RE)) if (match[1]) sources.push(match[1]);
  return sources;
}

/** Rewrite only image destinations, preserving alt text, titles and prose. */
export function rewriteMarkdownImageSources(text: string, replace: (source: string) => string): string {
  let result = text;
  for (const item of imageDestinations(text).reverse()) {
    const next = replace(item.source);
    if (next !== item.source) result = result.slice(0, item.start) + next + result.slice(item.end);
  }
  return result;
}
