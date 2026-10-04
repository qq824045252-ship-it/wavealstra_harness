/**
 * 验打包产物：electron-vite 打完的 out/main 必须内含全部 OAuth 实现，
 * 且入口必须静态注册 bundled loaders。找不到 out/main/xai.js 是预期——
 * 代码必须在 bundle 里，不能靠旁边再扔一份相对文件。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const mainDir = join(repo, "out", "main");
const mainEntry = join(mainDir, "index.js");

if (!existsSync(mainEntry)) {
  throw new Error("out/main/index.js 不存在：先跑 pnpm exec electron-vite build");
}

const files = readdirSync(mainDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, text: readFileSync(join(mainDir, name), "utf-8") }));
const blob = files.map((file) => file.text).join("\n");

const fingerprints: Array<[string, RegExp]> = [
  ["xai device-code", /auth\.x\.ai\/oauth2\/device\/code/],
  ["anthropic oauth", /claude\.ai\/oauth\/authorize/],
  ["openai-codex oauth", /auth\.openai\.com/],
  ["github-copilot oauth", /login\/device\/code/],
  ["openrouter oauth", /openrouter\.ai\/auth/],
  ["kimi-coding oauth", /auth\.kimi\.com/],
  ["registerBunOAuthFlows / bundled loaders", /registerBundledOAuthFlowLoaders|registerBunOAuthFlows/],
  ["bedrock module register", /setBedrockProviderModule/],
];

const missing = fingerprints.filter(([, re]) => !re.test(blob));
if (missing.length > 0) {
  throw new Error(
    `out/main 缺少全量 OAuth/Bedrock 实现：${missing.map(([name]) => name).join(", ")}`,
  );
}

if (existsSync(join(mainDir, "xai.js"))) {
  console.log("  note: out/main/xai.js 存在（动态 import 兜底），但主路径应走 bundle");
}

console.log(`  ✓ out/main 含全部 OAuth + Bedrock 指纹（${files.length} 个 js）`);
console.log("OK oauth-bundle-verify");
