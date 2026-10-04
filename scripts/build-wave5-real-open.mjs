/**
 * Wave 5 Real Open — Product Path E2E bundle 构建（V3.5 hotfix §19）
 *
 * 与 wave5a-preview 不同：**不 alias appStore**（真实 store + 真实 ArtifactPanel），
 * 仅 stub vite worker 模块（esbuild 不支持 ?worker&inline）。
 * CSS 复用 wave5a-preview.css（build-wave5a-preview.mjs 产物）。
 *
 * 运行：node scripts/build-wave5-real-open.mjs
 */
import { build } from "esbuild";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "out", "tests");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(ROOT, "scripts", "wave5-real-open-entry.tsx")],
  outfile: join(OUT, "wave5-real-open.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: false,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".css": "empty" },
  logLevel: "warning",
  alias: {
    "@": join(ROOT, "src", "renderer", "src"),
    "@shared": join(ROOT, "src", "shared"),
    "@/lib/monacoWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
    "@/lib/pdfWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
  },
});

console.log("[wave5-real-open] built → out/tests/wave5-real-open.js");
