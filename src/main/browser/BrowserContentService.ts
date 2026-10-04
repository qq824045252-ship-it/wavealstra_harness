/**
 * BrowserContentService — WebAccess/Browser 收敛 B：受控读取 BrowserHost 已渲染页面。
 *
 * 职责：
 * - 读取 MyBuddy 右侧浏览器当前已加载页面的 URL/title/正文（executeJavaScript，
 *   不 attach CDP —— 避免与用户 DevTools/检查模式冲突）；
 * - 供 WebAccess（fetch_content 等）在「用户已打开同一页面」时复用渲染结果，
 *   避免重复 HTTP 抓取（尤其登录态/JS 动态页）。
 *
 * 安全边界（与 resolver 同源）：
 * - 只读「当前已加载页面」，不导航、不执行用户未发起的请求；
 * - URL 匹配校验在 WebResourceResolver（同源同路径），杜绝浏览器越权访问；
 * - 正文按 PAGE_TEXT_MAX_CHARS 裁剪，防止整页无限塞入模型。
 */
import type { PageWebContentsLike } from "../artifact/PageInspectionService";
import { pageInspectionService } from "../artifact/PageInspectionService";
import type { BrowserHost } from "./BrowserHost";
import { isBrowserPageMatch, resolveWebFetchStrategy, type WebFetchStrategy } from "./WebResourceResolver";

export interface BrowserPageRead {
  url: string;
  title: string;
  text: string;
  fetchedAt: number;
  /** 读取来源（可观测：browser-reuse） */
  source: "browser";
}

export class BrowserContentService {
  constructor(private readonly host: () => BrowserHost | null) {}

  /** 浏览器是否可用且有已加载页面 */
  get available(): boolean {
    const host = this.host();
    return Boolean(host && host.inspectionWebContents && host.url);
  }

  /** 当前页面快照（正文裁剪；失败返回 null） */
  async getCurrentPage(): Promise<BrowserPageRead | null> {
    const host = this.host();
    const wc = host?.inspectionWebContents as PageWebContentsLike | undefined;
    if (!wc || !host?.url) return null;
    const snap = await pageInspectionService.getPageSnapshot(wc);
    if (!snap) return null;
    return { ...snap, source: "browser" };
  }

  /**
   * 为 Agent 请求解析策略并（命中时）返回浏览器已渲染内容。
   * 未命中浏览器复用 → 返回 null（调用方走 HTTP fetch / render fallback）。
   * 导航竞态防护：首次按 host.url 匹配后，拿到 page snapshot 必须用 page.url 对请求 URL
   * 做严格二次 isBrowserPageMatch 校验——两次读取之间发生导航时绝不能返回跨页内容。
   */
  async tryBrowserReuse(
    url: string,
    browserReuseEnabled: boolean,
  ): Promise<{ strategy: WebFetchStrategy; page: BrowserPageRead | null }> {
    const host = this.host();
    const strategy = resolveWebFetchStrategy({
      url,
      browserUrl: host?.url ?? null,
      browserReuseEnabled,
    });
    if (strategy !== "browser-reuse") {
      return { strategy, page: null };
    }
    const page = await this.getCurrentPage();
    // 二次校验：快照 URL 必须与请求 URL 精确匹配（同源同路径同 query）
    if (page && !isBrowserPageMatch(url, page.url)) {
      return { strategy, page: null };
    }
    return { strategy, page };
  }
}


