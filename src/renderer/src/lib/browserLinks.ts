import type { ChatMessage, Task } from "@/types";

export interface BrowserLink {
  id: string;
  url: string;
  label: string;
}

/** 无任务时（首页）扩展栏浏览器 session key */
export const HOME_BROWSER_KEY = "__home__";

/**
 * 磁盘绝对路径 → file:// URL。
 * Windows 盘符冒号必须保留原文：encodeURIComponent 会把 `C:` 编成 `C%3A`，
 * Chromium 拒载（ERR_ABORTED，如 file:///C%3A/...）；其余段逐段编码（空格/中文）。
 * UNC `\\server\share\...` → `file://server/share/...`。
 */
export function fileUrlForAbsolutePath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const unc = /^\/\/([^/]+)\/(.*)$/.exec(normalized);
  if (unc) {
    const [, host, rest] = unc;
    const encoded = rest
      .split("/")
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join("/");
    return `file://${encodeURIComponent(host)}/${encoded}`;
  }
  const encoded = normalized
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return `file:///${encoded}`;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const MD_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/gi;

export function normalizeBrowserUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(s) && !s.includes(" ")) return `https://${s}`;
  // loopback 端口形式：127.0.0.1:9001
  if (/^(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
  return null;
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)]+$/, "");
}

function truncateLabel(url: string, max = 48): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function collectFromText(text: string, seen: Set<string>, links: BrowserLink[]): void {
  for (const match of text.matchAll(URL_RE)) {
    const url = stripTrailingPunct(match[0]);
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ id: url, url, label: truncateLabel(url) });
    }
  }
  for (const match of text.matchAll(MD_LINK_RE)) {
    const url = stripTrailingPunct(match[1]);
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ id: url, url, label: truncateLabel(url) });
    }
  }
}

function walkBlocks(msg: ChatMessage, seen: Set<string>, links: BrowserLink[]): void {
  const blocks = [...msg.blocks, ...(msg.finalBlocks ?? [])];
  for (const block of blocks) {
    if (block.type === "text") collectFromText(block.text, seen, links);
    if (block.type === "detail" && block.contentKind !== "html") collectFromText(block.content, seen, links);
    if (block.type === "callout") collectFromText(block.text, seen, links);
  }
}

export function extractBrowserLinks(task: Task): BrowserLink[] {
  const seen = new Set<string>();
  const links: BrowserLink[] = [];
  for (const msg of task.messages) walkBlocks(msg, seen, links);
  return links;
}
