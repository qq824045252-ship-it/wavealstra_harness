import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_CODEX_IMAGE_MODEL,
  BUILTIN_CODEX_IMAGE_PROVIDER_ID,
} from "../src/shared/builtin-capabilities";
import {
  createCodexImageCapabilityProvider,
  extractChatGptAccountId,
} from "../src/main/capabilities/CodexImageCapabilityProvider";

function testJwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

async function main(): Promise<void> {
  const token = testJwt("acct_test_123");
  assert.equal(extractChatGptAccountId(token), "acct_test_123");
  assert.equal(extractChatGptAccountId("invalid"), null);

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      created: 1787688000,
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
      quality: "high",
      size: "1536x1024",
      background: "opaque",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const runtime = {
    hasConfiguredAuth: (providerId: string) => providerId === "openai-codex",
    isUsingOAuth: (providerId: string) => providerId === "openai-codex",
    getAuth: async () => ({ auth: { apiKey: token } }),
  };
  const provider = createCodexImageCapabilityProvider({
    getRuntime: () => runtime as never,
    fetchImpl: fakeFetch as typeof fetch,
  });
  assert.equal(provider.id, BUILTIN_CODEX_IMAGE_PROVIDER_ID);
  assert.equal(provider.isAvailable?.(), true);
  assert.match(await provider.test!(), /GPT Image 2/);
  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/codex/models?client_version=0.1.0");

  const generated = await provider.generateImage!({
    prompt: "A minimal blue circle",
    aspectRatio: "16:9",
    count: 1,
  }, {
    taskId: "task-test",
    taskRoot: process.cwd(),
    toolCallId: "tool-test",
  });
  assert.equal(generated.provider, BUILTIN_CODEX_IMAGE_PROVIDER_ID);
  assert.equal(generated.model, BUILTIN_CODEX_IMAGE_MODEL);
  assert.equal(Buffer.from(generated.items[0]!.bytes!).toString(), "png-bytes");
  assert.equal(requests[1]?.url, "https://chatgpt.com/backend-api/codex/images/generations");
  assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(requests[1]?.headers.get("chatgpt-account-id"), "acct_test_123");
  assert.equal(requests[1]?.body.model, "gpt-image-2");
  assert.equal(requests[1]?.body.size, "1536x1024");

  const root = mkdtempSync(join(tmpdir(), "mybuddy-codex-image-"));
  try {
    const source = join(root, "source.png");
    writeFileSync(source, Buffer.from("reference"));
    await provider.generateImage!({ prompt: "Edit this image", inputImagePaths: [source] }, {
      taskId: "task-edit",
      taskRoot: root,
      toolCallId: "tool-edit",
    });
    assert.equal(requests[2]?.url, "https://chatgpt.com/backend-api/codex/images/edits");
    const images = requests[2]?.body.images as Array<{ image_url?: string }>;
    assert.equal(images.length, 1);
    assert.match(images[0]?.image_url ?? "", /^data:image\/png;base64,/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const unavailable = createCodexImageCapabilityProvider({
    getRuntime: () => ({
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getAuth: async () => undefined,
    }) as never,
    fetchImpl: fakeFetch as typeof fetch,
  });
  assert.equal(unavailable.isAvailable?.(), false, "API-key auth must not be treated as ChatGPT Codex OAuth");

  console.log("codex image capability: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
