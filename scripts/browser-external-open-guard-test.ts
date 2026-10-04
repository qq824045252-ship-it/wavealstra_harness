/**
 * Browser External Open Guard — stale preload 回归门（V3.5 fa0174e 后续）
 *
 * 背景：fa0174e 新增「在系统浏览器打开」（renderer 按钮 + preload artifact.openInBrowser
 * + main artifact:openInBrowser IPC）。运行中的 Electron preload/main 不会随 renderer
 * HMR 更新——若应用未完整重启，renderer 已有新按钮，但 window.api.artifact.openInBrowser
 * 仍不存在。旧实现直接调用它：缺失时抛 TypeError / 仅 console.warn，用户无感知。
 *
 * 本 gate 锁定修复形态（不跑 Electron E2E，纯静态源码断言）：
 *   1. HtmlArtifactView 不得存在直接无保护调用 window.api?.artifact?.openInBrowser(
 *   2. 调用前必须有 typeof 能力守卫（缺失 → 提示重启，不调用、不抛错）
 *   3. 能力缺失提示文案「请重启 MyBuddy 后重试」必须存在
 *   4. IPC invoke 的 reject 必须有 .catch 兜底并转用户提示
 *   5. BrowserNavBar 的打开按钮必须支持 openDisabled（stale preload 时禁用）
 *   6. disabled 态必须带明确 title 提示「需重启 MyBuddy 后使用」
 *
 * 运行：pnpm test:browser-open-guard（node 直接跑，无需 esbuild）
 * 退出码：全部 PASS = 0；任一 FAIL = 1。
 */
// 注：CJS require 写法（Node 24 type-stripping 下按 CommonJS 解析，避免 ESM 警告）
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

/** 仓库根：从 cwd 向上找含 package.json 的目录 */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根（package.json）");
    dir = parent;
  }
}
const ROOT = findRoot(process.cwd());

const results: Array<{ rule: string; pass: boolean; detail: string }> = [];

function check(rule: string, pass: boolean, detail = ""): void {
  results.push({ rule, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${rule}${detail ? `  — ${detail}` : ""}`);
}

/** 剔除行注释与块注释（状态机；字符串内注释不处理——gate 用途足够） */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i += 1;
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const viewSrc = stripComments(
  readFileSync(join(ROOT, "src", "renderer", "src", "components", "artifact", "HtmlArtifactView.tsx"), "utf-8"),
);
const navSrc = stripComments(
  readFileSync(join(ROOT, "src", "renderer", "src", "components", "artifact", "BrowserNavBar.tsx"), "utf-8"),
);

// R1：旧形态直接无保护调用必须消失（fa0174e: void window.api?.artifact?.openInBrowser({...}).then(...)）
const directCall = /window\.api\?\.artifact\?\.openInBrowser\s*\(/.test(viewSrc);
check("R1 无直接无保护调用 window.api?.artifact?.openInBrowser(", !directCall, directCall ? "存在裸调用（缺失 API 会抛 TypeError）" : "调用已改为守卫后的局部引用");

// R2：调用前必须有 typeof 能力守卫（stale preload 不调用、不抛错）
const guard = /typeof\s+open\s*!==\s*["']function["']/.test(viewSrc) || /typeof\s+window\.api\?\.artifact\?\.openInBrowser\s*!==\s*["']function["']/.test(viewSrc);
check("R2 调用前存在 typeof 能力守卫", guard, guard ? "typeof open !== 'function' → 提示重启" : "缺能力守卫（缺失 API 会抛 TypeError）");

// R3：能力缺失提示文案必须存在（用户可见，非 console.warn）
const noticeText = viewSrc.includes("请重启 MyBuddy 后重试");
check("R3 能力缺失提示「请重启 MyBuddy 后重试」存在", noticeText, noticeText ? "视图内展示重启提示" : "缺用户可见提示（仅 console.warn 用户看不到）");

// R4：IPC invoke reject 必须有 .catch 兜底并转提示
const catchFallback = /\.catch\s*\(/.test(viewSrc);
check("R4 IPC 调用有 .catch 兜底（reject → 用户提示）", catchFallback, catchFallback ? "reject 转为 openBrowserError 提示" : "缺 .catch（reject 会变 unhandled rejection）");

// R5：BrowserNavBar 打开按钮必须支持 disabled（openDisabled prop + disabled 属性）
const openDisabledProp = /openDisabled\?:?\s*boolean/.test(navSrc) && /disabled=\{openDisabled\}/.test(navSrc);
check("R5 打开按钮支持 openDisabled（stale preload 时禁用）", openDisabledProp, openDisabledProp ? "openDisabled prop + disabled={openDisabled}" : "按钮缺 disabled 支持");

// R6：disabled 态必须带明确 title 提示
const disabledTitle = navSrc.includes("需重启 MyBuddy");
check("R6 disabled 态 title 提示「需重启 MyBuddy 后使用」存在", disabledTitle, disabledTitle ? "disabled 时 title 说明原因" : "disabled 态缺 title 提示（用户不知道为什么禁用）");

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`Browser External Open Guard: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((r) => r.rule).join(", ")}`);
  process.exit(1);
}
console.log("OK — stale preload 下打开按钮不再静默失效");
