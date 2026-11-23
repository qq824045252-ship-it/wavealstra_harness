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
const run = { model: "fixture", variant: "candidate", round: 0, case: "short", out, exitCode: 0, state: "finished" };
const runs = [run];
const payload = { modelId: run.model, variant: run.variant };
writeFileSync(join(out, "results.json"), JSON.stringify({ ...payload, status: "passed",
  calls: usages.map((usage, i) => ({ case: "short", ordinal: i + 1, elapsedMs: 1, usage })),
  cases: [{ id: "short", status: "passed", wallMs: 3, modelRequests: 3, runtimeCalls: 0 }] }));
function attempt(id, expectedStatus, result, overrides = {}) {
  const out = join(root, id);
  if (result) {
    mkdirSync(out);
    writeFileSync(join(out, "results.json"), JSON.stringify(result));
  }
  runs.push({ ...run, case: id, out, ...overrides });
  return expectedStatus;
}
const expected = [
  "passed",
  attempt("screenshot", "failed", { at: "timestamp", status: "passed", results: [{ width: 640 }] }, { exitCode: 1 }),
  attempt("long", "failed", { ...payload, status: "failed", cases: [{ id: "long", status: "passed" }] }),
  attempt("form", "invalid-report", { ...payload, status: "passed", cases: [{ id: "popup", status: "passed" }] }),
  attempt("async", "passed", { ...payload, status: "passed", cases: [{ id: "async", status: "passed", modelRequests: 2 }], calls: [] }),
  attempt("table", "planned", undefined, { state: "planned", exitCode: undefined }),
  attempt("non-browser", "missing-report"),
  attempt("partial", "invalid-report", { ...payload, modelId: "other", status: "passed", cases: [{ id: "partial", status: "passed" }] }),
  attempt("screenshot-second", "passed", { at: "timestamp", results: [{ width: 640 }] }, { case: "screenshot", round: 1 }),
];
writeFileSync(join(root, "manifest.json"), JSON.stringify({ baseline: "synthetic-test", runs }));
execFileSync(process.execPath, [fileURLToPath(new URL("./browser-benchmark-report.mjs", import.meta.url)), root]);
const result = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
assert.deepEqual(result.requests.map(call => call.cacheState), ["cache-read-reported", "zero-cache-read-reported", "unknown"]);
assert.equal(result.cacheGroups.find(group => group.cacheState === "cache-read-reported").cacheReadTokens, 80);
assert.equal(result.cacheGroups.find(group => group.cacheState === "zero-cache-read-reported").cacheReadTokens, 0);
assert.equal(result.cacheGroups.find(group => group.cacheState === "unknown").cacheReadTokens, null);
assert.equal(result.groups[0].cacheReadTokens, null, "incomplete usage must not become a known total");
assert.equal(result.groups[0].costUsd, null, "missing billing evidence stays unknown");
assert.deepEqual(result.rows.map(row => row.status), expected);
assert.deepEqual(result.rows.map(row => row.case), runs.map(run => run.case));
assert.equal(result.groups[0].passed, 3);
assert.equal(result.groups[0].attempted, 8);
assert.equal(result.groups[0].scheduled, 9);
assert.equal(result.rows.find(row => row.case === "async").inputTokens, null);
assert.match(readFileSync(join(root, "summary.md"), "utf8"), /\| fixture \| candidate \| 3\/9 \| 1 \|/);
console.log(`browser benchmark cache report: PASS (${cases.length} normalization cases + real report grouping)`);
