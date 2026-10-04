/**
 * skill-root-guard-test 构建辅助：esbuild JS API（pi 包在 cjs bundle 下需要
 * import.meta.url define 兜底；同 build-cad-skill-sync.mjs 模式）。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "..", "out", "tests", "skill-root-guard-test.cjs");

await build({
  entryPoints: [join(here, "skill-root-guard-test.ts")],
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
