import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserBenchmarkCache } from "./browser-benchmark-cache.mjs";

const cases = [
  ["chat-positive", { prompt_tokens_details: { cached_tokens: 80 } }, 80],
  ["chat-zero", { prompt_tokens_details: { cached_tokens: 0 } }, 0],
  ["flat-positive", { cache_read_input_tokens: 80 }, 80],
  ["flat-zero", { cache_read_input_tokens: 0 }, 0],
  ["responses-details", { input_tokens_details: { cached_tokens: 80 } }, 80],
  ["responses-zero", { input_tokens_details: { cached_tokens: 0 } }, 0],
  ["missing", {}, null], ["null", null, null],
  ["null-fallback", { prompt_tokens_details: { cached_tokens: null }, cache_read_input_tokens: 80 }, 80],
  ["zero-priority", { prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 80 }, 0],
  ["invalid-primary-not-hidden", { prompt_tokens_details: { cached_tokens: -1 }, cache_read_input_tokens: 80 }, null],
  ...[-1, 0.5, "80", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value, i) => [`invalid-${i}`, { cache_read_input_tokens: value }, null]),
];
for (const [name, usage, count] of cases) {
  assert.deepEqual(browserBenchmarkCache(usage), { cacheReadTokens: count,
    cacheState: count === null ? "unknown" : count === 0 ? "zero-cache-read-reported" : "cache-read-reported" }, name);
}
// Exercise the real report CLI, including request rows and cache grouping.
const root = mkdtempSync(join(tmpdir(), "browser-cache-report-"));
const out = join(root, "case"); mkdirSync(out);
const usages = [
  { prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 80 },
  { prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 0 },
  { prompt_tokens: 100, completion_tokens: 1 },
];
writeFileSync(join(root, "manifest.json"), JSON.stringify({ baseline: "synthetic-test", runs: [
  { model: "fixture", variant: "candidate", round: 0, case: "short", out, exitCode: 0 },
] }));
writeFileSync(join(out, "results.json"), JSON.stringify({ calls: usages.map((usage, i) => ({ case: "short", ordinal: i + 1, elapsedMs: 1, usage })),
  cases: [{ id: "short", status: "passed", wallMs: 3, modelRequests: 3, runtimeCalls: 0 }] }));
execFileSync(process.execPath, [fileURLToPath(new URL("./browser-benchmark-report.mjs", import.meta.url)), root]);
const result = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
assert.deepEqual(result.requests.map(call => call.cacheState), ["cache-read-reported", "zero-cache-read-reported", "unknown"]);
assert.equal(result.cacheGroups.find(group => group.cacheState === "cache-read-reported").cacheReadTokens, 80);
assert.equal(result.cacheGroups.find(group => group.cacheState === "zero-cache-read-reported").cacheReadTokens, 0);
assert.equal(result.cacheGroups.find(group => group.cacheState === "unknown").cacheReadTokens, null);
assert.equal(result.groups[0].cacheReadTokens, null, "incomplete usage must not become a known total");
assert.equal(result.groups[0].costUsd, null, "missing billing evidence stays unknown");
console.log(`browser benchmark cache report: PASS (${cases.length} normalization cases + real report grouping)`);
