import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSearchPolicy, searchPolicyFromConfig, DEFAULT_SEARCH_POLICY } from "../src/shared/web-search";
import { canonicalSearchUrl, mergeSearchSources, runSearchBatch } from "../src/main/capabilities/web-access/search-aggregation";
import { buildResearchArtifact, validateEvidenceResponse, assessClaim } from "../src/main/capabilities/web-access/source-check";
import { buildWebSearchReport } from "../src/main/capabilities/web-access/search-report";

let count = 0;
async function test(name: string, action: () => unknown | Promise<unknown>) { await action(); count++; console.log(`PASS ${name}`); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const result = (url = "https://example.com/spec") => ({ answer: "unverified summary", results: [{ title: "Spec", url, snippet: "仪器精度为百分之一。" }] });

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
globalThis.fetch = (async (url: string | URL | Request) => {
  const value = String(url); requests.push(value); dispatch.push(Date.now());
  if (value.includes("api.tavily.com/search")) { if (scenario === "fallback") return new Response("fixture unavailable", { status: 503 }); await delay(40); return new Response(JSON.stringify({ answer: "Tavily original", results: [{ title: "Spec", url: "https://example.com/spec?utm_source=tavily", content: "规格原文摘要。" }] }), { status: 200 }); }
  if (value.includes("google.serper.dev/search")) { if (scenario === "partial") return new Response("fixture failure", { status: 500 }); await delay(15); return new Response(JSON.stringify({ organic: [{ title: "Spec", link: "https://example.com/spec?utm_source=serper", snippet: "另一家摘要。" }, { title: "Other", link: "https://another.example/spec", snippet: "独有发现。" }] }), { status: 200 }); }
  throw new Error("Unexpected network request in isolated fixture");
}) as typeof fetch;
try {
  const { createWebAccessCapabilityExtension } = await import("../src/main/capabilities/web-access/index");
  const registered = new Map<string, any>(); const entries: unknown[] = [];
  createWebAccessCapabilityExtension({ registerTool: (t: any) => registered.set(t.name, t), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry: (_: string, entry: unknown) => entries.push(entry) } as any);
  const tool = registered.get("web_search");
  await test("native tool honors parallel config, reports actual adapters and persists full per-provider details", async () => {
    const updates: any[] = [];
    const r = await tool.execute("native-test", { query: "仪器精度" }, undefined, (v: unknown) => updates.push(v), { hasUI: false });
    assert.equal(r.details.webSearch.runs.length, 2); assert.equal(r.details.webSearch.sources.length, 2);
    assert.equal(r.details.webSearch.sources[0].origins.length, 2);
    assert(dispatch[1] - dispatch[0] < 35, "real adapters dispatched concurrently");
    assert(updates.some(u => u.details?.webSearch?.runs.some((p: any) => p.status === "success") && u.details?.webSearch?.runs.some((p: any) => p.status === "running")));
    assert((entries as any[]).some(e => e.queries?.[0].providerRuns?.length === 2));
    assert.match(r.content[0].text, /Tavily original/);
    assert(!r.isError);
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
  await test("request multiplication is rejected before any network dispatch", async () => {
    writeFileSync(join(profile, "web-search.json"), JSON.stringify({ ...config, searchPolicy: { ...config.searchPolicy, maxRequests: 2 } }));
    const before = requests.length;
    await assert.rejects(() => tool.execute("budget-test", { queries: ["one", "two"] }, undefined, undefined, { hasUI: false }), /调用上限/);
    assert.equal(requests.length, before);
  });
} finally { globalThis.fetch = nativeFetch; }
await test("reports survive serialization without turning partial coverage into consensus", () => {
  const report = buildWebSearchReport("r", ["q"], [{ query: "q", answer: "", results: [], error: "failure", provider: "tavily" }]);
  assert.equal(JSON.parse(JSON.stringify(report)).status, "error");
});
console.log(`${count} multi-search tests passed`);
