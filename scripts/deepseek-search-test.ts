import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every transport is a fixture; do not read a user's profile/keyring or call a live provider.
const profile = mkdtempSync(join(tmpdir(), "mybuddy-deepseek-search-"));
const previousProfile = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = profile;
const configPath = join(profile, "web-search.json");
let passed = 0;
async function test(name: string, action: () => unknown | Promise<unknown>) {
  await action(); passed++; console.log(`PASS ${name}`);
}
const secret = "fixture-deepseek-secret";
const connection = { baseUrl: "https://api.deepseek.com", apiKey: secret, timeoutMs: 1000 };
const item = {
  title: "Instrument specification", url: "https://example.com/spec", snippet: "Original short excerpt.",
  summary: "Provider-generated synthesis; not the original page.", content: "# Original page\n\nMeasurement: 42.0 μm.",
  site_name: "Example", site_icon: "https://example.com/favicon.ico", date: "2026-10-10T12:00:00+00:00",
  rerank_score: 2.4, authority: 3,
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const unexpectedFetch: typeof fetch = async () => { throw new Error("Unexpected network request in isolated DeepSeek fixture"); };
globalThis.fetch = unexpectedFetch;

try {
  const { createDeepSeekWebClient, deepSeekSearchQuery, getDeepSeekWebSettings } = await import("../src/main/capabilities/web-access/deepseek");
  const { normalizeFetchContentParams } = await import("../src/main/capabilities/web-access/fetch-params");
  const { shouldUseDeepSeekFetch } = await import("../src/main/capabilities/web-access/fetch-strategy");
  const { activityMonitor } = await import("../src/main/capabilities/web-access/activity");
  const { buildWebSearchReport, formatWebSearchReport } = await import("../src/main/capabilities/web-access/search-report");
  const { DEFAULT_SEARCH_POLICY, normalizeSearchPolicy } = await import("../src/shared/web-search");

  await test("Search posts the documented JSON fields to exactly one v1/tools prefix", async () => {
    for (const baseUrl of [connection.baseUrl, `${connection.baseUrl}/`, `${connection.baseUrl}/v1`, `${connection.baseUrl}/v1/`]) {
      const client = createDeepSeekWebClient({ resolveConnection: () => ({ ...connection, baseUrl }), fetch: async (url, init) => {
        assert.equal(url, "https://api.deepseek.com/v1/tools/search");
        assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${secret}`);
        assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
        assert.deepEqual(JSON.parse(String(init?.body)), { query: "measurement", count: 7, need_content: true, ori_question: "What is the measured value?" });
        return json({ results: [item] });
      } });
      const result = await client.search("measurement", { numResults: 7, includeContent: true, originalQuestion: "What is the measured value?" });
      assert.equal(result.results[0].snippet, item.snippet);
      assert.equal(result.results[0].summary, item.summary);
      assert.equal(result.results[0].evidence, "snippet");
      assert.equal(result.results[0].publishedAt, item.date);
      assert.equal(result.results[0].siteName, item.site_name);
      assert.equal(result.results[0].rerankScore, item.rerank_score);
      assert.equal(result.results[0].authority, item.authority);
      assert.equal(result.answer, "");
      assert.equal(result.inlineContent?.[0].content, item.content);
      assert.equal(result.inlineContent?.[0].provider, "deepseek");
    }
  });

  await test("Unicode/count validation and original-question bounds fail before a request", async () => {
    let requests = 0;
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async (_url, init) => {
      requests++; const body = JSON.parse(String(init?.body));
      assert.equal([...body.query].length, 128); assert.equal(body.count, 50);
      return json({ results: [] });
    } });
    await client.search("😀".repeat(128), { numResults: 50 });
    for (const query of ["", " \n ", "x".repeat(129), "😀".repeat(129)]) await assert.rejects(client.search(query), /128 Unicode/);
    for (const numResults of [0, 51, 1.5, NaN]) await assert.rejects(client.search("valid", { numResults }), /1 to 50/);
    await assert.rejects(client.search("valid", { originalQuestion: "文".repeat(129) }), /128 Unicode/);
    await assert.rejects(client.search("x".repeat(120), { domainFilter: ["example.com"] }), /including filters/);
    assert.equal(requests, 1);
  });

  await test("existing domain and recency filters become documented operators", () => {
    assert.equal(deepSeekSearchQuery("measurement", { domainFilter: ["example.com", "docs.example.com", "-ads.example.com"], recencyFilter: "week" }, Date.UTC(2026, 10, 15)),
      "measurement site:example.com OR site:docs.example.com -site:ads.example.com after:2026-11-08");
    assert.throws(() => deepSeekSearchQuery("query", { domainFilter: ["example.com injected:operator"] }), /hostnames/);
  });

  await test("snippet, summary, unavailable content and empty results remain distinct", async () => {
    let payload: unknown = { results: [{ ...item, content: "" }] };
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => json(payload) });
    const summaryOnly = await client.search("query", { includeContent: true });
    assert.equal(summaryOnly.inlineContent, undefined);
    assert.equal(summaryOnly.results[0].snippet, item.snippet);
    assert.equal(summaryOnly.results[0].summary, item.summary);
    const report = buildWebSearchReport("deepseek", ["query"], [{ query: "query", ...summaryOnly, provider: "deepseek", error: null }]);
    assert.equal(report.sources[0].evidence, "snippet");
    assert.match(formatWebSearchReport(report), /Provider summary \(unverified, not page content\)/);
    payload = { results: [item] };
    assert.equal((await client.search("query", { includeContent: false })).inlineContent, undefined);
    payload = { results: [] };
    assert.deepEqual(await client.search("query"), { answer: "", results: [] });
  });

  await test("malformed successful payloads are not accepted as search evidence", async () => {
    for (const payload of [{}, { results: null }, { results: [{ ...item, summary: null }] }, { results: [{ ...item, url: "javascript:alert(1)" }] }]) {
      const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => json(payload) });
      await assert.rejects(client.search("query"), /invalid (?:response|request)/);
    }
  });

  await test("HTTP 200 error envelopes and malformed Fetch responses remain failures", async () => {
    for (const payload of [{ error: { message: "provider failure", code: "fixture" } }, { title: "Page" }, { title: "Page", content: "" }]) {
      const client = createDeepSeekWebClient({ resolveConnection: () => connection, validateUrl: async () => {}, fetch: async () => json(payload) });
      await assert.rejects(client.fetch(item.url), /API error 200|invalid response/);
    }
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => json({ error: { message: `failure ${secret}` }, results: [item] }) });
    await assert.rejects(client.search("query"), (error: Error) => { assert.match(error.message, /API error 200/); assert(!error.message.includes(secret)); return true; });
  });

  await test("provider errors preserve status for existing fallback and redact credentials", async () => {
    for (const status of [400, 401, 402, 403, 408, 429, 500, 504]) {
      const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => json({ error: { message: `failure for ${secret}`, type: "provider_error", code: "fixture" } }, status) });
      await assert.rejects(client.search("query"), (error: Error) => {
        assert.match(error.message, new RegExp(`API error ${status}:`)); assert(!error.message.includes(secret)); return true;
      });
    }
    assert(!JSON.stringify(activityMonitor.getEntries()).includes(secret));
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => new Response("<html>gateway failed</html>", { status: 502 }) });
    await assert.rejects(client.search("query"), /API error 502/);
  });

  await test("cancellation and timeout abort the same HTTP request without retries", async () => {
    let requests = 0;
    const transport: typeof fetch = async (_url, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const client = createDeepSeekWebClient({ resolveConnection: () => ({ ...connection, timeoutMs: 25 }), fetch: transport });
    const cancel = client.search("query", { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    await assert.rejects(cancel, { name: "AbortError" });
    // AbortSignal.timeout is intentionally unref'ed; this fixture owns the event-loop timer.
    const keepAlive = setTimeout(() => {}, 100);
    try { await assert.rejects(client.search("query"), { name: "TimeoutError" }); } finally { clearTimeout(keepAlive); }
    const before = requests;
    await assert.rejects(client.search("query", { signal: AbortSignal.abort() }));
    assert.equal(requests, before); assert.equal(requests, 2);
  });

  await test("Fetch sends only the URL and returns the provider Markdown as original content", async () => {
    let validated = false;
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, validateUrl: async url => { assert.equal(url.href, item.url); validated = true; }, fetch: async (url, init) => {
      assert(validated); assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
      assert.deepEqual(JSON.parse(String(init?.body)), { url: item.url });
      assert.equal(init?.redirect, "error"); return json({ title: "", content: item.content });
    } });
    const page = await client.fetch(item.url);
    assert.equal(page.content, item.content); assert.equal(page.title, "");
    assert.equal(page.mimeType, "text/markdown"); assert.equal(page.provider, "deepseek");
  });

  await test("Fetch rejects credentials, unsupported protocols, oversized URLs and blocked hosts locally", async () => {
    let requests = 0;
    const client = createDeepSeekWebClient({ resolveConnection: () => connection, fetch: async () => { requests++; return json({ title: "Page", content: "body" }); } });
    for (const url of ["file:///tmp/private", "https://user:password@example.com", `https://example.com/${"x".repeat(8192)}`, "http://127.0.0.1/private"]) await assert.rejects(client.fetch(url));
    await assert.rejects(client.fetch("https://internal.example/", { lookup: async () => [{ address: "127.0.0.1", family: 4 }] }));
    assert.equal(requests, 0);
  });

  await test("Fetch routes preserve raw responses, binaries, local files and specialized media", () => {
    assert.equal(shouldUseDeepSeekFetch(new URL(item.url), { provider: "deepseek" }), true);
    for (const url of ["file:///tmp/local.mp4", "https://example.com/paper.pdf", "https://example.com/photo.png", "https://example.com/video.mp4"]) assert.equal(shouldUseDeepSeekFetch(new URL(url), { provider: "deepseek" }), false);
    for (const options of [{ mode: "raw" as const }, { forceClone: true }, { timestamp: "1:00" }, { frames: 3 }]) assert.equal(shouldUseDeepSeekFetch(new URL(item.url), { provider: "deepseek", ...options }), false);
    assert.equal(shouldUseDeepSeekFetch(new URL(item.url), { provider: "auto" }), false);
    assert.deepEqual(normalizeFetchContentParams({ url: item.url, provider: "deepseek" }).options, { provider: "deepseek" });
    assert.throws(() => normalizeFetchContentParams({ url: item.url, mode: "raw", provider: "deepseek" }), /readable page text/);
    assert.throws(() => normalizeFetchContentParams({ url: item.url, provider: "typo" }), /provider must/);
  });

  const { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } = await import("../src/shared/builtin-capabilities");
  const { configureDeepSeekConnectionSource } = await import("../src/main/capabilities/providers/DeepSeekConnection");
  const builtinConfig = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  builtinConfig.connections = {
    "api-deepseek-a": { name: "DeepSeek A", protocol: "deepseek", presetId: "deepseek", baseUrl: connection.baseUrl, auth: "api-key", credentialRef: "fixture-ref-a", timeoutMs: 1000 },
    "api-deepseek-b": { name: "DeepSeek B", protocol: "deepseek", presetId: "deepseek", baseUrl: connection.baseUrl, auth: "api-key", credentialRef: "fixture-ref-b", timeoutMs: 1000 },
  };
  const resolvedRefs: string[] = [];
  let credentialAvailable = true;
  configureDeepSeekConnectionSource({ getConfig: () => builtinConfig, getCredential: ref => { resolvedRefs.push(ref); return credentialAvailable ? ref === "fixture-ref-a" ? secret : "fixture-second-key" : null; } });
  const config = { deepseekConnectionId: "api-deepseek-a", fetchProvider: "deepseek", workflow: "none", searchPolicy: { ...DEFAULT_SEARCH_POLICY, mode: "single", providers: ["deepseek"] } };
  const save = (patch: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify({ ...config, ...patch }));
  save();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let searchStatus = 200;
  const fixtureFetch: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://api.deepseek.com/v1/tools/search") return searchStatus === 200 ? json({ results: [item] }) : json({ error: { message: "fixture rate limit" } }, searchStatus);
    if (String(url) === "https://api.deepseek.com/v1/tools/fetch") return json({ title: "Fetched", content: item.content });
    if (String(url) === "https://google.serper.dev/search") return json({ organic: [{ title: "Fallback result", link: item.url, snippet: "Fallback excerpt" }] });
    if (String(url).startsWith("https://8.8.8.8/")) return new Response("exact raw response", { headers: { "Content-Type": "text/plain" } });
    throw new Error(`Unexpected fixture endpoint: ${String(url)}`);
  };
  globalThis.fetch = fixtureFetch;
  const { createWebAccessCapabilityExtension } = await import("../src/main/capabilities/web-access/index");
  const tools = new Map<string, any>(); const entries: any[] = [];
  createWebAccessCapabilityExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry: (_type: string, entry: unknown) => entries.push(entry) } as any);
  const context = { hasUI: false, model: { provider: "anthropic", id: "fixture-main-model" } };
  const searchTool = tools.get("web_search"), fetchTool = tools.get("fetch_content");

  await test("registered web_search dispatches DeepSeek independently of the main model", async () => {
    const before = requests.length;
    const response = await searchTool.execute("deepseek-native", { query: "measurement", originalQuestion: "What is measured?" }, undefined, undefined, context);
    assert(!response.isError); assert.equal(response.details.webSearch.runs[0].provider, "deepseek");
    assert.equal(response.details.webSearch.sources[0].snippet, item.snippet);
    assert.equal(response.details.webSearch.sources[0].summary, item.summary);
    assert.equal(response.details.webSearch.sources[0].evidence, "snippet");
    assert.equal(requests.length - before, 1);
    assert.equal(JSON.parse(String(requests.at(-1)!.init?.body)).ori_question, "What is measured?");
    assert.match(response.content[0].text, /Provider summary \(unverified, not page content\)/);
    assert(entries.some(entry => entry.queries?.[0].providerRuns?.[0].results?.[0].summary === item.summary));
  });

  await test("search includeContent consumes real inline content without an extra Fetch/model call", async () => {
    const before = requests.length;
    const response = await searchTool.execute("deepseek-content", { query: "measurement", includeContent: true }, undefined, undefined, context);
    assert(!response.isError); assert.equal(requests.length - before, 1);
    assert.equal(JSON.parse(String(requests.at(-1)!.init?.body)).need_content, true);
    assert(entries.some(entry => entry.urls?.some((page: any) => page.content === item.content)));
  });

  await test("saved connection changes affect existing tools and reuse credential references", async () => {
    save({ deepseekConnectionId: "api-deepseek-b" });
    await searchTool.execute("deepseek-rebind", { query: "measurement" }, undefined, undefined, context);
    assert.equal(new Headers(requests.at(-1)!.init?.headers).get("Authorization"), "Bearer fixture-second-key");
    assert.equal(resolvedRefs.at(-1), "fixture-ref-b");
    assert.equal(getDeepSeekWebSettings().deepseekConnectionId, "api-deepseek-b");
    const saved = readFileSync(configPath, "utf8");
    assert(!saved.includes(secret)); assert(!saved.includes("fixture-second-key")); assert(!saved.includes("apiKey"));
    save();
  });

  await test("existing fallback handles DeepSeek quota, while auth failure remains explicit", async () => {
    save({ serperApiKey: "fixture-serper", searchPolicy: { ...DEFAULT_SEARCH_POLICY, mode: "fallback", providers: ["deepseek", "serper"] } });
    searchStatus = 429;
    const fallback = await searchTool.execute("deepseek-fallback", { query: "measurement" }, undefined, undefined, context);
    assert.deepEqual(fallback.details.webSearch.runs.map((run: any) => [run.provider, run.status]), [["deepseek", "error"], ["serper", "success"]]);
    searchStatus = 401;
    const denied = await searchTool.execute("deepseek-denied", { query: "measurement" }, undefined, undefined, context);
    assert.equal(denied.details.webSearch.runs.length, 1); assert.equal(denied.isError, true);
    searchStatus = 200; save();
  });

  await test("a missing saved API Key and caller cancellation never activate fallback", async () => {
    save({ serperApiKey: "fixture-serper", searchPolicy: { ...DEFAULT_SEARCH_POLICY, mode: "fallback", providers: ["deepseek", "serper"] } });
    const before = requests.length;
    credentialAvailable = false;
    try {
      const missing = await searchTool.execute("missing-key", { query: "measurement" }, undefined, undefined, context);
      assert.equal(missing.isError, true); assert.equal(missing.details.webSearch.runs.length, 1);
      assert.match(missing.details.webSearch.runs[0].error, /API Key/); assert.equal(requests.length, before);
    } finally { credentialAvailable = true; }
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => started = resolve);
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init }); started();
      assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    };
    try {
      const work = searchTool.execute("cancel-no-fallback", { query: "measurement" }, controller.signal, undefined, context);
      await requestStarted; controller.abort();
      await assert.rejects(work, { name: "AbortError" });
      assert.equal(requests.length, before + 1);
    } finally { globalThis.fetch = fixtureFetch; save(); }
  });

  await test("registered fetch_content uses selected DeepSeek and preserves exact raw/auto paths", async () => {
    const pageUrl = "https://8.8.8.8/fixture";
    const response = await fetchTool.execute("deepseek-fetch", { url: pageUrl }, undefined, undefined, context);
    assert(!response.isError); assert.equal(response.content[0].text, item.content);
    assert.equal(response.details.provider, "deepseek"); assert.equal(response.details.source, "render");
    assert.deepEqual(JSON.parse(String(requests.at(-1)!.init?.body)), { url: pageUrl });
    const raw = await fetchTool.execute("raw-fetch", { url: pageUrl, mode: "raw" }, undefined, undefined, context);
    assert(!raw.isError); assert.equal(raw.content[0].text, "exact raw response"); assert.equal(requests.at(-1)!.url, pageUrl);
    const direct = await fetchTool.execute("direct-fetch", { url: pageUrl, provider: "auto" }, undefined, undefined, context);
    assert(!direct.isError); assert.equal(requests.at(-1)!.url, pageUrl);
    save({ fetchProvider: "auto" });
    await fetchTool.execute("deepseek-explicit", { url: pageUrl, provider: "deepseek" }, undefined, undefined, context);
    assert.equal(requests.at(-1)!.url, "https://api.deepseek.com/v1/tools/fetch"); save();
  });

  await test("already opened same-page browser content wins over configured DeepSeek Fetch", async () => {
    const { bindBrowserBridge } = await import("../src/main/browser/browser-bridge");
    const pageUrl = "https://8.8.8.8/account";
    bindBrowserBridge({ url: pageUrl, inspectionWebContents: { getURL: () => pageUrl, isDestroyed: () => false,
      executeJavaScript: async (script: string) => script === "document.title || ''" ? "Authenticated page" : "Existing signed-in page body" } } as any);
    const before = requests.length;
    const cancelled = await fetchTool.execute("browser-cancelled", { url: pageUrl }, AbortSignal.abort(), undefined, context);
    assert.equal(cancelled.isError, true); assert.equal(requests.length, before);
    const response = await fetchTool.execute("browser-first", { url: pageUrl }, undefined, undefined, context);
    assert.equal(requests.length, before); assert.equal(response.content[0].text, "Existing signed-in page body"); assert.equal(response.details.source, "browser");
    await fetchTool.execute("different-page", { url: "https://8.8.8.8/other" }, undefined, undefined, context);
    assert.equal(requests.length, before + 1); assert.equal(requests.at(-1)!.url, "https://api.deepseek.com/v1/tools/fetch");
  });

  await test("invalid/missing connection and blocked URLs never dispatch an API request", async () => {
    save({ deepseekConnectionId: "api-removed" });
    const before = requests.length;
    const missing = await searchTool.execute("missing-service", { query: "query", provider: "deepseek" }, undefined, undefined, context);
    assert.equal(missing.isError, true); assert.equal(missing.details.webSearch.runs[0].skippedReason, "unavailable");
    assert.equal(requests.length, before);
    save();
    const blocked = await fetchTool.execute("blocked-page", { url: "http://127.0.0.1/private" }, undefined, undefined, context);
    assert.equal(blocked.isError, true); assert.equal(blocked.details.errorCode, "url-policy"); assert.equal(requests.length, before);
    assert.deepEqual(normalizeSearchPolicy({ mode: "single", providers: ["deepseek"] }).providers, ["deepseek"]);
  });

  console.log(`DeepSeek Search & Fetch: ${passed} tests passed`);
} finally {
  globalThis.fetch = previousFetch;
  if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousProfile;
  rmSync(profile, { recursive: true, force: true });
}
