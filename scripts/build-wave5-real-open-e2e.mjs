/**
 * build-wave5-real-open-e2e.mjs — wave5-real-open e2e 测试 bundle 构建（JS API）。
 *
 * 背景：esbuild CLI 的 `--alias:@shared=...` 在 npm/Windows cmd 环境下传参不可靠
 * （参数被 npm script 解析改写，导致 @shared 别名静默丢失）。本脚本用 JS API 构建，
 * alias 与 build-wave5-real-open.mjs 保持一致（@ / @shared），由 test:artifact-open-e2e 调用。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outfile = join(root, "out", "tests", "wave5-real-open-e2e.cjs");

await build({
  entryPoints: [join(root, "scripts", "wave5-real-open-e2e.ts")],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["electron", "better-sqlite3", "@terrastruct/d2"],
  alias: {
    "@": join(root, "src", "renderer", "src"),
    "@shared": join(root, "src", "shared"),
  },
  logLevel: "warning",
});
console.log(`built ${outfile}`);
