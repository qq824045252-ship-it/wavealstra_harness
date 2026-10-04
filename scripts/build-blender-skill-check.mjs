/**
 * Blender Skill 检查构建辅助：esbuild JS API。
 * 产出两个 bundle：
 * - out/tests/blender-skill-integration-check.cjs（沙箱集成检查，test-guard 执行）
 * - out/tests/verify-blender-skills.cjs（真实环境只读验证，直接 node 执行）
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["better-sqlite3", "electron"],
  define: {
    "import.meta.url": '"file:///C:/cjs-shim/index.js"',
  },
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [join(here, "blender-skill-integration-check.ts")],
  outfile: join(root, "out", "tests", "blender-skill-integration-check.cjs"),
});

await build({
  ...common,
  entryPoints: [join(here, "verify-blender-skills.ts")],
  outfile: join(root, "out", "tests", "verify-blender-skills.cjs"),
});

console.log("built blender skill checks");
