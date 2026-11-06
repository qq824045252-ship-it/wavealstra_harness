/**
 * markdown 正文里的图片引用解析 —— 纯正则，零依赖。
 *
 * 独立成文件的原因：虚拟列表的行高估算（messageSizeEstimate）也要数图片，
 * 但它不能把整条 artifact 协议链（@shared/artifact-ipc）拉进纯 node 测试。
 * 正则口径只能有一份，否则"估算画了几张图"和"实际画了几张图"会分歧。
 */

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

/** markdown 正文里出现的图片引用（内联语法 + HTML img），用来判断"正文已经画了哪些图"。 */
export function markdownImageSources(text: string): string[] {
  if (!text.includes("![") && !/<img/i.test(text)) return [];
  const found: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const raw = match[1] ?? "";
    found.push(raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
  }
  for (const match of text.matchAll(HTML_IMAGE_RE)) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}
