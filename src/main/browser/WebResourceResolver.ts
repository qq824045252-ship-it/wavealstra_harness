/**
 * WebResourceResolver — WebAccess/Browser 收敛 B：统一网页资源获取策略（纯函数，可测）。
 *
 * 策略层级（优先级从高到低）：
 *   1. search → 搜索 provider（web_search 工具）
 *   2. 公开静态 URL → HTTP fetch（extract.ts，含 SSRF/domain policy）
 *   3. 当前 MyBuddy Browser 已打开「同一页面」（用户主动浏览上下文）→ Browser rendered page 复用
 *   4. 其余 → HTTP fetch；第三方 render fallback 由 extract.ts 在 HTTP 失败/动态页时自行降级
 *      （不在此层表达，避免把「动态页猜测」做成隐式规则）。
 *
 * 信任边界（显式）：
 * - 「用户主动浏览上下文」：仅当目标 URL 与 BrowserHost 当前已加载 URL 同源同路径时，
 *   才允许读取浏览器已渲染内容（用户已在该页面）。Agent 请求的 URL 与浏览器页面不同 →
 *   一律走 HTTP fetch（SSRF/domain policy 生效），绝不借用浏览器越权访问。
 * - Browser 读取不触网（读已加载 DOM），因此不构成 SSRF 面；匹配校验必须严格。
 */

export type WebFetchStrategy = "http-fetch" | "browser-reuse";

export interface ResolveWebFetchInput {
  /** Agent 请求的目标 URL */
  url: string;
  /** BrowserHost 当前已加载 URL（null = 浏览器无页面/不可用） */
  browserUrl: string | null;
  /** Browser 复用总开关（设置项） */
  browserReuseEnabled: boolean;
}

/** URL 归一化：忽略 hash；query 保留（同页不同参数视为不同页，保守）。 */
export function normalizePageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

/** 浏览器复用匹配：同源 + 同路径 + 同 query（忽略 hash）。登录态/SPA 重定向后的规范 URL 视为同页。 */
export function isBrowserPageMatch(requested: string, browserUrl: string): boolean {
  try {
    const a = new URL(normalizePageUrl(requested));
    const b = new URL(normalizePageUrl(browserUrl));
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/**
 * 解析网页获取策略：
 * - browser-reuse：仅当开关开启、浏览器有页面、URL 与浏览器当前页匹配（用户已打开）。
 * - http-fetch：其余（默认路径，SSRF 防护在 extract.ts；第三方 render fallback 由
 *   extract.ts 在 HTTP 失败/动态页判定后自行降级，不在本层表达）。
 */
export function resolveWebFetchStrategy(input: ResolveWebFetchInput): WebFetchStrategy {
  const { url, browserUrl, browserReuseEnabled } = input;
  if (browserReuseEnabled && browserUrl && isBrowserPageMatch(url, browserUrl)) {
    return "browser-reuse";
  }
  return "http-fetch";
}
