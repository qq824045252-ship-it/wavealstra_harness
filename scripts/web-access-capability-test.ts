import { pageAnswerFallback } from "../src/main/capabilities/web-access/page-answer-fallback";
/**
 * WebAccess Capability 纯逻辑测试（P2-3/P3：browser reuse 决策、codex fallback、provider 一致性）。
 *
 * 测试对象 = repo 内建真源（src/main/capabilities/web-access），保证仓库内可复现、防漂移；
 * 生产运行时静态编译该目录，不存在 ~/.mybuddy/extensions 可执行副本。
 * 必须经 scripts/test-guard.mjs 执行。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// test-guard 在 repo 根运行；esbuild 打包为 cjs 时无 import.meta
const require = createRequire(join(process.cwd(), "package.json"));
const repo = process.cwd();

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

// ---------- 1) 从内建 Capability 真源加载 fetch-strategy（纯函数，无依赖） ----------
const bundledDir = join(repo, "src", "main", "capabilities", "web-access");
assert(existsSync(join(bundledDir, "fetch-strategy.ts")), "Capability 真源含 fetch-strategy.ts");
const strategySource = readFileSync(join(bundledDir, "fetch-strategy.ts"), "utf-8");

// 更稳：esbuild transform 把 bundled 纯 TS 模块转 cjs（无依赖），再以模块方式加载
const esbuild = require(join(repo, "node_modules", "esbuild")) as typeof import("esbuild");
function evalModule(): { decideBrowserReuse: (i: unknown) => unknown; resolveCodexFallbackProvider: (a: Record<string, boolean>, r?: string[]) => string } {
  const { code } = esbuild.transformSync(strategySource, {
    loader: "ts",
    format: "cjs",
    target: "node18",
    logLevel: "silent",
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", code)(mod, mod.exports);
  return {
    decideBrowserReuse: mod.exports.decideBrowserReuse as (i: unknown) => unknown,
    resolveCodexFallbackProvider: mod.exports.resolveCodexFallbackProvider as (a: Record<string, boolean>, r?: string[]) => string,
  };
}

console.log("== WebAccess Capability：decideBrowserReuse（Capability 真源） ==");
{
  const { decideBrowserReuse } = evalModule();
  const D = (over: Record<string, unknown>) =>
    decideBrowserReuse({
      urls: ["https://a.com/p"],
      mode: "readable",
      browserReuseEnabled: true,
      bridgeAvailable: true,
      matchResult: "match",
      ...over,
    }) as { useBrowser: boolean; reason: string };

  assert(D({}).useBrowser === true, "全条件满足 → 复用浏览器");
  assert(D({ urls: ["https://a.com/1", "https://a.com/2"] }).useBrowser === false, "多 URL → 不复用");
  assert(D({ mode: "raw" }).useBrowser === false, "raw 模式 → 不复用");
  assert(D({ browserReuseEnabled: false }).useBrowser === false, "开关关 → 不复用");
  assert(D({ bridgeAvailable: false }).useBrowser === false, "桥不可用 → 不复用");
  assert(D({ matchResult: "no-match" }).useBrowser === false, "URL 不匹配 → 不复用");
  assert(D({ matchResult: "unknown" }).useBrowser === false, "桥异常 → 不复用");
}

console.log("== WebAccess Capability：resolveCodexFallbackProvider（尊重 routing） ==");
{
  const { resolveCodexFallbackProvider } = evalModule();
  const available = (keys: string[]): Record<string, boolean> =>
    Object.fromEntries(keys.map((k) => [k, true]));
  const av = available(["openai", "exa", "brave"]);

  assert(resolveCodexFallbackProvider(av, ["codex", "openai"]) === "openai", "routing 中 codex 后第一个可用 → openai");
  assert(resolveCodexFallbackProvider(av, ["codex", "exa", "brave"]) === "exa", "routing 顺序尊重（exa）");
  assert(resolveCodexFallbackProvider(av, ["codex"]) === "openai", "routing 仅 codex → 固定顺序第一个（openai）");
  assert(resolveCodexFallbackProvider(av, undefined) === "openai", "无 routing → 固定顺序（openai）");
  assert(
    resolveCodexFallbackProvider(available(["brave"]), ["codex", "exa"]) === "brave",
    "routing 其后无可用 → 固定顺序兜底",
  );
  assert(resolveCodexFallbackProvider({}, ["codex"]) === "codex", "全不可用 → 原样（调用方抛 provider 错误）");
  assert(resolveCodexFallbackProvider(av, ["openai", "codex"]) === "openai", "codex 在 routing 末尾 → 其后为空 → 固定顺序第一个可用（openai）");
}

console.log("== WebAccess provider 一致性（shared UI 列表 ⊆ Capability 真源 RESOLVED） ==");
{
  const shared = readFileSync(join(repo, "src", "shared", "agent-ipc.ts"), "utf-8");
  const geminiSearch = readFileSync(join(bundledDir, "gemini-search.ts"), "utf-8");
  const sharedIds = [...shared.matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
  const extMatch = geminiSearch.match(/RESOLVED_SEARCH_PROVIDERS = \[([^\]]+)\]/);
  const extIds = extMatch ? [...extMatch[1].matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
  assert(extIds.length >= 15, `Capability 真源 provider 数（${extIds.length}）`);
  const missing = sharedIds.filter((x) => !extIds.includes(x));
  const extra = extIds.filter((x) => !sharedIds.includes(x));
  assert(missing.length === 0, `UI 列表无Capability 真源之外的 provider（${missing.join(",") || "无"}）`);
  assert(extra.length === 0, `Capability 真源 provider 全部在 UI 可配（缺: ${extra.join(",") || "无"}）`);
  assert(sharedIds.includes("codex"), "UI 含 codex");
}

console.log("== WebAccess Capability：index.ts 接线（防纯函数存在但接线被删假绿） ==");
{
  const indexSrc = readFileSync(join(bundledDir, "index.ts"), "utf-8");
  assert(
    indexSrc.includes("decideBrowserReuse({") &&
      indexSrc.includes("await bridge.tryBrowserReuse(urls[0], true)"),
    "fetchWithBrowserReuse 实际调用 decideBrowserReuse + bridge.tryBrowserReuse",
  );
  assert(
    indexSrc.includes("resolveCodexFallbackProvider(") &&
      indexSrc.includes('provider === "codex" && !available.codex'),
    "codex fallback 分支实际调用 resolveCodexFallbackProvider",
  );
  assert(indexSrc.includes('config.browserReuse?.enabled !== false'), "browserReuse 配置读取在接线内");
  const fetchStrategy = readFileSync(join(bundledDir, "fetch-strategy.ts"), "utf-8");
  assert(fetchStrategy.includes("useBrowser") && fetchStrategy.includes("resolveCodexFallbackProvider"), "纯函数导出保持");
}

console.log("== WebAccess product capability boundary ==");
{
  const indexSrc = readFileSync(join(bundledDir, "index.ts"), "utf-8");
  assert(indexSrc.includes("../../browser/browser-bridge"), "WebAccess directly imports the product browser bridge");
  assert(!indexSrc.includes("@mybuddy/browser-bridge"), "no virtual-module bridge remains");
  assert(!indexSrc.includes("loadBrowserBridge"), "no legacy dynamic bridge loader remains");
}

{
  const base = { mode: "answer", fetchError: null, content: "retrieved fact", url: "https://example.org", responseId: "r1", toolName: "get_search_content" };
  const recovered = pageAnswerFallback(base)!;
  assert(recovered.text.includes("retrieved fact") && recovered.text.includes("NOT a verified answer"), "synthesis failure retains explicitly unverified source text");
  assert(recovered.details.answerStatus === "failed" && recovered.details.fetched === true, "fetch success is distinct from answer failure");
  assert(pageAnswerFallback({ ...base, content: "x".repeat(10_000) })!.details.shownSourceChars === 4_000, "fallback is bounded");
  assert(pageAnswerFallback({ ...base, fetchError: "url-policy" }) === null, "access failure never exposes fallback");
  assert(pageAnswerFallback({ ...base, aborted: true }) === null, "aborted answer does not continue as fallback");
  assert(pageAnswerFallback({ ...base, content: "  " }) === null, "empty source is not fabricated");
  assert(pageAnswerFallback({ ...base, mode: "raw" }) === null, "non-answer behavior unchanged");
}
console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
