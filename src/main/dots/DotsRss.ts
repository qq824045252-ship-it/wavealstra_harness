import { createHash } from "node:crypto";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { fetchRemoteUrl, loadFetchContentDomainPolicy } from "../capabilities/web-access/ssrf-protection";
import { discoveryUrl, type DiscoveryItem } from "../../shared/dots-discovery";

export interface RssEntry extends DiscoveryItem { id: string }
export interface RssValidators { etag?: string; modified?: string }
export type RssResponse = RssValidators & { entries?: RssEntry[] };

const feedLimit = 1024 * 1024;
const elementName = (node: Element) => (node.localName ?? node.tagName).toLowerCase();
const children = (node: Element) => Array.from(node.childNodes)
  .filter((child): child is Element => child.nodeType === 1);
const child = (node: Element, name: string) => children(node).find(item => elementName(item) === name);
const text = (node: Element, name: string) => child(node, name)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

export function parseDotsRss(xml: string, base: string): RssEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("订阅包含不支持的 XML 声明。");
  let feed: Element | null;
  try {
    feed = new DOMParser({ onError: (level) => { if (level !== "warning") throw new Error("RSS XML"); } })
      .parseFromString(xml, "application/xml").documentElement;
  } catch { throw new Error("订阅 XML 无法解析。"); }
  if (!feed) throw new Error("订阅是空的。");
  const format = elementName(feed);
  const container = format === "rss" ? child(feed, "channel") : feed;
  if (!container || !["rss", "feed", "rdf"].includes(format)) throw new Error("网址没有返回 RSS 或 Atom 订阅。");
  const unique = new Map<string, RssEntry>();
  for (const entry of children(container).filter(node => elementName(node) === (format === "feed" ? "entry" : "item")).slice(0, 300)) {
    const title = text(entry, "title").slice(0, 180);
    const atomLink = children(entry).find(node => node.localName === "link" && (!node.getAttribute("rel") || node.getAttribute("rel") === "alternate"));
    const link = atomLink?.getAttribute("href") || text(entry, "link");
    const url = link && discoveryUrl(link, base);
    if (!title || !url) continue;
    const id = createHash("sha256").update(text(entry, format === "feed" ? "id" : "guid") || url).digest("hex");
    unique.set(id, { id, title, url });
  }
  return [...unique.values()];
}

export async function readDotsRss(url: string, validators: RssValidators, signal: AbortSignal): Promise<RssResponse> {
  const headers = new Headers({ accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1" });
  if (validators.etag) headers.set("If-None-Match", validators.etag);
  if (validators.modified) headers.set("If-Modified-Since", validators.modified);
  const response = await fetchRemoteUrl(url,
    { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(18_000)]) },
    { enabled: true, allowRanges: [], trustEnvProxy: false, maxRedirects: 4, domainPolicy: loadFetchContentDomainPolicy(),
      onRedirect: ({ to, init }) => { if (!discoveryUrl(to.href)) throw new Error("订阅跳转地址无效。"); return init; } },
  );
  if (response.status === 304) return validators;
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`订阅请求失败（HTTP ${response.status}）。`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > feedLimit) throw new Error("订阅超过 1 MB。");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  const encoding = response.headers.get("content-type")?.match(/charset=["']?([\w-]+)/i)?.[1]
    ?? bytes.subarray(0, 256).toString("ascii").match(/encoding=["']([\w-]+)/i)?.[1] ?? "utf-8";
  const entries = parseDotsRss(new TextDecoder(encoding).decode(bytes), response.url || url);
  return { entries, etag: response.headers.get("etag")?.slice(0, 512), modified: response.headers.get("last-modified")?.slice(0, 128) };
}
