import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const directory = resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const rows = [], requests = [];
for (const run of manifest.runs) {
  let result; try { result = JSON.parse(readFileSync(join(run.out, "results.json"), "utf8")); } catch { rows.push({ ...run, status: "missing-report" }); continue; }
  for (const call of result.calls ?? []) {
    const usage = call.usage;
    requests.push({ model: run.model, variant: run.variant, round: run.round, case: call.case, ordinal: call.ordinal,
      elapsedMs: call.elapsedMs ?? null, httpStatus: call.httpStatus ?? null, error: call.error ?? null,
      transportState: call.error ? "failed" : call.elapsedMs === undefined ? "open-at-process-exit" : "completed",
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
      cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? null, costUsd: typeof usage?.cost === "number" ? usage.cost : null,
      cacheState: typeof usage?.prompt_tokens_details?.cached_tokens === "number" ? usage.prompt_tokens_details.cached_tokens > 0 ? "cache-read-reported" : "zero-cache-read-reported" : "unknown",
      toolDefinitionChars: call.toolDefinitionChars ?? null, maxTokens: call.maxTokens ?? null,
      requestedModel: call.requestedModel ?? null, returnedModels: call.returnedModels ?? [], reasoning: call.reasoning ?? null });
  }
  if (!result.cases?.length) rows.push({ model: run.model, variant: run.variant, round: run.round, case: run.case,
    status: result.status ?? "missing-report", error: result.error ?? "no completed case report", wallMs: null,
    processWallMs: run.processWallMs, evidence: run.out });
  for (const test of result.cases ?? []) {
    const tools = (test.history?.messages ?? []).flatMap(message => message.tools ?? []);
    const browser = tools.filter(tool => tool.tool === "browser_exec");
    const code = tools.filter(tool => tool.tool === "codemode");
    const calls = requests.filter(call => call.model === run.model && call.variant === run.variant && call.round === run.round && call.case === test.id);
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
    const knownTotal = field => calls.every(call => Number.isSafeInteger(call[field])) ? calls.reduce((n, call) => n + call[field], 0) : null;
    rows.push({ model: run.model, variant: run.variant, round: run.round, case: test.id,
      status: test.status === "passed" && run.exitCode !== 0 ? "process-failed-after-case" : test.status ?? "incomplete",
      caseStatus: test.status ?? "incomplete", processExitCode: run.exitCode, error: test.error ?? null,
      wallMs: test.wallMs ?? null, processWallMs: run.processWallMs, modelRequests: test.modelRequests ?? calls.length, browserCalls: test.browserCalls ?? (test.id === "bot-work" ? null : browser.length),
      codemodeCalls: code.length, nestedCalls: tools.filter(tool => tool.parentToolCallId).length,
      completedBrowserCalls: browser.filter(tool => tool.status === "success").length, failedBrowserCalls: browser.filter(tool => tool.status !== "success").length,
      runtimeCalls: test.runtimeCalls ?? null, inputTokens: knownTotal("inputTokens"), outputTokens: knownTotal("outputTokens"), cacheReadTokens: knownTotal("cacheReadTokens"),
      cacheWriteTokens: knownTotal("cacheWriteTokens"), costUsd: calls.every(call => typeof call.costUsd === "number") ? calls.reduce((n, call) => n + call.costUsd, 0) : null,
      browserTrace: browser.map(tool => ({ id: tool.id, parent: tool.parentToolCallId, args: tool.summary, status: tool.status })),
      invalidRereads: duplicateReads, invalidRereadsNote: "strict duplicate returned text/targets/scope/offset without intervening input or navigation; a lower bound, not a relevance judgment about changing decorations",
      evidence: run.out });
  }
}
const groups = [];
for (const model of new Set(rows.map(row => row.model))) for (const variant of new Set(rows.map(row => row.variant))) {
  const cases = rows.filter(row => row.model === model && row.variant === variant);
  const total = field => cases.every(row => Number.isFinite(row[field])) ? cases.reduce((n, row) => n + row[field], 0) : null;
  const input = total("inputTokens"), cached = total("cacheReadTokens");
  groups.push({ model, variant, passed: cases.filter(row => row.status === "passed").length, attempted: cases.length,
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
const table = ["| Model | Variant | Success | Wall ms, all attempts | Model requests | Input tokens | Output tokens | Cache read tokens | Cost USD |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...groups.map(row => `| ${row.model} | ${row.variant} | ${row.passed}/${row.attempted} | ${row.wallMsAllAttempts ?? "unknown"} | ${row.modelRequests ?? "unknown"} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${tokens(row.cacheReadTokens)} | ${row.costUsd ?? "unknown"} |`)];
const cacheTable = ["| Model | Variant | Provider cache state | Requests | Input tokens | Cache read tokens |", "| --- | --- | --- | ---: | ---: | ---: |", ...cacheGroups.map(row => `| ${row.model} | ${row.variant} | ${row.cacheState} | ${row.requests} | ${tokens(row.inputTokens)} | ${tokens(row.cacheReadTokens)} |`)];
writeFileSync(join(directory, "summary.md"), table.join("\n") + "\n\n" + cacheTable.join("\n") + "\n\nProvider cache state is observed, not proof of a cold provider cache.\n\n" + summary.sampleWarning + "\n");
console.log(JSON.stringify(groups, null, 2));
