// 构建 TrayService 冒烟测试 bundle：用插件把 `?asset` 导入 stub 成本地图标路径
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const iconPath = `${root}/src/main/assets/tray.ico`;

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
          path: iconPath,
          namespace: "asset",
        }));
        b.onLoad({ filter: /.*/, namespace: "asset" }, () => ({
          contents: `export default ${JSON.stringify(iconPath)};`,
          loader: "js",
        }));
      },
    },
  ],
  outfile: `${root}/out/tests/tray-service-test.cjs`,
  logLevel: "silent",
});
console.log("built out/tests/tray-service-test.cjs");
