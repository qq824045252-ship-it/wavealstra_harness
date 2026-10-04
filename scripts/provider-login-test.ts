/**
 * Provider login/model selection: Pi-native auth only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL_PER_PROVIDER,
  isLoginCancelledMessage,
  pickDefaultModelAfterLogin,
} from "../src/shared/provider-login";

async function main(): Promise<void> {
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log("== pickDefaultModelAfterLogin ==");
{
  const models = [
    { id: "opencode-go/kimi-k2.6", vendor: "opencode-go" },
    { id: "opencode-go/mimo-v2.5", vendor: "opencode-go" },
    { id: "xai/grok-4.6", vendor: "xai" },
    { id: "xai/grok-3", vendor: "xai" },
    { id: "anthropic/claude-opus-4-8", vendor: "anthropic" },
  ];
  check(
    pickDefaultModelAfterLogin("xai", models) === "xai/grok-4.6",
    "xAI 登录后选用 grok-4.6",
  );
  check(
    pickDefaultModelAfterLogin("opencode-go", models) === "opencode-go/kimi-k2.6",
    "opencode-go 登录后选用 kimi-k2.6",
  );
  check(
    pickDefaultModelAfterLogin("anthropic", models) === "anthropic/claude-opus-4-8",
    "Anthropic 登录后选用默认 opus",
  );
  check(
    pickDefaultModelAfterLogin("openai", models) === undefined,
    "该 provider 无可用模型时不误选其它 provider",
  );
  check(
    pickDefaultModelAfterLogin("unknown-provider", [
      { id: "unknown-provider/custom-1", vendor: "unknown-provider" },
      { id: "unknown-provider/custom-2", vendor: "unknown-provider" },
    ]) === "unknown-provider/custom-1",
    "无默认表的 provider 回退到该 provider 第一项",
  );
  check(DEFAULT_MODEL_PER_PROVIDER.xai === "grok-4.6", "默认表含 xai/grok-4.6");
}

console.log("== isLoginCancelledMessage ==");
{
  check(isLoginCancelledMessage("Login cancelled"), "英文 Login cancelled");
  check(isLoginCancelledMessage("登录已取消"), "中文 登录已取消");
  check(isLoginCancelledMessage("用户取消"), "用户取消");
  check(!isLoginCancelledMessage("OAuth refresh failed"), "普通错误不算取消");
}

console.log("== Pi ModelRuntime credential store ==");
{
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-pi-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });

    await runtime.login("openai", "api_key", {
      prompt: async () => "sk-test",
      notify: () => undefined,
    });

    const afterLogin = await runtime.listCredentials();
    check(
      afterLogin.some((item) => item.providerId === "openai" && item.type === "api_key"),
      "ModelRuntime.login 持久化 API Key credential",
    );
    check(runtime.hasConfiguredAuth("openai"), "登录后 ModelRuntime 识别 provider 已认证");

    const reloaded = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const persisted = await reloaded.listCredentials();
    check(
      persisted.some((item) => item.providerId === "openai" && item.type === "api_key"),
      "新 ModelRuntime 从 Pi auth storage 读回 credential",
    );

    await reloaded.logout("openai");
    const afterLogout = await reloaded.listCredentials();
    check(
      !afterLogout.some((item) => item.providerId === "openai"),
      "ModelRuntime.logout 删除 credential",
    );

    const finalRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const finalCredentials = await finalRuntime.listCredentials();
    check(
      !finalCredentials.some((item) => item.providerId === "openai"),
      "logout 持久化到 Pi credential store",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\nFAILED ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}/${passed + failed}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
