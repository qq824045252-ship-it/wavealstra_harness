/**
 * PDF Runtime Preview — 真实 worker 版 preview bundle（PDF Runtime E2E 前置）
 *
 * 与 build-wave5a-preview.mjs 的区别：pdfWorkerEntry?worker&inline 不再 alias 到
 * 抛错 stub（stub → fake worker 主线程路径，主线程 legacy polyfill 掩盖 toHex
 * 缺口），而是 alias 到 pdf-worker-inline-entry.ts —— 真实 blob worker。
 *
 * 两步：
 *   1. 先把 pdfjs-dist/legacy/build/pdf.worker.min.mjs 独立打包为 IIFE
 *      （out/tests/pdf.worker.legacy.iife.js），供 inline entry 以 ?raw 内联；
 *   2. 打包 preview entry（真实生产组件 + 真实 legacy worker）。
 *
 * 运行：node scripts/build-pdf-runtime-preview.mjs
 */
import { build } from "esbuild";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "out", "tests");
mkdirSync(OUT, { recursive: true });

// 步骤 1：legacy pdfjs worker → 自包含 IIFE（classic blob worker）
// pdfjs 的 WasmImage 动态 import（/*webpackIgnore*/ /*@vite-ignore*/）在 classic
// worker 里是语法错误（Unexpected identifier）。该 import 是 pdfjs 允许打包器
// 绕过的（注释明示），且调用方自带 try/catch 降级（wasm 缺失 → warn）。
// 因此 bundle 后把 `await import(` 替换为 `await Promise.reject(`：语法合法，
// 语义 = wasm 模块加载失败 → 走 pdfjs 原有 catch 降级（与生产 vite-ignore 的
// 运行时失败行为一致，但语法层可解析）。
await build({
  entryPoints: [join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs")],
  outfile: join(OUT, "pdf.worker.legacy.iife.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  logLevel: "warning",
});
{
  const out = join(OUT, "pdf.worker.legacy.iife.js");
  let code = readFileSync(out, "utf-8");
  const dynamicImports = [...code.matchAll(/await\s+import\(/g)].length;
  if (dynamicImports !== 1) {
    throw new Error(`[pdf-runtime-preview] legacy worker 动态 import 数量异常: ${dynamicImports}（预期 1 处 WasmImage）`);
  }
  code = code.replace(/await\s+import\(/g, "await Promise.reject(");
  writeFileSync(out, code);
  console.log(`[pdf-runtime-preview] legacy worker → out/tests/pdf.worker.legacy.iife.js（替换 ${dynamicImports} 处动态 import → Promise.reject 降级）`);
  // 文本副本：esbuild 不支持 Vite 的 `?raw` 后缀（会按普通 JS 模块打包，default 导出
  // 为 undefined → blob worker 代码变成 "undefined" → SyntaxError，E2E 全部挂起）。
  // 测试 bundle 用 `.txt` + text loader 把 worker 源码原样嵌入为字符串。
  writeFileSync(join(OUT, "pdf.worker.legacy.iife.txt"), code);
}

// CSS（与 wave5a-preview 同源，esbuild 解析 katex @import 等裸说明符）
await build({
  entryPoints: [join(ROOT, "src", "renderer", "src", "styles", "global.css")],
  outfile: join(OUT, "pdf-runtime-preview.css"),
  bundle: true,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  logLevel: "warning",
});
console.log("[pdf-runtime-preview] css → out/tests/pdf-runtime-preview.css");

// 步骤 2：preview entry（真实生产组件；worker 为真实内联 legacy blob worker）
const result = await build({
  entryPoints: [join(ROOT, "scripts", "wave5a-preview-entry.tsx")],
  outfile: join(OUT, "pdf-runtime-preview.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  external: ["@terrastruct/d2"],
  sourcemap: false,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".css": "empty", ".txt": "text" },
  logLevel: "info",
  alias: {
    "@shared": join(ROOT, "src", "shared"),
    "@": join(ROOT, "src", "renderer", "src"),
    "@/store/appStore": join(ROOT, "scripts", "wave5a-store-mock.ts"),
    "@/lib/monacoWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
    // 关键差异：真实内联 legacy worker（生产形态），不是抛错 stub
    "@/lib/pdfWorkerEntry?worker&inline": join(ROOT, "scripts", "pdf-worker-inline-entry.ts"),
  },
});

console.log("[pdf-runtime-preview] built → out/tests/pdf-runtime-preview.js");
