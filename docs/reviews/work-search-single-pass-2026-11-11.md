# Work search single-pass follow-up, 2026-11-11

## Contract

Performance only. Search documents, Unicode normalization, ownership/scope checks, status classification, exact counts, sorting, page clamping, detail boundaries and result-cache invalidation are unchanged. The only production file changed is `WorkListQuery.ts`. No schema or public API change, product build, provider call, or feature change was made. User-authored issue #27 commits through `f9b3ae7b` were fast-forwarded and preserved.

Baseline is the preceding optimization `d2a8eaae`. Synthetic A/B bundles use identical current-main dependencies and fixtures, replacing only `WorkListQuery.ts` with the baseline source. The adjacent JSON contains source hashes, raw measurements, full-response hashes, scale checks and actual Electron acceptance results.

## Bottleneck and fix

Sparse searches used to compute the complete search document once for exact status counts and again to locate the page. The new plan computes matching IDs, timestamps and status groups once in a MATERIALIZED CTE, shares them between counts and page IDs, and loads only the bounded page of summary fields. An outer LEFT JOIN preserves the counts even when a selected status has no matches. The original transaction, user/scope predicates, tie order and page clamp are retained.

The plan is used only for at least 1,000 visible scoped records when the prior scalar probe does not select the broad-prefix fast path. Small scopes retain the original plan: a private-profile check caught fixed compilation overhead in an early unconditional version, which was rejected. A 24-entry LRU of prepared statements also avoids recompiling large SQL expressions for each different search term. All parameters are supplied afresh, no permanent `.bind` or active iterator is retained, and SQLite reparses plans after schema/function changes.

## Paired measurements

50,000 synthetic rows, mixed lifecycles and 250 reports. Seven timed page-result-cache misses per case after the first observed invocation. Prepared plans may be reused naturally, and SQLite/OS caches are not cold. `firstQueryMs` is recorded separately in JSON; it is the first invocation of that case, not a claim of process-cold startup.

| Case | Before median ms | After median ms | Change |
| --- | ---: | ---: | ---: |
| unfiltered | 135.98 | 132.78 | -2.4% |
| title-all | 199.78 | 192.62 | -3.6% |
| title-rare | 724.58 | 384.97 | -46.9% |
| goal-unicode | 364.64 | 352.91 | -3.2% |
| detail-tail | 375.94 | 351.94 | -6.4% |
| mixed-title-detail | 384.72 | 357.75 | -7.0% |
| derived-guidance | 476.01 | 490.99 | +3.1% |
| no-match | 347.95 | 354.98 | +2.0% |
| paused-page3 | 201.92 | 194.15 | -3.8% |
| closed-page-clamp | 223.11 | 212.87 | -4.6% |
| long-report-tail | 490.69 | 459.94 | -6.3% |

All 11 complete response hashes match, excluding only nondeterministic watermarks. Every page of the 250-match full-text result was walked in both directions, without duplicates or omissions. The rare-title first invocation fell from **805.2ms to 388.8ms**; its repeated-miss median fell from **724.6ms to 385.0ms**.

The pre-existing, heavier focused fixture (50k rows plus 200 longer reports and richer status facts) now observed **890ms**, versus about **1.65s** in the previous report. These are focused-test observations, not paired multi-sample statistics. The separate synthetic long-report A/B case above is paired and reports its smaller improvement explicitly.

Scale checks cover 1, 100, 999, 1,000 and 10,000 rows, each with broad, rare and absent terms. All 15 full-result hashes match. At 1,000 rows the rare-term median fell 24.5→12.7ms; at 10,000 it fell 164.5→80.5ms. Small-scope repeated searches improved through plan reuse. This is not a universal latency win: the 1,000-row absent-term case was about 1.6ms slower, and the 50k derived-guidance/absent cases were about 3.1%/2.0% slower. Those measured tradeoffs are retained rather than hidden.

## Real-profile and actual UI checks

A read-only SQLite backup of the local profile was checked privately. The running database was not changed. Missing current-main helper tables were initialized only in the disposable snapshot, with a hash assertion that original Work rows were unchanged. All 23 title/ID/report-tail, sort, view and page-clamp cases produced identical full responses. Temporary database copies were removed. No private rows, queries, identifiers, response hashes or databases are included in this commit.

The actual `BotWorkBrowser`/`useWorkQueryPage` ran through IPC into synchronous Electron-main SQLite on isolated synthetic data, with the production 250ms debounce:

- Rare title: main query **778.5→391.7ms**; input to visible result **1043.0→669.5ms**.
- Broad title: input to result was effectively unchanged, **511.8→511.8ms**.
- Mixed title/report: input to result **671.1→644.7ms**.
- Empty result: **622.0→642.7ms**, an observed small regression in this single acceptance pass.
- Both passes verified 24-card bounds, status counts, page 2, deep search, empty/clear, rapid replacement while an older query was executing, and no renderer console errors. Candidate screenshots were inspected. This is a real component/main-process fixture, not a full-product startup measurement.

## Verification and limits

Passed on the integrated code: focused summary-query regression, web/node/scripts typecheck with zero errors, static review, synthetic paired/scale equivalence, private-profile parity, and both actual Electron passes. New regressions assert one full-text evaluation shared by counts/page lookup, empty selected-status counts, deterministic timestamp ties, both sort directions, nonempty last-page clamping, and prepared-statement reprepare after schema changes. Existing tests also cover UDF replacement, parameter changes, owner isolation, cross-connection writes and transaction rollback.

The coordinated final full suite is pending this performance commit and must use the latest `--list`/`--audit` count, including newly added main tests. Earlier 472/472 results are not claimed for this patch.

Queries still execute synchronously on the main thread. This patch reduces the blocking interval; it does not eliminate it or introduce workers, a search index, asynchronous semantics, or new scheduling behavior.

## Reproduce

```sh
node scripts/perf-work-list-search.mjs d2a8eaaef3c599464463a178837583d947fa528b
node scripts/perf-work-list-search-scale.mjs
TMPDIR=<external-short-temp-directory> env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs baseline
TMPDIR=<external-short-temp-directory> env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs candidate
TMPDIR=<external-short-temp-directory> pnpm -s test:bot-work-summary-query
pnpm -s typecheck
```
