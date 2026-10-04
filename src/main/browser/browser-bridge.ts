/**
 * browser-bridge — 内建 WebAccess Capability 的受控浏览器桥。
 *
 * 内建 WebAccess Capability 直接通过受控最小面读取用户已打开的浏览器页面：
 * - 只读当前已加载页面的 URL/title/正文（裁剪）；
 * - URL 匹配（同源同路径）由 WebResourceResolver 严格校验；
 * - 不暴露导航/输入/cookie/Node 能力（最小权限）。
 */
import { BrowserContentService } from "./BrowserContentService";
import type { BrowserHost } from "./BrowserHost";

let hostRef: BrowserHost | null = null;

const service = new BrowserContentService(() => hostRef);

/** 装配（index.ts 启动时调用一次） */
export function bindBrowserBridge(host: BrowserHost): void {
  hostRef = host;
}

export const browserBridge = {
  /** 浏览器是否可用且有已加载页面 */
  get available(): boolean {
    return service.available;
  },

  /**
   * 解析策略并（命中时）返回浏览器已渲染内容。
   * @param url Agent 请求 URL
   * @param enabled browser reuse 开关（设置项）
   */
  tryBrowserReuse(url: string, enabled: boolean) {
    return service.tryBrowserReuse(url, enabled);
  },
};

export type BrowserBridge = typeof browserBridge;
