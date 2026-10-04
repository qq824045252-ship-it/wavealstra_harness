/**
 * build.mjs — 用 MyBuddy 仓库 node_modules 里的 esbuild 把扩展打包成 CJS bundle，
 * 供 node 直接加载测试（与 MyBuddy 的 jiti 加载路径解耦）。
 *
 * 打包要点（踩坑历史）：
 * - 全打包（不外部化 pi 包）：pi-ai 为纯 ESM 无 main，CJS require 会崩 → 全部 bundle 进 cjs。
 * - 顶层 `import.meta.url` 在 cjs 下未定义 → esbuild define 成假文件 URL
 *   （jiti/依赖里有顶层 import.meta 使用；Windows 必须用绝对 file:// 路径）。
 * - electron 外部化（测试环境无 electron，代码已 try/catch 降级）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");

// MyBuddy 仓库（含 esbuild / pi 包）可通过环境变量覆盖
const repo = resolve(process.env.MYBUDDY_REPO || "C:/Users/servi/Desktop/mybuddy");
const esbuildPath = join(repo, "node_modules", "esbuild");
if (!existsSync(esbuildPath)) {
  console.error(`esbuild 未找到: ${esbuildPath}（用 MYBUDDY_REPO 指定仓库）`);
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { build } = require(join(repo, "node_modules", "esbuild"));

const outfile = join(here, ".tmp", "subagent.bundle.cjs");

await build({
  entryPoints: [join(extDir, "index.ts")],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["electron"],
  nodePaths: [join(repo, "node_modules")],
  define: {
    "import.meta.url": '"file:///C:/cjs-shim/index.js"',
  },
  logLevel: "warning",
});

console.log(`bundle ok (cjs, 全打包 + import.meta define) -> ${outfile}`);
