/**
 * cad-skill-sync-check 构建辅助：esbuild JS API（define import.meta.url 规避
 * pi 包在 cjs bundle 下的顶层 import.meta 崩溃；CLI --define 在 Windows 引号转义不可靠）。
 * 与 scripts/build-tray-test.mjs 同一模式。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "..", "out", "tests", "cad-skill-sync-check.cjs");

await build({
  entryPoints: [join(here, "cad-skill-sync-check.ts")],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["better-sqlite3", "electron"],
  define: {
    "import.meta.url": '"file:///C:/cjs-shim/index.js"',
  },
  logLevel: "warning",
});
console.log(`built ${outfile}`);
