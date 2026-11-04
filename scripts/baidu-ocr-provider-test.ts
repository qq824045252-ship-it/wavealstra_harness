import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBaiduOcrAdapter } from "../src/main/capabilities/providers/BaiduOcrProvider";
import type { BaiduOcrSettings } from "../src/main/capabilities/providers/BaiduOcrProvider";
import type { ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";

const root = await mkdtemp(join(tmpdir(), "mybuddy-baidu-ocr-"));
const taskRoot = join(root, "task");
await mkdir(taskRoot);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const imagePath = join(taskRoot, "sample.png");
await writeFile(imagePath, png);
await writeFile(join(root, "outside.png"), png);

let settings: BaiduOcrSettings = { apiKey: "fixture-client", secretKey: "fixture-secret", mode: "general", timeoutMs: 10_000 };
let tokenCalls = 0, ocrCalls = 0, rejectToken = false, badLocation = false, errorCode: number | undefined;
const seen: Array<{ url: URL; body: URLSearchParams; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined; headers: Headers }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = new URLSearchParams(String(init?.body));
  const headers = new Headers(init?.headers);
  seen.push({ url, body, redirect: init?.redirect, signal: init?.signal, headers });
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error", "credentials cannot follow redirects");
  assert.equal(url.origin, "https://aip.baidubce.com", "the adapter never calls untrusted hosts");
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert(init?.signal, "all requests are bounded and cancellable");
  if (url.pathname === "/oauth/2.0/token") {
    tokenCalls++;
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_id"), settings.apiKey);
    assert.equal(body.get("client_secret"), settings.secretKey);
    assert.equal(url.search, "", "keys must not be placed in the OAuth URL");
    return json({ access_token: "fixture-access-token-" + tokenCalls, expires_in: 2592000 });
  }
  ocrCalls++;
  assert.match(url.pathname, /^\/rest\/2\.0\/ocr\/v1\/(general|general_basic|accurate|accurate_basic)$/);
  assert.equal(body.get("image"), png.toString("base64"));
  assert(!body.toString().includes("fixture-client") && !body.toString().includes("fixture-secret"));
  if (rejectToken) { rejectToken = false; return json({ error_code: 110, error_msg: settings.secretKey }); }
  if (errorCode !== undefined) return json({ error_code: errorCode, error_msg: settings.secretKey });
  return json({ words_result: settings.mode?.endsWith("_basic")
    ? [{ words: "第一行" }, { words: "第二行" }]
    : [{ words: "第一行", location: badLocation ? { left: 0, top: 1, width: -1, height: 10 } : { left: 10, top: 20, width: 100, height: 22 }, probability: { average: 0.96 } },
      { words: "第二行", location: { left: 12, top: 45, width: 60, height: 18 } }] });
}) as typeof fetch;

const context: ToolExecutionContext = { taskId: "task", taskRoot, toolCallId: "ocr-call" };
const adapter = createBaiduOcrAdapter({ getSettings: () => settings, fetch: fakeFetch });
try {
  const result = await adapter.recognize(imagePath, context);
  assert.equal(result.text, "第一行\n第二行");
  assert.deepEqual(result.boxes, [
    { text: "第一行", x: 10, y: 20, width: 100, height: 22, confidence: 0.96 },
    { text: "第二行", x: 12, y: 45, width: 60, height: 18 },
  ]);
  assert.equal(tokenCalls, 1); assert.equal(ocrCalls, 1);
  assert.equal(seen[1].url.pathname, "/rest/2.0/ocr/v1/general");
  assert.equal(seen[1].url.searchParams.get("access_token"), "fixture-access-token-1");
  assert(!JSON.stringify(result).includes(settings.secretKey));

  settings = { ...settings, mode: "accurate_basic" };
  assert.deepEqual(await adapter.recognize(imagePath, context), { text: "第一行\n第二行" },
    "without coordinates, do not fabricate text boxes");
  assert.equal(tokenCalls, 1, "OAuth token is reused until rotation or expiry");
  assert.equal(seen.at(-1)?.url.pathname, "/rest/2.0/ocr/v1/accurate_basic");

  settings = { ...settings, apiKey: "replacement-client", secretKey: "replacement-secret", mode: "accurate" };
  await adapter.recognize(imagePath, context);
  assert.equal(tokenCalls, 2, "a changed key pair invalidates the old token");
  assert.equal(seen.at(-1)?.url.pathname, "/rest/2.0/ocr/v1/accurate");

  rejectToken = true;
  const beforeRetry = ocrCalls;
  await adapter.recognize(imagePath, context);
  assert.equal(tokenCalls, 3);
  assert.equal(ocrCalls, beforeRetry + 2, "only explicit invalid-token error is retried once");

  errorCode = 17;
  const beforeFailure = ocrCalls;
  await assert.rejects(adapter.recognize(imagePath, context), err => err instanceof Error &&
    err.message.includes("额度") && !err.message.includes(settings.secretKey));
  assert.equal(ocrCalls, beforeFailure + 1, "quota failure must not be retried");
  errorCode = undefined;

  badLocation = true;
  await assert.rejects(adapter.recognize(imagePath, context), /文字坐标无效/);
  badLocation = false;

  const beforeInvalid = seen.length;
  await assert.rejects(adapter.recognize(join(root, "outside.png"), context), /current task|任务/);
  assert.equal(seen.length, beforeInvalid, "out-of-task image is never uploaded");

  settings = { ...settings, mode: "not-supported" as BaiduOcrSettings["mode"] };
  await assert.rejects(adapter.recognize(imagePath, context), /模式无效/);
  assert.equal(seen.length, beforeInvalid);
  settings = { ...settings, mode: "general_basic" };

  const abort = new AbortController(); abort.abort("private abort reason");
  await assert.rejects(adapter.recognize(imagePath, { ...context, signal: abort.signal }), err =>
    err instanceof Error && !err.message.includes("private abort reason"));
  assert.equal(seen.length, beforeInvalid);
  console.log("PASS Baidu OCR provider: two-key OAuth, four modes, coordinates, cache rotation, safe errors and task boundary");
} finally {
  await rm(root, { recursive: true, force: true });
}
