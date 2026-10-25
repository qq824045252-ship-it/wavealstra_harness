// 构建 TrayService 冒烟测试 bundle：把 `?asset` 导入解析成仓库里的真实图标路径
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

await build({
  entryPoints: [`${root}/src/main/TrayService.ts`],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  plugins: [
    {
      name: "asset-stub",
      setup(b) {
        b.onResolve({ filter: /\?asset$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?asset$/, "")),
          namespace: "asset",
        }));
        b.onLoad({ filter: /.*/, namespace: "asset" }, (args) => ({
          contents: `export default ${JSON.stringify(args.path)};`,
          loader: "js",
        }));
      },
    },
  ],
  outfile: `${root}/out/tests/tray-service-test.cjs`,
  logLevel: "silent",
});
console.log("built out/tests/tray-service-test.cjs");
