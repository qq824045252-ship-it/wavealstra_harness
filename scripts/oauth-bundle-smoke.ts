/**
 * 复现并验收：electron-vite 把 pi-ai 打进单文件后，OAuth 动态 import 不能再找
 * out/main/xai.js。本脚本用同样的「整包打进一个文件」方式打包，然后对每个
 * 带 oauth.login 的 provider 真正调用 login()。
 *
 * 失败形态（修之前）：Cannot find module '.../xai.js'
 * 通过：模块加载成功（网络取消 / Login cancelled 都算过，找不到模块才算挂）
 */
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const REQUIRED_OAUTH = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
  "kimi-coding",
  "xai",
  "radius",
] as const;

function isMissingModule(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message);
}

async function loadOAuth(providerId: string, login: (interaction: {
  signal: AbortSignal;
  prompt: (prompt: { type: string; message: string }) => Promise<string>;
  notify: (event: { type: string }) => void;
}) => Promise<unknown>): Promise<void> {
  const abort = new AbortController();
  const pending = login({
    signal: abort.signal,
    prompt: async () => {
      throw new Error("Login cancelled");
    },
    notify: () => {},
  });
  abort.abort();
  try {
    await pending;
  } catch (err) {
    if (isMissingModule(err)) throw err;
  }
}

registerBunOAuthFlows();

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-oauth-smoke-"));
  writeFileSync(join(dir, "auth.json"), "{}\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));

  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });

  const oauthProviders = runtime
    .getProviders()
    .filter((provider) => Boolean(provider.auth?.oauth?.login));
  const seen = new Set(oauthProviders.map((provider) => provider.id));

  const missingRequired = REQUIRED_OAUTH.filter((id) => !seen.has(id));
  if (missingRequired.length > 0) {
    throw new Error(`运行时缺少 OAuth provider：${missingRequired.join(", ")}`);
  }

  const failures: string[] = [];
  for (const provider of oauthProviders) {
    const login = provider.auth.oauth?.login;
    if (!login) continue;
    try {
      await loadOAuth(provider.id, login);
      console.log(`  ✓ ${provider.id} oauth.login 已加载（未再找相对 xai.js）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.id}: ${message}`);
      console.error(`  ✗ ${provider.id} ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`OAuth 模块加载失败：\n${failures.join("\n")}`);
  }

  const here = pathToFileURL(process.argv[1] ?? "").pathname;
  console.log(`OK ${oauthProviders.length} 个 OAuth provider 可在打包后加载（${here}）`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
