import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Electron 把 pi-coding-agent / pi-ai 打进 out/main/index.js 后，
 * `import.meta.url` 变成打包入口，pi-ai 里用变量 specifier 的
 * `import("./xai.ts")` 会去找 out/main/xai.js，登录直接炸。
 *
 * pi 官方独立二进制用同一套静态注册：把全部 OAuth flow 和 Bedrock
 * 实现打进包，运行时走 bundledLoaders，不再动态找相对路径。
 */
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

import { configurePiCodemodeAssets } from "./pi-codemode-assets";
configurePiCodemodeAssets(typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url)));
