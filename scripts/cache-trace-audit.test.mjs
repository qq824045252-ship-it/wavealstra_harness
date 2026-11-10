import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { summarizeCacheTraces } from './cache-trace-audit.mjs';

const rawUsage = (inputTokens, cachedTokens) => ({
  terminal: 'response.completed', responseStatus: 'completed', usagePresent: true,
  cachedTokensPresent: cachedTokens !== undefined,
  usage: { inputTokens, cachedTokens: cachedTokens ?? null },
});

function traces({ previous = {}, current = {}, historyGap = false } = {}) {
  let sequence = 0;
  const rows = [];
  const add = (request, row) => rows.push({ version: 1, epoch: 'fixture', request,
    at: ++sequence, sequence, ...row });
  for (const [request, overrides] of [['first', previous], ['second', current]]) {
    const isFirst = request === 'first';
    const raw = Object.hasOwn(overrides, 'raw') ? overrides.raw : rawUsage(isFirst ? 10000 : 20000, isFirst ? 0 : 10000);
    if (!isFirst || !historyGap) add(request, {
      event: 'request', stage: 'http', attempt: 1, coverage: 'complete',
      bodyHash: request, headersHash: 'same-headers', affinityHash: 'same-affinity', endpointHash: 'same-endpoint',
      previous: isFirst ? null : { request: 'first', attempt: 1, prefix: true, changedFields: [] },
    });
    if (raw) add(request, { event: 'provider-usage', ...raw });
    if (!overrides.omitResult) add(request, {
      event: 'result', outcome: 'stop', hitRate: isFirst ? 0 : 0.5,
      usage: { input: 10000, cacheRead: isFirst ? 0 : 10000, cacheWrite: 0, output: 1 },
      ...overrides.result,
    });
  }
  return rows;
}

const second = options => summarizeCacheTraces(traces(options)).requests.find(row => row.request === 'second');

test('impossible cached counts never produce a hit rate or reuse estimate', () => {
  for (const [input, cached] of [[10000, 20000], [0, 1], [10, -1], [10, 1.5], [10, Number.MAX_SAFE_INTEGER + 1]]) {
    const report = second({ current: { raw: rawUsage(input, cached) } });
    assert.equal(report.classification, 'raw-cache-usage-invalid', `${input}/${cached}`);
    assert.equal(report.cacheReadState, 'invalid');
    assert.equal(report.rawHitRate, null);
    assert.equal(report.historyUncachedTokens, null);
    assert.equal(report.rawUsage.usage.cachedTokens, cached, 'retain the provider evidence unchanged');
  }
});

test('invalid or missing input counts do not become a usable denominator', () => {
  for (const input of [-1, 1.5, '20000', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    const report = second({ current: { raw: rawUsage(input, 10000) } });
    const state = input == null ? 'missing' : 'invalid';
    assert.equal(report.classification, `raw-cache-usage-${state}`);
    assert.equal(report.inputTokenState, state);
    assert.equal(report.rawUsageState, state);
    assert.equal(report.rawHitRate, null);
    assert.equal(report.historyUncachedTokens, null);
  }
});

test('missing provider cache counts stay unknown despite a normalized zero', () => {
  for (const raw of [null, rawUsage(20000, undefined)]) {
    const report = second({ current: { raw, result: { usage: { input: 20000, cacheRead: 0, cacheWrite: 0 } } } });
    assert.equal(report.classification, 'raw-cache-usage-missing');
    assert.equal(report.cacheReadState, 'missing');
    assert.equal(report.rawHitRate, null);
    assert.equal(report.historyUncachedTokens, null);
    assert.equal(report.usage.cacheRead, 0, 'the SDK observation remains available without becoming raw evidence');
  }
});

test('failed or cancelled predecessors cannot establish reusable input', () => {
  for (const previous of [
    ...['error', 'aborted', 'observation-failed'].map(outcome => ({ result: { outcome } })),
    { raw: { ...rawUsage(10000, 0), terminal: 'response.failed', responseStatus: 'failed' } },
    { raw: { ...rawUsage(10000, 0), responseStatus: 'cancelled' } },
  ]) {
    const report = second({ previous, current: { raw: rawUsage(20000, 0) } });
    assert.equal(report.classification, 'predecessor-usage-unavailable');
    assert.equal(report.previousUsageState, 'request-failed');
    assert.equal(report.previousPromptTokens, null);
    assert.equal(report.historyUncachedTokens, null);
    assert.equal(report.rawHitRate, 0, 'the successful current call still has an observed zero');
  }
});

test('missing or invalid predecessor evidence stays unavailable, never zero', () => {
  for (const previous of [
    { omitResult: true }, { raw: null }, { result: { outcome: 'other' } },
    ...[null, -1, 1.5, '10000', Number.MAX_SAFE_INTEGER + 1].map(input => ({ raw: rawUsage(input, 0) })),
    { raw: rawUsage(10000, 20000) }, { raw: rawUsage(10000, -1) },
  ]) {
    const report = second({ previous, current: { raw: rawUsage(20000, 0) } });
    assert.equal(report.classification, 'predecessor-usage-unavailable');
    assert.notEqual(report.previousUsageState, 'available');
    assert.equal(report.previousPromptTokens, null);
    assert.equal(report.historyUncachedTokens, null);
  }
});

test('predecessor size uses raw input rather than fabricated or divergent normalization', () => {
  for (const usage of [null, {}, { input: 100000, cacheRead: 50000, cacheWrite: 1 }]) {
    const report = second({ previous: { result: { usage } }, current: { raw: rawUsage(20000, 10000) } });
    assert.equal(report.previousPromptTokens, 10000);
    assert.equal(report.previousUsageState, 'available');
    assert.equal(report.historyUncachedTokens, 0);
    assert.equal(report.classification, 'stable-prefix');
  }
});

test('a reported prompt total is usable without its previous cache breakdown', () => {
  const report = second({ previous: { raw: rawUsage(10000, undefined) } });
  assert.equal(report.previousPromptTokens, 10000);
  assert.equal(report.historyUncachedTokens, 0);
  assert.equal(report.classification, 'stable-prefix');
});

test('successful incomplete and tool-use predecessors remain comparable', () => {
  for (const outcome of ['stop', 'length', 'toolUse']) {
    const report = second({ previous: { result: { outcome },
      raw: { ...rawUsage(10000, 0), terminal: 'response.incomplete', responseStatus: 'incomplete' } } });
    assert.equal(report.previousPromptTokens, 10000);
    assert.equal(report.classification, 'stable-prefix');
  }
});

test('valid zero, growth, partial reuse and full reuse keep their distinct meanings', () => {
  for (const [input, cached, classification, uncached] of [
    [20000, 0, 'stable-prefix-low-cache', 10000],
    [100000, 10000, 'stable-prefix-new-input', 0],
    [10000, 7000, 'stable-prefix-partial-cache', 3000],
    [20000, 10000, 'stable-prefix', 0],
    [10000, 10000, 'stable-prefix', 0],
  ]) {
    const report = second({ current: { raw: rawUsage(input, cached) } });
    assert.equal(report.classification, classification);
    assert.equal(report.historyUncachedTokens, uncached);
    assert.equal(report.rawHitRate, cached / input);
    assert.equal(report.rawUsageState, 'complete');
  }
  const zero = second({ previous: { raw: rawUsage(0, 0) }, current: { raw: rawUsage(0, 0) } });
  assert.equal(zero.previousPromptTokens, 0, 'observed zero is distinct from missing');
  assert.equal(zero.rawUsageState, 'complete');
  assert.equal(zero.rawHitRate, null, 'zero divided by zero is not a hit rate');
  assert.equal(zero.classification, 'stable-prefix');
});

test('current failure and missing HTTP history retain priority over metering diagnostics', () => {
  for (const raw of [rawUsage(10, 20), rawUsage(20000, 0)]) {
    const failed = second({ current: { result: { outcome: 'error' }, raw } });
    assert.equal(failed.classification, 'request-failed');
    assert.equal(failed.historyUncachedTokens, null);
  }
  assert.equal(second({ historyGap: true }).classification, 'history-gap');
});

test('request changes, retries and coverage gaps remain distinct with an unmetered predecessor', () => {
  for (const [change, classification] of [
    [row => { row.previous.prefix = false; }, 'client-request-changed'],
    [row => { row.previous.changedFields = ['tools']; }, 'client-request-changed'],
    [row => { row.affinityHash = 'changed-affinity'; }, 'client-request-changed'],
    [row => { row.coverage = 'body-unobservable'; }, 'missing-http-observation'],
  ]) {
    const rows = traces({ previous: { raw: null } });
    change(rows.find(row => row.request === 'second' && row.event === 'request'));
    const report = summarizeCacheTraces(rows).requests[1];
    assert.equal(report.classification, classification);
    assert.equal(report.previousPromptTokens, null);
  }
  const rows = traces({ previous: { raw: null } });
  const firstSend = rows.find(row => row.request === 'second' && row.event === 'request');
  rows.push({ ...firstSend, sequence: 100, at: 100, attempt: 2, bodyHash: 'changed-retry' });
  assert.equal(summarizeCacheTraces(rows).requests[1].classification, 'retry-request-changed');
});

test('ordering and CLI log input preserve the same corrected classification', () => {
  const rows = traces({ current: { raw: rawUsage(10000, 20000) } });
  const expected = summarizeCacheTraces(rows);
  assert.deepEqual(summarizeCacheTraces([...rows].reverse()), expected);
  const dir = mkdtempSync(join(tmpdir(), 'mybuddy-cache-trace-audit-'));
  try {
    writeFileSync(join(dir, 'cache-requests-20261109.log'),
      rows.map(row => `[INFO] [cache-trace] ${JSON.stringify(row)}\n`).join(''));
    const output = execFileSync(process.execPath,
      [fileURLToPath(new URL('./cache-trace-audit.mjs', import.meta.url)), '--dir', dir], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), JSON.parse(JSON.stringify(expected)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Chat Completions raw usage supports history only with a successful result', () => {
  const raw = { ...rawUsage(10000, 8000), terminal: 'chat-completions.usage', responseStatus: 'unknown' };
  const ok = second({ previous: { raw } });
  assert.equal(ok.previousPromptTokens, 10000);
  assert.equal(ok.previousUsageState, 'available');
  for (const outcome of ['error', 'aborted']) {
    const failed = second({ previous: { raw, result: { outcome } } });
    assert.equal(failed.previousPromptTokens, null);
    assert.equal(failed.previousUsageState, 'request-failed');
  }
});
