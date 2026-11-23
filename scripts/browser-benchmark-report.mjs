import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { browserBenchmarkCache } from "./browser-benchmark-cache.mjs";
import { readBenchmarkAttempt } from "./browser-benchmark-attempt.mjs";

const directory = resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const rows = [], requests = [];
for (const run of manifest.runs) {
  const { result, test, status, error } = readBenchmarkAttempt(run);
  const attemptRequests = [];
  for (const call of result?.calls ?? []) {
    const usage = call.usage;
    attemptRequests.push({ model: run.model, variant: run.variant, round: run.round, case: call.case, ordinal: call.ordinal,
      elapsedMs: call.elapsedMs ?? null, httpStatus: call.httpStatus ?? null, error: call.error ?? null,
      transportState: call.error ? "failed" : call.elapsedMs === undefined ? "open-at-process-exit" : "completed",
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
      ...browserBenchmarkCache(usage),
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? null, costUsd: typeof usage?.cost === "number" ? usage.cost : null,
      toolDefinitionChars: call.toolDefinitionChars ?? null, maxTokens: call.maxTokens ?? null,
      requestedModel: call.requestedModel ?? null, returnedModels: call.returnedModels ?? [], reasoning: call.reasoning ?? null });
  }
  requests.push(...attemptRequests);
  const attempt = { model: run.model, variant: run.variant, round: run.round, case: run.case, status,
    processExitCode: run.exitCode ?? null, error: error ?? null, processWallMs: run.processWallMs ?? null, evidence: run.out };
  if (!test) {
    rows.push({ ...attempt, wallMs: null });
    continue;
  }
  const tools = (test.history?.messages ?? []).flatMap(message => message.tools ?? []);
  const browser = tools.filter(tool => tool.tool === "browser_exec");
  const code = tools.filter(tool => tool.tool === "codemode");
  const calls = attemptRequests.filter(call => call.case === test.id);
  const completeTelemetry = Number.isSafeInteger(test.modelRequests) && test.modelRequests === calls.length;
  const browserCalls = result.browserCalls?.filter(call => call.case === test.id);
  let duplicateReads = browserCalls ? 0 : null, previousRead;
  for (const call of browserCalls ?? []) {
    if (["navigate", "click", "fill", "press"].includes(call.input.action)) previousRead = undefined;
    if (call.input.action === "read" && call.result) {
      const key = JSON.stringify({ url: call.result.url, selector: call.input.selector, mode: call.input.mode, textOffset: call.result.textOffset ?? 0, text: call.result.text, elements: call.result.elements });
      if (key === previousRead) duplicateReads++;
      previousRead = key;
    }
  }
  const knownTotal = field => completeTelemetry && calls.every(call => Number.isSafeInteger(call[field])) ? calls.reduce((n, call) => n + call[field], 0) : null;
  rows.push({ ...attempt, caseStatus: test.status ?? "incomplete",
    wallMs: test.wallMs ?? null, modelRequests: test.modelRequests ?? null, browserCalls: test.browserCalls ?? (test.id === "bot-work" ? null : browser.length),
    codemodeCalls: code.length, nestedCalls: tools.filter(tool => tool.parentToolCallId).length,
    completedBrowserCalls: browser.filter(tool => tool.status === "success").length, failedBrowserCalls: browser.filter(tool => tool.status !== "success").length,
    runtimeCalls: test.runtimeCalls ?? null, inputTokens: knownTotal("inputTokens"), outputTokens: knownTotal("outputTokens"), cacheReadTokens: knownTotal("cacheReadTokens"),
    cacheWriteTokens: knownTotal("cacheWriteTokens"), costUsd: completeTelemetry && calls.every(call => Number.isFinite(call.costUsd)) ? calls.reduce((n, call) => n + call.costUsd, 0) : null,
    browserTrace: browser.map(tool => ({ id: tool.id, parent: tool.parentToolCallId, args: tool.summary, status: tool.status })),
    invalidRereads: duplicateReads, invalidRereadsNote: "strict duplicate returned text/targets/scope/offset without intervening input or navigation; a lower bound, not a relevance judgment about changing decorations" });
}
const groups = [];
for (const model of new Set(rows.map(row => row.model))) for (const variant of new Set(rows.map(row => row.variant))) {
  const cases = rows.filter(row => row.model === model && row.variant === variant);
  if (!cases.length) continue;
  const total = field => cases.every(row => Number.isFinite(row[field])) ? cases.reduce((n, row) => n + row[field], 0) : null;
  const input = total("inputTokens"), cached = total("cacheReadTokens");
  const planned = cases.filter(row => row.status === "planned").length;
  const running = cases.filter(row => row.status === "running").length;
  groups.push({ model, variant, passed: cases.filter(row => row.status === "passed").length, attempted: cases.length - planned,
    planned, running, scheduled: cases.length,
    wallMsAllAttempts: total("wallMs"), modelRequests: total("modelRequests"), runtimeCalls: total("runtimeCalls"), inputTokens: input, outputTokens: total("outputTokens"), cacheReadTokens: cached,
    cacheReadRatio: input && cached !== null ? cached / input : null, cacheRatioDenominator: "sum of provider prompt_tokens, including reported cached prompt tokens; all attempts with complete usage only",
    costUsd: total("costUsd") });
}
const cacheGroups = [];
for (const model of new Set(requests.map(call => call.model))) for (const variant of new Set(requests.map(call => call.variant))) {
  for (const cacheState of ["zero-cache-read-reported", "cache-read-reported", "unknown"]) {
    const calls = requests.filter(call => call.model === model && call.variant === variant && call.cacheState === cacheState);
    if (!calls.length) continue;
    const sum = field => calls.every(call => Number.isFinite(call[field])) ? calls.reduce((n, call) => n + call[field], 0) : null;
    cacheGroups.push({ model, variant, cacheState, requests: calls.length, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), costUsd: sum("costUsd") });
  }
}
const summary = { baseline: manifest.baseline, level: "production host/Durable/Electron with synthetic pages; no full UI send-to-render timing or public-site success claim", sampleWarning: "Descriptive observations. Keep all failures. No speedup/significance claim from one repeat or unknown load/pricing.",
  staticOverhead: requests.filter(call => call.case === "non-browser").map(call => ({ model: call.model, variant: call.variant, round: call.round, inputTokens: call.inputTokens, toolDefinitionChars: call.toolDefinitionChars, cacheReadTokens: call.cacheReadTokens })), groups, cacheGroups, rows, requests };
writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
const tokens = value => value === null ? "unknown" : `${(value / 1e6).toFixed(3)}M (${value})`;
const table = ["| Model | Variant | Passed / scheduled | Pending | Wall ms, all attempts | Model requests | Input tokens | Output tokens | Cache read tokens | Cost USD |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...groups.map(row => `| ${row.model} | ${row.variant} | ${row.passed}/${row.scheduled} | ${row.planned + row.running} | ${row.wallMsAllAttempts ?? "unknown"} | ${row.modelRequests ?? "unknown"} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${tokens(row.cacheReadTokens)} | ${row.costUsd ?? "unknown"} |`)];
const cacheTable = ["| Model | Variant | Provider cache state | Requests | Input tokens | Cache read tokens |", "| --- | --- | --- | ---: | ---: | ---: |", ...cacheGroups.map(row => `| ${row.model} | ${row.variant} | ${row.cacheState} | ${row.requests} | ${tokens(row.inputTokens)} | ${tokens(row.cacheReadTokens)} |`)];
writeFileSync(join(directory, "summary.md"), table.join("\n") + "\n\n" + cacheTable.join("\n") + "\n\nProvider cache state is observed, not proof of a cold provider cache.\n\n" + summary.sampleWarning + "\n");
console.log(JSON.stringify(groups, null, 2));
