/**
 * Wave 5A — 预览页 bundle 构建（Golden/E2E 前置）
 *
 * esbuild 打包真实生产组件（CodeView / MarkdownArtifactView）为单文件 ESM：
 *   - alias "@/store/appStore" → mock（预览页无主进程 IPC）
 *   - alias "?worker&inline" 模块 → stub（esbuild 不支持 vite worker 语法）
 * 输出：out/tests/wave5a-preview.js（gitignored，由 golden/e2e 脚本引用）
 *
 * 运行：node scripts/build-wave5a-preview.mjs
 */
import { build } from "esbuild";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "out", "tests");
mkdirSync(OUT, { recursive: true });

// CSS：esbuild 解析 katex @import 等裸说明符 → 自包含单文件
await build({
  entryPoints: [join(ROOT, "src", "renderer", "src", "styles", "global.css")],
  outfile: join(OUT, "wave5a-preview.css"),
  bundle: true,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  logLevel: "warning",
});
console.log("[wave5a-preview] built → out/tests/wave5a-preview.css");

const result = await build({
  entryPoints: [join(ROOT, "scripts", "wave5a-preview-entry.tsx")],
  outfile: join(OUT, "wave5a-preview.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: false,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".css": "empty" },
  logLevel: "info",
  external: ["@terrastruct/d2", "mermaid", "stream-monaco", "@antv/infographic"],
  alias: {
    "@shared": join(ROOT, "src", "shared"),
    "@": join(ROOT, "src", "renderer", "src"),
    "@/store/appStore": join(ROOT, "scripts", "wave5a-store-mock.ts"),
    "@/lib/monacoWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
    "@/lib/pdfWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
  },
});

console.log("[wave5a-preview] built → out/tests/wave5a-preview.js");
