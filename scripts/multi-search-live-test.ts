/** Opt-in real requests; isolated key-pool state. Never logs credentials or copies the live database. */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEARCH_POLICY } from "../src/shared/web-search";
const live = JSON.parse(readFileSync(join(homedir(), ".mybuddy/web-search.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "mybuddy-search-live-"));
const configPath = join(dir, "web-search.json");
process.env.PI_CODING_AGENT_DIR = dir;
const providers = ["tavily", "serper"];
writeFileSync(configPath, JSON.stringify({ tavilyApiKey: live.tavilyApiKey, serperApiKey: live.serperApiKey, apiKeyPools: Object.fromEntries(providers.filter(p => live.apiKeyPools?.[p]).map(p => [p, live.apiKeyPools[p]])), searchPolicy: { ...DEFAULT_SEARCH_POLICY, mode: "parallel", providers, verifySources: false } }));
try {
  const { search } = await import("../src/main/capabilities/web-access/gemini-search");
  const result = await search("Node.js fs readFile official documentation", { numResults: 5 });
  const report = { timestamp: new Date().toISOString(), providers: result.providerRuns?.map(r => ({ provider: r.provider, status: r.status, durationMs: r.durationMs, resultCount: r.results.length, error: r.error })), uniqueSources: result.results.length, overlappingSources: result.results.filter(r => (r.origins?.length ?? 0) > 1).length };
  mkdirSync("out/tests/multi-search", { recursive: true });
  writeFileSync("out/tests/multi-search/live-results.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (result.providerRuns?.some(r => r.status !== "success")) process.exitCode = 1;
} finally { unlinkSync(configPath); }
