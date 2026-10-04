/**
 * fetch-strategy.ts — WebAccess/Browser 收敛 B/C 的纯决策函数（可测，无副作用）。
 *
 * - decideBrowserReuse：fetch_content 是否复用 MyBuddy 浏览器已渲染页面。
 * - resolveCodexFallbackProvider：显式 provider=codex 不可用时的 fallback，
 *   尊重用户 searchRouting 顺序（codex 之后的第一个可用 provider），
 *   而非硬编码 firstAvailableProvider 顺序。
 */

import type { ResolvedSearchProvider } from "./gemini-search.ts";

export type BrowserReuseDecision =
  | { useBrowser: true; reason: "match" }
  | { useBrowser: false; reason: "not-single" | "not-readable" | "disabled" | "bridge-unavailable" | "no-match" | "read-failed" };

export interface DecideBrowserReuseInput {
  urls: string[];
  mode: string;
  browserReuseEnabled: boolean;
  bridgeAvailable: boolean;
  /** 主进程 resolver 对首个 URL 的匹配结果（"unknown" = 桥不可用/异常） */
  matchResult: "match" | "no-match" | "unknown";
}

export function decideBrowserReuse(input: DecideBrowserReuseInput): BrowserReuseDecision {
  if (input.urls.length !== 1) return { useBrowser: false, reason: "not-single" };
  if (input.mode !== "readable") return { useBrowser: false, reason: "not-readable" };
  if (!input.browserReuseEnabled) return { useBrowser: false, reason: "disabled" };
  if (!input.bridgeAvailable) return { useBrowser: false, reason: "bridge-unavailable" };
  if (input.matchResult !== "match") return { useBrowser: false, reason: "no-match" };
  return { useBrowser: true, reason: "match" };
}

/**
 * 显式 provider=codex 且 OAuth 不可用时的 fallback：
 * 1) 用户 searchRouting 中 codex 之后的第一个可用 provider（尊重配置）；
 * 2) 无 routing 或其后无可用 → 固定顺序第一个可用（openai 优先——与 openai 搜索同协议）；
 * 3) 全不可用 → 返回 "codex"（由调用方抛 provider 错误，走统一错误链）。
 */
export function resolveCodexFallbackProvider(
  available: Record<string, boolean>,
  routingProviders: ResolvedSearchProvider[] | undefined,
): ResolvedSearchProvider {
  if (routingProviders && routingProviders.length > 0) {
    const idx = routingProviders.indexOf("codex");
    if (idx >= 0) {
      for (const p of routingProviders.slice(idx + 1)) {
        if (available[p]) return p;
      }
    }
  }
  const fallbackOrder: ResolvedSearchProvider[] = ["openai", "exa", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "serpdive", "kagi", "ollama", "perplexity", "gemini", "searxng"];
  for (const p of fallbackOrder) {
    if (available[p]) return p;
  }
  return "codex";
}
