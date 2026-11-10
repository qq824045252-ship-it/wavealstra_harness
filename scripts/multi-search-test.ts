import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSearchPolicy, searchPolicyFromConfig, DEFAULT_SEARCH_POLICY } from "../src/shared/web-search";
import { canonicalSearchUrl, mergeSearchSources, runSearchBatch, probeSearchAvailability } from "../src/main/capabilities/web-access/search-aggregation";
import { buildResearchArtifact, validateEvidenceResponse, assessClaim } from "../src/main/capabilities/web-access/source-check";
import { buildWebSearchReport, formatWebSearchReport } from "../src/main/capabilities/web-access/search-report";
import { mergeWebSearchReports } from "../src/renderer/src/lib/mergeWebSearchReports";
import type { ToolCall } from "../src/renderer/src/types";

let count = 0;
async function test(name: string, action: () => unknown | Promise<unknown>) { await action(); count++; console.log(`PASS ${name}`); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const result = (url = "https://example.com/spec") => ({ answer: "unverified summary", results: [{ title: "Spec", url, snippet: "仪器精度为百分之一。" }] });

await test("availability probes are concurrent, bounded and abortable", async () => {
  const started: string[] = [];
  const result = await probeSearchAvailability(["hung", "fast"], async p => { started.push(p); return p === "hung" ? new Promise(() => {}) : true; }, 20);
  assert.deepEqual(started, ["hung", "fast"]);
  assert.equal(result[0].error, "可用性检查超时"); assert.equal(result[1].available, true);
  const controller = new AbortController();
  const pending = probeSearchAvailability(["hung"], async () => new Promise(() => {}), 10000, controller.signal);
  controller.abort(); await assert.rejects(pending);
});

await test("16 search rounds merge without losing queries, origins, provider traces or conflicting evidence", () => {
  const calls: ToolCall[] = Array.from({ length: 16 }, (_, i) => {
    const query = `query-${i + 1}`;
    const runs = ["tavily", "serper"].map(provider => ({ query, provider, status: "success" as const, durationMs: 1, results: result().results, answer: "provider text" }));
    const sources = mergeSearchSources(runs);
    if (i === 0) sources[0] = { ...sources[0], evidence: "page", contentHash: "original" };
    return { id: String(i), tool: "web_search", summary: query, status: "success", webSearch: {
      version: 1, id: String(i), status: "complete", queries: [query], runs, sources,
      evidence: i < 2 ? [{ claim: "claim", status: i === 0 ? "supported" : "contradicted", rationale: "different versions", citations: [{ passageId: String(i), url: sources[0].url, quote: i === 0 ? "supports" : "contradicts", kind: "page", stance: i === 0 ? "support" : "contradict" }] }] : [],
    } };
  });
  const original = JSON.stringify(calls);
  const merged = mergeWebSearchReports(calls);
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.sources[0].origins!.length, 32);
  assert.equal(merged.sources[0].evidence, "page");
  assert.equal(merged.sources[0].contentHash, "original");
  assert.equal(merged.queries.length, 16);
  assert.equal(merged.runs.length, 32);
  assert.equal(merged.evidence!.length, 2);
  assert.equal(merged.status, "complete");
  assert.equal(JSON.stringify(calls), original, "display aggregation never rewrites stored reports");
  const last = calls.at(-1)!;
  last.status = "running"; last.webSearch!.status = "running"; last.webSearch!.runs[0].status = "running";
  assert.equal(mergeWebSearchReports(calls).status, "running");
  last.status = "error";
  const interrupted = mergeWebSearchReports(calls);
  assert.equal(interrupted.status, "partial");
  assert.equal(interrupted.runs.at(-2)!.status, "cancelled");
  assert.equal(interrupted.sources.length, 1);
});

await test("legacy ordered routing stays fallback; policy validation rejects underconfigured parallel and unknown providers", () => {
  assert.equal(searchPolicyFromConfig({ searchRouting: { providers: ["tavily", "serper"] } }).mode, "fallback");
  assert.equal(searchPolicyFromConfig({ searchProvider: ["tavily", "serper"] }).mode, "parallel");
  assert.throws(() => normalizeSearchPolicy({ mode: "parallel", providers: ["tavily"] }));
  assert.throws(() => normalizeSearchPolicy({ mode: "parallel", providers: ["tavily", "typo"] }));
});
await test("concurrent dispatch, incremental snapshots, isolated failure and late response after timeout", async () => {
  const starts: number[] = []; const updates: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const work = runSearchBatch("spec", ["fast", "failure", "slow"], { providerTimeoutMs: 50, totalTimeoutMs: 100, onUpdate: runs => updates.push(runs), run: async p => {
    starts.push(Date.now()); if (starts.length === 3) release(); await gate;
    if (p === "failure") throw Error("quota exhausted");
    if (p === "slow") await delay(120);
    return result();
  } });
  const { runs } = await work;
  assert.equal(starts.length, 3); assert(starts[2] - starts[0] < 30);
  assert.deepEqual(runs.map(r => r.status), ["success", "error", "timeout"]);
  const n = updates.length; await delay(150); assert.equal(updates.length, n, "late response cannot publish");
  assert.equal((updates[0] as any[])[0].status, "running", "snapshots must not mutate");
});
await test("abort terminates signal-ignoring providers and listeners do not produce late results", async () => {
  const controller = new AbortController();
  const work = runSearchBatch("query", ["a", "b"], { signal: controller.signal, providerTimeoutMs: 2000, totalTimeoutMs: 2000, run: async () => new Promise(() => {}) });
  controller.abort(); const { runs } = await work;
  assert(runs.every(r => r.status === "cancelled"));
});
await test("URL tracking dedup retains semantic parameters, fragments and all provider origins", async () => {
  const { runs } = await runSearchBatch("query", ["a", "b"], { providerTimeoutMs: 100, totalTimeoutMs: 100, run: async p => result(`https://example.com/spec?v=2&utm_source=${p}`) });
  const merged = mergeSearchSources(runs); assert.equal(merged.length, 1); assert.equal(merged[0].origins!.length, 2);
  assert.notEqual(canonicalSearchUrl("https://a.com/p?v=1"), canonicalSearchUrl("https://a.com/p?v=2"));
  assert.notEqual(canonicalSearchUrl("https://a.com/p#a"), canonicalSearchUrl("https://a.com/p#b"));
});
const artifact = buildResearchArtifact({ query: "仪器精度为百分之一。", results: [
  { title: "规格", url: "https://example.com/spec", snippet: "仪器精度为百分之一。" },
  { title: "修订", url: "https://another.example/spec", snippet: "新版仪器精度不是百分之一，而是百分之二。" },
  { title: "转载", url: "https://mirror.example/spec", snippet: "仪器精度为百分之一。" },
], fetched: [
  { url: "https://example.com/spec", title: "规格", content: "仪器精度为百分之一。此规格适用于旧版仪器。", error: null },
  { url: "https://another.example/spec", title: "修订", content: "新版仪器精度不是百分之一，而是百分之二。", error: null },
  { url: "https://mirror.example/spec", title: "转载", content: "仪器精度为百分之一。此规格适用于旧版仪器。", error: null },
] });
await test("Chinese original passages preserve offsets; exact duplicate pages do not become independent evidence", () => {
  assert(artifact.passages.some(p => p.kind === "page" && p.text.includes("仪器精度")));
  assert.equal(artifact.sources[2].duplicate_of, "https://example.com/spec");
  assert(!artifact.passages.some(p => p.source_rank === 3));
  assert.equal(assessClaim("仪器精度为百分之一。", artifact.passages).status, "unclear", "extraction must not fabricate truth from keywords");
});
await test("semantic evidence must quote actual passages, retain conflicts, and cannot elevate snippets to proof", () => {
  const support = artifact.passages.find(p => p.kind === "page" && p.source_rank === 1)!;
  const contra = artifact.passages.find(p => p.kind === "page" && p.source_rank === 2)!;
  const item = { claim: artifact.query, rationale: "版本不同，不能一概而论", citations: [{ passageId: support.passage_id, quote: support.text, stance: "support" }, { passageId: contra.passage_id, quote: contra.text, stance: "contradict" }] };
  assert.equal(validateEvidenceResponse({ claims: [item] }, artifact)[0].status, "unclear");
  assert.throws(() => validateEvidenceResponse({ claims: [{ ...item, citations: [{ passageId: support.passage_id, quote: "伪造的引用内容", stance: "support" }] }] }, artifact));
  const snippet = artifact.passages.find(p => p.kind === "snippet")!;
  assert.equal(validateEvidenceResponse({ claims: [{ ...item, citations: [{ passageId: snippet.passage_id, quote: snippet.text, stance: "support" }] }] }, artifact)[0].status, "unclear");
});

// Actual built-in tool + adapters. Network endpoints are fixture responses; credentials and files are isolated.
const profile = mkdtempSync(join(tmpdir(), "mybuddy-multi-search-"));
process.env.PI_CODING_AGENT_DIR = profile;
const config = { tavilyApiKey: "fixture-tavily", serperApiKey: "fixture-serper", workflow: "none", searchPolicy: { ...DEFAULT_SEARCH_POLICY, mode: "parallel", providers: ["tavily", "serper"], verifySources: false } };
writeFileSync(join(profile, "web-search.json"), JSON.stringify(config));
const nativeFetch = globalThis.fetch;
let scenario = "ok"; const requests: string[] = []; const dispatch: number[] = [];
// 「并发派发」用因果判定，不用绝对时间差：只要第二个请求在第一个响应返回**之前**发出，
// 就证明是并发而不是串行（fallback 模式会等第一个结束后才发第二个）。CI 上 4 vCPU 争用
// 时，即使两次派发在同一事件循环批里，Date.now() 差也可能 >35ms，旧断言会假红。
let tavilySettledAt = 0;
globalThis.fetch = (async (url: string | URL | Request) => {
  const value = String(url); requests.push(value); dispatch.push(Date.now());
  if (value.includes("api.tavily.com/search")) { if (scenario === "fallback") return new Response("fixture unavailable", { status: 503 }); await delay(200); tavilySettledAt = Date.now(); return new Response(JSON.stringify({ answer: "Tavily original", results: [{ title: "Spec", url: "https://example.com/spec?utm_source=tavily", content: "规格原文摘要。" }] }), { status: 200 }); }
  if (value.includes("google.serper.dev/search")) { if (scenario === "partial") return new Response("fixture failure", { status: 500 }); await delay(15); return new Response(JSON.stringify({ organic: [{ title: "Spec", link: "https://example.com/spec?utm_source=serper", snippet: "另一家摘要。" }, { title: "Other", link: "https://another.example/spec", snippet: "独有发现。" }] }), { status: 200 }); }
  throw new Error("Unexpected network request in isolated fixture");
}) as typeof fetch;
const fixtureFetch = globalThis.fetch;
try {
  const { createWebAccessCapabilityExtension } = await import("../src/main/capabilities/web-access/index");
  const registered = new Map<string, any>(); const entries: unknown[] = [];
  createWebAccessCapabilityExtension({ registerTool: (t: any) => registered.set(t.name, t), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry: (_: string, entry: unknown) => entries.push(entry) } as any);
  const tool = registered.get("web_search");
  await test("Exa keeps evidence attached to each original URL across MCP text, JSON and API citations", async () => {
    const { searchWithExa } = await import("../src/main/capabilities/web-access/exa");
    const oldKey = process.env.EXA_API_KEY; delete process.env.EXA_API_KEY;
    try {
      for (const format of ["mcp-text", "mcp-json", "mcp-blocks", "mcp-json-blocks", "mcp-mixed", "api-citations", "api-highlights"]) {
        if (format.startsWith("api")) process.env.EXA_API_KEY="fixture-exa"; else delete process.env.EXA_API_KEY;
        writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, ...(format.startsWith("api") ? { exaApiKey: "fixture-exa" } : {}) }));
        const items = [{ title: "Rotation", url: "https://science.nasa.gov/rotation", text: "Sidereal rotation period: 24.6229 hours." },
          { title: "Solar day", url: "https://science.nasa.gov/solar", text: "Length of day: 24.6597 hours." }];
        let calls = 0;
        globalThis.fetch = (async () => {
          calls++;
          if (format === "api-citations") return new Response(JSON.stringify({ answer: "mixed provider summary", citations: [...items,{title:"No excerpt",url:"https://science.nasa.gov/empty"}] }));
          if (format === "api-highlights") return new Response(JSON.stringify({ results: items.map(x => ({...x, highlights: [x.text], text: "less useful full text"})) }));
          const text = format === "mcp-json" ? JSON.stringify({results:items}) : items.map(x=>`Title: ${x.title}\nURL: ${x.url}\nText: ${x.text}`).join("\n\n");
          return new Response(JSON.stringify({result:{content:format === "mcp-mixed" ? [{type:"text",text:JSON.stringify({results:[items[0]]})},{type:"text",text:`Title: ${items[1].title}\nURL: ${items[1].url}\nText: ${items[1].text}`}] : format === "mcp-json-blocks" ? items.map(x=>({type:"text",text:JSON.stringify({results:[x]})})) : format === "mcp-blocks" ? items.map(x=>({type:"text",text:`Title: ${x.title}\nURL: ${x.url}\nText: ${x.text}`})) : [{type:"text",text}]}}));
        }) as typeof fetch;
        const result = await searchWithExa("day length", format === "api-highlights" ? {numResults:2} : {});
        assert.equal(calls, 1, "preserving evidence adds no network or model call");
        assert.equal(result!.results[0].snippet, items[0].text, format);
        assert.equal(result!.results[1].snippet, items[1].text, format);
        if (format === "api-citations") assert.equal(result!.results[2].snippet, "", "citation without text cannot borrow the provider summary");
        const report = buildWebSearchReport("source-map", ["day length"], [{query:"day length",answer:result!.answer,results:result!.results,error:null,provider:"exa"}]);
        assert.equal(report.sources[0].url, items[0].url);
        assert(!report.sources[0].snippet.includes("24.6597"));
      }
    } finally {
      if (oldKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = oldKey;
      globalThis.fetch = fixtureFetch; writeFileSync(join(profile,"web-search.json"), JSON.stringify(config));
    }
  });
  await test("native tool honors parallel config, reports actual adapters and persists full per-provider details", async () => {
    const updates: any[] = [];
    const r = await tool.execute("native-test", { query: "仪器精度" }, undefined, (v: unknown) => updates.push(v), { hasUI: false });
    assert.equal(r.details.webSearch.runs.length, 2); assert.equal(r.details.webSearch.sources.length, 2);
    assert.equal(r.details.webSearch.sources[0].origins.length, 2);
    assert(dispatch.length >= 2 && tavilySettledAt > 0 && dispatch[1] < tavilySettledAt, "real adapters dispatched concurrently（第二个请求在第一个响应返回前发出）");
    assert(updates.some(u => u.details?.webSearch?.runs.some((p: any) => p.status === "success") && u.details?.webSearch?.runs.some((p: any) => p.status === "running")));
    assert((entries as any[]).some(e => e.queries?.[0].providerRuns?.length === 2));
    assert.match(r.content[0].text, /Tavily original/);
    assert(!r.isError);
  });
  await test("fallback skips an unavailable primary without consuming the next query's slot", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config,
      searchPolicy: { ...config.searchPolicy, mode: "fallback", providers: ["codex", "tavily"], maxRequests: 2 } }));
    const before = requests.length;
    const r = await tool.execute("unavailable-fallback", { queries: ["one", "two"] }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length - before, 2);
    assert.deepEqual(r.details.webSearch.runs.map((x: any) => [x.query, x.provider, x.status]), [
      ["one", "codex", "error"], ["one", "tavily", "success"],
      ["two", "codex", "error"], ["two", "tavily", "success"]]);
    assert.equal(r.details.webSearch.status, "partial");
  });
  await test("explicit unavailable provider never switches to configured fallback", async () => {
    const before = requests.length;
    const r = await tool.execute("explicit-unavailable", { query: "one", provider: "codex" }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length, before);
    assert.equal(r.details.webSearch.runs.length, 1);
    assert.equal(r.details.webSearch.runs[0].skippedReason, "unavailable");
  });
  await test("all unavailable fallback candidates end visibly without network requests", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ workflow: "none",
      searchPolicy: { ...config.searchPolicy, mode: "fallback", providers: ["codex", "openai"] } }));
    const before = requests.length;
    const r = await tool.execute("all-unavailable", { query: "one" }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length, before);
    assert.equal(r.details.webSearch.runs.length, 2);
    assert(r.details.webSearch.runs.every((x: any) => x.skippedReason === "unavailable"));
    assert.equal(r.details.webSearch.status, "error");
  });
  await test("provider authentication denial is not mistaken for local unavailability", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, tavilyApiKey: "fixture-auth-denied", searchPolicy: { ...config.searchPolicy, mode: "fallback" } }));
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url)); return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    const before = requests.length;
    try {
      const r = await tool.execute("auth-denied", { query: "one" }, undefined, undefined, { hasUI: false });
      assert.equal(requests.length - before, 1);
      assert.deepEqual(r.details.webSearch.runs.map((x: any) => x.provider), ["tavily"]);
      assert.equal(r.details.webSearch.runs[0].skippedReason, undefined);
    } finally { globalThis.fetch = fixtureFetch; }
  });
  await test("saved routing changes affect an already registered tool and fallback retains both attempts", async () => {
    scenario = "fallback";
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, mode: "fallback" } }));
    const r = await tool.execute("fallback-test", { query: "fallback" }, undefined, undefined, { hasUI: false });
    assert.deepEqual(r.details.webSearch.runs.map((r: any) => r.status), ["error", "success"]);
    assert.deepEqual(r.details.webSearch.runs.map((r: any) => r.provider), ["tavily", "serper"]);
    scenario = "ok"; writeFileSync(join(profile, "web-search.json"), JSON.stringify(config));
  });
  await test("cancelling the native tool returns a persistable cancelled report and never claims verification", async () => {
    const controller = new AbortController();
    const call = tool.execute("abort-native", { query: "cancel" }, controller.signal, undefined, { hasUI: false });
    setTimeout(() => controller.abort(), 5);
    const r = await call; assert.equal(r.isError, true); assert.equal(r.details.webSearch.status, "cancelled");
    assert(r.details.webSearch.runs.every((run: any) => run.status === "cancelled"));
  });
  await test("source_check without fetched originals is explicitly insufficient, including Chinese claims", async () => {
    const r = await registered.get("source_check").execute("claim-test", { claim: "仪器精度为百分之一。", fetchContent: false }, undefined, undefined, { hasUI: false });
    assert.equal(r.details.webSearch.evidence[0].status, "missing-evidence");
    assert.equal(r.details.webSearch.runs.length, 2);
    assert(!r.content[0].text.includes("confidence"));
  });
  await test("partial provider outage returns honest partial status and all-provider failure is an error", async () => {
    scenario = "partial"; const r = await tool.execute("partial-test", { query: "fixture" }, undefined, undefined, { hasUI: false });
    assert.equal(r.details.webSearch.status, "partial"); assert.equal(r.details.webSearch.runs[1].status, "error");
    globalThis.fetch = (async () => new Response("fixture outage", { status: 500 })) as typeof fetch;
    const failed = await tool.execute("failed-test", { query: "fixture" }, undefined, undefined, { hasUI: false });
    assert.equal(failed.isError, true); assert.equal(failed.details.webSearch.status, "error");
  });
  await test("multi-query budget distributes work instead of rejecting all queries", async () => {
    globalThis.fetch = fixtureFetch; scenario = "ok";
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, maxRequests: 2 } }));
    const before = requests.length;
    const r = await tool.execute("budget-test", { queries: ["one", "two"] }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length - before, 2);
    assert.deepEqual(r.details.webSearch.runs.filter((x: any) => x.status === "success").map((x: any) => x.query), ["one", "two"]);
    assert.equal(r.details.webSearch.status, "partial");
    assert.equal(r.details.webSearch.runs.filter((x: any) => /覆盖已缩减/.test(x.error ?? "")).length, 2);
  });
  await test("failed fallback candidates cannot consume the next query's reserved slots", async () => {
    globalThis.fetch = fixtureFetch; scenario = "fallback";
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, mode: "fallback", maxRequests: 2 } }));
    const before = requests.length;
    const r = await tool.execute("fallback-budget", { queries: ["one", "two"] }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length - before, 2);
    assert.deepEqual(r.details.webSearch.runs.map((x: any) => x.query), ["one", "two"]);
    assert(r.details.webSearch.runs.every((x: any) => x.provider === "tavily"));
    scenario = "ok";
  });
  await test("default quick mode never fetches pages or calls a judge even when policy enables verification", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, verifySources: true } }));
    const before = requests.length;
    const r = await tool.execute("quick", { query: "quick" }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length - before, 2, "only provider requests, no hidden page fetches");
    assert.equal(r.details.webSearch.evidence, undefined);
    assert.match(r.details.webSearch.notice, /未进行原文语义核验/);
    assert(r.details.webSearch.sources.every((s: any) => s.evidence === "snippet"));
  });
  await test("unavailable Codex is visible but does not consume a request slot or prevent other queries", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, providers: ["codex", "tavily"], maxRequests: 2 } }));
    const before = requests.length;
    const r = await tool.execute("unavailable", { queries: ["one", "two"] }, undefined, undefined, { hasUI: false });
    assert.equal(requests.length - before, 2);
    assert((entries.at(-1) as any).queries.every((q: any) => q.provider === "tavily"), "actual responder identity must not be the skipped Codex entry");
    assert.equal(r.details.webSearch.runs.filter((x: any) => x.provider === "tavily" && x.status === "success").length, 2);
    assert(r.details.webSearch.runs.filter((x: any) => x.provider === "codex").every((x: any) => /未发起请求/.test(x.error)));
  });
  await test("explicit verification with no page content reports missing evidence rather than inventing a conclusion", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, verifySources: true } }));
    const r = await tool.execute("verify", { query: "verify", evidenceMode: "verify" }, undefined, undefined, { hasUI: false });
    assert.equal(r.details.webSearch.evidence[0].status, "missing-evidence");
    assert.equal(r.details.webSearch.evidence[0].citations.length, 0);
  });
} finally { globalThis.fetch = nativeFetch; }
await test("source excerpts survive provider answer truncation without borrowing evidence", () => {
  const results = Array.from({length:4},(_,i)=>({title:`Source ${i}`,url:`https://example.com/source-${i}`,snippet:`Quantity ${i}: ${i+10} seconds for population ${i}.`}));
  results.push({title:"No passage",url:"https://example.com/empty",snippet:""});
  const report=buildWebSearchReport("long",["quantity"],[{query:"quantity",answer:"provider summary ".repeat(200),results,error:null,provider:"exa"}]);
  const output=formatWebSearchReport(report);
  for(const item of results.slice(0,4)) assert(output.includes(`${item.url}\nFound by: exa rank`) && output.includes(item.snippet));
  assert.equal(report.sources.at(-1)!.snippet, "", "missing evidence stays missing");
  assert(output.includes("Provider answer preview truncated"));
});
await test("reports survive serialization without turning partial coverage into consensus", () => {
  const report = buildWebSearchReport("r", ["q"], [{ query: "q", answer: "", results: [], error: "failure", provider: "tavily" }]);
  assert.equal(JSON.parse(JSON.stringify(report)).status, "error");
});
console.log(`${count} multi-search tests passed`);
