/**
 * compat.ts — 对 pi 包符号/API 的稳健封装（P3）。
 *
 * 目标：pi 升级导致裸 TS 扩展静默加载失败时，把失败面收窄到本文件，
 * 并提供可见诊断（console.warn 一次性打印）。所有跨包 API 一律经此转发。
 */

// 一次性告警去重
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[subagent/compat] ${message}`);
}

// ---- 包导入（加载失败不阻止扩展注册其余部分） ----
// 注意：本文件必须被 index.ts 最先 import；若这些导入抛错，index.ts 的
// registerTool 会整体失败 —— 因此这里全部用可选链 + 兜底，保证符号缺失
// 时扩展仍能加载（仅相关功能降级）。
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";

export function getAgentDirCompat(): string {
  try {
    const dir = piCodingAgent.getAgentDir();
    if (typeof dir === "string" && dir.length > 0) return dir;
  } catch (err) {
    warnOnce("getAgentDir", `getAgentDir() 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 兜底：MyBuddy 通过 PI_CODING_AGENT_DIR 重定向；再兜底到 ~/.mybuddy
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  if (nodePath && nodeOs) return nodePath.join(nodeOs.homedir(), ".mybuddy");
  return process.env.USERPROFILE ?? "";
}

export function getConfigDirNameCompat(): string {
  try {
    const v = piCodingAgent.CONFIG_DIR_NAME;
    if (typeof v === "string") return v;
  } catch {
    /* ignore */
  }
  return ".pi";
}

export function parseFrontmatterCompat<T extends Record<string, string>>(content: string): {
  frontmatter: T;
  body: string;
} {
  try {
    return piCodingAgent.parseFrontmatter<T>(content);
  } catch (err) {
    warnOnce("parseFrontmatter", `parseFrontmatter 缺失/失败: ${err instanceof Error ? err.message : String(err)}`);
    return { frontmatter: {} as T, body: content };
  }
}

/** withFileMutationQueue：多进程/多扩展并发写文件时的串行化；缺失时退化为直写。 */
export async function withFileMutationQueueCompat(
  filePath: string,
  fn: () => Promise<void>,
): Promise<void> {
  const api = (piCodingAgent as { withFileMutationQueue?: (p: string, f: () => Promise<void>) => Promise<void> })
    .withFileMutationQueue;
  if (typeof api === "function") {
    try {
      return await api(filePath, fn);
    } catch (err) {
      warnOnce("wfmq", `withFileMutationQueue 失败，退化直写: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await fn();
}

export function getMarkdownThemeCompat() {
  try {
    return piCodingAgent.getMarkdownTheme();
  } catch {
    return undefined;
  }
}

export function tuiComponentsCompat() {
  // Container/Markdown/Spacer/Text 来自 @earendil-works/pi-tui；缺失时渲染降级为纯文本。
  try {
    return {
      Container: require("@earendil-works/pi-tui").Container,
      Markdown: require("@earendil-works/pi-tui").Markdown,
      Spacer: require("@earendil-works/pi-tui").Spacer,
      Text: require("@earendil-works/pi-tui").Text,
    };
  } catch (err) {
    warnOnce("pi-tui", `@earendil-works/pi-tui 不可用: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function stringEnumCompat(name: string, values: readonly string[], opts?: object) {
  try {
    return piAi.StringEnum(values as readonly [string, ...string[]], opts);
  } catch (err) {
    warnOnce("StringEnum", `StringEnum(${name}) 失败: ${err instanceof Error ? err.message : String(err)}`);
    return { type: "string", enum: [...values] };
  }
}

export type ExtensionApiShape = any;

export { piCodingAgent, piAgentCore, piAi };
