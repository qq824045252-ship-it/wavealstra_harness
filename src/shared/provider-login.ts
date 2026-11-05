/**
 * 登录后模型选用：对齐 pi `completeProviderAuthentication`。
 * /login 成功后，从 getAvailable 结果里挑该 provider 的默认模型（或该 provider 的第一项）。
 */

/** 与 pi-coding-agent `defaultModelPerProvider` 保持同步 */
export const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-4-8",
  openai: "gpt-6.1-sol",
  azure: "gpt-5.4",
  "openai-codex": "gpt-6.1-sol",
  radius: "balanced",
  nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-6.1-sol",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  xai: "grok-4.7",
  groq: "openai/gpt-oss-120b",
  cerebras: "gpt-oss-120b",
  zai: "glm-5.3",
  "zai-coding-cn": "glm-5.3",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k3",
  together: "moonshotai/Kimi-K3",
  baseten: "zai-org/GLM-5.2",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k3",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.3",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  "qwen-token-plan": "qwen3.7-max",
  "qwen-token-plan-cn": "qwen3.7-max",
  "qwen-token-plan-individual": "qwen3.8-max",
  xiaomi: "mimo-v2.6-pro",
  "xiaomi-token-plan-cn": "mimo-v2.6-pro",
  "xiaomi-token-plan-ams": "mimo-v2.6-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

export interface LoginSelectableModel {
  id: string;
  vendor?: string;
}

/**
 * 从登录后的可用模型里选出该 provider 应激活的模型。
 * 优先 `provider/defaultId`，否则该 provider 的第一项；没有该 provider 的模型则 undefined。
 */
export function pickDefaultModelAfterLogin(
  providerId: string,
  models: readonly LoginSelectableModel[],
): string | undefined {
  const pid = providerId.trim();
  if (!pid) return undefined;
  const prefix = `${pid}/`;
  const fromProvider = models.filter((model) => {
    if (model.vendor === pid) return true;
    return model.id === pid || model.id.startsWith(prefix);
  });
  if (fromProvider.length === 0) return undefined;
  const defaultId = DEFAULT_MODEL_PER_PROVIDER[pid];
  if (defaultId) {
    const exact = fromProvider.find(
      (model) => model.id === `${pid}/${defaultId}` || model.id === defaultId,
    );
    if (exact) return exact.id;
  }
  return fromProvider[0]?.id;
}

export function isLoginCancelledMessage(message: string): boolean {
  return /login cancelled|登录已取消|用户取消/i.test(message);
}
